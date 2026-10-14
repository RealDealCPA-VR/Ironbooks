/**
 * Payment-terms math for A/P (QB "Terms" on bills): due date and early-payment discount.
 *
 * Legacy fallback: documents resolve their terms on the Terms list first
 * (lists/terms.ts `dueDateFromTermsList` / `findTermsRef`, standard and date-driven); this parser
 * only handles free text that is not on the list.
 *
 * Accepted shapes (case-insensitive, separators '_', ' ', '/', '%'):
 *   due_on_receipt                  -> due the bill date, no discount
 *   net_15 | net 30 | n60           -> due N days after the bill date
 *   2_10_net_30 | 2% 10 net 30 | 2/10 n/30
 *                                   -> 2% discount if paid within 10 days, due in 30
 */
import { Money, toAmountString } from '@/lib/money';

export interface ParsedTerms {
  /** Days after the bill date the bill is due. */
  netDays: number;
  /** Early-payment discount percent (e.g. 2 for 2%); 0 when none. */
  discountPercent: number;
  /** Days after the bill date the discount stays available; 0 when none. */
  discountDays: number;
}

/** Parse a terms string; null when it is not recognised. */
export function parseTerms(terms: string | null | undefined): ParsedTerms | null {
  if (!terms) return null;
  const t = terms.trim().toLowerCase();
  if (!t) return null;
  if (/^(due[\s_-]*on[\s_-]*receipt|cod|on[\s_-]*receipt)$/.test(t)) {
    return { netDays: 0, discountPercent: 0, discountDays: 0 };
  }
  // "2_10_net_30", "2% 10 net 30", "2/10 n/30", "2/10 net 30"
  const disc = /^(\d+(?:\.\d+)?)\s*%?[\s_/-]*(\d+)[\s_/,-]*(?:net|n)[\s_/-]*(\d+)$/.exec(t);
  if (disc) {
    return {
      discountPercent: Number(disc[1]),
      discountDays: Number(disc[2]),
      netDays: Number(disc[3]),
    };
  }
  const net = /^(?:net|n)[\s_/-]*(\d+)$/.exec(t);
  if (net) return { netDays: Number(net[1]), discountPercent: 0, discountDays: 0 };
  return null;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Due date implied by terms (null when the terms are unknown). */
export function dueDateFromTerms(billDate: Date, terms: string | null | undefined): Date | null {
  const p = parseTerms(terms);
  return p ? addDays(billDate, p.netDays) : null;
}

export interface DiscountInfo {
  /** Last day the discount can be taken (null when the terms carry no discount). */
  discountDate: Date | null;
  discountPercent: number;
  /** Suggested discount on the CURRENT open balance (2dp string; '0.00' when none). */
  suggestedDiscount: string;
  /** True when `asOf` is on/before the discount date. */
  available: boolean;
}

/**
 * Early-payment discount for a bill (QB Pay Bills "Discount" column). The suggestion is the
 * terms percent of the bill's open balance, rounded to the cent; it is only `available` while
 * the payment date is within the discount window.
 */
export function discountFor(
  bill: { date: Date; terms: string | null | undefined; balanceDue: string | number; total: string | number },
  asOf: Date,
): DiscountInfo {
  const p = parseTerms(bill.terms);
  if (!p || p.discountPercent <= 0) {
    return { discountDate: null, discountPercent: 0, suggestedDiscount: '0.00', available: false };
  }
  const discountDate = addDays(bill.date, p.discountDays);
  const available = asOf.toISOString().slice(0, 10) <= discountDate.toISOString().slice(0, 10);
  const suggested = Money.round2(Money.of(bill.balanceDue).times(p.discountPercent).dividedBy(100));
  return {
    discountDate,
    discountPercent: p.discountPercent,
    suggestedDiscount: available && suggested.greaterThan(0) ? toAmountString(suggested) : '0.00',
    available,
  };
}
