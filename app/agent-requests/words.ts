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
import { encodeSecretParts } from '@/lib/agent/guards';
import { BATCH_APPROVE_MAX } from '@/lib/validation/agentAccess';
import { Money, formatCurrency, toAmountString, toDecimal } from '@/lib/money';
import type {
  ApprovalNeeds,
  EffectPreview,
  GrantConstraints,
  RecordDiff,
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

/**
 * What each status is called. 'approved' is the short time a request is being carried out (the
 * service keeps a first-of-two approval 'pending', with the first approver named): statusLabel says
 * "Waiting for a second person" for that one.
 */
export const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: 'Waiting',
  approved: 'Approved, being carried out',
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

/** A waiting request one person already approved: two people must approve it (D8). */
export function waitsForSecondPerson(r: Pick<AgentRequestView, 'status' | 'decidedByName'>): boolean {
  return r.status === 'pending' && !!plain(r.decidedByName).trim();
}

/** The status as the list and the card say it. */
export function statusLabel(r: Pick<AgentRequestView, 'status' | 'decidedByName'>): string {
  if (waitsForSecondPerson(r)) return 'Waiting for a second person';
  return STATUS_LABELS[r.status] ?? plain(r.status);
}

export function statusTone(r: Pick<AgentRequestView, 'status' | 'decidedByName'>): (typeof STATUS_TONES)[RequestStatus] {
  if (waitsForSecondPerson(r)) return 'info';
  return STATUS_TONES[r.status] ?? 'neutral';
}

/**
 * Still waiting for a person: asked, or approved by the first of two people (D8) and waiting for
 * the second (both are 'pending'). 'approved' is being carried out: nobody answers it any more.
 * Whether THIS person may answer it is the server's canApprove.
 */
export function isWaiting(status: RequestStatus): boolean {
  return status === 'pending';
}

/** The status filter of the list: one status, or every request. */
export type StatusFilter = RequestStatus | 'all';

/** Waiting first: it is what the page is for. */
export const STATUS_FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'pending', label: 'Waiting' },
  { value: 'executed', label: 'Done' },
  { value: 'failed', label: 'Did not go through' },
  { value: 'approved', label: 'Approved, being carried out' },
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

/** A decimal amount as text ("1250.00"), or null when it is not one. Through lib/money.ts, never a JavaScript number. */
function moneyOf(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  try {
    return toAmountString(s);
  } catch {
    return null;
  }
}

