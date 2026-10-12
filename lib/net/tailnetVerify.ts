/**
 * Server-side DNS check for *.ts.net names (P2 security).
 *
 * Tailscale MagicDNS names (gpu-box.tail1234.ts.net) resolve to tailnet addresses, but Tailscale
 * Funnel publishes names under the same ts.net suffix that resolve to PUBLIC relay addresses. So
 * the name alone must not make a destination "tailnet" (which skips the cloud opt-in and AI
 * redaction). verifyTailnetName resolves the name and records it as tailnet only when EVERY
 * address is in 100.64.0.0/10 or fd7a:115c:a1e0::/48; lib/net/cidr.ts classifyHost then trusts it
 * for a short time (TAILNET_VERIFY_TTL_MS). Anything else — a public address, a mix, no answer —
 * leaves it 'public' (cloud: opt-in + redaction).
 *
 * Kept out of cidr.ts so that module stays browser-safe (no node:dns).
 */
import { lookup } from 'node:dns/promises';
import { classifyHost, isTsNetName, normalizeHost, recordTailnetVerification } from './cidr';

/** Resolve a host name to its addresses. Injectable so tests never touch real DNS. */
export type HostLookup = (host: string) => Promise<string[]>;

const systemLookup: HostLookup = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

let lookupImpl: HostLookup = systemLookup;

/** Replace the resolver (tests); null restores the system resolver. */
export function setHostLookup(fn: HostLookup | null): void {
  lookupImpl = fn ?? systemLookup;
}

/** True when `address` is a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48). */
export function isTailnetAddress(address: string): boolean {
  return classifyHost(address) === 'tailnet';
}

/**
 * Resolve a *.ts.net name and record whether it is really on the tailnet. Returns true only when
 * it resolved and every address is a Tailscale address. Never throws. Other names: false, no DNS.
 */
export async function verifyTailnetName(host: string): Promise<boolean> {
  if (!host || !isTsNetName(host)) return false;
  const name = normalizeHost(host);
  let addresses: string[] = [];
  try {
    addresses = await lookupImpl(name);
  } catch {
    addresses = [];
  }
  const ok = addresses.length > 0 && addresses.every(isTailnetAddress);
  recordTailnetVerification(name, ok);
  return ok;
}

/** Verify the host of every URL that is a *.ts.net name (unparseable / other URLs are skipped). */
export async function verifyTailnetUrls(urls: Array<string | URL | null | undefined>): Promise<void> {
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const h = (typeof u === 'string' ? new URL(u) : u).hostname;
      if (isTsNetName(h)) hosts.add(normalizeHost(h));
    } catch {
      /* not a URL */
    }
  }
  await Promise.all([...hosts].map((h) => verifyTailnetName(h)));
}
