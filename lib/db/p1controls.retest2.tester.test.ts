/**
 * P1 controls — re-test round 2 (independent tester): the ledger trigger allowlist compares names
 * exactly as Postgres stores them (fix 30fce5e).
 *
 *  - Parser: unquoted identifiers fold to lower case, quoted ones are kept exactly ("" unescaped),
 *    schema-qualified quoted tables are recognised, commented-out CREATE TRIGGER lines are ignored.
 *  - Every shipped trigger on a ledger table is in the allowlist under its stored name (no false
 *    alarm on a fresh file, nothing dropped on open), and the allowlist has no upper-case entries
 *    the real migrations never create.
 *  - A quoted case-twin of a shipped trigger on EVERY ledger table (bka_* guards and the non-bka
 *    void guard) is flagged by extraLedgerTriggers, checkLedgerHealth and Verify Data, and
 *    ensureLedgerGuards drops all of them while every original survives.
 *  - Odd quoted names (spaces, embedded double quotes, mixed case) are flagged and dropped without
 *    an SQL error on open.
 *  - An UNQUOTED upper-case trigger is stored lower-case by Postgres; a new one is still flagged.
 *  - After the clean-up the guards still refuse an unbalanced posting; the TB balances.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { verifyIntegrity } from '@/lib/services/integrity';

let t: TestCompany;
const D = (s: string) => new Date(`${s}T12:00:00Z`);
const qi = (n: string) => `"${n.replace(/"/g, '""')}"`;

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

async function extraKeys(): Promise<string[]> {
  return (await extraLedgerTriggers(q, MIGRATIONS_FOLDER)).map((x) => `${x.tbl}.${x.tgname}`).sort();
}

async function addTrigger(name: string, tbl: string) {
  await openDb(t.dir).client.exec(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${tbl} FOR EACH ROW EXECUTE FUNCTION retest2_noop()`,
  );
}

beforeAll(async () => {
  t = await makeTestCompany('p1-retest2-db');
  await postJournalEntry(t.ctx, {
    date: D('2026-01-02'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '1000.00' },
      { accountId: t.acct['3900'], credit: '1000.00' },
    ],
  });
  await openDb(t.dir).client.exec(
    `CREATE OR REPLACE FUNCTION retest2_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
  );
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('migration parser: identifiers as Postgres stores them', () => {
  it('folds unquoted names, keeps quoted ones exactly, unescapes "", ignores comments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-retest2-mig-'));
    try {
      fs.writeFileSync(
        path.join(dir, '0000_a.sql'),
        [
          'CREATE TRIGGER UPPER_UNQUOTED BEFORE INSERT ON JOURNAL_ENTRIES FOR EACH ROW EXECUTE FUNCTION f();',
          '--> statement-breakpoint',
          'CREATE TRIGGER "Mixed_Quoted" AFTER UPDATE OR DELETE ON "public"."accounts" FOR EACH ROW EXECUTE FUNCTION f();',
          '--> statement-breakpoint',
          'CREATE OR REPLACE TRIGGER "we""ird name" BEFORE UPDATE OF on_hold ON public.journal_entry_lines FOR EACH ROW EXECUTE FUNCTION f();',
          '--> statement-breakpoint',
          'create constraint trigger lower_ct after insert on "Quoted_Table" deferrable initially deferred for each row execute function f();',
          '--> statement-breakpoint',
          '-- CREATE TRIGGER commented_out BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION f();',
        ].join('\n'),
      );
      const known = migrationTriggerNames(dir);
      expect([...known].sort()).toEqual(
        [
          'journal_entries.upper_unquoted',
          'accounts.Mixed_Quoted',
          'journal_entry_lines.we"ird name',
          'Quoted_Table.lower_ct',
        ].sort(),
      );
      expect(known.has('accounts.mixed_quoted')).toBe(false);
      expect(known.has('journal_entries.UPPER_UNQUOTED')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every real shipped trigger on a ledger table is allowlisted under its stored name', async () => {
    const known = migrationTriggerNames(MIGRATIONS_FOLDER);
    for (const tbl of LEDGER_TABLES) {
      for (const name of await triggersOn(tbl)) expect(known.has(`${tbl}.${name}`), `${tbl}.${name}`).toBe(true);
    }
    // The real migrations ship lower-case names only: an upper-case allowlist entry would be a
    // parser slip that silently admits a quoted twin.
    for (const k of known) expect(k, k).toBe(k.toLowerCase());
    expect(await extraKeys()).toEqual([]);
  });
});

describe('quoted case-twins on every ledger table', () => {
  it('are flagged by the allowlist, checkLedgerHealth and Verify Data, and dropped on open; originals survive and still guard', async () => {
    const twins: string[] = [];
    const originals: Record<string, string[]> = {};
    for (const tbl of LEDGER_TABLES) {
      originals[tbl] = await triggersOn(tbl);
      if (!originals[tbl].length) continue; // e.g. journal_item_applications carries no trigger
      const upper = originals[tbl][0].toUpperCase();
      await addTrigger(qi(upper), tbl);
      twins.push(`${tbl}.${upper}`);
    }
    expect(twins.length).toBeGreaterThanOrEqual(3);
    // A shipped non-bka trigger gets a mixed-case twin too. (Since 0063 every trigger on the ledger
    // tables is a bka_ guard — the application void guard was renamed — so this may find none.)
    const nonBka = LEDGER_TABLES.flatMap((tbl) => originals[tbl].filter((n) => !n.startsWith('bka_')).map((n) => ({ tbl, n })));
    if (nonBka.length) {
      const { tbl, n } = nonBka[0];
      const mixed = n[0].toUpperCase() + n.slice(1);
      await addTrigger(qi(mixed), tbl);
      twins.push(`${tbl}.${mixed}`);
    }
    // Odd quoted names on journal_entry_lines.
    for (const odd of ['bka_jel balanced', 'bka"quote', 'Bka_Jel_Balanced']) {
      await addTrigger(qi(odd), 'journal_entry_lines');
      twins.push(`journal_entry_lines.${odd}`);
    }
    // An unquoted upper-case name is stored lower-case: still not shipped, still flagged.
    await addTrigger('BKA_RETEST2_UNQUOTED', 'journal_entries');
    twins.push('journal_entries.bka_retest2_unquoted');

    expect(await extraKeys()).toEqual([...twins].sort());

    const health = await checkLedgerHealth(openDb(t.dir).client, MIGRATIONS_FOLDER);
    expect(health.ok).toBe(false);
    const detail = health.problems.map((p) => p.detail).join(' | ');
    expect(detail).toMatch(new RegExp(`${twins.length} unexpected database triggers`));

    const integrity = await verifyIntegrity(t.ctx);
    const guards = integrity.checks.find((c) => c.name === 'Database ledger guards active');
    expect(guards?.ok).toBe(false);
    for (const k of twins) {
      const [tbl, ...rest] = k.split('.');
      expect(guards?.detail, k).toContain(`unexpected trigger ${rest.join('.')} on ${tbl}`);
    }

    // Opening the file removes every twin without an SQL error; every original stays.
    await ensureLedgerGuards(openDb(t.dir).client, MIGRATIONS_FOLDER);
    for (const tbl of LEDGER_TABLES) expect(await triggersOn(tbl), tbl).toEqual(originals[tbl]);
    expect(await extraKeys()).toEqual([]);
    const after = await checkLedgerHealth(openDb(t.dir).client, MIGRATIONS_FOLDER);
    expect(after.problems.filter((p) => /unexpected database trigger/.test(p.detail))).toEqual([]);
    expect((await verifyIntegrity(t.ctx)).checks.find((c) => c.name === 'Database ledger guards active')?.ok).toBe(true);

    // The guards still refuse an unbalanced posting written straight to the database.
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

  it('a lower-case quoted name equal to a shipped one is the shipped trigger itself (no false alarm)', async () => {
    // Leftovers from a failed previous case must not mask this one.
    await ensureLedgerGuards(openDb(t.dir).client, MIGRATIONS_FOLDER);
    // "bka_x" quoted lower-case == bka_x unquoted in Postgres: re-creating it collides.
    const name = (await triggersOn('journal_entry_lines')).find((n) => n.startsWith('bka_'))!;
    await expect(addTrigger(qi(name), 'journal_entry_lines')).rejects.toBeTruthy();
    expect(await extraKeys()).toEqual([]);
  });
});
