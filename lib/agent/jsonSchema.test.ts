/**
 * zod v3 -> JSON Schema (lib/agent/jsonSchema.ts): one case per zod kind the app's schemas use or
 * could use, plus the rules that hold across them (required fields, descriptions at every level,
 * recursion, never throwing, patterns never stricter than the route), and the two checks the
 * module also holds: is a schema valid draft 2020-12, and does a value meet one.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JSON_SCHEMA_DRAFT,
  jsonSchemaErrors,
  jsonSchemaProblems,
  patternWithFlags,
  zodAcceptsMissing,
  zodToJsonSchema,
  type JsonSchema,
} from './jsonSchema';

/**
 * ajv's draft 2020-12 validator, when it can be found (it comes in with electron-builder; it is not
 * a dependency of the app). The tests that use it are skipped without it.
 */
function loadAjv(): (new (opts: Record<string, unknown>) => {
  compile: (s: unknown) => ((v: unknown) => boolean) & { errors?: unknown };
  validateSchema: (s: unknown) => boolean;
  errors?: unknown;
}) | null {
  try {
    const mod = createRequire(import.meta.url)('ajv/dist/2020') as { default?: unknown };
    return (mod.default ?? mod) as never;
  } catch {
    return null;
  }
}
const Ajv2020 = loadAjv();

/** The schema without "$schema", for shorter expectations. */
const conv = (s: unknown) => zodToJsonSchema(s, { $schema: false });

/** A linked list whose `next` is the list again, or null: what `next` turns into. */
function nullableRef(): unknown {
  type Item = { next: Item | null };
  const item: z.ZodType<Item> = z.lazy(() => z.object({ next: item.nullable() }));
  const out = conv(z.object({ head: item }));
  const defs = out.$defs as Record<string, { properties: Record<string, unknown> }>;
  return defs.Recursive1.properties.next;
}

describe('zodToJsonSchema: the root', () => {
  it('names draft 2020-12 on the root, unless asked not to', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ $schema: JSON_SCHEMA_DRAFT, type: 'string' });
    expect(JSON_SCHEMA_DRAFT).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(conv(z.string())).toEqual({ type: 'string' });
  });

  it('never throws, and says so when it cannot describe something', () => {
    for (const odd of [undefined, null, 42, 'text', {}, { _def: null }, { _def: { typeName: 'ZodFromTheFuture' } }]) {
      const out = conv(odd);
      expect(Object.keys(out)).toEqual(['description']);
      expect(out.description).toMatch(/^Not described: /);
    }
    expect(conv({ _def: { typeName: 'ZodFromTheFuture' } }).description).toContain('ZodFromTheFuture');
    // A getter that throws, a shape that throws, a default that throws: that part only.
    const boom = () => {
      throw new Error('boom');
    };
    expect(conv(z.lazy(boom)).description).toMatch(/^Not described: /);
    const broken = z.object({ a: z.string() });
    (broken._def as unknown as { shape: () => never }).shape = boom;
    expect(conv(z.object({ ok: z.number(), broken })).properties).toEqual({
      ok: { type: 'number' },
      broken: { description: expect.stringMatching(/^Not described: .*ZodObject/) },
    });
    expect(conv(z.string().default(boom as () => string))).toEqual({ type: 'string' });
  });

  it('gives up on a branch nested deeper than maxDepth instead of running away', () => {
    let s: z.ZodTypeAny = z.string();
    for (let i = 0; i < 10; i++) s = z.array(s);
    const out = zodToJsonSchema(s, { $schema: false, maxDepth: 3 });
    const deep = ((out.items as Record<string, unknown>).items as Record<string, unknown>).items as Record<string, unknown>;
    expect(deep.items).toEqual({ description: expect.stringMatching(/nested too deeply/) });
  });
});

