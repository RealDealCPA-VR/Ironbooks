/**
 * Independent adversarial QA for the P0 "restore safety" fix (PARITY.md final audit).
 *
 * The doer's restoreGuards.test.ts covers the auditor's exact repro. This file attacks the fix
 * from other angles:
 *  - other kinds of offline tampering (cross-company lines, non-posting accounts, malformed
 *    lines, deleted lines, hidden entries, cached-balance drift) must be refused by restore and,
 *    where the ledger is damaged, by open;
 *  - the auditor's DISABLE TRIGGER ALL also turns off the database's own foreign-key triggers —
 *    restore/open must not leave those off either;
 *  - a busy, legitimate file (invoices, partial payment, penny rounding, voids, bills, bill
 *    payment, two companies) must NOT be refused (no false positives) and must tie out after
 *    restore (TB, balance sheet, A/R + A/P control);
 *  - permissions still hold on a damaged file; a damaged file in one folder never blocks another;
 *  - the recovery paths offered by the refusal message actually work on a damaged file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, withDamagedFileAccess, LedgerDamagedError, type DB } from '@/lib/db';
import { accounts, companies, invoices, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry, voidJournalEntry } from './posting';
import { createBackup, restoreBackup } from './backup';
import { condenseArchiveDir } from './condense';
import { booksInBalance, verifyIntegrity } from './integrity';
import { trialBalance } from './reports';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice, voidInvoice } from './invoices';
import { receivePayment } from './payments';
import { createBill } from './bills';
import { payBills } from './billPayments';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSessionUserId: async () => session.userId,
    getSessionInfo: async () => (session.userId ? { userId: session.userId } : null),
  };
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-restore-adv-'));
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
  userId: string;
  acct: Record<string, string>;
  entryIds: string[];
}

async function addCompany(db: DB, dir: string, name: string, userId?: string): Promise<Co> {
  let uid = userId;
  if (!uid) {
    const [user] = await db
      .insert(users)
      .values({ email: `${name.replace(/\W/g, '')}-${Date.now()}-${seq}@test.local`, name, passwordHash: 'x' })
      .returning();
    uid = user.id;
  }
  const company = await createCompany(db, { name, ownerId: uid });
  const ctx: ServiceContext = { db, companyId: company.id, userId: uid };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  const entryIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const e = await postJournalEntry(ctx, {
      date: new Date('2025-01-03'),
      description: `Entry ${i}`,
      lines: [
        { accountId: acct['6000'], debit: `${i}0.00` },
        { accountId: acct['1000'], credit: `${i}0.00` },
      ],
    });
    entryIds.push(e.id);
  }
  return { dir, db, ctx, userId: uid, acct, entryIds };
}

async function makeCompany(name: string): Promise<Co> {
  const dir = newDir(name.replace(/\W/g, '').toLowerCase());
  const db = await getDb(dir);
  return addCompany(db, dir, name);
}

async function disableAll(db: DB) {
  for (const t of ['journal_entry_lines', 'journal_entries', 'accounts']) {
    await db.execute(sql.raw(`ALTER TABLE ${t} DISABLE TRIGGER ALL`));
  }
}

async function rawRows<T>(db: DB, q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

/** Tamper with a file offline, back it up, close it. */
async function tamperedBackupOf(co: Co, tamper: (db: DB) => Promise<void>): Promise<Buffer> {
  await disableAll(co.db);
  await tamper(co.db);
  const buf = createBackup('Tampered', co.dir).buffer;
  await closeDb(co.dir);
  return buf;
}

let live: Co;
let liveTb: Awaited<ReturnType<typeof trialBalance>>;

async function expectLiveUntouched() {
  const db = await getDb(live.dir);
  const names = (await db.select({ name: companies.name }).from(companies)).map((c) => c.name);
  expect(names).toEqual(['Live Co']);
  const tb = await trialBalance({ ...live.ctx, db });
  expect(tb.rows).toEqual(liveTb.rows);
  expect(tb.balanced).toBe(true);
  live.db = db;
}

beforeAll(async () => {
  live = await makeCompany('Live Co');
  liveTb = await trialBalance(live.ctx);
}, 120_000);

