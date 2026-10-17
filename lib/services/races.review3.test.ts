/**
 * Review round 3: double-submit races (two identical requests in flight at once).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, journalEntries, creditMemos, vendorCredits, paymentsReceived, invoices, bills, purchaseOrderLines } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createCreditMemo, applyToInvoice, refundCreditMemo, voidCreditMemo } from './creditMemos';
import { createBill, voidBill } from './bills';
import { createPurchaseOrder, convertToBill } from './purchaseOrders';
import { createVendorCredit, applyToBill, refundVendorCredit, unapplyFromBill } from './vendorCredits';
import { receivePayment, applyPayment, refundPayment } from './payments';
import { createDeposit } from './deposits';
import { closePeriod } from './fiscalPeriods';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-races');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
const D = (s: string) => new Date(s + 'T12:00:00Z');

async function postedWithSource(sourceRef: string) {
  return db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef), eq(journalEntries.status, 'posted')));
}

describe('review3 races', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r3r@test.local', name: 'R3R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R3R Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['3000', 'Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['5000', 'Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'C1', taxable: false }).returning();
    customerId = c.id;
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'V1' }).returning();
    vendorId = v.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('credit memo: two concurrent applies of the whole credit to two invoices apply it only once', async () => {
    const inv1 = await createInvoice(ctx, { customerId, date: D('2026-03-01'), lines: [{ quantity: 1, rate: '100.00' }] });
    const inv2 = await createInvoice(ctx, { customerId, date: D('2026-03-01'), lines: [{ quantity: 1, rate: '100.00' }] });
    const memo = await createCreditMemo(ctx, { customerId, date: D('2026-03-02'), lines: [{ description: 'x', quantity: 1, rate: '100.00' }] });
    const res = await Promise.allSettled([
      applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv1.id, amount: '100.00' }),
      applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv2.id, amount: '100.00' }),
    ]);
    const [i1] = await db.select().from(invoices).where(eq(invoices.id, inv1.id));
    const [i2] = await db.select().from(invoices).where(eq(invoices.id, inv2.id));
    const credited = Number(i1.amountPaid) + Number(i2.amountPaid);
    expect(credited).toBe(100);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('credit memo: two concurrent refunds of the whole credit write only one refund check', async () => {
    const memo = await createCreditMemo(ctx, { customerId, date: D('2026-03-05'), lines: [{ description: 'x', quantity: 1, rate: '60.00' }] });
    const args = { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '60.00', date: D('2026-03-06') };
    const res = await Promise.allSettled([refundCreditMemo(ctx, args), refundCreditMemo(ctx, args)]);
    const checks = await postedWithSource(`refund:${memo.id}`);
    const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id));
    expect(checks).toHaveLength(1);
    expect(m.refundedAmount).toBe('60.00');
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('vendor credit: two concurrent applies of the whole credit to two bills apply it only once', async () => {
    const b1 = await createBill(ctx, { vendorId, date: D('2026-03-01'), lines: [{ accountId: acct['5000'], amount: '80.00' }] });
    const b2 = await createBill(ctx, { vendorId, date: D('2026-03-01'), lines: [{ accountId: acct['5000'], amount: '80.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-03-02'), lines: [{ accountId: acct['5000'], amount: '80.00' }] });
    const res = await Promise.allSettled([
      applyToBill(ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '80.00' }),
      applyToBill(ctx, { vendorCreditId: vc.id, billId: b2.id, amount: '80.00' }),
    ]);
    const [x1] = await db.select().from(bills).where(eq(bills.id, b1.id));
    const [x2] = await db.select().from(bills).where(eq(bills.id, b2.id));
    expect(Number(x1.amountCredited) + Number(x2.amountCredited)).toBe(80);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('vendor credit: two concurrent refunds of the whole credit post only one refund receipt', async () => {
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-03-05'), lines: [{ accountId: acct['5000'], amount: '40.00' }] });
    const args = { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '40.00', date: D('2026-03-06') };
    const res = await Promise.allSettled([refundVendorCredit(ctx, args), refundVendorCredit(ctx, args)]);
    const entries = await postedWithSource(`refund:${vc.id}`);
    const [c] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(entries).toHaveLength(1);
    expect(c.refundedAmount).toBe('40.00');
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('payment: two concurrent applies of the whole unapplied amount to two invoices apply it only once', async () => {
    const inv1 = await createInvoice(ctx, { customerId, date: D('2026-04-01'), lines: [{ quantity: 1, rate: '50.00' }] });
    const inv2 = await createInvoice(ctx, { customerId, date: D('2026-04-01'), lines: [{ quantity: 1, rate: '50.00' }] });
    const { payment } = await receivePayment(ctx, { customerId, date: D('2026-04-02'), method: 'check', amount: '50.00', depositAccountId: acct['1000'], applications: [] });
    const res = await Promise.allSettled([
      applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv1.id, amountApplied: '50.00' }] }),
      applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv2.id, amountApplied: '50.00' }] }),
    ]);
    const [i1] = await db.select().from(invoices).where(eq(invoices.id, inv1.id));
    const [i2] = await db.select().from(invoices).where(eq(invoices.id, inv2.id));
    expect(Number(i1.amountPaid) + Number(i2.amountPaid)).toBe(50);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('payment: two concurrent refunds of the unapplied amount post only one refund', async () => {
    const { payment } = await receivePayment(ctx, { customerId, date: D('2026-04-05'), method: 'check', amount: '30.00', depositAccountId: acct['1000'], applications: [] });
    const args = { paymentId: payment.id, bankAccountId: acct['1000'], amount: '30.00', date: D('2026-04-06') };
    const res = await Promise.allSettled([refundPayment(ctx, args), refundPayment(ctx, args)]);
    const entries = await postedWithSource(`refund:${payment.id}`);
    const [p] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(entries).toHaveLength(1);
    expect(p.unapplied).toBe('0.00');
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('credit memo: a void racing a refund cannot leave a refund check against a voided memo', async () => {
    const memo = await createCreditMemo(ctx, { customerId, date: D('2026-05-01'), lines: [{ description: 'x', quantity: 1, rate: '25.00' }] });
    const res = await Promise.allSettled([
      refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '25.00', date: D('2026-05-02') }),
      voidCreditMemo(ctx, memo.id),
    ]);
    const [m] = await db.select().from(creditMemos).where(eq(creditMemos.id, memo.id));
    const refunds = await postedWithSource(`refund:${memo.id}`);
    const memoEntry = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, memo.postedEntryId!));
    // Never both: the memo's credit reversed (voided) AND a refund check paid out of it.
    expect({ memoStatus: m.status, memoEntry: memoEntry[0]?.status, refunds: refunds.length }).not.toMatchObject({ memoEntry: 'void', refunds: 1 });
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('bill: two concurrent voids of one of two PO bills give back only that bill quantity', async () => {
    const po = await createPurchaseOrder(ctx, { vendorId, date: D('2026-05-04'), lines: [{ accountId: acct['5000'], quantity: 10, rate: 5 }] });
    const [line] = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    const a = await convertToBill(ctx, po.id, { lines: [{ lineId: line.id, quantity: 5 }] });
    await convertToBill(ctx, po.id, { lines: [{ lineId: line.id, quantity: 5 }] });
    await Promise.allSettled([voidBill(ctx, a.id), voidBill(ctx, a.id)]);
    const [l2] = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.id));
    expect(Number(l2.quantityBilled)).toBe(5);
  });

  it('deposit: the same undeposited payment cannot be deposited twice concurrently', async () => {
    await createAccount(ctx, { code: '1050', name: 'Undeposited Funds', type: 'asset' as never, subtype: 'undeposited_funds' });
    const { payment } = await receivePayment(ctx, { customerId, date: D('2026-06-01'), method: 'check', amount: '70.00', applications: [] });
    const res = await Promise.allSettled([
      createDeposit(ctx, { depositAccountId: acct['1000'], date: D('2026-06-02'), paymentIds: [payment.id] }),
      createDeposit(ctx, { depositAccountId: acct['1000'], date: D('2026-06-02'), paymentIds: [payment.id] }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('vendor credit: two concurrent unapplies from two bills both restore the credit (no lost update)', async () => {
    const b1 = await createBill(ctx, { vendorId, date: D('2026-06-05'), lines: [{ accountId: acct['5000'], amount: '20.00' }] });
    const b2 = await createBill(ctx, { vendorId, date: D('2026-06-05'), lines: [{ accountId: acct['5000'], amount: '20.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2026-06-06'), lines: [{ accountId: acct['5000'], amount: '40.00' }] });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '20.00' });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: b2.id, amount: '20.00' });
    const res = await Promise.allSettled([
      unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '20.00' }),
      unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: b2.id, amount: '20.00' }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const [c] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(c.unapplied).toBe('40.00');
  });

  it('invoice: a payment larger than the balance due is refused by markPaidAmount', async () => {
    const inv = await createInvoice(ctx, { customerId, date: D('2026-06-07'), lines: [{ quantity: 1, rate: '10.00' }] });
    const { markPaidAmount } = await import('./invoices');
    await expect(markPaidAmount(ctx, inv.id, '10.01')).rejects.toMatchObject({ code: 'CONFLICT' });
    const ok = await markPaidAmount(ctx, inv.id, '10.00');
    expect(ok.balanceDue).toBe('0.00');
    await markPaidAmount(ctx, inv.id, '-10.00'); // unapplying is never refused
  });

  it('vendor credit: a home-currency application dated in a closed period is refused', async () => {
    const b = await createBill(ctx, { vendorId, date: D('2025-01-05'), lines: [{ accountId: acct['5000'], amount: '15.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId, date: D('2025-01-06'), lines: [{ accountId: acct['5000'], amount: '15.00' }] });
    await closePeriod(ctx, { periodStart: D('2025-01-01'), periodEnd: D('2025-01-31') });
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: b.id, amount: '15.00', date: D('2025-01-20') }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    const [c] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(c.unapplied).toBe('15.00');
    // Dated today (open), the same application goes through.
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: b.id, amount: '15.00' });
  });

  it('books stay balanced', async () => {
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
