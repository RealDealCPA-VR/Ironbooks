/**
 * List exports — QB Desktop "File > Utilities > Export > Lists" parity.
 *
 * Every list can leave the app in an open format (data-ownership promise):
 *   customers, vendors, items, accounts (chart of accounts), employees, classes, tax rates
 *   (sales tax items), terms (as used on customers / vendors), jobs, payroll items, customer
 *   types, vendor types, sales reps, workers' comp codes.
 *
 * Formats:
 *   csv  — RFC-4180 escaped, CRLF-terminated, UTF-8 BOM so Excel opens it correctly.
 *   xlsx — one worksheet (header row first, so the file re-imports through the Excel list
 *          import); `all` → one workbook with a sheet per list.
 *   iif  — QuickBooks IIF for the lists QuickBooks can read (lib/services/iifExport.ts);
 *          `all` → every IIF list in one file.
 *
 * Sensitive fields (SSN, password hashes, vendor tax id) are intentionally NOT exported to
 * CSV / Excel. (The IIF export writes them only for users allowed to see them in full.)
 */
import { asc, eq } from 'drizzle-orm';
import { csvMinimal } from '@/lib/csv';
import {
  accounts,
  classes,
  customerTypes,
  customers,
  employees,
  items,
  jobs,
  payrollItems,
  salesReps,
  taxAgencies,
  taxRates,
  vendorTypes,
  vendors,
  workersCompCodes,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { buildXlsx, buildXlsxWorkbook, type XlsxSheetInput } from '@/lib/export/xlsx';
import { validation, type ServiceContext } from './_base';
import { exportListsIif, type IifListName } from './iifExport';
import { apAging, arAging } from './reportsExtra';

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

export type ExportableList =
  | 'customers'
  | 'vendors'
  | 'items'
  | 'accounts'
  | 'employees'
  | 'classes'
  | 'tax_rates'
  | 'terms'
  | 'jobs'
  | 'payroll_items'
  | 'customer_types'
  | 'vendor_types'
  | 'sales_reps'
  | 'workers_comp_codes';

export const EXPORTABLE_LISTS: ExportableList[] = [
  'customers',
  'vendors',
  'items',
  'accounts',
  'employees',
  'classes',
  'tax_rates',
  'terms',
  'jobs',
  'payroll_items',
  'customer_types',
  'vendor_types',
  'sales_reps',
  'workers_comp_codes',
];

export const LIST_LABELS: Record<ExportableList, string> = {
  customers: 'Customers',
  vendors: 'Vendors',
  items: 'Items',
  accounts: 'Chart of Accounts',
  employees: 'Employees',
  classes: 'Classes',
  tax_rates: 'Sales Tax Items',
  terms: 'Terms',
  jobs: 'Jobs',
  payroll_items: 'Payroll Items',
  customer_types: 'Customer Types',
  vendor_types: 'Vendor Types',
  sales_reps: 'Sales Reps',
  workers_comp_codes: "Workers' Comp Codes",
};

/** Lists that have an IIF section (others export as CSV / Excel only). */
const IIF_SECTION: Partial<Record<ExportableList, IifListName>> = {
  customers: 'customers',
  vendors: 'vendors',
  items: 'items',
  accounts: 'accounts',
  employees: 'employees',
  classes: 'classes',
  customer_types: 'types',
  vendor_types: 'types',
  sales_reps: 'reps',
};

export type ExportFormat = 'csv' | 'xlsx' | 'iif';

/**
 * Escape a single CSV cell per RFC 4180 (quote when it contains , " or newlines), with
 * spreadsheet formula-injection protection (lib/csv.ts).
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return csvMinimal(typeof value === 'number' || typeof value === 'boolean' ? value : String(value));
}

/** Build a CSV document from a header row + data rows (CRLF lines, UTF-8 BOM). */
export function buildCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvEscape).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** "Every date" cut-off for the open balances on the customer / vendor lists. */
const ALL_DATES = new Date(Date.UTC(9999, 0, 1));

