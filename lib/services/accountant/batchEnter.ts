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
import { Money } from '@/lib/money';
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
import {
  BATCH_ENTER_TYPES,
  type BatchEnterRow,
  type BatchEnterType,
  normalizeAmount,
  normalizeDate,
} from './batchEnterParse';

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

interface Lookups {
  account: (s: string) => string | null;
  className: (s: string) => string | null;
  customer: (s: string) => string | null;
  vendor: (s: string) => string | null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function loadLookups(ctx: ServiceContext): Promise<Lookups> {
  const acct = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
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
  const byName = (rows: Array<{ id: string; name: string | null }>) => {
    const m = new Map<string, string | null>();
    for (const r of rows) {
      const k = norm(r.name ?? '');
      m.set(k, m.has(k) ? null : r.id); // ambiguous duplicate names resolve to null
    }
    return (s: string) => m.get(norm(s)) ?? null;
  };
  return {
    account: (s: string) => {
      const t = s.trim();
      const code = t.split(/\s*[·:\-–]\s+|\s+/)[0];
      return (
        acct.find((a) => a.code === t)?.id ??
        acct.find((a) => norm(a.name) === norm(t))?.id ??
        acct.find((a) => norm(`${a.code} · ${a.name}`) === norm(t) || norm(`${a.code} ${a.name}`) === norm(t))?.id ??
        acct.find((a) => a.code === code && t.length > code.length && norm(t).endsWith(norm(a.name)))?.id ??
        null
      );
    },
    className: byName(cls),
    customer: byName(cust),
    vendor: byName(vend),
  };
}

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

type Job = { rows: number[]; errors: string[]; run?: (tx: ServiceContext) => Promise<{ id: string }> };

/** Resolve + structurally validate the rows into save jobs (no writes). */
function buildJobs(input: BatchEnterInput, L: Lookups): Job[] {
  const jobs: Job[] = [];
  const t = input.type;
  const needsBank = t === 'check' || t === 'deposit' || t === 'cc_charge' || t === 'cc_credit';
  const bank = input.bankAccountId ?? null;

  if (t === 'journal') {
    // Consecutive rows with the same date + ref form one entry; a row with both blank continues
    // the entry above it (how split lines are usually pasted).
    const groups: Array<{ idx: number[]; key: string }> = [];
    input.rows.forEach((r, i) => {
      const date = r.date?.trim() ?? '';
      const ref = r.ref?.trim() ?? '';
      const key = `${date}|${ref}`;
      const last = groups[groups.length - 1];
      if (last && ((!date && !ref) || last.key === key)) last.idx.push(i);
      else groups.push({ idx: [i], key });
    });
    for (const g of groups) {
      const errors: string[] = [];
      const first = input.rows[g.idx[0]];
      const date = normalizeDate(first.date);
      if (!date) errors.push(`Row ${g.idx[0] + 1}: date "${first.date ?? ''}" is not a valid date.`);
      const lines = g.idx.map((i) => {
        const r = input.rows[i];
        const accountId = r.account ? L.account(r.account) : null;
        if (!accountId) errors.push(`Row ${i + 1}: account "${r.account ?? ''}" was not found.`);
        const debit = normalizeAmount(r.debit);
        const credit = normalizeAmount(r.credit);
        if (r.debit && debit === null) errors.push(`Row ${i + 1}: debit "${r.debit}" is not a number.`);
        if (r.credit && credit === null) errors.push(`Row ${i + 1}: credit "${r.credit}" is not a number.`);
        if (!debit && !credit) errors.push(`Row ${i + 1}: enter a debit or a credit.`);
        const classId = r.className ? L.className(r.className) : null;
        if (r.className && !classId) errors.push(`Row ${i + 1}: class "${r.className}" was not found.`);
        return { accountId: accountId ?? '', debit: debit ?? null, credit: credit ?? null, memo: r.memo || r.name || null, classId };
      });
      if (g.idx.length < 2) errors.push(`Row ${g.idx[0] + 1}: a journal entry needs at least two rows (use the same Ref on each row).`);
      const td = lines.reduce((s, l) => s.plus(Money.of(l.debit ?? 0)), Money.zero());
      const tc = lines.reduce((s, l) => s.plus(Money.of(l.credit ?? 0)), Money.zero());
      if (errors.length === 0 && !td.equals(tc)) {
        errors.push(`Rows ${g.idx[0] + 1}–${g.idx[g.idx.length - 1] + 1}: debits (${td.toFixed(2)}) and credits (${tc.toFixed(2)}) must be equal.`);
      }
      jobs.push({
        rows: g.idx,
        errors,
        run: errors.length
          ? undefined
          : async (tx) =>
              createManualEntry(tx, {
                date: toDate(date!),
                description: first.memo?.trim() || `Batch journal entry${first.ref ? ` ${first.ref}` : ''}`,
                reference: first.ref?.trim() || null,
                lines,
              }),
      });
    }
    return jobs;
  }

  input.rows.forEach((r, i) => {
    const errors: string[] = [];
    const n = `Row ${i + 1}`;
    const date = normalizeDate(r.date);
    if (!date) errors.push(`${n}: date "${r.date ?? ''}" is not a valid date.`);
    const accountId = r.account ? L.account(r.account) : null;
    if (!accountId) errors.push(`${n}: account "${r.account ?? ''}" was not found.`);
    const amount = normalizeAmount(r.amount);
    if (amount === null) errors.push(`${n}: amount "${r.amount ?? ''}" is not a number.`);
    else if (!Money.gt(amount, 0)) errors.push(`${n}: amount must be greater than zero.`);
    const classId = r.className ? L.className(r.className) : null;
    if (r.className && !classId) errors.push(`${n}: class "${r.className}" was not found.`);
    if (needsBank && !bank) errors.push(`${n}: choose the ${t.startsWith('cc') ? 'credit card' : 'bank'} account first.`);
    let customerId: string | null = null;
    let vendorId: string | null = null;
    if (t === 'invoice' || t === 'credit_memo') {
      customerId = r.name ? L.customer(r.name) : null;
      if (!customerId) errors.push(`${n}: customer "${r.name ?? ''}" was not found (add it to the customer list first).`);
    } else if (t === 'bill' || t === 'bill_credit') {
      vendorId = r.name ? L.vendor(r.name) : null;
      if (!vendorId) errors.push(`${n}: vendor "${r.name ?? ''}" was not found (add it to the vendor list first).`);
    } else if (t === 'check' || t === 'cc_charge' || t === 'cc_credit') {
      vendorId = r.name ? L.vendor(r.name) : null;
      if (!r.name?.trim()) errors.push(`${n}: enter a payee name.`);
    }
    let dueDate: string | null = null;
    if (t === 'bill' && r.dueDate) {
      dueDate = normalizeDate(r.dueDate);
      if (!dueDate) errors.push(`${n}: due date "${r.dueDate}" is not a valid date.`);
    }
    if (errors.length) {
      jobs.push({ rows: [i], errors });
      return;
    }
    const d = toDate(date!);
    const memo = r.memo?.trim() || null;
    let run: Job['run'];
    switch (t) {
      case 'check':
      case 'cc_charge':
      case 'cc_credit':
        run = (tx) =>
          createExpense(tx, {
            vendorId,
            payeeName: vendorId ? null : r.name!.trim(),
            date: d,
            method: t === 'check' ? 'check' : 'credit_card',
            reference: r.ref?.trim() || null,
            paymentAccountId: bank!,
            memo,
            isRefund: t === 'cc_credit' ? true : undefined,
            lines: [{ accountId: accountId!, amount: amount!, description: memo, classId }],
          });
        break;
      case 'deposit':
        run = (tx) =>
          createDeposit(tx, {
            depositAccountId: bank!,
            date: d,
            memo,
            extraLines: [
              {
                accountId: accountId!,
                amount: amount!,
                description: [r.name?.trim(), memo].filter(Boolean).join(' — ') || null,
              },
            ],
          });
        break;
      case 'invoice':
        run = (tx) =>
          createInvoice(tx, {
            customerId: customerId!,
            date: d,
            memo,
            classId,
            lines: [{ accountId, description: memo, quantity: 1, rate: amount!, taxable: false, classId }],
          });
        break;
      case 'credit_memo':
        run = (tx) =>
          createCreditMemo(tx, {
            customerId: customerId!,
            date: d,
            memo,
            lines: [{ accountId, description: memo, quantity: 1, rate: amount!, taxable: false }],
          });
        break;
      case 'bill':
        run = (tx) =>
          createBill(tx, {
            vendorId: vendorId!,
            billNumber: r.ref?.trim() || null,
            date: d,
            dueDate: dueDate ? toDate(dueDate) : null,
            memo,
            classId,
            lines: [{ accountId, amount: amount!, description: memo, classId }],
          });
        break;
      case 'bill_credit':
        run = (tx) =>
          createVendorCredit(tx, {
            vendorId: vendorId!,
            date: d,
            memo,
            lines: [{ accountId: accountId!, amount: amount!, description: memo }],
          });
        break;
    }
    jobs.push({ rows: [i], errors, run: run as Job['run'] });
  });
  return jobs;
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

  const L = await loadLookups(ctx);
  const jobs = buildJobs(input, L);
  const results: BatchEnterRowResult[] = jobs.map((j) => ({ rows: j.rows, ok: j.errors.length === 0, errors: [...j.errors] }));
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
