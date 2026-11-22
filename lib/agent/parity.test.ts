/**
 * Agent full access: dry-run parity (plan §10 "Dry-run parity", Phase 1).
 *
 * The approval card a person says yes to is built from a dry run (plan §11.4): if the dry run
 * shows one thing and the real run then does another, the person approved something they never
 * saw. So for each `enter` / `change` operation with a fixture input (test/helpers/
 * agentParityFixtures.ts), through the real bridge on a real PGlite company:
 *
 *  - the dry run leaves the database as it was: the row count and a checksum of every table,
 *    the ledger tables among them, and the transaction log, before and after;
 *  - two dry runs in a row give the same staleness key;
 *  - the dry run's ledger preview (date, status, description, source, and the account, debit,
 *    credit and memo of every line; ids in the words put aside) is what the real run then posts:
 *    the entries it made, and the entries that already existed that it voided, deleted or changed
 *    (their lines and status as the real run left them). An account the run makes itself (Opening
 *    Balance Equity, say) is matched by its code and name: each run makes its own. The name
 *    (customer, vendor …) and class of each line the dry run made, and each new entry's reference,
 *    are compared too: the preview does not carry them (lib/agent/actions.ts PostingEntry,
 *    PostingLine), so they are read in the dry run's own transaction, just before it is rolled
 *    back, by a pass-through on changesInTransaction. In a source or a reference, an id the run
 *    made itself (also cut to its first 8 hex digits, a paycheck's reference) or one that names no
 *    row (made up by the run, "assembly_build:<id>") is written "(new)"; the id of a record that
 *    was there before is compared as it is;
 *  - the dry run's record diffs name the same records (action, kind, id) and the same changed
 *    fields as the audit rows the real run wrote, all of them, whichever handle wrote them. A
 *    record's id is compared as it is, except for a record the run made itself (an audit 'create'
 *    or a ledger entry of that same run, the rule of the bridge's staleness key), which each run
 *    makes anew. The values the card shows, and the entry numbers, are compared too, as notes. A
 *    preview with nothing in it for a real run that keeps rows (with no audit row for them) is a
 *    difference: the person would be shown nothing of what they approve;
 *  - the amount in the dry run's facts is what the real run posted: the largest entry for an
 *    operation with an amount field, all of it for one without, compared by size (the policy reads
 *    an amount by its size; a sign is a note). A run of an operation with no amount field that
 *    posted and touched no entry: "0.00" when it only made new records, and unknown (null) when it
 *    voided, deleted or changed a record that was there before it (an audit row other than
 *    'create', of a record it did not make): money may move that no entry shows. An amount field
 *    that could not be read stays unknown too. All three are decisions of this feature (fail
 *    closed); an unknown amount field is not a difference, but it is listed in the report
 *    (PARITY_REPORT below);
 *  - and, tested on its own in a second set of cases: the dry run an approval makes, as another
 *    person of the company (runApproved, lib/agent/operate.ts), gives the key the agent's dry run
 *    gave (the one the request stored), and keeps nothing either.
 *
 * The agent's runs are built as the door builds an agent's own run (ownActor in
 * lib/agent/operate.ts): the ceiling masked (maskedForAgent), the ceiling's role, the policy's
 * folders, never at the host. The approver's as runApproved builds it.
 *
 * A case where parity does not hold is marked `fails` (or `approverFails`) in the fixtures with
 * the patterns of what differs. It still runs as a plain test that checks exactly those
 * differences are found, no more and no fewer: a fix, or a new difference, fails it until the mark
 * is brought up to date. Set PARITY_REPORT to a file name to have every case written there: what
 * it posted, what differs and any notes, under a summary of how much of the registry the cases
 * cover.
 *
 * Only the request the bridge runs in (next/headers) and the time limits (longer, so a busy
 * machine does not turn a slow run into a difference) are replaced, changesInTransaction is
 * wrapped to read what the preview leaves out (above), and the checks of the harness itself put
 * a handler of their own in front of a route (a real run that does more than its dry runs showed,
 * or something else, must be caught). Everything else, every case's route handler included, is
 * the app's own code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

/** One line the run made, as its own transaction holds it: what the preview's line leaves out. */
interface MadeLine {
  entry_id: string;
  entity_type: string | null;
  entity_id: string | null;
  class_id: string | null;
}

const h = vi.hoisted(() => ({
  handler: null as null | ((req: Request) => Promise<Response>),
  /** The lines of the entries the last run made, read just before its transaction ended (null: not read). */
  madeLines: null as null | MadeLine[],
  /** The reference of each entry the last run made, by entry id, read beside its lines (null: not read). */
  madeRefs: null as null | Map<string, string | null>,
}));