describe('zodToJsonSchema: each zod kind', () => {
  it('object: properties, required, and unknown keys by strip / strict / passthrough / catchall', () => {
    const shape = { name: z.string(), memo: z.string().optional(), qty: z.number().default(1) };
    expect(conv(z.object(shape))).toEqual({
      type: 'object',
      properties: { name: { type: 'string' }, memo: { type: 'string' }, qty: { type: 'number', default: 1 } },
      required: ['name'],
    });
    expect(conv(z.object(shape).strict()).additionalProperties).toBe(false);
    expect(conv(z.object(shape).passthrough()).additionalProperties).toBe(true);
    expect(conv(z.object(shape).catchall(z.boolean())).additionalProperties).toEqual({ type: 'boolean' });
    // Stripped keys: nothing said (a route may read a field by hand next to the schema).
    expect('additionalProperties' in conv(z.object(shape))).toBe(false);
    // No required list when nothing is required.
    expect(conv(z.object({ a: z.string().optional() }))).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    expect(conv(z.object({}))).toEqual({ type: 'object', properties: {} });
  });

  it('string: min, max, length', () => {
    expect(conv(z.string().min(2).max(40))).toEqual({ type: 'string', minLength: 2, maxLength: 40 });
    expect(conv(z.string().length(5))).toEqual({ type: 'string', minLength: 5, maxLength: 5 });
    expect(conv(z.string().nonempty())).toEqual({ type: 'string', minLength: 1 });
    expect(conv(z.string().min(1).min(3).max(9).max(4))).toEqual({ type: 'string', minLength: 3, maxLength: 4 });
  });

  it('string: email, url, uuid, date as formats', () => {
    expect(conv(z.string().email())).toEqual({ type: 'string', format: 'email' });
    expect(conv(z.string().url())).toEqual({ type: 'string', format: 'uri' });
    expect(conv(z.string().uuid())).toEqual({ type: 'string', format: 'uuid' });
    expect(conv(z.string().date())).toEqual({ type: 'string', format: 'date' });
    expect(conv(z.string().ip({ version: 'v4' }))).toEqual({ type: 'string', format: 'ipv4' });
    // A second format goes to allOf (one "format" per level).
    expect(conv(z.string().email().url())).toEqual({ type: 'string', format: 'email', allOf: [{ format: 'uri' }] });
  });

  it('string: regex, startsWith, endsWith, includes as patterns', () => {
    expect(conv(z.string().regex(/^\d{4}-\d{2}$/))).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}$' });
    expect(conv(z.string().startsWith('INV-'))).toEqual({ type: 'string', pattern: '^INV-' });
    expect(conv(z.string().endsWith('.pdf'))).toEqual({ type: 'string', pattern: '\\.pdf$' });
    const two = conv(z.string().regex(/^[A-Z]/).endsWith('(x)'));
    expect(two).toEqual({ type: 'string', pattern: '^[A-Z]', allOf: [{ pattern: '\\(x\\)$' }] });
    // Every pattern it writes is a valid regular expression in unicode mode.
    for (const p of [two.pattern, (two.allOf as Array<{ pattern: string }>)[0].pattern]) {
      expect(() => new RegExp(p as string, 'u')).not.toThrow();
    }
    expect(new RegExp((conv(z.string().includes('a-b.c')).pattern as string), 'u').test('xa-b.cx')).toBe(true);
  });

  it('string: time and every datetime are zod\'s own patterns, never stricter than zod', () => {
    // JSON Schema's "time" and "date-time" need seconds and an offset; zod's checks take values
    // without seconds, without an offset (local) and with "+0200" (offset): a format would refuse them.
    const cases: Array<[z.ZodString, string[], string[]]> = [
      [z.string().time(), ['13:45', '13:45:09', '13:45:09.123'], ['24:00', '13:45Z', '1:45']],
      [z.string().time({ precision: 3 }), ['13:45:09.123'], ['13:45', '13:45:09.12']],
      [z.string().datetime(), ['2026-05-01T13:45:09Z', '2026-05-01T13:45Z', '2026-05-01T13:45:09.5Z'], ['2026-05-01T13:45:09', '2026-05-01T13:45:09+02:00']],
      [z.string().datetime({ precision: 0 }), ['2026-05-01T13:45:09Z', '2026-05-01T13:45Z'], ['2026-05-01T13:45:09.5Z']],
      [z.string().datetime({ offset: true }), ['2026-05-01T13:45:09Z', '2026-05-01T13:45:09+02:00', '2026-05-01T13:45-0530'], ['2026-05-01T13:45:09']],
      [z.string().datetime({ local: true }), ['2026-05-01T13:45:09', '2026-05-01T13:45:09Z', '2026-05-01T13:45'], ['2026-05-01T13:45:09+02:00', '2026-05-01']],
      [z.string().datetime({ local: true, offset: true }), ['2026-05-01T13:45:09', '2026-05-01T13:45:09+02:00'], ['2026-05-01 13:45:09']],
    ];
    for (const [s, good, bad] of cases) {
      const out = conv(s);
      expect(out.format).toBeUndefined();
      const re = new RegExp(out.pattern as string, 'u');
      for (const v of good) {
        expect(s.safeParse(v).success, v).toBe(true);
        expect(re.test(v), `${out.pattern} on ${v}`).toBe(true);
      }
      for (const v of bad) {
        expect(s.safeParse(v).success, v).toBe(false);
        expect(re.test(v), `${out.pattern} on ${v}`).toBe(false);
      }
    }
  });

  it('string: the id and duration patterns take every case zod takes', () => {
    // zod's ulid and nanoid tests are case-insensitive; its duration takes a sign and a fraction.
    const cases: Array<[z.ZodString, string[]]> = [
      [z.string().ulid(), ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01arz3ndektsv4rrffq69g5fav']],
      [z.string().nanoid(), ['V1StGXR8_Z5jdHi6B-myT', 'v1stgxr8_z5jdhi6b-MYT']],
      [z.string().cuid(), ['cjld2cjxh0000qzrmn831i7rn', 'Cjld2cjxh0000qzrmn831i7rn']],
      [z.string().duration(), ['P3Y6M4DT12H30M5S', '-P1.5D', 'PT0.5S']],
    ];
    for (const [s, values] of cases) {
      const out = conv(s);
      expect(out.format).toBeUndefined();
      for (const v of values) {
        expect(s.safeParse(v).success, v).toBe(true);
        expect(new RegExp(out.pattern as string, 'u').test(v), `${out.pattern} on ${v}`).toBe(true);
      }
    }
  });

  it('string: a regex with flags has them written into the pattern', () => {
    // The app's own: an id of any case (lib/validation/reports.ts), a batch key (accountant.ts).
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const key = /^[a-z_]+:[0-9a-f-]{36}$/i;
    expect(conv(z.string().regex(uuid)).pattern).toBe(
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    );
    expect(conv(z.string().regex(key)).pattern).toBe('^[a-zA-Z_]+:[0-9a-fA-F-]{36}$');
    const id = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';
    expect(z.string().regex(uuid).safeParse(id).success).toBe(true);
    expect(new RegExp(conv(z.string().regex(uuid)).pattern as string, 'u').test(id)).toBe(true);

    // Letters outside a class; escapes, group names and lookarounds kept as they are.
    // new RegExp, not a literal: the project compiles for ES2017 (no group names or s flag in literals).
    const mixed = new RegExp('^inv-(?<num>\\d+)\\.(?:PDF|png)(?!x)\\D$', 'i');
    const p = conv(z.string().regex(mixed)).pattern as string;
    expect(p).toBe('^[iI][nN][vV]-(?<num>\\d+)\\.(?:[Pp][Dd][Ff]|[pP][nN][gG])(?![xX])\\D$');
    for (const v of ['INV-12.pdf!', 'inv-3.PnG?', 'Inv-0.PDF.']) {
      expect(mixed.test(v), v).toBe(true);
      expect(new RegExp(p, 'u').test(v), v).toBe(true);
    }
    expect(new RegExp(p, 'u').test('inv-3.pdfx')).toBe(false);

    // s: a dot takes a line break; m: ^ and $ also at a line break. Unflagged: the source as written.
    const dot = conv(z.string().regex(new RegExp('^a.b$', 's'))).pattern as string;
    expect(new RegExp(dot, 'u').test('a\nb')).toBe(true);
    const lines = conv(z.string().regex(/^ok$/m)).pattern as string;
    expect(new RegExp(lines, 'u').test('first\nok\nlast')).toBe(true);
    expect(new RegExp(lines, 'u').test('not ok')).toBe(false);
    expect(conv(z.string().regex(/^[A-Z]{2}$/)).pattern).toBe('^[A-Z]{2}$');

    // A rewrite that would not be a valid pattern: left out and said in words, never wrong.
    class Odd extends RegExp {
      get source() {
        return '[a';
      }
    }
    const odd = conv(z.string().min(1).regex(new Odd('a', 'i')));
    expect(odd.pattern).toBeUndefined();
    expect(odd.minLength).toBe(1);
    expect(odd.description).toMatch(/pattern that cannot be written here/);
  });

  it('string: a pattern written from flags matches exactly what the regex matches', () => {
    // Each regex against values it takes and values it does not: the pattern, read the way a
    // validator reads it (unicode mode), must answer the same for every one.
    const cases: Array<[RegExp, string[]]> = [
      [/^[a-f0-9]+$/i, ['abc', 'ABC', 'aF09', 'g', 'G', '']],
      [/^inv-\d+$/i, ['INV-12', 'inv-1', 'Inv-', 'xinv-1']],
      [/^[^a-c]$/i, ['a', 'A', 'C', 'd', 'D', '-']],
      [/^[A-z]$/i, ['[', '_', 'a', 'Z', '{', '@']],
      [/^[Z-a]$/i, ['Z', 'z', 'a', 'A', '_', 'b', 'Y']],
      [/^[a-z]+$/iu, ['abc', 'ABC', 'ſ', 'K', 'é']],
      [/^s$/iu, ['s', 'S', 'ſ', 't']],
      [/^k$/i, ['k', 'K', 'K']],
      [/^[a-c-e]$/i, ['b', 'B', '-', 'e', 'E', 'd']],
      [/^[\x41-\x43]$/i, ['a', 'C', 'd']],
      [/^\x41b$/i, ['Ab', 'aB', 'ab', 'AB', 'ac']],
      [/\bfoo\b/i, ['a foo b', 'FOO', 'foobar']],
      [/^(?:ab|cd)+$/i, ['ABcd', 'abCD', 'ac']],
      [/^[\d.]+$/i, ['1.2', 'a']],
      [new RegExp('a.b', 's'), ['a\nb', 'axb', 'ab']],
      [/^x$/m, ['x', 'a\nx', 'x\nb', 'ax']],
      [/^a$/im, ['A', 'b\nA', 'ab']],
      // Written without u: what unicode mode refuses is rewritten (\- outside a class, a lone brace).
      [new RegExp('^a\\-b{x}c]$'), ['a-b{x}c]', 'a-bc']],
      [new RegExp('^[_\\-.]+$'), ['_-.', 'a']],
      [new RegExp('^\\d{2,}$'), ['12', '1']],
    ];
    for (const [regex, values] of cases) {
      const p = patternWithFlags(regex);
      expect(p, String(regex)).not.toBeNull();
      const re = new RegExp(p!, 'u');
      for (const v of values) expect(re.test(v), `${p} on ${JSON.stringify(v)} (${regex})`).toBe(regex.test(v));
    }
    // s and k under iu take the two letters outside ASCII that fold to them, written out.
    expect(patternWithFlags(/^s$/iu)).toBe('^[sS\\u017f]$');
    expect(patternWithFlags(/^[a-z]$/iu)).toBe('^[a-zA-Z\\u017f\\u212a]$');
  });

  it('string: a flag that cannot be written exactly leaves the pattern out, and the description says so', () => {
    // A letter outside ASCII under i, a back-reference under i, \w, \b and \p{…} under iu, a
    // \u{…} without u (it means "uuu" there), an unfinished class.
    const unwritable = [
      new RegExp('^café$', 'i'),
      new RegExp('^(a)\\1$', 'i'),
      new RegExp('^\\w+$', 'iu'),
      new RegExp('\\bx', 'iu'),
      new RegExp('^\\p{Lu}$', 'iu'),
      new RegExp('^[\\u00c0-\\u00ff]$', 'i'),
      new RegExp('^\\u{3}$'),
    ];
    for (const regex of unwritable) {
      expect(patternWithFlags(regex), String(regex)).toBeNull();
      const out = conv(z.string().max(9).regex(regex));
      expect(out.pattern, String(regex)).toBeUndefined();
      expect(out.maxLength).toBe(9);
      expect(out.description).toBe('This text must also match a pattern that cannot be written here. The app checks it when the operation runs.');
    }
    // The same in a field with its own words: the note comes after them, and stays through wrappers.
    const field = z.string().regex(new RegExp('^café$', 'i')).describe('Name on the card');
    expect(conv(field).description).toBe('Name on the card. This text must also match a pattern that cannot be written here. The app checks it when the operation runs.');
    const wrapped = conv(z.object({ name: field.optional().describe('Name on the card, if any.') }));
    expect((wrapped.properties as Record<string, JsonSchema>).name.description).toBe(
      'Name on the card, if any. This text must also match a pattern that cannot be written here. The app checks it when the operation runs.',
    );
    // Without the i flag the same letters are written as they are; a non-ASCII range without case is fine under i.
    expect(patternWithFlags(new RegExp('^café$'))).toBe('^café$');
    expect(patternWithFlags(new RegExp('^[\\u2000-\\u206f]$', 'i'))).toBe('^[\\u2000-\\u206f]$');
  });

  /** An emoji: one character to a validator, two UTF-16 units to a regex without u. */
  const EMOJI = '\u{1F600}';

  it('string: without u, a pattern that could refuse an emoji the route takes is left out', () => {
    // Each regex (no u) takes the text, and the same source read in unicode mode, as a validator
    // reads a pattern, refuses it: written as it is, the pattern would be stricter than the route.
    const stricter: Array<[RegExp, string]> = [
      [/^.{2}$/, EMOJI],
      [/^..$/, EMOJI],
      [/^.+.$/, EMOJI],
      [/^[^a]{2,}$/, EMOJI],
      [/^\S{3}$/, `a${EMOJI}`],
      [/^(?:x?.){2}$/, EMOJI],
      [/^[\x00-￿]+$/, EMOJI],
      // A lookaround or \B where a match can start or end inside an emoji.
      [new RegExp('(?<!a)[^a]'), `a${EMOJI}`],
      [/\B\S$/, `x${EMOJI}`],
    ];
    for (const [regex, text] of stricter) {
      expect(regex.test(text), `${regex} takes it`).toBe(true);
      expect(new RegExp(regex.source, 'u').test(text), `${regex} read in unicode mode`).toBe(false);
      expect(patternWithFlags(regex), String(regex)).toBeNull();
      const out = conv(z.string().regex(regex));
      expect(out.pattern, String(regex)).toBeUndefined();
      expect(out.description).toMatch(/pattern that cannot be written here/);
    }
    // Left out to be safe, where the rule cannot be sure: the wide atom in a lookaround, a
    // back-reference beside it, two quantifiers around it with a limit of 2 or more.
    for (const regex of [new RegExp('^(?=.)a$'), /^(.)a\1$/, /^(?:.{0,3})+$/, /^[^@]+@[^@]+$/]) {
      expect(patternWithFlags(regex), String(regex)).toBeNull();
    }
    // With u the source already counts as the validator does: written as it is.
    expect(patternWithFlags(new RegExp('^.{2}$', 'u'))).toBe('^.{2}$');
  });

  it('string: without u, one wide atom that cannot split an emoji is still written, and takes all the route takes', () => {
    const written: Array<[RegExp, string]> = [
      // The app's own: a login without spaces.
      [/^\S+$/, '^\\S+$'],
      [/^.{0,3}$/, '^.{0,3}$'],
      [/^a.?b$/, '^a.?b$'],
      [/^(?:x?.)+$/, '^(?:x?.)+$'],
      [/^[^@]+@example\.com$/, '^[^@]+@example\\.com$'],
      [/x.y/, 'x.y'],
      [new RegExp('^inv-\\d+(?!x)\\D$', 'i'), '^[iI][nN][vV]-\\d+(?![xX])\\D$'],
    ];
    const texts = ['', 'a', 'ab', 'axb', 'x y', EMOJI, EMOJI + EMOJI, `a${EMOJI}`, `a${EMOJI}b`, `x${EMOJI}y`, `${EMOJI}@example.com`, `inv-1${EMOJI}`, 'INV-12!'];
    for (const [regex, pattern] of written) {
      expect(patternWithFlags(regex), String(regex)).toBe(pattern);
      const re = new RegExp(pattern, 'u');
      for (const t of texts) if (regex.test(t)) expect(re.test(t), `${pattern} on ${JSON.stringify(t)} (${regex})`).toBe(true);
    }
  });

  it('string: a pattern written from a regex without u never refuses text the regex takes (fuzz)', () => {
    // Small random regexes from the parts that differ between UTF-16 units and characters (wide
    // atoms, quantifiers, lookarounds, \B, anchors, |), against every short text of letters,
    // spaces, digits and an emoji. A written pattern must take every text its regex takes.
    let seed = 20261121;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T,>(list: readonly T[]): T => list[rand(list.length)];
    const ATOMS = ['.', 'a', 'x', '[^a]', '\\S', '\\D', '\\W', '[ax]', '\\d', '[\\s\\S]', '[a\\S]'];
    const QUANTIFIERS = ['', '', '', '?', '*', '+', '{2}', '{0,2}', '{1,2}', '{2,}', '{1,}', '*?', '{0,1}'];
    const AROUND = ['(?!a)', '(?=x)', '(?<!a)', '(?<=a)', '\\b', '\\B'];
    const sequence = (depth: number): string => {
      let s = '';
      for (let i = 0, n = 1 + rand(3); i < n; i++) {
        const r = rand(10);
        if (r < 6 || depth > 1) s += pick(ATOMS) + pick(QUANTIFIERS);
        else if (r < 8) s += `(?:${sequence(depth + 1)})${pick(QUANTIFIERS)}`;
        else s += pick(AROUND);
      }
      return s;
    };
    const letters = ['a', 'x', ' ', '1', EMOJI];
    const texts = [''];
    for (let len = 1; len <= 3; len++) {
      for (const t of texts.filter((x) => [...x].length === len - 1)) for (const l of letters) texts.push(t + l);
    }
    const wrong: string[] = [];
    let checked = 0;
    for (let i = 0; i < 2500; i++) {
      let src = sequence(0);
      if (rand(3) === 0) src = `${src}|${sequence(0)}`;
      if (rand(2) === 0) src = `^${src}`;
      if (rand(2) === 0) src = `${src}$`;
      const flags = pick(['', '', 'i', 's', 'm']);
      let regex: RegExp;
      try {
        regex = new RegExp(src, flags);
      } catch {
        continue;
      }
      const p = patternWithFlags(regex);
      if (p === null) continue;
      checked++;
      const re = new RegExp(p, 'u');
      for (const t of texts) if (regex.test(t) && !re.test(t)) wrong.push(`/${src}/${flags} as ${p} refuses ${JSON.stringify(t)}`);
    }
    expect(wrong.slice(0, 10)).toEqual([]);
    // Not empty: most of the random regexes are still written.
    expect(checked).toBeGreaterThan(500);
  });

  it('string: after toLowerCase or toUpperCase a pattern takes either case (zod tests the changed text)', () => {
    const lower = z.string().toLowerCase().regex(/^[a-z]+$/);
    const p = conv(lower).pattern as string;
    expect(lower.safeParse('ABC').success).toBe(true);
    expect(new RegExp(p, 'u').test('ABC')).toBe(true);
    const starts = z.string().toUpperCase().startsWith('INV-');
    expect(starts.safeParse('inv-1').success).toBe(true);
    expect(new RegExp(conv(starts).pattern as string, 'u').test('inv-1')).toBe(true);
    // Before the change, the case still counts.
    expect(conv(z.string().regex(/^[a-z]+$/).toLowerCase()).pattern).toBe('^[a-z]+$');
  });

  it('string: transforms that do not limit the value add nothing', () => {
    expect(conv(z.string().trim().toLowerCase())).toEqual({ type: 'string' });
  });

  it('number and int: min, max (inclusive or not), multipleOf', () => {
    expect(conv(z.number())).toEqual({ type: 'number' });
    expect(conv(z.number().int())).toEqual({ type: 'integer' });
    expect(conv(z.number().min(0).max(100))).toEqual({ type: 'number', minimum: 0, maximum: 100 });
    expect(conv(z.number().positive())).toEqual({ type: 'number', exclusiveMinimum: 0 });
    expect(conv(z.number().lt(10))).toEqual({ type: 'number', exclusiveMaximum: 10 });
    expect(conv(z.number().int().nonnegative().multipleOf(5))).toEqual({ type: 'integer', minimum: 0, multipleOf: 5 });
    // A fractional step in words: 19.99 / 0.01 is not a whole number in binary, so a validator
    // would refuse an amount zod takes.
    expect(z.number().multipleOf(0.01).safeParse(19.99).success).toBe(true);
    expect(conv(z.number().multipleOf(0.01).min(0))).toEqual({ type: 'number', minimum: 0, description: 'This number must be a multiple of 0.01.' });
    expect(conv(z.coerce.number().int().min(1))).toEqual({ type: 'integer', minimum: 1 });
  });

  it('bigint: an integer, limits as numbers', () => {
    // BigInt(), not 1n: the project compiles for ES2017.
    expect(conv(z.bigint().min(BigInt(1)).max(BigInt(9)))).toEqual({ type: 'integer', format: 'int64', minimum: 1, maximum: 9 });
  });

  it('boolean', () => {
    expect(conv(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('literal: each JSON kind', () => {
    expect(conv(z.literal('void'))).toEqual({ type: 'string', const: 'void' });
    expect(conv(z.literal(3))).toEqual({ type: 'integer', const: 3 });
    expect(conv(z.literal(2.5))).toEqual({ type: 'number', const: 2.5 });
    expect(conv(z.literal(true))).toEqual({ type: 'boolean', const: true });
    expect(conv(z.literal(null))).toEqual({ type: 'null' });
    expect(conv(z.literal(BigInt(7)))).toEqual({ type: 'integer', const: 7 });
  });

  it('enum', () => {
    expect(conv(z.enum(['draft', 'open', 'paid']))).toEqual({ type: 'string', enum: ['draft', 'open', 'paid'] });
  });

  it('nativeEnum: string, number and mixed enums, without the reverse entries', () => {
    enum Color {
      Red = 'red',
      Blue = 'blue',
    }
    enum Level {
      Low,
      High,
    }
    enum Mixed {
      A = 'a',
      B = 2,
    }
    expect(conv(z.nativeEnum(Color))).toEqual({ type: 'string', enum: ['red', 'blue'] });
    expect(conv(z.nativeEnum(Level))).toEqual({ type: 'number', enum: [0, 1] });
    expect(conv(z.nativeEnum(Mixed))).toEqual({ type: ['string', 'number'], enum: ['a', 2] });
    expect(conv(z.nativeEnum({ Yes: 'yes', No: 'no' } as const))).toEqual({ type: 'string', enum: ['yes', 'no'] });
  });

  it('array: items, min, max, length', () => {
    expect(conv(z.array(z.string()))).toEqual({ type: 'array', items: { type: 'string' } });
    expect(conv(z.array(z.number()).min(1).max(500))).toEqual({ type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 500 });
    expect(conv(z.array(z.boolean()).length(2))).toEqual({ type: 'array', items: { type: 'boolean' }, minItems: 2, maxItems: 2 });
    expect(conv(z.string().array().nonempty())).toEqual({ type: 'array', items: { type: 'string' }, minItems: 1 });
  });

  it('tuple: prefixItems, with and without a rest', () => {
    expect(conv(z.tuple([z.string(), z.number()]))).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      minItems: 2,
      items: false,
      maxItems: 2,
    });
    expect(conv(z.tuple([z.string()]).rest(z.boolean()))).toEqual({
      type: 'array',
      prefixItems: [{ type: 'string' }],
      minItems: 1,
      items: { type: 'boolean' },
    });
  });

  it('union: a list of types, one enum, or anyOf', () => {
    expect(conv(z.union([z.string(), z.number()]))).toEqual({ type: ['string', 'number'] });
    expect(conv(z.union([z.string(), z.string()]))).toEqual({ type: 'string' });
    expect(conv(z.union([z.string().min(1), z.number()]))).toEqual({ anyOf: [{ type: 'string', minLength: 1 }, { type: 'number' }] });
    expect(conv(z.union([z.literal('a'), z.literal('b')]))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(conv(z.union([z.literal(1), z.literal(1.5)]))).toEqual({ type: 'number', enum: [1, 1.5] });
    expect(conv(z.union([z.literal('a'), z.literal(1)]))).toEqual({ type: ['string', 'integer'], enum: ['a', 1] });
    // Every option an object: "an object, one of these".
    const objects = conv(z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]));
    expect(objects.type).toBe('object');
    expect(objects.anyOf).toHaveLength(2);
  });

  it('discriminatedUnion: anyOf of the options, an object at the top', () => {
    const s = z.discriminatedUnion('action', [
      z.object({ action: z.literal('void') }),
      z.object({ action: z.literal('apply'), amount: z.number() }),
    ]);
    expect(conv(s)).toEqual({
      type: 'object',
      anyOf: [
        { type: 'object', properties: { action: { type: 'string', const: 'void' } }, required: ['action'] },
        {
          type: 'object',
          properties: { action: { type: 'string', const: 'apply' }, amount: { type: 'number' } },
          required: ['action', 'amount'],
        },
      ],
    });
  });

  it('intersection: allOf', () => {
    const s = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number().optional() }));
    expect(conv(s)).toEqual({
      type: 'object',
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    });
    expect(conv(z.string().and(z.string().min(2)))).toEqual({ allOf: [{ type: 'string' }, { type: 'string', minLength: 2 }] });
  });

  it('optional: the inner schema, and not required', () => {
    expect(conv(z.string().optional())).toEqual({ type: 'string' });
    expect(zodAcceptsMissing(z.string().optional())).toBe(true);
    expect(zodAcceptsMissing(z.string())).toBe(false);
  });

  it('nullable: null added to the type, or anyOf where a type cannot say it', () => {
    expect(conv(z.string().nullable())).toEqual({ type: ['string', 'null'] });
    expect(conv(z.string().max(5).nullish())).toEqual({ type: ['string', 'null'], maxLength: 5 });
    expect(conv(z.enum(['a', 'b']).nullable())).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
    expect(conv(z.literal('x').nullable())).toEqual({ type: ['string', 'null'], enum: ['x', null] });
    expect(conv(z.union([z.string(), z.number()]).nullable())).toEqual({ type: ['string', 'number', 'null'] });
    // A union gets null as one more option, not a union inside a union.
    expect(conv(z.union([z.string().min(1), z.number()]).nullable())).toEqual({
      anyOf: [{ type: 'string', minLength: 1 }, { type: 'number' }, { type: 'null' }],
    });
    const objects = conv(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]).nullable());
    expect(objects.type).toEqual(['object', 'null']);
    expect(objects.anyOf).toEqual([
      { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      { type: 'null' },
    ]);
    // A $ref cannot take null into its type: wrapped.
    expect(nullableRef()).toEqual({ anyOf: [{ $ref: '#/$defs/Recursive1' }, { type: 'null' }] });
    expect(conv(z.null().nullable())).toEqual({ type: 'null' });
    expect(conv(z.unknown().nullable())).toEqual({});
    // nullable alone still has to be sent; nullish need not.
    expect(conv(z.object({ a: z.string().nullable(), b: z.string().nullish() })).required).toEqual(['a']);
  });

  it('default: the default value, and not required', () => {
    expect(conv(z.boolean().default(false))).toEqual({ type: 'boolean', default: false });
    expect(conv(z.array(z.string()).default([]))).toEqual({ type: 'array', items: { type: 'string' }, default: [] });
    expect(conv(z.date().default(new Date('2026-01-02T03:04:05Z')))).toEqual({
      type: 'string',
      format: 'date-time',
      default: '2026-01-02T03:04:05.000Z',
    });
    expect(conv(z.object({ a: z.number().default(2) })).required).toBeUndefined();
  });

  it('effects: refine, superRefine, transform and preprocess are described by the schema inside', () => {
    const inner = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
    const base = z.object({ a: z.number() });
    expect(conv(base.refine((v) => v.a > 0, 'Must be positive'))).toEqual(inner);
    expect(conv(base.superRefine(() => undefined))).toEqual(inner);
    expect(conv(base.transform((v) => v.a))).toEqual(inner);
    expect(conv(z.preprocess((v) => v, base))).toEqual(inner);
    // A preprocess that fills a missing value makes the field optional; one that does not, not.
    const filled = z.object({ tags: z.preprocess((v) => v ?? [], z.array(z.string())) });
    expect(conv(filled).required).toBeUndefined();
    const plain = z.object({ tags: z.preprocess((v) => v, z.array(z.string())) });
    expect(conv(plain).required).toEqual(['tags']);
    const throws = z.object({
      n: z.preprocess(() => {
        throw new Error('no');
      }, z.number()),
    });
    expect(conv(throws).required).toEqual(['n']);
  });

  it('record: additionalProperties, and the key schema as propertyNames', () => {
    expect(conv(z.record(z.number()))).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
    expect(conv(z.record(z.enum(['a', 'b']), z.string()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
      propertyNames: { enum: ['a', 'b'] },
    });
    expect(conv(z.record(z.string().uuid(), z.boolean())).propertyNames).toEqual({ format: 'uuid' });
  });

  it('map and set: best effort as arrays', () => {
    expect(conv(z.map(z.string(), z.number()))).toEqual({
      type: 'array',
      items: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2 },
    });
    expect(conv(z.set(z.string()).min(1).max(3))).toEqual({
      type: 'array',
      uniqueItems: true,
      items: { type: 'string' },
      minItems: 1,
      maxItems: 3,
    });
  });

  it('date: text in date-time form; a coerced date also takes a date alone, so no format', () => {
    expect(conv(z.date())).toEqual({ type: 'string', format: 'date-time' });
    expect(z.coerce.date().safeParse('2026-05-01').success).toBe(true);
    expect(conv(z.coerce.date())).toEqual({
      type: 'string',
      description: 'A date such as 2026-05-01, or a date and time such as 2026-05-01T13:45:00Z.',
    });
    expect(conv(z.coerce.date().describe('When it was paid'))).toEqual({
      type: 'string',
      description: 'When it was paid. A date such as 2026-05-01, or a date and time such as 2026-05-01T13:45:00Z.',
    });
  });

  it('any and unknown: anything', () => {
    expect(conv(z.any())).toEqual({});
    expect(conv(z.unknown())).toEqual({});
    expect(conv(z.object({ x: z.unknown() })).required).toBeUndefined();
  });

  it('null, undefined, void, never', () => {
    expect(conv(z.null())).toEqual({ type: 'null' });
    expect(conv(z.undefined())).toEqual({ not: {}, description: 'Leave this field out.' });
    expect(conv(z.void())).toEqual({ not: {}, description: 'Leave this field out.' });
    expect(conv(z.never())).toEqual({ not: {} });
  });

  it('lazy: inline when it does not refer to itself', () => {
    expect(conv(z.lazy(() => z.string().min(1)))).toEqual({ type: 'string', minLength: 1 });
  });

  it('lazy: a recursive schema goes to $defs once, with a $ref at every use', () => {
    interface Node {
      name: string;
      children?: Node[];
    }
    const node: z.ZodType<Node> = z.object({ name: z.string(), children: z.lazy(() => node.array()).optional() });
    const out = zodToJsonSchema(z.object({ root: node, also: z.lazy(() => node) }));
    expect(out).toEqual({
      $schema: JSON_SCHEMA_DRAFT,
      type: 'object',
      properties: {
        root: {
          type: 'object',
          properties: { name: { type: 'string' }, children: { $ref: '#/$defs/Recursive1' } },
          required: ['name'],
        },
        also: {
          type: 'object',
          properties: { name: { type: 'string' }, children: { $ref: '#/$defs/Recursive1' } },
          required: ['name'],
        },
      },
      required: ['root', 'also'],
      $defs: {
        Recursive1: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, children: { $ref: '#/$defs/Recursive1' } },
            required: ['name'],
          },
        },
      },
    });
    // The output is plain data: it survives a JSON round trip (no cycles).
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('lazy: a schema that is lazy at the root and refers to itself', () => {
    type Tree = { kids: Tree[] };
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ kids: z.array(tree) }));
    const out = zodToJsonSchema(tree);
    expect(out.$ref).toBe('#/$defs/Recursive1');
    expect(out.$defs).toEqual({
      Recursive1: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/$defs/Recursive1' } } }, required: ['kids'] },
    });
  });

  it('branded, catch, readonly: the inner schema', () => {
    expect(conv(z.string().uuid().brand<'Id'>())).toEqual({ type: 'string', format: 'uuid' });
    expect(conv(z.number().catch(0))).toEqual({ type: 'number' });
    expect(zodAcceptsMissing(z.number().catch(0))).toBe(true);
    expect(conv(z.array(z.string()).readonly())).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('pipeline: the first schema, or the second when the first takes anything', () => {
    expect(conv(z.string().pipe(z.coerce.number()))).toEqual({ type: 'string' });
    expect(conv(z.unknown().pipe(z.number().int()))).toEqual({ type: 'integer' });
    expect(zodAcceptsMissing(z.string().optional().pipe(z.string().optional()))).toBe(true);
  });

  it('kinds JSON cannot carry: described as not described, never thrown', () => {
    for (const s of [z.nan(), z.symbol(), z.function(), z.promise(z.string())]) {
      const out = conv(s);
      expect(Object.keys(out)).toEqual(['description']);
      expect(out.description).toMatch(/^Not described: /);
    }
  });
});

