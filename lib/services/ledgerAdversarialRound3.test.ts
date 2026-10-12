/**
 * Independent QA (tester), re-test round 3: attacks aimed at the fix for the round-2 finding
 * (bka_accounts_guard exempted the account company move under the sanctioned rewrite flag, but
 * the deferred BK001 check never sees untouched entries). Every attack here runs WITH the
 * transaction-bound rewrite flag set, since that is the path the fix closed: void-only and
 * draft-only accounts, bulk moves, bundled type changes, re-keying / deleting the account, and
 * moving an entry header. Plus a non-over-reach check: a sanctioned rewrite that first re-points
 * every line away may then move the emptied account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { balanceSheet, trialBalance } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { booksInBalance } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-adversarial-r3');

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
const acct: Record<string, string> = {};

type Rows<T> = { rows: T[] };
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

async function expectRejected(p: Promise<unknown>, pattern?: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the write to be refused').toBeDefined();
  if (pattern) expect(String((caught as Error).message) + String((caught as { cause?: Error }).cause?.message ?? '')).toMatch(pattern);
}

/** Runs `fn` in a transaction that has the sanctioned, txid-bound rewrite flag set. */
function flagged(fn: (tx: Tx) => Promise<void>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
                                set_config('bka.ledger_rewrite_txid', txid_current()::text, true)`);
    await fn(tx);
  });
}

async function companyOf(accountId: string): Promise<string | undefined> {
  const [row] = await db.select({ c: accounts.companyId }).from(accounts).where(eq(accounts.id, accountId));
  return row?.c;
}

async function crossCompanyLines(): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM journal_entry_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE a.company_id <> e.company_id`);
  return (res as unknown as Rows<{ n: number }>).rows[0].n;
}

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
  const rows = (res as unknown as Rows<{ code: string; cached: string; derived: string }>).rows;
  expect(rows.filter((r) => !Money.eq(r.cached, r.derived)), 'accounts.balance drifted').toEqual([]);
}

async function expectBooksBalanced(c: ServiceContext) {
  const tb = await trialBalance(c);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  expect((await balanceSheet(c)).balanced).toBe(true);
  expect((await balanceSheetCashBasis(c)).balanced).toBe(true);
  await expectNoDrift(c.companyId);
}

async function post(amount: string, debitCode: string, creditCode: string) {
  return postJournalEntry(ctx, {
    date: new Date('2026-05-01'),
    description: 'QA r3 entry',
    lines: [
      { accountId: acct[debitCode], debit: amount },
      { accountId: acct[creditCode], credit: amount },
    ],
  });
}

async function newExpense(code: string, name: string) {
  const a = await createAccount(ctx, { code, name, type: 'expense' as never, subtype: 'operating_expenses' });
  acct[code] = a.id;
  return a.id;
}

