/**
 * Sandbox mode — "Try it on a copy".
 *
 * One click makes a throwaway copy of the whole company file (every company in the data
 * directory) and opens the app on the copy, so a user can try a risky change, practise, or
 * follow along with training without touching the real books. Leaving offers two choices:
 *
 *   Discard sandbox          — delete the copy, return to the real file.
 *   Keep as a training file  — move the copy next to the real file under a chosen name and
 *                              return to the real file. It is never merged back.
 *
 * How the copy is made (consistent snapshot, the same discipline as restoreBackup): the real
 * file's PGlite handle is closed first (PGlite checkpoints and flushes on close), then the data
 * directory is copied file-for-file with the event loop blocked (fs.cpSync), so no request can
 * write in the middle. The copy keeps the file's .auth-secret and .file-id, so the signed-in
 * user stays signed in, and gets a marker (SANDBOX_MARKER, lib/services/sandboxState.ts).
 *
 * How the app switches to it:
 *  - Server side (web / dev and desktop alike) the server points its active data directory
 *    (process.env.BKA_DATA_DIR, read by resolveDataDir on every call) at the copy. From then on
 *    every getDb(), attachment, transaction-log and session lookup uses the copy; the real
 *    file's handle is closed and nothing reopens it until the user leaves.
 *  - Desktop (Electron): after the server switched, the renderer tells the shell
 *    (window.bookkeeper.sandbox.entered), which records the copy as the active company file with
 *    a sandbox flag and relaunches into it like File > Open Company — the shell then skips
 *    auto-backups, scheduled reports, hosting, Recent Companies and update prompts.
 *  - Web / dev limitation: the switch lives in the server process. If the server restarts while
 *    in the sandbox it comes back on the real file; the copy is listed on the Sandbox page
 *    ("Copies left over") where it can be resumed or discarded.
 *
 * Every sandbox lives in its own container folder under sandboxRoot() (BKA_SANDBOX_ROOT, set by
 * the desktop shell to <userData>/sandboxes, else "Ironbooks Sandboxes" next to the real file),
 * so the copy's own side folders (pre-op backups, report exports, condense archives — all
 * siblings of a data dir) are removed with it on discard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir, type DB } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { ServiceError, inTransaction, writeAudit, type ServiceContext } from './_base';
import { requireFileAdmin } from './access';
import { assertExclusiveAccess } from './sessions';
import {
  SANDBOX_MARKER_SCHEMA,
  activeSandbox,
  readSandboxMarker,
  syncSandboxEnv,
  writeSandboxMarker,
  type SandboxKind,
  type SandboxMarker,
} from './sandboxState';

export {
  SANDBOX_MARKER,
  SANDBOX_BANNER_TEXT,
  TRAINING_BANNER_TEXT,
  assertNotSandbox,
  isSandboxActive,
  readSandboxMarker,
  type SandboxKind,
  type SandboxMarker,
} from './sandboxState';

/** Marks a folder under sandboxRoot() as a container this module created (safe to delete). */
export const SANDBOX_CONTAINER_MARKER = '.ironbooks-sandbox-container';
/** Desktop company-file manifest (mirrors electron/companyFile.js). */
const COMPANY_FILE_MANIFEST = 'bookkeeper-company.json';
const COMPANY_FILE_SCHEMA = 'bookkeeper-company/v1';
/** Longest name a training file may be given. */
export const TRAINING_NAME_MAX = 80;

// ---------------------------------------------------------------------------
// Paths and small helpers
// ---------------------------------------------------------------------------

/** Folder holding the sandbox containers for a real company file. */
export function sandboxRoot(realDataDir: string = resolveDataDir()): string {
  if (process.env.BKA_SANDBOX_ROOT) return path.resolve(process.env.BKA_SANDBOX_ROOT);
  return path.join(path.dirname(path.resolve(realDataDir)), 'Ironbooks Sandboxes');
}

/** Point the server at another data directory (and refresh the PDF stamp flag). */
export function switchActiveDataDir(dir: string): void {
  process.env.BKA_DATA_DIR = path.resolve(dir);
  syncSandboxEnv(readSandboxMarker(dir));
}

