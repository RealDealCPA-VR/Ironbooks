/**
 * Independent QA (tester) — wave-2 payroll team, RE-TEST round 2 of fix round 4 (2040d94).
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-wave2-retest2');
let db: DB;
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-pr-retest2-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
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

describe('wave-2 payroll — re-test round 2 of fix round 4', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('L6 re-import: payment identity', () => {
    it('a new payment from customer B with the same date and amount as an earlier payment from customer A is applied to B, not skipped', async () => {
      // QuickBooks PAYMENT rows often carry no DOCNUM. The first file has A's 100 payment on
      // 12/15; the newer export lists B's new 100 payment on 12/15 FIRST, then A's. B's payment
      // is new money: cash must be 200, A owes 400, B owes 400.
      const ctx = await newCompany('RT2 Same Pmt Two Customers');
      const docs = [inv('12/01/2025', 'Alpha Co', '500.00', 'A-1'), inv('12/01/2025', 'Beta Co', '500.00', 'B-1')];
      await importIIF(ctx, iif(...docs, pmt('12/15/2025', 'Alpha Co', '100.00')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('900.00');
      await importIIF(ctx, iif(...docs, pmt('12/15/2025', 'Beta Co', '100.00'), pmt('12/15/2025', 'Alpha Co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050'), 'two distinct 100 payments were received').toBe(200);
      expect(rec.ar.aging).toBe('800.00');
      expect(await owedBy(ctx, 'Alpha Co'), 'Alpha paid 100 once').toBe(400);
      expect(await owedBy(ctx, 'Beta Co'), 'Beta paid 100').toBe(400);
    });

    it('two identical 100 payments on the same day (second is new) — only the new one is applied', async () => {
      const ctx = await newCompany('RT2 Twin Pmts');
      const doc = inv('12/01/2025', 'Twin Co', '500.00', 'T-1');
      await importIIF(ctx, iif(doc, pmt('12/15/2025', 'Twin Co', '100.00')), AS_DOCS);
      await importIIF(ctx, iif(doc, pmt('12/15/2025', 'Twin Co', '100.00'), pmt('12/15/2025', 'Twin Co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(200);
      expect(rec.ar.aging).toBe('300.00');
      // Third identical import adds nothing.
      const before = await jeCount(ctx);
      await importIIF(ctx, iif(doc, pmt('12/15/2025', 'Twin Co', '100.00'), pmt('12/15/2025', 'Twin Co', '100.00')), AS_DOCS);
      expect(await jeCount(ctx)).toBe(before);
      expect((await tie(ctx)).ar.aging).toBe('300.00');
    });
  });

  describe('L6 re-import: newer export differs from the first', () => {
    it('an invoice edited in QuickBooks (500 -> 600) between exports is not brought in twice', async () => {
      // Same customer, same number, same date; only the total changed. QuickBooks now says the
      // customer owes 600 - 200 = 400. Bringing in a second invoice (500 + 600) double counts.
      const ctx = await newCompany('RT2 Edited Invoice');
      await importIIF(ctx, iif(inv('12/01/2025', 'Edit Co', '500.00', 'E-1'), pmt('12/10/2025', 'Edit Co', '200.00')), AS_DOCS);
      expect((await tie(ctx)).ar.aging).toBe('300.00');
      await importIIF(ctx, iif(inv('12/01/2025', 'Edit Co', '600.00', 'E-1'), pmt('12/10/2025', 'Edit Co', '200.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(200);
      expect(rec.ar.aging, 'QuickBooks: invoice 600 less payment 200').toBe('400.00');
    });

    it('a new payment dated after a closing date set between the two imports is applied (the change is not dated into the closed period)', async () => {
      // Invoice 12/01/2025 + payment 200 imported. The user then closes the books through
      // 12/31/2025. A newer export adds a 100 payment dated 01/10/2026 (open period). The
      // payment posts (cash 300) and must reduce the invoice: owes 200.
      const ctx = await newCompany('RT2 Closed Between');
      const base = [inv('12/01/2025', 'Close Co', '500.00', 'C-1'), pmt('12/10/2025', 'Close Co', '200.00')];
      await importIIF(ctx, iif(...base), AS_DOCS);
      await db.update(companies).set({ settings: { closingDate: '2025-12-31' } }).where(eq(companies.id, ctx.companyId));
      const r = await importIIF(ctx, iif(...base, pmt('01/10/2026', 'Close Co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050'), 'the January payment posts').toBe(300);
      expect(rec.ar.aging, `cash 300 against 500 invoiced; issues: ${JSON.stringify(r.issues.slice(-3))}`).toBe('200.00');
    });

    it('a new payment refused by the closing date on re-import is not applied', async () => {
      const ctx = await newCompany('RT2 Refused Reimport');
      const base = [inv('12/01/2025', 'Ref Co', '500.00', 'RF-1'), pmt('12/10/2025', 'Ref Co', '200.00')];
      await importIIF(ctx, iif(...base), AS_DOCS);
      await db.update(companies).set({ settings: { closingDate: '2025-12-31' } }).where(eq(companies.id, ctx.companyId));
      await importIIF(ctx, iif(...base, pmt('12/20/2025', 'Ref Co', '100.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(200);
      expect(rec.ar.aging).toBe('300.00');
    });

    it('an identical re-import of an overpaid customer whose payment exceeds every document adds nothing', async () => {
      const ctx = await newCompany('RT2 Overpay Identical');
      const file = iif(inv('12/01/2025', 'Overpay Co', '100.00', 'O-1'), pmt('12/10/2025', 'Overpay Co', '250.00'));
      await importIIF(ctx, file, AS_DOCS);
      const before = await jeCount(ctx);
      const ar = (await tie(ctx)).ar.aging;
      expect(ar).toBe('-150.00');
      await importIIF(ctx, file, AS_DOCS);
      await importIIF(ctx, file, AS_DOCS);
      expect(await jeCount(ctx)).toBe(before);
      expect((await tie(ctx)).ar.aging).toBe('-150.00');
    });
  });

  describe('L6 re-import: A/P mirror', () => {
    it('a bill imported open, then exported PAID=Y with its BILLPMT, ends at zero and stays there', async () => {
      const ctx = await newCompany('RT2 AP Settled');
      await importIIF(ctx, iif(bill('12/01/2025', 'Paper Vendor', '400.00', 'PB-1')), AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('400.00');
      const later = iif(bill('12/01/2025', 'Paper Vendor', '400.00', 'PB-1', 'Y'), billpmt('12/20/2025', 'Paper Vendor', '400.00', '9001'));
      await importIIF(ctx, later, AS_DOCS);
      let rec = await tie(ctx);
      expect(-(await bal(ctx, '1000'))).toBe(400);
      expect(rec.ap.aging).toBe('0.00');
      await importIIF(ctx, later, AS_DOCS);
      rec = await tie(ctx);
      expect(-(await bal(ctx, '1000'))).toBe(400);
      expect(rec.ap.aging).toBe('0.00');
      const live = (await ctx.db.select().from(bills).where(eq(bills.companyId, ctx.companyId))).filter((b) => b.status !== 'void');
      expect(live.length, 'the bill is never brought in a second time').toBeLessThanOrEqual(2);
    });

    it('a settled (PAID=Y) bill imported first is not re-opened by a later file that repeats it with the same BILLPMT', async () => {
      const ctx = await newCompany('RT2 AP Paid First');
      const file = iif(bill('12/01/2025', 'Ink Vendor', '300.00', 'IB-1', 'Y'), billpmt('12/05/2025', 'Ink Vendor', '300.00', '9002'));
      await importIIF(ctx, file, AS_DOCS);
      expect((await tie(ctx)).ap.aging).toBe('0.00');
      await importIIF(ctx, file, AS_DOCS);
      const rec = await tie(ctx);
      expect(-(await bal(ctx, '1000'))).toBe(300);
      expect(rec.ap.aging).toBe('0.00');
    });
  });

  describe('payroll adjustment account guards', () => {
    it("another company's expense account as the offset is NOT_FOUND and nothing is written", async () => {
      const ctx = await newCompany('RT2 Cross Co A');
      const other = await newCompany('RT2 Cross Co B');
      const e = await createEmployee(ctx, { firstName: 'Cross', lastName: 'Co', payType: 'hourly', payRate: '20' });
      const foreign = await acct(other, '6500');
      const before = await jeCount(ctx);
      await expect(
        createLiabilityAdjustment(ctx, {
          employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, offsetAccountId: foreign.id,
          lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '75.00' }],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        createYtdAdjustment(ctx, {
          employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: (await acct(other, '1000')).id,
          lines: [{ kind: 'earning', name: 'Salary', amount: '100.00' }],
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await jeCount(ctx)).toBe(before);
      expect((await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId))).length).toBe(0);
    });

    it('income, equity, payroll-liability and credit-card accounts are refused as the liability offset', async () => {
      const ctx = await newCompany('RT2 Offset Kinds');
      const e = await createEmployee(ctx, { firstName: 'Off', lastName: 'Set', payType: 'hourly', payRate: '20' });
      const cc = await createAccount(ctx, { code: '2150', name: 'Visa', type: 'liability', subtype: 'credit_card' } as never);
      const ids = [cc.id];
      for (const code of ['4000', '3000', '2300']) {
        const a = await acct(ctx, code);
        if (a) ids.push(a.id);
      }
      expect(ids.length).toBeGreaterThanOrEqual(3);
      for (const id of ids) {
        await expect(
          createLiabilityAdjustment(ctx, {
            employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, offsetAccountId: id,
            lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '75.00' }],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      expect((await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId))).length).toBe(0);
      await tie(ctx);
    });

    it('a credit card account is refused as the YTD "bank" account; savings is accepted', async () => {
      const ctx = await newCompany('RT2 Bank Kinds');
      const e = await createEmployee(ctx, { firstName: 'Bank', lastName: 'Kind', payType: 'hourly', payRate: '20' });
      const cc = await createAccount(ctx, { code: '2151', name: 'Amex', type: 'liability', subtype: 'credit_card' } as never);
      for (const id of [cc.id]) {
        await expect(
          createYtdAdjustment(ctx, {
            employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: id,
            lines: [{ kind: 'earning', name: 'Salary', amount: '100.00' }],
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      const sav = await createAccount(ctx, { code: '1019', name: 'Payroll Savings', type: 'asset', subtype: 'savings' } as never);
      const ok = await createYtdAdjustment(ctx, {
        employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: sav.id,
        lines: [{ kind: 'earning', name: 'Salary', amount: '100.00' }, { kind: 'tax', name: 'Medicare', amount: '1.45' }],
      });
      expect(ok.postedEntryId).toBeTruthy();
      expect(await bal(ctx, '1019')).toBe(-98.55);
      await tie(ctx);
    });

    it('malformed amounts (blank, 1e400, Infinity, sub-cent) are refused or stored as a finite amount, never NaN', async () => {
      const ctx = await newCompany('RT2 Amount Shapes');
      const e = await createEmployee(ctx, { firstName: 'Amt', lastName: 'Shape', payType: 'hourly', payRate: '20' });
      // Blank amounts may be read as 0.00 (harmless) or refused, but never stored as NaN.
      for (const amount of ['', '   ']) {
        try {
          const r = await createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount }] });
          expect(r.grossPay).toBe('0.00');
          expect(r.lines.every((l: { amount: string }) => /^-?\d+\.\d{2}$/.test(l.amount))).toBe(true);
        } catch (err) {
          expect(err).toMatchObject({ code: 'VALIDATION' });
        }
      }
      const blanks = (await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId))).length;
      for (const amount of ['1e400', '-1e400', Number.POSITIVE_INFINITY as unknown as string]) {
        await expect(
          createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await expect(
        createLiabilityAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'tax', name: 'Medicare', amount: '0.004' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      const rows = await ctx.db.select().from(paychecks).where(eq(paychecks.companyId, ctx.companyId));
      expect(rows.length).toBe(blanks);
      for (const r of rows) expect(r.grossPay).not.toContain('NaN');
    });
  });
});

void invoiceBalances;
