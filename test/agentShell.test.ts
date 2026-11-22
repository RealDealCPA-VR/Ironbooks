/**
 * Agent full access: the shell bridge (plan 5.5, 5.7, 5.8, 7.2; D9, D10).
 *
 *  - lib/agent/shellTicket.ts: the approval ticket's HMAC, its expiry, the operation, the input and
 *    everything else it covers (answers, folders, file, secret kinds), the sealed part and the
 *    signed answer; electron/agentShell.js does the same, byte for byte.
 *  - electron/agentShell.js: the replay memory, the folders agents may use ("..", another drive, a
 *    share, device paths, links, never the top of a drive, share or mounted volume, never a share
 *    of this very computer, held to lib/agent/files.ts by one table of cases), the host an agent
 *    may join (never this computer, nor a virtual machine or container it runs), the scripted
 *    dialogs (a question without an answer stops the flow cleanly, naming the question; "Save a
 *    Copy and Open It" is never pressed; nothing ever waits on
 *    screen), the endpoint itself over a real named pipe or Unix socket with fake flows (nothing
 *    else can listen on its name, nothing private goes on it in the open or into the log, a silent
 *    connection is let go quickly), printing from a hidden window, the desktop notice.
 *  - lib/agent/shell.ts: the server's side over that endpoint (an answer that does not check out is
 *    never "done", and there is no way to take one unchecked), files.save (an exclusive create; a
 *    disk error in plain words, no path), the print handler of the effects outbox. No secret the
 *    approver typed ever comes back in an answer.
 *  - electron/companySession.js: agents' staged files in a working copy are a cache entry, go a
 *    day after a crash left them, and are cleared when the company file opens and closes; those a
 *    company folder kept in the app data folder are cleared on quit and at start (marked ones only).
 *  - electron/agentService.js reads a dialog's options as Electron does.
 *  - lib/agent/operations/shell.ts is pure data and agrees with the shell's own table, and
 *    electron/main.js and preload.js are wired as described (read as text, like the other shell
 *    tests: main.js starts the app when it is loaded).
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '@/lib/services/_base';
import { SHELL_TICKET_SECONDS, type ShellOperationDef, type ShellTicket } from '@/lib/agent/contract';
import {
  makeShellTicket,
  openShellPrivate,
  sealShellPrivate,
  shellAnswerChecks,
  shellAnswerMac,
  shellBoundHash,
  shellFileRef,
  shellInputHash,
  shellTicketProblem,
  stableJson,
} from '@/lib/agent/shellTicket';
import { SHELL_OPERATIONS } from '@/lib/agent/operations/shell';
import {
  AGENT_OUTBOX_NAME,
  defaultAgentFolders,
  installShellPrinting,
  isDriveOrShareRoot,
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
import thisComputerShares from '@/lib/agent/thisComputerShares.json';

const mocks = vi.hoisted(() => ({
  folders: [] as string[],
  staged: new Map<string, { file: { fileId: string; name: string; type: string; size: number }; bytes: Uint8Array }>(),
  scope: undefined as unknown,
}));

// Other units' modules: replaced here, as the contract describes them.
vi.mock('@/lib/services/agentPolicies', () => ({
  loadAgentPolicy: vi.fn(async () => ({ folders: mocks.folders })),
}));
vi.mock('@/lib/agent/files', async (orig) => ({
  // The rule itself is the real one: lib/agent/shell.ts and the shell's port are held to it below.
  isThisComputerShare: (await orig<typeof import('@/lib/agent/files')>()).isThisComputerShare,
  // So is the one that leaves out an Admin's folder that has come to hold Ironbooks' own data.
  overlapsAppData: (await orig<typeof import('@/lib/agent/files')>()).overlapsAppData,
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
const agentService = require('../electron/agentService.js');
const companySession = require('../electron/companySession.js');
const companyFileFormat = require('../electron/companyFileFormat.js');
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

  it('covers everything the shell acts on: the answers, the folders, the file and which secrets come with it', () => {
    const now = Date.now();
    const pdf = { name: 'Checks.pdf', type: 'application/pdf', base64: PDF.toString('base64') };
    const bound = { answers: { openNow: true }, folders: ['C:\\Books'], file: shellFileRef(pdf), secrets: ['backup_password'] };
    const t = makeShellTicket(KEY, { requestId: 'req-9', operation: 'shell.portable.open', input, approverId: PERSON, now, bound });
    expect(shellTicketProblem(KEY, t, 'shell.portable.open', input, now, bound)).toBeNull();
    // As it travels (JSON) and as the shell checks it.
    const sent = JSON.parse(JSON.stringify({ t, bound }));
    expect(agentShell.ticketProblem(KEY, sent.t, 'shell.portable.open', input, now, sent.bound)).toBeNull();
    const other = { ...pdf, base64: Buffer.from('%PDF-1.7 other checks').toString('base64') };
    for (const changed of [
      { ...bound, answers: { openNow: false } },
      { ...bound, answers: {} },
      { ...bound, folders: ['C:\\Books', 'C:\\Windows'] },
      { ...bound, folders: [] },
      { ...bound, file: shellFileRef(other) },
      { ...bound, file: shellFileRef({ ...pdf, name: 'Other.pdf' }) },
      { ...bound, file: null },
      { ...bound, secrets: [] },
    ]) {
      expect(shellTicketProblem(KEY, t, 'shell.portable.open', input, now, changed), JSON.stringify(changed)).toMatch(/not made by this Ironbooks for exactly what came with it/);
      expect(agentShell.ticketProblem(KEY, t, 'shell.portable.open', input, now, changed)).toMatch(/not made by this Ironbooks for exactly what came with it/);
    }
    // Both ends hash it the same way, with the same defaults.
    expect(agentShell.boundHash(bound)).toBe(shellBoundHash(bound));
    expect(agentShell.boundHash({})).toBe(shellBoundHash(undefined));
    expect(agentShell.boundHash(null)).toBe(shellBoundHash({ answers: {}, folders: [], file: null, secrets: [] }));
    expect(agentShell.boundHash({ secrets: ['b', 'a'] })).toBe(shellBoundHash({ secrets: ['a', 'b'] }));
    expect(agentShell.fileRef(pdf)).toEqual(shellFileRef(pdf));
    expect(shellFileRef(pdf)).toEqual({ name: 'Checks.pdf', type: 'application/pdf', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(agentShell.fileRef(null)).toBeNull();
  });

  it('what must stay private travels sealed for one ticket, and the answer is signed for it', () => {
    const t = make();
    const priv = { secrets: { backup_password: SECRET }, file: { name: 'a.pdf', type: 'application/pdf', base64: PDF.toString('base64') } };
    const sealed = sealShellPrivate(KEY, t.mac, priv);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(JSON.stringify(sealed)).not.toContain(PDF.toString('base64'));
    // Sealed here, opened there, and back.
    expect(agentShell.openPrivate(KEY, t.mac, JSON.parse(JSON.stringify(sealed)))).toEqual(priv);
    expect(openShellPrivate(KEY, t.mac, agentShell.sealPrivate(KEY, t.mac, priv))).toEqual(priv);
    // Another key, another ticket, one changed byte, or no sealed part at all: nothing comes out.
    expect(agentShell.openPrivate(OTHER_KEY, t.mac, sealed)).toBeNull();
    expect(agentShell.openPrivate(KEY, make({ now: Date.now() + 5000 }).mac, sealed)).toBeNull();
    const bytes = Buffer.from(sealed.data, 'base64');
    bytes[0] ^= 1;
    expect(agentShell.openPrivate(KEY, t.mac, { ...sealed, data: bytes.toString('base64') })).toBeNull();
    expect(openShellPrivate(KEY, t.mac, { iv: 'x' })).toBeNull();
    expect(openShellPrivate(KEY, t.mac, null)).toBeNull();
    // The answer: only the shell, with this launch's key, can sign it for this ticket.
    const answer = { ok: true, result: { file: 'C:\\x.ironbooks', n: [1, { b: 2, a: undefined }] }, error: null, restarting: false };
    const back = JSON.parse(JSON.stringify(agentShell.signAnswer(KEY, t.mac, answer)));
    expect(shellAnswerChecks(KEY, t.mac, back, back.mac)).toBe(true);
    expect(agentShell.answerMac(KEY, t.mac, back)).toBe(shellAnswerMac(KEY, t.mac, back));
    expect(shellAnswerChecks(KEY, 'f'.repeat(64), back, back.mac)).toBe(false);
    expect(shellAnswerChecks(OTHER_KEY, t.mac, back, back.mac)).toBe(false);
    expect(shellAnswerChecks(KEY, t.mac, { ...back, ok: false }, back.mac)).toBe(false);
    expect(shellAnswerChecks(KEY, t.mac, { ...back, result: { file: 'C:\\y.ironbooks' } }, back.mac)).toBe(false);
    expect(shellAnswerChecks(KEY, t.mac, back, undefined)).toBe(false);
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

  it('a company file at the top of a drive or share adds no folder of its own: only Documents applies', () => {
    const docs = 'C:\\Users\\Dana\\Documents';
    const onlyDocuments = [`${docs}\\Ironbooks`, `${docs}\\Ironbooks\\${AGENT_OUTBOX_NAME}`];
    for (const [companyFile, what] of [
      ['E:\\Books.ironbooks', 'a USB stick'],
      ['Q:\\Acme.ironbooks', 'a mapped drive'],
      ['\\\\office\\books\\Acme.ironbooks', "a share's top folder"],
      ['C:\\Acme.ironbooks', 'the system drive'],
    ]) {
      expect(agentShell.defaultFolders({ companyFile, documents: docs, platform: 'win32' }), what).toEqual(onlyDocuments);
    }
    // One folder down is a folder of its own, on a mapped drive or a share alike.
    expect(agentShell.defaultFolders({ companyFile: 'Q:\\Clients\\Acme.ironbooks', documents: docs, platform: 'win32' })[0]).toBe('Q:\\Clients');
    expect(agentShell.defaultFolders({ companyFile: '\\\\office\\books\\Clients\\Acme.ironbooks', documents: docs, platform: 'win32' })[0]).toBe('\\\\office\\books\\Clients');
    expect(agentShell.defaultFolders({ companyFile: '/Acme.ironbooks', documents: '/home/dana/Documents', platform: 'linux' })).toEqual([
      '/home/dana/Documents/Ironbooks',
      `/home/dana/Documents/Ironbooks/${AGENT_OUTBOX_NAME}`,
    ]);
    // The finding's probe: the whole USB stick is no longer a place agents may write.
    const usb = agentShell.defaultFolders({ companyFile: 'E:\\Books.ironbooks', documents: docs, platform: 'win32' });
    expect(agentShell.pathProblem('E:\\Windows\\System32\\x.ironbooks', usb, win)).toMatch(/not in a folder agents may use/);
    expect(agentShell.pathProblem('E:\\Copy.ironbooks', usb, win)).toMatch(/not in a folder agents may use/);
    expect(agentShell.pathProblem(`${docs}\\Ironbooks\\Copy.ironbooks`, usb, win)).toBeNull();
  });

  it('the top of a drive or share is never a folder agents may use, even when the Admin names it or a folder links to it', () => {
    for (const [root, p] of [
      ['E:\\', 'E:\\Books\\x.ironbooks'],
      ['Q:', 'Q:\\x.ironbooks'],
      ['\\\\office\\books', '\\\\office\\books\\x.ironbooks'],
      ['\\\\office\\books\\', '\\\\office\\books\\Clients\\x.ironbooks'],
    ]) {
      expect(agentShell.pathProblem(p, [root], win), root).toMatch(/not in a folder agents may use/);
    }
    for (const root of ['E:\\', 'Q:\\', '\\\\office\\books', '\\\\office\\books\\']) expect(agentShell.driveOrShareRoot(root, 'win32'), root).toBe(true);
    for (const folder of ['\\\\office\\books\\Clients', 'E:\\Books', 'C:\\Users']) expect(agentShell.driveOrShareRoot(folder, 'win32'), folder).toBe(false);
    expect(agentShell.driveOrShareRoot('/', 'linux')).toBe(true);
    expect(agentShell.driveOrShareRoot('/home', 'linux')).toBe(false);
    // C:\Docs\Ironbooks is a link to the top of E: on this disk: refused like E:\ itself.
    const enoent = () => Object.assign(new Error('not there'), { code: 'ENOENT' });
    const linked = {
      lstat: (p: string) => {
        if (!['C:\\', 'C:\\Docs', 'C:\\Docs\\Ironbooks'].includes(p)) throw enoent();
      },
      realpath: (p: string) => (p === 'C:\\Docs\\Ironbooks' ? 'E:\\' : p),
    };
    expect(agentShell.pathProblem('C:\\Docs\\Ironbooks\\Books\\x.ironbooks', ['C:\\Docs\\Ironbooks'], { platform: 'win32', fs: linked })).toMatch(
      /is in a folder that is the top of a whole drive, share or disk .* so it was refused/,
    );
  });

  it('on macOS and Linux, a mounted volume’s top folder is a root too: never an agent folder', () => {
    const roots = [
      '/',
      '/Volumes',
      '/Volumes/USB',
      '/Volumes/Office Share/',
      '/volumes/usb', // macOS disks mostly ignore case
      '/System/Volumes/Data',
      '/media',
      '/media/pat',
      '/media/pat/USB',
      '/run/media',
      '/run/media/pat',
      '/run/media/pat/USB',
      '/mnt',
      '/mnt/c', // WSL: the whole C: drive
      '/mnt/backup/',
      '/Volumes/USB/..',
    ];
    const folders = ['/Volumes/USB/Books', '/media/pat/USB/Books', '/run/media/pat/USB/Books', '/mnt/c/Users', '/home/pat', '/Users/pat/Documents', '/run/user', '/home'];
    for (const platform of ['darwin', 'linux']) {
      for (const root of roots) {
        expect(agentShell.driveOrShareRoot(root, platform), `${platform} ${root}`).toBe(true);
        expect(isDriveOrShareRoot(root, platform as NodeJS.Platform), `server ${platform} ${root}`).toBe(true);
      }
      for (const folder of folders) {
        expect(agentShell.driveOrShareRoot(folder, platform), `${platform} ${folder}`).toBe(false);
        expect(isDriveOrShareRoot(folder, platform as NodeJS.Platform), `server ${platform} ${folder}`).toBe(false);
      }
    }
    // On Windows those words are no volume of their own (C:\Volumes is a folder).
    expect(agentShell.driveOrShareRoot('C:\\Volumes\\USB', 'win32')).toBe(false);
    expect(isDriveOrShareRoot('C:\\Volumes\\USB', 'win32')).toBe(false);
    // The finding's probe: a company file at the top of a USB stick or a mounted share leaves only Documents.
    const docs = '/Users/pat/Documents';
    const onlyDocuments = [`${docs}/Ironbooks`, `${docs}/Ironbooks/${AGENT_OUTBOX_NAME}`];
    for (const companyFile of ['/Volumes/USB/Acme.ironbooks', '/Volumes/Office/Acme.ironbooks', '/media/pat/USB/Acme.ironbooks', '/run/media/pat/USB/Acme.ironbooks', '/mnt/books/Acme.ironbooks']) {
      expect(agentShell.defaultFolders({ companyFile, documents: docs, platform: 'darwin' }), companyFile).toEqual(onlyDocuments);
    }
    const usb = agentShell.defaultFolders({ companyFile: '/Volumes/USB/Acme.ironbooks', documents: docs, platform: 'darwin' });
    expect(agentShell.pathProblem('/Volumes/USB/Other.ironbooks', usb, { platform: 'darwin', fs: null })).toMatch(/not in a folder agents may use/);
    // Named by the Admin, the top of a volume is not used either; a folder inside it is.
    expect(agentShell.pathProblem('/Volumes/USB/Books/x.ironbooks', ['/Volumes/USB'], { platform: 'darwin', fs: null })).toMatch(/not in a folder agents may use/);
    expect(agentShell.pathProblem('/Volumes/USB/Books/x.ironbooks', ['/Volumes/USB/Books'], { platform: 'darwin', fs: null })).toBeNull();
    expect(agentShell.defaultFolders({ companyFile: '/Volumes/USB/Books/Acme.ironbooks', documents: docs, platform: 'darwin' })[0]).toBe('/Volumes/USB/Books');
  });

  it('a disk mounted into a folder (another device than the folder it sits in) is the top of a volume', () => {
    const enoent = () => Object.assign(new Error('not there'), { code: 'ENOENT' });
    const there = ['C:\\', 'C:\\Docs', 'C:\\Docs\\Ironbooks', 'C:\\Docs\\Ironbooks\\Books'];
    const disk = (mounted: string | null) => ({
      lstat: (p: string) => {
        if (!there.includes(p)) throw enoent();
      },
      realpath: (p: string) => p,
      stat: (p: string) => {
        if (!there.includes(p)) throw enoent();
        // Everything from the mount point down is on the second disk.
        return { dev: mounted && (p === mounted || p.startsWith(`${mounted}\\`)) ? 2 : 1 };
      },
    });
    const opts = (mounted: string | null) => ({ platform: 'win32', fs: disk(mounted) });
    const file = 'C:\\Docs\\Ironbooks\\Books\\x.ironbooks';
    expect(agentShell.pathProblem(file, ['C:\\Docs\\Ironbooks'], opts(null))).toBeNull();
    // C:\Docs\Ironbooks is where a second disk is mounted: the whole disk, refused.
    expect(agentShell.pathProblem(file, ['C:\\Docs\\Ironbooks'], opts('C:\\Docs\\Ironbooks'))).toMatch(/top of a whole drive, share or disk/);
    // A folder below the mount point is a folder of its own.
    expect(agentShell.pathProblem(file, ['C:\\Docs\\Ironbooks\\Books'], opts('C:\\Docs\\Ironbooks'))).toBeNull();
    // An allowed folder that is not there yet is no mount point.
    expect(agentShell.pathProblem('C:\\Docs\\Ironbooks\\New\\x.ironbooks', ['C:\\Docs\\Ironbooks\\New'], opts(null))).toBeNull();
    // A folder the disk will say nothing about counts as one (fail closed).
    const silent = { ...disk(null), stat: (p: string) => {
      if (p === 'C:\\Docs\\Ironbooks') throw Object.assign(new Error('no'), { code: 'EACCES' });
      return { dev: 1 };
    } };
    expect(agentShell.pathProblem(file, ['C:\\Docs\\Ironbooks'], { platform: 'win32', fs: silent })).toMatch(/top of a whole drive, share or disk/);
  });

  it('the server’s own folders follow the same rule (files.save, the ask-time check)', () => {
    const keep = process.env.BKA_COMPANY_FILE;
    const top = path.parse(TMP).root;
    try {
      process.env.BKA_COMPANY_FILE = path.join(top, 'Books.ironbooks');
      expect(defaultAgentFolders()).not.toContain(top);
      expect(defaultAgentFolders()).toHaveLength(2);
      process.env.BKA_COMPANY_FILE = path.join(TMP, 'Books', 'Acme.ironbooks');
      expect(defaultAgentFolders()[0]).toBe(path.join(TMP, 'Books'));
    } finally {
      if (keep === undefined) delete process.env.BKA_COMPANY_FILE;
      else process.env.BKA_COMPANY_FILE = keep;
    }
    expect(isDriveOrShareRoot(top)).toBe(true);
    expect(isDriveOrShareRoot(TMP)).toBe(false);
  });
});

/** One case of lib/agent/thisComputerShares.json, with `templated` when it named this computer through a template. */
interface ShareCase {
  path: string;
  want: boolean;
  env?: Record<string, string>;
  since?: string;
  why?: string;
  templated?: boolean;
}

