/**
 * Adversarial QA for the running transaction log (transactions.bktlg), written independently of
 * the implementation's own tests:
 *  - concurrent commits keep a gap-free, intact chain with every entry logged exactly once;
 *  - hostile strings (newlines, U+2028, embedded '"hash":"', quotes, emoji) cannot break sealing;
 *  - reordering lines, or re-sealing one edited line with a correct hash, is still detected;
 *  - deleting the whole log (or replacing it with a fresh genesis) is detected — posted entries
 *    must not silently become "pre-log";
 *  - after a .bka restore over the same dir, new records chain onto the RESTORED head.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { postJournalEntry } from './posting';
import { createBackup, restoreBackup } from './backup';
import {
  readAllTransactionLog,
  transactionLogPath,
  verifyTransactionLog,
  type TransactionLogRecord,
} from './transactionLog';

const DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-tlog-adversarial');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const file = () => transactionLogPath(DIR);
const lines = () => fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);

async function post(description: string, amount = '10.00') {
  return postJournalEntry(ctx, {
    date: new Date('2025-03-01'),
    description,
    lines: [
      { accountId: acct['6000'], debit: amount },
      { accountId: acct['1000'], credit: amount },
    ],
  });
}

describe('transaction log — adversarial', () => {
  beforeAll(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    db = await getDb(DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'qa@tlog.test', name: 'QA Tester', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'QA Log Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    for (const [code, name, type, subtype] of [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['6000', 'Rent', 'expense', 'operating_expenses'],
    ] as const) {
      acct[code] = (await createAccount(ctx, { code, name, type, subtype })).id;
    }
    await post('seed');
  }, 120_000);

  afterAll(async () => {
    await closeDb(DIR);
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('concurrent postings: gap-free seq, intact chain, each entry logged exactly once', async () => {
    const entries = await Promise.all(Array.from({ length: 12 }, (_, i) => post(`parallel ${i}`, `${i + 1}.01`)));
    const { records, badLines } = readAllTransactionLog(DIR);
    expect(badLines).toEqual([]);
    records.forEach((r, i) => expect(r.seq).toBe(i + 1));
    for (const e of entries) {
      const hits = records.filter((r) => r.entityType === 'journal_entry' && r.entityId === e.id && r.action === 'create');
      expect(hits, e.id).toHaveLength(1);
    }
    const v = await verifyTransactionLog(db, DIR);
    expect(v.chainIntact).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('hostile strings in business data cannot break the sealing or the chain', async () => {
    const nasty = 'Evil\n"Name",\\"hash\\":"' + '0'.repeat(64) + '"}    \u{1F4A9} ,"hash":"x';
    const c = await createCustomer(ctx, { displayName: nasty });
    const { records } = readAllTransactionLog(DIR);
    const rec = records.find((r) => r.entityType === 'customer' && r.entityId === c.id);
    expect(rec).toBeTruthy();
    expect((rec!.data as { new: { displayName: string } }).new.displayName).toBe(nasty);
    // One physical line per record: the newline in the name did not split the record.
    expect(lines().length).toBe(records.length);
    const v = await verifyTransactionLog(db, DIR);
    expect(v.chainIntact).toBe(true);
    expect(v.ok).toBe(true);
  });

  it('swapping two records is detected', async () => {
    const original = fs.readFileSync(file(), 'utf8');
    try {
      const l = lines();
      [l[2], l[3]] = [l[3], l[2]];
      fs.writeFileSync(file(), l.join('\n') + '\n');
      const v = await verifyTransactionLog(db, DIR);
      expect(v.chainIntact).toBe(false);
      expect(v.ok).toBe(false);
    } finally {
      fs.writeFileSync(file(), original);
    }
  });

  it('an edited record that is re-sealed with a correct hash still breaks the chain', async () => {
    const original = fs.readFileSync(file(), 'utf8');
    try {
      const l = lines();
      const idx = l.findIndex((x) => x.includes('"parallel 3"'));
      expect(idx).toBeGreaterThan(0);
      const rec = JSON.parse(l[idx]) as TransactionLogRecord;
      const { hash: _h, ...body } = rec;
      const forged = { ...body, summary: rec.summary.replace('$4.01', '$9,999.00') };
      const bodyText = JSON.stringify(forged);
      l[idx] = `${bodyText.slice(0, -1)},"hash":"${sha(bodyText)}"}`;
      fs.writeFileSync(file(), l.join('\n') + '\n');
      const v = await verifyTransactionLog(db, DIR);
      expect(v.chainIntact).toBe(false);
      expect(v.chainError?.line).toBe(idx + 2); // the NEXT record's prevHash no longer links
    } finally {
      fs.writeFileSync(file(), original);
    }
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
  });

  it('deleting the whole log is detected while posted entries exist', async () => {
    const original = fs.readFileSync(file(), 'utf8');
    try {
      fs.rmSync(file());
      const v = await verifyTransactionLog(db, DIR);
      expect(v.exists).toBe(false);
      // Every posted entry was created while the log was running — none may be excused as "pre-log".
      expect(v.ok).toBe(false);
    } finally {
      fs.writeFileSync(file(), original);
    }
  });

  it('cutting non-journal records off the tail of the log is detected', async () => {
    await createCustomer(ctx, { displayName: 'Tail customer' });
    const original = fs.readFileSync(file(), 'utf8');
    try {
      const l = original.split('\n').filter(Boolean);
      expect(l[l.length - 1]).toContain('Tail customer');
      fs.writeFileSync(file(), l.slice(0, -1).join('\n') + '\n');
      const v = await verifyTransactionLog(db, DIR);
      expect(v.anchored).toBe(true);
      expect(v.ok).toBe(false);
      expect(v.chainError?.reason).toMatch(/missing from the end/);
    } finally {
      fs.writeFileSync(file(), original);
    }
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
  });

  it('replacing the log with a fresh one (new genesis) is detected', async () => {
    const original = fs.readFileSync(file(), 'utf8');
    const posted = await db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.status, 'posted'));
    expect(posted.length).toBeGreaterThan(0);
    try {
      fs.rmSync(file());
      // Wait so the new genesis timestamp is strictly after the existing entries' created_at.
      await new Promise((r) => setTimeout(r, 1100));
      await createCustomer(ctx, { displayName: 'After wipe' });
      const v = await verifyTransactionLog(db, DIR);
      // The new file chains internally, but its genesis does not match the one anchored in the
      // database, so the log is reported as replaced (a broken chain).
      expect(v.chainIntact).toBe(false);
      expect(v.chainError?.reason).toMatch(/replaced/);
      // The previously logged posted entries are now unaccounted for — this must not pass.
      expect(v.preLogEntries).toBe(0);
      expect(v.ok).toBe(false);
    } finally {
      fs.writeFileSync(file(), original);
    }
  });

  it('after a .bka restore over the same dir, new records chain onto the restored head', async () => {
    expect((await verifyTransactionLog(db, DIR)).ok).toBe(true);
    const backup = createBackup('QA Log Co', DIR).buffer;
    const headBefore = readAllTransactionLog(DIR).records.at(-1)!;

    const lost = await post('after backup — will be rolled back by the restore');
    await restoreBackup(backup, DIR);
    db = await getDb(DIR);
    ctx = { ...ctx, db };
    expect(await db.select().from(journalEntries).where(eq(journalEntries.id, lost.id))).toHaveLength(0);

    const next = await post('after restore');
    const recs = readAllTransactionLog(DIR).records;
    const rec = recs.find((r) => r.entityId === next.id)!;
    expect(rec).toBeTruthy();
    expect(recs.some((r) => r.entityId === lost.id)).toBe(false);
    expect(rec.seq).toBe(headBefore.seq + 1);
    expect(rec.prevHash).toBe(headBefore.hash);
    const v = await verifyTransactionLog(db, DIR);
    expect(v.chainIntact).toBe(true);
    expect(v.ok).toBe(true);
  }, 120_000);
});
