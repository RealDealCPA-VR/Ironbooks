/**
 * Integration tests for the Linked Transactions service (QB "Transaction History").
 *
 * Graphs are constructed with a mix of real service calls (postJournalEntry,
 * journal createManualEntry/reverseEntry/updateEntry, writeAudit) and direct
 * row inserts for the document tables — linkedTransactions is read-only, so
 * the tests exercise exactly the edges it reads:
 *
 *  1. Invoice tree: estimate + sales-order sources, payment applied (with the
 *     deposit that banked it as a grandchild), credit memo applied (audit
 *     edge), and the COGS entry (sourceRef 'invoice-cogs:<id>').
 *  2. entryHistory resolves an invoice posting entry AND its COGS entry to the
 *     same invoice tree.
 *  3. Bill tree: PO source, item receipt, bill payment, vendor credit (audit edge).
 *  4. entryHistory falls back to postedEntryId probing for payment entries
 *     (their sourceRef is 'customer:<id>', which doesn't embed the payment id).
 *  5. Deposit tree: payments with the invoices they paid as grandchildren.
 *  6. Paycheck tree: pay run child with the run's total net pay.
 *  7. Manual entries: reversal links (sourceRef 'reversal:<id>') and
 *     replacement links (journal.updateEntry audit old->new edges).
 *  8. Tenant safety / NOT_FOUND.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  billPaymentApplications,
  billPayments,
  bills,
  creditMemos,
  customers,
  depositLines,
  deposits,
  employees,
  estimates,
  invoices,
  itemReceipts,
  payRuns,
  paychecks,
  paymentApplications,
  paymentsReceived,
  purchaseOrders,
  salesOrders,
  users,
  companies,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { writeAudit, ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { createManualEntry, reverseEntry, updateEntry } from './journal';
import {
  buildLinkedTree,
  entryHistory,
  type LinkedTransaction,
} from './linkedTransactions';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-linked-transactions');

let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let employeeId: string;

function kinds(t: LinkedTransaction): string[] {
  return (t.children ?? []).map((c) => c.kind);
}

function child(t: LinkedTransaction, kind: string): LinkedTransaction | undefined {
  return (t.children ?? []).find((c) => c.kind === kind);
}

describe('Linked transactions service', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'linked-owner@test.local', name: 'Linked Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Linked Txn Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory', 'asset', 'inventory'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'COGS', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, {
        code,
        name,
        type: type as never,
        subtype: subtype as never,
      });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Acme Corp' })
      .returning();
    customerId = cust.id;

    const [vend] = await db
      .insert(vendors)
      .values({ companyId: company.id, displayName: 'Supplies Inc' })
      .returning();
    vendorId = vend.id;

    const [emp] = await db
      .insert(employees)
      .values({ companyId: company.id, firstName: 'Pat', lastName: 'Lee' })
      .returning();
    employeeId = emp.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Invoice graph
  // -------------------------------------------------------------------------
  let invoiceId: string;
  let invoiceEntryId: string;
  let cogsEntryId: string;
  let paymentId: string;
  let depositId: string;

  it('builds the invoice tree: estimate + SO sources, payment (with deposit), credit memo, COGS', async () => {
    // Invoice posting entry (Dr AR / Cr Sales).
    const [inv] = await db
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId,
        invoiceNumber: 1,
        date: new Date('2025-07-01'),
        total: '1000.00',
        balanceDue: '400.00',
        amountPaid: '600.00',
      })
      .returning();
    invoiceId = inv.id;

    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-07-01'),
      description: 'Invoice #1',
      sourceRef: `invoice:${invoiceId}`,
      lines: [
        { accountId: acct['1200'], debit: '1000.00' },
        { accountId: acct['4000'], credit: '1000.00' },
      ],
    });
    invoiceEntryId = entry.id;

    // COGS entry posted alongside the invoice.
    const cogs = await postJournalEntry(ctx, {
      date: new Date('2025-07-01'),
      description: 'COGS for Invoice #1',
      sourceRef: `invoice-cogs:${invoiceId}`,
      lines: [
        { accountId: acct['5000'], debit: '400.00' },
        { accountId: acct['1300'], credit: '400.00' },
      ],
    });
    cogsEntryId = cogs.id;

    // Estimate + sales order converted into this invoice.
    await db.insert(estimates).values({
      companyId: ctx.companyId,
      customerId,
      estimateNumber: 1,
      date: new Date('2025-06-15'),
      total: '1000.00',
      status: 'closed' as never,
      convertedInvoiceId: invoiceId,
    });
    await db.insert(salesOrders).values({
      companyId: ctx.companyId,
      customerId,
      orderNumber: 1,
      date: new Date('2025-06-20'),
      total: '1000.00',
      status: 'closed' as never,
      convertedInvoiceId: invoiceId,
    });

    // Payment applied to the invoice, banked by a deposit.
    const [pmt] = await db
      .insert(paymentsReceived)
      .values({
        companyId: ctx.companyId,
        customerId,
        date: new Date('2025-07-05'),
        method: 'check',
        reference: 'CHK-100',
        amount: '600.00',
        unapplied: '0.00',
        depositAccountId: acct['1050'],
      })
      .returning();
    paymentId = pmt.id;
    await db.insert(paymentApplications).values({
      paymentId,
      invoiceId,
      amountApplied: '600.00',
    });

    const [dep] = await db
      .insert(deposits)
      .values({
        companyId: ctx.companyId,
        depositAccountId: acct['1000'],
        date: new Date('2025-07-06'),
        total: '600.00',
      })
      .returning();
    depositId = dep.id;
    await db.insert(depositLines).values({ depositId, paymentId, amount: '600.00' });

    // Credit memo applied to the invoice — recorded only as an audit edge,
    // exactly like creditMemos.applyToInvoice does.
    const [memo] = await db
      .insert(creditMemos)
      .values({
        companyId: ctx.companyId,
        customerId,
        memoNumber: 1,
        date: new Date('2025-07-03'),
        total: '100.00',
        unapplied: '0.00',
      })
      .returning();
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'credit_memo',
      entityId: memo.id,
      newValues: {
        unapplied: '0.00',
        status: 'paid',
        appliedToInvoice: invoiceId,
        amountApplied: '100.00',
      },
    });

    const tree = await buildLinkedTree(ctx, 'invoice', invoiceId);
    expect(tree.kind).toBe('invoice');
    expect(tree.label).toBe('Invoice #1');
    expect(tree.amount).toBe('1000.00');
    expect(tree.route).toBe('/invoices');

    const ks = kinds(tree);
    expect(ks).toContain('estimate');
    expect(ks).toContain('sales_order');
    expect(ks).toContain('payment');
    expect(ks).toContain('credit_memo');
    expect(ks).toContain('cogs');

    const pay = child(tree, 'payment')!;
    expect(pay.amount).toBe('600.00');
    expect(pay.label).toBe('Payment CHK-100');
    // Grandchild: the deposit that banked the payment.
    expect((pay.children ?? []).map((c) => c.kind)).toContain('deposit');

    expect(child(tree, 'credit_memo')!.amount).toBe('100.00');
    expect(child(tree, 'cogs')!.amount).toBe('400.00');
    expect(child(tree, 'estimate')!.label).toBe('Estimate #1');
  });

  it('entryHistory resolves the invoice posting entry and its COGS entry to the invoice tree', async () => {
    const fromInvoiceEntry = await entryHistory(ctx, invoiceEntryId);
    expect(fromInvoiceEntry.kind).toBe('invoice');
    expect(fromInvoiceEntry.id).toBe(invoiceId);
    expect(kinds(fromInvoiceEntry)).toContain('payment');

    const fromCogsEntry = await entryHistory(ctx, cogsEntryId);
    expect(fromCogsEntry.kind).toBe('invoice');
    expect(fromCogsEntry.id).toBe(invoiceId);
  });

  // -------------------------------------------------------------------------
  // Bill graph
  // -------------------------------------------------------------------------
  it('builds the bill tree: PO source, item receipt, bill payment, vendor credit', async () => {
    const [bill] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId,
        billNumber: 'B-77',
        date: new Date('2025-07-10'),
        total: '500.00',
        balanceDue: '0.00',
        amountPaid: '450.00',
        amountCredited: '50.00',
      })
      .returning();

    await db.insert(purchaseOrders).values({
      companyId: ctx.companyId,
      vendorId,
      poNumber: 9,
      date: new Date('2025-07-01'),
      total: '500.00',
      status: 'closed' as never,
      convertedBillId: bill.id,
    });
    await db.insert(itemReceipts).values({
      companyId: ctx.companyId,
      vendorId,
      date: new Date('2025-07-05'),
      reference: 'RCV-1',
      status: 'billed',
      total: '500.00',
      convertedBillId: bill.id,
    });

    const [bp] = await db
      .insert(billPayments)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: new Date('2025-07-15'),
        method: 'check',
        reference: 'CHK-200',
        amount: '450.00',
        paymentAccountId: acct['1000'],
      })
      .returning();
    await db.insert(billPaymentApplications).values({
      billPaymentId: bp.id,
      billId: bill.id,
      amountApplied: '450.00',
    });

    const [credit] = await db
      .insert(vendorCredits)
      .values({
        companyId: ctx.companyId,
        vendorId,
        date: new Date('2025-07-12'),
        total: '50.00',
        unapplied: '0.00',
      })
      .returning();
    await writeAudit(ctx, {
      action: 'update',
      entityType: 'vendor_credit',
      entityId: credit.id,
      newValues: {
        action: 'applied_to_bill',
        billId: bill.id,
        amount: '50.00',
        newUnapplied: '0.00',
      },
    });

    const tree = await buildLinkedTree(ctx, 'bill', bill.id);
    expect(tree.kind).toBe('bill');
    expect(tree.label).toBe('Bill B-77');

    const ks = kinds(tree);
    expect(ks).toContain('purchase_order');
    expect(ks).toContain('item_receipt');
    expect(ks).toContain('bill_payment');
    expect(ks).toContain('vendor_credit');

    expect(child(tree, 'bill_payment')!.amount).toBe('450.00');
    expect(child(tree, 'vendor_credit')!.amount).toBe('50.00');
    expect(child(tree, 'purchase_order')!.label).toBe('PO #9');
  });

  // -------------------------------------------------------------------------
  // Payment entry resolution via postedEntryId fallback
  // -------------------------------------------------------------------------
  it("entryHistory resolves a payment entry (sourceRef 'customer:<id>') via postedEntryId", async () => {
    // Real receivePayment posts with sourceRef 'customer:<customerId>' and
    // stamps postedEntryId on the payment row — mirror that here.
    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-07-05'),
      description: 'Payment from Acme Corp',
      sourceRef: `customer:${customerId}`,
      lines: [
        { accountId: acct['1050'], debit: '600.00' },
        { accountId: acct['1200'], credit: '600.00' },
      ],
    });
    await db
      .update(paymentsReceived)
      .set({ postedEntryId: entry.id })
      .where(eq(paymentsReceived.id, paymentId));

    const tree = await entryHistory(ctx, entry.id);
    expect(tree.kind).toBe('payment');
    expect(tree.id).toBe(paymentId);
    // Children: the invoice it paid + the deposit that banked it.
    expect(kinds(tree)).toContain('invoice');
    expect(kinds(tree)).toContain('deposit');
    expect(child(tree, 'invoice')!.amount).toBe('600.00');
  });

  // -------------------------------------------------------------------------
  // Deposit tree
  // -------------------------------------------------------------------------
  it('builds the deposit tree: payments with their invoices as grandchildren', async () => {
    const tree = await buildLinkedTree(ctx, 'deposit', depositId);
    expect(tree.kind).toBe('deposit');
    expect(tree.amount).toBe('600.00');

    const pay = child(tree, 'payment')!;
    expect(pay).toBeDefined();
    expect(pay.id).toBe(paymentId);
    const grand = (pay.children ?? []).map((c) => c.kind);
    expect(grand).toContain('invoice');
  });

  // -------------------------------------------------------------------------
  // Paycheck -> pay run
  // -------------------------------------------------------------------------
  it('builds the paycheck tree with its pay run (run total = sum of net pay)', async () => {
    const [run] = await db
      .insert(payRuns)
      .values({ companyId: ctx.companyId, payDate: new Date('2025-07-31') })
      .returning();
    const [pc1] = await db
      .insert(paychecks)
      .values({
        companyId: ctx.companyId,
        employeeId,
        payDate: new Date('2025-07-31'),
        netPay: '1200.00',
        payRunId: run.id,
      })
      .returning();
    await db.insert(paychecks).values({
      companyId: ctx.companyId,
      employeeId,
      payDate: new Date('2025-07-31'),
      netPay: '800.00',
      payRunId: run.id,
    });

    const tree = await buildLinkedTree(ctx, 'paycheck', pc1.id);
    expect(tree.kind).toBe('paycheck');
    expect(tree.amount).toBe('1200.00');
    const runNode = child(tree, 'pay_run')!;
    expect(runNode).toBeDefined();
    expect(runNode.amount).toBe('2000.00');
  });

  // -------------------------------------------------------------------------
  // Manual entries: reversal + replacement links
  // -------------------------------------------------------------------------
  it('manual entry history shows reversal links both ways', async () => {
    const original = await createManualEntry(ctx, {
      date: new Date('2025-08-31'),
      description: 'Month-end accrual',
      lines: [
        { accountId: acct['5000'], debit: '250.00' },
        // QB rule (wave2 foundation): an A/P line on a journal entry names the vendor.
        { accountId: acct['2000'], credit: '250.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
    const reversal = await reverseEntry(ctx, original.id, new Date('2025-09-01'));

    const origHistory = await entryHistory(ctx, original.id);
    expect(origHistory.kind).toBe('journal_entry');
    expect(origHistory.amount).toBe('250.00');
    const reversedBy = (origHistory.children ?? []).find((c) => c.id === reversal.id);
    expect(reversedBy).toBeDefined();
    expect(reversedBy!.label).toContain('Reversed by');

    const revHistory = await entryHistory(ctx, reversal.id);
    const reverses = (revHistory.children ?? []).find((c) => c.id === original.id);
    expect(reverses).toBeDefined();
    expect(reverses!.label).toContain('Reverses');
  });

  it('manual entry history shows replacement links from updateEntry audit edges', async () => {
    const original = await createManualEntry(ctx, {
      date: new Date('2025-09-10'),
      description: 'Misc adjustment',
      lines: [
        { accountId: acct['5000'], debit: '75.00' },
        { accountId: acct['1000'], credit: '75.00' },
      ],
    });
    const replacement = await updateEntry(ctx, original.id, {
      date: new Date('2025-09-10'),
      description: 'Misc adjustment (corrected)',
      lines: [
        { accountId: acct['5000'], debit: '80.00' },
        { accountId: acct['1000'], credit: '80.00' },
      ],
    });

    const oldHistory = await entryHistory(ctx, original.id);
    const replacedBy = (oldHistory.children ?? []).find((c) => c.id === replacement.id);
    expect(replacedBy).toBeDefined();
    expect(replacedBy!.label).toContain('Replaced by');

    const newHistory = await entryHistory(ctx, replacement.id);
    const replaces = (newHistory.children ?? []).find((c) => c.id === original.id);
    expect(replaces).toBeDefined();
    expect(replaces!.label).toContain('Replaces');
  });

  // -------------------------------------------------------------------------
  // Not found / tenant safety
  // -------------------------------------------------------------------------
  it('entryHistory throws NOT_FOUND for an unknown entry id', async () => {
    await expect(
      entryHistory(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("entryHistory refuses another company's entry", async () => {
    const otherCtx: ServiceContext = {
      ...ctx,
      companyId: '00000000-0000-0000-0000-000000000001',
    };
    await expect(entryHistory(otherCtx, invoiceEntryId)).rejects.toBeInstanceOf(ServiceError);
  });
});
