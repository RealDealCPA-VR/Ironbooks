/**
 * The assistant can propose a VENDOR BILL (lib/services/aiAssistant.ts createBillProposal):
 * vendor by name, expense lines by account code, stored pending; approving it enters the bill
 * through the normal Enter Bills service (A/P posted, books balanced). Bad input is refused
 * with a plain message, and nothing is written until approval.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { approveProposal, createBillProposal, createProposal } from './aiAssistant';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-bill-proposal');
let db: DB;
let ctx: ServiceContext;
let expenseCode: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'billprop@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Bill Proposal Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  await db.insert(vendors).values({ companyId: company.id, displayName: 'Office Supply Co' });
  const expense = (await db.select({ code: accounts.code }).from(accounts).where(eq(accounts.companyId, company.id))).find((a) => /^6/.test(a.code));
  expenseCode = expense!.code;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('assistant bill proposals', () => {
  it('refuses an unknown vendor and suggests near matches', async () => {
    await expect(
      createBillProposal(ctx, { type: 'bill', vendorName: 'Office Supplies Inc', date: '2026-03-01', lines: [{ accountCode: expenseCode, amount: '10' }] }),
    ).rejects.toThrow(/No vendor named "Office Supplies Inc".*Did you mean "Office Supply Co"/);
  });

  it('stores a pending bill and enters it on approval through Enter Bills', async () => {
    const p = await createProposal(ctx, {
      type: 'bill',
      vendorName: 'office supply co',
      date: '2026-03-01',
      dueDate: '2026-03-31',
      billNumber: '1042',
      lines: [{ accountCode: expenseCode, amount: '125.50', description: 'Printer paper' }],
    });
    expect(p.kind).toBe('bill');
    expect(p.status).toBe('pending');
    expect(p.payload.totalDebit).toBe('125.50');
    expect(p.payload.lines.some((l) => l.entityName === 'Office Supply Co' && l.credit === '125.50')).toBe(true);
    expect(await db.select().from(bills).where(eq(bills.companyId, ctx.companyId))).toHaveLength(0);

    const approved = await approveProposal(ctx, p.id);
    expect(approved.status).toBe('approved');
    expect(approved.resultRef).toMatch(/^bill:/);
    const [bill] = await db.select().from(bills).where(eq(bills.companyId, ctx.companyId));
    expect(bill.billNumber).toBe('1042');
    expect(Number(bill.total)).toBe(125.5);
    const tb = await trialBalance(ctx);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
