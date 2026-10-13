/**
 * P1 round, team FX — tester re-test 7 (adversarial tests for fix round 7 = merge 006b1c3 + d78b931).
 *
 * Fix round 7 dated every vendor-credit application (never before the credit or the bill, an unapply
 * never before its apply), rebuilt the as-of A/P credit engine for home and foreign credits (dated
 * foreign application rows, audited home applications effective from max(credit, bill date), refunds
 * dated after the cutoff added back) and relies on main's guard for home memos on foreign invoices.
 *
 * Edges pushed here (each check: GL A/P == A/P aging == aging detail == Vendor Balance Summary on
 * every day of the window, plus TB balanced):
 *  [R1]  a refund dated BEFORE the credit exists (foreign and home): refused, or every view ties.
 *  [V1]  foreign credit applied, unapplied later, then the BILL is voided.
 *  [V2]  foreign credit applied, unapplied later, then the CREDIT is voided.
 *  [E1]  foreign credit applied, unapplied later, then the bill is re-dated after that history.
 *  [E2]  foreign credit applied, unapplied later, then the credit is re-dated after that history.
 *  [E3]  home-currency controls of V1/E1 (audited applications) — must tie.
 *  [P1]  penny walk: one EUR credit split in odd cents over three bills at three rates, partial
 *        unapply, partial refund, re-apply — every day; homeUnapplied ends at exactly 0.00.
 *  [P2]  Pay Bills dated before the credit: refused, nothing saved (no payment, no application).
 *  [K1]  closing date: an FX apply dated in a closed period is refused and nothing is saved.
 *  [I1]  company isolation: another company's dated applications / refunds do not move this
 *        company's as-of A/P aging.
 *  [C2]  currency mismatch on the A/R side the other way round: EUR memo on a home invoice and on a
 *        GBP invoice — refused, A/R aging == GL.
 *  [API] vendor-credit apply / unapply / refund through the route: a date before the credit is a
 *        400 with the plain message; an unreadable date is a 400, not a 500; permissions entry.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  billPayments,
  bills,
  invoices,
  journalEntries,
  journalEntryLines,
  users,
  vendorCreditApplications,
  vendorCredits,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createBill, updateBill, voidBill } from './bills';
import {
  createVendorCredit,
  updateVendorCredit,
  applyToBill,
  unapplyFromBill,
  refundVendorCredit,
  voidVendorCredit,
} from './vendorCredits';
import { payBillsWithCredits } from './billPayments';
import { createInvoice } from './invoices';
import { createCreditMemo, applyToInvoice } from './creditMemos';
import { apAging, apAgingDetail, arAging } from './reportsExtra';
import { vendorBalanceSummary } from './reportsLists';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import { Money } from '@/lib/money';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as vcPOST } from '@/app/api/vendor-credits/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest7');
let db: DB;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const FAR = d('2099-12-31');
const iso = (x: Date) => x.toISOString().slice(0, 10);
const days = (from: string, to: string) => {
  const out: Date[] = [];
  for (let t = d(from).getTime(); t <= d(to).getTime(); t += 86400000) out.push(new Date(t));
  return out;
};

async function apAsOf(asOf: Date, c: ServiceContext = ctx): Promise<string> {
  const [ap] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, c.companyId), eq(accounts.code, '2000')));
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, ap.id), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  return Money.of(row.c).minus(Money.of(row.d)).toFixed(2);
}
async function arAsOf(asOf: Date): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, acct['1200']), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  return Money.of(row.d).minus(Money.of(row.c)).toFixed(2);
}
async function summaryTotal(asOf: Date): Promise<string> {
  const sum = await vendorBalanceSummary(ctx, { asOf: iso(asOf) } as never);
  return sum.rows
    .filter((r) => r.kind === 'data')
    .reduce((s, r) => s.plus(Money.of(String(r.cells.balance ?? '0'))), Money.zero())
    .toFixed(2);
}
/** GL A/P, A/P aging, aging detail and Vendor Balance Summary must agree on every date. */
async function apMismatches(dates: Date[]): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const ap = await apAsOf(day);
    const aging = Money.of((await apAging(ctx, day)).totals.total).toFixed(2);
    const detail = Money.of((await apAgingDetail(ctx, day)).total).toFixed(2);
    const summary = await summaryTotal(day);
    if (aging !== ap || detail !== ap || summary !== ap) {
      out.push(`${iso(day)}: A/P ${ap} aging ${aging} detail ${detail} summary ${summary}`);
    }
  }
  return out;
}
async function balanced() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}
async function eurVendor(name: string) {
  return createVendor(ctx, { displayName: name, currency: 'EUR' });
}
function eurBill(vendorId: string, amount: string, date = '2026-06-01', rate = '1.1111') {
  return createBill(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
}
function eurCredit(vendorId: string, amount: string, date = '2026-07-01', rate = '1.2345') {
  return createVendorCredit(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
}
function homeBill(vendorId: string, amount: string, date = '2026-06-01') {
  return createBill(ctx, { vendorId, date: d(date), lines: [{ accountId: acct['6000'], amount }] } as never);
}
function homeCredit(vendorId: string, amount: string, date = '2026-07-01') {
  return createVendorCredit(ctx, { vendorId, date: d(date), lines: [{ accountId: acct['6000'], amount }] } as never);
}
/** Either the step is refused in plain words, or every view agrees with GL on every day. */
async function refusedOrConsistent(step: () => Promise<unknown>, window: Date[]) {
  let refused: Error | null = null;
  try {
    await step();
  } catch (e) {
    refused = e as Error;
  }
  if (refused) {
    expect(refused.message).toMatch(/before|date/i);
    return 'refused';
  }
  expect(await apMismatches(window)).toEqual([]);
  await balanced();
  return 'consistent';
}
function post(id: string, body: unknown) {
  return vcPOST(
    new Request(`http://localhost/api/vendor-credits/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

describe('P1 FX — tester re-test 7: dated vendor-credit steps around void / edit / refund / penny / isolation', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-rt7@test.local', name: 'FX RT7', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  async function newCompany(name: string): Promise<{ c: ServiceContext; a: Record<string, string> }> {
    const company = await createCompany(db, { name, ownerId: userId });
    const c: ServiceContext = { db, companyId: company.id, userId };
    const a: Record<string, string> = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) a[r.code] = r.id;
    await setBaseCurrency(c, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(c, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    await upsertCurrency(c, { code: 'GBP', name: 'Pound', rateToBase: '1.25' });
    a['1020'] = (await createAccount(c, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(c, a['1020'], 'EUR');
    return { c, a };
  }
  beforeEach(async () => {
    seq += 1;
    const { c, a } = await newCompany(`FX RT7 Co ${seq}`);
    ctx = c;
    acct = a;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  // ---------------------------------------------------------------------------------------------
  // [R1] refunds dated before the credit
  // ---------------------------------------------------------------------------------------------

  it('[R1] a foreign refund dated before the credit exists: refused, or every view ties', async () => {
    const v = await eurVendor('R1 Vendor');
    const vc = await eurCredit(v.id, '50.00', '2026-07-20');
    await refusedOrConsistent(
      () => refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '20.00', date: d('2026-07-05'), exchangeRate: '1.20' }),
      [...days('2026-07-01', '2026-07-31'), FAR],
    );
  });

  it('[R1-home] a home refund dated before the credit exists: refused, or every view ties', async () => {
    const v = await createVendor(ctx, { displayName: 'R1 Home Vendor' });
    const vc = await homeCredit(v.id, '50.00', '2026-07-20');
    await refusedOrConsistent(
      () => refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-07-05') }),
      [...days('2026-07-01', '2026-07-31'), FAR],
    );
  });

  // ---------------------------------------------------------------------------------------------
  // [V] void after an apply/unapply history
  // ---------------------------------------------------------------------------------------------

  it('[V1] EUR credit applied 07-05, unapplied 07-10, then the bill is voided: every view ties all July', async () => {
    const v = await eurVendor('V1 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    expect(await apMismatches([...days('2026-07-01', '2026-07-15'), FAR])).toEqual([]);
    await voidBill(ctx, bill.id);
    expect(await apMismatches([...days('2026-06-01', '2026-06-02'), ...days('2026-07-01', '2026-07-31'), new Date(), FAR])).toEqual([]);
    await balanced();
  });

  it('[V2] EUR credit applied 07-05, unapplied 07-10, then the credit is voided: every view ties all July', async () => {
    const v = await eurVendor('V2 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await voidVendorCredit(ctx, vc.id);
    expect(await apMismatches([...days('2026-07-01', '2026-07-31'), new Date(), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [E] re-dating a document after an apply/unapply history
  // ---------------------------------------------------------------------------------------------

  it('[E1] EUR bill re-dated 07-20 after a 07-05 apply / 07-10 unapply: refused, or every view ties', async () => {
    const v = await eurVendor('E1 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await refusedOrConsistent(
      () => updateBill(ctx, bill.id, { vendorId: v.id, date: d('2026-07-20'), exchangeRate: '1.1111', lines: [{ accountId: acct['6000'], amount: '40.00' }] } as never),
      [...days('2026-07-01', '2026-07-31'), FAR],
    );
  });

  it('[E2] EUR credit re-dated 07-20 after a 07-05 apply / 07-10 unapply: refused, or every view ties', async () => {
    const v = await eurVendor('E2 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await refusedOrConsistent(
      () => updateVendorCredit(ctx, vc.id, { vendorId: v.id, date: d('2026-07-20'), exchangeRate: '1.2345', lines: [{ accountId: acct['6000'], amount: '100.00' }] } as never),
      [...days('2026-07-01', '2026-07-31'), FAR],
    );
  });

  it('[E3] home controls: void bill / re-date bill / void credit after apply + unapply all tie', async () => {
    const v = await createVendor(ctx, { displayName: 'E3 Vendor' });
    const b1 = await homeBill(v.id, '40.00');
    const b2 = await homeBill(v.id, '25.00');
    const c1 = await homeCredit(v.id, '30.00');
    const c2 = await homeCredit(v.id, '15.00', '2026-07-03');
    await applyToBill(ctx, { vendorCreditId: c1.id, billId: b1.id, amount: '30.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: c1.id, billId: b1.id, amount: '30.00', date: d('2026-07-10') });
    await applyToBill(ctx, { vendorCreditId: c2.id, billId: b2.id, amount: '15.00', date: d('2026-07-06') });
    await unapplyFromBill(ctx, { vendorCreditId: c2.id, billId: b2.id, amount: '15.00', date: d('2026-07-12') });
    await voidBill(ctx, b1.id);
    await updateBill(ctx, b2.id, { vendorId: v.id, date: d('2026-07-20'), lines: [{ accountId: acct['6000'], amount: '25.00' }] } as never);
    await voidVendorCredit(ctx, c2.id);
    expect(await apMismatches([...days('2026-06-28', '2026-07-31'), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [P1] penny walk
  // ---------------------------------------------------------------------------------------------

  it('[P1] penny walk: one EUR credit in odd cents over three bills at three rates; every day ties; home unapplied ends at 0.00', async () => {
    const v = await eurVendor('P1 Vendor');
    const b1 = await eurBill(v.id, '33.33', '2026-06-01', '1.0987');
    const b2 = await eurBill(v.id, '0.07', '2026-06-10', '1.3333');
    const b3 = await eurBill(v.id, '66.67', '2026-07-02', '1.1717');
    const vc = await eurCredit(v.id, '100.01', '2026-07-01', '1.2345');
    const step = (fn: typeof applyToBill, billId: string, amount: string, date: string) =>
      fn(ctx, { vendorCreditId: vc.id, billId, amount, date: d(date) });
    await step(applyToBill, b1.id, '0.01', '2026-07-03');
    await step(applyToBill, b1.id, '11.11', '2026-07-04');
    await step(applyToBill, b2.id, '0.07', '2026-07-05');
    await step(applyToBill, b3.id, '33.33', '2026-07-06');
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: b1.id, amount: '0.01', date: d('2026-07-08') });
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '0.03', date: d('2026-07-09'), exchangeRate: '1.4444' });
    await step(applyToBill, b1.id, '22.22', '2026-07-11');
    await step(applyToBill, b3.id, '33.25', '2026-07-12');
    const [mid] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    // 100.01 - 0.01 - 11.11 - 0.07 - 33.33 + 0.01 - 0.03 - 22.22 - 33.25 = 0.00
    expect(mid.unapplied).toBe('0.00');
    expect(mid.homeUnapplied).toBe('0.00');
    expect(await apMismatches([...days('2026-06-01', '2026-06-01'), ...days('2026-06-30', '2026-07-15'), new Date(), FAR])).toEqual([]);
    // Unwind b3 completely (two applications) and refund what comes back: still ties, and the
    // credit's home part telescopes back to exactly 0.00 when its foreign part is 0.00.
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: b3.id, amount: '66.58', date: d('2026-07-20') });
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '66.58', date: d('2026-07-25'), exchangeRate: '1.0001' });
    const [end] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(end.unapplied).toBe('0.00');
    expect(end.homeUnapplied).toBe('0.00');
    expect(await apMismatches([...days('2026-06-30', '2026-07-31'), new Date(), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [P2] Pay Bills dated before the credit
  // ---------------------------------------------------------------------------------------------

  it('[P2] Pay Bills dated before the credit is refused; nothing is saved (no payment, no application)', async () => {
    const v = await eurVendor('P2 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '10.00', '2026-07-20');
    await expect(
      payBillsWithCredits(ctx, {
        vendorId: v.id,
        date: d('2026-07-15'),
        method: 'check',
        paymentAccountId: acct['1020'],
        exchangeRate: '1.15',
        applications: [{ billId: bill.id, amountApplied: '30.00' }],
        vendorCredits: [{ vendorCreditId: vc.id, billId: bill.id, amount: '10.00' }],
      } as never),
    ).rejects.toThrow(/before it exists/);
    expect(await db.select().from(billPayments).where(eq(billPayments.companyId, ctx.companyId))).toEqual([]);
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id))).toEqual([]);
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.balanceDue).toBe('40.00');
    expect(await apMismatches([...days('2026-07-14', '2026-07-21'), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [K1] closing date
  // ---------------------------------------------------------------------------------------------

  it('[K1] an apply with an exchange difference dated in a closed period is refused; nothing is saved', async () => {
    const v = await eurVendor('K1 Vendor');
    const bill = await eurBill(v.id, '40.00', '2026-01-05');
    const vc = await eurCredit(v.id, '100.00', '2026-01-10');
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'close-pw' } as never);
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-01-20') }),
    ).rejects.toThrow();
    const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(row.unapplied).toBe('100.00');
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id))).toEqual([]);
    // Dated after the closing date it works and ties.
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-02-02') });
    expect(await apMismatches([d('2026-01-20'), d('2026-01-31'), d('2026-02-01'), d('2026-02-02'), FAR])).toEqual([]);
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [I1] isolation
  // ---------------------------------------------------------------------------------------------

  it("[I1] another company's dated applications and refunds do not move this company's as-of A/P aging", async () => {
    const v = await eurVendor('I1 Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '20.00', date: d('2026-07-10') });
    const window = [...days('2026-07-01', '2026-07-31'), FAR];
    const snap = async () => {
      const out: string[] = [];
      for (const day of window) out.push(`${(await apAging(ctx, day)).totals.total}|${(await apAgingDetail(ctx, day)).total}`);
      return out;
    };
    const before = await snap();
    // Company B: same shapes, overlapping dates, home and foreign credits, refunds after the cutoff.
    const mine = { ctx, acct };
    const other = await newCompany(`FX RT7 Other ${seq}`);
    ctx = other.c;
    acct = other.a;
    const v2 = await eurVendor('I1 Vendor');
    const b2 = await eurBill(v2.id, '400.00');
    const c2 = await eurCredit(v2.id, '1000.00');
    await applyToBill(ctx, { vendorCreditId: c2.id, billId: b2.id, amount: '300.00', date: d('2026-07-12') });
    await refundVendorCredit(ctx, { vendorCreditId: c2.id, bankAccountId: acct['1020'], amount: '100.00', date: d('2026-07-20'), exchangeRate: '1.3' });
    const hv = await createVendor(ctx, { displayName: 'I1 Home' });
    const hb = await homeBill(hv.id, '70.00');
    const hc = await homeCredit(hv.id, '90.00');
    await applyToBill(ctx, { vendorCreditId: hc.id, billId: hb.id, amount: '70.00' });
    await refundVendorCredit(ctx, { vendorCreditId: hc.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-07-25') });
    expect(await apMismatches(window)).toEqual([]);
    ctx = mine.ctx;
    acct = mine.acct;
    expect(await snap()).toEqual(before);
    expect(await apMismatches(window)).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // [C2] A/R currency mismatch, other directions
  // ---------------------------------------------------------------------------------------------

  it('[C2] credit memos are home-only: refused on a GBP invoice, applied to a home invoice; A/R aging == GL', async () => {
    const c = await createCustomer(ctx, { displayName: 'C2 Customer' } as never);
    const homeInv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const gbpInv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-01'),
      currency: 'GBP',
      exchangeRate: '1.25',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00' }],
    } as never);
    const memo = await createCreditMemo(ctx, {
      customerId: c.id,
      date: d('2026-06-02'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '10.00' }],
    } as never);
    await expect(applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: gbpInv.id, amount: '10.00' })).rejects.toThrow(/This invoice is in GBP\./);
    const [gbp] = await db.select().from(invoices).where(eq(invoices.id, gbpInv.id));
    expect(gbp.balanceDue).toBe('40.00');
    await applyToInvoice(ctx, { creditMemoId: memo.id, invoiceId: homeInv.id, amount: '10.00' });
    const [hm] = await db.select().from(invoices).where(eq(invoices.id, homeInv.id));
    expect(hm.balanceDue).toBe('30.00');
    for (const day of [d('2026-06-01'), d('2026-06-02'), d('2026-06-30'), FAR]) {
      expect(Money.of((await arAging(ctx, day)).totals.total).toFixed(2)).toBe(await arAsOf(day));
    }
    await balanced();
  });

  // ---------------------------------------------------------------------------------------------
  // [API] dates through the route; permissions
  // ---------------------------------------------------------------------------------------------

  it('[API] apply dated before the credit is a 400 with the plain message; nothing is saved', async () => {
    const v = await eurVendor('API Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00', '2026-07-20');
    const res = await post(vc.id, { action: 'apply', billId: bill.id, amount: '40.00', date: '2026-07-05' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/can't be applied before it exists/);
    const ok = await post(vc.id, { action: 'apply', billId: bill.id, amount: '40.00', date: '2026-07-21' });
    expect(ok.status).toBe(200);
    const bad = await post(vc.id, { action: 'unapply', billId: bill.id, amount: '40.00', date: '2026-07-20' });
    expect(bad.status).toBe(400);
    expect(await apMismatches([...days('2026-07-18', '2026-07-23'), FAR])).toEqual([]);
  });

  it('[API] an unreadable date on apply / unapply / refund is a 400 validation error, not a 500', async () => {
    const v = await eurVendor('API Bad Date Vendor');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const apply = await post(vc.id, { action: 'apply', billId: bill.id, amount: '10.00', date: 'not-a-date' });
      const refund = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '10.00', date: 'not-a-date' });
      await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-07-02') });
      const unapply = await post(vc.id, { action: 'unapply', billId: bill.id, amount: '10.00', date: '2026-13-45' });
      expect({ apply: apply.status, refund: refund.status, unapply: unapply.status }).toEqual({ apply: 400, refund: 400, unapply: 400 });
    } finally {
      errSpy.mockRestore();
    }
    const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(row.unapplied).toBe('90.00');
    expect(row.refundedAmount ?? '0.00').toBe('0.00');
    await balanced();
  });

  it('[perm] the vendor-credit apply / unapply / refund route needs Vendors modify access', () => {
    const entry = API_ROUTE_PERMISSIONS['/api/vendor-credits/[id]'] as Record<string, unknown>;
    expect(entry.POST).toEqual({ area: 'vendors', action: 'modify' });
  });
});
