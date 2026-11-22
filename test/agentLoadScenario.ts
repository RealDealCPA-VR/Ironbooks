/**
 * Agent full access, Phase 7 load test (plan §9 Phase 7, §11.3): what test/agentLoad.test.ts builds
 * on top of the shared in-process scenario (test/helpers/agentScenario.ts, reused as it is). Not a
 * test file (vitest picks up *.test.ts only).
 *
 * Nothing of the app is mocked here. What this adds:
 *  - the clock: only Date is moved, set ahead and still running with real time (startLoadClock),
 *    so the door's per-minute limit can be stepped past without waiting a real minute. The
 *    database reads the same clock (PGlite takes its time from Date), so rows stamped by Postgres
 *    and rows stamped by the app agree;
 *  - a counter of the statements a piece of work sends to the company file. The database has no
 *    query hook of its own: lib/db/index.ts wraps the PGlite client twice, to turn Postgres errors
 *    into the app's own (lib/db/pgErrors.ts translatePgErrors) and to refuse every statement once
 *    another computer took the file (refuseWhenLost), and neither counts or reports anything. So
 *    the counter wraps the same client's query and exec, and those of every transaction it opens,
 *    while it counts, and puts them back after;
 *  - a bank account, statement rows and the import body an agent sends (POST /api/import, fileType
 *    "rows": reviewed statement rows, tied out);
 *  - a large journal seeded straight into the tables (posted, balanced entries; the database's own
 *    triggers keep the account balances), for timing a dry run on a company with years of entries;
 *  - timing on the real clock (performance.now, never faked).
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import type { OperationPreview } from '@/lib/agent/contract';
import { journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { createAccount } from '@/lib/services/accounts';
import { createBankAccount } from '@/lib/services/bankAccounts';
import type { ServiceContext } from '@/lib/services/_base';

// ---------------------------------------------------------------------------
// The data folder
// ---------------------------------------------------------------------------

/** Each run's data folder is .bookkeeper-data/<prefix><process id>, its own. */
export const LOAD_RUN_PREFIX = 'test-agent-load-';

/**
 * Remove the data folders earlier runs of the load test left behind (a run that could not remove
 * its own, Windows still holding a file of it). Only folders untouched for an hour: a run takes
 * minutes, so none of them is a run going on now. Best effort; nothing here fails a run.
 */
export function clearOldLoadRuns(now = Date.now()): void {
  const parent = path.resolve(process.cwd(), '.bookkeeper-data');
  let names: string[] = [];
  try {
    names = fs.readdirSync(parent).filter((n) => n.startsWith(LOAD_RUN_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(parent, name);
    try {
      if (now - fs.statSync(dir).mtimeMs < 3_600_000) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Still held: the next run tries again.
    }
  }
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface LoadClock {
  /** Move the clock forward (it keeps running from there). */
  jump(ms: number): void;
  /** How far ahead of the real clock it is, in milliseconds. */
  readonly ahead: number;
  /** Back to the real clock. */
  stop(): void;
}

/**
 * Date only, set ahead of the real clock by however far it was moved, and running on with real
 * time at the real clock's own resolution. Nothing else is touched: timers, the database's own
 * waits and the bridge's time limits run on real time.
 *
 * Why not vitest's fake timers: they move Date in steps of their own (and not at all while
 * PGlite is busy, since the steps come from a timer), and PGlite reads the same Date for the
 * database's now(). Many transactions then begin at the same now(), and the bridge, which knows the
 * rows a run wrote by created_at = now() (lib/agent/bridge.ts), takes other runs' rows for its own.
 * On the real clock two transactions share a now() only when the first begins, writes and commits
 * within the same millisecond.
 */
export function startLoadClock(): LoadClock {
  const RealDate = Date;
  let ahead = 0;
  // A proxy, not a subclass: every Date made anywhere is still a real Date (instanceof holds for
  // Dates made before, and by Node itself); only "now" moves.
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) => (args.length ? Reflect.construct(target, args, newTarget) : Reflect.construct(target, [target.now() + ahead], newTarget)),
    apply: (target) => new target(target.now() + ahead).toString(),
    get: (target, prop, receiver) => (prop === 'now' ? () => target.now() + ahead : Reflect.get(target, prop, receiver)),
  });
  return {
    jump: (ms) => {
      ahead += ms;
    },
    get ahead() {
      return ahead;
    },
    stop: () => {
      globalThis.Date = RealDate;
    },
  };
}

