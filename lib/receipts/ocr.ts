/**
 * Offline OCR for receipt photos (receipt capture), on the server, with tesseract.js.
 *
 * Fully local: the WebAssembly engine (tesseract.js-core) and the English language data
 * (@tesseract.js-data/eng, "best_int" model) are read from the app's own node_modules — the
 * language path is a folder on disk, so tesseract.js never downloads anything, and the cache is
 * off so nothing is written next to the company file. Images are passed as Buffers (never
 * URLs). One worker is shared, jobs run one at a time, and the worker is shut down after a
 * minute of idleness to give the memory back.
 *
 * Packaging: next.config.js keeps tesseract.js external and traces the engine + language data
 * into the standalone server; package.json lists both packages. If they are missing (e.g. a dev
 * checkout that hasn't run `npm install` since they were added), getOcrEngine() returns null
 * and the caller falls back to the local AI vision model or manual entry.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface OcrEngine {
  /** Text of one image (JPEG / PNG / WebP bytes). */
  recognize(image: Buffer): Promise<string>;
  /**
   * Every word of one image with its box (bank statements: rows and columns are rebuilt from the
   * positions, lib/statements/ocrLines.ts). A page scanned sideways or upside down is turned first.
   * Optional: an engine without it is read as plain text.
   */
  recognizeWords?(image: Buffer): Promise<Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>>;
}

/** Longest a single photo may take before we give up on it. */
const OCR_TIMEOUT_MS = 90_000;
const IDLE_SHUTDOWN_MS = 60_000;

let override: OcrEngine | null | undefined;

/** Tests: replace the engine (null = "not installed"); undefined restores the real one. */
export function setOcrEngineForTests(engine: OcrEngine | null | undefined): void {
  override = engine;
}

/** Folder holding eng.traineddata.gz (bundled with the app). */
export function ocrLanguageDir(): string | null {
  const candidates = [
    process.env.BKA_OCR_LANG_DIR,
    path.join(process.cwd(), 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int'),
  ].filter((p): p is string => Boolean(p));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'eng.traineddata.gz')) || fs.existsSync(path.join(dir, 'eng.traineddata'))) return dir;
  }
  return null;
}

interface TesseractBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TesseractWorker {
  recognize(
    image: Buffer,
    opts?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{
    data: {
      text: string;
      blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: Array<{ text: string; bbox: TesseractBox }> }> }> }> | null;
    };
  }>;
  terminate(): Promise<unknown>;
}
interface TesseractModule {
  createWorker(lang: string, oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
}

let workerPromise: Promise<TesseractWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function loadTesseract(): Promise<TesseractModule | null> {
  try {
    // Typed through the local TesseractModule above. The ignore covers only this line, for a
    // checkout that hasn't run `npm install` since tesseract.js was added (no ambient
    // `declare module` stub, which would hide the package's own types everywhere once installed);
    // at runtime a missing package lands in the catch and OCR reports itself unavailable.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TS2307 until tesseract.js is installed
    const mod = (await import('tesseract.js')) as unknown as { default?: TesseractModule } & TesseractModule;
    return typeof mod.createWorker === 'function' ? mod : (mod.default ?? null);
  } catch {
    return null;
  }
}

function scheduleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const p = workerPromise;
    workerPromise = null;
    p?.then((w) => w.terminate()).catch(() => {});
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function getWorker(tess: TesseractModule, langPath: string): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = tess
      .createWorker('eng', 1 /* LSTM only */, {
        langPath,
        gzip: fs.existsSync(path.join(langPath, 'eng.traineddata.gz')),
        cacheMethod: 'none',
        logger: () => {},
        errorHandler: () => {},
      })
      .catch((err) => {
        workerPromise = null;
        throw err;
      });
  }
  return workerPromise;
}

/** The offline OCR engine, or null when it is not installed / its language data is missing. */
export async function getOcrEngine(): Promise<OcrEngine | null> {
  if (override !== undefined) return override;
  const langPath = ocrLanguageDir();
  if (!langPath) return null;
  const tess = await loadTesseract();
  if (!tess) return null;
  /** Run one OCR job on the shared worker, one at a time, with the per-image time limit. */
  function run<T>(read: (worker: TesseractWorker) => Promise<T>): Promise<T> {
    const job = queue.then(async () => {
      // The worker is busy from here on: the idle shutdown the previous job scheduled must not
      // fire mid-read (a slow page used to be cut off after 60 s by the last page's timer).
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      const worker = await getWorker(tess!, langPath!);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          read(worker),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // A stuck job poisons the worker: drop it so the next photo gets a fresh one.
              const p = workerPromise;
              workerPromise = null;
              p?.then((w) => w.terminate()).catch(() => {});
              reject(new Error('Reading the photo took too long.'));
            }, OCR_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        scheduleShutdown();
      }
    });
    queue = job.catch(() => {});
    return job;
  }
  return {
    recognize: (image: Buffer) => run(async (w) => (await w.recognize(image)).data.text ?? ''),
    recognizeWords: (image: Buffer) =>
      run(async (w) => {
        const res = await w.recognize(image, { rotateAuto: true }, { text: true, blocks: true });
        const words: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }> = [];
        for (const b of res.data.blocks ?? [])
          for (const p of b.paragraphs ?? [])
            for (const l of p.lines ?? [])
              for (const word of l.words ?? []) words.push({ text: word.text, ...word.bbox });
        return words;
      }),
  };
}
