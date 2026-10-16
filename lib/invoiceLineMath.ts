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