/** Aging report → open balance per customer / vendor id (2dp strings). */
function agingTotals(report: Awaited<ReturnType<typeof arAging>>): Map<string, string> {
  return new Map(report.rows.map((r) => [r.id, toAmountString(r.total)]));
}

function flattenAddress(addr: Record<string, string> | null | undefined): string {
  if (!addr) return '';
  const parts = [addr.line1 ?? addr.street, addr.line2, addr.city, addr.state, addr.zip, addr.country];
  return parts.filter(Boolean).join(', ');
}

interface Table {
  header: string[];
  rows: unknown[][];
}

const yn = (b: boolean | null | undefined) => (b ? 'Y' : 'N');

function pathOf<T extends { id: string; name: string; parentId: string | null }>(rows: T[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id: string | null | undefined): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = id ? byId.get(id) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(':');
  };
}

// ---------------------------------------------------------------------------
// Per-list tables
// ---------------------------------------------------------------------------

async function customersTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db
    .select()
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId))
    .orderBy(asc(customers.displayName));
  const types = await ctx.db.select().from(customerTypes).where(eq(customerTypes.companyId, ctx.companyId));
  const typePath = pathOf(types);
  const parentName = new Map(rows.map((c) => [c.id, c.displayName]));
  // customers.balance is not maintained by anything (it is always 0): the Balance column is each
  // customer's open A/R — the same figure as A/R aging (open invoices, unapplied credits and
  // payments, named General Journal lines), every date included like QB's Customer list.
  const balanceOf = agingTotals(await arAging(ctx, ALL_DATES));
  // The billing address goes out in its parts (street lines, city, state, ZIP, country), as in
  // QuickBooks' list export, so a list import can map each part back (a one-column address can't
  // be split again reliably).
  const bill = (c: (typeof rows)[number]) => {
    const a = (c.billingAddress ?? {}) as Record<string, string>;
    return [a.line1 ?? a.street ?? '', a.line2 ?? '', a.city ?? '', a.state ?? '', a.zip ?? a.postalCode ?? '', a.country ?? ''];
  };
  return {
    header: [
      'Name', 'Company', 'Email', 'Phone',
      'Billing Street 1', 'Billing Street 2', 'Billing City', 'Billing State', 'Billing ZIP', 'Billing Country',
      'Shipping Address', 'Terms', 'Credit Limit', 'Taxable', 'Customer Type', 'Parent', 'Balance', 'Notes', 'Active',
    ],
    rows: rows.map((c) => [
      c.displayName,
      c.companyName,
      c.email,
      c.phone,
      ...bill(c),
      flattenAddress(c.shippingAddress),
      c.terms,
      c.creditLimit ? toAmountString(c.creditLimit) : '',
      yn(c.taxable),
      typePath(c.customerTypeId),
      c.parentId ? parentName.get(c.parentId) ?? '' : '',
      balanceOf.get(c.id) ?? '0.00',
      c.notes,
      yn(c.isActive),
    ]),
  };
}

async function vendorsTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db
    .select()
    .from(vendors)
    .where(eq(vendors.companyId, ctx.companyId))
    .orderBy(asc(vendors.displayName));
  const types = await ctx.db.select().from(vendorTypes).where(eq(vendorTypes.companyId, ctx.companyId));
  const typePath = pathOf(types);
  // vendors.balance is never maintained (always 0): the Balance column is the vendor's open A/P.
  const balanceOf = agingTotals(await apAging(ctx, ALL_DATES));
  return {
    header: ['Name', 'Company', 'Email', 'Phone', 'Address', 'Terms', '1099 Vendor', 'Vendor Type', 'Balance', 'Notes', 'Active'],
    rows: rows.map((v) => [
      v.displayName,
      v.companyName,
      v.email,
      v.phone,
      flattenAddress(v.address),
      v.terms,
      yn(v.is1099),
      typePath(v.vendorTypeId),
      balanceOf.get(v.id) ?? '0.00',
      v.notes,
      yn(v.isActive),
    ]),
  };
}

