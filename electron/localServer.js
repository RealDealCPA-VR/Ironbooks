// The desktop shell's link to its own app server on this computer (electron/main.js).
//
//  - Calls by exact address. The server listens on 127.0.0.1 only, but Node's fetch (like the
//    window, see the host-resolver rule in main.js) tries "localhost" over IPv6 first, so another
//    program listening on [::1]:<port> would receive the shell's calls and its internal token.
//  - The per-launch pass (lib/net/launchPass.ts): the window carries it as a cookie, the shell's
//    own calls as a header. The names here must match that module (test/security1.shell.test.ts).
//  - The start-up check: before the window or any call with the internal token goes to the port,
//    the server must answer a random nonce with a keyed hash only the server the shell started
//    can compute (GET /api/handshake, lib/net/internalToken.ts serverCheckProof). The port is
//    picked free and released before the server binds it, so something else could take it first.
//  - The server's environment: the installed app does not pass developer switches set on this
//    computer (BKA_ALLOW_DEV_FALLBACK, BKA_AUTH_SECRET, NODE_OPTIONS…) on to its server.
//
// Pure helpers (fetch injected) so they can be unit-tested without Electron.

'use strict';

const crypto = require('node:crypto');

const LAUNCH_PASS_ENV = 'BKA_LAUNCH_PASS';
const LAUNCH_PASS_COOKIE = 'bka_launch';
const LAUNCH_PASS_HEADER = 'x-bka-launch';
const HANDSHAKE_ROUTE = '/api/handshake';

/**
 * `route` (a path such as "/api/x?y=1") on the app server at `baseUrl`, addressed as 127.0.0.1.
 * Null when `baseUrl` is not the app server on this computer (a multi-user host, anything else):
 * the shell never sends its credentials there.
 */
function directUrl(baseUrl, route = '/') {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return null;
  let u;
  try {
    u = new URL(route, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost') u.hostname = '127.0.0.1';
  else if (host !== '127.0.0.1') return null;
  return u.toString();
}

/** Headers for the shell's own calls: the internal token and this launch's pass. */
function shellHeaders(internalToken, launchPass) {
  return { 'x-bka-internal': internalToken, [LAUNCH_PASS_HEADER]: launchPass };
}

/** The answer only a server holding `token` gives for `nonce` (lib/net/internalToken.ts). */
function handshakeProof(token, nonce) {
  return crypto.createHmac('sha256', token).update(`ironbooks-server-check:${nonce}`).digest('hex');
}

/**
 * True when the program answering on 127.0.0.1:`port` is the server started with `token`.
 * Sends nothing secret (only a fresh random nonce). Any failure — no answer, a wrong or missing
 * proof, a redirect — counts as "not ours".
 */
async function isOwnServer(port, token, { fetchImpl = fetch, timeoutMs = 15000, nonce } = {}) {
  const n = nonce || crypto.randomBytes(32).toString('hex');
  try {
    const res = await fetchImpl(`http://127.0.0.1:${Number(port)}${HANDSHAKE_ROUTE}?nonce=${n}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) return false;
    const body = await res.json();
    const got = Buffer.from(body && typeof body.proof === 'string' ? body.proof : '');
    const want = Buffer.from(handshakeProof(token, n));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Developer switches the installed app never hands to its server. */
const DEV_SWITCHES = new Set(['BKA_ALLOW_DEV_FALLBACK', 'BKA_AUTH_SECRET', 'BKA_TEST_FAST_KDF']);
/**
 * NODE_* settings about reaching the internet through a company network (extra certificate
 * authorities, the system's certificates, a proxy): kept, they are not debugging switches.
 */
const NODE_KEPT = new Set(['NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY']);

/**
 * The part of this process's environment the app server inherits. Development runs pass
 * everything on; the installed app drops the developer switches above and every NODE_* variable
 * (NODE_OPTIONS can load code into the server or open a debugger) except NODE_KEPT. Names are
 * compared without regard to case, as Windows does. Everything the shell sets for the server
 * itself is added afterwards (main.js), so nothing it needs is lost here.
 */
function inheritedServerEnv(env, { packaged }) {
  const out = { ...env };
  if (!packaged) return out;
  for (const key of Object.keys(out)) {
    const k = key.toUpperCase();
    if (DEV_SWITCHES.has(k) || (k.startsWith('NODE_') && !NODE_KEPT.has(k))) delete out[key];
  }
  return out;
}

module.exports = {
  LAUNCH_PASS_ENV,
  LAUNCH_PASS_COOKIE,
  LAUNCH_PASS_HEADER,
  HANDSHAKE_ROUTE,
  directUrl,
  shellHeaders,
  handshakeProof,
  isOwnServer,
  inheritedServerEnv,
};
