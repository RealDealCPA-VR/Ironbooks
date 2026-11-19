/**
 * Which host did a request name, and did it come through the multi-user host proxy?
 *
 * Edge-safe (no Node imports): middleware.ts and lib/context.ts both use it.
 *
 * The app server only listens on 127.0.0.1, so a request naming any other host either came
 * through the multi-user proxy (electron/hosting.js, which stamps x-bka-remote-addr AND the
 * sec-bka-proxy mark no web page can set) or from a web page that rebound its own name to
 * 127.0.0.1 to reach the books as if it were the app (DNS rebinding).
 */

type HeaderSource = { get(name: string): string | null };

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
 * the proxy's "Sec-" mark (a page can add x-bka-remote-addr itself, never a Sec- header).
 */
export function isProxiedRequest(h: HeaderSource): boolean {
  return Boolean(h.get('x-bka-remote-addr')) && h.get('sec-bka-proxy') === '1';
}
