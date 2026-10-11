/**
 * Independent QA (tester) — wave-2 payroll, re-test after fix rounds 1-3.
 *
 * Probes invariants the earlier rounds did not cover:
 *   - E4/E5/E3: the payroll liabilities report equals the GL 2300 control balance after
 *     paychecks, SUI/workers comp accruals, an edited check, a voided check, posting liability
 *     adjustments (+/−, one voided), a posting YTD entry and an itemized liability payment;
 *   - E4: an edit that cannot be posted rolls back completely; repeated edits leave exactly
 *     one live entry; another company's paycheck cannot be edited;
 *   - E3/E5: malformed / non-finite / oversized amounts are refused as VALIDATION with nothing
 *     written; offsets or "bank" accounts that are A/R / A/P control accounts are refused
 *     (they would break subledger == control);
 *   - L6: the A/P mirror of the re-import + new payment case.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { MoneyParseError } from '@/lib/money';
import { accounts, journalEntries, paycheckLines, paychecks, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance, balanceSheet } from './reports';
import { postJournalEntry } from './posting';
import { createEmployee, editPaycheck, runPaycheck, updateEmployee, voidPaycheck } from './payroll';
import {
  assignWorkersCompCode,
  createLiabilityAdjustment,
  createWorkersCompCode,
  createYtdAdjustment,
  upsertStateTaxSetting,
  voidPayrollAdjustment,
} from './payrollAdjustments';
import { payrollLiabilityBalances } from './payrollReports';
import { importIIF } from './qbImport';
import { arApReconciliation } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-payroll-wave2-retest');
let db: DB;
let seq = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-pr-retest-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}

async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
}

async function bal(ctx: ServiceContext, code: string) {
  return Number((await acct(ctx, code)).balance);
}

async function booksBalanced(ctx: ServiceContext) {
  expect((await trialBalance(ctx)).balanced).toBe(true);
  expect((await balanceSheet(ctx, new Date('2100-01-01T00:00:00Z'))).balanced).toBe(true);
}

/** A ServiceError VALIDATION, or the money parser's own MoneyParseError (routes map both to 400). */
const isInvalidAmount = (e: unknown) =>
  e instanceof MoneyParseError || (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'VALIDATION');

async function paycheckRows(ctx: ServiceContext) {
  return (await ctx.db.select({ id: paychecks.id }).from(paychecks).where(eq(paychecks.companyId, ctx.companyId))).length;
}

