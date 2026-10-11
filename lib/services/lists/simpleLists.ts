/**
 * Generic engine for QB Desktop's simple name lists (Lists → Customer & Vendor Profile Lists and
 * friends): Other Names, Job Types, Terms, Ship Via, Payment Methods, Customer Messages, Sales Tax
 * Codes and Vehicles. Master data only — no GL impact.
 *
 * Every list gets the same behaviour:
 *  - company-scoped CRUD with zod validation (lib/validation/lists.ts) and a per-list rule hook;
 *  - case-insensitive unique names (also enforced by a unique index in 0026_wave2_lists.sql);
 *  - "delete" removes an entry that is used nowhere, otherwise deactivates it so history keeps
 *    resolving (lib/services/lists/references.ts finds uses across the whole company file);
 *  - QB's built-in default entries are seeded once per company (list_seeds marks the seed, so a
 *    user who deletes the defaults never gets them back);
 *  - every mutation is audited (writeAudit → audit trail + transaction log).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  billingRateLevels,
  customerMessages,
  jobTypes,
  listSeeds,
  otherNames,
  paymentMethods,
  paymentTerms,
  salesTaxCodes,
  shipViaMethods,
  vehicles,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import {
  customerMessageSchema,
  jobTypeSchema,
  otherNameSchema,
  paymentMethodSchema,
  salesTaxCodeSchema,
  shipViaSchema,
  termsSchema,
  vehicleSchema,
} from '@/lib/validation/lists';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { isReferenced } from './references';

export const SIMPLE_LIST_KEYS = [
  'other-names',
  'job-types',
  'terms',
  'ship-via',
  'payment-methods',
  'customer-messages',
  'sales-tax-codes',
  'vehicles',
] as const;
export type SimpleListKey = (typeof SIMPLE_LIST_KEYS)[number];

export function isSimpleListKey(k: string): k is SimpleListKey {
  return (SIMPLE_LIST_KEYS as readonly string[]).includes(k);
}

type Row = Record<string, unknown> & { id: string; isActive: boolean };

interface ListDef {
  key: SimpleListKey;
  label: string;
  /** audit entity type */
  entityType: string;
  /** SQL table name (reference discovery) */
  tableName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Field holding the unique display name. */
  nameField: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** Cross-field rules + normalisation of the merged (post-update) values. */
  finalize?: (ctx: ServiceContext, data: Record<string, unknown>, selfId?: string) => Promise<Record<string, unknown>>;
  seed?: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Per-list rules
// ---------------------------------------------------------------------------

async function finalizeTerms(_ctx: ServiceContext, d: Record<string, unknown>) {
  const out = { ...d };
  const pct = d.discountPercent == null || d.discountPercent === '' ? null : Money.of(d.discountPercent as string);
  if (pct && (pct.isNegative() || pct.greaterThan(100))) {
    throw validation('The discount percent must be between 0 and 100.');
  }
  const hasDiscount = !!pct && pct.greaterThan(0);
  out.discountPercent = hasDiscount ? pct!.toFixed(4) : null;
  if (d.kind === 'date_driven') {
    if (d.dueDayOfMonth == null) throw validation('Date-driven terms need the day of the month the bill is due.');
    if (hasDiscount && d.discountDayOfMonth == null) {
      throw validation('Enter the day of the month by which payment earns the discount.');
    }
    out.netDays = null;
    out.discountDays = null;
    out.dueNextMonthWithinDays = d.dueNextMonthWithinDays ?? 0;
    if (!hasDiscount) out.discountDayOfMonth = null;
  } else {
    if (d.netDays == null) throw validation('Enter how many days after the transaction payment is due (0 = due on receipt).');
    if (hasDiscount) {
      if (d.discountDays == null) throw validation('Enter how many days the early-payment discount lasts.');
      if (Number(d.discountDays) > Number(d.netDays)) {
        throw validation('The discount period cannot be longer than the time until the bill is due.');
      }
    } else {
      out.discountDays = null;
    }
    out.dueDayOfMonth = null;
    out.dueNextMonthWithinDays = null;
    out.discountDayOfMonth = null;
  }
  return out;
}

