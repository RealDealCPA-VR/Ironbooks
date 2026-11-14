/**
 * When the books on this computer will not start.
 *
 * The open single company file ("ABC Company.ironbooks") is worked on in a private working copy on
 * this computer (electron/companySession.js) and saved back to the company file a few seconds after
 * each change (lib/services/companyFileSave.ts). Postgres normally recovers a working copy by
 * itself after a crash. It cannot when the copy's control file names a checkpoint its write-ahead
 * log no longer holds: then PGlite stops at start with "Aborted()" and every request would fail,
 * every time the file is opened again, because the shell reuses the working copy after a crash.
 * Two ways to get there: a power cut (PGlite's file layer does not flush to disk, so Postgres's
 * write ordering does not survive one), and two Postgres instances on one folder (see
 * lib/db/index.ts).
 *
 * Instead of locking the person out, a request that finds the working copy unable to start
 * (lib/db getDb) runs ONE recovery, while every other request waits (holdDbOpen):
 *  1. Is it really damaged? Only when the start check (electron/pgDataCheck.js) finds damage, or
 *     a second start after a short pause fails too. A start that fails for a passing reason (an
 *     antivirus scan holding a file, memory) is simply tried again, never "repaired".
 *  2. The company file's last save is unpacked into a fresh folder and STARTED once before it
 *     replaces anything; the damaged copy is swapped out (put back if the swap fails half way)
 *     and kept on this computer for support — encrypted when its books are protected.
 *  3. A protected file nobody has signed in to yet: only a sign-in whose password opens the
 *     company file may do this (withRecoveryAllowed, app/api/auth/login); the sign-in then
 *     decrypts the company file instead of reusing the working copy.
 *  4. The person is told in plain words what happened and what, if anything, was lost
 *     (recoveryNotice(): the sign-in answer and the title-bar status show it).
 *
 * The company file itself can only be replaced by a save whose snapshot passes the same start
 * check, so the last save is good to reopen from. Nothing is saved while a recovery runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PGlite } from '@electric-sql/pglite';
import format from '@/electron/companyFileFormat';
import session from '@/electron/companySession';
import pgData from '@/electron/pgDataCheck';
import { getDb, holdDbOpen, isDbOpen, openSettled, resolveDataDir, withSealedAccess } from '@/lib/db';
import { overrideSealedMode, sealedMode, type SealedMode } from '@/lib/db/sealed';
import { APP_VERSION } from '@/lib/appVersion';
import { ServiceError } from './errors';
import { isRestoreInProgress } from './restoreState';

export interface RecoveryNotice {
  id: string;
  at: string;
  /** What the person is told, in plain words. */
  message: string;
  /** When the save the books were reopened from was made (null: not known / not reopened yet). */
  savedAt: string | null;
  /** True when the damaged copy may have held changes the company file does not have. */
  changesLost: boolean;
  /** Where the damaged copy was kept (on this computer). */
  keptAt: string | null;
}

/**
 * 'replaced'      the working copy now holds the company file's last save: open it again;
 * 'retry'         it was not damaged after all (it started on a second try): open it again;
 * 'resealed'      a protected file nobody has signed in to: the sign-in decrypts the company file;
 * 'needs-sign-in' a protected file: only a sign-in that opens the company file may recover it;
 * 'busy'          the swap could not be completed (a file was busy): nothing changed, try again;
 * null            nothing could be done here (not a company file's working copy, or its last save
 *                 does not start either).
 */
export type RecoveryOutcome = 'replaced' | 'retry' | 'resealed' | 'needs-sign-in' | 'busy' | null;

const g = globalThis as typeof globalThis & {
  __ironbooksRecoveryNotice?: RecoveryNotice | null;
  __ironbooksRecovery?: Promise<RecoveryOutcome> | null;
};

