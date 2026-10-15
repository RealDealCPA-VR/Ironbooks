/**
 * Period Copy (PARITY I7): a portable company file holding only one date range. Its trial
 * balance on the end date and on the day before the start date (the opening balances) must
 * equal the original file's, nothing dated after the end date may remain, other companies are
 * removed, and an invoice paid after the end date is open again in the copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, gt } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, auditLogs, companies, expenses, invoices, journalEntries, paymentsReceived, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createExpense } from './expenses';
import { createManualEntry, voidEntry } from './journal';
import { trialBalance } from './reports';
import { restorePortableCompanyFile } from './portableFile';
import { createPeriodCopy } from './periodCopy';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-period-copy');
const SRC = path.join(ROOT, 'source');
const OUT = path.join(ROOT, 'copy');

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let rangeInvoiceId: string;
let copyDb: DB;
let cctx: ServiceContext;

function je(date: string, debitAcct: string, creditAcct: string, amount: string, description: string) {
  return { date: d(date), description, lines: [{ accountId: debitAcct, debit: amount }, { accountId: creditAcct, credit: amount }] };
}

async function tbRows(c: ServiceContext, asOf?: Date) {
  const tb = await trialBalance(c, asOf);
  expect(tb.balanced).toBe(true);
  return Object.fromEntries(tb.rows.map((r) => [r.code, `${r.debit}/${r.credit}`]));
}

describe('Period Copy', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(SRC);
    const [user] = await db.insert(users).values({ email: 'owner-period@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Period Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    const customerId = (await createCustomer(ctx, { displayName: 'Audit Customer' })).id;
    const vendorId = (await createVendor(ctx, { displayName: 'Supplier' })).id;

    // Before the period.
    await createManualEntry(ctx, je('2025-11-03', acct['1000'], acct['3000'], '10000.00', 'Owner investment'));
    await createManualEntry(ctx, je('2025-12-10', acct['6300'], acct['1000'], '250.00', 'December supplies'));
    const voided = await createManualEntry(ctx, je('2025-12-12', acct['6000'], acct['1000'], '99.00', 'Mistake'));
    await voidEntry(ctx, voided.id);
    const decInvoice = await createInvoice(ctx, { customerId, date: d('2025-12-15'), lines: [{ description: 'December work', quantity: 1, rate: '400' }] });
    // Paid inside the period.
    await receivePayment(ctx, { customerId, date: d('2026-01-20'), method: 'check', amount: '400', depositAccountId: acct['1000'], applications: [{ invoiceId: decInvoice.id, amountApplied: '400' }] });
    // Still open from before the period (condense keeps its detail).
    await createInvoice(ctx, { customerId, date: d('2025-12-20'), lines: [{ description: 'Open December work', quantity: 1, rate: '75' }] });

    // In the period.
    await createManualEntry(ctx, je('2026-02-01', acct['6300'], acct['1000'], '125.50', 'February supplies'));
    rangeInvoiceId = (await createInvoice(ctx, { customerId, date: d('2026-02-10'), lines: [{ description: 'February work', quantity: 1, rate: '500' }] })).id;
    await createExpense(ctx, { vendorId, date: d('2026-03-05'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '60.00' }] });

    // After the period: pays the February invoice, more activity.
    await receivePayment(ctx, { customerId, date: d('2026-04-05'), method: 'check', amount: '500', depositAccountId: acct['1000'], applications: [{ invoiceId: rangeInvoiceId, amountApplied: '500' }] });
    await createManualEntry(ctx, je('2026-04-15', acct['6300'], acct['1000'], '33.00', 'April supplies'));
    await createExpense(ctx, { vendorId, date: d('2026-05-01'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '80.00' }] });

    // A second company in the same file.
    const other = await createCompany(db, { name: 'Unrelated Co', ownerId: user.id });
    const otherCash = (await db.select().from(accounts).where(and(eq(accounts.companyId, other.id), eq(accounts.code, '1000'))))[0];
    const otherEq = (await db.select().from(accounts).where(and(eq(accounts.companyId, other.id), eq(accounts.code, '3000'))))[0];
    await createManualEntry({ db, companyId: other.id, userId: user.id }, je('2026-02-02', otherCash.id, otherEq.id, '5.00', 'Other company'));
  });

  afterAll(async () => {
    for (const dir of [SRC, OUT]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('refuses a bad range', async () => {
    await expect(createPeriodCopy(ctx, { from: '2026-04-01', to: '2026-03-31', dataDir: SRC })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createPeriodCopy(ctx, { from: 'soon', to: '2026-03-31', dataDir: SRC })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createPeriodCopy({ ...ctx, role: 'viewer' }, { from: '2026-01-01', to: '2026-03-31', dataDir: SRC })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('builds a verified portable copy of Jan 1 - Mar 31, 2026', async () => {
    const res = await createPeriodCopy(ctx, { from: '2026-01-01', to: '2026-03-31', dataDir: SRC });
    expect(res.filename).toBe('Period Co (Period Copy 2026-01-01 to 2026-03-31).bkp');
    expect(res.summary.otherCompaniesRemoved).toBe(1);
    expect(res.summary.removedAfter.journalEntries).toBeGreaterThanOrEqual(3);
    expect(res.summary.condensed?.entries).toBeGreaterThan(0);
    await restorePortableCompanyFile(res.buffer, OUT);
    copyDb = await getDb(OUT);
    cctx = { db: copyDb, companyId: ctx.companyId, userId: ctx.userId };
    // The original file is untouched.
    expect(await db.select().from(journalEntries).where(gt(journalEntries.date, endOfDay('2026-03-31')))).not.toHaveLength(0);
  });

  it('trial balance equals the original on the end date and for the opening balances', async () => {
    expect(await tbRows(cctx, endOfDay('2026-03-31'))).toEqual(await tbRows(ctx, endOfDay('2026-03-31')));
    expect(await tbRows(cctx, endOfDay('2025-12-31'))).toEqual(await tbRows(ctx, endOfDay('2025-12-31')));
    // Nothing after the end date: the copy's all-time balances are the original's as of Mar 31.
    expect(await tbRows(cctx)).toEqual(await tbRows(ctx, endOfDay('2026-03-31')));
    // Cached balances agree with the ledger.
    const cash = (await copyDb.select().from(accounts).where(eq(accounts.id, acct['1000'])))[0];
    const tb = await trialBalance(cctx);
    expect(tb.rows.find((r) => r.code === '1000')?.debit).toBe(cash.balance);
  });

  it('contains no later activity and only summaries / open items before the start date', async () => {
    expect(await copyDb.select().from(journalEntries).where(gt(journalEntries.date, endOfDay('2026-03-31')))).toHaveLength(0);
    expect(await copyDb.select().from(expenses).where(gt(expenses.date, endOfDay('2026-03-31')))).toHaveLength(0);
    expect(await copyDb.select().from(paymentsReceived).where(gt(paymentsReceived.date, endOfDay('2026-03-31')))).toHaveLength(0);
    const before = await copyDb.select().from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId)));
    const early = before.filter((e) => e.date < new Date('2026-01-01T00:00:00.000Z'));
    for (const e of early) {
      // Condensed opening balances, or the entry of a document still open at the period start.
      expect(e.sourceRef?.startsWith('condense:') || e.sourceRef?.startsWith('invoice:')).toBe(true);
    }
    expect(early.some((e) => e.sourceRef?.startsWith('condense:'))).toBe(true);
    expect(early.some((e) => e.status === 'void')).toBe(false);
    // Other company gone.
    expect(await copyDb.select().from(companies)).toHaveLength(1);
    // The audit trail of removed records went with them.
    const logs = await copyDb.select().from(auditLogs).where(eq(auditLogs.entityType, 'expense'));
    const ids = new Set((await copyDb.select({ id: expenses.id }).from(expenses)).map((r) => r.id));
    expect(logs.every((l) => ids.has(l.entityId))).toBe(true);
  });

  it('reads as of the end date: the invoice paid in April is open again, the copy is closed through Mar 31', async () => {
    const [inv] = await copyDb.select().from(invoices).where(eq(invoices.id, rangeInvoiceId));
    expect(inv.status).toBe('open');
    expect(inv.balanceDue).toBe('500.00');
    expect(inv.amountPaid).toBe('0.00');
    const [co] = await copyDb.select().from(companies).where(eq(companies.id, ctx.companyId));
    const s = co.settings as Record<string, unknown>;
    expect(s.closingDate).toBe('2026-03-31');
    expect(s.periodCopy).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
    // A/R in the copy = the open invoices on Mar 31 (500 February + 75 December).
    const tb = await trialBalance(cctx);
    expect(tb.rows.find((r) => r.code === '1200')?.debit).toBe('575.00');
  });
});
