/**
 * Vendor lookup — "what kind of business is this new vendor?" from the company's OWN SearXNG.
 *
 * Used only for a payee with no history in the books (aiCategorizer.suggestAccountForPayee), so
 * the AI can pick an account for "FERGUSON SUPPLY" without guessing. Privacy:
 *  - Off unless the owner turned on Privacy & Network → Vendor lookup AND entered a SearXNG
 *    address (the policy's vendor-lookup purpose needs that opt-in even on the tailnet, because
 *    SearXNG relays the search to public engines — lib/net/policy.ts).
 *  - Only the vendor name is sent, with store numbers and long digit runs (card / reference
 *    numbers) removed. Never amounts, dates, accounts, customers or anything else.
 *  - Every request goes through policyFetch (purpose 'vendor-lookup'), so Offline mode, the
 *    machine-wide ceiling and the outbound activity log all apply.
 *  - Answers (including "no results") are cached per company + name for a day; a failure
 *    (blocked, unreachable, timeout) is just "nothing known" and is retried next time.
 *
 * The returned summary is untrusted web text: callers pass it to the AI as reference data only.
 */
import { policyFetch } from '@/lib/net/guard';
import type { ServiceContext } from './_base';
import { getNetworkPolicy } from './networkPolicy';

export interface VendorFacts {
  /** The cleaned name that was searched. */
  query: string;
  /** Up to five results as "title — snippet (host)" lines, at most ~1,500 characters. */
  summary: string;
  sources: Array<{ title: string; url: string }>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; facts: VendorFacts | null }>();

/**
 * The part of a bank payee that is safe and useful to search: the business name. Drops store
 * numbers ("#2231", "STORE 0412"), long digit runs (card / reference numbers), and processor
 * prefixes such as "SQ *" or "POS ".
 */
export function lookupQuery(payee: string): string {
  return payee
    .replace(/^(?:SQ|SP|TST|POS|ACH|DEBIT|CHECKCARD|PURCHASE)\s*\*?\s+/i, '')
    .replace(/#\s*\d+/g, ' ')
    .replace(/\b(?:STORE|STR|NO|UNIT)\s*\d+\b/gi, ' ')
    .replace(/\d{4,}/g, ' ')
    .replace(/[*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Forget cached lookups (tests). */
export function clearVendorLookupCache(): void {
  cache.clear();
}

export async function lookupVendor(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  payee: string,
  opts: { fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> } = {},
): Promise<VendorFacts | null> {
  const query = lookupQuery(payee);
  if (query.length < 3) return null;
  const policy = await getNetworkPolicy(ctx);
  if (!policy.vendorLookupUrl || !policy.cloudOptIn['vendor-lookup'] || policy.mode === 'offline') return null;

  const key = `${ctx.companyId}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.facts;

  let facts: VendorFacts | null = null;
  try {
    const url = new URL(`${policy.vendorLookupUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', 'general');
    url.searchParams.set('safesearch', '1');
    const res = await policyFetch(
      url,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
      { purpose: 'vendor-lookup', ctx, fetchImpl: opts.fetchImpl },
    );
    if (res.ok) {
      const data = (await res.json()) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
      const results = (Array.isArray(data?.results) ? data.results : [])
        .map((r) => ({
          title: typeof r.title === 'string' ? r.title.trim() : '',
          url: typeof r.url === 'string' ? r.url : '',
          content: typeof r.content === 'string' ? r.content.trim() : '',
        }))
        .filter((r) => r.title && /^https?:\/\//.test(r.url))
        .slice(0, 5);
      if (results.length) {
        const lines = results.map((r) => {
          let host = '';
          try {
            host = new URL(r.url).hostname;
          } catch {
            /* skipped above */
          }
          return `- ${r.title.slice(0, 120)}${r.content ? ` — ${r.content.slice(0, 220)}` : ''}${host ? ` (${host})` : ''}`;
        });
        facts = {
          query,
          summary: lines.join('\n').slice(0, 1500),
          sources: results.map((r) => ({ title: r.title.slice(0, 120), url: r.url })),
        };
      }
    }
  } catch {
    return null; // blocked, unreachable, timed out or not JSON: nothing known, try again next time
  }
  cache.set(key, { at: Date.now(), facts });
  return facts;
}
