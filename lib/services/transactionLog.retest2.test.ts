/**
 * QA re-test (round 2) for the descent-checked transaction log anchor:
 *  - cutting SEVERAL records off the tail stays detected after the app appends on top;
 *  - replacing the head record with a forged, correctly chained one is never re-anchored;
 *  - rewriting a middle record and re-chaining every later record (a "perfect" forgery) is
 *    detected, and stays detected after later appends;
 *  - legitimate flows still advance the anchor: after a .bka restore and a .bkp restore the
 *    copy keeps logging, the anchor follows the new head and the log verifies;
 *  - a stale in-process cache (heads/parsed) never stops the anchor from advancing on an
 *    untouched file.
 * Each tamper scenario uses its own company dir because tampering is permanent by design.
 */
import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, transactionLogAnchor } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createBackup, restoreBackup } from './backup';
import { createPortableCompanyFile, restorePortableCompanyFile } from './portableFile';
import {
  readAllTransactionLog,
  resetTransactionLogCache,
  transactionLogPath,
  verifyTransactionLog,
  type TransactionLogRecord,
} from './transactionLog';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-tlog-retest2');
const opened: string[] = [];

const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');
/** Re-seal a record exactly the way the app does (hash of the JSON body, hash appended last). */
function seal(rec: Omit<TransactionLogRecord, 'hash'>): { line: string; hash: string } {
  const body = JSON.stringify(rec);
  const hash = sha256(body);
  return { line: `${body.slice(0, -1)},"hash":"${hash}"}`, hash };
}
function stripHash(r: TransactionLogRecord): Omit<TransactionLogRecord, 'hash'> {
  const { hash: _h, ...rest } = r;
  return rest;
}
const lines = (dir: string) => fs.readFileSync(transactionLogPath(dir), 'utf8').split('\n').filter(Boolean);
const writeLines = (dir: string, l: string[]) => fs.writeFileSync(transactionLogPath(dir), l.join('\n') + '\n');

async function anchorOf(db: DB) {
  return (await db.select().from(transactionLogAnchor).where(eq(transactionLogAnchor.id, 'log')))[0];
}

