/**
 * Agent full access: bridge purity (plan §5.2 item 5, §10 "Bridge purity").
 *
 * The route bridge (lib/agent/bridge.ts) previews an operation with dryRun 'transaction' by really
 * running its handler inside a database transaction and rolling it back, and commits it, and an
 * operation with dryRun 'preview', inside a transaction it can roll back when the handler fails.
 * Both only hold while the handler and its services use the context's database (ctx.db, the
 * bridge's transaction). A service that calls getDb() works on the company's own handle instead:
 * outside the transaction, so a "dry run" would really save, and a failed commit would keep half
 * its work. (PGlite runs one transaction at a time, so such a write may even wait for the bridge's
 * own transaction and never finish.)
 *
 * This test reads source text only. For every operation the bridge runs (availability 'agent')
 * with dryRun 'transaction' or 'preview', it opens the route file, follows its imports into the
 * route's own helper modules under app/ (any depth: they are the route's code) and into lib/services
 * (SERVICE_DEPTH levels), and fails when one of those files calls getDb( / getDbSync(.
 *
 * Why SERVICE_DEPTH is 2: the services a route imports, and the services those import, hold the
 * work a route asks for. One level more reaches the company-file machinery almost every service
 * shares (fileProtection -> companyFileSave, sandbox, workingCopyRecovery), whose getDb() calls
 * open or save the company file itself and are never on a route's path; following them flags
 * nearly every operation and hides the real findings. Modules outside lib/services and app/ (lib/db,
 * lib/context ...) are the infrastructure getDb belongs to and are not followed.
 *
 * It looks at whole files, so a module whose getDb() sits in a function the route never calls is
 * reported too. Two lists, each entry with its reason, say what has been looked at:
 *  - ALLOWED: a file that calls getDb where that is safe. `names`: covered only while every
 *    module reaching it imports just these names (a route that starts importing another one of
 *    its functions is reported again). `ops`: covered only for these operations.
 *  - KNOWN: real violations still waiting for a classification change (dryRun 'none') or a fix in
 *    the service, by "<operation id> <file>". The test fails once an entry is no longer needed, so
 *    the list only shrinks.
 * Anything on neither list fails the test: classify the operation dryRun 'none'
 * (lib/agent/operations/classes), or make the service use ctx.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allOperations } from '@/lib/agent/operations/registry';

const ROOT = process.cwd();
const SERVICES = path.join(ROOT, 'lib', 'services');
const APP = path.join(ROOT, 'app');
/** Levels of lib/services followed from a route: the modules it imports (1), and theirs (2). See above. */
const SERVICE_DEPTH = 2;
/** The dry-run kinds the bridge wraps in its own transaction (a commit of 'none' is not wrapped). */
const WRAPPED: readonly string[] = ['transaction', 'preview'];

interface Allowance {
  why: string;
  /** Covered only while every module reaching the file imports just these names from it. */
  names?: string[];
  /** Covered only for these operation ids. */
  ops?: string[];
}

/** Opening a copy restores it into a NEW folder: a separate company file, with a database of its own. */
const RESTORE_OPS = ['portable.restore', 'accountant-copy.open'];
const RESTORE_WHY =
  'getDb() here opens the newly restored target folder (restorePortableCompanyFile, openAccountantCopyFile, and ' +
  'protectionForDir through packRestoredAsCompanyFile, all on restored.dataDir): a separate company file with its own ' +
  "database, never the open company's handle, so it neither escapes nor waits on the bridge's transaction. A failed " +
  'restore removes that folder itself.';

