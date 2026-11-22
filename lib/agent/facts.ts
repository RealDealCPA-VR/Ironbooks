/**
 * Agent full access: the facts of one request, for the policy (lib/agent/policy.ts) and for grant
 * matching: the flags it confirms, whether it asks to reveal, its amount and count, the names and
 * accounts it touches, its date and whether that date is in a closed period (plan §4.4, §5.6, D8).
 *
 * Before a run only the agent's input is known. Once a dry run has answered, pass its answer too:
 * the route's own figures then count. Every fact fails closed, because a fact that is too small
 * would let a request run under Allow or under a grant it should not:
 *  - the amount is the LARGER (by size) of the body's and the answer's, never the body's alone: an
 *    agent can put "total": 1 in a body the route ignores (the total is in the answer);
 *  - an amount that cannot be read is null (the policy then treats it as over every limit);
 *  - a count that cannot be known is null, never 0 (an empty list counts as unknown: some routes
 *    read an empty selection as "every line");
 *  - names, accounts and dates are gathered from the whole request, not only its top level, so a
 *    line that names another customer or a row dated in a closed period is not missed. The search
 *    has no size or depth limit (a journal entry of 5,000 lines is valid, and its last line counts
 *    as much as its first), and an id it cannot read is listed as UNREADABLE_ID, which no grant can
 *    name, never left out.
 *
 * Pure: no database, no Node. Amounts are decimal text compared with decimal.js (lib/money.ts's
 * rule: never floating point for money).
 */
import Decimal from 'decimal.js';
import type { FactsOf, OperationInput } from './contract';
import { valuesAt } from './guards';
import type { Operation, RequestFacts } from './operations/types';

/**
 * Body, path and answer fields that name a customer, vendor, employee or other name. A job is a
 * customer's (jobs.customerId), so a line on another customer's job is a line about that customer:
 * jobId counts too.
 */
const ENTITY_KEYS: ReadonlySet<string> = new Set([
  'customerId',
  'vendorId',
  'employeeId',
  'entityId',
  'nameId',
  'otherNameId',
  'payeeId',
  'customerJobId',
  'jobId',
  'shipToCustomerId',
  'lenderVendorId',
  'preferredVendorId',
  'customerIds',
  'vendorIds',
  'employeeIds',
  'entityIds',
  'nameIds',
  'jobIds',
]);

/** accountId, bankAccountId, fromAccountId, paymentAccountId … and their lists. */
function isAccountKey(k: string): boolean {
  return /^(?:[a-z][A-Za-z]*Account|account)Ids?$/.test(k);
}

/** Routes whose [id] is itself a name: a change to a customer is a change about that customer. */
const ENTITY_ROUTES: readonly string[] = ['/api/customers/[id]', '/api/vendors/[id]', '/api/employees/[id]', '/api/other-names/[id]', '/api/jobs/[id]'];
/**
 * Routes whose [id] is itself an account. A register's [accountId] is read by its name (any path
 * parameter named like an account counts), so an entry in bank account B is about B even when the
 * body names only the other side of it.
 */
const ACCOUNT_ROUTES: readonly string[] = ['/api/accounts/[id]'];

/**
 * Listed in entityIds or accountIds for an id that is there but cannot be read (an object where an
 * id belongs). No grant can name it (grants list ids), so a request holding one is never covered by
 * a grant limited to names or accounts: it goes to a person instead of being judged on part of it.
 */
export const UNREADABLE_ID = '(an id that could not be read)';

/** The transaction date: the first of these present. The first four are the common ones. */
const DATE_KEYS: readonly string[] = ['date', 'txnDate', 'entryDate', 'paymentDate', 'payDate', 'depositDate', 'checkDate', 'openingBalanceDate'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function absent(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/**
 * Calls `visit` on every plain object in `root`, at any depth, however many there are. With its own
 * list instead of recursion, so a deeply nested body cannot overflow the stack, and each object
 * once, so an object reached twice (only possible in-process: parsed JSON has no cycles) ends.
 */
function eachObject(root: unknown, visit: (obj: Record<string, unknown>) => void): void {
  const seen = new Set<object>();
  const todo: unknown[] = [root];
  while (todo.length > 0) {
    const node = todo.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) todo.push(node[i]);
      continue;
    }
    if (!isPlainObject(node)) continue;
    visit(node);
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) todo.push(node[keys[i]]);
  }
}

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------

type Reading = { kind: 'none' } | { kind: 'bad' } | { kind: 'ok'; value: Decimal };
const NONE: Reading = { kind: 'none' };
const BAD: Reading = { kind: 'bad' };

