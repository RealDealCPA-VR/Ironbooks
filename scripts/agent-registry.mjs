#!/usr/bin/env node
/**
 * Agent full access: writes the generated half of the operation registry (plan §5.1).
 *
 *   node scripts/agent-registry.mjs           write the three files below
 *   node scripts/agent-registry.mjs --check   exit 1 when the files on disk are out of date
 *
 * It walks app/api/**\/route.ts, reads each file with the TypeScript parser (nothing is run or
 * imported) and writes:
 *
 *  - lib/agent/operations/routes.generated.ts: pure metadata, safe to import anywhere. Per route
 *    pattern: the file, the path parameter names and, per exported HTTP method, what the handler
 *    reads (body kind and the zod schema it parses the body with), what it answers (JSON, a PDF,
 *    a file or a stream) and whether it gets its context from getServerContext / getSessionGate.
 *  - lib/agent/operations/loaders.generated.ts: SERVER ONLY. A static import map
 *    pattern -> () => import('@/app/api/.../route'), so the bundler includes every handler the
 *    route bridge may run.
 *  - lib/agent/operations/schemas.generated.ts: SERVER ONLY. A static import map from every zod
 *    schema reference the registry knows ("@/lib/validation/x#name": the body and query schemas
 *    read above, and the `bodySchema` the classification files name, read the same way) to a
 *    loader of that schema. describe_operation turns them into JSON Schema
 *    (lib/agent/operations/schemas.ts); written out so the bundler includes each one.
 *
 * Only a schema the route file imports can be named (and so loaded); a handler that parses its body
 * with a schema written inside the route file is listed by inlineBodySchemas() and warned about.
 *
 * What it reports are HINTS read from the source. The hand-written classification
 * (lib/agent/operations/classes/*.ts) has the last word: it can name a body schema, a body kind or
 * an output kind the reader could not see. test/agentRegistry.test.ts runs this in --check mode, so
 * a route change without a regenerate fails the tests; `npm run build` regenerates first.
 *
 * Output is deterministic: patterns sorted by plain string order, methods in a fixed order, "\n"
 * line ends, and no time stamps, so the files only change when the routes do.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'app', 'api');
const OUT_DIR = path.join(ROOT, 'lib', 'agent', 'operations');
/** The hand-written classification, one file per area (their `bodySchema` names join the schema map). */
const CLASSES_DIR = path.join(OUT_DIR, 'classes');
export const ROUTES_FILE = path.join(OUT_DIR, 'routes.generated.ts');
export const LOADERS_FILE = path.join(OUT_DIR, 'loaders.generated.ts');
export const SCHEMAS_FILE = path.join(OUT_DIR, 'schemas.generated.ts');

/** The methods routes.ts maps, in the order they are written out. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Shared helpers that read the request body for the handler (passed the request as their first
 * argument). A helper not listed here is invisible to the reader: the classification then names
 * the body kind itself.
 */
const BODY_HELPERS = {
  requireJsonObject: 'json', // lib/routeErrors.ts (reads text, parses JSON)
  readJsonObject: 'json', // lib/routeErrors.ts
  readUploadedFile: 'multipart', // app/api/receipts/_upload.ts (formData, one `file`)
};

/**
 * Shared helpers that build the handler's answer, by the name they are exported under, and the
 * output kind each means. Their content type is written in the helper, not in the route file, so
 * the raw-Response reading below cannot see it. A helper not listed here: the classification names
 * the output kind itself.
 */
const RESPONSE_HELPERS = {
  pdfResponse: 'pdf', // lib/routeErrors.ts (application/pdf, inline)
  fileResponse: 'file', // lib/fileDownload.ts (application/octet-stream, attachment)
};

/** Methods called on the request itself, and the body kind each means. */
const REQUEST_READS = {
  json: 'json',
  formData: 'multipart',
  arrayBuffer: 'bytes',
  blob: 'bytes',
  text: 'text',
};

/** When a handler reads the body more than one way, the richer kind wins. */
const BODY_RANK = { none: 0, text: 1, json: 2, bytes: 3, multipart: 4 };

const PARSE_METHODS = new Set(['safeParse', 'parse', 'safeParseAsync', 'parseAsync']);

