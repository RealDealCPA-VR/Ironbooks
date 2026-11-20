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
 * sent on its own connection so other tools are not held up. When it comes back decided, the
 * client also hears about it as a log message and, if it subscribed, as a change of the resource
 * ironbooks://requests/<id> (plan §6.2). The answer of wait_for_decision stays the dependable path.
 */
import { ToolError } from './protocol.mjs';
import { CLASS_MEANINGS, SETTING_MEANINGS, SHORT_GRANT_MINUTES, STANDING, STANDING_TEXT } from './guide.mjs';
import { camelize, settle } from './write-tools.mjs';

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

const CUT_NOTE = 'The answer was too long to show in full: its longest lists were cut. Narrow the request (dates, a filter, a limit in the query) to see everything.';
const TOO_LONG_NOTE = 'The answer was too long to show. Narrow the request (dates, a filter, a limit in the query).';

/** The parts of a shaped answer that say what happened and what to do next: never left out. */
const ALWAYS_SHOWN = new Set(['outcome', 'said', 'next', 'request_id', 'status', 'who_decides', 'warnings', 'note', 'file', 'summary', 'repeated', 'note_repeat', 'under_standing_permission', 'proposal_id']);

/**
 * Run settle() on an answer that may be very long anywhere: its result, the operation's own
 * preview (route_preview), the records it would change. The whole shaped answer is held to
 * MAX_RESULT_CHARS: first by cutting its longest lists; when even that is not enough (one very long
 * text), by leaving out its longest parts, never what it says happened or what to do next.
 */
