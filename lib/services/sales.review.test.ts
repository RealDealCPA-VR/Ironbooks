/**
 * Regression tests for the sales review findings:
 *  1. Discount / subtotal items on sales receipts, credit memos, estimates and sales orders follow
 *     the invoice rules (discounts reduce the document, subtotals post nothing; payment items are
 *     refused) — and an estimate converts to an invoice with the same total.
 *  2. Invoice payment-item lines sitting in Undeposited Funds can be deposited (once), and a
 *     voided invoice's payment leaves the list.
 *  3. Refunds of a payment / credit memo cannot be dated before the payment / memo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, items, accounts, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createSalesReceipt } from './salesReceipts';
import { createCreditMemo, refundCreditMemo } from './creditMemos';
import { convertToInvoice as convertEstimate, createEstimate, createProgressInvoice } from './estimates';
import { createSalesOrder } from './salesOrders';
import { createInvoice, voidInvoice } from './invoices';
import { createDeposit, listUndepositedPayments, voidDeposit } from './deposits';
import { receivePayment, refundPayment } from './payments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-sales-review');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let discountItemId: string;
let subtotalItemId: string;
let paymentItemId: string;
let taxRateId: string;

async function balance(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Number(row.balance).toFixed(2);
}

async function expectBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

async function entryLines(sourceRef: string) {
  return db
    .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef), eq(journalEntries.status, 'posted')));
}

describe('sales review regressions', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r@sales.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review Sales', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'undeposited_funds'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4900', 'Sales Discounts', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
    const [c] = await db.insert(customers).values({ companyId: company.id, displayName: 'Cust', taxable: true }).returning();
    customerId = c.id;
    const ins = async (name: string, type: string, salesPrice: string, incomeAccountId: string | null) =>
      (
        await db
          .insert(items)
          .values({ companyId: company.id, name, type: type as never, salesPrice, incomeAccountId })
          .returning()
      )[0].id;
    discountItemId = await ins('Disc', 'discount', '10.00', acct['4900']);
    subtotalItemId = await ins('Subtotal', 'subtotal', '0', null);
    paymentItemId = await ins('Deposit rec', 'payment', '0', acct['4000']);
    const { taxRates } = await import('@/lib/db/schema');
    const [tr] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000', isActive: true })
      .returning();
    taxRateId = tr.id;
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const lines = () => [
    { description: 'Work', quantity: 1, rate: 100, taxable: true },
    { itemId: subtotalItemId, description: 'Subtotal', quantity: 1, rate: 0, taxable: false },
    { itemId: discountItemId, description: 'Disc', quantity: 1, rate: 10, taxable: true },
  ];
  // Expected (invoice rules): subtotal 90, tax 10% of 90 = 9, total 99.

  it('invoice: discount item reduces total (control)', async () => {
    const inv = await createInvoice(ctx, { customerId, date: new Date('2026-05-01'), taxRateId, lines: lines() } as never);
    expect(inv.total).toBe('99.00');
  });

  it('sales receipt: discount reduces the total; GL debits the discount account', async () => {
    const before = Number(await balance('1050'));
    const sr = (await createSalesReceipt(ctx, { customerId, date: new Date('2026-05-01'), taxRateId, lines: lines() } as never)) as {
      id: string;
      subtotal: string;
      taxAmount: string;
      total: string;
    };
    expect(sr.subtotal).toBe('90.00');
    expect(sr.taxAmount).toBe('9.00');
    expect(sr.total).toBe('99.00');
    expect((Number(await balance('1050')) - before).toFixed(2)).toBe('99.00');
    const gl = await entryLines(`salesreceipt:${sr.id}`);
    const disc = gl.find((l) => l.accountId === acct['4900'])!;
    expect(Number(disc.debit ?? 0)).toBe(10);
    await expectBalanced();
  });

  it('credit memo: discount reduces the credit; GL credits the discount account', async () => {
    const cm = (await createCreditMemo(ctx, { customerId, date: new Date('2026-05-01'), taxRateId, lines: lines() } as never)) as {
      id: string;
      total: string;
    };
    expect(cm.total).toBe('99.00');
    const gl = await entryLines(`credit_memo:${cm.id}`);
    expect(Number(gl.find((l) => l.accountId === acct['4900'])!.credit ?? 0)).toBe(10);
    expect(Number(gl.find((l) => l.accountId === acct['1200'])!.credit ?? 0)).toBe(99);
    await expectBalanced();
  });

  it('estimate: discount reduces the total and converts to an invoice with the same total', async () => {
    const est = (await createEstimate(ctx, { customerId, date: new Date('2026-05-01'), taxRateId, lines: lines() } as never)) as {
      id: string;
      total: string;
    };
    expect(est.total).toBe('99.00');
    const inv = await convertEstimate(ctx, est.id);
    expect(inv.total).toBe(est.total);
  });

  it('estimate with a discount line can be progress-invoiced in two halves', async () => {
    const est = (await createEstimate(ctx, { customerId, date: new Date('2026-05-01'), taxRateId, lines: lines() } as never)) as {
      id: string;
    };
    const first = await createProgressInvoice(ctx, est.id, { percent: 50 } as never);
    expect(first.invoice.total).toBe('49.50');
    const second = await createProgressInvoice(ctx, est.id, { remaining: true } as never);
    expect(second.invoice.total).toBe('49.50');
    expect(second.estimate.status).toBe('closed');
  });

  it('sales order: discount reduces the total', async () => {
    const so = (await createSalesOrder(ctx, { customerId, date: new Date('2026-05-01'), taxRateId, lines: lines() } as never)) as {
      total: string;
    };
    expect(so.total).toBe('99.00');
  });

  it('payment items are refused on a sales receipt', async () => {
    await expect(
      createSalesReceipt(ctx, {
        customerId,
        date: new Date('2026-05-01'),
        lines: [
          { description: 'Work', quantity: 1, rate: 100 },
          { itemId: paymentItemId, description: 'Paid', quantity: 1, rate: 30 },
        ],
      } as never),
    ).rejects.toThrow(/payment item/);
  });

  it('invoice payment-item lines are listed, deposited once, and cannot be voided while deposited', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-05-02'),
      lines: [
        { description: 'Work', quantity: 1, rate: 100, taxable: false },
        { itemId: paymentItemId, description: 'Paid at counter', quantity: 1, rate: 30, taxable: false },
      ],
    } as never);
    const listed = (await listUndepositedPayments(ctx)).find((i) => i.id === inv.id);
    expect(listed?.kind).toBe('invoice_payment');
    expect(listed?.amount).toBe('30.00');

    const ufBefore = Number(await balance('1050'));
    const bankBefore = Number(await balance('1000'));
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: new Date('2026-05-03'),
      invoicePaymentIds: [inv.id],
    });
    expect(dep.total).toBe('30.00');
    expect((ufBefore - Number(await balance('1050'))).toFixed(2)).toBe('30.00');
    expect((Number(await balance('1000')) - bankBefore).toFixed(2)).toBe('30.00');
    expect((await listUndepositedPayments(ctx)).some((i) => i.id === inv.id)).toBe(false);

    // Not twice.
    await expect(
      createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-05-03'), invoicePaymentIds: [inv.id] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The invoice can't be voided while its payment is in the deposit.
    await expect(voidInvoice(ctx, inv.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // Void the deposit: back on the list; void the invoice: off the list again.
    await voidDeposit(ctx, dep.id);
    expect((await listUndepositedPayments(ctx)).some((i) => i.id === inv.id)).toBe(true);
    await voidInvoice(ctx, inv.id);
    expect((await listUndepositedPayments(ctx)).some((i) => i.id === inv.id)).toBe(false);
    await expect(
      createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-05-03'), invoicePaymentIds: [inv.id] }),
    ).rejects.toBeInstanceOf(ServiceError);
    await expectBalanced();
  });

  it('refunds cannot be dated before the payment / credit memo', async () => {
    const { payment } = (await receivePayment(ctx, {
      customerId,
      date: new Date('2026-06-10'),
      method: 'check',
      amount: '50.00',
      applications: [],
    } as never)) as { payment: { id: string } };
    await expect(
      refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '10.00', date: new Date('2026-06-09') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const ok = await refundPayment(ctx, {
      paymentId: payment.id,
      bankAccountId: acct['1000'],
      amount: '10.00',
      date: new Date('2026-06-10'),
    });
    expect(ok.payment.unapplied).toBe('40.00');

    const cm = (await createCreditMemo(ctx, {
      customerId,
      date: new Date('2026-06-10'),
      lines: [{ description: 'Return', quantity: 1, rate: 20, taxable: false }],
    } as never)) as { id: string };
    await expect(
      refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1000'], amount: '5.00', date: new Date('2026-06-01') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await refundCreditMemo(ctx, {
      creditMemoId: cm.id,
      bankAccountId: acct['1000'],
      amount: '5.00',
      date: new Date('2026-06-11'),
    });
    expect(r.creditMemo.unapplied).toBe('15.00');
    await expectBalanced();
  });
});
