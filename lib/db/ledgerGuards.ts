/**
 * Ledger guards on EVERY company-file open (and after every restore).
 *
 * The ledger invariants live in the database as `bka_*` triggers and functions
 * (drizzle/0017_team_ledger.sql, drizzle/0025_wave2_foundation.sql, and any later migration that
 * adds a `bka_*` guard). The migrator only runs a migration once, so a company file whose guards
 * were disabled, dropped or replaced offline (PGlite runs as superuser, so raw SQL can do that)
 * would otherwise stay unguarded forever — and could be imported through a full .bka restore.
 *
 * `ensureLedgerGuards` re-runs every guard statement from the migration files (functions are
 * CREATE OR REPLACE'd, triggers dropped and recreated, then ENABLE ALWAYS) in one transaction, so
 * after it returns the guards are exactly the ones this version of the app ships, whatever the
 * file contained. It also switches disabled foreign-key triggers back on and re-adds every
 * foreign key the migrations declare that was dropped, made NOT VALID or given other delete
 * rules offline (journal lines to their entry and account included). It is idempotent and runs
 * on every open (lib/db/index.ts).
 *
 * `checkLedgerHealth` is a company-agnostic SQL check of the books themselves: every posted
 * entry balanced and well-formed, no line on another company's account or a non-posting
 * account, every cached account balance equal to its ledger balance, every guard present and
 * enabled. The open path refuses a file with a damaged ledger (QuickBooks likewise refuses to
 * open a damaged file); restore refuses any problem at all and rolls back.
 *
 * Dependency-free apart from the database driver, so lib/db/index.ts can use it without pulling
 * in the service layer.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';

/** A raw PGlite client (or transaction) — only query/exec are needed. */
type Raw = Pick<PGlite, 'query' | 'exec'>;

const GUARD_STATEMENT = [
  /^CREATE\s+OR\s+REPLACE\s+FUNCTION\s+bka_\w+/i,
  /^DROP\s+TRIGGER\s+IF\s+EXISTS\s+bka_\w+/i,
  /^CREATE\s+(CONSTRAINT\s+)?TRIGGER\s+bka_\w+/i,
  /^ALTER\s+TABLE\s+\S+\s+ENABLE\s+ALWAYS\s+TRIGGER\s+bka_\w+/i,
];

export interface LedgerGuardPlan {
  /** Guard DDL in migration order (later migrations' redefinitions win). */
  statements: string[];
  /** Every bka_* trigger name the migrations create. */
  triggers: string[];
  /** Every foreign key the migrations declare (deduplicated by table/columns/target). */
  foreignKeys: ForeignKeySpec[];
}

/** A foreign key declared by the migrations. */
export interface ForeignKeySpec {
  /** Constraint name the migration gives it (null = the database picks one). */
  name: string | null;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** pg_constraint.confdeltype / confupdtype codes: a no action, r restrict, c cascade, n set null, d set default. */
  onDelete: string;
  onUpdate: string;
}

const planCache = new Map<string, LedgerGuardPlan>();

/** Drop leading blank / comment lines (comments inside function bodies are kept). */
function stripLeadingComments(chunk: string): string {
  const lines = chunk.split(/\r?\n/);
  while (lines.length && (lines[0].trim() === '' || lines[0].trim().startsWith('--'))) lines.shift();
  return lines.join('\n').trim();
}

/** Migration files in journal order (falls back to sorted file names). */
function migrationFiles(folder: string): string[] {
  const journal = path.join(folder, 'meta', '_journal.json');
  try {
    const entries = (JSON.parse(fs.readFileSync(journal, 'utf8')) as { entries: Array<{ idx: number; tag: string }> })
      .entries
      .slice()
      .sort((a, b) => a.idx - b.idx);
    return entries.map((e) => path.join(folder, `${e.tag}.sql`)).filter((f) => fs.existsSync(f));
  } catch {
    return fs
      .readdirSync(folder)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(folder, f));
  }
}

