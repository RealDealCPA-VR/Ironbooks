/**
 * The command bar's structured intent — the ONE shape both the deterministic grammar
 * (lib/commands/grammar.ts) and the optional AI fallback produce, and the only thing the
 * executor (lib/services/commandBar.ts) runs. Validated with zod wherever it crosses a trust
 * boundary (model output, HTTP body). PURE (client + server).
 *
 * Intents only ever DESCRIBE what the user wants: open a form pre-filled for them to review and
 * save, open a report or page, or answer a read-only question. Nothing here can write data.
 */
import { z } from 'zod';
import { parseNumber } from './text';

export const FORM_KINDS = ['invoice', 'bill', 'expense', 'estimate', 'sales_receipt'] as const;
export type FormKind = (typeof FORM_KINDS)[number];

export const FORM_LABELS: Record<FormKind, string> = {
  invoice: 'invoice',
  bill: 'bill',
  expense: 'check / expense',
  estimate: 'estimate',
  sales_receipt: 'sales receipt',
};

/** Sales forms bill a customer; purchase forms pay a vendor. */
export const SALES_FORMS: readonly FormKind[] = ['invoice', 'estimate', 'sales_receipt'];
export function isSalesForm(f: FormKind): boolean {
  return SALES_FORMS.includes(f);
}

