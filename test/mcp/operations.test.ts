/**
 * The generic door (mcp/operations-tools.mjs): find, describe and run any operation, wait for a
 * person's decision, list and withdraw requests, read the agent's permissions, ask ahead for
 * standing permission; the guide (mcp/guide.mjs) as a resource and a prompt; and every tool's
 * input schema checked as real JSON Schema against what the tool itself accepts.
 *
 * The app is a recording stand-in, as in tools.test.ts: the verbs are still stubs on the server
 * side, so these tests hold the connector to the contract (lib/agent/contract.ts AgentVerbs).
 *
 * The JSON Schema checks use ajv, which is not a dependency of Ironbooks: today it is installed only
 * because electron-builder brings it. It is loaded when it can be found, and those cases are
 * skipped, saying why, when it cannot.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { argumentProblem, createServer } from '../../mcp/protocol.mjs';
import { IronbooksError, WAITS_BUSY_CODE, WAITS_BUSY_MESSAGE } from '../../mcp/client.mjs';
import { createIronbooksServer } from '../../mcp/ironbooks-mcp.mjs';
import { TOOLS } from '../../mcp/tools.mjs';
import { AREAS, MAX_RESULT_CHARS, OPERATION_TOOLS, REQUEST_STATUSES, RISK_CLASSES, WAIT_MAX_SECONDS, cutToFit, holdToLimit, shapeRequest } from '../../mcp/operations-tools.mjs';
import { FILE_TOOLS, STAGED_FILE_HOURS, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../../mcp/files-tools.mjs';
import { ENTRY_TOOLS } from '../../mcp/entry-tools.mjs';
import {
  ADMIN_GIVES_STANDING,
  CLASS_MEANINGS,
  DOOR_ENTRY_TOOLS,
  FIND_EXAMPLES,
  GUIDE_PROMPT_NAME,
  GUIDE_TEXT,
  GUIDE_URI,
  NAMED_ENTRY_TOOLS,
  NAMED_FIX_TOOLS,
  NAMED_REPORT_TOOLS,
  SHORT_GRANT_MINUTES,
  STANDING,
  STANDING_TEXT,
} from '../../mcp/guide.mjs';
import * as contract from '@/lib/agent/contract';
import * as registry from '@/lib/agent/operations/registry';
import * as policy from '@/lib/agent/policy';
import * as types from '@/lib/agent/operations/types';
import { AREA_KEYS } from '@/lib/permissions/model';

type Any = Record<string, any>;

/** The little of ajv these tests use (no types from the package: it may not be installed). */
interface Validator {
  (data: unknown): boolean;
  errors?: unknown;
}
interface AjvLike {
  addKeyword(def: { keyword: string; schemaType: string }): unknown;
  compile(schema: unknown): Validator;
}
type AjvClass = new (opts: { strict: boolean; allErrors: boolean }) => AjvLike;

/**
 * A package's default export, or null when it cannot be found here. Loaded at run time, so a
 * package that is not installed never breaks the whole file at import.
 */
function loadOptional<T>(id: string): T | null {
  try {
    const m = createRequire(import.meta.url)(id);
    return (m?.default ?? m) as T;
  } catch {
    return null;
  }
}
/** ajv's JSON Schema 2020-12 validator (not a declared dependency). */
const Ajv2020 = loadOptional<AjvClass>('ajv/dist/2020');
const AJV_MISSING =
  'skipped: ajv is not installed here. It is not a dependency of Ironbooks (it arrives only through electron-builder), so the JSON Schema checks run only where it can be found.';
if (!Ajv2020) console.warn(`test/mcp/operations.test.ts: JSON Schema checks ${AJV_MISSING}`);

const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '99999999-2222-4333-8444-555555555555';
const FILE = 'ab'.repeat(16);

/** Records every POST (verb) and GET, and answers with the functions given. */
function fake(answers: { act?: (r: Any) => unknown; get?: (p: string, q: Any, o: Any) => unknown } = {}) {
  const acted: Any[] = [];
  const got: Array<{ path: string; query: Any; opts: Any }> = [];
  return {
    acted,
    got,
    client: {
      async act(r: Any) {
        acted.push(r);
        const a = answers.act ? answers.act(r) : {};
        if (a instanceof Error) throw a;
        return a;
      },
      async get(p: string, query: Any = {}, opts: Any = {}) {
        got.push({ path: p, query, opts });
        const a = answers.get ? answers.get(p, query, opts) : {};
        if (a instanceof Error) throw a;
        return a;
      },
    },
  };
}

async function call(client: unknown, name: string, args: Any = {}, capture?: Any[]) {
  const server = createIronbooksServer(client);
  if (capture) server.connect((m: Any) => capture.push(m));
  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as Any;
  expect(res.error, JSON.stringify(res.error)).toBeUndefined();
  const text: string = res.result.content[0].text;
  let data: Any = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* a message */
  }
  return { isError: res.result.isError as boolean, text, data, content: res.result.content as Any[] };
}

const REQUEST: Any = {
  id: ID,
  kind: 'operation',
  agentId: 'agent-1',
  agentName: 'Bookkeeping bot',
  operation: 'estimates.create',
  class: 'enter',
  area: 'customers',
  status: 'executed',
  reason: 'The customer asked for a quote.',
  summary: 'Estimate for Acme, $500.00',
  amount: '500.00',
  needs: null,
  input: { body: { customerId: ID2 } },
  preview: null,
  grantAsked: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  expiresAt: '2026-11-27T10:00:00.000Z',
  decidedAt: '2026-11-20T10:05:00.000Z',
  decidedByName: 'Dana Lee',
  secondApproverName: null,
  note: null,
  error: null,
  result: { id: ID2, total: '500.00' },
  file: null,
  grantId: null,
};

describe('the connector and the app agree', () => {
  it('on the classes, areas, statuses and limits it writes out by hand', () => {
    expect(RISK_CLASSES).toEqual([...types.RISK_CLASSES]);
    expect(Object.keys(CLASS_MEANINGS)).toEqual([...types.RISK_CLASSES]);
    expect(AREAS).toEqual([...AREA_KEYS]);
    expect(REQUEST_STATUSES).toEqual([...types.REQUEST_STATUSES]);
    expect(WAIT_MAX_SECONDS).toBe(contract.WAIT_MAX_SECONDS);
    expect(UPLOAD_CHUNK_BYTES).toBe(contract.UPLOAD_CHUNK_BYTES);
    expect(UPLOAD_MAX_BYTES).toBe(contract.UPLOAD_MAX_BYTES);
    expect(STAGED_FILE_HOURS).toBe(contract.STAGED_FILE_HOURS);
    // Which classes can be given standing permission, for how long, and by whom.
    expect(STANDING).toEqual({ ...types.GRANTABLE });
    expect(SHORT_GRANT_MINUTES).toBe(policy.SHORT_GRANT_MINUTES);
    expect(ADMIN_GIVES_STANDING).toEqual([...policy.ADMIN_GRANT_CLASSES]);
  });

  it('what each class says about standing permission matches what the app gives', () => {
    for (const c of types.RISK_CLASSES) {
      const means = CLASS_MEANINGS[c as keyof typeof CLASS_MEANINGS];
      const g = types.GRANTABLE[c];
      if (g === 'short') expect(means, c).toMatch(new RegExp(`standing permission[^.]*\\(at most ${SHORT_GRANT_MINUTES} minutes\\)`));
      if (g === 'no' && c !== 'read') expect(means, c).toMatch(/one (request|reveal) at a time/);
      if (g !== 'short') expect(means, c).not.toMatch(/standing permission/);
    }
    expect(CLASS_MEANINGS.outside).toMatch(/an Admin gave you standing permission/);
    // The tool and the guide say the same, in the app's terms.
    const ask = (OPERATION_TOOLS as Any[]).find((t) => t.name === 'ask_for_permission')!;
    expect(ask.description).toContain(STANDING_TEXT);
    expect(GUIDE_TEXT).toContain(STANDING_TEXT);
    expect(STANDING_TEXT).toBe(
      'Standing permission can be given for prepare, enter and change (until the end of the day at most); bulk (the same, and each request still within the most records one request may change); outside and print (at most 30 minutes; for outside, only an Admin can give it). It is never given for read_sensitive (protected data), remove (deleting), period (closed-period work), settings, admin (users and security), file (the company file) and secret (passwords and keys): each of those is asked one request at a time, so do not ask ahead for them. Nor does standing permission ever cover a request dated on or before the closing date (that is closed-period work, whatever the operation), one with reveal, or one sent with a confirm flag: each of those asks a person. Whatever its class, work that can only be approved at the computer that holds the company file (a test email, a download or install, printing a file), or that only the company file\'s Admin may approve, never gets standing permission, not even from an Admin: send each such request with run_operation.',
    );
    expect(ask.inputSchema.properties.minutes.description).toBe('How long it should last, in minutes. The person may shorten it. It ends at the end of the day at the latest; outside and print at most 30.');
  });

  it('every verb of the agent\'s door is reached by a tool, through the one action route', async () => {
    const { client, acted, got } = fake({
      act: (r) =>
        r.verb === 'upload_file'
          ? { uploadId: 'u'.repeat(32), received: 3, file: { fileId: FILE, name: 'a.txt', type: 'text/plain', size: 3 } }
          : r.verb === 'get_file'
            ? { file: { fileId: FILE, name: 'a.txt', type: 'text/plain', size: 3 }, base64: 'YWJj' }
            : r.verb === 'describe_operation'
              ? { id: 'x.y', describe: 'x', class: 'read', params: [], treatment: 'run' }
              : r.verb === 'cancel_request'
                ? { request: { ...REQUEST, status: 'cancelled' } }
                : { outcome: 'read', operation: 'x.y' },
      get: () => ({ request: REQUEST }),
    });
    const samples: Record<string, Any> = {
      find_operations: {},
      describe_operation: { operation: 'x.y' },
      run_operation: { operation: 'x.y' },
      wait_for_decision: { request_id: ID, timeout_seconds: 0 },
      list_my_requests: {},
      list_my_proposals: {},
      cancel_request: { request_id: ID },
      get_my_permissions: {},
      ask_for_permission: { operation: 'x.y', reason: 'Because.', request_id: 'ask-1' },
      upload_file: { name: 'a.txt', type: 'text/plain', base64: 'YWJj' },
      get_file: { file_id: FILE },
      save_file: { file_id: FILE, folder: 'C:\\Books', request_id: 'save-1' },
    };
    for (const t of [...OPERATION_TOOLS, ...FILE_TOOLS]) {
      if (t.name === 'attach_local_file') continue; // test/mcp/files.test.ts
      const r = await call(client, t.name, samples[t.name]);
      expect(r.isError, `${t.name}: ${r.text}`).toBe(false);
    }
    expect([...new Set(acted.map((a) => a.verb))].sort()).toEqual([...contract.AGENT_VERBS].sort());
    expect(acted.every((a) => typeof a.verb === 'string' && !('action' in a))).toBe(true);
    // The only GET: the agent's own request.
    expect(got.map((g) => g.path)).toEqual([`/api/agent/requests/${ID}`]);
  });
});

