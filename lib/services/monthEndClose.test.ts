/**
 * Guided month-end close (lib/services/monthEndClose.ts): step computations from seeded data
 * (unreconciled accounts, uncategorized bank feed items and accounts, Undeposited Funds aging,
 * A/R and A/P tie-outs, payroll, error scan), persistence of the review progress (per company +
 * period, record locking, audit), the permission-gated close that sets the closing date, and the
 * PDF report pack containing every report.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { PDFDocument } from 'pdf-lib';
import {
  accounts,
  auditLogs,
  bankTransactions,
  companies,
  journalEntries,
  journalEntryLines,
  monthEndCloses,
} from '@/lib/db/schema';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';
import type { ServiceContext } from './_base';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';
import { createAccount } from './accounts';
import { createBankAccount } from './bankAccounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { postJournalEntry } from './posting';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared } from './reconcile';
import { createCompany, verifyClosingDatePassword } from './company';
import { createDeposit } from './deposits';
import { trialBalance } from './reports';
import {
  MONTH_END_STEP_KEYS,
  RECON_NO_ACCESS,
  buildMonthEndReportPack,
  closeMonth,
  getMonthEndChecklist,
  isUncategorizedAccount,
  listMonthEndCloses,
  parsePeriodEnd,
  runMonthEndErrorScan,
  updateMonthEndStep,
  type MonthEndChecklist,
} from './monthEndClose';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import * as reportPackRoute from '@/app/api/month-end-close/report-pack/route';
import * as closeRoute from '@/app/api/month-end-close/close/route';
import * as checklistRoute from '@/app/api/month-end-close/route';
import * as stepsRoute from '@/app/api/month-end-close/steps/route';

function jsonReq(url: string, method: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const PERIOD = '2026-03-31';
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let t: TestCompany;
let ctx: ServiceContext;
let checkingBankId: string;
let uncategorizedId: string;
let customerId: string;

function roleCtx(key: string): ServiceContext {
  return { ...ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)) };
}
/** A custom role with exactly these grants. */
function customCtx(permissions: Record<string, ('view' | 'create' | 'modify' | 'delete' | 'print')[]>): ServiceContext {
  return { ...ctx, access: unionRoles([{ key: 'custom', name: 'Custom', description: '', builtin: false, permissions, flags: {} }]) };
}
const stepOf = (c: MonthEndChecklist, key: string) => c.steps.find((s) => s.key === key)!;

/** All text drawn on the pages of a pdf-lib PDF (inflated content streams, hex/literal strings). */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      content = m[1];
    }
    for (const x of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(x[1], 'hex').toString('latin1'));
    for (const x of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(x[1]);
  }
  return out.join('\n');
}

beforeAll(async () => {
  t = await makeTestCompany('monthend');
  ctx = t.ctx;
  routeCtx = ctx;
});

afterAll(async () => {
  await t.cleanup();
});

