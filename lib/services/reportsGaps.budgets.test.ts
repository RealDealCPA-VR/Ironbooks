/**
 * Report gaps round — H17 budgets & forecasts:
 *  - a budget is by Account only, by Class or by Customer:Job (QB "criteria"): class lines and
 *    company-wide lines in one budget double counted in Budget vs. Actual (bug → refused now);
 *  - Create from actuals (QB "Create budget from previous year's actual data"), for the whole
 *    company, one class or one Customer:Job, and month-end balances for balance-sheet budgets;
 *  - Copy and adjust (a budget or forecast into another year, +/- a percentage) and Adjust Row
 *    Amounts (+/- a percentage from a month on);
 *  - Budget Overview / Budget vs. Actual by class.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, budgetLines, budgets, classes, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createBudget, getBudget, setBudgetLine } from './budgets';
import { adjustBudget, copyBudget, fillBudgetFromActuals } from './budgetTools';
import { runStandardReport } from './reportRegistry';
import { unionRoles } from '@/lib/permissions/model';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-budgets');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const amountOf = (lines: { accountId: string; month: number; amount: string; classId?: string | null; customerId?: string | null }[], accountId: string, month: number) =>
  lines.find((l) => l.accountId === accountId && l.month === month)?.amount;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'budgets@test.local', name: 'Budgets', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Budget Tools Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const company2 = await createCompany(db, { name: 'Other Budget Co', ownerId: user.id });
  other = { db, companyId: company2.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  const [east] = await db.insert(classes).values({ companyId: company.id, name: 'East' }).returning();
  S.east = east.id;
  S.cust = (await createCustomer(ctx, { displayName: 'Acme' } as never)).id;
  S.vendor = (await createVendor(ctx, { displayName: 'Landlord' } as never)).id;
  // FY2025 actuals: March sales 1,000 (East), 400 (no class); March rent 300 costed to Acme; June sales 200.
  await createInvoice(ctx, { customerId: S.cust, date: d('2025-03-10'), dueDate: d('2025-04-10'), classId: S.east, lines: [{ accountId: A['4000'], quantity: 1, rate: '1000.00', taxable: false, classId: S.east }] } as never);
  await createInvoice(ctx, { customerId: S.cust, date: d('2025-03-12'), dueDate: d('2025-04-12'), lines: [{ accountId: A['4000'], quantity: 1, rate: '400.00', taxable: false }] } as never);
  await createInvoice(ctx, { customerId: S.cust, date: d('2025-06-01'), dueDate: d('2025-07-01'), lines: [{ accountId: A['4000'], quantity: 1, rate: '200.00', taxable: false }] } as never);
  await createBill(ctx, { vendorId: S.vendor, date: d('2025-03-15'), lines: [{ accountId: A['6400'], amount: '300.00', customerId: S.cust }] } as never);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('budget criteria (bug: class lines doubled the company budget)', () => {
  it('a budget holds company-wide amounts, class amounts or Customer:Job amounts — never a mix', async () => {
    const b = await createBudget(ctx, { name: 'Mixed', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A['4000'], month: 1, amount: '100.00' });
    await expect(setBudgetLine(ctx, { budgetId: b.id, accountId: A['4000'], month: 1, amount: '50.00', classId: S.east })).rejects.toMatchObject({ code: 'VALIDATION' });
    const byClass = await createBudget(ctx, { name: 'By class', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: byClass.id, accountId: A['4000'], month: 1, amount: '50.00', classId: S.east });
    await expect(setBudgetLine(ctx, { budgetId: byClass.id, accountId: A['4000'], month: 2, amount: '10.00' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(setBudgetLine(ctx, { budgetId: byClass.id, accountId: A['4000'], month: 2, amount: '10.00', customerId: S.cust })).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await runStandardReport(ctx, 'budget-vs-actual-report', { budgetId: b.id });
    const row = r.rows.find((x) => x.id.endsWith(`:a:${A['4000']}`))!;
    expect(row.cells.total_bud).toBe('100.00');
  });
});

describe('Create from actuals', () => {
  it('fills a P&L budget with last fiscal year’s monthly actuals', async () => {
    const b = await createBudget(ctx, { name: 'FY26 from actuals', fiscalYear: 2026 });
    const res = await fillBudgetFromActuals(ctx, b.id, {});
    expect(res.lines).toBeGreaterThan(0);
    const { lines } = await getBudget(ctx, b.id);
    expect(amountOf(lines, A['4000'], 3)).toBe('1400.00');
    expect(amountOf(lines, A['4000'], 6)).toBe('200.00');
    expect(amountOf(lines, A['6400'], 3)).toBe('300.00');
    expect(amountOf(lines, A['4000'], 4)).toBeUndefined();
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, b.id), eq(auditLogs.entityType, 'budget')));
    expect(audits.some((a) => (a.newValues as Record<string, unknown> | null)?.filledFromActuals === 2025)).toBe(true);
  });

  it('for one class or one Customer:Job (job-costed expenses included)', async () => {
    const byClass = await createBudget(ctx, { name: 'East FY26', fiscalYear: 2026 });
    await fillBudgetFromActuals(ctx, byClass.id, { classId: S.east });
    const cl = (await getBudget(ctx, byClass.id)).lines;
    expect(amountOf(cl, A['4000'], 3)).toBe('1000.00');
    expect(cl.every((l) => l.classId === S.east)).toBe(true);
    const byJob = await createBudget(ctx, { name: 'Acme FY26', fiscalYear: 2026 });
    await fillBudgetFromActuals(ctx, byJob.id, { customerId: S.cust });
    const jl = (await getBudget(ctx, byJob.id)).lines;
    expect(amountOf(jl, A['4000'], 3)).toBe('1400.00');
    expect(amountOf(jl, A['6400'], 3)).toBe('300.00');
    expect(jl.every((l) => l.customerId === S.cust)).toBe(true);
  });

  it('a balance-sheet budget gets month-end balances', async () => {
    const b = await createBudget(ctx, { name: 'BS FY26', fiscalYear: 2026, kind: 'balance_sheet' });
    await fillBudgetFromActuals(ctx, b.id, {});
    const { lines } = await getBudget(ctx, b.id);
    expect(amountOf(lines, A['1200'], 3)).toBe('1400.00');
    expect(amountOf(lines, A['1200'], 6)).toBe('1600.00');
    expect(amountOf(lines, A['1200'], 12)).toBe('1600.00');
    expect(lines.some((l) => l.accountId === A['4000'])).toBe(false);
  });

  it('replaces the slice it fills, and refuses another company’s budget', async () => {
    const b = await createBudget(ctx, { name: 'Refill', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A['6600'], month: 1, amount: '99.00' });
    await fillBudgetFromActuals(ctx, b.id, {});
    const { lines } = await getBudget(ctx, b.id);
    expect(amountOf(lines, A['6600'], 1)).toBeUndefined();
    await expect(fillBudgetFromActuals(other, b.id, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(fillBudgetFromActuals(ctx, b.id, { classId: S.east, customerId: S.cust })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('Copy and adjust', () => {
  it('copies a budget into another year with a percentage change (cents rounded)', async () => {
    const src = await createBudget(ctx, { name: 'Base', fiscalYear: 2026 });
    await setBudgetLine(ctx, { budgetId: src.id, accountId: A['4000'], month: 1, amount: '1000.00' });
    await setBudgetLine(ctx, { budgetId: src.id, accountId: A['6400'], month: 2, amount: '333.33' });
    const copy = await copyBudget(ctx, src.id, { name: 'Base +10%', fiscalYear: 2027, percent: '10' });
    expect(copy.fiscalYear).toBe(2027);
    const { lines } = await getBudget(ctx, copy.id);
    expect(amountOf(lines, A['4000'], 1)).toBe('1100.00');
    expect(amountOf(lines, A['6400'], 2)).toBe('366.66');
    // As a forecast.
    const fc = await copyBudget(ctx, src.id, { name: 'Forecast', fiscalYear: 2027, isForecast: true });
    expect(fc.isForecast).toBe(true);
    expect(amountOf((await getBudget(ctx, fc.id)).lines, A['4000'], 1)).toBe('1000.00');
    const ov = await runStandardReport(ctx, 'forecast-overview', { budgetId: fc.id });
    expect(ov.title).toBe('Forecast Overview');
    await expect(copyBudget(ctx, src.id, { name: '  ', fiscalYear: 2027 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(copyBudget(other, src.id, { name: 'x', fiscalYear: 2027 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adjusts row amounts by a percentage from a month on, for one slice', async () => {
    const b = await createBudget(ctx, { name: 'Adjust', fiscalYear: 2026 });
    for (const m of [1, 2, 3]) await setBudgetLine(ctx, { budgetId: b.id, accountId: A['4000'], month: m, amount: '100.00' });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A['6400'], month: 3, amount: '50.00' });
    const res = await adjustBudget(ctx, b.id, { percent: '-20', fromMonth: 2, accountIds: [A['4000']] });
    expect(res.lines).toBe(2);
    const { lines } = await getBudget(ctx, b.id);
    expect(amountOf(lines, A['4000'], 1)).toBe('100.00');
    expect(amountOf(lines, A['4000'], 2)).toBe('80.00');
    expect(amountOf(lines, A['4000'], 3)).toBe('80.00');
    expect(amountOf(lines, A['6400'], 3)).toBe('50.00');
    await expect(adjustBudget(ctx, b.id, { percent: 'abc' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(adjustBudget(ctx, b.id, { percent: '-150' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('Budget reports by class', () => {
  it('Budget Overview and Budget vs. Actual of a class budget', async () => {
    const b = await createBudget(ctx, { name: 'East FY25', fiscalYear: 2025 });
    await setBudgetLine(ctx, { budgetId: b.id, accountId: A['4000'], month: 3, amount: '900.00', classId: S.east });
    const ov = await runStandardReport(ctx, 'budget-overview', { budgetId: b.id, classId: S.east });
    expect(ov.rows.find((x) => x.id.endsWith(`:a:${A['4000']}`))!.cells.m3).toBe('900.00');
    const bva = await runStandardReport(ctx, 'budget-vs-actual-report', { budgetId: b.id, classId: S.east });
    const row = bva.rows.find((x) => x.id.endsWith(`:a:${A['4000']}`))!;
    expect(row.cells.total_act).toBe('1000.00');
    expect(row.cells.total_bud).toBe('900.00');
    const [kept] = await db.select().from(budgets).where(eq(budgets.id, b.id));
    expect(kept.companyId).toBe(ctx.companyId);
    expect((await db.select().from(budgetLines).where(eq(budgetLines.budgetId, b.id))).length).toBe(1);
  });
});

describe('Create from actuals needs the right to see actuals (post-merge review)', () => {
  it('a Budgets-only user may not copy actual P&L amounts into a budget', async () => {
    const role = (grant: Record<string, string[]>) =>
      unionRoles([{ key: 'custom-activities', name: 'Custom', description: '', builtin: false, permissions: grant as never, flags: {} }]);
    const b = await createBudget(ctx, { name: 'Budgets only', fiscalYear: 2026 });
    const budgetsOnly = { ...ctx, access: role({ 'company.budgets': ['view', 'create', 'modify'] }) };
    await expect(fillBudgetFromActuals(budgetsOnly, b.id, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getBudget(ctx, b.id)).lines ?? []).toEqual([]);
    const withReports = { ...ctx, access: role({ 'company.budgets': ['view', 'create', 'modify'], 'reports_financial.company': ['view'] }) };
    await expect(fillBudgetFromActuals(withReports, b.id, {})).resolves.toMatchObject({ lines: expect.any(Number) });
  });
});
