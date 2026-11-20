/**
 * Agent full access: turn one of the app's zod schemas into JSON Schema (draft 2020-12), so
 * describe_operation can show an agent the exact body and query a route accepts (plan §6.3).
 *
 * Written here instead of adding `zod-to-json-schema`: the app is on zod 3.25 with v3 schemas, and
 * nothing new may be installed. The schema is built on the server when describe_operation asks
 * (lib/agent/operations/schemas.ts caches it per operation), not shipped as a file with the connector.
 *
 * It describes what a caller may SEND (the input side):
 *  - a field is required unless the schema accepts it missing (optional, default, catch, any …);
 *  - a refine / superRefine / transform / preprocess is described by the schema inside it (the
 *    check itself is code and cannot be written as JSON Schema; the route still runs it);
 *  - a pipeline is described by its first schema, which is what reads the input;
 *  - a pattern or format is never stricter than the route: a regex's flags are written into its
 *    pattern (a pattern has none), and zod's time, which has no offset, is a pattern, not a format;
 *  - an object that strips unknown keys (zod's default) says nothing about other keys: some routes
 *    read a field or two by hand next to the schema, so "no other keys" would be wrong there. A
 *    strict object says additionalProperties false, passthrough true, a catchall its schema.
 *
 * Every `.describe()` text becomes `description` at its own level. A kind it does not know becomes
 * {} with a description saying so. It never throws: one odd field must not hide the whole body.
 *
 * Pure: no Node, database or Next imports.
 */

/** One JSON Schema object (draft 2020-12). */
export type JsonSchema = { [keyword: string]: unknown };

export const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export interface ZodToJsonSchemaOptions {
  /** Put `"$schema"` on the root. Default true. */
  $schema?: boolean;
  /** How deep it follows nested schemas before it stops describing a branch. Default 64. */
  maxDepth?: number;
}

/** The parts of a zod v3 `_def` this module reads. Everything is optional: it may be anything. */
interface ZodDefLike {
  typeName?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

interface ZodLike {
  _def: ZodDefLike;
  safeParse?: (v: unknown) => { success: boolean };
}

function isZod(v: unknown): v is ZodLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { _def?: unknown })._def === 'object' &&
    (v as { _def?: unknown })._def !== null
  );
}

function typeNameOf(v: ZodLike): string {
  return typeof v._def.typeName === 'string' ? v._def.typeName : '';
}

/** A schema that accepts anything, saying why nothing more precise is given. */
function notDescribed(what: string): JsonSchema {
  return { description: `Not described: ${what}. The app still checks this value when the operation runs.` };
}

/**
 * Escape text so it matches itself inside a regular expression. Only the syntax characters: a
 * validator in unicode mode refuses any other escape (`\-`).
 */
function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** A value that can sit in JSON Schema as written (a default or a literal), or undefined. */
function jsonValue(v: unknown): unknown {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return undefined;
  try {
    const text = JSON.stringify(v);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined; // a cycle or a bigint deep inside: leave the default out
  }
}

const isPlainType = (t: unknown): t is string => typeof t === 'string';

/** Keywords that would reject null even when `type` allows it. */
const COMBINING = ['anyOf', 'oneOf', 'allOf', 'not', '$ref', 'if'];

/** `inner`, or null. */
function nullable(inner: JsonSchema): JsonSchema {
  const t = inner.type;
  const combined = COMBINING.some((k) => k in inner);
  if (!combined && (isPlainType(t) || (Array.isArray(t) && t.every(isPlainType)))) {
    const types = Array.isArray(t) ? [...t] : [t];
    if (types.includes('null')) return inner;
    const out: JsonSchema = { ...inner, type: [...types, 'null'] };
    if (Array.isArray(out.enum)) out.enum = [...out.enum, null];
    if ('const' in out) {
      out.enum = [out.const, null];
      delete out.const;
    }
    return out;
  }
  if (Object.keys(inner).length === 0) return inner; // already anything
  // A union already lists its options: null becomes one more (an "object, one of these" union
  // also lets null through its type).
  const keys = Object.keys(inner);
  if (Array.isArray(inner.anyOf) && keys.every((k) => k === 'anyOf' || k === 'description' || (k === 'type' && isPlainType(t)))) {
    const out: JsonSchema = { ...inner, anyOf: [...inner.anyOf, { type: 'null' }] };
    if (isPlainType(t)) out.type = [t, 'null'];
    return out;
  }
  return { anyOf: [inner, { type: 'null' }] };
}

