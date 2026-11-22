/**
 * Zod schemas for the accountant tools (/api/accountant/*) — wave2 accountant.
 * Mirror the service inputs in lib/services/accountant/*.
 */
import { z } from 'zod';
import { zDate, zLines, zMoneyPositive, zUuid } from './helpers';
import { postingLineSchema } from './journal';
import { isIsoDate } from '@/lib/onboarding';

/** POST /api/accountant/sales-tax/adjustments — QB Sales Tax Adjustment (lib/services/accountant/salesTaxTools.ts). */
export const salesTaxAdjustmentSchema = z.object({
  date: zDate.describe('Date of the adjustment entry, YYYY-MM-DD.'),
  agencyId: zUuid.describe('Id of the tax agency (vendor list) whose sales tax owed changes.'),
  amount: zMoneyPositive.describe('Size of the adjustment, as decimal text above zero such as "12.50".'),
  direction: z
    .enum(['reduce', 'increase'], { errorMap: () => ({ message: "direction must be 'reduce' or 'increase'" }) })
    .describe('reduce lowers what is owed to the agency (a discount, rounding down); increase raises it (a penalty, interest).'),
  adjustmentAccountId: zUuid.describe(
    'Id of the income or expense account (chart of accounts) on the other side, such as a discount income or a penalty expense account; not a sales tax, bank, A/R or A/P account.',
  ),
  reason: z
    .enum(['discount', 'rounding', 'penalty', 'interest', 'other'])
    .describe('Why: discount, rounding, penalty, interest or other; it names the entry when memo is left out.'),
  memo: z.string().nullish().describe('Description of the entry; leave out for "Sales tax <reason> — <agency name>".'),
  reference: z.string().nullish().describe('Reference number of the entry, such as the notice number; leave out for none.'),
});

/** POST /api/accountant/sales-tax/fix — Fix Incorrectly Recorded Sales Tax (GET lists the issues). */
export const fixSalesTaxSchema = z.discriminatedUnion('action', [
  z.object({
    action: z
      .literal('link')
      .describe('link: say which agency a line on a sales tax liability account belongs to; the line itself is not changed.'),
    lineId: zUuid.describe('Id of the entry line on the sales tax liability account (from GET /api/accountant/sales-tax/fix).'),
    agencyId: zUuid.describe('Id of the tax agency (vendor list) the line belongs to.'),
    kind: z
      .enum(['payment', 'adjustment', 'collected'])
      .describe('What the line is for that agency: payment, adjustment or collected (tax charged on sales).'),
    note: z.string().nullish().describe('Note saved with the link; leave out for none.'),
  }),
  z.object({
    action: z.literal('unlink').describe('unlink: take a link off again, so the line needs review again.'),
    lineId: zUuid.describe('Id of the entry line whose link is removed.'),
  }),
  z.object({
    action: z
      .literal('reclassify')
      .describe(
        'reclassify: move an agency payment that was posted to an expense account onto the sales tax liability, with a correcting entry; the original stays as it is.',
      ),
    lineId: zUuid.describe('Id of the expense line (a debit) that paid the agency (from GET /api/accountant/sales-tax/fix).'),
    agencyId: zUuid.describe('Id of the tax agency (vendor list) that was paid.'),
    date: zDate.nullish().describe('Date of the correcting entry, YYYY-MM-DD; leave out for the date of the original.'),
  }),
  z.object({
    action: z.literal('undo_fix').describe('undo_fix: void a correcting entry whose original is gone (GET lists them).'),
    entryId: zUuid.describe('Id of the correcting journal entry to void.'),
  }),
]);

export const reclassifySchema = z
  .object({
    lineIds: z.array(zUuid).min(1, 'select at least one line').max(2000),
    newAccountId: zUuid.nullish(),
    /** null clears the class; omit to keep it. */
    newClassId: zUuid.nullable().optional(),
  })
  .refine((v) => Boolean(v.newAccountId) || v.newClassId !== undefined, {
    message: 'Choose a new account and/or a new class.',
    path: ['newAccountId'],
  });

export const writeOffSchema = z.object({
  invoiceIds: z.array(zUuid).min(1, 'select at least one invoice').max(500),
  date: zDate,
  badDebtAccountId: zUuid,
  memo: z.string().nullish(),
});

const batchRowSchema = z.object({
  date: z.string().default(''),
  ref: z.string().optional(),
  name: z.string().optional(),
  account: z.string().default(''),
  amount: z.string().optional(),
  debit: z.string().optional(),
  credit: z.string().optional(),
  memo: z.string().optional(),
  className: z.string().optional(),
  dueDate: z.string().optional(),
  item: z.string().optional(),
  quantity: z.string().optional(),
  rate: z.string().optional(),
  taxCode: z.string().optional(),
  taxItem: z.string().optional(),
  customerJob: z.string().optional(),
});

