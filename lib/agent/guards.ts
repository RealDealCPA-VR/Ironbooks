/**
 * Agent full access: what an agent may never supply, and what is hidden from it (plan §4.6, §5.8,
 * §5.9 and §11.2).
 *
 *  - guardInput: takes out of an agent's input everything only a person may give (passwords, keys,
 *    the Integrated Applications switch, "save the copy without a password") and refuses what an
 *    agent may never ask for, even with approval: an operation that is not an agent's, the hard
 *    floor reached through a body field, a "yes, I am sure" flag no warning of the route names, a
 *    reveal where nothing is masked, a path value that is not a plain id, a mail server whose
 *    name the approval line could not show in full (the approver's mail password would go there),
 *    an email recipient that is not one or more plain addresses (RECIPIENT_FIELDS: the line
 *    shows each one's domain in full, and a plain address is read the same way by the mailer),
 *    and a file path that is not plain (pathRefusal: a ".." or a device prefix would make the
 *    start and end the line shows another place than where the file goes), or, for a desktop or
 *    backup operation, not a full path by the rules of the system this server runs on
 *    (FULL_PATH_FIELDS, notFullPath: where a relative one goes depends on the folder or drive the
 *    app is working in). It keeps the version of the record the agent last read
 *    (OperationInput.expectedUpdatedAt) when it is a plain ISO time, so a stored request still
 *    has it when a person approves.
 *  - applySecrets: puts what the approving person typed on the card exactly where the route reads
 *    it (a header or a body field). The agent never sees it and it is never stored.
 *  - redactAnswer: takes every secret the route produced out of the answer (the approver sees it
 *    once, on their own screen) and masks protected values unless a person approved a reveal.
 *
 * Pure: no database, no Node, no Next, so the door, the bridge, the request store and the pages can
 * all use it. The one thing it reads from where it runs is which system that is (process.platform,
 * when there is a process: hostPlatform), because a full path is written differently on Windows
 * than on a Mac. The tables below are keyed by operation ("METHOD /api/pattern"); each entry was read
 * off the route handler it names, and guards.test.ts holds them against the registry. Fail closed:
 * a field name that holds a secret is removed from every operation's input, listed or not.
 */
import { maskAccountNumber, maskSsn, stripSecrets } from '@/lib/permissions/mask';
import type { ApplySecrets, GuardInput, OperationInput, ProducedSecret, RedactAnswer } from './contract';
import type { Operation, SecretKind } from './operations/types';

// ---------------------------------------------------------------------------
// Names the routes read
// ---------------------------------------------------------------------------

/** lib/context.ts CLOSING_PASSWORD_HEADER: unlocks dates on or before the closing date for one request. */
export const CLOSING_PASSWORD_HEADER = 'x-closing-password';
/** lib/net/archiveCredentials.ts LOGIN_HEADER: the user name that opens a backup sealed with another file's key. */
export const ARCHIVE_LOGIN_HEADER = 'x-ironbooks-login';
/**
 * lib/net/archiveCredentials.ts PASSWORD_HEADER, base64url of the UTF-8 bytes: that user's password,
 * and also the password of a portable file or an Accountant's Copy transfer file being opened.
 */
export const ARCHIVE_PASSWORD_HEADER = 'x-ironbooks-password';
/** lib/net/archiveCredentials.ts RECOVERY_KEY_HEADER. */
export const ARCHIVE_RECOVERY_KEY_HEADER = 'x-ironbooks-recovery-key';
/** Every header applySecrets can hand back. The bridge must let exactly these into a service scope. */
export const SECRET_HEADERS: readonly string[] = Object.freeze([
  CLOSING_PASSWORD_HEADER,
  ARCHIVE_LOGIN_HEADER,
  ARCHIVE_PASSWORD_HEADER,
  ARCHIVE_RECOVERY_KEY_HEADER,
]);

/** What a produced secret reads as in the agent's answer. */
export const PRODUCED_SECRET_TEXT = 'Shown to the person who approved';
/** What a masked value reads as when no part of it may show (a password, a whole memo). */
export const MASKED_TEXT = '••••';

// ---------------------------------------------------------------------------
// What an agent never supplies
// ---------------------------------------------------------------------------

/**
 * Field names that hold a secret wherever they appear, for every operation: an agent that supplied
 * one would know a password a person relies on (or could sign in with it), so they are removed from
 * bodies and queries at any depth. The app's own stored-secret names (lib/permissions/mask.ts
 * SECRET_KEYS) are here too: a hash never comes from outside.
 */
const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'filePassword',
  'apiKey',
  'recoveryKey',
  'totp',
  'challengeAnswer',
  'passwordHash',
  'portalPasswordHash',
  'closingDatePasswordHash',
  'challengeAnswerHash',
  'totpSecret',
  'resetToken',
  'apiKeyEnc',
  'tokenHash',
]);

/**
 * Field names only a person may set, wherever they appear. integratedAppsBlocked is the switch that
 * shuts every agent out (the hard floor, plan §4.6). allowEmployeePortal and allowPhoneReceipts
 * decide who reaches the company file from outside it, and only an Admin may change them
 * (lib/services/company.ts updateCompany).
 */
const PERSON_ONLY_FIELD_NAMES: ReadonlySet<string> = new Set(['integratedAppsBlocked', 'allowEmployeePortal', 'allowPhoneReceipts']);

/**
 * Per operation, body fields only a person may set (dotted). `protect` on a copy of the company
 * file: { protect: false } answers a copy with every user's password hash and no password on it,
 * so an agent's copy is always protected with the password the approver types. `allowCloud` on an
 * AI test turns cloud AI on in Privacy & Network and keeps it on (lib/services/aiSettings.ts).
 */
const PERSON_ONLY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'PATCH /api/company': ['settings.integratedAppsBlocked', 'settings.allowEmployeePortal', 'settings.allowPhoneReceipts'],
  'POST /api/accountant-copy': ['protect'],
  'POST /api/period-copy': ['protect'],
  'POST /api/portable': ['protect'],
  'POST /api/ai/test': ['allowCloud'],
};

/**
 * "Yes, I am sure" flags the routes accept after a 409 warning (plan §5.6). A flag in the body that
 * the operation does not list is taken out: the policy could not see it, and an unlisted
 * allowLedgerRewrite would otherwise ride along on an ordinary change. A listed one counts as sent
 * in `confirm`, so the policy treats the request as confirmed whichever way it arrived.
 */
const CONFIRM_FLAG_NAMES: ReadonlySet<string> = new Set([
  'allowDuplicateNumber',
  'allowReconciledEdit',
  'overrideCreditLimit',
  'allowOverBilling',
  'allowUnnamedControl',
  'allowDuplicate',
  'allowLedgerRewrite',
  'allowInactive',
  'allowDeposited',
  'allowZero',
  'removeFromDeposit',
  'acceptVariance',
  'acceptExistingEntries',
  'acknowledgeDifference',
  'confirmReconciledRepost',
]);

// ---------------------------------------------------------------------------
// Where each secret goes (checked against every handler named)
// ---------------------------------------------------------------------------

type SecretPlace =
  /** A body field. `inside`: only when that object is already in the body (a draft being tested). */
  | { to: 'body'; path: string; inside?: string }
  /** POST /api/file-lock: `password` to set, `currentPassword` to change or remove (by body.action). */
  | { to: 'file_lock' }
  /** x-ironbooks-login + x-ironbooks-password, or x-ironbooks-recovery-key. */
  | { to: 'archive_headers' }
  /** x-ironbooks-password alone: the password of a portable or transfer file being opened. */
  | { to: 'file_password_header' };

interface SecretRoute {
  /** Body fields the route reads a secret from (dotted, * for any). What the agent put there goes. */
  fields: readonly string[];
  /** Where each kind the approver types is put. closing_password also always goes in its header. */
  place: Partial<Record<SecretKind, SecretPlace>>;
}

const body = (path: string): SecretPlace => ({ to: 'body', path });
const FILE_PROTECTION: SecretRoute = { fields: ['password'], place: { file_password: body('password') } };
const COPY_PASSWORD: SecretRoute = { fields: ['password'], place: { backup_password: body('password') } };
const OPEN_COPY: SecretRoute = { fields: [], place: { backup_password: { to: 'file_password_header' } } };
const ARCHIVE: SecretRoute = { fields: [], place: { archive_credentials: { to: 'archive_headers' } } };
const CLOSING_BODY: SecretRoute = { fields: ['password', 'currentPassword'], place: { closing_password: body('currentPassword') } };

/**
 * Keyed "METHOD /api/pattern". Read off each handler:
 *  - users (POST), users/[id]/reset-password: zod `password` (and `currentPassword` for your own).
 *  - file-lock: body.password (set) and body.currentPassword (change or remove).
 *  - file-protection, /file-key, /recovery-key: body.password, the approving file Admin's own.
 *  - employees/[id]/portal-password: body.password.
 *  - email/settings PUT: emailSetupSchema `password`; email/test: `draft.password` (only a draft
 *    carries one: without a draft the saved settings are tested).
 *  - ai/settings PUT: providers[].apiKey; ai/test: apiKey. No secret kind exists for an AI key, so
 *    an agent's key is only ever removed; a person types keys in AI settings.
 *  - portable, accountant-copy, period-copy (POST): body.password protects the copy.
 *  - portable/restore, accountant-copy/open: filePasswordFrom(x-ironbooks-password).
 *  - backup, backup/company, backups/preview, backups/restore, condense/archives (POST):
 *    archiveCredentialsFrom(the x-ironbooks-* headers).
 *  - company/closing-date PATCH, month-end-close/close: body.currentPassword is the closing-date
 *    password in force; body.password would SET a new one, which only a person does in Ironbooks.
 *  - year-end-close, accountant-copy/changes/import: the x-closing-password header only.
 */
