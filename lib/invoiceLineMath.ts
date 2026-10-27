/**
 * Live line amounts for the invoice form (app/invoices/page.tsx computeTotals), Decimal-safe and
 * rounded the way lib/services/invoices.ts rounds them: quantity and rate at 4 decimals, each
 * line amount = round2(qty × rate) (half-up), a %-discount line = round2(running body × % / 100)
 * — or, directly under a Subtotal item, round2(that subtotal × % / 100).
 *
 * The %-discount amount is SENT to the server as the line's flat rate, so it must be exact: the
 * float version (`-(running * pct / 100)).toFixed(2)`) saved 15% of 10.10 as -1.51, not -1.52.
 */
import Decimal from 'decimal.js';
import { Money } from '@/lib/money';

export type InvoiceLineKind = 'income' | 'discount' | 'subtotal' | 'payment' | 'sales_tax';

export interface LiveLineInput {
  kind: InvoiceLineKind;
  quantity: string;
  rate: string;
  taxable: boolean;
  /** Discount line given as a percent of the preceding body lines. */
  discountPercent?: boolean;
}

export interface LiveLineTotals {
  /** Per-line amount (subtotal lines carry the running body sum), 2dp. */
  amounts: Decimal[];
  /** Income + discount lines. */
  subtotal: Decimal;
  taxableSubtotal: Decimal;
  payments: Decimal;
  manualTax: Decimal;
}

/** A typed number while the user is still editing: blank / not-a-number counts as 0. */
export function typedNumber(raw: string | null | undefined): Decimal {
  const s = (raw ?? '').trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return new Decimal(0);
  try {
    return new Decimal(s);
  } catch {
    // Partial input such as "12abc": what parseFloat reads.
    return new Decimal(n);
  }
}

export function liveLineTotals(lines: LiveLineInput[]): LiveLineTotals {
  let subtotal = Money.zero();
  let taxableSubtotal = Money.zero();
  let payments = Money.zero();
  let manualTax = Money.zero();
  let running = Money.zero();
  // QB: a discount placed directly under a Subtotal item discounts that subtotal. The subtotal
  // resets the running group, so remember its amount for an immediately following %-discount.
  let subtotalAbove: Decimal | null = null;
  const amounts: Decimal[] = [];

  for (const l of lines) {
    if (l.kind === 'subtotal') {
      amounts.push(running);
      subtotalAbove = running;
      running = Money.zero();
      continue;
    }
    const pctBase = subtotalAbove ?? running;
    subtotalAbove = null;
    const qty = typedNumber(l.quantity).toDecimalPlaces(4);
    const rate = typedNumber(l.rate).toDecimalPlaces(4);
    let amt: Decimal;
    if (l.kind === 'discount') {
      amt = l.discountPercent
        ? Money.round2(pctBase.times(rate.abs()).dividedBy(100)).negated()
        : Money.round2((qty.isZero() ? new Decimal(1) : qty).times(rate)).abs().negated();
    } else {
      amt = Money.round2(qty.times(rate));
    }
    amounts.push(amt);

    if (l.kind === 'income' || l.kind === 'discount') {
      subtotal = subtotal.plus(amt);
      running = running.plus(amt);
      if (l.taxable) taxableSubtotal = taxableSubtotal.plus(amt);
    } else if (l.kind === 'payment') {
      payments = payments.plus(amt);
    } else if (l.kind === 'sales_tax') {
      manualTax = manualTax.plus(amt);
    }
  }
  return { amounts, subtotal, taxableSubtotal, payments, manualTax };
}

/**
 * A billable cost as the invoice bills it: the cost at cost, round2(amount), plus its own markup
 * line round2(cost × markup% / 100) when that is more than zero (lib/services/billables.ts).
 */
export function billableCostTotal(amount: string, markupPercent: string): Decimal {
  const base = Money.round2(typedNumber(amount));
  const markup = Money.round2(base.times(typedNumber(markupPercent)).dividedBy(100));
  return markup.greaterThan(0) ? base.plus(markup) : base;
}

