/**
 * Billing Groups (QB Batch Invoice "Billing Group", C6): named sets of customers that Batch
 * Invoicing bills together — "Monthly retainer clients", "HOA members". Picking a group on the
 * Batch Invoicing page selects its customers; the current selection can be saved as a group.
 *
 * Company-scoped; names are unique per company (case-insensitive, the database index
 * billing_groups_company_name_uq is the backstop); members must be this company's customers.
 * Customer merges move memberships to the surviving customer (merge.ts) and Clean Up Company
 * Data drops the memberships of a customer it removes (lists/cleanup.ts). No GL impact.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { billingGroupMembers, billingGroups, customers } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { assertListDeleteAllowed } from './accountantCopy/guard';

export interface BillingGroupMember {
  customerId: string;
  displayName: string;
  isActive: boolean;
}

export interface BillingGroupView {
  id: string;
  name: string;
  customerIds: string[];
  members: BillingGroupMember[];
}

/** At most this many customers in one group (Batch Invoicing bills 500 at a time). */
export const MAX_GROUP_MEMBERS = 2000;

function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw validation('Give the billing group a name.');
  if (name.length > 100) throw validation('Billing group names are limited to 100 characters.');
  return name;
}

async function assertUniqueName(ctx: ServiceContext, name: string, selfId?: string) {
  const [dup] = await ctx.db
    .select({ id: billingGroups.id })
    .from(billingGroups)
    .where(and(eq(billingGroups.companyId, ctx.companyId), sql`lower(${billingGroups.name}) = lower(${name})`));
  if (dup && dup.id !== selfId) throw validation(`A billing group named "${name}" already exists.`);
}

/** De-duplicated member ids, each verified to be one of this company's customers. */
async function cleanMembers(ctx: ServiceContext, raw: unknown): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
    throw validation('Pick the customers as a list of customer ids.');
  }
  const ids = [...new Set((raw as string[]).map((v) => v.toLowerCase()))];
  if (ids.length > MAX_GROUP_MEMBERS) {
    throw validation(`A billing group can hold at most ${MAX_GROUP_MEMBERS.toLocaleString('en-US')} customers.`);
  }
  if (ids.length === 0) return [];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (ids.some((v) => !UUID.test(v))) throw notFound('Customer');
  const found = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, ids)));
  if (found.length !== ids.length) throw notFound('Customer');
  return ids;
}

async function loadGroup(ctx: ServiceContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Billing group');
  const [g] = await ctx.db
    .select()
    .from(billingGroups)
    .where(and(eq(billingGroups.companyId, ctx.companyId), eq(billingGroups.id, id)));
  if (!g) throw notFound('Billing group');
  return g;
}

async function membersOf(ctx: ServiceContext, groupIds: string[]) {
  if (groupIds.length === 0) return [];
  return ctx.db
    .select({
      groupId: billingGroupMembers.groupId,
      customerId: billingGroupMembers.customerId,
      displayName: customers.displayName,
      isActive: customers.isActive,
    })
    .from(billingGroupMembers)
    .innerJoin(customers, eq(customers.id, billingGroupMembers.customerId))
    .where(and(eq(billingGroupMembers.companyId, ctx.companyId), inArray(billingGroupMembers.groupId, groupIds)))
    .orderBy(asc(customers.displayName));
}

/** Every billing group with its customers (by name). */
export async function listBillingGroups(ctx: ServiceContext): Promise<BillingGroupView[]> {
  const groups = await ctx.db
    .select()
    .from(billingGroups)
    .where(eq(billingGroups.companyId, ctx.companyId))
    .orderBy(asc(billingGroups.name));
  const members = await membersOf(ctx, groups.map((g) => g.id));
  return groups.map((g) => {
    const mine = members.filter((m) => m.groupId === g.id);
    return {
      id: g.id,
      name: g.name,
      customerIds: mine.map((m) => m.customerId),
      members: mine.map(({ customerId, displayName, isActive }) => ({ customerId, displayName, isActive })),
    };
  });
}

