/**
 * QuickBooks import helpers.
 *
 * Supports:
 *   - IIF (Intuit Interchange Format) — tab-delimited; header rows start with '!',
 *     data rows follow until the next header or end of file.
 *     parseIIF()  – pure parse, returns normalized objects (every row also keeps `raw`).
 *     importIIF() – parse then insert via existing services; skips duplicates.
 *     Sections:
 *       ACCNT    — full "Parent:Sub" hierarchy: parents are created first and every account
 *                  is matched by its FULL PATH (never by leaf name when leaves collide).
 *       CUST     — ship-to / bill-to addresses, terms, taxable + tax item, credit limit, CTYPE,
 *                  REP, price level, HIDDEN (inactive), contacts, CUSTFLD1-15 (labels from
 *                  CUSTNAMEDICT); "Customer:Job" → parent customer + sub-customer + job.
 *       VEND     — address, terms, VTYPE, 1099 flag, TAXID, credit limit, contacts, HIDDEN,
 *                  custom fields.
 *       EMP      — name parts, address, SSN (stored normalized, masked on output like the
 *                  employees service), hire/release dates, phone, pay type + rate, W-4 data.
 *       CLASS    — "Parent:Sub" class hierarchy.
 *       INVITEM  — every QB item type mapped to its own item type (service, inventory part,
 *                  inventory assembly, non-inventory, other charge, discount, payment, sales tax
 *                  item / group, group, subtotal); group components and assembly BOMs from
 *                  INVITEMCOMP rows when present; STAX items also create sales-tax rates.
 *                  G1: QNTY (quantity on hand) with VALUE (total value; else QNTY x COST) and an
 *                  optional ASOFDATE becomes the item's opening stock through the New Item path
 *                  (lib/services/lists/openingStock.ts: Dr Inventory Asset / Cr Opening Balance
 *                  Equity + a FIFO layer). When the same file already carries that inventory asset
 *                  account's balance (an ACCNT OBAMOUNT or TRNS rows on it - the usual QuickBooks
 *                  export) the item still gets its FIFO layer, quantity on hand and average cost,
 *                  but NO journal entry is posted (it would count the value twice); a note says so.
 *       Other lists through a REGISTRY (IIF_LIST_REGISTRY): CTYPE / VTYPE / SALESREP / BUD
 *                  import into their tables (OTHERNAME, JOBTYPE, TERMS, SHIPMETH, PAYMETH, CUSTMSG,
 *                  SALESTAXCODE, TODO, VEH, PRICELEVEL via qbIifLists.ts); unknown sections are parsed and
 *                  returned under `deferred` in the import report — wiring one later is a
 *                  single registry entry.
 *       TRNS/SPL/ENDTRNS — posted as balanced journal entries; accounts matched by full path /
 *                  code, unmatched accounts auto-created under a "QB Import (review)" bucket.
 *                  With `openItems.asDocuments`, open INVOICE / BILL blocks become real
 *                  invoices / bills instead (lib/services/openItemsImport.ts).
 *
 *   - CSV / Excel (.xlsx) lists with a user-supplied column mapping:
 *     importCustomersCSV() / importVendorsCSV() / importItemsCSV() / importAccountsCSV()
 *     and importListXlsx() (same importers, rows read with the GL-import xlsx reader).
 *
 * Master-data imports write no journal entries. IIF TRNS transactions DO post
 * to the GL — through postJournalEntry, like every other document — with a
 * sourceRef of `iif:…` so re-importing the same file skips duplicates.
 */
import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import { and, eq, like } from 'drizzle-orm';
import { csvUnsafeText } from '@/lib/csv';
import { withPlannerStats } from '@/lib/db/plannerStats';
import {
  accounts,
  classes as classesTable,
  customers as customersTable,
  employees as employeesTable,
  items as itemsTable,
  jobs as jobsTable,
  journalEntries,
  journalEntryLines,
  priceLevels,
  salesReps,
  taxRates,
  vendors as vendorsTable,
} from '@/lib/db/schema';
import { Money, allocate, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { ServiceError, writeAudit } from './_base';
import { createAccount } from './accounts';
import { createCustomer, type CustomerAddress } from './customers';
import { createVendor } from './vendors';
import { createClass } from './dimensions';
import { createItem, type CreateItemInput, type ItemType } from './items';
import { createItemWithOpeningStock, planOpeningStock, type OpeningStockInput } from './lists/openingStock';
import { setBom } from './assemblies';
import { createJob } from './jobs';
import { createEmployee, updateEmployee } from './payroll';
import { assertBalanced, postJournalEntry, type PostingLine } from './posting';
import { controlSideOfAccount, loadQbNameResolver, type QbNameRole } from './qbNameResolver';
import { assertPeriodOpen } from './fiscalPeriods';
import { createType } from './typeLists';
import { createSalesRep } from './salesReps';
import { createTaxRate } from './salesTax';
import { createBudget, setBudgetLine, listBudgets } from './budgets';
import { companyFiscalYearEnd, fiscalWindowFor } from './reportEngine';
import { readXlsx } from './qbGlFiles';
import * as L from './qbIifLists';
import { assignJobType } from './lists/jobTypes';
import type { IifControlRow } from './openItemsImport';
import { importRowError } from './qbImportErrors';
import { withImportLock } from './importLock';
import { getPreferences } from './company';
import { todayInTimeZone } from '@/lib/preferences';

// ---------------------------------------------------------------------------
// IIF type+subtype mapping
// ---------------------------------------------------------------------------

/**
 * Map QuickBooks IIF ACCNTTYPE values to our (type, subtype) pairs.
 * Unmapped types fall back to ('expense', 'operating_expenses').
 */
const IIF_TYPE_MAP: Record<string, { type: string; subtype: string }> = {
  // Assets
  BANK: { type: 'asset', subtype: 'checking' },
  SAVINGS: { type: 'asset', subtype: 'savings' },
  'ACCOUNTS RECEIVABLE': { type: 'asset', subtype: 'accounts_receivable' },
  ARACCNT: { type: 'asset', subtype: 'accounts_receivable' },
  INVENTORY: { type: 'asset', subtype: 'inventory' },
  'FIXED ASSET': { type: 'asset', subtype: 'fixed_assets' },
  FIXEDASSET: { type: 'asset', subtype: 'fixed_assets' },
  OTHERASSET: { type: 'asset', subtype: 'other_asset' },
  OASSET: { type: 'asset', subtype: 'other_asset' },
  'OTHER ASSET': { type: 'asset', subtype: 'other_asset' },
  OCASSET: { type: 'asset', subtype: 'other_current_asset' },
  'OTHER CURRENT ASSET': { type: 'asset', subtype: 'other_current_asset' },

  // Liabilities
  'ACCOUNTS PAYABLE': { type: 'liability', subtype: 'accounts_payable' },
  APACCNT: { type: 'liability', subtype: 'accounts_payable' },
  ACCSPAY: { type: 'liability', subtype: 'accounts_payable' },
  'CREDIT CARD': { type: 'liability', subtype: 'credit_card' },
  CREDITCARD: { type: 'liability', subtype: 'credit_card' },
  LTLIABILITY: { type: 'liability', subtype: 'long_term_liability' },
  LTLIAB: { type: 'liability', subtype: 'long_term_liability' },
  'LONG TERM LIABILITY': { type: 'liability', subtype: 'long_term_liability' },
  OCLIABILITY: { type: 'liability', subtype: 'other_current_liability' },
  OCLIAB: { type: 'liability', subtype: 'other_current_liability' },
  'OTHER CURRENT LIABILITY': { type: 'liability', subtype: 'other_current_liability' },

  // Equity
  EQUITY: { type: 'equity', subtype: 'owners_equity' },
  'RETAINED EARNINGS': { type: 'equity', subtype: 'retained_earnings' },

  // Revenue
  INCOME: { type: 'revenue', subtype: 'sales' },
  'OTHER INCOME': { type: 'revenue', subtype: 'other_income' },
  OTHERINCOME: { type: 'revenue', subtype: 'other_income' },
  EXINC: { type: 'revenue', subtype: 'other_income' },

  // Expenses
  EXPENSE: { type: 'expense', subtype: 'operating_expenses' },
  'COST OF GOODS SOLD': { type: 'expense', subtype: 'cost_of_goods_sold' },
  COGS: { type: 'expense', subtype: 'cost_of_goods_sold' },
  'OTHER EXPENSE': { type: 'expense', subtype: 'other_expense' },
  OTHEREXPENSE: { type: 'expense', subtype: 'other_expense' },
  EXEXP: { type: 'expense', subtype: 'other_expense' },

  // Non-posting (estimates, purchase orders) — never carries amounts
  NONPOSTING: { type: 'asset', subtype: 'non_posting' },
  'NON-POSTING': { type: 'asset', subtype: 'non_posting' },
  PAYROLL: { type: 'expense', subtype: 'payroll' },
};

/**
 * QuickBooks' own IIF ACCNTTYPE codes (what QB Desktop writes on export). Consulted only when
 * IIF_TYPE_MAP has no entry, so the account-type mapping above stays the single source of
 * truth for anything it lists (wave2 foundation QB account types: OASSET / OCLIAB / LTLIAB /
 * EXINC / EXEXP are listed there and win).
 */
const QB_NATIVE_ACCNTTYPE: Record<string, { type: string; subtype: string }> = {
  AR: { type: 'asset', subtype: 'accounts_receivable' },
  FIXASSET: { type: 'asset', subtype: 'fixed_assets' },
  OASSET: { type: 'asset', subtype: 'other_asset' },
  AP: { type: 'liability', subtype: 'accounts_payable' },
  CCARD: { type: 'liability', subtype: 'credit_card' },
  OCLIAB: { type: 'liability', subtype: 'other_current_liability' },
  LTLIAB: { type: 'liability', subtype: 'long_term_liability' },
  INC: { type: 'revenue', subtype: 'sales' },
  EXINC: { type: 'revenue', subtype: 'other_income' },
  EXP: { type: 'expense', subtype: 'operating_expenses' },
  EXEXP: { type: 'expense', subtype: 'other_expense' },
};

function mapIifType(iifType: string, name?: string): { type: string; subtype: string } {
  const key = iifType.trim().toUpperCase();
  const mapped = IIF_TYPE_MAP[key] ?? QB_NATIVE_ACCNTTYPE[key] ?? { type: 'expense', subtype: 'operating_expenses' };
  // QB keeps Undeposited Funds as an Other Current Asset, but it holds cash waiting to be
  // deposited — same special case as qbGlParse.toBookkeeperType.
  if (mapped.subtype === 'other_current_asset' && name && /undeposited/i.test(name)) {
    return { type: 'asset', subtype: 'undeposited_funds' };
  }
  // IIF ACCNTTYPE has no detail type: QuickBooks writes a savings account as BANK, Inventory Asset
  // as OCASSET, Retained Earnings as EQUITY, … Refine it from the account's own name, with the
  // same rules as the General Ledger import (qbGlParse.toBookkeeperType), so a round trip keeps
  // the detail type.
  const leaf = (name ?? '').split(':').pop()!.trim().toLowerCase();
  if (leaf) {
    if (mapped.type === 'asset' && mapped.subtype === 'checking' && /saving|money market/.test(leaf)) {
      return { type: 'asset', subtype: 'savings' };
    }
    if (mapped.type === 'asset' && mapped.subtype === 'other_current_asset' && /inventory/.test(leaf)) {
      return { type: 'asset', subtype: 'inventory' };
    }
    if (mapped.type === 'equity' && mapped.subtype === 'owners_equity' && /retained earnings/.test(leaf)) {
      return { type: 'equity', subtype: 'retained_earnings' };
    }
    if (mapped.type === 'revenue' && mapped.subtype === 'sales' && /service|consult|fee/.test(leaf)) {
      return { type: 'revenue', subtype: 'service_revenue' };
    }
    if (mapped.type === 'expense' && mapped.subtype === 'operating_expenses') {
      if (/payroll|wage|salar/.test(leaf)) return { type: 'expense', subtype: 'payroll' };
      if (/\btax/.test(leaf)) return { type: 'expense', subtype: 'taxes' };
    }
  }
  return mapped;
}


// ---------------------------------------------------------------------------
// Parsed IIF shapes
// ---------------------------------------------------------------------------

export interface IIFAccount {
  /** Full QB path, e.g. "Automobile:Fuel". */
  name: string;
  accntType: string;
  desc?: string;
  accnum?: string;
  hidden?: boolean;
  /** OBAMOUNT: opening balance, debit-positive (QB IIF sign convention). */
  obAmount?: string;
}

export interface IIFAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface IIFCustomer {
  /** Full QB name; "Customer:Job" for jobs. */
  name: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billAddr1?: string;
  billCity?: string;
  billState?: string;
  billZip?: string;
  billCountry?: string;
  billing?: IIFAddress | null;
  shipping?: IIFAddress | null;
  terms?: string;
  taxable?: boolean;
  taxItem?: string;
  salesTaxCode?: string;
  creditLimit?: string;
  customerType?: string;
  rep?: string;
  priceLevel?: string;
  hidden?: boolean;
  notes?: string;
  /** Contacts, alt phone, fax, resale number, job info and CUSTFLDn values by label. */
  fields?: Record<string, string>;
  raw?: Record<string, string>;
}

export interface IIFVendor {
  name: string;
  companyName?: string;
  email?: string;
  phone?: string;
  addr1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  address?: IIFAddress | null;
  terms?: string;
  vendorType?: string;
  is1099?: boolean;
  taxId?: string;
  creditLimit?: string;
  hidden?: boolean;
  notes?: string;
  fields?: Record<string, string>;
  raw?: Record<string, string>;
}

export interface IIFClass {
  name: string;
  hidden?: boolean;
}

export interface IIFItem {
  name: string;
  itemType: string;
  desc?: string;
  price?: string;
  cost?: string;
  /** Income account name (IIF ACCNT column). */
  incomeAccount?: string;
  cogsAccount?: string;
  assetAccount?: string;
  taxable?: boolean;
  hidden?: boolean;
  reorderPoint?: string;
  preferredVendor?: string;
  /** G1: QNTY - quantity on hand (inventory items). */
  quantityOnHand?: string;
  /** G1: VALUE / TOTALVALUE - total value of the quantity on hand (else QNTY x COST). */
  totalValue?: string;
  /** G1: ASOFDATE - as-of date of the quantity on hand (else the file's opening-balance date). */
  asOf?: string;
  /** CUSTFLD1..n values under their CUSTITEMDICT labels (item custom fields). */
  customFields?: Record<string, string>;
  raw?: Record<string, string>;
}

/** Group / assembly component row (INVITEMCOMP section — written by our IIF export). */
export interface IIFItemComponent {
  parent: string;
  component: string;
  quantity: string;
}

export interface IIFEmployee {
  name: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  address?: IIFAddress | null;
  ssn?: string;
  phone?: string;
  hireDate?: string;
  releaseDate?: string;
  payType?: string;
  payRate?: string;
  filingStatus?: string;
  allowances?: string;
  extraWithholding?: string;
  state?: string;
  hidden?: boolean;
  raw?: Record<string, string>;
}

export interface IIFTransactionLine {
  /** Account name (or "code" / "Parent:Sub" path) as written in the IIF. */
  accnt: string;
  /** Signed amount: positive = debit, negative = credit. */
  amount: string;
  memo?: string;
  /** Payee/entity name on the row. */
  name?: string;
  className?: string;
  item?: string;
  quantity?: string;
  price?: string;
  raw?: Record<string, string>;
}

export interface IIFTransaction {
  /** TRNSTYPE, e.g. CHECK, DEPOSIT, GENERAL JOURNAL. */
  type: string;
  /** Raw DATE field from the TRNS row (e.g. 1/15/2024). */
  date?: string;
  /** DOCNUM, if present. */
  num?: string;
  memo?: string;
  /** Name on the TRNS row (customer / vendor). */
  name?: string;
  dueDate?: string;
  terms?: string;
  /** PAID column: 'Y' when QB marked the invoice / bill paid. */
  paid?: boolean;
  /** Open balance when the export carries one (OPENBAL / BALANCE / AMTOPEN). */
  openBalance?: string;
  lines: IIFTransactionLine[];
}

/** A parsed list section with no dedicated parser (registry lists). */
export type IIFListRows = Array<Record<string, string>>;

export interface ParsedIIF {
  accounts: IIFAccount[];
  customers: IIFCustomer[];
  vendors: IIFVendor[];
  classes: IIFClass[];
  items: IIFItem[];
  itemComponents: IIFItemComponent[];
  employees: IIFEmployee[];
  transactions: IIFTransaction[];
  /** Every other list section keyed by its row type (CTYPE, TERMS, BUD, …). */
  lists: Record<string, IIFListRows>;
  /** CUSTNAMEDICT custom-field labels by CUSTFLD index, per name list. */
  customFieldLabels: {
    customer: Record<number, string>;
    vendor: Record<number, string>;
    employee: Record<number, string>;
    /** Item custom-field labels (CUSTITEMDICT). */
    item?: Record<number, string>;
  };
}

/** Sections parsed by dedicated code (everything else lands in `lists`). */
const CORE_SECTIONS = new Set([
  'ACCNT', 'CUST', 'VEND', 'CLASS', 'INVITEM', 'INVITEMCOMP', 'EMP', 'TRNS', 'SPL', 'ENDTRNS',
  'CUSTNAMEDICT', 'CUSTITEMDICT', 'HDR',
]);

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

const yes = (v: string | undefined) => !!v && /^(y|yes|true|1)$/i.test(v.trim());
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Parse an address from explicit city/state/zip columns or QB's free-form address lines. */
export function parseIifAddress(
  linesIn: Array<string | undefined>,
  explicit?: { city?: string; state?: string; zip?: string; country?: string },
): IIFAddress | null {
  const lines = linesIn.map((l) => (l ?? '').trim()).filter(Boolean);
  const out: IIFAddress = {};
  if (explicit?.city || explicit?.state || explicit?.zip) {
    out.city = explicit.city;
    out.state = explicit.state;
    out.zip = explicit.zip;
    out.country = explicit.country;
    out.line1 = lines[0];
    out.line2 = lines.slice(1).join(', ') || undefined;
  } else if (lines.length) {
    // QB writes "City, ST 12345" (optionally with a country line after it).
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^(.+?),?\s+([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/.test(lines[i])) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const m = /^(.+?),?\s+([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s?\d[A-Z]\d)$/.exec(lines[idx])!;
      out.city = m[1].replace(/,$/, '').trim();
      out.state = m[2].toUpperCase();
      out.zip = m[3];
      if (idx + 1 < lines.length) out.country = lines.slice(idx + 1).join(', ');
      const street = lines.slice(0, idx);
      out.line1 = street[0];
      out.line2 = street.slice(1).join(', ') || undefined;
    } else {
      out.line1 = lines[0];
      out.line2 = lines.slice(1).join(', ') || undefined;
    }
    if (explicit?.country) out.country = explicit.country;
  } else if (explicit?.country) {
    out.country = explicit.country;
  }
  const clean = Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as IIFAddress;
  return Object.keys(clean).length ? clean : null;
}

/** Collect CUSTFLD1..15 values under their CUSTNAMEDICT labels (or "Custom n"). */
function customFieldsOf(row: Record<string, string>, labels: Record<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= 15; i++) {
    const v = opt(row[`CUSTFLD${i}`]);
    if (v) out[labels[i] ?? `Custom ${i}`] = v;
  }
  return out;
}

/** Named contact / extra fields that have no dedicated column. */
function extraFields(row: Record<string, string>, map: Array<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [col, label] of map) {
    const v = opt(row[col]);
    if (v) out[label] = v;
  }
  return out;
}

