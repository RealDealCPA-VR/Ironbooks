/**
 * Agent full access: permission requests, what an agent asked a person to approve (plan §4.3,
 * §4.5, §7.2, §7.4; contract section 8).
 *
 * Two sides, and they never mix:
 *
 *  - THE AGENT (ctx.agent set) puts a request (createAgentRequest), reads its own requests, waits
 *    for an answer and may withdraw one that is still waiting. It only ever sees its own requests,
 *    masked, and it can never approve, deny or list anything for a person.
 *  - A PERSON (ctx.userId set, no ctx.agent, never inside an agent's service scope) lists the
 *    requests, approves or denies them. Every view says whether THIS person may approve and, if
 *    not, why in plain words. Anything that is not a person is refused with FORBIDDEN, always.
 *
 * Who may approve (plan §4.5): their own access allows the operation's route, an Admin when the
 * request needs one, the file Admin when the route needs that, every role flag the request needs
 * (closed period, full SSNs, full account numbers), the host computer's own window for host-only
 * work, and a request that is still waiting. Two different people when the amount is above the
 * agent's two-person limit (D8). At the second approval the first approver is judged again by the
 * same rules, read from the company file now (firstApprovalLapsed): one who has been deactivated,
 * removed, made view-only or has lost the right, the Admin role or a flag no longer counts, and the
 * request waits for two people again. Batch approval adds up each agent's chosen requests and
 * approves none together when the total passes the agent's two-person amount
 * (refuseTogetherOverTwoPerson). The run itself is lib/agent/operate.ts runApproved, as the
 * approver, within the agent's role.
 *
 * Secrets (plan §5.8): what the approver types on the card goes to runApproved and nowhere else,
 * never to a row, the audit trail or an error. What a run produces (a temporary password) goes
 * back to the approving person's screen only. A request never stores a secret the agent put in
 * its input: guardInput strips them, and a second pass here drops any field named like one.
 *
 * Protected data the agent supplied (a vendor's tax ID, an account number, a payroll memo) is kept
 * in the row only while the request can still run, because the approved run must enter what the
 * agent asked for (runApproved enters the stored input; a masked tax ID would be entered as
 * "***-**-6789"). It is masked in every view, and masked in the row itself once the request is
 * settled (done, failed, denied, expired or withdrawn).
 *
 * What an approved run answered is stored as the agent reads it. The answer of an approved reveal
 * (D6, plan §5.9) holds the full values: the agent may read it again (its wait, its list, a replay
 * of the same request id) for REVEAL_KEPT_MINUTES after the run, and from then on it is masked, in
 * every view at once and in the row itself by the settle step, for good (like any other protected
 * value a settled request kept); a file it answered with is removed from the agent's staged files
 * then too, so get_file no longer hands it over. The settle step runs on a timer at the end of the
 * time (endRevealOnTime) and on every read. When Ironbooks stops before the time is up, the staged
 * files go as the company file closes, but the row keeps the full answer until the first read once
 * the file is open again (at the latest the title bar's poll, once someone is signed in), and
 * a backup made meanwhile holds it as it holds the records it came from. The audit trail words the
 * reveal: which kinds of values of which record or report, to which agent, approved by whom. A
 * person reads that answer only through their
 * own role: someone without the View flag the request needed sees a note in its place, and everyone
 * else sees it masked by their own flags (lib/permissions/mask.ts).
 *
 * The books may change between the ask and the approval (plan §7.4). The run then shows what would
 * happen now instead of doing it, and the request goes back to waiting with that new preview (a new
 * "stale round"). From then on it runs only for someone who was shown the preview it holds in a
 * "the books changed" answer and approves again with acceptStale, and only while the books are as
 * that preview showed them; a further change is another stale round. So nobody ever approves a
 * preview other than the one on their screen.
 *
 * The table has no columns for the request's kind, its facts or the standing permission asked for.
 * They are kept in `needs`, under the key `request` (RequestMeta below), and left out of every
 * view's `needs`.
 *
 * Where a line or the audit trail names the request's records again (a new preview's line, the
 * words of a reveal), it reads their names from the books as they are now, the way the door named
 * them when the agent asked (lib/agent/operate.ts requestNames): "Delete role Clerk", not a uuid,
 * and a role renamed since by its new name. Today that knows roles, people, agents and sign-ins
 * only; any other record is named by the request's summary, as before.
 *
 * The stored input keeps the version of the record the agent last read (OperationInput
 * .expectedUpdatedAt), and the approved run sends it, so a person's edit made since is refused by
 * the route, never overwritten. The summary is kept whole: it names every recipient.
 *
 * Requests copied from the old proposals (proposal_id set, operation "action:<name>") still run
 * the old way (runApprovedAgentAction in lib/agent/actions.ts, as Ask AI approves them) and settle
 * the ai_proposals row in the same step, so Ask AI and the approval center show one state.
 *
 * What a view carries besides the row (wave 3):
 *  - `stale`: the request is waiting in a stale round, so its preview is the new one and a yes must
 *    be given again on it;
 *  - `posted` and `entryIds`: what the committed run itself posted to the ledger, kept beside its
 *    answer when it is recorded (not guessed from the preview a person approved);
 *  - `grant` and `grantError`: the standing permission actually given with the approval, or why
 *    none was given when the approver asked for some (the run itself still counts as done);
 *  - for a person: whether THIS window may approve it (`atHost`: a teammate's window never may
 *    approve host-only work), a desktop flow's questions, and the standing window grantWindowReader
 *    (lib/services/agentGrants.ts) allows, so the card never offers one createGrant then refuses.
 *
 * A desktop (shell) run that fails ends the request for good: it never goes back to waiting and is
 * never run again under the same id (the shell itself refuses an id it has seen).
 */
import { EventEmitter } from 'node:events';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DB } from '@/lib/db';
import { agentPermissionRequests, agents, aiProposals, auditLogs, companies, userCompanies, users } from '@/lib/db/schema';
import { isReadOnlyDb } from '@/lib/db/readOnly';
import { inServiceScope } from '@/lib/context';
import {
  ASKS_PER_HOUR_BEFORE_PAUSE,
  PREVIEW_ROW_LIMIT,
  WAIT_MAX_SECONDS,
  type AgentRequestForPerson,
  type AgentRequestKind,
  type AgentRequestView,
  type ApproveAgentRequest,
  type ApproveInput,
  type ApproveResult,
  type BadgeForPerson,
  type BatchApprove,
  type BridgeResult,
  type CancelAgentRequest,
  type CreateAgentRequest,
  type DenyAgentRequest,
  type ExpireRequests,
  type FlowQuestion,
  type ListRequestsForAgent,
  type ListRequestsForPerson,
  type NewAgentRequest,
  type OperationInput,
  type OperationPreview,
  type PendingCountForPerson,
  type ProducedSecret,
  type RequestForAgent,
  type RequestForPerson,
  type StagedFile,
  type WaitForDecision,
} from '@/lib/agent/contract';
import {
  ADMIN_APPROVAL_CLASSES,
  GRANTABLE,
  REQUEST_STATUSES,
  RISK_CLASS_LABELS,
  isRiskClass,
  type ApprovalNeeds,
  type GrantConstraints,
  type Operation,
  type RequestFacts,
  type RequestStatus,
  type RiskClass,
  type SecretKind,
} from '@/lib/agent/operations/types';
import { operationById, operationForRoute } from '@/lib/agent/operations/registry';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import {
  DEFAULT_REQUEST_EXPIRY_DAYS,
  NO_RULE_FOR_APPROVER,
  SHORT_GRANT_MINUTES,
  approvalNeeds,
  batchPassesTwoPerson,
  classRank,
  effectiveClass as effectiveClassOf,
  roleProblem,
  routeWithoutRule,
} from '@/lib/agent/policy';
import { removeStagedFile } from '@/lib/agent/files';
import { guardInput, maskAccountsInText, maskSensitiveFields, plainIsoTime } from '@/lib/agent/guards';
import { describeRequest } from '@/lib/agent/describe';
import { requestNames, runApproved } from '@/lib/agent/operate';
import { LIST_ROUTES, namedRecords, type ListKind } from '@/lib/agent/namedRecords';
import { OPTIONAL_ROUTE_SECRETS } from '@/lib/agent/bridge';
import { agentAction, agentInputHash, changesInTransaction, runApprovedAgentAction, type AnyAction } from '@/lib/agent/actions';
// The old proposals' actions run through the catalog, which registers itself when loaded (as
// lib/services/aiAssistant.ts does for Ask AI's approvals).
import '@/lib/agent/catalog';
import { FLAGS, legacyRoleFor, type Area, type EffectiveAccess, type Flag } from '@/lib/permissions/model';
import { maskAccountNumber, maskSensitive, maskSsn, stripSecrets } from '@/lib/permissions/mask';
import { authorizeRequest } from '@/lib/permissions/enforce';
import { BATCH_APPROVE_MAX } from '@/lib/validation/agentAccess';
import { Money, formatCurrency } from '@/lib/money';
import { loadAgentPolicy } from './agentPolicies';
import { createGrant, grantWindowReader, type GrantWindow } from './agentGrants';
import { requireFileAdmin, resolveAccess } from './access';
import { sendMail } from './email';
import { listActiveSessions } from './sessions';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';

type Row = typeof agentPermissionRequests.$inferSelect;
type Status = RequestStatus;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The agent's request id, as lib/agent/actions.ts takes it. */
const REQUEST_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{2,119}$/;

/** Longest reason an agent may give, and longest note a person may leave it (plan §4.3). */
export const REASON_MAX = 500;
export const NOTE_MAX = 500;
/**
 * Longest summary kept. Never a cut: the line (lib/agent/describe.ts describeRequest) keeps under
 * 200 characters by cutting values, but never hides a recipient, a path or a server name, so a
 * schedule emailed to many people makes a longer line, and every recipient must reach the card. So
 * this is far above any line a request a person can review would make; a longer one is refused when
 * the agent asks (split the work), and a new preview's line that long keeps the earlier summary.
 */
const SUMMARY_MAX = 64 * 1024;
/**
 * The names a request keeps of its records (RequestMeta.names): how many, and how long an id or a
 * name may be.
 */
const NAMES_MAX = 50;
const NAME_MAX = 200;
const NAME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:{}\-]{0,119}$/;
/** Largest input a request keeps, as JSON text. */
const INPUT_MAX_CHARS = 512 * 1024;
/** How often a waiting agent's request is read again, besides being woken. */
const WAIT_RECHECK_MS = 2_000;
/** At most one email notice per agent this often (D7): a busy agent must not flood the Admins. */
const NOTICE_EVERY_MS = 10 * 60_000;
/**
 * How long a request may stay "being carried out". The longest run (a desktop flow that copies a
 * whole company file) gives up after 35 minutes, so a request still marked approved well after that
 * was cut off by Ironbooks stopping between the claim and the record of how it ended.
 */
const STUCK_AFTER_MS = 2 * 60 * 60_000;
/**
 * How long after an approved reveal's run the agent may read its full values again (D6): long
 * enough for an agent that waited, or asked again with the same request id, to get the answer it
 * was approved for; after that the stored answer is masked for good.
 */
export const REVEAL_KEPT_MINUTES = 15;
const REVEAL_KEPT_MS = REVEAL_KEPT_MINUTES * 60_000;
/** How long after a reveal's time is up its timer ends it (endRevealOnTime): past the end, never before. */
const REVEAL_TIMER_SLACK_MS = 1_000;

/** Settled for good: nothing more can happen to the request. */
const SETTLED: readonly Status[] = ['denied', 'expired', 'cancelled', 'failed', 'executed'];

// ---------------------------------------------------------------------------
// Messages (plain words, no blame, what to do next)
// ---------------------------------------------------------------------------

const AGENT_ONLY_MESSAGE = 'This is for agents.';
const PERSON_ONLY_MESSAGE =
  'Only a person signed in to Ironbooks can see, approve or deny what agents ask for. An agent can never do this.';
const NOT_A_MEMBER_MESSAGE = 'You do not have access to this company.';
const IN_SCOPE_MESSAGE = "An agent's request cannot be put while another agent request is being carried out.";
const PAUSED_MESSAGE =
  'This agent is paused, so it cannot ask for anything right now. Ask a person to turn it back on in Users & Roles > Agents, then try again.';
const TOO_MANY_MESSAGE =
  `This agent asked for approval more than ${ASKS_PER_HOUR_BEFORE_PAUSE} times in the last hour, so Ironbooks paused it to keep people ` +
  'from being flooded with requests. Nothing more will run until a person turns it back on in Users & Roles > Agents. ' +
  'When it is back on, put related work into fewer requests.';
const REMOVED_AGENT_MESSAGE = 'This agent has been removed, so it cannot ask for anything.';
const NOT_FOUND_MESSAGE = 'That request was not found. List the requests to see what is there.';
const CHANGED_JUST_NOW_MESSAGE = 'Someone decided this request just now. Open it again to see where it stands.';
const VIEW_ONLY_APPROVE_MESSAGE =
  'Your role can only look at the books, so you cannot approve agent requests. Someone whose role can make changes can approve it.';
const VIEW_ONLY_DENY_MESSAGE =
  'Your role can only look at the books, so you cannot deny agent requests. Someone whose role can make changes can deny it.';
const UNKNOWN_OUTCOME_MESSAGE =
  'Ironbooks stopped while this was being carried out, so it cannot tell how it ended. Check the books to see whether it was done before asking the agent to send it again.';
const BOOKS_CHANGED_FAILED = 'The books changed since the agent asked, and this would no longer go through, so nothing was done.';

const STATUS_WHY: Record<Status, string> = {
  pending: '',
  approved: 'This request is being carried out right now.',
  denied: 'This request was denied.',
  expired: 'This request has expired. The agent can ask again if it still needs this.',
  cancelled: 'The agent withdrew this request.',
  failed: 'This request was approved, but the work could not be done.',
  executed: 'This request was approved and done.',
};

/**
 * Every secret an approver may type on a card, in the words the agent is told them
 * (lib/agent/operate.ts SECRET_WORDS). A Record, so that a kind added to
 * lib/agent/operations/types.ts fails to compile here until it is listed (types.ts has no list).
 */
const SECRET_WORDS: Record<SecretKind, string> = {
  closing_password: 'the closing-date password',
  file_password: "the company file's password",
  backup_password: "the backup file's password",
  archive_credentials: "the protected archive's password",
  new_user_password: 'the new password',
  mail_password: 'the mail server password',
  portal_password: 'the portal password',
  recovery_key: 'the recovery key',
  file_key: 'the file key',
  capability_link: 'the sharing link',
};
const SECRET_KINDS = Object.keys(SECRET_WORDS) as SecretKind[];

function flagLabel(flag: Flag): string {
  return FLAGS.find((f) => f.key === flag)?.label ?? flag;
}

function forbidden(message: string, details?: Record<string, unknown>): ServiceError {
  return new ServiceError('FORBIDDEN', message, details);
}

// ---------------------------------------------------------------------------
// Waking waiters: one emitter for the whole process
// ---------------------------------------------------------------------------

/** What changed: listeners read the request again (nothing secret travels here). */
export interface RequestChange {
  id: string;
  companyId: string;
  agentId: string;
  status: Status;
}

/**
 * Kept on globalThis under a registered symbol, like the service scope (lib/context.ts): Next can
 * load this module more than once in one process, and a waiter in one copy must still hear a
 * decision made through another.
 */
const EVENTS_KEY = Symbol.for('ironbooks.agent.requestEvents');

function requestEvents(): EventEmitter {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const existing = g[EVENTS_KEY];
  if (existing instanceof EventEmitter) return existing;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // one listener per waiting agent request
  Object.defineProperty(g, EVENTS_KEY, { value: emitter, enumerable: false, writable: false, configurable: false });
  return emitter;
}

function wake(row: Pick<Row, 'id' | 'companyId' | 'agentId' | 'status'>): void {
  const change: RequestChange = { id: row.id, companyId: row.companyId, agentId: row.agentId, status: row.status as Status };
  try {
    requestEvents().emit('change', change);
  } catch {
    /* a listener's problem never fails the request */
  }
}

/**
 * Hear every change to any request (made, decided, withdrawn, expired). For the desktop notice
 * and the badge. Returns the function that stops listening.
 */
export function onRequestChange(listener: (change: RequestChange) => void): () => void {
  const events = requestEvents();
  events.on('change', listener);
  return () => events.off('change', listener);
}

// ---------------------------------------------------------------------------
// Text, secrets and masking
// ---------------------------------------------------------------------------

/**
 * Code points that hide or reorder text: control characters other than line breaks and tabs,
 * zero-width marks, bidi embeddings, overrides and isolates, the byte-order mark. Written as
 * numbers on purpose: the characters themselves must never appear in source ("Trojan Source").
 */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

function isHidden(ch: string): boolean {
  const n = ch.codePointAt(0) ?? 0;
  return HIDDEN_RANGES.some(([from, to]) => n >= from && n <= to);
}

/** Text as a person reads it: no characters that hide or reverse what follows. */
function visibleText(v: string): string {
  let out = '';
  for (const ch of v.replace(/\r\n?/g, '\n')) if (!isHidden(ch)) out += ch;
  return out;
}

function oneLine(v: string): string {
  return visibleText(v).replace(/\s+/g, ' ').trim();
}

function cleanReason(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw validation('The reason must be text.');
  const s = visibleText(v).trim();
  if (!s) return null;
  if (s.length > REASON_MAX) {
    throw validation(`The reason is longer than ${REASON_MAX} characters. Say it in fewer words and send the request again.`);
  }
  return s;
}

function cleanNote(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw validation('The note must be text.');
  const s = visibleText(v).trim();
  if (!s) return null;
  if (s.length > NOTE_MAX) throw validation(`The note can be at most ${NOTE_MAX} characters. Shorten it and try again.`);
  return s;
}

/**
 * Field names that hold a secret. Compared without case, spaces, dashes or underscores. A field
 * whose name contains "password", "passphrase" or "passcode", or ends in "secret", counts too; a
 * yes/no such as "mustChangePassword" does not (only text and numbers are secrets).
 */
const SECRET_FIELD_NAMES = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'bearertoken',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
  'recoverykey',
  'filekey',
  'totp',
  'otp',
  'pin',
  'authorization',
]);

function isSecretField(key: string, value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_FIELD_NAMES.has(k) || k.includes('password') || k.includes('passphrase') || k.includes('passcode') || k.endsWith('secret');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A plain JSON copy (no undefined, no class instances, nothing shared with the caller). */
function jsonCopy<T>(v: T): T {
  if (v === undefined) return null as T;
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Every field named like a secret removed, at any depth. */
function withoutSecretFields(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSecretFields);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (isSecretField(k, val)) continue;
      out[k] = withoutSecretFields(val);
    }
    return out;
  }
  return v;
}

const SSN_FIELDS = new Set(['ssn', 'employeessn', 'taxid']);
const ACCOUNT_FIELDS = new Set(['accountnumber', 'routingnumber', 'bankaccountnumber']);
const MASKED = '•••';
const DROP = Symbol('drop');

function maskedLeaf(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (isSecretField(key, value)) return DROP;
  const k = key.toLowerCase();
  if (SSN_FIELDS.has(k)) return maskSsn(value) ?? MASKED;
  if (ACCOUNT_FIELDS.has(k)) return maskAccountNumber(value) ?? MASKED;
  return MASKED;
}

