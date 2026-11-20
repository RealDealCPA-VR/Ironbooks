/**
 * How an agent changes the books (AGENT_ACCESS.md): one runner, a fixed catalog of named actions.
 *
 * An agent never calls the app's own save routes. Everything it may do beyond reading the listed
 * routes is one of the actions in lib/agent/catalog.ts ("enter_invoice", "void_transaction",
 * "finish_reconciliation" …), sent to POST /api/agent/actions and run here. Each action names the
 * app route a person would use for the same thing, and the runner applies that route's entry in
 * the permission map, its feature switch and its Accountant's Copy rule to the agent's own access:
 * the same rules as a person with the agent's role, plus the agent limits
 * (lib/permissions/agentAccess.ts). The closing date is never open to an agent.
 *
 * What happens to a change depends on the agent's mode and on what it asked for:
 *
 *  - `dryRun: true` (Propose and Post): the action really runs, inside a database transaction that
 *    is then rolled back. The answer says what would have been entered, or why it would be
 *    refused, exactly as the real thing would. Nothing is kept, nothing is logged.
 *  - Propose: after the same check, the request is put in the approval queue (ai_proposals) for a
 *    person. Nothing is entered until a person approves it, and then it is entered under that
 *    person's own permissions, named as proposed by the agent and approved by them.
 *  - Post: the action runs and is kept. The audit trail and the transaction log name the agent.
 *  - Read only: refused.
 *
 * Work that never reaches the ledger (statement lines put in the bank feed, a reconciliation still
 * in progress: actions of kind 'prepare', lib/agent/banking.ts) is done directly in Propose mode
 * too, so an agent can lay a statement out for a person to finish.
 *
 * Every change that is kept needs a `requestId` chosen by the agent. Asking again with the same
 * id returns the first answer instead of entering the same thing twice (a retry after a timeout,
 * an agent that repeats itself); the same id with different input is refused.
 *
 * The context an agent's request arrives with can only read (lib/agentContext.ts). This module is
 * the one place that makes a context that can write, for one action, inside one transaction.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { getDb, type DB } from '@/lib/db';
import { agentRequests, aiProposals, companies } from '@/lib/db/schema';
import { blockingFeatureGate, resolveCompanyPreferences } from '@/lib/preferences';
import { featureOffError } from '@/lib/featureGate';
import { agentMayPropose, agentMayWrite } from '@/lib/permissions/agentAccess';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { legacyRoleFor } from '@/lib/permissions/model';
import { assertAccountantCopyAllowsPath } from '@/lib/services/accountantCopy/routeGate';
import { type ServiceContext, ServiceError, translateLedgerDbError, validation, writeAudit } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';

export type AgentActionMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AgentActionDef<I = unknown> {
  /** The action's name, as the agent's tool sends it ("enter_invoice"). */
  name: string;
  /**
   * 'read' runs on the agent's read-only context. 'write' changes the books and is subject to the
   * agent's mode: entered (Post) or queued for a person (Propose). 'prepare' lays work out without
   * touching the ledger (statement lines in the bank feed, a reconciliation still in progress):
   * an agent that may Propose or Post does it itself; a person can discard all of it.
   */
  kind: 'read' | 'prepare' | 'write';
  /**
   * The route a person uses for the same thing. Its permission-map entry, feature switch and
   * Accountant's Copy rule decide whether this agent (or the person approving) may do it.
   */
  route: { path: string; method: AgentActionMethod };
  schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** One line saying what this request is, for the approval queue and the answer. */
  describe: (ctx: ServiceContext, input: I) => string | Promise<string>;
  run: (ctx: ServiceContext, input: I) => Promise<unknown>;
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

export const READ_ONLY_AGENT_MESSAGE =
  'This agent can only read. To enter transactions, an Admin makes an agent that may Propose or Post (Users & Roles > Agents).';
export const REQUEST_ID_MESSAGE =
  'Give a request_id: any text of your own, unique to this change (for example "inv-acme-2026-03-01-a"). Asking again with the same request_id never enters the change twice.';

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{2,119}$/;