const NAME_EXTRA_FIELDS: Array<[string, string]> = [
  ['CONT1', 'Contact'],
  ['CONT2', 'Alt. Contact'],
  ['PHONE2', 'Alt. Phone'],
  ['FAXNUM', 'Fax'],
  ['SALUTATION', 'Salutation'],
  ['FIRSTNAME', 'First Name'],
  ['MIDINIT', 'M.I.'],
  ['LASTNAME', 'Last Name'],
];
const CUSTOMER_EXTRA_FIELDS: Array<[string, string]> = [
  ...NAME_EXTRA_FIELDS,
  ['RESALENUM', 'Resale Number'],
  ['SALESTAXCODE', 'Sales Tax Code'],
  ['REP', 'Rep'],
  ['JOBDESC', 'Job Description'],
  ['JOBTYPE', 'Job Type'],
  ['JOBSTATUS', 'Job Status'],
  ['JOBSTART', 'Job Start Date'],
  ['JOBPROJEND', 'Job Projected End'],
  ['JOBEND', 'Job End Date'],
];
const VENDOR_EXTRA_FIELDS: Array<[string, string]> = [
  ...NAME_EXTRA_FIELDS,
  ['PRINTAS', 'Print on Check As'],
  ['LIMIT', 'Credit Limit'],
];

// ---------------------------------------------------------------------------
// parseIIF
// ---------------------------------------------------------------------------

/**
 * Parse an IIF file string. Header rows (starting with '!') declare the field names for the
 * row type that follows; data rows (same prefix without '!') carry the values.
 */
export function parseIIF(content: string): ParsedIIF {
  const result: ParsedIIF = {
    accounts: [],
    customers: [],
    vendors: [],
    classes: [],
    items: [],
    itemComponents: [],
    employees: [],
    transactions: [],
    lists: {},
    customFieldLabels: { customer: {}, vendor: {}, employee: {}, item: {} },
  };

  const lines = content
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));

  const headersByType = new Map<string, string[]>();
  let currentTxn: IIFTransaction | null = null;
  // Raw rows are collected first so CUSTNAMEDICT labels (anywhere in the file) apply.
  const custRows: Array<Record<string, string>> = [];
  const vendRows: Array<Record<string, string>> = [];
  const empRows: Array<Record<string, string>> = [];

  const txnLineFrom = (row: Record<string, string>): IIFTransactionLine => ({
    accnt: row.ACCNT ?? '',
    amount: row.AMOUNT ?? '0',
    memo: row.MEMO ?? undefined,
    name: row.NAME ?? undefined,
    className: row.CLASS ?? undefined,
    item: row.INVITEM ?? undefined,
    quantity: row.QNTY ?? undefined,
    price: row.PRICE ?? undefined,
    raw: row,
  });

  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith('!')) {
      const cols = line.slice(1).split('\t');
      const sectionKey = cols[0].trim().toUpperCase();
      headersByType.set(sectionKey, cols.map((c) => c.trim().toUpperCase()));
      continue;
    }

    const cols = line.split('\t');
    const rowType = cols[0]?.trim().toUpperCase();

    if (rowType === 'ENDTRNS') {
      if (currentTxn) result.transactions.push(currentTxn);
      currentTxn = null;
      continue;
    }

    const headers = headersByType.get(rowType);
    if (!headers) continue; // data row for a section without a header

    const row = zipIIF(headers, cols);

    switch (rowType) {
      case 'ACCNT':
        if (row.NAME) {
          result.accounts.push({
            name: row.NAME,
            accntType: row.ACCNTTYPE ?? '',
            desc: row.DESC ?? undefined,
            accnum: row.ACCNUM ?? undefined,
            hidden: yes(row.HIDDEN),
            obAmount: opt(row.OBAMOUNT),
          });
        }
        break;
      case 'CUST':
        if (row.NAME) custRows.push(row);
        break;
      case 'VEND':
        if (row.NAME) vendRows.push(row);
        break;
      case 'EMP':
        if (row.NAME || row.FIRSTNAME || row.LASTNAME) empRows.push(row);
        break;
      case 'CLASS':
        if (row.NAME) result.classes.push({ name: row.NAME, hidden: yes(row.HIDDEN) });
        break;
      case 'INVITEM':
        if (row.NAME) {
          result.items.push({
            name: row.NAME,
            itemType: row.INVITEMTYPE ?? '',
            desc: row.DESC ?? undefined,
            price: row.PRICE ?? undefined,
            cost: row.COST ?? undefined,
            incomeAccount: row.ACCNT ?? undefined,
            cogsAccount: row.COGSACCNT ?? undefined,
            assetAccount: row.ASSETACCNT ?? undefined,
            taxable: row.TAXABLE ? yes(row.TAXABLE) : undefined,
            hidden: yes(row.HIDDEN),
            reorderPoint: row.REORDERPOINT ?? undefined,
            preferredVendor: row.PREFVEND ?? undefined,
            quantityOnHand: row.QNTY ?? row.QTYONHAND ?? undefined,
            totalValue: row.VALUE ?? row.TOTALVALUE ?? undefined,
            asOf: row.ASOFDATE ?? row.ASOF ?? undefined,
            raw: row,
          });
        }
        break;
      case 'INVITEMCOMP': {
        const parent = row.PARENT ?? row.GROUP ?? row.ASSEMBLY;
        const component = row.COMPONENT ?? row.ITEM ?? row.INVITEM;
        if (parent && component) {
          result.itemComponents.push({ parent, component, quantity: row.QNTY ?? row.QTY ?? '1' });
        }
        break;
      }
      case 'CUSTNAMEDICT': {
        // INDEX (0-based) + LABEL, with CUSTOMER / VENDOR / EMPLOYEE flags.
        const idx = Number(row.INDEX);
        if (Number.isInteger(idx) && row.LABEL) {
          const n = idx + 1;
          if (yes(row.CUSTOMER)) result.customFieldLabels.customer[n] = row.LABEL;
          if (yes(row.VENDOR)) result.customFieldLabels.vendor[n] = row.LABEL;
          if (yes(row.EMPLOYEE)) result.customFieldLabels.employee[n] = row.LABEL;
        }
        break;
      }
      case 'CUSTITEMDICT': {
        // Item custom-field labels: INDEX (0-based) + LABEL — values are INVITEM CUSTFLDn.
        const idx = Number(row.INDEX);
        if (Number.isInteger(idx) && row.LABEL) (result.customFieldLabels.item ??= {})[idx + 1] = row.LABEL;
        break;
      }
      case 'TRNS':
        if (currentTxn) result.transactions.push(currentTxn); // missing ENDTRNS — close defensively
        currentTxn = {
          type: row.TRNSTYPE ?? '',
          date: row.DATE ?? undefined,
          num: row.DOCNUM ?? undefined,
          memo: row.MEMO ?? undefined,
          name: row.NAME ?? undefined,
          dueDate: row.DUEDATE ?? undefined,
          terms: row.TERMS ?? undefined,
          paid: row.PAID ? yes(row.PAID) : undefined,
          openBalance: row.OPENBAL ?? row.BALANCE ?? row.AMTOPEN ?? undefined,
          lines: [txnLineFrom(row)],
        };
        break;
      case 'SPL':
        if (currentTxn) currentTxn.lines.push(txnLineFrom(row));
        break;
      default:
        if (!CORE_SECTIONS.has(rowType)) {
          (result.lists[rowType] ??= []).push(row);
        }
    }
  }
  if (currentTxn) result.transactions.push(currentTxn); // file ended without ENDTRNS

  const labels = result.customFieldLabels;
  // Item custom fields (INVITEM CUSTFLDn under CUSTITEMDICT labels), once every label is read.
  for (const item of result.items) {
    if (!item.raw) continue;
    const fields = customFieldsOf(item.raw, labels.item ?? {});
    if (Object.keys(fields).length) item.customFields = fields;
  }
  for (const row of custRows) {
    const billing = parseIifAddress(
      [row.BADDR1, row.BADDR2, row.BADDR3, row.BADDR4, row.BADDR5],
      { city: row.BCITY, state: row.BSTATE, zip: row.BZIP, country: row.BCOUNTRY },
    );
    const shipping = parseIifAddress(
      [row.SADDR1, row.SADDR2, row.SADDR3, row.SADDR4, row.SADDR5],
      { city: row.SCITY, state: row.SSTATE, zip: row.SZIP, country: row.SCOUNTRY },
    );
    result.customers.push({
      name: row.NAME,
      companyName: opt(row.COMPANYNAME),
      email: opt(row.EMAIL),
      phone: opt(row.PHONE1),
      billAddr1: opt(row.BADDR1),
      billCity: opt(row.BCITY),
      billState: opt(row.BSTATE),
      billZip: opt(row.BZIP),
      billCountry: opt(row.BCOUNTRY),
      billing,
      shipping,
      terms: opt(row.TERMS),
      taxable: row.TAXABLE ? yes(row.TAXABLE) : undefined,
      taxItem: opt(row.TAXITEM),
      salesTaxCode: opt(row.SALESTAXCODE),
      creditLimit: opt(row.LIMIT),
      customerType: opt(row.CTYPE),
      rep: opt(row.REP),
      priceLevel: opt(row.PRICELEVEL),
      hidden: yes(row.HIDDEN),
      notes: opt(row.NOTE) ?? opt(row.NOTEPAD),
      fields: { ...extraFields(row, CUSTOMER_EXTRA_FIELDS), ...customFieldsOf(row, labels.customer) },
      raw: row,
    });
  }
  for (const row of vendRows) {
    const address = parseIifAddress(
      [row.ADDR1, row.ADDR2, row.ADDR3, row.ADDR4, row.ADDR5],
      { city: row.CITY, state: row.STATE, zip: row.ZIP, country: row.COUNTRY },
    );
    result.vendors.push({
      name: row.NAME,
      companyName: opt(row.COMPANYNAME),
      email: opt(row.EMAIL),
      phone: opt(row.PHONE1),
      addr1: opt(row.ADDR1),
      city: opt(row.CITY),
      state: opt(row.STATE),
      zip: opt(row.ZIP),
      country: opt(row.COUNTRY),
      address,
      terms: opt(row.TERMS),
      vendorType: opt(row.VTYPE),
      is1099: yes(row['1099']),
      taxId: opt(row.TAXID),
      creditLimit: opt(row.LIMIT),
      hidden: yes(row.HIDDEN),
      notes: opt(row.NOTE) ?? opt(row.NOTEPAD),
      fields: { ...extraFields(row, VENDOR_EXTRA_FIELDS), ...customFieldsOf(row, labels.vendor) },
      raw: row,
    });
  }
  for (const row of empRows) {
    const address = parseIifAddress(
      [row.ADDR1, row.ADDR2, row.ADDR3, row.ADDR4, row.ADDR5],
      { city: row.CITY, state: row.STATE, zip: row.ZIP },
    );
    result.employees.push({
      name: row.NAME ?? [row.LASTNAME, row.FIRSTNAME].filter(Boolean).join(', '),
      email: opt(row.EMAIL),
      firstName: opt(row.FIRSTNAME),
      lastName: opt(row.LASTNAME),
      address,
      ssn: opt(row.SSNO) ?? opt(row.SSN),
      phone: opt(row.PHONE1),
      hireDate: opt(row.HIREDATE),
      releaseDate: opt(row.RELEASEDATE),
      payType: opt(row.PAYTYPE) ?? opt(row.EMPTYPE),
      payRate: opt(row.PAYRATE) ?? opt(row.RATE) ?? opt(row.SALARY),
      filingStatus: opt(row.FILINGSTATUS) ?? opt(row.FEDSTATUS),
      allowances: opt(row.ALLOWANCES) ?? opt(row.FEDALLOW),
      extraWithholding: opt(row.EXTRAWH) ?? opt(row.FEDEXTRA),
      state: opt(row.STATEWH) ?? opt(row.WORKSTATE),
      hidden: yes(row.HIDDEN),
      raw: row,
    });
  }

  return result;
}

