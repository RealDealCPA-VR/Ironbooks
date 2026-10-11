/**
 * Memorized transactions (QB Lists > Memorized Transaction List).
 *
 * A template stores a docType, a schedule (frequency + nextRunDate), a JSON payload that mirrors
 * the create-input of the target service, and the QB options:
 *   - mode            'automatic' (enter on schedule) | 'remind' (Reminders list, the user enters
 *                     it) | 'never' (only when the user chooses Enter Now)
 *   - groupName       memorized-transaction group (run a whole group at once)
 *   - remaining       number of entries left (null = no limit); reaching 0 deactivates it
 *   - daysInAdvance   enter / remind this many days before the scheduled date
 *
 * Documents always post through the regular create services (createInvoice, createBill, …), so
 * every ledger rule (balanced entries, closing date, permissions, audit) applies unchanged. The
 * generated document is dated on its SCHEDULED date (not the day the run happened).
 *
 * Back-compat: templates created before the `mode` column carried { __options: { autoEnter } }
 * inside the jsonb; createTemplate still writes it and templateAutoEnter() still reads it, but
 * `mode` is authoritative (migration 0031 back-filled it).
 */

import { and, eq, lte } from 'drizzle-orm';
import { recurringTemplates } from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { requireEffectivePermission } from './access';
import { createInvoice, type CreateInvoiceInput } from './invoices';
import { createBill, type CreateBillInput } from './bills';
import { createManualEntry, type ManualEntryInput } from './journal';
import { createExpense, type CreateExpenseInput } from './expenses';
import { createSalesReceipt, type CreateSalesReceiptInput } from './salesReceipts';
import { createCreditMemo, type CreateCreditMemoInput } from './creditMemos';
import { createDeposit, type CreateDepositInput } from './deposits';
import { createTransfer, type CreateTransferInput } from './transfers';
import { createPurchaseOrder, type CreatePurchaseOrderInput } from './purchaseOrders';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DOC_TYPES = [
  'invoice',
  'bill',
  'journal_entry',
  'expense',
  'check',
  'sales_receipt',
  'credit_memo',
  'deposit',
  'transfer',
  'purchase_order',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const FREQUENCIES = [
  'never',
  'daily',
  'weekly',
  'biweekly',
  'every_four_weeks',
  'semimonthly',
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannually',
  'yearly',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const MODES = ['automatic', 'remind', 'never'] as const;
export type MemorizedMode = (typeof MODES)[number];

export interface CreateTemplateInput {
  name: string;
  docType: DocType;
  frequency: Frequency;
  /** ISO date string or Date — the first (or next) scheduled run. */
  nextRunDate: string | Date;
  /** JSON payload matching the create-input of the docType. Date fields as ISO strings. */
  template: Record<string, unknown>;
  /**
   * Legacy switch: true = automatic, false = remind. Ignored when `mode` is given.
   */
  autoEnter?: boolean;
  mode?: MemorizedMode;
  groupName?: string | null;
  remaining?: number | null;
  daysInAdvance?: number;
}

export interface UpdateTemplateInput {
  name?: string;
  frequency?: Frequency;
  nextRunDate?: string | Date | null;
  mode?: MemorizedMode;
  groupName?: string | null;
  remaining?: number | null;
  daysInAdvance?: number;
  isActive?: boolean;
  template?: Record<string, unknown>;
}

export interface GeneratedDoc {
  templateId: string;
  templateName: string;
  docType: DocType;
  /** The id of the created document. */
  docId: string;
}

export interface TemplateReminder {
  templateId: string;
  templateName: string;
  docType: DocType;
  /** The run date the template is (over)due for. */
  dueDate: Date;
}

export interface RunFailure {
  templateId: string;
  templateName: string;
  error: string;
}

/** Reserved key inside the template jsonb that carries legacy non-payload options. */
const OPTIONS_KEY = '__options';

interface TemplateOptions {
  autoEnter?: boolean;
}

/** Read the legacy auto-enter flag from a stored template jsonb (default true). */
export function templateAutoEnter(template: Record<string, unknown>): boolean {
  const opts = template[OPTIONS_KEY] as TemplateOptions | undefined;
  return opts?.autoEnter !== false;
}

/** Strip reserved option keys so the create services see a clean payload. */
function payloadOf(template: Record<string, unknown>): Record<string, unknown> {
  const { [OPTIONS_KEY]: _options, ...payload } = template;
  return payload;
}

// ---------------------------------------------------------------------------
// Schedule helpers
// ---------------------------------------------------------------------------

/**
 * Add calendar months keeping the day of the month, clamped to the month's last day (Jan 31 +
 * 1 month = Feb 28/29, never Mar 3 — a plain setMonth overflows into the next month).
 */
function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date);
  const dayOfMonth = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dayOfMonth, lastDay));
  return d;
}

