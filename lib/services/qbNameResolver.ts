/**
 * QuickBooks "Name" column → our customer / vendor / employee / other name.
 *
 * Used by the migration paths (General Ledger import, IIF transaction import) so imported
 * history carries the QB Name on each journal line (journal_entry_lines.entity_type / entity_id).
 * That is what makes Sales by Customer, Expenses by Vendor, per-name QuickReports and the
 * A/R / A/P "General Journal" detail work for migrated periods.
 *
 * Matching rules (case-insensitive, whitespace-trimmed):
 *  - customers by display name AND by full "Customer:Job" path (sub-customers);
 *  - vendors and other names by display name;
 *  - employees by "First Last", "Last, First" and "Last First".
 *  - An Accounts Receivable line only ever resolves to a customer, an Accounts Payable line
 *    only to a vendor (QB's own rule). Otherwise the caller's preferred role wins, then a
 *    name that matches exactly one list.
 * A name that matches nothing (or is ambiguous) resolves to null — the line stays unnamed.
 */
import { eq } from 'drizzle-orm';
import { customers, employees, otherNames, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import type { JournalEntityType } from './posting';

export type QbNameRole = 'customer' | 'vendor' | 'employee' | 'other';

export interface ResolvedName {
  entityType: JournalEntityType;
  entityId: string;
}

export interface QbNameResolver {
  resolve(
    name: string | null | undefined,
    opts?: { side?: 'ar' | 'ap' | null; prefer?: QbNameRole | null },
  ): ResolvedName | null;
  /** Register a record created during the import so later lines resolve to it. */
  add(role: QbNameRole, name: string, id: string): void;
}

const norm = (s: string) => s.split(':').map((p) => p.trim().replace(/\s+/g, ' ')).join(':').toLowerCase();

function employeeKeys(first: string, last: string): string[] {
  const f = first.trim();
  const l = last.trim();
  return [`${f} ${l}`, `${l}, ${f}`, `${l} ${f}`, `${l},${f}`].map(norm);
}

export async function loadQbNameResolver(ctx: ServiceContext): Promise<QbNameResolver> {
  const maps: Record<QbNameRole, Map<string, string | null>> = {
    customer: new Map(),
    vendor: new Map(),
    employee: new Map(),
    other: new Map(),
  };
  /** null marks an ambiguous key (two records share it) — never resolved. */
  const put = (role: QbNameRole, key: string, id: string) => {
    const k = norm(key);
    if (!k) return;
    const cur = maps[role].get(k);
    if (cur === undefined) maps[role].set(k, id);
    else if (cur !== id) maps[role].set(k, null);
  };

  const custRows = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName, parentId: customers.parentId })
    .from(customers)
    .where(eq(customers.companyId, ctx.companyId));
  const custById = new Map(custRows.map((c) => [c.id, c]));
  const custPath = (id: string, seen = new Set<string>()): string => {
    const c = custById.get(id);
    if (!c) return '';
    if (!c.parentId || c.displayName.includes(':') || seen.has(id)) return c.displayName;
    seen.add(id);
    const p = custPath(c.parentId, seen);
    return p ? `${p}:${c.displayName}` : c.displayName;
  };
  for (const c of custRows) {
    put('customer', custPath(c.id), c.id);
    if (!c.parentId) put('customer', c.displayName, c.id);
  }

  const vendRows = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName })
    .from(vendors)
    .where(eq(vendors.companyId, ctx.companyId));
  for (const v of vendRows) put('vendor', v.name, v.id);

  const empRows = await ctx.db
    .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
    .from(employees)
    .where(eq(employees.companyId, ctx.companyId));
  for (const e of empRows) for (const k of employeeKeys(e.first, e.last)) put('employee', k, e.id);

  const otherRows = await ctx.db
    .select({ id: otherNames.id, name: otherNames.name })
    .from(otherNames)
    .where(eq(otherNames.companyId, ctx.companyId));
  for (const o of otherRows) put('other', o.name, o.id);

  const lookup = (role: QbNameRole, name: string): string | null => maps[role].get(norm(name)) ?? null;

  return {
    add(role, name, id) {
      if (role === 'employee') {
        const raw = name.trim();
        let first: string;
        let last: string;
        if (raw.includes(',')) {
          const [l, f] = raw.split(',').map((s) => s.trim());
          first = f || l;
          last = l;
        } else {
          const parts = raw.split(/\s+/);
          first = parts[0];
          last = parts.slice(1).join(' ') || parts[0];
        }
        for (const k of employeeKeys(first, last)) put('employee', k, id);
        put('employee', raw, id);
      } else {
        put(role, name, id);
      }
    },
    resolve(name, opts = {}) {
      const n = (name ?? '').trim();
      if (!n) return null;
      if (opts.side === 'ar') {
        const id = lookup('customer', n);
        return id ? { entityType: 'customer', entityId: id } : null;
      }
      if (opts.side === 'ap') {
        const id = lookup('vendor', n);
        return id ? { entityType: 'vendor', entityId: id } : null;
      }
      if (opts.prefer) {
        const id = lookup(opts.prefer, n);
        if (id) return { entityType: opts.prefer, entityId: id };
      }
      const hits: ResolvedName[] = [];
      for (const role of ['customer', 'vendor', 'employee', 'other'] as const) {
        const id = lookup(role, n);
        if (id) hits.push({ entityType: role, entityId: id });
      }
      return hits.length === 1 ? hits[0] : null;
    },
  };
}

/** A/R or A/P side of an account (null for every other account). */
export function controlSideOfAccount(acct: { type: string; subtype: string | null } | null | undefined): 'ar' | 'ap' | null {
  if (!acct) return null;
  if (acct.type === 'asset' && acct.subtype === 'accounts_receivable') return 'ar';
  if (acct.type === 'liability' && acct.subtype === 'accounts_payable') return 'ap';
  return null;
}
