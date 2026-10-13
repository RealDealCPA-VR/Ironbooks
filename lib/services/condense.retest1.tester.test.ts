/**
 * P1 controls — re-test round 1 (independent tester): condense keeps General Journal entries whose
 * applications point at a document it is not condensing (fix d24a8b8).
 *
 *  - A/P mirror of the reviewer's A/R case: a GJ A/P bill dated before the cutoff, paid by a bill
 *    payment dated after it. Condense must keep the GJ entry and its application, so voiding the
 *    bill payment later still ties A/P control == A/P aging.
 *  - No over-protection: a GJ charge AND the payment that closed it, both before the cutoff, are
 *    condensed away; A/R still ties, the TB still balances and every account balance is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, journalItemApplications, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createVendor } from './vendors';
import { apAging, arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createManualEntry } from './journal';
import { receivePayment } from './payments';
import { payBills, voidBillPayment } from './billPayments';
import { condensePeriod } from './condense';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense-retest1');
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2026-12-31T23:59:59Z');
let open: string[] = [];

async function fresh(label: string) {
  const dir = path.join(ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  const db: DB = await getDb(dir);
  open.push(dir);
  const [user] = await db.insert(users).values({ email: `${label}@test.local`, name: 'T', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: `${label} Co`, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  return { dir, db, ctx, code };
}

async function control(ctx: ServiceContext, db: DB, subtype: string, sign: 1 | -1) {
  const tb = await trialBalance(ctx, AS_OF);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += sign * (Number(r.debit) - Number(r.credit));
  return Math.round(total * 100) / 100;
}

function byAccount(rows: Array<{ accountId: string; debit: string; credit: string }>) {
  const m: Record<string, string> = {};
  for (const r of rows) {
    const v = Math.round((Number(r.debit) - Number(r.credit)) * 100) / 100;
    if (v !== 0) m[r.accountId] = v.toFixed(2);
  }
  return m;
}

afterEach(async () => {
  for (const dir of open) await closeDb(dir);
  open = [];
});

describe('condense — applications crossing the cutoff (re-test)', () => {
  it('A/P: a GJ bill paid by a bill payment after the cutoff survives; voiding the payment still ties A/P to aging', async () => {
    const { dir, db, ctx, code } = await fresh('ap');
    const vendorId = (await createVendor(ctx, { displayName: 'Later Paid Vendor' } as never)).id;
    await createManualEntry(ctx, {
      date: D('2026-01-02'),
      description: 'Opening cash',
      lines: [
        { accountId: code['1000'], debit: '1000.00' },
        { accountId: code['3900'], credit: '1000.00' },
      ],
    });
    const gjBill = await createManualEntry(ctx, {
      date: D('2026-01-06'),
      description: 'Freight owed',
      lines: [
        { accountId: code['6300'], debit: '55.55' },
        { accountId: code['2000'], credit: '55.55', entityType: 'vendor', entityId: vendorId },
      ],
    });
    const [apLine] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, gjBill.id), eq(journalEntryLines.accountId, code['2000'])));
    const pay = await payBills(ctx, {
      vendorId,
      date: D('2026-02-12'),
      method: 'check',
      paymentAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: apLine.id, amount: '55.55' }],
    } as never);
    expect(await control(ctx, db, 'accounts_payable', -1)).toBeCloseTo(0, 2);

    await createManualEntry(ctx, {
      date: D('2026-01-15'),
      description: 'Cash sale',
      lines: [
        { accountId: code['1000'], debit: '10.00' },
        { accountId: code['4000'], credit: '10.00' },
      ],
    });
    await setClosingDate(ctx, { closingDate: '2026-01-31' } as never);
    const tbBefore = byAccount((await trialBalance(ctx, AS_OF)).rows);
    await condensePeriod(ctx, { beforeDate: new Date('2026-02-01T00:00:00Z'), dataDir: dir });
    expect((await db.select().from(journalEntries).where(eq(journalEntries.id, gjBill.id))).length).toBe(1);
    expect(
      (await db.select().from(journalItemApplications).where(eq(journalItemApplications.journalEntryId, gjBill.id))).length,
    ).toBeGreaterThan(0);
    expect(byAccount((await trialBalance(ctx, AS_OF)).rows)).toEqual(tbBefore);

    await voidBillPayment(ctx, pay.id);
    const ap = await control(ctx, db, 'accounts_payable', -1);
    expect(ap).toBeCloseTo(55.55, 2);
    expect(Number((await apAging(ctx, AS_OF)).totals.total)).toBeCloseTo(ap, 2);
    expect((await trialBalance(ctx, AS_OF)).balanced).toBe(true);
  });

  it('a GJ charge and the payment that closed it, both before the cutoff, are condensed; balances unchanged and A/R ties', async () => {
    const { dir, db, ctx, code } = await fresh('ar-both');
    const customerId = (await createCustomer(ctx, { displayName: 'Early Payer' })).id;
    const charge = await createManualEntry(ctx, {
      date: D('2026-01-05'),
      description: 'Rebill',
      lines: [
        { accountId: code['1200'], debit: '40.00', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '40.00' },
      ],
    });
    const [line] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, charge.id), eq(journalEntryLines.accountId, code['1200'])));
    await receivePayment(ctx, {
      customerId,
      date: D('2026-01-20'),
      method: 'check',
      amount: '40.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: line.id, amount: '40.00' }],
    } as never);
    await setClosingDate(ctx, { closingDate: '2026-01-31' } as never);
    const tbBefore = byAccount((await trialBalance(ctx, AS_OF)).rows);

    await condensePeriod(ctx, { beforeDate: new Date('2026-02-01T00:00:00Z'), dataDir: dir });
    // Fully closed before the cutoff: nothing links it to a kept transaction, so it is condensed.
    expect((await db.select().from(journalEntries).where(eq(journalEntries.id, charge.id))).length).toBe(0);
    const tb = await trialBalance(ctx, AS_OF);
    expect(tb.balanced).toBe(true);
    expect(byAccount(tb.rows)).toEqual(tbBefore);
    const ar = await control(ctx, db, 'accounts_receivable', 1);
    expect(ar).toBeCloseTo(0, 2);
    expect(Number((await arAging(ctx, AS_OF)).totals.total)).toBeCloseTo(ar, 2);
    const owed = (await customerBalanceSummary(ctx)).reduce((s, r) => s + Number(r.totalBalanceDue), 0);
    expect(owed).toBeCloseTo(ar, 2);
  });
});
