/**
 * Backups you can see and trust (team backups) — end to end against a real PGlite company file
 * and the real route handlers (`next/headers` mocked, same hermetic pattern as
 * users.retest2.test.ts):
 *  - every backup source lands in the backup history: manual download, one-company download,
 *    "Back up now", quit-time (desktop internal token), scheduled, pre-operation safety copy
 *  - schedule: not due / due / skipped when nothing changed; rotation keeps the last N versions
 *  - status for the indicator
 *  - restore preview reads a backup in a temp folder without touching the live database and
 *    reports balanced trial-balance totals; temp folders are removed
 *  - restore of a version from the list, history kept across the restore
 *  - file-Admin gating on settings / back up now / preview / restore
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { and, count, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-team-backups');
const TEST_DIR = path.join(ROOT, 'company');
const BACKUP_DIR = path.join(ROOT, 'backups');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_BACKUP_DIR = BACKUP_DIR;
process.env.BKA_AUTH_SECRET = 'team-backups-secret';
process.env.BKA_INTERNAL_TOKEN = 'team-backups-internal-token';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { createManualEntry } from './journal';
import { createVendor } from './vendors';
import { addUser } from './users';
import { createBackup, ensurePreOpBackup } from './backup';
import { readBackupHistory, saveBackupSettings, type BackupRecord } from './backupHistory';
import { currentFingerprint } from './backupFingerprint';
import { runScheduledBackupIfDue, runVersionedBackup, stopBackupScheduler } from './backupSchedule';
import { PREVIEW_DIR_PREFIX, previewBackup } from './backupPreview';
import type { ServiceContext } from './_base';
import { GET as fullBackupGET } from '@/app/api/backup/route';
import { GET as companyBackupGET } from '@/app/api/backup/company/route';
import { POST as autoBackupPOST } from '@/app/api/dashboard/auto-backup/route';
import { GET as backupsGET, PUT as backupsPUT } from '@/app/api/backups/route';
import { GET as statusGET } from '@/app/api/backups/status/route';
import { POST as runPOST } from '@/app/api/backups/run/route';
import { POST as previewPOST } from '@/app/api/backups/preview/route';
import { POST as restorePOST } from '@/app/api/backups/restore/route';

let db: DB;
let companyId: string;
let ownerId: string;
let trusted: ServiceContext;
let cash: string;
let income: string;
const HOUR = 60 * 60 * 1000;

function as(userId: string | null, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  if (userId) {
    h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
    h.cookies.set(COMPANY_COOKIE, companyId);
  }
}
function req(url: string, init?: { method?: string; body?: string | Buffer; json?: boolean; headers?: Record<string, string> }) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: init?.method ?? 'GET',
    headers: { ...(init?.json ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    body: init?.body as BodyInit | undefined,
  });
}
const history = () => readBackupHistory(TEST_DIR);
// Some schedule tests run the clock forward ("now" + 25 hours), so "newest" means newest by time.
const newest = () => history()[0];
/** The record a call just added (history grows by exactly one). */
function added(before: BackupRecord[]): BackupRecord {
  const ids = new Set(before.map((r) => r.id));
  const fresh = history().filter((r) => !ids.has(r.id));
  expect(fresh).toHaveLength(1);
  return fresh[0];
}
async function postSale(amount: string, date = '2026-03-15') {
  await createManualEntry(trusted, {
    date: new Date(`${date}T12:00:00Z`),
    description: `Cash sale ${amount}`,
    lines: [
      { accountId: cash, debit: amount },
      { accountId: income, credit: amount },
    ],
  });
}
async function postedCount(d: DB) {
  const [row] = await d
    .select({ n: count() })
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.status, 'posted')));
  return Number(row.n);
}

