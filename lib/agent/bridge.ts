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
 * Secrets (plan 5.8): only from actor.secrets (typed by the approving person), put in place by
 * applySecrets (lib/agent/guards.ts), never from the agent's input (guardInput strips them, and
 * nothing of the input ever becomes a header). All of them on a commit; on a dry run only the
 * closing-date password, so the rolled-back try an approval makes of closed-period work is judged
 * on its real figures (nothing a dry run reads with it is protected: it only lets dates on or
 * before the closing date through); never in a read. The headers they travel in are exactly
 * SERVICE_SCOPE_SECRET_HEADERS (the closing-date password, and the user name, password and recovery
 * key that open a backup, a portable file or an Accountant's Copy). A secret the route itself can do
 * without (OPTIONAL_ROUTE_SECRETS: a backup made in this same file needs no sign-in) is not asked
 * for before the route runs; the route says so if it needs it after all.
 *
 * The closing-date password the approver typed is checked ONCE per run, here, before the route
 * runs, with the one limiter of that password (lib/closingPasswordLimiter.ts) under the approving
 * person's own keys, read outside the scope: a wrong one refuses the run at once, whatever the work
 * (a password typed on the card is taken as needed), a locked limiter refuses even the right one,
 * so approvals cannot be used to try passwords. (An approval runs the work twice, the rolled-back
 * try and the commit: a right password is counted right twice, a wrong one stops the first.) A
 * right one sets the closing-date
 * override for an access holding the closed-period right, and the scope is marked as having
 * checked it, so Set Closing Date takes that same password as its current one without counting it
 * a second time, in the scope's realm (lib/serviceScope.ts closingPasswordCheckedInScope).
 *
 * The staleness key (plan §7.4) covers the records the run reads and changes that existed before
 * it: the versions of the records the input names (read in the same transaction, before the handler
 * runs), the ledger lines it posts, the field values of every record it writes, and the emails,
 * files and print jobs it asks for. What the run assigns to itself is left out, and only that: the
 * next free document, check or entry number it takes, or the next position (a new bank rule's
 * priority, a new account's number), from the columns where the services take it (TAKEN_COLUMNS),
 * on what it makes and on a record that was there before with no number (a check marked printed),
 * left out only under a key naming that column, and that number where its own text repeats it
 * ("Invoice #1043"); every id that did not exist
 * before the run, wherever it shows (a value, a source reference, a journal reference made of its
 * first 8 hex digits); the times on what it makes, a date it fills in as today, and its own clock.
 * Every other number and time stays (a reference or a P.O. number the run copies, an account,
 * routing, tax, serial or lot number, any time of a record that was there before). So two runs
 * over the same books agree, two waiting requests that each take "the next number" do not make
 * each other stale, nor does midnight, a posting elsewhere that touches none of the request's
 * records changes nothing, and a price, a rate or a named record changed in between gives another
 * key.
 *
 * The handler's request also carries, besides the scope's headers:
 *  - the version of the record the agent last read (OperationInput.expectedUpdatedAt), as
 *    x-expected-updated-at, so the route's own withVersionCheck compares it inside the committing
 *    transaction: a person's edit made in between answers 409, never an overwrite;
 *  - this launch's pass (lib/net/launchPass.ts), only for a run a person approved at the host
 *    computer's own window (actor.atHost), so a route that asks whether the request came from
 *    the Ironbooks window here (lib/net/hostOnly.ts isRemoteRequest) answers yes, as it would for
 *    that person. Only on the handler's own request object, in memory for that one run: never in
 *    the scope's header set, never stored, never in anything the agent is answered.
 *
 * A dry run sent with confirmation flags is first tried without them, in a savepoint that is rolled
 * back, so the warnings those flags accept are in its preview (preview.warnings): the person
 * approving it reads the question they would have answered in the window (plan §5.6).
 *
 * No agent may change or delete a role any agent holds (plan §4.6, D9): such a run is refused
 * here, on every way in (a dry run, a run, a run under standing permission, an approved run), and
 * however the role's id is written (upper case, braces or no hyphens name the same role). The
 * agents counted are those not removed, as everywhere else a held role is judged.
 *
 * Files an operation saves (effects.writeFile) must land inside one of the agent's folders
 * (lib/agent/files.ts allowedFolder): the folder itself, or, when it does not exist yet, its
 * nearest existing parent with only plain names below it. The effects are collected with
 * { pinFiles: true }, so effects.writeFile does not look at the disk itself; the bridge looks at a
 * path only once it is known, as text, to be inside an allowed folder (allowedTarget). (The route's
 * own code could still look at a folder it is given; no route takes one from the agent today.) The
 * check is made inside the effects collection, so a refused run still reports the calls to other
 * computers it already made, and each allowed file is pinned to the real folder checked
 * (lib/effects.ts pinFile): it is written there, and only while that folder still resolves to
 * itself. A file the work asks for after the last check is never written (FILE_NOT_CHECKED).
 *
 * Never throws for what the handler answered: a refusal, an error answer, a time-out or a failed
 * commit all come back as outcome 'error' with the app's own message. It throws only for a
 * programming error (an unknown mode, an operation object the registry did not hand out).
 *
 * Time limits (BRIDGE_TIME_LIMIT_MS, reports BRIDGE_REPORT_TIME_LIMIT_MS): PGlite runs one
 * transaction at a time, so a long run blocks the app. On time-out the answer says the work took
 * too long; work still running is rolled back when it reaches the end (it cannot be interrupted
 * in the middle), and it releases nothing. A commit of a dryRun 'none' operation has a longer limit
 * of its own (IRREVERSIBLE_COMMIT_TIME_LIMIT_MS, 10 minutes, see there): its service opens its own
 * database handle, so the bridge cannot undo it, only answer that it may still finish and abandon
 * its effects; work not yet started by then never starts.
 *
 * The amount (facts): the run's ledger, all of it. Entries it makes (changesInTransaction), and
 * entries that existed and that it voids, deletes or changes in place (touchedEntries): both are
 * shown in the ledger preview, and counted when the run moves their money (a void, a delete, lines
 * rewritten, a draft posted; not a new title, number or link), so voiding a $50,000 check is a
 * $50,000 request, and voiding it while posting an unrelated $50,000 is $100,000 (with an amount
 * field or without; an edit that voids and re-posts its own document counts once). See factsFor for
 * the rules: "0.00" for a run that only makes new records and moves no entry, unknown for one that
 * voids, deletes or edits a record that existed and touches no entry (its money cannot be seen).
 *
 * The preview is read by the agent as well as the approver, so its ledger memos, descriptions and
 * field values hide what the run's own answer would: account numbers in memo or description text
 * are masked (shownText, lib/services/journal.ts lineMemoFor) unless a reveal was approved. Each
 * ledger line names who it is for (the customer, vendor, employee or other name: whose A/R or A/P
 * it is) and its class (NamedPostingLine), masked the same way.
 */
import { createHash } from 'node:crypto';
import { promises as fsp, type Stats } from 'node:fs';
import path from 'node:path';
import { and, eq, or, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { NextRequest } from 'next/server';
import { resolveDataDir, sealedMode, type DB } from '@/lib/db';
import { isReadOnlyDb, readOnlyDb } from '@/lib/db/readOnly';
import { dataDirOf, rootDbOf } from '@/lib/db/txHooks';
import {
  accounts,
  agentPermissionRequests,
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
  SERVICE_SCOPE_SECRET_HEADERS,
  isArchivedCompany,
  runWithServiceContext,
  type ServiceScopeOptions,
} from '@/lib/context';
import { AGENT_NOT_READY_MESSAGE, AGENT_SANDBOX_MESSAGE } from '@/lib/agentContext';
import { limitClosingPasswordGuess } from '@/lib/closingPasswordLimiter';
import { localDateISO } from '@/lib/dates';
import { currentEffects, effectsOfFailedRun, pinFile, runWithEffects, type EffectReport, type EffectsMode, type EffectsRun } from '@/lib/effects';
import { featureOffError } from '@/lib/featureGate';
import { Money, toAmountString } from '@/lib/money';
import { LAUNCH_PASS_HEADER, expectedLaunchPass } from '@/lib/net/launchPass';
import { blockingFeatureGate, resolveCompanyPreferences, todayInTimeZone } from '@/lib/preferences';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { isSecretKey, maskSensitive } from '@/lib/permissions/mask';
import { legacyRoleFor, type EffectiveAccess } from '@/lib/permissions/model';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { assertAccountantCopyAllowsPath } from '@/lib/services/accountantCopy/routeGate';
import { AGENTS_BLOCKED_MESSAGE } from '@/lib/services/agents';
import { useGrant } from '@/lib/services/agentGrants';
import { verifyClosingDatePassword } from '@/lib/services/company';
import { EXPECTED_VERSION_HEADER, VERSIONED_ENTITIES, versionField, type VersionedEntity } from '@/lib/services/concurrency';
import { getFileLockStatus } from '@/lib/services/fileLock';
import { lineMemoFor, resolveEntityNames } from '@/lib/services/journal';
import { assertPasswordChangeNotRequired } from '@/lib/services/passwordPolicy';
import { isSandboxActive } from '@/lib/services/sandboxState';
import { getSingleUserMode } from '@/lib/services/sessions';
import { agentsHoldingRole, heldRoleKeyForm } from '@/lib/services/users';
import { ServiceError, inTransaction, translateLedgerDbError, writeAudit, type ServiceContext } from '@/lib/services/_base';
import { changesInTransaction, type ChangePreview, type PostingEntry, type PostingLine } from './actions';
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
import { factsOf, withLedgerAccounts } from './facts';
import { allowedFolder, overlapsAppData, readStagedFile, stageAnswerFile } from './files';
import { applySecrets, guardInput, maskAccountsInText, plainIsoTime, redactAnswer } from './guards';
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

/**
 * Why a dry run was not tried out (routePreview { ran: false, note }). The agent reads it, and the
 * person's approval card shows it as "Ironbooks' note" under its own "Ironbooks did not try this
 * ahead of time" (app/agent-requests/Preview.tsx), so it gives the reason, true and in words that
 * read well for both, and leaves the decision with the person approving it.
 *  - preview: its own preview is the SAME operation sent with its preview option (a flag in the
 *    body or the query, or a preview action: the bulk list saves, price changes, a reorder, a
 *    paycheck, receiving, the batch entry, the exchange-rate adjustment, the QuickBooks imports,
 *    opening a portable file or an Accountant's Copy), which is a run of that operation like any
 *    other, so it may need approval too; there is no separate operation to look for. Not every
 *    description names the option, so the note does not point there.
 *  - answer: a read the agent may see only once a person approves it (a GET of class admin, file,
 *    outside ...): running it ahead of time would hand over its answer first.
 *  - none: work that cannot be rolled back (dryRun 'none').
 */
const NOT_TRIED: Record<'preview' | 'answer' | 'none', string> = {
  preview:
    'This operation has a preview mode of its own: the same operation, sent with its preview option. That preview is a run like any other, so it may need approval too. Nothing was changed.',
  answer:
    'Running it ahead of time would hand its answer to the agent before a person approved it. Nothing was read or changed; the person approving it decides from its description.',
  none: 'It cannot be run and then undone: it works outside the books, or on the company file itself. Nothing was changed; the person approving it decides from its description.',
};

/** A request that only reads by its method (GET), whatever its class. */
function readsByMethod(operation: Operation): boolean {
  return operation.method === 'GET';
}

/**
 * Time limit of a commit of a dryRun 'none' operation, work that cannot be undone: 10 minutes. Such
 * work runs on a database handle of its own or outside the books (restoring or opening a backup, a
 * portable file or an Accountant's Copy, making a copy of the company file, condensing archives, a
 * year-end close, a test email), so the bridge can neither roll it back nor stop it part way, and it
 * can rightly take far longer than an entry: copying or restoring a company file reads and writes
 * all of it, on a slow disk or a shared folder, and an outside call waits on the other computer.
 * The 10 seconds of BRIDGE_TIME_LIMIT_MS would answer "took too long" for work that then finishes
 * anyway. The limit is only there so the approving person's window and the agent are never left
 * waiting for ever on work that hangs (a PGlite lock wait, a server that never answers); 10 minutes
 * is well past the longest such work seen, yet short enough that a person still waiting at the
 * window is told. Work that has not started when it passes never starts.
 */
export const IRREVERSIBLE_COMMIT_TIME_LIMIT_MS = 10 * 60 * 1000;

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
  /** The company's time zone (its "today" for a date a service fills in), or null. */
  timeZone: string | null;
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
  const zone = resolveCompanyPreferences(settings).timezone;
  return {
    closingDate: typeof settings.closingDate === 'string' ? settings.closingDate : null,
    timeZone: typeof zone === 'string' && zone.trim() ? zone : null,
  };
}

/** What the closing-date password the approving person typed does for this run. */
interface ClosingCheck {
  /** The closing-date override: the password is right, and the access holds the closed-period right. */
  override: boolean;
  /** It was checked here and is right: the scope says so, and the route does not count it again. */
  checked: boolean;
}

/** Said when the closing-date password typed on the approval card is not the right one. */
export const CLOSING_PASSWORD_WRONG_MESSAGE =
  'The closing-date password typed on the approval card is not correct, so nothing was done. The request has to be sent again and approved with the right password.';

/**
 * The closing-date password the approving person typed, checked once, before the route runs (a dry
 * run or a commit; a read never gets one). Every guess goes through the one limiter of the
 * closing-date password (lib/closingPasswordLimiter.ts) under the approving person's own keys: the
 * request the bridge runs in, read here, outside the scope, the same keys as that person's own
 * x-closing-password and Set Closing Date in their window. So an approver without the password
 * cannot use approvals to try passwords until one works, nor spread guesses over the ways in. A
 * locked limiter refuses even the right one. A right one sets the override only for an access that
 * holds the closed-period right; either way the route takes it without counting it again.
 *
 * A wrong one refuses the run at once: the route never runs and nothing hashes it a second time.
 * A password typed on the card is always taken as needed: the card shows the box only when it asks
 * for one, and whether the work needs it cannot always be told before it runs (a void sent with
 * only the record's id, of a record dated in the closed period), so the person is told the true
 * reason, never the route's closed-period words after a wrong password was dropped.
 */
async function closingPasswordCheck(
  db: DB,
  companyId: string,
  actor: BridgeActor,
  access: EffectiveAccess,
  mode: BridgeMode,
): Promise<ClosingCheck | { refusal: BridgeError }> {
  const none: ClosingCheck = { override: false, checked: false };
  const supplied = secretValue(actor.secrets, 'closing_password');
  if (mode === 'read' || supplied === null) return none;
  let right: boolean;
  try {
    right = await limitClosingPasswordGuess({ companyId, userId: actor.userId }, () => verifyClosingDatePassword(db, companyId, supplied));
  } catch (err) {
    if (err instanceof ServiceError) return { refusal: serviceErrorAsBridgeError(err) };
    throw err;
  }
  if (!right) return { refusal: { message: CLOSING_PASSWORD_WRONG_MESSAGE, code: 'FORBIDDEN', details: { closingPassword: 'wrong' } } };
  return { override: access.flags.closedPeriod === true, checked: true };
}

/**
 * Secrets a route goes ahead without when none was typed (ApprovalNeeds.optionalSecrets, wave 4).
 * The sign-in of another company file, for a backup or an archive sealed with that file's key: a
 * backup made in this same file needs none (lib/net/archiveCredentials.ts reads the headers only
 * when they are there), so an approval without it is right, and the route answers in its own words
 * when it does need one. Every other secret a route lists, it always needs: a commit without it is
 * refused before anything runs.
 */
export const OPTIONAL_ROUTE_SECRETS: readonly SecretKind[] = ['archive_credentials'];

/**
 * A run a person approved at the host computer's own window: the approver is the actor's person,
 * and the approval names them. Only then does the handler's request carry this launch's pass.
 */
function approvedAtHost(actor: BridgeActor): boolean {
  return actor.atHost === true && typeof actor.userId === 'string' && actor.userId.length > 0 && actor.approval?.approvedBy === actor.userId;
}

/** Longest version text sent on (an ISO time is 24 characters). */
const MAX_VERSION_LENGTH = 40;

/** Why an expectedUpdatedAt is refused (here, and by the door: lib/agent/operate.ts withVersion). */
export const EXPECTED_VERSION_MESSAGE =
  'Send expectedUpdatedAt as the record\'s updatedAt exactly as Ironbooks answered it, with its time zone (for example "2026-11-22T14:05:09.123Z"), or leave it out.';

/**
 * OperationInput.expectedUpdatedAt, the version of the record the agent last read, as the route's
 * record locking reads it (lib/services/concurrency.ts expectedVersion): a time Date can read, sent
 * as given. Taken from the input the bridge was handed (guardInput keeps only what it knows), and
 * checked here: it is text that becomes a header, so only the characters a time is written with,
 * and a plain ISO time with its zone (guards.ts plainIsoTime): a time with no zone would be read in
 * this computer's own time zone, hours away from the version the agent read.
 */
function expectedVersionOf(input: OperationInput): { value: string | null } | { error: string } {
  const v = (input as { expectedUpdatedAt?: unknown }).expectedUpdatedAt;
  if (v === undefined || v === null || v === '') return { value: null };
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > MAX_VERSION_LENGTH || !/^[0-9TZ:.+\- ]+$/.test(s) || plainIsoTime(s) === null) {
    return { error: EXPECTED_VERSION_MESSAGE };
  }
  return { value: s };
}

/**
 * A role key as the held-role check compares it: lower case, and a uuid without its braces and
 * hyphens. The role route reads the id as a Postgres uuid, which takes upper case, braces and
 * missing hyphens alike ("{0A1B…}" and "0a1b…" name the same role), so the check must not tell
 * them apart either. The one form every check of a held role uses (lib/services/users.ts
 * heldRoleKeyForm), so they cannot drift apart.
 */
function roleKeyForm(key: string): string {
  return heldRoleKeyForm(key) ?? key.trim().toLowerCase();
}

/** The canonical uuid text of a role key in roleKeyForm, or null when it is not a uuid. */
function canonicalUuidOf(form: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(form)) return null;
  return `${form.slice(0, 8)}-${form.slice(8, 12)}-${form.slice(12, 16)}-${form.slice(16, 20)}-${form.slice(20)}`;
}

