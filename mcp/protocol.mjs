/**
 * The Model Context Protocol over stdio, as much of it as this server needs:
 * `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, and, when the
 * server is given them, `resources/*` (with subscriptions), `prompts/*` and `logging/setLevel`.
 * The server can also send a notification of its own (a request decided, a resource changed).
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
export const ERR_INTERNAL = -32603;
/** MCP's code for a resource that does not exist. */
export const ERR_RESOURCE_NOT_FOUND = -32002;

/** Log levels of `notifications/message`, least serious first (RFC 5424, as MCP uses them). */
export const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

/**
 * @typedef {{ notify: (method: string, params: object) => void, log: (level: string, data: unknown) => void,
 *   subscribed: (uri: string) => boolean }} Session
 *
 * What a tool may do besides answering: send a notification, send a log message (only at or above
 * the level the client asked for), and see whether the client subscribed to a resource.
 *
 * @typedef {{ name: string, title?: string, description: string, inputSchema: object,
 *   changes?: boolean, destructive?: boolean,
 *   handler: (args: Record<string, any>, client: any, session: Session) => Promise<unknown>,
 *   refused?: (args: unknown, problem: string) => void }} Tool
 *
 * `changes`: the tool can change the books or the disk (every such change can be repeated safely
 * with its request id). `destructive`: it voids, makes something inactive, or may remove something.
 * `refused`: told when the arguments were refused by the input schema, before the handler runs, so
 * a tool that logs every refusal (attach_local_file) logs those too.
 *
 * @typedef {{ list: () => object[], templates?: () => object[],
 *   read: (uri: string, client: any) => Promise<object[] | null> }} Resources
 *
 * `read` answers the `contents` of one resource, or null when there is no such resource.
 *
 * @typedef {{ list: () => object[], get: (name: string, args: Record<string, string>) => object | null }} Prompts
 */

/** A tool failure the agent should read as a plain message (not a protocol error). */
export class ToolError extends Error {}

/**
 * A tool answer that is not one text block: an image, a file as an embedded resource, or several
 * blocks. A handler returns `new ToolContent([...])` and the blocks go to the client as they are.
 */
export class ToolContent {
  /** @param {object[]} content */
  constructor(content) {
    this.content = content;
  }
}

/** @param {unknown} v */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Check one value against the small subset of JSON Schema the tools use: strings (enum, pattern,
 * minLength, maxLength), integers and numbers (minimum, maximum), booleans, arrays (items, minItems,
 * maxItems), objects (properties, required, maxProperties, no unknown properties unless the
 * schema allows them, or checks them against its `additionalProperties` schema) and `anyOf`.
 * A schema without a type takes any value. Returns the first problem in plain words, or null.
 * @param {any} s  the schema
 * @param {unknown} v  the value
 * @param {string} name  how to call the value in a message
 * @param {boolean} [optional]  the value is an optional field, which the caller may leave out
 * @returns {string | null}
 */
function valueProblem(s, v, name, optional = false) {
  if (Array.isArray(s.anyOf)) {
    const problems = s.anyOf.map((/** @type {any} */ branch) => valueProblem(branch, v, name, optional));
    if (problems.some((p) => p === null)) return null;
    return s.anyOfHint ? `${name} ${s.anyOfHint}.` : problems[0];
  }
  if (s.type === 'string') {
    if (typeof v !== 'string') return `${name} must be text.`;
    if (s.enum && !s.enum.includes(v)) return `${name} must be one of: ${s.enum.join(', ')}.`;
    if (s.pattern && !new RegExp(s.pattern).test(v)) return `${name} ${s.patternHint ?? 'is not in the expected form'}.`;
    // Lengths as the app's own checks count them (JavaScript string length), so a value this lets
    // through is never refused by Ironbooks for its length.
    // Only an optional field can be left out; a required one, or an entry of a list, needs a value.
    if (typeof s.minLength === 'number' && v.length < s.minLength) {
      if (s.minLength !== 1) return `${name} must be at least ${s.minLength} characters.`;
      return optional ? `${name} cannot be empty: give a value, or leave it out.` : `${name} cannot be empty: give a value.`;
    }
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) return `${name} is too long.`;
    return null;
  }
  if (s.type === 'integer' || s.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) {
      return `${name} must be a ${s.type === 'integer' ? 'whole number' : 'number'}.`;
    }
    if (typeof s.minimum === 'number' && v < s.minimum) return `${name} must be at least ${s.minimum}.`;
    if (typeof s.maximum === 'number' && v > s.maximum) return `${name} must be at most ${s.maximum}.`;
    return null;
  }
  if (s.type === 'boolean') return typeof v === 'boolean' ? null : `${name} must be true or false.`;
  if (s.type === 'array') {
    if (!Array.isArray(v)) return `${name} must be a list.`;
    if (typeof s.minItems === 'number' && v.length < s.minItems) return `${name} needs at least ${s.minItems} ${s.minItems === 1 ? 'entry' : 'entries'}.`;
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) return `${name} can have at most ${s.maxItems} entries.`;
    if (s.items) {
      for (let i = 0; i < v.length; i++) {
        const p = valueProblem(s.items, v[i], `${name}[${i + 1}]`);
        if (p) return p;
      }
    }
    return null;
  }
  if (s.type === 'object') return objectProblem(s, v, name);
  return null;
}

