/**
 * Tests for the EasyStep-style setup interview plan (lib/onboarding.ts).
 *
 * Unit: fiscal-year conversion, code collision handling, which preferences each answer turns on.
 * Integration (hermetic PGlite dir): the plan applied through the real services — settings pass
 * the /api/company zod schema and survive the updateCompany whitelist, template accounts are
 * created without duplicates, and the books stay balanced (no opening balances are posted).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { createCompany, getCompany, updateCompany } from '@/lib/services/company';
import { createAccount, listAccounts } from '@/lib/services/accounts';
import { trialBalance } from '@/lib/services/reports';
import { companySettingsSchema } from '@/lib/validation/company';
import {
  BUSINESS_TYPES,
  buildSetupPlan,
  fiscalYearEndFromStartMonth,
  fiscalYearStartMonthFromEnd,
  nextFreeCode,
  type InterviewAnswers,
} from './onboarding';

const base: InterviewAnswers = {
  businessType: 'retail',
  fiscalYearStartMonth: 1,
  reportBasis: 'accrual',
  salesTax: true,
  inventory: true,
  employees: false,
};

describe('fiscal year helpers', () => {
  it('converts a start month to the fiscal-year-end setting', () => {
    expect(fiscalYearEndFromStartMonth(1)).toBe('12-31');
    expect(fiscalYearEndFromStartMonth(7)).toBe('06-30');
    expect(fiscalYearEndFromStartMonth(3)).toBe('02-28');
    expect(fiscalYearEndFromStartMonth(10)).toBe('09-30');
    expect(() => fiscalYearEndFromStartMonth(13)).toThrow();
  });

  it('round-trips through fiscalYearStartMonthFromEnd', () => {
    for (let m = 1; m <= 12; m++) {
      expect(fiscalYearStartMonthFromEnd(fiscalYearEndFromStartMonth(m))).toBe(m);
    }
    expect(fiscalYearStartMonthFromEnd(undefined)).toBe(1);
    expect(fiscalYearStartMonthFromEnd('garbage')).toBe(1);
  });
});

describe('nextFreeCode', () => {
  it('steps numeric codes and suffixes non-numeric ones', () => {
    expect(nextFreeCode('5020', new Set())).toBe('5020');
    expect(nextFreeCode('5020', new Set(['5020', '5021']))).toBe('5022');
    expect(nextFreeCode('X', new Set(['X', 'X-2']))).toBe('X-3');
  });
});

describe('buildSetupPlan', () => {
  it('turns on preferences matching the answers', () => {
    const p = buildSetupPlan({ ...base, fiscalYearStartMonth: 7, reportBasis: 'cash' });
    expect(p.settings).toMatchObject({
      industry: 'retail',
      fiscalYearEnd: '06-30',
      reportBasis: 'cash',
      defaultCustomerTerms: 'due_on_receipt',
      negativeStockWarning: true,
    });
    expect(p.settings.payrollPayPeriod).toBeUndefined();

    const withPayroll = buildSetupPlan({ ...base, employees: true, inventory: false });
    expect(withPayroll.settings).toMatchObject({
      payrollPayPeriod: 'biweekly',
      payrollStandardHours: 40,
      negativeStockWarning: false,
    });
    expect(withPayroll.accounts.map((a) => a.name)).toContain('Payroll Tax Expense');
    expect(withPayroll.nextSteps.map((s) => s.href)).toContain('/employees');
  });

  it('every business type produces settings accepted by the Preferences schema', () => {
    for (const bt of BUSINESS_TYPES) {
      const p = buildSetupPlan({ ...base, businessType: bt.value, employees: true });
      expect(() => companySettingsSchema.parse(p.settings), bt.value).not.toThrow();
    }
  });

  it('adds sales-tax / inventory next steps only when answered yes', () => {
    const yes = buildSetupPlan(base).nextSteps.map((s) => s.href);
    expect(yes).toContain('/sales-tax-components');
    expect(yes).toContain('/inventory-ops');
    const no = buildSetupPlan({ ...base, salesTax: false, inventory: false }).nextSteps.map((s) => s.href);
    expect(no).not.toContain('/sales-tax-components');
    expect(no).not.toContain('/inventory-ops');
  });

  it('dedupes by name and moves colliding codes', () => {
    const p = buildSetupPlan(base, [
      { code: '4010', name: 'Something Else' },
      { code: '5010', name: 'Merchandise Purchases' },
    ]);
    const names = p.accounts.map((a) => a.name);
    expect(names).not.toContain('Merchandise Purchases');
    expect(p.accounts.find((a) => a.name === 'Merchandise Sales')?.code).toBe('4011');
    // Freight In appears in both the retail template and the inventory extras — only once.
    expect(names.filter((n) => n === 'Freight In')).toHaveLength(1);
    expect(new Set(p.accounts.map((a) => a.code)).size).toBe(p.accounts.length);
  });
});

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-onboarding-plan');
let db: DB;
let ctx: ServiceContext;

describe('setup plan applied through the services (integration)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'easystep@test.local', name: 'Easy Step', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'EasyStep Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function apply(answers: InterviewAnswers) {
    const existing = await listAccounts(ctx, { includeInactive: true });
    const plan = buildSetupPlan(answers, existing);
    await updateCompany(ctx, { settings: companySettingsSchema.parse(plan.settings) });
    for (const a of plan.accounts) await createAccount(ctx, { ...a });
    return plan;
  }

  it('creates the industry accounts and persists the preferences', async () => {
    const answers: InterviewAnswers = { ...base, businessType: 'construction', employees: true };
    const plan = await apply(answers);
    expect(plan.accounts.length).toBeGreaterThan(0);

    const names = (await listAccounts(ctx)).map((a) => a.name);
    for (const a of plan.accounts) expect(names).toContain(a.name);

    const company = await getCompany(ctx);
    expect(company?.settings).toMatchObject({
      industry: 'construction',
      fiscalYearEnd: '12-31',
      payrollPayPeriod: 'biweekly',
      negativeStockWarning: true,
    });

    // Running the interview again adds nothing (idempotent).
    const again = buildSetupPlan(answers, await listAccounts(ctx, { includeInactive: true }));
    expect(again.accounts).toHaveLength(0);

    // No opening balances were posted: trial balance is empty and balanced.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });
});
