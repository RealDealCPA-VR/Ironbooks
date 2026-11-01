/**
 * The password belongs to the company file (filecrypto) — the fresh-install portability test.
 *
 * A company file is created and set up on "computer A" (its own user data, its own working
 * copy, no BKA_AUTH_SECRET), an AI provider key is stored, the file is saved and closed. Then it
 * is opened on "computer B": a brand-new user data folder that has never seen the file, still
 * with BKA_AUTH_SECRET unset. Everything the books need travels in the file:
 *  - the file is encrypted at rest (no customer name in its bytes) and opens only with the file's
 *    own user name + password, with ONE sign-in that decrypts it and starts the session;
 *  - a wrong password and an unknown user name get the same answer, and nothing is decrypted;
 *  - the stored AI key works on B (it is sealed with the file's own vault secret);
 *  - after a clean close the plain-text working copy is gone from the computer.
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
delete process.env.BKA_AUTH_SECRET; // only the file's own secrets — nothing machine-bound
process.env.BKA_OFFLINE = '1';

const require = createRequire(import.meta.url);
const format = require('../../electron/companyFileFormat.js');
const lockMod = require('../../electron/companyLock.js');
const sessionMod = require('../../electron/companySession.js');
const fileCrypto = require('../../electron/fileCrypto.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-portable-'));
const SHARE = path.join(ROOT, 'Office Share');
const FILE = path.join(SHARE, 'Marigold Bakery.ironbooks');
const USER_A = path.join(ROOT, 'computer-A');
const USER_B = path.join(ROOT, 'computer-B');
const CUSTOMER = 'Zebulon Quarterfield Holdings';
const API_KEY = 'sk-ant-portable-test-0123456789';
fs.mkdirSync(SHARE, { recursive: true });

import { closeDb, getDb } from '@/lib/db';
import { resetSealedState } from '@/lib/db/sealed';
import { customers, fileKeySlots, users } from '@/lib/db/schema';
import { SESSION_COOKIE, UNLOCK_COOKIE, verifySessionToken } from '@/lib/auth';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as unlockPOST } from '@/app/api/unlock/route';
import { GET as infoGET } from '@/app/api/company-file/info/route';
import { closeCompanyFile, resetCompanyFileSaveState, saveCompanyFile } from './companyFileSave';
import { forgetFileKeys, readProtection } from './fileProtection';
import { getPublicSettings, updateSettings } from './aiSettings';
import { openStoredSecret, readVaultSecret } from '@/lib/ai/keyVault';
import { createCustomer } from './customers';

let lock: { token: string; dir: string } | null = null;
let workA = '';
let companyId = '';

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

/** Cookies a response set, kept for the next request (like the browser would). */
function keepCookies(res: Response) {
  for (const c of (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    h.cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

/** What the desktop shell does to open the company file on a computer (electron/main.js). */
async function openOn(userData: string, launch: string) {
  process.env.BKA_INTERNAL_TOKEN = launch;
  lock = lockMod.acquire(FILE, { appUser: 'Pat' }).lock;
  const prep = await sessionMod.prepareWorkingCopy(FILE, { root: path.join(userData, 'Working') });
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(prep.workDir, 'state.json');
  process.env.BKA_COMPANY_LOCK = lock!.dir;
  process.env.BKA_COMPANY_LOCK_TOKEN = lock!.token;
  if (prep.sealed) process.env.BKA_COMPANY_SEALED = prep.sealed;
  else delete process.env.BKA_COMPANY_SEALED;
  resetSealedState();
  resetCompanyFileSaveState();
  h.cookies.clear();
  return prep;
}

/** The app stops on that computer: everything it held in memory is gone. */
async function quit() {
  await closeDb().catch(() => undefined);
  if (lock) lockMod.release(lock);
  lock = null;
  forgetFileKeys();
  resetSealedState();
  resetCompanyFileSaveState();
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE', 'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN', 'BKA_COMPANY_SEALED']) delete process.env[k];
}

beforeAll(async () => {
  // File > New Company: an empty company file, exactly as the shell writes it.
  const now = new Date().toISOString();
  await format.writeCompanyFile(FILE, {
    manifest: { formatVersion: format.COMPANY_FILE_FORMAT_VERSION, fileId: 'fid-portable', companyName: 'Marigold Bakery', saveId: 'genesis', previousSaveId: null, savedAt: now },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: 'Marigold Bakery', createdAt: now })) },
      { name: '.file-id', data: Buffer.from('fid-portable') },
    ],
  });
}, 60_000);

