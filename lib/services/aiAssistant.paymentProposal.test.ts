/**
 * The assistant can propose a CUSTOMER PAYMENT (lib/services/aiAssistant.ts
 * createPaymentProposal): the oldest open invoices are paid first unless invoice numbers are
 * given; an overpayment or an unknown invoice is refused; approving records it through Receive
 * Payments (invoice paid, books balanced).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, customers, invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createInvoice } from './invoices';
import { approveProposal, createProposal } from './aiAssistant';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-payment-proposal');
let db: DB;
let ctx: ServiceContext;
let invId: string;
let invNumber: number;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'payprop@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Payment Proposal Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Smith Family' }).returning();
  const income = (await db.select().from(accounts).where(eq(accounts.companyId, company.id))).find((a) => a.type === 'revenue' && a.isActive)!;
  const inv = await createInvoice(ctx, {
    customerId: cust.id,
    date: new Date('2026-02-01T12:00:00Z'),
    lines: [{ accountId: income.id, description: 'Design', quantity: 1, rate: '300.00', taxable: false }],
  });
  invId = inv.id;
  invNumber = (await db.select().from(invoices).where(eq(invoices.id, inv.id)))[0].invoiceNumber;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('assistant payment proposals', () => {
  it('refuses an overpayment and an invoice the customer does not have', async () => {
    await expect(createProposal(ctx, { type: 'payment', customerName: 'Smith Family', date: '2026-03-01', amount: '500.00' })).rejects.toThrow(/more than/);
    await expect(
      createProposal(ctx, { type: 'payment', customerName: 'Smith Family', date: '2026-03-01', amount: '100.00', invoiceNumbers: ['9999'] }),
    ).rejects.toThrow(/no open invoice #9999/);
  });

  it('pays the open invoice on approval through Receive Payments', async () => {
    const p = await createProposal(ctx, { type: 'payment', customerName: 'smith family', date: '2026-03-01', amount: '300.00', method: 'check', reference: '1187' });
    expect(p.kind).toBe('payment');
    expect(p.payload.description).toContain(`#${invNumber}`);
    const approved = await approveProposal(ctx, p.id);
    expect(approved.status).toBe('approved');
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invId));
    expect(Number(inv.balanceDue)).toBe(0);
    const tb = await trialBalance(ctx);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
