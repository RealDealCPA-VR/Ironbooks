/**
 * The assistant can propose a CUSTOMER INVOICE (lib/services/aiAssistant.ts
 * createInvoiceProposal): customer by name, lines by income account code (or item name),
 * stored pending; approving it creates the invoice through Create Invoices (A/R posted, books
 * balanced). Nothing is written until approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, customers, invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { approveProposal, createProposal } from './aiAssistant';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-invoice-proposal');
let db: DB;
let ctx: ServiceContext;
let incomeCode: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'invprop@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Invoice Proposal Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  await db.insert(customers).values({ companyId: company.id, displayName: 'Smith Family' });
  const income = (await db.select().from(accounts).where(eq(accounts.companyId, company.id))).find((a) => a.type === 'revenue' && a.isActive);
  incomeCode = income!.code;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('assistant invoice proposals', () => {
  it('refuses an unknown customer with near matches, and a non-income account', async () => {
    await expect(
      createProposal(ctx, { type: 'invoice', customerName: 'Smith Co', date: '2026-03-01', lines: [{ accountCode: incomeCode, quantity: 1, rate: '10' }] }),
    ).rejects.toThrow(/No customer named "Smith Co".*Did you mean "Smith Family"/);
    const notIncome = (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).find((a) => a.type === 'expense')!;
    await expect(
      createProposal(ctx, { type: 'invoice', customerName: 'Smith Family', date: '2026-03-01', lines: [{ accountCode: notIncome.code, quantity: 1, rate: '10' }] }),
    ).rejects.toThrow(/not an income account/);
  });

  it('stores a pending invoice and creates it on approval', async () => {
    const p = await createProposal(ctx, {
      type: 'invoice',
      customerName: 'smith family',
      date: '2026-03-01',
      lines: [{ accountCode: incomeCode, description: 'Kitchen design', quantity: 3, rate: '150.00' }],
    });
    expect(p.kind).toBe('invoice');
    expect(p.payload.totalDebit).toBe('450.00');
    expect(await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId))).toHaveLength(0);

    const approved = await approveProposal(ctx, p.id);
    expect(approved.resultRef).toMatch(/^invoice:/);
    const [inv] = await db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
    expect(Number(inv.total)).toBe(450);
    const tb = await trialBalance(ctx);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
