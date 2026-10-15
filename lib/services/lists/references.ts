/**
 * Reference discovery for list records — "is this record used anywhere?" and "move every use of
 * record A onto record B" — driven by the live database catalog instead of a hand-maintained
 * table list, so tables added later (by any team) are covered automatically.
 *
 *  - `findReferences` scans EVERY uuid column in the company file (foreign key or not, e.g.
 *    polymorphic `source_id` / `entity_id` columns), every `*_ref` text column ("item:<id>" style
 *    source links) and every jsonb column (recurring templates, memorized reports, pricing
 *    provenance...) for the given ids. Audit history is excluded: deleting a record never
 *    rewrites its audit trail. Used by Clean Up Company Data and by list "delete" (delete when
 *    unused, otherwise deactivate).
 *  - `repointForeignKeys` re-points every FOREIGN KEY column that references a table from one id
 *    to another (merge). Each id is a UUID primary key already verified to belong to the
 *    caller's company, so matching on the id alone can only touch that company's rows (same
 *    tenancy argument as mergeAccounts in lib/services/merge.ts).
 *
 * Identifiers interpolated into SQL come only from the PostgreSQL catalog and are quoted.
 */
import { sql } from 'drizzle-orm';
import type { ServiceContext } from '../_base';

type Db = ServiceContext['db'];

export interface ColumnRef {
  table: string;
  column: string;
}

export interface ReferenceHit extends ColumnRef {
  count: number;
}

const qi = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function rows<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = await db.execute(query);
  return ((res as unknown as { rows?: T[] }).rows ?? []) as T[];
}

/** Tables whose contents never count as a "use" of a record. */
const IGNORED_TABLES = new Set(['audit_logs', 'list_seeds', 'transaction_log_anchor', 'user_sessions', 'single_user_mode', 'undo_actions']);

interface CatalogColumns {
  uuidCols: ColumnRef[];
  refCols: ColumnRef[];
  jsonCols: ColumnRef[];
  /** Legacy free-text `terms` columns (customers, vendors, invoices, bills...) in company-scoped tables. */
  termsTextCols: ColumnRef[];
}

async function catalogColumns(db: Db): Promise<CatalogColumns> {
  const cols = await rows<{ table_name: string; column_name: string; data_type: string }>(
    db,
    sql`SELECT c.table_name, c.column_name, c.data_type
          FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = current_schema()
           AND t.table_type = 'BASE TABLE'
           AND c.table_name NOT LIKE '\\_\\_%'
         ORDER BY c.table_name, c.ordinal_position`,
  );
  const out: CatalogColumns = { uuidCols: [], refCols: [], jsonCols: [], termsTextCols: [] };
  const companyScoped = new Set(cols.filter((c) => c.column_name === 'company_id').map((c) => c.table_name));
  for (const c of cols) {
    if (IGNORED_TABLES.has(c.table_name)) continue;
    const ref = { table: c.table_name, column: c.column_name };
    if (c.data_type === 'uuid') {
      if (c.column_name === 'company_id') continue; // only ever references companies
      out.uuidCols.push(ref);
    } else if ((c.data_type === 'character varying' || c.data_type === 'text') && /_ref$/.test(c.column_name)) {
      out.refCols.push(ref);
    } else if (
      (c.data_type === 'character varying' || c.data_type === 'text') &&
      c.column_name === 'terms' &&
      companyScoped.has(c.table_name)
    ) {
      out.termsTextCols.push(ref);
    } else if (c.data_type === 'jsonb' || c.data_type === 'json') {
      out.jsonCols.push(ref);
    }
  }
  return out;
}

/**
 * For each id, where (if anywhere) it is referenced. Ids that are not referenced map to [].
 * `ownTable` is the table the ids live in — its own `id` column is skipped (self-match).
 */
