/**
 * Independent QA (tester), re-test of P1 reports fix round 1. Adversarial checks that as-of aging
 * adds back credits applied AFTER the report date, without double counting:
 *  - A/R: a credit memo applied in several partial applications on different dates; a memo dated
 *    AFTER the report date applied with an earlier application date (effective on the memo date);
 *    an application that was later unapplied; a credit applied with a received payment, and one
 *    applied with a payment that was then voided. On every date: aging summary == detail == Open
 *    Invoices == Customer Balance Summary == A/R on the Trial Balance == legacy arAging /
 *    arAgingDetail, and the per-document open balances are penny-exact.
 *  - A/P: vendor credits applied before / after the bill date, partially unapplied, fully
 *    unapplied and re-applied, a credit dated after the report date, two open credits for one
 *    vendor listed per credit. Same tie-outs against A/P, Vendor Balance Summary, Unpaid Bills
 *    and legacy apAging / apAgingDetail.
 *  - Company isolation: another company's credit applications never move this company's aging.
 *  - Scheduled exports: names that sanitize to the same text (Café / Cafè, case variants, all
 *    punctuation) get distinct folders inside the export root; archived companies are skipped
 *    while un-archived ones come back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, creditApplications, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { receivePayment, voidPayment } from './payments';
import { createBill } from './bills';
import { applyToInvoice, createCreditMemo, unapplyCreditApplication } from './creditMemos';
import { applyToBill, createVendorCredit, refundVendorCredit, unapplyFromBill } from './vendorCredits';
import { runStandardReport } from './reportRegistry';
import { apAging, apAgingDetail, arAging, arAgingDetail } from './reportsExtra';
import { companyExportDir, internalContexts } from '@/app/api/report-schedules/_internal';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-p1-qa-fix1');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-p1qa-fix1-'));
const saved = { data: process.env.BKA_DATA_DIR, out: process.env.BKA_REPORT_EXPORT_DIR, tok: process.env.BKA_INTERNAL_TOKEN };

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;
const dataRows = (r: StdReport) => r.rows.filter((x) => x.kind === 'data');
const m = (v: unknown) => Money.of(v == null || v === '' ? '0' : String(v));
const sorted = (xs: unknown[]) => xs.map((x) => m(x).toFixed(2)).sort((a, b) => Number(a) - Number(b));

let db: DB;
let userId: string;
let n = 0;

interface Co {
  ctx: ServiceContext;
  code: Record<string, string>;
}

async function newCompany(name = `Fix1 QA Co ${++n}`): Promise<Co> {
  const company = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: company.id, userId };
  const code: Record<string, string> = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[r.code] = r.id;
  return { ctx, code };
}

async function tbBalance(ctx: ServiceContext, label: string, asOf: string): Promise<string> {
  const tb = await runStandardReport(ctx, 'trial-balance', { asOf });
  const r = tb.rows.find((x) => x.kind === 'data' && String(x.cells.label).includes(label));
  return r ? m(r.cells.debit).minus(m(r.cells.credit)).toFixed(2) : '0.00';
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  process.env.BKA_REPORT_EXPORT_DIR = OUT_DIR;
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'p1-qa-fix1@test.local', name: 'QA', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('BKA_DATA_DIR', saved.data);
  restore('BKA_REPORT_EXPORT_DIR', saved.out);
  restore('BKA_INTERNAL_TOKEN', saved.tok);
  for (const dir of [TEST_DIR, OUT_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold PGlite files briefly */
    }
  }
});

// ---------------------------------------------------------------------------
// A/R
// ---------------------------------------------------------------------------