/**
 * No agent may change or delete a role that any agent holds (plan §4.6, D9): changing it would
 * change what that agent, perhaps the very one asking, may do. A hard-floor refusal on every way
 * in, whatever the approval: the role editor of Users & Roles (PATCH, PUT or DELETE /api/roles/[id])
 * naming a role in the roleKeys of an agent of this company, however the id is written
 * (roleKeyForm: the role compared by its canonical id). A held role is judged the same way
 * everywhere, by the one count lib/services/users.ts refuseAgentOnAgentRole uses too
 * (agentsHoldingRole): the agents that are not removed (revoked). A paused agent still holds its
 * roles; a removed one holds none. Null when the run may go on.
 */
async function heldRoleRefusal(db: DB, companyId: string, operation: Operation, params: RouteParams): Promise<BridgeError | null> {
  if (operation.route !== '/api/roles/[id]' || operation.method === 'GET') return null;
  const key = typeof params.id === 'string' ? params.id : '';
  if (!key.trim()) return null;
  const form = roleKeyForm(key);
  if (!((await agentsHoldingRole(db, companyId, key)) > 0)) return null;
  const canonical = canonicalUuidOf(form);
  let name = canonical ?? key;
  if (canonical) {
    const role = (await db.execute(sql`SELECT name FROM company_roles WHERE id = ${canonical}::uuid AND company_id = ${companyId}`)) as unknown as {
      rows: Array<{ name: string | null }>;
    };
    name = role.rows[0]?.name?.trim() || canonical;
  }
  return {
    message: `No agent may change or delete the role "${name}": an agent holds it. A person can change it in Users & Roles.`,
    code: 'FORBIDDEN',
    details: { hardFloor: true, roleHeldByAgent: canonical ?? key },
  };
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
  // A value becomes one segment of the path. A slash, a backslash or a "%" (which could spell an
  // encoded one, %2F or %5C) would let it be read as more than one, so the scope's route checks
  // might judge another route than the one the handler serves: refused (guardInput refuses them
  // first; this is the second line, and the scope itself is the third).
  const check = (name: string, v: string): { error: string } | null => {
    if (!v) return badParam(name, 'is empty.');
    if (v.length > 500) return badParam(name, 'is too long.');
    if (v === '.' || v === '..') return badParam(name, 'cannot be "." or "..".');
    if (BAD_SEGMENT.test(v)) return badParam(name, 'holds characters a path cannot carry.');
    if (/[/\\%]/.test(v)) return badParam(name, 'cannot hold a slash, a backslash or "%". Send the record\'s id as Ironbooks shows it.');
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

/** Why a staged file of a reveal whose time is up is not used (revealFileEnded). */
export const REVEAL_FILE_ENDED =
  'That file held protected values a person let this agent see for a while, and that time is over, so it can no longer be fetched or saved. If it is still needed, ask for it again with reveal: true and a reason.';

/**
 * The staged file is the answer of an approved reveal whose time is up (D6). The requests service
 * removes such a file then (lib/services/agentRequests.ts letGoRevealFile); until it has (Ironbooks
 * stopped in between, or the removal failed and waits for the next try), it is handed over no
 * more, saved, printed or sent nowhere: not by the door (lib/agent/operate.ts), and not as a FileRef
 * in a request's body here. A reveal whose end cannot be read counts as over (fail closed).
 */
export async function revealFileEnded(db: DB, companyId: string, agentId: string, fileId: string): Promise<boolean> {
  if (!fileId || !UUID.test(agentId)) return false;
  const rows = await db
    .select({ result: agentPermissionRequests.result })
    .from(agentPermissionRequests)
    .where(
      and(
        eq(agentPermissionRequests.companyId, companyId),
        eq(agentPermissionRequests.agentId, agentId),
        eq(agentPermissionRequests.status, 'executed'),
        or(
          sql`(${agentPermissionRequests.result} ->> 'revealFileLeft') = ${fileId}`,
          sql`(${agentPermissionRequests.result} -> 'file' ->> 'fileId') = ${fileId}`,
        ),
      ),
    );
  const now = Date.now();
  return rows.some(({ result }) => {
    if (!isObject(result)) return false;
    if (result.revealFileLeft === fileId) return true;
    if (!Object.hasOwn(result, 'revealUntil')) return false;
    const ends = typeof result.revealUntil === 'string' ? Date.parse(result.revealUntil) : NaN;
    return !(Number.isFinite(ends) && now < ends);
  });
}

/** The staged files a body names as FileRefs, anywhere in it (as withFiles finds them). */
function fileRefIds(v: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 64 || out.size > MAX_FILE_REFS) return out;
  if (isFileRef(v)) out.add(v.fileId);
  else if (Array.isArray(v)) for (const item of v) fileRefIds(item, out, depth + 1);
  else if (isObject(v)) for (const k of Object.keys(v)) fileRefIds(v[k], out, depth + 1);
  return out;
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
  let got: StagedBytes | null;
  try {
    got = await readStagedFile(owner, ref.fileId);
  } catch (err) {
    // A file kept for a person only (a whole copy of the company file) is never sent in a request.
    if (err instanceof ServiceError) throw new BridgeRefusal(err.message, err.code, { fileId: ref.fileId });
    throw err;
  }
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

/** What the handler's request carries besides the input and the secrets. */
interface RequestExtras {
  /** The version of the record the agent last read (x-expected-updated-at), or null. */
  expectedVersion: string | null;
  /**
   * This launch's pass, for a run a person approved at the host's own window (approvedAtHost), or
   * null. On the handler's request only, never in the scope's header set.
   */
  hostPass: string | null;
}

/**
 * The NextRequest for http://127.0.0.1<path>?<query>: the method, the body in the operation's own
 * kind, confirmation flags set, files in place, and only headers in SERVICE_SCOPE_HEADERS, but for
 * the launch pass of an approval at the host (RequestExtras.hostPass), which the scope never sees.
 */
async function buildRequest(
  operation: Operation,
  path: string,
  input: OperationInput,
  owner: FileOwner,
  secretHeaders: Record<string, string>,
  extras: RequestExtras = { expectedVersion: null, hostPass: null },
): Promise<BuiltRequest> {
  const query = buildQuery(input.query);
  if ('error' in query) throw new BridgeRefusal(query.error, 'VALIDATION');
  const flags = Array.isArray(input.confirm) ? [...new Set(input.confirm)] : [];
  const method = operation.method;
  const canHaveBody = method !== 'GET';
  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.8' };
  if (extras.expectedVersion) headers[EXPECTED_VERSION_HEADER] = extras.expectedVersion;
  // Only the secrets the scope carries (the closing-date password, a backup's or a copy's user
  // name, password and recovery key), and only as applySecrets put them from what the approving
  // person typed: nothing of the agent's input ever becomes a header.
  for (const [name, value] of Object.entries(secretHeaders)) {
    if (!SERVICE_SCOPE_SECRET_HEADERS.includes(name.toLowerCase()) || typeof value !== 'string') {
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

  // Approved at the host's own window: the route's own "is this the Ironbooks window here?" check
  // (lib/net/requestInfo.ts originFromHeaders on req.headers) answers yes, as it would for that
  // person. Left out of the scope's set below, so getRequestOrigin() inside the scope stays an
  // agent's and no helper that reads the scope's headers ever sees the pass.
  const hostPass = extras.hostPass ? extras.hostPass : null;
  if (hostPass) headers[LAUNCH_PASS_HEADER] = hostPass;

  const qs = query.toString();
  const req = new NextRequest(`http://127.0.0.1${path}${qs ? `?${qs}` : ''}`, { method, headers, ...(body !== null ? { body } : {}) });
  // The scope's own set: what the handler's request carries (a form's boundary included).
  const scopeHeaders: Record<string, string> = {};
  for (const [name, value] of req.headers) {
    if (hostPass && name === LAUNCH_PASS_HEADER) continue;
    // Never reached: every name above is from the list. A guard against a later edit here.
    if (!SERVICE_SCOPE_HEADERS.includes(name)) throw new Error(`The route bridge built a request with the header "${name}".`);
    scopeHeaders[name] = value;
  }
  return { req, scopeHeaders };
}

/**
 * A copy of the input without these confirmation flags, wherever the agent put them: the list in
 * `confirm`, the body at the flag's dotted path (guardInput leaves a listed flag the agent wrote
 * into a body where it was), a form field, a query name. For the try without them (withheldWarnings).
 */
function withoutFlags(input: OperationInput, flags: readonly string[], kind: Operation['body']): OperationInput {
  const out: OperationInput = { ...input, confirm: (input.confirm ?? []).filter((f) => !flags.includes(f)) };
  if (isObject(input.query)) {
    const q: Record<string, string | string[]> = { ...(input.query as Record<string, string | string[]>) };
    for (const f of flags) delete q[f];
    out.query = q;
  }
  if (kind === 'json' && isObject(input.body)) {
    const body = JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>;
    for (const f of flags) {
      const segs = f.split('.');
      let at: unknown = body;
      for (const s of segs.slice(0, -1)) at = isObject(at) ? at[s] : undefined;
      if (isObject(at)) delete at[segs[segs.length - 1]];
    }
    out.body = body;
  } else if (kind === 'multipart' && isObject(input.body) && isObject(input.body.fields)) {
    const fields = { ...(input.body.fields as Record<string, unknown>) };
    for (const f of flags) delete fields[f];
    out.body = { ...input.body, fields };
  }
  return out;
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
 *
 * The scope refuses to open (a plain Error from runWithServiceContext, before the handler runs)
 * for a path no real request could carry, a context that cannot be checked while it runs, a
 * header off its list, or a scope already open. Nothing ran then, so it is an internal refusal
 * that says so (BridgeRefusal 'INTERNAL'), never a crash and never "something went wrong".
 */
async function invoke(
  handler: RouteHandler,
  request: BuiltRequest,
  params: RouteParams,
  ctx: ServiceContext,
  scope: ServiceScopeOptions,
  failOnError: boolean,
): Promise<RawAnswer> {
  let entered = false;
  try {
    return await runWithServiceContext(ctx, scope, async () => {
      entered = true;
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
  } catch (err) {
    if (entered || !(err instanceof Error) || err instanceof ServiceError) throw err;
    const why = err.message ? `${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}` : 'it could not be set up safely.';
    throw new BridgeRefusal(`Ironbooks did not run this request, and nothing was changed: ${why}`, 'INTERNAL', { notRun: true });
  }
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

const WIN = process.platform === 'win32';

/**
 * The parts of `child` below `parent` ([] for the folder itself), or null when `child` is not
 * inside it. Both are absolute and resolved; on Windows any case matches.
 */
function partsBelow(child: string, parent: string): string[] | null {
  const key = (p: string) => (WIN ? p.toLowerCase() : p);
  const c = key(child);
  const p = key(parent);
  if (c === p) return [];
  const withSep = p.endsWith(path.sep) ? p : `${p}${path.sep}`;
  if (!c.startsWith(withSep)) return null;
  return child.slice(withSep.length).split(path.sep).filter(Boolean);
}

/** A folder name effects.writeFile may make (it does not exist yet, so nothing can be odd about it). */
function plainNewFolder(name: string): boolean {
  return PLAIN_FOLDER_NAME.test(name) && !DEVICE_NAME.test(name) && !/[. ]$/.test(name);
}

/**
 * Walk down from `base` (a real allowed folder, every link in it resolved) along `parts`, one name
 * at a time with lstat, so nothing is ever looked at outside an allowed folder: lstat does not
 * follow the name it is given, and every folder above it is real. A link on the way counts only
 * when allowedFolder resolves it to a folder inside an allowed one (it looks only at the shares an
 * allowed folder names); the walk goes on from where it really leads. The first name that does not
 * exist starts the folders still to be made: plain names only, at most MAX_NEW_FOLDERS of them.
 * Returns the real folder the file would be saved in, or null.
 */
async function walkAllowed(folders: readonly string[], base: string, parts: readonly string[]): Promise<string | null> {
  let at = base;
  let missing: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(at, parts[i]);
    let st: Stats;
    try {
      st = await fsp.lstat(next);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== 'ENOENT') return null;
      missing = parts.slice(i);
      break;
    }
    if (st.isSymbolicLink()) {
      const real = await allowedFolder(folders, next);
      if (!real) return null;
      at = real;
    } else if (st.isDirectory()) {
      at = next;
    } else {
      return null; // a file where a folder should be
    }
  }
  if (missing.length > MAX_NEW_FOLDERS || !missing.every(plainNewFolder)) return null;
  // Once more on the folder found, links and all, exactly as save_file and the shell are checked
  // (allowedFolder: never inside the books or Ironbooks' own data, as the folder is now).
  const real = await allowedFolder(folders, at);
  if (!real) return null;
  const target = path.join(real, ...missing);
  // Folders still to be made are not on the disk for allowedFolder to judge: one that would be, lie
  // inside or hold a place of Ironbooks' own (a backups folder not made yet, beside the books in an
  // agent's folder) is refused by its words (lib/agent/files.ts overlapsAppData), as the folder is
  // now, whatever was true when the agent's folders were saved.
  if (missing.length && overlapsAppData(target)) return null;
  return target;
}

/**
 * Where a file would be saved, when that is inside one of the agent's folders; else null. The path
 * is first compared, as text, with each allowed folder (as typed, and as it really is), and only a
 * path already known to be inside one is ever looked at on the disk (walkAllowed). So a path on
 * someone's network share, or anywhere else, is refused without the bridge or effects.writeFile
 * looking at it: merely looking at a folder on a share makes Windows offer that share the person's
 * sign-in (lib/agent/files.ts). A folder that does not exist yet (effects.writeFile makes it)
 * counts by its nearest existing parent, with only plain folder names below it. The answer is the
 * real folder, which the file is then pinned to (lib/effects.ts pinFile).
 */
async function allowedTarget(folders: readonly string[], dir: string): Promise<string | null> {
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) return null;
  const want = path.resolve(dir);
  const list = Array.isArray(folders) ? folders : [];
  for (const raw of list) {
    const typed = typeof raw === 'string' ? raw.trim() : '';
    if (!typed || !path.isAbsolute(typed)) continue;
    const entry = path.resolve(typed);
    const lexical = partsBelow(want, entry);
    // The allowed folder itself is looked at only through allowedFolder, as everywhere else.
    const base = await allowedFolder(list, entry);
    if (!base) continue;
    const parts = lexical ?? partsBelow(want, base);
    if (parts === null) continue;
    const found = await walkAllowed(list, base, parts);
    if (found) return found;
  }
  return null;
}

/**
 * Most rounds of checkAndPinFiles: work still asking for new files after this many is refused. A
 * round only follows one in which the work (left running in the background) asked for another file.
 */
const MAX_FILE_CHECK_ROUNDS = 50;

/**
 * Check every file the work asked to save against the agent's folders, and pin each allowed one to
 * the real folder found (lib/effects.ts pinFile): after the commit it is written there and only
 * there, and only when that folder still resolves to itself, so a link made inside an allowed
 * folder while the work was committing cannot lead the write elsewhere. Returns the refusal for the
 * first file outside the folders (or with a folder in the way of its name), else null. Inside the
 * effects collection (the scope is open).
 *
 * The list is read again after every round until a round finds no file it has not checked: work
 * the handler left running may ask for one while the checks wait on the disk. One asked for after
 * the last round is never written: the collection runs with { pinFiles: true }, and release saves
 * only pinned files.
 */
async function checkAndPinFiles(folders: readonly string[]): Promise<BridgeRefusal | null> {
  const checked = new Set<EffectPreview>();
  for (let round = 0; ; round++) {
    const fresh = (currentEffects() ?? []).filter((e) => e.kind === 'file' && !checked.has(e));
    if (!fresh.length) return null;
    if (round >= MAX_FILE_CHECK_ROUNDS) {
      return new BridgeRefusal('This work kept asking to save more files while they were being checked, so nothing was saved. Ask again with fewer files.', 'VALIDATION');
    }
    for (const e of fresh) {
      checked.add(e);
      const dir = typeof e.detail.dir === 'string' ? e.detail.dir : '';
      const target = dir ? await allowedTarget(folders, dir) : null;
      if (!target) {
        return new BridgeRefusal(
          `Saving a file in "${dir || 'an unnamed folder'}" is not allowed for this agent. An Admin can add the folder to the agent's folders in ${AGENTS_TAB}.`,
          'FOLDER_NOT_ALLOWED',
          { folder: dir },
        );
      }
      try {
        await pinFile(e, target);
      } catch (err) {
        // A folder where the file's name should go: the words a person saving it would get.
        if (err instanceof ServiceError) return new BridgeRefusal(err.message, err.code, err.details ?? null);
        throw err;
      }
    }
  }
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

/**
 * Keys holding free text of the books that may carry an account number: a memo (every memo column
 * is named `memo`; "lineMemo" too) and a description. lib/services/auditVisibility.ts masks memo
 * text in the audit trail the same way.
 */
const BOOKS_TEXT_KEY = /(?:memo|description)$/i;

/**
 * Text of the books as this run may show it (a preview): the account number in it ("Acct #
 * 000123456789", the memo a check gets when it is left blank, still on older Sales Tax Payment
 * lines, or typed by a person) masked to its last four, unless a person approved a reveal of full
 * account numbers for this very call. `ctx.access` is the run's (runAccess), so the rule is the
 * one every other reader of these memos follows (lib/services/journal.ts lineMemoFor).
 */
function shownText(ctx: Pick<ServiceContext, 'access'>, text: string | null): string | null {
  return lineMemoFor(ctx, text);
}

/** A ledger preview entry with its description and line memos as this run may show them. */
function shownEntry<E extends PostingEntry>(ctx: Pick<ServiceContext, 'access'>, entry: E): E {
  return { ...entry, description: shownText(ctx, entry.description), lines: entry.lines.map((l) => ({ ...l, memo: shownText(ctx, l.memo) })) };
}

/** Hide the sensitive and secret values of one field's value (a copy). */
function maskFieldValue(field: string, value: unknown, hidden: Set<string>, access: EffectiveAccess): unknown {
  const hide = (v: unknown) => (v === null || v === undefined || v === '' ? v : MASK);
  const walk = (key: string, v: unknown, depth: number): unknown => {
    if (hidden.has(key.toLowerCase()) || isSecretKey(key) || SECRET_WORDS.test(key)) return hide(v);
    if (typeof v === 'string' && BOOKS_TEXT_KEY.test(key) && access.flags.fullAccountNumbers !== true) return maskAccountsInText(v);
    if (depth > 32) return v;
    // Items keep their list's key: a list of memos is memo text too.
    if (Array.isArray(v)) return v.map((item) => walk(key, item, depth + 1));
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

// ---------------------------------------------------------------------------
// Entries that already existed: voided, deleted or changed by the run
// ---------------------------------------------------------------------------
//
// changesInTransaction lists only the entries a run MAKES (created_at = now()). A void flips an
// entry's status (the ledger trigger takes its amounts back out), a batch delete hides it, a
// reclassify or a merge rewrites its lines in place: none of that is a new entry, yet it is money
// the run moves. These are found here, shown in the ledger preview, and counted in the amount, so
// "Void check 1042" for $50,000 is judged and shown at $50,000.

/** One more than the largest transaction id (ids are 32 bits and wrap around). */
const XID_SPAN = '4294967296';
/**
 * How far past the run's own transaction id a row's xmin may be and still be the run's: the
 * savepoints a service opens (lib/services/_base.ts inTransaction) get ids of their own after the
 * run's. PGlite runs one transaction at a time, so every id from the run's own up is this run's;
 * a run makes far fewer within its time limit.
 */
const OWN_XID_WINDOW = '1000000';

/** SQL: the row (of table alias `t`) was written by this transaction or one of its savepoints. */
function writtenHere(t: 'je' | 'l') {
  return sql.raw(
    `((((${t}.xmin::text::bigint - (txid_current() % ${XID_SPAN})) % ${XID_SPAN}) + ${XID_SPAN}) % ${XID_SPAN}) < ${OWN_XID_WINDOW}`,
  );
}

type TouchedHow = 'voided' | 'deleted' | 'changed';

/** How the preview names an entry the run voided, deleted or changed. */
const TOUCHED_WORDS: Record<TouchedHow, string> = {
  voided: 'Voided by this request',
  deleted: 'Deleted by this request',
  changed: 'Changed by this request',
};

/** A journal entry that existed before the run and that the run voided, deleted or changed. */
interface TouchedEntry {
  id: string;
  how: TouchedHow;
  /** Its status now ('void' once voided), or 'deleted' when it is gone. */
  status: string;
  /**
   * Its total debits when the run moves it into or out of the books, or rewrites its lines: what
   * the run moves. Null when it moves none of it (a draft or an entry already void touched, a
   * posted entry only given a new title, number, link or line memo).
   */
  counted: string | null;
  /** Its total cannot be known (it is gone and the audit trail does not hold it): fail closed. */
  unknown: boolean;
  /**
   * Which accounts its lines were on before the run cannot be known: the run opened the ledger
   * for rewriting (a merge, a reclassify), under which a line can be moved to another account or
   * deleted without a trace. Its accounts are then unknown (ledgerAccountsOf: fail closed).
   */
  accountsUnknown: boolean;
  entryNumber: number | null;
  date: string;
  description: string | null;
  source: string | null;
}

/** A decimal amount for a preview line: null when there is none or it is zero (as changesInTransaction). */
function lineAmount(v: unknown): string | null {
  if ((typeof v !== 'string' && typeof v !== 'number') || v === '') return null;
  try {
    return Money.isZero(v) ? null : toAmountString(v);
  } catch {
    return null;
  }
}

/** The total of a deleted entry as its audit row holds it ({ total } or its { lines }), or null. */
function deletedTotal(old: Record<string, unknown>): string | null {
  try {
    if (typeof old.total === 'string' || typeof old.total === 'number') return toAmountString(old.total);
    if (Array.isArray(old.lines)) {
      return toAmountString(Money.add(...old.lines.map((l) => (isObject(l) && (typeof l.debit === 'string' || typeof l.debit === 'number') ? l.debit : null))));
    }
  } catch {
    /* unreadable: unknown */
  }
  return null;
}

/** Most drafts remembered before a run (draftsBefore); with more, every posted entry the run touches counts. */
const MAX_DRAFTS_REMEMBERED = 100_000;

/**
 * The company's draft entries before the run, read in its transaction before the handler runs, or
 * null when there are too many to remember. A draft is not in the books: one the run posts moves
 * its whole total in, and nothing else can (the ledger guards keep a void entry void and a posted
 * one from going back to draft: drizzle/0017_team_ledger.sql bka_je_guard).
 */
async function draftsBefore(db: DB, companyId: string): Promise<ReadonlySet<string> | null> {
  const res = (await db.execute(sql`
    SELECT id::text AS id FROM journal_entries
     WHERE company_id = ${companyId} AND status = 'draft'
     LIMIT ${MAX_DRAFTS_REMEMBERED + 1}`)) as unknown as { rows: Array<{ id: string }> };
  if (res.rows.length > MAX_DRAFTS_REMEMBERED) return null;
  return new Set(res.rows.map((r) => r.id.toLowerCase()));
}

/**
 * The entries of this company that existed before the run and that it voided, deleted or changed,
 * read inside the run's transaction: every entry whose own row the run wrote (its xmin is this
 * transaction's: a void, a batch delete, a new title or number, a draft posted), every entry whose
 * lines it rewrote in place when it opened the ledger for rewriting (lib/services/posting.ts
 * allowLedgerRewrite: a merge, a reclassify), and every entry the audit trail says it touched (an
 * entry deleted outright leaves only that). `newIds` are the entries the run made, left out.
 *
 * What counts toward the amount (TouchedEntry.counted) is only what moves money: an entry voided
 * or deleted while in the books, one whose lines were rewritten under that flag, and a draft the run
 * posted (`drafts`, from draftsBefore; null: any posted entry may have been one, so it counts). An
 * entry only retitled, renumbered, relinked or given new line memos (the ledger guards let nothing
 * else change on a posted entry without the flag) is still shown, but counts nothing.
 */
async function touchedEntries(
  ctx: ServiceContext,
  audit: readonly AuditRow[],
  newIds: ReadonlySet<string>,
  drafts: ReadonlySet<string> | null,
): Promise<TouchedEntry[]> {
  const ids = new Set<string>();
  const add = (id: unknown) => {
    const s = typeof id === 'string' ? id.toLowerCase() : '';
    if (UUID.test(s) && !newIds.has(s)) ids.add(s);
  };
  const own = (await ctx.db.execute(sql`
    SELECT je.id::text AS id FROM journal_entries je
     WHERE je.company_id = ${ctx.companyId} AND je.created_at <> now() AND ${writtenHere('je')}`)) as unknown as { rows: Array<{ id: string }> };
  for (const r of own.rows) add(r.id);
  const flag = (await ctx.db.execute(sql`
    SELECT coalesce(current_setting('bka.allow_ledger_rewrite', true) = 'on'
                    AND current_setting('bka.ledger_rewrite_txid', true) = txid_current()::text, false) AS on`)) as unknown as { rows: Array<{ on: boolean }> };
  // Under the flag a line can also be deleted, which leaves no trace on the lines left, so every
  // posted entry the run wrote then may have had its lines rewritten: all of them count (fail closed).
  const rewriteOpen = flag.rows[0]?.on === true;
  if (rewriteOpen) {
    const rewritten = (await ctx.db.execute(sql`
      SELECT DISTINCT l.journal_entry_id::text AS id
        FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id
       WHERE je.company_id = ${ctx.companyId} AND je.created_at <> now() AND ${writtenHere('l')}`)) as unknown as { rows: Array<{ id: string }> };
    for (const r of rewritten.rows) add(r.id);
  }
  const auditOf = new Map<string, AuditRow[]>();
  for (const r of audit) {
    if (r.entity_type !== 'journal_entry') continue;
    const id = r.entity_id.toLowerCase();
    auditOf.set(id, [...(auditOf.get(id) ?? []), r]);
    // An entry made and removed again inside the run never was in the books.
    if (r.action !== 'create') add(id);
  }
  for (const [id, rows] of auditOf) if (rows.some((r) => r.action === 'create')) ids.delete(id);
  if (!ids.size) return [];

  // Every id passed the UUID pattern (hex digits and dashes only), so it can be written in place.
  const list = sql.raw(`ARRAY[${[...ids].map((id) => `'${id}'`).join(',')}]::uuid[]`);
  const found = (await ctx.db.execute(sql`
    SELECT je.id::text AS id, je.entry_number, je.date::text AS date, je.description, je.status::text AS status, je.source_ref,
           (je.voided_at IS NOT NULL AND je.voided_at >= date_trunc('milliseconds', now() AT TIME ZONE 'UTC')) AS voided_now,
           (je.deleted_at IS NOT NULL AND je.deleted_at >= date_trunc('milliseconds', now() AT TIME ZONE 'UTC')) AS deleted_now,
           ${writtenHere('je')} AS own_row,
           EXISTS (SELECT 1 FROM journal_entry_lines l WHERE l.journal_entry_id = je.id AND ${writtenHere('l')}) AS own_lines,
           coalesce((SELECT sum(l.debit) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id), 0)::text AS total
      FROM journal_entries je
     WHERE je.company_id = ${ctx.companyId} AND je.id = ANY(${list})`)) as unknown as {
    rows: Array<{
      id: string;
      entry_number: number | string | null;
      date: string | null;
      description: string | null;
      status: string;
      source_ref: string | null;
      voided_now: boolean;
      deleted_now: boolean;
      own_row: boolean;
      own_lines: boolean;
      total: string;
    }>;
  };
  const out: TouchedEntry[] = [];
  const day = (d: unknown) => (typeof d === 'string' ? d.slice(0, 10) : d instanceof Date ? d.toISOString().slice(0, 10) : '');
  const actions = (id: string) => new Set((auditOf.get(id) ?? []).map((r) => r.action));
  for (const r of found.rows) {
    const key = r.id.toLowerCase();
    const did = actions(key);
    // Named only by an audit row of the run (a credit applied against it, say), but neither the
    // entry nor any of its lines was written: it is as it was, so it is not shown as changed.
    if (!r.own_row && !r.own_lines && !r.voided_now && !r.deleted_now) continue;
    const how: TouchedHow = did.has('delete') || r.deleted_now ? 'deleted' : did.has('void') || r.voided_now ? 'voided' : 'changed';
    // A draft before the run (null: not known, so it may have been).
    const wasDraft = drafts === null ? null : drafts.has(key);
    // In the books before the run: posted then (still posted, or voided by it), not a draft.
    const wasInBooks = wasDraft !== true && (r.status === 'posted' || did.has('void') || r.voided_now);
    const moves =
      how !== 'changed'
        ? wasInBooks // voided or deleted: its whole total leaves the books
        : r.status === 'posted' && (rewriteOpen || wasDraft !== false); // lines rewritten, or a draft posted
    out.push({
      id: r.id,
      how,
      status: r.status,
      counted: moves ? toAmountString(r.total) : null,
      unknown: false,
      accountsUnknown: rewriteOpen,
      entryNumber: r.entry_number === null || r.entry_number === undefined ? null : Number(r.entry_number),
      date: day(r.date),
      description: r.description,
      source: r.source_ref,
    });
  }
  // Gone altogether: only the audit trail tells what they were.
  const still = new Set(found.rows.map((r) => r.id.toLowerCase()));
  for (const id of ids) {
    if (still.has(id)) continue;
    const gone = (auditOf.get(id) ?? []).filter((r) => r.action === 'delete').pop();
    const old = gone && isObject(gone.old_values) ? gone.old_values : {};
    const status = typeof old.status === 'string' ? old.status : null;
    const total = deletedTotal(old);
    const notInBooks = drafts?.has(id) === true || status === 'draft' || status === 'void';
    out.push({
      id,
      how: 'deleted',
      status: 'deleted',
      counted: notInBooks ? null : total,
      unknown: !notInBooks && total === null,
      accountsUnknown: false,
      entryNumber: typeof old.entryNumber === 'number' ? old.entryNumber : null,
      date: day(old.date),
      description: typeof old.description === 'string' ? old.description : null,
      source: typeof old.sourceRef === 'string' ? old.sourceRef : null,
    });
  }
  return out.sort((a, b) => (a.entryNumber ?? Number.MAX_SAFE_INTEGER) - (b.entryNumber ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}

/**
 * The touched entries as the ledger preview shows them, at most `limit`: their lines as they are
 * now (as they were, for an entry deleted outright, when its audit row holds them), and a
 * description that says what the run did to each. Memos and descriptions as the run may show them
 * (shownText): the agent reads this preview too, so an account number in them is masked unless a
 * reveal was approved for this call.
 */
async function touchedPreview(ctx: ServiceContext, touched: readonly TouchedEntry[], audit: readonly AuditRow[], limit: number): Promise<PostingEntry[]> {
  const shown = touched.slice(0, Math.max(0, limit));
  if (!shown.length) return [];
  /** Each line with the name and class it carries (named below). */
  const lines = new Map<string, Array<{ line: NamedPostingLine; ref: LineRef }>>();
  const live = shown.filter((t) => t.status !== 'deleted').map((t) => t.id.toLowerCase());
  if (live.length) {
    const list = sql.raw(`ARRAY[${live.map((id) => `'${id}'`).join(',')}]::uuid[]`);
    const res = (await ctx.db.execute(sql`
      SELECT l.journal_entry_id::text AS id, l.account_id::text AS account_id, a.code AS account_code, a.name AS account_name,
             l.debit::text AS debit, l.credit::text AS credit, l.memo, l.entity_type, l.entity_id::text AS entity_id, l.class_id::text AS class_id
        FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.journal_entry_id = ANY(${list})
       ORDER BY (l.debit IS NULL OR l.debit = 0), l.id`)) as unknown as {
      rows: Array<{
        id: string;
        account_id: string;
        account_code: string | null;
        account_name: string;
        debit: string | null;
        credit: string | null;
        memo: string | null;
        entity_type: string | null;
        entity_id: string | null;
        class_id: string | null;
      }>;
    };
    for (const r of res.rows) {
      const k = r.id.toLowerCase();
      lines.set(k, [
        ...(lines.get(k) ?? []),
        {
          line: {
            accountId: r.account_id,
            accountCode: r.account_code,
            accountName: r.account_name,
            debit: lineAmount(r.debit),
            credit: lineAmount(r.credit),
            memo: shownText(ctx, r.memo),
            entityName: null,
            entityType: r.entity_type,
            className: null,
          },
          ref: { entityType: r.entity_type, entityId: r.entity_id, classId: r.class_id },
        },
      ]);
    }
  }
  // An entry deleted outright: the lines its audit row kept, named from the chart of accounts.
  const goneLines = new Map<string, Array<Record<string, unknown>>>();
  for (const t of shown) {
    if (t.status !== 'deleted') continue;
    const row = audit.filter((r) => r.entity_type === 'journal_entry' && r.action === 'delete' && r.entity_id.toLowerCase() === t.id.toLowerCase()).pop();
    const old = row && isObject(row.old_values) ? row.old_values : {};
    if (Array.isArray(old.lines)) goneLines.set(t.id.toLowerCase(), old.lines.filter(isObject));
  }
  const accountIds = [...new Set([...goneLines.values()].flat().map((l) => (typeof l.accountId === 'string' ? l.accountId.toLowerCase() : '')).filter((id) => UUID.test(id)))];
  const names = new Map<string, { code: string | null; name: string }>();
  if (accountIds.length) {
    const list = sql.raw(`ARRAY[${accountIds.map((id) => `'${id}'`).join(',')}]::uuid[]`);
    const res = (await ctx.db.execute(sql`
      SELECT id::text AS id, code, name FROM accounts WHERE company_id = ${ctx.companyId} AND id = ANY(${list})`)) as unknown as {
      rows: Array<{ id: string; code: string | null; name: string }>;
    };
    for (const r of res.rows) names.set(r.id.toLowerCase(), { code: r.code, name: r.name });
  }
  const textOf = (v: unknown) => (typeof v === 'string' && v ? v : null);
  for (const [id, kept] of goneLines) {
    lines.set(
      id,
      kept.map((l) => {
        const acct = typeof l.accountId === 'string' ? l.accountId : '';
        const named = names.get(acct.toLowerCase());
        const entityType = textOf(l.entityType);
        return {
          line: {
            accountId: acct,
            accountCode: named?.code ?? null,
            accountName: named?.name ?? 'An account',
            debit: lineAmount(l.debit),
            credit: lineAmount(l.credit),
            memo: shownText(ctx, typeof l.memo === 'string' ? l.memo : null),
            entityName: null,
            entityType,
            className: null,
          },
          ref: { entityType, entityId: textOf(l.entityId), classId: textOf(l.classId) },
        };
      }),
    );
  }
  const all = [...lines.values()].flat();
  await nameLines(ctx, all);
  return shown.map((t): TouchedPostingEntry => ({
    journalEntryId: t.id,
    entryNumber: t.entryNumber,
    date: t.date,
    description: t.description ? `${TOUCHED_WORDS[t.how]}: ${shownText(ctx, t.description)}` : TOUCHED_WORDS[t.how],
    status: t.status,
    source: t.source,
    lines: (lines.get(t.id.toLowerCase()) ?? []).map((l) => l.line),
    touched: t.how,
    counted: t.counted,
  }));
}

/** Who a ledger line is for, and its class, as the journal lines hold them. */
interface LineRef {
  entityType: string | null;
  entityId: string | null;
  classId: string | null;
}

/**
 * A ledger line of a preview with who it is for and its class, so a person approving it sees whose
 * receivable or payable it is (the customer, vendor, employee or other name), not only the account.
 * actions.ts PostingLine carries the name; the bridge adds the kind of name (entityType: customer,
 * vendor, employee, other) and the class. Masked like every other text of the preview (shownText).
 */
export type NamedPostingLine = PostingLine & { entityType: string | null; className: string | null };

/**
 * Fill in the name and the class of each line from the ids its row holds (lib/services/journal.ts
 * resolveEntityNames, the names every journal screen shows), as this run may show them. A line that
 * already has a name or a class keeps it.
 */
async function nameLines(ctx: ServiceContext, lines: ReadonlyArray<{ line: NamedPostingLine; ref: LineRef }>): Promise<void> {
  const refs = lines.map((l) => l.ref).filter((r) => r.entityType && r.entityId && UUID.test(r.entityId));
  const names = refs.length ? await resolveEntityNames(ctx, refs) : new Map<string, string>();
  const classIds = [...new Set(lines.map((l) => (l.ref.classId ?? '').toLowerCase()).filter((id) => UUID.test(id)))];
  const classNames = new Map<string, string>();
  if (classIds.length) {
    // Every id passed the UUID pattern (hex digits and dashes only), so it can be written in place.
    const list = sql.raw(`ARRAY[${classIds.map((id) => `'${id}'`).join(',')}]::uuid[]`);
    const res = (await ctx.db.execute(sql`
      SELECT id::text AS id, name FROM classes WHERE company_id = ${ctx.companyId} AND id = ANY(${list})`)) as unknown as {
      rows: Array<{ id: string; name: string | null }>;
    };
    for (const r of res.rows) if (r.name) classNames.set(r.id.toLowerCase(), r.name);
  }
  for (const { line, ref } of lines) {
    if (!line.entityName && ref.entityType && ref.entityId) line.entityName = names.get(`${ref.entityType}:${ref.entityId.toLowerCase()}`) ?? null;
    if (!line.className && ref.classId) line.className = classNames.get(ref.classId.toLowerCase()) ?? null;
    if (line.entityType === undefined || line.entityType === null) line.entityType = ref.entityType ?? null;
    line.entityName = shownText(ctx, line.entityName);
    line.className = shownText(ctx, line.className);
  }
}

/**
 * A ledger preview entry the run did not make but voided, deleted or changed. `touched` says
 * which, so a reader can tell it from the entries the run made without reading its words (an
 * agent writes descriptions too). `counted` is what of it the amount counts (TouchedEntry.counted):
 * its total when the run moved its money (a void, a delete, lines rewritten, a draft posted), null
 * when it did not (a new title, number, link or line memo, an entry already void, a draft voided),
 * so lib/agent/operate.ts can tell a run that posted from one that only retitled an entry, also for
 * an operation with an amount field. Additions to actions.ts PostingEntry, which has neither field.
 */
export type TouchedPostingEntry = PostingEntry & { touched: 'voided' | 'deleted' | 'changed'; counted: string | null };

/** What the run moves in the ledger, for the facts (lib/money.ts throughout, never a float). */
interface LedgerTotals {
  /** It made, voided, deleted or changed at least one entry. */
  any: boolean;
  /** The largest single entry it made, or whose money it moved (TouchedEntry.counted). */
  largest: string | null;
  /**
   * All of it: the entries made and the counted ones it voided, deleted or changed, added up. An
   * edit that re-posts a document (voids or deletes its old entry and posts the new one, both under
   * the document's source reference, "bill:<id>") counts once, at the larger of the two, not twice;
   * everything else adds up, so voiding $100,000 and posting an unrelated $100,000 is $200,000.
   */
  sum: string | null;
  /**
   * The run both takes money out of the books (an entry it voids, deletes or rewrites, counted)
   * and posts new entries for something else: a made entry no counted one shares a document with,
   * and a counted one no made entry shares a document with. Then both sides count (`sum`), also
   * for an operation with an amount field; an edit that re-posts its own document is not mixed.
   */
  mixed: boolean;
  /** A touched entry's total cannot be known: the amount is unknown. */
  unknown: boolean;
  /**
   * The run voided, deleted or changed a record that existed before it (an audit row other than
   * 'create', of a record it did not make). With no entry made or touched, its money cannot be seen
   * (voiding a payroll adjustment that never posted still takes it off the W-2): unknown, never 0.00.
   */
  editsExisting: boolean;
  /**
   * Every account the run's ledger lines are on: of the entries it made, and of those it voided,
   * deleted or changed (ledgerAccountsOf), all of them, not only the lines the preview shows. Null
   * when that cannot be known; then no grant limited to accounts covers the run (factsFor).
   */
  accountIds: string[] | null;
}

function ledgerTotals(rows: readonly LedgerRow[], touched: readonly TouchedEntry[], editsExisting: boolean, accountIds: string[] | null): LedgerTotals {
  type Amount = ReturnType<typeof Money.zero>;
  const sourceOf = (s: string | null) => (s && s.trim() ? s.trim().toLowerCase() : null);
  const made = new Map<string, { total: Amount; source: string | null }>();
  for (const r of rows) {
    const e = made.get(r.entry_id);
    made.set(r.entry_id, { total: Money.add(e?.total ?? Money.zero(), r.debit), source: e?.source ?? sourceOf(r.source_ref) });
  }
  const moved = touched.filter((t) => t.counted !== null).map((t) => ({ total: Money.of(t.counted), source: sourceOf(t.source) }));
  let largest: Amount | null = null;
  for (const t of [...[...made.values()].map((m) => m.total), ...moved.map((m) => m.total)]) if (largest === null || t.greaterThan(largest)) largest = t;
  // By document: what it posts and what it takes out, the larger of the two (an edit re-posting it).
  const bySource = new Map<string, { made: Amount; moved: Amount }>();
  let sum: Amount = Money.zero();
  for (const m of made.values()) {
    if (m.source === null) sum = Money.add(sum, m.total);
    else bySource.set(m.source, { made: Money.add(bySource.get(m.source)?.made ?? Money.zero(), m.total), moved: bySource.get(m.source)?.moved ?? Money.zero() });
  }
  for (const m of moved) {
    if (m.source === null) sum = Money.add(sum, m.total);
    else bySource.set(m.source, { made: bySource.get(m.source)?.made ?? Money.zero(), moved: Money.add(bySource.get(m.source)?.moved ?? Money.zero(), m.total) });
  }
  for (const g of bySource.values()) sum = Money.add(sum, g.made.greaterThan(g.moved) ? g.made : g.moved);
  // An entry with no source reference shares a document with nothing.
  const madeSources = new Set([...made.values()].map((m) => m.source).filter((s): s is string => s !== null));
  const movedSources = new Set(moved.map((m) => m.source).filter((s): s is string => s !== null));
  const mixed =
    [...made.values()].some((m) => m.source === null || !movedSources.has(m.source)) && moved.some((m) => m.source === null || !madeSources.has(m.source));
  const any = made.size > 0 || touched.length > 0;
  return {
    any,
    largest: largest === null ? null : toAmountString(largest),
    sum: any ? toAmountString(sum) : null,
    mixed,
    unknown: touched.some((t) => t.unknown),
    editsExisting,
    accountIds,
  };
}

/**
 * Every account the run's ledger lines are on (lower-case ids, sorted): the lines of the entries it
 * made, the lines as they are now of the entries it voided or changed, and the lines an entry it
 * deleted outright had, as the audit trail kept them. An item line's account comes from the item
 * (a bill's expense or inventory asset account, an invoice's income account), not from the body,
 * so only the ledger shows it. Null when the accounts cannot all be known: the run opened the
 * ledger for rewriting (TouchedEntry.accountsUnknown), or an entry it deleted while it was in the
 * books left no readable lines.
 */
async function ledgerAccountsOf(ctx: ServiceContext, made: readonly LedgerRow[], touched: readonly TouchedEntry[], audit: readonly AuditRow[]): Promise<string[] | null> {
  if (touched.some((t) => t.accountsUnknown)) return null;
  const out = new Set<string>();
  for (const r of made) {
    const id = String(r.account_id ?? '').toLowerCase();
    if (!UUID.test(id)) return null;
    out.add(id);
  }
  const live = touched.filter((t) => t.status !== 'deleted').map((t) => t.id.toLowerCase()).filter((id) => UUID.test(id));
  if (live.length) {
    // Every id passed the UUID pattern (hex digits and dashes only), so it can be written in place.
    const list = sql.raw(`ARRAY[${live.map((id) => `'${id}'`).join(',')}]::uuid[]`);
    const res = (await ctx.db.execute(sql`
      SELECT DISTINCT l.account_id::text AS account_id FROM journal_entry_lines l
       WHERE l.journal_entry_id = ANY(${list})`)) as unknown as { rows: Array<{ account_id: string }> };
    for (const r of res.rows) out.add(r.account_id.toLowerCase());
  }
  for (const t of touched) {
    if (t.status !== 'deleted') continue;
    const row = audit.filter((r) => r.entity_type === 'journal_entry' && r.action === 'delete' && r.entity_id.toLowerCase() === t.id.toLowerCase()).pop();
    const old = row && isObject(row.old_values) ? row.old_values : {};
    const inBooks = t.counted !== null || t.unknown;
    if (!Array.isArray(old.lines)) {
      if (inBooks) return null;
      continue;
    }
    for (const l of old.lines) {
      const id = isObject(l) && typeof l.accountId === 'string' ? l.accountId.toLowerCase() : '';
      if (!UUID.test(id)) return null;
      out.add(id);
    }
  }
  return [...out].sort();
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

// --- What the run assigns to itself -----------------------------------------------------------
//
// The key covers the records the run reads and changes that existed before it. What the run
// assigns to itself differs on every run of the same request, or moves whenever anyone else posts
// or numbers something, so it is left out, everywhere it shows:
//  - every id that did not exist before the run (runIdsOf): written "new:<kinds>", whole, inside a
//    value ("bill:<id>"), or cut to its first 8 hex digits (a paycheck's journal reference);
//  - the next free number or position it takes for what it makes, and only that (TAKEN_COLUMNS:
//    the next estimate, purchase order, invoice, sales receipt, credit memo, sales order, transfer,
//    loan payment, check or journal entry number, a General Journal entry's Entry No., a new bank
//    rule's next position, a new account's next number), read from the rows of what it makes (and
//    of a record that was there before with no number, given the next one: a check marked
//    printed), left out under the keys that name the column it was taken in (columnsOfKey), and
//    the numbers where the text of what it makes repeats them ("Invoice #1043", the reference of
//    the check's own entry). Every other number stays, also on what the run makes: an account,
//    routing, tax, serial or lot number, a bill number, a customer's P.O. or check number, a
//    journal reference the run copied from its input or from a record that was there before;
//  - times, on what the run makes: a key ending in At, and a moment read as its day only (a due
//    date the run works out from today); a date it fills in as today because the input gave none
//    ('<today>', so a request that waits past midnight is not stale for that alone). The run's own
//    clock (a moment from the start of its transaction to the end) wherever it shows. A time of a
//    record that was there before, from before the run, stays as it is, under any key.

/** A whole value that is a moment (an ISO date and time). */
const MOMENT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** A moment's zone, when it gives one (a database timestamp without a zone is UTC wall time here). */
const MOMENT_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Slack on each side of the run's own time span, for the two clocks (database and app). */
const RUN_SPAN_SLACK_MS = 1000;

/**
 * Where the services take the next free number or position for a row they make, by table: the
 * columns that hold it (lib/services/docNumbers.ts allocateDocNumber, its text number and its
 * legacy integer; lib/services/checkNumbers.ts allocateCheckNumber, a check's `reference` or
 * `check_number`; lib/services/posting.ts nextEntryNumber; lib/services/inventoryTransfers.ts and
 * lib/services/loans.ts, max + 1). `inText`: the number shows in the text of what the run makes
 * too ("Invoice #1043", "Check 1001"), so it goes from there as well; a position or an account's
 * number only counts where it stands on its own (TAKEN_KEYS).
 *
 * Only these columns, of rows the run made (takenOfRows) or of a record that was there before and
 * had no number until the run gave it one (takenOnExisting): a column of the same name elsewhere
 * holds a number copied from the input or from another record (an invoice's or a sales order's
 * `po_number` is the customer's P.O., a payment's `reference` the customer's check number, a
 * vendor credit's `ref_number` the vendor's), and stays in the key. A number taken in one column
 * is left out only under a key that names that column (columnsOfKey). In these columns too, a
 * number the input gives under the same key, or that a record the run voided, deleted or changed
 * held before it (a check
 * written again with the number of the one it replaces), is copied, not the next free one: it
 * stays (heldBeforeRun). A number the services copy from a record the run neither names nor
 * changes cannot be told from the next free one in the row, and is left out; no service of these
 * columns does that today.
 */
const TAKEN_COLUMNS: Readonly<Record<string, ReadonlyArray<{ column: string; inText: boolean }>>> = {
  journal_entries: [{ column: 'entry_number', inText: true }],
  estimates: [
    { column: 'estimate_number', inText: true },
    { column: 'ref_number', inText: true },
  ],
  invoices: [
    { column: 'invoice_number', inText: true },
    { column: 'ref_number', inText: true },
  ],
  sales_receipts: [
    { column: 'receipt_number', inText: true },
    { column: 'ref_number', inText: true },
  ],
  credit_memos: [
    { column: 'memo_number', inText: true },
    { column: 'ref_number', inText: true },
  ],
  sales_orders: [
    { column: 'order_number', inText: true },
    { column: 'ref_number', inText: true },
  ],
  purchase_orders: [
    { column: 'po_number', inText: true },
    { column: 'ref_number', inText: true },
  ],
  inventory_transfers: [{ column: 'transfer_number', inText: true }],
  loan_payments: [{ column: 'payment_number', inText: true }],
  expenses: [{ column: 'reference', inText: true }],
  bill_payments: [{ column: 'reference', inText: true }],
  payment_checks: [{ column: 'reference', inText: true }],
  paychecks: [{ column: 'check_number', inText: true }],
  // A new bank rule goes above every other (lib/services/bankRules.ts topPriority + 1).
  transaction_rules: [{ column: 'priority', inText: false }],
  // A new account with no number gets the next free one of its range (accounts.ts nextAccountNumber).
  accounts: [{ column: 'code', inText: false }],
};

/**
 * Keys under which a record the run makes (its audit row) holds a number or position it took, as
 * the services name them: only a value the run took (TAKEN_COLUMNS, read from its rows) is left out
 * under them, never the key itself. A check's number is its `reference` (expenses, bill payments,
 * liability checks); the reference of an entry the run makes is read through the ledger part of the
 * key (keyText), where only the numbers taken and the run's own id prefixes go.
 */
const TAKEN_KEYS: ReadonlySet<string> = new Set([
  'number',
  'docNumber',
  'doc_number',
  'refNumber',
  'ref_number',
  'entryNumber',
  'entry_number',
  'estimateNumber',
  'estimate_number',
  'invoiceNumber',
  'invoice_number',
  'receiptNumber',
  'receipt_number',
  'memoNumber',
  'memo_number',
  'orderNumber',
  'order_number',
  'poNumber',
  'po_number',
  'transferNumber',
  'transfer_number',
  'paymentNumber',
  'payment_number',
  'checkNumber',
  'check_number',
  'checkNo',
  'reference',
  'priority',
  'code',
]);

/** The TAKEN_COLUMNS that hold a document's own number, as keyForm writes them. */
const DOCUMENT_NUMBER_COLUMNS: readonly string[] = [
  'refnumber',
  'estimatenumber',
  'invoicenumber',
  'receiptnumber',
  'memonumber',
  'ordernumber',
  'ponumber',
  'transfernumber',
  'paymentnumber',
  'entrynumber',
];

/**
 * The TAKEN_COLUMNS (as keyForm writes them) a value under a key of TAKEN_KEYS may have been taken
 * in: the column of the same name ("poNumber" is po_number, "priority" is priority), and for the
 * names the services give a document's own number whatever its table calls it ("number",
 * "docNumber", "refNumber") every column of a document number, and for a check's number its
 * `reference` too. So a number the run took in one column is never taken for a number under an
 * unrelated key that happens to be the same (a customer's P.O. that equals the run's entry number,
 * a payment's reference that equals a new rule's position "3").
 */
function columnsOfKey(key: string): readonly string[] {
  const form = keyForm(key);
  if (form === 'number' || form === 'docnumber' || form === 'refnumber') return DOCUMENT_NUMBER_COLUMNS;
  if (form === 'checknumber' || form === 'checkno') return ['checknumber', 'reference'];
  return [form];
}

/** A whole value that is a calendar day. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Keys of free text where a record or an entry the run makes may repeat its own number. */
const OWN_TEXT_KEY = /(?:memo|description|reference|source|sourceRef|source_ref|notes?|title|subject|name|attachments)$/i;

/** Longest number kept as one the run took (a document number is at most 50 characters). */
const MAX_OWN_NUMBER = 50;

/** An 8-hex-digit token standing alone (not part of a longer id or word): perhaps a new id cut short. */
const HEX8_TOKEN = /(^|[^0-9a-z-])([0-9a-f]{8})(?![0-9a-z-])/gi;

/** What a value is read through for the key. */
interface KeyRules {
  /** Each id the run made (lower case), as the key writes it: "new:<kinds>". */
  made: ReadonlyMap<string, string>;
  /** The first 8 hex digits of each id the run made, as the key writes that id. */
  prefixes: ReadonlyMap<string, string>;
  /** The numbers the run took for itself that its text may repeat (TAKEN_COLUMNS inText), longest first. */
  numbers: readonly string[];
  /**
   * Every number and position the run took for itself, by the column it took it in: "<keyForm of
   * the column>:<value>" ("checknumber:1001"). Left out under a key of TAKEN_KEYS whose columns
   * (columnsOfKey) include that one.
   */
  taken: ReadonlySet<string>;
  /** The run's own time span (milliseconds since 1970): from its transaction's start to now. */
  span: { from: number; to: number };
  /** The run's today, as the services may write it (this computer's day, the UTC day, the company's). */
  today: ReadonlySet<string>;
  /** The days the input gives (a date the agent sent is the input's, never the run's today). */
  givenDays: ReadonlySet<string>;
}

/** How the key writes an id the run made: "new:" and the kinds of record it is, sorted. */
function placeholderOf(kinds: ReadonlySet<string>): string {
  return `new:${[...kinds].sort().join('+') || 'record'}`;
}

function isAlnum(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9]/.test(c);
}

/**
 * `s` with each number the run took replaced, where it stands alone (not inside a longer word or
 * number). A number of one or two characters only after "#" ("Invoice #2") or as the whole text
 * (an entry's reference "2"): standing alone in other text ("2 boxes") it is far more often
 * something else.
 */
function withoutOwnNumbers(s: string, numbers: readonly string[]): string {
  if (numbers.includes(s.trim())) return '#own';
  let out = s;
  for (const n of numbers) {
    if (!n || !out.includes(n)) continue;
    let from = 0;
    let built = '';
    for (;;) {
      const at = out.indexOf(n, from);
      if (at < 0) break;
      const before = out[at - 1];
      const after = out[at + n.length];
      const alone = !isAlnum(before) && !isAlnum(after) && (n.length >= 3 || before === '#');
      built += out.slice(from, at) + (alone ? '#own' : n);
      from = at + n.length;
    }
    out = built + out.slice(from);
  }
  return out;
}

/** The time a moment stands for, in milliseconds since 1970 (one without a zone read as UTC). */
function momentMs(s: string): number {
  const iso = s.replace(' ', 'T');
  return Date.parse(MOMENT_ZONE.test(iso) ? iso : `${iso}Z`);
}

/**
 * A day on something the run made, as the key reads it: '<today>' when it is the run's today and
 * the input does not give it (the run filled it in: a date left out defaults to today), so the same
 * request run tomorrow agrees; any other day as it is (one the input gives, or copied from a record
 * that was there before).
 */
function keyDay(day: string, rules: KeyRules): string {
  return rules.today.has(day) && !rules.givenDays.has(day) ? '<today>' : day;
}

/**
 * A moment as the key reads it: '<time>' when it falls in the run's own time span (when the run
 * happened, never what it did, wherever it shows); on something the run made (`made`), its day only
 * (a date it works out from today agrees all day, and a date it copies from elsewhere still
 * counts), read through keyDay; on a record that was there before, as it is.
 */
function keyMoment(s: string, rules: KeyRules, made: boolean): string {
  const ms = momentMs(s);
  if (Number.isFinite(ms) && ms >= rules.span.from - RUN_SPAN_SLACK_MS && ms <= rules.span.to + RUN_SPAN_SLACK_MS) return '<time>';
  if (!made) return s;
  return keyDay(Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : s.slice(0, 10), rules);
}

/**
 * A text as the key reads it. `made`: of something the run made; `ownText`: free text of something
 * the run made, so the numbers it took for itself go too.
 */
function keyText(s: string, rules: KeyRules, made: boolean, ownText: boolean): string {
  const t = s.trim();
  if (MOMENT.test(t)) return keyMoment(t, rules, made);
  if (made && DAY.test(t)) return keyDay(t, rules);
  let out = s.replace(UUID_IN_TEXT, (m) => rules.made.get(m.toLowerCase()) ?? m.toLowerCase());
  if (rules.prefixes.size) out = out.replace(HEX8_TOKEN, (m, lead: string, hex: string) => `${lead}${rules.prefixes.get(hex.toLowerCase()) ?? hex}`);
  if (ownText && rules.numbers.length) out = withoutOwnNumbers(out, rules.numbers);
  return out;
}

/**
 * A whole value (text or number) under `key` that is a number or position the run took for itself
 * in one of that key's columns (columnsOfKey): the same text taken in another column does not count.
 */
function takenValue(v: unknown, key: string, rules: KeyRules): boolean {
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v.trim();
  return s !== '' && columnsOfKey(key).some((c) => rules.taken.has(`${c}:${s}`));
}

/**
 * A value as the key reads it. Keys that hold an id of a record's own row ("id") or a secret are
 * left out; texts go through keyText. `own`: the value is of a record (or an entry) the run made,
 * so what it assigned itself goes: the time of a change ("…At"), a number or position it took (a
 * value of TAKEN_COLUMNS under a key of TAKEN_KEYS naming the column it was taken in, written
 * "#own"), those numbers in its free text (OWN_TEXT_KEY), and its moments are read as their day.
 * On a record that was there before, every time stays (an "…At" too), except the run's own clock
 * (keyMoment), and so does every number, except one the run gave it in place of none (taken
 * earlier, by takenOnExisting, and written "#own" by the key before this reads it); references to
 * records that already existed stay as they are, everywhere.
 */
function keyValue(v: unknown, rules: KeyRules, own = false, key = '', depth = 0): unknown {
  if (typeof v === 'string') return keyText(v, rules, own, own && OWN_TEXT_KEY.test(key));
  if (depth > 32) return null;
  if (Array.isArray(v)) return v.map((item) => keyValue(item, rules, own, key, depth + 1));
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v)) {
      if (k === 'id' || isSecretKey(k) || SECRET_WORDS.test(k)) continue;
      if (own && TIME_KEY.test(k)) continue;
      if (own && TAKEN_KEYS.has(k) && takenValue(item, k, rules)) {
        out[k] = '#own';
        continue;
      }
      out[k] = keyValue(item, rules, own, k, depth + 1);
    }
    return out;
  }
  return v;
}

/** Every id (lower case) a value holds, whole or inside a text. */
function idsIn(v: unknown, into: Set<string>, depth = 0): void {
  if (typeof v === 'string') {
    for (const m of v.matchAll(UUID_IN_TEXT)) into.add(m[0].toLowerCase());
  } else if (depth <= 32 && Array.isArray(v)) {
    for (const item of v) idsIn(item, into, depth + 1);
  } else if (depth <= 32 && isObject(v)) {
    for (const item of Object.values(v)) idsIn(item, into, depth + 1);
  }
}

function addOwnNumber(v: unknown, into: Set<string>): void {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  if (s && s.length <= MAX_OWN_NUMBER && !UUID.test(s)) into.add(s);
}

/** A table of the company file with a uuid `id`, and how its created_at is kept (null: it has none). */
interface IdTable {
  name: string;
  createdAt: 'timestamp' | 'timestamptz' | null;
  /** Its TAKEN_COLUMNS that the table really has. */
  taken: ReadonlyArray<{ column: string; inText: boolean }>;
}

/** The tables with a uuid `id` (the schema is the migrations', the same for every company file). */
let idTableList: readonly IdTable[] | null = null;

async function idTables(db: DB): Promise<readonly IdTable[]> {
  if (idTableList) return idTableList;
  const names = [...new Set(Object.values(TAKEN_COLUMNS).flatMap((cols) => cols.map((c) => c.column)))];
  const own = sql.join(
    names.map((c) => sql`${c}`),
    sql`, `,
  );
  const res = (await db.execute(sql`
    SELECT c.table_name AS name,
           (SELECT k.data_type FROM information_schema.columns k
             WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = 'created_at') AS created_at,
           (SELECT string_agg(k.column_name::text, ',' ORDER BY k.column_name) FROM information_schema.columns k
             WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name::text IN (${own})) AS numbers
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema() AND c.column_name = 'id' AND c.data_type = 'uuid'
     ORDER BY c.table_name`)) as unknown as { rows: Array<{ name: string; created_at: string | null; numbers: string | null }> };
  const list = res.rows
    .filter((r) => /^[a-z_][a-z0-9_]*$/.test(r.name))
    .map((r): IdTable => {
      const has = new Set((r.numbers ?? '').split(','));
      return {
        name: r.name,
        createdAt: r.created_at === 'timestamp without time zone' ? 'timestamp' : r.created_at === 'timestamp with time zone' ? 'timestamptz' : null,
        taken: (Object.hasOwn(TAKEN_COLUMNS, r.name) ? TAKEN_COLUMNS[r.name] : []).filter((c) => has.has(c.column)),
      };
    });
  if (list.length) idTableList = list;
  return list;
}

/** The numbers and positions the run took for itself: all of them, and those its text may repeat. */
interface Taken {
  /** By the column taken in: "<keyForm of the column>:<value>" (KeyRules.taken). */
  all: Set<string>;
  /** As text only (KeyRules.numbers). */
  inText: Set<string>;
}

/**
 * The numbers and positions the rows the run made hold in their TAKEN_COLUMNS, read inside its
 * transaction. Only rows of ids the run made (runIdsOf), so a number of a record that was there
 * before is never taken for one the run took. And never one the input gives, or that a record the
 * run voided, deleted or changed held before it, under the same key (`heldBefore`, heldBeforeRun):
 * a check written again with the number of the one it replaces copies that number, it does not
 * take the next free one.
 */
async function takenOfRows(ctx: ServiceContext, made: ReadonlyMap<string, ReadonlySet<string>>, heldBefore: ReadonlySet<string>, into: Taken): Promise<void> {
  const ids = [...made.keys()].filter((id) => UUID.test(id)).slice(0, MAX_LOOKED_UP_IDS);
  if (!ids.length) return;
  const tables = (await idTables(ctx.db)).filter((t) => t.taken.length);
  if (!tables.length) return;
  // Every id passed the UUID pattern and every name the identifier pattern, so both are written in place.
  const list = `ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`;
  const parts = tables.flatMap((t) =>
    t.taken.map(
      (c) => `SELECT '${c.column}' AS c, "${c.column}"::text AS n, ${c.inText ? 'true' : 'false'} AS in_text FROM "${t.name}" WHERE id = ANY(${list}) AND "${c.column}" IS NOT NULL`,
    ),
  );
  const res = (await ctx.db.execute(sql.raw(parts.join(' UNION ALL ')))) as unknown as {
    rows: Array<{ c: string; n: string | null; in_text: boolean }>;
  };
  for (const r of res.rows) {
    const one = new Set<string>();
    addOwnNumber(r.n, one);
    for (const n of one) {
      if (heldBefore.has(`${keyForm(r.c)}:${n}`)) continue;
      into.all.add(`${keyForm(r.c)}:${n}`);
      if (r.in_text) into.inText.add(n);
    }
  }
}

/** An audit row's value that stands for "no number yet": absent, null or blank. */
function blankNumber(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * The next free number the run gave a record that was there before and had none: a check marked
 * printed with no number given (lib/services/printQueue.ts markPrinted: allocateCheckNumber, then
 * the number on the check and an audit 'update' from none to it). Two waiting requests that each
 * print a check take "the next number", so it is the run's own on that record too.
 *
 * Only exactly that: a key of TAKEN_KEYS at the top of an audit row other than 'create' of a
 * record the run did not make, whose old values hold that same key with no number (so the change
 * shows: a key the audit row leaves out of its old values could have held the same number before),
 * whose new value the record's row now holds in a column of TAKEN_COLUMNS that key may name
 * (columnsOfKey, read in the run's transaction), and that neither the input nor a record the run
 * changed held under any key (`heldBefore`: a number copied from either stays). A number changed
 * from one to another stays too (a renumbering is asked for, never the next free one by itself),
 * as does a number on a record of any other table.
 *
 * Adds what it finds to `into` (by its column, as takenOfRows does) and answers the audit keys to
 * write "#own" on those records, as "<record id> <key>".
 */
async function takenOnExisting(
  ctx: ServiceContext,
  audit: readonly AuditRow[],
  made: ReadonlyMap<string, ReadonlySet<string>>,
  heldBefore: ReadonlySet<string>,
  into: Taken,
): Promise<Set<string>> {
  const out = new Set<string>();
  // Whatever key held it: a number the input or an earlier record gives is copied, not taken.
  const heldValues = new Set([...heldBefore].map((h) => h.slice(h.indexOf(':') + 1)));
  const candidates: Array<{ id: string; key: string; value: string }> = [];
  for (const r of audit) {
    if (r.action === 'create') continue;
    const id = r.entity_id.toLowerCase();
    if (!UUID.test(id) || made.has(id) || !isObject(r.old_values) || !isObject(r.new_values)) continue;
    for (const [k, v] of Object.entries(r.new_values)) {
      if (!TAKEN_KEYS.has(k) || !Object.hasOwn(r.old_values, k) || !blankNumber(r.old_values[k])) continue;
      const one = new Set<string>();
      addOwnNumber(v, one);
      for (const n of one) if (!heldValues.has(n)) candidates.push({ id, key: k, value: n });
    }
  }
  if (!candidates.length) return out;
  const ids = [...new Set(candidates.map((c) => c.id))].slice(0, MAX_LOOKED_UP_IDS);
  const tables = (await idTables(ctx.db)).filter((t) => t.taken.length);
  if (!tables.length) return out;
  // Every id passed the UUID pattern and every name the identifier pattern, so both are written in place.
  const list = `ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`;
  const parts = tables.flatMap((t) =>
    t.taken.map(
      (c) =>
        `SELECT id::text AS id, '${c.column}' AS c, "${c.column}"::text AS n, ${c.inText ? 'true' : 'false'} AS in_text FROM "${t.name}" WHERE id = ANY(${list}) AND "${c.column}" IS NOT NULL`,
    ),
  );
  const res = (await ctx.db.execute(sql.raw(parts.join(' UNION ALL ')))) as unknown as {
    rows: Array<{ id: string; c: string; n: string | null; in_text: boolean }>;
  };
  const held = new Map<string, Array<{ column: string; inText: boolean }>>();
  for (const r of res.rows) {
    const n = typeof r.n === 'string' ? r.n.trim() : '';
    if (!n) continue;
    const at = `${r.id.toLowerCase()} ${n}`;
    held.set(at, [...(held.get(at) ?? []), { column: keyForm(r.c), inText: r.in_text === true }]);
  }
  for (const c of candidates) {
    const columns = columnsOfKey(c.key);
    const found = (held.get(`${c.id} ${c.value}`) ?? []).filter((h) => columns.includes(h.column));
    if (!found.length) continue;
    for (const f of found) {
      into.all.add(`${f.column}:${c.value}`);
      if (f.inText) into.inText.add(c.value);
    }
    out.add(`${c.id} ${c.key}`);
  }
  return out;
}

/**
 * An existing record's audit values with the numbers the run gave it in place of none
 * (takenOnExisting) written "#own"; every other value as it is.
 */
function withTakenOnExisting(values: unknown, id: string, keys: ReadonlySet<string>): unknown {
  if (!keys.size || !isObject(values)) return values;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(values)) {
    if (!keys.has(`${id} ${k}`)) continue;
    out ??= { ...values };
    out[k] = '#own';
  }
  return out ?? values;
}

/**
 * A General Journal entry's reference is its Entry No., the next one when the input gives none
 * (lib/services/journal.ts nextManualJournalNumber, entries with sourceRef 'manual'): a number the
 * run took, unless the input gives it or an entry the run changed held it (`heldBefore`).
 */
function takenOfManualEntries(ledger: readonly LedgerRow[], heldBefore: ReadonlySet<string>, into: Taken): void {
  for (const l of ledger) {
    if (l.source_ref !== 'manual' || !l.reference) continue;
    const one = new Set<string>();
    addOwnNumber(l.reference, one);
    for (const n of one) {
      if (heldBefore.has(`reference:${n}`)) continue;
      into.all.add(`reference:${n}`);
      into.inText.add(n);
    }
  }
}

/** A key or column name as heldBeforeRun compares them: "ref_number" and "refNumber" alike. */
function keyForm(k: string): string {
  return k.replace(/_/g, '').toLowerCase();
}

/** Every value under TAKEN_KEYS in `v`, at any depth, as "<keyForm>:<value>" ("refnumber:1043"). */
function numbersUnderKeys(v: unknown, into: Set<string>, depth = 0): void {
  if (depth > 32 || into.size > 5000) return;
  if (Array.isArray(v)) {
    for (const item of v) numbersUnderKeys(item, into, depth + 1);
  } else if (isObject(v)) {
    for (const [k, item] of Object.entries(v)) {
      if (TAKEN_KEYS.has(k) && (typeof item === 'string' || typeof item === 'number')) {
        const one = new Set<string>();
        addOwnNumber(item, one);
        for (const n of one) into.add(`${keyForm(k)}:${n}`);
      } else {
        numbersUnderKeys(item, into, depth + 1);
      }
    }
  }
}

/**
 * What a record that was there before held under TAKEN_KEYS, as the run's audit rows of it kept
 * them (old values of a record it voided, deleted or changed), and what the input gives under them
 * (`given`, givenNumbersOf): a number the run copies from either is not the next free one.
 */
function heldBeforeRun(audit: readonly AuditRow[], made: ReadonlyMap<string, ReadonlySet<string>>, given: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(given);
  for (const r of audit) if (r.action !== 'create' && !made.has(r.entity_id.toLowerCase())) numbersUnderKeys(r.old_values, out);
  return out;
}

/**
 * The numbers the input gives under TAKEN_KEYS (a typed invoice number, check number, account
 * number or rule position): the agent's, never the next free one, so they count where they show.
 * By key and value, so a P.O. number the input gives is never taken for an invoice number the run
 * took that happens to be the same.
 */
function givenNumbersOf(input: OperationInput): Set<string> {
  const out = new Set<string>();
  numbersUnderKeys(input.body, out);
  numbersUnderKeys(input.query, out);
  return out;
}

/**
 * Where an id was found: 'made' (this run wrote its row, created from the run's start on),
 * 'written' (this run wrote its row, but its created_at does not say it was new: a table without
 * one, or a service that dated it back, as FIFO's opening layer is, a millisecond before the
 * receipt that follows it), or 'existed' (this run did not write it: it was there before).
 */
type Found = 'made' | 'written' | 'existed';

/**
 * Look the ids up in every table with a uuid `id`, inside the run's transaction. A row this
 * transaction did not write (xmin) was there before the run. One it wrote counts as made by the run
 * when it was created from the run's start on (created_at: the database's own now() for a default,
 * or the app's clock, which is later); otherwise it is only 'written', and runIdsOf decides on the
 * audit trail. An id found nowhere is absent from the answer.
 */
async function findIds(ctx: ServiceContext, ids: readonly string[]): Promise<Map<string, Found>> {
  const out = new Map<string, Found>();
  if (!ids.length) return out;
  const tables = await idTables(ctx.db);
  if (!tables.length) return out;
  // Every id passed the UUID pattern (hex digits and dashes only), so it can be written in place.
  const list = `ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::uuid[]`;
  const written = `(((t.xmin::text::bigint - (txid_current() % ${XID_SPAN})) % ${XID_SPAN}) + ${XID_SPAN}) % ${XID_SPAN} < ${OWN_XID_WINDOW}`;
  const state = (t: IdTable): string => {
    if (t.createdAt === null) return `CASE WHEN ${written} THEN 'written' ELSE 'existed' END`;
    const since =
      t.createdAt === 'timestamptz'
        ? `t.created_at >= date_trunc('milliseconds', now())`
        : `(t.created_at = now() OR t.created_at >= date_trunc('milliseconds', now() AT TIME ZONE 'UTC'))`;
    return `CASE WHEN NOT (${written}) THEN 'existed' WHEN ${since} THEN 'made' ELSE 'written' END`;
  };
  const parts = tables.map((t) => `SELECT t.id::text AS id, ${state(t)} AS state FROM "${t.name}" t JOIN ids ON ids.id = t.id`);
  const res = (await ctx.db.execute(sql.raw(`WITH ids(id) AS (SELECT unnest(${list})) ${parts.join(' UNION ALL ')}`))) as unknown as {
    rows: Array<{ id: string; state: Found }>;
  };
  // Found in more than one table: it existed if any says so, then written (fail closed, the id stays).
  const rank: Record<Found, number> = { existed: 2, written: 1, made: 0 };
  for (const r of res.rows) {
    const id = r.id.toLowerCase();
    const state: Found = r.state === 'made' || r.state === 'written' ? r.state : 'existed';
    const was = out.get(id);
    if (was === undefined || rank[state] > rank[was]) out.set(id, state);
  }
  return out;
}

/** Most ids looked up for one run; past that, the rest stay in the key as they are (fail closed). */
const MAX_LOOKED_UP_IDS = 5000;

/**
 * The ids this run made, each with the kinds of record it is (a set: an audit 'create' of a second
 * kind on the same id, a retainage billing on the invoice it bills, say, adds a kind and changes
 * nothing). Read inside the run's transaction, after the handler ran:
 *  - the entries it posted (created_at = now()) and every id of a row this transaction inserted
 *    (findIds 'made'), wherever it shows: an audit row's own id, or a value (creditApplicationId,
 *    depreciationEntryId, bouncedCheckId, applicationId, an account made on first use);
 *  - a row this transaction wrote whose created_at cannot say it is new (a table without one, a
 *    row dated back), when an audit 'create' names it;
 *  - an id an audit 'create' names, or one only a value holds, that names no row at all (made up
 *    by the run, "assembly_build:<id>");
 *  - never an id the input names, an entry the run voided, deleted or changed, a row this run did
 *    not write, a row it wrote that no audit 'create' names, or a record an audit row other than
 *    'create' names and that is gone (deleted): those stay in the key as they are (fail closed).
 */
async function runIdsOf(
  ctx: ServiceContext,
  parts: { inputIds: readonly string[]; audit: readonly AuditRow[]; ledger: readonly LedgerRow[]; effects: readonly EffectPreview[]; touched: readonly TouchedEntry[] },
): Promise<Map<string, Set<string>>> {
  const made = new Map<string, Set<string>>();
  const kind = (id: string, k: string) => made.set(id, new Set([...(made.get(id) ?? []), k]));
  for (const l of parts.ledger) kind(l.entry_id.toLowerCase(), 'journal_entry');
  const existed = new Set<string>([...parts.inputIds.map((i) => i.toLowerCase()), ...parts.touched.map((t) => t.id.toLowerCase())]);

  const created = new Map<string, Set<string>>();
  const named = new Set<string>();
  const seen = new Set<string>();
  for (const r of parts.audit) {
    const id = r.entity_id.toLowerCase();
    if (UUID.test(id)) {
      seen.add(id);
      if (r.action === 'create') created.set(id, new Set([...(created.get(id) ?? []), r.entity_type]));
      else named.add(id);
    }
    idsIn(r.old_values, seen);
    idsIn(r.new_values, seen);
  }
  for (const l of parts.ledger) idsIn([l.account_id, l.entity_id, l.class_id, l.description, l.source_ref, l.reference, l.memo], seen);
  for (const e of parts.effects) idsIn(e.detail, seen);

  const look = [...seen].filter((id) => !made.has(id) && !existed.has(id)).slice(0, MAX_LOOKED_UP_IDS);
  const found = await findIds(ctx, look);
  for (const id of look) {
    const where = found.get(id);
    if (where === 'existed') continue;
    const kinds = created.get(id);
    if (where === 'made') {
      for (const k of kinds ?? ['record']) kind(id, k);
    } else if (kinds) {
      // Written by this run (or in no table at all), and an audit 'create' says the run made it.
      for (const k of kinds) kind(id, k);
    } else if (where === undefined && !named.has(id)) {
      // Names no row anywhere and no audit row says it was there: made up by the run.
      kind(id, 'value');
    }
  }
  return made;
}

/**
 * The rules the key reads values through: the ids the run made, their 8-digit prefixes, the
 * numbers and positions it took for itself (`taken`: TAKEN_COLUMNS of the rows it made, read by
 * takenOfRows; a journal entry's reference is not one, but a General Journal entry's Entry No. is),
 * its own time span and its today.
 */
function keyRulesOf(
  made: ReadonlyMap<string, ReadonlySet<string>>,
  taken: Taken,
  span: KeyRules['span'],
  days: { today: ReadonlySet<string>; givenDays: ReadonlySet<string> },
): KeyRules {
  const ids = new Map<string, string>();
  const prefixes = new Map<string, string>();
  for (const [id, kinds] of made) {
    const p = placeholderOf(kinds);
    ids.set(id, p);
    prefixes.set(id.slice(0, 8), p);
  }
  return {
    made: ids,
    prefixes,
    numbers: [...taken.inText].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)),
    taken: taken.all,
    span,
    today: days.today,
    givenDays: days.givenDays,
  };
}

/**
 * The run's today, as a service may write a date it fills in: this computer's calendar day
 * (lib/dates.ts todayISO, reportEngine localToday, inventory todayCalendarDay), the UTC day
 * (`new Date().toISOString().slice(0, 10)`, recurring todayUtcMidnight) and the company's own
 * (lib/preferences.ts todayInTimeZone), at the run's start and at its end (the app's own clock).
 */
function todayOf(times: readonly number[], timeZone: string | null): Set<string> {
  const out = new Set<string>();
  for (const t of times) {
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    out.add(localDateISO(d));
    out.add(d.toISOString().slice(0, 10));
    out.add(todayInTimeZone(timeZone, d));
  }
  return out;
}

/**
 * Every day the input gives (as a date, or as the day of a moment), at any depth. Not under a key
 * of a record's version or time stamp ("updatedAt", "expectedUpdatedAt", "version", any "…At"): a
 * version the agent sends back is not a date it gives the work, and taking today's for one would
 * keep the date the run fills in as today in the key, so the request would go stale at midnight.
 */
function givenDaysOf(input: OperationInput): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 32 || out.size > 1000) return;
    if (typeof v === 'string') {
      const t = v.trim();
      if (DAY.test(t)) out.add(t);
      else if (MOMENT.test(t)) {
        out.add(t.slice(0, 10));
        const ms = momentMs(t);
        if (Number.isFinite(ms)) out.add(new Date(ms).toISOString().slice(0, 10));
      }
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
    } else if (isObject(v)) {
      for (const [k, item] of Object.entries(v)) {
        if (TIME_KEY.test(k) || (VERSION_KEYS as readonly string[]).includes(k)) continue;
        walk(item, depth + 1);
      }
    }
  };
  walk(input.params, 0);
  walk(input.query, 0);
  walk(input.body, 0);
  return out;
}

/**
 * The run's own time span, read in its transaction: from the transaction's start (the database's
 * now(), which every default timestamp of the run takes) to the app's clock now.
 */
async function runSpanOf(ctx: ServiceContext): Promise<KeyRules['span']> {
  const res = (await ctx.db.execute(sql`SELECT floor(extract(epoch from now()) * 1000)::bigint::text AS ms`)) as unknown as { rows: Array<{ ms: string }> };
  const from = Number(res.rows[0]?.ms);
  const to = Date.now();
  return { from: Number.isFinite(from) ? Math.min(from, to) : to, to };
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
/**
 * The parts of an effect that say what it does (not its size, nor a file id made for this run).
 * Its subject, file name and attachment names are the run's own text: a number it took for itself
 * there ("Invoice 1043.pdf") goes too.
 */
function effectKey(e: EffectPreview, rules: KeyRules): string {
  const d = isObject(e.detail) ? e.detail : {};
  const picked: Record<string, unknown> = { kind: e.kind };
  for (const k of ['to', 'cc', 'bcc', 'subject', 'dir', 'name', 'replaces', 'printer', 'copies', 'host', 'purpose']) {
    if (d[k] !== undefined) picked[k] = d[k];
  }
  if (Array.isArray(d.attachments)) picked.attachments = d.attachments.map((a) => (isObject(a) ? (a.name ?? null) : null));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(picked)) out[k] = keyValue(v, rules, ['subject', 'name', 'attachments'].includes(k), k);
  return stableJson(out);
}

/**
 * Who carries the work out is not a change in the books: the agent's own trial run when it asks
 * has no person, the run at approval is the approver's. Columns that name the person acting
 * (createdBy, userId …) are left out of a record's values, at the top level (the record's own
 * columns). A record changed by someone else since still moves its version, which the key keeps.
 */
const ACTOR_KEYS: ReadonlySet<string> = new Set([
  'createdBy',
  'created_by',
  'updatedBy',
  'updated_by',
  'enteredBy',
  'entered_by',
  'userId',
  'user_id',
  'modifiedBy',
  'modified_by',
  'approvedBy',
  'approved_by',
]);

function withoutActors(values: unknown): unknown {
  if (!isObject(values)) return values;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (!ACTOR_KEYS.has(k)) out[k] = v;
  return out;
}

/**
 * The staleness key (plan §7.4): a hash over what the run read and what it did, with what the run
 * assigns to itself left out (KeyRules: the ids it made, the numbers it took, times). Lists are
 * sorted: the audit trail's own order is not the order of the work (its ids are random).
 */
function stalenessKeyOf(parts: {
  operation: Operation;
  status: number;
  named: readonly string[];
  ledger: readonly LedgerRow[];
  audit: readonly AuditRow[];
  effects: readonly EffectPreview[];
  touched: readonly TouchedEntry[];
  made: ReadonlyMap<string, ReadonlySet<string>>;
  taken: Taken;
  /** The numbers the run gave records that were there before, in place of none (takenOnExisting). */
  takenOnRecords: ReadonlySet<string>;
  span: KeyRules['span'];
  today: ReadonlySet<string>;
  givenDays: ReadonlySet<string>;
}): string {
  const rules = keyRulesOf(parts.made, parts.taken, parts.span, { today: parts.today, givenDays: parts.givenDays });

  // The ledger: every line of every entry made, by account, amount, memo and name, with its date
  // (its day), description, status, source and reference. Its entry number is the run's own (the
  // next number): not read at all. Its reference is read as text of what the run made, so only
  // what the run took for itself goes from it (a check or document number it took, a General
  // Journal Entry No., a paycheck's id cut short); a reference it copied from somewhere else (a
  // bill's number, a bank line's check number) stays.
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
            entryReference: lines[0].reference,
            lines: lines
              .map((l) =>
                stableJson(
                  keyValue({ account: l.account_id, debit: amount(l.debit), credit: amount(l.credit), memo: l.memo, nameType: l.entity_type, name: l.entity_id, class: l.class_id }, rules, true),
                ),
              )
              .sort(),
          },
          rules,
          true,
        ),
      ),
    )
    .sort();

  // The records written: their values, and the version each record that already existed had
  // before the run (the earliest its audit rows show: a record changed twice shows its in-run
  // version on the second row). A record the run made is written by its kinds, never its id. On a
  // record that already existed, a number the run gave it in place of none is its own.
  const records: string[] = [];
  const firstVersion = new Map<string, string>();
  for (const r of parts.audit) {
    const id = r.entity_id.toLowerCase();
    const own = rules.made.get(id);
    const after = own === undefined ? withTakenOnExisting(r.new_values, id, parts.takenOnRecords) : r.new_values;
    records.push(
      stableJson({
        action: r.action,
        kind: r.entity_type,
        id: own ?? id,
        before: keyValue(withoutActors(r.old_values), rules, own !== undefined),
        after: keyValue(withoutActors(after), rules, own !== undefined),
      }),
    );
    const v = own !== undefined ? null : versionIn(r.old_values);
    if (v !== null) {
      const k = `${r.entity_type}:${id}`;
      const seen = firstVersion.get(k);
      if (seen === undefined || earlier(v, seen) < 0) firstVersion.set(k, v);
    }
  }
  const versions = [...firstVersion].map(([k, v]) => `${k}:${v}`).sort();

  // Entries that existed and that the run voided, deleted or changed: by their own (lasting) ids.
  // Left out when there are none, so the key of every other run is what it was before.
  const touched = parts.touched
    .map((t) => stableJson({ id: t.id.toLowerCase(), how: t.how, status: t.status, counted: t.counted, unknown: t.unknown }))
    .sort();

  return sha256(
    stableJson({
      key: 'bridge-staleness-v5',
      operation: parts.operation.id,
      status: parts.status,
      named: parts.named,
      ledger,
      touched: touched.length ? touched : undefined,
      records: records.sort(),
      versions,
      effects: parts.effects.map((e) => effectKey(e, rules)).sort(),
    }),
  );
}