/** A line of the ledger an action would post, or posted. */
export interface PostingLine {
  accountId: string;
  accountCode: string | null;
  accountName: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  entityName: string | null;
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

export interface AgentActionAnswer {
  action: string;
  /** 'done' is a 'prepare' action that was carried out: nothing was posted to the ledger. */
  outcome: 'read' | 'dry_run' | 'posted' | 'proposed' | 'done';
  summary?: string;
  /** True when this answer is the stored answer of an earlier request with the same request id. */
  replayed?: boolean;
  result?: unknown;
  ledger?: ChangePreview;
  proposalId?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Checks shared by every way of running an action
// ---------------------------------------------------------------------------

/**
 * May this access do what the action does? The action's own route in the permission map, its
 * feature switch, and (for changes) the Accountant's Copy rule: what a person's request to that
 * route would have met in getServerContext.
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

/** What identifies a request's content: the action and its input, key order aside. */
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

/**
 * The ledger entries and audit rows written so far in the CURRENT transaction (their created_at
 * is the transaction's own start time, which no other transaction shares: PGlite runs one at a
 * time). Called just before a dry run is rolled back, or before a real change commits.
 */
export async function changesInTransaction(ctx: ServiceContext): Promise<ChangePreview> {
  const rows = (await ctx.db.execute(sql`
    SELECT je.id AS entry_id, je.entry_number, je.date, je.description, je.status, je.source_ref,
           l.account_id, a.code AS account_code, a.name AS account_name, l.debit, l.credit, l.memo,
           l.entity_type, l.entity_id
      FROM journal_entries je
      JOIN journal_entry_lines l ON l.journal_entry_id = je.id
      JOIN accounts a ON a.id = l.account_id
     WHERE je.company_id = ${ctx.companyId} AND je.created_at = now()
     ORDER BY je.entry_number, (l.debit IS NULL OR l.debit = 0), l.id`)) as unknown as {
    rows: Array<Record<string, unknown>>;
  };
  const entries = new Map<string, PostingEntry>();
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const money = (v: unknown) => (v === null || v === undefined || Number(v) === 0 ? null : Number(v).toFixed(2));
  for (const r of rows.rows) {
    const id = String(r.entry_id);
    let e = entries.get(id);
    if (!e) {
      const d = r.date instanceof Date ? r.date : new Date(String(r.date));
      e = {
        journalEntryId: id,
        entryNumber: r.entry_number === null || r.entry_number === undefined ? null : Number(r.entry_number),
        date: Number.isNaN(d.getTime()) ? String(r.date).slice(0, 10) : d.toISOString().slice(0, 10),
        description: text(r.description),
        status: String(r.status),
        source: text(r.source_ref),
        lines: [],
      };
      entries.set(id, e);
    }
    e.lines.push({
      accountId: String(r.account_id),
      accountCode: text(r.account_code),
      accountName: String(r.account_name),
      debit: money(r.debit),
      credit: money(r.credit),
      memo: text(r.memo),
      entityName: null,
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
// Dry run
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
// Request ids
// ---------------------------------------------------------------------------

function requireRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId.trim())) throw validation(REQUEST_ID_MESSAGE);
  return requestId.trim();
}

/** The stored answer of an earlier request with this id, or null. Different input → CONFLICT. */
async function earlierAnswer(db: DB, agentId: string, requestId: string, action: string, hash: string): Promise<AgentActionAnswer | null> {
  const [row] = await db
    .select()
    .from(agentRequests)
    .where(and(eq(agentRequests.agentId, agentId), eq(agentRequests.requestKey, requestId)));
  if (!row) return null;
  if (row.action !== action || row.inputHash !== hash) {
    throw new ServiceError(
      'CONFLICT',
      `The request_id "${requestId}" was already used for a different change. Use a new request_id for a new change; reuse one only to repeat the very same request.`,
      { requestId },
    );
  }
  return { ...((row.result ?? {}) as AgentActionAnswer), replayed: true };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface AgentActionRequest {
  action?: unknown;
  input?: unknown;
  dryRun?: unknown;
  requestId?: unknown;
}

/** Run one action for the agent behind `ctx` (a context from lib/agentContext.ts). */
export async function runAgentAction(ctx: ServiceContext, body: AgentActionRequest): Promise<AgentActionAnswer> {
  const agent = ctx.agent;
  if (!agent) throw new ServiceError('FORBIDDEN', 'This is for agents.');
  const action = agentAction(body?.action);
  if (!action) throw validation(`Unknown action "${String(body?.action ?? '')}".`, { actions: agentActionNames() });
  const input = parseInput(action, body?.input);

  if (action.kind === 'read') {
    await assertActionAllowed(ctx, action);
    return { action: action.name, outcome: 'read', result: await action.run(ctx, input) };
  }

  if (!agentMayPropose(agent.mode)) throw new ServiceError('FORBIDDEN', READ_ONLY_AGENT_MESSAGE, { agent: true, mode: agent.mode });
  await assertActionAllowed(ctx, action);
  const summary = await action.describe(ctx, input);

  // Preparing work is done directly; a change to the books only in Post mode.
  const direct = action.kind === 'prepare' || agentMayWrite(agent.mode);

  if (body?.dryRun === true) {
    const checked = await dryRun(ctx, action, input);
    return {
      action: action.name,
      outcome: 'dry_run',
      summary,
      result: checked.result,
      ledger: checked.ledger,
      note: direct
        ? 'Nothing was kept. Send the same request without dry_run, with a request_id, to do it.'
        : 'Nothing was entered. Send the same request without dry_run, with a request_id, to put it in the approval queue.',
    };
  }

  const requestId = requireRequestId(body?.requestId);
  const hash = agentInputHash(action.name, input);
  const db = await getDb();
  const earlier = await earlierAnswer(db, agent.id, requestId, action.name, hash);
  if (earlier) return earlier;

  return direct
    ? postAction(ctx, db, action, input, summary, requestId, hash, action.kind === 'prepare' ? 'done' : 'posted')
    : proposeAction(ctx, db, action, input, summary, requestId, hash);
}

async function postAction<I>(
  base: ServiceContext,
  db: DB,
  action: AgentActionDef<I>,
  input: I,
  summary: string,
  requestId: string,
  hash: string,
  outcome: 'posted' | 'done',
): Promise<AgentActionAnswer> {
  const agent = base.agent!;
  try {
    return await db.transaction(async (txRaw) => {
      const ctx = writeContext(base, txRaw as unknown as DB);
      // Claim the request id first, in the same transaction as the change: either both are kept
      // or neither is.
      const claimed = await ctx.db
        .insert(agentRequests)
        .values({ companyId: ctx.companyId, agentId: agent.id, requestKey: requestId, action: action.name, inputHash: hash, outcome })
        .onConflictDoNothing()
        .returning({ id: agentRequests.id });
      if (!claimed.length) {
        const again = await earlierAnswer(ctx.db, agent.id, requestId, action.name, hash);
        if (again) return again;
        throw new ServiceError('CONFLICT', 'That request is already being entered. Ask again in a moment with the same request_id.');
      }
      const result = await action.run(ctx, input);
      const answer: AgentActionAnswer = { action: action.name, outcome, summary, result, ledger: await changesInTransaction(ctx) };
      await ctx.db.update(agentRequests).set({ result: answer as unknown as Record<string, unknown> }).where(eq(agentRequests.id, claimed[0].id));
      return answer;
    });
  } catch (err) {
    throw translateLedgerDbError(err);
  }
}

/** The total of the debit side of a preview, as the approval card shows it. */
function totalDebit(ledger: ChangePreview): string {
  let cents = 0;
  for (const e of ledger.entries) for (const l of e.lines) cents += Math.round(Number(l.debit ?? 0) * 100);
  return (cents / 100).toFixed(2);
}

export const AGENT_PROPOSAL_KIND = 'agent_action';

/** What is stored for a person to approve (ai_proposals.payload of kind 'agent_action'). */
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

async function proposeAction<I>(
  base: ServiceContext,
  db: DB,
  action: AgentActionDef<I>,
  input: I,
  summary: string,
  requestId: string,
  hash: string,
): Promise<AgentActionAnswer> {
  const agent = base.agent!;
  // The same check a dry run makes: only something that would go through is queued.
  const checked = await dryRun(base, action, input);
  const payload: AgentProposalPayload = {
    date: checked.ledger.entries[0]?.date ?? new Date().toISOString().slice(0, 10),
    description: summary,
    reference: null,
    lines: checked.ledger.entries.flatMap((e) => e.lines),
    totalDebit: totalDebit(checked.ledger),
    rationale: `Proposed by the agent "${agent.name}".`,
    agent: { id: agent.id, name: agent.name },
    action: action.name,
    input,
    changes: checked.ledger.changes,
  };
  try {
    return await db.transaction(async (txRaw) => {
      const ctx = writeContext(base, txRaw as unknown as DB);
      const claimed = await ctx.db
        .insert(agentRequests)
        .values({ companyId: ctx.companyId, agentId: agent.id, requestKey: requestId, action: action.name, inputHash: hash, outcome: 'proposed' })
        .onConflictDoNothing()
        .returning({ id: agentRequests.id });
      if (!claimed.length) {
        const again = await earlierAnswer(ctx.db, agent.id, requestId, action.name, hash);
        if (again) return again;
        throw new ServiceError('CONFLICT', 'That request is already being queued. Ask again in a moment with the same request_id.');
      }
      const [row] = await ctx.db
        .insert(aiProposals)
        .values({
          companyId: ctx.companyId,
          createdBy: null,
          agentId: agent.id,
          kind: AGENT_PROPOSAL_KIND,
          summary: summary.slice(0, 1000),
          payload: payload as unknown as Record<string, unknown>,
          status: 'pending',
        })
        .returning({ id: aiProposals.id });
      await writeAudit(ctx, {
        action: 'create',
        entityType: 'ai_proposal',
        entityId: row.id,
        newValues: { kind: AGENT_PROPOSAL_KIND, action: action.name, summary, status: 'pending' },
      });
      const answer: AgentActionAnswer = {
        action: action.name,
        outcome: 'proposed',
        summary,
        proposalId: row.id,
        ledger: checked.ledger,
        note: 'Nothing was entered. A person has to approve this in Ironbooks (Ask AI > Waiting for your approval). Use list_my_proposals to see what they decided.',
      };
      await ctx.db.update(agentRequests).set({ result: answer as unknown as Record<string, unknown> }).where(eq(agentRequests.id, claimed[0].id));
      return answer;
    });
  } catch (err) {
    throw translateLedgerDbError(err);
  }
}

// ---------------------------------------------------------------------------
// Approval by a person
// ---------------------------------------------------------------------------

/**
 * Enter a change an agent proposed, now that a person approved it (called by approveProposal in
 * lib/services/aiAssistant.ts, inside its transaction, with the approving person's context).
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

/** The proposals this agent made, newest first, with what a person decided. */
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
