/**
 * Security plan 4.7 — the Ollama installer check (electron/ollamaSetup.js).
 *  - The signer must be Ollama's organisation in full: a certificate that merely contains the
 *    word "Ollama" (or is just "Ollama") is refused, and the signature must be Valid.
 *  - The checked file's SHA-256 travels with it, and the file is checked again right before it
 *    starts: a file changed after the signature check never runs.
 *  - Each download goes into a fresh, randomly named folder; earlier downloads are cleaned up.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkSignature, signedByOllama, verifyInstaller, stillSameFile, installOllama } = require('../electron/ollamaSetup.js');

const roots: string[] = [];
function freshRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec1-ollama-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const OLLAMA_SIG = { ok: true, status: 'Valid', subject: 'CN=Ollama Inc., O=Ollama Inc., L=Palo Alto, S=California, C=US' };

function fakeDownload(bytes: Uint8Array) {
  return vi.fn(async () => {
    const res = new Response(new Blob([bytes as BlobPart]), { status: 200, headers: { 'content-length': String(bytes.length) } });
    Object.defineProperty(res, 'url', { value: 'https://github.com/ollama/ollama/releases/download/v1/OllamaSetup.exe' });
    return res;
  });
}

describe('signer: Ollama in full, nothing that merely contains the word', () => {
  it('refuses look-alike and bare organisation names', () => {
    expect(signedByOllama('CN=Evil, O=Not Ollama LLC')).toBe(false);
    expect(signedByOllama('CN=Evil, O=ollama-fake')).toBe(false);
    expect(signedByOllama('O=ollama-fake')).toBe(false);
    expect(signedByOllama('CN=Ollama, O=Ollama, C=US')).toBe(false);
    expect(signedByOllama('CN=Ollama Inc., O=Ollama Inc. Holdings')).toBe(false);
    expect(signedByOllama('CN=Ollama Inc., O="Ollama Inc. "')).toBe(false);
    expect(signedByOllama('CN=x, O="Mallory"", O=""Ollama Inc."')).toBe(false);
  });

  it('refuses a subject with a second organisation next to Ollama', () => {
    expect(signedByOllama('CN=Ollama Inc., O=Ollama Inc., O=Mallory Ltd')).toBe(false);
    expect(signedByOllama('CN=Mallory, O=Mallory Ltd, O=Ollama Inc.')).toBe(false);
  });

  it('accepts Ollama’s own name, in either spelling and any letter case', () => {
    expect(signedByOllama('CN=Ollama Inc., O=Ollama Inc., L=Palo Alto, S=California, C=US')).toBe(true);
    expect(signedByOllama('CN="Ollama, Inc.", O="Ollama, Inc.", C=US')).toBe(true);
    expect(signedByOllama('CN=OLLAMA INC., O=OLLAMA INC., C=US')).toBe(true);
  });

  it('checkSignature needs Valid AND the exact signer', async () => {
    const run = (out: object) => async () => JSON.stringify(out);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: 'CN=Evil, O=Not Ollama LLC' }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: 'CN=Evil, O=ollama-fake' }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: 'CN=Ollama, O=Ollama' }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: run({ status: 'NotTrusted', subject: OLLAMA_SIG.subject }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: OLLAMA_SIG.subject }) })).ok).toBe(true);
  });
});

describe('verifyInstaller and stillSameFile', () => {
  it('decides on the status and signer itself, whatever the injected check claims', async () => {
    const file = path.join(freshRoot(), 'OllamaSetup.exe');
    fs.writeFileSync(file, 'installer');
    const claim = (sig: object) => async () => sig;
    expect((await verifyInstaller(file, { checkSig: claim({ ok: true, status: 'Valid', subject: 'CN=Evil, O=Not Ollama LLC' }) })).ok).toBe(false);
    expect((await verifyInstaller(file, { checkSig: claim({ ok: true, status: 'Valid', subject: 'O=ollama-fake' }) })).ok).toBe(false);
    expect((await verifyInstaller(file, { checkSig: claim({ ok: true, status: 'HashMismatch', subject: OLLAMA_SIG.subject }) })).ok).toBe(false);
    expect((await verifyInstaller(file, { checkSig: claim({ ok: true }) })).ok).toBe(false);
  });

  it('returns the path and the SHA-256 of the file it checked', async () => {
    const file = path.join(freshRoot(), 'OllamaSetup.exe');
    fs.writeFileSync(file, 'installer bytes');
    const v = await verifyInstaller(file, { checkSig: async () => OLLAMA_SIG });
    expect(v).toMatchObject({ ok: true, status: 'Valid', path: file, sha256: sha256('installer bytes') });
    // With the hash taken while downloading, that is the one carried forward.
    const given = sha256('installer bytes');
    expect((await verifyInstaller(file, { checkSig: async () => OLLAMA_SIG, sha256: given })).sha256).toBe(given);
  });

  it('stillSameFile: true only for the very same bytes', async () => {
    const file = path.join(freshRoot(), 'OllamaSetup.exe');
    fs.writeFileSync(file, 'installer bytes');
    const v = await verifyInstaller(file, { checkSig: async () => OLLAMA_SIG });
    expect(await stillSameFile(v.path, v.sha256)).toBe(true);
    fs.writeFileSync(file, 'installer bytez');
    expect(await stillSameFile(v.path, v.sha256)).toBe(false);
    fs.rmSync(file);
    expect(await stillSameFile(v.path, v.sha256)).toBe(false);
    expect(await stillSameFile(v.path, '')).toBe(false);
    expect(await stillSameFile(v.path, undefined)).toBe(false);
  });
});

describe('installOllama: private download folder and a last check before it runs', () => {
  it('a file changed after the signature check is never started, and is removed', async () => {
    const root = freshRoot();
    const launch = vi.fn();
    await expect(
      installOllama({
        platform: 'win32',
        tmpDir: path.join(root, 'ironbooks-ollama'),
        fetchImpl: fakeDownload(new Uint8Array(64).fill(1)),
        // Something swaps the file while (or just after) the signature is being checked.
        checkSig: async (file: string) => {
          fs.writeFileSync(file, 'something else');
          return OLLAMA_SIG;
        },
        launch,
        openPage: vi.fn(),
      }),
    ).rejects.toThrow(/changed after it was checked.*did not run it/);
    expect(launch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('downloads into a new random folder, passes the download’s SHA-256 to launch, and clears old downloads', async () => {
    const root = freshRoot();
    // Left behind by older versions (the fixed folder) and by an earlier install.
    fs.mkdirSync(path.join(root, 'ironbooks-ollama'));
    fs.writeFileSync(path.join(root, 'ironbooks-ollama', 'OllamaSetup.exe'), 'old');
    fs.mkdirSync(path.join(root, 'ironbooks-ollama-AbC123'));
    fs.writeFileSync(path.join(root, 'ironbooks-ollama-AbC123', 'OllamaSetup.exe'), 'older');
    // Not ours: left alone.
    fs.mkdirSync(path.join(root, 'ironbooks-ollama-notes'));
    fs.writeFileSync(path.join(root, 'ironbooks-ollama.txt'), 'keep');

    const bytes = new Uint8Array(4096).fill(9);
    const launch = vi.fn(async () => undefined);
    const r = await installOllama({
      platform: 'win32',
      tmpDir: path.join(root, 'ironbooks-ollama'),
      fetchImpl: fakeDownload(bytes),
      checkSig: async () => OLLAMA_SIG,
      launch,
      openPage: vi.fn(),
    });
    expect(r).toEqual({ done: 'installer-started' });
    const [file, extra] = launch.mock.calls[0] as unknown as [string, { sha256: string }];
    const folder = path.basename(path.dirname(file));
    expect(folder).toMatch(/^ironbooks-ollama-[A-Za-z0-9]{6}$/);
    expect(folder).not.toBe('ironbooks-ollama-AbC123');
    expect(extra.sha256).toBe(sha256(bytes));
    expect(await stillSameFile(file, extra.sha256)).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual([folder, 'ironbooks-ollama-notes', 'ironbooks-ollama.txt'].sort());

    // The next install clears this one too.
    await installOllama({
      platform: 'win32',
      tmpDir: path.join(root, 'ironbooks-ollama'),
      fetchImpl: fakeDownload(bytes),
      checkSig: async () => OLLAMA_SIG,
      launch: vi.fn(async () => undefined),
      openPage: vi.fn(),
    });
    expect(fs.existsSync(path.join(root, folder))).toBe(false);
  });

  it('a signer that only contains the word Ollama is refused end to end', async () => {
    const root = freshRoot();
    const launch = vi.fn();
    await expect(
      installOllama({
        platform: 'win32',
        tmpDir: path.join(root, 'ironbooks-ollama'),
        fetchImpl: fakeDownload(new Uint8Array(32)),
        checkSig: async () => ({ ok: true, status: 'Valid', subject: 'CN=Evil, O=Not Ollama LLC' }),
        launch,
        openPage: vi.fn(),
      }),
    ).rejects.toThrow(/not signed by Ollama.*did not run it/);
    expect(launch).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