/** One amount as the app reads it (lib/money.ts toDecimal): a finite number, or text that is one. */
function readAmount(v: unknown): Reading {
  if (absent(v)) return NONE;
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'ok', value: new Decimal(v) } : BAD;
  if (typeof v !== 'string') return BAD;
  // trim() also drops non-breaking spaces and the byte-order mark, as lib/money.ts toDecimal does.
  const s = v.trim();
  if (s === '') return NONE;
  try {
    const d = new Decimal(s);
    return d.isFinite() ? { kind: 'ok', value: d } : BAD;
  } catch {
    return BAD;
  }
}

/** The amount at a dotted path. With * (one amount per line) the sizes are added up. */
function amountIn(root: unknown, path: string): Reading {
  const values = valuesAt(root, path);
  if (!path.split('.').includes('*')) return values.length > 0 ? readAmount(values[0]) : NONE;
  let total = new Decimal(0);
  let any = false;
  for (const v of values) {
    const r = readAmount(v);
    if (r.kind === 'bad') return BAD;
    if (r.kind === 'ok') {
      total = total.plus(r.value.abs());
      any = true;
    }
  }
  return any ? { kind: 'ok', value: total } : NONE;
}

function decimalText(d: Decimal): string {
  return d.decimalPlaces() <= 2 ? d.toFixed(2) : d.toFixed();
}

/**
 * The request's amount: operation.amountField read in the body and, when given, in the answer;
 * the larger by size wins (a large refund is as large as a large charge). Null when the operation
 * names no amount, when neither holds one, or when either holds one that cannot be read.
 */
export function amountOf(operation: Pick<Operation, 'amountField'>, input: OperationInput, answer?: unknown): string | null {
  const field = operation.amountField;
  if (typeof field !== 'string' || field === '') return null;
  const readings = [amountIn(input?.body, field)];
  if (answer !== undefined) readings.push(amountIn(answer, field));
  if (readings.some((r) => r.kind === 'bad')) return null;
  let best: Decimal | null = null;
  for (const r of readings) {
    if (r.kind === 'ok' && (best === null || r.value.abs().greaterThan(best.abs()))) best = r.value;
  }
  return best === null ? null : decimalText(best);
}

/**
 * The amount as the one-line summary shows it to a person (describe.ts). amountOf is null as soon
 * as either side cannot be read, which is right for the policy (it then treats the request as over
 * every limit) but would leave the approval card without a figure: an agent could hide the total by
 * writing junk in a body field the route ignores. So:
 *  - amountOf when it has one;
 *  - otherwise the route's answer's figure, when that can be read (the body's is the junk: what the
 *    route did beats what the agent wrote);
 *  - otherwise 'unreadable': the answer's figure is junk (the body's figure is then one the route
 *    did not use, so it never shows), or no figure can be read at all, or none was given. The card
 *    then says the amount is not known, as the policy reads it;
 *  - null only when the operation names no amount.
 */
