/**
 * Restore safety, re-test round 1 (independent QA on fix/restore).
 *
 * Round 1 switched disabled foreign-key triggers back on. The same offline tampering has two
 * other equally simple forms that leave a file's ledger links unenforced after open / restore:
 *  - the foreign key itself dropped (ALTER TABLE journal_entry_lines DROP CONSTRAINT ...): no
 *    trigger is left to switch back on, so nothing re-creates it;
 *  - the whole file defaulted to replica mode (ALTER DATABASE/ROLE ... SET
 *    session_replication_role = replica): every foreign-key trigger is "enabled" in the catalog
 *    but never fires, so the catalog checks report the file healthy.
 * Either way, after open a journal line can point at an entry that does not exist, which is what
 * the round-1 fix was meant to make impossible. bka_assert_entry_balanced returns early for a
 * missing entry, so only the foreign key could stop it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql, type SQL } from 'drizzle-orm';
import { closeDb, getDb, openDb, MIGRATIONS_FOLDER, type DB } from '@/lib/db';
import { checkLedgerHealth } from '@/lib/db/ledgerGuards';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { createBackup, restoreBackup } from './backup';
import { verifyIntegrity } from './integrity';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-restore-r3-'));
const dirs: string[] = [];
let seq = 0;
function newDir(name: string): string {
  const d = path.join(ROOT, `${name}-${++seq}`);
  dirs.push(d);
  return d;
}

interface Co {
  dir: string;
  db: DB;
  ctx: ServiceContext;
  acct: Record<string, string>;
}

async function makeCompany(name: string): Promise<Co> {
  const dir = newDir(name.replace(/\W/g, '').toLowerCase());
  const db = await getDb(dir);
  const [user] = await db
    .insert(users)
    .values({ email: `${name.replace(/\W/g, '')}-${Date.now()}-${seq}@test.local`, name, passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  await postJournalEntry(ctx, {
    date: new Date('2025-01-03'),
    description: 'Ads',
    lines: [
      { accountId: acct['6000'], debit: '40.01' },
      { accountId: acct['1000'], credit: '40.01' },
    ],
  });
  return { dir, db, ctx, acct };
}

async function insertOrphan(db: DB, accountId: string) {
  await db.execute(sql`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                       VALUES (gen_random_uuid(), ${accountId}, 1, 0)`);
}

async function dropLineForeignKeys(db: DB) {
  await db.execute(sql.raw(
    `ALTER TABLE journal_entry_lines DROP CONSTRAINT journal_entry_lines_journal_entry_id_journal_entries_id_fk`,
  ));
  await db.execute(sql.raw(
    `ALTER TABLE journal_entry_lines DROP CONSTRAINT journal_entry_lines_account_id_accounts_id_fk`,
  ));
}

async function defaultToReplica(db: DB) {
  await db.execute(sql.raw(
    `DO $do$ BEGIN
       EXECUTE format('ALTER DATABASE %I SET session_replication_role = replica', current_database());
       EXECUTE format('ALTER ROLE %I SET session_replication_role = replica', current_user);
     END $do$`,
  ));
}

async function one<T>(db: DB, q: SQL): Promise<T> {
  const res = await db.execute(q);
  return (res as unknown as { rows: T[] }).rows[0];
}

afterAll(async () => {
  for (const d of dirs) await closeDb(d).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('ledger foreign keys dropped offline', () => {
  it('re-opening the file puts the journal-line foreign keys back (an orphan line is rejected)', async () => {
    const co = await makeCompany('FK Dropped Co');
    await dropLineForeignKeys(co.db);
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
  });

  it('restoring a backup whose journal-line foreign keys were dropped leaves them enforced (or refuses it)', async () => {
    const co = await makeCompany('FK Dropped Restore Co');
    await dropLineForeignKeys(co.db);
    const buf = createBackup('FKDrop', co.dir).buffer;
    await closeDb(co.dir);

    const target = newDir('fk-drop-target');
    const outcome = await restoreBackup(buf, target).then(() => 'restored', (e: unknown) => e);
    if (outcome !== 'restored') return; // refusing the file is an acceptable, safe answer
    const db = await getDb(target);
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
  });

  it('Verify Data flags a missing journal-line foreign key while the file is open', async () => {
    const co = await makeCompany('FK Dropped Verify Co');
    await dropLineForeignKeys(co.db);
    const result = await verifyIntegrity(co.ctx);
    expect(result.checks.some((c) => !c.ok)).toBe(true);
  });
});

describe('company file defaulted to replica mode offline', () => {
  it('re-opening the file still enforces foreign keys on journal lines', async () => {
    const co = await makeCompany('Replica Co');
    await defaultToReplica(co.db);
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
    const role = await one<{ r: string }>(db, sql`SELECT current_setting('session_replication_role') AS r`);
    expect(role.r).toBe('origin');
  });

  it('restoring such a file leaves foreign keys enforced (or refuses it)', async () => {
    const co = await makeCompany('Replica Restore Co');
    await defaultToReplica(co.db);
    const buf = createBackup('Replica', co.dir).buffer;
    await closeDb(co.dir);

    const target = newDir('replica-target');
    const outcome = await restoreBackup(buf, target).then(() => 'restored', (e: unknown) => e);
    if (outcome !== 'restored') return;
    const db = await getDb(target);
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
  });
});

describe('no regression: a legitimate file to the penny', () => {
  it('a clean round-trip restore keeps the ledger healthy, Verify Data clean, and no notices', async () => {
    const co = await makeCompany('Clean Co');
    for (const amt of ['0.01', '0.10', '33.33', '33.34']) {
      await postJournalEntry(co.ctx, {
        date: new Date('2025-02-01'),
        description: `Penny ${amt}`,
        lines: [
          { accountId: co.acct['6000'], debit: amt },
          { accountId: co.acct['1000'], credit: amt },
        ],
      });
    }
    const buf = createBackup('Clean', co.dir).buffer;
    const target = newDir('clean-target');
    const result = await restoreBackup(buf, target);
    expect(result).toEqual({ restored: true });
    const db = await getDb(target);
    const health = await checkLedgerHealth(openDb(target).client, MIGRATIONS_FOLDER);
    expect(health.problems).toEqual([]);
    const v = await verifyIntegrity({ ...co.ctx, db });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    const bal = await one<{ b: string }>(db, sql`SELECT balance::text AS b FROM accounts WHERE id = ${co.acct['6000']}`);
    expect(Number(bal.b)).toBeCloseTo(106.79, 2);
  });
});
