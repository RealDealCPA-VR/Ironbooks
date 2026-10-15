/**
 * Clean Up Company Data — "Remove unused list entries" (QB File → Utilities → Clean Up Company
 * Data, list part). Only INACTIVE entries that nothing in the company file refers to are
 * removed: no document, line, journal entry, price, setting, note, to-do, attachment, template or
 * other list entry (lib/services/lists/references.ts scans every id-bearing column). Removal is
 * re-checked at run time — a preview never authorizes deleting something that became used — and
 * each deletion runs in its own savepoint, so a reference the scan could not see (the database's
 * own foreign keys are the backstop) only skips that entry. No ledger data is touched.
 */
import { and, eq } from 'drizzle-orm';
import {
  billingRateLevelItems,
  billingRateLevels,
  classes,
  customerMessages,
  customerTypes,
  customers,
  items,
  jobTypes,
  otherNames,
  paymentMethods,
  paymentTerms,
  salesTaxCodes,
  shipViaMethods,
  uomSetUnits,
  uomSets,
  vehicles,
  vendorTypes,
  vendors,
} from '@/lib/db/schema';
import { type ServiceContext, inTransaction, writeAudit } from '../_base';
import { findReferences } from './references';
import { assertListDeleteAllowed } from '../accountantCopy/guard';

export type CleanupList =
  | 'customers' | 'vendors' | 'items' | 'classes' | 'other-names' | 'job-types' | 'terms'
  | 'ship-via' | 'payment-methods' | 'customer-messages' | 'sales-tax-codes' | 'vehicles'
  | 'customer-types' | 'vendor-types' | 'billing-rate-levels' | 'uom-sets';

