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
 *    a list shows as many whole items as fit and then "and N more", so none is hidden unsaid; an
 *    email address too long to show keeps where it goes whole, its "@" and domain or the "<addr>"
 *    of "Name<addr>" (the middle of the name before "@", or the end of the display name, is cut);
 *    a server name shows in full (see below); a line too long for 200 characters cuts its values
 *    shorter before it cuts its own words, and, as a last resort, its own words before its values;
 *  - passwords and keys never show, SSNs and account numbers show masked, and so does an account
 *    number inside any text ("Acct # ••••6789"); an email address is recognised before that, on
 *    the text as written and in the shape the app's senders take one (any mark but a space, ","
 *    or ";", exactly one "@"), and shows as it is, domain and all ("billing.acct#7'x@evil.com" is
 *    an address at evil.com, not an account number), and a server name is never masked;
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
import { cleanText, emailAddressParts, hostShownInFull, maskAccountsInText, maskedForDisplay, protectedKindOf, valuesAt, type EmailAddressParts } from './guards';
import type { Operation } from './operations/types';

/** Longest a filled-in value may be, and the whole line. */
export const DESCRIBE_VALUE_MAX = 60;
export const DESCRIBE_LINE_MAX = 200;

/**
 * What the line shows in place of a figure when none can be shown (facts.ts amountShown): the
 * route's answer holds none it can read, and the body's cannot be read or is not given ("Pay an
 * unknown amount of sales tax"). The policy then treats the request as over every limit.
 */
export const AMOUNT_UNREADABLE_TEXT = 'an unknown amount';

const PLACEHOLDER = /^\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$/;

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
    if (fields !== undefined) chosen = first(valuesAt(fields, name));
  }
  if (answer !== undefined) {
    const done = first(valuesAt(answer, name));
    if (!absent(done) && asText(done) !== asText(chosen)) return done;
  }
  return chosen;
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

/**
 * The shortest an email address may be cut to (cutAddress) while what says where it goes stays
 * whole: that part, "…", and two characters of the name before "@" (none of a display name).
 */
function addressFloor(parts: EmailAddressParts): number {
  return length(parts.kept) + (parts.form === 'name' ? 1 : 3);
}

/**
 * One email address (lib/agent/guards.ts emailAddressParts, the shape the app's senders take), cut
 * to `max`. What says where it goes stays whole and as written: "@" and the domain, or in the
 * "Name<addr>" form the address in angle brackets, which is what the mailer delivers to. The rest
 * is cut: the middle of the name before "@" ("averylongmail…box@acme.com", "o'bri…team@evil.example"),
 * or the end of a display name ("billing.acme.com.payables.depa…<x@evil.example>"). A domain too
 * long even for that keeps its end, as a server name does. Null when `text` is not one address.
 */
function cutAddress(text: string, max: number): string | null {
  const parts = emailAddressParts(text);
  if (!parts) return null;
  if (length(text) <= max) return text;
  if (max < addressFloor(parts)) return keepEnd(parts.kept, max);
  const head = Array.from(parts.head);
  const room = max - length(parts.kept) - 1;
  if (parts.form === 'name') return `${head.slice(0, room).join('')}…${parts.kept}`;
  const front = Math.ceil(room / 2);
  return `${head.slice(0, front).join('')}…${head.slice(head.length - (room - front)).join('')}${parts.kept}`;
}

/**
 * An email address as a value shows it (cutAddress): in `max` characters or, when that is too few
 * to keep where it goes whole, in as many as that takes, up to DESCRIBE_VALUE_MAX. A line made
 * shorter to fit cuts its other values and its words instead; only a domain too long for a whole
 * value keeps its end. Null when `text` is not one address.
 */
function addressShown(text: string, max: number): string | null {
  const parts = emailAddressParts(text);
  return parts ? cutAddress(text, Math.max(max, Math.min(addressFloor(parts), DESCRIBE_VALUE_MAX))) : null;
}

/**
 * Text as a value may show, cut to `max`. An email address is recognised first, on the text as it
 * was written, and shows as it is (addressShown): it is not an account number, and masking an
 * "acct#" inside it would hide its domain ("billing.acme.com.acct#••••.com" for mail that goes to
 * evil.com). Anything else has its account numbers masked and is cut at its end.
 */
