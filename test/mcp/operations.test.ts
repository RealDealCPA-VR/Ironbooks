/**
 * The generic door (mcp/operations-tools.mjs): find, describe and run any operation, wait for a
 * person's decision, list and withdraw requests, read the agent's permissions, ask ahead for
 * standing permission; the guide (mcp/guide.mjs) as a resource and a prompt; and every tool's
 * input schema checked as real JSON Schema against what the tool itself accepts.
 *
 * The app is a recording stand-in, as in tools.test.ts: the verbs are still stubs on the server
 * side, so these tests hold the connector to the contract (lib/agent/contract.ts AgentVerbs).
 */
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { argumentProblem, createServer } from '../../mcp/protocol.mjs';
import { IronbooksError } from '../../mcp/client.mjs';
import { createIronbooksServer } from '../../mcp/ironbooks-mcp.mjs';
import { TOOLS } from '../../mcp/tools.mjs';
import { AREAS, MAX_RESULT_CHARS, OPERATION_TOOLS, REQUEST_STATUSES, RISK_CLASSES, WAIT_MAX_SECONDS, cutToFit } from '../../mcp/operations-tools.mjs';
import { FILE_TOOLS, STAGED_FILE_HOURS, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from '../../mcp/files-tools.mjs';
import {
  ADMIN_GIVES_STANDING,
  CLASS_MEANINGS,
  GUIDE_PROMPT_NAME,
  GUIDE_TEXT,
  GUIDE_URI,
  SHORT_GRANT_MINUTES,
  STANDING,
  STANDING_TEXT,
} from '../../mcp/guide.mjs';
import * as contract from '@/lib/agent/contract';
import * as policy from '@/lib/agent/policy';
import * as types from '@/lib/agent/operations/types';
import { AREA_KEYS } from '@/lib/permissions/model';

type Any = Record<string, any>;
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
      'Standing permission can be given for prepare, enter and change (until the end of the day at most); bulk (the same, and each request still within the most records one request may change); outside and print (at most 30 minutes; for outside, only an Admin can give it). It is never given for read_sensitive (protected data), remove (deleting), period (closed-period work), settings, admin (users and security), file (the company file) and secret (passwords and keys): each of those is asked one request at a time, so do not ask ahead for them.',
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

  it('answers each outcome with what to do next', async () => {
    const answers: Any[] = [
      { operation: 'estimates.create', outcome: 'asked', requestId: ID, status: 'pending', summary: 'Estimate for Acme', needs: { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'yes' } },
      { operation: 'bills.create', outcome: 'needs_confirmation', warnings: [{ flag: 'allowDuplicateNumber', message: 'Already entered.' }] },
      { operation: 'users.create', outcome: 'refused', note: 'Agents may never manage users.' },
    ];
    const { client } = fake({ act: () => answers.shift() });
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

  it('a very long answer is cut, and says so', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, memo: 'x'.repeat(40) }));
    const { client } = fake({ act: () => ({ operation: 'x.list', outcome: 'read', result: { rows, total: rows.length } }) });
    const r = await call(client, 'run_operation', { operation: 'x.list' });
    expect(r.text.length).toBeLessThan(MAX_RESULT_CHARS + 5_000);
    expect(r.data.result.total).toBe(20_000);
    expect(r.data.result.rows.length).toBeLessThan(20_000);
    expect(r.data.result.rows[0]).toEqual({ id: 0, memo: 'x'.repeat(40) });
    expect(r.data.result_cut_short).toMatch(/Narrow the request/);
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
    expect(r.data).toMatchObject({ outcome: 'asked', request_id: ID, would_also: ['Emails 3 statements'] });
    expect(r.data.next).toMatch(/wait_for_decision/);
    expect(r.data.result_cut_short).toMatch(/longest lists were cut/);
    // One text too long to cut: that part is left out, and the answer says which.
    const huge = fake({ act: () => ({ operation: 'x.report', outcome: 'read', result: 'z'.repeat(MAX_RESULT_CHARS + 10), note: 'Kept.' }) });
    const left = await call(huge.client, 'run_operation', { operation: 'x.report' });
    expect(left.text.length).toBeLessThan(MAX_RESULT_CHARS);
    expect(left.data).toMatchObject({ outcome: 'read', note: 'Kept.', left_out: ['result'] });
    expect(left.data).not.toHaveProperty('result');
    expect(left.data.result_cut_short).toMatch(/too long to show/);
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
      said: 'Approved by Dana Lee. A second person must also approve it before anything is done.',
      first_approved_by: 'Dana Lee',
      first_approved_at: '2026-11-20T10:05:00.000Z',
    });
    // Not shown as decided while a second person has still to approve.
    expect(r.data).not.toHaveProperty('decided_by');
    expect(r.data).not.toHaveProperty('decided_at');
    expect(r.data.next).toMatch(/Call wait_for_decision again/);
    expect(sent).toEqual([]);
    // Once both have: decided by the first, second approver named.
    const both = await call(answering({ ...REQUEST, secondApproverName: 'Sam Roe' }).client, 'wait_for_decision', { request_id: ID });
    expect(both.data).toMatchObject({ decision: 'approved', decided_by: 'Dana Lee', second_approver: 'Sam Roe' });
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
});

describe('every input schema is real JSON Schema, and says what the tool itself accepts', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  // The two words the tools add for their own messages.
  ajv.addKeyword({ keyword: 'patternHint', schemaType: 'string' });
  ajv.addKeyword({ keyword: 'anyOfHint', schemaType: 'string' });

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
        ],
        bad: [{}, { operation: 'x', params: { id: 1 } }, { operation: 'x', query: { a: 1 } }, { operation: 'x', confirm: ['1x'] }, { operation: 'x', dry_run: 'yes' }, { operation: 'x', extra: 1 }],
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
      upload_file: { good: [{ name: 'a.pdf', type: 'application/pdf', base64: 'YWJj' }], bad: [{ name: 'a/b.pdf', type: 'application/pdf', base64: 'x' }, { name: 'a.pdf', type: 'pdf', base64: 'x' }, { name: 'a.pdf', type: 'application/pdf' }] },
      attach_local_file: { good: [{ path: 'C:\\Books\\a.pdf' }, { path: '/home/pat/a.pdf', name: 'a.pdf', type: 'application/pdf' }], bad: [{}, { path: 'x', name: '..\\a' }, { path: 5 }] },
      get_file: { good: [{ file_id: FILE }], bad: [{}, { file_id: '../x' }, { file_id: 'short' }] },
      save_file: { good: [{ file_id: FILE, folder: 'C:\\Books', request_id: 's-1' }, { file_id: FILE, folder: '/x', name: 'b.pdf', request_id: 's-1', reason: 'r' }], bad: [{ file_id: FILE, folder: 'C:\\Books' }, { file_id: FILE, request_id: 's-1' }] },
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

  it('every property the new tools declare is one their handler reads', async () => {
    // Fill every declared property with a valid value and check each one shows up in what is sent.
    const { client, acted } = fake({
      act: (r) => (r.verb === 'upload_file' ? { uploadId: 'u', received: 3, file: { fileId: FILE, name: 'a', type: 'text/plain', size: 3 } } : { outcome: 'asked', requestId: ID, request: REQUEST }),
    });
    const full: Record<string, [Any, string[]]> = {
      run_operation: [{ operation: 'x', params: { id: ID }, query: { q: 'a' }, body: { b: 1 }, request_id: 'r-1', reason: 'why', confirm: ['allowZero'], reveal: true }, ['operation', 'params', 'query', 'body', 'requestId', 'reason', 'confirm', 'reveal']],
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
