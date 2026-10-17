/**
 * Billing Rate Levels (QB Contractor/Professional/Enterprise time billing).
 *
 *  - 'fixed_rate': one hourly rate for every service item billed for the person;
 *  - 'custom': a rate per service item (items without a custom rate use their sales price).
 *
 * Levels are assigned to employees, vendors and other names. `resolveBillingRate` is the hook the
 * time-billing flow (time entries → invoice) calls to price a billable hour; precedence there is
 * QB's: billing rate level of the person > the service item's sales price. No GL impact.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  billingRateLevelItems,
  billingRateLevels,
  employees,
  items,
  otherNames,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { billingRateLevelSchema } from '@/lib/validation/lists';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from '../_base';
import { isReferenced } from './references';
import { assertListDeleteAllowed } from '../accountantCopy/guard';

function parseOrThrow<T>(r: { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } }): T {
  if (r.success) return r.data;
  const first = r.error.issues[0];
  throw validation(`${first?.path?.length ? first.path.join('.') + ': ' : ''}${first?.message ?? 'Invalid input.'}`);
}

export async function listBillingRateLevels(ctx: ServiceContext, opts: { includeInactive?: boolean } = {}) {
  const conds = [eq(billingRateLevels.companyId, ctx.companyId)];
  if (!opts.includeInactive) conds.push(eq(billingRateLevels.isActive, true));
  return ctx.db.select().from(billingRateLevels).where(and(...conds)).orderBy(asc(billingRateLevels.name));
}

export async function getBillingRateLevel(ctx: ServiceContext, id: string) {
  const [level] = await ctx.db
    .select()
    .from(billingRateLevels)
    .where(and(eq(billingRateLevels.id, id), eq(billingRateLevels.companyId, ctx.companyId)));
  if (!level) throw notFound('Billing rate level');
  const rates = await ctx.db
    .select({ itemId: billingRateLevelItems.itemId, rate: billingRateLevelItems.rate, itemName: items.name })
    .from(billingRateLevelItems)
    .innerJoin(items, eq(items.id, billingRateLevelItems.itemId))
    .where(eq(billingRateLevelItems.levelId, id))
    .orderBy(asc(items.name));
  return { ...level, items: rates };
}

async function validateLevel(ctx: ServiceContext, body: unknown, selfId?: string) {
  const input = parseOrThrow(billingRateLevelSchema.safeParse(body ?? {}));
  const dup = await ctx.db
    .select({ id: billingRateLevels.id, name: billingRateLevels.name })
    .from(billingRateLevels)
    .where(eq(billingRateLevels.companyId, ctx.companyId));
  if (dup.some((d) => d.id !== selfId && d.name.toLowerCase() === input.name.toLowerCase())) {
    throw validation(`A billing rate level named "${input.name}" already exists.`);
  }
  let fixedRate: string | null = null;
  if (input.type === 'fixed_rate') {
    if (input.fixedRate == null) throw validation('Enter the hourly rate for this level.');
    const r = Money.of(input.fixedRate);
    if (r.isNegative()) throw validation('The hourly rate cannot be negative.');
    fixedRate = r.toFixed(4);
  }
  const rates = input.type === 'custom' ? input.items ?? [] : [];
  const seen = new Set<string>();
  for (const r of rates) {
    if (seen.has(r.itemId)) throw validation('Each service item can appear only once.');
    seen.add(r.itemId);
    if (Money.of(r.rate).isNegative()) throw validation('Rates cannot be negative.');
  }
  if (rates.length) {
    const found = await ctx.db
      .select({ id: items.id, type: items.type })
      .from(items)
      .where(and(eq(items.companyId, ctx.companyId), inArray(items.id, [...seen])));
    if (found.length !== seen.size) throw notFound('Item');
    if (found.some((f) => f.type !== 'service')) throw validation('Billing rates apply to service items only.');
  }
  return { input, fixedRate, rates };
}

export async function createBillingRateLevel(ctx: ServiceContext, body: unknown) {
  const { input, fixedRate, rates } = await validateLevel(ctx, body);
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(billingRateLevels)
      .values({ companyId: tx.companyId, name: input.name, type: input.type, fixedRate, isActive: input.isActive ?? true })
      .returning();
    if (rates.length) {
      await tx.db.insert(billingRateLevelItems).values(
        rates.map((r) => ({ companyId: tx.companyId, levelId: row.id, itemId: r.itemId, rate: Money.of(r.rate).toFixed(4) })),
      );
    }
    await writeAudit(tx, { action: 'create', entityType: 'billing_rate_level', entityId: row.id, newValues: { ...row, items: rates } });
    return getBillingRateLevel(tx, row.id);
  });
}

export async function updateBillingRateLevel(ctx: ServiceContext, id: string, body: unknown) {
  const before = await getBillingRateLevel(ctx, id);
  const { input, fixedRate, rates } = await validateLevel(ctx, body, id);
  // Making a level inactive is deleting it: refused while an Accountant's Copy is out (I1).
  if (input.isActive === false && before.isActive) await assertListDeleteAllowed(ctx, 'delete', 'billing rate levels');
  return inTransaction(ctx, async (tx) => {
    await tx.db
      .update(billingRateLevels)
      .set({ name: input.name, type: input.type, fixedRate, isActive: input.isActive ?? before.isActive, updatedAt: new Date() })
      .where(eq(billingRateLevels.id, id));
    await tx.db.delete(billingRateLevelItems).where(eq(billingRateLevelItems.levelId, id));
    if (rates.length) {
      await tx.db.insert(billingRateLevelItems).values(
        rates.map((r) => ({ companyId: tx.companyId, levelId: id, itemId: r.itemId, rate: Money.of(r.rate).toFixed(4) })),
      );
    }
    const after = await getBillingRateLevel(tx, id);
    await writeAudit(tx, { action: 'update', entityType: 'billing_rate_level', entityId: id, oldValues: before, newValues: after });
    return after;
  });
}

/** Delete when no one uses the level, otherwise deactivate. */
export async function deleteBillingRateLevel(ctx: ServiceContext, id: string) {
  await assertListDeleteAllowed(ctx, 'delete', 'billing rate levels'); // Accountant's Copy (I1)
  const before = await getBillingRateLevel(ctx, id);
  // Its own per-item rates are part of the level, not a "use" of it.
  const assigned =
    (await ctx.db.select({ id: employees.id }).from(employees).where(eq(employees.billingRateLevelId, id)).limit(1)).length +
    (await ctx.db.select({ id: vendors.id }).from(vendors).where(eq(vendors.billingRateLevelId, id)).limit(1)).length +
    (await ctx.db.select({ id: otherNames.id }).from(otherNames).where(eq(otherNames.billingRateLevelId, id)).limit(1)).length;
  return inTransaction(ctx, async (tx) => {
    if (assigned > 0) {
      await tx.db.update(billingRateLevels).set({ isActive: false, updatedAt: new Date() }).where(eq(billingRateLevels.id, id));
      await writeAudit(tx, {
        action: 'update',
        entityType: 'billing_rate_level',
        entityId: id,
        oldValues: { isActive: before.isActive },
        newValues: { isActive: false, reason: 'in use — made inactive instead of deleted' },
      });
      return { deleted: false, deactivated: true };
    }
    await tx.db.delete(billingRateLevelItems).where(eq(billingRateLevelItems.levelId, id));
    await tx.db.delete(billingRateLevels).where(eq(billingRateLevels.id, id));
    await writeAudit(tx, { action: 'delete', entityType: 'billing_rate_level', entityId: id, oldValues: before });
    return { deleted: true, deactivated: false };
  });
}

