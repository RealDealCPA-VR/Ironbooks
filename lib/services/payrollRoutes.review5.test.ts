/**
 * Review round 5 — payroll / portal / mileage routes, driven through the real route handlers.
 *
 *  1. Employee portal sign-in works for an employee whose email was typed with capitals
 *     ("Jane.Doe@Example.com") — the lookup compared the lower-cased input with the stored text.
 *  2. The portal lists real, live paychecks only (a voided check is not pay).
 *  3. Pay stubs, W-2s and 941s print for names outside Latin-1 (Vietnamese, Chinese, …) — the
 *     standard PDF fonts and the Content-Disposition header both threw (HTTP 500).
 *  4. A voided paycheck's stub is stamped VOID.
 *  5. The W-2 footer is drawn once (it was drawn twice, overlapping).
 *  6. Mileage summary with a malformed date answers 400, not 500.
 *  7. Bad numbers on payroll setup / expense reports answer 400, not 500.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-payroll-routes');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-payroll-routes-secret';

import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, employees, users } from '@/lib/db/schema';
import { createPortalToken, createSessionToken, hashPassword, PORTAL_COOKIE, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createEmployee, runPaycheck, voidPaycheck } from './payroll';
import { POST as portalLoginPOST } from '@/app/api/portal/login/route';
import { GET as portalMeGET } from '@/app/api/portal/me/route';
import { GET as paystubGET } from '@/app/api/payroll/paystub/route';
import { GET as w2GET } from '@/app/api/payroll/w2/route';
import { GET as f941GET } from '@/app/api/payroll/941/route';
import { GET as w3GET } from '@/app/api/payroll/w3/route';
import { GET as f940GET } from '@/app/api/payroll/940/route';
import { GET as mileageGET } from '@/app/api/mileage/route';
import { POST as stateSettingsPOST } from '@/app/api/payroll/state-settings/route';
import { POST as workersCompPOST } from '@/app/api/payroll/workers-comp/route';
import { POST as expenseReportsPOST } from '@/app/api/expense-reports/route';

let db: DB;
let owner: string;
let companyId: string;
let ctx: ServiceContext;

type Handler = (r: NextRequest, c: never) => Promise<Response>;

function asOwner(method: string, routePath: string) {
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
async function ownerCall(handler: Handler, method: string, route: string, opts: { query?: string; body?: unknown } = {}) {
  asOwner(method, route);
  const res = await handler(req(method, `${route}${opts.query ?? ''}`, opts.body), undefined as never);
  return res;
}

/** Every text string drawn on a PDF (pdf-lib writes `<hex> Tj` into flate content streams). */
function pdfTexts(bytes: Uint8Array): string[] {
  const s = Buffer.from(bytes).toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const t of content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out.push(Buffer.from(t[1], 'hex').toString('latin1'));
  }
  return out;
}

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@review5-payroll.local', name: 'Owner', passwordHash: await hashPassword('pass12345') }).returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Café Ñandú 株式会社', ownerId: owner })).id;
  ctx = { db, companyId, userId: owner };
  await updateCompany(ctx, { settings: { ein: '12-3456789', address: '1 Rue Café, Đà Nẵng' } });
}, 300_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('employee portal', () => {
  it('signs in an employee whose email was saved with capital letters', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Jane', lastName: 'Doe', email: 'Jane.Doe@Example.com', payType: 'hourly', payRate: '20' });
    await db.update(employees).set({ portalPasswordHash: await hashPassword('portal-pass-1') }).where(eq(employees.id, emp.id));
    h.cookies.clear();
    h.headers.clear();
    const res = await portalLoginPOST(req('POST', '/api/portal/login', { email: 'jane.doe@example.com', password: 'portal-pass-1' }));
    expect(res.status).toBe(200);
    // Typed exactly as saved works too.
    const res2 = await portalLoginPOST(req('POST', '/api/portal/login', { email: 'Jane.Doe@Example.com', password: 'portal-pass-1' }));
    expect(res2.status).toBe(200);
    // A wrong password is still refused.
    const bad = await portalLoginPOST(req('POST', '/api/portal/login', { email: 'jane.doe@example.com', password: 'nope-nope' }));
    expect(bad.status).toBe(401);
  });

  it('lists live paychecks only — a voided check is not pay', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Vo', lastName: 'Ided', email: 'vo@example.com', payType: 'hourly', payRate: '20' });
    const hash = await hashPassword('portal-pass-2');
    await db.update(employees).set({ portalPasswordHash: hash }).where(eq(employees.id, emp.id));
    const live = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-03-06'), grossPay: '500.00' });
    const voided = await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-03-13'), grossPay: '600.00' });
    await voidPaycheck(ctx, voided.id);

    h.headers.clear();
    h.cookies.clear();
    h.cookies.set(PORTAL_COOKIE, createPortalToken(emp.id, hash));
    const res = await portalMeGET();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { paychecks: Array<{ id: string }> };
    expect(data.paychecks.map((p) => p.id)).toEqual([live.id]);

    // Its own voided stub (if opened from an old link) is stamped VOID.
    h.headers.clear();
    h.cookies.clear();
    h.cookies.set(PORTAL_COOKIE, createPortalToken(emp.id, hash));
    const stub = await paystubGET(req('GET', `/api/payroll/paystub?paycheckId=${voided.id}`));
    expect(stub.status).toBe(200);
    expect(pdfTexts(new Uint8Array(await stub.arrayBuffer()))).toContain('VOID');
    // ...and a live one is not.
    h.cookies.set(PORTAL_COOKIE, createPortalToken(emp.id, hash));
    const ok = await paystubGET(req('GET', `/api/payroll/paystub?paycheckId=${live.id}`));
    expect(pdfTexts(new Uint8Array(await ok.arrayBuffer()))).not.toContain('VOID');
  });
});

