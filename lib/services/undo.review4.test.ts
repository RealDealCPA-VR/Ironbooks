/**
 * Round-4 review regressions (undo):
 *  A. Undo of a void never re-enters a copy that loses the links the void released (sales-order
 *     / PO quantities, billed time & costs, billed retainage, item-receipt billing, costs already
 *     billed to a customer): no Undo is armed and the server refuses.
 *  B. No Undo for saves with linked effects the inverse can't reverse: vendor credits applied
 *     in Pay Bills, earlier payments used in Receive Payments, a payment edit that took it out
 *     of its deposit.
 *  C. A create whose response has no record id never arms an Undo for an earlier record.
 *  D. Customer price level, E. credit-card credits (sign) and Other Names payees, F. legacy
 *     deposit lines: restored exactly or refused, never silently changed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  customers,
  vendors,
  items,
  invoices,
  salesOrders,
  salesOrderLines,
  purchaseOrders,
  purchaseOrderLines,
  billLines,
  depositLines,
  deposits,
  itemReceiptLines,
  otherNames,
  undoActions,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, getAccount } from './accounts';
import { createManualEntry } from './journal';
import { createInvoice, getInvoice, voidInvoice } from './invoices';
import { createBill, getBill, voidBill } from './bills';
import { createExpense, getExpense, updateExpense, voidExpense } from './expenses';
import { receivePayment, getPayment, updatePayment } from './payments';
import { createDeposit, getDeposit, voidDeposit } from './deposits';
import { payBillsWithCredits, getBillPayment } from './billPayments';
import { createVendorCredit, getVendorCredit } from './vendorCredits';
import { createInvoiceWithBillables, listUnbilled } from './billables';
import { createSalesOrder, convertToInvoice } from './salesOrders';
import { createPurchaseOrder, convertToBill } from './purchaseOrders';
import { createCustomer, getCustomer, updateCustomer } from './customers';
import { createPriceLevel } from './pricing';
import { billRetainage } from './retainage';
import { createItemReceipt } from './itemReceipts';
import { enterBillForReceivedItems, updateReceivingSettings } from './receiving';
import { commitUndo, performUndo, prepareUndo, type UndoKind } from './undo';
import { createdIdOf } from '@/lib/undoClient';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-undo');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let serviceItemId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

/** What the client does around a save: prepare (snapshot) -> action -> commit (arm). */
async function track<T>(resource: string, kind: UndoKind, id: string | null, action: () => Promise<T>) {
  const prepared = kind === 'create' ? null : await prepareUndo(ctx, { resource, kind, id: id! });
  const result = await action();
  const createdId = kind === 'create' ? createdIdOf(result) : null;
  const armed = await commitUndo(ctx, { resource, kind, token: prepared?.token ?? null, id: createdId });
  return { result, token: armed.token };
}

/** Prepare -> void; returns the pending token (commit is the step under test). */
async function voidWithToken(resource: string, id: string, action: () => Promise<unknown>) {
  const { token } = await prepareUndo(ctx, { resource, kind: 'void', id });
  await action();
  return token;
}

async function newCustomer(name: string) {
  return (await db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning())[0].id;
}
async function newVendor(name: string) {
  return (await db.insert(vendors).values({ companyId: ctx.companyId, displayName: name }).returning())[0].id;
}
async function invoiceCount(customerId: string) {
  return (await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.customerId, customerId))).length;
}

