/**
 * Agent full access: the one-line summary of a request, from its operation's describe template
 * ("Email invoice {number} to {to}"), for the approval card, the agent's answer and the activity
 * list (plan §4.3).
 *
 * The line is built from the operation and the request, never from the agent's own words, and a
 * person approves on it, so:
 *  - a value missing or null shows as nothing, never "null", "undefined" or "{to}", and the words
 *    that only led to it go with it (tidyMissing): "Send a test email to" becomes "Send a test
 *    email", "to account (empty …)" loses "to account", "at or above %" goes whole, a label with a
 *    colon ("; allow cloud AI:") goes, and an aside in parentheses whose every value is missing
 *    goes whole ("(on: {enabled})", "(to {to} when given)");
 *  - each value is cut to 60 characters, and line breaks, control characters and invisible marks
 *    (a U+202E mark reverses what follows it, so "Invoice<U+202E>fdp.exe" reads as "Invoiceexe.pdf") are removed;
 *    a list shows as many whole items as fit and then "and N more", so none is hidden unsaid;
 *  - the recipients of an email are never hidden (RECIPIENTS below): every one shows. A plain
 *    address shows with its domain whole and in small letters (the mailer treats "ACME.COM" as
 *    "acme.com", and "paypaI.com" with a capital i reads as what it is: "paypai.com"); when the line
 *    is short of room only the middle of the part before "@" is cut ("accounts…payable@acme.com"),
 *    never the domain, and never "and N more": past that the line is left long and wraps on the
 *    card. Any other recipient text (an address on file the route's answer names) shows as written
 *    and not in small letters, whole when it holds an "@" (recipientItems). guardInput takes only
 *    plain addresses from an agent (lib/agent/guards.ts
 *    RECIPIENT_FIELDS), so what shows is what the mailer reads;
 *  - a file path keeps its start and its whole file name, and is cut in the middle
 *    ("C:\Users\…\Backups\Books backup.ironbooks"): its end says where a file goes. Its start is
 *    the drive or the share, with the server, also when written as a device path
 *    ("\\?\UNC\server\share\"), and is never cut or masked. Its "." and ".." folders are resolved
 *    first ("C:\a\…\..\..\Public\x" is shown as the C:\Public\x it is), and a path that cannot be
 *    resolved for sure is shown whole (resolvedPath). guardInput takes only plain paths from an
 *    agent (lib/agent/guards.ts pathRefusal), so a cut never leaves out what decides where it goes;
 *  - a server name shows in full (see below); a line too long for 200 characters cuts its values
 *    shorter before it cuts its own words, and, as a last resort, its own words before its values;
 *  - passwords and keys never show, SSNs and account numbers show masked, and so does an account
 *    number inside any text ("Acct # ••••6789"); an email address is recognised before that and
 *    shows as it is ("billing.acct#7@evil.com" is an address at evil.com, not an account number),
 *    and a server name is never masked;
 *  - a record is named the way a person knows it where the door says how (`names`: a role's name
 *    for its id), or where the route's own answer names the record the request is about;
 *  - making or changing a memorized transaction lists its next three dates (plan §8, Recurring),
 *    worked out by the rules of lib/services/recurring.ts;
 *  - the values show exactly as rendered: the tidying of what a missing value leaves ("()", a
 *    dangling "to") is done on the template's own words only;
 *  - what the route did beats what the agent wrote: when the answer holds a value, it wins over a
 *    different one in the body (an agent can put fields in a body that the route ignores), and the
 *    amount is the larger of the body's and the answer's, as the policy reads it. When the body's
 *    cannot be read the answer's shows; when the answer's cannot, or no figure is given at all,
 *    the line says the amount is not known (AMOUNT_UNREADABLE_TEXT), as the policy reads it: the
 *    figure is never left off the card, and never replaced by one the route did not use;
 *  - only what the route reads fills a placeholder, from the one place its handler reads it: its
 *    own path parameters (an extra "params.to" cannot); a route with a body (a DELETE with one
 *    too) its body when it takes one in fields (a JSON body, or a form's `fields`; a file or a text
 *    body has none) and never its query, except the few names in QUERY_OF_BODY_ROUTES, which come
 *    from the query only; a route without a body its query. Otherwise a "query.to" on an invoice
 *    email would put on the card an address the route never sends to;
 *  - a password the approver types goes where the line says: an operation that sends it to a
 *    server the request names shows that server (SECRET_GOES_TO), in full and never cut, however
 *    long the rest of the line (cutKeepingFixed). A name that could not be shown so
 *    (lib/agent/guards.ts hostShownInFull) is refused by guardInput and never gets the password
 *    from applySecrets.
 *
 * Pure: no database, no Node.
 */
import type { DescribeRequest, OperationInput } from './contract';
import { amountShown } from './facts';
import {
  DEVICE_PATH_PREFIX,
  DOTS_ONLY_FOLDER,
  RECIPIENT_FIELDS,
  cleanText,
  hostShownInFull,
  maskAccountsInText,
  maskedForDisplay,
  pathField,
  plainAddress,
  protectedKindOf,
  recipientFieldName,
  valuesAt,
} from './guards';
import type { Operation } from './operations/types';

/** Longest a filled-in value may be, and the whole line. */
export const DESCRIBE_VALUE_MAX = 60;
export const DESCRIBE_LINE_MAX = 200;
/**
 * Longest a file path shows before its middle is cut. Longer than other values: the folder and the
 * file name say where a file goes, and a person approves where every company's books are copied.
 */
export const DESCRIBE_PATH_MAX = 120;

/**
 * What the line shows in place of a figure when none can be shown (facts.ts amountShown): the
 * route's answer holds none it can read, and the body's cannot be read or is not given ("Pay an
 * unknown amount of sales tax"). The policy then treats the request as over every limit.
 */
export const AMOUNT_UNREADABLE_TEXT = 'an unknown amount';

/**
 * The name a person knows a record by, by its id, as the door read it from the books before the
 * run: { "<role id>": "Clerk", "<invoice id>": "1042" }. A value that is one of these ids shows as
 * its name. Optional: without it a line shows the id (or the name the route's own answer gives).
 */
export type DescribeNames = Readonly<Record<string, string>>;

/** A placeholder: dotted names, "*" for every element of a list (only the clauses below use it). */
const PLACEHOLDER = /^\{([A-Za-z0-9_]+(?:\.(?:[A-Za-z0-9_]+|\*))*)\}$/;

/**
 * Routes with a body whose handler reads these placeholders from its query string instead (read
 * off each handler; describe.test.ts holds the table against the handlers' source). These names
 * come from the query only: a value planted under the same name in the body is never used. Every
 * other route with a body reads none of its placeholders from its query, so a value an agent put
 * there would only ever show on the card: it fills nothing.
 */
export const QUERY_OF_BODY_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The body is the backup file itself; the new company's name is req.nextUrl.searchParams 'name'.
  'POST /api/backup/company': ['name'],
  // saveCopyAs(searchParams 'target', { companyName, convert } from the body).
  'POST /api/company-file/save-as': ['target'],
});

/**
 * A clause naming where a password the approver types is sent, for an operation whose template
 * does not say so (lib/agent/guards.ts MAIL_SERVER_PATHS names the same servers). POST
 * /api/email/test puts the typed mail password into the draft set-up the agent wrote and connects
 * to that draft's server with it; PUT /api/email/settings saves it for the server the request
 * names. Without the server on the line an agent could ask for its own server and collect the
 * password. Added only when the template does not name it already; with no draft (the saved set-up
 * is tested, and no typed password is used) it shows nothing.
 */