/** The guard statements shipped in `migrationsFolder` (parsed once per folder). */
export function ledgerGuardPlan(migrationsFolder: string): LedgerGuardPlan {
  const key = path.resolve(migrationsFolder);
  const cached = planCache.get(key);
  if (cached) return cached;
  if (!fs.existsSync(key)) return { statements: [], triggers: [], foreignKeys: [] };
  const statements: string[] = [];
  const triggers = new Set<string>();
  const foreignKeys = new Map<string, ForeignKeySpec>();
  for (const file of migrationFiles(key)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const fk of parseForeignKeys(text)) {
      const k = fkKey(fk);
      if (!foreignKeys.has(k)) foreignKeys.set(k, fk);
    }
    for (const raw of text.split('--> statement-breakpoint')) {
      const stmt = stripLeadingComments(raw);
      if (!stmt || !GUARD_STATEMENT.some((re) => re.test(stmt))) continue;
      statements.push(stmt);
      const created = /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(bka_\w+)/i.exec(stmt);
      if (created) triggers.add(created[1]);
    }
  }
  const plan = {
    statements,
    triggers: [...triggers].sort(),
    foreignKeys: [...foreignKeys.values()].sort((a, b) => fkKey(a).localeCompare(fkKey(b))),
  };
  planCache.set(key, plan);
  return plan;
}

async function rows<T>(db: Raw, text: string): Promise<T[]> {
  const res = await db.query<T>(text);
  return res.rows;
}

/**
 * Re-install every ledger guard from the migration files, force every bka_* trigger to
 * ENABLE ALWAYS, and switch every other disabled trigger (including the database's internal
 * foreign-key triggers) back on. Runs in one transaction: either every guard is (re)installed or nothing changes
 * and the error propagates (the caller must then refuse the file).
 */
