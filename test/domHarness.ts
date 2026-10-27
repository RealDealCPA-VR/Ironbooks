/**
 * DOM tests in a real browser engine, without a fake DOM: a *.dom.tsx file (test/dom/kit.tsx API)
 * is bundled with esbuild and run in a hidden Electron window (test/dom/runner.cjs), which presses
 * keys through DevTools input — trusted events, so Tab really moves focus and letters really type.
 *
 *   const results = await runDomFile('test/dom/keyboard.dom.tsx');
 *   expectAllPassed(results);
 *
 * next/navigation and next/link are replaced by recording stubs (test/dom/stubs). Each run uses a
 * throwaway Electron profile and exits when the page reports.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { expect } from 'vitest';
import type { DomResult } from './dom/kit';

const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/** The Electron binary, or null when it is not installed here. */
export function electronBinary(): string | null {
  try {
    const bin = require('electron') as unknown as string;
    return typeof bin === 'string' && fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export async function runDomFile(file: string, timeoutMs = 150_000): Promise<DomResult[]> {
  const bin = electronBinary();
  if (!bin) throw new Error('Electron is not installed (node_modules/electron): the DOM tests need it.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-domtest-'));
  const out = await build({
    entryPoints: [path.join(ROOT, file)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    sourcemap: 'inline',
    logLevel: 'silent',
    alias: {
      'next/navigation': path.join(ROOT, 'test/dom/stubs/next-navigation.ts'),
      'next/link': path.join(ROOT, 'test/dom/stubs/next-link.tsx'),
    },
    plugins: [
      {
        name: 'at-alias',
        setup(b) {
          b.onResolve({ filter: /^@\// }, async (args) => {
            const r = await b.resolve('./' + args.path.slice(2), { resolveDir: ROOT, kind: args.kind });
            return { path: r.path, errors: r.errors };
          });
        },
      },
    ],
    define: {
      'process.env.NODE_ENV': '"development"',
      'process.env.NEXT_PUBLIC_APP_VERSION': '"0.0.0-test"',
      'process.env': '{}',
      global: 'window',
    },
  });
  const js = path.join(dir, 'bundle.js');
  fs.writeFileSync(js, out.outputFiles[0].text);
  const html = path.join(dir, 'index.html');
  fs.writeFileSync(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><title>dom test</title></head><body><main id="dom-main"></main><script src="bundle.js"></script></body></html>`,
  );
  const results = path.join(dir, 'results.json');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, [path.join(ROOT, 'test/dom/runner.cjs'), html, results], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`DOM tests timed out\n${stderr}`));
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      if (fs.existsSync(results)) resolve();
      else reject(new Error(`the DOM test window exited without results\n${stderr}`));
    });
  });
  const parsed = JSON.parse(fs.readFileSync(results, 'utf8')) as DomResult[];
  fs.rmSync(dir, { recursive: true, force: true });
  return parsed;
}

/** Fail with every failed DOM test's name and reason. */
export function expectAllPassed(results: DomResult[], expectedNames?: string[]) {
  const failed = results.filter((r) => !r.ok).map((r) => `✗ ${r.name}: ${r.error}`);
  expect(failed, failed.join('\n\n')).toEqual([]);
  if (expectedNames) expect(results.map((r) => r.name)).toEqual(expectedNames);
}
