/**
 * Independent adversarial QA: no combined / consolidated report path may read the books of a
 * company the caller cannot report on (PARITY.md P0: legacy consolidated P&L / BS leak).
 *
 * Alice owns A. Bob owns B (Alice not a member), C (Alice active Accountant), D (Alice active,
 * A/R clerk role only) and E (Alice deactivated). Each company books a unique cash sale, so a leak
 * shows up as a distinctive number anywhere in the serialized report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { postJournalEntry } from './posting';
import { resolveAccess } from './access';
import {
  combinedAging,
  combinedCashFlow,
  combinedProfitAndLossByMonth,
  combinedTrialBalance,
  consolidatedBalanceSheet,
  consolidatedPL,
  reportableCompanies,
} from './consolidation';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-consolidation-adversarial');
let db: DB;
let alice: ServiceContext;
let aliceId: string;
const co: Record<string, string> = {};
const LEAKS = ['20000', '4000.00', '50000', 'Bob B', 'Bob E'];

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

const noLeak = (r: unknown, extra: string[] = []) => {
  const text = JSON.stringify(r);
  for (const l of [...LEAKS, ...extra]) expect(text, `leaked ${l}`).not.toContain(l);
};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [a] = await db.insert(users).values({ email: 'alice@adv-consol.test', name: 'Alice', passwordHash: 'x' }).returning();
  const [b] = await db.insert(users).values({ email: 'bob@adv-consol.test', name: 'Bob', passwordHash: 'x' }).returning();
  aliceId = a.id;
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
  alice = { db, companyId: co.A, userId: a.id, access: (await resolveAccess(db, co.A, a.id)).access };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('every combined report runner is limited to reportable companies', () => {
  it('combined Trial Balance sums only A + C and stays balanced', async () => {
    const r = await combinedTrialBalance(alice, { asOf: '2026-12-31' });
    expect(r.balanced).toBe(true);
    noLeak(r);
    expect(JSON.stringify(r)).toContain('400.00');
  });

  it('combined P&L by Month (accrual and cash basis) sums only A + C', async () => {
    for (const basis of [undefined, 'cash'] as const) {
      const r = await combinedProfitAndLossByMonth(alice, { from: '2026-01-01', to: '2026-12-31', basis });
      noLeak(r);
      const net = r.rows.find((x) => x.id === 'pl:net' || /net/i.test(String(x.cells.label)));
      expect(net, 'net income row').toBeTruthy();
      expect(Object.values(net!.cells)).toContain('400.00');
    }
  });

  it('combined Statement of Cash Flows sums only A + C', async () => {
    const r = await combinedCashFlow(alice, { from: '2026-01-01', to: '2026-12-31' });
    noLeak(r);
  });

  it('combined A/R and A/P aging never include B or E', async () => {
    noLeak(await combinedAging(alice, { asOf: '2026-12-31' }, 'ar'));
    noLeak(await combinedAging(alice, { asOf: '2026-12-31' }, 'ap'));
  });

  it('a scheduler-style context without a user only sees the current company', async () => {
    const ids = (await reportableCompanies({ db, companyId: co.A, userId: null } as unknown as ServiceContext)).map((c) => c.id);
    expect(ids).toEqual([co.A]);
    const r = await consolidatedPL({ db, companyId: co.A, userId: null } as unknown as ServiceContext);
    expect(r.consolidated.totalIncome).toBe('100.00');
  });

  it('a forged access grant on the context does not widen another company', async () => {
    // Even with an all-powerful access object for the CURRENT company, other companies are
    // decided by the user's own membership there.
    const forged = { ...alice, access: { ...(alice.access as object), isAdmin: true } } as ServiceContext;
    const r = await consolidatedPL(forged);
    expect(r.companies.map((c) => c.companyId).sort()).toEqual([co.A, co.C].sort());
    noLeak(r);
  });

  it('deactivating Alice in C removes C immediately from legacy and std combined reports', async () => {
    await db.update(userCompanies).set({ isActive: false }).where(and(eq(userCompanies.userId, aliceId), eq(userCompanies.companyId, co.C)));
    try {
      const pl = await consolidatedPL(alice);
      expect(pl.companies.map((c) => c.companyId)).toEqual([co.A]);
      expect(pl.consolidated.totalIncome).toBe('100.00');
      const bs = await consolidatedBalanceSheet(alice);
      expect(bs.consolidated.totalAssets).toBe('100.00');
      expect(bs.consolidated.balanced).toBe(true);
      const tb = await combinedTrialBalance(alice, { asOf: '2026-12-31' });
      noLeak(tb, ['300.00']);
    } finally {
      await db.update(userCompanies).set({ isActive: true }).where(and(eq(userCompanies.userId, aliceId), eq(userCompanies.companyId, co.C)));
    }
  });
});
