/**
 * B4: Customer Type / Vendor Type / Job Type report filters (QB Customize Report > Filters >
 * Customer Type, Vendor Type, Job Type).
 *
 *  - A type includes its subtypes (the lists are hierarchical, like QB's "Retail:Online").
 *  - Customer Type: a sub-customer (QB's Customer:Job) with no type of its own takes the type of
 *    its nearest parent that has one, as QB fills a new job's type in from its customer.
 *  - Job Type: the jobs of the Jobs list with that type (or a subtype).
 *
 * Every lookup is scoped to the company: a type id of another company matches nothing.
 */
import { eq } from 'drizzle-orm';
import { customerTypes, customers, jobTypes, jobs, vendorTypes, vendors } from '@/lib/db/schema';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';

type TypeKind = 'customer' | 'vendor' | 'job';

/** The type and all its subtypes (any depth), company scoped; empty when the id is not ours. */
async function typeWithSubtypes(ctx: ServiceContext, kind: TypeKind, typeId: string): Promise<Set<string>> {
  const t = (kind === 'customer' ? customerTypes : kind === 'vendor' ? vendorTypes : jobTypes) as typeof customerTypes;
  const rows = await ctx.db.select({ id: t.id, parentId: t.parentId }).from(t).where(eq(t.companyId, ctx.companyId));
  const out = new Set<string>();
  if (!rows.some((r) => r.id === typeId)) return out;
  out.add(typeId);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId && out.has(r.parentId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Ids of the customers (and their jobs / sub-customers) of a customer type. */
export async function customersOfType(ctx: ServiceContext, customerTypeId: string): Promise<Set<string>> {
  const types = await typeWithSubtypes(ctx, 'customer', customerTypeId);
  const out = new Set<string>();
  if (types.size === 0) return out;
  const rows = await ctx.db
    .select({ id: customers.id, parentId: customers.parentId, typeId: customers.customerTypeId })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    // Own type, else the nearest parent's (guarding against a malformed parent loop).
    let cur: (typeof rows)[number] | undefined = r;
    const seen = new Set<string>();
    while (cur && !cur.typeId && cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parentId);
    }
    if (cur?.typeId && types.has(cur.typeId)) out.add(r.id);
  }
  return out;
}

/** Ids of the vendors of a vendor type. */
export async function vendorsOfType(ctx: ServiceContext, vendorTypeId: string): Promise<Set<string>> {
  const types = await typeWithSubtypes(ctx, 'vendor', vendorTypeId);
  if (types.size === 0) return new Set();
  const rows = await ctx.db
    .select({ id: vendors.id, typeId: vendors.vendorTypeId })
    .from(vendors)
    .where(eq(vendors.companyId, ctx.companyId));
  return new Set(rows.filter((r) => r.typeId && types.has(r.typeId)).map((r) => r.id));
}

/** Ids of the jobs (Jobs list) of a job type. */
export async function jobsOfType(ctx: ServiceContext, jobTypeId: string): Promise<Set<string>> {
  const types = await typeWithSubtypes(ctx, 'job', jobTypeId);
  if (types.size === 0) return new Set();
  const rows = await ctx.db.select({ id: jobs.id, typeId: jobs.jobTypeId }).from(jobs).where(eq(jobs.companyId, ctx.companyId));
  return new Set(rows.filter((r) => r.typeId && types.has(r.typeId)).map((r) => r.id));
}

/**
 * The name filter a report's Customer Type / Vendor Type params ask for: null = no type filter,
 * else the set of customer (or vendor) ids to keep.
 */
export async function nameTypeFilter(ctx: ServiceContext, p: ReportParams, side: 'ar' | 'ap'): Promise<Set<string> | null> {
  if (side === 'ar') return p.customerTypeId ? customersOfType(ctx, p.customerTypeId) : null;
  return p.vendorTypeId ? vendorsOfType(ctx, p.vendorTypeId) : null;
}

/** The three type lists for the report filter pickers, as { id, name: "Parent:Child" }, sorted. */
export async function typeListOptions(ctx: ServiceContext): Promise<{
  customerTypes: Array<{ id: string; name: string }>;
  vendorTypes: Array<{ id: string; name: string }>;
  jobTypes: Array<{ id: string; name: string }>;
}> {
  const list = async (kind: TypeKind) => {
    const t = (kind === 'customer' ? customerTypes : kind === 'vendor' ? vendorTypes : jobTypes) as typeof customerTypes;
    const rows = await ctx.db.select({ id: t.id, name: t.name, parentId: t.parentId }).from(t).where(eq(t.companyId, ctx.companyId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const full = (id: string) => {
      const path: string[] = [];
      const seen = new Set<string>();
      for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        seen.add(cur.id);
        path.unshift(cur.name);
      }
      return path.join(':');
    };
    return rows.map((r) => ({ id: r.id, name: full(r.id) })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const [c, v, j] = await Promise.all([list('customer'), list('vendor'), list('job')]);
  return { customerTypes: c, vendorTypes: v, jobTypes: j };
}

/** "Customer Type: Retail" for a report subtitle (the type's full Parent:Child name). */
export async function typeFilterLabel(ctx: ServiceContext, p: ReportParams): Promise<string> {
  if (!p.customerTypeId && !p.vendorTypeId && !p.jobTypeId) return '';
  const opts = await typeListOptions(ctx);
  const name = (list: Array<{ id: string; name: string }>, id: string) => list.find((o) => o.id === id)?.name ?? '(unknown)';
  const parts: string[] = [];
  if (p.customerTypeId) parts.push(`Customer Type: ${name(opts.customerTypes, p.customerTypeId)}`);
  if (p.vendorTypeId) parts.push(`Vendor Type: ${name(opts.vendorTypes, p.vendorTypeId)}`);
  if (p.jobTypeId) parts.push(`Job Type: ${name(opts.jobTypes, p.jobTypeId)}`);
  return parts.join(' · ');
}