function settleLong(/** @type {any} */ answer) {
  const shaped = settle(answer, { fields: 'confirm' });
  const cut = cutToFit(shaped);
  if (!cut) return shaped;
  if (cut.value) return { .../** @type {object} */ (cut.value), result_cut_short: CUT_NOTE };
  /** @type {Record<string, unknown>} */
  let rest = { ...shaped };
  const leftOut = [];
  const bulky = Object.keys(rest)
    .filter((k) => !ALWAYS_SHOWN.has(k))
    .sort((a, b) => jsonLength(rest[b]) - jsonLength(rest[a]));
  for (const k of bulky) {
    delete rest[k];
    leftOut.push(k);
    const again = cutToFit(rest);
    if (!again) break;
    if (again.value) {
      rest = /** @type {Record<string, unknown>} */ (again.value);
      break;
    }
  }
  return { ...rest, left_out: leftOut, result_cut_short: TOO_LONG_NOTE };
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

/** describe_operation's answer, for the agent (lib/agent/contract.ts OperationDescription). */
export function shapeDescription(/** @type {any} */ d) {
  if (!d || typeof d !== 'object' || !d.id) throw new ToolError('Ironbooks did not describe that operation. Check the id with find_operations.');
  const needsSecret = Array.isArray(d.needsSecret) ? d.needsSecret : [];
  const effects = Array.isArray(d.effects) ? d.effects : [];
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

/** A grant's limits in the tools' words (lib/agent/operations/types.ts GrantConstraints). */
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

/**
 * One request as the agent reads it (lib/agent/contract.ts AgentRequestView): what it was, what a
 * person decided, in plain words, and what to do next. `full`: with the result of the run.
 * @param {any} r
 * @param {{ full?: boolean }} [opts]
 */
export function shapeRequest(r, opts = {}) {
  const decision = DECISIONS[/** @type {keyof typeof DECISIONS} */ (r.status)] ?? r.status;
  const by = r.decidedByName ? ` by ${r.decidedByName}` : '';
  const pending = r.status === 'pending';
  // Two people must approve (a large amount): after the first, the request stays pending with
  // that person's name on it until a second, different person approves it too.
  const firstOfTwo = pending && !!r.decidedByName;
  const file = r.file && r.file.fileId ? { file_id: r.file.fileId, name: r.file.name, type: r.file.type, size: r.file.size } : undefined;
  let said;
  let next;
  if (pending) {
    said = firstOfTwo
      ? `Approved by ${r.decidedByName}. A second person must also approve it before anything is done.`
      : 'A person has not decided yet.';
    next = `Call wait_for_decision again to keep waiting, or carry on with other work and check later. Do not send the request again: it is already waiting.${r.expiresAt ? ` If nobody decides, it expires at ${r.expiresAt}.` : ''}`;
  } else if (stillRunning(r)) {
    said = r.kind === 'grant' ? `Approved${by}. Ironbooks is setting up the standing permission.` : `Approved${by}. Ironbooks is carrying it out.`;
    next = 'Call wait_for_decision again in a moment for the result.';
  } else if (decision === 'approved' && r.kind === 'grant') {
    said = `Approved${by}: you have standing permission for ${r.operation}.`;
    next = `Run the operation now (run_operation with operation "${r.operation}"). The person may have narrowed the limits or the time you asked for: get_my_permissions shows the limits you were given and when it ends. Requests within them run without asking until then.`;
  } else if (decision === 'approved') {
    said = `Approved${by}, and done.`;
    next = file ? `Call get_file with file_id "${file.file_id}" to read the file it made.` : 'It is done. Do not send it again.';
  } else if (r.status === 'denied') {
    said = `Denied${by}. Nothing was done.`;
    next = "Do not send it again. Read the person's note; if the work still needs doing, ask the person what they would like instead.";
  } else if (r.status === 'expired') {
    said = 'Nobody decided in time, so the request expired. Nothing was done.';
    next = 'If it is still needed, ask again with a NEW request_id, and let the person know it is waiting for them.';
  } else if (r.status === 'cancelled') {
    said = 'The request was withdrawn. Nothing was done.';
  } else if (r.status === 'failed') {
    said = `Approved${by}, but Ironbooks could not carry it out.`;
    next = 'Read the error. If the request can be fixed, dry run the corrected one and ask again with a NEW request_id.';
  }
  const cut = opts.full && r.result !== undefined && r.result !== null ? cutToFit(r.result) : null;
  return compact({
    request_id: r.id,
    kind: r.kind === 'grant' ? 'standing permission' : undefined,
    decision,
    status: r.status !== decision ? r.status : undefined,
    said,
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
    // What the agent asked for, not what it was given: the person may narrow both.
    limits_you_asked: r.kind === 'grant' && r.grantAsked ? limitsOf(r.grantAsked.constraints) : undefined,
    minutes_you_asked: r.kind === 'grant' && r.grantAsked ? r.grantAsked.minutes : undefined,
    standing_permission: r.grantId,
    result: opts.full ? (cut ? cut.value : r.result) : undefined,
    result_cut_short: cut ? (cut.value === null ? TOO_LONG_NOTE : CUT_NOTE) : undefined,
    file: opts.full ? file : undefined,
    next: opts.full ? next : undefined,
  });
}

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
async function readRequest(/** @type {any} */ client, /** @type {string} */ id, /** @type {number} */ waitSeconds) {
  let res;
  try {
    res = await client.get(`/api/agent/requests/${encodeURIComponent(id)}`, { wait: waitSeconds }, { wait: waitSeconds > 0 });
  } catch (err) {
    if (err instanceof Error && /** @type {any} */ (err).status === 404) return null;
    throw err;
  }
  return res?.request && typeof res.request === 'object' ? res.request : null;
}

const NOT_FOUND = 'There is no request of yours with that id. list_my_requests shows the requests you made.';

/** The resource ironbooks://requests/<id>: one request, read now. Null when there is none. */
export async function readRequestResource(/** @type {string} */ uri, /** @type {any} */ client) {
  const id = uri.slice(REQUEST_URI_PREFIX.length);
  if (!new RegExp(ID_TEXT).test(id)) return null;
  const r = await readRequest(client, id, 0);
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
  const rows = asList(await verb(c, 'list_my_requests', { status: a.status, limit: a.limit }), 'requests').map((r) => shapeRequest(r));
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
      'Everything needed to run one operation: its path parameters, the JSON Schema of its query and its body (in the app\'s own field names, camelCase), what it returns, whether it can be dry run, the warnings it may raise and their confirm flags, whether it needs a person\'s password or key (never yours to ask for), what it does outside the books, and how your policy treats it.',
    inputSchema: schema({ operation: OPERATION }, ['operation']),
    handler: async (a, c) => shapeDescription(await verb(c, 'describe_operation', { operation: a.operation })),
  },
  {
    name: 'run_operation',
    title: 'Run an operation',
    changes: true,
    destructive: true,
    description:
      'Run any operation by its id (from find_operations), with the input describe_operation shows. dry_run true runs it inside Ironbooks and rolls it back: you see what it would post, change or send, and nothing is kept. Without dry_run it runs for real when your policy allows it; when a person must approve it the answer is "asked" (give a reason), and you call wait_for_decision. "needs_confirmation" means a warning a person would have been asked about: resend with the flag in confirm only if going ahead is right. Anything kept needs a request_id; the same request_id never runs twice.',
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
            anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 2000 } }],
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
      },
      ['operation'],
    ),
    handler: async (a, c) => {
      const dryRun = a.dry_run === true;
      const answer = await verb(c, 'run_operation', {
        operation: a.operation,
        params: a.params,
        query: a.query,
        body: a.body,
        confirm: Array.isArray(a.confirm) && a.confirm.length ? a.confirm : undefined,
        reveal: a.reveal === true ? true : undefined,
        // A dry run keeps nothing, so it is never filed under a request id the real run will need.
        ...(dryRun ? { dryRun: true } : { requestId: a.request_id, reason: a.reason }),
      });
      return settleLong(answer);
    },
  },
  {
    name: 'wait_for_decision',
    title: 'Wait for a person\'s decision',
    description:
      'After an answer said "asked": wait until a person approves or denies the request in Ironbooks, it expires, or the time runs out (at most 50 seconds; call again while it is pending). The answer is approved (with the result), denied (with the person\'s note), expired, failed (approved but it could not be carried out, with the error) or pending, with what to do next. timeout_seconds 0 reads where it stands now. Wait for one request at a time: at most two waits run at once, and a third waits for one of them to finish first.',
    inputSchema: schema(
      {
        request_id: REQUEST_REF,
        timeout_seconds: { type: 'integer', minimum: 0, maximum: WAIT_MAX_SECONDS, description: `How long to wait, in seconds (default ${WAIT_MAX_SECONDS}, at most ${WAIT_MAX_SECONDS}).` },
      },
      ['request_id'],
    ),
    handler: async (a, c, session) => {
      const wait = a.timeout_seconds ?? WAIT_MAX_SECONDS;
      const r = await readRequest(c, a.request_id, wait);
      if (!r) throw new ToolError(NOT_FOUND);
      if (isSettled(r)) announce(session, r, a.request_id);
      return shapeRequest(r, { full: true });
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
      settle(
        await verb(c, 'ask_for_permission', {
          operation: a.operation,
          constraints: a.constraints ? camelize(a.constraints) : undefined,
          minutes: a.minutes,
          reason: a.reason,
          requestId: a.request_id,
        }),
        { fields: 'confirm' },
      ),
  },
];