describe('ledger invariants — adversarial QA, re-test round 3 (rewrite flag)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa-ledger-r3@test.local', name: 'QA', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'QA R3 Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) {
      acct[r.code] = r.id;
    }
    const other = await createCompany(db, { name: 'QA R3 Other Co', ownerId: user.id });
    otherCtx = { db, companyId: other.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('the round-2 repro (flagged move of an account with posted lines) is refused with BK003', async () => {
    const id = await newExpense('6960', 'QA R3 Flagged Posted');
    await post('4.25', '6960', '1000');
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
      }),
      /another company/,
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('a flagged move of an account whose only lines are on a VOID entry is refused', async () => {
    // Void entries are "frozen history" and skip the balance checks — but they still must not
    // reference another company's account (reports that list voided entries would leak).
    const id = await newExpense('6961', 'QA R3 Void Only');
    const e = await post('6.10', '6961', '1000');
    await voidJournalEntry(ctx, e.id);
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
      }),
      /another company/,
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('a flagged move of an account whose only lines are on a DRAFT entry is refused', async () => {
    const id = await newExpense('6962', 'QA R3 Draft Only');
    await db.transaction(async (tx) => {
      const [e] = await tx
        .insert(journalEntries)
        .values({
          companyId: ctx.companyId,
          entryNumber: 930001,
          date: new Date('2026-05-02'),
          description: 'QA r3 draft',
          status: 'draft',
          createdBy: ctx.userId!,
        })
        .returning();
      await tx.insert(journalEntryLines).values([
        { journalEntryId: e.id, accountId: id, debit: '2.00', credit: '0' },
        { journalEntryId: e.id, accountId: acct['1000'], debit: '0', credit: '2.00' },
      ]);
    });
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
      }),
      /another company/,
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('a flagged bulk move of the whole chart of accounts is refused atomically', async () => {
    const before = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, ctx.companyId));
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE company_id = ${ctx.companyId}`);
      }),
      /another company/,
    );
    const after = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, ctx.companyId));
    expect(after.length).toBe(before.length);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('bundling a type change with the flagged company move cannot skip the check', async () => {
    const id = await newExpense('6963', 'QA R3 Type Bundle');
    await post('1.75', '6963', '1000');
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId}, type = 'liability' WHERE id = ${id}`);
      }),
      /another company/,
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('re-keying an account that has lines (new id + new company) is refused even under the flag', async () => {
    const id = await newExpense('6964', 'QA R3 Rekey');
    await post('3.30', '6964', '1000');
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE accounts SET id = gen_random_uuid(), company_id = ${otherCtx.companyId} WHERE id = ${id}`);
      }),
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('deleting an account that has posted lines is refused even under the flag', async () => {
    const id = await newExpense('6965', 'QA R3 Delete');
    await post('2.20', '6965', '1000');
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
      }),
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    await expectBooksBalanced(ctx);
  });

  it('moving a posted entry header to another company under the flag fails at COMMIT (BK001)', async () => {
    const e = await post('5.55', '6960', '1000');
    await expectRejected(
      flagged(async (tx) => {
        await tx.execute(sql`UPDATE journal_entries SET company_id = ${otherCtx.companyId} WHERE id = ${e.id}`);
      }),
      /another company/,
    );
    const [row] = await db.select({ c: journalEntries.companyId }).from(journalEntries).where(eq(journalEntries.id, e.id));
    expect(row.c).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('moving an entry AND re-pointing its lines to the other company\'s accounts under the flag keeps both books balanced', async () => {
    // The only way a flagged rewrite could legitimately carry an entry across: every line
    // re-pointed to the destination company's accounts. Either it is refused, or both
    // companies' books still balance with no drift and no cross-company lines.
    const e = await post('8.80', '6960', '1000');
    const [otherExp] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.companyId} = ${otherCtx.companyId} AND ${accounts.type} = 'expense'`)
      .limit(1);
    const [otherBank] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`${accounts.companyId} = ${otherCtx.companyId} AND ${accounts.code} = '1000'`)
      .limit(1);
    try {
      await flagged(async (tx) => {
        await tx.execute(sql`UPDATE journal_entries SET company_id = ${otherCtx.companyId} WHERE id = ${e.id}`);
        await tx.execute(sql`UPDATE journal_entry_lines SET account_id = ${otherExp.id} WHERE journal_entry_id = ${e.id} AND account_id = ${acct['6960']}`);
        await tx.execute(sql`UPDATE journal_entry_lines SET account_id = ${otherBank.id} WHERE journal_entry_id = ${e.id} AND account_id = ${acct['1000']}`);
      });
    } catch {
      /* refusing is also acceptable */
    }
    expect(await crossCompanyLines()).toBe(0);
    await expectBooksBalanced(ctx);
    await expectBooksBalanced(otherCtx);
  });

  it('does not over-reach: a flagged rewrite may re-point every line away and then move the emptied account', async () => {
    const id = await newExpense('6966', 'QA R3 Emptied');
    const sink = await newExpense('6967', 'QA R3 Sink');
    await post('9.90', '6966', '1000');
    await flagged(async (tx) => {
      await tx.execute(sql`UPDATE journal_entry_lines SET account_id = ${sink} WHERE account_id = ${id}`);
      await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
    });
    expect(await companyOf(id)).toBe(otherCtx.companyId);
    const [moved] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, id));
    const [sinkRow] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, sink));
    expect(Money.eq(moved.b, '0')).toBe(true);
    expect(Money.eq(sinkRow.b, '9.90')).toBe(true);
    expect(await crossCompanyLines()).toBe(0);
    await expectBooksBalanced(ctx);
    await expectBooksBalanced(otherCtx);
  });

  it('the flag set in one transaction does not leak into the next: an unflagged line rewrite is refused', async () => {
    const e = await post('1.11', '6960', '1000');
    await flagged(async () => {});
    await expectRejected(
      db.execute(sql`UPDATE journal_entry_lines SET debit = '100.00' WHERE journal_entry_id = ${e.id} AND debit > 0`),
      /LEDGER/,
    );
    await expectBooksBalanced(ctx);
  });

  it('books stay in balance after every attack in this file', async () => {
    await expectBooksBalanced(ctx);
    await expectBooksBalanced(otherCtx);
    const status = await booksInBalance(ctx);
    expect(status.inBalance).toBe(true);
    expect(status.guards.missing).toEqual([]);
    expect(await crossCompanyLines()).toBe(0);
  });
});