describe('finding and describing operations', () => {
  it('find_operations sends the search and lists each operation with how the policy treats it', async () => {
    const { client, acted } = fake({
      act: () => ({
        operations: [
          { id: 'estimates.create', describe: 'Create an estimate', class: 'enter', area: 'customers', method: 'POST', route: '/api/estimates', treatment: 'ask', why: 'A person approves new entries.' },
          { id: 'users.create', describe: 'Add a user', class: 'admin', area: 'users', method: 'POST', route: '/api/users', treatment: 'refused', why: 'Agents may not manage users.' },
        ],
        more: true,
      }),
    });
    const r = await call(client, 'find_operations', { query: 'estimate', area: 'customers', class: 'enter', limit: 10 });
    expect(acted[0]).toEqual({ verb: 'find_operations', query: 'estimate', area: 'customers', class: 'enter', limit: 10 });
    expect(r.data.operations[0]).toEqual({ operation: 'estimates.create', does: 'Create an estimate', class: 'enter', area: 'customers', method: 'POST', route: '/api/estimates', treatment: 'ask', why: 'A person approves new entries.' });
    expect(r.data).toMatchObject({ count: 2, more: true });
    expect(r.data.treatments.ask).toMatch(/wait_for_decision/);
    expect(r.data.next).toMatch(/describe_operation/);
    // Nothing given: nothing sent but the verb.
    await call(client, 'find_operations', {});
    expect(acted[1]).toEqual({ verb: 'find_operations' });
    for (const bad of [{ class: 'everything' }, { area: 'moon' }, { limit: 31 }, { query: 5 }]) {
      expect((await call(client, 'find_operations', bad)).isError, JSON.stringify(bad)).toBe(true);
    }
    expect(acted).toHaveLength(2);
  });

  it('describe_operation explains the fields, the dry run, the warnings and the secrets in plain words', async () => {
    const description = {
      id: 'company.closing-date.update',
      describe: 'Move the closing date to {date}',
      class: 'period',
      area: 'closing',
      method: 'PATCH',
      route: '/api/company/closing-date',
      treatment: 'ask',
      why: 'Closed-period work always needs a person.',
      params: [],
      bodySchema: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
      querySchema: null,
      body: 'json',
      output: 'json',
      dryRun: 'transaction',
      confirmFlags: ['allowLedgerRewrite'],
      reveal: null,
      needsSecret: ['closing_password'],
      effects: [],
      notes: ['The closing-date password is typed by the approver.'],
    };
    const { client, acted } = fake({ act: () => description });
    const r = await call(client, 'describe_operation', { operation: 'company.closing-date.update' });
    expect(acted[0]).toEqual({ verb: 'describe_operation', operation: 'company.closing-date.update' });
    expect(r.data).toMatchObject({
      operation: 'company.closing-date.update',
      class: 'period',
      class_means: CLASS_MEANINGS.period,
      treatment: 'ask',
      body_schema: description.bodySchema,
      confirm_flags: ['allowLedgerRewrite'],
      notes: description.notes,
    });
    expect(r.data.body).toMatch(/camelCase/);
    expect(r.data.dry_run).toMatch(/rolls it back/);
    expect(r.data.needs_secret).toMatch(/never ask for it and never send it/);
    expect(r.data.how_to_run).toMatch(/dry_run true first/);
    expect(r.data.how_to_run).toMatch(/and a reason/);
    expect(r.data).not.toHaveProperty('query_schema');
    // An id that is not one never reaches the app.
    expect((await call(client, 'describe_operation', { operation: '../users' })).isError).toBe(true);
    expect((await call(client, 'describe_operation', {})).text).toMatch(/"operation" is required/);
    expect(acted).toHaveLength(1);
    // No examples given: none shown, and nothing said about them.
    expect(r.data).not.toHaveProperty('examples');
    expect(r.data).not.toHaveProperty('examples_mean');
  });

  it('describe_operation passes on the worked examples (contract wave 4) as requests run_operation takes', async () => {
    const examples: unknown[] = [
      { title: 'A bill for one vendor', body: { vendorId: ID, lines: [{ accountId: ID2, amount: '120.00' }] } },
      { note: 'Its pay stub', params: { id: ID }, query: { format: 'pdf' }, reveal: true },
      { describe: 'With a warning accepted', body: { refNumber: '1001' }, confirm: ['allowDuplicateNumber', 5] },
      'not a request',
      { title: 'Words only' },
      ...Array.from({ length: 12 }, (_, i) => ({ body: { n: i } })),
    ];
    const { client } = fake({ act: () => ({ id: 'bills.create', describe: 'Enter a bill', class: 'enter', params: [], treatment: 'ask', body: 'json', confirmFlags: [], examples }) });
    const r = await call(client, 'describe_operation', { operation: 'bills.create' });
    expect(r.data.examples.slice(0, 3)).toEqual([
      { title: 'A bill for one vendor', body: { vendorId: ID, lines: [{ accountId: ID2, amount: '120.00' }] } },
      { note: 'Its pay stub', params: { id: ID }, query: { format: 'pdf' }, reveal: true },
      { title: 'With a warning accepted', body: { refNumber: '1001' }, confirm: ['allowDuplicateNumber'] },
    ]);
    // What is not a request is left out, and there are never more than ten.
    expect(r.data.examples).toHaveLength(10);
    expect(r.data.examples_mean).toBe(
      'Each example is a whole request: call run_operation with operation "bills.create" and its params, query, body, confirm and reveal as shown (dry_run true first). Put in your own ids, dates and amounts; send a confirm flag only after a warning named it.',
    );
    // Each one, sent as it is with the operation, is a request run_operation's own schema takes.
    const run = (OPERATION_TOOLS as Any[]).find((t) => t.name === 'run_operation')!;
    for (const ex of r.data.examples as Any[]) {
      const { title: _t, note: _n, ...request } = ex;
      expect(argumentProblem(run.inputSchema, { operation: 'bills.create', ...request, dry_run: true }), JSON.stringify(ex)).toBeNull();
    }
  });
});

