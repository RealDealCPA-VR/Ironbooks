/**
 * P1 controls — Condense keeps payment / credit applications consistent.
 *
 * journal_item_applications rows (payments and credits applied to named General Journal A/R / A/P
 * lines) are ON DELETE CASCADE from their journal entry. Condense used to delete a General Journal
 * entry whose named line was still open, or that was applied to an invoice that stays open, which
 * silently deleted the applications too: aging and customer balances stopped tying to A/R.
 * Now such entries are kept (like open documents); applications go only when both sides are
 * condensed, and A/R control == aging == customer balances afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, invoices, journalEntries, journalEntryLines, journalItemApplications, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { createManualEntry } from './journal';
import { receivePayment } from './payments';
import { listJournalOpenItems } from './journalApplications';
import { condensePeriod } from './condense';
import { verifyIntegrity } from './integrity';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense-apps');
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
  const check = (await verifyIntegrity(ctx)).checks.find((c) => c.name.startsWith('A/R control'));
  expect(check?.ok, check?.detail).toBe(true);
}

async function arLine(entryId: string) {
  const [l] = await db
    .select()
    .from(journalEntryLines)
    .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, code['1200'])));
  return l;
}

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'condense-apps@test.local', name: 'C', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Condense Apps Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) code[a.code] = a.id;
  customerId = (await createCustomer(ctx, { displayName: 'Applied Customer' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('condense keeps applications so aging and balances still tie', () => {
  it('keeps open General Journal items and entries applied to open invoices; drops fully settled pairs', async () => {
    // (1) JE charge 100, partly paid (60): still open 40.
    const charge = await createManualEntry(ctx, {
      date: D('2026-01-05'),
      description: 'Rebill freight',
      lines: [
        { accountId: code['1200'], debit: '100.00', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '100.00' },
      ],
    });
    const chargeLine = (await arLine(charge.id)).id;
    await receivePayment(ctx, {
      customerId,
      date: D('2026-01-06'),
      method: 'check',
      amount: '60.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: chargeLine, amount: '60.00' }],
    });

    // (2) JE credit 50 fully applied to an invoice that stays partly open (300 − 50 − 100 = 150).
    const inv = await createInvoice(ctx, { customerId, date: D('2026-01-10'), lines: [{ description: 'Work', quantity: 1, rate: '300.00' }] });
    const credit = await createManualEntry(ctx, {
      date: D('2026-01-11'),
      description: 'Courtesy credit',
      lines: [
        { accountId: code['6000'], debit: '50.00' },
        { accountId: code['1200'], credit: '50.00', entityType: 'customer', entityId: customerId },
      ],
    });
    const creditLine = (await arLine(credit.id)).id;
    await receivePayment(ctx, {
      customerId,
      date: D('2026-01-12'),
      method: 'check',
      amount: '100.00',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
      journalCredits: [{ journalLineId: creditLine, invoiceId: inv.id, amount: '50.00' }],
    });

    // (3) JE charge 30 paid in full — both sides closed.
    const settled = await createManualEntry(ctx, {
      date: D('2026-01-15'),
      description: 'Settled rebill',
      lines: [
        { accountId: code['1200'], debit: '30.00', entityType: 'customer', entityId: customerId },
        { accountId: code['4000'], credit: '30.00' },
      ],
    });
    await receivePayment(ctx, {
      customerId,
      date: D('2026-01-16'),
      method: 'check',
      amount: '30.00',
      depositAccountId: code['1000'],
      applications: [],
      journalItems: [{ journalLineId: (await arLine(settled.id)).id, amount: '30.00' }],
    });

    // Open A/R: 40 (JE charge) + 150 (invoice) = 190.
    await expectArTied(190);
    const appsBefore = await db.select().from(journalItemApplications).where(eq(journalItemApplications.companyId, ctx.companyId));
    expect(appsBefore).toHaveLength(3);

    await setClosingDate(ctx, { closingDate: '2026-01-31' } as never);
    const result = await condensePeriod(ctx, { beforeDate: new Date('2026-02-01T00:00:00Z'), dataDir: TEST_DIR });
    expect(result.entriesToCondense).toBeGreaterThan(0);

    // The open JE charge and the JE credit applied to the open invoice are kept, with their applications.
    const kept = new Set(
      (await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).map((r) => r.id),
    );
    expect(kept.has(charge.id)).toBe(true);
    expect(kept.has(credit.id)).toBe(true);
    expect(kept.has(settled.id)).toBe(false); // fully settled with a closed payment: condensed
    const appsAfter = await db.select().from(journalItemApplications).where(eq(journalItemApplications.companyId, ctx.companyId));
    expect(appsAfter.map((a) => a.journalEntryId).sort()).toEqual([charge.id, credit.id].sort());

    expect((await listJournalOpenItems(ctx, 'ar', customerId)).charges[0].open).toBe('40.00');
    const [i] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(i.balanceDue).toBe('150.00');
    await expectArTied(190);
    expect((await trialBalance(ctx, AS_OF)).balanced).toBe(true);
  });
});