/** Parse an IIF amount string ('1,234.56', '($50.00)', '-50') → 2dp string, or null. */
export function parseIifAmount(raw: string | undefined): string | null {
  if (raw == null) return null;
  let s = raw.trim().replace(/[$,]/g, '');
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return toAmountString(negative ? -n : n);
}

/** Parse an IIF date ('1/15/2024', '01/15/24', '2024-01-15') → Date, or null. */
export function parseIifDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  const parts = s.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3) return null;
  let year: number;
  let month: number;
  let day: number;
  if (parts[0].length === 4) {
    year = Number(parts[0]);
    month = Number(parts[1]);
    day = Number(parts[2]);
  } else {
    month = Number(parts[0]);
    day = Number(parts[1]);
    year = Number(parts[2]);
    if (parts[2].length <= 2) year += year < 50 ? 2000 : 1900;
  }
  if (!year || !month || !day || month > 12 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Zip IIF header row + data row into an object keyed by column names. */
function zipIIF(headers: string[], cols: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    // IIF exports quote fields containing tabs/quotes: strip one pair of surrounding quotes.
    let val = cols[i]?.trim() ?? '';
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/""/g, '"');
    if (val) obj[headers[i]] = val;
  }
  return obj;
}

/** QB terms text → the short key stored on customers/vendors ('Net 30' → 'net_30'). */
export function normalizeTerms(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/due on receipt/.test(s)) return 'due_on_receipt';
  return s.replace(/%/g, 'pct').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50) || null;
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

/** Per-row detail for anything that was skipped or imported with an adjustment. */
export interface ImportIssue {
  entity:
    | 'account' | 'customer' | 'vendor' | 'class' | 'item' | 'employee' | 'transaction'
    | 'job' | 'list' | 'invoice' | 'bill';
  name: string;
  code?: string;
  reason: 'duplicate' | 'code-collision' | 'validation' | 'unmatched-account' | 'ambiguous-account' | 'note';
  message: string;
}

/** A list section that was parsed but has no table yet (wired later via the registry). */
export interface DeferredList {
  list: string;
  label: string;
  count: number;
  note: string;
  rows: IIFListRows;
}

export interface ImportCounts {
  accounts: number;
  customers: number;
  vendors: number;
  classes: number;
  items: number;
  employees: number;
  /** Jobs created from "Customer:Job" names. */
  jobs: number;
  /** TRNS/SPL blocks posted as balanced journal entries. */
  transactions: number;
  /** Rows imported per registry list (CTYPE, VTYPE, SALESREP, BUD …). */
  lists: Record<string, number>;
  /** Parsed lists that have no table yet — returned so nothing is silently dropped. */
  deferred: DeferredList[];
  /** Open invoices / bills converted to real documents (when requested). */
  openItems?: { invoices: number; bills: number; credits: number; skipped: number };
  /**
   * G1: inventory items imported with an opening quantity on hand, and its total value.
   * `unposted` of them were brought in without a journal entry because the file already
   * carries their inventory asset account's balance.
   */
  openingStock?: { items: number; value: string; unposted?: number };
  skipped: number;
  /** One entry per skipped row (and per remap/auto-create), so users can see WHY. */
  issues: ImportIssue[];
}

export function emptyCounts(): ImportCounts {
  return {
    accounts: 0,
    customers: 0,
    vendors: 0,
    classes: 0,
    items: 0,
    employees: 0,
    jobs: 0,
    transactions: 0,
    lists: {},
    deferred: [],
    skipped: 0,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// Account rows (CSV path keeps the flat code/name dedupe)
// ---------------------------------------------------------------------------

/**
 * Import a single account definition with full dedupe / code-collision handling.
 * Used by the chart-of-accounts CSV import. Updates `counts` in place; never throws on
 * per-row validation problems.
 */
async function importAccountRow(
  ctx: ServiceContext,
  counts: ImportCounts,
  input: {
    name: string;
    code?: string;
    type: string;
    subtype: string;
    description?: string | null;
    parentId?: string | null;
  },
): Promise<{ id: string; code: string } | null> {
  const name = input.name.trim();
  let code = input.code?.trim() || sanitiseCode(name);
  if (!code) {
    counts.skipped++;
    counts.issues.push({
      entity: 'account',
      name: name || '(blank)',
      reason: 'validation',
      message: 'Could not derive an account code from the name.',
    });
    return null;
  }

  const [byCode] = await ctx.db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));

  if (byCode && byCode.name === name) {
    counts.skipped++;
    counts.issues.push({
      entity: 'account',
      name,
      code,
      reason: 'duplicate',
      message: `Account "${name}" (code ${code}) already exists.`,
    });
    return null;
  }

  if (byCode) {
    const [byName] = await ctx.db
      .select({ id: accounts.id, code: accounts.code })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, name)));
    if (byName) {
      counts.skipped++;
      counts.issues.push({
        entity: 'account',
        name,
        code: byName.code,
        reason: 'duplicate',
        message: `Account "${name}" already exists (code ${byName.code}).`,
      });
      return null;
    }

    const remapped = await findAvailableCode(ctx, code);
    if (!remapped) {
      counts.skipped++;
      counts.issues.push({
        entity: 'account',
        name,
        code,
        reason: 'code-collision',
        message: `Code ${code} is taken by "${byCode.name}" and no free variant was found.`,
      });
      return null;
    }
    counts.issues.push({
      entity: 'account',
      name,
      code: remapped,
      reason: 'code-collision',
      message: `Code ${code} is taken by "${byCode.name}"; imported as ${remapped}.`,
    });
    code = remapped;
  }

  try {
    const row = await createAccount(ctx, {
      code,
      name,
      type: input.type as never,
      subtype: input.subtype,
      description: input.description ?? null,
      parentId: input.parentId ?? null,
    });
    counts.accounts++;
    return { id: row.id, code };
  } catch (caught) {
    const err = importRowError(caught) ?? caught;
    if (err instanceof ServiceError && err.code === 'VALIDATION') {
      counts.skipped++;
      counts.issues.push({ entity: 'account', name, code, reason: 'validation', message: err.message });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Account lookup by FULL PATH
// ---------------------------------------------------------------------------

export interface AccountRef {
  id: string;
  type: string;
  subtype: string;
  code: string;
  name: string;
  /** Full "Parent:Sub" path (lowercase key in byPath). */
  path: string;
}

export interface AccountLookup {
  byPath: Map<string, AccountRef>;
  /** Exact (lowercase) account NAME → accounts with that name (leaf names can collide). */
  byLowerName: Map<string, AccountRef[]>;
  byCode: Map<string, AccountRef>;
}

const normPath = (p: string) =>
  p.split(':').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean).join(':').toLowerCase();

export async function loadAccountLookup(ctx: ServiceContext): Promise<AccountLookup> {
  const rows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
    })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(':');
  };
  const lookup: AccountLookup = { byPath: new Map(), byLowerName: new Map(), byCode: new Map() };
  for (const r of rows) addToLookup(lookup, { id: r.id, type: r.type, subtype: r.subtype, code: r.code, name: r.name, path: pathOf(r.id) });
  return lookup;
}

function addToLookup(lookup: AccountLookup, ref: AccountRef) {
  lookup.byPath.set(normPath(ref.path), ref);
  const k = ref.name.trim().toLowerCase();
  const list = lookup.byLowerName.get(k) ?? [];
  if (!list.some((x) => x.id === ref.id)) list.push(ref);
  lookup.byLowerName.set(k, list);
  lookup.byCode.set(ref.code, ref);
}

/**
 * Resolve an IIF account reference. Order: FULL PATH → account number/code → exact name when
 * exactly one account has it. A full "Parent:Sub" path that is not in the books resolves to
 * null (never to a same-named leaf under another parent). Ambiguous references resolve with
 * `ambiguous` set, so a collision can never post to the wrong account.
 */
export function resolveAccountRef(
  lookup: AccountLookup,
  ref: string,
): (AccountRef & { ambiguous?: false }) | { ambiguous: true; candidates: AccountRef[] } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const byPath = lookup.byPath.get(normPath(trimmed));
  if (byPath) return byPath;
  const byCode = lookup.byCode.get(trimmed);
  if (byCode) return byCode;
  // "10100 · Checking" style labels from reports: try the number.
  const num = /^([A-Za-z0-9][\w.-]*)\s*[·•]\s*(.+)$/.exec(trimmed);
  if (num && lookup.byCode.get(num[1])) return lookup.byCode.get(num[1])!;
  // "1300 Inventory Asset" (number, space, name — how our own list export writes an item's
  // accounts): the number only counts when the rest is that account's own name or full path,
  // so a name that merely starts with digits never resolves to an unrelated account.
  const spaced = /^([A-Za-z0-9][\w.-]*)\s+(.+)$/.exec(trimmed);
  if (spaced) {
    const acct = lookup.byCode.get(spaced[1]);
    const rest = normPath(spaced[2]);
    if (acct && (rest === acct.name.trim().replace(/\s+/g, ' ').toLowerCase() || rest === normPath(acct.path))) return acct;
  }
  const exact = lookup.byLowerName.get(trimmed.toLowerCase()) ?? [];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return { ambiguous: true, candidates: exact };
  // A "Parent:Sub" path that is not in the books is UNKNOWN. We deliberately never fall back
  // to the leaf name: "Travel:Meals" must not post to "Entertainment:Meals" just because the
  // leaf "Meals" happens to be unique. Callers create it (or send it to the review bucket).
  return null;
}

/** resolveAccountRef narrowed to a usable account (null for unknown OR ambiguous). */
function resolveAccount(lookup: AccountLookup, ref: string): AccountRef | null {
  const r = resolveAccountRef(lookup, ref);
  return r && !('ambiguous' in r && r.ambiguous) ? (r as AccountRef) : null;
}

/**
 * IIF chart of accounts with the full "Parent:Sub" hierarchy. Parents are created before
 * children (missing parents are created with the child's type); each account is deduped by its
 * full path; codes come from ACCNUM (or the leaf name) with collision remapping.
 */
async function importIifAccounts(
  ctx: ServiceContext,
  counts: ImportCounts,
  rows: IIFAccount[],
  lookup: AccountLookup,
  obDate: Date = new Date(),
): Promise<void> {
  // Non-posting accounts (estimates, purchase orders) are imported as the wave2 foundation
  // 'non_posting' subtype (IIF_TYPE_MAP NONPOSTING): they never carry amounts or reach reports.
  const typeOfPath = new Map<string, { type: string; subtype: string }>();
  for (const a of rows) typeOfPath.set(normPath(a.name), mapIifType(a.accntType, a.name));
  const defs = new Map(rows.map((a) => [normPath(a.name), a]));

  // Every path plus its ancestors, shallowest first.
  const allPaths = new Set<string>();
  for (const a of rows) {
    const segs = normPath(a.name).split(':');
    for (let i = 1; i <= segs.length; i++) allPaths.add(segs.slice(0, i).join(':'));
  }
  const ordered = [...allPaths].sort((x, y) => x.split(':').length - y.split(':').length);

  for (const key of ordered) {
    const def = defs.get(key);
    const segsOriginal = (def?.name ?? key).split(':').map((s) => s.trim()).filter(Boolean);
    const leaf = def ? segsOriginal[segsOriginal.length - 1] : titleFromKey(key, rows);
    const displayPath = def?.name ?? key;
    if (lookup.byPath.has(key)) {
      if (def) {
        counts.skipped++;
        counts.issues.push({
          entity: 'account',
          name: displayPath,
          code: lookup.byPath.get(key)!.code,
          reason: 'duplicate',
          message: `Account "${displayPath}" already exists.`,
        });
      }
      continue;
    }
    const parentKey = key.includes(':') ? key.slice(0, key.lastIndexOf(':')) : null;
    const parent = parentKey ? lookup.byPath.get(parentKey) ?? null : null;
    // Type: own definition, else the first defined descendant (implicit parent).
    let t = typeOfPath.get(key);
    if (!t) {
      const child = [...typeOfPath.entries()].find(([p]) => p.startsWith(`${key}:`));
      t = child ? child[1] : { type: 'expense', subtype: 'operating_expenses' };
    }
    let code = def?.accnum?.trim() || sanitiseCode(leaf);
    if (!code) {
      counts.skipped++;
      counts.issues.push({ entity: 'account', name: displayPath, reason: 'validation', message: 'Could not derive an account code.' });
      continue;
    }
    if (lookup.byCode.has(code)) {
      const free = await findAvailableCode(ctx, code);
      if (!free) {
        counts.skipped++;
        counts.issues.push({ entity: 'account', name: displayPath, code, reason: 'code-collision', message: `No free account code near ${code}.` });
        continue;
      }
      counts.issues.push({
        entity: 'account',
        name: displayPath,
        code: free,
        reason: 'code-collision',
        message: `Code ${code} is already used by "${lookup.byCode.get(code)!.path}"; imported as ${free}.`,
      });
      code = free;
    }
    // A parent of a different account type cannot hold the child — keep it top level.
    let parentId = parent?.id ?? null;
    if (parent && parent.type !== t.type) {
      counts.issues.push({
        entity: 'account',
        name: displayPath,
        reason: 'note',
        message: `"${displayPath}" was created at the top level because "${parent.path}" is a different account type.`,
      });
      parentId = null;
    }
    try {
      const base = {
        code,
        name: leaf,
        type: t.type as never,
        subtype: t.subtype,
        description: def?.desc ?? (def ? null : 'Parent account created by QuickBooks IIF import.'),
        parentId,
      };
      // OBAMOUNT is debit-positive; createAccount's opening balance is in the account's natural
      // direction (credit-normal accounts flip the sign).
      const ob = def?.obAmount ? parseIifAmount(def.obAmount) : null;
      let row;
      if (ob && !Money.isZero(ob)) {
        const natural = t.type === 'asset' || t.type === 'expense' ? Money.of(ob) : Money.of(ob).negated();
        try {
          row = await createAccount(ctx, { ...base, openingBalance: toAmountString(natural), openingBalanceDate: obDate });
        } catch (err) {
          if (!(err instanceof ServiceError)) throw err;
          row = await createAccount(ctx, base);
          counts.issues.push({
            entity: 'account',
            name: displayPath,
            code,
            reason: 'note',
            message: `The opening balance ${toAmountString(Money.of(ob))} was not posted: ${err.message}`,
          });
        }
      } else {
        row = await createAccount(ctx, base);
      }
      counts.accounts++;
      const ref: AccountRef = {
        id: row.id,
        type: row.type,
        subtype: row.subtype,
        code: row.code,
        name: row.name,
        path: parentId && parent ? `${parent.path}:${leaf}` : leaf,
      };
      addToLookup(lookup, ref);
      // Also index the QB path when it differs (parent kept at top level).
      lookup.byPath.set(key, ref);
      if (def?.hidden) {
        await ctx.db.update(accounts).set({ isActive: false, updatedAt: new Date() }).where(eq(accounts.id, row.id));
        await writeAudit(ctx, { action: 'update', entityType: 'account', entityId: row.id, oldValues: { isActive: true }, newValues: { isActive: false } });
      }
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'account', name: displayPath, code, reason: 'validation', message: err.message });
        continue;
      }
      throw err;
    }
  }
}

/** Original-case segment name for an implicit parent path key. */
function titleFromKey(key: string, rows: IIFAccount[]): string {
  const depth = key.split(':').length;
  for (const r of rows) {
    const segs = r.name.split(':').map((s) => s.trim()).filter(Boolean);
    if (segs.length >= depth && normPath(segs.slice(0, depth).join(':')) === key) return segs[depth - 1];
  }
  return key.split(':').pop()!;
}

// ---------------------------------------------------------------------------
// Other-list registry (L4)
// ---------------------------------------------------------------------------