describe('run_operation', () => {
  it('maps the tool\'s arguments to the contract and passes the operation\'s own input unchanged', async () => {
    const { client, acted } = fake({ act: (r) => ({ operation: r.operation, outcome: r.dryRun ? 'dry_run' : 'posted', result: { ok: true } }) });
    const input = { params: { id: ID }, query: { from: '2026-01-01', ids: [ID, ID2] }, body: { customerId: ID2, lines: [{ itemId: ID, qty: '2' }], snake_field: 'kept as is' } };
    await call(client, 'run_operation', { operation: 'estimates.update', ...input, request_id: 'est-1', reason: 'Fix the quantity.', confirm: ['allowDuplicateNumber'], reveal: true });
    expect(acted[0]).toEqual({
      verb: 'run_operation',
      operation: 'estimates.update',
      ...input,
      confirm: ['allowDuplicateNumber'],
      reveal: true,
      requestId: 'est-1',
      reason: 'Fix the quantity.',
    });
    // A dry run is never filed under the request id the real run will use.
    await call(client, 'run_operation', { operation: 'estimates.update', body: { a: 1 }, dry_run: true, request_id: 'est-1', reason: 'x' });
    expect(acted[1]).toEqual({ verb: 'run_operation', operation: 'estimates.update', body: { a: 1 }, dryRun: true });
    // Empty confirm, reveal false: left out.
    await call(client, 'run_operation', { operation: 'reports.std.get', confirm: [], reveal: false });
    expect(acted[2]).toEqual({ verb: 'run_operation', operation: 'reports.std.get' });
  });

  it('sends the version of the record the agent read (expected_updated_at), when given, as the contract names it', async () => {
    const VERSION = '2026-03-08T14:05:09.123Z';
    const { client, acted } = fake({ act: (r) => ({ operation: r.operation, outcome: r.dryRun ? 'dry_run' : 'done', result: { ok: true } }) });
    await call(client, 'run_operation', { operation: 'customers.update', params: { id: ID }, body: { phone: '555-0100' }, expected_updated_at: VERSION, request_id: 'c-1', reason: 'New phone.' });
    expect(acted[0]).toEqual({ verb: 'run_operation', operation: 'customers.update', params: { id: ID }, body: { phone: '555-0100' }, expectedUpdatedAt: VERSION, requestId: 'c-1', reason: 'New phone.' });
    // A dry run checks it too; left out, nothing is sent for it (it stays optional).
    await call(client, 'run_operation', { operation: 'customers.update', params: { id: ID }, body: {}, expected_updated_at: VERSION, dry_run: true });
    expect(acted[1]).toEqual({ verb: 'run_operation', operation: 'customers.update', params: { id: ID }, body: {}, expectedUpdatedAt: VERSION, dryRun: true });
    await call(client, 'run_operation', { operation: 'customers.update', params: { id: ID }, body: {}, request_id: 'c-2' });
    expect(acted[2]).not.toHaveProperty('expectedUpdatedAt');
    expect((OPERATION_TOOLS as Any[]).find((t) => t.name === 'run_operation')!.inputSchema.required).toEqual(['operation']);
    // Changed since: the route's "reload" becomes what an agent can do. Without a version sent, a 409 is passed on as it is.
    const changed = 'This record was changed by Dana Lee at 03/08/2026 2:06 PM. Reload to see the latest.';
    const conflict = fake({ act: () => new IronbooksError(changed, { status: 409, code: 'CONFLICT' }) });
    const r = await call(conflict.client, 'run_operation', { operation: 'customers.update', params: { id: ID }, body: {}, expected_updated_at: VERSION, request_id: 'c-3' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      `${changed} If it says the record was changed since you read it, nothing was changed: read the record again, make your change on what it says now, and send it with the updatedAt you read then (editedAt for an account or an item) as expected_updated_at and a NEW request_id.`,
    );
    expect((await call(conflict.client, 'run_operation', { operation: 'customers.update', params: { id: ID }, body: {}, request_id: 'c-4' })).text).toBe(changed);
  });

  it('answers each outcome with what to do next', async () => {
    const answers: Any[] = [
      { operation: 'estimates.create', outcome: 'asked', requestId: ID, status: 'pending', summary: 'Estimate for Acme', needs: { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'yes' } },
      { operation: 'bills.create', outcome: 'needs_confirmation', warnings: [{ flag: 'allowDuplicateNumber', message: 'Already entered.' }] },
      { operation: 'users.create', outcome: 'refused', note: 'Agents may never manage users.' },
    ];
    const { client } = fake({ act: (r) => (r.verb === 'describe_operation' ? { id: r.operation, confirmFlags: ['allowDuplicateNumber'] } : answers.shift()) });
    const asked = await call(client, 'run_operation', { operation: 'estimates.create', body: {}, request_id: 'e-1', reason: 'Quote.' });
    expect(asked.data).toMatchObject({ outcome: 'asked', request_id: ID, said: 'Not done yet. A person must approve it in Ironbooks first.' });
    expect(asked.data.next).toMatch(`wait_for_decision with request_id "${ID}"`);
    expect(asked.data.who_decides).toBe('A person who may do this themselves must approve it.');
    const warned = await call(client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-1' });
    expect(warned.data.warnings).toEqual([{ flag: 'allowDuplicateNumber', message: 'Already entered.', resend_with: 'confirm: ["allowDuplicateNumber"]' }]);
    const refused = await call(client, 'run_operation', { operation: 'users.create', body: {}, request_id: 'u-1' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: Agents may never manage users\. Nothing was done\. Do not send it again as it is\./);
  });

  it('a warning is offered for sending again only with a flag the operation lists (the door accepts no other)', async () => {
    const warnings = [
      { flag: 'allowDuplicateNumber', message: 'Already entered.' },
      { flag: 'allowNegativeStock', message: 'Not enough on hand.' },
    ];
    const described: string[] = [];
    const answer = { operation: 'bills.create', outcome: 'needs_confirmation', warnings, note: 'Nothing was done.' };
    const { client, acted } = fake({
      act: (r) => {
        if (r.verb !== 'describe_operation') return answer;
        described.push(r.operation);
        return { id: r.operation, describe: 'Enter a bill', class: 'enter', params: [], treatment: 'run', confirmFlags: ['allowDuplicateNumber'] };
      },
    });
    const r = await call(client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-1' });
    expect(r.data.warnings).toEqual([
      { flag: 'allowDuplicateNumber', message: 'Already entered.', resend_with: 'confirm: ["allowDuplicateNumber"]' },
      { flag: 'allowNegativeStock', message: 'Not enough on hand.', instead: expect.stringMatching(/cannot be accepted with a flag/) },
    ]);
    // Asked for once, then known while the same run of Ironbooks answers.
    await call(client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-2' });
    expect(described).toEqual(['bills.create']);
    expect(acted.filter((a) => a.verb === 'describe_operation')).toEqual([{ verb: 'describe_operation', operation: 'bills.create' }]);
    // Ironbooks restarted (an update may list other flags): the flags are asked for again, and the
    // new run's are the ones offered.
    const ironbooks: { run: string } = { run: 'run-1' };
    const updated = fake({
      act: (r) =>
        r.verb === 'describe_operation'
          ? { id: r.operation, describe: 'Enter a bill', class: 'enter', params: [], treatment: 'run', confirmFlags: ironbooks.run === 'run-2' ? ['allowNegativeStock'] : ['allowDuplicateNumber'] }
          : answer,
    });
    // The client's run, as mcp/client.mjs keeps it (the endpoint file's value of the run that answered).
    const restarting = Object.assign(updated.client, { run: ironbooks.run });
    const before = await call(restarting, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-6' });
    expect(before.data.warnings.map((w: Any) => [w.flag, 'resend_with' in w])).toEqual([['allowDuplicateNumber', true], ['allowNegativeStock', false]]);
    restarting.run = ironbooks.run = 'run-2';
    const after = await call(restarting, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-7' });
    expect(after.data.warnings.map((w: Any) => [w.flag, 'resend_with' in w])).toEqual([['allowDuplicateNumber', false], ['allowNegativeStock', true]]);
    expect(updated.acted.filter((a) => a.verb === 'describe_operation')).toHaveLength(2);
    // None of the warnings can be accepted: the next step says to change the request.
    const none = fake({ act: (r) => (r.verb === 'describe_operation' ? { id: r.operation, confirmFlags: [] } : { ...answer, warnings: [warnings[1]] }) });
    const n = await call(none.client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-3' });
    expect(n.data.warnings[0]).not.toHaveProperty('resend_with');
    expect(n.data.next).toMatch(/^No flag accepts these warnings\. Change the request/);
    // Read from describe_operation earlier: not asked for again.
    const known = fake({
      act: (r) =>
        r.verb === 'describe_operation'
          ? { id: 'bills.create', describe: 'Enter a bill', class: 'enter', params: [], treatment: 'run', confirmFlags: ['allowNegativeStock'] }
          : answer,
    });
    await call(known.client, 'describe_operation', { operation: 'bills.create' });
    const k = await call(known.client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-4' });
    expect(k.data.warnings.map((w: Any) => [w.flag, 'resend_with' in w])).toEqual([['allowDuplicateNumber', false], ['allowNegativeStock', true]]);
    expect(known.acted.filter((a) => a.verb === 'describe_operation')).toHaveLength(1);
    // When the flags cannot be learnt, the advice is what it was, and the door's own note still says whether it can be accepted.
    const blind = fake({ act: (r) => (r.verb === 'describe_operation' ? new IronbooksError('Ironbooks could not answer that.', { status: 500 }) : answer) });
    const b = await call(blind.client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-5' });
    expect(b.isError).toBe(false);
    expect(b.data.warnings[0].resend_with).toBe('confirm: ["allowDuplicateNumber"]');
    expect(b.data.note).toBe('Nothing was done.');
  });

  it('"slow down" is not a refusal of the work: nothing was done, wait the seconds given, then send it again as it was', async () => {
    const slow = { operation: 'bills.create', outcome: 'refused', note: 'This agent already has 4 requests under way. Wait about 5 seconds for one to finish, then send this again.', retryAfterSeconds: 5 };
    const r = await call(fake({ act: () => slow }).client, 'run_operation', { operation: 'bills.create', body: {}, request_id: 'b-1' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Not now: This agent already has 4 requests under way. Wait about 5 seconds for one to finish, then send this again. Nothing was done. Wait 5 seconds, then send it again as it was (with the same request_id, if it had one: it is never done twice).',
    );
    expect(r.text).not.toMatch(/Refused|Do not send it again/);
    // The same for ask_for_permission and save_file, and with no words from the door.
    const quiet = { outcome: 'refused', retryAfterSeconds: 1 };
    const a = await call(fake({ act: () => quiet }).client, 'ask_for_permission', { operation: 'x.y', reason: 'Because.', request_id: 'g-1' });
    expect(a.text).toBe('Not now: Ironbooks is busy with your other requests. Nothing was done. Wait 1 second, then send it again as it was (with the same request_id, if it had one: it is never done twice).');
    const s = await call(fake({ act: () => quiet }).client, 'save_file', { file_id: FILE, folder: 'C:\\Books', request_id: 's-1' });
    expect(s.text).toMatch(/^Not now: .* Wait 1 second, then send it again as it was/);
    // A refusal without a wait is still a refusal.
    const no = await call(fake({ act: () => ({ outcome: 'refused', note: 'Agents may never manage users.', retryAfterSeconds: 0 }) }).client, 'run_operation', { operation: 'users.create' });
    expect(no.text).toMatch(/^Refused: /);
    // Ironbooks' 429 (the route's answer to the same): the wait it gave, and the same advice, for every tool.
    const busy = new IronbooksError('This agent has sent more than 60 requests in the last minute.', { status: 429, code: 'RATE_LIMITED', retryAfter: 12 });
    for (const [tool, args] of [
      ['run_operation', { operation: 'x.y' }],
      ['find_operations', {}],
      ['list_accounts', {}],
    ] as const) {
      const t = await call(fake({ act: () => busy, get: () => busy }).client, tool, args);
      expect(t, tool).toMatchObject({
        isError: true,
        text: 'This agent has sent more than 60 requests in the last minute. Nothing was done. Wait 12 seconds, then send it again as it was (with the same request_id, if it had one: it is never done twice).',
      });
    }
  });

  it('a very long answer is cut, and says so', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, memo: 'x'.repeat(40) }));
    const { client } = fake({ act: () => ({ operation: 'x.list', outcome: 'read', result: { rows, total: rows.length } }) });
    const r = await call(client, 'run_operation', { operation: 'x.list' });
    expect(r.text.length).toBeLessThan(MAX_RESULT_CHARS + 5_000);
    expect(r.data.result.total).toBe(20_000);
    expect(r.data.result.rows.length).toBeLessThan(20_000);
    expect(r.data.result.rows[0]).toEqual({ id: 0, memo: 'x'.repeat(40) });
    expect(r.data.result_cut_short).toMatch(/Narrow the request/);
    expect(r.data.cut_short).toEqual({ result: r.data.result_cut_short });
    expect(r.data.cut_short.result).toMatch(/^The result was too long to show in full: its longest lists were cut\./);
    expect(cutToFit({ a: [1, 2] })).toBeNull();
    expect(cutToFit({ text: 'y'.repeat(300) }, 100)).toEqual({ value: null });
  });

  it('the whole answer is held to the limit: a long preview of the operation\'s own is cut too, never what to do next', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, memo: 'x'.repeat(40) }));
    const { client } = fake({
      act: () => ({ operation: 'x.batch', outcome: 'asked', requestId: ID, status: 'pending', preview: { routePreview: { rows }, effects: [{ summary: 'Emails 3 statements' }] } }),
    });
    const r = await call(client, 'run_operation', { operation: 'x.batch', request_id: 'b-1', reason: 'Month end.' });
    expect(r.text.length).toBeLessThan(MAX_RESULT_CHARS + 5_000);
    expect(r.data.route_preview.rows.length).toBeLessThan(20_000);
    expect(r.data.route_preview.rows[0]).toEqual(rows[0]);
    // The short list fits its share and is kept whole.
    expect(r.data).toMatchObject({ outcome: 'asked', request_id: ID, would_also: ['Emails 3 statements'] });
    expect(r.data.next).toMatch(/wait_for_decision/);
    // It says which part was cut, and how to see the rest.
    expect(Object.keys(r.data.cut_short)).toEqual(['route_preview']);
    expect(r.data.cut_short.route_preview).toMatch(/^The operation's own preview \(route_preview\) was too long to show in full: its longest lists were cut\. A person sees all of it on the approval card\. To see it all yourself, dry run a smaller request/);
    expect(r.data).not.toHaveProperty('result_cut_short');
    // One text too long to cut: that part is left out, and the answer says which.
    const huge = fake({ act: () => ({ operation: 'x.report', outcome: 'read', result: 'z'.repeat(MAX_RESULT_CHARS + 10), note: 'Kept.' }) });
    const left = await call(huge.client, 'run_operation', { operation: 'x.report' });
    expect(left.text.length).toBeLessThan(MAX_RESULT_CHARS);
    expect(left.data).toMatchObject({ outcome: 'read', note: 'Kept.', left_out: ['result'] });
    expect(left.data).not.toHaveProperty('result');
    expect(left.data.result_cut_short).toMatch(/^The result was too long to show at all, so it was left out\. Narrow the request/);
  });

  it('a long list of what it would also send is cut like the result: it says how many are shown of how many', async () => {
    const effects = Array.from({ length: 6_000 }, (_, i) => ({ kind: 'email', summary: `Email to customer${i}@example.com: Statement for March (1 attachment) ${'.'.repeat(30)}` }));
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, memo: 'x'.repeat(40) }));
    const { client } = fake({ act: () => ({ operation: 'statements.email', outcome: 'dry_run', preview: { routePreview: { rows }, effects }, result: { rows } }) });
    const r = await call(client, 'run_operation', { operation: 'statements.email', dry_run: true });
    expect(r.text.length).toBeLessThan(MAX_RESULT_CHARS + 5_000);
    expect(r.data.would_also.length).toBeLessThan(6_000);
    expect(r.data.would_also[0]).toBe(effects[0].summary);
    // A dry run waits for nobody: there is no approval card to point to.
    expect(r.data.cut_short.would_also).toBe(
      `The list of what it would also do outside the books (would_also) was too long to show in full: only the first ${r.data.would_also.length} of 6000 are shown. Nothing was sent. To see each one, dry run a smaller batch.`,
    );
    expect(r.data.cut_short.route_preview).toMatch(/Nothing was kept\. To see all of it, dry run a smaller request/);
    expect(JSON.stringify(r.data.cut_short)).not.toMatch(/approval card/);
    // Every long part was cut to a fair share; none took all the room.
    expect(Object.keys(r.data.cut_short).sort()).toEqual(['result', 'route_preview', 'would_also']);
    // (Halving a list can leave a part at half its share, a sixth of the room: never near nothing.)
    for (const part of ['result', 'route_preview', 'would_also']) expect(JSON.stringify(r.data[part]).length, part).toBeGreaterThan(MAX_RESULT_CHARS / 10);
    expect(r.data.outcome).toBe('dry_run');
    // An answer that fits is left as it is.
    expect(holdToLimit({ outcome: 'read', result: [1, 2, 3] })).toEqual({ outcome: 'read', result: [1, 2, 3] });
  });

  it('a change that was carried out is never cut with advice that would send it again', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, memo: 'x'.repeat(40) }));
    for (const outcome of ['posted', 'done']) {
      const { client } = fake({ act: () => ({ operation: 'bills.batch', outcome, result: { rows }, preview: { routePreview: { rows } } }) });
      const r = await call(client, 'run_operation', { operation: 'bills.batch', body: {}, request_id: `b-${outcome}` });
      expect(r.text.length, outcome).toBeLessThan(MAX_RESULT_CHARS + 5_000);
      for (const part of ['result', 'route_preview']) {
        expect(r.data.cut_short[part], `${outcome} ${part}`).toMatch(/It was carried out once, in full: do not send it again\. To see the rest, read what it made with a narrower read/);
        expect(r.data.cut_short[part], `${outcome} ${part}`).not.toMatch(/Narrow the request|dry run|approval card/);
      }
    }
    // Waiting for a person: the card shows the rest. Not carried out: a smaller request does.
    const card = holdToLimit({ outcome: 'asked', next: 'wait', route_preview: { rows } }, 50_000);
    expect((card.cut_short as Any).route_preview).toMatch(/A person sees all of it on the approval card/);
    const read = holdToLimit({ outcome: 'read', result: { rows } }, 50_000);
    expect((read.cut_short as Any).result).toMatch(/Narrow the request \(dates, a filter, a limit in the query\) to see everything\.$/);
    // A request read later: approved and done is carried out; one that failed was not, and sending it again shows nothing.
    const executed = shapeRequest({ ...REQUEST, result: { rows } }, { full: true }) as Any;
    expect(executed.cut_short.result).toMatch(/^The result was too long to show in full: its longest lists were cut\. It was carried out once, in full: do not send it again\./);
    const failed = shapeRequest({ ...REQUEST, status: 'failed', error: 'No.', result: { rows } }, { full: true }) as Any;
    expect(failed.cut_short.result).toMatch(/Do not send the request again to see the rest: read the error/);
    expect(failed.cut_short.result).not.toMatch(/carried out once/);
  });

  it('checks what it can before anything is sent', async () => {
    const { client, acted } = fake();
    for (const [args, message] of [
      [{ operation: 'x', params: { id: 5 } }, /"params"\.id must be text/],
      [{ operation: 'x', query: { a: { b: 1 } } }, /"query"\.a must be text, or a list of text/],
      [{ operation: 'x', confirm: ['allow duplicate'] }, /must be a flag a warning named/],
      [{ operation: 'x', reason: 'r'.repeat(501) }, /"reason" is too long/],
      [{ operation: 'x', request_id: 'a b' }, /"request_id" must be 3 to 120/],
      [{ operation: 'has space' }, /must be an operation id/],
      [{ operation: 'x', password: 'hunter2' }, /Unknown argument "password"/],
    ] as Array<[Any, RegExp]>) {
      const r = await call(client, 'run_operation', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.text).toMatch(message);
    }
    expect(acted).toEqual([]);
  });
});