/** Pause before a working copy that failed to start (but shows no damage) is tried a second time. */
function retryDelayMs(): number {
  const v = Number(process.env.BKA_RECOVERY_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1500;
}

/** The notice of a recovery made by this server process (null when none was needed). */
export function recoveryNotice(): RecoveryNotice | null {
  return g.__ironbooksRecoveryNotice ?? null;
}

/** A recovery is running in this process: nothing may be saved meanwhile (companyFileSave.ts). */
export function isRecoveryInProgress(): boolean {
  return Boolean(g.__ironbooksRecovery);
}

/** Resolves once no recovery is running. */
export async function whenRecoveryDone(): Promise<void> {
  while (g.__ironbooksRecovery) await g.__ironbooksRecovery.catch(() => null);
}

/** Tests. */
export function resetRecoveryState(): void {
  g.__ironbooksRecoveryNotice = null;
  g.__ironbooksRecovery = null;
}

/** Why a data folder would not start, or null when it looks fine / unknown (pgDataCheck.js). */
export function dataDirProblem(dir: string): string | null {
  const r = pgData.checkDataDir(dir) as { ok: boolean | null; reason: string | null };
  return r.ok === false ? r.reason : null;
}

/** The same for a snapshot of a data folder about to be saved. */
export function snapshotProblem(entries: Array<{ name: string; data?: Buffer; dir?: boolean; file?: string }>): string | null {
  const r = pgData.checkSnapshot(entries) as { ok: boolean | null; reason: string | null };
  return r.ok === false ? r.reason : null;
}

/** A copy of the books that would not start must never replace a company file or a backup. */
export class UnstartableBooksError extends ServiceError {
  constructor(public reason: string, what: 'save' | 'backup') {
    super(
      'CONFLICT',
      what === 'save'
        ? `Ironbooks found a problem with the copy of your books on this computer (${reason}), so it did not save it over your company file, which still holds your last good save. Your work stays open here and Ironbooks tries again in a moment. If this message does not go away, close the company file and open it again.`
        : `The books in this company file are damaged (${reason}), so no backup was made from them (it could not be restored). Your earlier backups are untouched.`,
      { unstartable: true, reason },
    );
    this.name = 'UnstartableBooksError';
  }
}

/** The database of a company file would not start, and Ironbooks could not put it right by itself. */
export class BooksWontOpenError extends ServiceError {
  constructor(reason: string | null, singleFile: boolean) {
    super(
      'CONFLICT',
      `Ironbooks could not open this company file: its database is damaged${reason ? ` (${reason})` : ''}, most likely because Ironbooks or the computer stopped unexpectedly while it was open. ${
        singleFile
          ? 'The last save of the company file could not be opened either. Open your most recent backup instead (File > Open or Restore Company).'
          : 'Restore your most recent backup (File > Open or Restore Company).'
      }`,
      { wontOpen: true, reason },
    );
    this.name = 'BooksWontOpenError';
  }
}

/** Reopening the company file could not be finished just now; nothing was changed. */
export class BooksBusyError extends ServiceError {
  constructor() {
    super(
      'CONFLICT',
      'Ironbooks could not open your company file just now because a file on this computer was busy (often antivirus or a backup program). Nothing was changed. Try again in a moment, or close the company file and open it again.',
      { retry: true },
    );
    this.name = 'BooksBusyError';
  }
}

/**
 * A protected file's sign-in whose password opened the company file may recover a working copy
 * that will not start ('key' mode); nobody else may (an unauthenticated request must never make the
 * app set the working copy aside).
 */
const recoveryAllowed = new AsyncLocalStorage<{ fileKey: Buffer | null }>();

/** `fileKey`: the key the sign-in unlocked from the company file (the damaged copy is kept encrypted with it). */
export function withRecoveryAllowed<T>(fn: () => Promise<T>, fileKey: Buffer | null = null): Promise<T> {
  return recoveryAllowed.run({ fileKey }, fn);
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** The working copy of the open single company file (null when the server runs on a company folder). */
export function workingCopyDir(): string | null {
  if (!process.env.BKA_COMPANY_FILE) return null;
  const st = process.env.BKA_COMPANY_STATE;
  return st ? path.resolve(path.dirname(st), 'data') : resolveDataDir();
}

function whenText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ` (saved ${d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })})`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does this folder start? Opens it once with PGlite and closes it again (a clean shutdown). */
async function starts(dir: string): Promise<boolean> {
  let pg: PGlite | null = null;
  try {
    pg = new PGlite(dir);
    await pg.waitReady;
    await pg.query('select 1');
    await pg.close();
    return true;
  } catch {
    try {
      await pg?.close();
    } catch {
      /* never started */
    }
    return false;
  }
}

/**
 * The damaged copy held changes the company file does not have: anything recorded as unsaved, or a
 * transaction log that moved on from the one the last save holds (electron/companySession.js).
 */
function heldUnsavedChanges(dir: string): boolean {
  const st = process.env.BKA_COMPANY_STATE ? session.readState(path.dirname(path.resolve(process.env.BKA_COMPANY_STATE))) : null;
  if (!st) return true; // unknown: never claim nothing was lost
  if (st.unsavedSince) return true;
  const base = st.base;
  if (!base || !Object.prototype.hasOwnProperty.call(base, 'fingerprint')) return true;
  if (session.logFingerprint(dir) !== (base.fingerprint ?? null)) return true;
  // A change the autosave had not noticed yet leaves neither of those behind: the database files
  // themselves say whether anything was written after the last save.
  const savedAt = Date.parse(st.lastSavedAt || base.savedAt || '');
  if (!Number.isFinite(savedAt)) return true;
  // (A save snapshots the files before it records savedAt: anything written later is newer.)
  return newestDbWrite(dir) > savedAt;
}

/** The newest modification time of the write-ahead log and table files of a data folder (0: none). */
function newestDbWrite(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(path.join(dir, 'pg_wal'));
  walk(path.join(dir, 'base'));
  return newest;
}

function messageFor(savedAt: string | null, changesLost: boolean, keptAt: string): string {
  const lost = changesLost
    ? 'Anything entered after that save could not be recovered. Please check your most recent work and enter again anything that is missing.'
    : 'Nothing was lost: everything had already been saved to the company file.';
  return `The copy of your books on this computer was damaged, most likely because Ironbooks or the computer stopped unexpectedly. Ironbooks reopened your company file as it was last saved${whenText(savedAt)}. ${lost} The damaged copy was kept at ${keptAt}.`;
}

function setNotice(savedAt: string | null, changesLost: boolean, keptAt: string): void {
  g.__ironbooksRecoveryNotice = { id: randomUUID(), at: new Date().toISOString(), message: messageFor(savedAt, changesLost, keptAt), savedAt, changesLost, keptAt };
}

/** The damaged copy named in the notice moved (it was encrypted once the file key was known). */
function noticeKeptMoved(from: string, to: string): void {
  const n = g.__ironbooksRecoveryNotice;
  if (!n || !n.keptAt || !samePath(n.keptAt, from)) return;
  g.__ironbooksRecoveryNotice = { ...n, keptAt: to, message: messageFor(n.savedAt, n.changesLost, to) };
}

/**
 * Called by lib/db getDb when the database in `dir` would not start. One recovery at a time;
 * concurrent callers share it, and nothing opens `dir` while it runs (holdDbOpen: getDb waits).
 */
export function recoverUnstartableWorkingCopy(dir: string): Promise<RecoveryOutcome> {
  const abs = path.resolve(dir);
  // A protected file nobody has signed in to: never on behalf of an unauthenticated request — and
  // without side effects, so it never hands its answer to a sign-in that may recover it.
  if (sealedMode() === 'key' && !recoveryAllowed.getStore() && !g.__ironbooksRecovery) return Promise.resolve('needs-sign-in');
  if (g.__ironbooksRecovery) return g.__ironbooksRecovery;
  const release = holdDbOpen(abs);
  g.__ironbooksRecovery = doRecover(abs).finally(() => {
    g.__ironbooksRecovery = null;
    release();
  });
  return g.__ironbooksRecovery;
}

async function doRecover(dir: string): Promise<RecoveryOutcome> {
  const work = workingCopyDir();
  const file = process.env.BKA_COMPANY_FILE ? path.resolve(process.env.BKA_COMPANY_FILE) : null;
  if (!work || !file || !samePath(work, dir)) return null;
  // A restore is putting other books in place and checks them itself: books it swapped in that do
  // not start are rolled back by the restore (lib/services/backup.ts), never replaced from here.
  if (isRestoreInProgress(dir)) return null;
  // A request that started before this recovery (it holds new opens off) may be opening it right
  // now: wait for that. Opened: it is fine. Failed: its handle is gone, go on. Never test-start a
  // folder that is open: a second Postgres on it is what damages it.
  if ((await openSettled(dir)) === true) return 'retry';
  if (isDbOpen(dir)) return 'retry';
  // A save already writing out of this folder finishes first (one that has not taken its snapshot
  // yet sees this recovery and stops): nothing is judged or replaced under a running save.
  try {
    const save = await import('./companyFileSave');
    await save.whenNoSaveWriting();
  } catch {
    /* not loaded */
  }
  const mode = sealedMode();
  // A protected file being decrypted from the company file ('extract' / 'conflict'): these books
  // ARE its last save, so there is nothing better to reopen from.
  if (mode === 'extract' || mode === 'conflict') return null;
  // What the damaged copy may hold that the company file does not: judged before anything starts it.
  const changesLost = heldUnsavedChanges(dir);

  // 1. Really damaged? Without damage the check can see, a second start decides: a folder that
  //    starts now (an antivirus scan let go of a file, another request's recovery already put it
  //    right) is used as it is — unsaved work in it is never thrown away for a passing failure.
  if (dataDirProblem(dir) === null) {
    await sleep(retryDelayMs());
    if (await starts(dir)) return 'retry';
  }

  const manifest = format.readCompanyManifest(file) as Record<string, any> | null;
  if (!manifest) return null;
  const sealed = format.isSealedManifest(manifest);
  const workDir = path.dirname(dir);
  const companyName = typeof manifest.companyName === 'string' ? manifest.companyName : undefined;

  if (sealed && mode === 'key') {
    // Nobody has signed in yet, and the sign-in of a working copy on this computer reads its users
    // from that copy. Set it aside and let the sign-in decrypt the company file instead (its key
    // slots are in the file's own listing), like opening the file on a new computer. The damaged
    // copy is encrypted once the sign-in knows the key (sealKeptDamagedCopies).
    const aside = `${dir}.damaged-${Date.now()}`;
    try {
      await format.renameWithRetry(dir, aside);
    } catch {
      return 'busy';
    }
    keepSessionSecret(aside, dir);
    // The sign-in proved its secret against the company file, so it holds the file key: the damaged
    // copy is kept encrypted with it straight away (never in plain text when that key is known).
    const signInKey = recoveryAllowed.getStore()?.fileKey ?? null;
    const enc = manifest.encryption ?? {};
    const { keyCheckOf } = (await import('@/electron/fileCrypto')).default as { keyCheckOf: (k: Buffer) => string };
    const keyProtection =
      signInKey && enc.keyCheck && keyCheckOf(signInKey) === enc.keyCheck
        ? { fileKey: signInKey, keyCheck: enc.keyCheck, lookupSalt: enc.lookupSalt, slots: Array.isArray(enc.slots) ? enc.slots : [] }
        : undefined;
    let kept = aside;
    try {
      kept = await session.keepDamagedCopy(workDir, aside, { protection: keyProtection, companyName, appVersion: APP_VERSION });
    } catch (err) {
      // Left at its temporary name, recorded so the cleanup encrypts or removes it in time. The
      // sign-in must go on all the same (decrypting the company file), never stay stuck on 'key'.
      console.error('[company-file] could not file away the damaged copy (left at its temporary name):', (err as Error)?.message ?? err);
      try {
        session.recordDamagedPlain(workDir, aside);
      } catch {
        /* the state file is busy: the folder is still named data.damaged-<time> */
      }
    }
    overrideSealedMode('extract');
    setNotice(manifest.savedAt ?? null, changesLost, kept);
    console.error(`[company-file] the working copy ${dir} would not start; kept at ${kept}. The sign-in reopens the company file.`);
    return 'resealed';
  }

  let protection: { fileKey: Buffer; keyCheck: string; lookupSalt: string; slots: unknown[] } | null = null;
  if (sealed) {
    const { fileKeyFor } = await import('./fileProtection');
    const fileKey = fileKeyFor(dir);
    if (!fileKey) return null; // signed in without the key: nothing here can decrypt the file
    const enc = manifest.encryption ?? {};
    protection = { fileKey, keyCheck: enc.keyCheck, lookupSalt: enc.lookupSalt, slots: Array.isArray(enc.slots) ? enc.slots : [] };
  }

  // 2. Unpack the last save next to the working copy and start it once before it replaces anything.
  const tmp = `${dir}.recover-${Date.now()}`;
  const dropTmp = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a leftover data.recover-<time> is removed with the working copy's cache */
    }
  };
  dropTmp();
  let opened: Record<string, any>;
  try {
    opened = await format.extractCompanyFile(file, tmp, protection ? { fileKey: protection.fileKey } : {});
  } catch (err) {
    dropTmp();
    console.error('[company-file] the company file could not be unpacked to replace a damaged working copy:', (err as Error)?.message ?? err);
    return null;
  }
  // Books, not an empty folder Postgres would happily make a NEW database in.
  if (!fs.existsSync(path.join(tmp, 'PG_VERSION')) || dataDirProblem(tmp) !== null || !(await starts(tmp))) {
    dropTmp();
    console.error(`[company-file] the working copy ${dir} would not start, and neither does the last save of ${file}.`);
    return null;
  }
  // Files that belong to this computer, never to the company file (the session-signing key, the
  // backup history and settings), stay with the working copy.
  for (const name of ['.auth-secret', '.backup-history.json', '.backup-settings.json']) {
    const from = path.join(dir, name);
    if (fs.existsSync(from) && !fs.existsSync(path.join(tmp, name))) fs.copyFileSync(from, path.join(tmp, name));
  }
  // Protected or not as the reopened save is, never as the damaged copy was (a folder marked
  // protected whose books are not refuses every save): the marker comes from the file's own key.
  fs.rmSync(path.join(tmp, session.PROTECTED_MARKER), { force: true });
  if (protection?.keyCheck) fs.writeFileSync(path.join(tmp, session.PROTECTED_MARKER), JSON.stringify({ keyCheck: protection.keyCheck }) + '\n');

  // 3. Swap: the damaged copy out, the last save in — and back again if the second step fails, so
  //    the working copy is never left missing (an empty folder would become a NEW, empty database).
  const aside = `${dir}.damaged-${Date.now()}`;
  try {
    await format.renameWithRetry(dir, aside);
  } catch {
    dropTmp();
    return 'busy';
  }
  let swapped = false;
  try {
    await format.renameWithRetry(tmp, dir);
    swapped = true;
  } catch (err) {
    console.error('[company-file] could not put the reopened save in place:', (err as Error)?.message ?? err);
    try {
      await format.renameWithRetry(aside, dir);
      console.error('[company-file] the working copy is back as it was.');
    } catch (back) {
      // Neither went back: try the good copy once more. Never delete it while the working copy is
      // missing — it is then the only usable copy of the books on this computer.
      console.error(`[company-file] could not put the working copy back from ${aside}:`, (back as Error)?.message ?? back);
      try {
        await format.renameWithRetry(tmp, dir);
        swapped = true;
      } catch (again) {
        console.error(`[company-file] the books are kept at ${tmp} (last save) and ${aside} (damaged copy):`, (again as Error)?.message ?? again);
      }
    }
    if (!swapped) {
      if (fs.existsSync(path.join(dir, 'PG_VERSION'))) dropTmp();
      return 'busy';
    }
  }
  // Kept for support: an encrypted company file when the books are protected, else the folder.
  let kept = aside;
  try {
    kept = await session.keepDamagedCopy(workDir, aside, { protection, companyName, appVersion: APP_VERSION });
  } catch (err) {
    console.error('[company-file] could not file away the damaged copy (left at its temporary name):', (err as Error)?.message ?? err);
    // Protected books left in plain text: recorded, so the cleanup encrypts or removes them in time.
    if (protection) {
      try {
        session.recordDamagedPlain(workDir, aside);
      } catch {
        /* the state file is busy */
      }
    }
  }
  if (process.env.BKA_COMPANY_STATE) {
    session.writeState(path.dirname(path.resolve(process.env.BKA_COMPANY_STATE)), {
      base: { saveId: opened.saveId ?? manifest.saveId ?? null, savedAt: opened.savedAt ?? manifest.savedAt ?? null, fingerprint: opened.fingerprint ?? null },
      unsavedSince: null,
      conflictFingerprint: null,
      closedCleanly: false,
    });
  }
  // The save logic read the old working state: let it start over from the reopened save.
  try {
    const save = await import('./companyFileSave');
    save.resetCompanyFileSaveState();
  } catch {
    /* not loaded */
  }
  setNotice(opened.savedAt ?? manifest.savedAt ?? null, changesLost, kept);
  console.error(`[company-file] the working copy ${dir} would not start; kept at ${kept} and reopened from ${file}.`);
  return 'replaced';
}

