/**
 * Agent full access: the route bridge (plan §5.2). Runs the app's own route handler in-process for
 * an agent, so an agent's operation goes through exactly the code a person's request does: the
 * same validation, the same services, the same warnings, the same answer.
 *
 * Three ways to run (BridgeMode):
 *  - 'read': on the read-only database handle (lib/db/readOnly.ts) with ctx.readOnly set, so a
 *    GET that would save something on the way (a default list on first use) is refused by the
 *    database instead of writing. Effects are captured, never sent. An operation of class read or
 *    read_sensitive always runs this way, whatever mode it was asked in: an approved reveal is a
 *    read too, and must never save anything under the agent's name.
 *  - 'dry_run': the handler really runs inside a database transaction that is then rolled back.
 *    The checks the database only makes at COMMIT are made first (SET CONSTRAINTS ALL IMMEDIATE),
 *    so a dry run fails wherever the real run would. What it did is read back before the rollback:
 *    the ledger entries and touched records (changesInTransaction), field changes from the audit
 *    rows, and the emails, files and print jobs it asked for (lib/effects.ts, captured). An
 *    operation whose classification says it cannot be rolled back ('preview' or 'none') is not run
 *    at all: the answer says so and lists what it may do.
 *  - 'commit': the same, kept. Effects are queued while the transaction runs and released only
 *    after it committed; a handler answer of 400 or more rolls everything back and releases
 *    nothing. A standing permission (grant) is counted inside the same transaction, so a failed run
 *    does not use it up.
 *
 * Who the handler runs as is built here from the ACTOR alone (contract BridgeActor), never from
 * `base.access`: `base` only gives the company and the database. The handler sees that context
 * through the service scope (lib/context.ts runWithServiceContext): getServerContext returns it and
 * requestHeaders() returns a synthetic header set the bridge builds, with only the names in
 * SERVICE_SCOPE_HEADERS. Nothing of the request the bridge happens to run in (perhaps the approving
 * person's own window, with their cookie) reaches the handler.
 *
 * Inside a scope getServerContext skips what is about the person or the file rather than the
 * request, so those are settled here before anything runs: the file password with nobody signed
 * in, a practice copy, single-user mode held by someone else, an approver whose password must be
 * changed, Pause all agents, a removed or paused agent. The route map, the feature switch and the
 * Accountant's Copy rule are checked here too, against the actor's access (and again by the scope).
 *
 * The operation decides what runs and how (its class, availability, dry-run kind, confirmation
 * flags, secrets), so the bridge only runs an operation exactly as the registry describes it: a
 * caller's copy that differs from the registered one in anything but `activity` is a programming
 * error and throws.
 *
 * Secrets (plan 5.8): only on a commit, only from actor.secrets (typed by the approving person),
 * put in place by applySecrets (lib/agent/guards.ts). Never in a read or a dry run, never from the
 * agent's input (guardInput strips them). The closing-date override is set only for a closing
 * password that verifies, on a commit, for an access that holds the closed-period right. Its
 * guesses count against the same limiter and keys as the person's own x-closing-password (lib/
 * context.ts resolveClosingDateOverride), so approvals cannot be used to try passwords.
 *
 * The staleness key (plan §7.4) says what the run did and what it read: the versions of the records
 * the input names (read in the same transaction, before the handler runs), the ledger lines it
 * posts, the field values of every record it writes, and the emails, files and print jobs it asks
 * for. Values that differ on every run of the same request (new ids, times of the run) are left out,
 * so two runs over the same books agree, and a price, a rate or a named record changed in between
 * gives another key.
 *
 * Files an operation saves (effects.writeFile) must land inside one of the agent's folders
 * (lib/agent/files.ts allowedFolder): the folder itself, or, when it does not exist yet, its
 * nearest existing parent with only plain names below it. The check is made inside the effects
 * collection, so a refused run still reports the calls to other computers it already made.
 *
 * Never throws for what the handler answered: a refusal, an error answer, a time-out or a failed
 * commit all come back as outcome 'error' with the app's own message. It throws only for a
 * programming error (an unknown mode, an operation object the registry did not hand out).
 *
 * Time limits (BRIDGE_TIME_LIMIT_MS, reports BRIDGE_REPORT_TIME_LIMIT_MS): PGlite runs one
 * transaction at a time, so a long run blocks the app. On time-out the answer says the work took
 * too long; work still running is rolled back when it reaches the end (it cannot be interrupted
 * in the middle), and it releases nothing. A commit of a dryRun 'none' operation has no limit: its
 * service opens its own database handle, so the bridge could not undo it, only abandon its effects.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import { resolveDataDir, sealedMode, type DB } from '@/lib/db';
import { isReadOnlyDb, readOnlyDb } from '@/lib/db/readOnly';
import { dataDirOf, rootDbOf } from '@/lib/db/txHooks';
import {
  accounts,
  agents,
  billPayments,
  bills,
  companies,
  creditMemos,
  customers,
  deposits,
  employees,
  estimates,
  expenses,
  invoices,
  itemReceipts,
  items,
  journalEntries,
  paychecks,
  paymentsReceived,
  purchaseOrders,
  salesOrders,
  salesReceipts,
  transfers,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import {
  SERVICE_SCOPE_HEADERS,
  isArchivedCompany,
  runWithServiceContext,
  type ServiceScopeOptions,
} from '@/lib/context';
import { AGENT_NOT_READY_MESSAGE, AGENT_SANDBOX_MESSAGE } from '@/lib/agentContext';
import { currentEffects, effectsOfFailedRun, runWithEffects, type EffectReport, type EffectsMode, type EffectsRun } from '@/lib/effects';
import { featureOffError } from '@/lib/featureGate';
import { Money, toAmountString } from '@/lib/money';
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { blockingFeatureGate, resolveCompanyPreferences } from '@/lib/preferences';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { isSecretKey, maskSensitive } from '@/lib/permissions/mask';
import { legacyRoleFor, type EffectiveAccess } from '@/lib/permissions/model';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { assertAccountantCopyAllowsPath } from '@/lib/services/accountantCopy/routeGate';
import { AGENTS_BLOCKED_MESSAGE } from '@/lib/services/agents';
import { useGrant } from '@/lib/services/agentGrants';
import { verifyClosingDatePassword } from '@/lib/services/company';
import { VERSIONED_ENTITIES, versionField, type VersionedEntity } from '@/lib/services/concurrency';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { assertPasswordChangeNotRequired } from '@/lib/services/passwordPolicy';
import { isSandboxActive } from '@/lib/services/sandboxState';
import { getSingleUserMode } from '@/lib/services/sessions';
import { ServiceError, translateLedgerDbError, type ServiceContext } from '@/lib/services/_base';
import { changesInTransaction, type ChangePreview } from './actions';
import {
  BRIDGE_REPORT_TIME_LIMIT_MS,
  BRIDGE_TIME_LIMIT_MS,
  PREVIEW_ROW_LIMIT,
  type BridgeActor,
  type BridgeError,
  type BridgeMode,
  type BridgeResult,
  type FileOwner,
  type FileRef,
  type OperationInput,
  type OperationPreview,
  type ProducedSecret,
  type RunOperation,
  type StagedFile,
} from './contract';
import { personSignedIn } from './endpointFile';
import { factsOf } from './facts';
import { allowedFolder, readStagedFile, stageFile } from './files';
import { applySecrets, guardInput, redactAnswer } from './guards';
import { loadRouteHandler, operationById, operationForPath, type RouteHandler, type RouteParams } from './operations/registry';
import type { EffectKind, EffectPreview, Operation, RecordDiff, RequestFacts, RiskClass, SecretKind, WarningPreview } from './operations/types';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const READ_CLASSES: readonly RiskClass[] = ['read', 'read_sensitive'];

/** Where a staged-file problem or a refusal points the agent. */
const AGENTS_TAB = 'Users & Roles > Agents';

/** What a declared effect may do, for a preview of an operation that is not tried out. */
const EFFECT_WORDS: Record<EffectKind, string> = {
  email: 'May send an email',
  file: 'May save a file',
  print: 'May print',
  network: 'May contact another computer',
};

const NOT_TRIED: Record<'preview' | 'none', string> = {
  preview:
    'This was not tried out: this operation has a preview of its own, which is a separate operation to read. Nothing was changed.',
  none:
    'This was not tried out: it cannot be run and then undone (it works outside the books, or on the company file itself). Nothing was changed; a person decides on its description.',
};

/** Shown in a preview in place of a hidden value. */
const MASK = '••••';

// ---------------------------------------------------------------------------
// Errors the bridge throws to itself (all turned into an answer before runOperation returns)
// ---------------------------------------------------------------------------

/** The handler answered 400 or more: thrown inside the run so the transaction rolls back. */
class HandlerAnswered extends Error {
  constructor(public raw: RawAnswer) {
    super('The handler answered with an error.');
  }
}

/** A dry run is done: thrown with its outcome so the transaction rolls back. */
class RolledBack extends Error {
  constructor(public result: BridgeResult) {
    super('dry run');
  }
}

