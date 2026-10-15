/**
 * Month-end close helpers shared by the server (lib/services/monthEndClose.ts) and the page
 * (app/month-end/page.tsx). Pure: no database or server-only imports, safe in client bundles.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of `now` on the LOCAL calendar (the desktop app's clock), not UTC. */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Last day of the month `back` months before the current LOCAL month ('YYYY-MM-DD'). */
export function monthEndBefore(back: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - back + 1, 0));
  return d.toISOString().slice(0, 10);
}

export type ClosePasswordMode = 'keep' | 'set' | 'remove';

/**
 * What is wrong with the closing-date password choice on the final step, or null when it is fine.
 * "Set a password" always needs a password typed (twice): choosing it and leaving it blank would
 * otherwise close the books with no password and no hint. "No password" / "Remove" covers that.
 */
export function closePasswordProblem(input: {
  mode: ClosePasswordMode;
  password: string;
  confirm: string;
  hasClosingPassword: boolean;
}): string | null {
  if (input.mode !== 'set') return null;
  if (!input.password) {
    return input.hasClosingPassword
      ? 'Type the new password, or choose Keep the current password.'
      : 'Type a password, or choose No password.';
  }
  if (input.password !== input.confirm) return 'The two passwords do not match.';
  return null;
}
