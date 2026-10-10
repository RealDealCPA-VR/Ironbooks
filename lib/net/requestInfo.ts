/**
 * Where did this request come from — this machine, or a teammate through the multi-user host?
 *
 * The Next server only ever listens on 127.0.0.1. When the desktop app hosts the company file
 * for other users (electron/hosting.js), their requests arrive through a small reverse proxy
 * on the tailnet address that ALWAYS overwrites `x-bka-remote-addr` with the real peer address
 * (a client cannot forge or remove it). A request without that header therefore came from a
 * process on this machine.
 *
 * Remote requests are held to stricter rules: legacy session cookies without a server-side
 * session are refused, the first-run fallback is closed, password-reset tokens are never
 * returned in the response, and cookies are marked Secure when the host serves HTTPS.
 */
import { headers } from 'next/headers';

export const REMOTE_ADDR_HEADER = 'x-bka-remote-addr';

export interface RequestOrigin {
  /** True when the request came through the multi-user host proxy (another machine). */
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
  const remote = Boolean(remoteAddr);
  return {
    remote,
    addr: remote ? String(remoteAddr).slice(0, 100) : 'local',
    https: remote && h.get('x-forwarded-proto') === 'https',
    userAgent: h.get('user-agent'),
  };
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
