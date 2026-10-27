/**
 * Review round 5 (team fx) — the currency API routes answer bad input with a plain 400 / 404
 * (never a 500) and never read "false" as true. Real route handlers + getServerContext against a
 * temp PGlite file with `next/headers` mocked (bankRules.routes.test.ts pattern). Each test failed
 * before its fix.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-currency-routes');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-currency-routes-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { POST as currenciesPOST } from '@/app/api/currencies/route';
import { POST as fxAdjPOST } from '@/app/api/currencies/fx-adjustment/route';
import { GET as hcaGET, DELETE as hcaDELETE } from '@/app/api/currencies/home-currency-adjustment/[id]/route';
import { POST as hcaPOST } from '@/app/api/currencies/home-currency-adjustment/route';

let db: DB;
let owner: string;
let companyId: string;
let checking: string;

function as(method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(owner));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'r5-cur@test.local', name: 'R5', passwordHash: await hashPassword('pass12345') }).returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'R5 Currency Routes', ownerId: owner })).id;
  const [a] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, '1000')));
  checking = a.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle. */
  }
});

describe('currency API routes (review5)', () => {
  it('POST /api/currencies: a rate or code that is not valid is a 400, not a 500', async () => {
    as('POST', '/api/currencies');
    expect((await currenciesPOST(req('POST', '/api/currencies', { code: 'USD', name: 'US Dollar', isBase: true }))).status).toBe(200);
    for (const body of [
      { code: 'EUR', name: 'Euro', rateToBase: 'abc' },
      { code: 'EUR', name: 'Euro', rateToBase: '99999999999' },
      { code: 12, name: 'Euro', rateToBase: '1.1' },
      { code: 'EUR', name: 42, rateToBase: '1.1' },
    ]) {
      const res = await currenciesPOST(req('POST', '/api/currencies', body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await currenciesPOST(req('POST', '/api/currencies', { code: 'EUR', name: 'Euro', rateToBase: '1.1' }))).status).toBe(200);
  });

  it('POST /api/currencies/fx-adjustment: gain "false" is refused (it used to post a gain); bad amount / date are 400s', async () => {
    as('POST', '/api/currencies/fx-adjustment');
    const base = { accountId: checking, amount: '10.00', date: '2026-03-31' };
    expect((await fxAdjPOST(req('POST', '/api/currencies/fx-adjustment', { ...base, gain: 'false' }))).status).toBe(400);
    expect((await fxAdjPOST(req('POST', '/api/currencies/fx-adjustment', { ...base, gain: true, amount: 'ten' }))).status).toBe(400);
    expect((await fxAdjPOST(req('POST', '/api/currencies/fx-adjustment', { ...base, gain: true, date: 'not a date' }))).status).toBe(400);
    const posted = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.sourceRef, 'fx_adjustment')));
    expect(posted).toHaveLength(0);
    const ok = await fxAdjPOST(req('POST', '/api/currencies/fx-adjustment', { ...base, gain: false }));
    expect(ok.status).toBe(201);
    const { entryId } = (await ok.json()) as { entryId: string };
    const [line] = await db
      .select({ credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, checking)));
    expect(line.credit).toBe('10.00'); // a loss credits the account
  });

  it('GET / DELETE /api/currencies/home-currency-adjustment/:id with a malformed id is a 404', async () => {
    const params = { params: Promise.resolve({ id: 'not-a-uuid' }) };
    as('GET', '/api/currencies/home-currency-adjustment/[id]');
    expect((await hcaGET(req('GET', '/api/currencies/home-currency-adjustment/not-a-uuid'), params)).status).toBe(404);
    as('DELETE', '/api/currencies/home-currency-adjustment/[id]');
    expect((await hcaDELETE(req('DELETE', '/api/currencies/home-currency-adjustment/not-a-uuid'), params)).status).toBe(404);
  });

  it('POST /api/currencies/home-currency-adjustment: an impossible date or a memo that is not text is a 400', async () => {
    as('POST', '/api/currencies/home-currency-adjustment');
    const url = '/api/currencies/home-currency-adjustment';
    // "Feb 30" used to be taken as March 2 (JavaScript rolls the day over).
    expect((await hcaPOST(req('POST', url, { date: '2026-02-30', preview: true }))).status).toBe(400);
    // A memo that is not text used to crash the post (memo.trim is not a function -> 500).
    expect((await hcaPOST(req('POST', url, { date: '2026-03-31', memo: 5 }))).status).toBe(400);
    expect((await hcaPOST(req('POST', url, { date: '2026-03-31', preview: true }))).status).toBe(200);
  });
});
