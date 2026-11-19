/**
 * Security work package E1 (SECURITY-PLAN 1.5 rows 1 and 4), through the real /api/backups route
 * handlers (`next/headers` mocked, same hermetic pattern as backups.integration.test.ts):
 *
 *  - A signed-in Admin on ANOTHER computer (multi-user hosting) cannot change the host's backup
 *    folder (which would make the host write every full backup to, and offer its credentials to, a
 *    share of their choosing); schedule and versions kept still save, and sending the folder as it
 *    is is no error. GET tells the page it is used from another computer.
 *  - Preview and restore of a listed version never read a record that names a network path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', `test-sec1-backup-routes-${process.pid}`);
const TEST_DIR = path.join(ROOT, 'company');
const BACKUP_DIR = path.join(ROOT, 'backups');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_BACKUP_DIR = BACKUP_DIR;
process.env.BKA_AUTH_SECRET = 'sec1-backup-routes-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { REMOTE_ADDR_HEADER } from '@/lib/net/requestInfo';
import { createCompany } from './company';
import { startSession } from './sessions';
import {
  BACKUP_HISTORY_FILE,
  BACKUP_SETTINGS_FILE,
  REMOTE_FOLDER_CHANGE_MESSAGE,
  backupFoldersHere,
  readBackupSettings,
  saveBackupSettings,
} from './backupHistory';
import { runVersionedBackup, stopBackupScheduler } from './backupSchedule';
import { GET as backupsGET, PUT as backupsPUT } from '@/app/api/backups/route';
import { POST as previewPOST } from '@/app/api/backups/preview/route';
import { POST as restorePOST } from '@/app/api/backups/restore/route';

const REMOTE_ADDR = '100.64.0.9';
const HOST = 'attacker-host';
const onShare = (name: string) => (process.platform === 'win32' ? `\\\\${HOST}\\drop\\${name}` : `//${HOST}/drop/${name}`);

let db: DB;
let companyId: string;
let ownerId: string;

/** Requests as the owner from this computer (legacy cookie) or from another one (live session). */
function as(routePath: string, method: string, opts: { remoteSid?: string } = {}) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  if (opts.remoteSid) h.headers.set(REMOTE_ADDR_HEADER, REMOTE_ADDR);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, opts.remoteSid ? createSessionToken(ownerId, 'user', opts.remoteSid) : createSessionToken(ownerId));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
function req(url: string, init: { method: string; body?: unknown; remote?: boolean }) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.remote ? { [REMOTE_ADDR_HEADER]: REMOTE_ADDR } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const chosenHere = (folder: string) =>
  backupFoldersHere(TEST_DIR).some((f) => path.resolve(f).toLowerCase() === path.resolve(folder).toLowerCase());