const SECRET_ROUTES: Readonly<Record<string, SecretRoute>> = {
  'POST /api/users': { fields: ['password'], place: { new_user_password: body('password') } },
  'POST /api/users/[id]/reset-password': { fields: ['password', 'currentPassword'], place: { new_user_password: body('password') } },
  'POST /api/file-lock': { fields: ['password', 'currentPassword', 'newPassword'], place: { file_password: { to: 'file_lock' } } },
  'POST /api/file-protection': FILE_PROTECTION,
  'POST /api/file-protection/file-key': FILE_PROTECTION,
  'POST /api/file-protection/recovery-key': FILE_PROTECTION,
  'POST /api/employees/[id]/portal-password': { fields: ['password'], place: { portal_password: body('password') } },
  'PUT /api/email/settings': { fields: ['password'], place: { mail_password: body('password') } },
  'POST /api/email/test': { fields: ['draft.password'], place: { mail_password: { to: 'body', path: 'draft.password', inside: 'draft' } } },
  'PUT /api/ai/settings': { fields: ['providers.*.apiKey'], place: {} },
  'POST /api/ai/test': { fields: ['apiKey'], place: {} },
  'POST /api/portable': COPY_PASSWORD,
  'POST /api/accountant-copy': COPY_PASSWORD,
  'POST /api/period-copy': COPY_PASSWORD,
  'POST /api/portable/restore': OPEN_COPY,
  'POST /api/accountant-copy/open': OPEN_COPY,
  'POST /api/backup': ARCHIVE,
  'POST /api/backup/company': ARCHIVE,
  'POST /api/backups/preview': ARCHIVE,
  'POST /api/backups/restore': ARCHIVE,
  'POST /api/condense/archives': ARCHIVE,
  'PATCH /api/company/closing-date': CLOSING_BODY,
  'POST /api/month-end-close/close': CLOSING_BODY,
  'POST /api/year-end-close': { fields: [], place: {} },
  'POST /api/accountant-copy/changes/import': { fields: [], place: {} },
};

/**
 * Operations that send the mail password the approver types to a mail server the request itself
 * names, and where that server's name is in the body. POST /api/email/test connects to the draft's
 * server with it (only a draft carries one: without a draft the saved set-up is tested and the
 * typed password goes nowhere); PUT /api/email/settings saves it for that server, which every later
 * email then signs in to. The approval line names that server (lib/agent/describe.ts), so a person
 * sees where their password goes; a name the line cannot show in full (hostShownInFull) is refused
 * by guardInput and never gets the password from applySecrets.
 */
export const MAIL_SERVER_PATHS: Readonly<Record<string, { host: string; inside?: string }>> = Object.freeze({
  'POST /api/email/test': { host: 'draft.host', inside: 'draft' },
  'PUT /api/email/settings': { host: 'host' },
});

/** Longest server name an approval line shows. Real mail server names are far shorter. */
export const SHOWN_HOST_MAX = 100;

/**
 * A server name the approval line shows exactly as it is, in full: letters, digits, dots and
 * hyphens (no look-alike letters from other alphabets, no spaces or invisible marks that would
 * make the line differ from the name used), or an IP address, at most SHOWN_HOST_MAX characters.
 * The same shape lib/services/emailSettings.ts accepts for a mail server, only shorter.
 */
export function hostShownInFull(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  return (
    host !== '' &&
    host.length <= SHOWN_HOST_MAX &&
    /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9a-fA-F:]+)$/.test(host)
  );
}

/**
 * The mail server this request would send a typed mail password to, as the approval line shows it.
 * 'none': the operation sends none to a server it names, or (a test without a draft) the typed
 * password is not used. A draft or set-up with no server name at all is 'not_shown' too: nobody
 * can say where it would go.
 */
function mailServerOf(operation: Pick<Operation, 'method' | 'route'>, input: OperationInput): 'none' | 'shown' | 'not_shown' {
  const spot = MAIL_SERVER_PATHS[routeKey(operation)];
  if (!spot) return 'none';
  if (spot.inside !== undefined && !(isPlainObject(input.body) && isPlainObject(input.body[spot.inside]))) return 'none';
  return hostShownInFull(valuesAt(input.body, spot.host)[0]) ? 'shown' : 'not_shown';
}

// ---------------------------------------------------------------------------
// Email recipients an agent sends
// ---------------------------------------------------------------------------

/** One field an operation reads recipients from. `many`: it takes several, parted by "," or ";". */
export interface RecipientField {
  /** Dotted path in the body, * for any element of a list. */
  path: string;
  many: boolean;
}

/**
 * Where each operation that sends email reads the recipients an agent may give (read off each
 * handler; guards.test.ts holds the table against the registry's email operations). A field that
 * takes one recipient takes one plain address and nothing else; a field that takes several takes
 * plain addresses parted by "," or ";". The mailer (nodemailer) reads a name, quotes, brackets,
 * parentheses or a comment in an address its own way, so an approval line could show one place and
 * the mail go to another: a plain address it reads exactly as written, and the line shows each
 * one's domain in full (lib/agent/describe.ts). A person's own sends keep the routes' own checks.
 */
export const RECIPIENT_FIELDS: Readonly<Record<string, readonly RecipientField[]>> = Object.freeze({
  // body.to (else the customer's or vendor's address on file).
  'POST /api/invoices/[id]/email': [{ path: 'to', many: false }],
  'POST /api/purchase-orders/[id]/email': [{ path: 'to', many: false }],
  'POST /api/sales-forms/[kind]/[id]/email': [{ path: 'to', many: false }],
  // body.email; body.to there is the end of the statement's period, a date.
  'POST /api/sales-forms/statement-email': [{ path: 'email', many: false }],
  // { action, items: [{ kind, id, to? }] }: each form's own recipient.
  'POST /api/sales-forms/queue': [{ path: 'items.*.to', many: false }],
  'POST /api/attention/invoice-reminder': [{ path: 'to', many: false }],
  'POST /api/collections/email': [{ path: 'to', many: false }],
  'POST /api/email/test': [{ path: 'to', many: false }],
  // "Always send a copy to" goes on every email the company sends; replies go to replyTo.
  'PUT /api/email/settings': [
    { path: 'bcc', many: true },
    { path: 'replyTo', many: false },
  ],
  'POST /api/report-schedules': [{ path: 'emailTo', many: true }],
  'PATCH /api/report-schedules/[id]': [{ path: 'emailTo', many: true }],
});

/**
 * Field names that hold recipients wherever they appear in the body of an operation that sends
 * email (fail closed: a field a route grows later is checked before anyone adds it to the table).
 * "to" is not one: the statement email's "to" is a date.
 */
const RECIPIENT_NAMES_MANY: ReadonlySet<string> = new Set(['cc', 'bcc', 'recipients', 'emailTo', 'emailCc', 'emailBcc']);
const RECIPIENT_NAMES_ONE: ReadonlySet<string> = new Set(['recipient', 'replyTo']);

/** Whether a field of that name holds recipients (RECIPIENT_NAMES_*), for describe.ts. */
export function recipientFieldName(name: string): boolean {
  return RECIPIENT_NAMES_MANY.has(name) || RECIPIENT_NAMES_ONE.has(name);
}

/** The longest parts of an address the mail standards allow (RFC 5321). */
export const ADDRESS_LOCAL_MAX = 64;
export const ADDRESS_DOMAIN_MAX = 253;
const DOMAIN_LABEL_MAX = 63;

/**
 * The part before "@" of a plain address: letters, digits and . _ + - # $ & * = ? ^ / { } | ~,
 * dots only between other characters. No space, quote, apostrophe, backtick, parenthesis, angle or
 * square bracket, backslash, comma, semicolon or colon (each starts a name, a quote, a comment, a
 * group or a second address for the mailer), nor "%" or "!" (old ways of routing mail on to
 * another server).
 */
const LOCAL_ATOM = String.raw`[A-Za-z0-9#$&*+/=?^_{|}~-]+`;
const PLAIN_LOCAL = new RegExp(String.raw`^${LOCAL_ATOM}(?:\.${LOCAL_ATOM})*$`);
/** One label of the domain: letters, digits and hyphens, not starting or ending with a hyphen. */
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** A plain email address in its two parts. */
export interface PlainAddress {
  local: string;
  domain: string;
}

/**
 * `text` as a plain email address (see PLAIN_LOCAL): the part before one "@", and a domain of at
 * least two labels of letters, digits and hyphens parted by single dots (no dot at either end; a
 * domain in another alphabet only in its "xn--" form). Null for anything else. No length limit
 * here: describe.ts shows a long one with its domain whole, and guardInput refuses it.
 */
export function plainAddress(text: string): PlainAddress | null {
  const at = text.indexOf('@');
  if (at <= 0 || at !== text.lastIndexOf('@')) return null;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (!PLAIN_LOCAL.test(local)) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL.test(l))) return null;
  return { local, domain };
}

/** Why one address cannot be sent to as an agent gave it, or null. */
function addressProblem(item: string, where: string): string | null {
  const parts = plainAddress(item);
  const shown = cleanText(item, 60);
  if (!parts) {
    return `"${shown}" in ${where} is not a plain email address. Send just the address, such as billing@acme.com: no name, quotes, brackets, parentheses or spaces, one @, and a domain of letters, digits, dots and hyphens (a domain in another alphabet in its xn-- form).`;
  }
  if (parts.local.length > ADDRESS_LOCAL_MAX || parts.domain.length > ADDRESS_DOMAIN_MAX || parts.domain.split('.').some((l) => l.length > DOMAIN_LABEL_MAX)) {
    return `"${shown}" in ${where} is too long for an email address: at most ${ADDRESS_LOCAL_MAX} characters before the @, ${ADDRESS_DOMAIN_MAX} after it and ${DOMAIN_LABEL_MAX} between two dots. Send the address as it really is.`;
  }
  return null;
}

/** Why one recipient field cannot be used as an agent gave it, or null. Empty means "none given". */
function recipientProblem(where: string, value: unknown, many: boolean, listsAllowed: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && listsAllowed) {
    for (const v of value) {
      const p = recipientProblem(where, v, many, false);
      if (p) return p;
    }
    return null;
  }
  if (typeof value !== 'string') {
    return many
      ? `${where} must be text: email addresses parted by commas, such as billing@acme.com, ap@acme.com. Send it again that way.`
      : `${where} must be one email address as text, such as billing@acme.com. Send it again with just the address.`;
  }
  const text = value.trim();
  if (text === '') return null;
  if (!many && /[,;]/.test(text)) {
    return `${where} takes one email address, and this holds more than one. Send just one address, such as billing@acme.com (one request for each recipient).`;
  }
  const items = many ? text.split(/[,;]/).map((s) => s.trim()).filter((s) => s !== '') : [text];
  for (const item of items) {
    const p = addressProblem(item, where);
    if (p) return p;
  }
  return null;
}

