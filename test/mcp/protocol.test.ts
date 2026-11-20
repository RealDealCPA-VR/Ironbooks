/**
 * The MCP server's protocol layer (mcp/protocol.mjs): JSON-RPC over stdio for a tools-only server.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSIONS, ToolError, argumentProblem, createServer, serve } from '../../mcp/protocol.mjs';
import { IronbooksError } from '../../mcp/client.mjs';
import { SERVER_INFO } from '../../mcp/ironbooks-mcp.mjs';
import { INSTRUCTIONS, TOOLS } from '../../mcp/tools.mjs';

type Msg = Record<string, any>;

const echoSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 10 },
    mode: { type: 'string', enum: ['a', 'b'] },
    n: { type: 'integer', minimum: 1, maximum: 5 },
    flag: { type: 'boolean' },
    day: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' },
  },
  required: ['text'],
  additionalProperties: false,
};

function server() {
  const seen: Msg[] = [];
  const tools = [
    { name: 'echo', title: 'Echo', description: 'Says it back.', inputSchema: echoSchema, handler: async (a: Msg, c: Msg) => (seen.push(a), { said: a.text, by: c.who }) },
    { name: 'plain', description: 'Text.', inputSchema: { type: 'object', properties: {} }, handler: async () => 'just text' },
    { name: 'refuses', description: 'x', inputSchema: { type: 'object', properties: {} }, handler: async () => { throw new ToolError('Give a date.'); } },
    { name: 'books_say_no', description: 'x', inputSchema: { type: 'object', properties: {} }, handler: async () => { throw new IronbooksError('You do not have permission to view Payroll.', { status: 403 }); } },
    { name: 'breaks', description: 'x', inputSchema: { type: 'object', properties: {} }, handler: async () => { throw new TypeError('secret internal detail at C:\\path'); } },
  ];
  return { seen, s: createServer({ tools, client: { who: 'client' }, serverInfo: { name: 't', version: '0' }, instructions: 'hi' }) };
}
const call = (id: number, name: string, args?: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }) } });

describe('initialize', () => {
  it('answers with the version the client asked for when it is one this server speaks', async () => {
    const { s } = server();
    for (const v of PROTOCOL_VERSIONS) {
      const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'c', version: '1' } } })) as Msg;
      expect(res).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 't', version: '0' }, instructions: 'hi' } });
    }
  });

  it('offers its newest version for one it does not know', async () => {
    const { s } = server();
    const res = (await s.handle({ jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as Msg;
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(res.id).toBe('x');
    const bare = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize' })) as Msg;
    expect(bare.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });
});

describe('requests and notifications', () => {
  it('answers ping, and says nothing to a notification', async () => {
    const { s } = server();
    expect(await s.handle({ jsonrpc: '2.0', id: 7, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeNull();
    expect(await s.handle({ jsonrpc: '2.0', method: 'something/unknown' })).toBeNull();
  });

  it('refuses a method it does not have and a message that is not a request', async () => {
    const { s } = server();
    expect(await s.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).toMatchObject({ id: 3, error: { code: -32601 } });
    expect(await s.handle({ id: 4, method: 'ping' })).toMatchObject({ id: 4, error: { code: -32600 } });
    expect(await s.handle({ jsonrpc: '2.0', id: 5 })).toMatchObject({ id: 5, error: { code: -32600 } });
    expect(await s.handle([1, 2])).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await s.handle('ping')).toMatchObject({ id: null, error: { code: -32600 } });
  });
});

describe('tools', () => {
  it('lists every tool with its schema, marked read-only', async () => {
    const { s } = server();
    const res = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as Msg;
    expect(res.result.tools.map((t: Msg) => t.name)).toEqual(['echo', 'plain', 'refuses', 'books_say_no', 'breaks']);
    expect(res.result.tools[0]).toEqual({
      name: 'echo',
      title: 'Echo',
      description: 'Says it back.',
      inputSchema: echoSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'Echo' },
    });
    expect(res.result.tools[1]).not.toHaveProperty('title');
    expect(JSON.stringify(res.result)).not.toContain('handler');
  });

  it('calls a tool and returns its result as text', async () => {
    const { s, seen } = server();
    const res = (await s.handle(call(1, 'echo', { text: 'hello', n: 2, flag: true, mode: 'a', day: '2026-01-31' }))) as Msg;
    expect(res.result.isError).toBe(false);
    expect(res.result.content).toEqual([{ type: 'text', text: JSON.stringify({ said: 'hello', by: 'client' }) }]);
    expect(seen).toEqual([{ text: 'hello', n: 2, flag: true, mode: 'a', day: '2026-01-31' }]);
    const plain = (await s.handle(call(2, 'plain'))) as Msg;
    expect(plain.result.content[0].text).toBe('just text');
  });

  it('says what is wrong with the arguments, without calling the tool', async () => {
    const { s, seen } = server();
    const cases: Array<[unknown, RegExp]> = [
      [{}, /"text" is required/],
      [{ text: '' }, /"text" is required/],
      [{ text: 5 }, /"text" must be text/],
      [{ text: 'x', extra: 1 }, /Unknown argument "extra"/],
      [{ text: 'x', mode: 'c' }, /"mode" must be one of: a, b/],
      [{ text: 'x', n: 1.5 }, /"n" must be a whole number/],
      [{ text: 'x', n: 0 }, /"n" must be at least 1/],
      [{ text: 'x', n: 6 }, /"n" must be at most 5/],
      [{ text: 'x', flag: 'yes' }, /"flag" must be true or false/],
      [{ text: 'x', day: '01/31/2026' }, /"day" must be a date as YYYY-MM-DD/],
      [{ text: 'x'.repeat(11) }, /"text" is too long/],
      [['x'], /must be an object/],
      ['x', /must be an object/],
    ];
    for (const [args, message] of cases) {
      const res = (await s.handle(call(1, 'echo', args))) as Msg;
      expect(res.result.isError, JSON.stringify(args)).toBe(true);
      expect(res.result.content[0].text).toMatch(message);
    }
    expect(seen).toEqual([]);
    expect(argumentProblem(echoSchema, { text: 'ok', n: null })).toBeNull();
  });

  it('an unknown tool is a protocol error', async () => {
    const { s } = server();
    expect(await s.handle(call(9, 'nope'))).toMatchObject({ id: 9, error: { code: -32602, message: 'Unknown tool: nope' } });
    expect(await s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} })).toMatchObject({ error: { code: -32602 } });
  });

  it('a failure is a readable message; nothing internal is passed on', async () => {
    const { s } = server();
    const refused = (await s.handle(call(1, 'refuses'))) as Msg;
    expect(refused.result).toEqual({ content: [{ type: 'text', text: 'Give a date.' }], isError: true });
    const denied = (await s.handle(call(2, 'books_say_no'))) as Msg;
    expect(denied.result).toEqual({ content: [{ type: 'text', text: 'You do not have permission to view Payroll.' }], isError: true });
    const broke = (await s.handle(call(3, 'breaks'))) as Msg;
    expect(broke.result.isError).toBe(true);
    expect(broke.result.content[0].text).toBe('Something went wrong reading from Ironbooks. Try again.');
    expect(JSON.stringify(broke)).not.toContain('secret internal detail');
  });
});

describe('over a stream', () => {
  async function converse(chunks: string[]): Promise<Msg[]> {
    const { s } = server();
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => (out += d.toString('utf8')));
    const done = serve(s, { input, output });
    for (const c of chunks) input.write(c);
    input.end();
    await done;
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('answers each line once, whatever way the bytes arrive', async () => {
    const a = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const b = JSON.stringify(call(2, 'echo', { text: 'hi' }));
    const n = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // split mid-message, two messages in one chunk, blank lines, Windows line ends, no final newline
    const out = await converse([a.slice(0, 10), `${a.slice(10)}\n${n}\n\r\n`, `${b}\r\n${a.replace('"id":1', '"id":3')}`]);
    expect(out.map((m) => m.id).sort()).toEqual([1, 2, 3]);
    expect(out.find((m) => m.id === 2)!.result.content[0].text).toBe(JSON.stringify({ said: 'hi', by: 'client' }));
  });

  it('a line that is not JSON gets a parse error, and the next line still works', async () => {
    const out = await converse(['{not json\n', `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })}\n`]);
    expect(out[0]).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(out.find((m) => m.id === 5)).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
  });

  it('writes one JSON object per line and nothing else', async () => {
    const out = await converse([`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`]);
    expect(out).toHaveLength(1);
    expect(out[0].jsonrpc).toBe('2.0');
  });
});

describe('the shipped server', () => {
  it('names itself and describes its tools for an agent', () => {
    expect(SERVER_INFO.name).toBe('ironbooks');
    expect(INSTRUCTIONS).toMatch(/get_company_info/);
    expect(INSTRUCTIONS).toMatch(/dry_run/);
    expect(INSTRUCTIONS).toMatch(/SAME request_id/);
    expect(INSTRUCTIONS).toMatch(/Nothing is ever deleted/);
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS as Array<Msg>) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
      expect(t.description.length, t.name).toBeGreaterThan(60);
      expect(t.inputSchema, t.name).toMatchObject({ type: 'object', additionalProperties: false });
      // A tool whose name says it changes something is marked as one, takes a dry run and a
      // request id; a tool that only looks takes neither. Nothing offers to delete.
      const changing = /^(enter|add|edit|void|deactivate|pay|write|make|transfer|receive|import|categorize|match|unmatch|exclude|start|mark|update|finish|cancel|undo)_/.test(t.name);
      expect(t.changes === true, t.name).toBe(changing);
      expect('dry_run' in t.inputSchema.properties, t.name).toBe(changing);
      expect('request_id' in t.inputSchema.properties, t.name).toBe(changing);
      expect(t.name).not.toMatch(/^(delete|remove|drop|purge)_/);
    }
  });

  it('marks the tools that change the books, and the ones that void', async () => {
    const s = createServer({ tools: TOOLS, client: {}, serverInfo: SERVER_INFO });
    const listed = ((await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as Msg).result.tools as Msg[];
    const hint = (name: string) => listed.find((t) => t.name === name)!.annotations;
    expect(hint('report_trial_balance')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hint('get_transaction')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hint('enter_invoice')).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(hint('void_transaction')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hint('deactivate_list_entry')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hint('import_statement_lines')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hint('undo_last_reconciliation')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hint('get_bank_feed')).toMatchObject({ readOnlyHint: true });
    expect(listed.filter((t) => !t.annotations.readOnlyHint).length).toBe(30);
  });
});
