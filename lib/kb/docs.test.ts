/**
 * The published documentation matches its sources.
 *
 * docs/guide/* and docs/agents/kb.json are generated from lib/kb, lib/nav.ts, lib/pageHelp.ts and
 * lib/glossary.ts; docs/agents/code-map.md from the app/ tree. When one of these tests fails,
 * run `npm run docs` and commit the result.
 *
 * The guides must match their sources exactly. The code map only has to be right (every screen
 * listed, nothing listed that is gone), so ordinary code changes do not fail it.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { guideFiles } from './render';
import { buildCodeMap } from './codeMap';
import { KB_ARTICLES } from './index';

const ROOT = process.cwd();
const read = (rel: string) => (fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n') : null);

describe('generated docs', () => {
  it('the user guide and kb.json are up to date (run: npm run docs)', () => {
    const stale = Object.entries(guideFiles())
      .filter(([rel, content]) => read(rel) !== content)
      .map(([rel]) => rel);
    expect(stale, 'run `npm run docs`').toEqual([]);
  });

  // The code map is rebuilt from the source by `npm run docs`. It is checked for being RIGHT, not
  // for being byte-identical: adding an API call to a page must not fail the build, but a screen
  // missing from the map, or a file in it that no longer exists, must.
  it('the published code map lists every screen and only files and routes that exist (run: npm run docs)', () => {
    const published = read('docs/agents/code-map.md');
    expect(published, 'docs/agents/code-map.md is missing: run `npm run docs`').not.toBeNull();
    const map = buildCodeMap(ROOT);
    const missingScreens = map.filter((e) => !published!.includes(`\`${e.route}\``) || !published!.includes(`\`${e.page}\``)).map((e) => e.route);
    expect(missingScreens, 'screens not in the code map: run `npm run docs`').toEqual([]);

    const dead: string[] = [];
    for (const m of published!.matchAll(/`((?:app|components|lib|electron)\/[^`\s]+\.(?:tsx?|js))`/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) dead.push(m[1]);
    }
    for (const m of published!.matchAll(/`(\/api\/[^`\s]+)`/g)) {
      if (!fs.existsSync(path.join(ROOT, 'app', ...m[1].split('/').filter(Boolean), 'route.ts'))) dead.push(m[1]);
    }
    expect([...new Set(dead)], 'the code map names files that are gone: run `npm run docs`').toEqual([]);
  });

  it('the code map covers the main screens with their API and services', () => {
    const map = buildCodeMap(ROOT);
    const by = new Map(map.map((e) => [e.route, e]));
    const rec = by.get('/reconcile')!;
    expect(rec.page).toBe('app/reconcile/page.tsx');
    expect(rec.api.map((a) => a.url)).toContain('/api/reconciliations');
    expect(rec.services).toContain('lib/services/reconcile.ts');
    expect(rec.guides).toContain('reconcile-monthly');
    const inv = by.get('/invoices')!;
    expect(inv.api.map((a) => a.url)).toEqual(expect.arrayContaining(['/api/invoices', '/api/invoices/[id]']));
    expect(inv.services).toContain('lib/services/invoices.ts');
    expect(inv.menu).toBe('Sales › Invoices');
    // Every screen an article links to is in the map.
    for (const a of KB_ARTICLES) if (a.go) expect(by.has(a.go.href.split('?')[0]), a.go.href).toBe(true);
  });

  it('hand-written docs link only to files that exist', () => {
    const broken: string[] = [];
    for (const rel of ['docs/README.md', 'docs/START-HERE.md', 'docs/agents/README.md', 'AGENTS.md']) {
      const text = read(rel);
      expect(text, rel).not.toBeNull();
      for (const m of text!.matchAll(/\]\((\.{1,2}\/[^)#\s]+)(#[^)\s]*)?\)/g)) {
        const target = path.join(ROOT, path.dirname(rel), m[1]);
        if (!fs.existsSync(target)) broken.push(`${rel}: ${m[1]}`);
        else if (m[2] && target.endsWith('.md')) {
          // Anchors into generated guides must be real article / term ids.
          const body = fs.readFileSync(target, 'utf8');
          if (!body.includes(`<a id="${m[2].slice(1)}"></a>`) && !/^#[a-z0-9-]+$/.test(m[2])) broken.push(`${rel}: ${m[1]}${m[2]}`);
          if (target.includes(`${path.sep}guide${path.sep}`) && !body.includes(`<a id="${m[2].slice(1)}"></a>`)) broken.push(`${rel}: ${m[1]}${m[2]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
