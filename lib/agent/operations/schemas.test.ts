/**
 * The body and query schemas of every operation (lib/agent/operations/schemas.ts), plan §6.3:
 * every schema the registry names loads through the generated import map and turns into a JSON
 * Schema object, and shell operations get theirs from their input fields. A field the guards take
 * out of an agent's input (a password, a key, a setting only a person changes, a confirmation the
 * operation does not take) is never described, nor required, at any depth. Every described schema
 * is valid draft 2020-12 and small enough for a model to read, and every example validates.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ShellOperationDef } from '../contract';
import { guardInput } from '../guards';
import { JSON_SCHEMA_DRAFT, jsonSchemaProblems, zodToJsonSchema } from '../jsonSchema';
import { allOperations } from './registry';
import { GENERATED_ROUTES } from './routes.generated';
import { SCHEMA_LOADERS } from './schemas.generated';
import { SHELL_OPERATIONS } from './shell';
import {
  SCHEMA_CHARS_MAX,
  describeSchemas,
  exampleProblems,
  examplesOf,
  loadBodySchema,
  plainSentence,
  shellBodySchema,
} from './schemas';
import type { Operation } from './types';

/** ajv's draft 2020-12 validator when it can be found (it is not a dependency of the app); null skips its test. */
function loadAjv(): (new (opts: Record<string, unknown>) => { compile: (s: unknown) => unknown; validateSchema: (s: unknown) => boolean; errors?: unknown }) | null {
  try {
    const mod = createRequire(import.meta.url)('ajv/dist/2020') as { default?: unknown };
    return (mod.default ?? mod) as never;
  } catch {
    return null;
  }
}
const Ajv2020 = loadAjv();

/** A shell operation for these tests, added next to the real ones (still none while phase 6 is open). */
const TEST_SHELL: ShellOperationDef = vi.hoisted(() => ({
  id: 'shell.test.copy-company',
  runner: 'electron',
  flow: 'testCopyFlow',
  class: 'file',
  area: null,
  describe: 'Save a copy of the company file',
  why: 'Writes a file outside the database.',
  input: {
    folder: { type: 'path', required: true, describe: 'Where the copy goes' },
    name: { type: 'string', required: false, describe: 'File name of the copy' },
    keepOpen: { type: 'boolean', required: false, describe: 'Stay in this company afterwards' },
    copies: { type: 'number', required: true, describe: 'How many copies' },
    logoFile: { type: 'fileId', required: false, describe: 'A logo to put on the copy' },
  },
  questions: [],
  needsSecret: ['file_password'],
  hostOnly: true,
  fileAdmin: true,
  restarts: false,
}) satisfies ShellOperationDef);

/**
 * Examples planted where the registry test reads them: no classification has any yet (types.ts has
 * no field for them), so without these that test would loop over nothing. Good and bad ones on a
 * real route's classification (POST /api/items/bulk, items.bulk.save), the same on the test shell
 * definition: the registry test expects exactly the bad ones, by operation id, and the good ones
 * in the shape describe_operation answers them (contract.ts OperationDescription.examples).
 */
const PLANTED = vi.hoisted(() => ({
  routeKey: 'POST /api/items/bulk',
  routeId: 'items.bulk.save',
  route: [
    { body: { rows: [{ name: 'Widget', salesPrice: 5 }] }, note: 'Add one item' },
    { rows: [{ name: 'Gadget' }], dryRun: true },
    { body: { rows: [] } },
    // Nothing in this operation's answer is masked, so the guards refuse a reveal.
    { body: { rows: [{ name: 'Bolt' }] }, summary: 'Ask to see masked values', reveal: true },
  ] as unknown[],
  shell: [{ body: { folder: 'C:\\Backups', copies: 1 } }, { folder: 'C:\\Backups' }] as unknown[],
}));

vi.mock('./shell', async (importOriginal) => {
  const real = await importOriginal<typeof import('./shell')>();
  // On the definition only (the registry's operation has no examples field): examplesOf reads it there.
  return { ...real, SHELL_OPERATIONS: [...real.SHELL_OPERATIONS, { ...TEST_SHELL, examples: PLANTED.shell }] };
});

vi.mock('./classes', async (importOriginal) => {
  const real = await importOriginal<typeof import('./classes')>();
  const entry = real.OPERATION_CLASSES[PLANTED.routeKey] as { examples?: unknown[] } | undefined;
  if (!entry) throw new Error(`${PLANTED.routeKey} is not classified: plant the examples on another route`);
  return {
    ...real,
    OPERATION_CLASSES: { ...real.OPERATION_CLASSES, [PLANTED.routeKey]: { ...entry, examples: [...(entry.examples ?? []), ...PLANTED.route] } },
  };
});

/**
 * References only these tests know: one that is not a zod schema, one whose module fails, and a
 * body and a query for the example tests.
 */
vi.mock('./schemas.generated', async (importOriginal) => {
  const real = await importOriginal<typeof import('./schemas.generated')>();
  const { z: zod } = await import('zod');
  return {
    SCHEMA_LOADERS: {
      ...real.SCHEMA_LOADERS,
      '@/test/fake#notZod': async () => ({ parse: () => null }),
      '@/test/fake#throws': async () => {
        throw new Error('module failed to load');
      },
      '@/test/fake#exampleBody': async () =>
        zod
          .object({
            name: zod.string().min(1),
            qty: zod.number().int().min(1).optional(),
            password: zod.string().optional(),
            allowDuplicateNumber: zod.boolean().optional(),
          })
          .strict(),
      '@/test/fake#recordBody': async () =>
        zod.object({ logins: zod.record(zod.object({ label: zod.string(), password: zod.string(), apiKey: zod.string().optional() })) }),
      // A body whose own fields carry the names of a request's parts.
      '@/test/fake#noteBody': async () => zod.object({ query: zod.string().optional(), body: zod.string().optional(), note: zod.string().optional() }),
    },
  };
});

/** The real guards, which one test makes fail to show the description still leaves secrets out. */
const guards = vi.hoisted(() => ({ fail: false }));
vi.mock('../guards', async (importOriginal) => {
  const real = await importOriginal<typeof import('../guards')>();
  return {
    ...real,
    guardInput: (...args: Parameters<typeof real.guardInput>) => {
      if (guards.fail) throw new Error('guards are down');
      return real.guardInput(...args);
    },
  };
});

