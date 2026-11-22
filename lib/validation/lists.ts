/**
 * Zod schemas for the wave-2 lists (lib/services/lists/*): the simple QB lists (Other Names, Job
 * Types, Terms, Ship Via, Payment Methods, Customer Messages, Sales Tax Codes, Vehicles), To Do,
 * Notes, Billing Rate Levels, Unit of Measure sets, Add/Edit Multiple, Clean Up and the item
 * tools (opening stock, change prices, POs from the reorder list).
 */
import { z } from 'zod';
import { zDate, zDecimal, zUuid } from './helpers';

const zName = (max: number, what = 'Name') =>
  z.string({ required_error: `${what} is required.` }).trim().min(1, `${what} is required.`).max(max, `${what} is too long (max ${max} characters).`);
const zOptText = (max: number) => z.string().trim().max(max, `Too long (max ${max} characters).`).nullish();
const zEmail = z.union([z.literal(''), z.string().trim().email('is not a valid email address')]).nullish();
const zInt = (min: number, max: number, what: string) =>
  z.coerce.number({ invalid_type_error: `${what} must be a whole number.` }).int(`${what} must be a whole number.`).min(min, `${what} must be at least ${min}.`).max(max, `${what} must be at most ${max}.`);

export const addressSchema = z
  .object({
    line1: z.string().optional(),
    line2: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
  })
  .nullish();

export const otherNameSchema = z.object({
  name: zName(255),
  companyName: zOptText(255),
  email: zEmail,
  phone: zOptText(50),
  address: addressSchema,
  accountNumber: zOptText(100),
  notes: z.string().nullish(),
  billingRateLevelId: zUuid.nullish(),
  isActive: z.boolean().optional(),
});

export const jobTypeSchema = z.object({
  name: zName(255),
  parentId: zUuid.nullish(),
  isActive: z.boolean().optional(),
});

export const TERMS_KINDS = ['standard', 'date_driven'] as const;
export const termsSchema = z.object({
  name: zName(100),
  kind: z.enum(TERMS_KINDS).default('standard'),
  netDays: zInt(0, 999, 'Net due days').nullish(),
  discountPercent: zDecimal.nullish(),
  discountDays: zInt(0, 999, 'Discount days').nullish(),
  dueDayOfMonth: zInt(1, 31, 'Due day of month').nullish(),
  dueNextMonthWithinDays: zInt(0, 30, 'Days before the due date').nullish(),
  discountDayOfMonth: zInt(1, 31, 'Discount day of month').nullish(),
  isActive: z.boolean().optional(),
});

export const shipViaSchema = z.object({ name: zName(100), isActive: z.boolean().optional() });

export const PAYMENT_METHOD_TYPES = ['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'] as const;
export const paymentMethodSchema = z.object({
  name: zName(100),
  type: z.enum(PAYMENT_METHOD_TYPES).default('other'),
  isActive: z.boolean().optional(),
});

export const customerMessageSchema = z.object({
  message: zName(500, 'Message'),
  isActive: z.boolean().optional(),
});

export const salesTaxCodeSchema = z.object({
  code: zName(3, 'Code'),
  description: zOptText(255),
  taxable: z.boolean().default(true),
  isActive: z.boolean().optional(),
});

export const vehicleSchema = z.object({
  name: zName(100),
  description: zOptText(255),
  isActive: z.boolean().optional(),
});

// ---- To Do + Notes ----
export const TODO_TYPES = ['call', 'fax', 'email', 'meeting', 'appointment', 'task'] as const;
export const TODO_PRIORITIES = ['low', 'medium', 'high'] as const;
export const TODO_STATUSES = ['open', 'done', 'inactive'] as const;
export const NOTE_ENTITY_TYPES = ['customer', 'vendor', 'employee', 'other_name'] as const;
export const TODO_ENTITY_TYPES = ['customer', 'vendor', 'employee', 'other_name', 'item'] as const;

