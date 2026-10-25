/**
 * The desktop shell's per-launch token (BKA_INTERNAL_TOKEN, sent as x-bka-internal).
 *
 * The Electron main process has no session cookie, so the few calls it makes on its own — the
 * quit-time backup, the launch-time recurring run, saving the company file when it closes —
 * authenticate with a random token it generated for this launch and handed to this server. The
 * server listens on 127.0.0.1 only and the multi-user host proxy strips the header
 * (electron/hosting.js), so only the shell on this computer can present it.
 */
import { timingSafeEqual } from 'node:crypto';

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
