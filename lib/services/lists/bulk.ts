/**
 * Add/Edit Multiple List Entries (QB Lists → Add/Edit Multiple List Entries) for customers,
 * vendors and items. Rows come from the grid (typed or pasted from Excel — lib/lists/bulk.ts) as
 * column-keyed strings; a row with an `id` edits that record, otherwise it is added.
 *
 * Every row goes through the normal create/update services (same validation, audit trail and
 * transaction log as the single-record forms). The batch is ALL-OR-NOTHING: rows are tried one
 * by one inside savepoints of one transaction so every row's problems are reported together;
 * if any row fails — or `dryRun` is set — the whole batch is rolled back and nothing is saved.
 */
import { and, eq } from 'drizzle-orm';
import { accounts, items, salesTaxCodes, vendors } from '@/lib/db/schema';
import { BULK_COLUMNS, type BulkList, ITEM_TYPES_FOR_BULK, parseAmount, parseBool, parseDateCell } from '@/lib/lists/bulk';
import { type ServiceContext, ServiceError, inTransaction, validation } from '../_base';
import { createCustomer, updateCustomer } from '../customers';
import { setReorderPoint } from '../inventory';
import { type ItemType, createItem, updateItem } from '../items';
import { createVendor, updateVendor } from '../vendors';
import { ensureSeeded } from './simpleLists';
import { createItemWithOpeningStock } from './openingStock';
import { resolveTermsRef } from './terms';

export interface BulkRowError {
  /** 0-based row index in the submitted batch. */
  row: number;
  field?: string;
  message: string;
}

export interface BulkResult {
  saved: boolean;
  dryRun: boolean;
  created: number;
  updated: number;
  errors: BulkRowError[];
  /** id per row (dry runs report the ids that would have been created, then rolled back). */
  ids: Array<string | null>;
}

type Cell = string | number | boolean | null | undefined;
type RawRow = Record<string, Cell>;

class Rollback extends Error {}

const str = (v: Cell): string => (v === null || v === undefined ? '' : String(v)).trim();

function has(row: RawRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

/** For a NEW record an empty cell means "not given"; when EDITING it means "clear". */
function optText(row: RawRow, key: string, editing: boolean): string | null | undefined {
  if (!has(row, key)) return undefined;
  const v = str(row[key]);
  if (v === '') return editing ? null : undefined;
  return v;
}

function moneyField(row: RawRow, key: string, label: string, editing: boolean): string | null | undefined {
  if (!has(row, key)) return undefined;
  const v = str(row[key]);
  if (v === '') return editing ? null : undefined;
  const parsed = parseAmount(v);
  if (parsed === null) throw new FieldError(key, `${label}: "${v}" is not a number.`);
  return parsed;
}

function boolField(row: RawRow, key: string, label: string): boolean | undefined {
  if (!has(row, key)) return undefined;
  const raw = row[key];
  if (typeof raw === 'boolean') return raw;
  const v = str(raw);
  if (v === '') return undefined;
  const b = parseBool(v);
  if (b === null) throw new FieldError(key, `${label}: use yes or no (got "${v}").`);
  return b;
}

class FieldError extends Error {
  constructor(public field: string, message: string) {
    super(message);
  }
}

interface Lookups {
  accounts: Array<{ id: string; code: string; name: string }>;
  vendors: Array<{ id: string; displayName: string }>;
  taxCodes: Array<{ id: string; code: string }>;
}

async function loadLookups(ctx: ServiceContext, list: BulkList): Promise<Lookups> {
  const out: Lookups = { accounts: [], vendors: [], taxCodes: [] };
  if (list === 'items') {
    out.accounts = await ctx.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true)));
    out.vendors = await ctx.db
      .select({ id: vendors.id, displayName: vendors.displayName })
      .from(vendors)
      .where(eq(vendors.companyId, ctx.companyId));
  }
  if (list !== 'vendors') {
    await ensureSeeded(ctx, 'sales-tax-codes');
    out.taxCodes = await ctx.db
      .select({ id: salesTaxCodes.id, code: salesTaxCodes.code })
      .from(salesTaxCodes)
      .where(and(eq(salesTaxCodes.companyId, ctx.companyId), eq(salesTaxCodes.isActive, true)));
  }
  return out;
}

