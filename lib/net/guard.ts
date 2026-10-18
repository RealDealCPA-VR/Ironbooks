/**
 * Enforcement point for the local-only network policy. EVERY server-side outbound call goes
 * through here:
 *
 *   await assertOutboundAllowed(url, 'ai', ctx);          // before an SDK/transport connects
 *   const res = await policyFetch(url, init, { purpose: 'email', ctx });  // fetch wrapper
 *
 * policyFetch re-checks every redirect hop (a redirect can never bounce a request from an
 * allowed host to a disallowed one). Blocked calls throw ServiceError('FORBIDDEN') with a
 * plain-English reason the UI can show as-is.
 *
 * A small in-memory log of recent decisions (destination host + purpose + verdict — never
 * payloads, headers or query strings) backs the "Recent network activity" list on the
 * Privacy & Network page so users can see exactly what was attempted.
 */
import type { ServiceContext } from '@/lib/services/_base';
import { ServiceError } from '@/lib/services/_base';
import { getNetworkPolicy } from '@/lib/services/networkPolicy';
import { decideOutbound, type OutboundDecision, type OutboundPurpose } from './policy';
import { verifyTailnetUrls } from './tailnetVerify';
import { applySandboxToDecision } from '@/lib/services/sandboxState';

export type PolicyCtx = Pick<ServiceContext, 'db' | 'companyId'>;

export interface OutboundLogEntry {
  at: string;
  companyId: string;
  purpose: OutboundPurpose;
  host: string;
  hostClass: OutboundDecision['hostClass'];
  allowed: boolean;
  reason: string;
}

const LOG_LIMIT = 200;
const g = globalThis as unknown as { __bkaOutboundLog?: OutboundLogEntry[] };

function log(companyId: string, d: OutboundDecision): void {
  const list = (g.__bkaOutboundLog ??= []);
  list.push({
    at: new Date().toISOString(),
    companyId,
    purpose: d.purpose,
    host: d.host,
    hostClass: d.hostClass,
    allowed: d.allowed,
    reason: d.reason,
  });
  if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
  if (!d.allowed) console.warn(`[net-policy] blocked ${d.purpose} → ${d.host || '(invalid)'}: ${d.reason}`);
}

/** Recent outbound decisions for one company, newest first. */
export function recentOutbound(companyId: string, limit = 50): OutboundLogEntry[] {
  return (g.__bkaOutboundLog ?? [])
    .filter((e) => e.companyId === companyId)
    .slice(-limit)
    .reverse();
}

/** Decide (and log) without throwing. */
export async function checkOutbound(
  url: string | URL,
  purpose: OutboundPurpose,
  ctx: PolicyCtx,
): Promise<OutboundDecision> {
  const policy = await getNetworkPolicy(ctx);
  // A *.ts.net name is tailnet only if it resolves to tailnet addresses (Funnel names are public).
  await verifyTailnetUrls([url]);
  // Sandbox mode: email and update checks stay off in a practice copy.
  const decision = applySandboxToDecision(decideOutbound(policy, url, purpose));
  log(ctx.companyId, decision);
  return decision;
}

/** Throw FORBIDDEN unless the company's policy allows `purpose` to reach `url`. */
export async function assertOutboundAllowed(
  url: string | URL,
  purpose: OutboundPurpose,
  ctx: PolicyCtx,
): Promise<OutboundDecision> {
  const decision = await checkOutbound(url, purpose, ctx);
  if (!decision.allowed) {
    throw new ServiceError('FORBIDDEN', decision.reason, { networkPolicy: decision });
  }
  return decision;
}

const MAX_REDIRECTS = 5;
/** Headers allowed to follow a redirect to a different origin; everything else is dropped. */
const CROSS_ORIGIN_SAFE_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent'] as const;

/**
 * Policy-checked fetch. Same shape as fetch(url, init) plus { purpose, ctx }. Redirects are
 * followed manually (max 5) and every hop is checked against the policy.
 */
export async function policyFetch(
  input: string | URL,
  init: RequestInit | undefined,
  opts: {
    purpose: OutboundPurpose;
    ctx: PolicyCtx;
    /** Transport for each (already policy-checked) hop; defaults to the global fetch. */
    fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  },
): Promise<Response> {
  const transport = opts.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  let url = new URL(String(input));
  let reqInit: RequestInit = { ...(init ?? {}), redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    await assertOutboundAllowed(url, opts.purpose, opts.ctx);
    const res = await transport(url.toString(), reqInit);
    const status = typeof res?.status === 'number' ? res.status : 200;
    const location = status >= 300 && status < 400 ? res.headers?.get?.('location') : null;
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new ServiceError('FORBIDDEN', 'Too many redirects from an outbound request.');
    }
    const next = new URL(location, url);
    const method = (reqInit.method ?? 'GET').toUpperCase();
    const crossOrigin = next.origin !== url.origin;
    // A 307/308 replays the method AND body. Bodies can carry credentials (API keys and
    // secrets often travel in a JSON body), so never replay one to a different origin.
    if (crossOrigin && (status === 307 || status === 308) && method !== 'GET' && method !== 'HEAD') {
      throw new ServiceError(
        'FORBIDDEN',
        `Refused to resend a ${method} request body to a different site (${next.host}) after a redirect.`,
      );
    }
    if (crossOrigin && reqInit.headers) {
      // Never forward credentials to a different origin: only an allowlist of harmless headers
      // follows a cross-origin hop (any auth / proxy-auth / cookie / API-key header is dropped).
      const src = new Headers(reqInit.headers);
      const h = new Headers();
      for (const name of CROSS_ORIGIN_SAFE_HEADERS) {
        const v = src.get(name);
        if (v !== null) h.set(name, v);
      }
      reqInit = { ...reqInit, headers: h };
    }
    url = next;
    // 303 (and 301/302 after a non-GET) become a bodyless GET, as browsers do.
    if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
      reqInit = { ...reqInit, method: 'GET', body: undefined };
    }
  }
}
