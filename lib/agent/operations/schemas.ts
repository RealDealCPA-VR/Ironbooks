/**
 * Agent full access: the zod schema of an operation's body and query, and their JSON Schema for
 * describe_operation (plan §6.3).
 *
 * Where the schemas come from:
 *  - an API route: the "@/lib/validation/x#name" references of the registry. The body schema is
 *    the operation's own (`bodySchema`: the classification's, else the one the generator read from
 *    the handler); the query schema is the one the generator read (routes.generated.ts). Each is
 *    loaded through the static import map of schemas.generated.ts, never by a path built at run
 *    time, so only a schema the build knows can ever be loaded.
 *  - a shell operation (shell.ts): built here from the definition's input fields, strict, so a
 *    field the flow does not name is refused rather than passed along.
 *
 * The JSON Schema is made on the server when asked (lib/agent/jsonSchema.ts), not shipped with the
 * connector, and kept per operation for the life of the process: the schemas are code, so they
 * only change with a new build. It leaves out every field the guards take out of an agent's input
 * (lib/agent/guards.ts: a password, a key, a setting only a person changes, a flag the operation
 * does not take), from its properties and from every required list, at any depth, so it never asks
 * an agent for something it must not send.
 *
 * Where a classification gives examples, examplesOf reads them in the shape describe_operation
 * answers them (contract.ts OperationDescription.examples, wave 4), and exampleProblems checks each
 * against the described schema and the guards, and says where one could be read two ways (the
 * registry test runs it over every operation). examplesOf says how to write one.
 *
 * The largest described schema today is the body of invoices.create, about 9,000 characters
 * (roughly 2,500 tokens); SCHEMA_CHARS_MAX is what the tests hold every one under.
 *
 * SERVER ONLY: loading a schema imports its validation module (some are service modules).
 */
import { z, type ZodTypeAny } from 'zod';
import type { OperationInput, ShellOperationDef } from '../contract';
import { guardInput } from '../guards';
import { jsonSchemaErrors, zodToJsonSchema, type JsonSchema } from '../jsonSchema';
import { OPERATION_CLASSES } from './classes';
import { GENERATED_ROUTES } from './routes.generated';
import { SHELL_OPERATIONS } from './shell';
import { operationKey, type Operation } from './types';

/**
 * Most characters one described body or query may take as JSON (about 8,000 tokens): a model reads
 * it whole next to the rest of its work. A schema that grows past it fails the tests, and is split
 * or trimmed at its source (fewer words per field, a shared part described once).
 */
export const SCHEMA_CHARS_MAX = 32_000;

/** Whether a loaded export is a zod schema (the app's are all zod v3). */
function isZodSchema(v: unknown): v is ZodTypeAny {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { safeParse?: unknown }).safeParse === 'function' &&
    typeof (v as { _def?: { typeName?: unknown } })._def?.typeName === 'string'
  );
}

/** The zod schema a "@/module#export" reference names, through the generated import map. */
async function loadRef(ref: string, operation: Operation): Promise<ZodTypeAny> {
  const { SCHEMA_LOADERS } = await import('./schemas.generated');
  const loader = Object.hasOwn(SCHEMA_LOADERS, ref) ? SCHEMA_LOADERS[ref] : undefined;
  if (!loader) {
    throw new Error(
      `The schema ${ref} of operation ${operation.id} is not in the list of known schemas. ` +
        'Run `npm run agent:registry` to bring lib/agent/operations/schemas.generated.ts up to date.',
    );
  }
  const schema = await loader();
  if (!isZodSchema(schema)) {
    throw new Error(
      `${ref} (operation ${operation.id}) does not name a zod schema. ` +
        'Point bodySchema in lib/agent/operations/classes at the schema the route parses its body with.',
    );
  }
  return schema;
}

/** What each kind of shell input field is, in words an agent can act on. */
const SHELL_FIELD_NOTES: Record<ShellOperationDef['input'][string]['type'], string> = {
  string: '',
  number: '',
  boolean: '',
  path: 'A folder or file path on this computer.',
  fileId: 'The fileId of a file you staged with upload_file.',
};

/** Small words that lead into a placeholder ("at {file}", "in {folder}"). */
const LEAD_WORDS = 'at|in|into|to|from|as|for|of|on|onto|with|by|under';

