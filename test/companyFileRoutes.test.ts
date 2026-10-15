/**
 * API routes for the company-file package, driven without HTTP (session mocked):
 *  - every route fails closed without a session;
 *  - /api/portable is owner/admin only and returns a .bkp;
 *  - /api/portable/restore validates (?inspect=1) and restores into a NEW sibling folder —
 *    a client-supplied ?target= is ignored unless the desktop shell's internal token is sent;
 *  - /api/transaction-log (+ /verify), /api/portable/shareable and /api/condense/archives respond.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-companyfile-routes');
const ACTIVE = path.join(ROOT, 'Active Co.bookkeeper');
process.env.BKA_DATA_DIR = ACTIVE;

const session = vi.hoisted(() => ({ userId: null as string | null, headers: new Map<string, string>() }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSessionUserId: async () => session.userId,
    // Multi-user hosting: getServerContext reads the live session (no sid → no session row).
    getSessionInfo: async () => (session.userId ? { userId: session.userId } : null),
  };
});
// Users & Roles: getServerContext authorizes the request path/method that middleware stamps.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers([...session.headers.entries()]),
}));
/** Stamp the route headers middleware.ts would set for this request. */
function route(method: string, routePath: string) {
  session.headers.set('x-bka-route-path', routePath);
  session.headers.set('x-bka-route-method', method);
}

import { getDb, closeDb } from '@/lib/db';
import { userCompanies, users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { GET as portableGET } from '@/app/api/portable/route';
import { POST as restorePOST } from '@/app/api/portable/restore/route';
import { GET as shareableGET } from '@/app/api/portable/shareable/route';
import { GET as logGET } from '@/app/api/transaction-log/route';
import { GET as verifyGET } from '@/app/api/transaction-log/verify/route';
import { GET as archivesGET } from '@/app/api/condense/archives/route';

let ownerId: string;
let accountantId: string;
let bkp: Uint8Array<ArrayBuffer>;

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`http://localhost${url}`, init);

describe('company-file API routes', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    const db = await getDb();
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@routes.test', name: 'Route Owner', passwordHash: 'hash-1' })
      .returning();
    const [acct] = await db
      .insert(users)
      .values({ email: 'acct@routes.test', name: 'Route Accountant', passwordHash: 'hash-2' })
      .returning();
    ownerId = owner.id;
    accountantId = acct.id;
    const company = await createCompany(db, { name: 'Active Co', ownerId });
    await db.insert(userCompanies).values({ userId: accountantId, companyId: company.id, role: 'accountant' });
  }, 120_000);

  afterAll(async () => {
    await closeDb(ACTIVE);
    for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) await closeDb(path.join(ROOT, d));
    fs.rmSync(ROOT, { recursive: true, force: true });
    delete process.env.BKA_DATA_DIR;
    delete process.env.BKA_INTERNAL_TOKEN;
  });

  it('fails closed without a session', async () => {
    session.userId = null;
    route('GET', '/api/portable');
    expect((await portableGET()).status).toBe(403);
    route('GET', '/api/transaction-log');
    expect((await logGET(req('/api/transaction-log'))).status).toBe(403);
    route('GET', '/api/transaction-log/verify');
    expect((await verifyGET()).status).toBe(403);
    route('GET', '/api/condense/archives');
    expect((await archivesGET()).status).toBe(403);
    route('GET', '/api/portable/shareable');
    expect((await shareableGET(req('/api/portable/shareable'))).status).toBe(403);
    route('POST', '/api/portable/restore');
    expect((await restorePOST(req('/api/portable/restore', { method: 'POST', body: 'x' }))).status).toBe(403);
  });

  it('portable file: accountant refused, owner gets a .bkp', async () => {
    session.userId = accountantId;
    route('GET', '/api/portable');
    const denied = await portableGET();
    expect(denied.status).toBe(403);

    session.userId = ownerId;
    const res = await portableGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('Active Co.bkp');
    bkp = new Uint8Array(await res.arrayBuffer());
    expect(bkp.length).toBeGreaterThan(1000);
  });

  it('inspects, then restores into a new sibling folder (ignoring a session-supplied target)', async () => {
    session.userId = ownerId;
    route('POST', '/api/portable/restore');
    const inspect = await restorePOST(req('/api/portable/restore?inspect=1', { method: 'POST', body: bkp }));
    expect(inspect.status).toBe(200);
    const summary = await inspect.json();
    expect(summary.companyName).toBe('Active Co');
    expect(summary.rowCounts.users).toBe(2);

    const evil = path.join(ROOT, 'attacker-chosen');
    const res = await restorePOST(
      req(`/api/portable/restore?target=${encodeURIComponent(evil)}`, { method: 'POST', body: bkp }),
    );
    expect(res.status).toBe(201);
    const result = await res.json();
    expect(fs.existsSync(evil)).toBe(false);
    expect(path.dirname(result.dataDir)).toBe(ROOT);
    expect(path.basename(result.dataDir)).toMatch(/^Active Co \(restored .+\)\.ironbooks$/);
    expect(result.verified.ledgersBalanced).toBe(true);
  });

  it('honors ?target= for the desktop shell (internal token)', async () => {
    session.userId = null;
    route('POST', '/api/portable/restore');
    process.env.BKA_INTERNAL_TOKEN = 'test-internal-token';
    const target = path.join(ROOT, 'Chosen.bookkeeper');
    const res = await restorePOST(
      req(`/api/portable/restore?target=${encodeURIComponent(target)}`, {
        method: 'POST',
        body: bkp,
        headers: { 'x-bka-internal': 'test-internal-token' },
      }),
    );
    expect(res.status).toBe(201);
    expect((await res.json()).dataDir).toBe(target);
    expect(fs.existsSync(path.join(target, 'PG_VERSION'))).toBe(true);

    const wrong = await restorePOST(
      req(`/api/portable/restore?target=${encodeURIComponent(path.join(ROOT, 'Other'))}`, {
        method: 'POST',
        body: bkp,
        headers: { 'x-bka-internal': 'wrong-token-value!!' },
      }),
    );
    expect(wrong.status).toBe(403);
  });

  it('serves the transaction log, its verification, the shareable ledger and the archive list', async () => {
    session.userId = ownerId;
    route('GET', '/api/transaction-log');
    const log = await (await logGET(req('/api/transaction-log?entityType=company'))).json();
    expect(log.total).toBe(1);
    expect(log.rows[0].summary).toContain('Created company "Active Co"');

    route('GET', '/api/transaction-log/verify');
    const v = await (await verifyGET()).json();
    expect(v.ok).toBe(true);

    route('GET', '/api/portable/shareable');
    const xlsx = await shareableGET(req('/api/portable/shareable?format=xlsx'));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('Content-Type')).toContain('spreadsheetml');
    const pdf = await shareableGET(req('/api/portable/shareable?format=pdf'));
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect((await shareableGET(req('/api/portable/shareable?format=doc'))).status).toBe(400);

    route('GET', '/api/condense/archives');
    expect(await (await archivesGET()).json()).toEqual({ archives: [] });
  });
});
