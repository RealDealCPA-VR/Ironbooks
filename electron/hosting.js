// Multi-user hosting for the desktop shell ("File > Host multi-user access").
//
// The Next server that owns the company file stays bound to 127.0.0.1. Hosting starts a small
// reverse proxy on this machine's Tailscale address that forwards to it, so teammates on the
// same tailnet can open the company in their own Ironbooks app (File > Open company on
// host…) or a browser. PGlite is single-process, so this one server remains the only writer.
//
// Office-network mode (a teammate let into a company file on the shared drive) listens on each of
// this computer's private LAN addresses instead, one listener per address (the addresses
// teammates are given), plus the tailnet address when Tailscale confirms one — never on an
// interface it does not advertise. Who may connect is unchanged (hostingCore.peerAllowedOn).
//
// What the proxy guarantees (the server relies on it — see lib/net/requestInfo.ts):
//  - every forwarded request carries x-bka-remote-addr = the real peer address (any value the
//    client sent is discarded), so the server knows the request is remote and applies the
//    stricter rules (sign-in required, no first-run fallback, no reset tokens in responses);
//  - the internal shell token header (x-bka-internal) and the desktop window's per-launch pass
//    (x-bka-launch header, bka_launch cookie) are stripped — remote clients can never present
//    them;
//  - a request naming a host this proxy does not serve is refused (DNS rebinding);
//  - connections from public internet addresses are dropped, and one device cannot hold more
//    than a handful of the connection slots or keep a silent connection open;
//  - redirects the app server aims at itself (http://localhost:<port>/unlock) are moved onto
//    the address the teammate used (hostingCore.rewriteUpstreamLocation).
//
// TLS: when `tailscale cert` can issue a certificate for this machine's MagicDNS name, the
// proxy serves HTTPS with it (teammates use https://<name>.ts.net:<port>). Otherwise plain HTTP
// over the tailnet, which WireGuard already encrypts end to end — only on an address Tailscale
// itself confirmed (hostingCore.confirmTailnetIPv4).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFile } = require('node:child_process');
const core = require('./hostingCore');
const { LAUNCH_PASS_COOKIE, LAUNCH_PASS_HEADER } = require('./localServer');

const STRIP_REQUEST_HEADERS = [
  'x-bka-remote-addr',
  'sec-bka-proxy',
  'x-bka-internal',
  LAUNCH_PASS_HEADER,
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'forwarded',
  'x-real-ip',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'upgrade',
];

/**
 * Connection limits for every listener. Timeouts only cover what a well-behaved client finishes
 * at once: the request headers (and, over HTTPS, the TLS handshake before them). Request bodies
 * stream straight through to the app server (createProxyHandler pipes them), so a long backup or
 * receipt upload is bounded only by requestTimeout, as before; an idle keep-alive connection
 * between requests is Node's keepAliveTimeout, also as before.
 */
const LIMITS = {
  maxConnections: 400, // ~40 users × a handful of keep-alive connections each
  maxPerPeer: 20, // one app window opens up to 6 per host; room for a browser tab or two as well
  headersTimeoutMs: 10_000,
  handshakeTimeoutMs: 10_000,
  // How often Node checks for connections past headersTimeout (so ~10-12 s in practice).
  checkIntervalMs: 2_000,
  requestTimeoutMs: 5 * 60 * 1000, // large backups/imports
  // Office-network mode: how often the computer's addresses are re-read (hostingCore.lanListenerChanges).
  watchIntervalMs: 10_000,
  // A LAN address that could not be listened on is tried again after this long.
  retryMs: 60_000,
};

const REFUSED_HOST_MESSAGE = 'This address is not served by the Ironbooks host. Use the address shown on the computer that has the company file open.';

