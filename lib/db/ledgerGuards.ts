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
 * file contained. It is idempotent and runs on every open (lib/db/index.ts).
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
  if (!fs.existsSync(key)) return { statements: [], triggers: [] };
  const statements: string[] = [];
  const triggers = new Set<string>();
  for (const file of migrationFiles(key)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split('--> statement-breakpoint')) {
      const stmt = stripLeadingComments(raw);
      if (!stmt || !GUARD_STATEMENT.some((re) => re.test(stmt))) continue;
      statements.push(stmt);
      const created = /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(bka_\w+)/i.exec(stmt);
      if (created) triggers.add(created[1]);
    }
  }
  const plan = { statements, triggers: [...triggers].sort() };
  planCache.set(key, plan);
  return plan;
}

async function rows<T>(db: Raw, text: string): Promise<T[]> {
  const res = await db.query<T>(text);
  return res.rows;
}

/**
 * Re-install every ledger guard from the migration files, then force every bka_* trigger to
 * ENABLE ALWAYS. Runs in one transaction: either every guard is (re)installed or nothing changes
 * and the error propagates (the caller must then refuse the file).
 */
export async function ensureLedgerGuards(client: PGlite, migrationsFolder: string): Promise<void> {
  const plan = ledgerGuardPlan(migrationsFolder);
  if (!plan.statements.length) return;
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
      await tx.exec(`ALTER TABLE "${r.tbl.replace(/"/g, '""')}" ENABLE ALWAYS TRIGGER "${r.tgname.replace(/"/g, '""')}"`);
    }
  });
}

export type LedgerProblemKind =
  | 'guards'
  | 'unbalanced_entries'
  | 'cross_company'
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
       LEFT JOIN accounts a ON a.id = l.account_id
      WHERE a.company_id IS DISTINCT FROM e.company_id`,
  );
  if (Number(cross?.n ?? 0) > 0) {
    problems.push({
      kind: 'cross_company',
      detail: `${cross.n} journal line${Number(cross.n) === 1 ? '' : 's'} point at an account that belongs to another company or no longer exists.`,
    });
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
  'non_posting',
]);