/** A field name in plain words: "fileId" is "file", "targetFolder" is "target folder". */
function fieldWords(name: string): string {
  const words = name
    .trim()
    .replace(/Ids?$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  return words || 'value';
}

/**
 * A describe template as a plain sentence, without its {field} placeholders: the card's line
 * "Save file {fileId} in {folder}" reads "Save file in the given folder.", "Open company file
 * {file}" reads "Open company file.", "Turn on multi-user access ({network})" reads "Turn on
 * multi-user access." A placeholder after a small word becomes "the given …"; any other one goes.
 */
export function plainSentence(template: string): string {
  let s = template
    .replace(/\s*\(\s*\{[^{}]*\}\s*\)/g, '')
    .replace(new RegExp(`\\b(${LEAD_WORDS})\\s+\\{([^{}]*)\\}`, 'gi'), (_m, lead: string, name: string) => `${lead} the given ${fieldWords(name)}`)
    .replace(/\s*\{[^{}]*\}/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[\s,;:]+$/, '');
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The body of a shell operation as a strict zod object, from its definition's input fields. */
export function shellBodySchema(def: ShellOperationDef): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, field] of Object.entries(def.input)) {
    let s: ZodTypeAny;
    if (field.type === 'number') s = z.number();
    else if (field.type === 'boolean') s = z.boolean();
    else if (field.type === 'path' || field.type === 'fileId') s = z.string().min(1);
    else s = z.string();
    const text = [SHELL_FIELD_NOTES[field.type], plainSentence(field.describe ?? '')].filter((t) => t && t.trim()).join(' ');
    if (text) s = s.describe(text);
    shape[name] = field.required ? s : s.optional();
  }
  // def.describe is the card's line, with {field} placeholders the card fills in: here it is said
  // as a plain sentence, with what the strict object means for the sender.
  const what = plainSentence(def.describe ?? '');
  const fields = Object.keys(shape).length
    ? 'Send only the fields listed here: any other field is refused.'
    : 'It takes no fields.';
  return z
    .object(shape)
    .strict()
    .describe(what ? `${what} ${fields}` : fields);
}

function shellDef(operation: Operation): ShellOperationDef | null {
  return SHELL_OPERATIONS.find((d) => d.id === operation.id) ?? null;
}

/** The query schema reference the generator read from the handler, or null. */
function queryRef(operation: Operation): string | null {
  if (operation.kind !== 'route') return null;
  return GENERATED_ROUTES[operation.route]?.methods[operation.method]?.querySchema ?? null;
}

/**
 * The cache key: the id, plus what the schema is read from and what decides the fields left out
 * (the route and the confirmation flags the guards go by). An operation is looked up by id, but a
 * caller holding an edited copy must not get (or leave behind) another operation's schema.
 */
function cacheKey(operation: Operation): string {
  const flags = Array.isArray(operation.confirmFlags) ? operation.confirmFlags.join(',') : '';
  return [operation.kind, operation.id, operation.route, operation.method, operation.bodySchema ?? '', flags].join('\u0000');
}

const bodySchemas = new Map<string, Promise<ZodTypeAny | null>>();
const described = new Map<string, Promise<{ body: unknown; query: unknown }>>();

/** Keep a promise, and forget it again if it fails (the next call tries afresh). */
function remember<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = make();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

/** The zod schema the route parses its body with, or null when it takes none or parses by hand. */
export async function loadBodySchema(operation: Operation): Promise<ZodTypeAny | null> {
  return remember(bodySchemas, cacheKey(operation), async () => {
    if (operation.kind === 'shell') {
      const def = shellDef(operation);
      return def ? shellBodySchema(def) : null;
    }
    return operation.bodySchema ? loadRef(operation.bodySchema, operation) : null;
  });
}

/** A schema the caller can read but not change: the same object is handed to every caller. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Fields an agent never sends
// ---------------------------------------------------------------------------

type SchemaNode = Record<string, unknown>;

const isNode = (v: unknown): v is SchemaNode => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How deep the walks below follow a schema (a recursive one through $ref goes round). */
const WALK_DEPTH = 16;

/** What stands in for every value that is not an object or a list, when the guards are asked. */
const STAND_IN = 'x';

/**
 * The key that stands in for any key of a record (additionalProperties), so the guards also see
 * the fields of a record's values. No real field is named with a NUL, and it holds no dot.
 */
const ANY_KEY = '\u0000any';

/** Field names that hold a secret: used only if the guards cannot be asked (fail closed). */
const SECRET_LOOKING = /pass(word|phrase|code)|apikey|secret|token|recoverykey|totp|challengeanswer/i;

