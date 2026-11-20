/**
 * Agent full access: the operation registry is complete (plan §10, "Registry completeness").
 * Fail closed: every route + method a person can reach is an operation, has a handler and a loader,
 * has a unique id and has a hand-written classification.
 *
 * The generated files are checked by running the generator itself in --check mode, so a route
 * change without `npm run agent:registry` fails here rather than at run time.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { API_ROUTE_PERMISSIONS, HTTP_METHODS, routePatternFromFile } from '@/lib/permissions/routes';
import { OPERATION_CLASSES } from '@/lib/agent/operations/classes';
import { CLASS_BUCKET_NAMES, bucketOfRoute } from '@/lib/agent/operations/classes/buckets';
import { GENERATED_ROUTES } from '@/lib/agent/operations/routes.generated';
import { ROUTE_LOADERS } from '@/lib/agent/operations/loaders.generated';
import { allOperations, idCollisions, operationById, operationForRoute } from '@/lib/agent/operations/registry';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import { operationKey } from '@/lib/agent/operations/types';

const root = path.resolve(__dirname, '..');

/** Every route + method of the route map ("POST /api/invoices"). */
const mapKeys = Object.entries(API_ROUTE_PERMISSIONS)
  .flatMap(([pattern, rules]) => HTTP_METHODS.filter((m) => rules[m] !== undefined).map((m) => operationKey(m, pattern)))
  .sort();

/** Every exported handler the generator read from app/api. */
const handlerKeys = Object.entries(GENERATED_ROUTES)
  .flatMap(([pattern, r]) => HTTP_METHODS.filter((m) => r.methods[m]).map((m) => operationKey(m, pattern)))
  .sort();

const minus = (a: string[], b: string[]) => {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
};