/** An operation like the registry's, for the cases the registry has none of. */
function fakeOperation(over: Partial<Operation>): Operation {
  return {
    id: 'test.op',
    kind: 'route',
    route: '/api/test-only',
    method: 'POST',
    params: [],
    rule: null,
    area: null,
    action: null,
    activity: null,
    classified: true,
    class: 'enter',
    describe: 'Test operation',
    availability: 'agent',
    why: null,
    dryRun: 'transaction',
    body: 'json',
    output: 'json',
    confirmFlags: [],
    sensitiveFields: [],
    reveal: null,
    hostOnly: false,
    fileAdmin: false,
    needsSecret: [],
    producesSecret: [],
    effects: [],
    countField: null,
    amountField: null,
    alwaysAsk: false,
    bodySchema: null,
    ...over,
  };
}

/** Every "Not described" note anywhere inside a JSON Schema, by its path. */
function notDescribed(schema: unknown, at = '$'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string' && v.startsWith('Not described')) out.push(`${at}: ${v}`);
    else out.push(...notDescribed(v, `${at}.${k}`));
  }
  return out;
}

const queryRefOf = (op: Operation) =>
  op.kind === 'route' ? GENERATED_ROUTES[op.route]?.methods[op.method]?.querySchema ?? null : null;

describe('operation schemas: every operation of the registry', () => {
  const ops = allOperations();

  it('every schema reference the registry names is in the generated import map', () => {
    const refs = new Set<string>();
    for (const op of ops) {
      if (op.bodySchema) refs.add(op.bodySchema);
      const q = queryRefOf(op);
      if (q) refs.add(q);
    }
    expect(refs.size).toBeGreaterThan(100);
    const missing = [...refs].filter((r) => !Object.hasOwn(SCHEMA_LOADERS, r)).sort();
    expect(missing, 'run `npm run agent:registry`: schemas.generated.ts does not list these').toEqual([]);
  });

  it('loads each body schema as a zod schema, and null where the operation names none', async () => {
    const problems: string[] = [];
    for (const op of ops) {
      try {
        const s = await loadBodySchema(op);
        if (op.kind === 'route' && !op.bodySchema && s !== null) problems.push(`${op.id}: a schema where none is named`);
        if (op.bodySchema && (!s || typeof s.safeParse !== 'function')) problems.push(`${op.id}: ${op.bodySchema} is not a zod schema`);
      } catch (err) {
        problems.push(`${op.id}: ${(err as Error).message}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('turns each body and query schema into a JSON Schema object, and nothing into null', async () => {
    const problems: string[] = [];
    let bodies = 0;
    let queries = 0;
    for (const op of ops) {
      let d: { body: unknown; query: unknown };
      try {
        d = await describeSchemas(op);
      } catch (err) {
        problems.push(`${op.id}: threw ${(err as Error).message}`);
        continue;
      }
      const parts: Array<['body' | 'query', unknown, boolean]> = [
        ['body', d.body, !!op.bodySchema || op.kind === 'shell'],
        ['query', d.query, !!queryRefOf(op)],
      ];
      for (const [part, schema, expected] of parts) {
        if (!expected) {
          if (schema !== null) problems.push(`${op.id}: a ${part} schema where none is named`);
          continue;
        }
        if (part === 'body') bodies++;
        else queries++;
        const s = schema as Record<string, unknown> | null;
        if (!s || typeof s !== 'object') {
          problems.push(`${op.id}: no ${part} schema`);
          continue;
        }
        if (s.$schema !== JSON_SCHEMA_DRAFT) problems.push(`${op.id}: ${part} schema does not name draft 2020-12`);
        if (s.type !== 'object') problems.push(`${op.id}: ${part} schema is not an object schema (type ${JSON.stringify(s.type)})`);
        for (const note of notDescribed(s)) problems.push(`${op.id} ${part} ${note}`);
        // Plain data: what the agent reads is this, sent as JSON.
        if (JSON.stringify(JSON.parse(JSON.stringify(s))) !== JSON.stringify(s)) problems.push(`${op.id}: ${part} schema is not plain JSON`);
      }
    }
    expect(problems).toEqual([]);
    expect(bodies).toBeGreaterThan(150);
    expect(queries).toBeGreaterThan(0);
  }, 120_000);
});

describe('operation schemas: shell operations', () => {
  it('builds a strict body from the input fields, with what each field is', async () => {
    const op = fakeOperation({ id: TEST_SHELL.id, kind: 'shell', route: TEST_SHELL.flow, class: 'file' });
    const s = await loadBodySchema(op);
    expect(s).not.toBeNull();
    expect(s!.safeParse({ folder: 'C:\\Backups', copies: 1 }).success).toBe(true);
    // Strict: a field the flow does not name is refused, not passed along.
    expect(s!.safeParse({ folder: 'C:\\Backups', copies: 1, password: 'x' }).success).toBe(false);
    expect(s!.safeParse({ copies: 1 }).success).toBe(false);
    expect(s!.safeParse({ folder: '', copies: 1 }).success).toBe(false);

    const { body, query } = await describeSchemas(op);
    expect(query).toBeNull();
    // The root says what the operation does in a plain sentence (the card's line has {field}
    // placeholders the card fills in), and what the strict object means for the sender.
    expect(body).toEqual({
      $schema: JSON_SCHEMA_DRAFT,
      type: 'object',
      description: 'Save a copy of the company file. Send only the fields listed here: any other field is refused.',
      properties: {
        folder: {
          type: 'string',
          minLength: 1,
          description:
            'A full path as this computer sees it, starting with a drive such as C:\\, a share such as \\\\server\\share, or / on a Mac or Linux computer. Where the copy goes.',
        },
        name: { type: 'string', description: 'File name of the copy.' },
        keepOpen: { type: 'boolean', description: 'Stay in this company afterwards.' },
        copies: { type: 'number', description: 'How many copies.' },
        logoFile: {
          type: 'string',
          minLength: 1,
          description: 'The fileId of a file you staged with upload_file. A logo to put on the copy.',
        },
      },
      required: ['folder', 'copies'],
      additionalProperties: false,
    });
  });

  it("every shell operation's schema says what it does in a plain sentence, with no placeholders", async () => {
    expect(SHELL_OPERATIONS.length).toBeGreaterThan(1);
    const problems: string[] = [];
    for (const def of SHELL_OPERATIONS) {
      const op = allOperations().find((o) => o.id === def.id && o.kind === 'shell');
      if (!op) {
        problems.push(`${def.id}: not in the registry`);
        continue;
      }
      const body = (await describeSchemas(op)).body as Record<string, unknown>;
      const texts: Array<[string, unknown]> = [['$', body.description]];
      for (const [name, field] of Object.entries((body.properties ?? {}) as Record<string, { description?: unknown }>)) {
        texts.push([`$.${name}`, field.description]);
        // A path says the rule the guards refuse it by (guards.ts notFullPath): a full one.
        if (def.input[name]?.type === 'path' && !/^A full path .*C:\\.*\\\\server\\share.*\/ on a Mac or Linux computer\./.test(String(field.description))) {
          problems.push(`${def.id} $.${name}: does not say it takes a full path`);
        }
      }
      for (const [at, text] of texts) {
        if (typeof text !== 'string' || !text.trim()) problems.push(`${def.id} ${at}: no description`);
        else if (/[{}]/.test(text)) problems.push(`${def.id} ${at}: "${text}" has a placeholder`);
        else if (!/^["'A-Z]/.test(text) || !/[.!?]$/.test(text)) problems.push(`${def.id} ${at}: "${text}" is not a sentence`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('plainSentence: the card line without its placeholders, still reading as a sentence', () => {
    const cases: Array<[string, string]> = [
      ['Open company file {file}', 'Open company file.'],
      ['Save file {fileId} in {folder}', 'Save file in the given folder.'],
      ['Turn on multi-user access ({network})', 'Turn on multi-user access.'],
      ['Open the company file hosted at {host}', 'Open the company file hosted at the given host.'],
      ['Restore backup {file} as a new company file {target}', 'Restore backup as a new company file.'],
      ['Create a new, empty company file at {file} and switch to it', 'Create a new, empty company file at the given file and switch to it.'],
      ['Close the company file', 'Close the company file.'],
      ['{everything}', ''],
    ];
    for (const [template, sentence] of cases) expect(plainSentence(template), template).toBe(sentence);
  });

  it('a shell operation with no fields takes an empty object; an unknown one has no body', async () => {
    const empty = shellBodySchema({ ...TEST_SHELL, input: {} });
    expect(empty.safeParse({}).success).toBe(true);
    expect(empty.safeParse({ x: 1 }).success).toBe(false);
    expect(empty.description).toBe('Save a copy of the company file. It takes no fields.');
    expect(await loadBodySchema(fakeOperation({ id: 'shell.nothing.here', kind: 'shell' }))).toBeNull();
    expect(await describeSchemas(fakeOperation({ id: 'shell.nothing.here', kind: 'shell' }))).toEqual({ body: null, query: null });
  });
});

/** Every property name anywhere in a JSON Schema, with its path. */
function propertyNames(schema: unknown, at = '$', out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s, i) => propertyNames(s, `${at}[${i}]`, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'properties' && v && typeof v === 'object') for (const name of Object.keys(v)) out.push(`${at}.${name}`);
      propertyNames(v, `${at}.${k}`, out);
    }
  }
  return out;
}

/** Every name a "required" list anywhere in a JSON Schema holds. */
function requiredNames(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) schema.forEach((s) => requiredNames(s, out));
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (k === 'required' && Array.isArray(v)) out.push(...(v as string[]));
      else requiredNames(v, out);
    }
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Two sample values for one place, merged: objects key by key, lists into one item. */
function mergeSamples(a: unknown, b: unknown): unknown {
  if (isObj(a) && isObj(b)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const v = Object.hasOwn(a, k) && Object.hasOwn(b, k) ? mergeSamples(a[k], b[k]) : Object.hasOwn(a, k) ? a[k] : b[k];
      Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) return [mergeSamples(a[0], b[0])];
  return a === 'x' ? b : a;
}

/**
 * A value holding every field a JSON Schema names anywhere: its properties AND the names in its
 * required lists, in every option, list item and record value. Written apart from schemas.ts on
 * purpose, so the test does not share a blind spot with the code.
 */
function everyField(node: unknown, root: Record<string, unknown>, depth = 0): unknown {
  if (!isObj(node) || depth > 12) return 'x';
  let out: unknown = 'x';
  const fields: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => Object.defineProperty(fields, k, { value: v, enumerable: true, writable: true, configurable: true });
  let isObject = false;
  if (isObj(node.properties)) {
    isObject = true;
    for (const [k, v] of Object.entries(node.properties)) put(k, everyField(v, root, depth + 1));
  }
  if (Array.isArray(node.required)) {
    isObject = true;
    for (const k of node.required as string[]) if (!Object.hasOwn(fields, k)) put(k, 'x');
  }
  if (isObj(node.additionalProperties)) {
    isObject = true;
    put('someKey', everyField(node.additionalProperties, root, depth + 1));
  }
  if (isObject) out = mergeSamples(out, fields);
  const items: unknown[] = [];
  if (Array.isArray(node.prefixItems)) items.push(...node.prefixItems.map((p) => everyField(p, root, depth + 1)));
  if (isObj(node.items)) items.push(everyField(node.items, root, depth + 1));
  if (items.length) out = mergeSamples(out, [items.reduce((a, b) => mergeSamples(a, b))]);
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[k])) for (const o of node[k] as unknown[]) out = mergeSamples(out, everyField(o, root, depth + 1));
  }
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/') && isObj(root.$defs)) {
    out = mergeSamples(out, everyField(root.$defs[node.$ref.slice('#/$defs/'.length)], root, depth + 1));
  }
  return out;
}

/** Field names that hold a secret (as lib/agent/guards.ts takes them out), written out again here on purpose. */
const SECRET_NAMES = ['password', 'currentPassword', 'newPassword', 'filePassword', 'apiKey', 'recoveryKey', 'totp', 'challengeAnswer'];

describe('operation schemas: fields an agent never sends are not described', () => {
  const byId = (id: string) => {
    const op = allOperations().find((o) => o.id === id);
    expect(op, id).toBeDefined();
    return op!;
  };
  const described = async (id: string) => (await describeSchemas(byId(id))).body as Record<string, unknown>;
  const props = (s: unknown) => Object.keys(((s as Record<string, unknown>).properties ?? {}) as object);

  it('a password the approver types is not listed, nor required, and the body says to leave it out', async () => {
    const cases: Array<[string, string[]]> = [
      ['users.create', ['password']],
      ['users.reset-password', ['password', 'currentPassword']],
      ['email.settings.update', ['password']],
      ['company.closing-date.update', ['password', 'currentPassword']],
    ];
    for (const [id, gone] of cases) {
      const body = await described(id);
      for (const name of gone) {
        expect(props(body), `${id} lists ${name}`).not.toContain(name);
        expect(requiredNames(body), `${id} requires ${name}`).not.toContain(name);
      }
      expect(body.description, id).toMatch(new RegExp(`^Leave out ${gone.join(' and ')}: only a person gives`));
    }
    // The fields beside it are still there.
    expect(props(await described('users.create'))).toEqual(expect.arrayContaining(['name', 'login', 'roleKeys']));
  });

  it('nested ones too: a draft password, a provider key, settings only a person changes', async () => {
    const test = await described('email.test');
    expect(props(test)).toContain('draft');
    const draft = (test.properties as Record<string, unknown>).draft;
    expect(props(draft)).toContain('host');
    expect(props(draft)).not.toContain('password');
    expect(requiredNames(test)).not.toContain('password');
    // The note on the body says which password. (The approval-card note is describe_operation's:
    // the next test checks what this file can of it.)
    expect(test.description).toMatch(/Leave out draft\.password: only a person gives this, in Ironbooks\./);
    expect(byId('email.test').needsSecret).toContain('mail_password');

    const ai = await described('ai.settings.update');
    const provider = ((ai.properties as Record<string, Record<string, unknown>>).providers.items ?? {}) as Record<string, unknown>;
    expect(props(provider)).toContain('model');
    expect(props(provider)).not.toContain('apiKey');

    const company = await described('company.update');
    const settings = (company.properties as Record<string, unknown>).settings;
    expect(props(settings)).toContain('legalName');
    for (const name of ['integratedAppsBlocked', 'allowEmployeePortal', 'allowPhoneReceipts']) expect(props(settings)).not.toContain(name);

    // Inside the values of a record (any key), required or not.
    const record = (await describeSchemas(fakeOperation({ id: 'test.record', bodySchema: '@/test/fake#recordBody' }))).body as Record<string, unknown>;
    const value = ((record.properties as Record<string, Record<string, unknown>>).logins.additionalProperties ?? {}) as Record<string, unknown>;
    expect(props(value)).toEqual(['label']);
    expect(value.required).toEqual(['label']);
    expect(record.description).toBe('Leave out logins.password and logins.apiKey: only a person gives these, in Ironbooks.');
  });

  it('each of them needs a secret, so describe_operation says a person types it on the approval card', () => {
    // describe_operation (lib/agent/operate.ts, notesFor) adds "A person types … on the approval
    // card. Never send it yourself." for every operation with needsSecret. notesFor is not exported,
    // so this file checks the two halves it can: each of these operations needs a secret, and
    // operate.ts still writes that note for one that does. (operate.test.ts is the place to pin
    // the note through describe_operation itself.)
    for (const id of ['users.create', 'users.reset-password', 'email.settings.update', 'email.test', 'company.closing-date.update']) {
      expect(byId(id).needsSecret.length, id).toBeGreaterThan(0);
    }
    const operate = fs.readFileSync(path.join(process.cwd(), 'lib', 'agent', 'operate.ts'), 'utf8');
    expect(operate).toMatch(/if \(operation\.needsSecret\.length\)[^\n]*on the approval card\. Never send it yourself\./);
  });

  it('no body or query of any operation lists a secret field, at any depth', async () => {
    const found: string[] = [];
    for (const op of allOperations()) {
      const d = await describeSchemas(op);
      for (const [part, schema] of [['body', d.body], ['query', d.query]] as const) {
        for (const p of propertyNames(schema)) {
          if (SECRET_NAMES.includes(p.split('.').pop()!)) found.push(`${op.id} ${part} ${p}`);
        }
        for (const name of requiredNames(schema)) {
          if (SECRET_NAMES.includes(name)) found.push(`${op.id} ${part} requires ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it('nothing any described schema names, as a field or as required, is something the guards take out', async () => {
    // A body with every field each schema names (its properties and its required lists, in every
    // option, list item and record value), shown to the real guards with the operation as it is.
    // First, that the check has teeth: on the schema as zod alone gives it, the guards do strip.
    const create = byId('users.create');
    const raw = zodToJsonSchema(await loadBodySchema(create));
    expect(guardInput(create, { body: everyField(raw, raw) }).stripped).toContain('body.password');
    const found: string[] = [];
    for (const op of allOperations()) {
      const d = await describeSchemas(op);
      for (const [part, schema] of [['body', d.body], ['query', d.query]] as const) {
        if (!isObj(schema)) continue;
        const sample = everyField(schema, schema);
        const stripped = guardInput(op, { [part]: sample }).stripped.filter((p) => p.startsWith(`${part}.`));
        for (const p of stripped) found.push(`${op.id} ${p}`);
      }
    }
    expect(found).toEqual([]);
  }, 120_000);

  it('a confirmation flag the operation takes stays; one it does not take is left out, and said', async () => {
    const real = byId('payments.create');
    const notTaken = (await describeSchemas(real)).body as Record<string, unknown>;
    expect(props(notTaken)).not.toContain('allowReconciledEdit');
    expect(notTaken.description).toMatch(/Leave out .*allowReconciledEdit.*: this operation does not take/);
    // The same route with the flags listed (a copy: its own cache entry).
    const listed = { ...real, confirmFlags: ['allowReconciledEdit', 'removeFromDeposit'] };
    const taken = (await describeSchemas(listed)).body as Record<string, unknown>;
    expect(props(taken)).toEqual(expect.arrayContaining(['allowReconciledEdit', 'removeFromDeposit']));
    expect(taken.description).toBeUndefined();
  });

  it('when the guards cannot be asked, every field that looks like a secret is left out (fail closed)', async () => {
    guards.fail = true;
    try {
      const copy = { ...byId('users.create'), id: 'users.create.guards-down' };
      const body = (await describeSchemas(copy)).body as Record<string, unknown>;
      expect(props(body)).not.toContain('password');
      expect(props(body)).toContain('login');
      expect(body.description).toMatch(/^Leave out password: only a person gives this/);
    } finally {
      guards.fail = false;
    }
  });
});

/** Every described body and query of the registry, with where it came from. */
async function everyDescribed(): Promise<Array<{ at: string; schema: Record<string, unknown> }>> {
  const out: Array<{ at: string; schema: Record<string, unknown> }> = [];
  for (const op of allOperations()) {
    const d = await describeSchemas(op);
    if (d.body) out.push({ at: `${op.id} body`, schema: d.body as Record<string, unknown> });
    if (d.query) out.push({ at: `${op.id} query`, schema: d.query as Record<string, unknown> });
  }
  return out;
}

describe('operation schemas: valid draft 2020-12, and small enough to read', () => {
  it('every described body and query is a valid draft 2020-12 schema (structural check)', async () => {
    const all = await everyDescribed();
    expect(all.length).toBeGreaterThan(150);
    const problems = all.flatMap(({ at, schema }) => jsonSchemaProblems(schema).map((p) => `${at} ${p}`));
    expect(problems).toEqual([]);
  }, 120_000);

  it.skipIf(!Ajv2020)('every described body and query compiles in ajv (draft 2020-12, strict) and meets its meta-schema', async () => {
    // strictTypes and strictTuples only log; with logger off they say nothing. Unknown formats are
    // named here, since ajv-formats is not installed (strict mode refuses a format it does not know).
    const formats = { uuid: true, date: true, 'date-time': true, email: true, uri: true, ipv4: true, ipv6: true, int64: true };
    const ajv = new Ajv2020!({ strict: true, formats, allowUnionTypes: true, logger: false });
    const problems: string[] = [];
    for (const { at, schema } of await everyDescribed()) {
      if (!ajv.validateSchema(schema)) problems.push(`${at}: ${JSON.stringify(ajv.errors).slice(0, 300)}`);
      try {
        ajv.compile(schema);
      } catch (err) {
        problems.push(`${at}: ${(err as Error).message.slice(0, 300)}`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it(`every described body and query stays under ${SCHEMA_CHARS_MAX} characters of JSON`, async () => {
    const sizes = (await everyDescribed()).map(({ at, schema }) => ({ at, chars: JSON.stringify(schema).length })).sort((a, b) => b.chars - a.chars);
    const largest = sizes[0];
    // The largest today: invoices.create body, about 9,000 characters.
    expect(largest.chars, `largest: ${largest.at}`).toBeLessThan(SCHEMA_CHARS_MAX);
    expect(sizes.filter((s) => s.chars >= SCHEMA_CHARS_MAX)).toEqual([]);
  }, 120_000);
});

describe('operation schemas: examples', () => {
  const exampleOp = (examples: unknown, over: Partial<Operation> = {}) =>
    ({ ...fakeOperation({ id: 'test.examples', route: '/api/test-examples', bodySchema: '@/test/fake#exampleBody', ...over }), examples }) as Operation;

  it('every example the registry gives validates against its described schema and passes the guards', async () => {
    // Each problem names its operation and example ("invoices.create example 2 body $.lines: …").
    // The registry's only examples today are the ones planted at the top of this file, on a
    // classification and on a shell definition: exactly their bad ones are reported, and any real
    // example that does not validate shows up here too.
    const problems: string[] = [];
    const counts = new Map<string, number>();
    for (const op of allOperations()) {
      counts.set(op.id, examplesOf(op).length);
      problems.push(...(await exampleProblems(op)));
    }
    const route = allOperations().find((o) => o.id === PLANTED.routeId)!;
    const shell = allOperations().find((o) => o.id === TEST_SHELL.id)!;
    // Read from where they are written: neither operation carries examples itself.
    expect(Object.hasOwn(route, 'examples') || Object.hasOwn(shell, 'examples')).toBe(false);
    // Real examples, if any, come before the planted ones.
    const routeBefore = (counts.get(route.id) ?? 0) - PLANTED.route.length;
    const shellBefore = (counts.get(shell.id) ?? 0) - PLANTED.shell.length;
    expect(routeBefore).toBeGreaterThanOrEqual(0);
    expect(shellBefore).toBeGreaterThanOrEqual(0);
    expect(problems).toEqual([
      `items.bulk.save example ${routeBefore + 3} body $.rows: must have at least 1 item`,
      expect.stringMatching(new RegExp(`^items\\.bulk\\.save example ${routeBefore + 4}: the guards would refuse it: Nothing in this answer is masked`)),
      `${TEST_SHELL.id} example ${shellBefore + 2} body $: must have copies`,
    ]);
    // As describe_operation answers them (OperationDescription.examples, wave 4): each a request as
    // run_operation takes it, with its title and note; an example written as a body alone is the body.
    expect(examplesOf(route).slice(routeBefore)).toEqual([
      { body: { rows: [{ name: 'Widget', salesPrice: 5 }] }, note: 'Add one item' },
      { body: { rows: [{ name: 'Gadget' }], dryRun: true } },
      { body: { rows: [] } },
      { body: { rows: [{ name: 'Bolt' }] }, title: 'Ask to see masked values', reveal: true },
    ]);
    expect(examplesOf(shell).slice(shellBefore)).toEqual([{ body: { folder: 'C:\\Backups', copies: 1 } }, { body: { folder: 'C:\\Backups' } }]);
  }, 120_000);

  it('reads an example as a whole request, or as the body alone', () => {
    expect(examplesOf(exampleOp(undefined))).toEqual([]);
    expect(examplesOf(exampleOp({ name: 'A' }))).toEqual([{ body: { name: 'A' } }]);
    expect(examplesOf(exampleOp([{ body: { name: 'A' }, note: 'one' }, { params: { id: 'x' } }]))).toEqual([
      { body: { name: 'A' }, note: 'one' },
      { params: { id: 'x' } },
    ]);
    // The words beside a request travel with it (title, from title, describe or summary; note),
    // trimmed; blank ones and a reveal that is not true are left out.
    expect(
      examplesOf(
        exampleOp([
          { body: { name: 'A' }, title: ' Plain ', note: '  ', reveal: false },
          { body: { name: 'B' }, describe: 'Described', summary: 'Summed up', reveal: true },
          { query: { q: 'acme' }, summary: 'Summed up' },
        ]),
      ),
    ).toEqual([
      { body: { name: 'A' }, title: 'Plain' },
      { body: { name: 'B' }, title: 'Described', reveal: true },
      { query: { q: 'acme' }, title: 'Summed up' },
    ]);
    // A body that happens to have a field called "body" next to others is a body.
    expect(examplesOf(exampleOp([{ body: 'text', name: 'B' }]))).toEqual([{ body: { body: 'text', name: 'B' } }]);
    // So is one where a request's key has another shape: a search's query text, params that are
    // not text, reveal that is not a yes or no.
    expect(examplesOf(exampleOp([{ query: 'acme' }, { params: { id: 1 } }, { body: {}, reveal: 'yes' }]))).toEqual([
      { body: { query: 'acme' } },
      { body: { params: { id: 1 } } },
      { body: { body: {}, reveal: 'yes' } },
    ]);
    // An empty confirm only makes an example read one way: it is not passed on.
    expect(examplesOf(exampleOp([{ body: { name: 'A' }, confirm: [] }]))).toEqual([{ body: { name: 'A' } }]);
  });

  it('an example that could be read as a request or as the body alone is reported', async () => {
    // The body has fields named query, body and note.
    const op = exampleOp(
      [{ query: 'acme' }, { body: 'hello', note: 'x' }, { body: { body: 'hello', note: 'x' }, confirm: [] }],
      { id: 'test.examples.note', route: '/api/test-examples-note', bodySchema: '@/test/fake#noteBody' },
    );
    const problems = await exampleProblems(op);
    // 1: query is text, so it is a body (and a good one). 3: confirm is no field of the body, so it
    // is a request, and its body is good. 2: either reading is possible, so it is said.
    expect(problems.filter((p) => !p.startsWith('test.examples.note example 2'))).toEqual([]);
    expect(problems).toContain(
      'test.examples.note example 2: it reads as a whole request, but body and note are also fields of the body, so it may have been ' +
        'meant as the body alone. Put the body under "body" and add "confirm": [] beside it, so it reads one way only.',
    );
    expect(examplesOf(op)[2]).toEqual({ body: { body: 'hello', note: 'x' } });
  });

  it('a good example has no problems', async () => {
    expect(await exampleProblems(exampleOp([{ name: 'Acme' }, { body: { name: 'Acme', qty: 2 } }]))).toEqual([]);
    const withParam = exampleOp([{ params: { id: 'a1' }, body: { name: 'A' } }], { id: 'test.examples.param', route: '/api/test-examples/[id]', params: ['id'] });
    expect(await exampleProblems(withParam)).toEqual([]);
  });

  it('a bad example is reported by operation id and example number, with what is wrong', async () => {
    const op = exampleOp([
      { qty: 0 },
      { name: 'A', password: 'hunter2' },
      { body: { name: 'A', allowDuplicateNumber: true } },
      { body: { name: 'A' }, confirm: ['allowDuplicateNumber'] },
      { name: 'A', colour: 'red' },
    ]);
    const problems = await exampleProblems(op);
    expect(problems).toEqual(
      expect.arrayContaining([
        'test.examples example 1 body $: must have name',
        'test.examples example 1 body $.qty: must be at least 1',
        // The password is not described (so the strict body refuses it) and the guards take it out.
        'test.examples example 2 body $: must not have password',
        'test.examples example 2: it sends body.password, which an agent never sends (the guards take it out).',
        // A confirmation the operation does not take.
        'test.examples example 3 body $: must not have allowDuplicateNumber',
        'test.examples example 3: it sends body.allowDuplicateNumber, which an agent never sends (the guards take it out).',
        expect.stringMatching(/^test\.examples example 4: the guards would refuse it: "allowDuplicateNumber" is not a confirmation/),
        'test.examples example 5 body $: must not have colour',
      ]),
    );
    expect(problems.every((p) => p.startsWith('test.examples example '))).toBe(true);
    // A missing path parameter, and a body for an operation that takes none.
    const param = exampleOp([{ body: { name: 'A' } }], { id: 'test.examples.param2', route: '/api/test-examples/[id]', params: ['id'] });
    expect(await exampleProblems(param)).toEqual([expect.stringMatching(/^test\.examples\.param2 example 1: the guards would refuse it: This needs the id/)]);
    const none = exampleOp([{ body: { x: 1 } }], { id: 'test.examples.none', method: 'GET', body: 'none', bodySchema: null });
    expect(await exampleProblems(none)).toEqual(['test.examples.none example 1: it sends a body, but this operation takes none.']);
  });
});

describe('operation schemas: caching and failures', () => {
  it('describes an operation once and hands every caller the same frozen answer', async () => {
    const op = allOperations().find((o) => o.bodySchema && queryRefOf(o) === null)!;
    const a = await describeSchemas(op);
    const b = await describeSchemas(op);
    expect(b).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.body)).toBe(true);
    expect(() => {
      (a.body as Record<string, unknown>).type = 'array'; // modules are strict: a frozen write throws
    }).toThrow();
    expect(await loadBodySchema(op)).toBe(await loadBodySchema(op));
  });

  it('an edited copy of an operation does not get the cached schema of the real one', async () => {
    const real = allOperations().find((o) => o.bodySchema)!;
    const other = allOperations().find((o) => o.bodySchema && o.bodySchema !== real.bodySchema)!;
    await describeSchemas(real);
    const copy = { ...real, bodySchema: other.bodySchema };
    expect(await describeSchemas(copy)).toEqual(await describeSchemas(other));
    expect(await describeSchemas(copy)).not.toEqual(await describeSchemas(real));
  });

  it('a schema that is not in the import map: loading says what to do, describing still answers', async () => {
    const op = fakeOperation({ id: 'test.missing', bodySchema: '@/lib/validation/nowhere#nothing' });
    await expect(loadBodySchema(op)).rejects.toThrow(/not in the list of known schemas.*npm run agent:registry/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = await describeSchemas(op);
    expect(first.query).toBeNull();
    expect((first.body as Record<string, unknown>).description).toMatch(/could not describe this body/);
    // Not kept: a later call tries again (and gets a new answer object).
    expect(await describeSchemas(op)).not.toBe(first);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a reference that is not a zod schema, or whose module fails, is refused', async () => {
    await expect(loadBodySchema(fakeOperation({ id: 'test.not-zod', bodySchema: '@/test/fake#notZod' }))).rejects.toThrow(
      /does not name a zod schema/,
    );
    await expect(loadBodySchema(fakeOperation({ id: 'test.throws', bodySchema: '@/test/fake#throws' }))).rejects.toThrow(
      /module failed to load/,
    );
  });

  it('an operation that names no schema has none', async () => {
    const op = fakeOperation({ id: 'test.none', bodySchema: null });
    expect(await loadBodySchema(op)).toBeNull();
    expect(await describeSchemas(op)).toEqual({ body: null, query: null });
  });

  it("keeps the app's own field names (plan §6.3: no second naming layer)", async () => {
    // Through the real path: a known schema, read back as JSON Schema with the same field names.
    const op = allOperations().find((o) => o.bodySchema === '@/lib/validation/lists#bulkSchema')!;
    expect(op).toBeDefined();
    const zod = (await loadBodySchema(op)) as z.ZodTypeAny;
    const { body } = await describeSchemas(op);
    const props = Object.keys(((body as Record<string, unknown>).properties ?? {}) as object);
    const shape = zod instanceof z.ZodObject ? Object.keys(zod.shape) : props;
    expect(props).toEqual(shape);
  });
});

// ---------------------------------------------------------------------------
// Wave 4: the routes that read their body by hand got schemas (plan §6.3)
// ---------------------------------------------------------------------------

/** Each operation and the schema its route now checks its body with (lib/validation). */
const HAND_READ_ROUTES: Array<[string, string]> = [
  ['ai.posts.undo', '@/lib/validation/ai#undoAiPostSchema'],
  ['assemblies.pending.create', '@/lib/validation/assemblies#createPendingBuildSchema'],
  ['assemblies.replace', '@/lib/validation/assemblies#setBomSchema'],
  ['assemblies.update', '@/lib/validation/assemblies#setBomSchema'],
  ['bank-accounts.create', '@/lib/validation/bankTransactions#createBankAccountSchema'],
  ['billing-groups.create', '@/lib/validation/billingGroups#createBillingGroupSchema'],
  ['billing-groups.update', '@/lib/validation/billingGroups#updateBillingGroupSchema'],
  ['currencies.fx-adjustment', '@/lib/validation/currencies#fxAdjustmentSchema'],
  ['custom-fields.values', '@/lib/validation/company#customFieldValuesSchema'],
  ['customer-prices.create', '@/lib/validation/pricing#setCustomerPriceSchema'],
  ['demo-feed', '@/lib/validation/bankTransactions#loadDemoFeedSchema'],
  ['errors.apply', '@/lib/validation/ai#applyCorrectionSchema'],
  ['fifo.adjust', '@/lib/validation/inventory#fifoActionSchema'],
  ['inventory-transfers.action', '@/lib/validation/inventorySites#voidInventoryTransferSchema'],
  ['invoices.post-draft', '@/lib/validation/invoices#postDraftInvoiceSchema'],
  ['landed-cost.action', '@/lib/validation/inventorySites#voidLandedCostSchema'],
  ['lists.action', '@/lib/validation/lists#simpleListEntrySchema'],
  ['pay-liabilities.by-item.pay', '@/lib/validation/liabilities#payLiabilitiesByItemSchema'],
  ['pay-liabilities.checks.action', '@/lib/validation/liabilities#voidLiabilityCheckSchema'],
  ['print-queue.refunds.add', '@/lib/validation/purchases#queueRefundCheckSchema'],
  ['reconciliations.pay', '@/lib/validation/reconciliations#payCreditCardBalanceSchema'],
  ['sales-forms.flags.update', '@/lib/validation/sales#sendFlagsUpdateSchema'],
  ['sales-reps.assign', '@/lib/validation/salesReps#assignSalesRepSchema'],
  ['sales-reps.create', '@/lib/validation/salesReps#createSalesRepSchema'],
  ['sales-reps.update', '@/lib/validation/salesReps#updateSalesRepSchema'],
  ['sales-tax.payments.action', '@/lib/validation/liabilities#voidSalesTaxPaymentSchema'],
];

const ID = '7d3c1f9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

/**
 * Bodies each route takes today, odd values included: past the handler's own checks, and either
 * used as they are or turned away by the service with its own message. The schema the route now
 * checks first must let every one of them through, so a person's request is answered as before.
 */
const STILL_ACCEPTED: Array<[string, string, unknown]> = [
  ['reconciliations.pay', 'service-checked fields of any type', { paymentAccountId: ID, amount: 'x', date: 5, memo: 3, exchangeRate: {} }],
  ['reconciliations.pay', 'only the bank account', { paymentAccountId: ID }],
  [
    'pay-liabilities.by-item.pay',
    'item rows of any shape, check fields of any type',
    { date: '2026-03-01', paymentAccountId: ID, items: [{ name: 'Federal Withholding', amount: '100.00' }, 'x', { amount: 5 }], vendorId: 7, payeeName: 3, toPrint: 'yes', checkNumber: 1001, memo: {} },
  ],
  ['sales-tax.payments.action', 'void', { action: 'void' }],
  ['pay-liabilities.checks.action', 'void with extras', { action: 'void', reason: 'x' }],
  ['currencies.fx-adjustment', 'a loss as a number', { accountId: ID, amount: 12.5, gain: false, date: '2026-03-01', memo: null }],
  ['assemblies.replace', 'no components (clears the list)', { assemblyItemId: ID }],
  ['assemblies.replace', 'a row the service refuses in its own words', { assemblyItemId: ID, components: [{ componentItemId: '', quantity: null }] }],
  ['assemblies.update', 'components of the wrong type', { assemblyItemId: ID, components: 'x' }],
  ['assemblies.pending.create', 'a memo of any type', { assemblyItemId: ID, quantity: '2', date: '2026-03-01', memo: 5 }],
  [
    'fifo.adjust',
    'receive with site fields of any type',
    { action: 'receive', itemId: ID, quantity: 5, unitCost: '2.50', date: '2026-03-01', siteId: 3, serialNumbers: 'x', lotExpiration: 7, classId: '', memo: null },
  ],
  ['fifo.adjust', 'consume with a quantity the route turns into text', { action: 'consume', itemId: ID, quantity: [5], date: '2026-03-01' }],
  ['fifo.adjust', 'consume with a quantity of any type', { action: 'consume', itemId: ID, quantity: { n: 1 }, date: '2026-03-01', adjustmentAccountId: 4 }],
  ['inventory-transfers.action', 'void', { action: 'void' }],
  ['landed-cost.action', 'void', { action: 'void' }],
  ['invoices.post-draft', 'no flags', {}],
  ['invoices.post-draft', 'a body that is not an object', null],
  ['invoices.post-draft', 'a list as the body', [1, 2]],
  ['invoices.post-draft', 'flags that are not exactly true', { overrideCreditLimit: 'yes', allowOverBilling: 1 }],
  ['print-queue.refunds.add', 'a memo of any type', { entryId: ID, memo: 5 }],
  ['ai.posts.undo', 'undo', { action: 'undo', id: 'any-text' }],
  ['errors.apply', 'only the correction', { correctionId: ID }],
  ['errors.apply', 'approved of any type, no entry', { correctionId: ID, approved: 'yes', entry: null }],
  [
    'errors.apply',
    'an edited entry with loosely read line fields',
    { correctionId: ID, approved: true, entry: { date: '2026-03-01', description: 'Fix', lines: [{ accountId: ID, debit: 5, credit: {}, memo: 3, entityType: 'x', entityId: 4 }] } },
  ],
  ['bank-accounts.create', 'nothing (the service says what is missing)', {}],
  ['bank-accounts.create', 'fields of any type', { bankName: 5, accountId: 'x', accountNumber: 7 }],
  ['demo-feed', 'a bank account', { bankAccountId: ID }],
  ['billing-groups.create', 'nothing (the service says what is missing)', {}],
  ['billing-groups.create', 'fields of any type', { name: 5, customerIds: 'x' }],
  ['billing-groups.update', 'customers to add of any type', { addCustomerIds: [1], name: null }],
  ['custom-fields.values', 'values of any type', { entity: 'item', id: ID, values: { Region: 5, Other: null, Size: { a: 1 } } }],
  ['customer-prices.create', 'nothing (the service says what is missing)', {}],
  ['customer-prices.create', 'fields of any type', { customerId: 5, itemId: 'x', price: 'abc' }],
  ['lists.action', 'nothing (the service says what is missing)', {}],
  ['lists.action', 'a body that is not an object', 5],
  ['lists.action', 'fields the list schema refuses in its own words', { name: '', netDays: 'x', kind: 'weird', taxable: 'yes', code: 'TOOLONG', address: 'x' }],
  ['sales-forms.flags.update', 'no flags', {}],
  ['sales-forms.flags.update', 'flags that are not true or false', { toBePrinted: 'yes', toBeEmailed: 1 }],
  ['sales-reps.create', 'a rate and an email the service checks', { name: 'Pat Lee', email: 'not-an-email', commissionRate: 'x' }],
  ['sales-reps.update', 'nothing', {}],
  ['sales-reps.update', 'a numeric rate the service refuses in its own words', { commissionRate: 5 }],
  ['sales-reps.update', 'a null email and a null rate (clears the email, sets the rate to 0)', { name: 'Pat Lee', email: null, commissionRate: null }],
  ['sales-reps.assign', 'a rep id of any type', { invoiceId: ID, salesRepId: 5 }],
  ['sales-reps.assign', 'no rep (takes it off)', { invoiceId: ID }],
];

describe('operation schemas: the routes that read their body by hand (wave 4)', () => {
  const byId = (id: string) => allOperations().find((o) => o.id === id);

  it('each of them names its schema, which loads and is described', async () => {
    const problems: string[] = [];
    for (const [id, ref] of HAND_READ_ROUTES) {
      const op = byId(id);
      if (!op) {
        problems.push(`${id}: not in the registry`);
        continue;
      }
      if (op.bodySchema !== ref) problems.push(`${id}: body schema ${op.bodySchema}, expected ${ref}`);
      const body = (await describeSchemas(op)).body as Record<string, unknown> | null;
      if (!body || body.type !== 'object') problems.push(`${id}: no object body schema`);
    }
    expect(problems).toEqual([]);
  });

  it.each(STILL_ACCEPTED)('%s accepts what its route took before: %s', async (id, _what, body) => {
    const op = byId(id);
    expect(op, id).toBeDefined();
    const schema = await loadBodySchema(op!);
    const parsed = schema!.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it('still refuses a value the service could never use, where the route checks the field itself', async () => {
    const refused: Array<[string, unknown]> = [
      ['currencies.fx-adjustment', { accountId: ID, amount: '5', gain: 'true', date: '2026-03-01' }],
      ['fifo.adjust', { action: 'receive', itemId: ID, quantity: [5], unitCost: '1', date: '2026-03-01' }],
      ['assemblies.pending.create', { assemblyItemId: 7, quantity: '1', date: '2026-03-01' }],
      ['landed-cost.action', { action: 'edit' }],
    ];
    for (const [id, body] of refused) {
      const schema = await loadBodySchema(byId(id)!);
      expect(schema!.safeParse(body).success, id).toBe(false);
    }
  });

  it('sales-reps.update says what the route does with each field, and refuses the null name the service cannot read', async () => {
    const op = byId('sales-reps.update')!;
    const schema = await loadBodySchema(op);
    // The service calls name.trim() on it: the route answered 500. Now a 400 that says what to do.
    const nullName = schema!.safeParse({ name: null });
    expect(nullName.success).toBe(false);
    expect(nullName.success ? '' : nullName.error.issues[0].message).toMatch(/leave the name out/);
    // The route hands the service every field, so an email left out is cleared: the text says so.
    const fields = ((await describeSchemas(op)).body as { properties: Record<string, { description?: string }> }).properties;
    expect(fields.email.description).toMatch(/leaving it out, or sending null or empty text, clears it/);
    expect(fields.email.description).not.toMatch(/leave out to keep/i);
    expect(fields.commissionRate.description).toMatch(/null sets it to 0/);
  });

  it('the inventory cogs quantity is read as the route reads it (String), so [5] is taken as before', async () => {
    const op = byId('inventory.adjust')!;
    expect(op.bodySchema).toBe('@/lib/validation/inventory#inventoryActionSchema');
    const schema = await loadBodySchema(op);
    expect(schema!.safeParse({ action: 'cogs', itemId: ID, quantity: [5], date: '2026-03-01' }).success).toBe(true);
    // Still required: the route refuses a missing one first, and the description says it is needed.
    expect(schema!.safeParse({ action: 'cogs', itemId: ID, date: '2026-03-01' }).success).toBe(false);
    const described = (await describeSchemas(op)).body as Record<string, unknown>;
    const branches = [...((described.anyOf ?? described.oneOf ?? []) as Array<Record<string, unknown>>)];
    const cogs = branches.find((b) => JSON.stringify(b.properties ?? {}).includes('"const":"cogs"'));
    expect(cogs, JSON.stringify(described).slice(0, 300)).toBeDefined();
    expect(cogs!.required).toEqual(expect.arrayContaining(['quantity']));
  });
});
