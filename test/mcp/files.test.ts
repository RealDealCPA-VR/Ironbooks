/**
 * Files in and out (mcp/files-tools.mjs): uploads in parts, a local file read only from the
 * folders an Admin opened to the agent (real folders, links and junctions on this disk), a staged
 * file handed back as an image, text or base64, and saving a file through a person.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOST_ANSWER_MESSAGE, IronbooksError } from '../../mcp/client.mjs';
import { createIronbooksServer } from '../../mcp/ironbooks-mcp.mjs';
import {
  BASE64_MAX_CHARS,
  FILE_TOOLS,
  NOT_A_PATH_MESSAGE,
  NOT_FOUND_MESSAGE,
  NO_FOLDERS_MESSAGE,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
  contentBlock,
  decodeBase64,
  outsideMessage,
  plainPath,
  readAllowedFile,
  readUpTo,
  uploadBytes,
} from '../../mcp/files-tools.mjs';

type Any = Record<string, any>;
const WIN = process.platform === 'win32';
const FILE = 'cd'.repeat(16);
const ID = '11111111-2222-4333-8444-555555555555';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ironbooks-mcp-files-')));
const ALLOWED = path.join(ROOT, 'allowed');
const OUTSIDE = path.join(ROOT, 'outside');
const SIBLING = path.join(ROOT, 'allowed-sibling');
const CSV = 'date,amount\n2026-03-01,-45.10\n';
const SECRET = 'the payroll export';
/** Links need a privilege on some Windows set-ups; the tests that need one say so when it is missing. */
let fileLink = false;

