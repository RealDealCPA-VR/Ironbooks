/**
 * Round-5 review regressions (sales / A/R):
 *  1. Receive Payments / Sales Receipt "Journal" (Ctrl+Y / Ctrl+H): the toolbar names the document
 *     (payment:<id>, salesreceipt:<id>); the lookup must answer the entry that document posted.
 *  2. Re-saving an unchanged sales receipt of an average-cost item keeps the average and the COGS.
 *  3. Retainage: an edit may not leave Retainage Receivable negative (release more than is held).
 *  4. Finance charges count interest from the last finance charge, not again from the due date.
 *  5. Commissions: a 2.5% rate is kept at 4 decimals and commission is on sales, not sales tax.
 *  6. Re-saving an unchanged final progress invoice keeps its exact amount (estimate stays closed).
 *  7. "Today" on the server is the company's calendar day (estimate conversion, Income Tracker,
 *     Collections Center, expiring estimates), not the UTC day.
 *  8. Transaction History (Ctrl+H) of an invoice: undone credit applications are not listed and
 *     documents show the number the user typed.
 *  9. Collection letters list invoices by their document number.
 * 10. Fulfillment packing slips ship to the sales order's own ship-to address.
 * 11. The emailed / queued invoice PDF prints in the invoice's currency.
 * 12. Bad amounts / dates on payment, credit-memo and estimate actions answer 400, not 500.
 * 13. Billable costs from a foreign-currency bill are billed at their home amount.
 * 14. Customer balance summary: unapplied credit memos and foreign invoices at home value.
 * 15. Voiding the same invoice twice at once gives its sales order the quantities back only once.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  companies,
  customers,
  estimateLines,
  invoices,
  items,
  journalEntryLines,
  journalEntries,
  salesOrderLines,
  salesReps,
  taxRates,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createInvoice, getInvoice, updateInvoice, voidInvoice } from './invoices';
import { listBouncedChecks, receivePayment, recordBouncedCheck, updatePayment } from './payments';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { adjustInventory } from './inventory';
import { billRetainage, openRetainage } from './retainage';
import { assessFinanceCharges, previewFinanceCharges } from './financeCharges';
import { commissionReport, createSalesRep, updateSalesRep } from './salesReps';
import { convertToInvoice as convertEstimate, createEstimate, createProgressInvoice, getEstimate } from './estimates';
import { collectionsCenter, incomeTracker } from './incomeTracker';
import { listExpiringEstimates } from './estimateExpiry';
import { openItemStatement } from './statements';
import { buildLinkedTree } from './linkedTransactions';
import { applyToInvoice, createCreditMemo, listCreditApplications, unapplyCreditApplication } from './creditMemos';
import { listRecipients } from './letters';
import { convertToInvoice as convertSalesOrder, createSalesOrder } from './salesOrders';
import { planShipments } from './fulfillment';
import { packingSlipData } from '@/lib/fulfillmentPrint';
import { renderSalesForm } from './salesForms';
import { listUnbilled } from './billables';
import { createBill } from './bills';
import { setBaseCurrency, upsertCurrency } from './currencies';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
const pdfCalls: Array<Record<string, unknown>> = [];
vi.mock('@/lib/pdf/invoice', async (orig) => ({
  ...(await orig<typeof import('@/lib/pdf/invoice')>()),
  renderInvoicePdf: vi.fn(async (data: Record<string, unknown>) => {
    pdfCalls.push(data);
    return new Uint8Array([37, 80, 68, 70]);
  }),
}));
import { GET as forSourceGET } from '@/app/api/journal-entries/for-source/route';
import { POST as paymentPOST } from '@/app/api/payments/[id]/route';
import { POST as creditMemoPOST } from '@/app/api/credit-memos/[id]/route';
import { POST as estimatePOST } from '@/app/api/estimates/[id]/route';
import { POST as expirePOST } from '@/app/api/estimates/expire/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-sales');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (x: Date | string) => new Date(x).toISOString().slice(0, 10);

function req(url: string, body?: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function serviceItem(name = 'Consulting', price = '100.00') {
  const [it] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name: `${name} ${seq}`, type: 'service' as never, salesPrice: price, incomeAccountId: acct['4000'] })
    .returning();
  return it.id;
}

async function inventoryItem(name = 'Widget') {
  const [it] = await db
    .insert(items)
    .values({
      companyId: ctx.companyId,
      name: `${name} ${seq}`,
      type: 'inventory' as never,
      salesPrice: '10.00',
      incomeAccountId: acct['4000'],
      assetAccountId: acct['1300'],
      expenseAccountId: acct['5000'],
    })
    .returning();
  return it.id;
}

async function newCustomer(name: string, extra: Record<string, unknown> = {}) {
  return (await createCustomer(ctx, { displayName: `${name} ${seq}`, ...extra } as never)).id;
}

async function plainInvoice(customerId: string, amount: string, date = '2026-03-01', extra: Record<string, unknown> = {}) {
  return createInvoice(ctx, {
    customerId,
    date: d(date),
    taxRateId: null,
    lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: amount, taxable: false }],
    ...extra,
  } as never);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'r5-sales@test.local', name: 'R5 Sales', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `R5 Sales ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

describe('1. Journal / history lookup for a payment and a sales receipt', () => {
  it('payment:<id> answers the payment’s own journal entry', async () => {
    const cust = await newCustomer('Payer');
    const inv = await plainInvoice(cust, '250.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '250.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '250.00' }],
    });
    const res = await forSourceGET(req(`/api/journal-entries/for-source?ref=payment:${payment.id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).entryId).toBe(payment.postedEntryId);
  });

  it('salesreceipt:<id> answers the receipt entry, not one of its COGS entries', async () => {
    const widget = await inventoryItem();
    await adjustInventory(ctx, { itemId: widget, quantityChange: 10, unitCost: '2.00', date: d('2026-03-01') });
    const sr = await createSalesReceipt(ctx, {
      date: d('2026-03-02'),
      depositAccountId: acct['1000'],
      lines: [
        { itemId: widget, quantity: 1, rate: '10.00', taxable: false },
        { itemId: widget, quantity: 2, rate: '10.00', taxable: false },
      ],
    });
    const res = await forSourceGET(req(`/api/journal-entries/for-source?ref=salesreceipt:${sr.id}`));
    expect(res.status).toBe(200);
    expect((await res.json()).entryId).toBe(sr.postedEntryId);
  });
});

describe('2. Sales receipt re-save keeps average cost and COGS', () => {
  it('saving an unchanged sales receipt does not move the average or the cost of goods sold', async () => {
    const widget = await inventoryItem();
    // 3 units at 3.3333: average 3.3333, book value 10.00.
    await adjustInventory(ctx, { itemId: widget, quantityChange: 3, unitCost: '3.3333', date: d('2026-03-01') });
    const input = {
      date: d('2026-03-02'),
      depositAccountId: acct['1000'],
      lines: [{ itemId: widget, quantity: 1, rate: '10.00', taxable: false }],
    };
    const sr = await createSalesReceipt(ctx, input);
    const cogsOf = async () => {
      const rows = await db
        .select({ debit: journalEntryLines.debit })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
        .where(
          and(
            eq(journalEntries.companyId, ctx.companyId),
            eq(journalEntries.sourceRef, `salesreceipt:${sr.id}`),
            eq(journalEntries.status, 'posted'),
            eq(journalEntryLines.accountId, acct['5000']),
          ),
        );
      return rows.map((r) => r.debit);
    };
    expect(await cogsOf()).toEqual(['3.33']);
    await updateSalesReceipt(ctx, sr.id, input);
    await updateSalesReceipt(ctx, sr.id, input);
    const [item] = await db.select().from(items).where(eq(items.id, widget));
    expect(item.averageCost).toBe('3.3333');
    expect(item.quantityOnHand).toBe('2.0000');
    expect(await cogsOf()).toEqual(['3.33']);
  });
});

describe('3. Retainage cannot be released twice through an edit', () => {
  it('removing the retainage from an invoice whose retainage was billed is refused', async () => {
    const cust = await newCustomer('Contractor');
    const inv = await plainInvoice(cust, '1000.00', '2026-03-01', { retainagePercent: 10 });
    expect(inv.retainageAmount).toBe('100.00');
    await billRetainage(ctx, { customerId: cust, date: d('2026-04-01') });
    expect(await openRetainage(ctx, cust)).toBe('0.00');
    await expect(
      updateInvoice(ctx, inv.id, {
        customerId: cust,
        date: d('2026-03-01'),
        taxRateId: null,
        retainagePercent: null,
        lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '1000.00', taxable: false }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await openRetainage(ctx, cust)).toBe('0.00');
  });

  it('raising a retainage billing invoice above what is held is refused', async () => {
    const cust = await newCustomer('Contractor B');
    await plainInvoice(cust, '1000.00', '2026-03-01', { retainagePercent: 10 });
    const bill = await billRetainage(ctx, { customerId: cust, date: d('2026-04-01'), amount: '60.00' });
    await expect(
      updateInvoice(ctx, bill.id, {
        customerId: cust,
        date: d('2026-04-01'),
        taxRateId: null,
        memo: 'Retainage billed',
        lines: [{ accountId: acct['1250'], description: 'Retainage billed', quantity: 1, rate: '150.00', taxable: false }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await openRetainage(ctx, cust)).toBe('40.00');
  });
});

describe('4. Finance charges', () => {
  it('a second assessment charges only the days since the last finance charge', async () => {
    const cust = await newCustomer('Late payer');
    await plainInvoice(cust, '1000.00', '2026-01-01', { dueDate: d('2026-01-30') });
    const settings = { annualRate: '18', minCharge: '0', graceDays: 0 };
    const first = await assessFinanceCharges(ctx, { asOf: d('2026-03-01'), settings });
    // 1000 x 18% / 365 x 30 days
    expect(first.assessed.map((a) => a.charge)).toEqual(['14.79']);
    const preview = await previewFinanceCharges(ctx, { asOf: d('2026-04-01'), settings });
    const row = preview.customers.find((c) => c.customerId === cust)!;
    // Only Mar 1 -> Apr 1 (31 days) is new: 1000 x 18% / 365 x 31 = 15.29.
    expect(row.overdueInvoices[0].daysOverdue).toBe(61);
    expect(row.overdueInvoices[0].daysCharged).toBe(31);
    expect(row.charge).toBe('15.29');
    // Voiding that earlier finance charge puts those days back in.
    const [fc] = first.assessed;
    await voidInvoice(ctx, fc.invoiceId);
    const again = await previewFinanceCharges(ctx, { asOf: d('2026-04-01'), settings });
    expect(again.customers.find((c) => c.customerId === cust)!.overdueInvoices[0].daysCharged).toBe(61);
  });
});

describe('5. Sales rep commissions', () => {
  it('keeps a 2.5% rate and pays commission on sales, not on sales tax', async () => {
    const rep = await createSalesRep(ctx, { name: `Rep ${seq}`, commissionRate: '0.025' });
    expect(rep.commissionRate).toBe('0.0250');
    const again = await updateSalesRep(ctx, rep.id, { commissionRate: '0.0125' });
    expect(again.commissionRate).toBe('0.0125');
    await updateSalesRep(ctx, rep.id, { commissionRate: '0.025' });
    const [tax] = await db.insert(taxRates).values({ companyId: ctx.companyId, name: 'State 8%', rate: '0.080000' }).returning();
    const cust = await newCustomer('Buyer');
    await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-10'),
      salesRepId: rep.id,
      taxRateId: tax.id,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '1000.00', taxable: true }],
    });
    const report = await commissionReport(ctx, { from: d('2026-03-01'), to: d('2026-03-31') });
    const row = report.rows.find((r) => r.repId === rep.id)!;
    expect(row.salesTotal).toBe('1000.00');
    expect(row.commission).toBe('25.00');
  });
});

describe('6. Final progress invoice re-save', () => {
  it('an unchanged re-save keeps the exact final amount and the estimate stays closed', async () => {
    const cust = await newCustomer('Builder');
    const svc = await serviceItem('Framing', '33.3333');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      lines: [{ itemId: svc, quantity: 3, rate: '33.3333', taxable: false }],
    });
    const line = (await getEstimate(ctx, est.id)).lines[0];
    expect(line.amount).toBe('100.00');
    for (const date of ['2026-03-05', '2026-03-10']) {
      await createProgressInvoice(ctx, est.id, { lines: [{ lineId: line.id, quantity: 1 }], date: d(date) });
    }
    const last = await createProgressInvoice(ctx, est.id, { remaining: true, date: d('2026-03-15') });
    expect(last.invoice.total).toBe('33.34');
    expect(last.estimate.status).toBe('closed');
    const saved = await getInvoice(ctx, last.invoice.id);
    const edited = await updateInvoice(ctx, saved.id, {
      customerId: cust,
      date: saved.date,
      taxRateId: null,
      memo: 'Final billing',
      lines: saved.lines.map((l) => ({
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        taxable: l.taxable,
        estimateLineId: l.estimateLineId,
      })),
    });
    expect(edited.total).toBe('33.34');
    const after = await getEstimate(ctx, est.id);
    expect(after.status).toBe('closed');
    expect(after.lines[0].amountInvoiced).toBe('100.00');
  });
});

describe('7. The server’s "today" is the company’s calendar day', () => {
  // 9:30 pm on Oct 26 in New York (the company's time zone) is already Oct 27 in UTC.
  const EVENING = new Date('2026-10-27T01:30:00.000Z');
  const useEvening = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING);
  };

  it('converting an estimate dates the invoice today', async () => {
    const cust = await newCustomer('Quote taker');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-10-20'),
      taxRateId: null,
      lines: [{ description: 'Job', quantity: 1, rate: '500.00', taxable: false }],
    });
    useEvening();
    const inv = await convertEstimate(ctx, est.id);
    expect(new Date(inv.date).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('Income Tracker and Collections Center: an invoice due today is not overdue yet', async () => {
    const cust = await newCustomer('Due today');
    const inv = await plainInvoice(cust, '300.00', '2026-10-01', { dueDate: d('2026-10-26') });
    useEvening();
    const tracker = await incomeTracker(ctx);
    expect(tracker.asOf).toBe('2026-10-26');
    expect(tracker.rows.find((r) => r.id === inv.id)?.bucket).toBe('unpaid');
    const center = await collectionsCenter(ctx);
    expect(center.asOf).toBe('2026-10-26');
    expect(center.overdue.find((c) => c.customerId === cust)).toBeUndefined();
    expect(center.almostDue.find((c) => c.customerId === cust)?.invoices[0].daysPastDue).toBe(0);
    const stmt = await openItemStatement(ctx, cust);
    expect(stmt.asOf).toBe('2026-10-26');
    expect(stmt.lines.find((l) => l.docId === inv.id)?.daysPastDue).toBe(0);
  });

  it('an estimate that expires today is still listed as expiring, and is not expired yet', async () => {
    const cust = await newCustomer('Expiring');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-10-01'),
      expirationDate: d('2026-10-26'),
      taxRateId: null,
      lines: [{ description: 'Quote', quantity: 1, rate: '50.00', taxable: false }],
    });
    useEvening();
    expect((await listExpiringEstimates(ctx, 7)).map((e) => e.id)).toContain(est.id);
    const res = await expirePOST(req('/api/estimates/expire', {}));
    expect(res.status).toBe(200);
    expect((await getEstimate(ctx, est.id)).status).toBe('draft');
  });
});

describe('8. Transaction History of an invoice', () => {
  it('lists only the credit applications still in place, with the typed document numbers', async () => {
    const cust = await newCustomer('History');
    const inv = await plainInvoice(cust, '400.00', '2026-03-01', { refNumber: 'INV-5001' });
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      refNumber: 'CM-77',
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00', taxable: false }],
    });
    await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '60.00' });
    const [app] = await listCreditApplications(ctx, { invoiceId: inv.id });
    await unapplyCreditApplication(ctx, app.id);
    const tree = await buildLinkedTree(ctx, 'invoice', inv.id);
    expect(tree.label).toBe('Invoice #INV-5001');
    expect((tree.children ?? []).filter((c) => c.kind === 'credit_memo')).toEqual([]);

    await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '25.00' });
    const again = await buildLinkedTree(ctx, 'invoice', inv.id);
    const cm = (again.children ?? []).filter((c) => c.kind === 'credit_memo');
    expect(cm.map((c) => [c.label, c.amount])).toEqual([['Credit Memo #CM-77', '25.00']]);
    const memoTree = await buildLinkedTree(ctx, 'credit_memo', memo.id);
    expect(memoTree.label).toBe('Credit Memo #CM-77');
    expect((memoTree.children ?? []).map((c) => [c.label, c.amount])).toEqual([['Invoice #INV-5001', '25.00']]);
  });
});

describe('9. Collection letters', () => {
  it('list open invoices by the number printed on them', async () => {
    const cust = await newCustomer('Letter');
    await plainInvoice(cust, '120.00', '2026-03-01', { refNumber: 'INV-9001', dueDate: d('2026-03-31') });
    const [r] = await listRecipients(ctx, { type: 'customer', ids: [cust], today: '2026-05-01' });
    expect(r.invoiceList).toContain('Invoice INV-9001');
  });
});

describe('10. Fulfillment packing slips', () => {
  it('ship to the address on the sales order', async () => {
    const cust = await newCustomer('Shipper', { shippingAddress: { line1: '1 Main St', city: 'Albany', state: 'NY', zip: '12207' } });
    const svc = await serviceItem('Install');
    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      shipTo: { line1: '99 Dock Rd', city: 'Reno', state: 'NV', zip: '89501' },
      lines: [{ itemId: svc, quantity: 2, rate: '100.00', taxable: false }],
    });
    const shipments = await planShipments(ctx, [{ salesOrderId: so.id }]);
    const [slip] = await packingSlipData(ctx, 'R5 Co', shipments, '2026-03-02');
    expect(slip.shipToLines?.[0]).toBe('99 Dock Rd');
  });
});

describe('11. Invoice PDF for email / print queue', () => {
  it('prints in the invoice’s currency', async () => {
    const cust = await newCustomer('Euro buyer');
    const inv = await plainInvoice(cust, '100.00');
    await db.update(invoices).set({ currency: 'EUR', exchangeRate: '1.20000000' }).where(eq(invoices.id, inv.id));
    pdfCalls.length = 0;
    await renderSalesForm(ctx, 'invoice', inv.id);
    expect(pdfCalls[0]?.currency).toBe('EUR');
  });
});

describe('12. Bad input on A/R actions is a 400', () => {
  it('payment apply / refund and credit-memo apply / refund with a bad amount or date', async () => {
    const cust = await newCustomer('Bad input');
    const inv = await plainInvoice(cust, '100.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      amount: '150.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    });
    const bad: Array<{ status: number }> = [
      await paymentPOST(req(`/api/payments/${payment.id}`, { action: 'apply', applications: [{ invoiceId: inv.id, amountApplied: 'abc' }] }), params(payment.id)),
      await paymentPOST(req(`/api/payments/${payment.id}`, { action: 'unapply', invoiceId: inv.id, amount: 'lots' }), params(payment.id)),
      await paymentPOST(req(`/api/payments/${payment.id}`, { action: 'refund', bankAccountId: acct['1000'], amount: '10.00', date: 'not-a-date' }), params(payment.id)),
      await paymentPOST(req(`/api/payments/${payment.id}`, { action: 'refund', bankAccountId: acct['1000'], amount: 'ten' }), params(payment.id)),
    ];
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00', taxable: false }],
    });
    bad.push(
      await creditMemoPOST(req(`/api/credit-memos/${memo.id}`, { action: 'apply', invoiceId: inv.id, amount: 'abc' }), params(memo.id)),
      await creditMemoPOST(req(`/api/credit-memos/${memo.id}`, { action: 'refund', bankAccountId: acct['1000'], amount: '5.00', date: 'garbage' }), params(memo.id)),
    );
    expect(bad.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
  });

  it('estimate progress with a percentage that is not a number', async () => {
    const cust = await newCustomer('Progress bad');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      lines: [{ description: 'Job', quantity: 1, rate: '500.00', taxable: false }],
    });
    const res = await estimatePOST(req(`/api/estimates/${est.id}`, { action: 'progress', percent: 'half' }), params(est.id));
    expect(res.status).toBe(400);
  });
});

describe('13. Billable costs from a foreign-currency bill', () => {
  it('are billed at the home amount the bill posted', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const cust = await newCustomer('Reimburser');
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: `Euro vendor ${seq}`, currency: 'EUR' }).returning();
    await createBill(ctx, {
      vendorId: v.id,
      date: d('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.20',
      lines: [{ accountId: acct['6300'], amount: '100.00', customerId: cust, description: 'Parts' }],
    } as never);
    const unbilled = await listUnbilled(ctx, cust);
    expect(unbilled.costs.map((c) => c.amount)).toEqual(['120.00']);
  });
});

describe('14. Customer balance summary', () => {
  it('nets unapplied credit memos and converts foreign invoices to home currency', async () => {
    const cust = await newCustomer('Summary');
    await plainInvoice(cust, '500.00');
    await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00', taxable: false }],
    });
    const euro = await plainInvoice(cust, '100.00', '2026-03-03');
    await db.update(invoices).set({ currency: 'EUR', exchangeRate: '1.20000000' }).where(eq(invoices.id, euro.id));
    const row = (await customerBalanceSummary(ctx)).find((r) => r.customerId === cust)!;
    // 500 + 120 (EUR 100 at 1.20) - 100 credit
    expect(row.totalBalanceDue).toBe('520.00');
  });
});

describe('15. Double void of an invoice made from a sales order', () => {
  it('gives the order the invoiced quantity back once', async () => {
    const cust = await newCustomer('Orderer');
    const svc = await serviceItem('Units');
    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      lines: [{ itemId: svc, quantity: 10, rate: '10.00', taxable: false }],
    });
    const [line] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    const a = await convertSalesOrder(ctx, so.id, { lines: [{ lineId: line.id, quantity: 4 }] });
    await convertSalesOrder(ctx, so.id);
    await Promise.allSettled([voidInvoice(ctx, a.id), voidInvoice(ctx, a.id)]);
    const [after] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.id, line.id));
    expect(after.quantityInvoiced).toBe('6.0000');
  });
});

// Keep unused-import lint quiet for helpers used only in some cases.
void companies;
void customers;
void estimateLines;
void salesReps;
void getSalesReceipt;

describe('16. Payment double submits', () => {
  async function paidInvoice(label: string) {
    const cust = await newCustomer(label);
    const inv = await plainInvoice(cust, '200.00');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      method: 'check',
      reference: '1001',
      amount: '200.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '200.00' }],
    });
    return { cust, inv, payment };
  }
  const arBalance = async () => {
    const [a] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, acct['1200']));
    return a.balance;
  };

  it('recording the same bounced check twice at once reverses the payment once', async () => {
    const { payment } = await paidInvoice('Bouncer');
    const res = await Promise.allSettled([
      recordBouncedCheck(ctx, { paymentId: payment.id, date: d('2026-03-10') }),
      recordBouncedCheck(ctx, { paymentId: payment.id, date: d('2026-03-10') }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await listBouncedChecks(ctx)).toHaveLength(1);
    expect(await arBalance()).toBe('200.00');
  });

  it('saving the same payment edit twice at once leaves one posted payment entry', async () => {
    const { cust, inv, payment } = await paidInvoice('Editor');
    const edit = {
      customerId: cust,
      date: d('2026-03-06'),
      method: 'check' as const,
      reference: '1001',
      amount: '150.00',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '150.00' }],
    };
    await Promise.allSettled([updatePayment(ctx, payment.id, edit), updatePayment(ctx, payment.id, edit)]);
    const live = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `customer:${cust}`),
          eq(journalEntries.status, 'posted'),
        ),
      );
    expect(live).toHaveLength(1);
    expect(await arBalance()).toBe('50.00');
    expect((await getInvoice(ctx, inv.id)).balanceDue).toBe('50.00');
  });
});

describe('17. Transaction History of partial invoices shows their source document', () => {
  it('a progress invoice lists its estimate and a partial sales-order invoice lists its order', async () => {
    const cust = await newCustomer('Sources');
    const svc = await serviceItem('Phase');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      refNumber: 'Q-12',
      taxRateId: null,
      lines: [{ itemId: svc, quantity: 4, rate: '100.00', taxable: false }],
    });
    const progress = await createProgressInvoice(ctx, est.id, { percent: 25, date: d('2026-03-05') });
    const pTree = await buildLinkedTree(ctx, 'invoice', progress.invoice.id);
    expect((pTree.children ?? []).filter((c) => c.kind === 'estimate').map((c) => c.label)).toEqual(['Estimate #Q-12']);

    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      refNumber: 'SO-7',
      taxRateId: null,
      lines: [{ itemId: svc, quantity: 10, rate: '10.00', taxable: false }],
    });
    const [line] = await db.select().from(salesOrderLines).where(eq(salesOrderLines.salesOrderId, so.id));
    const part = await convertSalesOrder(ctx, so.id, { lines: [{ lineId: line.id, quantity: 3 }] });
    const sTree = await buildLinkedTree(ctx, 'invoice', part.id);
    expect((sTree.children ?? []).filter((c) => c.kind === 'sales_order').map((c) => c.label)).toEqual(['Sales Order #SO-7']);
  });
});

describe('18. Indexes on A/R lines and applications (migration 0064)', () => {
  it('a document’s lines, its applications and a customer’s invoices are looked up by index', async () => {
    const rows = (await db.execute(sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)) as unknown as {
      rows: Array<{ indexname: string }>;
    };
    const names = new Set(rows.rows.map((r) => r.indexname));
    for (const n of [
      'invoice_lines_invoice_idx',
      'invoices_company_customer_idx',
      'payment_applications_payment_idx',
      'payment_applications_invoice_idx',
      'payments_received_company_customer_idx',
      'credit_memos_company_customer_idx',
      'credit_memo_lines_memo_idx',
      'credit_applications_payment_idx',
      'sales_receipt_lines_receipt_idx',
      'estimate_lines_estimate_idx',
      'sales_order_lines_order_idx',
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});
