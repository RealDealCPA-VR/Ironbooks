/**
 * Agent full access: staged files for agents (plan §5.7, contract §3).
 *
 * An agent hands Ironbooks a file (a receipt, a bank statement, a QuickBooks export) by uploading
 * it here first, and gets back a file id it can put in an operation's input. The other way round,
 * a PDF or download an operation makes is staged here and the agent fetches it by its id.
 *
 * Where: `<root>/<companyId>/<agentId>/`, each file as `<fileId>.bin` (the bytes) and
 * `<fileId>.json` (name, type, size, created). The root is (stagingRoot, stagedFilesRoot):
 *  - BKA_AGENT_FILES_DIR, when set, in test runs only (overrideRoot);
 *  - else the open company file's own working folder on this computer, next to its `data` folder
 *    (`<workDir>/agent-files`, the folder of BKA_COMPANY_STATE). Only `data` goes back into the
 *    company file when it is saved, so staged files never travel with the books;
 *  - else (a company folder, the browser version) this computer's app data folder for Ironbooks,
 *    never the company's own folder or the folder it sits in, which a person chose.
 * A root inside the company's database folder, or one that holds the database folder, the working
 * folder or the company file, is refused (fail closed), and so is one on a share or a device path.
 * The root carries a marker file (MARKER) once this module made or took it: clearing, which removes
 * empty folders, only ever works in a marked root, and a folder already holding other things is
 * never taken over.
 *
 * Rules that keep agents apart and the disk safe:
 *  - A file id is 32 lowercase hex characters from crypto.randomBytes. Any other shape is refused
 *    before the disk is touched, so an id can never be a path.
 *  - An owner only ever looks in its own folder: another agent's or another company's id answers
 *    null, the same as an id that never existed.
 *  - The name is only a label kept in the .json (cleanName): the bytes are always `<fileId>.bin`.
 *  - Every write goes to a temporary name first and is renamed into place, so a reader never sees
 *    half a file. An unfinished upload is `<uploadId>.part`, renamed to `<fileId>.bin` at the end.
 *  - One agent keeps at most AGENT_MAX_BYTES and AGENT_MAX_FILES here at once, and at most
 *    UPLOADS_PER_AGENT unfinished uploads, so it cannot fill the disk the books are on.
 *  - Writes for one agent happen one at a time (its lock); making or removing a folder also takes
 *    the root's lock, so a clear never removes a folder a write is about to use.
 *  - Nothing here logs, and no error passes on a path or a file's content: a disk failure becomes
 *    one plain message (diskTrouble).
 *  - Files and unfinished uploads go after STAGED_FILE_HOURS (clearStagedFiles, also run lazily at
 *    most once an hour by every call here that takes a file id or adds a file), and all of them
 *    when the company file closes.
 *
 * allowedFolder is the check behind save_file and the shell's paths: is this folder inside one the
 * Admin allowed for the agent, once links and ".." are resolved.
 */
import { randomBytes } from 'node:crypto';
import fs, { type Dirent, type Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServiceError } from '@/lib/services/errors';
import {
  STAGED_FILE_HOURS,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_MAX_BYTES,
  type AllowedFolder,
  type ClearStagedFiles,
  type FileOwner,
  type ReadStagedFile,
  type StagedFile,
  type StageFile,
  type StagedFileInfo,
  type UploadChunk,
} from './contract';

/** Overrides where staged files are kept, in test runs only (overrideRoot). */
export const AGENT_FILES_DIR_ENV = 'BKA_AGENT_FILES_DIR';
const FOLDER_NAME = 'agent-files';
/**
 * The file that marks a root as this module's own. Its name is never a company or agent id, so a
 * clear never takes it for one.
 */
const MARKER = '.ironbooks-agent-files';
const MARKER_TEXT = 'Ironbooks keeps files for its agents in this folder, each for a day at most. It is safe to delete while Ironbooks is closed.\n';

const HOUR_MS = 60 * 60 * 1000;
const STAGED_MS = STAGED_FILE_HOURS * HOUR_MS;
/** Unfinished uploads one agent may have at once. */
const UPLOADS_PER_AGENT = 5;
/** Most one agent may keep here at once, staged files and unfinished uploads together (500 MB). */
const AGENT_MAX_BYTES = 10 * UPLOAD_MAX_BYTES;
/** Most files one agent may keep here at once; also keeps the look through its folder short. */
const AGENT_MAX_FILES = 1000;
/** Longest name kept for a staged file, in characters, extension included. */
const NAME_MAX = 120;
const FALLBACK_NAME = 'file';
const FALLBACK_TYPE = 'application/octet-stream';