interface Collected {
  preview: OperationPreview;
  /** What the run moves in the ledger (facts). */
  ledger: LedgerTotals;
  stalenessKey: string;
}

/** What the run read before the handler ran, in its transaction (versionsOf, draftsBefore). */
interface Before {
  /** The ids the input names: records that were there before the run (or nothing at all). */
  inputIds: readonly string[];
  named: readonly string[];
  drafts: ReadonlySet<string> | null;
  /** The app's clock as the run starts (its today, with the clock at its end: todayOf). */
  startedAt: number;
  /** The company's time zone (Preferences > Company), for its today. */
  timeZone: string | null;
  /** The days the input gives (givenDaysOf). */
  givenDays: ReadonlySet<string>;
  /** The numbers the input gives, by key (givenNumbersOf). */
  givenNumbers: ReadonlySet<string>;
}

async function readBefore(ctx: ServiceContext, companyId: string, input: OperationInput, timeZone: string | null): Promise<Before> {
  const startedAt = Date.now();
  const inputIds = namedIds(input);
  return {
    inputIds,
    named: await versionsOf(ctx.db, companyId, inputIds),
    drafts: await draftsBefore(ctx.db, companyId),
    startedAt,
    timeZone,
    givenDays: givenDaysOf(input),
    givenNumbers: givenNumbersOf(input),
  };
}

