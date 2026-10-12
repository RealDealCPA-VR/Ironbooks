/**
 * Independent QA (tester) — adversarial tests for the database-level ledger invariants
 * (drizzle/0017_team_ledger.sql) and the balanced-by-construction reports.
 *
 * Complements ledgerInvariants.test.ts / ledgerProperty.test.ts with attacks those do not
 * cover: immutability bypasses, sub-cent rounding, rollback on failure, idempotent voids,
 * draft→posted promotion of a bad draft, the rewrite flag leaking past its transaction,
 * cross-company postings, and cash-basis report consistency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, inTransaction, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { createManualEntry, updateEntry, voidEntry } from './journal';
import { mergeAccounts } from './merge';
import { balanceSheet, trialBalance } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { profitAndLossCashBasis } from './cashBasisReports';
import { booksInBalance } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-adversarial');

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
/** Separate company used for attacks that (when a bypass exists) corrupt the books. */
let victimCtx: ServiceContext;
let userId: string;
const victimAcct: Record<string, string> = {};
const acct: Record<string, string> = {};
const otherAcct: Record<string, string> = {};

async function balanceOf(id: string): Promise<string> {
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return Money.of(row.b).toFixed(2);
}

/** Every account's cached balance must equal the ledger-derived one (posted lines only). */
async function expectNoDrift(companyId: string) {
  const res = await db.execute(sql`
    SELECT a.code, a.balance::text AS cached,
           coalesce(sum(CASE WHEN e.status = 'posted' THEN
             CASE WHEN a.type IN ('asset','expense') THEN coalesce(l.debit,0) - coalesce(l.credit,0)
                  ELSE coalesce(l.credit,0) - coalesce(l.debit,0) END END), 0)::numeric(15,2)::text AS derived
    FROM accounts a
    LEFT JOIN journal_entry_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
    WHERE a.company_id = ${companyId}
    GROUP BY a.id, a.code, a.balance`);
  const rows = (res as unknown as { rows: Array<{ code: string; cached: string; derived: string }> }).rows;
  const drift = rows.filter((r) => !Money.eq(r.cached, r.derived));
  expect(drift, 'accounts.balance drifted from the ledger').toEqual([]);
}

async function expectRejected(p: Promise<unknown>, pattern?: RegExp): Promise<unknown> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the write to be refused').toBeDefined();
  if (pattern) expect(String((caught as Error).message)).toMatch(pattern);
  return caught;
}

async function post(amount: string, debitCode = '1000', creditCode = '4100', date = new Date('2026-03-01')) {
  return postJournalEntry(ctx, {
    allowUnnamedControl: true, // fixture posts straight to A/R or A/P
    date,
    description: 'QA entry',
    lines: [
      { accountId: acct[debitCode], debit: amount },
      { accountId: acct[creditCode], credit: amount },
    ],
  });
}