export async function ensureLedgerGuards(client: PGlite, migrationsFolder: string): Promise<void> {
  const plan = ledgerGuardPlan(migrationsFolder);
  if (!plan.statements.length && !plan.foreignKeys.length) return;
  await client.transaction(async (tx) => {
    for (const stmt of plan.statements) await tx.exec(stmt);
    // Belt and braces: a guard trigger a migration forgot to ENABLE ALWAYS (or one left in
    // origin/replica/disabled mode) is switched to ALWAYS too.
    const off = await rows<{ tbl: string; tgname: string }>(
      tx,
      `SELECT c.relname AS tbl, t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE 'bka\\_%' AND t.tgenabled <> 'A'`,
    );
    for (const r of off) {
      await tx.exec(`ALTER TABLE ${qi(r.tbl)} ENABLE ALWAYS TRIGGER ${qi(r.tgname)}`);
    }
    // `ALTER TABLE ... DISABLE TRIGGER ALL` (the usual offline tampering) also switches off the
    // database's own foreign-key triggers (RI_ConstraintTrigger_*). With those off, a journal line
    // can point at an entry or account that does not exist. Switch every disabled trigger back on
    // (internal ones in disabled or replica-only mode too; PGlite runs as superuser, which
    // enabling internal triggers requires).
    const disabled = await rows<{ nsp: string; tbl: string; tgname: string }>(tx, DISABLED_TRIGGERS_SQL);
    for (const r of disabled) {
      await tx.exec(`ALTER TABLE ${qi(r.nsp)}.${qi(r.tbl)} ENABLE TRIGGER ${qi(r.tgname)}`);
    }
    // A foreign key DROPPED offline leaves no trigger to switch back on: re-add every key the
    // migrations declare (journal lines to their entry and account included). Keys that cannot
    // be re-added because orphan rows exist stay missing and make checkLedgerHealth refuse the file.
    await restoreForeignKeys(tx, migrationsFolder);
    // Triggers added offline to the ledger tables (anything the migrations don't ship) could
    // rewrite postings behind the guards' back: remove them.
    for (const t of await extraLedgerTriggers(<T,>(q: string) => rows<T>(tx, q), migrationsFolder)) {
      console.error(`[db] removing unexpected trigger ${t.tgname} on ${t.tbl}`);
      await tx.exec(`DROP TRIGGER IF EXISTS ${qi(t.tgname)} ON ${qi(t.tbl)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Foreign keys declared by the migrations
// ---------------------------------------------------------------------------

/** Structural identity of a foreign key (names are ignored: inline REFERENCES get database-chosen names). */
function fkKey(fk: Pick<ForeignKeySpec, 'table' | 'columns' | 'refTable' | 'refColumns'>): string {
  return `${fk.table}(${fk.columns.join(',')})->${fk.refTable}(${fk.refColumns.join(',')})`;
}

const ACTION_CODE: Record<string, string> = {
  'no action': 'a',
  restrict: 'r',
  cascade: 'c',
  'set null': 'n',
  'set default': 'd',
};

const ACTION_SQL: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/** `"public"."x"` / `"x"` / `x` → `x`. */
function ident(raw: string): string {
  const parts = raw.trim().split('.');
  return parts[parts.length - 1].trim().replace(/^"|"$/g, '');
}

function identList(raw: string): string[] {
  return raw.split(',').map(ident).filter(Boolean);
}

const IDENT = String.raw`(?:"[^"]+"|\w+)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;
const ACTION_RE = String.raw`(?:NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT)`;
const REFS = String.raw`REFERENCES\s+(${QUALIFIED})\s*\(([^)]*)\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+${ACTION_RE})*)`;

function actions(tail: string | undefined): { onDelete: string; onUpdate: string } {
  const del = new RegExp(String.raw`ON\s+DELETE\s+(${ACTION_RE})`, 'i').exec(tail ?? '');
  const upd = new RegExp(String.raw`ON\s+UPDATE\s+(${ACTION_RE})`, 'i').exec(tail ?? '');
  const code = (m: RegExpExecArray | null) => (m ? ACTION_CODE[m[1].toLowerCase().replace(/\s+/g, ' ')] : 'a');
  return { onDelete: code(del), onUpdate: code(upd) };
}

/** Split a CREATE TABLE body at top-level commas. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Every foreign key a migration file declares, in any of the forms the migrations use:
 * table-level `[CONSTRAINT n] FOREIGN KEY (...) REFERENCES ...` inside CREATE TABLE, an inline
 * column `REFERENCES t(c)`, `ALTER TABLE t ADD [CONSTRAINT n] FOREIGN KEY ...` (also inside DO
 * blocks), and `ALTER TABLE t ADD COLUMN c ... REFERENCES t(c)`. lib/db/ledgerGuards.test.ts
 * checks the result equals the keys a freshly migrated database actually has.
 */
export function parseForeignKeys(sqlText: string): ForeignKeySpec[] {
  const text = sqlText.replace(/--[^\n]*/g, ' ');
  const found: ForeignKeySpec[] = [];
  let m: RegExpExecArray | null;

  // CREATE TABLE bodies.
  const create = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})\s*\(`, 'gi');
  const tableLevel = new RegExp(String.raw`^(?:CONSTRAINT\s+(${IDENT})\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*${REFS}`, 'i');
  const inline = new RegExp(String.raw`^(${IDENT})\s[\s\S]*?${REFS}`, 'i');
  while ((m = create.exec(text))) {
    const table = ident(m[1]);
    let depth = 1;
    let quoted = false;
    let i = create.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === '(') depth++;
      else if (!quoted && ch === ')') depth--;
    }
    for (const raw of splitTopLevel(text.slice(create.lastIndex, i - 1))) {
      const item = raw.trim();
      const t = tableLevel.exec(item);
      if (t) {
        found.push({
          name: t[1] ? ident(t[1]) : null,
          table,
          columns: identList(t[2]),
          refTable: ident(t[3]),
          refColumns: identList(t[4]),
          ...actions(t[5]),
        });
        continue;
      }
      if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|EXCLUDE)\b/i.test(item)) continue;
      const c = inline.exec(item);
      if (c) {
        found.push({
          name: null,
          table,
          columns: [ident(c[1])],
          refTable: ident(c[2]),
          refColumns: identList(c[3]),
          ...actions(c[4]),
        });
      }
    }
  }

  // ALTER TABLE t ADD [CONSTRAINT n] FOREIGN KEY ...
  const addFk = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED})\s+ADD\s+(?:CONSTRAINT\s+(${IDENT})\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*${REFS}`,
    'gi',
  );
  while ((m = addFk.exec(text))) {
    found.push({
      name: m[2] ? ident(m[2]) : null,
      table: ident(m[1]),
      columns: identList(m[3]),
      refTable: ident(m[4]),
      refColumns: identList(m[5]),
      ...actions(m[6]),
    });
  }

  // ALTER TABLE t ADD COLUMN [IF NOT EXISTS] c type ... REFERENCES ...
  const addCol = new RegExp(
    String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(${QUALIFIED})\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s[^;]*?${REFS}`,
    'gi',
  );
  while ((m = addCol.exec(text))) {
    found.push({
      name: null,
      table: ident(m[1]),
      columns: [ident(m[2])],
      refTable: ident(m[3]),
      refColumns: identList(m[4]),
      ...actions(m[5]),
    });
  }
  return found;
}

interface ActualForeignKey {
  conname: string;
  tbl: string;
  cols: string;
  ref: string;
  refcols: string;
  convalidated: boolean;
  confdeltype: string;
  confupdtype: string;
}

const ACTUAL_FKS_SQL = `
  SELECT c.conname, tc.relname AS tbl, rc.relname AS ref, c.convalidated,
         c.confdeltype::text AS confdeltype, c.confupdtype::text AS confupdtype,
         (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord)
            FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
         (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord)
            FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS refcols
    FROM pg_constraint c
    JOIN pg_class tc ON tc.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace
    JOIN pg_class rc ON rc.oid = c.confrelid
   WHERE c.contype = 'f' AND n.nspname = 'public'`;

export interface ForeignKeyGap {
  spec: ForeignKeySpec;
  /**
   * missing: no such key; unvalidated: present but NOT VALID; altered: present with other
   * ON DELETE/UPDATE rules; extra: the declared key is there, but an undeclared look-alike on the
   * same columns and target with other rules (e.g. an added ON DELETE CASCADE) sits next to it.
   */
  state: 'missing' | 'unvalidated' | 'altered' | 'extra';
  /** Existing constraints on the same columns and target. */
  existing: ActualForeignKey[];
}

/** Run a raw query and return its rows (lets raw PGlite and drizzle callers share the check). */
export type RowQuery = <T>(text: string) => Promise<T[]>;

/**
 * Foreign keys the migrations declare that this database does not enforce exactly as declared
 * (missing, NOT VALID, or with other ON DELETE / ON UPDATE rules). Only keys whose table and
 * target both exist are considered.
 */
export async function foreignKeyGaps(query: RowQuery, migrationsFolder: string): Promise<ForeignKeyGap[]> {
  const expected = ledgerGuardPlan(migrationsFolder).foreignKeys;
  if (!expected.length) return [];
  const actual = await query<ActualForeignKey>(ACTUAL_FKS_SQL);
  const tables = new Set(
    (
      await query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
      )
    ).map((r) => r.relname),
  );
  const byKey = new Map<string, ActualForeignKey[]>();
  for (const a of actual) {
    const k = fkKey({ table: a.tbl, columns: a.cols.split(','), refTable: a.ref, refColumns: a.refcols.split(',') });
    byKey.set(k, [...(byKey.get(k) ?? []), a]);
  }
  const gaps: ForeignKeyGap[] = [];
  for (const spec of expected) {
    if (!tables.has(spec.table) || !tables.has(spec.refTable)) continue;
    const same = byKey.get(fkKey(spec)) ?? [];
    const exact = same.filter((a) => a.confdeltype === spec.onDelete && a.confupdtype === spec.onUpdate);
    if (exact.some((a) => a.convalidated)) {
      // The declared key is enforced, but a second key on the same link with other rules would
      // still fire (an extra ON DELETE CASCADE deletes rows the declared key protects).
      if (exact.length < same.length) gaps.push({ spec, state: 'extra', existing: same.filter((a) => !exact.includes(a)) });
      continue;
    }
    gaps.push({ spec, state: exact.length ? 'unvalidated' : same.length ? 'altered' : 'missing', existing: same });
  }
  return gaps;
}

/** Plain-language summary of foreign-key gaps (null when there are none). */
export function describeForeignKeyGaps(gaps: ForeignKeyGap[]): string | null {
  if (!gaps.length) return null;
  const label = (g: ForeignKeyGap) =>
    `${g.spec.table}.${g.spec.columns.join('+')} to ${g.spec.refTable}${g.state === 'extra' ? ' (an extra link with other delete rules was added)' : ''}`;
  const ledgerFirst = [
    ...gaps.filter((g) => g.spec.table === 'journal_entry_lines'),
    ...gaps.filter((g) => g.spec.table !== 'journal_entry_lines'),
  ];
  return `${gaps.length} link${gaps.length === 1 ? '' : 's'} between records ${
    gaps.length === 1 ? 'is' : 'are'
  } not enforced, so a record could point at one that does not exist (${sample(ledgerFirst.map(label))}).`;
}

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Put back every foreign key the migrations declare that is missing, NOT VALID, or carries other
 * ON DELETE / ON UPDATE rules. Each fix runs in its own savepoint: a key that cannot be re-added
 * (orphan rows exist) is left missing, and checkLedgerHealth then reports it, plus the orphans,
 * so the file is refused instead of opened half-guarded.
 */
async function restoreForeignKeys(tx: Raw, migrationsFolder: string): Promise<void> {
  const gaps = await foreignKeyGaps(<T,>(t: string) => rows<T>(tx, t), migrationsFolder);
  let n = 0;
  for (const gap of gaps) {
    const { spec } = gap;
    const sp = `bka_fk_${++n}`;
    await tx.exec(`SAVEPOINT ${sp}`);
    try {
      if (gap.state === 'extra') {
        // Keep the declared key; drop only the undeclared look-alikes with other rules.
        for (const e of gap.existing) await tx.exec(`ALTER TABLE ${qi(spec.table)} DROP CONSTRAINT ${qi(e.conname)}`);
      } else if (gap.state === 'unvalidated') {
        for (const e of gap.existing) {
          if (e.convalidated || e.confdeltype !== spec.onDelete || e.confupdtype !== spec.onUpdate) continue;
          await tx.exec(`ALTER TABLE ${qi(spec.table)} VALIDATE CONSTRAINT ${qi(e.conname)}`);
        }
      } else {
        // Drop look-alikes with other rules (e.g. ON DELETE CASCADE slipped in), then add the declared key.
        for (const e of gap.existing) await tx.exec(`ALTER TABLE ${qi(spec.table)} DROP CONSTRAINT ${qi(e.conname)}`);
        let name = '';
        if (spec.name) {
          const [taken] = await rows<{ n: number }>(
            tx,
            `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ${lit(spec.name)}`,
          );
          if (!Number(taken?.n ?? 0)) name = `CONSTRAINT ${qi(spec.name)} `;
        }
        await tx.exec(
          `ALTER TABLE ${qi(spec.table)} ADD ${name}FOREIGN KEY (${spec.columns.map(qi).join(', ')}) ` +
            `REFERENCES ${qi(spec.refTable)} (${spec.refColumns.map(qi).join(', ')}) ` +
            `ON DELETE ${ACTION_SQL[spec.onDelete]} ON UPDATE ${ACTION_SQL[spec.onUpdate]}`,
        );
      }
      await tx.exec(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      await tx.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      await tx.exec(`RELEASE SAVEPOINT ${sp}`);
      console.error(`[db] could not restore the record link ${fkKey(spec)}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * The ledger tables: the only triggers allowed on them are the bka_* guards the migrations ship.
 * (Other tables carry app triggers such as docnum_*; those aren't ledger-critical.)
 */
export const LEDGER_TABLES = ['journal_entries', 'journal_entry_lines', 'accounts', 'journal_item_applications'] as const;

/** Non-internal triggers on the ledger tables that the migrations don't create (added offline). */
export async function extraLedgerTriggers(
  query: RowQuery,
  migrationsFolder: string,
): Promise<Array<{ tbl: string; tgname: string }>> {
  const known = new Set(ledgerGuardPlan(migrationsFolder).triggers);
  const found = await query<{ tbl: string; tgname: string }>(
    `SELECT c.relname AS tbl, t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
        AND c.relname IN (${LEDGER_TABLES.map((x) => `'${x}'`).join(', ')})
      ORDER BY c.relname, t.tgname`,
  );
  return found.filter((t) => !known.has(t.tgname));
}

function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Triggers on this file's own tables that are switched off: any trigger in disabled mode ('D'),
 * plus internal (foreign-key) triggers in replica-only mode ('R'), which never fire normally.
 */
const DISABLED_TRIGGERS_SQL = `
  SELECT n.nspname AS nsp, c.relname AS tbl, t.tgname, t.tgisinternal
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\\_%'
     AND (t.tgenabled = 'D' OR (t.tgisinternal AND t.tgenabled = 'R'))
   ORDER BY n.nspname, c.relname, t.tgname`;

export type LedgerProblemKind =
  | 'guards'
  | 'unbalanced_entries'
  | 'cross_company'
  | 'orphan_lines'
  | 'non_posting'
  | 'cached_balances';

export interface LedgerProblem {
  kind: LedgerProblemKind;
  /** Plain-language description. */
  detail: string;
}

export interface LedgerHealth {
  ok: boolean;
  problems: LedgerProblem[];
}

function sample(list: string[], n = 3): string {
  return list.slice(0, n).join(', ') + (list.length > n ? ` and ${list.length - n} more` : '');
}

/**
 * Company-agnostic check of the whole ledger in this database. Read-only.
 * `expectedTriggers` defaults to every bka_* trigger the migrations create.
 */
export async function checkLedgerHealth(
  db: Raw,
  migrationsFolder: string,
  opts: { includeCachedBalances?: boolean } = {},
): Promise<LedgerHealth> {
  const problems: LedgerProblem[] = [];

  // (1) Guards present and ENABLE ALWAYS.
  const expected = ledgerGuardPlan(migrationsFolder).triggers;
  const active = new Set(
    (
      await rows<{ tgname: string }>(
        db,
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'A' AND tgname LIKE 'bka\\_%'`,
      )
    ).map((r) => r.tgname),
  );
  const missing = expected.filter((t) => !active.has(t));
  if (missing.length) {
    problems.push({
      kind: 'guards',
      detail: `${missing.length} ledger safety check${missing.length === 1 ? ' is' : 's are'} missing or turned off (${sample(missing)}).`,
    });
  }

  // (1b) No trigger switched off — including the database's own foreign-key triggers, which
  //      DISABLE TRIGGER ALL turns off along with the ledger guards.
  const disabled = await rows<{ tbl: string; tgname: string; tgisinternal: boolean }>(db, DISABLED_TRIGGERS_SQL);
  if (disabled.length) {
    const fk = disabled.filter((d) => d.tgisinternal).length;
    problems.push({
      kind: 'guards',
      detail: `${disabled.length} database safety trigger${disabled.length === 1 ? ' is' : 's are'} turned off${
        fk ? ` (${fk} of them enforce links between records, such as journal lines to their entries)` : ''
      }.`,
    });
  }

  // (1c) Every foreign key the migrations declare is present, validated and unaltered. A key
  //      dropped offline leaves no trigger behind, so (1b) cannot see it.
  const fkDetail = describeForeignKeyGaps(
    await foreignKeyGaps(<T,>(t: string) => rows<T>(db, t), migrationsFolder),
  );
  if (fkDetail) problems.push({ kind: 'guards', detail: fkDetail });

  // (1d) No triggers on the ledger tables other than the shipped guards.
  const extra = await extraLedgerTriggers(<T,>(t: string) => rows<T>(db, t), migrationsFolder);
  if (extra.length) {
    problems.push({
      kind: 'guards',
      detail: `${extra.length} unexpected database trigger${extra.length === 1 ? ' was' : 's were'} added to the ledger tables outside BookKeeper (${sample(
        extra.map((t) => `${t.tgname} on ${t.tbl}`),
      )}).`,
    });
  }

  // (2) Every posted entry: at least two lines, each with exactly one positive side of at most
  //     2 decimals, and debits = credits (mirrors bka_assert_entry_balanced).
  const unbalanced = await rows<{ entry_number: number; debit: string; credit: string }>(
    db,
    `SELECT e.entry_number, coalesce(sum(l.debit), 0)::text AS debit, coalesce(sum(l.credit), 0)::text AS credit
       FROM journal_entries e
       LEFT JOIN journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.status = 'posted'
      GROUP BY e.id, e.entry_number
     HAVING count(l.id) < 2
         OR coalesce(sum(l.debit), 0) <> coalesce(sum(l.credit), 0)
         OR count(l.id) FILTER (WHERE NOT (
              ((coalesce(l.debit, 0) > 0 AND coalesce(l.credit, 0) = 0)
                OR (coalesce(l.credit, 0) > 0 AND coalesce(l.debit, 0) = 0))
              AND coalesce(l.debit, 0) = round(coalesce(l.debit, 0), 2)
              AND coalesce(l.credit, 0) = round(coalesce(l.credit, 0), 2))) > 0
      ORDER BY e.entry_number
      LIMIT 50`,
  );
  if (unbalanced.length) {
    problems.push({
      kind: 'unbalanced_entries',
      detail: `${unbalanced.length === 50 ? 'At least 50' : unbalanced.length} posted journal entr${unbalanced.length === 1 ? 'y is' : 'ies are'} out of balance or malformed (${sample(
        unbalanced.map((u) => `#${u.entry_number}: debits ${u.debit}, credits ${u.credit}`),
      )}), so the trial balance does not balance.`,
    });
  }

  // (3) No line on another company's account.
  const [cross] = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE a.company_id IS DISTINCT FROM e.company_id`,
  );
  if (Number(cross?.n ?? 0) > 0) {
    problems.push({
      kind: 'cross_company',
      detail: `${cross.n} journal line${Number(cross.n) === 1 ? '' : 's'} point at an account that belongs to another company.`,
    });
  }

  // (3b) No orphan lines: every line belongs to an existing entry and an existing account. The
  //      foreign keys normally make this impossible, but a file edited with its triggers off can
  //      carry them — amounts that move account balances yet appear on no entry or report.
  const [orphan] = await rows<{ no_entry: number; no_account: number }>(
    db,
    `SELECT count(*) FILTER (WHERE e.id IS NULL)::int AS no_entry,
            count(*) FILTER (WHERE a.id IS NULL)::int AS no_account
       FROM journal_entry_lines l
       LEFT JOIN journal_entries e ON e.id = l.journal_entry_id
       LEFT JOIN accounts a ON a.id = l.account_id
      WHERE e.id IS NULL OR a.id IS NULL`,
  );
  const noEntry = Number(orphan?.no_entry ?? 0);
  const noAccount = Number(orphan?.no_account ?? 0);
  if (noEntry || noAccount) {
    const parts = [
      noEntry && `${noEntry} journal line${noEntry === 1 ? ' belongs' : 's belong'} to a journal entry that does not exist`,
      noAccount && `${noAccount} journal line${noAccount === 1 ? ' is' : 's are'} on an account that does not exist`,
    ].filter(Boolean);
    problems.push({ kind: 'orphan_lines', detail: `${parts.join(', and ')}.` });
  }

  // (4) No posted amount on a non-posting account.
  const [np] = await rows<{ n: number }>(
    db,
    `SELECT count(*)::int AS n
       FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'posted'
       JOIN accounts a ON a.id = l.account_id
      WHERE a.subtype::text = 'non_posting'`,
  );
  if (Number(np?.n ?? 0) > 0) {
    problems.push({
      kind: 'non_posting',
      detail: `${np.n} posted journal line${Number(np.n) === 1 ? ' is' : 's are'} on a non-posting account (estimates or purchase orders).`,
    });
  }

  // (5) Cached account balances equal the ledger.
  if (opts.includeCachedBalances !== false) {
    const drift = await rows<{ code: string; balance: string; ledger: string }>(
      db,
      `WITH ledger AS (
         SELECT l.account_id,
                sum(coalesce(l.debit, 0) - coalesce(l.credit, 0)) AS net
           FROM journal_entry_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id AND e.status = 'posted'
          GROUP BY l.account_id)
       SELECT a.code, a.balance::text AS balance,
              (CASE WHEN a.type::text IN ('asset', 'expense') THEN coalesce(g.net, 0) ELSE -coalesce(g.net, 0) END)::text AS ledger
         FROM accounts a
         LEFT JOIN ledger g ON g.account_id = a.id
        WHERE a.balance IS DISTINCT FROM
              (CASE WHEN a.type::text IN ('asset', 'expense') THEN coalesce(g.net, 0) ELSE -coalesce(g.net, 0) END)
        ORDER BY a.code
        LIMIT 50`,
    );
    if (drift.length) {
      problems.push({
        kind: 'cached_balances',
        detail: `${drift.length === 50 ? 'At least 50' : drift.length} account balance${drift.length === 1 ? ' does' : 's do'} not match the ledger (${sample(
          drift.map((d) => `account ${d.code}: shows ${d.balance}, ledger ${d.ledger}`),
        )}).`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Problems that make a file unsafe to open (cached-balance drift is repairable with Rebuild Data). */
export const OPEN_BLOCKING: ReadonlySet<LedgerProblemKind> = new Set([
  'guards',
  'unbalanced_entries',
  'cross_company',
  'orphan_lines',
  'non_posting',
]);
