/**
 * Keyboard-first: the cursor is always visible. app/globals.css gives every element a
 * :focus-visible outline; a control that removes it (outline-none, focus:outline-none) must draw
 * its own focus style (a focus / focus-visible ring, border or background) — else Tab moves to
 * something the bookkeeper cannot see. This scans every page and component for the removal.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function files(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      files(p, out);
    } else if (/\.tsx$/.test(ent.name) && !/\.test\.tsx$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Elements that may drop the outline, and why. */
const ALLOWED: Record<string, string> = {
  // The dialog box itself takes the focus only for a moment when it opens (its first field
  // usually has it); its fields and buttons have their own rings.
  'components/ui.tsx': 'relative z-10 w-full p-6 max-h-full overflow-y-auto rounded-2xl bg-white',
  // The command bar's one search box: the open bar is the focus indicator, and the caret is in it.
  'components/CommandPalette.tsx': 'w-full py-4 text-navy outline-none text-base bg-transparent',
};

describe('visible keyboard focus everywhere', () => {
  it('the app gives every focused element an outline', () => {
    const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid/);
  });

  it('nothing removes the outline without drawing its own focus style', () => {
    const offenders: string[] = [];
    for (const file of [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'components'))]) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\b(focus:)?outline-none\b/.test(line)) return;
        // The class list may continue on the lines around it (cn(…) calls).
        const near = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
        if (/(focus|focus-visible|group-focus|focus-within):/.test(near.replace(/focus:outline-none/g, ''))) return;
        if (ALLOWED[rel] && line.includes(ALLOWED[rel])) return;
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