describe('waiting for a decision', () => {
  const answering = (request: Any) => fake({ get: () => ({ request }) });

  it('asks for the agent\'s own request with the wait, on the long-wait connection', async () => {
    const { client, got } = answering({ ...REQUEST, status: 'pending', result: null, decidedAt: null, decidedByName: null });
    const r = await call(client, 'wait_for_decision', { request_id: ID });
    expect(got[0]).toEqual({ path: `/api/agent/requests/${ID}`, query: { wait: WAIT_MAX_SECONDS }, opts: { wait: true } });
    expect(r.data).toMatchObject({ request_id: ID, decision: 'pending', said: 'A person has not decided yet.', expires_at: REQUEST.expiresAt });
    expect(r.data.next).toMatch(/Call wait_for_decision again/);
    expect(r.data.next).toMatch(/Do not send the request again/);
    await call(client, 'wait_for_decision', { request_id: 'my-own-key-1', timeout_seconds: 0 });
    expect(got[1]).toEqual({ path: '/api/agent/requests/my-own-key-1', query: { wait: 0 }, opts: { wait: false } });
    for (const bad of [{ request_id: ID, timeout_seconds: 51 }, { request_id: '../x' }, { request_id: ID, timeout_seconds: -1 }, {}]) {
      expect((await call(client, 'wait_for_decision', bad)).isError, JSON.stringify(bad)).toBe(true);
    }
    expect(got).toHaveLength(2);
  });

  it('approved (with the result), denied (with the note), expired, failed, withdrawn: in plain words', async () => {
    const approved = await call(answering(REQUEST).client, 'wait_for_decision', { request_id: ID });
    expect(approved.data).toMatchObject({ decision: 'approved', status: 'executed', said: 'Approved by Dana Lee, and done.', result: { id: ID2, total: '500.00' }, decided_by: 'Dana Lee', your_reason: REQUEST.reason });
    expect(approved.data.next).toMatch(/Do not send it again/);

    const denied = await call(answering({ ...REQUEST, status: 'denied', result: null, note: 'Use the March price list.' }).client, 'wait_for_decision', { request_id: ID });
    expect(denied.data).toMatchObject({ decision: 'denied', said: 'Denied by Dana Lee. Nothing was done.', note_from_person: 'Use the March price list.' });
    expect(denied.data).not.toHaveProperty('result');
    expect(denied.data.next).toMatch(/Do not send it again/);

    const expired = await call(answering({ ...REQUEST, status: 'expired', result: null, decidedByName: null }).client, 'wait_for_decision', { request_id: ID });
    expect(expired.data).toMatchObject({ decision: 'expired', said: 'Nobody decided in time, so the request expired. Nothing was done.' });
    expect(expired.data.next).toMatch(/NEW request_id/);

    const failed = await call(answering({ ...REQUEST, status: 'failed', result: null, error: 'The customer is inactive.' }).client, 'wait_for_decision', { request_id: ID });
    expect(failed.data).toMatchObject({ decision: 'failed', said: 'Approved by Dana Lee, but Ironbooks could not carry it out.', error: 'The customer is inactive.' });

    const running = await call(answering({ ...REQUEST, status: 'approved', result: null }).client, 'wait_for_decision', { request_id: ID });
    expect(running.data).toMatchObject({ decision: 'approved', said: 'Approved by Dana Lee. Ironbooks is carrying it out.' });
    expect(running.data.next).toMatch(/again in a moment/);

    const grant = await call(
      answering({ ...REQUEST, kind: 'grant', status: 'approved', result: null, grantId: ID2, grantAsked: { constraints: { entityIds: [ID], maxAmount: '900.00' }, minutes: 60 } }).client,
      'wait_for_decision',
      { request_id: ID },
    );
    // What the agent asked for is labelled so: the person may have given less.
    expect(grant.data).toMatchObject({ kind: 'standing permission', decision: 'approved', standing_permission: ID2, limits_you_asked: { entity_ids: [ID], max_amount: '900.00' }, minutes_you_asked: 60 });
    expect(grant.data).not.toHaveProperty('limits');
    expect(grant.data).not.toHaveProperty('minutes');
    expect(grant.data.said).toBe('Approved by Dana Lee: you have standing permission for estimates.create.');
    expect(grant.data.next).toMatch(/run_operation with operation "estimates.create"/);
    expect(grant.data.next).toMatch(/get_my_permissions shows the limits you were given/);

    const file = await call(answering({ ...REQUEST, file: { fileId: FILE, name: 'Estimate.pdf', type: 'application/pdf', size: 900 } }).client, 'wait_for_decision', { request_id: ID });
    expect(file.data.file).toEqual({ file_id: FILE, name: 'Estimate.pdf', type: 'application/pdf', size: 900 });
    expect(file.data.next).toMatch(`get_file with file_id "${FILE}"`);
  });

  it('two people: after the first approves, it says a second must approve too, and is still pending', async () => {
    const first = { ...REQUEST, status: 'pending', result: null, decidedByName: 'Dana Lee', decidedAt: '2026-11-20T10:05:00.000Z' };
    const sent: Any[] = [];
    const r = await call(answering(first).client, 'wait_for_decision', { request_id: ID }, sent);
    expect(r.data).toMatchObject({
      decision: 'pending',
      said: 'One person approved it (Dana Lee); a second person must also approve it before anything is done.',
      first_approved_by: 'Dana Lee',
      first_approved_at: '2026-11-20T10:05:00.000Z',
    });
    expect(r.data.said).toMatch(/one person approved it/i);
    expect(r.data.said).toMatch(/a second person must also approve/);
    // Not shown as decided while a second person has still to approve.
    expect(r.data).not.toHaveProperty('decided_by');
    expect(r.data).not.toHaveProperty('decided_at');
    expect(r.data.next).toMatch(/Call wait_for_decision again/);
    expect(sent).toEqual([]);
    // The list says the same.
    const listed = await call(fake({ act: () => ({ requests: [first] }) }).client, 'list_my_requests');
    expect(listed.data.requests[0]).toMatchObject({ decision: 'pending', said: r.data.said, first_approved_by: 'Dana Lee' });
    expect(listed.data.requests[0]).not.toHaveProperty('decided_by');
    // Once both have: decided by the first, second approver named.
    const both = await call(answering({ ...REQUEST, secondApproverName: 'Sam Roe' }).client, 'wait_for_decision', { request_id: ID });
    expect(both.data).toMatchObject({ decision: 'approved', decided_by: 'Dana Lee', second_approver: 'Sam Roe' });
  });

  it('a stale request: the books changed, a person must decide again on the new preview, and it is not news yet', async () => {
    // Going stale sets every approval aside (lib/services/agentRequests.ts backToWaiting clears
    // decidedBy), so a stale request with no name on it waits for a person to decide again.
    const stale = { ...REQUEST, status: 'pending', result: null, decidedAt: null, decidedByName: null, stale: true };
    const sent: Any[] = [];
    const r = await call(answering(stale).client, 'wait_for_decision', { request_id: ID }, sent);
    expect(r.data).toMatchObject({ decision: 'pending', stale: true });
    expect(r.data.said).toBe('The books changed after a person was shown what this would do, so Ironbooks made a new preview. Nothing was done: a person must look at the new preview and decide again.');
    expect(r.data).not.toHaveProperty('first_approved_by');
    expect(r.data.next).toMatch(/Do not send the request again/);
    expect(sent).toEqual([]);
    // Not stale: no mark at all.
    expect(shapeRequest({ ...REQUEST, status: 'pending', stale: false, decidedByName: null })).not.toHaveProperty('stale');
  });

  it('a stale request one person approved again: the first of two approvals of the NEW preview, so a second person must also approve', async () => {
    // The stale mark stays on (it counts the rounds), and the name is set again only by a first of
    // two approvals of the new preview (agentRequests.ts approve, firstOfTwo).
    const stale = { ...REQUEST, status: 'pending', result: null, decidedByName: 'Dana Lee', decidedAt: '2026-11-20T10:09:00.000Z', stale: true };
    const sent: Any[] = [];
    const r = await call(answering(stale).client, 'wait_for_decision', { request_id: ID }, sent);
    expect(r.data).toMatchObject({ decision: 'pending', stale: true, first_approved_by: 'Dana Lee', first_approved_at: '2026-11-20T10:09:00.000Z' });
    expect(r.data.said).toBe(
      'The books changed after a person was shown what this would do, so Ironbooks made a new preview. One person approved the new preview (Dana Lee); a second person must also approve it before anything is done.',
    );
    expect(r.data.said).toMatch(/one person approved/i);
    expect(r.data.said).toMatch(/a second person must also approve/);
    // Not "decide again": the agent must not tell its person to approve once more.
    expect(r.data.said).not.toMatch(/decide again/);
    expect(r.data).not.toHaveProperty('decided_by');
    expect(r.data.next).toMatch(/Do not send the request again/);
    expect(sent).toEqual([]);
    // The list says the same.
    const listed = await call(fake({ act: () => ({ requests: [stale] }) }).client, 'list_my_requests');
    expect(listed.data.requests[0]).toMatchObject({ decision: 'pending', stale: true, said: r.data.said, first_approved_by: 'Dana Lee' });
  });

  it('the standing permission actually given is what the agent reads, not what it asked for', async () => {
    const asked = { constraints: { entityIds: [ID, ID2], maxAmount: '900.00' }, minutes: 240 };
    const given = { minutes: 60, constraints: { entityIds: [ID], maxAmount: '500.00', maxUses: 5 }, expiresAt: '2026-11-20T11:05:00.000Z' };
    const grantRequest = { ...REQUEST, kind: 'grant', status: 'executed', result: null, grantId: ID2, grantAsked: asked, grant: given };
    const r = await call(answering(grantRequest).client, 'wait_for_decision', { request_id: ID });
    expect(r.data).toMatchObject({
      kind: 'standing permission',
      decision: 'approved',
      standing_permission: ID2,
      limits_given: { entity_ids: [ID], max_amount: '500.00', max_uses: 5 },
      minutes_given: 60,
      standing_permission_ends_at: '2026-11-20T11:05:00.000Z',
    });
    expect(r.data.said).toBe('Approved by Dana Lee: you have standing permission for estimates.create until 2026-11-20T11:05:00.000Z, within the limits you were given (limits_given).');
    expect(r.data.next).toMatch(/go by limits_given, not by what you asked/);
    // What was asked is not shown once the given limits are known: the agent cannot take it for its own.
    expect(r.data).not.toHaveProperty('limits_you_asked');
    expect(r.data).not.toHaveProperty('minutes_you_asked');
    expect(r.text).not.toContain('900.00');
    expect(r.text).not.toContain(ID2 + '"]'); // the second customer asked for is not in the limits
    // The list shows the same.
    const listed = await call(fake({ act: () => ({ requests: [grantRequest] }) }).client, 'list_my_requests');
    expect(listed.data.requests[0]).toMatchObject({ limits_given: r.data.limits_given, minutes_given: 60 });
    expect(listed.data.requests[0]).not.toHaveProperty('limits_you_asked');
    // Given with no limits of its own: said so, not left out.
    const open = await call(answering({ ...grantRequest, grant: { ...given, constraints: {} } }).client, 'wait_for_decision', { request_id: ID });
    expect(open.data.limits_given).toMatch(/^none beyond the operation itself/);
    // While it waits, what was asked is shown, labelled as asked.
    const waiting = await call(answering({ ...grantRequest, status: 'pending', grantId: null, grant: null, decidedByName: null }).client, 'wait_for_decision', { request_id: ID });
    expect(waiting.data).toMatchObject({ limits_you_asked: { entity_ids: [ID, ID2], max_amount: '900.00' }, minutes_you_asked: 240 });
    expect(waiting.data).not.toHaveProperty('limits_given');
  });

  it('a request approved with "approve similar": the standing permission given with it, or why none was', async () => {
    const given = { minutes: 30, constraints: { maxAmount: '500.00' }, expiresAt: '2026-11-20T10:35:00.000Z' };
    const r = await call(answering({ ...REQUEST, grantId: ID2, grant: given }).client, 'wait_for_decision', { request_id: ID });
    expect(r.data.said).toBe('Approved by Dana Lee, and done. The person also gave you standing permission for more of the same until 2026-11-20T10:35:00.000Z, within limits_given.');
    expect(r.data).toMatchObject({ standing_permission: ID2, limits_given: { max_amount: '500.00' }, minutes_given: 30 });
    const refused = await call(answering({ ...REQUEST, grantError: 'Standing permission for this can last at most 30 minutes from now.' }).client, 'wait_for_decision', { request_id: ID });
    expect(refused.data.said).toMatch(/^Approved by Dana Lee, and done\. The person also wanted to give you standing permission for more of the same, but it was not given/);
    expect(refused.data.standing_permission_not_given).toBe('Standing permission for this can last at most 30 minutes from now.');
    expect(refused.data).not.toHaveProperty('standing_permission');
  });

  it('a run that posted to the books says so, with the entries it made', async () => {
    const r = await call(answering({ ...REQUEST, posted: true, entryIds: [ID2] }).client, 'wait_for_decision', { request_id: ID });
    expect(r.data).toMatchObject({ said: 'Approved by Dana Lee, and posted to the books.', entry_ids: [ID2] });
    // The list stays short: no entry ids.
    const listed = await call(fake({ act: () => ({ requests: [{ ...REQUEST, posted: true, entryIds: [ID2] }] }) }).client, 'list_my_requests');
    expect(listed.data.requests[0].said).toBe('Approved by Dana Lee, and posted to the books.');
    expect(listed.data.requests[0]).not.toHaveProperty('entry_ids');
  });

  it('a very long result of an approved run is cut, and says so', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, memo: 'x'.repeat(40) }));
    const r = await call(answering({ ...REQUEST, result: { rows } }).client, 'wait_for_decision', { request_id: ID });
    expect(r.text.length).toBeLessThan(MAX_RESULT_CHARS + 5_000);
    expect(r.data.result.rows.length).toBeLessThan(20_000);
    expect(r.data).toMatchObject({ decision: 'approved', said: 'Approved by Dana Lee, and done.' });
    // How to see the rest of a run that is done: never by sending it again.
    expect(r.data.cut_short.result).toBe(
      'The result was too long to show in full: its longest lists were cut. It was carried out once, in full: do not send it again. To see the rest, read what it made with a narrower read (find_operations finds one).',
    );
    expect(r.data.next).toMatch(/Do not send it again/);
  });

  it('when Ironbooks holds as many waits as it allows (429), the request is read now and the agent is told to check later', async () => {
    const pending = { ...REQUEST, status: 'pending', result: null, decidedAt: null, decidedByName: null };
    const asked: Any[] = [];
    const busy = fake({
      get: (_p, q) => {
        asked.push(q);
        return q.wait > 0 ? new IronbooksError('You are already waiting on 4 requests at once.', { status: 429, code: 'RATE_LIMITED', retryAfter: 5 }) : { request: pending };
      },
    });
    const sent: Any[] = [];
    const r = await call(busy.client, 'wait_for_decision', { request_id: ID }, sent);
    expect(r.isError, r.text).toBe(false);
    expect(asked).toEqual([{ wait: WAIT_MAX_SECONDS }, { wait: 0 }]);
    expect(busy.got[1].opts).toEqual({ wait: false });
    expect(r.data).toMatchObject({ request_id: ID, decision: 'pending', said: 'A person has not decided yet.', check_again_after_seconds: 5 });
    expect(r.data.next).toBe(
      'Ironbooks is already holding as many waits for you as it allows, so this one was read now, without waiting. Check this request later: call wait_for_decision for it again in 5 seconds or more, or carry on with other work first. Do not send the request again: it is already waiting.',
    );
    expect(sent).toEqual([]);
    // Decided meanwhile: the read now gives the decision, announced as usual.
    const decided = fake({ get: (_p, q) => (q.wait > 0 ? new IronbooksError('Busy.', { status: 429, code: 'RATE_LIMITED' }) : { request: REQUEST }) });
    const told: Any[] = [];
    const d = await call(decided.client, 'wait_for_decision', { request_id: ID }, told);
    expect(d.data).toMatchObject({ decision: 'approved', said: 'Approved by Dana Lee, and done.' });
    expect(d.data).not.toHaveProperty('check_again_after_seconds');
    expect(d.data.next).toBe('It is done. Do not send it again.');
    expect(told.map((m) => m.method)).toEqual(['notifications/message']);
    // A 429 on a read without waiting is passed on in Ironbooks' words (it never limits those), with
    // what every "slow down" means: nothing was done, wait, then ask again.
    const plain = await call(fake({ get: () => new IronbooksError('Busy.', { status: 429 }) }).client, 'wait_for_decision', { request_id: ID, timeout_seconds: 0 });
    expect(plain).toMatchObject({ isError: true, text: 'Busy. Nothing was done. Wait a little while, then send it again as it was (with the same request_id, if it had one: it is never done twice).' });
  });

  it('when this connector already holds its waits open, a third is read now, with advice to check it later', async () => {
    const pending = { ...REQUEST, status: 'pending', result: null, decidedAt: null, decidedByName: null };
    const busy = fake({ get: (_p, _q, o) => (o.wait ? new IronbooksError(WAITS_BUSY_MESSAGE, { code: WAITS_BUSY_CODE }) : { request: pending }) });
    const r = await call(busy.client, 'wait_for_decision', { request_id: ID });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.next).toBe(
      'You are already waiting on other requests here, so this one was read now, without waiting. Check this request later: call wait_for_decision for it again once one of your other waits has come back, or carry on with other work first. Do not send the request again: it is already waiting.',
    );
    expect(r.data).not.toHaveProperty('check_again_after_seconds');
  });

  it('tells the connector about requests that restart Ironbooks, so it is not started again while one may be under way', async () => {
    const noted: Any[] = [];
    const update = { ...REQUEST, operation: 'shell.update.install', class: 'settings', status: 'pending', result: null, decidedByName: null };
    const base = fake({
      act: (r) => (r.verb === 'run_operation' ? { operation: 'shell.update.install', outcome: 'asked', requestId: ID, status: 'pending' } : r.verb === 'list_my_requests' ? { requests: [update] } : { request: { ...update, status: 'cancelled' } }),
      get: () => ({ request: { ...update, status: 'executed' } }),
    });
    const client = { ...base.client, noteRequest: (r: Any) => noted.push({ id: r.id, operation: r.operation, status: r.status }) };
    await call(client, 'run_operation', { operation: 'shell.update.install', request_id: 'update-1', reason: 'The person asked for the update.' });
    await call(client, 'list_my_requests');
    await call(client, 'wait_for_decision', { request_id: ID });
    await call(client, 'cancel_request', { request_id: ID });
    expect(noted).toEqual([
      { id: ID, operation: 'shell.update.install', status: 'pending' },
      { id: ID, operation: 'shell.update.install', status: 'pending' },
      { id: ID, operation: 'shell.update.install', status: 'executed' },
      { id: ID, operation: 'shell.update.install', status: 'cancelled' },
    ]);
    // A client without the hook (the tests' stand-ins, older callers) is fine.
    expect((await call(base.client, 'wait_for_decision', { request_id: ID })).isError).toBe(false);
  });

  it('standing permission that is approved but not made yet is still going: it may yet fail', async () => {
    const claimed = { ...REQUEST, kind: 'grant', status: 'approved', result: null, grantId: null, grantAsked: { constraints: { maxUses: 3 }, minutes: 60 } };
    const sent: Any[] = [];
    const r = await call(answering(claimed).client, 'wait_for_decision', { request_id: ID }, sent);
    expect(r.data).toMatchObject({ decision: 'approved', said: 'Approved by Dana Lee. Ironbooks is setting up the standing permission.' });
    expect(r.data.next).toMatch(/again in a moment/);
    expect(r.data.said).not.toMatch(/you have standing permission/);
    expect(sent).toEqual([]);
    const failed = await call(answering({ ...claimed, status: 'failed', error: 'Standing permission for this can last at most 30 minutes.' }).client, 'wait_for_decision', { request_id: ID });
    expect(failed.data).toMatchObject({ decision: 'failed', error: 'Standing permission for this can last at most 30 minutes.' });
  });

  it('a decision is announced once: reading it again is not news', async () => {
    const sent: Any[] = [];
    const server = createIronbooksServer(fake({ get: () => ({ request: REQUEST }) }).client);
    server.connect((m: Any) => sent.push(m));
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: `ironbooks://requests/${ID}` } });
    for (const [id, timeout_seconds] of [[2, 50], [3, 0], [4, 0]] as const) {
      const res = (await server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'wait_for_decision', arguments: { request_id: ID, timeout_seconds } } })) as Any;
      expect(JSON.parse(res.result.content[0].text)).toMatchObject({ decision: 'approved' });
    }
    expect(sent.map((m) => m.method)).toEqual(['notifications/message', 'notifications/resources/updated']);
    // Another session (another client) hears about it for itself.
    const other: Any[] = [];
    await call(fake({ get: () => ({ request: REQUEST }) }).client, 'wait_for_decision', { request_id: ID }, other);
    expect(other.map((m) => m.method)).toEqual(['notifications/message']);
  });

  it('a request that is not the agent\'s (or not there) is said plainly', async () => {
    const none = await call(fake({ get: () => new IronbooksError('Not found', { status: 404 }) }).client, 'wait_for_decision', { request_id: ID });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/There is no request of yours with that id/);
    const empty = await call(fake({ get: () => ({}) }).client, 'wait_for_decision', { request_id: ID });
    expect(empty.text).toMatch(/list_my_requests/);
  });

  it('a decision also reaches the client as a notice, and as a change of the request\'s resource when it subscribed', async () => {
    const sent: Any[] = [];
    const server = createIronbooksServer(fake({ get: () => ({ request: { ...REQUEST, status: 'denied', result: null, note: 'No.' } }) }).client);
    server.connect((m: Any) => sent.push(m));
    expect(await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/subscribe', params: { uri: `ironbooks://requests/${ID}` } })).toMatchObject({ result: {} });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait_for_decision', arguments: { request_id: ID } } });
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'notice', logger: 'ironbooks', data: { message: 'Ironbooks: Estimate for Acme, $500.00: Denied by Dana Lee. Nothing was done.', request_id: ID, decision: 'denied' } },
      },
      { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: `ironbooks://requests/${ID}` } },
    ]);
  });

  it('nothing is announced while it is pending, or while the approved run is still going', async () => {
    for (const request of [{ ...REQUEST, status: 'pending', result: null }, { ...REQUEST, status: 'approved', result: null }]) {
      const sent: Any[] = [];
      await call(fake({ get: () => ({ request }) }).client, 'wait_for_decision', { request_id: ID }, sent);
      expect(sent, request.status).toEqual([]);
    }
  });

  it('the request is also a resource a client can read', async () => {
    const server = createIronbooksServer(fake({ get: (p) => (p.endsWith(ID) ? { request: REQUEST } : new IronbooksError('Not found', { status: 404 })) }).client);
    const read = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `ironbooks://requests/${ID}` } })) as Any;
    expect(read.result.contents[0]).toMatchObject({ uri: `ironbooks://requests/${ID}`, mimeType: 'application/json' });
    expect(JSON.parse(read.result.contents[0].text)).toMatchObject({ decision: 'approved', result: { id: ID2 } });
    expect(await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: `ironbooks://requests/${ID2}` } })).toMatchObject({ error: { code: -32002 } });
    expect(await server.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ironbooks://requests/../../x' } })).toMatchObject({ error: { code: -32002 } });
    const templates = ((await server.handle({ jsonrpc: '2.0', id: 4, method: 'resources/templates/list' })) as Any).result.resourceTemplates;
    expect(templates.map((t: Any) => t.uriTemplate)).toEqual(['ironbooks://requests/{request_id}', 'ironbooks://files/{file_id}']);
  });
});

