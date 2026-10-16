/**
 * QB item-type semantics for the sales documents that are not invoices (sales receipts, credit
 * memos, estimates, sales orders). They follow the same rules as invoices.ts prepareInvoice:
 *  - 'income'    - a normal line (service / inventory / non-inventory / other charge / no item).
 *  - 'discount'  - always REDUCES the document: the amount is stored negative whatever sign was
 *                  entered; a taxable discount lowers the taxable base.
 *  - 'subtotal'  - non-posting: amount = the sum of the body lines since the previous subtotal;
 *                  excluded from every total.
 *  - 'sales_tax' - a manual tax line: adds to the tax amount (Sales Tax Payable), not the subtotal.
 * Payment items only make sense on an invoice (money received against what it bills), so these
 * documents refuse them.
 */
import type Decimal from 'decimal.js';
import { Money, toAmountString } from '@/lib/money';
import { validation } from './_base';

export type SalesLineKind = 'income' | 'discount' | 'subtotal' | 'sales_tax';

/** The line's kind from its item's type; refuses payment items. */
export function salesLineKind(
  itemType: string | null | undefined,
  lineNo: number,
  docLabel: string,
): SalesLineKind {
  if (itemType === 'discount' || itemType === 'subtotal' || itemType === 'sales_tax') return itemType;
  if (itemType === 'payment') {
    throw validation(
      `Line ${lineNo}: a payment item can only be used on an invoice, not on a ${docLabel}. Remove the line (record money received with Receive Payments).`,
    );
  }
  return 'income';
}

/** Running totals of a sales document's lines, computed the way an invoice computes them. */
export class SalesLineTotals {
  /** Income + discount lines (discounts negative). */
  subtotal: Decimal = Money.zero();
  /** Positive income lines only (the credit side of the posting). */
  grossIncome: Decimal = Money.zero();
  /** Taxable income + taxable discount lines without their own rate. */
  taxableSubtotal: Decimal = Money.zero();
  /** Manual sales-tax item lines. */
  salesTaxLines: Decimal = Money.zero();
  private runningBody: Decimal = Money.zero();

  /**
   * The amount to store for a body line (discounts made negative) and whether it is taxable.
   * Adds it to the totals. `perLineTax` receives a taxable income line that has its own rate.
   */
  addLine(
    kind: Exclude<SalesLineKind, 'subtotal'>,
    amount: Decimal,
    taxable: boolean,
    opts: { ownRate?: Decimal | null; perLineTax?: (tax: Decimal) => void } = {},
  ): { amount: Decimal; taxable: boolean } {
    if (kind === 'sales_tax') {
      this.salesTaxLines = this.salesTaxLines.plus(amount);
      return { amount, taxable: false };
    }
    const amt = kind === 'discount' ? Money.abs(amount).negated() : amount;
    this.subtotal = this.subtotal.plus(amt);
    this.runningBody = this.runningBody.plus(amt);
    if (kind === 'income') this.grossIncome = this.grossIncome.plus(amt);
    if (taxable) {
      if (kind === 'income' && opts.ownRate && opts.perLineTax) {
        opts.perLineTax(Money.round2(Money.mul(amt, opts.ownRate)));
      } else {
        this.taxableSubtotal = this.taxableSubtotal.plus(amt);
      }
    }
    return { amount: amt, taxable };
  }

  /** A subtotal line's amount (the body since the last subtotal); starts a new group. */
  takeSubtotal(): string {
    const s = toAmountString(this.runningBody);
    this.runningBody = Money.zero();
    return s;
  }

  /** Tax on the document-level rate (a negative taxable base is never taxed) + manual tax lines. */
  taxAmount(rate: Decimal, perLineTax: Decimal = Money.zero()): Decimal {
    const base = this.taxableSubtotal.lessThan(0) ? Money.zero() : this.taxableSubtotal;
    const tax = Money.round2(Money.mul(base, rate)).plus(perLineTax).plus(this.salesTaxLines);
    return tax.lessThan(0) ? Money.zero() : tax;
  }
}
