/**
 * P1 setup — TESTER re-test round 1. Independent, adversarial checks of the fix round
 * (95be794, c43f7ca, adc012d, 2bc614e) against the reviewer's blockers/majors:
 *  - billables: cost nets the expense to zero, markup is income (both preference states),
 *    default markup, explicit 0 beats the default, rounding, ledger stays balanced, A/R == total;
 *  - sales tax off: every sales form refuses NEW tax (header and per line), edits may keep the
 *    old rate but may not swap to another one, removing tax is allowed; isolation per company;
 *    memorized taxed documents are skipped with a plain message;
 *  - inventory off: Inventory Part and Assembly refused, non-type edits of existing inventory
 *    items still allowed; isolation per company;
 *  - purchase orders off: service refuses, runTemplateNow refuses plainly, runGroup skips;
 *    every gate is checked on API paths (item receipts, receive-bill, reorder->PO), reads open;
 *  - payroll switch from the interview, payroll APIs/pages gated;
 *  - impossible start dates refused (leap years handled);
 *  - automatic journal numbers per company; always-on preferences survive a service write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { customers, expenseLines, invoices, taxAgencies, taxRates, users, vendors } from '@/lib/db/schema';
import { blockingFeatureGate, featureHiddenPaths, resolveCompanyPreferences } from '@/lib/preferences';
import type { ServiceContext } from './_base';
import { createCompany, getPreferences, updateCompany } from './company';
import { createAccount, listAccounts } from './accounts';
import { createInvoice, getInvoice, updateInvoice } from './invoices';
import { createSalesReceipt } from './salesReceipts';
import { createEstimate, updateEstimate } from './estimates';
import { createCreditMemo } from './creditMemos';
import { createItem, updateItem } from './items';
import { createExpense } from './expenses';
import { createInvoiceWithBillables } from './billables';
import { createPurchaseOrder } from './purchaseOrders';
import { createTemplate, runDue, runGroup, runTemplateNow } from './recurring';
import { createManualEntry } from './journal';
import { trialBalance } from './reports';
import { applySetupInterview, type SetupInterviewInput } from './setupInterview';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-setup-retest1');
let db: DB;
let A: ServiceContext;
let B: ServiceContext;
const acctA: Record<string, string> = {};
const acctB: Record<string, string> = {};
let custA: string;
let custB: string;
let vendA: string;
let rateA: string;
let rateA2: string;
let rateB: string;

async function mkCompany(name: string, email: string, acct: Record<string, string>) {
  const [user] = await db.insert(users).values({ email, name, passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  for (const a of await listAccounts(ctx)) acct[a.code] = a.id;
  return ctx;
}

async function mkRate(ctx: ServiceContext, acct: Record<string, string>, name: string, rate: string) {
  const [agency] = await db
    .insert(taxAgencies)
    .values({ companyId: ctx.companyId, name: `${name} agency`, liabilityAccountId: acct['2200'] })
    .returning();
  const [r] = await db
    .insert(taxRates)
    .values({ companyId: ctx.companyId, name, rate, agencyId: agency.id, isActive: true })
    .returning();
  return r.id;
}

function net(tb: Awaited<ReturnType<typeof trialBalance>>, accountId: string): string {
  const row = tb.rows.find((r) => r.accountId === accountId);
  return (row ? Number(row.debit) - Number(row.credit) : 0).toFixed(2);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  A = await mkCompany('Retest A', 'retest-a@test.local', acctA);
  B = await mkCompany('Retest B', 'retest-b@test.local', acctB);
  const [ca] = await db.insert(customers).values({ companyId: A.companyId, displayName: 'Client A' }).returning();
  custA = ca.id;
  const [cb] = await db.insert(customers).values({ companyId: B.companyId, displayName: 'Client B' }).returning();
  custB = cb.id;
  const [va] = await db.insert(vendors).values({ companyId: A.companyId, displayName: 'Supplier A' }).returning();
  vendA = va.id;
  rateA = await mkRate(A, acctA, 'A 5%', '0.050000');
  rateA2 = await mkRate(A, acctA, 'A 8%', '0.080000');
  rateB = await mkRate(B, acctB, 'B 6%', '0.060000');
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Billables / reimbursed expenses
// ---------------------------------------------------------------------------

describe('reimbursed expenses and markup (ledger)', () => {
  async function billableExpense(accountId: string, amount: string) {
    const exp = await createExpense(A, {
      vendorId: vendA,
      date: new Date('2026-03-06'),
      method: 'cash',
      paymentAccountId: acctA['1000'],
      lines: [{ accountId, description: 'Job cost', amount, customerId: custA }],
    });
    const [el] = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, exp.id));
    return el.id;
  }

  it('tracked as expense, no markup account: cost nets to zero, markup lands in default income', async () => {
    await updateCompany(A, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    const exp = await createAccount(A, { code: '6391', name: 'Pass-through Materials', type: 'expense', subtype: 'operating_expenses' });
    const elId = await billableExpense(exp.id, '50.00');
    const before = await trialBalance(A);
    const incomeBefore = Number(net(before, acctA['4000']));
    const arBefore = Number(net(before, acctA['1200']));
    const inv = await createInvoiceWithBillables(
      A,
      { customerId: custA, date: new Date('2026-03-07'), lines: [] },
      { expenseLineIds: [elId], markupPercent: 20 },
    );
    const full = await getInvoice(A, inv.id);
    expect(Number(full.total)).toBeCloseTo(60, 2);
    const tb = await trialBalance(A);
    expect(tb.balanced).toBe(true);
    expect(net(tb, exp.id)).toBe('0.00');
    // Markup 10 is income (credit = negative net).
    expect((Number(net(tb, acctA['4000'])) - incomeBefore).toFixed(2)).toBe('-10.00');
    expect((Number(net(tb, acctA['1200'])) - arBefore).toFixed(2)).toBe('60.00');
  });

  it('tracked as income: cost to Reimbursed Expenses Income, markup to Markup Income, expense untouched', async () => {
    await updateCompany(A, { settings: { trackReimbursedAsIncome: true } });
    const reimb = await createAccount(A, { code: '4131', name: 'Reimbursed Expenses Income', type: 'revenue', subtype: 'sales' });
    const mk = await createAccount(A, { code: '4141', name: 'Markup Income', type: 'revenue', subtype: 'sales' });
    const exp = await createAccount(A, { code: '6392', name: 'Travel Rebilled', type: 'expense', subtype: 'operating_expenses' });
    const elId = await billableExpense(exp.id, '80.00');
    await createInvoiceWithBillables(
      A,
      { customerId: custA, date: new Date('2026-03-08'), lines: [] },
      { expenseLineIds: [elId], markupPercent: 25 },
    );
    const tb = await trialBalance(A);
    expect(tb.balanced).toBe(true);
    expect(net(tb, exp.id)).toBe('80.00');
    expect(net(tb, reimb.id)).toBe('-80.00');
    expect(net(tb, mk.id)).toBe('-20.00');
  });

  it('tracked as expense with a Markup Income account: markup goes there, never to the expense', async () => {
    await updateCompany(A, { settings: { trackReimbursedAsIncome: false } });
    const exp = await createAccount(A, { code: '6393', name: 'Freight Rebilled', type: 'expense', subtype: 'operating_expenses' });
    const mk = (await listAccounts(A)).find((a) => a.name === 'Markup Income')!;
    const before = Number(net(await trialBalance(A), mk.id));
    const elId = await billableExpense(exp.id, '33.33');
    const inv = await createInvoiceWithBillables(
      A,
      { customerId: custA, date: new Date('2026-03-09'), lines: [] },
      { expenseLineIds: [elId], markupPercent: 15 },
    );
    // 33.33 * 15% = 4.9995 -> 5.00; total 38.33, never a fraction of a cent.
    expect(Number((await getInvoice(A, inv.id)).total)).toBeCloseTo(38.33, 2);
    const tb = await trialBalance(A);
    expect(tb.balanced).toBe(true);
    expect(net(tb, exp.id)).toBe('0.00');
    expect((Number(net(tb, mk.id)) - before).toFixed(2)).toBe('-5.00');
  });

  it('default markup applies when the caller gives none; an explicit 0 beats the default', async () => {
    await updateCompany(A, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 10 } });
    const exp = await createAccount(A, { code: '6394', name: 'Permits Rebilled', type: 'expense', subtype: 'operating_expenses' });
    const e1 = await billableExpense(exp.id, '100.00');
    const i1 = await createInvoiceWithBillables(
      A,
      { customerId: custA, date: new Date('2026-03-10'), lines: [] },
      { expenseLineIds: [e1] },
    );
    expect(Number((await getInvoice(A, i1.id)).total)).toBeCloseTo(110, 2);
    const e2 = await billableExpense(exp.id, '100.00');
    const i2 = await createInvoiceWithBillables(
      A,
      { customerId: custA, date: new Date('2026-03-10'), lines: [] },
      { expenseLineIds: [e2], markupPercent: 0 },
    );
    expect(Number((await getInvoice(A, i2.id)).total)).toBeCloseTo(100, 2);
    const tb = await trialBalance(A);
    expect(tb.balanced).toBe(true);
    expect(net(tb, exp.id)).toBe('0.00');
    await updateCompany(A, { settings: { defaultMarkupPercent: 0 } });
  });

  it('a negative markup is still refused', async () => {
    const exp = (await listAccounts(A)).find((a) => a.code === '6394')!;
    const e = await billableExpense(exp.id, '10.00');
    await expect(
      createInvoiceWithBillables(
        A,
        { customerId: custA, date: new Date('2026-03-11'), lines: [] },
        { expenseLineIds: [e], markupPercent: -5 },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
// Sales tax switch
// ---------------------------------------------------------------------------

describe('sales tax off at the service level', () => {
  const line = (extra: Record<string, unknown> = {}) => ({
    description: 'Taxable thing',
    quantity: 1,
    rate: 100,
    accountId: acctA['4000'],
    taxable: true,
    ...extra,
  });

  it('every sales form refuses new tax (header rate or per-line rate) with the plain message', async () => {
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    const off = { code: 'FORBIDDEN', message: expect.stringMatching(/^Sales tax is turned off/) };
    await expect(createInvoice(A, { customerId: custA, date: new Date('2026-03-12'), taxRateId: rateA, lines: [line()] })).rejects.toMatchObject(off);
    await expect(
      createInvoice(A, { customerId: custA, date: new Date('2026-03-12'), lines: [line({ taxRateId: rateA })] } as never),
    ).rejects.toMatchObject(off);
    await expect(
      createSalesReceipt(A, { customerId: custA, date: new Date('2026-03-12'), taxRateId: rateA, lines: [line()] }),
    ).rejects.toMatchObject(off);
    await expect(
      createSalesReceipt(A, { customerId: custA, date: new Date('2026-03-12'), lines: [line({ taxRateId: rateA })] }),
    ).rejects.toMatchObject(off);
    await expect(
      createEstimate(A, { customerId: custA, date: new Date('2026-03-12'), taxRateId: rateA, lines: [{ description: 'q', quantity: 1, rate: 100, taxable: true }] }),
    ).rejects.toMatchObject(off);
    await expect(
      createCreditMemo(A, { customerId: custA, date: new Date('2026-03-12'), taxRateId: rateA, lines: [line()] }),
    ).rejects.toMatchObject(off);
    // Nothing half-written: no invoice carries the refused tax rate.
    const taxed = await db.select().from(invoices).where(eq(invoices.taxRateId, rateA));
    expect(taxed.length).toBe(0);
    expect((await trialBalance(A)).balanced).toBe(true);
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
  });

  it('editing an old taxed invoice: keeping its rate is fine, switching to another rate is refused, removing tax is fine', async () => {
    const input = { customerId: custA, date: new Date('2026-03-13'), taxRateId: rateA, lines: [line()] };
    const inv = await createInvoice(A, input);
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    await expect(updateInvoice(A, inv.id, { ...input, taxRateId: rateA2 } as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(Number((await getInvoice(A, inv.id)).taxAmount)).toBeCloseTo(5, 2); // untouched by the refused edit
    await updateInvoice(A, inv.id, { ...input, memo: 'kept' } as never);
    expect(Number((await getInvoice(A, inv.id)).taxAmount)).toBeCloseTo(5, 2);
    await updateInvoice(A, inv.id, { ...input, taxRateId: null } as never);
    expect(Number((await getInvoice(A, inv.id)).taxAmount)).toBe(0);
    const tb = await trialBalance(A);
    expect(tb.balanced).toBe(true);
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
  });

  it('editing an old taxed estimate keeps its tax; swapping the rate is refused', async () => {
    const est = { customerId: custA, date: new Date('2026-03-14'), taxRateId: rateA, lines: [{ description: 'q', quantity: 1, rate: 200, taxable: true }] };
    const e = await createEstimate(A, est);
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    await expect(updateEstimate(A, e.id, { ...est, memo: 'kept' } as never)).resolves.toBeTruthy();
    await expect(updateEstimate(A, e.id, { ...est, taxRateId: rateA2 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
  });

  it('isolation: company A turning sales tax off does not affect company B', async () => {
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    const inv = await createInvoice(B, {
      customerId: custB,
      date: new Date('2026-03-15'),
      taxRateId: rateB,
      lines: [{ description: 'B sale', quantity: 1, rate: 100, accountId: acctB['4000'], taxable: true }],
    });
    expect(Number((await getInvoice(B, inv.id)).taxAmount)).toBeCloseTo(6, 2);
    expect((await getPreferences(B)).salesTaxEnabled).toBe(true);
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
  });

  it('a memorized taxed invoice is skipped while sales tax is off; the others still run', async () => {
    const taxedInv = await createTemplate(A, {
      name: 'Monthly taxed retainer',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: '2026-05-01',
      template: { customerId: custA, taxRateId: rateA, lines: [{ description: 'Retainer', quantity: 1, rate: 100, accountId: acctA['4000'], taxable: true }] },
      mode: 'automatic',
    });
    const plain = await createTemplate(A, {
      name: 'Monthly untaxed retainer',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: '2026-05-01',
      template: { customerId: custA, lines: [{ description: 'Retainer', quantity: 1, rate: 40, accountId: acctA['4000'] }] },
      mode: 'automatic',
    });
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    const res = await runDue(A, new Date('2026-05-01'));
    expect(res.generated.map((g) => g.templateId)).toContain(plain.id);
    expect(res.failed.find((f) => f.templateId === taxedInv.id)?.error).toMatch(/^Sales tax is turned off/);
    expect((await trialBalance(A)).balanced).toBe(true);
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
  });
});

// ---------------------------------------------------------------------------
// Inventory switch
// ---------------------------------------------------------------------------

describe('inventory off at the service level', () => {
  it('refuses Inventory Part and Inventory Assembly; services and non-type edits still work', async () => {
    const part = await createItem(A, {
      name: 'Widget',
      type: 'inventory',
      incomeAccountId: acctA['4000'],
      assetAccountId: acctA['1300'],
      expenseAccountId: acctA['5000'],
    });
    await updateCompany(A, { settings: { inventoryEnabled: false } });
    const off = { code: 'FORBIDDEN', message: expect.stringMatching(/turned off/) };
    await expect(
      createItem(A, { name: 'Widget 2', type: 'inventory', incomeAccountId: acctA['4000'], assetAccountId: acctA['1300'], expenseAccountId: acctA['5000'] }),
    ).rejects.toMatchObject(off);
    await expect(
      createItem(A, { name: 'Kit', type: 'assembly', incomeAccountId: acctA['4000'], assetAccountId: acctA['1300'], expenseAccountId: acctA['5000'] } as never),
    ).rejects.toMatchObject(off);
    await expect(createItem(A, { name: 'Consulting', type: 'service', incomeAccountId: acctA['4000'] })).resolves.toBeTruthy();
    // An existing inventory item is not locked: renaming it (type unchanged) still works.
    await expect(updateItem(A, part.id, { name: 'Widget (old)' })).resolves.toBeTruthy();
    await expect(updateItem(A, part.id, { type: 'inventory', name: 'Widget (old2)' })).resolves.toBeTruthy();
    // Company B is unaffected.
    await expect(
      createItem(B, { name: 'B Widget', type: 'inventory', incomeAccountId: acctB['4000'], assetAccountId: acctB['1300'], expenseAccountId: acctB['5000'] }),
    ).resolves.toBeTruthy();
    await updateCompany(A, { settings: { inventoryEnabled: true } });
  });
});

// ---------------------------------------------------------------------------
// Purchase orders switch
// ---------------------------------------------------------------------------

describe('purchase orders off', () => {
  it('the service refuses directly; runTemplateNow refuses plainly; runGroup skips and keeps going', async () => {
    const po = await createTemplate(A, {
      name: 'Group PO',
      docType: 'purchase_order',
      frequency: 'monthly',
      nextRunDate: '2026-06-01',
      groupName: 'Month end',
      template: { vendorId: vendA, lines: [{ accountId: acctA['6300'], description: 'Paper', quantity: 1, rate: '25.00' }] },
      mode: 'automatic',
    });
    const je = await createTemplate(A, {
      name: 'Group JE',
      docType: 'journal_entry',
      frequency: 'monthly',
      nextRunDate: '2026-06-01',
      groupName: 'Month end',
      template: {
        description: 'Accrual',
        lines: [
          { accountId: acctA['6300'], debit: '10.00' },
          { accountId: acctA['1000'], credit: '10.00' },
        ],
      },
      mode: 'automatic',
    });
    await updateCompany(A, { settings: { purchaseOrdersEnabled: false } });
    await expect(
      createPurchaseOrder(A, { vendorId: vendA, date: new Date('2026-06-01'), lines: [{ accountId: acctA['6300'], quantity: 1, rate: 5 }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/^Purchase orders are turned off/) });
    await expect(runTemplateNow(A, po.id)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/^Purchase orders are turned off/) });
    const res = await runGroup(A, 'Month end');
    expect(res.generated.map((g) => g.templateId)).toContain(je.id);
    expect(res.failed.find((f) => f.templateId === po.id)?.error).toMatch(/^Purchase orders are turned off/);
    // Company B can still enter purchase orders.
    const [vb] = await db.insert(vendors).values({ companyId: B.companyId, displayName: 'Supplier B' }).returning();
    await expect(
      createPurchaseOrder(B, { vendorId: vb.id, date: new Date('2026-06-01'), lines: [{ accountId: acctB['6300'], quantity: 1, rate: 5 }] }),
    ).resolves.toBeTruthy();
    await updateCompany(A, { settings: { purchaseOrdersEnabled: true } });
    expect((await trialBalance(A)).balanced).toBe(true);
  });

  it('every matching API gate is checked; reads stay open', () => {
    const prefs = resolveCompanyPreferences({ purchaseOrdersEnabled: false, inventoryEnabled: true });
    for (const p of ['/api/item-receipts', '/api/item-receipts/abc', '/api/receiving/bill', '/api/inventory/reorder/create-po', '/api/purchase-orders']) {
      expect(blockingFeatureGate(p, prefs, 'POST')?.key, p).toBe('purchaseOrdersEnabled');
      expect(blockingFeatureGate(p, prefs, 'GET'), p).toBeNull();
    }
    // Other inventory APIs stay open while only POs are off.
    expect(blockingFeatureGate('/api/inventory/adjustments', prefs, 'POST')).toBeNull();
    // Inventory off blocks reorder->PO even with POs on.
    const invOff = resolveCompanyPreferences({ purchaseOrdersEnabled: true, inventoryEnabled: false });
    expect(blockingFeatureGate('/api/inventory/reorder/create-po', invOff, 'POST')?.key).toBe('inventoryEnabled');
    // Prefix lookalikes are not gated.
    expect(blockingFeatureGate('/api/item-receipts-report', prefs, 'POST')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Interview: payroll switch, start dates
// ---------------------------------------------------------------------------

describe('setup interview fixes', () => {
  const base: SetupInterviewInput = {
    businessType: 'retail',
    entityType: 'sole_prop',
    fiscalYearStartMonth: 1,
    reportBasis: 'accrual',
    salesTax: true,
    inventory: true,
    employees: true,
    estimates: true,
    progressInvoicing: false,
    timeTracking: true,
    classTracking: false,
    multiCurrency: false,
  };

  it('employees No turns payroll off (APIs and pages gated); Yes turns it back on', async () => {
    await applySetupInterview(B, { ...base, employees: false });
    const off = await getPreferences(B);
    expect(off.payrollEnabled).toBe(false);
    expect(blockingFeatureGate('/api/payroll/pay-runs', off, 'POST')?.key).toBe('payrollEnabled');
    expect(blockingFeatureGate('/api/payroll-items', off, 'POST')?.key).toBe('payrollEnabled');
    expect(blockingFeatureGate('/api/pay-liabilities', off, 'POST')?.key).toBe('payrollEnabled');
    expect(featureHiddenPaths(off).has('/pay-runs')).toBe(true);
    // The employee list stays open (QB keeps the Employee Center with "No payroll").
    expect(blockingFeatureGate('/api/employees', off, 'POST')).toBeNull();
    // Company A untouched by B's interview.
    expect((await getPreferences(A)).payrollEnabled).toBe(true);
    await applySetupInterview(B, { ...base, employees: true });
    expect((await getPreferences(B)).payrollEnabled).toBe(true);
  });

  it('impossible start dates are refused; real leap days are accepted', async () => {
    for (const d of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-1-5']) {
      await expect(applySetupInterview(B, { ...base, startDate: d }), d).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    await expect(applySetupInterview(B, { ...base, startDate: '2028-02-29' })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Journal numbers, always-on preferences
// ---------------------------------------------------------------------------

describe('automatic journal numbers and always-on settings', () => {
  const entry = (ctx: ServiceContext, acct: Record<string, string>, reference?: string) =>
    createManualEntry(ctx, {
      date: new Date('2026-03-20'),
      description: 'Numbered',
      reference,
      lines: [
        { accountId: acct['6300'], debit: '1.00' },
        { accountId: acct['1000'], credit: '1.00' },
      ],
    });

  it('numbers follow each company separately; a blank/space number gets the next one; a typed number is kept', async () => {
    await updateCompany(A, { settings: { autoAssignJeNumbers: true } });
    await updateCompany(B, { settings: { autoAssignJeNumbers: true } });
    await entry(A, acctA, '900');
    const a2 = await entry(A, acctA, '   ');
    expect(a2.reference).toBe('901');
    const b1 = await entry(B, acctB);
    expect(b1.reference).not.toBe('902');
    expect(b1.reference).toBeTruthy();
    const typed = await entry(A, acctA, 'ADJ-7');
    expect(typed.reference).toBe('ADJ-7');
    expect((await trialBalance(A)).balanced).toBe(true);
    expect((await trialBalance(B)).balanced).toBe(true);
  });

  it('requireAccounts stays on even if a service caller writes false', async () => {
    await updateCompany(A, { settings: { requireAccounts: false } as never }).catch(() => undefined);
    expect((await getPreferences(A)).requireAccounts).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression probes found in re-test round 1
// ---------------------------------------------------------------------------

describe('re-test probes', () => {
  it('BUG: billing back an inventory item bought for a customer credits Inventory Asset, so the GL no longer ties to inventory valuation', async () => {
    // Before this branch billable costs were credited to income (4000). With the new routing
    // ("Track reimbursed expenses as income" off) the cost goes back to the bill line's account;
    // for an Inventory Part line that account is 1300 Inventory Asset. The invoice carries no
    // item, so no stock is relieved: GL Inventory Asset drops by the cost while the inventory
    // valuation (layers / on hand) does not. QB never lets a reimbursement credit the inventory
    // asset without moving quantity. Inventory Asset must keep tying to the valuation report.
    const accts: Record<string, string> = {};
    const C = await mkCompany('Retest C', 'retest-c@test.local', accts);
    await updateCompany(C, { settings: { trackReimbursedAsIncome: false } });
    const [cust] = await db.insert(customers).values({ companyId: C.companyId, displayName: 'Client C' }).returning();
    const [vend] = await db.insert(vendors).values({ companyId: C.companyId, displayName: 'Supplier C' }).returning();
    const part = await createItem(C, {
      name: 'Faucet',
      type: 'inventory',
      incomeAccountId: accts['4000'],
      assetAccountId: accts['1300'],
      expenseAccountId: accts['5000'],
    });
    const { createBill } = await import('./bills');
    const { billLines } = await import('@/lib/db/schema');
    const { inventoryValuation } = await import('./inventory');
    const bill = await createBill(C, {
      vendorId: vend.id,
      date: new Date('2026-03-02'),
      lines: [{ itemId: part.id, quantity: 2, unitCost: '40.00', customerId: cust.id }],
    });
    const [bl] = await db.select().from(billLines).where(eq(billLines.billId, bill.id));
    await createInvoiceWithBillables(
      C,
      { customerId: cust.id, date: new Date('2026-03-03'), lines: [] },
      { billLineIds: [bl.id] },
    );
    const tb = await trialBalance(C);
    expect(tb.balanced).toBe(true);
    const valuation = await inventoryValuation(C);
    expect(net(tb, accts['1300'])).toBe(Number(valuation.grandTotal).toFixed(2));
  });

  it('converting an old taxed estimate while sales tax is off gives a plain answer and never unbalances the books', async () => {
    const { convertToInvoice } = await import('./estimates');
    const e = await createEstimate(A, {
      customerId: custA,
      date: new Date('2026-03-21'),
      taxRateId: rateA,
      lines: [{ description: 'Quoted', quantity: 1, rate: 300, taxable: true }],
    });
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    try {
      await convertToInvoice(A, e.id);
    } catch (err) {
      expect(err).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/^Sales tax is turned off/) });
    }
    expect((await trialBalance(A)).balanced).toBe(true);
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
  });
});