describe('requests, permissions and asking ahead', () => {
  it('list_my_requests and its older name list_my_proposals send the same verb and give the same answer', async () => {
    const { client, acted } = fake({ act: () => ({ requests: [REQUEST, { ...REQUEST, id: ID2, status: 'pending', result: null, decidedAt: null, decidedByName: null }] }) });
    const a = await call(client, 'list_my_requests', { status: 'pending', limit: 5 });
    const b = await call(client, 'list_my_proposals', { status: 'pending', limit: 5 });
    expect(acted).toEqual([
      { verb: 'list_my_requests', status: 'pending', limit: 5 },
      { verb: 'list_my_requests', status: 'pending', limit: 5 },
    ]);
    expect(b.text).toBe(a.text);
    expect(a.data.count).toBe(2);
    expect(a.data.requests[0]).toMatchObject({ request_id: ID, decision: 'approved', summary: REQUEST.summary, decided_by: 'Dana Lee' });
    // The list stays short: no results, previews or inputs (wait_for_decision has them).
    expect(a.data.requests[0]).not.toHaveProperty('result');
    expect(JSON.stringify(a.data)).not.toContain('customerId');
    expect(a.data.requests[1]).toMatchObject({ request_id: ID2, decision: 'pending', expires_at: REQUEST.expiresAt });
    const byName = new Map((TOOLS as Any[]).map((t) => [t.name, t]));
    expect(byName.get('list_my_proposals')!.inputSchema).toEqual(byName.get('list_my_requests')!.inputSchema);
    expect((await call(client, 'list_my_requests', { status: 'maybe' })).isError).toBe(true);
  });

  it('cancel_request withdraws a waiting request, and says so when it was already decided', async () => {
    const answers = [{ request: { ...REQUEST, status: 'cancelled', result: null } }, { request: REQUEST }];
    const { client, acted } = fake({ act: () => answers.shift() });
    const ok = await call(client, 'cancel_request', { request_id: ID });
    expect(acted[0]).toEqual({ verb: 'cancel_request', requestId: ID });
    expect(ok.data).toMatchObject({ request_id: ID, decision: 'cancelled', said: 'The request was withdrawn. Nothing was done.' });
    const late = await call(client, 'cancel_request', { request_id: ID });
    expect(late.data.said).toMatch(/^It could not be withdrawn: it is already approved\./);
  });

  it('get_my_permissions shows the policy, the standing permissions and the folders, and says when nobody can answer', async () => {
    const permissions = {
      agent: { id: 'agent-1', name: 'Bookkeeping bot' },
      roles: ['Bookkeeper'],
      preset: 'trusted_bookkeeper',
      classes: Object.fromEntries(types.RISK_CLASSES.map((c) => [c, c === 'read' || c === 'enter' ? 'allow' : 'ask'])),
      areas: { payroll: { enter: 'ask' } },
      bulkCap: 200,
      twoPersonOver: '10000.00',
      requestExpiryDays: 7,
      folders: ['C:\\Users\\Pat\\Documents\\Ironbooks'],
      paused: false,
      grants: [{ id: ID2, agentId: 'agent-1', operation: 'bills.create', constraints: { entityIds: [ID], maxUses: 12 }, givenBy: 'u1', expiresAt: '2026-11-20T23:59:00.000Z', revokedAt: null, uses: 3 }],
      someoneSignedIn: false,
    };
    const { client, acted } = fake({ act: () => permissions });
    const r = await call(client, 'get_my_permissions');
    expect(acted[0]).toEqual({ verb: 'get_my_permissions' });
    expect(r.data).toMatchObject({
      agent: 'Bookkeeping bot',
      roles: ['Bookkeeper'],
      preset: 'trusted_bookkeeper',
      paused: false,
      someone_signed_in: false,
      classes: permissions.classes,
      by_area: { payroll: { enter: 'ask' } },
      most_records_per_request: 200,
      two_people_approve_above: '10000.00',
      requests_expire_after_days: 7,
      folders: permissions.folders,
      standing_permissions: [{ standing_permission: ID2, operation: 'bills.create', limits: { entity_ids: [ID], max_uses: 12 }, expires_at: '2026-11-20T23:59:00.000Z', uses: 3 }],
    });
    expect(r.data.settings_mean).toEqual({ allow: 'you may do it on your own', ask: 'a person must approve each request', never: 'not allowed for you' });
    expect(r.data.notes).toEqual(['Nobody is signed in right now: a request that needs a person waits until someone signs in.']);
    // No folders is said, not left out.
    const none = await call(fake({ act: () => ({ ...permissions, folders: [], grants: [], paused: true, someoneSignedIn: true }) }).client, 'get_my_permissions');
    expect(none.data.folders).toEqual([]);
    expect(none.data.standing_permissions).toEqual([]);
    expect(none.data.notes[0]).toMatch(/You are paused/);
  });

  it('ask_for_permission sends the operation, the limits in the contract\'s words, the minutes and the reason', async () => {
    const { client, acted } = fake({ act: () => ({ operation: 'bills.create', outcome: 'asked', requestId: ID, status: 'pending' }) });
    const r = await call(client, 'ask_for_permission', {
      operation: 'bills.create',
      constraints: { entity_ids: [ID, ID2], account_ids: [ID], max_amount: '900.00', date_from: '2026-11-01', date_to: '2026-11-30', max_uses: 12, max_count: 1 },
      minutes: 240,
      reason: 'Enter the 12 November bills from the vendors in the inbox.',
      request_id: 'grant-bills-1',
    });
    expect(acted[0]).toEqual({
      verb: 'ask_for_permission',
      operation: 'bills.create',
      constraints: { entityIds: [ID, ID2], accountIds: [ID], maxAmount: '900.00', dateFrom: '2026-11-01', dateTo: '2026-11-30', maxUses: 12, maxCount: 1 },
      minutes: 240,
      reason: 'Enter the 12 November bills from the vendors in the inbox.',
      requestId: 'grant-bills-1',
    });
    expect(r.data).toMatchObject({ outcome: 'asked', request_id: ID });
    expect(r.data.next).toMatch(/wait_for_decision/);
    for (const [args, message] of [
      [{ operation: 'bills.create', request_id: 'g-2' }, /"reason" is required/],
      [{ operation: 'bills.create', reason: 'x' }, /"request_id" is required/],
      [{ operation: 'bills.create', reason: 'x', request_id: 'g-3', minutes: 0 }, /"minutes" must be at least 1/],
      [{ operation: 'bills.create', reason: 'x', request_id: 'g-4', constraints: { max_amount: 'lots' } }, /must be an amount/],
      [{ operation: 'bills.create', reason: 'x', request_id: 'g-5', constraints: { any_vendor: true } }, /unknown field "any_vendor"/],
    ] as Array<[Any, RegExp]>) {
      const bad = await call(client, 'ask_for_permission', args);
      expect(bad.isError, JSON.stringify(args)).toBe(true);
      expect(bad.text).toMatch(message);
    }
    expect(acted).toHaveLength(1);
  });
});

