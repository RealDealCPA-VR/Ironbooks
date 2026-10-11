/**
 * Custom Fields service (QB "Define Fields" parity).
 *
 * Two halves:
 *  1. DEFINITIONS — the company defines up to MAX_CUSTOM_FIELDS named fields
 *     per entity type (customer / vendor / item / invoice), stored in
 *     companies.settings.customFields:
 *       { customer: [{ name }], vendor: [{ name }], item: [{ name }], invoice: [{ name }] }
 *  2. VALUES — each entity row carries its own values in a `custom_fields`
 *     jsonb column ({ [fieldName]: value }); `setEntityCustomFields`
 *     patch-merges validated values onto the row (empty string clears a key).
 *
 * Definitions are admin/owner only (QB: only the Admin can define fields);
 * values are writable by any non-viewer role (enforced centrally by writeAudit).
 */
import { and, eq } from 'drizzle-orm';
import { companies, customers, vendors, items, invoices } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { requireEffectivePermission } from './access';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CustomFieldEntity = 'customer' | 'vendor' | 'item' | 'invoice';

export const CUSTOM_FIELD_ENTITIES: CustomFieldEntity[] = [
  'customer',
  'vendor',
  'item',
  'invoice',
];

/** QB Desktop allows 7 custom fields per name list (15 for items in Enterprise — we use 7). */
export const MAX_CUSTOM_FIELDS = 7;

/** QB field labels max out at 31 characters. */
export const MAX_FIELD_NAME_LENGTH = 31;

export interface CustomFieldDefinition {
  name: string;
}

export type CustomFieldDefinitions = Record<CustomFieldEntity, CustomFieldDefinition[]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyDefinitions(): CustomFieldDefinitions {
  return { customer: [], vendor: [], item: [], invoice: [] };
}

function normalizeDefinitions(raw: unknown): CustomFieldDefinitions {
  const out = emptyDefinitions();
  if (!raw || typeof raw !== 'object') return out;
  for (const entity of CUSTOM_FIELD_ENTITIES) {
    const list = (raw as Record<string, unknown>)[entity];
    if (!Array.isArray(list)) continue;
    out[entity] = list
      .map((d) => ({ name: String((d as { name?: unknown })?.name ?? '').trim() }))
      .filter((d) => d.name.length > 0);
  }
  return out;
}

function validateDefinitionList(entity: CustomFieldEntity, list: CustomFieldDefinition[]) {
  if (list.length > MAX_CUSTOM_FIELDS) {
    throw validation(
      `Too many custom fields for ${entity}: ${list.length} (maximum ${MAX_CUSTOM_FIELDS}).`,
    );
  }
  const seen = new Set<string>();
  for (const def of list) {
    const name = def.name.trim();
    if (!name) throw validation(`Custom field names for ${entity} cannot be empty.`);
    if (name.length > MAX_FIELD_NAME_LENGTH) {
      throw validation(
        `Custom field name "${name}" is too long (maximum ${MAX_FIELD_NAME_LENGTH} characters).`,
      );
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw validation(`Duplicate custom field name "${name}" for ${entity}.`);
    }
    seen.add(key);
  }
}

/** Entity type → table with a `custom_fields` jsonb column. */
const ENTITY_TABLES = {
  customer: customers,
  vendor: vendors,
  item: items,
  invoice: invoices,
} as const;

const ENTITY_AUDIT_TYPE: Record<CustomFieldEntity, string> = {
  customer: 'customer',
  vendor: 'vendor',
  item: 'item',
  invoice: 'invoice',
};

// ---------------------------------------------------------------------------
// Definitions: get / set
// ---------------------------------------------------------------------------

/** Read the company's custom-field definitions (always a full, normalized map). */
export async function getCustomFieldDefinitions(
  ctx: ServiceContext,
): Promise<CustomFieldDefinitions> {
  const [company] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (!company) throw notFound('Company');
  return normalizeDefinitions((company.settings ?? {}).customFields);
}

/**
 * Replace custom-field definitions. Entities omitted from `input` keep their
 * current lists; entities provided are replaced wholesale (pass [] to clear).
 * Admin/owner only.
 */
export async function setCustomFieldDefinitions(
  ctx: ServiceContext,
  input: Partial<Record<CustomFieldEntity, CustomFieldDefinition[]>>,
): Promise<CustomFieldDefinitions> {
  // Enterprise roles: Lists / Centers — modify (same rule as PATCH /api/custom-fields).
  await requireEffectivePermission(ctx, 'lists', 'modify');

  const [company] = await ctx.db
    .select()
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (!company) throw notFound('Company');

  const before = normalizeDefinitions((company.settings ?? {}).customFields);
  const next: CustomFieldDefinitions = { ...before };

  for (const entity of CUSTOM_FIELD_ENTITIES) {
    const list = input[entity];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw validation(`Definitions for ${entity} must be an array of { name } objects.`);
    }
    const normalized = list.map((d) => ({ name: String(d?.name ?? '').trim() }));
    validateDefinitionList(entity, normalized);
    next[entity] = normalized;
  }

  const settings = { ...((company.settings ?? {}) as Record<string, unknown>) };
  settings.customFields = next;

  await ctx.db
    .update(companies)
    .set({ settings, updatedAt: new Date() })
    .where(eq(companies.id, ctx.companyId));

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'company',
    entityId: ctx.companyId,
    oldValues: { customFields: before },
    newValues: { customFields: next },
  });

  return next;
}

// ---------------------------------------------------------------------------
// Values: set on an entity row
// ---------------------------------------------------------------------------

/**
 * Patch-merge custom-field values onto an entity row (customers.custom_fields
 * etc.). Keys must match a defined field name for the entity type (exact
 * match). Empty-string values remove the key. Returns the stored map.
 */
export async function setEntityCustomFields(
  ctx: ServiceContext,
  entity: CustomFieldEntity,
  id: string,
  values: Record<string, string>,
): Promise<Record<string, string>> {
  if (!CUSTOM_FIELD_ENTITIES.includes(entity)) {
    throw validation(`Unknown custom-field entity "${entity}".`);
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw validation('values must be an object of { fieldName: value }.');
  }

  const defs = await getCustomFieldDefinitions(ctx);
  const definedNames = new Set(defs[entity].map((d) => d.name));

  for (const key of Object.keys(values)) {
    if (!definedNames.has(key)) {
      throw validation(
        `"${key}" is not a defined custom field for ${entity}. Define it first.`,
      );
    }
  }

  const table = ENTITY_TABLES[entity];

  const [row] = await ctx.db
    .select({ id: table.id, customFields: table.customFields })
    .from(table)
    .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)));
  if (!row) throw notFound(`${entity[0].toUpperCase()}${entity.slice(1)}`);

  const before = (row.customFields ?? {}) as Record<string, string>;
  const next: Record<string, string> = { ...before };
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw ?? '').trim();
    if (value === '') delete next[key];
    else next[key] = value;
  }

  await ctx.db
    .update(table)
    .set({ customFields: next })
    .where(and(eq(table.id, id), eq(table.companyId, ctx.companyId)));

  await writeAudit(ctx, {
    action: 'update',
    entityType: ENTITY_AUDIT_TYPE[entity],
    entityId: id,
    oldValues: { customFields: before },
    newValues: { customFields: next },
  });

  return next;
}