/** The schemas a node is made of: itself, its anyOf / oneOf / allOf options, and what its $ref names. */
function partsOf(node: SchemaNode, root: SchemaNode, seen = new Set<SchemaNode>()): SchemaNode[] {
  if (seen.has(node)) return [];
  seen.add(node);
  const out: SchemaNode[] = [node];
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[k];
    if (Array.isArray(list)) for (const o of list) if (isNode(o)) out.push(...partsOf(o, root, seen));
  }
  const ref = node.$ref;
  const defs = root.$defs;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/') && isNode(defs)) {
    const target = defs[ref.slice('#/$defs/'.length)];
    if (isNode(target)) out.push(...partsOf(target, root, seen));
  }
  return out;
}

function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  // defineProperty: a field named "__proto__" stays a field.
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Two stand-in values for one place merged: objects key by key, lists item by item. */
function mergeSample(a: unknown, b: unknown): unknown {
  if (isNode(a) && isNode(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const k of Object.keys(b)) setOwn(out, k, Object.hasOwn(out, k) ? mergeSample(out[k], b[k]) : b[k]);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: unknown[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(i < a.length && i < b.length ? mergeSample(a[i], b[i]) : (a[i] ?? b[i]));
    return out;
  }
  return a === STAND_IN ? b : a;
}

/**
 * A value with every field the schema names (in any of its options), each filled with a stand-in:
 * what the guards are shown, so they say which of the fields they take out.
 */
function sampleOf(node: unknown, root: SchemaNode, depth = 0): unknown {
  if (!isNode(node) || depth > WALK_DEPTH) return STAND_IN;
  let out: unknown = STAND_IN;
  for (const part of partsOf(node, root)) {
    if (isNode(part.properties)) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(part.properties)) setOwn(obj, k, sampleOf(v, root, depth + 1));
      out = mergeSample(out, obj);
    }
    if (isNode(part.additionalProperties)) {
      const obj: Record<string, unknown> = {};
      setOwn(obj, ANY_KEY, sampleOf(part.additionalProperties, root, depth + 1));
      out = mergeSample(out, obj);
    }
    const list: unknown[] = Array.isArray(part.prefixItems) ? part.prefixItems.map((p) => sampleOf(p, root, depth + 1)) : [];
    if (isNode(part.items)) list.push(sampleOf(part.items, root, depth + 1));
    if (list.length) out = mergeSample(out, list);
  }
  return out;
}

/** Every dotted path in a stand-in value, objects and lists included ("lines", "lines.0", "lines.0.memo"). */
function pathsOf(value: unknown, trail: string[] = [], out: string[] = []): string[] {
  const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : isNode(value) ? Object.keys(value) : [];
  for (const k of keys) {
    const p = [...trail, k];
    out.push(p.join('.'));
    pathsOf((value as Record<string, unknown>)[k], p, out);
  }
  return out;
}

/**
 * Take the field a dotted path names out of a schema: its property, and its name from every
 * required list of the object it sits in (the option that lists it as required may not be the one
 * that describes it, in an allOf).
 */
function removePath(node: unknown, segs: string[], root: SchemaNode, depth = 0): void {
  if (!isNode(node) || segs.length === 0 || depth > WALK_DEPTH) return;
  const [head, ...rest] = segs;
  for (const part of partsOf(node, root)) {
    if (/^\d+$/.test(head)) {
      // An element of a list: the field is inside the item schema.
      if (Array.isArray(part.prefixItems) && isNode(part.prefixItems[Number(head)])) {
        removePath(part.prefixItems[Number(head)], rest, root, depth + 1);
      }
      if (isNode(part.items)) removePath(part.items, rest, root, depth + 1);
    }
    if (head === ANY_KEY) {
      // Any key of a record: the field is inside the schema of its values.
      if (isNode(part.additionalProperties)) removePath(part.additionalProperties, rest, root, depth + 1);
      continue;
    }
    const props = part.properties;
    const described = isNode(props) && Object.hasOwn(props, head);
    if (rest.length > 0) {
      if (described) removePath(props[head], rest, root, depth + 1);
      continue;
    }
    if (described) delete props[head];
    if (Array.isArray(part.required) && part.required.includes(head)) {
      const required = part.required.filter((r) => r !== head);
      if (required.length) part.required = required;
      else delete part.required;
    }
  }
}

