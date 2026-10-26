/**
 * Review round 5 — budget lines.
 *  - Two saves of the same cell at once (double submit, two people) keep ONE line, so Budget vs.
 *    Actual does not double the budget.
 *  - A save that is refused (view-only role) leaves nothing behind (the line used to be written
 *    before the audit check refused it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, budgetLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { budgetVsActual, createBudget, setBudgetLine } from './budgets';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-budgets');
let db: DB;
let ctx: ServiceContext;
const A: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r5-budget@test.local', name: 'R5 Budget', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Budget Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('setBudgetLine', () => {
  it('two saves of the same cell at once keep one line', async () => {
    const b = await createBudget(ctx, { name: 'Race', fiscalYear: 2026 });
    await Promise.all([
      setBudgetLine(ctx, { budgetId: b.id, accountId: A['6400'], month: 3, amount: '500.00' }),
      setBudgetLine(ctx, { budgetId: b.id, accountId: A['6400'], month: 3, amount: '500.00' }),
    ]);
    const rows = await db.select().from(budgetLines).where(and(eq(budgetLines.budgetId, b.id), eq(budgetLines.month, 3)));
    expect(rows.length).toBe(1);
    const bva = await budgetVsActual(ctx, b.id);
    expect(bva.rows.find((r) => r.accountId === A['6400'])?.budget).toBe('500.00');
  });

  it('a refused save (view-only role) writes nothing', async () => {
    const b = await createBudget(ctx, { name: 'Viewer', fiscalYear: 2026 });
    await expect(
      setBudgetLine({ ...ctx, role: 'viewer' }, { budgetId: b.id, accountId: A['6400'], month: 4, amount: '10.00' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await db.select().from(budgetLines).where(eq(budgetLines.budgetId, b.id))).length).toBe(0);
  });
});