/** The JSON type of a literal value. */
function literalSchema(value: unknown): JsonSchema {
  if (value === null) return { type: 'null' };
  switch (typeof value) {
    case 'string':
      return { type: 'string', const: value };
    case 'number':
      return { type: Number.isInteger(value) ? 'integer' : 'number', const: value };
    case 'boolean':
      return { type: 'boolean', const: value };
    case 'bigint':
      return { type: 'integer', const: Number(value) };
    case 'undefined':
      return { not: {}, description: 'Leave this field out.' };
    default:
      return notDescribed(`a ${typeof value} value cannot be sent as JSON`);
  }
}

/**
 * Formats of zod string checks that JSON Schema names the same thing. Not `time`: zod's time has no
 * offset ("13:45"), JSON Schema's must have one ("13:45:00Z"), so it is written as a pattern below,
 * and so is a datetime that may leave its offset out (`local`).
 */
const STRING_FORMATS: Record<string, string> = {
  email: 'email',
  url: 'uri',
  uuid: 'uuid',
  datetime: 'date-time',
  date: 'date',
  duration: 'duration',
};

/**
 * zod's own time test (zod v3 timeRegexSource), without anchors: seconds and a fraction may be left
 * out unless a precision is set.
 */
function timePattern(precision: unknown): string {
  const p = typeof precision === 'number' ? precision : null;
  let seconds = '[0-5]\\d';
  if (p) seconds += `\\.\\d{${p}}`;
  else if (p == null) seconds += '(\\.\\d+)?';
  return `([01]\\d|2[0-3]):[0-5]\\d(:${seconds})${p ? '+' : '?'}`;
}

/**
 * A datetime whose offset may be left out (zod `datetime({ local: true })`). The date part is only
 * its shape (zod also checks the day exists, and still does when the operation runs): a pattern
 * here may let through more than the route takes, never less.
 */
function localDateTimePattern(check: { precision?: unknown; offset?: unknown }): string {
  const zone = check.offset === true ? '(Z?|([+-]\\d{2}:?\\d{2}))' : 'Z?';
  return `^\\d{4}-\\d{2}-\\d{2}T${timePattern(check.precision)}${zone}$`;
}

/** Whether a character has an upper and a lower case, each one character long. */
function hasCase(ch: string): boolean {
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  return lower !== upper && lower.length === 1 && upper.length === 1;
}

function otherCase(ch: string): string {
  const lower = ch.toLowerCase();
  return ch === lower ? ch.toUpperCase() : lower;
}

/** How many characters the escape at `at` (a backslash) takes: `\d`, `é`, `\u{1F600}`, `\p{L}`, `\k<name>`, `\12` … */
function escapeLength(src: string, at: number): number {
  const next = src[at + 1];
  if (next === undefined) return 1;
  const upTo = (close: string) => {
    const end = src.indexOf(close, at + 2);
    return end === -1 ? 2 : end - at + 1;
  };
  if (next === 'u') return src[at + 2] === '{' ? upTo('}') : 6;
  if (next === 'x') return 4;
  if (next === 'c') return 3;
  if ((next === 'p' || next === 'P') && src[at + 2] === '{') return upTo('}');
  if (next === 'k' && src[at + 2] === '<') return upTo('>');
  if (/\d/.test(next)) {
    let n = 2;
    while (/\d/.test(src[at + n] ?? '')) n++;
    return n;
  }
  return 2;
}

/**
 * The source of a regular expression with its i, s and m flags written into it, since a JSON Schema
 * pattern has no flags: without this, /^[a-f]+$/i would read as lower case only, stricter than the
 * route. `i` turns each letter into both cases (`a` into `[aA]`, `a-f` in a class into `a-fA-F`),
 * `s` turns `.` into `[\s\S]`, `m` lets `^` and `$` match at a line break too. Escapes, group
 * names and lookarounds are copied as they are. Null when the result would not be a valid regular
 * expression: then the pattern is left out rather than wrong.
 */