/** Mask the field at a dotted path ("*" for any key or position) in place. */
function maskPath(node: unknown, segs: string[]): void {
  if (!segs.length || node === null || typeof node !== 'object') return;
  const [seg, ...rest] = segs;
  const keys: string[] =
    seg === '*' ? (Array.isArray(node) ? node.map((_, i) => String(i)) : Object.keys(node as object)) : [seg];
  for (const key of keys) {
    const holder = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(holder, key)) continue;
    if (rest.length) {
      maskPath(holder[key], rest);
      continue;
    }
    const masked = maskedLeaf(Array.isArray(node) ? seg : key, holder[key]);
    if (masked === DROP) {
      if (Array.isArray(node)) holder[key] = MASKED;
      else delete holder[key];
    } else holder[key] = masked;
  }
}

const NO_FLAGS: Pick<EffectiveAccess, 'flags'> = { flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false } };

/** An input as anyone may see it: secrets gone, the operation's sensitive fields and every SSN or account number masked. */
function maskedInput(input: OperationInput | null, sensitiveFields: readonly string[]): OperationInput | null {
  if (!input) return null;
  const copy = withoutSecretFields(jsonCopy(input)) as OperationInput;
  if (copy.body !== undefined && copy.body !== null) {
    for (const path of sensitiveFields) if (typeof path === 'string' && path) maskPath(copy.body, path.split('.'));
    copy.body = maskSensitive(copy.body, NO_FLAGS);
  }
  if (copy.query) copy.query = maskSensitive(copy.query, NO_FLAGS);
  return stripSecrets(copy);
}

/**
 * Whether any secret the approver typed (or a run produced) appears anywhere in the value: its
 * text, its keys, nested. A secret is never cut out of the place it appears: the agent wrote much
 * of what a route answers (memos, names, descriptions), so a masked spot would tell it which of
 * its own guesses was the password (security review, wave 5c F8). The whole value is withheld.
 */
function holdsSecret(v: unknown, secrets: readonly string[]): boolean {
  const live = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  if (!live.length) return false;
  const seen = (t: string) => live.some((s) => t.includes(s));
  const walk = (x: unknown, depth: number): boolean => {
    if (depth > 64) return true;
    if (typeof x === 'string') return seen(x);
    if (typeof x === 'number' || typeof x === 'bigint') return seen(String(x));
    if (Array.isArray(x)) return x.some((y) => walk(y, depth + 1));
    if (isPlainObject(x)) return Object.entries(x).some(([k, y]) => seen(k) || walk(y, depth + 1));
    return false;
  };
  return walk(v, 0);
}

/** Text with no secret the approver typed (or a run produced) in it: the text, or the fallback. */
function scrubText(text: string, secrets: readonly string[], fallback: string): string {
  return holdsSecret(text, secrets) ? fallback : text;
}

/** What is kept of an answer that repeated a secret: a note, never the answer with the spot masked. */
const SECRET_WITHHELD_NOTE =
  'Ironbooks withheld this answer because it repeated a password typed on the card. The work itself ended as the status says.';

function scrubDeep(v: unknown, secrets: readonly string[]): unknown {
  return holdsSecret(v, secrets) ? { withheld: SECRET_WITHHELD_NOTE } : v;
}

/** A failure message that repeated a typed secret: said plainly, without the message. */
const SECRET_IN_MESSAGE =
  'Ironbooks could not finish this work. Its message is not shown because it repeated a password typed on the card.';

/** Every value typed on the card for this approval: the secrets, and a desktop flow's password answers. */
function typedOnCard(input: { secrets: Partial<Record<string, string>>; answers?: Record<string, unknown> }, shellDef: { questions?: readonly { id: string; kind?: string }[] } | null): string[] {
  const passwordQuestions = new Set((shellDef?.questions ?? []).filter((q) => q.kind === 'password').map((q) => q.id));
  return [
    ...Object.values(input.secrets),
    ...Object.entries(input.answers ?? {})
      .filter(([k, v]) => isSecretField(k, v) || (passwordQuestions.has(k) && (typeof v === 'string' || typeof v === 'number')))
      .map(([, v]) => String(v)),
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** Shortest typed value looked for in the agent's own words: shorter ones would match almost any text. */
const AGENT_TEXT_SECRET_MIN = 4;

/**
 * Refuse an approval whose typed password already appears in what the agent wrote (its input, its
 * reason, the line it asked for). An agent that writes candidate passwords into a memo or a name
 * and waits for the approver to type the real one is guessing it. Nothing is claimed or run, the
 * request stays waiting (the agent learns nothing new), and only the approver is told.
 */
function refuseSecretInAgentText(row: Row, typed: readonly string[]): void {
  const long = typed.filter((s) => s.length >= AGENT_TEXT_SECRET_MIN);
  if (!long.length) return;
  if (!holdsSecret([row.input, row.reason, row.summary], long)) return;
  throw validation(
    'What the agent sent already contains the password you typed. An agent that writes passwords into its own request may be trying to find one out. Nothing was done: deny this request, and pause the agent while you check what it was reading.',
  );
}

const UNEXPECTED_MESSAGE =
  'Ironbooks could not finish this work because of an unexpected problem. Check the books, then ask the agent to send the request again if it is still needed.';
/**
 * The work was done, but the standing permission asked for with it was not given for a reason
 * nobody can name. Never UNEXPECTED_MESSAGE: following that ("send the request again") would enter
 * the work twice.
 */
const GRANT_NOT_GIVEN_MESSAGE =
  'Standing permission was not given because of an unexpected problem. The work itself was done, so do not ask for it again; the next request like it will ask a person.';
/**
 * A request FOR standing permission that could not be given for a reason nobody can name. Nothing
 * else was asked, so nothing in the books changed: never UNEXPECTED_MESSAGE, which tells the person
 * to check the books for work that may have been done.
 */
const GRANT_REQUEST_NOT_GIVEN_MESSAGE =
  'Standing permission was not given because of an unexpected problem, so nothing changed. The agent can ask for it again.';
/**
 * The approval claimed the request and then stopped on something unexpected after its run had
 * ended (its answer could not be kept, say): the work may or may not have been done.
 */
const LOST_TRACK_MESSAGE =
  'Something unexpected went wrong while this was being carried out, so Ironbooks cannot tell whether it was done. Check the books before asking the agent to send it again.';

function messageOf(err: unknown): string {
  if (err instanceof ServiceError && err.message) return err.message;
  return UNEXPECTED_MESSAGE;
}

// ---------------------------------------------------------------------------
// What the table keeps beside the needs
// ---------------------------------------------------------------------------

interface RequestMeta {
  kind: AgentRequestKind;
  facts: RequestFacts;
  grantAsked: { constraints: GrantConstraints; minutes: number } | null;
  /** sha256 of the operation, kind, masked input and grant asked: the same request asked again. */
  inputHash: string;
  area: Area | null;
  /** The stored input is masked (the request is settled). */
  scrubbed: boolean;
  /**
   * How many times the books changed under the request and it went back to waiting with a new
   * preview (plan §7.4). 0: the preview is still the one the agent asked with.
   */
  staleRound: number;
  /**
   * The people who were shown this round's preview in a "the books changed" answer. Only they may
   * approve it with acceptStale; a new round starts the list again.
   */
  staleSeen: string[];
  /**
   * The name a person knows each of the request's records by, by id (lib/agent/describe.ts
   * DescribeNames), as the asker read them when the agent asked, only when the asker passes them
   * (`names` beside the request). NewAgentRequest has no field for them and the door does not pass
   * them today, so a request made by the door keeps none. Only a fallback: the line of a new preview
   * and the words of a reveal read the names as they are now (namesNow) and use these only for a
   * record that read finds no name for (say, one deleted since). Never in a view: needs.request is
   * left out of every view's needs.
   */
  names?: Record<string, string>;
}

type StoredNeeds = ApprovalNeeds & { request?: RequestMeta };

const EMPTY_FACTS: RequestFacts = {
  confirm: [],
  reveal: false,
  amount: null,
  count: null,
  entityIds: [],
  accountIds: [],
  date: null,
  closedPeriod: false,
};

function cleanFacts(raw: unknown): RequestFacts {
  const f = isPlainObject(raw) ? raw : {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const count = f.count;
  return {
    confirm: strings(f.confirm),
    reveal: f.reveal === true,
    amount: typeof f.amount === 'string' && f.amount.trim() ? f.amount.trim() : typeof f.amount === 'number' && Number.isFinite(f.amount) ? String(f.amount) : null,
    count: typeof count === 'number' && Number.isFinite(count) ? count : null,
    entityIds: strings(f.entityIds),
    accountIds: strings(f.accountIds),
    date: typeof f.date === 'string' ? f.date : null,
    closedPeriod: f.closedPeriod === true,
  };
}

/**
 * Names of a request's records (RequestMeta.names, or as read now by namesNow), kept only as text a
 * card can show: an id as the app writes one, and a name on one line, each at most NAME_MAX
 * characters, at most NAMES_MAX of them. Undefined when there are none.
 */
function cleanNames(raw: unknown): Record<string, string> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: Record<string, string> = {};
  let kept = 0;
  for (const [id, name] of Object.entries(raw)) {
    if (kept >= NAMES_MAX) break;
    if (!NAME_ID_RE.test(id) || typeof name !== 'string') continue;
    const shown = oneLine(name).slice(0, NAME_MAX);
    if (!shown) continue;
    out[id] = shown;
    kept++;
  }
  return kept ? out : undefined;
}

function cleanGrantAsked(raw: unknown): RequestMeta['grantAsked'] {
  if (!isPlainObject(raw)) return null;
  const minutes = raw.minutes;
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1) return null;
  const constraints = isPlainObject(raw.constraints) ? (jsonCopy(raw.constraints) as GrantConstraints) : {};
  return { constraints, minutes };
}

const FLAG_KEYS: readonly Flag[] = ['closedPeriod', 'sensitivePayroll', 'fullAccountNumbers'];
type ApproverFlag = NonNullable<ApprovalNeeds['flag']>;
const GRANTABLE_ORDER = ['yes', 'capped', 'short', 'no'] as const;
type Grantable = ApprovalNeeds['grantable'];

function isApproverFlag(v: unknown): v is ApproverFlag {
  return typeof v === 'string' && (FLAG_KEYS as readonly string[]).includes(v);
}

/**
 * Needs read fail-closed: anything that is not plainly "no" counts as "yes", an unknown grant
 * setting as "no standing permission".
 */
function isSecretKind(v: unknown): v is SecretKind {
  return typeof v === 'string' && (SECRET_KINDS as string[]).includes(v);
}

function normalNeeds(raw: unknown): ApprovalNeeds {
  const n = isPlainObject(raw) ? raw : {};
  const flags: ApproverFlag[] = [];
  for (const f of [...(Array.isArray(n.flags) ? n.flags : []), n.flag]) if (isApproverFlag(f) && !flags.includes(f)) flags.push(f);
  const secrets = [...new Set((Array.isArray(n.secrets) ? n.secrets : []).filter(isSecretKind))];
  const grantable = (GRANTABLE_ORDER as readonly string[]).includes(n.grantable as string) ? (n.grantable as Grantable) : 'no';
  return {
    admin: n.admin !== false,
    fileAdmin: n.fileAdmin !== false,
    hostOnly: n.hostOnly !== false,
    flag: flags[0] ?? null,
    flags,
    grantAdminOnly: n.grantAdminOnly !== false,
    secrets,
    // Kept only when the needs say it (wave 4), and only of the secrets they list: a needs that
    // does not say which secrets may be left empty is read by the rule of its operation
    // (optionalSecretsOf), never as "every secret is optional".
    ...(Array.isArray(n.optionalSecrets) ? { optionalSecrets: secrets.filter((k) => (n.optionalSecrets as unknown[]).includes(k)) } : {}),
    twoPerson: n.twoPerson !== false,
    grantable,
  };
}

/**
 * What one needs says of a secret: nothing (it does not list the secret, or does not say which are
 * optional), that the route goes ahead without it, or that it is required.
 */
function secretSaid(n: ApprovalNeeds, kind: SecretKind): 'optional' | 'required' | null {
  if (!n.secrets.includes(kind) || !Array.isArray(n.optionalSecrets)) return null;
  return n.optionalSecrets.includes(kind) ? 'optional' : 'required';
}

/** The stricter of two needs, field by field. A secret stays optional only when no side requires it. */
function mergeNeeds(a: ApprovalNeeds, b: ApprovalNeeds): ApprovalNeeds {
  const flags: ApproverFlag[] = [];
  for (const f of [...(a.flags ?? []), a.flag, ...(b.flags ?? []), b.flag]) if (isApproverFlag(f) && !flags.includes(f)) flags.push(f);
  const grantable = GRANTABLE_ORDER[Math.max(GRANTABLE_ORDER.indexOf(a.grantable), GRANTABLE_ORDER.indexOf(b.grantable))];
  const secrets = [...new Set([...a.secrets, ...b.secrets])];
  const said = Array.isArray(a.optionalSecrets) || Array.isArray(b.optionalSecrets);
  const optional = secrets.filter((k) => {
    const sides = [secretSaid(a, k), secretSaid(b, k)];
    return sides.includes('optional') && !sides.includes('required');
  });
  return {
    admin: a.admin || b.admin,
    fileAdmin: a.fileAdmin || b.fileAdmin,
    hostOnly: a.hostOnly || b.hostOnly,
    flag: flags[0] ?? null,
    flags,
    grantAdminOnly: Boolean(a.grantAdminOnly || b.grantAdminOnly),
    secrets,
    ...(said ? { optionalSecrets: optional } : {}),
    twoPerson: a.twoPerson || b.twoPerson,
    grantable: grantable ?? 'no',
  };
}

/** Needs of a request copied from an old proposal: the old approval asked for nothing more than the route's right. */
const PROPOSAL_NEEDS: ApprovalNeeds = {
  admin: false,
  fileAdmin: false,
  hostOnly: false,
  flag: null,
  flags: [],
  grantAdminOnly: false,
  secrets: [],
  twoPerson: false,
  grantable: 'no',
};

function metaOf(row: Row): RequestMeta {
  const raw = isPlainObject(row.needs) ? (row.needs as Record<string, unknown>).request : null;
  const m = isPlainObject(raw) ? raw : {};
  return {
    kind: m.kind === 'grant' ? 'grant' : 'operation',
    facts: cleanFacts(m.facts),
    grantAsked: cleanGrantAsked(m.grantAsked),
    inputHash: typeof m.inputHash === 'string' ? m.inputHash : '',
    area: typeof m.area === 'string' ? (m.area as Area) : null,
    // Rows this module did not write (copied proposals) count as kept as given.
    scrubbed: m.scrubbed === true,
    staleRound: typeof m.staleRound === 'number' && Number.isSafeInteger(m.staleRound) && m.staleRound > 0 ? m.staleRound : 0,
    staleSeen: Array.isArray(m.staleSeen) ? m.staleSeen.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)) : [],
    ...namesPart(cleanNames(m.names)),
  };
}

/** `{ names }` when there are any, else nothing (a row without them keeps none). */
function namesPart(names: Record<string, string> | undefined): Pick<RequestMeta, 'names'> {
  return names ? { names } : {};
}

/** What an approver must have, read fail-closed. */
function needsOf(row: Row): ApprovalNeeds {
  if (row.proposalId && row.needs === null) return PROPOSAL_NEEDS;
  return normalNeeds(row.needs);
}

/**
 * The needs as a view shows them (without the request's own bookkeeping), with the secrets the
 * approver may leave empty as this module judges them (optionalSecretsOf), so the card offers the
 * same boxes the approval then accepts.
 */
function viewNeeds(row: Row, target: Target): ApprovalNeeds | null {
  if (!isPlainObject(row.needs)) return null;
  const { optionalSecrets: said, ...needs } = needsOf(row);
  const optional = optionalSecretsOf(needs.secrets, said, target);
  return optional.length ? { ...needs, optionalSecrets: optional } : needs;
}

function classOf(row: Row): RiskClass {
  return isRiskClass(row.class) ? row.class : 'admin';
}

function stricterClass(a: RiskClass, b: RiskClass): RiskClass {
  return classRank(b) > classRank(a) ? b : a;
}

// ---------------------------------------------------------------------------
// What a request stands for
// ---------------------------------------------------------------------------

type Target =
  | { kind: 'operation'; op: Operation }
  | { kind: 'proposal'; action: AnyAction }
  | { kind: 'unknown' };

const ACTION_PREFIX = 'action:';

function targetOf(row: Pick<Row, 'operation' | 'proposalId'>): Target {
  return targetFor(row.operation, Boolean(row.proposalId));
}