/** "$1,250.00", or the text as it came when it is not an amount. Empty for none. */
export function amountText(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const m = moneyOf(amount);
  if (m === null) return plain(amount);
  return formatCurrency(m);
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
  archive_credentials: 'Sign-in for the protected backup',
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

type NeedFlag = NonNullable<ApprovalNeeds['flag']>;

const FLAG_NEEDS: Record<NeedFlag, string> = {
  sensitivePayroll: 'Needs someone who may see full payroll data',
  fullAccountNumbers: 'Needs someone who may see full account numbers',
  closedPeriod: 'Needs someone who may change the closed period',
};

/** What the approver must also be allowed, in the words of "… who may also …". */
const FLAG_MAY: Record<NeedFlag, string> = {
  closedPeriod: 'change the closed period',
  sensitivePayroll: 'see full payroll data',
  fullAccountNumbers: 'see full account numbers',
};

/** Every flag the approver needs (`flags`; `flag` alone from an older server), each once. */
export function needFlags(needs: ApprovalNeeds | null | undefined): NeedFlag[] {
  if (!needs) return [];
  const list = needs.flags?.length ? needs.flags : needs.flag ? [needs.flag] : [];
  const out: NeedFlag[] = [];
  for (const f of list) if (Object.prototype.hasOwnProperty.call(FLAG_NEEDS, f) && !out.includes(f)) out.push(f);
  return out;
}

/** The words for what approving needs, most limiting first. The list and the card show the same ones. */
export function needsLabels(needs: ApprovalNeeds | null | undefined): string[] {
  if (!needs) return [];
  const out: string[] = [];
  if (needs.fileAdmin) out.push('Needs an Admin of every company in this file');
  else if (needs.admin) out.push('Needs an Admin');
  for (const f of needFlags(needs)) if (!out.includes(FLAG_NEEDS[f])) out.push(FLAG_NEEDS[f]);
  if (needs.secrets?.length) out.push('Needs a password');
  if (needs.twoPerson) out.push('Needs two people');
  if (needs.hostOnly) out.push('Only at the host computer');
  return out;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Who may approve, as one or more sentences for the card (plan 4.5): the approver must be allowed to
 * do the work themselves, with every flag it needs (needs.flags), and an Admin where the class asks
 * for one. The server decides; this only says it.
 */
export function approverLines(needs: ApprovalNeeds | null | undefined): string[] {
  if (!needs) return [];
  const flags = joinAnd(needFlags(needs).map((f) => FLAG_MAY[f]));
  const admin = needs.fileAdmin ? 'An Admin of every company in this file' : needs.admin ? 'An Admin' : null;
  const first = admin
    ? `${admin}${flags ? ` who may also ${flags}` : ''} can approve this.`
    : flags
      ? `Someone whose own role allows this work, and who may also ${flags}, can approve this.`
      : 'Someone whose own role allows this work can approve this.';
  const out = [first];
  if (needs.twoPerson) out.push('Two different people must approve it before it runs.');
  if (needs.hostOnly) out.push("It can be approved only at the host computer's own window.");
  return out;
}

/**
 * Why nobody can give standing permission for this request, Admins included, or null: the server
 * refuses it for every operation approved only at the host computer or only by an Admin of every
 * company in the file (lib/services/agentGrants.ts), since a grant would let later requests run
 * without that approval.
 */
export function grantNeverHere(needs: ApprovalNeeds | null | undefined): string | null {
  if (needs?.hostOnly) return 'Standing permission cannot be given for this: it is approved one request at a time, at the host computer.';
  if (needs?.fileAdmin) return 'Standing permission cannot be given for this: an Admin of every company in this file approves it one request at a time.';
  return null;
}

/**
 * What the card says about standing permission for this request (plan 4.4, D3, D5): never for some
 * kinds of work (nor for anything approved only at the host computer or only by the file's Admin),
 * only from an Admin for outside sends (needs.grantAdminOnly), short or capped for others. Null
 * when there is nothing beyond the form itself to say.
 */
export function grantRuleLine(r: Pick<AgentRequestForPerson, 'needs' | 'grantMinutesMax'>): string | null {
  const needs = r.needs;
  if (!needs) return null;
  const never = grantNeverHere(needs);
  if (never) return never;
  if (needs.grantable === 'no') return 'Standing permission cannot be given for this kind of work: the agent asks each time.';
  const short = needs.grantable === 'short' ? ', and for at most 30 minutes' : '';
  if (needs.grantAdminOnly) {
    return r.grantMinutesMax > 0
      ? `Only an Admin can give standing permission for this${short}.`
      : `Only an Admin can give standing permission for this${short}. You can still approve it once.`;
  }
  if (needs.grantable === 'short') return 'Standing permission for this lasts at most 30 minutes.';
  if (needs.grantable === 'capped') return 'Standing permission for this always limits how many records one request may change.';
  return null;
}

// ---------------------------------------------------------------------------
// A desktop operation's questions (plan 5.5)
// ---------------------------------------------------------------------------

/** Most questions one card asks; the desktop flows have three at most. */
const MAX_QUESTIONS = 20;

/**
 * The questions a desktop flow would have asked in a message box (plan 5.5), as the server sent
 * them with the request (AgentRequestForPerson.questions): Ironbooks' own list of desktop
 * operations, looked up by the request's operation on the server. Never from the preview or the
 * agent's input, which an agent could shape (an agent must not be able to add a question, or word
 * one so that it asks for a password). Only a request to run something has them: a request for
 * standing permission runs nothing. A question that is not well formed is left out.
 */
export function flowQuestionsOf(r: Pick<AgentRequestForPerson, 'kind' | 'questions'>): FlowQuestion[] {
  if (r.kind !== 'operation' || !Array.isArray(r.questions)) return [];
  const seen = new Set<string>();
  const out: FlowQuestion[] = [];
  for (const q of r.questions) {
    if (!isFlowQuestion(q) || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

const QUESTION_KINDS = ['yes_no', 'choice', 'text', 'path', 'password'];

function isFlowQuestion(q: unknown): q is FlowQuestion {
  if (!q || typeof q !== 'object') return false;
  const o = q as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 100) return false;
  if (typeof o.text !== 'string' || o.text.length > 1000 || typeof o.kind !== 'string' || !QUESTION_KINDS.includes(o.kind)) return false;
  if (o.kind === 'choice' && !(Array.isArray(o.choices) && o.choices.length > 0 && o.choices.length <= 20 && o.choices.every((c) => typeof c === 'string'))) return false;
  if (o.secret !== undefined && !isSecretKind(o.secret)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Secrets the approver types (plan 5.8)
// ---------------------------------------------------------------------------

/** One box of a secret: the parts lib/agent/guards.ts reads (encodeSecretParts), or a second copy to compare. */
export type SecretPartName = 'login' | 'password' | 'currentPassword' | 'recoveryKey' | 'confirm';

export interface SecretPart {
  name: SecretPartName;
  label: string;
  /** 'text' for a user name; every password and key is 'password'. */
  type: 'text' | 'password';
}

/** One secret of a card: a secret the approver types for this one run. */
export interface SecretField {
  kind: SecretKind;
  label: string;
  /**
   * Typed in several boxes and sent as ONE text, built with encodeSecretParts (the guards' format:
   * contract.ts has one text per kind). Absent: one box, sent as typed.
   */
  parts?: SecretPart[];
  /** Which boxes must be filled: any one group, every box in it. Absent: the one box. */
  ready?: SecretPartName[][];
  /** Said under the boxes. */
  help?: string;
}

/**
 * The archive of another protected company file: a user name and password from it, or its recovery
 * key. The route itself needs none for a backup this file's own key opens, but the approval does
 * (lib/services/agentRequests.ts checkTypedSecrets and the bridge refuse a run without every secret
 * the operation lists), so the boxes are required here and the help says what to type.
 */
const ARCHIVE_FIELD: Omit<SecretField, 'kind' | 'label'> = {
  parts: [
    { name: 'login', label: 'User name in the company file the backup came from', type: 'text' },
    { name: 'password', label: "That user's password", type: 'password' },
    { name: 'recoveryKey', label: "Or: that company file's recovery key", type: 'password' },
  ],
  ready: [['login', 'password'], ['recoveryKey']],
  help:
    'A backup made in a protected company file opens with a user name and password from that file, or with its recovery key. ' +
    'A backup made in this company file usually needs neither, but Ironbooks asks for a sign-in before it does this for an agent: type your own user name and password in this company file. ' +
    'If you have none, do this yourself in Ironbooks and deny the request.',
};

/**
 * POST /api/file-protection, /file-key and /recovery-key: the secret is the approving file Admin's
 * OWN sign-in password (the nearest kind is file_password: lib/agent/operations/classes/admin.ts),
 * checked against the person the request runs as. Typing the company file password instead makes
 * the run fail, and a failed request is final, so the box says plainly which password it is.
 */
const OWN_SIGN_IN_FIELD: Pick<SecretField, 'label' | 'help'> = {
  label: 'Your own Ironbooks sign-in password',
  help: 'The password you sign in to Ironbooks with, not the company file password: Ironbooks checks that it is really you before it changes how the company file is protected.',
};

/**
 * POST /api/file-lock (file-lock.change): removing the file password needs the one in force;
 * setting one needs the new one (typed twice: a mistyped file password locks every company in the
 * file) and, when the file already has one, the one in force.
 */
function fileLockField(body: unknown): Omit<SecretField, 'kind' | 'label'> {
  const action = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).action : undefined;
  if (action === 'remove') {
    return {
      parts: [{ name: 'currentPassword', label: 'The company file password now', type: 'password' }],
      ready: [['currentPassword']],
      help: 'Removing the password lets anyone who can reach the company file open it.',
    };
  }
  return {
    parts: [
      { name: 'password', label: 'The new company file password', type: 'password' },
      { name: 'confirm', label: 'The new password again', type: 'password' },
      { name: 'currentPassword', label: 'The company file password now, if the file already has one', type: 'password' },
    ],
    ready: [['password', 'confirm']],
    help: 'Everyone who opens this company file will need the new password. Keep it somewhere safe: Ironbooks cannot show it to you again.',
  };
}

/** The boxes of one secret kind on this request: several for the kinds guards.ts reads as parts. */
function secretField(kind: SecretKind, r: Pick<AgentRequestView, 'operation' | 'input'>): SecretField {
  const field: SecretField = { kind, label: SECRET_LABELS[kind] };
  if (kind === 'archive_credentials') return { ...field, ...ARCHIVE_FIELD };
  if (kind === 'file_password' && r.operation === 'file-lock.change') return { ...field, ...fileLockField(r.input?.body) };
  if (kind === 'file_password' && r.operation.startsWith('file-protection.')) return { ...field, ...OWN_SIGN_IN_FIELD };
  return field;
}

/**
 * The password fields of a card: every secret the approval needs, and every password question of
 * a desktop flow that names its secret (its answer goes with the secrets, never with the answers,
 * so it is never stored). `unanswerable` is set when a flow asks for a password without saying
 * which one: it cannot be passed on safely, so the request cannot be approved here.
 *
 * A field is always named by Ironbooks' own words for that kind of secret (SECRET_LABELS, or the
 * words for the operation where it uses a kind for a nearby password, such as the file Admin's own
 * sign-in password of file protection), never by a question's text: the card says plainly which
 * password it is, and nothing else can change that wording into a request for some other password.
 */
export function secretFieldsOf(
  r: Pick<AgentRequestForPerson, 'kind' | 'operation' | 'needs' | 'questions'> & Partial<Pick<AgentRequestView, 'input'>>,
): { fields: SecretField[]; unanswerable: boolean } {
  const req = { operation: r.operation, input: r.input ?? null };
  const fields: SecretField[] = [];
  for (const kind of r.needs?.secrets ?? []) {
    if (isSecretKind(kind) && !fields.some((f) => f.kind === kind)) fields.push(secretField(kind, req));
  }
  let unanswerable = false;
  for (const q of flowQuestionsOf(r)) {
    if (q.kind !== 'password') continue;
    if (!q.secret) {
      unanswerable = true;
      continue;
    }
    if (!fields.some((f) => f.kind === q.secret)) fields.push(secretField(q.secret, req));
  }
  return { fields, unanswerable };
}

/** The boxes of a field, by name: the one box of a plain field is 'value'. */
export function secretBoxes(field: SecretField): Array<{ name: SecretPartName | 'value'; label: string; type: 'text' | 'password' }> {
  return field.parts?.length ? field.parts : [{ name: 'value', label: field.label, type: 'password' }];
}

/** Whether enough of a field is typed to send it. `filled` says, by box name, whether a box holds something. */
export function secretFieldReady(field: SecretField, filled: (name: SecretPartName | 'value') => boolean): boolean {
  if (!field.parts?.length) return filled('value');
  const groups = field.ready?.length ? field.ready : [field.parts.map((p) => p.name)];
  return groups.some((g) => g.length > 0 && g.every((n) => filled(n)));
}

/**
 * The one text a field sends, from what its boxes hold (`read` gives a box's value): as typed for a
 * plain field, encodeSecretParts for one in parts. Null when nothing is typed. An error, in plain
 * words, when the two copies of a new password differ.
 */
export function secretValueOf(field: SecretField, read: (name: SecretPartName | 'value') => string): { value: string } | { error: string } | null {
  if (!field.parts?.length) {
    const v = read('value');
    return v ? { value: v } : null;
  }
  const names = field.parts.map((p) => p.name);
  const get = (n: SecretPartName) => (names.includes(n) ? read(n) : '');
  if (names.includes('confirm') && get('password') !== get('confirm')) {
    return { error: 'The two copies of the new password are not the same, so nothing was sent.' };
  }
  const parts = { login: get('login').trim(), password: get('password'), currentPassword: get('currentPassword'), recoveryKey: get('recoveryKey').trim() };
  if (!parts.login && !parts.password && !parts.currentPassword && !parts.recoveryKey) return null;
  return { value: encodeSecretParts(parts) };
}

/**
 * The mail server a typed mail password goes to (guards.ts puts it into the request's own mail
 * settings): the test of typed settings (POST /api/email/test with a draft) connects to the draft's
 * server with it, and a save keeps it for the server the request names. `host` null: the test of
 * the saved settings, where the typed password is not sent anywhere. Null for other operations.
 */
export function mailServerOf(r: Pick<AgentRequestView, 'operation' | 'input'>): { host: string | null; port: string | null; saved: boolean } | null {
  const body = r.input?.body && typeof r.input.body === 'object' && !Array.isArray(r.input.body) ? (r.input.body as Record<string, unknown>) : {};
  let settings: Record<string, unknown> | null = null;
  if (r.operation === 'email.test') {
    const draft = body.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return { host: null, port: null, saved: false };
    settings = draft as Record<string, unknown>;
  } else if (r.operation === 'email.settings.update') {
    settings = body;
  } else {
    return null;
  }
  const host = typeof settings.host === 'string' && plain(settings.host).trim() ? asciiDomain(String(settings.host)) : null;
  const port = typeof settings.port === 'number' || (typeof settings.port === 'string' && /^\d{1,5}$/.test(settings.port.trim())) ? String(settings.port).trim() : null;
  return { host, port, saved: r.operation === 'email.settings.update' };
}

// ---------------------------------------------------------------------------
// Desktop operations: the files they open and write (plan 5.5, 5.7)
// ---------------------------------------------------------------------------

/**
 * The input field naming the company file each desktop flow WRITES (electron/agentShell.js
 * OPERATIONS `newFile`; test/agentRequests.dom.test.ts holds the two together).
 */
export const DESKTOP_WRITES: Readonly<Record<string, string>> = {
  'shell.company.new': 'file',
  'shell.company.saveCopyAs': 'file',
  'shell.portable.open': 'target',
  'shell.accountantCopy.open': 'target',
  'shell.backup.restoreAsNew': 'target',
};

/** The input field naming the file each desktop flow OPENS or reads (a path field of the same table). */
export const DESKTOP_READS: Readonly<Record<string, string>> = {
  'shell.company.open': 'file',
  'shell.company.switch': 'file',
  'shell.portable.open': 'file',
  'shell.accountantCopy.open': 'file',
  'shell.backup.restoreAsNew': 'file',
};

/**
 * The company file a desktop flow writes, as it writes it: ".ironbooks" is added when the name
 * lacks it (electron/agentShell.js companyFilePath, held together by the test).
 */
export function companyFilePath(p: string): string {
  return /\.ironbooks$/i.test(p) ? p : `${p}.ironbooks`;
}

function bodyOf(r: Pick<AgentRequestView, 'input'>): Record<string, unknown> {
  const b = r.input?.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function textField(body: Record<string, unknown>, key: string): string | null {
  const v = body[key];
  const s = typeof v === 'string' ? plain(v).trim() : '';
  return s ? s : null;
}

/** One line of what a desktop request touches on this computer, for the card. */
export interface DesktopLine {
  label: string;
  value: string;
  /** A path: shown whole, in a fixed-width font. Otherwise a computer's name. */
  path: boolean;
}

/**
 * What a desktop request opens, writes or connects to, in full: the path a save writes (plan 5.5:
 * "paths are shown on the approval card"), never shortened. For files.save the preview's own file
 * effect names the real path (the folder as Ironbooks found it), so only when there is none is the
 * folder and name the agent sent shown, said to be what it asked for.
 */
export function desktopLines(r: Pick<AgentRequestView, 'kind' | 'operation' | 'input' | 'preview'>): DesktopLine[] {
  if (r.kind !== 'operation') return [];
  const body = bodyOf(r);
  const out: DesktopLine[] = [];
  const reads = DESKTOP_READS[r.operation];
  const read = reads ? textField(body, reads) : null;
  if (read) out.push({ label: r.operation === 'shell.company.open' || r.operation === 'shell.company.switch' ? 'The company file it opens' : 'The file it restores from', value: read, path: true });
  const writes = DESKTOP_WRITES[r.operation];
  const written = writes ? textField(body, writes) : null;
  if (written) out.push({ label: 'The company file it writes', value: companyFilePath(written), path: true });
  if (r.operation === 'shell.hosting.connect') {
    const host = textField(body, 'host');
    if (host) out.push({ label: 'The computer it connects to', value: asciiDomain(host), path: false });
  }
  if (r.operation === 'files.save' && !(r.preview?.effects ?? []).some((e) => e.kind === 'file' && filePathOf(e))) {
    const folder = textField(body, 'folder');
    if (folder) {
      const name = textField(body, 'name');
      const sep = folder.includes('\\') ? '\\' : '/';
      out.push({
        label: name ? 'Where the agent asked to save it' : "The folder the agent asked to save it in, under the file's own name",
        value: name ? `${folder.replace(/[\\/]+$/, '')}${sep}${name}` : folder,
        path: true,
      });
    }
  }
  return out;
}

/** The full path a file effect writes (lib/effects.ts filePreview `detail.path`). */
export function filePathOf(e: EffectPreview): string | null {
  const p = (e.detail as Record<string, unknown> | undefined)?.path;
  const s = typeof p === 'string' ? plain(p).trim() : '';
  return s ? s : null;
}

/** What a desktop request's run answered about the file it wrote: `file` (the shell) or `path` (files.save). */
export function writtenPathOf(r: Pick<AgentRequestView, 'operation' | 'result'>): string | null {
  if (!(DESKTOP_WRITES[r.operation] || r.operation === 'files.save') || !r.result || typeof r.result !== 'object' || Array.isArray(r.result)) return null;
  const res = r.result as Record<string, unknown>;
  const v = r.operation === 'files.save' ? res.path : (res.file ?? res.path);
  const s = typeof v === 'string' ? plain(v).trim() : '';
  return s ? s : null;
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
// What a run voids or deletes (the ledger part of the preview)
// ---------------------------------------------------------------------------

/** What a run did to an entry that was already in the books (lib/agent/bridge.ts TouchedPostingEntry). */
export type EntryTouch = 'voided' | 'deleted' | 'changed';

const TOUCHES: readonly EntryTouch[] = ['voided', 'deleted', 'changed'];

/**
 * What the run did to an entry of the ledger part that was already in the books, from the bridge's
 * own `touched` mark (TouchedPostingEntry: it lists the entries a run voids, deletes or changes
 * beside the ones it makes). Null for an entry the run makes. Never from the entry's status or
 * description: an agent writes descriptions too, so a new entry described as "Voided …" is still a
 * new entry.
 */
export function entryTouched(e: object): EntryTouch | null {
  const t = (e as { touched?: unknown }).touched;
  return typeof t === 'string' && (TOUCHES as readonly string[]).includes(t) ? (t as EntryTouch) : null;
}

/** The words the bridge puts before a touched entry's own description (bridge.ts TOUCHED_WORDS). */
const TOUCHED_PREFIX: Record<EntryTouch, string> = {
  voided: 'Voided by this request',
  deleted: 'Deleted by this request',
  changed: 'Changed by this request',
};

type LedgerEntry = NonNullable<OperationPreview['ledger']>['entries'][number];

/**
 * How one entry of the ledger part is shown: its label, a line under it, and its frame. The label
 * comes only from `touched` (and, for an entry the run makes, the status the books give it), never
 * from its description.
 */
export function entryWords(e: LedgerEntry): { label: string; note: string | null; tone: 'gone' | 'changed' | 'new' } {
  const how = entryTouched(e);
  const status = plain(e.status).trim().toLowerCase();
  const hasLines = (e.lines ?? []).length > 0;
  if (how === 'voided' || how === 'deleted') {
    return {
      label: how === 'voided' ? 'Voided' : 'Deleted',
      note: hasLines ? 'These amounts leave the ledger.' : 'It leaves the ledger; its amounts are not in the preview.',
      tone: 'gone',
    };
  }
  if (how === 'changed') {
    const note =
      status === 'void'
        ? 'An entry that was void already: it moves nothing in the ledger.'
        : status === 'draft'
          ? 'A draft entry: it moves nothing in the ledger.'
          : hasLines
            ? 'An entry already in the books, shown as it would be after the change.'
            : 'An entry already in the books; its lines are not in the preview.';
    return { label: 'Changed', note, tone: 'changed' };
  }
  if (status === 'draft') return { label: 'New draft', note: 'A draft posts nothing to the ledger.', tone: 'new' };
  if (status === 'void') return { label: 'New, and void', note: 'It is void, so it moves nothing in the ledger.', tone: 'new' };
  return { label: 'Posts', note: null, tone: 'new' };
}

/**
 * An entry's description as shown: for an entry the run touched, without the words the bridge put
 * before it, which the label already says. An entry the run makes keeps its description whole.
 */
export function entryDescription(e: LedgerEntry): string {
  const text = plain(e.description).trim();
  const how = entryTouched(e);
  if (!how) return text;
  const prefix = TOUCHED_PREFIX[how];
  if (text === prefix) return '';
  return text.startsWith(`${prefix}: `) ? text.slice(prefix.length + 2).trim() : text;
}

/** The fields an amount is kept under in a record's audit values (lib/services/accountant/auditReports.ts). */
const AMOUNT_FIELDS = ['total', 'amount', 'netPay', 'totalAmount', 'grandTotal'];

/**
 * The kinds of record (audit entity types) that post to the ledger: a transaction, or a journal
 * entry itself. Voiding or deleting one changes the ledger; voiding or deleting anything else (an
 * estimate, a list entry, a line of a form) does not, so it is named with the record changes.
 */
const POSTING_KINDS: ReadonlySet<string> = new Set([
  'journal_entry',
  'invoice',
  'invoice_write_off',
  'bill',
  'bill_payment',
  'check',
  'payment_check',
  'expense',
  'expense_report',
  'deposit',
  'credit_memo',
  'vendor_credit',
  'sales_receipt',
  'payment',
  'payment_received',
  'paycheck',
  'transfer',
  'item_receipt',
  'inventory_adjustment',
  'loan_payment',
  'payroll_liability_adjustment',
  'sales_tax_adjustment',
  'home_currency_adjustment',
  'landed_cost_allocation',
]);

function kindKey(kind: unknown): string {
  return plain(kind)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** One kind of thing a run voids or deletes, with how many and their amounts. */
export interface LedgerRemoval {
  action: 'void' | 'delete';
  kind: string;
  count: number;
  /** The amounts that are known, as decimal text. */
  amounts: string[];
  /** A kind that posts to the ledger (the default). One that does not has no amount to miss. */
  posts?: boolean;
}

function removalAction(action: unknown): 'void' | 'delete' | null {
  const a = plain(action).toLowerCase();
  return a === 'void' ? 'void' : a === 'delete' || a === 'remove' ? 'delete' : null;
}

/** The amount a voided or deleted record had, from its record change: its total, or its lines' debits. */
function removedAmount(diff: RecordDiff | undefined): string | null {
  if (!diff) return null;
  const valueOf = (name: string) => {
    const f = diff.fields.find((x) => plain(x.field).toLowerCase() === name.toLowerCase());
    return f ? (moneyOf(f.before) ?? moneyOf(f.after)) : null;
  };
  for (const name of AMOUNT_FIELDS) {
    const v = valueOf(name);
    if (v !== null) return v;
  }
  // A journal entry's audit values carry its lines: the amount is the debit side.
  const lines = diff.fields.find((x) => plain(x.field).toLowerCase() === 'lines');
  const before: unknown = lines?.before;
  const after: unknown = lines?.after;
  const list = Array.isArray(before) ? before : Array.isArray(after) ? after : null;
  if (!list) return null;
  const debits: string[] = [];
  for (const l of list) {
    if (!l || typeof l !== 'object') return null;
    const d = (l as Record<string, unknown>).debit;
    if (d === null || d === undefined || d === '') continue;
    const m = moneyOf(d);
    if (m === null) return null;
    debits.push(m);
  }
  return debits.length ? toAmountString(Money.add(...debits)) : null;
}

/**
 * Everything the run voids or deletes: the trial run's touched records (ledger.changes) and record
 * changes whose action is a void or a delete, grouped by kind, with the amounts their record changes
 * show, each marked with whether its kind posts to the ledger.
 */
function removals(preview: OperationPreview | null | undefined): LedgerRemoval[] {
  if (!preview) return [];
  const diffs = new Map<string, RecordDiff>();
  for (const d of preview.records ?? []) diffs.set(`${kindKey(d.kind)}:${plain(d.id)}`, d);
  // An entry the ledger part lists itself (with its lines) is not named twice, nor the transaction
  // an entry the run touched belongs to (its source, "invoice:<id>"): its amounts are on screen.
  const listed = new Set<string>();
  for (const e of preview.ledger?.entries ?? []) {
    listed.add(`journal_entry:${plain(e.journalEntryId)}`);
    const source = /^([a-z_-]+):(.+)$/i.exec(plain(e.source).trim());
    if (entryTouched(e) && source) listed.add(`${kindKey(source[1])}:${source[2]}`);
  }
  const seen = new Set<string>(listed);
  const groups = new Map<string, LedgerRemoval>();
  const add = (actionText: unknown, kindText: unknown, idText: unknown) => {
    const action = removalAction(actionText);
    const kind = kindKey(kindText);
    if (!action || !kind) return;
    const key = `${kind}:${plain(idText)}`;
    if (seen.has(key) || seen.has(`${action}:${key}`)) return;
    seen.add(`${action}:${key}`);
    const g = groups.get(`${action}:${kind}`) ?? { action, kind, count: 0, amounts: [], posts: POSTING_KINDS.has(kind) };
    g.count++;
    const amount = removedAmount(diffs.get(key));
    if (amount !== null) g.amounts.push(amount);
    groups.set(`${action}:${kind}`, g);
  };
  for (const c of preview.ledger?.changes ?? []) add(c.action, c.kind, c.id);
  for (const d of preview.records ?? []) add(d.action, d.kind, d.id);
  return [...groups.values()];
}

/**
 * What the run voids or deletes in the ledger (plan 4.3): transactions and journal entries only. A
 * void takes an entry out of the ledger without posting a new one, so a preview with no new entries
 * still changes the ledger: the card says so instead of "nothing is posted".
 */
export function ledgerRemovals(preview: OperationPreview | null | undefined): LedgerRemoval[] {
  return removals(preview).filter((g) => g.posts);
}

/** What the run voids or deletes that does not post to the ledger (an estimate, a list entry, a line): named with the record changes. */
export function recordRemovals(preview: OperationPreview | null | undefined): LedgerRemoval[] {
  return removals(preview).filter((g) => !g.posts);
}

/** "invoice" → "invoices", "journal entry" → "journal entries". */
function plural(words: string): string {
  if (/[^aeiou]y$/.test(words)) return `${words.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(words)) return `${words}es`;
  return `${words}s`;
}

/** "Voided invoice: $1,250.00", "Deleted 2 estimate lines", "Voided 3 bills: $40.00 in all". */
export function removalText(g: LedgerRemoval): string {
  const what = fieldLabel(g.kind).toLowerCase() || 'record';
  const verb = g.action === 'void' ? 'Voided' : 'Deleted';
  const head = g.count === 1 ? `${verb} ${what}` : `${verb} ${g.count} ${plural(what)}`;
  // A record that posts nothing (a customer, an estimate line) has no amount the preview could miss.
  if (g.amounts.length === 0) return g.posts === false ? head : `${head} (${g.count === 1 ? 'its amount is' : 'their amounts are'} not in the preview)`;
  if (g.count === 1) return `${head}: ${amountText(g.amounts[0])}`;
  const total = amountText(toAmountString(Money.add(...g.amounts)));
  return g.amounts.length === g.count ? `${head}: ${total} in all` : `${head}: ${total} for ${g.amounts.length} of them, the rest not in the preview`;
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
 * well-formed ids, at most ten. Used only when the server did not send `entryIds`.
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

/**
 * The entries the "done" links open: the ones the server says the committed run created
 * (`entryIds`, oldest first), or, from a server that sends none, the ones the run's answer names.
 */
export function doneEntryIds(r: Pick<AgentRequestView, 'operation' | 'result' | 'entryIds'>): string[] {
  if (!Array.isArray(r.entryIds)) return postedEntryIds(r);
  const out: string[] = [];
  for (const id of r.entryIds) if (typeof id === 'string' && UUID_RE.test(id) && !out.includes(id) && out.length < 10) out.push(id);
  return out;
}

/**
 * The standing permission given with an approval, in one sentence, from what the server says was
 * really given (`grant`: it may be narrower than what was asked).
 */
export function grantGivenText(agentName: string, grant: NonNullable<AgentRequestView['grant']>): string {
  const until = Date.parse(grant.expiresAt);
  const minutes = Number.isFinite(grant.minutes) && grant.minutes > 0 ? Math.floor(grant.minutes) : null;
  const how = minutes ? ` for ${durationLabel(minutes)}` : '';
  const when = Number.isFinite(until) ? `, until about ${clockTime(new Date(until))}` : '';
  return `${plain(agentName)} may do more of the same without asking${how}${when}. You can take it back in Users & Roles > Agents.`;
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

/** Most requests one batch approval sends: the server's own limit (lib/validation/agentAccess.ts). */
export const BATCH_MAX = BATCH_APPROVE_MAX;

/**
 * Why this request cannot be chosen for approving together, or null when it can. `operation` is
 * the operation of the requests already chosen (they must all be the same). At least as strict as
 * the server's batchApprove (lib/services/agentRequests.ts), which refuses the whole batch over
 * one that does not fit: one operation, new entries and changes only, nothing that needs a
 * password, two people or the host computer.
 */
export function batchBlock(r: AgentRequestForPerson, operation: string | null): string | null {
  if (r.status !== 'pending') return 'Only requests that are still waiting can be approved.';
  if (!r.canApprove) return plain(r.cannotApproveWhy) || 'You cannot approve this one.';
  if (r.kind !== 'operation') return 'Standing permission is given one request at a time. Open it to answer.';
  if (!BATCH_CLASSES.includes(r.class)) return 'Only new entries and changes can be approved together. Open this one to approve it on its own.';
  if (r.needs?.secrets?.length) return 'This one needs a password. Open it to approve it on its own.';
  if (r.needs?.twoPerson) return 'This one needs two people to approve it. Open it to approve it on its own.';
  if (r.needs?.hostOnly) return 'This one can be approved only at the host computer, on its own. Open it to approve it.';
  if (flowQuestionsOf(r).length) return 'This one has questions to answer. Open it to approve it on its own.';
  // A yes must be given again on the new preview, by someone who was shown it (plan 7.4).
  if (r.stale) return 'The books changed since the agent asked. Open it to see what would happen now, and approve it on its own.';
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

/** Whether the card offers standing permission at all (never where the server refuses it for everyone). */
export function canGiveGrant(r: Pick<AgentRequestForPerson, 'grantMinutesMax' | 'needs'>): boolean {
  return r.grantMinutesMax > 0 && r.needs?.grantable !== 'no' && grantNeverHere(r.needs) === null;
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

/** A request or agent id as the app writes them. */
export function isId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

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
 * widens it by unticking, never by default. When the books changed, rebuildGrantForm takes what the
 * person had not changed from this again, on the new preview.
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

/** Parts of the form that follow from the request itself (what it names, whether it has a date), never a person's choice. */
const FORM_SHAPE: ReadonlyArray<keyof GrantForm> = ['entityIds', 'accountIds', 'datesOffered', 'countRequired', 'countOffered'];

function sameValue(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;
}

/**
 * "Approve similar…" filled in again after the books changed (plan 7.4): what the person had
 * changed stays as they left it (a shorter time, fewer uses, other dates, an unticked limit, an
 * amount or count they typed), and only what they had not touched is taken again from the new
 * preview (its amount, and the count of a bulk change). For how long is never longer than they
 * chose, nor than this person may give now. `before` is the request as the form was first filled
 * in from; `after` is it with the new preview. `note` says what was done, for the form to show.
 */
export function rebuildGrantForm(
  form: GrantForm,
  before: AgentRequestForPerson,
  after: AgentRequestForPerson,
  now: Date,
): { form: GrantForm; note: string } {
  const base = initialGrantForm(before, now);
  const fresh = initialGrantForm(after, now);
  const next: GrantForm = { ...fresh };
  const set = next as unknown as Record<keyof GrantForm, unknown>;
  for (const k of Object.keys(fresh) as Array<keyof GrantForm>) {
    if (FORM_SHAPE.includes(k)) continue;
    if (!sameValue(form[k], base[k])) set[k] = form[k];
  }
  if (next.countRequired) next.countOn = true;
  let shorter = false;
  const options = durationOptions(after.grantMinutesMax, after.kind === 'grant' ? (after.grantAsked?.minutes ?? null) : null, now);
  if (!options.some((o) => o.minutes === next.minutes)) {
    const fit = options.filter((o) => o.minutes <= next.minutes).pop() ?? options[0];
    shorter = !!fit && fit.minutes < next.minutes;
    next.minutes = fit?.minutes ?? 0;
  }
  const refilled = (['amount', 'count'] as const).filter((k) => next[k] !== form[k]);
  const words: string[] = ['The books changed.'];
  words.push(
    refilled.length
      ? `The ${refilled.map((k) => (k === 'amount' ? 'amount' : 'number of records')).join(' and ')} below now come${refilled.length === 1 ? 's' : ''} from what would happen now; every limit you had changed is kept.`
      : 'The limits below are as you left them.',
  );
  if (shorter) words.push(`For how long is now at most ${durationLabel(next.minutes)}: that is the most you may give now.`);
  words.push('Check them before you approve.');
  return { form: next, note: words.join(' ') };
}

/** "$1,250.50" or "1250.5" → "1250.50"; null when it is not an amount above zero. */
export function amountValue(text: string): string | null {
  const s = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  try {
    return toDecimal(s).greaterThan(0) ? toAmountString(s) : null;
  } catch {
    return null;
  }
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