const samePath = (a: string, b: string) => {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

/** Filesystem-safe name (keeps spaces; strips path and reserved characters). */
function safeName(s: string, fallback = 'Company'): string {
  const out = s
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim()
    .slice(0, TRAINING_NAME_MAX);
  return out || fallback;
}

function readCompanyManifest(dir: string): Record<string, unknown> | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, COMPANY_FILE_MANIFEST), 'utf8'));
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeCompanyManifest(dir: string, patch: Record<string, unknown>): void {
  const merged = { schema: COMPANY_FILE_SCHEMA, ...(readCompanyManifest(dir) ?? {}), ...patch };
  fs.writeFileSync(path.join(dir, COMPANY_FILE_MANIFEST), JSON.stringify(merged, null, 2), 'utf8');
}

/** Human name of a company file: its manifest name, else the folder name. */
function fileDisplayName(dir: string, fallback?: string): string {
  const m = readCompanyManifest(dir);
  if (m && typeof m.name === 'string' && m.name.trim()) return m.name.trim();
  const base = path.basename(dir).replace(/\.(ironbooks|bookkeeper)$/i, '');
  return base && base !== 'default' ? base : fallback ?? base ?? 'Company';
}

function removeContainer(container: string): void {
  // Only ever delete a folder this module created.
  if (!fs.existsSync(path.join(container, SANDBOX_CONTAINER_MARKER))) {
    throw new ServiceError('INTERNAL', 'Refusing to delete a folder that is not a sandbox copy.');
  }
  fs.rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Move a directory, falling back to copy + delete across drives (EXDEV). */
function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The company to attribute an audit entry to in `db` (the caller's, else the file's oldest). */
async function auditCompanyIn(db: DB, preferred: string): Promise<string | null> {
  const [hit] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, preferred));
  if (hit) return hit.id;
  const [first] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
  return first?.id ?? null;
}