export function patternWithFlags(regex: RegExp): string | null {
  const ignoreCase = regex.flags.includes('i');
  const dotAll = regex.flags.includes('s');
  const multiline = regex.flags.includes('m');
  const src = regex.source;
  if (!ignoreCase && !dotAll && !multiline) return src;
  let out = '';
  let inClass = false;
  for (let k = 0; k < src.length; k++) {
    const ch = src[k];
    if (ch === '\\') {
      const n = escapeLength(src, k);
      out += src.slice(k, k + n);
      k += n - 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
        out += ch;
        continue;
      }
      // A range: copied whole, with the other case's range beside it when both ends are letters of one case.
      if (src[k + 1] === '-' && k + 2 < src.length && src[k + 2] !== ']') {
        const endLength = src[k + 2] === '\\' ? escapeLength(src, k + 2) : 1;
        const end = src.slice(k + 2, k + 2 + endLength);
        out += `${ch}-${end}`;
        if (ignoreCase && endLength === 1 && hasCase(ch) && hasCase(end) && (ch === ch.toLowerCase()) === (end === end.toLowerCase())) {
          out += `${otherCase(ch)}-${otherCase(end)}`;
        }
        k += 1 + endLength;
        continue;
      }
      out += ignoreCase && hasCase(ch) ? ch + otherCase(ch) : ch;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += ch;
      if (src[k + 1] === '^') {
        out += '^';
        k++;
      }
      continue;
    }
    if (ch === '(' && src[k + 1] === '?') {
      // A group's head ((?: (?= (?! (?<= (?<! (?<name>): a group name has no case to fold.
      const head = /^\(\?(?:<[A-Za-z_$][\w$]*>|<=|<!|[:=!])/.exec(src.slice(k));
      if (head) {
        out += head[0];
        k += head[0].length - 1;
        continue;
      }
    }
    if (ignoreCase && hasCase(ch)) out += `[${ch}${otherCase(ch)}]`;
    else if (dotAll && ch === '.') out += '[\\s\\S]';
    else if (multiline && ch === '^') out += '(?:^|(?<=[\\n\\r\\u2028\\u2029]))';
    else if (multiline && ch === '$') out += '(?:$|(?=[\\n\\r\\u2028\\u2029]))';
    else out += ch;
  }
  try {
    // The same mode as the original (u or v kept), so a source that was valid stays checkable.
    new RegExp(out, regex.flags.replace(/[^uv]/g, ''));
    return out;
  } catch {
    return null;
  }
}

/** Patterns for id formats JSON Schema has no format name for (the same tests zod applies). */
const STRING_PATTERNS: Record<string, string> = {
  cuid: '^[cC][^\\s-]{8,}$',
  cuid2: '^[0-9a-z]+$',
  ulid: '^[0-9A-HJKMNP-TV-Z]{26}$',
  nanoid: '^[a-zA-Z0-9_-]{21}$',
  base64: '^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$',
  base64url: '^([0-9a-zA-Z_-]{4})*(([0-9a-zA-Z_-]{2}(==)?)|([0-9a-zA-Z_-]{3}(=)?))?$',
};

type Check = {
  kind?: unknown;
  value?: unknown;
  inclusive?: unknown;
  regex?: unknown;
  version?: unknown;
  precision?: unknown;
  offset?: unknown;
  local?: unknown;
};

function checksOf(def: ZodDefLike): Check[] {
  return Array.isArray(def.checks) ? (def.checks as Check[]) : [];
}

class Converter {
  /** Recursive schemas, by the name their $ref uses. */
  readonly defs: Record<string, JsonSchema> = {};
  /** z.lazy schemas that turned out to be recursive, and their $defs name. */
  private readonly lazyNames = new Map<object, string>();
  /** z.lazy schemas being converted right now (meeting one again means recursion). */
  private readonly open = new Set<object>();

  constructor(private readonly maxDepth: number) {}