/** A dotted path as the note names it: "draft.password", "providers.apiKey" (no list positions, no record key). */
function shownPath(path: string): string {
  return path
    .split('.')
    .filter((s) => s !== ANY_KEY && !/^\d+$/.test(s))
    .join('.') || path;
}

/**
 * The dotted paths (without "body." / "query.") the guards take out of an agent's input for this
 * operation, split by why: `personOnly` holds secrets and settings only a person gives;
 * `notTaken` holds "yes, I am sure" flags this operation does not take from an agent. Asked of
 * guardInput itself, so the description and the guards cannot drift apart.
 */
function guardedPaths(operation: Operation, part: 'body' | 'query', sample: unknown): { personOnly: string[]; notTaken: string[] } {
  const prefix = `${part}.`;
  const strip = (op: Operation) =>
    guardInput(op, { [part]: sample })
      .stripped.filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length));
  try {
    const all = strip(operation);
    // With every field counted as a flag the operation takes, what is still taken out is what
    // only a person gives; the rest are flags.
    const personOnly = strip({ ...operation, confirmFlags: pathsOf(sample) });
    return { personOnly, notTaken: all.filter((p) => !personOnly.includes(p)) };
  } catch {
    // The guards could not be asked: leave out every field whose name looks like a secret.
    return { personOnly: pathsOf(sample).filter((p) => SECRET_LOOKING.test(p.split('.').pop() ?? '')), notTaken: [] };
  }
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The schema without the fields the guards take out of an agent's input (a password the route
 * reads, a setting only a person changes), so it never asks an agent for what it must not send;
 * a sentence on the root says which were left out and why.
 */
function withoutGuardedFields(operation: Operation, part: 'body' | 'query', schema: JsonSchema): JsonSchema {
  const out = structuredClone(schema) as SchemaNode;
  const { personOnly, notTaken } = guardedPaths(operation, part, sampleOf(out, out));
  if (personOnly.length === 0 && notTaken.length === 0) return out;
  for (const p of [...personOnly, ...notTaken]) removePath(out, p.split('.'), out);
  // Named by where they sit, without list positions: "lines.0.password" and "lines.1.password"
  // are one field, "draft.password" says which password.
  const names = (paths: string[]) => [...new Set(paths.map(shownPath))];
  const notes: string[] = [];
  const person = names(personOnly);
  if (person.length) notes.push(`Leave out ${joinWords(person)}: only a person gives ${person.length > 1 ? 'these' : 'this'}, in Ironbooks.`);
  const flags = names(notTaken).filter((n) => !person.includes(n));
  if (flags.length) {
    notes.push(`Leave out ${joinWords(flags)}: this operation does not take ${flags.length > 1 ? 'these confirmations' : 'this confirmation'} from an agent.`);
  }
  const before = typeof out.description === 'string' && out.description.trim() ? `${out.description.trim()} ` : '';
  out.description = `${before}${notes.join(' ')}`;
  return out;
}

/** Said instead of a schema that could not be loaded: the rest of the description still helps. */
function couldNotDescribe(part: 'body' | 'query'): JsonSchema {
  return {
    description:
      `Ironbooks could not describe this ${part} right now. Send the fields the operation's description ` +
      'names; the app checks them when the operation runs, and a dry run shows any problem first.',
  };
}

async function describePart(
  operation: Operation,
  part: 'body' | 'query',
  load: () => Promise<ZodTypeAny | null>,
): Promise<{ schema: unknown; failed: boolean }> {
  let schema: ZodTypeAny | null;
  try {
    schema = await load();
  } catch (err) {
    // The generated map is out of date or a reference is wrong: the registry tests catch both
    // before a release. Here the agent still gets the rest of the description.
    console.warn(`[agent] ${err instanceof Error ? err.message : String(err)}`);
    return { schema: couldNotDescribe(part), failed: true };
  }
  return { schema: schema ? withoutGuardedFields(operation, part, zodToJsonSchema(schema)) : null, failed: false };
}

/** JSON Schema (draft 2020-12) of the body and of the query; null where there is none. */
export async function describeSchemas(operation: Operation): Promise<{ body: unknown; query: unknown }> {
  const key = cacheKey(operation);
  return remember(described, key, async () => {
    const qRef = queryRef(operation);
    const [body, query] = await Promise.all([
      describePart(operation, 'body', () => loadBodySchema(operation)),
      describePart(operation, 'query', async () => (qRef ? loadRef(qRef, operation) : null)),
    ]);
    // A part that could not be loaded is not kept: the next call tries again.
    if (body.failed || query.failed) described.delete(key);
    return deepFreeze({ body: body.schema, query: query.schema });
  });
}

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