const ID_RE = /^[0-9a-f]{32}$/;
/** A company or agent id as it may become a folder name (both are uuids). */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY_RE = /^([0-9a-f]{32})\.(bin|json|part)$/;
const TEMP_RE = /^[0-9a-f]{32}\.(bin|json|part)\.[0-9a-f]{12}\.tmp$/;

// Owner only on POSIX; Windows keeps the user profile's own permissions.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const WIN = process.platform === 'win32';
const MB = 1024 * 1024;

interface Meta {
  name: string;
  type: string;
  size: number;
  created: string;
}

// Process-wide, like the open databases (Next.js loads a module once per route bundle in dev).
const g = globalThis as typeof globalThis & { __bkaAgentFiles?: { clearedAt: number; locks: Map<string, Promise<void>> } };
const state = (g.__bkaAgentFiles ??= { clearedAt: 0, locks: new Map() });

// ---------------------------------------------------------------------------
// Where the files are
// ---------------------------------------------------------------------------

/** lib/db/index.ts resolveDataDir, without loading the database layer here. */
function companyDataDir(): string {
  if (process.env.BKA_DATA_DIR) return path.resolve(process.env.BKA_DATA_DIR);
  return path.resolve(process.cwd(), '.bookkeeper-data', 'default');
}

/** This computer's app data folder for Ironbooks (as lib/agent/endpointFile.ts finds its own). */
function appDataRoot(): string {
  const home = os.homedir();
  if (WIN) return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ironbooks', FOLDER_NAME);
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ironbooks', FOLDER_NAME);
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ironbooks', FOLDER_NAME);
}

/**
 * BKA_AGENT_FILES_DIR, in test runs only. An installed Ironbooks never lets a value planted in
 * the environment move agents' files (bank statements, reports) somewhere else, such as a synced
 * or shared folder: its server always runs with NODE_ENV=production.
 */
function overrideRoot(): string | null {
  const mode = process.env.NODE_ENV;
  if (mode === 'production' || (mode !== 'test' && !process.env.VITEST)) return null;
  const dir = process.env[AGENT_FILES_DIR_ENV]?.trim();
  return dir ? path.resolve(dir) : null;
}

/** The folder all staged files live under (see the module comment). Throws when it is refused. */
function stagingRoot(): string {
  const stateFile = process.env.BKA_COMPANY_STATE?.trim();
  const workDir = stateFile ? path.dirname(path.resolve(stateFile)) : null;
  const root = overrideRoot() ?? (workDir ? path.join(workDir, FOLDER_NAME) : appDataRoot());
  // Staged files stay on this computer: never on a network share or a device path.
  if (isDevicePath(root) || uncShare(root) !== null) {
    throw new ServiceError('INTERNAL', 'Ironbooks is set up to keep agent files on another computer, which it never does. Ask a person to check how Ironbooks was started.');
  }
  // Never inside the database folder, and never a folder that holds the books (the database
  // folder, the open file's working folder, the company file): clearing removes empty folders,
  // and the database has empty folders of its own.
  const dataDir = companyDataDir();
  const companyFile = process.env.BKA_COMPANY_FILE?.trim();
  const books = [dataDir, workDir, companyFile ? path.resolve(companyFile) : null].filter((p): p is string => !!p);
  if (within(root, dataDir) || books.some((b) => within(b, root))) {
    throw new ServiceError(
      'INTERNAL',
      'Ironbooks is set up to keep agent files inside the company file, or in a folder that holds it, which it never does. Ask a person to check how Ironbooks was started.',
    );
  }
  return root;
}

/**
 * Where staged files are kept on this computer (the folder may not exist yet), or null when the
 * setup is refused and nothing is kept at all. Nothing is made here. For the folder rules of other
 * units: a folder an agent may use must never hold this one or lie inside it, or the agent's own
 * file access would reach other agents' staged files.
 */
export function stagedFilesRoot(): string | null {
  try {
    return stagingRoot();
  } catch {
    return null;
  }
}

function segment(id: unknown): string | null {
  return typeof id === 'string' && SEGMENT_RE.test(id) ? id.toLowerCase() : null;
}

/** The owner's own folder, or null when the owner is not a plain company and agent id. */
function ownerDirOrNull(owner: FileOwner): string | null {
  const company = segment(owner?.companyId);
  const agent = segment(owner?.agentId);
  if (!company || !agent) return null;
  try {
    return path.join(stagingRoot(), company, agent);
  } catch {
    return null;
  }
}

