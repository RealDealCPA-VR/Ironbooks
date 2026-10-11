/**
 * Independent QA (tester), re-test round 1: attacks aimed at the fixes for the round-0
 * findings. The fixes are: created_at is immutable, the guards are ENABLE ALWAYS, the rewrite
 * flag is bound to a txid, and the cash-basis reports share one A/R / A/P classifier.
 * Variants of each original bypass are tried here, plus a few neighbouring invariants
 * (account reassignment and deletion).
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
import { allowLedgerRewrite, postJournalEntry } from './posting';
import { balanceSheet, trialBalance } from './reports';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { profitAndLossCashBasis } from './cashBasisReports';
import { booksInBalance, LEDGER_GUARD_TRIGGERS } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-adversarial-r1');

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
const acct: Record<string, string> = {};

type Rows<T> = { rows: T[] };

async function balanceOf(id: string): Promise<string> {
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return Money.of(row.b).toFixed(2);
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

async function post(amount: string, debitCode = '1000', creditCode = '4100', date = new Date('2026-03-01')) {
  return postJournalEntry(ctx, {
    date,
    description: 'QA r1 entry',
    lines: [
      { accountId: acct[debitCode], debit: amount },
      { accountId: acct[creditCode], credit: amount },
    ],
  });
}

/** Lines of an entry, normalised for comparison. */
async function linesOf(entryId: string) {
  const rows = await db
    .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId));
  return rows
    .map((r) => `${r.accountId}:${Money.of(r.debit ?? 0).toFixed(2)}:${Money.of(r.credit ?? 0).toFixed(2)}`)
    .sort();
}