/**
 * One example of an operation as describe_operation passes it on (contract.ts
 * OperationDescription.examples, wave 4): a whole request as run_operation takes it, { params?,
 * query?, body?, confirm?, reveal? }, with an optional title or note beside it that is not sent.
 * The contract types the examples as unknown[], so the compiler checks nothing here: the tests of
 * describe_operation (lib/agent/operate.test.ts) are what hold the answer to this shape.
 */
export interface OperationExample {
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
  confirm?: string[];
  /** Only ever true: an example that does not ask for unmasked values leaves it out. */
  reveal?: true;
  /** A short name for the example (written as title, describe or summary). Not sent. */
  title?: string;
  /** What the example shows or when to use it. Not sent. */
  note?: string;
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

/**
 * The keys of an example written as a whole request, each with the shape it must have there: the
 * parts of a request (contract.ts OperationInput), and words a person may write beside it, which
 * are not sent. An example with any other key, or one of these in another shape, is the body alone.
 */
const EXAMPLE_KEYS: Readonly<Record<string, (v: unknown) => boolean>> = {
  params: (v) => isNode(v) && Object.values(v).every(isText),
  query: (v) => isNode(v) && Object.values(v).every((x) => isText(x) || isTextList(x)),
  body: () => true,
  confirm: isTextList,
  reveal: (v) => typeof v === 'boolean',
  describe: isText,
  title: isText,
  note: isText,
  summary: isText,
};

/**
 * The examples as written, wherever they are given: on the operation itself, on its shell
 * definition, or on its classification (lib/agent/operations/classes). types.ts has no `examples`
 * field yet, so each place is read as unknown.
 */
function writtenExamples(operation: Operation): unknown {
  const own = (operation as { examples?: unknown }).examples;
  if (own !== undefined) return own;
  if (operation.kind === 'shell') return (shellDef(operation) as { examples?: unknown } | null)?.examples;
  const key = operationKey(operation.method, operation.route);
  return Object.hasOwn(OPERATION_CLASSES, key) ? (OPERATION_CLASSES[key] as { examples?: unknown }).examples : undefined;
}

/** One example as written, how it is read, and whether it was read as a whole request. */
interface ReadExample {
  written: unknown;
  read: OperationExample;
  whole: boolean;
}

function readExamples(operation: Operation): ReadExample[] {
  const written = writtenExamples(operation);
  if (written === undefined || written === null) return [];
  return (Array.isArray(written) ? written : [written]).map((ex): ReadExample => {
    const e = isNode(ex) ? ex : {};
    const keys = Object.keys(e);
    const whole =
      keys.length > 0 &&
      keys.every((k) => Object.hasOwn(EXAMPLE_KEYS, k) && EXAMPLE_KEYS[k](e[k])) &&
      keys.some((k) => k === 'params' || k === 'query' || k === 'body');
    if (!whole) return { written: ex, read: { body: ex }, whole: false };
    const read: OperationExample = {};
    if (e.params !== undefined) read.params = e.params as Record<string, string>;
    if (e.query !== undefined) read.query = e.query as Record<string, string | string[]>;
    if (e.body !== undefined) read.body = e.body;
    // An empty list confirms nothing: it is only there so the example reads one way (exampleProblems).
    if (Array.isArray(e.confirm) && e.confirm.length) read.confirm = e.confirm as string[];
    if (e.reveal === true) read.reveal = true;
    // The words beside it, as the contract names them: title (or describe, or summary) and note.
    const title = [e.title, e.describe, e.summary].find((t): t is string => isText(t) && t.trim() !== '');
    if (title) read.title = title.trim();
    if (isText(e.note) && e.note.trim()) read.note = e.note.trim();
    return { written: ex, read, whole: true };
  });
}

/**
 * An operation's examples, as describe_operation answers them (OperationDescription.examples): each
 * a request as run_operation takes it, with its title and note. How to write one (in a
 * classification, a shell definition or on the operation): as a whole request, { params?, query?,
 * body?, confirm?, reveal? }, with words beside it if wanted (title, note, summary, describe: not
 * sent; summary and describe are read as the title); anything else (another key, or one of those in
 * another shape) is read as the body alone. Where a body's own fields could make it read either way
 * ({ body, note } for a body with fields body and note), exampleProblems says so: write it as a
 * whole request with "confirm": [] beside it.
 */
export function examplesOf(operation: Operation): OperationExample[] {
  return readExamples(operation).map((e) => e.read);
}

/** The field names a body schema gives at its top level, in any of its options. */
function topLevelFields(schema: SchemaNode): Set<string> {
  const out = new Set<string>();
  for (const part of partsOf(schema, schema)) if (isNode(part.properties)) for (const k of Object.keys(part.properties)) out.add(k);
  return out;
}

/** Query text as the route reads it: "12" may stand for a number, "true" for a yes. */
function queryAsValues(query: Record<string, unknown>): Record<string, unknown> {
  const value = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(value);
    if (typeof v !== 'string') return v;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === 'true' || v === 'false') return v === 'true';
    return v;
  };
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, value(v)]));
}

