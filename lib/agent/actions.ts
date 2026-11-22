/**
 * The curated actions (AGENT_ACCESS.md): a fixed catalog of named changes and reads
 * ("enter_invoice", "void_check", "finish_reconciliation" …, lib/agent/catalog.ts and banking.ts),
 * sent to POST /api/agent/actions as `{ action, input, dryRun?, requestId?, reason? }`.
 *
 * There is one path for everything an agent does: the agent's door (lib/agent/operate.ts). Each
 * action names the route a person uses for the same thing (`route`), which is one operation of the
 * registry, and is a thin wrapper round that operation:
 *
 *  0. the request is counted as one of the agent's calls before anything is read for it, as the
 *     door counts a verb: an agent over its limit gets the door's "slow down" (429 with
 *     Retry-After) and nothing else;
 *  1. its input is checked with the action's own schema (the fields the curated tools send);
 *  2. the input is turned into the route's own request: path parameters, query and body
 *     (`request`), and the version of the record the agent last read (expectedUpdatedAt), which
 *     the route alone compares, inside the transaction that commits, so a stale request is
 *     answered exactly as run_operation answers it;
 *  3. a check of the action's own, where it has one (no opening stock on a new item), runs only
 *     once the policy has had its say. A request the policy or the agent's role refuses is refused
 *     first, exactly as run_operation refuses it, so a refusal never says who last changed a
 *     record, or whether it exists;
 *  4. that request goes through the door as the run_operation verb itself (handleVerb), with the
 *     agent's request id, the dry run flag and its reason (the agent's own words; the placeholder
 *     NO_REASON_GIVEN only when the request has no reason field at all). The policy, standing
 *     permission, the route bridge, dry runs, request ids, permission requests and the "slow
 *     down" are all the door's, so a curated action can never do what run_operation would not;
 *  5. the door's answer comes back in the action's words (`answer`: documentResult and friends).
 *     A refusal keeps the door's own words: the action's one-line summary, which may name a
 *     customer, vendor, account or bank, is made only for work the door looked at.
 *
 * The outcomes are the door's: 'read', 'dry_run', 'posted', 'done', 'asked' (a person must approve
 * it in the approval center first), 'needs_confirmation' and 'refused'. Nothing is put in the old
 * approval queue (ai_proposals) any more; an answer stored under a request id before this may still
 * say 'proposed', and is given again as it was.
 *
 * Two kinds of action keep a run of their own (`runs`):
 *  - 'own': the route does more than the action does (it refreshes a stored model or posts lines
 *    the AI is sure of), so the action runs its own narrower service call. It is decided by the
 *    policy for its route's operation exactly as the door decides it; a refusal is the door's own.
 *    When the policy says Ask, or standing permission would cover it, the request goes through the
 *    door as that operation, so a person approves (or gave permission for) what the route itself
 *    does. Its own run counts against the agent's calls a minute and takes one of its places at
 *    once, as a run through the door does.
 *  - 'self': the agent's own requests (list_my_proposals), which is what the list_my_requests verb
 *    answers.
 *
 * Requests copied from the old approval queue are still entered the old way, under the approving
 * person's permissions, by runApprovedAgentAction, which only the approval center calls
 * (lib/services/agentRequests.ts).
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getDb, type DB } from '@/lib/db';
import { agentRequests, aiProposals, companies } from '@/lib/db/schema';
import { blockingFeatureGate, resolveCompanyPreferences } from '@/lib/preferences';
import { featureOffError } from '@/lib/featureGate';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { legacyRoleFor } from '@/lib/permissions/model';
import { assertAccountantCopyAllowsPath } from '@/lib/services/accountantCopy/routeGate';
import { lineMemoFor, resolveEntityNames } from '@/lib/services/journal';
import { type ServiceContext, ServiceError, translateLedgerDbError, validation } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { toDecimal, type MoneyInput } from '@/lib/money';
import type { EffectReport } from '@/lib/effects';
import { operationForRoute } from './operations/registry';
import type { AgentOperationAnswer, AgentOutcome, OperationInput, OperationPreview, StagedFile } from './contract';
import type { ApprovalNeeds, Operation, RequestStatus, WarningPreview } from './operations/types';

export type AgentActionMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What the action's answer hook knows besides the route's answer. */
export interface ActionAnswerContext {
  /** The agent's own (read-only) context: for a follow-up read through the door, nothing else. */
  ctx: ServiceContext;
  outcome: AgentOutcome;
}