async function finalizeJobType(ctx: ServiceContext, d: Record<string, unknown>, selfId?: string) {
  const parentId = (d.parentId as string | null | undefined) ?? null;
  if (parentId) {
    if (parentId === selfId) throw validation('A job type cannot be its own parent.');
    const all = await ctx.db
      .select({ id: jobTypes.id, parentId: jobTypes.parentId })
      .from(jobTypes)
      .where(eq(jobTypes.companyId, ctx.companyId));
    const parentOf = new Map(all.map((r) => [r.id, r.parentId]));
    if (!parentOf.has(parentId)) throw notFound('Parent job type');
    if (selfId) {
      const seen = new Set<string>();
      let cur: string | null | undefined = parentId;
      while (cur && !seen.has(cur)) {
        if (cur === selfId) throw validation('A job type cannot be placed under one of its own subtypes.');
        seen.add(cur);
        cur = parentOf.get(cur);
      }
    }
  }
  return { ...d, parentId };
}

async function finalizeOtherName(ctx: ServiceContext, d: Record<string, unknown>) {
  const out = { ...d };
  if (out.email === '') out.email = null;
  const levelId = out.billingRateLevelId as string | null | undefined;
  if (levelId) {
    const [lvl] = await ctx.db
      .select({ id: billingRateLevels.id })
      .from(billingRateLevels)
      .where(and(eq(billingRateLevels.id, levelId), eq(billingRateLevels.companyId, ctx.companyId)));
    if (!lvl) throw notFound('Billing rate level');
  }
  return out;
}

