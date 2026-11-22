/**
 * Agent full access: staged files (lib/agent/files.ts, plan §5.7).
 *
 * Everything runs in a temporary folder (BKA_AGENT_FILES_DIR). What is proved:
 *  - A staged file comes back whole, with its cleaned name and type, and lies on the disk as
 *    <companyId>/<agentId>/<fileId>.bin + .json, nowhere else.
 *  - An upload in parts adds up to the same file; each part, the total, the number of unfinished
 *    uploads and the base64 itself are checked; an unknown or another agent's upload is refused.
 *  - Another agent, or the same agent id in another company, never reaches the file.
 *  - File ids and names cannot be paths, device names, hidden-direction tricks or broken characters;
 *    an id of the wrong shape never reaches the disk.
 *  - One agent keeps at most 500 MB or 1000 files at once (the exported constants), refused with
 *    words that say how much room is left when only the new file does not fit, and to remove files
 *    (remove_file, once the door has that verb), to wait and how long, or to ask a person; other
 *    agents are not affected; removing a file, or expiry as a read judges it, frees the room at
 *    once; only what a read would return holds room; and what expired, was left half written or
 *    can never be read is removed when the agent next adds a file.
 *  - As an attacker: a .bin, .json or .part swapped for another file, a second name, a link or (on
 *    macOS and Linux) a pipe between the check and the use; a .bin or .json that grows while it is
 *    read; the agent's or company's folder swapped for a link; a staged file copied into another
 *    owner's folder; ids guessed from another agent or company; device names, streams, trailing
 *    dots and spaces; long paths; a link swapped in after the walk that leads to a share. Each
 *    refused, nothing of anyone else's touched, nothing waited on, nothing read past its size.
 *  - The table of this-computer-share cases (thisComputerShares.json) the ports are held to.
 *  - Old files and uploads are cleared (by age, or all), also lazily (when adding and when reading);
 *    clearing a missing folder is fine; a full clear at the same time as writes never fails them,
 *    waits for a write already going, and never takes a file staged after it began (one gate).
 *  - Where: beside the open company file; never in a folder that holds the books or Ironbooks' own
 *    folder or lies inside the books, by the words or through a link; never on a share, by the
 *    words or as the disk answers (a link to one, a mapped drive); every folder made is marked, and
 *    a folder without the marker is never cleared, nor used when it holds other things; the
 *    override is for test runs only.
 *  - overlapsAppData: the staging folders, the books and the copies beside them, Ironbooks' own
 *    local folder, the desktop app's settings folder under every name it has had (company-folder
 *    mode's companies included), the backup, sandbox and connection-file folders the shell names,
 *    the browser version's sandbox folder and, while a sandbox is open there, the real books beside
 *    it, inside or holding them, through links and in other spellings; fail closed for what is no full
 *    path and for a share on this very computer in any spelling (by the words, nothing looked at,
 *    or as the disk answers).
 *  - allowedFolder: the folder itself or below, never beside or above (".."), case on Windows, a
 *    look-alike name (the Kelvin sign) refused, never a whole drive, share or mounted volume, links
 *    that lead outside, shares (refused before they are looked at, and accepted when an allowed
 *    folder names the share), a share on this very computer (refused even when it answers) and
 *    device paths.
 *  - "Before the disk is looked at" is checked by watching every file-system call this module makes.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_VERBS, STAGED_FILE_HOURS, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type FileOwner } from './contract';
import {
  AGENT_FILES_DIR_ENV,
  AGENT_MAX_BYTES,
  AGENT_MAX_FILES,
  allowedFolder,
  appDataPlaces,
  clearStagedFiles,
  isThisComputerShare,
  overlapsAppData,
  readStagedFile,
  REMOVE_FILE_VERB,
  removeStagedFile,
  stagedFileInfo,
  stagedFilesRoot,
  stageFile,
  uploadChunk,
} from './files';
import thisComputerShares from './thisComputerShares.json';
import { ServiceError } from '@/lib/services/errors';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-agent-files-'));
const ROOT = path.join(TMP, 'staged');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const me: FileOwner = { companyId: COMPANY, agentId: AGENT };
const otherAgent: FileOwner = { companyId: COMPANY, agentId: OTHER_AGENT };
const otherCompany: FileOwner = { companyId: OTHER_COMPANY, agentId: AGENT };

const MB = 1024 * 1024;
/** What marks a folder as Ironbooks' own staging folder (lib/agent/files.ts MARKER). */
const MARKER = '.ironbooks-agent-files';

const WIN = process.platform === 'win32';
/** The Kelvin sign: upper case already, lower case "k", and a name of its own on an NTFS disk. */
const KELVIN = 'K';

const ENV_KEYS = [
  AGENT_FILES_DIR_ENV,
  'BKA_COMPANY_STATE',
  'BKA_DATA_DIR',
  'BKA_COMPANY_FILE',
  'NODE_ENV',
  'LOCALAPPDATA',
  'XDG_STATE_HOME',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'IRONBOOKS_USER_DATA',
  'BKA_BACKUP_DIR',
  'BKA_SANDBOX_ROOT',
  'BKA_SANDBOX_REAL_DIR',
  'BKA_REAL_COMPANY_FILE',
  'IRONBOOKS_AGENT_ENDPOINT_DIR',
] as const;
/** process.env with every name writable (Next types NODE_ENV as read-only). */
const env = process.env as Record<string, string | undefined>;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, env[k]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(...keys: Array<(typeof ENV_KEYS)[number]>): void {
  for (const k of keys) {
    const v = savedEnv[k];
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

function ownerFolder(o: FileOwner): string {
  return path.join(ROOT, o.companyId, o.agentId);
}

/** As much of a FileHandle as the tests that watch its reads need. */
interface FileHandleLike {
  read: (...a: unknown[]) => Promise<{ bytesRead: number }>;
}

/** One case of lib/agent/thisComputerShares.json. */
interface ShareCase {
  path: string;
  want: boolean;
  env?: Record<string, string>;
  since?: string;
  why?: string;
}

/**
 * The table's cases with every template it lists filled in for this computer
 * (lib/agent/thisComputerShares.json says what each stands for); a case whose template cannot be
 * filled here is left out. A template the table lists that this cannot fill, or a case naming one
 * the table does not list, throws: the test fails rather than judge a template's own words.
 */
function shareCases(): ShareCase[] {
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
  const fill: Record<string, string | null> = {
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
  const listed = Object.keys(thisComputerShares.templates);
  const unknown = listed.filter((t) => !Object.prototype.hasOwnProperty.call(fill, t));
  if (unknown.length) throw new Error(`lib/agent/thisComputerShares.json lists templates this test cannot fill: ${unknown.join(', ')}.`);
  const out: ShareCase[] = [];
  for (const c of thisComputerShares.cases as ShareCase[]) {
    let p: string | null = c.path;
    for (const t of listed) if (p?.includes(t)) p = fill[t] === null ? null : p.split(t).join(fill[t] as string);
    if (p === null) continue;
    const left = /\{[^}]+\}/.exec(p);
    if (left) throw new Error(`The case ${JSON.stringify(c.path)} names ${left[0]}, which lib/agent/thisComputerShares.json does not list under templates.`);
    out.push({ ...c, path: p });
  }
  return out;
}

/** Run `fn` as if remove_file were one of the door's verbs (contract AGENT_VERBS), then put the list back. */
async function withRemoveVerb(fn: () => Promise<void>): Promise<void> {
  const verbs = AGENT_VERBS as unknown as string[];
  const had = verbs.includes(REMOVE_FILE_VERB);
  if (!had) verbs.push(REMOVE_FILE_VERB);
  try {
    await fn();
  } finally {
    if (!had) verbs.splice(verbs.indexOf(REMOVE_FILE_VERB), 1);
  }
}

/** Run `fn` with these environment values in place, then put back what was there. */
function withEnv(values: Record<string, string> | undefined, fn: () => void): void {
  const before = Object.fromEntries(Object.keys(values ?? {}).map((k) => [k, env[k]]));
  Object.assign(env, values ?? {});
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}

/** `count` more staged files of one byte in the owner's folder `dir`, as stageFile keeps them (each with its .json). */
function plantStaged(dir: string, o: FileOwner, count: number): void {
  const created = new Date().toISOString();
  for (let i = 1; i <= count; i++) {
    const id = i.toString(16).padStart(32, '0');
    fs.writeFileSync(path.join(dir, `${id}.bin`), 'p');
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ name: `p${i}.txt`, type: 'text/plain', size: 1, created, company: o.companyId, agent: o.agentId }));
  }
}

/**
 * Staged files of these sizes in the owner's folder `dir`, each whole as stageFile keeps it (its
 * .json names the owner and the very size of its .bin, so a read would return it); the bytes are
 * made by setting the size, never written. Their ids start with "5", away from plantStaged's.
 * Answers the .bin of each.
 */
function plantSized(dir: string, o: FileOwner, sizes: readonly number[]): string[] {
  const created = new Date().toISOString();
  return sizes.map((size, i) => {
    const id = `5${(i + 1).toString(16).padStart(31, '0')}`;
    const bin = path.join(dir, `${id}.bin`);
    fs.writeFileSync(bin, '');
    fs.truncateSync(bin, size);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ name: `s${i}.bin`, type: 'application/octet-stream', size, created, company: o.companyId, agent: o.agentId }));
    return bin;
  });
}

/** Make a staged file or upload look `hours` old on the disk. */
function age(file: string, hours: number): void {
  const t = new Date(Date.now() - hours * 3600_000);
  fs.utimesSync(file, t, t);
}

function lazyClearDue(): void {
  const g = globalThis as typeof globalThis & { __bkaAgentFiles?: { clearedAt: number } };
  if (g.__bkaAgentFiles) g.__bkaAgentFiles.clearedAt = 0;
}

function noLazyClear(): void {
  const g = globalThis as typeof globalThis & { __bkaAgentFiles?: { clearedAt: number } };
  if (g.__bkaAgentFiles) g.__bkaAgentFiles.clearedAt = Date.now();
}

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    // Plain words for the agent: never a folder of this computer.
    expect((err as Error).message).not.toContain(TMP);
    expect((err as Error).message).not.toContain(os.tmpdir());
    return err as ServiceError;
  }
  throw new Error('expected a refusal');
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A path one of this test's places stands for (its folders, the books, a share, Ironbooks' own). */
const OURS = (p: string) => p.includes(TMP) || p.includes('.bookkeeper-data') || /^[\\/]{2}/.test(p) || /ironbooks|agent-files/i.test(p);

/**
 * Watch every way lib/agent/files.ts looks at or changes the disk, the synchronous ones included:
 * `paths()` lists what each call was about (calls through to the real disk).
 */
