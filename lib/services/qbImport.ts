/**
 * QuickBooks import helpers.
 *
 * Supports:
 *   - IIF (Intuit Interchange Format) — tab-delimited; header rows start with '!',
 *     data rows follow until the next header or end of file.
 *     parseIIF()  – pure parse, returns normalized objects.
 *     importIIF() – parse then insert via existing services; skips duplicates.
 *     Sections: ACCNT, CUST, VEND, CLASS, INVITEM, EMP, and TRNS/SPL/ENDTRNS
 *     transactions (posted as balanced journal entries; accounts matched by
 *     name/code, unmatched accounts auto-created under a "QB Import (review)"
 *     bucket so nothing is silently dropped).
 *
 *   - CSV lists via papaparse with a user-supplied column mapping:
 *     importCustomersCSV() / importVendorsCSV() / importItemsCSV() / importAccountsCSV().
 *
 * Master-data imports write no journal entries. IIF TRNS transactions DO post
 * to the GL — through postJournalEntry, like every other document — with a
 * sourceRef of `iif:…` so re-importing the same file skips duplicates.
 */
import Papa from 'papaparse';
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  classes as classesTable,
  customers as customersTable,
  employees as employeesTable,
  items as itemsTable,
  journalEntries,
  vendors as vendorsTable,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createClass } from './dimensions';
import { createItem, type ItemType } from './items';
import { createEmployee } from './payroll';
import { postJournalEntry, type PostingLine } from './posting';

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

function mapIifType(iifType: string): { type: string; subtype: string } {
  const key = iifType.trim().toUpperCase();
  return IIF_TYPE_MAP[key] ?? { type: 'expense', subtype: 'operating_expenses' };
}

// ---------------------------------------------------------------------------
// Parsed IIF shapes
// ---------------------------------------------------------------------------

export interface IIFAccount {
  name: string;
  accntType: string;
  desc?: string;
  accnum?: string;
}

export interface IIFCustomer {
  name: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billAddr1?: string;
  billCity?: string;
  billState?: string;
  billZip?: string;
  billCountry?: string;
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
}

export interface IIFClass {
  name: string;
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
}

export interface IIFEmployee {
  name: string;
  email?: string;
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
}

export interface IIFTransaction {
  /** TRNSTYPE, e.g. CHECK, DEPOSIT, GENERAL JOURNAL. */
  type: string;
  /** Raw DATE field from the TRNS row (e.g. 1/15/2024). */
  date?: string;
  /** DOCNUM, if present. */
  num?: string;
  memo?: string;
  lines: IIFTransactionLine[];
}

export interface ParsedIIF {
  accounts: IIFAccount[];
  customers: IIFCustomer[];
  vendors: IIFVendor[];
  classes: IIFClass[];
  items: IIFItem[];
  employees: IIFEmployee[];
  transactions: IIFTransaction[];
}

// ---------------------------------------------------------------------------
// parseIIF
// ---------------------------------------------------------------------------

/**
 * Parse an IIF file string. Header rows (starting with '!') declare the
 * field names for the row type that follows; data rows (same prefix without
 * '!') carry the values. Supported sections: ACCNT, CUST, VEND, CLASS,
 * INVITEM, EMP, and TRNS/SPL/ENDTRNS transaction blocks.
 */
