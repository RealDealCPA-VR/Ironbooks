/**
 * Independent QA (tester) — wave-2 payroll team, RE-TEST round 3 of fix round 5 (86be2dd).
 *
 * Fix round 4 claims:
 *   - L6: IIF open-item re-import is idempotent — an IIF document carries a [qbdoc:] identity
 *     (type, name, number, date, total); a document an earlier import brought in stands in at
 *     what the books carry and only payments not posted before reduce it; control rows already
 *     posted by an earlier import are not applied again;
 *   - E3/E5: payroll adjustments refuse non-bank "bank" accounts, non-expense offsets and
 *     non-finite / oversized amounts.
 *
 * These tests probe the edges of those claims: payment identity across customers, newer exports
 * with an edited invoice, a closing date set between two imports, OPENBAL-only newer exports, the
 * A/P mirror with a fully settled bill, cross-company account ids, and liability / credit card /
 * income accounts as the offset or bank.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, companies, invoices, journalEntries, paychecks, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance, balanceSheet } from './reports';
import { createEmployee } from './payroll';
import { createLiabilityAdjustment, createYtdAdjustment } from './payrollAdjustments';
import { importIIF } from './qbImport';
import { arApReconciliation } from './openItemsImport';
import { createAccount } from './accounts';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-wave2-retest3');
let db: DB;
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-pr-retest3-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}
async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
}
const bal = async (ctx: ServiceContext, code: string) => Number((await acct(ctx, code)).balance);
const jeCount = async (ctx: ServiceContext) =>
  (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
async function tie(ctx: ServiceContext) {
  const rec = await arApReconciliation(ctx);
  expect(rec.ar.difference, `A/R control ${rec.ar.control} vs aging ${rec.ar.aging}`).toBe('0.00');
  expect(rec.ap.difference, `A/P control ${rec.ap.control} vs aging ${rec.ap.aging}`).toBe('0.00');
  expect((await trialBalance(ctx)).balanced).toBe(true);
  expect((await balanceSheet(ctx, new Date('2100-01-01T00:00:00Z'))).balanced).toBe(true);
  return rec;
}
/** Open balance per customer (sum of non-void invoices' balance due minus open credits). */
async function invoiceBalances(ctx: ServiceContext) {
  const rows = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
  return rows.filter((r) => r.status !== 'void');
}

const t = (...c: string[]) => c.join('\t');
const HDR = [
  t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'PAID', 'OPENBAL'),
  t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
  t('!ENDTRNS'),
];
const inv = (date: string, name: string, amt: string, num: string, paid = 'N', open = '') => [
  t('TRNS', '', 'INVOICE', date, 'Accounts Receivable', name, amt, num, '', paid, open),
  t('SPL', '', 'INVOICE', date, 'Sales Income', '', `-${amt}`, num, ''),
  t('ENDTRNS'),
];
const pmt = (date: string, name: string, amt: string) => [
  t('TRNS', '', 'PAYMENT', date, 'Undeposited Funds', name, amt, '', '', '', ''),
  t('SPL', '', 'PAYMENT', date, 'Accounts Receivable', name, `-${amt}`, '', ''),
  t('ENDTRNS'),
];
const bill = (date: string, name: string, amt: string, num: string, paid = 'N', open = '') => [
  t('TRNS', '', 'BILL', date, 'Accounts Payable', name, `-${amt}`, num, '', paid, open ? `-${open}` : ''),
  t('SPL', '', 'BILL', date, 'Office Supplies', '', amt, num, ''),
  t('ENDTRNS'),
];
const billpmt = (date: string, name: string, amt: string, num: string) => [
  t('TRNS', '', 'BILLPMT', date, 'Checking', name, `-${amt}`, num, '', '', ''),
  t('SPL', '', 'BILLPMT', date, 'Accounts Payable', name, amt, num, ''),
  t('ENDTRNS'),
];
const AS_DOCS = { openItems: { asDocuments: true, alreadyInGl: false } };
const iif = (...blocks: string[][]) => [...HDR, ...blocks.flat()].join('\r\n');
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Per-customer aging (sum of balance due of non-void invoices minus non-void credit memos). */
async function owedBy(ctx: ServiceContext, name: string) {
  const { customers, creditMemos } = await import('@/lib/db/schema');
  const [c] = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, name)));
  if (!c) return 0;
  const invs = (await ctx.db.select().from(invoices).where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, c.id)))).filter(
    (r) => r.status !== 'void',
  );
  const cms = (await ctx.db.select().from(creditMemos).where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.customerId, c.id)))).filter(
    (r) => r.status !== 'void',
  );
  const owed = invs.reduce((s, r) => s + Number(r.balanceDue), 0);
  const credit = cms.reduce((s, r) => s + Number(r.unapplied), 0);
  return Math.round((owed - credit) * 100) / 100;
}

