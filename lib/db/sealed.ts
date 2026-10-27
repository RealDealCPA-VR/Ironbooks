/**
 * The app server of a company file protected with passwords starts SEALED (filecrypto): the
 * desktop shell has locked the file and prepared the working copy, but it has no file key, so the
 * working copy is empty (or holds books that may only be used once someone has signed in). Until a
 * sign-in unlocks the file key (lib/services/fileProtection.ts), the working copy's database is
 * never opened: every request that needs it is answered "Authentication required." (pages go to
 * the sign-in screen), and only the sign-in, password-recovery and file-information routes run.
 *
 * The shell says so with BKA_COMPANY_SEALED = 'extract' | 'conflict' | 'key' (what the sign-in has
 * to do — electron/companySession.js prepareSealed). Dependency-free so lib/db can use it.
 */
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ServiceError } from '@/lib/services/errors';

export type SealedMode = 'extract' | 'conflict' | 'key';

const g = globalThis as typeof globalThis & { __ironbooksUnsealed?: boolean };

/** What the sign-in must do before the company file can be used, or null when it can be used. */
export function sealedMode(): SealedMode | null {
  if (g.__ironbooksUnsealed) return null;
  const m = process.env.BKA_COMPANY_SEALED;
  return m === 'extract' || m === 'conflict' || m === 'key' ? m : null;
}

/** The working copy's data folder the sealed state applies to (the shell's BKA_COMPANY_STATE folder). */
export function sealedDataDir(): string | null {
  if (!sealedMode()) return null;
  const st = process.env.BKA_COMPANY_STATE;
  if (st) return path.resolve(path.dirname(st), 'data');
  return process.env.BKA_DATA_DIR ? path.resolve(process.env.BKA_DATA_DIR) : null;
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when `dir` is the sealed working copy (not opened until someone signs in). */
export function isSealedDir(dir: string): boolean {
  const s = sealedDataDir();
  return Boolean(s && samePath(s, dir));
}

/** The sign-in unlocked the file key and the working copy is ready: the database may be opened. */
export function markUnsealed(): void {
  g.__ironbooksUnsealed = true;
}

/** Tests: back to the state the shell started the server in. */
export function resetSealedState(): void {
  g.__ironbooksUnsealed = false;
}

/**
 * The sign-in of a working copy that is already on this computer ('key': reuse / recover) reads
 * the users and key slots of that copy before the file key is known; only inside this scope.
 */
const sealedAccess = new AsyncLocalStorage<true>();

export function withSealedAccess<T>(fn: () => Promise<T>): Promise<T> {
  return sealedAccess.run(true, fn);
}

/** Refuse to open the sealed working copy outside the sign-in (lib/db openDb). */
export function assertNotSealed(dir: string): void {
  if (!isSealedDir(dir)) return;
  if (sealedMode() === 'key' && sealedAccess.getStore()) return;
  throw new ServiceError('FORBIDDEN', 'Authentication required.', { sealed: true });
}