export interface AgentActionDef<I = unknown> {
  /** The action's name, as the agent's tool sends it ("enter_invoice"). */
  name: string;
  /**
   * What the action does to the books, as a description: 'read' looks only, 'prepare' lays work out
   * without touching the ledger, 'write' changes the books. The policy decides by the route's
   * operation, not by this. Only a 'write' copied from the old approval queue can still be entered
   * by runApprovedAgentAction.
   */
  kind: 'read' | 'prepare' | 'write';
  /**
   * The route a person uses for the same thing: one operation of the registry
   * (lib/agent/operations/registry.ts operationForRoute). It is what the policy decides by.
   */
  route: { path: string; method: AgentActionMethod };
  schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** One line saying what this request is, for the agent's answer. */
  describe: (ctx: ServiceContext, input: I) => string | Promise<string>;
  /**
   * The service call itself. Used by the actions that run themselves (`runs` 'own' or 'self'), and
   * by runApprovedAgentAction for requests copied from the old approval queue.
   */
  run: (ctx: ServiceContext, input: I) => Promise<unknown>;
  /**
   * The same request to the route, in the route's own words: its path parameters, query and body
   * (lib/agent/contract.ts OperationInput). Left out: the input is the body.
   */
  request?: (input: I) => OperationInput;
  /** The route's answer in this action's words (documentResult and friends). Left out: as the route answered. */
  answer?: (routeAnswer: unknown, input: I, how: ActionAnswerContext) => unknown;
  /**
   * A check of the action's own before the request is sent: something the route accepts and the
   * action does not (opening stock on a new item). It runs only when the policy does not refuse the
   * request (see the top of this file). Never the version of a record: the route compares that
   * itself, and a check here could answer differently from run_operation (lib/agent/catalog.ts).
   */
  check?: (ctx: ServiceContext, input: I) => Promise<void>;
  /** 'door' (the default): through the agent's door. 'own' and 'self': see the top of this file. */
  runs?: 'door' | 'own' | 'self';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAction = AgentActionDef<any>;

/** The catalog, set once by lib/agent/catalog.ts (kept out of this file to avoid import cycles). */
const registry = new Map<string, AnyAction>();

export function registerAgentActions(defs: ReadonlyArray<AnyAction>): void {
  for (const d of defs) registry.set(d.name, d);
}

export function agentActionNames(): string[] {
  return [...registry.keys()].sort();
}

export function agentAction(name: unknown): AnyAction | null {
  return typeof name === 'string' ? (registry.get(name) ?? null) : null;
}

/**
 * @deprecated The policy decides now, and its refusal says why (lib/agent/policy.ts). Kept for
 * callers that still name it.
 */
export const READ_ONLY_AGENT_MESSAGE =
  'This agent can only read. To enter transactions, an Admin changes what it may do in Users & Roles > Agents.';
export const REQUEST_ID_MESSAGE =
  'Give a request_id: any text of your own, unique to this change (for example "inv-acme-2026-03-01-a"). Asking again with the same request_id never enters the change twice.';

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{2,119}$/;
const REQUEST_ID_MAX = 200;
const REASON_MAX = 500;

/** A line of the ledger an action would post, or posted. */
export interface PostingLine {
  accountId: string;
  accountCode: string | null;
  accountName: string;
  debit: string | null;
  credit: string | null;
  /** As the caller may see it (lib/services/journal.ts lineMemoFor). */
  memo: string | null;
  /**
   * The customer, vendor, employee or other name the line is for, when it names one. As the caller
   * may see it, like the memo: a name is typed text too.
   */
  entityName: string | null;
  /**
   * The class of the line, when it has one, as the caller may see it. Optional only because what
   * was stored before lines carried it (an answer kept under a request id, a preview a request
   * holds, a proposal still waiting in the old approval queue) has none; every line made now has it.
   */
  className?: string | null;
}
export interface PostingEntry {
  journalEntryId: string;
  entryNumber: number | null;
  date: string;
  description: string | null;
  status: string;
  source: string | null;
  lines: PostingLine[];
}
/** What a change did, or would do: the ledger entries, and every record it touched. */
export interface ChangePreview {
  entries: PostingEntry[];
  changes: { action: string; kind: string; id: string }[];
}

/**
 * The answer to a curated action: the door's answer (lib/agent/contract.ts AgentOperationAnswer)
 * under the action's name, with the result in the action's words.
 */
export interface AgentActionAnswer {
  action: string;
  /** The registry operation it ran as, or asked for. */
  operation?: string;
  /** The door's outcomes. 'proposed' only in an answer stored before the one path. */
  outcome: AgentOutcome | 'proposed';
  summary?: string;
  /** True when this answer is the stored answer of an earlier request with the same request id. */
  replayed?: boolean;
  result?: unknown;
  file?: StagedFile;
  ledger?: ChangePreview;
  preview?: OperationPreview;
  warnings?: WarningPreview[];
  effects?: EffectReport[];
  /** The permission request, when the outcome is 'asked'. */
  requestId?: string;
  status?: RequestStatus;
  needs?: ApprovalNeeds;
  grantId?: string;
  /** Answers stored before the one path only: the old approval queue's item. */
  proposalId?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Checks shared by every way of running an action itself
// ---------------------------------------------------------------------------

/**
 * May this access do what the action does? The action's own route in the permission map, its
 * feature switch, and (for changes) the Accountant's Copy rule: what a person's request to that
 * route would have met in getServerContext. The door's bridge makes the same checks for the
 * operations it runs; this is for the runs that do not go through it.
 */
async function assertActionAllowed(ctx: ServiceContext, action: AnyAction): Promise<void> {
  if (!ctx.access) throw new ServiceError('FORBIDDEN', 'This request could not be authorized.');
  authorizeRequest({ path: action.route.path, method: action.route.method }, ctx.access);
  if (action.route.method === 'GET') return;
  const [company] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const gate = blockingFeatureGate(action.route.path, resolveCompanyPreferences(company?.settings ?? {}), action.route.method);
  if (gate) throw featureOffError(gate);
  await assertAccountantCopyAllowsPath(ctx.db, ctx.companyId, action.route.path);
}

function parseInput<I>(action: AgentActionDef<I>, input: unknown): I {
  const parsed = action.schema.safeParse(input ?? {});
  if (!parsed.success) {
    const body = zodErrorBody(parsed.error);
    throw validation(body.error, { fields: body.fields });
  }
  return parsed.data;
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

/** What identifies a request's content: the action (or operation) and its input, key order aside. */
export function agentInputHash(action: string, input: unknown): string {
  return createHash('sha256').update(`${action}\n${stableJson(input ?? {})}`).digest('hex');
}

/** A context that can write, for one action. Never Admin, never the closing-date override. */
function writeContext(base: ServiceContext, db: DB): ServiceContext {
  return {
    db,
    companyId: base.companyId,
    userId: base.userId,
    role: base.access ? legacyRoleFor(base.access, false) : 'viewer',
    closingDateOverride: base.agent ? false : base.closingDateOverride,
    access: base.access,
    agent: base.agent,
    ...(base.sessionId ? { sessionId: base.sessionId } : {}),
  };
}

// ---------------------------------------------------------------------------
// What a change did
// ---------------------------------------------------------------------------

/** A ledger amount as decimal text with two places, or null for none (lib/money.ts, never a float). */
function ledgerAmount(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = toDecimal(v as MoneyInput);
    return d.isZero() ? null : d.toFixed(2);
  } catch {
    return null;
  }
}

/**
 * The ledger entries and audit rows written so far in the CURRENT transaction (their created_at
 * is the transaction's own start time, which no other transaction shares: PGlite runs one at a
 * time). Called just before a dry run is rolled back, or before a real change commits.
 *
 * What it gives back is shown to whoever ran the change (the agent's answer, the approval card),
 * so the free text of the books is as `ctx` may see it: a line memo or an entry description can
 * hold a payee's full account number ("Acct # 000123456789", typed, or copied by a reversal), and
 * goes through lineMemoFor (lib/services/journal.ts) with the caller's access, the rule every other
 * answer that shows a memo follows. Each line also carries the name it is for and its class (typed
 * text as well, so shown by the same rule), so a person approving an A/R line sees which customer
 * it is for. The lines keep their order (entry number, debits first, then line id):
 * lib/agent/parity.test.ts reads them in that same order.
 */
export async function changesInTransaction(ctx: ServiceContext): Promise<ChangePreview> {
  const rows = (await ctx.db.execute(sql`
    SELECT je.id AS entry_id, je.entry_number, je.date, je.description, je.status, je.source_ref,
           l.account_id, a.code AS account_code, a.name AS account_name, l.debit, l.credit, l.memo,
           l.entity_type, l.entity_id::text AS entity_id, c.name AS class_name
      FROM journal_entries je
      JOIN journal_entry_lines l ON l.journal_entry_id = je.id
      JOIN accounts a ON a.id = l.account_id
      LEFT JOIN classes c ON c.id = l.class_id AND c.company_id = je.company_id
     WHERE je.company_id = ${ctx.companyId} AND je.created_at = now()
     ORDER BY je.entry_number, (l.debit IS NULL OR l.debit = 0), l.id`)) as unknown as {
    rows: Array<Record<string, unknown>>;
  };
  const entries = new Map<string, PostingEntry>();
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const names = await resolveEntityNames(
    ctx,
    rows.rows.map((r) => ({ entityType: text(r.entity_type), entityId: text(r.entity_id) })),
  );
  for (const r of rows.rows) {
    const id = String(r.entry_id);
    let e = entries.get(id);
    if (!e) {
      const d = r.date instanceof Date ? r.date : new Date(String(r.date));
      e = {
        journalEntryId: id,
        entryNumber: r.entry_number === null || r.entry_number === undefined ? null : Number(r.entry_number),
        date: Number.isNaN(d.getTime()) ? String(r.date).slice(0, 10) : d.toISOString().slice(0, 10),
        description: lineMemoFor(ctx, text(r.description)),
        status: String(r.status),
        source: text(r.source_ref),
        lines: [],
      };
      entries.set(id, e);
    }
    const type = text(r.entity_type);
    const entityId = text(r.entity_id);
    e.lines.push({
      accountId: String(r.account_id),
      accountCode: text(r.account_code),
      accountName: String(r.account_name),
      debit: ledgerAmount(r.debit),
      credit: ledgerAmount(r.credit),
      memo: lineMemoFor(ctx, text(r.memo)),
      // A customer's, vendor's or class's name is typed text like a memo, and may hold an account
      // number as well: shown by the same rule (as the bridge shows its own lines, bridge.ts nameLines).
      entityName: lineMemoFor(ctx, type && entityId ? (names.get(`${type}:${entityId}`) ?? null) : null),
      className: lineMemoFor(ctx, text(r.class_name)),
    });
  }
  const audit = (await ctx.db.execute(sql`
    SELECT action::text AS action, entity_type, entity_id::text AS entity_id
      FROM audit_logs
     WHERE company_id = ${ctx.companyId} AND created_at = now()
     ORDER BY id`)) as unknown as { rows: Array<{ action: string; entity_type: string; entity_id: string }> };
  return {
    entries: [...entries.values()],
    changes: audit.rows.map((r) => ({ action: r.action, kind: r.entity_type, id: r.entity_id })),
  };
}

// ---------------------------------------------------------------------------
// Dry run of an action's own run
// ---------------------------------------------------------------------------

class RolledBack extends Error {
  constructor(public value: { result: unknown; ledger: ChangePreview }) {
    super('dry run');
  }
}

/**
 * Run a change for real inside a transaction, look at what it did, and roll it back. The checks
 * the database only makes when a transaction commits (every entry balanced, balances equal to the
 * ledger) are made now, so a dry run fails wherever the real change would.
 */
async function dryRun<I>(base: ServiceContext, action: AgentActionDef<I>, input: I): Promise<{ result: unknown; ledger: ChangePreview }> {
  const db = await getDb();
  try {
    await db.transaction(async (txRaw) => {
      const ctx = writeContext(base, txRaw as unknown as DB);
      const result = await action.run(ctx, input);
      await ctx.db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      throw new RolledBack({ result, ledger: await changesInTransaction(ctx) });
    });
  } catch (err) {
    if (err instanceof RolledBack) return err.value;
    throw translateLedgerDbError(err);
  }
  throw new ServiceError('INTERNAL', 'The check did not finish.');
}

// ---------------------------------------------------------------------------
// The request: request id, dry run, reason
// ---------------------------------------------------------------------------

export interface AgentActionRequest {
  action?: unknown;
  input?: unknown;
  dryRun?: unknown;
  requestId?: unknown;
  /** One line saying why, shown to the person when a request asks them. */
  reason?: unknown;
}

interface Asked {
  dryRun: boolean;
  requestId: string | undefined;
  reason: string;
}

/**
 * The words that stand in for a reason when the request has no reason field at all. Every curated
 * tool of today's connector offers one (mcp/write-tools.mjs) and leaves the field out when the
 * agent gives none; an older connector never sends it. A person is never asked without a reason,
 * so the card says plainly that the agent gave none, rather than make one up. A client that sends
 * the field (even empty) knows it: an empty reason then meets the door's own rule (operate.ts
 * NO_REASON_NOTE).
 */
const NO_REASON_GIVEN = 'No reason given: the agent did not say why.';

/**
 * A request id that cannot be one, said as the door says it, with the field named
 * (details.fields.requestId) so a client can tell it from any other refusal of the input.
 */
function requestIdError() {
  return validation(REQUEST_ID_MESSAGE, { fields: { requestId: 'give a request_id of your own, unique to this change' } });
}

function askedOf(body: AgentActionRequest): Asked {
  const dryRun = body?.dryRun === true;
  const id = body?.requestId;
  if (id !== undefined && id !== null && typeof id !== 'string') throw requestIdError();
  // The door refuses an id longer than it stores with a message of its own; say the same thing here.
  if (!dryRun && typeof id === 'string' && id.length > REQUEST_ID_MAX) throw requestIdError();
  const given = body?.reason;
  if (given !== undefined && given !== null && typeof given !== 'string') {
    throw validation('Give the reason as text: one line saying why this is needed.', { fields: { reason: 'must be text' } });
  }
  const reason = typeof given === 'string' ? given.trim() : '';
  if (reason.length > REASON_MAX) {
    throw validation(`The reason can be at most ${REASON_MAX} characters. Say why in one or two plain sentences.`, { fields: { reason: `at most ${REASON_MAX} characters` } });
  }
  const absent = given === undefined || given === null;
  return { dryRun, requestId: typeof id === 'string' ? id : undefined, reason: absent ? NO_REASON_GIVEN : reason };
}

function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId.trim())) throw requestIdError();
  return requestId.trim();
}

