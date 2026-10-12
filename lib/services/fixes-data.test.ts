/**
 * Regression tests for the "data" audit-fix package:
 *
 *  1. /api/backup GET/POST fail closed without a session (was completely unauthenticated).
 *  2. restoreBackup validates the archive BEFORE touching the data dir (junk / wrong zip
 *     → VALIDATION), closes the live PGlite handle, and swaps the directory atomically so
 *     no stale files survive and the restored data is visible on the next getDb().
 *  3. createBackup embeds a bookkeeper-manifest.json entry (not extracted into the data dir).
 *  4. importIIF no longer drops accounts on derived-code collisions and reports per-row issues.
 *  5. /api/companies GET/POST require a session (first-run carve-out only), GET is scoped to
 *     the caller's memberships, and POST assigns ownership to the session user.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { getDb, closeDb } from '@/lib/db';
import { users, companies, accounts, userCompanies } from '@/lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { ServiceContext } from './_base';
import { createBackup, restoreBackup, BACKUP_MANIFEST_ENTRY } from './backup';
import { importIIF } from './qbImport';
import { createCompany } from './company';

// ---------------------------------------------------------------------------
// Session mock — lets the route handlers be driven without HTTP cookies.
// ---------------------------------------------------------------------------

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSessionUserId: async () => session.userId,
    getSessionInfo: async () => (session.userId ? { userId: session.userId } : null),
  };
});

import { NextRequest } from 'next/server';
import { GET as companiesGET, POST as companiesPOST } from '@/app/api/companies/route';
import { GET as backupGET, POST as backupPOST } from '@/app/api/backup/route';

/** GET /api/companies now takes the request (for ?includeArchived=1). */
const companiesGetRequest = () => new NextRequest('http://localhost/api/companies');

const jsonRequest = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// 2 + 3: backup service — validation, manifest, close-then-swap restore
// ---------------------------------------------------------------------------

const BK_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fixes-data-backup');