/** What an operation id stands for; `copied`: the request was copied from an old proposal. */
function targetFor(operation: string, copied: boolean): Target {
  if (operation.startsWith(ACTION_PREFIX)) {
    const action = copied ? agentAction(operation.slice(ACTION_PREFIX.length)) : null;
    return action && action.kind === 'write' ? { kind: 'proposal', action } : { kind: 'unknown' };
  }
  try {
    const op = operationById(operation);
    return op ? { kind: 'operation', op } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * What an approver must have now: the stored needs, plus what the registry says of the operation
 * today (an operation reclassified since the agent asked is judged by the stricter of the two).
 */
function needsFor(row: Row, target: Target): ApprovalNeeds {
  const needs = needsOf(row);
  if (target.kind !== 'operation') return needs;
  const op = target.op;
  const own: RiskClass = op.classified && isRiskClass(op.class) ? op.class : 'admin';
  return {
    ...needs,
    admin: needs.admin || ADMIN_APPROVAL_CLASSES.includes(own),
    fileAdmin: needs.fileAdmin || op.fileAdmin === true,
    hostOnly: needs.hostOnly || op.hostOnly === true,
  };
}

/**
 * The write only succeeds on the version of the request this call read and judged: the same
 * staleness key and the same stale round. That is the row as read at the start of this call, not
 * the card on the person's screen; that the person saw the preview being run is settled by the
 * stale round rule in approveAgentRequest (staleSeen), and the run itself (runApproved) compares
 * the books with the staleness key stored here. A request that went back to waiting with a new
 * preview (and perhaps new needs) in between is not this call's to run.
 */
function sameVersion(row: Row) {
  const round = String(metaOf(row).staleRound);
  return and(
    row.stalenessKey === null ? isNull(agentPermissionRequests.stalenessKey) : eq(agentPermissionRequests.stalenessKey, row.stalenessKey),
    sql`coalesce(${agentPermissionRequests.needs} -> 'request' ->> 'staleRound', '0') = ${round}`,
  );
}

function sensitiveFieldsOf(target: Target): readonly string[] {
  return target.kind === 'operation' && Array.isArray(target.op.sensitiveFields) ? target.op.sensitiveFields : [];
}

/** The stored input (secrets never in it), or an empty one. */
function storedInput(row: Row): OperationInput {
  return isPlainObject(row.input) ? (jsonCopy(row.input) as OperationInput) : {};
}

/** The row's values once it is settled: its input masked for good. */
function settledInput(row: Row, target: Target): { input: OperationInput | null; needs: StoredNeeds | null } {
  const input = maskedInput(isPlainObject(row.input) ? (row.input as OperationInput) : null, sensitiveFieldsOf(target));
  if (!isPlainObject(row.needs)) return { input, needs: null };
  const stored = row.needs as StoredNeeds;
  return { input, needs: { ...stored, request: { ...metaOf(row), scrubbed: true } } };
}

/** The desktop flow behind a shell operation (lib/agent/operations/shell.ts), or null. */
function shellDefOf(target: Target) {
  if (target.kind !== 'operation' || target.op.kind !== 'shell') return null;
  return SHELL_OPERATIONS.find((d) => d.id === target.op.id) ?? null;
}

/** The questions the approver answers on the card for a desktop flow; none for anything else. */
function questionsOf(target: Target): FlowQuestion[] {
  const def = shellDefOf(target);
  return def ? (jsonCopy(def.questions) as FlowQuestion[]) : [];
}

/**
 * Which of a request's secrets the approver may leave empty (ApprovalNeeds.optionalSecrets, wave 4):
 *  - what the needs say, when they say it (`said`), and only of the secrets they list;
 *  - when they do not say (a request asked before wave 4, or a policy that does not tell): for a
 *    route, those its route goes ahead without (the bridge's own commit rule, lib/agent/bridge.ts
 *    OPTIONAL_ROUTE_SECRETS; every other one it takes always, and the bridge refuses a commit
 *    without it); for a desktop flow, those its flow uses
 *    only at the prompt it meets (a portable file saved with a password needs it,
 *    lib/agent/operations/shell.ts), so a yes without one is right for a file that has none. That is
 *    how such a flow was approved before wave 4.
 * Never, either way, a secret the desktop flow needs every time it runs (ShellOperationEntry
 * .alwaysNeedsSecret): a yes without it would be claimed, refused at its prompt and failed for good.
 */
function optionalSecretsOf(secrets: readonly SecretKind[], said: readonly SecretKind[] | undefined, target: Target): SecretKind[] {
  const def = shellDefOf(target);
  const always = new Set<SecretKind>((def?.alwaysNeedsSecret ?? []).filter(isSecretKind));
  if (Array.isArray(said)) return secrets.filter((k) => said.includes(k) && !always.has(k));
  if (!def) return target.kind === 'operation' ? secrets.filter((k) => OPTIONAL_ROUTE_SECRETS.includes(k)) : [];
  const flowSecrets = new Set<SecretKind>([...(def.needsSecret ?? []), ...flowPasswordSecrets(def.questions)]);
  return secrets.filter((k) => flowSecrets.has(k) && !always.has(k));
}

/** The secrets a desktop flow's password questions name (their answer goes with the secrets). */
function flowPasswordSecrets(questions: readonly FlowQuestion[]): SecretKind[] {
  return questions.filter((q) => q.kind === 'password' && isSecretKind(q.secret)).map((q) => q.secret as SecretKind);
}

// ---------------------------------------------------------------------------
// How an approved request ended, kept beside the run's answer
// ---------------------------------------------------------------------------

/** The standing permission given with an approval, as the views show it. */
type GrantGiven = NonNullable<AgentRequestView['grant']>;

/**
 * What the result column keeps once a request is recorded: the answer the agent reads, and how the
 * approval went. `posted` and `entryIds` are what the committed run itself posted (never the
 * preview a person approved, which may predate it), so a replay can say 'posted' truthfully. Both
 * are left out when that is not known (the run never read the ledger), never stored as "nothing".
 */
interface StoredOutcome {
  answer: unknown;
  file: StagedFile | null;
  posted?: boolean;
  entryIds?: string[];
  grant: GrantGiven | null;
  grantError: string | null;
  /**
   * An approved reveal (D6): until when (ISO) the answer keeps the full values for the agent. Once
   * past, every view masks it, and the settle step masks the stored answer and takes this away.
   */
  revealUntil?: string;
  /** The answer of a reveal, masked for good once its time was up. */
  revealEnded?: boolean;
  /**
   * The id of a reveal's staged file whose time is up but which may still be with the agent's
   * files (lib/agent/files.ts), where get_file would hand it over for the rest of the day. The row
   * no longer points to it; this mark comes off once it is removed, and a removal that failed is
   * tried again by the next settle (letGoRevealFile).
   */
  revealFileLeft?: string;
  /** Claimed and then cut off (LOST_TRACK_MESSAGE, UNKNOWN_OUTCOME_MESSAGE): whether it posted is not known. */
  outcomeUnknown?: boolean;
}

/** Journal entry ids, each once, oldest first as given, at most PREVIEW_ROW_LIMIT. */
function cleanEntryIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const id of v) {
    if (typeof id === 'string' && UUID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= PREVIEW_ROW_LIMIT) break;
  }
  return out;
}

function cleanGrantGiven(v: unknown): GrantGiven | null {
  if (!isPlainObject(v)) return null;
  const { minutes, expiresAt, constraints } = v;
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1) return null;
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { minutes, expiresAt, constraints: isPlainObject(constraints) ? (jsonCopy(constraints) as GrantConstraints) : {} };
}

/**
 * Whether a run that made no entry, and only changed entries in place, moved any money: what the
 * bridge's own facts say (lib/agent/bridge.ts factsFor). For an operation with no amount field the
 * amount of such a run is all the money it moved, "0.00" when it only gave an entry a new title,
 * number, link or memo. Null when that cannot be told (an operation whose amount comes from its
 * body, or an amount the bridge could not know).
 */
function movedByChanges(r: BridgeResult, target: Target): boolean | null {
  if (target.kind !== 'operation' || target.op.amountField) return null;
  const amount = r.facts?.amount;
  if (typeof amount !== 'string' || !amount.trim()) return null;
  try {
    return !Money.isZero(amount);
  } catch {
    return null;
  }
}

/**
 * What a committed run that worked posted, from its own preview ("Commit: what happened"):
 *  - `posted`: it moved the ledger: an entry it made, or one it voided or deleted, whatever its
 *    amount (a void is never "nothing": the rule lib/agent/operate.ts postedToLedger applies when it
 *    answers an agent's own commit 'posted', so that answer and a replay of the request agree).
 *    When it only changed entries in place, they count when they moved money (lines rewritten, a
 *    draft posted), never for a new title, number, link or memo (movedByChanges); when that cannot
 *    be told, unknown;
 *  - `entryIds`: only the entries it made, for the card's links (the bridge marks the others
 *    `touched`, lib/agent/bridge.ts TouchedPostingEntry; a deleted one could not be opened).
 * Unknown (left out) for a run that did not work, and for one whose ledger was never read: an
 * operation whose service opens its own database handle (dryRun 'none') or a desktop flow reports
 * no ledger at all, which says nothing about whether it posted.
 */
function committedLedger(r: BridgeResult, target: Target): Pick<StoredOutcome, 'posted' | 'entryIds'> {
  if (r.mode !== 'commit' || r.outcome !== 'ok') return {};
  const list: unknown = r.preview?.ledger?.entries;
  if (!Array.isArray(list)) return {};
  const entries = list.filter(isPlainObject);
  const made = entries.filter((e) => e.touched === undefined || e.touched === null);
  const entryIds = cleanEntryIds(made.map((e) => e.journalEntryId));
  if (made.length > 0) return { posted: true, entryIds };
  if (!entries.length) return { posted: false, entryIds };
  // Anything but "changed in place" (voided, deleted, or a mark this module does not know) moved
  // the ledger: only a run whose every entry was changed in place is judged by the money it moved.
  if (entries.some((e) => e.touched !== 'changed')) return { posted: true, entryIds };
  const moved = movedByChanges(r, target);
  if (moved !== null) return { posted: moved, entryIds };
  return {};
}

/** The messages of a request whose run was cut off: nobody can tell whether it posted. */
const OUTCOME_UNKNOWN_MESSAGES = new Set([UNKNOWN_OUTCOME_MESSAGE, LOST_TRACK_MESSAGE]);

/**
 * The outcome fields of a view. An executed request with no `posted` beside its answer (recorded
 * before these were kept, or by a run that never read the ledger) leaves `posted` and `entryIds`
 * out: unknown, so a reader keeps its own fallback rather than being told "nothing was posted". So
 * does one still being carried out, and one whose run was cut off (its outcome cannot be told).
 * Anything else not done posted nothing.
 */
function outcomeOf(row: Row): Pick<AgentRequestView, 'posted' | 'entryIds' | 'grant' | 'grantError'> {
  const r = isPlainObject(row.result) ? row.result : null;
  const grant = cleanGrantGiven(r?.grant);
  const grantError = typeof r?.grantError === 'string' && r.grantError ? r.grantError : null;
  if (r && typeof r.posted === 'boolean') return { posted: r.posted, entryIds: cleanEntryIds(r.entryIds), grant, grantError };
  const unknown =
    row.status === 'executed' ||
    row.status === 'approved' ||
    r?.outcomeUnknown === true ||
    (row.status === 'failed' && typeof row.error === 'string' && OUTCOME_UNKNOWN_MESSAGES.has(row.error));
  if (unknown) return { grant, grantError };
  return { posted: false, entryIds: [], grant, grantError };
}

// ---------------------------------------------------------------------------
// An approved reveal (D6, plan §5.9)
// ---------------------------------------------------------------------------

/** The agent asked for the full values and a person approved that for this one call. */
function isReveal(row: Row): boolean {
  return metaOf(row).facts.reveal === true || (isPlainObject(row.input) && (row.input as Record<string, unknown>).reveal === true);
}

/** What a reveal of each kind shows in full, in the audit trail's words. */
const REVEAL_WORDS: Record<NonNullable<Operation['reveal']>, string> = {
  ssn: 'full SSNs and tax IDs',
  account_numbers: 'full bank account numbers',
  payroll: 'full payroll details',
};

/** Which kinds of values a reveal showed: the operation's own kind, or what the approver needed to hold. */
function revealedKinds(row: Row, target: Target): string {
  if (target.kind === 'operation' && target.op.reveal && REVEAL_WORDS[target.op.reveal]) return REVEAL_WORDS[target.op.reveal];
  const flags = dataFlagsFor(row);
  const words = [
    ...(flags.includes('sensitivePayroll') ? ['full SSNs and payroll details'] : []),
    ...(flags.includes('fullAccountNumbers') ? ['full bank account numbers'] : []),
  ];
  return words.length ? words.join(' and ') : 'protected values';
}

/** The reveal's time for the agent is up: when it is past, or cannot be read (fail closed). */
function revealOver(stored: Record<string, unknown>, now: Date): boolean {
  if (!('revealUntil' in stored)) return false;
  const ends = typeof stored.revealUntil === 'string' ? Date.parse(stored.revealUntil) : NaN;
  return !(Number.isFinite(ends) && now.getTime() < ends);
}

/**
 * A reveal's answer once its time is up: masked as any answer of the operation is when no reveal
 * was approved (lib/agent/guards.ts maskSensitiveFields), and every SSN, tax ID or account number
 * by its field name besides.
 */
function maskedAnswer(target: Target, answer: unknown): unknown {
  let out: unknown = stripSecrets(jsonCopy(answer ?? null));
  if (target.kind === 'operation') {
    try {
      out = maskSensitiveFields(target.op, out, { reveal: false });
    } catch {
      // Masked by field name below.
    }
  }
  return maskSensitive(out, NO_FLAGS);
}

/** A staged file's id as lib/agent/files.ts makes them: anything else was never a staged file. */
const STAGED_FILE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The stored result of a reveal whose time is up, masked for good: no full value, and no pointer to
 * its file. The file itself is still with the agent's staged files, so its id is kept as the mark
 * of a file still to be removed (revealFileLeft): the settle step removes it, then the mark.
 */
function endedReveal(stored: Record<string, unknown>, target: Target): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...stored };
  delete rest.revealUntil;
  const fileId = isPlainObject(stored.file) && typeof stored.file.fileId === 'string' ? stored.file.fileId : null;
  const left = fileId && STAGED_FILE_ID_RE.test(fileId) ? { revealFileLeft: fileId } : {};
  return { ...rest, answer: maskedAnswer(target, stored.answer), file: null, revealEnded: true, ...left };
}

/** The reveal's file still to be removed (StoredOutcome.revealFileLeft), or null. */
function revealFileLeftOf(row: Row): string | null {
  const r = isPlainObject(row.result) ? row.result : null;
  return typeof r?.revealFileLeft === 'string' && STAGED_FILE_ID_RE.test(r.revealFileLeft) ? r.revealFileLeft : null;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

function requireAgent(ctx: ServiceContext): { id: string; name: string } {
  const agent = ctx?.agent;
  if (!agent || typeof agent.id !== 'string' || !UUID_RE.test(agent.id)) throw forbidden(AGENT_ONLY_MESSAGE);
  return { id: agent.id, name: typeof agent.name === 'string' ? agent.name : 'Agent' };
}

/** Where the agent's own writes go: its context only reads (lib/agentContext.ts). */
async function writableDb(ctx: ServiceContext): Promise<DB> {
  return isReadOnlyDb(ctx.db) ? getDb() : ctx.db;
}

/** A context for the module's own records (no person, no role limits): the request rows and the pause. */
function systemCtx(db: DB, companyId: string, agent?: ServiceContext['agent']): ServiceContext {
  return { db, companyId, userId: null, ...(agent ? { agent } : {}) };
}

interface Person {
  ctx: ServiceContext & { userId: string };
  userId: string;
  access: EffectiveAccess;
  isAdmin: boolean;
}

/**
 * The signed-in person behind ctx, with their access in this company. Refuses an agent, a run
 * inside an agent's service scope, a context without a person, and anyone who is not an active
 * member. When ctx carries no access (a trusted internal context) the person's own access is read
 * from the company file, so approving never runs wider than they are.
 */
async function requirePerson(ctx: ServiceContext): Promise<Person> {
  if (!ctx || ctx.agent || inServiceScope()) throw forbidden(PERSON_ONLY_MESSAGE, { personOnly: true });
  const userId = ctx.userId;
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) throw forbidden(PERSON_ONLY_MESSAGE, { personOnly: true });
  const resolved = await resolveAccess(ctx.db, ctx.companyId, userId);
  if (!resolved.member || !resolved.active) throw forbidden(NOT_A_MEMBER_MESSAGE);
  const access = ctx.access ?? resolved.access;
  const role = ctx.role ?? legacyRoleFor(access, resolved.isOwner);
  return { ctx: { ...ctx, userId, access, role }, userId, access, isAdmin: access.isAdmin === true };
}

// ---------------------------------------------------------------------------
// Reading rows, names and the agent's state
// ---------------------------------------------------------------------------

async function rowById(db: DB, companyId: string, id: string): Promise<Row | null> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(agentPermissionRequests)
    .where(and(eq(agentPermissionRequests.id, id), eq(agentPermissionRequests.companyId, companyId)));
  return row ?? null;
}

/** The agent's own request by id or by its request key. Never another agent's. */
async function ownRow(db: DB, companyId: string, agentId: string, idOrKey: string): Promise<Row | null> {
  if (typeof idOrKey !== 'string' || !idOrKey) return null;
  const byId = UUID_RE.test(idOrKey) ? eq(agentPermissionRequests.id, idOrKey) : null;
  const byKey = idOrKey.length <= 120 ? eq(agentPermissionRequests.requestKey, idOrKey) : null;
  const which = byId && byKey ? or(byId, byKey) : (byId ?? byKey);
  if (!which) return null;
  const rows = await db
    .select()
    .from(agentPermissionRequests)
    .where(and(eq(agentPermissionRequests.companyId, companyId), eq(agentPermissionRequests.agentId, agentId), which));
  return rows.find((r) => r.id === idOrKey) ?? rows[0] ?? null;
}

async function personNames(db: DB, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id)))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

interface AgentState {
  name: string;
  exists: boolean;
  removed: boolean;
  paused: boolean;
  unattended: boolean;
}

async function agentStates(db: DB, companyId: string, ids: string[]): Promise<Map<string, AgentState>> {
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  const out = new Map<string, AgentState>();
  if (!wanted.length) return out;
  const rows = await db
    .select({ id: agents.id, name: agents.name, revokedAt: agents.revokedAt, pausedAt: agents.pausedAt, unattended: agents.unattended })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, wanted)));
  for (const r of rows) {
    out.set(r.id, { name: r.name, exists: true, removed: Boolean(r.revokedAt), paused: Boolean(r.pausedAt), unattended: r.unattended === true });
  }
  return out;
}

const MISSING_AGENT: AgentState = { name: 'A removed agent', exists: false, removed: true, paused: false, unattended: false };