  convert(schema: unknown, depth: number): JsonSchema {
    if (!isZod(schema)) return notDescribed('this part of the schema is not a zod schema');
    if (depth > this.maxDepth) return notDescribed('it is nested too deeply to describe here');
    let out: JsonSchema;
    try {
      out = this.convertDef(schema, depth);
    } catch {
      out = notDescribed(`Ironbooks could not read this part of the schema (${typeNameOf(schema) || 'unknown kind'})`);
    }
    const text = schema._def.description;
    if (typeof text === 'string' && text.trim()) out = { ...out, description: text };
    return out;
  }

  /** Whether an object field with this schema may be left out (the input side). */
  acceptsMissing(schema: unknown, depth = 0): boolean {
    if (!isZod(schema) || depth > this.maxDepth) return false;
    const def = schema._def;
    switch (typeNameOf(schema)) {
      case 'ZodOptional':
      case 'ZodDefault':
      case 'ZodCatch':
      case 'ZodAny':
      case 'ZodUnknown':
      case 'ZodUndefined':
      case 'ZodVoid':
        return true;
      case 'ZodNullable':
      case 'ZodReadonly':
        return this.acceptsMissing(def.innerType, depth + 1);
      case 'ZodBranded':
        return this.acceptsMissing(def.type, depth + 1);
      case 'ZodPipeline':
        return this.acceptsMissing(def.in, depth + 1);
      case 'ZodEffects': {
        const effect = def.effect as { type?: unknown } | undefined;
        if (effect?.type === 'preprocess' && typeof schema.safeParse === 'function') {
          // A preprocess may turn a missing value into one (`v ?? []`); only running it can tell.
          try {
            return schema.safeParse(undefined).success;
          } catch {
            /* fall through to the inner schema */
          }
        }
        return this.acceptsMissing(def.schema, depth + 1);
      }
      case 'ZodLazy':
        try {
          return this.acceptsMissing((def.getter as () => unknown)(), depth + 1);
        } catch {
          return false;
        }
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        return Array.isArray(def.options) && def.options.some((o) => this.acceptsMissing(o, depth + 1));
      case 'ZodIntersection':
        return this.acceptsMissing(def.left, depth + 1) && this.acceptsMissing(def.right, depth + 1);
      case 'ZodLiteral':
        return def.value === undefined;
      default:
        return false;
    }
  }