/** Record a sandbox event in the REAL file's audit trail (best effort — never traps the user). */
async function auditReal(
  db: DB,
  ctx: Pick<ServiceContext, 'companyId' | 'userId'>,
  action: 'create' | 'update' | 'delete',
  values: Record<string, unknown>,
): Promise<void> {
  try {
    const companyId = await auditCompanyIn(db, ctx.companyId);
    if (!companyId) return;
    const auditCtx: ServiceContext = { db, companyId, userId: ctx.userId };
    await inTransaction(auditCtx, (tx) =>
      writeAudit(tx, {
        action,
        entityType: 'sandbox',
        entityId: companyId,
        ...(action === 'create' ? { newValues: values } : action === 'delete' ? { oldValues: values } : { newValues: values }),
      }),
    );
  } catch (err) {
    console.warn('[sandbox] could not record the audit entry:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface LeftoverSandbox {
  /** Container folder name (the id used by resume / discard). */
  id: string;
  sourceName: string;
  createdAt: string;
}

export interface SandboxStatus {
  active: boolean;
  kind: SandboxKind | null;
  /** Name of the real company file the copy was made from. */
  sourceName: string | null;
  createdAt: string | null;
  /** Training files: the name it was kept under. */
  trainingName: string | null;
  /** In a sandbox: whether the real file is still where it was (leaving needs it). */
  realFileFound: boolean | null;
  /** Not in a sandbox: copies of THIS file that were never discarded (e.g. after a restart). */
  leftovers: LeftoverSandbox[];
}

interface LocatedSandbox {
  container: string;
  dir: string;
  marker: SandboxMarker;
}

/** Sandboxes of `realDataDir` under its sandbox root (excluding none — callers filter). */
function locateSandboxes(realDataDir: string): LocatedSandbox[] {
  const root = sandboxRoot(realDataDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LocatedSandbox[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const container = path.join(root, e.name);
    if (!fs.existsSync(path.join(container, SANDBOX_CONTAINER_MARKER))) continue;
    let inner: fs.Dirent[];
    try {
      inner = fs.readdirSync(container, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of inner) {
      if (!d.isDirectory()) continue;
      const dir = path.join(container, d.name);
      const marker = readSandboxMarker(dir);
      if (marker && marker.kind === 'sandbox' && samePath(marker.realDataDir, realDataDir)) {
        out.push({ container, dir, marker });
        break;
      }
    }
  }
  return out.sort((a, b) => b.marker.createdAt.localeCompare(a.marker.createdAt));
}

export function listLeftoverSandboxes(realDataDir: string = resolveDataDir()): LeftoverSandbox[] {
  return locateSandboxes(realDataDir).map((s) => ({
    id: path.basename(s.container),
    sourceName: s.marker.sourceName,
    createdAt: s.marker.createdAt,
  }));
}

export function getSandboxStatus(): SandboxStatus {
  const marker = activeSandbox();
  if (marker) {
    return {
      active: true,
      kind: marker.kind,
      sourceName: marker.sourceName,
      createdAt: marker.createdAt,
      trainingName: marker.trainingName ?? null,
      realFileFound: fs.existsSync(marker.realDataDir),
      leftovers: [],
    };
  }
  return {
    active: false,
    kind: null,
    sourceName: null,
    createdAt: null,
    trainingName: null,
    realFileFound: null,
    leftovers: listLeftoverSandboxes(),
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface SandboxStartResult {
  /** The copy's data directory (now the active one). */
  dir: string;
  /** The real company file's data directory. */
  realDir: string;
  id: string;
  sourceName: string;
  createdAt: string;
}

function assertCanEnter(): void {
  const current = readSandboxMarker();
  if (!current) return;
  throw new ServiceError(
    'CONFLICT',
    current.kind === 'sandbox'
      ? 'You are already working in the sandbox. Leave it first to start a fresh copy.'
      : 'This is a training file. Open your real company file to try something on a copy of it.',
  );
}

async function openAndVerify(dir: string, realDir: string, container: string): Promise<void> {
  switchActiveDataDir(dir);
  try {
    await getDb(dir);
  } catch (err) {
    switchActiveDataDir(realDir);
    await closeDb(dir).catch(() => undefined);
    try {
      removeContainer(container);
    } catch {
      /* a leftover copy is harmless — it is listed on the Sandbox page */
    }
    throw err instanceof ServiceError
      ? err
      : new ServiceError('INTERNAL', `The copy could not be opened, so you are still in your real file: ${(err as Error).message}`);
  }
}

/**
 * Make a throwaway copy of the whole company file and switch the server to it.
 * Needs an Admin of every company in the file, with nobody else logged in (the copy and the
 * switch affect the whole file).
 */
export async function startSandbox(ctx: ServiceContext, opts: { now?: Date } = {}): Promise<SandboxStartResult> {
  assertCanEnter();
  await requireFileAdmin(ctx);
  await assertExclusiveAccess(ctx, 'Trying it on a copy', { scope: 'file' });

  const realDir = resolveDataDir();
  if (!fs.existsSync(realDir)) throw new ServiceError('NOT_FOUND', 'The company file could not be found.');
  const [company] = await ctx.db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId));
  const sourceName = fileDisplayName(realDir, company?.name ?? 'Company');
  const createdAt = (opts.now ?? new Date()).toISOString();

  // Recorded in the real file BEFORE the copy, so both files show when the copy was made.
  await auditReal(ctx.db, ctx, 'create', { event: 'sandbox_started', createdAt });

  const stamp = createdAt.slice(0, 19).replace('T', ' ').replace(/:/g, '');
  const id = `${safeName(sourceName)} sandbox ${stamp} ${randomBytes(2).toString('hex')}`;
  const container = path.join(sandboxRoot(realDir), id);
  const dir = path.join(container, path.basename(realDir));
  fs.mkdirSync(container, { recursive: true });
  fs.writeFileSync(path.join(container, SANDBOX_CONTAINER_MARKER), createdAt, 'utf8');

  // Consistent snapshot: release the real file's handle (PGlite checkpoints + flushes on close),
  // then copy synchronously so no request runs until the copy is complete.
  await closeDb(realDir);
  try {
    fs.cpSync(realDir, dir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      // A stale lock file from a crashed process must not make the copy look "in use".
      filter: (src) => path.basename(src) !== 'postmaster.pid',
    });
    writeSandboxMarker(dir, {
      schema: SANDBOX_MARKER_SCHEMA,
      kind: 'sandbox',
      realDataDir: path.resolve(realDir),
      sourceName,
      createdAt,
    });
    writeCompanyManifest(dir, { name: `${sourceName} (sandbox)`, sandbox: true });
  } catch (err) {
    try {
      removeContainer(container);
    } catch {
      /* ignore */
    }
    throw new ServiceError('INTERNAL', `The copy could not be made: ${(err as Error).message}. Your real file was not changed.`);
  }

  await openAndVerify(dir, realDir, container);
  return { dir, realDir: path.resolve(realDir), id, sourceName, createdAt };
}

// ---------------------------------------------------------------------------
// Leave: discard / keep as a training file
// ---------------------------------------------------------------------------

interface ActiveSandboxInfo {
  dir: string;
  container: string;
  marker: SandboxMarker;
  realDb: DB;
}

/**
 * Switch from the active sandbox back to the real file, after checking the caller may leave:
 * leaving acts on the REAL file, so it needs an Admin of every company there — checked against
 * the real file, opened only now (the real file is never opened while in the sandbox), so
 * whatever was changed in the copy (e.g. a demoted user) does not count. When the check fails
 * the server goes straight back to the sandbox. `precheck` runs before anything is switched.
 */
async function leaveToRealFile(
  ctx: ServiceContext,
  precheck?: (marker: SandboxMarker) => void,
): Promise<ActiveSandboxInfo> {
  const marker = readSandboxMarker();
  if (!marker || marker.kind !== 'sandbox') {
    throw new ServiceError('CONFLICT', 'You are not working in the sandbox.');
  }
  if (!fs.existsSync(marker.realDataDir)) {
    throw new ServiceError(
      'CONFLICT',
      `Your real company file is no longer at ${marker.realDataDir}. Reconnect the drive it is on, then try again.`,
    );
  }
  precheck?.(marker);
  const dir = resolveDataDir();
  switchActiveDataDir(marker.realDataDir);
  let realDb: DB;
  try {
    realDb = await getDb(marker.realDataDir);
    await requireFileAdmin({ db: realDb, userId: ctx.userId });
  } catch (err) {
    switchActiveDataDir(dir);
    await closeDb(marker.realDataDir).catch(() => undefined);
    if (err instanceof ServiceError && err.code === 'FORBIDDEN') {
      throw new ServiceError(
        'FORBIDDEN',
        'Only an Admin of every company in your real company file can leave the sandbox. Sign in as that person.',
      );
    }
    throw err;
  }
  await closeDb(dir);
  return { dir, container: path.dirname(dir), marker, realDb };
}

/** Delete the sandbox copy and switch back to the real company file. */
export async function discardSandbox(ctx: ServiceContext): Promise<{ realDir: string }> {
  const { container, marker, realDb } = await leaveToRealFile(ctx);
  try {
    removeContainer(container);
  } catch (err) {
    console.warn('[sandbox] the copy could not be deleted (it is listed as left over):', (err as Error).message);
  }
  await auditReal(realDb, ctx, 'delete', { event: 'sandbox_discarded', createdAt: marker.createdAt });
  return { realDir: marker.realDataDir };
}

/** Validate a training-file name and return its target folder next to the real file. */
export function trainingTarget(realDataDir: string, name: unknown): { name: string; dir: string } {
  if (typeof name !== 'string' || !name.trim()) {
    throw new ServiceError('VALIDATION', 'Give the training file a name.');
  }
  if (name.trim().length > TRAINING_NAME_MAX) {
    throw new ServiceError('VALIDATION', `Keep the name under ${TRAINING_NAME_MAX} characters.`);
  }
  const clean = safeName(name, '');
  if (!clean) throw new ServiceError('VALIDATION', 'Use letters or numbers in the name.');
  const dir = path.join(path.dirname(path.resolve(realDataDir)), `${clean}.ironbooks`);
  if (samePath(dir, realDataDir)) {
    throw new ServiceError('VALIDATION', 'That is the name of your real company file. Pick another name.');
  }
  if (fs.existsSync(dir)) {
    throw new ServiceError('VALIDATION', `A company file named "${clean}" already exists there. Pick another name.`);
  }
  return { name: clean, dir };
}

/**
 * Keep the sandbox as a training file: switch back to the real file, then move the copy next to
 * the real file under `name`. The training file is a separate company file (its own file id, so
 * a session from it is never valid on the real file) and is never merged back.
 */
export async function keepSandboxAsTraining(
  ctx: ServiceContext,
  name: unknown,
): Promise<{ realDir: string; trainingDir: string; name: string }> {
  let target: { name: string; dir: string } | null = null;
  const { dir, container, marker, realDb } = await leaveToRealFile(ctx, (m) => {
    target = trainingTarget(m.realDataDir, name);
  });
  if (!target) throw new ServiceError('VALIDATION', 'Give the training file a name.');
  const t: { name: string; dir: string } = target;
  try {
    moveDir(dir, t.dir);
  } catch (err) {
    throw new ServiceError(
      'INTERNAL',
      `You are back in your real books, but the copy could not be moved (${(err as Error).message}). It is listed under "Copies left over" on the Sandbox page.`,
    );
  }
  writeSandboxMarker(t.dir, {
    ...marker,
    kind: 'training',
    keptAt: new Date().toISOString(),
    trainingName: t.name,
  });
  writeCompanyManifest(t.dir, { name: t.name, sandbox: false, training: true });
  // A new file id: sessions signed in the training file never open the real file.
  fs.writeFileSync(path.join(t.dir, '.file-id'), randomUUID(), { mode: 0o600 });
  try {
    removeContainer(container);
  } catch {
    /* only side folders were left; harmless */
  }
  await auditReal(realDb, ctx, 'update', { event: 'sandbox_kept_as_training_file', name: t.name });
  return { realDir: marker.realDataDir, trainingDir: t.dir, name: t.name };
}

// ---------------------------------------------------------------------------
// Copies left over (web/dev after a server restart, or a copy that could not be moved)
// ---------------------------------------------------------------------------

function findLeftover(id: unknown): LocatedSandbox {
  if (typeof id !== 'string' || !id || id !== path.basename(id) || id.includes('..')) {
    throw new ServiceError('NOT_FOUND', 'Sandbox copy not found.');
  }
  const hit = locateSandboxes(resolveDataDir()).find((s) => path.basename(s.container) === id);
  if (!hit) throw new ServiceError('NOT_FOUND', 'Sandbox copy not found.');
  return hit;
}

/** Re-open a left-over copy of this file as the sandbox. */
export async function resumeSandbox(ctx: ServiceContext, id: unknown): Promise<SandboxStartResult> {
  assertCanEnter();
  await requireFileAdmin(ctx);
  await assertExclusiveAccess(ctx, 'Opening the sandbox', { scope: 'file' });
  const hit = findLeftover(id);
  const realDir = path.resolve(resolveDataDir());
  await closeDb(realDir);
  switchActiveDataDir(hit.dir);
  try {
    await getDb(hit.dir);
  } catch (err) {
    switchActiveDataDir(realDir);
    await closeDb(hit.dir).catch(() => undefined);
    throw err instanceof ServiceError ? err : new ServiceError('INTERNAL', `That copy could not be opened: ${(err as Error).message}`);
  }
  return {
    dir: hit.dir,
    realDir,
    id: path.basename(hit.container),
    sourceName: hit.marker.sourceName,
    createdAt: hit.marker.createdAt,
  };
}

/** Delete a left-over copy of this file. */
export async function discardLeftoverSandbox(ctx: ServiceContext, id: unknown): Promise<void> {
  if (readSandboxMarker()) throw new ServiceError('CONFLICT', 'Leave the sandbox first.');
  await requireFileAdmin(ctx);
  const hit = findLeftover(id);
  await closeDb(hit.dir).catch(() => undefined);
  removeContainer(hit.container);
}
