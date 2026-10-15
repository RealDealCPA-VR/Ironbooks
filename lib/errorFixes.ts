/**
 * Fix suggestions ("Fix errors where they happen").
 *
 * A failed save can carry machine-readable fixes next to its plain-language message:
 *
 *   { error, code, details, fixes: [{ id, label, kind: 'patch'|'navigate'|'retry', patch?, href? }] }
 *
 *  - 'patch'    — change the request body (and the form showing it), then save again.
 *                 Example: "Add $40.00 to line 3's credit".
 *  - 'retry'    — save the same thing again, optionally with a flag set by `patch` (for example
 *                 `overrideCreditLimit: true`) or after asking for the closing-date password
 *                 (`needs: 'closingPassword'`).
 *  - 'navigate' — open another screen (`href`) where the problem is fixed, e.g. Fiscal Periods.
 *
 * Patch paths address the REQUEST BODY the form sent ("lines.2.credit", "applications.0.amountApplied",
 * "date"), so the server can compute them without knowing the form; each form maps the changed
 * paths back onto its own state (see components/ErrorFixPanel.tsx).
 *
 * This module is pure (no DB, no React): the services use the builders to compute fixes with
 * Decimal-exact amounts, and the client uses the same builders for checks it runs before saving,
 * plus `applyFixPatch` to apply a fix. Unit-tested in lib/errorFixes.test.ts.
 */
import Decimal from 'decimal.js';
import { formatCurrency, toAmountString } from '@/lib/money';

export type FixKind = 'patch' | 'navigate' | 'retry';

export type FixPatchOp =
  /** Replace the value at `path` (creating parent objects as needed). */
  | { op: 'set'; path: string; value: unknown }
  /** Add `amount` (a decimal string, may be negative) to the money amount at `path` (2 dp). */
  | { op: 'add'; path: string; amount: string }
  /** Delete the property / array element at `path`. */
  | { op: 'remove'; path: string }
  /** Remove every element equal to `value` from the array at `path`. */
  | { op: 'pull'; path: string; value: unknown };

export interface ErrorFix {
  /** Stable id, e.g. 'balance-add', 'period-move-date', 'docnum-next'. */
  id: string;
  /** Button text, plain language: "Add $40.00 to line 3's credit". */
  label: string;
  kind: FixKind;
  patch?: FixPatchOp[];
  href?: string;
  /** Extra input the client must collect before retrying. */
  needs?: 'closingPassword';
  /** Optional one-line explanation shown under the button. */
  hint?: string;
}

const KINDS = new Set<FixKind>(['patch', 'navigate', 'retry']);
const OPS = new Set(['set', 'add', 'remove', 'pull']);

/** Money for labels: "$1,234.50". */
export function fixMoney(v: Decimal.Value): string {
  return formatCurrency(toAmountString(new Decimal(v)));
}

// ---------------------------------------------------------------------------
// Parsing / validation (client side: never trust the shape blindly)
// ---------------------------------------------------------------------------

function isOp(v: unknown): v is FixPatchOp {
  if (!v || typeof v !== 'object') return false;
  const o = v as { op?: unknown; path?: unknown; amount?: unknown };
  if (typeof o.op !== 'string' || !OPS.has(o.op) || typeof o.path !== 'string' || !o.path) return false;
  if (o.op === 'add') return typeof o.amount === 'string' && /^-?\d+(\.\d+)?$/.test(o.amount);
  return true;
}

