/**
 * The generic door (plan §6.1): every operation Ironbooks offers, not only the named tools.
 *
 * About 800 operations cannot each be a tool, so an agent finds one (find_operations), reads its
 * fields (describe_operation) and runs it (run_operation), with the same dry run, request id,
 * policy and approval as the named tools. When the policy says Ask, a person decides in Ironbooks
 * and the agent waits for the answer (wait_for_decision), sees what became of its requests
 * (list_my_requests), withdraws one (cancel_request), reads what it may do (get_my_permissions),
 * or asks ahead for standing permission (ask_for_permission).
 *
 * Each tool is one verb of the agent's door: POST /api/agent/actions with `{ verb, ...args }`
 * (lib/agent/contract.ts AgentVerbs). The tools take snake_case arguments, like the named tools,
 * and send the contract's camelCase. The one thing passed on unchanged is an operation's own
 * input (params, query, body): those are the app's field names, exactly as describe_operation
 * shows them, so there is no second mapping per operation to drift (plan §6.3).
 *
 * The long wait is a GET of the agent's own request (GET /api/agent/requests/<id>?wait=<seconds>),
 * sent on its own connection so other tools are not held up. When no wait can be held open (two
 * are open here already, or Ironbooks answers 429 because the agent holds as many as it allows),
 * the request is read at once instead, and the answer says to check it later. When it comes back
 * decided, the client also hears about it once as a log message and, if it subscribed, as a change
 * of the resource ironbooks://requests/<id> (plan §6.2). The answer of wait_for_decision stays the
 * dependable path.
 *
 * An answer is held to MAX_RESULT_CHARS: its result, the operation's own preview and what it would
 * also send are each cut to a fair share, and the answer says what was cut and how to see the rest.
 *
 * A warning is offered for sending again only with a confirm flag the operation lists (learnt from
 * describe_operation), since the door accepts no other. The door's "slow down" (retryAfterSeconds)
 * is told as a wait, never as a refusal of the work. describe_operation passes on the operation's
 * worked examples.
 */
import { WAITS_BUSY_CODE } from './client.mjs';
import { ToolError, slowDownAdvice } from './protocol.mjs';
import { CLASS_MEANINGS, SETTING_MEANINGS, SHORT_GRANT_MINUTES, STANDING, STANDING_TEXT } from './guide.mjs';
import { camelize, sentence, settle } from './write-tools.mjs';

/** The 14 risk classes (lib/agent/operations/types.ts RISK_CLASSES; a test holds them together). */
export const RISK_CLASSES = Object.keys(CLASS_MEANINGS);

/** The permission areas (lib/permissions/model.ts AREA_KEYS; a test holds them together). */
export const AREAS = [
  'banking', 'lists', 'customers', 'vendors', 'payroll', 'inventory', 'sales_tax', 'time', 'reports_financial', 'reports_sales',
  'reports_purchases', 'reports_payroll', 'reports_inventory', 'accounting', 'company', 'closing', 'users', 'file_utilities',
];

/** What a permission request can become (lib/agent/operations/types.ts REQUEST_STATUSES). */
export const REQUEST_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled', 'failed', 'executed'];

/** Longest one wait_for_decision may wait (lib/agent/contract.ts WAIT_MAX_SECONDS). */
export const WAIT_MAX_SECONDS = 50;

/** The longest answer handed to the agent as it is; a longer one has its longest lists cut. */
export const MAX_RESULT_CHARS = 200_000;

export const REQUEST_URI_PREFIX = 'ironbooks://requests/';

const ID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', patternHint: 'must be an id returned by another tool' };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' };
const MONEY = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like 1250.00 (text, at most 2 decimals)' };
const ID_TEXT = '^[A-Za-z0-9][A-Za-z0-9._:\\-]{2,119}$';
const ID_TEXT_HINT = 'must be 3 to 120 letters, digits, dots, dashes, colons or underscores';

export const OPERATION = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:\\-]{0,119}$',
  patternHint: 'must be an operation id from find_operations, for example "estimates.create"',
  description: 'The operation id, from find_operations (for example "estimates.create" or "invoices.email").',
};
export const REQUEST_ID = {
  type: 'string',
  pattern: ID_TEXT,
  patternHint: ID_TEXT_HINT,
  description:
    'Your own name for this one request, for example "estimate-acme-2026-03-08". Needed for anything that changes something or asks a person. Asking again with the same request_id returns the first answer and never does it twice; use a new one for each new request.',
};
/** A request named by the id an "asked" answer gave, or by the agent's own request_id. */
export const REQUEST_REF = {
  type: 'string',
  pattern: ID_TEXT,
  patternHint: 'must be the request_id an answer gave you (or your own request_id for it)',
  description: 'The request_id from the answer that said "asked" (your own request_id for it works too).',
};
const REASON = {
  type: 'string',
  maxLength: 500,
  description:
    'Why you are asking, in one or two plain sentences (at most 500 characters). Needed when a person must approve it. The person sees it labelled as your words, next to a preview Ironbooks builds itself.',
};
/**
 * The version of the record the agent last read (lib/agent/contract.ts OperationInput
 * .expectedUpdatedAt), as the named tools take it (write-tools.mjs EXPECTED). Optional on every
 * tool: it is kept into a request a person must approve and sent with the approved run, and the
 * route compares it as it saves (lib/agent/bridge.ts).
 */
const EXPECTED_VERSION = {
  type: 'string',
  maxLength: 40,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}',
  patternHint: "must be the record's updatedAt exactly as Ironbooks gave it, for example 2026-03-08T14:05:09.123Z",
  description:
    "When you change or void a record you read: its updatedAt as you read it (editedAt for an account or an item), exactly as given. If someone changed the record since, Ironbooks answers 409 (conflict) and changes nothing, instead of overwriting their work: read it again and make your change on what it says now. Leave it out for something new.",
};
/** After a 409 on a request that named a version: what to do, in place of the route's "reload". */
const VERSION_CHANGED =
  'If it says the record was changed since you read it, nothing was changed: read the record again, make your change on what it says now, and send it with the updatedAt you read then (editedAt for an account or an item) as expected_updated_at and a NEW request_id.';

/** @param {object} properties @param {string[]} [required] */
function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Leave out what was not given, so the request carries only what the agent said. */
function given(/** @type {Record<string, unknown>} */ args) {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * Send one verb to the agent's door: POST /api/agent/actions with `{ verb, ...args }`.
 * @param {any} client @param {string} name @param {Record<string, unknown>} args
 */
export function verb(client, name, args = {}) {
  return client.act({ verb: name, ...given(args) });
}

const asList = (/** @type {any} */ v, /** @type {string} */ key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

/** Drop empty fields from an answer row: the agent reads only what is there. */
function compact(/** @type {Record<string, unknown>} */ row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));
}

const jsonLength = (/** @type {unknown} */ v) => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

