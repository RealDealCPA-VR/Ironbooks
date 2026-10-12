/**
 * Restore safety, re-test round 2 (independent QA on fix/restore).
 *
 * Round 2 re-adds foreign keys the migrations declare when they were dropped, made NOT VALID or
 * given other delete rules offline. These tests attack that fix from other angles:
 *  - foreign key dropped AND an orphan line slipped in offline: the key cannot be re-added, so
 *    the file must be refused on open and on restore (original company untouched);
 *  - ON DELETE CASCADE swapped in / NOT VALID: put back exactly as declared;
 *  - the referenced primary key dropped (CASCADE drops the foreign key with it): refused;
 *  - non-ledger foreign keys (invoices -> customers) re-added too;
 *  - a healthy file is not churned on open (constraint oids stable), stays healthy, to the penny.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql, type SQL } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  getLedgerDamage,
  openDb,
  withDamagedFileAccess,
  LedgerDamagedError,
  MIGRATIONS_FOLDER,
  type DB,
} from '@/lib/db';
import { checkLedgerHealth } from '@/lib/db/ledgerGuards';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { createBackup, restoreBackup } from './backup';
import { verifyIntegrity } from './integrity';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-restore-r4-'));
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

async function makeCompany(name: string, dir?: string): Promise<Co> {
  dir ??= newDir(name.replace(/\W/g, '').toLowerCase());
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

async function all<T>(db: DB, q: SQL): Promise<T[]> {
  const res = await db.execute(q);
  return (res as unknown as { rows: T[] }).rows;
}

async function insertOrphan(db: DB, accountId: string) {
  await db.execute(sql`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                       VALUES (gen_random_uuid(), ${accountId}, 1, 0)`);
}

const JE_FK = 'journal_entry_lines_journal_entry_id_journal_entries_id_fk';

async function lineFks(db: DB) {
  return all<{ conname: string; convalidated: boolean; del: string; ref: string; oid: number }>(
    db,
    sql`SELECT c.conname, c.convalidated, c.confdeltype::text AS del, rc.relname AS ref, c.oid::int AS oid
          FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class rc ON rc.oid = c.confrelid
         WHERE c.contype = 'f' AND t.relname = 'journal_entry_lines' ORDER BY rc.relname`,
  );
}

async function lineCount(db: DB): Promise<number> {
  const [r] = await all<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM journal_entry_lines`);
  return r.n;
}

afterAll(async () => {
  for (const d of dirs) await closeDb(d).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('foreign key dropped and an orphan journal line slipped in offline', () => {
  it('re-opening the file refuses it (the key cannot come back while the orphan exists)', async () => {
    const co = await makeCompany('Orphan Open Co');
    await co.db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT ${JE_FK}`));
    await insertOrphan(co.db, co.acct['6000']);
    await closeDb(co.dir);

    await expect(getDb(co.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
    const damage = await getLedgerDamage(co.dir);
    expect(damage && damage.length).toBeTruthy();
    // And no later open silently "heals" it by deleting the orphan or leaving the key off.
    await closeDb(co.dir);
    await expect(getDb(co.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  });

  it('restoring such a backup is refused and the current company file is untouched', async () => {
    const live = await makeCompany('Live Co');
    const liveLines = await lineCount(live.db);

    const bad = await makeCompany('Orphan Restore Co');
    await bad.db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT ${JE_FK}`));
    await insertOrphan(bad.db, bad.acct['6000']);
    const buf = createBackup('Orphan', bad.dir).buffer;
    await closeDb(bad.dir);

    await expect(restoreBackup(buf, live.dir)).rejects.toThrow(/not restored/i);
    const db = await getDb(live.dir);
    expect(await lineCount(db)).toBe(liveLines);
    const [co] = await all<{ name: string }>(db, sql`SELECT name FROM companies`);
    expect(co.name).toBe('Live Co');
    const fks = await lineFks(db);
    expect(fks.map((f) => f.ref)).toEqual(expect.arrayContaining(['accounts', 'journal_entries']));
    await expect(insertOrphan(db, live.acct['6000'])).rejects.toThrow();
    const health = await checkLedgerHealth(openDb(live.dir).client, MIGRATIONS_FOLDER);
    expect(health.problems).toEqual([]);
  });
});

describe('foreign key rules changed offline', () => {
  it('ON DELETE CASCADE swapped in is put back to the declared rule on open', async () => {
    const co = await makeCompany('Cascade Co');
    await co.db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT ${JE_FK}`));
    await co.db.execute(sql.raw(
      `ALTER TABLE journal_entry_lines ADD CONSTRAINT ${JE_FK} FOREIGN KEY (journal_entry_id)
         REFERENCES journal_entries(id) ON DELETE CASCADE`,
    ));
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    const fk = (await lineFks(db)).filter((f) => f.ref === 'journal_entries');
    expect(fk).toHaveLength(1);
    expect(fk[0].del).toBe('a');
    expect(fk[0].convalidated).toBe(true);
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
  });

  it('a NOT VALID key is validated again on open', async () => {
    const co = await makeCompany('NotValid Co');
    await co.db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT ${JE_FK}`));
    await co.db.execute(sql.raw(
      `ALTER TABLE journal_entry_lines ADD CONSTRAINT ${JE_FK} FOREIGN KEY (journal_entry_id)
         REFERENCES journal_entries(id) NOT VALID`,
    ));
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    const fk = (await lineFks(db)).filter((f) => f.ref === 'journal_entries');
    expect(fk.every((f) => f.convalidated)).toBe(true);
  });

  it('a NOT VALID key hiding an orphan line makes the file refused, not opened', async () => {
    const co = await makeCompany('NotValid Orphan Co');
    await co.db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT ${JE_FK}`));
    await insertOrphan(co.db, co.acct['6000']);
    await co.db.execute(sql.raw(
      `ALTER TABLE journal_entry_lines ADD CONSTRAINT ${JE_FK} FOREIGN KEY (journal_entry_id)
         REFERENCES journal_entries(id) NOT VALID`,
    ));
    await closeDb(co.dir);

    await expect(getDb(co.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  });

  it('an extra CASCADE key next to the declared one cannot be used to delete posted lines', async () => {
    const co = await makeCompany('Extra Cascade Co');
    await co.db.execute(sql.raw(
      `ALTER TABLE journal_entry_lines ADD CONSTRAINT zz_evil_cascade FOREIGN KEY (account_id)
         REFERENCES accounts(id) ON DELETE CASCADE`,
    ));
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    const before = await lineCount(db);
    await expect(db.execute(sql`DELETE FROM accounts WHERE id = ${co.acct['6000']}`)).rejects.toThrow();
    expect(await lineCount(db)).toBe(before);
    const health = await checkLedgerHealth(openDb(co.dir).client, MIGRATIONS_FOLDER);
    expect(health.problems).toEqual([]);
  });
});

describe('referenced key removed offline', () => {
  it('dropping journal_entries primary key (CASCADE takes the line key with it) refuses the file', async () => {
    const co = await makeCompany('PK Drop Co');
    await co.db.execute(sql.raw(
      `DO $do$ DECLARE n text; BEGIN
         SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'journal_entries'::regclass AND contype = 'p';
         EXECUTE format('ALTER TABLE journal_entries DROP CONSTRAINT %I CASCADE', n);
       END $do$`,
    ));
    await closeDb(co.dir);

    // Either the key is fully back (the primary key re-created too) or the file is refused.
    const outcome = await getDb(co.dir).then((db) => db, (e: unknown) => e);
    if (outcome instanceof LedgerDamagedError) return;
    expect(outcome).not.toBeInstanceOf(Error);
    await expect(insertOrphan(outcome as DB, co.acct['6000'])).rejects.toThrow();
  });
});

describe('non-ledger foreign keys', () => {
  it('invoices -> customers dropped offline is re-added on open', async () => {
    const co = await makeCompany('Invoice FK Co');
    await co.db.execute(sql.raw(`ALTER TABLE invoices DROP CONSTRAINT invoices_customer_id_customers_id_fk`));
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    const fk = await all<{ n: number }>(
      db,
      sql`SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_class rc ON rc.oid = c.confrelid
          WHERE c.contype = 'f' AND t.relname = 'invoices' AND rc.relname = 'customers' AND c.convalidated`,
    );
    expect(fk[0].n).toBe(1);
  });

  it('Verify Data reports a dropped non-ledger key while the file is open', async () => {
    const co = await makeCompany('Invoice FK Verify Co');
    await co.db.execute(sql.raw(`ALTER TABLE invoices DROP CONSTRAINT invoices_customer_id_customers_id_fk`));
    const v = await verifyIntegrity(co.ctx);
    expect(v.checks.some((c) => !c.ok)).toBe(true);
  });
});

describe('no regression on a healthy file', () => {
  it('opening twice does not drop and re-add any key (constraint oids stable) and books stay balanced to the penny', async () => {
    const co = await makeCompany('Stable Co');
    for (const amt of ['0.01', '0.99', '1234.56']) {
      await postJournalEntry(co.ctx, {
        date: new Date('2025-02-01'),
        description: `Penny ${amt}`,
        lines: [
          { accountId: co.acct['6000'], debit: amt },
          { accountId: co.acct['1000'], credit: amt },
        ],
      });
    }
    const allFks = (db: DB) =>
      all<{ oid: number }>(db, sql`SELECT oid::int AS oid FROM pg_constraint WHERE contype = 'f' ORDER BY oid`);
    const before = await allFks(co.db);
    await closeDb(co.dir);
    const db = await getDb(co.dir);
    expect(await allFks(db)).toEqual(before);
    const v = await verifyIntegrity({ ...co.ctx, db });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    const [bal] = await all<{ b: string }>(db, sql`SELECT balance::text AS b FROM accounts WHERE id = ${co.acct['6000']}`);
    expect(bal.b.replace(/0+$/, '').replace(/\.$/, '')).toBe('1275.57');
  });

  it('a restored file with a dropped key (books balanced) comes back with the key enforced and books balanced', async () => {
    const co = await makeCompany('Restore Heal Co');
    await co.db.execute(sql.raw(`ALTER TABLE invoices DROP CONSTRAINT invoices_customer_id_customers_id_fk`));
    await co.db.execute(sql.raw(`ALTER TABLE journal_entry_lines DROP CONSTRAINT ${JE_FK}`));
    const buf = createBackup('Heal', co.dir).buffer;
    await closeDb(co.dir);

    const target = newDir('heal-target');
    const outcome = await restoreBackup(buf, target).then(() => 'restored', (e: unknown) => e);
    if (outcome !== 'restored') return; // refusing is also safe
    const db = await withDamagedFileAccess(() => getDb(target));
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
    const health = await checkLedgerHealth(openDb(target).client, MIGRATIONS_FOLDER);
    expect(health.problems).toEqual([]);
    const v = await verifyIntegrity({ ...co.ctx, db });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