export type RatePerson = { employeeId?: string | null; vendorId?: string | null; otherNameId?: string | null };

/** Assign (or clear) the billing rate level of an employee, vendor or other name. */
export async function assignBillingRateLevel(ctx: ServiceContext, person: RatePerson, levelId: string | null) {
  if (levelId) await getBillingRateLevel(ctx, levelId);
  return inTransaction(ctx, async (tx) => {
    const c = tx.companyId;
    let entityType: string;
    let entityId: string;
    let before: string | null;
    if (person.employeeId) {
      const [r] = await tx.db.select({ v: employees.billingRateLevelId }).from(employees).where(and(eq(employees.id, person.employeeId), eq(employees.companyId, c)));
      if (!r) throw notFound('Employee');
      before = r.v;
      await tx.db.update(employees).set({ billingRateLevelId: levelId, updatedAt: new Date() }).where(eq(employees.id, person.employeeId));
      entityType = 'employee';
      entityId = person.employeeId;
    } else if (person.vendorId) {
      const [r] = await tx.db.select({ v: vendors.billingRateLevelId }).from(vendors).where(and(eq(vendors.id, person.vendorId), eq(vendors.companyId, c)));
      if (!r) throw notFound('Vendor');
      before = r.v;
      await tx.db.update(vendors).set({ billingRateLevelId: levelId, updatedAt: new Date() }).where(eq(vendors.id, person.vendorId));
      entityType = 'vendor';
      entityId = person.vendorId;
    } else if (person.otherNameId) {
      const [r] = await tx.db.select({ v: otherNames.billingRateLevelId }).from(otherNames).where(and(eq(otherNames.id, person.otherNameId), eq(otherNames.companyId, c)));
      if (!r) throw notFound('Other name');
      before = r.v;
      await tx.db.update(otherNames).set({ billingRateLevelId: levelId, updatedAt: new Date() }).where(eq(otherNames.id, person.otherNameId));
      entityType = 'other_name';
      entityId = person.otherNameId;
    } else {
      throw validation('Pick an employee, vendor or other name.');
    }
    await writeAudit(tx, { action: 'update', entityType, entityId, oldValues: { billingRateLevelId: before }, newValues: { billingRateLevelId: levelId } });
    return { entityType, entityId, billingRateLevelId: levelId };
  });
}

