/**
 * Lead Center (QB Customers > Lead Center): prospects, their contacts and to-dos, and
 * "Convert to Customer" — which creates a real customer (through createCustomer, so every
 * customer rule applies), moves the lead's to-dos onto the customer and marks the lead converted.
 * Leads never touch the books.
 */
import { and, asc, eq } from 'drizzle-orm';
import { leads, todos } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { assertWrite } from './rbac';
import { createCustomer } from './customers';

export type LeadRow = typeof leads.$inferSelect;
export const LEAD_STATUSES = ['hot', 'warm', 'cold'] as const;

export interface LeadContact {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
}

export interface LeadInput {
  name?: string;
  companyName?: string | null;
  status?: (typeof LEAD_STATUSES)[number];
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  address?: Record<string, string> | null;
  contacts?: LeadContact[] | null;
  notes?: string | null;
  isActive?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(input: LeadInput, creating: boolean): Partial<typeof leads.$inferInsert> {
  if (creating && !input.name?.trim()) throw validation('A lead needs a name.');
  if (input.status !== undefined && !LEAD_STATUSES.includes(input.status)) throw validation('Status must be hot, warm or cold.');
  if (input.email && !EMAIL_RE.test(input.email.trim())) throw validation('That email address does not look right.');
  const out: Partial<typeof leads.$inferInsert> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw validation('A lead needs a name.');
    out.name = input.name.trim().slice(0, 255);
  }
  if (input.companyName !== undefined) out.companyName = input.companyName?.trim() || null;
  if (input.status !== undefined) out.status = input.status;
  if (input.email !== undefined) out.email = input.email?.trim() || null;
  if (input.phone !== undefined) out.phone = input.phone?.trim() || null;
  if (input.website !== undefined) out.website = input.website?.trim() || null;
  if (input.address !== undefined) out.address = input.address ?? null;
  if (input.contacts !== undefined) {
    const contacts = (input.contacts ?? [])
      .filter((c) => c && typeof c.name === 'string' && c.name.trim())
      .slice(0, 50)
      .map((c) => ({
        name: c.name.trim(),
        ...(c.title?.trim() ? { title: c.title.trim() } : {}),
        ...(c.email?.trim() ? { email: c.email.trim() } : {}),
        ...(c.phone?.trim() ? { phone: c.phone.trim() } : {}),
      }));
    out.contacts = contacts;
  }
  if (input.notes !== undefined) out.notes = input.notes?.trim() || null;
  if (input.isActive !== undefined) out.isActive = input.isActive;
  return out;
}

export async function listLeads(ctx: ServiceContext, opts: { includeConverted?: boolean } = {}): Promise<LeadRow[]> {
  const rows = await ctx.db.select().from(leads).where(eq(leads.companyId, ctx.companyId)).orderBy(asc(leads.name));
  return opts.includeConverted ? rows : rows.filter((r) => !r.convertedCustomerId);
}

export async function getLead(ctx: ServiceContext, id: string): Promise<LeadRow> {
  const [row] = await ctx.db.select().from(leads).where(and(eq(leads.id, id), eq(leads.companyId, ctx.companyId)));
  if (!row) throw notFound('Lead');
  return row;
}

export async function createLead(ctx: ServiceContext, input: LeadInput): Promise<LeadRow> {
  assertWrite(ctx); // view-only members change nothing (checked before any write)
  const values = clean(input, true);
  const [row] = await ctx.db
    .insert(leads)
    .values({ companyId: ctx.companyId, name: values.name!, ...values })
    .returning();
  await writeAudit(ctx, { action: 'create', entityType: 'lead', entityId: row.id, newValues: { name: row.name, status: row.status } });
  return row;
}

export async function updateLead(ctx: ServiceContext, id: string, input: LeadInput): Promise<LeadRow> {
  assertWrite(ctx); // view-only members change nothing (checked before any write)
  const before = await getLead(ctx, id);
  const patch = clean(input, false);
  const [row] = await ctx.db
    .update(leads)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.companyId, ctx.companyId)))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'lead',
    entityId: id,
    oldValues: { name: before.name, status: before.status, isActive: before.isActive },
    newValues: { name: row.name, status: row.status, isActive: row.isActive },
  });
  return row;
}

export async function deleteLead(ctx: ServiceContext, id: string): Promise<void> {
  // One transaction (refuses view-only members up front): the lead and its to-dos go together.
  await inTransaction(ctx, async (tx) => {
    const before = await getLead(tx, id);
    if (before.convertedCustomerId) {
      throw validation('This lead became a customer. Make it inactive instead of deleting it.');
    }
    await tx.db.delete(todos).where(and(eq(todos.companyId, tx.companyId), eq(todos.entityType, 'lead'), eq(todos.entityId, id)));
    await tx.db.delete(leads).where(and(eq(leads.id, id), eq(leads.companyId, tx.companyId)));
    await writeAudit(tx, { action: 'delete', entityType: 'lead', entityId: id, oldValues: { name: before.name } });
  });
}

/**
 * Convert a lead to a customer. The customer's display name defaults to the lead's company name
 * (else its name); the first contact's details fill email/phone when the lead has none. Open
 * to-dos follow the new customer.
 */
export async function convertLeadToCustomer(
  ctx: ServiceContext,
  id: string,
  opts: { displayName?: string } = {},
): Promise<{ lead: LeadRow; customerId: string }> {
  return inTransaction(ctx, (tx) => convertInTx(tx, id, opts));
}

async function convertInTx(
  ctx: ServiceContext,
  id: string,
  opts: { displayName?: string },
): Promise<{ lead: LeadRow; customerId: string }> {
  const lead = await getLead(ctx, id);
  if (lead.convertedCustomerId) throw validation('This lead is already a customer.');
  const first = (lead.contacts ?? [])[0] ?? {};
  const customer = await createCustomer(ctx, {
    displayName: (opts.displayName?.trim() || lead.companyName || lead.name).trim(),
    companyName: lead.companyName,
    email: lead.email ?? first.email ?? null,
    phone: lead.phone ?? first.phone ?? null,
    billingAddress: (lead.address as Record<string, string> | null) ?? null,
    notes: [lead.notes, lead.website ? `Website: ${lead.website}` : null].filter(Boolean).join('\n') || null,
  });
  await ctx.db
    .update(todos)
    .set({ entityType: 'customer', entityId: customer.id, updatedAt: new Date() })
    .where(and(eq(todos.companyId, ctx.companyId), eq(todos.entityType, 'lead'), eq(todos.entityId, id)));
  const [row] = await ctx.db
    .update(leads)
    .set({ convertedCustomerId: customer.id, convertedAt: new Date(), isActive: false, updatedAt: new Date() })
    .where(eq(leads.id, id))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'lead',
    entityId: id,
    oldValues: { convertedCustomerId: null },
    newValues: { convertedCustomerId: customer.id },
  });
  return { lead: row, customerId: customer.id };
}