describe('backup routes', () => {
  beforeAll(async () => {
    stopBackupScheduler();
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@sec1-backups.local', name: 'Ola Owner', passwordHash: await hashPassword('ownerpass123') })
      .returning();
    ownerId = owner.id;
    companyId = (await createCompany(db, { name: 'Sec Bakery', ownerId })).id;
  }, 180_000);

  afterAll(async () => {
    stopBackupScheduler();
    await closeDb(TEST_DIR);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('preview and restore by id never read a record that names a network path; a real version still previews', async () => {
    const made = await runVersionedBackup('manual', { dataDir: TEST_DIR, force: true });
    expect(made.status).toBe('created');
    const history = JSON.parse(fs.readFileSync(path.join(TEST_DIR, BACKUP_HISTORY_FILE), 'utf8'));
    history.records.push({ id: 'evil', at: '2020-01-01T00:00:00.000Z', source: 'manual', kind: 'full', filename: 'backup-evil.bka', path: onShare('backup-evil.bka'), sizeBytes: 3 });
    fs.writeFileSync(path.join(TEST_DIR, BACKUP_HISTORY_FILE), JSON.stringify(history));

    const touched: string[] = [];
    for (const name of ['existsSync', 'statSync', 'realpathSync', 'readFileSync'] as const) {
      const real = fs[name] as unknown as (...a: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).toLowerCase().includes(HOST)) {
          touched.push(String(args[0]));
          if (name === 'existsSync') return false;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return real.apply(fs, args);
      }) as never);
    }
    try {
      as('/api/backups/preview', 'POST');
      expect((await previewPOST(req('/api/backups/preview?id=evil', { method: 'POST' }))).status).toBe(404);
      as('/api/backups/restore', 'POST');
      expect((await restorePOST(req('/api/backups/restore', { method: 'POST', body: { id: 'evil' } }))).status).toBe(404);
      as('/api/backups', 'GET');
      const listed = await (await backupsGET()).json();
      expect(listed.history.find((r: { id: string }) => r.id === 'evil').available).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
    expect(touched).toEqual([]);

    if (made.status !== 'created') return;
    as('/api/backups/preview', 'POST');
    const ok = await previewPOST(req(`/api/backups/preview?id=${made.record.id}`, { method: 'POST' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).companies[0].name).toBe('Sec Bakery');
    stopBackupScheduler();
  }, 120_000);

  it('from another computer: schedule and versions kept save, the folder cannot be changed', async () => {
    const { id: sid } = await startSession(db, { userId: ownerId, companyId, remoteAddr: REMOTE_ADDR, viaHost: true });
    const remote = { remoteSid: sid };

    as('/api/backups', 'GET', remote);
    const seen = await backupsGET();
    expect(seen.status).toBe(200);
    expect((await seen.json()).remote).toBe(true);

    // Schedule and versions kept: saved.
    as('/api/backups', 'PUT', remote);
    const sched = await backupsPUT(req('/api/backups', { method: 'PUT', remote: true, body: { schedule: 'hours', everyHours: 6, keep: 9 } }));
    expect(sched.status).toBe(200);
    expect(readBackupSettings(TEST_DIR)).toMatchObject({ schedule: 'hours', everyHours: 6, keep: 9, folder: null });

    // A folder on the remote person's own computer: refused, nothing created, nothing approved.
    const theirShare = path.join(ROOT, 'their-pc-share');
    for (const folder of [theirShare, onShare('backups')]) {
      as('/api/backups', 'PUT', remote);
      const refused = await backupsPUT(req('/api/backups', { method: 'PUT', remote: true, body: { schedule: 'daily', keep: 3, folder } }));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'FORBIDDEN', error: REMOTE_FOLDER_CHANGE_MESSAGE });
    }
    expect(fs.existsSync(theirShare)).toBe(false);
    expect(chosenHere(theirShare)).toBe(false);
    // The refused request changed nothing at all.
    expect(readBackupSettings(TEST_DIR)).toMatchObject({ schedule: 'hours', keep: 9, folder: null });

    // Sending the folder as it is (none) is no error.
    as('/api/backups', 'PUT', remote);
    expect((await backupsPUT(req('/api/backups', { method: 'PUT', remote: true, body: { schedule: 'daily', keep: 7, folder: null } }))).status).toBe(200);
    expect(readBackupSettings(TEST_DIR)).toMatchObject({ schedule: 'daily', keep: 7, folder: null });

    // Chosen on this computer: sending it unchanged from the other one is fine too.
    const office = path.join(ROOT, 'office-backups');
    as('/api/backups', 'PUT');
    expect((await backupsPUT(req('/api/backups', { method: 'PUT', body: { folder: office } }))).status).toBe(200);
    as('/api/backups', 'PUT', remote);
    expect((await backupsPUT(req('/api/backups', { method: 'PUT', remote: true, body: { keep: 5, folder: office } }))).status).toBe(200);
    expect(readBackupSettings(TEST_DIR)).toMatchObject({ keep: 5, folder: path.resolve(office) });

    // A folder that came in with the company file: approving it on this computer from another one
    // is a change of where this computer's backups go, so it is refused as well.
    const cameWithFile = path.join(ROOT, 'came-with-file');
    fs.mkdirSync(cameWithFile, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, BACKUP_SETTINGS_FILE), JSON.stringify({ ...readBackupSettings(TEST_DIR), folder: cameWithFile }));
    as('/api/backups', 'PUT', remote);
    expect((await backupsPUT(req('/api/backups', { method: 'PUT', remote: true, body: { folder: cameWithFile } }))).status).toBe(403);
    expect(chosenHere(cameWithFile)).toBe(false);

    // On this computer the folder can be changed as before, and the page is told it is local.
    as('/api/backups', 'PUT');
    expect((await backupsPUT(req('/api/backups', { method: 'PUT', body: { folder: cameWithFile } }))).status).toBe(200);
    expect(chosenHere(cameWithFile)).toBe(true);
    as('/api/backups', 'GET');
    expect((await (await backupsGET()).json()).remote).toBe(false);
    saveBackupSettings({ folder: null }, TEST_DIR);
    stopBackupScheduler();
  }, 120_000);
});
