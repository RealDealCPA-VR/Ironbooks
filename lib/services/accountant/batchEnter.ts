/**
 * Batch Enter Transactions (QB Accountant → Batch Enter Transactions) — wave2 accountant, I5.
 *
 * A grid of checks, deposits, credit card charges/credits, invoices, credit memos, bills, bill
 * credits or journal entries (typed or pasted from Excel). Each row is resolved (names, accounts,
 * classes, dates, amounts), validated, and saved through the NORMAL document services
 * (createExpense, createDeposit, createInvoice, createCreditMemo, createBill, createVendorCredit,
 * createManualEntry) — so posting, closing-date, audit and transaction-log rules are identical to
 * entering the forms one by one.
 *
 * Modes:
 *  - 'all'  — one database transaction: either every row saves or none does (any error rolls the
 *             whole batch back and is reported per row).
 *  - 'row'  — each row in its own transaction; good rows save, bad rows are reported.
 *  - validateOnly — runs the full save inside a transaction that is always rolled back, so the
 *             report includes business-rule errors (closed period, unbalanced JE…) without saving.
 */
import { and, eq } from 'drizzle-orm';
import { accounts, classes, customers, vendors } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation } from '../_base';
import { createExpense } from '../expenses';
import { createDeposit } from '../deposits';
import { createInvoice } from '../invoices';
import { createCreditMemo } from '../creditMemos';
import { createBill } from '../bills';
import { createVendorCredit } from '../vendorCredits';
import { createManualEntry } from '../journal';
import { requirePermission } from '../access';
import type { Area } from '@/lib/permissions/model';
import { getClosingDateSettings } from '../company';
import { BATCH_ENTER_TYPES, type BatchEnterRow, type BatchEnterType } from './batchEnterParse';
import {
  type BatchLookupLists,
  type ResolvedBatchDoc,
  createBatchMatchers,
  resolveBatchRows,
} from './batchEnterMatch';

export interface BatchEnterInput {
  type: BatchEnterType;
  /** Bank account (checks, deposits) or credit-card account (cc charges/credits). */
  bankAccountId?: string | null;
  rows: BatchEnterRow[];
  mode?: 'all' | 'row';
  validateOnly?: boolean;
}

export interface BatchEnterRowResult {
  /** 0-based row indexes this result covers (journal entries span several rows). */
  rows: number[];
  ok: boolean;
  errors: string[];
  /** Non-blocking notes (one-time payee, closing date) from the row checks. */
  warnings: string[];
  /** Id of the saved document / entry. */
  id?: string;
}

export interface BatchEnterResult {
  saved: number;
  failed: number;
  /** True when nothing was persisted (validateOnly, or 'all' mode with an error). */
  rolledBack: boolean;
  results: BatchEnterRowResult[];
}

class RollbackSignal extends Error {}

/** The company's lists used to match names and account numbers (active accounts only). */
async function loadLists(ctx: ServiceContext): Promise<BatchLookupLists> {
  const acct = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true)));
  const cls = await ctx.db
    .select({ id: classes.id, name: classes.name })
    .from(classes)
    .where(eq(classes.companyId, ctx.companyId));
  const cust = await ctx.db
    .select({ id: customers.id, name: customers.displayName })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const vend = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.companyId, ctx.companyId));
  return {
    accounts: acct.map((a) => ({ ...a, type: String(a.type), subtype: a.subtype ? String(a.subtype) : null })),
    classes: cls,
    customers: cust,
    vendors: vend,
  };
}

export interface BatchEnterLookups extends BatchLookupLists {
  /** Company closing date ('YYYY-MM-DD') or null — rows on/before it need the password. */
  closingDate: string | null;
  closingDateHasPassword: boolean;
  /** The Accounts Payable account bills post to ("2000 · Accounts Payable"), when present. */
  apAccountLabel: string | null;
}

/**
 * Everything the Batch Enter grid needs to match and check rows while the user types or pastes
 * (GET /api/accountant/batch-enter/lookups). Company-scoped; read-only.
 */
export async function batchEnterLookups(ctx: ServiceContext): Promise<BatchEnterLookups> {
  // The full customer and vendor lists are only for people who may batch-enter (the same right
  // the POST needs), not for anyone who can merely view the books.
  requirePermission(ctx, 'accounting', 'create');
  const lists = await loadLists(ctx);
  const closing = await getClosingDateSettings(ctx);
  const ap = lists.accounts.find((a) => a.code === '2000');
  return {
    ...lists,
    closingDate: closing.closingDate,
    closingDateHasPassword: closing.hasPassword,
    apAccountLabel: ap ? `${ap.code} · ${ap.name}` : null,
  };
}

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

type Job = { rows: number[]; errors: string[]; warnings: string[]; run?: (tx: ServiceContext) => Promise<{ id: string }> };

