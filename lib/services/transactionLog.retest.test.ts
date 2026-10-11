/**
 * QA re-test (round 1) for the database-anchored transaction log (transaction_log_anchor):
 *  - hooks are awaited: when an audited write returns, the anchor already points at its record;
 *  - rolled-back work moves neither the log nor the anchor;
 *  - deleting the log is detected even when the company has no posted entries yet;
 *  - deleting the log AND the anchor row is still detected while posted entries exist;
 *  - cutting records off the tail stays detected after the app appends more records on top
 *    (the anchor must not be "re-based" onto a rewritten tail).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, transactionLogAnchor } from '@/lib/db/schema';
import { inTransaction, writeAudit, type ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { postJournalEntry } from './posting';
import { readAllTransactionLog, transactionLogPath, verifyTransactionLog } from './transactionLog';

const DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-tlog-retest');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const file = () => transactionLogPath(DIR);
const anchorRow = async () => (await db.select().from(transactionLogAnchor).where(eq(transactionLogAnchor.id, 'log')))[0];

describe('transaction log anchor — re-test', () => {
  beforeAll(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    db = await getDb(DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa@tlog-retest.test', name: 'QA Retest', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'Retest Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['6000', 'Rent', 'expense', 'operating_expenses'],
    ] as const) {
      acct[code] = (await createAccount(ctx, { code, name, type, subtype })).id;
    }
  }, 120_000);

  afterAll(async () => {
    await closeDb(DIR);
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('the anchor already points at the newest record when an audited write returns', async () => {
    await createCustomer(ctx, { displayName: 'Anchor check' });
    const last = readAllTransactionLog(DIR).records.at(-1)!;
    const a = await anchorRow();
    expect(a).toBeTruthy();
    expect(a.headSeq).toBe(last.seq);
    expect(a.headHash).toBe(last.hash);
    expect(a.genesisHash).toBe(readAllTransactionLog(DIR).records[0].hash);
  });

  it('rolled-back work moves neither the log nor the anchor', async () => {
    const before = await anchorRow();
    const size = fs.statSync(file()).size;
    await expect(
      inTransaction(ctx, async (tx) => {
        await writeAudit(tx, { action: 'create', entityType: 'customer', entityId: ctx.companyId });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.statSync(file()).size).toBe(size);
    const after = await anchorRow();
    expect(after.headSeq).toBe(before.headSeq);
    expect(after.headHash).toBe(before.headHash);
  });

  it('deleting the log is detected even with no posted journal entries', async () => {
    const original = fs.readFileSync(file(), 'utf8');
    try {
      fs.rmSync(file());
      const v = await verifyTransactionLog(db, DIR);
      expect(v.postedEntries).toBe(0);
      expect(v.anchored).toBe(true);
      expect(v.ok).toBe(false);
    } finally {
      fs.writeFileSync(file(), original);
    }
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
  });

  it('deleting the log AND the anchor row is still detected while posted entries exist', async () => {
    await postJournalEntry(ctx, {
      date: new Date('2025-03-01'),
      description: 'posted before wipe',
      lines: [
        { accountId: acct['6000'], debit: '10.00' },
        { accountId: acct['1000'], credit: '10.00' },
      ],
    });
    const original = fs.readFileSync(file(), 'utf8');
    const saved = await anchorRow();
    try {
      fs.rmSync(file());
      await db.delete(transactionLogAnchor);
      const v = await verifyTransactionLog(db, DIR);
      expect(v.ok).toBe(false);
    } finally {
      fs.writeFileSync(file(), original);
      await db.insert(transactionLogAnchor).values(saved);
    }
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
  });

  // Runs last: it leaves the log in a tampered state.
  it('cutting records off the tail stays detected after more records are appended on top', async () => {
    await createVendor(ctx, { displayName: 'Vendor whose creation is erased' });
    const l = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
    expect(l.at(-1)).toContain('Vendor whose creation is erased');
    // Attacker drops the last record (a list change — no journal entry to cross-check).
    fs.writeFileSync(file(), l.slice(0, -1).join('\n') + '\n');
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(false);

    // Ordinary work continues. The app re-reads the tail and keeps appending.
    await createCustomer(ctx, { displayName: 'Later 1' });
    await createCustomer(ctx, { displayName: 'Later 2' });
    await createCustomer(ctx, { displayName: 'Later 3' });

    const recs = readAllTransactionLog(DIR).records;
    expect(recs.some((r) => r.summary.includes('Vendor whose creation is erased'))).toBe(false);
    const v = await verifyTransactionLog(db, DIR);
    // The erased record must not be laundered by later appends advancing the anchor.
    expect(v.ok).toBe(false);
  });
});