/**
 * A route's answer cut down to `budget` characters of JSON, by halving its longest lists, or null
 * when it fits as it is. `{ value: null }` when even that does not make it fit.
 * @param {unknown} value @param {number} [budget]
 * @returns {{ value: unknown } | null}
 */
export function cutToFit(value, budget = MAX_RESULT_CHARS) {
  if (jsonLength(value) <= budget) return null;
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch {
    return { value: null };
  }
  /** @type {unknown[][]} */
  const lists = [];
  (function collect(/** @type {unknown} */ v, /** @type {number} */ depth) {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) lists.push(v);
    for (const x of Array.isArray(v) ? v : Object.values(v)) collect(x, depth + 1);
  })(copy, 0);
  for (let i = 0; i < 60 && jsonLength(copy) > budget; i++) {
    const longest = lists.reduce((m, l) => (l.length > m.length ? l : m), /** @type {unknown[]} */ ([]));
    if (longest.length <= 1) break;
    longest.length = Math.ceil(longest.length / 2);
  }
  return { value: jsonLength(copy) <= budget ? copy : null };
}

/** Said of a change that was carried out, whatever part of its answer was cut. */
const DONE_ONCE = 'It was carried out once, in full: do not send it again.';
/** How to see the rest of a long answer of a change that was carried out: never by sending it again. */
const RUN_RESULT_REST = `${DONE_ONCE} To see the rest, read what it made with a narrower read (find_operations finds one).`;

/**
 * Where an answer stands, for what the agent is told about a part that was cut:
 *  - 'card': a person decides on an approval card, which shows every part in full;
 *  - 'done': it was carried out, so the rest is read with a narrower read, never by sending it again;
 *  - 'other': nothing was kept (a dry run, a read, a warning), so a smaller request shows the rest.
 * @typedef {'card' | 'done' | 'other'} Phase
 */

/** The phase of an answer by its outcome (mcp/write-tools.mjs shapeAnswer). @returns {Phase} */
function phaseOf(/** @type {unknown} */ outcome) {
  if (outcome === 'asked' || outcome === 'proposed') return 'card';
  if (outcome === 'posted' || outcome === 'done') return 'done';
  return 'other';
}

/**
 * The parts of an answer that may be very long, in plain words, and how the agent sees the rest of
 * each when it was cut, by phase ('other' when a phase has nothing of its own). Only an answer that
 * waits for a person mentions the approval card: there is none otherwise. A part not named here is
 * cut the same way, with a plainer note.
 * @type {Record<string, { what: string, rest: { other: string, card?: string, done?: string } }>}
 */
const LONG_PARTS = {
  result: {
    what: 'The result',
    rest: { other: 'Narrow the request (dates, a filter, a limit in the query) to see everything.', done: RUN_RESULT_REST },
  },
  route_preview: {
    what: "The operation's own preview (route_preview)",
    rest: {
      card: 'A person sees all of it on the approval card. To see it all yourself, dry run a smaller request (fewer records, a shorter date range).',
      other: 'Nothing was kept. To see all of it, dry run a smaller request (fewer records, a shorter date range).',
      done: RUN_RESULT_REST,
    },
  },
  would_also: {
    what: 'The list of what it would also do outside the books (would_also)',
    rest: {
      card: 'A person sees every one on the approval card. To see each yourself, dry run a smaller batch.',
      other: 'Nothing was sent. To see each one, dry run a smaller batch.',
    },
  },
  also: {
    what: 'The list of what it also did outside the books (also)',
    rest: { other: 'Ironbooks keeps all of them in its audit trail.', done: `${DONE_ONCE} Ironbooks keeps all of them in its audit trail.` },
  },
  also_done: {
    what: 'The list of how each send or file went (also_done)',
    rest: { other: 'Ironbooks keeps all of them in its audit trail.', done: `${DONE_ONCE} Ironbooks keeps all of them in its audit trail.` },
  },
  would_post: {
    what: 'The ledger lines it would post (would_post)',
    rest: { card: 'A person sees every line on the approval card. To see each yourself, dry run a smaller request.', other: 'Nothing was posted. Dry run a smaller request to see every line.' },
  },
  ledger: {
    what: 'The ledger lines it posted (ledger)',
    rest: { other: 'Read the entries with get_journal_entry to see every line.', done: `${DONE_ONCE} Read the entries with get_journal_entry to see every line.` },
  },
};

/** How to see the rest of a part not named in LONG_PARTS. */
const PLAIN_REST = { other: 'Narrow the request to see all of it.', done: RUN_RESULT_REST };

/** Room kept for the notes that say what was cut. */
const NOTE_ROOM = 4_000;

/** The parts of a shaped answer that say what happened and what to do next: never cut or left out. */
const ALWAYS_SHOWN = new Set([
  'outcome', 'said', 'next', 'request_id', 'status', 'who_decides', 'warnings', 'note', 'file', 'summary', 'repeated', 'note_repeat',
  'under_standing_permission', 'proposal_id', 'decision', 'kind', 'operation', 'error', 'note_from_person', 'stale',
  'standing_permission', 'limits_given', 'minutes_given', 'standing_permission_ends_at', 'standing_permission_not_given',
  'check_again_after_seconds',
]);

/**
 * What the agent reads about one part that was cut (`kept`) or left out (`kept` undefined).
 * `restOf`: how to see the rest, where it differs from LONG_PARTS. `phase`: where the answer stands.
 */
function cutNote(
  /** @type {string} */ part,
  /** @type {unknown} */ whole,
  /** @type {unknown} */ kept,
  /** @type {Record<string, string>} */ restOf = {},
  /** @type {Phase} */ phase = 'other',
) {
  const p = Object.prototype.hasOwnProperty.call(LONG_PARTS, part) ? LONG_PARTS[part] : undefined;
  const what = p?.what ?? `"${part}"`;
  const rests = p?.rest ?? PLAIN_REST;
  const rest = restOf[part] ?? rests[phase] ?? rests.other;
  if (kept === undefined) return `${what} was too long to show at all, so it was left out. ${rest}`;
  if (Array.isArray(whole) && Array.isArray(kept)) return `${what} was too long to show in full: only the first ${kept.length} of ${whole.length} are shown. ${rest}`;
  return `${what} was too long to show in full: its longest lists were cut. ${rest}`;
}

/**
 * Hold a shaped answer to MAX_RESULT_CHARS of JSON. Every part that may be long (the result, the
 * operation's own preview, what it would also do outside the books, the ledger lines) gets a fair
 * share of the room: a part that fits its share is kept whole, and what it leaves over goes to the
 * others; a part that does not is cut to its share by halving its longest lists, or left out when
 * even that is not enough (one very long text). What the answer says happened and what to do next
 * is never cut. `cut_short` names each part that was cut, says so, and says how to see the rest:
 * by where the answer stands (`opts.phase`, else from its outcome), so a change that was carried
 * out is never answered with advice that would send it again, and the approval card is named only
 * when there is one.
 * @param {Record<string, unknown>} shaped
 * @param {number} [budget]
 * @param {{ rest?: Record<string, string>, phase?: Phase }} [opts]  how to see the rest of a part, where it differs from LONG_PARTS
 */
