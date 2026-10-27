/**
 * QuickBooks Enterprise "View Balance" (prefsperms, PARITY K).
 *
 * A role can be allowed to work in a register, the chart of accounts or a customer / vendor
 * center WITHOUT seeing balances. The API routes of those screens pass their answer through
 * `hideBalances`, which blanks every balance field (null) and marks the object `balanceHidden:
 * true`, so the screens show "Hidden" instead of a misleading $0.00 (`balanceText`).
 *
 * Pure (no DB): used by the API routes (through lib/services/access.ts balancesForContext) and the
 * screens.
 */

/** Field names that carry an account's or a name's balance. */
export const BALANCE_KEYS = new Set([
  'balance',
  'runningBalance',
  'openingBalance',
  'closingBalance',
  'foreignRunningBalance',
  'foreignOpeningBalance',
  'foreignClosingBalance',
  'lastReconciledBalance',
  'totalBalanceDue',
  'openBalance',
  'currentBalance',
  'endingBalance',
]);

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep copy of plain JSON with every balance field blanked (`balanceHidden: true` where it was). */
export function hideBalances<T>(data: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      let hid = false;
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (BALANCE_KEYS.has(k) && (typeof val === 'string' || typeof val === 'number' || val === null)) {
          out[k] = null;
          hid = true;
        } else {
          out[k] = walk(val);
        }
      }
      if (hid) out.balanceHidden = true;
      return out;
    }
    return v;
  };
  return walk(data) as T;
}

/** What a screen shows for a balance: the formatted amount, or "Hidden" without View Balance. */
export function balanceText(
  value: string | number | null | undefined,
  format: (v: string | number) => string,
  hidden?: boolean,
): string {
  if (hidden) return 'Hidden';
  if (value === null || value === undefined) return '';
  return format(value);
}

/** Tooltip for a hidden balance. */
export const HIDDEN_BALANCE_TITLE = 'Your role does not include View Balance. Ask your administrator.';