describe('payroll PDFs with names outside Latin-1', () => {
  let empId: string;
  let paycheckId: string;

  beforeAll(async () => {
    const emp = await createEmployee(ctx, { firstName: 'Nguyễn Văn', lastName: 'Trường', payType: 'hourly', payRate: '25' });
    empId = emp.id;
    paycheckId = (await runPaycheck(ctx, { employeeId: emp.id, payDate: d('2026-02-06'), grossPay: '1000.00' })).id;
  });

  it('prints the pay stub (HTTP 200, a PDF with a header-safe file name)', async () => {
    const res = await ownerCall(paystubGET as Handler, 'GET', '/api/payroll/paystub', { query: `?paycheckId=${paycheckId}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="[A-Za-z0-9._-]+"$/);
    const texts = pdfTexts(new Uint8Array(await res.arrayBuffer()));
    expect(texts.some((t) => t.includes('Nguy'))).toBe(true);
  });

  it('prints the W-2, 941, 940 and W-3', async () => {
    const w2 = await ownerCall(w2GET as Handler, 'GET', '/api/payroll/w2', { query: `?employeeId=${empId}&year=2026` });
    expect(w2.status).toBe(200);
    expect(w2.headers.get('content-disposition')).toMatch(/^inline; filename="[A-Za-z0-9._-]+"$/);
    const w2Texts = pdfTexts(new Uint8Array(await w2.arrayBuffer()));
    // The footer is drawn once (it used to be drawn twice, overlapping itself).
    expect(w2Texts.filter((t) => t.includes('W-2 for')).length).toBe(1);
    for (const [handler, route, query] of [
      [f941GET, '/api/payroll/941', '?quarter=1&year=2026'],
      [f940GET, '/api/payroll/940', '?year=2026'],
      [w3GET, '/api/payroll/w3', '?year=2026'],
    ] as const) {
      const res = await ownerCall(handler as Handler, 'GET', route, { query });
      expect(res.status, route).toBe(200);
    }
  });
});

describe('bad input answers 400', () => {
  it('GET /api/mileage?summary=true with a malformed date', async () => {
    for (const q of ['?summary=true&from=garbage', '?summary=true&to=2026-02-30']) {
      const res = await ownerCall(mileageGET as Handler, 'GET', '/api/mileage', { query: q });
      expect(res.status, q).toBe(400);
    }
    const ok = await ownerCall(mileageGET as Handler, 'GET', '/api/mileage', { query: '?summary=true&from=2026-01-01&to=2026-12-31' });
    expect(ok.status).toBe(200);
  });

  it('POST /api/payroll/state-settings, /api/payroll/workers-comp and /api/expense-reports with text for a number', async () => {
    expect((await ownerCall(stateSettingsPOST as Handler, 'POST', '/api/payroll/state-settings', { body: { state: 'CA', year: 2026, suiRate: 'abc' } })).status).toBe(400);
    expect((await ownerCall(workersCompPOST as Handler, 'POST', '/api/payroll/workers-comp', { body: { code: '8810', ratePer100: 'abc' } })).status).toBe(400);
    const emp = await createEmployee(ctx, { firstName: 'Ex', lastName: 'Pense', payType: 'salary', payRate: '1' });
    const [travel] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, '6000')));
    const res = await ownerCall(expenseReportsPOST as Handler, 'POST', '/api/expense-reports', { body: { employeeId: emp.id, lines: [{ accountId: travel.id, amount: 'abc' }] } });
    expect(res.status).toBe(400);
  });
});