/** Each file may carry several allowances; any one that matches covers it. */
const ALLOWED: Record<string, Allowance | Allowance[]> = {
  'app/api/recurring/run/route.ts': {
    why:
      'getDb() is only on the desktop timer path, which needs the x-bka-internal header. The bridge sends only ' +
      'SERVICE_SCOPE_HEADERS, so a bridged run always takes getServerContext() and the scope context.',
  },
  'lib/services/fileProtection.ts': [
    {
      names: ['syncPasswordSlot', 'requestFileKeyRotation', 'assertCopyPasswordGiven'],
      why:
        'getDb() is only in protectionForDir (backups) and unsealCompanyFile (opening a protected file). ' +
        'syncPasswordSlot and assertCopyPasswordGiven use the database handle they are given; ' +
        'requestFileKeyRotation only marks the next save in memory.',
    },
    { ops: RESTORE_OPS, why: RESTORE_WHY },
  ],
  'lib/services/accountantCopy/accountant.ts': [
    {
      names: ['accountantChanges', 'exportChangesFile'],
      why:
        "getDb() is only in openAccountantCopyFile, which opens a newly restored folder (a separate company file). " +
        'accountantChanges and exportChangesFile read through ctx.db.',
    },
    { ops: RESTORE_OPS, why: RESTORE_WHY },
  ],
  'lib/services/portableFile.ts': [
    {
      ops: ['accountant-copy.cancel', 'accountant-copy.changes.import', 'accountant-copy.changes.export'],
      why:
        "accountantCopy/client.ts imports createPortableCompanyFile for making a new Accountant's Copy (POST " +
        '/api/accountant-copy, another operation); cancelAccountantCopy and importChangesFile never call it. ' +
        'accountant.ts imports restorePortableCompanyFile for openAccountantCopyFile only, which these routes do not call.',
    },
    { ops: RESTORE_OPS, why: RESTORE_WHY },
  ],
  'lib/services/backupSchedule.ts': {
    ops: ['attention.invoice-reminder'],
    why:
      'lib/services/attention.ts imports runVersionedBackup for its own "back up now" item; sendPaymentReminder, ' +
      'the one function this route calls, never reaches it.',
  },
};

/**
 * Real violations still waiting for their fix, by "<operation id> <file>" (file relative to the
 * repo, forward slashes). Reclassify the operation dryRun 'none' or make the service use ctx.db,
 * then remove the entry. Empty since condense became dryRun 'none' (its service opens the
 * company's own folder through getDb() and writes a safety copy and an archive first).
 */
const KNOWN: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Reading source text
// ---------------------------------------------------------------------------

const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'else', 'yield', 'await', 'instanceof']);

/** Whether a "/" after this code starts a regular expression (not a division). */
function regexCanStart(before: string): boolean {
  const code = before.trimEnd();
  if (!code) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(code[code.length - 1])) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(code)?.[1];
  return word !== undefined && REGEX_AFTER_WORD.has(word);
}

/** The code without its comments (strings, template text and regular expressions are kept as they are). */
function withoutComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && regexCanStart(out)) {
      // A regular expression: a quote or "//" inside it must not start a string or a comment.
      const start = i;
      let inClass = false;
      i++;
      while (i < src.length && src[i] !== '\n') {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        i++;
        if (inClass) {
          if (ch === ']') inClass = false;
        } else if (ch === '[') {
          inClass = true;
        } else if (ch === '/') {
          break;
        }
      }
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      out += src.slice(start, i);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const cache = new Map<string, string>();
function code(file: string): string {
  let c = cache.get(file);
  if (c === undefined) {
    c = withoutComments(fs.readFileSync(file, 'utf8'));
    cache.set(file, c);
  }
  return c;
}

/** Names in `{ a, b as c, type d }`: the imported names, without the type-only ones. */
function braceNames(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^type\s/.test(s))
    .map((s) => s.split(/\s+as\s+/)[0].trim());
}

/**
 * What a file loads at run time, with the names it takes from each module ('*' for all of it,
 * 'default' for a default import). `import type` / `export type` are left out: the compiler
 * erases them.
 */
function runtimeImports(src: string): Array<{ spec: string; names: string[] }> {
  const out: Array<{ spec: string; names: string[] }> = [];
  for (const m of src.matchAll(/\bimport\s+(type\s+)?([^'"`;]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const clause = m[2].trim();
    const names: string[] = [];
    const brace = /\{([^}]*)\}/.exec(clause);
    if (brace) names.push(...braceNames(brace[1]));
    if (/\*\s*as\s+\w+/.test(clause)) names.push('*');
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+\w+/, '').replace(/,/g, ' ').trim();
    if (head) names.push('default');
    if (names.length) out.push({ spec: m[3], names });
  }
  for (const m of src.matchAll(/\bexport\s+(type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const names = m[2].startsWith('*') ? ['*'] : braceNames(m[2].slice(1, -1));
    if (names.length) out.push({ spec: m[3], names });
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], names: ['*'] });
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push({ spec: m[1], names: ['*'] });
  return out;
}

type Place = 'service' | 'app';

/** The lib/services or app/ file a specifier names, with where it is; null for anything else. */
function followed(spec: string, from: string): { file: string; place: Place } | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  const place: Place | null = base.startsWith(SERVICES + path.sep) ? 'service' : base.startsWith(APP + path.sep) ? 'app' : null;
  if (!place) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return { file: candidate, place };
  }
  return null;
}