/**
 * Keeps one agent's calls under the door's per-minute limit by stepping the clock past the minute
 * before a group would go over it. `used` is how many calls the agent sent in this minute.
 */
export class MinutePacer {
  used = 0;
  constructor(
    private readonly clock: LoadClock,
    private readonly perMinute: number,
  ) {}

  /** Call before sending `n` calls at once. */
  before(n: number): void {
    if (this.used + n > this.perMinute) this.nextMinute();
    this.used += n;
  }

  /** A minute and a second later: every call of the last minute has left the window. */
  nextMinute(): void {
    this.clock.jump(61_000);
    this.used = 0;
  }
}

// ---------------------------------------------------------------------------
// Counting statements
// ---------------------------------------------------------------------------

type Callable = (...args: unknown[]) => Promise<unknown>;
type Patchable = Record<string, unknown>;

export interface StatementCounter {
  /** Statements sent since the last reset. */
  readonly count: number;
  reset(): void;
  /** Count the statements `run` sends (and only those: nothing else may run meanwhile). */
  measure<T>(run: () => Promise<T>): Promise<{ value: T; statements: number }>;
  /** Put the client's own methods back. */
  stop(): void;
}

/**
 * Count the statements sent to `db`'s PGlite client: every query and exec, on the client and in
 * every transaction it opens. BEGIN, COMMIT and ROLLBACK are PGlite's own and are not counted.
 */
export function countStatements(db: DB): StatementCounter {
  const client = (db as unknown as { $client: Patchable }).$client;
  let n = 0;
  const wrap = (target: Patchable, name: 'query' | 'exec') => {
    const fn = target[name];
    if (typeof fn !== 'function') return;
    const bound = (fn as Callable).bind(target);
    target[name] = async (...args: unknown[]) => {
      n += 1;
      return bound(...args);
    };
  };
  const original = { query: client.query, exec: client.exec, transaction: client.transaction };
  wrap(client, 'query');
  wrap(client, 'exec');
  const transaction = (original.transaction as (fn: (t: Patchable) => Promise<unknown>, ...rest: unknown[]) => Promise<unknown>).bind(client);
  client.transaction = (fn: (t: Patchable) => Promise<unknown>, ...rest: unknown[]) =>
    transaction(async (t: Patchable) => {
      wrap(t, 'query');
      wrap(t, 'exec');
      return fn(t);
    }, ...rest);
  return {
    get count() {
      return n;
    },
    reset: () => {
      n = 0;
    },
    measure: async (run) => {
      const start = n;
      const value = await run();
      return { value, statements: n - start };
    },
    stop: () => {
      client.query = original.query;
      client.exec = original.exec;
      client.transaction = original.transaction;
    },
  };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** How long `run` took on the real clock, in milliseconds. */
export async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await run();
  return { value, ms: Math.round(performance.now() - t0) };
}

/** The middle value. */
export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/** The value `p` (0 to 1) of the way up. */
export function percentile(values: number[], p: number): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
}

// ---------------------------------------------------------------------------
// The bank and its statement
// ---------------------------------------------------------------------------