export const SECRET_GOES_TO: Readonly<Record<string, { placeholder: string; clause: string }>> = Object.freeze({
  'POST /api/email/test': { placeholder: '{draft.host}', clause: ' through {draft.host}' },
  'PUT /api/email/settings': { placeholder: '{host}', clause: ' (mail server {host})' },
});

/**
 * Per operation that sends email, the recipients the line shows beyond its template's own words:
 *  - `answer`: where the route's answer says whom it sent to, when that is not under the same name
 *    (the statement email answers { to } for the address it took from body.email; a collection
 *    email and the Send Forms queue list each recipient in `sent`, the address on file included).
 *    What the route did beats what the agent wrote, as for every other value;
 *  - `clause`: added when the template does not name the recipients at all (the queue's own
 *    recipients, the mail set-up's copies and reply address, which every later email uses).
 * Every field of guards.ts RECIPIENT_FIELDS is on the line, by its template or by a clause here
 * (describe.test.ts holds the two together).
 */
export const RECIPIENTS_SHOWN: Readonly<Record<string, ReadonlyArray<{ placeholder: string; answer?: string; clause?: string }>>> = Object.freeze({
  'POST /api/sales-forms/statement-email': [{ placeholder: 'email', answer: 'to' }],
  'POST /api/collections/email': [{ placeholder: 'to', answer: 'sent.*.to' }],
  'POST /api/sales-forms/queue': [{ placeholder: 'items.*.to', answer: 'sent.*.to', clause: ' (to {items.*.to})' }],
  'PUT /api/email/settings': [
    { placeholder: 'bcc', clause: ' (a copy of every email to {bcc})' },
    { placeholder: 'replyTo', clause: ' (replies to {replyTo})' },
  ],
});

/**
 * Operations that make or change a memorized transaction, and where the route's answer holds the
 * template row (the schedule as saved: frequency, nextRunDate, anchorDay, remaining, mode,
 * isActive). Their line ends with the next three dates (RUN_DATES). `fromBody`: before its dry run
 * (no answer yet) the dates are worked out from the body alone, for a new schedule (anchored as
 * createTemplate anchors it), from only the fields its route reads from the body, which are
 * listed: a field it ignores must not change the line (body.remaining: 1 on the AI's memorize
 * would read "its last date" for a schedule saved with no limit). Every other schedule field is as
 * createTemplate saves a new one: active, no limit, and a mode that enters or reminds on each
 * date. A change cannot (null): updateTemplate keeps the stored day of the month (a template on
 * the 31st, moved to 2027-02-28, runs on 03-31, not 03-28), the stored mode and the stored count
 * left, none of which the body holds, so its line shows no dates until the dry run's answer says
 * what was saved.
 */
export const RECURRING_SCHEDULES: Readonly<Record<string, { answer: string | null; fromBody: readonly string[] | null }>> = Object.freeze({
  // createRecurringTemplateSchema; isActive is not one of its fields: createTemplate saves it active.
  'POST /api/recurring': { answer: null, fromBody: ['frequency', 'nextRunDate', 'mode', 'remaining'] },
  'PATCH /api/recurring/[id]': { answer: null, fromBody: null },
  // { template } (lib/services/aiRecurring.ts memorizeSuggestion through createTemplate).
  // memorizeSuggestionSchema takes no mode, count left or isActive (autoEnter only picks
  // automatic or remind, both of which run on each date).
  'POST /api/ai/recurring': { answer: 'template', fromBody: ['frequency', 'nextRunDate'] },
});

/** The placeholder the run dates fill (not a field of any body). */
const RUN_DATES = '__runDates';

/** A server name says where it goes: it shows in full when it can, and otherwise keeps its end. */
const HOST_NAMES = /^(?:host|hostname|smtpHost|server)$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function absent(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function isScalar(v: unknown): boolean {
  return ['string', 'number', 'bigint', 'boolean'].includes(typeof v);
}

/** A value as words. Objects show nothing of themselves; a list of them, how many. */
function asText(v: unknown): string {
  if (absent(v)) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) {
    if (v.every(isScalar)) return v.map(asText).filter((s) => s !== '').join(', ');
    return v.length === 1 ? '1 item' : `${v.length} items`;
  }
  return '';
}

function first(values: unknown[]): unknown {
  return values.find((v) => !absent(v));
}

function routeKey(operation: Pick<Operation, 'method' | 'route'>): string {
  return `${operation.method} ${operation.route}`;
}

/**
 * The fields of the body as the route reads them: a JSON body itself, a form's `fields` (the
 * bridge sends only those, and its files, as the form). A file body (bytes) or a text body has no
 * fields, so nothing beside it in the request fills a placeholder.
 */
function bodyFields(operation: Operation, input: OperationInput): unknown {
  if (operation.method === 'GET') return undefined;
  if (operation.body === 'json') return input.body;
  if (operation.body === 'multipart') return isPlainObject(input.body) ? input.body.fields : undefined;
  return undefined;
}

/** Every value a dotted name with a "*" names, or the first one of a plain name. */
function pick(root: unknown, name: string): unknown {
  const values = valuesAt(root, name);
  return name.includes('*') ? values.filter((v) => !absent(v)) : first(values);
}

/** The raw value for one placeholder, from the one place the route reads it (or the route's answer, which beats it). */
function lookup(operation: Operation, input: OperationInput, answer: unknown, name: string): unknown {
  if (operation.amountField && name === operation.amountField) {
    const amount = amountShown(operation, input, answer);
    return amount === 'unreadable' ? AMOUNT_UNREADABLE_TEXT : amount;
  }

  // The route's own path parameters name the record; they are never overruled.
  if (!name.includes('.') && Array.isArray(operation.params) && operation.params.includes(name)) {
    const v = isPlainObject(input.params) ? input.params[name] : undefined;
    if (!absent(v)) return v;
  }

  // One source, the one the handler reads the name from. A route with a body (a DELETE with one
  // too) reads it from the body, except the names its handler reads from its query, which it reads
  // there only (QUERY_OF_BODY_ROUTES: a value planted under the same name in the body would never
  // be used). A route without a body (a GET, the bridge refuses a body for one; a DELETE without
  // one) reads its query.
  const takesBody = operation.method !== 'GET' && operation.body !== 'none';
  const fromQueryOnly = !takesBody || (QUERY_OF_BODY_ROUTES[routeKey(operation)] ?? []).includes(name);
  const query: Record<string, unknown> = isPlainObject(input.query) ? input.query : {};
  let chosen: unknown;
  if (fromQueryOnly) {
    if (Object.prototype.hasOwnProperty.call(query, name)) chosen = query[name];
  } else {
    const fields = bodyFields(operation, input);
    if (fields !== undefined) chosen = pick(fields, name);
  }
  if (answer !== undefined) {
    // Where the route says whom it sent to under another name (RECIPIENTS_SHOWN), that is read.
    const alias = (RECIPIENTS_SHOWN[routeKey(operation)] ?? []).find((r) => r.placeholder === name)?.answer;
    const done = pick(answer, alias ?? name);
    if (!absent(done) && asText(done) !== asText(chosen)) return done;
  }
  return chosen;
}