interface CleanupDef {
  label: string;
  tableName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  nameField: string;
  entityType: string;
  /** Child tables that belong to the entry itself (deleted with it, not counted as uses). */
  ownChildren?: Array<{ tableName: string; // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table: any; fk: string }>;
}

const DEFS: Record<CleanupList, CleanupDef> = {
  customers: { label: 'Customers', tableName: 'customers', table: customers, nameField: 'displayName', entityType: 'customer' },
  vendors: { label: 'Vendors', tableName: 'vendors', table: vendors, nameField: 'displayName', entityType: 'vendor' },
  items: { label: 'Items', tableName: 'items', table: items, nameField: 'name', entityType: 'item' },
  classes: { label: 'Classes', tableName: 'classes', table: classes, nameField: 'name', entityType: 'class' },
  'other-names': { label: 'Other Names', tableName: 'other_names', table: otherNames, nameField: 'name', entityType: 'other_name' },
  'job-types': { label: 'Job Types', tableName: 'job_types', table: jobTypes, nameField: 'name', entityType: 'job_type' },
  terms: { label: 'Terms', tableName: 'payment_terms', table: paymentTerms, nameField: 'name', entityType: 'payment_terms' },
  'ship-via': { label: 'Ship Via', tableName: 'ship_via_methods', table: shipViaMethods, nameField: 'name', entityType: 'ship_via' },
  'payment-methods': { label: 'Payment Methods', tableName: 'payment_methods', table: paymentMethods, nameField: 'name', entityType: 'payment_method' },
  'customer-messages': { label: 'Customer Messages', tableName: 'customer_messages', table: customerMessages, nameField: 'message', entityType: 'customer_message' },
  'sales-tax-codes': { label: 'Sales Tax Codes', tableName: 'sales_tax_codes', table: salesTaxCodes, nameField: 'code', entityType: 'sales_tax_code' },
  vehicles: { label: 'Vehicles', tableName: 'vehicles', table: vehicles, nameField: 'name', entityType: 'vehicle' },
  'customer-types': { label: 'Customer Types', tableName: 'customer_types', table: customerTypes, nameField: 'name', entityType: 'customer_type' },
  'vendor-types': { label: 'Vendor Types', tableName: 'vendor_types', table: vendorTypes, nameField: 'name', entityType: 'vendor_type' },
  'billing-rate-levels': {
    label: 'Billing Rate Levels',
    tableName: 'billing_rate_levels',
    table: billingRateLevels,
    nameField: 'name',
    entityType: 'billing_rate_level',
    ownChildren: [{ tableName: 'billing_rate_level_items', table: billingRateLevelItems, fk: 'levelId' }],
  },
  'uom-sets': {
    label: 'Unit of Measure Sets',
    tableName: 'uom_sets',
    table: uomSets,
    nameField: 'name',
    entityType: 'uom_set',
    ownChildren: [{ tableName: 'uom_set_units', table: uomSetUnits, fk: 'setId' }],
  },
};

export const CLEANUP_LIST_KEYS = Object.keys(DEFS) as CleanupList[];

export interface CleanupCandidate {
  list: CleanupList;
  id: string;
  name: string;
}

async function eligible(ctx: ServiceContext, list: CleanupList): Promise<CleanupCandidate[]> {
  const def = DEFS[list];
  const t = def.table;
  const rows: Array<Record<string, unknown>> = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.companyId, ctx.companyId), eq(t.isActive, false)));
  let pool = rows;
  if (list === 'items') {
    // Never drop an item that still has stock on hand, whatever the scan says.
    pool = rows.filter((r) => Number(r.quantityOnHand ?? 0) === 0);
  }
  if (pool.length === 0) return [];
  const hits = await findReferences(ctx, def.tableName, pool.map((r) => String(r.id)));
  const own = new Set((def.ownChildren ?? []).map((c) => c.tableName));
  return pool
    .filter((r) => (hits.get(String(r.id).toLowerCase()) ?? []).every((h) => own.has(h.table)))
    .map((r) => ({ list, id: String(r.id), name: String(r[def.nameField] ?? '') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What Clean Up would remove, per list. */
export async function previewCleanup(ctx: ServiceContext, lists: CleanupList[] = CLEANUP_LIST_KEYS) {
  const out: Array<{ list: CleanupList; label: string; entries: CleanupCandidate[] }> = [];
  for (const list of lists) out.push({ list, label: DEFS[list].label, entries: await eligible(ctx, list) });
  return { lists: out, total: out.reduce((s, l) => s + l.entries.length, 0) };
}

/**
 * Remove unused inactive entries. `ids` limits removal to entries chosen from the preview; every
 * entry is re-checked here, so anything that became used since the preview is kept.
 */
export async function runCleanup(
  ctx: ServiceContext,
  opts: { lists?: CleanupList[]; ids?: string[] } = {},
) {
  await assertListDeleteAllowed(ctx, 'delete', 'list entries'); // Accountant's Copy (I1)
  const lists = opts.lists?.length ? opts.lists : CLEANUP_LIST_KEYS;
  const only = opts.ids ? new Set(opts.ids.map((i) => i.toLowerCase())) : null;
  const removed: CleanupCandidate[] = [];
  const kept: Array<CleanupCandidate & { reason: string }> = [];
  for (const list of lists) {
    const def = DEFS[list];
    const candidates = (await eligible(ctx, list)).filter((c) => !only || only.has(c.id.toLowerCase()));
    if (candidates.length === 0) continue;
    await inTransaction(ctx, async (tx) => {
      for (const c of candidates) {
        try {
          await tx.db.transaction(async (sp) => {
            for (const child of def.ownChildren ?? []) {
              await sp.delete(child.table).where(eq(child.table[child.fk], c.id));
            }
            await sp.delete(def.table).where(and(eq(def.table.id, c.id), eq(def.table.companyId, tx.companyId)));
          });
          await writeAudit(tx, {
            action: 'delete',
            entityType: def.entityType,
            entityId: c.id,
            oldValues: { name: c.name, isActive: false },
            newValues: { reason: 'Clean Up Company Data: unused inactive list entry removed' },
          });
          removed.push(c);
        } catch {
          kept.push({ ...c, reason: 'Still referenced by the company file' });
        }
      }
    });
  }
  // Ids the caller asked for that were not eligible (active, used, or unknown) are reported.
  if (only) {
    const done = new Set([...removed, ...kept].map((r) => r.id.toLowerCase()));
    for (const id of only) if (!done.has(id)) kept.push({ list: lists[0], id, name: '', reason: 'Not an unused inactive entry' });
  }
  return { removed, kept };
}

/** Exposed for tests/UI: inactive entries of a list that ARE in use (and why they stay). */
export async function inUseInactive(ctx: ServiceContext, list: CleanupList) {
  const def = DEFS[list];
  const t = def.table;
  const rows: Array<Record<string, unknown>> = await ctx.db
    .select()
    .from(t)
    .where(and(eq(t.companyId, ctx.companyId), eq(t.isActive, false)));
  const ids = rows.map((r) => String(r.id));
  const hits = await findReferences(ctx, def.tableName, ids);
  return rows
    .filter((r) => (hits.get(String(r.id).toLowerCase()) ?? []).length > 0)
    .map((r) => ({ id: String(r.id), name: String(r[def.nameField] ?? ''), usedIn: hits.get(String(r.id).toLowerCase()) }));
}

