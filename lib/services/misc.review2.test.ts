/**
 * Review round 2 (lists, time & jobs, AI fixes) — regression tests for confirmed bugs:
 *  1. AI duplicate fix: reversing one copy of a flagged pair must not let the twin be reversed
 *     too, and a re-scan must not flag the corrected copy again.
 *  2. Billing time: two simultaneous "bill time" requests bill the hours once.
 *  3. Job profitability: void invoices are not job revenue.
 *  4. Customer / class merge into a grandchild must not create a parent loop.
 *  5. A customer cannot be moved under its own sub-customer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, classes, customers, errorDetections, invoices, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createManualEntry } from './journal';
import { detectErrors } from './errorDetection';
import { analyzeError, applyCorrection } from './llmCorrector';
import { Money } from '@/lib/money';
import { createCustomer, updateCustomer } from './customers';
import { mergeCustomers } from './merge';
import { mergeClasses } from './lists/mergeLists';
import { createClass } from './dimensions';
import { createJob, jobProfitability, jobsSummary } from './jobs';
import { createInvoice, voidInvoice } from './invoices';
import { createTimeEntry, billTimeToInvoice } from './timeTracking';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-misc');
let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function accountNet(accountId: string): Promise<string> {
  const rows = await db
    .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, accountId)));
  let n = Money.zero();
  for (const r of rows) n = n.plus(Money.of(r.debit ?? 0)).minus(Money.of(r.credit ?? 0));
  return n.toFixed(2);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'review2-misc@test.local', name: 'R2', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Review2 Misc Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const entryOf = (date: string, description: string, amount: string) => () =>
  createManualEntry(ctx, {
    date: D(date),
    description,
    lines: [
      { accountId: code['6000'], debit: amount },
      { accountId: code['1000'], credit: amount },
    ],
  });

describe('AI duplicate correction', () => {
  it('fixing one copy of a pair resolves the twin and refuses to reverse it (transaction not wiped out)', async () => {
    const before = Money.of(await accountNet(code['6000']));
    const make = entryOf('2026-04-10', 'Rent April', '500.00');
    await make();
    await make();

    // detectErrors flags BOTH copies of the pair.
    const dets = (await detectErrors(ctx)).filter((d) => d.errorType === 'duplicate' && d.description.includes('Rent April'));
    expect(dets.length).toBe(2);

    const c1 = await analyzeError(ctx, dets[0].id);
    await applyCorrection(ctx, c1.id, { approved: true });
    expect(Money.of(await accountNet(code['6000'])).minus(before).toFixed(2)).toBe('500.00');

    // The twin's detection is resolved with it ...
    const [twin] = await db.select().from(errorDetections).where(eq(errorDetections.id, dets[1].id));
    expect(twin.resolvedAt).not.toBeNull();
    // ... and even when followed, it can't be reversed: the remaining copy is the real one.
    await expect(analyzeError(ctx, dets[1].id)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(Money.of(await accountNet(code['6000'])).minus(before).toFixed(2)).toBe('500.00');
  });

  it('a correction prepared before the twin was fixed is refused at approval', async () => {
    const before = Money.of(await accountNet(code['6000']));
    const make = entryOf('2026-04-11', 'Rent extra', '300.00');
    await make();
    await make();
    const dets = (await detectErrors(ctx)).filter((d) => d.errorType === 'duplicate' && d.description.includes('Rent extra'));
    const c1 = await analyzeError(ctx, dets[0].id);
    const c2 = await analyzeError(ctx, dets[1].id); // both suggestions prepared up front
    await applyCorrection(ctx, c1.id, { approved: true });
    await expect(applyCorrection(ctx, c2.id, { approved: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(Money.of(await accountNet(code['6000'])).minus(before).toFixed(2)).toBe('300.00');
  });

  it('three copies: fixing one leaves the other two flagged (still a duplicate)', async () => {
    const make = entryOf('2026-04-12', 'Triple', '10.00');
    await make();
    await make();
    await make();
    const dets = (await detectErrors(ctx)).filter((d) => d.errorType === 'duplicate' && d.description.includes('Triple'));
    expect(dets.length).toBe(3);
    const c1 = await analyzeError(ctx, dets[0].id);
    await applyCorrection(ctx, c1.id, { approved: true });
    const open = await db.select().from(errorDetections).where(eq(errorDetections.companyId, ctx.companyId));
    const stillOpen = open.filter((d) => [dets[1].id, dets[2].id].includes(d.id) && !d.resolvedAt);
    expect(stillOpen.length).toBe(2);
    // One more fix is allowed (one surplus copy remains); the last copy then stands alone.
    const c2 = await analyzeError(ctx, dets[1].id);
    await applyCorrection(ctx, c2.id, { approved: true });
    await expect(analyzeError(ctx, dets[2].id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a re-scan after fixing a duplicate does not flag the already-corrected pair again', async () => {
    const make = entryOf('2026-05-10', 'Insurance May', '80.00');
    const a = await make();
    await make();
    const dets = (await detectErrors(ctx)).filter((d) => d.errorType === 'duplicate' && d.description.includes('Insurance May'));
    const forA = dets.find((d) => d.journalEntryId === a.id)!;
    const c = await analyzeError(ctx, forA.id);
    await applyCorrection(ctx, c.id, { approved: true });

    const again = (await detectErrors(ctx)).filter((d) => d.errorType === 'duplicate' && d.description.includes('Insurance May'));
    expect(again).toEqual([]);
  });
});

async function hasParentCycle(table: typeof customers | typeof classes): Promise<boolean> {
  const rows = await db.select({ id: table.id, parentId: table.parentId }).from(table).where(eq(table.companyId, ctx.companyId));
  const parent = new Map(rows.map((r) => [r.id, r.parentId]));
  for (const r of rows) {
    const seen = new Set<string>();
    let cur: string | null | undefined = r.id;
    while (cur) {
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = parent.get(cur);
    }
  }
  return false;
}

describe('list hierarchies', () => {
  it('merging a customer into its own grandchild job lifts the survivor (no parent loop)', async () => {
    const a = await createCustomer(ctx, { displayName: 'Hier A' });
    const b = await createCustomer(ctx, { displayName: 'Hier A:B', parentId: a.id });
    const c = await createCustomer(ctx, { displayName: 'Hier A:B:C', parentId: b.id });
    await mergeCustomers(ctx, { fromId: a.id, toId: c.id });
    expect(await hasParentCycle(customers)).toBe(false);
    const [cRow] = await db.select().from(customers).where(eq(customers.id, c.id));
    const [bRow] = await db.select().from(customers).where(eq(customers.id, b.id));
    expect(cRow.parentId).toBeNull();
    expect(bRow.parentId).toBe(c.id);
  });

  it('merging a class into its own grandchild lifts the survivor (no parent loop)', async () => {
    const a = await createClass(ctx, { name: 'Cls A' });
    const b = await createClass(ctx, { name: 'Cls B', parentId: a.id });
    const c = await createClass(ctx, { name: 'Cls C', parentId: b.id });
    await mergeClasses(ctx, { fromId: a.id, toId: c.id });
    expect(await hasParentCycle(classes)).toBe(false);
    const [cRow] = await db.select().from(classes).where(eq(classes.id, c.id));
    const [bRow] = await db.select().from(classes).where(eq(classes.id, b.id));
    expect(cRow.parentId).toBeNull();
    expect(bRow.parentId).toBe(c.id);
  });

  it('a customer cannot be moved under one of its own sub-customers', async () => {
    const p = await createCustomer(ctx, { displayName: 'Hier P' });
    const k = await createCustomer(ctx, { displayName: 'Hier P:K', parentId: p.id });
    const g = await createCustomer(ctx, { displayName: 'Hier P:K:G', parentId: k.id });
    await expect(updateCustomer(ctx, p.id, { parentId: k.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateCustomer(ctx, p.id, { parentId: g.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await hasParentCycle(customers)).toBe(false);
    // Moving a sub-customer elsewhere still works.
    const other = await createCustomer(ctx, { displayName: 'Hier Other' });
    await updateCustomer(ctx, k.id, { parentId: other.id });
  });
});

describe('job profitability', () => {
  it('a voided invoice is not job revenue (jobProfitability / jobsSummary)', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Job Cust', taxable: false });
    const job = await createJob(ctx, { customerId: cust.id, name: 'Roof job' });
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: D('2026-06-01'),
      lines: [{ accountId: code['4000'], description: 'Roof', quantity: 1, rate: '1000.00', taxable: false, jobId: job.id }],
    });
    expect((await jobProfitability(ctx, job.id)).revenue).toBe('1000.00');
    expect((await jobsSummary(ctx)).find((j) => j.id === job.id)!.revenue).toBe('1000.00');
    await voidInvoice(ctx, inv.id);
    const p = await jobProfitability(ctx, job.id);
    expect(p.revenue).toBe('0.00');
    expect(p.lines).toHaveLength(0);
    expect((await jobsSummary(ctx)).find((j) => j.id === job.id)!.revenue).toBe('0.00');
  });
});

describe('time billing', () => {
  it('two simultaneous "bill time" requests bill the same hours only once', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Time Cust', taxable: false });
    await createTimeEntry(ctx, { customerId: cust.id, date: D('2026-06-02'), hours: '2', rate: '100.00', description: 'Work' });
    const results = await Promise.allSettled([
      billTimeToInvoice(ctx, { customerId: cust.id }),
      billTimeToInvoice(ctx, { customerId: cust.id }),
    ]);
    const live = (await db.select().from(invoices).where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, cust.id))))
      .filter((i) => i.status !== 'void');
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(live.length).toBe(1);
    expect(live[0].total).toBe('200.00');
  });
});