async function appsBlocked(db: DB, companyId: string): Promise<boolean> {
  const [c] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  return (c?.settings as { integratedAppsBlocked?: unknown } | null | undefined)?.integratedAppsBlocked === true;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function iso(d: Date | null | undefined): string | null {
  return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * The run's answer as stored: `{ answer, file }`, or a copied proposal's own shape. A reveal whose
 * time is up reads masked (and without its file) whether or not the settle step has masked the row
 * yet, as an expiry reads as expired before anything marks it.
 */
function storedResult(row: Row, target: Target, now: Date): { result: unknown; file: StagedFile | null } {
  const r = row.result;
  if (isPlainObject(r) && 'answer' in r) {
    if (revealOver(r, now)) return { result: stripSecrets(endedReveal(r, target).answer ?? null), file: null };
    const file = isPlainObject(r.file) ? (r.file as unknown as StagedFile) : null;
    return { result: stripSecrets(r.answer ?? null), file };
  }
  return { result: stripSecrets(r ?? null), file: null };
}

function previewOf(row: Row): OperationPreview | null {
  if (!isPlainObject(row.preview)) return null;
  return stripSecrets(maskSensitive(row.preview as unknown as OperationPreview, NO_FLAGS));
}

/**
 * The status as a person sees it, for every screen and report that shows a request (the audit
 * report uses it too, so the two never disagree):
 *  - a request still marked pending after its expiry is expired, whether or not anything has
 *    marked it yet (an expiry that cannot be read counts as passed: it can never be approved);
 *  - the first of two approvals keeps the request pending (decided_by set, D8): it is still
 *    waiting, for a second person. 'approved' only ever means "being carried out right now";
 *  - a status nobody knows reads as withdrawn, never as something that can still run.
 */
export function shownStatus(row: { status: string; expiresAt: Date | string | null | undefined }, now: Date = new Date()): RequestStatus {
  const s = (REQUEST_STATUSES as readonly string[]).includes(row.status) ? (row.status as Status) : 'cancelled';
  if (s !== 'pending') return s;
  const ends = row.expiresAt instanceof Date ? row.expiresAt.getTime() : typeof row.expiresAt === 'string' ? Date.parse(row.expiresAt) : NaN;
  return Number.isFinite(ends) && ends > now.getTime() ? 'pending' : 'expired';
}

function toView(row: Row, agentName: string, people: Map<string, string>, now: Date): AgentRequestView {
  const meta = metaOf(row);
  const target = targetOf(row);
  const { result, file } = storedResult(row, target, now);
  const status = shownStatus(row, now);
  return {
    id: row.id,
    kind: meta.kind,
    agentId: row.agentId,
    agentName,
    operation: row.operation,
    class: classOf(row),
    area: meta.area ?? (target.kind === 'operation' ? target.op.area : null),
    status,
    reason: row.reason ?? null,
    summary: row.summary,
    amount: meta.facts.amount,
    needs: viewNeeds(row, target),
    input: maskedInput(isPlainObject(row.input) ? (row.input as OperationInput) : null, sensitiveFieldsOf(target)),
    preview: previewOf(row),
    grantAsked: meta.grantAsked,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    expiresAt: iso(row.expiresAt) ?? new Date(0).toISOString(),
    decidedAt: iso(row.decidedAt),
    decidedByName: row.decidedBy ? (people.get(row.decidedBy) ?? 'A person') : null,
    secondApproverName: row.secondApprover ? (people.get(row.secondApprover) ?? 'A person') : null,
    note: row.note ?? null,
    error: row.error ?? null,
    result,
    file,
    grantId: row.grantId ?? null,
    // Waiting in a stale round (plan §7.4): the preview above is the new one, and a yes is given again on it.
    stale: status === 'pending' && meta.staleRound > 0,
    ...outcomeOf(row),
  };
}

async function viewsFor(db: DB, companyId: string, rows: Row[], now: Date): Promise<AgentRequestView[]> {
  const states = await agentStates(db, companyId, rows.map((r) => r.agentId));
  const people = await personNames(db, rows.flatMap((r) => [r.decidedBy, r.secondApprover]));
  return rows.map((r) => toView(r, (states.get(r.agentId) ?? MISSING_AGENT).name, people, now));
}

// ---------------------------------------------------------------------------
// Who may approve (plan §4.5)
// ---------------------------------------------------------------------------

interface Judgement {
  canApprove: boolean;
  why: string | null;
  /** CONFLICT for a request that is no longer waiting, FORBIDDEN for the rest. */
  code: 'CONFLICT' | 'FORBIDDEN' | null;
  /** Minutes of standing permission this person may give with the approval (0 = none). */
  grantMinutesMax: number;
  /** The same, before "may they approve at all" and "is this the first of two": for a grant request's own check. */
  grantRoom: number;
}

interface JudgeEnv {
  person: Person;
  states: Map<string, AgentState>;
  blocked: boolean;
  /** The approval would come from the host computer's own window. False for a teammate's window. */
  atHost: boolean;
  now: Date;
  fileAdmin: () => Promise<boolean>;
  /**
   * Work out the standing window an approvable operation request offers (grantMinutesMax). Off for
   * the badge, which never shows it; a request FOR standing permission is always worked out, since
   * whether it can be approved at all depends on it.
   */
  grantWindows: boolean;
  /** The standing window for this person (grantWindowReader: the company's day read once per env). */
  grantMinutes: (operation: string, facts: RequestFacts) => Promise<number>;
}

/**
 * What the person's own access is missing for the request's route, or null. A route the permission
 * map has no rule for is denied to every role, an Admin too (lib/agent/policy.ts routeWithoutRule),
 * so no other person can approve it either: said in decide()'s own words (NO_RULE_FOR_APPROVER).
 */
function routeProblem(person: Person, target: Target): string | null {
  if (target.kind === 'operation') {
    const missing = roleProblem(person.access, target.op);
    if (!missing) return null;
    if (routeWithoutRule(target.op)) return NO_RULE_FOR_APPROVER;
    return `Your own access does not allow this: it needs ${missing}. Someone who has that right can approve it.`;
  }
  if (target.kind === 'proposal') {
    try {
      authorizeRequest({ path: target.action.route.path, method: target.action.route.method }, person.access);
      return null;
    } catch (err) {
      const why = err instanceof ServiceError ? ` (${err.message.replace(/\s*Ask your administrator for access\.?$/, '')})` : '';
      return `Your own access does not allow this${why}. Someone who has that right can approve it.`;
    }
  }
  return 'Ironbooks no longer knows this kind of request, so it cannot be approved. Deny it and ask the agent to send it again.';
}

/** Longest window a grantable setting allows before the end of the day (end of day: no limit here). */
function windowCap(g: Grantable): number {
  return g === 'no' ? 0 : g === 'short' ? SHORT_GRANT_MINUTES : Number.POSITIVE_INFINITY;
}

/**
 * Whole minutes of standing permission this person may give with this request right now. The
 * limit is grantWindowReader (lib/services/agentGrants.ts): every rule createGrant applies (the end
 * of the COMPANY's day, host-only and file-Admin work, the Admin rule for outside sends, the
 * person's own role), so the card never offers a window createGrant then refuses. It is never
 * longer than the request's stored class and needs allow either (they may be stricter than the
 * facts alone say: the class the agent's door worked out from the dry run).
 */
async function grantRoomFor(row: Row, target: Target, needs: ApprovalNeeds, env: JudgeEnv): Promise<number> {
  if (row.proposalId || target.kind !== 'operation') return 0;
  if (needs.grantAdminOnly && !env.person.isAdmin) return 0;
  const cap = Math.min(windowCap(needs.grantable), windowCap(GRANTABLE[classOf(row)] ?? 'no'));
  if (cap < 1) return 0;
  const allowed = await env.grantMinutes(row.operation, metaOf(row).facts);
  return Number.isSafeInteger(allowed) ? Math.max(0, Math.min(cap, allowed)) : 0;
}

async function judge(row: Row, target: Target, env: JudgeEnv): Promise<Judgement> {
  const { person, now } = env;
  const needs = needsFor(row, target);
  const meta = metaOf(row);
  const firstOfTwo = needs.twoPerson && !row.decidedBy;

  const no = (why: string, code: 'CONFLICT' | 'FORBIDDEN' = 'FORBIDDEN'): Judgement => ({ canApprove: false, why, code, grantMinutesMax: 0, grantRoom: 0 });

  const status = shownStatus(row, now);
  if (status !== 'pending') return no(STATUS_WHY[status], 'CONFLICT');

  const agent = env.states.get(row.agentId) ?? MISSING_AGENT;
  if (!agent.exists || agent.removed) return no('This agent has been removed, so its requests can no longer be approved. Deny this one to clear it.');
  if (env.blocked) {
    return no('Integrated Applications is switched off, so no agent request can be approved. Turn it back on in Preferences > Integrated Applications first, or deny this one.');
  }
  if (agent.paused) return no('This agent is paused. Turn it back on in Users & Roles > Agents to approve its requests, or deny this one.');

  if (target.kind === 'operation' && target.op.availability !== 'agent') {
    return no("Agents may no longer do this kind of work, even with a person's approval. Deny it; a person can do it in Ironbooks.");
  }
  // Every approval writes (the request, the audit trail), which a view-only role never may.
  if (person.ctx.role === 'viewer') return no(VIEW_ONLY_APPROVE_MESSAGE);
  // The older proposal path runs on one yes and takes nothing typed in: it never takes such a request.
  if (target.kind === 'proposal' && (needs.twoPerson || needs.secrets.length > 0)) {
    return no('This request was copied from an older kind of proposal, which cannot take two approvals or a password. Deny it and ask the agent to send it again.');
  }
  if (needs.twoPerson && row.decidedBy === person.userId) {
    return no('You already approved this. A different person must approve it too.');
  }
  const route = routeProblem(person, target);
  if (route) return no(route);
  if (needs.admin && !person.isAdmin) return no('Only an Admin can approve this.');
  if (needs.fileAdmin && !(await env.fileAdmin())) return no('Only an Admin of every company in this file can approve this.');
  for (const flag of needs.flags ?? []) {
    if (!person.access.flags?.[flag]) return no(`Approving this needs "${flagLabel(flag)}" in your own role.`);
  }
  if (needs.hostOnly && !env.atHost) {
    return no('This can be approved only in Ironbooks on the computer that holds the company file. Open it there, or deny it from here.');
  }
  // Worked out last: it reads the company's day, and only what may be approved needs it.
  const grantRoom = meta.kind === 'grant' || env.grantWindows ? await grantRoomFor(row, target, needs, env) : 0;
  if (meta.kind === 'grant') {
    if (needs.grantAdminOnly && !person.isAdmin) return no('Only an Admin can give standing permission for this.');
    if (grantRoom < 1) return no('Standing permission cannot be given for this right now, so this request can only be denied.');
  }
  const offered = firstOfTwo && meta.kind === 'operation' ? 0 : grantRoom;
  return { canApprove: true, why: null, code: null, grantMinutesMax: offered, grantRoom };
}

/** May this person see the request at all: an Admin, or someone whose own access allows its route. */
function visibleTo(person: Person, target: Target): boolean {
  if (person.isAdmin) return true;
  if (target.kind === 'unknown') return false;
  return routeProblem(person, target) === null;
}

/**
 * Why the first of two approvals no longer counts, or null when it still does (D8). At the second
 * approval the first approver is judged again by the rules judge() holds every approver to: still
 * an active member of the company, not view-only, allowed the request's route, an Admin or the
 * file's Admin where the request needs one, and holding every flag it needs. Being at the host
 * computer is not judged again: that was about where the first yes was given, and it was checked
 * then. Read from the company file now, never from what was true when they said yes.
 */
async function firstApprovalLapsed(db: DB, companyId: string, firstId: string, target: Target, needs: ApprovalNeeds): Promise<string | null> {
  const resolved = await resolveAccess(db, companyId, firstId);
  if (!resolved.member || !resolved.active) return 'is no longer an active member of this company';
  const access = resolved.access;
  if (legacyRoleFor(access, resolved.isOwner) === 'viewer') return 'can now only view the books';
  const first: Person = { ctx: { db, companyId, userId: firstId, access } as Person['ctx'], userId: firstId, access, isAdmin: access.isAdmin === true };
  if (routeProblem(first, target)) return 'no longer has the right to do this work';
  if (needs.admin && !first.isAdmin) return 'is no longer an Admin';
  if (needs.fileAdmin) {
    const fileAdmin = await requireFileAdmin({ db, userId: firstId }).then(
      () => true,
      () => false,
    );
    if (!fileAdmin) return 'is no longer an Admin of every company in this file';
  }
  for (const flag of needs.flags ?? []) {
    if (!access.flags?.[flag]) return `no longer has "${flagLabel(flag)}" in their role`;
  }
  return null;
}

/**
 * The first of two approvals no longer counts (firstApprovalLapsed): the request goes back to
 * waiting for two approvals, with the first approver (and the note that came with their yes)
 * cleared, and the audit trail says whose approval was withdrawn and why. Only while it is still
 * that first approval, on the version this call judged. The second approver is told in a CONFLICT
 * (the card reloads the request, which now waits for two people); nothing ran.
 */
async function withdrawFirstApproval(person: Person, row: Row, why: string): Promise<never> {
  const firstId = row.decidedBy as string;
  const names = await personNames(person.ctx.db, [firstId]);
  const who = names.get(firstId) ?? 'The person who approved this first';
  const reset = await inTransaction(person.ctx, async (tx) => {
    const [updated] = await tx.db
      .update(agentPermissionRequests)
      .set({ decidedBy: null, decidedAt: null, note: null })
      .where(
        and(
          eq(agentPermissionRequests.id, row.id),
          eq(agentPermissionRequests.status, 'pending'),
          eq(agentPermissionRequests.decidedBy, firstId),
          sameVersion(row),
        ),
      )
      .returning();
    if (!updated) return null;
    await auditDecision(tx, row, {
      status: 'pending',
      firstApprovalWithdrawn: firstId,
      why: `The first approval no longer counts: that person ${why}.`,
      waitingFor: 'two approvals',
      noticedBy: person.userId,
    });
    return updated;
  });
  if (!reset) throw new ServiceError('CONFLICT', CHANGED_JUST_NOW_MESSAGE);
  wake(reset);
  throw new ServiceError(
    'CONFLICT',
    `Nothing was done. ${who} approved this first, but ${why}, so that approval no longer counts. ` +
      'The request is waiting again for two people to approve it. Your approval can be the first of the two: approve it again.',
    { firstApprovalWithdrawn: true },
  );
}

/** A window that cannot be worked out is none (fail closed): the request can still be approved once. */
const NO_WINDOW: GrantWindow = () => 0;

async function judgeEnv(person: Person, rows: Row[], atHost: boolean, now: Date, opts: { grantWindows?: boolean } = {}): Promise<JudgeEnv> {
  const db = person.ctx.db;
  let fileAdminAnswer: Promise<boolean> | null = null;
  // The company's day is read once for the whole list, and only when a window is asked for
  // (lib/services/agentGrants.ts grantWindowReader applies every rule createGrant applies).
  let windowOf: Promise<GrantWindow> | null = null;
  return {
    person,
    states: await agentStates(db, person.ctx.companyId, rows.map((r) => r.agentId)),
    blocked: await appsBlocked(db, person.ctx.companyId),
    atHost,
    now,
    fileAdmin: () =>
      (fileAdminAnswer ??= requireFileAdmin({ db, userId: person.userId }).then(
        () => true,
        () => false,
      )),
    grantWindows: opts.grantWindows !== false,
    grantMinutes: async (operation, facts) => {
      windowOf ??= grantWindowReader(person.ctx, now).catch(() => NO_WINDOW);
      const window = await windowOf;
      try {
        return window(operation, facts);
      } catch {
        return 0;
      }
    },
  };
}

/** The View flags that show protected data in full (the closed-period right is about dates, not data). */
const DATA_FLAGS: readonly ApproverFlag[] = ['sensitivePayroll', 'fullAccountNumbers'];

/**
 * The View flags someone must hold to read the run's stored answer: those the request needed. A
 * reveal or a protected read whose needs name none needs both (fail closed).
 */
function dataFlagsFor(row: Row): ApproverFlag[] {
  const named = DATA_FLAGS.filter((f) => (needsOf(row).flags ?? []).includes(f));
  if (named.length) return named;
  const revealed =
    metaOf(row).facts.reveal ||
    (isPlainObject(row.input) && (row.input as Record<string, unknown>).reveal === true) ||
    classOf(row) === 'read_sensitive';
  return revealed ? [...DATA_FLAGS] : [];
}

/**
 * The run's answer as THIS person may read it. The stored answer is the agent's, unmasked when a
 * reveal was approved (D6), so a person without the View flag the request needed gets a note in its
 * place (and no file), and everyone else gets it masked by their own flags, as any screen would.
 */
function resultForPerson(person: Person, row: Row, view: AgentRequestView): Pick<AgentRequestView, 'result' | 'file'> {
  if (view.result === null && view.file === null) return { result: null, file: null };
  const missing = dataFlagsFor(row).filter((f) => !person.access.flags?.[f]);
  if (missing.length) {
    const rights = missing.map((f) => `"${flagLabel(f)}"`).join(' and ');
    return {
      result: `This answer holds protected values that your own role does not show. Someone with ${rights} can read it.`,
      file: null,
    };
  }
  return { result: maskSensitive(view.result, person.access), file: view.file };
}

/** `named`: also the names of the records each request names (one card: never for a whole list). */
async function personViews(person: Person, rows: Row[], atHost: boolean, now: Date, opts: { named?: boolean } = {}): Promise<AgentRequestForPerson[]> {
  if (!rows.length) return [];
  const env = await judgeEnv(person, rows, atHost, now);
  const people = await personNames(person.ctx.db, rows.flatMap((r) => [r.decidedBy, r.secondApprover]));
  const lists = opts.named ? listsReadBy(person) : new Set<ListKind>();
  const out: AgentRequestForPerson[] = [];
  for (const row of rows) {
    const target = targetOf(row);
    const j = await judge(row, target, env);
    const view = toView(row, (env.states.get(row.agentId) ?? MISSING_AGENT).name, people, now);
    const named = opts.named && target.kind === 'operation' ? await namedRecords(person.ctx.db, person.ctx.companyId, target.op, storedInput(row), lists).catch(() => []) : [];
    out.push({
      ...view,
      ...resultForPerson(person, row, view),
      ...(named.length ? { named } : {}),
      canApprove: j.canApprove,
      cannotApproveWhy: j.canApprove ? null : j.why,
      grantMinutesMax: j.grantMinutesMax,
      questions: questionsOf(target),
    });
  }
  return out;
}

/** The lists whose records this person may read (LIST_ROUTES), judged as their own read of each list. */
function listsReadBy(person: Person): ReadonlySet<ListKind> {
  const out = new Set<ListKind>();
  for (const kind of Object.keys(LIST_ROUTES) as ListKind[]) {
    const read = operationForRoute('GET', LIST_ROUTES[kind]);
    if (read && roleProblem(person.access, read) === null) out.add(kind);
  }
  return out;
}

async function personView(person: Person, row: Row, atHost: boolean): Promise<AgentRequestForPerson> {
  const [view] = await personViews(person, [row], atHost, new Date(), { named: true });
  return view;
}

// ---------------------------------------------------------------------------
// Settling: expiry, and proposals decided under Ask AI
// ---------------------------------------------------------------------------

/**
 * The ai_proposals status for a request's outcome. That table knows four words (pending, approved,
 * rejected, failed) and Ask AI shows any other as a warning, so a withdrawn or expired request
 * shows there as not done ("rejected") with a note saying why.
 */
const PROPOSAL_OUTCOME: Partial<Record<Status, { status: 'approved' | 'rejected' | 'failed'; note?: string }>> = {
  executed: { status: 'approved' },
  denied: { status: 'rejected' },
  failed: { status: 'failed' },
  cancelled: { status: 'rejected', note: 'The agent withdrew this request.' },
  expired: { status: 'rejected', note: 'This request expired before anyone decided it.' },
};

function statusFromProposal(status: string): Status {
  const s = status.toLowerCase();
  if (s === 'approved') return 'executed';
  if (s === 'rejected' || s === 'declined') return 'denied';
  if (s === 'failed') return 'failed';
  if (s === 'expired') return 'expired';
  return 'cancelled';
}

/** Mark the old proposal behind a copied request with the request's outcome, when it is still waiting. */
async function settleProposal(
  db: DB,
  row: Pick<Row, 'proposalId' | 'companyId'>,
  status: Status,
  extra: { decidedBy?: string | null; error?: string | null; resultRef?: string | null } = {},
): Promise<void> {
  const outcome = PROPOSAL_OUTCOME[status];
  if (!row.proposalId || !outcome) return;
  const error = extra.error !== undefined ? extra.error : outcome.note;
  await db
    .update(aiProposals)
    .set({
      status: outcome.status,
      decidedAt: new Date(),
      ...(extra.decidedBy !== undefined ? { decidedBy: extra.decidedBy } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(extra.resultRef !== undefined ? { resultRef: extra.resultRef } : {}),
    })
    .where(and(eq(aiProposals.id, row.proposalId), eq(aiProposals.companyId, row.companyId), eq(aiProposals.status, 'pending')));
}

/** End one waiting request (expired, withdrawn …) with its input masked for good. Null when it was no longer waiting. */
async function endWaiting(db: DB, row: Row, status: Status, set: Partial<typeof agentPermissionRequests.$inferInsert> = {}): Promise<Row | null> {
  const settled = settledInput(row, targetOf(row));
  const [updated] = await db
    .update(agentPermissionRequests)
    .set({ status, input: settled.input, ...(settled.needs ? { needs: settled.needs } : {}), ...set })
    .where(and(eq(agentPermissionRequests.id, row.id), eq(agentPermissionRequests.status, 'pending')))
    .returning();
  return updated ?? null;
}

/** What a request whose run was cut off keeps as its result: no answer, and that how it ended is not known. */
const OUTCOME_UNKNOWN: StoredOutcome = { answer: null, file: null, grant: null, grantError: null, outcomeUnknown: true };

/** Approved rows claimed so long ago that their run cannot still be going (STUCK_AFTER_MS). */
function stuckSince(now: Date) {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  return or(
    lte(agentPermissionRequests.decidedAt, cutoff),
    and(isNull(agentPermissionRequests.decidedAt), lte(agentPermissionRequests.createdAt, cutoff)),
  );
}

/**
 * A request left "being carried out" because Ironbooks stopped between the claim and the record:
 * failed, saying the outcome cannot be told, its input masked for good, its proposal settled too.
 * Without this it would stay approved forever, keep its unmasked input, and a waiting agent would
 * only ever time out.
 */
async function settleStuck(db: DB, row: Row, now: Date): Promise<Row> {
  const since = row.decidedAt ?? row.createdAt;
  if (now.getTime() - since.getTime() < STUCK_AFTER_MS) return row;
  const settled = settledInput(row, targetOf(row));
  const ended = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const [updated] = await tx
      .update(agentPermissionRequests)
      .set({ status: 'failed', error: UNKNOWN_OUTCOME_MESSAGE, result: OUTCOME_UNKNOWN, input: settled.input, ...(settled.needs ? { needs: settled.needs } : {}) })
      .where(and(eq(agentPermissionRequests.id, row.id), eq(agentPermissionRequests.status, 'approved'), stuckSince(now)))
      .returning();
    if (!updated) return null;
    await settleProposal(tx, row, 'failed', { error: UNKNOWN_OUTCOME_MESSAGE });
    await writeAudit(systemCtx(tx, row.companyId), {
      action: 'update',
      entityType: 'agent_permission_request',
      entityId: row.id,
      oldValues: { status: 'approved' },
      newValues: { status: 'failed', operation: row.operation, outcomeUnknown: true },
    });
    return updated;
  });
  if (ended) {
    wake(ended);
    return ended;
  }
  return (await rowById(db, row.companyId, row.id)) ?? row;
}

/**
 * A done reveal the settle step still has work on: its answer still holds the full values
 * (StoredOutcome.revealUntil), or its time is up and its file is still to be removed (revealFileLeft).
 */
function holdsReveal(row: Row): boolean {
  if (row.status !== 'executed' || !isPlainObject(row.result)) return false;
  return 'revealUntil' in row.result || revealFileLeftOf(row) !== null;
}

/**
 * A done reveal whose time is up: its stored answer masked for good, then its file removed from the
 * agent's staged files (D6). The masking is written only while the row still holds the full answer,
 * so two readers at once mask it once; the file goes only once the row no longer points to it (the
 * masking was written, by this reader or another). The audit trail already holds the reveal itself
 * (record); this changes nothing a person decided.
 */
async function endReveal(db: DB, row: Row, now: Date): Promise<Row> {
  const stored = row.result as Record<string, unknown>;
  let current = row;
  if ('revealUntil' in stored) {
    if (!revealOver(stored, now)) return row;
    const [updated] = await db
      .update(agentPermissionRequests)
      .set({ result: endedReveal(stored, targetOf(row)) })
      .where(
        and(
          eq(agentPermissionRequests.id, row.id),
          eq(agentPermissionRequests.status, 'executed'),
          sql`(${agentPermissionRequests.result} -> 'revealUntil') IS NOT NULL`,
        ),
      )
      .returning();
    current = updated ?? (await rowById(db, row.companyId, row.id)) ?? row;
  }
  return letGoRevealFile(db, current);
}

/**
 * Remove the staged file of a reveal whose time is up: the agent learned its id while it could read
 * the answer, and get_file (lib/agent/files.ts readStagedFile) would otherwise hand it over again
 * until staged files are cleared, a day later. Only for a row whose masking was written (the mark is
 * written with it). The mark comes off once the file is gone (removeStagedFile answering false: it
 * was gone already); a removal or a write that fails leaves it, for the next settle to try again,
 * and never fails the reader.
 */
async function letGoRevealFile(db: DB, row: Row): Promise<Row> {
  const fileId = revealFileLeftOf(row);
  if (!fileId || row.status !== 'executed') return row;
  try {
    await removeStagedFile({ companyId: row.companyId, agentId: row.agentId }, fileId);
    const [updated] = await db
      .update(agentPermissionRequests)
      .set({ result: sql`${agentPermissionRequests.result} - 'revealFileLeft'` })
      .where(and(eq(agentPermissionRequests.id, row.id), sql`(${agentPermissionRequests.result} ->> 'revealFileLeft') = ${fileId}`))
      .returning();
    return updated ?? row;
  } catch {
    return row;
  }
}

/**
 * An approved reveal ends on time even when nothing reads the request again (D6): a timer in this
 * process masks its answer and removes its file just after its time is up, so an agent that keeps
 * the file's id cannot fetch it again with get_file. When Ironbooks stops before then, its staged
 * files go as the company file closes (electron/main.js clearStagedAgentFiles), and the row is masked
 * by the first reader once the file is open again (at the latest the title bar's poll once someone is
 * signed in, settleForBadge). Never holds the process open; never fails anything.
 */
function endRevealOnTime(db: DB, row: Row): void {
  const r = isPlainObject(row.result) ? row.result : null;
  const ends = typeof r?.revealUntil === 'string' ? Date.parse(r.revealUntil) : NaN;
  if (row.status !== 'executed' || !Number.isFinite(ends)) return;
  const delay = Math.min(Math.max(ends - Date.now(), 0), REVEAL_KEPT_MS) + REVEAL_TIMER_SLACK_MS;
  const timer = setTimeout(() => {
    void (async () => {
      const current = await rowById(db, row.companyId, row.id);
      if (current) await settleRow(db, current, new Date());
    })().catch(() => undefined);
  }, delay);
  timer.unref?.();
}

/**
 * Bring one row up to date before anyone reads or decides it: a waiting request past its time is
 * marked expired, a copied proposal already decided under Ask AI takes that decision, a run cut off
 * long ago is marked failed, and a reveal whose time is up is masked for good and its file removed.
 */
async function settleRow(db: DB, row: Row, now: Date): Promise<Row> {
  if (row.status === 'approved') return settleStuck(db, row, now);
  if (holdsReveal(row)) return endReveal(db, row, now);
  if (row.status !== 'pending') return row;
  if (row.expiresAt.getTime() <= now.getTime()) {
    const ended = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as DB;
      const done = await endWaiting(tx, row, 'expired');
      if (done) await settleProposal(tx, row, 'expired');
      return done;
    });
    if (ended) {
      wake(ended);
      return ended;
    }
    return (await rowById(db, row.companyId, row.id)) ?? row;
  }
  if (row.proposalId) {
    const [p] = await db
      .select({ status: aiProposals.status, decidedBy: aiProposals.decidedBy, decidedAt: aiProposals.decidedAt, error: aiProposals.error })
      .from(aiProposals)
      .where(and(eq(aiProposals.id, row.proposalId), eq(aiProposals.companyId, row.companyId)));
    if (p && p.status !== 'pending') {
      const ended = await endWaiting(db, row, statusFromProposal(p.status), {
        decidedBy: p.decidedBy ?? null,
        decidedAt: p.decidedAt ?? now,
        ...(p.error ? { error: p.error } : {}),
      });
      if (ended) {
        wake(ended);
        return ended;
      }
      return (await rowById(db, row.companyId, row.id)) ?? row;
    }
  }
  return row;
}

