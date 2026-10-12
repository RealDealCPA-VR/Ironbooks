/**
 * Independent QA (tester) for the P1 reports round. Adversarial checks that the std-engine
 * aging, cash-basis and adjusting-entry reports behave like QuickBooks and tie to the ledger:
 *  - A/R aging (summary / detail / Open Invoices) == Customer Balance Summary == A/R on the
 *    Trial Balance, for several "as of" dates, through partial payments (to the penny), voids,
 *    edits, applied credits, unapplied payments and named General Journal A/R lines;
 *  - the same for A/P (aging == Vendor Balance Summary == Unpaid Bills == A/P);
 *  - aging column boundaries (exactly 0 / 1 / 30 / 31 / 90 / 91 days), odd Interval / Through,
 *    bad options rejected as VALIDATION (never a crash);
 *  - class and name filters, multi-company isolation;
 *  - Adjusting Journal Entries: empty, voided, range edges, other company;
 *  - cash basis: TB and Balance Sheet balance, P&L net income == Balance Sheet net income,
 *    prorated paid share sums to the penny, voided payments drop out, fully paid == accrual,
 *    P&L by Job cash column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, classes, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { fullAccess } from '@/lib/permissions/model';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice, updateInvoice, voidInvoice } from './invoices';
import { receivePayment, voidPayment } from './payments';
import { createBill, voidBill } from './bills';
import { payBills } from './billPayments';
import { applyToInvoice, createCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit } from './vendorCredits';
import { createSalesReceipt } from './salesReceipts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-p1-qa');
let db: DB;
let userId: string;
let n = 0;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;
const row = (r: StdReport, label: string) => r.rows.find((x) => x.cells.label === label);
const dataRows = (r: StdReport) => r.rows.filter((x) => x.kind === 'data');
const m = (v: unknown) => Money.of(v == null || v === '' ? '0' : String(v));

interface Co {
  ctx: ServiceContext;
  code: Record<string, string>;
}

async function newCompany(): Promise<Co> {
  const company = await createCompany(db, { name: `P1 QA Co ${++n}`, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  return { ctx, code };
}

/** Natural balance of an account on the Trial Balance (debit - credit). */
async function tbBalance(ctx: ServiceContext, label: string, asOf: string, basis?: 'cash' | 'accrual'): Promise<string> {
  const tb = await runStandardReport(ctx, 'trial-balance', { asOf, ...(basis ? { basis } : {}) });
  const r = tb.rows.find((x) => x.kind === 'data' && String(x.cells.label).includes(label));
  if (!r) return '0.00';
  return m(r.cells.debit).minus(m(r.cells.credit)).toFixed(2);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'p1-qa@test.local', name: 'P1 QA', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

// ---------------------------------------------------------------------------
// A/R: aging == customer balances == A/R control, through edits and voids
// ---------------------------------------------------------------------------

describe('A/R aging ties to the A/R account and customer balances', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const line = (amount: string) => ({ accountId: code['4000'], quantity: 1, rate: amount, taxable: false });
    ids.acme = (await createCustomer(ctx, { displayName: 'Acme' })).id;
    ids.beta = (await createCustomer(ctx, { displayName: 'Beta' })).id;
    ids.gamma = (await createCustomer(ctx, { displayName: 'Gamma' })).id;
    // 100.01 paid in two partial payments of 33.34 and 33.33 → 33.34 open.
    ids.invA = (await createInvoice(ctx, { customerId: ids.acme, date: d('2026-01-15'), dueDate: d('2026-02-14'), lines: [line('100.01')] })).id;
    await receivePayment(ctx, { customerId: ids.acme, date: d('2026-02-01'), amount: '33.34', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: ids.invA, amountApplied: '33.34' }] });
    await receivePayment(ctx, { customerId: ids.acme, date: d('2026-03-01'), amount: '33.33', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: ids.invA, amountApplied: '33.33' }] });
    // Credit memo 20.00, 10.00 applied to invoice A on Mar 5 → invoice 23.34 open, credit -10.00 open.
    const cm = await createCreditMemo(ctx, { customerId: ids.acme, date: d('2026-03-05'), lines: [line('20.00')] });
    await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: ids.invA, amount: '10.00', date: d('2026-03-05') });
    // Beta: a voided invoice and an edited invoice (75.50 → 80.25).
    const voided = await createInvoice(ctx, { customerId: ids.beta, date: d('2026-02-10'), dueDate: d('2026-03-12'), lines: [line('250.00')] });
    await voidInvoice(ctx, voided.id);
    const edit = await createInvoice(ctx, { customerId: ids.beta, date: d('2026-02-20'), dueDate: d('2026-03-22'), lines: [line('75.50')] });
    await updateInvoice(ctx, edit.id, { customerId: ids.beta, date: d('2026-02-20'), dueDate: d('2026-03-22'), lines: [line('80.25')] });
    // Gamma: an unapplied payment of 50.00 and a named General Journal A/R charge of 15.00.
    await receivePayment(ctx, { customerId: ids.gamma, date: d('2026-03-10'), amount: '50.00', method: 'check', depositAccountId: code['1000'], applications: [] });
    await postJournalEntry(ctx, {
      date: d('2026-03-15'),
      description: 'Rebill',
      lines: [
        { accountId: code['1200'], debit: '15.00', entityType: 'customer', entityId: ids.gamma },
        { accountId: code['4900'], credit: '15.00' },
      ],
    });
    // Gamma: an invoice that gets paid in full, then the payment is voided → open again.
    const full = await createInvoice(ctx, { customerId: ids.gamma, date: d('2026-03-20'), dueDate: d('2026-04-19'), lines: [line('40.00')] });
    const pay = await receivePayment(ctx, { customerId: ids.gamma, date: d('2026-03-25'), amount: '40.00', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: full.id, amountApplied: '40.00' }] });
    await voidPayment(ctx, pay.payment.id);
  }, 180_000);

  const run = (key: string, asOf: string, p: Record<string, string> = {}) => runStandardReport(co.ctx, key, { asOf, ...p });

  for (const asOf of ['2026-01-31', '2026-02-15', '2026-03-04', '2026-03-31', '2026-06-30']) {
    it(`as of ${asOf}: summary == detail == open invoices == customer balances == A/R`, async () => {
      const [sum, det, open, bal] = await Promise.all([
        run('ar-aging-summary', asOf),
        run('ar-aging-detail', asOf),
        run('open-invoices', asOf),
        run('customer-balance-summary', asOf),
      ]);
      const ar = await tbBalance(co.ctx, 'Accounts Receivable', asOf);
      expect.soft(grand(sum).cells.total, 'summary vs A/R').toBe(ar);
      expect.soft(grand(det).cells.open, 'detail vs A/R').toBe(ar);
      expect.soft(grand(open).cells.open, 'open invoices vs A/R').toBe(ar);
      expect.soft(m(grand(bal).cells.balance).toFixed(2), 'customer balances vs A/R').toBe(ar);
      // Column totals add up to the TOTAL column, row by row and on the grand row.
      const moneyCols = sum.columns.filter((c) => c.type === 'money' && c.key !== 'total').map((c) => c.key);
      for (const r of sum.rows.filter((x) => x.kind === 'data' || x.kind === 'grand')) {
        const s = moneyCols.reduce((a, k) => a.plus(m(r.cells[k])), Money.zero());
        expect(s.toFixed(2), `${r.cells.label} columns`).toBe(m(r.cells.total).toFixed(2));
      }
      // Each customer's aging total == their balance.
      for (const r of dataRows(sum)) {
        const b = row(bal, String(r.cells.label));
        expect(m(b?.cells.balance).toFixed(2), String(r.cells.label)).toBe(m(r.cells.total).toFixed(2));
      }
    });
  }

  it('penny-exact open balances after partial payments, applied credit, edit, void and voided payment', async () => {
    const sum = await run('ar-aging-summary', '2026-06-30');
    // Acme: invoice 100.01 - 33.34 - 33.33 - 10.00 = 23.34 open; unapplied credit -10.00 → 13.34.
    expect(row(sum, 'Acme')!.cells.total).toBe('13.34');
    // Beta: only the edited amount; the voided invoice is gone.
    expect(row(sum, 'Beta')!.cells.total).toBe('80.25');
    // Gamma: -50 unapplied + 15 JE + 40 (payment voided) = 5.00.
    expect(row(sum, 'Gamma')!.cells.total).toBe('5.00');
    expect(grand(sum).cells.total).toBe('98.59');
    const det = await run('ar-aging-detail', '2026-06-30');
    const types = dataRows(det).map((x) => `${x.cells.name}|${x.cells.type}|${x.cells.open}`).sort();
    expect(types).toContain('Acme|Invoice|23.34');
    expect(types).toContain('Beta|Invoice|80.25');
    expect(types.some((t) => t.startsWith('Beta|Invoice|250'))).toBe(false);
    // Every open item opens its transaction.
    for (const r of dataRows(det)) expect(r.entryId, `${r.cells.name} ${r.cells.type}`).toBeTruthy();
  });

  it('as of a date before a payment, the invoice is aged at its balance on that date', async () => {
    const det = await run('ar-aging-detail', '2026-02-15');
    const inv = dataRows(det).find((x) => x.cells.name === 'Acme' && x.cells.type === 'Invoice')!;
    expect(inv.cells.open).toBe('66.67');
    expect(inv.cells.aging).toBe(1);
    // The Mar 5 credit memo does not exist yet.
    expect(dataRows(det).some((x) => x.cells.type === 'Credit Memo')).toBe(false);
  });

  it('Collections Report is the overdue subset of Open Invoices (never credits, never current items)', async () => {
    const c = await run('collections-report', '2026-06-30');
    for (const r of dataRows(c)) {
      expect(m(r.cells.open).isPositive(), String(r.cells.type)).toBe(true);
      expect(Number(r.cells.aging)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// A/P: aging == vendor balances == unpaid bills == A/P control
// ---------------------------------------------------------------------------

describe('A/P aging ties to the A/P account and vendor balances', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    ids.sup = (await createVendor(ctx, { displayName: 'Supplier' })).id;
    ids.oth = (await createVendor(ctx, { displayName: 'Other Vendor' })).id;
    const b1 = await createBill(ctx, { vendorId: ids.sup, date: d('2026-01-10'), dueDate: d('2026-02-09'), lines: [{ accountId: code['6000'], amount: '500.00' }] });
    await payBills(ctx, { vendorId: ids.sup, date: d('2026-02-01'), method: 'check', paymentAccountId: code['1000'], applications: [{ billId: b1.id, amountApplied: '199.99' }] });
    const vc = await createVendorCredit(ctx, { vendorId: ids.sup, date: d('2026-02-15'), lines: [{ accountId: code['6000'], amount: '50.00' }] });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '25.00' });
    const gone = await createBill(ctx, { vendorId: ids.oth, date: d('2026-01-20'), dueDate: d('2026-02-19'), lines: [{ accountId: code['6300'], amount: '1000.00' }] });
    await voidBill(ctx, gone.id);
    await createBill(ctx, { vendorId: ids.oth, date: d('2026-03-01'), dueDate: d('2026-03-31'), lines: [{ accountId: code['6300'], amount: '12.34' }] });
  }, 180_000);

  for (const asOf of ['2026-01-31', '2026-02-20', '2026-06-30']) {
    it(`as of ${asOf}: A/P aging == vendor balances == unpaid bills == A/P`, async () => {
      const ctx = co.ctx;
      const [sum, det, bal, unpaid] = await Promise.all([
        runStandardReport(ctx, 'ap-aging-summary', { asOf }),
        runStandardReport(ctx, 'ap-aging-detail', { asOf }),
        runStandardReport(ctx, 'vendor-balance-summary', { asOf }),
        runStandardReport(ctx, 'unpaid-bills-detail', { asOf }),
      ]);
      const ap = Money.of(await tbBalance(ctx, 'Accounts Payable', asOf)).negated().toFixed(2);
      expect(grand(sum).cells.total).toBe(ap);
      expect(grand(det).cells.open).toBe(ap);
      expect(m(grand(bal).cells.balance).toFixed(2)).toBe(ap);
      const unpaidTotal = Object.values(grand(unpaid).cells).find((v) => typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v));
      expect(unpaidTotal, 'unpaid bills grand total').toBe(ap);
    });
  }

  it('penny-exact: 500.00 - 199.99 - 25.00 credit = 275.01, unapplied credit -25.00, voided bill gone', async () => {
    const sum = await runStandardReport(co.ctx, 'ap-aging-summary', { asOf: '2026-06-30' });
    expect(row(sum, 'Supplier')!.cells.total).toBe('250.01');
    expect(row(sum, 'Other Vendor')!.cells.total).toBe('12.34');
    const det = await runStandardReport(co.ctx, 'ap-aging-detail', { asOf: '2026-06-30', vendorId: ids.sup });
    const opens = dataRows(det).map((x) => x.cells.open).sort();
    expect(opens).toEqual(['-25.00', '275.01']);
  });
});

