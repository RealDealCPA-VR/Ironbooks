/**
 * The Model Context Protocol over stdio, as much of it as a tools-only server needs:
 * `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
 *
 * Messages are JSON-RPC 2.0, one per line, on stdin and stdout. Nothing else is ever written to
 * stdout (a stray line would break the client); diagnostics go to stderr. There are no
 * dependencies: this file and its neighbours are everything the connector runs.
 */

/** Protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;

/**
 * @typedef {{ name: string, title?: string, description: string, inputSchema: object,
 *   handler: (args: Record<string, any>, client: any) => Promise<unknown> }} Tool
 */

/** A tool failure the agent should read as a plain message (not a protocol error). */
export class ToolError extends Error {}

/** @param {unknown} v */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check tool arguments against the tool's input schema: the small subset of JSON Schema the tools
 * use (object with typed properties, `required`, `enum`, no unknown properties). Returns the
 * first problem in plain words, or null.
 * @param {any} schema
 * @param {unknown} args
 * @returns {string | null}
 */
export function argumentProblem(schema, args) {
  if (!isObject(args)) return 'The arguments must be an object.';
  const props = schema.properties ?? {};
  for (const key of Object.keys(/** @type {object} */ (args))) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) return `Unknown argument "${key}".`;
  }
  for (const key of schema.required ?? []) {
    const v = /** @type {Record<string, unknown>} */ (args)[key];
    if (v === undefined || v === null || v === '') return `"${key}" is required.`;
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = /** @type {Record<string, unknown>} */ (args)[key];
    if (v === undefined || v === null) continue;
    const s = /** @type {any} */ (spec);
    if (s.type === 'string') {
      if (typeof v !== 'string') return `"${key}" must be text.`;
      if (s.enum && !s.enum.includes(v)) return `"${key}" must be one of: ${s.enum.join(', ')}.`;
      if (s.pattern && !new RegExp(s.pattern).test(v)) return `"${key}" ${s.patternHint ?? 'is not in the expected form'}.`;
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) return `"${key}" is too long.`;
    } else if (s.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) return `"${key}" must be a whole number.`;
      if (typeof s.minimum === 'number' && v < s.minimum) return `"${key}" must be at least ${s.minimum}.`;
      if (typeof s.maximum === 'number' && v > s.maximum) return `"${key}" must be at most ${s.maximum}.`;
    } else if (s.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${key}" must be true or false.`;
    }
  }
  return null;
}

/**
 * Build the message handler of a tools-only MCP server.
 * @param {{ tools: Tool[], client: any, serverInfo: { name: string, version: string }, instructions?: string }} opts
 */
export function createServer(opts) {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));

  /** @param {unknown} id @param {unknown} result */
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  /** @param {unknown} id @param {number} code @param {string} message */
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  /**
   * Handle one parsed message. Returns the response, or null for a notification.
   * @param {any} msg
   */
  async function handle(msg) {
    if (!isObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return fail(isObject(msg) && 'id' in msg ? msg.id : null, ERR_INVALID_REQUEST, 'Invalid request');
    }
    const isNotification = !('id' in msg);
    const { id, method } = msg;
    const params = isObject(msg.params) ? msg.params : {};

    if (method === 'initialize') {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: opts.serverInfo,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
    }
    if (isNotification) return null; // notifications/initialized, cancelled, …
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') {
      return ok(id, {
        tools: opts.tools.map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...(t.title ? { title: t.title } : {}) },
        })),
      });
    }
    if (method === 'tools/call') {
      const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
      if (!tool) return fail(id, ERR_INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
      /** @param {string} text @param {boolean} isError */
      const text = (text, isError) => ok(id, { content: [{ type: 'text', text }], isError });
      const problem = argumentProblem(tool.inputSchema, args);
      if (problem) return text(problem, true);
      try {
        const result = await tool.handler(/** @type {Record<string, any>} */ (args), opts.client);
        return text(typeof result === 'string' ? result : JSON.stringify(result), false);
      } catch (err) {
        // The agent reads the reason and decides what to do next; nothing internal is passed on.
        const known = err instanceof ToolError || (err instanceof Error && /** @type {any} */ (err).isIronbooksError === true);
        if (!known) process.stderr.write(`[ironbooks-mcp] ${tool.name} failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
        return text(known ? /** @type {Error} */ (err).message : 'Something went wrong reading from Ironbooks. Try again.', true);
      }
    }
    return fail(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  return { handle };
}

/**
 * Serve messages from a readable stream of newline-delimited JSON, writing responses to a
 * writable stream. Resolves when the input ends.
 * @param {{ handle: (msg: any) => Promise<object | null> }} server
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} io
 */
export function serve(server, io) {
  /** @param {object} response */
  const send = (response) => {
    io.output.write(`${JSON.stringify(response)}\n`);
  };
  let buffer = '';
  /** Requests still being answered: the process must not exit before they are. */
  let pending = Promise.resolve();
  /** @param {string} line */
  const onLine = (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'Parse error' } });
      return;
    }
    const work = server
      .handle(msg)
      .then((response) => {
        if (response) send(response);
      })
      .catch((err) => {
        process.stderr.write(`[ironbooks-mcp] ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
      });
    pending = pending.then(() => work);
  };
  return new Promise((resolve) => {
    io.input.setEncoding('utf8');
    io.input.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    io.input.on('end', () => {
      if (buffer.trim()) onLine(buffer);
      pending.then(() => resolve(undefined));
    });
  });
}
