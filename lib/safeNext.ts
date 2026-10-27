/**
 * Where to go after signing in, unlocking the file or changing a password: the `?next=` the
 * sign-in gates were sent with (middleware, lib/client.ts, getPageContext). Only a path inside
 * this app is ever followed, so a link like `/login?next=https://evil.example` (or
 * `next=javascript:…`, which would run script in the app when assigned to location) can never
 * take the person — or their session — anywhere else.
 *
 * Browsers read `\` as `/` and drop tabs / newlines in URLs, so `/\evil.example` and
 * `/<tab>/evil.example` are other sites too: anything with a backslash or a control character is
 * refused, and the result is re-checked by resolving it against a placeholder origin.
 *
 * Dependency-free: used by client pages (app/login, app/unlock, app/change-password, app/security).
 */
const BASE = 'http://ironbooks.invalid';

export function safeNext(raw: string | null | undefined, fallback = '/dashboard', exclude: readonly string[] = []): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== BASE) return fallback;
  const target = u.pathname + u.search + u.hash;
  if (!target.startsWith('/') || target.startsWith('//')) return fallback;
  if (exclude.some((p) => u.pathname === p || u.pathname.startsWith(p + '/'))) return fallback;
  return target;
}
