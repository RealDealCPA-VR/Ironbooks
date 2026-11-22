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
 * A root inside the company's database folder is refused (fail closed), and so is one that holds
 * the database folder, the working folder, the folder of every working folder, the company file or
 * Ironbooks' own local folder; and one on a share or a device path, by its words or as the disk has
 * it (a link to a share, a mapped drive). Each is judged by the words and, where the folder exists,
 * as the disk has it (links and short names resolved), and a near match (another case, another
 * Unicode form) counts: a refusal errs on the side of refusing.
 * Every folder this module makes (the root, each company's and each agent's) carries a marker file
 * (MARKER). Clearing only ever looks in, and removes, a folder that carries it: never one that
 * merely has a name like an id. A root that already holds other things is never taken over.
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
 *  - One lock, the root's gate, is taken by every write (shared: agents write side by side) and by
 *    every clear (alone). A clear waits for the writes already going and the writes asked for after
 *    it wait for the clear, so it never removes a folder a write is using, and never a file staged
 *    after it began. Writes for one agent also happen one at a time (its own lock), so parts are
 *    appended in turn and the limits hold.
 *  - Nothing here logs, and no error passes on a path or a file's content: a disk failure becomes
 *    one plain message (diskTrouble).
 *  - Files and unfinished uploads go after STAGED_FILE_HOURS (clearStagedFiles, also run lazily at
 *    most once an hour by every call here that takes a file id or adds a file), and all of them
 *    when the company file closes.
 *
 * allowedFolder is the check behind save_file and the shell's paths: is this folder inside one the
 * Admin allowed for the agent, once links and ".." are resolved, compared exactly as the disk spells
 * the names. A whole drive or share is never an agent's folder, and neither is a share on this very
 * computer (isThisComputerShare: \\localhost\c$, \\127.1\…, its own name), through which the app's
 * own folders are there under another name. overlapsAppData is the check other units use before
 * they let a folder be an agent's at all.
 */
import { randomBytes } from 'node:crypto';
import fs, { type Dirent, type Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServiceError } from '@/lib/services/errors';
import { endpointDir } from './endpointFile';
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
 * The file that marks a folder as this module's own (the root, and each company's and agent's
 * folder in it). Its name is never a company or agent id, so a clear never takes it for one.
 */
const MARKER = '.ironbooks-agent-files';
const MARKER_TEXT = 'Ironbooks keeps files for its agents in this folder, each for a day at most. It is safe to delete while Ironbooks is closed.\n';

const HOUR_MS = 60 * 60 * 1000;
const STAGED_MS = STAGED_FILE_HOURS * HOUR_MS;
/** Unfinished uploads one agent may have at once. */
const UPLOADS_PER_AGENT = 5;
/** Most one agent may keep here at once, staged files and unfinished uploads together (500 MB). */
export const AGENT_MAX_BYTES = 10 * UPLOAD_MAX_BYTES;
/** Most files one agent may keep here at once; also keeps the look through its folder short. */
export const AGENT_MAX_FILES = 1000;
/** Longest name kept for a staged file, in characters, extension and any "_" in front included. */
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

/** A root's gate: writes share it, a clear has it alone; first come, first served. */
interface Gate {
  readers: number;
  writer: boolean;
  queue: Array<{ alone: boolean; go: () => void }>;
}

// Process-wide, like the open databases (Next.js loads a module once per route bundle in dev).
interface FilesState {
  clearedAt: number;
  locks: Map<string, Promise<void>>;
  /** Missing in a state an older copy of this module made (a reload in development). */
  gates?: Map<string, Gate>;
}
const g = globalThis as typeof globalThis & { __bkaAgentFiles?: FilesState };
const state: FilesState = (g.__bkaAgentFiles ??= { clearedAt: 0, locks: new Map() });
const gates: Map<string, Gate> = (state.gates ??= new Map());

// ---------------------------------------------------------------------------
// Comparing paths
// ---------------------------------------------------------------------------