function ownerDir(owner: FileOwner): string {
  const company = segment(owner?.companyId);
  const agent = segment(owner?.agentId);
  if (!company || !agent) throw new ServiceError('FORBIDDEN', 'Ironbooks could not tell which agent this file is for, so it was not kept.');
  return path.join(stagingRoot(), company, agent);
}

// ---------------------------------------------------------------------------
// Names, types, messages
// ---------------------------------------------------------------------------

/**
 * Control and invisible formatting characters (direction marks, zero-width ones), line separators,
 * and halves of a character pair standing alone, which cannot be shown and change when written
 * out as UTF-8 (to a disk, or to the agent).
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;
/** What Windows refuses in a name (the separators are taken care of before). */
const NOT_IN_NAMES = /[:*?"<>|]/g;
/** Names Windows keeps for devices, with or without an extension (lib/effects.ts DEVICE_NAME). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu;
const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;

/**
 * A name safe to show and to save under later (lib/effects.ts checkFile accepts it): the last part
 * of a path only, no control or direction-mark characters, nothing Windows refuses, no device
 * name, no trailing dot or space, at most NAME_MAX characters with the extension kept.
 */
function cleanName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw.normalize('NFC') : '';
  name = name.replace(/[\t\n\v\f\r]/g, ' ').replace(INVISIBLE, '');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(NOT_IN_NAMES, '-').replace(/\s+/g, ' ').trim();
  // Windows drops trailing dots and spaces, so "report." would be saved as another name.
  name = name.replace(/[. ]+$/, '');
  if (!name) return FALLBACK_NAME;
  const fitted = fitName(name, NAME_MAX);
  // A device name gets a "_" in front, and the cut leaves room for it.
  return DEVICE_NAME.test(fitted) ? `_${fitName(name, NAME_MAX - 1)}` : fitted;
}

/** `name` cut to at most `max` characters (never half a character), its extension kept. */
function fitName(name: string, max: number): string {
  if (Array.from(name).length <= max) return name;
  const ext = EXTENSION.exec(name)?.[0] ?? '';
  const stem = Array.from(name.slice(0, name.length - ext.length))
    .slice(0, max - ext.length)
    .join('')
    .replace(/[. ]+$/, '');
  return (stem || FALLBACK_NAME) + ext;
}

/** A plain MIME type ("application/pdf"), or application/octet-stream. */
function cleanType(raw: unknown): string {
  const t = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
  return t.length <= 100 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t) ? t : FALLBACK_TYPE;
}

function tooLarge(): ServiceError {
  return new ServiceError('VALIDATION', `A file can be at most ${UPLOAD_MAX_BYTES / MB} MB here. Send a smaller file, or split it into several.`);
}

function unknownUpload(): ServiceError {
  return new ServiceError(
    'VALIDATION',
    'There is no unfinished upload with that id. It may have been finished, stopped or cleared after a day. Start the upload again without an uploadId.',
  );
}

function tooManyUploads(): ServiceError {
  return new ServiceError(
    'VALIDATION',
    `This agent already has ${UPLOADS_PER_AGENT} unfinished uploads. Finish one of them (send its last part), or wait a day for them to be cleared, then start again.`,
  );
}

function agentFull(): ServiceError {
  return new ServiceError(
    'VALIDATION',
    `This agent already keeps as much here as one agent may at once (${AGENT_MAX_BYTES / MB} MB, or ${AGENT_MAX_FILES} files). Each file is cleared a day after it was made: work with the files it already has, or try again later.`,
  );
}

/** The root exists and holds other things, without the marker: it is not taken over. */
function notOurFolder(): ServiceError {
  return new ServiceError(
    'INTERNAL',
    'The folder Ironbooks would keep agent files in already holds other things, so it was not used. Ask a person to check how Ironbooks was started.',
  );
}

/** A disk failure, said without the path or the system's own words (they name folders). */
function diskTrouble(): ServiceError {
  return new ServiceError('INTERNAL', 'Ironbooks could not keep the file on this computer. Try again in a moment; if it keeps failing, ask a person to check that the disk has free space.');
}

async function onDisk<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw diskTrouble();
  }
}

function errCode(err: unknown): string {
  return String((err as { code?: unknown } | null)?.code ?? '');
}

