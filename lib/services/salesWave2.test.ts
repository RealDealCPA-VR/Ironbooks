/**
 * wave2 sales — integration tests for the A/R parity package:
 *   C1 edit after saving (payments, sales receipts, credit memos, estimates, sales orders)
 *   C3 early-payment discounts, C4 credits inside Receive Payments, F2 bounced checks,
 *   C5 statement charges, C6 batch invoicing, C7/C8 forms (PDF, flags, queues, email guard),
 *   C9 Income Tracker + Collections Center, B6 shipping fields.
 *
 * After every mutation: the trial balance balances AND the A/R control account equals the
 * subledger (open invoices − unapplied payments − unapplied credit memos).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  companies,
  creditMemos,
  customers,
  invoices,
  items,
  journalEntries,
  paymentsReceived,
  users,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, getInvoice } from './invoices';
import {
  getPayment,
  listAvailableCredits,
  parseDiscountTerms,
  receivePayment,
  recordBouncedCheck,
  suggestEarlyPaymentDiscounts,
  updatePayment,
  voidPayment,
} from './payments';
import { createCreditMemo, getCreditMemo, listCreditApplications, updateCreditMemo } from './creditMemos';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createEstimate, convertToInvoice as convertEstimate, getEstimate, updateEstimate } from './estimates';
import {
  convertToInvoice as convertSalesOrder,
  createSalesOrder,
  getSalesOrder,
  updateSalesOrder,
} from './salesOrders';
import { createDeposit } from './deposits';
import { customerStatement, openItemStatement } from './statements';
import { createBatchInvoices, createStatementCharge, listStatementCharges, updateStatementCharge } from './batchInvoicing';
import { emailSalesForm, listSendQueue, markPrinted, renderSalesForm, setSendFlags } from './salesForms';
import { addCollectionNote, collectionsCenter, incomeTracker, runTrackerAction } from './incomeTracker';
import { routeErrorWithWarnings } from '@/lib/salesRouteErrors';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-wave2');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let custA: string;
let custB: string;
let invItem: string;

async function balanceOf(code: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, acct[code]));
  return Money.round2(row.balance).toFixed(2);
}

/** Trial balance balanced + A/R control == subledger. */
async function assertBooks() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
  const invRows = await db
    .select({ balanceDue: invoices.balanceDue, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.companyId, ctx.companyId));
  const payRows = await db
    .select({ unapplied: paymentsReceived.unapplied })
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, ctx.companyId), isNull(paymentsReceived.voidedAt)));
  const memoRows = await db
    .select({ unapplied: creditMemos.unapplied, status: creditMemos.status })
    .from(creditMemos)
    .where(eq(creditMemos.companyId, ctx.companyId));
  let expected = Money.zero();
  for (const r of invRows) if (r.status !== 'draft') expected = expected.plus(Money.of(r.balanceDue));
  for (const r of payRows) expected = expected.minus(Money.of(r.unapplied));
  for (const r of memoRows) if (r.status !== 'void') expected = expected.minus(Money.of(r.unapplied));
  expect(await balanceOf('1200')).toBe(Money.round2(expected).toFixed(2));
}

async function newInvoice(customerId: string, amount: number, date = '2026-03-01') {
  return createInvoice(ctx, {
    customerId,
    date: new Date(date),
    dueDate: new Date(new Date(date).getTime() + 30 * 86_400_000),
    lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
  });
}

