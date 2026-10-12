/**
 * Wave-2 payroll fix round 4 (doer): IIF open-item re-import is idempotent (only payments not
 * imported before are applied, documents are never brought in twice), and payroll adjustments
 * refuse non-bank "bank" accounts, non-expense offsets and non-finite amounts.
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-wave2-fix4');
let db: DB;
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `fix4-${seq}@test.local`, name: 'Fix4', passwordHash: 'x' }).returning();
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
const AS_DOCS = { openItems: { asDocuments: true, alreadyInGl: false } };
const iif = (...blocks: string[][]) => [...HDR, ...blocks.flat()].join('\r\n');
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('wave-2 payroll fix round 4', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('L6 re-import idempotency', () => {
    it('a later file with ONLY the new payment reduces the invoice brought in earlier', async () => {
      const ctx = await newCompany('Fix4 Incremental');
      await importIIF(ctx, iif(inv('12/01/2025', 'Inc Co', '500.00', 'F4-1'), pmt('12/10/2025', 'Inc Co', '200.00')), AS_DOCS);
      await importIIF(ctx, iif(pmt('12/15/2025', 'Inc Co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(300);
      expect(rec.ar.aging).toBe('200.00');
    });

    it('re-importing twice with a new payment each time keeps aging = invoiced - received', async () => {
      const ctx = await newCompany('Fix4 Twice');
      const base = [inv('12/01/2025', 'Twice Co', '500.00', 'F4-2'), pmt('12/10/2025', 'Twice Co', '200.00')];
      await importIIF(ctx, iif(...base), AS_DOCS);
      await importIIF(ctx, iif(...base, pmt('12/15/2025', 'Twice Co', '100.00')), AS_DOCS);
      await importIIF(ctx, iif(...base, pmt('12/15/2025', 'Twice Co', '100.00'), pmt('12/20/2025', 'Twice Co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(400);
      expect(rec.ar.aging).toBe('100.00');
      const docs = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
      expect(docs.length, 'the invoice is never brought in a second time').toBe(1);
    });

    it('a fully paid (PAID=N) invoice re-imported with an extra payment becomes a credit, not a new invoice', async () => {
      const ctx = await newCompany('Fix4 Full');
      const base = [inv('12/01/2025', 'Full Co', '500.00', 'F4-3'), pmt('12/10/2025', 'Full Co', '500.00')];
      await importIIF(ctx, iif(...base), AS_DOCS);
      let rec = await tie(ctx);
      expect(rec.ar.aging).toBe('0.00');
      const before = await jeCount(ctx);
      await importIIF(ctx, iif(...base), AS_DOCS);
      expect(await jeCount(ctx), 'identical re-import adds nothing').toBe(before);
      await importIIF(ctx, iif(...base, pmt('12/20/2025', 'Full Co', '50.00')), AS_DOCS);
      rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(550);
      expect(rec.ar.aging, 'received 550 against 500 invoiced').toBe('-50.00');
    });

    it('an overpayment credit is not doubled by a cumulative re-import', async () => {
      const ctx = await newCompany('Fix4 Over');
      const base = [inv('12/01/2025', 'Over Co', '500.00', 'F4-4'), pmt('12/10/2025', 'Over Co', '600.00')];
      await importIIF(ctx, iif(...base), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('-100.00');
      await importIIF(ctx, iif(...base, pmt('12/20/2025', 'Over Co', '50.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(650);
      expect(rec.ar.aging).toBe('-150.00');
    });

    it('an invoice imported open and later exported PAID=Y with its payment ends at zero', async () => {
      const ctx = await newCompany('Fix4 Paid Later');
      await importIIF(ctx, iif(inv('12/01/2025', 'Later Co', '500.00', 'F4-5')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('500.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Later Co', '500.00', 'F4-5', 'Y'), pmt('12/12/2025', 'Later Co', '500.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(500);
      expect(rec.ar.aging).toBe('0.00');
    });
  });

  describe('payroll adjustment guards', () => {
    it('liability adjustment: A/P, bank and NaN / Infinity are refused with nothing written', async () => {
      const ctx = await newCompany('Fix4 Liab');
      const e = await createEmployee(ctx, { firstName: 'Liab', lastName: 'Guard', payType: 'hourly', payRate: '20' });
      for (const code of ['2000', '1200', '1000']) {
        const a = await acct(ctx, code);
        await expect(
          createLiabilityAdjustment(ctx, {
            employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, offsetAccountId: a.id,
            lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '75.00' }],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      for (const amount of ['NaN', 'Infinity', '-Infinity', 'abc', '99999999999999.99']) {
        await expect(
          createLiabilityAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'tax', name: 'Federal Income Tax', amount }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      const rows = await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId));
      expect(rows.length).toBe(0);
      // An expense offset still works.
      const ok = await createLiabilityAdjustment(ctx, {
        employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, offsetAccountId: (await acct(ctx, '6500')).id,
        lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '75.00' }],
      });
      expect(ok.postedEntryId).toBeTruthy();
      await tie(ctx);
    });

    it('YTD entry: a non-bank "bank" account and non-finite amounts are refused', async () => {
      const ctx = await newCompany('Fix4 YTD');
      const e = await createEmployee(ctx, { firstName: 'Ytd', lastName: 'Guard', payType: 'hourly', payRate: '20' });
      for (const code of ['2000', '1200', '6500']) {
        await expect(
          createYtdAdjustment(ctx, {
            employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: (await acct(ctx, code)).id,
            lines: [{ kind: 'earning', name: 'Salary', amount: '1000.00' }],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      for (const amount of ['NaN', 'Infinity', 'abc', '99999999999999.99']) {
        await expect(
          createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await expect(
        createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount: Number.NaN }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId))).length).toBe(0);
      const ok = await createYtdAdjustment(ctx, {
        employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: (await acct(ctx, '1000')).id,
        lines: [{ kind: 'earning', name: 'Salary', amount: '1000.00' }],
      });
      expect(ok.postedEntryId).toBeTruthy();
      await tie(ctx);
    });
  });
});
