/**
 * Restore safety, fix round 1 (reviewer/tester findings on fix/restore):
 *  - DISABLE TRIGGER ALL also switches off the database's own foreign-key triggers; open and
 *    restore must switch them back on, and Verify Data / checkLedgerHealth must notice them off;
 *  - orphan journal lines (no parent entry / no account) are damage: restore refuses them and
 *    open refuses the file;
 *  - subledger drift (A/R control vs open invoices) does not block a restore but is reported;
 *  - recovery routes on a damaged file: condense archives list works, opening a portable file
 *    works (it never touches the damaged file), adding a per-company backup INTO the damaged
 *    file is refused with the plain-language damaged-file message.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, openDb, LedgerDamagedError, MIGRATIONS_FOLDER, type DB } from '@/lib/db';
import { checkLedgerHealth } from '@/lib/db/ledgerGuards';
import { accounts, companies, invoices, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { createBackup, restoreBackup } from './backup';
import { verifyIntegrity } from './integrity';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSessionUserId: async () => session.userId,
    getSessionInfo: async () => (session.userId ? { userId: session.userId } : null),
  };
});

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-restore-r2-'));
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
      { accountId: acct['6000'], debit: '40.00' },
      { accountId: acct['1000'], credit: '40.00' },
    ],
  });
  return { dir, db, ctx, userId: user.id, acct };
}

async function disableAll(db: DB) {
  for (const t of ['journal_entry_lines', 'journal_entries', 'accounts']) {
    await db.execute(sql.raw(`ALTER TABLE ${t} DISABLE TRIGGER ALL`));
  }
}

async function disabledInternal(db: DB): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgisinternal AND tgenabled IN ('D', 'R')`,
  );
  return Number((res as unknown as { rows: Array<{ n: number }> }).rows[0].n);
}

/** An orphan journal line: its entry does not exist (and optionally its account neither). */
async function insertOrphan(db: DB, accountId: string | null) {
  if (accountId) {
    await db.execute(sql`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                         VALUES (gen_random_uuid(), ${accountId}, 1, 0)`);
  } else {
    await db.execute(sql`INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
                         VALUES (gen_random_uuid(), gen_random_uuid(), 1, 0)`);
  }
}

let live: Co;

beforeAll(async () => {
  live = await makeCompany('Live Co');
}, 120_000);

