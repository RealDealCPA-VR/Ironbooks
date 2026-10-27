/**
 * Preferences > Payments helpers for Receive Payments (pure, Decimal money):
 *  - autoApplyPayment: "Automatically apply payments" — spread the amount received over the
 *    customer's open invoices, oldest first (QB applies to an exact-amount match first).
 *  - sumApplied: "Automatically calculate payments" — the payment amount is the total applied.
 */
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';

export interface OpenDoc {
  id: string;
  date: string;
  dueDate?: string | null;
  balanceDue: string;
}

/** invoiceId -> amount ('0.00' amounts omitted). Never applies more than each balance or the amount. */
export function autoApplyPayment(amount: string, docs: OpenDoc[]): Record<string, string> {
  let left = Money.of(0);
  try {
    left = Money.of(amount || '0');
  } catch {
    return {};
  }
  if (!left.isFinite() || left.lte(0)) return {};
  const open = docs.filter((d) => {
    try {
      return Money.of(d.balanceDue).gt(0);
    } catch {
      return false;
    }
  });
  // QB first looks for one invoice whose balance equals the payment exactly.
  const exact = open.find((d) => Money.of(d.balanceDue).eq(left));
  if (exact) return { [exact.id]: toAmountString(left) };
  const ordered = [...open].sort((a, b) => {
    const ka = (a.dueDate || a.date || '').slice(0, 10);
    const kb = (b.dueDate || b.date || '').slice(0, 10);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const out: Record<string, string> = {};
  for (const d of ordered) {
    if (left.lte(0)) break;
    const bal = Money.of(d.balanceDue);
    const take = bal.lt(left) ? bal : left;
    out[d.id] = toAmountString(take);
    left = left.minus(take);
  }
  return out;
}

/** Total of the applied amounts (blank / invalid entries count as zero). */
export function sumApplied(applied: Record<string, string>): string {
  let total = Money.of(0);
  for (const v of Object.values(applied)) {
    try {
      const d = Money.of(v || '0');
      if (d.isFinite() && d.gt(0)) total = total.plus(d);
    } catch {
      /* ignore partial input */
    }
  }
  return toAmountString(total);
}

/**
 * What cash still has to cover on each open document once discounts and credits already entered
 * are taken off (QB lowers the payment due by the discount). Feed this to autoApplyPayment so an
 * auto-applied payment never adds up, with the discount and credits, to more than the balance.
 * Documents with nothing left for cash are dropped; blank / invalid deductions count as zero.
 */
export function cashDue<T extends OpenDoc>(docs: T[], deductions: Record<string, string | number | undefined>): T[] {
  const out: T[] = [];
  for (const d of docs) {
    let bal = Money.of(0);
    let less = Money.of(0);
    try {
      bal = Money.of(d.balanceDue);
    } catch {
      continue;
    }
    try {
      const v = deductions[d.id];
      const x = Money.of(v === undefined || v === '' ? 0 : v);
      if (x.isFinite() && x.gt(0)) less = x;
    } catch {
      /* partial input */
    }
    const left = bal.minus(less);
    if (left.gt(0)) out.push({ ...d, balanceDue: toAmountString(left) });
  }
  return out;
}

/** Decimal of an entered amount; blank or not-a-number counts as 0 (field validation reports those). */
export function moneyDec(v: string | number | null | undefined): Decimal {
  try {
    const d = Money.of(v || 0);
    return d.isFinite() ? d : Money.of(0);
  } catch {
    return Money.of(0);
  }
}

/** Decimal sum of entered amounts (blank / invalid count as 0). */
export function sumMoney(values: ReadonlyArray<string | number | null | undefined>): Decimal {
  return values.reduce<Decimal>((s, v) => s.plus(moneyDec(v)), Money.of(0));
}

/**
 * Receive Payments: cash applied to invoices plus cash applied to General Journal charges — the
 * same Decimal total the server compares with the amount received.
 */
export function cashApplied(body: {
  applications: ReadonlyArray<{ amountApplied: string | number | null | undefined }>;
  journalItems: ReadonlyArray<{ amount: string | number | null | undefined }>;
}): Decimal {
  return sumMoney([...body.applications.map((a) => a.amountApplied), ...body.journalItems.map((j) => j.amount)]);
}

/** True when the cash applied is more than the amount received (exact Decimal, no float tolerance). */
export function appliedExceedsReceived(
  body: Parameters<typeof cashApplied>[0],
  amountReceived: string | number | null | undefined,
): boolean {
  return cashApplied(body).greaterThan(moneyDec(amountReceived));
}

/**
 * Pay Bills rows after the open bills are read again. A different vendor, or a payment just
 * saved, starts fresh (`keep` false). Re-reading the SAME vendor's bills because the payment date
 * or a filter changed keeps what was ticked and typed for every bill still listed — that reload
 * used to clear every selection, so changing the date (or pressing + in it) lost the whole batch.
 */
export function carryRows<R>(prev: Record<string, R>, ids: readonly string[], empty: () => R, keep: boolean): Record<string, R> {
  return Object.fromEntries(ids.map((id) => [id, keep && prev[id] !== undefined ? prev[id] : empty()]));
}

/** The typed amounts of a keyed set (General Journal lines) still listed; others are dropped. */
export function carryAmounts(prev: Record<string, string>, ids: readonly string[], keep: boolean): Record<string, string> {
  if (!keep) return {};
  const out: Record<string, string> = {};
  for (const id of ids) if (prev[id] !== undefined) out[id] = prev[id];
  return out;
}

/**
 * Whether Pay Bills has anything to save: a ticked bill, a General Journal amount being paid, or
 * a General Journal vendor credit applied to a General Journal amount owed (no cash at all — the
 * save accepts it, but the button used to stay disabled for it).
 */
export function payBillsHasWork(w: { billsSelected: number; journalPaid: number; journalCreditOnJournal: string | number }): boolean {
  return w.billsSelected > 0 || w.journalPaid > 0 || moneyDec(w.journalCreditOnJournal).greaterThan(0);
}