/** A new ledger bank account linked to a bank, as a person sets it up in the app. */
export async function addBank(person: ServiceContext, name: string): Promise<{ bankAccountId: string; glAccountId: string }> {
  const account = await createAccount(person, { name, qbType: 'Bank' } as Parameters<typeof createAccount>[1]);
  const glAccountId = (account as { id: string }).id;
  const bank = await createBankAccount(person, { accountId: glAccountId, bankName: `${name} Bank`, accountNumber: '000777888' });
  return { bankAccountId: bank.id, glAccountId };
}

export interface StatementRow {
  date: string;
  description: string;
  amount: string;
  payee: string;
}

/** Payees that come back month after month, as on a real statement. */
export const PAYEES = [
  'Office Depot',
  'Staples',
  'Shell Oil',
  'Comcast',
  'City Water',
  'Verizon',
  'Amazon',
  'FedEx',
  'UPS Store',
  'Home Depot',
  'Lowes',
  'Costco',
  'Uber',
  'Delta Air',
  'Hilton',
  'Adobe',
  'Microsoft',
  'Google Ads',
  'Zoom',
  'Dropbox',
];

/** Payees the company has not paid before: adding their lines teaches Ironbooks new bank rules. */
export const NEW_PAYEES = [
  'Acme Janitorial',
  'Blue Sky Couriers',
  'Cedar Print Shop',
  'Delta Coffee Service',
  'Evergreen Landscaping',
  'Fresh Water Delivery',
  'Granite Security',
  'Harbor Parking',
  'Iron Gate Storage',
  'Juniper Catering',
];

/**
 * Statement line `i`: money out, a payee from the list, a day in the statement month, and a
 * description no other line has (the import never takes it for a duplicate). `amountOf` gives the
 * line's size as decimal text, without a sign.
 */
export function statementRow(i: number, amountOf: (i: number) => string, month = '2026-10', payees: readonly string[] = PAYEES): StatementRow {
  const day = String((i % 28) + 1).padStart(2, '0');
  const payee = payees[i % payees.length];
  return { date: `${month}-${day}`, description: `${payee.toUpperCase()} #${String(i).padStart(5, '0')}`, amount: Money.neg(amountOf(i)).toFixed(2), payee };
}

/** The body of POST /api/import for reviewed statement rows that tie out from an opening of zero. */
export function importBody(bankAccountId: string, rows: StatementRow[]): Record<string, unknown> {
  const closing = rows.reduce((sum, r) => Money.add(sum, r.amount), Money.of('0'));
  return {
    bankAccountId,
    fileType: 'rows',
    rows,
    statement: { kind: 'bank', openingBalance: '0.00', closingBalance: closing.toFixed(2) },
    filename: 'october-statement.pdf',
  };
}

// ---------------------------------------------------------------------------
// What changed between two previews of one request
// ---------------------------------------------------------------------------

/** Fields a run gives itself whatever the books say: a record's own id, times, the entry number it takes. */
const OWN_FIELD = /(?:At|_at)$|^id$|^entryNumber$/;
const ID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Where the preview a person was shown and the one a later try made differ, part by part, with
 * what a run gives itself left out: a record's own id, times, the entry number, and every id of a
 * record that try made (it creates it), wherever it shows, written "(made)". A reference to a
 * record that was there before (the line, the account, a rule) is compared as it is, as the
 * staleness key compares it. The parts, as lib/agent/bridge.ts stalenessKeyOf hashes them:
 *  - the records, kind by kind ("transaction_rule.priority: [8] then [9]"); a record that existed
 *    is compared on its fields before and after;
 *  - the ledger ("ledger entry: [...] then [...]"): each entry by its date, description, status,
 *    source and lines (account, debit, credit, memo, name, class), its number left out;
 *  - the effects ("effect email: [...] then [...]"): each by its summary and detail.
 * For explaining a 'stale' answer; empty when the two agree on everything else.
 */