// ---------------------------------------------------------------------------
// Aging columns: exact boundaries and options
// ---------------------------------------------------------------------------

describe('aging column boundaries and options', () => {
  let co: Co;
  const ids: Record<string, string> = {};
  const AS_OF = '2026-06-30';
  // days past due on Jun 30 → due date
  const DUE: Record<string, string> = { d0: '2026-06-30', dm1: '2026-07-01', d1: '2026-06-29', d30: '2026-05-31', d31: '2026-05-30', d60: '2026-05-01', d61: '2026-04-30', d90: '2026-04-01', d91: '2026-03-31' };

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    for (const k of Object.keys(DUE)) {
      ids[k] = (await createCustomer(ctx, { displayName: `C ${k}` })).id;
      await createInvoice(ctx, { customerId: ids[k], date: d('2026-01-01'), dueDate: d(DUE[k]), lines: [{ accountId: code['4000'], quantity: 1, rate: '10.00', taxable: false }] });
    }
  }, 180_000);

  it('Current = not yet past due (incl. due today); 1, 30 → 1 - 30; 31 → 31 - 60; 90 → 61 - 90; 91 → > 90', async () => {
    const r = await runStandardReport(co.ctx, 'ar-aging-summary', { asOf: AS_OF });
    const col = (k: string) => {
      const x = row(r, `C ${k}`)!;
      return Object.entries(x.cells).find(([key, v]) => key !== 'total' && key !== 'label' && v === '10.00')?.[0];
    };
    expect(col('dm1')).toBe('current');
    expect(col('d0')).toBe('current');
    expect(col('d1')).toBe('b0');
    expect(col('d30')).toBe('b0');
    expect(col('d31')).toBe('b1');
    expect(col('d60')).toBe('b1');
    expect(col('d61')).toBe('b2');
    expect(col('d90')).toBe('b2');
    expect(col('d91')).toBe('over');
    const det = await runStandardReport(co.ctx, 'ar-aging-detail', { asOf: AS_OF });
    const aging = (k: string) => dataRows(det).find((x) => x.cells.name === `C ${k}`)!.cells.aging;
    expect(aging('d91')).toBe(91);
    expect(aging('d0') ?? null).toBeNull();
  });

  it('odd Interval / Through: 7 through 10 gives Current, 1 - 7, 8 - 10, > 10 and keeps the total', async () => {
    const r = await runStandardReport(co.ctx, 'ar-aging-summary', { asOf: AS_OF, interval: '7', through: '10' });
    expect(r.columns.map((c) => c.header)).toEqual(['Customer', 'Current', '1 - 7', '8 - 10', '> 10', 'TOTAL']);
    expect(grand(r).cells.total).toBe('90.00');
    expect(grand(r).cells.over).toBe('60.00');
  });

  it('QuickZoom from the summary carries Interval / Through / Age from to the detail', async () => {
    const r = await runStandardReport(co.ctx, 'ar-aging-summary', { asOf: AS_OF, interval: '15', through: '45', agingFrom: 'transaction_date' });
    const href = row(r, 'C d91')!.hrefs!.total;
    const q = new URLSearchParams(href.split('?')[1]);
    expect(q.get('interval')).toBe('15');
    expect(q.get('through')).toBe('45');
    expect(q.get('agingFrom')).toBe('transaction_date');
    expect(q.get('asOf')).toBe(AS_OF);
    expect(q.get('customerId')).toBe(ids.d91);
  });

  for (const bad of [{ interval: '0' }, { interval: '-5' }, { interval: 'abc' }, { through: '0' }, { interval: '1' }, { through: '9999' }, { agingFrom: 'whenever' }, { interval: '2.5' }]) {
    it(`rejects ${JSON.stringify(bad)} as a plain-language VALIDATION error`, async () => {
      await expect(runStandardReport(co.ctx, 'ar-aging-summary', { asOf: AS_OF, ...bad })).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  }
});