/**
 * The first recipient of this request that is not plain address(es), as a refusal, or null. Only
 * for operations that send email: the table's fields, and any field named like a recipient list
 * (RECIPIENT_NAMES_*) at any depth of the body.
 */
function recipientRefusal(operation: Pick<Operation, 'method' | 'route' | 'effects'>, input: OperationInput): string | null {
  const listed = RECIPIENT_FIELDS[routeKey(operation)];
  const sendsMail = listed !== undefined || listOf(operation.effects).includes('email');
  if (!sendsMail || input.body === undefined) return null;
  for (const field of listed ?? []) {
    for (const p of placesAt(input.body, field.path)) {
      const problem = recipientProblem(`body.${p.path}`, p.value, field.many, false);
      if (problem) return problem;
    }
  }
  let found: string | null = null;
  const walk = (node: unknown, trail: string[]) => {
    if (found !== null) return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, [...trail, String(i)]));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const k of Object.keys(node)) {
      const p = [...trail, k];
      if (recipientFieldName(k)) {
        found = recipientProblem(`body.${p.join('.')}`, node[k], RECIPIENT_NAMES_MANY.has(k), true);
        if (found !== null) return;
      } else walk(node[k], p);
    }
  };
  walk(input.body, []);
  return found;
}

// ---------------------------------------------------------------------------
// File paths an agent sends
// ---------------------------------------------------------------------------

/**
 * A field holding a file or folder path, by its name: where a file goes or comes from. By the
 * field's name only, so a memo that starts with "/" or "C:\" is a memo.
 */
const PATH_FIELD_NAME = /(?:file|folder|target|path|dir|directory|destination)$/i;

/**
 * Whether the field `name` (dotted; its last name counts) holds a path with this text: it is
 * named like one and the text has a "/" or "\". lib/agent/describe.ts shows such a value as a path
 * (its start and its file name, the middle cut), and guardInput takes only a plain one from an
 * agent (pathRefusal), so the start and end the line shows are where the file really goes.
 */
export function pathField(name: string, text: string): boolean {
  return PATH_FIELD_NAME.test(name.split('.').pop() ?? name) && /[\\/]/.test(text);
}

/**
 * "\\?\", "\\.\" and "\??\", with either slash: a device path. Windows reads one as it is, without
 * resolving "." and "..", and "\\?\UNC\server\share" is a share under another spelling.
 */
export const DEVICE_PATH_PREFIX = /^(?:[\\/]{2}[?.](?:[\\/]|$)|[\\/]\?\?(?:[\\/]|$))/;

/** A folder of only dots and spaces ("..", ".", "...", ".. "): Windows reads some of them as a step up. */
export const DOTS_ONLY_FOLDER = /^[. ]*\.[. ]*$/;

/**
 * The server of a share ("\\server\share", "//server/share") written plainly: names of ASCII
 * letters, digits, "_" and "-" parted by single dots, or an IP address, then at most Windows' own
 * "@SSL" and "@port" of a web folder. No letter from another alphabet: a Cyrillic "і" in
 * "\\fіles.acme.com" reads as files.acme.com on the line, and every copy would go to another
 * computer (hostShownInFull holds mail servers to the same). No "$", "%" or trailing dot either:
 * those are other spellings of a server (lib/agent/files.ts judges this computer's own).
 */
const SHARE_SERVER = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*|\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*)(?:@SSL)?(?:@\d{1,5})?$/i;
/** The longest server name a share may have (a DNS name is at most 253 characters). */
const SHARE_SERVER_MAX = 253;

/**
 * Characters that look like "/" or "\" but are not one: the fraction and division slashes, set
 * minus, the solidus operators, the wide and small ones, the box-drawing diagonals, the Kangxi and
 * CJK strokes, the Philippine punctuation and the combining overlays that draw a slash through a
 * letter. "C:\Users\Pat", a wide backslash (U+FF3C), "Documents\Ironbooks Backups" reads as
 * C:\Users\Pat\Documents\…, but every backup would go to a new folder of that whole name right
 * under C:\Users. Built from numbers (charClass): none of them sits in this file as itself.
 */
const SLASH_LIKE = charClass(
  [
    [0x0337, 0x0338],
    [0x1735, 0x1735],
    [0x2044, 0x2044],
    [0x20e5, 0x20e5],
    [0x20eb, 0x20eb],
    [0x2215, 0x2216],
    [0x244a, 0x244a],
    [0x2571, 0x2572],
    [0x27cb, 0x27cb],
    [0x27cd, 0x27cd],
    [0x29f5, 0x29f9],
    [0x2f03, 0x2f03],
    [0x31d3, 0x31d3],
    [0xfe68, 0xfe68],
    [0xff0f, 0xff0f],
    [0xff3c, 0xff3c],
  ],
  '',
);

/**
 * The system this server runs on, as Node names it ("win32", "darwin", "linux"). The path rules
 * follow it: an agent's path is used by this same process (the backup settings, the restores) or
 * by the desktop shell on this same computer, which reads it by the same system's rules (electron/
 * agentShell.js cleanPath). Anything but "win32" is read as a Mac or Linux computer, as Node's own
 * `path` does; '' where there is no process (a browser loads this module for encodeSecretParts).
 */
function hostPlatform(): string {
  return typeof process !== 'undefined' && typeof process.platform === 'string' ? process.platform : '';
}

/** Full paths an agent might send, written the way this system writes them, for the refusals. */
function pathExamples(platform: string): string {
  return platform === 'win32'
    ? 'C:\\Users\\Pat\\Documents\\Ironbooks Backups or \\\\server\\share\\Ironbooks Backups'
    : '/Users/pat/Documents/Ironbooks Backups';
}

/**
 * What is not plain about a path an agent gave, or null. The line removes what nobody can see, so
 * a mark is first. The line also shows every run of spaces as one, and any other space (a no-break
 * space, a wide one) as an ordinary one, so neither is plain: "Ironbooks  Backups" is another
 * folder than the "Ironbooks Backups" it would show. A character that only looks like a slash
 * would show other folders than the ones the file goes to.
 */
function pathOddity(value: string): string | null {
  if (new RegExp(INVISIBLE.source, 'u').test(value) || new RegExp(LINE_BREAKS.source, 'u').test(value)) {
    return 'it holds a line break, a control character or an invisible mark, which the person approving could not see';
  }
  if (SLASH_LIKE.test(value)) return 'it holds a character that looks like a slash but is not one, so it would show other folders than the ones the file goes to';
  if (DEVICE_PATH_PREFIX.test(value)) return 'it starts with \\\\?\\ or \\\\.\\ (a device path)';
  if (/^[\\/]{3}/.test(value)) return 'it starts with three slashes or more';
  if (value.split(/[\\/]/).some((s) => DOTS_ONLY_FOLDER.test(s))) return 'it holds "." or ".." as a folder';
  if (/[^\S ]/u.test(value)) return 'it holds a space that is not an ordinary one (a no-break or wide space), which shows as an ordinary space';
  if (/ {2}/.test(value)) return 'it holds two spaces in a row, which show as one';
  if (/^ | $/.test(value)) return 'it starts or ends with a space, which does not show';
  if (/^[\\/]{2}/.test(value)) {
    const server = /^[\\/]{2}([^\\/]*)/.exec(value)?.[1] ?? '';
    if (server.length > SHARE_SERVER_MAX || !SHARE_SERVER.test(server)) {
      return "its server's name holds something other than the letters A to Z, digits, hyphens, underscores and single dots (a letter from another alphabet can look like one of these)";
    }
  }
  return null;
}

/**
 * Operations that name a file or folder on this computer, or on a share it reaches, for the company
 * file itself, beside every desktop operation (kind 'shell', lib/agent/operations/shell.ts: its
 * 'path' fields file, target and folder): where each one's paths are, "body." or "query." first.
 * Read off each handler. Every field named like a path (PATH_FIELD_NAME) in their body and query
 * counts too, at any depth.
 *  - PUT /api/backups: body.folder, where every automatic backup of the whole file is written.
 *  - POST /api/portable/restore and POST /api/accountant-copy/open: ?target= (a folder) and ?packAs=
 *    (the new .ironbooks file). Only the desktop shell's own call is given them today; an agent's
 *    run is restored beside the open file, but a path it names is still held to the rule.
 *  - POST /api/company-file/save-as: ?target= (the shell's call; refused to agents anyway).
 */
export const FULL_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'PUT /api/backups': ['body.folder'],
  'POST /api/portable/restore': ['query.target', 'query.packAs'],
  'POST /api/accountant-copy/open': ['query.target', 'query.packAs'],
  'POST /api/company-file/save-as': ['query.target'],
});

/**
 * Whether every path this operation's input names must be a full one: a desktop operation, or one
 * of FULL_PATH_FIELDS. Their paths say where the company file, a copy of it or its backups go.
 */
function needsFullPaths(operation: Pick<Operation, 'kind' | 'method' | 'route'>): boolean {
  return operation.kind === 'shell' || hasOwn(FULL_PATH_FIELDS, routeKey(operation));
}

/**
 * Why a path is not a full one on `platform` (hostPlatform: the system this server runs on, which
 * reads the path), or null. Anything that is not full is read from the folder or drive the app
 * happens to be working in.
 *  - Windows: a drive ("C:\" or "C:/") or a share with its shared folder ("\\server\share",
 *    "//server/share"). Not "Backups", "Books\x", "~/x", "C:Backups" (the drive's current
 *    folder), and not "\Backups" or "/Backups": Windows puts those on whichever drive Ironbooks
 *    runs from (the backup settings would save C:\Backups, or D:\Backups, while the line shows
 *    "/Backups").
 *  - Mac and Linux: "/" and a folder, with no "\" (there a "\" is part of a name, and the line
 *    would show it as a step into a folder). Not "//nas/books": it reads as a share, but these
 *    systems read it as the folder /nas/books on this computer. Not "C:\Backups" either: there
 *    that is a name inside the working folder.
 */