/** `raw` with every id the door named shown as its name (DescribeNames). */
function withNames(raw: unknown, names: DescribeNames | undefined): unknown {
  if (!names) return raw;
  const one = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const key = v.trim();
    const named = Object.prototype.hasOwnProperty.call(names, key) ? names[key] : undefined;
    return typeof named === 'string' && named.trim() !== '' ? named : v;
  };
  return Array.isArray(raw) ? raw.map(one) : one(raw);
}

/**
 * Placeholders that say what a record will be called after the change, and the path parameter
 * that names the record: they show only when the request renames it. The route's answer holds the
 * record's name whether or not it changed, so a change of a role's permissions alone would read
 * "Change what role Clerk allows (called Clerk after the change)". So the name must be in the
 * body, and not be the name the record has now (DescribeNames, as the door read it); then the
 * answer's name, what was saved, shows as usual. Missing, the template's aside goes with it.
 */
export const RENAMED_TO: Readonly<Record<string, { placeholder: string; param: string }>> = Object.freeze({
  'PATCH /api/roles/[id]': { placeholder: 'name', param: 'id' },
});

/** Whether this request renames the record (RENAMED_TO): a name in its body other than the one it has now. */
function renames(operation: Operation, input: OperationInput, names: DescribeNames | undefined, spot: { placeholder: string; param: string }): boolean {
  const fields = bodyFields(operation, input);
  const given = isPlainObject(fields) && Object.prototype.hasOwnProperty.call(fields, spot.placeholder) ? fields[spot.placeholder] : undefined;
  if (typeof given !== 'string' || cleanText(given, Number.POSITIVE_INFINITY) === '') return false;
  const id = isPlainObject(input.params) ? input.params[spot.param] : undefined;
  const key = typeof id === 'string' ? id.trim() : '';
  const now = names && key !== '' && Object.prototype.hasOwnProperty.call(names, key) ? names[key] : undefined;
  // Compared as written (only the ends trimmed): a name that differs by a mark nobody can see is
  // still a rename, and the aside then says one happens.
  return !(typeof now === 'string' && now.trim() === given.trim());
}

/**
 * The record's name from the route's own answer, for the route's own [id]: the answer is that
 * record ({ id, name, … }, as a role's change answers), so "Change what role <id> allows" reads
 * "Change what role Clerk allows". Not when the request renames it (a name field in its body): the
 * answer then holds the new name, and the line would read as another record; the id stays.
 */
function nameFromAnswer(operation: Operation, input: OperationInput, answer: unknown, name: string, raw: unknown): unknown {
  if (name !== 'id' || !Array.isArray(operation.params) || !operation.params.includes('id') || typeof raw !== 'string') return raw;
  if (!isPlainObject(answer) || answer.id !== raw) return raw;
  const named = answer.name;
  if (typeof named !== 'string' || cleanText(named, Number.POSITIVE_INFINITY) === '') return raw;
  const fields = bodyFields(operation, input);
  if (isPlainObject(fields) && Object.keys(fields).some((k) => /name$/i.test(k))) return raw;
  return named;
}

// ---------------------------------------------------------------------------
// The next dates of a memorized transaction (the rules of lib/services/recurring.ts)
// ---------------------------------------------------------------------------
//
// A copy of recurring.ts's schedule helpers (advanceDate, storedAnchorFor, scheduleAnchor), which
// sit in a module that opens the database: describe stays pure. describe.test.ts holds this copy
// against recurring.ts projectOccurrences for every frequency and many start dates. Dates are at
// UTC midnight, as the service stores them, and all the arithmetic uses the UTC calendar.

const FREQUENCY_DAYS: Readonly<Record<string, number>> = { daily: 1, weekly: 7, biweekly: 14, every_four_weeks: 28 };
const FREQUENCY_MONTHS: Readonly<Record<string, number>> = { monthly: 1, bimonthly: 2, quarterly: 3, semiannually: 6, yearly: 12 };

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function monthDayAnchor(date: Date, anchorDay: number | null | undefined): number {
  const day = date.getUTCDate();
  if (anchorDay == null || !Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) return day;
  return Math.min(anchorDay, lastDayOfMonth(date.getUTCFullYear(), date.getUTCMonth())) === day ? anchorDay : day;
}

function addMonthsClamped(date: Date, months: number, anchorDay?: number | null): Date {
  const d = new Date(date);
  const dayOfMonth = monthDayAnchor(d, anchorDay);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(dayOfMonth, lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth())));
  return d;
}

function validAnchor(anchorDay: number | null | undefined): number | null {
  return anchorDay != null && Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 15 ? anchorDay : null;
}

function semimonthlyAnchor(date: Date): number {
  const dayOfMonth = date.getUTCDate();
  if (dayOfMonth <= 15) return dayOfMonth;
  if (dayOfMonth === lastDayOfMonth(date.getUTCFullYear(), date.getUTCMonth()) && dayOfMonth < 30) return 15;
  return Math.min(dayOfMonth - 15, 15);
}

function inSemimonthlyPair(date: Date, anchor: number): boolean {
  const dayOfMonth = date.getUTCDate();
  const last = lastDayOfMonth(date.getUTCFullYear(), date.getUTCMonth());
  return dayOfMonth === Math.min(anchor, last) || dayOfMonth === Math.min(anchor + 15, last);
}

/** The anchor createTemplate / updateTemplate store for a schedule starting on `date`. */
function storedAnchorFor(date: Date, frequency: string, stored: number | null | undefined): number {
  if (FREQUENCY_MONTHS[frequency] !== undefined) return monthDayAnchor(date, stored);
  const keep = validAnchor(stored);
  return keep != null && inSemimonthlyPair(date, keep) ? keep : semimonthlyAnchor(date);
}

function scheduleAnchor(frequency: string, anchorDay: number | null | undefined, date: Date): number | null {
  if (frequency === 'semimonthly') return validAnchor(anchorDay) ?? semimonthlyAnchor(date);
  return anchorDay ?? null;
}

function advanceDate(date: Date, frequency: string, anchorDay: number | null): Date | null {
  const days = FREQUENCY_DAYS[frequency];
  if (days !== undefined) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  }
  if (frequency === 'semimonthly') {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const dayOfMonth = date.getUTCDate();
    if (dayOfMonth <= 15) return new Date(Date.UTC(y, m, Math.min(dayOfMonth + 15, lastDayOfMonth(y, m))));
    return new Date(Date.UTC(y, m + 1, validAnchor(anchorDay) ?? semimonthlyAnchor(date)));
  }
  const months = FREQUENCY_MONTHS[frequency];
  return months === undefined ? null : addMonthsClamped(date, months, anchorDay);
}

/**
 * The first `count` run dates of a schedule starting on `start` (YYYY-MM-DD), as the Memorized
 * Transaction List and the calendar project them. `anchorDay` is the template's stored anchor;
 * left out, the one createTemplate stores for that start. Empty for 'never' or an unknown frequency.
 */
export function nextRunDates(start: Date, frequency: string, count: number, anchorDay?: number | null): string[] {
  if (FREQUENCY_DAYS[frequency] === undefined && FREQUENCY_MONTHS[frequency] === undefined && frequency !== 'semimonthly') return [];
  const stored = anchorDay === undefined ? storedAnchorFor(start, frequency, null) : anchorDay;
  const anchor = scheduleAnchor(frequency, stored, start);
  const out: string[] = [];
  let d: Date | null = new Date(start);
  while (d && out.length < count) {
    out.push(d.toISOString().slice(0, 10));
    d = advanceDate(d, frequency, anchor);
  }
  return out;
}

