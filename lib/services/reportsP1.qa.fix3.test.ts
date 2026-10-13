/**
 * Independent QA (tester), re-test of P1 reports fix round 3 (ea6b6e8): voiding a vendor credit
 * refund from the journal register (voidJournalEntry -> restoreRefundedCustomerCredit) gives the
 * vendor credit back: unapplied up, refundedAmount down (floored at 0), status reopened (open /
 * partial), audit row (vendor_credit, refund_voided) in the same transaction.
 * Adversarial checks:
 *  - One of several partial refunds voided: penny-exact unapplied / refunded / status, and every
 *    A/P view ties to A/P on the Trial Balance on dates before, between and after the refunds.
 *  - A credit partly applied to a bill, rest refunded, refund voided: status 'partial' (not
 *    'open'), the restored part can be applied to a bill again, and aging still ties.
 *  - Voiding the same refund twice never restores twice (unapplied never exceeds total).
 *  - After the void the credit is open in full and can be voided itself (A/P goes to 0) or
 *    refunded again; integrity check stays green.
 *  - Closed period: the void is refused and the credit is untouched (one transaction).
 *  - Company isolation: another company cannot void the refund; its own credit is untouched.
 *  - Regression: voiding a credit-memo refund still restores the customer credit (A/R ties) and
 *    never touches vendor credits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, creditMemos, users, vendorCredits } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createCreditMemo, refundCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit, refundVendorCredit, voidVendorCredit } from './vendorCredits';
import { reverseEntry, voidEntry } from './journal';
import { verifyIntegrity } from './integrity';
import { runStandardReport } from './reportRegistry';
import { apAging, apAgingDetail, arAging } from './reportsExtra';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-p1-qa-fix3');
const saved = { data: process.env.BKA_DATA_DIR };

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
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

async function newCompany(name = `Fix3 QA Co ${++n}`): Promise<Co> {
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
const apOnTb = async (ctx: ServiceContext, asOf: string) => Money.of(await tbBalance(ctx, 'Accounts Payable', asOf)).negated().toFixed(2);
const arOnTb = (ctx: ServiceContext, asOf: string) => tbBalance(ctx, 'Accounts Receivable', asOf);

async function assertApTies(ctx: ServiceContext, asOf: string, docs: string[]) {
  const [sum, det, bal] = await Promise.all([
    runStandardReport(ctx, 'ap-aging-summary', { asOf }),
    runStandardReport(ctx, 'ap-aging-detail', { asOf }),
    runStandardReport(ctx, 'vendor-balance-summary', { asOf }),
  ]);
  const total = sumOf(docs);
  expect(sorted(dataRows(det).map((x) => x.cells.open)), `${asOf} detail documents`).toEqual(docs);
  expect.soft(await apOnTb(ctx, asOf), `${asOf} A/P on TB`).toBe(total);
  expect.soft(m(grand(sum).cells.total).toFixed(2), `${asOf} summary`).toBe(total);
  expect.soft(m(grand(det).cells.open).toFixed(2), `${asOf} detail`).toBe(total);
  expect.soft(m(grand(bal).cells.balance).toFixed(2), `${asOf} vendor balance`).toBe(total);
  const legacy = await apAging(ctx, eod(asOf));
  const legacyDet = await apAgingDetail(ctx, eod(asOf));
  expect.soft(m(legacy.totals.total).toFixed(2), `${asOf} legacy apAging`).toBe(total);
  expect.soft(m(legacyDet.total).toFixed(2), `${asOf} legacy apAgingDetail`).toBe(total);
}

async function credit(id: string) {
  const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, id));
  return { unapplied: m(row.unapplied).toFixed(2), refunded: m(row.refundedAmount).toFixed(2), status: row.status, total: m(row.total).toFixed(2) };
}

async function voidAudits(ctx: ServiceContext, id: string) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'vendor_credit'),
        eq(auditLogs.entityId, id),
        sql`${auditLogs.newValues}->>'action' = 'refund_voided'`,
      ),
    );
}

const exp = (co: Co, amount: string) => [{ accountId: co.code['6000'], amount }];

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'p1-qa-fix3@test.local', name: 'QA', passwordHash: 'x' }).returning();
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

describe('one of several partial vendor refunds voided', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const v = (await createVendor(ctx, { displayName: 'Partial Refunder' })).id;
    ids.vc = (await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: exp(co, '100.00') })).id;
    ids.r1 = (await refundVendorCredit(ctx, { vendorCreditId: ids.vc, bankAccountId: code['1000'], amount: '33.33', date: d('2026-01-20') })).entry.id;
    ids.r2 = (await refundVendorCredit(ctx, { vendorCreditId: ids.vc, bankAccountId: code['1000'], amount: '66.67', date: d('2026-02-20') })).entry.id;
    expect(await credit(ids.vc)).toMatchObject({ unapplied: '0.00', refunded: '100.00', status: 'closed' });
    await voidEntry(ctx, ids.r1);
  }, 180_000);

  it('credit: unapplied 33.33, refunded 66.67, status partial', async () => {
    expect(await credit(ids.vc)).toEqual({ unapplied: '33.33', refunded: '66.67', status: 'partial', total: '100.00' });
  });

  it('writes exactly one refund_voided audit row naming the voided entry', async () => {
    const rows = await voidAudits(co.ctx, ids.vc);
    expect(rows).toHaveLength(1);
    const nv = rows[0].newValues as Record<string, unknown>;
    expect(nv.postedEntryId).toBe(ids.r1);
    expect(nv.unapplied).toBe('33.33');
    expect((rows[0].oldValues as Record<string, unknown>).status).toBe('closed');
  });

  const expected: Record<string, string[]> = {
    '2026-01-09': [],
    '2026-01-15': ['-100.00'],
    '2026-01-20': ['-100.00'], // the 1/20 refund is voided: it no longer counts on any date
    '2026-02-19': ['-100.00'],
    '2026-02-20': ['-33.33'],
    '2026-12-31': ['-33.33'],
  };
  for (const [asOf, docs] of Object.entries(expected)) {
    it(`as of ${asOf}: aging ties to A/P on the Trial Balance`, async () => {
      await assertApTies(co.ctx, asOf, docs);
    });
  }

  it('today: legacy aging equals A/P and integrity is green', async () => {
    const legacy = await apAging(co.ctx);
    expect(m(legacy.totals.total).toFixed(2)).toBe('-33.33');
    const res = await verifyIntegrity(co.ctx);
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('voiding the same refund again is refused and never restores twice', async () => {
    await voidEntry(co.ctx, ids.r1).catch(() => undefined);
    expect(await credit(ids.vc)).toEqual({ unapplied: '33.33', refunded: '66.67', status: 'partial', total: '100.00' });
    expect(await voidAudits(co.ctx, ids.vc)).toHaveLength(1);
  });

  it('voiding the other refund too reopens the credit in full (unapplied == total, refunded 0)', async () => {
    await voidEntry(co.ctx, ids.r2);
    expect(await credit(ids.vc)).toEqual({ unapplied: '100.00', refunded: '0.00', status: 'open', total: '100.00' });
    await assertApTies(co.ctx, '2026-12-31', ['-100.00']);
  });

  it('the fully reopened credit can now be voided itself: A/P back to 0 and aging ties', async () => {
    await voidVendorCredit(co.ctx, ids.vc);
    expect((await credit(ids.vc)).status).toBe('void');
    await assertApTies(co.ctx, '2026-12-31', []);
    const res = await verifyIntegrity(co.ctx);
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
  });
});

describe('credit partly applied to a bill, rest refunded, refund voided', () => {
  let co: Co;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    co = await newCompany();
    const { ctx, code } = co;
    const v = (await createVendor(ctx, { displayName: 'Applied Then Refunded' })).id;
    ids.vc = (await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: exp(co, '80.00') })).id;
    ids.bill = (await createBill(ctx, { vendorId: v, date: d('2026-01-12'), dueDate: d('2026-02-11'), lines: exp(co, '200.00') })).id;
    await applyToBill(ctx, { vendorCreditId: ids.vc, billId: ids.bill, amount: '30.00' });
    ids.r = (await refundVendorCredit(ctx, { vendorCreditId: ids.vc, bankAccountId: code['1000'], amount: '50.00', date: d('2026-02-01') })).entry.id;
    await voidEntry(ctx, ids.r);
  }, 180_000);

  it('status is partial (30.00 still applied), unapplied 50.00, refunded 0', async () => {
    expect(await credit(ids.vc)).toEqual({ unapplied: '50.00', refunded: '0.00', status: 'partial', total: '80.00' });
  });

  it('aging ties to A/P after the void', async () => {
    await assertApTies(co.ctx, '2026-03-31', ['-50.00', '170.00']);
  });

  it('the restored 50.00 can be applied to the bill; it cannot be over-applied', async () => {
    await expect(applyToBill(co.ctx, { vendorCreditId: ids.vc, billId: ids.bill, amount: '50.01' })).rejects.toThrow();
    await applyToBill(co.ctx, { vendorCreditId: ids.vc, billId: ids.bill, amount: '50.00' });
    expect(await credit(ids.vc)).toMatchObject({ unapplied: '0.00', status: 'closed' });
    await assertApTies(co.ctx, '2026-12-31', ['120.00']);
  });
});

describe('vendor refund voided then refunded again', () => {
  it('the credit can be refunded again for the restored amount, not more', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    const v = (await createVendor(ctx, { displayName: 'Bounced Then Paid' })).id;
    const vc = (await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: exp(co, '40.00') })).id;
    const r = (await refundVendorCredit(ctx, { vendorCreditId: vc, bankAccountId: code['1000'], amount: '40.00', date: d('2026-01-15') })).entry.id;
    await voidEntry(ctx, r);
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: vc, bankAccountId: code['1000'], amount: '40.01', date: d('2026-02-01') }),
    ).rejects.toThrow();
    await refundVendorCredit(ctx, { vendorCreditId: vc, bankAccountId: code['1000'], amount: '40.00', date: d('2026-02-01') });
    expect(await credit(vc)).toEqual({ unapplied: '0.00', refunded: '40.00', status: 'closed', total: '40.00' });
    await assertApTies(ctx, '2026-01-20', ['-40.00']);
    await assertApTies(ctx, '2026-02-01', []);
    // Bank: the voided refund never counted, the second one did.
    expect(await tbBalance(ctx, 'Checking', '2026-01-31')).toBe(await tbBalance(ctx, 'Checking', '2026-01-09'));
  });
});

describe('closed period and company isolation', () => {
  it('a void inside the closing date is refused and leaves the credit consumed (one transaction)', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    const v = (await createVendor(ctx, { displayName: 'Locked Refund' })).id;
    const vc = (await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: exp(co, '25.00') })).id;
    const r = (await refundVendorCredit(ctx, { vendorCreditId: vc, bankAccountId: code['1000'], amount: '25.00', date: d('2026-01-15') })).entry.id;
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'lockit' });
    await expect(voidEntry(ctx, r)).rejects.toThrow();
    expect(await credit(vc)).toEqual({ unapplied: '0.00', refunded: '25.00', status: 'closed', total: '25.00' });
    expect(await voidAudits(ctx, vc)).toHaveLength(0);
    await assertApTies(ctx, '2026-03-31', []);
  });

  it("another company cannot void this company's vendor refund; neither credit moves", async () => {
    const a = await newCompany();
    const b = await newCompany();
    const va = (await createVendor(a.ctx, { displayName: 'A Vendor' })).id;
    const vb = (await createVendor(b.ctx, { displayName: 'B Vendor' })).id;
    const vca = (await createVendorCredit(a.ctx, { vendorId: va, date: d('2026-01-10'), lines: exp(a, '60.00') })).id;
    const vcb = (await createVendorCredit(b.ctx, { vendorId: vb, date: d('2026-01-10'), lines: exp(b, '70.00') })).id;
    const ra = (await refundVendorCredit(a.ctx, { vendorCreditId: vca, bankAccountId: a.code['1000'], amount: '60.00', date: d('2026-01-15') })).entry.id;
    await refundVendorCredit(b.ctx, { vendorCreditId: vcb, bankAccountId: b.code['1000'], amount: '70.00', date: d('2026-01-15') });
    await expect(voidEntry(b.ctx, ra)).rejects.toThrow();
    expect(await credit(vca)).toMatchObject({ unapplied: '0.00', refunded: '60.00', status: 'closed' });
    expect(await credit(vcb)).toMatchObject({ unapplied: '0.00', refunded: '70.00', status: 'closed' });
    // Voiding in A restores only A's credit.
    await voidEntry(a.ctx, ra);
    expect(await credit(vca)).toMatchObject({ unapplied: '60.00', refunded: '0.00', status: 'open' });
    expect(await credit(vcb)).toMatchObject({ unapplied: '0.00', refunded: '70.00', status: 'closed' });
    await assertApTies(a.ctx, '2026-03-31', ['-60.00']);
    await assertApTies(b.ctx, '2026-03-31', []);
  });
});

describe('regression: customer credit memo refund void', () => {
  it('still restores the memo, ties A/R, and never touches vendor credits', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    const cust = (await createCustomer(ctx, { displayName: 'Refunded Customer' })).id;
    await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-01-05'),
      dueDate: d('2026-02-04'),
      lines: [{ accountId: code['4000'], quantity: 1, rate: '500.00', taxable: false }],
    });
    const cm = await createCreditMemo(ctx, { customerId: cust, date: d('2026-01-12'), lines: [{ accountId: code['4000'], quantity: 1, rate: '60.00', taxable: false }] });
    const v = (await createVendor(ctx, { displayName: 'Bystander Vendor' })).id;
    const vc = (await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: exp(co, '45.00') })).id;
    await refundVendorCredit(ctx, { vendorCreditId: vc, bankAccountId: code['1000'], amount: '45.00', date: d('2026-01-15') });
    const { entry } = await refundCreditMemo(ctx, { creditMemoId: cm.id, bankAccountId: code['1000'], amount: '60.00', date: d('2026-01-20') });
    await voidEntry(ctx, entry.id);
    const [memo] = await db.select().from(creditMemos).where(eq(creditMemos.id, cm.id));
    expect(m(memo.unapplied).toFixed(2)).toBe('60.00');
    expect(m(memo.refundedAmount).toFixed(2)).toBe('0.00');
    expect(await credit(vc)).toMatchObject({ unapplied: '0.00', refunded: '45.00', status: 'closed' });
    expect(await voidAudits(ctx, vc)).toHaveLength(0);
    const ar = await arAging(ctx, eod('2026-03-31'));
    expect(m(ar.totals.total).toFixed(2)).toBe(await arOnTb(ctx, '2026-03-31'));
    expect(await arOnTb(ctx, '2026-03-31')).toBe('440.00');
    await assertApTies(ctx, '2026-03-31', []);
  });
});

describe('reversing (not voiding) a vendor refund', () => {
  it('is refused, so the GL and the vendor credit never disagree', async () => {
    const co = await newCompany();
    const { ctx, code } = co;
    const v = (await createVendor(ctx, { displayName: 'Reversal Attempt' })).id;
    const vc = (await createVendorCredit(ctx, { vendorId: v, date: d('2026-01-10'), lines: exp(co, '40.00') })).id;
    const r = (await refundVendorCredit(ctx, { vendorCreditId: vc, bankAccountId: code['1000'], amount: '40.00', date: d('2026-01-15') })).entry.id;
    await expect(reverseEntry(ctx, r, d('2026-02-01'))).rejects.toThrow();
    expect(await credit(vc)).toEqual({ unapplied: '0.00', refunded: '40.00', status: 'closed', total: '40.00' });
    await assertApTies(ctx, '2026-03-31', []);
  });
});