function newId(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

/** The root an owner folder (`<root>/<companyId>/<agentId>`) is in. */
function rootOf(dir: string): string {
  return path.dirname(path.dirname(dir));
}

/** The root carries the marker: this module made it, or took it over while it was empty. */
async function ownRoot(root: string): Promise<boolean> {
  try {
    return (await fsp.lstat(path.join(root, MARKER))).isFile();
  } catch {
    return false;
  }
}

/** Make the root when it is missing, and mark it. A folder that already holds other things is refused. Under the root's lock. */
async function claimRoot(root: string): Promise<void> {
  if (await ownRoot(root)) return;
  await fsp.mkdir(root, { recursive: true, mode: DIR_MODE });
  if ((await fsp.readdir(root)).length) throw notOurFolder();
  try {
    await fsp.writeFile(path.join(root, MARKER), MARKER_TEXT, { flag: 'wx', mode: FILE_MODE });
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
  }
}

/**
 * Make the owner's folder, in a marked root. The caller holds the owner's lock and this takes the
 * root's: a clear removes an empty folder only under both, so it never takes the folder away
 * between its making and the first file in it. Lock order is always owner, then root.
 */
async function ownerReady(dir: string): Promise<void> {
  const root = rootOf(dir);
  await withLock(root, async () => {
    await claimRoot(root);
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  });
}

/**
 * Write `final` so it appears whole or not at all: a temporary file next to it, renamed into place.
 * The folder is made again when it went meanwhile (a person removed it). Under the owner's lock.
 */
async function writeAtomic(dir: string, final: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    try {
      await fsp.writeFile(tmp, data, { flag: 'wx', mode: FILE_MODE });
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err;
      await ownerReady(dir);
      await fsp.writeFile(tmp, data, { flag: 'wx', mode: FILE_MODE });
    }
    await fsp.rename(tmp, final);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function writeMeta(dir: string, fileId: string, meta: Meta): Promise<void> {
  await writeAtomic(dir, path.join(dir, `${fileId}.json`), JSON.stringify(meta));
}

function parseMeta(text: string): Meta | null {
  try {
    const m = JSON.parse(text) as Partial<Meta> | null;
    if (
      m &&
      typeof m.name === 'string' &&
      typeof m.type === 'string' &&
      typeof m.size === 'number' &&
      Number.isSafeInteger(m.size) &&
      m.size >= 0 &&
      typeof m.created === 'string' &&
      !Number.isNaN(Date.parse(m.created))
    ) {
      return { name: m.name, type: m.type, size: m.size, created: m.created };
    }
  } catch {
    /* not ours, or damaged: treated as no file */
  }
  return null;
}

/** When a staged file was made: the earliest of what it says and what the disk says (a clock set back cannot keep it). */
function bornAt(meta: Meta | null, ...mtimes: number[]): number {
  const created = meta ? Date.parse(meta.created) : NaN;
  return Math.min(...[created, ...mtimes].filter((n) => Number.isFinite(n)));
}

/**
 * One write or clear at a time per agent folder, so parts are appended in turn and the limits
 * hold; the root's lock guards making and removing folders. Not re-entrant: never take the same
 * key twice, and never an owner's lock while holding the root's.
 */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = WIN ? key.toLowerCase() : key;
  const prev = state.locks.get(k) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  state.locks.set(k, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (state.locks.get(k) === chained) state.locks.delete(k);
  }
}

/**
 * Clear old files now and then (at most once an hour), from the calls here that take a file id or
 * add a file, so files of a crash are not kept long by a busy agent. Never fails the call. Called
 * outside every lock (a clear takes them all in turn).
 */
async function clearNowAndThen(): Promise<void> {
  const now = Date.now();
  if (now - state.clearedAt < HOUR_MS) return;
  state.clearedAt = now;
  try {
    await clearStagedFiles();
  } catch {
    /* next time */
  }
}

/** What an owner keeps here now: its live staged files and unfinished uploads, and their bytes. */
async function usage(dir: string): Promise<{ files: number; bytes: number; uploads: number }> {
  const out = { files: 0, bytes: 0, uploads: 0 };
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const n of names) {
    const m = ENTRY_RE.exec(n);
    if (!m || m[2] === 'json') continue;
    const p = path.join(dir, n);
    try {
      const st = await fsp.lstat(p);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > STAGED_MS) {
        // Expired: it no longer counts. An old upload goes at once, it can never be finished.
        if (m[2] === 'part') await fsp.rm(p, { force: true });
        continue;
      }
      out.files++;
      out.bytes += st.size;
      if (m[2] === 'part') out.uploads++;
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** Refuse what would take the owner over its limits. Under the owner's lock, so the answer holds until the write. */
async function checkRoom(dir: string, add: { bytes: number; file: boolean; upload: boolean }): Promise<void> {
  const kept = await usage(dir);
  if (add.upload && kept.uploads >= UPLOADS_PER_AGENT) throw tooManyUploads();
  if ((add.file && kept.files >= AGENT_MAX_FILES) || kept.bytes + add.bytes > AGENT_MAX_BYTES) throw agentFull();
}

/**
 * Keep `bytes` as a new staged file in `dir`. The .bin goes first: a .json always has its bytes.
 * Under the owner's lock, after checkRoom.
 */
async function writeStaged(dir: string, name: string, type: string, bytes: Uint8Array): Promise<StagedFile> {
  const fileId = newId();
  const bin = path.join(dir, `${fileId}.bin`);
  await ownerReady(dir);
  await writeAtomic(dir, bin, bytes);
  try {
    await writeMeta(dir, fileId, { name, type, size: bytes.byteLength, created: new Date().toISOString() });
  } catch (err) {
    await fsp.rm(bin, { force: true }).catch(() => undefined);
    throw err;
  }
  return { fileId, name, type, size: bytes.byteLength };
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** The owner's staged file with that id, when it is there, whole and not yet expired. */
async function findStaged(owner: FileOwner, fileId: string): Promise<{ file: StagedFile; bin: string } | null> {
  if (!validId(fileId)) return null;
  const dir = ownerDirOrNull(owner);
  if (!dir) return null;
  const bin = path.join(dir, `${fileId}.bin`);
  const json = path.join(dir, `${fileId}.json`);
  try {
    const [bs, js] = await Promise.all([fsp.lstat(bin), fsp.lstat(json)]);
    if (!bs.isFile() || !js.isFile()) return null;
    const meta = parseMeta(await fsp.readFile(json, 'utf8'));
    if (!meta || meta.size !== bs.size) return null;
    if (Date.now() - bornAt(meta, bs.mtimeMs, js.mtimeMs) > STAGED_MS) return null;
    return { file: { fileId, name: meta.name, type: meta.type, size: meta.size }, bin };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Staged files
// ---------------------------------------------------------------------------

export const stageFile: StageFile = async (owner, file) => {
  const dir = ownerDir(owner);
  if (!file || !(file.bytes instanceof Uint8Array)) throw new ServiceError('VALIDATION', 'There is no file content to keep. Send the file again.');
  if (file.bytes.byteLength > UPLOAD_MAX_BYTES) throw tooLarge();
  const name = cleanName(file.name);
  const type = cleanType(file.type);
  const bytes = file.bytes;
  await clearNowAndThen();
  return withLock(dir, () =>
    onDisk(async () => {
      await checkRoom(dir, { bytes: bytes.byteLength, file: true, upload: false });
      return writeStaged(dir, name, type, bytes);
    }),
  );
};

/** A plain file id and owner: only then is the disk looked at, the lazy clear included. */
function worthLooking(owner: FileOwner, fileId: unknown): boolean {
  return validId(fileId) && ownerDirOrNull(owner) !== null;
}

export const readStagedFile: ReadStagedFile = async (owner, fileId) => {
  if (!worthLooking(owner, fileId)) return null;
  await clearNowAndThen();
  const found = await findStaged(owner, fileId);
  if (!found) return null;
  try {
    const bytes = await fsp.readFile(found.bin);
    if (bytes.byteLength !== found.file.size) return null;
    return { file: found.file, bytes };
  } catch {
    return null;
  }
};

export const stagedFileInfo: StagedFileInfo = async (owner, fileId) => {
  if (!worthLooking(owner, fileId)) return null;
  await clearNowAndThen();
  const found = await findStaged(owner, fileId);
  return found ? found.file : null;
};

// ---------------------------------------------------------------------------
// Uploads in parts
// ---------------------------------------------------------------------------

/** Most base64 characters a part may have (whitespace aside), so a huge one is refused before it is decoded. */
const CHUNK_BASE64_MAX = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4;

/** The bytes of one part: standard base64 (line breaks allowed), at most UPLOAD_CHUNK_BYTES decoded. */
function decodeChunk(raw: unknown): Buffer {
  if (typeof raw !== 'string') throw new ServiceError('VALIDATION', 'Each part of an upload is sent as base64 text in chunkBase64.');
  const partTooLarge = () =>
    new ServiceError('VALIDATION', `Each part of an upload can be at most ${UPLOAD_CHUNK_BYTES / MB} MB once decoded. Send the file in smaller parts.`);
  if (raw.length > CHUNK_BASE64_MAX * 2) throw partTooLarge();
  const text = raw.replace(/[\r\n\t ]/g, '');
  if (text.length > CHUNK_BASE64_MAX) throw partTooLarge();
  const padded = text.includes('=');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || (padded ? text.length % 4 !== 0 : text.length % 4 === 1)) {
    throw new ServiceError('VALIDATION', "That part of the upload is not valid base64 text. Encode the file's bytes as standard base64 and send the part again.");
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.byteLength > UPLOAD_CHUNK_BYTES) throw partTooLarge();
  return bytes;
}

export const uploadChunk: UploadChunk = async (owner, part) => {
  const dir = ownerDir(owner);
  if (!part || typeof part !== 'object') throw new ServiceError('VALIDATION', 'Send the upload part with its name, type, chunkBase64 and last.');
  const given = part.uploadId === undefined || part.uploadId === null || part.uploadId === '' ? null : part.uploadId;
  // A malformed id is refused like an unknown one, before anything is read from the disk.
  if (given !== null && (typeof given !== 'string' || !ID_RE.test(given))) throw unknownUpload();
  const bytes = decodeChunk(part.chunkBase64);
  const last = part.last === true;
  await clearNowAndThen();

  return withLock(dir, () =>
    onDisk(async () => {
      if (given === null) {
        const uploadId = newId();
        // All in one part needs no place among the unfinished uploads.
        await checkRoom(dir, { bytes: bytes.byteLength, file: true, upload: !last });
        // All in one part: kept at once, nothing unfinished left behind.
        if (last) return { uploadId, received: bytes.byteLength, file: await writeStaged(dir, cleanName(part.name), cleanType(part.type), bytes) };
        await ownerReady(dir);
        const p = path.join(dir, `${uploadId}.part`);
        try {
          await fsp.writeFile(p, bytes, { flag: 'wx', mode: FILE_MODE });
        } catch (err) {
          await fsp.rm(p, { force: true }).catch(() => undefined);
          throw err;
        }
        return { uploadId, received: bytes.byteLength, file: null };
      }

      const uploadId = given;
      const p = path.join(dir, `${uploadId}.part`);
      // 'r+': the part must already be there. A part cleared meanwhile is never made again from a later piece.
      let handle: FileHandle;
      try {
        handle = await fsp.open(p, 'r+');
      } catch (err) {
        if (errCode(err) === 'ENOENT' || errCode(err) === 'EISDIR') throw unknownUpload();
        throw err;
      }
      let received: number;
      try {
        const st = await handle.stat();
        if (!st.isFile()) throw unknownUpload();
        if (Date.now() - st.mtimeMs > STAGED_MS) {
          await handle.close();
          await fsp.rm(p, { force: true });
          throw unknownUpload();
        }
        if (st.size + bytes.byteLength > UPLOAD_MAX_BYTES) {
          // It can never be finished: stop it, so it does not hold one of the agent's places.
          await handle.close();
          await fsp.rm(p, { force: true });
          throw new ServiceError(
            'VALIDATION',
            `The upload was stopped: its parts come to more than ${UPLOAD_MAX_BYTES / MB} MB, the most a file can be here. Send a smaller file, or split it into several.`,
          );
        }
        // The part already on the disk counts in the usage; only the new bytes are added.
        await checkRoom(dir, { bytes: bytes.byteLength, file: false, upload: false });
        try {
          if (bytes.byteLength) await handle.write(bytes, 0, bytes.byteLength, st.size);
        } catch (err) {
          // Leave the upload as it was before this part, so the agent can send the part again.
          await handle.truncate(st.size).catch(() => undefined);
          throw err;
        }
        received = st.size + bytes.byteLength;
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (!last) return { uploadId, received, file: null };

      const name = cleanName(part.name);
      const type = cleanType(part.type);
      const fileId = newId();
      const bin = path.join(dir, `${fileId}.bin`);
      try {
        await fsp.rename(p, bin);
      } catch (err) {
        if (errCode(err) === 'ENOENT') throw unknownUpload();
        throw err;
      }
      try {
        await writeMeta(dir, fileId, { name, type, size: received, created: new Date().toISOString() });
      } catch (err) {
        await fsp.rm(bin, { force: true }).catch(() => undefined);
        throw err;
      }
      return { uploadId, received, file: { fileId, name, type, size: received } };
    }),
  );
};

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

/** Sub-folders named like a company or agent id; links are never followed. */
async function idFolders(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SEGMENT_RE.test(e.name)).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  await fsp.rmdir(dir).catch(() => undefined);
}

/** Clear one agent's folder. Only names this module makes are touched. Returns staged files and uploads removed. */
async function clearOwner(dir: string, all: boolean, cutoff: number): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const staged = new Map<string, { bin?: string; json?: string }>();
  const parts: string[] = [];
  const temps: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = ENTRY_RE.exec(e.name);
    const p = path.join(dir, e.name);
    if (m) {
      if (m[2] === 'part') parts.push(p);
      else {
        const s = staged.get(m[1]) ?? {};
        s[m[2] as 'bin' | 'json'] = p;
        staged.set(m[1], s);
      }
    } else if (TEMP_RE.test(e.name)) temps.push(p);
  }

  const mtime = async (p: string | undefined): Promise<number> => {
    if (!p) return NaN;
    try {
      return (await fsp.lstat(p)).mtimeMs;
    } catch {
      return NaN;
    }
  };
  const old = (born: number) => all || !Number.isFinite(born) || born < cutoff;

  let removed = 0;
  for (const s of staged.values()) {
    const [binTime, jsonTime] = [await mtime(s.bin), await mtime(s.json)];
    if (Number.isNaN(binTime) && Number.isNaN(jsonTime)) continue; // gone meanwhile
    let meta: Meta | null = null;
    if (s.json) meta = parseMeta(await fsp.readFile(s.json, 'utf8').catch(() => ''));
    const born = bornAt(meta, binTime, jsonTime);
    // A .bin whose .json is still being written is young: left alone unless everything goes.
    if (!old(born)) continue;
    await Promise.all([s.bin, s.json].filter((p): p is string => !!p).map((p) => fsp.rm(p, { force: true }).catch(() => undefined)));
    removed++;
  }
  for (const p of parts) {
    if (!old(await mtime(p))) continue;
    await fsp.rm(p, { force: true }).catch(() => undefined);
    removed++;
  }
  for (const p of temps) {
    if (old(await mtime(p))) await fsp.rm(p, { force: true }).catch(() => undefined);
  }
  return removed;
}

/** The root goes when nothing but its marker is left. The marker comes back when the folder stays after all. */
async function removeRootIfEmpty(root: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return;
  }
  if (names.length !== 1 || names[0] !== MARKER) return;
  const marker = path.join(root, MARKER);
  try {
    await fsp.rm(marker, { force: true });
  } catch {
    return;
  }
  try {
    await fsp.rmdir(root);
  } catch {
    await fsp.writeFile(marker, MARKER_TEXT, { flag: 'wx', mode: FILE_MODE }).catch(() => undefined);
  }
}

export const clearStagedFiles: ClearStagedFiles = async (opts) => {
  const all = opts?.all === true;
  const root = stagingRoot();
  // Only a root this module made is ever cleared: a folder without the marker may be anyone's,
  // and its empty folders may matter to them.
  if (!(await ownRoot(root))) return 0;
  const cutoff = Date.now() - STAGED_MS;
  let removed = 0;
  for (const company of await idFolders(root)) {
    for (const agent of await idFolders(company)) {
      removed += await withLock(agent, async () => {
        const n = await clearOwner(agent, all, cutoff);
        await withLock(root, () => removeIfEmpty(agent));
        return n;
      });
    }
    await withLock(root, () => removeIfEmpty(company));
  }
  // An empty root goes too: the working folder of a company file is pruned only when it holds
  // nothing but its cache (electron/companySession.js pruneWorkingCopies).
  await withLock(root, () => removeRootIfEmpty(root));
  return removed;
};

// ---------------------------------------------------------------------------
// Allowed folders
// ---------------------------------------------------------------------------

/** \\?\…, \\.\… and \??\…: device and raw namespace paths, never a folder an agent may use. */
const DEVICE_PATH = /^(?:[\\/]{2}[?.](?:[\\/]|$)|\\\?\?\\)/;
const MAX_LINK_HOPS = 32;
const PATH_MAX = 1024;

function isDevicePath(p: string): boolean {
  return DEVICE_PATH.test(p);
}

/**
 * On Windows, the share a UNC path is on, as "\\server\share" in lower case; '' for a UNC path
 * without a share; null for any other path (and always on other systems).
 */
function uncShare(p: string): string | null {
  if (!WIN || !/^[\\/]{2}/.test(p) || isDevicePath(p)) return null;
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
  return m ? `\\\\${m[1]}\\${m[2]}`.toLowerCase() : '';
}

/** `child` is `parent` or inside it (case-insensitive on Windows). */
function within(child: string, parent: string): boolean {
  const key = (p: string) => (WIN ? p.toLowerCase() : p);
  const c = key(child);
  let p = key(parent);
  if (c === p) return true;
  if (!p.endsWith(path.sep)) p += path.sep;
  return c.startsWith(p);
}

/** A folder as typed, made absolute and normalised (".." resolved), or null when it is no plain folder path. */
function folderPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p || p.length > PATH_MAX || /[\p{Cc}]/u.test(p) || isDevicePath(p)) return null;
  if (WIN) {
    // A drive letter or a share: never "\folder" or "C:folder", which depend on the current drive or folder.
    const share = uncShare(p);
    if (share === '' || (share === null && !/^[A-Za-z]:[\\/]/.test(p))) return null;
  } else if (!path.isAbsolute(p)) {
    return null;
  }
  const resolved = path.resolve(p);
  if (WIN) {
    // No alternate data streams ("folder:stream") and no device names along the way ("C:\x\CON").
    const rest = resolved.slice(path.parse(resolved).root.length);
    if (rest.includes(':') || rest.split(path.sep).some((part) => DEVICE_NAME.test(part))) return null;
  }
  return resolved;
}