describe('wave2 sales', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'sales-w2@test.local', name: 'Sales', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Sales W2 Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    custA = (await db.insert(customers).values({ companyId: company.id, displayName: 'Acme', terms: '2_10_net_30', email: 'ap@acme.test' }).returning())[0].id;
    custB = (await db.insert(customers).values({ companyId: company.id, displayName: 'Bolt' }).returning())[0].id;
    invItem = (
      await db
        .insert(items)
        .values({ companyId: company.id, name: 'Widget', type: 'service', salesPrice: '10.00', incomeAccountId: acct['4000'] })
        .returning()
    )[0].id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- C3
  it('parses early-payment terms', () => {
    expect(parseDiscountTerms('2_10_net_30')).toEqual({ percent: '2', discountDays: 10, netDays: 30 });
    expect(parseDiscountTerms('2% 10 Net 30')).toEqual({ percent: '2', discountDays: 10, netDays: 30 });
    expect(parseDiscountTerms('1/15 n/45')).toEqual({ percent: '1', discountDays: 15, netDays: 45 });
    expect(parseDiscountTerms('net_30')).toBeNull();
    expect(parseDiscountTerms(null)).toBeNull();
  });

  it('takes an early-payment discount in Receive Payments (posted Dr discount / Cr A/R)', async () => {
    const inv = await newInvoice(custA, 1000, '2026-03-01');
    const sugg = await suggestEarlyPaymentDiscounts(ctx, { customerId: custA, paymentDate: new Date('2026-03-05'), invoiceIds: [inv.id] });
    expect(sugg[0]).toMatchObject({ eligible: true, suggested: '20.00', discountDate: '2026-03-11' });
    const late = await suggestEarlyPaymentDiscounts(ctx, { customerId: custA, paymentDate: new Date('2026-03-20'), invoiceIds: [inv.id] });
    expect(late[0].eligible).toBe(false);

    const { payment } = await receivePayment(ctx, {
      customerId: custA,
      date: new Date('2026-03-05'),
      method: 'check',
      amount: '980.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '980.00', discountAmount: '20.00' }],
    });
    const after = await getInvoice(ctx, inv.id);
    expect(after.status).toBe('paid');
    expect(after.balanceDue).toBe('0.00');
    expect(payment.discountAccountId).toBeTruthy();
    const [disc] = await db.select().from(accounts).where(eq(accounts.id, payment.discountAccountId!));
    expect(disc.code).toBe('4950');
    expect(Money.round2(disc.balance).toFixed(2)).toBe('-20.00'); // contra income (debit balance)
    await assertBooks();

    // Voiding the payment rolls back cash AND the discount.
    await voidPayment(ctx, payment.id);
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('1000.00');
    const [disc2] = await db.select().from(accounts).where(eq(accounts.id, payment.discountAccountId!));
    expect(Money.round2(disc2.balance).toFixed(2)).toBe('0.00');
    await assertBooks();
  });

  it('refuses a discount + cash larger than the invoice balance', async () => {
    const inv = await newInvoice(custA, 100);
    await expect(
      receivePayment(ctx, {
        customerId: custA,
        date: new Date('2026-03-05'),
        method: 'cash',
        amount: '100.00',
        applications: [{ invoiceId: inv.id, amountApplied: '100.00', discountAmount: '2.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await assertBooks();
  });

  // ---------------------------------------------------------------- C4
  it('applies a credit memo inside Receive Payments and undoes it when the payment is voided', async () => {
    const inv = await newInvoice(custB, 500);
    const memo = await createCreditMemo(ctx, {
      customerId: custB,
      date: new Date('2026-03-02'),
      lines: [{ description: 'Return', quantity: 1, rate: 150, taxable: false }],
    });
    const credits = await listAvailableCredits(ctx, custB);
    expect(credits.find((c) => c.id === memo.id)?.available).toBe('150.00');

    const { payment } = await receivePayment(ctx, {
      customerId: custB,
      date: new Date('2026-03-06'),
      method: 'check',
      amount: '350.00',
      applications: [{ invoiceId: inv.id, amountApplied: '350.00' }],
      credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '150.00' }],
    });
    expect((await getInvoice(ctx, inv.id)).status).toBe('paid');
    expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('0.00');
    expect((await getPayment(ctx, payment.id)).credits).toHaveLength(1);
    await assertBooks();

    await voidPayment(ctx, payment.id);
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('500.00');
    expect((await getCreditMemo(ctx, memo.id)).unapplied).toBe('150.00');
    expect(await listCreditApplications(ctx, { creditMemoId: memo.id })).toHaveLength(0);
    await assertBooks();

    // A zero-amount "payment" that only applies the credit posts nothing but closes it out.
    const credOnly = await receivePayment(ctx, {
      customerId: custB,
      date: new Date('2026-03-07'),
      method: 'other',
      amount: '0',
      applications: [],
      credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '150.00' }],
    });
    expect(credOnly.entry).toBeNull();
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('350.00');
    await assertBooks();

    // Over-using a credit is refused.
    await expect(
      receivePayment(ctx, {
        customerId: custB,
        date: new Date('2026-03-07'),
        method: 'other',
        amount: '0',
        applications: [],
        credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '1.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // ---------------------------------------------------------------- C1 payments
  it('edits a received payment (void + re-post onto the same record) and rolls back invalid edits', async () => {
    const i1 = await newInvoice(custB, 300);
    const i2 = await newInvoice(custB, 200);
    const { payment, entry } = await receivePayment(ctx, {
      customerId: custB,
      date: new Date('2026-03-08'),
      method: 'check',
      reference: '1001',
      amount: '300.00',
      applications: [{ invoiceId: i1.id, amountApplied: '300.00' }],
    });

    const edited = await updatePayment(ctx, payment.id, {
      customerId: custB,
      date: new Date('2026-03-09'),
      method: 'check',
      reference: '1001',
      amount: '450.00',
      applications: [
        { invoiceId: i1.id, amountApplied: '250.00' },
        { invoiceId: i2.id, amountApplied: '200.00' },
      ],
    });
    expect(edited.payment.id).toBe(payment.id);
    const [oldJe] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry!.id));
    expect(oldJe.status).toBe('void');
    expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('50.00');
    expect((await getInvoice(ctx, i2.id)).status).toBe('paid');
    await assertBooks();

    // An edit that over-applies is refused and leaves everything exactly as it was.
    await expect(
      updatePayment(ctx, payment.id, {
        customerId: custB,
        date: new Date('2026-03-09'),
        method: 'check',
        amount: '900.00',
        applications: [{ invoiceId: i1.id, amountApplied: '900.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getInvoice(ctx, i1.id)).balanceDue).toBe('50.00');
    expect((await getPayment(ctx, payment.id)).amount).toBe('450.00');
    await assertBooks();

    // The transaction log / audit trail records the old version.
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, payment.id));
    expect(audits.some((a) => (a.oldValues as { amount?: string } | null)?.amount === '300.00')).toBe(true);
  });

  it('respects the closing date when editing a payment', async () => {
    const inv = await newInvoice(custA, 80, '2026-01-10');
    const { payment } = await receivePayment(ctx, {
      customerId: custA, date: new Date('2026-01-12'), method: 'cash', amount: '80.00',
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    });
    await db.update(companies).set({ settings: { closingDate: '2026-01-31' } as never }).where(eq(companies.id, ctx.companyId));
    try {
      await expect(
        updatePayment(ctx, payment.id, {
          customerId: custA, date: new Date('2026-02-05'), method: 'cash', amount: '80.00',
          applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
        }),
      ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    } finally {
      await db.update(companies).set({ settings: {} as never }).where(eq(companies.id, ctx.companyId));
    }
    await assertBooks();
  });

  // ---------------------------------------------------------------- F2
  it('records a bounced check: money out of the bank, invoice reopened, bank fee + customer fee', async () => {
    const inv = await newInvoice(custA, 400);
    const bankBefore = await balanceOf('1000');
    const { payment } = await receivePayment(ctx, {
      customerId: custA, date: new Date('2026-03-10'), method: 'check', reference: 'NSF-1', amount: '400.00',
      applications: [{ invoiceId: inv.id, amountApplied: '400.00' }],
    });
    // Still in Undeposited Funds → cannot bounce yet.
    await expect(recordBouncedCheck(ctx, { paymentId: payment.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-03-11'), paymentIds: [payment.id] });
    expect(await balanceOf('1000')).toBe(Money.of(bankBefore).plus(400).toFixed(2));

    const bc = await recordBouncedCheck(ctx, {
      paymentId: payment.id, date: new Date('2026-03-15'), bankFee: '25.00', customerFee: '35.00',
    });
    expect(bc.customerFeeInvoiceId).toBeTruthy();
    expect(await balanceOf('1000')).toBe(Money.of(bankBefore).minus(25).toFixed(2));
    const reopened = await getInvoice(ctx, inv.id);
    expect(reopened.balanceDue).toBe('400.00');
    expect(reopened.status).toBe('open');
    expect((await getInvoice(ctx, bc.customerFeeInvoiceId!)).total).toBe('35.00');
    await assertBooks();

    await expect(recordBouncedCheck(ctx, { paymentId: payment.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(voidPayment(ctx, payment.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    const stmt = await customerStatement(ctx, custA, { from: new Date('2026-03-10'), to: new Date('2026-03-31') });
    expect(stmt.lines.some((l) => l.type === 'bounced_check' && l.amount === '400.00')).toBe(true);
  });

  // ---------------------------------------------------------------- C1 sales receipts
  it('edits a sales receipt (reverse + re-post) and locks the total once deposited', async () => {
    const r = await createSalesReceipt(ctx, {
      customerId: custB, date: new Date('2026-03-12'), method: 'cash',
      lines: [{ itemId: invItem, quantity: 2, rate: 10, taxable: false }],
      shipVia: 'UPS', trackingNumber: '1Z999',
    });
    expect(r.shipVia).toBe('UPS');
    const edited = await updateSalesReceipt(ctx, r.id, {
      customerId: custB, date: new Date('2026-03-12'), method: 'cash',
      lines: [{ itemId: invItem, quantity: 5, rate: 10, taxable: false }],
    });
    expect(edited.total).toBe('50.00');
    expect(edited.receiptNumber).toBe(r.receiptNumber);
    expect(edited.shipVia).toBe('UPS'); // untouched fields are kept
    const [oldJe] = await db.select().from(journalEntries).where(eq(journalEntries.id, r.postedEntryId!));
    expect(oldJe.status).toBe('void');
    await assertBooks();

    await createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-03-13'), salesReceiptIds: [r.id] });
    await expect(
      updateSalesReceipt(ctx, r.id, {
        customerId: custB, date: new Date('2026-03-12'), method: 'cash',
        lines: [{ itemId: invItem, quantity: 6, rate: 10, taxable: false }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Same total, different memo is fine.
    const memoOnly = await updateSalesReceipt(ctx, r.id, {
      customerId: custB, date: new Date('2026-03-12'), method: 'cash', memo: 'counter sale',
      lines: [{ itemId: invItem, quantity: 5, rate: 10, taxable: false }],
    });
    expect(memoOnly.memo).toBe('counter sale');
    expect((await getSalesReceipt(ctx, r.id)).total).toBe('50.00');
    await assertBooks();
  });

  // ---------------------------------------------------------------- C1 credit memos
  it('edits a credit memo but never below the credit already used', async () => {
    const inv = await newInvoice(custA, 90);
    const memo = await createCreditMemo(ctx, {
      customerId: custA, date: new Date('2026-03-14'),
      lines: [{ description: 'Allowance', quantity: 1, rate: 60, taxable: false }],
    });
    await receivePayment(ctx, {
      customerId: custA, date: new Date('2026-03-14'), method: 'other', amount: '0', applications: [],
      credits: [{ creditMemoId: memo.id, invoiceId: inv.id, amount: '40.00' }],
    });
    await expect(
      updateCreditMemo(ctx, memo.id, {
        customerId: custA, date: new Date('2026-03-14'),
        lines: [{ description: 'Allowance', quantity: 1, rate: 30, taxable: false }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const edited = await updateCreditMemo(ctx, memo.id, {
      customerId: custA, date: new Date('2026-03-14'),
      lines: [{ description: 'Allowance', quantity: 1, rate: 75, taxable: false }],
    });
    expect(edited.total).toBe('75.00');
    expect(edited.unapplied).toBe('35.00');
    expect(edited.memoNumber).toBe(memo.memoNumber);
    await assertBooks();
  });

  // ---------------------------------------------------------------- C1 estimates / SOs
  it('edits an estimate until it is invoiced; conversion keeps the quoted tax', async () => {
    const est = await createEstimate(ctx, {
      customerId: custB, date: new Date('2026-03-15'), lines: [{ description: 'Quote', quantity: 1, rate: 100 }],
    });
    const edited = await updateEstimate(ctx, est.id, {
      customerId: custB, date: new Date('2026-03-15'), memo: 'revised',
      lines: [{ description: 'Quote', quantity: 2, rate: 100 }],
    });
    expect(edited.total).toBe('200.00');
    expect((await getEstimate(ctx, est.id)).estimateNumber).toBe(est.estimateNumber);
    await convertEstimate(ctx, est.id);
    await expect(
      updateEstimate(ctx, est.id, { customerId: custB, date: new Date('2026-03-15'), lines: [{ description: 'x', quantity: 1, rate: 1 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await assertBooks();
  });

  it('edits a partly invoiced sales order but keeps invoiced lines valid; invoice inherits shipping', async () => {
    const so = await createSalesOrder(ctx, {
      customerId: custB, date: new Date('2026-03-16'), shipVia: 'FedEx', poNumber: 'PO-77', fob: 'Origin',
      lines: [
        { description: 'A', quantity: 10, rate: 5 },
        { description: 'B', quantity: 4, rate: 5 },
      ],
    });
    const loaded = await getSalesOrder(ctx, so.id);
    const lineA = loaded.lines.find((l) => l.description === 'A')!;
    const inv = await convertSalesOrder(ctx, so.id, { lines: [{ lineId: lineA.id, quantity: 6 }] });
    expect(inv.poNumber).toBe('PO-77');
    expect(inv.shipVia).toBe('FedEx');

    await expect(
      updateSalesOrder(ctx, so.id, {
        customerId: custB, date: new Date('2026-03-16'),
        lines: [{ id: lineA.id, description: 'A', quantity: 5, rate: 5 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const updated = await updateSalesOrder(ctx, so.id, {
      customerId: custB, date: new Date('2026-03-16'),
      lines: [{ id: lineA.id, description: 'A', quantity: 6, rate: 5 }],
    });
    expect(updated.status).toBe('closed');
    expect(updated.lines[0].quantityInvoiced).toBe('6.0000');
    expect(updated.poNumber).toBe('PO-77');
    await assertBooks();
  });

  // ---------------------------------------------------------------- C5 / C6
  it('enters statement charges that age, show on statements, and can be edited and paid', async () => {
    const sc = await createStatementCharge(ctx, {
      customerId: custB, date: new Date('2026-02-01'), description: 'Monthly service', rate: '45.00',
    });
    expect(sc.isStatementCharge).toBe(true);
    const list = await listStatementCharges(ctx, { customerId: custB });
    expect(list.find((c) => c.id === sc.id)?.line?.description).toBe('Monthly service');
    const open = await openItemStatement(ctx, custB, new Date('2026-03-31'));
    expect(open.lines.some((l) => l.invoiceId === sc.id)).toBe(true);
    const stmt = await customerStatement(ctx, custB, { from: new Date('2026-02-01'), to: new Date('2026-02-28') });
    expect(stmt.lines.find((l) => l.type === 'statement_charge')?.amount).toBe('45.00');

    const edited = await updateStatementCharge(ctx, sc.id, {
      customerId: custB, date: new Date('2026-02-01'), description: 'Monthly service', rate: '50.00',
    });
    expect(edited.total).toBe('50.00');
    await receivePayment(ctx, {
      customerId: custB, date: new Date('2026-03-01'), method: 'cash', amount: '50.00',
      applications: [{ invoiceId: sc.id, amountApplied: '50.00' }],
    });
    expect((await getInvoice(ctx, sc.id)).status).toBe('paid');
    await assertBooks();
  });

  it('batch-invoices a group and skips (not blocks) a customer over their credit limit', async () => {
    const [limited] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Tight Credit', creditLimit: '10.00', terms: 'net_15' })
      .returning();
    const res = await createBatchInvoices(ctx, {
      customerIds: [custA, custB, limited.id],
      date: new Date('2026-03-20'),
      lines: [{ itemId: invItem, quantity: 3, rate: 10 }],
    });
    expect(res.created.map((c) => c.customerId).sort()).toEqual([custA, custB].sort());
    expect(res.skipped).toEqual([expect.objectContaining({ customerId: limited.id, code: 'CREDIT_LIMIT' })]);
    await assertBooks();

    const forced = await createBatchInvoices(ctx, {
      customerIds: [limited.id], date: new Date('2026-03-20'), overrideCreditLimit: true,
      lines: [{ itemId: invItem, quantity: 3, rate: 10 }],
    });
    expect(forced.created).toHaveLength(1);
    const inv = await getInvoice(ctx, forced.created[0].invoiceId);
    expect(inv.dueDate?.toISOString().slice(0, 10)).toBe('2026-04-04'); // net 15 from the customer
    await assertBooks();
  });

  // ---------------------------------------------------------------- C7 / C8
  it('renders PDFs for every sales form and runs the print/email queues', async () => {
    const inv = await createInvoice(ctx, {
      customerId: custA, date: new Date('2026-03-21'), shipVia: 'UPS', trackingNumber: '1ZABC',
      shipTo: { line1: '1 Dock Rd', city: 'Portland', state: 'OR', zip: '97201' }, poNumber: 'PO-1', toBePrinted: true,
      lines: [{ accountId: acct['4000'], description: 'Shipped goods', quantity: 1, rate: 12, taxable: false }],
    });
    const r = await createSalesReceipt(ctx, { customerId: custA, date: new Date('2026-03-21'), lines: [{ description: 'Cash sale', quantity: 1, rate: 5 }] });
    const m = await createCreditMemo(ctx, { customerId: custA, date: new Date('2026-03-21'), lines: [{ description: 'Credit', quantity: 1, rate: 3 }] });
    const so = await createSalesOrder(ctx, { customerId: custA, date: new Date('2026-03-21'), lines: [{ description: 'Order', quantity: 1, rate: 7 }] });
    const est = await createEstimate(ctx, { customerId: custA, date: new Date('2026-03-21'), lines: [{ description: 'Quote', quantity: 1, rate: 9 }] });
    for (const [kind, id] of [
      ['invoice', inv.id], ['sales_receipt', r.id], ['credit_memo', m.id], ['sales_order', so.id], ['estimate', est.id],
    ] as const) {
      const form = await renderSalesForm(ctx, kind, id);
      expect(Buffer.from(form.bytes.slice(0, 5)).toString()).toBe('%PDF-');
      expect(form.bytes.length).toBeGreaterThan(800);
    }

    await setSendFlags(ctx, 'credit_memo', m.id, { toBeEmailed: true });
    const printQ = await listSendQueue(ctx, 'print');
    expect(printQ.some((q) => q.kind === 'invoice' && q.id === inv.id)).toBe(true);
    const emailQ = await listSendQueue(ctx, 'email');
    expect(emailQ.find((q) => q.id === m.id)?.customerEmail).toBe('ap@acme.test');
    await markPrinted(ctx, [{ kind: 'invoice', id: inv.id }]);
    expect((await listSendQueue(ctx, 'print')).some((q) => q.id === inv.id)).toBe(false);

    // Without SMTP settings, email fails with a plain-language VALIDATION error (nothing sent).
    const saved = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      await expect(emailSalesForm(ctx, 'credit_memo', m.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    } finally {
      if (saved !== undefined) process.env.SMTP_HOST = saved;
    }
  });

  // ---------------------------------------------------------------- C9
  it('builds the Income Tracker and Collections Center', async () => {
    const overdueInv = await newInvoice(custB, 70, '2026-01-01'); // due 2026-01-31
    const est = await createEstimate(ctx, { customerId: custB, date: new Date('2026-03-25'), lines: [{ description: 'Q', quantity: 1, rate: 33 }] });
    const t = await incomeTracker(ctx, { asOf: new Date('2026-03-31'), customerId: custB });
    expect(t.rows.find((x) => x.id === overdueInv.id)).toMatchObject({ bucket: 'overdue', daysOverdue: 59 });
    expect(t.rows.find((x) => x.id === est.id)).toMatchObject({ bucket: 'unbilled', openBalance: '33.00' });
    expect(Number(t.totals.paid.amount)).toBeGreaterThan(0);

    const res = await runTrackerAction(ctx, 'convert', [{ type: 'estimate', id: est.id }, { type: 'invoice', id: overdueInv.id }]);
    expect(res.done).toHaveLength(1);
    expect(res.failed).toHaveLength(1);
    await assertBooks();

    await addCollectionNote(ctx, { customerId: custB, invoiceId: overdueInv.id, note: 'Called, promised Friday', followUpDate: new Date('2026-04-03') });
    const cc = await collectionsCenter(ctx, { asOf: new Date('2026-03-31') });
    const row = cc.overdue.find((c) => c.customerId === custB)!;
    expect(row.invoices.some((i) => i.id === overdueInv.id)).toBe(true);
    expect(row.lastNote?.note).toBe('Called, promised Friday');
    expect(row.nextFollowUp).toBe('2026-04-03');
    await expect(addCollectionNote(ctx, { customerId: custB, note: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  // ---------------------------------------------------------------- C2 route mapping
  it('maps credit-limit warnings to code CREDIT_LIMIT and FORBIDDEN to 403', async () => {
    const warn = routeErrorWithWarnings(
      new ServiceError('VALIDATION', 'Credit limit exceeded: …', { warning: 'CREDIT_LIMIT' }),
      't',
    );
    expect(warn.status).toBe(409);
    expect((await warn.json()).code).toBe('CREDIT_LIMIT');
    expect(routeErrorWithWarnings(new ServiceError('FORBIDDEN', 'no'), 't').status).toBe(403);
  });
});
