/**
 * Wave-2 payroll fix round 5 (doer): IIF re-import identity includes the customer / vendor name,
 * a document edited in QuickBooks between exports brings in only the change (and repeats add
 * nothing), the change is dated at the newest payment behind it, and Undeposited Funds is not a
 * bank account for the YTD entry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, invoices, journalEntries, paychecks, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { createEmployee } from './payroll';
import { createLiabilityAdjustment, createYtdAdjustment } from './payrollAdjustments';
import { importIIF } from './qbImport';
import { arApReconciliation } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-wave2-fix5');
let db: DB;
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `fix5-${seq}@test.local`, name: 'Fix5', passwordHash: 'x' }).returning();
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
  return rec;
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
const bill = (date: string, name: string, amt: string, num: string) => [
  t('TRNS', '', 'BILL', date, 'Accounts Payable', name, `-${amt}`, num, '', 'N', ''),
  t('SPL', '', 'BILL', date, 'Office Supplies', '', amt, num, ''),
  t('ENDTRNS'),
];
const billpmt = (date: string, name: string, amt: string) => [
  t('TRNS', '', 'BILLPMT', date, 'Checking', name, `-${amt}`, '', '', '', ''),
  t('SPL', '', 'BILLPMT', date, 'Accounts Payable', name, amt, '', ''),
  t('ENDTRNS'),
];
const AS_DOCS = { openItems: { asDocuments: true, alreadyInGl: false } };
const iif = (...blocks: string[][]) => [...HDR, ...blocks.flat()].join('\r\n');
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('wave-2 payroll fix round 5', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('L6 re-import', () => {
    it('an invoice edited down (500 -> 450) brings in only the change, and repeating the file adds nothing', async () => {
      const ctx = await newCompany('Fix5 Edit Down');
      await importIIF(ctx, iif(inv('12/01/2025', 'Down Co', '500.00', 'D-1'), pmt('12/10/2025', 'Down Co', '200.00')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('300.00');
      const file = iif(inv('12/01/2025', 'Down Co', '450.00', 'D-1'), pmt('12/10/2025', 'Down Co', '200.00'));
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('250.00');
      const before = await jeCount(ctx);
      await importIIF(ctx, file, AS_DOCS);
      expect(await jeCount(ctx)).toBe(before);
      expect((await tie(ctx)).ar.aging).toBe('250.00');
    });

    it('an edit up and a new payment of the same size in one file leave the balance, and a repeat adds nothing', async () => {
      const ctx = await newCompany('Fix5 Edit And Pay');
      await importIIF(ctx, iif(inv('12/01/2025', 'Both Co', '500.00', 'B-1')), AS_DOCS);
      const file = iif(inv('12/01/2025', 'Both Co', '600.00', 'B-1'), pmt('12/20/2025', 'Both Co', '100.00'));
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      expect(await bal(ctx, '1050')).toBe(100);
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      expect(await bal(ctx, '1050')).toBe(100);
    });

    it('two unnumbered bills from one vendor on one day with different totals are two bills', async () => {
      const ctx = await newCompany('Fix5 Unnumbered Bills');
      const file = iif(bill('12/01/2025', 'Supply Co', '120.00', ''), bill('12/01/2025', 'Supply Co', '80.00', ''));
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('200.00');
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('200.00');
    });

    it('a new bill payment to vendor B with the same date and amount as an earlier one to vendor A is applied to B', async () => {
      const ctx = await newCompany('Fix5 Two Vendors');
      const docs = [bill('12/01/2025', 'Vend A', '300.00', 'VA-1'), bill('12/01/2025', 'Vend B', '300.00', 'VB-1')];
      await importIIF(ctx, iif(...docs, billpmt('12/15/2025', 'Vend A', '50.00')), AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('550.00');
      await importIIF(ctx, iif(...docs, billpmt('12/15/2025', 'Vend B', '50.00'), billpmt('12/15/2025', 'Vend A', '50.00')), AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('500.00');
    });
  });

  it('Undeposited Funds is refused as the YTD bank account', async () => {
    const ctx = await newCompany('Fix5 UF');
    const e = await createEmployee(ctx, { firstName: 'Uf', lastName: 'Guard', payType: 'hourly', payRate: '20' });
    await expect(
      createYtdAdjustment(ctx, {
        employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: (await acct(ctx, '1050')).id,
        lines: [{ kind: 'earning', name: 'Salary', amount: '1000.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId))).length).toBe(0);
  });
});
