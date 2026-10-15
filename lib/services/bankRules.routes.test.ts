/**
 * Bank rules API routes (team bankrules): real route handlers + getServerContext against a temp
 * PGlite file with `next/headers` mocked (same pattern as companyScoping.test.ts). Checks the
 * permission map wiring, validation (400), company scoping (404), the learning offer returned by
 * categorize, and bulk accept reporting per-line failures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-bankrules-routes');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'bankrules-routes-secret';

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { GET as rulesGET, POST as rulesPOST } from '@/app/api/bank-rules/route';
import { GET as ruleGET, PUT as rulePUT } from '@/app/api/bank-rules/[id]/route';
import { POST as testPOST } from '@/app/api/bank-rules/test/route';
import { GET as offersGET, POST as offersPOST } from '@/app/api/bank-rules/offers/route';
import { POST as runPOST } from '@/app/api/bank-rules/run/route';
import { POST as reorderPOST } from '@/app/api/bank-rules/reorder/route';
import { GET as suggGET } from '@/app/api/bank-transactions/suggestions/route';
import { POST as bulkPOST } from '@/app/api/bank-transactions/bulk-accept/route';
import { POST as categorizePOST } from '@/app/api/bank-transactions/categorize/route';

let db: DB;
let ownerA: string;
let ownerB: string;
let companyA: string;
let companyB: string;
let fuel: string;
let bankAccountId: string;

function as(userId: string, method: string, routePath: string, companyId: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function newUser(email: string) {
  const [u] = await db.insert(users).values({ email, name: email, passwordHash: await hashPassword('pass12345') }).returning();
  return u.id;
}
async function feed(description: string, amount: string, date = '2025-05-10') {
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: companyA, bankAccountId, date: new Date(`${date}T12:00:00Z`), description, amount })
    .returning();
  return row.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  ownerA = await newUser('a@bankrules.local');
  ownerB = await newUser('b@bankrules.local');
  companyA = (await createCompany(db, { name: 'Rules Alpha', ownerId: ownerA })).id;
  companyB = (await createCompany(db, { name: 'Rules Bravo', ownerId: ownerB })).id;
  const [gl] = await db.insert(accounts).values({ companyId: companyA, code: '1091', name: 'Feed Checking', type: 'asset', subtype: 'checking' }).returning();
  const [f] = await db.insert(accounts).values({ companyId: companyA, code: '6991', name: 'Fuel', type: 'expense', subtype: 'operating_expenses' }).returning();
  fuel = f.id;
  bankAccountId = (await db.insert(bankAccounts).values({ companyId: companyA, accountId: gl.id, bankName: 'Feed Bank', accountNumber: '4242' }).returning())[0].id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('bank rules API', () => {
  let ruleId: string;
  let updatedAt: string;

  it('POST /api/bank-rules validates and creates; GET lists in order', async () => {
    as(ownerA, 'POST', '/api/bank-rules', companyA);
    const bad = await rulesPOST(req('POST', '/api/bank-rules', { name: 'x', matchOperator: 'regex' }));
    expect(bad.status).toBe(400);
    const missing = await rulesPOST(req('POST', '/api/bank-rules', { name: 'x', matchValue: 'x' }));
    expect(missing.status).toBe(400);

    const res = await rulesPOST(
      req('POST', '/api/bank-rules', { name: 'Chevron', matchValue: 'chevron', direction: 'out', setAccountId: fuel, mode: 'suggest' }),
    );
    expect(res.status).toBe(201);
    const rule = await res.json();
    ruleId = rule.id;
    updatedAt = rule.updatedAt;

    as(ownerA, 'GET', '/api/bank-rules', companyA);
    const list = await (await rulesGET()).json();
    expect(list.rules.map((r: { id: string }) => r.id)).toEqual([ruleId]);
  });

  it('another company cannot read or edit the rule', async () => {
    as(ownerB, 'GET', '/api/bank-rules/[id]', companyB);
    expect((await ruleGET(req('GET', `/api/bank-rules/${ruleId}`), params(ruleId))).status).toBe(404);
    as(ownerB, 'PUT', '/api/bank-rules/[id]', companyB);
    expect((await rulePUT(req('PUT', `/api/bank-rules/${ruleId}`, { name: 'x' }), params(ruleId))).status).toBe(404);
    as(ownerB, 'GET', '/api/bank-rules', companyB);
    expect((await (await rulesGET()).json()).rules).toEqual([]);
    as(ownerB, 'POST', '/api/bank-rules/reorder', companyB);
    expect((await reorderPOST(req('POST', '/api/bank-rules/reorder', { orderedIds: [ruleId] }))).status).toBe(400);
  });

  it('PUT with a stale version answers 409', async () => {
    as(ownerA, 'PUT', '/api/bank-rules/[id]', companyA);
    const ok = await rulePUT(req('PUT', `/api/bank-rules/${ruleId}`, { enabled: false, expectedUpdatedAt: updatedAt }), params(ruleId));
    expect(ok.status).toBe(200);
    expect((await ok.json()).enabled).toBe(false);
    const stale = await rulePUT(req('PUT', `/api/bank-rules/${ruleId}`, { enabled: true, expectedUpdatedAt: updatedAt }), params(ruleId));
    expect(stale.status).toBe(409);
  });

  it('POST /api/bank-rules/test lists matching recent lines', async () => {
    await feed('CHEVRON 0042 SPRINGFIELD', '-31.00', new Date().toISOString().slice(0, 10));
    as(ownerA, 'POST', '/api/bank-rules/test', companyA);
    const res = await testPOST(req('POST', '/api/bank-rules/test', { matchValue: 'chevron', direction: 'out' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits).toHaveLength(1);
  });

  it('categorize returns a learning offer on the 2nd identical choice; accepting it creates a rule', async () => {
    const a = await feed('SHELL OIL 57444 HOUSTON TX', '-40.00');
    const b = await feed('SHELL OIL 12001 AUSTIN TX', '-41.00');
    as(ownerA, 'POST', '/api/bank-transactions/categorize', companyA);
    const r1 = await (await categorizePOST(req('POST', '/api/bank-transactions/categorize', { bankTransactionId: a, accountId: fuel }))).json();
    expect(r1.ruleOffer).toBeNull();
    const r2 = await (await categorizePOST(req('POST', '/api/bank-transactions/categorize', { bankTransactionId: b, accountId: fuel }))).json();
    expect(r2.ruleOffer.question).toBe('Always categorize SHELL OIL as Fuel?');

    as(ownerA, 'GET', '/api/bank-rules/offers', companyA);
    expect((await (await offersGET()).json()).offers).toHaveLength(1);
    as(ownerA, 'POST', '/api/bank-rules/offers', companyA);
    const created = await offersPOST(
      req('POST', '/api/bank-rules/offers', { action: 'accept', pattern: 'SHELL OIL', accountId: fuel, direction: 'out', mode: 'auto' }),
    );
    expect(created.status).toBe(201);
    as(ownerA, 'GET', '/api/bank-rules/offers', companyA);
    expect((await (await offersGET()).json()).offers).toHaveLength(0);
  });

  it('suggestions + run + bulk accept', async () => {
    as(ownerA, 'GET', '/api/bank-transactions/suggestions', companyA);
    expect((await suggGET(req('GET', '/api/bank-transactions/suggestions'))).status).toBe(400);

    const auto = await feed('SHELL OIL 9 DALLAS', '-12.00');
    as(ownerA, 'POST', '/api/bank-rules/run', companyA);
    const run = await (await runPOST(req('POST', '/api/bank-rules/run', { bankAccountId }))).json();
    expect(run.applied.map((x: { bankTransactionId: string }) => x.bankTransactionId)).toEqual([auto]);

    const line = await feed('CHEVRON 0043', '-20.00');
    as(ownerA, 'GET', '/api/bank-transactions/suggestions', companyA);
    const s = await (await suggGET(req('GET', `/api/bank-transactions/suggestions?bankAccountId=${bankAccountId}`))).json();
    expect(s.highConfidence).toBe(90);
    expect(s.suggestions.some((x: { bankTransactionId: string }) => x.bankTransactionId === line)).toBe(true);

    as(ownerA, 'POST', '/api/bank-transactions/bulk-accept', companyA);
    expect((await bulkPOST(req('POST', '/api/bank-transactions/bulk-accept', { items: [] }))).status).toBe(400);
    const res = await bulkPOST(
      req('POST', '/api/bank-transactions/bulk-accept', {
        items: [
          { bankTransactionId: line, accountId: fuel },
          { bankTransactionId: auto, accountId: fuel }, // already added by the auto rule
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted.map((x: { bankTransactionId: string }) => x.bankTransactionId)).toEqual([line]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].bankTransactionId).toBe(auto);

    // Company B cannot use company A's bank account.
    as(ownerB, 'POST', '/api/bank-transactions/bulk-accept', companyB);
    const forbidden = await bulkPOST(req('POST', '/api/bank-transactions/bulk-accept', { bankAccountId, allHighConfidence: true }));
    expect(forbidden.status).toBe(404);
  });
});
