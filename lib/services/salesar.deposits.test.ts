/**
 * Team salesar (B7) — Make Deposits, editing a saved deposit: the payments and sales receipts already
 * on it kept no payment method ("payment" / "sales receipt", customer "Already on this deposit"), so
 * the new "View payment method" filter grouped them under a made-up type and a credit-card receipt
 * fell out of the "Credit cards" view. getDeposit now names each line's source (type, Payment
 * Method list entry, customer, reference, date) and the edit form keeps them.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createSalesReceipt } from './salesReceipts';
import { listEntries } from './lists/simpleLists';
import { createDeposit, getDeposit } from './deposits';
import { depositToEdit, type Deposit } from '@/lib/depositEdit';
import { depositMethodViews, matchesDepositMethodView } from '@/lib/salesFormListsClient';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-deposits');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-deposits@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar Deposits ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

describe('Editing a saved deposit keeps each payment’s method', () => {
  it('a Visa payment and a check sales receipt load back with their method, customer and reference', async () => {
    const methods = await listEntries(ctx, 'payment-methods');
    const visa = methods.find((m) => m.name === 'Visa')!;
    const check = methods.find((m) => m.name === 'Check')!;
    const cust = await createCustomer(ctx, { displayName: `Depositor ${seq}` } as never);
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '80.00', taxable: false }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust.id,
      date: d('2026-03-05'),
      amount: '80.00',
      method: 'credit_card',
      paymentMethodId: visa.id,
      reference: 'auth 991',
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    } as never);
    const sr = await createSalesReceipt(ctx, {
      customerId: cust.id,
      date: d('2026-03-06'),
      paymentMethodId: check.id,
      reference: '1042',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '25.00', taxable: false }],
    } as never);
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: d('2026-03-07'),
      paymentIds: [payment.id],
      salesReceiptIds: [sr.id],
    });

    const saved = await getDeposit(ctx, dep.id);
    const edit = depositToEdit(JSON.parse(JSON.stringify(saved)) as Deposit);
    const byId = new Map(edit.items.map((i) => [i.id, i]));
    const p = byId.get(payment.id)!;
    expect(p).toMatchObject({ kind: 'payment', method: 'credit_card', paymentMethodId: visa.id, paymentMethodName: 'Visa', customerName: `Depositor ${seq}`, reference: 'auth 991' });
    expect(p.date.slice(0, 10)).toBe('2026-03-05');
    const r = byId.get(sr.id)!;
    expect(r).toMatchObject({ kind: 'sales_receipt', method: 'check', paymentMethodId: check.id, paymentMethodName: 'Check', customerName: `Depositor ${seq}`, reference: '1042' });

    // The "Credit cards" view of the edit form still lists the Visa payment.
    const views = depositMethodViews(edit.items);
    expect(views.map((v) => v.value)).toContain('group:credit_card');
    expect(edit.items.filter((i) => matchesDepositMethodView(i, 'group:credit_card')).map((i) => i.id)).toEqual([payment.id]);
  });
});