describe('backups you can see and trust', () => {
  beforeAll(async () => {
    stopBackupScheduler();
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@backups.local', name: 'Bea Owner', passwordHash: await hashPassword('ownerpass123') })
      .returning();
    ownerId = owner.id;
    companyId = (await createCompany(db, { name: 'Backup Bakery', ownerId })).id;
    trusted = { db, companyId, userId: ownerId };
    const rows = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    cash = rows.find((a) => a.type === 'asset' && a.isActive !== false)!.id;
    income = rows.find((a) => a.type === 'revenue')!.id;
    await postSale('250.00');
  });

  afterAll(async () => {
    stopBackupScheduler();
    await closeDb(TEST_DIR);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  describe('every backup source is recorded', () => {
    it('manual download of the whole file (GET /api/backup)', async () => {
      as(ownerId, 'GET', '/api/backup');
      const res = await fullBackupGET(req('/api/backup'));
      expect(res.status).toBe(200);
      expect(newest()).toMatchObject({ source: 'manual', kind: 'full', path: null, note: 'Downloaded' });
      expect(newest().fingerprint).toBe(currentFingerprint(TEST_DIR));
      expect(newest().fingerprint).toMatch(/^log:\d+:[0-9a-f]{64}$/);
    });

    it('one-company download is recorded as a company copy', async () => {
      as(ownerId, 'GET', '/api/backup/company');
      const res = await companyBackupGET(req('/api/backup/company'));
      expect(res.status).toBe(200);
      expect(newest()).toMatchObject({ source: 'manual', kind: 'company', path: null });
    });

    it('"Back up now" saves a copy into the backup folder', async () => {
      as(ownerId, 'POST', '/api/backups/run');
      const res = await runPOST();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('created');
      const rec = newest();
      expect(rec).toMatchObject({ source: 'manual', kind: 'full' });
      expect(path.dirname(rec.path!)).toBe(BACKUP_DIR);
      expect(fs.existsSync(rec.path!)).toBe(true);
      expect(rec.filename).toMatch(/^backup-backup-bakery-.*\.bka$/);
    });

    it('quit-time backup from the desktop shell (internal token, ?save=1) — and skipped when nothing changed', async () => {
      await createVendor(trusted, { displayName: 'Flour Mill' }); // a change since "Back up now"
      as(null, 'POST', '/api/dashboard/auto-backup');
      const headers = { 'x-bka-internal': 'team-backups-internal-token' };
      const first = await autoBackupPOST(req('/api/dashboard/auto-backup?save=1', { method: 'POST', headers }));
      expect(first.status).toBe(200);
      expect((await first.json()).status).toBe('created');
      const rec = newest();
      expect(rec).toMatchObject({ source: 'quit', kind: 'full' });
      expect(rec.filename).toMatch(/^auto-backup-backup-bakery-/);
      expect(fs.existsSync(rec.path!)).toBe(true);

      const before = history().length;
      const again = await autoBackupPOST(req('/api/dashboard/auto-backup?save=1', { method: 'POST', headers }));
      expect((await again.json()).status).toBe('unchanged');
      expect(history().length).toBe(before);
    });

    it('scheduled: not due right after a version, skipped when unchanged, made once the books change', async () => {
      const now = Date.now();
      expect(await runScheduledBackupIfDue({ dataDir: TEST_DIR, now: new Date(now) })).toBe('not-due');
      const before = history().length;
      expect(await runScheduledBackupIfDue({ dataDir: TEST_DIR, now: new Date(now + 25 * HOUR) })).toBe('unchanged');
      expect(history().length).toBe(before);

      await postSale('100.00', '2026-04-02');
      expect(await runScheduledBackupIfDue({ dataDir: TEST_DIR, now: new Date(now + 25 * HOUR), companyName: 'Backup Bakery' })).toBe('created');
      expect(newest()).toMatchObject({ source: 'scheduled', kind: 'full', note: 'Automatic backup' });
      expect(fs.existsSync(newest().path!)).toBe(true);
    });

    it('schedule off: never runs', async () => {
      saveBackupSettings({ schedule: 'off' }, TEST_DIR);
      expect(await runScheduledBackupIfDue({ dataDir: TEST_DIR, now: new Date(Date.now() + 100 * HOUR) })).toBe('off');
      saveBackupSettings({ schedule: 'daily' }, TEST_DIR);
    });

    it('pre-operation safety copy', () => {
      const before = history();
      const out = ensurePreOpBackup(null, 'restore', TEST_DIR)!;
      expect(added(before)).toMatchObject({ source: 'pre-op', path: out.path, note: 'Safety copy made before restoring a backup' });
    });

    it('never runs two backups of the same file at once', async () => {
      const a = runVersionedBackup('manual', { dataDir: TEST_DIR, force: true });
      const b = runVersionedBackup('scheduled', { dataDir: TEST_DIR, force: true });
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toBe(rb); // the second call joined the running one
    });

    it('the history and settings files never travel inside a backup', async () => {
      const { buffer } = createBackup('x', TEST_DIR);
      const AdmZip = (await import('adm-zip')).default;
      const names = new AdmZip(buffer).getEntries().map((e) => e.entryName);
      expect(names).not.toContain('.backup-history.json');
      expect(names).not.toContain('.backup-settings.json');
    });
  });

  describe('rotation', () => {
    it('keeps only the last N automatic versions; manual copies stay', async () => {
      saveBackupSettings({ keep: 2 }, TEST_DIR);
      const base = Date.now() + 48 * HOUR;
      for (let i = 0; i < 3; i++) {
        await postSale(`${10 + i}.00`, '2026-05-01');
        const r = await runVersionedBackup('scheduled', { dataDir: TEST_DIR, now: new Date(base + i * HOUR) });
        expect(r.status).toBe('created');
      }
      const autos = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('auto-backup-') && f.endsWith('.bka'));
      expect(autos).toHaveLength(2);
      const versions = history().filter((r) => r.source === 'scheduled' || r.source === 'quit');
      const live = versions.filter((r) => !r.prunedAt);
      expect(live).toHaveLength(2);
      expect(versions.filter((r) => r.prunedAt).every((r) => !fs.existsSync(r.path!))).toBe(true);
      // Manual "Back up now" copies are never rotated away.
      expect(fs.readdirSync(BACKUP_DIR).some((f) => f.startsWith('backup-'))).toBe(true);
      saveBackupSettings({ keep: 14 }, TEST_DIR);
    });
  });

  describe('status, settings and gating', () => {
    it('status for the sidebar indicator: backed up just now, nothing changed since', async () => {
      // The newest version was taken at a future "now"; make one at the real time for the age.
      await runVersionedBackup('manual', { dataDir: TEST_DIR, force: true });
      as(ownerId, 'GET', '/api/backups/status');
      const res = await statusGET();
      expect(res.status).toBe(200);
      const s = await res.json();
      expect(s).toMatchObject({ state: 'ok', warn: false, upToDate: true, schedule: 'daily' });
      expect(s.daysSince).toBe(0);
      stopBackupScheduler();
    });

    it('GET /api/backups lists history with which versions are still on disk; PUT validates', async () => {
      as(ownerId, 'GET', '/api/backups');
      const res = await backupsGET();
      const body = await res.json();
      expect(body.folder).toBe(BACKUP_DIR);
      expect(body.settings).toMatchObject({ schedule: 'daily', keep: 14 });
      expect(body.history.some((r: { available: boolean }) => r.available)).toBe(true);
      expect(body.history.filter((r: BackupRecord) => r.prunedAt).every((r: { available: boolean }) => !r.available)).toBe(true);

      as(ownerId, 'PUT', '/api/backups');
      const ok = await backupsPUT(req('/api/backups', { method: 'PUT', json: true, body: JSON.stringify({ schedule: 'hours', everyHours: 6, keep: 10, folder: null }) }));
      expect(ok.status).toBe(200);
      expect((await ok.json()).settings).toMatchObject({ schedule: 'hours', everyHours: 6, keep: 10 });
      const bad = await backupsPUT(req('/api/backups', { method: 'PUT', json: true, body: JSON.stringify({ keep: 0 }) }));
      expect(bad.status).toBe(400);
      saveBackupSettings({ schedule: 'daily', keep: 14 }, TEST_DIR);
      stopBackupScheduler();
    });

    it('settings, back up now, preview and restore need an Admin of every company in the file', async () => {
      as(ownerId, 'POST', '/api/users');
      const adminCtx = await getServerContext();
      const fin = await addUser(adminCtx, { name: 'Finn', login: 'finn', password: 'finnpass123', roleKeys: ['full_access'] });
      as(fin.userId, 'PUT', '/api/backups');
      expect((await backupsPUT(req('/api/backups', { method: 'PUT', json: true, body: JSON.stringify({ schedule: 'off' }) }))).status).toBe(403);
      as(fin.userId, 'POST', '/api/backups/run');
      expect((await runPOST()).status).toBe(403);
      as(fin.userId, 'POST', '/api/backups/preview');
      expect((await previewPOST(req('/api/backups/preview', { method: 'POST', body: Buffer.from('x') }))).status).toBe(403);
      as(fin.userId, 'POST', '/api/backups/restore');
      expect((await restorePOST(req('/api/backups/restore', { method: 'POST', json: true, body: JSON.stringify({ id: 'x' }) }))).status).toBe(403);
    });
  });

  describe('restore preview', () => {
    it('reads a version read-only in a temp folder: companies, counts, last date, balanced totals, date and version', async () => {
      const startedAt = Date.now();
      const liveCount = await postedCount(db);
      const version = history().find((r) => r.source === 'scheduled' && !r.prunedAt)!;

      as(ownerId, 'POST', '/api/backups/preview');
      const res = await previewPOST(req(`/api/backups/preview?id=${version.id}`, { method: 'POST' }));
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.problems).toEqual([]);
      expect(p.balanced).toBe(true);
      expect(p.appVersion).toMatch(/^\d+\.\d+\.\d+/);
      // The manifest's real creation time (the record's "at" was a simulated future clock).
      expect(Math.abs(Date.parse(p.backupDate) - startedAt)).toBeLessThan(10 * 60 * 1000);
      expect(p.companies).toHaveLength(1);
      const c = p.companies[0];
      expect(c.name).toBe('Backup Bakery');
      expect(c.transactions).toBeGreaterThanOrEqual(2);
      expect(c.lastTransactionDate).toBe('2026-05-01');
      expect(c.trialBalance.balanced).toBe(true);
      expect(c.trialBalance.totalDebit).toBe(c.trialBalance.totalCredit);
      expect(Number(c.trialBalance.totalDebit)).toBeGreaterThan(0);

      // The live company file was not closed, swapped or changed.
      expect(await getDb(TEST_DIR)).toBe(db);
      expect(await postedCount(db)).toBe(liveCount);
      // Temp folders are cleaned up.
      const leftovers = fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith(PREVIEW_DIR_PREFIX))
        .filter((n) => fs.statSync(path.join(os.tmpdir(), n)).mtimeMs >= startedAt - 1000);
      expect(leftovers).toEqual([]);
    });

    it('previews an uploaded file, and rejects a file that is not a backup', async () => {
      const { buffer } = createBackup('Upload', TEST_DIR);
      as(ownerId, 'POST', '/api/backups/preview');
      const res = await previewPOST(req('/api/backups/preview', { method: 'POST', body: buffer }));
      expect(res.status).toBe(200);
      const p = await res.json();
      expect(p.label).toBe('Upload');
      expect(p.companies[0].name).toBe('Backup Bakery');

      const junk = await previewPOST(req('/api/backups/preview', { method: 'POST', body: Buffer.from('not a zip at all') }));
      expect(junk.status).toBe(400);
      expect((await junk.json()).error).toMatch(/Not an Ironbooks backup/);
    });

    it('service level: a fresh backup previews with its own balanced trial balance', async () => {
      // previewBackup on a live backup buffer: totals come from the copy's own trial balance.
      const p = await previewBackup(createBackup(undefined, TEST_DIR).buffer);
      expect(p.companies[0].trialBalance?.balanced).toBe(true);
      expect(await getDb(TEST_DIR)).toBe(db);
    });
  });

  describe('restore from the version list', () => {
    it('restores an older version through the normal restore path; the history is kept', async () => {
      const version = history().find((r) => r.source === 'scheduled' && !r.prunedAt)!;
      const versionCount = await (async () => {
        as(ownerId, 'POST', '/api/backups/preview');
        const p = await (await previewPOST(req(`/api/backups/preview?id=${version.id}`, { method: 'POST' }))).json();
        return p.companies[0].transactions as number;
      })();
      await postSale('999.00', '2026-06-30'); // after the version: must be gone after restore
      const before = history();

      as(ownerId, 'POST', '/api/backups/restore');
      const res = await restorePOST(req('/api/backups/restore', { method: 'POST', json: true, body: JSON.stringify({ id: version.id }) }));
      expect(res.status).toBe(200);
      expect((await res.json()).restored).toBe(true);

      db = await getDb(TEST_DIR);
      trusted = { db, companyId, userId: ownerId };
      expect(await postedCount(db)).toBe(versionCount);
      // History survived the restore (+ the pre-restore safety copy).
      expect(added(before)).toMatchObject({ source: 'pre-op', note: 'Safety copy made before restoring a backup' });
    });

    it('refuses an id that is not in this file’s history', async () => {
      as(ownerId, 'POST', '/api/backups/restore');
      const res = await restorePOST(req('/api/backups/restore', { method: 'POST', json: true, body: JSON.stringify({ id: 'nope' }) }));
      expect(res.status).toBe(404);
    });
  });
});