// ---------------------------------------------------------------------------
// Walking the routes
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/^route\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Same as routePatternFromFile in lib/permissions/routes.ts (the registry test proves they agree). */
export function patternFromFile(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  const idx = norm.indexOf('app/api/');
  const tail = norm.slice(idx + 'app/'.length).replace(/\/route\.(ts|tsx|js)$/, '');
  return '/' + tail.split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/');
}

/** "[id]" -> "id", "[...slug]" -> "slug", "[[...slug]]" -> "slug". */
function paramsOf(pattern) {
  return pattern
    .split('/')
    .filter((s) => s.startsWith('[') && s.endsWith(']'))
    .map((s) => s.replace(/^\[+(\.\.\.)?/, '').replace(/\]+$/, ''));
}

// ---------------------------------------------------------------------------
// Reading one route file
// ---------------------------------------------------------------------------

function unwrap(node) {
  let n = node;
  for (;;) {
    if (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) {
      n = n.expression;
    } else if (ts.isSatisfiesExpression?.(n)) {
      n = n.expression;
    } else if (
      // (await req.json().catch(() => null)) ?? {}
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      n = n.left;
    } else if (
      // await req.json().catch(() => ({}))
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      (n.expression.name.text === 'catch' || n.expression.name.text === 'then')
    ) {
      n = n.expression.expression;
    } else {
      return n;
    }
  }
}

function isFunctionLike(n) {
  return n && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n));
}

function firstParamName(fn) {
  const p = fn.parameters?.[0];
  return p && ts.isIdentifier(p.name) ? p.name.text : null;
}

/** The '@/…' module a schema import names, so the registry can import it ('@/lib/validation/x'). */
function moduleRef(specifier, fileAbs) {
  if (specifier.startsWith('@/')) return specifier;
  if (specifier.startsWith('.')) {
    const abs = path.resolve(path.dirname(fileAbs), specifier);
    return '@/' + path.relative(ROOT, abs).replace(/\\/g, '/').replace(/\.(ts|tsx|js|mjs)$/, '');
  }
  return null; // a package: not a schema of this app
}