export function notFullPath(value: string, platform: string = hostPlatform()): string | null {
  const relative = 'so where it goes would depend on the folder Ironbooks is working in';
  if (platform === 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(value)) return null;
    if (/^[\\/]{2}/.test(value)) return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]/.test(value) ? null : 'it names a server but no shared folder on it';
    if (/^[\\/]/.test(value)) return 'it starts with a slash but names no drive, so Windows puts it on whichever drive Ironbooks runs from';
    return `it does not start with a drive such as C:\\ or a share such as \\\\server\\share (this computer runs Windows), ${relative}`;
  }
  if (/^\/\//.test(value)) {
    return 'it starts with two slashes, which a Mac or Linux computer reads as one: that is a folder on this computer, not a share (a share is used through the folder it is mounted at, such as /Volumes/books)';
  }
  if (/^\//.test(value)) return value.includes('\\') ? 'it holds a \\, which a Mac or Linux computer reads as part of a name, not as a step into a folder' : null;
  return `it does not start with / (this computer runs macOS or Linux, where every full path does), ${relative}`;
}

/**
 * Why a path an agent gave cannot be used as it is, or null. `full`: it must also be a full path
 * (needsFullPaths) on `platform`, the system this server runs on.
 */
function pathProblem(where: string, value: string, full: boolean, platform: string): string | null {
  const why = pathOddity(value);
  if (why !== null) {
    return `${where} is not a plain path: ${why}. Send the full path written the plain way, such as ${pathExamples(platform)}, so the person approving sees exactly where the file goes.`;
  }
  const partial = full ? notFullPath(value, platform) : null;
  if (partial === null) return null;
  return `${where} is not a full path: ${partial}. Send the whole path, such as ${pathExamples(platform)}, so the person approving sees exactly where the file goes.`;
}

/**
 * The first path in this request's body or query that is not plain, as a refusal, or null. The
 * approval line shows a long path by its start and its end (lib/agent/describe.ts): a ".." in the
 * part it leaves out, a device path's prefix or a mark nobody can see would make what it shows
 * another place than where the file goes (C:\Users\VR\Documents\…\..\..\Public\x is in
 * C:\Users\Public). A plain path reads the same whole or cut. Every field named like a path, at
 * any depth, for every operation, when its text has a "/" or "\" (a memorized report's group
 * "Monthly" is a name). For a desktop or backup operation (needsFullPaths) every such field, and
 * the ones FULL_PATH_FIELDS names, is a path whatever its text, and must be a full one ("" is none
 * given: the backups' folder then goes back to the default) by the rules of the system this server
 * runs on (notFullPath).
 */
function pathRefusal(operation: Pick<Operation, 'kind' | 'method' | 'route'>, input: OperationInput, platform: string = hostPlatform()): string | null {
  const full = needsFullPaths(operation);
  const listed = FULL_PATH_FIELDS[routeKey(operation)] ?? [];
  let found: string | null = null;
  const walk = (node: unknown, trail: string[]) => {
    if (found !== null) return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, [...trail, String(i)]));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      const p = [...trail, k];
      const where = p.join('.');
      const texts = typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
      if (texts && (PATH_FIELD_NAME.test(k) || listed.includes(where))) {
        for (const text of texts) {
          if (full ? text === '' : !/[\\/]/.test(text)) continue;
          found = pathProblem(where, text, full, platform);
          if (found !== null) return;
        }
      } else walk(v, p);
    }
  };
  walk(input.body, ['body']);
  walk(input.query, ['query']);
  return found;
}

/** Where a produced secret sits in the route's answer, and how the approver's screen names it. */
const PRODUCED_PLACES: Readonly<Record<string, Partial<Record<SecretKind, { paths: readonly string[]; label: string }>>>> = {
  // { ok, recoveryKey, status }: the key that opens the protected file, in this answer only, once.
  'POST /api/file-protection': { recovery_key: { paths: ['recoveryKey'], label: 'Recovery key for the company file' } },
  'POST /api/file-protection/recovery-key': { recovery_key: { paths: ['recoveryKey'], label: 'New recovery key for the company file' } },
  // { id, token, expiresAt, ... } (lib/services/receipts.ts createUploadToken): the token IS the link.
  'POST /api/receipts/upload-links': { capability_link: { paths: ['token'], label: 'Phone upload link for receipts' } },
};

/** For an operation the table does not name: the answer fields each kind could sit in, at any depth. */
const PRODUCED_FALLBACK_NAMES: Readonly<Record<SecretKind, readonly string[]>> = {
  closing_password: ['password'],
  file_password: ['password'],
  backup_password: ['password'],
  archive_credentials: ['password', 'recoveryKey'],
  new_user_password: ['temporaryPassword', 'tempPassword', 'password'],
  mail_password: ['password'],
  portal_password: ['temporaryPassword', 'password'],
  recovery_key: ['recoveryKey', 'recoveryCodes'],
  file_key: ['fileKey'],
  capability_link: ['token', 'url', 'link'],
};

const PRODUCED_LABELS: Readonly<Record<SecretKind, string>> = {
  closing_password: 'Closing-date password',
  file_password: 'Company file password',
  backup_password: 'Password of the copy',
  archive_credentials: 'Sign-in for the backup',
  new_user_password: 'Temporary password for the new user',
  mail_password: 'Mail server password',
  portal_password: 'Employee portal password',
  recovery_key: 'Recovery key for the company file',
  file_key: 'File key for the company file',
  capability_link: 'Link that lets someone in without signing in',
};

// ---------------------------------------------------------------------------
// Small helpers on plain JSON
// ---------------------------------------------------------------------------

type Container = Record<string, unknown> | unknown[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Sets an own property, "__proto__" included (a plain assignment would change the prototype). */
function setOwn(o: Container, k: string, v: unknown): void {
  if (Array.isArray(o) && /^\d+$/.test(k)) {
    o[Number(k)] = v;
    return;
  }
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** A deep copy of arrays and plain objects; anything else (a Date, bytes) is kept as it is. */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x)) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) setOwn(out, k, clone(v[k]));
    return out as T;
  }
  return v;
}

function childKeys(node: unknown): string[] {
  if (Array.isArray(node)) return node.map((_, i) => String(i));
  if (isPlainObject(node)) return Object.keys(node);
  return [];
}

export interface PathPlace {
  parent: Container;
  key: string;
  /** The concrete dotted path ("providers.0.apiKey"). */
  path: string;
  value: unknown;
}

/** Every place a dotted path ('lines.*.accountId', * for any index or key) names in `root`. */
export function placesAt(root: unknown, path: string): PathPlace[] {
  const segs = path.split('.').filter((s) => s !== '');
  const out: PathPlace[] = [];
  if (segs.length === 0) return out;
  const walk = (node: unknown, i: number, trail: string[]) => {
    if (!Array.isArray(node) && !isPlainObject(node)) return;
    const keys = segs[i] === '*' ? childKeys(node) : [segs[i]];
    for (const k of keys) {
      if (!hasOwn(node, k)) continue;
      const child = (node as Record<string, unknown>)[k];
      const p = [...trail, k];
      if (i === segs.length - 1) out.push({ parent: node as Container, key: k, path: p.join('.'), value: child });
      else walk(child, i + 1, p);
    }
  };
  walk(root, 0, []);
  return out;
}

/** The values a dotted path names in `root` (see placesAt). */
export function valuesAt(root: unknown, path: string): unknown[] {
  return placesAt(root, path).map((p) => p.value);
}

/** Whether a concrete dotted path is named by a pattern with * for any one segment. */
function pathMatches(pattern: string, concrete: string): boolean {
  const a = pattern.split('.');
  const b = concrete.split('.');
  return a.length === b.length && a.every((s, i) => s === '*' || s === b[i]);
}

function removeAt(root: unknown, path: string, stripped: string[], prefix: string): void {
  for (const p of placesAt(root, path)) {
    if (Array.isArray(p.parent)) continue; // a field, never an element of a list
    delete p.parent[p.key];
    stripped.push(`${prefix}${p.path}`);
  }
}

/**
 * Walk every object in `root` and drop each own key `drop` says to drop, at any depth. Returns
 * nothing; the dropped paths go to `stripped` with `prefix`.
 */
function dropKeysDeep(root: unknown, drop: (key: string, path: string, value: unknown) => boolean, stripped: string[], prefix: string): void {
  const walk = (node: unknown, trail: string[]) => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, [...trail, String(i)]));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const k of Object.keys(node)) {
      const p = [...trail, k];
      if (drop(k, p.join('.'), node[k])) {
        delete node[k];
        stripped.push(`${prefix}${p.join('.')}`);
      } else walk(node[k], p);
    }
  };
  walk(root, []);
}

function routeKey(operation: Pick<Operation, 'method' | 'route'>): string {
  return `${operation.method} ${operation.route}`;
}

