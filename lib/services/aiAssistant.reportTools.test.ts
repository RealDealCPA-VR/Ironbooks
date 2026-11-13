/**
 * The assistant's report tools beyond P&L / Balance Sheet / aging (lib/services/aiAssistant.ts
 * TOOLS): open invoices, sales by customer, spending by vendor and cash flow — each a read-only
 * wrapper over the report the person can open themselves, with that report's permission. Without
 * an AI model, the offline mode answers the same questions from the same tools.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, customers, users, vendors } from '@/lib/db/schema';
import { unionRoles } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { approveProposal, ask, createProposal, runTool } from './aiAssistant';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-report-tools');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'tools@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Report Tools Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  await db.insert(customers).values([
    { companyId: company.id, displayName: 'Big Buyer LLC' },
    { companyId: company.id, displayName: 'Small Shop' },
  ]);
  await db.insert(vendors).values({ companyId: company.id, displayName: 'Paper Supply Co' });
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const income = all.find((a) => a.type === 'revenue' && a.isActive)!.code;
  const expense = all.find((a) => a.type === 'expense' && a.isActive)!.code;
  const make = async (input: Record<string, unknown>) => approveProposal(ctx, (await createProposal(ctx, input as never)).id);
  await make({ type: 'invoice', customerName: 'Big Buyer LLC', date: '2026-02-01', dueDate: '2026-03-01', lines: [{ accountCode: income, quantity: 1, rate: '900.00' }] });
  await make({ type: 'invoice', customerName: 'Small Shop', date: '2026-04-01', dueDate: '2099-01-01', lines: [{ accountCode: income, quantity: 2, rate: '50.00' }] });
  await make({ type: 'bill', vendorName: 'Paper Supply Co', date: '2026-03-10', lines: [{ accountCode: expense, amount: '120.00' }] });
}, 120_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('assistant report tools', () => {
  it('open_invoices lists unpaid invoices, most overdue first, and filters by customer', async () => {
    const r = (await runTool(ctx, 'open_invoices', {})) as { invoices: { customer: string; balanceDue: string; daysOverdue: number }[]; count: number; totalOpen: string };
    expect(r.count).toBe(2);
    expect(r.invoices[0]).toMatchObject({ customer: 'Big Buyer LLC', balanceDue: '900.00' });
    expect(r.invoices[0].daysOverdue).toBeGreaterThan(0);
    expect(Number(r.totalOpen)).toBe(1000);
    const one = (await runTool(ctx, 'open_invoices', { customer: 'small' })) as { count: number; totalOpen: string };
    expect(one).toMatchObject({ count: 1, totalOpen: '100.00' });
  });

  it('sales_by_customer and expenses_by_vendor rank largest first', async () => {
    const s = (await runTool(ctx, 'sales_by_customer', { from: '2026-01-01', to: '2026-12-31' })) as { customers: { customer: string; sales: string }[]; total: string };
    expect(s.customers.map((c) => c.customer)).toEqual(['Big Buyer LLC', 'Small Shop']);
    expect(Number(s.total)).toBe(1000);
    const v = (await runTool(ctx, 'expenses_by_vendor', { from: '2026-01-01', to: '2026-12-31' })) as { vendors: { vendor: string; spent: string }[] };
    expect(v.vendors[0]).toMatchObject({ vendor: 'Paper Supply Co' });
    expect(Number(v.vendors[0].spent)).toBe(120);
  });

  it('cash_flow returns the three sections and the net change', async () => {
    const r = (await runTool(ctx, 'cash_flow', { from: '2026-01-01', to: '2026-12-31' })) as Record<string, { total?: string } | string>;
    expect(Object.keys(r)).toEqual(expect.arrayContaining(['operating', 'investing', 'financing', 'netCashChange']));
  });

  it('each tool needs the same right as its report', async () => {
    const financialOnly = {
      ...ctx,
      role: 'admin' as const,
      access: unionRoles([{ key: 'fin', name: 'Financial reports', description: '', builtin: false, permissions: { reports_financial: ['view'] }, flags: {} } as never]),
    };
    await expect(runTool(financialOnly as never, 'open_invoices', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runTool(financialOnly as never, 'expenses_by_vendor', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('offline mode (no AI connected) answers these questions from the tools', async () => {
    const open = await ask(ctx, [], 'Show me the open invoices');
    expect(open.mode).toBe('offline');
    expect(open.toolCalls[0].tool).toBe('open_invoices');
    expect(open.answer).toMatch(/2 open invoice\(s\).*Big Buyer LLC/);
    expect((await ask(ctx, [], 'Who are my top customers this year?')).toolCalls[0].tool).toBe('sales_by_customer');
    expect((await ask(ctx, [], 'Spending by vendor this year')).toolCalls[0].tool).toBe('expenses_by_vendor');
    const cf = await ask(ctx, [], 'What was our cash flow this year?');
    expect(cf.toolCalls[0].tool).toBe('cash_flow');
    expect(cf.answer).toMatch(/net change in cash/);
  });
});