/**
 * A name as Windows compares names (electron/agentShell.js windowsFold): each character in upper
 * case when that is still one character, as NTFS does, character by character. Not lower case:
 * "K" (the Kelvin sign) lowers to "k" but is a name of its own on the disk.
 */
function windowsFold(s: string): string {
  let out = '';
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += Array.from(up).length === 1 ? up : ch;
  }
  return out;
}

/** `child` is `parent` or inside it, both spelled the same way. */
function withinAsWritten(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * For a refusal only: `child` may be `parent` or inside it, as written, as Windows folds case, or
 * without case and Unicode form at all (macOS folds both). A near match counts, so a refusal never
 * misses a place over a spelling. Never used to allow anything.
 */
function mayBeWithin(child: string, parent: string): boolean {
  const loose = (p: string) => p.normalize('NFC').toLowerCase();
  return withinAsWritten(child, parent) || withinAsWritten(windowsFold(child), windowsFold(parent)) || withinAsWritten(loose(child), loose(parent));
}

/** For a refusal only: one of the two may be, hold or lie inside the other. */
function mayOverlap(a: string, b: string): boolean {
  return mayBeWithin(a, b) || mayBeWithin(b, a);
}

/**
 * To allow: `child` is `parent` or inside it, both real paths from the disk (realpath spells every
 * name as the disk does), compared exactly: a sibling "IronbooKs" (with the Kelvin sign) is not
 * "Ironbooks". Only the drive or share in front is compared the way Windows compares names
 * (per character in upper case), since the system answers it as typed.
 */
function realWithin(child: string, parent: string): boolean {
  const split = (p: string) => {
    const root = path.parse(p).root;
    return { root: WIN ? windowsFold(root) : root, rest: p.slice(root.length).replace(/[\\/]+$/, '') };
  };
  const c = split(child);
  const p = split(parent);
  if (c.root !== p.root) return false;
  if (!p.rest) return true;
  return c.rest === p.rest || c.rest.startsWith(p.rest + path.sep);
}

function errCode(err: unknown): string {
  return String((err as { code?: unknown } | null)?.code ?? '');
}

/**
 * `p` as the disk has it: the real path of its nearest part that exists (every link followed,
 * every name spelled as the disk spells it, short names expanded), with the parts below it that do
 * not exist yet as written. Null when the disk will not say. A share or device path is never looked
 * at here: merely looking makes Windows offer the person's sign-in to that computer.
 */
function onDiskSync(p: string): string | null {
  if (isDevicePath(p) || uncShare(p) !== null) return null;
  const below: string[] = [];
  let current = p;
  for (let i = 0; i < 512; i++) {
    try {
      fs.lstatSync(current);
    } catch (err) {
      // Only "not there" lets the look go up a level; anything else (no access) is unknown.
      if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      below.push(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.join(fs.realpathSync.native(current), ...below.reverse());
    } catch {
      return null;
    }
  }
  return null;
}

/** A place as written (made absolute) and, where the disk says, as it really is. */
function placeForms(p: string): string[] {
  const written = path.resolve(p);
  const real = onDiskSync(written);
  return real && real !== written ? [written, real] : [written];
}

// ---------------------------------------------------------------------------
// Where the files are
// ---------------------------------------------------------------------------

/** lib/db/index.ts resolveDataDir, without loading the database layer here. */
function companyDataDir(): string {
  if (process.env.BKA_DATA_DIR) return path.resolve(process.env.BKA_DATA_DIR);
  return path.resolve(process.cwd(), '.bookkeeper-data', 'default');
}

/** The open company file's working folder (the folder of BKA_COMPANY_STATE), or null. */
function workingFolder(): string | null {
  const stateFile = process.env.BKA_COMPANY_STATE?.trim();
  return stateFile ? path.dirname(path.resolve(stateFile)) : null;
}

function companyFile(): string | null {
  const file = process.env.BKA_COMPANY_FILE?.trim();
  return file ? path.resolve(file) : null;
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

function keptElsewhere(): ServiceError {
  return new ServiceError('INTERNAL', 'Ironbooks is set up to keep agent files on another computer, which it never does. Ask a person to check how Ironbooks was started.');
}

/** The folder all staged files live under (see the module comment). Throws when it is refused. */
function stagingRoot(): string {
  const workDir = workingFolder();
  const root = overrideRoot() ?? (workDir ? path.join(workDir, FOLDER_NAME) : appDataRoot());
  // Staged files stay on this computer: never on a network share or a device path. Said by the
  // words first, before the disk is looked at (looking at a share offers it the person's sign-in).
  if (isDevicePath(root) || uncShare(root) !== null) throw keptElsewhere();
  const roots = placeForms(root);
  // Then as the disk has it: a local-looking folder may be a link to a share, or on a mapped drive
  // (the system answers both as \\server\share\…).
  if (roots.some((r) => isDevicePath(r) || uncShare(r) !== null)) throw keptElsewhere();
  // Never inside the database folder, and never a folder that holds the books (the database
  // folder, the open file's working folder and the folder of them all, the company file) or
  // Ironbooks' own local folder: they keep things of their own, empty folders included.
  const dataDir = companyDataDir();
  const held = [dataDir, workDir, workDir ? path.dirname(workDir) : null, companyFile(), path.dirname(appDataRoot())].filter((p): p is string => !!p);
  const inside = placeForms(dataDir).some((d) => roots.some((r) => mayBeWithin(r, d)));
  if (inside || held.some((h) => placeForms(h).some((hf) => roots.some((r) => mayBeWithin(hf, r))))) {
    throw new ServiceError(
      'INTERNAL',
      "Ironbooks is set up to keep agent files inside the company's data, or in a folder that holds the company file or Ironbooks' own folders, which it never does. Ask a person to check how Ironbooks was started.",
    );
  }
  return root;
}

/**
 * Where staged files are kept on this computer (the folder may not exist yet), or null when the
 * setup is refused and nothing is kept at all. Nothing is made here. For the folder rules of other
 * units: a folder an agent may use must never hold this one or lie inside it, or the agent's own
 * file access would reach other agents' staged files (overlapsAppData says so for every such place).
 */
export function stagedFilesRoot(): string | null {
  try {
    return stagingRoot();
  } catch {
    return null;
  }
}

/**
 * The names the desktop app's settings folder has had (electron/main.js useLegacyUserDataIfPresent):
 * the product name, the package name a development run uses, and the two from before the rename.
 * lib/services/agentPolicies.ts and mcp/files-tools.mjs list the same four.
 */
const SETTINGS_FOLDER_NAMES = ['Ironbooks', 'ironbooks', 'BookKeeper AI', 'bookkeeper-ai'];

/** A path the server was started with (an environment value), made absolute; null when not set. */
function envPlace(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? path.resolve(v) : null;
}

/**
 * Every place on this computer where agents' staged files or Ironbooks' own data may be, as far as
 * this server can tell. The folders may not exist. Nothing is made or looked at here.
 *  - each staging root this module may use (the open file's, this computer's app data one, the
 *    test override), and Ironbooks' own local folder that holds the app data one (on Windows
 *    %LOCALAPPDATA%\Ironbooks: the working copies of company files in plain form, sandboxes, the
 *    agent connection files);
 *  - the folder of every company file's working folder (each keeps its own staged files);
 *  - the open company's database folder, working folder and company file, the backups beside the
 *    database folder (backups, pre-op-backups, archives: whole copies of the books) and the
 *    archives beside the company file; while a sandbox is open, the real company's as well;
 *  - the desktop app's settings folder under every name it has had (Windows %APPDATA%\Ironbooks:
 *    config.json, the sealed device secret, the TLS keys, the quit-time backups, the companies\
 *    folders of company-folder mode), or the one IRONBOOKS_USER_DATA names; ~/.ironbooks, where
 *    working copies go when the shell names no settings folder;
 *  - the folders the shell named for backups and sandboxes (BKA_BACKUP_DIR, BKA_SANDBOX_ROOT), and
 *    the agent connection files' folder (lib/agent/endpointFile.ts endpointDir, overridden or not).
 * Backup folders a person chose are the folder rules' own concern (lib/services/agentPolicies.ts
 * reads them with the books' settings).
 */
export function appDataPlaces(): string[] {
  const env = process.env;
  const home = os.homedir();
  const out: Array<string | null> = [appDataRoot(), path.dirname(appDataRoot())];
  out.push(overrideRoot());
  const workDir = workingFolder();
  if (workDir) out.push(path.join(workDir, FOLDER_NAME), workDir, path.dirname(workDir));
  // The books, and the copies of them Ironbooks writes beside them (lib/services/backupHistory.ts
  // defaultBackupFolder and preOpFolder, lib/services/condense.ts condenseArchiveDir).
  for (const dataDir of [companyDataDir(), envPlace('BKA_SANDBOX_REAL_DIR')]) {
    if (!dataDir) continue;
    out.push(dataDir, ...['backups', 'pre-op-backups', 'archives'].map((n) => path.join(path.dirname(dataDir), n)));
  }
  for (const file of [companyFile(), envPlace('BKA_REAL_COMPANY_FILE')]) {
    if (file) out.push(file, path.join(path.dirname(file), 'archives'));
  }
  // The desktop app's settings folder (electron/main.js userData), as Electron names it
  // (app.getPath('appData') joined with the app's name), and the one the shell may be told to use.
  const settingsParent = WIN
    ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || path.join(home, '.config');
  for (const name of SETTINGS_FOLDER_NAMES) out.push(path.join(settingsParent, name));
  out.push(envPlace('IRONBOOKS_USER_DATA'), path.join(home, '.ironbooks'));
  out.push(envPlace('BKA_BACKUP_DIR'), envPlace('BKA_SANDBOX_ROOT'));
  try {
    out.push(endpointDir());
  } catch {
    /* the usual place is in Ironbooks' own local folder, listed above */
  }
  return [...new Set(out.filter((p): p is string => !!p).map((p) => path.resolve(p)))];
}

/**
 * Whether `folder` is, lies inside, or holds one of appDataPlaces: then it is never a folder an
 * agent may use, or its file access would reach the books, Ironbooks' own state or other agents'
 * staged files. Judged by the words and, where the folders exist, as the disk has them (links and
 * short names resolved); a near match (another case, another Unicode form) counts. True as well when
 * `folder` is no full path, or a device path, or a share on this very computer (isThisComputerShare:
 * the app's own folders are there under another name), by its words or as the disk has it (a mapped
 * drive): fail closed. A share is judged by the words alone and never looked at.
 */
export function overlapsAppData(folder: string): boolean {
  if (typeof folder !== 'string') return true;
  const typed = folder.trim();
  if (!typed || typed.length > PATH_MAX || /[\p{Cc}]/u.test(typed) || isDevicePath(typed) || !path.isAbsolute(typed)) return true;
  if (isThisComputerShare(typed)) return true;
  try {
    const mine = placeForms(typed);
    if (mine.some(isThisComputerShare)) return true;
    return appDataPlaces().some((place) => placeForms(place).some((p) => mine.some((m) => mayOverlap(m, p))));
  } catch {
    return true;
  }
}

/** The company and agent ids as folder names, or null when the owner is not a plain pair of ids. */
function ownerSegments(owner: FileOwner): [string, string] | null {
  const segment = (id: unknown) => (typeof id === 'string' && SEGMENT_RE.test(id) ? id.toLowerCase() : null);
  const company = segment(owner?.companyId);
  const agent = segment(owner?.agentId);
  return company && agent ? [company, agent] : null;
}

/** The owner's own folder, or null when the owner is not a plain company and agent id or nothing is kept. */
function ownerDirOrNull(owner: FileOwner): string | null {
  const ids = ownerSegments(owner);
  if (!ids) return null;
  try {
    return path.join(stagingRoot(), ...ids);
  } catch {
    return null;
  }
}

function notForAnAgent(): ServiceError {
  return new ServiceError('FORBIDDEN', 'Ironbooks could not tell which agent this file is for, so it was not kept.');
}

function ownerDir(owner: FileOwner): string {
  const ids = ownerSegments(owner);
  if (!ids) throw notForAnAgent();
  return path.join(stagingRoot(), ...ids);
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
 * of a path only, no control or direction-mark characters and no half of a character pair, nothing
 * Windows refuses, no device name, no trailing dot or space, at most NAME_MAX characters with the
 * extension kept and the "_" a device name gets in front counted.
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
    `This agent already keeps as much here as one agent may at once (${AGENT_MAX_BYTES / MB} MB, or ${AGENT_MAX_FILES} files). ` +
      'Work with the files it already has and wait for older ones to be cleared (each goes a day after it was made), or ask a person for help.',
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

function newId(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

function lockKey(key: string): string {
  return WIN ? windowsFold(key) : key;
}

/**
 * The root's gate, the one lock every write and every clear takes: writes share it (`alone`
 * false), a clear has it alone. First come, first served: a write asked for after a clear waits
 * for that clear, and a clear waits for the writes already going. Not re-entrant: a clear is never
 * started while the gate is held.
 */
async function withGate<T>(root: string, alone: boolean, fn: () => Promise<T>): Promise<T> {
  const k = lockKey(root);
  let gate = gates.get(k);
  if (!gate) gates.set(k, (gate = { readers: 0, writer: false, queue: [] }));
  const gt = gate;
  // Joins the queue at once (in the caller's own turn), so the order of asking is the order served.
  await new Promise<void>((go) => {
    gt.queue.push({ alone, go });
    letIn(gt);
  });
  try {
    return await fn();
  } finally {
    if (alone) gt.writer = false;
    else gt.readers--;
    letIn(gt);
    if (!gt.writer && !gt.readers && !gt.queue.length && gates.get(k) === gt) gates.delete(k);
  }
}

function letIn(gt: Gate): void {
  while (gt.queue.length && !gt.writer) {
    const next = gt.queue[0];
    if (next.alone && gt.readers) return;
    gt.queue.shift();
    if (next.alone) gt.writer = true;
    else gt.readers++;
    next.go();
  }
}

/**
 * One at a time per key: an agent's writes (its folder), and the marking of a new root. Taken
 * inside the gate, never around it. Not re-entrant: never take the same key twice.
 */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = lockKey(key);
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

/** A write for the owner folder `dir`: in the root's gate (shared), then under the owner's lock. */
function asWrite<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withGate(rootOf(dir), false, () => withLock(dir, () => onDisk(fn)));
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

/** The root an owner folder (`<root>/<companyId>/<agentId>`) is in. */
function rootOf(dir: string): string {
  return path.dirname(path.dirname(dir));
}

/** The folder carries the marker: this module made it, or took it over while it was empty. */
async function marked(dir: string): Promise<boolean> {
  try {
    return (await fsp.lstat(path.join(dir, MARKER))).isFile();
  } catch {
    return false;
  }
}

async function mark(dir: string): Promise<void> {
  try {
    await fsp.writeFile(path.join(dir, MARKER), MARKER_TEXT, { flag: 'wx', mode: FILE_MODE });
  } catch (err) {
    if (errCode(err) !== 'EEXIST') throw err;
  }
}

/** Make the root when it is missing, and mark it. A folder that already holds other things is refused. */
async function claimRoot(root: string): Promise<void> {
  if (await marked(root)) return;
  await fsp.mkdir(root, { recursive: true, mode: DIR_MODE });
  if ((await fsp.readdir(root)).length) throw notOurFolder();
  await mark(root);
}

/**
 * Make the owner's folder in a marked root, and mark it and its company's folder: a clear only
 * ever removes a marked folder. In the gate (so no clear runs meanwhile) and under the owner's
 * lock; marking a new root takes a lock of its own, as two agents may start at the same time.
 */
async function ownerReady(dir: string): Promise<void> {
  const root = rootOf(dir);
  await withLock(`${root}${path.sep}${MARKER}`, () => claimRoot(root));
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await mark(path.dirname(dir));
  await mark(dir);
}

/**
 * Write `final` so it appears whole or not at all: a temporary file next to it, renamed into place.
 * The folder is made again when it went meanwhile (a person removed it). A write (asWrite).
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

/** What a .json says, its name and type cleaned again (a hand-edited one cannot pass on another). */
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
      return { name: cleanName(m.name), type: cleanType(m.type), size: m.size, created: m.created };
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
 * Clear old files now and then (at most once an hour), from the calls here that take a file id or
 * add a file, so files of a crash are not kept long by a busy agent. Never fails the call. Called
 * outside the gate (a clear takes it alone).
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
 * A write (asWrite), after checkRoom.
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
  return asWrite(dir, async () => {
    await checkRoom(dir, { bytes: bytes.byteLength, file: true, upload: false });
    return writeStaged(dir, name, type, bytes);
  });
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
  if (!ownerSegments(owner)) throw notForAnAgent();
  if (!part || typeof part !== 'object') throw new ServiceError('VALIDATION', 'Send the upload part with its name, type, chunkBase64 and last.');
  const given = part.uploadId === undefined || part.uploadId === null || part.uploadId === '' ? null : part.uploadId;
  // A malformed id is refused like an unknown one, and a malformed part too, before the disk is looked at.
  if (given !== null && !validId(given)) throw unknownUpload();
  const bytes = decodeChunk(part.chunkBase64);
  const last = part.last === true;
  const dir = ownerDir(owner);
  await clearNowAndThen();

  return asWrite(dir, async () => {
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
  });
};

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

/** Sub-folders this module made: named like a company or agent id, and marked. Links are never followed. */
async function ourFolders(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SEGMENT_RE.test(e.name)) continue;
    const sub = path.join(dir, e.name);
    if (await marked(sub)) out.push(sub);
  }
  return out;
}

/**
 * A folder this module made goes when nothing but its marker is left. The marker comes back when
 * the folder stays after all (something else was put in it meanwhile).
 */
async function removeIfOnlyMarker(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  if (names.length !== 1 || names[0] !== MARKER || !(await marked(dir))) return;
  const marker = path.join(dir, MARKER);
  try {
    await fsp.rm(marker, { force: true });
  } catch {
    return;
  }
  try {
    await fsp.rmdir(dir);
  } catch {
    await fsp.writeFile(marker, MARKER_TEXT, { flag: 'wx', mode: FILE_MODE }).catch(() => undefined);
  }
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

export const clearStagedFiles: ClearStagedFiles = async (opts) => {
  const all = opts?.all === true;
  const root = stagingRoot();
  // Alone in the gate, asked for in this same turn: the writes already going finish first, and
  // the ones asked for after this wait for it, so it never takes a file staged after it began.
  return withGate(root, true, async () => {
    // Only a root this module made is ever cleared: a folder without the marker may be anyone's,
    // and its empty folders may matter to them. The same holds for every folder in it.
    if (!(await marked(root))) return 0;
    const cutoff = Date.now() - STAGED_MS;
    let removed = 0;
    for (const company of await ourFolders(root)) {
      for (const agent of await ourFolders(company)) {
        removed += await clearOwner(agent, all, cutoff);
        await removeIfOnlyMarker(agent);
      }
      await removeIfOnlyMarker(company);
    }
    // An empty root goes too: the working folder of a company file is pruned only when it holds
    // nothing but its cache (electron/companySession.js pruneWorkingCopies).
    await removeIfOnlyMarker(root);
    return removed;
  });
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
 * On Windows, the share a UNC path is on, as "\\SERVER\SHARE" folded the way Windows compares
 * names (windowsFold: a server named with a Kelvin sign is another server); '' for a UNC path
 * without a share; null for any other path (and always on other systems).
 */
function uncShare(p: string): string | null {
  if (!WIN || !/^[\\/]{2}/.test(p) || isDevicePath(p)) return null;
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
  return m ? windowsFold(`\\\\${m[1]}\\${m[2]}`) : '';
}

/** The server a UNC path names ("\\SERVER\share\…" gives "SERVER"), as written; null for any other path, and always on other systems. */
function uncServer(p: string): string | null {
  if (!WIN || isDevicePath(p)) return null;
  const m = /^[\\/]{2}([^\\/]*)/.exec(p);
  return m ? m[1] : null;
}

/**
 * A server name as the name service may take it, for a refusal only: compatibility forms folded
 * (a full-width "ｌｏｃａｌｈｏｓｔ" is "localhost" once the system maps it, as IDNA does), the other
 * full stops a name may be written with as ".", lower case.
 */
function looseHost(s: string): string {
  return s.normalize('NFKC').replace(/[\u3002\uff0e\uff61]/g, '.').toLowerCase();
}

/**
 * An IPv4 address in any spelling the system takes ("127.0.0.1", "127.1", "0x7f.1", "0177.0.0.1",
 * "2130706433": one to four parts, each decimal, octal or hex, the last filling the bytes left), as
 * its 32-bit number; null for anything else.
 */
function ipv4Number(s: string): number | null {
  const parts = s.split('.');
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) n = part.length === 1 ? 0 : parseInt(part.slice(1), 8);
    else if (/^[1-9][0-9]*$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  const room = 2 ** (8 * (4 - nums.length));
  if (last >= room) return null;
  return nums.reduce((v, n) => v * 256 + n, 0) * room + last;
}

/**
 * An IPv6 address as its eight 16-bit groups: "::1", "[::1]", "0:0:0:0:0:0:0:1", with a zone
 * ("%4") or an IPv4 tail ("::ffff:127.0.0.1"), and Windows' own UNC spelling of one
 * ("0--1.ipv6-literal.net", "-" for ":" and "s" for "%"). Null for anything else.
 */
function ipv6Groups(s: string): number[] | null {
  let h = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  const literal = /^(.+)\.ipv6-literal\.net$/.exec(h);
  if (literal) h = literal[1].replace(/-/g, ':').replace(/s/g, '%');
  h = h.replace(/%.*$/, '');
  if (!h.includes(':')) return null;
  const tail = /^(.*:)([^:]*\.[^:]*)$/.exec(h);
  if (tail) {
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(tail[2]) ? ipv4Number(tail[2].replace(/(^|\.)0+(?=\d)/g, '$1')) : null;
    if (v4 === null) return null;
    h = `${tail[1]}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array<string>(missing).fill('0'), ...rest].map((g) => parseInt(g, 16));
}

/**
 * An address in one spelling for comparing ("v4:2130706433", "v6:0:0:0:0:0:0:0:1"), or null for a
 * name. An IPv4 address carried in IPv6 (::ffff:127.0.0.1, ::127.0.0.1) is the IPv4 one.
 */
function addressKey(host: string): string | null {
  const v4 = ipv4Number(host);
  if (v4 !== null) return `v4:${v4}`;
  const g = ipv6Groups(host);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && g[6] !== 0))) return `v4:${g[6] * 65536 + g[7]}`;
  return `v6:${g.join(':')}`;
}

/** This computer itself: 127.0.0.0/8, 0.0.0.0/8 (the system connects 0.0.0.0 here), ::1 and ::. */
function isLoopbackKey(key: string): boolean {
  if (key.startsWith('v4:')) {
    const first = Math.floor(Number(key.slice(3)) / 2 ** 24);
    return first === 127 || first === 0;
  }
  return key === 'v6:0:0:0:0:0:0:0:1' || key === 'v6:0:0:0:0:0:0:0:0';
}

/** This computer's own addresses (every network card's), as addressKey spells them. Nothing is sent. */
function ownAddressKeys(): Set<string> {
  const out = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        const key = addressKey(looseHost(a.address));
        if (key) out.add(key);
      }
    }
  } catch {
    /* none known: names and loopback still count */
  }
  return out;
}

/** This computer's own names (its host name and its Windows computer name), first label only, as looseHost spells them. */
function ownNames(): string[] {
  const names: Array<string | undefined> = [process.env.COMPUTERNAME];
  try {
    names.push(os.hostname());
  } catch {
    /* the computer name from the environment still counts */
  }
  return names.map((n) => looseHost(n?.trim() ?? '').split('.')[0]).filter((n) => !!n);
}

/**
 * On Windows, a UNC path whose server is this very computer: "localhost" and every name under
 * ".localhost" (WSL's "wsl.localhost" too), "wsl$" (WSL reaches this computer's drives under
 * /mnt), a loopback address in any spelling (127.1, 0x7f000001, ::1, [::1],
 * 0--1.ipv6-literal.net), one of this computer's own addresses, or its own name (with any domain
 * after it, a near match counting). Through such a share the app's own folders, the books and other
 * agents' staged files are there under another name, so it is never an agent's folder (the hosting
 * rule is the same: a join to this same computer is refused for agents). Judged by the words alone:
 * nothing is looked up and nothing is looked at. A server that is not named in the words (a name in
 * the hosts file that leads here) is not caught. False for every path that is no UNC path.
 */
export function isThisComputerShare(folder: string): boolean {
  if (typeof folder !== 'string') return false;
  const raw = uncServer(folder.trim());
  if (raw === null) return false;
  // "server@SSL@443" (a WebDAV share) is on that same server; a trailing dot is the same name.
  const host = looseHost(raw.split('@')[0]).replace(/\.+$/, '');
  // No server at all is no share anyone can name: refused as well.
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'wsl$') return true;
  const key = addressKey(host);
  if (key) return isLoopbackKey(key) || ownAddressKeys().has(key);
  return ownNames().includes(host.split('.')[0]);
}

/** A whole drive ("C:\", "/") or a share's own folder ("\\server\share"), by the words alone. */
function isRootByWords(p: string): boolean {
  const trim = (s: string) => s.replace(/[\\/]+$/, '');
  if (trim(p) === trim(path.parse(p).root)) return true;
  return WIN && /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]*$/.test(p);
}

/**
 * A whole drive, a share, or another volume mounted as a folder (/Volumes/USB, a disk mounted into
 * a folder: it is on another device than the folder it sits in). `real` is a real path. True as
 * well when the disk will not say (fail closed).
 */
async function isVolumeRoot(real: string): Promise<boolean> {
  if (isRootByWords(real)) return true;
  try {
    const [here, parent] = await Promise.all([fsp.stat(real), fsp.stat(path.dirname(real))]);
    return Boolean(here.dev && parent.dev && here.dev !== parent.dev);
  } catch {
    return true;
  }
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
    // The system's own answer (Windows: true case, short names expanded); the plain one where it
    // fails, whose spelling may differ from the disk's and then only ever refuses more.
    real = await realpathNative(p);
  } catch {
    try {
      real = await fsp.realpath(p);
    } catch {
      return null;
    }
  }
  // As the disk has it, a folder may be on a share of this very computer (a drive mapped to
  // \\localhost\c$): refused like one typed that way, before that share is looked at.
  if (isDevicePath(real) || uncShare(real) === '' || isThisComputerShare(real)) return null;
  try {
    return (await fsp.stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export const allowedFolder: AllowedFolder = async (allowed, folder) => {
  try {
    const want = folderPath(folder);
    // A share on this very computer is never an agent's folder, nor allows one (isThisComputerShare):
    // by the words, so it is never looked at, and so never in `shares` below, which keeps a link
    // that leads to it out too.
    if (!want || isThisComputerShare(want)) return null;
    const entries = (Array.isArray(allowed) ? allowed : [])
      .map(folderPath)
      .filter((p): p is string => !!p && !isThisComputerShare(p));
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
      // A whole drive or share is never an agent's folder: a company file at E:\ does not make
      // all of E: one. Said by the words first, then as the disk has it (a mounted volume).
      if (isRootByWords(entry)) continue;
      const base = await resolveFolder(entry, shares);
      if (!base || (await isVolumeRoot(base))) continue;
      if (realWithin(real, base)) return real;
    }
    return null;
  } catch {
    return null;
  }
};