// ---------------------------------------------------------------------------
// Filters and multi-company isolation
// ---------------------------------------------------------------------------

describe('aging filters and company isolation', () => {
  let a: Co;
  let b: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    a = await newCompany();
    b = await newCompany();
    const [east] = await db.insert(classes).values({ companyId: a.ctx.companyId, name: 'East' }).returning();
    const [west] = await db.insert(classes).values({ companyId: a.ctx.companyId, name: 'West' }).returning();
    ids.east = east.id;
    ids.west = west.id;
    ids.acme = (await createCustomer(a.ctx, { displayName: 'Acme' })).id;
    const line = (code: Record<string, string>, amount: string) => ({ accountId: code['4000'], quantity: 1, rate: amount, taxable: false });
    await createInvoice(a.ctx, { customerId: ids.acme, date: d('2026-05-01'), dueDate: d('2026-05-31'), classId: east.id, lines: [line(a.code, '100.00')] });
    await createInvoice(a.ctx, { customerId: ids.acme, date: d('2026-05-02'), dueDate: d('2026-06-01'), classId: west.id, lines: [line(a.code, '7.77')] });
    ids.bcust = (await createCustomer(b.ctx, { displayName: 'Acme' })).id;
    await createInvoice(b.ctx, { customerId: ids.bcust, date: d('2026-05-01'), dueDate: d('2026-05-31'), lines: [line(b.code, '999.00')] });
    ids.bvend = (await createVendor(b.ctx, { displayName: 'B Vendor' })).id;
    await createBill(b.ctx, { vendorId: ids.bvend, date: d('2026-05-01'), dueDate: d('2026-05-31'), lines: [{ accountId: b.code['6000'], amount: '55.00' }] });
  }, 180_000);

  it('class filter keeps only that class (summary and detail agree)', async () => {
    const s = await runStandardReport(a.ctx, 'ar-aging-summary', { asOf: '2026-06-30', classId: ids.west });
    expect(grand(s).cells.total).toBe('7.77');
    const det = await runStandardReport(a.ctx, 'ar-aging-detail', { asOf: '2026-06-30', classId: ids.east });
    expect(grand(det).cells.open).toBe('100.00');
    const all = await runStandardReport(a.ctx, 'ar-aging-summary', { asOf: '2026-06-30' });
    expect(grand(all).cells.total).toBe('107.77');
  });

  it('another company’s data never shows; another company’s customer / vendor id returns nothing', async () => {
    const ar = await runStandardReport(a.ctx, 'ar-aging-summary', { asOf: '2026-06-30' });
    expect(grand(ar).cells.total).toBe('107.77');
    const foreign = await runStandardReport(a.ctx, 'ar-aging-summary', { asOf: '2026-06-30', customerId: ids.bcust });
    expect(grand(foreign).cells.total).toBe('0.00');
    const foreignV = await runStandardReport(a.ctx, 'ap-aging-detail', { asOf: '2026-06-30', vendorId: ids.bvend });
    expect(grand(foreignV).cells.open).toBe('0.00');
    const ap = await runStandardReport(a.ctx, 'ap-aging-summary', { asOf: '2026-06-30' });
    expect(grand(ap).cells.total).toBe('0.00');
    const bs = await runStandardReport(b.ctx, 'ar-aging-summary', { asOf: '2026-06-30' });
    expect(grand(bs).cells.total).toBe('999.00');
    // A class of company A used in company B filters everything out (never leaks A's rows).
    const cross = await runStandardReport(b.ctx, 'ar-aging-detail', { asOf: '2026-06-30', classId: ids.east });
    expect(grand(cross).cells.open).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Adjusting Journal Entries edge cases
// ---------------------------------------------------------------------------

describe('Adjusting Journal Entries edge cases', () => {
  it('no adjusting entries → empty report (never every entry)', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    await postJournalEntry(ctx, { date: d('2026-03-01'), description: 'Regular', lines: [{ accountId: code['6000'], debit: '10' }, { accountId: code['1000'], credit: '10' }] });
    const r = await runStandardReport(ctx, 'adjusting-journal-entries', { from: '2026-01-01', to: '2026-12-31' });
    expect(r.rows.filter((x) => x.kind === 'section')).toHaveLength(0);
    expect(m(grand(r).cells.debit).toFixed(2)).toBe('0.00');
  });

  it('voided adjusting entries drop out; range edges are inclusive of the To date; other companies never show', async () => {
    const co = await newCompany();
    const other = await newCompany();
    const { ctx, code } = co;
    const je = (c: Co, date: string, desc: string, amt: string) =>
      postJournalEntry(c.ctx, { date: d(date), description: desc, isAdjusting: true, lines: [{ accountId: c.code['6400'], debit: amt }, { accountId: c.code['1000'], credit: amt }] });
    const v = await je(co, '2026-03-15', 'Voided adj', '40');
    await voidJournalEntry(ctx, v.id);
    await je(co, '2026-03-31', 'Month end', '12.34');
    await je(co, '2026-04-01', 'Next month', '5');
    await je(other, '2026-03-20', 'Other co', '999');
    const r = await runStandardReport(ctx, 'adjusting-journal-entries', { from: '2026-03-01', to: '2026-03-31' });
    const memos = r.rows.filter((x) => x.kind === 'section').map((x) => x.cells.memo);
    expect(memos).toEqual(['Month end']);
    expect(grand(r).cells).toMatchObject({ debit: '12.34', credit: '12.34' });
    // Account filter keeps whole adjusting entries only.
    const byAcct = await runStandardReport(ctx, 'adjusting-journal-entries', { from: '2026-01-01', to: '2026-12-31', accountId: code['6400'] });
    expect(byAcct.rows.filter((x) => x.kind === 'section').map((x) => x.cells.memo).sort()).toEqual(['Month end', 'Next month']);
  });
});

// ---------------------------------------------------------------------------
// Cash basis invariants
// ---------------------------------------------------------------------------

describe('cash basis invariants', () => {
  let co: Co;
  const ids: Record<string, string> = {};
  const FY = { from: '2026-01-01', to: '2026-12-31' };

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    ids.acme = (await createCustomer(ctx, { displayName: 'Acme' })).id;
    ids.beta = (await createCustomer(ctx, { displayName: 'Beta' })).id;
    ids.sup = (await createVendor(ctx, { displayName: 'Supplier' })).id;
    // Three-line invoice 33.33 / 33.33 / 33.34 across two income accounts, 50.00 paid → prorating
    // must still total exactly 50.00.
    const inv = await createInvoice(ctx, {
      customerId: ids.acme,
      date: d('2026-02-01'),
      dueDate: d('2026-03-03'),
      lines: [
        { accountId: code['4000'], quantity: 1, rate: '33.33', taxable: false },
        { accountId: code['4100'], quantity: 1, rate: '33.33', taxable: false },
        { accountId: code['4000'], quantity: 1, rate: '33.34', taxable: false },
      ],
    });
    await receivePayment(ctx, { customerId: ids.acme, date: d('2026-03-10'), amount: '50.00', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '50.00' }] });
    // Beta: 70.00 invoice paid 70.00, then the payment is voided → no cash income.
    const inv2 = await createInvoice(ctx, { customerId: ids.beta, date: d('2026-02-05'), dueDate: d('2026-03-07'), lines: [{ accountId: code['4000'], quantity: 1, rate: '70.00', taxable: false }] });
    const p2 = await receivePayment(ctx, { customerId: ids.beta, date: d('2026-03-11'), amount: '70.00', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: inv2.id, amountApplied: '70.00' }] });
    await voidPayment(ctx, p2.payment.id);
    await createSalesReceipt(ctx, { customerId: ids.beta, date: d('2026-03-12'), depositAccountId: code['1000'], lines: [{ accountId: code['4000'], quantity: 1, rate: '9.99', taxable: false }] });
    // Bill 300.00 across two expense accounts, 120.55 paid.
    const bill = await createBill(ctx, { vendorId: ids.sup, date: d('2026-02-02'), dueDate: d('2026-03-04'), lines: [{ accountId: code['6000'], amount: '100.00' }, { accountId: code['6300'], amount: '200.00' }] });
    await payBills(ctx, { vendorId: ids.sup, date: d('2026-03-12'), method: 'check', paymentAccountId: code['1000'], applications: [{ billId: bill.id, amountApplied: '120.55' }] });
    // Owner investment (non-P&L cash) and a plain JE expense.
    await postJournalEntry(ctx, { date: d('2026-01-02'), description: 'Owner in', lines: [{ accountId: code['1000'], debit: '1000' }, { accountId: code['3000'], credit: '1000' }] });
    await postJournalEntry(ctx, { date: d('2026-03-20'), description: 'Fees', lines: [{ accountId: code['6100'], debit: '3.21' }, { accountId: code['1000'], credit: '3.21' }] });
  }, 180_000);

  const run = (key: string, p: Record<string, string> = {}) => runStandardReport(co.ctx, key, { ...FY, ...p });
  const net = (r: StdReport) => r.rows.find((x) => x.id === 'pl:net')!.cells.total;

  it('cash P&L: income 50.00 + 9.99, expenses prorated 120.55 + 3.21, all to the penny', async () => {
    const pl = await run('profit-loss', { basis: 'cash' });
    // 59.99 - 123.76
    expect(net(pl)).toBe('-63.77');
    const acc = await run('profit-loss', { basis: 'accrual' });
    // 100 + 70 + 9.99 - 300 - 3.21
    expect(net(acc)).toBe('-123.22');
  });

  it('cash P&L Detail and General Ledger agree with the cash P&L per account', async () => {
    const pl = await run('profit-loss', { basis: 'cash' });
    const det = await run('profit-loss-detail', { basis: 'cash' });
    for (const c of ['4000', '4100', '6000', '6300']) {
      const plRow = pl.rows.find((x) => x.kind === 'data' && x.id.includes(co.code[c]));
      const gl = await run('general-ledger', { basis: 'cash', accountId: co.code[c] });
      const glSub = gl.rows.find((x) => x.kind === 'subtotal');
      expect(m(glSub?.cells.amount).abs().toFixed(2), `GL ${c}`).toBe(m(plRow?.cells.total).abs().toFixed(2));
      const detSub = det.rows.find((x) => x.kind === 'subtotal' && String(x.totalOf ?? '').includes(co.code[c]));
      if (detSub) expect(m(detSub.cells.amount).abs().toFixed(2), `P&L Detail ${c}`).toBe(m(plRow?.cells.total).abs().toFixed(2));
    }
    const inc = ['4000', '4100'].map((c) => pl.rows.find((x) => x.kind === 'data' && x.id.includes(co.code[c]))!.cells.total);
    expect(m(inc[0]).plus(m(inc[1])).toFixed(2)).toBe('59.99');
  });

  it('Trial Balance balances on a cash basis and has no A/R or A/P', async () => {
    for (const asOf of ['2026-02-28', '2026-03-11', '2026-12-31']) {
      const tb = await run('trial-balance', { asOf, basis: 'cash' });
      expect(tb.balanced, asOf).toBe(true);
      expect(m(grand(tb).cells.debit).toFixed(2), asOf).toBe(m(grand(tb).cells.credit).toFixed(2));
      expect(await tbBalance(co.ctx, 'Accounts Receivable', asOf, 'cash'), asOf).toBe('0.00');
      expect(await tbBalance(co.ctx, 'Accounts Payable', asOf, 'cash'), asOf).toBe('0.00');
    }
  });

  it('cash Balance Sheet balances, its Net Income equals the cash P&L, and Checking matches the bank', async () => {
    for (const key of ['balance-sheet', 'balance-sheet-summary', 'balance-sheet-prev-year']) {
      const bs = await run(key, { asOf: '2026-12-31', basis: 'cash' });
      expect(bs.balanced, key).toBe(true);
    }
    const bs = await run('balance-sheet', { asOf: '2026-12-31', basis: 'cash' });
    const ni = bs.rows.find((x) => String(x.cells.label) === 'Net Income');
    expect(ni?.cells.total).toBe('-63.77');
    // Checking: 1000 + 50 + 9.99 - 120.55 - 3.21 (voided payment nets out)
    expect(await tbBalance(co.ctx, 'Checking', '2026-12-31', 'cash')).toBe('936.23');
  });

  it('cash P&L by Job puts Acme’s paid share in Acme’s column and still ties to the P&L', async () => {
    const r = await run('profit-loss-by-job', { basis: 'cash' });
    const idx = r.columns.findIndex((c) => c.header === 'Acme');
    expect(idx).toBeGreaterThan(0);
    const key = r.columns[idx].key;
    const incomeTotal = r.rows.find((x) => /total income/i.test(String(x.cells.label)));
    expect(incomeTotal?.cells[key]).toBe('50.00');
    expect(net(r)).toBe('-63.77');
  });

  it('Expenses by Vendor Detail on a cash basis totals what was paid', async () => {
    const r = await run('expenses-by-vendor-detail', { basis: 'cash' });
    const sup = r.rows.find((x) => x.kind === 'subtotal' && String(x.cells.label).includes('Supplier'));
    expect(m(sup?.cells.amount).toFixed(2)).toBe('120.55');
    expect(r.subtitle).toContain('Cash Basis');
  });

  it('once everything is paid, cash and accrual P&L agree', async () => {
    const c2 = await newCompany();
    const { ctx, code } = c2;
    const cust = (await createCustomer(ctx, { displayName: 'Payer' })).id;
    const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-02-01'), dueDate: d('2026-03-03'), lines: [{ accountId: code['4000'], quantity: 3, rate: '33.33', taxable: false }] });
    await receivePayment(ctx, { customerId: cust, date: d('2026-02-10'), amount: '33.33', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '33.33' }] });
    await receivePayment(ctx, { customerId: cust, date: d('2026-02-11'), amount: '66.66', method: 'check', depositAccountId: code['1000'], applications: [{ invoiceId: inv.id, amountApplied: '66.66' }] });
    const acc = await runStandardReport(ctx, 'profit-loss', { ...FY, basis: 'accrual' });
    const cash = await runStandardReport(ctx, 'profit-loss', { ...FY, basis: 'cash' });
    expect(net(cash)).toBe(net(acc));
    expect(net(cash)).toBe('99.99');
  });
});