  private convertDef(schema: ZodLike, depth: number): JsonSchema {
    const def = schema._def;
    const next = (s: unknown) => this.convert(s, depth + 1);
    const kind = typeNameOf(schema);
    switch (kind) {
      case 'ZodString':
        return stringSchema(def);
      case 'ZodNumber':
        return numberSchema(def);
      case 'ZodBigInt':
        return bigintSchema(def);
      case 'ZodBoolean':
        return { type: 'boolean' };
      case 'ZodDate':
        // JSON has no dates: a body sends text the route turns into a date (z.coerce.date()).
        return { type: 'string', format: 'date-time' };
      case 'ZodNull':
        return { type: 'null' };
      case 'ZodUndefined':
      case 'ZodVoid':
        return { not: {}, description: 'Leave this field out.' };
      case 'ZodNever':
        return { not: {} };
      case 'ZodAny':
      case 'ZodUnknown':
        return {};
      case 'ZodLiteral':
        return literalSchema(def.value);
      case 'ZodEnum':
        return { type: 'string', enum: Array.isArray(def.values) ? [...def.values] : [] };
      case 'ZodNativeEnum':
        return nativeEnumSchema(def.values);
      case 'ZodArray': {
        const out: JsonSchema = { type: 'array', items: next(def.type) };
        const exact = def.exactLength as { value?: unknown } | null;
        const min = def.minLength as { value?: unknown } | null;
        const max = def.maxLength as { value?: unknown } | null;
        if (typeof exact?.value === 'number') {
          out.minItems = exact.value;
          out.maxItems = exact.value;
        }
        if (typeof min?.value === 'number') out.minItems = min.value;
        if (typeof max?.value === 'number') out.maxItems = max.value;
        return out;
      }
      case 'ZodTuple': {
        const items = Array.isArray(def.items) ? def.items : [];
        const out: JsonSchema = { type: 'array', prefixItems: items.map(next), minItems: items.length };
        if (isZod(def.rest)) out.items = next(def.rest);
        else {
          out.items = false;
          out.maxItems = items.length;
        }
        return out;
      }
      case 'ZodObject':
        return this.objectSchema(def, depth);
      case 'ZodUnion':
        return unionSchema((Array.isArray(def.options) ? def.options : []).map(next));
      case 'ZodDiscriminatedUnion': {
        const options = Array.isArray(def.options) ? def.options : [...((def.options as Iterable<unknown>) ?? [])];
        return unionSchema(options.map(next));
      }
      case 'ZodIntersection': {
        const parts = [next(def.left), next(def.right)];
        const out: JsonSchema = { allOf: parts };
        if (parts.some((p) => p.type === 'object')) out.type = 'object';
        return out;
      }
      case 'ZodRecord': {
        const out: JsonSchema = { type: 'object', additionalProperties: next(def.valueType) };
        const names = propertyNames(next(def.keyType));
        if (names) out.propertyNames = names;
        return out;
      }
      case 'ZodMap':
        // A Map cannot be sent as JSON; described as the [key, value] pairs it is built from.
        return {
          type: 'array',
          items: { type: 'array', prefixItems: [next(def.keyType), next(def.valueType)], minItems: 2, maxItems: 2 },
        };
      case 'ZodSet': {
        const out: JsonSchema = { type: 'array', uniqueItems: true, items: next(def.valueType) };
        const min = def.minSize as { value?: unknown } | null;
        const max = def.maxSize as { value?: unknown } | null;
        if (typeof min?.value === 'number') out.minItems = min.value;
        if (typeof max?.value === 'number') out.maxItems = max.value;
        return out;
      }
      case 'ZodOptional':
        return next(def.innerType);
      case 'ZodNullable':
        return nullable(next(def.innerType));
      case 'ZodDefault': {
        const out = next(def.innerType);
        let value: unknown;
        try {
          value = jsonValue((def.defaultValue as () => unknown)());
        } catch {
          value = undefined;
        }
        return value === undefined ? out : { ...out, default: value };
      }
      case 'ZodCatch':
      case 'ZodReadonly':
        return next(def.innerType);
      case 'ZodBranded':
        return next(def.type);
      case 'ZodEffects':
        return next(def.schema);
      case 'ZodPipeline': {
        // The first schema reads the input; when it takes anything, the second one says more.
        const first = next(def.in);
        return Object.keys(first).length === 0 ? next(def.out) : first;
      }
      case 'ZodLazy':
        return this.lazySchema(schema, depth);
      case 'ZodNaN':
        return notDescribed('NaN cannot be sent as JSON');
      default:
        return notDescribed(`Ironbooks does not know this kind of schema (${kind || 'unnamed'})`);
    }
  }

  private objectSchema(def: ZodDefLike, depth: number): JsonSchema {
    const shape = (typeof def.shape === 'function' ? (def.shape as () => unknown)() : def.shape) as Record<string, unknown>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape ?? {})) {
      properties[key] = this.convert(shape[key], depth + 1);
      if (!this.acceptsMissing(shape[key])) required.push(key);
    }
    const out: JsonSchema = { type: 'object', properties };
    if (required.length) out.required = required;
    const catchall = def.catchall;
    if (isZod(catchall) && typeNameOf(catchall) !== 'ZodNever') {
      out.additionalProperties = this.convert(catchall, depth + 1);
    } else if (def.unknownKeys === 'strict') {
      out.additionalProperties = false;
    } else if (def.unknownKeys === 'passthrough') {
      out.additionalProperties = true;
    }
    // 'strip' (the default): other keys are dropped by zod, but a route may still read one by
    // hand, so nothing is said about them.
    return out;
  }

  /**
   * A z.lazy is described inline, unless it refers back to itself: then it goes to $defs once and
   * every use (the inner ones included) is a $ref to it.
   */
  private lazySchema(schema: ZodLike, depth: number): JsonSchema {
    const named = this.lazyNames.get(schema);
    if (named) return { $ref: `#/$defs/${named}` };
    if (this.open.has(schema)) {
      const name = `Recursive${this.lazyNames.size + 1}`;
      this.lazyNames.set(schema, name);
      return { $ref: `#/$defs/${name}` };
    }
    this.open.add(schema);
    let inner: JsonSchema;
    try {
      inner = this.convert((schema._def.getter as () => unknown)(), depth + 1);
    } finally {
      this.open.delete(schema);
    }
    const name = this.lazyNames.get(schema);
    if (!name) return inner;
    this.defs[name] = inner;
    return { $ref: `#/$defs/${name}` };
  }
}