/** Next occurrence after `date` for a frequency ('never' returns null). */
export function advanceDate(date: Date, frequency: Frequency): Date | null {
  const d = new Date(date);
  switch (frequency) {
    case 'never':
      return null;
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'biweekly':
      d.setDate(d.getDate() + 14);
      break;
    case 'every_four_weeks':
      d.setDate(d.getDate() + 28);
      break;
    case 'semimonthly':
      // Twice a month: the 1st/15th rhythm — before the 15th jump 15 days, else to next month's 1st
      // offset by the same day-of-half (keeps e.g. 5th/20th pairs).
      if (d.getDate() <= 15) d.setDate(d.getDate() + 15);
      else {
        const dayInHalf = d.getDate() - 15;
        d.setDate(1);
        d.setMonth(d.getMonth() + 1);
        d.setDate(Math.min(Math.max(1, dayInHalf), 15));
      }
      break;
    case 'monthly':
      return addMonthsClamped(d, 1);
    case 'bimonthly':
      return addMonthsClamped(d, 2);
    case 'quarterly':
      return addMonthsClamped(d, 3);
    case 'semiannually':
      return addMonthsClamped(d, 6);
    case 'yearly':
      return addMonthsClamped(d, 12);
  }
  return d;
}

/** Upcoming scheduled dates for a template within [from, to] (calendar projection). */
export function projectOccurrences(
  start: Date | null,
  frequency: Frequency,
  from: Date,
  to: Date,
  limit = 100,
): Date[] {
  if (!start) return [];
  const out: Date[] = [];
  let d: Date | null = new Date(start);
  while (d && d.getTime() <= to.getTime() && out.length < limit) {
    if (d.getTime() >= from.getTime()) out.push(new Date(d));
    d = advanceDate(d, frequency);
  }
  return out;
}

function daysBefore(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d;
}

/**
 * The run date is authoritative for generated documents: a template payload built from a real
 * create-input carries the ORIGINAL document date, and reusing it would post every recurrence
 * into the same historical period. The stored secondary date (due date / expected date) only
 * carries its offset from the original date (e.g. the payment terms) forward.
 */