/** A schedule date as the service reads one (new Date of an ISO date or date-time); null for anything else. */
function scheduleDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "next dates: 2026-12-01, 2027-01-01, 2027-02-01" for a request that makes or changes a memorized
 * transaction (RECURRING_SCHEDULES), from the template row the route answered (the schedule as
 * saved), else, for a new schedule only, from the body. Fewer when only that many entries remain;
 * nothing when it repeats never, is entered only when someone chooses Enter Now, is made inactive,
 * has none left, or its dates are not known yet (a change before its dry run: `fromBody`).
 */
function runDatesText(operation: Operation, input: OperationInput, answer: unknown): string {
  const spot = RECURRING_SCHEDULES[routeKey(operation)];
  if (!spot) return '';
  const fields = bodyFields(operation, input);
  const body = isPlainObject(fields) ? fields : {};
  const answered = answer === undefined ? undefined : spot.answer === null ? answer : valuesAt(answer, spot.answer)[0];
  const row = isPlainObject(answered) && 'nextRunDate' in answered ? answered : null;
  const reads = spot.fromBody;
  if (!row && reads === null) return '';
  // The saved row as it is; before the dry run, only what the route reads from the body.
  const get = (k: string): unknown => (row ? row[k] : reads !== null && reads.includes(k) ? body[k] : undefined);

  const frequency = get('frequency');
  const start = scheduleDate(get('nextRunDate'));
  if (typeof frequency !== 'string' || start === null) return '';
  if (get('mode') === 'never' || get('isActive') === false) return '';
  const remaining = get('remaining');
  const left = typeof remaining === 'number' && Number.isInteger(remaining) && remaining >= 0 ? remaining : null;
  if (left === 0) return '';
  const count = left === null ? 3 : Math.min(3, left);
  const anchorDay = row ? (typeof row.anchorDay === 'number' ? row.anchorDay : null) : undefined;
  const dates = nextRunDates(start, frequency, count, anchorDay);
  if (dates.length === 0) return '';
  if (left !== null && left <= 3) return left === 1 ? `its last date: ${dates[0]}` : `its last ${dates.length} dates: ${dates.join(', ')}`;
  return `next dates: ${dates.join(', ')}`;
}

// ---------------------------------------------------------------------------
// One value as the line shows it
// ---------------------------------------------------------------------------

function length(text: string): number {
  return Array.from(text).length;
}

/** Line breaks, control characters and invisible marks out (so none can split an "Acct #" label, or hide part of an address). */
function flat(text: string): string {
  return cleanText(text, Number.POSITIVE_INFINITY);
}

/** The last `max` characters of `text`, after "…": the end of a server name says where it goes. */
function keepEnd(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `…${chars.slice(chars.length - (max - 1)).join('').trimStart()}` : text;
}

/** The shortest the part before "@" is cut to: its first and last character around "…". */
const LOCAL_FLOOR = 3;

/** The part before "@" in `max` characters at most: its middle cut, so both its ends show. */
function cutLocal(local: string, max: number): string {
  const chars = Array.from(local);
  const room = Math.max(LOCAL_FLOOR, max);
  if (chars.length <= room) return local;
  const front = Math.ceil((room - 1) / 2);
  return `${chars.slice(0, front).join('')}…${chars.slice(chars.length - (room - 1 - front)).join('')}`;
}

/**
 * A plain address (lib/agent/guards.ts plainAddress) in `max` characters, its domain whole and in
 * small letters: only the middle of the part before "@" is cut, and never below LOCAL_FLOOR, so a
 * long domain makes the value longer than `max` rather than lose any of itself. Null when `text`
 * is not one plain address.
 */
function addressShown(text: string, max: number): string | null {
  const parts = plainAddress(text);
  if (!parts) return null;
  const domain = parts.domain.toLowerCase();
  return `${cutLocal(parts.local, max - length(domain) - 1)}@${domain}`;
}

/**
 * Text as a value may show, cut to `max`. A plain email address is recognised first, on the text
 * as it was written, and keeps its domain (addressShown): it is not an account number, and masking
 * an "acct#" inside it would hide its domain ("billing.acme.com.acct#••••.com" for mail that goes
 * to evil.com). Anything else has its account numbers masked and is cut at its end.
 */
function shown(text: string, max: number): string {
  const clean = flat(text);
  return addressShown(clean, max) ?? cleanText(maskAccountsInText(clean), max);
}

/**
 * A list of plain values that are not recipients (ids, names): as many whole items as fit, then
 * how many more, so a person always sees that there are others ("a1, a2 and 2 more").
 */
function listText(items: readonly unknown[], max: number): string {
  const raws = items.map((x) => flat(asText(x))).filter((s) => s !== '');
  const texts = raws.map((x) => shown(x, max));
  const more = (n: number) => (n > 0 ? ` and ${n} more` : '');
  for (let k = texts.length; k >= 1; k--) {
    const text = `${texts.slice(0, k).join(', ')}${more(texts.length - k)}`;
    if (length(text) <= max) return text;
  }
  if (texts.length === 0) return '';
  // Not even the first item fits whole: cut it (an address keeps its domain), and still say how many follow.
  const rest = more(texts.length - 1);
  return `${shown(raws[0], Math.max(2, max - length(rest)))}${rest}`;
}

/**
 * Text that is a list of addresses written as one ("a@acme.com, b@x.example"): items parted by ","
 * or ";", each a single word, at least one of them a plain address. Shown as a list (or as
 * recipients, in a recipient field).
 */
function addressList(text: string): string[] | null {
  const parts = flat(text).split(/\s*[,;]\s*/).filter((s) => s !== '');
  if (parts.length < 2 || parts.some((p) => /\s/.test(p))) return null;
  return parts.some((p) => plainAddress(p) !== null) ? parts : null;
}

/**
 * One recipient: a plain address (its domain whole, in small letters) or, for anything else, its
 * text: whole when it holds an "@" (the mailer may read a name, a quote or brackets around an
 * address its own way, so none of it is cut), cut as any value when it holds none (no mail can go
 * to it, and a long one would only push the others off the line).
 */
type RecipientItem = { local: string; domain: string } | { text: string };

/**
 * Every recipient a recipient field holds, one per item (text parted by "," or ";", the way the
 * mailer reads it; a list's elements). Account numbers are masked on the whole text first, so a
 * "," inside one cannot let its digits out; an address is never masked (maskAccountsInText).
 * guardInput takes only plain addresses from an agent; anything else here came from the books
 * (the route's answer: the address on file it sent to).
 */