function listOf(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// ---------------------------------------------------------------------------
// guardInput
// ---------------------------------------------------------------------------

const REFUSE = {
  notAnObject: 'The request could not be read. Send params, query and body as one object.',
  hardFloor:
    "Agents can never do this, even with a person's approval. Ask a person to do it in Ironbooks if it is needed.",
  personOnly:
    'This is something a person does for themselves in Ironbooks, so an agent cannot ask for it. Ask a person to do it.',
  auditHistory:
    'Removing entries from the audit trail can never be done by an agent, even with approval: the audit trail is what makes agent work answerable. Ask a person to run this repair in Ironbooks.',
  confirmShape: 'Confirmation flags must be a list of flag names, such as ["allowDuplicateNumber"].',
  revealNothing: 'Nothing in this answer is masked, so there is nothing to reveal. Send it again without reveal.',
  revealOnApproval:
    "This operation's protected data is shown only once a person approves the request, so there is no separate reveal to ask for. Send it again without reveal.",
  revealNever:
    'This operation has no reveal: its protected values stay masked for agents. Send it again without reveal, or ask a person to look them up in Ironbooks.',
  bulkAcceptBoth:
    'Send either a list of items or allHighConfidence, not both: with both, every waiting line would be posted, not only the listed ones.',
  mailServerNotShown: `Name the mail server by its plain name or address, at most ${SHOWN_HOST_MAX} characters (such as smtp.gmail.com): the person approving types the mail password, and must see in full which server it is sent to. Send it again with that name, or ask a person to set up email in Preferences > Send Forms.`,
};

function unknownFlag(flag: string, listed: readonly string[]): string {
  const shown = cleanText(flag, 60);
  return listed.length > 0
    ? `"${shown}" is not a confirmation this operation accepts. Send only a flag its warning named: ${listed.join(', ')}.`
    : `"${shown}" is not a confirmation this operation accepts; it accepts none. Send it again without confirm.`;
}

/** Why a path parameter cannot be used, or null when it is a plain id. */
function paramProblem(name: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return `This needs the ${name} of the record in params. Send it again with params.${name}.`;
  }
  if (typeof value !== 'string') return `params.${name} must be text, such as the record's id.`;
  // A slash or "..", raw or encoded, would point the request at another route; "?" and "#" would
  // cut the path short. An id never holds any of them, nor a control character.
  if (/[\/\\?#%]|\.\.|[\u0000-\u001f\u007f]/.test(value)) {
    return `The value of params.${name} cannot be used in a web address: it holds a slash, a backslash, "..", "?", "#", "%" or a control character. Send the record's id as Ironbooks shows it.`;
  }
  return null;
}

/**
 * Strip what an agent may never supply, without deciding anything else. Shared by guardInput,
 * applySecrets and maskInput, so a secret the agent sent is gone whichever of them runs first.
 * Returns the cleaned copy; listed confirmation flags found in the body are added to `confirm`.
 */
function stripInput(operation: Operation, input: OperationInput, stripped: string[]): OperationInput {
  const out: OperationInput = {};
  const key = routeKey(operation);
  const declared = listOf(operation.params);

  if (input.params !== undefined) {
    const params: Record<string, string> = {};
    if (isPlainObject(input.params)) {
      for (const [k, v] of Object.entries(input.params)) {
        // Only the route's own parameters: anything else would only ever show on the card.
        if (declared.includes(k)) setOwn(params, k, v as string);
        else stripped.push(`params.${k}`);
      }
    }
    out.params = params;
  }

  if (input.query !== undefined) {
    const query: Record<string, string | string[]> = {};
    if (isPlainObject(input.query)) {
      for (const [k, v] of Object.entries(input.query)) {
        if (SECRET_FIELD_NAMES.has(k) || PERSON_ONLY_FIELD_NAMES.has(k)) stripped.push(`query.${k}`);
        else setOwn(query, k, clone(v) as string | string[]);
      }
    }
    out.query = query;
  }

  const listedFlags = listOf(operation.confirmFlags);
  const confirm: string[] = [...new Set(listOf(input.confirm))];

  if (input.body !== undefined) {
    const b = clone(input.body);
    const route = SECRET_ROUTES[key];
    for (const f of route?.fields ?? []) removeAt(b, f, stripped, 'body.');
    for (const f of PERSON_ONLY_FIELDS[key] ?? []) removeAt(b, f, stripped, 'body.');
    dropKeysDeep(b, (k) => SECRET_FIELD_NAMES.has(k) || PERSON_ONLY_FIELD_NAMES.has(k), stripped, 'body.');
    dropKeysDeep(
      b,
      (k, p, v) => {
        if (!CONFIRM_FLAG_NAMES.has(k)) return false;
        const listed = listedFlags.find((f) => pathMatches(f, p));
        if (listed === undefined) return true;
        if (v === true && !confirm.includes(listed)) confirm.push(listed);
        return false;
      },
      stripped,
      'body.',
    );
    out.body = b;
  }

  if (input.confirm !== undefined || confirm.length > 0) out.confirm = confirm;
  if (input.reveal !== undefined) out.reveal = input.reveal === true;
  const version = plainIsoTime(input.expectedUpdatedAt);
  if (version !== null) out.expectedUpdatedAt = version;
  return out;
}

/** Longest version text kept: an ISO time with nanoseconds and an offset is 35 characters. */
export const VERSION_TEXT_MAX = 40;

/**
 * A plain ISO time: date, "T", hours and minutes, seconds and a fraction when given, then "Z" or
 * an offset ("2026-11-22T14:05:09.123Z", "2026-11-22T15:05:09+01:00"). How Ironbooks answers a
 * record's updatedAt. No zone is not one: Date would read it in this computer's own time zone.
 */
const PLAIN_ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * OperationInput.expectedUpdatedAt as guardInput keeps it (contract, wave 4): the version of the
 * record the agent last read, as a plain ISO time Date can read (spaces around it taken off); null
 * for anything else, which is dropped. Kept, the request a person approves later still carries it
 * (lib/services/agentRequests.ts guards a stored request again, and so does the approved run), and
 * the route compares it when the work runs: a person's edit made in between is a 409, never
 * written over. The bridge checks it again before it becomes a header (bridge.ts expectedVersionOf).
 */
export function plainIsoTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length > VERSION_TEXT_MAX || !PLAIN_ISO_TIME.test(v)) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/** The first refusal that applies, or null. Order: the biggest reason first. */
function refusalOf(operation: Operation, raw: OperationInput, cleaned: OperationInput): string | null {
  if (operation.availability === 'hard_floor') return REFUSE.hardFloor;
  if (operation.availability !== 'agent') return REFUSE.personOnly;

  const key = routeKey(operation);
  // Rebuild Data's "orphaned_audit_refs" deletes audit trail rows: the hard floor (plan §4.6).
  if (key === 'POST /api/import/rebuild') {
    const actions = [
      ...valuesAt(cleaned.body, 'action'),
      ...(isPlainObject(cleaned.query) ? [cleaned.query.action].flat() : []),
    ];
    if (actions.some((a) => typeof a === 'string' && a.trim().toLowerCase() === 'orphaned_audit_refs')) return REFUSE.auditHistory;
  }
  // bulkAcceptSchema's allHighConfidence form drops a list sent with it, so a list of 1 could post
  // every waiting line. Refusing the mix lets the list's length stand as the count.
  if (key === 'POST /api/bank-transactions/bulk-accept' && isPlainObject(cleaned.body)) {
    const b = cleaned.body;
    if (b.allHighConfidence !== undefined && b.allHighConfidence !== false && b.items !== undefined) return REFUSE.bulkAcceptBoth;
  }
  // The mail password a person types goes to the server this request names: the approval line
  // must be able to show that name in full, or nobody could see where the password goes.
  if (mailServerOf(operation, cleaned) === 'not_shown') return REFUSE.mailServerNotShown;
  // Every recipient an agent gives is a plain address, which the line shows whole and the mailer
  // reads as written: refused before anyone is asked, and again when a person approves.
  const recipient = recipientRefusal(operation, cleaned);
  if (recipient) return recipient;
  // Every path an agent gives is a plain one, so the start and end the line shows are where the
  // file goes: refused before anyone is asked, and again when a person approves.
  const path = pathRefusal(operation, cleaned);
  if (path) return path;

  if (raw.params !== undefined && !isPlainObject(raw.params)) return REFUSE.notAnObject;
  if (raw.query !== undefined && !isPlainObject(raw.query)) return REFUSE.notAnObject;
  for (const name of listOf(operation.params)) {
    const problem = paramProblem(name, cleaned.params?.[name]);
    if (problem) return problem;
  }

  if (raw.confirm !== undefined && (!Array.isArray(raw.confirm) || raw.confirm.some((f) => typeof f !== 'string'))) {
    return REFUSE.confirmShape;
  }
  const listed = listOf(operation.confirmFlags);
  for (const flag of cleaned.confirm ?? []) {
    if (!listed.includes(flag)) return unknownFlag(flag, listed);
  }

  if (raw.reveal === true && !operation.reveal) {
    // A read_sensitive operation's fields are masked until a person approves the run, which then
    // shows them (redactAnswer with reveal); other operations that list fields keep them masked.
    if (listOf(operation.sensitiveFields).length === 0) return REFUSE.revealNothing;
    return operation.class === 'read_sensitive' ? REFUSE.revealOnApproval : REFUSE.revealNever;
  }
  return null;
}

/**
 * Remove what an agent may never supply and refuse what it may never ask. The input that comes
 * back is always the cleaned one, refused or not, so not even a refusal's record keeps a secret.
 */
export const guardInput: GuardInput = (operation, input) => {
  const stripped: string[] = [];
  if (!isPlainObject(input)) return { input: {}, refused: REFUSE.notAnObject, stripped };
  const cleaned = stripInput(operation, input, stripped);
  return { input: cleaned, refused: refusalOf(operation, input, cleaned), stripped: [...new Set(stripped)] };
};

// ---------------------------------------------------------------------------
// applySecrets
// ---------------------------------------------------------------------------

/**
 * Starts every value encodeSecretParts makes. A NUL character cannot be typed into a password
 * field, so no password a person typed starts with it: a typed "{...}" password stays a password.
 */
export const SECRET_PARTS_MARKER = '\u0000ironbooks-secret-parts:';

export interface SecretParts {
  login?: string;
  password?: string;
  currentPassword?: string;
  recoveryKey?: string;
}

/**
 * A secret made of parts, typed as one value on the card: archive credentials (a user name and
 * password, or a recovery key) and, for the file password, the current one beside the new one.
 * The approval card sends `encodeSecretParts({ login, password })` as that kind's value in
 * ApproveInput.secrets (contract.ts has one text per kind, so the parts travel in one text). A
 * plain value is the recovery key (archive credentials) or the one password the action needs (the
 * file password). Any other kind given an encoded value counts as missing.
 */
