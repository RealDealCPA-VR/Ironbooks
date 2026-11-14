/**
 * A company file protected with passwords whose working copy will not start after a crash
 * (lib/services/workingCopyRecovery.ts). Reopened on the same computer, the shell plans to reuse
 * the working copy ('key': the sign-in reads its users from it) — which cannot start. The sign-in
 * must still work: the damaged copy is kept aside and the sign-in decrypts the company file's last
 * save instead, like opening it on a new computer, and says what was lost.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

process.env.BKA_TEST_FAST_KDF = '1';
delete process.env.BKA_AUTH_SECRET; // the working copy's own session-signing key
process.env.BKA_OFFLINE = '1';
process.env.BKA_RECOVERY_RETRY_MS = '50';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-recover-sealed-'));
const SHARE = path.join(ROOT, 'Office Share');
const FILE = path.join(SHARE, 'Marigold Bakery.ironbooks');
const USER_DATA = path.join(ROOT, 'computer');
fs.mkdirSync(SHARE, { recursive: true });

import { closeDb, getDb } from '@/lib/db';
import { damageCheckpoint } from '@/lib/db/damage.fixture';
import { resetSealedState, sealedMode } from '@/lib/db/sealed';
import { customers, users } from '@/lib/db/schema';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';
import { forgetFileKeys } from './fileProtection';
import { createCustomer } from './customers';
import { dataDirProblem, resetRecoveryState } from './workingCopyRecovery';

let lock: { token: string; dir: string } | null = null;

function req(url: string, body: unknown) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, new URL(`http://127.0.0.1${url}`).pathname);
  h.headers.set(ROUTE_METHOD_HEADER, 'POST');
  h.headers.set('host', '127.0.0.1');
  return new NextRequest(`http://127.0.0.1${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify(body),
  });
}

/** What the desktop shell does to open the company file (electron/main.js). */
async function open(launch: string) {
  process.env.BKA_INTERNAL_TOKEN = launch;
  lock = lockMod.acquire(FILE, { appUser: 'Pat' }).lock;
  const prep = await sessionMod.prepareWorkingCopy(FILE, { root: path.join(USER_DATA, 'Working') });
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(prep.workDir, 'state.json');
  process.env.BKA_COMPANY_LOCK = lock!.dir;
  process.env.BKA_COMPANY_LOCK_TOKEN = lock!.token;
  if (prep.sealed) process.env.BKA_COMPANY_SEALED = prep.sealed;
  else delete process.env.BKA_COMPANY_SEALED;
  resetSealedState();
  resetCompanyFileSaveState();
  resetRecoveryState();
  h.cookies.clear();
  return prep;
}

/** The app stops without closing the company file (crash, power cut): memory is gone. */
async function crash() {
  await closeDb().catch(() => undefined);
  if (lock) lockMod.release(lock);
  lock = null;
  forgetFileKeys();
  resetSealedState();
  resetCompanyFileSaveState();
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: format.COMPANY_FILE_FORMAT_VERSION, fileId: 'fid-sealed-recover', companyName: 'Marigold Bakery', saveId: 'genesis', previousSaveId: null, savedAt: now },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Marigold Bakery', createdAt: now })) },
      { name: '.file-id', data: Buffer.from('fid-sealed-recover') },
    ],
  });
}, 60_000);

