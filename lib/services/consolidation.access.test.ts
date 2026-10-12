/**
 * Legacy consolidated P&L / Balance Sheet must never leak another company's books (P0 in
 * PARITY.md: consolidatedPL / consolidatedBalanceSheet used to sum EVERY company in the file,
 * exposed by GET /api/reports/consolidated to anyone with financial reports in one company).
 *
 * Alice owns A. Bob owns B, C, D and E. Alice is:
 *   - not a member of B                                  → never combined
 *   - an active Accountant in C                          → combined
 *   - an active A/R Clerk in D (no financial reports)    → never combined
 *   - a deactivated Accountant in E                      → never combined
 * Each company books a distinctive income amount so any leak shows up in the totals.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { resolveAccess } from './access';
import { consolidatedBalanceSheet, consolidatedPL, reportableCompanies } from './consolidation';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({
  getServerContext: vi.fn(async () => ctx),
}));
import { GET as consolidatedGET } from '@/app/api/reports/consolidated/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-consolidation-access');
let db: DB;
let alice: ServiceContext;
const co: Record<string, string> = {};

async function book(companyId: string, userId: string, amount: string) {
  const [cash] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, '1000')));
  const [sales] = await db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.code, '4000')));
  await postJournalEntry(
    { db, companyId, userId },
    {
      date: new Date('2026-05-01T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: cash.id, debit: amount },
        { accountId: sales.id, credit: amount },
      ],
    },
  );
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [a] = await db.insert(users).values({ email: 'alice@consol.test', name: 'Alice', passwordHash: 'x' }).returning();
  const [b] = await db.insert(users).values({ email: 'bob@consol.test', name: 'Bob', passwordHash: 'x' }).returning();
  co.A = (await createCompany(db, { name: 'Alice Co', ownerId: a.id })).id;
  for (const k of ['B', 'C', 'D', 'E']) co[k] = (await createCompany(db, { name: `Bob ${k}`, ownerId: b.id })).id;
  await db.insert(userCompanies).values([
    { userId: a.id, companyId: co.C, role: 'accountant', isActive: true },
    { userId: a.id, companyId: co.D, role: 'viewer', isActive: true },
    { userId: a.id, companyId: co.E, role: 'accountant', isActive: false },
  ]);
  await db.insert(userRoleAssignments).values({ companyId: co.D, userId: a.id, roleKey: 'ar_clerk' });
  await book(co.A, a.id, '100.00');
  await book(co.B, b.id, '20000.00');
  await book(co.C, b.id, '300.00');
  await book(co.D, b.id, '4000.00');
  await book(co.E, b.id, '50000.00');
  const access = (await resolveAccess(db, co.A, a.id)).access;
  alice = { db, companyId: co.A, userId: a.id, access };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('consolidated reports only combine companies the user may report on', () => {
  it('reportableCompanies: current company + active memberships with financial reports', async () => {
    const ids = (await reportableCompanies(alice)).map((c) => c.id).sort();
    expect(ids).toEqual([co.A, co.C].sort());
    // Internal contexts (no access grant, e.g. the report scheduler) get the same answer.
    const internal = (await reportableCompanies({ db, companyId: co.A, userId: alice.userId })).map((c) => c.id).sort();
    expect(internal).toEqual([co.A, co.C].sort());
  });

  it("consolidatedPL never includes another company's numbers", async () => {
    const r = await consolidatedPL(alice);
    expect(r.companies.map((c) => c.companyId).sort()).toEqual([co.A, co.C].sort());
    expect(r.consolidated.totalIncome).toBe('400.00');
  });

  it("consolidatedBalanceSheet never includes another company's numbers", async () => {
    const r = await consolidatedBalanceSheet(alice);
    expect(r.companies.map((c) => c.companyId).sort()).toEqual([co.A, co.C].sort());
    expect(r.consolidated.totalAssets).toBe('400.00');
    expect(r.consolidated.balanced).toBe(true);
  });

  it('GET /api/reports/consolidated (P&L and balance sheet) is limited the same way', async () => {
    ctx = alice;
    const pl = await consolidatedGET(new NextRequest('http://localhost/api/reports/consolidated?type=pl'));
    expect(pl.status).toBe(200);
    const plBody = (await pl.json()) as Awaited<ReturnType<typeof consolidatedPL>>;
    expect(plBody.companies.map((c) => c.companyName).sort()).toEqual(['Alice Co', 'Bob C']);
    expect(plBody.consolidated.totalIncome).toBe('400.00');
    const text = JSON.stringify(plBody);
    for (const leaked of ['20000.00', '4000.00', '50000.00', 'Bob B', 'Bob D', 'Bob E']) expect(text).not.toContain(leaked);

    const bs = await consolidatedGET(new NextRequest('http://localhost/api/reports/consolidated?type=bs'));
    expect(bs.status).toBe(200);
    const bsBody = (await bs.json()) as Awaited<ReturnType<typeof consolidatedBalanceSheet>>;
    expect(bsBody.companies.map((c) => c.companyId).sort()).toEqual([co.A, co.C].sort());
    expect(bsBody.consolidated.totalAssets).toBe('400.00');
  });

  it("a user of B alone sees only B, never Alice's company", async () => {
    const bob = (await db.select().from(users).where(eq(users.email, 'bob@consol.test')))[0];
    const access = (await resolveAccess(db, co.B, bob.id)).access;
    const r = await consolidatedPL({ db, companyId: co.B, userId: bob.id, access });
    expect(r.companies.map((c) => c.companyId)).not.toContain(co.A);
  });

  it('archived company files the user can open are not combined (current company always is)', async () => {
    const [c] = await db.select().from(companies).where(eq(companies.id, co.C));
    await db.update(companies).set({ settings: { ...((c.settings as object) ?? {}), archived: true } }).where(eq(companies.id, co.C));
    try {
      expect((await reportableCompanies(alice)).map((x) => x.id)).toEqual([co.A]);
      const r = await consolidatedPL(alice);
      expect(r.consolidated.totalIncome).toBe('100.00');
    } finally {
      await db.update(companies).set({ settings: c.settings }).where(eq(companies.id, co.C));
    }
    expect((await reportableCompanies(alice)).map((x) => x.id).sort()).toEqual([co.A, co.C].sort());
  });
});