interface ListImportEnv {
  ctx: ServiceContext;
  counts: ImportCounts;
  lookup: AccountLookup;
  classIdByPath: Map<string, string>;
}

type ListImporter = (env: ListImportEnv, rows: IIFListRows) => Promise<number>;

interface ListRegistryEntry {
  label: string;
  /** 'early' runs before customers/vendors (type lists they reference), 'late' after accounts. */
  phase: 'early' | 'late';
  importer?: ListImporter;
  /** Shown in the import report when the list has no table yet. */
  deferredNote?: string;
}

const typeListImporter = (kind: 'customer' | 'vendor'): ListImporter => async ({ ctx, counts }, rows) => {
  const table = kind === 'customer' ? (await import('@/lib/db/schema')).customerTypes : (await import('@/lib/db/schema')).vendorTypes;
  const existing = await ctx.db.select().from(table).where(eq(table.companyId, ctx.companyId));
  const byPath = new Map<string, string>();
  const pathOf = (id: string): string => {
    const r = existing.find((e) => e.id === id);
    return r ? (r.parentId ? `${pathOf(r.parentId)}:${r.name}` : r.name) : '';
  };
  for (const e of existing) byPath.set(normPath(pathOf(e.id)), e.id);
  let n = 0;
  const sorted = [...rows].filter((r) => r.NAME).sort((a, b) => a.NAME.split(':').length - b.NAME.split(':').length);
  for (const r of sorted) {
    const segs = r.NAME.split(':').map((s) => s.trim()).filter(Boolean);
    let parentId: string | null = null;
    let path = '';
    for (const seg of segs) {
      path = path ? `${path}:${seg}` : seg;
      let id = byPath.get(normPath(path));
      if (!id) {
        try {
          const row = await createType(ctx, kind, { name: seg, parentId, isActive: !yes(r.HIDDEN) });
          id = row.id;
          byPath.set(normPath(path), id);
          n++;
        } catch (caught) {
          const err = importRowError(caught) ?? caught;
          if (err instanceof ServiceError && err.code === 'VALIDATION') {
            counts.issues.push({ entity: 'list', name: r.NAME, reason: 'validation', message: err.message });
            break;
          }
          throw err;
        }
      }
      parentId = id;
    }
  }
  return n;
};

const salesRepImporter: ListImporter = async ({ ctx, counts }, rows) => {
  const existing = await ctx.db.select({ name: salesReps.name }).from(salesReps).where(eq(salesReps.companyId, ctx.companyId));
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  let n = 0;
  for (const r of rows) {
    const name = opt(r.ASSOCIATEDNAME) ?? opt(r.NAME) ?? opt(r.INITIALS);
    if (!name || names.has(name.toLowerCase())) continue;
    try {
      await createSalesRep(ctx, { name, commissionRate: 0 });
      names.add(name.toLowerCase());
      n++;
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.issues.push({ entity: 'list', name, reason: 'validation', message: err.message });
        continue;
      }
      throw err;
    }
  }
  return n;
};

/**
 * BUD rows: ACCNT, PERIOD (MONTH / QUARTER / YEAR), AMOUNT, STARTDATE, CLASS, CUSTOMER.
 * One budget per (fiscal year, class, customer); quarter / year amounts are spread evenly
 * (penny-exact) across their months.
 */
const budgetImporter: ListImporter = async ({ ctx, counts, lookup }, rows) => {
  const existing = await listBudgets(ctx);
  const budgetIds = new Map(existing.map((b) => [`${b.name}|${b.fiscalYear}`, b.id]));
  const fye = await companyFiscalYearEnd(ctx);
  let n = 0;
  for (const r of rows) {
    const start = parseIifDate(r.STARTDATE);
    const amount = parseIifAmount(r.AMOUNT);
    const acct = r.ACCNT ? resolveAccount(lookup, r.ACCNT) : null;
    if (!start || amount === null || !acct) {
      counts.issues.push({
        entity: 'list',
        name: `Budget ${r.ACCNT ?? ''}`,
        reason: 'validation',
        message: !acct ? `Budget account "${r.ACCNT ?? ''}" was not found.` : 'Budget row has no start date or amount.',
      });
      continue;
    }
    const suffix = [opt(r.CLASS), opt(r.CUSTOMER)].filter(Boolean).join(' / ');
    const name = suffix ? `QuickBooks budget — ${suffix}` : 'QuickBooks budget';
    try {
      const period = (r.PERIOD ?? 'MONTH').toUpperCase();
      const months = period.startsWith('Q') ? 3 : period.startsWith('Y') ? 12 : 1;
      const parts = allocate(amount, Array.from({ length: months }, () => 1));
      for (let i = 0; i < months; i++) {
        // Each month goes to the budget of the FISCAL year it falls in (budgets are keyed by the
        // year their fiscal year ends, lines by calendar month): a July-June company's July row
        // belongs to the next year's budget, and a year spread from July runs on into the next
        // budget instead of being cut off at December.
        const mid = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 15));
        const fiscalYear = fiscalWindowFor(mid, fye).end.getUTCFullYear();
        const key = `${name}|${fiscalYear}`;
        let budgetId = budgetIds.get(key);
        if (!budgetId) {
          const b = await createBudget(ctx, { name, fiscalYear });
          budgetId = b.id;
          budgetIds.set(key, budgetId);
        }
        await setBudgetLine(ctx, { budgetId, accountId: acct.id, month: mid.getUTCMonth() + 1, amount: toAmountString(parts[i]) });
      }
      n++;
    } catch (caught) {
      const err = importRowError(caught);
      if (err?.code !== 'VALIDATION') throw caught;
      counts.issues.push({ entity: 'list', name: `Budget ${r.ACCNT ?? ''}`, reason: 'validation', message: err.message });
    }
  }
  return n;
};

/** Adapter: a qbIifLists importer → registry importer (issues land in the import report). */
const otherListImporter =
  (fn: (ctx: ServiceContext, rows: IIFListRows, issues: L.ListIssue[]) => Promise<number>): ListImporter =>
  async ({ ctx, counts }, rows) => {
    const issues: L.ListIssue[] = [];
    const n = await fn(ctx, rows, issues);
    for (const i of issues) counts.issues.push({ entity: 'list', name: i.name, reason: 'validation', message: i.message });
    return n;
  };

/**
 * IIF list registry. Adding a list = one entry here: give it an `importer` when its table
 * exists, otherwise a `deferredNote` and its parsed rows are returned in the import report.
 */
export const IIF_LIST_REGISTRY: Record<string, ListRegistryEntry> = {
  CTYPE: { label: 'Customer types', phase: 'early', importer: typeListImporter('customer') },
  VTYPE: { label: 'Vendor types', phase: 'early', importer: typeListImporter('vendor') },
  SALESREP: { label: 'Sales reps', phase: 'early', importer: salesRepImporter },
  BUD: { label: 'Budgets', phase: 'late', importer: budgetImporter },
  // Simple QB lists: imported before customers / vendors so their Terms, Sales Tax Code, Price
  // Level and Job Type link to real list entries (lib/services/qbIifLists.ts).
  OTHERNAME: { label: 'Other names', phase: 'early', importer: otherListImporter(L.importOtherNames) },
  TERMS: { label: 'Terms', phase: 'early', importer: otherListImporter(L.importTerms) },
  SHIPMETH: { label: 'Shipping methods', phase: 'early', importer: otherListImporter(L.importShipMethods) },
  PAYMETH: { label: 'Payment methods', phase: 'early', importer: otherListImporter(L.importPaymentMethods) },
  CUSTMSG: { label: 'Customer messages', phase: 'early', importer: otherListImporter(L.importCustomerMessages) },
  SALESTAXCODE: { label: 'Sales tax codes', phase: 'early', importer: otherListImporter(L.importSalesTaxCodes) },
  JOBTYPE: { label: 'Job types', phase: 'early', importer: otherListImporter(L.importJobTypes) },
  VEH: { label: 'Vehicles', phase: 'early', importer: otherListImporter(L.importVehicles) },
  PRICELEVEL: { label: 'Price levels', phase: 'early', importer: otherListImporter(L.importPriceLevels) },
  // To-dos may name customers / vendors, so they come after the name lists.
  TODO: { label: 'To Do notes', phase: 'late', importer: otherListImporter(L.importTodos) },
};

async function runListRegistry(env: ListImportEnv, lists: Record<string, IIFListRows>, phase: 'early' | 'late') {
  for (const [key, rows] of Object.entries(lists)) {
    const entry = IIF_LIST_REGISTRY[key];
    if (!rows.length) continue;
    if (!entry) {
      if (phase === 'late') {
        env.counts.deferred.push({ list: key, label: key, count: rows.length, note: 'This IIF section is not supported yet.', rows });
      }
      continue;
    }
    if (entry.phase !== phase) continue;
    if (entry.importer) {
      env.counts.lists[key] = (env.counts.lists[key] ?? 0) + (await entry.importer(env, rows));
    } else {
      env.counts.deferred.push({ list: key, label: entry.label, count: rows.length, note: entry.deferredNote ?? '', rows });
    }
  }
}

// ---------------------------------------------------------------------------
// importIIF
// ---------------------------------------------------------------------------

export interface ImportIifOptions {
  /**
   * Convert open INVOICE / BILL transactions to real documents instead of journal entries
   * (lib/services/openItemsImport.ts). `alreadyInGl` = a General Ledger import already brought
   * the A/R and A/P balances, so each document is netted against the conversion clearing
   * account and the control-account balances do not change.
   */
  openItems?: { asDocuments: boolean; alreadyInGl?: boolean };
}

/**
 * Parse an IIF string, then insert records via the existing service layer. True duplicates
 * (same full account path, same displayName, …) are skipped and reported in `issues`.
 */
export async function importIIF(
  ctx: ServiceContext,
  content: string,
  opts: ImportIifOptions = {},
): Promise<ImportCounts> {
  // A bulk load: fresh planner statistics afterwards (PGlite has no autovacuum; best-effort).
  // One import at a time per company: two runs of the same file at once both passed the
  // "already imported?" checks and posted every transaction / open bill twice (importLock.ts).
  return withImportLock(ctx, () => withPlannerStats(ctx.db, 'IIF import', () => importIIFRows(ctx, content, opts)));
}

async function importIIFRows(
  ctx: ServiceContext,
  content: string,
  opts: ImportIifOptions,
): Promise<ImportCounts> {
  const parsed = parseIIF(content);
  const counts = emptyCounts();

  // ---- Accounts (full hierarchy) ----
  const lookup = await loadAccountLookup(ctx);
  // Opening balances (OBAMOUNT) are dated the day before the file's first transaction (QB has no
  // opening-balance date in the IIF), or today when the file has no transactions.
  // (A loop, not Math.min(...dates): spreading 150,000 dates as arguments overflows the stack.)
  let firstTxn: number | null = null;
  for (const t of parsed.transactions) {
    const d = parseIifDate(t.date)?.getTime();
    if (d !== undefined && (firstTxn === null || d < firstTxn)) firstTxn = d;
  }
  const obDate = firstTxn !== null ? new Date(firstTxn - 86_400_000) : await companyToday(ctx);
  await importIifAccounts(ctx, counts, parsed.accounts, lookup, obDate);

  // ---- Classes ("Parent:Sub") ----
  const classIdByPath = await importIifClasses(ctx, counts, parsed.classes);

  const env: ListImportEnv = { ctx, counts, lookup, classIdByPath };
  await runListRegistry(env, parsed.lists, 'early');

  // ---- Customers (parents first; "Customer:Job" → sub-customer + job) ----
  await importIifCustomers(ctx, counts, parsed.customers);

  // ---- Vendors ----
  await importIifVendors(ctx, counts, parsed.vendors);

  // ---- Items (INVITEM) + group / assembly components ----
  // Inventory asset accounts whose balance this file already brings in (opening balance or
  // transactions), or a General Ledger import already brought: item QNTY on those accounts is
  // not posted again (it would double the stock).
  const carriedAccountIds = await glImportedAssetAccountIds(ctx);
  for (const a of parsed.accounts) {
    const ob = parseIifAmount(a.obAmount);
    if (!ob || Money.of(ob).isZero()) continue;
    const r = resolveAccountRef(lookup, a.name);
    if (r && !('ambiguous' in r && r.ambiguous)) carriedAccountIds.add((r as AccountRef).id);
  }
  for (const t of parsed.transactions) {
    for (const l of t.lines) {
      const r = resolveAccountRef(lookup, l.accnt);
      if (r && !('ambiguous' in r && r.ambiguous)) carriedAccountIds.add((r as AccountRef).id);
    }
  }
  await importIifItems(ctx, counts, lookup, parsed.items, parsed.itemComponents, { obDate, carriedAccountIds });

  // ---- Employees (EMP) ----
  await importIifEmployees(ctx, counts, parsed.employees);

  // ---- Late registry lists (budgets etc.) ----
  await runListRegistry(env, parsed.lists, 'late');

  // ---- Transactions ----
  let txns = parsed.transactions;
  let redirectControl: { accountId: string } | undefined;
  if (opts.openItems?.asDocuments) {
    const { importOpenItemsFromIif } = await import('./openItemsImport');
    const docTypes = new Set(['INVOICE', 'BILL', 'CREDIT MEMO', 'BILL REFUND', 'BILLCRED', 'CREDITMEMO']);
    const docTxns = txns.filter((t) => docTypes.has(t.type.trim().toUpperCase()));
    txns = txns.filter((t) => !docTypes.has(t.type.trim().toUpperCase()));
    // Named A/R / A/P rows of payments, bill payments, refunds and journals in the same file are
    // applied to that customer's / vendor's open documents (QuickBooks' real per-name balance),
    // because below those rows themselves are re-pointed to the conversion account.
    const r = await importOpenItemsFromIif(ctx, docTxns, {
      alreadyInGl: !!opts.openItems.alreadyInGl,
      controlRows: await collectIifControlRows(ctx, txns, lookup, counts),
    });
    counts.openItems = { invoices: r.invoices, bills: r.bills, credits: r.credits, skipped: r.skipped };
    counts.skipped += r.skipped;
    for (const i of r.issues) counts.issues.push(i); // one per document: never spread as arguments
    // The open documents now carry the WHOLE A/R and A/P detail (each at its open balance, i.e.
    // already net of every payment QuickBooks applied). Payments, bill payments, deposits or
    // journal rows in the same file that touch A/R or A/P would reduce the control account a
    // second time (e.g. the payment of an invoice skipped as PAID), so those rows are re-pointed
    // to the same conversion account the documents were posted against. Control == aging holds.
    if (txns.length) {
      const { ensureConversionAccount } = await import('./openItemsImport');
      redirectControl = { accountId: await ensureConversionAccount(ctx, !!opts.openItems.alreadyInGl) };
    }
  }
  if (txns.length) {
    await importIifTransactions(ctx, counts, txns, lookup, classIdByPath, redirectControl);
  }

  return counts;
}

async function importIifClasses(ctx: ServiceContext, counts: ImportCounts, rows: IIFClass[]) {
  const existing = await ctx.db
    .select({ id: classesTable.id, name: classesTable.name, parentId: classesTable.parentId })
    .from(classesTable)
    .where(eq(classesTable.companyId, ctx.companyId));
  const pathOf = (id: string, seen = new Set<string>()): string => {
    const c = existing.find((r) => r.id === id);
    if (!c || seen.has(id)) return '';
    seen.add(id);
    return c.parentId ? `${pathOf(c.parentId, seen)}:${c.name}` : c.name;
  };
  const byPath = new Map<string, string>();
  for (const c of existing) byPath.set(normPath(pathOf(c.id)), c.id);

  const sorted = [...rows].sort((a, b) => a.name.split(':').length - b.name.split(':').length);
  for (const cls of sorted) {
    const segs = cls.name.split(':').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) continue;
    if (byPath.has(normPath(cls.name))) {
      counts.skipped++;
      counts.issues.push({ entity: 'class', name: cls.name, reason: 'duplicate', message: `Class "${cls.name}" already exists.` });
      continue;
    }
    let parentId: string | null = null;
    let path = '';
    for (const seg of segs) {
      path = path ? `${path}:${seg}` : seg;
      let id = byPath.get(normPath(path));
      if (!id) {
        try {
          const row = await createClass(ctx, { name: seg, parentId });
          id = row.id;
          byPath.set(normPath(path), id);
          existing.push({ id, name: seg, parentId });
          counts.classes++;
        } catch (caught) {
          const err = importRowError(caught) ?? caught;
          if (err instanceof ServiceError && err.code === 'VALIDATION') {
            counts.skipped++;
            counts.issues.push({ entity: 'class', name: cls.name, reason: 'validation', message: err.message });
            break;
          }
          throw err;
        }
      }
      parentId = id;
    }
  }
  return byPath;
}

