/**
 * P1 setup (fix round 1): feature switches and preferences enforced in the SERVICES, not only on
 * the API path or in the browser.
 *  - Charge sales tax off: new sales forms cannot carry tax; an edit that keeps an old
 *    document's tax is still allowed (turning tax off never locks old records).
 *  - Track inventory off: Inventory Part items cannot be created or converted to.
 *  - Use purchase orders off: memorized POs are skipped by runDue with a plain message (the
 *    rest of the run keeps going).
 *  - Duplicate bill / check number warnings off: the server accepts the duplicate silently.
 *  - Automatically number journal entries: the server assigns the next Entry No.
 *  - requireAccounts / warnWhenDeleting are always on (false is refused / never resolved).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { customers, taxAgencies, taxRates, users, vendors } from '@/lib/db/schema';
import { resolveCompanyPreferences, resolveMyPreferences } from '@/lib/preferences';
import { updateCompanyBodySchema as updateCompanySchema } from '@/lib/validation/company';
import { myPreferencesSchema } from '@/lib/validation/prefs';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { listAccounts } from './accounts';
import { createInvoice, getInvoice, updateInvoice } from './invoices';
import { createItem, updateItem } from './items';
import { createBill } from './bills';
import { createExpense } from './expenses';
import { createManualEntry } from './journal';
import { createTemplate, runDue } from './recurring';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-feature-enforcement');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
let vendorId: string;
const acct: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'enforce@test.local', name: 'E', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Enforce Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await listAccounts(ctx)) acct[a.code] = a.id;
  const [c] = await db.insert(customers).values({ companyId: company.id, displayName: 'Client' }).returning();
  customerId = c.id;
  const [v] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Supplier' }).returning();
  vendorId = v.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('sales tax switch', () => {
  it('an old taxed invoice can still be edited (tax kept) but new tax is refused', async () => {
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: ctx.companyId, name: 'State', liabilityAccountId: acct['2200'] })
      .returning();
    const [rate] = await db
      .insert(taxRates)
      .values({ companyId: ctx.companyId, name: 'State 5%', rate: '0.050000', agencyId: agency.id, isActive: true })
      .returning();
    const input = {
      customerId,
      date: new Date('2026-03-01'),
      taxRateId: rate.id,
      lines: [{ description: 'Taxable', quantity: 1, rate: 100, accountId: acct['4000'], taxable: true }],
    };
    const inv = await createInvoice(ctx, input);
    await updateCompany(ctx, { settings: { salesTaxEnabled: false } });
    const edited = await updateInvoice(ctx, inv.id, { ...input, memo: 'edited' } as never);
    expect(Number((await getInvoice(ctx, edited.id)).taxAmount)).toBeCloseTo(5);
    await expect(createInvoice(ctx, input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/^Sales tax is turned off/),
    });
    // Without tax the invoice is fine.
    await createInvoice(ctx, { ...input, taxRateId: null });
    await updateCompany(ctx, { settings: { salesTaxEnabled: true } });
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});

describe('inventory switch', () => {
  it('refuses converting an item to Inventory Part while inventory is off', async () => {
    const svc = await createItem(ctx, { name: 'Labor', type: 'service', incomeAccountId: acct['4000'] });
    await updateCompany(ctx, { settings: { inventoryEnabled: false } });
    await expect(
      updateItem(ctx, svc.id, { type: 'inventory', assetAccountId: acct['1300'], expenseAccountId: acct['5000'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Other edits still work.
    await expect(updateItem(ctx, svc.id, { name: 'Labor (hourly)' })).resolves.toBeTruthy();
    await updateCompany(ctx, { settings: { inventoryEnabled: true } });
  });
});

describe('memorized purchase orders while purchase orders are off', () => {
  it('runDue skips the PO with a plain message and still enters the other templates', async () => {
    await updateCompany(ctx, { settings: { purchaseOrdersEnabled: true } });
    const po = await createTemplate(ctx, {
      name: 'Weekly paper',
      docType: 'purchase_order',
      frequency: 'monthly',
      nextRunDate: '2026-04-01',
      template: { vendorId, lines: [{ accountId: acct['6300'], description: 'Paper', quantity: 1, rate: '25.00' }] },
      mode: 'automatic',
    });
    const je = await createTemplate(ctx, {
      name: 'Monthly accrual',
      docType: 'journal_entry',
      frequency: 'monthly',
      nextRunDate: '2026-04-01',
      template: {
        description: 'Accrual',
        lines: [
          { accountId: acct['6300'], debit: '10.00' },
          { accountId: acct['1000'], credit: '10.00' },
        ],
      },
      mode: 'automatic',
    });
    await updateCompany(ctx, { settings: { purchaseOrdersEnabled: false } });
    const res = await runDue(ctx, new Date('2026-04-01'));
    expect(res.generated.map((g) => g.templateId)).toContain(je.id);
    const failed = res.failed.find((f) => f.templateId === po.id);
    expect(failed?.error).toMatch(/^Purchase orders are turned off/);
    await updateCompany(ctx, { settings: { purchaseOrdersEnabled: true } });
  });
});

describe('duplicate bill and check numbers follow the preference on the server', () => {
  it('bill numbers: refused while warning is on, accepted silently while off', async () => {
    const bill = (n: string) =>
      createBill(ctx, {
        vendorId,
        billNumber: n,
        date: new Date('2026-03-05'),
        checkDuplicateNumber: true,
        lines: [{ accountId: acct['6300'], amount: '12.00' }],
      });
    await bill('INV-77');
    await expect(bill('INV-77')).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateCompany(ctx, { settings: { warnDuplicateBillNumbers: false } });
    await expect(bill('INV-77')).resolves.toBeTruthy();
    await updateCompany(ctx, { settings: { warnDuplicateBillNumbers: true } });
  });

  it('check numbers: refused while warning is on, accepted silently while off', async () => {
    const check = () =>
      createExpense(ctx, {
        vendorId,
        date: new Date('2026-03-06'),
        method: 'check',
        reference: '5001',
        paymentAccountId: acct['1000'],
        checkDuplicateNumber: true,
        lines: [{ accountId: acct['6300'], amount: '8.00' }],
      });
    await check();
    await expect(check()).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateCompany(ctx, { settings: { warnDuplicateCheckNumbers: false } });
    await expect(check()).resolves.toBeTruthy();
    await updateCompany(ctx, { settings: { warnDuplicateCheckNumbers: true } });
  });
});

describe('automatically number journal entries', () => {
  const entry = (reference?: string) =>
    createManualEntry(ctx, {
      date: new Date('2026-03-07'),
      description: 'Numbered',
      reference,
      lines: [
        { accountId: acct['6300'], debit: '1.00' },
        { accountId: acct['1000'], credit: '1.00' },
      ],
    });

  it('on: an entry saved without a number gets the next one; off: none', async () => {
    await entry('GJ-0041');
    const next = await entry();
    expect(next.reference).toBe('GJ-0042');
    await updateCompany(ctx, { settings: { autoAssignJeNumbers: false } });
    const none = await entry();
    expect(none.reference).toBeNull();
    await updateCompany(ctx, { settings: { autoAssignJeNumbers: true } });
  });
});

describe('always-on settings', () => {
  it('requireAccounts and warnWhenDeleting cannot be turned off', () => {
    expect(updateCompanySchema.safeParse({ settings: { requireAccounts: false } }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ settings: { requireAccounts: true } }).success).toBe(true);
    expect(myPreferencesSchema.safeParse({ warnWhenDeleting: false }).success).toBe(false);
    expect(resolveCompanyPreferences({ requireAccounts: false }).requireAccounts).toBe(true);
    expect(resolveMyPreferences({ warnWhenDeleting: false }).warnWhenDeleting).toBe(true);
  });
});