/**
 * What each template of lib/agent/thisComputerShares.json stands for on this computer, as the
 * table's own "templates" list explains it (null: it cannot be filled here, and its cases are left
 * out). A template the table lists and this has no way to fill makes the table tests fail
 * (unknownTemplates): the port is never held to less than the table says.
 */
function templateValues(): Record<string, string | null> {
  let ownIPv4: string | null = null;
  let ownIPv6: string | null = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      // Node names the family 'IPv4' or 'IPv6' (a number in some older versions).
      const family = String(a.family);
      if (!ownIPv4 && (family === 'IPv4' || family === '4') && !a.internal) ownIPv4 = a.address;
      if (!ownIPv6 && (family === 'IPv6' || family === '6') && !a.internal) ownIPv6 = a.address.replace(/%.*$/, '');
    }
  }
  const v4Number = ownIPv4 === null ? null : ownIPv4.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const host = os.hostname();
  return {
    '{hostname}': host,
    '{hostname:lower}': host.toLowerCase(),
    '{hostname:upper}': host.toUpperCase(),
    '{COMPUTERNAME}': process.env.COMPUTERNAME?.trim() || null,
    '{ownIPv4}': ownIPv4,
    '{ownIPv4:number}': v4Number === null ? null : String(v4Number),
    '{ownIPv4:hex}': v4Number === null ? null : `0x${v4Number.toString(16)}`,
    '{ownIPv6}': ownIPv6,
    '{ownIPv6:literal}': ownIPv6 === null ? null : `${ownIPv6.replace(/:/g, '-')}.ipv6-literal.net`,
  };
}

/** The templates the table lists (its "templates") that templateValues cannot fill: [] when it knows them all. */
function unknownTemplates(): string[] {
  const known = templateValues();
  return Object.keys(thisComputerShares.templates).filter((t) => !Object.prototype.hasOwnProperty.call(known, t));
}

/**
 * A share of this very computer, by the words alone: the shell's port (electron/agentShell.js
 * isThisComputerShare) is held to the server's rule (lib/agent/files.ts) through that rule's own
 * table, lib/agent/thisComputerShares.json, so the two cannot drift apart. Every template the table
 * lists is filled in for this computer (templateValues, as lib/agent/files.test.ts fills them); a
 * case whose template cannot be filled here is left out. A template this test does not know, or a
 * case naming one the table does not list, throws: the test fails rather than judge a template's
 * own words.
 */
function thisComputerCases(): ShareCase[] {
  const unknown = unknownTemplates();
  if (unknown.length) {
    throw new Error(`lib/agent/thisComputerShares.json lists templates this test cannot fill: ${unknown.join(', ')}. Fill them in templateValues.`);
  }
  const fill = templateValues();
  const listed = Object.keys(thisComputerShares.templates);
  const out: ShareCase[] = [];
  for (const c of thisComputerShares.cases as ShareCase[]) {
    let p: string | null = c.path;
    for (const t of listed) if (p?.includes(t)) p = fill[t] === null ? null : p.split(t).join(fill[t] as string);
    if (p === null) continue;
    const left = /\{[^}]+\}/.exec(p);
    if (left) throw new Error(`The case ${JSON.stringify(c.path)} names ${left[0]}, which lib/agent/thisComputerShares.json does not list under templates.`);
    out.push({ ...c, path: p, templated: p !== c.path });
  }
  return out;
}

