/**
 * Agent requests (the approval center, plan 7.2): the words and small rules the page and its card
 * share. What a request needs from the approver, how old it is, which requests may be approved
 * together, the standing-permission choices of "Approve similar…".
 *
 * Pure: no React, no fetch, no Node. The page, the card and the tests use the one copy. The server
 * decides who may approve what and holds every limit (lib/services/agentRequests.ts,
 * agentGrants.ts); nothing here widens what a person may do, it only says it and pre-fills forms
 * with the narrowest choice.
 */
import type { AgentRequestForPerson, AgentRequestView, ApproveInput, FlowQuestion, OperationPreview } from '@/lib/agent/contract';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import type {
  ApprovalNeeds,
  EffectPreview,
  GrantConstraints,
  RequestStatus,
  RiskClass,
  SecretKind,
} from '@/lib/agent/operations/types';

// ---------------------------------------------------------------------------
// Text as it is shown
// ---------------------------------------------------------------------------

/**
 * Invisible formatting characters (direction marks, zero-width characters) and broken pairs. A
 * right-to-left mark in an agent's words or a file name can make "Invoice[U+202E]fdp.exe" read as
 * "Invoiceexe.pdf", so nothing on this page shows them. Built at run time: the pattern needs the
 * Unicode flag, which the project's TypeScript target does not allow in a literal.
 */
const INVISIBLE = new RegExp('[\\p{Cf}\\p{Cs}]', 'gu');

/** Text as the page shows it: a string, without invisible formatting characters. Never HTML. */
export function plain(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(INVISIBLE, '');
}

/** The agent's reason as shown: its own words, line breaks kept, capped so a long one cannot bury the card. */
export function reasonText(reason: string | null): string {
  const s = plain(reason).trim();
  return s.length > 2000 ? `${s.slice(0, 1999)}…` : s;
}

/** "dueDate" → "Due date", "customer_id" → "Customer id". */
export function fieldLabel(field: string): string {
  const words = plain(field)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.\-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** A before or after value of a record change, as one short line. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return plain(v);
  try {
    const s = JSON.stringify(v);
    return plain(s.length > 300 ? `${s.slice(0, 299)}…` : s);
  } catch {
    return '(not shown)';
  }
}

/** "create" → "New", "update" → "Changed" … for the heading of one record's changes. */
export function recordHeading(action: string, kind: string): string {
  const a = plain(action).toLowerCase();
  const word =
    a === 'create' || a === 'insert' || a === 'add'
      ? 'New'
      : a === 'update' || a === 'edit' || a === 'change'
        ? 'Changed'
        : a === 'delete' || a === 'remove'
          ? 'Deleted'
          : a === 'void'
            ? 'Voided'
            : fieldLabel(a) || 'Changed';
  const what = fieldLabel(kind).toLowerCase();
  return what ? `${word} ${what}` : word;
}

// ---------------------------------------------------------------------------
// Status, age, amount
// ---------------------------------------------------------------------------

export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'Waiting',
  approved: 'Waiting for a second person',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Taken back by the agent',
  failed: 'Did not go through',
  executed: 'Done',
};

export const STATUS_TONES: Record<RequestStatus, 'warning' | 'info' | 'success' | 'danger' | 'neutral' | 'void'> = {
  pending: 'warning',
  approved: 'info',
  denied: 'neutral',
  expired: 'void',
  cancelled: 'void',
  failed: 'danger',
  executed: 'success',
};

/**
 * Still waiting for a person: asked, or approved by the first of two people (D8) and waiting for
 * the second. Whether THIS person may answer it is the server's canApprove.
 */
export function isWaiting(status: RequestStatus): boolean {
  return status === 'pending' || status === 'approved';
}

/** The status filter of the list: one status, or every request. */
export type StatusFilter = RequestStatus | 'all';

/** Waiting first: it is what the page is for. */
export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'pending', label: 'Waiting' },
  { value: 'executed', label: 'Done' },
  { value: 'failed', label: 'Did not go through' },
  { value: 'approved', label: 'Waiting for a second person' },
  { value: 'denied', label: 'Denied' },
  { value: 'expired', label: 'Expired' },
  { value: 'cancelled', label: 'Taken back by the agent' },
  { value: 'all', label: 'All requests' },
];