export function previewDifferences(shown: OperationPreview | null | undefined, now: OperationPreview | null | undefined): string[] {
  const valuesOf = (p: OperationPreview | null | undefined) => {
    const records = p?.records ?? [];
    const made = new Set(
      [...records, ...(p?.ledger?.changes ?? [])].filter((r) => r.action === 'create').map((r) => String(r.id).toLowerCase()),
    );
    const value = (v: unknown) => (JSON.stringify(v ?? null) ?? 'null').replace(ID_IN_TEXT, (id) => (made.has(id.toLowerCase()) ? '(made)' : id));
    const out = new Map<string, string[]>();
    const add = (k: string, v: string) => out.set(k, [...(out.get(k) ?? []), v]);
    for (const r of records) {
      const own = made.has(String(r.id).toLowerCase());
      add(`${r.kind} ${r.action}`, own ? '(record)' : String(r.id).toLowerCase());
      for (const f of r.fields ?? []) {
        if (OWN_FIELD.test(f.field)) continue;
        add(`${r.kind}.${f.field}`, own ? value(f.after) : `${value(f.before)} to ${value(f.after)}`);
      }
    }
    for (const e of p?.ledger?.entries ?? []) {
      const lines = e.lines
        .map((l) => ({ account: l.accountId, debit: l.debit, credit: l.credit, memo: l.memo, name: l.entityName, class: l.className ?? null }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      add('ledger entry', value({ id: e.journalEntryId, date: e.date, description: e.description, status: e.status, source: e.source, lines }));
    }
    for (const x of p?.effects ?? []) add(`effect ${x.kind}`, value({ summary: x.summary, detail: x.detail }));
    return out;
  };
  const a = valuesOf(shown);
  const b = valuesOf(now);
  const out: string[] = [];
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = (a.get(k) ?? []).sort();
    const y = (b.get(k) ?? []).sort();
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${k}: [${x.join(', ')}] then [${y.join(', ')}]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// A large journal, seeded straight into the tables
// ---------------------------------------------------------------------------

/**
 * `count` posted entries of two balanced lines each, over the ten years before `before`, numbered
 * after the company's last entry, written in chunks (one transaction each). Straight into the
 * tables, never through the posting service: this is the shape of a company file with years of
 * history, not a test of posting. The database's own triggers (drizzle/0017) check each entry
 * balances and keep the account balances.
 */
export async function seedJournal(
  db: DB,
  companyId: string,
  userId: string,
  count: number,
  accounts: { debit: string; credit: string },
  before = '2026-01-01',
): Promise<void> {
  const [{ last }] = await db
    .select({ last: sql<number>`coalesce(max(${journalEntries.entryNumber}), 0)::int` })
    .from(journalEntries)
    .where(sql`${journalEntries.companyId} = ${companyId}`);
  const end = Date.parse(`${before}T12:00:00Z`);
  const span = 10 * 365 * 86_400_000;
  const CHUNK = 1000;
  for (let from = 0; from < count; from += CHUNK) {
    const size = Math.min(CHUNK, count - from);
    await db.transaction(async (tx) => {
      const entries = await tx
        .insert(journalEntries)
        .values(
          Array.from({ length: size }, (_, k) => {
            const i = from + k;
            return {
              companyId,
              entryNumber: Number(last) + i + 1,
              date: new Date(end - span + Math.floor((span * i) / count)),
              description: `Seeded history entry ${i + 1}`,
              status: 'posted' as const,
              createdBy: userId,
            };
          }),
        )
        .returning({ id: journalEntries.id });
      const lines = entries.flatMap((e, k) => {
        const amount = `${((from + k) % 900) + 10}.25`;
        return [
          { journalEntryId: e.id, accountId: accounts.debit, debit: amount, credit: null, memo: 'Seeded' },
          { journalEntryId: e.id, accountId: accounts.credit, debit: null, credit: amount, memo: 'Seeded' },
        ];
      });
      for (let at = 0; at < lines.length; at += 1000) await tx.insert(journalEntryLines).values(lines.slice(at, at + 1000));
    });
  }
}