async function finalizeTaxCode(_ctx: ServiceContext, d: Record<string, unknown>) {
  const code = String(d.code ?? '').trim();
  if (!/^[A-Za-z0-9]{1,3}$/.test(code)) {
    throw validation('A sales tax code is 1 to 3 letters or digits (for example "Tax", "Non" or "OOS").');
  }
  return { ...d, code };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const DEFS: Record<SimpleListKey, ListDef> = {
  'other-names': {
    key: 'other-names',
    label: 'Other Names',
    entityType: 'other_name',
    tableName: 'other_names',
    table: otherNames,
    nameField: 'name',
    schema: otherNameSchema as unknown as z.ZodObject<z.ZodRawShape>,
    finalize: finalizeOtherName,
  },
  'job-types': {
    key: 'job-types',
    label: 'Job Types',
    entityType: 'job_type',
    tableName: 'job_types',
    table: jobTypes,
    nameField: 'name',
    schema: jobTypeSchema as unknown as z.ZodObject<z.ZodRawShape>,
    finalize: finalizeJobType,
  },
  terms: {
    key: 'terms',
    label: 'Terms',
    entityType: 'payment_terms',
    tableName: 'payment_terms',
    table: paymentTerms,
    nameField: 'name',
    schema: termsSchema as unknown as z.ZodObject<z.ZodRawShape>,
    finalize: finalizeTerms,
    seed: [
      { name: 'Due on receipt', code: 'due_on_receipt', kind: 'standard', netDays: 0 },
      { name: 'Net 10', code: 'net_10', kind: 'standard', netDays: 10 },
      { name: 'Net 15', code: 'net_15', kind: 'standard', netDays: 15 },
      { name: 'Net 30', code: 'net_30', kind: 'standard', netDays: 30 },
      { name: 'Net 60', code: 'net_60', kind: 'standard', netDays: 60 },
      { name: '1% 10 Net 30', code: '1_10_net_30', kind: 'standard', netDays: 30, discountPercent: '1.0000', discountDays: 10 },
      { name: '2% 10 Net 30', code: '2_10_net_30', kind: 'standard', netDays: 30, discountPercent: '2.0000', discountDays: 10 },
    ],
  },
  'ship-via': {
    key: 'ship-via',
    label: 'Ship Via',
    entityType: 'ship_via',
    tableName: 'ship_via_methods',
    table: shipViaMethods,
    nameField: 'name',
    schema: shipViaSchema as unknown as z.ZodObject<z.ZodRawShape>,
    seed: [{ name: 'DHL' }, { name: 'FedEx' }, { name: 'UPS' }, { name: 'US Mail' }, { name: 'Hand delivered' }],
  },
  'payment-methods': {
    key: 'payment-methods',
    label: 'Payment Methods',
    entityType: 'payment_method',
    tableName: 'payment_methods',
    table: paymentMethods,
    nameField: 'name',
    schema: paymentMethodSchema as unknown as z.ZodObject<z.ZodRawShape>,
    seed: [
      { name: 'Cash', type: 'cash' },
      { name: 'Check', type: 'check' },
      { name: 'Visa', type: 'credit_card' },
      { name: 'MasterCard', type: 'credit_card' },
      { name: 'American Express', type: 'credit_card' },
      { name: 'Discover', type: 'credit_card' },
      { name: 'Debit Card', type: 'credit_card' },
      { name: 'E-Check', type: 'ach' },
      { name: 'Bank Transfer', type: 'bank_transfer' },
      { name: 'Gift Card', type: 'other' },
    ],
  },
  'customer-messages': {
    key: 'customer-messages',
    label: 'Customer Messages',
    entityType: 'customer_message',
    tableName: 'customer_messages',
    table: customerMessages,
    nameField: 'message',
    schema: customerMessageSchema as unknown as z.ZodObject<z.ZodRawShape>,
    seed: [
      { message: 'Thank you for your business.' },
      { message: 'We appreciate your prompt payment.' },
      { message: "It's been a pleasure working with you!" },
      { message: 'Please remit to above address.' },
      { message: 'All work is complete!' },
    ],
  },
  'sales-tax-codes': {
    key: 'sales-tax-codes',
    label: 'Sales Tax Codes',
    entityType: 'sales_tax_code',
    tableName: 'sales_tax_codes',
    table: salesTaxCodes,
    nameField: 'code',
    schema: salesTaxCodeSchema as unknown as z.ZodObject<z.ZodRawShape>,
    finalize: finalizeTaxCode,
    seed: [
      { code: 'Tax', description: 'Taxable sales', taxable: true },
      { code: 'Non', description: 'Non-taxable sales', taxable: false },
    ],
  },
  vehicles: {
    key: 'vehicles',
    label: 'Vehicles',
    entityType: 'vehicle',
    tableName: 'vehicles',
    table: vehicles,
    nameField: 'name',
    schema: vehicleSchema as unknown as z.ZodObject<z.ZodRawShape>,
  },
};

export function listDef(key: SimpleListKey): ListDef {
  return DEFS[key];
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Insert QB's default entries for a list the first time the company uses it. Runs as a system
 * action (a view-only user opening the list still gets the defaults), audited like any insert.
 */
export async function ensureSeeded(ctx: ServiceContext, key: SimpleListKey): Promise<void> {
  const def = DEFS[key];
  if (!def.seed?.length) return;
  const markerId = `${ctx.companyId}:${key}`;
  const [done] = await ctx.db.select({ id: listSeeds.id }).from(listSeeds).where(eq(listSeeds.id, markerId));
  if (done) return;
  await ctx.db.transaction(async (txDb) => {
    const sys: ServiceContext = { ...ctx, db: txDb as unknown as ServiceContext['db'], role: undefined, access: undefined };
    const claimed = await sys.db
      .insert(listSeeds)
      .values({ id: markerId, companyId: ctx.companyId, listKey: key })
      .onConflictDoNothing()
      .returning({ id: listSeeds.id });
    if (claimed.length === 0) return; // another request seeded it
    const t = def.table;
    const existing: Array<Record<string, unknown>> = await sys.db.select().from(t).where(eq(t.companyId, ctx.companyId));
    const taken = new Set(existing.map((r) => String(r[def.nameField]).toLowerCase()));
    for (const entry of def.seed!) {
      if (taken.has(String(entry[def.nameField]).toLowerCase())) continue;
      const row = ((await sys.db.insert(t).values({ companyId: ctx.companyId, ...entry }).returning()) as Row[])[0];
      await writeAudit(sys, {
        action: 'create',
        entityType: def.entityType,
        entityId: row.id,
        newValues: { ...row, seeded: true },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listEntries(
  ctx: ServiceContext,
  key: SimpleListKey,
  opts: { includeInactive?: boolean } = {},
): Promise<Row[]> {
  await ensureSeeded(ctx, key);
  const def = DEFS[key];
  const t = def.table;
  const conds = [eq(t.companyId, ctx.companyId)];
  if (!opts.includeInactive) conds.push(eq(t.isActive, true));
  return (await ctx.db
    .select()
    .from(t)
    .where(and(...conds))
    .orderBy(asc(sql`lower(${t[def.nameField]})`))) as Row[];
}

export async function getEntry(ctx: ServiceContext, key: SimpleListKey, id: string): Promise<Row> {
  const def = DEFS[key];
  const t = def.table;
  const [row] = await ctx.db.select().from(t).where(and(eq(t.companyId, ctx.companyId), eq(t.id, id)));
  if (!row) throw notFound(def.label.replace(/s$/, ''));
  return row as Row;
}

function parse(def: ListDef, body: unknown, partial: boolean): Record<string, unknown> {
  const schema = partial ? def.schema.partial() : def.schema;
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    throw validation(`${where}${first?.message ?? 'Invalid input.'}`, { issues: parsed.error.issues });
  }
  return parsed.data as Record<string, unknown>;
}

async function assertUniqueName(ctx: ServiceContext, def: ListDef, name: string, selfId?: string) {
  const t = def.table;
  const rows: Array<{ id: string }> = await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.companyId, ctx.companyId), sql`lower(${t[def.nameField]}) = lower(${name})`));
  if (rows.some((r) => r.id !== selfId)) {
    throw validation(`"${name}" is already on the ${def.label} list.`);
  }
}

export async function createEntry(ctx: ServiceContext, key: SimpleListKey, body: unknown): Promise<Row> {
  await ensureSeeded(ctx, key);
  const def = DEFS[key];
  let data = parse(def, body, false);
  if (def.finalize) data = await def.finalize(ctx, data);
  await assertUniqueName(ctx, def, String(data[def.nameField]));
  return inTransaction(ctx, async (tx) => {
    const inserted = (await tx.db
      .insert(def.table)
      .values({ ...data, companyId: tx.companyId, isActive: data.isActive ?? true })
      .returning()) as Row[];
    const row = inserted[0];
    await writeAudit(tx, { action: 'create', entityType: def.entityType, entityId: row.id, newValues: row });
    return row as Row;
  });
}

export async function updateEntry(ctx: ServiceContext, key: SimpleListKey, id: string, body: unknown): Promise<Row> {
  const def = DEFS[key];
  const before = await getEntry(ctx, key, id);
  const patch = parse(def, body, true);
  // Re-validate the whole record as it will be after the update.
  const merged: Record<string, unknown> = {};
  for (const k of Object.keys(def.schema.shape)) merged[k] = k in patch ? patch[k] : before[k];
  let data = parse(def, stripNulls(merged, def), false);
  for (const k of Object.keys(def.schema.shape)) if (merged[k] === null) data[k] = null;
  if (def.finalize) data = await def.finalize(ctx, data, id);
  await assertUniqueName(ctx, def, String(data[def.nameField]), id);
  const t = def.table;
  return inTransaction(ctx, async (tx) => {
    const set: Record<string, unknown> = { ...data };
    if ('updatedAt' in t) set.updatedAt = new Date();
    const [row] = await tx.db.update(t).set(set).where(and(eq(t.id, id), eq(t.companyId, tx.companyId))).returning();
    await writeAudit(tx, { action: 'update', entityType: def.entityType, entityId: id, oldValues: before, newValues: row });
    return row as Row;
  });
}

/** Drop null values the schema would reject on a full parse (e.g. a stored numeric '1.0000'). */
function stripNulls(rec: Record<string, unknown>, def: ListDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(def.schema.shape)) {
    const v = rec[k];
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Delete an unused entry; an entry in use anywhere is deactivated instead. */
export async function removeEntry(
  ctx: ServiceContext,
  key: SimpleListKey,
  id: string,
): Promise<{ deleted: boolean; deactivated: boolean }> {
  const def = DEFS[key];
  const before = await getEntry(ctx, key, id);
  const used = await isReferenced(ctx, def.tableName, id);
  return inTransaction(ctx, async (tx) => {
    const t = def.table;
    if (used) {
      await tx.db.update(t).set({ isActive: false }).where(eq(t.id, id));
      await writeAudit(tx, {
        action: 'update',
        entityType: def.entityType,
        entityId: id,
        oldValues: { isActive: before.isActive },
        newValues: { isActive: false, reason: 'in use — made inactive instead of deleted' },
      });
      return { deleted: false, deactivated: true };
    }
    await tx.db.delete(t).where(eq(t.id, id));
    await writeAudit(tx, { action: 'delete', entityType: def.entityType, entityId: id, oldValues: before });
    return { deleted: true, deactivated: false };
  });
}

/** Verify an id belongs to the company's list (any status); returns the row. */
export async function requireEntry(ctx: ServiceContext, key: SimpleListKey, id: string): Promise<Row> {
  return getEntry(ctx, key, id);
}
