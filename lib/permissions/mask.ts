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
