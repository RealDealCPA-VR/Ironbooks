/**
 * Agent full access: the one-line summary of a request, from its operation's describe template
 * ("Email invoice {number} to {to}"), for the approval card, the agent's answer and the activity
 * list (plan §4.3).
 *
 * The line is built from the operation and the request, never from the agent's own words, and a
 * person approves on it, so:
 *  - a value missing or null shows as nothing, never "null", "undefined" or "{to}"; the words left
 *    hanging by it are tidied away ("Send a test email to" becomes "Send a test email", "Reverse
 *    journal entry je1 as of" becomes "Reverse journal entry je1"), and an aside in parentheses
 *    whose every value is missing goes whole ("(on: {enabled})", "(to {to} when given)");
 *  - each value is cut to 60 characters, and line breaks, control characters and invisible marks
 *    (a U+202E mark reverses what follows it, so "Invoice<U+202E>fdp.exe" reads as "Invoiceexe.pdf") are removed;
 *    a list shows as many whole items as fit and then "and N more", so none is hidden unsaid; a
 *    server name too long to show keeps its end, which is what says where it goes;
 *  - passwords and keys never show, SSNs and account numbers show masked, and so does an account
 *    number inside any text ("Acct # ••••6789");
 *  - what the route did beats what the agent wrote: when the answer holds a value, it wins over a
 *    different one in the body (an agent can put fields in a body that the route ignores), and the
 *    amount is the larger of the body's and the answer's, as the policy reads it (when one of them
 *    cannot be read, the other still shows: the figure is never left off the card);
 *  - only what the route reads fills a placeholder: its own path parameters (an extra "params.to"
 *    cannot), its body when it takes one, and its query only when it reads it. A route with a body
 *    reads no query, except the few names in QUERY_OF_BODY_ROUTES: otherwise a "query.to" on an
 *    invoice email would put on the card an address the route never sends to;
 *  - a password the approver types goes where the line says: an operation that sends it to a
 *    server the agent named shows that server (SECRET_GOES_TO).
 *
 * Pure: no database, no Node.
 */
import type { DescribeRequest, OperationInput } from './contract';
import { amountShown } from './facts';
import { cleanText, maskAccountsInText, maskedForDisplay, protectedKindOf, valuesAt } from './guards';
import type { Operation } from './operations/types';

/** Longest a filled-in value may be, and the whole line. */
export const DESCRIBE_VALUE_MAX = 60;
export const DESCRIBE_LINE_MAX = 200;

/** What the line shows for an amount that is there but cannot be read as one. */
export const AMOUNT_UNREADABLE_TEXT = 'an amount that could not be read';

const PLACEHOLDER = /^\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\}$/;
/**
 * Words that only make sense before the value that followed them. "as of" goes as one. A word of
 * its own only: the "in" of "sign-in" stays.
 */
const CONNECTOR_BEFORE_END = /(?:(?:^|\s+)(?:as\s+of|to|for|from|on|of|with|as|at|by|in|into|through|against|and|or)|\s*:)\s*$/i;
/**
 * What may follow a missing value for the words that led to it to go too: the end of the line or
 * of a clause (",", ";", ".", ")"), an aside that opens ("for {pattern} (accept)"), or another of
 * those small words ("for {from} to {to}" with no start date reads "to 2026-12-31"). Not "and" or
 * "or": "to {a} or {b}" without a is not "or b".
 */
const CLAUSE_END = /^\s*(?:$|[,;.!?)(]|(?:to|for|from|on|of|with|as|at|by|in|into|through|against)\b)/i;

/**
 * Routes with a body whose handler reads these placeholders from its query string all the same
 * (read off each handler). Every other route with a body reads none of its query, so a value an
 * agent put there would only ever show on the card: it fills nothing.
 */
const QUERY_OF_BODY_ROUTES: Readonly<Record<string, readonly string[]>> = {
  // The body is the backup file itself; the new company's name is req.nextUrl.searchParams 'name'.
  'POST /api/backup/company': ['name'],
  // saveCopyAs(searchParams 'target', { companyName, convert } from the body).
  'POST /api/company-file/save-as': ['target'],
};

/**
 * A clause naming where a password the approver types is sent, for an operation whose template
 * does not say so. POST /api/email/test puts the typed mail password into the draft set-up the
 * agent wrote (guards.ts SECRET_ROUTES: draft.password) and connects to that draft's server with
 * it: without the server on the line, an agent could ask for a test against its own server and
 * collect the password. Added only when the template does not name it already; with no draft (the
 * saved set-up is tested, and no typed password is used) it shows nothing.
 */
const SECRET_GOES_TO: Readonly<Record<string, { placeholder: string; clause: string }>> = {
  'POST /api/email/test': { placeholder: '{draft.host}', clause: ' through {draft.host}' },
};

/** A server name says where it goes at its end ("….evil.example"): too long, its start is cut. */
const HOST_NAMES = /^(?:host|hostname|smtpHost|server)$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function absent(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
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

/** The raw value for one placeholder, from the sources the route reads, in order. */
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

  // Every method but GET can take a body, in the operation's own kind (the bridge refuses one
  // anywhere else). A write reads its body first and its query only where the handler does; a
  // read or a delete reads its query first.
  const takesBody = operation.method !== 'GET' && operation.body !== 'none';
  const isWrite = takesBody && operation.method !== 'DELETE';
  const readsQuery = !isWrite || (QUERY_OF_BODY_ROUTES[routeKey(operation)] ?? []).includes(name);
  const query: Record<string, unknown> = isPlainObject(input.query) ? input.query : {};
  const fromQuery = () => (readsQuery && Object.prototype.hasOwnProperty.call(query, name) ? query[name] : undefined);
  const fromBody = () => (takesBody ? first(valuesAt(input.body, name)) : undefined);
  const sources = isWrite ? [fromBody, fromQuery] : [fromQuery, fromBody];
  let chosen: unknown;
  for (const source of sources) {
    const v = source();
    if (!absent(v)) {
      chosen = v;
      break;
    }
  }
  if (answer !== undefined) {
    const done = first(valuesAt(answer, name));
    if (!absent(done) && asText(done) !== asText(chosen)) return done;
  }
  return chosen;
}

