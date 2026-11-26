/**
 * Local (city / county) income tax on real paychecks: the employee's local taxes are validated
 * when saved, withheld on each check as their own lines (tax tracking local_tax), posted to the
 * company's local tax payroll item when there is one, and reported on W-2 Boxes 18-20 and the
 * W-3 totals. A place without a rate is never guessed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createEmployee, getEmployee, previewPaycheck, runPaycheck, updateEmployee } from './payroll';
import { createPayrollItem, ensureDefaultPayrollItems } from './payrollItems';
import { w2Data, w3Data } from './payrollReports';
import { trialBalance } from './reports';
import { OTHER_LOCAL } from './localPayrollTax';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-local-tax-paycheck');
let db: DB;
let ctx: ServiceContext;
let localLiabId: string;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function newEmp(first: string, state: string, w4: Record<string, unknown> = {}) {
  const e = await createEmployee(ctx, { firstName: first, lastName: 'Local', payType: 'salary', payRate: '52000' });
  await updateEmployee(ctx, e.id, { address: { line1: '1 Main', city: 'Town', state, zip: '00000' }, w4: { formYear: 2020, filingStatus: 'single', ...w4 } });
  return e.id;
}
const localLines = (lines: Array<{ taxTracking?: string | null; name: string; amount: string }>) =>
  lines.filter((l) => l.taxTracking === 'local_tax').map((l) => [l.name, l.amount]);

describe('local income tax on paychecks', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'local@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const c = await createCompany(db, { name: 'Local Co', ownerId: u.id });
    ctx = { db, companyId: c.id, userId: u.id };
    await ensureDefaultPayrollItems(ctx);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('refuses local taxes that are not complete, in plain words', async () => {
    const id = await newEmp('Val', 'TX');
    const save = (localTaxes: unknown) => updateEmployee(ctx, id, { w4: { formYear: 2020, filingStatus: 'single', localTaxes } });
    await expect(save([{ state: 'TX', jurisdiction: 'NOPE', name: 'X', resident: true }])).rejects.toThrow(/Choose the city or county/);
    await expect(save([{ state: 'TX', jurisdiction: OTHER_LOCAL, name: '', resident: true, percent: '1' }])).rejects.toThrow(/Enter the name/);
    await expect(save([{ state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Smallville', resident: true }])).rejects.toThrow(/percent of wages or an amount/);
    await expect(save([{ state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Smallville', resident: true, percent: '150' }])).rejects.toThrow(/between 0 and 100/);
    await expect(
      save([
        { state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Smallville', resident: true, percent: '1' },
        { state: 'TX', jurisdiction: OTHER_LOCAL, name: 'smallville', resident: false, percent: '2' },
      ]),
    ).rejects.toThrow(/listed twice/);
    // An empty list clears the setting.
    await save([]);
    expect((await getEmployee(ctx, id)).w4).not.toHaveProperty('localTaxes');
  });

  it('withholds a typed-in place by percent or by amount, one line per place', async () => {
    const id = await newEmp('Tess', 'TX', {
      localTaxes: [
        { state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Smallville', resident: true, percent: '1.5' },
        { state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Mill County', resident: false, amountPerCheck: '5.75' },
      ],
    });
    const pv = await previewPaycheck(ctx, { employeeId: id, payDate: d('2026-03-06'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(localLines(pv.lines)).toEqual([
      ['Local Tax (Smallville)', '30.00'],
      ['Local Tax (Mill County)', '5.75'],
    ]);
  });

  it('posts to the local tax payroll item named for the place, and reports W-2 Boxes 18-20 and the W-3 totals', async () => {
    localLiabId = (await createAccount(ctx, { code: '2316', name: 'Local Tax Payable', type: 'liability', subtype: 'other_current_liability' })).id;
    const item = await createPayrollItem(ctx, { name: 'Smallville City Tax', kind: 'tax', taxTracking: 'local_tax', liabilityAccountId: localLiabId });
    const id = await newEmp('Wes', 'TX', {
      localTaxes: [{ state: 'TX', jurisdiction: OTHER_LOCAL, name: 'Smallville', resident: true, percent: '2' }],
    });
    const pc = await runPaycheck(ctx, { employeeId: id, payDate: d('2026-03-06'), grossPay: '2000.00', periodsPerYear: 26 });
    const line = pc.lines.find((l) => l.taxTracking === 'local_tax')!;
    expect(line).toMatchObject({ name: 'Local Tax (Smallville)', amount: '40.00', payrollItemId: item.id });
    const credits = await ctx.db
      .select({ credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, pc.postedEntryId!), eq(journalEntryLines.accountId, localLiabId)));
    expect(credits.map((c) => c.credit)).toEqual(['40.00']);
    expect((await trialBalance(ctx)).balanced).toBe(true);

    const w2 = await w2Data(ctx, { employeeId: id, year: 2026 });
    expect(w2.local).toEqual([{ locality: 'Smallville', wages: '2000.00', withheld: '40.00' }]);
    const w3 = await w3Data(ctx, { year: 2026 });
    expect(w3.localWithheld).toBe('40.00');
    expect(w3.localWages).toBe('2000.00');
  });

  it('a listed city uses its built-in rate, and the state stops reminding about local taxes', async () => {
    // Without a local tax the Pennsylvania check carries the reminder.
    const plain = await newEmp('Pia', 'PA');
    const before = await previewPaycheck(ctx, { employeeId: plain, payDate: d('2026-03-06'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(before.notes.join(' ')).toMatch(/earned income tax/);
    expect(localLines(before.lines)).toEqual([]);

    const id = await newEmp('Phil', 'PA', { localTaxes: [{ jurisdiction: 'PA-PHILADELPHIA', resident: true }] });
    expect((await getEmployee(ctx, id)).w4).toMatchObject({
      localTaxes: [{ state: 'PA', jurisdiction: 'PA-PHILADELPHIA', name: 'Philadelphia', resident: true }],
    });
    const pv = await previewPaycheck(ctx, { employeeId: id, payDate: d('2026-03-06'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(localLines(pv.lines)).toEqual([['Local Tax (Philadelphia)', '74.80']]); // 3.74%
    expect(pv.notes.join(' ')).not.toMatch(/earned income tax/);
    // After July 1, 2026 the new rate applies on its own.
    const july = await previewPaycheck(ctx, { employeeId: id, payDate: d('2026-07-10'), grossPay: '2000.00', periodsPerYear: 26 });
    expect(localLines(july.lines)).toEqual([['Local Tax (Philadelphia)', '74.70']]); // 3.735%
  });

  it('Yonkers residents pay 16.75% of the New York State tax on the check; Indiana counties use the WH-4', async () => {
    const yon = await newEmp('Yuri', 'NY', { localTaxes: [{ jurisdiction: 'NY-YONKERS', resident: true }] });
    const pv = await previewPaycheck(ctx, { employeeId: yon, payDate: d('2026-03-06'), grossPay: '2000.00', periodsPerYear: 26 });
    const stateTax = Number(pv.lines.find((l) => l.taxTracking === 'state_withholding')!.amount);
    expect(stateTax).toBeGreaterThan(0);
    const local = Number(localLines(pv.lines)[0][1]);
    expect(localLines(pv.lines)[0][0]).toBe('Local Tax (Yonkers)');
    expect(Math.abs(local - stateTax * 0.1675)).toBeLessThan(0.006);

    const ind = await newEmp('Ina', 'IN', {
      stateW4: { allowances: 1, dependents: 1 },
      localTaxes: [{ jurisdiction: 'IN-MARION-COUNTY', resident: true }],
    });
    const pvIn = await previewPaycheck(ctx, { employeeId: ind, payDate: d('2026-03-06'), grossPay: '2000.00', periodsPerYear: 26 });
    // (52,000 − 1,000 − 1,500) × 2.02% ÷ 26
    expect(localLines(pvIn.lines)).toEqual([['Local Tax (Marion County)', '38.46']]);
  });
});
