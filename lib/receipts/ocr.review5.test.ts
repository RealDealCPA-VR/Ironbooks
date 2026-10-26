/**
 * Review round 5 (team banking) — the shared offline OCR worker must not be shut down while it is
 * reading. A scanned statement / receipt page that takes longer than the idle timeout (60 s) to
 * read used to be killed by the idle timer the PREVIOUS page had started.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = vi.hoisted(() => ({ terminated: 0, slowMs: 0 }));
vi.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: (image: Buffer) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ data: { text: `page ${image.length}` } }), state.slowMs);
        void t;
        (state as unknown as { reject?: (e: Error) => void }).reject = reject;
      }),
    terminate: async () => {
      state.terminated += 1;
      (state as unknown as { reject?: (e: Error) => void }).reject?.(new Error('worker terminated'));
    },
  }),
}));

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-ocr-r5-'));
  fs.writeFileSync(path.join(dir, 'eng.traineddata'), 'x');
  process.env.BKA_OCR_LANG_DIR = dir;
});
afterAll(() => {
  delete process.env.BKA_OCR_LANG_DIR;
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('offline OCR worker', () => {
  it('a page that takes longer than the idle timeout is not cut off by the previous page’s idle timer', async () => {
    vi.useFakeTimers();
    const { getOcrEngine } = await import('./ocr');
    const engine = await getOcrEngine();
    expect(engine).not.toBeNull();
    state.slowMs = 1_000;
    const first = engine!.recognize(Buffer.alloc(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBe('page 1');
    // Page 2 takes 75 s (under the 90 s per-page limit, over the 60 s idle shutdown).
    state.slowMs = 75_000;
    const second = engine!.recognize(Buffer.alloc(2));
    const settled = second.then(
      (v) => ({ ok: true as const, v }),
      (e: Error) => ({ ok: false as const, e: e.message }),
    );
    await vi.advanceTimersByTimeAsync(76_000);
    expect(await settled).toEqual({ ok: true, v: 'page 2' });
    expect(state.terminated).toBe(0);
  });
});
