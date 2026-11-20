/**
 * The body and query schemas of every operation (lib/agent/operations/schemas.ts), plan §6.3:
 * every schema the registry names loads through the generated import map and turns into a JSON
 * Schema object, and shell operations get theirs from their input fields. A field the guards take
 * out of an agent's input (a password, a setting only a person changes) is never described.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ShellOperationDef } from '../contract';
import { JSON_SCHEMA_DRAFT } from '../jsonSchema';
import { allOperations } from './registry';
import { GENERATED_ROUTES } from './routes.generated';
import { SCHEMA_LOADERS } from './schemas.generated';
import { describeSchemas, loadBodySchema, shellBodySchema } from './schemas';
import type { Operation } from './types';

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

vi.mock('./shell', async (importOriginal) => {
  const real = await importOriginal<typeof import('./shell')>();
  return { ...real, SHELL_OPERATIONS: [...real.SHELL_OPERATIONS, TEST_SHELL] };
});

/** Two references only these tests know: one that is not a zod schema, one whose module fails. */
vi.mock('./schemas.generated', async (importOriginal) => {
  const real = await importOriginal<typeof import('./schemas.generated')>();
  return {
    SCHEMA_LOADERS: {
      ...real.SCHEMA_LOADERS,
      '@/test/fake#notZod': async () => ({ parse: () => null }),
      '@/test/fake#throws': async () => {
        throw new Error('module failed to load');
      },
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
    // No description on the root: the operation's describe sentence has {field} placeholders, and
    // describe_operation shows it already.
    expect(body).toEqual({
      $schema: JSON_SCHEMA_DRAFT,
      type: 'object',
      properties: {
        folder: { type: 'string', minLength: 1, description: 'A folder or file path on this computer. Where the copy goes' },
        name: { type: 'string', description: 'File name of the copy' },
        keepOpen: { type: 'boolean', description: 'Stay in this company afterwards' },
        copies: { type: 'number', description: 'How many copies' },
        logoFile: {
          type: 'string',
          minLength: 1,
          description: 'The fileId of a file you staged with upload_file. A logo to put on the copy',
        },
      },
      required: ['folder', 'copies'],
      additionalProperties: false,
    });
  });

  it('a shell operation with no fields takes an empty object; an unknown one has no body', async () => {
    const empty = shellBodySchema({ ...TEST_SHELL, input: {} });
    expect(empty.safeParse({}).success).toBe(true);
    expect(empty.safeParse({ x: 1 }).success).toBe(false);
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

    const ai = await described('ai.settings.update');
    const provider = ((ai.properties as Record<string, Record<string, unknown>>).providers.items ?? {}) as Record<string, unknown>;
    expect(props(provider)).toContain('model');
    expect(props(provider)).not.toContain('apiKey');

    const company = await described('company.update');
    const settings = (company.properties as Record<string, unknown>).settings;
    expect(props(settings)).toContain('legalName');
    for (const name of ['integratedAppsBlocked', 'allowEmployeePortal', 'allowPhoneReceipts']) expect(props(settings)).not.toContain(name);
  });

  it('no body or query of any operation lists a secret field, at any depth', async () => {
    const found: string[] = [];
    for (const op of allOperations()) {
      const d = await describeSchemas(op);
      for (const [part, schema] of [['body', d.body], ['query', d.query]] as const) {
        for (const p of propertyNames(schema)) {
          if (SECRET_NAMES.includes(p.split('.').pop()!)) found.push(`${op.id} ${part} ${p}`);
        }
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
