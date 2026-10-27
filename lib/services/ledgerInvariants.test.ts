/**
 * Database-level ledger invariants (drizzle/0017_team_ledger.sql).
 *
 * These tests bypass the TypeScript services and attack the tables with raw SQL, proving
 * the database itself refuses to hold an unbalanced or tampered ledger:
 *  - an unbalanced / one-line / malformed posted entry fails at COMMIT,
 *  - posted lines cannot be changed or deleted, posted headers cannot be deleted/re-dated,
 *  - accounts.balance cannot be written directly (only the ledger-derived value is accepted),
 *  - accounts.balance follows posting, voiding, drafts and type changes automatically,
 *  - the sanctioned rewrite flag allows balanced rewrites only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { ServiceError, inTransaction, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import AdmZip from 'adm-zip';
import { allowLedgerRewrite, postJournalEntry, voidJournalEntry } from './posting';
import { COMPANY_DATA_ENTRY, createCompanyBackup, restoreCompanyBackup } from './backup';
import { booksInBalance, verifyIntegrity } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ledger-invariants');

let db: DB;
let ctx: ServiceContext;
let userId: string;
const acct: Record<string, string> = {};

async function balanceOf(id: string): Promise<string> {
  const [row] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, id));
  return Number(row.b).toFixed(2);
}

/** Expect a promise to reject with a ledger SQLSTATE (raw) or translated ServiceError. */
async function expectLedgerError(p: Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the database to refuse the write').toBeDefined();
  expect(String((caught as Error).message)).toMatch(pattern);
}

async function postSimple(amount: string, status: 'posted' | 'draft' = 'posted') {
  return postJournalEntry(ctx, {
    date: new Date('2026-03-01'),
    description: 'Cash sale',
    status,
    lines: [
      { accountId: acct['1000'], debit: amount },
      { accountId: acct['4000'], credit: amount },
    ],
  });
}