export function encodeSecretParts(parts: { login?: string | null; password?: string | null; currentPassword?: string | null; recoveryKey?: string | null }): string {
  const out: Record<string, string> = {};
  for (const k of ['login', 'password', 'currentPassword', 'recoveryKey'] as const) {
    const v = parts[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return `${SECRET_PARTS_MARKER}${JSON.stringify(out)}`;
}

type ReadParts = { kind: 'plain' } | { kind: 'parts'; parts: SecretParts } | { kind: 'bad' };

/** A plain typed value, the parts encodeSecretParts made, or text that starts like parts and is not. */
function secretParts(value: string): ReadParts {
  if (!value.startsWith(SECRET_PARTS_MARKER)) return { kind: 'plain' };
  try {
    const p: unknown = JSON.parse(value.slice(SECRET_PARTS_MARKER.length));
    if (!isPlainObject(p)) return { kind: 'bad' };
    const out: SecretParts = {};
    for (const k of ['login', 'password', 'currentPassword', 'recoveryKey'] as const) {
      const v = p[k];
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return Object.keys(out).length > 0 ? { kind: 'parts', parts: out } : { kind: 'bad' };
  } catch {
    return { kind: 'bad' };
  }
}

/** A value a header can carry as it is (no line breaks, nothing past Latin-1, no outer spaces). */
function headerSafe(v: string): boolean {
  return v !== '' && v === v.trim() && /^[ -~\u0080-ÿ\t]*$/.test(v);
}

/** base64url of the UTF-8 bytes, as lib/net/archiveCredentials.ts decodes it (any character survives). */
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bodyObject(input: OperationInput): Record<string, unknown> | null {
  if (input.body === undefined || input.body === null) input.body = {};
  return isPlainObject(input.body) ? input.body : null;
}

/** Put one secret where it goes. False when it could not be used (then it counts as missing). */
function place(spot: SecretPlace, value: string, input: OperationInput, headers: Record<string, string>): boolean {
  const read = secretParts(value);
  if (read.kind === 'bad') return false;
  const parts = read.kind === 'parts' ? read.parts : null;
  switch (spot.to) {
    case 'body': {
      // One password goes here: parts meant for another kind are not one.
      if (parts) return false;
      const b = bodyObject(input);
      if (!b) return false;
      const segs = spot.path.split('.');
      let parent: Record<string, unknown> = b;
      if (spot.inside !== undefined) {
        // Only into an object the request already has: a test without a draft tests the saved set-up.
        const inner = b[spot.inside];
        if (!isPlainObject(inner)) return true;
        parent = inner;
        segs.shift();
      }
      for (let i = 0; i < segs.length - 1; i++) {
        const next = parent[segs[i]];
        if (!isPlainObject(next)) setOwn(parent, segs[i], {});
        parent = parent[segs[i]] as Record<string, unknown>;
      }
      setOwn(parent, segs[segs.length - 1], value);
      return true;
    }
    case 'file_lock': {
      const b = bodyObject(input);
      if (!b) return false;
      if (b.action === 'remove') {
        const current = parts ? (parts.currentPassword ?? parts.password) : value;
        if (!current) return false;
        setOwn(b, 'currentPassword', current);
        return true;
      }
      const next = parts ? parts.password : value;
      if (!next) return false;
      setOwn(b, 'password', next);
      if (parts?.currentPassword) setOwn(b, 'currentPassword', parts.currentPassword);
      return true;
    }
    case 'archive_headers': {
      const given: SecretParts = parts ?? { recoveryKey: value };
      let used = false;
      const key = given.recoveryKey?.trim();
      if (key && headerSafe(key)) {
        headers[ARCHIVE_RECOVERY_KEY_HEADER] = key;
        used = true;
      }
      const login = given.login?.trim();
      if (login && headerSafe(login) && given.password) {
        headers[ARCHIVE_LOGIN_HEADER] = login;
        headers[ARCHIVE_PASSWORD_HEADER] = base64url(given.password);
        used = true;
      }
      return used;
    }
    case 'file_password_header':
      if (parts) return false;
      headers[ARCHIVE_PASSWORD_HEADER] = base64url(value);
      return true;
  }
}

/**
 * Put the approver's secrets where the route reads them. Whatever the agent sent in those places
 * is removed first. A kind the operation has no place for is not used (a shell operation passes
 * its secrets itself). `missing`: kinds the operation needs that were not given, or could not be
 * used as given (a closing-date password with a line break cannot travel in a header; a mail
 * password is never put into a request whose mail server the approval line cannot show in full,
 * MAIL_SERVER_PATHS). Many are
 * optional to the route (a backup that is not sealed with another key needs no credentials), so
 * `missing` says what was not supplied, not that the run will fail.
 */
export const applySecrets: ApplySecrets = (operation, input, secrets) => {
  const out = stripInput(operation, isPlainObject(input) ? input : {}, []);
  const headers: Record<string, string> = {};
  const used = new Set<SecretKind>();
  const given: Partial<Record<SecretKind, string>> = isPlainObject(secrets) ? secrets : {};
  const route = SECRET_ROUTES[routeKey(operation)];

  for (const kind of Object.keys(given) as SecretKind[]) {
    const value = given[kind];
    if (typeof value !== 'string' || value === '') continue;
    let ok = true;
    let placed = false;
    if (kind === 'closing_password') {
      // Any write can need it (a date in a closed period), not only the ones that list it.
      placed = true;
      if (headerSafe(value)) headers[CLOSING_PASSWORD_HEADER] = value;
      else ok = false;
    }
    const spot = route?.place[kind];
    if (spot) {
      placed = true;
      // A mail password only for a server the approval line shows in full (guardInput refuses
      // the others first; this holds even when it was not asked).
      if (kind === 'mail_password' && mailServerOf(operation, out) === 'not_shown') ok = false;
      else ok = place(spot, value, out, headers) && ok;
    }
    if (placed && ok) used.add(kind);
  }

  const needed = listOf(operation.needsSecret) as SecretKind[];
  const missing = needed.filter((k) => {
    if (used.has(k)) return false;
    const v = given[k];
    const supplied = typeof v === 'string' && v !== '';
    const hasPlace = k === 'closing_password' || Boolean(route?.place[k]);
    // Given, with nowhere to go on a route: not missing (a shell flow takes its secrets itself).
    return !(supplied && !hasPlace);
  });
  return { input: out, headers, missing };
};

// ---------------------------------------------------------------------------
// redactAnswer and masking
// ---------------------------------------------------------------------------

/** lib/permissions/mask.ts SSN_KEYS and ACCOUNT_KEYS (the field names the app masks for people). */
const SSN_KEYS: ReadonlySet<string> = new Set(['ssn', 'employeeSsn', 'taxId']);
const ACCOUNT_KEYS: ReadonlySet<string> = new Set(['accountNumber', 'routingNumber', 'bankAccountNumber']);
/** Sensitive-field names that are secrets, never protected data: no reveal ever shows them. */
const SECRET_ANSWER_NAMES: ReadonlySet<string> = new Set([
  ...SECRET_FIELD_NAMES,
  'token',
  'secret',
  'otpauthUrl',
  'recoveryCodes',
  'answer',
  'fileKey',
  'temporaryPassword',
  'tempPassword',
]);
/**
 * Answer fields masked in every answer, listed by the operation or not, reveal or not: the names in
 * SECRET_ANSWER_NAMES that only ever hold a secret. Not 'token' (also a word for harmless things,
 * such as a page cursor) nor 'answer' (an AI answer is the point of the call): those are masked
 * where an operation lists them, and a produced link is found by its operation's own entry.
 */
const ALWAYS_SECRET_NAMES: ReadonlySet<string> = new Set([...SECRET_ANSWER_NAMES].filter((k) => k !== 'token' && k !== 'answer'));

type DataKind = 'ssn' | 'account' | 'other' | 'secret';

/** What a sensitive field holds, from its last name: what decides whether a reveal shows it. */
function fieldKind(path: string): DataKind {
  const last = path.split('.').pop() ?? '';
  if (SECRET_ANSWER_NAMES.has(last)) return 'secret';
  if (SSN_KEYS.has(last)) return 'ssn';
  // A memo is protected for the account number the app writes into it ("Acct # …").
  if (ACCOUNT_KEYS.has(last) || /memo$/i.test(last)) return 'account';
  return 'other';
}

/**
 * The kinds of protected data a reveal shows. A reveal on an operation that names what it reveals
 * shows that kind (policy.ts asks the approver for that flag alone). A read_sensitive operation
 * also shows every field it lists (the approver held each one's flag), and so does a reveal on an
 * operation that names nothing (only an Admin approves those). Secrets are never a kind a reveal shows.
 */
function revealedKinds(operation: Operation, reveal: boolean): ReadonlySet<DataKind> {
  const kinds = new Set<DataKind>();
  if (!reveal) return kinds;
  kinds.add('other');
  const named = operation.reveal ?? null;
  if (named === 'account_numbers') kinds.add('account');
  else if (named === 'ssn' || named === 'payroll') kinds.add('ssn');
  else if (named !== null) {
    kinds.add('ssn');
    kinds.add('account');
  }
  if (operation.class === 'read_sensitive' || named === null) {
    for (const p of listOf(operation.sensitiveFields)) {
      const k = fieldKind(p);
      if (k !== 'secret') kinds.add(k);
    }
  }
  if (named === null && !kinds.has('ssn') && !kinds.has('account')) {
    kinds.add('ssn');
    kinds.add('account');
  }
  return kinds;
}

/** One masked value: SSNs and account numbers keep their last 4, anything else shows nothing. */
function maskValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || value === PRODUCED_SECRET_TEXT) return value;
  if (SSN_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number')) return maskSsn(value);
  if (ACCOUNT_KEYS.has(key) && (typeof value === 'string' || typeof value === 'number')) return maskAccountNumber(value);
  if (value === '') return value;
  return MASKED_TEXT;
}

/**
 * The label before an account number in text: "Acct #", "Account No.", "A/C Number:" and the like,
 * also inside a word ("BankAcct#"). "No" and "Number" only as words of their own ("Acct Now" is not one).
 */
const ACCT_LABEL = /(?:Acct|Account|A\/C)s?\.?\s*(?:#|No(?![a-z])\.?|Number(?![a-z]))\s*:?\s*/gi;

/**
 * The words "Account number" written out in full (no "#", no "No", no colon): how the app starts
 * its own sentences about a chart-of-accounts number (see appChartNumberSentence).
 */
const PLAIN_ACCOUNT_NUMBER_LABEL = /^Accounts?\s+Number\s+$/i;

/**
 * A chart-of-accounts number: one word of digits, groups joined by "." or "-" ("1000", "6100.10",
 * "1000-2"), short (7 digits at most, as charts of accounts number them) and not starting with 0
 * (a bank or vendor number often does: "0001234"). Not protected.
 */
function chartNumberShaped(word: string): boolean {
  return /^[1-9]\d*(?:[.-]\d+)*$/.test(word) && word.replace(/\D/g, '').length <= 7;
}

/**
 * The rest of lib/services/qbGlImport.ts's warning after the number, word for word:
 *   `Account number ${a.number} is already used, so "${a.fullName}" was created as ${code}.`
 * (the account's name in quotes, the code it got, a full stop, then the end of the text or a
 * space). Only that whole sentence: "is used for autopay", "was created by the utility" or "is
 * already used" alone are words someone typed, and their number stays masked.
 */
const GL_IMPORT_SENTENCE_REST = /^ is already used, so "[^"\r\n]*" was created as [^\s"]+\.(?=$|\s)/;

/**
 * Whether the plain words "Account number" at `at`, then `number`, are one of the app's own
 * sentences about a chart-of-accounts number, the number shaped like one (chartNumberShaped):
 *  - qbGlImport.ts's warning, in its full wording (GL_IMPORT_SENTENCE_REST), with a capital "A",
 *    starting the text or a clause (nothing before it, or ".", ";", ":", "!", "?" or "(");
 *  - qbGlParse.ts's reason for a guessed account type, which is the whole text, in small letters:
 *    exactly "account number 6100".
 * Anything else is a number someone wrote down and stays masked: "Account number 4471234" (a whole
 * memo), "Utilities: Account number 4471234", "Account number 4471234 is used for autopay",
 * "Account number 4471234 was created by the utility", "Vendor account number 4471234",
 * "BankAccount number 12345", "Account number 1234567 is the bank", "Account number 0001234".
 */
function appChartNumberSentence(text: string, at: number, number: string, after: string): boolean {
  if (!chartNumberShaped(number)) return false;
  if (text === `account number ${number}`) return true;
  if (!text.startsWith('Account number ', at)) return false;
  const before = text.slice(0, at).trimEnd();
  return (before === '' || /[.;:!?(]$/.test(before)) && GL_IMPORT_SENTENCE_REST.test(after);
}

/**
 * What ends a word an email address could sit in: spaces and the marks that part the items of a
 * list ("," and ";"), the ones the mailer splits recipients at. Nothing else does: the routes'
 * own checks take every other mark inside one address (see EMAIL_ADDRESS).
 */
const WORD_STOP = /[\s,;]/;
/**
 * One email address and nothing else, the way the app's senders take one: exactly one "@", a domain
 * with a dot in it, and no space, "," or ";". That is lib/services/salesForms.ts EMAIL_ADDRESS_RE;
 * emailSettings.ts EMAIL_RE takes less, and the reminder's check in attention.ts takes no "<" or ">"
 * but does take "," and ";", which the mailer reads as two recipients (see addressItemAt). The
 * mailer delivers what they take: "billing.acct#7'x@evil.com", "billing.acct#7(x)@evil.com",
 * 'billing.acct#7"@evil.com' and "billing.acct#7[x]@evil.com" all go to evil.com (nodemailer drops
 * the "(x)" and the stray quote), and "Name<x@evil.example>" goes to x@evil.example. So every mark
 * but those three can be part of an address, and is. This broad shape is only for masking (an
 * address is never masked as an account number); what an agent may SEND is a plain address
 * (plainAddress, RECIPIENT_FIELDS).
 */
const EMAIL_ADDRESS = /^([^\s@,;]+)@([^\s@,;]+\.[^\s@,;]+)$/;

/** Where the word holding `at` starts and ends (WORD_STOP ends one). */
function wordAround(text: string, at: number): { start: number; end: number } {
  let start = at;
  while (start > 0 && !WORD_STOP.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && !WORD_STOP.test(text[end])) end++;
  return { start, end };
}

/**
 * When the label at `at`, `length` characters long, lies inside one word that is an email address
 * ("billing.acme.com.acct#7@evil.com", "billing.acct#7'x@evil.com", "Name.acct#7<x@evil.example>",
 * "acctno1@evil.example"), where that word ends; otherwise null. An address is not an account
 * number, and masking from a label inside it would hide its domain: the line would show
 * "billing.acme.com.acct#••••.com", which reads as an acme.com address, for mail that goes to
 * evil.com. A label with a space in it ("Acct # 7@evil.com") is never inside one word, so it is
 * masked as before.
 */
function addressAround(text: string, at: number, length: number): number | null {
  const { start, end } = wordAround(text, at);
  if (at + length > end) return null;
  return EMAIL_ADDRESS.test(text.slice(start, end)) ? end : null;
}

/**
 * Where a list of addresses starts after an account number: the first "," or ";" in `rest` that an
 * email address follows ("Acct # 1234, ap@acme.com"); rest.length when there is none. An address
 * is another item, never part of the number, and the mailer reads it as one: the reminder's check
 * (lib/services/attention.ts) takes "," in a recipient, and "acct#1,b@evil.com" is mailed to
 * b@evil.com. Masked with the number, the stored request would never say so.
 */
function addressItemAt(rest: string): number {
  const separator = /[,;]\s*/g;
  for (let m = separator.exec(rest); m !== null; m = separator.exec(rest)) {
    const from = m.index + m[0].length;
    if (from < rest.length && EMAIL_ADDRESS.test(rest.slice(from, wordAround(rest, from).end))) return m.index;
  }
  return rest.length;
}

/**
 * "Acct # 000123456789" shows as "Acct # ••••6789". It is the memo the print queue and liability
 * checks write when a check's memo is blank (lib/services/printQueue.ts, liabilityPayments.ts),
 * with the payee's full account number. That number is free text of up to 100 characters (a
 * vendor's accountNumber: "#12345678", "(0001234567)", "1234 - 5678", "12_34567890", "1234,5678",
 * even a line break), so nobody can tell where it ends. As liabilityPayments.ts checkMemoFor does
 * for people, everything after the label to the end of the text is masked, keeping its last 4
 * characters that are not spaces: no punctuation inside the number can end the mask early. That
 * errs on the safe side: "Paid Acct # 1234, thanks" shows as "Paid Acct # ••••anks".
 * That is for a label with "#" ("Acct #" is the app's own). The one thing that ends it early is
 * a list of addresses after a "," or ";" ("Acct # 1234, ap@acme.com", addressItemAt): an address
 * is never part of a number, and it may be where mail goes.
 *
 * Only bank and vendor account numbers are protected; chart-of-accounts numbers are not, and the
 * app's own sentences about them start with the same words ("Account number 1000 is already
 * used …"). So after the other labels only the number itself is masked (the words that follow the
 * label up to the last one holding a digit, stopping at the first ordinary word: one with a small
 * letter and no digit; "1234 5678", "AB-12 CD-34" and "SMITH 0012" are numbers of several words),
 * and only where it is a bank or vendor number:
 *  - after a label written the way such numbers are labelled ("Acct No", "A/C Number", "Account
 *    No.", "Account Number:" with its colon), always;
 *  - after the plain words "Account number", unless they are one of the app's own sentences about
 *    a chart-of-accounts number in their full wording (appChartNumberSentence): "Account number
 *    1000 is already used, so "Checking" was created as 1000-2." stays as it is; "Account number
 *    12345678.", "Account number 4471234" (a whole memo), "Account number 4471234 is used for
 *    autopay", "Vendor account number 4471234" and "Account number 1234567 is the bank" do not.
 * "Account number must be unique" holds no number, so nothing in it is masked. A label inside an
 * email address ("billing.acct#7@acme.com", "billing.acct#7'x@evil.com") is part of the address,
 * not a label (addressAround): the address stays whole, so a recipient reads, is stored and is
 * answered as it is.
 */
export function maskAccountsInText(text: string): string {
  const label = new RegExp(ACCT_LABEL.source, ACCT_LABEL.flags);
  let out = '';
  let from = 0;
  for (let m = label.exec(text); m !== null; m = label.exec(text)) {
    const end = m.index + m[0].length;
    const address = addressAround(text, m.index, m[0].trimEnd().length);
    if (address !== null) {
      label.lastIndex = address;
      continue;
    }
    // The number runs no further than a list of addresses after it.
    const rest = text.slice(end, end + addressItemAt(text.slice(end)));
    if (rest.trim() === '') {
      label.lastIndex = end + rest.length;
      continue;
    }
    if (m[0].includes('#')) {
      out += `${text.slice(from, end)}${maskAccountNumber(rest) ?? MASKED_TEXT}`;
      from = end + rest.length;
      label.lastIndex = from;
      continue;
    }
    const n = numberAtStart(rest);
    // A sentence that only starts like a label: a real one may still follow ("…; Acct # SMITHJ").
    if (n === 0) continue;
    const number = rest.slice(0, n);
    // A chart-of-accounts number in the app's own words: left as it is, and the search goes on after it.
    if (PLAIN_ACCOUNT_NUMBER_LABEL.test(m[0]) && appChartNumberSentence(text, m.index, number, text.slice(end + n))) {
      label.lastIndex = end + n;
      continue;
    }
    out += `${text.slice(from, end)}${maskAccountNumber(number) ?? MASKED_TEXT}`;
    from = end + n;
    label.lastIndex = from;
  }
  return `${out}${text.slice(from)}`;
}

/**
 * How long the account number at the start of `rest` is (after a longer label): the words up to
 * the last one holding a digit, before the first ordinary word. Sentence punctuation after it
 * stays outside. 0 when no word there holds a digit.
 */
function numberAtStart(rest: string): number {
  const word = /\S+/g;
  let end = 0;
  for (let m = word.exec(rest); m !== null; m = word.exec(rest)) {
    if (/\d/.test(m[0])) end = m.index + m[0].length;
    else if (/\p{Ll}/u.test(m[0])) break;
  }
  if (end === 0) return 0;
  return rest.slice(0, end).replace(/[.,;:!?]+$/, '').length;
}

/**
 * Mask protected values in `value` (an answer, or the body or query of a stored request), in place:
 *  1. the operation's sensitive fields, unless a reveal shows their kind (secrets never);
 *  2. SSNs, tax IDs and account numbers anywhere, unless a reveal shows their kind (D6: one reveal
 *     at a time, whatever the agent's role allows);
 *  3. secret field names anywhere, always;
 *  4. "Acct # <number>" inside any text, unless account numbers are revealed.
 */
function maskInPlace(operation: Operation, root: unknown, shown: ReadonlySet<DataKind>): unknown {
  for (const path of listOf(operation.sensitiveFields)) {
    const kind = fieldKind(path);
    if (kind !== 'secret' && shown.has(kind)) continue;
    for (const p of placesAt(root, path)) {
      if (p.value === PRODUCED_SECRET_TEXT) continue;
      setOwn(p.parent, p.key, maskValue(p.key, p.value));
    }
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return shown.has('account') ? node : maskAccountsInText(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }
    if (!isPlainObject(node)) return node;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (ALWAYS_SECRET_NAMES.has(k)) setOwn(node, k, maskValue(k, v));
      else if (SSN_KEYS.has(k) && !shown.has('ssn')) setOwn(node, k, maskValue(k, v));
      else if (ACCOUNT_KEYS.has(k) && !shown.has('account')) setOwn(node, k, maskValue(k, v));
      else setOwn(node, k, walk(v));
    }
    return node;
  };
  return walk(root);
}

/**
 * The operation's protected values masked in a copy of `value`, as an answer is (see redactAnswer).
 * For the request store, logs and previews: a reveal the person approved shows what it reveals.
 */
export function maskSensitiveFields(operation: Operation, value: unknown, opts: { reveal: boolean }): unknown {
  return maskInPlace(operation, stripSecrets(clone(value)), revealedKinds(operation, opts.reveal === true));
}

/**
 * An agent's input as a request stores and shows it: everything guardInput strips is gone, and
 * protected values in the body and query are masked (the agent typed them; nobody else needs to
 * read them back from a request).
 */
export function maskInput(operation: Operation, input: OperationInput, opts: { reveal: boolean } = { reveal: false }): OperationInput {
  const out = stripInput(operation, isPlainObject(input) ? input : {}, []);
  const shown = revealedKinds(operation, opts.reveal === true);
  if (out.body !== undefined) out.body = maskInPlace(operation, out.body, shown);
  if (out.query !== undefined) out.query = maskInPlace(operation, out.query, shown) as Record<string, string | string[]>;
  return out;
}

function producedText(v: unknown): string | null {
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) {
    const items = v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
    return items.length > 0 ? items.join('\n') : null;
  }
  if (isPlainObject(v)) return JSON.stringify(v);
  return null;
}

