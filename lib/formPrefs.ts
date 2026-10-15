'use client';
/**
 * Form-side checks driven by Preferences, shared by the transaction forms so each form needs only
 * a one-line call before saving:
 *  - confirmTransactionDate: Accounting > "Warn if transactions are N days in the past/future".
 *  - confirmStockAvailable: Items & Inventory > "Warn if not enough inventory to sell".
 *  - confirmClassAssigned: Accounting > class tracking "Warn when a transaction has no class".
 * Each returns true when the user may continue (no warning, or they chose to go ahead).
 */
import { transactionDateWarning } from '@/lib/preferences';
import type { PreferencesState } from '@/lib/usePreferences';

function ask(message: string): boolean {
  if (typeof window === 'undefined') return true;
  return window.confirm(`${message}\n\nSave anyway?`);
}

export function confirmTransactionDate(dateIso: string, prefs: PreferencesState): boolean {
  const warning = transactionDateWarning(dateIso, prefs.company, prefs.today);
  return warning ? ask(warning) : true;
}

export interface StockLine {
  itemId: string | null | undefined;
  quantity: string | number | null | undefined;
}
export interface StockItem {
  id: string;
  name: string;
  type: string;
  quantityOnHand: string | null;
}

/**
 * Sum quantities per inventory item and compare with what is on hand (plus whatever this same
 * document already took, when editing). Lists every short item in one prompt.
 */
export function stockShortfalls(
  lines: StockLine[],
  items: StockItem[],
  alreadyOnDocument: StockLine[] = [],
): Array<{ name: string; need: number; have: number }> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const need = new Map<string, number>();
  for (const l of lines) {
    const it = l.itemId ? byId.get(l.itemId) : undefined;
    if (!it || it.type !== 'inventory') continue;
    need.set(it.id, (need.get(it.id) ?? 0) + (Number(l.quantity) || 0));
  }
  const back = new Map<string, number>();
  for (const l of alreadyOnDocument) {
    if (l.itemId) back.set(l.itemId, (back.get(l.itemId) ?? 0) + (Number(l.quantity) || 0));
  }
  const out: Array<{ name: string; need: number; have: number }> = [];
  for (const [id, qty] of need) {
    const it = byId.get(id)!;
    const have = (Number(it.quantityOnHand) || 0) + (back.get(id) ?? 0);
    if (qty > have + 1e-9) out.push({ name: it.name, need: qty, have });
  }
  return out;
}

export function confirmStockAvailable(
  lines: StockLine[],
  items: StockItem[],
  prefs: PreferencesState,
  alreadyOnDocument: StockLine[] = [],
): boolean {
  if (!prefs.company.negativeStockWarning) return true;
  const short = stockShortfalls(lines, items, alreadyOnDocument);
  if (short.length === 0) return true;
  return ask(
    `Not enough inventory:\n${short.map((s) => `• ${s.name}: selling ${s.need}, only ${s.have} on hand`).join('\n')}\n\nSelling it anyway makes the quantity on hand negative.`,
  );
}

/** True when "warn when a transaction has no class" applies (class tracking on, warning on, no class). */
export function classWarningApplies(classId: string | null | undefined, prefs: PreferencesState): boolean {
  return Boolean(prefs.company.classTrackingEnabled && prefs.company.warnUnassignedClass && !classId);
}

export function confirmClassAssigned(classId: string | null | undefined, prefs: PreferencesState): boolean {
  if (!classWarningApplies(classId, prefs)) return true;
  return ask('This transaction has no class.');
}

/**
 * QB "Warn about duplicate check / bill / invoice / PO numbers": true when `number` is new among
 * `existing` (same scope, not the document being edited, not voided), or the user goes ahead.
 */
export function findDuplicateNumber<T extends { id: string }>(
  number: string | null | undefined,
  existing: T[],
  numberOf: (row: T) => string | null | undefined,
  opts: { excludeId?: string | null; sameScope?: (row: T) => boolean } = {},
): T | undefined {
  const n = (number ?? '').trim().toLowerCase();
  if (!n) return undefined;
  return existing.find(
    (row) =>
      row.id !== opts.excludeId &&
      (opts.sameScope ? opts.sameScope(row) : true) &&
      (numberOf(row) ?? '').trim().toLowerCase() === n,
  );
}

export function confirmUniqueNumber(
  enabled: boolean,
  label: string,
  duplicate: unknown,
  number: string,
): boolean {
  if (!enabled || !duplicate) return true;
  return ask(`${label} ${number.trim()} is already used.`);
}
