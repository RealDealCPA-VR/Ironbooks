/**
 * Which company data folders a restore (lib/services/backup.ts restoreBackup) is replacing right
 * now. While one is, the open single company file's autosave waits (lib/services/companyFileSave.ts):
 * the restored books are swapped in BEFORE they are verified, and a backup that fails the check is
 * rolled back — so they must never be saved into the company file until the restore has finished.
 */
import { resolveDataDir } from '@/lib/db';

const running = new Map<string, number>();

/** Mark `dataDir` as being restored until the returned function is called. */
export function beginRestore(dataDir?: string): () => void {
  const dir = resolveDataDir(dataDir);
  running.set(dir, (running.get(dir) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (running.get(dir) ?? 1) - 1;
    if (n > 0) running.set(dir, n);
    else running.delete(dir);
  };
}

export function isRestoreInProgress(dataDir?: string): boolean {
  return running.has(resolveDataDir(dataDir));
}