/**
 * The run voided, deleted or changed a record that existed before it: an audit row other than
 * 'create', of a record it did not make (lib/agent/bridge.ts runIdsOf).
 */
function editsExistingRecord(audit: readonly AuditRow[], made: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  return audit.some((r) => r.action !== 'create' && !made.has(r.entity_id.toLowerCase()));
}

/**
 * The lines of the entries the run made, with who each is for and its class, in the order
 * changesInTransaction lists them (entry number, debits first, then the line's id): what
 * changesInTransaction does not fill in yet is filled in from these. A line whose account or
 * amounts do not match the row in its place keeps what it has (nothing is guessed).
 */
async function nameMadeLines(ctx: ServiceContext, entries: PostingEntry[]): Promise<void> {
  if (!entries.length) return;
  const res = (await ctx.db.execute(sql`
    SELECT je.id::text AS entry_id, l.account_id::text AS account_id, l.debit::text AS debit, l.credit::text AS credit,
           l.entity_type, l.entity_id::text AS entity_id, l.class_id::text AS class_id
      FROM journal_entries je
      JOIN journal_entry_lines l ON l.journal_entry_id = je.id
     WHERE je.company_id = ${ctx.companyId} AND je.created_at = now()
     ORDER BY je.entry_number, (l.debit IS NULL OR l.debit = 0), l.id`)) as unknown as {
    rows: Array<{ entry_id: string; account_id: string; debit: string | null; credit: string | null; entity_type: string | null; entity_id: string | null; class_id: string | null }>;
  };
  const byEntry = new Map<string, typeof res.rows>();
  for (const r of res.rows) byEntry.set(r.entry_id.toLowerCase(), [...(byEntry.get(r.entry_id.toLowerCase()) ?? []), r]);
  const all: Array<{ line: NamedPostingLine; ref: LineRef }> = [];
  for (const e of entries) {
    const rows = byEntry.get(e.journalEntryId.toLowerCase()) ?? [];
    e.lines.forEach((raw, i) => {
      const line = raw as NamedPostingLine;
      const row = rows[i];
      const same = row && row.account_id.toLowerCase() === String(line.accountId).toLowerCase() && lineAmount(row.debit) === line.debit && lineAmount(row.credit) === line.credit;
      const ref: LineRef = same ? { entityType: row.entity_type, entityId: row.entity_id, classId: row.class_id } : { entityType: null, entityId: null, classId: null };
      if (line.entityName === undefined) line.entityName = null;
      if (line.className === undefined) line.className = null;
      if (line.entityType === undefined) line.entityType = null;
      all.push({ line, ref });
    });
  }
  await nameLines(ctx, all);
}

