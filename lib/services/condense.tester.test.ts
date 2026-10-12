/**
 * P1 controls — independent tester: condense must keep journal-item applications consistent
 * even when the OTHER side of the application is dated AFTER the cutoff (QB never condenses a
 * transaction linked to one that stays). A General Journal A/R charge dated before the cutoff,
 * paid in full by a payment dated after it, is "closed" — but if condense deletes the charge
 * (cascading its application), voiding the later payment puts the money back in A/R with no
 * open item to show for it: A/R control != aging != customer balances.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createManualEntry } from './journal';
import { receivePayment, voidPayment } from './payments';
import { condensePeriod } from './condense';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense-tester');
const TEST_DIR = path.join(TEST_ROOT, 'data');
let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
let customerId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const AS_OF = new Date('2026-12-31T23:59:59Z');

async function arControl(): Promise<number> {
  const tb = await trialBalance(ctx, AS_OF);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), sql`${accounts.subtype} = 'accounts_receivable'`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) if (ids.has(r.accountId)) total += Number(r.debit) - Number(r.credit);
  return Math.round(total * 100) / 100;
}

async function expectArTied(expected: number) {
  const control = await arControl();
  expect(control).toBeCloseTo(expected, 2);
  expect(Number((await arAging(ctx, AS_OF)).totals.total)).toBeCloseTo(control, 2);
  const customersTotal = (await customerBalanceSummary(ctx)).reduce((s, r) => s + Number(r.totalBalanceDue), 0);
  expect(customersTotal).toBeCloseTo(control, 2);
}

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'condense-tester@test.local', name: 'T', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Condense Tester Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  customerId = (await createCustomer(ctx, { displayName: 'Later Payer' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('condense and applications that cross the cutoff', () => {
  it('a GJ charge paid by a payment dated after the cutoff survives, so voiding the payment still ties', async () => {
    const charge = await createManualEntry(ctx, {
      date: D('2026-01-05'),
      description: 'Rebill shipping',
      lines: [
        { accountId: code['1200'], debit: '77.77', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '77.77' },
      ],
    });
    const [line] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, charge.id), eq(journalEntryLines.accountId, code['1200'])));
    const pay = await receivePayment(ctx, {
      customerId,
      date: D('2026-02-10'),
      method: 'check',
      amount: '77.77',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: line.id, amount: '77.77' }],
    });
    const paymentId = (pay as { payment?: { id: string }; id?: string }).payment?.id ?? (pay as { id: string }).id;
    await expectArTied(0);

    await setClosingDate(ctx, { closingDate: '2026-01-31' } as never);
    await condensePeriod(ctx, { beforeDate: new Date('2026-02-01T00:00:00Z'), dataDir: TEST_DIR });
    await expectArTied(0);
    expect((await trialBalance(ctx, AS_OF)).balanced).toBe(true);

    // The February payment bounced / was entered by mistake: void it (open period).
    await voidPayment(ctx, paymentId);
    // The customer owes the 77.77 again: A/R control, aging and the customer balance all say so.
    await expectArTied(77.77);
    expect((await trialBalance(ctx, AS_OF)).balanced).toBe(true);
  });
});