function shiftedDate(payload: Record<string, unknown>, key: string, runDate: Date): Date | null {
  const baseDate = payload.date ? new Date(payload.date as string) : null;
  const base = payload[key] ? new Date(payload[key] as string) : null;
  if (!base || isNaN(base.getTime())) return null;
  if (!baseDate || isNaN(baseDate.getTime())) return base;
  return new Date(runDate.getTime() + (base.getTime() - baseDate.getTime()));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type TemplateRow = typeof recurringTemplates.$inferSelect;

export async function listTemplates(ctx: ServiceContext): Promise<TemplateRow[]> {
  return ctx.db
    .select()
    .from(recurringTemplates)
    .where(eq(recurringTemplates.companyId, ctx.companyId))
    .orderBy(recurringTemplates.createdAt);
}

export async function getTemplate(ctx: ServiceContext, id: string): Promise<TemplateRow> {
  const [row] = await ctx.db
    .select()
    .from(recurringTemplates)
    .where(
      and(eq(recurringTemplates.id, id), eq(recurringTemplates.companyId, ctx.companyId)),
    );
  if (!row) throw notFound('Memorized transaction');
  return row;
}

/** Re-read a template inside a transaction and hold its row lock until commit. */
async function lockTemplate(tx: ServiceContext, id: string): Promise<TemplateRow> {
  const [row] = await tx.db
    .select()
    .from(recurringTemplates)
    .where(and(eq(recurringTemplates.id, id), eq(recurringTemplates.companyId, tx.companyId)))
    .for('update');
  if (!row) throw notFound('Memorized transaction');
  return row;
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

function checkOptions(input: {
  frequency?: Frequency;
  mode?: MemorizedMode;
  remaining?: number | null;
  daysInAdvance?: number;
  groupName?: string | null;
}) {
  if (input.frequency !== undefined && !FREQUENCIES.includes(input.frequency)) {
    throw validation(`frequency must be one of: ${FREQUENCIES.join(', ')}.`);
  }
  if (input.mode !== undefined && !MODES.includes(input.mode)) {
    throw validation(`mode must be one of: ${MODES.join(', ')}.`);
  }
  if (input.remaining !== undefined && input.remaining !== null) {
    if (!Number.isInteger(input.remaining) || input.remaining < 0 || input.remaining > 9999) {
      throw validation('Number remaining must be a whole number from 0 to 9999 (or blank for no limit).');
    }
  }
  if (input.daysInAdvance !== undefined) {
    if (!Number.isInteger(input.daysInAdvance) || input.daysInAdvance < 0 || input.daysInAdvance > 365) {
      throw validation('Days in advance must be a whole number from 0 to 365.');
    }
  }
  if (input.groupName && input.groupName.length > 100) throw validation('Group name is too long.');
}

function parseRunDate(v: string | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) throw validation('nextRunDate is not a valid date.');
  return d;
}

/**
 * Automatic memorized transactions are posted unattended (at launch and hourly by the desktop
 * app, or by Run due) through a trusted context, so deciding WHAT gets posted automatically is
 * as sensitive as running memorized transactions (/api/recurring/run needs Accounting). Lists
 * permission alone may still rename/regroup any template and edit remind-only or never
 * templates, which only post when a user with the document's own permission enters them.
 * Trusted contexts (no `access`) are unrestricted, as everywhere else.
 */
async function assertMayAutomate(ctx: ServiceContext): Promise<void> {
  if (ctx.access) await requireEffectivePermission(ctx, 'accounting', 'create');
}

export async function createTemplate(ctx: ServiceContext, input: CreateTemplateInput) {
  if (!input.name?.trim()) {
    throw validation('Template name is required.');
  }
  if (!DOC_TYPES.includes(input.docType)) {
    throw validation(`docType must be one of: ${DOC_TYPES.join(', ')}.`);
  }
  if (!input.template || typeof input.template !== 'object' || Array.isArray(input.template)) {
    throw validation('template payload is required and must be an object.');
  }
  checkOptions(input);
  const nextRunDate = parseRunDate(input.nextRunDate);
  const mode: MemorizedMode = input.mode ?? (input.autoEnter === false ? 'remind' : 'automatic');

  // Keep the legacy option inside the jsonb so older readers see the same behavior.
  const template: Record<string, unknown> = {
    ...payloadOf(input.template),
    [OPTIONS_KEY]: { autoEnter: mode === 'automatic' },
  };

  // The view-only check, the insert and its audit entry commit together: a refused call leaves
  // nothing behind.
  return inTransaction(ctx, async (tx) => {
    if (mode === 'automatic') await assertMayAutomate(tx);
    const [row] = await tx.db
      .insert(recurringTemplates)
      .values({
        companyId: tx.companyId,
        name: input.name.trim(),
        docType: input.docType,
        frequency: input.frequency,
        nextRunDate,
        template,
        isActive: true,
        mode,
        groupName: input.groupName?.trim() || null,
        remaining: input.remaining ?? null,
        daysInAdvance: input.daysInAdvance ?? 0,
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'recurring_template',
      entityId: row.id,
      newValues: {
        name: row.name,
        docType: row.docType,
        frequency: row.frequency,
        mode,
        autoEnter: mode === 'automatic',
        groupName: row.groupName,
        remaining: row.remaining,
        daysInAdvance: row.daysInAdvance,
      },
    });

    return row;
  });
}

/** Edit a memorized transaction's schedule, options or (re-memorized) payload. */
export async function updateTemplate(ctx: ServiceContext, id: string, input: UpdateTemplateInput) {
  checkOptions(input);
  return inTransaction(ctx, async (tx) => {
    const before = await lockTemplate(tx, id);
    const patch: Partial<typeof recurringTemplates.$inferInsert> = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw validation('Template name is required.');
      patch.name = input.name.trim();
    }
    if (input.frequency !== undefined) patch.frequency = input.frequency;
    if (input.nextRunDate !== undefined) patch.nextRunDate = parseRunDate(input.nextRunDate);
    if (input.groupName !== undefined) patch.groupName = input.groupName?.trim() || null;
    if (input.remaining !== undefined) patch.remaining = input.remaining;
    if (input.daysInAdvance !== undefined) patch.daysInAdvance = input.daysInAdvance;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    const mode = input.mode ?? (before.mode as MemorizedMode);
    if (input.mode !== undefined) patch.mode = input.mode;
    if (input.template !== undefined) {
      if (!input.template || typeof input.template !== 'object' || Array.isArray(input.template)) {
        throw validation('template payload must be an object.');
      }
      patch.template = { ...payloadOf(input.template), [OPTIONS_KEY]: { autoEnter: mode === 'automatic' } };
    } else if (input.mode !== undefined) {
      patch.template = {
        ...payloadOf(before.template as Record<string, unknown>),
        [OPTIONS_KEY]: { autoEnter: mode === 'automatic' },
      };
    }
    if (Object.keys(patch).length === 0) return before;
    // Anything that changes what, when or how often an AUTOMATIC template posts (payload, schedule,
    // remaining, re-activation, switching to automatic) needs Accounting. Rename/regroup is a list edit.
    const touchesPosting = Object.keys(patch).some((k) => k !== 'name' && k !== 'groupName');
    if (mode === 'automatic' && touchesPosting) await assertMayAutomate(tx);
    const [row] = await tx.db
      .update(recurringTemplates)
      .set(patch)
      .where(and(eq(recurringTemplates.id, id), eq(recurringTemplates.companyId, tx.companyId)))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'recurring_template',
      entityId: id,
      oldValues: {
        name: before.name,
        frequency: before.frequency,
        nextRunDate: before.nextRunDate,
        mode: before.mode,
        groupName: before.groupName,
        remaining: before.remaining,
        daysInAdvance: before.daysInAdvance,
        isActive: before.isActive,
        ...(input.template !== undefined ? { template: before.template } : {}),
      },
      newValues: {
        name: row.name,
        frequency: row.frequency,
        nextRunDate: row.nextRunDate,
        mode: row.mode,
        groupName: row.groupName,
        remaining: row.remaining,
        daysInAdvance: row.daysInAdvance,
        isActive: row.isActive,
        ...(input.template !== undefined ? { template: row.template } : {}),
      },
    });
    return row;
  });
}

