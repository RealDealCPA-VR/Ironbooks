/**
 * Accountant fix round — I5 Batch Enter Transactions: item lines with quantity and tax, split
 * lines, Customer:Job, Ref passed through. Every batch-entered document must post exactly the same
 * journal lines as the same document entered on its own form (same service, same input).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like, ne } from 'drizzle-orm';
import { journalEntries, journalEntryLines } from '@/lib/db/schema';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createJob } from '../jobs';
import { createTaxRate } from '../salesTax';
import { createInvoice, getInvoice } from '../invoices';
import { createExpense, getExpense } from '../expenses';
import { createBill } from '../bills';
import { getDeposit } from '../deposits';
import { batchEnterTransactions } from './batchEnter';
import { makeTestCompany, type TestCompany } from '../testkit.prefs';

let t: TestCompany;
let customerId: string;
let jobId: string;
let vendorId: string;
let widget: string;
let taxRateId: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** The posted journal lines of a document, in a comparable form. */
async function posting(id: string) {
  const rows = await t.db
    .select({ e: journalEntries, l: journalEntryLines })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, t.ctx.companyId), like(journalEntries.sourceRef, `%:${id}`), ne(journalEntries.status, 'void')));
  expect(rows.length).toBeGreaterThan(0);
  return rows
    .map(({ l }) => [l.accountId, l.debit ?? '', l.credit ?? '', l.classId ?? '', l.entityType ?? '', l.entityId ?? ''].join('|'))
    .sort();
}

