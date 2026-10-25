// Multi-user hosting for the desktop shell ("File > Host multi-user access").
//
// The Next server that owns the company file stays bound to 127.0.0.1. Hosting starts a small
// reverse proxy on this machine's Tailscale address that forwards to it, so teammates on the
// same tailnet can open the company in their own Ironbooks app (File > Open company on
// host…) or a browser. PGlite is single-process, so this one server remains the only writer.
//
// What the proxy guarantees (the server relies on it — see lib/net/requestInfo.ts):
//  - every forwarded request carries x-bka-remote-addr = the real peer address (any value the
//    client sent is discarded), so the server knows the request is remote and applies the
//    stricter rules (sign-in required, no first-run fallback, no reset tokens in responses);
//  - the internal shell token header (x-bka-internal) is stripped — remote clients can never
//    present it;
//  - connections from non-private addresses are dropped (matters only with "bind all");
//  - redirects the app server aims at itself (http://localhost:<port>/unlock) are moved onto
//    the address the teammate used (hostingCore.rewriteUpstreamLocation).
//
// TLS: when `tailscale cert` can issue a certificate for this machine's MagicDNS name, the
// proxy serves HTTPS with it (teammates use https://<name>.ts.net:<port>). Otherwise plain HTTP
// over the tailnet, which WireGuard already encrypts end to end.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { execFile } = require('node:child_process');
const core = require('./hostingCore');

const STRIP_REQUEST_HEADERS = [
  'x-bka-remote-addr',
  'x-bka-internal',
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

function tailscaleCandidates() {
  const list = ['tailscale'];
  if (process.platform === 'win32') {
    list.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'));
  } else if (process.platform === 'darwin') {
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

/** This machine's tailnet IPv4: `tailscale ip -4`, else scan interfaces for 100.64.0.0/10. */
async function detectTailnetIPv4() {
  try {
    const { stdout } = await runTailscale(['ip', '-4']);
    const ip = core.parseTailscaleIpOutput(stdout);
    if (ip) return ip;
  } catch {
    /* CLI missing / not logged in — fall back to interfaces */
  }
  return core.pickTailnetIPv4FromInterfaces(os.networkInterfaces());
}

/** MagicDNS name of this machine (e.g. office-pc.tail1234.ts.net), or null. */
async function tailscaleDnsName() {
  try {
    const { stdout } = await runTailscale(['status', '--json']);
    const name = JSON.parse(stdout)?.Self?.DNSName;
    return typeof name === 'string' && name ? name.replace(/\.$/, '') : null;
  } catch {
    return null;
  }
}

/** Ask Tailscale for a TLS certificate for this machine. Returns { cert, key, dnsName } or null. */
async function obtainTlsCert(certDir, log) {
  const dnsName = await tailscaleDnsName();
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

/** Request handler that forwards to the local app server with sanitized headers. */
function createProxyHandler(upstreamPort, { secure }) {
  return (req, res) => {
    const peer = core.unmapAddress(req.socket.remoteAddress || '');
    const headers = { ...req.headers };
    for (const h of STRIP_REQUEST_HEADERS) delete headers[h];
    headers['x-bka-remote-addr'] = peer || 'unknown';
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

/**
 * Start hosting. Options: { upstreamPort, port, tls, bindAll, certDir, log }.
 * Resolves the hosting state (servers + share URLs) or rejects with a user-facing message.
 */
async function startHosting(opts) {
  const log = opts.log || console.log;
  const port = Number(opts.port) || core.DEFAULT_HOSTING_PORT;
  const tailnetIp = await detectTailnetIPv4();
  // Office-network mode (opts.lan): a teammate on the same network was let into a company file on
  // the shared drive. Listen on every interface (peers are still limited to private addresses)
  // and always serve HTTPS with this computer's own certificate, which the teammate pins.
  const lan = opts.lan === true && opts.lanCert && opts.lanCert.cert;
  const bind = lan ? { ok: true, proxyHosts: ['0.0.0.0'] } : core.selectBindAddresses({ tailnetIp, bindAll: opts.bindAll === true });
  if (!bind.ok) throw new Error(bind.error);

  const tlsMaterial = lan
    ? { cert: opts.lanCert.cert, key: opts.lanCert.key, dnsName: null }
    : opts.tls === false
      ? null
      : await obtainTlsCert(opts.certDir, log);
  const secure = Boolean(tlsMaterial);
  const handler = createProxyHandler(opts.upstreamPort, { secure });

  const servers = [];
  try {
    for (const host of bind.proxyHosts) {
      const server = secure
        ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
        : http.createServer(handler);
      server.maxConnections = 400; // ~40 users × a handful of keep-alive connections each
      server.headersTimeout = 30000;
      server.requestTimeout = 5 * 60 * 1000; // large backups/imports
      // Refuse anything that isn't loopback / LAN / tailnet before a byte is read.
      server.on('connection', (socket) => {
        if (!core.isPeerAllowed(socket.remoteAddress)) {
          log(`[hosting] refused connection from ${socket.remoteAddress}`);
          socket.destroy();
        }
      });
      // No WebSocket/upgrade traffic is needed by the production app.
      server.on('upgrade', (_req, socket) => socket.destroy());
      await listen(server, host, port);
      servers.push(server);
    }
  } catch (err) {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
    if (err && err.code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use on this computer.`);
    throw err;
  }

  const urls = lan
    ? core.lanShareUrls({ lanIps: core.lanIPv4s(os.networkInterfaces()), tailnetIp, port })
    : core.shareUrls({
        proxyHosts: bind.proxyHosts,
        port,
        tls: secure,
        dnsName: tlsMaterial && tlsMaterial.dnsName,
        tailnetIp,
      });
  if (lan && !urls.length) {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
    throw new Error('This computer is not connected to an office network (no private network address was found).');
  }
  log(`[hosting] multi-user access on ${urls.join(', ')} (app server stays on 127.0.0.1)`);
  return {
    servers,
    port,
    tls: secure,
    dnsName: tlsMaterial ? tlsMaterial.dnsName : null,
    tailnetIp,
    addresses: bind.proxyHosts,
    urls,
    lan: Boolean(lan),
    fingerprint: lan ? opts.lanCert.fingerprint : null,
    startedAt: new Date().toISOString(),
  };
}

async function stopHosting(state) {
  if (!state || !state.servers) return;
  await Promise.all(
    state.servers.map(
      (s) =>
        new Promise((resolve) => {
          s.close(() => resolve());
          if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        }),
    ),
  );
}

module.exports = {
  startHosting,
  stopHosting,
  detectTailnetIPv4,
  createProxyHandler,
};
