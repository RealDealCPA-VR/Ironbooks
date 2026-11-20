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

/** POST /api/loans/:id/payments — Loan Manager "Set up payment" (lib/services/loans.ts setUpLoanPayment). */
export const loanPaymentSchema = z.object({
  kind: z
    .enum(['check', 'bill'])
    .describe('How the loan payment is entered: check writes a check now, bill enters a bill to the lender to pay later.'),
  date: zDate
    .nullish()
    .describe("Date of the check or bill, YYYY-MM-DD; leave out for the payment's scheduled due date, or today when none is scheduled."),
  paymentAccountId: zUuid
    .nullish()
    .describe("Checks only: id of the bank account the payment comes from (chart of accounts); leave out for the loan's payment account."),
  principal: zMoney
    .nullish()
    .describe('Part of the payment that pays down the loan, as decimal text such as "850.00"; leave out for the scheduled amount.'),
  interest: zMoney
    .nullish()
    .describe('Part of the payment that is interest, as decimal text such as "150.00"; leave out for the scheduled amount.'),
  escrow: zMoney
    .nullish()
    .describe("Part of the payment that goes to escrow, as decimal text such as \"200.00\"; leave out for the scheduled amount or the loan's escrow amount."),
  reference: z
    .string()
    .max(100)
    .nullish()
    .describe('Check number of a check, or the lender\'s bill number of a bill (at most 100 characters).'),
  toPrint: z.boolean().optional().describe('Checks only: true puts the check in the Print Checks list to print later.'),
  memo: z.string().nullish().describe('Memo of the check or bill; leave out for the loan name and payment number.'),
  dueDate: zDate.nullish().describe('Bills only: date the bill is due, YYYY-MM-DD; leave out for the payment date.'),
  exchangeRate: zDecimalPositive
    .nullish()
    .describe('Foreign-currency loans only: home-currency units per 1 unit of the loan currency, as decimal text such as "1.10"; leave out for the currency list\'s rate.'),
});

// Shared by every Print Checks schema below, so the agent-facing text lives here once.
export const printSourceSchema = z
  .enum(['expense', 'bill_payment', 'paycheck', 'payment_check'])
  .describe(
    'Kind of check in the Print Checks list: expense (a written check), bill_payment (a bill payment by check), paycheck, or payment_check (a sales tax, payroll liability or customer refund check).',
  );

export const markPrintedSchema = z.object({
  source: printSourceSchema,
  id: zUuid.describe('Id of the check waiting to print, of the kind named by source.'),
  checkNumber: z
    .string()
    .max(100)
    .nullish()
    .describe("Number printed on the check paper; leave out for the bank account's next check number."),
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that this check number is already used on the bank account, to record it anyway.'),
});

/** purchbank D3: one check of a print run and the number on the check paper it prints on. */
const printRunItemSchema = z.object({
  source: printSourceSchema,
  id: zUuid.describe('Id of the check waiting to print, of the kind named by source.'),
  checkNumber: z
    .string()
    .trim()
    .min(1, 'Each check needs the number printed on its check paper.')
    .max(100)
    .describe('Number on the check paper this check prints on; each check in the run needs its own.'),
});

/** POST /api/print-queue/run — check a print run before printing (nothing is recorded). */
export const printRunSchema = z.object({
  items: z
    .array(printRunItemSchema)
    .min(1, 'Pick at least one check to print.')
    .max(300, 'Print at most 300 checks at a time.')
    .describe('The checks to print, all drawn on one bank account; 1 to 300.'),
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that check numbers in the run are already used on the bank account, to print them anyway.'),
});

/** POST /api/print-queue/confirm — "Did check(s) print OK?": `reprint` marks the ones that printed wrong. */
export const confirmPrintRunSchema = z.object({
  items: z
    .array(
      printRunItemSchema.extend({
        reprint: z
          .boolean()
          .optional()
          .describe('True when this check did not print correctly: it stays in the list, without a number, to print again.'),
      }),
    )
    .min(1, 'Pick at least one check to print.')
    .max(300, 'Print at most 300 checks at a time.')
    .describe('The checks of the print run, with the numbers they printed on; 1 to 300.'),
  allowDuplicateNumber: z
    .boolean()
    .optional()
    .describe('Send true only after the app warned that check numbers in the run are already used on the bank account, to record them anyway.'),
});

/** POST /api/print-queue/reprint — put a printed check back in the queue to print it again. */
export const reprintCheckSchema = z.object({
  source: printSourceSchema,
  id: zUuid.describe('Id of the printed check to put back in the Print Checks list; its check number is cleared.'),
});

export const queuePaychecksSchema = z.object({
  paycheckIds: z
    .array(zUuid)
    .min(1, 'Pick at least one paycheck.')
    .describe('Ids of paychecks (paycheck list) to add to the Print Checks list; at least one.'),
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