function splitPath(p: string): { root: string; rest: string[] } {
  const root = path.parse(p).root;
  return { root, rest: p.slice(root.length).split(path.sep).filter(Boolean) };
}

/**
 * Follow the links along `start` one part at a time without opening their targets first, and
 * refuse a link that leads to a device path or to a network share not in `shares`: merely looking
 * at a folder on someone's share makes Windows offer them this person's sign-in.
 */
async function linksStayHere(start: string, shares: ReadonlySet<string>): Promise<boolean> {
  let { root, rest } = splitPath(start);
  let current = root;
  let hops = 0;
  while (rest.length) {
    const next = path.join(current, rest.shift()!);
    let st: Stats;
    try {
      st = await fsp.lstat(next);
    } catch {
      return false;
    }
    if (!st.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return false;
    let target: string;
    try {
      target = await fsp.readlink(next);
    } catch {
      return false;
    }
    const abs = path.resolve(current, target);
    if (isDevicePath(abs)) return false;
    const share = uncShare(abs);
    if (share !== null && !shares.has(share)) return false;
    const more = splitPath(abs);
    current = more.root;
    rest = [...more.rest, ...rest];
  }
  return true;
}

function realpathNative(p: string): Promise<string> {
  return new Promise((resolve, reject) => fs.realpath.native(p, (err, out) => (err ? reject(err) : resolve(out))));
}

/** The existing folder `p` with every link resolved, or null. */
async function resolveFolder(p: string, shares: ReadonlySet<string>): Promise<string | null> {
  if (!(await linksStayHere(p, shares))) return null;
  let real: string;
  try {
    // The system's own answer (Windows: true case, short names expanded); the plain one where it fails.
    real = await realpathNative(p);
  } catch {
    try {
      real = await fsp.realpath(p);
    } catch {
      return null;
    }
  }
  if (isDevicePath(real) || uncShare(real) === '') return null;
  try {
    return (await fsp.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export const allowedFolder: AllowedFolder = async (allowed, folder) => {
  try {
    const want = folderPath(folder);
    if (!want) return null;
    const entries = (Array.isArray(allowed) ? allowed : []).map(folderPath).filter((p): p is string => !!p);
    if (!entries.length) return null;
    // Network shares an allowed folder names itself: the only ones ever looked at.
    const shares = new Set(entries.map(uncShare).filter((s): s is string => !!s));
    const wantShare = uncShare(want);
    if (wantShare !== null && !shares.has(wantShare)) return null;
    const real = await resolveFolder(want, shares);
    if (!real) return null;
    const realShare = uncShare(real);
    for (const entry of entries) {
      // An allowed share is looked at only when the folder is on it.
      const entryShare = uncShare(entry);
      if (entryShare !== null && entryShare !== realShare) continue;
      const base = await resolveFolder(entry, shares);
      if (base && within(real, base)) return real;
    }
    return null;
  } catch {
    return null;
  }
};
