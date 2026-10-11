/**
 * Host / address classification for the local-only network policy (lib/net/policy.ts).
 *
 * Every outbound destination is reduced to one of five classes:
 *   loopback — this machine (127.0.0.0/8, ::1, localhost)
 *   lan      — private LAN ranges (RFC 1918 10/8, 172.16/12, 192.168/16; IPv6 ULA fc00::/7)
 *   tailnet  — the Tailscale network (100.64.0.0/10 CGNAT, fd7a:115c:a1e0::/48, *.ts.net)
 *   public   — anything else, INCLUDING every hostname we cannot classify syntactically
 *              (a name like mail.example.com could resolve anywhere, so it is never trusted)
 *   invalid  — unroutable / special-purpose ranges we never call (0.0.0.0/8, link-local
 *              169.254/16 + fe80::/10 — which includes cloud metadata endpoints —, multicast,
 *              reserved, broadcast) and unparseable input
 *
 * Classification is purely syntactic (no DNS), so it cannot be fooled by DNS rebinding:
 * names are only trusted when the name itself pins the network (localhost, *.ts.net —
 * MagicDNS names are answered by Tailscale's own resolver with 100.x addresses).
 */

export type HostClass = 'loopback' | 'lan' | 'tailnet' | 'public' | 'invalid';

/** Parse a dotted-quad IPv4 literal to an unsigned 32-bit number (null if not one). */
export function parseIPv4(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** True when `ip` (dotted quad) is inside `cidr` ("a.b.c.d/len"). */
export function inCidr4(ip: string, cidr: string): boolean {
  const [base, lenStr] = cidr.split('/');
  const a = parseIPv4(ip);
  const b = parseIPv4(base);
  const len = Number(lenStr);
  if (a === null || b === null || !Number.isInteger(len) || len < 0 || len > 32) return false;
  if (len === 0) return true;
  const mask = len === 32 ? 0xffffffff : (~((1 << (32 - len)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/**
 * Parse an IPv6 literal (no brackets, no zone) into 8 16-bit groups. Supports '::'
 * compression and an embedded trailing IPv4 (::ffff:1.2.3.4). Returns null if invalid.
 */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (!s.includes(':')) return null;
  // Embedded IPv4 tail → two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...rest];
}

/** True when the IPv6 groups fall inside prefix/len (prefix given as a literal). */
export function inCidr6(groups: number[], cidr: string): boolean {
  const [base, lenStr] = cidr.split('/');
  const b = parseIPv6(base);
  const len = Number(lenStr);
  if (!b || !Number.isInteger(len) || len < 0 || len > 128) return false;
  let remaining = len;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (b[i] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

function classifyIPv4(ip: string): HostClass {
  if (inCidr4(ip, '127.0.0.0/8')) return 'loopback';
  if (inCidr4(ip, '0.0.0.0/8')) return 'invalid';
  if (inCidr4(ip, '169.254.0.0/16')) return 'invalid'; // link-local / cloud metadata
  if (inCidr4(ip, '224.0.0.0/4')) return 'invalid'; // multicast
  if (inCidr4(ip, '240.0.0.0/4')) return 'invalid'; // reserved + broadcast
  if (inCidr4(ip, '100.64.0.0/10')) return 'tailnet'; // Tailscale CGNAT range
  if (inCidr4(ip, '10.0.0.0/8') || inCidr4(ip, '172.16.0.0/12') || inCidr4(ip, '192.168.0.0/16')) {
    return 'lan';
  }
  return 'public';
}

function classifyIPv6(groups: number[]): HostClass {
  // IPv4-mapped (::ffff:a.b.c.d) → classify the embedded IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return classifyIPv4(v4);
  }
  if (groups.slice(0, 7).every((g) => g === 0)) {
    if (groups[7] === 1) return 'loopback'; // ::1
    return 'invalid'; // :: (unspecified)
  }
  if (inCidr6(groups, 'fd7a:115c:a1e0::/48')) return 'tailnet';
  if (inCidr6(groups, 'fc00::/7')) return 'lan';
  if (inCidr6(groups, 'fe80::/10')) return 'invalid';
  if (inCidr6(groups, 'ff00::/8')) return 'invalid';
  return 'public';
}

/**
 * Normalize a host string the way a URL parser would: lowercases, strips IPv6 brackets and
 * a trailing dot, and canonicalizes odd IPv4 spellings ("127.1", "2130706433", "0x7f.1")
 * through the WHATWG URL parser so they cannot slip past the CIDR checks.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.includes(':')) {
    // IPv6 literal — drop a zone id; the URL parser canonicalizes compression.
    h = h.split('%')[0];
    try {
      return new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return h;
    }
  }
  try {
    h = new URL(`http://${h}/`).hostname;
  } catch {
    /* leave as-is; classified as invalid below if unparseable */
  }
  return h.replace(/\.$/, '');
}

/** Classify a hostname or IP literal (no port). See the module comment for the classes. */
export function classifyHost(rawHost: string): HostClass {
  if (!rawHost || typeof rawHost !== 'string') return 'invalid';
  const host = normalizeHost(rawHost);
  if (!host) return 'invalid';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (parseIPv4(host) !== null) return classifyIPv4(host);
  const v6 = parseIPv6(host);
  if (v6) return classifyIPv6(v6);
  if (host.includes(':')) return 'invalid';
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..')) return 'invalid';
  // Tailscale MagicDNS names are resolved by Tailscale to tailnet addresses.
  if (host.endsWith('.ts.net')) return 'tailnet';
  return 'public';
}

/** True for destinations that never leave this machine or the user's private networks. */
export function isPrivateClass(c: HostClass): boolean {
  return c === 'loopback' || c === 'lan' || c === 'tailnet';
}
