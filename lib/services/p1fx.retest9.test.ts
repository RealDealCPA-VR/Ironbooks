/**
 * P1 round, team FX — tester re-test 9 (adversarial checks of fix round 9).
 *
 *  [R3c] payables subledger / HCA with later-dated refunds: two credits for one vendor plus a GBP
 *        vendor, refunds at different rates interleaved with an application on the same day,
 *        credits fully used by a final refund; A/P control == aging == detail == subledger and per
 *        vendor name balances as of every day; HCA foreign / home per vendor == subledger.
 *  [R3d] HCA posted before a later refund, refund recorded afterwards, then the HCA voided: still ties.
 *  [R3e] penny rounding: a tiny credit refunded a cent at a time leaves no residual.
 *  [R3f] instant boundaries: a refund dated at midnight UTC vs as-of 1 ms before / at the instant.
 *  [R3g] company isolation of the shared dated-refund helper.
 *  [HCA2] on the date of a posted HCA the payables / receivables subledger (HCA source) ignores the
 *        revaluation already posted, so it disagrees with GL A/P / A/R and a second HCA for the same
 *        date and rates revalues the same balances again (double unrealized gain/loss).
 *  [API4] more strict-date checks on refund / unapply (junk refused, nothing changes); permissions.
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
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createVendorCredit, applyToBill, refundVendorCredit } from './vendorCredits';
import { vendorCreditRefundsAfter } from './vendorCreditsFx';
import { apAging, apAgingDetail } from './reportsExtra';
import { foreignOpenPayables, foreignOpenReceivables } from './fxSubledger';
import { previewHomeCurrencyAdjustment, createHomeCurrencyAdjustment, voidHomeCurrencyAdjustment } from './homeCurrencyAdjustment';
import { vendorBalanceSummary } from './reportsLists';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import { Money } from '@/lib/money';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as vcPOST } from '@/app/api/vendor-credits/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-retest9');
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
async function vendorName(id: string, asOf: Date): Promise<string> {
  const rep = await vendorBalanceSummary(ctx, { asOf: iso(asOf) } as never);
  const row = rep.rows.find((r) => r.id === `bal:${id}`);
  return Money.of(String(row?.cells.balance ?? '0')).toFixed(2);
}
async function apMismatches(dates: Date[], vendorIds: string[] = []): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const ap = await apGl(day);
    const report = await apAging(ctx, day);
    const aging = Money.of(report.totals.total).toFixed(2);
    const detail = Money.of((await apAgingDetail(ctx, day)).total).toFixed(2);
    const items = await foreignOpenPayables(ctx, day);
    const sub = items.reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2);
    if (aging !== ap || detail !== ap || sub !== ap) out.push(`${day.toISOString()}: A/P ${ap} aging ${aging} detail ${detail} subledger ${sub}`);
    for (const v of vendorIds) {
      const gl = await vendorName(v, day);
      const row = report.rows.find((r) => r.id === v);
      const got = Money.of(row?.total ?? 0).toFixed(2);
      const subV = items.filter((i) => i.entityId === v).reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2);
      if (got !== gl || subV !== gl) out.push(`${iso(day)} vendor ${v.slice(0, 8)}: name ${gl} aging ${got} subledger ${subV}`);
    }
  }
  return out;
}
async function vendorForeign(vendorId: string, asOf: Date) {
  const items = (await foreignOpenPayables(ctx, asOf)).filter((i) => i.entityId === vendorId);
  return {
    foreign: items.reduce((s, i) => s.plus(i.foreignOpen), Money.zero()).toFixed(2),
    home: items.reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2),
  };
}
async function creditOpen(id: string, asOf: Date) {
  const item = (await foreignOpenPayables(ctx, asOf)).find((i) => i.kind === 'vendor_credit' && i.id === id);
  return item ? `${item.foreignOpen.toFixed(2)} / ${item.homeOpen.toFixed(2)}` : 'none';
}
const fxVendor = (name: string, currency = 'EUR') => createVendor(ctx, { displayName: name, currency });
const fxBill = (vendorId: string, amount: string, date = '2026-06-01', rate = '1.1111') =>
  createBill(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
const fxCredit = (vendorId: string, amount: string, date = '2026-07-01', rate = '1.2345') =>
  createVendorCredit(ctx, { vendorId, date: d(date), exchangeRate: rate, lines: [{ accountId: acct['6000'], amount }] } as never);
const refund = (id: string, bank: string, amount: string, date: Date, rate: string) =>
  refundVendorCredit(ctx, { vendorCreditId: id, bankAccountId: bank, amount, date, exchangeRate: rate });
const post = (id: string, body: unknown) =>
  vcPOST(
    new Request(`http://localhost/api/vendor-credits/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );

async function setupCompany(name: string) {
  const company = await createCompany(db, { name, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
  await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
  await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
  await upsertCurrency(ctx, { code: 'GBP', name: 'Pound', rateToBase: '1.25' });
  acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
  await setAccountCurrency(ctx, acct['1020'], 'EUR');
  acct['1030'] = (await createAccount(ctx, { code: '1030', name: 'Pound Bank', type: 'asset' as never, subtype: 'checking' })).id;
  await setAccountCurrency(ctx, acct['1030'], 'GBP');
  return company;
}

describe('P1 FX — tester re-test 9', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-retest9@test.local', name: 'FX R9', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    await setupCompany(`FX R9 Co ${seq}`);
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('[R3c] two credits + a GBP vendor, interleaved later refunds: control == aging == names == subledger == HCA every day', async () => {
    const v1 = await fxVendor('R3c EUR');
    const v2 = await fxVendor('R3c GBP', 'GBP');
    const bill = await fxBill(v1.id, '70.00');
    const a = await fxCredit(v1.id, '100.00', '2026-07-01', '1.2345');
    const b = await fxCredit(v1.id, '50.00', '2026-07-03', '1.30');
    const g = await fxCredit(v2.id, '80.00', '2026-07-02', '1.27');
    await refund(a.id, acct['1020'], '33.33', d('2026-07-06'), '1.25');
    await applyToBill(ctx, { vendorCreditId: a.id, billId: bill.id, amount: '30.00', date: d('2026-07-06') });
    await refund(b.id, acct['1020'], '50.00', d('2026-07-09'), '1.20');
    await refund(a.id, acct['1020'], '36.67', d('2026-07-12'), '1.10');
    await refund(g.id, acct['1030'], '80.00', d('2026-07-20'), '1.30');

    // Foreign open per vendor (A/P natural sign: bill +, credit -).
    const fx = async (day: string) => (await vendorForeign(v1.id, d(day))).foreign;
    expect(await fx('2026-07-02')).toBe('-30.00');
    expect(await fx('2026-07-04')).toBe('-80.00');
    expect(await fx('2026-07-06')).toBe('-46.67');
    expect(await fx('2026-07-10')).toBe('3.33');
    expect(await fx('2026-07-13')).toBe('40.00');
    expect((await vendorForeign(v2.id, d('2026-07-19'))).foreign).toBe('-80.00');
    expect((await vendorForeign(v2.id, d('2026-07-19'))).home).toBe('-101.60');
    expect((await vendorForeign(v2.id, d('2026-07-20'))).foreign).toBe('0.00');
    // A fully used credit leaves nothing behind (no residual penny); B before / after its refund.
    expect(await creditOpen(a.id, d('2026-07-12'))).toBe('none');
    expect(await creditOpen(b.id, d('2026-07-08'))).toBe('-50.00 / -65.00');
    expect(await creditOpen(b.id, d('2026-07-09'))).toBe('none');

    expect(await apMismatches([...days('2026-06-30', '2026-07-21'), FAR], [v1.id, v2.id])).toEqual([]);

    // HCA source == subledger, per vendor, on several dates (both currencies).
    for (const day of ['2026-07-02', '2026-07-05', '2026-07-08', '2026-07-11', '2026-07-15', '2026-07-19']) {
      const hca = await previewHomeCurrencyAdjustment(ctx, { date: d(day), rates: { EUR: '1.4567', GBP: '1.4567' }, updateCurrencyList: false });
      for (const v of [v1.id, v2.id]) {
        const sub = await vendorForeign(v, d(day));
        const line = hca.lines.find((l) => l.kind === 'vendor' && l.entityId === v);
        const got = line ? `${Money.of(line.foreignBalance).abs().toFixed(2)} ${Money.of(line.homeBalance).abs().toFixed(2)}` : '0.00 0.00';
        expect(`${day} ${got}`).toBe(`${day} ${Money.of(sub.foreign).abs().toFixed(2)} ${Money.of(sub.home).abs().toFixed(2)}`);
      }
    }
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('[R3d] HCA posted before a later refund, refund recorded afterwards, HCA voided: everything still ties', async () => {
    const v = await fxVendor('R3d');
    const vc = await fxCredit(v.id, '100.00');
    const hca = await createHomeCurrencyAdjustment(ctx, { date: d('2026-07-05'), rates: { EUR: '1.15' }, updateCurrencyList: false });
    const line = hca.preview.lines.find((l) => l.kind === 'vendor' && l.entityId === v.id);
    expect(Money.of(line!.foreignBalance).abs().toFixed(2)).toBe('100.00');
    expect(Money.of(line!.homeBalance).abs().toFixed(2)).toBe('123.45');
    await refund(vc.id, acct['1020'], '60.00', d('2026-07-08'), '1.20');
    expect(await creditOpen(vc.id, d('2026-07-07'))).toBe('-100.00 / -123.45');
    expect(await creditOpen(vc.id, d('2026-07-08'))).toBe('-40.00 / -49.38');
    // (The HCA date itself is covered by [HCA2] below.)
    expect(await apMismatches([d('2026-07-04'), ...days('2026-07-06', '2026-07-09'), FAR], [v.id])).toEqual([]);
    await voidHomeCurrencyAdjustment(ctx, hca.id);
    expect(await apMismatches([...days('2026-07-04', '2026-07-09'), FAR], [v.id])).toEqual([]);
    // A fresh HCA on 07-05 after the refund was recorded still revalues the full EUR 100.
    const again = await previewHomeCurrencyAdjustment(ctx, { date: d('2026-07-05'), rates: { EUR: '1.15' }, updateCurrencyList: false });
    const l2 = again.lines.find((l) => l.kind === 'vendor' && l.entityId === v.id);
    expect(Money.of(l2!.foreignBalance).abs().toFixed(2)).toBe('100.00');
    expect(Money.of(l2!.adjustment).abs().toFixed(2)).toBe('8.45');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('[HCA2] a second HCA for the same date and rates finds nothing to adjust; subledger == GL on the HCA date', async () => {
    const v = await fxVendor('HCA2 V');
    await fxCredit(v.id, '100.00');
    await fxBill(v.id, '300.00', '2026-06-01', '1.1111');
    const c = await createCustomer(ctx, { displayName: 'HCA2 C', currency: 'EUR' } as never);
    await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-06-15'),
      currency: 'EUR',
      exchangeRate: '1.05',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '200.00' }],
    } as never);
    const day = d('2026-07-05');
    await createHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.15' }, updateCurrencyList: false });

    const glNet = async (code: string) => {
      const [row] = await db
        .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .where(and(eq(journalEntryLines.accountId, acct[code]), eq(journalEntries.status, 'posted'), lte(journalEntries.date, day), eq(journalEntries.companyId, ctx.companyId)));
      return Money.of(row.d).minus(Money.of(row.c));
    };
    const apSub = (await foreignOpenPayables(ctx, day)).reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2);
    const arSub = (await foreignOpenReceivables(ctx, day)).reduce((s, i) => s.plus(i.homeOpen), Money.zero()).toFixed(2);
    const mism: string[] = [];
    if (apSub !== (await glNet('2000')).negated().toFixed(2)) mism.push(`A/P GL ${(await glNet('2000')).negated().toFixed(2)} subledger ${apSub}`);
    if (arSub !== (await glNet('1200')).toFixed(2)) mism.push(`A/R GL ${(await glNet('1200')).toFixed(2)} subledger ${arSub}`);

    const again = await previewHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.15' }, updateCurrencyList: false });
    const redo = again.lines.filter((l) => l.kind === 'vendor' || l.kind === 'customer').map((l) => `${l.kind} ${l.adjustment}`);
    // Posting it again must not double the revaluation (QB: nothing to adjust).
    let postedAgain = false;
    try {
      await createHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.15' }, updateCurrencyList: false });
      postedAgain = true;
    } catch {
      /* refused: nothing to adjust */
    }
    expect({ mism, redo, postedAgain }).toEqual({ mism: [], redo: [], postedAgain: false });
  });

  it('[HCA3] a customer with invoices in two currencies: each posted HCA line stays in its own currency', async () => {
    const c = await createCustomer(ctx, { displayName: 'HCA3 C' } as never);
    for (const [cur, rate] of [['EUR', '1.10'], ['GBP', '1.25']] as const) {
      await createInvoice(ctx, {
        customerId: c.id,
        date: d('2026-06-15'),
        currency: cur,
        exchangeRate: rate,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }],
      } as never);
    }
    const day = d('2026-07-05');
    await createHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.20', GBP: '1.40' }, updateCurrencyList: false });
    const hca = (await foreignOpenReceivables(ctx, day))
      .filter((i) => i.kind === 'hca')
      .map((i) => `${i.currency} ${i.homeOpen.toFixed(2)}`)
      .sort();
    expect(hca).toEqual(['EUR 10.00', 'GBP 15.00']);
    const again = await previewHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.20', GBP: '1.40' }, updateCurrencyList: false });
    expect(again.lines.filter((l) => l.kind === 'customer')).toEqual([]);
    // A later rate change on the same date adjusts each currency by its own delta only.
    const delta = await previewHomeCurrencyAdjustment(ctx, { date: day, rates: { EUR: '1.25', GBP: '1.40' }, updateCurrencyList: false });
    expect(delta.lines.filter((l) => l.kind === 'customer').map((l) => `${l.currency} ${l.adjustment}`)).toEqual(['EUR 5.00']);
  });

  it('[R3e] a tiny credit refunded a cent at a time at odd rates leaves no residual and ties each day', async () => {
    const v = await fxVendor('R3e');
    const vc = await fxCredit(v.id, '0.03', '2026-07-01', '1.555');
    await refund(vc.id, acct['1020'], '0.01', d('2026-07-02'), '1.333');
    await refund(vc.id, acct['1020'], '0.01', d('2026-07-03'), '1.777');
    await refund(vc.id, acct['1020'], '0.01', d('2026-07-04'), '1.111');
    expect(await creditOpen(vc.id, d('2026-07-01'))).toBe('-0.03 / -0.05');
    expect(await creditOpen(vc.id, d('2026-07-04'))).toBe('none');
    const before = await vendorCreditRefundsAfter(ctx, d('2026-07-01'));
    expect(before.get(vc.id)?.foreign.toFixed(2)).toBe('0.03');
    expect(before.get(vc.id)?.home.toFixed(2)).toBe('0.05');
    expect(await apMismatches([...days('2026-06-30', '2026-07-05'), FAR], [v.id])).toEqual([]);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('[R3f] a refund dated at midnight UTC: as-of 1 ms before keeps it open, as-of the instant does not', async () => {
    const v = await fxVendor('R3f');
    const vc = await fxCredit(v.id, '100.00');
    const res = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '25.00', date: '2026-07-08', exchangeRate: '1.20' });
    expect(res.status).toBe(200);
    const at = new Date('2026-07-08T00:00:00.000Z');
    const justBefore = new Date(at.getTime() - 1);
    expect(await creditOpen(vc.id, justBefore)).toBe('-100.00 / -123.45');
    expect(await creditOpen(vc.id, at)).toBe('-75.00 / -92.59');
    expect(await apMismatches([justBefore, at, d('2026-07-07'), d('2026-07-08')], [v.id])).toEqual([]);
  });

  it('[R3g] the shared dated-refund helper never sees another company', async () => {
    const v = await fxVendor('R3g A');
    const vcA = await fxCredit(v.id, '100.00');
    await refund(vcA.id, acct['1020'], '10.00', d('2026-07-08'), '1.20');
    const ctxA = ctx;
    const acctA = acct;
    await setupCompany(`FX R9 other ${seq}`);
    const w = await fxVendor('R3g B');
    const vcB = await fxCredit(w.id, '200.00');
    await refund(vcB.id, acct['1020'], '90.00', d('2026-07-08'), '1.20');
    const mapB = await vendorCreditRefundsAfter(ctx, d('2026-07-05'));
    expect([...mapB.keys()]).toEqual([vcB.id]);
    expect(await creditOpen(vcB.id, d('2026-07-05'))).toBe('-200.00 / -246.90');
    ctx = ctxA;
    acct = acctA;
    const mapA = await vendorCreditRefundsAfter(ctx, d('2026-07-05'));
    expect([...mapA.keys()]).toEqual([vcA.id]);
    expect(mapA.get(vcA.id)?.foreign.toFixed(2)).toBe('10.00');
    expect(await apMismatches([d('2026-07-05'), d('2026-07-08'), FAR], [v.id])).toEqual([]);
  });

  it('[API4] refund / unapply with junk dates are 400s and change nothing; permissions declared', async () => {
    const v = await fxVendor('API4');
    const bill = await fxBill(v.id, '40.00');
    const vc = await fxCredit(v.id, '100.00');
    const ok = await post(vc.id, { action: 'apply', billId: bill.id, amount: '5.00', date: '2026-07-10' });
    expect(ok.status).toBe(200);
    const bad = ['2026-07-15T10:00:00Zjunk', '2026-13-01', '2026-02-30', '2026-07-15T10:61', '2026-07-15T', '2026-07-15Z', '+02026-07-15', '20260715', 'x2026-07-15'];
    for (const date of bad) {
      const r1 = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '1.00', date, exchangeRate: '1.20' });
      expect(`${date} refund ${r1.status}`).toBe(`${date} refund 400`);
      expect((await r1.json()).error).toMatch(/valid date/);
      const r2 = await post(vc.id, { action: 'unapply', billId: bill.id, amount: '1.00', date });
      expect(`${date} unapply ${r2.status}`).toBe(`${date} unapply 400`);
      expect((await r2.json()).error).toMatch(/valid date/);
    }
    const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(row.unapplied).toBe('95.00');
    expect(row.refundedAmount).toBe('0.00');
    expect((await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id))).length).toBe(1);
    const refunds = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `refund:${vc.id}`)));
    expect(refunds).toEqual([]);
    // A strict form with an offset still works for a refund.
    const good = await post(vc.id, { action: 'refund', bankAccountId: acct['1020'], amount: '1.00', date: '2026-07-16T09:30:00-04:00', exchangeRate: '1.20' });
    expect(good.status).toBe(200);
    expect(JSON.stringify(API_ROUTE_PERMISSIONS['/api/vendor-credits/[id]'])).toMatch(/modify/);
    // (The name balance is day-granular, so check the day after the 13:30Z refund.)
    expect(await apMismatches([d('2026-07-09'), d('2026-07-10'), d('2026-07-17'), FAR], [v.id])).toEqual([]);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
