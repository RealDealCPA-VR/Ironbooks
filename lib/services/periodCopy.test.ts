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
import { accountantCopies, accounts, auditLogs, companies, expenses, inventoryLayers, invoices, items, journalEntries, paymentsReceived, users } from '@/lib/db/schema';
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
import { accountantCopyStatus, createAccountantCopy } from './accountantCopy/client';
import { createItem } from './items';
import { createSite, ensureDefaultSite, siteQuantities } from './inventorySites';
import { adjustQuantityAtSite } from './inventorySiteOps';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-period-copy');
const SRC = path.join(ROOT, 'source');
const OUT = path.join(ROOT, 'copy');
const OUT2 = path.join(ROOT, 'copy-while-acctcopy');

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let rangeInvoiceId: string;
let fifoItemId: string;
let avgItemId: string;
let eastSiteId: string;
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

    // Inventory: stocked in the period (FIFO item at two sites, an average-cost item).
    await ensureDefaultSite(ctx);
    eastSiteId = (await createSite(ctx, { name: 'East Store' })).id;
    fifoItemId = (await createItem(ctx, { name: 'Widget', type: 'inventory', incomeAccountId: acct['4000'] })).id;
    avgItemId = (await createItem(ctx, { name: 'Gadget', type: 'inventory', incomeAccountId: acct['4000'] })).id;
    await adjustQuantityAtSite(ctx, { itemId: fifoItemId, quantityChange: 10, unitCost: 5, date: d('2026-02-05'), costing: 'fifo' });
    await adjustQuantityAtSite(ctx, { itemId: fifoItemId, quantityChange: 4, unitCost: 6, date: d('2026-02-06'), siteId: eastSiteId });
    await adjustQuantityAtSite(ctx, { itemId: avgItemId, quantityChange: 8, unitCost: 3, date: d('2026-02-07') });
    // ...sold, adjusted and restocked after it.
    await createInvoice(ctx, { customerId, date: d('2026-04-10'), lines: [{ itemId: fifoItemId, quantity: 3, rate: 20 }, { itemId: avgItemId, quantity: 2, rate: 9 }] });
    await adjustQuantityAtSite(ctx, { itemId: fifoItemId, quantityChange: -1, date: d('2026-04-12'), siteId: eastSiteId });
    await adjustQuantityAtSite(ctx, { itemId: fifoItemId, quantityChange: 5, unitCost: 7, date: d('2026-04-20') });
    // A dearer restock of the average-cost item moves its average cost after the period.
    await adjustQuantityAtSite(ctx, { itemId: avgItemId, quantityChange: 2, unitCost: 9, date: d('2026-04-22') });

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

  it('inventory reads as of the end date: on-hand, per-site quantities and FIFO layers before the later sales', async () => {
    // The original moved on: 10 + 4 - 3 - 1 + 5 = 15 Widgets, 8 - 2 + 2 = 8 Gadgets at (6x3 + 2x9) / 8 = 4.50.
    const [orig] = await db.select().from(items).where(eq(items.id, fifoItemId));
    expect(orig.quantityOnHand).toBe('15.0000');
    const [origG] = await db.select().from(items).where(eq(items.id, avgItemId));
    expect(origG.averageCost).toBe('4.5000');
    const [w] = await copyDb.select().from(items).where(eq(items.id, fifoItemId));
    const [g] = await copyDb.select().from(items).where(eq(items.id, avgItemId));
    expect(w.quantityOnHand).toBe('14.0000');
    expect(g.quantityOnHand).toBe('8.0000');
    expect(g.averageCost).toBe('3.0000');
    const layers = await copyDb.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, fifoItemId));
    expect(layers.map((l) => [l.unitCost, l.quantityRemaining]).sort()).toEqual([
      ['5.0000', '10.0000'],
      ['6.0000', '4.0000'],
    ]);
    // The original: 3 left East (4 - 1), the rest at the default site.
    expect((await siteQuantities(ctx, [fifoItemId])).get(fifoItemId)!.get(eastSiteId)?.toFixed(4)).toBe('3.0000');
    const sites = (await siteQuantities(cctx, [fifoItemId])).get(fifoItemId)!;
    expect(sites.get(eastSiteId)?.toFixed(4)).toBe('4.0000');
    const total = [...sites.values()].reduce((s, q) => s + Number(q), 0);
    expect(total).toBe(14);
  });

  it("works while an Accountant's Copy is out, and the auditor's copy does not inherit it", async () => {
    await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: SRC });
    expect((await accountantCopyStatus(ctx)).mode).toBe('client');
    const res = await createPeriodCopy(ctx, { from: '2026-01-01', to: '2026-03-31', dataDir: SRC });
    await restorePortableCompanyFile(res.buffer, OUT2);
    const db2 = await getDb(OUT2);
    try {
      const c2: ServiceContext = { db: db2, companyId: ctx.companyId, userId: ctx.userId };
      expect(await db2.select().from(accountantCopies)).toHaveLength(0);
      expect((await accountantCopyStatus(c2)).mode).toBe('none');
      expect(await tbRows(c2, endOfDay('2026-03-31'))).toEqual(await tbRows(ctx, endOfDay('2026-03-31')));
      // The original still has its outstanding copy.
      expect((await accountantCopyStatus(ctx)).mode).toBe('client');
    } finally {
      await closeDb(OUT2).catch(() => undefined);
    }
  });
});
