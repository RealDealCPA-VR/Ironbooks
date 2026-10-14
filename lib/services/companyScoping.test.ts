/**
 * Multi-company scoping regressions (one company file, several companies):
 *
 *  1. POST /api/companies — only an Admin of the caller's current company may create a company
 *     (a clerk becoming Admin of a new company used to lock the real Admin out of every
 *     file-wide operation, because requireFileAdmin demands Admin of EVERY company).
 *  2. requireFileAdmin still covers archived (soft-deleted) companies.
 *  3. Foreign ids in payloads must belong to ctx.companyId (jobs customerId, time entry
 *     employee/job/service item, tax rate agency, customer tax rate, vendor default expense
 *     account, mileage employee) and lookup joins no longer leak another company's names.
 *
 * Same hermetic pattern as users.adversarial.test.ts: real route handler + getServerContext
 * against a temp PGlite file with `next/headers` mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-company-scoping');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'company-scoping-secret';

import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, employees, items, jobs, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE, getServerContext } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { POST as companiesPOST } from '@/app/api/companies/route';
import { createCompany } from './company';
import { addUser } from './users';
import { requireFileAdmin } from './access';
import type { ServiceContext } from './_base';
import { createJob, updateJob, jobsSummary } from './jobs';
import { createTimeEntry, updateTimeEntry } from './timeTracking';
import { createCustomer, updateCustomer } from './customers';
import { createVendor, updateVendor } from './vendors';
import { createTaxAgency, createTaxRate } from './salesTax';
import { logMiles } from './mileage';

let db: DB;
let ownerA: string;
let ownerB: string;
let companyA: string;
let companyB: string;
let ctxA: ServiceContext;
let ctxB: ServiceContext;

function as(userId: string, method: string, routePath: string, companyId = companyA) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
function postCompany(name: string) {
  return companiesPOST(
    new NextRequest('http://127.0.0.1/api/companies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
}
async function newUser(email: string, name: string) {
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash: await hashPassword('pass12345') })
    .returning();
  return u.id;
}
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  ownerA = await newUser('owner-a@scope.local', 'Owner A');
  ownerB = await newUser('owner-b@scope.local', 'Owner B');
  companyA = (await createCompany(db, { name: 'Scope Alpha', ownerId: ownerA })).id;
  companyB = (await createCompany(db, { name: 'Scope Bravo', ownerId: ownerB })).id;
  ctxA = { db, companyId: companyA, userId: ownerA };
  ctxB = { db, companyId: companyB, userId: ownerB };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('POST /api/companies — only an Admin may create a company', () => {
  it('a clerk (non-Admin) cannot create a company and become its owner', async () => {
    as(ownerA, 'POST', '/api/users');
    const admin = await getServerContext();
    const clerk = await addUser(admin, {
      name: 'Clerk',
      login: 'clerk@scope.local',
      password: 'clerkpass1',
      roleKeys: ['bookkeeper'],
    });
    as(clerk.userId, 'POST', '/api/companies');
    const res = await postCompany('Clerk Co');
    expect(res.status).toBe(403);
    const rows = await db.select().from(companies).where(eq(companies.name, 'Clerk Co'));
    expect(rows).toHaveLength(0);
  });

  it('an Admin of the current company can still create one (and owns it)', async () => {
    as(ownerA, 'POST', '/api/companies');
    const res = await postCompany('Admin Second Co');
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.ownerId).toBe(ownerA);
  });
});

describe('requireFileAdmin', () => {
  it('still covers archived companies (a whole-file restore would overwrite them too)', async () => {
    // ownerA is Admin of Scope Alpha and Admin Second Co, but not of Scope Bravo.
    expect(await codeOf(requireFileAdmin({ db, userId: ownerA }))).toBe('FORBIDDEN');
    const [b] = await db.select().from(companies).where(eq(companies.id, companyB));
    await db
      .update(companies)
      .set({ settings: { ...(b.settings ?? {}), archived: true } })
      .where(eq(companies.id, companyB));
    try {
      expect(await codeOf(requireFileAdmin({ db, userId: ownerA }))).toBe('FORBIDDEN');
    } finally {
      await db.update(companies).set({ settings: b.settings }).where(eq(companies.id, companyB));
    }
  });
});

describe('foreign ids from another company are rejected', () => {
  let custA: string;
  let custB: string;

  beforeAll(async () => {
    custA = (await createCustomer(ctxA, { displayName: 'Alpha Customer' })).id;
    custB = (await createCustomer(ctxB, { displayName: 'Bravo Secret Customer' })).id;
  });

  it("jobs: another company's customerId is refused on create and update", async () => {
    expect(await codeOf(createJob(ctxA, { name: 'Leak job', customerId: custB }))).toBe('VALIDATION');
    const job = await createJob(ctxA, { name: 'Own job', customerId: custA });
    expect(job.customerId).toBe(custA);
    expect(await codeOf(updateJob(ctxA, job.id, { customerId: custB }))).toBe('VALIDATION');
    expect(await codeOf(createJob(ctxA, { name: 'Bad id', customerId: 'not-a-uuid' }))).toBe('VALIDATION');
  });

  it("jobsSummary does not reveal another company's customer name", async () => {
    // A legacy row that already points across companies.
    await db.insert(jobs).values({ companyId: companyA, name: 'Legacy cross job', customerId: custB });
    const rows = await jobsSummary(ctxA);
    const legacy = rows.find((r) => r.name === 'Legacy cross job');
    expect(legacy).toBeDefined();
    expect(legacy!.customerName ?? null).toBeNull();
  });

  it("time entries: another company's employee / job / service item is refused", async () => {
    const [empB] = await db
      .insert(employees)
      .values({ companyId: companyB, firstName: 'Bea', lastName: 'Bravo' })
      .returning();
    const [empA] = await db
      .insert(employees)
      .values({ companyId: companyA, firstName: 'Al', lastName: 'Alpha' })
      .returning();
    const [itemB] = await db.insert(items).values({ companyId: companyB, name: 'Bravo svc' }).returning();
    const jobB = await createJob(ctxB, { name: 'Bravo job' });
    const base = { customerId: custA, date: new Date(), hours: 1 };

    expect(await codeOf(createTimeEntry(ctxA, { ...base, employeeId: empB.id }))).toBe('VALIDATION');
    expect(await codeOf(createTimeEntry(ctxA, { ...base, jobId: jobB.id }))).toBe('VALIDATION');
    expect(await codeOf(createTimeEntry(ctxA, { ...base, serviceItemId: itemB.id }))).toBe('VALIDATION');

    const entry = await createTimeEntry(ctxA, { ...base, employeeId: empA.id });
    expect(entry.employeeId).toBe(empA.id);
    expect(await codeOf(updateTimeEntry(ctxA, entry.id, { employeeId: empB.id }))).toBe('VALIDATION');

    // Mileage shares the employee check.
    expect(
      await codeOf(logMiles(ctxA, { employeeId: empB.id, date: new Date(), miles: 10 })),
    ).toBe('VALIDATION');
  });

  it("sales tax rate: another company's agency is refused on create", async () => {
    const agencyB = await createTaxAgency(ctxB, { name: 'Bravo Tax Board' });
    expect(await codeOf(createTaxRate(ctxA, { name: 'Leak', rate: '0.05', agencyId: agencyB.id }))).toBe(
      'NOT_FOUND',
    );
  });

  it("customers: another company's tax rate is refused on create and update", async () => {
    const rateB = await createTaxRate(ctxB, { name: 'Bravo rate', rate: '0.07' });
    expect(
      await codeOf(createCustomer(ctxA, { displayName: 'Leaky customer', taxRateId: rateB.id })),
    ).toBe('VALIDATION');
    expect(await codeOf(updateCustomer(ctxA, custA, { taxRateId: rateB.id }))).toBe('VALIDATION');
  });

  it("vendors: another company's default expense account is refused on create and update", async () => {
    const [acctB] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, companyB), eq(accounts.type, 'expense')))
      .limit(1);
    const [acctA] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, companyA), eq(accounts.type, 'expense')))
      .limit(1);
    expect(
      await codeOf(createVendor(ctxA, { displayName: 'Leaky vendor', defaultExpenseAccountId: acctB.id })),
    ).toBe('VALIDATION');
    const v = await createVendor(ctxA, { displayName: 'Own vendor', defaultExpenseAccountId: acctA.id });
    expect(v.defaultExpenseAccountId).toBe(acctA.id);
    expect(await codeOf(updateVendor(ctxA, v.id, { defaultExpenseAccountId: acctB.id }))).toBe('VALIDATION');
  });
});
