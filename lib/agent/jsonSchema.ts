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
 *  - a pattern or format is never stricter than the route. A JSON Schema pattern has no flags and
 *    a validator reads it in unicode mode, so a regex's flags are written into the pattern itself
 *    (/^[a-f]+$/i becomes ^[a-fA-F]+$) where that can be done exactly, and where it cannot the
 *    pattern is left out and the description says so. A regex without u counts an emoji as two
 *    characters where a validator counts one, so a pattern that could refuse one the route takes
 *    (`/^..$/`, `/^.{2}$/`) is left out the same way. zod's time and datetime take values JSON
 *    Schema's "time" and "date-time" refuse (no seconds, no offset, "+0200"), so they are written
 *    as zod's own patterns, not as formats;
 *  - lengths are zod's own: zod counts UTF-16 units and a validator characters, so for text with
 *    an emoji in it a minLength of 2 or more can be stricter than the route (one emoji alone meets
 *    zod's min(2), not minLength 2). maxLength can only be looser. Written as they are all the
 *    same: halving them would mislead about every other text;
 *  - an object that strips unknown keys (zod's default) says nothing about other keys: some routes
 *    read a field or two by hand next to the schema, so "no other keys" would be wrong there. A
 *    strict object says additionalProperties false, passthrough true, a catchall its schema.
 *
 * Every `.describe()` text becomes `description` at its own level; a note this module adds (a
 * pattern it could not write) is kept after it. A kind it does not know becomes {} with a
 * description saying so. It never throws: one odd field must not hide the whole body.
 *
 * Also here, for the tests and for operation examples: jsonSchemaProblems (is a schema a valid
 * draft 2020-12 schema, in the words it is written with) and jsonSchemaErrors (does a value meet a
 * schema). Both cover the keywords of draft 2020-12 a described schema can hold.
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

// ---------------------------------------------------------------------------
// Notes this module adds, kept next to the schema's own description
// ---------------------------------------------------------------------------

/**
 * A note this module adds to a schema ("a pattern that cannot be written here"). It is the
 * description while the schema has none of its own; when a `.describe()` text is set on top, the
 * note goes after that text instead of being lost. A symbol key: copied along by every `{ ...out }`
 * of a wrapper, and taken off before the schema leaves this module.
 */
const NOTE = Symbol('note');

type Noted = JsonSchema & { [NOTE]?: string };

/** Two texts as sentences one after the other ("Name on the card." + "This text must …"). */
function sentences(first: string, second: string): string {
  const a = first.trim();
  if (!a) return second;
  return `${a}${/[.!?:]$/.test(a) ? '' : '.'} ${second}`;
}

function withNote(schema: JsonSchema, note: string): JsonSchema {
  const own = typeof schema.description === 'string' ? schema.description : '';
  const out: Noted = { ...schema, description: sentences(own, note) };
  const before = (schema as Noted)[NOTE];
  out[NOTE] = before ? sentences(before, note) : note;
  return out;
}

/** Remove every NOTE marker (the notes are already in the descriptions). */
function dropNotes(node: unknown, seen = new Set<object>()): void {
  if (typeof node !== 'object' || node === null || seen.has(node)) return;
  seen.add(node);
  if (!Array.isArray(node)) delete (node as Noted)[NOTE];
  for (const child of Object.values(node)) dropNotes(child, seen);
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

// ---------------------------------------------------------------------------
// A regular expression with its flags written into it
// ---------------------------------------------------------------------------

interface RegexMode {
  ignoreCase: boolean;
  dotAll: boolean;
  multiline: boolean;
  /** The source is read in unicode mode (u or v): escapes are strict, characters are code points. */
  unicode: boolean;
  /** v: classes may nest and hold set operations. */
  sets: boolean;
  /** The source has a named group, so `\k<name>` is a back-reference even without u. */
  namedGroups: boolean;
}

/** Thrown inside the rewrite when a part cannot be written without flags, exactly or more loosely. */
class NotWritable extends Error {}

function notWritable(): never {
  throw new NotWritable();
}

const LINE_BREAK = '[\\n\\r\\u2028\\u2029]';

/** The other case of an ASCII letter, or null. */
function asciiOtherCase(cp: number): number | null {
  if (cp >= 0x41 && cp <= 0x5a) return cp + 0x20;
  if (cp >= 0x61 && cp <= 0x7a) return cp - 0x20;
  return null;
}

/**
 * The two characters outside ASCII that fold to an ASCII letter in unicode mode: the long s (U+017F)
 * to s and the Kelvin sign (U+212A) to k. Without u, the i flag never maps a character outside
 * ASCII to one inside it (ECMA-262 Canonicalize), so an ASCII letter matches exactly its two cases.
 */
const UNICODE_FOLDS: Readonly<Record<number, number>> = { 0x73: 0x17f, 0x6b: 0x212a };

/** Whether a character has another case (so an i flag would match more than it). */
function hasCase(cp: number): boolean {
  const ch = String.fromCodePoint(cp);
  return ch.toLowerCase() !== ch || ch.toUpperCase() !== ch;
}

/** What an i flag matches for one character besides itself. Throws for a letter outside ASCII. */
function caseMates(cp: number, mode: RegexMode): number[] {
  if (!mode.ignoreCase) return [];
  const other = asciiOtherCase(cp);
  if (other !== null) {
    const extra = mode.unicode ? UNICODE_FOLDS[Math.max(cp, other)] : undefined;
    return extra === undefined ? [other] : [other, extra];
  }
  // Folding outside ASCII has many special cases (σ ς Σ, ß, ǅ …): not guessed at.
  if (cp >= 0x80 && hasCase(cp)) notWritable();
  return [];
}

const hex = (cp: number, width: number) => cp.toString(16).padStart(width, '0');

/** Characters a reader cannot see or tell apart from a space: separators, controls, format marks. Built at run time (the project compiles for ES2017). */
const UNSEEN = new RegExp('[\\p{Z}\\p{C}]', 'u');

/**
 * One character as a pattern writes it (unicode mode): control characters, spaces other than " "
 * and invisible marks as escapes, syntax characters escaped, everything else as it is.
 */
function literal(cp: number, inClass: boolean): string {
  const named: Record<number, string> = { 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
  if (named[cp]) return named[cp];
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return `\\x${hex(cp, 2)}`;
  const ch = String.fromCodePoint(cp);
  // The two letters that fold to ASCII look like s and K: written out, so a reader sees them.
  if (cp === 0x17f || cp === 0x212a || (cp !== 0x20 && UNSEEN.test(ch))) return cp > 0xffff ? `\\u{${hex(cp, 1)}}` : `\\u${hex(cp, 4)}`;
  if ((inClass ? '\\]^-[' : '\\^$.*+?()[]{}|').includes(ch)) return `\\${ch}`;
  return ch;
}

type Escape =
  | { kind: 'char'; cp: number; raw: string; len: number }
  /** \d \D \s \S \w \W, and \p{…} \P{…} in unicode mode. */
  | { kind: 'set'; raw: string; len: number }
  /** \b \B outside a class. */
  | { kind: 'assert'; raw: string; len: number }
  | { kind: 'backref'; raw: string; len: number };

const CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
const SYNTAX_CHARACTERS = '^$\\.*+?()[]{}|/';

/** The escape that starts at `at` (a backslash), read as the source's own mode reads it. */
function readEscape(src: string, at: number, inClass: boolean, mode: RegexMode): Escape {
  const next = src[at + 1];
  if (next === undefined) notWritable();
  const char = (cp: number, len: number): Escape => ({ kind: 'char', cp, raw: src.slice(at, at + len), len });
  if (Object.hasOwn(CONTROL_ESCAPES, next)) return char(CONTROL_ESCAPES[next], 2);
  if ('dDsSwW'.includes(next)) return { kind: 'set', raw: src.slice(at, at + 2), len: 2 };
  if (next === 'b' || next === 'B') {
    if (!inClass) return { kind: 'assert', raw: src.slice(at, at + 2), len: 2 };
    if (next === 'b') return char(8, 2); // a backspace, inside a class
    if (mode.unicode) notWritable();
    return char(0x42, 2); // without u, the letter B
  }
  if (next === '0' && !/\d/.test(src[at + 2] ?? '')) return char(0, 2);
  if (/\d/.test(next)) {
    // A back-reference (or, without u and without that many groups, an old octal escape: a
    // validator in unicode mode refuses it, so the final check leaves the pattern out).
    if (inClass) notWritable();
    let n = 2;
    while (/\d/.test(src[at + n] ?? '')) n++;
    return { kind: 'backref', raw: src.slice(at, at + n), len: n };
  }
  if (next === 'k') {
    if (!mode.unicode && !mode.namedGroups) return char(0x6b, 2); // without u and named groups, the letter k
    const end = src.indexOf('>', at + 3);
    if (src[at + 2] !== '<' || end === -1 || inClass) notWritable();
    return { kind: 'backref', raw: src.slice(at, end + 1), len: end - at + 1 };
  }
  if (next === 'c') {
    const letter = src[at + 2] ?? '';
    if (/^[A-Za-z]$/.test(letter)) return char(letter.charCodeAt(0) % 32, 3);
    notWritable();
  }
  if (next === 'x') {
    const digits = src.slice(at + 2, at + 4);
    if (/^[0-9a-fA-F]{2}$/.test(digits)) return char(parseInt(digits, 16), 4);
    if (mode.unicode) notWritable();
    return char(0x78, 2);
  }
  if (next === 'u') {
    if (src[at + 2] === '{') {
      // Without u, \u{3} is "uuu": a validator in unicode mode would read a code point instead.
      if (!mode.unicode) notWritable();
      const end = src.indexOf('}', at + 3);
      const digits = end === -1 ? '' : src.slice(at + 3, end);
      if (!/^[0-9a-fA-F]+$/.test(digits)) notWritable();
      return char(parseInt(digits, 16), end - at + 1);
    }
    const digits = src.slice(at + 2, at + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      if (mode.unicode) notWritable();
      return char(0x75, 2);
    }
    const cp = parseInt(digits, 16);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      // A surrogate: in unicode mode a pair is one character, without it two.
      if (!mode.unicode || cp > 0xdbff) notWritable();
      const low = src.slice(at + 6, at + 8) === '\\u' ? src.slice(at + 8, at + 12) : '';
      const lo = /^[0-9a-fA-F]{4}$/.test(low) ? parseInt(low, 16) : -1;
      if (lo < 0xdc00 || lo > 0xdfff) notWritable();
      return char(0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00), 12);
    }
    return char(cp, 6);
  }
  if (next === 'p' || next === 'P') {
    if (!mode.unicode) return char(next.charCodeAt(0), 2); // without u, the letter itself
    const end = src.indexOf('}', at + 3);
    if (src[at + 2] !== '{' || end === -1) notWritable();
    return { kind: 'set', raw: src.slice(at, end + 1), len: end - at + 1 };
  }
  // An identity escape: the character itself. Unicode mode only allows it for syntax characters.
  const cp = src.codePointAt(at + 1)!;
  if (mode.unicode && !SYNTAX_CHARACTERS.includes(next) && !(inClass && next === '-')) notWritable();
  if (!mode.unicode && cp >= 0xd800 && cp <= 0xdfff) notWritable();
  return char(cp, 1 + (cp > 0xffff ? 2 : 1));
}

/** A character set with the cases an i flag adds: `a` as `[aA]`. */
function withMates(first: string, mates: number[]): string {
  return `[${first}${mates.map((m) => literal(m, true)).join('')}]`;
}

/** One escape outside a class. */
function emitEscape(e: Escape, mode: RegexMode): string {
  switch (e.kind) {
    case 'char': {
      const mates = caseMates(e.cp, mode);
      const self = mode.unicode ? e.raw : literal(e.cp, false);
      return mates.length ? withMates(mode.unicode ? e.raw : literal(e.cp, true), mates) : self;
    }
    case 'set':
      // With i in unicode mode, \w also takes ſ and the Kelvin sign, and \p{Lu} every cased letter.
      if (mode.ignoreCase && mode.unicode && /^\\[wWpP]/.test(e.raw)) notWritable();
      return e.raw;
    case 'assert':
      if (mode.ignoreCase && mode.unicode) notWritable(); // \b is built on \w
      return e.raw;
    case 'backref':
      // With i a back-reference matches the group's text in any case: no pattern says that.
      if (mode.ignoreCase) notWritable();
      return e.raw;
  }
}

type CharAtom = { kind: 'char'; cp: number; raw: string; escaped: boolean };
type ClassAtom = CharAtom | { kind: 'set'; raw: string };

/** \S \D \W: the class escapes that take any character but a few, half an emoji included (without u). */
const WIDE_SET = /^\\[SDW]$/;

/**
 * Reads one character class from `start` (its "["), and writes it with the flags applied. `wide`
 * says whether it takes almost any character (it is negated, or holds \S, \D or \W): without u
 * such a class also takes half of an emoji, which matters to the caller (see rewriteSource).
 */
function rewriteClass(
  src: string,
  start: number,
  mode: RegexMode,
  readChar: (at: number) => number,
): { text: string; end: number; wide: boolean } {
  let k = start + 1;
  let head = '[';
  const negated = src[k] === '^';
  let wide = negated;
  if (negated) {
    head += '^';
    k++;
  }
  const readAtom = (): ClassAtom => {
    if (src[k] === '\\') {
      const e = readEscape(src, k, true, mode);
      k += e.len;
      if (e.kind === 'char') return { kind: 'char', cp: e.cp, raw: e.raw, escaped: true };
      if (e.kind === 'set') {
        if (WIDE_SET.test(e.raw)) wide = true;
        return { kind: 'set', raw: e.raw };
      }
      return notWritable();
    }
    // v mode: a nested class or a set operation is not something this rewrite reads.
    if (mode.sets && (src[k] === '[' || src.startsWith('&&', k) || src.startsWith('--', k) || src.startsWith('\\q{', k))) notWritable();
    const cp = readChar(k);
    k += cp > 0xffff ? 2 : 1;
    return { kind: 'char', cp, raw: String.fromCodePoint(cp), escaped: false };
  };
  /** A character of the class as written: an escape kept as it is where unicode mode reads it the same. */
  const own = (a: CharAtom) => (a.escaped && mode.unicode ? a.raw : literal(a.cp, true));
  const atom = (a: ClassAtom): string => {
    if (a.kind === 'set') {
      if (mode.ignoreCase && mode.unicode && /^\\[wWpP]/.test(a.raw)) notWritable();
      return a.raw;
    }
    return own(a) + caseMates(a.cp, mode).map((m) => literal(m, true)).join('');
  };
  const parts: string[] = [];
  for (;;) {
    if (k >= src.length) notWritable(); // a class that never ends
    if (src[k] === ']') {
      k++;
      break;
    }
    const first = parts.length === 0;
    const a = readAtom();
    if (src[k] === '-' && k + 1 < src.length && src[k + 1] !== ']') {
      k++;
      const b = readAtom();
      if (a.kind === 'char' && b.kind === 'char') {
        // Without u a range over the surrogates (\x00-￿) takes both halves of an emoji, one
        // at a time; in unicode mode it takes no emoji at all. Not written, rather than stricter.
        if (!mode.unicode && !negated && a.cp <= 0xdfff && b.cp >= 0xd800) notWritable();
        parts.push(rangeText(a, b, own, mode));
        continue;
      }
      // Without u, a class escape at either end makes the dash a plain character.
      if (mode.unicode) notWritable();
      parts.push(atom(a), '\\-', atom(b));
      continue;
    }
    if (a.kind === 'char' && a.cp === 0x2d && !a.escaped) {
      // A plain dash at either end of the class stays plain; anywhere else it is escaped, so the
      // cases added next to it can never turn it into a range.
      parts.push(first || src[k] === ']' ? '-' : '\\-');
      continue;
    }
    parts.push(atom(a));
  }
  return { text: `${head}${parts.join('')}]`, end: k, wide };
}

/** A range in a class, with the other case's range beside it under i. */
function rangeText(a: CharAtom, b: CharAtom, own: (x: CharAtom) => string, mode: RegexMode): string {
  const lo = a.cp;
  const hi = b.cp;
  if (lo > hi) notWritable();
  const text = `${own(a)}-${own(b)}`;
  if (!mode.ignoreCase) return text;
  if (hi >= 0x80) {
    // Outside ASCII: only when no character in it has a case (punctuation, symbols, CJK …).
    if (hi - Math.max(lo, 0x80) > 0x10000) notWritable();
    for (let cp = Math.max(lo, 0x80); cp <= hi; cp++) if (hasCase(cp)) notWritable();
  }
  const added: Array<[number, number]> = [];
  const overlap = (from: number, to: number, shift: number) => {
    const x = Math.max(lo, from);
    const y = Math.min(hi, to);
    if (x <= y) added.push([x + shift, y + shift]);
  };
  overlap(0x41, 0x5a, 0x20); // A-Z: a-z beside it
  overlap(0x61, 0x7a, -0x20); // a-z: A-Z beside it
  const covers = (cp: number) => (lo <= cp && cp <= hi) || added.some(([x, y]) => x <= cp && cp <= y);
  const extra = mode.unicode ? [0x73, 0x6b].filter(covers).map((cp) => UNICODE_FOLDS[cp]) : [];
  return (
    text +
    added.map(([x, y]) => (x === y ? literal(x, true) : `${literal(x, true)}-${literal(y, true)}`)).join('') +
    extra.map((cp) => literal(cp, true)).join('')
  );
}

/** What a wide atom (or a group around it) has been repeated by so far. */
interface WideRepeats {
  /** How many quantifiers repeat it. */
  count: number;
  /** One of them has a highest count of 2 or more that is not "no limit" ({0,5}). */
  bounded: boolean;
}

/**
 * Watches a source written without u for what could make the pattern stricter than the route.
 *
 * Without u the route reads text as UTF-16 units and a validator reads the pattern as characters
 * (code points), so an emoji is two units to the route and one character to the validator. Only a
 * WIDE atom takes half of one: `.`, a negated class, `\S`, `\D`, `\W` or a class holding one of
 * those (every other atom of such a source takes neither half nor a whole emoji). A pattern that
 * holds exactly one wide atom is never stricter than the route as long as:
 *  - every quantifier around it lets it match once (`*`, `+`, `?`, `{0,n}`, `{1,n}`: not `{2}`,
 *    where the route takes one emoji as two characters and the validator does not), and, when two
 *    or more quantifiers are around it, each lets it repeat once or without limit;
 *  - it is not inside a lookaround, and the source has no back-reference;
 *  - a `\B` or a lookaround only ever looks at a whole character: the source is anchored at both
 *    ends (^…$ with no | at the top), so a match can neither start nor end inside an emoji.
 * Two wide atoms side by side (`..`, `.+.`, `[^a]\S`) can each take one half of an emoji that the
 * validator sees as one character, so with two or more the pattern is left out. Conservative: a
 * pattern left out is said in words, never wrong (the fuzz test in jsonSchema.test.ts holds it to that).
 */
class UnitWatch {
  private wide = 0;
  /** A quantifier around the wide atom makes it repeat ({2}), or two around it set a limit ({0,3} inside +). */
  private mustRepeat = false;
  private wideInLookaround = false;
  private looksAround = false;
  private backref = false;
  private topLevelOr = false;
  private endsWithDollar = false;
  /** Groups open at this point: whether each holds the wide atom (and what repeats it inside), and whether it is a lookaround. */
  private readonly groups: Array<{ wide: WideRepeats | null; lookaround: boolean }> = [{ wide: null, lookaround: false }];
  /** The atom a quantifier that follows would repeat, when it is (or holds) the wide atom. */
  private last: WideRepeats | null = null;

  constructor(private readonly src: string) {}

  /** An atom that takes one character (or one unit). */
  atom(wide: boolean): void {
    this.endsWithDollar = false;
    this.last = null;
    if (!wide) return;
    this.wide++;
    if (this.groups.some((g) => g.lookaround)) this.wideInLookaround = true;
    this.last = { count: 0, bounded: false };
    this.groups[this.groups.length - 1].wide = this.last;
  }

  /** An assertion (^, $, \b, \B): it takes nothing, and a quantifier cannot follow it. */
  assertion(kind: '^' | '$' | 'b' | 'B'): void {
    this.last = null;
    if (kind === 'B') this.looksAround = true;
    this.endsWithDollar = kind === '$' && this.groups.length === 1;
  }

  backReference(): void {
    this.backref = true;
    this.atom(false);
  }

  open(lookaround: boolean): void {
    if (lookaround) this.looksAround = true;
    this.groups.push({ wide: null, lookaround });
    this.last = null;
    this.endsWithDollar = false;
  }

  close(): void {
    if (this.groups.length < 2) notWritable(); // a ")" with no group open
    const g = this.groups.pop()!;
    if (g.wide) this.groups[this.groups.length - 1].wide = g.wide;
    this.last = g.wide;
    this.endsWithDollar = false;
  }

  or(): void {
    if (this.groups.length === 1) this.topLevelOr = true;
    this.last = null;
    this.endsWithDollar = false;
  }

  /** A quantifier on the atom before it; max null means no limit. */
  quantifier(min: number, max: number | null): void {
    this.endsWithDollar = false;
    const r = this.last;
    if (!r) return;
    r.count++;
    if (max !== null && max >= 2) r.bounded = true;
    if (min >= 2 || (r.count >= 2 && r.bounded)) this.mustRepeat = true;
  }

  /** Throws NotWritable when the pattern could refuse text the route takes. */
  check(): void {
    if (this.wide === 0) return;
    const anchored = this.src.startsWith('^') && this.endsWithDollar && !this.topLevelOr;
    if (this.wide > 1 || this.mustRepeat || this.wideInLookaround || this.backref || (this.looksAround && !anchored)) notWritable();
  }
}

/** The source rewritten with the flags applied. Throws NotWritable. */
function rewriteSource(src: string, mode: RegexMode): string {
  const readChar = (at: number): number => {
    const cp = mode.unicode ? src.codePointAt(at)! : src.charCodeAt(at);
    // Without u a character outside the BMP is two units, with it one: a quantifier or a class
    // would mean something else to a validator in unicode mode.
    if (!mode.unicode && cp >= 0xd800 && cp <= 0xdfff) notWritable();
    return cp;
  };
  // Only a source without u counts units: one with u reads text as the validator does.
  const watch = new UnitWatch(src);
  let out = '';
  let k = 0;
  /** The token before was a quantifier: a "?" now only makes it lazy. */
  let quantified = false;
  while (k < src.length) {
    const ch = src[k];
    const afterQuantifier = quantified;
    quantified = false;
    if (ch === '\\') {
      const e = readEscape(src, k, false, mode);
      out += emitEscape(e, mode);
      k += e.len;
      if (e.kind === 'char') watch.atom(false);
      else if (e.kind === 'set') watch.atom(!mode.unicode && WIDE_SET.test(e.raw));
      else if (e.kind === 'assert') watch.assertion(e.raw[1] === 'B' ? 'B' : 'b');
      else watch.backReference();
      continue;
    }
    if (ch === '[') {
      const c = rewriteClass(src, k, mode, readChar);
      out += c.text;
      k = c.end;
      watch.atom(c.wide);
      continue;
    }
    if (ch === '(') {
      if (src[k + 1] !== '?') {
        out += ch;
        k++;
        watch.open(false);
        continue;
      }
      // (?: (?= (?! (?<= (?<! (?<name>: a group name has no case to fold. Anything else
      // (a modifier group such as (?i:…)) is not read here.
      const head = /^\(\?(?:<[A-Za-z_$][\w$]*>|<=|<!|[:=!])/.exec(src.slice(k));
      if (!head) notWritable();
      out += head[0];
      k += head[0].length;
      watch.open(/^\(\?(?:<=|<!|=|!)$/.test(head[0]));
      continue;
    }
    if (ch === '{') {
      const quantifier = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(k));
      if (quantifier) {
        out += quantifier[0];
        k += quantifier[0].length;
        const min = Number(quantifier[1]);
        watch.quantifier(min, !quantifier[2] ? min : quantifier[3] ? Number(quantifier[3]) : null);
        quantified = true;
        continue;
      }
      // Without u a brace that is not a quantifier is a plain character; unicode mode wants it escaped.
      if (mode.unicode) notWritable();
      out += '\\{';
      k++;
      watch.atom(false);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (mode.unicode) notWritable();
      out += `\\${ch}`;
      k++;
      watch.atom(false);
      continue;
    }
    if (ch === '.') {
      out += mode.dotAll ? '[\\s\\S]' : '.';
      watch.atom(true);
    } else if (ch === '^') {
      out += mode.multiline ? `(?:^|(?<=${LINE_BREAK}))` : '^';
      watch.assertion('^');
    } else if (ch === '$') {
      out += mode.multiline ? `(?:$|(?=${LINE_BREAK}))` : '$';
      watch.assertion('$');
    } else if (ch === '|') {
      out += ch;
      watch.or();
    } else if (ch === ')') {
      out += ch;
      watch.close();
    } else if (ch === '*' || ch === '+') {
      out += ch;
      watch.quantifier(ch === '+' ? 1 : 0, null);
      quantified = true;
    } else if (ch === '?') {
      out += ch;
      // After a quantifier it only makes that one lazy; else it repeats the atom zero or one time.
      if (!afterQuantifier) {
        watch.quantifier(0, 1);
        quantified = true;
      }
    } else {
      const cp = readChar(k);
      const mates = caseMates(cp, mode);
      out += mates.length ? withMates(literal(cp, true), mates) : literal(cp, false);
      k += cp > 0xffff ? 2 : 1;
      watch.atom(false);
      continue;
    }
    k++;
  }
  if (!mode.unicode) watch.check();
  return out;
}

/**
 * The source of a regular expression as a JSON Schema pattern: with its i, s and m flags written
 * into it (a pattern has no flags), in the syntax a validator's unicode mode reads (ECMA-262 with
 * u, as ajv and most validators compile patterns). Without this, /^[a-f]+$/i would read as lower
 * case only, stricter than the route.
 *
 * `i` turns each ASCII letter into both cases (`a` into `[aA]`, `a-f` in a class into `a-fA-F`, and
 * in unicode mode s and k also into ſ and the Kelvin sign, which fold to them). `s` turns `.` into
 * `[\s\S]`, `m` lets `^` and `$` match at a line break too. A source written without u has what
 * unicode mode refuses rewritten (`\-` as `-`, a lone `{` as `\{`).
 *
 * Null when the flags cannot be written into the pattern exactly: a letter outside ASCII, a
 * back-reference or `\w`, `\b`, `\p{…}` under i in unicode mode, a modifier group. Null too for a
 * source without u that could refuse an emoji the route takes, since the route counts it as two
 * characters and the validator as one (UnitWatch: `/^.{2}$/`, `/^..$/`). Then the pattern is left
 * out rather than wrong, and the description says so.
 */
export function patternWithFlags(regex: RegExp): string | null {
  const flags = regex.flags;
  const src = regex.source;
  const mode: RegexMode = {
    ignoreCase: flags.includes('i'),
    dotAll: flags.includes('s'),
    multiline: flags.includes('m'),
    unicode: flags.includes('u') || flags.includes('v'),
    sets: flags.includes('v'),
    namedGroups: /\(\?<(?![=!])/.test(src),
  };
  let out: string;
  if (mode.unicode && !mode.ignoreCase && !mode.dotAll && !mode.multiline) out = src;
  else {
    try {
      out = rewriteSource(src, mode);
    } catch {
      return null;
    }
  }
  try {
    new RegExp(out, 'u');
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/**
 * Formats of zod string checks that JSON Schema names the same thing, and that take what zod takes.
 * Not time and datetime (zod's take values without seconds or an offset, which "time" and
 * "date-time" refuse) and not duration (zod's takes a sign and a fraction): those are zod's own
 * patterns below.
 */
const STRING_FORMATS: Record<string, string> = {
  email: 'email',
  url: 'uri',
  uuid: 'uuid',
  date: 'date',
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
 * zod's datetime test (zod v3 datetimeRegex): "Z" (or nothing, with `local`), and with `offset`
 * also "+02:00" or "+0200". The date part is only its shape (zod also checks the day exists, and
 * still does when the operation runs): a pattern here may let through more than the route takes,
 * never less.
 */
function dateTimePattern(check: { precision?: unknown; offset?: unknown; local?: unknown }): string {
  const zones = [check.local === true ? 'Z?' : 'Z'];
  if (check.offset === true) zones.push('([+-]\\d{2}:?\\d{2})');
  return `^\\d{4}-\\d{2}-\\d{2}T${timePattern(check.precision)}(${zones.join('|')})$`;
}

/** zod v3's duration test (durationRegex), as it is: it takes a sign and fractions ISO 8601 durations do not. */
const DURATION_PATTERN =
  '^[-+]?P(?!$)(?:(?:[-+]?\\d+Y)|(?:[-+]?\\d+[.,]\\d+Y$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M$))?' +
  '(?:(?:[-+]?\\d+W)|(?:[-+]?\\d+[.,]\\d+W$))?(?:(?:[-+]?\\d+D)|(?:[-+]?\\d+[.,]\\d+D$))?' +
  '(?:T(?=[\\d+-])(?:(?:[-+]?\\d+H)|(?:[-+]?\\d+[.,]\\d+H$))?(?:(?:[-+]?\\d+M)|(?:[-+]?\\d+[.,]\\d+M$))?' +
  '(?:[-+]?\\d+(?:[.,]\\d+)?S)?)??$';

/**
 * Patterns for id formats JSON Schema has no format name for (zod's own tests, with their flags
 * written in). zod's cuid test (/^c[^\s-]{8,}$/i) has no u, so it counts an emoji as two: written
 * as it is for text without one, and with 4 characters at least where there is one (never stricter).
 */
const STRING_PATTERNS: Record<string, string> = {
  cuid: '^[cC](?:[^\\s-]{8,}|(?=[^\\s-]*[\\u{10000}-\\u{10ffff}])[^\\s-]{4,})$',
  cuid2: '^[0-9a-z]+$',
  ulid: '^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$',
  nanoid: '^[a-zA-Z0-9_-]{21}$',
  base64: '^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$',
  base64url: '^([0-9a-zA-Z_-]{4})*(([0-9a-zA-Z_-]{2}(==)?)|([0-9a-zA-Z_-]{3}(=)?))?$',
  duration: DURATION_PATTERN,
};

const UNWRITTEN_PATTERN_NOTE =
  'This text must also match a pattern that cannot be written here. The app checks it when the operation runs.';

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
    if (typeof text === 'string' && text.trim()) {
      // The schema's own words, with a note this module added (if any) kept after them.
      const note = (out as Noted)[NOTE];
      out = { ...out, description: note ? sentences(text, note) : text };
    }
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
        // JSON has no dates: a body sends text the route turns into a date. z.coerce.date() reads
        // anything a JavaScript Date does ("2026-05-01" too), which "date-time" would refuse.
        return def.coerce === true
          ? withNote({ type: 'string' }, 'A date such as 2026-05-01, or a date and time such as 2026-05-01T13:45:00Z.')
          : { type: 'string', format: 'date-time' };
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
        if (items.length === 0) delete out.prefixItems; // draft 2020-12: prefixItems is never empty
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
      // defineProperty: a field named "__proto__" stays a field.
      Object.defineProperty(properties, key, { value: this.convert(shape[key], depth + 1), enumerable: true, writable: true, configurable: true });
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

/** The same regular expression, case-insensitive. */
function caseInsensitive(regex: RegExp): RegExp {
  return regex.flags.includes('i') ? regex : new RegExp(regex.source, `${regex.flags}i`);
}

function stringSchema(def: ZodDefLike): JsonSchema {
  const out: JsonSchema = { type: 'string' };
  /** A second format or pattern: JSON Schema has room for one of each per level, so the rest go to allOf. */
  const more: JsonSchema[] = [];
  const once = (keyword: 'format' | 'pattern', value: string) => {
    if (out[keyword] === undefined) out[keyword] = value;
    else if (out[keyword] !== value) more.push({ [keyword]: value });
  };
  /** A pattern that could not be written: said in words instead. */
  let unwritten = false;
  const pattern = (regex: RegExp) => {
    const p = patternWithFlags(regex);
    if (p !== null) once('pattern', p);
    else unwritten = true;
  };
  /**
   * After toLowerCase / toUpperCase zod tests the changed text, so a sender may use either case:
   * a pattern that follows is written case-insensitive. (trim also runs first, but nobody sends
   * spaces around a value on purpose, so the limits stay as they are.)
   */
  let anyCase = false;
  for (const c of checksOf(def)) {
    const kind = typeof c.kind === 'string' ? c.kind : '';
    const n = typeof c.value === 'number' ? c.value : null;
    const text = typeof c.value === 'string' ? c.value : null;
    if (kind === 'min' && n != null) out.minLength = Math.max(n, (out.minLength as number | undefined) ?? 0);
    else if (kind === 'max' && n != null) out.maxLength = Math.min(n, (out.maxLength as number | undefined) ?? n);
    else if (kind === 'length' && n != null) {
      out.minLength = n;
      out.maxLength = n;
    } else if (kind === 'toLowerCase' || kind === 'toUpperCase') anyCase = true;
    else if (kind === 'time') once('pattern', `^${timePattern(c.precision)}$`);
    else if (kind === 'datetime') once('pattern', dateTimePattern(c));
    else if (Object.hasOwn(STRING_FORMATS, kind)) once('format', STRING_FORMATS[kind]);
    else if (Object.hasOwn(STRING_PATTERNS, kind)) once('pattern', STRING_PATTERNS[kind]);
    else if (kind === 'ip') {
      if (c.version === 'v4') once('format', 'ipv4');
      else if (c.version === 'v6') once('format', 'ipv6');
      else more.push({ anyOf: [{ format: 'ipv4' }, { format: 'ipv6' }] });
    } else if (kind === 'regex' && c.regex instanceof RegExp) pattern(anyCase ? caseInsensitive(c.regex) : c.regex);
    else if (text != null && (kind === 'startsWith' || kind === 'endsWith' || kind === 'includes')) {
      const source = `${kind === 'startsWith' ? '^' : ''}${escapeRegex(text)}${kind === 'endsWith' ? '$' : ''}`;
      if (anyCase) pattern(new RegExp(source, 'i'));
      else once('pattern', source);
    }
    // trim changes the value rather than limit it; emoji, cidr and jwt have no JSON Schema word:
    // the route still checks them.
  }
  if (more.length) out.allOf = more;
  return unwritten ? withNote(out, UNWRITTEN_PATTERN_NOTE) : out;
}

function numberSchema(def: ZodDefLike): JsonSchema {
  let out: JsonSchema = { type: 'number' };
  /** A fractional step, said in words. */
  let step: number | null = null;
  for (const c of checksOf(def)) {
    const v = typeof c.value === 'number' && Number.isFinite(c.value) ? c.value : null;
    if (c.kind === 'int') out.type = 'integer';
    else if (c.kind === 'multipleOf' && v != null && v > 0) {
      // A whole step only: 19.99 / 0.01 is 1998.9999999999998 in binary, so a validator would refuse
      // amounts zod takes (zod allows for the rounding).
      if (Number.isInteger(v)) out.multipleOf = v;
      else step = v;
    } else if (c.kind === 'min' && v != null) {
      const key = c.inclusive === false ? 'exclusiveMinimum' : 'minimum';
      out[key] = Math.max(v, (out[key] as number | undefined) ?? -Infinity);
    } else if (c.kind === 'max' && v != null) {
      const key = c.inclusive === false ? 'exclusiveMaximum' : 'maximum';
      out[key] = Math.min(v, (out[key] as number | undefined) ?? Infinity);
    }
    // finite: JSON numbers always are.
  }
  if (step !== null) out = withNote(out, `This number must be a multiple of ${step}.`);
  return out;
}

function bigintSchema(def: ZodDefLike): JsonSchema {
  const out: JsonSchema = { type: 'integer', format: 'int64' };
  for (const c of checksOf(def)) {
    if (typeof c.value !== 'bigint') continue;
    const v = Number(c.value);
    if (c.kind === 'multipleOf' && v > 0) out.multipleOf = v;
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
    dropNotes(out);
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

// ---------------------------------------------------------------------------
// Checking a schema, and checking a value against one
// ---------------------------------------------------------------------------

const TYPE_NAMES = ['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'];

type KeywordValue =
  | 'schema'
  | 'schemaMap'
  | 'patternSchemaMap'
  | 'schemaList'
  | 'count'
  | 'number'
  | 'positive'
  | 'string'
  | 'regex'
  | 'boolean'
  | 'names'
  | 'type'
  | 'list'
  | 'any'
  | 'ref'
  | 'dependentRequired'
  | 'vocabulary';

/** Every keyword of draft 2020-12 (core, applicator, validation, meta-data, format, content, unevaluated). */
const KEYWORDS: Readonly<Record<string, KeywordValue>> = {
  $schema: 'string',
  $id: 'string',
  $anchor: 'string',
  $dynamicAnchor: 'string',
  $ref: 'ref',
  $dynamicRef: 'string',
  $defs: 'schemaMap',
  $comment: 'string',
  $vocabulary: 'vocabulary',
  type: 'type',
  enum: 'list',
  const: 'any',
  properties: 'schemaMap',
  patternProperties: 'patternSchemaMap',
  additionalProperties: 'schema',
  propertyNames: 'schema',
  required: 'names',
  dependentRequired: 'dependentRequired',
  dependentSchemas: 'schemaMap',
  minProperties: 'count',
  maxProperties: 'count',
  unevaluatedProperties: 'schema',
  items: 'schema',
  prefixItems: 'schemaList',
  contains: 'schema',
  minContains: 'count',
  maxContains: 'count',
  minItems: 'count',
  maxItems: 'count',
  uniqueItems: 'boolean',
  unevaluatedItems: 'schema',
  minLength: 'count',
  maxLength: 'count',
  pattern: 'regex',
  format: 'string',
  contentEncoding: 'string',
  contentMediaType: 'string',
  contentSchema: 'schema',
  minimum: 'number',
  maximum: 'number',
  exclusiveMinimum: 'number',
  exclusiveMaximum: 'number',
  multipleOf: 'positive',
  allOf: 'schemaList',
  anyOf: 'schemaList',
  oneOf: 'schemaList',
  not: 'schema',
  if: 'schema',
  then: 'schema',
  else: 'schema',
  title: 'string',
  description: 'string',
  default: 'any',
  examples: 'list',
  deprecated: 'boolean',
  readOnly: 'boolean',
  writeOnly: 'boolean',
};

/** Pairs where the first above the second leaves no value that passes. */
const MIN_MAX: ReadonlyArray<[string, string]> = [
  ['minLength', 'maxLength'],
  ['minItems', 'maxItems'],
  ['minProperties', 'maxProperties'],
  ['minContains', 'maxContains'],
  ['minimum', 'maximum'],
];

const isObjectNode = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a value is plain JSON (what JSON.stringify writes back as it is). */
function jsonProblem(v: unknown, seen: Set<object>): string | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'a number that is not finite';
  if (typeof v !== 'object') return `a value of the kind "${typeof v}"`;
  if (seen.has(v)) return 'a value that contains itself';
  if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
    return 'an object that is not plain data';
  }
  seen.add(v);
  try {
    for (const child of Object.values(v)) {
      const p = jsonProblem(child, seen);
      if (p) return p;
    }
    return null;
  } finally {
    seen.delete(v);
  }
}

/** The schema a "#/a/b" reference names inside `root`, or undefined. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(node) && /^\d+$/.test(seg)) node = node[Number(seg)];
    else if (isObjectNode(node) && Object.hasOwn(node, seg)) node = node[seg];
    else return undefined;
  }
  return node;
}

/**
 * What is wrong with a JSON Schema as a draft 2020-12 schema, by path ("$.properties.amount: …").
 * Empty when it is valid. Stricter than the meta-schema in a few places, the way a strict validator
 * (ajv strict) is: a keyword draft 2020-12 does not have, a $schema below the root, a reference that
 * does not lead anywhere inside the schema, a value that is not plain JSON, and limits no value can
 * meet (minLength above maxLength) are all problems, since each one is a mistake in a described
 * schema, never an intent.
 */
export function jsonSchemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  const json = jsonProblem(schema, new Set());
  if (json) return [`$: the schema holds ${json}, which is not JSON`];
  const walk = (node: unknown, at: string) => {
    if (typeof node === 'boolean') return;
    if (!isObjectNode(node)) {
      problems.push(`${at}: a schema must be an object or true / false`);
      return;
    }
    for (const [keyword, value] of Object.entries(node)) {
      const kind = Object.hasOwn(KEYWORDS, keyword) ? KEYWORDS[keyword] : undefined;
      const here = `${at}.${keyword}`;
      if (!kind) {
        problems.push(`${here}: not a keyword of JSON Schema draft 2020-12`);
        continue;
      }
      switch (kind) {
        case 'schema':
          walk(value, here);
          break;
        case 'schemaMap':
        case 'patternSchemaMap':
          if (!isObjectNode(value)) problems.push(`${here}: must be an object of schemas`);
          else
            for (const [name, sub] of Object.entries(value)) {
              if (kind === 'patternSchemaMap') {
                try {
                  new RegExp(name, 'u');
                } catch {
                  problems.push(`${here}: "${name}" is not a valid regular expression`);
                }
              }
              walk(sub, `${here}.${name}`);
            }
          break;
        case 'schemaList':
          if (!Array.isArray(value) || value.length === 0) problems.push(`${here}: must be a list of at least one schema`);
          else value.forEach((sub, i) => walk(sub, `${here}[${i}]`));
          break;
        case 'count':
          if (!Number.isInteger(value) || (value as number) < 0) problems.push(`${here}: must be a whole number, 0 or more`);
          break;
        case 'number':
          if (typeof value !== 'number') problems.push(`${here}: must be a number`);
          break;
        case 'positive':
          if (typeof value !== 'number' || value <= 0) problems.push(`${here}: must be a number above 0`);
          break;
        case 'string':
          if (typeof value !== 'string') problems.push(`${here}: must be text`);
          else if (keyword === '$schema' && at !== '$') problems.push(`${here}: $schema belongs on the root only`);
          break;
        case 'regex':
          if (typeof value !== 'string') problems.push(`${here}: must be text`);
          else
            try {
              new RegExp(value, 'u');
            } catch {
              problems.push(`${here}: "${value}" is not a valid regular expression in unicode mode`);
            }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') problems.push(`${here}: must be true or false`);
          break;
        case 'names':
          if (!Array.isArray(value) || value.some((v) => typeof v !== 'string') || new Set(value).size !== value.length) {
            problems.push(`${here}: must be a list of different field names`);
          }
          break;
        case 'type': {
          const list = Array.isArray(value) ? value : [value];
          if (list.length === 0 || list.some((t) => !TYPE_NAMES.includes(t as string)) || new Set(list).size !== list.length) {
            problems.push(`${here}: must be one of ${TYPE_NAMES.join(', ')}, or a list of different ones`);
          }
          break;
        }
        case 'list':
          if (!Array.isArray(value)) problems.push(`${here}: must be a list`);
          else if (keyword === 'enum' && value.length === 0) problems.push(`${here}: an empty list lets no value through`);
          else if (keyword === 'enum' && new Set(value.map(canonicalJson)).size !== value.length) problems.push(`${here}: lists a value twice`);
          break;
        case 'ref':
          if (typeof value !== 'string') problems.push(`${here}: must be text`);
          else if (resolvePointer(schema, value) === undefined) problems.push(`${here}: "${value}" does not lead to a schema inside this one`);
          break;
        case 'dependentRequired':
          if (!isObjectNode(value) || Object.values(value).some((v) => !Array.isArray(v) || v.some((n) => typeof n !== 'string'))) {
            problems.push(`${here}: must be an object of field-name lists`);
          }
          break;
        case 'vocabulary':
          if (!isObjectNode(value) || Object.values(value).some((v) => typeof v !== 'boolean')) problems.push(`${here}: must be an object of true / false`);
          break;
        case 'any':
          break;
      }
    }
    for (const [min, max] of MIN_MAX) {
      if (typeof node[min] === 'number' && typeof node[max] === 'number' && (node[min] as number) > (node[max] as number)) {
        problems.push(`${at}: ${min} is above ${max}, so no value passes`);
      }
    }
  };
  walk(schema, '$');
  return problems;
}

/** JSON text with object keys in order: two equal values give the same text. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObjectNode(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The formats a described schema uses, checked the way RFC 3339 and the other standards write them. */
const FORMAT_TESTS: Readonly<Record<string, (s: string) => boolean>> = {
  date: (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return !!m && validDate(+m[1], +m[2], +m[3]);
  },
  'date-time': (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/.exec(s);
    return !!m && validDate(+m[1], +m[2], +m[3]);
  },
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  uri: (s) => {
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return false;
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  },
  ipv4: (s) => /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(s),
  ipv6: (s) => s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s),
};

/** "1 item", "2 items". */
function counted(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface JsonSchemaErrorsOptions {
  /** Check the formats it knows (date, date-time, email, uuid, uri, ipv4, ipv6). Default true. */
  formats?: boolean;
}

/**
 * What keeps `value` from meeting `schema` (draft 2020-12), by path ("$.lines[0].amount: must be a
 * number"). Empty when it meets it. Follows "#/…" references inside the schema; a reference that
 * leads nowhere, or one followed more than 64 deep, is an error rather than a pass.
 */
export function jsonSchemaErrors(schema: unknown, value: unknown, opts: JsonSchemaErrorsOptions = {}): string[] {
  const formats = opts.formats !== false;
  const check = (node: unknown, v: unknown, at: string, depth: number): string[] => {
    if (node === true) return [];
    if (node === false) return [`${at}: no value is allowed here`];
    if (!isObjectNode(node)) return [];
    if (depth > 64) return [`${at}: the schema refers to itself too deeply to check`];
    const errors: string[] = [];
    const add = (msg: string) => errors.push(`${at}: ${msg}`);

    if (typeof node.$ref === 'string') {
      const target = resolvePointer(schema, node.$ref);
      if (target === undefined) add(`the schema refers to "${node.$ref}", which is not in it`);
      else errors.push(...check(target, v, at, depth + 1));
    }
    if (node.type !== undefined) {
      const types = (Array.isArray(node.type) ? node.type : [node.type]) as string[];
      const actual = jsonTypeOf(v);
      const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
      if (!ok) {
        add(`must be ${types.join(' or ')}${v === undefined ? ', and is missing' : ''}`);
        return errors;
      }
    }
    if (Array.isArray(node.enum) && !node.enum.some((e) => canonicalJson(e) === canonicalJson(v))) {
      add(`must be one of ${node.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    }
    if ('const' in node && canonicalJson(node.const) !== canonicalJson(v)) add(`must be ${JSON.stringify(node.const)}`);

    if (typeof v === 'string') {
      const length = [...v].length;
      if (typeof node.minLength === 'number' && length < node.minLength) add(`must be at least ${counted(node.minLength, 'character')}`);
      if (typeof node.maxLength === 'number' && length > node.maxLength) add(`must be at most ${counted(node.maxLength, 'character')}`);
      if (typeof node.pattern === 'string') {
        let re: RegExp | null = null;
        try {
          re = new RegExp(node.pattern, 'u');
        } catch {
          add(`the schema's pattern "${node.pattern}" is not valid`);
        }
        if (re && !re.test(v)) add(`must match ${node.pattern}`);
      }
      if (formats && typeof node.format === 'string' && Object.hasOwn(FORMAT_TESTS, node.format) && !FORMAT_TESTS[node.format](v)) {
        add(`must be in ${node.format} form`);
      }
    }
    if (typeof v === 'number') {
      if (typeof node.minimum === 'number' && v < node.minimum) add(`must be at least ${node.minimum}`);
      if (typeof node.maximum === 'number' && v > node.maximum) add(`must be at most ${node.maximum}`);
      if (typeof node.exclusiveMinimum === 'number' && v <= node.exclusiveMinimum) add(`must be above ${node.exclusiveMinimum}`);
      if (typeof node.exclusiveMaximum === 'number' && v >= node.exclusiveMaximum) add(`must be below ${node.exclusiveMaximum}`);
      if (typeof node.multipleOf === 'number' && node.multipleOf > 0) {
        const q = v / node.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-9) add(`must be a multiple of ${node.multipleOf}`);
      }
    }
    if (Array.isArray(v)) {
      const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : [];
      prefix.forEach((sub, i) => {
        if (i < v.length) errors.push(...check(sub, v[i], `${at}[${i}]`, depth + 1));
      });
      if (node.items !== undefined) {
        for (let i = prefix.length; i < v.length; i++) errors.push(...check(node.items, v[i], `${at}[${i}]`, depth + 1));
      }
      if (typeof node.minItems === 'number' && v.length < node.minItems) add(`must have at least ${counted(node.minItems, 'item')}`);
      if (typeof node.maxItems === 'number' && v.length > node.maxItems) add(`must have at most ${counted(node.maxItems, 'item')}`);
      if (node.uniqueItems === true && new Set(v.map(canonicalJson)).size !== v.length) add('must not list the same item twice');
      if (node.contains !== undefined) {
        const n = v.filter((x, i) => check(node.contains, x, `${at}[${i}]`, depth + 1).length === 0).length;
        const min = typeof node.minContains === 'number' ? node.minContains : 1;
        if (n < min) add(`must have at least ${counted(min, 'matching item')}`);
        if (typeof node.maxContains === 'number' && n > node.maxContains) add(`must have at most ${counted(node.maxContains, 'matching item')}`);
      }
    }
    if (isObjectNode(v)) {
      const props = isObjectNode(node.properties) ? node.properties : {};
      const patterns = isObjectNode(node.patternProperties) ? Object.entries(node.patternProperties) : [];
      for (const name of Array.isArray(node.required) ? (node.required as string[]) : []) {
        if (!Object.hasOwn(v, name)) add(`must have ${name}`);
      }
      for (const [k, x] of Object.entries(v)) {
        const where = `${at}.${k}`;
        let matched = false;
        if (Object.hasOwn(props, k)) {
          matched = true;
          errors.push(...check(props[k], x, where, depth + 1));
        }
        for (const [p, sub] of patterns) {
          let re: RegExp | null = null;
          try {
            re = new RegExp(p, 'u');
          } catch {
            /* reported by jsonSchemaProblems */
          }
          if (re?.test(k)) {
            matched = true;
            errors.push(...check(sub, x, where, depth + 1));
          }
        }
        if (!matched && node.additionalProperties !== undefined) {
          if (node.additionalProperties === false) add(`must not have ${k}`);
          else errors.push(...check(node.additionalProperties, x, where, depth + 1));
        }
        if (node.propertyNames !== undefined) errors.push(...check(node.propertyNames, k, `${where} (its name)`, depth + 1));
      }
      const count = Object.keys(v).length;
      if (typeof node.minProperties === 'number' && count < node.minProperties) add(`must have at least ${counted(node.minProperties, 'field')}`);
      if (typeof node.maxProperties === 'number' && count > node.maxProperties) add(`must have at most ${counted(node.maxProperties, 'field')}`);
      if (isObjectNode(node.dependentRequired)) {
        for (const [k, needs] of Object.entries(node.dependentRequired)) {
          if (!Object.hasOwn(v, k) || !Array.isArray(needs)) continue;
          for (const n of needs) if (typeof n === 'string' && !Object.hasOwn(v, n)) add(`must have ${n} when it has ${k}`);
        }
      }
    }
    if (Array.isArray(node.allOf)) for (const sub of node.allOf) errors.push(...check(sub, v, at, depth + 1));
    if (Array.isArray(node.anyOf) && !node.anyOf.some((sub) => check(sub, v, at, depth + 1).length === 0)) {
      add(`must match one of ${node.anyOf.length} options; it matches none`);
    }
    if (Array.isArray(node.oneOf)) {
      const n = node.oneOf.filter((sub) => check(sub, v, at, depth + 1).length === 0).length;
      if (n !== 1) add(`must match exactly one of ${node.oneOf.length} options; it matches ${n}`);
    }
    if (node.not !== undefined && check(node.not, v, at, depth + 1).length === 0) add('must not match the schema in "not"');
    if (node.if !== undefined) {
      const branch = check(node.if, v, at, depth + 1).length === 0 ? node.then : node.else;
      if (branch !== undefined) errors.push(...check(branch, v, at, depth + 1));
    }
    return errors;
  };
  return check(schema, value, '$', 0);
}