/**
 * @param {any} schema
 * @param {unknown} value
 * @param {string} [name]  empty for the arguments themselves
 * @returns {string | null}
 */
function objectProblem(schema, value, name = '') {
  if (!isObject(value)) return name ? `${name} must be an object.` : 'The arguments must be an object.';
  const obj = /** @type {Record<string, unknown>} */ (value);
  const props = schema.properties ?? {};
  const label = (/** @type {string} */ key) => (name ? `${name}.${key}` : `"${key}"`);
  if (typeof schema.maxProperties === 'number' && Object.keys(obj).length > schema.maxProperties) {
    return `${name || 'The arguments'} can have at most ${schema.maxProperties} fields.`;
  }
  const extra = schema.additionalProperties;
  if (extra !== true) {
    for (const key of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) continue;
      if (!isObject(extra)) return name ? `${name} has an unknown field "${key}".` : `Unknown argument "${key}".`;
      // A map (path parameters, query values): every value meets the one schema.
      const p = obj[key] === undefined || obj[key] === null ? null : valueProblem(extra, obj[key], label(key));
      if (p) return p;
    }
  }
  for (const key of schema.required ?? []) {
    const v = obj[key];
    if (v === undefined || v === null || v === '') return `${label(key)} is required.`;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, spec] of Object.entries(props)) {
    const v = obj[key];
    if (v === undefined || v === null) continue;
    const p = valueProblem(spec, v, label(key), !required.has(key));
    if (p) return p;
  }
  return null;
}

/**
 * Check tool arguments against the tool's input schema. Returns the first problem in plain words,
 * or null. Ironbooks checks everything again itself; this only gives the agent an answer sooner.
 * @param {any} schema
 * @param {unknown} args
 * @returns {string | null}
 */
export function argumentProblem(schema, args) {
  return objectProblem(schema, args);
}

/** A failure whose message is plain words for the agent (ToolError, or an IronbooksError from the client). */
function isKnownError(/** @type {unknown} */ err) {
  return err instanceof ToolError || (err instanceof Error && /** @type {any} */ (err).isIronbooksError === true);
}

/**
 * What the agent is told after Ironbooks said "slow down" (429, with how long to wait in seconds;
 * 0 when it gave no time). Ironbooks refuses such a request before doing any of it, so sending it
 * again later, the same way, is safe: a request_id never does it twice.
 * @param {number} seconds
 */
export function slowDownAdvice(seconds) {
  const wait = seconds > 0 ? `${seconds} second${seconds === 1 ? '' : 's'}` : 'a little while';
  return `Nothing was done. Wait ${wait}, then send it again as it was (with the same request_id, if it had one: it is never done twice).`;
}

/** The message of a known failure, with what to do after a "slow down". */
function knownMessage(/** @type {Error} */ err) {
  const e = /** @type {any} */ (err);
  if (e.status !== 429) return err.message;
  const said = err.message.trim();
  return `${said}${/[.!?]$/.test(said) ? '' : '.'} ${slowDownAdvice(Number(e.retryAfter) || 0)}`;
}

/**
 * Build the message handler of an MCP server: tools always; resources and prompts when given.
 * `connect(send)` hands it the way to send a message of its own (serve does that); until then a
 * notification goes nowhere.
 * @param {{ tools: Tool[], client: any, serverInfo: { name: string, version: string }, instructions?: string,
 *   resources?: Resources, prompts?: Prompts }} opts
 */