export const batchEnterSchema = z.object({
  type: z.enum(['check', 'deposit', 'cc_charge', 'cc_credit', 'invoice', 'credit_memo', 'bill', 'bill_credit', 'journal']),
  bankAccountId: zUuid.nullish(),
  rows: z.array(batchRowSchema).min(1, 'enter at least one row').max(1000),
  mode: z.enum(['all', 'row']).optional(),
  validateOnly: z.boolean().optional(),
});

export const batchVoidSchema = z.object({
  keys: z.array(z.string().regex(/^[a-z_]+:[0-9a-f-]{36}$/i, 'invalid transaction key')).min(1).max(500),
  /** 'delete' = QB Batch Delete where allowed (default 'void'). */
  action: z.enum(['void', 'delete']).optional(),
  /** Record locking: key -> the version (updated_at) the row was listed with. */
  versions: z.record(z.string().nullish()).optional(),
});

export const batchRestoreSchema = z.object({
  ids: z.array(zUuid).min(1).max(500),
});

export const wtbNoteSchema = z.object({
  accountId: zUuid,
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD'),
  workpaperRef: z.string().max(100).nullish(),
  note: z.string().max(4000).nullish(),
});

/** POST /api/accountant/working-trial-balance — an adjusting journal entry from the Working Trial Balance. */
export const adjustingEntrySchema = z.object({
  date: zDate.describe('Date of the adjusting entry, YYYY-MM-DD.'),
  description: z
    .string()
    .trim()
    .min(1, 'description is required')
    .describe('What the adjustment is for, such as "Accrue December rent".'),
  reference: z.string().nullish().describe('Reference number of the entry, such as a workpaper reference; leave out for none.'),
  lines: zLines(postingLineSchema).describe('The lines of the entry, each a debit or a credit; the debits and credits must be equal.'),
});

export const listChangesReviewSchema = z.object({
  auditLogIds: z.array(zUuid).min(1).max(5000),
  reviewed: z.boolean(),
});

/** POST /api/accountant/client-data-review — Client Data Review (GET lists the tasks and their issues). */
export const clientReviewActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('task_status').describe('task_status: set where one review task stands.'),
    taskKey: z.string().min(1).describe('Key of the review task, as GET /api/accountant/client-data-review lists it.'),
    status: z.enum(['not_started', 'in_progress', 'completed']).describe('not_started, in_progress or completed.'),
    note: z.string().nullish().describe('Note saved with the task; leave out for none.'),
  }),
  z.object({
    action: z
      .literal('snapshot')
      .describe('snapshot: mark the review complete, keeping every account balance as of asOf so the next review shows what changed since.'),
    asOf: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be YYYY-MM-DD')
      .refine((s) => isIsoDate(s), 'The review period end must be a real date.')
      .describe('End of the review period, YYYY-MM-DD.'),
    note: z.string().nullish().describe('Note saved with the review; leave out for none.'),
  }),
  z.object({
    action: z
      .literal('apply_customer_credit')
      .describe("apply_customer_credit: apply an unapplied customer payment or credit memo to that customer's oldest open invoices."),
    refType: z.enum(['payment', 'credit_memo']).describe('What refId is: payment or credit_memo.'),
    refId: zUuid.describe('Id of the customer payment or credit memo that has an unapplied amount.'),
  }),
  z.object({
    action: z.literal('apply_vendor_credit').describe("apply_vendor_credit: apply an unapplied bill credit to that vendor's oldest open bills."),
    refId: zUuid.describe('Id of the bill credit (vendor credit) that has an unapplied amount.'),
  }),
  // Clear Up Undeposited Funds (feature round, I13): the deposit takes these payments in place of its line.
  z.object({
    action: z
      .literal('clear_undeposited')
      .describe(
        'clear_undeposited: a deposit that recorded income straight to an account takes the payments waiting in Undeposited Funds in place of that line (same total).',
      ),
    depositId: zUuid.describe('Id of the deposit to change.'),
    lineId: zUuid.describe('Id of the deposit line, posted straight to an account, that the payments replace.'),
    items: z
      .array(
        z.object({
          kind: z.enum(['payment', 'sales_receipt', 'invoice_payment']).describe('What id is: payment, sales_receipt or invoice_payment.'),
          id: zUuid.describe('Id of the payment or sales receipt waiting in Undeposited Funds.'),
        }),
      )
      .min(1)
      .max(200)
      .describe('The waiting payments the deposit takes instead, 1 to 200; together they must equal the line.'),
  }),
]);