beforeAll(() => {
  fs.mkdirSync(path.join(ALLOWED, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(ALLOWED, 'a folder'), { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.mkdirSync(SIBLING, { recursive: true });
  fs.writeFileSync(path.join(ALLOWED, 'statement.csv'), CSV);
  fs.writeFileSync(path.join(ALLOWED, 'sub', 'receipt.txt'), 'Paper, $12.00');
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(SIBLING, 'x.txt'), SECRET);
  // A folder link inside the allowed folder that leads out of it (a junction needs no privilege on Windows).
  fs.symlinkSync(OUTSIDE, path.join(ALLOWED, 'link-out'), 'junction');
  // And one that leads to another place inside it.
  fs.symlinkSync(path.join(ALLOWED, 'sub'), path.join(ALLOWED, 'link-in'), 'junction');
  try {
    fs.symlinkSync(path.join(OUTSIDE, 'secret.txt'), path.join(ALLOWED, 'file-link.txt'), 'file');
    fileLink = true;
  } catch {
    fileLink = false;
  }
  // One byte over the cap, without writing 50 MB.
  const fd = fs.openSync(path.join(ALLOWED, 'big.bin'), 'w');
  fs.ftruncateSync(fd, UPLOAD_MAX_BYTES + 1);
  fs.closeSync(fd);
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** A stand-in for the app: get_my_permissions lists `folders`; upload_file keeps what arrives. */
function app(folders: string[] = [ALLOWED]) {
  const acted: Any[] = [];
  const parts: Buffer[] = [];
  let received = 0;
  const client = {
    async act(r: Any) {
      acted.push(r);
      if (r.verb === 'get_my_permissions') return { folders };
      if (r.verb === 'upload_file') {
        const bytes = Buffer.from(r.chunkBase64, 'base64');
        parts.push(bytes);
        received += bytes.length;
        return { uploadId: 'u'.repeat(32), received, file: r.last ? { fileId: FILE, name: r.name, type: r.type, size: received } : null };
      }
      throw new Error(`unexpected ${r.verb}`);
    },
    async get() {
      throw new Error('unexpected read');
    },
  };
  return { client, acted, parts, uploaded: () => Buffer.concat(parts) };
}

async function call(client: unknown, name: string, args: Any = {}) {
  const res = (await createIronbooksServer(client).handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as Any;
  expect(res.error, JSON.stringify(res.error)).toBeUndefined();
  const text: string = res.result.content[0].text;
  let data: Any = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* a message */
  }
  return { isError: res.result.isError as boolean, text, data, content: res.result.content as Any[] };
}

describe('upload_file', () => {
  it('sends a file in parts of UPLOAD_CHUNK_BYTES, each after the first naming the upload, and the last saying so', async () => {
    const bytes = Buffer.alloc(2 * UPLOAD_CHUNK_BYTES + 1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const { client, acted, uploaded } = app();
    const file = await uploadBytes(client, { name: 'scan.pdf', type: 'application/pdf', bytes });
    expect(file).toEqual({ fileId: FILE, name: 'scan.pdf', type: 'application/pdf', size: bytes.length });
    expect(acted.map((a) => [a.verb, a.uploadId ?? null, Buffer.from(a.chunkBase64, 'base64').length, a.last])).toEqual([
      ['upload_file', null, UPLOAD_CHUNK_BYTES, false],
      ['upload_file', 'u'.repeat(32), UPLOAD_CHUNK_BYTES, false],
      ['upload_file', 'u'.repeat(32), 1000, true],
    ]);
    expect(uploaded().equals(bytes)).toBe(true);
    expect(acted.every((a) => a.name === 'scan.pdf' && a.type === 'application/pdf')).toBe(true);
  });

  it('a small file goes in one part, and the answer gives the file id to use', async () => {
    const { client, acted } = app();
    const r = await call(client, 'upload_file', { name: 'statement.csv', type: 'text/csv', base64: Buffer.from(CSV).toString('base64').replace(/(.{20})/g, '$1\n') });
    expect(r.isError, r.text).toBe(false);
    expect(acted).toHaveLength(1);
    expect(acted[0]).toMatchObject({ verb: 'upload_file', name: 'statement.csv', type: 'text/csv', last: true });
    expect(acted[0]).not.toHaveProperty('uploadId');
    expect(r.data).toMatchObject({ file_id: FILE, name: 'statement.csv', type: 'text/csv', size: CSV.length });
    expect(r.data.said).toContain(`{ "fileId": "${FILE}" }`);
  });

  it('refuses what cannot be a file before anything is sent', async () => {
    const { client, acted } = app();
    expect((await call(client, 'upload_file', { name: 'a.txt', type: 'text/plain', base64: 'not base64!' })).text).toMatch(/is not base64 text/);
    expect((await call(client, 'upload_file', { name: 'a.txt', type: 'text/plain', base64: '' })).text).toMatch(/"base64" is required/);
    expect((await call(client, 'upload_file', { name: 'a.txt', type: 'text/plain', base64: '====' })).text).toMatch(/is not base64 text/);
    await expect(uploadBytes(client, { name: 'a.txt', type: 'text/plain', bytes: new Uint8Array(0) })).rejects.toThrow('The file is empty. Nothing was uploaded.');
    await expect(uploadBytes(client, { name: 'huge.bin', type: 'application/octet-stream', bytes: new Uint8Array(UPLOAD_MAX_BYTES + 1) })).rejects.toThrow(/at most 50 MB/);
    expect(acted).toEqual([]);
    expect(decodeBase64('YWJj')!.toString()).toBe('abc');
    expect(decodeBase64('YWJ')).not.toBeNull();
    expect(decodeBase64('Y')).toBeNull();
  });

  it('takes the largest file base64 encoded with line breaks (CR LF every 76 or every 64 characters)', () => {
    const bare = Math.ceil(UPLOAD_MAX_BYTES / 3) * 4;
    const wrapped = (every: number) => bare + 2 * Math.ceil(bare / every);
    const upload = (FILE_TOOLS as Any[]).find((t) => t.name === 'upload_file')!;
    expect(upload.inputSchema.properties.base64.maxLength).toBe(BASE64_MAX_CHARS);
    expect(wrapped(76)).toBeLessThanOrEqual(BASE64_MAX_CHARS);
    expect(wrapped(64)).toBeLessThanOrEqual(BASE64_MAX_CHARS);
    // Not much more: anything longer could not be a file under the cap.
    expect(BASE64_MAX_CHARS).toBeLessThan(bare * 1.04);
  });

  it('an upload whose part was lost, or that did not arrive whole, is to be started over', async () => {
    const lost = { async act() { throw new IronbooksError(LOST_ANSWER_MESSAGE); } };
    await expect(uploadBytes(lost, { name: 'a', type: 'text/plain', bytes: Buffer.from('abc') })).rejects.toThrow('The upload was cut off. Nothing was kept; upload the file again.');
    const short = { async act() { return { uploadId: 'u', received: 1, file: { fileId: FILE } }; } };
    await expect(uploadBytes(short, { name: 'a', type: 'text/plain', bytes: Buffer.from('abc') })).rejects.toThrow(/did not arrive whole/);
    const noId = { async act() { return { received: UPLOAD_CHUNK_BYTES, file: null }; } };
    await expect(uploadBytes(noId, { name: 'a', type: 'text/plain', bytes: new Uint8Array(UPLOAD_CHUNK_BYTES + 1) })).rejects.toThrow(/did not start the upload/);
  });
});

describe('attach_local_file: only from the folders an Admin opened to the agent', () => {
  it('reads a file inside an allowed folder and hands it over, named and typed from the file', async () => {
    const { client, acted, uploaded } = app();
    const r = await call(client, 'attach_local_file', { path: path.join(ALLOWED, 'statement.csv') });
    expect(r.isError, r.text).toBe(false);
    expect(acted.map((a) => a.verb)).toEqual(['get_my_permissions', 'upload_file']);
    expect(acted[1]).toMatchObject({ name: 'statement.csv', type: 'text/csv', last: true });
    expect(uploaded().toString()).toBe(CSV);
    expect(r.data).toMatchObject({ file_id: FILE, name: 'statement.csv', type: 'text/csv' });
    // In a folder inside it, under another name and type, and through a link that stays inside.
    const sub = await call(app().client, 'attach_local_file', { path: path.join(ALLOWED, 'sub', 'receipt.txt'), name: 'Receipt 12.txt', type: 'text/plain' });
    expect(sub.data).toMatchObject({ name: 'Receipt 12.txt', type: 'text/plain' });
    const linked = app();
    expect((await call(linked.client, 'attach_local_file', { path: path.join(ALLOWED, 'link-in', 'receipt.txt') })).isError).toBe(false);
    expect(linked.uploaded().toString()).toBe('Paper, $12.00');
  });

  it('refuses a file outside them, in plain words, and sends nothing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const p of [
        path.join(OUTSIDE, 'secret.txt'),
        // ".." out of the allowed folder
        path.join(ALLOWED, '..', 'outside', 'secret.txt'),
        `${ALLOWED}${path.sep}sub${path.sep}..${path.sep}..${path.sep}outside${path.sep}secret.txt`,
        // a folder whose name merely starts with the allowed one's
        path.join(SIBLING, 'x.txt'),
        // a folder link inside the allowed folder that leads out of it
        path.join(ALLOWED, 'link-out', 'secret.txt'),
        // missing, outside: refused the same way, so nothing is learnt about what exists there
        path.join(OUTSIDE, 'no-such-file.txt'),
        // missing behind a link that leads out: the same again, not "could not be found"
        path.join(ALLOWED, 'link-out', 'no-such-file.txt'),
        path.join(ALLOWED, 'link-out', 'no-such-folder', 'x.txt'),
      ]) {
        const { client, acted } = app();
        const r = await call(client, 'attach_local_file', { path: p });
        expect(r.isError, p).toBe(true);
        expect(r.text, p).toBe(outsideMessage([ALLOWED]));
        expect(r.text).not.toContain(SECRET);
        expect(acted.map((a) => a.verb), p).toEqual(['get_my_permissions']);
      }
      // Each refusal is written to the connector's log.
      expect(stderr.mock.calls.filter(([line]) => String(line).includes('attach_local_file refused')).length).toBe(8);
      // Missing behind a link that stays inside: that is in an allowed folder, so it is said.
      await expect(readAllowedFile(path.join(ALLOWED, 'link-in', 'no-such-file.txt'), [ALLOWED])).rejects.toThrow(NOT_FOUND_MESSAGE);
    } finally {
      stderr.mockRestore();
    }
  });

  it('a file link inside the allowed folder that leads out of it is refused too', async () => {
    if (!fileLink) {
      console.warn('file links cannot be made here (no privilege); covered by the folder link case');
      return;
    }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { client, acted } = app();
      const r = await call(client, 'attach_local_file', { path: path.join(ALLOWED, 'file-link.txt') });
      expect(r.text).toBe(outsideMessage([ALLOWED]));
      expect(acted).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it('says plainly what else is wrong: missing, a folder, too large, no folders, not a full path', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const run = async (args: Any, folders?: string[]) => {
        const { client, acted } = app(folders);
        const r = await call(client, 'attach_local_file', args);
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(acted.filter((a) => a.verb === 'upload_file')).toEqual([]);
        return r.text;
      };
      expect(await run({ path: path.join(ALLOWED, 'missing.csv') })).toBe(NOT_FOUND_MESSAGE);
      expect(await run({ path: path.join(ALLOWED, 'no-such-folder', 'x.csv') })).toBe(NOT_FOUND_MESSAGE);
      expect(await run({ path: path.join(ALLOWED, 'a folder') })).toBe('That is not a file. Give the path of one file.');
      expect(await run({ path: ALLOWED })).toBe('That is not a file. Give the path of one file.');
      expect(await run({ path: path.join(ALLOWED, 'big.bin') })).toMatch(/^The file is 50\.0 MB; at most 50 MB can be handed to Ironbooks\. Nothing was uploaded\.$/);
      expect(await run({ path: path.join(ALLOWED, 'statement.csv') }, [])).toBe(NO_FOLDERS_MESSAGE);
      expect(stderr).not.toHaveBeenCalled();
      expect(await run({ path: 'statement.csv' })).toBe(NOT_A_PATH_MESSAGE);
      expect(await run({ path: `.${path.sep}allowed${path.sep}statement.csv` })).toBe(NOT_A_PATH_MESSAGE);
      // A path that is not a plain full path is a refusal too, and is written to the log, quoted.
      const logged = stderr.mock.calls.map(([line]) => String(line));
      expect(logged).toEqual([
        '[ironbooks-mcp] attach_local_file refused "statement.csv": not a plain full path (relative, a device, a stream or a device name).\n',
        `[ironbooks-mcp] attach_local_file refused ${JSON.stringify(`.${path.sep}allowed${path.sep}statement.csv`)}: not a plain full path (relative, a device, a stream or a device name).\n`,
      ]);
      // A path cannot add lines of its own to the log.
      await expect(readAllowedFile('a\nb', [ALLOWED])).rejects.toThrow(NOT_A_PATH_MESSAGE);
      expect(String(stderr.mock.calls.at(-1)![0])).toBe('[ironbooks-mcp] attach_local_file refused "a\\nb": not a plain full path (relative, a device, a stream or a device name).\n');
    } finally {
      stderr.mockRestore();
    }
  });

  it('never holds more than the cap in memory, even when a file is larger than it said', async () => {
    const p = path.join(ALLOWED, 'twenty.txt');
    fs.writeFileSync(p, '01234567890123456789');
    const handle = await fsp.open(p, 'r');
    try {
      // Told it is empty (it grew after it was looked at): still read to the cap, and no further.
      expect(await readUpTo(handle, 10, 0)).toBeNull();
      expect((await readUpTo(handle, 20, 0))!.toString()).toBe('01234567890123456789');
      expect((await readUpTo(handle, 25, 3))!.toString()).toBe('01234567890123456789');
    } finally {
      await handle.close();
      fs.rmSync(p);
    }
  });

  it.runIf(WIN)('Windows: device names, streams, device paths and other computers\' shares are refused before the disk is touched', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Every way this connector looks at the disk. Each fails loudly, so a slip cannot reach a share.
    const touched: string[] = [];
    const deny = (name: string) => async (p: unknown) => {
      touched.push(`${name} ${String(p)}`);
      throw new Error(`touched ${name}`);
    };
    const spies = [
      vi.spyOn(fsp, 'lstat').mockImplementation(deny('lstat') as never),
      vi.spyOn(fsp, 'readlink').mockImplementation(deny('readlink') as never),
      vi.spyOn(fsp, 'realpath').mockImplementation(deny('realpath') as never),
      vi.spyOn(fsp, 'stat').mockImplementation(deny('stat') as never),
      vi.spyOn(fsp, 'open').mockImplementation(deny('open') as never),
      vi.spyOn(fs.realpath, 'native').mockImplementation(((p: unknown) => touched.push(`realpath.native ${String(p)}`)) as never),
    ];
    try {
      const refused = [path.join(ALLOWED, 'CON'), path.join(ALLOWED, 'nul.txt'), `${path.join(ALLOWED, 'statement.csv')}:hidden`, `\\\\?\\${path.join(ALLOWED, 'statement.csv')}`, `\\\\.\\${path.join(ALLOWED, 'statement.csv')}`];
      for (const p of refused) {
        expect(plainPath(p), p).toBeNull();
        await expect(readAllowedFile(p, [ALLOWED]), p).rejects.toThrow(NOT_A_PATH_MESSAGE);
      }
      // A share no allowed folder is on: refused as outside, without looking at it.
      await expect(readAllowedFile('\\\\some-server\\share\\statement.csv', [ALLOWED])).rejects.toThrow(outsideMessage([ALLOWED]));
      await expect(readAllowedFile('//some-server/share/statement.csv', [ALLOWED])).rejects.toThrow(outsideMessage([ALLOWED]));
      expect(touched).toEqual([]);
      // Each was logged as a refusal.
      expect(stderr.mock.calls.filter(([line]) => String(line).includes('attach_local_file refused')).length).toBe(refused.length + 2);
      // And the watch works: a path that is looked at is seen being looked at.
      await expect(readAllowedFile(path.join(ALLOWED, 'statement.csv'), [ALLOWED])).rejects.toThrow();
      expect(touched.length).toBeGreaterThan(0);
    } finally {
      for (const s of spies) s.mockRestore();
      stderr.mockRestore();
    }
    expect(plainPath('C:statement.csv')).toBeNull();
    expect(plainPath('\\statement.csv')).toBeNull();
    // Case does not matter on Windows.
    const upper = await readAllowedFile(path.join(ALLOWED.toUpperCase(), 'statement.csv'), [ALLOWED]);
    expect(upper.bytes.toString()).toBe(CSV);
  });

  it('an allowed folder given with ".." or a trailing separator still works; one that is not a full path is ignored', async () => {
    const r = await readAllowedFile(path.join(ALLOWED, 'statement.csv'), [`${path.join(ALLOWED, 'sub', '..')}${path.sep}`, 'relative/folder']);
    expect(r.bytes.toString()).toBe(CSV);
    await expect(readAllowedFile(path.join(ALLOWED, 'statement.csv'), ['relative/folder'])).rejects.toThrow(NO_FOLDERS_MESSAGE);
  });
});

