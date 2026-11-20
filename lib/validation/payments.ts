/**
 * Zod schemas for /api/payments — mirrors ReceivePaymentInput.
 */
import { z } from 'zod';
import { zDate, zDecimalPositive, zMoney, zMoneyPositive, zUuid } from './helpers';

const zMoneyNonNegative = zMoney
  .refine((v) => Number(v) >= 0, { message: 'cannot be negative' })
  .describe('Amount of zero or more as decimal text with at most 2 decimal places, such as "125.00".');

export const paymentApplicationSchema = z
  .object({
    invoiceId: zUuid.describe("Id of one of the customer's open invoices that this payment pays."),
    /** Cash applied; may be 0 when only an early-payment discount is taken (wave2 sales C3). */
    amountApplied: zMoneyNonNegative.describe(
      'Cash from this payment applied to the invoice, as decimal text such as "125.00"; may be "0" when only a discount is taken.',
    ),
    discountAmount: zMoneyNonNegative
      .nullish()
      .describe('Early-payment discount given on the invoice, as decimal text such as "5.00".'),
  })
  .refine((a) => Number(a.amountApplied) > 0 || Number(a.discountAmount ?? 0) > 0, {
    message: 'amountApplied must be greater than zero',
    path: ['amountApplied'],
  });

/** wave2 sales (C4): credit memo applied to an invoice inside Receive Payments. */
export const paymentCreditSchema = z.object({
  creditMemoId: zUuid.describe("Id of one of the customer's credit memos with credit left."),
  invoiceId: zUuid.describe('Id of the invoice the credit is applied to.'),
  amount: zMoneyPositive.describe('Credit applied, as decimal text above zero such as "50.00".'),
});

/** wave2 sales (C4): an earlier unapplied payment used on an invoice inside Receive Payments. */
export const paymentCreditFromPaymentSchema = z
  .object({
    paymentId: zUuid.describe('Id of an earlier payment from this customer that still has an unapplied amount.'),
    /** The invoice it is applied to — or journalLineId, a General Journal charge (P1). */
    invoiceId: zUuid.nullish().describe('Id of the invoice it is applied to; give this or journalLineId, not both.'),
    journalLineId: zUuid
      .nullish()
      .describe('Id of the General Journal charge line it is applied to; give this or invoiceId, not both.'),
    amount: zMoneyPositive.describe('Amount applied, as decimal text above zero such as "50.00".'),
  })
  .refine((c) => Boolean(c.invoiceId) !== Boolean(c.journalLineId), {
    message: 'Pick the invoice or the General Journal charge to apply the earlier payment to.',
    path: ['invoiceId'],
  });

/** P1: a General Journal A/R credit applied to a General Journal A/R charge of the same customer. */
export const journalOffsetSchema = z.object({
  journalLineId: zUuid.describe("Id of a General Journal line that credits this customer's receivable."),
  chargeLineId: zUuid.describe("Id of a General Journal line that charges this customer's receivable."),
  amount: zMoneyPositive.describe('Amount of the credit applied to the charge, as decimal text above zero such as "50.00".'),
});

/** I11: a General Journal A/R charge paid by this payment. */
export const journalItemPaymentSchema = z.object({
  journalLineId: zUuid.describe("Id of a General Journal line that charges this customer's receivable."),
  amount: zMoneyPositive.describe('Amount of this payment applied to it, as decimal text above zero such as "50.00".'),
});

/** I11: a General Journal A/R credit applied to an invoice inside Receive Payments. */
export const journalCreditToInvoiceSchema = z.object({
  journalLineId: zUuid.describe("Id of a General Journal line that credits this customer's receivable."),
  invoiceId: zUuid.describe('Id of the invoice the credit is applied to.'),
  amount: zMoneyPositive.describe('Credit applied, as decimal text above zero such as "50.00".'),
});