/**
 * Read back what the run did, still inside its transaction. The ledger preview lists the entries
 * the run makes, then those it voids, deletes or changes (their description says which), at most
 * PREVIEW_ROW_LIMIT in all, their memos and descriptions as the run may show them (shownText), each
 * line naming who it is for and its class. `warnings`: what the route warned about before the
 * agent's confirmation flags accepted it (withheldWarnings), for the person approving it.
 */
async function collect(
  ctx: ServiceContext,
  operation: Operation,
  access: EffectiveAccess,
  effects: EffectPreview[],
  before: Before,
  status: number,
  warnings: readonly WarningPreview[] = [],
): Promise<Collected> {
  const { named } = before;
  const ledger = await changesInTransaction(ctx);
  const lines = await ledgerRowsInTransaction(ctx);
  const rows = await auditRowsInTransaction(ctx);
  const touched = await touchedEntries(ctx, rows, new Set(lines.map((l) => l.entry_id.toLowerCase())), before.drafts);
  const made = await runIdsOf(ctx, { inputIds: before.inputIds, audit: rows, ledger: lines, effects, touched });
  const span = await runSpanOf(ctx);
  const taken: Taken = { all: new Set(), inText: new Set() };
  const held = heldBeforeRun(rows, made, before.givenNumbers);
  await takenOfRows(ctx, made, held, taken);
  const takenOnRecords = await takenOnExisting(ctx, rows, made, held, taken);
  takenOfManualEntries(lines, held, taken);
  const today = todayOf([before.startedAt, span.to], before.timeZone);
  // changesInTransaction gives the memos as stored: a reversal copies its entry's, account numbers and all.
  const madeShown = ledger.entries.slice(0, PREVIEW_ROW_LIMIT).map((e) => shownEntry(ctx, e));
  await nameMadeLines(ctx, madeShown);
  const touchedShown = await touchedPreview(ctx, touched, rows, PREVIEW_ROW_LIMIT - madeShown.length);
  const { records, cut } = recordDiffs(rows, operation, access);
  const shown = capped(effects);
  const truncated =
    cut ||
    shown.truncated ||
    ledger.entries.length + touched.length > PREVIEW_ROW_LIMIT ||
    ledger.changes.length > PREVIEW_ROW_LIMIT ||
    records.length > PREVIEW_ROW_LIMIT;
  return {
    ledger: ledgerTotals(lines, touched, editsExistingRecord(rows, made), await ledgerAccountsOf(ctx, lines, touched, rows)),
    stalenessKey: stalenessKeyOf({ operation, status, named, ledger: lines, audit: rows, effects, touched, made, taken, takenOnRecords, span, today, givenDays: before.givenDays }),
    preview: {
      ledger: { entries: [...madeShown, ...touchedShown], changes: ledger.changes.slice(0, PREVIEW_ROW_LIMIT) } satisfies ChangePreview,
      records: records.slice(0, PREVIEW_ROW_LIMIT),
      effects: shown.list,
      warnings: [...warnings],
      loss: lossOf(rows),
      routePreview: null,
      truncated,
    },
  };
}