describe('review4 undo', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r4@undo.test', name: 'Una', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review4 Undo', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2100', 'Visa', 'liability', 'credit_card'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['6400', 'Job Materials', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    const [svc] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Svc', type: 'service' as never, salesPrice: '100.00', incomeAccountId: acct['4000'] })
      .returning();
    serviceItemId = svc.id;
    await createManualEntry(ctx, {
      date: d('2026-01-01'),
      description: 'Opening funds',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  // ---- A. voids that released links ---------------------------------------------------------

  it('A1: an invoice that billed time & costs: no Undo for its void, and the server refuses a copy', async () => {
    const cust = await newCustomer('Billable Co');
    const vend = await newVendor('Lumber');
    const bill = await createBill(ctx, {
      vendorId: vend,
      date: d('2026-03-01'),
      lines: [{ accountId: acct['6400'], amount: '200.00', customerId: cust, description: 'Lumber for job' }],
    });
    const lineId = (await getBill(ctx, bill.id)).lines[0].id as string;
    const inv = await createInvoiceWithBillables(ctx, { customerId: cust, date: d('2026-03-02'), lines: [] }, { billLineIds: [lineId] });
    const token = await voidWithToken('invoices', inv.id, () => voidInvoice(ctx, inv.id));
    await expect(commitUndo(ctx, { resource: 'invoices', kind: 'void', token })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/Can't undo this void: the invoice had linked billable time and costs.*re-enter the invoice instead/),
    });
    // Even a token armed some other way is refused, and nothing is re-entered.
    await db.update(undoActions).set({ status: 'armed', expiresAt: new Date(Date.now() + 30_000) }).where(eq(undoActions.id, token));
    const before = await invoiceCount(cust);
    await expect(performUndo(ctx, token)).rejects.toThrow(/had linked billable time and costs/);
    expect(await invoiceCount(cust)).toBe(before);
    expect((await listUnbilled(ctx, cust)).costs).toHaveLength(1); // released by the void, billable once
  });

  it('A2: an invoice made from a sales order: no Undo for its void', async () => {
    const cust = await newCustomer('SO Co');
    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      taxRateId: null,
      lines: [{ itemId: serviceItemId, quantity: 4, rate: '100.00', taxable: false }],
    });
    const inv = await convertToInvoice(ctx, so.id);
    const token = await voidWithToken('invoices', inv.id, () => voidInvoice(ctx, inv.id));
    await expect(commitUndo(ctx, { resource: 'invoices', kind: 'void', token })).rejects.toThrow(/had linked sales-order quantities/);
    const [o] = await db.select().from(salesOrders).where(eq(salesOrders.id, so.id));
    const ls = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    expect({ status: o.status, invoiced: ls.map((l) => Number(l.quantityInvoiced)) }).toEqual({ status: 'open', invoiced: [0] });
  });

  it('A3: a bill converted from a purchase order: no Undo for its void', async () => {
    const vend = await newVendor('PO Vendor');
    const po = await createPurchaseOrder(ctx, {
      vendorId: vend,
      date: d('2026-03-06'),
      lines: [{ accountId: acct['6300'], description: 'Paper', quantity: 2, rate: '50.00' }],
    });
    const bill = await convertToBill(ctx, po.id);
    const token = await voidWithToken('bills', bill.id, () => voidBill(ctx, bill.id));
    await expect(commitUndo(ctx, { resource: 'bills', kind: 'void', token })).rejects.toThrow(/the bill had linked purchase-order quantities/);
    const [p] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id));
    const ls = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    expect({ status: p.status, billed: ls.map((l) => Number(l.quantityBilled)) }).toEqual({ status: 'open', billed: [0] });
  });

  it('A4: billed retainage: no Undo for the void; an invoice that only HOLDS retainage is still re-entered exactly', async () => {
    const cust = await newCustomer('Contractor client');
    const held = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-07'),
      taxRateId: null,
      retainagePercent: 10,
      lines: [{ itemId: serviceItemId, quantity: 2, rate: '100.00', taxable: false }],
    });
    const { token: heldToken } = await track('invoices', 'void', held.id, () => voidInvoice(ctx, held.id));
    const out = await performUndo(ctx, heldToken);
    expect((await getInvoice(ctx, out.newId!)).retainageAmount).toBe((await getInvoice(ctx, held.id)).retainageAmount);

    const billing = await billRetainage(ctx, { customerId: cust, date: d('2026-03-08'), amount: '20.00' });
    const token = await voidWithToken('invoices', billing.id, () => voidInvoice(ctx, billing.id));
    await expect(commitUndo(ctx, { resource: 'invoices', kind: 'void', token })).rejects.toThrow(/had linked billed retainage/);
  });

  it('A5: bill and check lines already billed to a customer: no Undo for their void', async () => {
    const cust = await newCustomer('Rebill Co');
    const vend = await newVendor('Rebill Vendor');
    const bill = await createBill(ctx, {
      vendorId: vend,
      date: d('2026-03-09'),
      lines: [{ accountId: acct['6400'], amount: '80.00', customerId: cust }],
    });
    const check = await createExpense(ctx, {
      vendorId: vend,
      date: d('2026-03-09'),
      method: 'check',
      reference: '2001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6400'], amount: '30.00', customerId: cust }],
    });
    const billLineId = (await getBill(ctx, bill.id)).lines[0].id as string;
    const checkLineId = (await getExpense(ctx, check.id)).lines[0].id as string;
    await createInvoiceWithBillables(ctx, { customerId: cust, date: d('2026-03-10'), lines: [] }, {
      billLineIds: [billLineId],
      expenseLineIds: [checkLineId],
    });
    const bt = await voidWithToken('bills', bill.id, () => voidBill(ctx, bill.id));
    await expect(commitUndo(ctx, { resource: 'bills', kind: 'void', token: bt })).rejects.toThrow(
      /had linked billable costs already billed to a customer/,
    );
    const ct = await voidWithToken('expenses', check.id, () => voidExpense(ctx, check.id));
    await expect(commitUndo(ctx, { resource: 'expenses', kind: 'void', token: ct })).rejects.toThrow(
      /had linked billable costs already billed to a customer/,
    );
  });

  // ---- B. linked effects of the same save -------------------------------------------------------

  it('B1: Pay Bills that also applied a vendor credit offers no Undo; a cash-only Pay Bills still does', async () => {
    const vend = await newVendor('Credit Vendor');
    const bill = await createBill(ctx, { vendorId: vend, date: d('2026-03-10'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId: vend, date: d('2026-03-10'), lines: [{ accountId: acct['6300'], amount: '30.00' }] });
    await expect(
      track('bill-payments', 'create', null, () =>
        payBillsWithCredits(ctx, {
          vendorId: vend,
          date: d('2026-03-11'),
          method: 'check',
          paymentAccountId: acct['1000'],
          applications: [{ billId: bill.id, amountApplied: '70.00' }],
          vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '30.00' }],
        }),
      ),
    ).rejects.toThrow(/also applied vendor credits/);
    expect((await getBill(ctx, bill.id)).balanceDue).toBe('0.00');
    expect((await getVendorCredit(ctx, vc.id)).unapplied).toBe('0.00');

    const bill2 = await createBill(ctx, { vendorId: vend, date: d('2026-03-10'), lines: [{ accountId: acct['6300'], amount: '40.00' }] });
    const { token } = await track('bill-payments', 'create', null, () =>
      payBillsWithCredits(ctx, {
        vendorId: vend,
        date: d('2026-03-11'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill2.id, amountApplied: '40.00' }],
      }),
    );
    await performUndo(ctx, token);
    expect((await getBill(ctx, bill2.id)).balanceDue).toBe('40.00');
  });

  it('B2: Receive Payments that also used an earlier payment offers no Undo', async () => {
    const cust = await newCustomer('Earlier Pay Co');
    const p0 = await receivePayment(ctx, { customerId: cust, date: d('2026-03-12'), method: 'check', amount: '40.00', applications: [] });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-12'),
      lines: [{ accountId: acct['4000'], quantity: '1', rate: '100.00', taxable: false }],
    });
    await expect(
      track('payments', 'create', null, () =>
        receivePayment(ctx, {
          customerId: cust,
          date: d('2026-03-13'),
          method: 'check',
          amount: '60.00',
          applications: [{ invoiceId: inv.id, amountApplied: '60.00' }],
          paymentCredits: [{ paymentId: p0.payment.id, invoiceId: inv.id, amount: '40.00' }],
        }),
      ),
    ).rejects.toThrow(/earlier payments/);
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('0.00');
    expect((await getPayment(ctx, p0.payment.id)).unapplied).toBe('0.00');
  });

  it('B3: a payment edit that took it out of its deposit offers no Undo', async () => {
    const cust = await newCustomer('Deposit Edit Co');
    const p = await receivePayment(ctx, { customerId: cust, date: d('2026-03-16'), method: 'check', amount: '50.00', applications: [] });
    const dep = await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-03-16'), paymentIds: [p.payment.id] });
    await expect(
      track('payments', 'update', p.payment.id, () =>
        updatePayment(ctx, p.payment.id, {
          customerId: cust,
          date: d('2026-03-16'),
          method: 'check',
          amount: '60.00',
          applications: [],
          removeFromDeposit: true,
        }),
      ),
    ).rejects.toThrow(/out of its bank deposit/);
    expect((await getDeposit(ctx, dep.id)).voidedAt).not.toBeNull();
    expect((await getPayment(ctx, p.payment.id)).amount).toBe('60.00');
  });

  // ---- C. creates without an id ----------------------------------------------------------------

  it('C: a credits-only Pay Bills save never arms an Undo for an earlier bill payment', async () => {
    const vend = await newVendor('Two Bills Vendor');
    const billX = await createBill(ctx, { vendorId: vend, date: d('2026-03-14'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    const billY = await createBill(ctx, { vendorId: vend, date: d('2026-03-14'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId: vend, date: d('2026-03-14'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
    const first = await track('bill-payments', 'create', null, () =>
      payBillsWithCredits(ctx, {
        vendorId: vend,
        date: d('2026-03-15'),
        method: 'check',
        paymentAccountId: acct['1000'],
        applications: [{ billId: billX.id, amountApplied: '100.00' }],
      }),
    );
    const bp1 = (first.result.payment as { id: string }).id;
    const second = await payBillsWithCredits(ctx, {
      vendorId: vend,
      date: d('2026-03-15'),
      method: 'check',
      paymentAccountId: acct['1000'],
      applications: [],
      vendorCredits: [{ vendorCreditId: vc.id, billId: billY.id, amount: '50.00' }],
    });
    expect(second.payment).toBeNull();
    expect(createdIdOf(second)).toBeNull();
    await expect(commitUndo(ctx, { resource: 'bill-payments', kind: 'create', token: null, id: null })).rejects.toThrow(/nothing to undo/);
    expect((await getBillPayment(ctx, bp1)).voidedAt).toBeNull();
    expect((await getBill(ctx, billY.id)).balanceDue).toBe('0.00');
  });

  // ---- D/E/F. fields restored exactly ------------------------------------------------------------

  it('D: undo of a customer edit puts the price level back', async () => {
    const c = await createCustomer(ctx, { displayName: 'Level Co' });
    const lvl = await createPriceLevel(ctx, { name: 'VIP', type: 'fixed_percent', percent: -10 });
    const { token } = await track('customers', 'update', c.id, () =>
      updateCustomer(ctx, c.id, { displayName: 'Level Co', phone: '555-0100', priceLevelId: lvl.id }),
    );
    const out = await performUndo(ctx, token);
    expect(out.message).toMatch(/reversed/);
    const back = await getCustomer(ctx, c.id);
    expect(back.phone).toBeNull();
    expect(back.priceLevelId).toBeNull();
  });

  const ccIn = (memo: string | null, amount = '25.00') => ({
    payeeName: 'Office Store',
    date: d('2026-03-20'),
    method: 'credit_card' as const,
    paymentAccountId: acct['2100'],
    isRefund: true, // what app/expenses/page.tsx sends for a "Credit card credit"
    memo,
    lines: [{ accountId: acct['6300'], amount }],
  });

  it('E1: undo of an edit of a credit-card credit keeps it a credit', async () => {
    const cc = await createExpense(ctx, ccIn(null));
    expect(cc.total).toBe('-25.00');
    const ccBal = (await getAccount(ctx, acct['2100'])).balance;
    const supplies = (await getAccount(ctx, acct['6300'])).balance;
    const { token } = await track('expenses', 'update', cc.id, () => updateExpense(ctx, cc.id, ccIn('returned toner')));
    await performUndo(ctx, token);
    const back = await getExpense(ctx, cc.id);
    expect(back.memo).toBeNull();
    expect({ total: back.total, cc: (await getAccount(ctx, acct['2100'])).balance, supplies: (await getAccount(ctx, acct['6300'])).balance }).toEqual({
      total: '-25.00',
      cc: ccBal,
      supplies,
    });
  });

  it('E2: undo of a void of a credit-card credit re-enters a credit', async () => {
    const cc = await createExpense(ctx, ccIn(null, '15.00'));
    const ccBal = (await getAccount(ctx, acct['2100'])).balance;
    const { token } = await track('expenses', 'void', cc.id, () => voidExpense(ctx, cc.id));
    const out = await performUndo(ctx, token);
    expect((await getExpense(ctx, out.newId!)).total).toBe('-15.00');
    expect((await getAccount(ctx, acct['2100'])).balance).toBe(ccBal);
  });

  it('E3: undo keeps an Other Names payee on a check (edit and void)', async () => {
    const [other] = await db.insert(otherNames).values({ companyId: ctx.companyId, name: 'Town Clerk' }).returning();
    const input = (memo: string | null) => ({
      otherNameId: other.id,
      date: d('2026-03-22'),
      method: 'check' as const,
      reference: '3001',
      paymentAccountId: acct['1000'],
      memo,
      lines: [{ accountId: acct['6300'], amount: '12.00' }],
    });
    const chk = await createExpense(ctx, input(null));
    const { token } = await track('expenses', 'update', chk.id, () => updateExpense(ctx, chk.id, input('permit')));
    await performUndo(ctx, token);
    expect((await getExpense(ctx, chk.id)).otherNameId).toBe(other.id);
    const { token: vt } = await track('expenses', 'void', chk.id, () => voidExpense(ctx, chk.id));
    const out = await performUndo(ctx, vt);
    expect((await getExpense(ctx, out.newId!)).otherNameId).toBe(other.id);
  });

  it('F: undo of a void of a deposit with an older account-less line is refused, not re-entered short', async () => {
    const cust = await newCustomer('Legacy Dep Co');
    const p = await receivePayment(ctx, { customerId: cust, date: d('2026-03-23'), method: 'check', amount: '70.00', applications: [] });
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: d('2026-03-23'),
      paymentIds: [p.payment.id],
      extraLines: [{ accountId: acct['4000'], amount: '5.00', description: 'Old line' }],
    });
    // Simulate a line from before 0037 (no account on the deposit line).
    await db.update(depositLines).set({ accountId: null }).where(and(eq(depositLines.depositId, dep.id), eq(depositLines.description, 'Old line')));
    const { token } = await track('deposits', 'void', dep.id, () => voidDeposit(ctx, dep.id));
    const countBefore = (await db.select({ id: deposits.id }).from(deposits)).length;
    await expect(performUndo(ctx, token)).rejects.toThrow(/older version/);
    expect((await db.select({ id: deposits.id }).from(deposits)).length).toBe(countBefore);
  });

  // Last: turns on enhanced receiving for the rest of the company.
  it('A6: a bill for received items: no Undo for its void', async () => {
    await updateReceivingSettings(ctx, { enhancedReceiving: true, varianceMode: 'inventory' });
    const vend = await newVendor('Receiving Vendor');
    const [widget] = await db
      .insert(items)
      .values({
        companyId: ctx.companyId,
        name: 'Widget',
        type: 'inventory' as never,
        salesPrice: '20.00',
        assetAccountId: acct['1300'],
        expenseAccountId: acct['5000'],
        quantityOnHand: '0',
        averageCost: '0',
      })
      .returning();
    const receipt = await createItemReceipt(ctx, {
      vendorId: vend,
      date: d('2026-03-24'),
      lines: [{ itemId: widget.id, quantity: 4, unitCost: '5.00' }],
    });
    const [line] = await db.select().from(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, receipt.id));
    const bill = await enterBillForReceivedItems(ctx, {
      vendorId: vend,
      date: d('2026-03-25'),
      lines: [{ receiptLineId: line.id, quantity: 4, unitCost: '5.00' }],
    });
    const token = await voidWithToken('bills', bill.id, () => voidBill(ctx, bill.id));
    await expect(commitUndo(ctx, { resource: 'bills', kind: 'void', token })).rejects.toThrow(/had linked received items/);
    expect((await db.select().from(billLines).where(eq(billLines.billId, bill.id))).length).toBeGreaterThan(0);
  });
});
