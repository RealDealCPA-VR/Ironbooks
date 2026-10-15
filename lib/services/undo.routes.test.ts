/**
 * Undo + "Why did this number change?" through the real API route handlers (ux/undo):
 * prepare -> PATCH -> commit -> undo, a second undo answers 409, and /api/why-changed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createCustomer, getCustomer } from './customers';
import { createManualEntry } from './journal';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as preparePOST } from '@/app/api/undo/prepare/route';
import { POST as commitPOST } from '@/app/api/undo/commit/route';
import { POST as undoPOST } from '@/app/api/undo/[id]/route';
import { GET as whyGET } from '@/app/api/why-changed/route';
import { PATCH as customerPATCH } from '@/app/api/customers/[id]/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-undo-routes');
let db: DB;
const json = (url: string, body: unknown, method = 'POST') =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('undo + why-changed routes', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'routes@undo.test', name: 'Pat', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Undo Routes Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
  });

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes it. */
    }
  });

  it('prepare -> save -> commit -> undo; a second undo is refused with 409', async () => {
    const c = await createCustomer(ctx, { displayName: 'Route Co' });
    const prep = await preparePOST(json('/api/undo/prepare', { resource: 'customers', kind: 'update', id: c.id }));
    expect(prep.status).toBe(201);
    const { token } = await prep.json();
    const saved = await customerPATCH(json(`/api/customers/${c.id}`, { displayName: 'Route Co (renamed)' }, 'PATCH'), {
      params: Promise.resolve({ id: c.id }),
    });
    expect(saved.status).toBe(200);
    const armed = await commitPOST(json('/api/undo/commit', { resource: 'customers', kind: 'update', token }));
    expect(armed.status).toBe(201);
    const a = await armed.json();
    expect(a.message).toMatch(/Route Co/);
    expect(new Date(a.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30_000);

    const undone = await undoPOST(json(`/api/undo/${token}`, {}), { params: Promise.resolve({ id: token }) });
    expect(undone.status).toBe(200);
    expect((await undone.json()).message).toMatch(/reversed/);
    expect((await getCustomer(ctx, c.id)).displayName).toBe('Route Co');

    const again = await undoPOST(json(`/api/undo/${token}`, {}), { params: Promise.resolve({ id: token }) });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already undone/);
  });

  it('refuses unknown resources and malformed tokens with 400', async () => {
    const bad = await preparePOST(json('/api/undo/prepare', { resource: 'payroll', kind: 'update', id: 'x' }));
    expect(bad.status).toBe(400);
    const res = await undoPOST(json('/api/undo/nope', {}), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(400);
  });

  it('GET /api/why-changed explains an account balance', async () => {
    const bank = await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset' as never, subtype: 'checking' });
    const eq = await createAccount(ctx, { code: '3000', name: 'Equity', type: 'equity' as never, subtype: 'owners_equity' });
    const since = new Date(Date.now() - 1000);
    await createManualEntry(ctx, {
      date: new Date('2026-05-01T12:00:00Z'),
      description: 'Owner put money in',
      lines: [
        { accountId: bank.id, debit: '500.00' },
        { accountId: eq.id, credit: '500.00' },
      ],
    });
    const res = await whyGET(new NextRequest(`http://localhost/api/why-changed?since=${since.toISOString()}&accounts=${bank.id}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ kind: 'created', delta: '500.00', who: 'Pat' });
    expect(body.changes[0].label).toMatch(/^Owner put money in/);
    const bad = await whyGET(new NextRequest('http://localhost/api/why-changed?since=garbage&preset=assets'));
    expect(bad.status).toBe(400);
  });
});
