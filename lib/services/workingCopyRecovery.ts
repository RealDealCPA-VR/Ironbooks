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
 * Instead of locking the person out, the first request that finds the working copy unable to
 * start (lib/db getDb):
 *  1. keeps the damaged copy aside, next to the working copy ("damaged copy <date>"), never
 *     deleted here, so nothing is destroyed;
 *  2. reopens the company file as it was last saved: its books are unpacked into a fresh folder and
 *     STARTED once before they replace anything; a protected file whose key is not known yet
 *     (nobody has signed in) switches the sign-in to decrypting the company file instead;
 *  3. tells the person in plain words what happened and what, if anything, was lost
 *     (recoveryNotice(): the sign-in answer and the title-bar status show it).
 *
 * The company file itself can only be replaced by a save whose snapshot passes the same start
 * check (electron/pgDataCheck.js), so the last save is good to reopen from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import format from '@/electron/companyFileFormat';
import session from '@/electron/companySession';
import pgData from '@/electron/pgDataCheck';
import { getDb, isDbOpen, resolveDataDir, withSealedAccess } from '@/lib/db';
import { overrideSealedMode, sealedMode } from '@/lib/db/sealed';
import { ServiceError } from './errors';
import { isRestoreInProgress } from './restoreState';

export interface RecoveryNotice {
  id: string;
  at: string;
  /** What the person is told, in plain words. */
  message: string;
  /** When the save the books were reopened from was made (null: not known / not reopened yet). */
  savedAt: string | null;
  /** True when the damaged copy held changes the company file does not have (they are lost). */
  changesLost: boolean;
  /** Where the damaged copy was kept (on this computer). */
  keptAt: string | null;
}

type Outcome = 'replaced' | 'resealed' | null;

const g = globalThis as typeof globalThis & {
  __ironbooksRecoveryNotice?: RecoveryNotice | null;
  __ironbooksRecovery?: Promise<Outcome> | null;
};

/** The notice of a recovery made by this server process (null when none was needed). */
export function recoveryNotice(): RecoveryNotice | null {
  return g.__ironbooksRecoveryNotice ?? null;
}

/** Tests. */
export function resetRecoveryState(): void {
  g.__ironbooksRecoveryNotice = null;
  g.__ironbooksRecovery = null;
}

/** Why a data folder (or a snapshot of one) would not start, or null when it looks fine / unknown. */
export function dataDirProblem(dir: string): string | null {
  const r = pgData.checkDataDir(dir) as { ok: boolean | null; reason: string | null };
  return r.ok === false ? r.reason : null;
}

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
        ? `The copy of your books on this computer is damaged (${reason}), so Ironbooks did not save it over your company file, which still holds your last good save. Close the company file and open it again: Ironbooks then reopens it from that save.`
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

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** The working copy of the open single company file (null when the server runs on a company folder). */
function workingCopyDir(): string | null {
  if (!process.env.BKA_COMPANY_FILE) return null;
  const st = process.env.BKA_COMPANY_STATE;
  return st ? path.resolve(path.dirname(st), 'data') : resolveDataDir();
}

function stamp(when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
}

function whenText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ` (saved ${d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })})`;
}

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
  return session.logFingerprint(dir) !== (base.fingerprint ?? null);
}

function noticeFor(opts: { savedAt: string | null; changesLost: boolean; keptAt: string }): RecoveryNotice {
  const lost = opts.changesLost
    ? 'Changes made after that save could not be recovered. Please check your most recent work and enter again anything that is missing.'
    : 'Nothing was lost: everything had already been saved to the company file.';
  const message = `The copy of your books on this computer was damaged, most likely because Ironbooks or the computer stopped unexpectedly. Ironbooks reopened your company file as it was last saved${whenText(opts.savedAt)}. ${lost} The damaged copy was kept at ${opts.keptAt}.`;
  return { id: randomUUID(), at: new Date().toISOString(), message, savedAt: opts.savedAt, changesLost: opts.changesLost, keptAt: opts.keptAt };
}

/**
 * Called by lib/db getDb when the database in `dir` would not start. Returns 'replaced' (open it
 * again: the working copy now holds the company file's last save), 'resealed' (a protected file
 * nobody has signed in to yet: the sign-in will decrypt the company file) or null (nothing could
 * be done here: not the working copy of a company file, or its last save does not start either).
 * One recovery at a time; concurrent callers share it.
 */
export function recoverUnstartableWorkingCopy(dir: string): Promise<Outcome> {
  if (g.__ironbooksRecovery) return g.__ironbooksRecovery;
  g.__ironbooksRecovery = doRecover(path.resolve(dir)).finally(() => {
    g.__ironbooksRecovery = null;
  });
  return g.__ironbooksRecovery;
}

