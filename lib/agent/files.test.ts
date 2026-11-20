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
 *  - One agent keeps at most 500 MB or 1000 files at once; other agents are not affected.
 *  - Old files and uploads are cleared (by age, or all), also lazily (when adding and when reading);
 *    clearing a missing folder is fine; a full clear at the same time as writes never fails them.
 *  - Where: beside the open company file; never in a folder that holds the books or lies inside
 *    them; a folder Ironbooks did not make is never cleared, nor used when it holds other things;
 *    the override is for test runs only.
 *  - allowedFolder: the folder itself or below, never beside or above (".."), case on Windows,
 *    links that lead outside, shares (refused, and accepted when an allowed folder names the share)
 *    and device paths.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAGED_FILE_HOURS, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES, type FileOwner } from './contract';
import { AGENT_FILES_DIR_ENV, allowedFolder, clearStagedFiles, readStagedFile, stagedFileInfo, stagedFilesRoot, stageFile, uploadChunk } from './files';
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

const ENV_KEYS = [AGENT_FILES_DIR_ENV, 'BKA_COMPANY_STATE', 'BKA_DATA_DIR', 'BKA_COMPANY_FILE', 'NODE_ENV'] as const;
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
    expect(meta).toEqual({ name: 'November.csv', type: 'text/csv', size: bytes.length, created: expect.any(String) });
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
    const looks = [
      vi.spyOn(fsp, 'lstat'),
      vi.spyOn(fsp, 'stat'),
      vi.spyOn(fsp, 'readFile'),
      vi.spyOn(fsp, 'readdir'),
      vi.spyOn(fsp, 'open'),
      vi.spyOn(fsp, 'realpath'),
    ];
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
      for (const spy of looks) expect(spy).not.toHaveBeenCalled();
      // The watch works: a well-formed id is looked for.
      noLazyClear();
      expect((await readStagedFile(me, file.fileId))?.file.name).toBe('a.txt');
      expect(looks[0]).toHaveBeenCalled();
    } finally {
      for (const spy of looks) spy.mockRestore();
      noLazyClear();
    }
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

  it('one agent keeps at most 500 MB at once, uploads included; other agents are not affected; expired files stop counting', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const up = await uploadChunk(owner, { name: 'u.bin', type: 'application/octet-stream', chunkBase64: b64('u'), last: false });
    const big = await stageFile(owner, { name: 'big.bin', type: 'application/octet-stream', bytes: Buffer.from('b') });
    const bigBin = path.join(dir, `${big.fileId}.bin`);
    try {
      // As if the agent kept almost 500 MB: 1 byte of upload, the rest in one file; 5 bytes still fit.
      fs.truncateSync(bigBin, MAX_BYTES - 6);
      const err = await refusal(uploadChunk(owner, { uploadId: up.uploadId, name: 'u.bin', type: 'application/octet-stream', chunkBase64: b64('123456'), last: false }));
      expect(err.code).toBe('VALIDATION');
      expect(err.message).toMatch(/500 MB/);
      // The upload is not stopped by that: a smaller part still fits.
      expect(fs.existsSync(path.join(dir, `${up.uploadId}.part`))).toBe(true);
      const done = await uploadChunk(owner, { uploadId: up.uploadId, name: 'u.bin', type: 'application/octet-stream', chunkBase64: b64('12345'), last: true });
      expect(done.file?.size).toBe(6);

      // Full now: nothing more, in any way.
      await refusal(stageFile(owner, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
      await refusal(uploadChunk(owner, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
      await refusal(uploadChunk(owner, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: false }));
      // Another agent is not affected.
      expect((await stageFile(otherAgent, { name: 'y.txt', type: 'text/plain', bytes: Buffer.from('y') })).size).toBe(1);
      // A file older than a day no longer counts.
      age(bigBin, STAGED_FILE_HOURS + 1);
      expect((await stageFile(owner, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') })).size).toBe(1);
    } finally {
      fs.rmSync(bigBin, { force: true });
    }
  });

  it('one agent keeps at most 1000 files at once', async () => {
    const owner: FileOwner = { companyId: COMPANY, agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    const dir = path.join(limitsRoot, owner.companyId, owner.agentId);
    const first = await stageFile(owner, { name: 'first.txt', type: 'text/plain', bytes: Buffer.from('1') });
    // As if it had staged 999 more.
    for (let i = 1; i < MAX_FILES; i++) fs.writeFileSync(path.join(dir, `${i.toString(16).padStart(32, '0')}.bin`), '');
    const err = await refusal(stageFile(owner, { name: 'one-more.txt', type: 'text/plain', bytes: Buffer.from('x') }));
    expect(err.message).toMatch(/1000 files/);
    await refusal(uploadChunk(owner, { name: 'x', type: 'text/plain', chunkBase64: b64('x'), last: true }));
    age(path.join(dir, `${first.fileId}.bin`), STAGED_FILE_HOURS + 1);
    expect((await stageFile(owner, { name: 'one-more.txt', type: 'text/plain', bytes: Buffer.from('x') })).size).toBe(1);
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

  it.runIf(process.platform === 'win32')('a folder on a network share or a device path is refused (fail closed)', async () => {
    for (const root of ['\\\\ironbooks-test.invalid\\share\\agent-files', `\\\\?\\${ROOT}`]) {
      process.env[AGENT_FILES_DIR_ENV] = root;
      const err = await refusal(stageFile(me, { name: 'x.txt', type: 'text/plain', bytes: Buffer.from('x') }));
      expect(err.code).toBe('INTERNAL');
      expect(await readStagedFile(me, 'a'.repeat(32))).toBeNull();
      await expect(clearStagedFiles()).rejects.toBeInstanceOf(ServiceError);
    }
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

  it.runIf(process.platform === 'win32')('refuses shares and device paths (before looking at them), and odd Windows paths', async () => {
    expect(await allowedFolder([allowed], '\\\\ironbooks-test.invalid\\share\\folder')).toBeNull();
    expect(await allowedFolder([allowed], '//ironbooks-test.invalid/share/folder')).toBeNull();
    expect(await allowedFolder(['\\\\ironbooks-test.invalid\\other'], '\\\\ironbooks-test.invalid\\share\\folder')).toBeNull();
    expect(await allowedFolder([allowed], `\\\\?\\${sub}`)).toBeNull();
    expect(await allowedFolder([allowed], `\\\\.\\${sub}`)).toBeNull();
    expect(await allowedFolder([`\\\\?\\${allowed}`], sub)).toBeNull();
    expect(await allowedFolder([allowed], `\\??\\${sub}`)).toBeNull();
    // A path without a drive, or relative to a drive's current folder.
    expect(await allowedFolder([allowed], sub.slice(2))).toBeNull();
    expect(await allowedFolder([allowed], `${sub.slice(0, 2)}${sub.slice(3)}`)).toBeNull();
    // Device names and alternate data streams along the way.
    expect(await allowedFolder([allowed], path.join(allowed, 'CON'))).toBeNull();
    expect(await allowedFolder([allowed], `${sub}:stream`)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('accepts a folder on a share that an allowed folder itself names, and only below it', async (ctx) => {
    // This computer's own drive as a share (\\localhost\c$), where the system offers one.
    const onShare = (p: string) => `\\\\localhost\\${p.slice(0, 1).toLowerCase()}$${p.slice(2)}`;
    let reachable = false;
    try {
      reachable = fs.statSync(onShare(allowed)).isDirectory();
    } catch {
      /* no such share here */
    }
    if (!reachable) ctx.skip();
    const got = await allowedFolder([onShare(allowed)], onShare(sub));
    expect(got?.toLowerCase()).toBe(onShare(real(sub)).toLowerCase());
    // The share's name is compared without case.
    expect(await allowedFolder([onShare(allowed).toUpperCase()], onShare(sub))).not.toBeNull();
    // Still never beside or above the allowed folder on that share.
    expect(await allowedFolder([onShare(allowed)], onShare(outside))).toBeNull();
    expect(await allowedFolder([onShare(allowed)], `${onShare(allowed)}\\..\\allowed-evil`)).toBeNull();
    // A share entry allows nothing off the share, and a local entry nothing on it.
    expect(await allowedFolder([onShare(allowed)], sub)).toBeNull();
    expect(await allowedFolder([allowed], onShare(sub))).toBeNull();
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