function recipientItems(raw: unknown): RecipientItem[] {
  const out: RecipientItem[] = [];
  const add = (v: unknown) => {
    if (!isScalar(v)) return;
    for (const piece of maskAccountsInText(flat(asText(v))).split(/[,;]/)) {
      const item = piece.trim();
      if (item === '') continue;
      const parts = plainAddress(item);
      if (parts) out.push({ local: parts.local, domain: parts.domain.toLowerCase() });
      else out.push({ text: item.includes('@') ? item : cleanText(item, DESCRIBE_VALUE_MAX) });
    }
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else add(raw);
  return out;
}

/** The recipients joined, each part before "@" cut to `localMax`; everything else whole. */
function recipientsText(items: readonly RecipientItem[], localMax: number): string {
  return items.map((r) => ('text' in r ? r.text : `${cutLocal(r.local, localMax)}@${r.domain}`)).join(', ');
}

/** Whether a placeholder of this operation holds email recipients, which the line never hides. */
function isRecipientField(operation: Operation, name: string): boolean {
  const key = routeKey(operation);
  if ((RECIPIENT_FIELDS[key] ?? []).some((f) => f.path === name)) return true;
  if ((RECIPIENTS_SHOWN[key] ?? []).some((r) => r.placeholder === name)) return true;
  return recipientFieldName(name.split('.').pop() ?? name);
}

/**
 * Where a path starts: the part a cut never touches, which says what disk or server it is on. A
 * drive ("C:\", or "C:" alone), a share ("\\server\share\", also written "//server/share/"),
 * either of those as a device path ("\\?\C:\", "\\?\UNC\server\share\", "\\.\UNC\…",
 * "//?/UNC/…"), the top folder ("/" or "\") or "~/". '' for a relative path. Null when its start
 * does not say where it is: any other device path ("\\?\Volume{…}\", "\\.\pipe\…",
 * "\\?\GLOBALROOT\…", whose server or disk may come later), a share with no share name, three
 * slashes or more, or a server or share named only by dots. Such a path is never cut (cutPath).
 */
function pathRoot(text: string): string | null {
  const device = DEVICE_PATH_PREFIX.exec(text)?.[0] ?? '';
  const after = text.slice(device.length);
  let named: string | null;
  if (device !== '') named = /^(?:UNC[\\/][^\\/]+[\\/][^\\/]+(?:[\\/]|$)|[A-Za-z]:(?:[\\/]|$))/i.exec(after)?.[0] ?? null;
  else if (/^[\\/]{3}/.test(text)) named = null;
  else if (/^[\\/]{2}/.test(text)) named = /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.exec(text)?.[0] ?? null;
  else named = /^(?:[A-Za-z]:[\\/]?|[\\/]|~[\\/])/.exec(text)?.[0] ?? '';
  // The server and the share, past the device prefix's own "." ("\\.\"), are never only dots.
  return named === null || holdsDots(named) ? null : `${device}${named}`;
}

/** Whether a path, or a part of one, holds a folder of only dots and spaces ("..", "."): one a cut could hide. */
function holdsDots(text: string): boolean {
  return text.split(/[\\/]/).some((s) => DOTS_ONLY_FOLDER.test(s));
}

/**
 * A path with its "." and ".." folders resolved the way Windows, macOS and Linux all read them
 * ("C:\a\b\..\c" is "C:\a\c", and ".." never climbs above the drive, the share or "/"), so the
 * start the line shows is where the path really goes. Only where they read it the same, or where
 * only Windows reads it as a path at all: on a drive ("C:\"), a share ("\\server\share\"), or
 * under "/" with no "\" in it. Any other path with such a folder is left as written, and cutPath
 * never cuts it: a device path (Windows does not resolve its dots), a relative one, one under "\"
 * or "~/" alone ("\" is part of a name on macOS and Linux, and a route reads "~" as a folder's
 * name), a share written "//server/share/" (on macOS and Linux that is "/server/share/", where
 * ".." climbs past the server), and a folder of dots other than "." and ".." ("...", ".. "),
 * which Windows reads its own way. `plain`: the text as written held
 * no mark the line removes (a removed mark could have made ".\u200b." look like ".."). guardInput
 * refuses all of these from an agent (lib/agent/guards.ts pathRefusal); this is for the rest.
 */
function resolvedPath(text: string, plain: boolean): string {
  const root = pathRoot(text);
  if (!plain || root === null) return text;
  const rest = text.slice(root.length);
  if (!holdsDots(rest)) return text;
  const sure = /^[A-Za-z]:[\\/]$/.test(root) || (/^\\\\/.test(root) && !DEVICE_PATH_PREFIX.test(root)) || (root === '/' && !text.includes('\\'));
  const segs = rest.split(/[\\/]/);
  if (!sure || segs.some((s) => DOTS_ONLY_FOLDER.test(s) && s !== '.' && s !== '..')) return text;
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  const sep = text.includes('\\') ? '\\' : '/';
  const joined = out.join(sep);
  const rootEnd = /[\\/]$/.test(root) || joined === '' ? root : `${root}${sep}`;
  return `${rootEnd}${joined}${joined !== '' && /[\\/]$/.test(rest) ? sep : ''}`;
}

/**
 * A path with an account number in any of its folders masked there, so the file name after it
 * stays. Its start (pathRoot) is never masked: a drive or a server says where the file goes, and
 * no account number is one.
 */
function maskedPath(text: string): string {
  const root = pathRoot(text) ?? '';
  return `${root}${text
    .slice(root.length)
    .split(/([\\/])/)
    .map((piece) => (piece === '/' || piece === '\\' ? piece : maskAccountsInText(piece)))
    .join('')}`;
}

/**
 * A path in `max` characters: its start (pathRoot, and the first folders that fit) and its end
 * (the folders before the file and the file name), the middle cut ("C:\Users\…\Backups\Books
 * backup.ironbooks"). The file name is always whole, and the folder holding it whole when it fits:
 * a path too long even for that is left longer than `max`. A path whose start does not say where
 * it is, or that still holds a folder of only dots (resolvedPath could not resolve it for sure), is
 * never cut: what the cut left out could change where it goes.
 */
function cutPath(text: string, max: number): string {
  if (length(text) <= max) return text;
  const root = pathRoot(text);
  if (root === null || holdsDots(text.slice(root.length))) return text;
  const rest = text.slice(root.length);
  // Folders with their separator after them, then the last part (a file name, or the last folder).
  const segs = rest.match(/[^\\/]*[\\/]|[^\\/]+$/g) ?? [];
  let name = segs.length > 0 && !/[\\/]$/.test(segs[segs.length - 1]) ? (segs.pop() as string) : '';
  if (name === '' && segs.length > 0) name = segs.pop() as string;
  const sep = text.includes('\\') ? '\\' : '/';
  const gap = `…${sep}`;
  let head = root;
  let tail = name;
  let i = segs.length;
  let j = 0;
  const fits = (h: string, t: string) => length(h) + length(gap) + length(t) <= max;
  const growTail = () => {
    while (i > j && fits(head, segs[i - 1] + tail)) tail = segs[--i] + tail;
  };
  const growHead = (room: number) => {
    while (j < i && length(head) + length(segs[j]) <= room && fits(head + segs[j], tail)) head += segs[j++];
  };
  // The folder holding the file first, then the start up to a third of the room, then as much of
  // the end as fits, then of the start again.
  if (i > j && fits(head, segs[i - 1] + tail)) tail = segs[--i] + tail;
  growHead(Math.floor(max / 3));
  growTail();
  growHead(max);
  return j === i ? `${head}${tail}` : `${head}${gap}${tail}`;
}

/** The shortest a path is cut to: its start, "…", and the file name. */
function pathFloor(text: string): number {
  return length(cutPath(text, 0));
}

interface Value {
  /** What the placeholder held (absent: shows nothing). */
  raw: unknown;
  /** A server name shown in full, or the run dates: never cut, whatever the line's length. */
  fixed: boolean;
}

function valueOf(operation: Operation, input: OperationInput, answer: unknown, name: string, names: DescribeNames | undefined): Value {
  if (name === RUN_DATES) {
    const text = runDatesText(operation, input, answer);
    return { raw: text, fixed: text !== '' };
  }
  const rename = RENAMED_TO[routeKey(operation)];
  if (rename && rename.placeholder === name && !renames(operation, input, names, rename)) return { raw: undefined, fixed: false };
  const found = lookup(operation, input, answer, name);
  const named = withNames(found, names);
  const raw = named === found ? nameFromAnswer(operation, input, answer, name, found) : named;
  const last = name.split('.').pop() ?? name;
  const fixed = !protectedKindOf(operation, name) && HOST_NAMES.test(last) && hostShownInFull(raw);
  return { raw, fixed };
}

/** Each value's room on the line: lists keep theirs longest, so none is hidden first. */
interface Room {
  value: number;
  list: number;
}

type Kind = 'value' | 'fixed' | 'list' | 'recipients' | 'path';

/** A value as the line shows it, with what a later cut needs to cut it again from the whole. */
interface Rendered {
  text: string;
  kind: Kind;
  /** 'value' and 'path': the whole text as it may show, before it was cut to its room. */
  source?: string;
  /** 'recipients': each one. */
  recipients?: RecipientItem[];
}

function render(operation: Operation, name: string, value: Value, room: Room): Rendered {
  const { raw } = value;
  const one = (text: string, source?: string): Rendered => ({ text, kind: 'value', source });
  if (absent(raw)) return one('');
  const kind = protectedKindOf(operation, name);
  if (kind) return one(cleanText(maskedForDisplay(name, kind, raw), room.value));
  // Exactly the name the server is reached by (hostShownInFull allows nothing a mask or a cut would
  // change), or the run dates the app worked out.
  if (value.fixed && typeof raw === 'string') return { text: raw.trim(), kind: 'fixed' };
  if (isRecipientField(operation, name)) {
    const recipients = recipientItems(raw);
    return { text: recipientsText(recipients, Number.POSITIVE_INFINITY), kind: 'recipients', recipients };
  }
  if (Array.isArray(raw) && raw.every(isScalar)) return { text: listText(raw, room.list), kind: 'list' };
  const last = name.split('.').pop() ?? name;
  // A server name is never masked either: it says where something goes, and no account number is one.
  if (HOST_NAMES.test(last)) {
    const text = flat(asText(raw));
    return one(keepEnd(text, room.value), text);
  }
  const text = asText(raw);
  if (typeof raw === 'string' && pathField(name, flat(text))) {
    const path = maskedPath(resolvedPath(flat(text), flat(text) === text.replace(/\s+/g, ' ').trim()));
    return { text: cutPath(path, DESCRIBE_PATH_MAX), kind: 'path', source: path };
  }
  const addresses = typeof raw === 'string' ? addressList(text) : null;
  if (addresses) return { text: listText(addresses, room.list), kind: 'list' };
  const clean = flat(text);
  return one(shown(clean, room.value), plainAddress(clean) ? clean : maskAccountsInText(clean));
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  /** Where it starts in the template (UTF-16 index, as String.slice counts). */
  start: number;
  /** "{…}" text: a placeholder when `name` is set, else kept as it is and never searched for parentheses. */
  brace: boolean;
  name: string | null;
}

function tokensOf(template: string): Token[] {
  const out: Token[] = [];
  const re = /\{[^{}]*\}/g;
  let at = 0;
  for (let m = re.exec(template); m !== null; m = re.exec(template)) {
    if (m.index > at) out.push({ text: template.slice(at, m.index), start: at, brace: false, name: null });
    const p = PLACEHOLDER.exec(m[0]);
    out.push({ text: m[0], start: m.index, brace: true, name: p ? p[1] : null });
    at = m.index + m[0].length;
  }
  if (at < template.length) out.push({ text: template.slice(at), start: at, brace: false, name: null });
  return out;
}

/**
 * The template's asides in parentheses that hold a placeholder, every one of them missing: each is
 * dropped whole ("(on: {enabled})", "(to {to} when given)"), since what is left of it says nothing
 * or, worse, reads as a value ("(on)"). An aside that explains more after a ";" is kept: its own
 * empty value is tidied like any other ("(action: {action}; empty means void)" keeps "(empty means void)").
 */
function emptiedAsides(template: string, tokens: readonly Token[], empty: (t: Token) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const open: number[] = [];
  for (const t of tokens) {
    if (t.brace) continue;
    for (let i = 0; i < t.text.length; i++) {
      if (t.text[i] === '(') open.push(t.start + i);
      else if (t.text[i] === ')' && open.length > 0) {
        const from = open.pop() as number;
        const to = t.start + i;
        const inside = tokens.filter((x) => x.name !== null && x.start > from && x.start < to);
        if (inside.length === 0 || !inside.every(empty)) continue;
        if (template.slice(from + 1, to).replace(/\{[^{}]*\}/g, '').includes(';')) continue;
        out.push([from, to]);
      }
    }
  }
  return out;
}

/**
 * Small words that only lead to the value after them ("to {to}", "as of {date}", "dated {date}",
 * "at or above {n}%"). "and" and "or" join two values instead: see tidyMissing.
 */
const LEAD = String.raw`as\s+of|to|for|from|on|of|with|as|at|by|in|into|through|against|dated|costing|named|called|numbered|than|via|per|above|below|over|under|before|after|until|since|within|between`;
const NOT_A_LEAD = String.raw`(?!(?:${LEAD}|and|or)\b)`;
/**
 * The words that led to a missing value, at the end of the text before it: a small word (or a "/"
 * between choices), then at most two words that name the value ("to account", "with opening
 * balance", "/ other name"). Group 2 is the small word; group 3 the naming words.
 */
const LEAD_IN = new RegExp(String.raw`(^|\s)(${LEAD}|\/)((?:\s+${NOT_A_LEAD}[^\s{}()\[\],;:/]+){0,2})\s*$`, 'i');
/** "and" or "or" right before a missing value: "{a} and {b}" without b is "a". */
const JOINER_BEFORE = /(^|\s)(?:and|or)\s*$/i;
/**
 * All the text between two values, when it joins the missing second one to the first with naming
 * words: "{quantity} and opening value {value}", "{account} or class {class}". Only right after a
 * value: "profit and loss {period}" is a name of its own.
 */
const JOINED_LABEL = new RegExp(String.raw`^\s*(?:and|or)(?:\s+${NOT_A_LEAD}[^\s{}()\[\],;:/]+){1,2}\s*$`, 'i');
/** What a removed small word may leave: "at or" of "at or above". */
const LEAD_THEN_JOINER = new RegExp(String.raw`(^|\s)(?:${LEAD})\s+(?:or|and)\s*$`, 'i');
/** A verb whose small word belongs to it, not to the value: the "in" of "Sign in", the "on" of "Turn on". */
const PARTICLE_VERB = /(?:^|\s)(?:sign|log|turn|switch|check|opt|carry|roll|hand)\s+(?:in|on|over)\s*$/i;
/**
 * A label of its own before a missing value: "; allow cloud AI: {x}", ", label: {x}" (group 1 the
 * mark that starts it), or one opening an aside ("(action: {x}; …)", group 2).
 */
const LABEL_BEFORE = /(?:([;,])|(\())\s*[^;,():{}]*:\s*$/;
/** The text between two values, when it only joins them: "or", "and", "/" and up to two naming words. */
const JOINS_NEXT = /^\s*(?:or|and|\/)\s+(?:[^\s{}()\[\],;:/]+\s+){0,2}$/i;
/** A unit that only belongs to the value before it: "{n}%", "{n} percent", "{hours} hours". */
const UNIT_AFTER = /^(?:\s*%|\s+(?:percent|hours?|days?|miles?)\b)/i;
/** "{quantity} of assembly": the "of" goes with a missing quantity ("payment {id} of loan" keeps it). */
const OF_AFTER = /^\s+of\b/i;
const QUANTITY_NAME = /(?:quantity|qty|amount|total|count|hours|miles|percent|value)$/i;
/**
 * What may follow a missing value for the words that led to it to go too: the end of the line or of
 * a clause (",", ";", ".", ")", "(", ":"), another small word ("for {from} to {to}" with no start
 * date reads "to 2026-12-31"), or the start of a clause about the sentence ("… of bank account {id}
 * that a rule covers"). Not a word that goes on naming something: "to the {list} list" without the
 * list's name still reads "to the list".
 */
const CLAUSE_AFTER = new RegExp(String.raw`^\s*(?:$|[,;.!?)(:]|(?:${LEAD}|and|or|that|which|who|whose|when|where|if|unless|but)\b)`, 'i');

interface Seg {
  text: string;
  placeholder: boolean;
  /** The placeholder's name (placeholders only). */
  name?: string;
}

/**
 * Take away what only made sense with a missing value, from the end of the line backwards (so
 * "from {a} to {b}" with neither loses both "to" and "from"):
 *  - a unit right after it ("{n}%", "{n} percent"), and an "of" after a missing quantity or amount
 *    ("Build or unbuild {quantity} of assembly");
 *  - when it is one of two values joined by "or", "and" or "/" ("to account {a} or class {b}"):
 *    its naming words and the joining word, so the other value keeps the small word ("to class X");
 *  - a label with a colon of its own, from the ";" or "," that starts it ("; allow cloud AI:"), or
 *    inside an aside that opens with it ("(action:");
 *  - a second value's joining words right after the first value ("{a} or class {b}" without b is "a");
 *  - otherwise, where a clause ends after it (CLAUSE_AFTER), the words that led to it: a small word
 *    and up to two naming words ("to account", "dated", "as of the date"), and then an "at or" left
 *    by "at or above"; or a joining "and"/"or" right before it; or the colon of a title ("Client
 *    Data Review: {action}").
 */
function tidyMissing(segs: Seg[], amountField: string | null): void {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (!s.placeholder || s.text !== '') continue;
    const prev = i > 0 && !segs[i - 1].placeholder ? segs[i - 1] : null;
    const next = i + 1 < segs.length && !segs[i + 1].placeholder ? segs[i + 1] : null;
    const after = i + 2 < segs.length ? segs[i + 2] : null;

    if (next && UNIT_AFTER.test(next.text)) next.text = next.text.replace(UNIT_AFTER, '');
    if (!prev) continue;
    const rest = segs.slice(i + 1).map((x) => x.text).join('');

    // One of two values joined: "to account {a} or class {b}" without a is "to class b", and
    // "{a} or {b}" is "b". Without a small word to keep ("bill {a} or invoice {b}"), it is left be.
    if (next && after?.placeholder && after.text !== '' && JOINS_NEXT.test(next.text)) {
      const lead = LEAD_IN.exec(prev.text);
      if (lead || /^\s*(?:or|and|\/)\s*$/i.test(next.text)) {
        if (lead) prev.text = `${prev.text.slice(0, lead.index)}${lead[1]}${lead[2]} `;
        next.text = next.text.replace(/^\s*(?:or|and|\/)\s+/i, '');
        continue;
      }
    }

    const label = LABEL_BEFORE.exec(prev.text);
    if (label) {
      prev.text = label[2] ? prev.text.slice(0, label.index + label[0].indexOf('(') + 1) : prev.text.slice(0, label.index);
      continue;
    }
    if (i >= 2 && segs[i - 2].placeholder && JOINED_LABEL.test(prev.text)) {
      prev.text = '';
      continue;
    }

    const lead = CLAUSE_AFTER.test(rest) ? LEAD_IN.exec(prev.text) : null;
    if (lead && !(lead[3].trim() === '' && PARTICLE_VERB.test(prev.text))) {
      prev.text = prev.text.slice(0, lead.index);
      const left = LEAD_THEN_JOINER.exec(prev.text);
      if (left) prev.text = prev.text.slice(0, left.index);
      continue;
    }
    if (JOINER_BEFORE.test(prev.text)) {
      prev.text = prev.text.replace(JOINER_BEFORE, '');
      continue;
    }
    if (/:\s*$/.test(prev.text)) {
      prev.text = prev.text.replace(/\s*:\s*$/, '');
      continue;
    }
    const name = s.name ?? '';
    if (next && OF_AFTER.test(next.text) && (name === amountField || QUANTITY_NAME.test(name))) next.text = next.text.replace(OF_AFTER, '');
  }
}

/** Leftover punctuation and pairs emptied by a missing value. */
function tidy(line: string): string {
  return line
    .replace(/(^|[\s(])(["'])\2(?=$|[\s),.;:!?])/g, '$1') // ""
    .replace(/[“‘]\s*[”’]/g, '')
    .replace(/\(\s*(?:[A-Za-z][\w -]*:\s*)?\)/g, '') // () and (on: )
    .replace(/\(\s*[,;:]+\s*/g, '(') // "(, 12.00)": a separator left first in an aside
    .replace(/\s*[,;:]+\s*\)/g, ')') // "(apply, )": or last
    .replace(/\(\s*\)/g, '') // and an aside left with nothing
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+([,;:.!?)\]])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '');
}

/**
 * The room of each value, tried in turn while the line is too long: values are cut before the
 * line's own words are, other values before lists, and a server name shown in full, the
 * recipients and the run dates never (a path keeps DESCRIBE_PATH_MAX here).
 */
const ROOM_STEPS: readonly Room[] = [
  ...[DESCRIBE_VALUE_MAX, 48, 40, 32, 24, 16, 12].map((value) => ({ value, list: DESCRIBE_VALUE_MAX })),
  ...[48, 40, 32, 24, 16, 12].map((list) => ({ value: 12, list })),
];

/** Stands in for a value kept out of tidy(): a control character, which no shown value holds (cleanText removes them). */
const KEPT_MARK = '\u0001';
const KEPT_VALUE = /\u0001(\d+)\u0001/g;

/** A line with its values kept out (KEPT_MARK n KEPT_MARK), and those values. */
interface Built {
  tidied: string;
  kept: Rendered[];
}

function restore(built: Built): string {
  return cleanText(built.tidied.replace(KEPT_VALUE, (_m, n: string) => built.kept[Number(n)]?.text ?? ''), Number.POSITIVE_INFINITY);
}

/**
 * The last resort, for a line still too long with every value at its shortest. The values say what
 * the request touches and where it goes, so the line's own words are cut before any of them, the
 * longest stretch first, each at its end with "…"; the word that leads to a value stays with it
 * ("to", "through", "(mail server"). Then the values, the longest first: an email address in the
 * middle of the part before "@", anything else at its end; then a path, in its middle (its start
 * and its file name stay); then the recipients, the middle of the part before "@" of each, all to
 * one length. Never a domain, a list (it already says how many it leaves out), a server name shown
 * in full (where a typed password goes) or the run dates. Null when the line cannot get within
 * `max` that way because of what says where something goes (recipients, a path, a server name):
 * describeRequest then leaves it long, at full length, and it wraps on the card. A line with only
 * lists left is cut as any other line.
 */
function cutKeepingFixed(built: Built, max: number): string | null {
  type Role = 'words' | 'lead' | 'value' | 'path' | 'recipients' | 'kept';
  type Part = { text: string; role: Role; value?: Rendered };
  const parts: Part[] = [];
  let at = 0;
  for (const m of built.tidied.matchAll(KEPT_VALUE)) {
    const index = m.index ?? 0;
    const words = built.tidied.slice(at, index);
    // The word right before a value says what it is for: it stays, with the start of an aside it opens.
    const lead = /(?:\(\S*\s+)?\S+\s*$/.exec(words);
    parts.push({ text: lead ? words.slice(0, lead.index) : words, role: 'words' });
    if (lead) parts.push({ text: lead[0], role: 'lead' });
    const value = built.kept[Number(m[1])];
    const role: Role = !value ? 'kept' : value.kind === 'value' ? 'value' : value.kind === 'path' ? 'path' : value.kind === 'recipients' ? 'recipients' : 'kept';
    parts.push({ text: value?.text ?? '', role, value });
    at = index + m[0].length;
  }
  parts.push({ text: built.tidied.slice(at), role: 'words' });

  const total = () => parts.reduce((n, p) => n + length(p.text), 0);
  /** Cut the longest part of `role` by what the line is over, as `cut` cuts; false when none of them can be cut more. */
  const cutLongest = (role: Role, cut: (part: Part, to: number) => string | null): boolean => {
    for (const p of parts.filter((x) => x.role === role).sort((a, b) => length(b.text) - length(a.text))) {
      const next = cut(p, length(p.text) - (total() - max));
      if (next !== null && length(next) < length(p.text)) {
        p.text = next;
        return true;
      }
    }
    return false;
  };
  const cutWords = (p: Part, to: number): string | null => {
    const core = p.text.trim();
    if (length(core) <= 2) return null;
    const before = /^\s/.test(p.text) ? ' ' : '';
    const after = /\s$/.test(p.text) ? ' ' : '';
    return `${before}${cleanText(core, Math.max(2, to - before.length - after.length))}${after}`;
  };
  const cutValue = (p: Part, to: number): string | null => {
    const source = p.value?.source ?? p.text;
    const address = addressShown(source, to);
    if (address !== null) return address;
    if (length(p.text) <= 2) return null;
    // A value already cut to keep its end (a long server name) keeps it.
    return p.text.startsWith('…') ? keepEnd(source, Math.max(2, to)) : cleanText(source, Math.max(2, to));
  };
  const cutPathPart = (p: Part, to: number): string | null => {
    const source = p.value?.source ?? p.text;
    return cutPath(source, Math.max(pathFloor(source), to));
  };
  // The recipients: the part before "@" of each, all to one length, never below LOCAL_FLOOR.
  const recipients = parts.filter((p) => p.role === 'recipients' && p.value?.recipients);
  const longest = Math.max(0, ...recipients.flatMap((p) => (p.value?.recipients ?? []).map((r) => ('local' in r ? length(r.local) : 0))));
  const capRecipients = (cap: number) => {
    for (const p of recipients) p.text = recipientsText(p.value?.recipients ?? [], cap);
  };
  const cutRecipients = () => {
    for (let cap = longest - 1; total() > max && cap >= LOCAL_FLOOR; cap--) capRecipients(cap);
  };
  // First the recipients alone, so the line keeps all its words when that is enough ("Send to
  // accounts…payable@acme.com, …"); when it is not, they are put back whole and cut only after the
  // words, the other values and the paths.
  cutRecipients();
  if (total() > max) {
    capRecipients(longest);
    while (total() > max && cutLongest('words', cutWords));
    while (total() > max && cutLongest('value', cutValue));
    while (total() > max && cutLongest('path', cutPathPart));
    cutRecipients();
  }

  const line = cleanText(parts.map((p) => p.text).join(''), Number.POSITIVE_INFINITY);
  if (length(line) <= max) return line;
  const placeKept = parts.some((p) => p.role === 'recipients' || p.role === 'path' || (p.role === 'kept' && p.value?.kind === 'fixed'));
  return placeKept ? null : cleanText(line, max);
}

/**
 * Fill the operation's describe template. A missing value shows as nothing, never "null" or "{x}".
 * `names` (optional, beyond the contract's DescribeRequest): the name a person knows each record
 * by, by its id, as the door read it from the books (DescribeNames).
 */
export function describeRequest(operation: Operation, input: OperationInput, answer?: unknown, names?: DescribeNames): string {
  let template = typeof operation.describe === 'string' && operation.describe.trim() !== '' ? operation.describe : operation.id;
  const key = routeKey(operation);
  const goes = SECRET_GOES_TO[key];
  if (goes && !template.includes(goes.placeholder)) template = `${template}${goes.clause}`;
  for (const r of RECIPIENTS_SHOWN[key] ?? []) if (r.clause && !template.includes(`{${r.placeholder}}`)) template = `${template}${r.clause}`;
  if (RECURRING_SCHEDULES[key]) template = `${template} ({${RUN_DATES}})`;
  const safeInput: OperationInput = isPlainObject(input) ? input : {};
  const safeNames = isPlainObject(names) ? (names as DescribeNames) : undefined;

  const tokens = tokensOf(template);
  const values = new Map<Token, Value>();
  for (const t of tokens) if (t.name !== null) values.set(t, valueOf(operation, safeInput, answer, t.name, safeNames));
  const empty = (t: Token) => render(operation, t.name as string, values.get(t) as Value, ROOM_STEPS[0]).text === '';
  const dropped = emptiedAsides(template, tokens, empty);
  const gone = (at: number) => dropped.some(([a, b]) => at >= a && at <= b);

  const lineAt = (room: Room): Built => {
    const segs: Seg[] = [];
    // Every value shown is kept out of the tidying, which is for the template's own words: a value
    // shows exactly as rendered ("C:/Reports ()/x" keeps its "()", "-5.00" its sign, "[::1]" is not
    // a doubled colon).
    const kept: Rendered[] = [];
    for (const t of tokens) {
      if (t.name !== null) {
        if (gone(t.start)) continue;
        const rendered = render(operation, t.name, values.get(t) as Value, room);
        if (rendered.text !== '') {
          kept.push(rendered);
          segs.push({ text: `${KEPT_MARK}${kept.length - 1}${KEPT_MARK}`, placeholder: true, name: t.name });
        } else segs.push({ text: '', placeholder: true, name: t.name });
        continue;
      }
      let text = '';
      for (let i = 0; i < t.text.length; i++) if (!gone(t.start + i)) text += t.text[i];
      segs.push({ text, placeholder: false });
    }
    tidyMissing(segs, operation.amountField);
    return { tidied: tidy(segs.map((s) => s.text).join('')), kept };
  };

  let built: Built | null = null;
  for (const room of ROOM_STEPS) {
    built = lineAt(room);
    const line = restore(built);
    if (length(line) <= DESCRIBE_LINE_MAX) return line;
  }
  if (!built) return '';
  // Recipients (or a path, or a server name) too long for any line: every word and value as at
  // first, and the line wraps, rather than a line cut to pieces that is still too long.
  return cutKeepingFixed(built, DESCRIBE_LINE_MAX) ?? restore(lineAt(ROOM_STEPS[0]));
}

/** Held to the contract: a caller typed by DescribeRequest (three arguments) calls this same function. */
const contractShape: DescribeRequest = describeRequest;
void contractShape;