/**
 * After an agent's run committed and what it queued was released: one audit row for each email,
 * file or print job that FAILED, so a record that says an email went out ("emailed", written in the
 * run's transaction) is followed by one that says it did not (lib/effects.ts header). The row is on
 * the record the service named (EffectAbout; else on the agent), with the run's agent, approval,
 * request and grant, and says what it was, to whom and why it failed. A sales form's email also
 * puts the form back in its "to be emailed" queue (salesForms.ts putBackAfterFailedEmail). Never
 * throws: the work is committed either way, and the agent gets its answer. Returns the reports as
 * the agent reads them (without `about`).
 */
async function recordFailedEffects(db: DB, parts: RunContextParts, reports: readonly EffectReport[]): Promise<EffectReport[]> {
  const failed = reports.filter((r) => r.status === 'failed' && !r.ranDuringOperation);
  if (failed.length) {
    const own = handlerContext(db, parts, false);
    // Recording what happened changes nothing in the books: a view-only role may record it.
    const ctx: ServiceContext = { ...own, role: own.role === 'viewer' ? undefined : own.role };
    for (const r of failed) {
      try {
        await inTransaction(ctx, async (tx) => {
          const about = r.about && UUID.test(r.about.entityId) ? r.about : null;
          let putBack: Record<string, unknown> | null = null;
          if (about?.onFailure && r.effect.kind === 'email') {
            const forms = await import('@/lib/services/salesForms');
            if (about.onFailure.putBack === forms.SALES_FORM_EMAIL) putBack = await forms.putBackAfterFailedEmail(tx, about.entityType, about.entityId, about.onFailure);
          }
          await writeAudit(tx, {
            action: 'update',
            entityType: about ? about.entityType : 'agent',
            entityId: about ? about.entityId : parts.actor.agent.id,
            newValues: failedEffectValues(r, putBack),
          });
        });
      } catch (err) {
        console.error('[agent bridge] a failed email, file or print job could not be recorded', err);
      }
    }
  }
  return reports.map(({ about: _about, ...rest }) => rest);
}

