/**
 * Starting Ironbooks while it is already open (electron/main.js, the single-instance lock).
 *
 * The second launch hands its command line to the running app ('second-instance') and must then
 * leave without doing anything. It used to call app.quit() and carry on: app.whenReady still ran
 * createWindow() while it quit, which failed (ERR_FAILED loading No Company Open) and left an
 * "Ironbooks could not start" box next to the open window; before-quit also ran the quit-time
 * auto backup and the company-file close in that second process.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// As checked out: CRLF on a Windows runner, so lines are compared with LF.
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

/** The text of the block that starts at `start` (up to its matching closing brace). */
function blockAt(start: string): string {
  const at = main.indexOf(start);
  expect(at, start).toBeGreaterThan(-1);
  const open = main.indexOf('{', at + start.length - 1);
  let depth = 0;
  for (let i = open; i < main.length; i++) {
    if (main[i] === '{') depth++;
    else if (main[i] === '}' && --depth === 0) return main.slice(at, i + 1);
  }
  throw new Error(`unclosed block: ${start}`);
}

describe('a second launch while Ironbooks is open', () => {
  it('asks for the lock once, keeps the answer, and exits at once when refused', () => {
    expect(main.match(/app\.requestSingleInstanceLock\(/g)).toHaveLength(1);
    expect(main).toMatch(/const gotSingleInstanceLock = app\.requestSingleInstanceLock\(\);\nif \(!gotSingleInstanceLock\) \{\n\s+app\.exit\(0\);\n\}/);
    // Asked after userData is chosen (the lock lives there; IRONBOOKS_USER_DATA keeps test builds apart).
    expect(main.indexOf('app.requestSingleInstanceLock()')).toBeGreaterThan(main.indexOf('function useLegacyUserDataIfPresent()'));
    // Not app.quit(): that let the rest of startup run in the second process.
    expect(main).not.toMatch(/if \(!app\.requestSingleInstanceLock\(\)\) \{\s*app\.quit\(\);/);
  });

  it('opens no window: whenReady stops before the security setup and createWindow', () => {
    const ready = blockAt('app.whenReady().then(async () => {');
    const guard = ready.indexOf('if (!gotSingleInstanceLock) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(ready.indexOf('security.install('));
    expect(guard).toBeLessThan(ready.indexOf('await createWindow()'));
    expect(guard).toBeLessThan(ready.indexOf('checkForUpdates()'));
  });

  it('runs no quit-time backup or company-file close', () => {
    const quit = blockAt("app.on('before-quit', (event) => {");
    const guard = quit.indexOf('if (!gotSingleInstanceLock) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(quit.indexOf('event.preventDefault()'));
    expect(guard).toBeLessThan(quit.indexOf('runAutoBackup()'));
    expect(guard).toBeLessThan(quit.indexOf('closeOpenCompanyFile()'));
  });

  it('leaves config.json to the running app', () => {
    const note = blockAt('function noteFilesKnownBeforeApprovals() {');
    const guard = note.indexOf('if (!gotSingleInstanceLock) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(note.indexOf('saveConfig('));
    // The lock is known before that note is taken at load time.
    expect(main.indexOf('const gotSingleInstanceLock')).toBeLessThan(main.indexOf('\nnoteFilesKnownBeforeApprovals();\n'));
  });

  it('the running app still receives the second launch (file to open, window to the front)', () => {
    expect(main).toContain("app.on('second-instance', (_event, rawArgv, workingDirectory) => {");
  });
});