/** Look up rows of a name-keyed table (lowercase name → id). */
async function nameMap(ctx: ServiceContext, table: typeof priceLevels | typeof taxRates): Promise<Map<string, string>> {
  const rows = await ctx.db.select({ id: table.id, name: table.name }).from(table).where(eq(table.companyId, ctx.companyId));
  return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
}

async function typeIdMap(ctx: ServiceContext, kind: 'customer' | 'vendor'): Promise<Map<string, string>> {
  const schema = await import('@/lib/db/schema');
  const table = kind === 'customer' ? schema.customerTypes : schema.vendorTypes;
  const rows = await ctx.db.select().from(table).where(eq(table.companyId, ctx.companyId));
  const pathOf = (id: string): string => {
    const r = rows.find((e) => e.id === id);
    return r ? (r.parentId ? `${pathOf(r.parentId)}:${r.name}` : r.name) : '';
  };
  return new Map(rows.map((r) => [normPath(pathOf(r.id)), r.id]));
}

const toCustomerAddress = (a: IIFAddress | null | undefined): CustomerAddress | null =>
  a ? { line1: a.line1 ?? '', line2: a.line2, city: a.city ?? '', state: a.state ?? '', zip: a.zip ?? '', country: a.country ?? '' } : null;

async function importIifCustomers(ctx: ServiceContext, counts: ImportCounts, rows: IIFCustomer[]) {
  const existing = await ctx.db
    .select({ id: customersTable.id, name: customersTable.displayName })
    .from(customersTable)
    .where(eq(customersTable.companyId, ctx.companyId));
  const idByName = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  const ctypes = await typeIdMap(ctx, 'customer');
  const levels = await nameMap(ctx, priceLevels);
  const lists = await L.listIdMaps(ctx);
  const rates = await nameMap(ctx, taxRates);
  const jobRows = await ctx.db
    .select({ name: jobsTable.name, customerId: jobsTable.customerId })
    .from(jobsTable)
    .where(eq(jobsTable.companyId, ctx.companyId));
  const jobKeys = new Set(jobRows.map((j) => `${j.customerId}|${j.name.toLowerCase()}`));

  const sorted = [...rows].sort((a, b) => a.name.split(':').length - b.name.split(':').length);
  for (const cust of sorted) {
    const displayName = cust.name.split(':').map((s) => s.trim()).filter(Boolean).join(':');
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({ entity: 'customer', name: '(blank)', reason: 'validation', message: 'Customer row has no name.' });
      continue;
    }
    if (idByName.has(displayName.toLowerCase())) {
      counts.skipped++;
      counts.issues.push({ entity: 'customer', name: displayName, reason: 'duplicate', message: `Customer "${displayName}" already exists.` });
      continue;
    }

    // Parent customer for "Customer:Job" (created on the fly when the file lacks it).
    const segs = displayName.split(':');
    let parentId: string | null = null;
    let parentProblem: string | null = null;
    for (let i = 1; i < segs.length && !parentProblem; i++) {
      const pName = segs.slice(0, i).join(':');
      let pid = idByName.get(pName.toLowerCase());
      if (!pid) {
        try {
          const p = await createCustomer(ctx, { displayName: pName, parentId });
          pid = p.id;
          idByName.set(pName.toLowerCase(), pid);
          counts.customers++;
        } catch (caught) {
          const err = importRowError(caught);
          if (err?.code !== 'VALIDATION') throw caught;
          parentProblem = `Its parent "${pName}" could not be created: ${err.message}`;
          break;
        }
      }
      parentId = pid;
    }
    if (parentProblem) {
      counts.skipped++;
      counts.issues.push({ entity: 'customer', name: displayName, reason: 'validation', message: parentProblem });
      continue;
    }

    const fields: Record<string, string> = { ...(cust.fields ?? {}) };
    let taxRateId: string | null = null;
    if (cust.taxItem) {
      taxRateId = rates.get(cust.taxItem.toLowerCase()) ?? null;
      if (!taxRateId) fields['Tax Item'] = cust.taxItem;
    }
    const limit = cust.creditLimit ? parseIifAmount(cust.creditLimit) : null;

    try {
      const row = await createCustomer(ctx, {
        displayName,
        companyName: cust.companyName ?? null,
        email: cust.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cust.email) ? cust.email : null,
        phone: cust.phone ?? null,
        billingAddress: cust.billing ? toCustomerAddress(cust.billing) : null,
        shippingAddress: cust.shipping ? toCustomerAddress(cust.shipping) : null,
        terms: normalizeTerms(cust.terms) ?? undefined,
        creditLimit: limit,
        taxable: cust.taxable ?? true,
        taxRateId,
        parentId,
        notes: cust.notes ?? null,
      });
      if (cust.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cust.email)) fields['Email (as in QuickBooks)'] = cust.email;
      idByName.set(displayName.toLowerCase(), row.id);
      counts.customers++;

      // Columns createCustomer does not take: type, price level, inactive flag, custom fields.
      const patch: Partial<typeof customersTable.$inferInsert> = {};
      if (cust.customerType) {
        const id = ctypes.get(normPath(cust.customerType));
        if (id) patch.customerTypeId = id;
        else fields['Customer Type'] = cust.customerType;
      }
      if (cust.priceLevel) {
        const id = levels.get(cust.priceLevel.toLowerCase());
        if (id) patch.priceLevelId = id;
        else fields['Price Level'] = cust.priceLevel;
      }
      // Terms / Sales Tax Code list entries (imported from TERMS / SALESTAXCODE sections or
      // already on the lists): link the real entries, as QuickBooks does.
      const termsId = cust.terms ? lists.termsByName.get(cust.terms.toLowerCase()) : undefined;
      if (termsId) {
        patch.termsId = termsId;
      }
      if (cust.salesTaxCode) {
        const code = lists.taxCodeByCode.get(cust.salesTaxCode.toLowerCase());
        if (code) {
          patch.salesTaxCodeId = code.id;
          patch.taxable = code.taxable;
          delete fields['Sales Tax Code'];
        }
      }
      if (cust.hidden) patch.isActive = false;
      if (Object.keys(fields).length) patch.customFields = fields;
      if (Object.keys(patch).length) {
        await ctx.db.update(customersTable).set({ ...patch, updatedAt: new Date() }).where(eq(customersTable.id, row.id));
        await writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: row.id, newValues: patch });
      }

      // A job (sub-customer) also becomes a job for job costing under its parent.
      if (parentId) {
        const leaf = segs[segs.length - 1];
        const key = `${parentId}|${leaf.toLowerCase()}`;
        if (!jobKeys.has(key)) {
          try {
            const job = await createJob(ctx, {
              customerId: parentId,
              name: leaf,
              startDate: parseIifDate(cust.raw?.JOBSTART) ?? null,
              endDate: parseIifDate(cust.raw?.JOBEND) ?? null,
            });
            jobKeys.add(key);
            counts.jobs++;
            const jobTypeName = cust.raw?.JOBTYPE?.trim();
            const jobTypeId = jobTypeName ? lists.jobTypeByName.get(jobTypeName.split(':').pop()!.trim().toLowerCase()) : undefined;
            if (jobTypeId) await assignJobType(ctx, job.id, jobTypeId);
          } catch (caught) {
            const err = importRowError(caught) ?? caught;
            if (err instanceof ServiceError && err.code === 'VALIDATION') {
              counts.issues.push({ entity: 'job', name: displayName, reason: 'validation', message: err.message });
            } else throw err;
          }
        }
      }
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'customer', name: displayName, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }
}

async function importIifVendors(ctx: ServiceContext, counts: ImportCounts, rows: IIFVendor[]) {
  const vtypes = await typeIdMap(ctx, 'vendor');
  const lists = await L.listIdMaps(ctx);
  for (const vend of rows) {
    const displayName = vend.name.trim();
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({ entity: 'vendor', name: '(blank)', reason: 'validation', message: 'Vendor row has no name.' });
      continue;
    }
    const existing = await ctx.db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(and(eq(vendorsTable.companyId, ctx.companyId), eq(vendorsTable.displayName, displayName)));
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({ entity: 'vendor', name: displayName, reason: 'duplicate', message: `Vendor "${displayName}" already exists.` });
      continue;
    }
    const a = vend.address;
    const fields: Record<string, string> = { ...(vend.fields ?? {}) };
    const emailOk = !vend.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vend.email);
    if (!emailOk) fields['Email (as in QuickBooks)'] = vend.email!;
    try {
      const row = await createVendor(ctx, {
        displayName,
        companyName: vend.companyName ?? null,
        email: emailOk ? vend.email ?? null : null,
        phone: vend.phone ?? null,
        address: a
          ? Object.fromEntries(
              Object.entries({ street: a.line1, line2: a.line2, city: a.city, state: a.state, zip: a.zip, country: a.country })
                .map(([k, v]) => [k, v ?? '']),
            )
          : null,
        terms: normalizeTerms(vend.terms) ?? undefined,
        is1099: !!vend.is1099,
        taxId: vend.taxId ?? null,
        notes: vend.notes ?? null,
      });
      counts.vendors++;
      const patch: Partial<typeof vendorsTable.$inferInsert> = {};
      if (vend.vendorType) {
        const id = vtypes.get(normPath(vend.vendorType));
        if (id) patch.vendorTypeId = id;
        else fields['Vendor Type'] = vend.vendorType;
      }
      const vTermsId = vend.terms ? lists.termsByName.get(vend.terms.toLowerCase()) : undefined;
      if (vTermsId) {
        patch.termsId = vTermsId;
      }
      if (vend.hidden) patch.isActive = false;
      if (Object.keys(fields).length) patch.customFields = fields;
      if (Object.keys(patch).length) {
        await ctx.db.update(vendorsTable).set({ ...patch, updatedAt: new Date() }).where(eq(vendorsTable.id, row.id));
        await writeAudit(ctx, { action: 'update', entityType: 'vendor', entityId: row.id, newValues: patch });
      }
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'vendor', name: displayName, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }
}