/** Validate an unknown value (a response body's `fixes`) into ErrorFix[]; drops malformed entries. */
export function parseFixes(raw: unknown): ErrorFix[] {
  if (!Array.isArray(raw)) return [];
  const out: ErrorFix[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const x = f as Partial<ErrorFix>;
    if (typeof x.id !== 'string' || typeof x.label !== 'string' || !KINDS.has(x.kind as FixKind)) continue;
    if (x.kind === 'navigate' && (typeof x.href !== 'string' || !x.href.startsWith('/'))) continue;
    const patch = x.patch === undefined ? undefined : Array.isArray(x.patch) ? x.patch.filter(isOp) : undefined;
    if (x.kind === 'patch' && (!patch || patch.length === 0)) continue;
    out.push({
      id: x.id,
      label: x.label,
      kind: x.kind as FixKind,
      ...(patch && patch.length ? { patch } : {}),
      ...(x.kind === 'navigate' ? { href: x.href } : {}),
      ...(x.needs === 'closingPassword' ? { needs: 'closingPassword' as const } : {}),
      ...(typeof x.hint === 'string' ? { hint: x.hint } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying a patch (pure, immutable)
// ---------------------------------------------------------------------------

function splitPath(path: string): string[] {
  return path.split('.').filter((p) => p.length > 0);
}

/** Read the value at a dotted path ("lines.2.credit"); undefined when absent. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of splitPath(path)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function cloneContainer(v: unknown, nextKey: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') return { ...(v as Record<string, unknown>) };
  return /^\d+$/.test(nextKey) ? [] : {};
}

/** Copy-on-write update of the value at `path`; `fn` gets the old value, returns the new (or REMOVE). */
const REMOVE = Symbol('remove');
function updateAt(obj: unknown, keys: string[], fn: (old: unknown) => unknown): unknown {
  if (keys.length === 0) return fn(obj);
  const [key, ...rest] = keys;
  const copy = cloneContainer(obj, key);
  const old = (copy as Record<string, unknown>)[key];
  const next = updateAt(old, rest, fn);
  if (next === REMOVE) {
    if (Array.isArray(copy)) copy.splice(Number(key), 1);
    else delete (copy as Record<string, unknown>)[key];
  } else {
    (copy as Record<string, unknown>)[key] = next;
  }
  return copy;
}

function addMoney(old: unknown, amount: string): string {
  let base = new Decimal(0);
  if (typeof old === 'number' && Number.isFinite(old)) base = new Decimal(old);
  else if (typeof old === 'string' && old.trim()) {
    const s = old.trim().replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(s)) base = new Decimal(s);
  }
  return base.plus(new Decimal(amount)).toFixed(2);
}

/**
 * Apply fix operations to a request body (or any JSON-like object). Pure: returns a new object
 * and never mutates `target`. Money additions are Decimal-exact and produce 2-dp strings.
 */
export function applyFixPatch<T>(target: T, patch: readonly FixPatchOp[] | undefined): T {
  let out: unknown = target;
  for (const op of patch ?? []) {
    const keys = splitPath(op.path);
    if (keys.length === 0) continue;
    switch (op.op) {
      case 'set':
        out = updateAt(out, keys, () => op.value);
        break;
      case 'add':
        out = updateAt(out, keys, (old) => addMoney(old, op.amount));
        break;
      case 'remove':
        if (getPath(out, op.path) !== undefined) out = updateAt(out, keys, () => REMOVE);
        break;
      case 'pull':
        out = updateAt(out, keys, (old) =>
          Array.isArray(old) ? old.filter((v) => JSON.stringify(v) !== JSON.stringify(op.value)) : old,
        );
        break;
    }
  }
  return out as T;
}

/** Paths a fix changes (forms use this to copy the new values back into their own state). */
export function patchedPaths(fix: Pick<ErrorFix, 'patch'>): string[] {
  return (fix.patch ?? []).map((p) => p.path);
}

/** Parse "lines.3.credit" style paths: { collection: 'lines', index: 3, field: 'credit' }. */
export function parseLinePath(path: string): { collection: string; index: number; field: string } | null {
  const m = /^([A-Za-z_]\w*)\.(\d+)\.([A-Za-z_][\w.]*)$/.exec(path);
  return m ? { collection: m[1], index: Number(m[2]), field: m[3] } : null;
}

// ---------------------------------------------------------------------------
// Builders: each returns the fixes for one common error (Decimal-exact)
// ---------------------------------------------------------------------------

export interface BalanceLine {
  debit?: Decimal.Value | null;
  credit?: Decimal.Value | null;
}

function amt(v: Decimal.Value | null | undefined): Decimal {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  try {
    const s = typeof v === 'string' ? v.trim().replace(/,/g, '') : v;
    if (s === '') return new Decimal(0);
    return new Decimal(new Decimal(s).toFixed(2));
  } catch {
    return new Decimal(0);
  }
}

export interface BalanceSummary {
  totalDebit: string;
  totalCredit: string;
  /** debits − credits */
  difference: string;
  /** "Debits are $40.00 more than credits." (null when balanced) */
  message: string | null;
}

export function balanceSummary(lines: readonly BalanceLine[]): BalanceSummary {
  let d = new Decimal(0);
  let c = new Decimal(0);
  for (const l of lines) {
    d = d.plus(amt(l.debit));
    c = c.plus(amt(l.credit));
  }
  const diff = d.minus(c);
  const message = diff.isZero()
    ? null
    : diff.greaterThan(0)
      ? `Debits are ${fixMoney(diff)} more than credits.`
      : `Credits are ${fixMoney(diff.abs())} more than debits.`;
  return { totalDebit: d.toFixed(2), totalCredit: c.toFixed(2), difference: diff.toFixed(2), message };
}

/**
 * Out-of-balance journal entry / split: fixes that make debits equal credits.
 *
 * Primary fix: add the difference to the short side on the chosen line (`lineIndex`, 0-based),
 * or else the LAST line that already has an amount on the short side, or else the last empty
 * line. Alternative: lower the long side on the last line that can absorb it (stays > 0).
 * Line numbers in labels are 1-based (`lineNumberOffset` shifts them when the form shows a
 * different numbering).
 */
export function balanceFixes(
  lines: readonly BalanceLine[],
  opts: { path?: string; lineIndex?: number; lineNumbers?: readonly number[] } = {},
): ErrorFix[] {
  const path = opts.path ?? 'lines';
  const { difference } = balanceSummary(lines);
  const diff = new Decimal(difference);
  if (diff.isZero() || lines.length === 0) return [];
  const short: 'debit' | 'credit' = diff.greaterThan(0) ? 'credit' : 'debit';
  const long: 'debit' | 'credit' = short === 'credit' ? 'debit' : 'credit';
  const gap = diff.abs();
  const lineNo = (i: number) => opts.lineNumbers?.[i] ?? i + 1;
  const fixes: ErrorFix[] = [];

  const usable = (i: number) => amt(lines[i][long]).isZero(); // adding to the short side must not make a two-sided line
  let target = -1;
  if (opts.lineIndex !== undefined && opts.lineIndex >= 0 && opts.lineIndex < lines.length && usable(opts.lineIndex)) {
    target = opts.lineIndex;
  }
  if (target < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (amt(lines[i][short]).greaterThan(0)) { target = i; break; }
    }
  }
  if (target < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (amt(lines[i].debit).isZero() && amt(lines[i].credit).isZero()) { target = i; break; }
    }
  }
  if (target >= 0) {
    fixes.push({
      id: 'balance-add',
      kind: 'patch',
      label: `Add ${fixMoney(gap)} to line ${lineNo(target)}'s ${short}`,
      patch: [{ op: 'add', path: `${path}.${target}.${short}`, amount: gap.toFixed(2) }],
    });
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (amt(lines[i][long]).greaterThan(gap)) {
      fixes.push({
        id: 'balance-lower',
        kind: 'patch',
        label: `Lower line ${lineNo(i)}'s ${long} by ${fixMoney(gap)}`,
        patch: [{ op: 'add', path: `${path}.${i}.${long}`, amount: gap.negated().toFixed(2) }],
      });
      break;
    }
  }
  return fixes;
}

/** ISO yyyy-mm-dd → "Jan 5, 2026" (UTC; no locale surprises). */
export function friendlyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** The day after an ISO date (yyyy-mm-dd), as yyyy-mm-dd. */
export function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Date in a closed period. `firstOpenDate` is the first date that can be posted (computed by
 * lib/services/fiscalPeriods.ts firstOpenDate). Closing-date locks can be passed with the
 * password; a closed fiscal period has to be reopened.
 */
export function closedPeriodFixes(opts: {
  reason: 'closingDate' | 'fiscalPeriod';
  firstOpenDate: string | null;
  dateField?: string;
}): ErrorFix[] {
  const fixes: ErrorFix[] = [];
  if (opts.firstOpenDate) {
    fixes.push({
      id: 'period-move-date',
      kind: 'patch',
      label: `Move the date to ${friendlyDate(opts.firstOpenDate)} (first open date)`,
      patch: [{ op: 'set', path: opts.dateField ?? 'date', value: opts.firstOpenDate }],
    });
  }
  if (opts.reason === 'closingDate') {
    fixes.push({
      id: 'period-password',
      kind: 'retry',
      label: 'Enter the closing-date password',
      needs: 'closingPassword',
      hint: 'Keeps the date and records the change on the Closing Date Exception report.',
    });
  } else {
    fixes.push({ id: 'period-reopen', kind: 'navigate', label: 'Reopen the period (Fiscal Periods)', href: '/fiscal-periods' });
  }
  return fixes;
}

/** Number already used: switch to the next free number, or keep it (the existing override flag). */
export function duplicateNumberFixes(opts: {
  number: string;
  nextNumber: string | null;
  field: string;
  overrideFlag?: { path: string; value: unknown };
  label?: string;
}): ErrorFix[] {
  const what = opts.label ?? 'number';
  const fixes: ErrorFix[] = [];
  if (opts.nextNumber && opts.nextNumber !== opts.number) {
    fixes.push({
      id: 'docnum-next',
      kind: 'patch',
      label: `Use the next free ${what}, ${opts.nextNumber}`,
      patch: [{ op: 'set', path: opts.field, value: opts.nextNumber }],
    });
  }
  if (opts.overrideFlag) {
    fixes.push({
      id: 'docnum-keep',
      kind: 'retry',
      label: `Keep ${opts.number} anyway`,
      patch: [{ op: 'set', path: opts.overrideFlag.path, value: opts.overrideFlag.value }],
    });
  }
  return fixes;
}

/** Over the customer's credit limit: save anyway with the existing override (audited). */
export function creditLimitFixes(opts: { customerId?: string | null } = {}): ErrorFix[] {
  const fixes: ErrorFix[] = [
    {
      id: 'credit-limit-override',
      kind: 'retry',
      label: 'Save anyway',
      patch: [{ op: 'set', path: 'overrideCreditLimit', value: true }],
      hint: 'Going over the credit limit is recorded in the audit trail.',
    },
  ];
  if (opts.customerId) {
    fixes.push({
      id: 'credit-limit-review',
      kind: 'navigate',
      label: 'Review the customer',
      href: `/customers?focus=${encodeURIComponent(opts.customerId)}`,
    });
  }
  return fixes;
}

/** A required account left empty: use the default account. */
export function missingAccountFixes(opts: {
  paths: readonly string[];
  account: { id: string; name: string; code?: string | null } | null;
  lineNumbers?: readonly (number | null)[];
}): ErrorFix[] {
  if (!opts.account || opts.paths.length === 0) return [];
  const name = opts.account.code ? `${opts.account.code} ${opts.account.name}` : opts.account.name;
  const where =
    opts.paths.length === 1
      ? opts.lineNumbers?.[0]
        ? ` on line ${opts.lineNumbers[0]}`
        : ''
      : ` on the ${opts.paths.length} lines missing one`;
  return [
    {
      id: 'account-default',
      kind: 'patch',
      label: `Use ${name}${where}`,
      patch: opts.paths.map((p) => ({ op: 'set' as const, path: p, value: opts.account!.id })),
    },
  ];
}

/** Lines without a class while "warn when a transaction has no class" is on. */
export function missingClassFixes(opts: {
  paths: readonly string[];
  suggested: { id: string; name: string } | null;
}): ErrorFix[] {
  const fixes: ErrorFix[] = [];
  if (opts.suggested && opts.paths.length) {
    fixes.push({
      id: 'class-default',
      kind: 'patch',
      label: `Use class ${opts.suggested.name}`,
      patch: opts.paths.map((p) => ({ op: 'set' as const, path: p, value: opts.suggested!.id })),
    });
  }
  fixes.push({ id: 'class-skip', kind: 'retry', label: 'Save without a class' });
  return fixes;
}

export interface StockShortfall {
  itemId: string;
  name: string;
  /** Quantity this document sells. */
  need: string;
  /** Quantity available (on hand + what this document already took when editing). */
  have: string;
  /** Request-body line indexes selling this item. */
  lineIndexes: number[];
}

/** Selling more than on hand: continue (stock goes negative), sell only what is on hand, or adjust. */
export function negativeStockFixes(
  shortfalls: readonly StockShortfall[],
  opts: { continuePatch?: FixPatchOp[]; linesPath?: string } = {},
): ErrorFix[] {
  if (shortfalls.length === 0) return [];
  const path = opts.linesPath ?? 'lines';
  const fixes: ErrorFix[] = [
    {
      id: 'stock-continue',
      kind: 'retry',
      label: 'Sell anyway',
      hint: 'The quantity on hand goes below zero until you receive more.',
      ...(opts.continuePatch ? { patch: opts.continuePatch } : {}),
    },
  ];
  // "Sell only what's on hand" only when each short item sits on one line and some stock exists.
  const shrinkable = shortfalls.every((s) => s.lineIndexes.length === 1 && new Decimal(s.have).greaterThan(0));
  if (shrinkable) {
    fixes.push({
      id: 'stock-reduce',
      kind: 'patch',
      label:
        shortfalls.length === 1
          ? `Sell only the ${new Decimal(shortfalls[0].have).toString()} on hand`
          : 'Sell only what is on hand',
      patch: shortfalls.map((s) => ({
        op: 'set' as const,
        path: `${path}.${s.lineIndexes[0]}.quantity`,
        value: new Decimal(s.have).toString(),
      })),
    });
  }
  fixes.push({
    id: 'stock-adjust',
    kind: 'navigate',
    label: 'Adjust quantity on hand',
    href: '/inventory-ops',
  });
  return fixes;
}

export function negativeStockMessage(shortfalls: readonly StockShortfall[]): string {
  const parts = shortfalls.map(
    (s) => `${s.name}: selling ${new Decimal(s.need).toString()}, only ${new Decimal(s.have).toString()} on hand`,
  );
  return `Not enough inventory (${parts.join('; ')}). Selling it anyway makes the quantity on hand negative.`;
}

/** Sales tax is turned off but the form still charges it: remove the tax. */
export function removeTaxFixes(opts: { headerTax: boolean; linePaths: readonly string[] }): ErrorFix[] {
  const patch: FixPatchOp[] = [];
  if (opts.headerTax) patch.push({ op: 'set', path: 'taxRateId', value: null });
  for (const p of opts.linePaths) patch.push({ op: 'set', path: p, value: null });
  const fixes: ErrorFix[] = [];
  if (patch.length) fixes.push({ id: 'tax-remove', kind: 'patch', label: 'Remove the sales tax', patch });
  fixes.push({ id: 'tax-turn-on', kind: 'navigate', label: 'Turn sales tax on (Preferences)', href: '/settings' });
  return fixes;
}

export interface OverApplication {
  /** Request-body path of the cash amount to change ("applications.1.amountApplied"). */
  path: string;
  /** What the document still owes. */
  balanceDue: Decimal.Value;
  /** Discount + credits also going onto the same document (they use up part of the balance). */
  otherApplied?: Decimal.Value;
  /** Document label for the button, e.g. "invoice #1042". */
  label: string;
  /** False when a zero application is not allowed (bill payments): no fix then. */
  allowZero?: boolean;
}

/** One document received more than its balance: apply exactly what is still owed. */
export function overAppliedFixes(o: OverApplication): ErrorFix[] {
  const exact = amt(o.balanceDue).minus(amt(o.otherApplied ?? 0));
  if (exact.lessThan(0) || (exact.isZero() && o.allowZero === false)) return [];
  return [
    {
      id: 'apply-exact',
      kind: 'patch',
      label: exact.isZero()
        ? `Apply nothing more to ${o.label} (it is already covered)`
        : `Apply exactly ${fixMoney(exact)} to ${o.label} (the balance due)`,
      patch: [{ op: 'set', path: o.path, value: exact.toFixed(2) }],
    },
  ];
}

/** Applications add up to more than the payment: raise the payment, or trim the last application. */
export function appliedExceedsPaymentFixes(opts: {
  amountPath?: string;
  paymentAmount: Decimal.Value;
  applications: readonly { path: string; amount: Decimal.Value; label: string }[];
}): ErrorFix[] {
  const total = opts.applications.reduce((s, a) => s.plus(amt(a.amount)), new Decimal(0));
  const pay = amt(opts.paymentAmount);
  const excess = total.minus(pay);
  if (!excess.greaterThan(0)) return [];
  const fixes: ErrorFix[] = [
    {
      id: 'payment-raise',
      kind: 'patch',
      label: `Change the amount received to ${fixMoney(total)}`,
      patch: [{ op: 'set', path: opts.amountPath ?? 'amount', value: total.toFixed(2) }],
    },
  ];
  for (let i = opts.applications.length - 1; i >= 0; i--) {
    const a = opts.applications[i];
    if (amt(a.amount).greaterThan(excess)) {
      fixes.push({
        id: 'payment-trim',
        kind: 'patch',
        label: `Apply ${fixMoney(excess)} less to ${a.label}`,
        patch: [{ op: 'set', path: a.path, value: amt(a.amount).minus(excess).toFixed(2) }],
      });
      break;
    }
  }
  return fixes;
}

/**
 * Deposit includes payments / receipts that are not (or no longer) waiting in Undeposited Funds:
 * take them off this deposit.
 */
export function depositMismatchFixes(opts: {
  paymentIds?: readonly string[];
  salesReceiptIds?: readonly string[];
  reason: 'already_deposited' | 'not_undeposited' | 'voided';
}): ErrorFix[] {
  const patch: FixPatchOp[] = [
    ...(opts.paymentIds ?? []).map((id) => ({ op: 'pull' as const, path: 'paymentIds', value: id })),
    ...(opts.salesReceiptIds ?? []).map((id) => ({ op: 'pull' as const, path: 'salesReceiptIds', value: id })),
  ];
  if (!patch.length) return [];
  const n = patch.length;
  const what = n === 1 ? 'it' : `these ${n}`;
  const why =
    opts.reason === 'already_deposited' ? 'already deposited' : opts.reason === 'voided' ? 'voided' : 'not in Undeposited Funds';
  return [
    {
      id: 'deposit-remove',
      kind: 'patch',
      label: `Take ${what} off this deposit (${why})`,
      patch,
    },
    { id: 'deposit-review', kind: 'navigate', label: 'Review Undeposited Funds', href: '/deposits' },
  ];
}
