/**
 * Sensitive-field masking for API responses (QB Enterprise "view sensitive data" permissions).
 *
 *  - SSNs / tax IDs (employee `ssn`, payroll form `ssn`/`employeeSsn`, vendor `taxId` -- a sole
 *    proprietor's TIN is their SSN) are masked to the last 4 digits
 *    unless the caller's roles grant `sensitivePayroll`.
 *  - Bank / account numbers (`accountNumber`, `routingNumber`) are masked to the last 4 unless
 *    the caller's roles grant `fullAccountNumbers`.
 *
 * `maskSensitive` deep-walks plain JSON (objects/arrays), so a route can pass its whole response
 * body. Contexts without `access` (trusted/internal) see everything.
 *
 * `stripSecrets` removes credential material that no response may carry whatever the caller's
 * roles (review round 5): password / answer hashes, TOTP secrets, reset tokens, sealed API keys and
 * the company-file password hash. Backups keep them (they restore the file); API answers never do.
 */
import type { EffectiveAccess } from './model';

const SSN_KEYS = new Set(['ssn', 'employeeSsn', 'taxId']);
const ACCOUNT_KEYS = new Set(['accountNumber', 'routingNumber', 'bankAccountNumber']);

/** True for a field name that maskSensitive may mask. */
export function isSensitiveKey(key: string): boolean {
  return SSN_KEYS.has(key) || ACCOUNT_KEYS.has(key);
}

/** True for a value produced by masking ("***-**-6789", "••••6789") — never real data. */
export function isMaskedValue(v: unknown): boolean {
  return typeof v === 'string' && /[*•]/.test(v);
}

/** "123-45-6789" → "***-**-6789"; anything with < 4 digits → "****". */
export function maskSsn(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4 ? `***-**-${digits.slice(-4)}` : '****';
}

/** "000123456789" → "••••6789". */
export function maskAccountNumber(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).replace(/\s/g, '');
  return s.length > 4 ? `••••${s.slice(-4)}` : '••••';
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function maskSensitive<T>(
  data: T,
  access: Pick<EffectiveAccess, 'flags'> | null | undefined,
): T {
  if (!access) return data;
  const showSsn = access.flags.sensitivePayroll;
  const showAcct = access.flags.fullAccountNumbers;
  if (showSsn && showAcct) return data;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    // Only plain objects are rebuilt — class instances (Date, Decimal, Buffer…) pass through.
    if (v && typeof v === 'object' && isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!showSsn && SSN_KEYS.has(k) && (typeof val === 'string' || typeof val === 'number')) {
          out[k] = maskSsn(val);
        } else if (
          !showAcct &&
          ACCOUNT_KEYS.has(k) &&
          (typeof val === 'string' || typeof val === 'number')
        ) {
          out[k] = maskAccountNumber(val);
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  };
  return walk(data) as T;
}

/**
 * Keys holding credential material. They are removed from API answers for everyone, the Admin
 * included: a bcrypt hash can be cracked offline (the closing-date password exists to stop users
 * who have the closed-period right but not the password).
 */
const SECRET_KEYS = new Set([
  'passwordHash',
  'portalPasswordHash',
  'closingDatePasswordHash',
  'challengeAnswerHash',
  'totpSecret',
  'resetToken',
  'apiKeyEnc',
]);

/** True for a field name stripSecrets removes. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

/**
 * Deep copy of plain JSON without credential material: secret keys are dropped (a portal password
 * becomes `hasPortalPassword`), and the company-file lock `{ enabled, hash }` becomes `{ enabled }`.
 * Class instances (Date, Decimal, Buffer…) pass through untouched.
 */
export function stripSecrets<T>(data: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && isPlainObject(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(src)) {
        if (SECRET_KEYS.has(k)) {
          if (k === 'portalPasswordHash' && !('hasPortalPassword' in src)) out.hasPortalPassword = Boolean(val);
          continue;
        }
        if (k === 'fileLock' && val && typeof val === 'object' && !Array.isArray(val)) {
          const lock = val as { enabled?: unknown; hash?: unknown };
          out[k] = { enabled: Boolean(lock.enabled && lock.hash) };
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(data) as T;
}