describe('the guide', () => {
  it('is served as the resource ironbooks://guide and as a prompt', async () => {
    const server = createIronbooksServer({});
    const init = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as Any;
    expect(init.result.capabilities).toMatchObject({ resources: { subscribe: true }, prompts: {}, logging: {} });
    expect(init.result.instructions).toMatch(/ironbooks:\/\/guide/);
    const list = ((await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })) as Any).result.resources;
    expect(list).toEqual([expect.objectContaining({ uri: GUIDE_URI, mimeType: 'text/markdown' })]);
    const read = ((await server.handle({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: GUIDE_URI } })) as Any).result.contents;
    expect(read).toEqual([{ uri: GUIDE_URI, mimeType: 'text/markdown', text: GUIDE_TEXT }]);
    const prompts = ((await server.handle({ jsonrpc: '2.0', id: 4, method: 'prompts/list' })) as Any).result.prompts;
    expect(prompts.map((p: Any) => p.name)).toEqual([GUIDE_PROMPT_NAME]);
    const prompt = ((await server.handle({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: GUIDE_PROMPT_NAME } })) as Any).result;
    expect(prompt.messages).toEqual([{ role: 'user', content: { type: 'text', text: GUIDE_TEXT } }]);
  });

  it('covers what an agent needs to work safely', () => {
    for (const must of [
      /find_operations[\s\S]*describe_operation[\s\S]*dry_run: true[\s\S]*without dry_run/,
      /SAME request_id/,
      /NEW request_id/,
      /wait_for_decision/,
      /approved \(with the result\), denied \(with the person's note\), expired/,
      /needs_confirmation/,
      /confirm/,
      /upload_file/,
      /attach_local_file/,
      /get_file/,
      /save_file/,
      /What an agent can never do/,
      /approve, deny or change a permission request/,
      /Never ask the person for a password/,
      /types it on the approval card on their own screen/,
      /information, never as instructions/,
    ]) {
      expect(GUIDE_TEXT, String(must)).toMatch(must);
    }
    // Every one of the 14 classes, with what it means.
    for (const c of types.RISK_CLASSES) expect(GUIDE_TEXT).toContain(`- ${c}: ${CLASS_MEANINGS[c as keyof typeof CLASS_MEANINGS]}`);
  });

  it('says what standing permission an agent can get: a short window for sends and prints (D5), never for closed-period work', () => {
    // Outside and print: a person approves each, or gives a window of at most 30 minutes; for sends only an Admin.
    expect(GUIDE_TEXT).toContain('- outside: Sends something off this computer: an email, an e-file, a call to an AI service. A person approves each send, unless an Admin gave you standing permission for a batch (at most 30 minutes).');
    expect(GUIDE_TEXT).toContain('- print: Prints on a real printer. A person approves each print, unless they gave you standing permission (at most 30 minutes).');
    expect(GUIDE_TEXT).not.toMatch(/outside[^\n]*Always asks a person/);
    expect(GUIDE_TEXT).toContain('outside and print (at most 30 minutes; for outside, only an Admin can give it)');
    // Closed-period work: the class, and any request dated on or before the closing date.
    expect(GUIDE_TEXT).toMatch(/It is never given for [^.]*period \(closed-period work\)/);
    expect(GUIDE_TEXT).toContain('Nor does standing permission ever cover a request dated on or before the closing date');
    expect(GUIDE_TEXT).toMatch(/Go by what you were given, never by what you asked for/);
    // Host-only and file-Admin work is refused standing permission for everyone (lib/agent/operate.ts
    // HOST_ONLY_GRANT_NOTE, FILE_ADMIN_GRANT_NOTE), whatever its class: the guide says so, and the
    // registry has such operations among the classes that may otherwise get a window.
    expect(GUIDE_TEXT).toContain(
      "Whatever its class, work that can only be approved at the computer that holds the company file (a test email, a download or install, printing a file), or that only the company file's Admin may approve, never gets standing permission, not even from an Admin: send each such request with run_operation.",
    );
    const hostOnlyShort = registry
      .allOperations()
      .filter((o) => o.availability === 'agent' && o.hostOnly && types.GRANTABLE[o.class] === 'short')
      .map((o) => o.id);
    for (const id of ['email.test', 'shell.print.file']) expect(hostOnlyShort, id).toContain(id);
  });

  it('says what a stale request is, and that the person decides again', () => {
    expect(GUIDE_TEXT).toMatch(/A pending request can be marked stale: the books changed after a person was shown what it would do/);
    expect(GUIDE_TEXT).toMatch(/Nothing was done\. The person must look at the new preview and decide again; any approval given before counts for nothing\./);
    expect(GUIDE_TEXT).toMatch(/do not send the request again/);
    // Two people and a stale request: one approval of the new preview, and a second still to come.
    expect(GUIDE_TEXT).toMatch(/That holds for a stale request too: once one person approves the new preview, the answer still says stale, names that person \(first_approved_by\), and says a second person must also approve it\./);
    // And what a wait that cannot be held open means.
    expect(GUIDE_TEXT).toMatch(/says to check it later/);
  });

  it('says what to search for to find 1099s, pay stubs, the audit trail, the transaction log and why a number changed, and each is found', () => {
    expect(FIND_EXAMPLES.map((e) => e.work)).toEqual(['1099s', 'Pay stubs', 'The audit trail (who changed what, and when)', 'The transaction log', 'Why a number changed']);
    for (const e of FIND_EXAMPLES) {
      expect(GUIDE_TEXT).toContain(`- ${e.work}: find_operations with query "${e.query}". ${e.finds}`);
      const found = registry.findOperations({ query: e.query, limit: 30 }).map((o) => o.id);
      for (const id of e.operations) {
        // A real operation, found by the words the guide gives, and named in what the guide says.
        expect(registry.operationById(id), id).not.toBeNull();
        expect(found, `${e.query} finds ${id}`).toContain(id);
        expect(e.finds).toContain(`"${id}"`);
      }
    }
  });

  it('names the report and entry tools, each a real one, and says the tools that change the books take a reason', () => {
    const names = new Set((TOOLS as Any[]).map((t) => t.name));
    for (const n of [...NAMED_ENTRY_TOOLS, ...NAMED_FIX_TOOLS, ...NAMED_REPORT_TOOLS]) {
      expect(names.has(n), n).toBe(true);
      expect(GUIDE_TEXT).toContain(n);
    }
    for (const n of ['list_reports', 'run_report', 'report_drilldown', 'export_report', 'enter_estimate', 'convert_estimate', 'enter_purchase_order', 'receive_items', 'enter_credit_memo', 'enter_vendor_credit', 'enter_time', 'adjust_inventory', 'pay_sales_tax']) {
      expect(GUIDE_TEXT, n).toContain(n);
    }
    expect(GUIDE_TEXT).toContain('Every named tool that changes the books takes dry_run, request_id and a reason, like run_operation.');
    // What a missing reason does is said apart for the tools that go through the generic door (the
    // door refuses to ask without one) and the curated ones (they ask, and the card says so).
    expect(DOOR_ENTRY_TOOLS).toEqual((ENTRY_TOOLS as Any[]).map((t) => t.name));
    expect(GUIDE_TEXT).toContain(`Without one, a request from ${DOOR_ENTRY_TOOLS.join(', ')} (these go through the generic door, like run_operation and the report tools) is not put to a person at all: Ironbooks refuses it and says to send it again with a reason.`);
    expect(GUIDE_TEXT).not.toMatch(/without one it says that no reason was given/);
    // As the guide says: every named tool that changes something takes all three.
    const generic = new Set([...OPERATION_TOOLS, ...FILE_TOOLS].map((t: Any) => t.name));
    for (const t of (TOOLS as Any[]).filter((x) => x.changes === true && !generic.has(x.name))) {
      for (const k of ['dry_run', 'request_id', 'reason']) expect(t.inputSchema.properties, `${t.name} takes ${k}`).toHaveProperty(k);
    }
  });

  it('says what an answer that is out of date, and a "slow down" (429), mean and what to do', () => {
    expect(GUIDE_TEXT).toMatch(/stale: true on a request[^\n]*Nothing was done, and the person decides again\. Keep waiting; do not send the request again\./);
    expect(GUIDE_TEXT).toMatch(/A change refused because the record changed since you read it[^\n]*Read the record again[^\n]*send it with a NEW request_id\./);
    expect(GUIDE_TEXT).toMatch(/"Not now", or Ironbooks answering 429[^\n]*nothing was done\. Wait the number of seconds the answer gives, then send the same request again exactly as it was, with the same request_id/);
    // A warning that cannot be accepted with a flag, the role floor, plain email addresses and the reveal window.
    expect(GUIDE_TEXT).toMatch(/Only a warning that gives resend_with can be accepted/);
    expect(GUIDE_TEXT).toContain('- change or delete a role that any agent holds;');
    expect(GUIDE_TEXT).toMatch(/An email address you send is the plain address only/);
    expect(GUIDE_TEXT).toMatch(/for 15 minutes after it ran; after that it is masked for good/);
  });
});

