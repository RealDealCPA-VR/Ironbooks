/**
 * The desktop shell's per-launch token (BKA_INTERNAL_TOKEN, sent as x-bka-internal).
 *
 * The Electron main process has no session cookie, so the few calls it makes on its own — the
 * quit-time backup, the launch-time recurring run, saving the company file when it closes —
 * authenticate with a random token it generated for this launch and handed to this server. The
 * server listens on 127.0.0.1 only and the multi-user host proxy strips the header
 * (electron/hosting.js), so only the shell on this computer can present it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

type HeaderSource = { get(name: string): string | null };

/** Constant-time check of the x-bka-internal header against BKA_INTERNAL_TOKEN. */
export function isInternalRequest(req: { headers: HeaderSource }): boolean {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A nonce the shell may ask about: 32-128 hex characters (it sends 64). */
const NONCE_RE = /^[0-9a-f]{32,128}$/;

/**
 * The answer to the desktop shell's start-up check (GET /api/handshake?nonce=…): a keyed hash of
 * its random nonce with BKA_INTERNAL_TOKEN. Before the shell loads its window into this server or
 * sends it the internal token, it checks the answer (electron/localServer.js), which only the
 * server it started can give: another program that grabbed the port does not know the token, and
 * the answer is useless for any other nonce. Null when this server has no token (not started by
 * the desktop shell) or the nonce is malformed. Reveals nothing about the token itself.
 */
export function serverCheckProof(nonce: string | null | undefined): string | null {
  const token = process.env.BKA_INTERNAL_TOKEN;
  if (!token || typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  return createHmac('sha256', token).update(`ironbooks-server-check:${nonce}`).digest('hex');
}
