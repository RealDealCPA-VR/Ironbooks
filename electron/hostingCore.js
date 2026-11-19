// Pure helpers for multi-user hosting (no Electron / no I/O, so they are unit-testable from
// vitest — see test/hostingCore.test.ts). The server-side twin of the address rules lives in
// lib/net/cidr.ts; keep the two in step.
//
// Model (QuickBooks Enterprise "host multi-user access" parity):
//  - The Next server that owns the company file is ALWAYS bound to 127.0.0.1 only.
//  - Hosting adds a small reverse proxy (electron/hosting.js) on the machine's Tailscale
//    address (100.64.0.0/10), so only devices on the user's tailnet can reach it. The address
//    counts as Tailscale's only when Tailscale itself says so: some internet providers hand out
//    the same 100.64.0.0/10 range (carrier-grade NAT) straight to the computer.
//  - Office-network mode listens on each of this computer's private LAN addresses (the ones
//    teammates are given), one listener per address, plus the tailnet address — never on an
//    interface it does not advertise.
//  - Binding to every interface (0.0.0.0) happens only when the user explicitly chooses it
//    (hosting.bindAll in the app config).
//  - Every listener accepts the same devices: private, tailnet and loopback addresses, never the
//    public internet (isPeerAllowed). Teammates still sign in, over pinned HTTPS in office mode.

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

/**
 * What `tailscale status --json` says about this computer: { running, ip, dnsName }, or null when
 * the output is not Tailscale's JSON. `running` is false when Tailscale reports any state but
 * "Running" (stopped, signed out, starting), null when the output does not say (very old CLI).
 */
