/**
 * Zod schemas for /api/bill-payments — mirrors PayBillsInput / BillApplication
 * (lib/services/billPayments.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zMoney, zMoneyPositive, zUuid } from './helpers';

export const paymentMethodSchema = z.enum([
  'cash',
  'check',
  'credit_card',
  'ach',
  'bank_transfer',
  'other',
]);

export const billApplicationSchema = z.object({
  billId: zUuid.describe("Id of one of the vendor's open bills that this payment pays."),
  amountApplied: zMoney.describe('Cash paid toward the bill, as decimal text such as "125.00".'),
  discountTaken: zMoney
    .nullish()
    .describe('Early-payment discount taken on the bill, as decimal text such as "2.50"; it needs a discountAccountId.'),
});

/** I11: a General Journal A/P amount owed paid by this bill payment. */
export const journalItemBillPaymentSchema = z.object({
  journalLineId: zUuid.describe('Id of a General Journal line that records an amount owed to this vendor.'),
  amount: zMoneyPositive.describe('Amount of this payment applied to it, as decimal text above zero such as "50.00".'),
});

/** I11: a General Journal A/P debit (vendor credit) applied to a bill in Pay Bills. */
export const journalCreditToBillSchema = z.object({
  journalLineId: zUuid.describe('Id of a General Journal line that records a credit from this vendor.'),
  billId: zUuid.describe('Id of the bill the credit is applied to.'),
  amount: zMoneyPositive.describe('Credit applied, as decimal text above zero such as "50.00".'),
});

/** P1: a General Journal A/P debit (vendor credit) applied to a General Journal A/P amount owed. */
export const journalOffsetBillSchema = z.object({
  journalLineId: zUuid.describe('Id of a General Journal line that records a credit from this vendor.'),
  chargeLineId: zUuid.describe('Id of a General Journal line that records an amount owed to this vendor.'),
  amount: zMoneyPositive.describe('Amount of the credit applied to the amount owed, as decimal text above zero such as "50.00".'),
});

/** P1: a vendor credit document applied to a bill in the same Pay Bills save. */
export const vendorCreditUseSchema = z.object({
  vendorCreditId: zUuid.describe("Id of one of the vendor's credits with credit left."),
  billId: zUuid.describe('Id of the bill the credit is applied to.'),
  amount: zMoneyPositive.describe('Credit applied, as decimal text above zero such as "50.00".'),
});

export const payBillsSchema = z.object({
  vendorId: zUuid.describe('Id of the vendor being paid (vendor list).'),
  date: zDate.describe('Payment date, YYYY-MM-DD.'),
  method: paymentMethodSchema.describe('How the vendor is paid.'),
  reference: z
    .string()
    .max(100, 'can be at most 100 characters')
    .nullish()
    .describe('Check number or other payment reference; for a check from a bank account, leave out to use the next check number.'),
  /** Required when money is paid; a Pay Bills save that only applies credits may leave it out. */
  paymentAccountId: zUuid
    .nullish()
    .describe('Id of the bank or credit card account the money comes from (chart of accounts); leave out only when the save just applies credits.'),
  /** Required by the service when any application takes a discount. */
  discountAccountId: zUuid
    .nullish()
    .describe('Id of the account discounts taken post to (chart of accounts); required when any bill takes a discount.'),
  /** May be empty when the payment only pays General Journal amounts (checked in the service). */
  applications: z
    .array(billApplicationSchema, {
      required_error: 'applications must be an array (may be empty)',
      invalid_type_error: 'applications must be an array',
    })
    .describe('The bills this payment pays; may be empty when the save only pays General Journal amounts or applies credits.'),
  journalItems: z
    .array(journalItemBillPaymentSchema)
    .nullish()
    .describe('General Journal amounts owed to this vendor that this payment pays (home currency only).'),
  journalCredits: z
    .array(journalCreditToBillSchema)
    .nullish()
    .describe('General Journal credits from this vendor applied to bills in this save.'),
  journalOffsets: z
    .array(journalOffsetBillSchema)
    .nullish()
    .describe('General Journal credits from this vendor applied to General Journal amounts owed to this vendor.'),
  vendorCredits: z
    .array(vendorCreditUseSchema)
    .nullish()
    .describe('Vendor credits applied to bills in the same save as the payment.'),
  /** Check payments: queue for Print Checks (number assigned when printed). */
  toPrint: z
    .boolean()
    .optional()
    .describe('Checks only: true puts the check in the print queue, and its number is given when it is printed.'),
  /** Foreign-currency bills: home units per 1 unit at payment (defaults to the list rate). */
  exchangeRate: zDecimal
    .nullish()
    .describe('Foreign-currency bills only: home-currency units per 1 unit of the bill currency, as decimal text such as "1.10".'),
  /** The user saw the duplicate check-number warning and chose to keep the number. */
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that this check number is already used on the account, to keep it.'),
  /** Edits: the user confirmed QB's "this transaction has been reconciled" warning (reconciledEdits.ts). */
  allowReconciledEdit: z
    .boolean()
    .optional()
    .describe('Edits only: send true only after the app warned that this payment is reconciled with a bank statement, to save the change anyway.'),
}).refine(
  (b) =>
    b.applications.length > 0 ||
    (b.journalItems ?? []).length > 0 ||
    (b.vendorCredits ?? []).length > 0 ||
    (b.journalCredits ?? []).length > 0 ||
    (b.journalOffsets ?? []).length > 0,
  {
    message: 'At least one line is required.',
    path: ['applications'],
  },
);
export type PayBillsBody = z.infer<typeof payBillsSchema>;

/**
 * POST /api/bill-payments/journal-items — General Journal A/P items of a vendor in Pay Bills
 * (QB invariant I11): apply a General Journal vendor credit, or take one application off again.
 */
export const billPaymentJournalItemsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z
      .literal('apply_credit')
      .describe('apply_credit: apply a General Journal credit from this vendor to a bill or to a General Journal amount owed.'),
    journalLineId: zUuid.describe('Id of the General Journal line that holds the vendor credit (from GET /api/bill-payments/journal-items, credits).'),
    /** The bill to apply the credit to — or `chargeLineId`, a General Journal amount owed (P1). */
    billId: zUuid.nullish().describe("Id of the vendor's open bill the credit pays; send exactly one of billId and chargeLineId."),
    chargeLineId: zUuid
      .nullish()
      .describe(
        'Id of the General Journal line of an amount owed to this vendor (from GET /api/bill-payments/journal-items, charges); send exactly one of billId and chargeLineId.',
      ),
    amount: zMoneyPositive.describe('Amount of the credit to apply, as decimal text such as "125.00".'),
    date: zDate
      .nullish()
      .describe('Date of the application, YYYY-MM-DD; leave out for today. It is never earlier than the credit or the document it pays.'),
  }),
  z.object({
    action: z.literal('unapply').describe('unapply: take one earlier credit application off again.'),
    applicationId: zUuid.describe('Id of the application to remove (from the application list of the credit or bill).'),
  }),
]);