export const REPORT_KINDS = ['unpaid_bills', 'unpaid_invoices', 'profit_loss', 'balance_sheet', 'ap_aging', 'ar_aging'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const ACTION_KEYS = [
  'pay_bills',
  'reconcile',
  'record_deposit',
  'receive_payment',
  'transfer_funds',
  'journal_entry',
  'run_payroll',
  'bank_feeds',
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

/** A real calendar day ('2026-02-31' is rejected — JS Date would roll it into March). */
const zDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'not a real date');
const zText = (max = 200) => z.string().trim().min(1).max(max);

/**
 * Accepts "3", 3, "$1,200.50" — normalizes to a canonical decimal string. Zero is rejected: a
 * zero quantity, rate or amount is never what was meant (and a zero quantity would divide by 0).
 */
const zDecimal = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z
    .string()
    .transform((s, ctx) => {
      const n = parseNumber(s);
      if (n === null || !/^\d{1,13}(\.\d{1,4})?$/.test(n) || !/[1-9]/.test(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a positive number' });
        return z.NEVER;
      }
      return n;
    }),
);

export const intentLineSchema = z.object({
  /** Item / service / expense-account words ("consulting", "office supplies"). */
  text: zText().optional(),
  quantity: zDecimal.optional(),
  /** Price per unit. */
  rate: zDecimal.optional(),
  /** Line total (purchases: the amount; sales: quantity 1 at this rate). */
  amount: zDecimal.optional(),
  /**
   * Purchases: `amount` came from a bare whole number ("bill from Staples 3 widgets"). If the line
   * turns out to be an ITEM, the executor reads it as a quantity instead of dollars.
   */
  amountMaybeCount: z.boolean().optional(),
  /** Numbers the user typed that the grammar could not place — shown as a note, never dropped. */
  unclear: z.array(z.string().trim().min(1).max(40)).max(5).optional(),
});
export type IntentLine = z.infer<typeof intentLineSchema>;

const zCreate = z.object({
  kind: z.literal('create'),
  form: z.enum(FORM_KINDS),
  /** Customer (sales forms) or vendor / payee (purchase forms), as typed. */
  party: zText().optional(),
  lines: z.array(intentLineSchema).max(20).default([]),
  date: zDay.optional(),
  memo: zText(500).optional(),
  /** Checks/expenses: the bank or card it was paid from ("with Amex"). */
  paymentAccount: zText().optional(),
});

const zReport = z.object({
  kind: z.literal('report'),
  report: z.enum(REPORT_KINDS),
  /** Only documents MORE than this many days past due. */
  overDays: z.coerce.number().int().min(0).max(3650).optional(),
  party: zText().optional(),
  from: zDay.optional(),
  to: zDay.optional(),
  /** Free-text period ("Q3", "last month"), resolved by the executor when from/to are absent. */
  period: zText(60).optional(),
  /** The typed period was not valid (inverted / not a real date) — the executor reports it. */
  dateProblem: zText(200).optional(),
});

const zQuestion = z.object({
  kind: z.literal('question'),
  /** spend = expense accounts (debits), income = income accounts (credits). */
  measure: z.enum(['spend', 'income']),
  /** Account / vendor / customer words ("fuel", "Staples"); absent = everything. */
  subject: zText().optional(),
  from: zDay.optional(),
  to: zDay.optional(),
  period: zText(60).optional(),
  rangeLabel: zText(100).optional(),
  /** The typed period was not valid (inverted / not a real date) — the executor reports it. */
  dateProblem: zText(200).optional(),
});

const zNavigate = z.object({
  kind: z.literal('navigate'),
  /** Page name as typed ("pay bills", "chart of accounts"). */
  target: zText(),
});

const zAction = z.object({
  kind: z.literal('action'),
  action: z.enum(ACTION_KEYS),
  /** e.g. the account for "reconcile checking", the customer for "receive payment from Acme". */
  target: zText().optional(),
});

export const commandIntentSchema = z.discriminatedUnion('kind', [zCreate, zReport, zQuestion, zNavigate, zAction]);
export type CommandIntent = z.infer<typeof commandIntentSchema>;
export type CreateIntent = z.infer<typeof zCreate>;
export type ReportIntent = z.infer<typeof zReport>;
export type QuestionIntent = z.infer<typeof zQuestion>;
export type NavigateIntent = z.infer<typeof zNavigate>;
export type ActionIntent = z.infer<typeof zAction>;

/** What the AI fallback must return: an intent, or a refusal when it cannot tell. */
export const aiIntentReplySchema = z.object({
  intent: commandIntentSchema.nullable(),
});

/**
 * Hints chosen by the user from a "Which one did you mean?" list. Ids are re-checked against
 * the company by the executor — a hint is never trusted on its own.
 */
export const resolveHintsSchema = z
  .object({
    partyId: z.string().uuid().optional(),
    /** Line index → item id (sales forms or purchase item lines). */
    itemIds: z.record(z.string().regex(/^\d{1,2}$/), z.string().uuid()).optional(),
    /** Line index → expense account id (purchase forms). */
    accountIds: z.record(z.string().regex(/^\d{1,2}$/), z.string().uuid()).optional(),
    /** Question subject: an account or a name. */
    subjectAccountId: z.string().uuid().optional(),
    subjectVendorId: z.string().uuid().optional(),
    subjectCustomerId: z.string().uuid().optional(),
    /** "Everything": ignore the subject (all expense / income accounts). */
    subjectAll: z.boolean().optional(),
    bankAccountId: z.string().uuid().optional(),
    paymentAccountId: z.string().uuid().optional(),
    /** Ambiguous form: the user picked which form they meant. */
    form: z.enum(FORM_KINDS).optional(),
  })
  .strict();
export type ResolveHints = z.infer<typeof resolveHintsSchema>;

// ---------------------------------------------------------------------------
// One-line description (live preview row in the command bar)
// ---------------------------------------------------------------------------

function lineText(l: IntentLine): string {
  const parts: string[] = [];
  if (l.quantity) parts.push(`${l.quantity} ×`);
  if (l.text) parts.push(l.text);
  if (l.rate) parts.push(`at $${l.rate}`);
  if (l.amount) parts.push(`$${l.amount}`);
  if (l.unclear?.length) parts.push(`(not sure about ${l.unclear.join(', ')})`);
  return parts.join(' ');
}

const REPORT_TITLES: Record<ReportKind, string> = {
  unpaid_bills: 'unpaid bills',
  unpaid_invoices: 'unpaid invoices',
  profit_loss: 'Profit & Loss',
  balance_sheet: 'Balance Sheet',
  ap_aging: 'A/P aging (what you owe)',
  ar_aging: 'A/R aging (who owes you)',
};

export const ACTION_TITLES: Record<ActionKey, string> = {
  pay_bills: 'Pay bills',
  reconcile: 'Reconcile',
  record_deposit: 'Record a deposit',
  receive_payment: 'Receive a payment',
  transfer_funds: 'Transfer money between accounts',
  journal_entry: 'New journal entry',
  run_payroll: 'Run payroll',
  bank_feeds: 'Bank feeds',
};

/** Plain-language summary of what pressing Enter will do. */
export function describeIntent(i: CommandIntent): string {
  switch (i.kind) {
    case 'create': {
      const who = i.party ? (isSalesForm(i.form) ? ` for “${i.party}”` : ` from “${i.party}”`) : '';
      const what = i.lines.map(lineText).filter(Boolean).join(', ');
      return `Fill in a new ${FORM_LABELS[i.form]}${who}${what ? ` — ${what}` : ''} (you review and save)`;
    }
    case 'report': {
      if (i.dateProblem) return i.dateProblem;
      const over = i.overDays !== undefined ? ` more than ${i.overDays} days past due` : '';
      const who = i.party ? ` for “${i.party}”` : '';
      return `Show ${REPORT_TITLES[i.report]}${who}${over}`;
    }
    case 'question': {
      if (i.dateProblem) return i.dateProblem;
      const verb = i.measure === 'spend' ? 'spent' : 'earned';
      const on = i.subject ? (i.measure === 'spend' ? ` on “${i.subject}”` : ` from “${i.subject}”`) : '';
      return `Work out how much you ${verb}${on}${i.rangeLabel ? `, ${i.rangeLabel}` : ''}`;
    }
    case 'navigate':
      return `Go to “${i.target}”`;
    case 'action':
      return `${ACTION_TITLES[i.action]}${i.target ? ` — ${i.target}` : ''}`;
  }
}