export const todoSchema = z.object({
  title: zName(255, 'Title'),
  details: z.string().nullish(),
  type: z.enum(TODO_TYPES).default('task'),
  priority: z.enum(TODO_PRIORITIES).default('medium'),
  status: z.enum(TODO_STATUSES).default('open'),
  dueDate: zDate.nullish(),
  entityType: z.enum(TODO_ENTITY_TYPES).nullish(),
  entityId: zUuid.nullish(),
  assignedUserId: zUuid.nullish(),
});
export const todoUpdateSchema = todoSchema.partial();

export const noteSchema = z.object({
  entityType: z.enum(NOTE_ENTITY_TYPES),
  entityId: zUuid,
  body: z.string().trim().min(1, 'The note is empty.').max(20000, 'The note is too long.'),
  noteDate: zDate.nullish(),
});
export const noteUpdateSchema = z.object({
  body: z.string().trim().min(1, 'The note is empty.').max(20000, 'The note is too long.').optional(),
  noteDate: zDate.nullish(),
});

// ---- Billing rate levels ----
// Create and edit (PUT) take the same full body: an edit replaces the level, its custom rates included.
export const billingRateLevelSchema = z.object({
  name: zName(100).describe('Name of the billing rate level, such as "Senior consultant" (at most 100 characters).'),
  type: z
    .enum(['fixed_rate', 'custom'])
    .default('fixed_rate')
    .describe('fixed_rate (the default): one hourly rate for every service item; custom: a rate per service item in items.'),
  fixedRate: zDecimal
    .nullish()
    .describe('With type fixed_rate: the hourly rate as decimal text such as "150.00" (required there, not used for custom).'),
  isActive: z
    .boolean()
    .optional()
    .describe('False hides the level from lists; on a new level leave out for active, and on an edit leave out to keep it.'),
  items: z
    .array(
      z.object({
        itemId: zUuid.describe('Id of a service item (item list).'),
        rate: zDecimal.describe('Hourly rate for that item as decimal text such as "150.00".'),
      }),
    )
    .max(5000)
    .optional()
    .describe('With type custom: the rate per service item, replacing the saved ones; a service item not listed bills at its sales price.'),
});

/** POST /api/billing-rate-levels/assign — give an employee, vendor or other name a billing rate level. */
export const assignBillingRateLevelSchema = z.object({
  employeeId: zUuid.optional().describe('Id of the employee to assign the level to; send exactly one of employeeId, vendorId and otherNameId.'),
  vendorId: zUuid.optional().describe('Id of the vendor to assign the level to; send exactly one of employeeId, vendorId and otherNameId.'),
  otherNameId: zUuid
    .optional()
    .describe('Id of the Other Names list entry to assign the level to; send exactly one of employeeId, vendorId and otherNameId.'),
  levelId: zUuid.nullable().describe('Id of the billing rate level to assign, or null to take the level off.'),
});

// ---- Unit of measure sets ----
export const UOM_KINDS = ['count', 'length', 'weight', 'volume', 'area', 'time', 'other'] as const;
// Create and edit (PUT) take the same full body: an edit replaces the set, its units included.
export const uomSetSchema = z.object({
  name: zName(100).describe('Name of the unit of measure set, such as "Box of 12" (at most 100 characters).'),
  kind: z
    .enum(UOM_KINDS)
    .default('count')
    .describe('What the units measure: count (the default), length, weight, volume, area, time or other.'),
  baseUnitName: zName(50, 'Base unit name').describe('Name of the base unit every other unit is a multiple of, such as "Each".'),
  baseUnitAbbrev: zName(20, 'Base unit abbreviation').describe('Short name of the base unit, such as "ea".'),
  defaultPurchaseUnit: zOptText(50).describe("Name of one of the set's units that purchase orders preselect; leave out for none."),
  defaultSalesUnit: zOptText(50).describe("Name of one of the set's units that sales forms preselect; leave out for none."),
  defaultShippingUnit: zOptText(50).describe("Name of one of the set's units that packing slips preselect; leave out for none."),
  isActive: z.boolean().optional().describe('False makes the set inactive; leaving it out makes it active, on an edit too.'),
  units: z
    .array(
      z.object({
        name: zName(50, 'Unit name').describe('Name of the unit, such as "Box".'),
        abbrev: zName(20, 'Unit abbreviation').describe('Short name of the unit, such as "bx".'),
        factor: zDecimal.describe('How many base units one of this unit holds, as decimal text such as "12".'),
      }),
    )
    .max(50)
    .default([])
    .describe('The other units of the set besides the base unit, at most 50; leave out for none.'),
});