/** Split a QB employee name ("Last, First" or "First Last"). */
export function splitEmployeeName(raw: string): { firstName: string; lastName: string } {
  if (raw.includes(',')) {
    const [last, first] = raw.split(',').map((s) => s.trim());
    return { firstName: first || last, lastName: last };
  }
  const parts = raw.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

async function importIifEmployees(ctx: ServiceContext, counts: ImportCounts, rows: IIFEmployee[]) {
  for (const emp of rows) {
    const raw = emp.name.trim();
    if (!raw && !emp.firstName) continue;
    const split = splitEmployeeName(raw || `${emp.firstName ?? ''} ${emp.lastName ?? ''}`);
    const firstName = emp.firstName ?? split.firstName;
    const lastName = emp.lastName ?? split.lastName;

    const existing = await ctx.db
      .select({ id: employeesTable.id })
      .from(employeesTable)
      .where(
        and(
          eq(employeesTable.companyId, ctx.companyId),
          eq(employeesTable.firstName, firstName),
          eq(employeesTable.lastName, lastName),
        ),
      );
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({ entity: 'employee', name: raw, reason: 'duplicate', message: `Employee "${firstName} ${lastName}" already exists.` });
      continue;
    }

    const payTypeRaw = (emp.payType ?? '').toLowerCase();
    const payType = /sal/.test(payTypeRaw) ? 'salary' : /comm/.test(payTypeRaw) ? 'commission' : 'hourly';
    const rate = emp.payRate ? parseIifAmount(emp.payRate) : null;
    try {
      const row = await createEmployee(ctx, {
        firstName,
        lastName,
        email: emp.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emp.email) ? emp.email : null,
        payType,
        payRate: rate && Money.gte(rate, 0) ? rate : 0,
      });
      counts.employees++;

      // Everything createEmployee does not take goes through updateEmployee, which
      // normalizes the SSN and masks it in the audit trail (never logged in full).
      const w4: Record<string, unknown> = {};
      if (emp.filingStatus) {
        const fs = emp.filingStatus.toLowerCase();
        w4.filingStatus = /head/.test(fs) ? 'head_of_household' : /married/.test(fs) && !/separ/.test(fs) ? 'married' : 'single';
      }
      if (emp.allowances && Number.isFinite(Number(emp.allowances))) {
        w4.allowances = Number(emp.allowances);
        w4.formYear = 2019; // allowances only exist on pre-2020 W-4s
      }
      if (emp.extraWithholding) {
        const x = parseIifAmount(emp.extraWithholding);
        if (x) w4.extraWithholding = x;
      }
      if (emp.state && /^[A-Za-z]{2}$/.test(emp.state)) w4.state = emp.state.toUpperCase();
      const ssnDigits = (emp.ssn ?? '').replace(/\D/g, '');
      const hire = parseIifDate(emp.hireDate);
      const release = parseIifDate(emp.releaseDate);
      try {
        await updateEmployee(ctx, row.id, {
          ...(ssnDigits.length === 9 ? { ssn: ssnDigits } : {}),
          ...(emp.address ? { address: emp.address as Record<string, unknown> } : {}),
          ...(Object.keys(w4).length ? { w4 } : {}),
          ...(emp.phone ? { phone: emp.phone } : {}),
          ...(hire ? { hireDate: hire } : {}),
          ...(release ? { releaseDate: release } : {}),
          ...(emp.hidden ? { isActive: false } : {}),
        });
      } catch (caught) {
        const err = importRowError(caught) ?? caught;
        if (err instanceof ServiceError && err.code === 'VALIDATION') {
          counts.issues.push({ entity: 'employee', name: raw, reason: 'validation', message: `Imported, but some details were not saved: ${err.message}` });
        } else throw err;
      }
      if (emp.ssn && ssnDigits.length !== 9) {
        counts.issues.push({ entity: 'employee', name: raw, reason: 'validation', message: 'The SSN in the file is not 9 digits and was not saved.' });
      }
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'employee', name: raw, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Map a QuickBooks INVITEMTYPE / CSV type value to our item type enum. */
export function mapIifItemType(raw: string | undefined): ItemType {
  const k = (raw ?? '').trim().toUpperCase().replace(/[\s_-]/g, '');
  if (!k) return 'service';
  if (k === 'SERVICE' || k === 'SERV') return 'service';
  if (k === 'BUNDLE' || k === 'GROUP' || k === 'GRP' || k === 'ITEMGROUP') return 'bundle';
  if (k === 'OTHC' || k === 'OTHERCHARGE' || k === 'OTHCHG') return 'other_charge';
  if (k === 'DISC' || k === 'DISCOUNT') return 'discount';
  if (k === 'PMT' || k === 'PAYMENT') return 'payment';
  if (k === 'SUBT' || k === 'SUBTOTAL') return 'subtotal';
  if (k === 'STAX' || k === 'COMPTAX' || k === 'SALESTAX' || k === 'SALESTAXITEM' || k === 'SALESTAXGROUP' || k === 'TAXGROUP') {
    return 'sales_tax';
  }
  if (k.startsWith('NONINV') || k === 'NONINVENTORY') return 'non_inventory';
  if (
    k === 'PART' || k === 'INVPART' || k === 'INVENTORY' || k === 'INVENTORYPART' || k === 'STOCK' ||
    k === 'ASSEMBLY' || k === 'INVASSY' || k === 'INVENTORYASSEMBLY' || k === 'ASSY' || k === 'INVASSEMBLY'
  ) {
    return 'inventory';
  }
  return 'non_inventory';
}

/** True for QB item types that carry a bill of materials. */
export function isAssemblyType(raw: string | undefined): boolean {
  const k = (raw ?? '').trim().toUpperCase().replace(/[\s_-]/g, '');
  return k === 'ASSEMBLY' || k === 'INVASSY' || k === 'INVENTORYASSEMBLY' || k === 'ASSY' || k === 'INVASSEMBLY';
}

/** "8.25%" → 8.25 (percent), else null. */
function percentOf(raw: string | undefined): string | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*%\s*$/.exec(raw ?? '');
  return m ? m[1] : null;
}

async function importIifItems(
  ctx: ServiceContext,
  counts: ImportCounts,
  lookup: AccountLookup,
  rows: IIFItem[],
  components: IIFItemComponent[],
  openingOpts: { obDate: Date; carriedAccountIds: Set<string> } = { obDate: new Date(), carriedAccountIds: new Set() },
) {
  const rates = await nameMap(ctx, taxRates);
  for (const item of rows) {
    const type = mapIifItemType(item.itemType);
    const pct = percentOf(item.price);
    let salesPrice = pct ? null : parseIifAmount(item.price);
    let purchaseCost = parseIifAmount(item.cost);
    let description = item.desc ?? null;
    if (pct) description = [description, `Rate: ${pct}%`].filter(Boolean).join(' — ');
    let income = item.incomeAccount;
    let cogs = item.cogsAccount;
    let asset = item.assetAccount;
    if (type === 'subtotal') {
      salesPrice = null;
      purchaseCost = null;
      income = cogs = asset = undefined;
    }
    if (type === 'payment') income = cogs = asset = undefined;
    if (type === 'sales_tax' && pct) salesPrice = toAmountString(pct);
    const created = await importItemRow(ctx, counts, lookup, {
      name: item.name,
      type,
      description,
      salesPrice,
      purchaseCost,
      incomeAccountRef: income,
      expenseAccountRef: cogs,
      assetAccountRef: asset,
      taxable: item.taxable,
      inactive: item.hidden,
      reorderPoint: item.reorderPoint ? parseIifAmount(item.reorderPoint) : null,
      opening: openingFromRow(item.quantityOnHand, item.totalValue, purchaseCost, item.asOf, openingOpts.obDate),
      carriedAccountIds: openingOpts.carriedAccountIds,
      customFields: item.customFields,
    });
    // A sales tax item (STAX) is also a sales tax RATE so invoices can charge it.
    if (created && type === 'sales_tax' && pct && (item.itemType ?? '').toUpperCase().replace(/\s/g, '') === 'STAX') {
      if (!rates.has(item.name.toLowerCase())) {
        try {
          const r = await createTaxRate(ctx, { name: item.name, rate: Money.of(pct).dividedBy(100).toFixed(6) });
          rates.set(item.name.toLowerCase(), r.id);
        } catch (caught) {
          const err = importRowError(caught) ?? caught;
          if (err instanceof ServiceError && err.code === 'VALIDATION') {
            counts.issues.push({ entity: 'item', name: item.name, reason: 'validation', message: `Tax rate not created: ${err.message}` });
          } else throw err;
        }
      }
    }
  }

  // Group components / assembly BOMs.
  if (!components.length) return;
  const itemRows = await ctx.db
    .select({ id: itemsTable.id, name: itemsTable.name })
    .from(itemsTable)
    .where(eq(itemsTable.companyId, ctx.companyId));
  const idOf = new Map(itemRows.map((r) => [r.name.toLowerCase(), r.id]));
  const byParent = new Map<string, IIFItemComponent[]>();
  for (const c of components) {
    const arr = byParent.get(c.parent) ?? [];
    arr.push(c);
    byParent.set(c.parent, arr);
  }
  for (const [parent, comps] of byParent) {
    const parentId = idOf.get(parent.trim().toLowerCase());
    if (!parentId) {
      counts.issues.push({ entity: 'item', name: parent, reason: 'validation', message: 'Components listed for an item that was not imported.' });
      continue;
    }
    const merged = new Map<string, Decimalish>();
    let ok = true;
    for (const c of comps) {
      const cid = idOf.get(c.component.trim().toLowerCase());
      const qty = parseIifAmount(c.quantity) ?? '1.00';
      if (!cid) {
        counts.issues.push({ entity: 'item', name: parent, reason: 'validation', message: `Component "${c.component}" was not found.` });
        ok = false;
        continue;
      }
      merged.set(cid, (merged.get(cid) ?? Money.zero()).plus(Money.of(qty).abs()));
    }
    if (!merged.size) continue;
    try {
      await setBom(ctx, parentId, [...merged.entries()].map(([componentItemId, quantity]) => ({ componentItemId, quantity: quantity.toString() })));
      counts.lists.INVITEMCOMP = (counts.lists.INVITEMCOMP ?? 0) + 1;
      if (!ok) {
        counts.issues.push({ entity: 'item', name: parent, reason: 'note', message: 'Imported with the components that were found.' });
      }
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.issues.push({ entity: 'item', name: parent, reason: 'validation', message: `Components not saved: ${err.message}` });
      } else throw err;
    }
  }
}

type Decimalish = ReturnType<typeof Money.zero>;

/** Parsed opening stock of an imported item (G1), or the reason it cannot be read. */
type ImportedOpening = OpeningStockInput | { error: string } | null;

/** Quantity cell -> decimal string (QNTY is not money: no 2-dp rounding); null = blank, 'bad' = not a number. */
function parseQuantityCell(raw: string | undefined): string | null | 'bad' {
  const s = (raw ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  const body = neg ? s.slice(1, -1) : s;
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(body)) return 'bad';
  const n = Money.of(body);
  return (neg ? n.negated() : n).toString();
}

/**
 * Opening stock from quantity / total value / cost / as-of cells (IIF INVITEM or CSV columns).
 * The total value wins over the cost; the as-of date defaults to `defaultAsOf`. Null when there
 * is no (or a zero) quantity.
 */
export function openingFromRow(
  qtyRaw: string | undefined,
  valueRaw: string | undefined,
  unitCost: string | null | undefined,
  asOfRaw: string | undefined,
  defaultAsOf: Date,
): ImportedOpening {
  if (!qtyRaw?.trim()) return null;
  const qty = parseQuantityCell(qtyRaw);
  if (qty === 'bad') return { error: `"${qtyRaw}" is not a number.` };
  if (qty === null || Money.of(qty).isZero()) return null;
  let asOf = defaultAsOf;
  if (asOfRaw?.trim()) {
    const d = parseIifDate(asOfRaw);
    if (!d) return { error: `the as-of date "${asOfRaw}" is not a date.` };
    asOf = d;
  }
  if (valueRaw?.trim()) {
    const v = parseIifAmount(valueRaw);
    if (v === null) return { error: `the total value "${valueRaw}" is not a number.` };
    return { openingQuantity: qty, openingValue: v, openingAsOf: asOf };
  }
  if (unitCost != null && unitCost !== '') return { openingQuantity: qty, openingUnitCost: unitCost, openingAsOf: asOf };
  return { error: 'there is no total value and the item has no cost.' };
}