/** Unbilled billable time & costs picked on a new invoice (GET /api/billables). */
export interface LiveBillables {
  /** Bill / expense costs, passed through at cost plus the markup. */
  costs: Array<{ amount: string }>;
  /** Time entries, billed hours × rate. */
  time: Array<{ hours: string; rate: string }>;
  /** Markup % on the costs as typed ('' = none). */
  markupPercent: string;
}

export interface InvoiceFormTotalsInput {
  lines: LiveLineInput[];
  /** Header discount as typed: dollars, or a percent of the subtotal. */
  discount: string;
  discountType: 'amount' | 'percent';
  /** The tax item's rate as a fraction ("0.0825"); '' / 0 = no tax. */
  taxRate: string | number;
  billables?: LiveBillables | null;
  /** Retainage % held back as typed ('' = none). */
  retainagePercent?: string;
}

export interface InvoiceFormTotals extends LiveLineTotals {
  /** What the selected billables add to the subtotal (cost lines + markup lines + time). */
  billables: Decimal;
  /** The header discount in dollars. */
  discount: Decimal;
  tax: Decimal;
  total: Decimal;
  /** Held back as retainage (part of the total, not due yet). */
  retainage: Decimal;
  /** total − retainage: what is due now, before payment lines (the server's dueNow). */
  dueNow: Decimal;
  /** dueNow − payment lines. */
  balanceDue: Decimal;
}

/**
 * The invoice form's totals exactly as lib/services/invoices.ts prepareInvoice (and
 * lib/services/billables.ts for picked billables) will save them — every step rounded where the
 * server rounds it, in Decimal:
 *  - billables: each cost round2(amount) plus its own markup line round2(cost × markup%), each
 *    time entry round2(hours × rate) — all non-taxable income lines;
 *  - header discount: round2(the typed amount), or round2(subtotal × round2(percent) / 100);
 *  - tax: round2(taxable base × rate) (a negative base is not taxed) + manual sales-tax lines;
 *  - total: round2(subtotal − discount + tax); retainage round2(total × round2(percent) / 100);
 *  - due now: total − retainage; balance due: due now − payment lines.
 * The float version showed a 15% discount of $10.10 as $1.51 while the invoice saved $1.52.
 */
export function invoiceFormTotals(input: InvoiceFormTotalsInput): InvoiceFormTotals {
  const live = liveLineTotals(input.lines);
  let billables = Money.zero();
  const b = input.billables;
  if (b) {
    for (const c of b.costs) billables = billables.plus(billableCostTotal(c.amount, b.markupPercent));
    for (const t of b.time) {
      billables = billables.plus(Money.round2(typedNumber(t.hours).toDecimalPlaces(4).times(typedNumber(t.rate).toDecimalPlaces(4))));
    }
  }
  const subtotal = live.subtotal.plus(billables);
  const typedDiscount = Money.round2(typedNumber(input.discount));
  const discount =
    input.discountType === 'percent'
      ? Money.round2(subtotal.times(Decimal.min(typedDiscount, 100)).dividedBy(100))
      : typedDiscount;
  const rate = typedNumber(String(input.taxRate ?? ''));
  const base = live.taxableSubtotal.lessThan(0) ? Money.zero() : live.taxableSubtotal;
  let tax = Money.round2(base.times(rate)).plus(live.manualTax);
  if (tax.lessThan(0)) tax = Money.zero();
  let total = Money.round2(subtotal.minus(discount).plus(tax));
  if (total.lessThan(0)) total = Money.zero(); // the server refuses it; the form shows 0.00
  const retPct = Money.round2(typedNumber(input.retainagePercent ?? ''));
  const retainage = retPct.greaterThan(0)
    ? Money.round2(total.times(Decimal.min(retPct, 100)).dividedBy(100))
    : Money.zero();
  // lib/services/invoices.ts: dueNow = round2(total − retainage); the balance = dueNow − payments.
  const dueNow = Money.round2(total.minus(retainage));
  let balanceDue = dueNow.minus(live.payments);
  if (balanceDue.lessThan(0)) balanceDue = Money.zero();
  return { ...live, subtotal, billables, discount, tax, total, retainage, dueNow, balanceDue };
}