async function itemsTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db.select().from(items).where(eq(items.companyId, ctx.companyId)).orderBy(asc(items.name));
  const acctRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const acctLabel = new Map(acctRows.map((a) => [a.id, `${a.code} ${a.name}`]));
  return {
    header: [
      'Name', 'SKU', 'Type', 'Description', 'Sales Price', 'Purchase Cost', 'Income Account',
      'Expense Account', 'Asset Account', 'Taxable', 'Qty On Hand', 'Reorder Point', 'Average Cost',
      'Unit of Measure', 'Active',
    ],
    rows: rows.map((i) => [
      i.name,
      i.sku,
      i.type,
      i.description,
      i.salesPrice ? toAmountString(i.salesPrice) : '',
      i.purchaseCost ? toAmountString(i.purchaseCost) : '',
      i.incomeAccountId ? acctLabel.get(i.incomeAccountId) ?? '' : '',
      i.expenseAccountId ? acctLabel.get(i.expenseAccountId) ?? '' : '',
      i.assetAccountId ? acctLabel.get(i.assetAccountId) ?? '' : '',
      yn(i.taxable),
      i.quantityOnHand ?? '',
      i.reorderPoint ?? '',
      i.averageCost ?? '',
      i.unitOfMeasure,
      yn(i.isActive),
    ]),
  };
}

async function accountsTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId)).orderBy(asc(accounts.code));
  const codeById = new Map(rows.map((a) => [a.id, a.code]));
  return {
    header: ['Code', 'Name', 'Type', 'Subtype', 'Parent Code', 'Balance', 'Description', 'Active'],
    rows: rows.map((a) => [
      a.code,
      a.name,
      a.type,
      a.subtype,
      a.parentId ? codeById.get(a.parentId) ?? '' : '',
      toAmountString(a.balance),
      a.description,
      yn(a.isActive),
    ]),
  };
}

async function employeesTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db
    .select()
    .from(employees)
    .where(eq(employees.companyId, ctx.companyId))
    .orderBy(asc(employees.lastName), asc(employees.firstName));
  return {
    header: ['First Name', 'Last Name', 'Email', 'Phone', 'Pay Type', 'Pay Rate', 'Address', 'Hire Date', 'Release Date', 'Active'],
    rows: rows.map((e) => [
      e.firstName,
      e.lastName,
      e.email,
      e.phone,
      e.payType,
      toAmountString(e.payRate),
      flattenAddress(e.address as Record<string, string> | null),
      e.hireDate ? e.hireDate.toISOString().slice(0, 10) : '',
      e.releaseDate ? e.releaseDate.toISOString().slice(0, 10) : '',
      yn(e.isActive),
    ]),
  };
}

async function classesTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db.select().from(classes).where(eq(classes.companyId, ctx.companyId));
  const p = pathOf(rows);
  return {
    header: ['Name', 'Full Name', 'Active'],
    rows: rows
      .map((c) => [c.name, p(c.id), yn(c.isActive)])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  };
}

async function taxRatesTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db.select().from(taxRates).where(eq(taxRates.companyId, ctx.companyId)).orderBy(asc(taxRates.name));
  const agencies = await ctx.db.select().from(taxAgencies).where(eq(taxAgencies.companyId, ctx.companyId));
  const agencyName = new Map(agencies.map((a) => [a.id, a.name]));
  return {
    header: ['Name', 'Rate %', 'Tax Agency', 'Active'],
    rows: rows.map((r) => [
      r.name,
      Money.of(r.rate).times(100).toDecimalPlaces(4).toString(),
      r.agencyId ? agencyName.get(r.agencyId) ?? '' : '',
      yn(r.isActive),
    ]),
  };
}

