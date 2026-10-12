/**
 * Independent QA (tester), re-test round 2: attacks aimed at the fix for the round-1 finding
 * (an account carrying journal lines could be moved to another company, leaving posted lines
 * that cross companies). Variants: bulk moves, draft-only accounts, moving the entry instead
 * of the account, and the sanctioned rewrite flag (which the guard now exempts).
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
import { postJournalEntry } from './posting';
import { balanceSheet, trialBalance } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { booksInBalance } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-adversarial-r2');

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
const acct: Record<string, string> = {};

type Rows<T> = { rows: T[] };

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

async function companyOf(accountId: string): Promise<string> {
  const [row] = await db.select({ c: accounts.companyId }).from(accounts).where(eq(accounts.id, accountId));
  return row.c;
}

async function crossCompanyLines(): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(*)::int AS n FROM journal_entry_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE e.status = 'posted' AND a.company_id <> e.company_id`);
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
    date: new Date('2026-04-01'),
    description: 'QA r2 entry',
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

/** A draft entry (never posted) with one balanced pair of lines, inserted directly. */
async function insertDraft(entryNumber: number, debitId: string, creditId: string, amount: string) {
  return db.transaction(async (tx) => {
    const [e] = await tx
      .insert(journalEntries)
      .values({
        companyId: ctx.companyId,
        entryNumber,
        date: new Date('2026-04-02'),
        description: 'QA r2 draft',
        status: 'draft',
        createdBy: ctx.userId!,
      })
      .returning();
    await tx.insert(journalEntryLines).values([
      { journalEntryId: e.id, accountId: debitId, debit: amount, credit: '0' },
      { journalEntryId: e.id, accountId: creditId, debit: '0', credit: amount },
    ]);
    return e;
  });
}

describe('ledger invariants — adversarial QA, re-test round 2', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa-ledger-r2@test.local', name: 'QA', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'QA R2 Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) {
      acct[r.code] = r.id;
    }
    const other = await createCompany(db, { name: 'QA R2 Other Co', ownerId: user.id });
    otherCtx = { db, companyId: other.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('the round-1 repro is now refused with BK003 and leaves the account where it was', async () => {
    const id = await newExpense('6900', 'QA R2 Wanderer');
    await post('3.00', '6900', '1000');
    await expectRejected(db.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`), /another company/);
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('a bulk move of several accounts is refused atomically when any one carries lines', async () => {
    const used = await newExpense('6910', 'QA R2 Used');
    const unused = await newExpense('6911', 'QA R2 Unused');
    await post('5.00', '6910', '1000');
    await expectRejected(
      db.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id IN (${used}, ${unused})`),
      /another company/,
    );
    expect(await companyOf(used)).toBe(ctx.companyId);
    expect(await companyOf(unused)).toBe(ctx.companyId);
  });

  it('moving a whole chart of accounts to another company is refused', async () => {
    await expectRejected(
      db.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE company_id = ${ctx.companyId}`),
      /another company/,
    );
    expect(await crossCompanyLines()).toBe(0);
    await expectBooksBalanced(ctx);
  });

  it('the fix does not over-reach: an account with no journal lines can still be reassigned', async () => {
    const id = await newExpense('6920', 'QA R2 Fresh');
    await db.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
    expect(await companyOf(id)).toBe(otherCtx.companyId);
    // And it is now a foreign account to company A: posting to it from A is refused.
    await expectRejected(post('1.00', '6920', '1000'));
    expect(await crossCompanyLines()).toBe(0);
    await expectBooksBalanced(ctx);
    await expectBooksBalanced(otherCtx);
  });

  it('a draft whose account is moved away can never be posted across companies', async () => {
    const id = await newExpense('6930', 'QA R2 Draft Only');
    const draft = await insertDraft(910001, id, acct['1000'], '7.00');
    // Either the move is refused (draft lines count as lines) or the later posting is refused.
    let moved = true;
    try {
      await db.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
    } catch {
      moved = false;
    }
    if (moved) {
      await expectRejected(db.execute(sql`UPDATE journal_entries SET status = 'posted' WHERE id = ${draft.id}`), /LEDGER/);
    }
    expect(await crossCompanyLines()).toBe(0);
    await expectBooksBalanced(ctx);
  });

  it('a draft moved to another company (instead of its account) cannot then be posted there', async () => {
    const draft = await insertDraft(910002, acct['6400'] ?? acct['1000'], acct['1000'], '8.00');
    let moved = true;
    try {
      await db.execute(sql`UPDATE journal_entries SET company_id = ${otherCtx.companyId} WHERE id = ${draft.id}`);
    } catch {
      moved = false;
    }
    if (moved) {
      await expectRejected(db.execute(sql`UPDATE journal_entries SET status = 'posted' WHERE id = ${draft.id}`), /LEDGER/);
    }
    expect(await crossCompanyLines()).toBe(0);
    await expectBooksBalanced(otherCtx);
  });

  it('a posted entry cannot be moved to the company that owns none of its accounts', async () => {
    const e = await post('9.00', '6900', '1000');
    await expectRejected(db.execute(sql`UPDATE journal_entries SET company_id = ${otherCtx.companyId} WHERE id = ${e.id}`));
    expect(await crossCompanyLines()).toBe(0);
  });

  it('swapping an account and an entry to the other company together in one transaction is refused', async () => {
    const id = await newExpense('6940', 'QA R2 Swap');
    const e = await post('2.50', '6940', '1000');
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE journal_entries SET company_id = ${otherCtx.companyId} WHERE id = ${e.id}`);
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id IN (${id}, ${acct['1000']})`);
      }),
    );
    expect(await companyOf(id)).toBe(ctx.companyId);
    expect(await crossCompanyLines()).toBe(0);
  });

  it('even under the sanctioned rewrite flag, moving an account with posted lines cannot commit cross-company lines', async () => {
    // The guard exempts the account move when bka.allow_ledger_rewrite is on, on the premise
    // (migration header) that the deferred check (a) "still runs at COMMIT". But (a) only
    // re-checks entries whose rows were touched; moving the account touches none, so the
    // foreign-account rule (BK001) is never evaluated for the stranded posted lines.
    const id = await newExpense('6950', 'QA R2 Flagged Move');
    await post('4.25', '6950', '1000');
    let committed = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
                                    set_config('bka.ledger_rewrite_txid', txid_current()::text, true)`);
        await tx.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${id}`);
      });
      committed = true;
    } catch {
      committed = false;
    }
    const strandedLines = await crossCompanyLines();
    if (committed) {
      // Put the account back so the remaining assertions in this file are not polluted.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
                                    set_config('bka.ledger_rewrite_txid', txid_current()::text, true)`);
        await tx.execute(sql`UPDATE accounts SET company_id = ${ctx.companyId} WHERE id = ${id}`);
      });
    }
    expect(strandedLines, 'posted lines left pointing at another company\'s account').toBe(0);
    expect(committed, 'cross-company account move committed under the rewrite flag').toBe(false);
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