/** What the audit row of a failed effect says (recordFailedEffects). */
function failedEffectValues(r: EffectReport, putBack: Record<string, unknown> | null): Record<string, unknown> {
  const d = isObject(r.effect.detail) ? r.effect.detail : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    action: r.effect.kind === 'email' ? 'email_failed' : `${r.effect.kind}_failed`,
    what: r.effect.summary,
    ...(r.effect.kind === 'email'
      ? { to: list(d.to), cc: list(d.cc), bcc: list(d.bcc), subject: typeof d.subject === 'string' ? d.subject : '' }
      : {}),
    error: r.error ?? 'It did not go through.',
    ...(putBack ? { putBack } : {}),
  };
}

/**
 * Called inside a commit's transaction, before it ends, with what the run did (its facts, preview
 * and staleness key): the message to refuse it with when what it did is no longer what it was
 * judged on (lib/agent/operate.ts: a run under a grant or under Allow, judged on its dry run's
 * facts, whose record changed in between), or null to keep it. A refusal rolls everything back.
 */
export type CommitCheck = (committed: BridgeResult) => string | null;

/** What a caller of runOperation may add to the contract's arguments. */
export interface RunOptions {
  /** A commit inside a transaction is checked with it before the transaction ends (CommitCheck). */
  commitCheck?: CommitCheck;
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
  if (raw.status === 409 || raw.status === 400) {
    const named = raw.status === 409 ? namedFlags(answer.body as Record<string, unknown>) : warningFlagsOf400(answer.body as Record<string, unknown>);
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
 * Warnings a route answers with a 400 rather than a 409, by the flag that accepts them: only the
 * markers listed here, so an ordinary 400 (a field the route cannot read) stays the error it is.
 *  - details.tieOut with ok false: POST /api/import's reviewed statement rows do not tie out
 *    (opening + rows is not closing), or the balances are missing. The page asks "import anyway?"
 *    and resends with statement.acknowledgeDifference (WAVE1 note 7).
 */
function warningFlagsOf400(body: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  if (body.code !== undefined && body.code !== 'VALIDATION') return out;
  const details = isObject(body.details) ? body.details : {};
  if (isObject(details.tieOut) && details.tieOut.ok === false) out.add('statement.acknowledgeDifference');
  return out;
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
 * The request's facts, with the amount the run moves in the ledger. `ledger` is what a run that
 * went through showed (a dry run or a commit in a transaction); null when there was no such run
 * (a refusal, an error answer, a warning, a read, a dryRun 'none' commit on its own handle).
 *
 *  - An operation that names an amount field: the larger of what factsOf found and the largest
 *    single entry the run made, voided, deleted or changed; for a mixed run (LedgerTotals.mixed:
 *    it takes money out of one document and posts another), the larger of the field and all of
 *    it (LedgerTotals.sum), so both sides count. Its amount field not read (absent, or
 *    unreadable) keeps null: that is "over every limit" to the policy, and nothing the ledger
 *    shows makes it smaller.
 *  - An operation with no amount field: what the run moves, all of it (LedgerTotals.sum), so a
 *    bulk accept, a rules run, a batch enter or void, a reclassify is judged at its whole, not its
 *    largest row. With no entry made or touched: "0.00" when the run only made new records (a new
 *    customer, a time entry: nothing to compare with a limit), and unknown (null) when it voided,
 *    deleted or changed a record that existed before it (a payroll adjustment that never posted,
 *    an applied credit: money may move that no entry shows). A check number or a title given to a
 *    posted entry touches an entry and moves none of it: "0.00". A touched entry whose total cannot
 *    be known keeps null (fail closed).
 */
function factsFor(operation: Operation, input: OperationInput, closingDate: string | null, answer: unknown, ledger: LedgerTotals | null): RequestFacts {
  const named = factsOf(operation, input, answer === undefined ? { closingDate } : { closingDate, answer });
  if (ledger === null) return named;
  // The accounts the run posts to, besides those the body and the answer name (an item line's).
  const facts = withLedgerAccounts(named, ledger.accountIds);
  if (ledger.unknown) return { ...facts, amount: null };
  if (operation.amountField) {
    const seen = ledger.mixed ? ledger.sum : ledger.largest;
    if (facts.amount === null || seen === null) return facts;
    try {
      return Money.gt(seen, Money.abs(facts.amount)) ? { ...facts, amount: seen } : facts;
    } catch {
      return { ...facts, amount: null };
    }
  }
  if (ledger.any) return { ...facts, amount: ledger.sum };
  return { ...facts, amount: ledger.editsExisting ? null : '0.00' };
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export const runOperation = (async (
  base: ServiceContext,
  operation: Operation,
  input: OperationInput,
  mode: BridgeMode,
  actor: BridgeActor,
  opts: RunOptions = {},
): Promise<BridgeResult> => {
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

  // 2. What the agent may never supply; secrets from the approving person: all of them on a
  // commit, only the closing-date password on a dry run, none on a read.
  const guarded = guardInput(operation, given);
  if (guarded.refused) return refuse(guarded.refused, 'REFUSED', { stripped: guarded.stripped });
  const asked = guarded.input;
  const version = expectedVersionOf(given);
  if ('error' in version) return refuse(version.error, 'VALIDATION');
  let runInput: OperationInput = asked;
  let secretHeaders: Record<string, string> = {};
  if (mode === 'commit') {
    const secrets = actor.secrets ?? {};
    const applied = applySecrets(operation, asked, secrets);
    const missing = [...new Set([...applied.missing, ...operation.needsSecret.filter((k) => !secretValue(secrets, k))])].filter(
      (k) => !OPTIONAL_ROUTE_SECRETS.includes(k),
    );
    if (missing.length) {
      return refuse(
        'This needs a password or key that only the approving person can type. Ask for it to be approved, and the person types it on the approval card.',
        'SECRET_NEEDED',
        { secrets: missing },
      );
    }
    runInput = applied.input;
    secretHeaders = applied.headers;
  } else if (mode === 'dry_run' && secretValue(actor.secrets, 'closing_password') !== null) {
    const applied = applySecrets(operation, asked, { closing_password: secretValue(actor.secrets, 'closing_password')! });
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

  // 3. What getServerContext would have checked for a person, and the hard floor's roles.
  const db = writableDb(base);
  const access = runAccess(actor, operation);
  const gates = await settleGates(db, base.companyId, actor, access, operation.method, built.path);
  if ('refusal' in gates) return errorResult(mode, startFacts, gates.refusal);
  const held = await heldRoleRefusal(db, base.companyId, operation, built.params);
  if (held) return errorResult(mode, startFacts, held);

  // 4. The handler's context, from the actor only. The closing-date password is checked here, once.
  const closing = await closingPasswordCheck(db, base.companyId, actor, access, mode);
  if ('refusal' in closing) return errorResult(mode, startFacts, closing.refusal);
  const parts: RunContextParts = {
    companyId: base.companyId,
    access,
    // Never the owner: the agent is not the person who owns the company.
    role: actor.role === 'owner' ? legacyRoleFor(access, false) : actor.role,
    closingDateOverride: closing.override,
    actor,
  };

  // 5. The request.
  const owner: FileOwner = { companyId: base.companyId, agentId: actor.agent.id };
  // A file of a reveal whose time is up goes nowhere, approved or not (revealFileEnded).
  for (const fileId of fileRefIds(runInput.body)) {
    if (await revealFileEnded(db, base.companyId, actor.agent.id, fileId)) return refuse(REVEAL_FILE_ENDED, 'FILE_NOT_FOUND', { fileId });
  }
  const extras: RequestExtras = { expectedVersion: version.value, hostPass: approvedAtHost(actor) ? expectedLaunchPass() : null };
  let request: BuiltRequest;
  try {
    request = await buildRequest(operation, built.path, runInput, owner, mode === 'read' ? {} : secretHeaders, extras);
  } catch (err) {
    if (err instanceof BridgeRefusal) return refuse(err.message, err.code, err.details);
    throw err;
  }
  const scopeOf = (r: BuiltRequest): ServiceScopeOptions => ({
    path: built.path,
    method: operation.method,
    headers: r.scopeHeaders,
    ...(closing.checked ? { closingPasswordChecked: true } : {}),
  });
  const scope = scopeOf(request);
  const sentFlags = Array.isArray(asked.confirm) ? asked.confirm : [];

  // A dry run of what cannot be rolled back is described, not run. (A read is simply read.) So is a
  // read the agent may see only once approved, whatever its dryRun says: its answer is the point.
  const answerFirst = !isRead && readsByMethod(operation);
  if (!isRead && mode === 'dry_run' && (operation.dryRun !== 'transaction' || answerFirst)) {
    const effects: EffectPreview[] = operation.effects.map((kind) => ({ kind, summary: EFFECT_WORDS[kind], detail: { declared: true } }));
    const note = answerFirst ? NOT_TRIED.answer : operation.dryRun === 'preview' ? NOT_TRIED.preview : NOT_TRIED.none;
    return {
      ...blank(mode, factsOf(operation, asked, { closingDate: gates.closingDate })),
      preview: {
        ledger: null,
        records: [],
        effects,
        warnings: [],
        loss: null,
        routePreview: { ran: false, note },
        truncated: false,
      },
    };
  }

  // 6. Run.
  const handler = await loadRouteHandler(operation);
  const limit = isReportRoute(operation.route) ? BRIDGE_REPORT_TIME_LIMIT_MS : BRIDGE_TIME_LIMIT_MS;
  const facts = (answer: unknown, ledger: LedgerTotals | null) => factsFor(operation, asked, gates.closingDate, answer, ledger);
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
   * reported (effectsOfFailedRun) and nothing queued is ever released; a file inside them is pinned
   * to the real folder that was checked (checkAndPinFiles). `kept` says the work itself cannot be
   * undone (a dryRun 'none' commit), so the refusal says what did and did not happen.
   */
  const collectRun = (effectsMode: EffectsMode, ctx: ServiceContext, kept: boolean): Promise<EffectsRun<RawAnswer>> =>
    runWithEffects(effectsMode, async () => {
      const raw = await invoke(handler, request, built.params, ctx, scope, true);
      const refusal = await checkAndPinFiles(actor.folders);
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
    }, { pinFiles: true });

  // Kept saying which operation answered it: a whole copy of the company file (a backup, a portable
  // copy) is the person's only, which the agent may have saved but never read (files.ts).
  const stage = (file: Interpreted['file']) => (file ? stageAnswerFile(owner, file, operation.id) : Promise.resolve(null));

  /**
   * The warnings the agent's confirmation flags accept, in the route's own words (plan §5.6), for
   * the preview of a dry run sent with flags. The work is tried without them first, each try in a
   * savepoint of the dry run's transaction that is rolled back at once, its effects only captured
   * (nothing is sent, no file is looked at); each round adds back the flags the route asked for,
   * until it asks for none the agent sent. A try that fails some other way ends the search.
   */
  const withheldWarnings = async (tx: DB, d: Deadline): Promise<WarningPreview[]> => {
    const found: WarningPreview[] = [];
    let accepted: string[] = [];
    for (let round = 0; round < sentFlags.length && !d.expired; round++) {
      const tryInput = withoutFlags(runInput, sentFlags.filter((f) => !accepted.includes(f)), operation.body);
      const got: { raw: RawAnswer | null } = { raw: null };
      try {
        await (tx as unknown as { transaction<T>(fn: (sp: unknown) => Promise<T>): Promise<T> }).transaction(async (sp) => {
          const ctx = handlerContext(sp as DB, parts, false);
          const tried = await buildRequest(operation, built.path, tryInput, owner, secretHeaders, extras);
          got.raw = (await runWithEffects('capture', () => invoke(handler, tried, built.params, ctx, scopeOf(tried), false), { pinFiles: true })).value;
          // Undo the try: its savepoint is rolled back.
          throw new RolledBack(blank(mode, startFacts));
        });
      } catch (err) {
        if (!(err instanceof RolledBack)) return found;
      }
      if (!got.raw) break;
      const seen = interpret(got.raw, operation, actor, []);
      const asks = seen.outcome === 'needs_confirmation' ? seen.warnings.filter((w) => sentFlags.includes(w.flag) && !accepted.includes(w.flag)) : [];
      if (!asks.length) break;
      for (const w of asks) if (!found.some((f) => f.flag === w.flag)) found.push(w);
      accepted = [...accepted, ...asks.map((w) => w.flag)];
    }
    return found;
  };

  if (isRead) {
    return withDeadline(limit, async (d) => {
      try {
        const ctx = handlerContext(readOnlyDb(db), parts, true);
        // { pinFiles }: a file a read asks for is never looked at on the disk, and never saved.
        const run = await runWithEffects('capture', () => invoke(handler, request, built.params, ctx, scope, false), { pinFiles: true });
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
          preview:
            mode === 'read' ? null : { ledger: null, records: [], effects: shown.list, warnings: [...seen.warnings], loss: null, routePreview: null, truncated: shown.truncated },
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
      let withheld: WarningPreview[] = [];
      try {
        await db.transaction(async (txRaw) => {
          const ctx = handlerContext(txRaw as unknown as DB, parts, false);
          const before = await readBefore(ctx, base.companyId, asked, gates.timeZone);
          if (sentFlags.length) withheld = await withheldWarnings(txRaw as unknown as DB, d);
          if (d.expired) throw new TimedOut();
          const run = await collectRun('capture', ctx, false);
          if (d.expired) throw new TimedOut();
          await ctx.db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          const done = await collect(ctx, operation, access, run.effects, before, run.value.status, withheld);
          const seen = interpret(run.value, operation, actor, sentFlags);
          throw new RolledBack({
            ...blank(mode, facts(seen.answer, done.ledger)),
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
            preview: { ledger: null, records: [], effects: shown.list, warnings: [...withheld], loss: null, routePreview: { ran: false, note }, truncated: shown.truncated },
          };
        }
        return failed(err);
      }
      throw new Error('The dry run did not finish.');
    }, timeout);
  }

  // Commit of an operation whose service opens its own database handle: no wrapping transaction
  // (it could not be rolled back anyway), still inside the scope and the outbox, with a time limit
  // of its own (IRREVERSIBLE_COMMIT_TIME_LIMIT_MS). Work past it cannot be stopped or undone, so the
  // answer says it may still finish; whatever it queued (emails, files, print jobs) is then never
  // sent, since nobody is left to report how they went. Work that has not started when the limit
  // passes (still waiting to count the grant, on a PGlite lock say) never starts.
  if (operation.dryRun === 'none') {
    const seconds = Math.round(IRREVERSIBLE_COMMIT_TIME_LIMIT_MS / 1000);
    const stillRunning = () =>
      errorResult(mode, startFacts, {
        message:
          `This has taken longer than ${Math.round(seconds / 60)} minutes. It works outside the books, so Ironbooks cannot stop or undo it ` +
          'part way: it may still finish. Check whether it was done before asking again. Emails, files and print jobs it asked for will not be sent.',
        code: 'TIMEOUT',
        details: { seconds, mayStillFinish: true },
      });
    return withDeadline(IRREVERSIBLE_COMMIT_TIME_LIMIT_MS, async (d) => {
      let run: EffectsRun<RawAnswer> | null = null;
      try {
        if (actor.approval?.grantId) {
          const grantId = actor.approval.grantId;
          // Counted first, in its own transaction: a failed run then uses it up, never the other way.
          await db.transaction(async (txRaw) => countGrantUse(handlerContext(txRaw as unknown as DB, parts, false), grantId));
        }
        // The answer has already gone out ("may still finish"): what cannot be undone must not
        // start after it.
        if (d.expired) return stillRunning();
        run = await collectRun('defer', handlerContext(db, parts, false), true);
        if (d.expired) {
          run.discard();
          return stillRunning();
        }
        // From here on the time limit no longer answers: this answer is the one that counts.
        d.finishing = true;
        const seen = interpret(run.value, operation, actor, sentFlags);
        const file = await stage(seen.file);
        const shown = capped(run.effects);
        const effects = await recordFailedEffects(db, parts, await run.release());
        return {
          ...blank(mode, facts(seen.answer, null)),
          httpStatus: run.value.status,
          outcome: seen.outcome,
          result: seen.result,
          file,
          preview: { ledger: null, records: [], effects: shown.list, warnings: [...seen.warnings], loss: null, routePreview: null, truncated: shown.truncated },
          warnings: seen.warnings,
          error: seen.error,
          effects,
          produced: seen.produced,
        };
      } catch (err) {
        run?.discard();
        return failed(err, effectsOfFailedRun(err)?.ran ?? []);
      }
    }, stillRunning);
  }

  return withDeadline(limit, async (d) => {
    try {
      const kept = await db.transaction(async (txRaw) => {
        const ctx = handlerContext(txRaw as unknown as DB, parts, false);
        if (actor.approval?.grantId) await countGrantUse(ctx, actor.approval.grantId);
        const before = await readBefore(ctx, base.companyId, asked, gates.timeZone);
        const run = await collectRun('defer', ctx, false);
        try {
          if (d.expired) throw new TimedOut();
          await ctx.db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
          const done = await collect(ctx, operation, access, run.effects, before, run.value.status);
          const seen = interpret(run.value, operation, actor, sentFlags);
          if (seen.outcome !== 'ok') {
            // A success answer that cannot be read: nothing is kept, so the agent never retries
            // work that was in fact saved.
            throw new BridgeRefusal(`${seen.error?.message ?? 'The answer could not be read.'} Nothing was saved.`, seen.error?.code ?? 'INTERNAL', null, run.value.status);
          }
          const file = await stage(seen.file);
          const result: BridgeResult = {
            ...blank(mode, facts(seen.answer, done.ledger)),
            httpStatus: run.value.status,
            outcome: seen.outcome,
            result: seen.result,
            file,
            preview: done.preview,
            stalenessKey: done.stalenessKey,
            produced: seen.produced,
          };
          // What it did is still what it was judged on (RunOptions.commitCheck): else nothing is kept.
          const stale = opts.commitCheck?.(result) ?? null;
          if (stale) throw new BridgeRefusal(stale, 'CONFLICT', null, run.value.status);
          if (d.expired) throw new TimedOut();
          d.finishing = true;
          return { run, result };
        } catch (err) {
          run.discard();
          throw err;
        }
      });
      // Committed: only now does anything leave the database. What failed is recorded.
      return { ...kept.result, effects: await recordFailedEffects(db, parts, await kept.run.release()) };
    } catch (err) {
      // Calls to other computers a failed run had already made did happen: say so.
      return failed(err, effectsOfFailedRun(err)?.ran ?? []);
    }
  }, timeout);
}) satisfies RunOperation;
