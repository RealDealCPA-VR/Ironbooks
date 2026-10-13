/**
 * Independent QA (tester), re-test of P1 reports fix round 2: as-of A/P aging adds back vendor
 * credit refunds dated AFTER the report date (creditMemoRefundsAfter, sourceRef 'refund:<id>').
 * Adversarial checks:
 *  - Several partial refunds of one credit, before / on / after the report date, mixed with a
 *    later application to a bill and a final refund that closes the credit. On every date the
 *    per-document open balances are penny-exact and A/P Aging Summary == Detail == Vendor Balance
 *    Summary == Unpaid Bills == A/P on the Trial Balance == legacy apAging / apAgingDetail.
 *  - A credit refunded in full on its own date never appears (no double add-back).
 *  - Aging options (vendor filter, Interval / Through, aging from transaction date) keep the
 *    added-back credit and the total.
 *  - A voided vendor refund (journal register void): the credit is open again and aging still ties
 *    to A/P. FAILS today: voidJournalEntry restores customer refunds (restoreRefundedCustomerCredit)
 *    but not vendor-credit refunds, so vendorCredits.unapplied stays consumed while the A/P GL
 *    reverses the refund (production bug in posting.ts / vendorCredits.ts, outside reportsExtra).
 *  - Customer and vendor refunds in one company never cross ledgers (the shared 'refund:' prefix).
 *  - Company isolation: another company's vendor refunds never move this company's aging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createCreditMemo, refundCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit, refundVendorCredit } from './vendorCredits';
import { voidEntry } from './journal';
import { runStandardReport } from './reportRegistry';
import { apAging, apAgingDetail, arAging } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-p1-qa-fix2');
const saved = { data: process.env.BKA_DATA_DIR };

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const noon = (s: string) => new Date(`${s}T12:00:00.000Z`);
const eod = (s: string) => new Date(`${s}T23:59:59.999Z`);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;
const dataRows = (r: StdReport) => r.rows.filter((x) => x.kind === 'data');
const m = (v: unknown) => Money.of(v == null || v === '' ? '0' : String(v));
const sorted = (xs: unknown[]) => xs.map((x) => m(x).toFixed(2)).sort((a, b) => Number(a) - Number(b));
const sumOf = (xs: string[]) => xs.reduce((a, x) => a.plus(m(x)), Money.zero()).toFixed(2);

let db: DB;
let userId: string;
let n = 0;

interface Co {
  ctx: ServiceContext;
  code: Record<string, string>;
}

async function newCompany(name = `Fix2 QA Co ${++n}`): Promise<Co> {
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

/** A/P on the Trial Balance as a payable (credit balance positive). */
const apOnTb = async (ctx: ServiceContext, asOf: string) => Money.of(await tbBalance(ctx, 'Accounts Payable', asOf)).negated().toFixed(2);
const arOnTb = (ctx: ServiceContext, asOf: string) => tbBalance(ctx, 'Accounts Receivable', asOf);