export function createServer(opts) {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  /** @type {((message: object) => void) | null} */
  let sendOut = null;
  /** Resources the client asked to hear about. */
  const subscriptions = new Set();
  /** The least serious log level the client wants (it may raise it with logging/setLevel). */
  let logLevel = 'info';

  /** @type {Session} */
  const session = {
    notify(method, params) {
      if (sendOut) sendOut({ jsonrpc: '2.0', method, params });
    },
    log(level, data) {
      if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(logLevel)) return;
      session.notify('notifications/message', { level, logger: opts.serverInfo.name, data });
    },
    subscribed(uri) {
      return subscriptions.has(uri);
    },
  };

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
        capabilities: {
          tools: { listChanged: false },
          ...(opts.resources ? { resources: { subscribe: true, listChanged: false } } : {}),
          ...(opts.prompts ? { prompts: { listChanged: false } } : {}),
          logging: {},
        },
        serverInfo: opts.serverInfo,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
    }
    if (isNotification) return null; // notifications/initialized, cancelled, …
    if (method === 'ping') return ok(id, {});
    if (method === 'logging/setLevel') {
      if (typeof params.level !== 'string' || !LOG_LEVELS.includes(params.level)) return fail(id, ERR_INVALID_PARAMS, `level must be one of: ${LOG_LEVELS.join(', ')}`);
      logLevel = params.level;
      return ok(id, {});
    }
    if (opts.resources) {
      const resources = opts.resources;
      if (method === 'resources/list') return ok(id, { resources: resources.list() });
      if (method === 'resources/templates/list') return ok(id, { resourceTemplates: resources.templates ? resources.templates() : [] });
      if (method === 'resources/read' || method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        if (!uri) return fail(id, ERR_INVALID_PARAMS, 'uri is required');
        if (method === 'resources/subscribe') {
          subscriptions.add(uri);
          return ok(id, {});
        }
        if (method === 'resources/unsubscribe') {
          subscriptions.delete(uri);
          return ok(id, {});
        }
        try {
          const contents = await resources.read(uri, opts.client);
          if (!contents) return fail(id, ERR_RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
          return ok(id, { contents });
        } catch (err) {
          if (!isKnownError(err)) process.stderr.write(`[ironbooks-mcp] reading ${uri} failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
          return fail(id, ERR_INTERNAL, isKnownError(err) ? knownMessage(/** @type {Error} */ (err)) : 'Something went wrong reading from Ironbooks. Try again.');
        }
      }
    }
    if (opts.prompts) {
      if (method === 'prompts/list') return ok(id, { prompts: opts.prompts.list() });
      if (method === 'prompts/get') {
        const args = isObject(params.arguments) ? /** @type {Record<string, string>} */ (params.arguments) : {};
        const prompt = typeof params.name === 'string' ? opts.prompts.get(params.name, args) : null;
        if (!prompt) return fail(id, ERR_INVALID_PARAMS, `Unknown prompt: ${String(params.name)}`);
        return ok(id, prompt);
      }
    }
    if (method === 'tools/list') {
      return ok(id, {
        tools: opts.tools.map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.changes !== true, destructiveHint: t.destructive === true, idempotentHint: true, openWorldHint: false, ...(t.title ? { title: t.title } : {}) },
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
      if (problem) {
        try {
          tool.refused?.(args, problem);
        } catch {
          // A log that cannot be written changes nothing about the answer.
        }
        return text(problem, true);
      }
      try {
        const result = await tool.handler(/** @type {Record<string, any>} */ (args), opts.client, session);
        if (result instanceof ToolContent) return ok(id, { content: result.content, isError: false });
        return text(typeof result === 'string' ? result : JSON.stringify(result), false);
      } catch (err) {
        // The agent reads the reason and decides what to do next; nothing internal is passed on.
        const known = isKnownError(err);
        if (!known) process.stderr.write(`[ironbooks-mcp] ${tool.name} failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
        return text(known ? knownMessage(/** @type {Error} */ (err)) : 'Something went wrong reading from Ironbooks. Try again.', true);
      }
    }
    return fail(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  /** @param {(message: object) => void} send */
  function connect(send) {
    sendOut = send;
  }

  return { handle, connect, session };
}

/**
 * The longest message read, in characters. The largest a tool takes is upload_file with a file at
 * the 50 MB cap, base64 encoded with line breaks (files-tools.mjs BASE64_MAX_CHARS, about 72
 * million); a longer line is not read into memory at all, and gets an error.
 */
export const MAX_MESSAGE_CHARS = 96 * 1024 * 1024;

/**
 * How much of a line too long to read is kept: enough to find the id it is answered with (a
 * client writes "jsonrpc", "id" and "method" before the long params), never the long part.
 */
export const HEAD_CHARS = 512;

/** Index just past the end of the JSON string that starts at `i`, or -1 when it does not end in `s`. */
function stringEnd(/** @type {string} */ s, /** @type {number} */ i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return -1;
}

/**
 * The id of a JSON-RPC message from the start of its line (the rest was too long to read), or
 * null when the start does not hold the whole of a top-level "id" (an "id" inside params is not
 * it). Only a string or a number, as JSON-RPC allows.
 * @param {string} head
 * @returns {string | number | null}
 */
export function idFromHead(head) {
  let depth = 0;
  let wantKey = false;
  for (let i = 0; i < head.length; ) {
    const ch = head[i];
    if (ch === '"') {
      if (depth === 0) return null;
      const end = stringEnd(head, i);
      if (end < 0) return null;
      if (depth === 1 && wantKey) {
        wantKey = false;
        let key;
        try {
          key = JSON.parse(head.slice(i, end));
        } catch {
          return null;
        }
        const colon = /^\s*:\s*/.exec(head.slice(end));
        if (!colon) return null;
        i = end + colon[0].length;
        if (key !== 'id') continue;
        // The whole value, and something after it: a number at the very end may be cut short.
        const m = /^("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*[,}]/.exec(head.slice(i));
        if (!m) return null;
        try {
          const id = JSON.parse(m[1]);
          return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
        } catch {
          return null;
        }
      }
      i = end;
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch !== '{') return null;
      depth++;
      if (depth === 1) wantKey = true;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth <= 0) return null;
    } else if (ch === ',') {
      if (depth === 1) wantKey = true;
    } else if (depth === 0 && !/\s/.test(ch)) {
      return null;
    }
    i++;
  }
  return null;
}

/**
 * Serve messages from a readable stream of newline-delimited JSON, writing responses (and the
 * server's own notifications) to a writable stream. Resolves when the input ends.
 *
 * Each chunk is searched for line ends on its own, and the pieces of a line are joined once, when
 * it ends: a long line (a large upload arrives as one line of tens of megabytes, in chunks of a
 * few kilobytes) is never searched or copied again with every chunk.
 * @param {{ handle: (msg: any) => Promise<object | null>, connect?: (send: (message: object) => void) => void }} server
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} io
 * @param {{ maxMessageChars?: number }} [opts]
 */
export function serve(server, io, opts = {}) {
  const maxChars = opts.maxMessageChars ?? MAX_MESSAGE_CHARS;
  /** @param {object} response */
  const send = (response) => {
    io.output.write(`${JSON.stringify(response)}\n`);
  };
  server.connect?.(send);
  /** The pieces of the line not ended yet, and how long they are together. */
  let pieces = /** @type {string[]} */ ([]);
  let piecesLength = 0;
  /** The line now arriving is too long: its pieces are dropped until it ends. */
  let tooLong = false;
  /** The first HEAD_CHARS of the line now arriving, kept even when it is too long, for its id. */
  let head = '';
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
  /** Keep one piece of the line now arriving, unless that makes it too long. */
  const keep = (/** @type {string} */ piece) => {
    if (!piece) return;
    if (head.length < HEAD_CHARS) head += piece.slice(0, HEAD_CHARS - head.length);
    if (tooLong) return;
    if (piecesLength + piece.length > maxChars) {
      tooLong = true;
      pieces = [];
      piecesLength = 0;
      return;
    }
    pieces.push(piece);
    piecesLength += piece.length;
  };
  /**
   * The line now arriving has ended: answer it, or say it was too long, under the id its start
   * names (null when it names none), so the client's own call gets the error instead of waiting.
   */
  const endLine = () => {
    const start = head;
    head = '';
    if (tooLong) {
      tooLong = false;
      send({ jsonrpc: '2.0', id: idFromHead(start.trimStart()), error: { code: ERR_INVALID_REQUEST, message: `Message too large: at most ${maxChars} characters.` } });
      return;
    }
    const line = pieces.length === 1 ? pieces[0] : pieces.join('');
    pieces = [];
    piecesLength = 0;
    onLine(line);
  };
  return new Promise((resolve) => {
    io.input.setEncoding('utf8');
    io.input.on('data', (/** @type {string} */ chunk) => {
      let start = 0;
      let nl;
      while ((nl = chunk.indexOf('\n', start)) >= 0) {
        keep(chunk.slice(start, nl));
        endLine();
        start = nl + 1;
      }
      keep(chunk.slice(start));
    });
    io.input.on('end', () => {
      if (tooLong || pieces.length) endLine();
      pending.then(() => resolve(undefined));
    });
  });
}
