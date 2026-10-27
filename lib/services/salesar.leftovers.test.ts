/**
 * Team salesar — the sales review leftovers (round 5), each reproduced first:
 *  1. Server-dated sales postings (refunds, bounced checks, FX plugs of later applications, the
 *     credit-application fallback) use the company's calendar day, not the UTC day.
 *  2. Undo of an invoice edit that moved it to another customer bills the cost again.
 *  3. A bill edit that re-creates its lines keeps the invoice line's billable link working.
 *  4. The Accountant's Copy invoice payload carries the billable link.
 *  5. A Pay Sales Tax payment / sales tax adjustment cannot be reversed from the journal window.
 *  6. The customers-area journal-items route only applies A/R journal credits.
 *  7. Customer / Vendor Center balances come from the ledger.
 *  8. An invoice made from a sales order: editing its quantity moves the order's invoiced quantity.
 *  9. Billable / job-costing lines: the job must belong to the line's customer.
 * 10. Sales receipt / credit memo edits keep the stock at the site the line was saved with.
 * 11. Credit memos carry a class and a job; a write-off takes the invoice's.
 * 12. Editing an estimate keeps its line ids (links of invoices made from it survive).
 * 13. Income Tracker as of a past date: a taxed estimate partly billed later.
 * 14. Estimate sales-tax item lines count as billed under progress invoicing.
 * 15. Collection letters print home-currency balances (foreign documents at their booked rate).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  billLines,
  bouncedChecks,
  creditApplications,
  creditMemoLines,
  creditMemos,
  estimateLines,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  taxAgencies,
  taxRates,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, listCustomersWithBalances } from './customers';
import { createVendor, listVendorsWithBalances } from './vendors';
import { createInvoice, getInvoice, updateInvoice, voidInvoice } from './invoices';
import { applyPayment, receivePayment, recordBouncedCheck, refundPayment, unapplyFromInvoice } from './payments';
import { applyToInvoice, createCreditMemo, getCreditMemo, refundCreditMemo, updateCreditMemo } from './creditMemos';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createInvoiceWithBillables, listUnbilled } from './billables';
import { createBill, updateBill, getBill } from './bills';
import { createExpense } from './expenses';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { commitUndo, performUndo, prepareUndo } from './undo';
import { docPayload, updateDoc } from './accountantCopy/docs';
import { DOC_SHAPES, matchesShape } from './accountantCopy/format';
import { postJournalEntry } from './posting';
import { reverseEntry, voidEntry } from './journal';
import { applyJournalCredit } from './journalApplications';
import { convertToInvoice as convertSalesOrder, createSalesOrder, getSalesOrder } from './salesOrders';
import { createJob } from './jobs';
import { createClass } from './dimensions';
import { createSite, quantityAtSite } from './inventorySites';
import { writeOffInvoices } from './accountant/writeOff';
import { convertToInvoice as convertEstimate, createEstimate, createProgressInvoice, getEstimate, updateEstimate } from './estimates';
import { incomeTracker } from './incomeTracker';
import { listRecipients } from './letters';
import { Money } from '@/lib/money';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as journalItemsPOST } from '@/app/api/payments/journal-items/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-leftovers');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (x: Date | string) => new Date(x).toISOString().slice(0, 10);
// 9:30 pm on Oct 26 in New York (the company's default time zone) is already Oct 27 in UTC.
const EVENING = new Date('2026-10-27T01:30:00.000Z');
const useEvening = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EVENING);
};

function req(url: string, body?: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}

async function serviceItem(name = 'Consulting', price = '100.00', extra: Record<string, unknown> = {}) {
  const [it] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name: `${name} ${seq}`, type: 'service' as never, salesPrice: price, incomeAccountId: acct['4000'], ...extra })
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

async function newVendor(name: string, extra: Record<string, unknown> = {}) {
  const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: `${name} ${seq}`, ...extra }).returning();
  return v.id;
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

async function entryOf(sourceRef: string) {
  return db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef)));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-left@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar ${seq}`, ownerId: userId });
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

// ---------------------------------------------------------------------------
describe('1. Server-dated sales postings use the company calendar day', () => {
  it('refund of a payment, a bounced check and a credit-memo refund default to today', async () => {
    const cust = await newCustomer('Evening');
    const inv = await plainInvoice(cust, '100.00', '2026-10-01');
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-10-05'),
      amount: '150.00',
      method: 'check',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    });
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-10-06'),
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '20.00', taxable: false }],
    });
    // A second check (a refunded payment can't bounce).
    const inv2 = await plainInvoice(cust, '40.00', '2026-10-01');
    const { payment: check } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-10-07'),
      amount: '40.00',
      method: 'check',
      depositAccountId: acct['1000'],
      applications: [{ invoiceId: inv2.id, amountApplied: '40.00' }],
    });
    useEvening();
    const refund = await refundPayment(ctx, { paymentId: payment.id, bankAccountId: acct['1000'], amount: '50.00' });
    expect(ymd(refund.entry.date)).toBe('2026-10-26');
    const memoRefund = await refundCreditMemo(ctx, { creditMemoId: memo.id, bankAccountId: acct['1000'], amount: '20.00' });
    expect(ymd(memoRefund.entry.date)).toBe('2026-10-26');
    const bounce = await recordBouncedCheck(ctx, { paymentId: check.id });
    expect(ymd(bounce.date)).toBe('2026-10-26');
  });

  it('a credit applied without a date whose natural day is closed is dated today', async () => {
    const cust = await newCustomer('Closed credit');
    const inv = await plainInvoice(cust, '100.00', '2026-01-10');
    const memo = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-01-12'),
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '30.00', taxable: false }],
    });
    await setClosingDate(ctx, { closingDate: '2026-06-30', password: null } as never);
    useEvening();
    await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: inv.id, amount: '30.00' });
    const [app] = await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, memo.id));
    expect(ymd(app.date)).toBe('2026-10-26');
  });

  it('FX plugs of applying / unapplying a foreign payment later are dated today', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const cust = await newCustomer('Euro later', { currency: 'EUR' });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-10-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00', taxable: false }],
    } as never);
    const [euroBank] = await db
      .insert(accounts)
      .values({ companyId: ctx.companyId, code: '1020', name: `Euro bank ${seq}`, type: 'asset' as never, subtype: 'checking', currency: 'EUR' })
      .returning();
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-10-05'),
      amount: '100.00',
      method: 'ach',
      depositAccountId: euroBank.id,
      currency: 'EUR',
      exchangeRate: '1.20',
      applications: [],
    } as never);
    useEvening();
    await applyPayment(ctx, { paymentId: payment.id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] });
    await unapplyFromInvoice(ctx, { paymentId: payment.id, invoiceId: inv.id });
    const plugs = (await entryOf(`payment:${payment.id}`)).filter((e) => /FX adjustment/.test(e.description ?? ''));
    expect(plugs.length).toBeGreaterThan(0);
    for (const p of plugs) expect(ymd(p.date)).toBe('2026-10-26');
  });
});

// ---------------------------------------------------------------------------
async function billableCost(cust: string, amount = '100.00', description = 'Parts') {
  const v = await newVendor(`Supplier ${description}`);
  const bill = await createBill(ctx, {
    vendorId: v,
    date: d('2026-03-01'),
    lines: [
      { accountId: acct['6300'], amount: '10.00', description: 'Freight' },
      { accountId: acct['6300'], amount, customerId: cust, description },
    ],
  } as never);
  const cost = (await listUnbilled(ctx, cust)).costs.find((c) => c.description === description)!;
  expect(cost).toBeDefined();
  return { bill, cost, vendorId: v };
}
const labor = () => ({ accountId: acct['4000'], description: 'Labor', quantity: 1, rate: '50.00', taxable: false });
const formLines = async (invoiceId: string) =>
  (await getInvoice(ctx, invoiceId)).lines.map((l) => ({
    itemId: l.itemId,
    accountId: l.accountId,
    description: l.description,
    quantity: l.quantity,
    rate: l.rate,
    taxable: l.taxable,
  }));
const header = (customerId: string) => ({ customerId, date: d('2026-03-05'), taxRateId: null });
const billedTo = async (billLineId: string) =>
  (await db.select({ b: billLines.billedInvoiceId }).from(billLines).where(eq(billLines.id, billLineId)))[0]?.b ?? null;

describe('2. Undo of an invoice edit that moved it to another customer', () => {
  it('bills the cost again (it is not left unbilled while the invoice charges it)', async () => {
    const cust = await newCustomer('Undo owner');
    const other = await newCustomer('Undo other');
    const { cost } = await billableCost(cust);
    const inv = await createInvoiceWithBillables(ctx, { ...header(cust), lines: [labor()] } as never, { billLineIds: [cost.id] });
    const prepared = await prepareUndo(ctx, { resource: 'invoices', kind: 'update', id: inv.id });
    await updateInvoice(ctx, inv.id, { ...header(other), lines: await formLines(inv.id) } as never);
    expect(await billedTo(cost.id)).toBeNull();
    const armed = await commitUndo(ctx, { resource: 'invoices', kind: 'update', token: prepared.token, id: null });
    await performUndo(ctx, armed.token);
    const back = await getInvoice(ctx, inv.id);
    expect(back.customerId).toBe(cust);
    expect(back.total).toBe('150.00');
    expect(await billedTo(cost.id)).toBe(inv.id);
    expect((await listUnbilled(ctx, cust)).costs).toHaveLength(0);
  });

  it('a stated link to a cost of the NEW customer is billed; one of the old customer is not', async () => {
    const cust = await newCustomer('Mover A');
    const other = await newCustomer('Mover B');
    const a = await billableCost(cust, '100.00', 'A parts');
    const b = await billableCost(other, '40.00', 'B parts');
    const inv = await createInvoiceWithBillables(ctx, { ...header(cust), lines: [labor()] } as never, { billLineIds: [a.cost.id] });
    const lines = (await getInvoice(ctx, inv.id)).lines.map((l) => ({
      itemId: l.itemId,
      accountId: l.accountId,
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      taxable: l.taxable,
      billableSource: l.description === 'Labor' ? { kind: 'bill_line', id: b.cost.id } : l.billableSource ?? null,
    }));
    await updateInvoice(ctx, inv.id, { ...header(other), lines } as never);
    expect(await billedTo(a.cost.id)).toBeNull();
    expect(await billedTo(b.cost.id)).toBe(inv.id);
  });
});

// ---------------------------------------------------------------------------
describe('3. Editing a bill whose cost is on an invoice', () => {
  it('removing the cost line from the invoice after the bill was edited still releases it', async () => {
    const cust = await newCustomer('Bill edit');
    const { bill, cost, vendorId } = await billableCost(cust);
    const inv = await createInvoiceWithBillables(ctx, { ...header(cust), lines: [labor()] } as never, { billLineIds: [cost.id] });
    // An edit that re-posts the bill (a new date) re-creates its lines.
    const saved = await getBill(ctx, bill.id);
    await updateBill(ctx, bill.id, {
      vendorId,
      date: d('2026-03-02'),
      memo: 'Re-dated',
      lines: saved.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description, customerId: l.customerId, jobId: l.jobId })),
    } as never);
    const kept = (await formLines(inv.id)).filter((l) => l.description === 'Labor');
    await updateInvoice(ctx, inv.id, { ...header(cust), lines: kept } as never);
    expect((await listUnbilled(ctx, cust)).costs.map((c) => c.description)).toEqual(['Parts']);
  });

  it('the invoice line keeps naming the bill line that is billed', async () => {
    const cust = await newCustomer('Bill edit link');
    const { bill, cost, vendorId } = await billableCost(cust);
    const inv = await createInvoiceWithBillables(ctx, { ...header(cust), lines: [labor()] } as never, { billLineIds: [cost.id] });
    const saved = await getBill(ctx, bill.id);
    await updateBill(ctx, bill.id, {
      vendorId,
      date: d('2026-03-03'),
      lines: saved.lines.map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description, customerId: l.customerId, jobId: l.jobId })),
    } as never);
    const billed = (await db.select().from(billLines).where(eq(billLines.billId, bill.id))).find((l) => l.billedInvoiceId === inv.id)!;
    const line = (await getInvoice(ctx, inv.id)).lines.find((l) => l.description !== 'Labor')!;
    expect(line.billableSource).toEqual({ kind: 'bill_line', id: billed.id });
  });
});

// ---------------------------------------------------------------------------
describe("4. The Accountant's Copy invoice payload", () => {
  it('carries the billable link, so a line re-priced and re-worded by the accountant keeps the cost billed', async () => {
    const cust = await newCustomer('AC billable');
    const { cost } = await billableCost(cust);
    const inv = await createInvoiceWithBillables(ctx, { ...header(cust), lines: [labor()] } as never, { billLineIds: [cost.id] });
    const payload = await docPayload(ctx, 'invoice', inv.id);
    expect(matchesShape(payload, DOC_SHAPES.invoice)).toBe(true);
    const lines = payload.lines as Array<Record<string, unknown>>;
    expect(lines.find((l) => l.description !== 'Labor')?.billableSource).toEqual({ kind: 'bill_line', id: cost.id });
    // The accountant re-prices and re-words the cost line; the import edits the client's invoice.
    const edited = {
      ...payload,
      date: d('2026-03-05'),
      lines: lines.map((l) => (l.description === 'Labor' ? l : { ...l, description: 'Reimbursed materials', rate: '95.00' })),
    };
    await updateDoc(ctx, 'invoice', inv.id, edited);
    expect(await billedTo(cost.id)).toBe(inv.id);
    expect((await listUnbilled(ctx, cust)).costs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('5. Sales tax payments and adjustments in the journal window', () => {
  it('cannot be reversed (the reversal would be unattributed); voiding them is still allowed', async () => {
    const [agency] = await db.insert(taxAgencies).values({ companyId: ctx.companyId, name: `State ${seq}` }).returning();
    const pay = await postJournalEntry(ctx, {
      date: d('2026-04-15'),
      description: 'Sales tax payment',
      sourceRef: `tax_agency:${agency.id}`,
      lines: [
        { accountId: acct['2200'], debit: '50.00' },
        { accountId: acct['1000'], credit: '50.00' },
      ],
    });
    await expect(reverseEntry(ctx, pay.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const adj = await postJournalEntry(ctx, {
      date: d('2026-04-16'),
      description: 'Sales tax adjustment',
      sourceRef: `sales_tax_adj:${agency.id}`,
      lines: [
        { accountId: acct['2200'], debit: '5.00' },
        { accountId: acct['4900'], credit: '5.00' },
      ],
    });
    await expect(reverseEntry(ctx, adj.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(voidEntry(ctx, pay.id)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('6. The customers-area journal-items route', () => {
  it('refuses to apply a vendor (A/P) journal credit to a journal charge', async () => {
    const v = await newVendor('JE vendor');
    const credit = await postJournalEntry(ctx, {
      date: d('2026-03-01'),
      description: 'Vendor credit by journal',
      lines: [
        { accountId: acct['2000'], debit: '30.00', entityType: 'vendor', entityId: v },
        { accountId: acct['6000'], credit: '30.00' },
      ],
    });
    const charge = await postJournalEntry(ctx, {
      date: d('2026-03-02'),
      description: 'Vendor charge by journal',
      lines: [
        { accountId: acct['6000'], debit: '30.00' },
        { accountId: acct['2000'], credit: '30.00', entityType: 'vendor', entityId: v },
      ],
    });
    const creditLine = (await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, credit.id))).find((l) => l.accountId === acct['2000'])!;
    const chargeLine = (await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, charge.id))).find((l) => l.accountId === acct['2000'])!;
    const res = await journalItemsPOST(req('/api/payments/journal-items', { action: 'apply_credit', journalLineId: creditLine.id, chargeLineId: chargeLine.id, amount: '30.00' }));
    expect([400, 404]).toContain(res.status);
    // The vendors-side service call still works.
    await expect(applyJournalCredit(ctx, { journalLineId: creditLine.id, chargeLineId: chargeLine.id, amount: '30.00' }, { side: 'ap' })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('7. Customer Center and Vendor Center balances', () => {
  it('come from the A/R and A/P ledger (open invoices less credits; open bills less credits)', async () => {
    const cust = await newCustomer('Balance shown');
    await plainInvoice(cust, '300.00');
    await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '50.00', taxable: false }],
    });
    const list = await listCustomersWithBalances(ctx);
    expect(list.find((c) => c.id === cust)?.balance).toBe('250.00');
    const v = (await createVendor(ctx, { displayName: `Owed vendor ${seq}` } as never)).id;
    await createBill(ctx, { vendorId: v, date: d('2026-03-01'), lines: [{ accountId: acct['6000'], amount: '80.00' }] } as never);
    const vlist = await listVendorsWithBalances(ctx);
    expect(vlist.find((x) => x.id === v)?.balance).toBe('80.00');
  });
});

// ---------------------------------------------------------------------------
describe('8. An invoice made from a sales order, edited afterwards', () => {
  it('cutting it from 10 to 6 leaves 4 to invoice; voiding it then gives back 6, not 10', async () => {
    const cust = await newCustomer('SO edit');
    const item = await serviceItem('Unit', '10.00');
    const so = await createSalesOrder(ctx, { customerId: cust, date: d('2026-03-01'), taxRateId: null, lines: [{ itemId: item, quantity: 10, rate: '10.00', taxable: false }] });
    const inv = await convertSalesOrder(ctx, so.id);
    const full = await getInvoice(ctx, inv.id);
    await updateInvoice(ctx, inv.id, {
      customerId: cust,
      date: full.date,
      taxRateId: null,
      lines: full.lines.map((l) => ({ itemId: l.itemId, accountId: l.accountId, description: l.description, quantity: '6', rate: l.rate, taxable: l.taxable })),
    } as never);
    const qtyInvoiced = async () => Money.of((await getSalesOrder(ctx, so.id)).lines[0].quantityInvoiced).toFixed(2);
    expect(await qtyInvoiced()).toBe('6.00');
    const rest = await convertSalesOrder(ctx, so.id);
    expect(Money.of((await getInvoice(ctx, rest.id)).lines[0].quantity).toFixed(2)).toBe('4.00');
    expect(await qtyInvoiced()).toBe('10.00');
    await voidInvoice(ctx, inv.id);
    expect(await qtyInvoiced()).toBe('4.00');
    expect((await getSalesOrder(ctx, so.id)).status).toBe('partial');
  });

  it('an edit that asks for more than the order still has open is refused', async () => {
    const cust = await newCustomer('SO over');
    const item = await serviceItem('Unit', '10.00');
    const so = await createSalesOrder(ctx, { customerId: cust, date: d('2026-03-01'), taxRateId: null, lines: [{ itemId: item, quantity: 5, rate: '10.00', taxable: false }] });
    const inv = await convertSalesOrder(ctx, so.id, { lines: [{ lineId: (await getSalesOrder(ctx, so.id)).lines[0].id, quantity: 3 }] });
    const full = await getInvoice(ctx, inv.id);
    await expect(
      updateInvoice(ctx, inv.id, {
        customerId: cust,
        date: full.date,
        taxRateId: null,
        lines: full.lines.map((l) => ({ itemId: l.itemId, accountId: l.accountId, description: l.description, quantity: '7', rate: l.rate, taxable: l.taxable })),
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
describe("9. A job on a line must belong to the line's customer", () => {
  it('bills, checks and invoices refuse another customer’s job', async () => {
    const cust = await newCustomer('Job owner');
    const other = await newCustomer('Job stranger');
    const job = (await createJob(ctx, { customerId: other, name: `Remodel ${seq}` })).id;
    const v = await newVendor('Job supplier');
    await expect(
      createBill(ctx, { vendorId: v, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '10.00', customerId: cust, jobId: job }] } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createExpense(ctx, {
        date: d('2026-03-01'),
        paymentAccountId: acct['1000'],
        method: 'check',
        vendorId: v,
        lines: [{ accountId: acct['6300'], amount: '10.00', customerId: cust, jobId: job }],
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(plainInvoice(cust, '10.00', '2026-03-01', { jobId: job })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      createInvoice(ctx, {
        customerId: cust,
        date: d('2026-03-01'),
        taxRateId: null,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '10.00', taxable: false, jobId: job }],
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // The job's own customer is fine; a bill line with a job and no customer takes the job's customer.
    await expect(plainInvoice(other, '10.00', '2026-03-01', { jobId: job })).resolves.toBeTruthy();
    const bill = await createBill(ctx, { vendorId: v, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '10.00', jobId: job }] } as never);
    expect((await getBill(ctx, bill.id)).lines[0].customerId).toBe(other);
  });
});

// ---------------------------------------------------------------------------
describe('10. Sales receipt and credit memo edits keep the stock where it was', () => {
  it('a line re-sent without its site keeps the site it was saved with', async () => {
    const widget = await inventoryItem('Sited');
    const east = (await createSite(ctx, { name: `East ${seq}` })).id;
    const v = await newVendor('Stock vendor');
    await createBill(ctx, { vendorId: v, date: d('2026-01-05'), lines: [{ itemId: widget, quantity: 10, unitCost: 4, siteId: east }] } as never);
    const cust = await newCustomer('Sited buyer');
    const sr = await createSalesReceipt(ctx, {
      customerId: cust,
      date: d('2026-01-10'),
      depositAccountId: acct['1000'],
      lines: [{ itemId: widget, quantity: 2, rate: '10.00', siteId: east }],
    } as never);
    expect((await quantityAtSite(ctx, widget, east)).toFixed(0)).toBe('8');
    const saved = await getSalesReceipt(ctx, sr.id);
    await updateSalesReceipt(ctx, sr.id, {
      customerId: cust,
      date: d('2026-01-10'),
      depositAccountId: acct['1000'],
      memo: 'edited',
      // A changed price re-posts the receipt (void and re-post of its lines and stock).
      lines: saved.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, rate: '12.00', description: l.description })),
    } as never);
    expect((await quantityAtSite(ctx, widget, east)).toFixed(0)).toBe('8');

    const cm = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-01-12'),
      taxRateId: null,
      lines: [{ itemId: widget, quantity: 1, rate: '10.00', siteId: east }],
    } as never);
    expect((await quantityAtSite(ctx, widget, east)).toFixed(0)).toBe('9');
    const memo = await getCreditMemo(ctx, cm.id);
    await updateCreditMemo(ctx, cm.id, {
      customerId: cust,
      date: d('2026-01-12'),
      taxRateId: null,
      memo: 'edited',
      lines: memo.lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, rate: '12.00', description: l.description })),
    } as never);
    expect((await quantityAtSite(ctx, widget, east)).toFixed(0)).toBe('9');
  });
});

// ---------------------------------------------------------------------------
describe('11. Credit memos carry a class and a job', () => {
  it('are saved on the memo and its lines, post the class, and a write-off takes the invoice’s', async () => {
    const cust = await newCustomer('Class memo');
    const job = (await createJob(ctx, { customerId: cust, name: `Job ${seq}` })).id;
    const cls = (await createClass(ctx, { name: `East class ${seq}` } as never)).id;
    const cm = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-02'),
      taxRateId: null,
      classId: cls,
      jobId: job,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '20.00', taxable: false }],
    } as never);
    const saved = await getCreditMemo(ctx, cm.id);
    expect(saved.classId).toBe(cls);
    expect(saved.jobId).toBe(job);
    expect(saved.lines[0].classId).toBe(cls);
    expect(saved.lines[0].jobId).toBe(job);
    const posted = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, saved.postedEntryId!));
    expect(posted.find((l) => l.accountId === acct['4000'])?.classId).toBe(cls);

    const [badDebt] = await db
      .insert(accounts)
      .values({ companyId: ctx.companyId, code: '6900B', name: `Bad debt ${seq}`, type: 'expense' as never, subtype: 'operating_expenses' })
      .returning();
    const inv = await plainInvoice(cust, '75.00', '2026-03-01', { jobId: job, classId: cls });
    const res = await writeOffInvoices(ctx, { invoiceIds: [inv.id], date: d('2026-06-30'), badDebtAccountId: badDebt.id });
    const wo = await getCreditMemo(ctx, res.results[0].creditMemoId);
    expect(wo.jobId).toBe(job);
    expect(wo.classId).toBe(cls);
    const woLines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, wo.postedEntryId!));
    expect(woLines.find((l) => l.accountId === badDebt.id)?.classId).toBe(cls);
  });

  it('refuses a job of another customer', async () => {
    const cust = await newCustomer('Memo job owner');
    const other = await newCustomer('Memo job other');
    const job = (await createJob(ctx, { customerId: other, name: `Other job ${seq}` })).id;
    await expect(
      createCreditMemo(ctx, {
        customerId: cust,
        date: d('2026-03-02'),
        taxRateId: null,
        jobId: job,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '20.00', taxable: false }],
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
describe('12. Editing an estimate keeps its line ids', () => {
  it('a pending invoice linked to its lines keeps the links', async () => {
    const cust = await newCustomer('Estimate ids');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      lines: [
        { description: 'Design', quantity: 1, rate: '500.00', taxable: false },
        { description: 'Build', quantity: 2, rate: '250.00', taxable: false },
      ],
    });
    const saved = await getEstimate(ctx, est.id);
    const draft = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      taxRateId: null,
      status: 'draft',
      lines: [{ description: 'Design', quantity: 1, rate: '500.00', taxable: false, estimateLineId: saved.lines[0].id }],
    } as never);
    await updateEstimate(ctx, est.id, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      memo: 'tweak',
      lines: saved.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, rate: l.rate, taxable: l.taxable })),
    } as never);
    const after = await getEstimate(ctx, est.id);
    expect(after.lines.map((l) => l.id)).toEqual(saved.lines.map((l) => l.id));
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, draft.id));
    expect(line.estimateLineId).toBe(saved.lines[0].id);
    const [still] = await db.select().from(estimateLines).where(eq(estimateLines.id, saved.lines[0].id));
    expect(still).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('13. Income Tracker as of a past date', () => {
  it('a taxed estimate billed after the day shows its full total unbilled on that day', async () => {
    const [rate] = await db.insert(taxRates).values({ companyId: ctx.companyId, name: `Tax ${seq}`, rate: '0.100000' }).returning();
    const cust = await newCustomer('Taxed estimate');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate.id,
      lines: [{ description: 'Job', quantity: 1, rate: '1000.00', taxable: true }],
    });
    expect((await getEstimate(ctx, est.id)).total).toBe('1100.00');
    await createProgressInvoice(ctx, est.id, { percent: 50, date: d('2026-03-20') });
    const asOf = await incomeTracker(ctx, { asOf: d('2026-03-10') });
    expect(asOf.rows.find((r) => r.id === est.id)?.openBalance).toBe('1100.00');
    const now = await incomeTracker(ctx, { asOf: d('2026-03-25') });
    expect(now.rows.find((r) => r.id === est.id)?.openBalance).toBe('550.00');
  });
});

// ---------------------------------------------------------------------------
describe('14. Estimate sales-tax item lines under progress invoicing', () => {
  it('billing the whole estimate closes it (its sales-tax line counts as billed)', async () => {
    const [agency] = await db.insert(taxAgencies).values({ companyId: ctx.companyId, name: `Agency ${seq}` }).returning();
    void agency;
    const taxItem = await serviceItem('City tax', '0.00', { type: 'sales_tax' as never, incomeAccountId: acct['2200'] });
    const cust = await newCustomer('Tax line estimate');
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: null,
      lines: [
        { description: 'Job', quantity: 1, rate: '1000.00', taxable: true },
        { itemId: taxItem, description: 'City tax', quantity: 1, rate: '50.00', taxable: false },
      ],
    });
    await createProgressInvoice(ctx, est.id, { percent: 50, date: d('2026-03-10') });
    await createProgressInvoice(ctx, est.id, { remaining: true, date: d('2026-03-20') });
    expect((await getEstimate(ctx, est.id)).status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
describe('15. Collection letters', () => {
  it('total a customer’s foreign invoices at their home value (booked rate)', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const cust = await newCustomer('Letter euro', { currency: 'EUR' });
    await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      dueDate: d('2026-03-31'),
      currency: 'EUR',
      exchangeRate: '1.20',
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00', taxable: false }],
    } as never);
    await plainInvoice(cust, '30.00', '2026-03-02');
    const [r] = await listRecipients(ctx, { type: 'customer', ids: [cust], today: '2026-05-01' });
    expect(r.balance).toBe('150.00');
    expect(r.invoiceList).toContain('EUR');
  });
});

void bouncedChecks;
void creditMemoLines;
void creditMemos;
