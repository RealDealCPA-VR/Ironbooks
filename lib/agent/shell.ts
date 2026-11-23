/**
 * Agent full access: the server's side of the shell bridge (plan §5.5): hands an approved shell
 * operation to the desktop shell (electron/agentShell.js), or carries out a 'server' one itself.
 *
 * The desktop shell tells its company server, in the environment, where its private endpoint is
 * (BKA_AGENT_SHELL: a named pipe on Windows, a Unix socket elsewhere) and this launch's key for
 * approval tickets (BKA_AGENT_SHELL_KEY). A plain server (the browser version, a test) has neither:
 * shellAvailable() is false and every 'electron' operation answers that it needs the desktop app.
 *
 * runShellOperation, for an 'electron' operation:
 *  1. only for a person's approval: a context with an agent on it, or with no person, is refused;
 *     each path the operation takes must be in a folder agents may use as things are now, by the
 *     rule files.save uses (pathOutsideFolders): the approval may come long after the ask;
 *  2. makes the approval ticket (lib/agent/shellTicket.ts) over the request id, the operation, the
 *     input and the approver, good for SHELL_TICKET_SECONDS, its MAC also covering the answers,
 *     the folders, the file and which secrets come with it;
 *  3. sends one JSON line { ticket, operation, input, answers, folders, sealed? }: the approver's
 *     answers and secrets are for this one run and are never kept or logged; `folders` are the
 *     ones the Admin allowed for the agent (the shell adds its defaults); `sealed` carries the
 *     secrets and, for a print request, the PDF read from the agent's own staged files, sealed for
 *     this ticket so nothing between here and the shell can read or swap them;
 *  4. waits for the one-line answer { ok, result, error, restarting, mac } with a time limit, takes
 *     it only when its MAC checks out for this ticket, and maps anything else (no shell, no answer,
 *     a garbled or unchecked one) to a plain message.
 * The shell checks everything again on its side (ticket, replay, input, folders) before it runs.
 *
 * Folders: the company file's folder counts only when it is not the top of a drive or share (a USB
 * stick's E:\, a mapped Q:\, \\server\share, a mounted volume's /Volumes/USB) nor reached through a
 * share of this very computer (\\localhost\c$\…): then only Documents\Ironbooks and its Agent Outbox
 * apply. A folder the Admin added that is such a place, or leads to one, is never used either, nor
 * one that has come to hold the books or Ironbooks' own data since it was added (policyFolders).
 *
 * 'files.save' (runner 'server') is done here: one of the agent's staged files saved into a folder
 * agents may use, made new on the disk (an exclusive create: never over a file that is there, even
 * one that arrives a moment before), and a disk failure answers in plain words without any path.
 *
 * Printing an operation's PDF (plan §5.4, D10): installShellPrinting() registers the effects
 * outbox's print handler (lib/effects.ts setPrintHandler), which sends the job to the shell the
 * same way, as the operation "shell.print.file".
 */
import { randomUUID } from 'node:crypto';
import fs, { promises as fsp } from 'node:fs';
import net from 'node:net';
import { homeDir } from './homeDir';
import path from 'node:path';
import type { ServiceContext } from '@/lib/services/_base';
import { loadAgentPolicy } from '@/lib/services/agentPolicies';
import { setPrintHandler, type PrintHandler } from '@/lib/effects';
import { currentServiceScope } from '@/lib/serviceScope';
import type { ShellOperationDef } from './contract';
import { allowedFolder, holdsAppDataBesideTheBooks, isThisComputerShare, overlapsAppData, PERSON_ONLY_FILE_MESSAGE, readStagedFile, readStagedFileForSave } from './files';
import { runnableNameProblem } from './guards';
import { SHELL_OPERATIONS } from './operations/shell';
import { makeShellTicket, sealShellPrivate, shellAnswerChecks, shellFileRef, type ShellPrivate } from './shellTicket';

export interface ShellRunResult {
  ok: boolean;
  /** What the flow answered (paths, names); never a secret. */
  result: unknown;
  /** The app's own message when it did not work. */
  error: string | null;
  /** Ironbooks is restarting or changing company file: the agent must connect again. */
  restarting: boolean;
}