function stringSchema(def: ZodDefLike): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  /** A second format or pattern: JSON Schema has room for one of each per level, so the rest go to allOf. */
  const more: JsonSchema[] = [];
  const once = (keyword: 'format' | 'pattern', value: string) => {
    if (out[keyword] === undefined) out[keyword] = value;
    else if (out[keyword] !== value) more.push({ [keyword]: value });
  };
  /** A regex whose flags could not be written into a pattern: said in words instead. */
  let unwritten = false;
  for (const c of checksOf(def)) {
    const kind = typeof c.kind === 'string' ? c.kind : '';
    const n = typeof c.value === 'number' ? c.value : null;
    const text = typeof c.value === 'string' ? c.value : null;
    if (kind === 'min' && n != null) out.minLength = Math.max(n, (out.minLength as number | undefined) ?? 0);
    else if (kind === 'max' && n != null) out.maxLength = Math.min(n, (out.maxLength as number | undefined) ?? n);
    else if (kind === 'length' && n != null) {
      out.minLength = n;
      out.maxLength = n;
    } else if (kind === 'time') once('pattern', `^${timePattern(c.precision)}$`);
    else if (kind === 'datetime' && c.local === true) once('pattern', localDateTimePattern(c));
    // A datetime with an offset (or "Z") is RFC 3339's date-time, the word a reader knows a
    // timestamp by. zod also takes one without seconds or with "+0200"; in draft 2020-12 a format
    // is a note for the reader unless a validator is told to check it. (No app schema uses one yet.)
    else if (STRING_FORMATS[kind]) once('format', STRING_FORMATS[kind]);
    else if (STRING_PATTERNS[kind]) once('pattern', STRING_PATTERNS[kind]);
    else if (kind === 'ip') {
      if (c.version === 'v4') once('format', 'ipv4');
      else if (c.version === 'v6') once('format', 'ipv6');
      else more.push({ anyOf: [{ format: 'ipv4' }, { format: 'ipv6' }] });
    } else if (kind === 'regex' && c.regex instanceof RegExp) {
      const pattern = patternWithFlags(c.regex);
      if (pattern !== null) once('pattern', pattern);
      else unwritten = true;
    } else if (kind === 'startsWith' && text != null) once('pattern', `^${escapeRegex(text)}`);
    else if (kind === 'endsWith' && text != null) once('pattern', `${escapeRegex(text)}$`);
    else if (kind === 'includes' && text != null) once('pattern', escapeRegex(text));
    // trim, toLowerCase, toUpperCase change the value rather than limit it; emoji, cidr and jwt have
    // no JSON Schema word: the route still checks them.
  }
  if (more.length) out.allOf = more;
  if (unwritten) {
    out.description = 'This text must also match a pattern that cannot be written here. The app checks it when the operation runs.';
  }
  return out;
}

function numberSchema(def: ZodDefLike): JsonSchema {
  const out: JsonSchema = { type: 'number' };
  for (const c of checksOf(def)) {
    const v = typeof c.value === 'number' ? c.value : null;
    if (c.kind === 'int') out.type = 'integer';
    else if (c.kind === 'multipleOf' && v != null) out.multipleOf = v;
    else if (c.kind === 'min' && v != null) {
      const key = c.inclusive === false ? 'exclusiveMinimum' : 'minimum';
      out[key] = Math.max(v, (out[key] as number | undefined) ?? -Infinity);
    } else if (c.kind === 'max' && v != null) {
      const key = c.inclusive === false ? 'exclusiveMaximum' : 'maximum';
      out[key] = Math.min(v, (out[key] as number | undefined) ?? Infinity);
    }
    // finite: JSON numbers always are.
  }
  return out;
}