/** Every place an own key named one of `names` sits, at any depth. */
function placesNamed(root: unknown, names: readonly string[]): PathPlace[] {
  const out: PathPlace[] = [];
  const walk = (node: unknown, trail: string[]) => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, [...trail, String(i)]));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const k of Object.keys(node)) {
      const p = [...trail, k];
      if (names.includes(k)) out.push({ parent: node, key: k, path: p.join('.'), value: node[k] });
      else walk(node[k], p);
    }
  };
  walk(root, []);
  return out;
}

/** Replace every produced value wherever it still appears (inside a link, a message, a key). */
function scrubProduced(root: unknown, values: readonly string[]): unknown {
  if (values.length === 0) return root;
  const scrub = (s: string): string => {
    let out = s;
    for (const v of values) {
      if (out === v) return PRODUCED_SECRET_TEXT;
      // A short value inside other text could be anything; a key, token or password is long.
      if (v.length >= 6 && out.includes(v)) out = out.split(v).join(PRODUCED_SECRET_TEXT);
    }
    return out;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrub(node);
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node)) setOwn(out, scrub(k), walk(node[k]));
    return out;
  };
  return walk(root);
}

/**
 * The answer as the agent may read it: every secret the operation produced is replaced with
 * "Shown to the person who approved" (and handed back in `produced`, for the approver's screen
 * only, never stored), stored-secret fields are dropped, and protected values are masked unless a
 * person approved a reveal of them. For an approved read_sensitive run pass reveal: true: the
 * approver held the flags of what it shows.
 */