/** "Just now", "5 minutes ago", "3 days ago". Empty for a time that cannot be read. */
export function ageText(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'Just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** "$1,250.00", or the text as it came when it is not an amount. Empty for none. */
export function amountText(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  if (!Number.isFinite(n)) return plain(amount);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

/** "15 minutes", "1 hour", "1 hour 30 minutes". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h === 0 ? '' : h === 1 ? '1 hour' : `${h} hours`;
  const mins = m === 0 ? '' : m === 1 ? '1 minute' : `${m} minutes`;
  return [hours, mins].filter(Boolean).join(' ') || '0 minutes';
}

/** "3:45 PM" in this computer's own way of writing times. */
export function clockTime(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// What an approval needs
// ---------------------------------------------------------------------------

/** What each secret is called on the card. A Record, so a new kind fails to compile until it is named. */
export const SECRET_LABELS: Record<SecretKind, string> = {
  closing_password: 'Closing date password',
  file_password: 'Company file password',
  backup_password: 'Backup file password',
  archive_credentials: 'Password of the protected archive',
  new_user_password: "The new user's password",
  mail_password: 'Email server password',
  portal_password: 'Employee portal password',
  recovery_key: 'Recovery key',
  file_key: 'File key',
  capability_link: 'Sharing link',
};

export function isSecretKind(v: unknown): v is SecretKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SECRET_LABELS, v);
}

const FLAG_NEEDS: Record<NonNullable<ApprovalNeeds['flag']>, string> = {
  sensitivePayroll: 'Needs someone who may see full payroll data',
  fullAccountNumbers: 'Needs someone who may see full account numbers',
  closedPeriod: 'Needs someone who may change the closed period',
};

/** The words for what approving needs, most limiting first. The list and the card show the same ones. */
export function needsLabels(needs: ApprovalNeeds | null | undefined): string[] {
  if (!needs) return [];
  const out: string[] = [];
  if (needs.fileAdmin) out.push('Needs an Admin of every company in this file');
  else if (needs.admin) out.push('Needs an Admin');
  const flags = needs.flags?.length ? needs.flags : needs.flag ? [needs.flag] : [];
  for (const f of flags) if (FLAG_NEEDS[f] && !out.includes(FLAG_NEEDS[f])) out.push(FLAG_NEEDS[f]);
  if (needs.secrets?.length) out.push('Needs a password');
  if (needs.twoPerson) out.push('Needs two people');
  if (needs.hostOnly) out.push('Only at the host computer');
  return out;
}

/**
 * The questions a desktop flow would have asked in a message box (plan 5.5). Taken from Ironbooks'
 * own list of desktop operations (lib/agent/operations/shell.ts), looked up by the request's
 * operation: never from anything stored with the request, which an agent's input could have
 * shaped (an agent must not be able to add a question, or word one so that it asks for a
 * password). Only a request to run something has them: a request for standing permission runs
 * nothing.
 */
export function flowQuestionsOf(r: Pick<AgentRequestView, 'kind' | 'operation'>): FlowQuestion[] {
  if (r.kind !== 'operation') return [];
  const def = SHELL_OPERATIONS.find((o) => o.id === r.operation);
  if (!def) return [];
  const seen = new Set<string>();
  const out: FlowQuestion[] = [];
  for (const q of def.questions) {
    if (!isFlowQuestion(q) || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
  }
  return out;
}

const QUESTION_KINDS = ['yes_no', 'choice', 'text', 'path', 'password'];

function isFlowQuestion(q: unknown): q is FlowQuestion {
  if (!q || typeof q !== 'object') return false;
  const o = q as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 100) return false;
  if (typeof o.text !== 'string' || typeof o.kind !== 'string' || !QUESTION_KINDS.includes(o.kind)) return false;
  if (o.kind === 'choice' && !(Array.isArray(o.choices) && o.choices.length > 0 && o.choices.every((c) => typeof c === 'string'))) return false;
  if (o.secret !== undefined && !isSecretKind(o.secret)) return false;
  return true;
}

/** One password field of the card: a secret the approver types for this one run. */
export interface SecretField {
  kind: SecretKind;
  label: string;
}

/**
 * The password fields of a card: every secret the approval needs, and every password question of
 * a desktop flow that names its secret (its answer goes with the secrets, never with the answers,
 * so it is never stored). `unanswerable` is set when a flow asks for a password without saying
 * which one: it cannot be passed on safely, so the request cannot be approved here.
 *
 * A field is always named by Ironbooks' own words for that kind of secret (SECRET_LABELS), never
 * by a question's text: the card says plainly which password it is, and nothing else can change
 * that wording into a request for some other password.
 */
export function secretFieldsOf(r: Pick<AgentRequestView, 'kind' | 'operation' | 'needs'>): { fields: SecretField[]; unanswerable: boolean } {
  const fields: SecretField[] = [];
  for (const kind of r.needs?.secrets ?? []) {
    if (isSecretKind(kind) && !fields.some((f) => f.kind === kind)) fields.push({ kind, label: SECRET_LABELS[kind] });
  }
  let unanswerable = false;
  for (const q of flowQuestionsOf(r)) {
    if (q.kind !== 'password') continue;
    if (!q.secret) {
      unanswerable = true;
      continue;
    }
    if (!fields.some((f) => f.kind === q.secret)) fields.push({ kind: q.secret, label: SECRET_LABELS[q.secret] });
  }
  return { fields, unanswerable };
}

// ---------------------------------------------------------------------------
// Whether Ironbooks tried the request out
// ---------------------------------------------------------------------------

/**
 * The note Ironbooks stored when it described a request instead of trying it out (the bridge
 * answers `routePreview: { ran: false, note }` for an operation that cannot be run and rolled
 * back). Null when the request was tried, or has no preview at all.
 */
export function notTriedNote(preview: OperationPreview | null | undefined): string | null {
  const rp = preview?.routePreview;
  if (!rp || typeof rp !== 'object' || (rp as { ran?: unknown }).ran !== false) return null;
  const note = (rp as { note?: unknown }).note;
  return typeof note === 'string' ? plain(note).trim() : '';
}

/**
 * Whether the preview comes from a real trial run (done, then rolled back), so what it shows of
 * the ledger is known. A preview without a ledger part was never worked out: that is "not known",
 * never "nothing is posted".
 */
export function previewTried(preview: OperationPreview | null | undefined): boolean {
  return !!preview && preview.ledger !== null && preview.ledger !== undefined && notTriedNote(preview) === null;
}

/** An effect the operation may have, named from its description only: who, where or what is not known yet. */
export function isDeclaredEffect(e: EffectPreview): boolean {
  return (e.detail as Record<string, unknown> | undefined)?.declared === true;
}

// ---------------------------------------------------------------------------
// What an approved run made
// ---------------------------------------------------------------------------

const ENTRY_ID_KEYS = ['postedEntryId', 'journalEntryId'];

/**
 * The ledger entries an approved run posted, from the run's own answer (`request.result`): the
 * entry ids the created or changed record names (postedEntryId, journalEntryId), at the top of the
 * answer or one level in (`{ invoice: { … } }`), and a journal entry's own id. Never from the
 * preview: that came from a trial run that was rolled back, so its entries do not exist. Only
 * well-formed ids, at most ten.
 */
export function postedEntryIds(r: Pick<AgentRequestView, 'operation' | 'result'>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (out.length < 10 && typeof v === 'string' && UUID_RE.test(v) && !out.includes(v)) out.push(v);
  };
  const look = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 20)) look(x, depth);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const k of ENTRY_ID_KEYS) add(o[k]);
    if (depth > 0) for (const x of Object.values(o)) look(x, depth - 1);
  };
  look(r.result, 1);
  // A journal entry is its own entry: POST and PUT /api/journal-entries answer `{ entry }`.
  if (/^journal-entries\.(create|update|replace)$/.test(r.operation) && r.result && typeof r.result === 'object') {
    const res = r.result as Record<string, unknown>;
    const entry = res.entry && typeof res.entry === 'object' ? (res.entry as Record<string, unknown>) : res;
    add(entry.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effects: what leaves the computer
// ---------------------------------------------------------------------------

/**
 * A domain as it is really spelled. A name with letters from other alphabets ("аcme.com" with a
 * Cyrillic "а") looks the same as the familiar one on screen, so it is shown in its plain-letter
 * form ("xn--cme-…"), which never looks like it. When that form cannot be worked out the name is
 * kept as it came, and isUnusualDomain still flags it.
 */
export function asciiDomain(domain: string): string {
  const d = plain(domain).trim().toLowerCase();
  if (!/[^\x00-\x7f]/.test(d) || /[/?#\\:@\s]/.test(d)) return d;
  try {
    const host = new URL(`http://${d}`).hostname;
    return /^[a-z0-9.-]+$/.test(host) ? host : d;
  } catch {
    return d;
  }
}

/** A domain with letters from other alphabets, which can pass for a familiar one (plan 11.2). */
export function isUnusualDomain(domain: string): boolean {
  return /[^\x00-\x7f]/.test(domain) || domain.split('.').some((label) => label.startsWith('xn--'));
}

/** "billing@acme.com" or "Acme <billing@acme.com>" → "acme.com". Null when it is not an address. */
export function domainOf(mailbox: string): string | null {
  const s = plain(mailbox).trim();
  const angle = /<([^<>]*)>\s*$/.exec(s);
  const addr = (angle ? angle[1] : s).trim();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const domain = addr
    .slice(at + 1)
    .replace(/[>\s"',;)]+$/g, '')
    .toLowerCase();
  return domain ? asciiDomain(domain) : null;
}

function mailboxesIn(e: EffectPreview, keys: string[]): string[] {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  return keys.flatMap((k) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : [])).filter((x): x is string => typeof x === 'string');
}

function domainsOf(boxes: string[]): string[] {
  const out: string[] = [];
  for (const b of boxes) {
    const dom = domainOf(b);
    if (dom && !out.includes(dom)) out.push(dom);
  }
  return out;
}

/** Every domain an email effect goes to (To, Cc and hidden copies), in order, each once. */
export function emailDomains(e: EffectPreview): string[] {
  const boxes = mailboxesIn(e, ['to', 'cc', 'bcc']);
  // A preview without the detail: the addresses in its one-line summary.
  if (boxes.length === 0 && !isDeclaredEffect(e)) boxes.push(...(plain(e.summary).match(/[^\s<>(),:;"']+@[^\s<>(),:;"']+/g) ?? []));
  return domainsOf(boxes);
}

/**
 * Where replies to an email go, when that is somewhere other than the recipients' domains: an
 * outsider who got a "Reply-To" in reads every answer, even though the email went to the right place.
 */
export function replyToDomains(e: EffectPreview): string[] {
  const to = emailDomains(e);
  return domainsOf(mailboxesIn(e, ['replyTo'])).filter((d) => !to.includes(d));
}

/** The computer a network effect contacts, when the preview names it. */
export function networkHost(e: EffectPreview): string | null {
  const host = (e.detail as Record<string, unknown> | undefined)?.host;
  const s = typeof host === 'string' ? plain(host).trim() : '';
  return s ? asciiDomain(s) : null;
}

// ---------------------------------------------------------------------------
// Approving several at once (plan 7.2, 11.2)
// ---------------------------------------------------------------------------

/** Only new entries and changes may be approved together; everything else is read one by one. */
export const BATCH_CLASSES: readonly RiskClass[] = ['enter', 'change'];

/**
 * Most requests one batch approval sends. The server holds the same limit (BATCH_APPROVE_MAX in
 * lib/validation/agentAccess.ts); it is repeated here so the page does not pull in the server's
 * request checks.
 */
export const BATCH_MAX = 100;

/**
 * Why this request cannot be chosen for approving together, or null when it can. `operation` is
 * the operation of the requests already chosen (they must all be the same).
 */
export function batchBlock(r: AgentRequestForPerson, operation: string | null): string | null {
  if (r.status !== 'pending') return 'Only requests that are still waiting can be approved.';
  if (!r.canApprove) return plain(r.cannotApproveWhy) || 'You cannot approve this one.';
  if (r.kind !== 'operation') return 'Standing permission is given one request at a time. Open it to answer.';
  if (!BATCH_CLASSES.includes(r.class)) return 'Only new entries and changes can be approved together. Open this one to approve it on its own.';
  if (r.needs?.secrets?.length) return 'This one needs a password. Open it to approve it on its own.';
  if (flowQuestionsOf(r).length) return 'This one has questions to answer. Open it to approve it on its own.';
  // Approving many at once rests on each preview: one Ironbooks could not try out is read alone.
  if (!previewTried(r.preview)) return 'Ironbooks could not try this one ahead of time. Open it and read it before you approve it on its own.';
  if (operation && r.operation !== operation) return 'Only requests for the same kind of work can be approved together.';
  return null;
}

/**
 * The chosen requests that may still be approved together, in list order: the first that still
 * qualifies sets the kind of work, and anything that no longer qualifies (answered meanwhile,
 * moved to a stricter kind of work, gone from the list) drops out. At most BATCH_MAX.
 */
export function batchChoice(requests: readonly AgentRequestForPerson[], selected: readonly string[]): AgentRequestForPerson[] {
  const picked = requests.filter((r) => selected.includes(r.id));
  const operation = picked.find((r) => batchBlock(r, null) === null)?.operation ?? null;
  return picked.filter((r) => batchBlock(r, operation) === null).slice(0, BATCH_MAX);
}

// ---------------------------------------------------------------------------
// Standing permission: "Approve similar…" (plan 4.4)
// ---------------------------------------------------------------------------

/** Whether the card offers standing permission at all. */
export function canGiveGrant(r: Pick<AgentRequestForPerson, 'grantMinutesMax' | 'needs'>): boolean {
  return r.grantMinutesMax > 0 && r.needs?.grantable !== 'no';
}

/**
 * How long standing permission may last: the usual steps below the most this person may give,
 * then that most itself, and what the agent asked for when it is in between. Never above `max`.
 */
export function durationOptions(max: number, asked: number | null, now: Date): Array<{ minutes: number; label: string }> {
  const most = Math.max(0, Math.floor(max));
  if (most === 0) return [];
  const wanted = asked && asked > 0 ? Math.floor(asked) : null;
  const steps = new Set<number>([15, 30, 60, 120, 240].filter((m) => m < most));
  if (wanted && wanted < most) steps.add(wanted);
  steps.add(most);
  return [...steps]
    .sort((a, b) => a - b)
    .map((minutes) => {
      const until = clockTime(new Date(now.getTime() + minutes * 60_000));
      const label = minutes === most && most > 240 ? `Until ${until}` : `${durationLabel(minutes)} (until ${until})`;
      return { minutes, label: wanted && minutes === wanted ? `${label}, as the agent asked` : label };
    });
}

/** The ticks and values of the "Approve similar…" form. Strings are as typed. */
export interface GrantForm {
  minutes: number;
  amountOn: boolean;
  amount: string;
  /** Offered only when the request names a customer, vendor or other name. */
  entityIds: string[];
  entitiesOn: boolean;
  accountIds: string[];
  accountsOn: boolean;
  /** Offered only when the request has a date. */
  datesOffered: boolean;
  datesOn: boolean;
  dateFrom: string;
  dateTo: string;
  usesOn: boolean;
  uses: string;
  /** Change many at once ('capped'): a count limit is always set. */
  countRequired: boolean;
  /** Offered when it is required, or the agent asked with one. */
  countOffered: boolean;
  countOn: boolean;
  count: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_KEYS = ['customerId', 'vendorId', 'employeeId', 'entityId', 'nameId', 'payeeId', 'otherNameId'];
const ACCOUNT_KEYS = ['accountId', 'bankAccountId', 'depositToAccountId', 'paymentAccountId', 'fromAccountId', 'toAccountId'];
const DATE_KEYS = ['date', 'txnDate', 'payDate', 'depositDate', 'paymentDate'];

/** Ids found at the top of the request's body under these names. */
function idsIn(body: unknown, keys: string[]): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const b = body as Record<string, unknown>;
  const out: string[] = [];
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && UUID_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

function hasDate(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return DATE_KEYS.some((k) => typeof b[k] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(b[k] as string));
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The first and last day of `now`'s month, as calendar days. */
export function monthOf(now: Date): { dateFrom: string; dateTo: string } {
  return { dateFrom: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
}

/** "Nov 1 to Nov 30, 2026". */
export function dayRange(from: string, to: string): string {
  const day = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const a = day(from);
  const b = day(to);
  const short = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${short(a)} to ${short(b)}, ${b.getFullYear()}`;
}

/** A count from the request: the bulk preview's records, when it has any. */
function countOf(r: AgentRequestForPerson): number | null {
  const n = r.preview?.records?.length ?? 0;
  return n > 0 ? n : null;
}

/**
 * The form as it opens: every limit that fits this request ticked, filled from the request (or
 * from what the agent asked for, on a request for standing permission). Narrowest first: a person
 * widens it by unticking, never by default.
 */
export function initialGrantForm(r: AgentRequestForPerson, now: Date): GrantForm {
  const asked = r.kind === 'grant' ? r.grantAsked : null;
  const c: GrantConstraints = asked?.constraints ?? {};
  const options = durationOptions(r.grantMinutesMax, asked?.minutes ?? null, now);
  const preferred = asked?.minutes ? Math.min(Math.floor(asked.minutes), r.grantMinutesMax) : Math.min(60, r.grantMinutesMax);
  const minutes = options.find((o) => o.minutes === preferred)?.minutes ?? options[0]?.minutes ?? 0;
  const body = r.input?.body;
  const entityIds = c.entityIds?.length ? [...c.entityIds] : idsIn(body, ENTITY_KEYS);
  const accountIds = c.accountIds?.length ? [...c.accountIds] : idsIn(body, ACCOUNT_KEYS);
  const month = monthOf(now);
  const datesOffered = Boolean(c.dateFrom || c.dateTo) || hasDate(body);
  const amount = c.maxAmount ?? r.amount ?? '';
  const capped = r.needs?.grantable === 'capped';
  const count = c.maxCount ?? countOf(r);
  return {
    minutes,
    amountOn: amount !== '',
    amount: amount ? String(amount) : '',
    entityIds,
    entitiesOn: entityIds.length > 0,
    accountIds,
    accountsOn: accountIds.length > 0,
    datesOffered,
    datesOn: datesOffered,
    dateFrom: c.dateFrom ?? month.dateFrom,
    dateTo: c.dateTo ?? month.dateTo,
    usesOn: true,
    uses: String(c.maxUses ?? 10),
    countRequired: capped,
    countOffered: capped || c.maxCount !== undefined,
    countOn: capped || c.maxCount !== undefined,
    count: count ? String(count) : '',
  };
}

/** "$1,250.50" or "1250.5" → "1250.50"; null when it is not an amount above zero. */
export function amountValue(text: string): string | null {
  const s = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) return null;
  return Number(s).toFixed(2);
}

function wholeNumber(text: string, min: number, max: number): number | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** The grant to send, or what to fix first (in plain words). */
export function grantFromForm(form: GrantForm, max: number): { grant: NonNullable<ApproveInput['grant']> } | { error: string } {
  if (!(form.minutes > 0) || form.minutes > max) return { error: 'Choose for how long.' };
  const constraints: GrantConstraints = {};
  if (form.amountOn) {
    const a = amountValue(form.amount);
    if (!a) return { error: 'Type the largest amount, like 500 or 500.00, or untick the amount limit.' };
    constraints.maxAmount = a;
  }
  if (form.entitiesOn && form.entityIds.length) constraints.entityIds = [...form.entityIds];
  if (form.accountsOn && form.accountIds.length) constraints.accountIds = [...form.accountIds];
  if (form.datesOffered && form.datesOn) {
    constraints.dateFrom = form.dateFrom;
    constraints.dateTo = form.dateTo;
  }
  if (form.usesOn) {
    const n = wholeNumber(form.uses, 1, 10_000);
    if (n === null) return { error: 'Type how many times, from 1 to 10,000, or untick that limit.' };
    constraints.maxUses = n;
  }
  if (form.countRequired || (form.countOffered && form.countOn)) {
    const n = wholeNumber(form.count, 1, 100_000);
    if (n === null) {
      return { error: form.countRequired ? 'Type the most records one request may change.' : 'Type the most records one request may change, or untick that limit.' };
    }
    constraints.maxCount = n;
  }
  return { grant: { minutes: form.minutes, constraints } };
}

/** The limits of standing permission, one line each ("Amount at or below $500.00"). */
export function constraintLines(c: GrantConstraints | null | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.maxAmount) out.push(`Amount at or below ${amountText(c.maxAmount)}`);
  if (c.entityIds?.length) out.push(c.entityIds.length === 1 ? 'Only for one customer, vendor or name' : `Only for ${c.entityIds.length} customers, vendors or names`);
  if (c.accountIds?.length) out.push(c.accountIds.length === 1 ? 'Only for one account' : `Only for ${c.accountIds.length} accounts`);
  if (c.dateFrom && c.dateTo) out.push(`Dated ${dayRange(c.dateFrom, c.dateTo)}`);
  else if (c.dateFrom) out.push(`Dated on or after ${plain(c.dateFrom)}`);
  else if (c.dateTo) out.push(`Dated on or before ${plain(c.dateTo)}`);
  if (c.maxUses) out.push(c.maxUses === 1 ? 'Once' : `At most ${c.maxUses} times`);
  if (c.maxCount) out.push(`At most ${c.maxCount} records each time`);
  return out;
}
