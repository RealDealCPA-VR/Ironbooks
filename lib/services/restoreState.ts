/**
 * Which company data folders a restore (lib/services/backup.ts restoreBackup) is replacing right
 * now. While one is, nothing is saved out of it (lib/services/companyFileSave.ts): the autosave and
 * Save Now wait, and the close-time save and Save Copy As wait for the restore to finish. The
 * restored books are swapped in BEFORE they are verified, and a backup that fails the check is
 * rolled back — so they must never be saved into the company file (or a copy) until it has finished.
 *
 * Kept on globalThis, like the save state itself: every route of the server sees the same restores.
 */
import { resolveDataDir } from '@/lib/db';

interface Restores {
  running: Map<string, number>;
  waiters: Map<string, Array<() => void>>;
}

const g = globalThis as typeof globalThis & { __ironbooksRestores?: Restores };

function restores(): Restores {
  return (g.__ironbooksRestores ??= { running: new Map(), waiters: new Map() });
}

/** Mark `dataDir` as being restored until the returned function is called. */
export function beginRestore(dataDir?: string): () => void {
  const dir = resolveDataDir(dataDir);
  const { running, waiters } = restores();
  running.set(dir, (running.get(dir) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (running.get(dir) ?? 1) - 1;
    if (n > 0) {
      running.set(dir, n);
      return;
    }
    running.delete(dir);
    const list = waiters.get(dir) ?? [];
    waiters.delete(dir);
    for (const resolve of list) resolve();
  };
}

export function isRestoreInProgress(dataDir?: string): boolean {
  return restores().running.has(resolveDataDir(dataDir));
}

/** Resolves once no restore into `dataDir` is running (at once when none is). */
export function whenRestoreDone(dataDir?: string): Promise<void> {
  const dir = resolveDataDir(dataDir);
  const { running, waiters } = restores();
  if (!running.has(dir)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const list = waiters.get(dir) ?? [];
    list.push(resolve);
    waiters.set(dir, list);
  });
}