describe('zodToJsonSchema: descriptions', () => {
  it('puts each .describe() text at its own level', () => {
    const s = z
      .object({
        customerId: z.string().uuid().describe('The customer the invoice is for'),
        memo: z.string().max(200).optional().describe('Shown on the invoice'),
        lines: z
          .array(z.object({ amount: z.number().describe('Line amount in dollars') }).describe('One line'))
          .min(1)
          .describe('The invoice lines'),
        status: z.enum(['draft', 'open']).nullable().describe('Leave empty for draft'),
      })
      .describe('A new invoice');
    const out = conv(s);
    expect(out.description).toBe('A new invoice');
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.customerId).toEqual({ type: 'string', format: 'uuid', description: 'The customer the invoice is for' });
    expect(props.memo).toEqual({ type: 'string', maxLength: 200, description: 'Shown on the invoice' });
    expect(props.lines.description).toBe('The invoice lines');
    const item = props.lines.items as Record<string, unknown>;
    expect(item.description).toBe('One line');
    expect((item.properties as Record<string, Record<string, unknown>>).amount.description).toBe('Line amount in dollars');
    expect(props.status).toEqual({ type: ['string', 'null'], enum: ['draft', 'open', null], description: 'Leave empty for draft' });
    expect(out.required).toEqual(['customerId', 'lines', 'status']);
  });

  it('keeps the text of wrappers: effects, default, lazy, a description written on the outside', () => {
    expect(conv(z.string().refine(() => true).describe('Checked by hand'))).toEqual({ type: 'string', description: 'Checked by hand' });
    expect(conv(z.number().default(3).describe('How many'))).toEqual({ type: 'number', default: 3, description: 'How many' });
    expect(conv(z.lazy(() => z.boolean()).describe('Lazy flag'))).toEqual({ type: 'boolean', description: 'Lazy flag' });
    expect(conv(z.string().describe('inner').optional().describe('outer'))).toEqual({ type: 'string', description: 'outer' });
  });

  it('leaves no marker of its own behind: the output is plain JSON data', () => {
    const out = zodToJsonSchema(z.object({ a: z.string().regex(new RegExp('é', 'i')), b: z.coerce.date() }));
    const symbols = (v: unknown): number =>
      v && typeof v === 'object' ? Object.getOwnPropertySymbols(v).length + Object.values(v).reduce((n: number, c) => n + symbols(c), 0) : 0;
    expect(symbols(out)).toBe(0);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

/** One schema with every kind the converter writes, and values zod takes for it. */
const EVERYTHING = (() => {
  type Tree = { name: string; kids?: Tree[] };
  const tree: z.ZodType<Tree> = z.lazy(() => z.object({ name: z.string(), kids: z.array(tree).optional() }));
  enum Level {
    Low,
    High,
  }
  return z
    .object({
      id: z.string().uuid(),
      code: z.string().regex(/^[a-z]{2}-\d+$/i).max(20),
      when: z.string().datetime({ offset: true }).optional(),
      at: z.string().time().optional(),
      day: z.string().date().optional(),
      mail: z.string().email().nullish(),
      site: z.string().url().optional(),
      amount: z.number().positive().multipleOf(0.01),
      qty: z.number().int().min(1).max(500).default(1),
      big: z.bigint().optional(),
      kind: z.enum(['a', 'b']),
      level: z.nativeEnum(Level).optional(),
      on: z.literal(true).optional(),
      pair: z.tuple([z.string(), z.number()]).optional(),
      none: z.tuple([]).optional(),
      tags: z.set(z.string()).max(3).optional(),
      map: z.record(z.enum(['x', 'y']), z.number()).optional(),
      lines: z.array(z.object({ memo: z.string().max(5).optional(), n: z.number() }).strict()).min(1),
      pick: z.discriminatedUnion('t', [z.object({ t: z.literal('one') }), z.object({ t: z.literal('two'), v: z.number() })]).optional(),
      both: z.intersection(z.object({ p: z.string() }), z.object({ q: z.number().optional() })).optional(),
      either: z.union([z.string().min(1), z.number()]).nullable().optional(),
      tree: tree.optional(),
      anything: z.unknown(),
      ip: z.string().ip().optional(),
    })
    .passthrough();
})();

const GOOD_VALUES: unknown[] = [
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: 12.5, kind: 'a', lines: [{ n: 1 }] },
  {
    id: '0B6C2F8E-5F7A-4B1E-9C3D-2A1B4C5D6E7F',
    code: 'ab-1',
    when: '2026-05-01T13:45+02:00',
    at: '13:45',
    day: '2026-02-28',
    mail: null,
    site: 'https://example.com/x',
    amount: 0.01,
    qty: 500,
    kind: 'b',
    level: 1,
    on: true,
    pair: ['x', 2],
    none: [],
    map: { x: 1 },
    lines: [{ memo: 'hi', n: 2 }],
    pick: { t: 'two', v: 3 },
    both: { p: 'p', q: 1 },
    either: 'z',
    tree: { name: 'root', kids: [{ name: 'leaf' }] },
    anything: [1, 'two'],
    ip: '10.0.0.1',
    extra: 'kept',
  },
];

const BAD_VALUES: unknown[] = [
  { id: 'x', code: 'AB-12', amount: 1, kind: 'a', lines: [{ n: 1 }] },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'A-12', amount: 1, kind: 'a', lines: [{ n: 1 }] },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: -1, kind: 'a', lines: [{ n: 1 }] },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: 1, kind: 'c', lines: [{ n: 1 }] },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: 1, kind: 'a', lines: [] },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: 1, kind: 'a', lines: [{ n: 1, other: 1 }] },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: 1, kind: 'a', lines: [{ n: 1 }], pick: { t: 'two' } },
  { id: '0b6c2f8e-5f7a-4b1e-9c3d-2a1b4c5d6e7f', code: 'AB-12', amount: 1, kind: 'a', lines: [{ n: 1 }], tree: { kids: [] } },
  { code: 'AB-12', amount: 1, kind: 'a', lines: [{ n: 1 }] },
];