function shown(text: string, max: number): string {
  const clean = flat(text);
  return addressShown(clean, max) ?? cleanText(maskAccountsInText(clean), max);
}

/**
 * A list of plain values (recipients, ids): as many whole items as fit, then how many more, so a
 * person always sees that there are others ("a@acme.com, b@acme.com and 2 more"). Cutting the
 * joined text instead would hide the last ones behind "…", and the last could be the outside one.
 */
function listText(items: readonly unknown[], max: number): string {
  const texts = items.map((x) => shown(asText(x), max)).filter((s) => s !== '');
  const more = (n: number) => (n > 0 ? ` and ${n} more` : '');
  for (let k = texts.length; k >= 1; k--) {
    const text = `${texts.slice(0, k).join(', ')}${more(texts.length - k)}`;
    if (length(text) <= max) return text;
  }
  if (texts.length === 0) return '';
  // Not even the first item fits whole: cut it (an address keeps its domain), and still say how many follow.
  const rest = more(texts.length - 1);
  const room = Math.max(2, max - length(rest));
  return `${addressShown(texts[0], room) ?? cleanText(texts[0], room)}${rest}`;
}

/**
 * Text that is a list of recipients ("a@acme.com, b@x.example"): items parted by "," or ";", each a
 * single word, at least one of them an email address. Shown as a list, each address recognised on
 * the text as written (see shown), so none of them is masked away and none hides the ones after it.
 * The mailer reads the same text as several recipients, whatever the other items are: the
 * reminder's check (lib/services/attention.ts) takes "acct#1,b@evil.com" as one address, and the
 * mail goes to b@evil.com, so the line shows "acct#••••, b@evil.com".
 */
function addressList(text: string): string[] | null {
  const parts = flat(text).split(/\s*[,;]\s*/).filter((s) => s !== '');
  if (parts.length < 2 || parts.some((p) => /\s/.test(p))) return null;
  return parts.some((p) => emailAddressParts(p) !== null) ? parts : null;
}

interface Value {
  /** What the placeholder held (absent: shows nothing). */
  raw: unknown;
  /** A server name shown in full: never cut, whatever the line's length. */
  fixed: boolean;
}

function valueOf(operation: Operation, input: OperationInput, answer: unknown, name: string): Value {
  const raw = lookup(operation, input, answer, name);
  const last = name.split('.').pop() ?? name;
  const fixed = !protectedKindOf(operation, name) && HOST_NAMES.test(last) && hostShownInFull(raw);
  return { raw, fixed };
}

/** Each value's room on the line: lists (recipients) keep theirs longest, so none is hidden first. */
interface Room {
  value: number;
  list: number;
}

/** A value as the line shows it. `list`: shown as a list (listText), which says itself how many it leaves out. */
interface Rendered {
  text: string;
  list: boolean;
}

function render(operation: Operation, name: string, value: Value, room: Room): Rendered {
  const { raw } = value;
  const one = (text: string): Rendered => ({ text, list: false });
  if (absent(raw)) return one('');
  const kind = protectedKindOf(operation, name);
  if (kind) return one(cleanText(maskedForDisplay(name, kind, raw), room.value));
  // Exactly the name the server is reached by (hostShownInFull allows nothing a mask or a cut would change).
  if (value.fixed && typeof raw === 'string') return one(raw.trim());
  if (Array.isArray(raw) && raw.every(isScalar)) return { text: listText(raw, room.list), list: true };
  const last = name.split('.').pop() ?? name;
  // A server name is never masked either: it says where something goes, and no account number is one.
  if (HOST_NAMES.test(last)) return one(keepEnd(flat(asText(raw)), room.value));
  const text = asText(raw);
  const addresses = typeof raw === 'string' ? addressList(text) : null;
  return addresses ? { text: listText(addresses, room.list), list: true } : one(shown(text, room.value));
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
 * line's own words are, other values before lists (the recipients of an email stay whole longest),
 * and a server name shown in full never.
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
  kept: Array<{ text: string; fixed: boolean; list: boolean }>;
}

function restore(built: Built): string {
  return cleanText(built.tidied.replace(KEPT_VALUE, (_m, n: string) => built.kept[Number(n)]?.text ?? ''), Number.POSITIVE_INFINITY);
}

