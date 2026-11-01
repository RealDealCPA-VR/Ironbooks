/**
 * Feature round (accountant team) — review-round-5 leftovers of the accountant area. Each test
 * failed before its fix:
 *  L13 Reclassify of a bill credit: vendor_credit_lines keep a class per line (since P1
 *      purchases) and the credit posts each line with it, so reclassifySync must match and update
 *      the line by account AND class. Before, a class-only reclassify was refused ("a bill credit
 *      doesn't keep a class on each line") and an account reclassify of the South line updated the
 *      North row; the next memo-only edit then re-posted the reverse of what the accountant did.
 *  L14 Client Data Review "Save review balances": an impossible date (2026-13-01, 2026-02-31) is a
 *      400, never a 500 (Invalid Date) nor a snapshot stored as "2026-02-31" that rolls to March.
 *  L7  Calendar: void sales orders, purchase orders and estimates are not "entered" transactions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, clientReviewSnapshots, journalEntryLines, users, vendorCreditLines, vendorCredits } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount } from '../accounts';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createVendorCredit, updateVendorCredit } from '../vendorCredits';
import { reclassifyLines } from './reclassify';
import { takeReviewSnapshot } from './clientDataReview';
import { getCalendar } from '../calendar';
import { createSalesOrder, updateStatus as updateSalesOrderStatus } from '../salesOrders';
import { createPurchaseOrder, updateStatus as updatePurchaseOrderStatus } from '../purchaseOrders';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-feature-accountant-leftovers');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'feat-acct@test.local', name: 'Accountant', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Feature Accountant Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  acct.e1 = (await createAccount(ctx, { code: '6810', name: 'F Supplies', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  acct.e2 = (await createAccount(ctx, { code: '6820', name: 'F Repairs', type: 'expense' as never, subtype: 'operating_expenses' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'F Customer' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'F Vendor' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('L13: reclassifying a bill credit line keeps the document in step, class by class', () => {
  it('moves the South row (not the North one) and a later memo-only edit keeps it', async () => {
    const north = await createClass(ctx, { name: 'North' });
    const south = await createClass(ctx, { name: 'South' });
    const credit = await createVendorCredit(ctx, {
      vendorId,
      date: D('2026-04-02'),
      lines: [
        { accountId: acct.e1, amount: '10.00', description: 'Return', classId: north.id },
        { accountId: acct.e1, amount: '10.00', description: 'Return', classId: south.id },
      ],
    });
    const [h] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, credit.id));
    const southLine = (
      await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, h.postedEntryId!))
    ).find((l) => l.classId === south.id && l.accountId === acct.e1)!;
    expect(southLine).toBeTruthy();
    await reclassifyLines(ctx, { lineIds: [southLine.id], newAccountId: acct.e2 });

    const rows = await db.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, credit.id));
    expect(rows.find((r) => r.classId === south.id)?.accountId).toBe(acct.e2);
    expect(rows.find((r) => r.classId === north.id)?.accountId).toBe(acct.e1);

    // A memo-only edit re-sends the rows as they are: South stays on 6820, North on 6810.
    await updateVendorCredit(ctx, credit.id, {
      vendorId,
      date: D('2026-04-02'),
      memo: 'memo only',
      lines: rows
        .sort((a, b) => a.lineOrder - b.lineOrder)
        .map((r) => ({ accountId: r.accountId, amount: r.amount, description: r.description, classId: r.classId })),
    });
    const [after] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, credit.id));
    const posted = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, after.postedEntryId!));
    expect(posted.find((l) => l.classId === south.id && l.credit)?.accountId).toBe(acct.e2);
    expect(posted.find((l) => l.classId === north.id && l.credit)?.accountId).toBe(acct.e1);
  });

  it('a class-only reclassify of a bill credit line is allowed and updates that row', async () => {
    const east = await createClass(ctx, { name: 'East' });
    const west = await createClass(ctx, { name: 'West' });
    const credit = await createVendorCredit(ctx, {
      vendorId,
      date: D('2026-04-03'),
      lines: [{ accountId: acct.e1, amount: '15.00', description: 'Part', classId: east.id }],
    });
    const [h] = await db.select().from(vendorCredits).where(eq(vendorCredits.id, credit.id));
    const line = (await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, h.postedEntryId!))).find(
      (l) => l.accountId === acct.e1,
    )!;
    await reclassifyLines(ctx, { lineIds: [line.id], newClassId: west.id });
    const [row] = await db.select().from(vendorCreditLines).where(eq(vendorCreditLines.vendorCreditId, credit.id));
    expect(row.classId).toBe(west.id);
    const [moved] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.id, line.id));
    expect(moved.classId).toBe(west.id);
  });
});

describe('L14: review snapshots refuse impossible dates', () => {
  for (const bad of ['2026-13-01', '2026-02-31', '2026-00-10', '2026-04-31']) {
    it(`"${bad}" is a validation error and stores nothing`, async () => {
      await expect(takeReviewSnapshot(ctx, { asOf: bad })).rejects.toMatchObject({ code: 'VALIDATION' });
      const rows = await db
        .select()
        .from(clientReviewSnapshots)
        .where(and(eq(clientReviewSnapshots.companyId, ctx.companyId), eq(clientReviewSnapshots.asOf, bad)));
      expect(rows).toHaveLength(0);
    });
  }
  it('a real date still saves', async () => {
    const row = await takeReviewSnapshot(ctx, { asOf: '2024-02-29' });
    expect(row.asOf).toBe('2024-02-29');
  });
});

describe('L7: the Calendar leaves void orders out of "entered"', () => {
  it('void sales and purchase orders are not listed', async () => {
    const so = await createSalesOrder(ctx, { customerId, date: D('2026-06-10'), lines: [{ description: 'Widget', quantity: 1, rate: '5.00' }] });
    const keep = await createSalesOrder(ctx, { customerId, date: D('2026-06-10'), lines: [{ description: 'Gadget', quantity: 1, rate: '6.00' }] });
    await updateSalesOrderStatus(ctx, so.id, 'void');
    const po = await createPurchaseOrder(ctx, { vendorId, date: D('2026-06-10'), lines: [{ description: 'Bolts', quantity: 1, rate: '4.00', accountId: acct.e1 }] as never });
    await updatePurchaseOrderStatus(ctx, po.id, 'void');
    const cal = await getCalendar(ctx, { from: '2026-06-10', to: '2026-06-10', today: '2026-06-10' });
    const ids = cal.days.flatMap((d) => d.events.filter((e) => e.type === 'entered').map((e) => e.id));
    expect(ids).not.toContain(so.id);
    expect(ids).not.toContain(po.id);
    expect(ids).toContain(keep.id);
  });
});