function tailscaleCandidates() {
  // Windows: the installed copy by full path only (a bare name is looked up in the current
  // folder first — a planted tailscale.exe next to a shared company file would run).
  if (process.platform === 'win32') {
    return [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  }
  const list = ['tailscale'];
  if (process.platform === 'darwin') {
    list.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale');
  } else {
    list.push('/usr/bin/tailscale', '/usr/local/bin/tailscale');
  }
  return list;
}

/** Run the tailscale CLI (first binary that exists). Resolves { stdout } or rejects. */
function runTailscale(args, { cwd, timeoutMs = 8000 } = {}) {
  const candidates = tailscaleCandidates();
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      if (i >= candidates.length) {
        reject(new Error('The tailscale command was not found.'));
        return;
      }
      execFile(
        candidates[i],
        args,
        { cwd, timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) return tryAt(i + 1);
          if (err) return reject(new Error(String(stderr || err.message).trim()));
          resolve({ stdout: String(stdout) });
        },
      );
    };
    tryAt(0);
  });
}

/**
 * This machine's tailnet IPv4 and MagicDNS name, as Tailscale itself reports them:
 * `tailscale status --json` (else `tailscale ip -4` when the status cannot be read). Both null
 * when Tailscale does not confirm an address — the CLI is missing, Tailscale is stopped or
 * signed out — even if some interface has a 100.64.0.0/10 address (carrier-grade NAT from an
 * internet provider uses that range too).
 */
async function tailscaleSelf() {
  let status = null;
  try {
    status = core.parseTailscaleStatus((await runTailscale(['status', '--json'])).stdout);
  } catch {
    status = null; // CLI missing, not running, or an error message instead of JSON
  }
  let ipOutput = null;
  if (!status) {
    try {
      ipOutput = (await runTailscale(['ip', '-4'])).stdout;
    } catch {
      ipOutput = null;
    }
  }
  const ip = core.confirmTailnetIPv4({ status, ipOutput, ifaces: os.networkInterfaces() });
  return { ip, dnsName: ip && status ? status.dnsName : null };
}

/** This machine's tailnet IPv4, only when Tailscale confirms it (tailscaleSelf), else null. */
async function detectTailnetIPv4() {
  return (await tailscaleSelf()).ip;
}

/** Ask Tailscale for a TLS certificate for this machine. Returns { cert, key, dnsName } or null. */
async function obtainTlsCert(certDir, log, dnsName) {
  if (!dnsName) return null;
  try {
    fs.mkdirSync(certDir, { recursive: true });
    const certFile = path.join(certDir, `${dnsName}.crt`);
    const keyFile = path.join(certDir, `${dnsName}.key`);
    await runTailscale(['cert', '--cert-file', certFile, '--key-file', keyFile, dnsName], {
      cwd: certDir,
      timeoutMs: 60000,
    });
    try {
      fs.chmodSync(keyFile, 0o600);
    } catch {
      /* best effort (no-op on Windows) */
    }
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), dnsName };
  } catch (err) {
    log(`[hosting] tailscale cert unavailable (${err.message}); serving plain HTTP over the tailnet`);
    return null;
  }
}

/**
 * Request handler that forwards to the local app server with sanitized headers.
 * Options: { secure, servesHost?(req) -> boolean, onForward?(req) }. With `servesHost`, a request
 * naming a host the proxy does not serve is answered 421 and never forwarded.
 */