afterAll(async () => {
  await quit();
  delete process.env.BKA_INTERNAL_TOKEN;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe('a protected company file is portable to a fresh install', () => {
  it('computer A: the Admin set up at /signup protects the new file from its first save', async () => {
    const prep = await openOn(USER_A, 'launch-A');
    workA = prep.workDir;
    expect(prep.sealed).toBeNull(); // a brand-new file is not protected yet
    const res = await signupPOST(
      req('/api/auth/signup', {
        name: 'Pat Owner',
        email: 'pat',
        password: 'Bakery-Pass-2026',
        companyName: 'Marigold Bakery',
        challengeQuestion: 'Name of your first pet',
        challengeAnswer: 'Biscuit',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    companyId = body.companyId;
    // The recovery key, shown once: 24 characters in groups of four.
    expect(body.recoveryKey).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    expect(body.protected).toBe(true);
    const db = await getDb();
    expect(await readProtection(db)).not.toBeNull();
    const slots = await db.select({ kind: fileKeySlots.kind }).from(fileKeySlots);
    expect(slots.map((s) => s.kind).sort()).toEqual(['challenge', 'password', 'recovery']);

    // Books and a stored AI key.
    const [pat] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'pat'));
    const ctx = { db, companyId, userId: pat.id };
    await createCustomer(ctx, { displayName: CUSTOMER } as Parameters<typeof createCustomer>[1]);
    await updateSettings(ctx, { providers: [{ kind: 'anthropic', label: 'Claude', apiKey: API_KEY, enabled: true }] } as Parameters<typeof updateSettings>[1]);

    const saved = await saveCompanyFile({ force: true });
    expect(saved).toMatchObject({ outcome: 'saved', encrypted: true });
  }, 180_000);

  it('the company file on the share is encrypted: only its listing fields and key slots are readable', () => {
    const m = format.readCompanyManifest(FILE);
    expect(format.isSealedManifest(m)).toBe(true);
    expect(m).toMatchObject({ formatVersion: 2, companyName: 'Marigold Bakery', fileId: 'fid-portable' });
    expect(m.encryption.slots.length).toBe(3);
    expect(JSON.stringify(m)).not.toMatch(/pat/i); // no user names
    const raw = fs.readFileSync(FILE);
    expect(raw.includes(Buffer.from(CUSTOMER))).toBe(false);
    expect(raw.includes(Buffer.from('Zebulon'))).toBe(false);
    expect(raw.includes(Buffer.from(API_KEY))).toBe(false);
    expect(raw.includes(Buffer.from('Pat Owner'))).toBe(false);
  });

  it('computer A closes the file: everything is saved and the plain-text working copy is removed', async () => {
    const r = await closeCompanyFile();
    expect(r.workingCopyRemoved).toBe(true);
    expect(fs.existsSync(sessionMod.dataDirOf(workA))).toBe(false);
    await quit();
  }, 120_000);

  it('computer B (fresh install): the file opens only with its own user name and password', async () => {
    const prep = await openOn(USER_B, 'launch-B');
    expect(prep.sealed).toBe('extract');
    expect(fs.existsSync(path.join(USER_A, 'Working'))).toBe(true);

    // Nothing is readable before the sign-in: the books are not even decrypted yet.
    await expect(getDb()).rejects.toThrow(/Authentication required/);
    const info = await (await infoGET()).json();
    expect(info).toMatchObject({ companyName: 'Marigold Bakery', protected: true, hasUsers: true });

    // The unlock screen only lets the sign-in screen show.
    const un = await unlockPOST(req('/api/unlock', { password: '' }));
    expect(un.status).toBe(200);
    keepCookies(un);

    // A wrong password and an unknown user name: the same answer, nothing decrypted.
    const wrong = await loginPOST(req('/api/auth/login', { email: 'pat', password: 'not-the-password' }));
    expect(wrong.status).toBe(401);
    const unknown = await loginPOST(req('/api/auth/login', { email: 'nobody', password: 'Bakery-Pass-2026' }));
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).error).toBe((await unknown.json()).error);
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(false);

    // The right one: ONE sign-in decrypts the file AND starts the session.
    const ok = await loginPOST(req('/api/auth/login', { email: 'pat', password: 'Bakery-Pass-2026' }));
    expect(ok.status).toBe(200);
    keepCookies(ok);
    expect(verifySessionToken(h.cookies.get(SESSION_COOKIE))).not.toBeNull();
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(true);
    expect(h.cookies.has(UNLOCK_COOKIE)).toBe(true);
  }, 180_000);

  it('everything the books need came with the file, the stored AI key included', async () => {
    const db = await getDb();
    const [c] = await db.select({ name: customers.displayName }).from(customers).where(eq(customers.displayName, CUSTOMER));
    expect(c?.name).toBe(CUSTOMER);
    const [pat] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'pat'));
    const ctx = { db, companyId, userId: pat.id };
    const settings = await getPublicSettings(ctx);
    expect(settings.providers[0]).toMatchObject({ hasApiKey: true });
    expect((settings.providers[0] as { apiKeyUnreadable?: boolean }).apiKeyUnreadable).toBeUndefined();
    // And it decrypts to the key that was typed on computer A.
    const { aiSettings } = await import('@/lib/db/schema');
    const [row] = await db.select({ providers: aiSettings.providers }).from(aiSettings).where(eq(aiSettings.companyId, companyId));
    const blob = (row.providers as Array<{ apiKeyEnc: string }>)[0].apiKeyEnc;
    expect(openStoredSecret(blob, companyId, await readVaultSecret(db))).toBe(API_KEY);
    // Computer B never had a session-signing secret before: it made its own, inside its working copy.
    expect(fs.existsSync(path.join(process.env.BKA_DATA_DIR!, '.auth-secret'))).toBe(true);
  }, 60_000);

  it('the recovery key and the challenge answer each open the file on their own', async () => {
    const m = format.readCompanyManifest(FILE);
    expect(await fileCrypto.unlockWith(m.encryption, { kind: 'challenge', login: 'pat', secret: 'biscuit' })).not.toBeNull();
    expect(await fileCrypto.unlockWith(m.encryption, { kind: 'challenge', login: 'pat', secret: 'cookie' })).toBeNull();
  });
});
