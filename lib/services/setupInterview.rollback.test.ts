/**
 * P1 setup — TESTER (adversarial). The interview is applied in ONE transaction: if anything
 * fails part-way (here: the 2nd new account), nothing is saved — no switched-off features, no
 * company name change, no half-added chart, no "done" record, no audit row for the record.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

let calls = 0;
vi.mock('./accounts', async (orig) => {
  const real = await orig<typeof import('./accounts')>();
  return {
    ...real,
    createAccount: vi.fn(async (...args: Parameters<typeof real.createAccount>) => {
      calls++;
      if (calls === 2) throw new Error('disk full (simulated)');
      return real.createAccount(...args);
    }),
  };
});

import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, getCompany, getPreferences } from './company';
import { getIncomeTaxForm, listAccounts } from './accounts';
import { trialBalance } from './reports';
import { applySetupInterview, getSetupInterview } from './setupInterview';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-setup-interview-rollback');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'rb@test.local', name: 'RB', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Rollback Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('applySetupInterview rollback', () => {
  it('a failure part-way leaves the company exactly as it was', async () => {
    const before = await getCompany(ctx);
    const prefsBefore = await getPreferences(ctx);
    const acctsBefore = (await listAccounts(ctx, { includeInactive: true })).map((a) => `${a.code}|${a.name}|${a.taxLine ?? ''}`).sort();
    const formBefore = await getIncomeTaxForm(ctx);
    calls = 0;
    await expect(
      applySetupInterview(ctx, {
        businessType: 'retail',
        entityType: 'c_corp',
        fiscalYearStartMonth: 7,
        reportBasis: 'cash',
        salesTax: false,
        inventory: false,
        employees: true,
        estimates: false,
        company: { name: 'Should Not Stick', ein: '11-2223333' },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);

    const after = await getCompany(ctx);
    expect(after?.name).toBe(before?.name);
    expect(after?.settings).toEqual(before?.settings);
    expect(await getPreferences(ctx)).toEqual(prefsBefore);
    expect(await getIncomeTaxForm(ctx)).toBe(formBefore);
    const acctsAfter = (await listAccounts(ctx, { includeInactive: true })).map((a) => `${a.code}|${a.name}|${a.taxLine ?? ''}`).sort();
    expect(acctsAfter).toEqual(acctsBefore);
    expect(await getSetupInterview(ctx)).toBeNull();
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
