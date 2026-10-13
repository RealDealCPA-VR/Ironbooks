/**
 * P1 round, team FX — fix round 8 regression tests (reviewer / tester re-test 7).
 *
 *  [R1]   a vendor refund can't be dated before its credit (foreign and home); no date on a credit
 *         dated in the future takes the credit's date.
 *  [V1]   voiding a bill whose foreign credit was applied and unapplied again voids the apply /
 *         unapply exchange entries and drops the settled rows; aging == GL every day.
 *  [V2]   the same for voiding the credit; a credit that is still applied is still refused.
 *  [E1]   a bill can't be moved after its dated foreign application; an earlier date is fine.
 *  [E2]   a credit can't be moved after its dated application or (home too) its refund.
 *  [API]  unreadable dates are a 400 on apply / unapply / refund.
 *  [M1]   legacy home credit memo on a foreign invoice: the foreign open amount (HCA, aging detail
 *         foreign column) equals the invoice's balance due; A/R aging still ties to GL.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { and, eq, lte, sql } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
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
import { createCompany } from './company';
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
import { createInvoice, markPaidAmount } from './invoices';
import { createCreditMemo } from './creditMemos';
import { apAging, apAgingDetail, arAging, arAgingDetail } from './reportsExtra';
import { foreignOpenReceivables } from './fxSubledger';
import { Money } from '@/lib/money';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as vcPOST } from '@/app/api/vendor-credits/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-p1-fx-fix8');
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

async function glAsOf(code: string, asOf: Date, sign: 1 | -1): Promise<string> {
  const [row] = await db
    .select({ d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`, c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)` })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.accountId, acct[code]), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)));
  const net = Money.of(row.d).minus(Money.of(row.c));
  return (sign === 1 ? net : net.negated()).toFixed(2);
}
async function apMismatches(dates: Date[]): Promise<string[]> {
  const out: string[] = [];
  for (const day of dates) {
    const ap = await glAsOf('2000', day, -1);
    const aging = Money.of((await apAging(ctx, day)).totals.total).toFixed(2);
    const detail = Money.of((await apAgingDetail(ctx, day)).total).toFixed(2);
    if (aging !== ap || detail !== ap) out.push(`${iso(day)}: A/P ${ap} aging ${aging} detail ${detail}`);
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
const homeCredit = (vendorId: string, amount: string, date = '2026-07-01') =>
  createVendorCredit(ctx, { vendorId, date: d(date), lines: [{ accountId: acct['6000'], amount }] } as never);
async function fxEntryStatuses(ids: (string | null)[]) {
  const out: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    const [e] = await db.select().from(journalEntries).where(eq(journalEntries.id, id));
    out.push(e.status);
  }
  return out;
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

describe('P1 FX — fix round 8', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'p1fx-fix8@test.local', name: 'FX F8', passwordHash: 'x' }).returning();
    userId = u.id;
  });
  beforeEach(async () => {
    seq += 1;
    const company = await createCompany(db, { name: `FX F8 Co ${seq}`, ownerId: userId });
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

  it('[R1] a refund dated before its credit is refused (foreign and home); nothing is saved', async () => {
    const v = await eurVendor('R1 EUR');
    const vc = await eurCredit(v.id, '50.00', '2026-07-20');
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: vc.id, bankAccountId: acct['1020'], amount: '20.00', date: d('2026-07-05'), exchangeRate: '1.20' }),
    ).rejects.toThrow(/can't be refunded before it exists.*2026-07-20/);
    const hv = await createVendor(ctx, { displayName: 'R1 Home' });
    const hc = await homeCredit(hv.id, '50.00', '2026-07-20');
    await expect(
      refundVendorCredit(ctx, { vendorCreditId: hc.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-07-19') }),
    ).rejects.toThrow(/can't be refunded before it exists/);
    for (const id of [vc.id, hc.id]) {
      const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, id));
      expect(row.unapplied).toBe('50.00');
    }
    // Same day works.
    await refundVendorCredit(ctx, { vendorCreditId: hc.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-07-20') });
    // No date on a credit dated in the future: the refund takes the credit's date, not today.
    const future = await homeCredit(hv.id, '10.00', '2099-01-15');
    const res = await refundVendorCredit(ctx, { vendorCreditId: future.id, bankAccountId: acct['1000'], amount: '10.00' });
    expect(iso(new Date(res.entry.date))).toBe('2099-01-15');
    expect(await apMismatches([...days('2026-07-01', '2026-07-31'), FAR])).toEqual([]);
    await balanced();
  });

  it('[V1] voiding the bill after a foreign apply / unapply voids the exchange entries and drops the settled rows', async () => {
    const v = await eurVendor('V1');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    const rows = await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.billId, bill.id));
    expect(rows).toHaveLength(2);
    expect(await fxEntryStatuses(rows.map((r) => r.fxEntryId))).toEqual(['posted', 'posted']);
    await voidBill(ctx, bill.id);
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.billId, bill.id))).toEqual([]);
    expect(await fxEntryStatuses(rows.map((r) => r.fxEntryId))).toEqual(['void', 'void']);
    const [credit] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(credit.unapplied).toBe('100.00');
    expect(credit.homeUnapplied).toBe('123.45');
    expect(await apMismatches([...days('2026-06-01', '2026-06-02'), ...days('2026-07-01', '2026-07-31'), FAR])).toEqual([]);
    await balanced();
  });

  it('[V2] voiding the credit after a foreign apply / unapply ties every day; a still-applied credit is refused', async () => {
    const v = await eurVendor('V2');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await expect(voidVendorCredit(ctx, vc.id)).rejects.toThrow(/applied/);
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await voidVendorCredit(ctx, vc.id);
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.vendorCreditId, vc.id))).toEqual([]);
    expect(await apMismatches([...days('2026-07-01', '2026-07-31'), FAR])).toEqual([]);
    // The bill is still open for its full amount and can take another credit.
    const c2 = await eurCredit(v.id, '40.00', '2026-08-01', '1.05');
    await applyToBill(ctx, { vendorCreditId: c2.id, billId: bill.id, amount: '40.00', date: d('2026-08-02') });
    expect(await apMismatches([...days('2026-07-30', '2026-08-03'), FAR])).toEqual([]);
    await balanced();
  });

  it("[E1] a bill can't be moved after its dated foreign application; an earlier date is allowed", async () => {
    const v = await eurVendor('E1');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    const edit = (date: string) =>
      updateBill(ctx, bill.id, { vendorId: v.id, date: d(date), exchangeRate: '1.1111', lines: [{ accountId: acct['6000'], amount: '40.00' }] } as never);
    await expect(edit('2026-07-20')).rejects.toThrow(/can't be dated after 2026-07-05/);
    await expect(edit('2026-07-06')).rejects.toThrow(/can't be dated after 2026-07-05/);
    await edit('2026-07-05');
    await edit('2026-05-15');
    expect(await apMismatches([...days('2026-05-14', '2026-05-16'), ...days('2026-07-01', '2026-07-31'), FAR])).toEqual([]);
    await balanced();
  });

  it("[E2] a credit can't be moved after its dated application, nor (home credits too) after its refund", async () => {
    const v = await eurVendor('E2');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-05') });
    await unapplyFromBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '40.00', date: d('2026-07-10') });
    await expect(
      updateVendorCredit(ctx, vc.id, { vendorId: v.id, date: d('2026-07-20'), exchangeRate: '1.2345', lines: [{ accountId: acct['6000'], amount: '100.00' }] } as never),
    ).rejects.toThrow(/can't be dated after 2026-07-05/);
    const hv = await createVendor(ctx, { displayName: 'E2 Home' });
    const hc = await homeCredit(hv.id, '50.00', '2026-07-01');
    await refundVendorCredit(ctx, { vendorCreditId: hc.id, bankAccountId: acct['1000'], amount: '20.00', date: d('2026-07-08') });
    await expect(
      updateVendorCredit(ctx, hc.id, { vendorId: hv.id, date: d('2026-07-09'), lines: [{ accountId: acct['6000'], amount: '50.00' }] } as never),
    ).rejects.toThrow(/vendor refund was recorded/);
    expect(await apMismatches([...days('2026-06-30', '2026-07-31'), FAR])).toEqual([]);
    await balanced();
  });

  it('[API] unreadable dates are a 400 with a plain message; a good date still works', async () => {
    const v = await eurVendor('API');
    const bill = await eurBill(v.id, '40.00');
    const vc = await eurCredit(v.id, '100.00');
    for (const body of [
      { action: 'apply', billId: bill.id, amount: '10.00', date: 'not-a-date' },
      { action: 'apply', billId: bill.id, amount: '10.00', date: '2026-02-30' },
      { action: 'refund', bankAccountId: acct['1020'], amount: '10.00', date: '2026-13-45' },
      { action: 'unapply', billId: bill.id, amount: '10.00', date: { y: 2026 } },
    ]) {
      const res = await post(vc.id, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/valid date/);
    }
    const ok = await post(vc.id, { action: 'apply', billId: bill.id, amount: '10.00', date: '2026-07-02' });
    expect(ok.status).toBe(200);
    const [row] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, vc.id));
    expect(row.unapplied).toBe('90.00');
  });

  it('[M1] legacy home memo on a foreign invoice: foreign open == balance due; A/R aging == GL', async () => {
    const c = await createCustomer(ctx, { displayName: 'M1', currency: 'EUR' } as never);
    const inv = await createInvoice(ctx, {
      customerId: c.id,
      date: d('2026-05-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00' }],
    } as never);
    const hc = await createCustomer(ctx, { displayName: 'M1 home' } as never);
    const memo = await createCreditMemo(ctx, { customerId: hc.id, date: d('2026-05-02'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '10.00' }] } as never);
    // Written before the guard existed: the subledger rows only (the memo already credited A/R).
    await db.insert(creditApplications).values({ companyId: ctx.companyId, creditMemoId: memo.id, invoiceId: inv.id, amount: '10.00', date: d('2026-05-03') });
    await markPaidAmount(ctx, inv.id, '10.00');
    await db.update(creditMemos).set({ unapplied: '0.00', status: 'paid' as never }).where(eq(creditMemos.id, memo.id));
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('90.00');

    const before = (await foreignOpenReceivables(ctx, d('2026-05-02'))).find((i) => i.id === inv.id)!;
    expect(before.foreignOpen.toFixed(2)).toBe('100.00');
    const after = (await foreignOpenReceivables(ctx, d('2026-05-03'))).find((i) => i.id === inv.id)!;
    expect(after.foreignOpen.toFixed(2)).toBe('90.00');
    expect(after.homeOpen.toFixed(2)).toBe('100.00'); // 110.00 on A/R less the memo's 10.00
    for (const day of [d('2026-05-01'), d('2026-05-02'), d('2026-05-03'), FAR]) {
      const ar = await glAsOf('1200', day, 1);
      expect(Money.of((await arAging(ctx, day)).totals.total).toFixed(2)).toBe(ar);
      const detail = await arAgingDetail(ctx, day);
      expect(Money.of(detail.total).toFixed(2)).toBe(ar);
      const line = detail.rows.find((r) => r.docId === inv.id);
      expect(line?.foreignOpenBalance).toBe(day >= d('2026-05-03') ? '90.00' : '100.00');
    }
    await balanced();
  });
});
