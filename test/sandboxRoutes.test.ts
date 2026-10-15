/**
 * Sandbox mode API routes (app/api/sandbox/**), driven without HTTP (session mocked), plus the
 * desktop shell's marker reader (electron/companyFile.js):
 *  - start / leave fail closed without a session; an accountant cannot start or leave;
 *  - the owner starts a sandbox (201), the public status flag turns on, the auto-backup route
 *    refuses while in the sandbox, keep validates the name, discard returns to the real file;
 *  - leftover routes resume and delete a copy, also when its id has a "%" ("50% Off LLC");
 *  - a held file-password unlock is re-issued for the folder the server switched to;
 *  - keep: a Windows device name is a 400, a non-Admin gets 403 whatever the name, and a copy
 *    that cannot be moved after leaving answers 200 with trainingDir null and a warning.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', `test-sandbox-routes-${process.pid}`);
const REAL = path.join(ROOT, 'Route Co.ironbooks');
process.env.BKA_DATA_DIR = REAL;
process.env.BKA_SANDBOX_ROOT = path.join(ROOT, 'sandboxes');

const session = vi.hoisted(() => ({ userId: null as string | null, headers: new Map<string, string>(), unlock: undefined as string | undefined }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSessionUserId: async () => session.userId,
    getSessionInfo: async () => (session.userId ? { userId: session.userId } : null),
  };
});
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'bka_unlock' && session.unlock ? { name, value: session.unlock } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers([...session.headers.entries()]),
}));
function route(method: string, routePath: string) {
  session.headers.set('x-bka-route-path', routePath);
  session.headers.set('x-bka-route-method', method);
}

import { closeDb, getDb, resolveDataDir } from '@/lib/db';
import { userCompanies, users } from '@/lib/db/schema';
import { UNLOCK_COOKIE, createUnlockToken, verifyUnlockToken } from '@/lib/auth';
import { createCompany } from '@/lib/services/company';
import { sandboxFs, switchActiveDataDir } from '@/lib/services/sandbox';
import { GET as sandboxGET, POST as sandboxPOST } from '@/app/api/sandbox/route';
import { GET as statusGET } from '@/app/api/sandbox/status/route';
import { POST as discardPOST } from '@/app/api/sandbox/discard/route';
import { POST as keepPOST } from '@/app/api/sandbox/keep/route';
import { POST as leftoverPOST, DELETE as leftoverDELETE } from '@/app/api/sandbox/leftovers/[id]/route';
import { POST as autoBackupPOST } from '@/app/api/dashboard/auto-backup/route';

const companyFile = createRequire(import.meta.url)('../electron/companyFile.js') as {
  SANDBOX_MARKER: string;
  readSandboxMarker: (dir: string) => { kind: string; realDataDir: string } | null;
};

let ownerId: string;
let accountantId: string;
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(`http://localhost${url}`, init);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('sandbox API routes', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    const db = await getDb();
    const [owner] = await db.insert(users).values({ email: 'owner@sbroutes.test', name: 'Owner', passwordHash: 'h1' }).returning();
    const [acct] = await db.insert(users).values({ email: 'acct@sbroutes.test', name: 'Accountant', passwordHash: 'h2' }).returning();
    ownerId = owner.id;
    accountantId = acct.id;
    const company = await createCompany(db, { name: 'Route Co', ownerId });
    await db.insert(userCompanies).values({ userId: accountantId, companyId: company.id, role: 'accountant' });
  }, 180_000);

  afterAll(async () => {
    const active = resolveDataDir();
    switchActiveDataDir(REAL);
    await closeDb(active).catch(() => undefined);
    await closeDb(REAL).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    delete process.env.BKA_DATA_DIR;
    delete process.env.BKA_SANDBOX_ROOT;
    delete process.env.BKA_SANDBOX;
    delete process.env.BKA_INTERNAL_TOKEN;
  });

  it('fails closed without a session and refuses an accountant', async () => {
    session.userId = null;
    route('POST', '/api/sandbox');
    expect((await sandboxPOST(req('/api/sandbox', { method: 'POST' }))).status).toBe(403);
    route('POST', '/api/sandbox/discard');
    expect((await discardPOST(req('/api/sandbox/discard', { method: 'POST' }))).status).toBe(403);

    session.userId = accountantId;
    route('POST', '/api/sandbox');
    expect((await sandboxPOST(req('/api/sandbox', { method: 'POST' }))).status).toBe(403);
    expect(fs.existsSync(path.join(ROOT, 'sandboxes'))).toBe(false);
  });

  it('starts a sandbox, exposes the flag, blocks the auto-backup and leaves by discarding', async () => {
    session.userId = ownerId;
    route('GET', '/api/sandbox');
    expect(await (await sandboxGET()).json()).toMatchObject({ active: false, leftovers: [] });

    route('POST', '/api/sandbox');
    const started = await sandboxPOST(req('/api/sandbox', { method: 'POST' }));
    expect(started.status).toBe(201);
    const { dir, realDir } = await started.json();
    expect(realDir).toBe(path.resolve(REAL));
    expect(resolveDataDir()).toBe(path.resolve(dir));
    // The desktop shell reads the same marker to know it is running a practice copy.
    expect(companyFile.readSandboxMarker(dir)).toMatchObject({ kind: 'sandbox', realDataDir: path.resolve(REAL) });
    expect(companyFile.readSandboxMarker(REAL)).toBeNull();

    route('GET', '/api/sandbox/status');
    expect(await (await statusGET()).json()).toMatchObject({ active: true, kind: 'sandbox' });

    // The shell's quit-time auto-backup is refused in the sandbox.
    process.env.BKA_INTERNAL_TOKEN = 'sandbox-internal-token';
    route('POST', '/api/dashboard/auto-backup');
    const backup = await autoBackupPOST(
      req('/api/dashboard/auto-backup', { method: 'POST', headers: { 'x-bka-internal': 'sandbox-internal-token' } }),
    );
    expect(backup.status).toBe(403);
    expect((await backup.json()).error).toMatch(/Automatic backup is turned off in the sandbox/);

    // An accountant (not an Admin of the real file) cannot leave; bad keep bodies are refused.
    session.userId = accountantId;
    route('POST', '/api/sandbox/discard');
    expect((await discardPOST(req('/api/sandbox/discard', { method: 'POST' }))).status).toBe(403);
    session.userId = ownerId;
    route('POST', '/api/sandbox/keep');
    expect((await keepPOST(req('/api/sandbox/keep', { method: 'POST', body: 'not json' }))).status).toBe(400);
    expect((await keepPOST(req('/api/sandbox/keep', { method: 'POST', body: JSON.stringify({ name: '' }) }))).status).toBe(400);
    expect(resolveDataDir()).toBe(path.resolve(dir));

    route('POST', '/api/sandbox/discard');
    // Holding the unlock for the copy: the response re-issues it for the real file.
    session.unlock = createUnlockToken();
    const left = await discardPOST(req('/api/sandbox/discard', { method: 'POST' }));
    session.unlock = undefined;
    expect(left.status).toBe(200);
    expect(verifyUnlockToken(left.cookies.get(UNLOCK_COOKIE)?.value)).toBe(true);
    expect((await left.json()).realDir).toBe(path.resolve(REAL));
    expect(resolveDataDir()).toBe(path.resolve(REAL));
    expect(fs.existsSync(dir)).toBe(false);
    route('GET', '/api/sandbox/status');
    expect(await (await statusGET()).json()).toMatchObject({ active: false });
  }, 180_000);

  it('resumes and deletes a left-over copy', async () => {
    session.userId = ownerId;
    route('POST', '/api/sandbox');
    const { dir } = await (await sandboxPOST(req('/api/sandbox', { method: 'POST' }))).json();
    await closeDb(dir);
    switchActiveDataDir(REAL); // as after a server restart
    route('GET', '/api/sandbox');
    const status = await (await sandboxGET()).json();
    expect(status.leftovers).toHaveLength(1);
    const id = status.leftovers[0].id as string;

    route('POST', '/api/sandbox/leftovers/[id]');
    const resumed = await leftoverPOST(req(`/api/sandbox/leftovers/${encodeURIComponent(id)}`, { method: 'POST' }), params(id));
    expect(resumed.status).toBe(200);
    expect(resolveDataDir()).toBe(path.resolve(dir));

    await closeDb(dir);
    switchActiveDataDir(REAL);
    route('DELETE', '/api/sandbox/leftovers/[id]');
    const missing = await leftoverDELETE(req('/api/sandbox/leftovers/nope', { method: 'DELETE' }), params('nope'));
    expect(missing.status).toBe(404);
    const deleted = await leftoverDELETE(req(`/api/sandbox/leftovers/${encodeURIComponent(id)}`, { method: 'DELETE' }), params(id));
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(path.dirname(dir))).toBe(false);
  }, 180_000);

  it('resumes and deletes a left-over copy whose id has a "%" in it', async () => {
    const manifest = path.join(REAL, 'bookkeeper-company.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: '50% Off LLC' }), 'utf8');
    try {
      session.userId = ownerId;
      route('POST', '/api/sandbox');
      const { dir } = await (await sandboxPOST(req('/api/sandbox', { method: 'POST' }))).json();
      await closeDb(dir);
      switchActiveDataDir(REAL);
      route('GET', '/api/sandbox');
      const [left] = (await (await sandboxGET()).json()).leftovers as { id: string }[];
      expect(left.id).toContain('50% Off LLC');

      // Next.js hands the param already decoded; the route must not decode it again.
      route('POST', '/api/sandbox/leftovers/[id]');
      const resumed = await leftoverPOST(req(`/api/sandbox/leftovers/${encodeURIComponent(left.id)}`, { method: 'POST' }), params(left.id));
      expect(resumed.status).toBe(200);
      expect(resolveDataDir()).toBe(path.resolve(dir));

      await closeDb(dir);
      switchActiveDataDir(REAL);
      route('DELETE', '/api/sandbox/leftovers/[id]');
      expect((await leftoverDELETE(req('/api/sandbox/leftovers/x', { method: 'DELETE' }), params('%E0%A4%A'))).status).toBe(404);
      const deleted = await leftoverDELETE(req(`/api/sandbox/leftovers/${encodeURIComponent(left.id)}`, { method: 'DELETE' }), params(left.id));
      expect(deleted.status).toBe(200);
      expect(fs.existsSync(path.dirname(dir))).toBe(false);
    } finally {
      fs.rmSync(manifest, { force: true });
    }
  }, 180_000);
  it('keep: reserved names are a 400, non-Admins a 403, and a failed move still completes the leave', async () => {
    session.userId = ownerId;
    route('POST', '/api/sandbox');
    const { dir } = await (await sandboxPOST(req('/api/sandbox', { method: 'POST' }))).json();
    fs.mkdirSync(path.join(ROOT, 'Taken.ironbooks'), { recursive: true });
    const keep = (name: string) => keepPOST(req('/api/sandbox/keep', { method: 'POST', body: JSON.stringify({ name }) }));

    route('POST', '/api/sandbox/keep');
    const reserved = await keep('NUL');
    expect(reserved.status).toBe(400);
    expect((await reserved.json()).error).toMatch(/reserved by Windows/);
    expect((await keep('Taken')).status).toBe(400);
    // An accountant cannot learn which names are taken next to the real file.
    session.userId = accountantId;
    for (const name of ['Taken', 'NUL', 'Anything']) expect((await keep(name)).status).toBe(403);
    session.userId = ownerId;
    expect(resolveDataDir()).toBe(path.resolve(dir));

    const move = vi.spyOn(sandboxFs, 'moveDir').mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });
    try {
      const res = await keep('Locked Practice');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ realDir: path.resolve(REAL), trainingDir: null, name: 'Locked Practice' });
      expect(body.warning).toMatch(/could not be saved as the training file/);
    } finally {
      move.mockRestore();
    }
    expect(resolveDataDir()).toBe(path.resolve(REAL));
    route('GET', '/api/sandbox');
    const status = await (await sandboxGET()).json();
    expect(status).toMatchObject({ active: false });
    expect(status.leftovers).toHaveLength(1);
    route('DELETE', '/api/sandbox/leftovers/[id]');
    const id = status.leftovers[0].id as string;
    expect((await leftoverDELETE(req(`/api/sandbox/leftovers/${encodeURIComponent(id)}`, { method: 'DELETE' }), params(id))).status).toBe(200);
  }, 180_000);
});