/** The normal document service call that saves one resolved row (or journal-entry group). */
function runnerFor(doc: ResolvedBatchDoc, bank: string | null): (tx: ServiceContext) => Promise<{ id: string }> {
  switch (doc.kind) {
    case 'expense':
      return (tx) =>
        createExpense(tx, {
          vendorId: doc.vendorId,
          payeeName: doc.payeeName,
          date: toDate(doc.date),
          method: doc.type === 'check' ? 'check' : 'credit_card',
          reference: doc.ref,
          paymentAccountId: bank!,
          memo: doc.memo,
          isRefund: doc.type === 'cc_credit' ? true : undefined,
          lines: [{ accountId: doc.accountId, amount: doc.amount, description: doc.memo, classId: doc.classId }],
        });
    case 'deposit':
      return (tx) =>
        createDeposit(tx, {
          depositAccountId: bank!,
          date: toDate(doc.date),
          memo: doc.memo,
          extraLines: [{ accountId: doc.accountId, amount: doc.amount, description: doc.description }],
        });
    case 'invoice':
      return (tx) =>
        createInvoice(tx, {
          customerId: doc.customerId,
          refNumber: doc.ref,
          date: toDate(doc.date),
          memo: doc.memo,
          classId: doc.classId,
          lines: [{ accountId: doc.accountId, description: doc.memo, quantity: 1, rate: doc.amount, taxable: false, classId: doc.classId }],
        });
    case 'credit_memo':
      return (tx) =>
        createCreditMemo(tx, {
          customerId: doc.customerId,
          refNumber: doc.ref,
          date: toDate(doc.date),
          memo: doc.memo,
          lines: [{ accountId: doc.accountId, description: doc.memo, quantity: 1, rate: doc.amount, taxable: false }],
        });
    case 'bill':
      return (tx) =>
        createBill(tx, {
          vendorId: doc.vendorId,
          billNumber: doc.ref,
          date: toDate(doc.date),
          dueDate: doc.dueDate ? toDate(doc.dueDate) : null,
          memo: doc.memo,
          classId: doc.classId,
          lines: [{ accountId: doc.accountId, amount: doc.amount, description: doc.memo, classId: doc.classId }],
        });
    case 'bill_credit':
      return (tx) =>
        createVendorCredit(tx, {
          vendorId: doc.vendorId,
          refNumber: doc.ref,
          date: toDate(doc.date),
          memo: doc.memo,
          lines: [{ accountId: doc.accountId, amount: doc.amount, description: doc.memo, classId: doc.classId }],
        });
    case 'journal':
      return (tx) =>
        createManualEntry(tx, {
          date: toDate(doc.date),
          description: doc.description,
          reference: doc.reference,
          lines: doc.lines,
        });
  }
}

/** Resolve + structurally validate the rows into save jobs (no writes). */
function buildJobs(input: BatchEnterInput, lists: BatchLookupLists): Job[] {
  const resolved = resolveBatchRows(input, createBatchMatchers(lists));
  const bank = input.bankAccountId ?? null;
  return resolved.map((j) => ({
    rows: j.rows,
    errors: j.errors,
    warnings: j.warnings,
    run: j.doc && j.errors.length === 0 ? runnerFor(j.doc, bank) : undefined,
  }));
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : 'Could not save this row.';
}

const BATCH_ENTER_AREA: Record<BatchEnterType, Area> = {
  check: 'banking',
  deposit: 'banking',
  cc_charge: 'banking',
  cc_credit: 'banking',
  invoice: 'customers',
  credit_memo: 'customers',
  bill: 'vendors',
  bill_credit: 'vendors',
  journal: 'accounting',
};

export async function batchEnterTransactions(ctx: ServiceContext, input: BatchEnterInput): Promise<BatchEnterResult> {
  if (!BATCH_ENTER_TYPES.includes(input.type)) throw validation('Unknown transaction type.');
  // The route only guarantees accounting:create — each document type also needs its own area's
  // create right, so Batch Enter can never be a side door around Customers / Vendors / Banking.
  requirePermission(ctx, BATCH_ENTER_AREA[input.type], 'create');
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw validation('Enter at least one row.');
  if (input.rows.length > 1000) throw validation('Enter at most 1,000 rows per batch.');
  if (input.bankAccountId) {
    const [a] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.bankAccountId)));
    if (!a) throw notFound('Bank / credit card account');
  }

  const jobs = buildJobs(input, await loadLists(ctx));
  const results: BatchEnterRowResult[] = jobs.map((j) => ({ rows: j.rows, ok: j.errors.length === 0, errors: [...j.errors], warnings: [...j.warnings] }));
  const mode = input.mode ?? 'all';

  if (mode === 'row' && !input.validateOnly) {
    for (let k = 0; k < jobs.length; k++) {
      const job = jobs[k];
      if (!job.run) continue;
      try {
        const saved = await inTransaction(ctx, (tx) => job.run!(tx));
        results[k].id = saved.id;
      } catch (err) {
        results[k].ok = false;
        results[k].errors.push(`Row ${job.rows[0] + 1}: ${msg(err)}`);
      }
    }
    const saved = results.filter((r) => r.ok && r.id).length;
    return { saved, failed: results.filter((r) => !r.ok).length, rolledBack: false, results };
  }

  // 'all' mode / validateOnly: everything inside one transaction; any failure → roll back all.
  let rolledBack = false;
  try {
    await inTransaction(ctx, async (tx) => {
      for (let k = 0; k < jobs.length; k++) {
        const job = jobs[k];
        if (!job.run) continue;
        try {
          // Savepoint per row so one failure does not poison the rest of the validation pass.
          const saved = await inTransaction(tx, (inner) => job.run!(inner));
          results[k].id = saved.id;
        } catch (err) {
          results[k].ok = false;
          results[k].errors.push(`Row ${job.rows[0] + 1}: ${msg(err)}`);
        }
      }
      if (input.validateOnly || results.some((r) => !r.ok)) throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
    rolledBack = true;
    for (const r of results) delete r.id;
  }
  const failed = results.filter((r) => !r.ok).length;
  return { saved: rolledBack ? 0 : results.length, failed, rolledBack, results };
}