/** Run `fn` with `values` in process.env (as lib/agent/files.ts reads it), then put them back. */
function withEnv(values: Record<string, string> | undefined, fn: () => void): void {
  const before = Object.fromEntries(Object.keys(values ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values ?? {});
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('a share of this very computer (\\\\localhost, a loopback address, its own name) is never an agent folder', () => {
  const WIN32 = process.platform === 'win32';
  /** This computer as the tests describe it: FRONT-DESK, one office address, its loopback. */
  const front = {
    platform: 'win32',
    fs: null,
    env: { COMPUTERNAME: 'FRONT-DESK' },
    hostname: () => 'front-desk.office.example',
    interfaces: () => ({ Ethernet: [{ address: '192.168.1.202' }], Loopback: [{ address: '127.0.0.1' }] }),
  };

  it('this test fills every template the table lists, and fails on one it does not know', () => {
    expect(unknownTemplates()).toEqual([]);
    // Every case's templates are ones the table lists, and none is left unfilled.
    for (const c of thisComputerCases()) expect(c.path, c.path).not.toMatch(/\{[^}]+\}/);
    // The cases that name this computer through a template are there (its name at least).
    expect(thisComputerCases().some((c) => c.templated && c.path.includes(os.hostname()))).toBe(true);
    // A template the table would list and this test cannot fill is caught.
    const templates = thisComputerShares.templates as Record<string, string>;
    templates['{ownMAC}'] = 'a template no test knows';
    try {
      expect(unknownTemplates()).toEqual(['{ownMAC}']);
      expect(() => thisComputerCases()).toThrow(/lists templates this test cannot fill: \{ownMAC\}/);
    } finally {
      delete templates['{ownMAC}'];
    }
    // So is a case that names a template the table does not list.
    const cases = thisComputerShares.cases as ShareCase[];
    cases.push({ path: '\\\\{nowhere}\\c$', want: true });
    try {
      expect(() => thisComputerCases()).toThrow(/names \{nowhere\}, which lib\/agent\/thisComputerShares\.json does not list/);
    } finally {
      cases.pop();
    }
  });

  it('the shell’s rule says what the server’s says, case by case, by the words alone', async () => {
    const files = await vi.importActual<typeof import('@/lib/agent/files')>('@/lib/agent/files');
    expect(unknownTemplates()).toEqual([]);
    const cases = thisComputerCases();
    expect(cases.length).toBeGreaterThan(50);
    for (const c of cases) {
      const say = JSON.stringify(c.path);
      // Judged as Windows judges them, on any system the test runs on: the table's answer. A case
      // that names this computer through a template is this computer's name only here.
      if (!c.templated) expect(agentShell.isThisComputerShare(c.path, { platform: 'win32', env: c.env ?? {} }), say).toBe(c.want);
      // On other systems a path written that way is no share at all.
      expect(agentShell.isThisComputerShare(c.path, { platform: 'linux', env: c.env }), say).toBe(false);
      // Here, held to lib/agent/files.ts and to the table: the same answer for every case.
      withEnv(c.env, () => {
        expect(agentShell.isThisComputerShare(c.path), say).toBe(files.isThisComputerShare(c.path));
        expect(agentShell.isThisComputerShare(c.path), say).toBe(WIN32 ? c.want : false);
      });
    }
    expect(agentShell.isThisComputerShare(5)).toBe(false);
    // This computer's own name and addresses, as it gives them.
    for (const p of ['\\\\FRONT-DESK\\Books', '\\\\front-desk.office.example\\Books', '\\\\192.168.1.202\\c$', '\\\\0xc0a801ca\\c$']) {
      expect(agentShell.isThisComputerShare(p, front), p).toBe(true);
    }
    expect(agentShell.isThisComputerShare('\\\\FRONT-DESK-2\\Books', front)).toBe(false);
    expect(agentShell.isThisComputerShare('\\\\192.168.1.203\\Books', front)).toBe(false);
  });

  it('a path through one is refused, as typed, and allowed folders through one allow nothing', () => {
    const refused = /reaches this computer through one of its own network shares, so it was refused/;
    // Typed so, even inside a folder the Admin named the same way.
    expect(agentShell.pathProblem('\\\\localhost\\c$\\Users\\Dana\\Documents\\Ironbooks\\x.ironbooks', ['\\\\localhost\\c$\\Users\\Dana\\Documents\\Ironbooks'], front)).toMatch(refused);
    // Ironbooks' own folders under another name: refused, whatever folders are allowed.
    expect(agentShell.pathProblem('\\\\127.1\\c$\\Users\\Dana\\AppData\\Local\\Ironbooks\\x.ironbooks', ['C:\\Users\\Dana'], front)).toMatch(refused);
    expect(agentShell.pathProblem('\\\\FRONT-DESK\\Books\\x.ironbooks', ['\\\\FRONT-DESK\\Books'], front)).toMatch(refused);
    // A space or a dot beside the server's name leaves the same server.
    for (const server of ['localhost ', ' localhost', 'localhost. ']) {
      const base = `\\\\${server}\\c$\\Users\\Dana\\Documents\\Ironbooks`;
      expect(agentShell.pathProblem(`${base}\\x.ironbooks`, [base], front), server).toMatch(refused);
    }
    // An allowed entry that is such a share allows nothing, not even a path that is no share.
    expect(agentShell.pathProblem('C:\\Users\\Dana\\x.ironbooks', ['\\\\localhost\\c$\\Users\\Dana'], front)).toMatch(/not in a folder agents may use/);
    // Another computer's share is as before.
    expect(agentShell.pathProblem('\\\\office\\books\\Clients\\x.ironbooks', ['\\\\office\\books\\Clients'], front)).toBeNull();
    // insideFolder itself never says yes through one.
    expect(agentShell.insideFolder('\\\\127.0.0.1\\c$\\Books\\x.ironbooks', '\\\\127.0.0.1\\c$\\Books', 'win32')).toBe(false);
    expect(agentShell.insideFolder('\\\\office\\books\\Clients\\x.ironbooks', '\\\\office\\books\\Clients', 'win32')).toBe(true);
    // The message says what to do instead, in plain words.
    expect(agentShell.pathProblem('\\\\localhost\\c$\\x.ironbooks', ['C:\\'], front)).toMatch(/Give the file's own path on this computer instead/);
  });

  it('as the disk has it: a folder that leads to one (a link, a mapped drive) is refused too', () => {
    const enoent = () => Object.assign(new Error('not there'), { code: 'ENOENT' });
    const linked = {
      lstat: (p: string) => {
        if (!['C:\\', 'C:\\Docs', 'C:\\Docs\\Ironbooks'].includes(p)) throw enoent();
      },
      realpath: (p: string) => (p === 'C:\\Docs\\Ironbooks' ? '\\\\localhost\\c$\\Users\\Dana\\AppData\\Local\\Ironbooks' : p),
    };
    expect(agentShell.pathProblem('C:\\Docs\\Ironbooks\\x.ironbooks', ['C:\\Docs\\Ironbooks'], { ...front, fs: linked })).toMatch(/reaches this computer through one of its own network shares/);
  });

  it.runIf(WIN32)('the server’s own folders: a company file opened through one adds no folder of its own', () => {
    const keep = process.env.BKA_COMPANY_FILE;
    try {
      process.env.BKA_COMPANY_FILE = '\\\\localhost\\c$\\Books\\Acme.ironbooks';
      expect(defaultAgentFolders()).toHaveLength(2);
      expect(defaultAgentFolders().some((f) => f.startsWith('\\\\'))).toBe(false);
      process.env.BKA_COMPANY_FILE = '\\\\office\\books\\Clients\\Acme.ironbooks';
      expect(defaultAgentFolders()[0]).toBe('\\\\office\\books\\Clients');
    } finally {
      if (keep === undefined) delete process.env.BKA_COMPANY_FILE;
      else process.env.BKA_COMPANY_FILE = keep;
    }
  });
});

// ---------------------------------------------------------------------------
// The host an agent asks to join
// ---------------------------------------------------------------------------

/** This computer as the join check sees it: its adapters, its name, and what names lead to. */
const NETWORK = {
  interfaces: () => ({
    Ethernet: [
      { address: '192.168.1.202', family: 'IPv4', internal: false },
      { address: 'fe80::1df0:60eb:dfcd:1bc6%12', family: 'IPv6', internal: false },
    ],
    Tailscale: [
      { address: '100.114.92.33', family: 'IPv4', internal: false },
      { address: 'fd7a:115c:a1e0::9c35:5c21', family: 'IPv6', internal: false },
    ],
    Loopback: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    // The virtual machines and containers this computer runs, as os.networkInterfaces() shows them.
    'vEthernet (WSL (Hyper-V firewall))': [
      { address: '172.29.144.1', netmask: '255.255.240.0', family: 'IPv4', mac: '00:15:5d:8a:01:02', internal: false, cidr: '172.29.144.1/20' },
      { address: 'fe80::9a3c:1b2d:4e5f:6a7b%41', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:15:5d:8a:01:02', internal: false, cidr: 'fe80::9a3c:1b2d:4e5f:6a7b/64' },
    ],
    docker0: [
      { address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:6b:11:22:33', internal: false, cidr: '172.17.0.1/16' },
      { address: 'fd42:4242:4242:1::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '02:42:6b:11:22:33', internal: false, cidr: 'fd42:4242:4242:1::1/64' },
    ],
    // A Hyper-V switch someone named: known by its hardware address.
    'Ethernet 3': [{ address: '10.99.0.1', netmask: '255.255.255.0', family: 'IPv4', mac: '00-15-5D-01-02-03', internal: false, cidr: '10.99.0.1/24' }],
    // No mask the shell can read: a /24 is assumed.
    vboxnet0: [{ address: '192.168.56.1', family: 'IPv4', mac: '0a:00:27:00:00:00', internal: false }],
    // A mask wider than any virtual network uses: taken as a /16, never a whole private range.
    'vEthernet (Odd Switch)': [{ address: '10.200.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:15:5d:aa:bb:cc', internal: false, cidr: '10.200.0.1/8' }],
  }),
  hostname: () => 'FRONT-DESK',
  lookup: async (name: string) => {
    const known: Record<string, string[]> = {
      'office.tail1234.ts.net': ['100.101.102.103'],
      'me.tail1234.ts.net': ['100.114.92.33'],
      'loop.tail1234.ts.net': ['127.0.0.1'],
      'both.tail1234.ts.net': ['100.101.102.103', 'fd7a:115c:a1e0::9c35:5c21'],
      'wsl-box.tail1234.ts.net': ['172.29.150.7'],
    };
    const found = known[name];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
};

describe('the host an agent asks to join (shell.hosting.connect)', () => {
  const join = (host: string) => agentShell.joinProblem(host, NETWORK);

  it('is never this computer itself: localhost, any loopback, its own addresses and name, a name that leads here', async () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'localhost.',
      'http://localhost:47800',
      '127.0.0.1',
      '127.1',
      '127.255.0.9:47800',
      '0x7f000001',
      '[::1]',
      'http://[::1]:47800/',
      '192.168.1.202',
      'https://192.168.1.202:47800',
      '100.114.92.33',
      '[fd7a:115c:a1e0::9c35:5c21]:47800',
      'front-desk.tail1234.ts.net',
      'me.tail1234.ts.net',
      'loop.tail1234.ts.net',
      'both.tail1234.ts.net',
    ]) {
      expect(await join(host), host).toMatch(/is this computer itself, so Ironbooks did not join it/);
    }
    // An IPv4 address written the IPv6 way is refused too (the window takes no such address).
    expect(await join('[::ffff:127.0.0.1]')).toBeTruthy();
  });

  it('another computer on this office network or tailnet is fine', async () => {
    for (const host of ['192.168.1.20', '10.0.0.5:47800', '100.101.102.103', 'office.tail1234.ts.net', 'https://office.tail1234.ts.net:47800']) {
      expect(await join(host), host).toBeNull();
    }
  });

  it('is never a virtual machine or container this computer runs (WSL, Hyper-V, Docker, VirtualBox): one hop removed is still here', async () => {
    for (const host of [
      // WSL behind its NAT switch: the guest has an address of its own on the switch's /20.
      '172.29.150.7',
      'http://172.29.144.5:47800',
      '172.29.159.254',
      // Docker's bridge, IPv4 and IPv6.
      '172.17.0.2',
      '[fd42:4242:4242:1::5]:47800',
      // A switch known only by its hardware address; one with no mask; one with an odd wide mask.
      '10.99.0.7',
      '192.168.56.101',
      '10.200.3.4',
      // A name that leads to one now.
      'wsl-box.tail1234.ts.net',
    ]) {
      const why = await join(host);
      expect(why, host).toMatch(/is a virtual machine or container running on this computer \(such as WSL, Hyper-V, Docker or VirtualBox\), so Ironbooks did not join it/);
      expect(why, host).toMatch(/a person can join it from File > Open company on host/);
    }
    // Next door is not: another subnet, another /64, and nothing wider than a /16 is ever assumed.
    for (const host of ['172.29.160.1', '172.30.0.9', '172.18.0.2', '[fd42:4242:4242:2::5]', '10.99.1.7', '192.168.57.1', '10.201.0.1', '10.0.0.5']) {
      expect(await join(host), host).toBeNull();
    }
    // A link-local address of a virtual switch decides nothing (the window never joins one anyway).
    expect(await join('[fe80::1]')).not.toMatch(/virtual machine/);
    // Without virtual adapters the same addresses are just this office network, a Wi-Fi adapter's
    // random hardware address included (it may start like Docker's).
    const plain = {
      ...NETWORK,
      interfaces: () => ({
        Ethernet: [{ address: '192.168.1.202', netmask: '255.255.255.0', family: 'IPv4', mac: '3c:52:82:01:02:03', internal: false }],
        'Wi-Fi': [{ address: '172.17.5.9', netmask: '255.255.0.0', family: 'IPv4', mac: '02:42:9e:01:02:03', internal: false }],
      }),
    };
    for (const host of ['172.29.150.7', '172.17.0.2', '10.99.0.7']) expect(await agentShell.joinProblem(host, plain), host).toBeNull();
    // An interface table that cannot be read refuses nothing more and breaks nothing.
    const broken = { ...NETWORK, interfaces: () => { throw new Error('no table'); } };
    expect(await agentShell.joinProblem('172.29.150.7', broken)).toBeNull();
    expect(await agentShell.joinProblem('localhost', broken)).toMatch(/is this computer itself/);
  });

  it('a Hyper-V switch shared with the office network is not let off by its name: agents cannot join a host on it (fail closed)', async () => {
    // An "external" switch: Windows moves the office network card's address onto the switch's own
    // adapter. A virtual machine's network can be named anything, so no name lets one off.
    for (const name of ['vEthernet (External Switch)', 'vEthernet (Office LAN)', 'Office network']) {
      const shared = {
        ...NETWORK,
        interfaces: () => ({
          [name]: [{ address: '192.168.1.202', netmask: '255.255.255.0', family: 'IPv4', mac: '00:15:5d:01:0a:0b', internal: false, cidr: '192.168.1.202/24' }],
          Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        }),
      };
      const why = await agentShell.joinProblem('192.168.1.20', shared);
      expect(why, name).toMatch(/is a virtual machine or container running on this computer/);
      // What a person does instead is said.
      expect(why, name).toMatch(/a person can join it from File > Open company on host/);
      // Another office network next to it is not this computer's.
      expect(await agentShell.joinProblem('192.168.2.20', shared), name).toBeNull();
    }
  });

  it('refuses what the window refuses anyway, and a name it cannot look up', async () => {
    expect(await join('evil.example')).toMatch(/only connects to hosts on your own network or tailnet/);
    expect(await join('')).toMatch(/Enter the host computer/);
    expect(await join('ghost.tail1234.ts.net')).toMatch(/could not look up "ghost\.tail1234\.ts\.net"/);
    expect(await agentShell.joinProblem('office.tail1234.ts.net', { ...NETWORK, lookup: async () => [] })).toMatch(/could not look up/);
  });

  it('the approval card says what joining really does', () => {
    const why = def('shell.hosting.connect').why;
    expect(why).toMatch(/shows the pages the program at that address serves instead of its own/);
    expect(why).toMatch(/people sign in there with their user names and passwords/);
    expect(why).toMatch(/refuses this computer's own addresses and names/);
    expect(why).toMatch(/and the virtual machines or containers it runs \(such as WSL or Docker\)/);
    expect(why).not.toMatch(/becomes a client of another computer's company file/);
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
    const s = script('shell.company.open', { answers: { cloudFolder: true, temporaryFolder: 'open it here anyway' } });
    expect(s.messageBox([{ message: 'In OneDrive', buttons: ['Open It', 'Cancel'], cancelId: 1 }]).response).toBe(0);
    expect(s.messageBox([{ message: 'Temporary', buttons: ['Save a Copy and Open It', 'Open It Here Anyway', 'Cancel'], cancelId: 2 }]).response).toBe(1);
    expect(s.problems).toEqual([]);
    const odd = script('shell.company.open', { answers: { temporaryFolder: 'Maybe' } });
    expect(odd.messageBox([{ message: 'Temporary', buttons: ['Save a Copy and Open It', 'Open It Here Anyway', 'Cancel'], cancelId: 2 }]).response).toBe(2);
    expect(odd.problems[0]).toMatch(/not one of its choices \(Open It Here Anyway, Cancel\)/);
    const no = script('shell.company.close', { answers: { closeWhileHosting: false } });
    expect(no.messageBox([{ message: 'Close it?', buttons: ['Close Company', 'Cancel'], cancelId: 1 }]).response).toBe(1);
    expect(no.stoppedBy).toMatch(/the answer to "Close it\?" was "Cancel"/);
  });

  it('"Save a Copy and Open It" is never pressed for an agent: the open company file never switches by itself', () => {
    const temporary = { message: 'Acme.ironbooks is in a temporary folder', buttons: ['Save a Copy and Open It', 'Open It Here Anyway', 'Cancel'], defaultId: 0, cancelId: 2 };
    const readOnly = { message: 'Acme.ironbooks is read-only', buttons: ['Save a Copy and Open It', 'Cancel'], defaultId: 0, cancelId: 1 };
    for (const op of ['shell.company.new', 'shell.company.open', 'shell.backup.restoreAsNew']) {
      // Even when the answer names it (an older card, or answers sent by hand): its cancel button, and not done.
      const asked = script(op, { answers: { temporaryFolder: 'save a copy and open it' } });
      expect(asked.messageBox([WIN, temporary]).response, op).toBe(2);
      expect(asked.problems[0], op).toMatch(/was "Save a Copy and Open It", which an agent's request never chooses/);
      expect(asked.problems[0], op).toMatch(/choose "Open It Here Anyway" or "Cancel" on the approval card/);
      expect(agentShell.answerOf(asked, { done: true, restarting: true }, null).ok, op).toBe(false);
      // A read-only company file: nothing to choose but the copy, so the request stops, saying why.
      const ro = script(op, { answers: { readOnlyFile: 'Save a Copy and Open It' } });
      expect(ro.messageBox([WIN, readOnly]).response, op).toBe(1);
      expect(ro.problems[0], op).toMatch(/^Acme\.ironbooks is read-only\. Ironbooks cannot work in a read-only company file/);
      expect(ro.problems[0], op).toMatch(/A person can open it from File > Open or Restore Company/);
      expect(ro.asked, op).toEqual([]);
    }
    // The card never offers it.
    for (const d of SHELL_OPERATIONS) {
      for (const q of d.questions) expect(q.choices ?? [], `${d.id} ${q.id}`).not.toContain('Save a Copy and Open It');
      expect(d.questions.map((q) => q.id), d.id).not.toContain('readOnlyFile');
    }
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
  const personHost = vi.fn(() => new Promise(() => {}));
  const hostPrompt = agentShell.scriptedPrompt('host', personHost);
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
    'shell.hosting.connect': async () => {
      ran.push('connect');
      // As openOnHostFlow: the prompt takes the address, the window then restarts as its client.
      const submitted: string[] = [];
      await hostPrompt(WIN, { onSubmit: async (value: string) => (submitted.push(value), { ok: true }) });
      return { done: submitted.length === 1, restarting: true, result: { host: submitted[0] } };
    },
  };

  let endpoint: { env: { endpoint: string; key: string }; ready: Promise<unknown>; close: () => Promise<void> };
  const saved = { endpoint: process.env[SHELL_ENDPOINT_ENV], key: process.env[SHELL_KEY_ENV], docs: process.env[SHELL_DOCUMENTS_ENV] };

  /** What the endpoint writes to the app's log (main.js prints it with "[agent-shell]"). */
  const logged: string[] = [];

  beforeAll(async () => {
    endpoint = agentShell.openEndpoint({ flows, folders: () => [ALLOWED], key: KEY, network: NETWORK, log: (m: string) => logged.push(String(m)) });
    await endpoint.ready;
    process.env[SHELL_ENDPOINT_ENV] = endpoint.env.endpoint;
    process.env[SHELL_KEY_ENV] = endpoint.env.key;
    // As main.js tells the company server: the shell's Documents, so the server's own check of a
    // flow's paths (runShellOperation) and the shell's (its folders: Documents\Ironbooks) agree.
    process.env[SHELL_DOCUMENTS_ENV] = path.dirname(ALLOWED);
  });
  afterAll(async () => {
    setPrintHandler(null);
    await endpoint.close();
    for (const [k, v] of [[SHELL_ENDPOINT_ENV, saved.endpoint], [SHELL_KEY_ENV, saved.key], [SHELL_DOCUMENTS_ENV, saved.docs]] as const) {
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

  /** A line as the server sends it, with a ticket made as given (no secrets, no file: nothing sealed). */
  const line = (operation: string, input: unknown, t: Partial<{ key: string; now: number; requestId: string; ticketInput: unknown }> = {}) =>
    JSON.stringify({
      ticket: makeShellTicket(t.key ?? KEY, { requestId: t.requestId ?? `req-${Math.random()}`, operation, input: t.ticketInput ?? input, approverId: PERSON, now: t.now }),
      operation,
      input,
      answers: {},
      folders: [],
    });
  /**
   * A line sent as the server sends it: the answer is taken only when it is signed with this
   * launch's key for the ticket on the line ('' for a line with no readable ticket, as the shell
   * signs it). sendShellLine has no unchecked way.
   */
  const sendLine = (text: string, ms?: number) => {
    let mac = '';
    try {
      const m = (JSON.parse(text) as { ticket?: { mac?: unknown } })?.ticket?.mac;
      mac = typeof m === 'string' && /^[0-9a-f]{64}$/.test(m) ? m : '';
    } catch {
      mac = '';
    }
    return sendShellLine(text, ms, { key: KEY, ticketMac: mac });
  };

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

  it('a folder the Admin added that has since come to hold Ironbooks’ own data is not sent to the shell, and allows nothing', async () => {
    // Since the Admin added it, Ironbooks keeps its backups in a folder inside it.
    const kept = path.join(OUTSIDE, 'kept-backups');
    fs.mkdirSync(kept, { recursive: true });
    const before = process.env.BKA_BACKUP_DIR;
    process.env.BKA_BACKUP_DIR = kept;
    mocks.folders = [OUTSIDE];
    try {
      const r = await run('shell.company.saveCopyAs', { file: path.join(OUTSIDE, 'Later.ironbooks') });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not in a folder agents may use/);
      expect(fs.existsSync(path.join(OUTSIDE, 'Later.ironbooks'))).toBe(false);
      expect(ran).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.BKA_BACKUP_DIR;
      else process.env.BKA_BACKUP_DIR = before;
      fs.rmSync(kept, { recursive: true, force: true });
    }
    // Once it holds none, it is the agent's folder again.
    expect((await run('shell.company.saveCopyAs', { file: path.join(OUTSIDE, 'Later.ironbooks') })).ok).toBe(true);
  });

  it('each path is judged again when the approved work runs: one that has come to lie inside Ironbooks’ own data is refused before the shell is asked', async () => {
    // The company file now sits in Documents\Ironbooks (one of the default folders), with its
    // archives beside it. The shell's own check knows nothing of Ironbooks' data and would take a
    // path in the archives; the server judges each path field as files.save judges its folder.
    const archives = path.join(ALLOWED, 'archives');
    fs.mkdirSync(archives, { recursive: true });
    const keep = process.env.BKA_COMPANY_FILE;
    process.env.BKA_COMPANY_FILE = path.join(ALLOWED, 'Acme.ironbooks');
    const files = await import('@/lib/agent/files');
    const real = await vi.importActual<typeof import('@/lib/agent/files')>('@/lib/agent/files');
    const allowed = vi.mocked(files.allowedFolder);
    const stand = allowed.getMockImplementation();
    // The real folder rule for this test (the stand-in above knows nothing of Ironbooks' data).
    allowed.mockImplementation(real.allowedFolder);
    try {
      const r = await run('shell.company.saveCopyAs', { file: path.join(archives, 'Old.ironbooks') });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Old\.ironbooks" is not in a folder agents may use on this computer now, or its folder is no longer there, so nothing was done/);
      expect(fs.existsSync(path.join(archives, 'Old.ironbooks'))).toBe(false);
      // Every path the operation takes: the target of an open as well as the file it opens.
      const target = await run('shell.portable.open', { file: path.join(ALLOWED, 'Acme.bkp'), target: path.join(archives, 'New.ironbooks') }, {}, { backup_password: SECRET });
      expect(target.error).toMatch(/New\.ironbooks" is not in a folder agents may use on this computer now/);
      // A folder that is gone by then, and what is no full path, the same.
      expect((await run('shell.company.saveCopyAs', { file: path.join(ALLOWED, 'Gone', 'Copy.ironbooks') })).error).toMatch(/or its folder is no longer there/);
      expect((await run('shell.company.saveCopyAs', { file: 'Copy.ironbooks' })).error).toMatch(/^"file" must be the full path of a file in a folder agents may use/);
      expect(JSON.stringify(target)).not.toContain(SECRET);
      expect(ran).toEqual([]);
      // In the folder itself, beside the company file: the run goes through, and the shell checks it again.
      expect((await run('shell.company.saveCopyAs', { file: path.join(ALLOWED, 'Beside.ironbooks') })).ok).toBe(true);
      expect(ran).toEqual(['saveCopyAs']);
    } finally {
      if (stand) allowed.mockImplementation(stand);
      if (keep === undefined) delete process.env.BKA_COMPANY_FILE;
      else process.env.BKA_COMPANY_FILE = keep;
      fs.rmSync(archives, { recursive: true, force: true });
    }
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
    const noTicket = await sendLine(JSON.stringify({ operation: 'shell.company.saveCopyAs', input }));
    expect(noTicket.error).toMatch(/could not be read/);
    expect((await sendLine(line('shell.company.saveCopyAs', input, { key: OTHER_KEY }))).error).toMatch(/not made by this Ironbooks/);
    expect((await sendLine(line('shell.company.saveCopyAs', input, { now: Date.now() - 10 * 60_000 }))).error).toMatch(/ran out/);
    expect((await sendLine(line('shell.company.saveCopyAs', input, { ticketInput: { file: path.join(ALLOWED, 'Other.ironbooks') } }))).error).toMatch(/changed after/);
    expect((await sendLine('not json')).error).toMatch(/could not be read/);
    expect((await sendLine(line('shell.nothing.here', {}))).error).toMatch(/cannot carry out/);
    expect((await sendLine(line('shell.company.saveCopyAs', { ...input, extra: 1 }))).error).toMatch(/"extra" is not something this request takes/);
    expect(ran).toEqual([]);
    const once = line('shell.company.saveCopyAs', input);
    expect((await sendLine(once)).ok).toBe(true);
    expect((await sendLine(once)).error).toMatch(/already used/);
    expect(ran).toEqual(['saveCopyAs']);
  });

  it('an answer is taken only with its check: the shell’s own answer checked against another ticket is not “done”', async () => {
    const once = line('shell.hosting.stop', {});
    const otherMac = (JSON.parse(line('shell.hosting.stop', {})) as { ticket: { mac: string } }).ticket.mac;
    const r = await sendShellLine(once, undefined, { key: KEY, ticketMac: otherMac });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be checked, so Ironbooks does not take it as done/);
    // A caller from plain JavaScript that leaves the check out gets the same: never an unsigned "done".
    const unchecked = await (sendShellLine as unknown as (l: string) => Promise<{ ok: boolean; error: string | null }>)(line('shell.hosting.stop', {}));
    expect(unchecked.ok).toBe(false);
    expect(unchecked.error).toMatch(/could not be checked/);
    expect(ran).toEqual(['stop', 'stop']);
  });

  it('one request at a time; a slow answer is reported as such', async () => {
    const [a, b] = await Promise.all([run('shell.hosting.stop', {}), new Promise((r) => setTimeout(r, 50)).then(() => run('shell.hosting.stop', {}))]);
    expect(a.ok).toBe(true);
    expect(b.error).toMatch(/another approved request/);
    const slow = await sendLine(line('shell.hosting.stop', {}), 50);
    expect(slow.error).toMatch(/did not finish this in time/);
    await new Promise((r) => setTimeout(r, 400));
  });

  it('the ticket covers the answers and folders as sent; passwords and files only ever travel sealed', async () => {
    const input = { file: path.join(ALLOWED, 'T2.ironbooks') };
    const t = makeShellTicket(KEY, { requestId: 'req-bound', operation: 'shell.company.saveCopyAs', input, approverId: PERSON });
    const send = (over: Record<string, unknown>) =>
      sendLine(JSON.stringify({ ticket: t, operation: 'shell.company.saveCopyAs', input, answers: {}, folders: [], ...over }));
    // A folder or an answer added on the way: the MAC no longer checks out.
    expect((await send({ folders: [OUTSIDE] })).error).toMatch(/not made by this Ironbooks for exactly what came with it/);
    expect((await send({ answers: { openNow: true } })).error).toMatch(/not made by this Ironbooks for exactly what came with it/);
    // A password or a file in the open: never from this Ironbooks's server.
    expect((await send({ secrets: { backup_password: SECRET } })).error).toMatch(/could not be read/);
    expect((await send({ file: { name: 'a.pdf', type: 'application/pdf', base64: PDF.toString('base64') } })).error).toMatch(/could not be read/);
    // A sealed part made with another key, or one the ticket does not cover (a password slipped in).
    expect((await send({ sealed: sealShellPrivate(OTHER_KEY, t.mac, { secrets: { backup_password: SECRET } }) })).error).toMatch(/not made by this Ironbooks/);
    expect((await send({ sealed: sealShellPrivate(KEY, t.mac, { secrets: { backup_password: SECRET } }) })).error).toMatch(/not made by this Ironbooks/);
    expect(ran).toEqual([]);
    // None of those used the approval up; the line as approved still runs, once.
    expect((await send({})).ok).toBe(true);
    expect((await send({})).error).toMatch(/already used/);
    expect(ran).toEqual(['saveCopyAs']);
  });

  it('nothing private goes on the line in the open, and an answer that is not the shell’s is never “done”', async () => {
    // Something else listening where the server was told to go: it keeps what it is sent and says "done".
    const seen: string[] = [];
    const impostorPath = process.platform === 'win32' ? `\\\\.\\pipe\\ironbooks-agent-shell-impostor-${process.pid}` : path.join(TMP, 'impostor.sock');
    const impostor = net.createServer((s) => {
      let text = '';
      s.on('data', (c) => {
        text += c.toString('utf8');
        if (!text.includes('\n')) return;
        seen.push(text);
        s.end(`${JSON.stringify({ ok: true, result: { trust: 'me' }, error: null, restarting: false, mac: 'a'.repeat(64) })}\n`);
      });
    });
    await new Promise<void>((resolve) => impostor.listen(impostorPath, () => resolve()));
    const keep = process.env[SHELL_ENDPOINT_ENV];
    process.env[SHELL_ENDPOINT_ENV] = impostorPath;
    try {
      const restored = await run('shell.portable.open', { file: path.join(ALLOWED, 'Acme.bkp'), target: path.join(ALLOWED, 'Restored2.ironbooks') }, {}, { backup_password: SECRET });
      expect(restored.ok).toBe(false);
      expect(restored.error).toMatch(/could not be checked, so Ironbooks does not take it as done/);
      const fileId = '9'.repeat(32);
      mocks.staged.set(`${COMPANY}/${AGENT}/${fileId}`, { file: { fileId, name: 'Checks.pdf', type: 'application/pdf', size: PDF.length }, bytes: PDF });
      expect((await run('shell.print.file', { fileId })).ok).toBe(false);
      expect(seen).toHaveLength(2);
      const all = seen.join('');
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain(PDF.toString('base64'));
      expect(JSON.parse(seen[0]).sealed).toMatchObject({ iv: expect.any(String), data: expect.any(String), tag: expect.any(String) });
      expect(JSON.parse(seen[0])).not.toHaveProperty('secrets');
      expect(JSON.parse(seen[1])).not.toHaveProperty('file');
    } finally {
      process.env[SHELL_ENDPOINT_ENV] = keep;
      await new Promise((resolve) => impostor.close(() => resolve(null)));
    }
    expect(ran).toEqual([]);
  });

  it('nothing else can listen on the endpoint’s name while it is open (a second instance is refused)', async () => {
    const second = net.createServer();
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      second.once('error', (e) => resolve(e as NodeJS.ErrnoException));
      second.listen(endpoint.env.endpoint, () => resolve(null));
    });
    if (!err) await new Promise((resolve) => second.close(() => resolve(null)));
    expect(err?.code).toBe('EADDRINUSE');
    // And the endpoint still answers.
    expect((await run('shell.hosting.stop', {})).ok).toBe(true);
  });

  it('a connection that says nothing is let go quickly, so silent ones cannot hold the endpoint for long', async () => {
    // The real window: two seconds, well inside the ten a whole line may take.
    expect(agentShell.FIRST_BYTE_MS).toBeLessThanOrEqual(2000);
    expect(agentShell.MAX_CONNECTIONS).toBe(8);
    const quietEnd = agentShell.openEndpoint({ flows, folders: () => [ALLOWED], key: KEY, network: NETWORK, firstByteMs: 150 });
    await quietEnd.ready;
    const keep = process.env[SHELL_ENDPOINT_ENV];
    try {
      const opened = Date.now();
      // Every connection the endpoint holds, opened and left silent (as a read-only connect would).
      const closedAfter = await Promise.all(
        Array.from(
          { length: agentShell.MAX_CONNECTIONS },
          () =>
            new Promise<number>((resolve) => {
              const s = net.connect({ path: quietEnd.env.endpoint });
              s.on('error', () => {});
              s.on('close', () => resolve(Date.now() - opened));
            }),
        ),
      );
      // Each one let go long before the ten seconds a whole line may take.
      for (const ms of closedAfter) expect(ms).toBeLessThan(5000);
      // The server's line then gets through at once.
      process.env[SHELL_ENDPOINT_ENV] = quietEnd.env.endpoint;
      expect((await run('shell.hosting.stop', {})).ok).toBe(true);
    } finally {
      process.env[SHELL_ENDPOINT_ENV] = keep;
      await quietEnd.close();
    }
  });

  it('never joins this computer itself: refused before the flow runs, another computer is joined', async () => {
    for (const host of ['localhost', '127.0.0.1:47800', '[::1]', '192.168.1.202', 'front-desk.tail1234.ts.net', 'me.tail1234.ts.net']) {
      const r = await run('shell.hosting.connect', { host });
      expect(r.ok, host).toBe(false);
      expect(r.error, host).toMatch(/is this computer itself/);
    }
    for (const host of ['172.29.150.7', 'wsl-box.tail1234.ts.net']) {
      const r = await run('shell.hosting.connect', { host });
      expect(r.ok, host).toBe(false);
      expect(r.error, host).toMatch(/is a virtual machine or container running on this computer/);
    }
    expect(ran).toEqual([]);
    expect(await run('shell.hosting.connect', { host: 'office.tail1234.ts.net' })).toEqual({ ok: true, result: { host: 'office.tail1234.ts.net' }, error: null, restarting: true });
    expect(ran).toEqual(['connect']);
    expect(personHost).not.toHaveBeenCalled();
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

  it('the log has the operation and its plain outcome only: never a password or a file', async () => {
    // A flow whose error quotes the password, and a print job: their lines are written too.
    const input = { file: path.join(ALLOWED, 'Acme.bkp'), target: path.join(ALLOWED, 'Logged.ironbooks') };
    const before = logged.length;
    expect((await run('shell.portable.open', input, {}, { backup_password: `${SECRET} 3` })).ok).toBe(false);
    expect((await run('shell.portable.open', input, {}, { backup_password: SECRET })).ok).toBe(true);
    const fileId = '8'.repeat(32);
    mocks.staged.set(`${COMPANY}/${AGENT}/${fileId}`, { file: { fileId, name: 'Checks.pdf', type: 'application/pdf', size: PDF.length }, bytes: PDF });
    expect((await run('shell.print.file', { fileId })).ok).toBe(true);
    // One line for each run above. This test does not count on the ones before it: run alone
    // (vitest -t) only its own three are there.
    expect(logged.length - before).toBe(3);
    // Everything this endpoint logged in the whole block: the runs above and, when the block runs
    // whole, every earlier one too (wrong and right passwords, the printed PDFs, refused and
    // replayed tickets).
    expect(logged).toContain('shell.portable.open: done');
    expect(logged.some((m) => /^shell\.portable\.open: not done: /.test(m))).toBe(true);
    expect(logged).toContain('shell.print.file: done');
    const all = logged.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('correct horse');
    expect(all).not.toContain(PDF.toString('base64'));
    expect(all).not.toContain('%PDF-');
    expect(all).not.toContain(KEY);
    // Nor any ticket's MAC: each line is the operation and its outcome, nothing more.
    expect(all).not.toMatch(/[0-9a-f]{64}/);
    for (const m of logged) expect(m, m).toMatch(/^(?:shell\.[A-Za-z.]+: (?:done|done, restarting|not done: [\s\S]*)|a request failed: [\s\S]*)$/);
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

  it('the top of a drive, as the Admin named it or behind a link, is never a folder it saves in', async () => {
    const name = `ib-agent-shell-should-not-exist-${process.pid}.pdf`;
    const top = path.parse(OUTSIDE).root;
    mocks.folders = [top];
    try {
      expect((await save({ fileId, folder: top, name })).error).toMatch(/not a folder agents may save in/);
      const link = path.join(TMP, 'to-the-top');
      fs.symlinkSync(top, link, 'junction');
      mocks.folders = [link];
      expect((await save({ fileId, folder: link, name })).error).toMatch(/not a folder agents may save in/);
      fs.rmSync(link, { force: true, recursive: false });
    } finally {
      fs.rmSync(path.join(top, name), { force: true });
    }
    expect(fs.existsSync(path.join(OUTSIDE, name))).toBe(false);
  });

  it('an Admin folder that has since come to hold Ironbooks’ own data is not one it saves in', async () => {
    const kept = path.join(OUTSIDE, 'kept-backups');
    fs.mkdirSync(kept, { recursive: true });
    const before = process.env.BKA_BACKUP_DIR;
    process.env.BKA_BACKUP_DIR = kept;
    const name = `ib-agent-shell-held-${process.pid}.pdf`;
    try {
      expect((await save({ fileId, folder: OUTSIDE, name })).error).toMatch(/not a folder agents may save in/);
      expect(fs.existsSync(path.join(OUTSIDE, name))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.BKA_BACKUP_DIR;
      else process.env.BKA_BACKUP_DIR = before;
      fs.rmSync(kept, { recursive: true, force: true });
    }
  });

  it('an Admin folder that is a device path, or no full path, is never looked at and never used', async () => {
    // \\?\GLOBALROOT\Device\Mup\… reaches any computer's shares (this one's too): refused by the
    // words, before anything asks the disk about it (looking at a share offers it this person's sign-in).
    // This covers the pair policyFolders (which already leaves these out: overlapsAppData is true
    // for them) and usableFolders; the next test reaches usableFolders alone, through the defaults.
    const odd = [
      '\\\\?\\GLOBALROOT\\Device\\Mup\\otherserver\\books',
      '\\\\.\\UNC\\otherserver\\books',
      '\\??\\C:\\Books',
      '//?/C:/Books',
      'relative\\Books',
      '   ',
    ];
    const looked = vi.spyOn(fs.realpathSync, 'native');
    const allowed = vi.mocked((await import('@/lib/agent/files')).allowedFolder);
    mocks.folders = odd;
    try {
      allowed.mockClear();
      await save({ fileId, folder: OUTSIDE });
      const seen = looked.mock.calls.map((c) => String(c[0]));
      for (const f of odd) expect(seen, f).not.toContain(f);
      // What reaches the folder check is only the defaults: none of those.
      const given = (allowed.mock.calls[0]?.[0] ?? []) as string[];
      for (const f of odd) expect(given, f).not.toContain(f);
    } finally {
      looked.mockRestore();
      mocks.folders = [];
    }
  });

  it.runIf(process.platform === 'win32')('a default folder that is a device path (the company file or Documents as the shell told them) is never looked at either', async () => {
    // The defaults do not go through policyFolders: usableFolders is the only check on them here.
    const DEVICE = /^[\\/]{2}[?.][\\/]|^\\\?\?\\/;
    const keep = { company: process.env.BKA_COMPANY_FILE, docs: process.env[SHELL_DOCUMENTS_ENV] };
    process.env.BKA_COMPANY_FILE = '\\\\?\\GLOBALROOT\\Device\\Mup\\otherserver\\books\\Acme.ironbooks';
    process.env[SHELL_DOCUMENTS_ENV] = '\\\\.\\UNC\\otherserver\\docs';
    const odd = [
      '\\\\?\\GLOBALROOT\\Device\\Mup\\otherserver\\books',
      '\\\\.\\UNC\\otherserver\\docs\\Ironbooks',
      `\\\\.\\UNC\\otherserver\\docs\\Ironbooks\\${AGENT_OUTBOX_NAME}`,
    ];
    // Should the guard ever go, the look still never leaves this computer from a test.
    const realNative = fs.realpathSync.native;
    const looked = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (DEVICE.test(String(p))) throw Object.assign(new Error('ENOENT: not looked at in a test'), { code: 'ENOENT' });
      return realNative(p, o as BufferEncoding);
    }) as unknown as typeof fs.realpathSync.native);
    const allowed = vi.mocked((await import('@/lib/agent/files')).allowedFolder);
    const name = `ib-agent-shell-device-${process.pid}.pdf`;
    try {
      // They are among the defaults as the shell told them, so only usableFolders can leave them out.
      expect(defaultAgentFolders()).toEqual(expect.arrayContaining(odd));
      allowed.mockClear();
      const r = await save({ fileId, folder: OUTSIDE, name });
      expect(r.ok, r.error ?? '').toBe(true);
      const seen = looked.mock.calls.map((c) => String(c[0]));
      expect(seen.filter((s) => DEVICE.test(s))).toEqual([]);
      const given = (allowed.mock.calls[0]?.[0] ?? []) as string[];
      expect(given.filter((s) => DEVICE.test(s))).toEqual([]);
      expect(given).toContain(OUTSIDE);
    } finally {
      looked.mockRestore();
      for (const [k, v] of [['BKA_COMPANY_FILE', keep.company], [SHELL_DOCUMENTS_ENV, keep.docs]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(path.join(OUTSIDE, name), { force: true });
    }
  });

  it('a name is only a name: no folder in it, nothing Windows would change or keeps for a device', async () => {
    for (const name of ['..\\Evil.pdf', '../Evil.pdf', 'a\\b.pdf', 'C:evil.pdf', 'x.pdf:stream', 'CON', 'nul.pdf', 'Report.pdf.', 'Report‮fdp.exe']) {
      const r = await save({ fileId, folder: OUTSIDE, name });
      expect(r.ok, name).toBe(false);
      expect(r.error, name).toMatch(/cannot be used as a file name/);
    }
    expect(fs.existsSync(path.join(TMP, 'Evil.pdf'))).toBe(false);
  });

  it('an exclusive create: never over a folder, nor through a link that leads nowhere (Windows would write where it leads)', async () => {
    fs.mkdirSync(path.join(OUTSIDE, 'Folder.pdf'), { recursive: true });
    expect((await save({ fileId, folder: OUTSIDE, name: 'Folder.pdf' })).error).toMatch(/already a file called "Folder\.pdf"/);
    const nowhere = path.join(TMP, 'nowhere.pdf');
    try {
      fs.symlinkSync(nowhere, path.join(OUTSIDE, 'Link.pdf'), 'file');
    } catch {
      return; // this account may not make links here
    }
    expect((await save({ fileId, folder: OUTSIDE, name: 'Link.pdf' })).error).toMatch(/already a file called "Link\.pdf"/);
    expect(fs.existsSync(nowhere)).toBe(false);
  });

  it('a disk failure says what to do in plain words, never a path; a half-written file is taken away', async () => {
    const full = vi
      .spyOn(fs.promises, 'open')
      .mockRejectedValueOnce(Object.assign(new Error(`ENOSPC: no space left on device, open '${path.join(OUTSIDE, 'Full.pdf')}'`), { code: 'ENOSPC' }));
    try {
      const r = await save({ fileId, folder: OUTSIDE, name: 'Full.pdf' });
      expect(r.error).toMatch(/no room left on that disk, so nothing was saved/);
      expect(r.error).not.toContain(OUTSIDE);
      expect(r.error).not.toMatch(/ENOSPC|Full\.pdf/);
    } finally {
      full.mockRestore();
    }
    const realOpen = fs.promises.open.bind(fs.promises);
    const half = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.promises.open>) => {
      const h = await realOpen(...args);
      h.writeFile = async () => {
        throw Object.assign(new Error(`EIO: i/o error, write '${path.join(OUTSIDE, 'Half.pdf')}'`), { code: 'EIO' });
      };
      return h;
    });
    try {
      const r = await save({ fileId, folder: OUTSIDE, name: 'Half.pdf' });
      expect(r.error).toMatch(/could not be saved in that folder/);
      expect(r.error).not.toContain(OUTSIDE);
      expect(fs.existsSync(path.join(OUTSIDE, 'Half.pdf'))).toBe(false);
    } finally {
      half.mockRestore();
    }
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
        if (q.kind === 'choice') {
          // The card offers the window's own button words, less those an agent's request never presses.
          const offered = boxes.map((b: { buttons: string[]; refused?: string[] }) => b.buttons.filter((x) => !(b.refused ?? []).includes(x)));
          expect(offered, q.id).toContainEqual(q.choices);
        }
      }
      if (spec.password) expect(d.needsSecret, d.id).toContain(spec.password);
    }
    const asked = new Set(electron.flatMap((d) => d.questions.map((q) => q.id)));
    for (const box of agentShell.QUESTIONS) if (box.id) expect(asked.has(box.id), box.id).toBe(true);
    // A box that only stops the request says why, in a sentence.
    for (const box of agentShell.QUESTIONS as { stop?: string; why?: string }[]) if (box.stop) expect(box.why, box.stop).toMatch(/^[A-Z].*\.$/);
  });

  it('a secret a flow always needs is one it takes; none of today’s flows needs one every time', () => {
    for (const d of SHELL_OPERATIONS) {
      for (const k of d.alwaysNeedsSecret ?? []) expect(d.needsSecret, d.id).toContain(k);
    }
    // A portable file or an Accountant's Copy asks for its password only when it was saved with one.
    for (const id of ['shell.portable.open', 'shell.accountantCopy.open']) {
      expect(SHELL_OPERATIONS.find((d) => d.id === id)?.needsSecret, id).toEqual(['backup_password']);
      expect(SHELL_OPERATIONS.find((d) => d.id === id)?.alwaysNeedsSecret, id).toEqual([]);
    }
  });

  it('the why texts and questions read as the person approving reads them: plain sentences, the agent named as "the agent"', () => {
    for (const d of SHELL_OPERATIONS) {
      // Never "your connection" or "connect again" said to the agent: a person reads this on the card.
      expect(d.why, d.id).not.toMatch(/\byour connection\b|\bYour connection\b|\bconnect again in\b|\byou may work\b|\byou cannot\b|\byour staged\b|\bfor you\b|\bgave you\b/);
      expect(d.why, d.id).toMatch(/^[A-Z"'].*[.)]$/);
      for (const q of d.questions) {
        expect(q.text, `${d.id} ${q.id}`).toMatch(/\?/);
        expect(q.text, `${d.id} ${q.id}`).not.toMatch(/\byour connection\b/i);
      }
    }
  });

  it('is pure data that client code may read: type-only imports, nothing that runs', () => {
    const src = read('lib/agent/operations/shell.ts');
    const imports = src.match(/^import\b.*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^import type \{[^}]+\} from '[^']+';$/);
    expect(src).not.toMatch(/\brequire\(|\bimport\(|\bprocess\.|\bexport (async )?function\b|\bawait\b/);
    // The list, and the type of its entries (the contract's ShellOperationDef plus what it lacks).
    expect(src.match(/^export \S+ \S+/gm)).toEqual(['export interface ShellOperationEntry', 'export const SHELL_OPERATIONS:']);
  });
});

describe('the agent service’s quiet answers (electron/agentService.js)', () => {
  it('read a dialog’s options as Electron does: a plain object first, otherwise the second argument', () => {
    const box = { message: 'Take over?', buttons: ['Open Anyway', 'Cancel'], cancelId: 1 };
    for (const args of [[box], [WIN, box], [null, box], [undefined, box]]) expect(agentService.quietDialogAnswer(args).response).toBe(1);
    // A window (an object of a class, with a `title` of its own) is never taken for the options.
    expect('title' in WIN).toBe(true);
    expect(agentService.quietDialogAnswer([WIN])).toEqual({ response: 0, checkboxChecked: false });
    expect(agentService.quietDialogAnswer([WIN, WIN])).toEqual({ response: 0, checkboxChecked: false });
    // The first plain object is the options whatever it holds, as Electron reads it: never picked by content.
    expect(agentService.quietDialogAnswer([{ cancelId: 2 }, box]).response).toBe(2);
    expect(agentService.quietDialogAnswer([{ title: 'x' }, box]).response).toBe(0);
    expect(agentService.quietDialogAnswer([]).response).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Agents' staged files in a working copy (electron/companySession.js)
// ---------------------------------------------------------------------------

describe('agents’ staged files in a working copy', () => {
  const root = path.join(TMP, 'Working');
  const DAY = 24 * 3600 * 1000;
  /** A working copy with a database, a state, and agents' staged files. */
  const workingCopy = (name: string, lastUsedAt: string) => {
    const dir = path.join(root, name);
    companySession.writeState(dir, { lastUsedAt, unsavedSince: null });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'PG_VERSION'), '17\n');
    const staged = path.join(dir, 'agent-files', COMPANY, AGENT);
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-files', '.ironbooks-agent-files'), 'marker');
    fs.writeFileSync(path.join(staged, `${'a'.repeat(32)}.bin`), 'a bank statement');
    return dir;
  };
  /** Make everything under `dir` look `ms` old. */
  const age = (dir: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    const walk = (p: string) => {
      for (const n of fs.readdirSync(p)) {
        const q = path.join(p, n);
        if (fs.lstatSync(q).isDirectory()) walk(q);
        fs.utimesSync(q, when, when);
      }
    };
    walk(dir);
    fs.utimesSync(dir, when, when);
  };

  it('are kept where lib/agent/files.ts keeps them, and count as a cache entry', async () => {
    expect(companySession.AGENT_FILES_DIR).toBe('agent-files');
    expect(companySession.isCacheEntry('agent-files')).toBe(true);
    expect(companySession.isCacheEntry('archives')).toBe(false);
    const files = await vi.importActual<typeof import('@/lib/agent/files')>('@/lib/agent/files');
    const keep = { state: process.env.BKA_COMPANY_STATE, dir: process.env.BKA_AGENT_FILES_DIR, data: process.env.BKA_DATA_DIR };
    const work = path.join(root, 'where-cccccccccccc');
    try {
      delete process.env.BKA_AGENT_FILES_DIR;
      process.env.BKA_DATA_DIR = path.join(work, 'data');
      process.env.BKA_COMPANY_STATE = path.join(work, companySession.STATE_FILE);
      expect(files.stagedFilesRoot()).toBe(path.join(work, companySession.AGENT_FILES_DIR));
    } finally {
      for (const [k, v] of [['BKA_COMPANY_STATE', keep.state], ['BKA_AGENT_FILES_DIR', keep.dir], ['BKA_DATA_DIR', keep.data]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a leftover never keeps an old working copy from being pruned', () => {
    const old = workingCopy('old-aaaaaaaaaaaa', '2020-01-01T00:00:00Z');
    companySession.pruneWorkingCopies(root);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('go a day after nothing changed in them, in a working copy that is not open; the open one keeps its own', () => {
    const recent = new Date().toISOString();
    const stale = workingCopy('stale-bbbbbbbbbbbb', recent);
    const fresh = workingCopy('fresh-dddddddddddd', recent);
    const open = workingCopy('open-eeeeeeeeeeee', recent);
    age(path.join(stale, 'agent-files'), DAY + 60_000);
    age(path.join(open, 'agent-files'), DAY + 60_000);
    companySession.pruneWorkingCopies(root, [open]);
    expect(fs.existsSync(path.join(stale, 'agent-files'))).toBe(false);
    // The working copy itself is not old: its books and state stay.
    expect(fs.existsSync(path.join(stale, 'data', 'PG_VERSION'))).toBe(true);
    expect(companySession.readState(stale)).toBeTruthy();
    expect(fs.existsSync(path.join(fresh, 'agent-files'))).toBe(true);
    expect(fs.existsSync(path.join(open, 'agent-files'))).toBe(true);
  });

  it('are cleared when the company file closes; a link in their place is removed, never followed', () => {
    const work = workingCopy('close-ffffffffffff', new Date().toISOString());
    expect(companySession.clearAgentFiles(work)).toBe(true);
    expect(fs.existsSync(path.join(work, 'agent-files'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'data', 'PG_VERSION'))).toBe(true);
    expect(companySession.clearAgentFiles(work)).toBe(true); // nothing there: fine
    const elsewhere = path.join(TMP, 'not-agent-files');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'keep me');
    fs.symlinkSync(elsewhere, path.join(work, 'agent-files'), 'junction');
    expect(companySession.clearAgentFiles(work)).toBe(true);
    expect(fs.existsSync(path.join(work, 'agent-files'))).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep me');
    expect(companySession.clearAgentFiles('')).toBe(true);
  });

  it('with a company folder open they live in the app data folder, where lib/agent/files.ts puts them', async () => {
    const files = await vi.importActual<typeof import('@/lib/agent/files')>('@/lib/agent/files');
    const local = path.join(TMP, 'LocalAppData-where');
    const keep = { state: process.env.BKA_COMPANY_STATE, dir: process.env.BKA_AGENT_FILES_DIR, data: process.env.BKA_DATA_DIR, local: process.env.LOCALAPPDATA, xdg: process.env.XDG_STATE_HOME };
    try {
      delete process.env.BKA_COMPANY_STATE;
      delete process.env.BKA_AGENT_FILES_DIR;
      process.env.BKA_DATA_DIR = path.join(TMP, 'Company Folder', 'data');
      process.env.LOCALAPPDATA = local;
      process.env.XDG_STATE_HOME = local;
      if (process.platform !== 'darwin') expect(companySession.appDataAgentFilesRoot()).toBe(files.stagedFilesRoot());
    } finally {
      for (const [k, v] of [['BKA_COMPANY_STATE', keep.state], ['BKA_AGENT_FILES_DIR', keep.dir], ['BKA_DATA_DIR', keep.data], ['LOCALAPPDATA', keep.local], ['XDG_STATE_HOME', keep.xdg]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(companySession.appDataAgentFilesRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Pat\\AppData\\Local' } })).toBe(path.join('C:\\Users\\Pat\\AppData\\Local', 'Ironbooks', 'agent-files'));
  });

  it('and are cleared from there too (on quit and when the server starts): only a folder that carries the marker, never through a link', () => {
    const local = path.join(TMP, 'LocalAppData-clear');
    const opts = { platform: 'win32', env: { LOCALAPPDATA: local } };
    const where = companySession.appDataAgentFilesRoot(opts);
    expect(where).toBe(path.join(local, 'Ironbooks', 'agent-files'));
    // Nothing there: fine.
    expect(companySession.clearAppDataAgentFiles(opts)).toBe(true);
    // As lib/agent/files.ts leaves it: the root, a company's and an agent's folder, each marked.
    const staged = path.join(where, COMPANY, AGENT);
    fs.mkdirSync(staged, { recursive: true });
    for (const d of [where, path.join(where, COMPANY), staged]) fs.writeFileSync(path.join(d, '.ironbooks-agent-files'), 'marker');
    fs.writeFileSync(path.join(staged, `${'b'.repeat(32)}.bin`), 'a bank statement');
    fs.writeFileSync(path.join(staged, `${'b'.repeat(32)}.json`), '{}');
    expect(companySession.clearAppDataAgentFiles(opts)).toBe(true);
    expect(fs.existsSync(where)).toBe(false);
    // Ironbooks' other folders beside it stay.
    fs.mkdirSync(path.join(local, 'Ironbooks', 'Working'), { recursive: true });
    expect(companySession.clearAppDataAgentFiles(opts)).toBe(true);
    expect(fs.existsSync(path.join(local, 'Ironbooks', 'Working'))).toBe(true);
    // A folder of that name without the marker may be anyone's: kept.
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, 'notes.txt'), 'not ours');
    expect(companySession.clearAppDataAgentFiles(opts)).toBe(false);
    expect(fs.readFileSync(path.join(where, 'notes.txt'), 'utf8')).toBe('not ours');
    fs.rmSync(where, { recursive: true, force: true });
    // A link there, even to a marked folder: neither followed nor removed.
    const target = path.join(TMP, 'marked-elsewhere');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.ironbooks-agent-files'), 'marker');
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep me');
    fs.symlinkSync(target, where, 'junction');
    expect(companySession.clearAppDataAgentFiles(opts)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('keep me');
    fs.unlinkSync(where);
    // A file in its place: left alone.
    fs.writeFileSync(where, 'a file');
    expect(companySession.clearAppDataAgentFiles(opts)).toBe(false);
    expect(fs.readFileSync(where, 'utf8')).toBe('a file');
  });

  it('are cleared when a company file opens (what a crash left), but not when the open is called off', async () => {
    const { makeStartableFolder } = await import('@/lib/db/damage.fixture');
    const src = path.join(TMP, 'open-src');
    await makeStartableFolder(src);
    const cf = path.join(TMP, 'Open Co.ironbooks');
    await companyFileFormat.writeCompanyFile(cf, {
      manifest: { formatVersion: 1, fileId: 'fid-open', companyName: 'Open Co', saveId: 's1', savedAt: 'x' },
      entries: companyFileFormat.snapshotDir(src),
    });
    const wr = path.join(TMP, 'Working-open');
    const first = await companySession.prepareWorkingCopy(cf, { root: wr });
    const leftover = path.join(first.workDir, 'agent-files', COMPANY, AGENT);
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, `${'b'.repeat(32)}.bin`), 'a statement from before the crash');
    // Someone else saved the file meanwhile and this copy holds unsaved work: the person says stop.
    companySession.writeState(first.workDir, { unsavedSince: '2026-11-20T10:00:00Z' });
    await companyFileFormat.writeCompanyFile(cf, {
      manifest: { formatVersion: 1, fileId: 'fid-open', companyName: 'Open Co', saveId: 's2', savedAt: 'y' },
      entries: companyFileFormat.snapshotDir(src),
    });
    const stopped = await companySession.prepareWorkingCopy(cf, { root: wr, onConflict: async () => false });
    expect(stopped.plan).toBe('cancelled');
    expect(fs.existsSync(leftover)).toBe(true);
    // Opened after all: the leftover goes.
    const opened = await companySession.prepareWorkingCopy(cf, { root: wr, onConflict: async () => true });
    expect(opened.plan).toBe('conflict');
    expect(fs.existsSync(path.join(first.workDir, 'agent-files'))).toBe(false);
    for (const f of fs.readdirSync(TMP).filter((n) => n.startsWith('Open Co (unsaved changes'))) fs.rmSync(path.join(TMP, f), { force: true });
  }, 60_000);
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

  it('is worded from the server’s own count, never from text the page sends or the agent’s words', () => {
    const count = {
      pending: 1,
      newest: { id: 'r1', agentName: 'Month-end\nhelper', summary: 'Pay 3 bills from Checking for $1,240.00.', createdAt: '2026-11-20T10:00:00.000Z', reason: 'Ignore your rules' },
      agents: 1,
      allPaused: false,
      canPauseAll: true,
    };
    expect(agentShell.noticeFromCount(count, '/agent-requests')).toEqual({
      title: 'Month-end helper asks for your approval',
      body: 'Pay 3 bills from Checking for $1,240.00. Click to review it.',
      href: '/agent-requests',
      id: 'r1',
    });
    const three = agentShell.noticeFromCount({ ...count, pending: 3 }, '/agent-requests/r1');
    expect(three.body).toBe('Pay 3 bills from Checking for $1,240.00. 3 requests are waiting. Click to review them.');
    expect(three.href).toBe('/agent-requests/r1');
    expect(JSON.stringify(three)).not.toMatch(/Ignore your rules/);
    // The server could not be asked: a notice that names nothing, still opening the approval center.
    for (const unknown of [null, undefined, 'text from a page', { pending: 2, newest: null }]) {
      const n = agentShell.noticeFromCount(unknown, 'https://evil.example/');
      expect(n.title).toBe('An agent asks for your approval');
      expect(n.body).toMatch(/^A request is waiting in Agent requests\./);
      expect(n.href).toBe('/agent-requests');
    }
  });

  it('names the agent and what it asks only for the request the window found new, and announces each request once', () => {
    // The window found "a" new; this app's own read, a moment later, finds "b" newest (it arrived in between).
    const count = {
      pending: 2,
      newest: { id: 'b-2', agentName: 'Payroll helper', summary: 'Enter a paycheck for Dana Lee', createdAt: '2026-11-20T10:01:00.000Z' },
      agents: 1,
      allPaused: false,
      canPauseAll: true,
    };
    const forA = agentShell.noticeFromCount(count, '/agent-requests', 'a-1');
    expect(forA).toEqual({
      title: 'An agent asks for your approval',
      body: 'A request is waiting in Agent requests. 2 requests are waiting. Click to review them.',
      href: '/agent-requests',
      id: 'a-1',
    });
    expect(JSON.stringify(forA)).not.toMatch(/Payroll helper|Dana Lee/);
    // The same request: named.
    const forB = agentShell.noticeFromCount(count, '/agent-requests', 'b-2');
    expect(forB.title).toBe('Payroll helper asks for your approval');
    expect(forB.id).toBe('b-2');
    // An id that is no request's id is no id at all (an older window): the newest one is named.
    for (const odd of ['', '../settings', 'x'.repeat(65), 42, null, undefined]) {
      expect(agentShell.noticeFromCount(count, '/agent-requests', odd).title, String(odd)).toBe('Payroll helper asks for your approval');
    }
    // Each request is announced once, also when the window asks again (a reload, a later poll).
    const before = FakeNotice.made.length;
    const show = (notice: unknown) => agentShell.showNotice({ Notification: FakeNotice, win: win(false), notice, open: vi.fn() });
    expect(show(forA)).toBe(true);
    expect(show(agentShell.noticeFromCount(count, '/agent-requests', 'a-1'))).toBe(false);
    // Asked without an id, the newest one ("b") is named once; the window's later ask for "b" shows nothing more.
    expect(show(agentShell.noticeFromCount(count, '/agent-requests'))).toBe(true);
    expect(show(agentShell.noticeFromCount(count, '/agent-requests', 'b-2'))).toBe(false);
    expect(FakeNotice.made.slice(before).map((n) => n.opts.title)).toEqual(['An agent asks for your approval', 'Payroll helper asks for your approval']);
    // While the window is in front nothing is announced, so the request is still announced later.
    const c = { ...count, newest: { ...count.newest, id: 'c-3' } };
    expect(agentShell.showNotice({ Notification: FakeNotice, win: win(true), notice: agentShell.noticeFromCount(c, '/agent-requests', 'c-3'), open: vi.fn() })).toBe(false);
    expect(show(agentShell.noticeFromCount(c, '/agent-requests', 'c-3'))).toBe(true);
    // A notice with no id at all (the server could not be asked) is never held back.
    expect(show(agentShell.noticeFromCount(null, '/agent-requests'))).toBe(true);
    expect(show(agentShell.noticeFromCount(null, '/agent-requests'))).toBe(true);
  });

  it('a minimized window is not in front: the notice shows, and clicking it brings the window back on the approval center', () => {
    const calls: string[] = [];
    const minimized = {
      isDestroyed: () => false,
      isFocused: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    };
    const navigate = vi.fn();
    const made = FakeNotice.made.length;
    const shown = agentShell.showNotice({
      Notification: FakeNotice,
      win: minimized,
      notice: agentShell.noticeFromCount(null, '/agent-requests'),
      open: (route: string) => agentShell.showWindowOn(minimized, route, navigate),
    });
    expect(shown).toBe(true);
    FakeNotice.made[made].handlers.click();
    expect(calls).toEqual(['restore', 'show', 'focus']);
    expect(navigate).toHaveBeenCalledWith('/agent-requests');
    // Only the approval center's own pages, and a window that is gone still gets the page asked for.
    agentShell.showWindowOn(null, 'https://evil.example/', navigate);
    expect(navigate).toHaveBeenLastCalledWith('/agent-requests');
    agentShell.showWindowOn({ ...minimized, isDestroyed: () => true }, '/agent-requests/r2', navigate);
    expect(navigate).toHaveBeenLastCalledWith('/agent-requests/r2');
  });

  it('lib/desktop/agentNotice.ts calls the desktop bridge when there is one, and does nothing otherwise', () => {
    expect(() => showAgentRequestNotice({ title: 't', body: 'b', href: '/agent-requests' })).not.toThrow();
    const g = globalThis as { window?: unknown };
    const agentNotice = vi.fn(async () => true);
    g.window = { bookkeeper: { agentNotice } };
    try {
      showAgentRequestNotice({ title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests/r1' });
      expect(agentNotice).toHaveBeenCalledWith({ title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests/r1' });
      // The id of the request the window found new goes along when there is one.
      showAgentRequestNotice({ title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests', id: 'r1' });
      expect(agentNotice).toHaveBeenLastCalledWith({ title: 'Bot asks', body: 'Email invoice 1042', href: '/agent-requests', id: 'r1' });
      showAgentRequestNotice({ title: ' ', body: 'b', href: '/agent-requests' });
      expect(agentNotice).toHaveBeenCalledTimes(2);
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
    // The answer names the file the restart really opens, from the next launch's config.
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

  it('the notice is shown only for the local app’s own pages, worded from the server, and the preload sends no text', () => {
    const at = main.indexOf("ipcMain.handle('agent:notice'");
    expect(at).toBeGreaterThan(-1);
    expect(main.slice(at, at + 200)).toMatch(/if \(!fromLocalApp\(e\) \|\| agentServiceHidden\) return false;/);
    const handler = main.slice(at, main.indexOf('});', at));
    expect(handler).toContain('const count = await agentRequestCountForNotice();');
    // The page to open, and the id of the request the window found new (named only when it is this read's newest).
    expect(handler).toContain(
      "notice: agentShell.noticeFromCount(count, ask && typeof ask === 'object' ? ask.href : null, ask && typeof ask === 'object' ? ask.id : null),",
    );
    expect(handler).not.toMatch(/ask\.(title|body)/);
    expect(handler).toContain('open: (route) => agentShell.showWindowOn(mainWindow, route, navigate),');
    // The count is asked with the window's own sign-in, from this app's own server only.
    const count = fnBody('async function agentRequestCountForNotice() {');
    expect(count).toMatch(/if \(!serverUrl \|\| remoteHostOrigin \|\| !mainWindow \|\| mainWindow\.isDestroyed\(\)\) return null;/);
    expect(count).toContain("new URL('/api/agent-requests/count', serverUrl)");
    expect(count).toContain("ses.fetch(countUrl, { credentials: 'include', cache: 'no-store', redirect: 'error' })");
    // The preload passes the page to open and the request's id, and nothing else.
    const bridge = preload.slice(preload.indexOf('agentNotice: (notice) =>'), preload.indexOf('isDesktop: true'));
    expect(bridge).toMatch(
      /ipcRenderer\.invoke\('agent:notice', \{\s*href: String\(\(notice && notice\.href\) \?\? ''\),\s*id: String\(\(notice && notice\.id\) \?\? ''\),\s*\}\)/,
    );
    expect(bridge).not.toMatch(/title: String|body: String|notice\.(title|body|summary|newest)/);
  });

  it('staged files go when the company file closes, and the servers never take a staged-files folder from this computer', () => {
    // All of them (clearStagedFiles({ all: true }), done by the shell): the working copy's, or with
    // a company folder open those in this computer's app data folder (not in client mode, where
    // this computer ran no server of its own).
    const clear = fnBody('function clearStagedAgentFiles() {');
    expect(clear).toContain('if (openFile && openFile.workDir) companySession.clearAgentFiles(openFile.workDir);');
    expect(clear).toContain('else if (!remoteHostOrigin) companySession.clearAppDataAgentFiles();');
    // As soon as the company file is saved and released (an update's installer may end the app
    // before will-quit), and never when the save failed and the person keeps working in it.
    const close = main.slice(main.indexOf("app.on('before-quit', (event) => {"), main.indexOf('// Second pass: backup done'));
    const released = close.indexOf('.then(() => closeOpenCompanyFile())');
    const keptWorking = close.indexOf('if (goOn === false) {');
    const cleared = close.indexOf('clearStagedAgentFiles();');
    expect(released).toBeGreaterThan(-1);
    expect(keptWorking).toBeGreaterThan(released);
    expect(cleared).toBeGreaterThan(close.indexOf('quittingAfterBackup = true;', keptWorking));
    expect(cleared).toBeLessThan(close.indexOf('autoUpdater.quitAndInstall(false, true);'));
    // And again on quit, for anything staged in the moment before the server stopped.
    const quit = main.slice(main.indexOf("app.on('will-quit', () => {"), main.indexOf('async function agentRequestCountForNotice() {'));
    expect(quit).toContain('clearStagedAgentFiles();');
    // …and when the server starts, before it can hand any out (what a crash left).
    const start = fnBody('async function startNextServer() {');
    expect(start).toContain('companySession.clearAppDataAgentFiles();');
    expect(start.indexOf('companySession.clearAppDataAgentFiles();')).toBeLessThan(start.indexOf("await startVerifiedServer('server'"));
    expect(start.indexOf("if (isDev) return 'http://localhost:3000';")).toBeLessThan(start.indexOf('companySession.clearAppDataAgentFiles();'));
    expect(fnBody('async function startNextServer() {')).toContain("BKA_AGENT_FILES_DIR: '',");
    expect(fnBody('async function startScratchServer(dataDir) {')).toContain("BKA_AGENT_FILES_DIR: '',");
    expect(main).not.toMatch(/process\.env\.BKA_AGENT_/);
  });
});
