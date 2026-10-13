/**
 * P1 round, team FX — fix round 9 regressions.
 *
 *  [R3b] The foreign payables subledger (Home Currency Adjustment source) adds back vendor-credit
 *        refunds dated after the as-of date, from the same dated-refund source as the A/P aging:
 *        several refunds and an application interleaved, per-credit foreign / home open checked
 *        on each day, subledger == aging == GL A/P, HCA revalues the right foreign amount.
 *        A home credit refunded later still ties in the aging (shared helper, home branch).
 *  [API3] the vendor-credit route only accepts a calendar date (optionally with a time / zone):
 *        trailing junk and loose formats are 400s and change nothing; strict forms still work.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users, vendorCreditApplications, vendorCredits } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { upsertCurrency, setBaseCurrency, setAccountCurrency } from './currencies';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { createVendorCredit, applyToBill, refundVendorCredit } from './vendorCredits';
import { vendorCreditRefundsAfter } from './vendorCreditsFx';
import { apAging, apAgingDetail } from './reportsExtra';
import { foreignOpenPayables } from './fxSubledger';
import { previewHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { Money } from '@/lib/money';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as vcPOST } from '@/app/api/vendor-credits/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix9');
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

async function apGl(asOf: Date): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntryLines.accountId, acct['2000']),
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.date, asOf),
        eq(journalEntries.companyId, ctx.companyId),
      ),
    );
  return Money.of(row.c).minus(Money.of(row.d)).toFixed(2);
}
async function apMismatches(dates: Date[], withSubledger = true): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const ap = await apGl(day);
    const aging = Money.of((await apAging(ctx, day)).totals.total).toFixed(2);
    const detail = Money.of((await apAgingDetail(ctx, day)).total).toFixed(2);
    const sub = !withSubledger ? ap : (await foreignOpenPayables(ctx, day)).reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2);
    if (aging !== ap || detail !== ap || sub !== ap) out.push(`${iso(day)}: A/P ${ap} aging ${aging} detail ${detail} subledger ${sub}`);
  }
  return out;
}
async function creditOpen(id: string, asOf: Date) {
  const item = (await foreignOpenPayables(ctx, asOf)).find((i) => i.kind === 'vendor_credit' && i.id === id);
  return item ? `${item.foreignOpen.toFixed(2)} / ${item.homeOpen.toFixed(2)}` : 'none';
}
const eurVendor = (name: string) => createVendor(ctx, { displayName: name, currency: 'EUR' });
const eurBill = (vendorId: string, amount: string, date = '2026-06-01', rate = '1.1111') =>
  createBill(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
const eurCredit = (vendorId: string, amount: string, date = '2026-07-01', rate = '1.2345') =>
  createVendorCredit(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
const post = (id: string, body: unknown) =>
  vcPOST(
    new Request(`http://localhost/api/vendor-credits/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );

describe('P1 FX — fix round 9', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-fix9@test.local', name: 'FX F9', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `FX F9 Co ${seq}`, ownerId: userId });
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

  it('[R3b] later-dated refunds are added back in the payables subledger per credit, interleaved with an application', async () => {
    const v = await eurVendor('R3b');
    const bill = await eurBill(v.id, '20.00', '2026-06-01', '1.1111');
    const vc = await eurCredit(v.id, '100.00');
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '60.00', date: d('2026-07-08'), exchangeRate: '1.20' });
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '20.00', date: d('2026-07-10') });
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '15.00', date: d('2026-07-15'), exchangeRate: '1.30' });

    // Foreign / home open of the credit (negative: a credit), day by day.
    expect(await creditOpen(vc.id, d('2026-07-05'))).toBe('-100.00 / -123.45');
    expect(await creditOpen(vc.id, d('2026-07-09'))).toBe('-40.00 / -49.38');
    expect(await creditOpen(vc.id, d('2026-07-12'))).toBe('-20.00 / -24.69');
    expect(await creditOpen(vc.id, d('2026-07-20'))).toBe('-5.00 / -6.17');

    // The shared dated-refund source: only refunds strictly after the cutoff, both currencies.
    const after = await vendorCreditRefundsAfter(ctx, d('2026-07-09'));
    expect(after.get(vc.id)?.foreign.toFixed(2)).toBe('15.00');
    expect(after.get(vc.id)?.home.toFixed(2)).toBe('18.52');
    expect((await vendorCreditRefundsAfter(ctx, d('2026-07-20'))).size).toBe(0);

    expect(await apMismatches([...days('2026-05-31', '2026-06-02'), ...days('2026-06-30', '2026-07-17'), FAR])).toEqual([]);

    for (const [day, expected] of [
      ['2026-07-05', '80.00'], // vendor net: credit -100 + bill 20
      ['2026-07-09', '20.00'], // credit -40 + bill 20
      ['2026-07-12', '20.00'], // credit -20, bill fully credited
    ] as const) {
      const hca = await previewHomeCurrencyAdjustment(ctx, { date: d(day), rates: { EUR: '1.15' }, updateCurrencyList: false });
      const line = hca.lines.find((l) => l.kind === 'vendor' && l.entityId === v.id);
      expect(`${day} ${Money.of(line?.foreignBalance ?? '0').abs().toFixed(2)}`).toBe(`${day} ${expected}`);
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('[R3b] a home-currency credit refunded later still ties in the aging (shared helper, home branch)', async () => {
    const v = await createVendor(ctx, { displayName: 'Home Vendor' });
    const vc = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-07-01'), lines: [{ accountId: acct['6000'], amount: '80.00' }] } as never);
    await refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1000'], amount: '30.00', date: d('2026-07-08') });
    const after = await vendorCreditRefundsAfter(ctx, d('2026-07-05'));
    expect(after.get(vc.id)?.foreign.toFixed(2)).toBe('30.00');
    expect(after.get(vc.id)?.home.toFixed(2)).toBe('30.00');
    expect(await apMismatches([...days('2026-06-30', '2026-07-09'), FAR], false)).toEqual([]);
    // A home credit is not in the foreign subledger.
    expect((await foreignOpenPayables(ctx, d('2026-07-05'))).find((i) => i.id === vc.id)).toBeUndefined();
  });

  it('[API3] only a strict calendar date (optionally with a time / zone) is accepted', async () => {
    const v = await eurVendor('API3');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    for (const date of ['2026-07-15junk', '2026-07-15 junk', '2026-07-15T10:00junk', '2026-07-15T10', 'July 15, 2026', '07/15/2026', '2026-7-15', '   ']) {
      const res = await post(vc.id, { action: 'apply', billId: bill.id, amount: '1.00', date });
      expect(`${date} ${res.status}`).toBe(`${date} 400`);
      expect((await res.json()).error).toMatch(/valid date/);
    }
    const [unchanged] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(unchanged.unapplied).toBe('100.00');
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id))).toEqual([]);

    for (const [date, day] of [
      [' 2026-07-15 ', '2026-07-15'],
      ['2026-07-16T10:00', '2026-07-16'],
      ['2026-07-17T10:00:00.000Z', '2026-07-17'],
      ['2026-07-18T10:00:00+02:00', '2026-07-18'],
    ] as const) {
      const res = await post(vc.id, { action: 'apply', billId: bill.id, amount: '1.00', date });
      expect(`${date} ${res.status}`).toBe(`${date} 200`);
      const rows = await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id));
      expect(rows.map((r) => iso(new Date(r.date)))).toContain(day);
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
