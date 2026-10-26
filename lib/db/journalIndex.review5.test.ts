/**
 * Round-5 review regression (performance on a large company file): every posting takes the next
 * entry number with MAX(entry_number) for its company (posting.ts nextEntryNumber), and the journal
 * window lists the newest entries by date. The only index on journal_entries by company was
 * (company_id, status), so both read every entry of the company — a cost that grows with the file
 * and is paid on EVERY posting (a QuickBooks conversion of a large file posts tens of thousands of
 * entries, so the import slowed down quadratically). 0063 adds (company_id, entry_number) and
 * (company_id, date, entry_number).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, openDb } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-je-idx-r5-'));
const dir = path.join(ROOT, 'file');

afterAll(async () => {
  await closeDb(dir).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('journal entry number and date lookups use an index (review round 5)', () => {
  it('the next entry number and the newest entries do not read the whole journal', async () => {
    const db = await getDb(dir);
    const [user] = await db.insert(users).values({ email: 'r5@je.idx', name: 'Jen', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Big Co', ownerId: user.id }).returning();
    const [other] = await db.insert(companies).values({ name: 'Other Co', ownerId: user.id }).returning();
    const client = openDb(dir).client;
    // Years of a busy company (drafts: no lines needed), plus a second company in the same file.
    for (const id of [company.id, other.id]) {
      await client.query(
        `INSERT INTO journal_entries (company_id, entry_number, date, description, status, created_by, source_ref)
         SELECT $1::uuid, g, timestamp '2018-01-01' + (g || ' hours')::interval, 'Entry', 'draft', $2::uuid, 'invoice:' || g
           FROM generate_series(1, 40000) g`,
        [id, user.id],
      );
    }
    await client.query('ANALYZE journal_entries');
    const plan = async (sql: string, params: unknown[]) =>
      (await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');

    // posting.ts nextEntryNumber
    const next = await plan('SELECT COALESCE(MAX(entry_number), 0) FROM journal_entries WHERE company_id = $1', [company.id]);
    expect(next).toMatch(/je_company_entry_number_idx/);
    expect(next).not.toMatch(/Bitmap Heap Scan|Seq Scan/);

    // journal.ts listEntries (the journal window, newest first)
    const newest = await plan(
      'SELECT * FROM journal_entries WHERE company_id = $1 ORDER BY date DESC, entry_number DESC LIMIT 100',
      [company.id],
    );
    expect(newest).toMatch(/je_company_date_idx/);
    expect(newest).not.toMatch(/Sort/);
  });
});