/**
 * The answer kept under this request id before the one path, when the action stored it itself
 * (agent_requests.action is then the action's name). Null when there is none: the door answers for
 * every other request id, including a different change sent under an id used before.
 */
async function answerFromBefore(agentId: string, requestId: string, action: AnyAction, input: unknown): Promise<AgentActionAnswer | null> {
  const key = requestId.trim();
  if (!REQUEST_ID_RE.test(key)) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(agentRequests)
    .where(and(eq(agentRequests.agentId, agentId), eq(agentRequests.requestKey, key)));
  if (!row || row.action !== action.name) return null;
  if (row.inputHash !== agentInputHash(action.name, input) || row.result === null || row.result === undefined) {
    throw new ServiceError(
      'CONFLICT',
      `The request_id "${key}" was already used for a different change. Use a new request_id for a new change; reuse one only to repeat the very same request.`,
      { requestId: key },
    );
  }
  return { ...(row.result as unknown as AgentActionAnswer), replayed: true };
}

// ---------------------------------------------------------------------------
// The action's route, as a registry operation
// ---------------------------------------------------------------------------

/** The registry operation of the action's route. Every action has one (lib/agent/actions.test.ts). */
export function actionOperation(action: AnyAction): Operation {
  const operation = operationForRoute(action.route.method, action.route.path);
  if (!operation) {
    throw new ServiceError('INTERNAL', `The action "${action.name}" names a route Ironbooks does not have (${action.route.method} ${action.route.path}).`);
  }
  return operation;
}