/** Every A/P view on one date: returns the open documents and asserts all totals tie to A/P. */
async function assertApTies(ctx: ServiceContext, asOf: string, docs: string[]) {
  const [sum, det, bal, unpaid] = await Promise.all([
    runStandardReport(ctx, 'ap-aging-summary', { asOf }),
    runStandardReport(ctx, 'ap-aging-detail', { asOf }),
    runStandardReport(ctx, 'vendor-balance-summary', { asOf }),
    runStandardReport(ctx, 'unpaid-bills-detail', { asOf }),
  ]);
  const total = sumOf(docs);
  expect(sorted(dataRows(det).map((x) => x.cells.open)), `${asOf} detail documents`).toEqual(docs);
  expect.soft(await apOnTb(ctx, asOf), `${asOf} A/P on TB`).toBe(total);
  expect.soft(m(grand(sum).cells.total).toFixed(2), `${asOf} summary`).toBe(total);
  expect.soft(m(grand(det).cells.open).toFixed(2), `${asOf} detail`).toBe(total);
  expect.soft(m(grand(bal).cells.balance).toFixed(2), `${asOf} vendor balance`).toBe(total);
  const bills = docs.filter((x) => m(x).greaterThan(0));
  const unpaidTotal = Object.values(grand(unpaid).cells).find((v) => typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v));
  // Unpaid Bills lists bills only in some builds and bills + credits in others: accept either.
  expect.soft([sumOf(bills), total], `${asOf} unpaid bills`).toContain(m(unpaidTotal).toFixed(2));
  const legacy = await apAging(ctx, eod(asOf));
  const legacyDet = await apAgingDetail(ctx, eod(asOf));
  expect.soft(m(legacy.totals.total).toFixed(2), `${asOf} legacy apAging`).toBe(total);
  expect.soft(m(legacyDet.total).toFixed(2), `${asOf} legacy apAgingDetail`).toBe(total);
  expect.soft(sorted(legacyDet.rows.map((r) => r.openBalance)), `${asOf} legacy detail docs`).toEqual(docs);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'p1-qa-fix2@test.local', name: 'QA', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  if (saved.data === undefined) delete process.env.BKA_DATA_DIR;
  else process.env.BKA_DATA_DIR = saved.data;
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

// ---------------------------------------------------------------------------
// Partial refunds on several dates
// ---------------------------------------------------------------------------

describe('A/P aging with vendor credits refunded in parts on several dates', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const exp = (amount: string) => [{ accountId: code['6000'], amount }];
    ids.v = (await createVendor(ctx, { displayName: 'Refunding Supplier' })).id;
    ids.v2 = (await createVendor(ctx, { displayName: 'Same Day Refunder' })).id;
    // vc1 100.00 (1/10): refund 20.00 on 1/20 (noon), 30.00 on 2/15; bill 2/20 takes 25.00;
    // the last 25.00 refunded 3/10 -> closed.
    ids.vc1 = (await createVendorCredit(ctx, { vendorId: ids.v, date: d('2026-01-10'), lines: exp('100.00') })).id;
    await refundVendorCredit(ctx, { vendorCreditId: ids.vc1, bankAccountId: code['1000'], amount: '20.00', date: noon('2026-01-20') });
    await refundVendorCredit(ctx, { vendorCreditId: ids.vc1, bankAccountId: code['1000'], amount: '30.00', date: d('2026-02-15') });
    ids.bill = (await createBill(ctx, { vendorId: ids.v, date: d('2026-02-20'), dueDate: d('2026-03-20'), lines: exp('100.00') })).id;
    await applyToBill(ctx, { vendorCreditId: ids.vc1, billId: ids.bill, amount: '25.00' });
    await refundVendorCredit(ctx, { vendorCreditId: ids.vc1, bankAccountId: code['1000'], amount: '25.00', date: d('2026-03-10') });
    // vc2 30.00 (1/05) refunded in full the same day: never open at a day's end.
    ids.vc2 = (await createVendorCredit(ctx, { vendorId: ids.v2, date: d('2026-01-05'), lines: exp('30.00') })).id;
    await refundVendorCredit(ctx, { vendorCreditId: ids.vc2, bankAccountId: code['1000'], amount: '30.00', date: d('2026-01-05') });
  }, 180_000);

  const expected: Record<string, string[]> = {
    '2026-01-04': [],
    '2026-01-05': [],
    '2026-01-15': ['-100.00'],
    '2026-01-20': ['-80.00'],
    '2026-01-31': ['-80.00'],
    '2026-02-14': ['-80.00'],
    '2026-02-15': ['-50.00'],
    '2026-02-25': ['-25.00', '75.00'],
    '2026-03-09': ['-25.00', '75.00'],
    '2026-03-10': ['75.00'],
    '2026-12-31': ['75.00'],
  };

  for (const [asOf, docs] of Object.entries(expected)) {
    it(`as of ${asOf}: penny-exact open credit; every A/P view ties to A/P on the Trial Balance`, async () => {
      await assertApTies(co.ctx, asOf, docs);
    });
  }

  it('the refunded credit is one row with the real credit id (never split per refund)', async () => {
    const det = await apAgingDetail(co.ctx, eod('2026-01-31'));
    const credits = det.rows.filter((r) => r.docType === 'vendor_credit');
    expect(credits.map((r) => r.docId)).toEqual([ids.vc1]);
    expect(credits[0].openBalance).toBe('-80.00');
  });

  it('today (no as-of date) the fully refunded credit is gone and aging ties to A/P', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const legacy = await apAging(co.ctx);
    expect(m(legacy.totals.total).toFixed(2)).toBe('75.00');
    expect(await apOnTb(co.ctx, today)).toBe('75.00');
  });

  it('aging options keep the added-back credit: vendor filter, Interval / Through, transaction-date aging', async () => {
    const asOf = '2026-01-31';
    const only = await runStandardReport(co.ctx, 'ap-aging-detail', { asOf, vendorId: ids.v });
    expect(sorted(dataRows(only).map((x) => x.cells.open))).toEqual(['-80.00']);
    const other = await runStandardReport(co.ctx, 'ap-aging-detail', { asOf, vendorId: ids.v2 });
    expect(dataRows(other)).toHaveLength(0);
    for (const opts of [{ interval: '7', through: '10' }, { interval: '15', through: '45', agingFrom: 'transaction_date' }]) {
      const r = await runStandardReport(co.ctx, 'ap-aging-summary', { asOf, ...opts });
      expect(m(grand(r).cells.total).toFixed(2), JSON.stringify(opts)).toBe('-80.00');
    }
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

  it('a refund larger than the remaining credit is still refused (no negative open credit)', async () => {
    await expect(
      refundVendorCredit(co.ctx, { vendorCreditId: ids.vc1, bankAccountId: co.code['1000'], amount: '0.01', date: d('2026-12-01') }),
    ).rejects.toThrow();
    await assertApTies(co.ctx, '2026-12-31', ['75.00']);
  });
});