function accountRef(lk: Lookups, row: RawRow, key: string, label: string, editing: boolean): string | null | undefined {
  const v = optText(row, key, editing);
  if (v === undefined || v === null) return v;
  const lower = v.toLowerCase();
  const found =
    lk.accounts.find((a) => a.code.toLowerCase() === lower) ??
    lk.accounts.find((a) => a.name.toLowerCase() === lower) ??
    lk.accounts.find((a) => `${a.code} ${a.name}`.toLowerCase() === lower || `${a.code} · ${a.name}`.toLowerCase() === lower);
  if (!found) throw new FieldError(key, `${label}: no active account "${v}" in the chart of accounts.`);
  return found.id;
}

function taxCodeRef(lk: Lookups, row: RawRow, editing: boolean): string | null | undefined {
  const v = optText(row, 'salesTaxCode', editing);
  if (v === undefined || v === null) return v;
  const found = lk.taxCodes.find((t) => t.code.toLowerCase() === v.toLowerCase());
  if (!found) throw new FieldError('salesTaxCode', `Tax code: "${v}" is not on the Sales Tax Code list.`);
  return found.id;
}

async function termsRef(ctx: ServiceContext, row: RawRow, editing: boolean): Promise<string | null | undefined> {
  const v = optText(row, 'terms', editing);
  if (v === undefined || v === null) return v;
  const t = await resolveTermsRef(ctx, v).catch(() => null);
  if (!t) throw new FieldError('terms', `Terms: "${v}" is not on the Terms list.`);
  return t.id;
}

async function saveCustomer(ctx: ServiceContext, row: RawRow, lk: Lookups): Promise<{ id: string; created: boolean }> {
  const id = str(row.id) || null;
  const editing = !!id;
  const address: Record<string, string> = {};
  let addressTouched = false;
  for (const [k, a] of [['billLine1', 'line1'], ['billCity', 'city'], ['billState', 'state'], ['billZip', 'zip']] as const) {
    if (has(row, k)) {
      addressTouched = true;
      const v = str(row[k]);
      if (v) address[a] = v;
    }
  }
  const email = optText(row, 'email', editing);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FieldError('email', `Email: "${email}" is not a valid email address.`);
  const input = {
    displayName: has(row, 'displayName') ? str(row.displayName) : undefined,
    companyName: optText(row, 'companyName', editing),
    email,
    phone: optText(row, 'phone', editing),
    billingAddress: addressTouched ? (Object.keys(address).length ? address : null) : undefined,
    termsId: await termsRef(ctx, row, editing),
    creditLimit: moneyField(row, 'creditLimit', 'Credit limit', editing),
    salesTaxCodeId: taxCodeRef(lk, row, editing),
    resaleNumber: optText(row, 'resaleNumber', editing),
    notes: optText(row, 'notes', editing),
  };
  if (editing) {
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    const r = await updateCustomer(ctx, id!, patch);
    return { id: r.id, created: false };
  }
  if (!input.displayName) throw new FieldError('displayName', 'Customer name is required.');
  const r = await createCustomer(ctx, { ...input, displayName: input.displayName } as Parameters<typeof createCustomer>[1]);
  return { id: r.id, created: true };
}

async function saveVendor(ctx: ServiceContext, row: RawRow): Promise<{ id: string; created: boolean }> {
  const id = str(row.id) || null;
  const editing = !!id;
  const address: Record<string, string> = {};
  let addressTouched = false;
  for (const k of ['line1', 'city', 'state', 'zip'] as const) {
    if (has(row, k)) {
      addressTouched = true;
      const v = str(row[k]);
      if (v) address[k] = v;
    }
  }
  const email = optText(row, 'email', editing);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FieldError('email', `Email: "${email}" is not a valid email address.`);
  const input = {
    displayName: has(row, 'displayName') ? str(row.displayName) : undefined,
    companyName: optText(row, 'companyName', editing),
    email,
    phone: optText(row, 'phone', editing),
    address: addressTouched ? (Object.keys(address).length ? address : null) : undefined,
    termsId: await termsRef(ctx, row, editing),
    is1099: boolField(row, 'is1099', '1099'),
    notes: optText(row, 'notes', editing),
  };
  if (editing) {
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (patch.displayName === '') throw new FieldError('displayName', 'Vendor name is required.');
    const r = await updateVendor(ctx, id!, patch);
    return { id: r.id, created: false };
  }
  if (!input.displayName) throw new FieldError('displayName', 'Vendor name is required.');
  const r = await createVendor(ctx, { ...input, displayName: input.displayName } as Parameters<typeof createVendor>[1]);
  return { id: r.id, created: true };
}

