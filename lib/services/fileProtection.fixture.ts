/**
 * Test fixture for the company file's own passwords (filecrypto): does what the desktop shell
 * does to open a single company file on a computer (lock it, prepare the working copy, start the
 * server — sealed when the file is protected) and what a browser does between requests (keep
 * the cookies a response set). Shared by the fileProtection.*.test.ts files.
 *
 * Tests mock next/headers with a factory that reads the shared jar from globalThis — never by
 * importing this module from the factory (it imports modules that import next/headers, which
 * would wait for the factory: a deadlock):
 *
 *   vi.mock('next/headers', () => {
 *     const j = ((globalThis as any).__fpJar ??= { cookies: new Map(), headers: new Map() });
 *     return {
 *       cookies: async () => ({ get: (n: string) => (j.cookies.has(n) ? { name: n, value: j.cookies.get(n) } : undefined) }),
 *       headers: async () => new Headers([...j.headers.entries()]),
 *     };
 *   });
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';
import { closeDb } from '@/lib/db';
import { resetSealedState } from '@/lib/db/sealed';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { SESSION_COOKIE, createSessionToken } from '@/lib/auth';
import { resetCompanyFileSaveState } from './companyFileSave';
import { forgetFileKeys } from './fileProtection';

const require = createRequire(import.meta.url);
export const format = require('../../electron/companyFileFormat.js');
export const lockMod = require('../../electron/companyLock.js');
export const sessionMod = require('../../electron/companySession.js');
export const fileCrypto = require('../../electron/fileCrypto.js');

/** The "browser": cookies kept between requests, headers of the current request (shared with the mock). */
const gj = globalThis as typeof globalThis & { __fpJar?: { cookies: Map<string, string>; headers: Map<string, string> } };
gj.__fpJar ??= { cookies: new Map<string, string>(), headers: new Map<string, string>() };
export const jar = gj.__fpJar;

/** A request to an API route (JSON body), from this computer unless `remoteAddr` is given. */
export function apiRequest(method: string, url: string, body?: unknown, opts: { remoteAddr?: string; headers?: Record<string, string> } = {}) {
  jar.headers.clear();
  jar.headers.set(ROUTE_PATH_HEADER, new URL(`http://127.0.0.1${url}`).pathname);
  jar.headers.set(ROUTE_METHOD_HEADER, method);
  jar.headers.set('host', '127.0.0.1');
  const headers: Record<string, string> = { host: '127.0.0.1', ...(opts.headers ?? {}) };
  if (body !== undefined && !(body instanceof Uint8Array)) headers['content-type'] = 'application/json';
  if (opts.remoteAddr) {
    headers['x-bka-remote-addr'] = opts.remoteAddr;
    jar.headers.set('x-bka-remote-addr', opts.remoteAddr);
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) jar.headers.set(k, v);
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
}

/** Keep the cookies a response set (like the browser). */
export function keepCookies(res: Response): void {
  for (const c of (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

/** Act as a signed-in user (a session cookie for this launch). */
export function signedInAs(userId: string, sessionId?: string): void {
  jar.cookies.set(SESSION_COOKIE, createSessionToken(userId, 'user', sessionId));
}

/** File > New Company: an empty company file, exactly as the shell writes it. */
export async function newCompanyFile(file: string, companyName: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  const fileId = `fid-${Math.random().toString(16).slice(2)}`;
  await format.writeCompanyFile(file, {
    manifest: { formatVersion: format.COMPANY_FILE_FORMAT_VERSION, fileId, companyName, saveId: 'genesis', previousSaveId: null, savedAt: now },
    entries: [
      { name: 'bookkeeper-company.json', data: Buffer.from(JSON.stringify({ schema: 'bookkeeper-company/v1', name: companyName, createdAt: now })) },
      { name: '.file-id', data: Buffer.from(fileId) },
    ],
  });
}

export interface OpenedFile {
  file: string;
  workDir: string;
  dataDir: string;
  plan: string;
  sealed: string | null;
  lock: { token: string; dir: string };
  conflictCopy: string | null;
}

let current: OpenedFile | null = null;

/** Open `file` on the computer whose user data is `userData` (a fresh launch: `launch`). */
export async function openOn(file: string, userData: string, launch: string, opts: { onConflict?: () => Promise<boolean> } = {}): Promise<OpenedFile> {
  process.env.BKA_INTERNAL_TOKEN = launch;
  const acquired = lockMod.acquire(file, { appUser: 'test' });
  const lock = acquired.ok ? acquired.lock : lockMod.takeOver(file, acquired.holder, { appUser: 'test' }).lock;
  const prep = await sessionMod.prepareWorkingCopy(file, { root: path.join(userData, 'Working'), onConflict: opts.onConflict });
  process.env.BKA_DATA_DIR = prep.dataDir;
  process.env.BKA_COMPANY_FILE = file;
  process.env.BKA_COMPANY_STATE = path.join(prep.workDir, 'state.json');
  process.env.BKA_COMPANY_LOCK = lock.dir;
  process.env.BKA_COMPANY_LOCK_TOKEN = lock.token;
  if (prep.sealed) process.env.BKA_COMPANY_SEALED = prep.sealed;
  else delete process.env.BKA_COMPANY_SEALED;
  resetSealedState();
  resetCompanyFileSaveState();
  jar.cookies.clear();
  current = { file, workDir: prep.workDir, dataDir: prep.dataDir, plan: prep.plan, sealed: prep.sealed ?? null, lock, conflictCopy: prep.conflictCopy ?? null };
  return current;
}

/** The app stops on that computer (without saving): everything it held in memory is gone. */
export async function quit(): Promise<void> {
  await closeDb().catch(() => undefined);
  if (current) {
    try {
      lockMod.release(current.lock);
    } catch {
      /* already gone */
    }
  }
  current = null;
  forgetFileKeys();
  resetSealedState();
  resetCompanyFileSaveState();
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE', 'BKA_COMPANY_LOCK', 'BKA_COMPANY_LOCK_TOKEN', 'BKA_COMPANY_SEALED']) delete process.env[k];
}

/** Reset the sign-in / reset rate limiters (each test starts with a clean slate). */
export function resetLimiters(): void {
  const g = globalThis as unknown as { __bkaResetLimiter?: unknown; __bkaLoginLimiter?: unknown };
  g.__bkaResetLimiter = undefined;
  g.__bkaLoginLimiter = undefined;
}

/** True when `secret` opens the company file's CURRENT manifest (after a save) for `login`. */
export async function fileOpensWith(file: string, kind: 'password' | 'challenge' | 'recovery', secret: string, login: string | null = null): Promise<boolean> {
  const m = format.readCompanyManifest(file);
  if (!format.isSealedManifest(m)) return false;
  return Boolean(await fileCrypto.unlockWith(m.encryption, { kind, login, secret }));
}