describe('a package that is not installed', () => {
  it('is found missing at run time, so its cases are skipped instead of the whole file failing at import', () => {
    expect(loadOptional('ironbooks-no-such-package/dist/2020')).toBeNull();
    // ajv itself is found wherever electron-builder brought it; either way the describe below says what it does.
    expect(Ajv2020 === null || typeof Ajv2020 === 'function').toBe(true);
  });
});

describe.skipIf(!Ajv2020)(`every input schema is real JSON Schema, and says what the tool itself accepts${Ajv2020 ? '' : ` (${AJV_MISSING})`}`, () => {
  // Only built when ajv was found (the describe is skipped otherwise, and its body still runs to collect the cases).
  const ajv = Ajv2020 ? new Ajv2020({ strict: true, allErrors: true }) : (null as unknown as AjvLike);
  // The two words the tools add for their own messages.
  ajv?.addKeyword({ keyword: 'patternHint', schemaType: 'string' });
  ajv?.addKeyword({ keyword: 'anyOfHint', schemaType: 'string' });

  it('every tool\'s schema compiles under JSON Schema 2020-12, strictly', () => {
    for (const t of TOOLS as Any[]) {
      expect(() => ajv.compile(t.inputSchema), t.name).not.toThrow();
    }
  });

  it('the new tools: a JSON Schema validator and the tool\'s own check agree, argument by argument', () => {
    const cases: Record<string, { good: Any[]; bad: Any[] }> = {
      find_operations: { good: [{}, { query: 'email invoice', area: 'customers', class: 'outside', limit: 30 }], bad: [{ limit: 0 }, { class: 'x' }, { other: 1 }] },
      describe_operation: { good: [{ operation: 'invoices.email' }, { operation: 'shell.company.saveCopyAs' }, { operation: 'action:enter_bill' }], bad: [{}, { operation: 'a/b' }, { operation: 5 }] },
      run_operation: {
        good: [
          { operation: 'invoices.email', params: { id: ID }, query: { a: 'b', c: ['d'] }, body: { to: 'x' }, dry_run: true },
          { operation: 'x', body: [1, 2], request_id: 'r-1', reason: 'why', confirm: ['allowZero'], reveal: true },
          { operation: 'x', body: 'text' },
          { operation: 'x', params: { id: ID }, body: {}, expected_updated_at: '2026-03-08T14:05:09.123Z', request_id: 'r-1' },
        ],
        bad: [
          {},
          { operation: 'x', expected_updated_at: '2026-03-08' },
          { operation: 'x', expected_updated_at: `2026-03-08T14:05:09.123Z${'0'.repeat(20)}` },
          { operation: 'x', params: { id: 1 } },
          { operation: 'x', query: { a: 1 } },
          // More values for one query name than the door takes (lib/agent/operate.ts: at most 100).
          { operation: 'x', query: { a: Array.from({ length: 101 }, () => 'v') } },
          { operation: 'x', confirm: ['1x'] },
          { operation: 'x', dry_run: 'yes' },
          { operation: 'x', extra: 1 },
        ],
      },
      wait_for_decision: { good: [{ request_id: ID }, { request_id: 'mine-1', timeout_seconds: 0 }, { request_id: ID, timeout_seconds: 50 }], bad: [{}, { request_id: ID, timeout_seconds: 51 }, { request_id: 'a/b' }, { request_id: ID, timeout_seconds: 1.5 }] },
      list_my_requests: { good: [{}, { status: 'executed', limit: 200 }], bad: [{ status: 'done' }, { limit: 201 }] },
      list_my_proposals: { good: [{}, { status: 'pending' }], bad: [{ status: 'done' }] },
      cancel_request: { good: [{ request_id: ID }], bad: [{}, { request_id: '..' }] },
      get_my_permissions: { good: [{}], bad: [{ agent: 'other' }] },
      ask_for_permission: {
        good: [{ operation: 'bills.create', reason: 'r', request_id: 'g-1', minutes: 60, constraints: { entity_ids: [ID], max_amount: '10.00', date_from: '2026-01-01', max_uses: 3 } }],
        bad: [{ operation: 'bills.create', reason: 'r' }, { operation: 'b', reason: 'r', request_id: 'g-1', minutes: 1441 }, { operation: 'b', reason: 'r', request_id: 'g-1', constraints: { entity_ids: ['x'] } }],
      },
      upload_file: {
        good: [{ name: 'a.pdf', type: 'application/pdf', base64: 'YWJj' }],
        bad: [{ name: 'a/b.pdf', type: 'application/pdf', base64: 'x' }, { name: 'a.pdf', type: 'pdf', base64: 'x' }, { name: 'a.pdf', type: 'application/pdf' }, { name: 'a.pdf', type: `application/${'x'.repeat(200)}`, base64: 'x' }],
      },
      attach_local_file: { good: [{ path: 'C:\\Books\\a.pdf' }, { path: '/home/pat/a.pdf', name: 'a.pdf', type: 'application/pdf' }], bad: [{}, { path: 'x', name: '..\\a' }, { path: 5 }] },
      // No longer than the door takes a file id (64), a media type (200) or a folder (1000).
      get_file: { good: [{ file_id: FILE }, { file_id: 'a'.repeat(64) }], bad: [{}, { file_id: '../x' }, { file_id: 'short' }, { file_id: 'a'.repeat(65) }] },
      save_file: {
        good: [{ file_id: FILE, folder: 'C:\\Books', request_id: 's-1' }, { file_id: FILE, folder: '/x', name: 'b.pdf', request_id: 's-1', reason: 'r' }],
        bad: [{ file_id: FILE, folder: 'C:\\Books' }, { file_id: FILE, request_id: 's-1' }, { file_id: FILE, folder: `C:\\${'a'.repeat(1_000)}`, request_id: 's-1' }],
      },
    };
    const byName = new Map((TOOLS as Any[]).map((t) => [t.name, t]));
    expect(Object.keys(cases).sort()).toEqual([...OPERATION_TOOLS, ...FILE_TOOLS].map((t: Any) => t.name).sort());
    for (const [name, { good, bad }] of Object.entries(cases)) {
      const schema = byName.get(name)!.inputSchema;
      const validate = ajv.compile(schema);
      for (const args of good) {
        expect(validate(args), `${name} ${JSON.stringify(args)}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(argumentProblem(schema, args), `${name} ${JSON.stringify(args)}`).toBeNull();
      }
      for (const args of bad) {
        expect(validate(args), `${name} ${JSON.stringify(args)}`).toBe(false);
        expect(argumentProblem(schema, args), `${name} ${JSON.stringify(args)}`).not.toBeNull();
      }
    }
  });
});

// Needs no JSON Schema validator: it runs whether ajv is there or not.
describe('the new tools\' schemas and handlers agree', () => {
  it('every property the new tools declare is one their handler reads', async () => {
    // Fill every declared property with a valid value and check each one shows up in what is sent.
    const { client, acted } = fake({
      act: (r) => (r.verb === 'upload_file' ? { uploadId: 'u', received: 3, file: { fileId: FILE, name: 'a', type: 'text/plain', size: 3 } } : { outcome: 'asked', requestId: ID, request: REQUEST }),
    });
    const full: Record<string, [Any, string[]]> = {
      run_operation: [
        { operation: 'x', params: { id: ID }, query: { q: 'a' }, body: { b: 1 }, request_id: 'r-1', reason: 'why', confirm: ['allowZero'], reveal: true, expected_updated_at: '2026-03-08T14:05:09.123Z' },
        ['operation', 'params', 'query', 'body', 'requestId', 'reason', 'confirm', 'reveal', 'expectedUpdatedAt'],
      ],
      ask_for_permission: [{ operation: 'x', constraints: { max_uses: 1 }, minutes: 5, reason: 'why', request_id: 'g-1' }, ['operation', 'constraints', 'minutes', 'reason', 'requestId']],
      save_file: [{ file_id: FILE, folder: 'C:\\Books', name: 'b.pdf', request_id: 's-1', reason: 'why' }, ['fileId', 'folder', 'name', 'requestId', 'reason']],
      find_operations: [{ query: 'q', area: 'banking', class: 'read', limit: 3 }, ['query', 'area', 'class', 'limit']],
      upload_file: [{ name: 'a.txt', type: 'text/plain', base64: 'YWJj' }, ['name', 'type', 'chunkBase64', 'last']],
    };
    for (const [name, [args, sentKeys]] of Object.entries(full)) {
      acted.length = 0;
      const r = await call(client, name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(false);
      for (const k of sentKeys) expect(acted[0], `${name} sends ${k}`).toHaveProperty(k);
    }
  });
});

describe('createServer still serves the tools alone', () => {
  it('without resources or prompts, as the older tests build it', async () => {
    const s = createServer({ tools: TOOLS, client: {}, serverInfo: { name: 't', version: '0' } });
    expect(await s.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
  });
});