/** Terms are stored on customers / vendors (no Terms table yet): every distinct value + usage. */
async function termsTable(ctx: ServiceContext): Promise<Table> {
  const c = await ctx.db.select({ terms: customers.terms }).from(customers).where(eq(customers.companyId, ctx.companyId));
  const v = await ctx.db.select({ terms: vendors.terms }).from(vendors).where(eq(vendors.companyId, ctx.companyId));
  const counts = new Map<string, { customers: number; vendors: number }>();
  for (const r of c) if (r.terms) counts.set(r.terms, { ...(counts.get(r.terms) ?? { customers: 0, vendors: 0 }), customers: (counts.get(r.terms)?.customers ?? 0) + 1 });
  for (const r of v) if (r.terms) counts.set(r.terms, { ...(counts.get(r.terms) ?? { customers: 0, vendors: 0 }), vendors: (counts.get(r.terms)?.vendors ?? 0) + 1 });
  const due = (k: string) => {
    const m = /net_?(\d+)/.exec(k);
    return m ? m[1] : k === 'due_on_receipt' ? '0' : '';
  };
  return {
    header: ['Terms', 'Net Due In Days', 'Customers Using', 'Vendors Using'],
    rows: [...counts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, n]) => [k, due(k), n.customers, n.vendors]),
  };
}

async function jobsTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db.select().from(jobs).where(eq(jobs.companyId, ctx.companyId)).orderBy(asc(jobs.name));
  const custs = await ctx.db
    .select({ id: customers.id, name: customers.displayName })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const custName = new Map(custs.map((c) => [c.id, c.name]));
  return {
    header: ['Customer', 'Job', 'Status', 'Budget', 'Start Date', 'End Date', 'Active'],
    rows: rows.map((j) => [
      j.customerId ? custName.get(j.customerId) ?? '' : '',
      j.name,
      j.status,
      j.budget ? toAmountString(j.budget) : '',
      j.startDate ? j.startDate.toISOString().slice(0, 10) : '',
      j.endDate ? j.endDate.toISOString().slice(0, 10) : '',
      yn(j.isActive),
    ]),
  };
}

async function payrollItemsTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db
    .select()
    .from(payrollItems)
    .where(eq(payrollItems.companyId, ctx.companyId))
    .orderBy(asc(payrollItems.kind), asc(payrollItems.name));
  const acctRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const acctLabel = new Map(acctRows.map((a) => [a.id, `${a.code} ${a.name}`]));
  return {
    header: ['Name', 'Kind', 'Pre-tax', 'Expense Account', 'Liability Account', 'Calculation', 'Default Rate', 'Active'],
    rows: rows.map((p) => [
      p.name,
      p.kind,
      yn(p.pretax),
      p.expenseAccountId ? acctLabel.get(p.expenseAccountId) ?? '' : '',
      p.liabilityAccountId ? acctLabel.get(p.liabilityAccountId) ?? '' : '',
      p.calcBasis ?? '',
      p.defaultRate ?? '',
      yn(p.isActive),
    ]),
  };
}

async function typeTable(ctx: ServiceContext, kind: 'customer' | 'vendor'): Promise<Table> {
  const table = kind === 'customer' ? customerTypes : vendorTypes;
  const rows = await ctx.db.select().from(table).where(eq(table.companyId, ctx.companyId));
  const p = pathOf(rows);
  return {
    header: ['Name', 'Full Name', 'Active'],
    rows: rows.map((t) => [t.name, p(t.id), yn(t.isActive)]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  };
}

async function salesRepsTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db.select().from(salesReps).where(eq(salesReps.companyId, ctx.companyId)).orderBy(asc(salesReps.name));
  return {
    header: ['Name', 'Email', 'Commission %', 'Active'],
    rows: rows.map((r) => [r.name, r.email, Money.of(r.commissionRate).times(100).toDecimalPlaces(4).toString(), yn(r.isActive)]),
  };
}

async function workersCompTable(ctx: ServiceContext): Promise<Table> {
  const rows = await ctx.db
    .select()
    .from(workersCompCodes)
    .where(eq(workersCompCodes.companyId, ctx.companyId))
    .orderBy(asc(workersCompCodes.code));
  return {
    header: ['Code', 'Description', 'Rate per $100', 'Active'],
    rows: rows.map((r) => [r.code, r.description, r.ratePer100, yn(r.isActive)]),
  };
}