/** Where the desktop shell's endpoint is, and this launch's ticket key (electron/agentShell.js ENDPOINT_ENV, KEY_ENV). */
export const SHELL_ENDPOINT_ENV = 'BKA_AGENT_SHELL';
export const SHELL_KEY_ENV = 'BKA_AGENT_SHELL_KEY';
/**
 * Documents as the desktop shell knows it (electron/main.js, app.getPath('documents')): OneDrive
 * can move it out of the home folder, and the shell's folder check uses the shell's Documents.
 */
export const SHELL_DOCUMENTS_ENV = 'BKA_AGENT_DOCUMENTS';
/** The folder in Documents\Ironbooks agents may always use (electron/agentShell.js OUTBOX_NAME). */
export const AGENT_OUTBOX_NAME = 'Agent Outbox';

const KEY_RE = /^[0-9a-f]{64}$/;
/** Most bytes of the shell's answer: paths, names and messages only. */
const MAX_ANSWER_BYTES = 1024 * 1024;
/**
 * Most bytes of a PDF sent to be printed (electron/agentShell.js MAX_PRINT_BYTES): the hidden
 * print window loads it as a data: address, which Chromium caps at 2 MB.
 */
const MAX_PRINT_BYTES = 1_500_000;

/** How long to wait for the shell's answer. The flows that copy whole company files allow 30 minutes themselves. */
const DEFAULT_TIME_LIMIT_MS = 2 * 60_000;
const TIME_LIMIT_MS: Record<string, number> = {
  'shell.company.saveCopyAs': 35 * 60_000,
  'shell.portable.open': 35 * 60_000,
  'shell.accountantCopy.open': 35 * 60_000,
  'shell.backup.restoreAsNew': 35 * 60_000,
  'shell.print.file': 5 * 60_000,
};

// A request that does not work is final (plan §7.2): the way on is a new request from the agent.
const NO_SHELL =
  'This needs the Ironbooks desktop app on this computer, and it is not connected to this server. Do it in the Ironbooks window, or start Ironbooks and have the agent ask again.';
const NOT_ANSWERING =
  'The Ironbooks window is not answering. Check that Ironbooks is open on this computer, then have the agent ask again.';
const TOO_SLOW =
  'Ironbooks did not finish this in time. Look in the Ironbooks window to see whether it was done before asking again.';
const GARBLED = 'The Ironbooks window gave an answer that could not be read. Look in the window to see whether it was done.';
const UNCHECKED =
  'The answer from the Ironbooks window could not be checked, so Ironbooks does not take it as done. Look in the Ironbooks window to see whether it was done before the agent asks again.';

function fail(error: string, restarting = false): ShellRunResult {
  return { ok: false, result: null, error, restarting };
}

/** True when a desktop shell is listening (false in a plain server or a test). */
export function shellAvailable(): boolean {
  const endpoint = process.env[SHELL_ENDPOINT_ENV]?.trim();
  const key = process.env[SHELL_KEY_ENV]?.trim();
  return Boolean(endpoint && key && KEY_RE.test(key));
}

function shellKey(): string {
  return (process.env[SHELL_KEY_ENV] ?? '').trim();
}

/** Only a signed-in person approves, never an agent (plan 4.6, 11.1). Null when `ctx` is one. */
function approverProblem(ctx: ServiceContext | null | undefined): string | null {
  if (!ctx || ctx.agent || typeof ctx.userId !== 'string' || !ctx.userId) {
    return 'Only a person signed in to Ironbooks can approve this, in their own window.';
  }
  return null;
}

/** Replace every secret the approver typed wherever it appears in an answer. */
function scrub<T>(value: T, secrets: Record<string, string>): T {
  const list = Object.values(secrets ?? {}).filter((s): s is string => typeof s === 'string' && s.length >= 3);
  if (!list.length) return value;
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return list.reduce((s, secret) => s.split(secret).join('[hidden]'), v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return clean(value) as T;
}

/** Only text secrets, by kind, for this one run. */
function cleanSecrets(secrets: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets ?? {})) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

/**
 * On macOS and Linux, by the words: the top folder of a mounted volume, or a folder that holds
 * mounted volumes (/Volumes/<name>, /System/Volumes/Data, /media/<user>/<name>, /run/media/<user>/
 * <name>, /mnt/<name>), compared without regard to case (electron/agentShell.js posixVolumeTop: the
 * same rule, the same words).
 */
