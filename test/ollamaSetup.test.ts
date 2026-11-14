/**
 * electron/ollamaSetup.js — "Set up free AI" installs Ollama. Windows: download the official
 * installer from ollama.com (redirects only to Ollama / GitHub), check it is signed by Ollama, and
 * only then start it. Elsewhere: open the download page. A cut-off download, a redirect elsewhere
 * or an unsigned file never runs.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installOllama, checkSignature, allowedUrl, downloadTo, signedByOllama } = require('../electron/ollamaSetup.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ollama-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function fakeDownload(bytes: Uint8Array, opts: { url?: string; length?: number; status?: number } = {}) {
  return vi.fn(async () => {
    const res = new Response(new Blob([bytes as BlobPart]), { status: opts.status ?? 200, headers: { 'content-length': String(opts.length ?? bytes.length) } });
    Object.defineProperty(res, 'url', { value: opts.url ?? 'https://github.com/ollama/ollama/releases/download/v1/OllamaSetup.exe' });
    return res;
  });
}

describe('installOllama', () => {
  it('macOS / Linux: opens the download page, runs nothing', async () => {
    const openPage = vi.fn(async () => undefined);
    const launch = vi.fn();
    expect(await installOllama({ platform: 'darwin', tmpDir, openPage, launch })).toEqual({ done: 'page-opened' });
    expect(openPage).toHaveBeenCalledWith('https://ollama.com/download');
    expect(launch).not.toHaveBeenCalled();
  });

  it('Windows: downloads, checks the signature, then starts the installer', async () => {
    const launch = vi.fn(async () => undefined);
    const progress: number[] = [];
    const r = await installOllama({
      platform: 'win32',
      tmpDir,
      fetchImpl: fakeDownload(new Uint8Array(5000).fill(7)),
      checkSig: async () => ({ ok: true, status: 'Valid', subject: 'CN=Ollama Inc., O=Ollama Inc.' }),
      launch,
      openPage: vi.fn(),
      onProgress: (p: { received: number }) => progress.push(p.received),
    });
    expect(r).toEqual({ done: 'installer-started' });
    const file = path.join(tmpDir, 'OllamaSetup.exe');
    expect(launch).toHaveBeenCalledWith(file);
    expect(fs.statSync(file).size).toBe(5000);
    expect(progress.at(-1)).toBe(5000);
  });

  it('Windows: an installer not signed by Ollama is deleted and never started', async () => {
    const launch = vi.fn();
    await expect(
      installOllama({
        platform: 'win32',
        tmpDir,
        fetchImpl: fakeDownload(new Uint8Array(10)),
        checkSig: async () => ({ ok: false, status: 'NotSigned', subject: '' }),
        launch,
        openPage: vi.fn(),
      }),
    ).rejects.toThrow(/not signed by Ollama.*did not run it/);
    expect(launch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'OllamaSetup.exe'))).toBe(false);
  });

  it('Windows: a redirect off Ollama / GitHub, or a cut-off download, is refused', async () => {
    const base = { platform: 'win32', tmpDir, checkSig: async () => ({ ok: true }), launch: vi.fn(), openPage: vi.fn() };
    await expect(installOllama({ ...base, fetchImpl: fakeDownload(new Uint8Array(10), { url: 'https://evil.example/x.exe' }) })).rejects.toThrow(/redirected/);
    await expect(installOllama({ ...base, fetchImpl: fakeDownload(new Uint8Array(10), { length: 99 }) })).rejects.toThrow(/cut off/);
    expect(base.launch).not.toHaveBeenCalled();
  });

  it('only https Ollama addresses, Ollama releases on GitHub and GitHub download hosts are allowed', () => {
    expect(allowedUrl('https://ollama.com/download/OllamaSetup.exe')).toBe(true);
    expect(allowedUrl('https://github.com/ollama/ollama/releases/download/v1/OllamaSetup.exe')).toBe(true);
    expect(allowedUrl('https://objects.githubusercontent.com/x')).toBe(true);
    expect(allowedUrl('https://github.com/someone-else/ollama/releases/download/v1/OllamaSetup.exe')).toBe(false);
    expect(allowedUrl('https://evil.githubusercontent.com/x')).toBe(false);
    expect(allowedUrl('http://ollama.com/x')).toBe(false);
    expect(allowedUrl('https://ollama.com.evil.example/x')).toBe(false);
  });

  it('a download that stalls gives up, and Cancel stops it', async () => {
    const never = vi.fn(async (_u: string, init: RequestInit) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(3));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      const res = new Response(body, { status: 200, headers: { 'content-length': '100' } });
      Object.defineProperty(res, 'url', { value: 'https://ollama.com/download/OllamaSetup.exe' });
      return res;
    });
    const dest = path.join(tmpDir, 'stall.exe');
    await expect(downloadTo('https://ollama.com/download/OllamaSetup.exe', dest, { fetchImpl: never, stallMs: 50 })).rejects.toThrow(/stopped/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await expect(downloadTo('https://ollama.com/download/OllamaSetup.exe', dest, { fetchImpl: never, signal: ac.signal, stallMs: 5000 })).rejects.toThrow(/cancelled/);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('signedByOllama', () => {
  it('needs the organization to be exactly Ollama, not a look-alike', () => {
    expect(signedByOllama('CN=Ollama Inc., O=Ollama Inc., L=Palo Alto, S=California, C=US')).toBe(true);
    expect(signedByOllama('CN="Ollama, Inc.", O="Ollama, Inc.", C=US')).toBe(true);
    expect(signedByOllama('CN=Ollama Tools LLC, O=Ollama Tools LLC')).toBe(false);
    expect(signedByOllama('CN=Mallory, OU="O=Ollama Inc.", O=Mallory Ltd')).toBe(false);
    expect(signedByOllama('CN=Ollama Inc.')).toBe(false);
  });
});

describe('checkSignature', () => {
  it('needs a Valid signature whose signer is Ollama', async () => {
    const run = (out: object) => async () => JSON.stringify(out);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: 'CN=Ollama Inc., O=Ollama Inc., C=US' }) })).ok).toBe(true);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: 'CN=Someone Else LLC' }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: run({ status: 'Valid', subject: 'CN=Ollama Tools LLC, O=Ollama Tools LLC' }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: run({ status: 'HashMismatch', subject: 'CN=Ollama Inc.' }) })).ok).toBe(false);
    expect((await checkSignature('x', { run: async () => '' })).ok).toBe(false);
  });
});
