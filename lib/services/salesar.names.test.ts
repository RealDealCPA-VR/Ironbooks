/**
 * Team salesar, sub-builder "names":
 *  B18  Sales tax items: create (unique name, own agency), rename, re-rate (saved documents keep
 *       their tax), set the agency, make inactive (left out of the new-form pick-list) / active.
 *  B10  Notes on employees (service + route, guarded by the Employees & Payroll area).
 *  B4   Customer / Vendor / Job Type on the name forms (company-scoped, inactive refused) and the
 *       type filters of the customer, vendor and job reports.
 *  OB   Opening Balance on New Customer / New Vendor: an invoice / bill dated the as-of day on
 *       Uncategorized Income / Expenses, in one transaction with the name.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, creditMemos, customers, invoiceLines, invoices, jobs, users, vendors } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createCustomer, updateCustomer } from './customers';
import { createVendor, updateVendor } from './vendors';
import { createJob, updateJob } from './jobs';
import { createType, updateType } from './typeLists';
import { createEntry, updateEntry } from './lists/simpleLists';
import { createTaxAgency, createTaxRate, getTaxRate, listTaxRates, updateTaxRate } from './salesTax';
import { createInvoice, getInvoice } from './invoices';
import { createBill } from './bills';
import { commitUndo, performUndo } from './undo';
import { addNote, listNotes } from './lists/notes';
import { runStandardReport } from './reportRegistry';
import { reportFilterOptions } from './reportsAnalysis';
import { createEmployee } from './payroll';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { GET as taxRatesGET, POST as taxRatesPOST } from '@/app/api/tax-rates/route';
import { PATCH as taxRatePATCH } from '@/app/api/tax-rates/[id]/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { PATCH as vendorPATCH } from '@/app/api/vendors/[id]/route';
import { POST as vendorsPOST } from '@/app/api/vendors/route';
import { PATCH as jobPATCH } from '@/app/api/jobs/[id]/route';
import { GET as notesGET, POST as notesPOST } from '@/app/api/notes/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-names');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function req(url: string, method = 'GET', body?: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Labels of a report's data rows. */
const labels = (r: StdReport) => r.rows.filter((x) => x.kind === 'data' || x.kind === 'section').map((x) => String(x.cells.label ?? ''));
const grand = (r: StdReport, key: string) => String(r.rows.find((x) => x.kind === 'grand')?.cells[key] ?? '');

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-names@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar Names ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

async function otherCompanyCtx(): Promise<ServiceContext> {
  const other = await createCompany(db, { name: `Other ${seq}`, ownerId: userId });
  return { db, companyId: other.id, userId };
}

