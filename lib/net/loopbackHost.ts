/**
 * Which host did a request name, and did it come through the multi-user host proxy?
 *
 * Edge-safe (no Node imports): middleware.ts and lib/context.ts both use it.
 *
 * The app server only listens on 127.0.0.1, so a request naming any other host either came
 * through the multi-user proxy (electron/hosting.js, which stamps x-bka-remote-addr AND the
 * sec-bka-proxy mark no web page can set) or from a web page that rebound its own name to
 * 127.0.0.1 to reach the books as if it were the app (DNS rebinding).
 *
 * A web page cannot set a Sec- header, but any other program on this computer can send both
 * headers straight to 127.0.0.1 and claim to be any teammate. So the desktop shell also gives this
 * server a random secret per launch (BKA_PROXY_SECRET, in the environment), which the proxy stamps
 * on every request it forwards (x-bka-proxy-secret, any copy a client sent is discarded). While
 * one is set, only a request carrying it counts as proxied. Without one (`next dev`, the tests,
 * the scripts that start the standalone server themselves) the two headers are enough, as before.
 */
import { constantTimeEqual } from '@/lib/net/launchPass';

type HeaderSource = { get(name: string): string | null };

/** Names shared with the desktop shell (electron/hostingCore.js); they must match. */
export const PROXY_SECRET_ENV = 'BKA_PROXY_SECRET';
export const PROXY_SECRET_HEADER = 'x-bka-proxy-secret';

/** The proxy secret this server expects, or null when none was given (not enforced). */
export function expectedProxySecret(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[PROXY_SECRET_ENV];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * True when the request carries this launch's proxy secret, or when none is enforced. Constant-time
 * comparison (the secret has a fixed, public length).
 */
export function carriesProxySecret(h: HeaderSource, expected: string | null = expectedProxySecret()): boolean {
  if (expected === null) return true;
  const got = h.get(PROXY_SECRET_HEADER);
  return typeof got === 'string' && constantTimeEqual(got.trim(), expected);
}

/**
 * True when a Host header value names a loopback host (localhost / 127.x / [::1], any port).
 * No Host header at all (outside a request scope, scripts, tests) counts as loopback: every
 * browser names the host, so only a program that already reaches 127.0.0.1 directly can omit it.
 */
export function isLoopbackHostHeader(host: string | null | undefined): boolean {
  if (host === null || host === undefined) return true;
  const h = host.trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d*$/, '');
  if (name === 'localhost' || name === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * True when the request came through the multi-user host proxy: it carries the peer address AND
 * the proxy's "Sec-" mark (a page can add x-bka-remote-addr itself, never a Sec- header) AND, when
 * one is set, this launch's proxy secret (another program on this computer can add both headers).
 */
export function isProxiedRequest(h: HeaderSource, expected: string | null = expectedProxySecret()): boolean {
  return Boolean(h.get('x-bka-remote-addr')) && h.get('sec-bka-proxy') === '1' && carriesProxySecret(h, expected);
}