/** Delete a memorized transaction (documents it already entered are untouched). */
export async function deleteTemplate(ctx: ServiceContext, id: string): Promise<void> {
  await inTransaction(ctx, async (tx) => {
    const before = await lockTemplate(tx, id);
    await tx.db
      .delete(recurringTemplates)
      .where(and(eq(recurringTemplates.id, id), eq(recurringTemplates.companyId, tx.companyId)));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'recurring_template',
      entityId: id,
      oldValues: { name: before.name, docType: before.docType, frequency: before.frequency },
    });
  });
}

// ---------------------------------------------------------------------------
// generateFromTemplate — internal
// ---------------------------------------------------------------------------

async function generateFromTemplate(
  ctx: ServiceContext,
  template: TemplateRow,
  runDate: Date,
): Promise<GeneratedDoc> {
  const payload = payloadOf(template.template as Record<string, unknown>);
  let docId: string;

  switch (template.docType as DocType) {
    case 'invoice': {
      const input = { ...(payload as unknown as CreateInvoiceInput), date: runDate, dueDate: shiftedDate(payload, 'dueDate', runDate) };
      docId = (await createInvoice(ctx, input)).id;
      break;
    }
    case 'bill': {
      const input = { ...(payload as unknown as CreateBillInput), date: runDate, dueDate: shiftedDate(payload, 'dueDate', runDate) };
      docId = (await createBill(ctx, input)).id;
      break;
    }
    case 'journal_entry': {
      const input = { ...(payload as unknown as ManualEntryInput), date: runDate };
      docId = (await createManualEntry(ctx, input)).id;
      break;
    }
    case 'expense': {
      const input = { ...(payload as unknown as CreateExpenseInput), date: runDate };
      docId = (await createExpense(ctx, input)).id;
      break;
    }
    case 'check': {
      // A memorized check: an expense paid by check. A stored reference (check number) is never
      // reused — the next number comes from the check sequence (or Print Checks).
      const input = {
        ...(payload as unknown as CreateExpenseInput),
        method: 'check' as const,
        reference: null,
        date: runDate,
      };
      docId = (await createExpense(ctx, input)).id;
      break;
    }
    case 'sales_receipt': {
      const input = { ...(payload as unknown as CreateSalesReceiptInput), date: runDate };
      docId = (await createSalesReceipt(ctx, input)).id;
      break;
    }
    case 'credit_memo': {
      const input = { ...(payload as unknown as CreateCreditMemoInput), date: runDate };
      docId = (await createCreditMemo(ctx, input)).id;
      break;
    }
    case 'deposit': {
      // Only the "other" deposit lines recur — customer payments in Undeposited Funds are
      // one-time money and are never re-deposited from a memorized deposit.
      const input = {
        ...(payload as unknown as CreateDepositInput),
        paymentIds: [],
        salesReceiptIds: [],
        date: runDate,
      };
      docId = (await createDeposit(ctx, input)).id;
      break;
    }
    case 'transfer': {
      const input = { ...(payload as unknown as CreateTransferInput), date: runDate };
      docId = (await createTransfer(ctx, input)).id;
      break;
    }
    case 'purchase_order': {
      const input = {
        ...(payload as unknown as CreatePurchaseOrderInput),
        date: runDate,
        expectedDate: shiftedDate(payload, 'expectedDate', runDate),
      };
      docId = (await createPurchaseOrder(ctx, input)).id;
      break;
    }
    default:
      throw new ServiceError('VALIDATION', `Unknown docType: ${template.docType}`);
  }

  return {
    templateId: template.id,
    templateName: template.name,
    docType: template.docType as DocType,
    docId,
  };
}

