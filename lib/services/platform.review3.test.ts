/**
 * Regression tests from the third (platform) review.
 *
 *  1. 0059 repairs deposit_lines.account_id: 0037 gave two extra deposit lines with the same
 *     amount and memo the same account, and the next re-post (Remove payment from deposit) moved
 *     the other line's amount to that account. 0059 pairs lines one-to-one with the posted entry,
 *     is idempotent and leaves undamaged files untouched.
 *  2. A company file folder carries an exclusive lock (lib/db/dirLock.ts): another live process's
 *     lock refuses the open; this process's own, a dead process's on this computer, or one with no
 *     heartbeat for 2 minutes is taken over; closeDb releases it.
 *  3. Dates: zDate refuses impossible days (2026-02-30) and years outside 1900-9999; report/list
 *     routes answer a bad date query with 400 and clamp limit/offset; Postgres date errors are
 *     VALIDATION.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB, CompanyFileInUseError, LOCK_FILE } from '@/lib/db';
import { acquireDirLock, releaseDirLock, holdsDirLock, STALE_MS } from '@/lib/db/dirLock';
import { translatePgError } from '@/lib/db/pgErrors';
import { accounts, customers, depositLines, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createCompany } from './company';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { createDeposit, removePaymentFromDeposit } from './deposits';
import { zDate } from '@/lib/validation/helpers';
import { createJournalEntrySchema } from '@/lib/validation/journal';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as glGET } from '@/app/api/reports/general-ledger/route';
import { GET as jeGET, POST as jePOST } from '@/app/api/journal-entries/route';
import { GET as plClassGET } from '@/app/api/reports/pl-by-class/route';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-platform');
const TEST_DIR = path.join(TEST_ROOT, 'data');
let db: DB;

function get(url: string) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(new Request(u), { nextUrl: u }) as never;
}
function post(url: string, body: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}

const migrationSql = (file: string, marker: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), 'drizzle', file), 'utf8')
    .split('--> statement-breakpoint')
    .find((s) => s.includes(marker))!;

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r3p@test.local', name: 'R3', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'R3 Platform Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Dates and query parameters
// ---------------------------------------------------------------------------
describe('dates and query parameters', () => {
  it('zDate refuses impossible calendar days and out-of-range years, keeps real ones', () => {
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '10000-01-01', '1899-12-31', '0001-01-01']) {
      expect(zDate.safeParse(bad).success, bad).toBe(false);
    }
    for (const good of ['2024-02-29', '2026-12-31', '1900-01-01', '9999-12-31', '2026-01-15T12:00:00Z']) {
      expect(zDate.safeParse(good).success, good).toBe(true);
    }
    const r = zDate.safeParse('2026-03-01');
    expect(r.success && r.data.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('a bad date query is a 400 on the report and list routes', async () => {
    expect((await glGET(get('/api/reports/general-ledger?from=not-a-date'))).status).toBe(400);
    expect((await glGET(get('/api/reports/general-ledger?to=2026-02-30'))).status).toBe(400);
    expect((await jeGET(get('/api/journal-entries?from=garbage'))).status).toBe(400);
    expect((await plClassGET(get('/api/reports/pl-by-class?to=x'))).status).toBe(400);
    expect((await glGET(get('/api/reports/general-ledger?from=2026-01-01&to=2026-12-31'))).status).toBe(200);
  });

  it('journal-entries limit/offset are clamped instead of failing', async () => {
    expect((await jeGET(get('/api/journal-entries?offset=-1'))).status).toBe(200);
    expect((await jeGET(get('/api/journal-entries?limit=abc&offset=xyz'))).status).toBe(200);
    expect((await jeGET(get('/api/journal-entries?limit=-5'))).status).toBe(200);
  });

  it('a year-10000 journal entry is refused with 400', async () => {
    const rows = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const body = {
      date: '10000-01-01',
      description: 'far future',
      lines: [
        { accountId: rows.find((r) => r.type === 'expense')!.id, debit: '10.00' },
        { accountId: rows.find((r) => r.code === '1000')!.id, credit: '10.00' },
      ],
    };
    expect(createJournalEntrySchema.safeParse(body).success).toBe(false);
    expect((await jePOST(post('/api/journal-entries', body))).status).toBe(400);
  });

  it('Postgres date/time errors become VALIDATION', () => {
    for (const code of ['22007', '22008', '22009']) {
      const e = translatePgError(Object.assign(new Error('bad date'), { code }));
      expect(e instanceof ServiceError && e.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// 1. 0059 deposit_lines.account_id repair
// ---------------------------------------------------------------------------
describe('0059 deposit line accounts', () => {
  async function depositWithTwoSameAmountLines() {
    const accts = await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
    const id = (c: string) => accts.find((a) => a.code === c)!.id;
    const [cust] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: `Dep Cust ${Math.random()}` })
      .returning();
    const inv: any = await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-01-10'),
      lines: [{ accountId: id('4000'), description: 'Work', quantity: 1, rate: '500.00' }],
    } as never);
    const pay: any = await receivePayment(ctx, {
      customerId: cust.id,
      date: new Date('2026-01-15'),
      method: 'check',
      amount: '500.00',
      applications: [{ invoiceId: inv.id ?? inv.invoice.id, amountApplied: '500.00' }],
    } as never);
    const dep: any = await createDeposit(ctx, {
      depositAccountId: id('1000'),
      date: new Date('2026-01-16'),
      paymentIds: [pay.id ?? pay.payment.id],
      extraLines: [
        { accountId: id('3000'), amount: '100.00' },
        { accountId: id('4900'), amount: '100.00' },
      ],
    } as never);
    const depId: string = dep.id ?? dep.deposit.id;
    const extraCodes = async () =>
      (await db.select().from(depositLines).where(eq(depositLines.depositId, depId)))
        .filter((l) => !l.paymentId)
        .map((l) => accts.find((a) => a.id === l.accountId)?.code ?? null)
        .sort();
    const bal = async (c: string) => {
      const [r] = await db
        .select({ s: sql<string>`coalesce(sum(coalesce(${journalEntryLines.credit},0) - coalesce(${journalEntryLines.debit},0)),0)` })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
        .where(and(eq(journalEntries.status, 'posted'), eq(journalEntryLines.accountId, id(c))));
      return Number(r.s);
    };
    return { depId, extraCodes, bal };
  }

  const run0059 = async () => {
    const res: any = await db.execute(sql.raw(migrationSql('0059_deposit_line_accounts.sql', 'UPDATE "deposit_lines"')));
    return Number(res.affectedRows ?? res.rowCount ?? 0);
  };

  it('is a no-op on an undamaged file', async () => {
    const { extraCodes } = await depositWithTwoSameAmountLines();
    expect(await extraCodes()).toEqual(['3000', '4900']);
    expect(await run0059()).toBe(0);
    expect(await extraCodes()).toEqual(['3000', '4900']);
  });

  it('repairs lines 0037 gave the same account (and lines it left empty), idempotently', async () => {
    const { depId, extraCodes, bal } = await depositWithTwoSameAmountLines();
    // A file from before 0037: the column was empty. Re-run 0037's backfill → the damage.
    await db.execute(sql`UPDATE deposit_lines SET account_id = NULL WHERE deposit_id = ${depId} AND payment_id IS NULL`);
    await db.execute(sql.raw(migrationSql('0037_fix_ledger.sql', 'UPDATE "deposit_lines"')));
    expect(await extraCodes()).toEqual(['3000', '3000']);

    expect(await run0059()).toBe(1);
    expect(await extraCodes()).toEqual(['3000', '4900']);
    expect(await run0059()).toBe(0);

    // Lines left empty are filled too.
    await db.execute(sql`UPDATE deposit_lines SET account_id = NULL WHERE deposit_id = ${depId} AND payment_id IS NULL`);
    await run0059();
    expect(await extraCodes()).toEqual(['3000', '4900']);

    // The re-post from the repaired lines keeps each amount on its own account.
    const before = [await bal('3000'), await bal('4900')];
    const [payLine] = (await db.select().from(depositLines).where(eq(depositLines.depositId, depId))).filter((l) => l.paymentId);
    await removePaymentFromDeposit(ctx, depId, payLine.paymentId!);
    expect([await bal('3000'), await bal('4900')]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. Company file lock
// ---------------------------------------------------------------------------
describe('company file lock', () => {
  const lockDir = (name: string) => {
    const d = path.join(TEST_ROOT, 'locks', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const writeLock = (dir: string, info: Record<string, unknown>, ageMs = 0) => {
    const file = path.join(dir, LOCK_FILE);
    fs.writeFileSync(file, JSON.stringify(info));
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(file, t, t);
    }
    return file;
  };
  const DEAD_PID = 2 ** 22 - 7;

  it('an open file holds the lock; closeDb releases it; the same process may reopen', async () => {
    const lockFile = path.join(TEST_DIR, LOCK_FILE);
    const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    expect(info).toMatchObject({ pid: process.pid, hostname: os.hostname() });
    expect(typeof info.startedAt).toBe('string');
    const dir = lockDir('reopen');
    await getDb(dir);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(true);
    await closeDb(dir);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    // Our own lock left behind (e.g. copied back by a restore) does not block us.
    writeLock(dir, { pid: process.pid, hostname: os.hostname(), startedAt: 'x', heartbeatAt: 'x' });
    await getDb(dir);
    await closeDb(dir);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  }, 120_000);

  it('refuses a file another live process has open, with the host in the message', async () => {
    const dir = lockDir('other-pc');
    writeLock(dir, { pid: 1234, hostname: 'FRONT-DESK-PC', startedAt: 'x', heartbeatAt: 'x' });
    await expect(getDb(dir)).rejects.toThrow(
      'This company file is open on FRONT-DESK-PC. Close it there, or use multi-user hosting.',
    );
    await expect(getDb(dir)).rejects.toBeInstanceOf(CompanyFileInUseError);
    // No handle was left behind, and the other computer's lock is untouched.
    expect(holdsDirLock(path.resolve(dir))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).hostname).toBe('FRONT-DESK-PC');

    const dir2 = lockDir('same-pc-live');
    writeLock(dir2, { pid: process.ppid, hostname: os.hostname(), startedAt: 'x', heartbeatAt: 'x' });
    expect(() => acquireDirLock(path.resolve(dir2))).toThrow(CompanyFileInUseError);
  });

  it('takes over a dead process on this computer, or a lock with no heartbeat for 2 minutes', () => {
    const dead = path.resolve(lockDir('dead-pid'));
    writeLock(dead, { pid: DEAD_PID, hostname: os.hostname(), startedAt: 'x', heartbeatAt: 'x' });
    acquireDirLock(dead);
    expect(JSON.parse(fs.readFileSync(path.join(dead, LOCK_FILE), 'utf8')).pid).toBe(process.pid);
    releaseDirLock(dead);
    expect(fs.existsSync(path.join(dead, LOCK_FILE))).toBe(false);

    const crashed = path.resolve(lockDir('crashed-pc'));
    writeLock(crashed, { pid: 99, hostname: 'CRASHED-PC', startedAt: 'x', heartbeatAt: 'x' }, STALE_MS + 30_000);
    acquireDirLock(crashed);
    expect(JSON.parse(fs.readFileSync(path.join(crashed, LOCK_FILE), 'utf8')).hostname).toBe(os.hostname());
    releaseDirLock(crashed);

    const fresh = path.resolve(lockDir('fresh-pc'));
    writeLock(fresh, { pid: 99, hostname: 'BUSY-PC', startedAt: 'x', heartbeatAt: 'x' }, STALE_MS - 30_000);
    expect(() => acquireDirLock(fresh)).toThrow(/open on BUSY-PC/);
  });
});
