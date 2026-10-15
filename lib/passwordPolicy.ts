/**
 * Password policy shared by the server (sign-up, self-service and admin resets, employee portal)
 * and the client forms. Dependency-free so client components can import it.
 *
 * gapsb (K): each company file has its own policy (stored with the file, edited by an Admin on
 * Users & Roles; server side in lib/services/passwordPolicy.ts):
 *  - minimum length (never below MIN_PASSWORD_LENGTH = 8),
 *  - letters AND numbers required (on by default),
 *  - a symbol required (optional),
 *  - expiry after N days (0 = never) — an expired password still signs in, then must be changed,
 *  - no reuse of the last N passwords (0 = off).
 * Existing passwords are never rejected at sign-in; the rules apply when a password is SET.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export interface PasswordPolicy {
  /** Minimum number of characters (8–64). */
  minLength: number;
  /** At least one letter and one number. */
  requireLettersAndNumbers: boolean;
  /** At least one symbol (anything that is not a letter, number or space). */
  requireSymbol: boolean;
  /** Days before a password must be changed; 0 = never expires. */
  expiryDays: number;
  /** How many recent passwords (including the current one) can't be used again; 0 = no check. */
  historyCount: number;
}

export const DEFAULT_PASSWORD_POLICY: Readonly<PasswordPolicy> = {
  minLength: MIN_PASSWORD_LENGTH,
  requireLettersAndNumbers: true,
  requireSymbol: false,
  expiryDays: 0,
  historyCount: 0,
};

/** Allowed ranges for the numeric settings (inclusive). */
export const PASSWORD_POLICY_LIMITS = {
  minLength: [MIN_PASSWORD_LENGTH, 64],
  expiryDays: [0, 3650],
  historyCount: [0, 24],
} as const;

function intIn(v: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

/** A stored (possibly partial or old) policy with defaults filled in and values clamped. */
export function normalizePasswordPolicy(raw: unknown): PasswordPolicy {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PASSWORD_POLICY;
  return {
    minLength: intIn(r.minLength, PASSWORD_POLICY_LIMITS.minLength, d.minLength),
    requireLettersAndNumbers:
      typeof r.requireLettersAndNumbers === 'boolean' ? r.requireLettersAndNumbers : d.requireLettersAndNumbers,
    requireSymbol: typeof r.requireSymbol === 'boolean' ? r.requireSymbol : d.requireSymbol,
    expiryDays: intIn(r.expiryDays, PASSWORD_POLICY_LIMITS.expiryDays, d.expiryDays),
    historyCount: intIn(r.historyCount, PASSWORD_POLICY_LIMITS.historyCount, d.historyCount),
  };
}

/** What a new password is missing, in plain words (empty = it meets the policy). */
export function passwordProblems(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string[] {
  const p = typeof password === 'string' ? password : '';
  const out: string[] = [];
  if (p.length < Math.max(MIN_PASSWORD_LENGTH, policy.minLength)) {
    out.push(`at least ${Math.max(MIN_PASSWORD_LENGTH, policy.minLength)} characters`);
  }
  if (p.length > MAX_PASSWORD_LENGTH) out.push(`no more than ${MAX_PASSWORD_LENGTH} characters`);
  const chars = Array.from(p);
  if (policy.requireLettersAndNumbers) {
    if (!chars.some(isLetter)) out.push('a letter');
    if (!chars.some(isDigit)) out.push('a number');
  }
  if (policy.requireSymbol && !chars.some((c) => !isLetter(c) && !isDigit(c) && !/\s/.test(c))) {
    out.push('a symbol (like ! # or $)');
  }
  return out;
}

/** A letter in any alphabet that has upper/lower case (a-z, é, ж …). */
function isLetter(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** "The password needs at least 10 characters and a number." */
export function passwordProblemMessage(problems: string[]): string {
  if (problems.length === 0) return '';
  const list =
    problems.length === 1
      ? problems[0]
      : `${problems.slice(0, -1).join(', ')} and ${problems[problems.length - 1]}`;
  return `The password needs ${list}.`;
}

/** One-line description for password forms: "At least 8 characters, with letters and numbers." */
export function describePasswordPolicy(policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string {
  const parts = [`At least ${Math.max(MIN_PASSWORD_LENGTH, policy.minLength)} characters`];
  const need: string[] = [];
  if (policy.requireLettersAndNumbers) need.push('letters and numbers');
  if (policy.requireSymbol) need.push('a symbol');
  if (need.length) parts.push(`with ${need.join(' and ')}`);
  return parts.join(', ') + '.';
}

/** True when a password set at `changedAt` is past the policy's expiry (never when expiry is 0). */
export function isPasswordExpired(
  changedAt: Date | string | null | undefined,
  policy: PasswordPolicy,
  now: Date = new Date(),
): boolean {
  if (!policy.expiryDays || policy.expiryDays <= 0) return false;
  if (!changedAt) return true;
  const t = new Date(changedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= policy.expiryDays * 86_400_000;
}

/** Message used when a signed-in person must choose a new password first (server <-> client). */
export const PASSWORD_CHANGE_REQUIRED_MESSAGE = 'You need to choose a new password before you continue.';

export function isPasswordChangeRequiredError(status: number, message: string): boolean {
  return status === 403 && message === PASSWORD_CHANGE_REQUIRED_MESSAGE;
}