afterAll(async () => {
  for (const d of dirs) await closeDb(d).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function expectLiveUntouched() {
  const db = await getDb(live.dir);
  const names = (await db.select({ name: companies.name }).from(companies)).map((c) => c.name);
  expect(names).toEqual(['Live Co']);
  expect(await disabledInternal(db)).toBe(0);
}

describe('foreign-key triggers are switched back on and their absence is reported', () => {
  it('Verify Data and checkLedgerHealth flag foreign-key triggers left off; reopening switches them on', async () => {
    const co = await makeCompany('FK Report Co');
    await disableAll(co.db);
    expect(await disabledInternal(co.db)).toBeGreaterThan(0);

    const guards = (await verifyIntegrity(co.ctx)).checks.find((c) => /guards/.test(c.name))!;
    expect(guards.ok).toBe(false);
    expect(guards.detail).toMatch(/record-link \(foreign key\) trigger/);

    const health = await checkLedgerHealth(openDb(co.dir).client, MIGRATIONS_FOLDER);
    const g = health.problems.filter((p) => p.kind === 'guards').map((p) => p.detail).join(' ');
    expect(g).toMatch(/enforce links between records/);

    await closeDb(co.dir);
    const db = await getDb(co.dir);
    expect(await disabledInternal(db)).toBe(0);
    const again = (await verifyIntegrity({ ...co.ctx, db })).checks.find((c) => /guards/.test(c.name))!;
    expect(again.ok).toBe(true);
    const healthy = await checkLedgerHealth(openDb(co.dir).client, MIGRATIONS_FOLDER);
    expect(healthy.problems).toEqual([]);
  });

  it('a restored file made with DISABLE TRIGGER ALL rejects an orphan line afterwards', async () => {
    const co = await makeCompany('FK Restore Co');
    await disableAll(co.db);
    const buf = createBackup('FK', co.dir).buffer;
    await closeDb(co.dir);
    const target = newDir('fk-restore-target');
    await restoreBackup(buf, target);
    const db = await getDb(target);
    expect(await disabledInternal(db)).toBe(0);
    await expect(insertOrphan(db, co.acct['6000'])).rejects.toThrow();
  });
});

describe('orphan journal lines are damage', () => {
  it('a backup with a line whose entry does not exist is refused; the live file is untouched', async () => {
    const co = await makeCompany('Orphan Co');
    await disableAll(co.db);
    await insertOrphan(co.db, co.acct['6000']);
    const buf = createBackup('Orphan', co.dir).buffer;
    await closeDb(co.dir);

    const err = await restoreBackup(buf, live.dir).catch((e) => e);
    expect(err?.code).toBe('VALIDATION');
    expect(err.message).toMatch(/belongs to a journal entry that does not exist/);
    expect(err.message).toMatch(/Your current company file has not been changed/);
    await expectLiveUntouched();
  });

  it('a file with orphan lines (no entry, no account) is refused on open', async () => {
    const co = await makeCompany('Orphan Open Co');
    await disableAll(co.db);
    await insertOrphan(co.db, null);
    await closeDb(co.dir);

    const err = await getDb(co.dir).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerDamagedError);
    expect(err.message).toMatch(/journal entry that does not exist/);
    expect(err.message).toMatch(/account that does not exist/);
  });
});

describe('subledger drift does not block a restore but is reported', () => {
  it('an invoice balance due changed offline restores with a Verify / Rebuild Data notice', async () => {
    const co = await makeCompany('Drift Co');
    const cust = await createCustomer(co.ctx, { displayName: 'Drift Customer' });
    const inv = await createInvoice(co.ctx, {
      customerId: cust.id,
      date: new Date('2025-02-01'),
      lines: [{ accountId: co.acct['4100'], description: 'Service', quantity: 1, rate: 100 }],
    });
    await co.db.update(invoices).set({ balanceDue: '60.00' }).where(eq(invoices.id, inv.id));
    const buf = createBackup('Drift', co.dir).buffer;
    await closeDb(co.dir);

    const target = newDir('drift-target');
    const result = await restoreBackup(buf, target);
    expect(result.restored).toBe(true);
    expect(result.notices?.join(' ')).toMatch(/A\/R control account/);
    expect(result.notices?.join(' ')).toMatch(/Rebuild Data/);
  });

  it('a clean restore carries no notices', async () => {
    const buf = createBackup('Live', live.dir).buffer;
    const target = newDir('clean-target');
    const result = await restoreBackup(buf, target);
    expect(result).toEqual({ restored: true });
  });
});

describe('recovery routes on a damaged file', () => {
  let damaged: Co;
  let viewer: string;

  beforeAll(async () => {
    damaged = await makeCompany('Damaged Co');
    const [u] = await damaged.db
      .insert(users)
      .values({ email: `viewer-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x' })
      .returning();
    viewer = u.id;
    await damaged.db
      .insert(userCompanies)
      .values({ userId: viewer, companyId: damaged.ctx.companyId, role: 'viewer' } as never);
    await disableAll(damaged.db);
    await damaged.db.execute(sql`UPDATE journal_entry_lines SET debit = 9 WHERE debit > 0`);
    await closeDb(damaged.dir);
    await expect(getDb(damaged.dir)).rejects.toBeInstanceOf(LedgerDamagedError);
  }, 120_000);

  async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
    const prevDir = process.env.BKA_DATA_DIR;
    process.env.BKA_DATA_DIR = damaged.dir;
    session.userId = userId;
    try {
      return await fn();
    } finally {
      session.userId = null;
      if (prevDir === undefined) delete process.env.BKA_DATA_DIR;
      else process.env.BKA_DATA_DIR = prevDir;
    }
  }

  it('GET /api/condense/archives lists archive copies on a damaged file', async () => {
    const { GET } = await import('@/app/api/condense/archives/route');
    const res = await asUser(damaged.userId, () => GET());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archives: [] });
  });

  it('POST /api/condense/archives on a damaged file still refuses a non-admin', async () => {
    const { POST } = await import('@/app/api/condense/archives/route');
    const res = await asUser(viewer, () =>
      POST(
        new NextRequest('http://localhost/api/condense/archives', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'anything' }),
        }),
      ),
    );
    expect(res.status).toBe(403);
  });

  it('POST /api/portable/restore (browser path) reaches the file checks on a damaged file; non-admins are refused', async () => {
    const { POST } = await import('@/app/api/portable/restore/route');
    const req = () =>
      new NextRequest('http://localhost/api/portable/restore?inspect=1', {
        method: 'POST',
        body: new Uint8Array(Buffer.from('not a portable file')),
      });
    const owner = await asUser(damaged.userId, () => POST(req()));
    expect(owner.status).toBe(400); // the junk file is refused — not the damaged active file
    const other = await asUser(viewer, () => POST(req()));
    expect(other.status).toBe(403);
    const anon = await asUser(null, () => POST(req()));
    expect([401, 403]).toContain(anon.status);
  });

  it('POST /api/backup/company refuses to add a company INTO a damaged file, with the plain-language reason', async () => {
    const { POST } = await import('@/app/api/backup/company/route');
    const res = await asUser(damaged.userId, () =>
      POST(
        new NextRequest('http://localhost/api/backup/company', {
          method: 'POST',
          body: new Uint8Array(Buffer.from('anything')),
        }),
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/company file is damaged.*Restore your most recent backup/);
  });
});