async function doRecover(dir: string): Promise<Outcome> {
  const work = workingCopyDir();
  const file = process.env.BKA_COMPANY_FILE ? path.resolve(process.env.BKA_COMPANY_FILE) : null;
  if (!work || !file || !samePath(work, dir)) return null;
  // A restore is putting other books in place and checks them itself: books it swapped in that do
  // not start are rolled back by the restore (lib/services/backup.ts), never replaced from here.
  if (isRestoreInProgress(dir)) return null;
  // Another request already put it right and the books are open again: nothing more to do. (Never
  // test-start a folder that may be open: a second Postgres on it is what damages it.)
  if (isDbOpen(dir)) return 'replaced';
  const manifest = format.readCompanyManifest(file) as Record<string, any> | null;
  if (!manifest) return null;
  const mode = sealedMode();
  // A protected file being decrypted from the company file right now ('extract' / 'conflict'):
  // these books ARE its last save, so there is nothing better to reopen from.
  if (mode === 'extract' || mode === 'conflict') return null;
  const sealed = format.isSealedManifest(manifest);
  let fileKey: Buffer | null = null;
  if (sealed && mode !== 'key') {
    const { fileKeyFor } = await import('./fileProtection');
    fileKey = fileKeyFor(dir);
    if (!fileKey) return null; // signed in without the key: nothing here can decrypt the file
  }

  const changesLost = heldUnsavedChanges(dir);
  const workDir = path.dirname(dir);
  const keptAt = path.join(workDir, `damaged copy ${stamp(new Date())}`);

  if (sealed && mode === 'key') {
    // Nobody has signed in yet, and the sign-in of a working copy on this computer reads its users
    // from that copy. Keep it aside and let the sign-in decrypt the company file instead (its key
    // slots are in the file's own listing), like opening the file on a new computer.
    await format.renameWithRetry(dir, keptAt);
    keepSessionSecret(keptAt, dir);
    overrideSealedMode('extract');
    g.__ironbooksRecoveryNotice = noticeFor({ savedAt: manifest.savedAt ?? null, changesLost, keptAt });
    console.error(`[company-file] the working copy ${dir} would not start; kept at ${keptAt}. The sign-in reopens the company file.`);
    return 'resealed';
  }

  // Unpack the last save next to the working copy and start it once before it replaces anything.
  const tmp = `${dir}.recover-${Date.now()}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  let opened: Record<string, any>;
  try {
    opened = await format.extractCompanyFile(file, tmp, fileKey ? { fileKey } : {});
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error('[company-file] the company file could not be unpacked to replace a damaged working copy:', (err as Error)?.message ?? err);
    return null;
  }
  if (dataDirProblem(tmp) !== null || !(await starts(tmp))) {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.error(`[company-file] the working copy ${dir} would not start, and neither does the last save of ${file}.`);
    return null;
  }
  // Files that belong to this computer, never to the company file (the session-signing key, the
  // backup history and settings), stay with the working copy.
  for (const name of ['.auth-secret', '.backup-history.json', '.backup-settings.json']) {
    const from = path.join(dir, name);
    if (fs.existsSync(from) && !fs.existsSync(path.join(tmp, name))) fs.copyFileSync(from, path.join(tmp, name));
  }
  // Protected or not as the reopened save is — never as the damaged copy was (a folder marked
  // protected whose books are not refuses every save): the marker comes from the file's own key.
  fs.rmSync(path.join(tmp, session.PROTECTED_MARKER), { force: true });
  if (sealed && manifest.encryption?.keyCheck) {
    fs.writeFileSync(path.join(tmp, session.PROTECTED_MARKER), JSON.stringify({ keyCheck: manifest.encryption.keyCheck }) + '\n');
  }
  await format.renameWithRetry(dir, keptAt);
  await format.renameWithRetry(tmp, dir);
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
  g.__ironbooksRecoveryNotice = noticeFor({ savedAt: opened.savedAt ?? manifest.savedAt ?? null, changesLost, keptAt });
  console.error(`[company-file] the working copy ${dir} would not start; kept at ${keptAt} and reopened from ${file}.`);
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
 * Sign-in of a protected file whose working copy is already here ('key'): try the working copy
 * first, so one that would not start is set aside BEFORE the sign-in decides how to unlock the
 * file (lib/db getDb runs the recovery; afterwards sealedMode() says 'extract').
 */
export async function settleSealedWorkingCopy(): Promise<void> {
  if (sealedMode() !== 'key') return;
  try {
    await withSealedAccess(() => getDb());
  } catch (err) {
    if ((err as ServiceError)?.details && (err as { details: { resealed?: boolean } }).details.resealed) return;
    throw err;
  }
}