function posixVolumeTop(resolved: string): boolean {
  const parts = resolved.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (!parts.length) return true;
  if (parts[0] === 'volumes' || parts[0] === 'mnt') return parts.length <= 2;
  if (parts[0] === 'media') return parts.length <= 3;
  if (parts[0] === 'run' && parts[1] === 'media') return parts.length <= 4;
  if (parts[0] === 'system' && parts[1] === 'volumes') return parts.length <= 3;
  return false;
}

/**
 * `p` is the top of a drive or a share ("E:\", "\\server\share", "/"), or on macOS and Linux a
 * mounted volume's top folder (/Volumes/USB, /media/pat/USB, /mnt/c): never a folder agents may
 * use, which would hand them the whole drive, share or volume (electron/agentShell.js
 * driveOrShareRoot). By the words; lib/agent/files.ts allowedFolder also asks the disk.
 * `platform`: this computer's, unless a test says another.
 */
export function isDriveOrShareRoot(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof p !== 'string' || !p.trim()) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const resolved = P.resolve(p);
  if (resolved === P.parse(resolved).root) return true;
  return platform !== 'win32' && posixVolumeTop(resolved);
}

/** \\?\…, \\.\… and \??\…: device and raw namespace paths (lib/agent/files.ts DEVICE_PATH). */
const DEVICE_PATH = /^(?:[\\/]{2}[?.](?:[\\/]|$)|\\\?\?\\)/;

/**
 * The folders of `list` agents may use: never the top of a drive or share, as written or on the
 * disk, and never a share of this very computer (isThisComputerShare: \\localhost\c$\…). Refused by
 * the words before the disk is looked at: those, every device path (\\?\GLOBALROOT\Device\Mup\…
 * reaches any computer's shares, this one's too, and the rule judges no such path), and anything
 * that is not a full path. allowedFolder refuses each of them as well; here they are never looked at.
 */
function usableFolders(list: readonly string[]): string[] {
  return list.filter((f) => {
    const typed = typeof f === 'string' ? f.trim() : '';
    if (!typed || DEVICE_PATH.test(typed) || !path.isAbsolute(typed)) return false;
    if (isDriveOrShareRoot(f) || isThisComputerShare(f)) return false;
    try {
      // A folder that is a link to the top of a drive or share, or to a share of this computer, is
      // refused like those themselves.
      const real = fs.realpathSync.native(f);
      return !isDriveOrShareRoot(real) && !isThisComputerShare(real);
    } catch {
      return true; // not there (yet): allowedFolder refuses a folder that is not there
    }
  });
}

/**
 * The folders the Admin allowed for this agent that it may still use (none when the policy cannot
 * be read: the defaults still apply). Saving the list refused a folder that is, lies inside or
 * holds a place where Ironbooks keeps the books or its own data, but a folder can come to be one
 * later (the books or their backups moved into it): judged again here, each time the work runs, by
 * the rule the door uses when it is asked (lib/agent/files.ts overlapsAppData), and left out when it
 * is one or cannot be judged. files.save and the desktop shell's own check (the line's `folders`)
 * get only these.
 */