export const receivePaymentSchema = z.object({
  customerId: zUuid.describe('Id of the customer who paid (customer list).'),
  date: zDate.describe('Date the payment was received, YYYY-MM-DD.'),
  method: z
    .enum(['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'], {
      errorMap: () => ({
        message: 'method must be cash, check, credit_card, ach, bank_transfer, or other',
      }),
    })
    .describe('How the customer paid.'),
  /** salesar (B7): Payment Method list entry ("Visa"); its type is stored as the method. */
  paymentMethodId: zUuid
    .nullish()
    .describe('Id of a Payment Method list entry such as "Visa"; its type is saved as the method.'),
  reference: z.string().nullish().describe("The customer's check number or another payment reference."),
  /** May be 0 when the payment only applies credits/discounts (checked in the service). */
  amount: zMoneyNonNegative.describe(
    'Total received as decimal text such as "125.00"; may be "0" when the payment only applies credits or discounts.',
  ),
  depositAccountId: zUuid
    .nullish()
    .describe('Id of the bank account the money goes to (chart of accounts); leave out to hold it in Undeposited Funds.'),
  /** May be empty — the un-applied remainder is recorded as a customer credit. */
  applications: z
    .array(paymentApplicationSchema, {
      required_error: 'applications must be an array (may be empty)',
      invalid_type_error: 'applications must be an array',
    })
    .describe('The invoices this payment pays; may be empty, and any amount not applied stays as a credit for the customer.'),
  credits: z
    .array(paymentCreditSchema)
    .nullish()
    .describe('Credit memos of this customer applied to invoices together with this payment.'),
  paymentCredits: z
    .array(paymentCreditFromPaymentSchema)
    .nullish()
    .describe('Unapplied amounts of earlier payments from this customer, applied to invoices or General Journal charges.'),
  journalItems: z
    .array(journalItemPaymentSchema)
    .nullish()
    .describe('General Journal charges to this customer that this payment pays (home currency only).'),
  journalCredits: z
    .array(journalCreditToInvoiceSchema)
    .nullish()
    .describe('General Journal credits of this customer applied to invoices together with this payment.'),
  journalOffsets: z
    .array(journalOffsetSchema)
    .nullish()
    .describe('General Journal credits of this customer applied to General Journal charges of this customer.'),
  discountAccountId: zUuid
    .nullish()
    .describe('Id of the account early-payment discounts post to (chart of accounts); leave out for Sales Discounts.'),
  memo: z.string().nullish().describe('Internal note saved with the payment.'),
  currency: z
    .string()
    .trim()
    .length(3, 'currency must be a 3-letter ISO 4217 code')
    .nullish()
    .describe("3-letter currency code of the payment such as \"EUR\"; leave out for the company's home currency."),
  /** FX rates carry more than 2 decimal places. */
  exchangeRate: zDecimalPositive
    .nullish()
    // resolvePaymentCurrency / updatePayment (lib/services/payments.ts): typed rate, else the
    // currency list's rate on a new payment, else the saved rate on an edit in the same currency.
    .describe(
      'Home-currency units per 1 unit of the payment currency, as decimal text such as "1.10"; leave out for the currency list\'s rate (the home currency is always 1), and on an edit that keeps the currency leave out to keep the saved rate.',
    ),
  /**
   * Edit only (C1): the payment is in a bank deposit and its amount changes — take it out of the
   * deposit (the rest of the deposit stays) and save the edit, in one step.
   */
  removeFromDeposit: z
    .boolean()
    .optional()
    .describe('Edits only: send true only after the app warned that this payment is in a bank deposit, to take it out of that deposit and save the change.'),
  /** Edit only: QB's "this transaction has been reconciled" warning confirmed. */
  allowReconciledEdit: z
    .boolean()
    .optional()
    .describe('Edits only: send true only after the app warned that this payment is reconciled with a bank statement, to save the change anyway.'),
});
export type ReceivePaymentBody = z.infer<typeof receivePaymentSchema>;

/** POST /api/payments/:id { action: 'bounce' } — Record Bounced Check (wave2 sales F2). */
export const bouncedCheckSchema = z.object({
  date: zDate.nullish().describe('Date the check bounced, YYYY-MM-DD; leave out for today.'),
  bankFee: zMoneyNonNegative.nullish().describe('Fee the bank charged you for the bounced check, as decimal text such as "25.00".'),
  bankFeeAccountId: zUuid.nullish().describe('Id of the expense account the bank fee posts to (chart of accounts).'),
  customerFee: zMoneyNonNegative
    .nullish()
    .describe('Fee billed to the customer on a new invoice for the bounced check, as decimal text such as "35.00".'),
  customerFeeAccountId: zUuid.nullish().describe('Id of the income account the customer fee posts to (chart of accounts).'),
  memo: z.string().nullish().describe('Note saved with the bounced check record.'),
});