/**
 * What is wrong with each of an operation's examples, one line per problem, each naming the
 * operation and the example: a body or query that does not meet the described schema, a field the
 * guards would take out (an agent never sends it), or a request the guards would refuse (a
 * missing path parameter, a confirmation the operation does not take). Empty when they are all good.
 */
export async function exampleProblems(operation: Operation): Promise<string[]> {
  const read = readExamples(operation);
  if (read.length === 0) return [];
  let schemas: { body: unknown; query: unknown };
  try {
    schemas = await describeSchemas(operation);
  } catch (err) {
    return [`${operation.id}: its examples could not be checked, because its schemas could not be described (${err instanceof Error ? err.message : String(err)}).`];
  }
  const bodyFields = isNode(schemas.body) ? topLevelFields(schemas.body) : new Set<string>();
  const problems: string[] = [];
  read.forEach(({ written, read: ex, whole }, i) => {
    const at = `${operation.id} example ${i + 1}`;
    // Read as a whole request, but every key of it is also a field of the body: it may have been
    // meant as the body alone, and then the real body was never checked.
    const keys = whole && isNode(written) ? Object.keys(written) : [];
    if (keys.length && keys.every((k) => bodyFields.has(k))) {
      problems.push(
        `${at}: it reads as a whole request, but ${joinWords(keys)} ${keys.length > 1 ? 'are' : 'is'} also ${keys.length > 1 ? 'fields' : 'a field'} of the body, ` +
          'so it may have been meant as the body alone. Put the body under "body" and add "confirm": [] beside it, so it reads one way only.',
      );
    }
    if (isNode(schemas.body) && Object.keys(schemas.body).length === 1 && String(schemas.body.description).startsWith('Ironbooks could not describe this body')) {
      problems.push(`${at}: the body schema could not be loaded, so the example could not be checked.`);
    } else if (schemas.body) {
      // No body where the route reads one is checked as an empty object: its required fields show.
      const body = ex.body !== undefined ? ex.body : operation.body === 'json' ? {} : undefined;
      if (body !== undefined) for (const e of jsonSchemaErrors(schemas.body, body)) problems.push(`${at} body ${e}`);
    } else if (ex.body !== undefined && operation.body === 'none') {
      problems.push(`${at}: it sends a body, but this operation takes none.`);
    }
    if (schemas.query && ex.query !== undefined) {
      // Query values travel as text: one that only passes read as a number or a yes still passes.
      const asSent = jsonSchemaErrors(schemas.query, ex.query);
      const errors = asSent.length && isNode(ex.query) ? jsonSchemaErrors(schemas.query, queryAsValues(ex.query)) : asSent;
      for (const e of errors) problems.push(`${at} query ${e}`);
    }
    const input: OperationInput = {};
    if (ex.params !== undefined) input.params = ex.params;
    if (ex.query !== undefined) input.query = ex.query;
    if (ex.body !== undefined) input.body = ex.body;
    if (ex.confirm !== undefined) input.confirm = ex.confirm;
    // A reveal the operation does not have is refused by the guards: an example must not show one.
    if (ex.reveal) input.reveal = true;
    let guarded: ReturnType<typeof guardInput>;
    try {
      guarded = guardInput(operation, input);
    } catch (err) {
      problems.push(`${at}: the guards could not read it (${err instanceof Error ? err.message : String(err)}).`);
      return;
    }
    if (guarded.stripped.length) {
      problems.push(`${at}: it sends ${joinWords(guarded.stripped)}, which an agent never sends (the guards take it out).`);
    }
    if (guarded.refused) problems.push(`${at}: the guards would refuse it: ${guarded.refused}`);
  });
  return problems;
}