async function policyFolders(approver: ServiceContext, agentId: string): Promise<string[]> {
  try {
    const policy = await loadAgentPolicy(approver, agentId);
    const listed = Array.isArray(policy?.folders) ? policy.folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
    return listed.filter((f) => {
      try {
        return !overlapsAppData(f);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Whether `dir` is a broad personal folder, or holds one: the user's profile folder (home), its
 * Desktop, Documents and Downloads, and Documents where the desktop shell says it is (OneDrive can
 * move it). Such a folder is never a default folder agents may use: through it a save could reach
 * the Startup folder or a PowerShell profile. By the words, without regard to case on Windows and
 * macOS; a folder inside one of them (Documents\Books) is not broad. electron/agentShell.js
 * broadPersonalFolder is the same rule (test/agentShell.test.ts holds the two to one table).
 */
export function isBroadPersonalFolder(dir: string, where: { home: string; documents?: string | null; platform?: NodeJS.Platform }): boolean {
  const platform = where.platform ?? process.platform;
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (typeof dir !== 'string' || !dir.trim() || typeof where.home !== 'string' || !where.home.trim()) return true;
  const fold = (p: string) => {
    const r = P.resolve(p).replace(/[\\/]+$/, '');
    return platform === 'win32' || platform === 'darwin' ? r.normalize('NFC').toLowerCase() : r;
  };
  const home = where.home;
  const personal = [home, P.join(home, 'Desktop'), P.join(home, 'Documents'), P.join(home, 'Downloads')];
  if (typeof where.documents === 'string' && where.documents.trim()) personal.push(where.documents);
  const d = fold(dir);
  return personal.some((p) => {
    const f = fold(p);
    return f === d || f.startsWith(d.endsWith(P.sep) ? d : d + P.sep);
  });
}

/**
 * The folders agents may use without the Admin naming them: the open company file's folder, and
 * Documents\Ironbooks with its Agent Outbox. Documents is the one the desktop shell told this
 * server (the same the shell's own check uses); without the shell, the one in this account's home.
 * The company file's folder is left out (only Documents applies) when the file is at the top of a
 * drive or share, when it was opened through a share of this very computer, when the folder is a
 * broad personal one (isBroadPersonalFolder: the profile folder, Desktop, Documents, Downloads)
 * and when it is, lies inside or holds a place of Ironbooks' own data other than the company file
 * itself (lib/agent/files.ts holdsAppDataBesideTheBooks), as an Admin's own folder is judged.
 */
export function defaultAgentFolders(): string[] {
  const out: string[] = [];
  const told = process.env[SHELL_DOCUMENTS_ENV]?.trim();
  const docs = told && path.isAbsolute(told) ? told : path.join(homeDir(), 'Documents');
  const companyFile = process.env.BKA_COMPANY_FILE?.trim();
  if (companyFile) {
    const dir = path.dirname(path.resolve(companyFile));
    const shared = isDriveOrShareRoot(dir) || isThisComputerShare(dir);
    if (!shared && !isBroadPersonalFolder(dir, { home: homeDir(), documents: docs }) && !holdsAppDataSafely(dir)) out.push(dir);
  }
  out.push(path.join(docs, 'Ironbooks'), path.join(docs, 'Ironbooks', AGENT_OUTBOX_NAME));
  return out;
}

/** holdsAppDataBesideTheBooks, true when it cannot tell (fail closed). */
function holdsAppDataSafely(dir: string): boolean {
  try {
    return holdsAppDataBesideTheBooks(dir);
  } catch {
    return true;
  }
}

/** How an answer is checked: the launch key and the MAC of the ticket the request carried. */
export interface ShellAnswerCheck {
  key: string;
  ticketMac: string;
}

/**
 * Read the shell's answer: the four fields, nothing else, or null when it is not one. An answer
 * whose MAC is not the shell's for that ticket is a failure (UNCHECKED), never taken as done:
 * something else may have answered in the shell's place. With no check to make, nothing is taken.
 */
function readAnswer(text: string, check: ShellAnswerCheck): ShellRunResult | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.ok !== 'boolean') return null;
  if (!check || typeof check.ticketMac !== 'string' || !shellAnswerChecks(check.key, check.ticketMac, { ok: a.ok, result: a.result, error: a.error, restarting: a.restarting }, a.mac)) {
    return fail(UNCHECKED);
  }
  const error = typeof a.error === 'string' && a.error ? a.error : null;
  return {
    ok: a.ok,
    result: a.result === undefined ? null : a.result,
    error: a.ok ? null : error ?? 'The Ironbooks window could not do it.',
    restarting: a.restarting === true,
  };
}

/**
 * Send one request line to the shell and resolve its one-line answer. Never throws: no endpoint,
 * no answer in time or an unreadable answer come back as a plain failure. `check` is required: the
 * answer is taken only when its MAC is the shell's for that ticket (the launch key and the MAC of
 * the ticket on the line; '' for a line with no readable ticket, as the shell signs it). There is no
 * way to take an unsigned answer from whatever listens at the endpoint, for tests included.
 */
export function sendShellLine(line: string, timeLimitMs: number | undefined, check: ShellAnswerCheck): Promise<ShellRunResult> {
  const limit = typeof timeLimitMs === 'number' && timeLimitMs > 0 ? timeLimitMs : DEFAULT_TIME_LIMIT_MS;
  const endpoint = process.env[SHELL_ENDPOINT_ENV]?.trim();
  if (!endpoint) return Promise.resolve(fail(NO_SHELL));
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = net.connect({ path: endpoint });
    const finish = (r: ShellRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(fail(TOO_SLOW)), limit);
    socket.on('connect', () => {
      socket.write(line.endsWith('\n') ? line : `${line}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      const nl = chunk.indexOf(0x0a);
      const part = nl < 0 ? chunk : chunk.subarray(0, nl);
      size += part.length;
      if (size > MAX_ANSWER_BYTES) return finish(fail(GARBLED));
      chunks.push(part);
      if (nl >= 0) finish(readAnswer(Buffer.concat(chunks).toString('utf8'), check) ?? fail(GARBLED));
    });
    socket.on('end', () => {
      if (!chunks.length) return finish(fail(NOT_ANSWERING));
      finish(readAnswer(Buffer.concat(chunks).toString('utf8'), check) ?? fail(GARBLED));
    });
    socket.on('error', () => finish(fail(NOT_ANSWERING)));
  });
}

/** The PDF of a staged file of this agent, ready for the line, or why it cannot be printed. */
async function stagedPdf(companyId: string, agentId: string, fileId: unknown): Promise<{ name: string; type: string; base64: string } | string> {
  if (typeof fileId !== 'string' || !fileId) return 'Say which staged file to print (its fileId).';
  // A whole copy of the company file is the person's: never printed (PERSON_ONLY_FILE_MESSAGE).
  const staged = await readStagedFile({ companyId, agentId }, fileId).catch((err: unknown) => (personOnlyRefusal(err) ? PERSON_ONLY_FILE_MESSAGE : null));
  if (typeof staged === 'string') return staged;
  if (!staged) return 'There is no staged file with that id for this agent (staged files are kept for 24 hours). Stage it again first.';
  const bytes = Buffer.from(staged.bytes);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return `${staged.file.name} is not a PDF. Only a PDF can be printed this way.`;
  if (bytes.length > MAX_PRINT_BYTES) {
    return `${staged.file.name} is too large to print without a person (at most 1.5 MB). A person can print it from the Ironbooks window.`;
  }
  return { name: staged.file.name, type: 'application/pdf', base64: bytes.toString('base64') };
}

/** Send one operation to the shell with a fresh ticket. */
async function sendToShell(
  def: ShellOperationDef,
  t: { requestId: string; approverId: string; input: Record<string, unknown>; answers: Record<string, unknown>; secrets: Record<string, string>; folders: string[]; file?: { name: string; type: string; base64: string } },
): Promise<ShellRunResult> {
  if (!shellAvailable()) return fail(NO_SHELL);
  const key = shellKey();
  const kinds = Object.keys(t.secrets);
  let ticket;
  try {
    ticket = makeShellTicket(key, {
      requestId: t.requestId,
      operation: def.id,
      input: t.input,
      approverId: t.approverId,
      // Everything else the shell acts on: changed on the way, the MAC no longer checks out.
      bound: { answers: t.answers, folders: t.folders, file: shellFileRef(t.file ?? null), secrets: kinds },
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : NO_SHELL);
  }
  // The approver's secrets and a print job's PDF travel sealed for this ticket, never in the open.
  const priv: ShellPrivate = {};
  if (kinds.length) priv.secrets = t.secrets;
  if (t.file) priv.file = t.file;
  const line = JSON.stringify({
    ticket,
    operation: def.id,
    input: t.input,
    answers: t.answers,
    folders: t.folders,
    ...(priv.secrets || priv.file ? { sealed: sealShellPrivate(key, ticket.mac, priv) } : {}),
  });
  const answer = await sendShellLine(line, TIME_LIMIT_MS[def.id] ?? DEFAULT_TIME_LIMIT_MS, { key, ticketMac: ticket.mac });
  // The shell never answers with a secret; this keeps it so even if a message ever quoted one.
  return scrub(answer, t.secrets);
}

// ---------------------------------------------------------------------------
// files.save: done by the server itself
// ---------------------------------------------------------------------------

/** Characters a file name on Windows cannot hold, and invisible ones (lib/effects.ts checkFile). */
const BAD_NAME = /[\\/:*?"<>|\p{Cc}\p{Cf}]/u;
/** Names Windows keeps for devices, with or without an extension ("CON", "nul.txt", "COM1.pdf"). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu;

/** Why `name` cannot be a file's name in a folder, or null. Never a path: only a name. */
function nameProblem(name: string): string | null {
  const shown = name.length > 80 ? `${name.slice(0, 79)}…` : name;
  if (!name) return 'The file needs a name.';
  // Windows drops a trailing dot or space, so such a file would be saved under another name.
  if (BAD_NAME.test(name) || name !== name.trim() || name.endsWith('.')) {
    return `"${shown.replace(/[\p{Cc}\p{Cf}]/gu, '')}" cannot be used as a file name. Give only the name (the folder separately), leave out \\ / : * ? " < > | and invisible characters, and do not end it with a dot or a space.`;
  }
  if (DEVICE_NAME.test(name)) return `"${shown}" cannot be used as a file name: Windows keeps that name for a device. Choose another name.`;
  if (name.length > 255) return 'The file name is too long. Use at most 255 characters.';
  // A program, script or shortcut is never saved for an agent, in any folder (lib/agent/guards.ts).
  return runnableNameProblem(name);
}

/** The refusal readStagedFile gives for a whole copy of the company file. */
function personOnlyRefusal(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { message?: unknown }).message === PERSON_ONLY_FILE_MESSAGE;
}

/** A disk failure in plain words, never with a path (the system's message names the file). */
function diskTrouble(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const again = 'then have the agent ask again.';
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return `There is no room left on that disk, so nothing was saved. Free some space, ${again}`;
    case 'EACCES':
    case 'EPERM':
      return `Ironbooks may not write in that folder, so nothing was saved. Check the folder's permissions or choose another folder, ${again}`;
    case 'EROFS':
      return `That folder is on a disk that cannot be written to, so nothing was saved. Choose another folder, ${again}`;
    case 'ENOENT':
    case 'ENOTDIR':
      return `That folder is no longer there, so nothing was saved. Check the folder, ${again}`;
    case 'ENAMETOOLONG':
      return `The folder and the name together are too long, so nothing was saved. Use a shorter name, ${again}`;
    case 'EBUSY':
    case 'ETXTBSY':
      return `Another program is using that file or folder, so nothing was saved. Close it, ${again}`;
    default:
      return `The file could not be saved in that folder. Check that the folder is there and has room, ${again}`;
  }
}

function alreadyThere(fileName: string): string {
  return `There is already a file called "${fileName}" in that folder. Choose another name: Ironbooks never replaces a file for an agent.`;
}

async function saveStagedFile(approver: ServiceContext, request: { agentId: string; input: Record<string, unknown> }): Promise<ShellRunResult> {
  const { fileId, folder, name } = request.input ?? {};
  if (typeof fileId !== 'string' || !fileId) return fail('Say which staged file to save (its fileId).');
  if (typeof folder !== 'string' || !folder.trim()) return fail('Say which folder to save it in.');
  if (name !== undefined && name !== null && typeof name !== 'string') return fail('The name must be text.');
  // The save is the one reader that may have a whole copy of the company file: its bytes go to
  // the disk, in a folder agents may use, never to the agent (lib/agent/files.ts readStagedFileForSave).
  const staged = await readStagedFileForSave({ companyId: approver.companyId, agentId: request.agentId }, fileId).catch(() => null);
  if (!staged) return fail('There is no staged file with that id for this agent (staged files are kept for 24 hours). Stage it again first.');
  const allowed = usableFolders([...defaultAgentFolders(), ...(await policyFolders(approver, request.agentId))]);
  const dir = await allowedFolder(allowed, folder);
  if (!dir || isDriveOrShareRoot(dir)) {
    return fail(
      `"${folder}" is not a folder agents may save in, or it does not exist. Use the company file's folder, Documents\\Ironbooks\\${AGENT_OUTBOX_NAME}, ` +
        "or a folder the Admin added in the agent's settings.",
    );
  }
  const fileName = typeof name === 'string' && name.trim() ? name.trim() : staged.file.name;
  const wrongName = nameProblem(fileName);
  if (wrongName) return fail(wrongName);
  const target = path.join(dir, fileName);
  // Anything at that name (a file, a folder, a link even to nowhere) and nothing is saved. Windows
  // creates a new file THROUGH a link that leads nowhere, so a link is looked for first.
  try {
    await fsp.lstat(target);
    return fail(alreadyThere(fileName));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ENOENT') return fail(diskTrouble(err));
  }
  // Made new on the disk (an exclusive create): a file that arrived a moment ago makes the save
  // fail. Nothing is ever replaced for an agent.
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  let made = false;
  try {
    handle = await fsp.open(target, 'wx');
    made = true;
    // The file made is the one at that name, not one a link planted meanwhile led elsewhere.
    const [opened, atName] = await Promise.all([handle.stat({ bigint: true }), fsp.lstat(target, { bigint: true })]);
    if (atName.isSymbolicLink() || opened.ino !== atName.ino || opened.dev !== atName.dev) {
      made = false; // not this save's to take away: it is wherever the link led
      await handle.close().catch(() => undefined);
      handle = null;
      return fail('Something in that folder changed while the file was being saved (a link appeared at its name), so nothing was saved. Have the agent ask again.');
    }
    await handle.writeFile(staged.bytes);
    await handle.sync().catch(() => undefined);
    await handle.close();
    handle = null;
    return {
      ok: true,
      result: { path: target, name: fileName, size: staged.bytes.byteLength, saved: true, status: 'done' },
      error: null,
      restarting: false,
    };
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    if (!made && (err as { code?: unknown } | null)?.code === 'EEXIST') return fail(alreadyThere(fileName));
    // Only a file this save made itself is taken away again (half written: the disk filled up).
    if (made) await fsp.unlink(target).catch(() => undefined);
    return fail(diskTrouble(err));
  }
}

/** A path an agent sent, as one line a person can read in a message (no invisible characters, cut short). */
function shownPath(v: string): string {
  const one = v.replace(/[\p{Cc}\p{Cf}]/gu, '');
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

/**
 * Why a desktop operation's paths may not be used now, or null. Each 'path' field names a file
 * its flow opens or writes; its folder must be one agents may use as things are when the work
 * runs, judged as files.save judges its folder (usableFolders, allowedFolder: links resolved, never
 * the top of a drive or share nor a share of this computer, never inside the books or Ironbooks'
 * own data). The door judged the same at the ask (lib/agent/operate.ts shellPathRefusal), but the
 * approval may come later: a folder that has since come to lie inside such a place (the company
 * file's folder that now holds its archives), or is gone, is refused before the shell is asked.
 * The desktop shell checks again on its side (electron/agentShell.js pathProblem), without the
 * rule on Ironbooks' own data, which only this side knows.
 */
async function pathOutsideFolders(def: ShellOperationDef, input: Record<string, unknown>, added: readonly string[]): Promise<string | null> {
  const fields = Object.entries(def.input ?? {}).filter(([, f]) => f.type === 'path');
  if (!fields.length) return null;
  const where =
    `Use the company file's folder, Documents\\Ironbooks or Documents\\Ironbooks\\${AGENT_OUTBOX_NAME}, ` +
    "or a folder the Admin added in the agent's settings, then have the agent ask again.";
  let allowed: string[] | null = null;
  for (const [field, f] of fields) {
    const v = input[field];
    if ((v === undefined || v === null) && f.required !== true) continue;
    // As the door and the shell read it: a whole path, with nothing around it.
    if (typeof v !== 'string' || !v || v !== v.trim() || !path.isAbsolute(v)) {
      return `"${field}" must be the full path of a file in a folder agents may use on this computer, so nothing was done. ${where}`;
    }
    allowed ??= usableFolders([...defaultAgentFolders(), ...added]);
    const dir = await allowedFolder(allowed, path.dirname(path.resolve(v)));
    if (!dir || isDriveOrShareRoot(dir)) {
      return `"${shownPath(v)}" is not in a folder agents may use on this computer now, or its folder is no longer there, so nothing was done. ${where}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Carry out an approved shell operation. `approver` is the approving person's context; `answers`
 * are their answers to the flow's questions; `secrets` are what they typed on the card.
 */
export async function runShellOperation(
  approver: ServiceContext,
  def: ShellOperationDef,
  request: { id: string; agentId: string; input: Record<string, unknown> },
  answers: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<ShellRunResult> {
  const refused = approverProblem(approver);
  if (refused) return fail(refused);
  // Our own definition, never the caller's copy: what runs is what the registry describes.
  const known = SHELL_OPERATIONS.find((d) => d.id === def?.id);
  if (!known || known.runner !== def.runner) return fail(`Ironbooks does not know the operation "${String(def?.id ?? '')}".`);
  if (!request || typeof request.id !== 'string' || !request.id || typeof request.agentId !== 'string' || !request.agentId) {
    return fail('The request this approval is for could not be read.');
  }
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input) ? request.input : {};
  const cleaned = cleanSecrets(secrets);
  try {
    if (known.runner === 'server') {
      if (known.id === 'files.save') return scrub(await saveStagedFile(approver, { agentId: request.agentId, input }), cleaned);
      return fail(`Ironbooks does not know the operation "${known.id}".`);
    }
    if (!shellAvailable()) return fail(NO_SHELL);
    let file: { name: string; type: string; base64: string } | undefined;
    if (known.id === 'shell.print.file') {
      const pdf = await stagedPdf(approver.companyId, request.agentId, input.fileId);
      if (typeof pdf === 'string') return fail(pdf);
      file = pdf;
    }
    const added = await policyFolders(approver, request.agentId);
    const outside = await pathOutsideFolders(known, input, added);
    if (outside) return fail(outside);
    return await sendToShell(known, {
      requestId: request.id,
      approverId: approver.userId as string,
      input,
      answers: answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {},
      secrets: cleaned,
      folders: added,
      file,
    });
  } catch (err) {
    return scrub(fail(err instanceof Error && err.message ? err.message : 'Ironbooks could not carry out the request.'), cleaned);
  }
}

// ---------------------------------------------------------------------------
// Printing through the shell (the effects outbox's print handler)
// ---------------------------------------------------------------------------

const PRINT_DEF = SHELL_OPERATIONS.find((d) => d.id === 'shell.print.file') as ShellOperationDef;

/**
 * Print a staged PDF through the shell. Whose file it is, and who approved, come from the open
 * service scope (the agent's run in the bridge): a print effect is always an agent's work, and
 * print is never Allow, so it carries a person's approval or a short standing permission.
 */
export const printThroughShell: PrintHandler = async (job) => {
  let ctx: ServiceContext | undefined;
  try {
    ctx = currentServiceScope()?.ctx;
  } catch {
    ctx = undefined;
  }
  if (!ctx || !ctx.agent) throw new Error('Ironbooks could not tell whose file this is, so it was not printed.');
  const approval = ctx.approval ?? { approvedBy: null, requestId: null, grantId: null };
  const approverId = approval.approvedBy ?? (approval.grantId ? `grant:${approval.grantId}` : null);
  if (!approverId) throw new Error("Printing for an agent needs a person's approval.");
  const file = await stagedPdf(ctx.companyId, ctx.agent.id, job.fileId);
  if (typeof file === 'string') throw new Error(file);
  const input: Record<string, unknown> = { fileId: job.fileId };
  if (job.printer) input.printer = job.printer;
  if (job.copies && job.copies !== 1) input.copies = job.copies;
  const r = await sendToShell(PRINT_DEF, {
    // One ticket per job: the shell runs each request id once, and one run may print several files.
    requestId: `print:${approval.requestId ?? 'grant'}:${randomUUID()}`,
    approverId,
    input,
    answers: {},
    secrets: {},
    folders: [],
    file,
  });
  if (!r.ok) throw new Error(r.error ?? 'The job could not be sent to the printer.');
};

/**
 * Let the effects outbox print through the desktop shell, when there is one (idempotent). Runs
 * when this module loads; the server's start-up or the bridge may call it again.
 */
export function installShellPrinting(): boolean {
  if (!shellAvailable()) return false;
  setPrintHandler(printThroughShell);
  return true;
}

installShellPrinting();