/** The work ran past its time limit: thrown so the transaction rolls back. */
class TimedOut extends Error {
  constructor() {
    super('time limit');
  }
}

/** The bridge refuses part of the run (a folder, a missing file): thrown so it rolls back. */
class BridgeRefusal extends Error {
  constructor(
    message: string,
    public code: string,
    public details: unknown = null,
    public httpStatus = 0,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** The facts before anything is known beyond the input (refusals). */
function bareFacts(input: OperationInput): RequestFacts {
  return {
    confirm: Array.isArray(input.confirm) ? input.confirm.filter((f): f is string => typeof f === 'string') : [],
    reveal: input.reveal === true,
    amount: null,
    count: null,
    entityIds: [],
    accountIds: [],
    date: null,
    closedPeriod: false,
  };
}

function blank(mode: BridgeMode, facts: RequestFacts): BridgeResult {
  return {
    mode,
    httpStatus: 0,
    outcome: 'ok',
    result: null,
    file: null,
    preview: null,
    warnings: [],
    error: null,
    effects: [],
    facts,
    stalenessKey: null,
    produced: [],
  };
}

function errorResult(mode: BridgeMode, facts: RequestFacts, error: BridgeError, httpStatus = 0, effects: EffectReport[] = []): BridgeResult {
  return { ...blank(mode, facts), outcome: 'error', httpStatus, error, effects };
}

function serviceErrorAsBridgeError(err: ServiceError): BridgeError {
  return { message: err.message, code: err.code, details: err.details ?? null };
}

/** The agent's mode as older code reads it (ServiceContext.agent.mode), from its preset. */
function modeOfPreset(preset: BridgeActor['agent']['preset']): 'read_only' | 'propose' | 'post' {
  if (preset === 'read_only') return 'read_only';
  if (preset === 'ask_every_change') return 'propose';
  return 'post';
}

function isReportRoute(route: string): boolean {
  return ['/api/reports', '/api/report-builder'].some((r) => route === r || route.startsWith(`${r}/`));
}

function secretValue(secrets: BridgeActor['secrets'] | undefined, kind: SecretKind): string | null {
  const v = secrets?.[kind];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** At most PREVIEW_ROW_LIMIT effects in a preview, and whether some were left out. */
function capped(effects: EffectPreview[]): { list: EffectPreview[]; truncated: boolean } {
  return { list: effects.slice(0, PREVIEW_ROW_LIMIT), truncated: effects.length > PREVIEW_ROW_LIMIT };
}

/**
 * The operation exactly as the registry has it. Everything the bridge decides on (availability,
 * class, hostOnly, confirmFlags, needsSecret, dryRun, reveal, sensitiveFields, body) comes from the
 * operation object, so an edited copy ({ ...op, availability: 'agent' }) must never run.
 */
function assertRegistered(operation: Operation): void {
  if (!isObject(operation) || typeof operation.id !== 'string') throw new Error('The route bridge was given something that is not an operation.');
  const registered = operationById(operation.id);
  const comparable = (o: Operation) => {
    const { activity: _activity, ...rest } = o;
    return stableJson(rest);
  };
  if (!registered || comparable(operation) !== comparable(registered)) {
    throw new Error(`The route bridge was given an operation "${operation.id}" that differs from the registry's.`);
  }
}

// ---------------------------------------------------------------------------
// The context the handler runs with
// ---------------------------------------------------------------------------

/**
 * The actor's access for this one run: the View flags for full SSNs and full account numbers are
 * switched off unless a person approved a reveal of exactly that kind for this call.
 */
function runAccess(actor: BridgeActor, operation: Operation): EffectiveAccess {
  const access = actor.access;
  const revealed = actor.reveal && operation.reveal ? (operation.reveal === 'account_numbers' ? 'fullAccountNumbers' : 'sensitivePayroll') : null;
  return {
    ...access,
    flags: {
      ...access.flags,
      sensitivePayroll: revealed === 'sensitivePayroll' && access.flags.sensitivePayroll === true,
      fullAccountNumbers: revealed === 'fullAccountNumbers' && access.flags.fullAccountNumbers === true,
    },
  };
}

/**
 * A handle that can write, from the one `base` carries. The agent's own context holds the
 * read-only wrapper of the company's database (lib/agentContext.ts); its root is the real handle.
 */
function writableDb(base: ServiceContext): DB {
  if (!isReadOnlyDb(base.db)) return base.db;
  const root = rootDbOf(base.db as unknown as object);
  if (!root) throw new Error('The route bridge was given a read-only database it cannot write through.');
  return root as unknown as DB;
}

interface RunContextParts {
  companyId: string;
  access: EffectiveAccess;
  role: NonNullable<ServiceContext['role']>;
  closingDateOverride: boolean;
  actor: BridgeActor;
}

function handlerContext(db: DB, parts: RunContextParts, readOnly: boolean): ServiceContext {
  const { actor } = parts;
  return {
    db,
    companyId: parts.companyId,
    userId: actor.userId,
    role: parts.role,
    closingDateOverride: parts.closingDateOverride,
    access: parts.access,
    agent: {
      id: actor.agent.id,
      name: actor.agent.name,
      mode: modeOfPreset(actor.agent.preset),
      preset: actor.agent.preset,
      onBehalfOf: actor.agent.onBehalfOf,
    },
    approval: {
      approvedBy: actor.approval?.approvedBy ?? null,
      requestId: actor.approval?.requestId ?? null,
      grantId: actor.approval?.grantId ?? null,
    },
    ...(readOnly ? { readOnly: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Step 3: what getServerContext would have checked for a person
// ---------------------------------------------------------------------------

interface Gates {
  closingDate: string | null;
}

/**
 * The checks a scope skips, made here for the actor, on the concrete path. Returns the refusal, or
 * what the run needs to know about the company.
 */
async function settleGates(
  db: DB,
  companyId: string,
  actor: BridgeActor,
  access: EffectiveAccess,
  method: string,
  path: string,
): Promise<{ refusal: BridgeError } | Gates> {
  const refuse = (message: string, code: string, details: unknown = null) => ({ refusal: { message, code, details } });
  // A company file protected with passwords is not open at all until a person opens it.
  if (sealedMode() !== null) return refuse(AGENT_NOT_READY_MESSAGE, 'NOT_READY', { notReady: true });
  if (isSandboxActive()) return refuse(AGENT_SANDBOX_MESSAGE, 'SANDBOX');

  const [company] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  if (!company || isArchivedCompany(company.settings)) {
    return refuse('This company is not available. Open it in Ironbooks first.', 'FORBIDDEN');
  }
  const settings = (company.settings ?? {}) as Record<string, unknown>;
  if (settings.integratedAppsBlocked === true) return refuse(AGENTS_BLOCKED_MESSAGE, 'FORBIDDEN', { agent: true });

  const [agent] = await db
    .select({ companyId: agents.companyId, revokedAt: agents.revokedAt, pausedAt: agents.pausedAt })
    .from(agents)
    .where(eq(agents.id, actor.agent.id));
  if (!agent || agent.companyId !== companyId || agent.revokedAt) {
    return refuse(`This agent no longer has access to this company. An Admin can add it again in ${AGENTS_TAB}.`, 'FORBIDDEN', { agent: true });
  }
  if (agent.pausedAt) {
    return refuse(`This agent is paused. A person can resume it in ${AGENTS_TAB}.`, 'PAUSED', { agent: true });
  }

  // The file password: an agent works past it only while a person has the books open.
  const dir = dataDirOf(db as unknown as object) ?? resolveDataDir();
  if ((await getFileLockStatus(db)).enabled && !personSignedIn(dir)) {
    return refuse(AGENT_NOT_READY_MESSAGE, 'NOT_READY', { notReady: true });
  }
  // Single-user mode: only its holder works in the company. The approving person may be it.
  const holder = await getSingleUserMode(db, companyId);
  if (holder && (!actor.userId || holder.userId !== actor.userId)) {
    return refuse(
      `The company file is in single-user mode: ${holder.userName} is doing maintenance. Try again when they let everyone back in.`,
      'FORBIDDEN',
      { singleUserMode: true },
    );
  }

  try {
    // The approving person must have chosen a new password first, as at their own window.
    if (actor.userId) await assertPasswordChangeNotRequired(db, actor.userId);
    // The route map, the feature switch and the Accountant's Copy rule, as assertActionAllowed
    // (lib/agent/actions.ts) does for the curated actions.
    authorizeRequest({ path, method }, access);
    if (method !== 'GET') {
      const gate = blockingFeatureGate(path, resolveCompanyPreferences(settings), method);
      if (gate) throw featureOffError(gate);
      await assertAccountantCopyAllowsPath(db, companyId, path);
    }
  } catch (err) {
    if (err instanceof ServiceError) return { refusal: serviceErrorAsBridgeError(err) };
    throw err;
  }
  return { closingDate: typeof settings.closingDate === 'string' ? settings.closingDate : null };
}

/**
 * The closing-date override of a commit: only for an access holding the closed-period right, and
 * only for a closing password the approving person typed that verifies. Every guess goes through
 * the limiter and keys the person's own x-closing-password goes through (lib/context.ts
 * resolveClosingDateOverride: per person in this company, plus the global cap), so an approver
 * without the password cannot use approvals to try passwords until one works, nor spread guesses
 * over the two ways in. A locked limiter refuses the run before anything runs.
 */
async function closingOverride(
  db: DB,
  companyId: string,
  actor: BridgeActor,
  access: EffectiveAccess,
  mode: BridgeMode,
): Promise<boolean | { refusal: BridgeError }> {
  const supplied = secretValue(actor.secrets, 'closing_password');
  if (mode !== 'commit' || access.flags.closedPeriod !== true || supplied === null) return false;
  const origin = await getRequestOrigin();
  const limiter = loginLimiter();
  // As lib/context.ts: the person (in this company) and the global cap, never the address.
  const keys = attemptKeys('closing-password', `${companyId}:${actor.userId ?? ''}`, origin.addr).filter((k) => !k.includes(':addr:'));
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) {
    const secs = Number(tooManyAttempts(gate.retryAfterMs).retryAfter);
    return {
      refusal: {
        message: `Too many wrong closing-date passwords. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`,
        code: 'FORBIDDEN',
        details: { rateLimited: true, retryAfterSeconds: secs },
      },
    };
  }
  try {
    const ok = await verifyClosingDatePassword(db, companyId, supplied);
    if (ok) limiter.recordSuccess(keys.slice(0, -1));
    else limiter.recordFailure(keys, Date.now(), weights);
    return ok;
  } finally {
    gate.release();
  }
}

// ---------------------------------------------------------------------------
// Step 5: the request
// ---------------------------------------------------------------------------

const BAD_SEGMENT = /[\u0000-\u001f\u007f]/;

function badParam(name: string, why: string): { error: string } {
  return { error: `The path value "${name}" ${why}` };
}

/** The concrete path and the params the handler gets, from the route pattern and input.params. */
function buildPath(operation: Operation, given: unknown): { path: string; params: RouteParams } | { error: string } {
  if (given !== undefined && given !== null && !isObject(given)) return { error: 'Give params as names and values, for example { "id": "…" }.' };
  const values = (given ?? {}) as Record<string, unknown>;
  const extra = Object.keys(values).filter((k) => !operation.params.includes(k));
  if (extra.length) {
    return {
      error: `This operation has no path value ${extra.map((k) => `"${k}"`).join(', ')}.${operation.params.length ? ` It takes: ${operation.params.join(', ')}.` : ' It takes none.'}`,
    };
  }
  const check = (name: string, v: string): { error: string } | null => {
    if (!v) return badParam(name, 'is empty.');
    if (v.length > 500) return badParam(name, 'is too long.');
    if (v === '.' || v === '..') return badParam(name, 'cannot be "." or "..".');
    if (BAD_SEGMENT.test(v)) return badParam(name, 'holds characters a path cannot carry.');
    return null;
  };
  const out: string[] = [];
  const params: RouteParams = {};
  for (const seg of operation.route.split('/').filter(Boolean)) {
    if (!(seg.startsWith('[') && seg.endsWith(']'))) {
      out.push(seg);
      continue;
    }
    const name = seg.replace(/^\[+(\.\.\.)?/, '').replace(/\]+$/, '');
    const optional = seg.startsWith('[[');
    const catchAll = seg.includes('...');
    const v = values[name];
    if (v === undefined || v === null || v === '') {
      if (optional) continue;
      return { error: `Give params.${name}: this operation's path needs it.` };
    }
    if (typeof v !== 'string') return badParam(name, 'must be text.');
    if (catchAll) {
      const parts = v.split('/').filter(Boolean);
      for (const p of parts) {
        const bad = check(name, p);
        if (bad) return bad;
      }
      params[name] = parts;
      out.push(...parts.map(encodeURIComponent));
    } else {
      const bad = check(name, v);
      if (bad) return bad;
      params[name] = v;
      out.push(encodeURIComponent(v));
    }
  }
  return { path: `/${out.join('/')}`, params };
}

function buildQuery(given: unknown): URLSearchParams | { error: string } {
  const q = new URLSearchParams();
  if (given === undefined || given === null) return q;
  if (!isObject(given)) return { error: 'Give query as names and values, for example { "from": "2026-01-01" }.' };
  for (const [k, v] of Object.entries(given)) {
    const list = Array.isArray(v) ? v : [v];
    for (const item of list) {
      if (typeof item !== 'string') return { error: `The query value "${k}" must be text (or a list of texts).` };
      q.append(k, item);
    }
  }
  return q;
}

function isFileRef(v: unknown): v is FileRef {
  return isObject(v) && Object.keys(v).length === 1 && typeof v.fileId === 'string';
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Put `true` at a dotted path of a JSON body (a copy), making the objects on the way. */
function setFlag(body: Record<string, unknown>, dotted: string): string | null {
  const segs = dotted.split('.');
  if (segs.some((s) => !s || UNSAFE_KEYS.has(s))) return `The confirmation "${dotted}" cannot be set.`;
  let at: Record<string, unknown> = body;
  for (const s of segs.slice(0, -1)) {
    const next = at[s];
    if (next === undefined || next === null) at[s] = {};
    else if (!isObject(next)) return `The confirmation "${dotted}" cannot be set: the body's "${s}" is not an object.`;
    at = at[s] as Record<string, unknown>;
  }
  at[segs[segs.length - 1]] = true;
  return null;
}

/** Most file references one request may carry. */
const MAX_FILE_REFS = 20;

interface StagedBytes {
  file: StagedFile;
  bytes: Uint8Array;
}

async function readFileRef(owner: FileOwner, ref: FileRef, seen: Map<string, StagedBytes>): Promise<StagedBytes> {
  const known = seen.get(ref.fileId);
  if (known) return known;
  if (seen.size >= MAX_FILE_REFS) {
    throw new BridgeRefusal(`One request can use at most ${MAX_FILE_REFS} files.`, 'TOO_MANY_FILES');
  }
  const got = await readStagedFile(owner, ref.fileId);
  if (!got) {
    throw new BridgeRefusal(
      `The file "${ref.fileId}" is not there any more (staged files are cleared after a day). Upload it again and use the new file id.`,
      'FILE_NOT_FOUND',
      { fileId: ref.fileId },
    );
  }
  seen.set(ref.fileId, got);
  return got;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** A copy of a JSON value with every FileRef replaced by the base64 text of that staged file. */
async function withFiles(v: unknown, owner: FileOwner, seen: Map<string, StagedBytes>, depth = 0): Promise<unknown> {
  if (depth > 64) throw new BridgeRefusal('The body is nested too deeply.', 'VALIDATION');
  if (isFileRef(v)) return base64((await readFileRef(owner, v, seen)).bytes);
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) out.push(await withFiles(item, owner, seen, depth + 1));
    return out;
  }
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) out[k] = await withFiles(item, owner, seen, depth + 1);
    return out;
  }
  return v;
}

function isEmptyBody(v: unknown): boolean {
  return v === undefined || v === null || (isObject(v) && Object.keys(v).length === 0);
}

interface BuiltRequest {
  /** Read once, by the one handler call of this run. */
  req: NextRequest;
  /** The scope's synthetic header set: exactly what the request carries. */
  scopeHeaders: Record<string, string>;
}

/**
 * The NextRequest for http://127.0.0.1<path>?<query>: the method, the body in the operation's own
 * kind, confirmation flags set, files in place, and only headers in SERVICE_SCOPE_HEADERS.
 */
async function buildRequest(
  operation: Operation,
  path: string,
  input: OperationInput,
  owner: FileOwner,
  secretHeaders: Record<string, string>,
): Promise<BuiltRequest> {
  const query = buildQuery(input.query);
  if ('error' in query) throw new BridgeRefusal(query.error, 'VALIDATION');
  const flags = Array.isArray(input.confirm) ? [...new Set(input.confirm)] : [];
  const method = operation.method;
  const canHaveBody = method !== 'GET';
  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.8' };
  for (const [name, value] of Object.entries(secretHeaders)) {
    if (!SERVICE_SCOPE_HEADERS.includes(name.toLowerCase())) {
      throw new BridgeRefusal(
        'This operation needs a password that agent work cannot pass on yet. A person can do it in Ironbooks.',
        'SECRET_NOT_CARRIED',
      );
    }
    headers[name.toLowerCase()] = value;
  }

  const seen = new Map<string, StagedBytes>();
  let body: BodyInit | null = null;
  const kind = canHaveBody ? operation.body : 'none';
  if (!canHaveBody && !isEmptyBody(input.body)) {
    throw new BridgeRefusal('This operation reads and takes no body. Put what it needs in query or params.', 'VALIDATION');
  }
  if (kind === 'json') {
    let json = input.body === undefined || input.body === null ? {} : JSON.parse(JSON.stringify(input.body));
    if (flags.length) {
      if (!isObject(json)) throw new BridgeRefusal('Confirmations can only be added to a body that is an object.', 'VALIDATION');
      for (const f of flags) {
        const bad = setFlag(json, f);
        if (bad) throw new BridgeRefusal(bad, 'VALIDATION');
      }
    }
    json = await withFiles(json, owner, seen);
    body = JSON.stringify(json);
    headers['content-type'] = 'application/json';
  } else if (kind === 'bytes') {
    if (!isFileRef(input.body)) {
      throw new BridgeRefusal('This operation takes a file as its body: upload it first and send { "fileId": "…" } as the body.', 'VALIDATION');
    }
    const got = await readFileRef(owner, input.body, seen);
    body = new Blob([got.bytes as BlobPart]);
    headers['content-type'] = got.file.type || 'application/octet-stream';
  } else if (kind === 'multipart') {
    const given = input.body ?? {};
    if (!isObject(given)) {
      throw new BridgeRefusal('This operation takes a form: send { "fields": { … }, "files": { "<name>": { "fileId": "…" } } }.', 'VALIDATION');
    }
    const form = new FormData();
    const fields = given.fields ?? {};
    const files = given.files ?? {};
    if (!isObject(fields) || !isObject(files)) {
      throw new BridgeRefusal('Send the form as { "fields": { … }, "files": { "<name>": { "fileId": "…" } } }.', 'VALIDATION');
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    for (const f of flags) form.set(f, 'true');
    for (const [k, ref] of Object.entries(files)) {
      if (!isFileRef(ref)) throw new BridgeRefusal(`The form file "${k}" must be { "fileId": "…" }.`, 'VALIDATION');
      const got = await readFileRef(owner, ref, seen);
      form.append(k, new File([got.bytes as BlobPart], got.file.name, { type: got.file.type || 'application/octet-stream' }));
    }
    body = form;
  } else if (kind === 'text') {
    if (input.body !== undefined && input.body !== null && typeof input.body !== 'string') {
      throw new BridgeRefusal('This operation takes plain text as its body.', 'VALIDATION');
    }
    body = (input.body as string | undefined) ?? '';
    headers['content-type'] = 'text/plain; charset=utf-8';
  } else if (canHaveBody && !isEmptyBody(input.body)) {
    throw new BridgeRefusal('This operation takes no body.', 'VALIDATION');
  }
  // Flags the body cannot carry (no JSON or form body) go in the query, where such routes read them.
  if (kind !== 'json' && kind !== 'multipart') for (const f of flags) query.set(f, 'true');

  const qs = query.toString();
  const req = new NextRequest(`http://127.0.0.1${path}${qs ? `?${qs}` : ''}`, { method, headers, ...(body !== null ? { body } : {}) });
  // The scope's own set: what the handler's request carries (a form's boundary included).
  const scopeHeaders: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    // Never reached: every name above is from the list. A guard against a later edit here.
    if (!SERVICE_SCOPE_HEADERS.includes(name)) throw new Error(`The route bridge built a request with the header "${name}".`);
    scopeHeaders[name] = value;
  }
  return { req, scopeHeaders };
}

// ---------------------------------------------------------------------------
// Step 6: running the handler
// ---------------------------------------------------------------------------

interface RawAnswer {
  status: number;
  type: string;
  disposition: string | null;
  bytes: Uint8Array;
}

/**
 * Call the handler inside the service scope and read its whole answer there (a streamed answer
 * may still call into the app while it is read). With `failOnError` an answer of 400 or more is
 * thrown, so the effects collected so far are kept by the error and a transaction rolls back.
 */
async function invoke(
  handler: RouteHandler,
  request: BuiltRequest,
  params: RouteParams,
  ctx: ServiceContext,
  scope: ServiceScopeOptions,
  failOnError: boolean,
): Promise<RawAnswer> {
  return runWithServiceContext(ctx, scope, async () => {
    const res = await handler(request.req, { params: Promise.resolve(params) });
    if (!(res instanceof Response)) throw new Error('The route handler gave no answer.');
    const raw: RawAnswer = {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      disposition: res.headers.get('content-disposition'),
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
    if (failOnError && raw.status >= 400) throw new HandlerAnswered(raw);
    return raw;
  });
}

/** A time-out guard shared by a run and the timer racing it. */
interface Deadline {
  expired: boolean;
  /** Set just before a commit: from then on the time-out no longer fires. */
  finishing: boolean;
}

/**
 * Run `work` with a time limit. When the limit wins, `onTimeout` answers; the work goes on in the
 * background until it reaches a check of `deadline.expired` (and rolls back there).
 */
async function withDeadline(ms: number, work: (d: Deadline) => Promise<BridgeResult>, onTimeout: () => BridgeResult): Promise<BridgeResult> {
  const deadline: Deadline = { expired: false, finishing: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => {
      if (deadline.finishing) return;
      deadline.expired = true;
      resolve('late');
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  const running = work(deadline);
  running.catch(() => undefined); // nothing waits for it once the time is up
  try {
    const first = await Promise.race([running, late]);
    return first === 'late' ? onTimeout() : first;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Allowed folders
// ---------------------------------------------------------------------------

/** A folder name effects.writeFile may make: no separator, Windows stream mark, invisible character. */
const PLAIN_FOLDER_NAME = /^[^\\/:*?"<>|\p{Cc}\p{Cf}]+$/u;
/** Names Windows keeps for devices (lib/effects.ts DEVICE_NAME). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu;
/** Most folders one save may make below the nearest one that exists. */
const MAX_NEW_FOLDERS = 16;

/**
 * Where a file would be saved, when that is inside one of the agent's folders; else null. A folder
 * that does not exist yet (effects.writeFile makes it) counts by its nearest existing parent, which
 * must be allowed (links resolved by allowedFolder), with only plain folder names below it: those
 * do not exist, so no link can sit among them at the time of the check.
 */
async function allowedTarget(folders: readonly string[], dir: string): Promise<string | null> {
  if (!dir || !path.isAbsolute(dir)) return null;
  let at = path.resolve(dir);
  const missing: string[] = [];
  for (;;) {
    try {
      await fsp.lstat(at);
      break;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT') return null;
      const up = path.dirname(at);
      if (up === at || missing.length >= MAX_NEW_FOLDERS) return null;
      missing.unshift(path.basename(at));
      at = up;
    }
  }
  if (missing.some((name) => !PLAIN_FOLDER_NAME.test(name) || DEVICE_NAME.test(name) || /[. ]$/.test(name))) return null;
  const real = await allowedFolder(folders ?? [], at);
  return real ? path.join(real, ...missing) : null;
}

/** The first file an effect would save outside the agent's folders, as a refusal; else null. */
async function folderRefusal(effects: readonly EffectPreview[], folders: readonly string[]): Promise<BridgeRefusal | null> {
  for (const e of effects) {
    if (e.kind !== 'file') continue;
    const dir = typeof e.detail.dir === 'string' ? e.detail.dir : '';
    if (dir && (await allowedTarget(folders, dir))) continue;
    return new BridgeRefusal(
      `Saving a file in "${dir || 'an unnamed folder'}" is not allowed for this agent. An Admin can add the folder to the agent's folders in ${AGENTS_TAB}.`,
      'FOLDER_NOT_ALLOWED',
      { folder: dir },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the run did
// ---------------------------------------------------------------------------

interface AuditRow {
  action: string;
  entity_type: string;
  entity_id: string;
  old_values: unknown;
  new_values: unknown;
}

function asJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** The audit rows written so far in the current transaction (as changesInTransaction reads them). */
async function auditRowsInTransaction(ctx: ServiceContext): Promise<AuditRow[]> {
  const res = (await ctx.db.execute(sql`
    SELECT action::text AS action, entity_type, entity_id::text AS entity_id, old_values, new_values
      FROM audit_logs
     WHERE company_id = ${ctx.companyId} AND created_at = now()
     ORDER BY id`)) as unknown as { rows: AuditRow[] };
  return res.rows.map((r) => ({ ...r, old_values: asJson(r.old_values), new_values: asJson(r.new_values) }));
}

/** One ledger line of an entry made in the current transaction, as the database holds it. */
interface LedgerRow {
  entry_id: string;
  date: string | null;
  description: string | null;
  status: string | null;
  source_ref: string | null;
  reference: string | null;
  account_id: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  entity_type: string | null;
  entity_id: string | null;
  class_id: string | null;
}

/**
 * The lines of the entries made in the current transaction, with the amounts as decimal text and
 * the name each line is about (changesInTransaction leaves that out). For the staleness key and the
 * amount the run posts.
 */
async function ledgerRowsInTransaction(ctx: ServiceContext): Promise<LedgerRow[]> {
  const res = (await ctx.db.execute(sql`
    SELECT je.id::text AS entry_id, je.date::text AS date, je.description, je.status::text AS status,
           je.source_ref, je.reference, l.account_id::text AS account_id, l.debit::text AS debit,
           l.credit::text AS credit, l.memo, l.entity_type, l.entity_id::text AS entity_id, l.class_id::text AS class_id
      FROM journal_entries je
      JOIN journal_entry_lines l ON l.journal_entry_id = je.id
     WHERE je.company_id = ${ctx.companyId} AND je.created_at = now()`)) as unknown as { rows: LedgerRow[] };
  return res.rows;
}

/** Keys whose values a preview never shows (credentials, whatever their case). */
const SECRET_WORDS = /password|secret|token|apikey|api_key|privatekey|recoverykey|filekey/i;

/** Hide the sensitive and secret values of one field's value (a copy). */
function maskFieldValue(field: string, value: unknown, hidden: Set<string>, access: EffectiveAccess): unknown {
  const hide = (v: unknown) => (v === null || v === undefined || v === '' ? v : MASK);
  const walk = (key: string, v: unknown, depth: number): unknown => {
    if (hidden.has(key.toLowerCase()) || isSecretKey(key) || SECRET_WORDS.test(key)) return hide(v);
    if (depth > 32) return v;
    if (Array.isArray(v)) return v.map((item) => walk('', item, depth + 1));
    if (isObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v)) out[k] = walk(k, item, depth + 1);
      return out;
    }
    return v;
  };
  // maskSensitive: SSNs and account numbers to their last four, unless revealed for this call.
  const masked = maskSensitive({ [field]: value }, access)[field];
  return walk(field, masked, 0);
}

/**
 * Field-level changes from the audit rows: changed fields only, sensitive values masked. A field
 * named by the operation's sensitiveFields is hidden wherever it appears (its last part is
 * matched: the audit row holds the record, not the body the path was written for). `cut` is set
 * when a record had more changed fields than a preview keeps.
 */
function recordDiffs(rows: AuditRow[], operation: Operation, access: EffectiveAccess): { records: RecordDiff[]; cut: boolean } {
  const hidden = new Set(operation.sensitiveFields.map((p) => p.split('.').pop()!.toLowerCase()).filter((k) => k && k !== '*'));
  let cut = false;
  const records = rows.map((r) => {
    const before = isObject(r.old_values) ? r.old_values : {};
    const after = isObject(r.new_values) ? r.new_values : {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const fields: RecordDiff['fields'] = [];
    for (const k of keys) {
      const b = before[k] === undefined ? null : before[k];
      const a = after[k] === undefined ? null : after[k];
      if (stableJson(b) === stableJson(a)) continue;
      fields.push({ field: k, before: maskFieldValue(k, b, hidden, access), after: maskFieldValue(k, a, hidden, access) });
    }
    if (fields.length > PREVIEW_ROW_LIMIT) cut = true;
    return { action: r.action, kind: r.entity_type, id: r.entity_id, fields: fields.slice(0, PREVIEW_ROW_LIMIT) };
  });
  return { records, cut };
}

/** "This deletes for good: 1 estimate, 2 estimate lines." Null when nothing is deleted. */
function lossOf(rows: AuditRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.action === 'delete') counts.set(r.entity_type, (counts.get(r.entity_type) ?? 0) + 1);
  if (!counts.size) return null;
  const words = [...counts].map(([kind, n]) => {
    const name = kind.replace(/_/g, ' ');
    return `${n} ${n === 1 ? name : name.endsWith('s') ? name : `${name}s`}`;
  });
  return `This deletes for good: ${words.join(', ')}.`;
}

/** The largest single ledger entry's total debits, as decimal text (lib/money.ts, never a float). */
function largestEntryTotal(rows: readonly LedgerRow[]): string | null {
  const totals = new Map<string, ReturnType<typeof Money.zero>>();
  for (const r of rows) totals.set(r.entry_id, Money.add(totals.get(r.entry_id) ?? Money.zero(), r.debit));
  let best: ReturnType<typeof Money.zero> | null = null;
  for (const t of totals.values()) if (best === null || t.greaterThan(best)) best = t;
  return best === null ? null : toAmountString(best);
}

// ---------------------------------------------------------------------------
// The staleness key
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Most record ids of the input whose versions count (a request naming more is still one request). */
const MAX_NAMED_IDS = 1000;
/** Keys whose value is when something happened: the time of the run itself on a new value. */
const TIME_KEY = /(?:At|_at)$/;
const VERSION_KEYS = ['updatedAt', 'updated_at', 'editedAt', 'edited_at', 'version'] as const;

/**
 * The record-locking tables of lib/services/concurrency.ts (TABLES), keyed the same way: each one's
 * version column (versionField) moves on every change of the record (edit, void, payment applied).
 * Typed by VersionedEntity, so a table added there must be added here.
 */
const VERSIONED_TABLES: Record<VersionedEntity, PgTable> = {
  invoice: invoices,
  bill: bills,
  journal_entry: journalEntries,
  customer: customers,
  vendor: vendors,
  item: items,
  estimate: estimates,
  sales_order: salesOrders,
  sales_receipt: salesReceipts,
  credit_memo: creditMemos,
  purchase_order: purchaseOrders,
  expense: expenses,
  deposit: deposits,
  transfer: transfers,
  payment_received: paymentsReceived,
  bill_payment: billPayments,
  vendor_credit: vendorCredits,
  item_receipt: itemReceipts,
  paycheck: paychecks,
  employee: employees,
  account: accounts,
};

/** Every record id the input names (params, query, body, at any depth), lower case and sorted. */
function namedIds(input: OperationInput): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 64 || out.size >= MAX_NAMED_IDS) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (UUID.test(s)) out.add(s.toLowerCase());
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (isObject(v)) {
      for (const item of Object.values(v)) walk(item, depth + 1);
    }
  };
  walk(input.params, 0);
  walk(input.query, 0);
  walk(input.body, 0);
  return [...out].sort();
}

/**
 * The versions of the records `ids` names in this company, as "kind:id:version", sorted. Read in the
 * run's own transaction before the handler runs, so it is what the books said when the run began:
 * an invoice paid by someone else meanwhile, a customer or an item edited, gives another key even
 * when the run itself would write the same.
 */
async function versionsOf(db: DB, companyId: string, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  // Every id passed the UUID pattern (hex digits and dashes only), so it can be written in place.
  const list = sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`);
  const parts = VERSIONED_ENTITIES.map((entity) => {
    const table = VERSIONED_TABLES[entity];
    const col = table as unknown as Record<string, AnyPgColumn>;
    return sql`SELECT ${entity}::text AS kind, ${col.id}::text AS id, ${col[versionField(entity)]}::text AS v
                 FROM ${table} WHERE ${col.companyId} = ${companyId} AND ${col.id} = ANY(${list})`;
  });
  const res = (await db.execute(sql.join(parts, sql` UNION ALL `))) as unknown as { rows: Array<{ kind: string; id: string; v: string | null }> };
  return res.rows.map((r) => `${r.kind}:${r.id}:${r.v ?? ''}`).sort();
}

/**
 * A value as the key reads it: the record ids made by this run become "new:<kind>" (they are new on
 * every run), and keys that hold an id of a record's own row ("id"), the time of a change ("…At"),
 * or a secret are left out. References to records that already existed stay as they are.
 */
function keyValue(v: unknown, created: ReadonlyMap<string, string>, depth = 0): unknown {
  if (typeof v === 'string') return v.replace(UUID_IN_TEXT, (m) => created.get(m.toLowerCase()) ?? m.toLowerCase());
  if (depth > 32) return null;
  if (Array.isArray(v)) return v.map((item) => keyValue(item, created, depth + 1));
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) {
      if (k === 'id' || TIME_KEY.test(k) || isSecretKey(k) || SECRET_WORDS.test(k)) continue;
      out[k] = keyValue(item, created, depth + 1);
    }
    return out;
  }
  return v;
}

/** The version an audit row's old values carry, or null. */
function versionIn(values: unknown): string | null {
  if (!isObject(values)) return null;
  for (const k of VERSION_KEYS) {
    const v = values[k];
    if (v !== undefined && v !== null) return typeof v === 'string' ? v : stableJson(v);
  }
  return null;
}

/** Earlier version first: numbers by size, times by time, else as text. */
function earlier(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The parts of an effect that say what it does (not its size, nor a file id made for this run). */
function effectKey(e: EffectPreview, created: ReadonlyMap<string, string>): string {
  const d = isObject(e.detail) ? e.detail : {};
  const picked: Record<string, unknown> = { kind: e.kind };
  for (const k of ['to', 'cc', 'bcc', 'subject', 'dir', 'name', 'replaces', 'printer', 'copies', 'host', 'purpose']) {
    if (d[k] !== undefined) picked[k] = d[k];
  }
  if (Array.isArray(d.attachments)) picked.attachments = d.attachments.map((a) => (isObject(a) ? (a.name ?? null) : null));
  return stableJson(keyValue(picked, created));
}

/**
 * The staleness key (plan §7.4): a hash over what the run read and what it did, with what differs
 * on every run of the same request left out (keyValue). Lists are sorted: the audit trail's own
 * order is not the order of the work (its ids are random).
 */
function stalenessKeyOf(parts: {
  operation: Operation;
  status: number;
  named: readonly string[];
  ledger: readonly LedgerRow[];
  audit: readonly AuditRow[];
  effects: readonly EffectPreview[];
}): string {
  const created = new Map<string, string>();
  for (const r of parts.audit) if (r.action === 'create') created.set(r.entity_id.toLowerCase(), `new:${r.entity_type}`);
  for (const l of parts.ledger) created.set(l.entry_id.toLowerCase(), 'new:journal_entry');

  // The ledger: every line of every entry made, by account, amount, memo and name.
  const entries = new Map<string, LedgerRow[]>();
  for (const l of parts.ledger) entries.set(l.entry_id, [...(entries.get(l.entry_id) ?? []), l]);
  const amount = (v: string | null) => (v === null ? null : toAmountString(v));
  const ledger = [...entries.values()]
    .map((lines) =>
      stableJson(
        keyValue(
          {
            date: lines[0].date,
            description: lines[0].description,
            status: lines[0].status,
            source: lines[0].source_ref,
            reference: lines[0].reference,
            lines: lines
              .map((l) => stableJson(keyValue({ account: l.account_id, debit: amount(l.debit), credit: amount(l.credit), memo: l.memo, nameType: l.entity_type, name: l.entity_id, class: l.class_id }, created)))
              .sort(),
          },
          created,
        ),
      ),
    )
    .sort();

  // The records written: their values, and the version each record that already existed had
  // before the run (the earliest its audit rows show: a record changed twice shows its in-run
  // version on the second row).
  const records: string[] = [];
  const firstVersion = new Map<string, string>();
  for (const r of parts.audit) {
    const id = r.entity_id.toLowerCase();
    const isNew = created.get(id) === `new:${r.entity_type}`;
    records.push(
      stableJson({
        action: r.action,
        kind: r.entity_type,
        id: isNew ? `new:${r.entity_type}` : id,
        before: keyValue(r.old_values, created),
        after: keyValue(r.new_values, created),
      }),
    );
    const v = isNew ? null : versionIn(r.old_values);
    if (v !== null) {
      const k = `${r.entity_type}:${id}`;
      const seen = firstVersion.get(k);
      if (seen === undefined || earlier(v, seen) < 0) firstVersion.set(k, v);
    }
  }
  const versions = [...firstVersion].map(([k, v]) => `${k}:${v}`).sort();

  return sha256(
    stableJson({
      key: 'bridge-staleness-v2',
      operation: parts.operation.id,
      status: parts.status,
      named: parts.named,
      ledger,
      records: records.sort(),
      versions,
      effects: parts.effects.map((e) => effectKey(e, created)).sort(),
    }),
  );
}

interface Collected {
  preview: OperationPreview;
  /** The largest single entry the run posts, as decimal text (facts). */
  ledgerTotal: string | null;
  stalenessKey: string;
}

/** Read back what the run did, still inside its transaction. */
async function collect(
  ctx: ServiceContext,
  operation: Operation,
  access: EffectiveAccess,
  effects: EffectPreview[],
  named: readonly string[],
  status: number,
): Promise<Collected> {
  const ledger = await changesInTransaction(ctx);
  const lines = await ledgerRowsInTransaction(ctx);
  const rows = await auditRowsInTransaction(ctx);
  const { records, cut } = recordDiffs(rows, operation, access);
  const shown = capped(effects);
  const truncated =
    cut || shown.truncated || ledger.entries.length > PREVIEW_ROW_LIMIT || ledger.changes.length > PREVIEW_ROW_LIMIT || records.length > PREVIEW_ROW_LIMIT;
  return {
    ledgerTotal: largestEntryTotal(lines),
    stalenessKey: stalenessKeyOf({ operation, status, named, ledger: lines, audit: rows, effects }),
    preview: {
      ledger: { entries: ledger.entries.slice(0, PREVIEW_ROW_LIMIT), changes: ledger.changes.slice(0, PREVIEW_ROW_LIMIT) } satisfies ChangePreview,
      records: records.slice(0, PREVIEW_ROW_LIMIT),
      effects: shown.list,
      warnings: [],
      loss: lossOf(rows),
      routePreview: null,
      truncated,
    },
  };
}

/** One use of a standing permission; a grant that is gone or used up refuses the run. */
async function countGrantUse(tx: ServiceContext, grantId: string): Promise<void> {
  try {
    await useGrant(tx, grantId);
  } catch (err) {
    if (err instanceof ServiceError) throw new BridgeRefusal(err.message, err.code, err.details ?? { grantId });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 8: reading the answer
// ---------------------------------------------------------------------------

function isJsonType(type: string): boolean {
  return /[/+]json\b/i.test(type);
}

type Answer =
  | { kind: 'json'; body: unknown }
  | { kind: 'file'; name: string; type: string; bytes: Uint8Array }
  | { kind: 'empty' }
  | { kind: 'unreadable' };

const EXTENSIONS: Array<[RegExp, string]> = [
  [/pdf/i, '.pdf'],
  [/csv/i, '.csv'],
  [/spreadsheetml|excel/i, '.xlsx'],
  [/zip/i, '.zip'],
  [/text\/plain/i, '.txt'],
  [/xml/i, '.xml'],
];

/** The file name a Content-Disposition gives (filename* first), else one made from the operation. */
function fileNameOf(disposition: string | null, operation: Operation, type: string): string {
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (star) {
      try {
        const name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
        if (name) return name;
      } catch {
        /* a broken escape: try the plain name */
      }
    }
    const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(disposition);
    const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
    if (name) return name;
  }
  const ext = EXTENSIONS.find(([re]) => re.test(type))?.[1] ?? '';
  return `${operation.id}${ext}`;
}

function readAnswer(raw: RawAnswer, operation: Operation): Answer {
  if (raw.bytes.byteLength === 0) return { kind: 'empty' };
  const declaredFile = operation.output !== 'json';
  if (isJsonType(raw.type) || (!raw.type && !declaredFile)) {
    const textBody = Buffer.from(raw.bytes.buffer, raw.bytes.byteOffset, raw.bytes.byteLength).toString('utf8');
    try {
      return { kind: 'json', body: JSON.parse(textBody) };
    } catch {
      if (isJsonType(raw.type)) return { kind: 'unreadable' };
    }
  }
  const type = raw.type.split(';')[0].trim() || 'application/octet-stream';
  return { kind: 'file', name: fileNameOf(raw.disposition, operation, type), type, bytes: raw.bytes };
}

/** Warning markers the services put in `details` (or the answer's code), by the flag that accepts them. */
const WARNING_FLAGS: Record<string, string> = {
  CREDIT_LIMIT: 'overrideCreditLimit',
  PROGRESS_OVERBILL: 'allowOverBilling',
};
const DETAIL_FLAGS: Record<string, string> = {
  duplicateDocNumber: 'allowDuplicateNumber',
  duplicateNumber: 'allowDuplicateNumber',
  reconciledEdit: 'allowReconciledEdit',
};

/**
 * The confirmation flags a 409 names: the "do it anyway" fixes it offers (a patch that sets a flag
 * to true), a flag its details name, or a warning marker the services use. Only what the answer
 * says; a 409 that names none is an ordinary conflict.
 */
function namedFlags(body: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const fixes = Array.isArray(body.fixes) ? body.fixes : [];
  for (const fix of fixes) {
    const patch = isObject(fix) && Array.isArray(fix.patch) ? fix.patch : [];
    for (const p of patch) {
      if (isObject(p) && p.op === 'set' && typeof p.path === 'string' && p.value === true) out.add(p.path);
    }
  }
  const details = isObject(body.details) ? body.details : {};
  for (const key of ['overrideFlag', 'flag', 'confirmFlag', 'confirm']) {
    const v = details[key];
    if (typeof v === 'string') out.add(v);
    else if (isObject(v) && typeof v.path === 'string') out.add(v.path);
  }
  for (const marker of [details.warning, body.code]) {
    if (typeof marker === 'string' && WARNING_FLAGS[marker]) out.add(WARNING_FLAGS[marker]);
  }
  for (const [key, flag] of Object.entries(DETAIL_FLAGS)) if (details[key] === true) out.add(flag);
  return out;
}

interface Interpreted {
  outcome: BridgeResult['outcome'];
  result: unknown;
  warnings: WarningPreview[];
  error: BridgeError | null;
  produced: ProducedSecret[];
  /** The masked JSON answer of a success, for the facts. */
  answer: unknown;
  file: { name: string; type: string; bytes: Uint8Array } | null;
}

/** The answer as the agent may see it: masked, produced secrets taken out, warnings found. */
function interpret(raw: RawAnswer, operation: Operation, actor: BridgeActor, sentFlags: readonly string[]): Interpreted {
  const answer = readAnswer(raw, operation);
  const none: Interpreted = { outcome: 'ok', result: null, warnings: [], error: null, produced: [], answer: undefined, file: null };
  if (raw.status < 400) {
    if (answer.kind === 'file') return { ...none, file: answer };
    if (answer.kind === 'empty') return none;
    if (answer.kind === 'unreadable') {
      return { ...none, outcome: 'error', error: { message: 'Ironbooks answered, but the answer could not be read.', code: 'INTERNAL', details: null } };
    }
    const red = redactAnswer(operation, answer.body, { reveal: actor.reveal });
    return { ...none, result: red.answer, answer: red.answer, produced: red.produced };
  }
  // An error answer: the app's own message, code and details, masked like any answer.
  const fallback = `Ironbooks could not ${operation.method === 'GET' ? 'read this' : 'do this'} (status ${raw.status}).`;
  if (answer.kind !== 'json' || !isObject(answer.body)) {
    const words = answer.kind === 'file' && /^text\//i.test(answer.type)
      ? Buffer.from(answer.bytes).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 300)
      : '';
    return { ...none, outcome: 'error', error: { message: words || fallback, code: null, details: null } };
  }
  const body = redactAnswer(operation, answer.body, { reveal: actor.reveal }).answer;
  const b = isObject(body) ? body : {};
  const message = text(b.error) ?? text(b.message) ?? fallback;
  const code = text(b.code);
  const details = b.details !== undefined ? b.details : b.fields !== undefined ? { fields: b.fields } : null;
  if (raw.status === 409) {
    const named = namedFlags(answer.body as Record<string, unknown>);
    const flags = operation.confirmFlags.filter((f) => named.has(f));
    // A flag the agent already sent and the route still refuses cannot be confirmed again: asking
    // for it would loop. It is an error then.
    const fresh = flags.filter((f) => !sentFlags.includes(f));
    if (fresh.length) {
      return { ...none, outcome: 'needs_confirmation', warnings: fresh.map((flag) => ({ flag, message })) };
    }
  }
  return { ...none, outcome: 'error', error: { message, code, details } };
}

/**
 * The route's answer when a dry run stopped at a call to another computer (lib/effects.ts
 * EffectNotRunInPreview, answered as a refusal with details.notRunInPreview): its message. Null
 * for any other answer, which stays the error it is.
 */
function stoppedAtNetwork(raw: RawAnswer, operation: Operation, actor: BridgeActor, sentFlags: readonly string[]): string | null {
  const answer = readAnswer(raw, operation);
  if (answer.kind !== 'json' || !isObject(answer.body) || !isObject(answer.body.details) || answer.body.details.notRunInPreview !== true) return null;
  const seen = interpret(raw, operation, actor, sentFlags);
  return seen.error?.message ?? 'This would contact another computer. A preview does not contact other computers, so it stopped there.';
}

// ---------------------------------------------------------------------------
// Step 9: facts
// ---------------------------------------------------------------------------

/**
 * The request's facts, with the amount the run posts: the larger of what factsOf found and the
 * largest single entry, so an operation with no amountField still has a true amount. An operation
 * that names an amount field and whose amount factsOf could not read keeps null: that is "over
 * every limit" to the policy, and nothing the ledger shows makes it smaller.
 */
function factsFor(operation: Operation, input: OperationInput, closingDate: string | null, answer: unknown, ledgerTotal: string | null): RequestFacts {
  const facts = factsOf(operation, input, answer === undefined ? { closingDate } : { closingDate, answer });
  if (ledgerTotal === null) return facts;
  if (facts.amount === null) return operation.amountField ? facts : { ...facts, amount: ledgerTotal };
  try {
    return Money.gt(ledgerTotal, Money.abs(facts.amount)) ? { ...facts, amount: ledgerTotal } : facts;
  } catch {
    return { ...facts, amount: null };
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export const runOperation: RunOperation = async (base, operation, input, mode, actor) => {
  if (mode !== 'read' && mode !== 'dry_run' && mode !== 'commit') throw new Error(`Unknown bridge mode "${String(mode)}".`);
  assertRegistered(operation);
  const given: OperationInput = isObject(input) ? (input as OperationInput) : {};
  const startFacts = bareFacts(given);
  const refuse = (message: string, code: string, details: unknown = null) => errorResult(mode, startFacts, { message, code, details });

  // 1. What may never run here.
  if (operation.kind !== 'route') {
    return refuse('This is not an operation of the app\'s own pages, so it cannot run here. It runs through the desktop app.', 'NOT_A_ROUTE');
  }
  if (operation.availability !== 'agent') {
    return refuse(
      operation.availability === 'person_only'
        ? 'Only a person can do this, signed in to Ironbooks as themselves.'
        : 'This is never available to agents, with or without approval.',
      'NOT_AVAILABLE',
      { availability: operation.availability },
    );
  }
  const isRead = READ_CLASSES.includes(operation.class);
  if (mode === 'read' && !isRead) {
    return refuse('This operation changes the books, so it cannot run as a read. Try it out (dry run) or ask to run it.', 'NOT_A_READ');
  }
  if (mode === 'commit' && operation.hostOnly && !actor.atHost) {
    return refuse('This can only be approved at the computer that holds the company file, in its own Ironbooks window.', 'HOST_ONLY');
  }
  const confirm = given.confirm ?? [];
  if (!Array.isArray(confirm) || confirm.some((f) => typeof f !== 'string' || !operation.confirmFlags.includes(f))) {
    const notListed = Array.isArray(confirm) ? confirm.filter((f) => !operation.confirmFlags.includes(f as string)) : [];
    return refuse(
      operation.confirmFlags.length
        ? `This operation accepts only these confirmations: ${operation.confirmFlags.join(', ')}. Send one only after the operation warned about it.`
        : 'This operation takes no confirmations. Leave confirm out.',
      'UNKNOWN_CONFIRM_FLAG',
      { allowed: [...operation.confirmFlags], unknown: notListed },
    );
  }

  // 2. What the agent may never supply; secrets from the approving person, on a commit only.
  const guarded = guardInput(operation, given);
  if (guarded.refused) return refuse(guarded.refused, 'REFUSED', { stripped: guarded.stripped });
  const asked = guarded.input;
  let runInput: OperationInput = asked;
  let secretHeaders: Record<string, string> = {};
  if (mode === 'commit') {
    const secrets = actor.secrets ?? {};
    const applied = applySecrets(operation, asked, secrets);
    const missing = [...new Set([...applied.missing, ...operation.needsSecret.filter((k) => !secretValue(secrets, k))])];
    if (missing.length) {
      return refuse(
        'This needs a password or key that only the approving person can type. Ask for it to be approved, and the person types it on the approval card.',
        'SECRET_NEEDED',
        { secrets: missing },
      );
    }
    runInput = applied.input;
    secretHeaders = applied.headers;
  }

  // The concrete path, and the registry agreeing that it is this very operation (a param value
  // such as "expire" could otherwise reach the route /api/estimates/expire under another name).
  const built = buildPath(operation, runInput.params);
  if ('error' in built) return refuse(built.error, 'VALIDATION');
  const matched = operationForPath(operation.method, built.path);
  if (!matched || matched.operation.id !== operation.id) {
    return refuse('These path values lead to a different operation. Check params.', 'VALIDATION', { path: built.path });
  }

  // 3. What getServerContext would have checked for a person.
  const db = writableDb(base);
  const access = runAccess(actor, operation);
  const gates = await settleGates(db, base.companyId, actor, access, operation.method, built.path);
  if ('refusal' in gates) return errorResult(mode, startFacts, gates.refusal);

  // 4. The handler's context, from the actor only.
  const override = await closingOverride(db, base.companyId, actor, access, mode);
  if (typeof override !== 'boolean') return errorResult(mode, startFacts, override.refusal);
  const parts: RunContextParts = {
    companyId: base.companyId,
    access,
    // Never the owner: the agent is not the person who owns the company.
    role: actor.role === 'owner' ? legacyRoleFor(access, false) : actor.role,
    closingDateOverride: override,
    actor,
  };

  // 5. The request.
  const owner: FileOwner = { companyId: base.companyId, agentId: actor.agent.id };
  let request: BuiltRequest;
  try {
    request = await buildRequest(operation, built.path, runInput, owner, mode === 'commit' ? secretHeaders : {});
  } catch (err) {
    if (err instanceof BridgeRefusal) return refuse(err.message, err.code, err.details);
    throw err;
  }
  const scope: ServiceScopeOptions = { path: built.path, method: operation.method, headers: request.scopeHeaders };
  const sentFlags = Array.isArray(asked.confirm) ? asked.confirm : [];

  // A dry run of what cannot be rolled back is described, not run. (A read is simply read.)
  if (!isRead && mode === 'dry_run' && operation.dryRun !== 'transaction') {
    const effects: EffectPreview[] = operation.effects.map((kind) => ({ kind, summary: EFFECT_WORDS[kind], detail: { declared: true } }));
    return {
      ...blank(mode, factsOf(operation, asked, { closingDate: gates.closingDate })),
      preview: {
        ledger: null,
        records: [],
        effects,
        warnings: [],
        loss: null,
        routePreview: { ran: false, note: NOT_TRIED[operation.dryRun] },
        truncated: false,
      },
    };
  }

  // 6. Run.
  const handler = await loadRouteHandler(operation);
  const limit = isReportRoute(operation.route) ? BRIDGE_REPORT_TIME_LIMIT_MS : BRIDGE_TIME_LIMIT_MS;
  const facts = (answer: unknown, ledgerTotal: string | null) => factsFor(operation, asked, gates.closingDate, answer, ledgerTotal);
  const timeout = () =>
    errorResult(mode, startFacts, {
      message:
        `This took longer than ${Math.round(limit / 1000)} seconds, so it was stopped` +
        (isRead ? '.' : ' and nothing was saved.') +
        ' Try a smaller request, or ask again when Ironbooks is less busy.',
      code: 'TIMEOUT',
      details: { seconds: Math.round(limit / 1000) },
    });

  /** Turn what a run threw into its answer. */
  const failed = (err: unknown, effects: EffectReport[] = []): BridgeResult => {
    if (err instanceof TimedOut) return timeout();
    if (err instanceof RolledBack) return err.result;
    if (err instanceof BridgeRefusal) return errorResult(mode, startFacts, { message: err.message, code: err.code, details: err.details }, err.httpStatus, effects);
    if (err instanceof HandlerAnswered) {
      const seen = interpret(err.raw, operation, actor, sentFlags);
      return {
        ...blank(mode, facts(undefined, null)),
        httpStatus: err.raw.status,
        outcome: seen.outcome,
        warnings: seen.warnings,
        error: seen.error,
        effects,
      };
    }
    const known = translateLedgerDbError(err);
    if (known instanceof ServiceError) return errorResult(mode, startFacts, serviceErrorAsBridgeError(known), serviceErrorStatus(known.code), effects);
    console.error('[agent bridge]', operation.id, err);
    return errorResult(
      mode,
      startFacts,
      {
        message: isRead ? 'Something went wrong while reading this.' : 'Something went wrong while doing this, so nothing was saved.',
        code: 'INTERNAL',
        details: null,
      },
      500,
      effects,
    );
  };

  /**
   * Call the handler with its effects collected. A file it would save outside the agent's folders
   * fails the run inside the collection, so the calls to other computers it already made are still
   * reported (effectsOfFailedRun) and nothing queued is ever released. `kept` says the work itself
   * cannot be undone (a dryRun 'none' commit), so the refusal says what did and did not happen.
   */
  const collectRun = (effectsMode: EffectsMode, ctx: ServiceContext, kept: boolean): Promise<EffectsRun<RawAnswer>> =>
    runWithEffects(effectsMode, async () => {
      const raw = await invoke(handler, request, built.params, ctx, scope, true);
      const refusal = await folderRefusal(currentEffects() ?? [], actor.folders);
      if (refusal) {
        throw new BridgeRefusal(
          kept
            ? `${refusal.message} The rest of the work was done and kept, but none of the emails, files or print jobs it asked for were sent.`
            : refusal.message,
          refusal.code,
          refusal.details,
          raw.status,
        );
      }
      return raw;
    });

  const stage = (file: Interpreted['file']) => (file ? stageFile(owner, file) : Promise.resolve(null));

  if (isRead) {
    return withDeadline(limit, async (d) => {
      try {
        const ctx = handlerContext(readOnlyDb(db), parts, true);
        const run = await runWithEffects('capture', () => invoke(handler, request, built.params, ctx, scope, false));
        const seen = interpret(run.value, operation, actor, sentFlags);
        if (d.expired) return timeout();
        const file = seen.outcome === 'ok' ? await stage(seen.file) : null;
        const shown = capped(run.effects);
        return {
          ...blank(mode, facts(seen.answer, null)),
          httpStatus: run.value.status,
          outcome: seen.outcome,
          result: seen.result,
          file,
          // A read asked for as a dry run or a commit still only read: nothing was kept or sent.
          preview: mode === 'read' ? null : { ledger: null, records: [], effects: shown.list, warnings: [], loss: null, routePreview: null, truncated: shown.truncated },
          warnings: seen.warnings,
          error: seen.error,
          produced: seen.produced,
        };
      } catch (err) {
        return failed(err);
      }
    }, timeout);
  }

  if (mode === 'dry_run') {
    return withDeadline(limit, async (d) => {
      try {
        await db.transaction(async (txRaw) => {
          const ctx = handlerContext(txRaw as unknown as DB, parts, false);
          const named = await versionsOf(ctx.db, base.companyId, namedIds(asked));
          const run = await collectRun('capture', ctx, false);
          if (d.expired) throw new TimedOut();
          await ctx.db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          const done = await collect(ctx, operation, access, run.effects, named, run.value.status);
          const seen = interpret(run.value, operation, actor, sentFlags);
          throw new RolledBack({
            ...blank(mode, facts(seen.answer, done.ledgerTotal)),
            httpStatus: run.value.status,
            outcome: seen.outcome,
            result: seen.result,
            // Nothing was kept, so nothing is staged and no secret was really made.
            preview: done.preview,
            stalenessKey: done.stalenessKey,
          });
        });
      } catch (err) {
        // A dry run that reached a call to another computer stops there (lib/effects.ts): what it
        // would do up to there is the preview, it says where it stopped, and a person decides.
        const note = err instanceof HandlerAnswered ? stoppedAtNetwork(err.raw, operation, actor, sentFlags) : null;
        if (err instanceof HandlerAnswered && note !== null) {
          const shown = capped(effectsOfFailedRun(err)?.effects ?? []);
          return {
            ...blank(mode, facts(undefined, null)),
            httpStatus: err.raw.status,
            preview: { ledger: null, records: [], effects: shown.list, warnings: [], loss: null, routePreview: { ran: false, note }, truncated: shown.truncated },
          };
        }
        return failed(err);
      }
      throw new Error('The dry run did not finish.');
    }, timeout);
  }

  // Commit of an operation whose service opens its own database handle: no wrapping transaction
  // (it could not be rolled back anyway), still inside the scope and the outbox.
  if (operation.dryRun === 'none') {
    let run: EffectsRun<RawAnswer> | null = null;
    try {
      if (actor.approval?.grantId) {
        const grantId = actor.approval.grantId;
        // Counted first, in its own transaction: a failed run then uses it up, never the other way.
        await db.transaction(async (txRaw) => countGrantUse(handlerContext(txRaw as unknown as DB, parts, false), grantId));
      }
      run = await collectRun('defer', handlerContext(db, parts, false), true);
      const seen = interpret(run.value, operation, actor, sentFlags);
      const file = await stage(seen.file);
      const shown = capped(run.effects);
      const effects = await run.release();
      return {
        ...blank(mode, facts(seen.answer, null)),
        httpStatus: run.value.status,
        outcome: seen.outcome,
        result: seen.result,
        file,
        preview: { ledger: null, records: [], effects: shown.list, warnings: [], loss: null, routePreview: null, truncated: shown.truncated },
        warnings: seen.warnings,
        error: seen.error,
        effects,
        produced: seen.produced,
      };
    } catch (err) {
      run?.discard();
      return failed(err, effectsOfFailedRun(err)?.ran ?? []);
    }
  }

  return withDeadline(limit, async (d) => {
    try {
      const kept = await db.transaction(async (txRaw) => {
        const ctx = handlerContext(txRaw as unknown as DB, parts, false);
        if (actor.approval?.grantId) await countGrantUse(ctx, actor.approval.grantId);
        const named = await versionsOf(ctx.db, base.companyId, namedIds(asked));
        const run = await collectRun('defer', ctx, false);
        try {
          if (d.expired) throw new TimedOut();
          await ctx.db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          const done = await collect(ctx, operation, access, run.effects, named, run.value.status);
          const seen = interpret(run.value, operation, actor, sentFlags);
          if (seen.outcome !== 'ok') {
            // A success answer that cannot be read: nothing is kept, so the agent never retries
            // work that was in fact saved.
            throw new BridgeRefusal(`${seen.error?.message ?? 'The answer could not be read.'} Nothing was saved.`, seen.error?.code ?? 'INTERNAL', null, run.value.status);
          }
          const file = await stage(seen.file);
          const result: BridgeResult = {
            ...blank(mode, facts(seen.answer, done.ledgerTotal)),
            httpStatus: run.value.status,
            outcome: seen.outcome,
            result: seen.result,
            file,
            preview: done.preview,
            stalenessKey: done.stalenessKey,
            produced: seen.produced,
          };
          if (d.expired) throw new TimedOut();
          d.finishing = true;
          return { run, result };
        } catch (err) {
          run.discard();
          throw err;
        }
      });
      // Committed: only now does anything leave the database.
      return { ...kept.result, effects: await kept.run.release() };
    } catch (err) {
      // Calls to other computers a failed run had already made did happen: say so.
      return failed(err, effectsOfFailedRun(err)?.ran ?? []);
    }
  }, timeout);
};
