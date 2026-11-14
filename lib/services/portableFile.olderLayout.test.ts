/**
 * A portable company file (.bkp) — or an Accountant's Copy (.ibac), restored the same way — made
 * by an OLDER Ironbooks: its rows are loaded at the layout they were made with and this app's newer
 * migrations then run over them, data steps included (lib/services/portableFile.ts
 * stagingAtLayout). Loaded straight into this app's layout instead, 0066_r5_banking never linked an
 * old transfer's journal entry to it (source_ref 'transfer:<id>'), so the entry was taken for a
 * General Journal entry that could be edited apart from its transfer.
 *
 * The "older version" here is a real database built with the migrations up to 0065 only, holding a
 * transfer posted the way versions before 0066 posted it (an entry without a source).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { MIGRATIONS_FOLDER, closeDb, getDb, type DB } from '@/lib/db';
import { createPortableCompanyFile, restorePortableCompanyFile } from './portableFile';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-older-bkp-'));
const LAYOUT_TAG = '0065_r5_purchases';

afterAll(async () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

/** A database with the migrations up to `tag` only: what an older version made. */
async function olderDatabase(dir: string, tag: string): Promise<PGlite> {
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const idx = journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
  expect(idx).toBeGreaterThan(0);
  const upTo = journal.entries.slice(0, idx + 1);
  const subset = path.join(ROOT, `migrations-${tag}`);
  fs.mkdirSync(path.join(subset, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(subset, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: upTo }));
  for (const e of upTo) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(subset, `${e.tag}.sql`));
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  await pg.exec("SET TIME ZONE 'UTC'");
  await migrate(drizzle(pg), { migrationsFolder: subset });
  return pg;
}

describe('restoring a portable file made by an older version', () => {
  it('runs the newer migrations over its rows: an old transfer is linked to its journal entry', async () => {
    const src = path.join(ROOT, 'older-source');
    const pg = await olderDatabase(src, LAYOUT_TAG);
    // One company with a bank transfer, posted the way versions before 0066 did: no source_ref.
    const ids = (
      await pg.query<{ u: string; c: string; a1: string; a2: string }>(`
        WITH u AS (INSERT INTO users (email, name, password_hash) VALUES ('owner@older.test', 'Owner', 'x') RETURNING id),
             c AS (INSERT INTO companies (name, owner_id) SELECT 'Older Co', id FROM u RETURNING id),
             a1 AS (INSERT INTO accounts (company_id, code, name, type, subtype) SELECT id, '1000', 'Checking', 'asset', 'checking' FROM c RETURNING id),
             a2 AS (INSERT INTO accounts (company_id, code, name, type, subtype) SELECT id, '1010', 'Savings', 'asset', 'savings' FROM c RETURNING id)
        SELECT (SELECT id FROM u) AS u, (SELECT id FROM c) AS c, (SELECT id FROM a1) AS a1, (SELECT id FROM a2) AS a2`)
    ).rows[0];
    await pg.exec(`
      BEGIN;
      INSERT INTO journal_entries (id, company_id, entry_number, date, description, status, created_by)
        VALUES ('11111111-1111-4111-8111-111111111111', '${ids.c}', 1, '2025-01-31', 'Transfer to savings', 'posted', '${ids.u}');
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        VALUES ('11111111-1111-4111-8111-111111111111', '${ids.a2}', 250, 0),
               ('11111111-1111-4111-8111-111111111111', '${ids.a1}', 0, 250);
      INSERT INTO transfers (id, company_id, date, from_account_id, to_account_id, amount, posted_entry_id)
        VALUES ('22222222-2222-4222-8222-222222222222', '${ids.c}', '2025-01-31', '${ids.a1}', '${ids.a2}', 250, '11111111-1111-4111-8111-111111111111');
      COMMIT;`);
    const before = (await pg.query<{ s: string | null }>(`SELECT source_ref AS s FROM journal_entries`)).rows;
    expect(before).toEqual([{ s: null }]);

    // The older version's portable file of it.
    const db = drizzle(pg, { schema }) as unknown as DB;
    const file = await createPortableCompanyFile({ db, companyId: ids.c, userId: ids.u }, { dataDir: src });
    await pg.close();

    // This version restores it.
    const target = path.join(ROOT, 'restored');
    const restored = await restorePortableCompanyFile(file.buffer, target);
    expect(restored.verified.ledgersBalanced).toBe(true);
    const out = await getDb(target);
    const rows = (await out.execute(sql`SELECT source_ref AS s FROM journal_entries`)).rows as Array<{ s: string | null }>;
    expect(rows).toEqual([{ s: 'transfer:22222222-2222-4222-8222-222222222222' }]);
    // Every migration of this app is applied (the file now has this version's layout).
    const applied = (await out.execute(sql`SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations`)).rows as Array<{ n: number }>;
    const shipped = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')).entries.length;
    expect(applied[0].n).toBe(shipped);
    await closeDb(target);
  }, 240_000);
});