afterAll(async () => {
  await crash();
  resetRecoveryState();
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE', 'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN', 'BKA_COMPANY_SEALED', 'BKA_INTERNAL_TOKEN']) delete process.env[k];
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe('a protected company file whose working copy will not start after a crash', () => {
  let workDir = '';
  let secretBefore = '';

  it('is set up, saved (encrypted) and changed again, then the app crashes and the copy is damaged', async () => {
    const prep = await open('launch-1');
    workDir = prep.workDir;
    const res = await signupPOST(
      req('/api/auth/signup', {
        name: 'Pat Owner',
        email: 'pat',
        password: 'Bakery-Pass-2026',
        companyName: 'Marigold Bakery',
        challengeQuestion: 'Name of your first pet',
        challengeAnswer: 'Biscuit the corgi',
      }),
    );
    expect(res.status).toBe(201);
    const { companyId } = await res.json();
    const db = await getDb();
    const [pat] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'pat'));
    const ctx = { db, companyId, userId: pat.id };
    await createCustomer(ctx, { displayName: 'Saved Customer' } as Parameters<typeof createCustomer>[1]);
    expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved', encrypted: true });
    await createCustomer(ctx, { displayName: 'Unsaved Customer' } as Parameters<typeof createCustomer>[1]);
    secretBefore = fs.readFileSync(path.join(prep.dataDir, '.auth-secret'), 'utf8');

    await crash();
    damageCheckpoint(prep.dataDir);
  }, 180_000);

  it('a sign-in with a wrong password changes nothing: only someone who can open the file triggers a recovery', async () => {
    const prep = await open('launch-2');
    expect(prep.plan).toBe('recover');
    expect(prep.sealed).toBe('key'); // the shell plans to reuse the (damaged) working copy

    const wrong = await loginPOST(req('/api/auth/login', { email: 'pat', password: 'not-the-password' }));
    expect(wrong.status).toBe(401);
    const nobody = await loginPOST(req('/api/auth/login', { email: 'nobody', password: 'Bakery-Pass-2026' }));
    expect(nobody.status).toBe(401);
    expect((await wrong.json()).error).toBe((await nobody.json()).error);
    // Untouched: still the damaged working copy, nothing set aside, still waiting for a sign-in.
    expect(sealedMode()).toBe('key');
    expect(dataDirProblem(prep.dataDir)).toMatch(/missing/);
    expect(fs.readdirSync(workDir).filter((n) => n.startsWith(sessionMod.DAMAGED_PREFIX))).toEqual([]);
    await expect(getDb()).rejects.toThrow(/Authentication required/);
  }, 120_000);

  it('the next sign-in reopens the company file as last saved and says what was lost', async () => {
    const prep = { dataDir: process.env.BKA_DATA_DIR! };

    const res = await loginPOST(req('/api/auth/login', { email: 'pat', password: 'Bakery-Pass-2026' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recovery).toMatchObject({ changesLost: true });
    expect(body.recovery.message).toMatch(/reopened your company file as it was last saved/);
    expect(sealedMode()).toBeNull();

    const db = await getDb();
    const names = (await db.select({ name: customers.displayName }).from(customers)).map((c) => c.name);
    expect(names).toContain('Saved Customer');
    expect(names).not.toContain('Unsaved Customer');
    // The damaged copy is kept next to the working copy, ENCRYPTED like the company file (the same
    // passwords open it): no plain-text copy of protected books is left behind.
    expect(path.dirname(body.recovery.keptAt)).toBe(workDir);
    expect(body.recovery.keptAt).toMatch(/\.ironbooks$/);
    expect(format.isSealedManifest(format.readCompanyManifest(body.recovery.keptAt))).toBe(true);
    expect(fs.readFileSync(body.recovery.keptAt).includes(Buffer.from('Unsaved Customer'))).toBe(false);
    const kept = fs.readdirSync(workDir).filter((n) => n.startsWith(sessionMod.DAMAGED_PREFIX));
    expect(kept).toEqual([path.basename(body.recovery.keptAt)]);
    expect(sessionMod.readState(workDir).damagedPlain ?? null).toBeNull();
    // This computer's session key stays.
    expect(fs.readFileSync(path.join(prep.dataDir, '.auth-secret'), 'utf8')).toBe(secretBefore);
  }, 180_000);

  it('saving works again (still encrypted)', async () => {
    const db = await getDb();
    const [pat] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'pat'));
    const [company] = await db.select({ id: customers.companyId }).from(customers).limit(1);
    await createCustomer({ db, companyId: company.id, userId: pat.id }, { displayName: 'After Recovery' } as Parameters<typeof createCustomer>[1]);
    expect(await saveCompanyFile({ force: true })).toMatchObject({ outcome: 'saved', encrypted: true });
    expect(fs.readFileSync(FILE).includes(Buffer.from('After Recovery'))).toBe(false);
  }, 120_000);
});