export function holdToLimit(shaped, budget = MAX_RESULT_CHARS, opts = {}) {
  const restOf = opts.rest ?? {};
  const phase = opts.phase ?? phaseOf(shaped.outcome);
  if (jsonLength(shaped) <= budget) return shaped;
  const fixed = Object.fromEntries(Object.entries(shaped).filter(([k]) => ALWAYS_SHOWN.has(k)));
  let room = budget - jsonLength(fixed) - NOTE_ROOM;
  const sized = Object.keys(shaped)
    .filter((k) => !ALWAYS_SHOWN.has(k))
    .map((k) => /** @type {[string, number]} */ ([k, jsonLength(shaped[k]) + k.length + 4]))
    .sort((a, b) => a[1] - b[1]);
  /** @type {Record<string, unknown>} */
  const out = { ...shaped };
  /** @type {Record<string, string>} */
  const cutShort = {};
  const leftOut = [];
  sized.forEach(([k, size], i) => {
    const share = Math.floor(room / (sized.length - i));
    if (size <= share) {
      room -= size;
      return;
    }
    const cut = cutToFit(shaped[k], share - k.length - 4);
    if (cut === null) {
      room -= size; // fits after all
      return;
    }
    if (cut.value !== null && cut.value !== undefined) {
      out[k] = cut.value;
      room -= jsonLength(cut.value) + k.length + 4;
      cutShort[k] = cutNote(k, shaped[k], cut.value, restOf, phase);
    } else {
      delete out[k];
      leftOut.push(k);
      cutShort[k] = cutNote(k, shaped[k], undefined, restOf, phase);
    }
  });
  return {
    ...out,
    cut_short: cutShort,
    ...(leftOut.length ? { left_out: leftOut } : {}),
    // The older name, for agents that read it: what became of the result.
    ...(cutShort.result ? { result_cut_short: cutShort.result } : {}),
  };
}

/**
 * The door's "slow down" given as an answer (lib/agent/contract.ts AgentOperationAnswer
 * retryAfterSeconds, wave 4): too many calls in the last minute, or too many under way. It is not a
 * refusal of the work, and nothing was done, so the agent is told to wait and send it again as it
 * was, never to give up on it. Null for any other answer.
 * @param {any} answer
 * @returns {ToolError | null}
 */