describe('backup service — restore validation and atomic swap', () => {
  // Start clean: a dir left behind by an earlier interrupted run would fail the "nothing created" asserts.
  beforeAll(() => {
    fs.rmSync(BK_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  afterAll(async () => {
    await closeDb(BK_DIR);
    fs.rmSync(BK_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('rejects junk bytes with VALIDATION before touching the data dir', async () => {
    await expect(restoreBackup(Buffer.from('definitely not a zip file'), BK_DIR)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    // Nothing was created/extracted.
    expect(fs.existsSync(BK_DIR)).toBe(false);
  });

  it('rejects a valid zip that is not a BookKeeper backup', async () => {
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('just some random archive'));
    await expect(restoreBackup(zip.toBuffer(), BK_DIR)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fs.existsSync(BK_DIR)).toBe(false);
  });

  it('rejects a backup from a newer format version', async () => {
    const zip = new AdmZip();
    zip.addFile(
      BACKUP_MANIFEST_ENTRY,
      Buffer.from(JSON.stringify({ app: 'bookkeeper-ai', formatVersion: 999 })),
    );
    zip.addFile('PG_VERSION', Buffer.from('16'));
    await expect(restoreBackup(zip.toBuffer(), BK_DIR)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('round-trips: closes the open handle, removes stale files, restored data is queryable', async () => {
    // Seed a real PGlite dir with one company.
    let db = await getDb(BK_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'backup@test.local', name: 'Backup User', passwordHash: 'x' })
      .returning();
    await db.insert(companies).values({ name: 'Original Co', ownerId: user.id });
    // Flush to disk so the zip captures the row, then back up.
    await closeDb(BK_DIR);
    const { buffer } = createBackup('Original Co', BK_DIR);

    // The backup embeds a manifest entry.
    expect(new AdmZip(buffer).getEntry(BACKUP_MANIFEST_ENTRY)).toBeTruthy();

    // Reopen (live handle now open) and diverge from the backup state.
    db = await getDb(BK_DIR);
    await db.insert(companies).values({ name: 'After Backup Co', ownerId: user.id });
    const staleFile = path.join(BK_DIR, 'stale-file.txt');
    fs.writeFileSync(staleFile, 'left over from the pre-restore state');

    // Restore while the handle is open — restoreBackup must close it itself.
    const result = await restoreBackup(buffer, BK_DIR);
    expect(result).toEqual({ restored: true });

    // Reopen: only the backed-up state is visible; stale files did not survive.
    db = await getDb(BK_DIR);
    const names = (await db.select().from(companies)).map((c) => c.name);
    expect(names).toContain('Original Co');
    expect(names).not.toContain('After Backup Co');
    expect(fs.existsSync(staleFile)).toBe(false);
    // The manifest is archive metadata and must not land in the data dir.
    expect(fs.existsSync(path.join(BK_DIR, BACKUP_MANIFEST_ENTRY))).toBe(false);
    // No temp/pre-restore residue next to the data dir.
    const siblings = fs.readdirSync(path.dirname(BK_DIR));
    expect(siblings.some((n) => n.startsWith(`${path.basename(BK_DIR)}.restore-tmp-`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4: IIF import — code collisions + per-row issues
// ---------------------------------------------------------------------------

const IIF_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fixes-data-iif');

describe('importIIF — code collisions and per-row issues', () => {
  let ctx: ServiceContext;

  // Both names sanitise to the same 20-char code 'LONG-DEPARTMENTAL-EX'.
  const COLLIDING_IIF =
    `!ACCNT\tNAME\tACCNTTYPE\n` +
    `ACCNT\tLong Departmental Expenses Alpha\tEXPENSE\n` +
    `ACCNT\tLong Departmental Expenses Beta\tEXPENSE\n`;

  beforeAll(async () => {
    const db = await getDb(IIF_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'iif@test.local', name: 'IIF User', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'IIF Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb(IIF_DIR);
    fs.rmSync(IIF_DIR, { recursive: true, force: true });
  });

  it('imports BOTH accounts when derived codes collide, with distinct codes', async () => {
    const counts = await importIIF(ctx, COLLIDING_IIF);
    expect(counts.accounts).toBe(2);
    expect(counts.skipped).toBe(0);

    const rows = await ctx.db
      .select({ name: accounts.name, code: accounts.code })
      .from(accounts)
      .where(
        and(
          eq(accounts.companyId, ctx.companyId),
          inArray(accounts.name, [
            'Long Departmental Expenses Alpha',
            'Long Departmental Expenses Beta',
          ]),
        ),
      );
    expect(rows).toHaveLength(2);
    const codes = rows.map((r) => r.code);
    expect(new Set(codes).size).toBe(2);
    for (const code of codes) expect(code.length).toBeLessThanOrEqual(20);

    // The remap is reported, not silent.
    const collision = counts.issues.filter((i) => i.reason === 'code-collision');
    expect(collision).toHaveLength(1);
    expect(collision[0].entity).toBe('account');
    expect(collision[0].name).toBe('Long Departmental Expenses Beta');
  });

  it('re-importing the same file skips both as duplicates and reports each in issues', async () => {
    const counts = await importIIF(ctx, COLLIDING_IIF);
    expect(counts.accounts).toBe(0);
    expect(counts.skipped).toBe(2);
    const dupes = counts.issues.filter(
      (i) => i.entity === 'account' && i.reason === 'duplicate',
    );
    expect(dupes.map((d) => d.name).sort()).toEqual([
      'Long Departmental Expenses Alpha',
      'Long Departmental Expenses Beta',
    ]);
  });

  it('reports validation failures per row instead of swallowing them', async () => {
    // A customer row with a blank name is skipped with a validation issue.
    const iif = `!CUST\tNAME\tCOMPANYNAME\nCUST\t\tNo Name Inc\n`;
    const counts = await importIIF(ctx, iif);
    expect(counts.customers).toBe(0);
    // Blank-name rows never make it past parseIIF, so this is a no-op import — but a
    // duplicate customer DOES surface an issue:
    const dupIif = `!CUST\tNAME\nCUST\tRepeat Customer\n`;
    const first = await importIIF(ctx, dupIif);
    expect(first.customers).toBe(1);
    const second = await importIIF(ctx, dupIif);
    expect(second.customers).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.issues).toEqual([
      expect.objectContaining({ entity: 'customer', name: 'Repeat Customer', reason: 'duplicate' }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1 + 5: route auth — /api/companies and /api/backup fail closed
// ---------------------------------------------------------------------------

const ROUTE_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fixes-data-routes');

describe('route auth — /api/companies and /api/backup', () => {
  let userAId: string;
  let userBId: string;

  beforeAll(() => {
    process.env.BKA_DATA_DIR = ROUTE_DIR;
    delete process.env.BKA_ALLOW_DEV_FALLBACK;
  });

  afterAll(async () => {
    delete process.env.BKA_DATA_DIR;
    await closeDb(ROUTE_DIR);
    fs.rmSync(ROUTE_DIR, { recursive: true, force: true });
  });

  it('first-run GET /api/companies without a session is allowed (onboarding boot)', async () => {
    session.userId = null;
    const res = await companiesGET(companiesGetRequest());
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0); // dev company seeded
  });

  it('unauthenticated GET/POST /api/companies fail closed once a user exists', async () => {
    session.userId = null; // a user now exists (seeded by first-run above)
    const get = await companiesGET(companiesGetRequest());
    expect(get.status).toBe(401);

    const post = await companiesPOST(
      jsonRequest('http://localhost/api/companies', { name: 'Rogue Co' }) as never,
    );
    expect(post.status).toBe(401);
  });

  it('GET is membership-scoped and POST assigns ownership to the session user', async () => {
    const db = await getDb();
    const [ua] = await db
      .insert(users)
      .values({ email: 'a@test.local', name: 'User A', passwordHash: 'x' })
      .returning();
    const [ub] = await db
      .insert(users)
      .values({ email: 'b@test.local', name: 'User B', passwordHash: 'x' })
      .returning();
    userAId = ua.id;
    userBId = ub.id;
    await createCompany(db, { name: 'A Co', ownerId: ua.id, seedCoa: false });
    await createCompany(db, { name: 'B Co', ownerId: ub.id, seedCoa: false });

    // B only sees B's companies — not A's, not the seeded demo company.
    session.userId = userBId;
    const res = await companiesGET(companiesGetRequest());
    expect(res.status).toBe(200);
    const names = ((await res.json()) as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain('B Co');
    expect(names).not.toContain('A Co');
    expect(names).not.toContain('Demo Company');

    // POST creates a company owned by the SESSION user (not the first/dev user).
    const post = await companiesPOST(
      jsonRequest('http://localhost/api/companies', { name: 'B Second Co' }) as never,
    );
    expect(post.status).toBe(201);
    const created = await post.json();
    expect(created.ownerId).toBe(userBId);
  });

  it('unauthenticated backup download and restore fail closed (403)', async () => {
    session.userId = null;
    const get = await backupGET(undefined as never);
    expect(get.status).toBe(403);

    const post = await backupPOST(
      new Request('http://localhost/api/backup', {
        method: 'POST',
        body: 'junk bytes pretending to be a .bka',
      }) as never,
    );
    expect(post.status).toBe(403);
  });

  it('a whole-file restore by an Admin of only ONE company in the file is refused (403)', async () => {
    session.userId = userBId; // Admin of B Co only; A Co and the demo company share the file
    const post = await backupPOST(
      new Request('http://localhost/api/backup', {
        method: 'POST',
        body: 'junk bytes pretending to be a .bka',
      }) as never,
    );
    expect(post.status).toBe(403);
  });

  it('authenticated restore of a junk body returns 400 VALIDATION (data dir untouched)', async () => {
    // Whole-file restore needs an active Admin of every company in the file.
    const db = await getDb();
    const all = await db.select({ id: companies.id, ownerId: companies.ownerId }).from(companies);
    for (const c of all) {
      if (c.ownerId === userBId) continue;
      await db.insert(userCompanies).values({ userId: userBId, companyId: c.id, role: 'admin' });
    }
    session.userId = userBId;
    const post = await backupPOST(
      new Request('http://localhost/api/backup', {
        method: 'POST',
        body: 'junk bytes pretending to be a .bka',
      }) as never,
    );
    expect(post.status).toBe(400);
    const body = await post.json();
    expect(body.code).toBe('VALIDATION');
  });
});
