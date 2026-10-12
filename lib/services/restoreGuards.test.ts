/**
 * P0 goal break (PARITY.md final audit): a full .bka restore, a condense-archive restore and
 * POST /api/backup accepted a company file whose ledger guard triggers had been disabled offline
 * and whose books were out of balance — and left the guards off afterwards.
 *
 * Now:
 *  - every company-file open re-installs the ledger guards (functions recreated, triggers
 *    recreated + ENABLE ALWAYS) and refuses a file whose ledger is damaged;
 *  - restore opens the restored file, re-installs the guards and verifies the books (every
 *    entry balanced, cached balances = ledger, trial balance + balance sheets, guards on); any
 *    problem rolls back to the original file and returns a plain-language error.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, withDamagedFileAccess, LedgerDamagedError, MIGRATIONS_FOLDER, type DB } from '@/lib/db';
import { ledgerGuardPlan } from '@/lib/db/ledgerGuards';
import { accounts, companies, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { createBackup, restoreBackup } from './backup';
import { condenseArchiveDir, restoreCondenseArchive } from './condense';
import { LEDGER_GUARD_TRIGGERS, booksInBalance } from './integrity';
import { trialBalance } from './reports';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSessionUserId: async () => session.userId,
    getSessionInfo: async () => (session.userId ? { userId: session.userId } : null),
  };
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-restore-guards-'));
const dirs: string[] = [];
function newDir(name: string): string {
  const d = path.join(ROOT, name);
  dirs.push(d);
  return d;
}

interface Co {
  dir: string;
  db: DB;
  ctx: ServiceContext;
  userId: string;
  firstEntryId: string;
}

/** The auditor's company: 100.00 Dr expense / Cr 1000, plus 25 more entries. */
async function makeCompany(dir: string, name: string): Promise<Co> {
  const db = await getDb(dir);
  const [user] = await db
    .insert(users)
    .values({ email: `${name.replace(/\W/g, '')}-${Date.now()}@test.local`, name, passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  const first = await postJournalEntry(ctx, {
    date: new Date('2025-01-02'),
    description: 'Ads',
    lines: [
      { accountId: acct['6000'], debit: '100.00' },
      { accountId: acct['1000'], credit: '100.00' },
    ],
  });
  for (let i = 1; i <= 25; i++) {
    await postJournalEntry(ctx, {
      date: new Date('2025-01-03'),
      description: `Entry ${i}`,
      lines: [
        { accountId: acct['6100'], debit: `${i}.01` },
        { accountId: acct['1000'], credit: `${i}.01` },
      ],
    });
  }
  return { dir, db, ctx, userId: user.id, firstEntryId: first.id };
}

async function guardModes(db: DB): Promise<Record<string, string>> {
  const res = await db.execute(sql`SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'bka%'`);
  const rows = (res as unknown as { rows: Array<{ tgname: string; tgenabled: string }> }).rows;
  return Object.fromEntries(rows.map((r) => [r.tgname, r.tgenabled]));
}

/** The auditor's tampering: guards off via raw SQL, then one debit corrupted. */
async function disableGuards(db: DB) {
  await db.execute(sql`ALTER TABLE journal_entry_lines DISABLE TRIGGER ALL`);
  await db.execute(sql`ALTER TABLE journal_entries DISABLE TRIGGER ALL`);
  await db.execute(sql`ALTER TABLE accounts DISABLE TRIGGER ALL`);
}
async function corruptDebit(db: DB, entryId: string) {
  await db.execute(
    sql`UPDATE journal_entry_lines SET debit = 90 WHERE journal_entry_id = ${entryId} AND debit > 0`,
  );
}

function leftovers(dir: string): string[] {
  const base = path.basename(dir);
  return fs
    .readdirSync(path.dirname(dir))
    .filter((f) => f.startsWith(`${base}.pre-restore-`) || f.startsWith(`${base}.restore-tmp-`));
}

let good: Co; // the live company file restores are attempted over
let goodTb: Awaited<ReturnType<typeof trialBalance>>;
let goodBackup: Buffer;
let tamperedBackup: Buffer;

describe('restore re-asserts ledger guards and refuses damaged books', () => {
  beforeAll(async () => {
    good = await makeCompany(newDir('live'), 'Live Co');
    goodTb = await trialBalance(good.ctx);
    goodBackup = createBackup('Live Co', good.dir).buffer;

    const bad = await makeCompany(newDir('audit'), 'Audit Co');
    await disableGuards(bad.db);
    await corruptDebit(bad.db, bad.firstEntryId);
    tamperedBackup = createBackup('Audit Co', bad.dir).buffer;
    await closeDb(bad.dir);
  }, 240_000);

  afterAll(async () => {
    for (const d of dirs) await closeDb(d).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('every guard the migrations ship is known to Verify Data (and vice versa)', () => {
    expect(ledgerGuardPlan(MIGRATIONS_FOLDER).triggers).toEqual(Object.keys(LEDGER_GUARD_TRIGGERS).sort());
  });

  it("auditor's scenario: a tampered .bka (guards off, unbalanced) is refused and the live file is untouched", async () => {
    const err = await restoreBackup(tamperedBackup, good.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/not restored because the books in it are damaged/);
    expect(err.message).toMatch(/out of balance/);
    expect(err.message).toMatch(/current company file has not been changed/);

    // Original company file: same company, same trial balance, every guard on.
    const db = await getDb(good.dir);
    const names = (await db.select({ name: companies.name }).from(companies)).map((c) => c.name);
    expect(names).toEqual(['Live Co']);
    const tb = await trialBalance({ ...good.ctx, db });
    expect(tb.rows).toEqual(goodTb.rows);
    expect(tb.balanced).toBe(true);
    const modes = await guardModes(db);
    for (const t of Object.keys(LEDGER_GUARD_TRIGGERS)) expect(modes[t]).toBe('A');
    expect(leftovers(good.dir)).toEqual([]);
    good.db = db;
  });

  it('a .bka whose guards were turned off but whose books balance restores with every guard back on', async () => {
    const src = await makeCompany(newDir('guards-off'), 'Guards Off Co');
    await disableGuards(src.db);
    const buf = createBackup('Guards Off Co', src.dir).buffer;
    await closeDb(src.dir);

    const target = newDir('guards-off-target');
    await restoreBackup(buf, target);
    const db = await getDb(target);
    const modes = await guardModes(db);
    for (const t of Object.keys(LEDGER_GUARD_TRIGGERS)) expect(modes[t]).toBe('A');
    // The guards really work again: corrupting a posted line is refused.
    const [entry] = await db.select({ id: journalEntries.id }).from(journalEntries).limit(1);
    await expect(corruptDebit(db, entry.id)).rejects.toThrow();
    const [co] = await db.select({ id: companies.id }).from(companies);
    expect((await booksInBalance({ db, companyId: co.id, userId: null })).inBalance).toBe(true);
  });

  it('a .bka whose guard function was replaced by a no-op gets the real function back', async () => {
    const src = await makeCompany(newDir('noop-fn'), 'Noop Co');
    await src.db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION bka_assert_entry_balanced(p_entry uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$`),
    );
    await src.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION bka_jel_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN COALESCE(NEW, OLD); END; $$`));
    const buf = createBackup('Noop Co', src.dir).buffer;
    await closeDb(src.dir);

    const target = newDir('noop-fn-target');
    await restoreBackup(buf, target);
    const db = await getDb(target);
    const [entry] = await db.select({ id: journalEntries.id }).from(journalEntries).limit(1);
    await expect(corruptDebit(db, entry.id)).rejects.toThrow();
  });

  it('a damaged backup over a brand-new location leaves nothing behind', async () => {
    const target = newDir('fresh-target');
    await expect(restoreBackup(tamperedBackup, target)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('condense-archive restore refuses a tampered archive copy and keeps the live file', async () => {
    const archDir = condenseArchiveDir(good.dir);
    fs.mkdirSync(archDir, { recursive: true });
    const file = path.join(archDir, 'tampered-archive.bka');
    fs.writeFileSync(file, tamperedBackup);
    fs.writeFileSync(
      path.join(archDir, 'condense-archives.json'),
      JSON.stringify([
        {
          id: 'run-1',
          path: file,
          filename: 'tampered-archive.bka',
          createdAt: new Date().toISOString(),
          dataDir: path.resolve(good.dir),
          companyId: good.ctx.companyId,
          companyName: 'Live Co',
          beforeDate: '2025-01-01',
          entriesCondensed: 1,
          sizeBytes: tamperedBackup.length,
        },
      ]),
    );
    const err = await restoreCondenseArchive({ ...good.ctx, db: good.db, role: 'owner' }, 'run-1', good.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/books in it are damaged/);
    const db = await getDb(good.dir);
    expect((await trialBalance({ ...good.ctx, db })).rows).toEqual(goodTb.rows);
    good.db = db;
  });

  it('POST /api/backup with the tampered file answers 400 with a plain-language reason', async () => {
    const prevDir = process.env.BKA_DATA_DIR;
    process.env.BKA_DATA_DIR = good.dir;
    session.userId = good.userId;
    try {
      const { POST } = await import('@/app/api/backup/route');
      const res = await POST(
        new NextRequest('http://localhost/api/backup', { method: 'POST', body: new Uint8Array(tamperedBackup) }),
      );
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(body.code).toBe('VALIDATION');
      expect(body.error).toMatch(/books in it are damaged/);
      const db = await getDb(good.dir);
      expect((await trialBalance({ ...good.ctx, db })).rows).toEqual(goodTb.rows);
      good.db = db;
    } finally {
      session.userId = null;
      if (prevDir === undefined) delete process.env.BKA_DATA_DIR;
      else process.env.BKA_DATA_DIR = prevDir;
    }
  });
});

describe('opening a company file re-asserts the ledger guards', () => {
  afterAll(async () => {
    for (const d of dirs) await closeDb(d).catch(() => undefined);
  });

  it('a file whose guards were turned off offline gets them back on open', async () => {
    const co = await makeCompany(newDir('open-guards-off'), 'Open Co');
    await disableGuards(co.db);
    expect(await guardModes(co.db)).toMatchObject({ bka_jel_balanced: 'D', bka_jel_guard: 'D', bka_accounts_guard: 'D' });
    await closeDb(co.dir);

    const db = await getDb(co.dir);
    const modes = await guardModes(db);
    for (const t of Object.keys(LEDGER_GUARD_TRIGGERS)) expect(modes[t]).toBe('A');
    await expect(corruptDebit(db, co.firstEntryId)).rejects.toThrow();
  });

  it('a file with an unbalanced ledger is refused on open (QB: damaged file); a good backup can replace it', async () => {
    const co = await makeCompany(newDir('open-damaged'), 'Damaged Co');
    await disableGuards(co.db);
    await corruptDebit(co.db, co.firstEntryId);
    await closeDb(co.dir);

    const err = await getDb(co.dir).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerDamagedError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/company file is damaged/);
    expect(err.message).toMatch(/#1: debits 90\.00, credits 100\.00/);
    expect(err.message).toMatch(/Restore your most recent backup/);

    // Guards were still re-installed, so nothing more can be written around them.
    const db = await withDamagedFileAccess(() => getDb(co.dir));
    const modes = await guardModes(db);
    for (const t of Object.keys(LEDGER_GUARD_TRIGGERS)) expect(modes[t]).toBe('A');

    // Signing in still works (the only way to reach Back Up and Restore): a wrong password is a
    // normal 401, not a crash.
    const prevDir = process.env.BKA_DATA_DIR;
    process.env.BKA_DATA_DIR = co.dir;
    try {
      const { POST: login } = await import('@/app/api/auth/login/route');
      const res = await login(
        new NextRequest('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@test.local', password: 'wrong-password' }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      if (prevDir === undefined) delete process.env.BKA_DATA_DIR;
      else process.env.BKA_DATA_DIR = prevDir;
    }

    // Restoring a good backup over the damaged file works and the file opens again.
    await restoreBackup(goodBackup, co.dir);
    const restored = await getDb(co.dir);
    const names = (await restored.select({ name: companies.name }).from(companies)).map((c) => c.name);
    expect(names).toEqual(['Live Co']);
  });
});
