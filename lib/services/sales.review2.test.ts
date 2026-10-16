/**
 * Round-2 review regressions (sales / A/R):
 *  1. A sales receipt already in a bank deposit cannot be voided.
 *  2. A credit memo cannot be re-dated after its first refund / application.
 *  3. Finance charges on foreign-currency invoices are charged on the home value.
 *  4. Progress invoicing works for discount lines entered with a negative rate.
 *  5. Voiding an invoice puts the billable time / costs it billed back on the unbilled list.
 *  6. Undo and Accountant's Copy keep a deposit's invoice payment-item lines.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, items, accounts, taxRates, invoices } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createSalesReceipt, voidSalesReceipt } from './salesReceipts';
import { createCreditMemo, refundCreditMemo, updateCreditMemo } from './creditMemos';
import { createDeposit, getDeposit, voidDeposit, listUndepositedPayments } from './deposits';
import { createInvoice, voidInvoice } from './invoices';
import { createTimeEntry } from './timeTracking';
import { createInvoiceWithBillables, listUnbilled } from './billables';
import { assessFinanceCharges } from './financeCharges';
import { updateCompany } from './company';
import { upsertCurrency } from './currencies';
import { createEstimate, createProgressInvoice } from './estimates';
import { commitUndo, performUndo, prepareUndo } from './undo';
import { depositPayloadOf } from './accountantCopy/client';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-sales');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let discountItemId: string;
let taxRateId: string;
let paymentItemId: string;

async function balance(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return Number(row.balance).toFixed(2);
}

describe('review2 sales', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r2@sales.test', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Review2 Sales', ownerId: user.id }).returning();
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
    const [d] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Disc', type: 'discount' as never, salesPrice: '10.00', incomeAccountId: acct['4900'] })
      .returning();
    discountItemId = d.id;
    const [tr] = await db.insert(taxRates).values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000', isActive: true }).returning();
    taxRateId = tr.id;
    const [pi] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Deposit rec', type: 'payment' as never, salesPrice: '0', incomeAccountId: acct['4000'] })
      .returning();
    paymentItemId = pi.id;
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a sales receipt already in a bank deposit cannot be voided (UF would be relieved twice)', async () => {
    const sr = (await createSalesReceipt(ctx, {
      customerId,
      date: new Date('2026-05-01'),
      lines: [{ description: 'Work', quantity: 1, rate: 100, taxable: false }],
    } as never)) as { id: string };
    await createDeposit(ctx, { depositAccountId: acct['1000'], date: new Date('2026-05-02'), salesReceiptIds: [sr.id] });
    expect(await balance('1050')).toBe('0.00');
    let err: unknown = null;
    try {
      await voidSalesReceipt(ctx, sr.id);
    } catch (e) {
      err = e;
    }
    // Correct: refused (like a deposited payment / invoice payment). Bug: voids and UF goes to -100.
    expect(await balance('1050')).toBe('0.00');
    expect(err).toMatchObject({ code: 'CONFLICT' });
  });

  it('a refunded credit memo cannot be re-dated after its refund', async () => {
    const lines = [{ description: 'Return', quantity: 1, rate: 20, taxable: false }];
    const cm = (await createCreditMemo(ctx, { customerId, date: new Date('2026-06-10'), lines } as never)) as { id: string };
    await refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1000'], amount: '5.00', date: new Date('2026-06-11') });
    await expect(
      updateCreditMemo(ctx, cm.id, { customerId, date: new Date('2026-06-20'), lines } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // Re-dating on or before the refund is still fine.
    const ok = (await updateCreditMemo(ctx, cm.id, { customerId, date: new Date('2026-06-11'), lines } as never)) as {
      unapplied: string;
    };
    expect(ok.unapplied).toBe('15.00');
  });

  it('finance charges on a foreign-currency invoice are charged at its home value', async () => {
    await updateCompany(ctx, { settings: { multiCurrencyEnabled: true } });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '2' });
    const [c2] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'EUR Cust' }).returning();
    await createInvoice(ctx, {
      customerId: c2.id,
      date: new Date('2025-01-01T12:00:00Z'),
      dueDate: new Date('2025-01-01T12:00:00Z'),
      currency: 'EUR',
      exchangeRate: '2',
      overrideCreditLimit: true,
      lines: [{ description: 'Work', quantity: 1, rate: '1000.00', taxable: false }],
    } as never);
    const res = await assessFinanceCharges(ctx, { asOf: new Date('2026-01-01T12:00:00Z'), customerIds: [c2.id], settings: { annualRate: '18', minCharge: '0', graceDays: 0 } });
    expect(res.assessed).toHaveLength(1);
    const [fc] = await db.select().from(invoices).where(eq(invoices.id, res.assessed[0].invoiceId));
    // 1000 EUR x 18% x 365/365 = 180 EUR = 360 USD. Home value of the FC invoice must be 360.
    const home = Number(fc.total) * Number(fc.exchangeRate ?? 1);
    expect(home.toFixed(2)).toBe('360.00');
  });

  it('an estimate whose discount line was entered with a negative rate can be progress-invoiced', async () => {
    const est = (await createEstimate(ctx, {
      customerId,
      date: new Date('2026-05-01'),
      taxRateId,
      lines: [
        { description: 'Work', quantity: 1, rate: 100, taxable: true },
        { itemId: discountItemId, description: 'Disc', quantity: 1, rate: -10, taxable: true },
      ],
    } as never)) as { id: string; total: string };
    expect(est.total).toBe('99.00'); // the estimate accepts the negative rate
    const first = await createProgressInvoice(ctx, est.id, { percent: 50 } as never);
    expect(first.invoice.total).toBe('49.50');
  });

  it('voiding an invoice that billed time puts the time back on the unbilled list', async () => {
    const te = await createTimeEntry(ctx, {
      customerId,
      date: new Date('2026-07-01'),
      hours: 2,
      rate: '50.00',
      billable: true,
      description: 'Consulting',
    } as never);
    const inv = await createInvoiceWithBillables(
      ctx,
      { customerId, date: new Date('2026-07-02'), lines: [] } as never,
      { timeEntryIds: [te.id] },
    );
    expect(inv.total).toBe('100.00');
    expect((await listUnbilled(ctx, customerId)).time.some((t) => t.id === te.id)).toBe(false);
    await voidInvoice(ctx, inv.id);
    // Correct (QB): the voided invoice no longer bills the hours, so they can be billed again.
    expect((await listUnbilled(ctx, customerId)).time.some((t) => t.id === te.id)).toBe(true);
  });

  it("undo of a deposit void (and Accountant's Copy) keeps its invoice payment-item lines", async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-08-01'),
      lines: [
        { description: 'Work', quantity: 1, rate: 100, taxable: false },
        { itemId: paymentItemId, description: 'Paid at counter', quantity: 1, rate: 30, taxable: false },
      ],
    } as never);
    const dep = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: new Date('2026-08-02'),
      invoicePaymentIds: [inv.id],
      extraLines: [{ accountId: acct['3000'], amount: '10.00', description: 'Top-up' }],
    });
    expect(dep.total).toBe('40.00');
    const payload = (await depositPayloadOf(ctx, dep.id)) as { invoicePaymentIds?: string[] };
    expect(payload.invoicePaymentIds).toEqual([inv.id]);

    const prepared = await prepareUndo(ctx, { resource: 'deposits', kind: 'void', id: dep.id });
    await voidDeposit(ctx, dep.id);
    const armed = await commitUndo(ctx, { resource: 'deposits', kind: 'void', token: prepared.token, id: null });
    const out = await performUndo(ctx, armed.token);
    const copy = await getDeposit(ctx, out.newId!);
    expect(copy.total).toBe('40.00');
    expect(copy.lines.some((l) => l.description === `invoicePayment:${inv.id}`)).toBe(true);
    expect((await listUndepositedPayments(ctx)).some((i) => i.id === inv.id)).toBe(false);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