async function importItemRow(
  ctx: ServiceContext,
  counts: ImportCounts,
  lookup: AccountLookup,
  input: {
    name: string;
    sku?: string | null;
    type: ItemType;
    description?: string | null;
    salesPrice?: string | null;
    purchaseCost?: string | null;
    incomeAccountRef?: string;
    expenseAccountRef?: string;
    assetAccountRef?: string;
    taxable?: boolean;
    inactive?: boolean;
    reorderPoint?: string | null;
    /** G1: opening quantity on hand / value / as-of (inventory items). */
    opening?: ImportedOpening;
    /** Inventory asset accounts whose balance the same import already carries (no double count). */
    carriedAccountIds?: Set<string>;
    /** Item custom-field values ({ label: value }). */
    customFields?: Record<string, string>;
  },
): Promise<string | null> {
  const name = input.name.trim();
  if (!name) {
    counts.skipped++;
    counts.issues.push({ entity: 'item', name: '(blank)', reason: 'validation', message: 'Item row has no name.' });
    return null;
  }

  const existing = await ctx.db
    .select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.companyId, ctx.companyId), eq(itemsTable.name, name)));
  if (existing.length) {
    counts.skipped++;
    counts.issues.push({ entity: 'item', name, reason: 'duplicate', message: `Item "${name}" already exists.` });
    return null;
  }

  // Resolve account links by path/name/code; only attach when the type matches what
  // createItem expects, otherwise import the item WITHOUT the link + an issue.
  const resolveLink = (ref: string | undefined, expectedType: string | string[], label: string): string | null => {
    if (!ref?.trim()) return null;
    const r = resolveAccountRef(lookup, ref);
    const types = Array.isArray(expectedType) ? expectedType : [expectedType];
    if (r && !('ambiguous' in r && r.ambiguous) && types.includes((r as AccountRef).type)) return (r as AccountRef).id;
    counts.issues.push({
      entity: 'item',
      name,
      reason: r && 'ambiguous' in r && r.ambiguous ? 'ambiguous-account' : 'unmatched-account',
      message:
        r && 'ambiguous' in r && r.ambiguous
          ? `${label} account "${ref}" matches more than one account — link skipped.`
          : r
            ? `${label} account "${ref}" is not a ${types.join('/')} account — link skipped.`
            : `${label} account "${ref}" was not found — link skipped.`,
    });
    return null;
  };

  // Other charge / discount / sales tax items may point at income, expense or liability.
  const incomeTypes = ['discount', 'sales_tax', 'other_charge'].includes(input.type) ? ['revenue'] : ['revenue'];
  const incomeAccountId = resolveLink(input.incomeAccountRef, incomeTypes, 'Income');
  const expenseAccountId = resolveLink(input.expenseAccountRef, 'expense', 'Expense/COGS');
  const assetAccountId = resolveLink(input.assetAccountRef, 'asset', 'Inventory asset');

  const itemInput: CreateItemInput = {
    name,
    sku: input.sku ?? null,
    type: input.type,
    description: input.description ?? null,
    salesPrice: input.salesPrice ?? null,
    purchaseCost: input.purchaseCost ?? null,
    incomeAccountId,
    expenseAccountId,
    assetAccountId,
    ...(input.taxable !== undefined ? { taxable: input.taxable } : {}),
  };

  // G1: opening quantity on hand, posted through the New Item path when it can be.
  let opening: OpeningStockInput | null = null;
  if (input.opening) {
    const skip = (message: string) =>
      counts.issues.push({ entity: 'item', name, reason: 'note', message: `Quantity on hand not imported: ${message}` });
    if (input.type !== 'inventory') skip('only inventory items carry a quantity on hand.');
    else if ('error' in input.opening) skip(input.opening.error);
    else {
      try {
        planOpeningStock(input.opening, input.type);
        opening = input.opening;
      } catch (caught) {
        const err = importRowError(caught) ?? caught;
        if (err instanceof ServiceError && err.code === 'VALIDATION') skip(err.message);
        else throw err;
      }
    }
  }
  // The file already brings in the inventory asset account's balance: create the stock (layer,
  // quantity, average cost) without posting it again.
  const assetIdForStock = assetAccountId ?? lookup.byCode.get('1300')?.id ?? null;
  const ledgerCarried = !!opening && !!assetIdForStock && !!input.carriedAccountIds?.has(assetIdForStock);

  try {
    let row: Awaited<ReturnType<typeof createItem>>;
    if (opening) {
      try {
        row = (await createItemWithOpeningStock(ctx, { ...itemInput, ...opening }, { postToLedger: !ledgerCarried })).item;
      } catch (err) {
        // e.g. the as-of date is on or before the closing date: import the item without stock.
        if (!(err instanceof ServiceError) || err.code === 'VALIDATION') throw err;
        counts.issues.push({ entity: 'item', name, reason: 'note', message: `Quantity on hand not imported: ${err.message}` });
        opening = null;
        row = await createItem(ctx, itemInput);
      }
    } else {
      row = await createItem(ctx, itemInput);
    }
    if (opening) {
      const plan = planOpeningStock(opening, input.type);
      const prev = counts.openingStock ?? { items: 0, value: '0.00' };
      counts.openingStock = {
        items: prev.items + 1,
        value: toAmountString(Money.of(prev.value).plus(plan ? plan.value : 0)),
        ...(ledgerCarried || prev.unposted ? { unposted: (prev.unposted ?? 0) + (ledgerCarried ? 1 : 0) } : {}),
      };
      if (ledgerCarried) {
        counts.issues.push({
          entity: 'item',
          name,
          reason: 'note',
          message:
            'Quantity on hand imported without a journal entry: the balance of the inventory asset account is already in the books ' +
            '(this file or your General Ledger import brings it in), so posting the stock again would count it twice. ' +
            'Check that the item values add up to that balance.',
        });
      }
    }
    counts.items++;
    const patch: Partial<typeof itemsTable.$inferInsert> = {};
    if (input.inactive) patch.isActive = false;
    if (input.reorderPoint && input.type === 'inventory') patch.reorderPoint = input.reorderPoint;
    if (input.customFields && Object.keys(input.customFields).length) patch.customFields = input.customFields;
    if (Object.keys(patch).length) {
      await ctx.db.update(itemsTable).set({ ...patch, updatedAt: new Date() }).where(eq(itemsTable.id, row.id));
      await writeAudit(ctx, { action: 'update', entityType: 'item', entityId: row.id, newValues: patch });
    }
    return row.id;
  } catch (caught) {
    const err = importRowError(caught) ?? caught;
    if (err instanceof ServiceError && err.code === 'VALIDATION') {
      counts.skipped++;
      counts.issues.push({ entity: 'item', name, reason: 'validation', message: err.message });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// IIF transactions — TRNS/SPL blocks posted through the GL engine
// ---------------------------------------------------------------------------

/** Name + code of the bucket that collects auto-created unmatched IIF accounts. */
export const QB_IMPORT_BUCKET = { code: 'QB-IMPORT', name: 'QB Import (review)' } as const;

/**
 * Get-or-create the "QB Import (review)" parent bucket, then get-or-create a child account
 * for an unmatched IIF account name. Created as an expense account so debits/credits land
 * somewhere visible until the user re-files it.
 */
async function ensureBucketAccount(
  ctx: ServiceContext,
  counts: ImportCounts,
  lookup: AccountLookup,
  ref: string,
): Promise<AccountRef | null> {
  let parent = lookup.byCode.get(QB_IMPORT_BUCKET.code) ?? null;
  if (!parent) {
    const created = await createAccount(ctx, {
      code: QB_IMPORT_BUCKET.code,
      name: QB_IMPORT_BUCKET.name,
      type: 'expense' as never,
      subtype: 'operating_expenses',
      description: 'Auto-created bucket for unmatched accounts from QuickBooks IIF import.',
    });
    parent = { id: created.id, type: 'expense', subtype: created.subtype, code: created.code, name: created.name, path: created.name };
    addToLookup(lookup, parent);
  }

  // The account holds the name as written (up to the 255 characters an account name can hold);
  // a name without Latin letters or digits ("Касса", "現金") still gets a stable code. Without
  // these the transaction was skipped (or the whole import stopped on a raw database error),
  // while the open-items step had already applied its A/R / A/P rows to the documents.
  const name = ref.trim().slice(0, 255);
  if (name.length < ref.trim().length) {
    // A re-import of a name longer than an account name can hold: the account an earlier import
    // made for it under the review bucket (its name is the first 255 characters).
    const made = (lookup.byLowerName.get(name.toLowerCase()) ?? []).filter((a) => a.path.startsWith(`${parent!.path}:`));
    if (made.length === 1) {
      lookup.byPath.set(normPath(ref), made[0]);
      return made[0];
    }
  }
  let code = sanitiseCode(name) || `QB-${createHash('sha256').update(name).digest('hex').slice(0, 8).toUpperCase()}`;
  if (lookup.byCode.has(code)) {
    const free = await findAvailableCode(ctx, code);
    if (!free) return null;
    code = free;
  }
  const created = await createAccount(ctx, {
    code,
    name,
    type: 'expense' as never,
    subtype: 'operating_expenses',
    parentId: parent.id,
    description: `Auto-created by IIF import (unmatched account "${ref}").`,
  });
  const entry: AccountRef = { id: created.id, type: 'expense', subtype: created.subtype, code, name, path: `${parent.path}:${name}` };
  addToLookup(lookup, entry);
  // Later references to the same unmatched name resolve to this account.
  lookup.byPath.set(normPath(ref), entry);
  counts.issues.push({
    entity: 'account',
    name,
    code,
    reason: 'unmatched-account',
    message: `Account "${ref}" was not found — created under "${QB_IMPORT_BUCKET.name}" for review.`,
  });
  return entry;
}

/**
 * The review-bucket account for an IIF account reference that is not in the books, or the reason
 * (a row problem) it cannot be made. Shared by the transaction import and the open-items control
 * rows (collectIifControlRows), so a transaction is posted exactly when its A/R / A/P rows are
 * applied to the open documents. Never throws for a value the database cannot hold.
 */
async function bucketAccountOrProblem(
  ctx: ServiceContext,
  counts: ImportCounts,
  lookup: AccountLookup,
  ref: string,
): Promise<AccountRef | string> {
  try {
    return (await ensureBucketAccount(ctx, counts, lookup, ref || '(no account)')) ?? 'A row has an unresolvable account.';
  } catch (caught) {
    const err = importRowError(caught);
    if (!err) throw caught;
    return `Account "${(ref || '').slice(0, 60)}" could not be created: ${err.message}`;
  }
}

/**
 * Identity of an IIF transaction across imports (before the occurrence counter): type, number,
 * date, total and the customer / vendor it is for. The name matters: two payments with no
 * DOCNUM on the same day for the same amount from different customers are different money.
 */
function iifBaseKey(txn: IIFTransaction, date: Date, totalDebit: ReturnType<typeof Money.zero>): string {
  const rawName = (txn.name?.trim() || (txn.lines.find((l) => l.name && l.name.trim())?.name ?? '')).trim();
  const name = rawName.replace(/\s+/g, ' ').toLowerCase();
  const key = `iif:${txn.type || 'TRNS'}:${txn.num || 'no-num'}:${date.toISOString().slice(0, 10)}:${toAmountString(totalDebit)}${name ? `:${encodeURIComponent(name)}` : ''}`;
  // journal_entries.source_ref holds 255 characters (with the ':<occurrence>' suffix). A longer
  // key (long DOCNUM / TRNSTYPE, a long or accented "Customer:Job" name) keeps a readable prefix
  // and a hash of the whole key, still stable across re-imports. Shorter keys are unchanged, so
  // files imported before keep matching their entries.
  if (key.length <= IIF_KEY_MAX) return key;
  return `${key.slice(0, IIF_KEY_MAX - 33)}#${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}
const IIF_KEY_MAX = 240;

/**
 * Named A/R and A/P rows of the transactions importIifTransactions will actually post (date
 * readable, every amount readable and unambiguous, rows balanced and within the ledger limits,
 * date not in a closed period or on/before the closing date — the same checks postJournalEntry
 * makes). Used to apply payments and other control-account activity to the open documents when
 * those come in as documents. A transaction the ledger would refuse must never move a
 * customer's or vendor's balance, or its money would disappear.
 */
async function collectIifControlRows(
  ctx: ServiceContext,
  transactions: IIFTransaction[],
  lookup: AccountLookup,
  counts: ImportCounts,
): Promise<IifControlRow[]> {
  const out: IifControlRow[] = [];
  // Same source references importIifTransactions gives these transactions (see there).
  const seenKeys = new Map<string, number>();
  for (const txn of transactions) {
    const date = parseIifDate(txn.date);
    if (!date) continue;
    const rows: IifControlRow[] = [];
    const probe: PostingLine[] = [];
    let net = Money.zero();
    let totalDebit = Money.zero();
    let ok = true;
    let nonZero = 0;
    for (const l of txn.lines) {
      const amt = parseIifAmount(l.amount);
      if (amt === null) {
        ok = false;
        break;
      }
      if (Money.isZero(amt)) continue;
      nonZero++;
      net = net.plus(toAmountString(amt));
      const abs = toAmountString(Money.abs(amt));
      if (Money.isPositive(amt)) totalDebit = totalDebit.plus(abs);
      probe.push({ accountId: '', debit: Money.isPositive(amt) ? abs : null, credit: Money.isPositive(amt) ? null : abs });
      const resolved = resolveAccountRef(lookup, l.accnt);
      if (resolved && 'ambiguous' in resolved && resolved.ambiguous) {
        ok = false;
        break;
      }
      let acct = resolved as AccountRef | null;
      if (!acct) {
        // Exactly what importIifTransactions does with an account the books lack: its review
        // account, or — when none can be made — the transaction is not posted, so its rows must
        // not touch the documents either (they did: a skipped payment still reduced the invoice).
        const made = await bucketAccountOrProblem(ctx, counts, lookup, l.accnt);
        if (typeof made === 'string') {
          ok = false;
          break;
        }
        acct = made;
      }
      if (acct.code === '1250') continue;
      const side = acct.subtype === 'accounts_receivable' ? 'ar' : acct.subtype === 'accounts_payable' ? 'ap' : null;
      const name = (l.name ?? txn.name ?? '').trim();
      if (!side || !name) continue;
      rows.push({ side, name, amount: toAmountString(amt), date: date.toISOString().slice(0, 10) });
    }
    if (!ok || nonZero < 2 || !net.isZero()) continue;
    const baseKey = iifBaseKey(txn, date, totalDebit);
    const occurrence = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, occurrence + 1);
    if (!rows.length) continue;
    const ref = `${baseKey}:${occurrence}`;
    const [dup] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, ref)));
    if (dup) {
      // Posted by an earlier import (the ledger skips it now): applied back then already.
      out.push(...rows.map((r) => ({ ...r, ref, posted: true })));
      continue;
    }
    try {
      assertBalanced(probe);
      await assertPeriodOpen(ctx, date);
    } catch (err) {
      if (err instanceof ServiceError) continue; // postJournalEntry will refuse it too
      throw err;
    }
    out.push(...rows.map((r) => ({ ...r, ref })));
  }
  return out;
}

/**
 * Get or create the customer (A/R) / vendor (A/P) an IIF control line names, register it with the
 * resolver and note it in the import report. "Customer:Job" creates the parent chain first.
 */
async function ensureIifName(
  ctx: ServiceContext,
  counts: ImportCounts,
  names: Awaited<ReturnType<typeof loadQbNameResolver>>,
  side: 'ar' | 'ap',
  rawName: string,
): Promise<string | null> {
  const full = rawName.split(':').map((s) => s.trim()).filter(Boolean).join(':');
  const role = side === 'ar' ? 'customer' : 'vendor';
  const hit = names.resolve(full, { side });
  if (hit) return hit.entityId;
  try {
    return await createIifName(ctx, counts, names, side, full);
  } catch (caught) {
    // e.g. two customers already share the name (ambiguous): the line stays unnamed, as before.
    const err = importRowError(caught);
    if (err?.code !== 'VALIDATION') throw caught;
    counts.issues.push({ entity: role, name: full, reason: 'validation', message: `Could not add it to your ${role} list: ${err.message}` });
    return null;
  }
}

async function createIifName(
  ctx: ServiceContext,
  counts: ImportCounts,
  names: Awaited<ReturnType<typeof loadQbNameResolver>>,
  side: 'ar' | 'ap',
  full: string,
): Promise<string> {
  const role = side === 'ar' ? 'customer' : 'vendor';
  let id: string;
  if (side === 'ap') {
    id = (await createVendor(ctx, { displayName: full })).id;
    counts.vendors++;
  } else {
    const segs = full.split(':');
    let parentId: string | null = null;
    for (let i = 1; i <= segs.length; i++) {
      const path = segs.slice(0, i).join(':');
      const existing = names.resolve(path, { side: 'ar' });
      if (existing && i < segs.length) {
        parentId = existing.entityId;
        continue;
      }
      const row = await createCustomer(ctx, { displayName: path, parentId });
      names.add('customer', path, row.id);
      counts.customers++;
      parentId = row.id;
    }
    id = parentId!;
  }
  names.add(role, full, id);
  counts.issues.push({
    entity: role,
    name: full,
    reason: 'note',
    message: `Not on your ${role} list — added so its ${side === 'ar' ? 'Accounts Receivable' : 'Accounts Payable'} lines keep the name.`,
  });
  return id;
}

/** The kind of name a QB transaction type carries (the Name column's list). */
export function iifRoleOfType(type: string | null | undefined): QbNameRole | null {
  const t = (type ?? '').trim().toUpperCase();
  if (['INVOICE', 'PAYMENT', 'CREDIT MEMO', 'CREDITMEMO', 'CASH SALE', 'SALES RECEIPT', 'ESTIMATE', 'STMT CHG', 'CUSTOMER REFUND'].includes(t)) return 'customer';
  if (['BILL', 'BILLCRED', 'BILL REFUND', 'BILLPMT', 'BILL PMT -CHECK', 'BILL PMT -CCARD', 'CHECK', 'CREDIT CARD', 'CC CREDIT', 'ITEM RECEIPT', 'PURCHORD'].includes(t)) return 'vendor';
  if (['PAYCHECK', 'LIABILITY ADJUSTMENT', 'YTD ADJUSTMENT'].includes(t)) return 'employee';
  return null;
}

async function importIifTransactions(
  ctx: ServiceContext,
  counts: ImportCounts,
  transactions: IIFTransaction[],
  lookup: AccountLookup,
  classIdByPath: Map<string, string>,
  /** Open items were brought in as documents: re-point A/R and A/P rows here (see importIIF). */
  redirectControl?: { accountId: string },
): Promise<void> {
  const seenKeys = new Map<string, number>();
  const isControl = (a: AccountRef) =>
    (a.subtype === 'accounts_receivable' || a.subtype === 'accounts_payable') && a.code !== '1250';
  // QB Name column → journal line name (customer / vendor / employee / other name).
  const names = await loadQbNameResolver(ctx);

  for (const txn of transactions) {
    const label = `${txn.type || 'TRNS'}${txn.num ? ` #${txn.num}` : ''}`;

    const date = parseIifDate(txn.date);
    if (!date) {
      counts.skipped++;
      counts.issues.push({ entity: 'transaction', name: label, reason: 'validation', message: `Missing or unparseable date "${txn.date ?? ''}".` });
      continue;
    }

    const lines: PostingLine[] = [];
    const missingNames: Array<{ line: number; side: 'ar' | 'ap'; name: string }> = [];
    let totalDebit = Money.zero();
    let problem: string | null = null;
    let redirected = false;
    for (const l of txn.lines) {
      const amt = parseIifAmount(l.amount);
      if (amt === null) {
        problem = 'A row has an unreadable amount.';
        break;
      }
      if (Money.isZero(amt)) continue;

      const resolved = resolveAccountRef(lookup, l.accnt);
      let acct: AccountRef | null = null;
      if (resolved && 'ambiguous' in resolved && resolved.ambiguous) {
        problem = `Account "${l.accnt}" matches more than one account (${resolved.candidates.map((c) => c.path).join(', ')}). Use the full "Parent:Sub" name.`;
        break;
      } else if (resolved) {
        acct = resolved as AccountRef;
      } else {
        const made = await bucketAccountOrProblem(ctx, counts, lookup, l.accnt);
        if (typeof made === 'string') {
          problem = made;
          break;
        }
        acct = made;
      }
      const classId = l.className ? classIdByPath.get(normPath(l.className)) ?? null : null;
      const isDebit = Money.isPositive(amt);
      const abs = toAmountString(Money.abs(amt));
      if (isDebit) totalDebit = totalDebit.plus(abs);
      const toConversion = !!redirectControl && isControl(acct);
      if (toConversion) redirected = true;
      const baseMemo = l.memo ?? (l.name ? `Payee: ${l.name}` : null);
      const side = toConversion ? null : controlSideOfAccount(acct);
      const rawName = (l.name || (side ? txn.name : '') || '').trim();
      const named = names.resolve(rawName, {
        side,
        prefer: iifRoleOfType(txn.type),
      });
      // An A/R line's name is a customer and an A/P line's a vendor (QB's rule). A name the lists
      // don't have yet is added just before the entry posts (QuickBooks adds it on import too), so
      // the line never lands on A/R or A/P without its name.
      if (side && rawName && !named) missingNames.push({ line: lines.length, side, name: rawName });
      lines.push({
        accountId: toConversion ? redirectControl!.accountId : acct.id,
        ...(named ? { entityType: named.entityType, entityId: named.entityId } : {}),
        debit: isDebit ? abs : null,
        credit: isDebit ? null : abs,
        memo: toConversion
          ? `QB conversion (was ${acct.path}${l.name ? `, ${l.name}` : ''})${baseMemo ? ` — ${baseMemo}` : ''}`
          : baseMemo,
        classId,
      });
    }

    if (problem) {
      counts.skipped++;
      counts.issues.push({ entity: 'transaction', name: label, reason: 'validation', message: problem });
      continue;
    }
    if (lines.length < 2) {
      counts.skipped++;
      counts.issues.push({ entity: 'transaction', name: label, reason: 'validation', message: 'Transaction has fewer than two non-zero lines.' });
      continue;
    }

    const totalCredit = lines.reduce((sum, l) => sum.plus(Money.of(l.credit ?? 0)), Money.zero());
    if (!Money.eq(totalDebit, totalCredit)) {
      counts.skipped++;
      counts.issues.push({
        entity: 'transaction',
        name: label,
        reason: 'validation',
        message: `Rows do not balance (debits ${toAmountString(totalDebit)} ≠ credits ${toAmountString(totalCredit)}).`,
      });
      continue;
    }

    const baseKey = iifBaseKey(txn, date, totalDebit);
    const occurrence = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, occurrence + 1);
    const sourceRef = `${baseKey}:${occurrence}`;

    const [dup] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef)));
    if (dup) {
      counts.skipped++;
      counts.issues.push({ entity: 'transaction', name: label, reason: 'duplicate', message: `Already imported (journal entry with source ${sourceRef} exists).` });
      continue;
    }

    try {
      for (const m of missingNames) {
        const id = await ensureIifName(ctx, counts, names, m.side, m.name);
        if (id) lines[m.line] = { ...lines[m.line], entityType: m.side === 'ar' ? 'customer' : 'vendor', entityId: id };
      }
      await postJournalEntry(ctx, {
        date,
        description: txn.memo?.trim() || `QB import: ${label}`,
        // journal_entries.reference holds 100 characters (QB's own DOCNUM is far shorter).
        reference: txn.num ? txn.num.slice(0, 100) : null,
        lines,
        sourceRef,
      });
      counts.transactions++;
      if (redirected) {
        counts.issues.push({
          entity: 'transaction',
          name: label,
          reason: 'note',
          message:
            'Its Accounts Receivable / Payable row was posted to the conversion account, because the open invoices and bills brought in as documents already reflect it.',
        });
      }
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError) {
        counts.skipped++;
        counts.issues.push({ entity: 'transaction', name: label, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CSV / XLSX list imports (column mapping)
// ---------------------------------------------------------------------------

/**
 * Caller-supplied mapping from canonical field names to column headers.
 * All fields are optional; unmapped fields are left null.
 */
export interface CsvColumnMapping {
  displayName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billingAddress_line1?: string;
  billingAddress_line2?: string;
  billingAddress_city?: string;
  billingAddress_state?: string;
  billingAddress_zip?: string;
  billingAddress_country?: string;
  // vendor-specific
  address_line1?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  address_country?: string;
  notes?: string;
  /** Payment terms ("Net 30", "net_30", "Due on receipt"). */
  terms?: string;
  /** Vendors: 1099 vendor (Y / N). */
  is1099?: string;
}

type Row = Record<string, string>;

/** An address object with only the parts that have a value (no empty-string keys). */
function addressOf(parts: Record<string, string>): Record<string, string> | null {
  const out = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, (v ?? '').trim()]).filter(([, v]) => v));
  return Object.keys(out).length ? out : null;
}

function parseCsvRows(content: string): Row[] {
  const parsed = Papa.parse<Row>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => csvUnsafeText(h.trim()),
    // Our own list exports (lib/csv.ts) prefix formula-like cells ("-Acme") with an apostrophe.
    transform: (v) => csvUnsafeText(v.trim()),
  });
  return parsed.data;
}

async function importCustomerRows(ctx: ServiceContext, rows: Row[], mapping: CsvColumnMapping): Promise<ImportCounts> {
  const counts = emptyCounts();
  for (const row of rows) {
    const displayName = mapping.displayName ? (row[mapping.displayName] ?? '').trim() : '';
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({ entity: 'customer', name: '(blank)', reason: 'validation', message: 'Row has no display name value.' });
      continue;
    }
    const existing = await ctx.db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(and(eq(customersTable.companyId, ctx.companyId), eq(customersTable.displayName, displayName)));
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({ entity: 'customer', name: displayName, reason: 'duplicate', message: `Customer "${displayName}" already exists.` });
      continue;
    }
    const part = (key: keyof CsvColumnMapping) => (mapping[key] ? (row[mapping[key]!] ?? '') : '');
    const terms = normalizeTerms(part('terms'));
    try {
      await createCustomer(ctx, {
        displayName,
        companyName: mapping.companyName ? (row[mapping.companyName] || null) : null,
        email: mapping.email ? (row[mapping.email] || null) : null,
        phone: mapping.phone ? (row[mapping.phone] || null) : null,
        // Only the parts the file has (a street-less "Springfield" is still an address).
        billingAddress: addressOf({
          line1: part('billingAddress_line1'),
          line2: part('billingAddress_line2'),
          city: part('billingAddress_city'),
          state: part('billingAddress_state'),
          zip: part('billingAddress_zip'),
          country: part('billingAddress_country'),
        }),
        notes: mapping.notes ? (row[mapping.notes] || null) : null,
        ...(terms ? { terms } : {}),
      });
      counts.customers++;
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'customer', name: displayName, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }
  return counts;
}

/** Parse a CSV string and insert customers using the supplied column mapping. */
export async function importCustomersCSV(ctx: ServiceContext, content: string, mapping: CsvColumnMapping): Promise<ImportCounts> {
  return withImportLock(ctx, () => withPlannerStats(ctx.db, 'customer import', () => importCustomerRows(ctx, parseCsvRows(content), mapping)));
}

async function importVendorRows(ctx: ServiceContext, rows: Row[], mapping: CsvColumnMapping): Promise<ImportCounts> {
  const counts = emptyCounts();
  for (const row of rows) {
    const displayName = mapping.displayName ? (row[mapping.displayName] ?? '').trim() : '';
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({ entity: 'vendor', name: '(blank)', reason: 'validation', message: 'Row has no display name value.' });
      continue;
    }
    const existing = await ctx.db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(and(eq(vendorsTable.companyId, ctx.companyId), eq(vendorsTable.displayName, displayName)));
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({ entity: 'vendor', name: displayName, reason: 'duplicate', message: `Vendor "${displayName}" already exists.` });
      continue;
    }
    const street = mapping.address_line1 ? (row[mapping.address_line1] ?? '') : '';
    const city = mapping.address_city ? (row[mapping.address_city] ?? '') : '';
    const state = mapping.address_state ? (row[mapping.address_state] ?? '') : '';
    const zip = mapping.address_zip ? (row[mapping.address_zip] ?? '') : '';
    const country = mapping.address_country ? (row[mapping.address_country] ?? '') : '';
    const terms = normalizeTerms(mapping.terms ? row[mapping.terms] : '');
    const is1099 = mapping.is1099 ? (row[mapping.is1099] ?? '').trim() : '';
    try {
      await createVendor(ctx, {
        displayName,
        companyName: mapping.companyName ? (row[mapping.companyName] || null) : null,
        email: mapping.email ? (row[mapping.email] || null) : null,
        phone: mapping.phone ? (row[mapping.phone] || null) : null,
        address: street || city ? { street, city, state, zip, country } : null,
        notes: mapping.notes ? (row[mapping.notes] || null) : null,
        ...(terms ? { terms } : {}),
        ...(is1099 ? { is1099: yes(is1099) } : {}),
      });
      counts.vendors++;
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'vendor', name: displayName, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }
  return counts;
}

/** Parse a CSV string and insert vendors using the supplied column mapping. */
export async function importVendorsCSV(ctx: ServiceContext, content: string, mapping: CsvColumnMapping): Promise<ImportCounts> {
  return withImportLock(ctx, () => withPlannerStats(ctx.db, 'vendor import', () => importVendorRows(ctx, parseCsvRows(content), mapping)));
}

/**
 * Caller-supplied mapping from canonical item fields to column headers. Account columns may
 * contain an account NAME, full "Parent:Sub" path or CODE; unresolved links are skipped with an
 * issue (the item still imports).
 */
export interface ItemsCsvMapping {
  name?: string;
  sku?: string;
  type?: string;
  description?: string;
  salesPrice?: string;
  purchaseCost?: string;
  incomeAccount?: string;
  expenseAccount?: string;
  assetAccount?: string;
  /** G1: quantity on hand for new inventory items (posted as opening stock). */
  quantityOnHand?: string;
  /** G1: total value of that quantity (blank = quantity x purchase cost). */
  totalValue?: string;
  /** G1: as-of date of the quantity on hand (blank = today). */
  asOfDate?: string;
  /** Taxable (Y / N); blank keeps the default. */
  taxable?: string;
}

async function importItemRows(ctx: ServiceContext, rows: Row[], mapping: ItemsCsvMapping): Promise<ImportCounts> {
  const counts = emptyCounts();
  const lookup = await loadAccountLookup(ctx);
  // Inventory asset accounts a General Ledger import already filled: quantities on hand for
  // items on them come in without a journal entry (posting them would double the inventory).
  const carriedAccountIds = await glImportedAssetAccountIds(ctx);
  const col = (key: keyof ItemsCsvMapping, row: Row): string => (mapping[key] ? (row[mapping[key]!] ?? '').trim() : '');
  const today = await companyToday(ctx);
  for (const row of rows) {
    const name = col('name', row);
    if (!name) {
      counts.skipped++;
      counts.issues.push({ entity: 'item', name: '(blank)', reason: 'validation', message: 'Row has no item name value.' });
      continue;
    }
    const purchaseCost = parseIifAmount(col('purchaseCost', row)) ?? null;
    const taxable = col('taxable', row);
    await importItemRow(ctx, counts, lookup, {
      ...(taxable ? { taxable: yes(taxable) } : {}),
      name,
      sku: col('sku', row) || null,
      type: mapIifItemType(col('type', row)),
      description: col('description', row) || null,
      salesPrice: parseIifAmount(col('salesPrice', row)) ?? null,
      purchaseCost,
      incomeAccountRef: col('incomeAccount', row) || undefined,
      expenseAccountRef: col('expenseAccount', row) || undefined,
      assetAccountRef: col('assetAccount', row) || undefined,
      // G1: opening quantity on hand / value (or cost) / as-of date.
      opening: openingFromRow(col('quantityOnHand', row), col('totalValue', row), purchaseCost, col('asOfDate', row), today),
      carriedAccountIds,
    });
  }
  return counts;
}

/** Parse a CSV string and insert items using the supplied column mapping. */
export async function importItemsCSV(ctx: ServiceContext, content: string, mapping: ItemsCsvMapping): Promise<ImportCounts> {
  return withImportLock(ctx, () => withPlannerStats(ctx.db, 'item import', () => importItemRows(ctx, parseCsvRows(content), mapping)));
}

export interface AccountsCsvMapping {
  code?: string;
  name?: string;
  /** Accepts our types (asset/liability/equity/revenue/expense) or QB type names (BANK, COGS, …). */
  type?: string;
  subtype?: string;
  description?: string;
  /** Optional parent account (code, name or full path). A "Parent:Sub" name also nests. */
  parent?: string;
}

const OUR_ACCOUNT_TYPES = new Set(['asset', 'liability', 'equity', 'revenue', 'expense']);
const DEFAULT_CSV_SUBTYPE: Record<string, string> = {
  asset: 'checking',
  liability: 'accounts_payable',
  equity: 'owners_equity',
  revenue: 'sales',
  expense: 'operating_expenses',
};

/** Resolve a CSV type/subtype pair: native enum values pass through, QB names map via the IIF table. */
function resolveCsvAccountType(rawType: string, rawSubtype: string): { type: string; subtype: string } {
  const t = rawType.trim().toLowerCase();
  if (OUR_ACCOUNT_TYPES.has(t)) {
    const subtype = rawSubtype.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return { type: t, subtype: subtype || DEFAULT_CSV_SUBTYPE[t] };
  }
  return mapIifType(rawType);
}

async function importAccountRows(ctx: ServiceContext, rows: Row[], mapping: AccountsCsvMapping): Promise<ImportCounts> {
  const counts = emptyCounts();
  const col = (key: keyof AccountsCsvMapping, row: Row): string => (mapping[key] ? (row[mapping[key]!] ?? '').trim() : '');
  // Shallow rows first so "Parent:Sub" names (or a Parent column) find their parent.
  const ordered = [...rows].sort((a, b) => col('name', a).split(':').length - col('name', b).split(':').length);
  const lookup = await loadAccountLookup(ctx);
  for (const row of ordered) {
    const fullName = col('name', row);
    if (!fullName) {
      counts.skipped++;
      counts.issues.push({ entity: 'account', name: '(blank)', reason: 'validation', message: 'Row has no account name value.' });
      continue;
    }
    const segs = fullName.split(':').map((s) => s.trim()).filter(Boolean);
    const name = segs[segs.length - 1];
    const parentRef = col('parent', row) || (segs.length > 1 ? segs.slice(0, -1).join(':') : '');
    let parentId: string | null = null;
    if (parentRef) {
      const p = resolveAccount(lookup, parentRef);
      if (p) parentId = p.id;
      else counts.issues.push({ entity: 'account', name: fullName, reason: 'unmatched-account', message: `Parent "${parentRef}" was not found — imported at the top level.` });
    }
    const { type, subtype } = resolveCsvAccountType(col('type', row), col('subtype', row));
    const created = await importAccountRow(ctx, counts, {
      name,
      code: col('code', row) || undefined,
      type,
      subtype,
      description: col('description', row) || null,
      parentId,
    });
    if (created) {
      const parent = parentId ? [...lookup.byPath.values()].find((r) => r.id === parentId) : null;
      addToLookup(lookup, { id: created.id, type, subtype, code: created.code, name, path: parent ? `${parent.path}:${name}` : name });
    }
  }
  return counts;
}

/**
 * Parse a CSV string and insert chart-of-accounts rows using the supplied column mapping.
 * Dedupe and code-collision behaviour matches importAccountRow so accounts are never
 * silently dropped.
 */
export async function importAccountsCSV(ctx: ServiceContext, content: string, mapping: AccountsCsvMapping): Promise<ImportCounts> {
  return withImportLock(ctx, () => withPlannerStats(ctx.db, 'account import', () => importAccountRows(ctx, parseCsvRows(content), mapping)));
}

// ---------------------------------------------------------------------------
// Excel (.xlsx) list import — the GL-import xlsx reader + the same row importers
// ---------------------------------------------------------------------------

export type ListImportKind = 'customers' | 'vendors' | 'items' | 'accounts';

/** Rows of the first worksheet that has a header row (first row with 2+ non-empty cells). */
export function xlsxRows(bytes: Uint8Array): { headers: string[]; rows: Row[]; sheet: string } {
  const sheets = readXlsx(bytes);
  for (const s of sheets) {
    const hi = s.rows.findIndex((r) => r.cells.filter((c) => c.trim()).length >= 2);
    if (hi < 0) continue;
    const headers = s.rows[hi].cells.map((c) => c.trim());
    const rows: Row[] = [];
    for (const r of s.rows.slice(hi + 1)) {
      if (!r.cells.some((c) => c.trim())) continue;
      const obj: Row = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = (r.cells[i] ?? '').trim();
      });
      rows.push(obj);
    }
    return { headers: headers.filter(Boolean), rows, sheet: s.name };
  }
  return { headers: [], rows: [], sheet: '' };
}

/** Import a customers / vendors / items / accounts list from an .xlsx workbook. */
export async function importListXlsx(
  ctx: ServiceContext,
  kind: ListImportKind,
  bytes: Uint8Array,
  mapping: Record<string, string>,
): Promise<ImportCounts> {
  let rows: Row[];
  try {
    rows = xlsxRows(bytes).rows;
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError('VALIDATION', 'This file could not be read as an Excel workbook (.xlsx).');
  }
  const run = (): Promise<ImportCounts> => {
    switch (kind) {
      case 'customers':
        return importCustomerRows(ctx, rows, mapping as CsvColumnMapping);
      case 'vendors':
        return importVendorRows(ctx, rows, mapping as CsvColumnMapping);
      case 'items':
        return importItemRows(ctx, rows, mapping as ItemsCsvMapping);
      case 'accounts':
        return importAccountRows(ctx, rows, mapping as AccountsCsvMapping);
      default:
        throw new ServiceError('VALIDATION', `Unknown list "${kind as string}".`);
    }
  };
  return withImportLock(ctx, () => withPlannerStats(ctx.db, `${kind} import`, run));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Today as the company's calendar day (Company Preferences time zone), at UTC midnight like every
 * stored date. The UTC day was tomorrow every evening in the Americas (after 7 pm in New York), so
 * opening balances and stock dated "today" landed a day ahead.
 */
async function companyToday(ctx: ServiceContext): Promise<Date> {
  return new Date(`${todayInTimeZone((await getPreferences(ctx)).timezone)}T00:00:00.000Z`);
}

/**
 * Asset accounts holding postings of a QuickBooks General Ledger import (qbgl:* entries). That
 * import brings each account's whole history — the Inventory Asset balance included — so an item
 * list imported afterwards with quantities on hand must not post the same value again.
 */
async function glImportedAssetAccountIds(ctx: ServiceContext): Promise<Set<string>> {
  const rows = await ctx.db
    .selectDistinct({ id: journalEntryLines.accountId })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        like(journalEntries.sourceRef, 'qbgl:%'),
        eq(accounts.type, 'asset'),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Convert an account name to a short alphanumeric code (max 20 chars). */
function sanitiseCode(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toUpperCase()
    .slice(0, 20);
}

/**
 * Find a free variant of a colliding account code within the 20-char limit by
 * appending '-2', '-3', … to a truncated base. Returns null if none is free.
 */
async function findAvailableCode(ctx: ServiceContext, base: string): Promise<string | null> {
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 20 - suffix.length) + suffix;
    const clash = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, candidate)));
    if (!clash.length) return candidate;
  }
  return null;
}
