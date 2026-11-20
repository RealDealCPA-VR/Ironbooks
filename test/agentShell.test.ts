/**
 * Agent full access: the shell bridge (plan 5.5, 5.7, 5.8, 7.2; D9, D10).
 *
 *  - lib/agent/shellTicket.ts: the approval ticket's HMAC, its expiry, the operation and the input
 *    it is good for; electron/agentShell.js checks tickets with the same algorithm.
 *  - electron/agentShell.js: the replay memory, the folders agents may use ("..", another drive, a
 *    share, device paths, links), the scripted dialogs (a question without an answer stops the flow
 *    cleanly, naming the question; nothing ever waits on screen), the endpoint itself over a real
 *    named pipe or Unix socket with fake flows, printing from a hidden window, the desktop notice.
 *  - lib/agent/shell.ts: the server's side over that endpoint, files.save, the print handler of
 *    the effects outbox. No secret the approver typed ever comes back in an answer.
 *  - lib/agent/operations/shell.ts agrees with the shell's own table, and electron/main.js and
 *    preload.js are wired as described (read as text, like the other shell tests: main.js starts
 *    the app when it is loaded).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '@/lib/services/_base';
import { SHELL_TICKET_SECONDS, type ShellOperationDef, type ShellTicket } from '@/lib/agent/contract';
import { makeShellTicket, shellInputHash, shellTicketProblem, stableJson } from '@/lib/agent/shellTicket';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import {
  AGENT_OUTBOX_NAME,
  defaultAgentFolders,
  installShellPrinting,
  printThroughShell,
  runShellOperation,
  sendShellLine,
  SHELL_DOCUMENTS_ENV,
  SHELL_ENDPOINT_ENV,
  SHELL_KEY_ENV,
  shellAvailable,
} from '@/lib/agent/shell';
import { showAgentRequestNotice } from '@/lib/desktop/agentNotice';
import { effects, setPrintHandler } from '@/lib/effects';

const mocks = vi.hoisted(() => ({
  folders: [] as string[],
  staged: new Map<string, { file: { fileId: string; name: string; type: string; size: number }; bytes: Uint8Array }>(),
  scope: undefined as unknown,
}));

// Other units' modules: replaced here, as the contract describes them.
vi.mock('@/lib/services/agentPolicies', () => ({
  loadAgentPolicy: vi.fn(async () => ({ folders: mocks.folders })),
}));
vi.mock('@/lib/agent/files', () => ({
  readStagedFile: vi.fn(async (owner: { companyId: string; agentId: string }, fileId: string) => mocks.staged.get(`${owner.companyId}/${owner.agentId}/${fileId}`) ?? null),
  allowedFolder: vi.fn(async (allowed: readonly string[], folder: string) => {
    const want = path.resolve(folder).toLowerCase();
    const ok = allowed.some((a) => {
      const base = path.resolve(a).toLowerCase();
      return want === base || want.startsWith(base + path.sep);
    });
    return ok && fs.existsSync(folder) ? path.resolve(folder) : null;
  }),
}));
vi.mock('@/lib/serviceScope', () => ({ currentServiceScope: () => mocks.scope }));

/* eslint-disable @typescript-eslint/no-require-imports */
const agentShell = require('../electron/agentShell.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Electron's dialog module as the flows use it. */
interface FakeDialogs {
  showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>;
  showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog?: (...args: unknown[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showErrorBox: (...args: unknown[]) => void;
}

/**
 * A window as Electron makes one: `title` (and the rest) are accessors on its class, so
 * `'title' in win` is true. Every flow in main.js passes one first; the options come second.
 */
class FakeBrowserWindow {
  webContents = { id: 1 };
  get title() {
    return 'Ironbooks';
  }
  set title(_v: string) {}
  isDestroyed() {
    return false;
  }
}
const WIN = new FakeBrowserWindow();

const read =(rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const main = read('electron/main.js');
const preload = read('electron/preload.js');
/** The body of a top-level function in main.js (up to the next top-level declaration). */
const fnBody = (signature: string) => {
  const at = main.indexOf(signature);
  expect(at, signature).toBeGreaterThan(-1);
  const rest = main.slice(at + signature.length);
  const end = rest.search(/\n(?:async function |function |const |let |ipcMain\.|app\.on\(|app\.whenReady\()/);
  return main.slice(at, at + signature.length + (end < 0 ? rest.length : end));
};

const KEY = 'a1'.repeat(32);
const OTHER_KEY = 'b2'.repeat(32);
const COMPANY = 'c0000000-0000-4000-8000-000000000001';
const AGENT = 'a0000000-0000-4000-8000-000000000001';
const PERSON = 'u0000000-0000-4000-8000-000000000001';
const approver = { db: {} as never, companyId: COMPANY, userId: PERSON, role: 'admin' } as ServiceContext;
const def = (id: string) => SHELL_OPERATIONS.find((d) => d.id === id) as ShellOperationDef;
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
const SECRET = 'correct horse battery';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-agent-shell-'));
const ALLOWED = path.join(TMP, 'Documents', 'Ironbooks');
const OUTSIDE = path.join(TMP, 'Elsewhere');
fs.mkdirSync(ALLOWED, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

describe('the approval ticket (lib/agent/shellTicket.ts)', () => {
  const input = { file: 'C:\\Books\\Copy.ironbooks', nested: { b: 2, a: [1, { z: true, y: null }] } };
  const make = (over: Partial<{ now: number; operation: string; input: unknown }> = {}) =>
    makeShellTicket(KEY, { requestId: 'req-1', operation: over.operation ?? 'shell.company.saveCopyAs', input: over.input ?? input, approverId: PERSON, now: over.now });

  it('is good for exactly its operation and input, whatever the order of the keys', () => {
    const now = 1_700_000_000_000;
    const t = make({ now });
    expect(t.expiresAt).toBe(now + SHELL_TICKET_SECONDS * 1000);
    expect(t.mac).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { nested: { a: [1, { y: null, z: true }], b: 2 }, file: 'C:\\Books\\Copy.ironbooks' };
    expect(shellTicketProblem(KEY, t, 'shell.company.saveCopyAs', reordered, now + 1000)).toBeNull();
  });

  it('refuses another key, an altered field, a late ticket, another operation, a changed input', () => {
    const now = Date.now();
    const t = make({ now });
    expect(shellTicketProblem(OTHER_KEY, t, 'shell.company.saveCopyAs', input, now)).toMatch(/not made by this Ironbooks/);
    expect(shellTicketProblem(KEY, { ...t, approverId: 'someone-else' }, 'shell.company.saveCopyAs', input, now)).toMatch(/not made by this Ironbooks/);
    expect(shellTicketProblem(KEY, { ...t, expiresAt: t.expiresAt + 60_000 }, 'shell.company.saveCopyAs', input, now)).toMatch(/not made by this Ironbooks/);
    expect(shellTicketProblem(KEY, t, 'shell.company.saveCopyAs', input, t.expiresAt + 1)).toMatch(/ran out/);
    expect(shellTicketProblem(KEY, t, 'shell.company.close', input, now)).toMatch(/another request/);
    expect(shellTicketProblem(KEY, t, 'shell.company.saveCopyAs', { ...input, file: 'C:\\Windows\\x.ironbooks' }, now)).toMatch(/changed after it was approved/);
    // One made to last far longer than a ticket lasts was not made by makeShellTicket.
    const far = make({ now: now + 10 * 60_000 });
    expect(shellTicketProblem(KEY, far, 'shell.company.saveCopyAs', input, now)).toMatch(/could not be read/);
  });

  it('fails closed without a key or with an unreadable ticket', () => {
    expect(() => makeShellTicket('', { requestId: 'r', operation: 'o', input: {}, approverId: 'p' })).toThrow(/no key/);
    expect(() => makeShellTicket(KEY, { requestId: '', operation: 'o', input: {}, approverId: 'p' })).toThrow(/request id/);
    const t = make();
    expect(shellTicketProblem('', t, 'shell.company.saveCopyAs', input)).toMatch(/no key/);
    for (const bad of [null, {}, { ...t, mac: 'zz' }, { ...t, expiresAt: 'soon' }, { ...t, inputHash: 'abc' }]) {
      expect(shellTicketProblem(KEY, bad as unknown as ShellTicket, 'shell.company.saveCopyAs', input)).toMatch(/could not be read/);
    }
  });

  it('the shell checks with the same algorithm, byte for byte', () => {
    const values: unknown[] = [null, 0, -0, 1.5, 'x', [1, undefined, () => 1], { b: 1, a: undefined, c: { y: [], x: {} } }, { d: new Date(0) }, NaN, true];
    for (const v of values) {
      expect(agentShell.stableJson(v), JSON.stringify(v)).toBe(stableJson(v));
      expect(agentShell.inputHash(v)).toBe(shellInputHash(v));
    }
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const now = Date.now();
    const t = make({ now });
    // What travels is JSON: the shell hashes the parsed copy.
    const sent = JSON.parse(JSON.stringify({ ticket: t, input }));
    expect(agentShell.ticketProblem(KEY, sent.ticket, 'shell.company.saveCopyAs', sent.input, now)).toBeNull();
    for (const [k, op, inp, at] of [
      [OTHER_KEY, 'shell.company.saveCopyAs', input, now],
      [KEY, 'shell.company.close', input, now],
      [KEY, 'shell.company.saveCopyAs', { other: 1 }, now],
      [KEY, 'shell.company.saveCopyAs', input, t.expiresAt + 1],
    ] as const) {
      expect(agentShell.ticketProblem(k, t, op, inp, at)).toBe(shellTicketProblem(k, t, op, inp, at));
    }
    expect(agentShell.TICKET_SECONDS).toBe(SHELL_TICKET_SECONDS);
  });

  it('a ticket is used once: the same ticket, or another for the same request, is a replay', () => {
    const memory = agentShell.createReplayMemory();
    const now = Date.now();
    const t = make({ now });
    expect(memory.use(t, now)).toBe(true);
    expect(memory.use(t, now + 1)).toBe(false);
    expect(memory.use(make({ now: now + 5 }), now + 10)).toBe(false);
    const other = makeShellTicket(KEY, { requestId: 'req-2', operation: 'shell.company.close', input: {}, approverId: PERSON, now });
    expect(memory.use(other, now)).toBe(true);
    // Once they have run out they are forgotten (the ticket check refuses them anyway).
    expect(memory.use(other, other.expiresAt + 1)).toBe(true);
    expect(memory.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Folders agents may use
// ---------------------------------------------------------------------------

describe('the folders agents may use', () => {
  const win = { platform: 'win32', fs: null };
  const allowed = ['C:\\Users\\Dana\\Documents\\Ironbooks', '\\\\office\\books\\Clients'];
  const problem = (p: string, opts = win) => agentShell.pathProblem(p, allowed, opts);

  it('takes a path inside an allowed folder, below it, in any case on Windows', () => {
    expect(problem('C:\\Users\\Dana\\Documents\\Ironbooks\\Copy.ironbooks')).toBeNull();
    expect(problem('C:\\Users\\Dana\\Documents\\Ironbooks\\new\\deeper\\Copy.ironbooks')).toBeNull();
    expect(problem('c:\\users\\dana\\documents\\IRONBOOKS\\x.bkp')).toBeNull();
    expect(problem('C:/Users/Dana/Documents/Ironbooks/x.bka')).toBeNull();
    expect(problem('\\\\office\\books\\Clients\\Acme.ironbooks')).toBeNull();
  });

  it('a file strictly inside: never the allowed folder itself (the flow would write "<folder>.ironbooks" beside it)', () => {
    for (const p of ['C:\\Users\\Dana\\Documents\\Ironbooks', 'C:\\Users\\Dana\\Documents\\Ironbooks\\', 'c:\\users\\dana\\documents\\ironbooks', '\\\\office\\books\\Clients']) {
      expect(problem(p), p).toMatch(/not in a folder agents may use/);
    }
    // What the flow writes for that input is outside too.
    expect(problem(agentShell.companyFilePath('C:\\Users\\Dana\\Documents\\Ironbooks'))).toMatch(/not in a folder agents may use/);
  });

  it('a name that only looks like the folder’s is another folder: Windows does not fold the Kelvin sign into "k"', () => {
    expect('Ironboo\u212As'.toLowerCase()).toBe('ironbooks'); // what a lower-case comparison would wrongly accept
    expect(problem('C:\\Users\\Dana\\Documents\\Ironboo\u212As\\x.ironbooks')).toMatch(/not in a folder agents may use/);
    expect(agentShell.windowsFold('Ironboo\u212As')).not.toBe(agentShell.windowsFold('IRONBOOKS'));
    expect(agentShell.windowsFold('Ironbooks')).toBe(agentShell.windowsFold('iRONBOOKS'));
    // "ß" has no one-character upper case: left as it is, never "SS".
    expect(agentShell.windowsFold('Straße')).toBe('STRAßE');
  });

  it('on the disk: names compared as the disk spells them, so a look-alike that is not there yet is refused', () => {
    const enoent = () => Object.assign(new Error('not there'), { code: 'ENOENT' });
    // A disk with C:\Docs\Ironbooks, spelled so; IRONBOOKS is a folder of its own (a case-sensitive folder).
    const strict = {
      lstat: (p: string) => {
        if (!['C:\\', 'C:\\Docs', 'C:\\Docs\\Ironbooks'].includes(p)) throw enoent();
      },
      realpath: (p: string) => p,
    };
    const opts = { platform: 'win32', fs: strict };
    expect(agentShell.pathProblem('C:\\Docs\\Ironbooks\\x.ironbooks', ['C:\\Docs\\Ironbooks'], opts)).toBeNull();
    expect(agentShell.pathProblem('C:\\Docs\\IRONBOOKS\\x.ironbooks', ['C:\\Docs\\Ironbooks'], opts)).toMatch(/leads outside/);
    // The usual disk: any case finds the folder, and its real path is spelled as the disk spells it.
    const folding = {
      lstat: (p: string) => {
        if (!['c:\\', 'c:\\docs', 'c:\\docs\\ironbooks'].includes(p.toLowerCase())) throw enoent();
      },
      realpath: (p: string) => (p.toLowerCase() === 'c:\\docs\\ironbooks' ? 'C:\\Docs\\Ironbooks' : p.toLowerCase() === 'c:\\docs' ? 'C:\\Docs' : 'C:\\'),
    };
    expect(agentShell.pathProblem('C:\\DOCS\\IRONBOOKS\\new\\x.ironbooks', ['C:\\Docs\\Ironbooks'], { platform: 'win32', fs: folding })).toBeNull();
    // A part the disk will say nothing about (no access) is refused, never passed over.
    const denied = {
      lstat: (p: string) => {
        if (p === 'C:\\Docs\\Ironbooks\\locked') throw Object.assign(new Error('no'), { code: 'EACCES' });
        if (!['C:\\', 'C:\\Docs', 'C:\\Docs\\Ironbooks'].includes(p)) throw enoent();
      },
      realpath: (p: string) => p,
    };
    expect(agentShell.pathProblem('C:\\Docs\\Ironbooks\\locked\\x', ['C:\\Docs\\Ironbooks'], { platform: 'win32', fs: denied })).toMatch(/leads outside/);
  });

  it('refuses "..", a folder beside it, another drive, another share, device paths', () => {
    expect(problem('C:\\Users\\Dana\\Documents\\Ironbooks\\..\\..\\AppData\\x.ironbooks')).toMatch(/not in a folder agents may use/);
    expect(problem('C:\\Users\\Dana\\Documents\\Ironbooks2\\x.ironbooks')).toMatch(/not in a folder agents may use/);
    expect(problem('D:\\Users\\Dana\\Documents\\Ironbooks\\x.ironbooks')).toMatch(/not in a folder agents may use/);
    expect(problem('\\\\evil\\share\\x.ironbooks')).toMatch(/not in a folder agents may use/);
    expect(problem('\\\\office\\other\\Clients\\x.ironbooks')).toMatch(/not in a folder agents may use/);
    for (const p of ['\\\\?\\C:\\Users\\Dana\\Documents\\Ironbooks\\x', '\\\\.\\pipe\\x', '\\??\\C:\\x']) {
      expect(problem(p), p).toMatch(/not a full path/);
    }
  });

  it('refuses what is not a plain full path: relative, drive-relative, streams, device names, trailing dots', () => {
    for (const p of [
      'Ironbooks\\x.ironbooks',
      '\\Users\\Dana\\x',
      'C:Ironbooks\\x',
      'C:\\Users\\Dana\\Documents\\Ironbooks\\x.ironbooks:hidden',
      'C:\\Users\\Dana\\Documents\\Ironbooks\\CON',
      'C:\\Users\\Dana\\Documents\\Ironbooks\\nul.ironbooks',
      'C:\\Users\\Dana\\Documents\\Ironbooks\\x.',
      ' C:\\Users\\Dana\\Documents\\Ironbooks\\x',
      'C:\\Users\\Dana\\Documents\\Ironbooks\\a\u202Eb',
      '',
    ]) {
      expect(problem(p), JSON.stringify(p)).toMatch(/not a full path/);
    }
    expect(agentShell.pathProblem('C:\\Users\\Dana\\Documents\\Ironbooks\\x', [], win)).toMatch(/not in a folder agents may use/);
  });

  it('works the same way on macOS and Linux', () => {
    const posix = { platform: 'linux', fs: null };
    expect(agentShell.pathProblem('/home/dana/Documents/Ironbooks/x.ironbooks', ['/home/dana/Documents/Ironbooks'], posix)).toBeNull();
    expect(agentShell.pathProblem('/home/dana/Documents/Ironbooks/../.ssh/x', ['/home/dana/Documents/Ironbooks'], posix)).toMatch(/not in a folder/);
    expect(agentShell.pathProblem('/home/dana/Documents/IRONBOOKS/x', ['/home/dana/Documents/Ironbooks'], posix)).toMatch(/not in a folder/);
    expect(agentShell.pathProblem('Documents/x', ['/home/dana/Documents/Ironbooks'], posix)).toMatch(/not a full path/);
  });

  it('follows links on the disk: a link inside an allowed folder must not lead out of it', () => {
    const link = path.join(ALLOWED, 'link');
    fs.symlinkSync(OUTSIDE, link, 'junction');
    try {
      expect(agentShell.pathProblem(path.join(link, 'x.ironbooks'), [ALLOWED])).toMatch(/leads outside/);
      expect(agentShell.pathProblem(path.join(ALLOWED, 'not', 'there', 'yet.ironbooks'), [ALLOWED])).toBeNull();
      expect(agentShell.pathProblem(path.join(OUTSIDE, 'x.ironbooks'), [ALLOWED])).toMatch(/not in a folder/);
    } finally {
      fs.rmSync(link, { recursive: false, force: true });
    }
  });

  it('by default: the company file’s folder, Documents\\Ironbooks and its Agent Outbox', () => {
    const folders = agentShell.defaultFolders({ companyFile: path.join(TMP, 'Books', 'Acme.ironbooks'), documents: path.join(TMP, 'Documents') });
    expect(folders).toEqual([path.join(TMP, 'Books'), ALLOWED, path.join(ALLOWED, AGENT_OUTBOX_NAME)]);
    expect(agentShell.OUTBOX_NAME).toBe(AGENT_OUTBOX_NAME);
    expect(agentShell.defaultFolders({ companyFile: null, documents: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scripted dialogs
// ---------------------------------------------------------------------------

describe('a flow’s dialogs answered from the request', () => {
  const spec = agentShell.OPERATIONS;
  const script = (operation: string, over: { input?: object; answers?: object; secrets?: object; exists?: (p: string) => boolean } = {}) =>
    new agentShell.ShellScript({ operation, spec: spec[operation], input: over.input ?? {}, answers: over.answers ?? {}, secrets: over.secrets ?? {}, fileExists: over.exists ?? (() => false) });

  it('a question with no answer is answered as Cancel, and the request says which question it was', () => {
    const s = script('shell.company.close');
    const r = s.messageBox([WIN, { message: 'Close the company file?', buttons: ['Close Company', 'Cancel'], defaultId: 1, cancelId: 1 }]);
    expect(r).toEqual({ response: 1, checkboxChecked: false });
    expect(s.problems[0]).toMatch(/needed an answer to "Close the company file\?"/);
    expect(s.problems[0]).toMatch(/The agent can ask again/);
  });

  it('reads a dialog’s options as Electron does: after the window, never the window itself', () => {
    expect('title' in WIN).toBe(true);
    const box = { message: 'Close the company file?', buttons: ['Close Company', 'Cancel'], defaultId: 1, cancelId: 1 };
    for (const args of [[WIN, box], [undefined, box], [null, box], [box]]) expect(agentShell.dialogOptions(args)).toBe(box);
    expect(agentShell.dialogOptions([WIN])).toBeNull();
    expect(agentShell.dialogOptions([WIN, WIN])).toBeNull();
    // Answered no, with the window first: the box's own cancel button, never the first.
    const no = script('shell.hosting.stop', { answers: { disconnectOthers: false } });
    const others = { message: 'Others are working in this company file', buttons: ['Switch to Single-user Mode', 'Cancel'], defaultId: 1, cancelId: 1 };
    expect(no.messageBox([WIN, others]).response).toBe(1);
    expect(no.stoppedBy).toMatch(/was "Cancel"/);
    // A question this operation has no answer for: its cancel button, and the request is not done.
    const other = script('shell.update.install', { answers: { closeWhileHosting: true } });
    expect(other.messageBox([WIN, box]).response).toBe(1);
    expect(other.problems[0]).toMatch(/has no answer for/);
    const unsaved = { message: 'Close Ironbooks?', buttons: ['Close Without Recording', 'Cancel'], defaultId: 1, cancelId: 1 };
    expect(script('shell.update.install').messageBox([WIN, unsaved]).response).toBe(1);
    expect(script('shell.update.install', { answers: { closeOverUnsavedForm: true } }).messageBox([WIN, unsaved]).response).toBe(0);
    // A notice with the window first is still a notice.
    const n = script('shell.hosting.start');
    expect(n.messageBox([WIN, { noLink: true, type: 'info', message: 'Multi-user mode is on', detail: 'People can join.' }]).response).toBe(0);
    expect(n.notices).toEqual(['Multi-user mode is on. People can join.']);
    // Options it cannot read: no button at all (-1, which every flow takes for "no"), and not done.
    const unread = script('shell.company.close');
    expect(unread.messageBox([WIN])).toEqual({ response: -1, checkboxChecked: false });
    expect(unread.problems[0]).toMatch(/could not read/);
    expect(unread.saveDialog([WIN]).canceled).toBe(true);
    expect(unread.openDialog([WIN]).canceled).toBe(true);
    expect(unread.problems).toHaveLength(3);
  });

  it('a Save dialog after the window adds the file type before it looks for a file there', () => {
    const filters = [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }];
    const target = path.join(ALLOWED, 'Other');
    const there = new Set([`${target}.ironbooks`]);
    const s = script('shell.company.saveCopyAs', { input: { file: target }, exists: (p) => there.has(p) });
    expect(s.saveDialog([WIN, { title: 'Save a Copy of the Company File', filters, properties: ['createDirectory', 'showOverwriteConfirmation'] }]).canceled).toBe(true);
    expect(s.problems[0]).toMatch(/already a file at ".*Other\.ironbooks"/);
    const open = script('shell.company.open', { input: { file: 'C:\\B\\A.ironbooks' }, exists: () => true });
    expect(open.openDialog([WIN, { title: 'Open Company File', filters, properties: ['openFile'] }])).toEqual({ canceled: false, filePaths: ['C:\\B\\A.ironbooks'] });
  });

  it('the path a dialog gives is checked again against the folders, as the flow will write it', () => {
    const checkPath = vi.fn((p: string) => (p.startsWith(ALLOWED + path.sep) ? null : `"${p}" is not in a folder agents may use on this computer.`));
    const make = (input: object, op = 'shell.company.saveCopyAs') =>
      new agentShell.ShellScript({ operation: op, spec: spec[op], input, answers: {}, secrets: {}, fileExists: () => false, checkPath });
    const filters = [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }];
    const folder = make({ file: ALLOWED });
    expect(folder.saveDialog([WIN, { filters }]).canceled).toBe(true);
    expect(checkPath).toHaveBeenCalledWith(`${ALLOWED}.ironbooks`);
    expect(folder.problems[0]).toMatch(/not in a folder agents may use/);
    const fine = make({ file: path.join(ALLOWED, 'Copy') });
    expect(fine.saveDialog([WIN, { filters }])).toEqual({ canceled: false, filePath: path.join(ALLOWED, 'Copy.ironbooks') });
    const opened = make({ file: path.join(OUTSIDE, 'A.ironbooks') }, 'shell.company.open');
    expect(opened.openDialog([WIN, { filters }]).canceled).toBe(true);
    expect(opened.problems[0]).toMatch(/not in a folder agents may use/);
  });

  it('yes and no, and the window’s own button words for a choice', () => {
    const s = script('shell.company.open', { answers: { cloudFolder: true, temporaryFolder: 'open it here anyway', readOnlyFile: 'Maybe' } });
    expect(s.messageBox([{ message: 'In OneDrive', buttons: ['Open It', 'Cancel'], cancelId: 1 }]).response).toBe(0);
    expect(s.messageBox([{ message: 'Temporary', buttons: ['Save a Copy and Open It', 'Open It Here Anyway', 'Cancel'], cancelId: 2 }]).response).toBe(1);
    expect(s.messageBox([{ message: 'Read-only', buttons: ['Save a Copy and Open It', 'Cancel'], cancelId: 1 }]).response).toBe(1);
    expect(s.problems[0]).toMatch(/not one of its choices/);
    const no = script('shell.company.close', { answers: { closeWhileHosting: false } });
    expect(no.messageBox([{ message: 'Close it?', buttons: ['Close Company', 'Cancel'], cancelId: 1 }]).response).toBe(1);
    expect(no.stoppedBy).toMatch(/the answer to "Close it\?" was "Cancel"/);
  });

  it('a question the operation does not cover is never answered yes', () => {
    const s = script('shell.company.switch', { answers: { closeWhileHosting: true } });
    expect(s.messageBox([{ message: 'Close it?', buttons: ['Close Company', 'Cancel'], cancelId: 1 }]).response).toBe(1);
    expect(s.messageBox([{ message: 'Something new?', buttons: ['Do It', 'Cancel'], cancelId: 1 }]).response).toBe(1);
    // A box without a cancel button of its own: the one that says so, else the last, never the first.
    expect(s.messageBox([{ message: 'No id', buttons: ['Do It', 'Cancel', 'Help'] }]).response).toBe(1);
    expect(s.messageBox([{ message: 'No id either', buttons: ['Do It', 'Stop'] }]).response).toBe(1);
    expect(s.problems).toHaveLength(4);
    expect(s.problems[1]).toMatch(/asked "Something new\?", which this request has no answer for/);
  });

  it('notices are kept for the answer; the operation’s own question is answered by the approval', () => {
    const s = script('shell.ollama.install');
    expect(s.messageBox([{ message: 'Multi-user mode is on', detail: 'People can join.' }]).response).toBe(0);
    expect(s.notices).toEqual(['Multi-user mode is on. People can join.']);
    expect(s.messageBox([{ message: 'Install Ollama?', buttons: ['Download and install', 'Cancel'], cancelId: 1 }]).response).toBe(0);
    const copy = script('shell.company.saveCopyAs');
    expect(copy.messageBox([{ message: 'The copy is saved.', buttons: ['OK', 'Show in Folder'], cancelId: 0 }]).response).toBe(0);
    expect(copy.problems).toEqual([]);
  });

  it('a Save dialog takes the input’s path, adds the file type, and never a file already there', () => {
    const target = path.join(ALLOWED, 'Copy');
    const s = script('shell.company.saveCopyAs', { input: { file: target } });
    const filters = [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }];
    expect(s.saveDialog([null, { filters }])).toEqual({ canceled: false, filePath: `${target}.ironbooks` });
    expect(s.saveDialog([null, { filters }]).canceled).toBe(true);
    expect(s.problems[0]).toMatch(/second place to save/);
    const taken = script('shell.company.saveCopyAs', { input: { file: `${target}.ironbooks` }, exists: () => true });
    expect(taken.saveDialog([{ filters }]).canceled).toBe(true);
    expect(taken.problems[0]).toMatch(/already a file .*never replaces a file/);
  });

  it('an Open dialog takes the input’s file only when it is of a kind it offers and is there', () => {
    const filters = [{ name: 'Company', extensions: ['ironbooks'] }];
    const ok = script('shell.company.open', { input: { file: 'C:\\B\\A.ironbooks' }, exists: () => true });
    expect(ok.openDialog([{ filters }])).toEqual({ canceled: false, filePaths: ['C:\\B\\A.ironbooks'] });
    const wrongKind = script('shell.company.open', { input: { file: 'C:\\B\\A.exe' }, exists: () => true });
    expect(wrongKind.openDialog([{ filters }]).canceled).toBe(true);
    expect(wrongKind.problems[0]).toMatch(/takes \.ironbooks/);
    const missing = script('shell.company.open', { input: { file: 'C:\\B\\A.ironbooks' } });
    expect(missing.openDialog([{ filters }]).canceled).toBe(true);
    expect(missing.problems[0]).toMatch(/no file at/);
  });

  it('a password prompt takes what the approver typed, tried once; without it the flow stops', async () => {
    const onSubmit = vi.fn(async (pw: string) => (pw === SECRET ? { ok: true, value: { companyName: 'Acme' } } : { ok: false, error: 'That password does not open this file.' }));
    const none = script('shell.portable.open');
    expect(await none.passwordPrompt({ onSubmit })).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(none.problems[0]).toMatch(/protected with a password/);
    const right = script('shell.portable.open', { secrets: { backup_password: SECRET } });
    expect(await right.passwordPrompt({ onSubmit })).toEqual({ companyName: 'Acme' });
    expect(await right.passwordPrompt({ onSubmit })).toBeNull(); // never asked twice
    const wrong = script('shell.portable.open', { secrets: { backup_password: 'nope' } });
    expect(await wrong.passwordPrompt({ onSubmit })).toBeNull();
    // A failed request is final (plan 7.2): the way on is the agent asking again.
    expect(wrong.problems[0]).toMatch(/does not open this file\. The agent can ask again/);
    right.finish();
    expect(right.secrets).toEqual({});
  });

  it('outside a script every dialog and prompt goes to the person exactly as before', async () => {
    const asked = vi.fn(async (..._args: unknown[]) => ({ response: 7, checkboxChecked: true }));
    const told = vi.fn((..._args: unknown[]) => {});
    const person: FakeDialogs = { showMessageBox: asked, showSaveDialog: vi.fn(async () => ({ canceled: true })), showErrorBox: told };
    agentShell.scriptDialogs(person);
    agentShell.scriptDialogs(person); // once only
    const realPrompt = vi.fn(async () => 'typed by a person');
    const prompt = agentShell.scriptedPrompt('password', realPrompt);
    expect(await person.showMessageBox('win', { message: 'Hi', buttons: ['A', 'B'] })).toEqual({ response: 7, checkboxChecked: true });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith('win', { message: 'Hi', buttons: ['A', 'B'] });
    expect(await prompt('win', { title: 't' })).toBe('typed by a person');
    person.showErrorBox('t', 'c');
    expect(told).toHaveBeenCalledWith('t', 'c');

    // Inside one: nothing reaches the person. After it ended (the flow left work running): the person again.
    const s = script('shell.company.close');
    let late: Promise<unknown> = Promise.resolve();
    await agentShell.runScripted(s, async () => {
      await person.showMessageBox(null, { message: 'Close?', buttons: ['Close Company', 'Cancel'], cancelId: 1 });
      person.showErrorBox('Could not', 'do it');
      late = new Promise((r) => setTimeout(r, 20)).then(() => person.showMessageBox(null, { message: 'Later', buttons: ['A', 'B'] }));
    });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(told).toHaveBeenCalledTimes(1);
    expect(s.errors).toEqual(['Could not. do it']);
    await late;
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('the answer: a problem or an error box means it did not work; never a secret', () => {
    const s = script('shell.portable.open', { secrets: { backup_password: SECRET } });
    s.errorBox('Could not open the portable company file', `The password ${SECRET} is wrong`);
    const a = agentShell.scrub(agentShell.answerOf(s, { done: true, result: { echoed: SECRET } }, null), [SECRET]);
    expect(a.ok).toBe(false);
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(a.error).toContain('[hidden]');
    const quiet = script('shell.company.close');
    expect(agentShell.answerOf(quiet, { done: false }, null)).toEqual({ ok: false, result: null, error: 'Nothing was changed.', restarting: false });
    expect(agentShell.answerOf(quiet, { done: true, restarting: true, result: { a: 1 } }, null)).toEqual({ ok: true, result: { a: 1 }, error: null, restarting: true });
    expect(agentShell.answerOf(quiet, null, new Error('boom')).error).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// The endpoint, over a real pipe or socket, with fake flows
// ---------------------------------------------------------------------------

describe('the endpoint and the server’s side of it', () => {
  // A person's dialogs: in these tests they would never answer, so any call would hang the flow.
  const never = <T,>() => new Promise<T>(() => {});
  const onScreen = {
    showMessageBox: vi.fn((..._args: unknown[]) => never<{ response: number; checkboxChecked: boolean }>()),
    showSaveDialog: vi.fn((..._args: unknown[]) => never<{ canceled: boolean; filePath?: string }>()),
    showOpenDialog: vi.fn((..._args: unknown[]) => never<{ canceled: boolean; filePaths: string[] }>()),
    showErrorBox: vi.fn((..._args: unknown[]) => {}),
  };
  const person: FakeDialogs = { ...onScreen };
  agentShell.scriptDialogs(person);
  const personPassword = vi.fn(() => new Promise(() => {}));
  const passwordPrompt = agentShell.scriptedPrompt('password', personPassword);
  const ran: string[] = [];

  // The flows call the dialogs as main.js does: the window first (a class with a `title` of its own).
  const flows = {
    'shell.company.saveCopyAs': async () => {
      ran.push('saveCopyAs');
      const res = await person.showSaveDialog(WIN, {
        title: 'Save a Copy of the Company File',
        message: 'The copy is a separate company file: changes in one do not appear in the other.',
        filters: [{ name: 'Ironbooks Company File', extensions: ['ironbooks'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (res.canceled || !res.filePath) return { done: false };
      // As saveCopyAsFlow: the server's save replaces a file that is there.
      fs.writeFileSync(res.filePath, 'copy');
      await person.showMessageBox(WIN, { noLink: true, type: 'info', message: 'The copy is saved.', buttons: ['OK', 'Show in Folder'], defaultId: 0, cancelId: 0 });
      return { done: true, result: { file: res.filePath } };
    },
    'shell.company.close': async () => {
      ran.push('close');
      const { response } = await person.showMessageBox(WIN, {
        noLink: true,
        type: 'warning',
        message: 'Close the company file?',
        buttons: ['Close Company', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0 ? { done: true, restarting: true } : { done: false };
    },
    'shell.portable.open': async () => {
      ran.push('portable');
      const value = await passwordPrompt(WIN, {
        onSubmit: async (pw: string) => (pw === SECRET ? { ok: true, value: { companyName: 'Acme' } } : { ok: false, error: `"${pw}" does not open this file.` }),
      });
      if (!value) return { done: false };
      // A flow that (wrongly) repeats the password: it never reaches the answer.
      return { done: true, result: { companyName: 'Acme', note: `opened with ${SECRET}` } };
    },
    'shell.print.file': async ({ input, file }: { input: { copies?: number }; file: { bytes: Buffer } }) => ({
      done: true,
      result: { size: file.bytes.length, head: file.bytes.subarray(0, 5).toString('latin1'), copies: input.copies ?? 1 },
    }),
    'shell.update.install': async () => {
      ran.push('update');
      const { response } = await person.showMessageBox(WIN, {
        type: 'warning',
        noLink: true,
        message: 'Close Ironbooks?',
        detail: 'A form has changes that are not recorded yet. Closing now loses them.',
        buttons: ['Close Without Recording', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0 ? { done: true, restarting: true, result: { installing: '1.8.0' } } : { done: false };
    },
    'shell.hosting.stop': async () => {
      ran.push('stop');
      await new Promise((r) => setTimeout(r, 300));
      return { done: true, result: { hosting: false } };
    },
  };

  let endpoint: { env: { endpoint: string; key: string }; ready: Promise<unknown>; close: () => Promise<void> };
  const saved = { endpoint: process.env[SHELL_ENDPOINT_ENV], key: process.env[SHELL_KEY_ENV] };

  beforeAll(async () => {
    endpoint = agentShell.openEndpoint({ flows, folders: () => [ALLOWED], key: KEY });
    await endpoint.ready;
    process.env[SHELL_ENDPOINT_ENV] = endpoint.env.endpoint;
    process.env[SHELL_KEY_ENV] = endpoint.env.key;
  });
  afterAll(async () => {
    setPrintHandler(null);
    await endpoint.close();
    for (const [k, v] of [[SHELL_ENDPOINT_ENV, saved.endpoint], [SHELL_KEY_ENV, saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    ran.length = 0;
    mocks.folders = [];
    mocks.scope = undefined;
  });

  const run = (id: string, input: Record<string, unknown>, answers: Record<string, unknown> = {}, secrets: Record<string, string> = {}, who = approver) =>
    runShellOperation(who, def(id), { id: `req-${Math.random().toString(36).slice(2)}`, agentId: AGENT, input }, answers, secrets);

  /** A line as the server sends it, with a ticket made as given. */
  const line = (operation: string, input: unknown, t: Partial<{ key: string; now: number; requestId: string; ticketInput: unknown }> = {}) =>
    JSON.stringify({
      ticket: makeShellTicket(t.key ?? KEY, { requestId: t.requestId ?? `req-${Math.random()}`, operation, input: t.ticketInput ?? input, approverId: PERSON, now: t.now }),
      operation,
      input,
      answers: {},
      secrets: {},
      folders: [],
    });

  it('listens where the environment says, with this launch’s key, in a private place', () => {
    expect(shellAvailable()).toBe(true);
    if (process.platform === 'win32') expect(endpoint.env.endpoint).toMatch(/^\\\\\.\\pipe\\ironbooks-agent-shell-[0-9a-f]{32}$/);
    else expect((fs.statSync(path.dirname(endpoint.env.endpoint)).mode & 0o077) === 0).toBe(true);
    expect(agentShell.ENDPOINT_ENV).toBe(SHELL_ENDPOINT_ENV);
    expect(agentShell.KEY_ENV).toBe(SHELL_KEY_ENV);
  });

  it('carries out an approved request: the Save dialog answered from the input, nothing on screen', async () => {
    const r = await run('shell.company.saveCopyAs', { file: path.join(ALLOWED, 'Copy') });
    expect(r).toEqual({ ok: true, result: { file: path.join(ALLOWED, 'Copy.ironbooks') }, error: null, restarting: false });
    expect(fs.readFileSync(path.join(ALLOWED, 'Copy.ironbooks'), 'utf8')).toBe('copy');
    expect(onScreen.showSaveDialog).not.toHaveBeenCalled();
    expect(onScreen.showMessageBox).not.toHaveBeenCalled();
    // Again to the same place: never over the file that is there now.
    const again = await run('shell.company.saveCopyAs', { file: path.join(ALLOWED, 'Copy.ironbooks') });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already a file/);
  });

  it('never saves over a company file that is there, when the name leaves out ".ironbooks"', async () => {
    const there = path.join(ALLOWED, 'Other.ironbooks');
    fs.writeFileSync(there, 'the books of another company');
    const r = await run('shell.company.saveCopyAs', { file: path.join(ALLOWED, 'Other') });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already a file at ".*Other\.ironbooks"/);
    expect(fs.readFileSync(there, 'utf8')).toBe('the books of another company');
    expect(ran).toEqual([]);
  });

  it('the allowed folder itself is not a file in it: its ".ironbooks" would land beside it', async () => {
    const r = await run('shell.company.saveCopyAs', { file: ALLOWED });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in a folder agents may use/);
    expect(fs.existsSync(`${ALLOWED}.ironbooks`)).toBe(false);
    // A name that only looks like the folder's is a folder beside it.
    const lookAlike = await run('shell.company.saveCopyAs', { file: path.join(TMP, 'Documents', 'IronbooKs', 'x.ironbooks') });
    expect(lookAlike.ok).toBe(false);
    expect(lookAlike.error).toMatch(/not in a folder agents may use|leads outside/);
    expect(ran).toEqual([]);
  });

  it('refuses a path outside the folders agents may use before the flow runs; the policy’s folders count', async () => {
    const r = await run('shell.company.saveCopyAs', { file: path.join(OUTSIDE, 'Copy.ironbooks') });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in a folder agents may use/);
    const dotdot = await run('shell.company.saveCopyAs', { file: path.join(ALLOWED, '..', '..', 'Elsewhere', 'x.ironbooks') });
    expect(dotdot.error).toMatch(/not in a folder agents may use/);
    expect(ran).toEqual([]);
    mocks.folders = [OUTSIDE];
    expect((await run('shell.company.saveCopyAs', { file: path.join(OUTSIDE, 'Copy.ironbooks') })).ok).toBe(true);
  });

  it('a flow that needs an answer it was not given fails cleanly, naming the question, and nothing waits', async () => {
    const started = Date.now();
    const r = await run('shell.company.close', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/needed an answer to "Close the company file\?" and the approval gave none/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(onScreen.showMessageBox).not.toHaveBeenCalled();
    expect(await run('shell.company.close', {}, { closeWhileHosting: true })).toEqual({ ok: true, result: null, error: null, restarting: true });
    const no = await run('shell.company.close', {}, { closeWhileHosting: false });
    expect(no.ok).toBe(false);
    expect(no.error).toMatch(/the answer to "Close the company file\?" was "Cancel"/);
    // A person's typed form is never thrown away without the approver saying so.
    const update = await run('shell.update.install', {});
    expect(update.ok).toBe(false);
    expect(update.error).toMatch(/needed an answer to "Close Ironbooks\?"/);
    expect((await run('shell.update.install', {}, { closeOverUnsavedForm: false })).ok).toBe(false);
    expect(await run('shell.update.install', {}, { closeOverUnsavedForm: true })).toEqual({ ok: true, result: { installing: '1.8.0' }, error: null, restarting: true });
    expect(onScreen.showMessageBox).not.toHaveBeenCalled();
  });

  it('the approver’s password is used for the run and never comes back', async () => {
    const target = path.join(ALLOWED, 'Restored.ironbooks');
    const input = { file: path.join(ALLOWED, 'Acme.bkp'), target };
    const none = await run('shell.portable.open', input);
    expect(none.error).toMatch(/protected with a password/);
    const wrong = await run('shell.portable.open', input, {}, { backup_password: `${SECRET} 2` });
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain(SECRET);
    const right = await run('shell.portable.open', input, {}, { backup_password: SECRET });
    expect(right.ok).toBe(true);
    expect(JSON.stringify(right)).not.toContain(SECRET);
    expect(right.result).toEqual({ companyName: 'Acme', note: 'opened with [hidden]' });
    expect(personPassword).not.toHaveBeenCalled();
  });

  it('refuses a missing, foreign, late, replayed or altered ticket, and what it cannot read', async () => {
    const input = { file: path.join(ALLOWED, 'T1.ironbooks') };
    const noTicket = await sendShellLine(JSON.stringify({ operation: 'shell.company.saveCopyAs', input }));
    expect(noTicket.error).toMatch(/could not be read/);
    expect((await sendShellLine(line('shell.company.saveCopyAs', input, { key: OTHER_KEY }))).error).toMatch(/not made by this Ironbooks/);
    expect((await sendShellLine(line('shell.company.saveCopyAs', input, { now: Date.now() - 10 * 60_000 }))).error).toMatch(/ran out/);
    expect((await sendShellLine(line('shell.company.saveCopyAs', input, { ticketInput: { file: path.join(ALLOWED, 'Other.ironbooks') } }))).error).toMatch(/changed after/);
    expect((await sendShellLine('not json')).error).toMatch(/could not be read/);
    expect((await sendShellLine(line('shell.nothing.here', {}))).error).toMatch(/cannot carry out/);
    expect((await sendShellLine(line('shell.company.saveCopyAs', { ...input, extra: 1 }))).error).toMatch(/"extra" is not something this request takes/);
    expect(ran).toEqual([]);
    const once = line('shell.company.saveCopyAs', input);
    expect((await sendShellLine(once)).ok).toBe(true);
    expect((await sendShellLine(once)).error).toMatch(/already used/);
    expect(ran).toEqual(['saveCopyAs']);
  });

  it('one request at a time; a slow answer is reported as such', async () => {
    const [a, b] = await Promise.all([run('shell.hosting.stop', {}), new Promise((r) => setTimeout(r, 50)).then(() => run('shell.hosting.stop', {}))]);
    expect(a.ok).toBe(true);
    expect(b.error).toMatch(/another approved request/);
    const slow = await sendShellLine(line('shell.hosting.stop', {}), 50);
    expect(slow.error).toMatch(/did not finish this in time/);
    await new Promise((r) => setTimeout(r, 400));
  });

  it('only a person approves: an agent’s context, no person, an unknown operation are refused', async () => {
    const asAgent = { ...approver, agent: { id: AGENT, name: 'Bot', mode: 'post' as const } };
    expect((await run('shell.company.close', {}, { closeWhileHosting: true }, {}, asAgent)).error).toMatch(/Only a person/);
    expect((await run('shell.company.close', {}, {}, {}, { ...approver, userId: null })).error).toMatch(/Only a person/);
    const fake = { ...def('shell.company.close'), id: 'shell.format.disk' };
    expect((await runShellOperation(approver, fake, { id: 'r', agentId: AGENT, input: {} }, {}, {})).error).toMatch(/does not know/);
    expect(ran).toEqual([]);
  });

  it('prints a staged PDF of this agent only; anything else is refused before the shell', async () => {
    const fileId = 'f'.repeat(32);
    mocks.staged.set(`${COMPANY}/${AGENT}/${fileId}`, { file: { fileId, name: 'Checks.pdf', type: 'application/pdf', size: PDF.length }, bytes: PDF });
    const r = await run('shell.print.file', { fileId, copies: 2 });
    expect(r).toEqual({ ok: true, result: { size: PDF.length, head: '%PDF-', copies: 2 }, error: null, restarting: false });
    const notPdf = 'e'.repeat(32);
    mocks.staged.set(`${COMPANY}/${AGENT}/${notPdf}`, { file: { fileId: notPdf, name: 'a.txt', type: 'text/plain', size: 2 }, bytes: Buffer.from('hi') });
    expect((await run('shell.print.file', { fileId: notPdf })).error).toMatch(/not a PDF/);
    expect((await run('shell.print.file', { fileId: 'd'.repeat(32) })).error).toMatch(/no staged file/);
    expect((await run('shell.print.file', { fileId, copies: 500 })).error).toMatch(/whole number from 1 to 100/);
    const big = 'c'.repeat(32);
    const bigPdf = Buffer.concat([PDF, Buffer.alloc(1_600_000)]);
    mocks.staged.set(`${COMPANY}/${AGENT}/${big}`, { file: { fileId: big, name: 'Year.pdf', type: 'application/pdf', size: bigPdf.length }, bytes: bigPdf });
    expect((await run('shell.print.file', { fileId: big })).error).toMatch(/too large to print without a person/);
  });

  it('the effects outbox prints through the shell, for the agent of the open scope, with an approval', async () => {
    const fileId = 'f'.repeat(32);
    expect(installShellPrinting()).toBe(true);
    await expect(effects.print({ fileId })).rejects.toThrow(/whose file/);
    mocks.scope = { ctx: { companyId: COMPANY, agent: { id: AGENT, name: 'Bot', mode: 'post' }, approval: { approvedBy: null, requestId: 'r1', grantId: null } } };
    await expect(printThroughShell({ fileId, printer: null, copies: 1, name: null })).rejects.toThrow(/approval/);
    mocks.scope = { ctx: { companyId: COMPANY, agent: { id: AGENT, name: 'Bot', mode: 'post' }, approval: { approvedBy: PERSON, requestId: 'r1', grantId: null } } };
    // Two jobs of one approved run: each gets its own ticket.
    expect((await effects.print({ fileId, copies: 2 })).printed).toBe(true);
    expect((await effects.print({ fileId })).printed).toBe(true);
  });

  it('without the desktop shell an electron operation says so; an unreachable shell is not answering', async () => {
    const keep = process.env[SHELL_KEY_ENV];
    delete process.env[SHELL_KEY_ENV];
    try {
      expect(shellAvailable()).toBe(false);
      expect((await run('shell.company.close', {})).error).toMatch(/needs the Ironbooks desktop app/);
    } finally {
      process.env[SHELL_KEY_ENV] = keep;
    }
    process.env[SHELL_KEY_ENV] = 'not-hex';
    expect(shellAvailable()).toBe(false);
    process.env[SHELL_KEY_ENV] = keep;
    const keepEndpoint = process.env[SHELL_ENDPOINT_ENV];
    process.env[SHELL_ENDPOINT_ENV] = process.platform === 'win32' ? '\\\\.\\pipe\\ironbooks-agent-shell-nobody' : path.join(TMP, 'nobody.sock');
    try {
      expect((await run('shell.company.close', {}, { closeWhileHosting: true })).error).toMatch(/not answering/);
    } finally {
      process.env[SHELL_ENDPOINT_ENV] = keepEndpoint;
    }
  });
});

// ---------------------------------------------------------------------------
// files.save (the server itself)
// ---------------------------------------------------------------------------

describe('files.save', () => {
  const fileId = '1'.repeat(32);
  beforeEach(() => {
    mocks.folders = [OUTSIDE];
    mocks.staged.set(`${COMPANY}/${AGENT}/${fileId}`, { file: { fileId, name: 'Report.pdf', type: 'application/pdf', size: PDF.length }, bytes: PDF });
  });
  const save = (input: Record<string, unknown>, who = approver) => runShellOperation(who, def('files.save'), { id: 'r', agentId: AGENT, input }, {}, {});

  it('saves the staged file in a folder the Admin allowed, never over a file already there', async () => {
    const r = await save({ fileId, folder: OUTSIDE });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(OUTSIDE, 'Report.pdf'))).toEqual(PDF);
    const again = await save({ fileId, folder: OUTSIDE });
    expect(again.error).toMatch(/already a file called "Report.pdf"/);
    expect((await save({ fileId, folder: OUTSIDE, name: 'June.pdf' })).ok).toBe(true);
  });

  it('Documents\\Ironbooks is the one in the Documents the desktop shell told the server (OneDrive can move it)', async () => {
    const keep = process.env[SHELL_DOCUMENTS_ENV];
    const docs = path.join(TMP, 'OneDrive', 'Documents');
    const outbox = path.join(docs, 'Ironbooks', AGENT_OUTBOX_NAME);
    fs.mkdirSync(outbox, { recursive: true });
    try {
      process.env[SHELL_DOCUMENTS_ENV] = docs;
      expect(defaultAgentFolders()).toEqual(expect.arrayContaining([path.join(docs, 'Ironbooks'), outbox]));
      mocks.folders = [];
      const r = await save({ fileId, folder: outbox });
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(path.join(outbox, 'Report.pdf'))).toEqual(PDF);
      // Not told, or told something that is not a full path: the home folder's Documents.
      for (const told of ['', 'Documents']) {
        process.env[SHELL_DOCUMENTS_ENV] = told;
        expect(defaultAgentFolders()).toContain(path.join(os.homedir(), 'Documents', 'Ironbooks'));
      }
    } finally {
      if (keep === undefined) delete process.env[SHELL_DOCUMENTS_ENV];
      else process.env[SHELL_DOCUMENTS_ENV] = keep;
    }
  });

  it('refuses a folder agents may not use, another agent’s file, and an agent approving', async () => {
    mocks.folders = [];
    expect((await save({ fileId, folder: OUTSIDE })).error).toMatch(/not a folder agents may save in/);
    expect((await runShellOperation(approver, def('files.save'), { id: 'r', agentId: 'someone-else', input: { fileId, folder: OUTSIDE } }, {}, {})).error).toMatch(/no staged file/);
    expect((await save({ fileId, folder: OUTSIDE }, { ...approver, agent: { id: AGENT, name: 'Bot', mode: 'post' } })).error).toMatch(/Only a person/);
  });
});

// ---------------------------------------------------------------------------
// The definitions agree with the shell
// ---------------------------------------------------------------------------

describe('the shell operations (lib/agent/operations/shell.ts)', () => {
  const electron = SHELL_OPERATIONS.filter((d) => d.runner === 'electron');

  it('every operation of plan 5.5, plus files.save run by the server', () => {
    expect(SHELL_OPERATIONS.map((d) => d.id).sort()).toEqual(
      [
        'shell.company.new',
        'shell.company.open',
        'shell.company.switch',
        'shell.company.close',
        'shell.company.saveCopyAs',
        'shell.portable.open',
        'shell.accountantCopy.open',
        'shell.backup.restoreAsNew',
        'shell.sandbox.enter',
        'shell.sandbox.leave',
        'shell.hosting.start',
        'shell.hosting.stop',
        'shell.hosting.connect',
        'shell.hosting.disconnect',
        'shell.update.install',
        'shell.ollama.install',
        'shell.print.file',
        'files.save',
      ].sort(),
    );
    expect(def('files.save').runner).toBe('server');
    expect(electron.map((d) => d.id).sort()).toEqual(Object.keys(agentShell.OPERATIONS).sort());
  });

  it('classes: update and Ollama send outside, printing is print, the rest is the company file', () => {
    for (const d of SHELL_OPERATIONS) {
      const want = ['shell.update.install', 'shell.ollama.install'].includes(d.id) ? 'outside' : d.id === 'shell.print.file' ? 'print' : 'file';
      expect(d.class, d.id).toBe(want);
      expect(d.hostOnly, d.id).toBe(true);
    }
    for (const id of ['shell.company.new', 'shell.company.open', 'shell.company.switch', 'shell.company.close', 'shell.sandbox.enter', 'shell.update.install', 'shell.hosting.connect']) {
      expect(def(id).restarts, id).toBe(true);
    }
    expect(def('shell.company.saveCopyAs').restarts).toBe(false);
    // Leaving only opens a page for the person; the restart, if any, is theirs.
    expect(def('shell.sandbox.leave').restarts).toBe(false);
    // Working in a practice copy stays off-limits (plan 4.6): said in so many words.
    expect(def('shell.sandbox.enter').why).toMatch(/cannot work in the practice copy/);
    expect(def('shell.sandbox.leave').why).toMatch(/nothing is left or deleted by this request itself/);
  });

  it('input fields and questions match the shell’s own table', () => {
    for (const d of electron) {
      const spec = agentShell.OPERATIONS[d.id];
      expect(Object.keys(d.input).sort(), d.id).toEqual(Object.keys(spec.fields).sort());
      for (const [name, field] of Object.entries(d.input)) {
        expect(field.type, `${d.id}.${name}`).toBe(spec.fields[name].type);
        expect(field.required, `${d.id}.${name}`).toBe(spec.fields[name].required);
      }
      expect(d.questions.map((q) => q.id).sort(), d.id).toEqual([...spec.questions].sort());
      for (const q of d.questions) {
        const boxes = agentShell.QUESTIONS.filter((b: { id?: string }) => b.id === q.id);
        expect(boxes.length, q.id).toBeGreaterThan(0);
        for (const box of boxes) expect(box.kind, q.id).toBe(q.kind);
        if (q.kind === 'choice') expect(boxes.map((b: { buttons: string[] }) => b.buttons)).toContainEqual(q.choices);
      }
      if (spec.password) expect(d.needsSecret, d.id).toContain(spec.password);
    }
    const asked = new Set(electron.flatMap((d) => d.questions.map((q) => q.id)));
    for (const box of agentShell.QUESTIONS) if (box.id) expect(asked.has(box.id), box.id).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Printing and the desktop notice
// ---------------------------------------------------------------------------

describe('printing from a hidden window (D10)', () => {
  type Decide = (details: { url: string }, cb: (r: { cancel?: boolean }) => void) => void;
  /** The window's own session (its partition), as electron/security.js never sets one up. */
  class FakeSession {
    beforeRequest: Decide | null = null;
    permissionRequest: ((wc: unknown, permission: string, cb: (ok: boolean) => void) => void) | null = null;
    permissionCheck: ((wc: unknown, permission: string) => boolean) | null = null;
    download: ((event: { preventDefault: () => void }) => void) | null = null;
    webRequest = {
      onBeforeRequest: (fn: Decide) => {
        this.beforeRequest = fn;
      },
    };
    setPermissionRequestHandler(fn: FakeSession['permissionRequest']) {
      this.permissionRequest = fn;
    }
    setPermissionCheckHandler(fn: FakeSession['permissionCheck']) {
      this.permissionCheck = fn;
    }
    on(ev: string, fn: (event: { preventDefault: () => void }) => void) {
      if (ev === 'will-download') this.download = fn;
    }
  }
  class FakeWindow {
    static last: FakeWindow | null = null;
    static noSession = false;
    opts: Record<string, unknown>;
    destroyed = false;
    loaded: string | null = null;
    lockedBeforeLoad = false;
    printed: Record<string, unknown> | null = null;
    webContents: {
      session?: FakeSession;
      getPrintersAsync: () => Promise<unknown[]>;
      print: (o: Record<string, unknown>, cb: (ok: boolean, why: string) => void) => void;
    };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      FakeWindow.last = this;
      this.webContents = {
        ...(FakeWindow.noSession ? {} : { session: new FakeSession() }),
        getPrintersAsync: async () => [{ name: 'HP_LaserJet', displayName: 'HP LaserJet 400' }],
        print: (o, cb) => {
          this.printed = o;
          cb(true, '');
        },
      };
    }
    async loadURL(u: string) {
      this.lockedBeforeLoad = Boolean(this.webContents.session?.beforeRequest);
      this.loaded = u;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  it('prints silently on the printer named from a hidden window that loads no file, then closes it', async () => {
    const r = await agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: PDF, printer: 'hp laserjet 400', copies: 2, settleMs: 0 });
    expect(r).toEqual({ printed: true, printer: 'HP_LaserJet', copies: 2 });
    const w = FakeWindow.last!;
    expect(w.opts.show).toBe(false);
    expect(w.opts.webPreferences).toMatchObject({ partition: 'ironbooks-agent-print', sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(w.loaded!.startsWith('data:application/pdf;base64,')).toBe(true);
    expect(Buffer.from(w.loaded!.slice('data:application/pdf;base64,'.length), 'base64')).toEqual(PDF);
    expect(w.printed).toMatchObject({ silent: true, deviceName: 'HP_LaserJet', copies: 2 });
    expect(w.destroyed).toBe(true);
    // The default printer when none is named.
    await agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: PDF, settleMs: 0 });
    expect(FakeWindow.last!.printed).toMatchObject({ silent: true, deviceName: undefined, copies: 1 });
  });

  it('the print window’s session is held off the network before the PDF loads: no request out, no permission, no download', async () => {
    await agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: PDF, settleMs: 0 });
    const w = FakeWindow.last!;
    expect(w.lockedBeforeLoad).toBe(true);
    const ses = w.webContents.session!;
    const decide = (url: string) => {
      let answer: { cancel?: boolean } | null = null;
      ses.beforeRequest!({ url }, (r) => {
        answer = r;
      });
      return answer;
    };
    for (const url of ['data:application/pdf;base64,JVBERi0=', 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html', 'blob:chrome-extension://x/1', 'about:blank']) {
      expect(decide(url), url).toEqual({});
    }
    for (const url of ['https://evil.example/collect', 'http://localhost:51234/api/accounts', 'file:///C:/Users/Dana/secrets.txt', 'ws://127.0.0.1:1/', 'not a url']) {
      expect(decide(url), url).toEqual({ cancel: true });
    }
    let granted: boolean | null = null;
    ses.permissionRequest!(null, 'media', (ok) => {
      granted = ok;
    });
    expect(granted).toBe(false);
    expect(ses.permissionCheck!(null, 'clipboard-sanitized-write')).toBe(false);
    const prevent = vi.fn();
    ses.download!({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();
    expect(agentShell.printRequestAllowed('https://example.com/')).toBe(false);
  });

  it('a window whose session cannot be held off the network prints nothing', async () => {
    FakeWindow.noSession = true;
    try {
      await expect(agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: PDF, settleMs: 0 })).rejects.toThrow(/off the network/);
      expect(FakeWindow.last!.loaded).toBeNull();
      expect(FakeWindow.last!.printed).toBeNull();
      expect(FakeWindow.last!.destroyed).toBe(true);
    } finally {
      FakeWindow.noSession = false;
    }
  });

  it('refuses a printer that is not there, what is not a PDF, a PDF too large for a data: address, and odd copies', async () => {
    await expect(agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: PDF, printer: 'Nowhere', settleMs: 0 })).rejects.toThrow(/no printer called "Nowhere"/);
    expect(FakeWindow.last!.destroyed).toBe(true);
    FakeWindow.last = null;
    await expect(agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: Buffer.from('MZ') })).rejects.toThrow(/Only a PDF/);
    const big = Buffer.concat([PDF, Buffer.alloc(1_600_000)]);
    await expect(agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: big })).rejects.toThrow(/too large to print without a person/);
    await expect(agentShell.printPdf({ BrowserWindow: FakeWindow, bytes: PDF, copies: 0 })).rejects.toThrow(/whole number from 1 to 100/);
    expect(FakeWindow.last).toBeNull();
  });
});

describe('the desktop notice when an agent asks (plan 7.2)', () => {
  class FakeNotice {
    static made: FakeNotice[] = [];
    static isSupported = () => true;
    handlers: Record<string, () => void> = {};
    shown = false;
    constructor(public opts: { title: string; body: string }) {
      FakeNotice.made.push(this);
    }
    on(ev: string, fn: () => void) {
      this.handlers[ev] = fn;
    }
    show() {
      this.shown = true;
    }
  }
  const win = (focused: boolean) => ({ isDestroyed: () => false, isFocused: () => focused });

  it('title and body only, one line each; it opens the approval center and nothing else', () => {
    expect(agentShell.cleanNotice({ title: 'Agent\nasks', body: 'Email invoice 1042\u202E', href: '/agent-requests/abc-123' })).toEqual({
      title: 'Agent asks',
      body: 'Email invoice 1042',
      href: '/agent-requests/abc-123',
    });
    for (const href of ['https://evil.example', '/agent-requests/../settings', '//x', '/users', undefined]) {
      expect(agentShell.cleanNotice({ title: 't', body: 'b', href }).href, String(href)).toBe('/agent-requests');
    }
    expect(agentShell.cleanNotice({ title: '  ', body: 'b' })).toBeNull();
  });

  it('shown only while the window is not in front; clicking it opens the page', () => {
    const open = vi.fn();
    expect(agentShell.showNotice({ Notification: FakeNotice, win: win(true), notice: { title: 'Bot asks', body: 'x' }, open })).toBe(false);
    expect(FakeNotice.made).toHaveLength(0);
    expect(agentShell.showNotice({ Notification: FakeNotice, win: win(false), notice: { title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests' }, open })).toBe(true);
    const n = FakeNotice.made[0];
    expect(n.opts).toEqual({ title: 'Bot asks', body: 'Email invoice 1042' });
    expect(n.shown).toBe(true);
    n.handlers.click();
    expect(open).toHaveBeenCalledWith('/agent-requests');
  });

  it('lib/desktop/agentNotice.ts calls the desktop bridge when there is one, and does nothing otherwise', () => {
    expect(() => showAgentRequestNotice({ title: 't', body: 'b', href: '/agent-requests' })).not.toThrow();
    const g = globalThis as { window?: unknown };
    const agentNotice = vi.fn(async () => true);
    g.window = { bookkeeper: { agentNotice } };
    try {
      showAgentRequestNotice({ title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests/r1' });
      expect(agentNotice).toHaveBeenCalledWith({ title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests/r1' });
      showAgentRequestNotice({ title: ' ', body: 'b', href: '/agent-requests' });
      expect(agentNotice).toHaveBeenCalledTimes(1);
      g.window = { bookkeeper: { agentNotice: () => Promise.reject(new Error('no')) } };
      expect(() => showAgentRequestNotice({ title: 't', body: 'b', href: '/agent-requests' })).not.toThrow();
      g.window = { bookkeeper: {} };
      expect(() => showAgentRequestNotice({ title: 't', body: 'b', href: '/agent-requests' })).not.toThrow();
    } finally {
      delete g.window;
    }
  });
});

// ---------------------------------------------------------------------------
// The wiring in electron/main.js and preload.js
// ---------------------------------------------------------------------------

describe('main.js and preload.js', () => {
  it('the scripted dialogs wrap what was there, after the agent service’s quiet answers', () => {
    expect(main).toContain("const agentShell = require('./agentShell');");
    expect(main).toContain("const promptForHost = agentShell.scriptedPrompt('host', require('./connectPrompt').promptForHost);");
    expect(main).toContain("const promptForFilePassword = agentShell.scriptedPrompt('password', require('./passwordPrompt').promptForFilePassword);");
    expect(main.match(/agentShell\.scriptDialogs\(dialog\);/g)).toHaveLength(1);
    expect(main.indexOf('dialog.showMessageBox = (...args) => (agentServiceHidden')).toBeLessThan(main.indexOf('agentShell.scriptDialogs(dialog);'));
    expect(main.indexOf('agentShell.scriptDialogs(dialog);')).toBeLessThan(main.indexOf('app.whenReady()'));
  });

  it('only the company server is told where the endpoint is and the key; a scratch server never', () => {
    const company = fnBody('async function startNextServer() {');
    expect(company).toContain('BKA_AGENT_SHELL: agentShellEnv().endpoint,');
    expect(company).toContain('BKA_AGENT_SHELL_KEY: agentShellEnv().key,');
    const scratch = fnBody('async function startScratchServer(dataDir) {');
    expect(scratch).toContain("BKA_AGENT_SHELL: '',");
    expect(scratch).toContain("BKA_AGENT_SHELL_KEY: '',");
    expect(main).not.toMatch(/process\.env\.BKA_AGENT_SHELL/);
    // The shell's own Documents, for files.save's folder check (never one planted in a scratch server).
    expect(company).toContain(`${SHELL_DOCUMENTS_ENV}: agentShellDocuments(),`);
    expect(scratch).toContain(`${SHELL_DOCUMENTS_ENV}: '',`);
    // Asking for Documents never stops the server from starting.
    expect(fnBody('function agentShellDocuments() {')).toMatch(/try \{\s*return app\.getPath\('documents'\);\s*\} catch \{\s*return '';/);
  });

  it('every operation the shell takes has its flow; none runs while Ironbooks is closing', () => {
    const block = main.slice(main.indexOf('const AGENT_SHELL_FLOWS = {'), main.indexOf('let agentShellEndpoint = null;'));
    for (const id of Object.keys(agentShell.OPERATIONS)) expect(block, id).toContain(`'${id}':`);
    expect(fnBody('function agentShellEnv() {')).toMatch(/if \(closingInProgress \|\| quittingAfterBackup\) throw/);
    // Save Copy As refuses a file that is there before the flow runs (the server's save replaces one).
    const copy = block.slice(block.indexOf("'shell.company.saveCopyAs':"), block.indexOf("'shell.portable.open':"));
    const guard = copy.indexOf('if (fs.existsSync(file)) throw new Error(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(copy.indexOf('await saveCopyAsFlow();'));
    // The answer names the file the restart really opens ("Save a Copy and Open It" opens a copy).
    expect(fnBody('async function agentShellRestartFlow(run, result = {}) {')).toContain('agentShellOpening()');
  });

  it('every question the shell knows is still asked in main.js with exactly those buttons', () => {
    // A reworded button would make its question unanswerable (it then fails closed): this says so.
    const literal = (buttons: string[]) => `[${buttons.map((b) => `'${b}'`).join(', ')}]`;
    for (const box of agentShell.QUESTIONS as { buttons: string[]; approval?: string }[]) {
      if (box.approval === 'installOllama') {
        // Built with this platform's own first button.
        expect(main).toContain("buttons: [isWin ? 'Download and install' : 'Open the download page', 'Cancel'],");
        expect(['Download and install', 'Open the download page']).toContain(box.buttons[0]);
        expect(box.buttons.slice(1)).toEqual(['Cancel']);
      } else {
        expect(main, box.buttons.join(' / ')).toContain(literal(box.buttons));
      }
    }
  });

  it('the notice is shown only for the local app’s own pages, and the preload exposes it', () => {
    const at = main.indexOf("ipcMain.handle('agent:notice'");
    expect(at).toBeGreaterThan(-1);
    expect(main.slice(at, at + 200)).toMatch(/if \(!fromLocalApp\(e\) \|\| agentServiceHidden\) return false;/);
    expect(preload).toMatch(/agentNotice: \(notice\) =>\s*ipcRenderer\.invoke\('agent:notice', \{/);
  });
});