/** The session-signing key of this computer stays with the working copy (never in the company file). */
function keepSessionSecret(from: string, to: string): void {
  const secret = path.join(from, '.auth-secret');
  if (!fs.existsSync(secret)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(secret, path.join(to, '.auth-secret'));
}

/**
 * The sign-in has the file key now (lib/services/fileProtection.ts doUnseal): encrypt the damaged
 * copies of protected books that had to be kept in plain text (electron/companySession.js
 * keepDamagedCopy). Best effort; one that fails is removed by the shell's cleanup in time.
 */
export async function sealKeptDamagedCopies(dataDir: string, protection: unknown, companyName?: string): Promise<void> {
  try {
    const done = (await session.sealDamagedCopies(path.dirname(path.resolve(dataDir)), protection, { companyName, appVersion: APP_VERSION })) as Array<{ from: string; to: string }>;
    for (const d of done) noticeKeptMoved(d.from, d.to);
  } catch (err) {
    console.warn('[company-file] could not encrypt the damaged copy kept on this computer:', (err as Error)?.message ?? err);
  }
}

/**
 * Opening a protected file found unsaved changes here, but in books that would not start
 * (lib/services/fileProtection.ts doUnseal, 'conflict'): they were kept, encrypted, at `keptAt`
 * instead of being written out as an "(unsaved changes)" file that would not open either.
 */
export function noteDamagedUnsavedChanges(savedAt: string | null, keptAt: string): void {
  setNotice(savedAt, true, keptAt);
}

/** Whether an error says the working copy will not start and only a sign-in may recover it. */
export function needsSignInToRecover(err: unknown): boolean {
  return Boolean((err as { details?: { needsSignIn?: boolean } })?.details?.needsSignIn);
}

/**
 * Sign-in of a protected file whose working copy will not start ('key'), once the typed password
 * has opened the company file: recover it (lib/db getDb, allowed here only) and return the sign-in
 * mode to continue with — 'extract' when the copy was set aside, still 'key' when it started after all.
 */
export async function recoverSealedWorkingCopy(fileKey: Buffer | null = null): Promise<SealedMode | null> {
  // Another sign-in already set the copy aside (the mode is 'extract' now): go on with that.
  if (sealedMode() !== 'key') return sealedMode();
  try {
    await withRecoveryAllowed(() => withSealedAccess(() => getDb()), fileKey);
  } catch (err) {
    if (!(err as { details?: { resealed?: boolean } })?.details?.resealed) throw err;
  }
  return sealedMode();
}
