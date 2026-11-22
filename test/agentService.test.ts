/**
 * Ironbooks started for an agent while it was closed (electron/agentService.js, wired into
 * electron/main.js; AGENT_ACCESS.md).
 *
 * The helper is pure and is tested directly. main.js starts the app when it is loaded, so its
 * wiring is checked by reading it, the way the other shell tests do (test/security1.shell.test.ts):
 * each place a normal start would ask a person something, show something, or start background
 * work must be guarded, and a start WITHOUT the flag must not be changed by any of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const agentService = require('../electron/agentService.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const main = fs.readFileSync(path.resolve(__dirname, '..', 'electron', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
/** The body of a top-level function in main.js (up to the next top-level declaration). */
const fnBody = (signature: string) => {
  const at = main.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const rest = main.slice(at + signature.length);
  const end = rest.search(/\n(?:async function |function |const |let |ipcMain\.|app\.on\(|app\.whenReady\()/);
  return main.slice(at, at + signature.length + (end < 0 ? rest.length : end));
};
const before = (body: string, first: string, second: string) => {
  const a = body.indexOf(first);
  const b = body.indexOf(second);
  expect(a, first).toBeGreaterThan(-1);
  expect(b, second).toBeGreaterThan(-1);
  expect(a, `${first} comes before ${second}`).toBeLessThan(b);
};

describe('the flag', () => {
  it('is one exact argument, and nothing else turns the mode on', () => {
    expect(agentService.FLAG).toBe('--agent-service');
    expect(agentService.isAgentServiceLaunch(['C:\\Ironbooks.exe', '--agent-service'])).toBe(true);
    expect(agentService.isAgentServiceLaunch(['C:\\Ironbooks.exe'])).toBe(false);
    expect(agentService.isAgentServiceLaunch(['C:\\Ironbooks.exe', '--agent-service=1'])).toBe(false);
    expect(agentService.isAgentServiceLaunch(['C:\\Ironbooks.exe', '--AGENT-SERVICE'])).toBe(false);
    expect(agentService.isAgentServiceLaunch(['C:\\Ironbooks.exe', 'C:\\Books\\--agent-service.ironbooks'])).toBe(false);
    expect(agentService.isAgentServiceLaunch(undefined)).toBe(false);
    expect(agentService.isAgentServiceLaunch('--agent-service')).toBe(false);
  });

  it('a relaunch never carries it: starting again is always a normal start with its window', () => {
    expect(agentService.withoutFlag(['--agent-service', '--foo', 'x'])).toEqual(['--foo', 'x']);
    expect(agentService.withoutFlag(undefined)).toEqual([]);
    expect(fnBody('function relaunchArgs()')).toContain('agentService.withoutFlag(process.argv.slice(1))');
  });
});

describe('what may start with no window', () => {
  const ok = { companyFile: 'C:\\Books\\Acme.ironbooks' };
  it('only a company file on this computer that opens by itself', () => {
    expect(agentService.headlessBlocker(ok)).toBeNull();
    expect(agentService.headlessBlocker(ok, {})).toBeNull();
  });

  it('everything a person would have to decide is refused, with the reason', () => {
    expect(agentService.headlessBlocker({})).toMatch(/no company file/);
    expect(agentService.headlessBlocker(null)).toMatch(/no company file/);
    expect(agentService.headlessBlocker({ ...ok, companyClosed: true })).toMatch(/closed/);
    expect(agentService.headlessBlocker({ ...ok, remoteHost: 'https://office.example.ts.net:47800' })).toMatch(/another computer/);
    expect(agentService.headlessBlocker({ ...ok, sandbox: { dir: 'x' } })).toMatch(/practice copy/);
    expect(agentService.headlessBlocker(ok, { firstRun: true })).toMatch(/not been set up/);
    expect(agentService.headlessBlocker(ok, { dataDirEnv: true })).toMatch(/data folder/);
    expect(agentService.headlessBlocker(ok, { fileArgument: true })).toMatch(/command line/);
    expect(agentService.headlessBlocker({ companyFile: 42 })).toMatch(/no company file/);
  });
});

describe('questions asked while nobody is there', () => {
  it('get the answer that changes nothing: the cancel button', () => {
    expect(agentService.quietDialogAnswer([{ message: 'Take over?', buttons: ['Open Anyway', 'Cancel'], cancelId: 1 }])).toEqual({ response: 1, checkboxChecked: false });
    // With a parent window first, as dialog.showMessageBox(window, options). A window is an object
    // of a class (BrowserWindow): Electron takes a plain object first as the options themselves.
    const win = new (class BrowserWindow {
      id = 7;
    })();
    expect(agentService.quietDialogAnswer([win, { message: 'x', buttons: ['Try Again', 'Close Anyway', 'Keep Working'], cancelId: 2 }]).response).toBe(2);
    // A plain object first is the options, as Electron reads it: no buttons there, so a notice.
    expect(agentService.quietDialogAnswer([{ id: 7 }, { message: 'x', buttons: ['Try Again', 'Close Anyway', 'Keep Working'], cancelId: 2 }]).response).toBe(0);
    expect(agentService.quietDialogAnswer([null, { message: 'x', buttons: ['A', 'B'], cancelId: 1 }]).response).toBe(1);
  });

  it('a plain notice is just dismissed, and a checkbox is never ticked', () => {
    expect(agentService.quietDialogAnswer([{ message: 'Saved.' }])).toEqual({ response: 0, checkboxChecked: false });
    expect(agentService.quietDialogAnswer([])).toEqual({ response: 0, checkboxChecked: false });
    expect(agentService.quietDialogAnswer([{ message: 'x', buttons: ['OK'], cancelId: 1.5, checkboxLabel: 'Do not ask again', checkboxChecked: true }])).toEqual({
      response: 0,
      checkboxChecked: false,
    });
  });
});

describe('closing after a quiet while', () => {
  const t0 = Date.parse('2026-11-19T10:00:00Z');
  const min = 60_000;
  it('counts from the start when no agent has worked yet', () => {
    expect(agentService.idleTooLong({ now: t0 + 9 * min, since: t0, lastAgentUse: null })).toBe(false);
    expect(agentService.idleTooLong({ now: t0 + 10 * min, since: t0, lastAgentUse: null })).toBe(true);
  });

  it('counts from the last agent request after that', () => {
    const used = new Date(t0 + 30 * min).toISOString();
    expect(agentService.idleTooLong({ now: t0 + 39 * min, since: t0, lastAgentUse: used })).toBe(false);
    expect(agentService.idleTooLong({ now: t0 + 41 * min, since: t0, lastAgentUse: used })).toBe(true);
  });

  it('an unreadable time, or one from before this start, never keeps it open longer or closes it sooner', () => {
    expect(agentService.idleTooLong({ now: t0 + 5 * min, since: t0, lastAgentUse: 'not a date' })).toBe(false);
    expect(agentService.idleTooLong({ now: t0 + 11 * min, since: t0, lastAgentUse: 'not a date' })).toBe(true);
    expect(agentService.idleTooLong({ now: t0 + 5 * min, since: t0, lastAgentUse: new Date(t0 - 60 * min).toISOString() })).toBe(false);
  });

  it('ten minutes, checked every minute', () => {
    expect(agentService.IDLE_MS).toBe(10 * min);
    expect(agentService.POLL_MS).toBe(min);
  });
});

describe('main.js: a start without the flag is unchanged', () => {
  it('the mode is on only for a launch with the flag', () => {
    expect(main).toContain("const agentService = require('./agentService');");
    expect(main).toContain('let agentServiceHidden = agentService.isAgentServiceLaunch(process.argv);');
    // Nothing else ever turns it on: the only other assignment turns it off (the window is shown).
    const assignments = main.match(/agentServiceHidden\s*=[^=]/g) ?? [];
    expect(assignments).toHaveLength(2);
    expect(main).toContain('agentServiceHidden = false;');
  });

  it('questions and notices go to the person exactly as before unless the app is hidden', () => {
    expect(main).toContain('dialog.showMessageBox = (...args) => (agentServiceHidden ? Promise.resolve(agentService.quietDialogAnswer(args)) : askPerson(...args));');
    expect(main).toMatch(/dialog\.showErrorBox = \(title, content\) => \{\n\s+if \(agentServiceHidden\) console\.error\(`\[agent-service\] \$\{title\}: \$\{content\}`\);\n\s+else tellPerson\(title, content\);/);
  });

  it('the window is created shown, as always, unless the app was started for an agent', () => {
    // The app's one window is made in ensureMainWindow (No Company Open, Opening… and the company's
    // pages all show in it).
    const win = fnBody('function ensureMainWindow()');
    expect(win).toContain('show: !agentServiceHidden,');
    expect(win).toContain('if (state?.maximized && !agentServiceHidden) win.maximize();');
    // Still one server start in createWindow, and the page still loads from it.
    const body = fnBody('async function createWindow()');
    expect(body.match(/await startNextServer\(/g) ?? []).toHaveLength(1);
  });
});

describe('main.js: started for an agent', () => {
  const body = fnBody('async function createWindow()');

  it('closes again before opening anything when a person would have to decide', () => {
    before(body, 'agentService.headlessBlocker(loadConfig(),', 'if (pendingCompanyPath) {');
    expect(body).toMatch(/const why = agentService\.headlessBlocker\([^\n]+\n\s+if \(why\) \{\n\s+quitAgentService\(why\);\n\s+return;/);
  });

  it('closes again when the company file does not open by itself (in use, missing, unsaved work to sort out)', () => {
    expect(body).toMatch(/if \(!opened && agentServiceHidden\) \{[^}]*quitAgentService\([^)]*\);\n\s+return;/);
    // …before the start window that a person would get instead.
    const at = body.indexOf('if (!opened && agentServiceHidden) {');
    expect(body.slice(at)).toMatch(/^if \(!opened && agentServiceHidden\) \{[^}]*\}\n\s+if \(!opened\) \{\n\s+await createStartWindow\(\);/);
  });

  it('asks its own server before serving, and starts no recurring entries, schedules or hosting', () => {
    before(body, 'await startAgentService(url);', 'runDueRecurring(url);');
    before(body, 'await startAgentService(url);', 'scheduleBackgroundJobs(url);');
    expect(body).toMatch(/if \(agentServiceHidden\) \{[^}]*await startAgentService\(url\);\n\s+return;\n\s+\}/);
    expect(body).toContain('if (!agentServiceHidden) noteRecoveredWork();');
    const start = fnBody('async function startAgentService(url)');
    expect(start).toContain("shellFetch(url, '/api/agent/service', { method: 'POST'");
    // No yes from the server (a file with passwords, no agent allowed to, an error): close.
    expect(start).toMatch(/if \(!answer \|\| answer\.ok !== true\) \{\n\s+quitAgentService\(/);
    expect(start).toContain('agentService.idleTooLong({ now: Date.now(), since: agentServiceSince, lastAgentUse })');
  });

  it('names no person on the company file lock', () => {
    expect(main).toContain('appUser: agentServiceHidden ? agentService.LOCK_USER : lastUserFor(filePath)');
    expect(agentService.LOCK_USER).toMatch(/agent/);
  });

  it('downloads and installs no update', () => {
    const check = fnBody('async function checkForUpdates(');
    before(check, 'if (agentServiceHidden) return;', 'await updatesAllowed()');
  });
});

describe('main.js: people come first', () => {
  it('a person starting Ironbooks gets the running app: its window is shown, and what was held back starts', () => {
    const second = main.slice(main.indexOf("app.on('second-instance'"));
    before(second, 'if (agentService.isAgentServiceLaunch(rawArgv)) {', 'revealAgentServiceWindow();');
    before(second, 'revealAgentServiceWindow();', 'mainWindow.focus();');
    const reveal = fnBody('function revealAgentServiceWindow()');
    expect(reveal).toContain('if (!agentServiceHidden) return;');
    for (const step of ['mainWindow.show();', 'openFile.appUser = lastUserFor(openFile.path);', 'noteRecoveredWork();', 'runDueRecurring(serverUrl);', 'scheduleBackgroundJobs(serverUrl);', 'checkForUpdates();']) {
      expect(reveal, step).toContain(step);
    }
    // Arriving while it is already saving and closing: a normal start follows.
    before(reveal, 'if (closingInProgress || quittingAfterBackup) {', 'relaunchAfterQuit = true;');
    before(reveal, 'relaunchAfterQuit = true;', 'agentServiceHidden = false;');
  });

  it("an agent's connector asking again never shows or focuses a window", () => {
    const second = main.slice(main.indexOf("app.on('second-instance'"));
    const guard = second.slice(second.indexOf('if (agentService.isAgentServiceLaunch(rawArgv)) {'), second.indexOf('revealAgentServiceWindow();'));
    expect(guard).toMatch(/\n\s+return;\n\s+\}/);
    expect(guard).not.toContain('.show(');
    expect(guard).not.toContain('.focus(');
  });

  it('another computer asking for the company file gets it at once', () => {
    const body = fnBody('async function serviceAccessRequests()');
    expect(body).toMatch(/if \(agentServiceHidden\) \{\n\s+companyLock\.respond\(openFile\.lock, req\.id, \{ decision: 'handoff' \}\);\n\s+quitAgentService\(/);
    // …before anything that would wait for an answer from this computer.
    before(body, 'if (agentServiceHidden) {', 'Already letting people on the network join without asking');
  });

  it('a company file taken over elsewhere is let go', () => {
    const body = fnBody('async function showLockLost(holder)');
    before(body, 'if (agentServiceHidden) {', 'lockLostNoticeShown = true;');
  });

  it('closing always finishes: a save that fails leaves the file marked unsaved for the next person', () => {
    const body = fnBody('async function closeOpenCompanyFile()');
    expect(body).toMatch(/if \(agentServiceHidden\) \{[^}]*companyLock\.heartbeat\(openFile\.lock, \{ unsavedSince: new Date\(\)\.toISOString\(\) \}\);\n\s+return true;/);
    // The save is still tried first, exactly as for a person.
    before(body, "'/api/company-file/close'", 'if (agentServiceHidden) {');
  });

  it('quitting goes through the normal close: backup, save into the company file, release', () => {
    expect(fnBody('function quitAgentService(why)')).toContain('app.quit();');
    expect(fnBody('function quitAgentService(why)')).not.toMatch(/app\.exit|process\.exit|serverProcess\.kill/);
  });
});