function watchDisk(): { paths: (which?: (p: string) => boolean) => string[]; restore: () => void } {
  const asyncCalls = ['lstat', 'stat', 'readFile', 'readdir', 'open', 'realpath', 'readlink', 'mkdir', 'writeFile', 'rename', 'rm', 'rmdir'] as const;
  const syncCalls = ['lstatSync', 'statSync', 'existsSync', 'readdirSync'] as const;
  const spies: Array<{ mock: { calls: unknown[][] }; mockRestore: () => void }> = [
    ...asyncCalls.map((m) => vi.spyOn(fsp, m as never) as never),
    ...syncCalls.map((m) => vi.spyOn(fs, m as never) as never),
    vi.spyOn(fs.realpathSync, 'native') as never,
    vi.spyOn(fs.realpath, 'native') as never,
  ];
  return {
    paths: (which = OURS) => spies.flatMap((s) => s.mock.calls.map((c) => String(c[0]))).filter(which),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

/** Spy on `obj[name]`: every call goes on to the real one, after `see` is shown what it is about. */
function passThrough(obj: object, name: string, see: (p: unknown) => void): { mockRestore: () => void } {
  const target = obj as Record<string, (...a: unknown[]) => unknown>;
  const orig = target[name].bind(obj);
  return vi.spyOn(target, name).mockImplementation((p: unknown, ...a: unknown[]) => {
    see(p);
    return orig(p, ...a);
  });
}

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

beforeAll(() => {
  process.env[AGENT_FILES_DIR_ENV] = ROOT;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_COMPANY_FILE;
});

beforeEach(() => {
  process.env[AGENT_FILES_DIR_ENV] = ROOT;
  noLazyClear();
});

afterAll(() => {
  restoreEnv(...ENV_KEYS);
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('staging a file', () => {
  it('round trip: the same bytes, name, type and size; on disk as <fileId>.bin and .json in the owner folder', async () => {
    const bytes = Buffer.from('date,amount\n2026-11-01,12.50\n');
    const file = await stageFile(me, { name: 'November.csv', type: 'text/csv; charset=utf-8', bytes });
    expect(file.fileId).toMatch(/^[0-9a-f]{32}$/);
    expect(file).toEqual({ fileId: file.fileId, name: 'November.csv', type: 'text/csv', size: bytes.length });

    const back = await readStagedFile(me, file.fileId);
    expect(back?.file).toEqual(file);
    expect(Buffer.from(back!.bytes).equals(bytes)).toBe(true);
    expect(await stagedFileInfo(me, file.fileId)).toEqual(file);

    const dir = ownerFolder(me);
    expect(fs.readFileSync(path.join(dir, `${file.fileId}.bin`)).equals(bytes)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${file.fileId}.json`), 'utf8'));
    // The .json names its owner too.
    expect(meta).toEqual({ name: 'November.csv', type: 'text/csv', size: bytes.length, created: expect.any(String), company: COMPANY, agent: AGENT });
    expect(Number.isNaN(Date.parse(meta.created))).toBe(false);
    // Nothing else left behind (no temporary files).
    expect(fs.readdirSync(dir).filter((n) => n.startsWith(file.fileId)).sort()).toEqual([`${file.fileId}.bin`, `${file.fileId}.json`]);
    expect(fs.readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('a type that is not a plain MIME type becomes application/octet-stream; an empty file is fine', async () => {
    const file = await stageFile(me, { name: 'x.bin', type: 'text/html\r\nX-Evil: 1', bytes: new Uint8Array() });
    expect(file.type).toBe('application/octet-stream');
    expect(file.size).toBe(0);
    expect((await readStagedFile(me, file.fileId))?.bytes.byteLength).toBe(0);
  });

  it('refuses a file over UPLOAD_MAX_BYTES with a plain message, and keeps nothing', async () => {
    const before = fs.existsSync(ownerFolder(otherCompany)) ? fs.readdirSync(ownerFolder(otherCompany)).length : 0;
    const err = await refusal(stageFile(otherCompany, { name: 'big.pdf', type: 'application/pdf', bytes: new Uint8Array(UPLOAD_MAX_BYTES + 1) }));
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/at most 50 MB/);
    const after = fs.existsSync(ownerFolder(otherCompany)) ? fs.readdirSync(ownerFolder(otherCompany)).length : 0;
    expect(after).toBe(before);
  });

  it('refuses an owner that is not a plain company and agent id', async () => {
    await refusal(stageFile({ companyId: '../x', agentId: AGENT }, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') }));
    await refusal(stageFile({ companyId: COMPANY, agentId: '' }, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') }));
    expect(fs.existsSync(path.join(ROOT, 'x'))).toBe(false);
    expect(await readStagedFile({ companyId: '..', agentId: '..' }, 'a'.repeat(32))).toBeNull();
  });
});

describe('owners are kept apart', () => {
  it('another agent, or the same agent id in another company, gets null', async () => {
    const file = await stageFile(me, { name: 'mine.txt', type: 'text/plain', bytes: Buffer.from('secret-ish') });
    expect(await readStagedFile(otherAgent, file.fileId)).toBeNull();
    expect(await stagedFileInfo(otherAgent, file.fileId)).toBeNull();
    expect(await readStagedFile(otherCompany, file.fileId)).toBeNull();
    expect(await stagedFileInfo(otherCompany, file.fileId)).toBeNull();
    // The owner still has it.
    expect((await readStagedFile(me, file.fileId))?.file.name).toBe('mine.txt');
  });

  it('an id in capitals (the same file on a Windows disk) is refused', async () => {
    const file = await stageFile(me, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
    expect(await readStagedFile(me, file.fileId.toUpperCase())).toBeNull();
  });
});

describe('path tricks', () => {
  it('a fileId of any other shape answers null before the disk is looked at', async () => {
    const file = await stageFile(me, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
    // A file planted next to the owner folder, to be reached by a path in the id.
    fs.writeFileSync(path.join(ROOT, COMPANY, 'planted.bin'), 'x');
    const tricks = [
      '',
      `../${OTHER_AGENT}/${file.fileId}`,
      `..\\${OTHER_AGENT}\\${file.fileId}`,
      `${file.fileId}.json`,
      `${file.fileId}/`,
      `${file.fileId.slice(0, 31)}`,
      `${file.fileId}0`,
      '../planted',
      `${file.fileId.slice(0, 31)}\u0000`,
      'g'.repeat(32),
      ` ${file.fileId.slice(1)}`,
    ];
    // Every way this module looks at the disk is watched from here on, the lazy clear's included.
    lazyClearDue();
    const disk = watchDisk();
    try {
      for (const id of tricks) {
        expect(await readStagedFile(me, id)).toBeNull();
        expect(await stagedFileInfo(me, id)).toBeNull();
      }
      for (const bad of [null, undefined, 42, { fileId: file.fileId }]) {
        expect(await readStagedFile(me, bad as unknown as string)).toBeNull();
        expect(await stagedFileInfo(me, bad as unknown as string)).toBeNull();
      }
      // A good id from an owner that is no plain company and agent id is not looked for either.
      expect(await readStagedFile({ companyId: '..', agentId: AGENT }, file.fileId)).toBeNull();
      expect(await stagedFileInfo({ companyId: COMPANY, agentId: `${AGENT}/..` }, file.fileId)).toBeNull();
      expect(disk.paths()).toEqual([]);
      // The watch works: a well-formed id is looked for.
      noLazyClear();
      expect((await readStagedFile(me, file.fileId))?.file.name).toBe('a.txt');
      expect(disk.paths().some((p) => p.endsWith(`${file.fileId}.bin`))).toBe(true);
    } finally {
      disk.restore();
      noLazyClear();
    }
  });

  it('an upload with a malformed id, a malformed part or no plain owner is refused before the disk is looked at', async () => {
    const started = await uploadChunk(me, { name: 'u.txt', type: 'text/plain', chunkBase64: b64('u'), last: false });
    lazyClearDue();
    const disk = watchDisk();
    try {
      for (const bad of ['../x', started.uploadId.toUpperCase(), started.uploadId.slice(1), `${started.uploadId}.part`, 42, { id: 1 }]) {
        const err = await refusal(uploadChunk(me, { uploadId: bad as unknown as string, name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
        expect(err.message).toMatch(/no unfinished upload/);
      }
      // A part that is not base64, or too large, is refused before anything is looked at either.
      await refusal(uploadChunk(me, { uploadId: started.uploadId, name: 'x', type: 'text/plain', chunkBase64: 'abc$', last: true }));
      await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: 'A'.repeat(UPLOAD_CHUNK_BYTES * 3), last: true }));
      await refusal(uploadChunk(me, null as never));
      const owner = await refusal(uploadChunk({ companyId: '..', agentId: AGENT }, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
      expect(owner.code).toBe('FORBIDDEN');
      await refusal(stageFile({ companyId: COMPANY, agentId: '../../x' }, { name: 'x', type: 'text/plain', bytes: Buffer.from('x') }));
      expect(disk.paths()).toEqual([]);
    } finally {
      disk.restore();
      noLazyClear();
    }
    // The upload itself carries on.
    const done = await uploadChunk(me, { uploadId: started.uploadId, name: 'u.txt', type: 'text/plain', chunkBase64: b64('p'), last: true });
    expect(done.file?.size).toBe(2);
  });

  it('a .json changed by hand cannot pass on a name or type that is not clean', async () => {
    const file = await stageFile(me, { name: 'plain.txt', type: 'text/plain', bytes: Buffer.from('x') });
    const json = path.join(ownerFolder(me), `${file.fileId}.json`);
    const meta = JSON.parse(fs.readFileSync(json, 'utf8'));
    fs.writeFileSync(json, JSON.stringify({ ...meta, name: '..\\..\\evil\uD800‮.pdf', type: 'text/html\r\nX-Evil: 1' }));
    expect(await stagedFileInfo(me, file.fileId)).toEqual({ fileId: file.fileId, name: 'evil.pdf', type: 'application/octet-stream', size: 1 });
    expect((await readStagedFile(me, file.fileId))?.file.name).toBe('evil.pdf');
  });

  it('names lose path parts, control and direction marks, Windows-reserved characters and device names', async () => {
    const cases: Array<[string, string]> = [
      ['../../evil.pdf', 'evil.pdf'],
      ['..\\..\\Windows\\System32\\drivers\\etc\\hosts', 'hosts'],
      ['C:\\Users\\someone\\Desktop\\receipt.jpg', 'receipt.jpg'],
      ['/etc/passwd', 'passwd'],
      ['invoice\u202Efdp.exe', 'invoicefdp.exe'],
      ['a\u200Eb\u200Fc\u2066d\u2069.txt', 'abcd.txt'],
      ['line\nbreak\t.txt', 'line break .txt'],
      ['bell\u0007\u0000.txt', 'bell.txt'],
      ['what?*<>|"name:x.csv', 'what------name-x.csv'],
      ['con.txt', '_con.txt'],
      ['NUL', '_NUL'],
      ['com1.pdf', '_com1.pdf'],
      ['LPT9', '_LPT9'],
      ['aux .txt', '_aux .txt'],
      ['report. ', 'report'],
      ['...', 'file'],
      ['..', 'file'],
      ['', 'file'],
      ['folder/', 'file'],
      ['   spaced   name.pdf  ', 'spaced name.pdf'],
      ['.hidden', '.hidden'],
      // Half of a character pair, alone, cannot be shown or written as UTF-8; a whole pair stays.
      ['a\uD800b.txt', 'ab.txt'],
      ['\uDC00x\uD83D.txt', 'x.txt'],
      ['😀.txt', '😀.txt'],
    ];
    for (const [raw, want] of cases) {
      const file = await stageFile(me, { name: raw, type: 'text/plain', bytes: Buffer.from('x') });
      expect(file.name, JSON.stringify(raw)).toBe(want);
      // The bytes are always <fileId>.bin, whatever the name was.
      expect(fs.existsSync(path.join(ownerFolder(me), `${file.fileId}.bin`))).toBe(true);
    }
    expect(fs.existsSync(path.join(TMP, 'evil.pdf'))).toBe(false);
    const nonString = await stageFile(me, { name: 42 as unknown as string, type: 'text/plain', bytes: Buffer.from('x') });
    expect(nonString.name).toBe('file');
  });

  it('a long name is cut to 120 characters and keeps its extension', async () => {
    const long = await stageFile(me, { name: `${'a'.repeat(300)}.pdf`, type: 'application/pdf', bytes: Buffer.from('x') });
    expect(long.name).toHaveLength(120);
    expect(long.name.endsWith('.pdf')).toBe(true);
    // Counted in characters: an emoji is never cut in half.
    const emoji = await stageFile(me, { name: `${'😀'.repeat(200)}.xlsx`, type: 'application/octet-stream', bytes: Buffer.from('x') });
    expect(Array.from(emoji.name)).toHaveLength(120);
    expect(emoji.name.endsWith('.xlsx')).toBe(true);
    expect(emoji.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    // A long device name: the "_" in front is counted too.
    const device = await stageFile(me, { name: `con.${'a'.repeat(200)}.pdf`, type: 'application/pdf', bytes: Buffer.from('x') });
    expect(device.name).toHaveLength(120);
    expect(device.name.startsWith('_con.aaa')).toBe(true);
    expect(device.name.endsWith('.pdf')).toBe(true);
    // In characters as well, and with halves of character pairs taken out before the count.
    const wide = await stageFile(me, { name: `LPT1.${'\uD800😀'.repeat(200)}`, type: 'application/octet-stream', bytes: Buffer.from('x') });
    expect(Array.from(wide.name)).toHaveLength(120);
    expect(wide.name.startsWith('_LPT1.😀')).toBe(true);
    expect(wide.name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // Every name kept is at most 120 characters, whatever was sent.
    for (const raw of [`${'x'.repeat(119)}.`, `aux${' '.repeat(5)}.${'b'.repeat(130)}.txt`, `${'é'.normalize('NFD').repeat(130)}.csv`]) {
      const f = await stageFile(me, { name: raw, type: 'text/plain', bytes: Buffer.from('x') });
      expect(Array.from(f.name).length, JSON.stringify(raw)).toBeLessThanOrEqual(120);
    }
  });
});

describe('uploads in parts', () => {
  it('parts add up to the staged file; the last returns it and leaves no part behind', async () => {
    const parts = ['first part, ', 'second part, ', 'last part.'];
    const one = await uploadChunk(me, { name: 'statement.txt', type: 'text/plain', chunkBase64: b64(parts[0]), last: false });
    expect(one.uploadId).toMatch(/^[0-9a-f]{32}$/);
    expect(one).toEqual({ uploadId: one.uploadId, received: parts[0].length, file: null });
    expect(fs.existsSync(path.join(ownerFolder(me), `${one.uploadId}.part`))).toBe(true);

    const two = await uploadChunk(me, { uploadId: one.uploadId, name: 'statement.txt', type: 'text/plain', chunkBase64: b64(parts[1]), last: false });
    expect(two.received).toBe(parts[0].length + parts[1].length);
    expect(two.file).toBeNull();

    // Line breaks in the base64 (MIME style) are fine.
    const lastB64 = b64(parts[2]).replace(/(.{4})/g, '$1\r\n');
    const three = await uploadChunk(me, { uploadId: one.uploadId, name: '../statement.txt', type: 'text/plain', chunkBase64: lastB64, last: true });
    const whole = parts.join('');
    expect(three.received).toBe(whole.length);
    expect(three.file).toEqual({ fileId: expect.stringMatching(/^[0-9a-f]{32}$/), name: 'statement.txt', type: 'text/plain', size: whole.length });
    expect(fs.existsSync(path.join(ownerFolder(me), `${one.uploadId}.part`))).toBe(false);

    const back = await readStagedFile(me, three.file!.fileId);
    expect(Buffer.from(back!.bytes).toString()).toBe(whole);
    // Finished: the id is not an upload any more.
    await refusal(uploadChunk(me, { uploadId: one.uploadId, name: 'x', type: 'text/plain', chunkBase64: b64('more'), last: true }));
  });

  it('one part with last: true is kept at once', async () => {
    const r = await uploadChunk(me, { name: 'one.txt', type: 'text/plain', chunkBase64: b64('all at once'), last: true });
    expect(r.file?.size).toBe(11);
    expect(r.received).toBe(11);
    expect(fs.existsSync(path.join(ownerFolder(me), `${r.uploadId}.part`))).toBe(false);
    expect(Buffer.from((await readStagedFile(me, r.file!.fileId))!.bytes).toString()).toBe('all at once');
  });

  it('a part over UPLOAD_CHUNK_BYTES once decoded is refused', async () => {
    const err = await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: Buffer.alloc(UPLOAD_CHUNK_BYTES + 1).toString('base64'), last: false }));
    expect(err.message).toMatch(/at most 4 MB/);
    // Exactly the limit is fine.
    const ok = await uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: Buffer.alloc(UPLOAD_CHUNK_BYTES).toString('base64'), last: true });
    expect(ok.file?.size).toBe(UPLOAD_CHUNK_BYTES);
  });

  it('parts that come to more than UPLOAD_MAX_BYTES stop the upload', async () => {
    const start = await uploadChunk(otherAgent, { name: 'big.bin', type: 'application/octet-stream', chunkBase64: b64('abc'), last: false });
    const part = path.join(ownerFolder(otherAgent), `${start.uploadId}.part`);
    // As if the agent had already sent almost 50 MB.
    fs.truncateSync(part, UPLOAD_MAX_BYTES - 5);
    const err = await refusal(uploadChunk(otherAgent, { uploadId: start.uploadId, name: 'big.bin', type: 'application/octet-stream', chunkBase64: b64('123456'), last: true }));
    expect(err.message).toMatch(/stopped/);
    expect(fs.existsSync(part)).toBe(false);
    await refusal(uploadChunk(otherAgent, { uploadId: start.uploadId, name: 'big.bin', type: 'application/octet-stream', chunkBase64: b64('1'), last: true }));
  });

  it('exactly UPLOAD_MAX_BYTES in all is accepted', async () => {
    const start = await uploadChunk(otherAgent, { name: 'edge.bin', type: 'application/octet-stream', chunkBase64: b64('abc'), last: false });
    fs.truncateSync(path.join(ownerFolder(otherAgent), `${start.uploadId}.part`), UPLOAD_MAX_BYTES - 5);
    const done = await uploadChunk(otherAgent, { uploadId: start.uploadId, name: 'edge.bin', type: 'application/octet-stream', chunkBase64: b64('12345'), last: true });
    expect(done.file?.size).toBe(UPLOAD_MAX_BYTES);
    fs.rmSync(path.join(ownerFolder(otherAgent), `${done.file!.fileId}.bin`));
  });

  it('bad base64 is refused', async () => {
    for (const bad of ['abc$', 'abcde', '=abc', 'ab=c', 'A===', '-_-_', 42 as unknown as string]) {
      const err = await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: bad, last: true }));
      expect(err.code).toBe('VALIDATION');
    }
    // Unpadded base64 is still base64.
    const r = await uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: 'aGk', last: true });
    expect(Buffer.from((await readStagedFile(me, r.file!.fileId))!.bytes).toString()).toBe('hi');
  });

  it('an unknown, malformed or other agent’s uploadId is refused, and the owner’s upload carries on', async () => {
    const mine = await uploadChunk(me, { name: 'mine.txt', type: 'text/plain', chunkBase64: b64('mine '), last: false });
    const unknown = await refusal(uploadChunk(me, { uploadId: 'f'.repeat(32), name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
    expect(unknown.message).toMatch(/no unfinished upload/);
    for (const bad of ['../x', `${mine.uploadId}.part`, mine.uploadId.toUpperCase(), `..\\${OTHER_AGENT}\\${mine.uploadId}`]) {
      await refusal(uploadChunk(me, { uploadId: bad, name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
    }
    // Another agent, and the same agent id in another company, cannot add to it or finish it.
    await refusal(uploadChunk(otherAgent, { uploadId: mine.uploadId, name: 'x', type: 'text/plain', chunkBase64: b64('evil'), last: true }));
    await refusal(uploadChunk(otherCompany, { uploadId: mine.uploadId, name: 'x', type: 'text/plain', chunkBase64: b64('evil'), last: true }));
    const done = await uploadChunk(me, { uploadId: mine.uploadId, name: 'mine.txt', type: 'text/plain', chunkBase64: b64('upload'), last: true });
    expect(Buffer.from((await readStagedFile(me, done.file!.fileId))!.bytes).toString()).toBe('mine upload');
  });

  it('at most 5 unfinished uploads per agent; finishing one frees a place', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await uploadChunk(owner, { name: `p${i}`, type: 'text/plain', chunkBase64: b64(`part ${i}`), last: false })).uploadId);
    const err = await refusal(uploadChunk(owner, { name: 'p6', type: 'text/plain', chunkBase64: b64('six'), last: false }));
    expect(err.message).toMatch(/5 unfinished uploads/);
    // Other agents are not affected, and a single-part upload needs no place.
    await uploadChunk(otherAgent, { name: 'p', type: 'text/plain', chunkBase64: b64('x'), last: false });
    await uploadChunk(owner, { name: 'whole', type: 'text/plain', chunkBase64: b64('whole'), last: true });
    await uploadChunk(owner, { uploadId: ids[0], name: 'p0', type: 'text/plain', chunkBase64: b64(' end'), last: true });
    const sixth = await uploadChunk(owner, { name: 'p6', type: 'text/plain', chunkBase64: b64('six'), last: false });
    expect(sixth.file).toBeNull();
    // An upload older than a day no longer holds a place (and is gone).
    age(path.join(path.join(ROOT, owner.companyId, owner.agentId), `${ids[1]}.part`), STAGED_FILE_HOURS + 1);
    await uploadChunk(owner, { name: 'p7', type: 'text/plain', chunkBase64: b64('seven'), last: false });
    await refusal(uploadChunk(owner, { uploadId: ids[1], name: 'p1', type: 'text/plain', chunkBase64: b64('late'), last: true }));
  });

  it('parts sent at the same time are appended one after the other', async () => {
    const start = await uploadChunk(me, { name: 'together.bin', type: 'application/octet-stream', chunkBase64: b64('0'), last: false });
    const sends = Array.from({ length: 8 }, (_, i) =>
      uploadChunk(me, { uploadId: start.uploadId, name: 'together.bin', type: 'application/octet-stream', chunkBase64: b64(String(i + 1).repeat(100)), last: false }),
    );
    const results = await Promise.all(sends);
    expect(results.map((r) => r.received).sort((a, b) => a - b)).toEqual(Array.from({ length: 8 }, (_, i) => 1 + 100 * (i + 1)));
    const done = await uploadChunk(me, { uploadId: start.uploadId, name: 'together.bin', type: 'application/octet-stream', chunkBase64: '', last: true });
    expect(done.file?.size).toBe(801);
  });
});

describe('limits per agent', () => {
  const limitsRoot = path.join(TMP, 'limits');
  /** Most one agent may keep at once (lib/agent/files.ts AGENT_MAX_BYTES, AGENT_MAX_FILES). */
  const MAX_BYTES = 500 * MB;
  const MAX_FILES = 1000;

  beforeEach(() => {
    process.env[AGENT_FILES_DIR_ENV] = limitsRoot;
  });

  it('the limits are the constants: 500 MB and 1000 files per agent; room is made with remove_file', () => {
    expect(AGENT_MAX_BYTES).toBe(MAX_BYTES);
    expect(AGENT_MAX_FILES).toBe(MAX_FILES);
    expect(REMOVE_FILE_VERB).toBe('remove_file');
  });

  it('one agent keeps at most 500 MB at once, uploads included; other agents are not affected; expired files stop counting', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const up = await uploadChunk(owner, { name: 'u.bin', type: 'application/octet-stream', chunkBase64: b64('u'), last: false });
    try {
      // As if the agent kept almost 500 MB: 1 byte of upload, the rest in ten files of at most
      // 50 MB each, every one a file a read would return; 5 bytes still fit.
      const bins = plantSized(dir, owner, [...Array<number>(9).fill(UPLOAD_MAX_BYTES), UPLOAD_MAX_BYTES - 6]);
      expect(10 * UPLOAD_MAX_BYTES).toBe(MAX_BYTES);
      expect((await stagedFileInfo(owner, path.basename(bins[9], '.bin')))?.size).toBe(UPLOAD_MAX_BYTES - 6);
      const err = await refusal(uploadChunk(owner, { uploadId: up.uploadId, name: 'u.bin', type: 'application/octet-stream', chunkBase64: b64('123456'), last: false }));
      expect(err.code).toBe('VALIDATION');
      expect(err.message).toMatch(/500 MB/);
      // Not full yet: it says how much room is left, and how much this needs.
      expect(err.message).toMatch(/There is not room for this here\. This agent keeps 499 MB of the 500 MB one agent may keep at once, which leaves room for 5 bytes, and this needs 6 bytes\./);
      expect(err.message).not.toMatch(/already keeps/);
      // Plain words that say what to do next: wait (and how long), or ask a person. Never a verb
      // the door does not have (remove_file, until it is one of AGENT_VERBS).
      expect(err.message).toMatch(/To make room, wait for older ones to be cleared/);
      expect(err.message).toMatch(/the oldest in about 24 hours/);
      expect(err.message).toMatch(/ask a person/);
      expect(err.message).not.toMatch(/remove_file/);
      // The upload is not stopped by that: a smaller part still fits.
      expect(fs.existsSync(path.join(dir, `${up.uploadId}.part`))).toBe(true);
      const done = await uploadChunk(owner, { uploadId: up.uploadId, name: 'u.bin', type: 'application/octet-stream', chunkBase64: b64('12345'), last: true });
      expect(done.file?.size).toBe(6);

      // Full now: nothing more, in any way, and it says it is full.
      const full = await refusal(stageFile(owner, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
      expect(full.message).toMatch(/^This agent already keeps as much here as one agent may at once \(500 MB\)\. To make room, /);
      await refusal(uploadChunk(owner, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
      await refusal(uploadChunk(owner, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
      // Another agent is not affected.
      expect((await stageFile(otherAgent, { name: 'y.txt', type: 'text/plain', bytes: Buffer.from('y') })).size).toBe(1);
      // A file older than a day no longer counts, and is gone once the agent adds one.
      age(bins[0], STAGED_FILE_HOURS + 1);
      expect((await stageFile(owner, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') })).size).toBe(1);
      expect(fs.existsSync(bins[0])).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only what a read would return holds room: an entry no read returns is not counted, and is removed (only its name, for a second name)', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: '9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const outside = path.join(TMP, 'limits-outside.txt');
    fs.writeFileSync(outside, 'p');
    try {
      await stageFile(owner, { name: 'first.txt', type: 'text/plain', bytes: Buffer.from('1') });
      plantStaged(dir, owner, MAX_FILES - 1);
      await refusal(stageFile(owner, { name: 'full.txt', type: 'text/plain', bytes: Buffer.from('f') }));
      // Four of the planted files spoiled, each in a way a read refuses (findStaged).
      const at = (i: number, ext: string) => path.join(dir, `${i.toString(16).padStart(32, '0')}.${ext}`);
      const meta = (i: number) => JSON.parse(fs.readFileSync(at(i, 'json'), 'utf8')) as Record<string, unknown>;
      // 1: a .json that names no owner (as an older Ironbooks wrote it).
      const { company: _c, agent: _a, ...ownerless } = meta(1);
      fs.writeFileSync(at(1, 'json'), JSON.stringify(ownerless));
      // 2: copied from another agent's folder (its .json names that agent).
      fs.writeFileSync(at(2, 'json'), JSON.stringify({ ...meta(2), agent: OTHER_AGENT }));
      // 3: a .bin that is not the size its .json says.
      fs.writeFileSync(at(3, 'bin'), 'longer than one byte');
      // 4: a second name (a hard link) for a file kept elsewhere.
      fs.rmSync(at(4, 'bin'));
      fs.linkSync(outside, at(4, 'bin'));
      for (const i of [1, 2, 3, 4]) expect(await stagedFileInfo(owner, i.toString(16).padStart(32, '0')), String(i)).toBeNull();
      // Their room is free: four more fit, and a fifth does not.
      for (let n = 0; n < 4; n++) expect((await stageFile(owner, { name: `more${n}.txt`, type: 'text/plain', bytes: Buffer.from('m') })).size).toBe(1);
      expect((await refusal(stageFile(owner, { name: 'fifth.txt', type: 'text/plain', bytes: Buffer.from('m') }))).message).toMatch(/1000 files/);
      // And they are gone from the disk; the file the second name led to is untouched.
      for (const i of [1, 2, 3, 4]) for (const ext of ['bin', 'json']) expect(fs.existsSync(at(i, ext)), `${i}.${ext}`).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('p');
      expect(fs.statSync(outside).nlink).toBe(1);
      // An upload that is a second name for another file can never be finished: it holds no place.
      fs.rmSync(dir, { recursive: true, force: true });
      const ups: string[] = [];
      for (let i = 0; i < 5; i++) ups.push((await uploadChunk(owner, { name: `u${i}`, type: 'text/plain', chunkBase64: b64('u'), last: false })).uploadId);
      const part = path.join(dir, `${ups[0]}.part`);
      fs.rmSync(part);
      fs.linkSync(outside, part);
      expect((await uploadChunk(owner, { name: 'u5', type: 'text/plain', chunkBase64: b64('u'), last: false })).file).toBeNull();
      expect(fs.existsSync(part)).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('p');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it('one agent keeps at most 1000 files at once', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const first = await stageFile(owner, { name: 'first.txt', type: 'text/plain', bytes: Buffer.from('1') });
    // As if it had staged 999 more.
    plantStaged(dir, owner, MAX_FILES - 1);
    const err = await refusal(stageFile(owner, { name: 'one-more.txt', type: 'text/plain', bytes: Buffer.from('x') }));
    expect(err.message).toMatch(/1000 files/);
    expect(err.message).toMatch(/If it cannot wait, ask a person for help\./);
    // Once the door has the verb to remove files, the refusal says to use it.
    await withRemoveVerb(async () => {
      const said = (await refusal(stageFile(owner, { name: 'one-more.txt', type: 'text/plain', bytes: Buffer.from('x') }))).message;
      expect(said).toMatch(/To make room, remove the files it no longer needs \(remove_file with their file id\), or wait for older ones to be cleared/);
    });
    await refusal(uploadChunk(owner, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
    age(path.join(dir, `${first.fileId}.bin`), STAGED_FILE_HOURS + 1);
    expect((await stageFile(owner, { name: 'one-more.txt', type: 'text/plain', bytes: Buffer.from('x') })).size).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removing a file frees its room at once; an id of another shape or another agent’s removes nothing', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: '12121212-1212-4121-8121-121212121212' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const mine = await stageFile(owner, { name: 'keep-or-go.txt', type: 'text/plain', bytes: Buffer.from('k') });
    plantStaged(dir, owner, MAX_FILES - 1);
    await refusal(stageFile(owner, { name: 'more.txt', type: 'text/plain', bytes: Buffer.from('m') }));
    // Another agent's file with the same shape of id is never reached, and stays.
    const theirs = await stageFile(otherAgent, { name: 'theirs.txt', type: 'text/plain', bytes: Buffer.from('t') });
    expect(await removeStagedFile(owner, theirs.fileId)).toBe(false);
    expect(await readStagedFile(otherAgent, theirs.fileId)).not.toBeNull();
    // A malformed id is answered before the disk is looked at.
    const disk = watchDisk();
    try {
      for (const bad of ['', '../x', mine.fileId.toUpperCase(), `${mine.fileId}.bin`, 42, null]) expect(await removeStagedFile(owner, bad as unknown as string)).toBe(false);
      expect(await removeStagedFile({ companyId: '..', agentId: owner.agentId }, mine.fileId)).toBe(false);
      expect(disk.paths()).toEqual([]);
    } finally {
      disk.restore();
    }
    expect(await removeStagedFile(owner, mine.fileId)).toBe(true);
    expect(await readStagedFile(owner, mine.fileId)).toBeNull();
    expect(fs.existsSync(path.join(dir, `${mine.fileId}.bin`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${mine.fileId}.json`))).toBe(false);
    expect(await removeStagedFile(owner, mine.fileId)).toBe(false);
    // The room is there again at once.
    expect((await stageFile(owner, { name: 'more.txt', type: 'text/plain', bytes: Buffer.from('m') })).size).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stopping an unfinished upload frees its place, and the refusal for too many says how', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: '34343434-3434-4343-8343-343434343434' };
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await uploadChunk(owner, { name: `p${i}`, type: 'text/plain', chunkBase64: b64(`part ${i}`), last: false })).uploadId);
    const err = await refusal(uploadChunk(owner, { name: 'p6', type: 'text/plain', chunkBase64: b64('six'), last: false }));
    expect(err.message).toMatch(/Finish one of them \(send its last part\), then start again\./);
    expect(err.message).toMatch(/24 hours after its last part/);
    expect(err.message).not.toMatch(/remove_file/);
    await withRemoveVerb(async () => {
      const said = (await refusal(uploadChunk(owner, { name: 'p6', type: 'text/plain', chunkBase64: b64('six'), last: false }))).message;
      expect(said).toMatch(/Finish one of them \(send its last part\), or stop one it no longer needs \(remove_file with its upload id\), then start again\./);
    });
    expect(await removeStagedFile(owner, ids[2])).toBe(true);
    expect((await uploadChunk(owner, { name: 'p6', type: 'text/plain', chunkBase64: b64('six'), last: false })).file).toBeNull();
    // A stopped upload cannot be carried on.
    await refusal(uploadChunk(owner, { uploadId: ids[2], name: 'p2', type: 'text/plain', chunkBase64: b64('late'), last: true }));
  });

  it('expiry frees the room as a read judges it (the .json’s own time too), and what expired is removed when the agent next adds a file', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: '56565656-5656-4565-8565-565656565656' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const old = await stageFile(owner, { name: 'old.txt', type: 'text/plain', bytes: Buffer.from('o') });
    plantStaged(dir, owner, MAX_FILES - 1);
    await refusal(stageFile(owner, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
    // Its .json says it was made more than a day ago (the disk's times say now): a read finds no
    // file, so it holds no room either.
    const json = path.join(dir, `${old.fileId}.json`);
    fs.writeFileSync(json, JSON.stringify({ ...JSON.parse(fs.readFileSync(json, 'utf8')), created: new Date(Date.now() - (STAGED_FILE_HOURS + 1) * 3600_000).toISOString() }));
    expect(await readStagedFile(owner, old.fileId)).toBeNull();
    const fresh = await stageFile(owner, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') });
    expect(fresh.size).toBe(1);
    // And it is gone from the disk, not merely no longer counted.
    expect(fs.existsSync(path.join(dir, `${old.fileId}.bin`))).toBe(false);
    expect(fs.existsSync(json)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('half a staged file (a crash between its two halves) holds no room and is removed', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: '78787878-7878-4787-8787-787878787878' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const first = await stageFile(owner, { name: 'whole.txt', type: 'text/plain', bytes: Buffer.from('w') });
    // 999 .bin files without their .json, as if each write had stopped half way.
    for (let i = 1; i < MAX_FILES; i++) fs.writeFileSync(path.join(dir, `${i.toString(16).padStart(32, '0')}.bin`), 'half');
    const lonelyJson = path.join(dir, `${'e'.repeat(32)}.json`);
    fs.writeFileSync(lonelyJson, fs.readFileSync(path.join(dir, `${first.fileId}.json`)));
    // Not ours at all (a folder, a name of another shape): left alone.
    const strangers = [path.join(dir, `${'d'.repeat(32)}.bin`), path.join(dir, 'notes.txt')];
    fs.mkdirSync(strangers[0]);
    fs.writeFileSync(strangers[1], 'not ours');
    expect((await stageFile(owner, { name: 'more.txt', type: 'text/plain', bytes: Buffer.from('m') })).size).toBe(1);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.bin') && n !== `${'d'.repeat(32)}.bin`)).toHaveLength(2);
    expect(fs.existsSync(lonelyJson)).toBe(false);
    for (const s of strangers) expect(fs.existsSync(s), s).toBe(true);
    expect((await readStagedFile(owner, first.fileId))?.file.name).toBe('whole.txt');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('clearing', () => {
  const clearRoot = path.join(TMP, 'clearing');

  beforeEach(() => {
    process.env[AGENT_FILES_DIR_ENV] = clearRoot;
  });

  it('removes files and unfinished uploads older than STAGED_FILE_HOURS, keeps newer ones, and old files read as null', async () => {
    const oldFile = await stageFile(me, { name: 'old.txt', type: 'text/plain', bytes: Buffer.from('old') });
    const newFile = await stageFile(me, { name: 'new.txt', type: 'text/plain', bytes: Buffer.from('new') });
    const oldUpload = await uploadChunk(otherAgent, { name: 'u', type: 'text/plain', chunkBase64: b64('u'), last: false });
    const newUpload = await uploadChunk(otherAgent, { name: 'u', type: 'text/plain', chunkBase64: b64('u'), last: false });
    const dir = path.join(clearRoot, COMPANY, AGENT);
    age(path.join(dir, `${oldFile.fileId}.bin`), STAGED_FILE_HOURS + 1);
    age(path.join(clearRoot, COMPANY, OTHER_AGENT, `${oldUpload.uploadId}.part`), STAGED_FILE_HOURS + 1);

    // Expired already reads as gone, before any clearing.
    expect(await readStagedFile(me, oldFile.fileId)).toBeNull();
    expect(await stagedFileInfo(me, oldFile.fileId)).toBeNull();

    expect(await clearStagedFiles()).toBe(2);
    expect(fs.existsSync(path.join(dir, `${oldFile.fileId}.bin`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${oldFile.fileId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(clearRoot, COMPANY, OTHER_AGENT, `${oldUpload.uploadId}.part`))).toBe(false);
    expect((await readStagedFile(me, newFile.fileId))?.file.name).toBe('new.txt');
    expect(fs.existsSync(path.join(clearRoot, COMPANY, OTHER_AGENT, `${newUpload.uploadId}.part`))).toBe(true);
  });

  it('the created time in the .json counts too, and a .json older than its bytes cannot keep them', async () => {
    const f = await stageFile(me, { name: 'meta-old.txt', type: 'text/plain', bytes: Buffer.from('x') });
    const json = path.join(clearRoot, COMPANY, AGENT, `${f.fileId}.json`);
    const meta = JSON.parse(fs.readFileSync(json, 'utf8'));
    meta.created = new Date(Date.now() - (STAGED_FILE_HOURS + 2) * 3600_000).toISOString();
    fs.writeFileSync(json, JSON.stringify(meta));
    expect(await readStagedFile(me, f.fileId)).toBeNull();
    expect(await clearStagedFiles()).toBe(1);
  });

  it('{ all: true } removes everything, and empty folders go too', async () => {
    await stageFile(me, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
    await stageFile(otherCompany, { name: 'b.txt', type: 'text/plain', bytes: Buffer.from('b') });
    await uploadChunk(otherAgent, { name: 'c', type: 'text/plain', chunkBase64: b64('c'), last: false });
    const n = await clearStagedFiles({ all: true });
    expect(n).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(clearRoot)).toBe(false);
  });

  it('leaves alone what it did not make', async () => {
    await stageFile(me, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
    const stranger = path.join(clearRoot, COMPANY, AGENT, 'notes.txt');
    fs.writeFileSync(stranger, 'not ours');
    await clearStagedFiles({ all: true });
    expect(fs.readFileSync(stranger, 'utf8')).toBe('not ours');
    fs.rmSync(clearRoot, { recursive: true, force: true });
  });

  it('a folder that does not exist is fine', async () => {
    process.env[AGENT_FILES_DIR_ENV] = path.join(TMP, 'never-made');
    expect(await clearStagedFiles()).toBe(0);
    expect(await clearStagedFiles({ all: true })).toBe(0);
    expect(fs.existsSync(path.join(TMP, 'never-made'))).toBe(false);
  });

  it('stageFile and uploadChunk clear old files by themselves, at most once an hour', async () => {
    const old = await stageFile(me, { name: 'stale.txt', type: 'text/plain', bytes: Buffer.from('stale') });
    const bin = path.join(clearRoot, COMPANY, AGENT, `${old.fileId}.bin`);
    age(bin, STAGED_FILE_HOURS + 1);
    lazyClearDue();
    await stageFile(otherAgent, { name: 'fresh.txt', type: 'text/plain', bytes: Buffer.from('fresh') });
    expect(fs.existsSync(bin)).toBe(false);

    // Within the hour it does not run again.
    const again = await stageFile(me, { name: 'stale2.txt', type: 'text/plain', bytes: Buffer.from('stale') });
    const bin2 = path.join(clearRoot, COMPANY, AGENT, `${again.fileId}.bin`);
    age(bin2, STAGED_FILE_HOURS + 1);
    await uploadChunk(otherAgent, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true });
    expect(fs.existsSync(bin2)).toBe(true);
    lazyClearDue();
    await uploadChunk(otherAgent, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true });
    expect(fs.existsSync(bin2)).toBe(false);
  });

  it('reading a file, or asking about one, clears old files too', async () => {
    const fresh = await stageFile(otherAgent, { name: 'fresh.txt', type: 'text/plain', bytes: Buffer.from('fresh') });
    for (const look of [readStagedFile, stagedFileInfo]) {
      const old = await stageFile(me, { name: 'stale.txt', type: 'text/plain', bytes: Buffer.from('stale') });
      const bin = path.join(clearRoot, COMPANY, AGENT, `${old.fileId}.bin`);
      age(bin, STAGED_FILE_HOURS + 1);
      lazyClearDue();
      expect(await look(otherAgent, fresh.fileId)).not.toBeNull();
      expect(fs.existsSync(bin)).toBe(false);
    }
  });

  it('removing a file clears old files too, as every call that takes an id does', async () => {
    const old = await stageFile(me, { name: 'stale.txt', type: 'text/plain', bytes: Buffer.from('stale') });
    const bin = path.join(clearRoot, COMPANY, AGENT, `${old.fileId}.bin`);
    age(bin, STAGED_FILE_HOURS + 1);
    const goes = await stageFile(otherAgent, { name: 'goes.txt', type: 'text/plain', bytes: Buffer.from('goes') });
    lazyClearDue();
    expect(await removeStagedFile(otherAgent, goes.fileId)).toBe(true);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it('a full clear at the same time as staging and uploads never makes them fail', async () => {
    const owners: FileOwner[] = [me, otherAgent, otherCompany];
    for (let round = 0; round < 25; round++) {
      const results = await Promise.allSettled([
        ...owners.map((o) => stageFile(o, { name: 'r.txt', type: 'text/plain', bytes: Buffer.from(`round ${round}`) })),
        ...owners.map((o) => uploadChunk(o, { name: 'u', type: 'text/plain', chunkBase64: b64('u'), last: false })),
        clearStagedFiles({ all: true }),
        ...owners.map((o) => uploadChunk(o, { name: 'w', type: 'text/plain', chunkBase64: b64('whole'), last: true })),
      ]);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      await clearStagedFiles({ all: true });
    }
    expect(fs.existsSync(clearRoot)).toBe(false);
  });

  it('a full clear already going: files staged meanwhile wait for it, and are kept', async () => {
    const before = await stageFile(me, { name: 'before.txt', type: 'text/plain', bytes: Buffer.from('before') });
    // Hold the clear at its first look into the root.
    const reached = gate();
    const held = gate();
    const readdir = fsp.readdir.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
    let holding = true;
    const spy = vi.spyOn(fsp, 'readdir').mockImplementation((async (...a: unknown[]) => {
      if (holding && String(a[0]) === clearRoot && (a[1] as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        holding = false;
        reached.open();
        await held.wait;
      }
      return readdir(...a);
    }) as never);
    try {
      const clearing = clearStagedFiles({ all: true });
      await reached.wait;
      const during = Promise.all([
        stageFile(me, { name: 'during.txt', type: 'text/plain', bytes: Buffer.from('during') }),
        stageFile(otherCompany, { name: 'other.txt', type: 'text/plain', bytes: Buffer.from('other') }),
        uploadChunk(otherAgent, { name: 'whole.txt', type: 'text/plain', chunkBase64: b64('whole'), last: true }),
      ]);
      await sleep(50);
      // Nothing new on the disk while the clear goes: the writes wait in the gate.
      expect(fs.readdirSync(path.join(clearRoot, COMPANY, AGENT)).filter((n) => !n.startsWith(before.fileId) && n !== MARKER)).toEqual([]);
      expect(fs.existsSync(path.join(clearRoot, OTHER_COMPANY))).toBe(false);
      held.open();
      expect(await clearing).toBe(1);
      const [a, b, c] = await during;
      expect(Buffer.from((await readStagedFile(me, a.fileId))!.bytes).toString()).toBe('during');
      expect(Buffer.from((await readStagedFile(otherCompany, b.fileId))!.bytes).toString()).toBe('other');
      expect(Buffer.from((await readStagedFile(otherAgent, c.file!.fileId))!.bytes).toString()).toBe('whole');
      expect(await readStagedFile(me, before.fileId)).toBeNull();
    } finally {
      held.open();
      spy.mockRestore();
      await clearStagedFiles({ all: true });
    }
  });

  it('a full clear asked for while a file is being written waits for the write, which never fails', async () => {
    await stageFile(otherAgent, { name: 'first.txt', type: 'text/plain', bytes: Buffer.from('first') });
    const reached = gate();
    const held = gate();
    const writeFile = fsp.writeFile.bind(fsp) as (...a: unknown[]) => Promise<void>;
    let holding = true;
    const spy = vi.spyOn(fsp, 'writeFile').mockImplementation((async (...a: unknown[]) => {
      if (holding && String(a[0]).startsWith(path.join(clearRoot, COMPANY, AGENT)) && String(a[0]).endsWith('.tmp')) {
        holding = false;
        reached.open();
        await held.wait;
      }
      return writeFile(...a);
    }) as never);
    try {
      const staging = stageFile(me, { name: 'slow.txt', type: 'text/plain', bytes: Buffer.from('slow') });
      await reached.wait;
      let cleared = false;
      const clearing = clearStagedFiles({ all: true }).then((n) => {
        cleared = true;
        return n;
      });
      await sleep(50);
      expect(cleared).toBe(false);
      held.open();
      const file = await staging;
      expect(file.size).toBe(4);
      // The clear ran after the write: everything there was then, the new file included, went.
      expect(await clearing).toBe(2);
      expect(await readStagedFile(me, file.fileId)).toBeNull();
      expect(fs.existsSync(clearRoot)).toBe(false);
    } finally {
      held.open();
      spy.mockRestore();
    }
  });

  it('every folder it makes is marked, and only marked folders are cleared or removed', async () => {
    const f = await stageFile(me, { name: 'a.txt', type: 'text/plain', bytes: Buffer.from('a') });
    for (const d of [clearRoot, path.join(clearRoot, COMPANY), ownerFolder(me).replace(ROOT, clearRoot)]) {
      expect(fs.statSync(path.join(d, MARKER)).isFile(), d).toBe(true);
    }
    // Folders named like ids, or like the database's own, that this module did not make.
    const strangers = [
      path.join(clearRoot, 'pg_tblspc'),
      path.join(clearRoot, OTHER_COMPANY, OTHER_AGENT),
      path.join(clearRoot, COMPANY, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    ];
    for (const d of strangers) fs.mkdirSync(d, { recursive: true });
    // An old file with a staged file's name, in a folder that is not marked, is not touched either.
    const lookalike = path.join(clearRoot, OTHER_COMPANY, OTHER_AGENT, `${'e'.repeat(32)}.bin`);
    fs.writeFileSync(lookalike, 'not ours');
    age(lookalike, STAGED_FILE_HOURS + 5);
    expect(await clearStagedFiles({ all: true })).toBe(1);
    expect(await readStagedFile(me, f.fileId)).toBeNull();
    for (const d of strangers) expect(fs.existsSync(d), d).toBe(true);
    expect(fs.readFileSync(lookalike, 'utf8')).toBe('not ours');
    // The marked folders that held nothing else went; the ones that hold strangers stay, still marked.
    expect(fs.existsSync(ownerFolder(me).replace(ROOT, clearRoot))).toBe(false);
    expect(fs.existsSync(path.join(clearRoot, COMPANY, MARKER))).toBe(true);
    expect(fs.existsSync(path.join(clearRoot, MARKER))).toBe(true);
    fs.rmSync(clearRoot, { recursive: true, force: true });
  });

  it('a folder Ironbooks did not make is never cleared, and one that already holds things is not used', async () => {
    const foreign = path.join(TMP, 'foreign');
    for (const d of [path.join('Taxes', '2024'), 'pg_tblspc', path.join(COMPANY, AGENT)]) fs.mkdirSync(path.join(foreign, d), { recursive: true });
    process.env[AGENT_FILES_DIR_ENV] = foreign;
    expect(await clearStagedFiles({ all: true })).toBe(0);
    expect(await clearStagedFiles()).toBe(0);
    const err = await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
    expect(err.code).toBe('INTERNAL');
    await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
    await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
    // Untouched: its empty folders are all still there, and it was not marked.
    for (const d of [path.join('Taxes', '2024'), 'pg_tblspc', path.join(COMPANY, AGENT)]) expect(fs.existsSync(path.join(foreign, d))).toBe(true);
    expect(fs.readdirSync(foreign).sort()).toEqual([COMPANY, 'Taxes', 'pg_tblspc'].sort());

    // An empty folder is taken over (marked), and goes again once it is empty.
    const empty = path.join(TMP, 'empty-root');
    fs.mkdirSync(empty);
    process.env[AGENT_FILES_DIR_ENV] = empty;
    await stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') });
    expect(fs.existsSync(path.join(empty, MARKER))).toBe(true);
    expect(await clearStagedFiles({ all: true })).toBe(1);
    expect(fs.existsSync(empty)).toBe(false);
  });
});

describe('as an attacker: attach, get and save', () => {
  const attackRoot = path.join(TMP, 'attack');
  const dirOf = (o: FileOwner) => path.join(attackRoot, o.companyId, o.agentId);

  beforeEach(() => {
    process.env[AGENT_FILES_DIR_ENV] = attackRoot;
  });

  /** Run `swap` once, just before lib/agent/files.ts opens `target`, then let the open go on. */
  function beforeOpen(target: string, swap: () => void): { mockRestore: () => void } {
    const open = fsp.open.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
    let done = false;
    return vi.spyOn(fsp, 'open').mockImplementation((async (p: unknown, ...a: unknown[]) => {
      if (!done && String(p) === target) {
        done = true;
        swap();
      }
      return open(p, ...a);
    }) as never);
  }

  /** Remove a directory link (a junction on Windows) without touching what it leads to. */
  function unlinkDir(p: string): void {
    try {
      fs.unlinkSync(p);
    } catch {
      fs.rmdirSync(p);
    }
  }

  it('a .bin swapped for another file between the check and the read is refused: another file, or a second name for one', async () => {
    const secret = path.join(TMP, 'attack-secret.txt');
    fs.writeFileSync(secret, 'SECRET');
    for (const how of ['another file', 'a second name'] as const) {
      // The same size as the secret, so only the file itself can tell them apart.
      const f = await stageFile(me, { name: 'mine.txt', type: 'text/plain', bytes: Buffer.from('mine!!') });
      const bin = path.join(dirOf(me), `${f.fileId}.bin`);
      const spy = beforeOpen(bin, () => {
        fs.rmSync(bin);
        if (how === 'a second name') fs.linkSync(secret, bin);
        else fs.writeFileSync(bin, 'SECRET');
      });
      try {
        expect(await readStagedFile(me, f.fileId), how).toBeNull();
      } finally {
        spy.mockRestore();
      }
    }
    expect(fs.readFileSync(secret, 'utf8')).toBe('SECRET');
  });

  it('a second name (a hard link) or a link planted at a .bin is no file, for the bytes or the facts', async () => {
    const secret = path.join(TMP, 'attack-secret-2.txt');
    fs.writeFileSync(secret, 'SECRET');
    const f = await stageFile(me, { name: 'mine.txt', type: 'text/plain', bytes: Buffer.from('mine!!') });
    const bin = path.join(dirOf(me), `${f.fileId}.bin`);
    fs.rmSync(bin);
    fs.linkSync(secret, bin);
    expect(await stagedFileInfo(me, f.fileId)).toBeNull();
    expect(await readStagedFile(me, f.fileId)).toBeNull();
    fs.rmSync(bin);
    let symlinked = true;
    try {
      fs.symlinkSync(secret, bin, 'file');
    } catch {
      symlinked = false; // this computer lets no one make one: nothing more to prove
    }
    if (symlinked) {
      expect(await stagedFileInfo(me, f.fileId)).toBeNull();
      expect(await readStagedFile(me, f.fileId)).toBeNull();
    }
    expect(fs.readFileSync(secret, 'utf8')).toBe('SECRET');
  });

  it('a file that grows while it is read is refused, and is never read past its size', async () => {
    // Grown by the time it is opened.
    const f = await stageFile(me, { name: 'grows.bin', type: 'application/octet-stream', bytes: Buffer.from('abc') });
    const bin = path.join(dirOf(me), `${f.fileId}.bin`);
    const open = fsp.open.bind(fsp) as (...a: unknown[]) => Promise<FileHandleLike>;
    let spy = vi.spyOn(fsp, 'open').mockImplementation((async (p: unknown, ...a: unknown[]) => {
      const h = await open(p, ...a);
      if (String(p) === bin) fs.appendFileSync(bin, Buffer.alloc(5 * MB));
      return h;
    }) as never);
    try {
      expect(await readStagedFile(me, f.fileId)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    // Growing while it is read: past UPLOAD_MAX_BYTES, and still never read on.
    const g = await stageFile(me, { name: 'grows-later.bin', type: 'application/octet-stream', bytes: Buffer.from('abcdef') });
    const gBin = path.join(dirOf(me), `${g.fileId}.bin`);
    let read = 0;
    spy = vi.spyOn(fsp, 'open').mockImplementation((async (p: unknown, ...a: unknown[]) => {
      const h = await open(p, ...a);
      if (String(p) !== gBin) return h;
      const real = h.read.bind(h);
      let first = true;
      h.read = async (...args: unknown[]) => {
        if (first) {
          first = false;
          fs.truncateSync(gBin, UPLOAD_MAX_BYTES + MB);
        }
        const r = await real(...args);
        read += r.bytesRead;
        return r;
      };
      return h;
    }) as never);
    try {
      expect(await readStagedFile(me, g.fileId)).toBeNull();
      // Read through the handle that was checked, and never more than one byte past the size.
      expect(read).toBeGreaterThan(0);
      expect(read).toBeLessThanOrEqual(g.size + 1);
    } finally {
      spy.mockRestore();
      fs.rmSync(gBin, { force: true });
    }
  });

  it('a .json swapped for a larger file or a link between the check and the read, or growing while it is read, is no file, and is never read into memory', async () => {
    const META_MAX = 64 * 1024; // lib/agent/files.ts META_MAX
    const open = fsp.open.bind(fsp) as (...a: unknown[]) => Promise<FileHandleLike>;
    /**
     * Run `change` once when lib/agent/files.ts opens `target`: just before the open, just after
     * it, or at the first read through the handle. Counts every byte read through that handle.
     */
    const watchReads = (target: string, change: () => void, when: 'before the open' | 'after the open' | 'at the first read') => {
      let read = 0;
      const spy = vi.spyOn(fsp, 'open').mockImplementation((async (p: unknown, ...a: unknown[]) => {
        if (String(p) !== target) return open(p, ...a);
        if (when === 'before the open') change();
        const h = await open(p, ...a);
        if (when === 'after the open') change();
        const real = h.read.bind(h);
        let first = true;
        h.read = async (...args: unknown[]) => {
          if (first && when === 'at the first read') change();
          first = false;
          const r = await real(...args);
          read += r.bytesRead;
          return r;
        };
        return h;
      }) as never);
      return { read: () => read, restore: () => spy.mockRestore() };
    };
    const big = JSON.stringify({ name: 'big.txt', type: 'text/plain', size: 4, created: new Date().toISOString(), company: COMPANY, agent: AGENT, pad: 'x'.repeat(4 * META_MAX) });
    const readFiles = vi.spyOn(fsp, 'readFile');
    try {
      for (const how of ['a larger file', 'a link', 'grown after the open', 'grown while read'] as const) {
        const f = await stageFile(me, { name: 'meta.txt', type: 'text/plain', bytes: Buffer.from('meta') });
        const json = path.join(dirOf(me), `${f.fileId}.json`);
        const before = fs.readFileSync(json, 'utf8');
        const elsewhere = path.join(TMP, `attack-meta-${f.fileId}.json`);
        fs.writeFileSync(elsewhere, big);
        let made = true;
        const w = watchReads(
          json,
          () => {
            // The checked .json is replaced (a new file, or a link), or grows where it is.
            if (how === 'a larger file') {
              fs.rmSync(json);
              fs.writeFileSync(json, big);
            } else if (how === 'a link') {
              fs.rmSync(json);
              try {
                fs.symlinkSync(elsewhere, json, 'file');
              } catch {
                made = false; // this computer lets no one make one
                fs.writeFileSync(json, before);
              }
            } else {
              fs.appendFileSync(json, 'x'.repeat(4 * META_MAX));
            }
          },
          how === 'grown after the open' ? 'after the open' : how === 'grown while read' ? 'at the first read' : 'before the open',
        );
        try {
          if (made) expect(await stagedFileInfo(me, f.fileId), how).toBeNull();
          // At most one byte past what it was when it was checked, never the larger file.
          expect(w.read(), how).toBeLessThanOrEqual(Buffer.byteLength(before) + 1);
        } finally {
          w.restore();
          fs.rmSync(json, { force: true });
          fs.rmSync(elsewhere, { force: true });
        }
      }
      // A .json is only ever read through a handle, never by its name alone.
      const f = await stageFile(me, { name: 'read.txt', type: 'text/plain', bytes: Buffer.from('read') });
      expect((await readStagedFile(me, f.fileId))?.file.name).toBe('read.txt');
      await clearStagedFiles();
      expect(readFiles.mock.calls.map((c) => String(c[0])).filter((p) => p.endsWith('.json'))).toEqual([]);
    } finally {
      readFiles.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')('a pipe put at a .bin’s, a .json’s or a .part’s name after the check is never waited on', async (ctx) => {
    const { execFileSync } = await import('node:child_process');
    const pipeAt = (p: string) => {
      fs.rmSync(p, { force: true });
      execFileSync('mkfifo', [p]);
    };
    try {
      pipeAt(path.join(TMP, 'attack-fifo-probe'));
    } catch {
      ctx.skip(); // no mkfifo here
    }
    /** `p` settled within two seconds; else the pipe is opened for writing once, so the waiting open ends. */
    const soon = async <T>(p: Promise<T>, pipe: string): Promise<T | 'waited'> => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'waited'>((r) => (timer = setTimeout(() => r('waited'), 2000)));
      const out = await Promise.race([p, late]);
      clearTimeout(timer);
      if (out === 'waited') {
        try {
          fs.closeSync(fs.openSync(pipe, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          /* nothing waits on it any more */
        }
      }
      return out;
    };
    for (const ext of ['bin', 'json'] as const) {
      const f = await stageFile(me, { name: 'pipe.txt', type: 'text/plain', bytes: Buffer.from('pipe') });
      const target = path.join(dirOf(me), `${f.fileId}.${ext}`);
      const spy = beforeOpen(target, () => pipeAt(target));
      try {
        expect(await soon(readStagedFile(me, f.fileId), target), ext).toBeNull();
      } finally {
        spy.mockRestore();
        fs.rmSync(target, { force: true });
      }
    }
    const up = await uploadChunk(me, { name: 'u.txt', type: 'text/plain', chunkBase64: b64('u'), last: false });
    const part = path.join(dirOf(me), `${up.uploadId}.part`);
    const spy = beforeOpen(part, () => pipeAt(part));
    try {
      const sent = uploadChunk(me, { uploadId: up.uploadId, name: 'u.txt', type: 'text/plain', chunkBase64: b64('x'), last: false }).then(
        () => 'kept',
        () => 'refused',
      );
      expect(await soon(sent, part)).toBe('refused');
    } finally {
      spy.mockRestore();
      fs.rmSync(part, { force: true });
    }
  });

  it('the agent’s folder, or its company’s, swapped for a link to another agent’s: nothing is read from it, kept in it or removed from it', async (ctx) => {
    const mine = await stageFile(me, { name: 'mine.txt', type: 'text/plain', bytes: Buffer.from('mine') });
    const theirs = await stageFile(otherAgent, { name: 'theirs.txt', type: 'text/plain', bytes: Buffer.from('their secret') });
    const myDir = dirOf(me);
    const theirDir = dirOf(otherAgent);
    const moved = `${myDir}-moved`;
    fs.renameSync(myDir, moved);
    try {
      fs.symlinkSync(theirDir, myDir, WIN ? 'junction' : 'dir');
    } catch {
      fs.renameSync(moved, myDir);
      ctx.skip();
    }
    const before = fs.readdirSync(theirDir).sort();
    try {
      expect(await readStagedFile(me, theirs.fileId)).toBeNull();
      expect(await stagedFileInfo(me, theirs.fileId)).toBeNull();
      expect((await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }))).code).toBe('INTERNAL');
      await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
      await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
      await refusal(removeStagedFile(me, theirs.fileId));
      expect(fs.readdirSync(theirDir).sort()).toEqual(before);
    } finally {
      unlinkDir(myDir);
      fs.renameSync(moved, myDir);
    }
    expect(Buffer.from((await readStagedFile(otherAgent, theirs.fileId))!.bytes).toString()).toBe('their secret');
    expect((await readStagedFile(me, mine.fileId))?.file.name).toBe('mine.txt');

    // The company's folder: another company's (same agent id) made a link to this one's.
    const otherCompanyDir = path.join(attackRoot, OTHER_COMPANY);
    fs.rmSync(otherCompanyDir, { recursive: true, force: true });
    fs.symlinkSync(path.join(attackRoot, COMPANY), otherCompanyDir, WIN ? 'junction' : 'dir');
    try {
      expect(await readStagedFile(otherCompany, mine.fileId)).toBeNull();
      expect(await stagedFileInfo(otherCompany, mine.fileId)).toBeNull();
      await refusal(stageFile(otherCompany, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
    } finally {
      unlinkDir(otherCompanyDir);
    }
    expect((await readStagedFile(me, mine.fileId))?.file.name).toBe('mine.txt');
  });

  it('a staged file copied into another agent’s or company’s folder is no file there: its .json names its owner', async () => {
    const f = await stageFile(me, { name: 'mine.txt', type: 'text/plain', bytes: Buffer.from('mine') });
    for (const o of [otherAgent, otherCompany]) {
      await stageFile(o, { name: 'own.txt', type: 'text/plain', bytes: Buffer.from('own') });
      for (const ext of ['bin', 'json']) fs.copyFileSync(path.join(dirOf(me), `${f.fileId}.${ext}`), path.join(dirOf(o), `${f.fileId}.${ext}`));
      expect(await readStagedFile(o, f.fileId)).toBeNull();
      expect(await stagedFileInfo(o, f.fileId)).toBeNull();
    }
    expect((await readStagedFile(me, f.fileId))?.file.name).toBe('mine.txt');
    // A .json that names no owner at all is no file either.
    const json = path.join(dirOf(me), `${f.fileId}.json`);
    const { company: _company, agent: _agent, ...rest } = JSON.parse(fs.readFileSync(json, 'utf8'));
    fs.writeFileSync(json, JSON.stringify(rest));
    expect(await stagedFileInfo(me, f.fileId)).toBeNull();
  });

  it('an id guessed from another agent or another company reaches nothing of theirs, in any call', async () => {
    const theirs = await stageFile(otherAgent, { name: 'theirs.txt', type: 'text/plain', bytes: Buffer.from('theirs') });
    const elsewhere = await stageFile(otherCompany, { name: 'elsewhere.txt', type: 'text/plain', bytes: Buffer.from('elsewhere') });
    const theirUpload = await uploadChunk(otherAgent, { name: 'u.txt', type: 'text/plain', chunkBase64: b64('their '), last: false });
    for (const id of [theirs.fileId, elsewhere.fileId, theirUpload.uploadId]) {
      expect(await readStagedFile(me, id)).toBeNull();
      expect(await stagedFileInfo(me, id)).toBeNull();
      expect(await removeStagedFile(me, id)).toBe(false);
    }
    await refusal(uploadChunk(me, { uploadId: theirUpload.uploadId, name: 'x', type: 'text/plain', chunkBase64: b64('evil'), last: true }));
    // Theirs, untouched.
    expect(Buffer.from((await readStagedFile(otherAgent, theirs.fileId))!.bytes).toString()).toBe('theirs');
    expect(Buffer.from((await readStagedFile(otherCompany, elsewhere.fileId))!.bytes).toString()).toBe('elsewhere');
    const done = await uploadChunk(otherAgent, { uploadId: theirUpload.uploadId, name: 'u.txt', type: 'text/plain', chunkBase64: b64('upload'), last: true });
    expect(Buffer.from((await readStagedFile(otherAgent, done.file!.fileId))!.bytes).toString()).toBe('their upload');
  });

  it('an upload’s part that is a link, or a second name for another file, is never written through: planted, or swapped in before it is opened', async () => {
    const victim = path.join(TMP, 'attack-victim.txt');
    fs.writeFileSync(victim, 'VICTIM');
    const start = async () => {
      const up = await uploadChunk(me, { name: 'u.txt', type: 'text/plain', chunkBase64: b64('u'), last: false });
      return { id: up.uploadId, part: path.join(dirOf(me), `${up.uploadId}.part`) };
    };
    // Planted: a second name for the victim at the part's name.
    const a = await start();
    fs.rmSync(a.part);
    fs.linkSync(victim, a.part);
    expect((await refusal(uploadChunk(me, { uploadId: a.id, name: 'u.txt', type: 'text/plain', chunkBase64: b64('EVIL'), last: false }))).message).toMatch(/no unfinished upload/);
    fs.rmSync(a.part);
    // Swapped in between the check and the open.
    const b = await start();
    const spy = beforeOpen(b.part, () => {
      fs.rmSync(b.part);
      fs.linkSync(victim, b.part);
    });
    try {
      await refusal(uploadChunk(me, { uploadId: b.id, name: 'u.txt', type: 'text/plain', chunkBase64: b64('EVIL'), last: true }));
    } finally {
      spy.mockRestore();
      fs.rmSync(b.part, { force: true });
    }
    // A symbolic link, where this computer lets one be made.
    const c = await start();
    fs.rmSync(c.part);
    let symlinked = true;
    try {
      fs.symlinkSync(victim, c.part, 'file');
    } catch {
      symlinked = false;
    }
    if (symlinked) await refusal(uploadChunk(me, { uploadId: c.id, name: 'u.txt', type: 'text/plain', chunkBase64: b64('EVIL'), last: false }));
    fs.rmSync(c.part, { force: true });
    expect(fs.readFileSync(victim, 'utf8')).toBe('VICTIM');
  });

  it('a part changed between its last write and being kept is not kept', async () => {
    const up = await uploadChunk(me, { name: 'u.txt', type: 'text/plain', chunkBase64: b64('first '), last: false });
    const part = path.join(dirOf(me), `${up.uploadId}.part`);
    const binsBefore = fs.readdirSync(dirOf(me)).filter((n) => n.endsWith('.bin'));
    const rename = fsp.rename.bind(fsp) as (...a: unknown[]) => Promise<void>;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation((async (from: unknown, to: unknown) => {
      if (String(from) === part) {
        // Another file of the very size the upload came to.
        fs.rmSync(part);
        fs.writeFileSync(part, 'EVIL-EVIL!');
      }
      return rename(from, to);
    }) as never);
    try {
      const err = await refusal(uploadChunk(me, { uploadId: up.uploadId, name: 'u.txt', type: 'text/plain', chunkBase64: b64('last'), last: true }));
      expect(err.message).toMatch(/changed on this computer while it was being sent/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(dirOf(me)).filter((n) => n.endsWith('.bin'))).toEqual(binsBefore);
  });

  it('names with trailing dots or spaces, device names (CON, NUL, COM1 and the rest) and streams are kept plain', async () => {
    const cases: Array<[string, string]> = [
      ['CON.', '_CON'],
      ['nul.txt.', '_nul.txt'],
      ['COM1 ', '_COM1'],
      ['com¹.txt', '_com¹.txt'],
      ['Lpt3.log', '_Lpt3.log'],
      ['conin$', '_conin$'],
      ['CONOUT$.log', '_CONOUT$.log'],
      ['clock$', '_clock$'],
      ['PRN . .', '_PRN'],
      ['aux .txt', '_aux .txt'],
      ['CON​.txt', '_CON.txt'],
      ['report.pdf:hidden', 'report.pdf-hidden'],
      ['report.pdf::$DATA', 'report.pdf--$DATA'],
      ['file.txt:Zone.Identifier:$DATA', 'file.txt-Zone.Identifier-$DATA'],
      ['name . . .', 'name'],
      ['ends-in-space ', 'ends-in-space'],
      ['dots...', 'dots'],
    ];
    for (const [raw, want] of cases) {
      const file = await stageFile(me, { name: raw, type: 'text/plain', bytes: Buffer.from('x') });
      expect(file.name, JSON.stringify(raw)).toBe(want);
      expect(fs.existsSync(path.join(dirOf(me), `${file.fileId}.bin`))).toBe(true);
    }
    // Nothing but this module's own names in the agent's folder.
    for (const n of fs.readdirSync(dirOf(me))) expect(n, n).toMatch(/^([0-9a-f]{32}\.(bin|json|part)|\.ironbooks-agent-files)$/);
  });

  it('a long path: refused when longer than a plain path may be; a real folder deep inside an allowed one still works', async () => {
    const allowed = path.join(TMP, 'long-allowed');
    let deep = allowed;
    for (let i = 0; i < 7; i++) deep = path.join(deep, `${'d'.repeat(60)}${i}`);
    fs.mkdirSync(deep, { recursive: true });
    expect(deep.length).toBeGreaterThan(400);
    expect(await allowedFolder([allowed], deep)).toBe(fs.realpathSync.native(deep));
    const tooLong = path.join(deep, 'x'.repeat(700));
    expect(tooLong.length).toBeGreaterThan(1024);
    expect(await allowedFolder([allowed], tooLong)).toBeNull();
    expect(await allowedFolder([tooLong], deep)).toBeNull();
    expect(overlapsAppData(tooLong)).toBe(true);
  });

  it('a folder named with a trailing dot or space is the same folder to Windows: overlapsAppData refuses it too', () => {
    const shellBackups = path.join(TMP, 'trim', 'backups-here');
    process.env.BKA_BACKUP_DIR = shellBackups;
    try {
      // As written, as inside it, and as the folder that holds it.
      for (const folder of [`${shellBackups}.`, `${shellBackups} `, `${shellBackups}. .`, path.join(`${shellBackups}.`, 'Acme'), path.join(TMP, 'trim.'), path.join(TMP, 'trim. ')]) {
        expect(overlapsAppData(folder), folder).toBe(true);
      }
      expect(overlapsAppData(`${shellBackups}2`)).toBe(false);
    } finally {
      restoreEnv('BKA_BACKUP_DIR');
    }
  });

  it.runIf(process.platform === 'win32')('a folder with a trailing dot or space, a device name or a stream along the way is refused', async () => {
    const allowed = path.join(TMP, 'odd-allowed');
    const sub = path.join(allowed, 'sub', 'deeper');
    fs.mkdirSync(sub, { recursive: true });
    expect(await allowedFolder([allowed], sub)).toBe(fs.realpathSync.native(sub));
    for (const folder of [
      path.join(allowed, 'sub.'),
      path.join(allowed, 'sub.', 'deeper'),
      `${path.join(allowed, 'sub ')}\\deeper`,
      path.join(allowed, 'sub', 'deeper..'),
      path.join(allowed, 'CON'),
      path.join(allowed, 'nul.txt'),
      path.join(allowed, 'COM1.'),
      path.join(allowed, 'sub', 'conout$'),
      `${sub}::$INDEX_ALLOCATION`,
      `${path.join(allowed, 'sub')}:stream\\deeper`,
    ]) {
      expect(await allowedFolder([allowed], folder), folder).toBeNull();
    }
    // An allowed folder written that way allows nothing.
    expect(await allowedFolder([`${allowed}.`], sub)).toBeNull();
    expect(await allowedFolder([`${allowed}\\.\\sub.`], sub)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('a link swapped in after the walk, leading to a share no allowed folder names, is refused before the share is looked at again; a drive mapped to it still works', async () => {
    const SHARE = '\\\\ironbooks-test.invalid\\share';
    const local = path.join(TMP, 'swap-share');
    const allowed = path.join(local, 'allowed');
    const sub = path.join(allowed, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const localReal = fs.realpathSync.native(local);
    const driveRoot = path.parse(localReal).root;
    let mapped = false;
    const statted: string[] = [];
    const toShare = (p: string) => (p === localReal || p.startsWith(localReal + path.sep) ? SHARE + p.slice(localReal.length) : p);
    const toLocal = (p: string) => (p.toUpperCase().startsWith(SHARE.toUpperCase()) ? localReal + p.slice(SHARE.length) : p);
    const nativeOrig = fs.realpath.native;
    const stat = fsp.stat.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
    const spies = [
      vi.spyOn(fs.realpath, 'native').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (err: Error | null, out?: string) => void;
        if (/^[\\/]{2}/.test(String(p))) return cb(Object.assign(new Error('not there'), { code: 'ENOENT' }));
        // The drive this test's folders are on, mapped to the share, or not.
        if (String(p) === driveRoot) return cb(null, mapped ? `${SHARE}\\` : driveRoot);
        nativeOrig(p, (err, out) => (err ? cb(err) : cb(null, toShare(out))));
      }) as never),
      vi.spyOn(fsp, 'stat').mockImplementation((async (p: unknown, ...a: unknown[]) => {
        if (/^[\\/]{2}/.test(String(p))) statted.push(String(p));
        return stat(toLocal(String(p)), ...a);
      }) as never),
    ];
    try {
      // As if a link had been put in place after the walk: the folder answers as on the share.
      expect(await allowedFolder([allowed], sub)).toBeNull();
      expect(statted).toEqual([]);
      // A drive mapped to that very share is the person's own way there: as before.
      mapped = true;
      expect(await allowedFolder([allowed], sub)).toBe(toShare(fs.realpathSync.native(sub)));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe('where the files are kept', () => {
  it('without the override: in the open company file’s working folder, beside its data, never inside it', async () => {
    const work = path.join(TMP, 'Working', 'abc123');
    delete process.env[AGENT_FILES_DIR_ENV];
    process.env.BKA_COMPANY_STATE = path.join(work, 'state.json');
    process.env.BKA_DATA_DIR = path.join(work, 'data');
    try {
      expect(stagedFilesRoot()).toBe(path.join(work, 'agent-files'));
      const f = await stageFile(me, { name: 'w.txt', type: 'text/plain', bytes: Buffer.from('w') });
      expect(fs.existsSync(path.join(work, 'agent-files', COMPANY, AGENT, `${f.fileId}.bin`))).toBe(true);
      expect(fs.existsSync(path.join(work, 'agent-files', MARKER))).toBe(true);
      expect(fs.existsSync(path.join(work, 'data'))).toBe(false);
    } finally {
      restoreEnv('BKA_COMPANY_STATE', 'BKA_DATA_DIR');
    }
  });

  it('the override is for test runs only: an installed Ironbooks ignores it', () => {
    const work = path.join(TMP, 'Working', 'prod');
    process.env.BKA_COMPANY_STATE = path.join(work, 'state.json');
    process.env.BKA_DATA_DIR = path.join(work, 'data');
    try {
      expect(stagedFilesRoot()).toBe(path.resolve(ROOT));
      env.NODE_ENV = 'production';
      expect(stagedFilesRoot()).toBe(path.join(work, 'agent-files'));
      // No open company file (a company folder): this computer's app data folder for Ironbooks.
      delete process.env.BKA_COMPANY_STATE;
      expect(stagedFilesRoot()).toMatch(/ironbooks[\\/]agent-files$/i);
      expect(stagedFilesRoot()!.toLowerCase().startsWith(TMP.toLowerCase())).toBe(false);
    } finally {
      restoreEnv('NODE_ENV', 'BKA_COMPANY_STATE', 'BKA_DATA_DIR');
    }
  });

  it('a folder inside the company database folder is refused (fail closed)', async () => {
    const data = path.join(TMP, 'company', 'data');
    process.env.BKA_DATA_DIR = data;
    process.env[AGENT_FILES_DIR_ENV] = path.join(data, 'agent-files');
    try {
      expect(stagedFilesRoot()).toBeNull();
      const err = await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
      expect(err.code).toBe('INTERNAL');
      expect(await readStagedFile(me, 'a'.repeat(32))).toBeNull();
      await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
      expect(fs.existsSync(data)).toBe(false);
    } finally {
      restoreEnv('BKA_DATA_DIR');
    }
  });

  it('a folder that holds the database folder, the working folder or the company file is refused, and clearing leaves their folders alone', async () => {
    const holds = path.join(TMP, 'holds');
    const work = path.join(holds, 'Working', 'abc123');
    const data = path.join(work, 'data');
    // The database keeps empty folders of its own: a clear there would remove them.
    const pgDirs = ['pg_tblspc', 'pg_twophase', 'pg_replslot'];
    for (const d of pgDirs) fs.mkdirSync(path.join(data, d), { recursive: true });
    const companyFile = path.join(holds, 'Documents', 'Books.ironbooks');
    fs.mkdirSync(path.dirname(companyFile), { recursive: true });
    fs.writeFileSync(companyFile, 'books');
    const elsewhere = path.join(TMP, 'elsewhere', 'data');
    const setups: Array<{ data: string; state?: string; file?: string; root: string }> = [
      { data, root: work }, // the folder that holds the database folder
      { data, root: data }, // the database folder itself
      { data: elsewhere, state: path.join(work, 'state.json'), root: path.join(holds, 'Working') }, // holds the working folder
      { data: elsewhere, file: companyFile, root: path.dirname(companyFile) }, // holds the company file
    ];
    try {
      for (const s of setups) {
        process.env.BKA_DATA_DIR = s.data;
        if (s.state) process.env.BKA_COMPANY_STATE = s.state;
        else delete process.env.BKA_COMPANY_STATE;
        if (s.file) process.env.BKA_COMPANY_FILE = s.file;
        else delete process.env.BKA_COMPANY_FILE;
        process.env[AGENT_FILES_DIR_ENV] = s.root;
        expect(stagedFilesRoot(), s.root).toBeNull();
        const err = await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
        expect(err.code).toBe('INTERNAL');
        await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
        await expect(clearStagedFiles({ all: true })).rejects.toBeInstanceOf(ServiceError);
        expect(fs.existsSync(path.join(s.root, MARKER))).toBe(false);
      }
      for (const d of pgDirs) expect(fs.existsSync(path.join(data, d))).toBe(true);
      expect(fs.readFileSync(companyFile, 'utf8')).toBe('books');
    } finally {
      restoreEnv('BKA_DATA_DIR', 'BKA_COMPANY_STATE', 'BKA_COMPANY_FILE');
    }
  });

  it.runIf(process.platform === 'win32')('a folder on a network share or a device path is refused (fail closed), before it is looked at', async () => {
    lazyClearDue();
    const disk = watchDisk();
    try {
      for (const root of ['\\\\ironbooks-test.invalid\\share\\agent-files', '//ironbooks-test.invalid/share/agent-files', `\\\\?\\${ROOT}`, `\\\\.\\${ROOT}`]) {
        process.env[AGENT_FILES_DIR_ENV] = root;
        expect(stagedFilesRoot()).toBeNull();
        const err = await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
        expect(err.code).toBe('INTERNAL');
        expect(err.message).toMatch(/another computer/);
        expect(await readStagedFile(me, 'a'.repeat(32))).toBeNull();
        await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
        await expect(clearStagedFiles()).rejects.toBeInstanceOf(ServiceError);
      }
      expect(disk.paths((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    } finally {
      disk.restore();
      noLazyClear();
    }
  });

  it.runIf(process.platform === 'win32')('a folder the disk answers as a share (a link to one, a mapped drive) is refused too, and the share is never looked at', async () => {
    // The system answers a junction to a share, or a folder on a mapped drive, as \\server\share\…
    const looksLocal = path.join(TMP, 'mapped-root');
    fs.mkdirSync(looksLocal, { recursive: true });
    const localReal = fs.realpathSync.native(looksLocal);
    const nativeSync = fs.realpathSync.native;
    const onShare: string[] = [];
    const see = (p: unknown) => {
      if (/^[\\/]{2}/.test(String(p))) onShare.push(String(p));
    };
    const spies = [
      vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        see(p);
        const out = String(nativeSync(p, ...(rest as [])));
        const inside = out === localReal || out.startsWith(localReal + path.sep);
        return inside ? `\\\\ironbooks-test.invalid\\share\\mapped${out.slice(localReal.length)}` : out;
      }) as never),
      ...['lstatSync', 'statSync', 'existsSync', 'readdirSync'].map((m) => passThrough(fs, m, see)),
      ...['lstat', 'stat', 'mkdir', 'writeFile', 'readdir', 'open', 'rename'].map((m) => passThrough(fsp, m, see)),
    ];
    try {
      for (const root of [path.join(looksLocal, 'agent-files'), looksLocal]) {
        process.env[AGENT_FILES_DIR_ENV] = root;
        expect(stagedFilesRoot(), root).toBeNull();
        const err = await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
        expect(err.code).toBe('INTERNAL');
        expect(err.message).toMatch(/another computer/);
        await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
        await expect(clearStagedFiles()).rejects.toBeInstanceOf(ServiceError);
      }
      expect(onShare).toEqual([]);
      // Nothing was made or marked in the folder that only looks local.
      expect(fs.readdirSync(looksLocal)).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('the same refusals hold through a link, in another spelling, and for a folder that holds Ironbooks’ own local folder', async (ctx) => {
    const real = path.join(TMP, 'linked-real');
    const books = path.join(real, 'books');
    const data = path.join(books, 'data');
    fs.mkdirSync(path.join(data, 'pg_tblspc'), { recursive: true });
    const alias = path.join(TMP, 'linked-alias');
    try {
      fs.symlinkSync(books, alias, WIN ? 'junction' : 'dir');
    } catch {
      ctx.skip();
    }
    try {
      // The database folder named through the link; the staging folder holds it as the disk has it.
      process.env.BKA_DATA_DIR = path.join(alias, 'data');
      process.env[AGENT_FILES_DIR_ENV] = books;
      expect(stagedFilesRoot()).toBeNull();
      await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
      // The other way round: the staging folder named through the link, inside the database folder.
      process.env.BKA_DATA_DIR = data;
      process.env[AGENT_FILES_DIR_ENV] = path.join(alias, 'data', 'agent-files');
      expect(stagedFilesRoot()).toBeNull();
      await refusal(uploadChunk(me, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
      // A spelling that may be the same folder (another case) is refused as well.
      process.env[AGENT_FILES_DIR_ENV] = books.toUpperCase();
      expect(stagedFilesRoot()).toBeNull();
      process.env[AGENT_FILES_DIR_ENV] = path.join(data.toUpperCase(), 'agent-files');
      expect(stagedFilesRoot()).toBeNull();
      // Ironbooks' own local folder (working copies, sandboxes, the app data staging folder).
      if (WIN) process.env.LOCALAPPDATA = path.join(TMP, 'local');
      else process.env.XDG_STATE_HOME = path.join(TMP, 'local');
      if (process.platform !== 'darwin') {
        process.env.BKA_DATA_DIR = path.join(TMP, 'elsewhere-data');
        process.env[AGENT_FILES_DIR_ENV] = path.join(TMP, 'local');
        expect(stagedFilesRoot()).toBeNull();
        // Inside it is where staged files belong when no company file is open.
        process.env[AGENT_FILES_DIR_ENV] = path.join(TMP, 'local', WIN ? 'Ironbooks' : 'ironbooks', 'agent-files');
        expect(stagedFilesRoot()).toBe(path.join(TMP, 'local', WIN ? 'Ironbooks' : 'ironbooks', 'agent-files'));
      }
      // Nothing was made or marked anywhere, and the database's own empty folder is still there.
      expect(fs.existsSync(path.join(books, MARKER))).toBe(false);
      expect(fs.existsSync(path.join(data, 'agent-files'))).toBe(false);
      expect(fs.existsSync(path.join(data, 'pg_tblspc'))).toBe(true);
    } finally {
      restoreEnv('BKA_DATA_DIR', 'LOCALAPPDATA', 'XDG_STATE_HOME');
    }
  });
});

describe('overlapsAppData (for the folder rules of other units)', () => {
  const base = path.join(TMP, 'overlaps');
  const local = path.join(base, 'local');
  const staged = path.join(base, 'staged');
  const working = path.join(base, 'Working');
  const work = path.join(working, 'Acme-1a2b');
  const data = path.join(work, 'data');
  const filed = path.join(base, 'Books');
  const companyFileAt = path.join(filed, 'Acme.ironbooks');
  const elsewhere = path.join(TMP, 'overlaps-elsewhere');
  const appLocal = () =>
    WIN ? path.join(local, 'Ironbooks') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Ironbooks') : path.join(local, 'ironbooks');

  beforeAll(() => {
    for (const d of [staged, data, path.join(working, 'Other-3c4d'), filed, path.join(elsewhere, 'Receipts')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(companyFileAt, 'books');
  });

  beforeEach(() => {
    process.env[AGENT_FILES_DIR_ENV] = staged;
    process.env.BKA_DATA_DIR = data;
    process.env.BKA_COMPANY_STATE = path.join(work, 'state.json');
    process.env.BKA_COMPANY_FILE = companyFileAt;
    if (WIN) process.env.LOCALAPPDATA = local;
    else process.env.XDG_STATE_HOME = local;
  });

  afterAll(() => restoreEnv('BKA_DATA_DIR', 'BKA_COMPANY_STATE', 'BKA_COMPANY_FILE', 'LOCALAPPDATA', 'XDG_STATE_HOME'));

  it('every staging folder, the books and Ironbooks’ own folder: the place itself, inside it, or holding it', () => {
    expect(stagedFilesRoot()).toBe(staged);
    expect(appDataPlaces()).toEqual(expect.arrayContaining([staged, data, work, working, companyFileAt, path.join(work, 'agent-files'), appLocal()]));
    const refused = [
      staged,
      path.join(staged, COMPANY),
      base, // holds all of them
      data,
      path.join(data, 'pg_tblspc'),
      work,
      path.join(work, 'agent-files'), // the open file's own staging folder (used when there is no override)
      working, // the folder of every working folder
      path.join(working, 'Other-3c4d'), // another company file's working folder, with its own staged files
      filed, // holds the company file
      companyFileAt,
      appLocal(),
      path.join(appLocal(), 'agent-files'), // the staging folder when no company file is open
      path.join(appLocal(), 'Working', 'x'),
    ];
    for (const folder of refused) expect(overlapsAppData(folder), folder).toBe(true);
    // Beside them is fine.
    for (const folder of [elsewhere, path.join(elsewhere, 'Receipts'), path.join(base + '-beside'), path.join(filed + 'x')]) {
      expect(overlapsAppData(folder), folder).toBe(false);
    }
    if (process.platform !== 'darwin') expect(overlapsAppData(path.join(local, 'Other'))).toBe(false);
  });

  it('through a link, and in a spelling that may be the same folder', (ctx) => {
    expect(overlapsAppData(staged.toUpperCase())).toBe(true);
    expect(overlapsAppData(path.join(data.toLowerCase(), 'x'))).toBe(true);
    // A Kelvin sign where the folder has a "k": refused too, a refusal errs on the side of refusing.
    expect(overlapsAppData(path.join(base, `Wor${KELVIN}ing`, 'Acme-1a2b'))).toBe(true);
    expect(overlapsAppData(path.join(base, `Wor${KELVIN}ing-not`))).toBe(false);
    const alias = path.join(elsewhere, 'link-to-staged');
    try {
      fs.symlinkSync(staged, alias, WIN ? 'junction' : 'dir');
    } catch {
      ctx.skip();
    }
    expect(overlapsAppData(alias)).toBe(true);
    expect(overlapsAppData(path.join(alias, COMPANY, 'not-yet'))).toBe(true);
    // A link that holds the books' folder.
    const holder = path.join(elsewhere, 'link-to-working');
    fs.symlinkSync(working, holder, WIN ? 'junction' : 'dir');
    expect(overlapsAppData(holder)).toBe(true);
  });

  it('fails closed for what is no full path, and never looks at a share', () => {
    for (const bad of ['', '   ', 'relative/folder', '..', 42, null, `${elsewhere}\u0000`, 'x'.repeat(2000)]) {
      expect(overlapsAppData(bad as unknown as string), String(bad).slice(0, 20)).toBe(true);
    }
    if (WIN) {
      expect(overlapsAppData(`\\\\?\\${elsewhere}`)).toBe(true);
      expect(overlapsAppData(`\\\\.\\${elsewhere}`)).toBe(true);
      const disk = watchDisk();
      try {
        expect(overlapsAppData('\\\\ironbooks-test.invalid\\share\\Receipts')).toBe(false);
        expect(disk.paths((p) => /^[\\/]{2}/.test(p))).toEqual([]);
      } finally {
        disk.restore();
      }
    }
  });

  describe('the desktop app’s own folders, wherever the shell keeps them', () => {
    // Outside `base`, so "beside them is fine" below means something.
    const appData = path.join(TMP, 'overlaps-appdata');
    const settingsParent = () =>
      WIN ? path.join(appData, 'Roaming') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(appData, 'config');
    const settings = (name: string) => path.join(settingsParent(), name);
    const shellNamed = {
      BKA_BACKUP_DIR: path.join(TMP, 'overlaps-shell', 'backups-here'),
      BKA_SANDBOX_ROOT: path.join(TMP, 'overlaps-shell', 'sandboxes-here'),
      IRONBOOKS_AGENT_ENDPOINT_DIR: path.join(TMP, 'overlaps-shell', 'endpoints-here'),
    } as const;
    const realBooks = path.join(TMP, 'overlaps-real', 'Working', 'Real-9f9f', 'data');
    const realFile = path.join(TMP, 'overlaps-realfile', 'Real.ironbooks');

    beforeEach(() => {
      if (WIN) process.env.APPDATA = path.join(appData, 'Roaming');
      else process.env.XDG_CONFIG_HOME = path.join(appData, 'config');
      // On Windows the settings folder must be covered without the shell naming it.
      delete process.env.IRONBOOKS_USER_DATA;
      for (const k of Object.keys(shellNamed) as Array<keyof typeof shellNamed>) delete process.env[k];
      delete process.env.BKA_SANDBOX_REAL_DIR;
      delete process.env.BKA_REAL_COMPANY_FILE;
    });

    afterAll(() =>
      restoreEnv('APPDATA', 'XDG_CONFIG_HOME', 'IRONBOOKS_USER_DATA', 'BKA_BACKUP_DIR', 'BKA_SANDBOX_ROOT', 'IRONBOOKS_AGENT_ENDPOINT_DIR', 'BKA_SANDBOX_REAL_DIR', 'BKA_REAL_COMPANY_FILE'),
    );

    it('the settings folder under every name it has had: itself, its backups and companies, and the folder that holds them', () => {
      const refused = [
        settings('Ironbooks'),
        path.join(settings('Ironbooks'), 'backups'), // the quit-time backups: whole copies of the books
        path.join(settings('Ironbooks'), 'companies', 'Acme'),
        path.join(settings('Ironbooks'), 'tls'),
        settings('ironbooks'), // a development run's name
        settings('BookKeeper AI'), // the names from before the rename
        path.join(settings('BookKeeper AI'), 'backups'),
        settings('bookkeeper-ai'),
        path.join(os.homedir(), '.ironbooks', 'Working'),
      ];
      if (process.platform !== 'darwin') refused.push(settingsParent()); // holds them all (not the real ~/Library one on a Mac)
      expect(appDataPlaces()).toEqual(expect.arrayContaining(['Ironbooks', 'ironbooks', 'BookKeeper AI', 'bookkeeper-ai'].map((n) => path.resolve(settings(n)))));
      for (const folder of refused) expect(overlapsAppData(folder), folder).toBe(true);
      // Beside them is fine.
      if (process.platform !== 'darwin') {
        for (const folder of [path.join(settingsParent(), 'Other'), path.join(settingsParent(), 'IronbooksExports'), `${settings('BookKeeper AI')} old`]) {
          expect(overlapsAppData(folder), folder).toBe(false);
        }
      }
    });

    it('company-folder mode: every company folder under the settings folder, not only the open one', () => {
      delete process.env.BKA_COMPANY_STATE;
      delete process.env.BKA_COMPANY_FILE;
      process.env.BKA_DATA_DIR = path.join(settings('Ironbooks'), 'companies', 'Acme');
      expect(overlapsAppData(path.join(settings('Ironbooks'), 'companies', 'Other'))).toBe(true);
      expect(overlapsAppData(path.join(settings('Ironbooks'), 'companies'))).toBe(true);
      // A database folder of its own (the browser version): the backups and copies Ironbooks writes beside it.
      const web = path.join(TMP, 'overlaps-web', '.bookkeeper-data', 'default');
      process.env.BKA_DATA_DIR = web;
      for (const n of ['backups', 'pre-op-backups', 'archives']) expect(overlapsAppData(path.join(path.dirname(web), n)), n).toBe(true);
    });

    it('the backup, sandbox and connection-file folders the shell names, the real books while a sandbox is open, and the archives beside the company file', () => {
      for (const [k, v] of Object.entries(shellNamed)) process.env[k] = v;
      process.env.BKA_SANDBOX_REAL_DIR = realBooks;
      process.env.BKA_REAL_COMPANY_FILE = realFile;
      expect(appDataPlaces()).toEqual(expect.arrayContaining([...Object.values(shellNamed), realBooks, realFile]));
      const refused = [
        ...Object.values(shellNamed),
        path.join(shellNamed.BKA_BACKUP_DIR, 'Acme'),
        path.join(shellNamed.BKA_SANDBOX_ROOT, 'sandbox-1', 'data'),
        path.join(TMP, 'overlaps-shell'), // holds them
        realBooks,
        path.join(path.dirname(realBooks), 'backups'),
        path.join(path.dirname(realBooks), 'pre-op-backups'),
        path.dirname(realFile), // holds the real company file
        path.join(path.dirname(realFile), 'archives'),
        path.join(filed, 'archives'), // archive copies beside the open company file
      ];
      for (const folder of refused) expect(overlapsAppData(folder), folder).toBe(true);
      // Beside them is fine, the company file's other folders too.
      for (const folder of [path.join(TMP, 'overlaps-shell-other'), path.join(filed, 'Receipts'), path.join(TMP, 'overlaps-real', 'Elsewhere')]) {
        expect(overlapsAppData(folder), folder).toBe(false);
      }
    });

    it('with no sandbox folder named (the browser version): "Ironbooks Sandboxes" beside the books, real or sandboxed, as lib/services/sandbox.ts keeps them', () => {
      const web = path.join(TMP, 'overlaps-web2', '.bookkeeper-data', 'default');
      const sandboxes = path.join(path.dirname(web), 'Ironbooks Sandboxes');
      process.env.BKA_DATA_DIR = web;
      expect(appDataPlaces()).toContain(sandboxes);
      for (const folder of [sandboxes, path.join(sandboxes, 'sbx-1', 'data'), path.dirname(web)]) expect(overlapsAppData(folder), folder).toBe(true);
      for (const folder of [`${sandboxes} old`, path.join(TMP, 'overlaps-web2', 'Receipts')]) expect(overlapsAppData(folder), folder).toBe(false);
      // The default data folder, as the reviewer found it: <cwd>/.bookkeeper-data/Ironbooks Sandboxes.
      delete process.env.BKA_DATA_DIR;
      expect(overlapsAppData(path.resolve(process.cwd(), '.bookkeeper-data', 'Ironbooks Sandboxes', 'sbx-2'))).toBe(true);
      // While a sandbox is open the books in use are the copy; the real books' sandboxes count too.
      process.env.BKA_DATA_DIR = path.join(sandboxes, 'sbx-1', 'data');
      process.env.BKA_SANDBOX_REAL_DIR = realBooks;
      expect(overlapsAppData(path.join(path.dirname(realBooks), 'Ironbooks Sandboxes', 'sbx-3'))).toBe(true);
      // The shell names the folder: that one, not the default (which is then never used).
      process.env.BKA_SANDBOX_ROOT = shellNamed.BKA_SANDBOX_ROOT;
      process.env.BKA_DATA_DIR = web;
      expect(appDataPlaces()).toContain(shellNamed.BKA_SANDBOX_ROOT);
      expect(appDataPlaces()).not.toContain(sandboxes);
      restoreEnv('BKA_DATA_DIR');
    });

    it('a sandbox open in the browser version (only BKA_DATA_DIR changes): the sandbox folder, the real books beside it and the copies beside them', () => {
      const beside = path.join(TMP, 'overlaps-web3', '.bookkeeper-data');
      const real = path.join(beside, 'default');
      const sandboxes = path.join(beside, 'Ironbooks Sandboxes');
      const copy = path.join(sandboxes, 'Acme sandbox 2026-11-22 101500 ab12', 'default');
      const copies = ['backups', 'pre-op-backups', 'archives'].map((n) => path.join(beside, n));
      // As lib/services/sandbox.ts switchActiveDataDir leaves it: the shell names nothing at all.
      process.env.BKA_DATA_DIR = copy;
      expect(process.env.BKA_SANDBOX_ROOT).toBeUndefined();
      expect(process.env.BKA_SANDBOX_REAL_DIR).toBeUndefined();
      expect(appDataPlaces()).toEqual(expect.arrayContaining([sandboxes, real, ...copies]));
      const refused = [
        real,
        path.join(real, 'base'),
        ...copies,
        path.join(copies[0], 'Acme 2026-11-21.bka'),
        sandboxes,
        path.join(sandboxes, 'Acme sandbox 2026-11-20 090000 cd34', 'default'), // another sandbox
        copy,
        beside, // holds them all
      ];
      for (const folder of refused) expect(overlapsAppData(folder), folder).toBe(true);
      for (const folder of [path.join(beside, 'Receipts'), path.join(TMP, 'overlaps-web3', 'Receipts'), `${sandboxes} old`]) {
        expect(overlapsAppData(folder), folder).toBe(false);
      }
      // The folder's name in another case: the same folder to Windows and macOS, refused too.
      process.env.BKA_DATA_DIR = path.join(beside, 'ironbooks sandboxes', 'x', 'default');
      expect(overlapsAppData(real)).toBe(true);
      // Two levels under a folder of any other name: no sandbox, nothing more is listed.
      process.env.BKA_DATA_DIR = path.join(TMP, 'overlaps-web3', 'Projects', 'x', 'default');
      expect(overlapsAppData(path.join(TMP, 'overlaps-web3', 'default'))).toBe(false);
      // The shell names the sandbox folder (the desktop, which names the real books too): the words are not taken.
      process.env.BKA_SANDBOX_ROOT = shellNamed.BKA_SANDBOX_ROOT;
      process.env.BKA_DATA_DIR = copy;
      expect(appDataPlaces()).not.toContain(real);
      restoreEnv('BKA_DATA_DIR');
    });
  });

  describe('the table of this-computer-share cases every port is held to (lib/agent/thisComputerShares.json)', () => {
    it('is plain data: every case a path and an answer, every template one the table explains', () => {
      expect(Array.isArray(thisComputerShares.cases)).toBe(true);
      expect(thisComputerShares.cases.length).toBeGreaterThan(50);
      const known = Object.keys(thisComputerShares.templates);
      for (const c of thisComputerShares.cases as ShareCase[]) {
        expect(typeof c.path, JSON.stringify(c)).toBe('string');
        expect(typeof c.want, JSON.stringify(c)).toBe('boolean');
        for (const t of c.path.match(/\{[^}]+\}/g) ?? []) expect(known, c.path).toContain(t);
      }
      // This test fills every template the table names: no case is judged by a template's own words.
      for (const c of shareCases()) expect(c.path, c.path).not.toMatch(/\{[^}]+\}/);
      // A template the table would list and this test cannot fill fails it.
      const templates = thisComputerShares.templates as Record<string, string>;
      templates['{ownMAC}'] = 'a template no test knows';
      try {
        expect(() => shareCases()).toThrow(/lists templates this test cannot fill: \{ownMAC\}/);
      } finally {
        delete templates['{ownMAC}'];
      }
      // Both answers, and the machine-specific ones, are there.
      expect(shareCases().some((c) => c.want)).toBe(true);
      expect(shareCases().some((c) => !c.want)).toBe(true);
      expect(shareCases().some((c) => c.path.includes(os.hostname()))).toBe(true);
    });

    it('lib/agent/files.ts answers every case as the table says (on other systems: never a share)', () => {
      const cases = shareCases();
      for (const c of cases) {
        withEnv(c.env, () => expect(isThisComputerShare(c.path), JSON.stringify(c.path)).toBe(WIN ? c.want : false));
      }
      expect(isThisComputerShare(5 as unknown as string)).toBe(false);
    });
  });

  describe.runIf(process.platform === 'win32')('a share on this very computer', () => {
    it('is refused in every spelling, by the words alone: nothing at all is looked at', async () => {
      const here = shareCases().filter((c) => c.want && !c.env).map((c) => c.path);
      const disk = watchDisk();
      try {
        for (const p of here) {
          expect(isThisComputerShare(p), p).toBe(true);
          expect(overlapsAppData(p), p).toBe(true);
          // Never a folder an agent may use, nor one that allows any.
          expect(await allowedFolder([p], p), p).toBeNull();
        }
        expect(disk.paths(() => true)).toEqual([]);
      } finally {
        disk.restore();
      }
      // Not a share at all.
      expect(isThisComputerShare(elsewhere)).toBe(false);
    });

    it('a folder the disk answers as one (a drive mapped to this computer’s own share) is refused', () => {
      const looksLocal = path.join(elsewhere, 'Receipts');
      expect(overlapsAppData(looksLocal)).toBe(false);
      const localReal = fs.realpathSync.native(looksLocal);
      const nativeSync = fs.realpathSync.native;
      const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const out = String(nativeSync(p, ...(rest as [])));
        return out === localReal ? '\\\\localhost\\c$\\Receipts' : out;
      }) as never);
      try {
        expect(overlapsAppData(looksLocal)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe('allowedFolder', () => {
  const base = path.join(TMP, 'folders');
  const allowed = path.join(base, 'allowed');
  const sub = path.join(allowed, 'sub', 'deeper');
  const outside = path.join(base, 'outside');
  const sibling = path.join(base, 'allowed-evil');
  const real = (p: string) => fs.realpathSync.native(p);

  beforeAll(() => {
    for (const d of [sub, outside, sibling]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'a-file.txt'), 'x');
  });

  /** A directory link (a junction on Windows); false when the system will not make one here. */
  function link(target: string, at: string): boolean {
    try {
      fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }

  it('accepts the allowed folder itself and a folder below it, answering the resolved folder', async () => {
    expect(await allowedFolder([allowed], allowed)).toBe(real(allowed));
    expect(await allowedFolder([allowed], sub)).toBe(real(sub));
    expect(await allowedFolder([outside, allowed], `${sub}${path.sep}`)).toBe(real(sub));
  });

  it('judges a folder as it is when it is used: one that has come to hold Ironbooks’ data allows nothing inside that data', async () => {
    // The Admin allowed `allowed` long ago; since then Ironbooks keeps its backups in a folder in it
    // (the shell's BKA_BACKUP_DIR), and the company file sits in it, with its archives beside it.
    const backups = path.join(allowed, 'kept-backups');
    const archives = path.join(allowed, 'archives');
    const later = path.join(backups, 'later');
    for (const d of [later, archives]) fs.mkdirSync(d, { recursive: true });
    process.env.BKA_BACKUP_DIR = backups;
    process.env.BKA_COMPANY_FILE = path.join(allowed, 'Acme.ironbooks');
    try {
      // Inside that data, as typed, in another case, or through ".." that ends there: refused.
      expect(await allowedFolder([allowed], backups)).toBeNull();
      expect(await allowedFolder([allowed], later)).toBeNull();
      expect(await allowedFolder([allowed], archives)).toBeNull();
      expect(await allowedFolder([allowed], `${sub}${path.sep}..${path.sep}..${path.sep}kept-backups`)).toBeNull();
      if (WIN) expect(await allowedFolder([allowed.toUpperCase()], later.toLowerCase())).toBeNull();
      // Even when the data's own folder is the allowed one.
      expect(await allowedFolder([backups], later)).toBeNull();
      // A folder that only holds it is still used: the company file's own folder holds the company
      // file, and the rest of the allowed folder is as before.
      expect(await allowedFolder([allowed], allowed)).toBe(real(allowed));
      expect(await allowedFolder([allowed], sub)).toBe(real(sub));
      // Through a link into that data: refused as the disk has it.
      const into = path.join(allowed, 'to-backups');
      if (link(later, into)) {
        try {
          expect(await allowedFolder([allowed], into)).toBeNull();
        } finally {
          try {
            fs.unlinkSync(into);
          } catch {
            fs.rmSync(into, { force: true });
          }
        }
      }
    } finally {
      restoreEnv('BKA_BACKUP_DIR', 'BKA_COMPANY_FILE');
      fs.rmSync(backups, { recursive: true, force: true });
      fs.rmSync(archives, { recursive: true, force: true });
    }
    // Once Ironbooks keeps nothing there, the folder is the agent's again.
    fs.mkdirSync(later, { recursive: true });
    try {
      expect(await allowedFolder([allowed], later)).toBe(real(later));
    } finally {
      fs.rmSync(backups, { recursive: true, force: true });
    }
  });

  it('refuses a folder beside or above, also through ".."', async () => {
    expect(await allowedFolder([allowed], outside)).toBeNull();
    expect(await allowedFolder([allowed], sibling)).toBeNull();
    expect(await allowedFolder([allowed], base)).toBeNull();
    const sep = path.sep;
    expect(await allowedFolder([allowed], `${allowed}${sep}sub${sep}..${sep}..${sep}outside`)).toBeNull();
    expect(await allowedFolder([allowed], `${allowed}${sep}..${sep}allowed-evil`)).toBeNull();
    // ".." that stays inside is fine.
    expect(await allowedFolder([allowed], `${sub}${sep}..`)).toBe(real(path.join(allowed, 'sub')));
    // An allowed entry with ".." in it is resolved the same way.
    expect(await allowedFolder([`${outside}${sep}..${sep}allowed`], sub)).toBe(real(sub));
  });

  it('refuses what is not an existing folder, relative paths, and no allowed folders at all', async () => {
    expect(await allowedFolder([allowed], path.join(allowed, 'missing'))).toBeNull();
    expect(await allowedFolder([allowed], path.join(allowed, 'a-file.txt'))).toBeNull();
    expect(await allowedFolder([allowed], 'allowed')).toBeNull();
    expect(await allowedFolder([allowed], '')).toBeNull();
    expect(await allowedFolder([allowed], `${allowed}\u0000`)).toBeNull();
    expect(await allowedFolder([], allowed)).toBeNull();
    expect(await allowedFolder(['relative', ''], allowed)).toBeNull();
    expect(await allowedFolder([path.join(base, 'not-there')], allowed)).toBeNull();
    expect(await allowedFolder(null as unknown as string[], allowed)).toBeNull();
    expect(await allowedFolder([allowed], 42 as unknown as string)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('compares without case on Windows', async () => {
    expect(await allowedFolder([allowed.toUpperCase()], sub.toLowerCase())).toBe(real(sub));
    expect(await allowedFolder([allowed.toLowerCase()], sub.toUpperCase())).toBe(real(sub));
    expect(await allowedFolder([allowed.toUpperCase()], sibling.toLowerCase())).toBeNull();
  });

  it('a folder whose name only looks like the allowed one (a Kelvin sign for the "k") is another folder, and refused', async (ctx) => {
    const plain = path.join(base, 'Ironbooks');
    const lookalike = path.join(base, `Ironboo${KELVIN}s`);
    fs.mkdirSync(path.join(plain, 'inside'), { recursive: true });
    try {
      fs.mkdirSync(path.join(lookalike, 'inside'), { recursive: true });
    } catch {
      ctx.skip();
    }
    // Where the disk folds the two names together (macOS), there is only one folder: nothing to prove.
    if (fs.statSync(plain).ino === fs.statSync(lookalike).ino) ctx.skip();
    expect(await allowedFolder([plain], path.join(lookalike, 'inside'))).toBeNull();
    expect(await allowedFolder([plain], lookalike)).toBeNull();
    expect(await allowedFolder([lookalike], path.join(plain, 'inside'))).toBeNull();
    // Each is its own allowed folder.
    expect(await allowedFolder([plain], path.join(plain, 'inside'))).toBe(real(path.join(plain, 'inside')));
    expect(await allowedFolder([lookalike], path.join(lookalike, 'inside'))).toBe(real(path.join(lookalike, 'inside')));
  });

  it('never a whole drive or a volume mounted as a folder, even when it is in the allowed list', async () => {
    // The company file at a drive's top (E:\Books.ironbooks) makes its folder the whole drive.
    const top = path.parse(sub).root;
    expect(await allowedFolder([top], sub)).toBeNull();
    expect(await allowedFolder([top], top)).toBeNull();
    expect(await allowedFolder([top, allowed], sub)).toBe(real(sub));
    // A folder that is another volume (on another device than the folder it sits in).
    const mounted = path.join(base, 'mounted');
    fs.mkdirSync(path.join(mounted, 'inner'), { recursive: true });
    const stat = fsp.stat.bind(fsp) as (...a: unknown[]) => Promise<fs.Stats>;
    const mountedReal = real(mounted);
    const spy = vi.spyOn(fsp, 'stat').mockImplementation((async (...a: unknown[]) => {
      const st = await stat(...a);
      // The mounted volume and everything on it: another device than the folder it sits in.
      if (String(a[0]) !== mountedReal && !String(a[0]).startsWith(mountedReal + path.sep)) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: st.dev + 1 });
    }) as never);
    try {
      expect(await allowedFolder([mounted], path.join(mounted, 'inner'))).toBeNull();
      expect(await allowedFolder([mounted], mounted)).toBeNull();
      // A folder inside it, allowed by itself, and the mount reached from an allowed folder above it, are fine.
      expect(await allowedFolder([path.join(mounted, 'inner')], path.join(mounted, 'inner'))).toBe(real(path.join(mounted, 'inner')));
      expect(await allowedFolder([base], path.join(mounted, 'inner'))).toBe(real(path.join(mounted, 'inner')));
    } finally {
      spy.mockRestore();
    }
  });

  describe.runIf(process.platform === 'win32')('a share, as Windows reaches it (simulated)', () => {
    // \\ironbooks-test.invalid\share is answered from a local folder, so the accepting side of the
    // share rule is proved on every Windows computer; \\ironbooks-test.invalid\other must never be looked at.
    const SHARE = '\\\\ironbooks-test.invalid\\share';
    const OTHER = '\\\\ironbooks-test.invalid\\other';
    /** This computer's own share, answered from the same local folder: it must be refused all the same. */
    const HERE = '\\\\localhost\\share';
    const mirror = path.join(TMP, 'share-mirror');
    const onShare = (...parts: string[]) => [SHARE, ...parts].join('\\');
    let mirrorReal = '';
    let touched: string[] = [];
    let spies: Array<{ mockRestore: () => void }> = [];

    beforeAll(() => {
      for (const d of [path.join(mirror, 'allowed', 'sub', 'deeper'), path.join(mirror, 'outside'), path.join(mirror, 'allowed-evil')]) fs.mkdirSync(d, { recursive: true });
      mirrorReal = fs.realpathSync.native(mirror);
    });

    beforeEach(() => {
      touched = [];
      const fold = (p: string) => p.toUpperCase();
      /** The local folder a path on the simulated share is, or null when it is on no simulated share. */
      const local = (p: unknown): string | null => {
        const s = String(p);
        if (/^[\\/]{2}/.test(s)) touched.push(s);
        for (const share of [SHARE, HERE]) if (fold(s.replace(/\//g, '\\')).startsWith(fold(share))) return mirror + s.slice(share.length);
        return null;
      };
      const back = (p: string) => (p.startsWith(mirrorReal) ? SHARE + p.slice(mirrorReal.length) : p);
      const missing = () => Object.assign(new Error('not there'), { code: 'ENOENT' });
      const through = <K extends 'lstat' | 'stat' | 'readlink' | 'realpath'>(name: K, map: (out: unknown) => unknown) => {
        const orig = (fsp[name] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
        return vi.spyOn(fsp, name).mockImplementation((async (p: unknown, ...a: unknown[]) => {
          const l = local(p);
          if (l === null && /^[\\/]{2}/.test(String(p))) throw missing();
          return map(await orig(l ?? p, ...a));
        }) as never);
      };
      const nativeOrig = fs.realpath.native;
      spies = [
        through('lstat', (o) => o),
        through('stat', (o) => o),
        through('readlink', (o) => back(String(o))),
        through('realpath', (o) => back(String(o))),
        vi.spyOn(fs.realpath, 'native').mockImplementation(((p: unknown, ...rest: unknown[]) => {
          const cb = rest[rest.length - 1] as (err: Error | null, out?: string) => void;
          const l = local(p);
          if (l === null && /^[\\/]{2}/.test(String(p))) return cb(missing());
          nativeOrig(l ?? (p as string), (err, out) => cb(err, err ? undefined : back(out)));
        }) as never),
      ];
    });

    afterEach(() => spies.forEach((s) => s.mockRestore()));

    it('accepts a folder on a share an allowed folder itself names, answering it on the share', async () => {
      expect(await allowedFolder([onShare('allowed')], onShare('allowed', 'sub'))).toBe(onShare('allowed', 'sub'));
      expect(await allowedFolder([onShare('allowed')], onShare('allowed'))).toBe(onShare('allowed'));
      expect(await allowedFolder([onShare('allowed')], `${onShare('allowed', 'sub', 'deeper')}\\..`)).toBe(onShare('allowed', 'sub'));
      expect(await allowedFolder(['C:\\nowhere-ironbooks-test', onShare('allowed')], onShare('allowed', 'sub', 'deeper'))).toBe(onShare('allowed', 'sub', 'deeper'));
      // The server and share are compared the way Windows compares names; forward slashes are the same path.
      expect(await allowedFolder([onShare('allowed').toUpperCase()], onShare('allowed', 'sub'))).not.toBeNull();
      expect(await allowedFolder([onShare('allowed')], onShare('allowed', 'sub').replace(/\\/g, '/'))).not.toBeNull();
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.filter((p) => p.toUpperCase().startsWith(OTHER.toUpperCase()))).toEqual([]);
    });

    it('still never beside or above the allowed folder on the share, never the share itself, never another share', async () => {
      expect(await allowedFolder([onShare('allowed')], onShare('outside'))).toBeNull();
      expect(await allowedFolder([onShare('allowed')], onShare('allowed-evil'))).toBeNull();
      expect(await allowedFolder([onShare('allowed')], `${onShare('allowed')}\\..\\allowed-evil`)).toBeNull();
      expect(await allowedFolder([onShare('allowed')], onShare('allowed', 'missing'))).toBeNull();
      // The whole share is never an agent's folder.
      expect(await allowedFolder([SHARE], onShare('allowed'))).toBeNull();
      expect(await allowedFolder([`${SHARE}\\`], onShare('allowed', 'sub'))).toBeNull();
      // A share entry allows nothing off the share, a local entry nothing on it.
      expect(await allowedFolder([onShare('allowed')], sub)).toBeNull();
      expect(await allowedFolder([allowed], onShare('allowed', 'sub'))).toBeNull();
      // Another share on the same server is never looked at, whatever is allowed on this one.
      touched = [];
      expect(await allowedFolder([onShare('allowed')], `${OTHER}\\allowed\\sub`)).toBeNull();
      expect(await allowedFolder([onShare('allowed'), allowed], `${OTHER}\\allowed`)).toBeNull();
      expect(touched).toEqual([]);
    });

    it('a local entry never makes the share looked at', async () => {
      expect(await allowedFolder([allowed, sub], onShare('allowed', 'sub'))).toBeNull();
      expect(touched).toEqual([]);
    });

    it('a share on this very computer is refused even when it answers, and never looked at', async () => {
      const here = (...parts: string[]) => [HERE, ...parts].join('\\');
      // The same folders the simulated share just allowed, reached through this computer's own share.
      expect(await allowedFolder([here('allowed')], here('allowed', 'sub'))).toBeNull();
      expect(await allowedFolder([here('allowed'), onShare('allowed')], here('allowed', 'sub'))).toBeNull();
      expect(await allowedFolder([here('allowed')], onShare('allowed', 'sub'))).toBeNull();
      expect(touched).toEqual([]);
      // The other share still works beside it, and is the only one looked at.
      expect(await allowedFolder([here('allowed'), onShare('allowed')], onShare('allowed', 'sub'))).toBe(onShare('allowed', 'sub'));
      expect(touched.filter((p) => p.toUpperCase().startsWith(HERE.toUpperCase()))).toEqual([]);
    });
  });

  it.runIf(process.platform === 'win32')('refuses shares and device paths (before looking at them), and odd Windows paths', async () => {
    const disk = watchDisk();
    try {
      expect(await allowedFolder([allowed], '\\\\ironbooks-test.invalid\\share\\folder')).toBeNull();
      expect(await allowedFolder([allowed], '//ironbooks-test.invalid/share/folder')).toBeNull();
      expect(await allowedFolder(['\\\\ironbooks-test.invalid\\other'], '\\\\ironbooks-test.invalid\\share\\folder')).toBeNull();
      // A server named with a Kelvin sign is another server than the one allowed.
      expect(await allowedFolder([`\\\\ironbooks-test.invalid\\share\\folder`], `\\\\ironbooKs-test.invalid\\share\\folder`.replace('K', KELVIN))).toBeNull();
      expect(await allowedFolder([allowed], `\\\\?\\${sub}`)).toBeNull();
      expect(await allowedFolder([allowed], `\\\\.\\${sub}`)).toBeNull();
      expect(await allowedFolder([`\\\\?\\${allowed}`], sub)).toBeNull();
      expect(await allowedFolder([allowed], `\\??\\${sub}`)).toBeNull();
      // Each is refused by its words: nothing at all was looked at, the local allowed folder included.
      expect(disk.paths(() => true)).toEqual([]);
    } finally {
      disk.restore();
    }
    // A path without a drive, or relative to a drive's current folder.
    expect(await allowedFolder([allowed], sub.slice(2))).toBeNull();
    expect(await allowedFolder([allowed], `${sub.slice(0, 2)}${sub.slice(3)}`)).toBeNull();
    // Device names and alternate data streams along the way.
    expect(await allowedFolder([allowed], path.join(allowed, 'CON'))).toBeNull();
    expect(await allowedFolder([allowed], `${sub}:stream`)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('a share on this very computer is never an allowed folder nor one asked for, and is never looked at', async () => {
    // This computer's own drive as a share: the app's own folders are there under another name.
    const drive = (p: string) => `${p.slice(0, 1).toLowerCase()}$${p.slice(2)}`;
    const servers = ['localhost', '127.0.0.1', '127.1', '[::1]', '0--1.ipv6-literal.net', os.hostname()];
    const disk = watchDisk();
    try {
      for (const server of servers) {
        const onShare = (p: string) => `\\\\${server}\\${drive(p)}`;
        expect(await allowedFolder([onShare(allowed)], onShare(sub)), server).toBeNull();
        expect(await allowedFolder([onShare(allowed)], onShare(allowed)), server).toBeNull();
        expect(await allowedFolder([allowed, onShare(allowed)], onShare(sub)), server).toBeNull();
      }
      expect(disk.paths((p) => /^[\\/]{2}/.test(p))).toEqual([]);
      // Such an entry is left out; the others still count.
      expect(await allowedFolder([`\\\\localhost\\${drive(allowed)}`, allowed], sub)).toBe(real(sub));
      expect(await allowedFolder([`\\\\localhost\\${drive(allowed)}`], sub)).toBeNull();
      expect(disk.paths((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    } finally {
      disk.restore();
    }
  });

  it.runIf(process.platform === 'win32')('a folder the disk answers as a share on this very computer (a mapped drive) is refused, before that share is looked at', async () => {
    const mapped = path.join(base, 'mapped-here');
    fs.mkdirSync(path.join(mapped, 'inner'), { recursive: true });
    const mappedReal = real(mapped);
    const nativeOrig = fs.realpath.native;
    const onShare: string[] = [];
    const see = (p: unknown) => {
      if (/^[\\/]{2}/.test(String(p))) onShare.push(String(p));
    };
    const spies = [
      vi.spyOn(fs.realpath, 'native').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1] as (err: Error | null, out?: string) => void;
        see(p);
        nativeOrig(p, (err, out) => {
          if (err) return cb(err);
          const inside = out === mappedReal || out.startsWith(mappedReal + path.sep);
          cb(null, inside ? `\\\\localhost\\z$${out.slice(mappedReal.length)}` : out);
        });
      }) as never),
      ...['lstat', 'stat', 'readlink', 'realpath'].map((m) => passThrough(fsp, m, see)),
    ];
    try {
      expect(await allowedFolder([mapped], path.join(mapped, 'inner'))).toBeNull();
      expect(await allowedFolder([allowed], path.join(mapped, 'inner'))).toBeNull();
      // An allowed folder that turns out to be on it allows nothing either.
      expect(await allowedFolder([mapped, allowed], sub)).toBe(real(sub));
      expect(onShare).toEqual([]);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    // Without the mapping the same folders are fine (the refusal above is the share's, not the folder's).
    expect(await allowedFolder([mapped], path.join(mapped, 'inner'))).toBe(real(path.join(mapped, 'inner')));
  });

  it('refuses a link inside the allowed folder that leads outside', async (ctx) => {
    const escape = path.join(allowed, 'escape');
    if (!link(outside, escape)) ctx.skip();
    expect(await allowedFolder([allowed], escape)).toBeNull();
    fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
    expect(await allowedFolder([allowed], path.join(escape, 'inner'))).toBeNull();
    // "..": lexically back inside, so that one is fine.
    expect(await allowedFolder([allowed], `${escape}${path.sep}..`)).toBe(real(allowed));
  });

  it('follows a link from outside that leads into the allowed folder, and answers where it leads', async (ctx) => {
    const into = path.join(outside, 'into-allowed');
    if (!link(sub, into)) ctx.skip();
    expect(await allowedFolder([allowed], into)).toBe(real(sub));
  });

  it('an allowed folder that is itself a link is judged by where it leads', async (ctx) => {
    const alias = path.join(base, 'alias-of-outside');
    if (!link(outside, alias)) ctx.skip();
    expect(await allowedFolder([alias], outside)).toBe(real(outside));
    expect(await allowedFolder([alias], allowed)).toBeNull();
  });
});