export function slowDownOf(answer) {
  if (!answer || typeof answer !== 'object' || answer.outcome !== 'refused') return null;
  const seconds = Number(answer.retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const note = typeof answer.note === 'string' && answer.note.trim() ? answer.note.trim() : 'Ironbooks is busy with your other requests.';
  return new ToolError(`Not now: ${/[.!?]$/.test(note) ? note : `${note}.`} ${slowDownAdvice(Math.min(Math.ceil(seconds), 3600))}`);
}

/**
 * Run settle() on an answer that may be very long anywhere (its result, the operation's own
 * preview, what it would also send), then hold it to MAX_RESULT_CHARS (holdToLimit). A "slow down"
 * is answered as such (slowDownOf), not as a refusal. `opts`: how a warning's flag is sent again
 * (mcp/write-tools.mjs resendWith): the operation's own confirm flags when they are known.
 * @param {any} answer
 * @param {{ fields?: string[] | 'confirm', confirm?: string[] }} [opts]
 */
export function settleLong(answer, opts = { fields: 'confirm' }) {
  const slow = slowDownOf(answer);
  if (slow) throw slow;
  return holdToLimit(settle(answer, opts));
}

/**
 * Per client, the confirm flags each operation lists, as describe_operation gave them, and the run
 * of Ironbooks that gave them (client.run, the endpoint file's value: a new one each time Ironbooks
 * starts). An update can change an operation's flags, so flags learnt from another run are dropped.
 * @type {WeakMap<object, { run: unknown, flags: Map<string, string[]> }>}
 */
const flagsByClient = new WeakMap();
/** At most this many operations' flags are kept per client (there are about 800). */
const FLAGS_KEPT = 1000;

/** The flags kept for `client`, emptied first when they came from another run of Ironbooks. */
function keptFlags(/** @type {any} */ client) {
  const run = client.run ?? null;
  let kept = flagsByClient.get(client);
  if (!kept || kept.run !== run) flagsByClient.set(client, (kept = { run, flags: new Map() }));
  return kept.flags;
}

/** Keep an operation's confirm flags from its description, for run_operation's warnings. */
function rememberFlags(/** @type {any} */ client, /** @type {any} */ d) {
  if (!client || typeof client !== 'object' || !d || typeof d.id !== 'string' || !Array.isArray(d.confirmFlags)) return;
  const kept = keptFlags(client);
  if (kept.size >= FLAGS_KEPT && !kept.has(d.id)) kept.delete(/** @type {string} */ (kept.keys().next().value));
  kept.set(d.id, d.confirmFlags.filter((/** @type {unknown} */ f) => typeof f === 'string'));
}

/**
 * The confirm flags an operation lists (the only ones the door accepts with it), from an earlier
 * describe_operation or by asking for its description now. Null when they cannot be learnt: the
 * door's own note on the answer still says whether the warning can be accepted.
 * @param {any} client @param {unknown} operation
 * @returns {Promise<string[] | null>}
 */
async function confirmFlagsOf(client, operation) {
  if (typeof operation !== 'string' || !operation) return null;
  // Flags from this same run of Ironbooks only: after an update the operation may list others.
  const known = client && typeof client === 'object' ? keptFlags(client).get(operation) : undefined;
  if (known) return known;
  try {
    const d = await verb(client, 'describe_operation', { operation });
    rememberFlags(client, d);
    return Array.isArray(d?.confirmFlags) ? d.confirmFlags.filter((/** @type {unknown} */ f) => typeof f === 'string') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Finding and describing operations
// ---------------------------------------------------------------------------

const TREATMENTS = {
  run: 'you may run it now',
  ask: 'a person must approve it: run_operation asks for you, then call wait_for_decision',
  refused: 'you cannot run it (why says why)',
};

/** One operation as find_operations lists it (lib/agent/contract.ts OperationSummary). */
function summaryRow(/** @type {any} */ o) {
  return compact({ operation: o.id, does: o.describe, class: o.class, area: o.area, method: o.method, route: o.route, treatment: o.treatment, why: o.why });
}

const OUTPUT_WORDS = {
  json: 'JSON, in the answer.',
  pdf: 'A PDF: the answer gives a file_id; call get_file to read it.',
  file: 'A file: the answer gives a file_id; call get_file to read it.',
  stream: 'A stream of data, gathered into the answer.',
};
const DRY_RUN_WORDS = {
  transaction: 'dry_run really runs it inside Ironbooks and rolls it back: you see what it would post and change, and nothing is kept.',
  preview: 'dry_run uses the operation\'s own preview: you see what it would do, and nothing is kept.',
  none: 'It cannot be tried out first: dry_run only describes it. A person sees the same description when they approve it.',
};
const BODY_WORDS = {
  none: 'It takes no body.',
  json: 'The body is a JSON object with the fields of body_schema, in the app\'s own names (camelCase).',
  multipart: 'The body is a JSON object with the fields of body_schema; each file field is { "fileId": "<file_id> from upload_file or attach_local_file" }.',
  bytes: 'The body is one file: { "fileId": "<file_id> from upload_file or attach_local_file" }.',
  text: 'The body is text.',
};
const REVEAL_WORDS = { ssn: 'Social Security numbers', account_numbers: 'bank account numbers', payroll: 'payroll detail' };
const EFFECT_WORDS = { email: 'sends an email', file: 'writes a file', print: 'prints', network: 'calls another computer' };

/** How to call one operation with run_operation, in a line. */
function howToRun(/** @type {any} */ d) {
  const parts = [`run_operation with operation "${d.id}"`];
  const params = Array.isArray(d.params) ? d.params : [];
  if (params.length) parts.push(`params { ${params.map((p) => `"${p}": "..."`).join(', ')} }`);
  if (d.querySchema) parts.push('query as query_schema shows');
  if (d.body && d.body !== 'none') parts.push(d.body === 'bytes' ? 'body { "fileId": "..." }' : 'a body as body_schema shows');
  if (d.class === 'read' && !d.reveal) return `${parts.join(', ')}.`;
  return `${parts.join(', ')}, and dry_run true first. Then the same again without dry_run, with a request_id${d.treatment === 'ask' ? ' and a reason' : ''}.`;
}

/** The most worked examples passed on from one description. */
export const MAX_EXAMPLES = 10;

const isMap = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
const wordsOf = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);

/**
 * One worked example of an operation (lib/agent/contract.ts OperationDescription.examples, wave 4:
 * a whole request { params?, query?, body?, confirm?, reveal? } with an optional title or note),
 * in the tool's words. The request parts keep their names: they are run_operation's own arguments.
 * Null for an example that is not a request.
 */
function exampleRow(/** @type {unknown} */ e) {
  if (!isMap(e)) return null;
  const x = /** @type {Record<string, unknown>} */ (e);
  const row = compact({
    title: wordsOf(x.title) ?? wordsOf(x.describe) ?? wordsOf(x.summary),
    note: wordsOf(x.note),
    params: isMap(x.params) ? x.params : undefined,
    query: isMap(x.query) ? x.query : undefined,
    body: x.body,
    confirm: Array.isArray(x.confirm) ? x.confirm.filter((f) => typeof f === 'string') : undefined,
    reveal: x.reveal === true ? true : undefined,
  });
  return 'params' in row || 'query' in row || 'body' in row ? row : null;
}

/** describe_operation's answer, for the agent (lib/agent/contract.ts OperationDescription). */
export function shapeDescription(/** @type {any} */ d) {
  if (!d || typeof d !== 'object' || !d.id) throw new ToolError('Ironbooks did not describe that operation. Check the id with find_operations.');
  const needsSecret = Array.isArray(d.needsSecret) ? d.needsSecret : [];
  const effects = Array.isArray(d.effects) ? d.effects : [];
  const examples = (Array.isArray(d.examples) ? d.examples : []).map(exampleRow).filter((x) => x !== null).slice(0, MAX_EXAMPLES);
  return compact({
    operation: d.id,
    does: d.describe,
    class: d.class,
    class_means: CLASS_MEANINGS[/** @type {keyof typeof CLASS_MEANINGS} */ (d.class)],
    area: d.area,
    method: d.method,
    route: d.route,
    treatment: d.treatment,
    treatment_means: TREATMENTS[/** @type {keyof typeof TREATMENTS} */ (d.treatment)],
    why: d.why,
    params: d.params,
    query_schema: d.querySchema,
    body: BODY_WORDS[/** @type {keyof typeof BODY_WORDS} */ (d.body)] ?? d.body,
    body_schema: d.bodySchema,
    returns: OUTPUT_WORDS[/** @type {keyof typeof OUTPUT_WORDS} */ (d.output)] ?? d.output,
    dry_run: d.class === 'read' ? undefined : DRY_RUN_WORDS[/** @type {keyof typeof DRY_RUN_WORDS} */ (d.dryRun)],
    confirm_flags: d.confirmFlags,
    ...(Array.isArray(d.confirmFlags) && d.confirmFlags.length
      ? { confirm_flags_means: 'Warnings it may raise. Send a flag in confirm only after a warning naming it, and only when going ahead is right.' }
      : {}),
    reveal: d.reveal
      ? `Masked by default. reveal: true asks a person to show the ${REVEAL_WORDS[/** @type {keyof typeof REVEAL_WORDS} */ (d.reveal)] ?? 'protected values'} in full, for this one call.`
      : undefined,
    needs_secret: needsSecret.length
      ? 'It needs a password or key. The person who approves it types it on their own screen; never ask for it and never send it.'
      : undefined,
    effects: effects.length ? effects.map((e) => EFFECT_WORDS[/** @type {keyof typeof EFFECT_WORDS} */ (e)] ?? e) : undefined,
    notes: d.notes,
    examples: examples.length ? examples : undefined,
    ...(examples.length
      ? {
          examples_mean: `Each example is a whole request: call run_operation with operation "${d.id}" and its params, query, body, confirm and reveal as shown (dry_run true first). Put in your own ids, dates and amounts; send a confirm flag only after a warning named it.`,
        }
      : {}),
    how_to_run: howToRun(d),
  });
}

// ---------------------------------------------------------------------------
// Requests: what the agent asked for, and what a person decided
// ---------------------------------------------------------------------------

/** The agent's word for a request's status: executed is approved (and done). */
const DECISIONS = { pending: 'pending', approved: 'approved', executed: 'approved', denied: 'denied', expired: 'expired', cancelled: 'cancelled', failed: 'failed' };

/**
 * Approved, but not finished: an operation request whose approved run has no result yet, or a
 * standing-permission request whose permission is not made yet. Either can still end as failed
 * (lib/services/agentRequests.ts claims the request as approved first, then runs or grants).
 */
function stillRunning(/** @type {any} */ r) {
  if (r.status !== 'approved') return false;
  if (r.kind === 'grant') return !r.grantId;
  return (r.result === undefined || r.result === null) && !r.file;
}

/** The request is decided for good: nothing more will happen to it. */
export function isSettled(/** @type {any} */ r) {
  return !!r && typeof r.status === 'string' && r.status !== 'pending' && !stillRunning(r);
}

/** A grant's limits in the tools' words (lib/agent/operations/types.ts GrantConstraints). Undefined when it has none. */
function limitsOf(/** @type {any} */ c) {
  if (!c || typeof c !== 'object') return undefined;
  const out = compact({
    entity_ids: c.entityIds,
    account_ids: c.accountIds,
    max_amount: c.maxAmount,
    date_from: c.dateFrom,
    date_to: c.dateTo,
    max_uses: c.maxUses,
    max_count: c.maxCount,
  });
  return Object.keys(out).length ? out : undefined;
}

/** Said of a standing permission given with no limits of its own. */
const NO_LIMITS = 'none beyond the operation itself (your other limits, such as the most records per request, still apply)';

/**
 * The standing permission a person actually gave (lib/agent/contract.ts AgentRequestView.grant,
 * wave 3), in the tools' words, or null when the view does not say (an older Ironbooks, or none).
 */
function givenOf(/** @type {any} */ g) {
  if (!g || typeof g !== 'object' || typeof g.expiresAt !== 'string') return null;
  return { limits: limitsOf(g.constraints) ?? NO_LIMITS, minutes: typeof g.minutes === 'number' ? g.minutes : undefined, endsAt: g.expiresAt };
}

/** A standard report read through the door (mcp/report-tools.mjs). */
const REPORT_READ = 'reports.std.get';

/**
 * What to do once an approved report read is done. export_report asks for the read as its first
 * step and makes the file only when it is sent again (mcp/report-tools.mjs exportReadNext), and
 * this is the last answer such an agent reads: "do not send it again" alone would leave it with the
 * rows and no file. The request does not say which tool asked for it, so both cases are said; the
 * agent's own request_id is not in the request either, so it is described, apart from this one.
 */
export const REPORT_READ_DONE =
  'It is done: what was read is in result. If you asked for it with export_report, send export_report again now with the same arguments and your own request_id (the one you chose, not this request_id) to make the file: the report is not read a second time. Otherwise, do not send it again.';

/**
 * One request as the agent reads it (lib/agent/contract.ts AgentRequestView): what it was, what a
 * person decided, in plain words, and what to do next. `full`: with the result of the run (held to
 * MAX_RESULT_CHARS, holdToLimit).
 * @param {any} r
 * @param {{ full?: boolean }} [opts]
 */
export function shapeRequest(r, opts = {}) {
  const decision = DECISIONS[/** @type {keyof typeof DECISIONS} */ (r.status)] ?? r.status;
  const by = r.decidedByName ? ` by ${r.decidedByName}` : '';
  const pending = r.status === 'pending';
  const isGrant = r.kind === 'grant';
  // The books changed after a person was shown the preview (plan §7.4): the request waits again,
  // with a new preview, and a person must decide again on that one. It stays marked stale after
  // that (lib/services/agentRequests.ts: the mark counts the rounds, and is never taken off).
  const stale = pending && r.stale === true;
  // Two people must approve (a large amount): after the first, the request stays pending with
  // that person's name on it until a second, different person approves it too. Going stale sets
  // every approval aside (backToWaiting clears the name), so a name on a stale request is a first
  // approval of the NEW preview, and a second person must still approve.
  const firstOfTwo = pending && !!r.decidedByName;
  const done = !pending && !stillRunning(r) && decision === 'approved';
  // What the person really gave: it may be narrower, or shorter, than what was asked.
  const given = done ? givenOf(r.grant) : null;
  const file = r.file && r.file.fileId ? { file_id: r.file.fileId, name: r.file.name, type: r.file.type, size: r.file.size } : undefined;
  let said;
  let next;
  if (pending) {
    if (stale && firstOfTwo) {
      said = `The books changed after a person was shown what this would do, so Ironbooks made a new preview. One person approved the new preview (${r.decidedByName}); a second person must also approve it before anything is done.`;
    } else if (stale) {
      said = 'The books changed after a person was shown what this would do, so Ironbooks made a new preview. Nothing was done: a person must look at the new preview and decide again.';
    } else if (firstOfTwo) {
      said = `One person approved it (${r.decidedByName}); a second person must also approve it before anything is done.`;
    } else {
      said = 'A person has not decided yet.';
    }
    next = `Call wait_for_decision again to keep waiting, or carry on with other work and check later. Do not send the request again: it is already waiting.${r.expiresAt ? ` If nobody decides, it expires at ${r.expiresAt}.` : ''}`;
  } else if (stillRunning(r)) {
    // Not announced as decided: it can still end as failed.
    said = isGrant ? `Approved${by}. Ironbooks is setting up the standing permission.` : `Approved${by}. Ironbooks is carrying it out.`;
    next = 'Call wait_for_decision again in a moment for the result.';
  } else if (done && isGrant) {
    said = given
      ? `Approved${by}: you have standing permission for ${r.operation} until ${given.endsAt}, within the limits you were given (limits_given).`
      : `Approved${by}: you have standing permission for ${r.operation}.`;
    next = given
      ? `Run the operation now (run_operation with operation "${r.operation}"). Requests within limits_given run without asking until ${given.endsAt}; anything outside them still asks a person. The person may have given less than you asked for: go by limits_given, not by what you asked.`
      : `Run the operation now (run_operation with operation "${r.operation}"). The person may have narrowed the limits or the time you asked for: get_my_permissions shows the limits you were given and when it ends. Requests within them run without asking until then.`;
  } else if (done) {
    said = `Approved${by}, and ${r.posted === true ? 'posted to the books' : 'done'}.`;
    if (given) said += ` The person also gave you standing permission for more of the same until ${given.endsAt}, within limits_given.`;
    else if (r.grantError) said += ' The person also wanted to give you standing permission for more of the same, but it was not given (standing_permission_not_given says why): each one still asks.';
    next = file ? `Call get_file with file_id "${file.file_id}" to read the file it made.` : r.operation === REPORT_READ ? REPORT_READ_DONE : 'It is done. Do not send it again.';
  } else if (r.status === 'denied') {
    said = `Denied${by}. Nothing was done.`;
    next = "Do not send it again. Read the person's note; if the work still needs doing, ask the person what they would like instead.";
  } else if (r.status === 'expired') {
    said = 'Nobody decided in time, so the request expired. Nothing was done.';
    next = 'If it is still needed, ask again with a NEW request_id, and let the person know it is waiting for them.';
  } else if (r.status === 'cancelled') {
    said = 'The request was withdrawn. Nothing was done.';
  } else if (r.status === 'failed') {
    said = isGrant ? `Approved${by}, but Ironbooks could not set up the standing permission.` : `Approved${by}, but Ironbooks could not carry it out.`;
    next = isGrant
      ? 'Read the error. You hold no standing permission from this request: ask for each request one at a time, or ask again for standing permission that fits what the error says.'
      : 'Read the error. If the request can be fixed, dry run the corrected one and ask again with a NEW request_id.';
  }
  // What the agent asked for is shown while it waits (labelled as asked); once given, only what
  // was given, so the agent never takes the wider limits it asked for as its own.
  const showAsked = isGrant && !!r.grantAsked && !given;
  const row = compact({
    request_id: r.id,
    kind: isGrant ? 'standing permission' : undefined,
    decision,
    status: r.status !== decision ? r.status : undefined,
    said,
    stale: stale ? true : undefined,
    operation: r.operation,
    class: r.class,
    summary: r.summary,
    amount: r.amount,
    your_reason: r.reason,
    asked_at: r.createdAt,
    expires_at: pending ? r.expiresAt : undefined,
    decided_at: pending ? undefined : r.decidedAt,
    decided_by: pending ? undefined : r.decidedByName,
    first_approved_by: firstOfTwo ? r.decidedByName : undefined,
    first_approved_at: firstOfTwo ? r.decidedAt : undefined,
    second_approver: r.secondApproverName,
    note_from_person: r.note,
    error: r.error,
    limits_you_asked: showAsked ? limitsOf(r.grantAsked.constraints) : undefined,
    minutes_you_asked: showAsked ? r.grantAsked.minutes : undefined,
    standing_permission: r.grantId,
    limits_given: given ? given.limits : undefined,
    minutes_given: given ? given.minutes : undefined,
    standing_permission_ends_at: given ? given.endsAt : undefined,
    standing_permission_not_given: done && !given && r.grantError ? r.grantError : undefined,
    entry_ids: opts.full && done && Array.isArray(r.entryIds) ? r.entryIds : undefined,
    result: opts.full ? r.result : undefined,
    file: opts.full ? file : undefined,
    next: opts.full ? next : undefined,
  });
  // A request's result is the approved run's: once run, the rest is never seen by sending it again;
  // not run (it failed, say), sending it again shows nothing either.
  if (!opts.full) return row;
  return holdToLimit(row, MAX_RESULT_CHARS, done ? { phase: 'done' } : { rest: { result: REQUEST_RESULT_REST } });
}

/** How to see the rest of a long result on a request that was not carried out: not by sending it again. */
const REQUEST_RESULT_REST = 'Do not send the request again to see the rest: read the error and what to do next (next).';

/** Per server session, the requests whose decision the client was already told about. */
const announced = new WeakMap();

/**
 * Tell the client a request was decided: a log message, and a resource change if it subscribed.
 * Once per request: reading a decided request again (wait_for_decision with timeout 0, say) is
 * not news.
 */
function announce(/** @type {any} */ session, /** @type {any} */ r, /** @type {string} */ asked) {
  if (!session) return;
  let told = announced.get(session);
  if (!told) announced.set(session, (told = new Set()));
  const id = String(r.id ?? asked);
  if (told.has(id)) return;
  told.add(id);
  const out = shapeRequest(r);
  session.log('notice', { message: `Ironbooks: ${out.summary ?? r.operation ?? 'a request'}: ${out.said}`, request_id: r.id, decision: out.decision });
  for (const id of new Set([r.id, asked])) {
    const uri = `${REQUEST_URI_PREFIX}${id}`;
    if (session.subscribed(uri)) session.notify('notifications/resources/updated', { uri });
  }
}

/** Read one of the agent's requests, waiting up to `waitSeconds` for a decision. Null when there is none. */
async function getRequest(/** @type {any} */ client, /** @type {string} */ id, /** @type {number} */ waitSeconds) {
  let res;
  try {
    res = await client.get(`/api/agent/requests/${encodeURIComponent(id)}`, { wait: waitSeconds }, { wait: waitSeconds > 0 });
  } catch (err) {
    if (err instanceof Error && /** @type {any} */ (err).status === 404) return null;
    throw err;
  }
  const r = res?.request && typeof res.request === 'object' ? res.request : null;
  // A request for a restart tells the connector not to start a second Ironbooks meanwhile.
  if (r) client.noteRequest?.(r);
  return r;
}

/**
 * The same, but when no wait can be held open for it right now (this connector already holds
 * MAX_OPEN_WAITS, or Ironbooks answers 429 because the agent holds as many as it allows), it is
 * read at once without waiting, and `held` says why, so the agent is told to check later instead
 * of being refused.
 * @returns {Promise<{ request: any, held: { retryAfter: number, here: boolean } | null }>}
 */
async function readRequest(/** @type {any} */ client, /** @type {string} */ id, /** @type {number} */ waitSeconds) {
  try {
    return { request: await getRequest(client, id, waitSeconds), held: null };
  } catch (err) {
    const e = /** @type {any} */ (err);
    const here = e?.code === WAITS_BUSY_CODE;
    if (waitSeconds <= 0 || !(here || e?.status === 429)) throw err;
    return { request: await getRequest(client, id, 0), held: { retryAfter: here ? 0 : Number(e.retryAfter) || 0, here } };
  }
}

/** What to do next when the wait could not be held open and the request is still undecided. */
function checkLater(/** @type {{ retryAfter: number, here: boolean }} */ held) {
  const why = held.here
    ? 'You are already waiting on other requests here, so this one was read now, without waiting.'
    : 'Ironbooks is already holding as many waits for you as it allows, so this one was read now, without waiting.';
  const when = held.here
    ? 'once one of your other waits has come back'
    : `in ${Math.max(held.retryAfter, 5)} seconds or more`;
  return `${why} Check this request later: call wait_for_decision for it again ${when}, or carry on with other work first. Do not send the request again: it is already waiting.`;
}

const NOT_FOUND = 'There is no request of yours with that id. list_my_requests shows the requests you made.';

/** The resource ironbooks://requests/<id>: one request, read now. Null when there is none. */
export async function readRequestResource(/** @type {string} */ uri, /** @type {any} */ client) {
  const id = uri.slice(REQUEST_URI_PREFIX.length);
  if (!new RegExp(ID_TEXT).test(id)) return null;
  const r = await getRequest(client, id, 0);
  if (!r) return null;
  return [{ uri, mimeType: 'application/json', text: JSON.stringify(shapeRequest(r, { full: true })) }];
}

export const REQUEST_TEMPLATE = {
  uriTemplate: `${REQUEST_URI_PREFIX}{request_id}`,
  name: 'request',
  title: 'One of your permission requests',
  description: 'What you asked a person for and what they decided. Subscribe to hear when it is decided while wait_for_decision is waiting.',
  mimeType: 'application/json',
};

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const LIST_REQUESTS_SCHEMA = schema({
  status: { type: 'string', enum: REQUEST_STATUSES, description: 'Only requests with this status. executed means approved and done.' },
  limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many, newest first (default 50).' },
});

/** list_my_requests and its older name list_my_proposals: one handler, one answer. */
async function listMyRequests(/** @type {any} */ a, /** @type {any} */ c) {
  const views = asList(await verb(c, 'list_my_requests', { status: a.status, limit: a.limit }), 'requests');
  for (const r of views) if (r && typeof r === 'object') c.noteRequest?.(r);
  const rows = views.map((r) => shapeRequest(r));
  return { count: rows.length, requests: rows, ...(rows.length ? { note: 'wait_for_decision with a request_id gives one request in full, with its result.' } : {}) };
}

/** @type {import('./protocol.mjs').Tool[]} */
export const OPERATION_TOOLS = [
  {
    name: 'find_operations',
    title: 'Find an operation',
    description:
      'Search everything Ironbooks can do (about 800 operations: every action a person has in the app) when none of the named tools fits. Search by words ("email invoice", "budget", "closing date"), by area, or by class. Each result gives the operation id, what it does, its class, and its treatment: run (you may run it now), ask (a person must approve it) or refused (you cannot, and why). At most 30 results. Next: describe_operation for the fields of one.',
    inputSchema: schema({
      query: { type: 'string', maxLength: 200, description: 'Words to look for in the operation\'s id, description and route.' },
      area: { type: 'string', enum: AREAS, description: 'Only operations in this area of the app.' },
      class: { type: 'string', enum: RISK_CLASSES, description: 'Only operations of this class (the guide, ironbooks://guide, says what each means).' },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Most results (default 30).' },
    }),
    handler: async (a, c) => {
      const res = await verb(c, 'find_operations', { query: a.query, area: a.area, class: a.class, limit: a.limit });
      const rows = asList(res, 'operations').map(summaryRow);
      return {
        count: rows.length,
        operations: rows,
        treatments: TREATMENTS,
        ...(res?.more ? { more: true, note: 'There are more. Add words, an area or a class to narrow the search.' } : {}),
        next: rows.length
          ? 'Call describe_operation with an operation id for its fields, then run_operation with dry_run true.'
          : 'Nothing matched. Try other words, or leave out the area or the class.',
      };
    },
  },
  {
    name: 'describe_operation',
    title: 'Describe an operation',
    description:
      'Everything needed to run one operation: its path parameters, the JSON Schema of its query and its body (in the app\'s own field names, camelCase), what it returns, whether it can be dry run, the warnings it may raise and their confirm flags, whether it needs a person\'s password or key (never yours to ask for), what it does outside the books, how your policy treats it, and worked examples where Ironbooks has them.',
    inputSchema: schema({ operation: OPERATION }, ['operation']),
    handler: async (a, c) => {
      const d = await verb(c, 'describe_operation', { operation: a.operation });
      rememberFlags(c, d);
      return shapeDescription(d);
    },
  },
  {
    name: 'run_operation',
    title: 'Run an operation',
    changes: true,
    destructive: true,
    description:
      'Run any operation by its id (from find_operations), with the input describe_operation shows. dry_run true runs it inside Ironbooks and rolls it back: you see what it would post, change or send, and nothing is kept. Without dry_run it runs for real when your policy allows it; when a person must approve it the answer is "asked" (give a reason), and you call wait_for_decision. "needs_confirmation" means a warning a person would have been asked about: resend with the flag in confirm only if going ahead is right. Anything kept needs a request_id; the same request_id never runs twice. When you change or void a record you read, send its updatedAt as expected_updated_at: a 409 (conflict) then means someone changed it after you read it, and nothing was changed.',
    inputSchema: schema(
      {
        operation: OPERATION,
        params: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 500 },
          maxProperties: 20,
          description: 'Path parameters by name, as describe_operation lists them, for example { "id": "<invoice id>" }.',
        },
        query: {
          type: 'object',
          additionalProperties: {
            // As many as the door takes (lib/agent/operate.ts runOperationArgs).
            anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2000 } }],
            anyOfHint: 'must be text, or a list of text',
          },
          maxProperties: 50,
          description: 'Query values by name, as describe_operation\'s query_schema shows them. Each is text, or a list of text.',
        },
        body: {
          description:
            'The body, in the app\'s own field names (camelCase), exactly as describe_operation\'s body_schema shows it. Usually an object. Where it takes a file, give { "fileId": "<file_id>" } from upload_file or attach_local_file.',
        },
        dry_run: { type: 'boolean', description: 'true: try it and show what it would do, keeping nothing. Do this first for anything that changes something. No request_id is needed (one given is not used).' },
        request_id: REQUEST_ID,
        reason: REASON,
        confirm: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{0,79}$', patternHint: 'must be a flag a warning named, for example allowDuplicateNumber' },
          description: 'Flags of warnings you accept, each named by an earlier needs_confirmation answer (for example ["allowDuplicateNumber"]). Only after reading the warning, and only when going ahead is right.',
        },
        reveal: { type: 'boolean', description: 'Ask for protected values in full (Social Security numbers, bank account numbers). Always asks a person, for this one call.' },
        expected_updated_at: EXPECTED_VERSION,
      },
      ['operation'],
    ),
    handler: async (a, c) => {
      const dryRun = a.dry_run === true;
      const version = typeof a.expected_updated_at === 'string' && a.expected_updated_at ? a.expected_updated_at : undefined;
      let answer;
      try {
        answer = await verb(c, 'run_operation', {
          operation: a.operation,
          params: a.params,
          query: a.query,
          body: a.body,
          confirm: Array.isArray(a.confirm) && a.confirm.length ? a.confirm : undefined,
          reveal: a.reveal === true ? true : undefined,
          // Sent with a dry run too: the route's own check then says at once that it changed since.
          expectedUpdatedAt: version,
          // A dry run keeps nothing, so it is never filed under a request id the real run will need.
          ...(dryRun ? { dryRun: true } : { requestId: a.request_id, reason: a.reason }),
        });
      } catch (err) {
        // The route's words for a record changed since say to reload, which an agent cannot do.
        const e = /** @type {any} */ (err);
        if (version && e?.isIronbooksError === true && e.status === 409) throw new ToolError(`${sentence(e.message)} ${VERSION_CHANGED}`);
        throw err;
      }
      // Asking for a restart (a company file switched, an update installed): until it is decided,
      // a silence of Ironbooks may be that restart, so no second copy is started meanwhile.
      if (answer?.outcome === 'asked' && typeof answer.requestId === 'string') {
        c.noteRequest?.({ id: answer.requestId, operation: answer.operation ?? a.operation, status: answer.status ?? 'pending' });
      }
      // A warning's flag is offered for sending again only when the operation lists it: the door
      // accepts no other flag with it, so any other warning is one to change the request for.
      if (answer?.outcome === 'needs_confirmation') {
        const flags = await confirmFlagsOf(c, typeof answer.operation === 'string' ? answer.operation : a.operation);
        return settleLong(answer, flags ? { confirm: flags } : { fields: 'confirm' });
      }
      return settleLong(answer);
    },
  },
  {
    name: 'wait_for_decision',
    title: 'Wait for a person\'s decision',
    description:
      'After an answer said "asked": wait until a person approves or denies the request in Ironbooks, it expires, or the time runs out (at most 50 seconds; call again while it is pending). The answer is approved (with the result), denied (with the person\'s note), expired, failed (approved but it could not be carried out, with the error) or pending, with what to do next. timeout_seconds 0 reads where it stands now. Wait for one request at a time: at most two waits run at once, and a third is read at once without waiting, with advice to check it later.',
    inputSchema: schema(
      {
        request_id: REQUEST_REF,
        timeout_seconds: { type: 'integer', minimum: 0, maximum: WAIT_MAX_SECONDS, description: `How long to wait, in seconds (default ${WAIT_MAX_SECONDS}, at most ${WAIT_MAX_SECONDS}).` },
      },
      ['request_id'],
    ),
    handler: async (a, c, session) => {
      const wait = a.timeout_seconds ?? WAIT_MAX_SECONDS;
      const { request: r, held } = await readRequest(c, a.request_id, wait);
      if (!r) throw new ToolError(NOT_FOUND);
      if (isSettled(r)) announce(session, r, a.request_id);
      const out = shapeRequest(r, { full: true });
      if (held && r.status === 'pending') {
        out.next = checkLater(held);
        if (!held.here) out.check_again_after_seconds = Math.max(held.retryAfter, 5);
      }
      return out;
    },
  },
  {
    name: 'list_my_requests',
    title: 'My requests',
    description:
      'What you asked a person to approve (requests and standing permissions), newest first, and what became of each: pending, approved, denied, expired, cancelled or failed, with the person\'s note. For one request in full, with its result, use wait_for_decision.',
    inputSchema: LIST_REQUESTS_SCHEMA,
    handler: listMyRequests,
  },
  {
    name: 'list_my_proposals',
    title: 'My requests (older name)',
    description: 'The older name of list_my_requests, kept for agents that use it: the same requests, the same answer. Prefer list_my_requests.',
    inputSchema: LIST_REQUESTS_SCHEMA,
    handler: listMyRequests,
  },
  {
    name: 'cancel_request',
    title: 'Withdraw a request',
    changes: true,
    description: 'Withdraw a request that is still waiting for a person, for example when it is no longer needed or you made a mistake in it. Nothing is done for a withdrawn request. A request already decided cannot be withdrawn.',
    inputSchema: schema({ request_id: REQUEST_REF }, ['request_id']),
    handler: async (a, c) => {
      const r = (await verb(c, 'cancel_request', { requestId: a.request_id }))?.request;
      if (!r || typeof r !== 'object') throw new ToolError(NOT_FOUND);
      c.noteRequest?.(r);
      const out = shapeRequest(r);
      if (r.status !== 'cancelled') out.said = `It could not be withdrawn: it is already ${out.decision}. ${out.said ?? ''}`.trim();
      return out;
    },
  },
  {
    name: 'get_my_permissions',
    title: 'What I may do',
    description:
      'What you may do in these books: your role, your policy for each class (allow: on your own; ask: a person approves each request; never: not allowed), anything different per area, the standing permissions you hold now, the most records one request may change, the amount above which two people must approve, how long a request waits, the folders you may use for files, whether you are paused, and whether someone is signed in to answer a request right now.',
    inputSchema: schema({}),
    handler: async (_a, c) => {
      const p = (await verb(c, 'get_my_permissions', {})) ?? {};
      const notes = [];
      if (p.paused) notes.push('You are paused: everything is refused until a person resumes you under Users & Roles > Agents.');
      if (p.someoneSignedIn === false) notes.push('Nobody is signed in right now: a request that needs a person waits until someone signs in.');
      return {
        ...compact({
          agent: p.agent?.name,
          roles: p.roles,
          preset: p.preset,
          paused: p.paused === true,
          someone_signed_in: p.someoneSignedIn,
          classes: p.classes,
          by_area: p.areas && Object.keys(p.areas).length ? p.areas : undefined,
          settings_mean: SETTING_MEANINGS,
          most_records_per_request: p.bulkCap,
          two_people_approve_above: p.twoPersonOver,
          requests_expire_after_days: p.requestExpiryDays,
        }),
        // Shown even when empty: no folders means no files from or to this computer.
        folders: Array.isArray(p.folders) ? p.folders : [],
        standing_permissions: asList(p.grants, 'grants').map((g) =>
          compact({ standing_permission: g.id, operation: g.operation, limits: limitsOf(g.constraints), expires_at: g.expiresAt, uses: g.uses }),
        ),
        ...(notes.length ? { notes } : {}),
      };
    },
  },
  {
    name: 'ask_for_permission',
    title: 'Ask ahead for standing permission',
    changes: true,
    description: `Ask a person ahead of time for standing permission to run one operation without asking each time, within limits you propose and for some minutes, for example "enter bills from these 12 vendors this afternoon". A person approves or denies it in Ironbooks (call wait_for_decision); they may narrow the limits or shorten the time, and get_my_permissions shows what you were given. ${STANDING_TEXT}`,
    inputSchema: schema(
      {
        operation: OPERATION,
        constraints: {
          type: 'object',
          additionalProperties: false,
          description: 'The limits you propose. Every limit given must hold for a request to run under the permission.',
          properties: {
            entity_ids: { type: 'array', maxItems: 200, items: { ...ID }, description: 'Only these customers, vendors or other names.' },
            account_ids: { type: 'array', maxItems: 200, items: { ...ID }, description: 'Only these accounts.' },
            max_amount: { ...MONEY, description: 'Each request at most this amount.' },
            date_from: { ...DATE, description: 'Only transactions dated on or after this day.' },
            date_to: { ...DATE, description: 'Only transactions dated on or before this day.' },
            max_uses: { type: 'integer', minimum: 1, maximum: 10000, description: 'At most this many requests in all.' },
            max_count: { type: 'integer', minimum: 1, maximum: 100000, description: 'At most this many records changed by one request.' },
          },
        },
        minutes: {
          type: 'integer',
          minimum: 1,
          maximum: 1440,
          description: `How long it should last, in minutes. The person may shorten it. It ends at the end of the day at the latest; ${Object.entries(STANDING)
            .filter(([, s]) => s === 'short')
            .map(([c]) => c)
            .join(' and ')} at most ${SHORT_GRANT_MINUTES}.`,
        },
        reason: { ...REASON, description: 'What you are about to do and why you need it, in one or two plain sentences (at most 500 characters). The person sees it labelled as your words.' },
        request_id: REQUEST_ID,
      },
      ['operation', 'reason', 'request_id'],
    ),
    handler: async (a, c) =>
      settleLong(
        await verb(c, 'ask_for_permission', {
          operation: a.operation,
          constraints: a.constraints ? camelize(a.constraints) : undefined,
          minutes: a.minutes,
          reason: a.reason,
          requestId: a.request_id,
        }),
      ),
  },
];
