/**
 * P1 round, team FX — tester re-test 8 (independent adversarial checks of fix round 8).
 *
 *  [V3]  a credit applied / unapplied on bill A, then applied to bill B: voiding A only drops A's
 *        settled rows; the credit can't be voided while it is on B; after unapplying B it can.
 *  [V4]  several partial unapplies; a bill still partly credited is refused and nothing changes.
 *  [V5]  closing date: a void that would void a closed-period exchange entry is refused whole.
 *  [V6]  after the voids, the foreign payables subledger (HCA source) == GL A/P per vendor, every day.
 *  [E3]  same-day re-date with a different time of day is allowed and still ties.
 *  [E4]  rate / amount edits (same date) after settled history keep aging == GL; homeUnapplied follows.
 *  [E5]  a foreign credit with a refund can't be edited below what was refunded (or still ties).
 *  [R2]  refund floor: same day earlier time-of-day is fine; API before-credit date is a 400 and
 *        posts nothing.
 *  [API2] more unreadable dates (true, [], 2026-02-29, 25:00); a leap day and '' still work;
 *         PATCH re-date after history is a 400 with the plain message.
 *  [ISO] another company can't void / clear / post against these documents.
 *  [M2]  legacy home memo, same customer, partly applied: foreign open == balance due; aging,
 *        per-customer aging rows and HCA customer lines tie to GL by name, several dates.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  bills,
  creditApplications,
  creditMemos,
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
import { clearSettledForeignApplications } from './vendorCreditsFx';
import { createInvoice, markPaidAmount } from './invoices';
import { createCreditMemo } from './creditMemos';
import { apAging, apAgingDetail, arAging, arAgingDetail } from './reportsExtra';
import { foreignOpenPayables, foreignOpenReceivables } from './fxSubledger';
import { previewHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { vendorBalanceSummary, customerBalanceSummary } from './reportsLists';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import { Money } from '@/lib/money';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as vcPOST, PATCH as vcPATCH, DELETE as vcDELETE } from '@/app/api/vendor-credits/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest8');
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

/** Name balance from Vendor / Customer Balance Summary (the GL by name). */
async function nameBalance(kind: 'vendor' | 'customer', id: string, asOf: Date): Promise<string> {
  const rep = kind === 'vendor' ? await vendorBalanceSummary(ctx, { asOf: iso(asOf) } as never) : await customerBalanceSummary(ctx, { asOf: iso(asOf) } as never);
  const row = rep.rows.find((r) => r.id === `bal:${id}`);
  return Money.of(String(row?.cells.balance ?? '0')).toFixed(2);
}
async function glAsOf(code: string, asOf: Date, sign: 1 | -1, entityId?: string): Promise<string> {
  if (entityId) return nameBalance(code === '2000' ? 'vendor' : 'customer', entityId, asOf);
  const conds = [
    eq(journalEntryLines.accountId, acct[code]),
    eq(journalEntries.status, 'posted'),
    lte(journalEntries.date, asOf),
    eq(journalEntries.companyId, ctx.companyId),
  ];
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds));
  const net = Money.of(row.d).minus(Money.of(row.c));
  return (sign === 1 ? net : net.negated()).toFixed(2);
}
/** A/P control == aging == aging detail == foreign payables subledger, and per vendor too. */
async function apMismatches(dates: Date[], vendorIds: string[] = [], withSubledger = true): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const ap = await glAsOf('2000', day, -1);
    const report = await apAging(ctx, day);
    const aging = Money.of(report.totals.total).toFixed(2);
    const detail = Money.of((await apAgingDetail(ctx, day)).total).toFixed(2);
    const sub = !withSubledger ? ap : (await foreignOpenPayables(ctx, day)).reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2);
    if (aging !== ap || detail !== ap || sub !== ap) out.push(`${iso(day)}: A/P ${ap} aging ${aging} detail ${detail} subledger ${sub}`);
    for (const v of vendorIds) {
      const gl = await glAsOf('2000', day, -1, v);
      const row = report.rows.find((r) => r.id === v);
      const got = Money.of(row?.total ?? 0).toFixed(2);
      if (got !== gl) out.push(`${iso(day)} vendor ${v.slice(0, 8)}: GL ${gl} aging ${got}`);
    }
  }
  return out;
}
async function balanced() {
  expect((await trialBalance(ctx)).balanced).toBe(true);
}
const eurVendor = (name: string) => createVendor(ctx, { displayName: name, currency: 'EUR' });
const eurBill = (vendorId: string, amount: string, date = '2026-06-01', rate = '1.1111') =>
  createBill(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
const eurCredit = (vendorId: string, amount: string, date = '2026-07-01', rate = '1.2345') =>
  createVendorCredit(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
async function statuses(ids: (string | null)[]) {
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.id, id));
    out.push(e.status);
  }
  return out;
}
function req(method: string, id: string, body: unknown) {
  return new Request(`http://localhost/api/vendor-credits/${id}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}
const post = (id: string, body: unknown) => vcPOST(req('POST', id, body), { params: Promise.resolve({ id }) });
const appsFor = (where: { billId?: string; vendorCreditId?: string }) =>
  db
    .select()
    .from(vendorCreditApplications)
    .where(where.billId ? eq(vendorCreditApplications.billId, where.billId) : eq(vendorCreditApplications.vendorCreditId, where.vendorCreditId!));

describe('P1 FX — tester re-test 8', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-retest8@test.local', name: 'FX RT8', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `FX RT8 Co ${seq}`, ownerId: userId });
    ctx = { db, companyId: company.id, userId };
    acct = {};
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    await setAccountCurrency(ctx, acct['1020'], 'EUR');
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('[V3] voiding bill A drops only its settled rows; the credit on bill B blocks a credit void until unapplied', async () => {
    const v = await eurVendor('V3');
    const a = await eurBill(v.id, '40.00', '2026-06-01', '1.1111');
    const b = await eurBill(v.id, '30.00', '2026-06-15', '1.0503');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: a.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: a.id, amount: '40.00', date: d('2026-07-10') });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: b.id, amount: '30.00', date: d('2026-07-12') });
    const window = [...days('2026-05-31', '2026-06-16'), ...days('2026-06-30', '2026-07-25'), FAR];
    expect(await apMismatches(window, [v.id])).toEqual([]);

    await voidBill(ctx, a.id);
    expect(await appsFor({ billId: a.id })).toEqual([]);
    expect(await appsFor({ billId: b.id })).toHaveLength(1);
    expect(await apMismatches(window, [v.id])).toEqual([]);

    await expect(voidVendorCredit(ctx, vc.id)).rejects.toThrow(/applied/);
    expect(await appsFor({ billId: b.id })).toHaveLength(1);

    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: b.id, amount: '30.00', date: d('2026-07-20') });
    const bRows = await appsFor({ billId: b.id });
    await voidVendorCredit(ctx, vc.id);
    expect(await appsFor({ vendorCreditId: vc.id })).toEqual([]);
    expect(await statuses(bRows.map((r) => r.fxEntryId))).toEqual(bRows.filter((r) => r.fxEntryId).map(() => 'void'));
    const [bill] = await db.select().from(bills).where(eq(bills.id, b.id));
    expect(bill.balanceDue).toBe('30.00');
    expect(await apMismatches(window, [v.id])).toEqual([]);
    await balanced();
  });

  it('[V4] several partial unapplies, then void; a bill still partly credited is refused with nothing changed', async () => {
    const v = await eurVendor('V4');
    const bill = await eurBill(v.id, '40.00', '2026-06-01', '1.0987');
    const vc = await eurCredit(v.id, '100.00', '2026-07-01', '1.2345');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '15.00', date: d('2026-07-08') });
    const before = await appsFor({ billId: bill.id });
    await expect(voidBill(ctx, bill.id)).rejects.toThrow(/vendor credits applied/);
    expect(await appsFor({ billId: bill.id })).toHaveLength(before.length);
    expect(await statuses(before.map((r) => r.fxEntryId))).toEqual(before.filter((r) => r.fxEntryId).map(() => 'posted'));
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '25.00', date: d('2026-07-10') });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '0.01', date: d('2026-07-11') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '0.01', date: d('2026-07-12') });
    const rows = await appsFor({ billId: bill.id });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    await voidBill(ctx, bill.id);
    expect(await appsFor({ billId: bill.id })).toEqual([]);
    expect(await statuses(rows.map((r) => r.fxEntryId))).toEqual(rows.filter((r) => r.fxEntryId).map(() => 'void'));
    const [credit] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(credit.unapplied).toBe('100.00');
    expect(credit.homeUnapplied).toBe('123.45');
    expect(await apMismatches([...days('2026-06-30', '2026-07-14'), FAR], [v.id])).toEqual([]);
    await balanced();
  });

  it('[V5] a void that would touch a closed-period exchange entry is refused whole; after reopening it works', async () => {
    const v = await eurVendor('V5');
    const bill = await eurBill(v.id, '40.00', '2026-07-02');
    const vc = await eurCredit(v.id, '100.00', '2026-07-01');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    const rows = await appsFor({ billId: bill.id });
    await setClosingDate(ctx, { closingDate: '2026-07-06', password: 'pw' } as never);
    const tbBefore = (await trialBalance(ctx, FAR)).rows;
    await expect(voidBill(ctx, bill.id)).rejects.toThrow();
    await expect(voidVendorCredit(ctx, vc.id)).rejects.toThrow();
    expect(await appsFor({ billId: bill.id })).toHaveLength(rows.length);
    expect(await statuses(rows.map((r) => r.fxEntryId))).toEqual(rows.filter((r) => r.fxEntryId).map(() => 'posted'));
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(b.status).not.toBe('void');
    expect((await trialBalance(ctx, FAR)).rows).toEqual(tbBefore);
    expect(await apMismatches([...days('2026-07-01', '2026-07-12'), FAR], [v.id])).toEqual([]);
    await setClosingDate(ctx, { closingDate: null } as never);
    await voidBill(ctx, bill.id);
    expect(await apMismatches([...days('2026-07-01', '2026-07-12'), FAR], [v.id])).toEqual([]);
    await balanced();
  });

  it('[V6] HCA vendor lines == GL A/P by vendor on each date after a bill void and a credit void', async () => {
    const v1 = await eurVendor('V6 one');
    const v2 = await eurVendor('V6 two');
    const b1 = await eurBill(v1.id, '40.00');
    const c1 = await eurCredit(v1.id, '100.00');
    const b2 = await eurBill(v2.id, '55.55', '2026-06-03', '1.0777');
    const c2 = await eurCredit(v2.id, '20.00', '2026-07-02', '1.3333');
    await applyToBill(ctx, { vendorCreditId: c1.id, billId: b1.id, amount: '40.00', date: d('2026-07-05') });
    await applyToBill(ctx, { vendorCreditId: c2.id, billId: b2.id, amount: '20.00', date: d('2026-07-06') });
    await unapplyFromBill(ctx, { vendorCreditId: c1.id, billId: b1.id, amount: '40.00', date: d('2026-07-10') });
    await unapplyFromBill(ctx, { vendorCreditId: c2.id, billId: b2.id, amount: '20.00', date: d('2026-07-11') });
    await voidBill(ctx, b1.id);
    await voidVendorCredit(ctx, c2.id);
    const dates = [...days('2026-07-04', '2026-07-12'), FAR];
    expect(await apMismatches(dates, [v1.id, v2.id])).toEqual([]);
    for (const day of dates) {
      const hca = await previewHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.15' }, updateCurrencyList: false });
      for (const v of [v1.id, v2.id]) {
        const lines = hca.lines.filter((l) => l.kind === 'vendor' && l.entityId === v);
        const home = lines.reduce((s, l) => s.plus(Money.of(l.homeBalance)), Money.zero()).toFixed(2);
        expect(`${iso(day)} ${home}`).toBe(`${iso(day)} ${await glAsOf('2000', day, -1, v)}`);
      }
    }
    await balanced();
  });

  it('[E3] a same-day re-date at a later time of day is allowed and still ties', async () => {
    const v = await eurVendor('E3');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await updateBill(ctx, bill.id, {
      vendorId: v.id,
      date: new Date('2026-07-05T23:30:00.000Z'),
      exchangeRate: '1.1111',
      lines: [{ accountId: acct['6000'], amount: '40.00' }],
    } as never);
    await expect(
      updateBill(ctx, bill.id, {
        vendorId: v.id,
        date: new Date('2026-07-06T00:00:00.000Z'),
        exchangeRate: '1.1111',
        lines: [{ accountId: acct['6000'], amount: '40.00' }],
      } as never),
    ).rejects.toThrow(/can't be dated after 2026-07-05/);
    await updateVendorCredit(ctx, vc.id, {
      vendorId: v.id,
      date: new Date('2026-07-05T00:00:01.000Z'),
      exchangeRate: '1.2345',
      lines: [{ accountId: acct['6000'], amount: '100.00' }],
    } as never);
    // Reports run to the end of the day (the UI only sends days), so check at end of day.
    const eod = days('2026-07-03', '2026-07-12').map((x) => new Date(`${iso(x)}T23:59:59.999Z`));
    expect(await apMismatches([...eod, FAR], [v.id])).toEqual([]);
    await balanced();
  });

  it('[E4] rate and amount edits on the same date after settled history keep aging == GL', async () => {
    const v = await eurVendor('E4');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await updateBill(ctx, bill.id, { vendorId: v.id, date: d('2026-06-01'), exchangeRate: '1.3001', lines: [{ accountId: acct['6000'], amount: '45.67' }] } as never);
    await updateVendorCredit(ctx, vc.id, { vendorId: v.id, date: d('2026-07-01'), exchangeRate: '1.0001', lines: [{ accountId: acct['6000'], amount: '77.77' }] } as never);
    const [credit] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(credit.unapplied).toBe('77.77');
    expect(credit.homeUnapplied).toBe(Money.round2(Money.of('77.77').times('1.0001')).toFixed(2));
    expect(await apMismatches([...days('2026-05-31', '2026-06-02'), ...days('2026-06-30', '2026-07-12'), FAR], [v.id])).toEqual([]);
    // And the edited documents can be applied again at their new rates.
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '45.67', date: d('2026-07-15') });
    expect(await apMismatches([...days('2026-07-14', '2026-07-16'), FAR], [v.id])).toEqual([]);
    await balanced();
  });

  it('[E5] a foreign credit with a refund is not edited below what was refunded (or still ties)', async () => {
    const v = await eurVendor('E5');
    const vc = await eurCredit(v.id, '100.00');
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '60.00', date: d('2026-07-08'), exchangeRate: '1.20' });
    let refused = false;
    try {
      await updateVendorCredit(ctx, vc.id, { vendorId: v.id, date: d('2026-07-01'), exchangeRate: '1.2345', lines: [{ accountId: acct['6000'], amount: '40.00' }] } as never);
    } catch {
      refused = true;
    }
    const [credit] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(Money.of(credit.unapplied).isNegative()).toBe(false);
    if (!refused) expect(credit.total).toBe('40.00');
    // (The payables subledger before the refund date is covered by [R3].)
    expect(await apMismatches([...days('2026-06-30', '2026-07-09'), FAR], [v.id], false)).toEqual([]);
    await balanced();
  });

  it('[R3] a foreign refund dated later is added back in the payables subledger / HCA before its date', async () => {
    const v = await eurVendor('R3');
    const vc = await eurCredit(v.id, '100.00');
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '60.00', date: d('2026-07-08'), exchangeRate: '1.20' });
    expect(await apMismatches([...days('2026-06-30', '2026-07-09'), FAR], [v.id])).toEqual([]);
    const hca = await previewHomeCurrencyAdjustment(ctx, { date: d('2026-07-05'), rates: { EUR: '1.15' }, updateCurrencyList: false });
    const line = hca.lines.find((l) => l.kind === 'vendor' && l.entityId === v.id);
    expect(line?.foreignBalance).toMatch(/^-?100\.00$/);
    await balanced();
  });

  it('[R2] refund floor: same day earlier in the day is fine; the API refuses an earlier date with a 400 and posts nothing', async () => {
    const v = await eurVendor('R2');
    const vc = await eurCredit(v.id, '50.00', '2026-07-20');
    const res = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '10.00', date: '2026-07-19', exchangeRate: '1.20' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/can't be refunded before it exists/);
    const refunds = () =>
      db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `refund:${vc.id}`)));
    expect(await refunds()).toEqual([]);
    const ok = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '10.00', date: '2026-07-20T00:00:00.000Z', exchangeRate: '1.20' });
    expect(ok.status).toBe(200);
    const posted = await refunds();
    expect(posted).toHaveLength(1);
    expect(iso(new Date(posted[0].date))).toBe('2026-07-20');
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '0.01', date: d('2026-07-21'), exchangeRate: '0.0001' }).catch(
      () => undefined,
    );
    expect(await apMismatches([...days('2026-07-18', '2026-07-22'), FAR], [v.id])).toEqual([]);
    await balanced();
  });

  it('[API2] more unreadable dates are 400s; a leap day and an empty date work; PATCH re-date after history is a 400', async () => {
    const v = await eurVendor('API2');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    for (const date of [true, [], '2026-02-29', '2026-07-05T25:00:00', '2026-00-10']) {
      const res = await post(vc.id, { action: 'apply', billId: bill.id, amount: '1.00', date });
      expect(`${JSON.stringify(date)} ${res.status}`).toBe(`${JSON.stringify(date)} 400`);
      expect((await res.json()).error).toMatch(/valid date/);
    }
    // Trailing junk must not be read leniently: JS parses '2026-07-15junk' as 2026-06-07 ("jun").
    const junk = await post(vc.id, { action: 'apply', billId: bill.id, amount: '1.00', date: '2026-07-15junk' });
    expect(`junk ${junk.status}`).toBe('junk 400');
    expect((await junk.json()).error).toMatch(/valid date/);
    const [unchanged] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(unchanged.unapplied).toBe('100.00');
    const leap = await post(vc.id, { action: 'apply', billId: bill.id, amount: '1.00', date: '2028-02-29' });
    expect(leap.status).toBe(200);
    const blank = await post(vc.id, { action: 'apply', billId: bill.id, amount: '1.00', date: '' });
    expect(blank.status).toBe(200);
    const un = await post(vc.id, { action: 'unapply', billId: bill.id, amount: '2.00', date: '2028-03-01' });
    expect(un.status).toBe(200);
    const patch = await vcPATCH(
      req('PATCH', vc.id, { vendorId: v.id, date: '2028-03-05', exchangeRate: '1.2345', lines: [{ accountId: acct['6000'], amount: '100.00' }] }),
      { params: Promise.resolve({ id: vc.id }) },
    );
    expect(patch.status).toBe(400);
    expect(JSON.stringify(await patch.json())).toMatch(/can't be dated after/);
    // Void through the API: the settled history goes with it and A/P still ties.
    const del = await vcDELETE(req('DELETE', vc.id, {}), { params: Promise.resolve({ id: vc.id }) });
    expect(del.status).toBe(200);
    expect(await appsFor({ vendorCreditId: vc.id })).toEqual([]);
    expect(await apMismatches([...days('2026-06-30', '2026-07-02'), new Date(), d('2028-02-29'), d('2028-03-01'), FAR], [v.id])).toEqual([]);
    expect(API_ROUTE_PERMISSIONS['/api/vendor-credits/[id]']).toBeTruthy();
    expect(JSON.stringify(API_ROUTE_PERMISSIONS['/api/vendor-credits/[id]'])).toMatch(/modify/);
    await balanced();
  });

  it('[ISO] another company cannot void, clear or post against these documents', async () => {
    const v = await eurVendor('ISO');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    const mine = ctx;
    const other = await createCompany(db, { name: `FX RT8 Other ${seq}`, ownerId: userId });
    const octx: ServiceContext = { db, companyId: other.id, userId };
    await expect(voidBill(octx, bill.id)).rejects.toThrow();
    await expect(voidVendorCredit(octx, vc.id)).rejects.toThrow();
    await clearSettledForeignApplications(octx, { billId: bill.id });
    await clearSettledForeignApplications(octx, { vendorCreditId: vc.id });
    expect(await appsFor({ billId: bill.id })).toHaveLength(2);
    ctx = octx;
    const res = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '1.00', date: '2026-07-20' });
    expect(res.status).toBe(404);
    ctx = mine;
    expect(await apMismatches([...days('2026-07-04', '2026-07-11'), FAR], [v.id])).toEqual([]);
    await balanced();
  });

  it('[M2] legacy home memo (same customer, partly applied): foreign open == balance due; aging, per-customer rows and HCA tie to GL', async () => {
    const c = await createCustomer(ctx, { displayName: 'M2', currency: 'EUR' } as never);
    const inv1 = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-05-01'),
      currency: 'EUR',
      exchangeRate: '1.1033',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.01' }],
    } as never);
    const inv2 = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-05-04'),
      currency: 'EUR',
      exchangeRate: '1.0911',
      lines: [{ accountId: acct['4000'], quantity: 3, rate: '33.33' }],
    } as never);
    // A home memo (credit memos have no currency) for the same customer, applied before the guard existed.
    const memo = await createCreditMemo(ctx, {
      customerId: c.id,
      date: d('2026-05-02'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '10.00' }],
    } as never);
    await db.insert(creditApplications).values({ companyId: ctx.companyId, creditMemoId: memo.id, invoiceId: inv1.id, amount: '4.00', date: d('2026-05-03') });
    await markPaidAmount(ctx, inv1.id, '4.00');
    await db.update(creditMemos).set({ unapplied: '6.00', status: 'partial' as never }).where(eq(creditMemos.id, memo.id));
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv1.id));
    expect(row.balanceDue).toBe('96.01');

    for (const day of [d('2026-05-01'), d('2026-05-02'), d('2026-05-03'), d('2026-05-04'), d('2026-06-30'), FAR]) {
      const ar = await glAsOf('1200', day, 1);
      const report = await arAging(ctx, day);
      expect(`${iso(day)} aging ${Money.of(report.totals.total).toFixed(2)}`).toBe(`${iso(day)} aging ${ar}`);
      const custRow = report.rows.find((r) => r.id === c.id);
      expect(`${iso(day)} customer ${Money.of(custRow?.total ?? 0).toFixed(2)}`).toBe(`${iso(day)} customer ${await glAsOf('1200', day, 1, c.id)}`);
      const detail = await arAgingDetail(ctx, day);
      expect(`${iso(day)} detail ${Money.of(detail.total).toFixed(2)}`).toBe(`${iso(day)} detail ${ar}`);
      const items = await foreignOpenReceivables(ctx, day);
      const i1 = items.find((i) => i.id === inv1.id);
      expect(i1?.foreignOpen.toFixed(2)).toBe(day >= d('2026-05-03') ? '96.01' : '100.01');
      const hca = await previewHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.20' }, updateCurrencyList: false });
      const lines = hca.lines.filter((l) => l.kind === 'customer' && l.entityId === c.id);
      const foreign = lines.reduce((s, l) => s.plus(Money.of(l.foreignBalance)), Money.zero());
      const expectedForeign = (day >= d('2026-05-03') ? Money.of('96.01') : Money.of('100.01')).plus(day >= d('2026-05-04') ? Money.of('99.99') : Money.zero());
      expect(`${iso(day)} hca foreign ${foreign.toFixed(2)}`).toBe(`${iso(day)} hca foreign ${expectedForeign.toFixed(2)}`);
    }
    await balanced();
  });
});
