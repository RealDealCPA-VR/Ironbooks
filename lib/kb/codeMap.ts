/**
 * The code map: for every screen, the files that make it work — its page, the API routes the
 * page calls and the service modules those routes use. It is what lets a person or a coding
 * agent go from "the Reconcile screen" to the right files without reading the whole codebase.
 *
 * Built by reading the source (Node only: used by scripts/gen-docs.ts and the docs test, never
 * by the app). It is a map of static references, so it can miss a call built at run time; it
 * never lists a file that does not exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { KB_ARTICLES, KB_SCREENS, basePath, linksOf, menuPath } from './index';
import { GENERATED_NOTE } from './render';

export interface CodeMapEntry {
  /** The page route, e.g. '/invoices' or '/registers/[accountId]'. */
  route: string;
  label: string;
  group: string;
  menu: string | null;
  qb?: string;
  page: string;
  /** Components the page imports (not the shared shell and UI kit). */
  components: string[];
  /** API routes called from the page or those components: URL pattern and route file. */
  api: { url: string; file: string }[];
  /** Service modules the API routes import (lib/services). */
  services: string[];
  /** How-to articles that send people here. */
  guides: string[];
}

const SHARED_COMPONENTS = new Set(['ui', 'AppShell', 'Help', 'FieldError', 'LoadFailed', 'PageRefresh']);

function walk(dir: string, name: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, name, out);
    else if (e.name === name) out.push(full);
  }
  return out;
}

const posix = (p: string) => p.split(path.sep).join('/');

function resolveSource(root: string, spec: string): string | null {
  const rel = spec.replace(/^@\//, '');
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (fs.existsSync(path.join(root, rel + ext))) return rel + ext;
  }
  return null;
}

/** '/api/invoices/${id}/pdf' → ['api','invoices','*','pdf'] */
function urlSegments(url: string): string[] {
  return url
    .replace(/\$\{[^}]*\}/g, '*')
    .replace(/[.?].*$/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => (s.includes('*') ? '*' : s));
}