export interface ResolvedBillingRate {
  /** Hourly rate (4dp string), or null when the item has no price and no level applies. */
  rate: string | null;
  source: 'billing_rate_level' | 'item_price' | 'none';
  levelId: string | null;
  levelName: string | null;
}

/**
 * Hourly rate to bill for `serviceItemId` worked by the given person. TODO(time billing):
 * lib/services/timeTracking.ts / billables.ts should call this when turning billable time into
 * invoice lines (time entries carry employeeId; vendor/other-name time when those are added).
 */
export async function resolveBillingRate(
  ctx: ServiceContext,
  person: RatePerson,
  serviceItemId: string,
): Promise<ResolvedBillingRate> {
  const [item] = await ctx.db
    .select({ id: items.id, salesPrice: items.salesPrice })
    .from(items)
    .where(and(eq(items.id, serviceItemId), eq(items.companyId, ctx.companyId)));
  if (!item) throw notFound('Service item');
  let levelId: string | null = null;
  if (person.employeeId) {
    const [r] = await ctx.db.select({ v: employees.billingRateLevelId }).from(employees).where(and(eq(employees.id, person.employeeId), eq(employees.companyId, ctx.companyId)));
    levelId = r?.v ?? null;
  } else if (person.vendorId) {
    const [r] = await ctx.db.select({ v: vendors.billingRateLevelId }).from(vendors).where(and(eq(vendors.id, person.vendorId), eq(vendors.companyId, ctx.companyId)));
    levelId = r?.v ?? null;
  } else if (person.otherNameId) {
    const [r] = await ctx.db.select({ v: otherNames.billingRateLevelId }).from(otherNames).where(and(eq(otherNames.id, person.otherNameId), eq(otherNames.companyId, ctx.companyId)));
    levelId = r?.v ?? null;
  }
  const itemPrice = item.salesPrice != null ? Money.of(item.salesPrice).toFixed(4) : null;
  if (levelId) {
    const [level] = await ctx.db.select().from(billingRateLevels).where(eq(billingRateLevels.id, levelId));
    if (level && level.isActive) {
      if (level.type === 'fixed_rate' && level.fixedRate != null) {
        return { rate: Money.of(level.fixedRate).toFixed(4), source: 'billing_rate_level', levelId, levelName: level.name };
      }
      if (level.type === 'custom') {
        const [custom] = await ctx.db
          .select({ rate: billingRateLevelItems.rate })
          .from(billingRateLevelItems)
          .where(and(eq(billingRateLevelItems.levelId, levelId), eq(billingRateLevelItems.itemId, serviceItemId)));
        if (custom) return { rate: Money.of(custom.rate).toFixed(4), source: 'billing_rate_level', levelId, levelName: level.name };
      }
    }
  }
  return { rate: itemPrice, source: itemPrice ? 'item_price' : 'none', levelId: null, levelName: null };
}

/** Exposed for Clean Up: is the level referenced outside its own rate rows? */
export async function billingRateLevelInUse(ctx: ServiceContext, id: string): Promise<boolean> {
  return isReferenced(ctx, 'billing_rate_levels', id);
}