// ---- Add/Edit Multiple ----
export const BULK_LISTS = ['customers', 'vendors', 'items'] as const;
export const bulkSchema = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1, 'Add at least one row.').max(1000, 'At most 1000 rows at a time.'),
  /** Validate only — nothing is saved. */
  dryRun: z.boolean().optional(),
});

// ---- Clean Up Company Data ----
export const CLEANUP_LISTS = [
  'customers', 'vendors', 'items', 'classes', 'other-names', 'job-types', 'terms', 'ship-via',
  'payment-methods', 'customer-messages', 'sales-tax-codes', 'vehicles', 'customer-types',
  'vendor-types', 'billing-rate-levels', 'uom-sets',
] as const;
export const cleanupSchema = z.object({
  lists: z.array(z.enum(CLEANUP_LISTS)).min(1).optional(),
  /** Only these ids (from the preview) are removed; omit to remove every eligible entry. */
  ids: z.array(zUuid).max(5000).optional(),
});

// ---- Item tools ----
export const openingStockSchema = z.object({
  openingQuantity: zDecimal.nullish(),
  /** Total value of the opening quantity (preferred) ... */
  openingValue: zDecimal.nullish(),
  /** ... or a unit cost (value = quantity × unit cost). */
  openingUnitCost: zDecimal.nullish(),
  openingAsOf: zDate.nullish(),
});

export const changeItemPricesSchema = z.object({
  itemIds: z.array(zUuid).max(5000).optional(),
  itemType: z.enum(['service', 'inventory', 'non_inventory', 'bundle', 'other_charge']).optional(),
  /** Base the new price on the current price or on the item's cost. */
  basis: z.enum(['price', 'cost']).default('price'),
  adjustBy: z.enum(['percent', 'amount']),
  /** Signed: 10 = +10% (or +$10), -5 = -5%. */
  value: zDecimal,
  rounding: z.enum(['none', 'cent', 'dime', 'dollar', 'up_99']).default('cent'),
  dryRun: z.boolean().optional(),
});

export const reorderPoSchema = z.object({
  itemIds: z.array(zUuid).max(5000).optional(),
  /** Per-item quantity overrides (else the suggested reorder quantity). */
  quantities: z.record(zUuid, zDecimal).optional(),
  date: zDate.optional(),
  dryRun: z.boolean().optional(),
});

export const mergeMoreSchema = z.object({
  type: z.enum(['customer', 'vendor', 'account', 'item', 'class', 'employee', 'other_name']),
  fromId: zUuid,
  toId: zUuid,
});

export const taxRatePatchSchema = z.object({
  name: z.string().trim().min(1, 'Rate name is required.').max(255).optional(),
  rate: zDecimal.optional(),
  agencyId: zUuid.nullish(),
  isActive: z.boolean().optional(),
});

/** B18: POST /api/tax-rates — a new sales tax item { name, rate (0..1 fraction), agencyId?, isActive? }. */
export const taxRateCreateSchema = z.object({
  name: zName(255, 'Rate name'),
  rate: zDecimal,
  agencyId: zUuid.nullish(),
  isActive: z.boolean().optional(),
});