/** Settle every waiting request of the company that needs it. Returns how many expired. */
async function settleCompany(db: DB, companyId: string, now: Date): Promise<number> {
  const overdue = await db
    .select()
    .from(agentPermissionRequests)
    .where(
      and(
        eq(agentPermissionRequests.companyId, companyId),
        eq(agentPermissionRequests.status, 'pending'),
        lte(agentPermissionRequests.expiresAt, now),
      ),
    );
  let expired = 0;
  for (const row of overdue) if ((await settleRow(db, row, now)).status === 'expired') expired++;
  const copied = await db
    .select({ request: agentPermissionRequests })
    .from(agentPermissionRequests)
    .innerJoin(aiProposals, eq(aiProposals.id, agentPermissionRequests.proposalId))
    .where(
      and(
        eq(agentPermissionRequests.companyId, companyId),
        eq(agentPermissionRequests.status, 'pending'),
        sql`${aiProposals.status} <> 'pending'`,
      ),
    );
  for (const { request } of copied) await settleRow(db, request, now);
  const stuck = await db
    .select()
    .from(agentPermissionRequests)
    .where(and(eq(agentPermissionRequests.companyId, companyId), eq(agentPermissionRequests.status, 'approved'), stuckSince(now)));
  for (const row of stuck) await settleRow(db, row, now);
  // Reveals whose time is up (D6), and those whose file is still to be removed (a removal that
  // failed before). ISO times sort as text, and only this module writes them.
  const revealed = await db
    .select()
    .from(agentPermissionRequests)
    .where(
      and(
        eq(agentPermissionRequests.companyId, companyId),
        eq(agentPermissionRequests.status, 'executed'),
        or(
          and(
            sql`(${agentPermissionRequests.result} ->> 'revealUntil') IS NOT NULL`,
            sql`(${agentPermissionRequests.result} ->> 'revealUntil') <= ${now.toISOString()}`,
          ),
          sql`(${agentPermissionRequests.result} ->> 'revealFileLeft') IS NOT NULL`,
        ),
      ),
    );
  for (const row of revealed) await settleRow(db, row, now);
  return expired;
}

// ---------------------------------------------------------------------------
// The agent's side
// ---------------------------------------------------------------------------

function cleanRequestKey(v: unknown): string {
  if (typeof v !== 'string' || !REQUEST_KEY_RE.test(v)) {
    throw validation(
      'Give a request id: 3 to 120 letters, digits, dots, dashes, colons or underscores, unique to this request (for example "bill-staples-2026-03-a"). Asking again with the same id never asks twice.',
    );
  }
  return v;
}

/** The newest moment the hourly limit paused this agent, or null. */
async function lastLimitPause(db: DB, companyId: string, agentId: string): Promise<number | null> {
  const [row] = await db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, companyId),
        eq(auditLogs.entityType, 'agent'),
        eq(auditLogs.entityId, agentId),
        sql`${auditLogs.newValues} ->> 'pausedFor' = 'too_many_requests'`,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const at = isPlainObject(row?.newValues) ? Date.parse(String((row!.newValues as Record<string, unknown>).pausedAt ?? '')) : NaN;
  return Number.isFinite(at) ? at : null;
}

function expiryDays(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 365 ? v : DEFAULT_REQUEST_EXPIRY_DAYS;
}

/** The bridge's words for a version it cannot send (lib/agent/bridge.ts expectedVersionOf). */
const VERSION_MESSAGE =
  'Send expectedUpdatedAt as the record\'s updatedAt exactly as Ironbooks answered it (for example "2026-11-22T14:05:09.123Z"), or leave it out.';
const SUMMARY_TOO_LONG_MESSAGE =
  'This request is too long to show a person on one approval card. Split the work into smaller requests (for example, fewer recipients in each), then ask again. Nobody was asked.';

/**
 * The input to keep, with the version of the record the agent last read
 * (OperationInput.expectedUpdatedAt) kept as the door keeps it (lib/agent/operate.ts withVersion):
 * guardInput keeps only the parts it knows, and this one is neither a secret nor anything only a
 * person sets. Stored with the request, the approved run sends it on (runApproved), so a person's
 * edit made after the agent read the record is refused by the route's own version check (409),
 * never overwritten. One the bridge could not send is refused here, before anyone is asked: dropping
 * it would let the run overwrite that edit, and keeping it would only fail the approved run.
 */
function withVersionKept(guarded: OperationInput, given: OperationInput): OperationInput {
  const own = (guarded as { expectedUpdatedAt?: unknown }).expectedUpdatedAt;
  const v = own !== undefined && own !== null && own !== '' ? own : (given as { expectedUpdatedAt?: unknown }).expectedUpdatedAt;
  const out: OperationInput = { ...guarded };
  delete out.expectedUpdatedAt;
  if (v === undefined || v === null || v === '') return out;
  // A plain ISO time with its zone, as guardInput keeps one (lib/agent/guards.ts plainIsoTime): a
  // time with no zone would be read in this computer's own time zone, so it is refused.
  const plain = plainIsoTime(v);
  if (plain === null) throw validation(VERSION_MESSAGE);
  return { ...out, expectedUpdatedAt: plain };
}

export const createAgentRequest: CreateAgentRequest = async (ctx, req) => {
  const agent = requireAgent(ctx);
  if (inServiceScope()) throw forbidden(IN_SCOPE_MESSAGE);
  if (!req || typeof req !== 'object') throw validation('Say what the request is for.');
  const requestKey = cleanRequestKey(req.requestKey);
  if (req.kind !== 'operation' && req.kind !== 'grant') throw validation('A request is either for an operation or for standing permission.');
  const kind: AgentRequestKind = req.kind;

  const given = req.operation;
  if (!given || typeof given !== 'object' || typeof given.id !== 'string' || !given.id || given.id.length > 160) {
    throw validation('Say which operation the request is for.');
  }
  // The registry's own entry when there is one: what was classified, not what a caller passed.
  let op: Operation = given;
  try {
    op = operationById(given.id) ?? given;
  } catch {
    op = given;
  }
  if (op.id.startsWith(ACTION_PREFIX)) throw validation('Ask for an operation by its id (find_operations lists them).');
  if (op.availability !== 'agent') {
    throw forbidden("Agents can never do this, even with a person's approval. Ask a person to do it in Ironbooks.");
  }

  // The caller already guarded the input; guard it again, then drop anything named like a secret.
  // The version of the record the agent last read goes with it (withVersionKept).
  const sent = isPlainObject(req.input) ? (req.input as OperationInput) : {};
  const guarded = guardInput(op, sent);
  if (guarded.refused) throw forbidden(guarded.refused);
  const input = withVersionKept(withoutSecretFields(jsonCopy(guarded.input ?? {})) as OperationInput, sent);
  if (JSON.stringify(input).length > INPUT_MAX_CHARS) {
    throw validation('This request is too large to keep for a person to approve. Split the work into smaller requests.');
  }

  const reason = cleanReason(req.reason);
  // Kept whole, never cut (SUMMARY_MAX): a cut could leave recipients off the card.
  const said = oneLine(typeof req.summary === 'string' ? req.summary : '');
  if (said.length > SUMMARY_MAX) throw validation(SUMMARY_TOO_LONG_MESSAGE);
  const summary = said || `${RISK_CLASS_LABELS[op.class] ?? 'Work'}: ${op.id}`;
  // Only when the asker passes them beside the request (the contract has no field for them, and the
  // door passes none today): a fallback for a record the names read later finds no name for.
  const names = cleanNames((req as NewAgentRequest & { names?: unknown }).names);
  const facts = cleanFacts(req.facts);
  const grantAsked = cleanGrantAsked(req.grantAsked);
  if (kind === 'grant' && !grantAsked) throw validation('Say how long the standing permission should last, in minutes.');

  const policy = await loadAgentPolicy(ctx, agent.id);
  // Fail closed: the stricter of what the caller worked out and what the policy engine says now.
  const asked = isRiskClass(req.effectiveClass) ? req.effectiveClass : 'admin';
  const cls = stricterClass(asked, effectiveClassOf(op, facts));
  const needs = mergeNeeds(normalNeeds(req.needs), approvalNeeds(op, cls, facts, policy));

  const masked = maskedInput(input, op.sensitiveFields ?? []);
  const inputHash = agentInputHash(op.id, { kind, input: masked, grantAsked });
  const meta: RequestMeta = { kind, facts, grantAsked, inputHash, area: op.area ?? null, scrubbed: false, staleRound: 0, staleSeen: [], ...namesPart(names) };

  const db = await writableDb(ctx);
  const now = new Date();

  // The same request id again: the same request, or a refusal when it asked for something else.
  const sameKey = async (): Promise<AgentRequestView | null> => {
    const [earlier] = await db
      .select()
      .from(agentPermissionRequests)
      .where(and(eq(agentPermissionRequests.agentId, agent.id), eq(agentPermissionRequests.requestKey, requestKey)));
    if (!earlier) return null;
    const m = metaOf(earlier);
    const same =
      earlier.companyId === ctx.companyId &&
      earlier.operation === op.id &&
      m.kind === kind &&
      m.inputHash === inputHash &&
      (m.scrubbed || agentInputHash(op.id, storedInput(earlier)) === agentInputHash(op.id, input));
    if (!same) {
      throw new ServiceError(
        'CONFLICT',
        `The request id "${requestKey}" was already used for a different request. Use a new request id for new work; reuse one only to ask about the very same request again.`,
        { requestId: requestKey },
      );
    }
    const settled = await settleRow(db, earlier, now);
    return (await viewsFor(db, ctx.companyId, [settled], now))[0];
  };
  const earlier = await sameKey();
  if (earlier) return earlier;

  const [me] = await db
    .select({ revokedAt: agents.revokedAt, pausedAt: agents.pausedAt, unattended: agents.unattended })
    .from(agents)
    .where(and(eq(agents.id, agent.id), eq(agents.companyId, ctx.companyId)));
  if (!me || me.revokedAt) throw forbidden(REMOVED_AGENT_MESSAGE);
  if (me.pausedAt || policy?.pausedAt) throw forbidden(PAUSED_MESSAGE, { paused: true });

  const expiresAt = new Date(now.getTime() + expiryDays(policy?.requestExpiryDays) * 86_400_000);
  const pausedSince = await lastLimitPause(db, ctx.companyId, agent.id);
  const since = new Date(Math.max(now.getTime() - 3_600_000, pausedSince ?? 0));

  const made = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentPermissionRequests)
      .where(and(eq(agentPermissionRequests.agentId, agent.id), gt(agentPermissionRequests.createdAt, since)));
    if (Number(n) >= ASKS_PER_HOUR_BEFORE_PAUSE) {
      // Approval fatigue (plan §11.2): too many asks in an hour pauses the agent until a person resumes it.
      await tx.update(agents).set({ pausedAt: now }).where(and(eq(agents.id, agent.id), isNull(agents.pausedAt)));
      await writeAudit(systemCtx(tx, ctx.companyId), {
        action: 'update',
        entityType: 'agent',
        entityId: agent.id,
        oldValues: { paused: false },
        newValues: { paused: true, pausedFor: 'too_many_requests', pausedAt: now.toISOString(), asksInLastHour: Number(n) },
      });
      return { paused: true as const };
    }
    const stored: StoredNeeds = { ...needs, request: meta };
    const [row] = await tx
      .insert(agentPermissionRequests)
      .values({
        companyId: ctx.companyId,
        agentId: agent.id,
        requestKey,
        operation: op.id,
        class: cls,
        input,
        reason,
        summary,
        preview: req.preview ? jsonCopy(req.preview) : null,
        needs: stored,
        stalenessKey: typeof req.stalenessKey === 'string' ? req.stalenessKey.slice(0, 128) : null,
        status: 'pending',
        expiresAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning();
    return { row: row ?? null };
  });

  if ('paused' in made) throw forbidden(TOO_MANY_MESSAGE, { paused: true });
  if (!made.row) {
    // Asked twice at the same moment: the other ask made it.
    const again = await sameKey();
    if (again) return again;
    throw new ServiceError('CONFLICT', 'That request is already being asked. Ask again in a moment with the same request id.');
  }
  wake(made.row);
  if (me.unattended && policy?.notifyEmail === true) void noticeAdmins(db, ctx.companyId, agent, made.row.summary);
  return (await viewsFor(db, ctx.companyId, [made.row], now))[0];
};

export const requestForAgent: RequestForAgent = async (ctx, idOrKey) => {
  const agent = requireAgent(ctx);
  const row = await ownRow(ctx.db, ctx.companyId, agent.id, idOrKey);
  if (!row) return null;
  const now = new Date();
  const settled = row.status === 'pending' || row.status === 'approved' || holdsReveal(row) ? await settleRow(await writableDb(ctx), row, now) : row;
  return (await viewsFor(ctx.db, ctx.companyId, [settled], now))[0];
};