describe('ledger invariants — adversarial QA, re-test round 1', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa-ledger-r1@test.local', name: 'QA', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'QA R1 Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) {
      acct[r.code] = r.id;
    }
    const other = await createCompany(db, { name: 'QA R1 Other Co', ownerId: user.id });
    otherCtx = { db, companyId: other.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // created_at / "entry is new" bypass variants
  // -------------------------------------------------------------------------

  it('created_at of a posted entry cannot be changed at all (to now(), to the past, or to NULL)', async () => {
    const e = await post('10.00');
    await expectRejected(db.execute(sql`UPDATE journal_entries SET created_at = now() WHERE id = ${e.id}`), /immutable/);
    await expectRejected(
      db.execute(sql`UPDATE journal_entries SET created_at = created_at - interval '1 day' WHERE id = ${e.id}`),
      /immutable/,
    );
    await expectRejected(db.execute(sql`UPDATE journal_entries SET created_at = NULL WHERE id = ${e.id}`));
    // Also refused on draft entries, so a draft cannot be made to "look new" later.
    const [draft] = await db
      .insert(journalEntries)
      .values({ companyId: ctx.companyId, entryNumber: 900001, date: new Date('2026-03-01'), description: 'draft', status: 'draft', createdBy: ctx.userId! })
      .returning();
    await expectRejected(db.execute(sql`UPDATE journal_entries SET created_at = now() WHERE id = ${draft.id}`), /immutable/);
  });

  it('a balanced pair of lines cannot be added to an OLD posted entry', async () => {
    const e = await post('15.00');
    const before = await linesOf(e.id);
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: acct['6400'], debit: '5.00' },
          { journalEntryId: e.id, accountId: acct['1000'], credit: '5.00' },
        ]);
      }),
      /LEDGER/,
    );
    expect(await linesOf(e.id)).toEqual(before);
  });

  it('balanced lines cannot be MOVED out of an old posted entry into an entry created in this transaction', async () => {
    // A four-line old entry: two independent balanced pairs. Moving one pair into a fresh
    // entry keeps every entry balanced, so only the immutability guard can stop it.
    const old = await postJournalEntry(ctx, {
      date: new Date('2026-03-02'),
      description: 'two pairs',
      lines: [
        { accountId: acct['1000'], debit: '30.00' },
        { accountId: acct['4100'], credit: '30.00' },
        { accountId: acct['6400'], debit: '7.00' },
        { accountId: acct['1000'], credit: '7.00' },
      ],
    });
    const before = await linesOf(old.id);
    await expectRejected(
      db.transaction(async (tx) => {
        const [fresh] = await tx
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 900002, date: new Date('2026-03-02'), description: 'thief', status: 'posted', createdBy: ctx.userId! })
          .returning();
        await tx.execute(sql`UPDATE journal_entry_lines SET journal_entry_id = ${fresh.id}
                             WHERE journal_entry_id = ${old.id}
                               AND ((account_id = ${acct['6400']} AND debit = 7) OR (account_id = ${acct['1000']} AND credit = 7))`);
      }),
      /LEDGER/,
    );
    expect(await linesOf(old.id)).toEqual(before);
    await expectBooksBalanced(ctx);
  });

  it('an old posted entry cannot be deleted and re-inserted under the same id inside one transaction', async () => {
    const e = await post('12.00');
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${e.id}`);
      }),
      /LEDGER/,
    );
    await expectRejected(
      db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM journal_entries WHERE id = ${e.id}`);
      }),
    );
    expect((await linesOf(e.id)).length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // session_replication_role = replica
  // -------------------------------------------------------------------------

  it('replica mode (SET LOCAL) cannot skip any of the guards', async () => {
    const e = await post('20.00');
    const cash = await balanceOf(acct['1000']);
    const attempts: Array<[string, (tx: Parameters<Parameters<DB['transaction']>[0]>[0]) => Promise<unknown>]> = [
      [
        'unbalanced posted entry',
        async (tx) => {
          const [h] = await tx
            .insert(journalEntries)
            .values({ companyId: ctx.companyId, entryNumber: 900003, date: new Date('2026-03-03'), description: 'replica', status: 'posted', createdBy: ctx.userId! })
            .returning();
          await tx.insert(journalEntryLines).values([
            { journalEntryId: h.id, accountId: acct['1000'], debit: '50.00' },
            { journalEntryId: h.id, accountId: acct['4100'], credit: '1.00' },
          ]);
        },
      ],
      ['update posted line', (tx) => tx.execute(sql`UPDATE journal_entry_lines SET account_id = ${acct['1010']} WHERE journal_entry_id = ${e.id} AND debit > 0`)],
      ['delete posted lines', (tx) => tx.execute(sql`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${e.id}`)],
      ['nudge accounts.balance', (tx) => tx.execute(sql`UPDATE accounts SET balance = balance + 1 WHERE id = ${acct['1000']}`)],
      ['truncate ledger', (tx) => tx.execute(sql`TRUNCATE journal_entry_lines CASCADE`)],
      ['re-date posted entry', (tx) => tx.execute(sql`UPDATE journal_entries SET date = '2020-01-01' WHERE id = ${e.id}`)],
    ];
    for (const [name, attack] of attempts) {
      await expectRejected(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role = replica`);
          await attack(tx);
        }),
      ).catch((err) => {
        throw new Error(`replica-mode attack "${name}" was not refused: ${String(err)}`);
      });
    }
    expect(await balanceOf(acct['1000'])).toBe(cash);
    await expectBooksBalanced(ctx);
  });

  it('replica mode set for the whole SESSION cannot skip the guards either', async () => {
    const e = await post('21.00');
    try {
      await db.execute(sql`SET session_replication_role = replica`);
      await expectRejected(
        db.execute(sql`UPDATE journal_entry_lines SET debit = debit + 1 WHERE journal_entry_id = ${e.id} AND debit > 0`),
        /LEDGER/,
      );
    } finally {
      await db.execute(sql`SET session_replication_role = origin`);
    }
    await expectBooksBalanced(ctx);
  });

  it('every registered guard exists and is ENABLE ALWAYS; a REPLICA-only guard is reported inactive', async () => {
    const res = await db.execute(sql`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'bka%' AND NOT tgisinternal`);
    const rows = (res as unknown as Rows<{ tgname: string; tgenabled: string }>).rows;
    const byName = new Map(rows.map((r) => [r.tgname, r.tgenabled]));
    for (const name of Object.keys(LEDGER_GUARD_TRIGGERS)) {
      expect(byName.get(name), `guard ${name}`).toBe('A');
    }
    // ENABLE REPLICA ('R') fires ONLY in replica sessions — i.e. never in normal use.
    await db.execute(sql`ALTER TABLE journal_entry_lines ENABLE REPLICA TRIGGER bka_jel_balanced`);
    try {
      const status = await booksInBalance(ctx);
      expect(status.guards.ok).toBe(false);
      expect(status.guards.missing).toContain('bka_jel_balanced');
      expect(status.inBalance).toBe(false);
    } finally {
      await db.execute(sql`ALTER TABLE journal_entry_lines ENABLE ALWAYS TRIGGER bka_jel_balanced`);
    }
    // A fully disabled guard is also reported.
    await db.execute(sql`ALTER TABLE journal_entries DISABLE TRIGGER bka_je_guard`);
    try {
      expect((await booksInBalance(ctx)).guards.missing).toContain('bka_je_guard');
    } finally {
      await db.execute(sql`ALTER TABLE journal_entries ENABLE ALWAYS TRIGGER bka_je_guard`);
    }
    expect((await booksInBalance(ctx)).guards.missing).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Rewrite flag binding
  // -------------------------------------------------------------------------

  it('a session-level flag PLUS a session-level txid from an earlier transaction is not honoured', async () => {
    const e = await post('9.00');
    try {
      // Both settings left behind on the connection, the txid captured in an earlier statement.
      await db.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', false),
                                  set_config('bka.ledger_rewrite_txid', txid_current()::text, false)`);
      await expectRejected(
        db.execute(sql`UPDATE journal_entry_lines SET account_id = ${acct['1010']}
                       WHERE journal_entry_id = ${e.id} AND debit > 0`),
        /LEDGER/,
      );
      await expectRejected(
        db.transaction(async (tx) => {
          await tx.execute(sql`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${e.id}`);
          await tx.execute(sql`DELETE FROM journal_entries WHERE id = ${e.id}`);
        }),
        /LEDGER/,
      );
    } finally {
      await db.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', '', false),
                                  set_config('bka.ledger_rewrite_txid', '', false)`);
    }
    expect((await linesOf(e.id)).length).toBe(2);
  });

  it('a flag with a wrong / empty txid is not honoured even when set transaction-locally', async () => {
    const e = await post('8.00');
    for (const txid of ['', '0', 'not-a-number']) {
      await expectRejected(
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
                                      set_config('bka.ledger_rewrite_txid', ${txid}, true)`);
          await tx.execute(sql`UPDATE journal_entry_lines SET account_id = ${acct['1010']}
                               WHERE journal_entry_id = ${e.id} AND debit > 0`);
        }),
        /LEDGER/,
      );
    }
  });

  it('a flag set inside a rolled-back savepoint does not survive into the rest of the transaction', async () => {
    const e = await post('6.00');
    await expectRejected(
      db.transaction(async (tx) => {
        await tx
          .transaction(async (sp) => {
            await allowLedgerRewrite({ db: sp as unknown as DB }, 'merge');
            throw new Error('rollback savepoint');
          })
          .catch(() => undefined);
        await tx.execute(sql`UPDATE journal_entry_lines SET account_id = ${acct['1010']}
                             WHERE journal_entry_id = ${e.id} AND debit > 0`);
      }),
      /LEDGER/,
    );
  });

  it('the sanctioned flag still works (txid matches inside savepoints) yet cannot unbalance the books', async () => {
    const e = await post('5.00');
    // Balanced rewrite inside a nested savepoint: allowed, balances follow.
    const cashBefore = await balanceOf(acct['1000']);
    const savBefore = await balanceOf(acct['1010']);
    await db.transaction(async (tx) => {
      await allowLedgerRewrite({ db: tx as unknown as DB }, 'merge');
      await tx.transaction(async (sp) => {
        await sp.execute(sql`UPDATE journal_entry_lines SET account_id = ${acct['1010']}
                             WHERE journal_entry_id = ${e.id} AND debit > 0`);
      });
    });
    expect(await balanceOf(acct['1000'])).toBe(Money.sub(cashBefore, '5.00').toFixed(2));
    expect(await balanceOf(acct['1010'])).toBe(Money.add(savBefore, '5.00').toFixed(2));
    // Unbalanced rewrite under the flag: still refused at COMMIT.
    await expectRejected(
      db.transaction(async (tx) => {
        await allowLedgerRewrite({ db: tx as unknown as DB }, 'merge');
        await tx.execute(sql`UPDATE journal_entry_lines SET debit = debit + 1 WHERE journal_entry_id = ${e.id} AND debit > 0`);
      }),
      /LEDGER/,
    );
    // And the flag is gone afterwards.
    await expectRejected(
      db.execute(sql`UPDATE journal_entry_lines SET account_id = ${acct['1000']} WHERE journal_entry_id = ${e.id} AND debit > 0`),
      /LEDGER/,
    );
    await expectBooksBalanced(ctx);
  });

  // -------------------------------------------------------------------------
  // Accounts that carry posted history
  // -------------------------------------------------------------------------

  it('an account with posted lines cannot be deleted', async () => {
    const acc = await createAccount(ctx, { code: '6830', name: 'QA Delete Me', type: 'expense' as never, subtype: 'operating_expenses' });
    acct['6830'] = acc.id;
    await post('4.00', '6830', '1000');
    await expectRejected(db.execute(sql`DELETE FROM accounts WHERE id = ${acc.id}`));
    await expectBooksBalanced(ctx);
  });

  it('an account with posted lines cannot be reassigned to another company (posted lines would cross companies)', async () => {
    // The deferred check refuses posted lines that point at another company's account
    // (BK001). Moving the account itself produces exactly that state, so it must be refused too.
    const acc = await createAccount(ctx, { code: '6840', name: 'QA Wanderer', type: 'expense' as never, subtype: 'operating_expenses' });
    acct['6840'] = acc.id;
    await post('3.00', '6840', '1000');
    await expectRejected(db.execute(sql`UPDATE accounts SET company_id = ${otherCtx.companyId} WHERE id = ${acc.id}`));
    const cross = await db.execute(sql`
      SELECT count(*)::int AS n FROM journal_entry_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN accounts a ON a.id = l.account_id
      WHERE e.status = 'posted' AND a.company_id <> e.company_id`);
    expect((cross as unknown as Rows<{ n: number }>).rows[0].n).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cash basis: one classifier for both reports
  // -------------------------------------------------------------------------

  it('cash-basis BS earnings equal cash-basis P&L net income with a second Accounts Payable account', async () => {
    const ap2 = await createAccount(ctx, {
      code: '2010',
      name: 'Accounts Payable - Foreign',
      type: 'liability' as never,
      subtype: 'accounts_payable',
    });
    acct['2010'] = ap2.id;
    // Unpaid bill on the second A/P account: no cash moved, so cash-basis earnings ignore it.
    await post('75.00', '6400', '2010', new Date('2026-05-01'));
    // A loan (liability, default subtype accounts_payable, not named A/P) is NOT A/P.
    const loan = await createAccount(ctx, { code: '2700', name: 'Bank Loan', type: 'liability' as never, subtype: '' });
    acct['2700'] = loan.id;
    await post('1000.00', '1000', '2700', new Date('2026-05-02'));
    // Retainage receivable billed on account (no cash).
    await post('40.00', '1250', '4100', new Date('2026-05-03'));

    const bs = await balanceSheetCashBasis(ctx);
    const pl = await profitAndLossCashBasis(ctx);
    expect(bs.balanced).toBe(true);
    expect(Money.of(bs.retainedEarnings).toFixed(2)).toBe(Money.of(pl.netIncome).toFixed(2));
    expect(bs.adjustments.removedApLines.map((l) => l.code)).toContain('2010');
    expect(bs.adjustments.removedApLines.map((l) => l.code)).not.toContain('2700');
    expect(bs.liabilities.map((l) => l.code)).toContain('2700');
  });

  it('cash-basis BS as of a past date agrees with cash-basis P&L through that date', async () => {
    await post('60.00', '1200', '4100', new Date('2026-06-10'));
    await post('25.00', '6400', '2000', new Date('2026-06-11'));
    const asOf = new Date('2026-05-31T23:59:59Z');
    const bs = await balanceSheetCashBasis(ctx, asOf);
    const pl = await profitAndLossCashBasis(ctx, { from: new Date('1970-01-01'), to: asOf });
    expect(bs.balanced).toBe(true);
    expect(Money.of(bs.retainedEarnings).toFixed(2)).toBe(Money.of(pl.netIncome).toFixed(2));
    // And through today.
    const bsNow = await balanceSheetCashBasis(ctx);
    const plNow = await profitAndLossCashBasis(ctx);
    expect(Money.of(bsNow.retainedEarnings).toFixed(2)).toBe(Money.of(plNow.netIncome).toFixed(2));
  });

  it('books stay in balance after every attack in this file', async () => {
    await expectBooksBalanced(ctx);
    await expectBooksBalanced(otherCtx);
    const status = await booksInBalance(ctx);
    expect(status.inBalance).toBe(true);
    expect(status.guards.missing).toEqual([]);
  });
});