describe('jsonSchemaProblems: a valid draft 2020-12 schema', () => {
  it('finds nothing wrong with what the converter writes, for every kind at once', () => {
    const out = zodToJsonSchema(EVERYTHING);
    expect(jsonSchemaProblems(out)).toEqual([]);
    // Each kind on its own too, including the odd ones (a tuple with no items, a never).
    for (const s of [z.tuple([]), z.never(), z.undefined(), z.nan(), z.string().regex(new RegExp('é', 'i')), z.coerce.date()]) {
      expect(jsonSchemaProblems(zodToJsonSchema(s)), String(s._def.typeName)).toEqual([]);
    }
  });

  it('names each mistake by where it is', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ type: 'text' }, /^\$\.type: must be one of/],
      [{ type: ['string', 'string'] }, /^\$\.type:/],
      [{ minLength: -1 }, /^\$\.minLength: must be a whole number/],
      [{ maxItems: 1.5 }, /^\$\.maxItems:/],
      [{ pattern: '[a' }, /^\$\.pattern: "\[a" is not a valid regular expression/],
      [{ pattern: '\\-' }, /^\$\.pattern:/], // fine without u, refused in unicode mode
      [{ $ref: '#/$defs/Nope' }, /^\$\.\$ref: "#\/\$defs\/Nope" does not lead/],
      [{ anyOf: [] }, /^\$\.anyOf: must be a list of at least one schema/],
      [{ prefixItems: [] }, /^\$\.prefixItems:/],
      [{ enum: [] }, /^\$\.enum: an empty list/],
      [{ enum: ['a', 'a'] }, /^\$\.enum: lists a value twice/],
      [{ required: ['a', 'a'] }, /^\$\.required:/],
      [{ minLength: 5, maxLength: 2 }, /^\$: minLength is above maxLength/],
      [{ multipleOf: 0 }, /^\$\.multipleOf: must be a number above 0/],
      [{ formatt: 'date' }, /^\$\.formatt: not a keyword of JSON Schema draft 2020-12/],
      [{ toString: 'x' }, /^\$\.toString: not a keyword/],
      [{ properties: { a: 5 } }, /^\$\.properties\.a: a schema must be an object/],
      [{ properties: { a: { $schema: JSON_SCHEMA_DRAFT } } }, /^\$\.properties\.a\.\$schema: \$schema belongs on the root only/],
      [{ items: { type: 'string', default: Infinity } }, /not JSON/],
      [{ default: undefined }, /not JSON/],
    ];
    for (const [schema, problem] of cases) {
      const found = jsonSchemaProblems(schema);
      expect(found.length, JSON.stringify(schema)).toBeGreaterThan(0);
      expect(found.some((p) => problem.test(p)), `${JSON.stringify(schema)}: ${found.join(' | ')}`).toBe(true);
    }
    // A boolean schema and the empty schema are schemas.
    expect(jsonSchemaProblems(true)).toEqual([]);
    expect(jsonSchemaProblems({})).toEqual([]);
    expect(jsonSchemaProblems({ $defs: { A: { type: 'string' } }, $ref: '#/$defs/A' })).toEqual([]);
  });

  it.skipIf(!Ajv2020)('agrees with ajv (draft 2020-12, strict): the schema compiles and checks values as zod does', () => {
    // ajv-formats is not installed: the formats the schema uses, roughly, so ajv checks them too.
    const formats = {
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      date: /^\d{4}-\d{2}-\d{2}$/,
      email: /^[^\s@]+@[^\s@]+$/,
      uri: /^[a-z][a-z0-9+.-]*:/i,
      ipv4: /^\d{1,3}(\.\d{1,3}){3}$/,
      ipv6: /:/,
      int64: true,
    };
    const ajv = new Ajv2020!({ strict: true, formats, allowUnionTypes: true, logger: false });
    const out = zodToJsonSchema(EVERYTHING);
    expect(ajv.validateSchema(out), JSON.stringify(ajv.errors)).toBe(true);
    const check = ajv.compile(out);
    for (const v of GOOD_VALUES) {
      expect(EVERYTHING.safeParse(v).success, JSON.stringify(v)).toBe(true);
      expect(check(v), `${JSON.stringify(v)}: ${JSON.stringify(check.errors)}`).toBe(true);
    }
    for (const v of BAD_VALUES) {
      expect(EVERYTHING.safeParse(v).success, JSON.stringify(v)).toBe(false);
      expect(check(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe('jsonSchemaErrors: does a value meet a schema', () => {
  const schema = zodToJsonSchema(EVERYTHING);

  it('takes what zod takes, and refuses what zod refuses (for these values)', () => {
    for (const v of GOOD_VALUES) expect(jsonSchemaErrors(schema, v), JSON.stringify(v)).toEqual([]);
    for (const v of BAD_VALUES) expect(jsonSchemaErrors(schema, v).length, JSON.stringify(v)).toBeGreaterThan(0);
  });

  it('says what is wrong and where', () => {
    expect(jsonSchemaErrors(schema, BAD_VALUES[0])).toEqual(['$.id: must be in uuid form']);
    expect(jsonSchemaErrors(schema, BAD_VALUES[8])).toEqual(['$: must have id']);
    expect(jsonSchemaErrors(schema, BAD_VALUES[5])).toEqual(['$.lines[0]: must not have other']);
    expect(jsonSchemaErrors({ type: 'object' }, undefined)).toEqual(['$: must be object, and is missing']);
    expect(jsonSchemaErrors({ type: 'integer' }, 1.5)).toEqual(['$: must be integer']);
    expect(jsonSchemaErrors({ type: 'number', minimum: 0 }, 3)).toEqual([]);
    expect(jsonSchemaErrors({ type: 'string', format: 'date' }, '2026-02-30')).toEqual(['$: must be in date form']);
    expect(jsonSchemaErrors({ type: 'string', format: 'date' }, '2026-02-30', { formats: false })).toEqual([]);
    expect(jsonSchemaErrors({ $ref: '#/$defs/Gone' }, 1)).toEqual(['$: the schema refers to "#/$defs/Gone", which is not in it']);
    expect(jsonSchemaErrors({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 2)).toEqual(['$: must match exactly one of 2 options; it matches 2']);
    expect(jsonSchemaErrors(false, 1)).toEqual(['$: no value is allowed here']);
  });
});