export const listRequestsForAgent: ListRequestsForAgent = async (ctx, opts = {}) => {
  const agent = requireAgent(ctx);
  const now = new Date();
  await settleCompany(await writableDb(ctx), ctx.companyId, now);
  const status = opts.status && (REQUEST_STATUSES as readonly string[]).includes(opts.status) ? opts.status : null;
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 50), 1), 200);
  const rows = await ctx.db
    .select()
    .from(agentPermissionRequests)
    .where(
      and(
        eq(agentPermissionRequests.companyId, ctx.companyId),
        eq(agentPermissionRequests.agentId, agent.id),
        ...(status ? [eq(agentPermissionRequests.status, status)] : []),
      ),
    )
    .orderBy(desc(agentPermissionRequests.createdAt))
    .limit(limit);
  return viewsFor(ctx.db, ctx.companyId, rows, now);
};

export const cancelAgentRequest: CancelAgentRequest = async (ctx, id) => {
  const agent = requireAgent(ctx);
  if (inServiceScope()) throw forbidden(IN_SCOPE_MESSAGE);
  const db = await writableDb(ctx);
  const found = await ownRow(db, ctx.companyId, agent.id, id);
  if (!found) throw notFound('That request');
  const now = new Date();
  const row = await settleRow(db, found, now);
  if (row.status !== 'pending') {
    throw new ServiceError('CONFLICT', `${STATUS_WHY[shownStatus(row, now)] || 'This request is no longer waiting.'} It can no longer be withdrawn.`);
  }
  const ended = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const done = await endWaiting(tx, row, 'cancelled', { decidedAt: now });
    if (!done) return null;
    await settleProposal(tx, row, 'cancelled');
    await writeAudit(systemCtx(tx, ctx.companyId, ctx.agent), {
      action: 'update',
      entityType: 'agent_permission_request',
      entityId: row.id,
      oldValues: { status: 'pending' },
      newValues: { status: 'cancelled', operation: row.operation },
    });
    return done;
  });
  if (!ended) throw new ServiceError('CONFLICT', 'This request was decided just now, so it can no longer be withdrawn.');
  wake(ended);
  return (await viewsFor(db, ctx.companyId, [ended], now))[0];
};

export const waitForDecision: WaitForDecision = async (ctx, id, timeoutSeconds) => {
  const agent = requireAgent(ctx);
  const db = await writableDb(ctx);
  const read = async (): Promise<Row | null> => {
    const row = await ownRow(ctx.db, ctx.companyId, agent.id, id);
    return row ? settleRow(db, row, new Date()) : null;
  };
  const view = async (row: Row) => (await viewsFor(ctx.db, ctx.companyId, [row], new Date()))[0];

  const first = await read();
  if (!first) throw notFound('That request');
  const seconds = Number.isFinite(timeoutSeconds) ? Math.min(Math.max(timeoutSeconds, 0), WAIT_MAX_SECONDS) : 0;
  // A run inside the route bridge has a time limit of its own: it never waits.
  if (SETTLED.includes(first.status as Status) || seconds <= 0 || inServiceScope()) return view(first);

  return new Promise<AgentRequestView>((resolve, reject) => {
    let finished = false;
    let latest: Row = first;
    let checking = false;
    const events = requestEvents();
    const finish = (row: Row) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearTimeout(deadline);
      events.off('change', onChange);
      view(row).then(resolve, reject);
    };
    const check = async () => {
      if (finished || checking) return;
      checking = true;
      try {
        const row = await read();
        if (row) latest = row;
        if (row && SETTLED.includes(row.status as Status)) finish(row);
      } catch {
        /* read again on the next tick */
      } finally {
        checking = false;
      }
    };
    const onChange = (change: RequestChange) => {
      if (change.id === first.id) void check();
    };
    events.on('change', onChange);
    const timer = setInterval(() => void check(), WAIT_RECHECK_MS);
    const deadline = setTimeout(() => {
      read()
        .then((row) => finish(row ?? latest))
        .catch(() => finish(latest));
    }, seconds * 1000);
  });
};

/**
 * D7: an agent that works unattended asked while nobody is signed in, and the Admin asked to be
 * told. A short email to the company's Admins naming the agent and the summary, nothing more (no
 * reason, no input, no links of its own). At most one per agent every few minutes. Never fails
 * the request it is sent for.
 */
const noticeState = globalThis as typeof globalThis & { __ironbooksAgentNotices?: Map<string, number> };
const lastNotice: Map<string, number> = (noticeState.__ironbooksAgentNotices ??= new Map());

async function noticeAdmins(db: DB, companyId: string, agent: { id: string; name: string }, summary: string): Promise<void> {
  try {
    const sessions = await listActiveSessions(db, { companyId }).catch(() => []);
    if (sessions.length > 0) return; // someone is signed in and sees the badge
    const nowMs = Date.now();
    const last = lastNotice.get(agent.id);
    if (last !== undefined && nowMs - last < NOTICE_EVERY_MS) return;
    lastNotice.set(agent.id, nowMs);

    const [company] = await db.select({ ownerId: companies.ownerId }).from(companies).where(eq(companies.id, companyId));
    const members = await db
      .select({ userId: userCompanies.userId })
      .from(userCompanies)
      .where(and(eq(userCompanies.companyId, companyId), eq(userCompanies.isActive, true)));
    const ids = [...new Set([...(company?.ownerId ? [company.ownerId] : []), ...members.map((m) => m.userId)])];
    const admins: string[] = [];
    for (const id of ids) {
      const r = await resolveAccess(db, companyId, id);
      if (r.member && r.active && r.access.isAdmin) admins.push(id);
    }
    if (!admins.length) return;
    const emails = await db.select({ email: users.email }).from(users).where(inArray(users.id, admins));

    // The summary is filled in from the request, so a link in it is the agent's: never made clickable.
    const shown = oneLine(summary)
      .replace(/\b(?:https?|ftp|file):\/\/\S+/gi, '[link removed]')
      .replace(/\bwww\.\S+/gi, '[link removed]')
      .slice(0, 300);
    const name = oneLine(agent.name).slice(0, 100) || 'An agent';
    const text =
      `${name} asked for approval while nobody was signed in to Ironbooks:\n\n` +
      `    ${shown}\n\n` +
      'Nothing has been done. To approve or deny it, open Ironbooks and go to Agent requests. ' +
      'If you did not expect this, you can pause the agent in Users & Roles > Agents.\n';
    const ctx = systemCtx(db, companyId);
    for (const { email } of emails) {
      try {
        await sendMail({ to: email, subject: `${name} is waiting for your approval in Ironbooks`, text }, ctx);
      } catch {
        /* a notice that cannot be sent never fails the request */
      }
    }
  } catch {
    /* a notice that cannot be sent never fails the request */
  }
}

// ---------------------------------------------------------------------------
// A person's side
// ---------------------------------------------------------------------------

export const listRequestsForPerson: ListRequestsForPerson = async (ctx, opts = {}) => {
  const person = await requirePerson(ctx);
  const db = person.ctx.db;
  const now = new Date();
  await settleCompany(db, ctx.companyId, now);
  const wanted = opts.status ?? 'pending';
  if (wanted !== 'all' && !(REQUEST_STATUSES as readonly string[]).includes(wanted)) throw validation('Choose a status to list.');
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 100), 1), 500);
  const conds = [eq(agentPermissionRequests.companyId, ctx.companyId)];
  if (wanted !== 'all') conds.push(eq(agentPermissionRequests.status, wanted));
  if (opts.agentId) {
    if (!UUID_RE.test(opts.agentId)) return [];
    conds.push(eq(agentPermissionRequests.agentId, opts.agentId));
  }
  // Read more than asked: what this person may not see is left out after.
  const rows = await db
    .select()
    .from(agentPermissionRequests)
    .where(and(...conds))
    .orderBy(desc(agentPermissionRequests.createdAt))
    .limit(Math.min(limit * 4, 2000));
  const visible = rows.filter((r) => visibleTo(person, targetOf(r))).slice(0, limit);
  // Left out, the window counts as the host's (the contract's rule); a teammate's window says false.
  return personViews(person, visible, opts.atHost !== false, now);
};

export const requestForPerson: RequestForPerson = async (ctx, id, opts = {}) => {
  const person = await requirePerson(ctx);
  const found = await rowById(person.ctx.db, ctx.companyId, id);
  if (!found || !visibleTo(person, targetOf(found))) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
  const row = await settleRow(person.ctx.db, found, new Date());
  return personView(person, row, opts?.atHost !== false);
};

/** How many waiting requests the badge judges, newest first, and how many rows it reads to find them. */
const BADGE_COUNT_MAX = 500;
const BADGE_READ_MAX = 2000;
/**
 * How often the badge brings the company's requests up to date (settleCompany), at most. Exported
 * for the load test (test/agentLoad.test.ts), which moves its clock past it before a settling read.
 */
export const BADGE_SETTLE_EVERY_MS = 60_000;

/**
 * When the badge last settled each company (by company id). On globalThis: Next can load this
 * module more than once in one process, and the copies must share one time per company.
 */
const badgeState = globalThis as typeof globalThis & { __ironbooksAgentBadgeSettled?: Map<string, number> };
const badgeSettled: Map<string, number> = (badgeState.__ironbooksAgentBadgeSettled ??= new Map());

/**
 * The badge is the one reader that runs all day, so it is what settles requests nobody opens: an
 * expired one, a copied proposal decided under Ask AI, a run cut off long ago. Settling masks the
 * protected values such a request kept in its row for the run (a tax ID, an account number), for
 * good. At most once a minute per company (the poll is every few seconds), and never failing the
 * badge: a file that cannot be written now is settled by the next reader that can.
 */
async function settleForBadge(db: DB, companyId: string, now: Date): Promise<void> {
  const at = now.getTime();
  const last = badgeSettled.get(companyId);
  // A clock set back since (last in the future) settles again rather than waiting for it.
  if (last !== undefined && at >= last && at - last < BADGE_SETTLE_EVERY_MS) return;
  badgeSettled.set(companyId, at);
  try {
    await settleCompany(db, companyId, now);
  } catch {
    /* the count below never counts what is overdue anyway */
  }
}

/**
 * The title bar's count and the newest request it counts, from ONE read of the waiting requests,
 * so the two never disagree. Each is judged for this person in this window exactly as an approval
 * would be (a teammate's window does not count host-only work), without the standing-permission
 * window the badge never shows. A request past its expiry, or a copied proposal already decided
 * under Ask AI, is never counted, whether or not anything has marked it yet (settleForBadge marks
 * them at most once a minute). Someone who is not an Admin reads only the operations they may see,
 * so a busy company's other work never crowds theirs out of the count. Nothing for an agent, a run
 * inside an agent's scope, or a context without a person.
 */
export const badgeForPerson: BadgeForPerson = async (ctx, opts) => {
  if (!ctx || ctx.agent || inServiceScope() || !ctx.userId) return { pending: 0, newest: null };
  const person = await requirePerson(ctx);
  const db = person.ctx.db;
  const now = new Date();
  await settleForBadge(db, ctx.companyId, now);
  const proposalJoin = and(eq(aiProposals.id, agentPermissionRequests.proposalId), eq(aiProposals.companyId, agentPermissionRequests.companyId));
  const waiting = and(
    eq(agentPermissionRequests.companyId, ctx.companyId),
    eq(agentPermissionRequests.status, 'pending'),
    gt(agentPermissionRequests.expiresAt, now),
    or(isNull(agentPermissionRequests.proposalId), eq(aiProposals.status, 'pending')),
  );
  let visibleOps: string[] | null = null;
  if (!person.isAdmin) {
    // Which kinds of work are waiting, and which of them this person may see (a short list).
    const kinds = await db
      .selectDistinct({ operation: agentPermissionRequests.operation })
      .from(agentPermissionRequests)
      .leftJoin(aiProposals, proposalJoin)
      .where(waiting);
    // A copied proposal always names its proposal; the rows are checked one by one below anyway.
    visibleOps = kinds.map((k) => k.operation).filter((op) => visibleTo(person, targetFor(op, op.startsWith(ACTION_PREFIX))));
    if (!visibleOps.length) return { pending: 0, newest: null };
  }
  const found = await db
    .select({ request: agentPermissionRequests })
    .from(agentPermissionRequests)
    .leftJoin(aiProposals, proposalJoin)
    .where(visibleOps ? and(waiting, inArray(agentPermissionRequests.operation, visibleOps)) : waiting)
    .orderBy(desc(agentPermissionRequests.createdAt))
    .limit(BADGE_READ_MAX);
  const rows = found
    .map((f) => f.request)
    .filter((r) => visibleTo(person, targetOf(r)))
    .slice(0, BADGE_COUNT_MAX);
  if (!rows.length) return { pending: 0, newest: null };
  const env = await judgeEnv(person, rows, opts?.atHost === true, now, { grantWindows: false });
  let pending = 0;
  let newest: Awaited<ReturnType<BadgeForPerson>>['newest'] = null;
  for (const row of rows) {
    if (!(await judge(row, targetOf(row), env)).canApprove) continue;
    pending += 1;
    // The app's own summary only, never the agent's words: it may be shown in a desktop notice.
    newest ??= {
      id: row.id,
      agentName: (env.states.get(row.agentId) ?? MISSING_AGENT).name,
      summary: row.summary,
      createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    };
  }
  return { pending, newest };
};

export const pendingCountForPerson: PendingCountForPerson = async (ctx) => {
  // The same count as the badge, with no window to tell: as the contract reads a left-out atHost.
  return (await badgeForPerson(ctx, { atHost: true })).pending;
};

function cleanSecrets(raw: unknown): Partial<Record<SecretKind, string>> {
  const out: Partial<Record<SecretKind, string>> = {};
  if (!isPlainObject(raw)) return out;
  for (const kind of SECRET_KINDS) {
    const v = raw[kind];
    if (typeof v === 'string' && v.length > 0 && v.length <= 1000) out[kind] = v;
  }
  return out;
}

function cleanApproveInput(raw: unknown): ApproveInput & { secrets: Partial<Record<SecretKind, string>> } {
  const i = isPlainObject(raw) ? raw : {};
  const grant = cleanGrantAsked(i.grant);
  if (i.grant !== undefined && i.grant !== null && !grant) {
    throw validation('Give how long the standing permission lasts in whole minutes, 1 or more.');
  }
  return {
    secrets: cleanSecrets(i.secrets),
    grant,
    acceptStale: i.acceptStale === true,
    ...(isPlainObject(i.answers) ? { answers: jsonCopy(i.answers) } : {}),
    note: cleanNote(i.note),
  };
}

const YES_NO_RE = /^(yes|no|true|false)$/i;

/**
 * A desktop flow's questions must each have an answer the shell can use before anything is claimed
 * (a 'password' one goes with the secrets instead). The shell stops at a question it has no usable
 * answer for and the request then fails for good, so a missing or wrong answer is sent back to the
 * card while the request can still be approved. The words are the ones the shell accepts
 * (electron/agentShell.js): yes or no for a yes/no question, one of the choices for a choice.
 */
function checkFlowAnswers(questions: readonly FlowQuestion[], answers: Record<string, unknown> | undefined): void {
  for (const q of questions) {
    if (q.kind === 'password') continue;
    const raw = answers?.[q.id];
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
      throw validation(`Answer every question on the card, then approve again. Nothing was done. Still to answer: "${q.text}"`);
    }
    if (q.kind === 'yes_no' && !(typeof raw === 'boolean' || (typeof raw === 'string' && YES_NO_RE.test(raw.trim())))) {
      throw validation(`Answer "${q.text}" with yes or no, then approve again. Nothing was done.`);
    }
    if (q.kind === 'choice') {
      const want = typeof raw === 'string' ? raw.trim().toLowerCase() : null;
      if (!want || !(q.choices ?? []).some((c) => c.toLowerCase() === want)) {
        throw validation(`Answer "${q.text}" with one of: ${(q.choices ?? []).join(', ')}. Then approve again. Nothing was done.`);
      }
    }
    if ((q.kind === 'text' || q.kind === 'path') && typeof raw !== 'string') {
      throw validation(`Answer "${q.text}" in words, then approve again. Nothing was done.`);
    }
  }
}

/** The decision itself in the audit trail: who, what, the outcome. Never a secret or the input. */
async function auditDecision(
  tx: ServiceContext,
  row: Row,
  newValues: Record<string, unknown>,
): Promise<void> {
  await writeAudit(
    { ...tx, approval: { approvedBy: null, requestId: row.id, grantId: (newValues.grantId as string | null | undefined) ?? null } },
    {
      action: 'update',
      entityType: 'agent_permission_request',
      entityId: row.id,
      oldValues: { status: 'pending' },
      newValues: { operation: row.operation, agentId: row.agentId, ...newValues },
    },
  );
}

function emptyResult(message: string): BridgeResult {
  return {
    mode: 'commit',
    httpStatus: 0,
    outcome: 'error',
    result: null,
    file: null,
    preview: null,
    warnings: [],
    error: { message, code: null, details: null },
    effects: [],
    facts: EMPTY_FACTS,
    stalenessKey: null,
    produced: [],
  };
}

/**
 * The standing permission as it was given: createGrant's own limits and end time (it cleans the
 * limits, so they may be narrower than asked), the minutes the person chose.
 */
function grantGiven(made: unknown, asked: { minutes: number; constraints: GrantConstraints }, now: Date): GrantGiven {
  const g = isPlainObject(made) ? made : {};
  const expiresAt =
    typeof g.expiresAt === 'string' && Number.isFinite(Date.parse(g.expiresAt))
      ? g.expiresAt
      : new Date(now.getTime() + asked.minutes * 60_000).toISOString();
  const constraints = isPlainObject(g.constraints) ? g.constraints : isPlainObject(asked.constraints) ? asked.constraints : {};
  return { minutes: asked.minutes, constraints: jsonCopy(constraints) as GrantConstraints, expiresAt };
}

function producedOf(r: BridgeResult): ProducedSecret[] {
  return (Array.isArray(r.produced) ? r.produced : []).filter(
    (p): p is ProducedSecret => isPlainObject(p) && typeof p.value === 'string' && typeof p.label === 'string',
  );
}

function failureMessage(r: BridgeResult): string {
  if (r.outcome === 'needs_confirmation') {
    const w = (r.warnings ?? []).find((x) => x && typeof x.message === 'string');
    if (w) return `${w.message} The agent can send the request again with "${w.flag}" if this is right.`;
  }
  return r.error?.message || 'The work could not be done.';
}

export const approveAgentRequest: ApproveAgentRequest = (ctx, id, rawInput, opts) => approveRequest(ctx, id, rawInput, opts, null);

/**
 * A secret the run cannot do without that the approver did not type: the run would be refused for
 * it, and the request would then fail for good (a desktop flow is never run twice under one id).
 * Sent back to the card first, while the request can still be approved.
 *  - A route: every secret the operation lists (Operation.needsSecret: lib/agent/bridge.ts refuses
 *    a commit missing one), and every one the needs list for this request alone (the closing-date
 *    password for work in a closed period, lib/agent/policy.ts approvalNeeds: the route refuses
 *    such work without it, and the request would end failed instead of waiting for the password).
 *  - A desktop flow: every secret it or its password questions name, and every one the needs list.
 * Less, for both, what the approver may leave empty (optionalSecretsOf: what the needs say, wave 4;
 * when they do not say, for a route the bridge's commit rule, OPTIONAL_ROUTE_SECRETS, and for a
 * desktop flow its secrets it uses only at the prompt it meets). The card asks for exactly these
 * (viewNeeds). A secret the flow needs every time (alwaysNeedsSecret) is never left empty, whatever
 * the needs say.
 */
