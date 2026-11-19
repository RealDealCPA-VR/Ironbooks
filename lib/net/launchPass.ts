/**
 * The desktop shell's per-launch pass: proof that a request on 127.0.0.1 comes from Ironbooks
 * itself, not from another program or another Windows account on this computer.
 *
 * The server listens on 127.0.0.1 only, but so can anything else running on the computer. At
 * start the shell (electron/main.js) makes a random value, hands it to this server in the
 * environment (BKA_LAUNCH_PASS, never on the command line) and puts it on its own window as an
 * HttpOnly, SameSite=Strict cookie (bka_launch). Pop-ups the app opens (PDF preview, printable
 * forms) share that window's cookies; the shell's own calls send it as a header (x-bka-launch).
 *
 * A request that did not come through the multi-user proxy and does not carry the pass gets the
 * same, lower trust as a teammate's device (lib/net/requestInfo.ts originFromHeaders): no reset
 * token in the reply, no first-account setup, no file paths, no first-run fallback.
 *
 * Only enforced when BKA_LAUNCH_PASS is set, so `next dev`, the test suite and the scripts that
 * start the standalone server themselves keep working without one.
 *
 * Edge-safe (no Node imports).
 */

export const LAUNCH_PASS_ENV = 'BKA_LAUNCH_PASS';
export const LAUNCH_PASS_COOKIE = 'bka_launch';
export const LAUNCH_PASS_HEADER = 'x-bka-launch';

type HeaderSource = { get(name: string): string | null };

/** The pass this server expects, or null when none was given (not enforced). */
export function expectedLaunchPass(env: Record<string, string | undefined> = process.env): string | null {
  const v = env[LAUNCH_PASS_ENV];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Compare two strings without stopping at the first difference, so the time taken says nothing
 * about how much of a guess was right. (The pass has a fixed, public length.)
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Every value of cookie `name` in a Cookie header (a page can add a second one of its own). */
function cookieValues(cookieHeader: string | null, name: string): string[] {
  if (!cookieHeader) return [];
  const out: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) out.push(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * True when the request carries this launch's pass (cookie or header), or when no pass is
 * enforced. Constant-time comparison for every candidate value.
 */
export function carriesLaunchPass(h: HeaderSource, expected: string | null = expectedLaunchPass()): boolean {
  if (expected === null) return true;
  const candidates = [...cookieValues(h.get('cookie'), LAUNCH_PASS_COOKIE)];
  const header = h.get(LAUNCH_PASS_HEADER);
  if (header) candidates.push(header.trim());
  let ok = false;
  for (const c of candidates) ok = constantTimeEqual(c, expected) || ok;
  return ok;
}