function createProxyHandler(upstreamPort, { secure, servesHost = null, onForward = null }) {
  return (req, res) => {
    if (servesHost && !servesHost(req)) {
      res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
      res.end(REFUSED_HOST_MESSAGE);
      req.resume();
      return;
    }
    if (onForward) onForward(req);
    const peer = core.unmapAddress(req.socket.remoteAddress || '');
    const headers = { ...req.headers };
    for (const h of STRIP_REQUEST_HEADERS) delete headers[h];
    // The desktop window's launch pass also travels as a cookie: never forward one from another
    // computer (such a request is classed remote anyway — lib/net/requestInfo.ts).
    const cookie = core.stripCookie(headers.cookie, LAUNCH_PASS_COOKIE);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    headers['x-bka-remote-addr'] = peer || 'unknown';
    // A "Sec-" header no web page can set (browsers forbid it in fetch / XHR): the app server takes a
    // request naming a non-loopback host as proxied only with it, so a DNS-rebinding page that adds
    // its own x-bka-remote-addr is still refused (middleware.ts).
    headers['sec-bka-proxy'] = '1';
    headers['x-forwarded-for'] = peer || 'unknown';
    headers['x-forwarded-proto'] = secure ? 'https' : 'http';
    if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;

    const upstream = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers },
      (up) => {
        const outHeaders = { ...up.headers };
        if (outHeaders.location) {
          outHeaders.location = core.rewriteUpstreamLocation(outHeaders.location, upstreamPort, {
            secure,
            host: req.headers.host,
          });
        }
        res.writeHead(up.statusCode || 502, outHeaders);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('The Ironbooks host is not responding.');
    });
    req.pipe(upstream);
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

/**
 * Start one listener ({ host, kind, prefix } from hostingCore.planListeners) on `ctx.port`.
 * ctx: { port, tlsMaterial, handler, conns (hostingCore.createConnectionLimiter), limits, log }.
 * Resolves the listening server, or rejects with the listen error (this listener only).
 */
async function openListener(listener, ctx) {
  const { port, tlsMaterial, handler, conns, log } = ctx;
  const limits = { ...LIMITS, ...(ctx.limits || {}) };
  const httpOptions = {
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    connectionsCheckingInterval: limits.checkIntervalMs,
  };
  const server = tlsMaterial
    ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key, handshakeTimeout: limits.handshakeTimeoutMs, ...httpOptions }, handler)
    : http.createServer(httpOptions, handler);
  server.maxConnections = limits.maxConnections;
  const busyLogged = new Map();
  // Refuse public internet addresses before a byte is read, and any device already holding its
  // share of connections.
  server.on('connection', (socket) => {
    const peer = core.unmapAddress(socket.remoteAddress || '');
    if (!core.peerAllowedOn(listener, peer)) {
      log(`[hosting] refused connection from ${socket.remoteAddress} on ${listener.host}`);
      socket.destroy();
      return;
    }
    if (!conns.acquire(peer)) {
      const now = Date.now();
      if (!(busyLogged.get(peer) > now - 60_000)) {
        if (busyLogged.size > 1000) busyLogged.clear();
        busyLogged.set(peer, now);
        log(`[hosting] too many connections from ${peer}; refusing more for now`);
      }
      socket.destroy();
      return;
    }
    socket.once('close', () => conns.release(peer));
  });
  // No WebSocket/upgrade traffic is needed by the production app.
  server.on('upgrade', (_req, socket) => socket.destroy());
  await listen(server, listener.host, port);
  // After it is listening, a failure on this listener (an accept error, its address going away)
  // is logged and stays with it: never an uncaught error that would take the others, or the
  // app, down.
  server.on('error', (err) => log(`[hosting] listener on ${listener.host} failed (${(err && (err.code || err.message)) || err})`));
  return server;
}

/**
 * Start every listener; one that cannot start (its address busy or gone) does not stop the others.
 * Resolves { started: [{ listener, server }], failed: [{ listener, error }] }.
 */
async function openListeners(listeners, ctx) {
  const results = await Promise.allSettled(listeners.map((l) => openListener(l, ctx)));
  const started = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') started.push({ listener: listeners[i], server: r.value });
    else failed.push({ listener: listeners[i], error: r.reason });
  });
  return { started, failed };
}

/** Per-state internals (listeners, the address watcher), kept off the state object main.js reads. */
const runtimes = new WeakMap();

function refreshShareUrls(state, rt) {
  const listeners = rt.running.map((r) => r.listener);
  state.servers = rt.running.map((r) => r.server);
  state.addresses = listeners.map((l) => l.host);
  state.urls = core.shareUrlsForListeners({
    listeners,
    lan: state.lan,
    port: state.port,
    tls: state.tls,
    dnsName: state.dnsName,
    tailnetIp: state.tailnetIp,
    ifaces: os.networkInterfaces(),
  });
  rt.served = core.servedHostNames({ urls: state.urls, dnsName: rt.dnsName });
}

