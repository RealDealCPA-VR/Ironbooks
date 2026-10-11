/**
 * Running transaction log (transactions.bktlg):
 *  - committed audited changes are appended (hash-chained, gap-free seq, genesis first);
 *  - rolled-back work (incl. a rolled-back nested savepoint) is never logged;
 *  - verifyTransactionLog passes for an intact log and catches tampering, deletion and
 *    posted journal entries that bypassed the log;
 *  - queryTransactionLog filters by type / user / text and returns newest first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, journalEntries } from '@/lib/db/schema';
import { inTransaction, writeAudit, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { allowLedgerRewrite, postJournalEntry, voidJournalEntry } from './posting';
import {
  GENESIS_PREV_HASH,
  queryTransactionLog,
  readAllTransactionLog,
  transactionLogPath,
  verifyTransactionLog,
  describeChange,
} from './transactionLog';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-transaction-log');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

function logLines(): string[] {
  return fs.readFileSync(transactionLogPath(TEST_DIR), 'utf8').split('\n').filter(Boolean);
}

describe('running transaction log', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'tlog@test.local', name: 'Log Tester', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'TLog Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['6000', 'Rent', 'expense', 'operating_expenses'],
    ] as const) {
      acct[code] = (await createAccount(ctx, { code, name, type, subtype })).id;
    }
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('starts with a genesis record and logs committed changes in order', async () => {
    const entry = await postJournalEntry(ctx, {
      date: new Date('2025-01-02'),
      description: 'Owner investment',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['3000'], credit: '1000.00' },
      ],
    });
    const { records } = readAllTransactionLog(TEST_DIR);
    expect(records[0].action).toBe('log_started');
    expect(records[0].prevHash).toBe(GENESIS_PREV_HASH);
    records.forEach((r, i) => expect(r.seq).toBe(i + 1));
    const last = records[records.length - 1];
    expect(last).toMatchObject({
      action: 'create',
      entityType: 'journal_entry',
      entityId: entry.id,
      userId: ctx.userId,
      userName: 'Log Tester',
      companyId: ctx.companyId,
    });
    expect(last.summary).toContain('Created journal entry #');
    expect(last.summary).toContain('$1,000.00');
    // The three account creations were logged too.
    expect(records.filter((r) => r.entityType === 'account')).toHaveLength(3);
  });

  it('never logs rolled-back work (outer rollback and nested savepoint rollback)', async () => {
    const before = logLines().length;
    await expect(
      inTransaction(ctx, async (tx) => {
        await writeAudit(tx, { action: 'create', entityType: 'customer', entityId: ctx.companyId });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(logLines().length).toBe(before);

    // Nested: the savepoint rolls back, the outer transaction commits.
    await inTransaction(ctx, async (tx) => {
      await writeAudit(tx, { action: 'update', entityType: 'vendor', entityId: ctx.companyId, newValues: { displayName: 'Kept' } });
      await tx.db
        .transaction(async (inner) => {
          await writeAudit({ ...tx, db: inner as unknown as DB }, {
            action: 'delete', entityType: 'vendor', entityId: ctx.companyId, oldValues: { displayName: 'Dropped' },
          });
          throw new Error('savepoint');
        })
        .catch(() => undefined);
    });
    const added = logLines().slice(before).map((l) => JSON.parse(l));
    expect(added).toHaveLength(1);
    expect(added[0].summary).toContain('Kept');
  });

  it('a failed posting (unbalanced) leaves no trace', async () => {
    const before = logLines().length;
    await expect(
      postJournalEntry(ctx, {
        date: new Date('2025-01-03'),
        description: 'bad',
        lines: [
          { accountId: acct['6000'], debit: '5.00' },
          { accountId: acct['1000'], credit: '4.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
    expect(logLines().length).toBe(before);
  });

  it('verifies an intact log including every posted journal entry', async () => {
    const e = await postJournalEntry(ctx, {
      date: new Date('2025-01-05'),
      description: 'Rent',
      lines: [
        { accountId: acct['6000'], debit: '250.00' },
        { accountId: acct['1000'], credit: '250.00' },
      ],
    });
    await voidJournalEntry(ctx, e.id);
    const v = await verifyTransactionLog(db, TEST_DIR);
    expect(v.chainIntact).toBe(true);
    expect(v.missingEntries).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.postedEntries).toBeGreaterThanOrEqual(1);
    const voids = queryTransactionLog(TEST_DIR, { action: 'void' });
    expect(voids.rows[0]).toMatchObject({ entityId: e.id, entityType: 'journal_entry' });
  });

  it('flags a posted journal entry that bypassed the log', async () => {
    // The ledger guards (drizzle/0017_team_ledger.sql) still require a balanced posted entry, so
    // the rogue write is a balanced entry + lines inserted straight into the tables (no log).
    const { journalEntryLines } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const rogue = await db.transaction(async (tx) => {
      const [je] = await tx
        .insert(journalEntries)
        .values({
          companyId: ctx.companyId,
          entryNumber: 999,
          date: new Date('2025-02-01'),
          description: 'Written straight to the table',
          status: 'posted',
          createdBy: ctx.userId!,
        })
        .returning();
      await tx.insert(journalEntryLines).values([
        { journalEntryId: je.id, accountId: acct['6000'], debit: '1.00', credit: null },
        { journalEntryId: je.id, accountId: acct['1000'], debit: null, credit: '1.00' },
      ]);
      return je;
    });
    const v = await verifyTransactionLog(db, TEST_DIR);
    expect(v.ok).toBe(false);
    expect(v.chainIntact).toBe(true);
    expect(v.missingEntries.map((m) => m.id)).toEqual([rogue.id]);
    // Clean up through the sanctioned rewrite path (posted entries are otherwise undeletable).
    await db.transaction(async (tx) => {
      await allowLedgerRewrite({ db: tx as unknown as DB }, 'restore');
      await tx.delete(journalEntryLines).where(eq(journalEntryLines.journalEntryId, rogue.id));
      await tx.delete(journalEntries).where(eq(journalEntries.id, rogue.id));
    });
  });

  it('detects an edited record and a deleted record', async () => {
    const file = transactionLogPath(TEST_DIR);
    const original = fs.readFileSync(file, 'utf8');
    try {
      // Edit an amount inside a record without fixing its hash.
      fs.writeFileSync(file, original.replace('1000.00', '9000.00'));
      let v = await verifyTransactionLog(db, TEST_DIR);
      expect(v.chainIntact).toBe(false);
      expect(v.chainError?.reason).toMatch(/altered/);

      // Remove a middle record.
      const lines = original.split('\n').filter(Boolean);
      lines.splice(2, 1);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      v = await verifyTransactionLog(db, TEST_DIR);
      expect(v.chainIntact).toBe(false);
      expect(v.ok).toBe(false);
    } finally {
      fs.writeFileSync(file, original);
    }
    expect((await verifyTransactionLog(db, TEST_DIR)).ok).toBe(true);
  });

  it('keeps chaining correctly after the file is replaced underneath (e.g. a restore)', async () => {
    const file = transactionLogPath(TEST_DIR);
    // Simulate a torn final write: half a record without a newline.
    fs.appendFileSync(file, '{"seq":99,"broken');
    await postJournalEntry(ctx, {
      date: new Date('2025-01-06'),
      description: 'After torn write',
      lines: [
        { accountId: acct['6000'], debit: '1.00' },
        { accountId: acct['1000'], credit: '1.00' },
      ],
    });
    const v = await verifyTransactionLog(db, TEST_DIR);
    // The torn line is reported, but the new record was not glued onto it.
    expect(v.chainIntact).toBe(false);
    expect(v.chainError?.reason).toMatch(/unreadable/);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(lines[lines.length - 1]).summary).toContain('After torn write');
    // Repair for the remaining tests: drop the torn line, keep the rest.
    fs.writeFileSync(file, lines.filter((l) => !l.includes('"broken')).join('\n') + '\n');
    expect((await verifyTransactionLog(db, TEST_DIR)).ok).toBe(true);
  });

  it('filters by type, user and text; newest first', () => {
    const all = queryTransactionLog(TEST_DIR, { companyId: ctx.companyId });
    expect(all.total).toBeGreaterThan(5);
    expect(all.rows[0].seq).toBeGreaterThan(all.rows[1].seq);
    const accounts = queryTransactionLog(TEST_DIR, { entityType: 'account' });
    expect(accounts.rows.every((r) => r.entityType === 'account')).toBe(true);
    const byUser = queryTransactionLog(TEST_DIR, { userId: ctx.userId! });
    expect(byUser.rows.every((r) => r.userId === ctx.userId)).toBe(true);
    expect(all.users).toEqual([{ userId: ctx.userId, userName: 'Log Tester' }]);
    const search = queryTransactionLog(TEST_DIR, { search: 'rent' });
    expect(search.total).toBeGreaterThan(0);
    const future = queryTransactionLog(TEST_DIR, { from: new Date(Date.now() + 86_400_000) });
    expect(future.total).toBe(0);
  });

  it('describes changes in plain language', () => {
    expect(describeChange('create', 'invoice', { new: { invoiceNumber: 1001, total: '1250.5' } })).toBe(
      'Created invoice #1001 for $1,250.50',
    );
    expect(describeChange('void', 'payment_received', { new: { amount: '20' } })).toBe(
      'Voided customer payment for $20.00',
    );
    expect(describeChange('update', 'customer', { old: { displayName: 'A', phone: '1' }, new: { displayName: 'A', phone: '2' } })).toBe(
      'Changed customer "A" (changed: phone)',
    );
  });
});
