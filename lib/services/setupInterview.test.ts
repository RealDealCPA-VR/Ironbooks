/**
 * P1 setup: the EasyStep interview applied to the active company through
 * applySetupInterview — one transaction, features really switched, tax form + tax lines set,
 * equity accounts added, books balanced, re-run safe, viewer refused, skip recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, getCompany, getPreferences } from './company';
import { listAccounts, getIncomeTaxForm } from './accounts';
import { trialBalance } from './reports';
import {
  applySetupInterview,
  getSetupInterview,
  skipSetupInterview,
  type SetupInterviewInput,
} from './setupInterview';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-setup-interview');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext;

const answers: SetupInterviewInput = {
  businessType: 'construction',
  entityType: 's_corp',
  fiscalYearStartMonth: 1,
  taxYearStartMonth: 1,
  startDate: '2026-01-01',
  reportBasis: 'accrual',
  salesTax: false,
  inventory: false,
  employees: true,
  estimates: true,
  progressInvoicing: true,
  timeTracking: true,
  classTracking: false,
  multiCurrency: false,
  currency: 'USD',
  company: {
    name: 'Builder Bros',
    legalName: 'Builder Brothers Inc.',
    ein: '98-7654321',
    addressLine1: '1 Hammer Way',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    phone: '555-0199',
    email: 'office@builder.test',
  },
};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'interview@test.local', name: 'Interview', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'New Company', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const other = await createCompany(db, { name: 'Skipper', ownerId: user.id });
  ctx2 = { db, companyId: other.id, userId: user.id };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('applySetupInterview', () => {
  it('saves company info, switches features to match the answers, and records the interview', async () => {
    const result = await applySetupInterview(ctx, answers);
    expect(result.accountsAdded).toBeGreaterThan(0);

    const company = await getCompany(ctx);
    expect(company?.name).toBe('Builder Bros');
    expect(company?.settings).toMatchObject({
      legalName: 'Builder Brothers Inc.',
      ein: '98-7654321',
      address: '1 Hammer Way, Austin, TX 78701',
      phone: '555-0199',
      email: 'office@builder.test',
      industry: 'construction',
    });

    const prefs = await getPreferences(ctx);
    expect(prefs.inventoryEnabled).toBe(false);
    expect(prefs.purchaseOrdersEnabled).toBe(false);
    expect(prefs.salesTaxEnabled).toBe(false);
    expect(prefs.estimatesEnabled).toBe(true);
    expect(prefs.progressInvoicingEnabled).toBe(true);
    expect(prefs.timeTrackingEnabled).toBe(true);
    expect(prefs.classTrackingEnabled).toBe(false);
    expect(prefs.payrollPayPeriod).toBe('biweekly');

    // Summary agrees with what was saved.
    expect(result.plan.summary).toContain('Sales tax: off');
    expect(result.plan.summary).toContain('Inventory tracking: off');

    const rec = await getSetupInterview(ctx);
    expect(rec).toMatchObject({ status: 'done', entityType: 's_corp', taxYearStartMonth: 1, startDate: '2026-01-01' });
  });

  it('sets the tax form, adds S-corp equity and maps the starter chart to tax lines', async () => {
    expect(await getIncomeTaxForm(ctx)).toBe('1120S');
    const accts = await listAccounts(ctx);
    const byName = new Map(accts.map((a) => [a.name, a]));
    expect(byName.get('Capital Stock')?.taxLine).toBe('1120S:L22');
    expect(byName.get('Shareholder Distributions')?.taxLine).toBe('1120S:L26');
    expect(byName.get('Rent')?.taxLine).toBe('1120S:11');
    expect(byName.get('Sales Income')?.taxLine).toBe('1120S:1a');
    expect(byName.get('Checking')?.taxLine).toBe('1120S:L1');
    expect(byName.get('Retained Earnings')?.taxLine).toBe('1120S:L24');
  });

  it('keeps the books balanced and is safe to run again (no duplicates, mapped lines kept)', async () => {
    const before = (await listAccounts(ctx, { includeInactive: true })).length;
    const again = await applySetupInterview(ctx, { ...answers, entityType: 'c_corp' });
    expect(again.accountsAdded).toBe(1); // only "Dividends Paid" is new for a C corp
    const accts = await listAccounts(ctx, { includeInactive: true });
    expect(accts.length).toBe(before + 1);
    // A tax line that was already set is never replaced (only empty ones are filled).
    expect(accts.find((a) => a.name === 'Rent')?.taxLine).toBe('1120S:11');
    expect(accts.find((a) => a.name === 'Dividends Paid')?.taxLine).toBe('1120:L26');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('refuses bad input with a plain message, and a viewer cannot run it', async () => {
    await expect(
      applySetupInterview(ctx, { ...answers, company: { ein: '123' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(applySetupInterview({ ...ctx, role: 'viewer' }, answers)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('skip is recorded and never overrides a finished interview', async () => {
    expect(await getSetupInterview(ctx2)).toBeNull();
    const rec = await skipSetupInterview(ctx2);
    expect(rec.status).toBe('skipped');
    expect((await getSetupInterview(ctx2))?.status).toBe('skipped');
    expect((await skipSetupInterview(ctx)).status).toBe('done');
  });
});