async function entryRows(ctx: ServiceContext) {
  return (await ctx.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
}

describe('wave-2 payroll — re-test adversarial QA', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Subledger == control: payroll liabilities report vs GL 2300
  // -------------------------------------------------------------------------
  it('payroll liabilities report balance == GL 2300 after checks, edits, voids, adjustments and a payment', async () => {
    const ctx = await newCompany('Retest Liab Tie');
    await upsertStateTaxSetting(ctx, { state: 'CA', year: 2026, suiRate: '0.034', suiWageBase: '7000', sdiRate: '0.011', sdiWageBase: '150000' });
    const wc = await createWorkersCompCode(ctx, { code: '8810', description: 'Clerical', ratePer100: '0.27' });
    const a = await createEmployee(ctx, { firstName: 'Ana', lastName: 'Tie', payType: 'hourly', payRate: '30' });
    const b = await createEmployee(ctx, { firstName: 'Ben', lastName: 'Tie', payType: 'salary', payRate: '90000' });
    await updateEmployee(ctx, a.id, { address: { line1: '1 Main', city: 'LA', state: 'CA', zip: '90001' } });
    await assignWorkersCompCode(ctx, a.id, wc.id);

    const c1 = await runPaycheck(ctx, { employeeId: a.id, payDate: d('2026-03-06'), grossPay: '2400.00' });
    const c2 = await runPaycheck(ctx, { employeeId: b.id, payDate: d('2026-03-06'), grossPay: '3461.54' });
    const c3 = await runPaycheck(ctx, { employeeId: a.id, payDate: d('2026-03-20'), grossPay: '2400.00' });
    await editPaycheck(ctx, c1.id, { payDate: d('2026-03-06'), grossPay: '2555.55' });
    await editPaycheck(ctx, c1.id, { payDate: d('2026-03-07'), grossPay: '2511.11' });
    await voidPaycheck(ctx, c3.id);
    void c2;

    await createLiabilityAdjustment(ctx, {
      employeeId: a.id, date: d('2026-03-31'), affectsAccounts: true,
      lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '12.34' }, { kind: 'employer_contribution', name: 'FUTA', amount: '-1.11' }],
    });
    const voided = await createLiabilityAdjustment(ctx, {
      employeeId: b.id, date: d('2026-03-31'), affectsAccounts: true,
      lines: [{ kind: 'tax', name: 'Medicare', amount: '50.00' }],
    });
    await voidPayrollAdjustment(ctx, voided.id);
    await createYtdAdjustment(ctx, {
      employeeId: b.id, date: d('2026-02-27'), affectsAccounts: true,
      lines: [
        { kind: 'earning', name: 'Salary', amount: '1000.00' },
        { kind: 'tax', name: 'Social Security', amount: '62.00' },
        { kind: 'tax', name: 'Medicare', amount: '14.50' },
        { kind: 'employer_contribution', name: 'Social Security Employer', amount: '62.00' },
      ],
    });

    // An itemized liability payment (Pay Payroll Liabilities): Dr 2300 / Cr 1000.
    const liab = await acct(ctx, '2300');
    const bank = await acct(ctx, '1000');
    await postJournalEntry(ctx, {
      date: d('2026-04-15'),
      description: 'Pay payroll liabilities',
      lines: [
        { accountId: liab.id, debit: '100.00', memo: 'Federal Income Tax' },
        { accountId: bank.id, credit: '100.00' },
      ],
    });

    await booksBalanced(ctx);
    const report = await payrollLiabilityBalances(ctx, { asOf: d('2026-12-31') });
    const glOwed = Math.abs(await bal(ctx, '2300'));
    expect(Number(report.balance), `report ${report.balance} vs GL 2300 ${glOwed}`).toBeCloseTo(glOwed, 2);
    expect(Number(report.balance)).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // E4 — edit paycheck rollback / idempotency / isolation
  // -------------------------------------------------------------------------
  describe('edit paycheck', () => {
    it('an edit with deductions larger than gross is refused and the original check stays posted', async () => {
      const ctx = await newCompany('Retest Edit Rollback');
      const e = await createEmployee(ctx, { firstName: 'Rae', lastName: 'Back', payType: 'hourly', payRate: '20' });
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-05-01'), grossPay: '800.00' });
      const linesBefore = await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, pc.id));
      const entriesBefore = await entryRows(ctx);
      await expect(
        editPaycheck(ctx, pc.id, {
          payDate: d('2026-05-01'),
          grossPay: '100.00',
          deductions: [{ name: '401k', amount: '500.00' }],
        } as never),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      const [je] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, pc.postedEntryId!));
      expect(je.status).toBe('posted');
      const [row] = await ctx.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
      expect(row.grossPay).toBe('800.00');
      expect(row.postedEntryId).toBe(pc.postedEntryId);
      expect((await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, pc.id))).length).toBe(linesBefore.length);
      expect(await entryRows(ctx)).toBe(entriesBefore);
      await booksBalanced(ctx);
    });

    it('three successive edits leave exactly ONE posted entry for the check and payroll expense equals its gross', async () => {
      const ctx = await newCompany('Retest Edit Repeat');
      const e = await createEmployee(ctx, { firstName: 'Rip', lastName: 'Peat', payType: 'hourly', payRate: '20' });
      const pc = await runPaycheck(ctx, { employeeId: e.id, payDate: d('2026-05-01'), grossPay: '800.00' });
      await editPaycheck(ctx, pc.id, { payDate: d('2026-05-01'), grossPay: '900.00' });
      await editPaycheck(ctx, pc.id, { payDate: d('2026-05-02'), grossPay: '950.00' });
      const last = await editPaycheck(ctx, pc.id, { payDate: d('2026-05-02'), grossPay: '1000.00' });
      const live = await ctx.db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), like(journalEntries.sourceRef, `paycheck:${pc.id}`), eq(journalEntries.status, 'posted')));
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(last.postedEntryId);
      // Default COA has no 6510, so employer taxes land in 6500 next to the wages.
      const employer = (await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, pc.id)))
        .filter((l) => l.kind === 'employer_contribution')
        .reduce((s, l) => s + Number(l.amount), 0);
      expect(Math.abs(await bal(ctx, '6500'))).toBeCloseTo(1000 + employer, 2);
      expect(Math.abs(await bal(ctx, '1000'))).toBeCloseTo(Number(last.netPay), 2);
      await booksBalanced(ctx);
    });

    it("another company's paycheck cannot be edited (NOT_FOUND) and stays untouched", async () => {
      const owner = await newCompany('Retest Edit Owner');
      const intruder = await newCompany('Retest Edit Intruder');
      const e = await createEmployee(owner, { firstName: 'Iso', lastName: 'Late', payType: 'hourly', payRate: '20' });
      const pc = await runPaycheck(owner, { employeeId: e.id, payDate: d('2026-05-01'), grossPay: '800.00' });
      await expect(editPaycheck(intruder, pc.id, { payDate: d('2026-05-01'), grossPay: '1.00' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const [row] = await owner.db.select().from(paychecks).where(eq(paychecks.id, pc.id));
      expect(row.grossPay).toBe('800.00');
    });
  });

  // -------------------------------------------------------------------------
  // E3 / E5 — malformed amounts at the SERVICE layer
  // -------------------------------------------------------------------------
  describe('malformed amounts are VALIDATION errors and write nothing', () => {
    const bad = ['abc', 'Infinity', 'NaN', '1e14', '99999999999999.99'];
    for (const amount of bad) {
      it(`YTD entry with amount ${JSON.stringify(amount)}`, async () => {
        const ctx = await newCompany(`Retest YTD bad ${amount}`);
        const e = await createEmployee(ctx, { firstName: 'Bad', lastName: 'Amt', payType: 'hourly', payRate: '20' });
        const before = await paycheckRows(ctx);
        await expect(
          createYtdAdjustment(ctx, { employeeId: e.id, date: d('2026-03-31'), lines: [{ kind: 'earning', name: 'Salary', amount }] }),
        ).rejects.toSatisfy(isInvalidAmount);
        expect(await paycheckRows(ctx)).toBe(before);
      });

      it(`liability adjustment (posting) with amount ${JSON.stringify(amount)}`, async () => {
        const ctx = await newCompany(`Retest Liab bad ${amount}`);
        const e = await createEmployee(ctx, { firstName: 'Bad', lastName: 'Liab', payType: 'hourly', payRate: '20' });
        const before = await paycheckRows(ctx);
        const entries = await entryRows(ctx);
        await expect(
          createLiabilityAdjustment(ctx, {
            employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true,
            lines: [{ kind: 'tax', name: 'Federal Income Tax', amount }],
          }),
        ).rejects.toSatisfy(isInvalidAmount);
        expect(await paycheckRows(ctx)).toBe(before);
        expect(await entryRows(ctx)).toBe(entries);
      });
    }
  });

  // -------------------------------------------------------------------------
  // E3 / E5 — control accounts as offsets would break subledger == control
  // -------------------------------------------------------------------------
  describe('A/R and A/P control accounts are never used as payroll offsets', () => {
    it('a liability adjustment offset to Accounts Receivable is refused or leaves A/R control == aging', async () => {
      const ctx = await newCompany('Retest Offset AR');
      const e = await createEmployee(ctx, { firstName: 'Off', lastName: 'Set', payType: 'hourly', payRate: '20' });
      const ar = await acct(ctx, '1200');
      const attempt = createLiabilityAdjustment(ctx, {
        employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, offsetAccountId: ar.id,
        lines: [{ kind: 'tax', name: 'Federal Income Tax', amount: '75.00' }],
      });
      await attempt.catch((err) => expect(err).toMatchObject({ code: 'VALIDATION' }));
      const rec = await arApReconciliation(ctx);
      expect(rec.ar.difference, `A/R control ${rec.ar.control} vs aging ${rec.ar.aging}`).toBe('0.00');
    });

    it('a posting YTD entry whose "bank" account is Accounts Payable is refused or leaves A/P control == aging', async () => {
      const ctx = await newCompany('Retest Bank AP');
      const e = await createEmployee(ctx, { firstName: 'Bank', lastName: 'Ap', payType: 'hourly', payRate: '20' });
      const ap = await acct(ctx, '2000');
      const attempt = createYtdAdjustment(ctx, {
        employeeId: e.id, date: d('2026-03-31'), affectsAccounts: true, bankAccountId: ap.id,
        lines: [{ kind: 'earning', name: 'Salary', amount: '1000.00' }],
      });
      await attempt.catch((err) => expect(err).toMatchObject({ code: 'VALIDATION' }));
      const rec = await arApReconciliation(ctx);
      expect(rec.ap.difference, `A/P control ${rec.ap.control} vs aging ${rec.ap.aging}`).toBe('0.00');
    });
  });

  // -------------------------------------------------------------------------
  // L6 — A/P mirror of the re-import + new payment case
  // -------------------------------------------------------------------------
  it('L6 A/P: re-importing a file plus one new BILLPMT applies only the new payment', async () => {
    const ctx = await newCompany('Retest AP Reimport');
    const t = (...c: string[]) => c.join('\t');
    const HDR = [
      t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'PAID', 'OPENBAL'),
      t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
      t('!ENDTRNS'),
    ];
    const bill = [
      t('TRNS', '', 'BILL', '12/01/2025', 'Accounts Payable', 'Again Supply', '-500.00', 'B-1', '', 'N', ''),
      t('SPL', '', 'BILL', '12/01/2025', 'Office Supplies', '', '500.00', 'B-1', ''),
      t('ENDTRNS'),
    ];
    const pay = (date: string, amt: string, num: string) => [
      t('TRNS', '', 'BILLPMT', date, 'Checking', 'Again Supply', `-${amt}`, num, '', '', ''),
      t('SPL', '', 'BILLPMT', date, 'Accounts Payable', 'Again Supply', amt, num, ''),
      t('ENDTRNS'),
    ];
    const opts = { openItems: { asDocuments: true, alreadyInGl: false } };
    const file = (...blocks: string[][]) => [...HDR, ...blocks.flat()].join('\r\n');
    await importIIF(ctx, file(bill, pay('12/10/2025', '200.00', '101')), opts);
    let rec = await arApReconciliation(ctx);
    expect(rec.ap.aging).toBe('300.00');
    await importIIF(ctx, file(bill, pay('12/10/2025', '200.00', '101'), pay('12/15/2025', '100.00', '102')), opts);
    rec = await arApReconciliation(ctx);
    expect(rec.ap.difference).toBe('0.00');
    await booksBalanced(ctx);
    expect(Math.abs(await bal(ctx, '1000'))).toBe(300);
    expect(rec.ap.aging, 'paid 300 of a 500 bill: 200 still owed').toBe('200.00');
  });
});
