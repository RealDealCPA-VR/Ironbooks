/**
 * The list records an agent's request names by id (its customer, vendor, accounts, items …), by
 * their names in the books, for the approval card's own line (AgentRequestForPerson.named).
 *
 * Never part of the one-line summary: that line is also the desktop notice, and a record's name can
 * be an outsider's text (a customer or vendor named in an import or a bank feed). The card shows
 * these names apart, marked as names from the books.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { accounts, classes, customers, employees, items, vendors } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import type { OperationInput } from './contract';
import type { Operation } from './operations/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lists a request names records of by id, and the route a person reads each from. */
export const LIST_ROUTES = {
  customers: '/api/customers',
  vendors: '/api/vendors',
  employees: '/api/employees',
  items: '/api/items',
  accounts: '/api/accounts',
  classes: '/api/classes',
} as const;
export type ListKind = keyof typeof LIST_ROUTES;

/** Which list a field of a request names a record of, by the field's name. */
function listOfField(key: string): ListKind | null {
  if (/^(customerId|customer_id|jobId|job_id)$/.test(key)) return 'customers';
  if (/^(vendorId|vendor_id)$/.test(key)) return 'vendors';
  if (/^(employeeId|employee_id)$/.test(key)) return 'employees';
  if (/^(itemId|item_id)$/.test(key)) return 'items';
  if (/^(classId|class_id)$/.test(key)) return 'classes';
  if (/(^a|A)ccount(Id|_id)$/.test(key)) return 'accounts';
  return null;
}

/** Most record ids a line names by name (a request naming more is still one request). */
const MAX_RECORD_NAMES = 200;

/** A list record a request names, by its name in the books, for the approval card. */
export interface NamedRecord {
  kind: ListKind;
  name: string;
}

/**
 * The list records a request names by id, anywhere in its input (a bill's vendorId, an invoice's
 * customerId, every line's accountId and itemId) and as the record a list route's path names
 * (/api/customers/[id] …), by their names in this company's books, for the lists `lists` allows
 * (those its reader may read). In the order the request first names them; an id that names no
 * record is left out. For the approval card's own line, never the one-line summary.
 */
export async function namedRecords(
  db: ServiceContext['db'],
  companyId: string,
  operation: Operation,
  input: OperationInput,
  lists: ReadonlySet<ListKind>,
): Promise<NamedRecord[]> {
  if (!lists.size) return [];
  const wanted = new Map<ListKind, Set<string>>();
  let count = 0;
  const want = (kind: ListKind | null, v: unknown) => {
    if (!kind || !lists.has(kind) || typeof v !== 'string' || !UUID_RE.test(v.trim()) || count >= MAX_RECORD_NAMES) return;
    const id = v.trim().toLowerCase();
    const set = wanted.get(kind) ?? new Set<string>();
    if (!set.has(id)) count += 1;
    set.add(id);
    wanted.set(kind, set);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 16 || count >= MAX_RECORD_NAMES) return;
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === 'string') want(listOfField(k), x);
        else walk(x, depth + 1);
      }
    }
  };
  walk(input?.body, 0);
  walk(input?.query, 0);
  if (operation.kind === 'route') {
    const ofPath = (Object.keys(LIST_ROUTES) as ListKind[]).find((k) => operation.route.startsWith(`${LIST_ROUTES[k]}/[id]`));
    if (ofPath) want(ofPath, input?.params?.id);
  }
  if (!wanted.size) return [];
  const found: Record<string, string> = {};
  const put = (rows: Array<{ id: string; name: string | null }>) => {
    for (const r of rows) if (typeof r.name === 'string' && r.name.trim()) found[r.id.toLowerCase()] = r.name.trim();
  };
  const ids = (k: ListKind) => [...(wanted.get(k) ?? [])];
  try {
    if (wanted.has('customers')) {
      put(await db.select({ id: customers.id, name: customers.displayName }).from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, ids('customers')))));
    }
    if (wanted.has('vendors')) {
      put(await db.select({ id: vendors.id, name: vendors.displayName }).from(vendors).where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids('vendors')))));
    }
    if (wanted.has('items')) {
      put(await db.select({ id: items.id, name: items.name }).from(items).where(and(eq(items.companyId, companyId), inArray(items.id, ids('items')))));
    }
    if (wanted.has('classes')) {
      put(await db.select({ id: classes.id, name: classes.name }).from(classes).where(and(eq(classes.companyId, companyId), inArray(classes.id, ids('classes')))));
    }
    if (wanted.has('employees')) {
      const rows = await db
        .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
        .from(employees)
        .where(and(eq(employees.companyId, companyId), inArray(employees.id, ids('employees'))));
      put(rows.map((r) => ({ id: r.id, name: `${r.first ?? ''} ${r.last ?? ''}`.trim() })));
    }
    if (wanted.has('accounts')) {
      const rows = await db
        .select({ id: accounts.id, number: accounts.code, name: accounts.name })
        .from(accounts)
        .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids('accounts'))));
      put(rows.map((r) => ({ id: r.id, name: r.number ? `${r.number} ${r.name}` : r.name })));
    }
  } catch {
    // Only words: the card then shows no names line.
    return [];
  }
  const out: NamedRecord[] = [];
  const seen = new Set<string>();
  for (const [kind, set] of wanted) {
    for (const id of set) {
      const name = found[id];
      if (!name || seen.has(`${kind}:${name}`)) continue;
      seen.add(`${kind}:${name}`);
      out.push({ kind, name: name.slice(0, 120) });
    }
  }
  return out;
}

