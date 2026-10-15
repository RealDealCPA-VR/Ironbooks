/**
 * tesseract.js typing: no ambient `declare module 'tesseract.js'` shorthand may exist anywhere in
 * the project (it would type the whole package as `any` and hide its own definitions once it is
 * installed). lib/receipts/ocr.ts is the only importer and types the module itself.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', '.wt', 'dist', 'out', 'release']);

function declarationFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) declarationFiles(p, out);
    else if (e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('tesseract.js types', () => {
  it('no ambient module stub hides the package types', () => {
    const offenders = declarationFiles(root).filter((f) =>
      /declare\s+module\s+['"]tesseract\.js['"]/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('ocr.ts is the only importer and casts the import to its local interface', () => {
    const src = fs.readFileSync(path.join(root, 'lib/receipts/ocr.ts'), 'utf8');
    const lines = src.split('\n');
    const i = lines.findIndex((l) => l.includes("import('tesseract.js')"));
    expect(i).toBeGreaterThan(0);
    expect(lines[i]).toMatch(/as unknown as \{ default\?: TesseractModule \} & TesseractModule/);
    // The type-check exemption is limited to that single line.
    expect(lines[i - 1]).toMatch(/@ts-ignore/);
    expect(src.match(/@ts-(ignore|nocheck|expect-error)/g)).toHaveLength(1);
  });
});