// ---------------------------------------------------------------------------
// Permissions on the migrated reports
// ---------------------------------------------------------------------------

describe('area permissions on the migrated std reports', () => {
  it('each aging / financial / sales tax report needs its own area', async () => {
    const co = await newCompany();
    const without = (area: string) => {
      const a = fullAccess();
      (a.permissions as Record<string, string[]>)[area] = [];
      return { ...co.ctx, access: a } as ServiceContext;
    };
    const cases: [string, string, Record<string, string>][] = [
      ['ar-aging-summary', 'reports_sales', { asOf: '2026-06-30' }],
      ['ar-aging-detail', 'reports_sales', { asOf: '2026-06-30' }],
      ['open-invoices', 'reports_sales', { asOf: '2026-06-30' }],
      ['collections-report', 'reports_sales', { asOf: '2026-06-30' }],
      ['ap-aging-summary', 'reports_purchases', { asOf: '2026-06-30' }],
      ['ap-aging-detail', 'reports_purchases', { asOf: '2026-06-30' }],
      ['general-ledger', 'reports_financial', { from: '2026-01-01', to: '2026-01-31' }],
      ['statement-of-cash-flows', 'reports_financial', { from: '2026-01-01', to: '2026-01-31' }],
      ['adjusting-journal-entries', 'reports_financial', { from: '2026-01-01', to: '2026-01-31' }],
      ['income-tax-summary', 'reports_financial', { from: '2026-01-01', to: '2026-01-31' }],
      ['profit-loss-by-job', 'reports_financial', { from: '2026-01-01', to: '2026-01-31' }],
      ['sales-tax-liability', 'sales_tax', { from: '2026-01-01', to: '2026-01-31' }],
    ];
    for (const [key, area, p] of cases) {
      await expect(runStandardReport(without(area), key, p), `${key} without ${area}`).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Another area being off does not block it.
      const other = area === 'reports_sales' ? 'reports_purchases' : 'reports_sales';
      await expect(runStandardReport(without(other), key, p), `${key} without ${other}`).resolves.toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Sales Tax Liability on the std engine follows the Sales Tax basis preference
// ---------------------------------------------------------------------------

describe('Sales Tax Liability basis', () => {
  it('no basis → the Sales Tax preference; an explicit basis wins', async () => {
    const co = await newCompany();
    await updateCompany(co.ctx, { settings: { salesTaxBasis: 'cash' } });
    const r = await runStandardReport(co.ctx, 'sales-tax-liability', { from: '2026-01-01', to: '2026-01-31' });
    expect(r.subtitle).toContain('Cash Basis');
    const acc = await runStandardReport(co.ctx, 'sales-tax-liability', { from: '2026-01-01', to: '2026-01-31', basis: 'accrual' });
    expect(acc.subtitle).not.toContain('Cash Basis');
  });
});