function bigintSchema(def: ZodDefLike): JsonSchema {
  const out: JsonSchema = { type: 'integer', format: 'int64' };
  for (const c of checksOf(def)) {
    if (typeof c.value !== 'bigint') continue;
    const v = Number(c.value);
    if (c.kind === 'multipleOf') out.multipleOf = v;
    else if (c.kind === 'min') out[c.inclusive === false ? 'exclusiveMinimum' : 'minimum'] = v;
    else if (c.kind === 'max') out[c.inclusive === false ? 'exclusiveMaximum' : 'maximum'] = v;
  }
  return out;
}

/** The values of a TypeScript enum, without the reverse number-to-name entries (as zod reads it). */
function nativeEnumSchema(values: unknown): JsonSchema {
  if (typeof values !== 'object' || values === null) return notDescribed('the list of allowed values is missing');
  const obj = values as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => typeof obj[obj[k] as string] !== 'number');
  const list = keys.map((k) => obj[k]).filter((v) => typeof v === 'string' || typeof v === 'number');
  const types = [...new Set(list.map((v) => (typeof v === 'number' ? 'number' : 'string')))];
  return { type: types.length === 1 ? types[0] : types, enum: list };
}

/**
 * A union: a list of types when every option is a bare type ("text or a number"), one enum when
 * every option is one plain value, otherwise anyOf.
 */
function unionSchema(options: JsonSchema[]): JsonSchema {
  if (options.length === 0) return { not: {} };
  if (options.every((o) => isPlainType(o.type) && Object.keys(o).length === 1)) {
    const types = [...new Set(options.map((o) => o.type as string))];
    return { type: types.length === 1 ? types[0] : types };
  }
  const constOnly = options.every(
    (o) => 'const' in o && isPlainType(o.type) && Object.keys(o).every((k) => k === 'type' || k === 'const'),
  );
  if (constOnly) {
    const types = [...new Set(options.map((o) => o.type as string))];
    // An integer and a fraction are both numbers.
    const merged = types.length > 1 && types.every((t) => t === 'integer' || t === 'number') ? ['number'] : types;
    return { type: merged.length === 1 ? merged[0] : merged, enum: options.map((o) => o.const) };
  }
  const out: JsonSchema = { anyOf: options };
  // Every option is an object: say so at the top too, so a reader sees "an object, one of these".
  if (options.every((o) => o.type === 'object')) out.type = 'object';
  return out;
}

/** What a record's key schema adds beyond "a string", or null when it adds nothing. */
function propertyNames(key: JsonSchema): JsonSchema | null {
  const rest = { ...key };
  if (rest.type === 'string') delete rest.type;
  if (Object.keys(rest).length === 0) return null;
  if (rest.type !== undefined) return null; // number or symbol keys: object keys are text in JSON anyway
  return rest;
}

/**
 * JSON Schema (draft 2020-12) of a zod v3 schema, as a caller would send it. Never throws: an input
 * that is not a zod schema, or a part it cannot read, is described as accepting anything, with a
 * description saying why.
 */
export function zodToJsonSchema(schema: unknown, opts: ZodToJsonSchemaOptions = {}): JsonSchema {
  const head: JsonSchema = opts.$schema === false ? {} : { $schema: JSON_SCHEMA_DRAFT };
  try {
    const converter = new Converter(opts.maxDepth ?? 64);
    const body = converter.convert(schema, 0);
    const out: JsonSchema = { ...head, ...body };
    if (Object.keys(converter.defs).length) out.$defs = converter.defs;
    return out;
  } catch {
    return { ...head, ...notDescribed('Ironbooks could not read this schema') };
  }
}

/** Whether an object field with this schema may be left out by a caller. */
export function zodAcceptsMissing(schema: unknown): boolean {
  try {
    return new Converter(64).acceptsMissing(schema);
  } catch {
    return false;
  }
}