describe('ledger invariants enforced by the database', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'ledger@test.local', name: 'Ledger', passwordHash: 'x' })
      .returning();
    userId = user.id;
    const [company] = await db.insert(companies).values({ name: 'Ledger Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1100', 'Savings', 'asset', 'savings'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Expense', 'expense', 'operating_expenses'],
    ] as const) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('maintains accounts.balance from posted lines (post, draft, void)', async () => {
    await postSimple('100.00');
    expect(await balanceOf(acct['1000'])).toBe('100.00');
    expect(await balanceOf(acct['4000'])).toBe('100.00');

    const draft = await postSimple('7.00', 'draft');
    expect(await balanceOf(acct['1000'])).toBe('100.00'); // drafts never touch balances

    const e = await postSimple('25.50');
    expect(await balanceOf(acct['1000'])).toBe('125.50');
    await voidJournalEntry(ctx, e.id);
    expect(await balanceOf(acct['1000'])).toBe('100.00');
    expect(await balanceOf(acct['4000'])).toBe('100.00');

    // draft -> posted applies its lines
    await db.update(journalEntries).set({ status: 'posted' }).where(eq(journalEntries.id, draft.id));
    expect(await balanceOf(acct['1000'])).toBe('107.00');
  });

  it('rejects an unbalanced posted entry inserted with raw SQL (at COMMIT)', async () => {
    const before = await balanceOf(acct['1000']);
    await expectLedgerError(
      db.transaction(async (tx) => {
        const [e] = await tx
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 9001, date: new Date(), description: 'bad', status: 'posted', createdBy: userId })
          .returning();
        await tx.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: acct['1000'], debit: '50.00' },
          { journalEntryId: e.id, accountId: acct['4000'], credit: '49.99' },
        ]);
      }),
      /out of balance/,
    );
    expect(await balanceOf(acct['1000'])).toBe(before);
    const rows = await db.select().from(journalEntries).where(eq(journalEntries.entryNumber, 9001));
    expect(rows).toHaveLength(0);
  });

  it('rejects one-line, two-sided, negative and cross-company posted entries', async () => {
    const insertEntry = (lines: Array<Record<string, unknown>>) =>
      db.transaction(async (tx) => {
        const [e] = await tx
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 9002, date: new Date(), description: 'bad', status: 'posted', createdBy: userId })
          .returning();
        await tx.insert(journalEntryLines).values(lines.map((l) => ({ journalEntryId: e.id, ...l })) as never);
      });
    await expectLedgerError(insertEntry([{ accountId: acct['1000'], debit: '0' }]), /at least two/);
    await expectLedgerError(
      insertEntry([
        { accountId: acct['1000'], debit: '10.00', credit: '10.00' },
        { accountId: acct['4000'], debit: '5.00' },
        { accountId: acct['4000'], credit: '5.00' },
      ]),
      /malformed/,
    );
    await expectLedgerError(
      insertEntry([
        { accountId: acct['1000'], debit: '-10.00' },
        { accountId: acct['4000'], credit: '-10.00' },
      ]),
      /malformed/,
    );

    // An account belonging to another company.
    const [other] = await db.insert(companies).values({ name: 'Other Co', ownerId: userId }).returning();
    const [foreign] = await db
      .insert(accounts)
      .values({ companyId: other.id, code: '1000', name: 'Foreign', type: 'asset', subtype: 'checking' })
      .returning();
    await expectLedgerError(
      insertEntry([
        { accountId: foreign.id, debit: '10.00' },
        { accountId: acct['4000'], credit: '10.00' },
      ]),
      /another company/,
    );
  });

  it('refuses to change or delete lines of a posted entry, and to delete/re-date it', async () => {
    const e = await postSimple('40.00');
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, e.id));
    const debitLine = lines.find((l) => l.debit)!;
    const before = await balanceOf(acct['1000']);

    await expectLedgerError(
      db.update(journalEntryLines).set({ debit: '400.00' }).where(eq(journalEntryLines.id, debitLine.id)),
      /cannot be changed/,
    );
    await expectLedgerError(
      db.update(journalEntryLines).set({ accountId: acct['1100'] }).where(eq(journalEntryLines.id, debitLine.id)),
      /cannot be changed/,
    );
    await expectLedgerError(
      db.delete(journalEntryLines).where(eq(journalEntryLines.journalEntryId, e.id)),
      /cannot be deleted/,
    );
    await expectLedgerError(
      db.insert(journalEntryLines).values([
        { journalEntryId: e.id, accountId: acct['1000'], debit: '1.00' },
        { journalEntryId: e.id, accountId: acct['4000'], credit: '1.00' },
      ]),
      /cannot be added/,
    );
    await expectLedgerError(db.delete(journalEntries).where(eq(journalEntries.id, e.id)), /void it instead/);
    await expectLedgerError(
      db.update(journalEntries).set({ date: new Date('2020-01-01') }).where(eq(journalEntries.id, e.id)),
      /date/,
    );
    await expectLedgerError(
      db.update(journalEntries).set({ status: 'draft' }).where(eq(journalEntries.id, e.id)),
      /draft/,
    );
    // Memo / class edits are harmless and allowed; metadata on the header too.
    await db.update(journalEntryLines).set({ memo: 'annotated' }).where(eq(journalEntryLines.id, debitLine.id));
    await db.update(journalEntries).set({ reference: 'REF-1' }).where(eq(journalEntries.id, e.id));

    // Void is final.
    await voidJournalEntry(ctx, e.id);
    await expectLedgerError(
      db.update(journalEntries).set({ status: 'posted' }).where(eq(journalEntries.id, e.id)),
      /voiding is final/,
    );
    expect(Number(await balanceOf(acct['1000']))).toBeCloseTo(Number(before) - 40, 2);
  });

  it('refuses a direct UPDATE of accounts.balance (only the ledger value is accepted)', async () => {
    const derived = await balanceOf(acct['1000']);
    await expectLedgerError(
      db.update(accounts).set({ balance: '999999.00' }).where(eq(accounts.id, acct['1000'])),
      /derived from the ledger/,
    );
    await expectLedgerError(
      db.execute(sql`UPDATE accounts SET balance = balance + 1 WHERE id = ${acct['1000']}`),
      /derived from the ledger/,
    );
    expect(await balanceOf(acct['1000'])).toBe(derived);
    // Writing the ledger-derived value (Rebuild Data) is a no-op and allowed.
    await db.update(accounts).set({ balance: derived }).where(eq(accounts.id, acct['1000']));
    // New accounts must start at zero.
    await expectLedgerError(
      db.insert(accounts).values({ companyId: ctx.companyId, code: '1999', name: 'Seeded', type: 'asset', subtype: 'checking', balance: '50.00' }),
      /zero balance/,
    );
  });

  it('re-derives the balance when an account type changes', async () => {
    const acc = await createAccount(ctx, { code: '6100', name: 'Misc', type: 'expense' as never, subtype: 'operating_expenses' });
    await postJournalEntry(ctx, {
      date: new Date('2026-03-02'),
      description: 'Spend',
      lines: [
        { accountId: acc.id, debit: '30.00' },
        { accountId: acct['1000'], credit: '30.00' },
      ],
    });
    expect(await balanceOf(acc.id)).toBe('30.00');
    await db.update(accounts).set({ type: 'revenue', subtype: 'other_income' }).where(eq(accounts.id, acc.id));
    expect(await balanceOf(acc.id)).toBe('-30.00');
  });

  it('translates commit-time ledger failures into ServiceErrors inside inTransaction', async () => {
    let caught: unknown;
    try {
      await inTransaction(ctx, async (tx) => {
        const [e] = await tx.db
          .insert(journalEntries)
          .values({ companyId: ctx.companyId, entryNumber: 9003, date: new Date(), description: 'bad', status: 'posted', createdBy: userId })
          .returning();
        await tx.db.insert(journalEntryLines).values([
          { journalEntryId: e.id, accountId: acct['1000'], debit: '5.00' },
          { journalEntryId: e.id, accountId: acct['4000'], credit: '4.00' },
        ]);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('UNBALANCED');
  });

  it('a sanctioned rewrite may restructure posted lines but must still balance at COMMIT', async () => {
    const e = await postSimple('60.00');
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, e.id));
    const debitLine = lines.find((l) => l.debit)!;
    const before1000 = await balanceOf(acct['1000']);
    const before1100 = await balanceOf(acct['1100']);

    // Balanced rewrite: re-point the debit line to another asset account — allowed.
    await inTransaction(ctx, async (tx) => {
      await allowLedgerRewrite(tx, 'merge');
      await tx.db.update(journalEntryLines).set({ accountId: acct['1100'] }).where(eq(journalEntryLines.id, debitLine.id));
    });
    expect(Number(await balanceOf(acct['1000']))).toBeCloseTo(Number(before1000) - 60, 2);
    expect(Number(await balanceOf(acct['1100']))).toBeCloseTo(Number(before1100) + 60, 2);

    // Unbalanced rewrite: still refused at COMMIT, everything rolled back.
    await expectLedgerError(
      inTransaction(ctx, async (tx) => {
        await allowLedgerRewrite(tx, 'condense');
        await tx.db.update(journalEntryLines).set({ debit: '61.00' }).where(eq(journalEntryLines.id, debitLine.id));
      }),
      /out of balance/,
    );
    expect(Number(await balanceOf(acct['1100']))).toBeCloseTo(Number(before1100) + 60, 2);

    // The flag is transaction-local: it does not leak into the next statement.
    await expectLedgerError(
      db.delete(journalEntryLines).where(eq(journalEntryLines.journalEntryId, e.id)),
      /cannot be deleted/,
    );
  });

  it('restore rebuilds balances from the ledger and refuses a tampered (unbalanced) archive', async () => {
    const { buffer } = await createCompanyBackup(db, ctx.companyId);

    // Clean restore: cached balances are re-derived from the restored ledger and match.
    const restored = await restoreCompanyBackup(db, buffer, { ownerId: userId, name: 'Ledger Co restored' });
    const srcRows = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const newRows = await db.select().from(accounts).where(eq(accounts.companyId, restored.companyId));
    const byCode = (rows: typeof srcRows) => Object.fromEntries(rows.map((r) => [r.code, r.balance]));
    expect(byCode(newRows)).toEqual(byCode(srcRows));
    const status = await booksInBalance({ db, companyId: restored.companyId, userId });
    expect(status.inBalance).toBe(true);

    // Tampered archive: one posted line's debit altered → the whole restore is refused.
    const zip = new AdmZip(buffer);
    const data = JSON.parse(zip.getEntry(COMPANY_DATA_ENTRY)!.getData().toString('utf8'));
    const entries = data.tables.journalEntries as Array<{ id: string; status: string }>;
    const posted = new Set(entries.filter((e) => e.status === 'posted').map((e) => e.id));
    const line = (data.tables.journalEntryLines as Array<{ journalEntryId: string; debit: string | null }>).find(
      (l) => posted.has(l.journalEntryId) && l.debit,
    )!;
    line.debit = (Number(line.debit) + 1).toFixed(2);
    zip.updateFile(COMPANY_DATA_ENTRY, Buffer.from(JSON.stringify(data), 'utf8'));
    const companiesBefore = (await db.select().from(companies)).length;
    await expectLedgerError(
      restoreCompanyBackup(db, zip.toBuffer(), { ownerId: userId, name: 'Tampered' }),
      /out of balance/,
    );
    expect((await db.select().from(companies)).length).toBe(companiesBefore);
  });

  it('integrity reports the guards and a live Books-in-balance status', async () => {
    const verify = await verifyIntegrity(ctx);
    const guards = verify.checks.find((c) => c.name === 'Database ledger guards active')!;
    expect(guards.ok).toBe(true);
    expect(verify.allOk).toBe(true);
    const status = await booksInBalance(ctx);
    expect(status.guards.missing).toEqual([]);
    expect(status.trialBalance.totalDebit).toBe(status.trialBalance.totalCredit);
    expect(status.inBalance).toBe(true);
  });

  it('guards fire ALWAYS (replica mode cannot skip them) and origin mode is reported as inactive', async () => {
    // Every bka_* trigger is ENABLE ALWAYS.
    // (0046's bka_version_* triggers only bump record versions for record locking — they are not
    // ledger guards and are counted separately.)
    const res = await db.execute(
      sql`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'bka%' AND tgname NOT LIKE 'bka\_version\_%' AND NOT tgisinternal`,
    );
    const rows = (res as unknown as { rows: Array<{ tgname: string; tgenabled: string }> }).rows;
    expect(rows.length).toBe(17); // 11 from 0017 + 3 non-posting guards + 1 transfer A/R-A/P guard from 0025 + 1 foreign-amount guard from 0043 + 1 journal-application void guard from 0063
    expect(rows.map((r) => r.tgname)).toContain('bka_jia_void_guard');
    expect(rows.map((r) => r.tgname)).toContain('bka_jel_fx_guard');
    const versions = await db.execute(
      sql`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'bka\_version\_%' AND NOT tgisinternal`,
    );
    expect((versions as unknown as { rows: unknown[] }).rows.length).toBe(16); // 15 from 0046 + bka_version_items from 0067
    expect(rows.filter((r) => r.tgenabled !== 'A')).toEqual([]);

    // Downgraded to origin mode ('O'), the integrity check must flag it.
    await db.execute(sql`ALTER TABLE accounts ENABLE TRIGGER bka_accounts_guard`);
    try {
      const status = await booksInBalance(ctx);
      expect(status.guards.missing).toEqual(['bka_accounts_guard']);
    } finally {
      await db.execute(sql`ALTER TABLE accounts ENABLE ALWAYS TRIGGER bka_accounts_guard`);
    }
    expect((await booksInBalance(ctx)).guards.missing).toEqual([]);
  });
});