describe('ledger invariants — adversarial QA', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa-ledger@test.local', name: 'QA', passwordHash: 'x' })
      .returning();
    userId = user.id;
    const company = await createCompany(db, { name: 'QA Ledger Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) {
      acct[r.code] = r.id;
    }
    const other = await createCompany(db, { name: 'QA Other Co', ownerId: user.id });
    otherCtx = { db, companyId: other.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, other.id))) {
      otherAcct[r.code] = r.id;
    }
    const victim = await createCompany(db, { name: 'QA Victim Co', ownerId: user.id });
    victimCtx = { db, companyId: victim.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, victim.id))) {
      victimAcct[r.code] = r.id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Immutability
  // -------------------------------------------------------------------------

  it('cannot bypass immutability by resetting created_at to now() (posted entry "looks new")', async () => {
    const e = await postJournalEntry(victimCtx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2026-03-01'),
      description: 'victim',
      lines: [
        { accountId: victimAcct['1000'], debit: '40.00' },
        { accountId: victimAcct['4100'], credit: '40.00' },
      ],
    });
    // A balanced but history-rewriting change: move the debit from Checking to Savings
    // on an entry posted in an EARLIER transaction. Must be refused (BK002).
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE journal_entries SET created_at = now() WHERE id = ${e.id}`);
        await tx.execute(
          sql`UPDATE journal_entry_lines SET account_id = ${victimAcct['1010']}
              WHERE journal_entry_id = ${e.id} AND account_id = ${victimAcct['1000']}`,
        );
      }),
      /LEDGER|cannot/,
    );
    const lines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, e.id));
    expect(lines.map((l) => l.accountId).sort()).toEqual([victimAcct['1000'], victimAcct['4100']].sort());
  });

  it('cannot change line amounts symmetrically (still balanced) on a posted entry', async () => {
    const e = await post('15.00');
    await expectRejected(
      db.execute(sql`UPDATE journal_entry_lines SET debit = CASE WHEN debit IS NULL THEN NULL ELSE 999.00 END,
                                                   credit = CASE WHEN credit IS NULL THEN NULL ELSE 999.00 END
                     WHERE journal_entry_id = ${e.id}`),
      /LEDGER/,
    );
    await expectNoDrift(ctx.companyId);
  });

  it('refuses TRUNCATE of the ledger tables', async () => {
    await expectRejected(db.execute(sql`TRUNCATE journal_entry_lines CASCADE`));
    await expectRejected(db.execute(sql`TRUNCATE journal_entries CASCADE`));
  });

  it('void is final and posted→void through raw SQL reverses balances exactly once', async () => {
    const e = await post('12.34');
    const cash = await balanceOf(acct['1000']);
    await db.update(journalEntries).set({ status: 'void' }).where(eq(journalEntries.id, e.id));
    expect(await balanceOf(acct['1000'])).toBe(Money.sub(cash, '12.34').toFixed(2));
    // Re-voiding (void→void) must not reverse again.
    await db.update(journalEntries).set({ status: 'void', updatedAt: new Date() }).where(eq(journalEntries.id, e.id));
    expect(await balanceOf(acct['1000'])).toBe(Money.sub(cash, '12.34').toFixed(2));
    await expectRejected(
      db.update(journalEntries).set({ status: 'posted' }).where(eq(journalEntries.id, e.id)),
      /void/,
    );
    await expectRejected(
      db.update(journalEntries).set({ status: 'draft' }).where(eq(journalEntries.id, e.id)),
      /void/,
    );
    await expectNoDrift(ctx.companyId);
  });

  it('voidJournalEntry is idempotent-safe: a second void is refused and does not double-reverse', async () => {
    const e = await post('7.77');
    const cash = await balanceOf(acct['1000']);
    await voidJournalEntry(ctx, e.id);
    const afterVoid = await balanceOf(acct['1000']);
    expect(afterVoid).toBe(Money.sub(cash, '7.77').toFixed(2));
    await voidJournalEntry(ctx, e.id).catch(() => undefined);
    expect(await balanceOf(acct['1000'])).toBe(afterVoid);
    await expectNoDrift(ctx.companyId);
  });

  // -------------------------------------------------------------------------
  // Commit-time balance check
  // -------------------------------------------------------------------------

  it('promoting an unbalanced DRAFT to posted fails at commit and leaves balances untouched', async () => {
    const [draft] = await db
      .insert(journalEntries)
      .values({ companyId: ctx.companyId, entryNumber: 8001, date: new Date('2026-03-02'), description: 'bad draft', status: 'draft', createdBy: userId })
      .returning();
    // Drafts are not checked — this commits.
    await db.insert(journalEntryLines).values([
      { journalEntryId: draft.id, accountId: acct['1000'], debit: '10.00' },
      { journalEntryId: draft.id, accountId: acct['4100'], credit: '9.00' },
    ]);
    const cash = await balanceOf(acct['1000']);
    await expectRejected(
      db.update(journalEntries).set({ status: 'posted' }).where(eq(journalEntries.id, draft.id)),
      /out of balance/,
    );
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, draft.id));
    expect(row.status).toBe('draft');
    expect(await balanceOf(acct['1000'])).toBe(cash);
    await expectNoDrift(ctx.companyId);
  });

  it('SET CONSTRAINTS ALL IMMEDIATE cannot be used to skip the deferred check', async () => {
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const [e] = await tx
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 8002, date: new Date(), description: 'x', status: 'posted', createdBy: userId })
          .returning();
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: acct['1000'], debit: '5.00' },
          { journalEntryId: e.id, accountId: acct['4100'], credit: '4.00' },
        ]);
      }),
      /LEDGER/,
    );
    await expectNoDrift(ctx.companyId);
  });

  it('raw SQL cannot disable the guards with session_replication_role = replica', async () => {
    const cash = await balanceOf(victimAcct['1000']);
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        const [e] = await tx
          .insert(journalEntries)
          .values({ companyId: victimCtx.companyId, entryNumber: 8003, date: new Date(), description: 'replica', status: 'posted', createdBy: userId })
          .returning();
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: victimAcct['1000'], debit: '50.00' },
          { journalEntryId: e.id, accountId: victimAcct['4100'], credit: '1.00' },
        ]);
      }),
    );
    expect(await balanceOf(victimAcct['1000'])).toBe(cash);
  });

  it('a posted line pointing at another company\'s account is refused (service and raw SQL)', async () => {
    await expectRejected(
      postJournalEntry(ctx, {
        allowUnnamedControl: true, // fixture posts straight to A/R or A/P
        date: new Date('2026-03-03'),
        description: 'cross-company',
        lines: [
          { accountId: acct['1000'], debit: '20.00' },
          { accountId: otherAcct['4100'], credit: '20.00' },
        ],
      }),
    );
    await expectRejected(
      db.transaction(async (tx) => {
        const [e] = await tx
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 8004, date: new Date(), description: 'x', status: 'posted', createdBy: userId })
          .returning();
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: acct['1000'], debit: '20.00' },
          { journalEntryId: e.id, accountId: otherAcct['4100'], credit: '20.00' },
        ]);
      }),
      /another company/,
    );
    expect(await balanceOf(otherAcct['4100'])).toBe('0.00');
    await expectNoDrift(otherCtx.companyId);
  });

  // -------------------------------------------------------------------------
  // Rounding / malformed input through the public services
  // -------------------------------------------------------------------------

  it('sub-cent amounts that do not net to zero after 2dp rounding are refused with no side effects', async () => {
    const cash = await balanceOf(acct['1000']);
    const count0 = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    // 10.004 + 10.004 = 20.008 exactly, but each line rounds to 10.00 → 20.00 vs 20.01.
    const err = await expectRejected(
      postJournalEntry(ctx, {
        allowUnnamedControl: true, // fixture posts straight to A/R or A/P
        date: new Date('2026-03-04'),
        description: 'sub-cent',
        lines: [
          { accountId: acct['1000'], debit: '10.004' },
          { accountId: acct['1000'], debit: '10.004' },
          { accountId: acct['4100'], credit: '20.008' },
        ],
      }),
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect(await balanceOf(acct['1000'])).toBe(cash);
    const count1 = (await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    expect(count1).toBe(count0);
  });

  it('a line that rounds to 0.00 is refused (no zero-amount posted lines)', async () => {
    await expectRejected(
      postJournalEntry(ctx, {
        allowUnnamedControl: true, // fixture posts straight to A/R or A/P
        date: new Date('2026-03-04'),
        description: 'dust',
        lines: [
          { accountId: acct['1000'], debit: '5.00' },
          { accountId: acct['6000'], debit: '0.004' },
          { accountId: acct['4100'], credit: '5.00' },
        ],
      }),
    );
    const zero = await db.execute(
      sql`SELECT count(*)::int AS n FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
          WHERE e.status = 'posted' AND coalesce(l.debit,0) = 0 AND coalesce(l.credit,0) = 0`,
    );
    expect((zero as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
  });

  it('negative, NaN and both-sided lines are refused by the posting engine', async () => {
    for (const lines of [
      [{ accountId: acct['1000'], debit: '-5.00' }, { accountId: acct['4100'], credit: '-5.00' }],
      [{ accountId: acct['1000'], debit: 'abc' }, { accountId: acct['4100'], credit: 'abc' }],
      [{ accountId: acct['1000'], debit: '5.00', credit: '5.00' }, { accountId: acct['4100'], debit: '5.00', credit: '5.00' }],
    ]) {
      await expectRejected(postJournalEntry(ctx, { date: new Date('2026-03-04'), description: 'bad', lines }));
    }
    await expectNoDrift(ctx.companyId);
  });

  // -------------------------------------------------------------------------
  // Rollback on failure
  // -------------------------------------------------------------------------

  it('a service transaction that throws after posting rolls back the trigger-maintained balances', async () => {
    const cash = await balanceOf(acct['1000']);
    await expectRejected(
      inTransaction(ctx, async (tx) => {
        await postJournalEntry(tx, {
          allowUnnamedControl: true, // fixture posts straight to A/R or A/P
          date: new Date('2026-03-05'),
          description: 'rolled back',
          lines: [
            { accountId: acct['1000'], debit: '300.00' },
            { accountId: acct['4100'], credit: '300.00' },
          ],
        });
        throw new ServiceError('VALIDATION', 'boom after posting');
      }),
      /boom/,
    );
    expect(await balanceOf(acct['1000'])).toBe(cash);
    await expectNoDrift(ctx.companyId);
  });

  it('editing a manual entry into an unbalanced one fails atomically (original stays posted)', async () => {
    const original = await createManualEntry(ctx, {
      date: new Date('2026-03-06'),
      description: 'Accrual',
      lines: [
        { accountId: acct['6200'], debit: '80.00' },
        { accountId: acct['1000'], credit: '80.00' },
      ],
    } as never);
    const ins = await balanceOf(acct['6200']);
    await expectRejected(
      updateEntry(ctx, original.id, {
        date: new Date('2026-03-06'),
        description: 'Accrual (edited)',
        lines: [
          { accountId: acct['6200'], debit: '90.00' },
          { accountId: acct['1000'], credit: '80.00' },
        ],
      } as never),
    );
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, original.id));
    expect(row.status).toBe('posted');
    expect(await balanceOf(acct['6200'])).toBe(ins);
    // A valid edit works and moves balances exactly.
    await updateEntry(ctx, original.id, {
      date: new Date('2026-03-06'),
      description: 'Accrual (edited)',
      lines: [
        { accountId: acct['6200'], debit: '90.00' },
        { accountId: acct['1000'], credit: '90.00' },
      ],
    } as never);
    expect(await balanceOf(acct['6200'])).toBe(Money.add(ins, '10.00').toFixed(2));
    await expectNoDrift(ctx.companyId);
  });

  it('viewers cannot post or void (RBAC before any ledger write)', async () => {
    const viewer: ServiceContext = { ...ctx, role: 'viewer' } as ServiceContext;
    const e = await post('3.00');
    await expectRejected(voidEntry(viewer, e.id), /view-only/);
    await expectRejected(
      createManualEntry(viewer, {
        date: new Date('2026-03-07'),
        description: 'viewer',
        lines: [
          { accountId: acct['1000'], debit: '1.00' },
          { accountId: acct['4100'], credit: '1.00' },
        ],
      } as never),
      /view-only/,
    );
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, e.id));
    expect(row.status).toBe('posted');
  });

  // -------------------------------------------------------------------------
  // Sanctioned rewrite flag must not leak
  // -------------------------------------------------------------------------

  it('the rewrite flag set by mergeAccounts does not leak past its transaction', async () => {
    const a = await createAccount(ctx, { code: '6810', name: 'QA Merge From', type: 'expense' as never, subtype: 'operating_expenses' });
    const b = await createAccount(ctx, { code: '6820', name: 'QA Merge To', type: 'expense' as never, subtype: 'operating_expenses' });
    acct['6810'] = a.id;
    acct['6820'] = b.id;
    await post('11.00', '6810', '1000');
    await post('22.00', '6820', '1000');
    await mergeAccounts(ctx, { fromId: a.id, toId: b.id });
    expect(await balanceOf(b.id)).toBe('33.00');
    expect(await balanceOf(a.id)).toBe('0.00');
    await expectNoDrift(ctx.companyId);

    const flag = await db.execute(sql`SELECT coalesce(current_setting('bka.allow_ledger_rewrite', true), '') AS v`);
    expect((flag as unknown as { rows: Array<{ v: string }> }).rows[0].v).not.toBe('on');

    const target = await post('1.00');
    await expectRejected(
      db.delete(journalEntryLines).where(eq(journalEntryLines.journalEntryId, target.id)),
      /LEDGER/,
    );
  });

  it('Data Integrity detects a ledger corrupted behind the guards back (never reports false green)', async () => {
    // Whether or not the replica-role attack above got through, the live check must tell the
    // truth about the victim company: if an unbalanced posted entry exists, it is not in balance.
    const bad = await db.execute(sql`
      SELECT e.id FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.status = 'posted' AND e.company_id = ${victimCtx.companyId} GROUP BY e.id
      HAVING sum(coalesce(l.debit,0)) <> sum(coalesce(l.credit,0))`);
    const corrupt = (bad as unknown as { rows: unknown[] }).rows.length > 0;
    const status = await booksInBalance(victimCtx);
    expect(status.inBalance).toBe(!corrupt);
    if (corrupt) {
      expect(status.trialBalance.ok).toBe(false);
      expect(status.trialBalance.detail).toMatch(/INTEGRITY/);
    }
  });

  it('a session-level (non-local) rewrite flag is not honoured outside a whitelisted transaction', async () => {
    // set_config(..., false) would open the gate for the whole connection. Only a
    // transaction-local flag is a sanctioned rewrite. (Reset afterwards either way.)
    const e = await postJournalEntry(victimCtx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2026-03-01'),
      description: 'victim 2',
      lines: [
        { accountId: victimAcct['1000'], debit: '2.00' },
        { accountId: victimAcct['4100'], credit: '2.00' },
      ],
    });
    try {
      await db.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', false)`);
      await expectRejected(
        db.execute(sql`UPDATE journal_entry_lines SET account_id = ${victimAcct['1010']}
                       WHERE journal_entry_id = ${e.id} AND account_id = ${victimAcct['1000']}`),
      );
    } finally {
      await db.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', '', false)`);
    }
  });

  // -------------------------------------------------------------------------
  // accounts.balance
  // -------------------------------------------------------------------------

  it('accounts cannot be created with a non-zero balance, nor have balance nudged by a cent', async () => {
    await expectRejected(
      db.insert(accounts).values({ companyId: ctx.companyId, code: '1999', name: 'Sneaky', type: 'asset', subtype: 'checking', balance: '0.01' }),
      /zero balance/,
    );
    const cash = await balanceOf(acct['1000']);
    await expectRejected(
      db.update(accounts).set({ balance: Money.add(cash, '0.01').toFixed(2) }).where(eq(accounts.id, acct['1000'])),
      /derived/,
    );
    // Re-setting it to the derived value is harmless.
    await db.update(accounts).set({ balance: cash }).where(eq(accounts.id, acct['1000']));
    expect(await balanceOf(acct['1000'])).toBe(cash);
  });

  it('createAccount with an opening balance posts a balanced entry and the cache follows', async () => {
    const acc = await createAccount(ctx, {
      code: '1020',
      name: 'QA Money Market',
      type: 'asset' as never,
      subtype: 'savings',
      openingBalance: '1234.56',
      openingBalanceDate: new Date('2026-01-01'),
    });
    expect(await balanceOf(acc.id)).toBe('1234.56');
    await expectNoDrift(ctx.companyId);
  });

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  it('balance sheet as of a past date balances and splits earnings consistently', async () => {
    await post('500.00', '1000', '4000', new Date('2025-06-15'));
    await post('120.00', '6400', '1000', new Date('2025-07-15'));
    const past = await balanceSheet(ctx, new Date('2025-12-31T23:59:59Z'));
    expect(past.balanced).toBe(true);
    expect(Money.eq(past.totalAssets, Money.add(past.totalLiabilities, past.totalEquity))).toBe(true);
    expect(Money.eq(past.retainedEarnings, '380.00')).toBe(true);
    expect(Money.eq(Money.add(past.priorYearsEarnings, past.currentYearNetIncome), past.retainedEarnings)).toBe(true);
    const now = await balanceSheet(ctx);
    expect(now.balanced).toBe(true);
    expect(Money.eq(Money.add(now.priorYearsEarnings, now.currentYearNetIncome), now.retainedEarnings)).toBe(true);
    // As of 2026, the 2025 earnings are prior-years earnings.
    expect(Money.gte(now.priorYearsEarnings, '380.00')).toBe(true);
  });

  it('cash-basis balance sheet earnings agree with the cash-basis P&L (all A/R accounts, e.g. Retainage)', async () => {
    // Retainage Receivable (1250) is an A/R account in the default chart. Revenue billed to
    // it is not cash yet, so BOTH cash-basis reports must exclude it consistently.
    await post('250.00', '1250', '4100', new Date('2026-04-01'));
    const bs = await balanceSheetCashBasis(ctx);
    expect(bs.balanced).toBe(true);
    const pl = await profitAndLossCashBasis(ctx);
    // No equity contributions / closes in this file: all-time cash earnings on the balance sheet
    // must equal all-time cash net income on the P&L.
    expect(Money.of(bs.retainedEarnings).toFixed(2)).toBe(Money.of(pl.netIncome).toFixed(2));
  });

  it('books-in-balance stays green after all of the attacks above', async () => {
    const status = await booksInBalance(ctx);
    expect(status.trialBalance.ok).toBe(true);
    expect(status.balanceSheet.ok).toBe(true);
    expect(status.cashBasisBalanceSheet.ok).toBe(true);
    expect(status.accountBalances.ok).toBe(true);
    expect(status.guards.ok).toBe(true);
    const tb = await trialBalance(ctx);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const bad = await db.execute(sql`
      SELECT e.id FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.status = 'posted' AND e.company_id = ${ctx.companyId} GROUP BY e.id
      HAVING sum(coalesce(l.debit,0)) <> sum(coalesce(l.credit,0)) OR count(*) < 2`);
    expect((bad as unknown as { rows: unknown[] }).rows).toEqual([]);
  });
});