describe('A/R aging with credit memos applied on later dates', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const line = (amount: string) => ({ accountId: code['4000'], quantity: 1, rate: amount, taxable: false });
    ids.cust = (await createCustomer(ctx, { displayName: 'Credit Juggler' })).id;
    ids.inv1 = (await createInvoice(ctx, { customerId: ids.cust, date: d('2026-01-05'), dueDate: d('2026-02-04'), lines: [line('300.00')] })).id;
    ids.inv2 = (await createInvoice(ctx, { customerId: ids.cust, date: d('2026-01-08'), dueDate: d('2026-02-07'), lines: [line('60.00')] })).id;
    // Memo A 100.00 (1/10): 30.00 applied 1/20, 50.00 applied 2/10, the last 20.00 used with a payment 2/20.
    ids.cmA = (await createCreditMemo(ctx, { customerId: ids.cust, date: d('2026-01-10'), lines: [line('100.00')] })).id;
    await applyToInvoice(ctx, { creditMemoId: ids.cmA, invoiceId: ids.inv1, amount: '30.00', date: d('2026-01-20') });
    await applyToInvoice(ctx, { creditMemoId: ids.cmA, invoiceId: ids.inv1, amount: '50.00', date: d('2026-02-10') });
    // Memo B 40.00 dated 2/15, "applied" with an earlier date (1/25): cannot take effect before 2/15.
    ids.cmB = (await createCreditMemo(ctx, { customerId: ids.cust, date: d('2026-02-15'), lines: [line('40.00')] })).id;
    await applyToInvoice(ctx, { creditMemoId: ids.cmB, invoiceId: ids.inv1, amount: '40.00', date: d('2026-01-25') });
    // Memo C 25.00 (1/12): applied to invoice 2 on 2/05 then unapplied → never applied.
    ids.cmC = (await createCreditMemo(ctx, { customerId: ids.cust, date: d('2026-01-12'), lines: [line('25.00')] })).id;
    await applyToInvoice(ctx, { creditMemoId: ids.cmC, invoiceId: ids.inv2, amount: '25.00', date: d('2026-02-05') });
    const [app] = await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, ids.cmC));
    await unapplyCreditApplication(ctx, app.id);
    // Payment 2/20: 10.00 cash + the last 20.00 of memo A on invoice 1.
    await receivePayment(ctx, {
      customerId: ids.cust,
      date: d('2026-02-20'),
      amount: '10.00',
      method: 'check',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: ids.inv1, amountApplied: '10.00' }],
      credits: [{ creditMemoId: ids.cmA, invoiceId: ids.inv1, amount: '20.00' }],
    });
    // Payment 3/01 with 15.00 of memo C on invoice 2, then voided → the credit comes back.
    const p = await receivePayment(ctx, {
      customerId: ids.cust,
      date: d('2026-03-01'),
      amount: '5.00',
      method: 'check',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: ids.inv2, amountApplied: '5.00' }],
      credits: [{ creditMemoId: ids.cmC, invoiceId: ids.inv2, amount: '15.00' }],
    });
    await voidPayment(ctx, p.payment.id);
  }, 180_000);

  // Expected open documents per date (invoice +, memo -).
  const expected: Record<string, string[]> = {
    '2026-01-15': ['-100.00', '-25.00', '60.00', '300.00'],
    '2026-01-31': ['-70.00', '-25.00', '60.00', '270.00'],
    '2026-02-10': ['-25.00', '-20.00', '60.00', '220.00'], // application dated on the report date counts
    '2026-02-14': ['-25.00', '-20.00', '60.00', '220.00'],
    '2026-02-15': ['-25.00', '-20.00', '60.00', '180.00'], // memo B effective on its own date, consumed in full
    '2026-02-28': ['-25.00', '60.00', '150.00'],
    '2026-03-31': ['-25.00', '60.00', '150.00'], // voided payment's credit use is gone
  };

  for (const [asOf, docs] of Object.entries(expected)) {
    it(`as of ${asOf}: penny-exact documents; every A/R view ties to A/R on the Trial Balance`, async () => {
      const { ctx } = co;
      const [sum, det, open, bal] = await Promise.all([
        runStandardReport(ctx, 'ar-aging-summary', { asOf }),
        runStandardReport(ctx, 'ar-aging-detail', { asOf }),
        runStandardReport(ctx, 'open-invoices', { asOf }),
        runStandardReport(ctx, 'customer-balance-summary', { asOf }),
      ]);
      const ar = await tbBalance(ctx, 'Accounts Receivable', asOf);
      const total = docs.reduce((a, x) => a.plus(m(x)), Money.zero()).toFixed(2);
      expect(sorted(dataRows(det).map((x) => x.cells.open)), 'detail documents').toEqual(docs);
      expect.soft(ar, 'A/R on TB').toBe(total);
      expect.soft(grand(sum).cells.total, 'summary').toBe(total);
      expect.soft(grand(det).cells.open, 'detail').toBe(total);
      expect.soft(grand(open).cells.open, 'open invoices').toBe(total);
      expect.soft(m(grand(bal).cells.balance).toFixed(2), 'customer balance').toBe(total);
      // The legacy services behind older pages use the same as-of logic.
      const legacy = await arAging(ctx, eod(asOf));
      const legacyDet = await arAgingDetail(ctx, eod(asOf));
      expect.soft(m(legacy.totals.total).toFixed(2), 'legacy arAging').toBe(total);
      expect.soft(m(legacyDet.total).toFixed(2), 'legacy arAgingDetail').toBe(total);
      expect.soft(sorted(legacyDet.rows.map((r) => r.openBalance)), 'legacy detail docs').toEqual(docs);
      // No memo ever shows as more credit than it was written for, and never as a positive row.
      for (const r of legacyDet.rows.filter((x) => x.docType === 'credit_memo')) {
        expect(m(r.openBalance).lessThan(0)).toBe(true);
        expect(m(r.openBalance).greaterThanOrEqualTo(-100)).toBe(true);
      }
    });
  }

  it('Collections Report on 1/31 never lists the memos and shows the not-yet-applied invoices whole', async () => {
    // 2/28: invoice 1 (due 2/04) and invoice 2 (due 2/07) are overdue.
    const c = await runStandardReport(co.ctx, 'collections-report', { asOf: '2026-02-28' });
    expect(sorted(dataRows(c).map((x) => x.cells.open))).toEqual(['60.00', '150.00']);
    const early = await runStandardReport(co.ctx, 'collections-report', { asOf: '2026-02-14' });
    expect(sorted(dataRows(early).map((x) => x.cells.open))).toEqual(['60.00', '220.00']);
  });

  it("another company's credit applications never move this company's aging", async () => {
    const before = grand(await runStandardReport(co.ctx, 'ar-aging-summary', { asOf: '2026-01-31' })).cells.total;
    const other = await newCompany();
    const line = (amount: string) => ({ accountId: other.code['4000'], quantity: 1, rate: amount, taxable: false });
    const c = (await createCustomer(other.ctx, { displayName: 'Credit Juggler' })).id;
    const inv = await createInvoice(other.ctx, { customerId: c, date: d('2026-01-05'), dueDate: d('2026-02-04'), lines: [line('999.99')] });
    const cm = await createCreditMemo(other.ctx, { customerId: c, date: d('2026-01-10'), lines: [line('333.33')] });
    await applyToInvoice(other.ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '333.33', date: d('2026-03-10') });
    expect(grand(await runStandardReport(co.ctx, 'ar-aging-summary', { asOf: '2026-01-31' })).cells.total).toBe(before);
    const o = await runStandardReport(other.ctx, 'ar-aging-detail', { asOf: '2026-01-31' });
    expect(sorted(dataRows(o).map((x) => x.cells.open))).toEqual(['-333.33', '999.99']);
    expect(grand(o).cells.open).toBe(await tbBalance(other.ctx, 'Accounts Receivable', '2026-01-31'));
    // Applying a memo to a document in another company is refused outright.
    await expect(applyToInvoice(co.ctx, { creditMemoId: ids.cmC, invoiceId: inv.id, amount: '1.00' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A/P
// ---------------------------------------------------------------------------

describe('A/P aging with vendor credits applied, unapplied and re-applied', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const exp = (amount: string) => [{ accountId: code['6000'], amount }];
    ids.v = (await createVendor(ctx, { displayName: 'Main Supplier' })).id;
    ids.v2 = (await createVendor(ctx, { displayName: 'Second Supplier' })).id;
    // vc1 50.00 (1/12) → bill1 200.00 (1/20): apply 30, unapply 10 → 20 effective 1/20.
    ids.vc1 = (await createVendorCredit(ctx, { vendorId: ids.v, date: d('2026-01-12'), lines: exp('50.00') })).id;
    ids.bill1 = (await createBill(ctx, { vendorId: ids.v, date: d('2026-01-20'), dueDate: d('2026-02-19'), lines: exp('200.00') })).id;
    await applyToBill(ctx, { vendorCreditId: ids.vc1, billId: ids.bill1, amount: '30.00' });
    await unapplyFromBill(ctx, { vendorCreditId: ids.vc1, billId: ids.bill1, amount: '10.00' });
    // vc4 5.00 (1/25) stays open: a second open credit for the same vendor.
    ids.vc4 = (await createVendorCredit(ctx, { vendorId: ids.v, date: d('2026-01-25'), lines: exp('5.00') })).id;
    // bill2 100.00 (2/05) ← 15.00 of vc1, effective 2/05 (the later of the two dates).
    ids.bill2 = (await createBill(ctx, { vendorId: ids.v, date: d('2026-02-05'), dueDate: d('2026-03-07'), lines: exp('100.00') })).id;
    await applyToBill(ctx, { vendorCreditId: ids.vc1, billId: ids.bill2, amount: '15.00' });
    // vc2 40.00 (2/10) → bill1, effective 2/10.
    ids.vc2 = (await createVendorCredit(ctx, { vendorId: ids.v, date: d('2026-02-10'), lines: exp('40.00') })).id;
    await applyToBill(ctx, { vendorCreditId: ids.vc2, billId: ids.bill1, amount: '40.00' });
    // Second supplier: bill3 80.00 (1/03) ← vc3 25.00 (1/05): applied, fully unapplied, re-applied.
    ids.bill3 = (await createBill(ctx, { vendorId: ids.v2, date: d('2026-01-03'), dueDate: d('2026-02-02'), lines: exp('80.00') })).id;
    ids.vc3 = (await createVendorCredit(ctx, { vendorId: ids.v2, date: d('2026-01-05'), lines: exp('25.00') })).id;
    await applyToBill(ctx, { vendorCreditId: ids.vc3, billId: ids.bill3, amount: '25.00' });
    await unapplyFromBill(ctx, { vendorCreditId: ids.vc3, billId: ids.bill3, amount: '25.00' });
    await applyToBill(ctx, { vendorCreditId: ids.vc3, billId: ids.bill3, amount: '25.00' });
  }, 180_000);

  // Expected open documents per date (bill +, credit -).
  const expected: Record<string, string[]> = {
    '2026-01-04': ['80.00'],
    '2026-01-15': ['-50.00', '55.00'],
    '2026-01-31': ['-30.00', '-5.00', '55.00', '180.00'],
    '2026-02-07': ['-15.00', '-5.00', '55.00', '85.00', '180.00'],
    '2026-02-28': ['-15.00', '-5.00', '55.00', '85.00', '140.00'],
  };

  for (const [asOf, docs] of Object.entries(expected)) {
    it(`as of ${asOf}: penny-exact documents; every A/P view ties to A/P on the Trial Balance`, async () => {
      const { ctx } = co;
      const [sum, det, bal, unpaid] = await Promise.all([
        runStandardReport(ctx, 'ap-aging-summary', { asOf }),
        runStandardReport(ctx, 'ap-aging-detail', { asOf }),
        runStandardReport(ctx, 'vendor-balance-summary', { asOf }),
        runStandardReport(ctx, 'unpaid-bills-detail', { asOf }),
      ]);
      const ap = Money.of(await tbBalance(ctx, 'Accounts Payable', asOf)).negated().toFixed(2);
      const total = docs.reduce((a, x) => a.plus(m(x)), Money.zero()).toFixed(2);
      expect(sorted(dataRows(det).map((x) => x.cells.open)), 'detail documents').toEqual(docs);
      expect.soft(ap, 'A/P on TB').toBe(total);
      expect.soft(grand(sum).cells.total, 'summary').toBe(total);
      expect.soft(grand(det).cells.open, 'detail').toBe(total);
      expect.soft(m(grand(bal).cells.balance).toFixed(2), 'vendor balance').toBe(total);
      const unpaidTotal = Object.values(grand(unpaid).cells).find((v) => typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v));
      expect.soft(unpaidTotal, 'unpaid bills').toBe(total);
      const legacy = await apAging(ctx, eod(asOf));
      const legacyDet = await apAgingDetail(ctx, eod(asOf));
      expect.soft(m(legacy.totals.total).toFixed(2), 'legacy apAging').toBe(total);
      expect.soft(m(legacyDet.total).toFixed(2), 'legacy apAgingDetail').toBe(total);
      expect.soft(sorted(legacyDet.rows.map((r) => r.openBalance)), 'legacy detail docs').toEqual(docs);
    });
  }

  it('each vendor credit is its own row (never summed), each row a real credit id', async () => {
    const det = await apAgingDetail(co.ctx, eod('2026-01-31'));
    const creditRows = det.rows.filter((r) => r.docType === 'vendor_credit');
    expect(creditRows.map((r) => r.docId).sort()).toEqual([ids.vc1, ids.vc4].sort());
    expect(creditRows.find((r) => r.docId === ids.vc1)?.openBalance).toBe('-30.00');
  });

  it('per-vendor summary rows equal Vendor Balance Summary on each date', async () => {
    for (const asOf of Object.keys(expected)) {
      const sum = await runStandardReport(co.ctx, 'ap-aging-summary', { asOf });
      const bal = await runStandardReport(co.ctx, 'vendor-balance-summary', { asOf });
      for (const r of dataRows(sum)) {
        const b = bal.rows.find((x) => x.cells.label === r.cells.label);
        expect(m(b?.cells.balance).toFixed(2), `${asOf} ${r.cells.label}`).toBe(m(r.cells.total).toFixed(2));
      }
    }
  });

  it('a vendor credit refunded after the report date is still an open credit on that date (ties to A/P)', async () => {
    const other = await newCompany();
    const v = (await createVendor(other.ctx, { displayName: 'Refunder' })).id;
    const vc = await createVendorCredit(other.ctx, { vendorId: v, date: d('2026-01-10'), lines: [{ accountId: other.code['6000'], amount: '50.00' }] });
    await refundVendorCredit(other.ctx, { vendorCreditId: vc.id, bankAccountId: other.code['1000'], amount: '50.00', date: d('2026-02-15') });
    const ap = Money.of(await tbBalance(other.ctx, 'Accounts Payable', '2026-01-31')).negated().toFixed(2);
    expect(ap).toBe('-50.00');
    const sum = await runStandardReport(other.ctx, 'ap-aging-summary', { asOf: '2026-01-31' });
    expect.soft(grand(sum).cells.total, 'A/P aging summary vs A/P').toBe(ap);
    const det = await runStandardReport(other.ctx, 'ap-aging-detail', { asOf: '2026-01-31' });
    expect.soft(sorted(dataRows(det).map((x) => x.cells.open)), 'A/P aging detail').toEqual(['-50.00']);
    const bal = await runStandardReport(other.ctx, 'vendor-balance-summary', { asOf: '2026-01-31' });
    expect.soft(m(grand(bal).cells.balance).toFixed(2), 'vendor balance').toBe(ap);
    // After the refund it is gone everywhere.
    expect(grand(await runStandardReport(other.ctx, 'ap-aging-summary', { asOf: '2026-02-28' })).cells.total).toBe('0.00');
  });

  it("another company's vendor credit applications never move this company's A/P aging", async () => {
    const before = grand(await runStandardReport(co.ctx, 'ap-aging-summary', { asOf: '2026-01-31' })).cells.total;
    const other = await newCompany();
    const v = (await createVendor(other.ctx, { displayName: 'Main Supplier' })).id;
    const vc = await createVendorCredit(other.ctx, { vendorId: v, date: d('2026-01-12'), lines: [{ accountId: other.code['6000'], amount: '70.00' }] });
    const b = await createBill(other.ctx, { vendorId: v, date: d('2026-02-20'), dueDate: d('2026-03-20'), lines: [{ accountId: other.code['6000'], amount: '700.00' }] });
    await applyToBill(other.ctx, { vendorCreditId: vc.id, billId: b.id, amount: '70.00' });
    expect(grand(await runStandardReport(co.ctx, 'ap-aging-summary', { asOf: '2026-01-31' })).cells.total).toBe(before);
    const o = await runStandardReport(other.ctx, 'ap-aging-detail', { asOf: '2026-01-31' });
    expect(sorted(dataRows(o).map((x) => x.cells.open))).toEqual(['-70.00']);
    await expect(applyToBill(co.ctx, { vendorCreditId: ids.vc4, billId: b.id, amount: '1.00' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scheduled exports: folders and archived companies
// ---------------------------------------------------------------------------

describe('scheduled export folders and archived companies', () => {
  const req = (headers: Record<string, string> = {}) =>
    new NextRequest('http://127.0.0.1/api/reports/schedules/run-due', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  it('names that sanitize alike (Café / Cafè, case variants, punctuation only) never share a folder', async () => {
    const names = ['Café', 'Cafè', 'ACME', 'acme', '???', '***', '..', 'CON', ' Café '];
    const ctxs: ServiceContext[] = [];
    for (const nm of names) ctxs.push((await newCompany(nm)).ctx);
    const all = (await db.select({ id: companies.id }).from(companies)).map((c) => ({ db, companyId: c.id, userId }));
    const dirs = await Promise.all(all.map((c) => companyExportDir(c)));
    // Windows paths are case-insensitive: compare lower-cased.
    expect(new Set(dirs.map((x) => x.toLowerCase())).size, dirs.join('\n')).toBe(dirs.length);
    for (const dir of dirs) {
      const rel = path.relative(path.resolve(OUT_DIR), dir);
      expect(rel.startsWith('..') || path.isAbsolute(rel), dir).toBe(false);
      // Each folder segment is a usable name (no trailing dot/space, not bare dots).
      for (const seg of rel.split(path.sep).filter(Boolean)) {
        expect(seg, dir).not.toMatch(/^\.+$|[. ]$/);
      }
    }
    // A company's folder is stable from run to run.
    for (const c of ctxs) expect(await companyExportDir(c)).toBe(await companyExportDir(c));
  });

  it('archived companies are skipped, a restored company is served again', async () => {
    const co = await newCompany('Soon Archived');
    const tok = 'f'.repeat(64);
    process.env.BKA_INTERNAL_TOKEN = tok;
    try {
      const ids = async () => (await internalContexts(req({ 'x-bka-internal': tok })))!.map((c) => c.companyId);
      expect(await ids()).toContain(co.ctx.companyId);
      await db.update(companies).set({ settings: { archived: true } }).where(eq(companies.id, co.ctx.companyId));
      expect(await ids()).not.toContain(co.ctx.companyId);
      await db.update(companies).set({ settings: { archived: false } }).where(eq(companies.id, co.ctx.companyId));
      expect(await ids()).toContain(co.ctx.companyId);
      // Each served context runs as that company's owner, never as another company's.
      const ctxs = (await internalContexts(req({ 'x-bka-internal': tok })))!;
      const owners = new Map((await db.select({ id: companies.id, ownerId: companies.ownerId }).from(companies)).map((c) => [c.id, c.ownerId]));
      for (const c of ctxs) expect(c.userId).toBe(owners.get(c.companyId));
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
  });
});
