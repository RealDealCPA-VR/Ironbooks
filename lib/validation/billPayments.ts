/**
 * Zod schemas for /api/bill-payments — mirrors PayBillsInput / BillApplication
 * (lib/services/billPayments.ts).
 */
import { z } from 'zod';
import { zDate, zDecimal, zLines, zMoney, zUuid } from './helpers';

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

export const payBillsSchema = z.object({
  vendorId: zUuid,
  date: zDate,
  method: paymentMethodSchema,
  reference: z.string().nullish(),
  paymentAccountId: zUuid,
  /** Required by the service when any application takes a discount. */
  discountAccountId: zUuid.nullish(),
  applications: zLines(billApplicationSchema),
  /** Check payments: queue for Print Checks (number assigned when printed). */
  toPrint: z.boolean().optional(),
  /** Foreign-currency bills: home units per 1 unit at payment (defaults to the list rate). */
  exchangeRate: zDecimal.nullish(),
  /** The user saw the duplicate check-number warning and chose to keep the number. */
  allowDuplicateNumber: z.boolean().optional(),
});
export type PayBillsBody = z.infer<typeof payBillsSchema>;