/**
 * Office-network mode: follow this computer's addresses while hosting is on (every few seconds).
 * A listener whose address went away (missing on two checks in a row, so a momentary gap in the
 * table never drops teammates) closes on its own; an address that comes back, or a new one in a
 * subnet hosting started on, gets a listener; the share URLs (which main.js sends to the shared
 * drive with every heartbeat) follow. Resolves true when something changed.
 */
async function refreshLanListeners(state, ifaces = os.networkInterfaces()) {
  const rt = runtimes.get(state);
  if (!rt || rt.stopped || rt.refreshing || !rt.homeSubnets) return false;
  rt.refreshing = true;
  try {
    const { close, open, missed } = core.lanListenerChanges({
      listening: rt.running.map((r) => r.listener),
      ifaces,
      homeSubnets: rt.homeSubnets,
      missed: rt.missed,
    });
    rt.missed = missed;
    let changed = false;
    for (const host of close) {
      const gone = rt.running.find((r) => r.listener.host === host);
      if (!gone) continue;
      rt.running = rt.running.filter((r) => r !== gone);
      changed = true;
      rt.log(`[hosting] ${host} is no longer on this computer; stopped listening there`);
      closeServer(gone.server).catch(() => {});
    }
    const now = Date.now();
    for (const listener of open) {
      if ((rt.retryAt.get(listener.host) || 0) > now) continue;
      try {
        const server = await openListener(listener, rt.ctx);
        if (rt.stopped) {
          await closeServer(server);
          return changed;
        }
        rt.retryAt.delete(listener.host);
        rt.running.push({ listener, server });
        changed = true;
        rt.log(`[hosting] now also listening on ${listener.host}`);
      } catch (err) {
        if (!rt.retryAt.has(listener.host)) rt.log(`[hosting] could not listen on ${listener.host} (${(err && (err.code || err.message)) || err})`);
        rt.retryAt.set(listener.host, now + rt.limits.retryMs);
      }
    }
    if (changed) {
      refreshShareUrls(state, rt);
      rt.log(`[hosting] multi-user access now on ${state.urls.join(', ') || 'no address on this network'}`);
    }
    return changed;
  } finally {
    rt.refreshing = false;
  }
}

/**
 * Start hosting. Options: { upstreamPort, port, tls, bindAll, certDir, log, lan, lanCert }.
 * Resolves the hosting state (servers + share URLs) or rejects with a user-facing message.
 */
