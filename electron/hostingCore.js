// Pure helpers for multi-user hosting (no Electron / no I/O, so they are unit-testable from
// vitest — see test/hostingCore.test.ts). The server-side twin of the address rules lives in
// lib/net/cidr.ts; keep the two in step.
//
// Model (QuickBooks Enterprise "host multi-user access" parity):
//  - The Next server that owns the company file is ALWAYS bound to 127.0.0.1 only.
//  - Hosting adds a small reverse proxy (electron/hosting.js) on the machine's Tailscale
//    address (100.64.0.0/10), so only devices on the user's tailnet can reach it. Binding to
//    every interface (0.0.0.0) happens only when the user explicitly chooses it, and even then
//    connections from public addresses are refused.

'use strict';

const DEFAULT_HOSTING_PORT = 47800;

function parseIPv4(s) {
  if (typeof s !== 'string') return null;
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

function inCidr4(ip, cidr) {
  const [base, lenStr] = cidr.split('/');
  const a = parseIPv4(ip);
  const b = parseIPv4(base);
  const len = Number(lenStr);
  if (a === null || b === null || !Number.isInteger(len) || len < 0 || len > 32) return false;
  if (len === 0) return true;
  const mask = len === 32 ? 0xffffffff : (~((1 << (32 - len)) - 1)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function isTailnetIPv4(ip) {
  return inCidr4(ip, '100.64.0.0/10');
}

/** Strip an IPv4-mapped IPv6 prefix (sockets report '::ffff:100.1.2.3'). */
function unmapAddress(addr) {
  if (typeof addr !== 'string') return '';
  const a = addr.trim().toLowerCase();
  return a.startsWith('::ffff:') && parseIPv4(a.slice(7)) !== null ? a.slice(7) : a;
}

/**
 * Classify a peer / host address: 'loopback' | 'tailnet' | 'lan' | 'other'.
 * Hostnames: localhost → loopback, *.ts.net → tailnet, anything else → other.
 */
function classifyAddress(raw) {
  let a = unmapAddress(raw);
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  a = a.replace(/\.$/, '');
  if (!a) return 'other';
  if (a === 'localhost') return 'loopback';
  if (parseIPv4(a) !== null) {
    if (inCidr4(a, '127.0.0.0/8')) return 'loopback';
    if (isTailnetIPv4(a)) return 'tailnet';
    if (inCidr4(a, '10.0.0.0/8') || inCidr4(a, '172.16.0.0/12') || inCidr4(a, '192.168.0.0/16')) return 'lan';
    return 'other';
  }
  if (a.includes(':')) {
    if (a === '::1') return 'loopback';
    if (a.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
    if (/^f[cd][0-9a-f]{2}:/.test(a)) return 'lan';
    return 'other';
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(a)) return 'tailnet';
  return 'other';
}

/** Peers allowed to talk to the host proxy (everything private; never the public internet). */
function isPeerAllowed(addr) {
  const c = classifyAddress(addr);
  return c === 'loopback' || c === 'tailnet' || c === 'lan';
}

/** First tailnet IPv4 in the output of `tailscale ip -4` (one address per line). */
function parseTailscaleIpOutput(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const ip = line.trim();
    if (isTailnetIPv4(ip)) return ip;
  }
  return null;
}

/** Fallback detection: a tailnet IPv4 on any interface (os.networkInterfaces() shape). */
function pickTailnetIPv4FromInterfaces(ifaces) {
  for (const list of Object.values(ifaces || {})) {
    for (const i of list || []) {
      const fam = i && (i.family === 'IPv4' || i.family === 4);
      if (fam && !i.internal && isTailnetIPv4(i.address)) return i.address;
    }
  }
  return null;
}

/**
 * Decide where the host proxy listens.
 *   - default: the tailnet IPv4 only (the app server itself stays on 127.0.0.1)
 *   - bindAll (explicit opt-in): 0.0.0.0, still filtered to private peers
 * Returns { ok, serverHost, proxyHosts, error }.
 */
function selectBindAddresses({ tailnetIp, bindAll } = {}) {
  if (bindAll === true) {
    return { ok: true, serverHost: '127.0.0.1', proxyHosts: ['0.0.0.0'], error: null };
  }
  if (tailnetIp && isTailnetIPv4(tailnetIp)) {
    return { ok: true, serverHost: '127.0.0.1', proxyHosts: [tailnetIp], error: null };
  }
  return {
    ok: false,
    serverHost: '127.0.0.1',
    proxyHosts: [],
    error:
      'Tailscale is not running on this computer, so there is no private network address to share the company file on. Install/sign in to Tailscale and try again.',
  };
}

function validPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
}

/**
 * Normalize what a user typed in "Open company on host…" into a URL. Accepts a bare address
 * ("100.101.102.103", "office-pc.tail1234.ts.net", "192.168.1.20:47800") or a full
 * http(s) URL. Only loopback / LAN / tailnet hosts are accepted — never the public internet.
 * Returns { ok, url, origin, host, port, error }.
 */
function normalizeHostAddress(input, defaultPort = DEFAULT_HOSTING_PORT) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Enter the host computer\'s address.' };
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return { ok: false, error: 'That doesn\'t look like a valid address.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'Use an http:// or https:// address.' };
  }
  if (u.username || u.password) return { ok: false, error: 'Don\'t include a user name or password in the address.' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const cls = classifyAddress(host);
  if (cls === 'other') {
    return {
      ok: false,
      error:
        'For your privacy, BookKeeper AI only connects to hosts on your own network or tailnet (a 100.x.y.z address or a name ending in .ts.net).',
    };
  }
  // The URL parser drops a scheme's default port (":80"/":443"), so read an explicit port from
  // what was typed; only when none was typed do we use the hosting default.
  const typedPort = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\[[^\]]*\]|[^/:?#]+):(\d+)/i.exec(raw);
  const port = validPort(typedPort ? typedPort[1] : u.port || defaultPort);
  if (!port) return { ok: false, error: 'The port must be between 1024 and 65535.' };
  u.port = String(port);
  return { ok: true, url: `${u.origin}/`, origin: u.origin, host, port, error: null };
}

/** URLs teammates should use to reach this host. */
function shareUrls({ proxyHosts, port, tls, dnsName, tailnetIp }) {
  const urls = [];
  const scheme = tls ? 'https' : 'http';
  if (tls && dnsName) urls.push(`https://${dnsName}:${port}`);
  for (const h of proxyHosts || []) {
    if (h === '0.0.0.0') {
      if (tailnetIp) urls.push(`${scheme}://${tailnetIp}:${port}`);
    } else if (!(tls && dnsName)) {
      urls.push(`${scheme}://${h}:${port}`);
    }
  }
  return [...new Set(urls)];
}

module.exports = {
  DEFAULT_HOSTING_PORT,
  parseIPv4,
  inCidr4,
  isTailnetIPv4,
  unmapAddress,
  classifyAddress,
  isPeerAllowed,
  parseTailscaleIpOutput,
  pickTailnetIPv4FromInterfaces,
  selectBindAddresses,
  normalizeHostAddress,
  shareUrls,
};
