/**
 * Integration tests for the condense/archive service.
 *
 * Boots a throwaway PGlite database, posts detail entries across two closed
 * months (plus a protected open-invoice entry, a voided entry, and an
 * after-cutoff entry), then verifies that condensePeriod:
 *   - previews correctly (dry run, no mutation),
 *   - refuses to condense an open (not closed) period,
 *   - replaces detail with monthly summaries that preserve account balances,
 *     gross debit/credit totals, and class totals,
 *   - keeps open-document entries + after-cutoff entries intact,
 *   - unlinks (but keeps) closed documents, writes archive + pre-op backups,
 *     and records an audit row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, and, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  classes,
  customers,
  invoices,
  journalEntries,
  journalEntryLines,
  auditLogs,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { postJournalEntry, voidJournalEntry } from './posting';
import { condensePeriod } from './condense';
import { preOpBackupDir } from './backup';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense');
const TEST_DIR = path.join(TEST_ROOT, 'data');

let db: DB;
let ctx: ServiceContext;
let cashId: string;
let revenueId: string;
let expenseId: string;
let arId: string;
let classAId: string;
let protectedEntryId: string;
let afterCutoffEntryId: string;
let closedInvoiceId: string;

/** Sum posted journal lines per account: { accountId: { debit, credit } }. */
async function postedTotalsByAccount() {
  const rows = await db
    .select({
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      classId: journalEntryLines.classId,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')));

  const byAccount = new Map<string, { debit: string; credit: string }>();
  const byClass = new Map<string, { debit: string; credit: string }>();
  for (const r of rows) {
    const a = byAccount.get(r.accountId) ?? { debit: '0.00', credit: '0.00' };
    a.debit = toAmountString(Money.add(a.debit, r.debit));
    a.credit = toAmountString(Money.add(a.credit, r.credit));
    byAccount.set(r.accountId, a);

    const ck = r.classId ?? '(none)';
    const c = byClass.get(ck) ?? { debit: '0.00', credit: '0.00' };
    c.debit = toAmountString(Money.add(c.debit, r.debit));
    c.credit = toAmountString(Money.add(c.credit, r.credit));
    byClass.set(ck, c);
  }
  return { byAccount, byClass };
}

async function accountBalances(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: accounts.id, balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return new Map(rows.map((r) => [r.id, toAmountString(r.balance)]));
}

describe('condensePeriod', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'condense@test.local', name: 'Condenser', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Condense Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const mkAccount = async (code: string, name: string, type: string, subtype: string) => {
      const [a] = await db
        .insert(accounts)
        .values({ companyId: company.id, code, name, type: type as never, subtype: subtype as never })
        .returning();
      return a.id;
    };
    cashId = await mkAccount('1000', 'Cash', 'asset', 'checking');
    arId = await mkAccount('1100', 'Accounts Receivable', 'asset', 'accounts_receivable');
    revenueId = await mkAccount('4000', 'Revenue', 'revenue', 'sales');
    expenseId = await mkAccount('6000', 'Expense', 'expense', 'operating_expenses');

    const [cls] = await db
      .insert(classes)
      .values({ companyId: company.id, name: 'Class A' })
      .returning();
    classAId = cls.id;

    // --- January detail (to be condensed) ---
    const e1 = await postJournalEntry(ctx, {
      date: new Date('2024-01-10T00:00:00Z'),
      description: 'Jan sale',
      lines: [
        { accountId: cashId, debit: '100.00' },
        { accountId: revenueId, credit: '100.00', classId: classAId },
      ],
    });
    await postJournalEntry(ctx, {
      date: new Date('2024-01-20T00:00:00Z'),
      description: 'Jan expense',
      lines: [
        { accountId: expenseId, debit: '40.00' },
        { accountId: cashId, credit: '40.00' },
      ],
    });
    // Voided entry in January (deleted outright by condense).
    const voided = await postJournalEntry(ctx, {
      date: new Date('2024-01-25T00:00:00Z'),
      description: 'Jan mistake',
      lines: [
        { accountId: expenseId, debit: '5.00' },
        { accountId: cashId, credit: '5.00' },
      ],
    });
    await voidJournalEntry(ctx, voided.id);

    // --- Protected: entry behind an OPEN invoice ---
    const e4 = await postJournalEntry(ctx, {
      date: new Date('2024-01-15T00:00:00Z'),
      description: 'Open invoice posting',
      sourceRef: 'invoice:placeholder',
      lines: [
        { accountId: arId, debit: '75.00', controlLine: true },
        { accountId: revenueId, credit: '75.00' },
      ],
    });
    protectedEntryId = e4.id;
    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Open Customer' })
      .returning();
    await db.insert(invoices).values({
      companyId: company.id,
      customerId: cust.id,
      invoiceNumber: 1,
      date: new Date('2024-01-15T00:00:00Z'),
      status: 'open',
      total: '75.00',
      balanceDue: '75.00',
      postedEntryId: e4.id,
    });

    // --- Closed (paid) invoice whose entry IS condensed: link must be cleared ---
    const [closedInv] = await db
      .insert(invoices)
      .values({
        companyId: company.id,
        customerId: cust.id,
        invoiceNumber: 2,
        date: new Date('2024-01-10T00:00:00Z'),
        status: 'paid',
        total: '100.00',
        balanceDue: '0.00',
        postedEntryId: e1.id,
      })
      .returning();
    closedInvoiceId = closedInv.id;

    // --- February detail (to be condensed) ---
    await postJournalEntry(ctx, {
      date: new Date('2024-02-05T00:00:00Z'),
      description: 'Feb sale',
      lines: [
        { accountId: cashId, debit: '250.00' },
        { accountId: revenueId, credit: '250.00', classId: classAId },
      ],
    });

    // --- March entry (after cutoff — untouched) ---
    const e5 = await postJournalEntry(ctx, {
      date: new Date('2024-03-10T00:00:00Z'),
      description: 'March sale',
      lines: [
        { accountId: cashId, debit: '10.00' },
        { accountId: revenueId, credit: '10.00' },
      ],
    });
    afterCutoffEntryId = e5.id;

    // Close the books through Feb 29 (company closing date).
    await db
      .update(companies)
      .set({ settings: { closingDate: '2024-02-29' } as never })
      .where(eq(companies.id, company.id));
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('refuses to condense a range that is not closed', async () => {
    // Cutoff past March: the March entry is not in a closed period.
    await expect(
      condensePeriod(ctx, { beforeDate: new Date('2024-04-01T00:00:00Z'), dryRun: true }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });

  it('dry run previews counts without modifying anything', async () => {
    const entriesBefore = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctx.companyId));

    const preview = await condensePeriod(ctx, {
      beforeDate: new Date('2024-03-01T00:00:00Z'),
      dryRun: true,
    });

    expect(preview.dryRun).toBe(true);
    expect(preview.archivePath).toBeNull();
    expect(preview.entriesToCondense).toBe(3); // Jan sale, Jan expense, Feb sale
    expect(preview.voidEntriesToDelete).toBe(1);
    expect(preview.keptOpenDocumentEntries).toBe(1); // the open invoice's entry
    expect(preview.months).toEqual(['2024-01', '2024-02']);
    expect(preview.summaryEntriesToCreate).toBe(2);

    const entriesAfter = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctx.companyId));
    expect(entriesAfter.length).toBe(entriesBefore.length); // nothing touched
  });

  it('blocks viewers from executing a condense', async () => {
    await expect(
      condensePeriod(
        { ...ctx, role: 'viewer' },
        { beforeDate: new Date('2024-03-01T00:00:00Z') },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('condenses detail into monthly summaries preserving balances and class totals', async () => {
    const balancesBefore = await accountBalances();
    const totalsBefore = await postedTotalsByAccount();

    const result = await condensePeriod(ctx, {
      beforeDate: new Date('2024-03-01T00:00:00Z'),
      dataDir: TEST_DIR,
    });

    expect(result.dryRun).toBe(false);
    expect(result.runId).toBeTruthy();
    expect(result.entriesToCondense).toBe(3);

    // Archive snapshot written before any deletion.
    expect(result.archivePath).toBeTruthy();
    expect(fs.existsSync(result.archivePath!)).toBe(true);
    // Rotating pre-op backup also written.
    const preOpDir = preOpBackupDir(TEST_DIR);
    const preOps = fs.readdirSync(preOpDir).filter((f) => f.startsWith('preop-condense'));
    expect(preOps.length).toBeGreaterThanOrEqual(1);

    // Detail gone, summaries present.
    const remaining = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctx.companyId));
    const summaries = remaining.filter((e) => e.sourceRef === `condense:${result.runId}`);
    expect(summaries).toHaveLength(2); // one per month
    expect(remaining.some((e) => e.description === 'Jan sale')).toBe(false);
    expect(remaining.some((e) => e.description === 'Jan mistake')).toBe(false); // void deleted
    // Protected + after-cutoff entries survive.
    expect(remaining.some((e) => e.id === protectedEntryId)).toBe(true);
    expect(remaining.some((e) => e.id === afterCutoffEntryId)).toBe(true);

    // Account balances (cache) untouched; gross posted debit/credit totals identical.
    const balancesAfter = await accountBalances();
    expect(balancesAfter).toEqual(balancesBefore);
    const totalsAfter = await postedTotalsByAccount();
    expect(Object.fromEntries(totalsAfter.byAccount)).toEqual(
      Object.fromEntries(totalsBefore.byAccount),
    );
    // Class totals preserved (Class A revenue: 100 + 250 credits).
    expect(Object.fromEntries(totalsAfter.byClass)).toEqual(
      Object.fromEntries(totalsBefore.byClass),
    );
    expect(totalsAfter.byClass.get(classAId)?.credit).toBe('350.00');

    // Closed invoice row kept, but its GL link cleared; open invoice untouched.
    const [closedInv] = await db.select().from(invoices).where(eq(invoices.id, closedInvoiceId));
    expect(closedInv).toBeDefined();
    expect(closedInv.postedEntryId).toBeNull();
    const [openInv] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.invoiceNumber, 1)));
    expect(openInv.postedEntryId).toBe(protectedEntryId);

    // Audit row recorded.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'condense')));
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe(result.runId);

    // Summary entries balance and carry only one-sided lines.
    for (const s of summaries) {
      const lines = await db
        .select()
        .from(journalEntryLines)
        .where(eq(journalEntryLines.journalEntryId, s.id));
      let d = Money.zero();
      let c = Money.zero();
      for (const l of lines) {
        expect(l.debit === null || l.credit === null).toBe(true);
        d = d.plus(Money.of(l.debit));
        c = c.plus(Money.of(l.credit));
      }
      expect(toAmountString(d)).toBe(toAmountString(c));
    }
  });

  it('throws VALIDATION when there is nothing left to condense', async () => {
    // Everything before 2024-01-01 is already empty.
    await expect(
      condensePeriod(ctx, { beforeDate: new Date('2024-01-01T00:00:00Z'), dataDir: TEST_DIR }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('previous summaries can be seen via sourceRef prefix', async () => {
    const summaries = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(
        eq(journalEntries.companyId, ctx.companyId),
        like(journalEntries.sourceRef, 'condense:%'),
      ));
    expect(summaries.length).toBe(2);
  });
});
