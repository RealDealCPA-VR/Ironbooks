/**
 * P1 controls — independent tester (adversarial) checks at the database level.
 *
 *  - Ledger-table trigger allowlist must be by TABLE + name: a trigger that reuses the name of a
 *    migration trigger from another table (e.g. bka_version_expenses) but sits on
 *    journal_entry_lines is still an offline trigger that can rewrite postings.
 *  - Migration 0046 is idempotent: re-running it on a populated file changes nothing and leaves
 *    exactly one version trigger per table.
 *  - Upgraded file: a table without updated_at (pre-0046 shape) with existing rows gets the
 *    column, NOT NULL, and the version trigger moves it on change.
 *  - Version trigger: consecutive changes always produce strictly increasing versions;
 *    accounts.edited_at ignores balance-only changes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { MIGRATIONS_FOLDER, openDb } from '@/lib/db';
import { accounts, transfers } from '@/lib/db/schema';
import { checkLedgerHealth, ensureLedgerGuards, extraLedgerTriggers } from './ledgerGuards';
import { makeTestCompany, type TestCompany } from '@/lib/services/testkit.prefs';
import { createTransfer, updateTransfer } from '@/lib/services/transfers';
import { postJournalEntry } from '@/lib/services/posting';
import { trialBalance } from '@/lib/services/reports';

let t: TestCompany;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

function migration0046(): string[] {
  const text = fs.readFileSync(path.join(MIGRATIONS_FOLDER, '0046_p1_controls.sql'), 'utf8');
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

async function q<T>(text: string): Promise<T[]> {
  return (await openDb(t.dir).client.query<T>(text)).rows;
}

beforeAll(async () => {
  t = await makeTestCompany('p1-tester-db');
  await postJournalEntry(t.ctx, {
    date: D('2026-01-02'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '1000.00' },
      { accountId: t.acct['3900'], credit: '1000.00' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('ledger trigger allowlist is per table', () => {
  it('a trigger on journal_entry_lines reusing another table\'s migration trigger name is flagged and removed', async () => {
    const client = openDb(t.dir).client;
    await client.exec(`CREATE OR REPLACE FUNCTION tester_skim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    // bka_version_expenses is a real 0046 trigger name — but on expenses, not on the ledger.
    await client.exec(
      `CREATE TRIGGER bka_version_expenses BEFORE INSERT ON journal_entry_lines FOR EACH ROW EXECUTE FUNCTION tester_skim()`,
    );
    try {
      const extra = await extraLedgerTriggers(q, MIGRATIONS_FOLDER);
      expect(extra.map((x) => `${x.tbl}.${x.tgname}`)).toContain('journal_entry_lines.bka_version_expenses');
      const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER);
      expect(health.problems.some((p) => /unexpected database trigger/.test(p.detail))).toBe(true);
      await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
      const left = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'journal_entry_lines'::regclass AND tgname = 'bka_version_expenses'`,
      );
      expect(left[0].n).toBe(0);
      // ...while the real one on expenses survives.
      const real = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'expenses'::regclass AND tgname = 'bka_version_expenses'`,
      );
      expect(real[0].n).toBe(1);
    } finally {
      await client.exec(`DROP TRIGGER IF EXISTS bka_version_expenses ON journal_entry_lines`);
    }
  });
});

describe('migration 0046 on existing data', () => {
  it('re-running it on a populated file is a no-op (idempotent)', async () => {
    const tr = await createTransfer(t.ctx, {
      date: D('2026-01-05'),
      fromAccountId: t.acct['1000'],
      toAccountId: t.acct['1010'],
      amount: '25.00',
    });
    const [before] = await t.db.select().from(transfers).where(eq(transfers.id, tr.id));
    const client = openDb(t.dir).client;
    for (const stmt of migration0046()) await client.exec(stmt);
    for (const stmt of migration0046()) await client.exec(stmt);
    const [after] = await t.db.select().from(transfers).where(eq(transfers.id, tr.id));
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.amount).toBe(before.amount);
    const counts = await q<{ tbl: string; n: number }>(
      `SELECT c.relname AS tbl, count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE 'bka_version_%' GROUP BY c.relname`,
    );
    expect(counts.length).toBe(16); // 15 tables from 0046 + items (bka_version_items) from 0067
    for (const c of counts) expect(c.n, c.tbl).toBe(1);
    expect((await trialBalance(t.ctx, D('2026-12-31'))).balanced).toBe(true);
  });

  it('a pre-0046 table with existing rows gains a NOT NULL version that moves on change', async () => {
    const tr = await createTransfer(t.ctx, {
      date: D('2026-01-06'),
      fromAccountId: t.acct['1000'],
      toAccountId: t.acct['1010'],
      amount: '10.00',
    });
    const client = openDb(t.dir).client;
    // Pre-0046 shape: no updated_at, no version trigger.
    await client.exec(`DROP TRIGGER IF EXISTS bka_version_transfers ON transfers`);
    await client.exec(`ALTER TABLE transfers DROP COLUMN updated_at`);
    for (const stmt of migration0046()) await client.exec(stmt);
    const rows = await q<{ updated_at: string | null; nullable: string }>(
      `SELECT t.updated_at, (SELECT is_nullable FROM information_schema.columns WHERE table_name = 'transfers' AND column_name = 'updated_at') AS nullable
         FROM transfers t WHERE t.id = '${tr.id}'`,
    );
    expect(rows[0].updated_at).not.toBeNull();
    expect(rows[0].nullable).toBe('NO');
    const v0 = (await t.db.select().from(transfers).where(eq(transfers.id, tr.id)))[0].updatedAt.getTime();
    await updateTransfer(t.ctx, tr.id, {
      date: D('2026-01-06'),
      fromAccountId: t.acct['1000'],
      toAccountId: t.acct['1010'],
      amount: '10.00',
      memo: 'after upgrade',
    });
    const v1 = (await t.db.select().from(transfers).where(eq(transfers.id, tr.id)))[0].updatedAt.getTime();
    expect(v1).toBeGreaterThan(v0);
  });
});

describe('version trigger', () => {
  it('back-to-back raw updates give strictly increasing versions', async () => {
    const tr = await createTransfer(t.ctx, {
      date: D('2026-01-07'),
      fromAccountId: t.acct['1000'],
      toAccountId: t.acct['1010'],
      amount: '1.00',
    });
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      await t.db.execute(sql`UPDATE transfers SET memo = ${`m${i}`} WHERE id = ${tr.id}`);
      seen.push((await t.db.select().from(transfers).where(eq(transfers.id, tr.id)))[0].updatedAt.getTime());
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it('accounts: a balance-only change keeps edited_at; a rename moves it', async () => {
    const id = t.acct['6300'];
    const e0 = (await t.db.select().from(accounts).where(eq(accounts.id, id)))[0].editedAt.getTime();
    await postJournalEntry(t.ctx, {
      date: D('2026-01-08'),
      description: 'Supplies',
      lines: [
        { accountId: id, debit: '12.34' },
        { accountId: t.acct['1000'], credit: '12.34' },
      ],
    });
    const e1 = (await t.db.select().from(accounts).where(eq(accounts.id, id)))[0].editedAt.getTime();
    expect(e1).toBe(e0);
    await t.db.execute(sql`UPDATE accounts SET name = 'Office Supplies & Paper' WHERE id = ${id}`);
    const e2 = (await t.db.select().from(accounts).where(eq(accounts.id, id)))[0].editedAt.getTime();
    expect(e2).toBeGreaterThan(e1);
  });
});