function analyzeFile(fileAbs) {
  const src = fs.readFileSync(fileAbs, 'utf8');
  const sf = ts.createSourceFile(fileAbs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** local name -> { module, name } for every named import. */
  const imports = new Map();
  /** Names of the file's own top-level constants (a zod schema written inside the route is one). */
  const locals = new Set();
  /** top-level function name -> function node (declarations and `const f = () => …`). */
  const functions = new Map();
  /** exported name -> local name it points at (or the function node itself). */
  const exported = new Map();

  const isExported = (node) => !!ts.getModifiers?.(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const bindings = st.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          imports.set(el.name.text, { module: st.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      functions.set(st.name.text, st);
      if (isExported(st)) exported.set(st.name.text, st.name.text);
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        locals.add(d.name.text);
        const init = unwrap(d.initializer);
        if (isFunctionLike(init)) functions.set(d.name.text, init);
        if (isExported(st)) {
          // export const PATCH = PUT;  export const GET = async (req) => …
          if (ts.isIdentifier(init)) exported.set(d.name.text, init.text);
          else if (isFunctionLike(init)) exported.set(d.name.text, d.name.text);
          else exported.set(d.name.text, null);
        }
      }
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      // export { PUT as PATCH };
      for (const el of st.exportClause.elements) exported.set(el.name.text, (el.propertyName ?? el.name).text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      // export { GET } from './x': the handler lives elsewhere; nothing to read here.
      for (const el of st.exportClause.elements) exported.set(el.name.text, null);
    }
  }

  /** The handler plus every top-level function of this file it refers to, recursively. */
  function reachable(rootName) {
    const seen = new Set();
    const out = [];
    const queue = [rootName];
    while (queue.length) {
      const name = queue.shift();
      if (name == null || seen.has(name)) continue;
      seen.add(name);
      const fn = functions.get(name);
      if (!fn) continue;
      out.push(fn);
      const visit = (n) => {
        if (ts.isIdentifier(n) && functions.has(n.text) && !seen.has(n.text)) queue.push(n.text);
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn, visit);
    }
    return out;
  }

  function analyzeHandler(rootName) {
    const fns = reachable(rootName);
    const requestNames = new Set(['req', 'request', '_req']);
    for (const fn of fns) {
      const p = firstParamName(fn);
      if (p) requestNames.add(p);
    }

    let body = 'none';
    const bump = (kind) => {
      if (BODY_RANK[kind] > BODY_RANK[body]) body = kind;
    };
    /** What a (unwrapped) expression reads from the request, or null. */
    const readKind = (expr) => {
      const n = unwrap(expr);
      if (!ts.isCallExpression(n)) return null;
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        if (requestNames.has(callee.expression.text) && REQUEST_READS[callee.name.text]) return REQUEST_READS[callee.name.text];
      }
      if (ts.isIdentifier(callee) && BODY_HELPERS[callee.text] && n.arguments.length > 0) {
        const a = unwrap(n.arguments[0]);
        if (ts.isIdentifier(a) && requestNames.has(a.text)) return BODY_HELPERS[callee.text];
      }
      return null;
    };
    const queryLike = (text) => /searchParams|nextUrl|\bsp\.get\(|fromEntries/.test(text);

    let serverContext = false;
    let sessionGate = false;
    let rawResponse = false;
    /** Output kinds of the shared response helpers the handler calls (RESPONSE_HELPERS). */
    const helperOutputs = new Set();
    const bodyVars = new Set();
    const queryVars = new Set();
    const parses = []; // { ref, arg }
    /** Parses with a schema the route file defines itself: { name, arg }. */
    const inlineParses = [];
    let text = '';

    for (const fn of fns) {
      text += fn.getText(sf) + '\n';
      const visit = (n) => {
        if (ts.isCallExpression(n)) {
          const kind = readKind(n);
          if (kind) bump(kind);
          if (ts.isIdentifier(n.expression)) {
            if (n.expression.text === 'getServerContext') serverContext = true;
            if (n.expression.text === 'getSessionGate') sessionGate = true;
            // By the imported name, so `import { pdfResponse as pdf }` counts and a local function
            // that happens to share the name does not (its own Response is read below).
            const imp = imports.get(n.expression.text);
            if (imp && Object.hasOwn(RESPONSE_HELPERS, imp.name)) helperOutputs.add(RESPONSE_HELPERS[imp.name]);
          }
          const callee = n.expression;
          if (
            ts.isPropertyAccessExpression(callee) &&
            PARSE_METHODS.has(callee.name.text) &&
            ts.isIdentifier(callee.expression) &&
            n.arguments.length > 0
          ) {
            const imp = imports.get(callee.expression.text);
            const mod = imp ? moduleRef(imp.module, fileAbs) : null;
            // Only schemas imported from this app: a schema written inside the route file cannot be
            // imported by anyone else, and JSON.parse is not a schema. One written inside the file
            // is noted, so it can be moved to lib/validation (inlineBodySchemas below).
            if (imp && mod) parses.push({ ref: `${mod}#${imp.name}`, arg: n.arguments[0] });
            else if (!imp && locals.has(callee.expression.text)) inlineParses.push({ name: callee.expression.text, arg: n.arguments[0] });
          }
        }
        if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && /^(Next)?Response$/.test(n.expression.text)) {
          const first = n.arguments?.[0];
          if (first && first.kind !== ts.SyntaxKind.NullKeyword) rawResponse = true;
        }
        // const body = await req.json();   body = await requireJsonObject(req);
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
          if (readKind(n.initializer)) bodyVars.add(n.name.text);
          else if (queryLike(n.initializer.getText(sf))) queryVars.add(n.name.text);
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
          if (readKind(n.right)) bodyVars.add(n.left.text);
        }
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn, visit);
    }

    // The fields the handler reads from its body: body.x, body?.x, body['x'], and
    // `const { x, y } = body` (or = await req.json()). Shown by describe_operation when the route
    // parses its body with no schema the registry can load.
    const bodyFields = new Set();
    for (const fn of fns) {
      const visitFields = (n) => {
        if ((ts.isPropertyAccessExpression(n) || ts.isPropertyAccessChain?.(n)) && ts.isIdentifier(n.expression) && bodyVars.has(n.expression.text)) {
          bodyFields.add(n.name.text);
        }
        if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && bodyVars.has(n.expression.text) && ts.isStringLiteral(n.argumentExpression)) {
          bodyFields.add(n.argumentExpression.text);
        }
        if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
          const init = unwrap(n.initializer);
          if (readKind(n.initializer) || (ts.isIdentifier(init) && bodyVars.has(init.text))) {
            for (const el of n.name.elements) {
              const key = el.propertyName ?? el.name;
              if (ts.isIdentifier(key) || ts.isStringLiteral(key)) bodyFields.add(key.text);
            }
          }
        }
        ts.forEachChild(n, visitFields);
      };
      ts.forEachChild(fn, visitFields);
    }
    // Methods of the value itself, not fields a caller sends.
    for (const notField of ['then', 'catch', 'length', 'map', 'filter', 'toString', 'valueOf']) bodyFields.delete(notField);

    const bodySchemas = [];
    const querySchemas = [];
    const isBodyArg = (arg) => {
      const a = unwrap(arg);
      return !!readKind(arg) || (ts.isIdentifier(a) && bodyVars.has(a.text));
    };
    for (const { ref, arg } of parses) {
      const a = unwrap(arg);
      const isBody = isBodyArg(arg);
      const isQuery = !isBody && ((ts.isIdentifier(a) && queryVars.has(a.text)) || queryLike(arg.getText(sf)));
      if (isBody && !bodySchemas.includes(ref)) bodySchemas.push(ref);
      if (isQuery && !querySchemas.includes(ref)) querySchemas.push(ref);
    }
    const inlineBody = [...new Set(inlineParses.filter(({ arg }) => isBodyArg(arg)).map(({ name }) => name))];

    // A raw Response with a body is not JSON. Which kind it is comes from the content types the
    // handler names: only PDF is "pdf"; NDJSON or server-sent events without a download name is a
    // "stream"; anything else (zip, CSV, XML, a type read from the record, PDF or CSV by choice) is
    // a "file".
    const outputs = new Set(helperOutputs);
    if (rawResponse) {
      const types = new Set(
        [...text.matchAll(/\b(?:application|text|image)\/[\w.+-]+/g)]
          .map((m) => m[0].toLowerCase())
          .filter((t) => t !== 'application/json' && t !== 'multipart/form-data'),
      );
      if (types.size === 1 && types.has('application/pdf')) outputs.add('pdf');
      else if ([...types].some((t) => /ndjson|event-stream/.test(t)) && !/content-disposition/i.test(text)) outputs.add('stream');
      else outputs.add('file');
    }
    // A handler that also answers JSON on some paths (an error, a "nothing to print") keeps the
    // binary kind: that is the one a caller must not parse as JSON. Two binary kinds (a PDF here, a
    // CSV there) are a "file".
    const output = outputs.size === 0 ? 'json' : outputs.size === 1 ? [...outputs][0] : 'file';

    return {
      // One schema read the body: that is it. None, or two depending on the input: the
      // classification names it (bodySchema) when it matters.
      bodySchema: bodySchemas.length === 1 ? bodySchemas[0] : null,
      ...(bodySchemas.length > 1 ? { bodySchemaCandidates: bodySchemas } : {}),
      querySchema: querySchemas.length === 1 ? querySchemas[0] : null,
      body,
      output,
      serverContext,
      sessionGate,
      ...(bodyFields.size && bodySchemas.length === 0 ? { bodyFields: [...bodyFields].sort() } : {}),
      // Not written to routes.generated.ts: read by inlineBodySchemas() and the warning in main().
      ...(inlineBody.length ? { inlineBodySchemas: inlineBody } : {}),
    };
  }

  const methods = {};
  const other = [];
  for (const [name, local] of exported) {
    if (!METHODS.includes(name)) {
      if (/^(HEAD|OPTIONS)$/.test(name)) other.push(name);
      continue;
    }
    methods[name] = local
      ? analyzeHandler(local)
      : { bodySchema: null, querySchema: null, body: 'none', output: 'json', serverContext: false, sessionGate: false };
    // `export { PUT as PATCH }` and `export const PATCH = PUT` run the PUT handler.
    if (local && local !== name && METHODS.includes(local)) methods[name].aliasOf = local;
    // What the file's header comment says the body is, for a method with no body schema.
    const doc = bodyDocOf(src, name);
    if (doc && methods[name].body !== 'none' && !methods[name].bodySchema && !methods[name].bodySchemaCandidates) methods[name].bodyDoc = doc;
  }
  return { methods, other };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const qs = (v) => (v == null ? 'null' : q(v));