// ===========================================================================
describe('B18. Sales tax items', () => {
  it('creates an item with its agency; names are unique in the company (any case)', async () => {
    const agency = await createTaxAgency(ctx, { name: 'State Comptroller' });
    const item = await createTaxRate(ctx, { name: 'State Tax', rate: '0.0625', agencyId: agency.id });
    expect(item).toMatchObject({ name: 'State Tax', rate: '0.062500', agencyId: agency.id, isActive: true });
    await expect(createTaxRate(ctx, { name: '  state tax ', rate: '0.05' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Another company may use the same name.
    const other = await otherCompanyCtx();
    await expect(createTaxRate(other, { name: 'State Tax', rate: '0.05' })).resolves.toMatchObject({ name: 'State Tax' });
  });

  it("refuses another company's agency, and a duplicate agency name", async () => {
    const other = await otherCompanyCtx();
    const theirs = await createTaxAgency(other, { name: 'Their Agency' });
    await expect(createTaxRate(ctx, { name: 'X', rate: '0.01', agencyId: theirs.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const mine = await createTaxRate(ctx, { name: 'Y', rate: '0.01' });
    await expect(updateTaxRate(ctx, mine.id, { agencyId: theirs.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await createTaxAgency(ctx, { name: 'County' });
    await expect(createTaxAgency(ctx, { name: 'county' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('renames (refusing a name in use), sets the agency, inactivates and reactivates', async () => {
    const a = await createTaxRate(ctx, { name: 'City', rate: '0.01' });
    await createTaxRate(ctx, { name: 'County', rate: '0.02' });
    await expect(updateTaxRate(ctx, a.id, { name: 'COUNTY' })).rejects.toMatchObject({ code: 'VALIDATION' });
    // Same name in another case is a rename of itself, not a clash.
    await expect(updateTaxRate(ctx, a.id, { name: 'CITY' })).resolves.toMatchObject({ name: 'CITY' });
    const agency = await createTaxAgency(ctx, { name: 'City Treasurer' });
    expect((await updateTaxRate(ctx, a.id, { name: 'City Tax', agencyId: agency.id })).agencyId).toBe(agency.id);

    await updateTaxRate(ctx, a.id, { isActive: false });
    expect((await listTaxRates(ctx)).map((r) => r.id)).not.toContain(a.id); // new forms' pick-list
    expect((await listTaxRates(ctx, { includeInactive: true })).map((r) => r.id)).toContain(a.id);
    await updateTaxRate(ctx, a.id, { isActive: true });
    expect((await listTaxRates(ctx)).map((r) => r.id)).toContain(a.id);
  });

  it('a new rate applies to new sales; a saved invoice keeps the tax it was saved with', async () => {
    const rate = await createTaxRate(ctx, { name: 'Sales Tax', rate: '0.10' });
    const cust = await createCustomer(ctx, { displayName: `Taxed ${seq}` });
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-01'),
      taxRateId: rate.id,
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '100.00', taxable: true }],
    });
    expect(inv.taxAmount).toBe('10.00');
    await updateTaxRate(ctx, rate.id, { rate: '0.20' });
    expect((await getInvoice(ctx, inv.id)).taxAmount).toBe('10.00');
    const next = await createInvoice(ctx, {
      customerId: cust.id,
      date: d('2026-03-02'),
      taxRateId: rate.id,
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '100.00', taxable: true }],
    });
    expect(next.taxAmount).toBe('20.00');
  });

  it('routes: POST validates and creates, PATCH renames / inactivates, GET lists active (or all)', async () => {
    expect((await taxRatesPOST(req('/api/tax-rates', 'POST', { name: 'No rate' }))).status).toBe(400);
    expect((await taxRatesPOST(req('/api/tax-rates', 'POST', { name: 'Bad', rate: '1.5' }))).status).toBe(400);
    const res = await taxRatesPOST(req('/api/tax-rates', 'POST', { name: 'Route Tax', rate: '0.07' }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    expect((await taxRatesPOST(req('/api/tax-rates', 'POST', { name: 'route tax', rate: '0.07' }))).status).toBe(400);
    const patched = await taxRatePATCH(req(`/api/tax-rates/${created.id}`, 'PATCH', { name: 'Route Tax 2', isActive: false }), params(created.id));
    expect(patched.status).toBe(200);
    expect(await getTaxRate(ctx, created.id)).toMatchObject({ name: 'Route Tax 2', isActive: false });
    const active = (await (await taxRatesGET(req('/api/tax-rates'))).json()) as Array<{ id: string }>;
    expect(active.map((r) => r.id)).not.toContain(created.id);
    const all = (await (await taxRatesGET(req('/api/tax-rates?includeInactive=true'))).json()) as Array<{ id: string }>;
    expect(all.map((r) => r.id)).toContain(created.id);
  });
});

// ===========================================================================
describe('B10. Notes on employees', () => {
  async function employee() {
    return createEmployee(ctx, { firstName: 'Pat', lastName: `Lee ${seq}`, payType: 'hourly', payRate: '20.00' } as never);
  }

  it('adds and lists dated notes on an employee (service and route)', async () => {
    const emp = await employee();
    await addNote(ctx, { entityType: 'employee', entityId: emp.id, body: 'Asked for Fridays off', noteDate: '2026-04-02' });
    const res = await notesPOST(req('/api/notes', 'POST', { entityType: 'employee', entityId: emp.id, body: 'Review in June' }));
    expect(res.status).toBe(201);
    const listed = await listNotes(ctx, 'employee', emp.id);
    expect(listed.map((n) => n.body).sort()).toEqual(['Asked for Fridays off', 'Review in June']);
    const got = (await (await notesGET(req(`/api/notes?entityType=employee&entityId=${emp.id}`))).json()) as { notes: unknown[] };
    expect(got.notes).toHaveLength(2);
  });

  it('needs the Employees & Payroll area, and the employee must be in the company', async () => {
    const emp = await employee();
    const noPayroll = fullAccess();
    noPayroll.permissions.payroll = [];
    routeCtx = { ...ctx, access: noPayroll };
    expect((await notesPOST(req('/api/notes', 'POST', { entityType: 'employee', entityId: emp.id, body: 'x' }))).status).toBe(403);
    expect((await notesGET(req(`/api/notes?entityType=employee&entityId=${emp.id}`))).status).toBe(403);
    routeCtx = ctx;
    const other = await otherCompanyCtx();
    await expect(addNote(other, { entityType: 'employee', entityId: emp.id, body: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ===========================================================================
describe('B4. Customer / Vendor / Job Types on the forms', () => {
  it('customer type: set on create and edit; another company\'s or an inactive type is refused', async () => {
    const retail = await createType(ctx, 'customer', { name: 'Retail' });
    const wholesale = await createType(ctx, 'customer', { name: 'Wholesale' });
    const c = await createCustomer(ctx, { displayName: `Typed ${seq}`, customerTypeId: retail.id });
    expect(c.customerTypeId).toBe(retail.id);
    expect((await updateCustomer(ctx, c.id, { customerTypeId: wholesale.id })).customerTypeId).toBe(wholesale.id);
    expect((await updateCustomer(ctx, c.id, { customerTypeId: null })).customerTypeId).toBeNull();

    const other = await otherCompanyCtx();
    const theirs = await createType(other, 'customer', { name: 'Theirs' });
    await expect(createCustomer(ctx, { displayName: `Bad ${seq}`, customerTypeId: theirs.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await db.select().from(customers).where(eq(customers.displayName, `Bad ${seq}`))).toHaveLength(0);

    // Inactive: cannot be newly picked, but a customer that has it keeps it on other edits.
    await updateCustomer(ctx, c.id, { customerTypeId: retail.id });
    await updateType(ctx, 'customer', retail.id, { name: 'Retail', isActive: false });
    await expect(createCustomer(ctx, { displayName: `New ${seq}`, customerTypeId: retail.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateCustomer(ctx, c.id, { customerTypeId: retail.id, phone: '555' })).resolves.toMatchObject({ customerTypeId: retail.id, phone: '555' });
  });

  it('vendor type through the vendor routes (create and PATCH)', async () => {
    const sup = await createType(ctx, 'vendor', { name: 'Suppliers' });
    const res = await vendorsPOST(req('/api/vendors', 'POST', { displayName: `Acme Supply ${seq}`, vendorTypeId: sup.id }));
    expect(res.status).toBe(201);
    const v = (await res.json()) as { id: string; vendorTypeId: string };
    expect(v.vendorTypeId).toBe(sup.id);
    const cleared = await vendorPATCH(req(`/api/vendors/${v.id}`, 'PATCH', { vendorTypeId: null }), params(v.id));
    expect(cleared.status).toBe(200);
    const [row] = await db.select().from(vendors).where(eq(vendors.id, v.id));
    expect(row.vendorTypeId).toBeNull();
    const other = await otherCompanyCtx();
    const theirs = await createType(other, 'vendor', { name: 'Theirs' });
    expect((await vendorPATCH(req(`/api/vendors/${v.id}`, 'PATCH', { vendorTypeId: theirs.id }), params(v.id))).status).toBe(400);
    await expect(updateVendor(ctx, v.id, { vendorTypeId: sup.id })).resolves.toMatchObject({ vendorTypeId: sup.id });
  });

  it('job type on new and edited jobs (service and route)', async () => {
    const repair = await createEntry(ctx, 'job-types', { name: 'Repair' });
    const build = await createEntry(ctx, 'job-types', { name: 'New Construction' });
    const job = await createJob(ctx, { name: 'Fix roof', jobTypeId: String(repair.id) });
    expect(job.jobTypeId).toBe(repair.id);
    expect((await updateJob(ctx, job.id, { jobTypeId: String(build.id) })).jobTypeId).toBe(build.id);
    const res = await jobPATCH(req(`/api/jobs/${job.id}`, 'PATCH', { jobTypeId: null }), params(job.id));
    expect(res.status).toBe(200);
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].jobTypeId).toBeNull();
    await updateEntry(ctx, 'job-types', String(repair.id), { name: 'Repair', isActive: false });
    await expect(createJob(ctx, { name: 'Another', jobTypeId: String(repair.id) })).rejects.toMatchObject({ code: 'VALIDATION' });
    const other = await otherCompanyCtx();
    const theirs = await createEntry(other, 'job-types', { name: 'Theirs' });
    await expect(updateJob(ctx, job.id, { jobTypeId: String(theirs.id) })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ===========================================================================
describe('B4. Type filters on the customer, vendor and job reports', () => {
  async function arFixture() {
    const retail = await createType(ctx, 'customer', { name: 'Retail' });
    const online = await createType(ctx, 'customer', { name: 'Online', parentId: retail.id });
    const wholesale = await createType(ctx, 'customer', { name: 'Wholesale' });
    const shop = await createCustomer(ctx, { displayName: 'Shop', customerTypeId: retail.id });
    const shopJob = await createCustomer(ctx, { displayName: 'Shop Job', parentId: shop.id }); // inherits Retail
    const web = await createCustomer(ctx, { displayName: 'Web', customerTypeId: online.id }); // subtype
    const big = await createCustomer(ctx, { displayName: 'Big', customerTypeId: wholesale.id });
    const none = await createCustomer(ctx, { displayName: 'Plain' });
    const sell = (customerId: string, amount: string) =>
      createInvoice(ctx, { customerId, date: d('2026-05-01'), lines: [{ accountId: acct['4000'], description: 'Sale', quantity: 1, rate: amount, taxable: false }] });
    await sell(shop.id, '100.00');
    await sell(shopJob.id, '20.00');
    await sell(web.id, '30.00');
    await sell(big.id, '500.00');
    await sell(none.id, '7.00');
    return { retail, online, wholesale };
  }

  it('A/R aging, open invoices, customer balance and sales by customer keep the type, its subtypes and jobs', async () => {
    const { retail, wholesale } = await arFixture();
    const p = { asOf: '2026-06-30', customerTypeId: retail.id };
    const aging = await runStandardReport(ctx, 'ar-aging-summary', p);
    expect(grand(aging, 'total')).toBe('150.00');
    expect(labels(aging).join('|')).not.toMatch(/Big|Plain/);
    expect(aging.subtitle).toContain('Customer Type: Retail');
    const detail = await runStandardReport(ctx, 'ar-aging-detail', p);
    expect(labels(detail).join('|')).not.toMatch(/Big|Plain/);
    const open = await runStandardReport(ctx, 'open-invoices', { asOf: '2026-06-30', customerTypeId: wholesale.id });
    expect(labels(open).join('|')).toMatch(/Big/);
    expect(labels(open).join('|')).not.toMatch(/Shop|Web/);

    const bal = await runStandardReport(ctx, 'customer-balance-summary', p);
    expect(grand(bal, 'balance')).toBe('150.00');
    const balDetail = await runStandardReport(ctx, 'customer-balance-detail', { to: '2026-06-30', customerTypeId: wholesale.id });
    expect(labels(balDetail).join('|')).toMatch(/Big/);
    expect(labels(balDetail).join('|')).not.toMatch(/Shop|Web|Plain/);

    const sales = await runStandardReport(ctx, 'sales-by-customer-summary', { from: '2026-01-01', to: '2026-12-31', customerTypeId: retail.id });
    expect(labels(sales).join('|')).not.toMatch(/Big|Plain/);
    expect(labels(sales).join('|')).toMatch(/Web/);
    const salesDetail = await runStandardReport(ctx, 'sales-by-customer-detail', { from: '2026-01-01', to: '2026-12-31', customerTypeId: wholesale.id });
    expect(labels(salesDetail).join('|')).toMatch(/Big/);
    expect(labels(salesDetail).join('|')).not.toMatch(/Shop|Web|Plain/);

    // Without the filter every customer is there (back-compat).
    expect(grand(await runStandardReport(ctx, 'ar-aging-summary', { asOf: '2026-06-30' }), 'total')).toBe('657.00');
  });

  it("another company's type matches nothing", async () => {
    await arFixture();
    const other = await otherCompanyCtx();
    const theirs = await createType(other, 'customer', { name: 'Retail' });
    const r = await runStandardReport(ctx, 'ar-aging-summary', { asOf: '2026-06-30', customerTypeId: theirs.id });
    expect(grand(r, 'total')).toBe('0.00');
  });

  it('A/P aging, vendor balance and unpaid bills keep the vendor type', async () => {
    const sup = await createType(ctx, 'vendor', { name: 'Suppliers' });
    const util = await createType(ctx, 'vendor', { name: 'Utilities' });
    const a = await createVendor(ctx, { displayName: 'Lumber Co', vendorTypeId: sup.id });
    const b = await createVendor(ctx, { displayName: 'Power Co', vendorTypeId: util.id });
    const bill = (vendorId: string, amount: string) =>
      createBill(ctx, { vendorId, date: d('2026-05-01'), lines: [{ accountId: acct['6600'], description: 'x', amount }] });
    await bill(a.id, '300.00');
    await bill(b.id, '45.00');
    const p = { asOf: '2026-06-30', vendorTypeId: sup.id };
    const aging = await runStandardReport(ctx, 'ap-aging-summary', p);
    expect(grand(aging, 'total')).toBe('300.00');
    expect(aging.subtitle).toContain('Vendor Type: Suppliers');
    expect(labels(await runStandardReport(ctx, 'ap-aging-detail', p)).join('|')).not.toMatch(/Power/);
    expect(grand(await runStandardReport(ctx, 'vendor-balance-summary', p), 'balance')).toBe('300.00');
    const vbd = await runStandardReport(ctx, 'vendor-balance-detail', { to: '2026-06-30', vendorTypeId: util.id });
    expect(labels(vbd).join('|')).toMatch(/Power/);
    expect(labels(vbd).join('|')).not.toMatch(/Lumber/);
    expect(grand(await runStandardReport(ctx, 'unpaid-bills-detail', { asOf: '2026-06-30', vendorTypeId: util.id }), 'open')).toBe('45.00');
  });

  it('job profitability and estimates vs actuals keep the job type', async () => {
    const repair = await createEntry(ctx, 'job-types', { name: 'Repair' });
    const roofing = await createEntry(ctx, 'job-types', { name: 'Roofing', parentId: String(repair.id) });
    const build = await createEntry(ctx, 'job-types', { name: 'New Construction' });
    const cust = await createCustomer(ctx, { displayName: 'Owner' });
    const j1 = await createJob(ctx, { name: 'Fix porch', customerId: cust.id, jobTypeId: String(repair.id) });
    const j2 = await createJob(ctx, { name: 'Roof', customerId: cust.id, jobTypeId: String(roofing.id) });
    const j3 = await createJob(ctx, { name: 'House', customerId: cust.id, jobTypeId: String(build.id) });
    for (const [jobId, amount] of [[j1.id, '100.00'], [j2.id, '200.00'], [j3.id, '5000.00']] as const) {
      await createInvoice(ctx, { customerId: cust.id, jobId, date: d('2026-05-01'), lines: [{ accountId: acct['4000'], description: 'Job', quantity: 1, rate: amount, taxable: false }] });
    }
    const sum = await runStandardReport(ctx, 'job-profitability-summary', { jobTypeId: String(repair.id) });
    expect(grand(sum, 'revenue')).toBe('300.00');
    expect(labels(sum).join('|')).not.toMatch(/House/);
    expect(sum.subtitle).toContain('Job Type: Repair');
    const det = await runStandardReport(ctx, 'job-profitability-detail', { jobTypeId: String(build.id) });
    expect(grand(det, 'revenue')).toBe('5000.00');
    const eva = await runStandardReport(ctx, 'job-estimates-vs-actuals', { jobTypeId: String(repair.id) });
    expect(grand(eva, 'rev')).toBe('300.00');
    expect(grand(await runStandardReport(ctx, 'job-profitability-summary', {}), 'revenue')).toBe('5300.00');
  });

  it('the filter pickers list the three type lists with Parent:Child names', async () => {
    const retail = await createType(ctx, 'customer', { name: 'Retail' });
    await createType(ctx, 'customer', { name: 'Online', parentId: retail.id });
    await createType(ctx, 'vendor', { name: 'Suppliers' });
    await createEntry(ctx, 'job-types', { name: 'Repair' });
    const o = await reportFilterOptions(ctx);
    expect(o.customerTypes.map((t) => t.name)).toEqual(['Retail', 'Retail:Online']);
    expect(o.vendorTypes.map((t) => t.name)).toEqual(['Suppliers']);
    expect(o.jobTypes.map((t) => t.name)).toContain('Repair');
  });
});

// ===========================================================================
describe('Opening Balance on New Customer / New Vendor', () => {
  const incomeAccount = async (name: string) =>
    (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, name))))[0];

  it('a customer opening balance is an invoice dated the as-of day on Uncategorized Income', async () => {
    const c = await createCustomer(ctx, { displayName: `Opening ${seq}`, openingBalance: '1250.00', openingBalanceDate: '2026-01-15' });
    expect(c.openingBalanceDoc).toMatchObject({ kind: 'invoice', amount: '1250.00', date: '2026-01-15' });
    const [inv] = await db.select().from(invoices).where(eq(invoices.customerId, c.id));
    expect(inv.total).toBe('1250.00');
    expect(inv.taxAmount).toBe('0.00');
    expect(inv.date.toISOString().slice(0, 10)).toBe('2026-01-15');
    const acc = await incomeAccount('Uncategorized Income');
    expect(acc).toMatchObject({ type: 'revenue' });
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect(lines.map((l) => l.accountId)).toEqual([acc.id]);
    // On A/R aging and the customer's balance.
    const aging = await runStandardReport(ctx, 'ar-aging-summary', { asOf: '2026-02-28' });
    expect(grand(aging, 'total')).toBe('1250.00');
    // A second one reuses the account.
    await createCustomer(ctx, { displayName: `Opening B ${seq}`, openingBalance: '10', openingBalanceDate: '2026-01-15' });
    expect(await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Uncategorized Income')))).toHaveLength(1);
  });

  it('a negative customer opening balance is a credit memo; blank or zero posts nothing', async () => {
    const c = await createCustomer(ctx, { displayName: `Credit ${seq}`, openingBalance: '-40.00', openingBalanceDate: '2026-02-01' });
    expect(c.openingBalanceDoc).toMatchObject({ kind: 'credit_memo', amount: '-40.00' });
    const [memo] = await db.select().from(creditMemos).where(eq(creditMemos.customerId, c.id));
    expect(memo.total).toBe('40.00');
    const z = await createCustomer(ctx, { displayName: `Zero ${seq}`, openingBalance: '0' });
    expect(z.openingBalanceDoc).toBeUndefined();
    expect(await db.select().from(invoices).where(eq(invoices.customerId, z.id))).toHaveLength(0);
  });

  it('a posting the closing date refuses does not create the customer either', async () => {
    await setClosingDate(ctx, { closingDate: '2026-03-31', password: 'secret-close' });
    await expect(
      createCustomer(ctx, { displayName: `Closed ${seq}`, openingBalance: '99.00', openingBalanceDate: '2026-01-10' }),
    ).rejects.toBeTruthy();
    expect(await db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, `Closed ${seq}`)))).toHaveLength(0);
    // After the closing date it is fine.
    await expect(createCustomer(ctx, { displayName: `Open ${seq}`, openingBalance: '99.00', openingBalanceDate: '2026-04-10' })).resolves.toBeTruthy();
  });

  it('a vendor opening balance is a bill on Uncategorized Expenses (default date: the company today)', async () => {
    const v = await createVendor(ctx, { displayName: `Owed ${seq}`, openingBalance: '300.50' });
    expect(v.openingBalanceDoc).toMatchObject({ kind: 'bill', amount: '300.50' });
    const [bill] = await db.select().from(bills).where(eq(bills.vendorId, v.id));
    expect(bill.total).toBe('300.50');
    expect(bill.date.toISOString().slice(11)).toBe('00:00:00.000Z');
    expect(await incomeAccount('Uncategorized Expenses')).toMatchObject({ type: 'expense' });
    const ap = await runStandardReport(ctx, 'vendor-balance-summary', {});
    expect(grand(ap, 'balance')).toBe('300.50');
  });

  it('routes: POST /api/customers and /api/vendors take openingBalance + openingBalanceDate; edits ignore them', async () => {
    const res = await customersPOST(req('/api/customers', 'POST', { displayName: `Route ${seq}`, openingBalance: '75.25', openingBalanceDate: '2026-03-05' }));
    expect(res.status).toBe(201);
    const c = (await res.json()) as { id: string };
    expect((await db.select().from(invoices).where(eq(invoices.customerId, c.id)))[0].total).toBe('75.25');
    expect((await customersPOST(req('/api/customers', 'POST', { displayName: `Bad ${seq}`, openingBalance: '1.234' }))).status).toBe(400);
    const vres = await vendorsPOST(req('/api/vendors', 'POST', { displayName: `RouteV ${seq}`, openingBalance: '12.00', openingBalanceDate: '2026-03-05' }));
    expect(vres.status).toBe(201);
    const v = (await vres.json()) as { id: string };
    expect((await db.select().from(bills).where(eq(bills.vendorId, v.id)))[0].total).toBe('12.00');
    // PATCH has no opening balance: it is dropped, nothing is posted.
    await vendorPATCH(req(`/api/vendors/${v.id}`, 'PATCH', { openingBalance: '500.00', phone: '1' }), params(v.id));
    expect(await db.select().from(bills).where(eq(bills.vendorId, v.id))).toHaveLength(1);
  });

  it('Undo of a New Customer / New Vendor voids its Opening Balance document, so A/R and A/P go back too', async () => {
    const undoCreate = async (resource: string, id: string) => {
      const armed = await commitUndo(ctx, { resource, kind: 'create', id });
      return performUndo(ctx, armed.token);
    };
    const c = await createCustomer(ctx, { displayName: `Undo open ${seq}`, openingBalance: '300.00', openingBalanceDate: '2026-01-15' });
    await undoCreate('customers', c.id);
    const [inv] = await db.select().from(invoices).where(eq(invoices.customerId, c.id));
    expect(inv.status).toBe('void');
    expect((await db.select().from(customers).where(eq(customers.id, c.id)))[0].isActive).toBe(false);
    const cc = await createCustomer(ctx, { displayName: `Undo credit ${seq}`, openingBalance: '-20.00', openingBalanceDate: '2026-01-15' });
    await undoCreate('customers', cc.id);
    expect((await db.select().from(creditMemos).where(eq(creditMemos.customerId, cc.id)))[0].status).toBe('void');
    const v = await createVendor(ctx, { displayName: `Undo vendor ${seq}`, openingBalance: '80.00', openingBalanceDate: '2026-01-15' } as never);
    await undoCreate('vendors', v.id);
    expect((await db.select().from(bills).where(eq(bills.vendorId, v.id)))[0].status).toBe('void');
    expect((await db.select().from(vendors).where(eq(vendors.id, v.id)))[0].isActive).toBe(false);
    const aging = await runStandardReport(ctx, 'ar-aging-summary', { asOf: '2026-02-28' });
    expect(grand(aging, 'total')).toBe('0.00');
  });
});