async function startHosting(opts) {
  const log = opts.log || console.log;
  const port = Number(opts.port) || core.DEFAULT_HOSTING_PORT;
  const limits = { ...LIMITS };
  // Only an address Tailscale itself confirms counts as the tailnet one.
  const self = await tailscaleSelf();
  const tailnetIp = self.ip;
  // Office-network mode (opts.lan): a teammate on the same network was let into a company file on
  // the shared drive. Listen on each of this computer's LAN addresses and the tailnet one (never
  // on an interface teammates are not given), and always serve HTTPS with this computer's own
  // certificate, which the teammate pins.
  const lan = opts.lan === true && opts.lanCert && opts.lanCert.cert;
  const plan = core.planListeners({ lan: Boolean(lan), bindAll: opts.bindAll === true, tailnetIp, ifaces: os.networkInterfaces() });
  if (!plan.ok) throw new Error(plan.error);

  const tlsMaterial = lan
    ? { cert: opts.lanCert.cert, key: opts.lanCert.key, dnsName: null }
    : opts.tls === false
      ? null
      : await obtainTlsCert(opts.certDir, log, self.dnsName);
  const secure = Boolean(tlsMaterial);
  // When each other computer last used the file (File > Switch to Single-user Mode asks first).
  const peers = new Map();
  const state = {
    servers: [],
    port,
    tls: secure,
    dnsName: tlsMaterial ? tlsMaterial.dnsName : null,
    tailnetIp,
    addresses: [],
    urls: [],
    lan: Boolean(lan),
    fingerprint: lan ? opts.lanCert.fingerprint : null,
    startedAt: new Date().toISOString(),
    peers,
  };
  const rt = {
    running: [],
    served: new Set(),
    // The MagicDNS name is served whether or not a certificate was issued for it.
    dnsName: self.dnsName,
    stopped: false,
    refreshing: false,
    watcher: null,
    homeSubnets: null,
    // LAN addresses missing from the last check(s), and how many in a row (lanListenerChanges).
    missed: new Map(),
    retryAt: new Map(),
    limits,
    log,
    ctx: null,
  };
  const handler = createProxyHandler(opts.upstreamPort, {
    secure,
    servesHost: (req) =>
      core.isServedHost(req.headers.host, { names: rt.served, localAddress: req.socket.localAddress, localPort: req.socket.localPort }),
    onForward: (req) => peers.set(req.socket.remoteAddress, Date.now()),
  });
  rt.ctx = { port, tlsMaterial, handler, conns: core.createConnectionLimiter({ maxTotal: limits.maxConnections, maxPerPeer: limits.maxPerPeer }), limits, log };

  const { started, failed } = await openListeners(plan.listeners, rt.ctx);
  for (const f of failed) log(`[hosting] could not listen on ${f.listener.host} (${(f.error && (f.error.code || f.error.message)) || f.error})`);
  if (!started.length) {
    const err = failed[0] && failed[0].error;
    if (err && err.code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use on this computer.`);
    throw err || new Error('Multi-user access could not start.');
  }
  rt.running = started;
  runtimes.set(state, rt);
  refreshShareUrls(state, rt);
  if (lan && !state.urls.length) {
    rt.stopped = true;
    await Promise.all(started.map((s) => closeServer(s.server)));
    throw new Error('This computer is not connected to an office network (no private network address was found).');
  }
  // Office-network mode on its own addresses: follow address changes (Wi-Fi reconnecting, a new
  // address from the same router) within the networks hosting started on.
  if (lan && plan.listeners.some((l) => l.kind === 'lan')) {
    rt.homeSubnets = new Set(plan.listeners.filter((l) => l.kind === 'lan').map((l) => core.subnetKey(l.host, l.prefix)));
    for (const f of failed) rt.retryAt.set(f.listener.host, Date.now() + limits.retryMs);
    rt.watcher = setInterval(() => {
      refreshLanListeners(state).catch((err) => log(`[hosting] address check failed (${err && err.message})`));
    }, limits.watchIntervalMs);
    if (typeof rt.watcher.unref === 'function') rt.watcher.unref();
  }
  log(`[hosting] multi-user access on ${state.urls.join(', ')} (app server stays on 127.0.0.1)`);
  return state;
}

/** How many other computers used the hosted file in the last `windowMs`. */
function activePeerCount(state, windowMs = 5 * 60 * 1000) {
  if (!state || !state.peers) return 0;
  const since = Date.now() - windowMs;
  let n = 0;
  for (const [addr, at] of state.peers) {
    if (at >= since && !/^(127\.|::1$|::ffff:127\.)/.test(String(addr))) n++;
  }
  return n;
}

async function stopHosting(state) {
  if (!state) return;
  const rt = runtimes.get(state);
  if (rt) {
    rt.stopped = true;
    if (rt.watcher) clearInterval(rt.watcher);
    const servers = rt.running.map((r) => r.server);
    rt.running = [];
    await Promise.all(servers.map(closeServer));
    return;
  }
  if (!state.servers) return;
  await Promise.all(state.servers.map(closeServer));
}

module.exports = {
  startHosting,
  stopHosting,
  activePeerCount,
  detectTailnetIPv4,
  createProxyHandler,
  openListener,
  openListeners,
  refreshLanListeners,
  LIMITS,
};