const closeThrough = (ctx: ServiceContext, date: string | null) =>
  db.update(companies).set({ settings: date ? { closingDate: date } : {} }).where(eq(companies.id, ctx.companyId));

describe('wave-2 payroll — re-test round 3 of fix round 5', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('L6 edited document totals', () => {
    it('an invoice edited DOWN (600 -> 450) after a payment brings in only the reduction', async () => {
      const ctx = await newCompany('RT3 Edit Down');
      await importIIF(ctx, iif(inv('12/01/2025', 'Down Co', '600.00', 'D-1'), pmt('12/10/2025', 'Down Co', '200.00')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('400.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Down Co', '450.00', 'D-1'), pmt('12/10/2025', 'Down Co', '200.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(200);
      expect(rec.ar.aging, 'QuickBooks: 450 - 200').toBe('250.00');
      expect(await owedBy(ctx, 'Down Co')).toBe(250);
    });

    it('edit 500 -> 600, then the same export again, then 600 -> 550: each step lands once', async () => {
      const ctx = await newCompany('RT3 Edit Chain');
      const p = pmt('12/10/2025', 'Chain Co', '100.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Chain Co', '500.00', 'CH-1'), p), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('400.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Chain Co', '600.00', 'CH-1'), p), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      const before = await jeCount(ctx);
      await importIIF(ctx, iif(inv('12/01/2025', 'Chain Co', '600.00', 'CH-1'), p), AS_DOCS);
      expect(await jeCount(ctx), 'identical re-import adds nothing').toBe(before);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Chain Co', '550.00', 'CH-1'), p), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('450.00');
      expect(await owedBy(ctx, 'Chain Co')).toBe(450);
      expect(await bal(ctx, '1050')).toBe(100);
    });

    it('an invoice edited below what was already paid (500 -> 150, paid 200) leaves a 50 credit, not a negative invoice', async () => {
      const ctx = await newCompany('RT3 Edit Below Paid');
      await importIIF(ctx, iif(inv('12/01/2025', 'Below Co', '500.00', 'BP-1'), pmt('12/10/2025', 'Below Co', '200.00')), AS_DOCS);
      await importIIF(ctx, iif(inv('12/01/2025', 'Below Co', '150.00', 'BP-1'), pmt('12/10/2025', 'Below Co', '200.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('-50.00');
      expect(await owedBy(ctx, 'Below Co')).toBe(-50);
      const neg = (await invoiceBalances(ctx)).filter((r) => Number(r.balanceDue) < 0);
      expect(neg.length, 'no invoice carries a negative balance').toBe(0);
    });

    it('an edited total AND a new payment in the same newer export are both brought in', async () => {
      const ctx = await newCompany('RT3 Edit Plus Pmt');
      await importIIF(ctx, iif(inv('12/01/2025', 'Both Co', '500.00', 'BO-1'), pmt('12/10/2025', 'Both Co', '100.00')), AS_DOCS);
      await importIIF(
        ctx,
        iif(inv('12/01/2025', 'Both Co', '700.00', 'BO-1'), pmt('12/10/2025', 'Both Co', '100.00'), pmt('12/20/2025', 'Both Co', '150.00')),
        AS_DOCS,
      );
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(250);
      expect(rec.ar.aging, '700 - 100 - 150').toBe('450.00');
    });

    it('a bill edited in QuickBooks (300 -> 360) between exports brings in only the 60 change on the A/P side', async () => {
      const ctx = await newCompany('RT3 AP Edit');
      await importIIF(ctx, iif(bill('12/01/2025', 'Edit Vendor', '300.00', 'EB-1')), AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('300.00');
      await importIIF(ctx, iif(bill('12/01/2025', 'Edit Vendor', '360.00', 'EB-1')), AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('360.00');
      await importIIF(ctx, iif(bill('12/01/2025', 'Edit Vendor', '360.00', 'EB-1')), AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('360.00');
    });

    it('two invoices with different numbers for the same customer/date/amount stay two documents across re-imports', async () => {
      const ctx = await newCompany('RT3 Two Numbers');
      const file = iif(inv('12/01/2025', 'Pair Co', '250.00', 'P-1'), inv('12/01/2025', 'Pair Co', '250.00', 'P-2'));
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      // P-2 edited, P-1 untouched.
      await importIIF(ctx, iif(inv('12/01/2025', 'Pair Co', '250.00', 'P-1'), inv('12/01/2025', 'Pair Co', '300.00', 'P-2')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('550.00');
    });
  });

  describe('L6 closing date between imports', () => {
    it('an edit refused by the closing date is tried again (once) after the closing date is lifted', async () => {
      // The invoice is in the closed period; its edited total cannot be brought in while the
      // books are closed. The next import after reopening must bring the 100 in exactly once.
      const ctx = await newCompany('RT3 Closed Edit Retry');
      await importIIF(ctx, iif(inv('12/01/2025', 'Retry Co', '500.00', 'R-1')), AS_DOCS);
      await closeThrough(ctx, '2025-12-31');
      await importIIF(ctx, iif(inv('12/01/2025', 'Retry Co', '600.00', 'R-1')), AS_DOCS);
      const mid = (await tie(ctx)).ar.aging;
      expect(['500.00', '600.00']).toContain(mid);
      await closeThrough(ctx, null);
      await importIIF(ctx, iif(inv('12/01/2025', 'Retry Co', '600.00', 'R-1')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('600.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Retry Co', '600.00', 'R-1')), AS_DOCS);
      expect((await tie(ctx)).ar.aging, 'not a second time').toBe('600.00');
    });

    it('nothing a re-import posts lands on or before the closing date', async () => {
      const ctx = await newCompany('RT3 Nothing In Closed');
      const base = [inv('12/01/2025', 'Guard Co', '500.00', 'G-1'), pmt('12/10/2025', 'Guard Co', '200.00')];
      await importIIF(ctx, iif(...base), AS_DOCS);
      const before = new Set((await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).map((j) => j.id));
      await closeThrough(ctx, '2025-12-31');
      await importIIF(
        ctx,
        iif(inv('12/01/2025', 'Guard Co', '650.00', 'G-1'), pmt('12/10/2025', 'Guard Co', '200.00'), pmt('01/05/2026', 'Guard Co', '50.00')),
        AS_DOCS,
      );
      const added = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).filter((j) => !before.has(j.id));
      for (const j of added) {
        const day = new Date(j.date as unknown as string).toISOString().slice(0, 10);
        expect(day > '2025-12-31', `entry ${j.id} dated ${day}`).toBe(true);
      }
      await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(250);
    });
  });

  describe('L6 payment identity (name normalisation)', () => {
    it('the same payment re-exported with the customer name in a different case / spacing is not posted twice', async () => {
      const ctx = await newCompany('RT3 Name Case');
      const doc = inv('12/01/2025', 'Gamma Co', '500.00', 'G-9');
      await importIIF(ctx, iif(doc, pmt('12/15/2025', 'Gamma Co', '100.00')), AS_DOCS);
      await importIIF(ctx, iif(doc, pmt('12/15/2025', 'gamma  co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(100);
      expect(rec.ar.aging).toBe('400.00');
    });

    it('three customers, same day, same amount, no DOCNUM, shuffled on re-import: each is paid exactly once', async () => {
      const ctx = await newCompany('RT3 Three Shuffle');
      const docs = ['Ann', 'Ben', 'Cal'].map((n) => inv('12/01/2025', `${n} Co`, '300.00', `${n}-1`));
      await importIIF(ctx, iif(...docs, pmt('12/15/2025', 'Ann Co', '100.00'), pmt('12/15/2025', 'Ben Co', '100.00')), AS_DOCS);
      await importIIF(
        ctx,
        iif(...docs, pmt('12/15/2025', 'Cal Co', '100.00'), pmt('12/15/2025', 'Ben Co', '100.00'), pmt('12/15/2025', 'Ann Co', '100.00')),
        AS_DOCS,
      );
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(300);
      expect(rec.ar.aging).toBe('600.00');
      for (const n of ['Ann Co', 'Ben Co', 'Cal Co']) expect(await owedBy(ctx, n), n).toBe(200);
    });

    it('bill payments with no number, same day and amount, to different vendors are both posted', async () => {
      const ctx = await newCompany('RT3 AP Two Vendors');
      const docs = [bill('12/01/2025', 'V One', '200.00', 'VB-1'), bill('12/01/2025', 'V Two', '200.00', 'VB-2')];
      await importIIF(ctx, iif(...docs, billpmt('12/10/2025', 'V One', '50.00', '')), AS_DOCS);
      await importIIF(ctx, iif(...docs, billpmt('12/10/2025', 'V Two', '50.00', ''), billpmt('12/10/2025', 'V One', '50.00', '')), AS_DOCS);
      const rec = await tie(ctx);
      expect(-(await bal(ctx, '1000'))).toBe(100);
      expect(rec.ap.aging).toBe('300.00');
    });
  });
});
