/**
 * Review round 5 (security): password hashes never leave the server.
 *
 * The closing-date password hash and the company-file password hash live in companies.settings,
 * and an employee's self-service portal password hash in employees. They reached the browser:
 *  - GET /api/company (any member — a View-Only user, a Time Tracking user) returned the raw
 *    company row, settings and all; so did PATCH /api/company, GET /api/companies,
 *    POST /api/companies/select and PATCH /api/companies/[id];
 *  - every Preferences save audits the whole settings object before/after, and the audit trail
 *    (Reports — Financial) showed those snapshots as stored;
 *  - GET /api/employees returned portalPasswordHash.
 * A bcrypt hash can be cracked offline; the closing-date password exists precisely to stop users
 * who have the closed-period right but not the password (an Accountant, an External Accountant).
 *
 * And online: the closing-date password (x-closing-password on any save) was the one password
 * with no attempt limit, so such a user could simply try passwords until one worked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-secrets');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-secrets-secret';
delete process.env.BKA_INTERNAL_TOKEN;

import { closeDb, getDb, type DB } from '@/lib/db';
import { auditLogs, companies, employees, users } from '@/lib/db/schema';
import { createSessionToken, createUnlockToken, hashPassword, SESSION_COOKIE, UNLOCK_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess } from '@/lib/permissions/model';
import { createCompany, setClosingDate, updateCompany } from './company';
import { setFilePassword } from './fileLock';
import { addUser } from './users';
import { GET as companyGET, PATCH as companyPATCH } from '@/app/api/company/route';
import { GET as companiesGET } from '@/app/api/companies/route';
import { POST as selectPOST } from '@/app/api/companies/select/route';
import { PATCH as companyIdPATCH } from '@/app/api/companies/[id]/route';
import { GET as auditListGET } from '@/app/api/audit-trail/route';
import { GET as auditOneGET } from '@/app/api/audit-trail/[id]/route';
import { GET as employeesGET } from '@/app/api/employees/route';
import { GET as employeeGET } from '@/app/api/employees/[id]/route';
import { POST as journalPOST } from '@/app/api/journal-entries/route';
import { POST as portalPasswordPOST } from '@/app/api/employees/[id]/portal-password/route';
import { verifyPassword } from '@/lib/auth';
import { accounts } from '@/lib/db/schema';

let db: DB;
let owner: string;
let viewer: string;
let companyId: string;
let employeeId: string;
const secrets: string[] = [];

function as(userId: string, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
  h.cookies.set(COMPANY_COOKIE, companyId);
  h.cookies.set(UNLOCK_COOKIE, createUnlockToken());
}
function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** The response carries none of the stored hashes (and no "$2…" bcrypt string at all). */
async function expectNoSecrets(res: Response, what: string) {
  expect(res.status, what).toBeLessThan(300);
  const text = await res.text();
  for (const s of secrets) expect(text.includes(s), `${what} leaks a stored hash`).toBe(false);
  expect(/\$2[aby]\$\d\d\$/.test(text), `${what} carries a bcrypt hash`).toBe(false);
  return JSON.parse(text);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@secrets5.local', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Secrets Co', ownerId: owner })).id;
  const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
  viewer = (await addUser(ownerCtx, { name: 'Viewer', login: 'viewer5', password: 'viewerPass123', roleKeys: ['view_only'] })).userId;

  await setClosingDate(ownerCtx, { closingDate: '2025-12-31', password: 'Cl0sing-Secret' });
  await setFilePassword(db, 'file-secret-1');
  // A Preferences save after both passwords exist: its audit row snapshots the whole settings.
  await updateCompany(ownerCtx, { settings: { phone: '555-0100' } });

  const [emp] = await db
    .insert(employees)
    .values({ companyId, firstName: 'Pat', lastName: 'Portal', portalPasswordHash: await hashPassword('portalPass123') })
    .returning();
  employeeId = emp.id;

  const [c] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  const s = c.settings as Record<string, unknown>;
  secrets.push(String(s.closingDatePasswordHash), String((s.fileLock as { hash: string }).hash), emp.portalPasswordHash!);
  expect(secrets.every((x) => x.startsWith('$2'))).toBe(true);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('review5: password hashes never reach a browser', () => {
  it('GET /api/company (a View-Only user) shows the settings without any hash', async () => {
    as(viewer, 'GET', '/api/company');
    const body = await expectNoSecrets(await companyGET(), 'GET /api/company');
    expect(body.settings.closingDate).toBe('2025-12-31');
    expect(body.settings.phone).toBe('555-0100');
    expect(body.settings.fileLock).toEqual({ enabled: true });
  });

  it('PATCH /api/company answers the saved company without any hash', async () => {
    as(owner, 'PATCH', '/api/company');
    await expectNoSecrets(await companyPATCH(req('PATCH', '/api/company', { settings: { phone: '555-0101' } })), 'PATCH /api/company');
  });

  it('the company-file list, switching company and renaming answer without any hash', async () => {
    as(viewer, 'GET', '/api/companies');
    await expectNoSecrets(await companiesGET(req('GET', '/api/companies')), 'GET /api/companies');
    as(viewer, 'POST', '/api/companies/select');
    await expectNoSecrets(await selectPOST(req('POST', '/api/companies/select', { companyId })), 'POST /api/companies/select');
    as(owner, 'PATCH', `/api/companies/${companyId}`);
    await expectNoSecrets(
      await companyIdPATCH(req('PATCH', `/api/companies/${companyId}`, { name: 'Secrets Co Renamed' }), params({ id: companyId })),
      'PATCH /api/companies/[id]',
    );
  });

  it('the audit trail of a Preferences save shows the settings change without any hash', async () => {
    const rows = await db
      .select({ id: auditLogs.id, newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityType, 'company')));
    // The service no longer writes the hashes into the snapshot (updateCompany strips them), so
    // find the Preferences save by its change; the route must answer without any hash either way.
    const prefSave = rows.find((r) => JSON.stringify(r.newValues ?? '').includes('555-0100'));
    expect(prefSave, 'fixture: a Preferences save audited with the settings snapshot').toBeTruthy();
    as(viewer, 'GET', '/api/audit-trail');
    await expectNoSecrets(await auditListGET(req('GET', '/api/audit-trail')), 'GET /api/audit-trail');
    as(viewer, 'GET', `/api/audit-trail/${prefSave!.id}`);
    const one = await expectNoSecrets(
      await auditOneGET(req('GET', `/api/audit-trail/${prefSave!.id}`), params({ id: prefSave!.id })),
      'GET /api/audit-trail/[id]',
    );
    expect(one.newValues.settings.phone).toBe('555-0100');
  });

  it('employees answer whether a portal password is set, never its hash', async () => {
    as(owner, 'GET', '/api/employees');
    const list = await expectNoSecrets(await employeesGET(req('GET', '/api/employees')), 'GET /api/employees');
    expect(list.find((e: { id: string }) => e.id === employeeId)).toMatchObject({ hasPortalPassword: true });
    as(owner, 'GET', `/api/employees/${employeeId}`);
    const one = await expectNoSecrets(
      await employeeGET(req('GET', `/api/employees/${employeeId}`), params({ id: employeeId })),
      'GET /api/employees/[id]',
    );
    expect(one.hasPortalPassword).toBe(true);
    expect('portalPasswordHash' in one).toBe(false);
  });
});

