/**
 * Review round 5 (team banking) — API routes of the banking area answer bad input with a 400 and
 * a plain message (never a 500): real route handlers + getServerContext against a temp PGlite
 * file with `next/headers` mocked (same pattern as bankRules.routes.test.ts).
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-banking-routes-r5');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'banking-routes-r5-secret';

import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { createCompany } from './company';
import { POST as reconPOST } from '@/app/api/reconciliations/route';
import { PATCH as reconPATCH } from '@/app/api/reconciliations/[id]/route';
import { POST as payPOST } from '@/app/api/reconciliations/[id]/pay/route';
import { POST as bankAcctPOST } from '@/app/api/bank-accounts/route';
import { POST as importPOST } from '@/app/api/import/route';

let db: DB;
let owner: string;
let companyId: string;
const acct: Record<string, string> = {};
let checkingLink: string;
let cardLink: string;

function as(userId: string, method: string, routePath: string) {
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

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@banking-r5.local', name: 'Owner', passwordHash: await hashPassword('pass12345') }).returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Banking Routes R5', ownerId: owner })).id;
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, companyId))) acct[r.code] = r.id;
  checkingLink = (await db.insert(bankAccounts).values({ companyId, accountId: acct['1000'], bankName: 'First', accountNumber: '1111' }).returning())[0].id;
  cardLink = (await db.insert(bankAccounts).values({ companyId, accountId: acct['2100'], bankName: 'Card', accountNumber: '2222' }).returning())[0].id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('banking routes: bad input is a 400', () => {
  it('POST /api/reconciliations: a statement balance that is not a number, or a bad date', async () => {
    as(owner, 'POST', '/api/reconciliations');
    const a = await reconPOST(req('POST', '/api/reconciliations', { bankAccountId: checkingLink, statementDate: '2026-03-31', statementBalance: 'abc' }));
    expect(a.status).toBe(400);
    const b = await reconPOST(req('POST', '/api/reconciliations', { bankAccountId: checkingLink, statementDate: 'garbage', statementBalance: '10.00' }));
    expect(b.status).toBe(400);
  });

  it('PATCH /api/reconciliations/[id] adjustments / updateStatement with junk', async () => {
    as(owner, 'POST', '/api/reconciliations');
    const started = await reconPOST(req('POST', '/api/reconciliations', { bankAccountId: checkingLink, statementDate: '2026-03-31', statementBalance: '0.00' }));
    expect(started.status).toBe(201);
    const recon = await started.json();
    as(owner, 'PATCH', '/api/reconciliations/[id]');
    const adj = await reconPATCH(req('PATCH', `/api/reconciliations/${recon.id}`, { action: 'adjustments', serviceCharge: { amount: 'x', accountId: acct['6100'] } }), params(recon.id));
    expect(adj.status).toBe(400);
    const adj2 = await reconPATCH(req('PATCH', `/api/reconciliations/${recon.id}`, { action: 'adjustments', serviceCharge: 'five dollars' }), params(recon.id));
    expect(adj2.status).toBe(400);
    const upd = await reconPATCH(req('PATCH', `/api/reconciliations/${recon.id}`, { action: 'updateStatement', statementBalance: 'NaN' }), params(recon.id));
    expect(upd.status).toBe(400);
    const upd2 = await reconPATCH(req('PATCH', `/api/reconciliations/${recon.id}`, { action: 'updateStatement', statementDate: 'not a date' }), params(recon.id));
    expect(upd2.status).toBe(400);
    const tog = await reconPATCH(req('PATCH', `/api/reconciliations/${recon.id}`, { action: 'toggleCleared', journalEntryLineId: 12345, isCleared: true }), params(recon.id));
    expect(tog.status).toBeLessThan(500);
  });

  it('POST /api/reconciliations/[id]/pay: an amount that is not a number, or a bad date', async () => {
    as(owner, 'POST', '/api/reconciliations');
    const started = await reconPOST(req('POST', '/api/reconciliations', { bankAccountId: cardLink, statementDate: '2026-03-31', statementBalance: '0.00' }));
    const recon = await started.json();
    as(owner, 'PATCH', '/api/reconciliations/[id]');
    const done = await reconPATCH(req('PATCH', `/api/reconciliations/${recon.id}`, { action: 'complete' }), params(recon.id));
    expect(done.status).toBe(200);
    as(owner, 'POST', '/api/reconciliations/[id]/pay');
    const a = await payPOST(req('POST', `/api/reconciliations/${recon.id}/pay`, { paymentAccountId: acct['1000'], amount: 'lots' }), params(recon.id));
    expect(a.status).toBe(400);
    const b = await payPOST(req('POST', `/api/reconciliations/${recon.id}/pay`, { paymentAccountId: acct['1000'], amount: '10.00', date: 'someday' }), params(recon.id));
    expect(b.status).toBe(400);
  });

  it('POST /api/bank-accounts: a bank name that is not text', async () => {
    as(owner, 'POST', '/api/bank-accounts');
    const r = await bankAcctPOST(req('POST', '/api/bank-accounts', { accountId: acct['1010'], bankName: 42, accountNumber: '9' }));
    expect(r.status).toBe(400);
  });

  it('POST /api/import rows: an amount that is not a number is refused even when the statement "ties out"', async () => {
    as(owner, 'POST', '/api/import');
    const r = await importPOST(
      req('POST', '/api/import', {
        bankAccountId: checkingLink,
        fileType: 'rows',
        rows: [
          { date: '2026-03-02', description: 'Deposit', amount: '100.00' },
          { date: '2026-03-03', description: 'Junk', amount: 'NaN' },
        ],
        statement: { kind: 'bank', openingBalance: '0.00', closingBalance: '100.00' },
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe('register route on a long register', () => {
  it('GET /api/registers/[accountId]?last=N sends only the newest N rows, with their true running balance', async () => {
    const { postJournalEntry } = await import('./posting');
    const { GET: registerGET } = await import('@/app/api/registers/[accountId]/route');
    for (const [day, amt] of [['2026-01-05', '100.00'], ['2026-02-05', '50.00'], ['2026-03-05', '25.00']] as const) {
      await postJournalEntry({ db, companyId, userId: owner }, {
        date: new Date(`${day}T00:00:00.000Z`),
        description: `Owner money ${day}`,
        lines: [
          { accountId: acct['1010'], debit: amt },
          { accountId: acct['3000'], credit: amt },
        ],
      });
    }
    as(owner, 'GET', '/api/registers/[accountId]');
    const res = await registerGET(req('GET', `/api/registers/${acct['1010']}?last=2`), { params: Promise.resolve({ accountId: acct['1010'] }) });
    expect(res.status).toBe(200);
    const { register } = await res.json();
    expect(register.totalRows).toBe(3);
    expect(register.offset).toBe(1);
    expect(register.rows.map((r: { runningBalance: string }) => r.runningBalance)).toEqual(['150.00', '175.00']);
    const bad = await registerGET(req('GET', `/api/registers/${acct['1010']}?last=-1`), { params: Promise.resolve({ accountId: acct['1010'] }) });
    expect(bad.status).toBe(400);
  });
});