describe('get_file and save_file', () => {
  const staged = (type: string, bytes: Buffer, name = 'f') => ({
    async act(r: Any) {
      if (r.verb !== 'get_file' || r.fileId !== FILE) throw new IronbooksError('Not found', { status: 404 });
      return { file: { fileId: FILE, name, type, size: bytes.length }, base64: bytes.toString('base64') };
    },
  });

  it('an image comes back as an image, text as text, anything else as base64, each with its details', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const img = await call(staged('image/png', png, 'logo.png'), 'get_file', { file_id: FILE });
    expect(img.content).toEqual([
      { type: 'text', text: JSON.stringify({ file_id: FILE, name: 'logo.png', type: 'image/png', size: 4 }) },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    const csv = await call(staged('text/csv', Buffer.from(CSV)), 'get_file', { file_id: FILE });
    expect(csv.content[1]).toEqual({ type: 'resource', resource: { uri: `ironbooks://files/${FILE}`, mimeType: 'text/csv', text: CSV } });
    const pdf = await call(staged('application/pdf', Buffer.from('%PDF-1.7')), 'get_file', { file_id: FILE });
    expect(pdf.content[1]).toEqual({ type: 'resource', resource: { uri: `ironbooks://files/${FILE}`, mimeType: 'application/pdf', blob: Buffer.from('%PDF-1.7').toString('base64') } });
    // Text that is not UTF-8 goes as bytes, unchanged.
    expect(contentBlock({ fileId: FILE, type: 'text/plain' }, Buffer.from([0xff, 0xfe, 0x00]).toString('base64'))).toMatchObject({ resource: { blob: '//4A' } });
    const missing = await call(staged('text/csv', Buffer.from(CSV)), 'get_file', { file_id: 'ef'.repeat(16) });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/There is no file with that file_id/);
  });

  it('a staged file is also a resource', async () => {
    const server = createIronbooksServer(staged('text/csv', Buffer.from(CSV)));
    const read = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `ironbooks://files/${FILE}` } })) as Any;
    expect(read.result.contents).toEqual([{ uri: `ironbooks://files/${FILE}`, mimeType: 'text/csv', text: CSV }]);
    expect(await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ironbooks://files/..%2F..%2Fx' } })).toMatchObject({ error: { code: -32002 } });
  });

  it('save_file asks a person, with the folder and the reason, and says to wait', async () => {
    const acted: Any[] = [];
    const client = { async act(r: Any) { acted.push(r); return { operation: 'files.save', outcome: 'asked', requestId: ID, status: 'pending' }; } };
    const r = await call(client, 'save_file', { file_id: FILE, folder: ALLOWED, name: 'Invoice 1042.pdf', request_id: 'save-1042', reason: 'The owner wants the PDF in the books folder.' });
    expect(acted).toEqual([{ verb: 'save_file', fileId: FILE, folder: ALLOWED, name: 'Invoice 1042.pdf', requestId: 'save-1042', reason: 'The owner wants the PDF in the books folder.' }]);
    expect(r.data).toMatchObject({ outcome: 'asked', request_id: ID });
    expect(r.data.next).toMatch(/wait_for_decision/);
    expect((await call(client, 'save_file', { file_id: FILE, folder: ALLOWED })).text).toMatch(/"request_id" is required/);
    expect(acted).toHaveLength(1);
  });
});