describe('I5 Batch Enter: items, tax, splits, Customer:Job, Ref', () => {
  beforeAll(async () => {
    t = await makeTestCompany('i5batch');
    customerId = (await createCustomer(t.ctx, { displayName: 'Harbor Hotel' })).id;
    jobId = (await createJob(t.ctx, { customerId, name: 'Lobby Remodel' })).id;
    vendorId = (await createVendor(t.ctx, { displayName: 'Supply House' })).id;
    widget = (await createItem(t.ctx, { name: 'Widget', type: 'non_inventory', salesPrice: '25.00', purchaseCost: '10.00', incomeAccountId: t.acct['4000'], expenseAccountId: t.acct['6300'] ?? t.acct['5000'] } as never)).id;
    taxRateId = (await createTaxRate(t.ctx, { name: 'County 8%', rate: '0.08' })).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('an invoice with an item + tax line and an account line posts the same as the invoice form', async () => {
    const res = await batchEnterTransactions(t.ctx, {
      type: 'invoice',
      rows: [
        { date: '2026-03-05', ref: 'B-100', name: 'Harbor Hotel:Lobby Remodel', account: '', item: 'Widget', quantity: '3', rate: '25.00', taxCode: 'Y', taxItem: 'County 8%', memo: 'Widgets' },
        { date: '', ref: '', name: '', account: '4000', amount: '40.00', memo: 'Delivery' },
      ],
    });
    expect(res.failed).toBe(0);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].rows).toEqual([0, 1]);
    const batchId = res.results[0].id!;
    const inv = await getInvoice(t.ctx, batchId);
    expect(inv.refNumber).toBe('B-100');
    expect((inv as { jobId?: string | null }).jobId).toBe(jobId);
    expect(inv.lines).toHaveLength(2);
    // 3 x 25 = 75 taxed at 8% = 6.00; delivery 40 untaxed.
    expect(inv.total).toBe('121.00');

    const form = await createInvoice(t.ctx, {
      customerId,
      jobId,
      refNumber: 'F-100',
      date: d('2026-03-05'),
      memo: 'Widgets',
      classId: null,
      taxRateId,
      lines: [
        { itemId: widget, accountId: null, description: 'Widgets', quantity: '3', rate: '25.00', taxable: true, classId: null },
        { itemId: null, accountId: t.acct['4000'], description: 'Delivery', quantity: 1, rate: '40.00', taxable: false, classId: null },
      ],
    });
    expect(await posting(batchId)).toEqual(await posting((form as { id: string }).id));
  });

  it('a split check with an item line and Customer:Job posts the same as Write Checks', async () => {
    const res = await batchEnterTransactions(t.ctx, {
      type: 'check',
      bankAccountId: t.acct['1000'],
      rows: [
        { date: '2026-03-06', ref: '2001', name: 'Supply House', account: '6300', amount: '12.50', memo: 'Paper', customerJob: 'Harbor Hotel:Lobby Remodel' },
        { date: '', ref: '', name: '', account: '', item: 'Widget', quantity: '4', rate: '10.00', memo: 'Widgets', customerJob: 'Harbor Hotel' },
      ],
    });
    expect(res.failed).toBe(0);
    const id = res.results[0].id!;
    const exp = await getExpense(t.ctx, id);
    expect(exp.reference).toBe('2001');
    expect(exp.lines).toHaveLength(2);
    expect(exp.total).toBe('52.50');
    const form = await createExpense(t.ctx, {
      vendorId,
      date: d('2026-03-06'),
      method: 'check',
      reference: '2002',
      paymentAccountId: t.acct['1000'],
      lines: [
        { accountId: t.acct['6300'], amount: '12.50', description: 'Paper', classId: null, customerId, jobId },
        { itemId: widget, accountId: null, quantity: '4', unitCost: '10.00', amount: null, description: 'Widgets', classId: null, customerId, jobId: null },
      ],
    });
    expect(await posting(id)).toEqual(await posting((form as { id: string }).id));
  });

  it('a bill with item quantity posts the same as Enter Bills', async () => {
    const res = await batchEnterTransactions(t.ctx, {
      type: 'bill',
      rows: [
        { date: '2026-03-07', ref: 'INV-9', name: 'Supply House', account: '', item: 'Widget', quantity: '2', amount: '20.00', customerJob: 'Harbor Hotel' },
        { date: '2026-03-07', ref: 'INV-9', name: 'Supply House', account: '6300', amount: '5.00' },
      ],
    });
    expect(res.failed).toBe(0);
    expect(res.results[0].rows).toEqual([0, 1]);
    const form = await createBill(t.ctx, {
      vendorId,
      billNumber: 'INV-10',
      date: d('2026-03-07'),
      classId: null,
      lines: [
        { itemId: widget, accountId: null, quantity: '2', unitCost: null, amount: '20.00', description: null, classId: null, customerId, jobId: null },
        { accountId: t.acct['6300'], amount: '5.00', description: null, classId: null, customerId: null, jobId: null },
      ],
    });
    expect(await posting(res.results[0].id!)).toEqual(await posting((form as { id: string }).id));
  });

  it('deposit rows keep the check number (Ref) and the Received From name', async () => {
    const res = await batchEnterTransactions(t.ctx, {
      type: 'deposit',
      bankAccountId: t.acct['1000'],
      rows: [
        { date: '2026-03-08', ref: '5512', name: 'Harbor Hotel', account: '4000', amount: '100.00', memo: 'Refund of overpayment' },
        { date: '', ref: '77', name: 'Walk-in', account: '4000', amount: '20.00' },
      ],
    });
    expect(res.failed).toBe(0);
    const dep = await getDeposit(t.ctx, res.results[0].id!);
    expect(dep.total).toBe('120.00');
    const first = dep.lines.find((l) => l.amount === '100.00')!;
    expect(first).toMatchObject({ entityType: 'customer', entityId: customerId });
    expect(first.description).toMatch(/Chk No\. 5512/);
    const second = dep.lines.find((l) => l.amount === '20.00')!;
    expect(second.description).toMatch(/Walk-in.*Chk No\. 77/);
  });

  it('refuses unknown items, jobs and tax codes, and Qty x Rate that does not match the amount', async () => {
    const res = await batchEnterTransactions(t.ctx, {
      type: 'invoice',
      mode: 'row',
      rows: [
        { date: '2026-03-09', name: 'Harbor Hotel:No Such Job', account: '', item: 'Widget', quantity: '1' },
        { date: '2026-03-09', name: 'Harbor Hotel', account: '', item: 'Gadget', quantity: '1' },
        { date: '2026-03-09', name: 'Harbor Hotel', account: '', item: 'Widget', quantity: '2', rate: '25', amount: '49.00' },
        { date: '2026-03-09', name: 'Harbor Hotel', account: '4000', amount: '5', taxCode: 'Maybe' },
      ],
    });
    expect(res.saved).toBe(0);
    const text = res.results.map((r) => r.errors.join(' '));
    expect(text[0]).toMatch(/job "No Such Job" was not found/);
    expect(text[1]).toMatch(/item "Gadget" was not found/);
    expect(text[2]).toMatch(/Qty x Rate is 50\.00, not 49\.00/);
    expect(text[3]).toMatch(/tax code "Maybe" was not found/);
  });
});