function holdsProduced(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '' && v !== PRODUCED_SECRET_TEXT;
}

/**
 * Every text inside a produced value long enough to be a secret (a link object found by name also
 * holds an id and a count), to find it again wherever else it was copied.
 */
function leafTexts(v: unknown, out: string[]): void {
  if (typeof v === 'string') {
    if (v.length >= 6) out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => leafTexts(x, out));
  else if (isPlainObject(v)) Object.values(v).forEach((x) => leafTexts(x, out));
}

export const redactAnswer: RedactAnswer = (operation, answer, opts) => {
  let out: unknown = stripSecrets(clone(answer));
  const produced: ProducedSecret[] = [];
  const found: string[] = [];
  const key = routeKey(operation);

  for (const kind of listOf(operation.producesSecret) as SecretKind[]) {
    const known = PRODUCED_PLACES[key]?.[kind];
    let places = known ? known.paths.flatMap((p) => placesAt(out, p)).filter((p) => holdsProduced(p.value)) : [];
    // Not where the table says (the route's answer changed shape, or the table does not know the
    // operation): look for the kind's own names anywhere, so the secret still never reaches the agent.
    if (places.length === 0) places = placesNamed(out, PRODUCED_FALLBACK_NAMES[kind] ?? []).filter((p) => holdsProduced(p.value));
    for (const p of places) {
      const text = producedText(p.value);
      if (text !== null) produced.push({ kind, label: known?.label ?? PRODUCED_LABELS[kind] ?? 'Secret', value: text });
      leafTexts(p.value, found);
      setOwn(p.parent, p.key, PRODUCED_SECRET_TEXT);
    }
  }

  out = maskInPlace(operation, out, revealedKinds(operation, opts?.reveal === true));
  out = scrubProduced(
    out,
    [...new Set([...produced.flatMap((s) => [s.value, ...s.value.split('\n')]), ...found])].filter((v) => v !== ''),
  );
  return { answer: out, produced };
};

// ---------------------------------------------------------------------------
// For describe.ts and the tests
// ---------------------------------------------------------------------------

/**
 * Whether a dotted path of this operation's input or answer holds something never shown as it is:
 * 'secret' (a password, a key: nothing of it shows), a kind of protected data (masked), or null.
 */
export function protectedKindOf(operation: Operation, path: string): 'secret' | 'ssn' | 'account' | 'other' | null {
  const last = path.split('.').pop() ?? '';
  if (SECRET_FIELD_NAMES.has(last) || SECRET_ANSWER_NAMES.has(last)) return 'secret';
  const route = SECRET_ROUTES[routeKey(operation)];
  if (route?.fields.some((f) => pathMatches(f, path))) return 'secret';
  for (const f of listOf(operation.sensitiveFields)) {
    if (pathMatches(f, path) || (f.startsWith('*.') && pathMatches(f.slice(2), path))) return fieldKind(f);
  }
  if (SSN_KEYS.has(last)) return 'ssn';
  if (ACCOUNT_KEYS.has(last)) return 'account';
  return null;
}

/**
 * A protected value as describe shows it: an SSN or account number keeps its last 4 (what anyone
 * without the View flag sees in the app); a secret, a memo or anything else shows nothing of itself.
 */
export function maskedForDisplay(path: string, kind: 'secret' | 'ssn' | 'account' | 'other', value: unknown): string {
  const scalar = typeof value === 'string' || typeof value === 'number';
  if (kind === 'ssn' && scalar) return maskSsn(value) ?? '';
  const last = path.split('.').pop() ?? '';
  if (kind === 'account' && scalar && !/memo$/i.test(last)) return maskAccountNumber(value) ?? '';
  return MASKED_TEXT;
}

/**
 * A character class of code point ranges, built from numbers: these characters must never sit in
 * the source as themselves (a direction mark in source text is itself a way to hide code).
 */
function charClass(ranges: ReadonlyArray<readonly [number, number]>, flags: string): RegExp {
  // \u{…} with the u flag, so code points past U+FFFF (the tag characters) are one character each.
  const u = (n: number) => `\\u{${n.toString(16)}}`;
  return new RegExp(`[${ranges.map(([a, b]) => (a === b ? u(a) : `${u(a)}-${u(b)}`)).join('')}]+`, `${flags}u`);
}

/** CR, LF, tab, vertical tab, form feed, NEL, line and paragraph separators. */
const LINE_BREAKS = charClass([[0x09, 0x0d], [0x85, 0x85], [0x2028, 0x2029]], 'g');
/**
 * Characters that show as nothing, or change how what follows them shows:
 *  - control characters, the soft hyphen, the combining grapheme joiner;
 *  - zero-width spaces and joiners, word joiner and invisible operators, the byte-order mark;
 *  - every direction mark, embedding, override and isolate (U+061C, U+200E, U+200F,
 *    U+202A-U+202E, U+2066-U+2069) and the old format controls beside them (U+206A-U+206F);
 *  - blank fillers that look like spaces or nothing (Hangul U+115F, U+1160, U+3164, U+FFA0; Khmer
 *    U+17B4, U+17B5; Mongolian U+180B-U+180F), variation selectors (U+FE00-U+FE0F,
 *    U+E0100-U+E01EF), interlinear annotation marks (U+FFF9-U+FFFB), musical format controls;
 *  - the tag characters U+E0000-U+E007F: invisible on screen, but a model reads them as text, so
 *    they could carry instructions to the agent inside a summary.
 */
const INVISIBLE = charClass(
  [
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0xad, 0xad],
    [0x034f, 0x034f],
    [0x061c, 0x061c],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x206f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff9, 0xfffb],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe007f],
    [0xe0100, 0xe01ef],
  ],
  'g',
);

/**
 * Text as it may show on a card or in a message: line breaks become spaces; control characters
 * and invisible marks are removed (direction marks such as U+202E would show "fdp.exe" as "exe.pdf");
 * spaces are collapsed; cut to `max` characters with "…".
 */
export function cleanText(value: string, max: number): string {
  const flat = value
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

/** The secret routes table's keys and where each kind goes: for guards.test.ts only. */
export const SECRET_ROUTE_TABLE: Readonly<Record<string, { fields: readonly string[]; kinds: readonly SecretKind[] }>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SECRET_ROUTES).map(([k, r]) => [k, { fields: r.fields, kinds: Object.keys(r.place) as SecretKind[] }]),
  ),
);
/** The produced-secret table's keys and kinds: for guards.test.ts only. */
export const PRODUCED_SECRET_TABLE: Readonly<Record<string, readonly SecretKind[]>> = Object.freeze(
  Object.fromEntries(Object.entries(PRODUCED_PLACES).map(([k, r]) => [k, Object.keys(r) as SecretKind[]])),
);