const HEADER = `// GENERATED by scripts/agent-registry.mjs. Do not edit by hand: run \`npm run agent:registry\`.\n`;

export function collect() {
  const routes = [];
  for (const abs of walk(API_DIR)) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const { methods, other } = analyzeFile(abs);
    routes.push({ pattern: patternFromFile(rel), file: rel, params: paramsOf(patternFromFile(rel)), methods, other });
  }
  routes.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return routes;
}

/**
 * The body a route file's header comment documents for `method`: its lines that name a body
 * ("Body: { customerId, what: 'invoices' | 'statement', … }", "POST body { … }"), comment marks
 * removed, joined, at most 500 characters. A line that names another method is left out.
 */
function bodyDocOf(src, method) {
  const head = /^\s*\/\*\*([\s\S]*?)\*\//.exec(src);
  if (!head) return null;
  const lines = head[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/\bbody\b/i.test(l) || !/[{:]/.test(l)) continue;
    const other = METHODS.filter((m) => m !== method).some((m) => new RegExp(`\\b${m}\\b`).test(l));
    if (other && !new RegExp(`\\b${method}\\b`).test(l)) continue;
    let text = l;
    // "Body:" (or "Body (JSON):") alone: the fields follow on the next lines, up to a blank one.
    if (/\bbody(\s*\([^)]*\))?\s*:?\s*$/i.test(l)) {
      for (let j = i + 1; j < lines.length && j < i + 10 && lines[j] !== ''; j++) text += '; ' + lines[j];
      out.push(text.replace(/:\s*;\s*/, ': '));
      continue;
    }
    // An object that goes on over the next lines: up to its closing brace.
    let depth = (text.match(/{/g) || []).length - (text.match(/}/g) || []).length;
    for (let j = i + 1; depth > 0 && j < lines.length && j < i + 8; j++) {
      text += ' ' + lines[j];
      depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
    }
    out.push(text);
  }
  const joined = out.join(' ').replace(/\s+/g, ' ').trim();
  return joined ? joined.slice(0, 500) : null;
}

