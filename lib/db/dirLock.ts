/**
 * Exclusive "in use" lock for a company file (one PGlite data directory).
 *
 * PGlite has no lock of its own: two processes that open the same folder (two PCs on a network
 * share, two Windows users on one PC) each run their own Postgres over the same files and the
 * last writer silently wins — committed transactions of the other are lost. QuickBooks refuses
 * to open a company file that is open elsewhere; so do we. Several people share a file through
 * multi-user hosting (electron/hosting.js), where the one host process stays the only writer.
 *
 * The lock is `<dataDir>/ironbooks.lock`, created with flag 'wx' (fails if it exists) and holding
 * { pid, hostname, startedAt, heartbeatAt }. While the file is open the holder rewrites it every
 * HEARTBEAT_MS, so its modification time — stamped by the file system holding the folder — stays
 * fresh. An existing lock is stale (taken over) when:
 *  - it is this process's own lock (a handle re-opened after a restore copied it back, …);
 *  - it was written on this computer by a process that no longer runs;
 *  - it has had no heartbeat for STALE_MS (a crash or power cut on another computer). The age is
 *    measured against a probe file written in the same folder, so clock differences between
 *    computers on a network share do not matter.
 * No file descriptor is kept open, so the folder can still be renamed (restore) once closed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServiceError } from '@/lib/services/errors';

export const LOCK_FILE = 'ironbooks.lock';
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 2 * 60_000;

interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
}

interface HeldLock {
  file: string;
  info: LockInfo;
  timer: ReturnType<typeof setInterval>;
}

/** Locks this process holds, by resolved data directory. */
const held = new Map<string, HeldLock>();

export class CompanyFileInUseError extends ServiceError {
  constructor(public host: string) {
    super('CONFLICT', `This company file is open on ${host}. Close it there, or use multi-user hosting.`, {
      host,
    });
    this.name = 'CompanyFileInUseError';
  }
}

function readLock(file: string): { info: LockInfo | null; mtimeMs: number } | null {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.hostname === 'string') {
      return { info: parsed as LockInfo, mtimeMs };
    }
  } catch {
    /* half-written or foreign content: judged by its age alone */
  }
  return { info: null, mtimeMs };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** "Now" on the file system holding `dir` (mtime of a fresh probe file); local clock as fallback. */
function folderNow(dir: string): number {
  const probe = path.join(dir, `.ironbooks-clock-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, '');
    return fs.statSync(probe).mtimeMs;
  } catch {
    return Date.now();
  } finally {
    try {
      fs.unlinkSync(probe);
    } catch {
      /* ignore */
    }
  }
}

const isOwn = (info: LockInfo | null) => !!info && info.pid === process.pid && info.hostname === os.hostname();

function isStale(dir: string, lock: { info: LockInfo | null; mtimeMs: number }): boolean {
  const { info } = lock;
  if (info && info.hostname === os.hostname()) {
    if (info.pid === process.pid || !pidAlive(info.pid)) return true;
  }
  return folderNow(dir) - lock.mtimeMs > STALE_MS;
}

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of [...held.keys()]) releaseDirLock(dir);
  });
}

/**
 * Take the lock on `dir` (already resolved and created) for this process. Throws
 * CompanyFileInUseError when another live process holds it. A folder where no lock file can be
 * created at all (read-only media, …) is opened without one rather than refused.
 */
export function acquireDirLock(dir: string): void {
  if (held.has(dir)) return;
  const file = path.join(dir, LOCK_FILE);
  const now = new Date().toISOString();
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), startedAt: now, heartbeatAt: now };
  let holder: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
      startHeartbeat(dir, file, info);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        console.warn(`[db] could not create the company file lock in ${dir} (${code}); opening without it`);
        return;
      }
    }
    const lock = readLock(file);
    if (!lock) continue; // released meanwhile: try again
    holder = lock.info?.hostname ?? holder;
    if (!isStale(dir, lock)) throw new CompanyFileInUseError(holder ?? 'another computer');
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new CompanyFileInUseError(holder ?? 'another computer');
}

function startHeartbeat(dir: string, file: string, info: LockInfo) {
  installExitHook();
  const timer = setInterval(() => {
    try {
      const current = readLock(file);
      if (current && !isOwn(current.info)) {
        // Someone else took it over (we were judged stale): stop claiming it.
        clearInterval(timer);
        held.delete(dir);
        console.error(`[db] the company file lock in ${dir} was taken over by another process`);
        return;
      }
      info.heartbeatAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(info));
    } catch {
      /* folder gone / unreachable for a moment: try again next beat */
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  held.set(dir, { file, info, timer });
}

/** Release this process's lock on `dir` (no-op when it holds none). */
export function releaseDirLock(dir: string): void {
  const lock = held.get(dir);
  if (!lock) return;
  clearInterval(lock.timer);
  held.delete(dir);
  try {
    const current = readLock(lock.file);
    if (current && isOwn(current.info)) fs.unlinkSync(lock.file);
  } catch {
    /* already gone */
  }
}

/** Whether this process holds the lock on `dir` (tests). */
export function holdsDirLock(dir: string): boolean {
  return held.has(dir);
}