function checkTypedSecrets(target: Target, needs: ApprovalNeeds, typed: Partial<Record<SecretKind, string>>): void {
  if (target.kind !== 'operation') return;
  const def = shellDefOf(target);
  const wanted = new Set<SecretKind>((target.op.needsSecret ?? []).filter(isSecretKind));
  if (def) {
    const flowSecrets = [...(def.needsSecret ?? []), ...(def.alwaysNeedsSecret ?? []), ...flowPasswordSecrets(def.questions), ...needs.secrets];
    for (const k of flowSecrets) if (isSecretKind(k)) wanted.add(k);
  } else if (target.op.kind === 'route') {
    for (const k of needs.secrets) if (isSecretKind(k)) wanted.add(k);
  } else {
    return;
  }
  const optional = optionalSecretsOf([...wanted], needs.optionalSecrets, target);
  const missing = [...wanted].filter((k) => !optional.includes(k) && !(typeof typed[k] === 'string' && typed[k]!.length > 0));
  if (!missing.length) return;
  const words = missing.map((k) => SECRET_WORDS[k] ?? 'a password');
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
  throw validation(`Type ${list} on the card, then approve again. Nothing was done.`);
}

/**
 * approveAgentRequest itself. `onClaim` hears the moment this call claims the request, or records
 * the first of two approvals (batchApprove, so it can tell a request this call acted on and then
 * lost track of from one it never got to).
 */
async function approveRequest(
  ctx: ServiceContext,
  id: string,
  rawInput: ApproveInput,
  opts: { atHost: boolean },
  onClaim: (() => void) | null,
): Promise<ApproveResult> {
  const person = await requirePerson(ctx);
  const atHost = opts?.atHost === true;
  const input = cleanApproveInput(rawInput);
  const db = person.ctx.db;
  const now = new Date();

  const found = await rowById(db, ctx.companyId, id);
  if (!found) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
  const target = targetOf(found);
  if (!visibleTo(person, target)) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
  const row = await settleRow(db, found, now);
  const env = await judgeEnv(person, [row], atHost, now);
  const j = await judge(row, target, env);
  if (!j.canApprove) throw new ServiceError(j.code ?? 'FORBIDDEN', j.why ?? 'You cannot approve this request.');

  if (target.kind === 'proposal') {
    if (input.grant) throw validation('Standing permission cannot be given with this approval. Approve it once instead.');
    return approveProposalCopy(person, row, target, input, atHost, onClaim);
  }

  const needs = needsFor(row, target);
  const meta = metaOf(row);
  const firstOfTwo = needs.twoPerson && !row.decidedBy;

  // The second of two approvals: the first one still counts only while its giver could still give
  // it (D8). Otherwise the request waits for two people again, and nothing runs.
  if (needs.twoPerson && row.decidedBy) {
    const lapsed = await firstApprovalLapsed(db, ctx.companyId, row.decidedBy, target, needs);
    if (lapsed) await withdrawFirstApproval(person, row, lapsed);
  }

  // Plan §7.4: once the books changed under a request it holds a new preview, and it goes ahead
  // only for someone who was shown that preview in a "the books changed" answer and says yes to it
  // again (acceptStale). Anyone else, or a yes without acceptStale, is shown it first; nothing runs.
  if (meta.staleRound > 0 && !(input.acceptStale === true && meta.staleSeen.includes(person.userId))) {
    return showStale(person, row, atHost, now);
  }

  // A desktop flow runs once, ever: its questions are answered before anything is claimed.
  const shellDef = shellDefOf(target);
  if (shellDef) checkFlowAnswers(shellDef.questions, input.answers);

  // Standing permission is checked before anything is claimed or run.
  const grant = meta.kind === 'grant' ? (input.grant ?? meta.grantAsked) : firstOfTwo ? null : (input.grant ?? null);
  if (meta.kind === 'grant' && !grant) throw validation('Say how long the standing permission lasts, in minutes, and approve again.');
  const room = meta.kind === 'grant' ? j.grantRoom : j.grantMinutesMax;
  if (grant && (room < 1 || grant.minutes > room)) {
    throw validation(
      room < 1
        ? 'Standing permission cannot be given with this approval. Approve it once instead.'
        : `Standing permission for this can last at most ${room} minutes from now. Choose a shorter time.`,
    );
  }

  // What the run will be refused without is typed before anything is claimed (the first of two
  // approvals types nothing: the second approver's run is the one that needs it).
  if (!firstOfTwo && meta.kind === 'operation') checkTypedSecrets(target, needs, input.secrets);
  if (!firstOfTwo) refuseSecretInAgentText(row, typedOnCard(input, shellDef));

  if (firstOfTwo) {
    // D8: the first of two different people. Nothing runs yet; nothing typed is kept.
    const recorded = await inTransaction(person.ctx, async (tx) => {
      const [updated] = await tx.db
        .update(agentPermissionRequests)
        .set({ decidedBy: person.userId, decidedAt: now, ...(input.note ? { note: input.note } : {}) })
        .where(
          and(
            eq(agentPermissionRequests.id, row.id),
            eq(agentPermissionRequests.status, 'pending'),
            isNull(agentPermissionRequests.decidedBy),
            gt(agentPermissionRequests.expiresAt, now),
            sameVersion(row),
          ),
        )
        .returning();
      if (!updated) return null;
      await auditDecision(tx, row, { status: 'pending', firstApprovalBy: person.userId, waitingFor: 'a second approver' });
      return updated;
    });
    if (!recorded) throw new ServiceError('CONFLICT', CHANGED_JUST_NOW_MESSAGE);
    wake(recorded);
    onClaim?.();
    return { status: 'needs_second_approver', request: await personView(person, recorded, atHost), produced: [], effects: [] };
  }

  // Claim it: only one click, by one person, ever gets past this.
  const claimed = await inTransaction(person.ctx, async (tx) => {
    const [updated] = await tx.db
      .update(agentPermissionRequests)
      .set({
        status: 'approved',
        decidedAt: now,
        decidedBy: needs.twoPerson ? row.decidedBy : person.userId,
        secondApprover: needs.twoPerson ? person.userId : null,
        note: input.note ?? (needs.twoPerson ? row.note : null),
      })
      .where(
        and(
          eq(agentPermissionRequests.id, row.id),
          eq(agentPermissionRequests.status, 'pending'),
          gt(agentPermissionRequests.expiresAt, now),
          sameVersion(row),
          needs.twoPerson && row.decidedBy ? eq(agentPermissionRequests.decidedBy, row.decidedBy) : isNull(agentPermissionRequests.decidedBy),
        ),
      )
      .returning();
    return updated ?? null;
  });
  if (!claimed) throw new ServiceError('CONFLICT', CHANGED_JUST_NOW_MESSAGE);
  wake(claimed);
  onClaim?.();
  try {
    return await carryOut({ person, row, claimed, target, meta, input, grant, shellDef, atHost, now });
  } catch (err) {
    // Claimed, then stopped on something unexpected once its run had ended (the answer could not be
    // kept, say): the request ends as failed now, its outcome unknown, rather than staying "being
    // carried out" for hours with its input in clear. When even that cannot be written, the error
    // goes on and the stuck-run rule settles it later.
    const ended = await endLostClaim(person, claimed, target).catch(() => null);
    if (!ended) throw err;
    return { status: 'failed', request: await personView(person, ended, atHost), produced: [], effects: [] };
  }
}

/** A request this approval claimed, with what the approval was given. */
interface ClaimedRun {
  person: Person;
  row: Row;
  claimed: Row;
  target: Target;
  meta: RequestMeta;
  input: ReturnType<typeof cleanApproveInput>;
  grant: RequestMeta['grantAsked'];
  shellDef: ReturnType<typeof shellDefOf>;
  atHost: boolean;
  now: Date;
}

/**
 * End, as failed with its outcome unknown and its input masked for good, a request this person's
 * approval claimed and then lost track of. Only while it is still that claim (approved, by them);
 * null when there was nothing to end (it was recorded after all, or went back to waiting).
 */
async function endLostClaim(person: Person, claimed: Row, target: Target): Promise<Row | null> {
  const settled = settledInput(claimed, target);
  const ended = await inTransaction(person.ctx, async (tx) => {
    const [updated] = await tx.db
      .update(agentPermissionRequests)
      .set({ status: 'failed', error: LOST_TRACK_MESSAGE, result: OUTCOME_UNKNOWN, input: settled.input, ...(settled.needs ? { needs: settled.needs } : {}) })
      .where(
        and(
          eq(agentPermissionRequests.id, claimed.id),
          eq(agentPermissionRequests.status, 'approved'),
          or(eq(agentPermissionRequests.decidedBy, person.userId), eq(agentPermissionRequests.secondApprover, person.userId)),
        ),
      )
      .returning();
    if (!updated) return null;
    await settleProposal(tx.db, claimed, 'failed', { decidedBy: person.userId, error: LOST_TRACK_MESSAGE });
    await auditDecision(tx, claimed, { status: 'failed', approvedBy: claimed.decidedBy, outcomeUnknown: true, error: LOST_TRACK_MESSAGE });
    return updated;
  });
  if (ended) wake(ended);
  return ended;
}

/** Carry out a claimed request: give the standing permission it asks for, or run it, and record how it ended. */
async function carryOut(c: ClaimedRun): Promise<ApproveResult> {
  const { person, row, claimed, target, meta, input, grant, shellDef, atHost, now } = c;

  // Typed on the card: never in the row, the audit trail or an error. A desktop flow's answer named
  // like a password, or to a question that asks for one, counts too.
  const typed = typedOnCard(input, shellDef);

  if (meta.kind === 'grant') {
    let made: Awaited<ReturnType<typeof createGrant>> | null = null;
    let error: string | null = null;
    try {
      made = await createGrant(person.ctx, meta.facts, {
        agentId: row.agentId,
        operation: row.operation,
        constraints: grant!.constraints,
        minutes: grant!.minutes,
        requestId: row.id,
      });
    } catch (err) {
      // Nothing but the grant was asked, so nothing else was done: never the words that send the
      // person to check the books.
      const why = err instanceof ServiceError && err.message ? err.message : GRANT_REQUEST_NOT_GIVEN_MESSAGE;
      error = scrubText(why, typed, GRANT_REQUEST_NOT_GIVEN_MESSAGE);
    }
    const grantId = made && typeof made.id === 'string' ? made.id : null;
    if (!grantId && !error) error = GRANT_REQUEST_NOT_GIVEN_MESSAGE;
    const final = await record(person, claimed, target, {
      status: grantId ? 'executed' : 'failed',
      error,
      answer: null,
      file: null,
      posted: false,
      entryIds: [],
      grantId,
      grant: grantId ? grantGiven(made, grant!, now) : null,
      grantError: null,
    });
    return { status: grantId ? 'executed' : 'failed', request: await personView(person, final, atHost), produced: [], effects: [] };
  }

  // acceptStale never reaches the run. The staleness key stored on the row is the one of the preview
  // this person approved (the agent's own, or the stale round they were shown), so the run must
  // still compare the books with it: when they changed again, that is a new round, never a run of
  // a preview nobody saw. (runApproved skips the comparison altogether when acceptStale is true.)
  const runInput: ApproveInput = { ...input, acceptStale: false };
  let r: BridgeResult;
  try {
    r = await runApproved(person.ctx, { id: row.id, agentId: row.agentId, operation: row.operation, input: storedInput(row) }, runInput, { atHost });
    if (!r || typeof r !== 'object') r = emptyResult(UNEXPECTED_MESSAGE);
  } catch (err) {
    r = emptyResult(messageOf(err));
  }
  const produced = producedOf(r);
  const hide = [...typed, ...produced.map((p) => p.value)];

  // A desktop flow has no staleness key and is never previewed by running it: anything but a
  // committed run that worked ends it as failed, for good, so it is never claimed or run again.
  // A new preview that repeats a typed secret is never stored or shown: the request ends instead.
  const previewHoldsSecret = r.mode === 'dry_run' && holdsSecret([r.preview, r.result], hide);
  if (r.mode === 'dry_run' && r.outcome === 'ok' && !shellDef && !previewHoldsSecret) {
    // The books changed since the agent asked (plan §7.4): nothing ran. The person sees what would
    // happen now and approves again with acceptStale; every approval so far is set aside.
    const back = await backToWaiting(person, claimed, target, r, hide);
    return { status: 'stale', request: await personView(person, back, atHost), produced: [], effects: [] };
  }

  // runApproved hands back a dry run only when the books changed. One that now fails or raises a
  // warning ends the request: approving the new preview could not go through either, and the
  // agent needs to know why (for a warning, to ask again with the flag).
  const changedUnder = r.mode === 'dry_run' && !shellDef;
  const ok = r.outcome === 'ok' && r.mode !== 'dry_run';
  let made: Awaited<ReturnType<typeof createGrant>> | null = null;
  let grantError: string | null = null;
  if (ok && grant) {
    try {
      made = await createGrant(person.ctx, cleanFacts(r.facts ?? meta.facts), {
        agentId: row.agentId,
        operation: row.operation,
        constraints: grant.constraints,
        minutes: grant.minutes,
        requestId: row.id,
      });
      if (!made || typeof made.id !== 'string') throw new Error('no grant');
    } catch (err) {
      // The work is done and stays done; the person is told why no standing permission came with it
      // (never "send the request again": that would enter the work twice).
      made = null;
      const why = err instanceof ServiceError && err.message ? err.message : GRANT_NOT_GIVEN_MESSAGE;
      grantError = scrubText(why, hide, GRANT_NOT_GIVEN_MESSAGE);
    }
  }
  const failed = ok
    ? null
    : previewHoldsSecret && r.outcome === 'ok'
      ? SECRET_IN_MESSAGE
      : shellDef && r.mode === 'dry_run' && r.outcome === 'ok'
        ? UNEXPECTED_MESSAGE
        : failureMessage(r);
  // An approved reveal (D6): the full values stay readable by the agent for a while after the run,
  // then are masked for good; the audit trail words what was revealed, to whom, approved by whom.
  const revealed = ok && isReveal(row);
  const final = await record(
    person,
    claimed,
    target,
    {
      status: ok ? 'executed' : 'failed',
      error: failed === null ? null : scrubText(changedUnder ? `${BOOKS_CHANGED_FAILED} ${failed}` : failed, hide, SECRET_IN_MESSAGE),
      answer: ok ? scrubDeep(stripSecrets(jsonCopy(r.result ?? null)), hide) : null,
      file: ok && r.file ? jsonCopy(r.file) : null,
      ...committedLedger(r, target),
      grantId: made ? made.id : null,
      grant: made && grant ? grantGiven(made, grant, now) : null,
      grantError,
      ...(revealed ? { revealUntil: new Date(Date.now() + REVEAL_KEPT_MS).toISOString() } : {}),
    },
    revealed ? await revealAudit(person, claimed, target) : {},
  );
  if (revealed) endRevealOnTime(person.ctx.db, final);
  return {
    status: ok ? 'executed' : 'failed',
    request: await personView(person, final, atHost),
    produced: ok ? produced : [],
    effects: Array.isArray(r.effects) ? r.effects : [],
  };
}

/**
 * The audit trail's words for an approved reveal (plan §5.9): "Revealed <which kinds of values> of
 * <record or report> to agent <name>, approved by <person>", with the kinds beside it on their own.
 * The record or report is named by its own name where one is known (recordNamesOf, with the names
 * read as they are now, namesNow), else by the request's summary (the app's own words from the
 * operation, never the agent's reason). Today namesNow knows roles, people, agents and sign-ins
 * only, so an employee's, a vendor's or a bank account's reveal is named by its summary. The agent
 * and the approvers by their names as they are now; a name that cannot be read is said plainly.
 */
async function revealAudit(person: Person, claimed: Row, target: Target): Promise<Record<string, unknown>> {
  const kinds = revealedKinds(claimed, target);
  let agentName = 'a removed agent';
  let approvers = 'a person';
  try {
    const states = await agentStates(person.ctx.db, claimed.companyId, [claimed.agentId]);
    const agent = states.get(claimed.agentId);
    if (agent?.exists) agentName = `"${oneLine(agent.name).slice(0, 100) || 'Agent'}"`;
    const ids = [claimed.decidedBy, claimed.secondApprover].filter((x): x is string => typeof x === 'string');
    const names = await personNames(person.ctx.db, ids);
    const said = ids.map((id) => oneLine(names.get(id) ?? '') || 'a person');
    if (said.length) approvers = said.join(' and ');
  } catch {
    // The words below still say what was revealed and that a person approved it.
  }
  const of = recordNamesOf(claimed, await namesNow(person, claimed, target)) ?? (oneLine(claimed.summary).slice(0, 200) || claimed.operation);
  return {
    revealed: `Revealed ${kinds} of "${of}" to agent ${agentName}, approved by ${approvers}.`,
    revealedFields: kinds,
  };
}

/**
 * The names a person knows the request's records by, read from the books as they are now, the way
 * the door named them when the agent asked (lib/agent/operate.ts requestNames; the agent's role
 * decides whether a sign-in is named, as at the door, since a new preview's line goes to the agent
 * too). So a role renamed since the ask is shown by its new name on the preview a person approves
 * again. A name the request keeps (RequestMeta.names) stands in only for a record this read finds
 * none for. Only words: a read that fails leaves the kept names, or none (the line shows the ids).
 */
async function namesNow(person: Person, row: Row, target: Target): Promise<Record<string, string> | undefined> {
  const kept = metaOf(row).names;
  if (target.kind !== 'operation') return kept;
  let now: Record<string, string> | undefined;
  try {
    now = cleanNames(await requestNames(person.ctx, row.agentId, target.op, storedInput(row)));
  } catch {
    now = undefined;
  }
  return now || kept ? { ...(kept ?? {}), ...(now ?? {}) } : undefined;
}

/**
 * The record or report a request is about, by the name a person knows it by, where one is known:
 * the names (namesNow) of the ids its path and its query name, in that order, each once. Null when
 * none is known. An account number typed into a name is masked, as the summary masks it.
 */
function recordNamesOf(row: Row, names: Record<string, string> | undefined): string | null {
  if (!names) return null;
  const input = storedInput(row);
  const ids: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) ids.push(v.trim());
  };
  for (const v of Object.values(isPlainObject(input.params) ? input.params : {})) add(v);
  for (const v of Object.values(isPlainObject(input.query) ? input.query : {})) (Array.isArray(v) ? v : [v]).forEach(add);
  const said: string[] = [];
  for (const id of ids) {
    const name = Object.prototype.hasOwnProperty.call(names, id) ? names[id] : undefined;
    if (name && !said.includes(name)) said.push(name);
  }
  return said.length ? oneLine(maskAccountsInText(said.join(', '))).slice(0, 200) || null : null;
}

/**
 * Write how an approved request ended, with its input masked for good, and the decision to the
 * audit trail (with `audit` beside it: the words of a reveal). The result column keeps the answer
 * beside what the committed run posted and the standing permission given (StoredOutcome), for
 * every reader of the request from then on.
 */