function renderMethod(m, meta) {
  const parts = [
    `bodySchema: ${qs(meta.bodySchema)}`,
    ...(meta.bodySchemaCandidates ? [`bodySchemaCandidates: [${meta.bodySchemaCandidates.map(q).join(', ')}]`] : []),
    `querySchema: ${qs(meta.querySchema)}`,
    `body: ${q(meta.body)}`,
    `output: ${q(meta.output)}`,
    `serverContext: ${meta.serverContext}`,
    `sessionGate: ${meta.sessionGate}`,
    ...(meta.aliasOf ? [`aliasOf: ${q(meta.aliasOf)}`] : []),
    ...(meta.bodyFields ? [`bodyFields: [${meta.bodyFields.map(q).join(', ')}]`] : []),
    ...(meta.bodyDoc ? [`bodyDoc: ${q(meta.bodyDoc)}`] : []),
  ];
  return `      ${m}: { ${parts.join(', ')} },`;
}

export function renderRoutes(routes) {
  const lines = [
    HEADER,
    '/**',
    ' * Agent full access: what each API route handler reads and answers, read from its source',
    ' * (scripts/agent-registry.mjs). Pure data: safe to import anywhere, imports no handler.',
    ' * lib/agent/operations/registry.ts joins it with the route map and the classification.',
    ' */',
    "import type { HttpMethod } from '@/lib/permissions/routes';",
    "import type { BodyKind, OutputKind } from './types';",
    '',
    'export interface GeneratedMethod {',
    '  /** "@/lib/validation/x#name": the one imported zod schema the handler parses the body with. */',
    '  bodySchema: string | null;',
    '  /** Set when the handler parses the body with one of several schemas (by mode or kind). */',
    '  bodySchemaCandidates?: string[];',
    '  /** The imported zod schema the handler parses its query parameters with, when it has one. */',
    '  querySchema: string | null;',
    '  /** How the handler reads the body; "none" when the reader saw no read. */',
    '  body: BodyKind;',
    '  /** What it answers: "json" unless it builds a raw Response (PDF, file download, stream). */',
    '  output: OutputKind;',
    '  /** It gets its context from getServerContext (the route map is enforced there). */',
    '  serverContext: boolean;',
    "  /** It calls getSessionGate (a 'self' route acting on the signed-in person). */",
    '  sessionGate: boolean;',
    '  /** The export is another method\'s handler (`export { PUT as PATCH }`). */',
    '  aliasOf?: HttpMethod;',
    '  /** With no body schema: the fields the handler reads from its body. */',
    '  bodyFields?: string[];',
    "  /** With no body schema: the body as the route file's header comment documents it. */",
    '  bodyDoc?: string;',
    '}',
    '',
    'export interface GeneratedRoute {',
    '  /** The route file, relative to the project root. */',
    '  file: string;',
    '  /** Path parameter names, in order ("[id]" -> "id"). */',
    '  params: string[];',
    '  /** Every HTTP method the file exports. */',
    '  methods: Partial<Record<HttpMethod, GeneratedMethod>>;',
    '  /**',
    '   * HEAD or OPTIONS handlers the file exports. They are not operations (the route map has no',
    '   * rule for them); listed so test/agentRegistry.test.ts can refuse one nobody allowed.',
    '   */',
    '  otherMethods?: string[];',
    '}',
    '',
    'export const GENERATED_ROUTES: Record<string, GeneratedRoute> = {',
  ];
  for (const r of routes) {
    lines.push(`  ${q(r.pattern)}: {`);
    lines.push(`    file: ${q(r.file)},`);
    lines.push(`    params: [${r.params.map(q).join(', ')}],`);
    lines.push('    methods: {');
    for (const m of METHODS) if (r.methods[m]) lines.push(renderMethod(m, r.methods[m]));
    lines.push('    },');
    if (r.other.length) lines.push(`    otherMethods: [${[...r.other].sort().map(q).join(', ')}],`);
    lines.push('  },');
  }
  lines.push('};', '');
  return lines.join('\n');
}

