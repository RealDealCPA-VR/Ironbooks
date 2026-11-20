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
 *  2. makes the approval ticket (lib/agent/shellTicket.ts) over the request id, the operation, the
 *     input and the approver, good for SHELL_TICKET_SECONDS;
 *  3. sends one JSON line { ticket, operation, input, answers, secrets, folders, file? }: the
 *     approver's answers and secrets are for this one run and are never kept; `folders` are the
 *     ones the Admin allowed for the agent (the shell adds its defaults); `file` is the PDF of a
 *     print request, read from the agent's own staged files;
 *  4. waits for the one-line answer { ok, result, error, restarting } with a time limit, and maps
 *     anything else (no shell, no answer, a garbled one) to a plain message.
 * The shell checks everything again on its side (ticket, replay, input, folders) before it runs.
 *
 * 'files.save' (runner 'server') is done here: one of the agent's staged files saved into a folder
 * agents may use, never over a file that is already there.
 *
 * Printing an operation's PDF (plan §5.4, D10): installShellPrinting() registers the effects
 * outbox's print handler (lib/effects.ts setPrintHandler), which sends the job to the shell the
 * same way, as the operation "shell.print.file".
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ServiceContext } from '@/lib/services/_base';
import { loadAgentPolicy } from '@/lib/services/agentPolicies';
import { effects, setPrintHandler, type PrintHandler } from '@/lib/effects';
import { currentServiceScope } from '@/lib/serviceScope';
import type { ShellOperationDef } from './contract';
import { allowedFolder, readStagedFile } from './files';
import { SHELL_OPERATIONS } from './operations/shell';
import { makeShellTicket } from './shellTicket';

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

/** The folders the Admin allowed for this agent (none when the policy cannot be read: the defaults still apply). */
async function policyFolders(approver: ServiceContext, agentId: string): Promise<string[]> {
  try {
    const policy = await loadAgentPolicy(approver, agentId);
    return Array.isArray(policy?.folders) ? policy.folders.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
  } catch {
    return [];
  }
}

/**
 * The folders agents may use without the Admin naming them: the open company file's folder, and
 * Documents\Ironbooks with its Agent Outbox. Documents is the one the desktop shell told this
 * server (the same the shell's own check uses); without the shell, the one in this account's home.
 */
export function defaultAgentFolders(): string[] {
  const out: string[] = [];
  const companyFile = process.env.BKA_COMPANY_FILE?.trim();
  if (companyFile) out.push(path.dirname(path.resolve(companyFile)));
  const told = process.env[SHELL_DOCUMENTS_ENV]?.trim();
  const docs = told && path.isAbsolute(told) ? told : path.join(os.homedir(), 'Documents');
  out.push(path.join(docs, 'Ironbooks'), path.join(docs, 'Ironbooks', AGENT_OUTBOX_NAME));
  return out;
}

/** Read the shell's answer: the four fields, nothing else, or null when it is not one. */
function readAnswer(text: string): ShellRunResult | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.ok !== 'boolean') return null;
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
 * no answer in time or an unreadable answer come back as a plain failure.
 */
export function sendShellLine(line: string, timeLimitMs = DEFAULT_TIME_LIMIT_MS): Promise<ShellRunResult> {
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
    const timer = setTimeout(() => finish(fail(TOO_SLOW)), timeLimitMs);
    socket.on('connect', () => {
      socket.write(line.endsWith('\n') ? line : `${line}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      const nl = chunk.indexOf(0x0a);
      const part = nl < 0 ? chunk : chunk.subarray(0, nl);
      size += part.length;
      if (size > MAX_ANSWER_BYTES) return finish(fail(GARBLED));
      chunks.push(part);
      if (nl >= 0) finish(readAnswer(Buffer.concat(chunks).toString('utf8')) ?? fail(GARBLED));
    });
    socket.on('end', () => {
      if (!chunks.length) return finish(fail(NOT_ANSWERING));
      finish(readAnswer(Buffer.concat(chunks).toString('utf8')) ?? fail(GARBLED));
    });
    socket.on('error', () => finish(fail(NOT_ANSWERING)));
  });
}

/** The PDF of a staged file of this agent, ready for the line, or why it cannot be printed. */
async function stagedPdf(companyId: string, agentId: string, fileId: unknown): Promise<{ name: string; type: string; base64: string } | string> {
  if (typeof fileId !== 'string' || !fileId) return 'Say which staged file to print (its fileId).';
  const staged = await readStagedFile({ companyId, agentId }, fileId).catch(() => null);
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
  let ticket;
  try {
    ticket = makeShellTicket(shellKey(), { requestId: t.requestId, operation: def.id, input: t.input, approverId: t.approverId });
  } catch (err) {
    return fail(err instanceof Error ? err.message : NO_SHELL);
  }
  const line = JSON.stringify({
    ticket,
    operation: def.id,
    input: t.input,
    answers: t.answers,
    secrets: t.secrets,
    folders: t.folders,
    ...(t.file ? { file: t.file } : {}),
  });
  const answer = await sendShellLine(line, TIME_LIMIT_MS[def.id] ?? DEFAULT_TIME_LIMIT_MS);
  // The shell never answers with a secret; this keeps it so even if a message ever quoted one.
  return scrub(answer, t.secrets);
}

// ---------------------------------------------------------------------------
// files.save: done by the server itself
// ---------------------------------------------------------------------------

async function saveStagedFile(approver: ServiceContext, request: { agentId: string; input: Record<string, unknown> }): Promise<ShellRunResult> {
  const { fileId, folder, name } = request.input ?? {};
  if (typeof fileId !== 'string' || !fileId) return fail('Say which staged file to save (its fileId).');
  if (typeof folder !== 'string' || !folder.trim()) return fail('Say which folder to save it in.');
  if (name !== undefined && name !== null && typeof name !== 'string') return fail('The name must be text.');
  const staged = await readStagedFile({ companyId: approver.companyId, agentId: request.agentId }, fileId).catch(() => null);
  if (!staged) return fail('There is no staged file with that id for this agent (staged files are kept for 24 hours). Stage it again first.');
  const allowed = [...defaultAgentFolders(), ...(await policyFolders(approver, request.agentId))];
  const dir = await allowedFolder(allowed, folder);
  if (!dir) {
    return fail(
      `"${folder}" is not a folder agents may save in, or it does not exist. Use the company file's folder, Documents\\Ironbooks\\${AGENT_OUTBOX_NAME}, ` +
        "or a folder the Admin added in the agent's settings.",
    );
  }
  const fileName = typeof name === 'string' && name.trim() ? name.trim() : staged.file.name;
  const target = path.join(dir, fileName);
  const there = await fsp.lstat(target).then(
    () => true,
    () => false,
  );
  if (there) return fail(`There is already a file called "${fileName}" in that folder. Choose another name: Ironbooks never replaces a file for an agent.`);
  try {
    const written = await effects.writeFile({ dir, name: fileName, bytes: staged.bytes });
    return {
      ok: true,
      result: { path: written.path, name: fileName, size: written.size, saved: written.written, status: written.status },
      error: null,
      restarting: false,
    };
  } catch (err) {
    return fail(err instanceof Error && err.message ? err.message : 'The file could not be saved.');
  }
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
    return await sendToShell(known, {
      requestId: request.id,
      approverId: approver.userId as string,
      input,
      answers: answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {},
      secrets: cleaned,
      folders: await policyFolders(approver, request.agentId),
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
