/**
 * Where did this request come from — this machine, or a teammate through the multi-user host?
 *
 * The Next server only ever listens on 127.0.0.1. When the desktop app hosts the company file
 * for other users (electron/hosting.js), their requests arrive through a small reverse proxy
 * on the tailnet address that ALWAYS overwrites `x-bka-remote-addr` with the real peer address
 * (a client cannot forge or remove it) and stamps this launch's proxy secret
 * (lib/net/loopbackHost.ts). A request without that header came from a process on
 * this machine — and it counts as the app itself only when it also carries this launch's pass
 * (lib/net/launchPass.ts): any other program, or another Windows account, can reach 127.0.0.1
 * too, so without the pass it is treated like a teammate's device.
 *
 * Such a program can also send `x-bka-remote-addr` itself, straight to 127.0.0.1, to pose as a
 * teammate: spend that teammate's sign-in attempts (account lockouts are kept per account and
 * address for remote callers, lib/net/rateLimit.ts) or put a false address in session and audit
 * records. While the shell has given this server a proxy secret, a request carrying the header
 * without the secret is that program: remote-level trust under UNVERIFIED_LOCAL_ADDR, and the
 * address it claims is not used anywhere.
 *
 * Remote requests are held to stricter rules: legacy session cookies without a server-side
 * session are refused, the first-run fallback is closed, password-reset tokens are never
 * returned in the response, and cookies are marked Secure when the host serves HTTPS.
 */
import { headers } from 'next/headers';
import { carriesLaunchPass } from '@/lib/net/launchPass';
import { carriesProxySecret } from '@/lib/net/loopbackHost';

export const REMOTE_ADDR_HEADER = 'x-bka-remote-addr';

/**
 * The address recorded for a caller on this computer that is not the app (no launch pass), or
 * that claims a teammate's address without the multi-user proxy's secret. Its own value, so its
 * failed sign-ins never lock out the person using Ironbooks here (rate limits keep 'local' in a
 * realm of its own) nor a teammate, and the Multi-user page shows where it came from.
 */
export const UNVERIFIED_LOCAL_ADDR = 'this computer, outside Ironbooks';

export interface RequestOrigin {
  /**
   * True when the request came through the multi-user host proxy (another machine), or from a
   * program on this computer that is not the app (no launch pass, or a teammate's address claimed
   * without the proxy secret).
   */
  remote: boolean;
  /** Peer address ('local' for this machine). */
  addr: string;
  /** True when the client connected over HTTPS (host TLS via `tailscale cert`). */
  https: boolean;
  userAgent: string | null;
}

type HeaderSource = { get(name: string): string | null };

export function originFromHeaders(h: HeaderSource): RequestOrigin {
  const remoteAddr = h.get(REMOTE_ADDR_HEADER);
  const userAgent = h.get('user-agent');
  if (remoteAddr) {
    // Not through the proxy (no proxy secret, while one is set): a program on this computer posing
    // as a teammate. Remote-level trust, and nothing it claims (address, HTTPS) is believed.
    if (!carriesProxySecret(h)) return { remote: true, addr: UNVERIFIED_LOCAL_ADDR, https: false, userAgent };
    return {
      remote: true,
      addr: String(remoteAddr).slice(0, 100),
      https: h.get('x-forwarded-proto') === 'https',
      userAgent,
    };
  }
  if (!carriesLaunchPass(h)) {
    return { remote: true, addr: UNVERIFIED_LOCAL_ADDR, https: false, userAgent };
  }
  return { remote: false, addr: 'local', https: false, userAgent };
}

/** Request origin for the current server render / route (next/headers). */
export async function getRequestOrigin(): Promise<RequestOrigin> {
  try {
    return originFromHeaders(await headers());
  } catch {
    // Outside a request scope (scripts/tests): treat as local.
    return { remote: false, addr: 'local', https: false, userAgent: null };
  }
}

/**
 * Whether auth cookies should carry the Secure flag. Remote clients over plain HTTP (TLS not
 * available on the host) would otherwise never get a session; the tailnet itself is
 * WireGuard-encrypted. Local requests keep the previous production behaviour.
 */
export function cookieSecure(origin: RequestOrigin): boolean {
  if (origin.remote) return origin.https;
  return process.env.NODE_ENV === 'production';
}