const CALLS_GET_DB = /\bgetDb(?:Sync)?\s*\(/;

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

interface Reach {
  /** The first import chain that reaches the file. */
  chain: string[];
  /** Every name taken from the file by the modules reaching it. */
  names: Set<string>;
  /** lib/services levels on the way here (route files and app/ helpers add none). */
  depth: number;
}

/** The route file, the app/ helpers it reaches, and the services it reaches. */
function reached(routeFile: string): Map<string, Reach> {
  const out = new Map<string, Reach>([[routeFile, { chain: [rel(routeFile)], names: new Set(), depth: 0 }]]);
  const todo = [routeFile];
  while (todo.length) {
    const file = todo.shift()!;
    const here = out.get(file)!;
    for (const { spec, names } of runtimeImports(code(file))) {
      const target = followed(spec, file);
      if (!target || /\.(test|fixture)\.tsx?$|testkit/.test(target.file)) continue;
      const depth = here.depth + (target.place === 'service' ? 1 : 0);
      if (depth > SERVICE_DEPTH) continue;
      const seen = out.get(target.file);
      if (seen) {
        for (const n of names) seen.names.add(n);
        // Reached by a shorter way: follow it again from there.
        if (depth < seen.depth) {
          seen.depth = depth;
          todo.push(target.file);
        }
        continue;
      }
      out.set(target.file, { chain: [...here.chain, rel(target.file)], names: new Set(names), depth });
      todo.push(target.file);
    }
  }
  return out;
}

function routeFileOf(route: string): string | null {
  const dir = path.join(APP, ...route.split('/').filter(Boolean));
  for (const name of ['route.ts', 'route.tsx']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function allowancesOf(file: string): Allowance[] {
  const a = ALLOWED[file];
  return !a ? [] : Array.isArray(a) ? a : [a];
}

/** The allowance that covers this file for this operation, as "<file>#<index>"; null when none does. */
function allowed(file: string, opId: string, names: Set<string>): string | null {
  const i = allowancesOf(file).findIndex((a) => {
    if (a.ops && !a.ops.includes(opId)) return false;
    if (a.names && ![...names].every((n) => a.names!.includes(n))) return false;
    return true;
  });
  return i < 0 ? null : `${file}#${i}`;
}

interface Violation {
  key: string;
  chain: string[];
  names: string[];
}

function violations(): { found: Violation[]; allowedUsed: Set<string>; missingRoutes: string[]; checked: number; previews: number } {
  const found: Violation[] = [];
  const allowedUsed = new Set<string>();
  const missingRoutes: string[] = [];
  // Only what the bridge runs inside its own transaction: it refuses person-only and hard-floor
  // operations before anything, and commits a dryRun 'none' operation without wrapping it.
  const ops = allOperations().filter((o) => o.kind === 'route' && o.availability === 'agent' && WRAPPED.includes(o.dryRun));
  for (const op of ops) {
    const file = routeFileOf(op.route);
    if (!file) {
      missingRoutes.push(`${op.id} (${op.method} ${op.route})`);
      continue;
    }
    for (const [f, reach] of reached(file)) {
      if (!CALLS_GET_DB.test(code(f))) continue;
      const r = rel(f);
      const by = allowed(r, op.id, reach.names);
      if (by) {
        allowedUsed.add(by);
        continue;
      }
      found.push({ key: `${op.id} ${r}`, chain: reach.chain, names: [...reach.names] });
    }
  }
  return { found, allowedUsed, missingRoutes, checked: ops.length, previews: ops.filter((o) => o.dryRun === 'preview').length };
}

describe('bridge purity: nothing behind an operation the bridge wraps in its transaction opens its own database handle', () => {
  const result = violations();

  it('checks real operations, those with a preview of their own included', () => {
    expect(result.checked).toBeGreaterThan(100);
    expect(result.previews).toBeGreaterThan(0);
    expect(result.missingRoutes).toEqual([]);
  });

  it('no route, route helper or service reached from such a route calls getDb(), beyond the lists', () => {
    const unexpected = result.found.filter((v) => !KNOWN[v.key]);
    expect(
      unexpected.map((v) => `${v.key}\n    via ${v.chain.join(' -> ')}\n    importing ${v.names.join(', ') || '(the route itself)'}`),
      'Classify these operations dryRun "none" (lib/agent/operations/classes), or make the service use ctx.db.',
    ).toEqual([]);
  });

  it('every KNOWN and ALLOWED entry is still needed and says why', () => {
    const live = new Set(result.found.map((v) => v.key));
    expect(Object.keys(KNOWN).filter((k) => !live.has(k)), 'No longer a violation: remove it from KNOWN').toEqual([]);
    const every = Object.keys(ALLOWED).flatMap((f) => allowancesOf(f).map((_, i) => `${f}#${i}`));
    expect(every.filter((k) => !result.allowedUsed.has(k)), 'No longer reached with getDb(): remove it from ALLOWED').toEqual([]);
    for (const [k, why] of Object.entries(KNOWN)) expect(why.trim().length, k).toBeGreaterThan(20);
    for (const k of Object.keys(ALLOWED)) for (const a of allowancesOf(k)) expect(a.why.trim().length, k).toBeGreaterThan(20);
  });

  it('reads the source as code: comments do not count, strings and regular expressions hide nothing, imports and their names are followed', () => {
    expect(CALLS_GET_DB.test(withoutComments('// getDb() in a comment\n/* getDb() */ const x = 1;'))).toBe(false);
    expect(CALLS_GET_DB.test(withoutComments("const s = 'a//b'; const db = await getDb();"))).toBe(true);
    // A quote or "//" inside a regular expression starts neither a string nor a comment.
    expect(CALLS_GET_DB.test(withoutComments('const q = /"/; const db = await getDb();'))).toBe(true);
    expect(CALLS_GET_DB.test(withoutComments("const u = /^https?:\\/\\/x'/i.test(s) ? getDb() : null;"))).toBe(true);
    expect(CALLS_GET_DB.test(withoutComments('if (/[/"]/.test(s)) return getDb();'))).toBe(true);
    // A division is not a regular expression.
    expect(CALLS_GET_DB.test(withoutComments('const half = total / 2; // getDb()\nconst y = a / b / c;'))).toBe(false);
    expect(CALLS_GET_DB.test(withoutComments('const half = total / 2; const db = await getDb();'))).toBe(true);
    const found = runtimeImports(
      withoutComments(
        [
          "import type { A } from '@/lib/services/a';",
          "import { b, c as d, type E } from '@/lib/services/b';",
          "import whole, { f } from '@/lib/services/f';",
          "import * as g from '@/lib/services/g';",
          "export { h } from './h';",
          "export type { I } from './i';",
          "const j = await import('@/lib/services/j');",
        ].join('\n'),
      ),
    );
    expect(found).toEqual([
      { spec: '@/lib/services/b', names: ['b', 'c'] },
      { spec: '@/lib/services/f', names: ['f', 'default'] },
      { spec: '@/lib/services/g', names: ['*'] },
      { spec: './h', names: ['h'] },
      { spec: '@/lib/services/j', names: ['*'] },
    ]);
  });

  it("follows a route's own helpers under app/ without spending a level, and stops lib/services at SERVICE_DEPTH", () => {
    const helperRoutes = allOperations()
      .filter((o) => o.kind === 'route' && WRAPPED.includes(o.dryRun))
      .map((o) => routeFileOf(o.route))
      .filter((f): f is string => !!f)
      .filter((f) => [...reached(f).values()].some((r) => r.chain.length > 1 && r.chain[r.chain.length - 1].startsWith('app/')));
    expect(helperRoutes.length, 'no route imports a helper under app/: drop the app/ following or check the resolver').toBeGreaterThan(0);
    for (const f of helperRoutes.slice(0, 20)) {
      for (const r of reached(f).values()) expect(r.depth).toBeLessThanOrEqual(SERVICE_DEPTH);
    }
  });
});