export function renderLoaders(routes) {
  const lines = [
    HEADER,
    '/**',
    ' * Agent full access: SERVER ONLY. One loader per API route pattern, written out as a static',
    ' * import so the bundler includes every handler the route bridge may run in-process. Nothing is',
    ' * loaded until a loader is called; import this lazily (lib/agent/operations/registry.ts',
    ' * loadRouteHandler does).',
    ' */',
    '',
    'export const ROUTE_LOADERS: Record<string, () => Promise<object>> = {',
  ];
  for (const r of routes) {
    const spec = '@/' + r.file.replace(/\.(ts|tsx|js)$/, '');
    lines.push(`  ${q(r.pattern)}: () => import(${q(spec)}),`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Schema references
// ---------------------------------------------------------------------------

/**
 * A schema reference the map can hold: an app module ("@/…", no "..") and an export name. The name
 * is written into the generated file as code (`m.<name>`), so anything else is refused, never
 * written.
 */
const SCHEMA_REF = /^@\/(?!.*\.\.)[A-Za-z0-9_\-./[\]()]+#[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Every `bodySchema: '…'` of the classification files (lib/agent/operations/classes/*.ts), read
 * with the TypeScript parser like the routes. A bodySchema written as anything but plain text
 * cannot be read without running the file, so it stops the generator rather than being left out.
 */
export function classificationSchemaRefs() {
  const refs = [];
  const files = fs
    .readdirSync(CLASSES_DIR)
    .filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
    .sort();
  for (const name of files) {
    const abs = path.join(CLASSES_DIR, name);
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
        n.name.text === 'bodySchema'
      ) {
        const init = n.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          refs.push(init.text);
        } else {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
          throw new Error(
            `${rel}:${line + 1}: write bodySchema as plain text ('@/lib/validation/x#name'), so the ` +
              'generator can read it without running the file.',
          );
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return refs;
}

/**
 * The schema references of the routes (body, query and candidate body schemas) and of the
 * classification, each once, sorted. Throws on one that is not a plain "@/module#export".
 */
export function schemaRefs(routes, classificationRefs = classificationSchemaRefs()) {
  const refs = new Set(classificationRefs);
  for (const r of routes) {
    for (const meta of Object.values(r.methods)) {
      if (meta.bodySchema) refs.add(meta.bodySchema);
      if (meta.querySchema) refs.add(meta.querySchema);
      for (const c of meta.bodySchemaCandidates ?? []) refs.add(c);
    }
  }
  const bad = [...refs].filter((ref) => !SCHEMA_REF.test(ref));
  if (bad.length) {
    throw new Error(
      `These schema references are not "@/<module>#<export name>": ${bad.join(', ')}. ` +
        'Fix the bodySchema in lib/agent/operations/classes, or import the schema from a module under the project root.',
    );
  }
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function renderSchemas(refs) {
  const lines = [
    HEADER,
    '/**',
    ' * Agent full access: SERVER ONLY. One loader per zod schema the operation registry names',
    ' * ("@/lib/validation/x#name": the body and query schemas read from the route files, and the',
    " * classification's own bodySchema), written out as a static import so the bundler includes each",
    ' * one. Nothing is loaded until a loader is called; lib/agent/operations/schemas.ts imports this',
    ' * lazily and turns the schema into JSON Schema for describe_operation.',
    ' */',
    '',
    'export const SCHEMA_LOADERS: Record<string, () => Promise<unknown>> = {',
  ];
  for (const ref of refs) {
    const [mod, name] = ref.split('#');
    lines.push(`  ${q(ref)}: () => import(${q(mod)}).then((m) => m.${name}),`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

/**
 * Handlers that parse their body with a zod schema written inside the route file
 * ("POST app/api/x/route.ts: bodySchema"). The registry cannot export such a schema, so
 * describe_operation shows no body for the operation: move it to lib/validation and import it.
 * test/agentSchemas.described.test.ts keeps this list empty.
 */
export function inlineBodySchemas(routes = collect()) {
  const out = [];
  for (const r of routes) {
    for (const m of METHODS) {
      for (const name of r.methods[m]?.inlineBodySchemas ?? []) out.push(`${m} ${r.file}: ${name}`);
    }
  }
  return out;
}

export function generate() {
  const routes = collect();
  const schemas = schemaRefs(routes);
  return {
    routes,
    schemas,
    files: {
      [ROUTES_FILE]: renderRoutes(routes),
      [LOADERS_FILE]: renderLoaders(routes),
      [SCHEMAS_FILE]: renderSchemas(schemas),
    },
  };
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

function main(argv) {
  const check = argv.includes('--check');
  let generated;
  try {
    generated = generate();
  } catch (err) {
    // A bodySchema the reader cannot use: say which and where, without a stack trace.
    console.error(`agent-registry: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const { routes, schemas, files } = generated;
  const methodCount = routes.reduce((n, r) => n + Object.keys(r.methods).length, 0);
  const counts = `${routes.length} routes, ${methodCount} handlers, ${schemas.length} schemas`;
  const other = routes.filter((r) => r.other.length).map((r) => `${r.other.join(' ')} ${r.pattern}`);
  if (other.length) {
    console.warn(
      `agent-registry: these exports are not operations (only ${METHODS.join(' ')} are). They are listed as ` +
        `otherMethods, and test/agentRegistry.test.ts refuses each one it does not allow:\n  ${other.join('\n  ')}`,
    );
  }
  const inline = inlineBodySchemas(routes);
  if (inline.length) {
    console.warn(
      'agent-registry: these handlers parse their body with a zod schema written inside the route file, so agents ' +
        `see no body for them. Move each schema to lib/validation and import it:\n  ${inline.join('\n  ')}`,
    );
  }
  const stale = Object.entries(files)
    .filter(([file, text]) => readOrNull(file) !== text)
    .map(([file]) => path.relative(ROOT, file).replace(/\\/g, '/'));

  if (check) {
    if (stale.length) {
      console.error(
        `agent-registry: out of date: ${stale.join(', ')}\n` +
          'The API routes, or a bodySchema in lib/agent/operations/classes, changed since these files were written. ' +
          'Run `npm run agent:registry` and commit the result.',
      );
      return 1;
    }
    console.log(`agent-registry: up to date (${counts}).`);
    return 0;
  }
  for (const [file, text] of Object.entries(files)) {
    if (readOrNull(file) !== text) fs.writeFileSync(file, text, 'utf8');
  }
  console.log(`agent-registry: ${stale.length ? `wrote ${stale.join(', ')}` : 'no changes'} (${counts}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
