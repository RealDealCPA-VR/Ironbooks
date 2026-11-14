/**
 * Review loop 5 fixes (memorized transactions, foreign currency, Accountant's Copy):
 *  - month-end schedules return to the 31st after a short month;
 *  - the automatic run enters every due occurrence (none skipped, today's included);
 *  - a failed automatic entry keeps its reason, shown in Reminders; an inactive customer stops it;
 *  - Enter Now inside the days-in-advance window is dated on the scheduled day;
 *  - a foreign overpayment refunded at a typed rate posts the realized gain / loss;
 *  - an accountant's new account whose number the client took meanwhile gets the next free one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { customers, invoices, recurringTemplates, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { advanceDate, createTemplate, enterNowDate, projectOccurrences, runDue } from './recurring';
import { freeAccountCode } from './accountantCopy/client';
import { getReminders } from './reminders';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-fixes');
let db: DB;
let ctx: ServiceContext;
let customerId: string;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'review5@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review Five Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Retainer Client' }).returning())[0].id;
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const invoiceTemplate = () => ({
  customerId,
  lines: [{ description: 'Retainer', quantity: '1', rate: '100.00' }],
});

describe('schedule arithmetic', () => {
  it('a month-end schedule returns to the 31st after February', () => {
    const steps = [d('2026-01-31')];
    for (let i = 0; i < 3; i++) steps.push(advanceDate(steps[steps.length - 1], 'monthly', 31)!);
    expect(steps.map(iso)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(projectOccurrences(d('2026-08-31'), 'quarterly', d('2026-01-01'), d('2027-12-31'), 4, 31).map(iso)).toEqual([
      '2026-08-31',
      '2026-11-30',
      '2027-02-28',
      '2027-05-31',
    ]);
    // A leap-day yearly schedule comes back to Feb 29.
    const y = [d('2028-02-29')];
    for (let i = 0; i < 4; i++) y.push(advanceDate(y[y.length - 1], 'yearly', 29)!);
    expect(iso(y[4])).toBe('2032-02-29');
  });

  it('Enter Now inside the days-in-advance window is dated on the scheduled day', () => {
    const row = { nextRunDate: d('2026-12-01'), frequency: 'monthly', daysInAdvance: 5 };
    expect(iso(enterNowDate(row, d('2026-11-27')))).toBe('2026-12-01');
    expect(iso(enterNowDate(row, d('2026-11-20')))).toBe('2026-11-20'); // early, outside the window
    expect(iso(enterNowDate({ ...row, nextRunDate: d('2026-10-01') }, d('2026-11-14')))).toBe('2026-11-14'); // overdue
  });
});

describe('the automatic run', { timeout: 120_000 }, () => {
  it('stores the day of the month for a monthly template', async () => {
    const tpl = await createTemplate(ctx, { name: 'Month end', docType: 'invoice', frequency: 'monthly', nextRunDate: d('2027-01-31'), mode: 'remind', template: invoiceTemplate() });
    expect(tpl.anchorDay).toBe(31);
  });

  it('enters every due occurrence, today included', async () => {
    const tpl = await createTemplate(ctx, { name: 'Weekly fee', docType: 'invoice', frequency: 'weekly', nextRunDate: d('2026-11-07'), mode: 'automatic', template: invoiceTemplate() });
    const res = await runDue(ctx, d('2026-11-14'));
    const mine = res.generated.filter((g) => g.templateId === tpl.id);
    expect(mine).toHaveLength(2);
    const dates = (await db.select({ date: invoices.date }).from(invoices).where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId))))
      .map((r) => iso(r.date))
      .sort();
    expect(dates).toEqual(expect.arrayContaining(['2026-11-07', '2026-11-14']));
    const [after] = await db.select().from(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    expect(iso(after.nextRunDate)).toBe('2026-11-21');
  });

  it('a long-overdue schedule fires once and skips ahead (no unattended backlog)', async () => {
    const tpl = await createTemplate(ctx, { name: 'Old daily', docType: 'invoice', frequency: 'daily', nextRunDate: d('2025-11-14'), mode: 'automatic', template: invoiceTemplate() });
    const res = await runDue(ctx, d('2026-11-14'));
    expect(res.generated.filter((g) => g.templateId === tpl.id)).toHaveLength(2); // the oldest, then today's
    const [after] = await db.select().from(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    expect(iso(after.nextRunDate)).toBe('2026-11-15');
  });

  it('an inactive customer stops the entry, and the reason is kept and shown in Reminders', async () => {
    const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Gone Client', isActive: false }).returning();
    const tpl = await createTemplate(ctx, {
      name: 'Gone retainer',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: d('2026-11-01'),
      mode: 'automatic',
      template: { customerId: c.id, lines: [{ description: 'Retainer', quantity: '1', rate: '100.00' }] },
    }).catch(() => null);
    expect(tpl).toBeTruthy();
    if (!tpl) return;
    const res = await runDue(ctx, d('2026-11-14'));
    expect(res.failed.find((f) => f.templateId === tpl.id)?.error).toMatch(/inactive/);
    const [row] = await db.select().from(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    expect(row.lastError).toMatch(/inactive/);
    expect(iso(row.nextRunDate)).toBe('2026-11-01'); // still due
    const rem = await getReminders(ctx, { today: '2026-11-14' });
    const items = rem.sections.find((x) => x.key === 'memorizedTransactionsDue')?.items ?? [];
    expect(items.find((r) => r.id === tpl.id)?.label).toMatch(/could not be entered/);
  });
});

describe("Accountant's Copy: account numbers", () => {
  it('a number the client took meanwhile gives the next free one', () => {
    expect(freeAccountCode('6010', new Set(['6000']))).toBe('6010');
    expect(freeAccountCode('6010', new Set(['6010', '6011']))).toBe('6012');
    expect(freeAccountCode('0610', new Set(['0610']))).toBe('0611');
    expect(freeAccountCode('EXP', new Set(['EXP', 'EXP-2']))).toBe('EXP-3');
  });
});