afterAll(async () => {
  for (const d of dirs) await closeDb(d).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('restore refuses every kind of damaged ledger, not just the auditor\'s one', () => {
  it('balanced lines moved onto ANOTHER company\'s account (two-company file) are refused; live file untouched', async () => {
    const a = await makeCompany('Cross A');
    const b = await addCompany(a.db, a.dir, 'Cross B', a.userId);
    const buf = await tamperedBackupOf(a, async (db) => {
      // Re-point both lines of A's entry at B's accounts: still debits = credits.
      await db.execute(sql`UPDATE journal_entry_lines SET account_id = ${b.acct['6000']}
                           WHERE journal_entry_id = ${a.entryIds[0]} AND account_id = ${a.acct['6000']}`);
      await db.execute(sql`UPDATE journal_entry_lines SET account_id = ${b.acct['1000']}
                           WHERE journal_entry_id = ${a.entryIds[0]} AND account_id = ${a.acct['1000']}`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/another company/);
    await expectLiveUntouched();
    // ...and the tampered file itself is refused on open.
    await expect(getDb(a.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  });

  it('a posted amount moved onto a non-posting account is refused', async () => {
    const co = await makeCompany('NonPosting Co');
    const buf = await tamperedBackupOf(co, async (db) => {
      await db.execute(sql`UPDATE accounts SET subtype = 'non_posting' WHERE id = ${co.acct['6000']}`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/non-posting/);
    await expectLiveUntouched();
  });

  it('malformed but "balanced" lines (negative / zero / both sides) are refused', async () => {
    const co = await makeCompany('Malformed Co');
    const buf = await tamperedBackupOf(co, async (db) => {
      // Entry 1: both lines negative on the same side — sums still equal (0 = 0 after flip).
      await db.execute(sql`UPDATE journal_entry_lines SET debit = -10, credit = -10 WHERE journal_entry_id = ${co.entryIds[0]}`);
      // Entry 2: zero lines.
      await db.execute(sql`UPDATE journal_entry_lines SET debit = 0, credit = 0 WHERE journal_entry_id = ${co.entryIds[1]}`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/2 posted journal entries are out of balance or malformed/);
    await expectLiveUntouched();
  });

  it('a posted entry whose lines were deleted is refused', async () => {
    const co = await makeCompany('NoLines Co');
    const buf = await tamperedBackupOf(co, async (db) => {
      await db.execute(sql`DELETE FROM journal_entry_lines WHERE journal_entry_id = ${co.entryIds[2]}`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/out of balance or malformed/);
    await expectLiveUntouched();
    await expect(getDb(co.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  });

  it('a posted entry hidden by flipping it to draft (cached balances now wrong) is refused by restore', async () => {
    const co = await makeCompany('Hidden Co');
    const buf = await tamperedBackupOf(co, async (db) => {
      await db.execute(sql`UPDATE journal_entries SET status = 'draft' WHERE id = ${co.entryIds[0]}`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/do not match the ledger/);
    await expectLiveUntouched();
  });

  it('cached-balance-only drift is refused by restore but does not lock the file on open (Rebuild can fix it)', async () => {
    const co = await makeCompany('Drift Co');
    const buf = await tamperedBackupOf(co, async (db) => {
      await db.execute(sql`UPDATE accounts SET balance = balance + 0.01 WHERE id = ${co.acct['1000']}`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/account 1000/);
    await expectLiveUntouched();

    // Open: not blocking, guards back on, Verify Data reports the one-cent drift.
    const db = await getDb(co.dir);
    const result = await verifyIntegrity({ ...co.ctx, db });
    const cached = result.checks.find((c) => /Cached account balances/.test(c.name))!;
    expect(cached.ok).toBe(false);
    expect(result.checks.find((c) => /guards/.test(c.name))!.ok).toBe(true);
  });

  it('a damaged second company in a multi-company file blocks the whole restore', async () => {
    const a = await makeCompany('Multi A');
    const b = await addCompany(a.db, a.dir, 'Multi B', a.userId);
    const buf = await tamperedBackupOf(a, async (db) => {
      await db.execute(sql`UPDATE journal_entry_lines SET credit = 29.99 WHERE journal_entry_id = ${b.entryIds[1]} AND credit > 0`);
    });
    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION' });
    expect(err.message).toMatch(/debits 20\.00, credits 29\.99/);
    await expectLiveUntouched();
  });
});

describe('restore/open must not leave the database\'s own safety triggers off', () => {
  /** Internal (foreign-key) triggers that are turned off. */
  async function disabledInternalTriggers(db: DB): Promise<string[]> {
    const rows = await rawRows<{ tbl: string; tgname: string }>(
      db,
      sql`SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE t.tgisinternal AND t.tgenabled = 'D'`,
    );
    return rows.map((r) => `${r.tbl}.${r.tgname}`);
  }

  it('after restoring a file made with DISABLE TRIGGER ALL, foreign keys on ledger tables are enforced again', async () => {
    const co = await makeCompany('FK Co');
    const buf = await tamperedBackupOf(co, async () => undefined); // books balance; only triggers off
    const target = newDir('fk-target');
    await restoreBackup(buf, target);
    const db = await getDb(target);
    expect(await disabledInternalTriggers(db)).toEqual([]);
  });

  it('after re-opening a file whose triggers were all disabled offline, foreign keys are enforced again', async () => {
    const co = await makeCompany('FK Open Co');
    await disableAll(co.db);
    await closeDb(co.dir);
    const db = await getDb(co.dir);
    // Behaviour, not just catalog state: an orphan journal line pointing at an entry that does
    // not exist must be rejected (bka_assert_entry_balanced skips a missing entry, so only the
    // foreign key stands in the way). It would carry an amount into account balances that no
    // entry, report or trial balance ever shows.
    const probe = await db
      .execute(sql`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                   VALUES (gen_random_uuid(), ${co.acct['6000']}, 1, 0)`)
      .then(
        () => 'accepted',
        (e: Error) => `rejected: ${e.message}`,
      );
    expect(probe).toMatch(/^rejected/);
    expect(await disabledInternalTriggers(db)).toEqual([]);
  });
});

describe('no false positives: a busy, legitimate file restores and ties out', () => {
  let busy: Co;
  let busy2: Co;
  let buf: Buffer;

  beforeAll(async () => {
    busy = await makeCompany('Busy Co');
    busy2 = await addCompany(busy.db, busy.dir, 'Busy Two', busy.userId);
    const ctx = busy.ctx;
    const cust = await createCustomer(ctx, { displayName: 'Penny Customer' });
    const vend = await createVendor(ctx, { displayName: 'Penny Vendor' });
    // Penny rounding: 3 x 33.333 = 99.999 -> 100.00 on the invoice.
    const inv1 = await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2025-02-01'),
      lines: [{ accountId: busy.acct['4000'], description: 'Thirds', quantity: 3, rate: 33.333 }],
    });
    const inv2 = await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2025-02-02'),
      lines: [{ accountId: busy.acct['4100'], description: 'Service', quantity: 1, rate: 250 }],
    });
    const inv3 = await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2025-02-03'),
      lines: [{ accountId: busy.acct['4100'], description: 'To void', quantity: 1, rate: 75 }],
    });
    await voidInvoice(ctx, inv3.id);
    // Partial payment on inv2, full payment on inv1.
    await receivePayment(ctx, {
      customerId: cust.id,
      date: new Date('2025-02-10'),
      method: 'check',
      amount: '133.33',
      depositAccountId: busy.acct['1000'],
      applications: [
        { invoiceId: inv1.id, amountApplied: inv1.total },
        { invoiceId: inv2.id, amountApplied: (133.33 - Number(inv1.total)).toFixed(2) },
      ],
    });
    const bill = await createBill(ctx, {
      vendorId: vend.id,
      billNumber: 'B-1',
      date: new Date('2025-02-05'),
      lines: [{ accountId: busy.acct['6300'], description: 'Supplies', amount: '80.01' }],
    });
    await payBills(ctx, {
      vendorId: vend.id,
      date: new Date('2025-02-15'),
      method: 'check',
      paymentAccountId: busy.acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '40.00' }],
    });
    // A voided general-journal entry.
    await voidJournalEntry(ctx, busy.entryIds[1]);
    buf = createBackup('Busy Co', busy.dir).buffer;
  }, 240_000);

  it('restores over another file with no complaint, and every invariant holds afterwards', async () => {
    const target = newDir('busy-target');
    await restoreBackup(buf, target);
    const db = await getDb(target); // must not throw LedgerDamagedError
    for (const co of [busy, busy2]) {
      const ctx = { ...co.ctx, db };
      const tb = await trialBalance(ctx);
      expect(tb.balanced).toBe(true);
      const status = await booksInBalance(ctx);
      expect(status.inBalance, JSON.stringify(status)).toBe(true);
      const integrity = await verifyIntegrity(ctx);
      expect(integrity.allOk, JSON.stringify(integrity.checks.filter((c) => !c.ok))).toBe(true);
    }
    // A/R control = open invoice balances (100.00 paid, 250 - 33.33 open, 75 voided).
    const [ar] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, busy.acct['1200']));
    const open = await db
      .select({ due: invoices.balanceDue })
      .from(invoices)
      .where(and(eq(invoices.companyId, busy.ctx.companyId), sql`${invoices.status} IN ('open','partial','overdue')`));
    const due = open.reduce((s, r) => s + Math.round(Number(r.due) * 100), 0);
    expect(Math.round(Number(ar.balance) * 100)).toBe(due);
    expect(due).toBe(21667);
    // A/P control = 80.01 - 40.00.
    const [ap] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, busy.acct['2000']));
    expect(ap.balance).toBe('40.01');
  });

  it('re-opening a legitimate file over and over is idempotent (no duplicate guards, still healthy)', async () => {
    const target = newDir('reopen');
    await restoreBackup(buf, target);
    for (let i = 0; i < 3; i++) {
      await closeDb(target);
      await getDb(target);
    }
    const db = await getDb(target);
    const dupes = await rawRows<{ tgname: string; n: number }>(
      db,
      sql`SELECT tgname, count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'bka%' GROUP BY tgname, tgrelid HAVING count(*) > 1`,
    );
    expect(dupes).toEqual([]);
  });
});

describe('damaged files: isolation, permissions and recovery paths', () => {
  let damaged: Co;
  let goodBackup: Buffer;
  let staff: string;

  beforeAll(async () => {
    goodBackup = createBackup('Live Co', live.dir).buffer;
    damaged = await makeCompany('Damaged Co');
    const [u] = await damaged.db
      .insert(users)
      .values({ email: `staff-${Date.now()}@test.local`, name: 'Staff', passwordHash: 'x' })
      .returning();
    staff = u.id;
    await damaged.db.insert(userCompanies).values({ userId: staff, companyId: damaged.ctx.companyId, role: 'viewer' } as never);
    await disableAll(damaged.db);
    await damaged.db.execute(
      sql`UPDATE journal_entry_lines SET debit = 9 WHERE journal_entry_id = ${damaged.entryIds[0]} AND debit > 0`,
    );
    await closeDb(damaged.dir);
  }, 120_000);

  it('a damaged file in one folder never blocks a healthy file in another', async () => {
    await expect(getDb(damaged.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
    await expectLiveUntouched();
  });

  it('the damaged file cannot be written to even inside damaged-file access (guards are back on)', async () => {
    const db = await withDamagedFileAccess(() => getDb(damaged.dir));
    await expect(
      db.execute(sql`UPDATE journal_entry_lines SET debit = 10 WHERE journal_entry_id = ${damaged.entryIds[0]} AND debit > 0`),
    ).rejects.toThrow();
    await expect(
      postJournalEntry({ ...damaged.ctx, db }, {
        date: new Date('2025-03-01'),
        description: 'still unbalanced',
        lines: [
          { accountId: damaged.acct['6000'], debit: '1.00' },
          { accountId: damaged.acct['1000'], credit: '0.99' },
        ],
      }),
    ).rejects.toThrow();
  });

  async function withRouteEnv<T>(dir: string, userId: string | null, fn: () => Promise<T>): Promise<T> {
    const prevDir = process.env.BKA_DATA_DIR;
    process.env.BKA_DATA_DIR = dir;
    session.userId = userId;
    try {
      return await fn();
    } finally {
      session.userId = null;
      if (prevDir === undefined) delete process.env.BKA_DATA_DIR;
      else process.env.BKA_DATA_DIR = prevDir;
    }
  }

  it('POST /api/backup on a damaged file still refuses a signed-out caller and a non-admin', async () => {
    const { POST } = await import('@/app/api/backup/route');
    const req = () =>
      new NextRequest('http://localhost/api/backup', { method: 'POST', body: new Uint8Array(goodBackup) });
    const anon = await withRouteEnv(damaged.dir, null, () => POST(req()));
    expect([401, 403]).toContain(anon.status); // pre-existing: getServerContext answers FORBIDDEN
    const viewer = await withRouteEnv(damaged.dir, staff, () => POST(req()));
    expect(viewer.status).toBe(403);
    // Still damaged — nothing was restored by the refused callers.
    await expect(getDb(damaged.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  });

  it('GET /api/backup on a damaged file lets the owner download it for support', async () => {
    const { GET } = await import('@/app/api/backup/route');
    const res = await withRouteEnv(damaged.dir, damaged.userId, () =>
      GET(new NextRequest('http://localhost/api/backup')),
    );
    expect(res.status).toBe(200);
  });

  it('the condense-archive restore offered on Back Up and Restore also works on a damaged file', async () => {
    // A pre-condense archive copy of a GOOD file, recorded against the damaged file's folder.
    const archDir = condenseArchiveDir(damaged.dir);
    fs.mkdirSync(archDir, { recursive: true });
    // Use a good backup of the damaged company itself (taken before the damage) — simulate it with
    // the live file's backup but recorded for the damaged company id.
    const file = path.join(archDir, 'good-archive.bka');
    fs.writeFileSync(file, goodBackup);
    fs.writeFileSync(
      path.join(archDir, 'condense-archives.json'),
      JSON.stringify([
        {
          id: 'run-good',
          path: file,
          filename: 'good-archive.bka',
          createdAt: new Date().toISOString(),
          dataDir: path.resolve(damaged.dir),
          companyId: damaged.ctx.companyId,
          companyName: 'Damaged Co',
          beforeDate: '2025-01-01',
          entriesCondensed: 1,
          sizeBytes: goodBackup.length,
        },
      ]),
    );
    // Keep a raw copy of the damaged file: this restore replaces it, and the next test needs it
    // damaged again.
    await closeDb(damaged.dir);
    const damagedCopy = `${damaged.dir}.copy`;
    fs.cpSync(damaged.dir, damagedCopy, { recursive: true });
    const { POST } = await import('@/app/api/condense/archives/route');
    const res = await withRouteEnv(damaged.dir, damaged.userId, () =>
      POST(
        new NextRequest('http://localhost/api/condense/archives', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `bka_company=${damaged.ctx.companyId}` },
          body: JSON.stringify({ id: 'run-good' }),
        }),
      ),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    // The archive copy is now the company file, and it opens.
    const restored = await getDb(damaged.dir);
    expect((await restored.select({ name: companies.name }).from(companies)).map((c) => c.name)).toEqual(['Live Co']);
    // Put the damaged file back for the next test.
    await closeDb(damaged.dir);
    fs.rmSync(damaged.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.renameSync(damagedCopy, damaged.dir);
    await expect(getDb(damaged.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  });

  it('POST /api/backup by the owner replaces the damaged file with a good backup', async () => {
    const { POST } = await import('@/app/api/backup/route');
    const res = await withRouteEnv(damaged.dir, damaged.userId, () =>
      POST(new NextRequest('http://localhost/api/backup', { method: 'POST', body: new Uint8Array(goodBackup) })),
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    const db = await getDb(damaged.dir);
    const names = (await db.select({ name: companies.name }).from(companies)).map((c) => c.name);
    expect(names).toEqual(['Live Co']);
  });
});