describe('agent operation registry: completeness', () => {
  it('has an operation for every route + method of the route map, and nothing else', () => {
    const opKeys = allOperations()
      .filter((o) => o.kind === 'route')
      .map((o) => operationKey(o.method, o.route))
      .sort();
    expect(minus(mapKeys, opKeys), 'routes in lib/permissions/routes.ts with no operation').toEqual([]);
    expect(minus(opKeys, mapKeys), 'operations that are not in lib/permissions/routes.ts').toEqual([]);
    expect(mapKeys.length).toBeGreaterThan(700);
  });

  it('every exported handler is in the route map, and every mapped method has a handler', () => {
    expect(
      minus(handlerKeys, mapKeys),
      'handlers exported by app/api/**/route.ts but missing from API_ROUTE_PERMISSIONS (lib/permissions/routes.ts)',
    ).toEqual([]);
    expect(
      minus(mapKeys, handlerKeys),
      'methods in API_ROUTE_PERMISSIONS that no route file exports (remove them, or run `npm run agent:registry`)',
    ).toEqual([]);
    // HEAD and OPTIONS have no rule in the route map and are not operations. A route that exports
    // one is answered outside the map's checks, so each needs a deliberate place on this list.
    const allowedOther = new Set<string>([]);
    const other = Object.entries(GENERATED_ROUTES)
      .flatMap(([pattern, r]) => (r.otherMethods ?? []).map((m) => `${m} ${pattern}`))
      .filter((k) => !allowedOther.has(k));
    expect(other, 'HEAD or OPTIONS handlers in app/api: remove them, or allow each one here with a reason').toEqual([]);
  });

  it('pins every operation id (a changed id is a breaking change)', async () => {
    const lines = allOperations().map((o) =>
      o.kind === 'shell' ? `SHELL ${o.route} -> ${o.id}` : `${o.method} ${o.route} -> ${o.id}`,
    );
    const text = [
      '# Agent operation ids, one line per API route + method: METHOD route -> id.',
      '# Then one line per desktop-shell or server operation (lib/agent/operations/shell.ts): SHELL flow -> id.',
      '# Pinned by test/agentRegistry.test.ts. Standing permissions, stored permission requests and',
      '# MCP clients name operations by these ids, so changing a line breaks them.',
      "# Keep an old id: give the route's classification id: '<old id>' (lib/agent/operations/classes).",
      '# Accept new or changed ids: npx vitest run test/agentRegistry.test.ts -u',
      ...lines,
      '',
    ].join('\n');
    await expect(text).toMatchFileSnapshot(
      '../lib/agent/operations/operation-ids.txt',
      'Operation ids changed (lib/agent/operations/registry.ts, operationIdFor explains the rule). A new route ' +
        "adds lines; a changed line renames an operation that agents' standing permissions and stored " +
        "requests use. To keep the old id, give the classification id: '<old id>'. To accept, run " +
        '`npx vitest run test/agentRegistry.test.ts -u` and commit operation-ids.txt.',
    );
  });

  it('reads what a handler answers, including through the shared response helpers', () => {
    const output = (method: 'GET' | 'POST', pattern: string) => GENERATED_ROUTES[pattern]?.methods[method]?.output;
    // pdfResponse (lib/routeErrors.ts)
    expect(output('GET', '/api/invoices/[id]/pdf')).toBe('pdf');
    expect(output('GET', '/api/sales-forms/[kind]/[id]/pdf')).toBe('pdf');
    expect(output('POST', '/api/letters/prepare')).toBe('pdf'); // JSON on some answers, a PDF on the rest
    // fileResponse (lib/fileDownload.ts)
    expect(output('POST', '/api/portable')).toBe('file');
    expect(output('POST', '/api/period-copy')).toBe('file');
    // A raw Response written in the route file
    expect(output('POST', '/api/ai/assistant')).toBe('stream');
    expect(output('GET', '/api/backup')).toBe('file');
    expect(output('GET', '/api/payroll/w2')).toBe('pdf');
    expect(output('GET', '/api/invoices')).toBe('json');
    // Every route file that calls a response helper is read as a PDF or a file, never JSON.
    const helperFiles = Object.values(GENERATED_ROUTES).filter((r) =>
      /\b(pdfResponse|fileResponse)\(/.test(fs.readFileSync(path.join(root, r.file), 'utf8')),
    );
    expect(helperFiles.length).toBeGreaterThan(10);
    const asJson = helperFiles.flatMap((r) =>
      Object.entries(r.methods)
        .filter(([, m]) => m?.output === 'json')
        .map(([method]) => `${method} ${r.file}`),
    );
    // A file may also export a method that answers JSON only: these GETs say what a copy holds.
    expect(asJson.sort()).toEqual([
      'GET app/api/accountant-copy/changes/route.ts',
      'GET app/api/accountant-copy/route.ts',
    ]);
  });

  it('reads each route file under the pattern the route map uses', () => {
    const wrong = Object.entries(GENERATED_ROUTES)
      .filter(([pattern, r]) => routePatternFromFile(r.file) !== pattern || !fs.existsSync(path.join(root, r.file)))
      .map(([pattern, r]) => `${pattern} <- ${r.file}`);
    expect(wrong).toEqual([]);
  });

  it('every handler a person reaches through the route map gets its context the checked way', () => {
    // The route bridge runs a handler for an agent by scoping getServerContext, so a handler of an
    // area or member route that found its context some other way would escape the agent's checks.
    // Stricter than lib/permissions/routes.test.ts, which looks at whole files.
    const portal = new Set(['GET /api/portal/me']); // its own portal session, as in routes.test.ts
    const problems: string[] = [];
    for (const [pattern, rules] of Object.entries(API_ROUTE_PERMISSIONS)) {
      for (const m of HTTP_METHODS) {
        const rule = rules[m];
        const meta = GENERATED_ROUTES[pattern]?.methods[m];
        if (rule === undefined || !meta) continue;
        const key = operationKey(m, pattern);
        if ((typeof rule === 'object' || rule === 'member') && !meta.serverContext) problems.push(`${key}: never calls getServerContext()`);
        if (rule === 'self' && !portal.has(key) && !meta.serverContext && !meta.sessionGate) {
          problems.push(`${key}: never calls getSessionGate() / getServerContext()`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('gives every operation a unique id', () => {
    const collisions = idCollisions();
    expect(
      collisions.map((c) => `${c.id}: ${c.keys.join(' | ')}`),
      'These operations share an id. Give one of each its own "id" in lib/agent/operations/classes/<bucket>.ts',
    ).toEqual([]);
    const routeShape = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
    // Shell ids are written by hand in shell.ts with the names plan §5.5 gives them, some of which
    // join words the camelCase way (shell.company.saveCopyAs); still dotted words, no spaces.
    const shellShape = /^[a-z][a-zA-Z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-zA-Z0-9]*(?:-[a-z0-9]+)*)+$/;
    const badShape = allOperations()
      .filter((o) => !(o.kind === 'shell' ? shellShape : routeShape).test(o.id))
      .map((o) => o.id);
    expect(badShape, 'ids are lower-case words with hyphens (shell ids may be camelCase words), joined by dots').toEqual([]);
  });

  it('has every shell operation of lib/agent/operations/shell.ts, classified, and out of reach of any route', () => {
    const shell = allOperations().filter((o) => o.kind === 'shell');
    expect(shell.map((o) => o.id), 'the shell operations are exactly the definitions, in order').toEqual(
      SHELL_OPERATIONS.map((d) => d.id),
    );
    const problems: string[] = [];
    for (const def of SHELL_OPERATIONS) {
      const op = operationById(def.id);
      if (!op || op.kind !== 'shell') problems.push(`${def.id}: not a shell operation in the registry`);
      else if (!op.classified) problems.push(`${def.id}: class "${String(def.class)}" is not a risk class`);
      else if (!op.alwaysAsk || op.dryRun !== 'none' || op.rule !== null) problems.push(`${def.id}: must always ask, with no dry run and no route rule`);
      if (operationForRoute('POST', def.flow)) problems.push(`${def.id}: its flow name "${def.flow}" is also a route`);
    }
    expect(problems).toEqual([]);
  });

  it('has up-to-date generated files (scripts/agent-registry.mjs --check)', () => {
    let out = '';
    let failed = false;
    try {
      out = execFileSync(process.execPath, [path.join(root, 'scripts', 'agent-registry.mjs'), '--check'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, out).toBe(false);
    expect(out).toMatch(/up to date/);
  }, 60_000);

  it('has a loader for every route pattern, pointing at that route file', () => {
    const patterns = Object.keys(API_ROUTE_PERMISSIONS).sort();
    expect(minus(patterns, Object.keys(ROUTE_LOADERS)), 'patterns with no loader').toEqual([]);
    const text = fs.readFileSync(path.join(root, 'lib/agent/operations/loaders.generated.ts'), 'utf8').replace(/\r\n/g, '\n');
    const entries = [...text.matchAll(/^ {2}'([^']+)': \(\) => import\('@\/([^']+)'\),$/gm)];
    expect(entries.length).toBe(Object.keys(ROUTE_LOADERS).length);
    const wrong = entries
      .filter(([, pattern, spec]) => !fs.existsSync(path.join(root, `${spec}.ts`)) || routePatternFromFile(`${spec}.ts`) !== pattern)
      .map(([, pattern, spec]) => `${pattern} -> ${spec}`);
    expect(wrong).toEqual([]);
  });

  it('names body and query schemas that exist', async () => {
    const refs = new Set<string>();
    for (const r of Object.values(GENERATED_ROUTES)) {
      for (const m of Object.values(r.methods)) {
        if (m?.bodySchema) refs.add(m.bodySchema);
        if (m?.querySchema) refs.add(m.querySchema);
        for (const c of m?.bodySchemaCandidates ?? []) refs.add(c);
      }
    }
    for (const c of Object.values(OPERATION_CLASSES)) if (c.bodySchema) refs.add(c.bodySchema);
    expect(refs.size).toBeGreaterThan(100);
    const broken: string[] = [];
    for (const ref of [...refs].sort()) {
      const [mod, name] = ref.split('#');
      const loaded = (await import(/* @vite-ignore */ mod)) as Record<string, unknown>;
      const schema = loaded[name] as { safeParse?: unknown } | undefined;
      if (typeof schema?.safeParse !== 'function') broken.push(ref);
    }
    expect(broken, 'schema references that do not name an exported zod schema').toEqual([]);
  }, 60_000);

  it('has no classification entry for a route + method that does not exist', () => {
    const stale = minus(Object.keys(OPERATION_CLASSES).sort(), mapKeys);
    expect(stale, 'classification keys that are not in lib/permissions/routes.ts (a typo leaves the real route unclassified)').toEqual([]);
  });

  // Every route is classified today. A new route fails this until its bucket's file
  // (lib/agent/operations/classes/<bucket>.ts) names it; until then it runs as class 'admin'
  // (always ask an Admin).
  it('classifies every operation', () => {
    const missing = allOperations().filter((o) => o.kind === 'route' && !o.classified);
    const groups = new Map<string, string[]>();
    for (const op of missing) {
      const bucket = bucketOfRoute(op.route) ?? '(no bucket: add the segment to classes/buckets.ts)';
      groups.set(bucket, [...(groups.get(bucket) ?? []), operationKey(op.method, op.route)]);
    }
    const order = [...CLASS_BUCKET_NAMES, ...[...groups.keys()].filter((k) => !(CLASS_BUCKET_NAMES as readonly string[]).includes(k))];
    const summary = order.filter((b) => groups.has(b)).map((b) => `  ${b}: ${groups.get(b)!.length}`);
    const detail = order
      .filter((b) => groups.has(b))
      .map((b) => `${b} (lib/agent/operations/classes/${b}.ts), ${groups.get(b)!.length} missing:\n    ${groups.get(b)!.join('\n    ')}`);
    expect(
      missing.length,
      `${missing.length} of ${mapKeys.length} operations have no classification yet:\n${summary.join('\n')}\n\n${detail.join('\n\n')}\n`,
    ).toBe(0);
  });
});