export async function getBillingGroup(ctx: ServiceContext, id: string): Promise<BillingGroupView> {
  const g = await loadGroup(ctx, id);
  const mine = await membersOf(ctx, [g.id]);
  return {
    id: g.id,
    name: g.name,
    customerIds: mine.map((m) => m.customerId),
    members: mine.map(({ customerId, displayName, isActive }) => ({ customerId, displayName, isActive })),
  };
}

async function replaceMembers(tx: ServiceContext, groupId: string, customerIds: string[]) {
  await tx.db.delete(billingGroupMembers).where(and(eq(billingGroupMembers.companyId, tx.companyId), eq(billingGroupMembers.groupId, groupId)));
  if (customerIds.length) {
    await tx.db
      .insert(billingGroupMembers)
      .values(customerIds.map((customerId) => ({ companyId: tx.companyId, groupId, customerId })));
  }
}

/** New billing group: `{ name, customerIds? }`. */
export async function createBillingGroup(
  ctx: ServiceContext,
  input: { name?: unknown; customerIds?: unknown },
): Promise<BillingGroupView> {
  const name = cleanName(input.name);
  return inTransaction(ctx, async (tx) => {
    await assertUniqueName(tx, name);
    const customerIds = await cleanMembers(tx, input.customerIds);
    const [row] = await tx.db.insert(billingGroups).values({ companyId: tx.companyId, name }).returning();
    await replaceMembers(tx, row.id, customerIds);
    await writeAudit(tx, {
      action: 'create',
      entityType: 'billing_group',
      entityId: row.id,
      newValues: { name, customerIds },
    });
    return getBillingGroup(tx, row.id);
  });
}

/** Rename a group and/or replace its customers: `{ name?, customerIds? }`. */
export async function updateBillingGroup(
  ctx: ServiceContext,
  id: string,
  input: { name?: unknown; customerIds?: unknown },
): Promise<BillingGroupView> {
  return inTransaction(ctx, async (tx) => {
    const before = await getBillingGroup(tx, id);
    const patch: { name?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (input.name !== undefined) {
      patch.name = cleanName(input.name);
      await assertUniqueName(tx, patch.name, id);
    }
    const customerIds = input.customerIds !== undefined ? await cleanMembers(tx, input.customerIds) : null;
    await tx.db
      .update(billingGroups)
      .set(patch)
      .where(and(eq(billingGroups.companyId, tx.companyId), eq(billingGroups.id, id)));
    if (customerIds) await replaceMembers(tx, id, customerIds);
    const after = await getBillingGroup(tx, id);
    await writeAudit(tx, {
      action: 'update',
      entityType: 'billing_group',
      entityId: id,
      oldValues: { name: before.name, customerIds: before.customerIds },
      newValues: { name: after.name, customerIds: after.customerIds },
    });
    return after;
  });
}

/** Add customers to a group (already-members are left as they are). */
export async function addBillingGroupMembers(ctx: ServiceContext, id: string, customerIds: unknown) {
  const g = await getBillingGroup(ctx, id);
  const extra = await cleanMembers(ctx, customerIds);
  return updateBillingGroup(ctx, id, { customerIds: [...new Set([...g.customerIds, ...extra])] });
}

/** Delete a group (its customers are untouched). Refused while an Accountant's Copy is out. */
export async function deleteBillingGroup(ctx: ServiceContext, id: string): Promise<{ deleted: true }> {
  await assertListDeleteAllowed(ctx, 'delete', 'billing groups');
  return inTransaction(ctx, async (tx) => {
    const before = await getBillingGroup(tx, id);
    await tx.db.delete(billingGroupMembers).where(and(eq(billingGroupMembers.companyId, tx.companyId), eq(billingGroupMembers.groupId, id)));
    await tx.db.delete(billingGroups).where(and(eq(billingGroups.companyId, tx.companyId), eq(billingGroups.id, id)));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'billing_group',
      entityId: id,
      oldValues: { name: before.name, customerIds: before.customerIds },
    });
    return { deleted: true as const };
  });
}
