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
  billId: zUuid,
  amountApplied: zMoney,
  discountTaken: zMoney.nullish(),
});

/** I11: a General Journal A/P amount owed paid by this bill payment. */
export const journalItemBillPaymentSchema = z.object({
  journalLineId: zUuid,
  amount: zMoneyPositive,
});

/** I11: a General Journal A/P debit (vendor credit) applied to a bill in Pay Bills. */
export const journalCreditToBillSchema = z.object({
  journalLineId: zUuid,
  billId: zUuid,
  amount: zMoneyPositive,
});

export const payBillsSchema = z.object({
  vendorId: zUuid,
  date: zDate,
  method: paymentMethodSchema,
  reference: z.string().nullish(),
  paymentAccountId: zUuid,
  /** Required by the service when any application takes a discount. */
  discountAccountId: zUuid.nullish(),
  /** May be empty when the payment only pays General Journal amounts (checked in the service). */
  applications: z.array(billApplicationSchema, {
    required_error: 'applications must be an array (may be empty)',
    invalid_type_error: 'applications must be an array',
  }),
  journalItems: z.array(journalItemBillPaymentSchema).nullish(),
  journalCredits: z.array(journalCreditToBillSchema).nullish(),
  /** Check payments: queue for Print Checks (number assigned when printed). */
  toPrint: z.boolean().optional(),
  /** Foreign-currency bills: home units per 1 unit at payment (defaults to the list rate). */
  exchangeRate: zDecimal.nullish(),
  /** The user saw the duplicate check-number warning and chose to keep the number. */
  allowDuplicateNumber: z.boolean().optional(),
}).refine((b) => b.applications.length > 0 || (b.journalItems ?? []).length > 0, {
  message: 'At least one line is required.',
  path: ['applications'],
});
export type PayBillsBody = z.infer<typeof payBillsSchema>;
