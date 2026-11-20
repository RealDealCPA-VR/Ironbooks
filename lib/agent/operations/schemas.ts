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
 * (lib/agent/guards.ts: a password, a setting only a person changes, a flag the operation does
 * not take), so it never asks an agent for something it must not send.
 *
 * SERVER ONLY: loading a schema imports its validation module (some are service modules).
 */
import { z, type ZodTypeAny } from 'zod';
import type { ShellOperationDef } from '../contract';
import { guardInput } from '../guards';
import { zodToJsonSchema, type JsonSchema } from '../jsonSchema';
import { GENERATED_ROUTES } from './routes.generated';
import { SHELL_OPERATIONS } from './shell';
import type { Operation } from './types';

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

/** The body of a shell operation as a strict zod object, from its definition's input fields. */
export function shellBodySchema(def: ShellOperationDef): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [name, field] of Object.entries(def.input)) {
    let s: ZodTypeAny;
    if (field.type === 'number') s = z.number();
    else if (field.type === 'boolean') s = z.boolean();
    else if (field.type === 'path' || field.type === 'fileId') s = z.string().min(1);
    else s = z.string();
    const text = [SHELL_FIELD_NOTES[field.type], field.describe].filter((t) => t && t.trim()).join(' ');
    if (text) s = s.describe(text);
    shape[name] = field.required ? s : s.optional();
  }
  // No description on the object itself: def.describe is the card's sentence with {field}
  // placeholders, and describe_operation already shows it as the operation's description.
  return z.object(shape).strict();
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

/** Take the field a dotted path names out of a schema: its property, and its place in required. */
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
    const props = part.properties;
    if (!isNode(props) || !Object.hasOwn(props, head)) continue;
    if (rest.length > 0) {
      removePath(props[head], rest, root, depth + 1);
      continue;
    }
    delete props[head];
    if (Array.isArray(part.required)) {
      const required = part.required.filter((r) => r !== head);
      if (required.length) part.required = required;
      else delete part.required;
    }
  }
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
  // Named by field name: "lines.0.password" and "lines.1.password" are one password field.
  const names = (paths: string[]) => [...new Set(paths.map((p) => p.split('.').pop() ?? p))];
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
