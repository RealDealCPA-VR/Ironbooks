/**
 * zod v3 -> JSON Schema (lib/agent/jsonSchema.ts): one case per zod kind the app's schemas use or
 * could use, plus the rules that hold across them (required fields, descriptions at every level,
 * recursion, never throwing).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JSON_SCHEMA_DRAFT, zodAcceptsMissing, zodToJsonSchema } from './jsonSchema';

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

  it('string: email, url, uuid, datetime, date as formats', () => {
    expect(conv(z.string().email())).toEqual({ type: 'string', format: 'email' });
    expect(conv(z.string().url())).toEqual({ type: 'string', format: 'uri' });
    expect(conv(z.string().uuid())).toEqual({ type: 'string', format: 'uuid' });
    expect(conv(z.string().datetime())).toEqual({ type: 'string', format: 'date-time' });
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

  it('string: time and a datetime without an offset are patterns, never stricter than zod', () => {
    // JSON Schema's "time" and "date-time" need an offset; these zod checks take a value without one.
    const cases: Array<[z.ZodString, string[], string[]]> = [
      [z.string().time(), ['13:45', '13:45:09', '13:45:09.123'], ['24:00', '13:45Z', '1:45']],
      [z.string().time({ precision: 3 }), ['13:45:09.123'], ['13:45', '13:45:09.12']],
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
      for (const v of bad) expect(re.test(v), `${out.pattern} on ${v}`).toBe(false);
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

  it('date: text in date-time form', () => {
    expect(conv(z.date())).toEqual({ type: 'string', format: 'date-time' });
    expect(conv(z.coerce.date())).toEqual({ type: 'string', format: 'date-time' });
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
});