export function buildCodeMap(root: string = process.cwd()): CodeMapEntry[] {
  const apiRoot = path.join(root, 'app', 'api');
  const routeFiles = walk(apiRoot, 'route.ts').map((f) => {
    const rel = posix(path.relative(root, f));
    const segs = rel.replace(/^app\//, '').replace(/\/route\.ts$/, '').split('/');
    return { rel, segs, url: '/' + segs.join('/') };
  });
  const matchRoute = (url: string) => {
    const want = urlSegments(url);
    // Exact segments beat dynamic ones ('/api/invoices/batch' before '/api/invoices/[id]').
    const fits = routeFiles.filter(
      (r) => r.segs.length === want.length && r.segs.every((s, i) => s === want[i] || /^\[.*\]$/.test(s) || want[i] === '*'),
    );
    // A value filled in at run time ('${id}') means the dynamic segment, not a sibling like 'batch'.
    const exactness = (r: (typeof routeFiles)[number]) =>
      r.segs.filter((s, i) => s === want[i] || (want[i] === '*' && /^\[.*\]$/.test(s))).length;
    return fits.sort((a, b) => exactness(b) - exactness(a))[0] ?? null;
  };

  const servicesOf = new Map<string, string[]>();
  const servicesFor = (routeRel: string): string[] => {
    const hit = servicesOf.get(routeRel);
    if (hit) return hit;
    const src = fs.readFileSync(path.join(root, routeRel), 'utf8');
    const found = new Set<string>();
    for (const m of src.matchAll(/from\s+['"](@\/lib\/services\/[A-Za-z0-9_./-]+)['"]/g)) {
      const file = resolveSource(root, m[1]);
      if (file && !/\/_base\.ts$/.test(file)) found.add(file);
    }
    const list = [...found].sort();
    servicesOf.set(routeRel, list);
    return list;
  };

  const guidesByPath = new Map<string, string[]>();
  for (const a of KB_ARTICLES) {
    for (const l of linksOf(a)) {
      const p = basePath(l.href);
      guidesByPath.set(p, [...new Set([...(guidesByPath.get(p) ?? []), a.id])]);
    }
  }
  const screenByPath = new Map(KB_SCREENS.map((s) => [s.path, s]));

  const entries: CodeMapEntry[] = [];
  for (const pageFile of walk(path.join(root, 'app'), 'page.tsx')) {
    const rel = posix(path.relative(root, pageFile));
    if (rel.startsWith('app/api/')) continue;
    const route = '/' + rel.replace(/^app\//, '').replace(/\/?page\.tsx$/, '');
    const src = fs.readFileSync(pageFile, 'utf8');

    const components: string[] = [];
    const sources = [src];
    for (const m of src.matchAll(/from\s+['"](@\/components\/[A-Za-z0-9_./-]+)['"]/g)) {
      const name = m[1].split('/').pop()!;
      if (SHARED_COMPONENTS.has(name)) continue;
      const file = resolveSource(root, m[1]);
      if (!file || components.includes(file)) continue;
      components.push(file);
      sources.push(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    // Client helpers the page imports (lib/*Client.ts) call the API on its behalf.
    for (const m of src.matchAll(/from\s+['"](@\/lib\/[A-Za-z0-9_./-]*Client)['"]/g)) {
      const file = resolveSource(root, m[1]);
      if (file) sources.push(fs.readFileSync(path.join(root, file), 'utf8'));
    }

    const api = new Map<string, string>();
    for (const text of sources) {
      for (const m of text.matchAll(/\/api\/[A-Za-z0-9_/${}.[\]-]+/g)) {
        const r = matchRoute(m[0]);
        if (r) api.set(r.url, r.rel);
      }
    }
    const apiList = [...api.entries()].map(([url, file]) => ({ url, file })).sort((a, b) => a.url.localeCompare(b.url, 'en'));
    const services = [...new Set(apiList.flatMap((a) => servicesFor(a.file)))].sort();

    const screen = screenByPath.get(route);
    entries.push({
      route: route === '/' ? '/' : route,
      label: screen?.label ?? route,
      group: screen?.group ?? 'Other',
      menu: menuPath(route),
      qb: screen?.qb,
      page: rel,
      components: components.sort(),
      api: apiList,
      services,
      guides: guidesByPath.get(route) ?? [],
    });
  }
  return entries.sort((a, b) => a.route.localeCompare(b.route, 'en'));
}

const GROUP_ORDER = ['Home', 'Sales', 'Customers', 'Purchases', 'Vendors', 'Banking', 'Accounting', 'Employees', 'Reports', 'Admin', 'Operations', 'Setup', 'Company', 'Other'];

export function renderCodeMap(entries: CodeMapEntry[]): string {
  const out: string[] = [
    '# Code map: screen → files',
    '',
    GENERATED_NOTE,
    '',
    'For every screen: the page file, the components it uses, the API routes it calls and the service modules behind them. Search this file for a screen’s name, its QuickBooks name or its path (for example `/reconcile`), then open only the files listed.',
    '',
    'How to read an entry: **UI** is what renders; **API** lists the routes it calls (the handler for `/api/invoices/[id]` is `app/api/invoices/[id]/route.ts`); **Logic** is where the accounting rules live (`lib/services`). The map is built from static references in the source, so a call assembled at run time can be missing; nothing listed is made up. The product side of each screen (what it is for, how people use it) is in [`../guide/screens.md`](../guide/screens.md) and [`kb.json`](./kb.json).',
    '',
  ];
  const groups = new Map<string, CodeMapEntry[]>();
  for (const e of entries) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  const ordered = [...groups.entries()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a[0]);
    const ib = GROUP_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  out.push('**Areas:** ' + ordered.map(([g]) => `[${g}](#${g.toLowerCase().replace(/[^a-z0-9]+/g, '-')})`).join(' · '), '');
  for (const [group, list] of ordered) {
    out.push(`## ${group}`, '');
    for (const e of list) {
      out.push(`### ${e.label === e.route ? `\`${e.route}\`` : `${e.label} · \`${e.route}\``}`, '');
      const facts = [e.qb ? `QuickBooks: ${e.qb}` : '', e.menu ? `Menu: ${e.menu}` : '', e.guides.length ? `Guides: ${e.guides.map((g) => `\`${g}\``).join(', ')}` : ''].filter(Boolean);
      if (facts.length) out.push(facts.join(' · '), '');
      out.push(`- **UI:** \`${e.page}\`${e.components.length ? ' + ' + e.components.map((c) => `\`${c}\``).join(', ') : ''}`);
      if (e.api.length) out.push(`- **API:** ${e.api.map((a) => `\`${a.url}\``).join(', ')}`);
      if (e.services.length) out.push(`- **Logic:** ${e.services.map((s) => `\`${s}\``).join(', ')}`);
      out.push('');
    }
  }
  return out.join('\n');
}