async function tableFor(ctx: ServiceContext, list: ExportableList): Promise<Table> {
  switch (list) {
    case 'customers': return customersTable(ctx);
    case 'vendors': return vendorsTable(ctx);
    case 'items': return itemsTable(ctx);
    case 'accounts': return accountsTable(ctx);
    case 'employees': return employeesTable(ctx);
    case 'classes': return classesTable(ctx);
    case 'tax_rates': return taxRatesTable(ctx);
    case 'terms': return termsTable(ctx);
    case 'jobs': return jobsTable(ctx);
    case 'payroll_items': return payrollItemsTable(ctx);
    case 'customer_types': return typeTable(ctx, 'customer');
    case 'vendor_types': return typeTable(ctx, 'vendor');
    case 'sales_reps': return salesRepsTable(ctx);
    case 'workers_comp_codes': return workersCompTable(ctx);
  }
}

const FILE_BASE: Partial<Record<ExportableList, string>> = { accounts: 'chart-of-accounts' };

function assertList(list: string): asserts list is ExportableList {
  if (!EXPORTABLE_LISTS.includes(list as ExportableList)) {
    throw validation(`Unknown list "${list}". Exportable lists: ${EXPORTABLE_LISTS.join(', ')}, all.`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export one of the lists to CSV. Throws VALIDATION on an unknown list name. Returns the
 * suggested download filename alongside the CSV body.
 */
export async function exportListCsv(ctx: ServiceContext, list: string): Promise<{ filename: string; csv: string }> {
  assertList(list);
  const today = new Date().toISOString().slice(0, 10);
  const t = await tableFor(ctx, list);
  return {
    filename: `${FILE_BASE[list] ?? list.replace(/_/g, '-')}-${today}.csv`,
    csv: buildCsv(t.header, t.rows),
  };
}

export interface ExportedFile {
  filename: string;
  contentType: string;
  body: string | Buffer;
}

const toXlsxSheet = (list: ExportableList, t: Table): XlsxSheetInput => ({
  sheetName: LIST_LABELS[list],
  columns: t.header.map((h) => ({ header: h })),
  rows: t.rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : typeof c === 'number' ? c : String(c)))),
});

/**
 * Export a list (or `all`) as csv / xlsx / iif. IIF is available for the lists QuickBooks can
 * read; `all` + iif writes every IIF list, `all` + xlsx a workbook with one sheet per list.
 */
export async function exportList(ctx: ServiceContext, list: string, format: ExportFormat = 'csv'): Promise<ExportedFile> {
  const today = new Date().toISOString().slice(0, 10);
  if (!['csv', 'xlsx', 'iif'].includes(format)) throw validation('Format must be csv, xlsx or iif.');

  if (list === 'all') {
    if (format === 'csv') throw validation('Choose Excel or IIF to export every list in one file.');
    if (format === 'iif') {
      return { filename: `all-lists-${today}.iif`, contentType: 'text/plain; charset=utf-8', body: await exportListsIif(ctx) };
    }
    const sheets: XlsxSheetInput[] = [];
    for (const l of EXPORTABLE_LISTS) sheets.push(toXlsxSheet(l, await tableFor(ctx, l)));
    return {
      filename: `all-lists-${today}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: buildXlsxWorkbook(sheets),
    };
  }

  assertList(list);
  const base = `${FILE_BASE[list] ?? list.replace(/_/g, '-')}-${today}`;
  if (format === 'iif') {
    const section = IIF_SECTION[list];
    if (!section) throw validation(`${LIST_LABELS[list]} cannot be exported to IIF. Choose CSV or Excel.`);
    return { filename: `${base}.iif`, contentType: 'text/plain; charset=utf-8', body: await exportListsIif(ctx, [section]) };
  }
  const t = await tableFor(ctx, list);
  if (format === 'xlsx') {
    return {
      filename: `${base}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: buildXlsx(toXlsxSheet(list, t)),
    };
  }
  return { filename: `${base}.csv`, contentType: 'text/csv; charset=utf-8', body: buildCsv(t.header, t.rows) };
}