async function saveItem(ctx: ServiceContext, row: RawRow, lk: Lookups): Promise<{ id: string; created: boolean }> {
  const id = str(row.id) || null;
  const editing = !!id;
  let type: ItemType | undefined;
  if (has(row, 'type') && str(row.type)) {
    const t = str(row.type).toLowerCase().replace(/[\s-]+/g, '_');
    const mapped = t === 'noninventory' ? 'non_inventory' : t === 'othercharge' ? 'other_charge' : t;
    if (!(ITEM_TYPES_FOR_BULK as readonly string[]).includes(mapped)) {
      throw new FieldError('type', `Type: "${str(row.type)}" is not one of ${ITEM_TYPES_FOR_BULK.join(', ')}.`);
    }
    type = mapped as ItemType;
  }
  let preferredVendorId: string | null | undefined = undefined;
  const pv = optText(row, 'preferredVendor', editing);
  if (pv === null) preferredVendorId = null;
  else if (pv) {
    const v = lk.vendors.find((x) => x.displayName.toLowerCase() === pv.toLowerCase());
    if (!v) throw new FieldError('preferredVendor', `Preferred vendor: no vendor named "${pv}".`);
    preferredVendorId = v.id;
  }
  const reorder = has(row, 'reorderPoint') ? str(row.reorderPoint) : undefined;
  if (reorder && parseAmount(reorder) === null) throw new FieldError('reorderPoint', `Reorder point: "${reorder}" is not a number.`);
  const input = {
    name: has(row, 'name') ? str(row.name) : undefined,
    sku: optText(row, 'sku', editing),
    description: optText(row, 'description', editing),
    salesPrice: moneyField(row, 'salesPrice', 'Sales price', editing),
    purchaseCost: moneyField(row, 'purchaseCost', 'Cost', editing),
    incomeAccountId: accountRef(lk, row, 'incomeAccount', 'Income account', editing),
    expenseAccountId: accountRef(lk, row, 'expenseAccount', 'Expense account', editing),
    assetAccountId: accountRef(lk, row, 'assetAccount', 'Asset account', editing),
    taxable: boolField(row, 'taxable', 'Taxable'),
    salesTaxCodeId: taxCodeRef(lk, row, editing),
    preferredVendorId,
    unitOfMeasure: optText(row, 'unitOfMeasure', editing),
  };
  // G1: opening quantity on hand / total value / as-of date (new inventory items only). Posted
  // by the same path as the New Item form (lib/services/lists/openingStock.ts): Dr Inventory
  // Asset / Cr Opening Balance Equity plus a FIFO layer, so the ledger stays balanced.
  const openQty = has(row, 'openingQuantity') ? str(row.openingQuantity) : '';
  const openValueRaw = has(row, 'openingValue') ? str(row.openingValue) : '';
  const openAsOfRaw = has(row, 'openingAsOf') ? str(row.openingAsOf) : '';
  const anyOpening = openQty !== '' || openValueRaw !== '' || openAsOfRaw !== '';
  let opening: { openingQuantity: string; openingValue?: string; openingUnitCost?: string; openingAsOf?: Date } | null = null;
  if (anyOpening) {
    if (editing) {
      const field = openQty !== '' ? 'openingQuantity' : openValueRaw !== '' ? 'openingValue' : 'openingAsOf';
      throw new FieldError(field, 'Quantity on hand can only be entered for a new item. To change stock of an existing item, use Adjust inventory.');
    }
    if (openQty === '') throw new FieldError('openingQuantity', 'Enter the quantity on hand along with its value and date.');
    const q = parseAmount(openQty);
    if (q === null) throw new FieldError('openingQuantity', `Qty on hand: "${openQty}" is not a number.`);
    if ((type ?? 'service') !== 'inventory') {
      throw new FieldError('openingQuantity', 'Only inventory items can start with a quantity on hand (set Type to inventory).');
    }
    let openingValue: string | undefined;
    let openingUnitCost: string | undefined;
    if (openValueRaw !== '') {
      const v = parseAmount(openValueRaw);
      if (v === null) throw new FieldError('openingValue', `Total value: "${openValueRaw}" is not a number.`);
      openingValue = v;
    } else if (input.purchaseCost) {
      // No total value: value the stock at the item's cost (QB uses the cost the same way).
      openingUnitCost = input.purchaseCost;
    } else {
      throw new FieldError('openingValue', "Enter the total value of the quantity on hand (or the item's Cost).");
    }
    let openingAsOf: Date | undefined;
    if (openAsOfRaw !== '') {
      const dt = parseDateCell(openAsOfRaw);
      if (!dt) throw new FieldError('openingAsOf', `As of date: "${openAsOfRaw}" is not a date (use 2026-01-31 or 1/31/2026).`);
      openingAsOf = dt;
    }
    opening = { openingQuantity: q, openingValue, openingUnitCost, openingAsOf };
  }
  let itemId: string;
  let created: boolean;
  if (editing) {
    // The grid loads every column of an existing item, Type included, and sends the whole row
    // back when any cell changed: only a DIFFERENT type is a change of type.
    if (type) {
      const [current] = await ctx.db
        .select({ type: items.type })
        .from(items)
        .where(and(eq(items.companyId, ctx.companyId), eq(items.id, id!)));
      if (current && current.type !== type) {
        throw new FieldError('type', 'The type of an existing item cannot be changed here.');
      }
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (patch.name === '') throw new FieldError('name', 'Item name is required.');
    itemId = (await updateItem(ctx, id!, patch)).id;
    created = false;
  } else {
    if (!input.name) throw new FieldError('name', 'Item name is required.');
    const itemInput = { ...input, name: input.name, type: type ?? 'service' } as Parameters<typeof createItem>[1];
    itemId = opening
      ? (await createItemWithOpeningStock(ctx, { ...itemInput, ...opening })).item.id
      : (await createItem(ctx, itemInput)).id;
    created = true;
  }
  if (reorder !== undefined && (reorder !== '' || editing)) {
    await setReorderPoint(ctx, itemId, reorder === '' ? null : parseAmount(reorder));
  }
  return { id: itemId, created };
}

/** Run a batch (see module doc). */
export async function bulkSave(
  ctx: ServiceContext,
  list: BulkList,
  rows: RawRow[],
  opts: { dryRun?: boolean } = {},
): Promise<BulkResult> {
  if (!BULK_COLUMNS[list]) throw validation('Unknown list.');
  if (rows.length === 0) throw validation('Add at least one row.');
  if (rows.length > 1000) throw validation('At most 1000 rows at a time.');
  const errors: BulkRowError[] = [];
  const ids: Array<string | null> = rows.map(() => null);
  let created = 0;
  let updated = 0;
  const dryRun = !!opts.dryRun;
  // Duplicate names inside the batch are reported on the later row.
  const nameKey = list === 'items' ? 'name' : 'displayName';
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const n = str(r[nameKey]).toLowerCase();
    if (!n) return;
    if (seen.has(n)) errors.push({ row: i, field: nameKey, message: `Same name as row ${seen.get(n)! + 1}.` });
    else seen.set(n, i);
  });

  try {
    await inTransaction(ctx, async (tx) => {
      const lk = await loadLookups(tx, list);
      for (let i = 0; i < rows.length; i++) {
        if (errors.some((e) => e.row === i)) continue;
        const row = rows[i];
        if (Object.entries(row).every(([k, v]) => k === 'id' || str(v) === '')) continue; // blank grid row
        try {
          await tx.db.transaction(async (sp) => {
            const spCtx: ServiceContext = { ...tx, db: sp as unknown as ServiceContext['db'] };
            const r =
              list === 'customers'
                ? await saveCustomer(spCtx, row, lk)
                : list === 'vendors'
                  ? await saveVendor(spCtx, row)
                  : await saveItem(spCtx, row, lk);
            ids[i] = r.id;
            if (r.created) created++;
            else updated++;
          });
        } catch (err) {
          if (err instanceof FieldError) errors.push({ row: i, field: err.field, message: err.message });
          else if (err instanceof ServiceError) errors.push({ row: i, message: err.message });
          else errors.push({ row: i, message: 'This row could not be saved.' });
        }
      }
      if (errors.length > 0 || dryRun) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  errors.sort((a, b) => a.row - b.row);
  const saved = !dryRun && errors.length === 0;
  return { saved, dryRun, created: saved || dryRun ? created : 0, updated: saved || dryRun ? updated : 0, errors, ids: saved ? ids : ids.map(() => null) };
}

/** Rows for the grid in edit mode: current values in the column keys. */
export async function bulkLoad(ctx: ServiceContext, list: BulkList): Promise<Array<Record<string, string>>> {
  if (list === 'customers') {
    const { listCustomers } = await import('../customers');
    const { listEntries } = await import('./simpleLists');
    const terms = await listEntries(ctx, 'terms', { includeInactive: true });
    const codes = await listEntries(ctx, 'sales-tax-codes', { includeInactive: true });
    return (await listCustomers(ctx)).map((c) => {
      const a = (c.billingAddress ?? {}) as Record<string, string>;
      return {
        id: c.id,
        displayName: c.displayName,
        companyName: c.companyName ?? '',
        email: c.email ?? '',
        phone: c.phone ?? '',
        billLine1: a.line1 ?? '',
        billCity: a.city ?? '',
        billState: a.state ?? '',
        billZip: a.zip ?? '',
        terms: (c.termsId ? (terms.find((t) => t.id === c.termsId)?.name as string | undefined) : undefined) ?? '',
        creditLimit: c.creditLimit ?? '',
        salesTaxCode: (c.salesTaxCodeId ? (codes.find((t) => t.id === c.salesTaxCodeId)?.code as string | undefined) : undefined) ?? '',
        resaleNumber: c.resaleNumber ?? '',
        notes: c.notes ?? '',
      };
    });
  }
  if (list === 'vendors') {
    const { listVendors } = await import('../vendors');
    const { listEntries } = await import('./simpleLists');
    const terms = await listEntries(ctx, 'terms', { includeInactive: true });
    return (await listVendors(ctx)).map((v) => {
      const a = (v.address ?? {}) as Record<string, string>;
      return {
        id: v.id,
        displayName: v.displayName,
        companyName: v.companyName ?? '',
        email: v.email ?? '',
        phone: v.phone ?? '',
        line1: a.line1 ?? a.street ?? '',
        city: a.city ?? '',
        state: a.state ?? '',
        zip: a.zip ?? '',
        terms: (v.termsId ? (terms.find((t) => t.id === v.termsId)?.name as string | undefined) : undefined) ?? '',
        is1099: v.is1099 ? 'yes' : 'no',
        notes: v.notes ?? '',
      };
    });
  }
  const { listItems } = await import('../items');
  const accts = await ctx.db.select({ id: accounts.id, code: accounts.code }).from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const code = new Map(accts.map((a) => [a.id, a.code]));
  const vend = await ctx.db.select({ id: vendors.id, n: vendors.displayName }).from(vendors).where(eq(vendors.companyId, ctx.companyId));
  const vname = new Map(vend.map((v) => [v.id, v.n]));
  const codes = await ctx.db.select({ id: salesTaxCodes.id, code: salesTaxCodes.code }).from(salesTaxCodes).where(eq(salesTaxCodes.companyId, ctx.companyId));
  const cname = new Map(codes.map((c) => [c.id, c.code]));
  return (await listItems(ctx))
    .filter((i) => (ITEM_TYPES_FOR_BULK as readonly string[]).includes(i.type))
    .map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      sku: i.sku ?? '',
      description: i.description ?? '',
      salesPrice: i.salesPrice ?? '',
      purchaseCost: i.purchaseCost ?? '',
      incomeAccount: i.incomeAccountId ? code.get(i.incomeAccountId) ?? '' : '',
      expenseAccount: i.expenseAccountId ? code.get(i.expenseAccountId) ?? '' : '',
      assetAccount: i.assetAccountId ? code.get(i.assetAccountId) ?? '' : '',
      taxable: i.taxable ? 'yes' : 'no',
      preferredVendor: i.preferredVendorId ? vname.get(i.preferredVendorId) ?? '' : '',
      reorderPoint: i.reorderPoint ?? '',
      unitOfMeasure: i.unitOfMeasure ?? '',
      salesTaxCode: i.salesTaxCodeId ? cname.get(i.salesTaxCodeId) ?? '' : '',
    }));
}

