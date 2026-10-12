/**
 * fix/sales — regression tests for the P0 sales bugs of the final audit (PARITY.md).
 *
 *  1. Progress invoicing billed the estimate's sales tax as income (a % of the estimate TOTAL
 *     on non-taxable lines). Now the invoice carries the estimate lines and computes tax itself.
 *  2. Progress invoices on inventory items relieved exactly 1 unit each time (quantity 1,
 *     rate = dollars). Now quantity = estimate qty × %, and stock / COGS follow it.
 *  3. Customer statements left out refunds (credit-memo refunds, overpayment refunds), so the
 *     statement disagreed with A/R. Statement closing balance == customer's A/R in the GL ==
 *     A/R aging total, across every A/R document type.
 *  4. Finance-charge invoices bypassed allocateDocNumber (MAX+1), breaking "INV-1001" numbering.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, items, taxAgencies, taxRates, invoices, creditMemos, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { adjustInventory } from './inventory';
import { Money } from '@/lib/money';
import { createInvoice, getInvoice, voidInvoice, updateInvoice, postDraftInvoice } from './invoices';
import { createEstimate, createProgressInvoice, getEstimate, convertToInvoice } from './estimates';
import { receivePayment, refundPayment, recordBouncedCheck } from './payments';
import { createCreditMemo, applyToInvoice, refundCreditMemo } from './creditMemos';
import { createStatementCharge } from './batchInvoicing';
import { createManualEntry, voidEntry } from './journal';
import { assessFinanceCharges } from './financeCharges';
import { setStartingDocNumber } from './docNumbers';
import { customerStatement, customerArLedgerBalance } from './statements';
import { arAging } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fix-sales-p0-' + Date.now());

let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let taxRateId: string;
let widgetId: string; // average-cost inventory item, 100 on hand @ $6

async function balanceOf(code: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, acct[code]));
  return Money.of(row?.balance ?? '0').toFixed(2);
}

async function qtyOnHand(itemId: string): Promise<string> {
  const [row] = await db.select({ q: items.quantityOnHand }).from(items).where(eq(items.id, itemId));
  return Money.of(row?.q ?? '0').toFixed(4);
}

async function newCustomer(name: string): Promise<string> {
  const [c] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: name, taxable: true }).returning();
  return c.id;
}

async function assertBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

describe('fix/sales P0 regressions', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@fix-sales-p0.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'Fix Sales P0 Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'State Board', liabilityAccountId: acct['2200'] })
      .returning();
    const [tr] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000', agencyId: agency.id, isActive: true })
      .returning();
    taxRateId = tr.id;

    const [w] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Widget',
        type: 'inventory',
        salesPrice: '20.00',
        incomeAccountId: acct['4000'],
        quantityOnHand: '0',
        averageCost: '0',
      })
      .returning();
    widgetId = w.id;
    await adjustInventory(ctx, { itemId: widgetId, quantityChange: 100, unitCost: 6, date: new Date('2025-01-01') });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // 1. Progress invoicing: sales tax is tax, not income
  // ---------------------------------------------------------------------------
  it('progress invoice of 100% books sales tax to Sales Tax Payable, not income (audit repro)', async () => {
    const customerId = await newCustomer('Tax Progress Customer');
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-03-01'),
      taxRateId,
      lines: [{ description: 'Taxable work', quantity: 1, rate: 1000, taxable: true }],
    });
    expect(est.total).toBe('1100.00');

    const incomeBefore = Money.of(await balanceOf('4000'));
    const taxBefore = Money.of(await balanceOf('2200'));
    const { invoice } = await createProgressInvoice(ctx, est.id, { percent: 100, date: new Date('2025-03-02') });

    expect(invoice.subtotal).toBe('1000.00');
    expect(invoice.taxAmount).toBe('100.00');
    expect(invoice.total).toBe('1100.00');
    // Income +1000 (not 1100), Sales Tax Payable +100 (not 0). Balances are signed by type.
    expect(Money.of(await balanceOf('4000')).minus(incomeBefore).abs().toFixed(2)).toBe('1000.00');
    expect(Money.of(await balanceOf('2200')).minus(taxBefore).abs().toFixed(2)).toBe('100.00');
    const inv = await getInvoice(ctx, invoice.id);
    expect(inv.lines[0].taxable).toBe(true);
    await assertBalanced();
  });

  it('progress invoices by % of each line, by quantity and by amount; carry class; warn past 100%', async () => {
    const customerId = await newCustomer('Line Progress Customer');
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-03-05'),
      taxRateId,
      lines: [
        { description: 'Labor', quantity: 10, rate: 50, taxable: true }, // 500
        { description: 'Permit', quantity: 1, rate: 120, taxable: false }, // 120
      ],
    });
    const full = await getEstimate(ctx, est.id);
    const labor = full.lines.find((l) => l.description === 'Labor')!;
    const permit = full.lines.find((l) => l.description === 'Permit')!;

    // Different percentage of each line.
    const r1 = await createProgressInvoice(ctx, est.id, {
      lines: [
        { lineId: labor.id, percent: 40 },
        { lineId: permit.id, percent: 100 },
      ],
      date: new Date('2025-03-06'),
    });
    const inv1 = await getInvoice(ctx, r1.invoice.id);
    const l1 = inv1.lines.find((l) => l.description === 'Labor')!;
    expect(l1.quantity).toBe('4.0000');
    expect(l1.rate).toBe('50.0000');
    expect(l1.amount).toBe('200.00');
    expect(r1.invoice.taxAmount).toBe('20.00'); // 10% of the taxable 200 only
    expect(r1.invoice.total).toBe('340.00');
    expect(r1.estimate.status).toBe('partial');

    // By quantity.
    const r2 = await createProgressInvoice(ctx, est.id, { lines: [{ lineId: labor.id, quantity: 3 }] });
    expect(r2.invoice.subtotal).toBe('150.00');

    const mid = await getEstimate(ctx, est.id);
    const laborMid = mid.lines.find((l) => l.id === labor.id)!;
    expect(laborMid.qtyInvoiced).toBe('7.0000');
    expect(laborMid.amountInvoiced).toBe('350.00');
    expect(laborMid.percentInvoiced).toBe('70.00');

    // Over 100% of Labor: warning, then allowed.
    await expect(
      createProgressInvoice(ctx, est.id, { lines: [{ lineId: labor.id, amount: 200 }] }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { warning: 'PROGRESS_OVERBILL', lines: [expect.objectContaining({ lineId: labor.id, percentBilled: '110.00' })] },
    });
    const r3 = await createProgressInvoice(ctx, est.id, {
      lines: [{ lineId: labor.id, amount: 200 }],
      allowOverBilling: true,
    });
    expect(r3.overBilled).toHaveLength(1);
    const inv3 = await getInvoice(ctx, r3.invoice.id);
    expect(inv3.lines[0].quantity).toBe('4.0000');
    expect(r3.estimate.status).toBe('closed');

    // Voiding a progress invoice gives its share back to the estimate.
    await voidInvoice(ctx, r3.invoice.id);
    const reopened = await getEstimate(ctx, est.id);
    expect(reopened.status).toBe('partial');
    expect(reopened.lines.find((l) => l.id === labor.id)!.amountInvoiced).toBe('350.00');
    expect(reopened.convertedInvoiceId).toBeNull();

    // Remaining bills exactly what is left.
    const r4 = await createProgressInvoice(ctx, est.id, { remaining: true });
    expect(r4.invoice.subtotal).toBe('150.00');
    expect(r4.estimate.status).toBe('closed');
    expect(r4.estimate.convertedInvoiceId).toBe(r4.invoice.id);
    await assertBalanced();
  });

  it('penny-exact: three bills of 33.33% / 33.33% / remaining add up to the estimate', async () => {
    const customerId = await newCustomer('Penny Customer');
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-03-07'),
      lines: [{ description: 'Odd', quantity: 3, rate: 33.35, taxable: false }], // 100.05
    });
    const a = await createProgressInvoice(ctx, est.id, { percent: '33.33' });
    const b = await createProgressInvoice(ctx, est.id, { percent: '33.33' });
    const c = await createProgressInvoice(ctx, est.id, { remaining: true });
    const sum = Money.of(a.invoice.total).plus(b.invoice.total).plus(c.invoice.total);
    expect(sum.toFixed(2)).toBe('100.05');
    expect(c.estimate.status).toBe('closed');
    const done = await getEstimate(ctx, est.id);
    expect(done.lines[0].qtyInvoiced).toBe('3.0000');
  });

  // ---------------------------------------------------------------------------
  // 2. Progress invoicing relieves the units actually billed
  // ---------------------------------------------------------------------------
  it('50% progress invoice on a 10-unit inventory estimate relieves 5 units and 5 units of COGS', async () => {
    const customerId = await newCustomer('Inventory Progress Customer');
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-04-01'),
      taxRateId,
      lines: [{ itemId: widgetId, description: 'Widget', quantity: 10, rate: 20, taxable: true }],
    });
    const qtyBefore = Money.of(await qtyOnHand(widgetId));
    const cogsBefore = Money.of(await balanceOf('5000'));

    const { invoice } = await createProgressInvoice(ctx, est.id, { percent: 50, date: new Date('2025-04-02') });
    const inv = await getInvoice(ctx, invoice.id);
    expect(inv.lines[0].itemId).toBe(widgetId);
    expect(inv.lines[0].quantity).toBe('5.0000');
    expect(inv.lines[0].rate).toBe('20.0000');
    expect(invoice.subtotal).toBe('100.00');
    expect(invoice.taxAmount).toBe('10.00');

    expect(qtyBefore.minus(Money.of(await qtyOnHand(widgetId))).toFixed(4)).toBe('5.0000');
    // 5 units × $6 average cost.
    expect(Money.of(await balanceOf('5000')).minus(cogsBefore).abs().toFixed(2)).toBe('30.00');

    // Editing the progress invoice keeps it linked to the estimate line.
    await updateInvoice(ctx, invoice.id, {
      customerId,
      date: new Date('2025-04-02'),
      taxRateId,
      memo: inv.memo,
      lines: [{ itemId: widgetId, description: 'Widget', quantity: 4, rate: 20, taxable: true }],
    });
    const afterEdit = await getEstimate(ctx, est.id);
    expect(afterEdit.lines[0].qtyInvoiced).toBe('4.0000');
    expect(afterEdit.lines[0].amountInvoiced).toBe('80.00');
    await assertBalanced();
  });

  it('a full conversion links every line, so the estimate shows 100% invoiced', async () => {
    const customerId = await newCustomer('Convert Customer');
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-04-03'),
      taxRateId,
      lines: [{ description: 'All of it', quantity: 2, rate: 75, taxable: true }],
    });
    const invoice = await convertToInvoice(ctx, est.id);
    const after = await getEstimate(ctx, est.id);
    expect(after.status).toBe('closed');
    expect(after.amountInvoiced).toBe(invoice.total);
    expect(after.lines[0].percentInvoiced).toBe('100.00');
  });

  // ---------------------------------------------------------------------------
  // 3. Statements include refunds; statement == GL == aging
  // ---------------------------------------------------------------------------
  it('a plain or pending invoice that bills estimate lines warns past 100%, saves when allowed, and re-stamps the estimate', async () => {
    const customerId = await newCustomer('Linked Lena');
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-06-01'),
      lines: [{ description: 'Labor', quantity: 10, rate: 50, taxable: false }],
    });
    const labor = (await getEstimate(ctx, est.id)).lines[0];
    // A pending invoice for 6 hours: bills nothing yet, so no warning on save.
    const draft = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-06-02'),
      status: 'draft',
      lines: [{ description: 'Labor', quantity: 6, rate: 50, taxable: false, estimateLineId: labor.id }],
    });
    // A posted invoice for another 6 hours: 60%, fine.
    await createInvoice(ctx, {
      customerId,
      date: new Date('2025-06-03'),
      lines: [{ description: 'Labor', quantity: 6, rate: 50, taxable: false, estimateLineId: labor.id }],
    });
    let e = await getEstimate(ctx, est.id);
    expect(e.amountInvoiced).toBe('300.00');
    expect(e.status).toBe('partial');
    // Posting the pending one would make it 120%: warned, nothing posted.
    await expect(postDraftInvoice(ctx, draft.id)).rejects.toMatchObject({
      details: { warning: 'PROGRESS_OVERBILL' },
    });
    expect((await getInvoice(ctx, draft.id)).status).toBe('draft');
    // The user says "save anyway".
    await postDraftInvoice(ctx, draft.id, { allowOverBilling: true });
    e = await getEstimate(ctx, est.id);
    expect(e.lines[0].amountInvoiced).toBe('600.00');
    expect(e.amountInvoiced).toBe('600.00');
    expect(e.status).toBe('closed');
    await assertBalanced();
  });

  it('voiding a refund gives the customer the credit back (memo / payment can be refunded again)', async () => {
    const customerId = await newCustomer('Void Refund Vic');
    const cm = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-07-01'),
      lines: [{ description: 'Credit', quantity: 1, rate: 90, taxable: false }],
    });
    await refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1000'], amount: 90, date: new Date('2025-07-02') });
    const [je] = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `refund:${cm.id}`)));
    await voidEntry(ctx, je.id);
    const [memo] = await db.select().from(creditMemos).where(eq(creditMemos.id, cm.id));
    expect(memo.unapplied).toBe('90.00');
    expect(memo.refundedAmount).toBe('0.00');
    expect(memo.status).toBe('open');
    expect(await customerArLedgerBalance(ctx, customerId)).toBe('-90.00');
    expect((await customerStatement(ctx, customerId)).closingBalance).toBe('-90.00');
    const aging = await arAging(ctx, new Date('2030-01-01'));
    expect(Money.of(aging.rows.find((r) => r.id === customerId)!.total).toFixed(2)).toBe('-90.00');
    // The restored credit is real: it can be refunded again, and the books end at zero.
    await refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: acct['1000'], amount: 90, date: new Date('2025-07-03') });
    expect(await customerArLedgerBalance(ctx, customerId)).toBe('0.00');
    await assertBalanced();
  });

  it('overpayment refund: statement balance matches A/R (audit repro)', async () => {
    const customerId = await newCustomer('Overpaid Olive');
    const pay = await receivePayment(ctx, {
      customerId,
      date: new Date('2025-05-01'),
      method: 'check',
      reference: 'CHK-1',
      amount: 100,
      depositAccountId: acct['1000'],
      applications: [],
    });
    await refundPayment(ctx, { paymentId: pay.payment.id, bankAccountId: acct['1000'], amount: 100, date: new Date('2025-05-02') });
    const st = await customerStatement(ctx, customerId);
    expect(st.closingBalance).toBe('0.00');
    expect(st.lines.map((l) => l.type)).toEqual(['payment', 'refund']);
    expect(await customerArLedgerBalance(ctx, customerId)).toBe('0.00');
  });

  it('statement closing balance == customer A/R in the GL == aging total, across every A/R document type', async () => {
    const customerId = await newCustomer('Everything Eve');
    const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

    // Invoice 1 (taxable) and invoice 2.
    const inv1 = await createInvoice(ctx, {
      customerId, date: d('2025-06-01'), dueDate: d('2025-06-11'), taxRateId,
      lines: [{ description: 'Service A', quantity: 1, rate: 500 }],
    }); // 550
    const inv2 = await createInvoice(ctx, {
      customerId, date: d('2025-06-02'), dueDate: d('2025-06-12'),
      lines: [{ description: 'Service B', quantity: 1, rate: 300 }],
    }); // 300
    // Retainage invoice: 10% of 1000 held back (only 900 hits A/R).
    await createInvoice(ctx, {
      customerId, date: d('2025-06-03'), dueDate: d('2025-06-13'), retainagePercent: 10,
      lines: [{ description: 'Contract work', quantity: 1, rate: 1000 }],
    });
    // Draft invoice: posts nothing, must be ignored everywhere.
    await createInvoice(ctx, {
      customerId, date: d('2025-06-04'), status: 'draft',
      lines: [{ description: 'Pending', quantity: 1, rate: 999 }],
    });
    // Payment with an early-payment discount on invoice 2.
    await receivePayment(ctx, {
      customerId, date: d('2025-06-05'), method: 'check', reference: 'CHK-10', amount: 290,
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv2.id, amountApplied: 290, discountAmount: 10 }],
    });
    // Credit memo applied to invoice 1, credit memo refunded.
    const cm1 = await createCreditMemo(ctx, {
      customerId, date: d('2025-06-06'), lines: [{ description: 'Credit', quantity: 1, rate: 50, taxable: false }],
    });
    await applyToInvoice(ctx, { creditMemoId: cm1.id, invoiceId: inv1.id, amount: 50 });
    const cm2 = await createCreditMemo(ctx, {
      customerId, date: d('2025-06-07'), lines: [{ description: 'Refundable credit', quantity: 1, rate: 80, taxable: false }],
    });
    await refundCreditMemo(ctx, { creditMemoId: cm2.id, bankAccountId: acct['1000'], amount: 80, date: d('2025-06-08') });
    // Overpayment, partly refunded.
    const over = await receivePayment(ctx, {
      customerId, date: d('2025-06-09'), method: 'check', reference: 'CHK-11', amount: 120,
      depositAccountId: acct['1000'], applications: [],
    });
    await refundPayment(ctx, { paymentId: over.payment.id, bankAccountId: acct['1000'], amount: 70, date: d('2025-06-10') });
    // Bounced check: a payment on invoice 1 that comes back.
    const bouncer = await receivePayment(ctx, {
      customerId, date: d('2025-06-11'), method: 'check', reference: 'CHK-12', amount: 100,
      depositAccountId: acct['1000'], applications: [{ invoiceId: inv1.id, amountApplied: 100 }],
    });
    await recordBouncedCheck(ctx, { paymentId: bouncer.payment.id, date: d('2025-06-12') });
    // Statement charge.
    await createStatementCharge(ctx, { customerId, date: d('2025-06-13'), description: 'Late paperwork', rate: 25 });
    // Journal entry naming the customer on A/R.
    await createManualEntry(ctx, {
      date: d('2025-06-14'),
      description: 'Write-up of customer balance',
      lines: [
        { accountId: acct['1200'], debit: '15.00', entityType: 'customer', entityId: customerId },
        { accountId: acct['4000'], credit: '15.00' },
      ],
    });
    // Finance charge on the overdue balance.
    const fc = await assessFinanceCharges(ctx, { asOf: d('2025-08-31'), customerIds: [customerId] });
    expect(fc.assessed).toHaveLength(1);

    const asOf = d('2025-09-01');
    const st = await customerStatement(ctx, customerId);
    const gl = await customerArLedgerBalance(ctx, customerId, asOf);
    const aging = await arAging(ctx, asOf);
    const agingRow = aging.rows.find((r) => r.id === customerId)!;

    const types = new Set(st.lines.map((l) => l.type));
    for (const t of ['invoice', 'payment', 'discount', 'credit_memo', 'refund', 'bounced_check', 'statement_charge', 'general_journal']) {
      expect(types.has(t as never)).toBe(true);
    }
    expect(st.lines.filter((l) => l.type === 'refund')).toHaveLength(2);
    expect(st.closingBalance).toBe(gl);
    expect(Money.of(agingRow.total).toFixed(2)).toBe(gl);

    // A statement with a date range carries the same refunds into the opening balance.
    const ranged = await customerStatement(ctx, customerId, { from: d('2025-06-09'), to: d('2025-09-01') });
    expect(ranged.closingBalance).toBe(gl);
    const before = await customerStatement(ctx, customerId, { to: d('2025-06-08') });
    expect(ranged.openingBalance).toBe(before.closingBalance);
    expect(before.closingBalance).toBe(await customerArLedgerBalance(ctx, customerId, d('2025-06-08')));
    await assertBalanced();
  });

  // ---------------------------------------------------------------------------
  // 4. Finance-charge invoices use the normal invoice numbering
  // ---------------------------------------------------------------------------
  it('finance-charge invoices continue an alphanumeric invoice sequence (INV-1001 → INV-1003 → INV-1004)', async () => {
    const customerId = await newCustomer('Late Larry');
    await setStartingDocNumber(ctx, 'invoice', 'INV-1001');
    const a = await createInvoice(ctx, {
      customerId, date: new Date('2025-01-01'), dueDate: new Date('2025-01-31'),
      lines: [{ description: 'Old work', quantity: 1, rate: 1000 }],
    });
    const b = await createInvoice(ctx, {
      customerId, date: new Date('2025-01-02'), dueDate: new Date('2025-02-01'),
      lines: [{ description: 'More old work', quantity: 1, rate: 500 }],
    });
    expect(a.refNumber).toBe('INV-1001');
    expect(b.refNumber).toBe('INV-1002');

    const res = await assessFinanceCharges(ctx, { asOf: new Date('2025-04-01'), customerIds: [customerId] });
    expect(res.assessed).toHaveLength(1);
    expect(res.assessed[0].refNumber).toBe('INV-1003');
    const [fcRow] = await db.select().from(invoices).where(eq(invoices.id, res.assessed[0].invoiceId));
    expect(fcRow.refNumber).toBe('INV-1003');

    const next = await createInvoice(ctx, {
      customerId, date: new Date('2025-04-02'), lines: [{ description: 'New work', quantity: 1, rate: 10 }],
    });
    expect(next.refNumber).toBe('INV-1004');
    await assertBalanced();
  });
});
