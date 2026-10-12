/**
 * P1 controls — re-test round 1 (independent tester): the ledger trigger allowlist is keyed by
 * (table, trigger name) — fix c11c0df.
 *
 *  - A fresh file has no "unexpected" triggers: every trigger the migrations ship on a ledger
 *    table is parsed with its correct table (no false alarm, nothing dropped on open).
 *  - The allowlist contains the real pairs (expenses.bka_version_expenses,
 *    accounts.bka_version_accounts) but not a ledger table paired with another table's name.
 *  - A shipped ledger guard's name moved to a DIFFERENT ledger table is flagged and dropped, and
 *    the original guard survives and still blocks an unbalanced posting.
 *  - bka_version_accounts reused on journal_entries is flagged; the real one on accounts is not.
 *  - A quoted, differently-cased copy of a shipped guard name ("BKA_...") on the same table is a
 *    distinct trigger in Postgres and must be flagged too (names are case-sensitive when quoted).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MIGRATIONS_FOLDER, openDb } from '@/lib/db';
import {
  LEDGER_TABLES,
  checkLedgerHealth,
  ensureLedgerGuards,
  extraLedgerTriggers,
  migrationTriggerNames,
} from './ledgerGuards';
import { makeTestCompany, type TestCompany } from '@/lib/services/testkit.prefs';
import { postJournalEntry } from '@/lib/services/posting';
import { trialBalance } from '@/lib/services/reports';

let t: TestCompany;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function q<T>(text: string): Promise<T[]> {
  return (await openDb(t.dir).client.query<T>(text)).rows;
}

async function triggersOn(tbl: string): Promise<string[]> {
  return (
    await q<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = '${tbl}'::regclass AND NOT tgisinternal ORDER BY tgname`,
    )
  ).map((r) => r.tgname);
}

beforeAll(async () => {
  t = await makeTestCompany('p1-retest1-db');
  await postJournalEntry(t.ctx, {
    date: D('2026-01-02'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '1000.00' },
      { accountId: t.acct['3900'], credit: '1000.00' },
    ],
  });
  await openDb(t.dir).client.exec(
    `CREATE OR REPLACE FUNCTION retest_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
  );
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('trigger allowlist keyed by table + name', () => {
  it('a fresh company file reports no unexpected ledger triggers (every shipped trigger parsed with its table)', async () => {
    expect(await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).toEqual([]);
    const health = await checkLedgerHealth(openDb(t.dir).client, MIGRATIONS_FOLDER);
    expect(health.problems.filter((p) => /unexpected database trigger/.test(p.detail))).toEqual([]);
    // Opening the file again (ensureLedgerGuards) must not drop any shipped trigger.
    const before: Record<string, string[]> = {};
    for (const tbl of LEDGER_TABLES) before[tbl] = await triggersOn(tbl);
    await ensureLedgerGuards(openDb(t.dir).client, MIGRATIONS_FOLDER);
    for (const tbl of LEDGER_TABLES) expect(await triggersOn(tbl), tbl).toEqual(before[tbl]);
    expect(before.accounts).toContain('bka_version_accounts');
  });

  it('the allowlist holds real (table, name) pairs only', () => {
    const known = migrationTriggerNames(MIGRATIONS_FOLDER);
    expect(known.has('expenses.bka_version_expenses')).toBe(true);
    expect(known.has('accounts.bka_version_accounts')).toBe(true);
    expect(known.has('journal_entry_lines.bka_version_expenses')).toBe(false);
    expect(known.has('journal_entries.bka_version_accounts')).toBe(false);
    // No bare names left over from the old name-only allowlist.
    for (const k of known) expect(k, k).toMatch(/^\w+\.\w+$/);
  });

  it('a shipped ledger guard name copied onto a different ledger table is flagged and removed; the real guard stays and still works', async () => {
    const jelGuards = (await triggersOn('journal_entry_lines')).filter((n) => n.startsWith('bka'));
    expect(jelGuards.length).toBeGreaterThan(0);
    const borrowed = jelGuards[0];
    const client = openDb(t.dir).client;
    await client.exec(`CREATE TRIGGER ${borrowed} BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION retest_noop()`);
    try {
      const extra = await extraLedgerTriggers(q, MIGRATIONS_FOLDER);
      expect(extra.map((x) => `${x.tbl}.${x.tgname}`)).toEqual([`accounts.${borrowed}`]);
      await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
      expect(await triggersOn('accounts')).not.toContain(borrowed);
      expect(await triggersOn('journal_entry_lines')).toContain(borrowed);
    } finally {
      await client.exec(`DROP TRIGGER IF EXISTS ${borrowed} ON accounts`);
    }
    // The ledger guards still refuse an unbalanced posting written straight to the database.
    await expect(
      t.db.execute(sql`
        WITH e AS (
          INSERT INTO journal_entries (company_id, date, description, status)
          VALUES (${t.ctx.companyId}, ${D('2026-01-03').toISOString()}, 'raw unbalanced', 'posted')
          RETURNING id
        )
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        SELECT e.id, ${t.acct['1000']}, '5.00', '0' FROM e`),
    ).rejects.toBeTruthy();
    expect((await trialBalance(t.ctx, D('2026-12-31'))).balanced).toBe(true);
  });

  it('bka_version_accounts reused on journal_entries is flagged; the one on accounts is not', async () => {
    const client = openDb(t.dir).client;
    await client.exec(
      `CREATE TRIGGER bka_version_accounts BEFORE UPDATE ON journal_entries FOR EACH ROW EXECUTE FUNCTION retest_noop()`,
    );
    try {
      const extra = (await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).map((x) => `${x.tbl}.${x.tgname}`);
      expect(extra).toEqual(['journal_entries.bka_version_accounts']);
      await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
      expect(await triggersOn('journal_entries')).not.toContain('bka_version_accounts');
      expect(await triggersOn('accounts')).toContain('bka_version_accounts');
    } finally {
      await client.exec(`DROP TRIGGER IF EXISTS bka_version_accounts ON journal_entries`);
    }
  });

  it('a quoted upper-case twin of a shipped guard on the same table is a different trigger and is flagged', async () => {
    const jelGuards = (await triggersOn('journal_entry_lines')).filter((n) => n.startsWith('bka'));
    const twin = jelGuards[0].toUpperCase();
    const client = openDb(t.dir).client;
    await client.exec(
      `CREATE TRIGGER "${twin}" BEFORE INSERT ON journal_entry_lines FOR EACH ROW EXECUTE FUNCTION retest_noop()`,
    );
    try {
      // Postgres now has two distinct triggers on the table: the guard and its twin.
      expect((await triggersOn('journal_entry_lines')).filter((n) => n.toLowerCase() === jelGuards[0])).toHaveLength(2);
      const extra = (await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).map((x) => `${x.tbl}.${x.tgname}`);
      expect(extra).toContain(`journal_entry_lines.${twin}`);
    } finally {
      await client.exec(`DROP TRIGGER IF EXISTS "${twin}" ON journal_entry_lines`);
    }
  });
});