export async function findReferences(
  ctx: Pick<ServiceContext, 'db'>,
  ownTable: string,
  ids: string[],
): Promise<Map<string, ReferenceHit[]>> {
  ids.forEach(assertUuid);
  const result = new Map<string, ReferenceHit[]>(ids.map((id) => [id.toLowerCase(), []]));
  ids = ids.map((id) => id.toLowerCase());
  if (ids.length === 0) return result;
  const cat = await catalogColumns(ctx.db);
  const idArray = `{${ids.join(',')}}`;
  const add = (id: string, hit: ReferenceHit) => result.get(id)?.push(hit);

  for (const col of cat.uuidCols) {
    if (col.table === ownTable && col.column === 'id') continue;
    const found = await rows<{ id: string; n: string | number }>(
      ctx.db,
      sql.raw(
        `SELECT ${qi(col.column)}::text AS id, count(*) AS n FROM ${qi(col.table)} ` +
          `WHERE ${qi(col.column)} = ANY('${idArray}'::uuid[]) GROUP BY 1`,
      ),
    );
    for (const f of found) add(f.id, { ...col, count: Number(f.n) });
  }
  // Text "source link" columns and JSON documents: substring match on the id.
  for (const col of [...cat.refCols, ...cat.jsonCols]) {
    const found = await rows<{ id: string; n: string | number }>(
      ctx.db,
      sql.raw(
        `SELECT u.id AS id, count(*) AS n FROM ${qi(col.table)} t, ` +
          `unnest('{${ids.join(',')}}'::text[]) AS u(id) ` +
          `WHERE t.${qi(col.column)} IS NOT NULL AND t.${qi(col.column)}::text LIKE '%' || u.id || '%' GROUP BY 1`,
      ),
    );
    for (const f of found) add(f.id, { ...col, count: Number(f.n) });
  }
  // Terms entries are also used through the legacy text code/name kept in `terms` varchar columns
  // (a customer created without a terms id stores 'net_30'; documents copy the text). A match in
  // the same company counts as a use, so such an entry is deactivated, never deleted.
  if (ownTable === 'payment_terms' && cat.termsTextCols.length > 0) {
    const terms = await rows<{
      id: string; company_id: string; code: string | null; name: string;
      kind: string; net_days: number | null; discount_percent: string | null;
    }>(
      ctx.db,
      sql.raw(
        `SELECT id::text AS id, company_id::text AS company_id, code, name, kind, net_days, discount_percent ` +
          `FROM payment_terms WHERE id = ANY('${idArray}'::uuid[])`,
      ),
    );
    for (const t of terms) {
      const labels = [t.code, t.name].filter((v): v is string => !!v).map((v) => v.toLowerCase());
      // resolveTermsRef maps a never-listed legacy 'net_N' onto a plain standard "Net N" entry.
      if (t.kind === 'standard' && t.net_days != null && t.discount_percent == null) labels.push(`net_${t.net_days}`);
      if (labels.length === 0) continue;
      for (const col of cat.termsTextCols) {
        const found = await rows<{ n: string | number }>(
          ctx.db,
          sql`SELECT count(*) AS n FROM ${sql.raw(qi(col.table))}
               WHERE company_id = ${t.company_id}::uuid
                 AND lower(${sql.raw(qi(col.column))}) IN (${sql.join(labels.map((l) => sql`${l}`), sql`, `)})`,
        );
        const n = Number(found[0]?.n ?? 0);
        if (n > 0) add(t.id.toLowerCase(), { ...col, count: n });
      }
    }
  }
  return result;
}

/** True when the record is referenced anywhere (see findReferences). */
export async function isReferenced(
  ctx: Pick<ServiceContext, 'db'>,
  ownTable: string,
  id: string,
): Promise<boolean> {
  const hits = await findReferences(ctx, ownTable, [id]);
  return (hits.get(id.toLowerCase()) ?? []).length > 0;
}

/** Single-column FOREIGN KEY columns that reference `targetTable`. */
export async function foreignKeyColumns(db: Db, targetTable: string): Promise<ColumnRef[]> {
  const found = await rows<{ table_name: string; column_name: string }>(
    db,
    sql`SELECT src.relname AS table_name, att.attname AS column_name
          FROM pg_constraint con
          JOIN pg_class src ON src.oid = con.conrelid
          JOIN pg_class ref ON ref.oid = con.confrelid
          JOIN pg_namespace ns ON ns.oid = ref.relnamespace
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
         WHERE con.contype = 'f'
           AND array_length(con.conkey, 1) = 1
           AND ref.relname = ${targetTable}
           AND ns.nspname = current_schema()
         ORDER BY 1, 2`,
  );
  return found.map((r) => ({ table: r.table_name, column: r.column_name }));
}

/**
 * Re-point every foreign key referencing `targetTable` from `fromId` to `toId`. Columns listed in
 * `skip` ("table.column") are left for the caller to handle (hierarchies, unique conflicts).
 * Returns rows changed per "table.column". Must run inside the caller's transaction.
 */
export async function repointForeignKeys(
  tx: Pick<ServiceContext, 'db'>,
  targetTable: string,
  fromId: string,
  toId: string,
  opts: { skip?: string[] } = {},
): Promise<Record<string, number>> {
  assertUuid(fromId);
  assertUuid(toId);
  const skip = new Set(opts.skip ?? []);
  const counts: Record<string, number> = {};
  for (const col of await foreignKeyColumns(tx.db, targetTable)) {
    const key = `${col.table}.${col.column}`;
    if (skip.has(key)) continue;
    const changed = await rows<{ n: string | number }>(
      tx.db,
      sql.raw(
        `WITH u AS (UPDATE ${qi(col.table)} SET ${qi(col.column)} = '${toId}'::uuid ` +
          `WHERE ${qi(col.column)} = '${fromId}'::uuid RETURNING 1) SELECT count(*) AS n FROM u`,
      ),
    );
    const n = Number(changed[0]?.n ?? 0);
    if (n > 0) counts[key] = n;
  }
  return counts;
}

/** Validate that a string is a canonical uuid before it is ever placed in raw SQL. */
export function assertUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Not a uuid: ${id}`);
  }
}