describe('month-end close: step computations', () => {
  it('validates the period end', () => {
    expect(parsePeriodEnd('2026-03-31')).toBe('2026-03-31');
    expect(() => parsePeriodEnd('2026-02-30')).toThrow(/not a real date/);
    expect(() => parsePeriodEnd('03/31/2026')).toThrow();
    expect(isUncategorizedAccount({ code: '6999', name: 'Uncategorized Expense' })).toBe(true);
    expect(isUncategorizedAccount({ code: 'QB-SUSPENSE', name: 'QB Import Suspense' })).toBe(true);
    expect(isUncategorizedAccount({ code: '6300', name: 'Office Supplies' })).toBe(false);
  });

  it('an empty company: nothing to reconcile, everything ties, payroll skipped, scan not yet run', async () => {
    const c = await getMonthEndChecklist(ctx, PERIOD);
    expect(c.steps.map((s) => s.key)).toEqual(MONTH_END_STEP_KEYS);
    expect(stepOf(c, 'reconcile').status).toBe('skipped');
    expect(stepOf(c, 'bank_feed').status).toBe('skipped');
    expect(stepOf(c, 'bank_feed').statusReason).toMatch(/not downloaded/);
    expect(stepOf(c, 'uncategorized').status).toBe('done');
    expect(stepOf(c, 'undeposited').status).toBe('done');
    expect(stepOf(c, 'receivables').status).toBe('done');
    expect(stepOf(c, 'payables').status).toBe('done');
    expect(stepOf(c, 'payroll').status).toBe('skipped');
    expect(stepOf(c, 'error_scan').status).toBe('attention'); // the scan was never run
    expect(stepOf(c, 'open_items').status).toBe('done');
    expect(c.outstanding).toEqual(['error_scan']);
    expect(c.ready).toBe(false);
    expect(c.version).toBeNull(); // reading never writes
    expect(c.canClose).toBe(true); // owner
  });

  it('seeded data: unreconciled accounts, uncategorized feed items and accounts, aged deposits, tie-outs', async () => {
    const a = t.acct;
    checkingBankId = (await createBankAccount(ctx, { accountId: a['1000'], bankName: 'First Bank', accountNumber: '123456789' })).id;
    await postJournalEntry(ctx, {
      date: d('2026-03-02'),
      description: 'Owner investment',
      lines: [
        { accountId: a['1000'], debit: '1000.00' },
        { accountId: a['3000'], credit: '1000.00' },
      ],
    });
    uncategorizedId = (await createAccount(ctx, { code: '6999', name: 'Uncategorized Expense', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    await createAccount(ctx, { code: '6998', name: 'Ask My Accountant', type: 'expense' as never, subtype: 'operating_expenses' });
    await postJournalEntry(ctx, {
      date: d('2026-03-10'),
      description: 'Card swipe, unknown',
      lines: [
        { accountId: uncategorizedId, debit: '50.00' },
        { accountId: a['1000'], credit: '50.00' },
      ],
    });
    // Credit card used, but never set up for reconciling.
    await postJournalEntry(ctx, {
      date: d('2026-03-12'),
      description: 'Office supplies on the card',
      lines: [
        { accountId: a['6300'], debit: '80.00' },
        { accountId: a['2100'], credit: '80.00' },
      ],
    });
    // Bank feed: one waiting, one excluded, one matched, one after the period end.
    await t.db.insert(bankTransactions).values([
      { companyId: ctx.companyId, bankAccountId: checkingBankId, date: d('2026-03-20'), description: 'COFFEE', amount: '-12.50' },
      { companyId: ctx.companyId, bankAccountId: checkingBankId, date: d('2026-03-21'), description: 'DUP', amount: '-9.00', excluded: true },
      { companyId: ctx.companyId, bankAccountId: checkingBankId, date: d('2026-03-22'), description: 'MATCHED', amount: '-1.00', matched: true },
      { companyId: ctx.companyId, bankAccountId: checkingBankId, date: d('2026-04-05'), description: 'APRIL', amount: '-3.00' },
    ]);
    // A/R: an invoice, paid into Undeposited Funds 29 days before the period end.
    customerId = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
    const inv = await createInvoice(ctx, { customerId, date: d('2026-03-01'), dueDate: d('2026-03-31'), lines: [{ description: 'Work', quantity: 1, rate: '500' }] });
    await receivePayment(ctx, { customerId, date: d('2026-03-02'), method: 'check', amount: '200', applications: [{ invoiceId: inv.id, amountApplied: '200' }] });
    // A/P: one open bill.
    const vendorId = (await createVendor(ctx, { displayName: 'Paper Co' })).id;
    await createBill(ctx, { vendorId, billNumber: 'P-1', date: d('2026-03-05'), dueDate: d('2026-04-05'), lines: [{ accountId: a['6300'], description: 'Paper', amount: '120.00' }] });

    const c = await getMonthEndChecklist(ctx, PERIOD);

    const rec = stepOf(c, 'reconcile');
    expect(rec.status).toBe('attention');
    const checkingRow = rec.rows.find((r) => r.label.includes('Checking'))!;
    expect(checkingRow.status).toBe('attention');
    expect(checkingRow.detail).toMatch(/Never reconciled/);
    expect(checkingRow.href).toBe(`/reconcile?bankAccountId=${checkingBankId}&statementDate=${PERIOD}`);
    const cardRow = rec.rows.find((r) => r.label.includes('Credit Card'))!;
    expect(cardRow.status).toBe('attention');
    expect(cardRow.detail).toMatch(/not set up for reconciling/);
    expect(rec.rows.find((r) => r.label.includes('Savings'))).toBeUndefined(); // no activity, not listed

    const feed = stepOf(c, 'bank_feed');
    expect(feed.status).toBe('attention');
    expect(feed.summary).toMatch(/^1 downloaded transaction/);
    expect(feed.rows[0].amount).toBe('12.50');

    const unc = stepOf(c, 'uncategorized');
    expect(unc.status).toBe('attention');
    expect(unc.rows).toHaveLength(1); // Ask My Accountant has no balance
    expect(unc.rows[0].label).toBe('6999 · Uncategorized Expense');
    expect(unc.rows[0].amount).toBe('50.00');

    const uf = stepOf(c, 'undeposited');
    expect(uf.status).toBe('attention');
    expect(uf.rows[0].amount).toBe('200.00');
    expect(uf.rows[0].detail).toMatch(/29 days old/);
    expect(uf.figures.find((f) => f.label === '8 - 30 days')!.value).toBe('200.00');
    expect(uf.figures.find((f) => f.label.startsWith('Undeposited Funds balance'))!.value).toBe('200.00');

    const ar = stepOf(c, 'receivables');
    expect(ar.status).toBe('done');
    expect(ar.figures.find((f) => f.label === 'Aging total')!.value).toBe('300.00');
    expect(ar.figures.find((f) => f.label === 'Accounts Receivable account balance')!.value).toBe('300.00');
    const ap = stepOf(c, 'payables');
    expect(ap.status).toBe('done');
    expect(ap.figures.find((f) => f.label === 'Aging total')!.value).toBe('120.00');

    // Something dated after the period end does not count.
    const april = await getMonthEndChecklist(ctx, '2026-02-28');
    expect(stepOf(april, 'uncategorized').status).toBe('done');
    expect(stepOf(april, 'receivables').figures.find((f) => f.label === 'Aging total')!.value).toBe('0.00');
  });

  it('A/R or A/P aging that does not tie to the control account needs attention', async () => {
    // The posting layer refuses unnamed A/R / A/P lines, so a mismatch only comes from legacy or
    // imported data: simulate one in a second company with a raw (balanced) ledger insert.
    const legacy = await createCompany(t.db, { name: 'Legacy Co', ownerId: ctx.userId! });
    const lctx: ServiceContext = { db: t.db, companyId: legacy.id, userId: ctx.userId };
    const la = Object.fromEntries(
      (await t.db.select().from(accounts).where(eq(accounts.companyId, legacy.id))).map((r) => [r.code, r.id]),
    );
    await t.db.transaction(async (tx) => {
      const [je] = await tx
        .insert(journalEntries)
        .values({ companyId: legacy.id, entryNumber: 1, date: d('2026-03-25'), description: 'Imported opening A/R', status: 'posted', createdBy: ctx.userId! })
        .returning();
      await tx.insert(journalEntryLines).values([
        { journalEntryId: je.id, accountId: la['1200'], debit: '75.00' },
        { journalEntryId: je.id, accountId: la['2000'], credit: '75.00' },
      ]);
    });
    const c = await getMonthEndChecklist(lctx, PERIOD);
    const ar = stepOf(c, 'receivables');
    expect(ar.status).toBe('attention');
    expect(ar.summary).toMatch(/does not match/);
    expect(ar.rows[0].amount).toBe('75.00');
    expect(ar.figures.find((f) => f.label === 'Aging total')!.value).toBe('0.00');
    expect(ar.figures.find((f) => f.label === 'Accounts Receivable account balance')!.value).toBe('75.00');
    const ap = stepOf(c, 'payables');
    expect(ap.status).toBe('attention');
    expect(ap.figures.find((f) => f.label === 'Accounts Payable account balance')!.value).toBe('75.00');
    // The first company is untouched: its aging still ties.
    expect(stepOf(await getMonthEndChecklist(ctx, PERIOD), 'receivables').status).toBe('done');
  });

  it('Undeposited Funds is aged as of the period end and ties to the account balance', async () => {
    const co = await createCompany(t.db, { name: 'Deposits Co', ownerId: ctx.userId! });
    const dctx: ServiceContext = { db: t.db, companyId: co.id, userId: ctx.userId };
    const da = Object.fromEntries(
      (await t.db.select().from(accounts).where(eq(accounts.companyId, co.id))).map((r) => [r.code, r.id]),
    );
    const cust = (await createCustomer(dctx, { displayName: 'Late Deposit LLC' })).id;
    const inv = await createInvoice(dctx, { customerId: cust, date: d('2026-03-01'), dueDate: d('2026-03-31'), lines: [{ description: 'Work', quantity: 1, rate: '400' }] });
    // Received Mar 20 into Undeposited Funds, deposited Apr 2: still waiting on Mar 31.
    const pmt = await receivePayment(dctx, { customerId: cust, date: d('2026-03-20'), method: 'check', amount: '400', applications: [{ invoiceId: inv.id, amountApplied: '400' }] });
    await createDeposit(dctx, { depositAccountId: da['1000'], date: d('2026-04-02'), paymentIds: [pmt.payment.id] });

    const march = stepOf(await getMonthEndChecklist(dctx, PERIOD), 'undeposited');
    expect(march.status).toBe('attention'); // 11 days old on Mar 31
    expect(march.rows).toHaveLength(1);
    expect(march.rows[0].label).toMatch(/^Late Deposit LLC: payment of Mar 20, 2026/);
    expect(march.rows[0].detail).toMatch(/11 days old/);
    expect(march.figures.find((f) => f.label === '8 - 30 days')!.value).toBe('400.00');
    expect(march.figures.find((f) => f.label.startsWith('Undeposited Funds balance'))!.value).toBe('400.00');
    expect(march.summary).not.toMatch(/do not match/);
    // By April's end it was deposited: nothing waiting, and still tied.
    const april = stepOf(await getMonthEndChecklist(dctx, '2026-04-30'), 'undeposited');
    expect(april.status).toBe('done');
    expect(april.rows).toEqual([]);
    expect(april.figures.find((f) => f.label.startsWith('Undeposited Funds balance'))!.value).toBe('0.00');

    // Money put into Undeposited Funds outside a payment / sales receipt breaks the tie-out.
    await postJournalEntry(dctx, {
      date: d('2026-04-10'),
      description: 'Cash moved to UF by hand',
      lines: [
        { accountId: da['1050'], debit: '30.00' },
        { accountId: da['1000'], credit: '30.00' },
      ],
    });
    const off = stepOf(await getMonthEndChecklist(dctx, '2026-04-30'), 'undeposited');
    expect(off.status).toBe('attention');
    expect(off.summary).toMatch(/do not match the Undeposited Funds account \(30\.00\)/);
    expect(off.rows[0].label).toMatch(/does not tie/);
    expect(off.rows[0].amount).toBe('30.00');
    expect(off.rows[0].href).toBe(`/registers/${da['1050']}`);
  });

  it('a completed reconciliation through the period end marks the account done', async () => {
    const recon = await startReconciliation(ctx, { bankAccountId: checkingBankId, statementDate: d(PERIOD), statementBalance: '950.00' });
    const lines = await listClearable(ctx, checkingBankId, new Date(`${PERIOD}T23:59:59.999Z`), recon.id);
    for (const l of lines) await toggleCleared(ctx, recon.id, l.journalEntryLineId, true);
    await completeReconciliation(ctx, recon.id);
    const c = await getMonthEndChecklist(ctx, PERIOD);
    const rec = stepOf(c, 'reconcile');
    expect(rec.rows.find((r) => r.label.includes('Checking'))!.status).toBe('done');
    expect(rec.status).toBe('attention'); // the credit card is still not set up
    expect(rec.summary).toMatch(/1 of 2 accounts reconciled/);
  });

  it('the error scan step shows Verify Data and is done once the scan ran clean', async () => {
    const before = stepOf(await getMonthEndChecklist(ctx, PERIOD), 'error_scan');
    expect(before.rows.some((r) => r.label.startsWith('Verify Data'))).toBe(true);
    expect(before.summary).toMatch(/Run the error scan/);
    const res = await runMonthEndErrorScan(ctx, { periodEnd: PERIOD });
    expect(res.checklist.scanRanAt).not.toBeNull();
    const step = stepOf(res.checklist, 'error_scan');
    expect(step.summary).not.toMatch(/Run the error scan/);
    expect(step.status).toBe(res.found ? 'attention' : 'done');
    expect(res.checklist.version).not.toBeNull();
  });
});

describe('month-end close: step visibility follows permissions', () => {
  it('people without payroll access get the payroll step skipped; without File Utilities, no Verify Data rows', async () => {
    for (const role of ['bookkeeper', 'banking']) {
      const c = await getMonthEndChecklist(roleCtx(role), PERIOD);
      const payroll = stepOf(c, 'payroll');
      expect(payroll.status).toBe('skipped');
      expect(payroll.statusReason).toMatch(/do not have access to payroll/);
      expect(payroll.figures).toEqual([]);
      const scan = stepOf(c, 'error_scan');
      expect(scan.rows.some((r) => r.label.startsWith('Verify Data'))).toBe(false);
      expect(scan.figures.some((f) => f.label === 'Verify Data')).toBe(false);
      expect(scan.figures.some((f) => f.label === 'Open possible errors')).toBe(true);
    }
    // Banking has no Customers & Sales / Vendors & Purchases reports: aging tie-out figures only,
    // no per-customer or per-vendor rows and no link to the aging reports.
    const banking = await getMonthEndChecklist(roleCtx('banking'), PERIOD);
    for (const key of ['receivables', 'payables']) {
      const step = stepOf(banking, key);
      expect(step.status, key).toBe('done');
      expect(step.rows, key).toEqual([]);
      expect(step.action, key).toBeNull();
      expect(step.figures.find((f) => f.label === 'Aging total'), key).toBeDefined();
      expect(step.figures.some((f) => f.label.endsWith('account balance')), key).toBe(true);
    }
    expect(stepOf(banking, 'receivables').figures.find((f) => f.label === 'Aging total')!.value).toBe('300.00');
    expect(JSON.stringify(stepOf(banking, 'receivables'))).not.toContain('Acme Corp');
    expect(JSON.stringify(stepOf(banking, 'payables'))).not.toContain('Paper Co');
    // Banking makes deposits, so it sees who the waiting payments are from ...
    expect(stepOf(banking, 'undeposited').rows[0].label).toMatch(/^Acme Corp: payment/);
    // ... a role without Banking sees the amounts only.
    const noBanking = await getMonthEndChecklist(customCtx({ accounting: ['view'] }), PERIOD);
    const ufRow = stepOf(noBanking, 'undeposited').rows[0];
    expect(ufRow.label).toBe('Payment of Mar 2, 2026');
    expect(ufRow.amount).toBe('200.00');
    expect(stepOf(noBanking, 'receivables').rows).toEqual([]);
    // The owner still sees the names, Verify Data and a payroll reason that is not about access.
    const own = await getMonthEndChecklist(ctx, PERIOD);
    expect(stepOf(own, 'receivables').rows.map((r) => r.label)).toContain('Acme Corp');
    expect(stepOf(own, 'payables').rows.map((r) => r.label)).toContain('Paper Co');
    expect(stepOf(own, 'receivables').action?.href).toMatch(/ar-aging-summary/);
    expect(stepOf(own, 'error_scan').rows.some((r) => r.label.startsWith('Verify Data'))).toBe(true);
    expect(stepOf(own, 'payroll').statusReason ?? '').not.toMatch(/access to payroll/);
  });
});

describe('month-end close: saved progress', () => {
  it('a malformed version is a 400 (validation), not a crash', async () => {
    await expect(
      updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'review', version: 'garbage' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const patch = await stepsRoute.PATCH(
      jsonReq('/api/month-end-close/steps', 'PATCH', { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'review', version: 'garbage' }),
    );
    expect(patch.status).toBe(400);
    const close = await closeRoute.POST(jsonReq('/api/month-end-close/close', 'POST', { periodEnd: PERIOD, version: 'garbage' }));
    expect(close.status).toBe(400);
    // Nothing was saved by the refused calls.
    const c = await getMonthEndChecklist(ctx, PERIOD);
    expect(stepOf(c, 'bank_feed').reviewed).toBe(false);
  });

  it('is stored by migration 0051 (registered as idx 51, safe to re-run)', async () => {
    const j = JSON.parse(fs.readFileSync(path.resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(j.entries.filter((e) => e.tag === '0051_monthend')).toEqual([
      { idx: 51, version: '7', when: 1781400051000, tag: '0051_monthend', breakpoints: true },
    ]);
    const file = fs.readFileSync(path.resolve('drizzle/0051_monthend.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) if (stmt.trim()) await t.db.execute(sql.raw(stmt));
    // One row per company + period.
    await expect(
      t.db.insert(monthEndCloses).values([
        { companyId: ctx.companyId, periodEnd: '2025-01-31' },
        { companyId: ctx.companyId, periodEnd: '2025-01-31' },
      ]),
    ).rejects.toThrow();
  });

  it('marks a step reviewed with a note and keeps it per company + period', async () => {
    const start = await getMonthEndChecklist(ctx, PERIOD);
    const c = await updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'uncategorized', action: 'review', note: 'Owner says it is a meal; reclass next month', version: start.version });
    const s = stepOf(c, 'uncategorized');
    expect(s.reviewed).toBe(true);
    expect(s.status).toBe('attention'); // the books still say so
    expect(s.resolved).toBe(true);
    expect(s.note).toMatch(/meal/);
    expect(s.reviewedByName).toBe('monthend owner');
    // Survives a reload, other periods unaffected.
    expect(stepOf(await getMonthEndChecklist(ctx, PERIOD), 'uncategorized').reviewed).toBe(true);
    expect(stepOf(await getMonthEndChecklist(ctx, '2026-02-28'), 'uncategorized').reviewed).toBe(false);
    const [row] = await t.db
      .select()
      .from(monthEndCloses)
      .where(and(eq(monthEndCloses.companyId, ctx.companyId), eq(monthEndCloses.periodEnd, PERIOD)));
    expect(row.steps.uncategorized.reviewed).toBe(true);
    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'month_end_close')));
    expect(audits.length).toBeGreaterThanOrEqual(2); // scan + review
  });

  it('skips need a reason; unknown steps and stale versions are refused; un-review / un-skip work', async () => {
    await expect(updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'skip', reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'nope', action: 'review' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'review', version: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { staleVersion: true } });

    let c = await updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'skip', reason: 'Feed is a duplicate of the March statement' });
    expect(stepOf(c, 'bank_feed').status).toBe('skipped');
    expect(stepOf(c, 'bank_feed').computedStatus).toBe('attention');
    expect(stepOf(c, 'bank_feed').statusReason).toBe('Feed is a duplicate of the March statement');
    expect(stepOf(c, 'bank_feed').skippedByUser).toBe(true);
    c = await updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'unskip' });
    expect(stepOf(c, 'bank_feed').status).toBe('attention');
    c = await updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'uncategorized', action: 'unreview' });
    expect(stepOf(c, 'uncategorized').reviewed).toBe(false);
    expect(c.outstanding).toContain('uncategorized');
  });

  it('view-only members can read the checklist but not change it', async () => {
    const viewer = await addMember(t, 'viewer');
    const c = await getMonthEndChecklist(viewer, PERIOD);
    expect(c.canClose).toBe(false);
    await expect(updateMonthEndStep(viewer, { periodEnd: PERIOD, stepKey: 'bank_feed', action: 'review' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists the periods worked on', async () => {
    const h = await listMonthEndCloses(ctx);
    expect(h.map((r) => r.periodEnd)).toContain(PERIOD);
    expect(h.find((r) => r.periodEnd === PERIOD)!.status).toBe('open');
  });
});

describe('month-end close: closing the books', () => {
  it('is permission-gated: people without Closing Date / Periods: modify cannot close', async () => {
    const bookkeeper = roleCtx('bookkeeper');
    expect((await getMonthEndChecklist(bookkeeper, PERIOD)).canClose).toBe(false);
    await expect(closeMonth(bookkeeper, { periodEnd: PERIOD })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // ... and through the API the refusal is a 403.
    routeCtx = bookkeeper;
    const res = await closeRoute.POST(
      new NextRequest('http://localhost/api/month-end-close/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periodEnd: PERIOD }),
      }),
    );
    routeCtx = ctx;
    expect(res.status).toBe(403);
    // The route map sends the close to the closing area and everything else to accounting / reports.
    expect(apiRuleFor('/api/month-end-close/close', 'POST')).toEqual({ area: 'closing', action: 'modify' });
    expect(apiRuleFor('/api/month-end-close', 'GET')).toEqual({ area: 'accounting', action: 'view' });
    expect(apiRuleFor('/api/month-end-close/steps', 'PATCH')).toEqual({ area: 'accounting', action: 'modify' });
    expect(apiRuleFor('/api/month-end-close/scan', 'POST')).toEqual({ area: 'accounting', action: 'create' });
    expect(apiRuleFor('/api/month-end-close/report-pack', 'GET')).toEqual({ area: 'reports_financial', action: 'print' });
    expect(pageAreasFor('/month-end')).toEqual(['accounting']);
    const [co] = await t.db.select().from(companies).where(eq(companies.id, ctx.companyId));
    expect((co.settings as Record<string, unknown> | null)?.closingDate).toBeUndefined();
  });

  it('refuses while required steps are open, and for a period that has not ended', async () => {
    await expect(closeMonth(ctx, { periodEnd: PERIOD })).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { outstanding: expect.arrayContaining(['reconcile', 'bank_feed', 'uncategorized', 'undeposited']) },
    });
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await expect(closeMonth(ctx, { periodEnd: future })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a period is over only after its last LOCAL day: no early close in the evening west of UTC', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 8 pm on Mar 30 in Los Angeles: already Mar 31 in UTC, but March is not over.
      vi.setSystemTime(new Date('2026-03-31T03:00:00.000Z'));
      await expect(closeMonth(ctx, { periodEnd: PERIOD })).rejects.toThrow(/has not happened yet/);
      // 8 pm on Mar 31 local (Apr 1 UTC): the last day itself is still running.
      vi.setSystemTime(new Date('2026-04-01T03:00:00.000Z'));
      await expect(closeMonth(ctx, { periodEnd: PERIOD })).rejects.toThrow(/is not over yet/);
      // Local Apr 1: past the date check (now it is the open steps that stop the close).
      vi.setSystemTime(new Date('2026-04-01T08:00:00.000Z'));
      await expect(closeMonth(ctx, { periodEnd: PERIOD })).rejects.toThrow(/Finish, review or skip/);
    } finally {
      vi.useRealTimers();
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('sets the closing date (with the closing-date password) once every step is resolved', async () => {
    let c = await getMonthEndChecklist(ctx, PERIOD);
    for (const key of c.outstanding) {
      c = await updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: key, action: 'review', note: `Checked ${key}`, version: c.version });
    }
    expect(c.ready).toBe(true);

    // A step un-reviewed by someone else after the readiness check but before the close's
    // transaction (simulated by flipping it right as the transaction starts, keeping the version)
    // must still block the close.
    const [rowBefore] = await t.db
      .select()
      .from(monthEndCloses)
      .where(and(eq(monthEndCloses.companyId, ctx.companyId), eq(monthEndCloses.periodEnd, PERIOD)));
    const flipKey = c.steps.find((s) => s.reviewed && !s.optional && s.computedStatus === 'attention')!.key;
    const flipped = { ...(rowBefore.steps as Record<string, Record<string, unknown>>) };
    flipped[flipKey] = { ...flipped[flipKey], reviewed: false };
    const realDb = ctx.db;
    const racingDb = new Proxy(realDb, {
      get(target, prop) {
        if (prop === 'transaction') {
          return async (fn: Parameters<typeof realDb.transaction>[0]) => {
            await target.update(monthEndCloses).set({ steps: flipped, updatedAt: rowBefore.updatedAt }).where(eq(monthEndCloses.id, rowBefore.id));
            return target.transaction(fn);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(closeMonth({ ...ctx, db: racingDb }, { periodEnd: PERIOD })).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { outstanding: [flipKey] },
    });
    await t.db.update(monthEndCloses).set({ steps: rowBefore.steps, updatedAt: rowBefore.updatedAt }).where(eq(monthEndCloses.id, rowBefore.id));
    const [co0] = await t.db.select().from(companies).where(eq(companies.id, ctx.companyId));
    expect((co0.settings as Record<string, unknown> | null)?.closingDate).toBeUndefined();

    // The close version check: a stale screen is refused.
    await expect(closeMonth(ctx, { periodEnd: PERIOD, password: 'march-secret', version: '2020-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const res = await closeMonth(ctx, { periodEnd: PERIOD, password: 'march-secret', version: c.version });
    expect(res.closingDate).toBe(PERIOD);
    expect(res.hasPassword).toBe(true);
    expect(res.checklist.status).toBe('closed');
    expect(res.checklist.closedByName).toBe('monthend owner');
    expect(res.checklist.closingDate).toBe(PERIOD);
    expect(await verifyClosingDatePassword(t.db, ctx.companyId, 'march-secret')).toBe(true);
    expect(await verifyClosingDatePassword(t.db, ctx.companyId, 'wrong')).toBe(false);

    // The closing date now protects March: postings dated in it are refused.
    await expect(
      postJournalEntry(ctx, {
        date: d('2026-03-15'),
        description: 'Late entry',
        lines: [
          { accountId: t.acct['6300'], debit: '1.00' },
          { accountId: t.acct['1000'], credit: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });

    // A closed month's checklist is read-only; an earlier period cannot move the date backwards.
    await expect(updateMonthEndStep(ctx, { periodEnd: PERIOD, stepKey: 'payroll', action: 'review' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(closeMonth(ctx, { periodEnd: '2026-02-28' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await listMonthEndCloses(ctx)).find((r) => r.periodEnd === PERIOD)!.status).toBe('closed');

    const audits = await t.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'company')));
    expect(audits.some((a) => (a.newValues as { closingDate?: string } | null)?.closingDate === PERIOD)).toBe(true);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('closing again keeps the existing password when none is given', async () => {
    const res = await closeMonth(ctx, { periodEnd: PERIOD });
    expect(res.closingDate).toBe(PERIOD);
    expect(res.hasPassword).toBe(true);
    expect(await verifyClosingDatePassword(t.db, ctx.companyId, 'march-secret')).toBe(true);
  });

  it('the error scan cannot be re-run for a closed period', async () => {
    const where = and(eq(monthEndCloses.companyId, ctx.companyId), eq(monthEndCloses.periodEnd, PERIOD));
    const [before] = await t.db.select().from(monthEndCloses).where(where);
    await expect(runMonthEndErrorScan(ctx, { periodEnd: PERIOD })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [after] = await t.db.select().from(monthEndCloses).where(where);
    expect(after.scanRanAt?.toISOString()).toBe(before.scanRanAt?.toISOString());
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
});

describe('month-end close: report pack', () => {
  const TITLES = [
    'Month-End Report Pack',
    'Profit & Loss',
    'Balance Sheet',
    'Trial Balance',
    'A/R Aging Summary',
    'A/P Aging Summary',
    'Reconciliation Summary',
  ];

  it('is one PDF containing the P&L, Balance Sheet, Trial Balance, both aging summaries and the reconciliations', async () => {
    const pack = await buildMonthEndReportPack(ctx, PERIOD);
    expect(pack.sections).toEqual(TITLES);
    expect(pack.filename).toBe('month-end-2026-03-31.pdf');
    expect(Buffer.from(pack.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const doc = await PDFDocument.load(pack.bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(TITLES.length);
    expect(doc.getKeywords()).toContain('Trial Balance');
    const text = pdfText(pack.bytes);
    for (const title of TITLES) expect(text, title).toContain(title);
    // Report content made it in, not just the titles.
    expect(text).toContain('Acme Corp'); // A/R aging
    expect(text).toContain('Paper Co'); // A/P aging
    expect(text).toContain('1000 Checking'); // reconciliation summary
    expect(text).toContain('950.00'); // statement ending balance
    expect(text).toMatch(/Credit Card|2100/); // trial balance lists the card
    expect(text).toContain('Books closed through Mar 31, 2026.');
  });

  it('leaves the reconciliation figures out for people without Sensitive Accounting: print', async () => {
    const reportsOnly = customCtx({ reports_financial: ['view', 'print'], reports_sales: ['view'], reports_purchases: ['view'] });
    const pack = await buildMonthEndReportPack(reportsOnly, PERIOD);
    expect(pack.sections).toEqual(TITLES);
    const text = pdfText(pack.bytes);
    expect(text).toContain(RECON_NO_ACCESS);
    expect(text).not.toContain('1000 Checking');
    expect(text).toContain('Acme Corp'); // the aging summaries they may see are still there
    // With accounting: print the figures are back.
    const withRecon = customCtx({ reports_financial: ['view', 'print'], reports_sales: ['view'], reports_purchases: ['view'], accounting: ['view', 'print'] });
    const full = pdfText((await buildMonthEndReportPack(withRecon, PERIOD)).bytes);
    expect(full).toContain('1000 Checking');
    expect(full).not.toContain(RECON_NO_ACCESS);
  });

  it('needs the customer and vendor report areas too, and downloads through the API', async () => {
    await expect(buildMonthEndReportPack(roleCtx('banking'), PERIOD)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    routeCtx = ctx;
    const res = await reportPackRoute.GET(new NextRequest(`http://localhost/api/month-end-close/report-pack?periodEnd=${PERIOD}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="month-end-2026-03-31\.pdf"/);
    const bad = await reportPackRoute.GET(new NextRequest('http://localhost/api/month-end-close/report-pack?periodEnd=2026-13-01'));
    expect(bad.status).toBe(400);
    const list = await checklistRoute.GET(new NextRequest(`http://localhost/api/month-end-close?periodEnd=${PERIOD}`));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { checklist: MonthEndChecklist; history: unknown[] };
    expect(body.checklist.status).toBe('closed');
    expect(body.history.length).toBeGreaterThan(0);
  });
});