function parseTailscaleStatus(stdout) {
  let s;
  try {
    s = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const self = s.Self && typeof s.Self === 'object' ? s.Self : {};
  const state = typeof s.BackendState === 'string' ? s.BackendState : null;
  const ips = [
    ...(Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []),
    ...(Array.isArray(s.TailscaleIPs) ? s.TailscaleIPs : []),
  ];
  const ip = ips.find((a) => typeof a === 'string' && isTailnetIPv4(a.trim()));
  const dnsName = typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : null;
  return { running: state === null ? null : state === 'Running', ip: ip ? ip.trim() : null, dnsName };
}

/** True when `ip` is an IPv4 address on one of this computer's own interfaces. */
function hasInterfaceAddress(ifaces, ip) {
  for (const list of Object.values(ifaces || {})) {
    for (const i of list || []) {
      const fam = i && (i.family === 'IPv4' || i.family === 4);
      if (fam && i.address === ip) return true;
    }
  }
  return false;
}

/**
 * This computer's tailnet IPv4, only when Tailscale itself confirms it: from `tailscale status
 * --json` (Self addresses, while Tailscale reports itself running), else from `tailscale ip -4`
 * (only when the status could not be read at all), and in both cases only when the address is on
 * one of this computer's interfaces. An interface address in 100.64.0.0/10 is NOT enough on its
 * own: some internet providers hand out that range (carrier-grade NAT), and hosting would then
 * serve plain HTTP on the provider-facing address. Null means "Tailscale is not running".
 */
function confirmTailnetIPv4({ status = null, ipOutput = null, ifaces = null } = {}) {
  if (status && status.running === false) return null;
  const ip = status && status.ip ? status.ip : !status ? parseTailscaleIpOutput(ipOutput) : null;
  if (!ip || !isTailnetIPv4(ip)) return null;
  if (ifaces && !hasInterfaceAddress(ifaces, ip)) return null;
  return ip;
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
        'For your privacy, Ironbooks only connects to hosts on your own network or tailnet (a 100.x.y.z address or a name ending in .ts.net).',
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

function ipv4ToString(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Prefix length of a dotted IPv4 netmask ('255.255.255.0' -> 24), null when it is not one. */
function maskBits(netmask) {
  const m = parseIPv4(netmask);
  if (m === null) return null;
  for (let bits = 0; bits <= 32; bits++) {
    if (((bits === 0 ? 0 : ~(2 ** (32 - bits) - 1)) >>> 0) === m) return bits;
  }
  return null;
}

/**
 * The widest subnet that counts as "a network hosting started on" when following address changes
 * (lanListenerChanges). An interface reporting a wider (or unreadable) netmask counts as its own
 * address only, never a whole slice of the address space.
 */
const MIN_LAN_PREFIX = 8;

/** How many address checks in a row a LAN address must be missing before its listener closes. */
const CLOSE_AFTER_MISSES = 2;

/** 'network/prefix' of an address, e.g. ('192.168.1.10', 24) -> '192.168.1.0/24'. */
function subnetKey(address, prefix) {
  const a = parseIPv4(address);
  if (a === null) return null;
  const mask = prefix === 0 ? 0 : ~(2 ** (32 - prefix) - 1) >>> 0;
  return `${ipv4ToString((a & mask) >>> 0)}/${prefix}`;
}

/**
 * This computer's office-network (private LAN) IPv4 addresses with their subnet prefix,
 * os.networkInterfaces() shape: [{ address, prefix }]. One entry per address. The prefix only
 * decides which networks hosting follows when addresses change; it never limits who may connect.
 */
function lanInterfaces(ifaces) {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(ifaces || {})) {
    for (const i of list || []) {
      const fam = i && (i.family === 'IPv4' || i.family === 4);
      if (!fam || i.internal || classifyAddress(i.address) !== 'lan' || seen.has(i.address)) continue;
      seen.add(i.address);
      let prefix = maskBits(i.netmask);
      if (prefix === null && typeof i.cidr === 'string') {
        const n = Number(i.cidr.split('/')[1]);
        if (Number.isInteger(n) && n >= 0 && n <= 32) prefix = n;
      }
      if (prefix === null || prefix < MIN_LAN_PREFIX) prefix = 32;
      out.push({ address: i.address, prefix });
    }
  }
  return out;
}

/**
 * This computer's office-network (private LAN) IPv4 addresses, os.networkInterfaces() shape.
 * Used by office-network hosting (a teammate let into a company file on the shared drive).
 */
function lanIPv4s(ifaces) {
  return lanInterfaces(ifaces).map((i) => i.address);
}

const NO_OFFICE_NETWORK = 'This computer is not connected to an office network (no private network address was found).';

/**
 * Where the host proxy listens, from this computer's interface table. Each listener is
 * { host, kind, prefix? }:
 *  - 'lan': one of this computer's private LAN addresses (office-network mode), with its subnet
 *    prefix (used only to follow address changes, see lanListenerChanges);
 *  - 'tailnet': the tailnet address Tailscale confirmed;
 *  - 'all': 0.0.0.0, only with hosting.bindAll set in the app config by hand.
 * Who may connect is the same on all three (peerAllowedOn).
 * Office-network mode listens on every LAN address plus the tailnet one (when Tailscale confirmed
 * it); tailnet mode on the tailnet address only. Returns { ok, error, listeners }.
 */
function planListeners({ lan = false, bindAll = false, tailnetIp = null, ifaces = null } = {}) {
  if (bindAll === true) return { ok: true, error: null, listeners: [{ host: '0.0.0.0', kind: 'all' }] };
  const tailnet = tailnetIp && isTailnetIPv4(tailnetIp) ? [{ host: tailnetIp, kind: 'tailnet' }] : [];
  if (lan === true) {
    const listeners = [...lanInterfaces(ifaces).map((i) => ({ host: i.address, kind: 'lan', prefix: i.prefix })), ...tailnet];
    return listeners.length ? { ok: true, error: null, listeners } : { ok: false, error: NO_OFFICE_NETWORK, listeners: [] };
  }
  const sel = selectBindAddresses({ tailnetIp });
  return sel.ok ? { ok: true, error: null, listeners: tailnet } : { ok: false, error: sel.error, listeners: [] };
}

/**
 * May a device at `addr` use the listener `listener` ({ host, kind })? The same rule on every
 * listener, as before per-address listening (isPeerAllowed): private, tailnet and loopback
 * addresses, never the public internet. Listening per address changes where the proxy can be
 * reached, not who may connect: wired and Wi-Fi on different subnets, a guest or mesh split, a
 * site-to-site VPN, or a Tailscale subnet router with SNAT off all arrive from another private
 * range and must keep working.
 */
function peerAllowedOn(listener, addr) {
  if (!listener || !['lan', 'tailnet', 'all'].includes(listener.kind)) return false;
  return isPeerAllowed(addr);
}

/**
 * Office-network listeners after the computer's addresses changed (checked every few seconds
 * while hosting): a listener whose address is gone closes (the others keep running), and an
 * address that (re)appears in one of the subnets hosting started on gets a listener again (Wi-Fi
 * reconnecting, a new address from the same router). A network hosting did not start on (the
 * laptop carried to a café) is never listened on: turn multi-user mode off and on there.
 *
 * An address must be missing on `closeAfter` checks in a row before its listener closes: Windows
 * leaves an adapter out of the table while it is briefly not "up" (a Wi-Fi roam between access
 * points, a driver reset) although the address and the teammates' connections survive it, and
 * closing then would drop them mid-work.
 * `listening`: [{ host, kind, prefix }]; `homeSubnets`: Set of subnetKey()s planned at start;
 * `missed`: Map host -> checks in a row it was missing, as returned by the previous call.
 * Returns { close: [host], open: [listener], missed } (pass `missed` to the next call).
 */
function lanListenerChanges({ listening = [], ifaces = null, homeSubnets = new Set(), missed = new Map(), closeAfter = CLOSE_AFTER_MISSES } = {}) {
  const now = lanInterfaces(ifaces);
  const present = new Set(now.map((i) => i.address));
  const listeningHosts = new Set(listening.map((l) => l.host));
  const close = [];
  const stillMissing = new Map();
  for (const l of listening) {
    if (l.kind !== 'lan' || present.has(l.host)) continue;
    const n = (missed.get(l.host) || 0) + 1;
    if (n >= closeAfter) close.push(l.host);
    else stillMissing.set(l.host, n);
  }
  return {
    close,
    open: now
      .filter((i) => !listeningHosts.has(i.address) && homeSubnets.has(subnetKey(i.address, i.prefix)))
      .map((i) => ({ host: i.address, kind: 'lan', prefix: i.prefix })),
    missed: stillMissing,
  };
}

/**
 * Share URLs for the listeners that are actually running (a listener that could not start is not
 * offered to teammates). Office-network mode: HTTPS on each LAN address, then the tailnet one;
 * with bindAll, every LAN address on the interface table. Tailnet mode: shareUrls().
 */
function shareUrlsForListeners({ listeners = [], lan = false, port, tls = false, dnsName = null, tailnetIp = null, ifaces = null }) {
  if (lan) {
    if (listeners.some((l) => l.kind === 'all')) return lanShareUrls({ lanIps: lanIPv4s(ifaces), tailnetIp, port });
    const t = listeners.find((l) => l.kind === 'tailnet');
    return lanShareUrls({ lanIps: listeners.filter((l) => l.kind === 'lan').map((l) => l.host), tailnetIp: t ? t.host : null, port });
  }
  return shareUrls({ proxyHosts: listeners.map((l) => l.host), port, tls, dnsName, tailnetIp });
}

/** { name, port } of a Host header value (lower case, no brackets or trailing dot), or null. */
function parseHostHeader(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || /[\s/?#@\\]/.test(v)) return null;
  let name;
  let port = null;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return null;
    name = v.slice(1, end);
    const rest = v.slice(end + 1);
    if (rest) {
      const m = /^:(\d{1,5})$/.exec(rest);
      if (!m) return null;
      port = Number(m[1]);
    }
  } else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(v);
    if (!m) return null;
    name = m[1];
    if (m[2] !== undefined) port = Number(m[2]);
  }
  name = name.replace(/\.$/, '');
  return name ? { name, port } : null;
}

/** Host names the proxy answers to: the hosts of its share URLs and this computer's MagicDNS name. */
function servedHostNames({ urls = [], dnsName = null } = {}) {
  const names = new Set();
  for (const u of urls || []) {
    try {
      names.add(new URL(u).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  if (typeof dnsName === 'string' && dnsName.trim()) names.add(dnsName.trim().replace(/\.$/, '').toLowerCase());
  return names;
}

/**
 * Is a request's Host header one this proxy serves? Its name must be one of `names` (share URL
 * hosts, the MagicDNS name) or the very address the connection arrived on, and a port, when
 * given, must be the one it arrived on. A DNS-rebinding page in a teammate's browser names its
 * own domain here, so it is refused before it can become same-origin with the hosted app.
 */
function isServedHost(hostHeader, { names = new Set(), localAddress = '', localPort = null } = {}) {
  const h = parseHostHeader(hostHeader);
  if (!h) return false;
  if (h.port !== null && h.port !== Number(localPort)) return false;
  if (names.has(h.name)) return true;
  const local = unmapAddress(localAddress || '');
  return Boolean(local) && h.name === local;
}

/**
 * Simultaneous-connection bookkeeping for the proxy: at most `maxTotal` across every listener and
 * `maxPerPeer` from one address, so one device cannot hold every slot. acquire(peer) -> boolean;
 * release(peer) once that connection closes.
 */
function createConnectionLimiter({ maxTotal = 400, maxPerPeer = 20 } = {}) {
  const perPeer = new Map();
  let total = 0;
  return {
    acquire(peer) {
      const n = perPeer.get(peer) || 0;
      if (total >= maxTotal || n >= maxPerPeer) return false;
      perPeer.set(peer, n + 1);
      total += 1;
      return true;
    },
    release(peer) {
      const n = perPeer.get(peer) || 0;
      if (n <= 0) return;
      if (n === 1) perPeer.delete(peer);
      else perPeer.set(peer, n - 1);
      total = Math.max(0, total - 1);
    },
    count(peer) {
      return peer === undefined ? total : perPeer.get(peer) || 0;
    },
  };
}

/** A Cookie header without cookie `name` (any letter case), or null when nothing is left. */
function stripCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  const drop = String(name).trim().toLowerCase();
  const kept = cookieHeader
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && (p.indexOf('=') < 0 ? p : p.slice(0, p.indexOf('='))).trim().toLowerCase() !== drop);
  return kept.length ? kept.join('; ') : null;
}

/** Office-network hosting URLs: every LAN address, then the tailnet one (always HTTPS). */
function lanShareUrls({ lanIps, tailnetIp, port }) {
  const urls = (lanIps || []).map((ip) => `https://${ip}:${port}`);
  if (tailnetIp) urls.push(`https://${tailnetIp}:${port}`);
  return [...new Set(urls)];
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

/**
 * Location header the proxy hands a teammate. Next.js builds absolute redirect URLs from the
 * address the app server is bound to and spells loopback as "localhost" (NextURL), so an /unlock
 * or /login redirect points at http(s)://localhost:<upstreamPort>/ — nothing on the teammate's
 * computer. A redirect aimed at the upstream server is moved onto the origin the teammate used
 * (scheme from the proxy, host from their request); any other Location passes through unchanged.
 */
function rewriteUpstreamLocation(location, upstreamPort, { secure, host }) {
  if (typeof location !== 'string' || !location || typeof host !== 'string' || !host) return location;
  let u;
  try {
    u = new URL(location);
  } catch {
    return location; // relative: the browser resolves it against the proxy's origin already
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(u.hostname);
  // Next builds the URL with the scheme the proxy forwards (x-forwarded-proto), so over HTTPS it
  // is https://localhost:<upstreamPort>/… — both schemes point at the app server here.
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !loopback || Number(u.port) !== Number(upstreamPort)) return location;
  let client;
  try {
    client = new URL(`${secure ? 'https' : 'http'}://${host}`);
  } catch {
    return location;
  }
  if (client.username || client.password || client.pathname !== '/' || client.search || client.hash) return location;
  return `${client.origin}${u.pathname}${u.search}${u.hash}`;
}

module.exports = {
  DEFAULT_HOSTING_PORT,
  rewriteUpstreamLocation,
  parseIPv4,
  inCidr4,
  isTailnetIPv4,
  unmapAddress,
  classifyAddress,
  isPeerAllowed,
  parseTailscaleIpOutput,
  parseTailscaleStatus,
  confirmTailnetIPv4,
  selectBindAddresses,
  normalizeHostAddress,
  shareUrls,
  maskBits,
  subnetKey,
  lanInterfaces,
  lanIPv4s,
  lanShareUrls,
  planListeners,
  peerAllowedOn,
  lanListenerChanges,
  shareUrlsForListeners,
  parseHostHeader,
  servedHostNames,
  isServedHost,
  createConnectionLimiter,
  stripCookie,
};