async function freshCompany(name: string): Promise<{ db: DB; ctx: ServiceContext; dir: string }> {
  const dir = path.join(ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const db = await getDb(dir);
  opened.push(dir);
  const [user] = await db
    .insert(users)
    .values({ email: `qa-${name}@tlog-retest2.test`, name: 'QA Round 2', passwordHash: 'x' })
    .returning();
  const [company] = await db.insert(companies).values({ name: `R2 ${name}`, ownerId: user.id }).returning();
  const ctx = { db, companyId: company.id, userId: user.id };
  for (let i = 0; i < 3; i++) await createCustomer(ctx, { displayName: `Seed ${name} ${i}` });
  return { db, ctx, dir };
}

async function expectAnchorAtHead(db: DB, dir: string) {
  resetTransactionLogCache(dir);
  const last = readAllTransactionLog(dir).records.at(-1)!;
  const a = await anchorOf(db);
  expect(a.headSeq).toBe(last.seq);
  expect(a.headHash).toBe(last.hash);
}

afterAll(async () => {
  for (const d of opened) await closeDb(d);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('transaction log anchor — re-test round 2', { timeout: 180_000 }, () => {
  it('cutting TWO records off the tail stays detected after many later appends', async () => {
    const { db, ctx, dir } = await freshCompany('cut-two');
    await createVendor(ctx, { displayName: 'Erased vendor A' });
    await createVendor(ctx, { displayName: 'Erased vendor B' });
    const before = await anchorOf(db);
    writeLines(dir, lines(dir).slice(0, -2));
    expect((await verifyTransactionLog(db, dir)).ok).toBe(false);

    for (let i = 0; i < 5; i++) await createCustomer(ctx, { displayName: `After cut ${i}` });

    const a = await anchorOf(db);
    expect(a.headSeq).toBe(before.headSeq);
    expect(a.headHash).toBe(before.headHash);
    const v = await verifyTransactionLog(db, dir);
    expect(v.ok).toBe(false);
    expect(v.chainIntact).toBe(false);
  });

  it('a forged, correctly chained replacement of the head record is never re-anchored', async () => {
    const { db, ctx, dir } = await freshCompany('forge-head');
    await createVendor(ctx, { displayName: 'Original vendor' });
    const anchored = await anchorOf(db);
    const l = lines(dir);
    const head = JSON.parse(l.at(-1)!) as TransactionLogRecord;
    // Same seq, same prevHash (chain looks perfect), different content.
    const forged = seal({ ...stripHash(head), summary: 'Created vendor Innocent Co', data: { displayName: 'Innocent Co' } });
    writeLines(dir, [...l.slice(0, -1), forged.line]);
    const v0 = await verifyTransactionLog(db, dir);
    expect(v0.ok).toBe(false);

    await createCustomer(ctx, { displayName: 'After forge 1' });
    await createCustomer(ctx, { displayName: 'After forge 2' });

    const a = await anchorOf(db);
    expect(a.headSeq).toBe(anchored.headSeq);
    expect(a.headHash).toBe(anchored.headHash);
    const v = await verifyTransactionLog(db, dir);
    expect(v.chainIntact).toBe(false);
    expect(v.ok).toBe(false);
  });

  it('rewriting a middle record and re-chaining every later record is detected for good', async () => {
    const { db, ctx, dir } = await freshCompany('rechain-middle');
    await createVendor(ctx, { displayName: 'Middle vendor' });
    for (let i = 0; i < 3; i++) await createCustomer(ctx, { displayName: `Tail ${i}` });
    const recs = lines(dir).map((x) => JSON.parse(x) as TransactionLogRecord);
    const idx = recs.findIndex((r) => r.summary.includes('Middle vendor'));
    expect(idx).toBeGreaterThan(0);
    // Full forgery: alter one record, then recompute prevHash/hash for every later record.
    const out: string[] = [];
    let prev = '';
    for (let i = 0; i < recs.length; i++) {
      if (i < idx) {
        out.push(lines(dir)[i]);
        prev = recs[i].hash;
        continue;
      }
      const base = stripHash(recs[i]);
      const edited = i === idx ? { ...base, summary: 'Created vendor Nobody', data: null } : base;
      const s = seal({ ...edited, prevHash: prev });
      out.push(s.line);
      prev = s.hash;
    }
    writeLines(dir, out);
    const v0 = await verifyTransactionLog(db, dir);
    expect(v0.ok).toBe(false); // only the anchor can catch this

    await createCustomer(ctx, { displayName: 'After rechain 1' });
    await createCustomer(ctx, { displayName: 'After rechain 2' });
    const v = await verifyTransactionLog(db, dir);
    expect(v.ok).toBe(false);
    expect(v.chainIntact).toBe(false);
  });

  it('an untouched log keeps advancing the anchor even after the in-process caches are dropped', async () => {
    const { db, ctx, dir } = await freshCompany('cache-reset');
    resetTransactionLogCache(dir);
    await createCustomer(ctx, { displayName: 'After reset' });
    await expectAnchorAtHead(db, dir);
    expect((await verifyTransactionLog(db, dir)).ok).toBe(true);
  });

  it('a .bka restored copy keeps logging and its anchor follows the new head', async () => {
    const src = await freshCompany('bka-src');
    const { buffer } = createBackup('R2 bka-src', src.dir);
    const dir = path.join(ROOT, 'bka-copy');
    fs.rmSync(dir, { recursive: true, force: true });
    await restoreBackup(buffer, dir);
    const db = await getDb(dir);
    opened.push(dir);
    expect((await verifyTransactionLog(db, dir)).ok).toBe(true);
    const ctx = { db, companyId: src.ctx.companyId, userId: src.ctx.userId };
    await createCustomer(ctx, { displayName: 'Added in bka copy' });
    await createVendor(ctx, { displayName: 'Added in bka copy (vendor)' });
    await expectAnchorAtHead(db, dir);
    expect((await verifyTransactionLog(db, dir)).ok).toBe(true);
    // The source log is untouched by the copy's writes.
    expect(readAllTransactionLog(src.dir).records.some((r) => r.summary.includes('Added in bka copy'))).toBe(false);
  });

  it('a .bkp restored copy keeps logging and its anchor follows the new head', async () => {
    const src = await freshCompany('bkp-src');
    const { buffer } = await createPortableCompanyFile(src.ctx, { dataDir: src.dir });
    const dir = path.join(ROOT, 'bkp-copy');
    fs.rmSync(dir, { recursive: true, force: true });
    await restorePortableCompanyFile(buffer, dir);
    const db = await getDb(dir);
    opened.push(dir);
    expect((await verifyTransactionLog(db, dir)).ok).toBe(true);
    const ctx = { db, companyId: src.ctx.companyId, userId: src.ctx.userId };
    await createCustomer(ctx, { displayName: 'Added in bkp copy' });
    await createVendor(ctx, { displayName: 'Added in bkp copy (vendor)' });
    await expectAnchorAtHead(db, dir);
    expect((await verifyTransactionLog(db, dir)).ok).toBe(true);
  });
});
