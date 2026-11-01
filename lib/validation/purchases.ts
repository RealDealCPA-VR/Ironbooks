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
  // purchbank F1: balloon, compounding, the lender's payment amount, a loan already in progress
  balloonAmount: zMoney.nullish(),
  compounding: z.enum(['monthly', 'exact_days']).nullish(),
  dayCount: z.coerce.number().int().nullish(),
  paymentAmount: zMoney.nullish(),
  nextPaymentNumber: z.coerce.number().int().min(1).nullish(),
  nextPaymentDate: zDate.nullish(),
});

/** POST /api/loans/:id/what-if — QB Loan Manager "What If Scenarios" (nothing is saved). */
export const loanWhatIfSchema = z.object({
  annualRate: zDecimal.nullish(),
  paymentAmount: zMoney.nullish(),
  termMonths: z.coerce.number().int().min(1).max(600).nullish(),
  lumpSum: zMoney.nullish(),
  extraPrincipal: zMoney.nullish(),
  balloonAmount: zMoney.nullish(),
});

/** POST /api/loans/what-if — evaluate a new loan's payment, interest and payoff. */
export const loanEvaluateSchema = z.object({
  originalAmount: zMoney,
  annualRate: zDecimal,
  termMonths: z.coerce.number().int().min(1).max(600),
  paymentsPerYear: z.coerce.number().int().optional(),
  originDate: zDate,
  firstPaymentDate: zDate,
  balloonAmount: zMoney.nullish(),
  compounding: z.enum(['monthly', 'exact_days']).nullish(),
  dayCount: z.coerce.number().int().nullish(),
  paymentAmount: zMoney.nullish(),
  escrowAmount: zMoney.nullish(),
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

export const printSourceSchema = z.enum(['expense', 'bill_payment', 'paycheck', 'payment_check']);

export const markPrintedSchema = z.object({
  source: printSourceSchema,
  id: zUuid,
  checkNumber: z.string().max(100).nullish(),
  allowDuplicateNumber: z.boolean().optional(),
});

/** purchbank D3: one check of a print run and the number on the check paper it prints on. */
const printRunItemSchema = z.object({
  source: printSourceSchema,
  id: zUuid,
  checkNumber: z.string().trim().min(1, 'Each check needs the number printed on its check paper.').max(100),
});

/** POST /api/print-queue/run — check a print run before printing (nothing is recorded). */
export const printRunSchema = z.object({
  items: z.array(printRunItemSchema).min(1, 'Pick at least one check to print.').max(300, 'Print at most 300 checks at a time.'),
  allowDuplicateNumber: z.boolean().optional(),
});

/** POST /api/print-queue/confirm — "Did check(s) print OK?": `reprint` marks the ones that printed wrong. */
export const confirmPrintRunSchema = z.object({
  items: z
    .array(printRunItemSchema.extend({ reprint: z.boolean().optional() }))
    .min(1, 'Pick at least one check to print.')
    .max(300, 'Print at most 300 checks at a time.'),
  allowDuplicateNumber: z.boolean().optional(),
});

/** POST /api/print-queue/reprint — put a printed check back in the queue to print it again. */
export const reprintCheckSchema = z.object({
  source: printSourceSchema,
  id: zUuid,
});

export const queuePaychecksSchema = z.object({
  paycheckIds: z.array(zUuid).min(1, 'Pick at least one paycheck.'),
});

export const checkPrintSettingsSchema = z.object({
  style: z.enum(['voucher', 'standard', 'wallet']),
  stock: z.enum(['preprinted', 'blank']).nullish(),
  offsetX: zDecimal,
  offsetY: zDecimal,
  /** drizzle/0047 — check stock layout (validated in saveCheckPrintSettings). */
  position: z.enum(['top', 'middle', 'bottom']).nullish(),
  pageSize: z.enum(['letter', 'legal']).nullish(),
  checkHeight: zDecimal.nullish(),
  firstSheetRemaining: z.union([z.number(), z.string()]).nullish(),
  /** Field-position overrides; null resets to the standard positions. */
  layout: z.unknown().optional(),
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