// ---------------------------------------------------------------------------
// Voided vendor refund
// ---------------------------------------------------------------------------

describe('a voided vendor refund', () => {
  it('no longer counts on any date: the credit is open again and aging ties to A/P', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    const v = (await createVendor(ctx, { displayName: 'Bounced Refund' })).id;
    const vc = await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: [{ accountId: code['6000'], amount: '40.00' }] });
    const { entry } = await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: code['1000'], amount: '40.00', date: d('2026-02-15') });
    // Voided from the journal register (DELETE /api/journal-entries/[id] -> voidEntry).
    await voidEntry(ctx, entry.id);
    // With the refund voided the vendor still owes the credit on every date after 1/10.
    for (const asOf of ['2026-01-31', '2026-02-15', '2026-03-31']) {
      expect.soft(await apOnTb(ctx, asOf), `${asOf} A/P on TB`).toBe('-40.00');
      const sum = await runStandardReport(ctx, 'ap-aging-summary', { asOf });
      expect.soft(m(grand(sum).cells.total).toFixed(2), `${asOf} A/P aging summary vs A/P`).toBe('-40.00');
      const det = await apAgingDetail(ctx, eod(asOf));
      expect.soft(m(det.total).toFixed(2), `${asOf} A/P aging detail vs A/P`).toBe('-40.00');
    }
  });
});

// ---------------------------------------------------------------------------
// Customer vs vendor refunds share the 'refund:' prefix
// ---------------------------------------------------------------------------