describe('review5: closing-date password guesses are limited like every other password', () => {
  async function closedPeriodEntry(userId: string, password: string) {
    const [cash, expense] = await Promise.all([
      db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.subtype, 'checking'))),
      db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.type, 'expense'))),
    ]);
    as(userId, 'POST', '/api/journal-entries');
    h.headers.set('x-closing-password', password);
    return journalPOST(
      req('POST', '/api/journal-entries', {
        date: '2025-06-30',
        description: 'Closed-period fix',
        lines: [
          { accountId: expense[0].id, debit: '10.00' },
          { accountId: cash[0].id, credit: '10.00' },
        ],
      }),
    );
  }

  it('the right password unlocks the closed period for an Accountant; repeated wrong guesses lock the guesser out', async () => {
    const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
    const accountant = (await addUser(ownerCtx, { name: 'Acct', login: 'acct5', password: 'acctPass1234', roleKeys: ['accountant'] })).userId;
    const guesser = (await addUser(ownerCtx, { name: 'Guess', login: 'guess5', password: 'guessPass1234', roleKeys: ['external_accountant'] })).userId;

    expect((await closedPeriodEntry(accountant, 'Cl0sing-Secret')).status).toBe(201);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await closedPeriodEntry(guesser, `guess-${i}`)).status);
    // Wrong passwords are refused as the closed period (the form asks again)…
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    // …until the limit: then even the right password waits.
    expect(statuses[5]).toBe(403);
    const locked = await closedPeriodEntry(guesser, 'Cl0sing-Secret');
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toMatch(/too many wrong closing-date passwords/i);
    // Other people are not affected.
    expect((await closedPeriodEntry(accountant, 'Cl0sing-Secret')).status).toBe(201);
  });
});

describe("review5: an employee's portal password follows the file's password rules and is audited", () => {
  it('a password the rules refuse is a 400; a good one is saved and audited (never the password)', async () => {
    as(owner, 'POST', `/api/employees/${employeeId}/portal-password`);
    // Default rules: letters AND numbers.
    const weak = await portalPasswordPOST(
      req('POST', `/api/employees/${employeeId}/portal-password`, { password: 'lettersonly' }),
      params({ id: employeeId }),
    );
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toBe('The password needs a number.');
    const [still] = await db.select().from(employees).where(eq(employees.id, employeeId));
    expect(await verifyPassword('portalPass123', still.portalPasswordHash!)).toBe(true);

    as(owner, 'POST', `/api/employees/${employeeId}/portal-password`);
    const ok = await portalPasswordPOST(
      req('POST', `/api/employees/${employeeId}/portal-password`, { password: 'NewPortal2026' }),
      params({ id: employeeId }),
    );
    expect(ok.status).toBe(200);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityId, employeeId)));
    const text = JSON.stringify(audits.map((a) => a.newValues));
    expect(text).toContain('"portalPassword":"set"');
    expect(text).not.toContain('NewPortal2026');
  });
});