async function record(
  person: Person,
  claimed: Row,
  target: Target,
  outcome: { status: 'executed' | 'failed'; error: string | null; grantId: string | null } & StoredOutcome,
  audit: Record<string, unknown> = {},
): Promise<Row> {
  const settled = settledInput(claimed, target);
  const kept: StoredOutcome = {
    answer: outcome.answer ?? null,
    file: outcome.file ?? null,
    // Kept only when known: a view of a row without them says nothing of what was posted.
    ...(typeof outcome.posted === 'boolean' ? { posted: outcome.posted, entryIds: cleanEntryIds(outcome.entryIds) } : {}),
    grant: outcome.grant ?? null,
    grantError: outcome.grantError ?? null,
    ...(typeof outcome.revealUntil === 'string' ? { revealUntil: outcome.revealUntil } : {}),
  };
  const final = await inTransaction(person.ctx, async (tx) => {
    const [updated] = await tx.db
      .update(agentPermissionRequests)
      .set({
        status: outcome.status,
        error: outcome.error,
        result: kept,
        grantId: outcome.grantId,
        input: settled.input,
        ...(settled.needs ? { needs: settled.needs } : {}),
      })
      .where(and(eq(agentPermissionRequests.id, claimed.id), eq(agentPermissionRequests.status, 'approved')))
      .returning();
    await auditDecision(tx, claimed, {
      status: outcome.status,
      approvedBy: claimed.decidedBy,
      ...(claimed.secondApprover ? { secondApprover: claimed.secondApprover } : {}),
      grantId: outcome.grantId,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.grantError ? { grantNotGiven: outcome.grantError } : {}),
      ...audit,
    });
    return updated ?? claimed;
  });
  wake(final);
  return final;
}

/**
 * Answer "the books changed" with the preview the request holds now, without running anything, and
 * note that this person was shown it (so their next yes with acceptStale may go ahead). The note is
 * written only on the version this call read, so what is recorded as seen is what is returned.
 */
async function showStale(person: Person, row: Row, atHost: boolean, now: Date): Promise<ApproveResult> {
  const meta = metaOf(row);
  const seen = meta.staleSeen.includes(person.userId) ? meta.staleSeen : [...meta.staleSeen, person.userId];
  const stored: StoredNeeds = { ...needsOf(row), request: { ...meta, staleSeen: seen } };
  const updated = await inTransaction(person.ctx, async (tx) => {
    const [u] = await tx.db
      .update(agentPermissionRequests)
      .set({ needs: stored })
      .where(
        and(
          eq(agentPermissionRequests.id, row.id),
          eq(agentPermissionRequests.status, 'pending'),
          gt(agentPermissionRequests.expiresAt, now),
          sameVersion(row),
        ),
      )
      .returning();
    return u ?? null;
  });
  if (!updated) throw new ServiceError('CONFLICT', CHANGED_JUST_NOW_MESSAGE);
  return { status: 'stale', request: await personView(person, updated, atHost), produced: [], effects: [] };
}

/**
 * The books changed since the agent asked: back to waiting, with the new preview (and a summary
 * built from it), the needs of the new figures, and a new stale round that only the person who
 * caused it has been shown. What the approver typed or the run produced is taken out of everything
 * stored: the preview goes to the agent too.
 */
async function backToWaiting(person: Person, claimed: Row, target: Target, r: BridgeResult, hide: readonly string[]): Promise<Row> {
  const meta = metaOf(claimed);
  const facts = cleanFacts(r.facts ?? meta.facts);
  let summary = claimed.summary;
  if (target.kind === 'operation') {
    try {
      // With the records' names as they are now (namesNow), as the door named them when the agent
      // asked: "Delete role Clerk", not a uuid. Never cut (SUMMARY_MAX): a line longer than that
      // keeps the earlier one.
      const names = await namesNow(person, claimed, target);
      const line = oneLine(describeRequest(target.op, storedInput(claimed), r.result ?? undefined, names));
      if (line && line.length <= SUMMARY_MAX) summary = scrubText(line, hide, claimed.summary);
    } catch {
      // Keep the summary the request was asked with.
    }
  }
  let cls = classOf(claimed);
  let needs = needsOf(claimed);
  if (target.kind === 'operation') {
    cls = stricterClass(cls, effectiveClassOf(target.op, facts));
    try {
      const policy = await loadAgentPolicy(person.ctx, claimed.agentId);
      needs = mergeNeeds(needs, approvalNeeds(target.op, cls, facts, policy));
    } catch {
      // Without the policy the two-person rule cannot be told: ask for two (fail closed).
      needs = { ...needs, twoPerson: true };
    }
  }
  const stored: StoredNeeds = { ...needs, request: { ...meta, facts, staleRound: meta.staleRound + 1, staleSeen: [person.userId] } };
  const back = await inTransaction(person.ctx, async (tx) => {
    const [updated] = await tx.db
      .update(agentPermissionRequests)
      .set({
        status: 'pending',
        class: cls,
        summary,
        preview: r.preview ? (scrubDeep(stripSecrets(jsonCopy(r.preview)), hide) as OperationPreview) : null,
        stalenessKey: typeof r.stalenessKey === 'string' ? r.stalenessKey.slice(0, 128) : null,
        needs: stored,
        decidedBy: null,
        secondApprover: null,
        decidedAt: null,
        note: null,
        error: null,
      })
      .where(and(eq(agentPermissionRequests.id, claimed.id), eq(agentPermissionRequests.status, 'approved')))
      .returning();
    await auditDecision(tx, claimed, { status: 'pending', stale: true, approvedBy: person.userId, note: 'The books changed since the agent asked; nothing ran.' });
    return updated ?? claimed;
  });
  wake(back);
  return back;
}

/**
 * What the old path's run posted, read inside its own transaction (the entries it created carry
 * the transaction's time, lib/agent/actions.ts changesInTransaction). Read under a savepoint, so a
 * read that fails only leaves `posted` unknown (left out) and never undoes the work.
 */
async function postedInThisTransaction(tx: ServiceContext): Promise<Pick<StoredOutcome, 'posted' | 'entryIds'>> {
  try {
    return await tx.db.transaction(async (sp) => {
      const changes = await changesInTransaction({ ...tx, db: sp as unknown as DB });
      return { posted: changes.entries.length > 0, entryIds: cleanEntryIds(changes.entries.map((e) => e.journalEntryId)) };
    });
  } catch {
    return {};
  }
}

class ProposalAlreadyDecided extends Error {
  constructor(readonly proposalStatus: string) {
    super('decided');
  }
}

/**
 * Approve a request copied from an old proposal: the old way (runApprovedAgentAction, under the
 * approving person's own permissions, as Ask AI does), settling the proposal in the same
 * transaction so both screens show one state.
 */
async function approveProposalCopy(
  person: Person,
  row: Row,
  target: Extract<Target, { kind: 'proposal' }>,
  input: ApproveInput,
  atHost: boolean,
  onClaim: (() => void) | null,
): Promise<ApproveResult> {
  const now = new Date();
  const claimed = await inTransaction(person.ctx, async (tx) => {
    const [updated] = await tx.db
      .update(agentPermissionRequests)
      .set({ status: 'approved', decidedBy: person.userId, decidedAt: now, note: input.note ?? null })
      .where(and(eq(agentPermissionRequests.id, row.id), eq(agentPermissionRequests.status, 'pending'), gt(agentPermissionRequests.expiresAt, now)))
      .returning();
    return updated ?? null;
  });
  if (!claimed) throw new ServiceError('CONFLICT', CHANGED_JUST_NOW_MESSAGE);
  wake(claimed);
  onClaim?.();
  const settled = settledInput(claimed, target);

  try {
    const final = await inTransaction(person.ctx, async (tx) => {
      const [p] = await tx.db
        .select()
        .from(aiProposals)
        .where(and(eq(aiProposals.id, claimed.proposalId!), eq(aiProposals.companyId, tx.companyId)))
        .for('update');
      if (!p) throw validation('The proposal this request was copied from is gone, so it cannot be entered. Ask the agent to send it again.');
      if (p.status !== 'pending') throw new ProposalAlreadyDecided(p.status);
      const done = await runApprovedAgentAction(tx, p.payload);
      await tx.db
        .update(aiProposals)
        .set({ status: 'approved', resultRef: done.resultRef, decidedBy: person.userId, decidedAt: now })
        .where(eq(aiProposals.id, p.id));
      await writeAudit(tx, {
        action: 'update',
        entityType: 'ai_proposal',
        entityId: p.id,
        oldValues: { status: 'pending' },
        newValues: { status: 'approved', resultRef: done.resultRef },
        llmReasoning: 'Approved a proposal made by an agent (Agent requests).',
      });
      const answer = stripSecrets(maskSensitive(jsonCopy({ resultRef: done.resultRef, result: done.result ?? null }), NO_FLAGS));
      const kept: Partial<StoredOutcome> = { answer, file: null, grant: null, grantError: null, ...(await postedInThisTransaction(tx)) };
      const [updated] = await tx.db
        .update(agentPermissionRequests)
        .set({ status: 'executed', result: kept, input: settled.input, ...(settled.needs ? { needs: settled.needs } : {}) })
        .where(and(eq(agentPermissionRequests.id, claimed.id), eq(agentPermissionRequests.status, 'approved')))
        .returning();
      await auditDecision(tx, claimed, { status: 'executed', approvedBy: person.userId, proposalId: p.id });
      return updated ?? claimed;
    });
    wake(final);
    return { status: 'executed', request: await personView(person, final, atHost), produced: [], effects: [] };
  } catch (err) {
    if (err instanceof ProposalAlreadyDecided) {
      // Decided under Ask AI first: this request takes that decision; nothing more is done.
      const mirrored = statusFromProposal(err.proposalStatus);
      const [updated] = await person.ctx.db
        .update(agentPermissionRequests)
        .set({ status: mirrored, input: settled.input, ...(settled.needs ? { needs: settled.needs } : {}) })
        .where(and(eq(agentPermissionRequests.id, claimed.id), eq(agentPermissionRequests.status, 'approved')))
        .returning();
      if (updated) wake(updated);
      throw new ServiceError(
        'CONFLICT',
        `This was already decided under Ask AI > Waiting for your approval (${STATUS_WHY[mirrored].replace(/^This request /, '').replace(/\.$/, '')}), so nothing more was done.`,
      );
    }
    const message = messageOf(err);
    const final = await inTransaction(person.ctx, async (tx) => {
      const [updated] = await tx.db
        .update(agentPermissionRequests)
        .set({ status: 'failed', error: message, input: settled.input, ...(settled.needs ? { needs: settled.needs } : {}) })
        .where(and(eq(agentPermissionRequests.id, claimed.id), eq(agentPermissionRequests.status, 'approved')))
        .returning();
      await settleProposal(tx.db, claimed, 'failed', { decidedBy: person.userId, error: message });
      await auditDecision(tx, claimed, { status: 'failed', approvedBy: person.userId, error: message });
      return updated ?? claimed;
    });
    wake(final);
    return { status: 'failed', request: await personView(person, final, atHost), produced: [], effects: [] };
  }
}

export const denyAgentRequest: DenyAgentRequest = async (ctx, id, rawNote) => {
  const person = await requirePerson(ctx);
  const note = cleanNote(rawNote);
  const db = person.ctx.db;
  const now = new Date();
  const found = await rowById(db, ctx.companyId, id);
  if (!found) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
  const target = targetOf(found);
  if (!visibleTo(person, target)) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
  const row = await settleRow(db, found, now);
  if (row.status !== 'pending') throw new ServiceError('CONFLICT', STATUS_WHY[shownStatus(row, now)] || 'This request is no longer waiting.');
  // Saying no is open to anyone who could say yes to the route, and to an Admin.
  if (!person.isAdmin && routeProblem(person, target)) {
    throw forbidden('Only someone whose own access allows this, or an Admin, can deny it.');
  }
  if (person.ctx.role === 'viewer') throw forbidden(VIEW_ONLY_DENY_MESSAGE);
  const denied = await inTransaction(person.ctx, async (tx) => {
    const done = await endWaiting(tx.db, row, 'denied', { decidedBy: person.userId, decidedAt: now, secondApprover: null, note });
    if (!done) return null;
    await settleProposal(tx.db, row, 'denied', { decidedBy: person.userId });
    await auditDecision(tx, row, { status: 'denied', deniedBy: person.userId, ...(note ? { note } : {}) });
    return done;
  });
  if (!denied) throw new ServiceError('CONFLICT', CHANGED_JUST_NOW_MESSAGE);
  wake(denied);
  // Settled: where the window is no longer changes what it shows.
  return personView(person, denied, true);
};

/** Classes a batch may approve (plan §7.2): everyday entry and change, nothing riskier. */
const BATCH_CLASSES: readonly RiskClass[] = ['enter', 'change'];

export const batchApprove: BatchApprove = async (ctx, ids, opts) => {
  const person = await requirePerson(ctx);
  const atHost = opts?.atHost === true;
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === 'string'))];
  if (!wanted.length) throw validation('Choose the requests to approve.');
  // The one number the screen and the route hold a batch to as well (lib/validation/agentAccess.ts).
  if (wanted.length > BATCH_APPROVE_MAX) throw validation(`Approve at most ${BATCH_APPROVE_MAX} requests at once.`);
  const now = new Date();

  const rows: Row[] = [];
  for (const id of wanted) {
    const found = await rowById(person.ctx.db, ctx.companyId, id);
    if (!found || !visibleTo(person, targetOf(found))) throw new ServiceError('NOT_FOUND', NOT_FOUND_MESSAGE);
    rows.push(await settleRow(person.ctx.db, found, now));
  }
  // What may be batched at all is checked for every one before any is approved: one operation,
  // everyday classes, nothing that needs a password, two people, the host computer or a desktop
  // flow's answers. Whether THIS person may approve each is that one's own approval below.
  const operation = rows[0].operation;
  for (const row of rows) {
    const target = targetOf(row);
    const needs = needsFor(row, target);
    const label = `"${row.summary}"`;
    if (row.operation !== operation) throw validation('Approve together only requests for the same kind of work. Approve the others one by one.');
    if (!BATCH_CLASSES.includes(classOf(row)) || metaOf(row).kind !== 'operation') {
      throw validation(`${label} must be approved on its own: only entering and changing records can be approved together.`);
    }
    if (needs.secrets.length) throw validation(`${label} needs something typed in, so approve it on its own.`);
    if (needs.twoPerson) throw validation(`${label} needs two people to approve it, so approve it on its own.`);
    if (needs.hostOnly) throw validation(`${label} can be approved only at the host computer, so approve it on its own.`);
    if (questionsOf(target).length) throw validation(`${label} has questions to answer, so approve it on its own.`);
  }
  await refuseTogetherOverTwoPerson(person, rows);

  // Each on its own: one that is not approved, fails or finds the books changed never stops the others.
  const results: ApproveResult[] = [];
  for (const row of rows) {
    const track = { acted: false };
    try {
      results.push(await approveRequest(ctx, row.id, {}, { atHost }, () => (track.acted = true)));
    } catch (err) {
      const current = await rowById(person.ctx.db, ctx.companyId, row.id);
      results.push(batchOutcome(await personView(person, current ?? row, atHost), err, track.acted));
    }
  }
  return results;
};

/**
 * D8 for work split into pieces: one person approving many of an agent's requests in one click is
 * one approval of all of them, so each agent's chosen requests are added up (their stored amounts,
 * by size) and held to that agent's two-person amount as it is set now. When the total is above it,
 * or any chosen request's amount is not known while the amount is set, nothing is approved: the
 * person approves them one at a time from their cards. An agent whose settings cannot be read is
 * left to each approval's own judge, which refuses a removed agent's requests.
 */
async function refuseTogetherOverTwoPerson(person: Person, rows: readonly Row[]): Promise<void> {
  const byAgent = new Map<string, Row[]>();
  for (const row of rows) byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
  const states = await agentStates(person.ctx.db, person.ctx.companyId, [...byAgent.keys()]);
  for (const [agentId, group] of byAgent) {
    const policy = await loadAgentPolicy(person.ctx, agentId).catch(() => null);
    if (!policy || policy.twoPersonOver === null || policy.twoPersonOver === undefined) continue;
    const sum = batchPassesTwoPerson(policy, group.map((r) => metaOf(r).facts.amount));
    if (!sum.over) continue;
    const agent = plainName(states.get(agentId)?.name ?? 'this agent');
    const limit = moneyWords(policy.twoPersonOver);
    const chosen = group.length === 1 ? 'The chosen request' : `The ${group.length} chosen requests`;
    if (sum.unknown > 0) {
      throw validation(
        `${sum.unknown === group.length ? chosen : `${sum.unknown} of the chosen requests`} from ${agent} ${sum.unknown === 1 ? 'shows' : 'show'} no amount, ` +
          `and work by ${agent} above ${limit} needs two people to approve it, so they cannot be approved together. Approve them one at a time from their cards.`,
      );
    }
    throw validation(
      `${chosen} from ${agent} ${group.length === 1 ? 'comes to' : 'come to'} ${moneyWords(sum.total)}${group.length === 1 ? '' : ' together'}, ` +
        `more than ${limit}, the amount above which work by ${agent} needs two people to approve it. ` +
        'Approve them one at a time from their cards, reading each one, or ask a second person to look at them too.',
    );
  }
}

/** An amount as the card shows one ("$14,997.00"), or the text as given when it cannot be read. */
function moneyWords(v: string): string {
  try {
    return formatCurrency(v);
  } catch {
    return v;
  }
}

/** A stored name on one line, for a message. */
function plainName(v: string): string {
  return oneLine(v) || 'this agent';
}

/**
 * What one approval of a batch came to when it threw: read from where the request stands now, not
 * assumed failed.
 *  - Acted on by THIS call (claimed, or its first of two approvals recorded) and then lost track of:
 *    as the request stands, done, failed, back to waiting with a new preview ('stale') or waiting
 *    for a second person; otherwise 'failed', saying the outcome cannot be told. Never "nothing
 *    ran": the work may well have been done.
 *  - Anything this call never got to approve (this person may not, the agent was paused part way,
 *    someone else denied, withdrew, let it expire, is carrying it out or has done it):
 *    'not_approved' (contract: this call approved nothing and ran nothing for it), why in `error`;
 *    `request.status` says where it stands now (still waiting, mostly). The screen shows `error`
 *    after "Not approved, and nothing was done.", so one approved before this call got to it says
 *    that it was approved already and this approval added nothing (ALREADY_APPROVED_WHY), never
 *    STATUS_WHY's "was approved and done" on its own, which would read as a contradiction.
 */
function batchOutcome(view: AgentRequestForPerson, err: unknown, actedHere: boolean): ApproveResult {
  const result = (status: ApproveResult['status'], request: AgentRequestForPerson): ApproveResult => ({ status, request, produced: [], effects: [] });
  if (actedHere) {
    if (view.status === 'executed') return result('executed', view);
    if (view.status === 'failed') return result('failed', view);
    if (view.status === 'pending' && view.stale) return result('stale', view);
    if (view.status === 'pending' && view.needs?.twoPerson && view.decidedByName) return result('needs_second_approver', view);
    return result('failed', { ...view, error: LOST_TRACK_MESSAGE });
  }
  const why =
    view.status === 'pending'
      ? (view.cannotApproveWhy ?? messageOf(err))
      : (ALREADY_APPROVED_WHY[view.status] ?? (STATUS_WHY[view.status] || messageOf(err)));
  return result('not_approved', { ...view, error: why });
}

/** Why a batch did not approve a request someone approved before it got there (batchOutcome). */
const ALREADY_APPROVED_WHY: Partial<Record<Status, string>> = {
  approved: 'It was already approved, and it is being carried out right now. This approval added nothing.',
  executed: 'It was already approved before this approval got to it, and it was done then. This approval added nothing.',
  failed:
    'It was already approved before this approval got to it, and that time the work could not be done. Open it to see why. This approval added nothing.',
};

export const expireRequests: ExpireRequests = async (ctx, now = new Date()) => {
  if (!ctx || typeof ctx.companyId !== 'string' || !UUID_RE.test(ctx.companyId)) return 0;
  const db = await writableDb(ctx);
  return settleCompany(db, ctx.companyId, now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date());
};