describe('customer and vendor refunds in one company never cross ledgers', () => {
  let co: Co;

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const cust = (await createCustomer(ctx, { displayName: 'Refunded Customer' })).id;
    await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-01-05'),
      dueDate: d('2026-02-04'),
      lines: [{ accountId: code['4000'], quantity: 1, rate: '500.00', taxable: false }],
    });
    const cm = await createCreditMemo(ctx, { customerId: cust, date: d('2026-01-12'), lines: [{ accountId: code['4000'], quantity: 1, rate: '60.00', taxable: false }] });
    await refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: code['1000'], amount: '60.00', date: d('2026-02-10') });
    const v = (await createVendor(ctx, { displayName: 'Refunded Vendor' })).id;
    await createBill(ctx, { vendorId: v, date: d('2026-01-06'), dueDate: d('2026-02-05'), lines: [{ accountId: code['6000'], amount: '300.00' }] });
    const vc = await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-14'), lines: [{ accountId: code['6000'], amount: '45.00' }] });
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: code['1000'], amount: '45.00', date: d('2026-02-12') });
  }, 180_000);

  for (const [asOf, ar, apDocs] of [
    ['2026-01-31', '440.00', ['-45.00', '300.00']],
    ['2026-02-28', '500.00', ['300.00']],
  ] as const) {
    it(`as of ${asOf}: A/R aging ties to A/R and A/P aging ties to A/P`, async () => {
      const { ctx } = co;
      await assertApTies(ctx, asOf, [...apDocs]);
      expect.soft(await arOnTb(ctx, asOf), `${asOf} A/R on TB`).toBe(ar);
      const sum = await runStandardReport(ctx, 'ar-aging-summary', { asOf });
      expect.soft(m(grand(sum).cells.total).toFixed(2), `${asOf} A/R aging summary`).toBe(ar);
      const legacy = await arAging(ctx, eod(asOf));
      expect.soft(m(legacy.totals.total).toFixed(2), `${asOf} legacy arAging`).toBe(ar);
      const cbs = await runStandardReport(ctx, 'customer-balance-summary', { asOf });
      expect.soft(m(grand(cbs).cells.balance).toFixed(2), `${asOf} customer balance`).toBe(ar);
    });
  }
});

// ---------------------------------------------------------------------------
// Company isolation
// ---------------------------------------------------------------------------

describe('company isolation of later vendor refunds', () => {
  it("another company's vendor refunds never move this company's A/P aging", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const va = (await createVendor(a.ctx, { displayName: 'Shared Name' })).id;
    const vca = await createVendorCredit(a.ctx, { vendorId: va, date: d('2026-01-10'), lines: [{ accountId: a.code['6000'], amount: '10.00' }] });
    const before = grand(await runStandardReport(a.ctx, 'ap-aging-summary', { asOf: '2026-01-31' })).cells.total;
    expect(m(before).toFixed(2)).toBe('-10.00');
    const vb = (await createVendor(b.ctx, { displayName: 'Shared Name' })).id;
    const vcb = await createVendorCredit(b.ctx, { vendorId: vb, date: d('2026-01-10'), lines: [{ accountId: b.code['6000'], amount: '90.00' }] });
    await refundVendorCredit(b.ctx, { vendorCreditId: vcb.id, bankAccountId: b.code['1000'], amount: '90.00', date: d('2026-02-20') });
    expect(grand(await runStandardReport(a.ctx, 'ap-aging-summary', { asOf: '2026-01-31' })).cells.total).toBe(before);
    expect(m(grand(await runStandardReport(b.ctx, 'ap-aging-summary', { asOf: '2026-01-31' })).cells.total).toFixed(2)).toBe('-90.00');
    // Company B cannot refund company A's credit.
    await expect(
      refundVendorCredit(b.ctx, { vendorCreditId: vca.id, bankAccountId: b.code['1000'], amount: '1.00', date: d('2026-02-21') }),
    ).rejects.toThrow();
    expect(grand(await runStandardReport(a.ctx, 'ap-aging-summary', { asOf: '2026-01-31' })).cells.total).toBe(before);
  });
});