/** After an entry: next date (caught up past `now`), remaining count, deactivate when done. */
async function recordRun(
  ctx: ServiceContext,
  template: TemplateRow,
  fromDate: Date,
  now: Date,
  docId: string,
): Promise<void> {
  const frequency = template.frequency as Frequency;
  // Catch up so a template several periods overdue fires once, not on every subsequent run.
  let nextRun = advanceDate(fromDate, frequency);
  while (nextRun && nextRun.getTime() <= now.getTime()) {
    nextRun = advanceDate(nextRun, frequency);
  }
  const remaining = template.remaining === null ? null : Math.max(0, template.remaining - 1);
  const finished = remaining === 0;
  await ctx.db
    .update(recurringTemplates)
    .set({
      nextRunDate: nextRun,
      remaining,
      lastRunAt: now,
      ...(finished ? { isActive: false } : {}),
    })
    .where(eq(recurringTemplates.id, template.id));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'recurring_template',
    entityId: template.id,
    oldValues: { nextRunDate: template.nextRunDate, remaining: template.remaining },
    newValues: { nextRunDate: nextRun, remaining, generatedDocId: docId, ...(finished ? { isActive: false } : {}) },
  });
}

/**
 * Enter one template atomically: lock its row, let `decide` re-check it against the CURRENT
 * state (an overlapping run may have entered it a moment ago), then create the document and
 * advance the schedule in the same transaction. Overlapping runs (desktop launch run, hourly
 * timer, manual Run due / Enter Now / Enter Group) therefore never post the same occurrence
 * twice, and a document that fails to post (e.g. closed period) leaves the template unchanged.
 * Returns null when `decide` says the template is no longer due.
 */