/**
 * The last resort, for a line still too long with every value at its shortest. The values say what
 * the request touches and where it goes, so the line's own words are cut before any of them, the
 * longest stretch first, each at its end with "…"; the word that leads to a value stays with it
 * ("to", "through", "(mail server"). Only then the values, the longest first: an email address in
 * the middle of its name, never its domain (cutAddress), anything else at its end. Never a list,
 * which already says how many it leaves out, nor a server name shown in full (where a typed
 * password goes): only if those alone fill the line is it cut as any other line.
 */
function cutKeepingFixed(built: Built, max: number): string {
  type Part = { text: string; role: 'words' | 'lead' | 'value' | 'kept' };
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
    parts.push({ text: value?.text ?? '', role: value && !value.fixed && !value.list ? 'value' : 'kept' });
    at = index + m[0].length;
  }
  parts.push({ text: built.tidied.slice(at), role: 'words' });

  const total = () => parts.reduce((n, p) => n + length(p.text), 0);
  /** Cut the longest part of `role` by what the line is over, as `cut` cuts; false when none of them can be cut more. */
  const cutLongest = (role: Part['role'], cut: (text: string, to: number) => string | null): boolean => {
    for (const p of parts.filter((x) => x.role === role).sort((a, b) => length(b.text) - length(a.text))) {
      const next = cut(p.text, length(p.text) - (total() - max));
      if (next !== null && length(next) < length(p.text)) {
        p.text = next;
        return true;
      }
    }
    return false;
  };
  const cutWords = (text: string, to: number): string | null => {
    const core = text.trim();
    if (length(core) <= 2) return null;
    const before = /^\s/.test(text) ? ' ' : '';
    const after = /\s$/.test(text) ? ' ' : '';
    return `${before}${cleanText(core, Math.max(2, to - before.length - after.length))}${after}`;
  };
  const cutValue = (text: string, to: number): string | null => {
    const address = emailAddressParts(text);
    if (address) return cutAddress(text, Math.max(addressFloor(address), to));
    if (length(text) <= 2) return null;
    // A value already cut to keep its end (a long domain or server name) keeps it.
    return text.startsWith('…') ? keepEnd(text, Math.max(2, to)) : cleanText(text, Math.max(2, to));
  };
  while (total() > max && cutLongest('words', cutWords));
  while (total() > max && cutLongest('value', cutValue));

  const line = cleanText(parts.map((p) => p.text).join(''), Number.POSITIVE_INFINITY);
  return length(line) <= max ? line : cleanText(line, max);
}

/** Fill the operation's describe template. A missing value shows as nothing, never "null" or "{x}". */
export const describeRequest: DescribeRequest = (operation, input, answer) => {
  let template = typeof operation.describe === 'string' && operation.describe.trim() !== '' ? operation.describe : operation.id;
  const goes = SECRET_GOES_TO[routeKey(operation)];
  if (goes && !template.includes(goes.placeholder)) template = `${template}${goes.clause}`;
  const safeInput: OperationInput = isPlainObject(input) ? input : {};

  const tokens = tokensOf(template);
  const values = new Map<Token, Value>();
  for (const t of tokens) if (t.name !== null) values.set(t, valueOf(operation, safeInput, answer, t.name));
  const empty = (t: Token) => render(operation, t.name as string, values.get(t) as Value, ROOM_STEPS[0]).text === '';
  const dropped = emptiedAsides(template, tokens, empty);
  const gone = (at: number) => dropped.some(([a, b]) => at >= a && at <= b);

  const lineAt = (room: Room): Built => {
    const segs: Seg[] = [];
    // Every value shown is kept out of the tidying, which is for the template's own words: a value
    // shows exactly as rendered ("C:/Reports ()/x" keeps its "()", "-5.00" its sign, "[::1]" is not
    // a doubled colon).
    const kept: Built['kept'] = [];
    for (const t of tokens) {
      if (t.name !== null) {
        if (gone(t.start)) continue;
        const value = values.get(t) as Value;
        const { text, list } = render(operation, t.name, value, room);
        if (text !== '') {
          kept.push({ text, fixed: value.fixed, list });
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
  return built ? cutKeepingFixed(built, DESCRIBE_LINE_MAX) : '';
};