/**
 * A value as JSON carries it, the way the route reads it. The action's schema turns dates into
 * Date objects; the route wants the text back, and the door reads dates as text (a date it cannot
 * read could be on either side of the closing date, so it would count as closed-period work). A
 * day (midnight UTC, as the schemas make it) goes back as "YYYY-MM-DD", any other time in full.
 */
function asJson(v: unknown): unknown {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(v)) return v.map(asJson);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = asJson(x);
    return out;
  }
  return v;
}

/** The action's request to its route: params, query and body, as the action's `request` builds it, in JSON's terms. */
export function actionRequest<I>(action: AgentActionDef<I>, input: I): OperationInput {
  const built = action.request ? action.request(input) : { body: input };
  return asJson(built) as OperationInput;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Run one action for the agent behind `ctx` (a context from lib/agentContext.ts). */
export async function runAgentAction(ctx: ServiceContext, body: AgentActionRequest): Promise<AgentActionAnswer> {
  const agent = ctx.agent;
  if (!agent) throw new ServiceError('FORBIDDEN', 'This is for agents.');
  const action = agentAction(body?.action);
  if (!action) throw validation(`Unknown action "${String(body?.action ?? '')}".`, { actions: agentActionNames() });

  if (action.runs === 'self') {
    const input = parseInput(action, body?.input);
    askedOf(body);
    // Its run is a verb of the door's (list_my_requests), which counts the call itself.
    return { action: action.name, outcome: 'read', result: await action.run(ctx, input) };
  }

  // Loaded when used: the door imports this module (request ids, changesInTransaction).
  const { doorRun } = await import('./operate');
  // One call of the agent's, counted before anything is read for it and run in one of its places,
  // as the door counts and places a verb: over the limit, the answer is the door's "slow down"
  // (429 with Retry-After), never a record's version, a policy's answer or an earlier request's.
  // Whatever the action then sends through the door (its first look, its run, a read for its
  // answer) is this same call.
  return doorRun(ctx, async () => {
    const input = parseInput(action, body?.input);
    const asked = askedOf(body);
    const operation = actionOperation(action);
    if (asked.requestId !== undefined && !asked.dryRun) {
      const before = await answerFromBefore(agent.id, asked.requestId, action, input);
      if (before) return before;
    }
    if (action.runs === 'own') return runOwn(ctx, action, operation, input, asked);
    return throughDoor(ctx, action, operation, input, asked);
  });
}

/**
 * The door, reached exactly as run_operation reaches it: the verb itself (lib/agent/operate.ts
 * handleVerb), inside the call runAgentAction counted (doorRun), so it is neither counted again
 * nor given a second place.
 *
 * The version of the record the agent last read goes with the request (OperationInput
 * expectedUpdatedAt): the bridge sends it to the route as x-expected-updated-at, and the route's
 * own withVersionCheck compares it inside the transaction that commits. That is the one guard
 * against overwriting a person's edit, for a dry run, the agent's own run and an approved run
 * alike; nothing here compares it first (lib/agent/catalog.ts versioned says why).
 */
async function door(ctx: ServiceContext, operation: Operation, request: OperationInput, asked: Asked): Promise<AgentOperationAnswer> {
  const { handleVerb } = await import('./operate');
  const answer = await handleVerb(ctx, 'run_operation', {
    operation: operation.id,
    ...request,
    ...(asked.dryRun ? { dryRun: true } : {}),
    ...(asked.requestId !== undefined ? { requestId: asked.requestId } : {}),
    ...(asked.reason ? { reason: asked.reason } : {}),
  });
  return answer as AgentOperationAnswer;
}

/**
 * The door's first look at the action's request (lib/agent/operate.ts doorDecision): what the
 * guards refuse outright, a pause, the hard floor, the role and the policy, on what the request
 * itself says. Nothing of the record the request names is read.
 */
async function firstLook(ctx: ServiceContext, operation: Operation, request: OperationInput) {
  const { doorDecision } = await import('./operate');
  return doorDecision(ctx, operation, request);
}

/**
 * The door's own refusal of a request it refuses at its first look, in its words, exactly as
 * run_operation gives it. It is asked as a dry run: should the agent's settings have changed in
 * between so that the door does not refuse after all, nothing was done, and the answer is null so
 * the caller decides again. An error the door throws (its "this agent is paused", input it cannot
 * read, or what the real request's own tried run would meet) is passed on as it is, before the
 * action's check has read anything.
 */
async function doorRefusal(ctx: ServiceContext, operation: Operation, request: OperationInput, asked: Asked): Promise<AgentOperationAnswer | null> {
  const answer = await door(ctx, operation, request, { ...asked, dryRun: true });
  return answer.outcome === 'refused' ? answer : null;
}

/**
 * Send the action's request through the agent's door, as run_operation sends it. The action's own
 * check (opening stock on a new item) runs only for a request the policy does not refuse: a
 * refusal comes first, in the door's words. All of it comes after the call was counted
 * (runAgentAction, doorRun): a request the check refuses counts as a call like any other.
 * `decided`: the caller already knows the policy does not refuse it (runOwn).
 */
async function throughDoor<I>(
  ctx: ServiceContext,
  action: AgentActionDef<I>,
  operation: Operation,
  input: I,
  asked: Asked,
  decided = false,
): Promise<AgentActionAnswer> {
  const request = actionRequest(action, input);
  if (action.check) {
    if (!decided && (await firstLook(ctx, operation, request)).decision.outcome === 'refuse') {
      const refusal = await doorRefusal(ctx, operation, request, asked);
      if (refusal) return inActionWords(ctx, action, input, refusal);
    }
    await action.check(ctx, input);
  }
  return inActionWords(ctx, action, input, await door(ctx, operation, request, asked));
}

/** Outcomes whose `result` is the route's answer (or a run's), to be put in the action's words. */
const RESULT_OUTCOMES: readonly string[] = ['read', 'dry_run', 'posted', 'done'];

/** The action's one line; the door's when the action's own cannot be made (a record it names is gone). */
async function summaryOf<I>(ctx: ServiceContext, action: AgentActionDef<I>, input: I, fallback: string | undefined): Promise<string | undefined> {
  try {
    return await action.describe(ctx, input);
  } catch {
    return fallback;
  }
}

/** The door's answer under the action's name, with the result in the action's words. */
async function inActionWords<I>(ctx: ServiceContext, action: AgentActionDef<I>, input: I, a: AgentOperationAnswer): Promise<AgentActionAnswer> {
  // A request id asked again whose first answer this action stored itself (its own run): as it was.
  if (a.replayed && (a as unknown as { action?: unknown }).action === action.name) {
    return { ...(a as unknown as AgentActionAnswer), replayed: true };
  }
  const { operation, outcome, result, ledger, summary: doorSummary, ...rest } = a;
  const out: AgentActionAnswer = { action: action.name, operation, outcome };
  // A refusal keeps the door's words, and the door gives none for a request it would not look at.
  // The action's own line reads the books (a customer's, vendor's, account's or bank's name), which
  // a role that lacks the area must not learn by naming an id.
  const summary = outcome === 'refused' ? doorSummary : await summaryOf(ctx, action, input, doorSummary);
  if (summary) out.summary = summary;
  if (rest.replayed) out.replayed = true;
  if (result !== undefined) {
    out.result = RESULT_OUTCOMES.includes(outcome) && action.answer ? await shaped(action, result, input, { ctx, outcome }) : result;
  }
  // Only the ledger the door showed. A run it could not try (closing date, no rolled-back run, the
  // agent's masked rights), or an answer given again, has none: an empty one would say "posts
  // nothing" where nothing was looked at.
  const lines = ledger ?? rest.preview?.ledger ?? null;
  if (lines) out.ledger = lines;
  if (rest.file) out.file = rest.file;
  if (rest.preview) out.preview = rest.preview;
  if (rest.warnings?.length) out.warnings = rest.warnings;
  if (rest.effects?.length) out.effects = rest.effects;
  if (rest.requestId) out.requestId = rest.requestId;
  if (rest.status) out.status = rest.status;
  if (rest.needs) out.needs = rest.needs;
  if (rest.grantId) out.grantId = rest.grantId;
  if (rest.note) out.note = rest.note;
  return out;
}

/** The action's words for a result. A result the action cannot read stays as the route gave it. */
async function shaped<I>(action: AgentActionDef<I>, result: unknown, input: I, how: ActionAnswerContext): Promise<unknown> {
  try {
    return await action.answer!(result, input, how);
  } catch {
    return result;
  }
}

/**
 * A read through the door, for an answer that needs one more fact than its route gave (the
 * progress of a reconciliation just started). Null when the read is refused or fails: the answer
 * then goes without it.
 */
export async function readForAnswer(ctx: ServiceContext, method: AgentActionMethod, pattern: string, input: OperationInput): Promise<unknown> {
  const operation = operationForRoute(method, pattern);
  if (!operation) return null;
  try {
    const { operate } = await import('./operate');
    const answer = await operate(ctx, { operation: operation.id, ...input });
    return answer.outcome === 'read' ? (answer.result ?? null) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Actions that run themselves ('own'), decided by the policy for their route's operation
// ---------------------------------------------------------------------------

/** The input as it identifies a request (lib/agent/operate.ts hashInput): confirmation flags in any order. */
function hashInput(input: OperationInput): unknown {
  return { ...input, ...(input.confirm ? { confirm: [...input.confirm].sort() } : {}) };
}

async function requestIdUsed(agentId: string, requestKey: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: agentRequests.id })
    .from(agentRequests)
    .where(and(eq(agentRequests.agentId, agentId), eq(agentRequests.requestKey, requestKey)));
  return !!row;
}

const OWN_READ_ASKS =
  "This agent's settings ask a person before it reads this. Ask an Admin to change what it may do in Users & Roles > Agents, or ask a person to look it up in Ironbooks.";
const SETTINGS_CHANGED = "This agent's settings changed while this request was being looked at, so nothing was done. Send it again.";

/** Why an own run will not go on with input the guards took something out of. */
function strippedNote(stripped: readonly string[]): string {
  return `This request carries what only a person may set (${stripped.join(', ')}), so the agent cannot do it on its own. Ask a person to do it in Ironbooks.`;
}

/**
 * An action that runs itself, decided by the policy for its route's operation exactly as the door
 * decides it, before anything else is done. A refusal is the door's own (doorRefusal); Ask and
 * standing permission go through the door as that operation; only what the agent may do on its
 * own is run here. The call was counted, and given one of the agent's places, before any of this
 * (runAgentAction, doorRun): a statement import holds a write transaction of up to 5000 lines, and
 * the company file does one piece of work at a time.
 */
async function runOwn<I>(ctx: ServiceContext, action: AgentActionDef<I>, operation: Operation, input: I, asked: Asked): Promise<AgentActionAnswer> {
  const agent = ctx.agent!;
  const request = actionRequest(action, input);
  const look = await firstLook(ctx, operation, request);
  const decision = look.decision;
  const ownRefusal = (note: string): AgentActionAnswer => ({ action: action.name, operation: operation.id, outcome: 'refused', note });

  if (decision.outcome === 'refuse') {
    const refusal = await doorRefusal(ctx, operation, request, asked);
    // The door did not refuse after all: an own run follows only the decision just made, so this
    // one is not run.
    return refusal ? inActionWords(ctx, action, input, refusal) : ownRefusal(SETTINGS_CHANGED);
  }

  if (action.kind === 'read') {
    // A read the policy would ask about is not one this action can ask for: its route is a
    // different read (see the action), and an approved run of that would not answer this.
    if (decision.outcome !== 'run') return ownRefusal(OWN_READ_ASKS);
    if (look.stripped.length) return ownRefusal(strippedNote(look.stripped));
    await assertActionAllowed(ctx, action);
    return { action: action.name, operation: operation.id, outcome: 'read', result: await action.run(ctx, input) };
  }

  // Ask, or standing permission: the door, as the route's operation. A person then approves (or
  // gave permission for) what the route does, with the preview of it.
  if (decision.outcome !== 'run' || decision.grantId) return throughDoor(ctx, action, operation, input, asked, true);
  // A request id used before: the door answers for it (the first answer again, what became of an
  // ask, or a refusal of other input under the same id).
  if (!asked.dryRun && asked.requestId !== undefined && REQUEST_ID_RE.test(asked.requestId.trim()) && (await requestIdUsed(agent.id, asked.requestId.trim()))) {
    return throughDoor(ctx, action, operation, input, asked, true);
  }

  // The run below takes the action's own input, not the guarded request: anything the guards
  // would have taken out (a person-only or secret field, a confirmation flag the operation does
  // not list) must not reach the service by that way round.
  if (look.stripped.length) return ownRefusal(strippedNote(look.stripped));
  await assertActionAllowed(ctx, action);
  const summary = await action.describe(ctx, input);
  if (asked.dryRun) {
    const checked = await dryRun(ctx, action, input);
    return {
      action: action.name,
      operation: operation.id,
      outcome: 'dry_run',
      summary,
      result: checked.result,
      ledger: checked.ledger,
      note: 'Nothing was kept. Sent without dry_run and with a request_id, it would be done straight away.',
    };
  }
  const requestKey = requireRequestId(asked.requestId);
  return keepOwn(ctx, action, operation, input, summary, requestKey, agentInputHash(operation.id, hashInput(look.input)));
}

/**
 * Do it and keep it. The request id is claimed in the same transaction as the change, under the
 * door's key for the operation, so asking again (here or through run_operation) gives this answer.
 */
async function keepOwn<I>(
  base: ServiceContext,
  action: AgentActionDef<I>,
  operation: Operation,
  input: I,
  summary: string,
  requestKey: string,
  hash: string,
): Promise<AgentActionAnswer> {
  const agent = base.agent!;
  const db = await getDb();
  try {
    return await db.transaction(async (txRaw) => {
      const ctx = writeContext(base, txRaw as unknown as DB);
      const claimed = await ctx.db
        .insert(agentRequests)
        .values({ companyId: ctx.companyId, agentId: agent.id, requestKey, action: operation.id.slice(0, 60), inputHash: hash, outcome: 'running' })
        .onConflictDoNothing()
        .returning({ id: agentRequests.id });
      if (!claimed.length) {
        throw new ServiceError('CONFLICT', 'That request is already being carried out. Ask again in a moment with the same request_id.', { requestId: requestKey });
      }
      const result = await action.run(ctx, input);
      const ledger = await changesInTransaction(ctx);
      const answer: AgentActionAnswer = {
        action: action.name,
        operation: operation.id,
        outcome: ledger.entries.length > 0 ? 'posted' : 'done',
        summary,
        result,
        ledger,
      };
      await ctx.db
        .update(agentRequests)
        .set({ outcome: answer.outcome, result: answer as unknown as Record<string, unknown> })
        .where(eq(agentRequests.id, claimed[0].id));
      return answer;
    });
  } catch (err) {
    throw translateLedgerDbError(err);
  }
}

// ---------------------------------------------------------------------------
// Requests copied from the old approval queue
// ---------------------------------------------------------------------------

export const AGENT_PROPOSAL_KIND = 'agent_action';

/** What the old approval queue stored for a person to approve (ai_proposals.payload of kind 'agent_action'). */
export interface AgentProposalPayload {
  /** Shown by the approval card: the first entry's date (or today), the summary, the ledger lines. */
  date: string;
  description: string;
  reference: string | null;
  lines: Array<Omit<PostingLine, 'accountId'> & { accountId: string }>;
  totalDebit: string;
  rationale: string | null;
  agent: { id: string; name: string };
  action: string;
  input: unknown;
  changes: ChangePreview['changes'];
}

/**
 * Enter a change an agent proposed in the old approval queue, now that a person approved it. The
 * only caller is the approval center (lib/services/agentRequests.ts), for a request copied from
 * such a proposal, inside its transaction, with the approving person's context. Ask AI no longer
 * approves agent proposals: it only lists them, with a link to Agent requests. Nothing new goes
 * to that queue: this is for what is still waiting in it.
 *
 * It runs under the PERSON's permissions: the action's route is checked against their access, and
 * their closing-date password (if they gave it) is theirs to use. The records name both: proposed
 * by the agent, approved by the person.
 */
export async function runApprovedAgentAction(tx: ServiceContext, payload: unknown): Promise<{ resultRef: string; result: unknown }> {
  const p = (payload ?? {}) as Partial<AgentProposalPayload>;
  const action = agentAction(p.action);
  if (!action || action.kind !== 'write' || !p.agent?.id) throw validation('This proposal can no longer be entered. Reject it and ask the agent to propose it again.');
  const input = parseInput(action, p.input);
  await assertActionAllowed(tx, action);
  const ctx: ServiceContext = { ...tx, agent: { id: p.agent.id, name: String(p.agent.name ?? 'Agent'), mode: 'propose', onBehalfOf: tx.userId } };
  const result = await action.run(ctx, input);
  return { resultRef: `agent:${action.name}`.slice(0, 255), result };
}

/**
 * The proposals this agent made in the old approval queue, newest first, with what a person
 * decided. list_my_proposals answers with the agent's requests now (they include the requests
 * copied from these proposals), and nothing in the app calls this any more; it is kept for a
 * caller outside the app that still reads the old queue.
 */
export async function listAgentProposals(ctx: ServiceContext, limit = 50) {
  if (!ctx.agent) return [];
  const rows = await ctx.db
    .select({ id: aiProposals.id, summary: aiProposals.summary, status: aiProposals.status, createdAt: aiProposals.createdAt, decidedAt: aiProposals.decidedAt, payload: aiProposals.payload })
    .from(aiProposals)
    .where(and(eq(aiProposals.companyId, ctx.companyId), eq(aiProposals.agentId, ctx.agent.id)))
    .orderBy(sql`${aiProposals.createdAt} DESC`)
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({
    proposal_id: r.id,
    action: (r.payload as { action?: string } | null)?.action ?? null,
    summary: r.summary,
    status: r.status,
    proposed_at: r.createdAt.toISOString(),
    decided_at: r.decidedAt ? r.decidedAt.toISOString() : null,
  }));
}