function isScalar(v: unknown): boolean {
  return ['string', 'number', 'bigint', 'boolean'].includes(typeof v);
}

/**
 * Text as a value may show, cut to `max`: invisible marks out first (so none can split an
 * "Acct #" label and slip the number past the mask), then account numbers in it masked.
 */
function shown(text: string, max: number): string {
  return cleanText(maskAccountsInText(cleanText(text, Number.POSITIVE_INFINITY)), max);
}

/** As shown(), but a value too long keeps its end ("…mail.evil.example"), not its start. */
function shownEnd(text: string, max: number): string {
  const chars = Array.from(shown(text, Number.POSITIVE_INFINITY));
  return chars.length > max ? `…${chars.slice(chars.length - (max - 1)).join('').trimStart()}` : chars.join('');
}

/**
 * A list of plain values (recipients, ids): as many whole items as fit, then how many more, so a
 * person always sees that there are others ("a@acme.com, b@acme.com and 2 more"). Cutting the
 * joined text instead would hide the last ones behind "…", and the last could be the outside one.
 */
function listText(items: readonly unknown[]): string {
  const texts = items.map((x) => shown(asText(x), DESCRIBE_VALUE_MAX)).filter((s) => s !== '');
  const more = (n: number) => (n > 0 ? ` and ${n} more` : '');
  for (let k = texts.length; k >= 1; k--) {
    const text = `${texts.slice(0, k).join(', ')}${more(texts.length - k)}`;
    if (Array.from(text).length <= DESCRIBE_VALUE_MAX) return text;
  }
  if (texts.length === 0) return '';
  // Not even the first item fits whole: cut it, and still say how many follow.
  const rest = more(texts.length - 1);
  return `${cleanText(texts[0], DESCRIBE_VALUE_MAX - Array.from(rest).length)}${rest}`;
}

function filled(operation: Operation, input: OperationInput, answer: unknown, name: string): string {
  const raw = lookup(operation, input, answer, name);
  if (absent(raw)) return '';
  const kind = protectedKindOf(operation, name);
  if (kind) return cleanText(maskedForDisplay(name, kind, raw), DESCRIBE_VALUE_MAX);
  if (Array.isArray(raw) && raw.every(isScalar)) return listText(raw);
  const last = name.split('.').pop() ?? name;
  return HOST_NAMES.test(last) ? shownEnd(asText(raw), DESCRIBE_VALUE_MAX) : shown(asText(raw), DESCRIBE_VALUE_MAX);
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
 * empty value is tidied like any other ("(action; empty means void)").
 */
function emptiedAsides(template: string, tokens: readonly Token[], values: ReadonlyMap<Token, string>): Array<[number, number]> {
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
        if (inside.length === 0 || inside.some((x) => values.get(x) !== '')) continue;
        if (template.slice(from + 1, to).replace(/\{[^{}]*\}/g, '').includes(';')) continue;
        out.push([from, to]);
      }
    }
  }
  return out;
}

/** Fill the operation's describe template. A missing value shows as nothing, never "null" or "{x}". */
export const describeRequest: DescribeRequest = (operation, input, answer) => {
  let template = typeof operation.describe === 'string' && operation.describe.trim() !== '' ? operation.describe : operation.id;
  const goes = SECRET_GOES_TO[routeKey(operation)];
  if (goes && !template.includes(goes.placeholder)) template = `${template}${goes.clause}`;
  const safeInput: OperationInput = isPlainObject(input) ? input : {};

  const tokens = tokensOf(template);
  const values = new Map<Token, string>();
  for (const t of tokens) if (t.name !== null) values.set(t, filled(operation, safeInput, answer, t.name));
  const dropped = emptiedAsides(template, tokens, values);
  const gone = (at: number) => dropped.some(([a, b]) => at >= a && at <= b);

  const segs: Array<{ text: string; placeholder: boolean }> = [];
  for (const t of tokens) {
    if (t.name !== null) {
      if (!gone(t.start)) segs.push({ text: values.get(t) ?? '', placeholder: true });
      continue;
    }
    let text = '';
    for (let i = 0; i < t.text.length; i++) if (!gone(t.start + i)) text += t.text[i];
    segs.push({ text, placeholder: false });
  }

  // A value missing at the end of the sentence (or of a clause) takes the word that led to it.
  // From the end backwards, so "from {a} to {b}" with neither loses both "to" and "from".
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (!s.placeholder || s.text !== '') continue;
    const rest = segs.slice(i + 1).map((x) => x.text).join('');
    if (!CLAUSE_END.test(rest)) continue;
    const prev = segs[i - 1];
    if (prev && !prev.placeholder) prev.text = prev.text.replace(CONNECTOR_BEFORE_END, '');
  }

  const line = tidy(segs.map((s) => s.text).join(''));
  return cleanText(line, DESCRIBE_LINE_MAX);
};
