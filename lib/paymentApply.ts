/**
 * Preferences > Payments helpers for Receive Payments (pure, Decimal money):
 *  - autoApplyPayment: "Automatically apply payments" — spread the amount received over the
 *    customer's open invoices, oldest first (QB applies to an exact-amount match first).
 *  - sumApplied: "Automatically calculate payments" — the payment amount is the total applied.
 */
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