export function amountShown(operation: Pick<Operation, 'amountField'>, input: OperationInput, answer?: unknown): string | 'unreadable' | null {
  const field = operation.amountField;
  if (typeof field !== 'string' || field === '') return null;
  const strict = amountOf(operation, input, answer);
  if (strict !== null) return strict;
  const done = answer === undefined ? NONE : amountIn(answer, field);
  return done.kind === 'ok' ? decimalText(done.value) : 'unreadable';
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

/** The number of records a list names; an empty list or anything else is unknown (null). */
function countIn(root: unknown, path: string, fromAnswer: boolean): number | null {
  const v = valuesAt(root, path)[0];
  if (Array.isArray(v)) return v.length > 0 ? v.length : null;
  // An answer may say how many it did instead of listing them.
  if (fromAnswer && typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
  return null;
}

function countOf(operation: Pick<Operation, 'countField'>, input: OperationInput, answer?: unknown): number | null {
  const field = operation.countField;
  if (typeof field !== 'string' || field === '') return null;
  const counts = [countIn(input?.body, field, false), answer === undefined ? null : countIn(answer, field, true)];
  const known = counts.filter((n): n is number => n !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

// ---------------------------------------------------------------------------
// Names and accounts
// ---------------------------------------------------------------------------

/**
 * One id value as listed: text trimmed, any other plain value as text (a customerId of 42 is still
 * a name the request touches, and no grant lists "42"). Missing and empty values name nothing. A
 * list adds each of its items. An object where an id belongs cannot be read: UNREADABLE_ID (the ids
 * inside it, if any, are found by the walk on their own).
 */
function addId(v: unknown, into: Set<string>, inList = false): void {
  if (absent(v)) return;
  if (typeof v === 'string') {
    if (v.trim() !== '') into.add(v.trim());
    return;
  }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    into.add(String(v));
    return;
  }
  if (Array.isArray(v) && !inList) {
    for (const x of v) addId(x, into, true);
    return;
  }
  into.add(UNREADABLE_ID);
}

/** Every id under a matching key, anywhere in `root`. */
function collectIds(root: unknown, match: (key: string) => boolean, into: Set<string>): void {
  eachObject(root, (obj) => {
    for (const k of Object.keys(obj)) if (match(k)) addId(obj[k], into);
  });
}

function onRoute(operation: Pick<Operation, 'route'>, routes: readonly string[]): boolean {
  const route = typeof operation.route === 'string' ? operation.route : '';
  return routes.some((r) => route === r || route.startsWith(`${r}/`));
}

/**
 * The ids a request names: path parameters named like one (a register's [accountId]), the [id] of
 * a route whose record is itself one (`idRoutes`), and every matching field of the body and the
 * answer at any depth.
 */
function idsOf(
  operation: Pick<Operation, 'route'>,
  input: OperationInput,
  answer: unknown,
  match: (k: string) => boolean,
  idRoutes: readonly string[],
): string[] {
  const ids = new Set<string>();
  const params: Record<string, unknown> = isPlainObject(input?.params) ? input.params : {};
  for (const k of Object.keys(params)) if (match(k)) addId(params[k], ids);
  if (onRoute(operation, idRoutes)) addId(params.id, ids);
  collectIds(input?.body, match, ids);
  if (answer !== undefined) collectIds(answer, match, ids);
  return [...ids];
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

/** "2026-11-20" from an ISO date or date-time; null when the text is not one. */
function dayOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(v.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

interface DateScan {
  days: string[];
  /** A date field held something that is not a date: nobody can tell where it falls. */
  unreadable: boolean;
}

/** The first date field present in one object. */
function firstDate(obj: unknown, scan: DateScan): void {
  if (!isPlainObject(obj)) return;
  for (const k of DATE_KEYS) {
    if (absent(obj[k])) continue;
    const day = dayOf(obj[k]);
    if (day) scan.days.push(day);
    else scan.unreadable = true;
    return;
  }
}

/**
 * The dates a request is for: every object's in the body, at any depth (batch entry rows, a
 * deposit's lines and a statement carry their own; whatever the agent dates, it writes), and the
 * answer's record's (an edit that names no date is still dated). Only the answer's top level, and
 * each row of an answer that is a list: deeper in an answer sit the record's history and the
 * documents linked to it (an invoice's earlier payments), whose dates are not this request's.
 */
function datesOf(input: OperationInput, answer: unknown): DateScan {
  const scan: DateScan = { days: [], unreadable: false };
  eachObject(input?.body, (obj) => firstDate(obj, scan));
  if (Array.isArray(answer)) answer.forEach((row) => firstDate(row, scan));
  else firstDate(answer, scan);
  return scan;
}

// ---------------------------------------------------------------------------
// factsOf
// ---------------------------------------------------------------------------

function confirmOf(operation: Pick<Operation, 'confirmFlags'>, input: OperationInput): string[] {
  const out = new Set<string>();
  if (Array.isArray(input?.confirm)) for (const f of input.confirm) if (typeof f === 'string' && f !== '') out.add(f);
  // A listed flag sent in the body counts as sent: the route reads it there either way.
  for (const f of Array.isArray(operation.confirmFlags) ? operation.confirmFlags : []) {
    if (valuesAt(input?.body, f).some((v) => v === true)) out.add(f);
  }
  return [...out];
}

export const factsOf: FactsOf = (operation, input, opts) => {
  const safeInput: OperationInput = isPlainObject(input) ? input : {};
  const answer = opts?.answer;

  const scan = datesOf(safeInput, answer);
  const distinct = [...new Set(scan.days)];
  // One date only when every date found agrees: a grant "dated within this month" must not cover
  // rows dated elsewhere.
  const date = !scan.unreadable && distinct.length === 1 ? distinct[0] : null;

  const closingText = opts?.closingDate ?? null;
  let closedPeriod = false;
  if (typeof closingText === 'string' && closingText.trim() !== '') {
    const closing = dayOf(closingText);
    const dated = scan.days.length > 0 || scan.unreadable;
    // A closing date that cannot be read, or a date that cannot, could be on either side of it.
    closedPeriod = closing === null ? dated : scan.unreadable || scan.days.some((d) => d <= closing);
  }

  const facts: RequestFacts = {
    confirm: confirmOf(operation, safeInput),
    reveal: safeInput.reveal === true,
    amount: amountOf(operation, safeInput, answer),
    count: countOf(operation, safeInput, answer),
    entityIds: idsOf(operation, safeInput, answer, (k) => ENTITY_KEYS.has(k), ENTITY_ROUTES),
    accountIds: idsOf(operation, safeInput, answer, isAccountKey, ACCOUNT_ROUTES),
    date,
    closedPeriod,
  };
  return facts;
};
