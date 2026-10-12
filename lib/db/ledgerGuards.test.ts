/**
 * The foreign keys ensureLedgerGuards re-asserts are read from the migration files. These tests
 * pin the parser to reality: on a freshly migrated database the parsed set must be exactly the
 * set of foreign keys the database has, and a healthy file must report no gaps (so opening a
 * healthy file never changes it).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, getLedgerDamage, openDb, LedgerDamagedError, MIGRATIONS_FOLDER } from '@/lib/db';
import { checkLedgerHealth, ensureLedgerGuards, foreignKeyGaps, ledgerGuardPlan, parseForeignKeys } from './ledgerGuards';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-ledger-guards-'));
const dir = path.join(ROOT, 'fresh');

afterAll(async () => {
  await closeDb(dir).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('parseForeignKeys', () => {
  it('reads every form the migrations use', () => {
    const fks = parseForeignKeys(`
      CREATE TABLE IF NOT EXISTS "a" (
        "id" uuid PRIMARY KEY,
        "b_id" uuid NOT NULL REFERENCES "b"("id") ON DELETE CASCADE,
        "note" text DEFAULT 'x, y',
        CONSTRAINT "a_c_id_c_id_fk" FOREIGN KEY ("c_id") REFERENCES "public"."c"("id") ON DELETE no action ON UPDATE no action
      );
      --> statement-breakpoint
      ALTER TABLE "d" ADD CONSTRAINT "d_e_fk" FOREIGN KEY ("e_id") REFERENCES "public"."e"("id") ON DELETE set null ON UPDATE no action;
      ALTER TABLE "f" ADD COLUMN IF NOT EXISTS "g_id" uuid REFERENCES "g"("id");
    `);
    expect(fks.map((f) => [f.name, f.table, f.columns.join(), f.refTable, f.onDelete, f.onUpdate])).toEqual([
      [null, 'a', 'b_id', 'b', 'c', 'a'],
      ['a_c_id_c_id_fk', 'a', 'c_id', 'c', 'a', 'a'],
      ['d_e_fk', 'd', 'e_id', 'e', 'n', 'a'],
      [null, 'f', 'g_id', 'g', 'a', 'a'],
    ]);
  });
});

describe('migration foreign-key plan vs a freshly migrated file', () => {
  it('matches the database exactly, and a healthy file has no gaps', async () => {
    const db = await getDb(dir);
    const res = await db.execute(sql`
      SELECT tc.relname AS tbl, rc.relname AS ref,
             (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
             (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols
        FROM pg_constraint c JOIN pg_class tc ON tc.oid = c.conrelid JOIN pg_class rc ON rc.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = tc.relnamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'`);
    const actual = new Set(
      (res as unknown as { rows: Array<{ tbl: string; ref: string; cols: string; refcols: string }> }).rows.map(
        (r) => `${r.tbl}(${r.cols})->${r.ref}(${r.refcols})`,
      ),
    );
    const planned = new Set(
      ledgerGuardPlan(MIGRATIONS_FOLDER).foreignKeys.map(
        (f) => `${f.table}(${f.columns.join(',')})->${f.refTable}(${f.refColumns.join(',')})`,
      ),
    );
    expect([...planned].filter((k) => !actual.has(k)).sort()).toEqual([]);
    expect([...actual].filter((k) => !planned.has(k)).sort()).toEqual([]);
    expect(planned.has('journal_entry_lines(journal_entry_id)->journal_entries(id)')).toBe(true);
    expect(planned.has('journal_entry_lines(account_id)->accounts(id)')).toBe(true);

    const client = openDb(dir).client;
    const q = async <T,>(t: string) => (await client.query<T>(t)).rows;
    expect(await foreignKeyGaps(q, MIGRATIONS_FOLDER)).toEqual([]);
    expect((await checkLedgerHealth(client, MIGRATIONS_FOLDER)).problems).toEqual([]);
  });

  it('re-adds a dropped key, validates a NOT VALID one, and restores altered delete rules', async () => {
    const db = await getDb(dir);
    await db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT journal_entry_lines_journal_entry_id_journal_entries_id_fk`));
    await db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT journal_entry_lines_account_id_accounts_id_fk`));
    await db.execute(sql.raw(`ALTER TABLE journal_entry_lines ADD CONSTRAINT x_nv FOREIGN KEY (account_id) REFERENCES accounts(id) NOT VALID`));
    await db.execute(sql.raw(`ALTER TABLE journal_entries DROP CONSTRAINT journal_entries_company_id_companies_id_fk`));
    await db.execute(sql.raw(`ALTER TABLE journal_entries ADD CONSTRAINT x_cascade FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE`));

    const client = openDb(dir).client;
    const q = async <T,>(t: string) => (await client.query<T>(t)).rows;
    const before = await foreignKeyGaps(q, MIGRATIONS_FOLDER);
    expect(before.map((g) => `${g.spec.table}.${g.spec.columns.join()}:${g.state}`).sort()).toEqual([
      'journal_entries.company_id:altered',
      'journal_entry_lines.account_id:unvalidated',
      'journal_entry_lines.journal_entry_id:missing',
    ]);
    const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER);
    expect(health.problems.some((p) => p.kind === 'guards' && /links between records/.test(p.detail))).toBe(true);

    await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
    expect(await foreignKeyGaps(q, MIGRATIONS_FOLDER)).toEqual([]);
    expect((await checkLedgerHealth(client, MIGRATIONS_FOLDER)).problems).toEqual([]);
    // Idempotent: a second run changes nothing.
    await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
    expect(await foreignKeyGaps(q, MIGRATIONS_FOLDER)).toEqual([]);
  });

  it('refuses to open a file whose key was dropped and an orphan line slipped in', async () => {
    const other = path.join(ROOT, 'orphan');
    try {
      const db = await getDb(other);
      await db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT journal_entry_lines_journal_entry_id_journal_entries_id_fk`));
      await db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT journal_entry_lines_account_id_accounts_id_fk`));
      await db.execute(sql.raw(`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                                VALUES (gen_random_uuid(), gen_random_uuid(), 1, 0)`));
      await closeDb(other);
      await expect(getDb(other)).rejects.toBeInstanceOf(LedgerDamagedError);
      const damage = await getLedgerDamage(other);
      expect(damage?.map((p) => p.kind).sort()).toEqual(['guards', 'orphan_lines']);
    } finally {
      await closeDb(other).catch(() => undefined);
    }
  });
});
