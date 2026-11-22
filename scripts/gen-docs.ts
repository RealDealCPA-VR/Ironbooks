/**
 * npm run docs — writes the generated documentation:
 *   docs/guide/*            the user guide (how-to articles, every screen, QuickBooks names, glossary)
 *   docs/agents/kb.json     the same knowledge base as data
 *   docs/agents/code-map.md every screen → page, API routes and service files
 *
 * Sources: lib/kb/articles.ts, lib/nav.ts, lib/pageHelp.ts, lib/glossary.ts and the app/ tree.
 * Run it after changing any of those; lib/kb/docs.test.ts fails while the files are out of date.
 * `npm run docs -- --check` writes nothing and exits 1 when something would change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { guideFiles } from '../lib/kb/render';
import { buildCodeMap, renderCodeMap } from '../lib/kb/codeMap';

const root = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');

const files: Record<string, string> = {
  ...guideFiles(),
  'docs/agents/code-map.md': renderCodeMap(buildCodeMap(root)),
};

const norm = (s: string) => s.replace(/\r\n/g, '\n');
let changed = 0;
for (const [rel, content] of Object.entries(files)) {
  const file = path.join(root, rel);
  const current = fs.existsSync(file) ? norm(fs.readFileSync(file, 'utf8')) : null;
  if (current === content) continue;
  changed++;
  if (check) {
    console.log(`out of date: ${rel}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${rel}`);
  }
}
console.log(changed ? `${changed} file(s) ${check ? 'out of date. Run: npm run docs' : 'written'}.` : 'Docs are up to date.');
if (check && changed) process.exit(1);
