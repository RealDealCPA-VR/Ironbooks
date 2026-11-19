/**
 * Where did this request come from — this machine, or a teammate through the multi-user host?
 *
 * The Next server only ever listens on 127.0.0.1. When the desktop app hosts the company file
 * for other users (electron/hosting.js), their requests arrive through a small reverse proxy
 * on the tailnet address that ALWAYS overwrites `x-bka-remote-addr` with the real peer address
 * (a client cannot forge or remove it). A request without that header came from a process on
 * this machine — and it counts as the app itself only when it also carries this launch's pass
 * (lib/net/launchPass.ts): any other program, or another Windows account, can reach 127.0.0.1
 * too, so without the pass it is treated like a teammate's device.
 *
 * Remote requests are held to stricter rules: legacy session cookies without a server-side
 * session are refused, the first-run fallback is closed, password-reset tokens are never
 * returned in the response, and cookies are marked Secure when the host serves HTTPS.
 */
import { headers } from 'next/headers';
import { carriesLaunchPass } from '@/lib/net/launchPass';

export const REMOTE_ADDR_HEADER = 'x-bka-remote-addr';

/**
 * The address recorded for a caller on this computer that is not the app (no launch pass). Its
 * own value, so its failed sign-ins never lock out the person using Ironbooks here (rate limits
 * keep 'local' in a realm of its own), and the Multi-user page shows where it came from.
 */
export const UNVERIFIED_LOCAL_ADDR = 'this computer, outside Ironbooks';

export interface RequestOrigin {
  /**
   * True when the request came through the multi-user host proxy (another machine), or from a
   * program on this computer that is not the app (no launch pass).
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