async function enterLocked(
  ctx: ServiceContext,
  id: string,
  now: Date,
  decide: (row: TemplateRow) => { runDate: Date; fromDate: Date } | null,
): Promise<GeneratedDoc | null> {
  return inTransaction(ctx, async (tx) => {
    const row = await lockTemplate(tx, id);
    const plan = decide(row);
    if (!plan) return null;
    const doc = await generateFromTemplate(tx, row, plan.runDate);
    await recordRun(tx, row, plan.fromDate, now, doc.docId);
    return doc;
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// runDue
// ---------------------------------------------------------------------------

/**
 * Run every active, scheduled template due on or before `asOf` (+ its days in advance).
 * Automatic templates are entered (dated on their scheduled date) and advanced; remind-only
 * templates come back as reminders without posting; 'never' templates are skipped. A template
 * whose document fails to post (e.g. closed period) is reported in `failed` and left due —
 * it never blocks the others.
 */
export async function runDue(
  ctx: ServiceContext,
  asOf: Date = new Date(),
): Promise<{ generated: GeneratedDoc[]; reminders: TemplateReminder[]; failed: RunFailure[] }> {
  const candidates = await ctx.db
    .select()
    .from(recurringTemplates)
    .where(
      and(
        eq(recurringTemplates.companyId, ctx.companyId),
        eq(recurringTemplates.isActive, true),
        // Upper bound: the furthest a template may be entered in advance (filtered per row below).
        lte(recurringTemplates.nextRunDate, new Date(asOf.getTime() + 366 * 86_400_000)),
      ),
    );

  const generated: GeneratedDoc[] = [];
  const reminders: TemplateReminder[] = [];
  const failed: RunFailure[] = [];

  for (const template of candidates) {
    if (!template.nextRunDate) continue;
    if (template.mode === 'never' || template.frequency === 'never') continue;
    if (template.remaining === 0) continue;
    const runDate = template.nextRunDate;
    if (daysBefore(runDate, template.daysInAdvance ?? 0).getTime() > asOf.getTime()) continue;

    const remind = template.mode === 'remind';
    if (remind) {
      reminders.push({
        templateId: template.id,
        templateName: template.name,
        docType: template.docType as DocType,
        dueDate: runDate,
      });
      continue;
    }
    try {
      const doc = await enterLocked(ctx, template.id, asOf, (cur) =>
        cur.isActive &&
        cur.mode === 'automatic' &&
        cur.frequency !== 'never' &&
        cur.remaining !== 0 &&
        cur.nextRunDate !== null &&
        cur.nextRunDate.getTime() === runDate.getTime()
          ? { runDate, fromDate: runDate }
          : null, // already entered (or changed) by an overlapping run
      );
      if (doc) generated.push(doc);
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw err;
      failed.push({ templateId: template.id, templateName: template.name, error: errMessage(err) });
    }
  }

  return { generated, reminders, failed };
}

// ---------------------------------------------------------------------------
// runTemplateNow / runGroup
// ---------------------------------------------------------------------------

/**
 * Enter a single template now (QB "Enter Transaction"). Dated today unless `date` is given;
 * advances the schedule as if it ran on time and counts toward "number remaining".
 */
export async function runTemplateNow(
  ctx: ServiceContext,
  id: string,
  date?: Date,
): Promise<GeneratedDoc> {
  const now = new Date();
  const runDate = date ?? now;
  const doc = await enterLocked(ctx, id, now, (cur) => {
    if (!cur.isActive) throw validation('This memorized transaction is inactive. Make it active to enter it.');
    if (cur.remaining === 0) throw validation('No entries remain for this memorized transaction.');
    return { runDate, fromDate: cur.nextRunDate ?? runDate };
  });
  if (!doc) throw validation('This memorized transaction could not be entered.');
  return doc;
}

/** Enter every active template in a memorized group now (QB "Enter Group"). */
export async function runGroup(
  ctx: ServiceContext,
  groupName: string,
): Promise<{ generated: GeneratedDoc[]; failed: RunFailure[] }> {
  const rows = await ctx.db
    .select()
    .from(recurringTemplates)
    .where(
      and(
        eq(recurringTemplates.companyId, ctx.companyId),
        eq(recurringTemplates.groupName, groupName),
        eq(recurringTemplates.isActive, true),
      ),
    );
  if (rows.length === 0) throw notFound('Memorized group');
  const generated: GeneratedDoc[] = [];
  const failed: RunFailure[] = [];
  for (const t of rows) {
    if (t.remaining === 0) continue;
    try {
      generated.push(await runTemplateNow(ctx, t.id));
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw err;
      failed.push({ templateId: t.id, templateName: t.name, error: errMessage(err) });
    }
  }
  return { generated, failed };
}
