/**
 * P1 controls — things added offline NEXT TO the declared guards:
 *  - an extra foreign key on a declared link with other rules (an added ON DELETE CASCADE next to
 *    the declared key) is reported and dropped on open, keeping the declared key;
 *  - a trigger added to the ledger tables outside the app is reported by checkLedgerHealth and
 *    Verify Data, and removed on open.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, openDb, MIGRATIONS_FOLDER } from '@/lib/db';
import { checkLedgerHealth, ensureLedgerGuards, extraLedgerTriggers, foreignKeyGaps } from './ledgerGuards';
import { companies, users } from '@/lib/db/schema';
import { verifyIntegrity } from '@/lib/services/integrity';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-ledger-extra-'));
const dir = path.join(ROOT, 'file');

afterAll(async () => {
  await closeDb(dir).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('undeclared keys and triggers added offline', () => {
  it('a freshly migrated file has no unexpected triggers (migration triggers with any name are known)', async () => {
    await getDb(dir);
    const client = openDb(dir).client;
    const q = async <T,>(t: string) => (await client.query<T>(t)).rows;
    expect(await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).toEqual([]);
    // The journal-application void guard (0037, a maintained bka_ guard since 0063) must survive.
    const names = (
      await q<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE tgname IN ('bk_journal_item_applications_void_guard', 'bka_jia_void_guard')`,
      )
    ).map((r) => r.tgname);
    expect(names).toEqual(['bka_jia_void_guard']);
  });

  it('an extra ON DELETE CASCADE beside the declared key is flagged and dropped on open', async () => {
    const db = await getDb(dir);
    await db.execute(
      sql.raw(`ALTER TABLE journal_entry_lines ADD CONSTRAINT x_extra_cascade FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE`),
    );
    const client = openDb(dir).client;
    const q = async <T,>(t: string) => (await client.query<T>(t)).rows;
    const gaps = await foreignKeyGaps(q, MIGRATIONS_FOLDER);
    expect(gaps.map((g) => `${g.spec.table}.${g.spec.columns.join()}:${g.state}`)).toEqual([
      'journal_entry_lines.journal_entry_id:extra',
    ]);
    expect(gaps[0].existing.map((e) => e.conname)).toEqual(['x_extra_cascade']);
    const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER);
    expect(health.problems.some((p) => p.kind === 'guards' && /extra link with other delete rules/.test(p.detail))).toBe(true);

    await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
    expect(await foreignKeyGaps(q, MIGRATIONS_FOLDER)).toEqual([]);
    const left = await q<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'journal_entry_lines'::regclass AND contype = 'f'`,
    );
    expect(left.map((r) => r.conname)).not.toContain('x_extra_cascade');
    expect(left.map((r) => r.conname)).toContain('journal_entry_lines_journal_entry_id_journal_entries_id_fk');
  });

  it('a non-guard trigger on a ledger table is reported (health + Verify Data) and removed on open', async () => {
    const db = await getDb(dir);
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION sneaky_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`),
    );
    await db.execute(sql.raw(`CREATE TRIGGER sneaky BEFORE INSERT ON journal_entry_lines FOR EACH ROW EXECUTE FUNCTION sneaky_fn()`));
    // A look-alike name that isn't one the migrations ship counts too.
    await db.execute(sql.raw(`CREATE TRIGGER bka_lookalike BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION sneaky_fn()`));
    // Triggers on non-ledger tables are not the ledger's business.
    await db.execute(sql.raw(`CREATE TRIGGER other_ok BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION sneaky_fn()`));

    const client = openDb(dir).client;
    const q = async <T,>(t: string) => (await client.query<T>(t)).rows;
    expect((await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).map((t) => `${t.tbl}.${t.tgname}`)).toEqual([
      'accounts.bka_lookalike',
      'journal_entry_lines.sneaky',
    ]);
    const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER);
    expect(health.problems.some((p) => /unexpected database triggers? (was|were) added/.test(p.detail))).toBe(true);

    // Verify Data names them.
    const [user] = await db.insert(users).values({ email: 'x@extra.local', name: 'X', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Extra Co', ownerId: user.id }).returning();
    const report = await verifyIntegrity({ db, companyId: company.id, userId: user.id });
    const guards = report.checks.find((c) => c.name === 'Database ledger guards active');
    expect(guards?.ok).toBe(false);
    expect(guards?.detail).toMatch(/unexpected trigger sneaky on journal_entry_lines/);

    await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
    expect(await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).toEqual([]);
    expect((await q<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgname = 'other_ok'`)).length).toBe(1);
    expect((await checkLedgerHealth(client, MIGRATIONS_FOLDER)).problems).toEqual([]);
  });
});