// A pass-through: the preview as the app builds it, and, beside it, the name and class of every
// line it lists and the reference of every entry, read in the same transaction (so a dry run's,
// before it is rolled back) in the same order as changesInTransaction lists them. Nothing is written.
vi.mock('./actions', async (orig) => {
  const real = await orig<typeof import('./actions')>();
  const { sql: q } = await import('drizzle-orm');
  return {
    ...real,
    changesInTransaction: async (ctx: Parameters<typeof real.changesInTransaction>[0]) => {
      const out = await real.changesInTransaction(ctx);
      const res = (await ctx.db.execute(q`
        SELECT l.journal_entry_id::text AS entry_id, l.entity_type, l.entity_id::text AS entity_id, l.class_id::text AS class_id
          FROM journal_entries je
          JOIN journal_entry_lines l ON l.journal_entry_id = je.id
         WHERE je.company_id = ${ctx.companyId} AND je.created_at = now()
         ORDER BY je.entry_number, (l.debit IS NULL OR l.debit = 0), l.id`)) as unknown as { rows: MadeLine[] };
      h.madeLines = res.rows;
      const refs = (await ctx.db.execute(q`
        SELECT je.id::text AS id, je.reference FROM journal_entries je
         WHERE je.company_id = ${ctx.companyId} AND je.created_at = now()`)) as unknown as { rows: Array<{ id: string; reference: string | null }> };
      h.madeRefs = new Map(refs.rows.map((r) => [r.id.toLowerCase(), r.reference]));
      return out;
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

vi.mock('./contract', async (orig) => {
  const real = await orig<typeof import('./contract')>();
  return { ...real, BRIDGE_TIME_LIMIT_MS: 120_000, BRIDGE_REPORT_TIME_LIMIT_MS: 120_000 };
});

// The harness's own check only: a handler that stands in for the route while it is set.
vi.mock('./operations/registry', async (orig) => {
  const real = await orig<typeof import('./operations/registry')>();
  return {
    ...real,
    loadRouteHandler: async (operation: Parameters<typeof real.loadRouteHandler>[0]) => h.handler ?? real.loadRouteHandler(operation),
  };
});

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-parity');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-parity-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
process.env.BKA_AGENT_FILES_DIR = path.join(ROOT, 'agent-files');
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;
delete process.env.BKA_COMPANY_STATE;

import { getDb, closeDb, type DB } from '@/lib/db';
import { readOnlyDb } from '@/lib/db/readOnly';
import { items, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import { legacyRoleFor, type EffectiveAccess } from '@/lib/permissions/model';
import { agentDirectAccess, maskedForAgent } from '@/lib/permissions/agentAccess';
import { Money, toAmountString, type MoneyInput } from '@/lib/money';
import { seedRichCompany, type RichCompany } from '@/lib/services/companyFile.fixture';
import { createAgent } from '@/lib/services/agents';
import { agentCeiling, loadAgentPolicy } from '@/lib/services/agentPolicies';
import { resolveAccess } from '@/lib/services/access';
import { readAllTransactionLog } from '@/lib/services/transactionLog';
import { writeAudit, type ServiceContext } from '@/lib/services/_base';
import { postJournalEntry } from '@/lib/services/posting';
import { lineMemoFor } from '@/lib/services/journal';
import { getServerContext } from '@/lib/context';
import { PARITY_CASES, buildParityWorld, type ParityCase, type ParityTools, type ParityWorld } from '@/test/helpers/agentParityFixtures';
import { allOperations } from './operations/registry';
import type { AgentPolicy, Operation, RecordDiff } from './operations/types';
import type { BridgeActor, BridgeResult, OperationInput } from './contract';
import { runOperation } from './bridge';
import { intersectAccess, lowerRole } from './operate';

type Obj = Record<string, unknown>;
type Role = NonNullable<ServiceContext['role']>;
let db: DB;
let rich: RichCompany;
let agentId: string;
/** The agent's ceiling (agentCeiling, lib/services/agentPolicies.ts): its roles' access and role word. */
let ceiling: { access: EffectiveAccess; role: Role };
/** The agent's policy as the door loads it (loadAgentPolicy): its preset and folders. */
let policy: AgentPolicy;
/** The agent's own context, as lib/agentContext.ts builds it: read-only, with the narrow direct access. */
let agentBase: ServiceContext;
let world: ParityWorld;
let tableNames: string[] = [];
/** The tables whose rows have a uuid `id`: where an id in a source or a reference may name a row. */
let idTables: string[] = [];
/** A second person of the company (Full Access) who approves the agent's requests: not the person who made the agent. */
let approver: ServiceContext;
/** The agent's ceiling as the approval loads it, as the approver (runApproved, lib/agent/operate.ts). */
let approverCeiling: { access: EffectiveAccess; role: Role };

/** What one case found. */
interface Found {
  differences: string[];
  notes: string[];
  summary: string;
  /**
   * The approver's dry run against the key the agent's dry run gave: null when they agree, what
   * differs when they do not, undefined when the case did not get that far.
   */
  approverKey?: string | null;
}

/** Every case's summary, differences and notes, written at the end when PARITY_REPORT names a file. */
const report: Array<Found & { name: string }> = [];
/** How much of the registry the cases cover, for the top of the report. */
let coverage: string[] = [];

function op(id: string): Operation {
  const o = allOperations().find((x) => x.id === id);
  if (!o) throw new Error(`No operation ${id}`);
  return o;
}

/**
 * The actor of an agent's own run, as ownActor (lib/agent/operate.ts) builds it: the ceiling
 * masked (maskedForAgent: the View flags off, so previews and answers stay masked), the ceiling's
 * role, the policy's folders, nobody signed in, never at the host. Its dry run gives the key a
 * request stores; with no person behind it, its real run is the one an Allow runs.
 */
function actor(): BridgeActor {
  return {
    agent: { id: agentId, name: 'Parity Agent', preset: policy.preset, onBehalfOf: rich.ctx.userId },
    access: maskedForAgent(ceiling.access),
    role: ceiling.role,
    userId: null,
    approval: { approvedBy: null, requestId: null, grantId: null },
    reveal: false,
    secrets: {},
    folders: [...(policy.folders ?? [])],
    atHost: false,
  };
}

const run = (operation: Operation, input: OperationInput, mode: 'dry_run' | 'commit') => runOperation(agentBase, operation, input, mode, actor());

/**
 * The actor of the dry run an approval makes before the real run (runApproved in lib/agent/operate.ts):
 * the approving person's own context as the base, their access within the agent's ceiling, the
 * lower of their role and the ceiling's, the policy's folders, no reveal, and of the secrets the
 * approver typed only the closing-date password (dryRunSecrets there). No case dates anything in a
 * closed period, so none is typed and `secrets` stays empty, as it is in the app for these
 * requests. Approved at the desktop window (atHost). Its key is compared with the one the agent's
 * dry run gave (the one the request stored): when they differ, the person is told the books
 * changed and has to say yes again on a preview that shows the same thing.
 */
function approverActor(): BridgeActor {
  return {
    agent: { id: agentId, name: 'Parity Agent', preset: policy.preset, onBehalfOf: approver.userId },
    access: intersectAccess(approver.access!, approverCeiling.access),
    role: lowerRole(approver.role, approverCeiling.role),
    userId: approver.userId,
    approval: { approvedBy: approver.userId, requestId: randomUUID(), grantId: null },
    reveal: false,
    secrets: {},
    folders: [...(policy.folders ?? [])],
    atHost: true,
  };
}

const rowsOf = async <T,>(q: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(q)) as unknown as { rows: T[] }).rows;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Obj;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

const asJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** A ledger amount as the preview shows it: two places, null for none or zero (lib/money.ts). */
function amount(v: MoneyInput): string | null {
  if (v === null || v === undefined || v === '') return null;
  return Money.isZero(v) ? null : toAmountString(v);
}

// ---------------------------------------------------------------------------
// What the database holds
// ---------------------------------------------------------------------------

/** Row count and checksum of every table, and the transaction log's length. */
async function fingerprint(): Promise<{ tables: Record<string, string>; log: number }> {
  const parts = tableNames.map(
    (t) => `SELECT '${t}' AS t, count(*)::int AS n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM "${t}" x`,
  );
  const rows = await rowsOf<{ t: string; n: number; h: string }>(sql.raw(parts.join(' UNION ALL ')));
  const tables: Record<string, string> = {};
  for (const r of rows) tables[r.t] = `${r.n} rows, ${r.h}`;
  return { tables, log: readAllTransactionLog(TEST_DIR).records.length };
}

function fingerprintDifferences(before: Awaited<ReturnType<typeof fingerprint>>, after: Awaited<ReturnType<typeof fingerprint>>, when: string): string[] {
  const out: string[] = [];
  for (const t of Object.keys(before.tables)) {
    if (before.tables[t] !== after.tables[t]) out.push(`${when} changed table ${t}: ${before.tables[t]} -> ${after.tables[t]}`);
  }
  if (before.log !== after.log) out.push(`${when} wrote ${after.log - before.log} record(s) to the transaction log`);
  return out;
}

interface EntryState {
  status: string;
  date: string;
  description: string | null;
  entryNumber: number | null;
  reference: string | null;
  source: string | null;
  hash: string;
  total: string;
}

/** Every journal entry of the company: its status, date, reference, source, total debits and a hash of it and its lines. */
async function entries(): Promise<Map<string, EntryState>> {
  const rows = await rowsOf<{
    id: string;
    status: string;
    date: string;
    description: string | null;
    entry_number: number | string | null;
    reference: string | null;
    source_ref: string | null;
    hash: string;
    total: string;
  }>(sql`
    SELECT je.id::text AS id, je.status::text AS status, je.date::text AS date, je.description, je.entry_number, je.reference, je.source_ref,
           md5(je::text || coalesce((SELECT string_agg(l::text, '|' ORDER BY l.id) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id), '')) AS hash,
           coalesce((SELECT sum(l.debit) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id), 0)::text AS total
      FROM journal_entries je
     WHERE je.company_id = ${rich.ctx.companyId}`);
  return new Map(
    rows.map((r) => [
      r.id.toLowerCase(),
      {
        status: r.status,
        date: String(r.date).slice(0, 10),
        description: r.description,
        entryNumber: r.entry_number === null ? null : Number(r.entry_number),
        reference: r.reference,
        source: r.source_ref,
        hash: r.hash,
        total: r.total,
      },
    ]),
  );
}

/**
 * One ledger line as the comparison sees it. `account` is the account's id when it existed before
 * the runs, and its code and name when the run made it (Opening Balance Equity, say): each run
 * makes its own, with an id of its own. `name` and `cls` are the name the line is about ("customer
 * <id>") and its class, an id the run made itself written "(new)" (as records, below); they are
 * left out (undefined) where the dry run's side cannot be read: the entries that already existed.
 */
interface Line {
  account: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  name?: string;
  cls?: string;
}

/** An id as the comparison writes it: "(new)" when that run made the record itself, else the id. */
const idAs = (made: ReadonlySet<string>, id: string | null | undefined): string | null =>
  id ? (made.has(id.toLowerCase()) ? '(new)' : id.toLowerCase()) : null;

/** The name and class of a line, as written for the comparison ("-" for none). */
function nameAndClass(made: ReadonlySet<string>, l: { entity_type: string | null; entity_id: string | null; class_id: string | null }): { name: string; cls: string } {
  const id = idAs(made, l.entity_id);
  return { name: l.entity_type || id ? `${l.entity_type ?? '?'} ${id ?? '?'}` : '-', cls: idAs(made, l.class_id) ?? '-' };
}

async function accountIds(): Promise<Set<string>> {
  const rows = await rowsOf<{ id: string }>(sql`SELECT id::text AS id FROM accounts WHERE company_id = ${rich.ctx.companyId}`);
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

const accountOf = (existing: ReadonlySet<string>, id: string, code: string | null, name: string) =>
  existing.has(id.toLowerCase()) ? id.toLowerCase() : `(new account ${code ?? ''} ${name})`;

/** Of these ids, the ones that name a row of any table now. */
async function idsThatNameARow(ids: Iterable<string>): Promise<Set<string>> {
  const list = [...new Set([...ids].map((id) => id.toLowerCase()))].filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (!list.length || !idTables.length) return new Set();
  // Ids passed the pattern above (hex digits and dashes only), and the table names come from the
  // database's own catalogue, so both can be written in place.
  const arr = `ARRAY[${list.map((id) => `'${id}'`).join(',')}]::uuid[]`;
  const rows = await rowsOf<{ id: string }>(sql.raw(idTables.map((t) => `SELECT id::text AS id FROM "${t}" WHERE id = ANY(${arr})`).join(' UNION ')));
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/** The uuids in these texts. */
const uuidsIn = (...texts: Array<string | null | undefined>): string[] => texts.flatMap((t) => (t ?? '').toLowerCase().match(UUID_RE) ?? []);

/**
 * A new entry's source or reference as the comparison writes it. An id the run made itself
 * (`made`), or one that names no row (`rows`: the ids of it that do), is "(new)": each run makes
 * its own, or makes one up ("assembly_build:<id>"). So is a run of 8 hex digits that begins an id
 * the run made (a paycheck's reference is the first 8 of the paycheck's id). The id of a record
 * that was there before stays as it is: a source or reference naming another record is a
 * difference. The entry's own number in its reference (a General Journal entry's) is "(its no.)",
 * as entry numbers are notes, not differences.
 */
function refText(v: string | null, made: ReadonlySet<string>, rows: ReadonlySet<string>, entryNumber: number | null): string {
  if (v === null || v === '') return '-';
  if (entryNumber !== null && v === String(entryNumber)) return '(its no.)';
  const prefixes = [...made].map((id) => id.slice(0, 8));
  return v
    .replace(UUID_RE, (m) => (made.has(m.toLowerCase()) || !rows.has(m.toLowerCase()) ? '(new)' : m.toLowerCase()))
    .replace(/(?<![0-9a-f-])[0-9a-f]{8}(?![0-9a-f-])/gi, (m) => (prefixes.includes(m.toLowerCase()) ? '(new)' : m));
}

/**
 * The lines of these entries as the real run left them, their memos as the run's access may show
 * them (the preview masks an account number in a memo the same way, lib/agent/bridge.ts
 * shownText), with the name and class of each (ids the real run made written "(new)").
 */
async function linesOf(ids: string[], existing: ReadonlySet<string>, made: ReadonlySet<string>): Promise<Map<string, Line[]>> {
  const out = new Map<string, Line[]>();
  if (!ids.length) return out;
  // Ids come from the database (uuids), so they can be written in place.
  const list = sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`);
  const rows = await rowsOf<
    MadeLine & { account_id: string; code: string | null; name: string; debit: string | null; credit: string | null; memo: string | null }
  >(sql`
    SELECT l.journal_entry_id::text AS entry_id, l.account_id::text AS account_id, a.code, a.name, l.debit::text AS debit, l.credit::text AS credit, l.memo,
           l.entity_type, l.entity_id::text AS entity_id, l.class_id::text AS class_id
      FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
     WHERE l.journal_entry_id = ANY(${list})`);
  const shownTo = { access: actor().access };
  for (const r of rows) {
    const k = r.entry_id.toLowerCase();
    out.set(k, [
      ...(out.get(k) ?? []),
      { account: accountOf(existing, r.account_id, r.code, r.name), debit: amount(r.debit), credit: amount(r.credit), memo: lineMemoFor(shownTo, r.memo), ...nameAndClass(made, r) },
    ]);
  }
  return out;
}

interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  old_values: unknown;
  new_values: unknown;
}

async function auditRows(): Promise<AuditRow[]> {
  return rowsOf<AuditRow>(sql`
    SELECT id::text AS id, action::text AS action, entity_type, entity_id::text AS entity_id, old_values, new_values
      FROM audit_logs WHERE company_id = ${rich.ctx.companyId}`);
}

/** The fields an audit row changed, as the bridge's record diffs count them (before and after differ). */
function changedFields(row: Pick<AuditRow, 'old_values' | 'new_values'>): string[] {
  const oldV = asJson(row.old_values);
  const newV = asJson(row.new_values);
  const before = isObj(oldV) ? oldV : {};
  const after = isObj(newV) ? newV : {};
  const out: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[k] === undefined ? null : before[k];
    const a = after[k] === undefined ? null : after[k];
    if (stableJson(b) !== stableJson(a)) out.push(k);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

/** Ids in a description or memo: each run's own record gets an id of its own, so they are put aside. */
const words = (v: string | null) => (v ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
const lineText = (l: Line) =>
  `${l.account} Dr ${l.debit ?? '-'} Cr ${l.credit ?? '-'}${l.memo ? ` "${words(l.memo)}"` : ''}` +
  `${l.name === undefined ? '' : ` for ${l.name}`}${l.cls === undefined ? '' : ` class ${l.cls}`}`;
const entryText = (date: string, status: string | null, description: string | null, lines: Line[], refs?: { source: string; reference: string }) =>
  `${date}${status ? ` ${status}` : ''} "${words(description)}"${refs ? ` source ${refs.source} ref ${refs.reference}` : ''}: ${lines.map(lineText).sort().join('; ')}`;

/** What is in `a` and not in `b`, and the other way round, as multisets. */
function multisetDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const left = [...a];
  const onlyB: string[] = [];
  for (const x of b) {
    const i = left.indexOf(x);
    if (i >= 0) left.splice(i, 1);
    else onlyB.push(x);
  }
  return { onlyA: left, onlyB };
}

/** Two long texts cut to where they first differ, so a hint shows the difference and not a shared start. */
function around(a: string, b: string, width: number): [string, string] {
  if (a.length <= width && b.length <= width) return [a, b];
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  const cut = (s: string) => `${from > 0 ? '…' : ''}${s.slice(from, from + width)}${s.length > from + width ? '…' : ''}`;
  return [cut(a), cut(b)];
}

/**
 * Where two dry runs' previews differ, for a key that moved: the record values and ledger details
 * that are not the same (the ids each run made itself put aside), so the difference says what moves.
 */
function keyHint(a: BridgeResult, b: BridgeResult): string {
  const made = new Map<string, string>();
  const idsOf = (r: BridgeResult) => [...(r.preview?.records ?? []).map((x) => x.id), ...(r.preview?.ledger?.entries ?? []).map((e) => e.journalEntryId)];
  const bIds = new Set(idsOf(b).map((id) => id.toLowerCase()));
  const aIds = new Set(idsOf(a).map((id) => id.toLowerCase()));
  // An id only one run has is one that run made: the n-th such id of a kind stands for the same
  // record. Within a kind they are put in order of what they hold (ids blanked), not of the audit
  // trail (random), so two new accounts of one run pair with the same two of the other.
  const blank = (v: unknown) => JSON.stringify(v ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
  const own = (r: BridgeResult, other: Set<string>) => {
    const n = new Map<string, number>();
    const all = [
      ...(r.preview?.records ?? []).map((x) => [x.id, x.kind, blank(x.fields.filter((f) => !/(?:At|_at)$/.test(f.field)))] as const),
      ...(r.preview?.ledger?.entries ?? []).map((e) => [e.journalEntryId, 'journal_entry', blank(e.lines)] as const),
    ].sort((x, y) => x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]));
    for (const [id, kind] of all) {
      const k = id.toLowerCase();
      if (other.has(k) || made.has(k)) continue;
      const i = n.get(kind) ?? 0;
      n.set(kind, i + 1);
      made.set(k, `new:${kind}#${i}`);
    }
  };
  own(a, bIds);
  own(b, aIds);
  const swap = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) => made.get(m.toLowerCase()) ?? m));
  const out: string[] = [];
  // The audit trail's order is random (its ids are): records are matched by what they are.
  const sig = (r: RecordDiff) => `${r.action} ${r.kind} ${String(swap(r.id))}`;
  const byB = new Map<string, RecordDiff[]>();
  for (const r of b.preview?.records ?? []) byB.set(sig(r), [...(byB.get(sig(r)) ?? []), r]);
  const many = new Set((a.preview?.records ?? []).map(sig).filter((s, i, all) => all.indexOf(s) !== i));
  for (const s of byB.keys()) if ((byB.get(s)?.length ?? 0) > 1) many.add(s);
  for (const x of a.preview?.records ?? []) {
    // Two records alike (two new accounts, say) cannot be told apart in a random order: left out.
    if (many.has(sig(x))) continue;
    const y = byB.get(sig(x))?.shift();
    if (!y) {
      out.push(`${sig(x)} only in the first run`);
      continue;
    }
    const fy = new Map(y.fields.map((f) => [f.field, stableJson(swap(f.after))]));
    for (const f of x.fields) {
      // What the key leaves out itself (lib/agent/bridge.ts keyValue): a record's own id and times.
      if (f.field === 'id' || /(?:At|_at)$/.test(f.field)) continue;
      const ax = stableJson(swap(f.after));
      const by = fy.get(f.field) ?? '(none)';
      if (by !== ax) {
        const [l, r] = around(ax, by, 120);
        out.push(`${x.kind}.${f.field}: ${l} then ${r}`);
      }
    }
  }
  for (const [s, rest] of byB) if (!many.has(s)) for (const y of rest) out.push(`${sig(y)} only in the second run`);
  // The lines of an entry, and the entries, in an order of what they hold (ids blanked): the order
  // a preview lists them in is not the same from one run to the next (lines with the same entry
  // number and side go by their random ids), and the hint must point at what differs.
  const byContent = <T,>(list: readonly T[]) => [...list].sort((x, y) => blank(x).localeCompare(blank(y)));
  const ledgerOf = (r: BridgeResult) => byContent((r.preview?.ledger?.entries ?? []).map((e) => ({ ...e, journalEntryId: null, entryNumber: null, lines: byContent(e.lines) })));
  const ea = stableJson(swap(ledgerOf(a)));
  const eb = stableJson(swap(ledgerOf(b)));
  if (ea !== eb) {
    const [l, r] = around(ea, eb, 200);
    out.push(`ledger preview: ${l} then ${r}`);
  }
  return out.length ? ` (${out.slice(0, 6).join('; ')})` : ' (the previews agree: the difference is in what the key reads, not what it shows)';
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The values the approval card shows beside what the real run wrote, for each record the two name
 * alike (one record of its kind and action). A note, not a difference: the plan pins records and
 * fields. Put aside: masked values (the card hides them on purpose), times ("…At"), and ids in the
 * values that only one side has (each run's own new records). Records are named as in the
 * comparison: an id that run made itself is "(new)".
 */
function valueNotes(shown: readonly RecordDiff[], written: readonly AuditRow[], shownMade: ReadonlySet<string>, writtenMade: ReadonlySet<string>): string[] {
  const shownUuids = new Set(JSON.stringify(shown).toLowerCase().match(UUID_RE) ?? []);
  const writtenUuids = new Set(JSON.stringify(written.map((r) => [r.old_values, r.new_values])).toLowerCase().match(UUID_RE) ?? []);
  const norm = (v: unknown, other: ReadonlySet<string>) =>
    stableJson(JSON.parse(JSON.stringify(v ?? null).replace(UUID_RE, (m) => (other.has(m.toLowerCase()) ? m.toLowerCase() : '(new id)'))));
  const sigOfShown = (r: RecordDiff) => `${r.action} ${r.kind} ${idAs(shownMade, r.id)}`;
  const sigOfWritten = (r: AuditRow) => `${r.action} ${r.entity_type} ${idAs(writtenMade, r.entity_id)}`;
  const count = (sigs: string[]) => sigs.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map<string, number>());
  const shownCount = count(shown.map(sigOfShown));
  const writtenCount = count(written.map(sigOfWritten));
  const out: string[] = [];
  for (const r of shown) {
    const sig = sigOfShown(r);
    if (shownCount.get(sig) !== 1 || writtenCount.get(sig) !== 1) continue;
    const w = written.find((x) => sigOfWritten(x) === sig)!;
    const after = asJson(w.new_values);
    const before = asJson(w.old_values);
    for (const f of r.fields) {
      if (/(?:At|_at)$/.test(f.field)) continue;
      if (JSON.stringify([f.before, f.after]).includes('•')) continue;
      const a = norm(f.after, writtenUuids);
      const b = norm(isObj(after) ? (after[f.field] ?? null) : null, shownUuids);
      const a0 = norm(f.before, writtenUuids);
      const b0 = norm(isObj(before) ? (before[f.field] ?? null) : null, shownUuids);
      if (a !== b || a0 !== b0) out.push(`value: ${r.kind}.${f.field} shown ${a0.slice(0, 60)} -> ${a.slice(0, 60)}, written ${b0.slice(0, 60)} -> ${b.slice(0, 60)}`);
    }
  }
  return out;
}

/** Two amounts of the same size: the policy compares an amount by its size (lib/agent/policy.ts), so a sign is a note, not a difference. */
function sameAmount(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Money.eq(Money.abs(a), Money.abs(b));
}

async function parityOf(operation: Operation, input: OperationInput): Promise<Found> {
  const differences: string[] = [];
  const notes: string[] = [];
  let summary = '';
  const fp0 = await fingerprint();
  const before = await entries();
  const auditBefore = new Set((await auditRows()).map((r) => r.id));
  const accountsBefore = await accountIds();

  // 1. Two dry runs: nothing kept, the same key.
  h.madeLines = null;
  h.madeRefs = null;
  const dry = await run(operation, input, 'dry_run');
  // The name and class of every line the dry run made, and each entry's reference, read in its own
  // transaction (the mock of ./actions above): the preview does not carry them.
  const dryMadeLines = h.madeLines as MadeLine[] | null;
  const dryRefs = h.madeRefs as Map<string, string | null> | null;
  if (dry.outcome !== 'ok' || dry.error) {
    return { differences: [`the dry run did not run (${dry.outcome}, status ${dry.httpStatus}): ${JSON.stringify(dry.error ?? dry.warnings)}`], notes, summary };
  }
  differences.push(...fingerprintDifferences(fp0, await fingerprint(), 'the dry run'));
  const again = await run(operation, input, 'dry_run');
  if (again.outcome !== 'ok') differences.push(`the second dry run did not run: ${JSON.stringify(again.error ?? again.warnings)}`);
  differences.push(...fingerprintDifferences(fp0, await fingerprint(), 'the second dry run'));
  if (!dry.stalenessKey) differences.push('the dry run has no staleness key');
  else if (again.stalenessKey !== dry.stalenessKey) differences.push(`two dry runs in a row gave different staleness keys${keyHint(dry, again)}`);

  // 1b. The dry run an approval makes, as the approving person (tested on its own, below): it keeps
  // nothing either, and its key is the one the request stored, or the person is asked twice.
  const asApprover = await runOperation(approver, operation, input, 'dry_run', approverActor());
  differences.push(...fingerprintDifferences(fp0, await fingerprint(), "the approver's dry run"));
  const approverKey =
    asApprover.outcome !== 'ok' || asApprover.error
      ? `the approver's dry run did not run (${asApprover.outcome}, status ${asApprover.httpStatus}): ${JSON.stringify(asApprover.error ?? asApprover.warnings)}`
      : asApprover.stalenessKey !== dry.stalenessKey
        ? `the approver's dry run gave another staleness key than the agent's${keyHint(dry, asApprover)}`
        : null;

  if (!dry.preview?.ledger) {
    differences.push('the dry run has no ledger preview');
    return { differences, notes, summary, approverKey };
  }

  // Which ids in the dry run's sources and references name a row, read now: its own rows are
  // rolled back, so this is the books as they were before the runs.
  const dryRows = await idsThatNameARow(uuidsIn(...dry.preview.ledger.entries.flatMap((e) => [e.source, dryRefs?.get(e.journalEntryId.toLowerCase())])));

  // 2. The real run.
  const done: BridgeResult = await run(operation, input, 'commit');
  if (done.outcome !== 'ok' || done.error) {
    differences.push(`the dry run ran, but the real run did not (${done.outcome}, status ${done.httpStatus}): ${JSON.stringify(done.error ?? done.warnings)}`);
    return { differences, notes, summary, approverKey };
  }
  if (done.httpStatus !== dry.httpStatus) differences.push(`the dry run answered ${dry.httpStatus}, the real run ${done.httpStatus}`);
  const after = await entries();
  const madeIds = [...after.keys()].filter((id) => !before.has(id));
  const touchedIds = [...before.keys()].filter((id) => !after.has(id) || after.get(id)!.hash !== before.get(id)!.hash);
  const written = (await auditRows()).filter((r) => !auditBefore.has(r.id));
  const shownMade = dry.preview.ledger.entries.filter((e) => !before.has(e.journalEntryId.toLowerCase()));
  const shownTouched = dry.preview.ledger.entries.filter((e) => before.has(e.journalEntryId.toLowerCase()));
  // What each run made itself, the rule of the bridge's staleness key (stalenessKeyOf): the records
  // it wrote an audit 'create' for, and the ledger entries it made. Each run makes its own, with
  // ids of its own, so those ids are written "(new)"; every other id is compared as it is.
  const dryMade = new Set([
    ...dry.preview.records.filter((r) => r.action === 'create').map((r) => r.id.toLowerCase()),
    ...shownMade.map((e) => e.journalEntryId.toLowerCase()),
  ]);
  const commitMade = new Set([...written.filter((r) => r.action === 'create').map((r) => r.entity_id.toLowerCase()), ...madeIds]);
  const lines = await linesOf([...madeIds, ...touchedIds.filter((id) => after.has(id))], accountsBefore, commitMade);
  const shownTo = { access: actor().access };

  // 3. The ledger: entries made.
  const norm = (ls: Array<{ accountId: string; accountCode: string | null; accountName: string; debit: string | null; credit: string | null; memo: string | null }>): Line[] =>
    ls.map((l) => ({ account: accountOf(accountsBefore, l.accountId, l.accountCode, l.accountName), debit: amount(l.debit), credit: amount(l.credit), memo: l.memo }));
  // The dry run's lines of one entry, with the name and class its transaction held (in the order
  // changesInTransaction lists them, which is the preview's order).
  const dryNames = new Map<string, MadeLine[]>();
  for (const l of dryMadeLines ?? []) dryNames.set(l.entry_id.toLowerCase(), [...(dryNames.get(l.entry_id.toLowerCase()) ?? []), l]);
  const shownLines = (e: (typeof shownMade)[number]): Line[] =>
    norm(e.lines).map((l, i) => {
      const held = dryNames.get(e.journalEntryId.toLowerCase())?.[i];
      return { ...l, ...(held ? nameAndClass(dryMade, held) : { name: '(not read)', cls: '(not read)' }) };
    });
  // Which ids in the real run's sources and references name a row: a row it wrote with no audit
  // 'create' still does, so its id is compared as it is (where the dry run's, rolled back, is
  // "(new)"): such a row then shows as a difference, never hidden.
  const commitRows = await idsThatNameARow(uuidsIn(...madeIds.flatMap((id) => [after.get(id)!.source, after.get(id)!.reference])));
  const shownRefs = (e: (typeof shownMade)[number]) => {
    const id = e.journalEntryId.toLowerCase();
    return {
      source: refText(e.source, dryMade, dryRows, e.entryNumber),
      reference: dryRefs?.has(id) ? refText(dryRefs.get(id) ?? null, dryMade, dryRows, e.entryNumber) : '(not read)',
    };
  };
  const madeRefs = (id: string) => {
    const a = after.get(id)!;
    return { source: refText(a.source, commitMade, commitRows, a.entryNumber), reference: refText(a.reference, commitMade, commitRows, a.entryNumber) };
  };
  const made = multisetDiff(
    shownMade.map((e) => entryText(e.date, e.status, e.description, shownLines(e), shownRefs(e))),
    madeIds.map((id) => entryText(after.get(id)!.date, after.get(id)!.status, lineMemoFor(shownTo, after.get(id)!.description), lines.get(id) ?? [], madeRefs(id))),
  );
  for (const e of made.onlyA) differences.push(`ledger: the dry run shows a new entry the real run did not post: ${e}`);
  for (const e of made.onlyB) differences.push(`ledger: the real run posted a new entry the dry run did not show: ${e}`);
  const numbers = multisetDiff(
    shownMade.map((e) => String(e.entryNumber)),
    madeIds.map((id) => String(after.get(id)!.entryNumber)),
  );
  if (numbers.onlyA.length || numbers.onlyB.length) {
    notes.push(`entry numbers: the dry run showed ${numbers.onlyA.join(', ') || '-'}, the real run used ${numbers.onlyB.join(', ') || '-'}`);
  }

  // 4. The ledger: entries that existed, voided, deleted or changed.
  const shownIds = new Set(shownTouched.map((e) => e.journalEntryId.toLowerCase()));
  for (const id of touchedIds) if (!shownIds.has(id)) differences.push(`ledger: the real run changed entry ${id} (${before.get(id)!.status}), the dry run did not show it`);
  for (const e of shownTouched) {
    const id = e.journalEntryId.toLowerCase();
    if (!touchedIds.includes(id)) {
      differences.push(`ledger: the dry run shows entry ${id} as ${JSON.stringify(e.description)}, the real run left it as it was`);
      continue;
    }
    const now = after.get(id);
    const status = now ? now.status : 'deleted';
    if (e.status !== status) differences.push(`ledger: entry ${id} is ${status} after the real run, the dry run showed ${e.status}`);
    if (now) {
      // The preview names what the run did to it ("Voided by this request: …"); the lines are
      // compared (its status just above). The name and class of a line that already existed are
      // not: the dry run's side of them cannot be read (they are not in the preview).
      const shown = entryText(e.date, null, null, norm(e.lines));
      const real = entryText(now.date, null, null, (lines.get(id) ?? []).map(({ name: _n, cls: _c, ...l }) => l));
      if (shown !== real) differences.push(`ledger: entry ${id} after the real run is ${real}, the dry run showed ${shown}`);
    }
  }

  // 5. The records: the same records and fields as every audit row the real run wrote.
  const shownRecords = dry.preview.records.map((r) => `${r.action} ${r.kind} ${idAs(dryMade, r.id)} [${r.fields.map((f) => f.field).sort().join(', ')}]`);
  const auditRecords = written.map((r) => `${r.action} ${r.entity_type} ${idAs(commitMade, r.entity_id)} [${changedFields(r).join(', ')}]`);
  const recs = multisetDiff(shownRecords, auditRecords);
  for (const r of recs.onlyA) differences.push(`records: the dry run shows ${r}, the real run wrote no such audit row`);
  for (const r of recs.onlyB) differences.push(`records: the real run wrote ${r}, the dry run did not show it`);
  // A preview with nothing in it (no entry, no record) for a run that keeps rows: the card shows
  // a person nothing of what they approve. The agent's own bookkeeping tables are put aside.
  if (!dry.preview.records.length && !dry.preview.ledger.entries.length) {
    const fpDone = await fingerprint();
    const kept = Object.keys(fp0.tables).filter((t) => fp0.tables[t] !== fpDone.tables[t] && t !== 'audit_logs' && !t.startsWith('agent'));
    if (kept.length) {
      differences.push(`records: the dry run shows nothing, the real run changed ${kept.map((t) => `${t} (${fp0.tables[t].split(',')[0]} -> ${fpDone.tables[t].split(',')[0]})`).join(', ')} and wrote no audit row`);
    }
  }
  notes.push(...valueNotes(dry.preview.records, written, dryMade, commitMade));

  // 6. The amount: what the real run posted.
  const madeTotals = madeIds.map((id) => after.get(id)!.total);
  const touchedCounted = touchedIds
    .filter((id) => before.get(id)!.status === 'posted' || after.get(id)?.status === 'posted')
    .map((id) => (after.get(id) ?? before.get(id)!).total);
  const all = [...madeTotals, ...touchedCounted];
  const largest = all.length ? all.reduce((m, t) => (Money.gt(t, m) ? t : m)) : null;
  const sumMade = Money.add(...madeTotals);
  const sumTouched = Money.add(...touchedCounted);
  // It voided, deleted or changed a record that was there before it: an audit row other than
  // 'create' of a record it did not make.
  const editsExisting = written.some((r) => r.action !== 'create' && !commitMade.has(r.entity_id.toLowerCase()));
  const noEntry = !madeIds.length && !touchedIds.length;
  const posted = operation.amountField
    ? largest === null
      ? null
      : toAmountString(largest)
    : !noEntry
      ? toAmountString(sumMade.greaterThan(sumTouched) ? sumMade : sumTouched)
      : editsExisting
        ? null
        : '0.00';
  if (!sameAmount(dry.facts.amount, done.facts.amount)) differences.push(`amount: the dry run says ${dry.facts.amount}, the real run ${done.facts.amount}`);
  // Decided (fail closed): with no amount field and no entry, a run that changed what was there
  // before has an unknown amount, never "0.00".
  if (!operation.amountField && noEntry && editsExisting && dry.facts.amount !== null) {
    differences.push(`amount: the dry run says ${dry.facts.amount}; the real run changed a record that was there before and posted nothing, so the amount must be unknown`);
  }
  if (dry.facts.amount !== null && Money.isNegative(dry.facts.amount)) {
    notes.push(`amount sign: the facts say ${dry.facts.amount} (the answer's own signed figure); the policy reads its size, the card shows the sign`);
  }
  if (dry.facts.amount === null && operation.amountField) {
    notes.push(`amount unknown: amountField "${operation.amountField}" could not be read (fail closed); the real run posted ${posted ?? 'no entry'}`);
  } else if (posted !== null && !sameAmount(dry.facts.amount, posted)) {
    differences.push(`amount: the dry run says ${dry.facts.amount}, the real run posted ${posted}`);
  }
  summary = `${madeIds.length} entries made, ${touchedIds.length} changed, ${written.length} audit rows, amount ${dry.facts.amount}`;
  return { differences, notes, summary, approverKey };
}

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  rich = await seedRichCompany(db, TEST_DIR, 'Parity Co');
  const owner: ServiceContext = { ...rich.ctx, role: 'owner' };
  const made = await createAgent(owner, { name: 'Parity Agent', roleKeys: ['full_access'], preset: 'trusted_bookkeeper' });
  agentId = made.agent.id;
  // As the door loads them for the agent's own run (openDoor, lib/agent/operate.ts).
  ceiling = await agentCeiling(owner, agentId);
  policy = await loadAgentPolicy(owner, agentId);
  agentBase = {
    db: readOnlyDb(db),
    companyId: rich.ctx.companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access: agentDirectAccess(ceiling.access),
    agent: { id: agentId, name: 'Parity Agent', mode: 'post', preset: policy.preset, onBehalfOf: rich.ctx.userId },
    readOnly: true,
  };
  // Dana approves: a person of the company other than the one who made the agent (the agent's own
  // runs are on behalf of its maker, lib/agentContext.ts), as in any office of more than one.
  const [dana] = await db.insert(users).values({ email: `dana-${randomUUID()}@parity.test`, name: 'Dana Approver', passwordHash: 'x' }).returning();
  await db.insert(userCompanies).values({ userId: dana.id, companyId: rich.ctx.companyId, role: 'accountant', isActive: true });
  await db.insert(userRoleAssignments).values({ companyId: rich.ctx.companyId, userId: dana.id, roleKey: 'full_access' });
  const danaAccess = await resolveAccess(db, rich.ctx.companyId, dana.id);
  approver = { db, companyId: rich.ctx.companyId, userId: dana.id, access: danaAccess.access, role: legacyRoleFor(danaAccess.access, danaAccess.isOwner) };
  approverCeiling = await agentCeiling(approver, agentId);
  tableNames = (
    await rowsOf<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`,
    )
  ).map((r) => r.table_name);
  idTables = (
    await rowsOf<{ table_name: string }>(
      sql`select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
           where c.table_schema = current_schema() and t.table_type = 'BASE TABLE' and c.column_name = 'id' and c.data_type = 'uuid' order by c.table_name`,
    )
  ).map((r) => r.table_name);
  const tools: ParityTools = {
    acct: rich.acct,
    customerId: rich.customerId,
    vendorId: rich.vendorId,
    commit: async (id, input) => {
      const r = await run(op(id), input, 'commit');
      if (r.outcome !== 'ok' || r.error) throw new Error(`Setting up with ${id} did not run: ${JSON.stringify(r.error ?? r.warnings)}`);
      return (isObj(r.result) ? r.result : {}) as Obj;
    },
    idsWhere: async (table, column, value) => {
      if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error(`Not a table and column: ${table}.${column}`);
      // Compared as text, so a flag ('true') or an id is written the same way.
      const rows = await rowsOf<{ id: string }>(sql`SELECT id::text AS id FROM ${sql.raw(`"${table}"`)} WHERE ${sql.raw(`"${column}"`)}::text = ${value} ORDER BY id`);
      return rows.map((r) => r.id);
    },
    valueOf: async (table, id, column) => {
      if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error(`Not a table and column: ${table}.${column}`);
      const [row] = await rowsOf<{ v: string | null }>(sql`SELECT ${sql.raw(`"${column}"`)}::text AS v FROM ${sql.raw(`"${table}"`)} WHERE id = ${id}`);
      return row?.v ?? null;
    },
    itemIdByName: async (name) => {
      const [found] = await db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.companyId, rich.ctx.companyId), eq(items.name, name)));
      if (!found) throw new Error(`No item named ${name}`);
      return found.id;
    },
  };
  world = await buildParityWorld(tools);
}, 240_000);

afterAll(async () => {
  // PARITY_REPORT=<file>: every case's summary, differences and notes, written to that file.
  if (process.env.PARITY_REPORT) {
    const lines = report.map((r) =>
      [
        `### ${r.name}: ${r.summary}`,
        ...r.differences.map((d) => `  DIFF ${d}`),
        ...(r.approverKey ? [`  APPROVER ${r.approverKey}`] : []),
        ...r.notes.map((n) => `  NOTE ${n}`),
      ].join('\n'),
    );
    fs.writeFileSync(path.resolve(process.env.PARITY_REPORT), `${[...coverage, '', ...lines].join('\n')}\n`);
  }
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe('the parity cases', () => {
  it('cover at least 40 enter and change operations, each one an agent operation whose dry run is really run', () => {
    const ids = new Set(PARITY_CASES.map((c) => c.operation));
    expect(ids.size).toBeGreaterThanOrEqual(40);
    // What is in scope (an agent's enter or change route whose dry run is really run) and what is
    // not ('preview' and 'none' operations are described, not run): written at the top of the report.
    const enterOrChange = allOperations().filter((o) => (o.class === 'enter' || o.class === 'change') && o.availability === 'agent');
    const inScope = enterOrChange.filter((o) => o.kind === 'route' && o.dryRun === 'transaction');
    const outOfScope = enterOrChange.filter((o) => !(o.kind === 'route' && o.dryRun === 'transaction'));
    const uncovered = inScope.filter((o) => !ids.has(o.id));
    coverage = [
      `${ids.size} of ${inScope.length} enter / change operations whose dry run is really run have a case (${PARITY_CASES.length} cases).`,
      `Out of scope, dry run not really run: ${outOfScope.length} (${outOfScope.map((o) => `${o.id} ${o.dryRun}`).join(', ')}).`,
      `Without a case yet: ${uncovered.map((o) => o.id).join(', ') || 'none'}.`,
    ];
    // In the test's own output too, so what still has no case is seen without PARITY_REPORT.
    console.info(`Dry-run parity: ${coverage.join(' ')}`);
    for (const id of ids) {
      const o = op(id);
      expect(['enter', 'change'], id).toContain(o.class);
      expect(o.dryRun, id).toBe('transaction');
      expect(o.availability, id).toBe('agent');
      expect(o.kind, id).toBe('route');
    }
    const names = PARITY_CASES.map((c) => `${c.operation}${c.label ? ` (${c.label})` : ''}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the comparison itself', () => {
  it('catches a real run that posts and writes more than its dry runs showed, and a key that moves', async () => {
    let calls = 0;
    h.handler = async () => {
      calls++;
      const ctx = await getServerContext();
      // The dry runs (the agent's two and the approver's) post 100.00; the real run (the fourth
      // call) posts 150.00 and writes one more audit row.
      const dryCall = calls <= 3;
      const amt = dryCall ? '100.00' : '150.00';
      const entry = await postJournalEntry(ctx, {
        date: new Date('2026-03-05'),
        description: 'Parity probe',
        lines: [
          { accountId: rich.acct['6300'], debit: amt },
          { accountId: rich.acct['1000'], credit: amt },
        ],
      });
      await writeAudit(ctx, { action: 'create', entityType: 'parity_probe', entityId: randomUUID(), newValues: { note: dryCall ? 'shown' : 'only for real', run: calls } });
      if (!dryCall) await writeAudit(ctx, { action: 'create', entityType: 'parity_probe_extra', entityId: randomUUID(), newValues: { note: 'never shown' } });
      return NextResponse.json({ id: entry.id }, { status: 201 });
    };
    try {
      const found = await parityOf(op('journal-entries.create'), { body: { date: '2026-03-05', description: 'Parity probe', lines: [] } });
      const all = found.differences.join('\n');
      expect(calls).toBe(4);
      expect(all).toMatch(/two dry runs in a row gave different staleness keys \(parity_probe\.run: 1 then 2\)/);
      expect(all).toMatch(/the dry run shows a new entry the real run did not post: .*Dr 100\.00/);
      expect(all).toMatch(/the real run posted a new entry the dry run did not show: .*Dr 150\.00/);
      expect(all).toMatch(/the real run wrote create parity_probe_extra \(new\)/);
      expect(all).toMatch(/amount: the dry run says 100\.00, the real run posted 150\.00/);
      expect(found.notes.join('\n')).toMatch(/value: parity_probe\.note shown null -> "shown", written null -> "only for real"/);
      expect(found.approverKey).toMatch(/the approver's dry run gave another staleness key than the agent's \(parity_probe\.run: 1 then 3\)/);
    } finally {
      h.handler = null;
    }
  });

  it('catches a real run that changes another record than the one its dry runs showed', async () => {
    // Two customers that existed before the runs: the dry runs change one, the real run the other.
    const other = await world.make('customers.create', { body: { displayName: world.unique('Other customer') } });
    let calls = 0;
    h.handler = async () => {
      calls++;
      const ctx = await getServerContext();
      const id = calls <= 3 ? rich.customerId : other;
      await writeAudit(ctx, { action: 'update', entityType: 'customer', entityId: id, oldValues: { phone: null }, newValues: { phone: '555-0199' } });
      return NextResponse.json({ ok: true }, { status: 200 });
    };
    try {
      const found = await parityOf(op('journal-entries.create'), { body: { date: '2026-03-05', description: 'Parity probe', lines: [] } });
      expect(calls).toBe(4);
      expect(found.approverKey).toBeNull();
      expect(found.differences).toEqual([
        `records: the dry run shows update customer ${rich.customerId.toLowerCase()} [phone], the real run wrote no such audit row`,
        `records: the real run wrote update customer ${other.toLowerCase()} [phone], the dry run did not show it`,
      ]);
      // Both change a record that was there before and post nothing: the amount is unknown (a
      // decision of this feature), so it is no third difference.
      expect(found.summary).toMatch(/, amount null$/);
    } finally {
      h.handler = null;
    }
  });

  it('catches a real run that posts a line for another name or class than its dry runs showed', async () => {
    const other = await world.make('customers.create', { body: { displayName: world.unique('Other customer') } });
    const classId = await world.make('classes.create', { body: { name: world.unique('Probe class') } });
    let calls = 0;
    h.handler = async () => {
      calls++;
      const ctx = await getServerContext();
      const dryCall = calls <= 3;
      const entry = await postJournalEntry(ctx, {
        date: new Date('2026-03-05'),
        description: 'Parity probe',
        lines: [
          { accountId: rich.acct['1200'], debit: '40.00', entityType: 'customer', entityId: dryCall ? rich.customerId : other },
          { accountId: rich.acct['4000'], credit: '40.00', classId: dryCall ? null : classId },
        ],
      });
      return NextResponse.json({ id: entry.id }, { status: 201 });
    };
    try {
      const found = await parityOf(op('journal-entries.create'), { body: { date: '2026-03-05', description: 'Parity probe', lines: [] } });
      expect(calls).toBe(4);
      const shown = found.differences.filter((d) => d.startsWith('ledger: the dry run shows a new entry the real run did not post: '));
      const posted = found.differences.filter((d) => d.startsWith('ledger: the real run posted a new entry the dry run did not show: '));
      expect(shown).toHaveLength(1);
      expect(posted).toHaveLength(1);
      expect(shown[0]).toContain(`for customer ${rich.customerId.toLowerCase()} class -`);
      expect(posted[0]).toContain(`for customer ${other.toLowerCase()} class -`);
      expect(posted[0]).toContain(`class ${classId.toLowerCase()}`);
      expect(shown[0]).not.toContain(classId.toLowerCase());
      // Same accounts and amounts: only the name and the class differ.
      expect(found.differences.filter((d) => d.startsWith('amount'))).toEqual([]);
    } finally {
      h.handler = null;
    }
  });

  it('catches a real run whose new entry names another record in its source or reference; its own and made-up ids are put aside', async () => {
    const other = await world.make('customers.create', { body: { displayName: world.unique('Other customer') } });
    let calls = 0;
    h.handler = async () => {
      calls++;
      const ctx = await getServerContext();
      const named = calls <= 3 ? rich.customerId : other;
      // A record of the run's own (an audit 'create'), whose first 8 hex digits are the reference,
      // and an id made up by the run in the source: each run has its own, which is not a difference.
      const own = randomUUID();
      await writeAudit(ctx, { action: 'create', entityType: 'parity_probe', entityId: own, newValues: { note: 'probe' } });
      const entry = await postJournalEntry(ctx, {
        date: new Date('2026-03-05'),
        description: 'Parity probe',
        sourceRef: `probe:${randomUUID()}:${named}`,
        reference: `${own.slice(0, 8)} for ${named}`,
        lines: [
          { accountId: rich.acct['6300'], debit: '10.00' },
          { accountId: rich.acct['1000'], credit: '10.00' },
        ],
      });
      return NextResponse.json({ id: entry.id }, { status: 201 });
    };
    try {
      const found = await parityOf(op('journal-entries.create'), { body: { date: '2026-03-05', description: 'Parity probe', lines: [] } });
      expect(calls).toBe(4);
      const a = rich.customerId.toLowerCase();
      const b = other.toLowerCase();
      expect(found.differences).toEqual([
        expect.stringMatching(new RegExp(`^ledger: the dry run shows a new entry the real run did not post: .* source probe:\\(new\\):${a} ref \\(new\\) for ${a}: `)),
        expect.stringMatching(new RegExp(`^ledger: the real run posted a new entry the dry run did not show: .* source probe:\\(new\\):${b} ref \\(new\\) for ${b}: `)),
      ]);
    } finally {
      h.handler = null;
    }
  });

  it('a run that only makes new records and posts nothing has the amount 0.00, and no difference', async () => {
    h.handler = async () => {
      const ctx = await getServerContext();
      await writeAudit(ctx, { action: 'create', entityType: 'parity_probe', entityId: randomUUID(), newValues: { note: 'new' } });
      return NextResponse.json({ ok: true }, { status: 201 });
    };
    try {
      const found = await parityOf(op('journal-entries.create'), { body: { date: '2026-03-05', description: 'Parity probe', lines: [] } });
      expect(found.differences).toEqual([]);
      expect(found.approverKey).toBeNull();
      expect(found.summary).toMatch(/^0 entries made, 0 changed, 1 audit rows, amount 0\.00$/);
    } finally {
      h.handler = null;
    }
  });

  it("the approver's dry run runs as that person, and keeps the agent's key when the run writes the same", async () => {
    const contexts: ServiceContext[] = [];
    h.handler = async () => {
      contexts.push(await getServerContext());
      return NextResponse.json({ ok: true }, { status: 200 });
    };
    try {
      const found = await parityOf(op('journal-entries.create'), { body: { date: '2026-03-05', description: 'Nothing done', lines: [] } });
      expect(found.differences).toEqual([]);
      expect(found.approverKey).toBeNull();
      // The agent's two dry runs, the approver's, then the real run (the agent's own again).
      expect(contexts.map((c) => c.userId)).toEqual([null, null, approver.userId, null]);
      expect(contexts[2].approval?.approvedBy).toBe(approver.userId);
      expect(contexts[2].agent?.onBehalfOf).toBe(approver.userId);
    } finally {
      h.handler = null;
    }
  });

  it('a mark holds exactly the differences found: a fix, or a difference of another kind, fails it', () => {
    expect(() => expectExactly(['two dry runs in a row gave different staleness keys (x)'], [/^two dry runs/])).not.toThrow();
    // Fixed: the mark has to come off.
    expect(() => expectExactly([], [/^two dry runs/])).toThrow();
    // A new difference beside the known one.
    expect(() => expectExactly(['two dry runs in a row gave different staleness keys (x)', 'amount: the dry run says 1.00, the real run posted 2.00'], [/^two dry runs/])).toThrow();
  });

  it('a fingerprint sees one row changed in any table', async () => {
    const before = await fingerprint();
    const [row] = await rowsOf<{ id: string }>(sql`UPDATE customers SET notes = 'parity check' WHERE id = ${rich.customerId} RETURNING id::text AS id`);
    expect(row.id).toBe(rich.customerId);
    try {
      expect(fingerprintDifferences(before, await fingerprint(), 'the check')).toEqual([expect.stringMatching(/^the check changed table customers: /)]);
    } finally {
      await db.execute(sql`UPDATE customers SET notes = NULL WHERE id = ${rich.customerId}`);
    }
  });
});

/** Each case's run, by name: made once, by whichever of its two tests comes first. */
const caseRuns = new Map<string, Promise<Found>>();

const caseName = (c: ParityCase) => `${c.area}: ${c.operation}${c.label ? ` (${c.label})` : ''}`;

/**
 * What a case found: its fixture built and its parity run made the first time it is asked for, the
 * same answer after. A fixture that throws fails both of the case's tests. Run alone (vitest -t),
 * the approver's test makes the run itself.
 */
function caseRun(c: ParityCase): Promise<Found> {
  const name = caseName(c);
  let found = caseRuns.get(name);
  if (!found) {
    found = (async () => {
      const result = await parityOf(op(c.operation), await c.input(world));
      report.push({ name, ...result });
      return result;
    })();
    caseRuns.set(name, found);
  }
  return found;
}

/**
 * Exactly the differences a mark expects: each one found is matched by a pattern of the mark, and
 * each pattern matches one found. A fix (a pattern matched by nothing) or a difference of another
 * kind (one no pattern matches) fails, so the mark is brought up to date when what differs changes.
 */
function expectExactly(found: readonly string[], expected: readonly RegExp[]): void {
  const unexpected = found.filter((d) => !expected.some((re) => re.test(d)));
  const notFound = expected.filter((re) => !found.some((d) => re.test(d))).map(String);
  expect({ unexpected, notFound }, `what was found:\n${found.join('\n') || '(nothing)'}`).toEqual({ unexpected: [], notFound: [] });
}

describe('dry-run parity: the dry run shows what the real run does, and keeps nothing', () => {
  for (const c of PARITY_CASES) {
    // A case marked `fails` holds the patterns of what differs (test/helpers/agentParityFixtures.ts).
    it(
      c.fails ? `${caseName(c)} [known differences]` : caseName(c),
      async () => {
        const found = await caseRun(c);
        if (c.fails) expectExactly(found.differences, c.fails);
        else expect(found.differences, found.differences.join('\n')).toEqual([]);
      },
      240_000,
    );
  }
});

/**
 * Plan §7.4: an approval runs the request dry again, as the approving person, and compares its key
 * with the one the agent's dry run stored. Where they differ for a request nobody else touched,
 * the person is told the books changed and must say yes a second time, on every request of that
 * operation. Each case reads what its own parity run found (caseRun). A case marked
 * `approverFails` holds the pattern of what differs, and is checked to differ in just that way.
 */
describe("the approver's dry run gives the key the agent's request stored", () => {
  for (const c of PARITY_CASES) {
    it(
      c.approverFails ? `${caseName(c)} [known difference]` : caseName(c),
      async () => {
        const found = await caseRun(c);
        expect(found.approverKey, `the parity run stopped before the approver's dry run ran:\n${found.differences.join('\n')}`).not.toBeUndefined();
        // "(the keys agree)" for null, so a mark whose difference is gone fails with words, not a type error.
        if (c.approverFails) expect(found.approverKey ?? '(the keys agree)').toMatch(c.approverFails);
        else expect(found.approverKey).toBeNull();
      },
      240_000,
    );
  }
});