export function parseIIF(content: string): ParsedIIF {
  const result: ParsedIIF = {
    accounts: [],
    customers: [],
    vendors: [],
    classes: [],
    items: [],
    employees: [],
    transactions: [],
  };

  // Normalise line endings, split into non-empty lines.
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());

  // Column headers keyed by row type (a file declares !TRNS and !SPL headers
  // separately; data rows are matched to their own header by first column).
  const headersByType = new Map<string, string[]>();
  let currentTxn: IIFTransaction | null = null;

  const txnLineFrom = (row: Record<string, string>): IIFTransactionLine => ({
    accnt: row.ACCNT ?? '',
    amount: row.AMOUNT ?? '0',
    memo: row.MEMO ?? undefined,
    name: row.NAME ?? undefined,
    className: row.CLASS ?? undefined,
  });

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('!')) {
      // Header row — register column names for this row type.
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
    if (!headers) continue; // data row for a section we do not handle

    const row = zipIIF(headers, cols);

    if (rowType === 'ACCNT') {
      if (row.NAME) {
        result.accounts.push({
          name: row.NAME,
          accntType: row.ACCNTTYPE ?? '',
          desc: row.DESC ?? undefined,
          accnum: row.ACCNUM ?? undefined,
        });
      }
    } else if (rowType === 'CUST') {
      if (row.NAME) {
        result.customers.push({
          name: row.NAME,
          companyName: row.COMPANYNAME ?? undefined,
          email: row.EMAIL ?? undefined,
          phone: row.PHONE1 ?? undefined,
          billAddr1: row.BADDR1 ?? undefined,
          billCity: row.BCITY ?? undefined,
          billState: row.BSTATE ?? undefined,
          billZip: row.BZIP ?? undefined,
          billCountry: row.BCOUNTRY ?? undefined,
        });
      }
    } else if (rowType === 'VEND') {
      if (row.NAME) {
        result.vendors.push({
          name: row.NAME,
          companyName: row.COMPANYNAME ?? undefined,
          email: row.EMAIL ?? undefined,
          phone: row.PHONE1 ?? undefined,
          addr1: row.ADDR1 ?? undefined,
          city: row.CITY ?? undefined,
          state: row.STATE ?? undefined,
          zip: row.ZIP ?? undefined,
          country: row.COUNTRY ?? undefined,
        });
      }
    } else if (rowType === 'CLASS') {
      if (row.NAME) result.classes.push({ name: row.NAME });
    } else if (rowType === 'INVITEM') {
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
        });
      }
    } else if (rowType === 'EMP') {
      if (row.NAME) {
        result.employees.push({ name: row.NAME, email: row.EMAIL ?? undefined });
      }
    } else if (rowType === 'TRNS') {
      // A TRNS row both starts a transaction and carries its first GL line.
      if (currentTxn) result.transactions.push(currentTxn); // missing ENDTRNS — close defensively
      currentTxn = {
        type: row.TRNSTYPE ?? '',
        date: row.DATE ?? undefined,
        num: row.DOCNUM ?? undefined,
        memo: row.MEMO ?? undefined,
        lines: [txnLineFrom(row)],
      };
    } else if (rowType === 'SPL') {
      if (currentTxn) currentTxn.lines.push(txnLineFrom(row));
    }
  }
  if (currentTxn) result.transactions.push(currentTxn); // file ended without ENDTRNS

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
    // ISO-ish YYYY-MM-DD
    year = Number(parts[0]);
    month = Number(parts[1]);
    day = Number(parts[2]);
  } else {
    // QB-style M/D/Y
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
    const val = cols[i]?.trim() ?? '';
    if (val) obj[headers[i]] = val;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

/** Per-row detail for anything that was skipped or imported with an adjustment. */
export interface ImportIssue {
  entity: 'account' | 'customer' | 'vendor' | 'class' | 'item' | 'employee' | 'transaction';
  name: string;
  code?: string;
  reason: 'duplicate' | 'code-collision' | 'validation' | 'unmatched-account';
  message: string;
}

export interface ImportCounts {
  accounts: number;
  customers: number;
  vendors: number;
  classes: number;
  items: number;
  employees: number;
  /** TRNS/SPL blocks posted as balanced journal entries. */
  transactions: number;
  skipped: number;
  /** One entry per skipped row (and per remap/auto-create), so users can see WHY. */
  issues: ImportIssue[];
}

function emptyCounts(): ImportCounts {
  return {
    accounts: 0,
    customers: 0,
    vendors: 0,
    classes: 0,
    items: 0,
    employees: 0,
    transactions: 0,
    skipped: 0,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// importIIF
// ---------------------------------------------------------------------------

/**
 * Parse an IIF string, then insert records via the existing service layer.
 * True duplicates (same account code AND name, or same displayName) are skipped;
 * every skipped row is reported in `issues` with a reason. When two distinct
 * accounts collide on the derived code (e.g. long names truncated to 20 chars),
 * the second is imported under a deduped code instead of being dropped.
 */
/**
 * Import a single account definition with full dedupe / code-collision handling.
 * Shared by the IIF account section and the chart-of-accounts CSV import.
 * Updates `counts` in place; never throws on per-row validation problems.
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
  // Derive a short code: use the explicit code if present, else sanitise the name.
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

  // Check for existing account with the same derived code in this company.
  const [byCode] = await ctx.db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));

  if (byCode && byCode.name === name) {
    // Same code AND same name — a true duplicate.
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
    // Code collision with a DIFFERENT account. If this account name was already
    // imported (under a remapped code), it is a duplicate; otherwise remap the
    // code so the account is not silently dropped.
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
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'VALIDATION') {
      counts.skipped++;
      counts.issues.push({
        entity: 'account',
        name,
        code,
        reason: 'validation',
        message: err.message,
      });
      return null;
    }
    throw err;
  }
}

export async function importIIF(
  ctx: ServiceContext,
  content: string,
): Promise<ImportCounts> {
  const parsed = parseIIF(content);
  const counts = emptyCounts();

  // ---- Accounts ----
  for (const acc of parsed.accounts) {
    const { type, subtype } = mapIifType(acc.accntType);
    await importAccountRow(ctx, counts, {
      name: acc.name,
      code: acc.accnum,
      type,
      subtype,
      description: acc.desc ?? null,
    });
  }

  // ---- Customers ----
  for (const cust of parsed.customers) {
    const displayName = cust.name.trim();
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({
        entity: 'customer',
        name: '(blank)',
        reason: 'validation',
        message: 'Customer row has no name.',
      });
      continue;
    }

    const existing = await ctx.db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.companyId, ctx.companyId),
          eq(customersTable.displayName, displayName),
        ),
      );
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({
        entity: 'customer',
        name: displayName,
        reason: 'duplicate',
        message: `Customer "${displayName}" already exists.`,
      });
      continue;
    }

    try {
      await createCustomer(ctx, {
        displayName,
        companyName: cust.companyName ?? null,
        email: cust.email ?? null,
        phone: cust.phone ?? null,
        billingAddress:
          cust.billAddr1 || cust.billCity
            ? {
                line1: cust.billAddr1 ?? '',
                city: cust.billCity ?? '',
                state: cust.billState ?? '',
                zip: cust.billZip ?? '',
                country: cust.billCountry ?? '',
              }
            : null,
      });
      counts.customers++;
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({
          entity: 'customer',
          name: displayName,
          reason: 'validation',
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // ---- Vendors ----
  for (const vend of parsed.vendors) {
    const displayName = vend.name.trim();
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({
        entity: 'vendor',
        name: '(blank)',
        reason: 'validation',
        message: 'Vendor row has no name.',
      });
      continue;
    }

    const existing = await ctx.db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(
        and(
          eq(vendorsTable.companyId, ctx.companyId),
          eq(vendorsTable.displayName, displayName),
        ),
      );
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({
        entity: 'vendor',
        name: displayName,
        reason: 'duplicate',
        message: `Vendor "${displayName}" already exists.`,
      });
      continue;
    }

    try {
      await createVendor(ctx, {
        displayName,
        companyName: vend.companyName ?? null,
        email: vend.email ?? null,
        phone: vend.phone ?? null,
        address:
          vend.addr1 || vend.city
            ? {
                street: vend.addr1 ?? '',
                city: vend.city ?? '',
                state: vend.state ?? '',
                zip: vend.zip ?? '',
                country: vend.country ?? '',
              }
            : null,
      });
      counts.vendors++;
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({
          entity: 'vendor',
          name: displayName,
          reason: 'validation',
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  // ---- Classes ----
  for (const cls of parsed.classes) {
    const name = cls.name.trim();
    if (!name) continue;
    const existing = await ctx.db
      .select({ id: classesTable.id })
      .from(classesTable)
      .where(and(eq(classesTable.companyId, ctx.companyId), eq(classesTable.name, name)));
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({
        entity: 'class',
        name,
        reason: 'duplicate',
        message: `Class "${name}" already exists.`,
      });
      continue;
    }
    try {
      await createClass(ctx, { name });
      counts.classes++;
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'class', name, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }

  // ---- Items (INVITEM) ----
  // Build an account lookup AFTER the account phase so item links resolve
  // against freshly imported accounts too.
  const acctLookup = await loadAccountLookup(ctx);
  for (const item of parsed.items) {
    await importItemRow(ctx, counts, acctLookup, {
      name: item.name,
      type: mapIifItemType(item.itemType),
      description: item.desc ?? null,
      salesPrice: parseIifAmount(item.price),
      purchaseCost: parseIifAmount(item.cost),
      incomeAccountRef: item.incomeAccount,
      expenseAccountRef: item.cogsAccount,
      assetAccountRef: item.assetAccount,
    });
  }

  // ---- Employees (EMP) ----
  for (const emp of parsed.employees) {
    const raw = emp.name.trim();
    if (!raw) continue;
    // QB writes employee names as "Last, First" (or sometimes "First Last").
    let firstName: string;
    let lastName: string;
    if (raw.includes(',')) {
      const [last, first] = raw.split(',').map((s) => s.trim());
      firstName = first || last;
      lastName = last;
    } else {
      const parts = raw.split(/\s+/);
      firstName = parts[0];
      lastName = parts.slice(1).join(' ') || parts[0];
    }

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
      counts.issues.push({
        entity: 'employee',
        name: raw,
        reason: 'duplicate',
        message: `Employee "${firstName} ${lastName}" already exists.`,
      });
      continue;
    }
    try {
      await createEmployee(ctx, {
        firstName,
        lastName,
        email: emp.email ?? null,
        payType: 'hourly',
        payRate: 0,
      });
      counts.employees++;
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({ entity: 'employee', name: raw, reason: 'validation', message: err.message });
      } else {
        throw err;
      }
    }
  }

  // ---- Transactions (TRNS/SPL → balanced journal entries) ----
  if (parsed.transactions.length) {
    await importIifTransactions(ctx, counts, parsed.transactions, acctLookup);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// IIF transactions — TRNS/SPL blocks posted through the GL engine
// ---------------------------------------------------------------------------

interface AccountLookup {
  byLowerName: Map<string, { id: string; type: string }>;
  byCode: Map<string, { id: string; type: string }>;
}

async function loadAccountLookup(ctx: ServiceContext): Promise<AccountLookup> {
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const byLowerName = new Map<string, { id: string; type: string }>();
  const byCode = new Map<string, { id: string; type: string }>();
  for (const r of rows) {
    byLowerName.set(r.name.toLowerCase(), { id: r.id, type: r.type });
    byCode.set(r.code, { id: r.id, type: r.type });
  }
  return { byLowerName, byCode };
}

/** Resolve an IIF account reference by exact name, "Parent:Sub" leaf name, or code. */
function resolveAccountRef(lookup: AccountLookup, ref: string): { id: string; type: string } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const byName = lookup.byLowerName.get(trimmed.toLowerCase());
  if (byName) return byName;
  // QB "Parent:Sub" paths — try the leaf segment.
  if (trimmed.includes(':')) {
    const leaf = trimmed.split(':').pop()!.trim();
    const byLeaf = lookup.byLowerName.get(leaf.toLowerCase());
    if (byLeaf) return byLeaf;
  }
  return lookup.byCode.get(trimmed) ?? null;
}

/** Name + code of the bucket that collects auto-created unmatched IIF accounts. */
export const QB_IMPORT_BUCKET = { code: 'QB-IMPORT', name: 'QB Import (review)' } as const;

/**
 * Get-or-create the "QB Import (review)" parent bucket, then get-or-create a
 * child account for an unmatched IIF account name. Created as an expense
 * account so debits/credits land somewhere visible until the user re-files it.
 */
async function ensureBucketAccount(
  ctx: ServiceContext,
  counts: ImportCounts,
  lookup: AccountLookup,
  ref: string,
): Promise<{ id: string; type: string } | null> {
  // Parent bucket.
  let parent = lookup.byCode.get(QB_IMPORT_BUCKET.code) ?? null;
  if (!parent) {
    const created = await createAccount(ctx, {
      code: QB_IMPORT_BUCKET.code,
      name: QB_IMPORT_BUCKET.name,
      type: 'expense' as never,
      subtype: 'operating_expenses',
      description: 'Auto-created bucket for unmatched accounts from QuickBooks IIF import.',
    });
    parent = { id: created.id, type: 'expense' };
    lookup.byCode.set(QB_IMPORT_BUCKET.code, parent);
    lookup.byLowerName.set(QB_IMPORT_BUCKET.name.toLowerCase(), parent);
  }

  // Child account named after the unmatched reference.
  const name = ref.trim();
  let code = sanitiseCode(name);
  if (!code) return null;
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
  const entry = { id: created.id, type: 'expense' };
  lookup.byLowerName.set(name.toLowerCase(), entry);
  lookup.byCode.set(code, entry);
  counts.issues.push({
    entity: 'account',
    name,
    code,
    reason: 'unmatched-account',
    message: `Account "${ref}" was not found — created under "${QB_IMPORT_BUCKET.name}" for review.`,
  });
  return entry;
}

async function importIifTransactions(
  ctx: ServiceContext,
  counts: ImportCounts,
  transactions: IIFTransaction[],
  lookup: AccountLookup,
): Promise<void> {
  // Class lookup for optional per-line class tagging.
  const classRows = await ctx.db
    .select({ id: classesTable.id, name: classesTable.name })
    .from(classesTable)
    .where(eq(classesTable.companyId, ctx.companyId));
  const classByLowerName = new Map(classRows.map((c) => [c.name.toLowerCase(), c.id]));

  // Occurrence counter so two IDENTICAL transactions in one file get distinct
  // sourceRefs, while re-importing the same file still dedupes row-for-row.
  const seenKeys = new Map<string, number>();

  for (const txn of transactions) {
    const label = `${txn.type || 'TRNS'}${txn.num ? ` #${txn.num}` : ''}`;

    const date = parseIifDate(txn.date);
    if (!date) {
      counts.skipped++;
      counts.issues.push({
        entity: 'transaction',
        name: label,
        reason: 'validation',
        message: `Missing or unparseable date "${txn.date ?? ''}".`,
      });
      continue;
    }

    // Build posting lines: positive amount = debit, negative = credit.
    const lines: PostingLine[] = [];
    let totalDebit = Money.zero();
    let badAmount = false;
    for (const l of txn.lines) {
      const amt = parseIifAmount(l.amount);
      if (amt === null) {
        badAmount = true;
        break;
      }
      if (Money.isZero(amt)) continue;

      let acct = resolveAccountRef(lookup, l.accnt);
      if (!acct) {
        acct = await ensureBucketAccount(ctx, counts, lookup, l.accnt || '(no account)');
        if (!acct) {
          badAmount = true;
          break;
        }
      }
      const classId = l.className ? classByLowerName.get(l.className.toLowerCase()) ?? null : null;
      const isDebit = Money.isPositive(amt);
      const abs = toAmountString(Money.abs(amt));
      if (isDebit) totalDebit = totalDebit.plus(abs);
      lines.push({
        accountId: acct.id,
        debit: isDebit ? abs : null,
        credit: isDebit ? null : abs,
        memo: l.memo ?? (l.name ? `Payee: ${l.name}` : null),
        classId,
      });
    }

    if (badAmount) {
      counts.skipped++;
      counts.issues.push({
        entity: 'transaction',
        name: label,
        reason: 'validation',
        message: 'A row has an unreadable amount or unresolvable account.',
      });
      continue;
    }
    if (lines.length < 2) {
      counts.skipped++;
      counts.issues.push({
        entity: 'transaction',
        name: label,
        reason: 'validation',
        message: 'Transaction has fewer than two non-zero lines.',
      });
      continue;
    }

    // Pre-check balance so a bad block produces a per-row issue, not a thrown error.
    const totalCredit = lines.reduce(
      (sum, l) => sum.plus(Money.of(l.credit ?? 0)),
      Money.zero(),
    );
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

    // Duplicate guard: stable sourceRef per (type, num, date, total, occurrence).
    const baseKey = `iif:${txn.type || 'TRNS'}:${txn.num || 'no-num'}:${date.toISOString().slice(0, 10)}:${toAmountString(totalDebit)}`;
    const occurrence = seenKeys.get(baseKey) ?? 0;
    seenKeys.set(baseKey, occurrence + 1);
    const sourceRef = `${baseKey}:${occurrence}`;

    const [dup] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef)),
      );
    if (dup) {
      counts.skipped++;
      counts.issues.push({
        entity: 'transaction',
        name: label,
        reason: 'duplicate',
        message: `Already imported (journal entry with source ${sourceRef} exists).`,
      });
      continue;
    }

    try {
      await postJournalEntry(ctx, {
        date,
        description: txn.memo?.trim() || `QB import: ${label}`,
        reference: txn.num ?? null,
        lines,
        sourceRef,
      });
      counts.transactions++;
    } catch (err) {
      if (err instanceof ServiceError) {
        counts.skipped++;
        counts.issues.push({
          entity: 'transaction',
          name: label,
          reason: 'validation',
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Item import core (shared by IIF INVITEM and items CSV)
// ---------------------------------------------------------------------------

/** Map a QuickBooks INVITEMTYPE / CSV type value to our item type enum. */
export function mapIifItemType(raw: string | undefined): ItemType {
  const k = (raw ?? '').trim().toUpperCase().replace(/[\s_-]/g, '');
  if (!k) return 'service';
  if (k === 'SERVICE' || k === 'SERV') return 'service';
  if (k === 'BUNDLE' || k === 'GROUP') return 'bundle';
  if (k.startsWith('NONINV') || k === 'NONINVENTORY' || k === 'OTHC' || k === 'OTHERCHARGE') {
    return 'non_inventory';
  }
  if (k === 'PART' || k === 'INVPART' || k === 'INVENTORY' || k === 'STOCK') return 'inventory';
  return 'non_inventory';
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
  },
): Promise<void> {
  const name = input.name.trim();
  if (!name) {
    counts.skipped++;
    counts.issues.push({
      entity: 'item',
      name: '(blank)',
      reason: 'validation',
      message: 'Item row has no name.',
    });
    return;
  }

  const existing = await ctx.db
    .select({ id: itemsTable.id })
    .from(itemsTable)
    .where(and(eq(itemsTable.companyId, ctx.companyId), eq(itemsTable.name, name)));
  if (existing.length) {
    counts.skipped++;
    counts.issues.push({
      entity: 'item',
      name,
      reason: 'duplicate',
      message: `Item "${name}" already exists.`,
    });
    return;
  }

  // Resolve account links by name/code; only attach when the type matches what
  // createItem expects, otherwise import the item WITHOUT the link + an issue.
  const resolveLink = (ref: string | undefined, expectedType: string, label: string): string | null => {
    if (!ref?.trim()) return null;
    const acct = resolveAccountRef(lookup, ref);
    if (acct && acct.type === expectedType) return acct.id;
    counts.issues.push({
      entity: 'item',
      name,
      reason: 'unmatched-account',
      message: acct
        ? `${label} account "${ref}" is not a ${expectedType} account — link skipped.`
        : `${label} account "${ref}" was not found — link skipped.`,
    });
    return null;
  };

  const incomeAccountId = resolveLink(input.incomeAccountRef, 'revenue', 'Income');
  const expenseAccountId = resolveLink(input.expenseAccountRef, 'expense', 'Expense/COGS');
  const assetAccountId = resolveLink(input.assetAccountRef, 'asset', 'Inventory asset');

  try {
    await createItem(ctx, {
      name,
      sku: input.sku ?? null,
      type: input.type,
      description: input.description ?? null,
      salesPrice: input.salesPrice ?? null,
      purchaseCost: input.purchaseCost ?? null,
      incomeAccountId,
      expenseAccountId,
      assetAccountId,
    });
    counts.items++;
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'VALIDATION') {
      counts.skipped++;
      counts.issues.push({ entity: 'item', name, reason: 'validation', message: err.message });
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// CSV column mapping type
// ---------------------------------------------------------------------------

/**
 * Caller-supplied mapping from canonical field names to CSV column headers.
 * All fields are optional; unmapped fields are left null.
 */
export interface CsvColumnMapping {
  displayName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billingAddress_line1?: string;
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
}

// ---------------------------------------------------------------------------
// importCustomersCSV
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string with papaparse and insert customers using the supplied
 * column mapping. Rows missing a displayName value are silently skipped.
 * Duplicate displayNames within the company are also skipped.
 */
export async function importCustomersCSV(
  ctx: ServiceContext,
  content: string,
  mapping: CsvColumnMapping,
): Promise<ImportCounts> {
  const counts = emptyCounts();

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim(),
  });

  for (const row of parsed.data) {
    const displayName = mapping.displayName ? (row[mapping.displayName] ?? '').trim() : '';
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({
        entity: 'customer',
        name: '(blank)',
        reason: 'validation',
        message: 'Row has no display name value.',
      });
      continue;
    }

    // Duplicate check.
    const existing = await ctx.db
      .select({ id: customersTable.id })
      .from(customersTable)
      .where(
        and(
          eq(customersTable.companyId, ctx.companyId),
          eq(customersTable.displayName, displayName),
        ),
      );
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({
        entity: 'customer',
        name: displayName,
        reason: 'duplicate',
        message: `Customer "${displayName}" already exists.`,
      });
      continue;
    }

    const line1 = mapping.billingAddress_line1 ? (row[mapping.billingAddress_line1] ?? '') : '';
    const city   = mapping.billingAddress_city  ? (row[mapping.billingAddress_city]  ?? '') : '';
    const state  = mapping.billingAddress_state ? (row[mapping.billingAddress_state] ?? '') : '';
    const zip    = mapping.billingAddress_zip   ? (row[mapping.billingAddress_zip]   ?? '') : '';
    const country = mapping.billingAddress_country ? (row[mapping.billingAddress_country] ?? '') : '';

    try {
      await createCustomer(ctx, {
        displayName,
        companyName: mapping.companyName ? (row[mapping.companyName] ?? null) : null,
        email: mapping.email ? (row[mapping.email] ?? null) : null,
        phone: mapping.phone ? (row[mapping.phone] ?? null) : null,
        billingAddress: line1 || city ? { line1, city, state, zip, country } : null,
        notes: mapping.notes ? (row[mapping.notes] ?? null) : null,
      });
      counts.customers++;
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({
          entity: 'customer',
          name: displayName,
          reason: 'validation',
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// importVendorsCSV
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string with papaparse and insert vendors using the supplied
 * column mapping. Rows missing a displayName value are silently skipped.
 * Duplicate displayNames within the company are also skipped.
 */
export async function importVendorsCSV(
  ctx: ServiceContext,
  content: string,
  mapping: CsvColumnMapping,
): Promise<ImportCounts> {
  const counts = emptyCounts();

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim(),
  });

  for (const row of parsed.data) {
    const displayName = mapping.displayName ? (row[mapping.displayName] ?? '').trim() : '';
    if (!displayName) {
      counts.skipped++;
      counts.issues.push({
        entity: 'vendor',
        name: '(blank)',
        reason: 'validation',
        message: 'Row has no display name value.',
      });
      continue;
    }

    // Duplicate check.
    const existing = await ctx.db
      .select({ id: vendorsTable.id })
      .from(vendorsTable)
      .where(
        and(
          eq(vendorsTable.companyId, ctx.companyId),
          eq(vendorsTable.displayName, displayName),
        ),
      );
    if (existing.length) {
      counts.skipped++;
      counts.issues.push({
        entity: 'vendor',
        name: displayName,
        reason: 'duplicate',
        message: `Vendor "${displayName}" already exists.`,
      });
      continue;
    }

    const street  = mapping.address_line1   ? (row[mapping.address_line1]   ?? '') : '';
    const city    = mapping.address_city    ? (row[mapping.address_city]    ?? '') : '';
    const state   = mapping.address_state   ? (row[mapping.address_state]   ?? '') : '';
    const zip     = mapping.address_zip     ? (row[mapping.address_zip]     ?? '') : '';
    const country = mapping.address_country ? (row[mapping.address_country] ?? '') : '';

    try {
      await createVendor(ctx, {
        displayName,
        companyName: mapping.companyName ? (row[mapping.companyName] ?? null) : null,
        email: mapping.email ? (row[mapping.email] ?? null) : null,
        phone: mapping.phone ? (row[mapping.phone] ?? null) : null,
        address: street || city ? { street, city, state, zip, country } : null,
        notes: mapping.notes ? (row[mapping.notes] ?? null) : null,
      });
      counts.vendors++;
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        counts.skipped++;
        counts.issues.push({
          entity: 'vendor',
          name: displayName,
          reason: 'validation',
          message: err.message,
        });
      } else {
        throw err;
      }
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// importItemsCSV
// ---------------------------------------------------------------------------

/**
 * Caller-supplied mapping from canonical item fields to CSV column headers.
 * Account columns may contain an account NAME or CODE; unresolved links are
 * skipped with an issue (the item still imports).
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
}

/** Parse a CSV string and insert items using the supplied column mapping. */
export async function importItemsCSV(
  ctx: ServiceContext,
  content: string,
  mapping: ItemsCsvMapping,
): Promise<ImportCounts> {
  const counts = emptyCounts();

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim(),
  });

  const lookup = await loadAccountLookup(ctx);
  const col = (key: keyof ItemsCsvMapping, row: Record<string, string>): string =>
    mapping[key] ? (row[mapping[key]!] ?? '').trim() : '';

  for (const row of parsed.data) {
    const name = col('name', row);
    if (!name) {
      counts.skipped++;
      counts.issues.push({
        entity: 'item',
        name: '(blank)',
        reason: 'validation',
        message: 'Row has no item name value.',
      });
      continue;
    }
    await importItemRow(ctx, counts, lookup, {
      name,
      sku: col('sku', row) || null,
      type: mapIifItemType(col('type', row)),
      description: col('description', row) || null,
      salesPrice: parseIifAmount(col('salesPrice', row)) ?? null,
      purchaseCost: parseIifAmount(col('purchaseCost', row)) ?? null,
      incomeAccountRef: col('incomeAccount', row) || undefined,
      expenseAccountRef: col('expenseAccount', row) || undefined,
      assetAccountRef: col('assetAccount', row) || undefined,
    });
  }

  return counts;
}

// ---------------------------------------------------------------------------
// importAccountsCSV (chart of accounts)
// ---------------------------------------------------------------------------

export interface AccountsCsvMapping {
  code?: string;
  name?: string;
  /** Accepts our types (asset/liability/equity/revenue/expense) or QB type names (BANK, COGS, …). */
  type?: string;
  subtype?: string;
  description?: string;
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

/**
 * Parse a CSV string and insert chart-of-accounts rows using the supplied
 * column mapping. Dedupe and code-collision behaviour matches the IIF path
 * (importAccountRow) so accounts are never silently dropped.
 */
export async function importAccountsCSV(
  ctx: ServiceContext,
  content: string,
  mapping: AccountsCsvMapping,
): Promise<ImportCounts> {
  const counts = emptyCounts();

  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    transform: (v) => v.trim(),
  });

  const col = (key: keyof AccountsCsvMapping, row: Record<string, string>): string =>
    mapping[key] ? (row[mapping[key]!] ?? '').trim() : '';

  for (const row of parsed.data) {
    const name = col('name', row);
    if (!name) {
      counts.skipped++;
      counts.issues.push({
        entity: 'account',
        name: '(blank)',
        reason: 'validation',
        message: 'Row has no account name value.',
      });
      continue;
    }
    const { type, subtype } = resolveCsvAccountType(col('type', row), col('subtype', row));
    await importAccountRow(ctx, counts, {
      name,
      code: col('code', row) || undefined,
      type,
      subtype,
      description: col('description', row) || null,
    });
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
