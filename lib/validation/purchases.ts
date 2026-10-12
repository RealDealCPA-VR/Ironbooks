/**
 * Zod schemas for the wave2 purchases routes: Loan Manager, unified Print Checks queue, check
 * printer setup, bank/card account currency.
 */
import { z } from 'zod';
import { zDate, zDecimal, zDecimalPositive, zMoney, zUuid } from './helpers';

export const loanSchema = z.object({
  name: z.string().trim().min(1, 'Give the loan a name.').max(255),
  lenderVendorId: zUuid.nullish(),
  liabilityAccountId: zUuid,
  interestAccountId: zUuid,
  escrowAccountId: zUuid.nullish(),
  paymentAccountId: zUuid.nullish(),
  originalAmount: zMoney,
  annualRate: zDecimal,
  termMonths: z.coerce.number().int().min(1).max(600),
  paymentsPerYear: z.coerce.number().int().optional(),
  originDate: zDate,
  firstPaymentDate: zDate,
  escrowAmount: zMoney.nullish(),
  notes: z.string().nullish(),
  // p1 fx: loan currency (default: the lender's) and the rate it was booked at
  currency: z.string().max(3).nullish(),
  exchangeRate: zDecimalPositive.nullish(),
});

export const loanPaymentSchema = z.object({
  kind: z.enum(['check', 'bill']),
  date: zDate.nullish(),
  paymentAccountId: zUuid.nullish(),
  principal: zMoney.nullish(),
  interest: zMoney.nullish(),
  escrow: zMoney.nullish(),
  reference: z.string().max(100).nullish(),
  toPrint: z.boolean().optional(),
  memo: z.string().nullish(),
  dueDate: zDate.nullish(),
  exchangeRate: zDecimalPositive.nullish(),
});

export const printSourceSchema = z.enum(['expense', 'bill_payment', 'paycheck']);

export const markPrintedSchema = z.object({
  source: printSourceSchema,
  id: zUuid,
  checkNumber: z.string().max(100).nullish(),
  allowDuplicateNumber: z.boolean().optional(),
});

export const queuePaychecksSchema = z.object({
  paycheckIds: z.array(zUuid).min(1, 'Pick at least one paycheck.'),
});

export const checkPrintSettingsSchema = z.object({
  style: z.enum(['voucher', 'standard', 'wallet']),
  offsetX: zDecimal,
  offsetY: zDecimal,
});

export const accountCurrencySchema = z.object({
  accountId: zUuid,
  currency: z.string().max(3).nullish(),
});

export const updateTransferBodySchema = z.object({
  date: zDate,
  fromAccountId: zUuid,
  toAccountId: zUuid,
  amount: zMoney,
  memo: z.string().nullish(),
});
