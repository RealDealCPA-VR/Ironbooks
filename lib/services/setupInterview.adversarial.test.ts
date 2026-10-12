/**
 * P1 setup — TESTER (adversarial). Independent checks of the EasyStep interview and the
 * preference wiring, written against QuickBooks Desktop behaviour:
 *  - the interview only touches the ACTIVE company (multi-company isolation);
 *  - answering "No" really turns a feature off everywhere it can be used, not just its menu
 *    (sales tax on invoices, inventory part items, payroll, memorized purchase orders);
 *  - the summary matches what is saved, bad input is refused instead of silently dropped;
 *  - running it on a company that already has posted transactions keeps the books balanced
 *    and A/R control == open invoice balances;
 *  - wired preferences behave end-to-end (duplicate numbers, account auto-numbering per
 *    company, reimbursed expenses + markup).
 * Tests that fail here expose PRODUCTION bugs (see the test names); do not "fix" them by
 * weakening the assertions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  customers,
  expenseLines,
  invoices,
  taxAgencies,
  taxRates,
  users,
  vendors,
} from '@/lib/db/schema';
import { blockingFeatureGate, featureHiddenPaths, resolveCompanyPreferences } from '@/lib/preferences';
import type { ServiceContext } from './_base';
import { createCompany, getCompany, getPreferences, updateCompany } from './company';
import { createAccount, getIncomeTaxForm, listAccounts } from './accounts';
import { createInvoice } from './invoices';
import { createItem } from './items';
import { createExpense } from './expenses';
import { createInvoiceWithBillables } from './billables';
import { createTemplate, runTemplateNow } from './recurring';
import { trialBalance } from './reports';
import {
  applySetupInterview,
  getSetupInterview,
  skipSetupInterview,
  type SetupInterviewInput,
} from './setupInterview';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-setup-interview-adv');
let db: DB;
let A: ServiceContext; // the company the interview runs on
let B: ServiceContext; // a second company in the same file — must never change
let C: ServiceContext; // an "upgraded" company with posted transactions
const acctA: Record<string, string> = {};
const acctC: Record<string, string> = {};
let customerA: string;
let vendorA: string;

const allNo: SetupInterviewInput = {
  businessType: 'retail',
  entityType: 'sole_prop',
  fiscalYearStartMonth: 1,
  reportBasis: 'accrual',
  salesTax: false,
  inventory: false,
  employees: false,
  estimates: false,
  progressInvoicing: false,
  timeTracking: false,
  classTracking: false,
  multiCurrency: false,
};

async function settingsOf(ctx: ServiceContext) {
  return ((await getCompany(ctx))?.settings ?? {}) as Record<string, unknown>;
}

async function arControlBalance(ctx: ServiceContext): Promise<string> {
  const tb = await trialBalance(ctx);
  const row = tb.rows.find((r) => r.code === '1200');
  if (!row) return '0.00';
  return (Number(row.debit) - Number(row.credit)).toFixed(2);
}

async function openInvoiceTotal(ctx: ServiceContext): Promise<string> {
  const [r] = await ctx.db
    .select({ s: sql<string>`coalesce(sum(${invoices.balanceDue}), 0)` })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), sql`${invoices.status} <> 'void'`));
  return Number(r.s).toFixed(2);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'adv-interview@test.local', name: 'Adv', passwordHash: 'x' })
    .returning();
  const a = await createCompany(db, { name: 'Alpha', ownerId: user.id });
  const b = await createCompany(db, { name: 'Bravo', ownerId: user.id });
  const c = await createCompany(db, { name: 'Charlie (upgraded)', ownerId: user.id });
  A = { db, companyId: a.id, userId: user.id };
  B = { db, companyId: b.id, userId: user.id };
  C = { db, companyId: c.id, userId: user.id };
  for (const x of await listAccounts(A)) acctA[x.code] = x.id;
  for (const x of await listAccounts(C)) acctC[x.code] = x.id;
  const [cu] = await db.insert(customers).values({ companyId: a.id, displayName: 'Cust A' }).returning();
  customerA = cu.id;
  const [v] = await db.insert(vendors).values({ companyId: a.id, displayName: 'Vend A' }).returning();
  vendorA = v.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('interview: isolation, summary, validation', () => {
  it('only changes the active company (another company in the file is untouched)', async () => {
    const beforeB = await settingsOf(B);
    const beforeBAccounts = (await listAccounts(B, { includeInactive: true })).length;
    const beforeBForm = await getIncomeTaxForm(B);
    await applySetupInterview(A, {
      ...allNo,
      entityType: 's_corp',
      company: { name: 'Alpha Renamed', legalName: 'Alpha LLC', ein: '12-3456789' },
    });
    expect(await settingsOf(B)).toEqual(beforeB);
    expect((await listAccounts(B, { includeInactive: true })).length).toBe(beforeBAccounts);
    expect(await getIncomeTaxForm(B)).toBe(beforeBForm);
    expect((await getCompany(B))?.name).toBe('Bravo');
    expect(await getSetupInterview(B)).toBeNull();
    expect((await getCompany(A))?.name).toBe('Alpha Renamed');
  });

  it('"No" to every feature: every switch is off, the menus hide and saves are blocked; summary agrees', async () => {
    const res = await applySetupInterview(A, allNo);
    const prefs = await getPreferences(A);
    for (const k of [
      'salesTaxEnabled',
      'inventoryEnabled',
      'purchaseOrdersEnabled',
      'estimatesEnabled',
      'progressInvoicingEnabled',
      'timeTrackingEnabled',
      'classTrackingEnabled',
      'multiCurrencyEnabled',
    ] as const) {
      expect(prefs[k], k).toBe(false);
    }
    const hidden = featureHiddenPaths(prefs);
    for (const p of ['/estimates', '/time-tracking', '/sales-tax-components', '/inventory-ops', '/purchase-orders']) {
      expect(hidden.has(p), p).toBe(true);
    }
    for (const api of ['/api/estimates', '/api/time-entries', '/api/tax-rates', '/api/inventory', '/api/purchase-orders']) {
      expect(blockingFeatureGate(api, prefs, 'POST'), api).not.toBeNull();
    }
    for (const line of [
      'Sales tax: off',
      'Inventory tracking: off',
      'Purchase orders: off',
      'Estimates: off',
      'Progress invoicing: off',
      'Time tracking: off',
      'Class tracking: off',
      'More than one currency: no',
    ]) {
      expect(res.plan.summary, line).toContain(line);
    }
  });

  it('progress invoicing cannot end up on while estimates are off', async () => {
    await applySetupInterview(A, { ...allNo, estimates: false, progressInvoicing: true });
    expect((await getPreferences(A)).progressInvoicingEnabled).toBe(false);
  });

  it('BUG: answering "No" to employees does not turn payroll off (payroll menus and saves stay on)', async () => {
    // QB EasyStep "Do you have employees?" No => payroll is off (Payroll & Employees
    // preference "No payroll"): the Employees/Payroll menus are hidden and paychecks can't be
    // created. Here nothing is saved for "No", and there is no payroll feature switch at all.
    await applySetupInterview(A, { ...allNo, employees: false });
    const prefs = resolveCompanyPreferences(await settingsOf(A));
    expect(featureHiddenPaths(prefs).has('/pay-runs')).toBe(true);
    expect(blockingFeatureGate('/api/payroll/pay-runs', prefs, 'POST')).not.toBeNull();
  });

  it('BUG: an impossible start date (Feb 30) is silently dropped instead of refused', async () => {
    // The schema only checks the YYYY-MM-DD shape; buildSetupPlan then discards a non-calendar
    // date, so the user's answer vanishes without a message.
    await expect(applySetupInterview(A, { ...allNo, startDate: '2026-02-30' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('refuses out-of-range months and malformed EIN/email with plain messages, saving nothing', async () => {
    const before = await settingsOf(A);
    await expect(applySetupInterview(A, { ...allNo, fiscalYearStartMonth: 13 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(applySetupInterview(A, { ...allNo, taxYearStartMonth: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(applySetupInterview(A, { ...allNo, company: { ein: '12-345678' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(applySetupInterview(A, { ...allNo, company: { email: 'not-an-email' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await settingsOf(A)).toEqual(before);
  });

  it('re-running without company info keeps the saved legal name / EIN and the company name', async () => {
    await applySetupInterview(A, { ...allNo, company: { name: 'Alpha Renamed', legalName: 'Alpha LLC', ein: '12-3456789' } });
    await applySetupInterview(A, allNo); // no company block
    const s = await settingsOf(A);
    expect(s.legalName).toBe('Alpha LLC');
    expect(s.ein).toBe('12-3456789');
    await applySetupInterview(A, { ...allNo, company: { name: '   ' } });
    expect((await getCompany(A))?.name).toBe('Alpha Renamed');
  });

  it('"Other / not sure" never clears a tax form already chosen', async () => {
    await applySetupInterview(A, { ...allNo, entityType: 'c_corp' });
    expect(await getIncomeTaxForm(A)).toBe('1120');
    await applySetupInterview(A, { ...allNo, entityType: 'other' });
    expect(await getIncomeTaxForm(A)).toBe('1120');
  });

  it('a viewer can neither apply nor skip the interview', async () => {
    await expect(applySetupInterview({ ...B, role: 'viewer' }, allNo)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(skipSetupInterview({ ...B, role: 'viewer' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await getSetupInterview(B)).toBeNull();
  });

  it('skip after skip keeps "skipped"; apply after skip turns it into "done"', async () => {
    await skipSetupInterview(B);
    await skipSetupInterview(B);
    expect((await getSetupInterview(B))?.status).toBe('skipped');
    await applySetupInterview(B, { ...allNo, businessType: 'general', entityType: 'other' });
    expect((await getSetupInterview(B))?.status).toBe('done');
    expect((await skipSetupInterview(B)).status).toBe('done');
  });
});

describe('interview on a company with posted transactions (upgraded file)', () => {
  it('keeps the trial balance balanced and A/R control == open invoices; no opening balances posted', async () => {
    const [cust] = await db.insert(customers).values({ companyId: C.companyId, displayName: 'Old Customer' }).returning();
    await createInvoice(C, {
      customerId: cust.id,
      date: new Date('2026-02-01'),
      lines: [
        { description: 'Work', quantity: 3, rate: '33.33', accountId: acctC['4100'] },
        { description: 'Part', quantity: 1, rate: '0.01', accountId: acctC['4000'] },
      ],
    });
    const tbBefore = await trialBalance(C);
    const arBefore = await arControlBalance(C);
    expect(arBefore).toBe('100.00');

    await applySetupInterview(C, { ...allNo, businessType: 'construction', entityType: 'partnership', employees: true, inventory: true });
    // Run twice (Help > Run Setup Interview again) — still nothing posted, nothing duplicated.
    const n = (await listAccounts(C, { includeInactive: true })).length;
    await applySetupInterview(C, { ...allNo, businessType: 'construction', entityType: 'partnership', employees: true, inventory: true });
    expect((await listAccounts(C, { includeInactive: true })).length).toBe(n);

    const tbAfter = await trialBalance(C);
    expect(tbAfter.balanced).toBe(true);
    expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
    expect(await arControlBalance(C)).toBe(arBefore);
    expect(await arControlBalance(C)).toBe(await openInvoiceTotal(C));
    expect(await getIncomeTaxForm(C)).toBe('1065');
  });
});

describe('"No" really turns the feature off where it is used (not only its own pages)', () => {
  it('BUG: sales tax off — an invoice can still charge sales tax', async () => {
    await updateCompany(A, { settings: { salesTaxEnabled: true } });
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: A.companyId, name: 'State', liabilityAccountId: acctA['2200'] })
      .returning();
    const [rate] = await db
      .insert(taxRates)
      .values({ companyId: A.companyId, name: 'State 8%', rate: '0.080000', agencyId: agency.id, isActive: true })
      .returning();
    await updateCompany(A, { settings: { salesTaxEnabled: false } });
    // QB: with "Do you charge sales tax? No" the Tax column and tax item are gone from forms.
    await expect(
      createInvoice(A, {
        customerId: customerA,
        date: new Date('2026-03-01'),
        taxRateId: rate.id,
        lines: [{ description: 'Taxable', quantity: 1, rate: 100, accountId: acctA['4000'], taxable: true }],
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|VALIDATION/) });
    expect((await trialBalance(A)).balanced).toBe(true);
  });

  it('BUG: inventory off — an Inventory Part item can still be created', async () => {
    await updateCompany(A, { settings: { inventoryEnabled: false } });
    // QB: with inventory off the Inventory Part / Assembly item types are not offered.
    await expect(
      createItem(A, {
        name: 'Widget (inventory off)',
        type: 'inventory',
        salesPrice: 10,
        purchaseCost: 4,
        incomeAccountId: acctA['4000'],
        expenseAccountId: acctA['5000'],
        assetAccountId: acctA['1300'],
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|VALIDATION/) });
  });

  it('BUG: purchase orders off — a memorized purchase order is still entered', async () => {
    await updateCompany(A, { settings: { purchaseOrdersEnabled: true } });
    const tpl = await createTemplate(A, {
      name: 'Monthly paper order',
      docType: 'purchase_order',
      frequency: 'monthly',
      nextRunDate: '2026-04-01',
      template: {
        vendorId: vendorA,
        lines: [{ accountId: acctA['6300'], description: 'Paper', quantity: 1, rate: '25.00' }],
      },
      mode: 'remind',
    });
    await updateCompany(A, { settings: { purchaseOrdersEnabled: false } });
    // Memorized transactions also run with no HTTP request (desktop start-up), where the
    // API-path gate (lib/featureGate.ts enforceFeatureGate) never fires.
    await expect(runTemplateNow(A, tpl.id, new Date('2026-04-01'))).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|VALIDATION/),
    });
    await updateCompany(A, { settings: { purchaseOrdersEnabled: true } });
  });
});

describe('wired preferences, end to end', () => {
  it('warn about duplicate invoice numbers: off saves both invoices, on refuses the second', async () => {
    const mk = (ref: string) =>
      createInvoice(A, {
        customerId: customerA,
        date: new Date('2026-03-05'),
        refNumber: ref,
        lines: [{ description: 'x', quantity: 1, rate: 1, accountId: acctA['4100'] }],
      });
    await updateCompany(A, { settings: { warnDuplicateInvoiceNumbers: true } });
    await mk('ADV-7');
    await expect(mk('ADV-7')).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateCompany(A, { settings: { warnDuplicateInvoiceNumbers: false } });
    await mk('ADV-7');
    const rows = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.companyId, A.companyId), eq(invoices.refNumber, 'ADV-7')));
    expect(rows.length).toBe(2);
    await updateCompany(A, { settings: { warnDuplicateInvoiceNumbers: true } });
    expect((await trialBalance(A)).balanced).toBe(true);
  });

  it('auto account numbers look only at this company and never reuse a taken code', async () => {
    await updateCompany(A, { settings: { requireAccountNumbers: false } });
    await updateCompany(B, { settings: { requireAccountNumbers: false } });
    await createAccount(A, { code: '6010', name: 'Taken in A', type: 'expense', subtype: 'operating_expenses' });
    const inB = await createAccount(B, { code: '', name: 'Auto in B', type: 'expense', subtype: 'operating_expenses' });
    expect(inB.code).not.toBe('6000');
    expect(inB.code).toBe('6010'); // A's 6010 does not count for B
    const inA = await createAccount(A, { code: '  ', name: 'Auto in A', type: 'expense', subtype: 'operating_expenses' });
    expect(inA.code).not.toBe('6010');
    const codes = (await listAccounts(A, { includeInactive: true })).map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('require account numbers is ignored while account numbers are turned off (QB greys it out)', async () => {
    await updateCompany(A, { settings: { accountNumbersEnabled: false, requireAccountNumbers: true } });
    const a = await createAccount(A, { code: '', name: 'No numbers mode', type: 'revenue', subtype: 'sales' });
    expect(a.code).toMatch(/^\d+$/);
    await updateCompany(A, { settings: { accountNumbersEnabled: true, requireAccountNumbers: false } });
  });

  it('BUG: reimbursed expenses (tracked as expense) with markup push the expense account below the cost', async () => {
    // QB: with "Track reimbursed expenses as income" off, the reimbursed COST nets the expense
    // account back to zero and the MARKUP goes to an income (markup) account. Here the whole
    // marked-up amount is credited to the expense account, so Office Supplies goes negative.
    await updateCompany(A, { settings: { trackReimbursedAsIncome: false } });
    const supplies = await createAccount(A, { code: '6390', name: 'Job Supplies', type: 'expense', subtype: 'operating_expenses' });
    const expense = await createExpense(A, {
      vendorId: vendorA,
      date: new Date('2026-03-06'),
      method: 'cash',
      paymentAccountId: acctA['1000'],
      lines: [{ accountId: supplies.id, description: 'Lumber', amount: '50.00', customerId: customerA }],
    });
    const [el] = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, expense.id));
    await createInvoiceWithBillables(
      A,
      { customerId: customerA, date: new Date('2026-03-07'), lines: [] },
      { expenseLineIds: [el.id], markupPercent: 20 },
    );
    const tb = await trialBalance(A);
    expect(tb.balanced).toBe(true);
    const row = tb.rows.find((r) => r.accountId === supplies.id);
    const net = row ? Number(row.debit) - Number(row.credit) : 0;
    expect(net.toFixed(2)).toBe('0.00'); // cost 50 billed back at cost; markup 10 is income
  });

  it('the setup interview never writes accounts.balance directly (balances come from postings)', async () => {
    const rows = await db
      .select({ name: accounts.name, balance: accounts.balance })
      .from(accounts)
      .where(eq(accounts.companyId, C.companyId));
    const added = rows.filter((r) => ['Partner Contributions', 'Partner Distributions', 'Job Materials', 'Subcontractors'].includes(r.name));
    expect(added.length).toBe(4);
    for (const r of added) expect(Number(r.balance ?? 0)).toBe(0);
  });
});
