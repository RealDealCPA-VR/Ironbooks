// Agent full access: the desktop shell's side of approved agent requests (plan 5.5, AGENT_ACCESS.md).
//
// Some of what an agent may ask for has no API route, because only this window can do it: open,
// switch or close the company file, Save Copy As, restore a backup, a portable file or an
// Accountant's Copy as a new company file, the practice copy, multi-user access, updates, Ollama,
// printing. How such a request reaches the window:
//
//  - At start-up the shell opens a private local endpoint (a named pipe with a random name on
//    Windows, a Unix socket in a private folder elsewhere) and tells only its own company server
//    where it is, with a random key for this launch, in that server's environment
//    (BKA_AGENT_SHELL, BKA_AGENT_SHELL_KEY), the same way it hands over BKA_INTERNAL_TOKEN.
//  - When a person approves such a request in their own window, the server makes an approval
//    ticket: an HMAC with that key over the request id, the operation, a hash of the input, the
//    approver and an expiry two minutes ahead (lib/agent/shellTicket.ts). It sends ONE JSON line:
//    { ticket, operation, input, answers, secrets, folders, file? }.
//  - Here, before anything runs: the ticket must be good for exactly this operation and input and
//    must not have been seen before (a replay is refused); the input must be what the operation
//    takes; every path in it must be inside a folder agents may use (the open company file's
//    folder, Documents\Ironbooks and its Agent Outbox, plus the folders the Admin added for the
//    agent, which the line carries from the policy). Anything unexpected is refused: fail closed.
//    A path is a file strictly inside such a folder (never the folder itself), checked as the disk
//    has it (links followed, names exactly as the disk spells them); the company file a flow will
//    write (".ironbooks" added) is checked too, and must not be there yet.
//  - Then the operation runs the same flow the File menu runs (electron/main.js), inside a SCRIPT:
//    every native dialog the flow would show takes its answer from the request instead of opening.
//    A dialog's options are read as Electron reads them (window first, or none). File pickers get
//    the input's paths (checked again as the dialog gives them), questions the approver's answers
//    from the approval card, a password prompt what the approver typed there. A question with no
//    answer is answered the way Cancel would answer it, and the request fails naming the question.
//    Nothing ever waits on screen. The script follows the flow's own async work (AsyncLocalStorage)
//    and ends with it: a dialog shown by anything else, at any other moment, goes to the person
//    exactly as before.
//  - One JSON line goes back: { ok, result, error, restarting }. Never a secret, never the ticket.
//
// Plain Node, no Electron import: the ticket check, the replay memory, the path check, the
// scripted dialogs and the endpoint itself are driven by test/agentShell.test.ts with fake flows.
// main.js passes in what needs Electron (the dialog module, the flows, BrowserWindow, Notification).

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

/** Where the endpoint listens, and this launch's ticket key, in the company server's environment. */
const ENDPOINT_ENV = 'BKA_AGENT_SHELL';
const KEY_ENV = 'BKA_AGENT_SHELL_KEY';
/** lib/agent/contract.ts SHELL_TICKET_SECONDS. */
const TICKET_SECONDS = 120;
/** The folder in Documents\Ironbooks agents may always use for what they hand over. */
const OUTBOX_NAME = 'Agent Outbox';
/**
 * Most bytes of a PDF printed for an agent. The hidden print window loads it as a data: address
 * (no window ever loads a file:// page: test/security4.fuses.test.ts), and Chromium refuses an
 * address over 2 MB; 1.5 MB in base64 stays under that. A larger PDF a person prints themselves.
 */
const MAX_PRINT_BYTES = 1_500_000;
/** A request line: the input plus, for printing, that PDF in base64 (2 MB at most) and room for the rest. */
const MAX_LINE_BYTES = 2.5 * 1024 * 1024;
/**
 * How long a connection has, from the moment it is accepted, to send its whole line (the server
 * writes it at once). Counted from the start, not from the last byte: a program that trickles a
 * byte at a time cannot hold the endpoint's few connections for long.
 */
const READ_TIMEOUT_MS = 10_000;
const MAX_COPIES = 100;

const TICKET_LABEL = 'ironbooks-shell-ticket/1';
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-f]{32}$/;
const CLOCK_SLACK_MS = 60_000;

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

/** One line for a message: no control or invisible formatting characters, at most `max` characters. */
function oneLine(value, max = 300) {
  const s = String(value == null ? '' : value)
    .replace(/[\p{Cf}\p{Cs}]/gu, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function errorText(err) {
  return oneLine(err && typeof err === 'object' && err.message ? err.message : String(err), 500) || 'Something went wrong.';
}

// ---------------------------------------------------------------------------
// Approval tickets (the same algorithm as lib/agent/shellTicket.ts)
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted (lib/agent/shellTicket.ts stableJson). */
function stableJson(value) {
  if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') return stableJson(value.toJSON());
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined && typeof value[k] !== 'function' && typeof value[k] !== 'symbol')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function inputHash(input) {
  return crypto.createHash('sha256').update(stableJson(input === undefined ? null : input), 'utf8').digest('hex');
}

function ticketMac(key, t) {
  const message = JSON.stringify([TICKET_LABEL, t.requestId, t.operation, t.inputHash, t.approverId, t.expiresAt]);
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

function readableTicket(t) {
  return Boolean(
    t &&
      typeof t === 'object' &&
      typeof t.requestId === 'string' &&
      t.requestId &&
      typeof t.operation === 'string' &&
      t.operation &&
      typeof t.inputHash === 'string' &&
      HEX64.test(t.inputHash) &&
      typeof t.approverId === 'string' &&
      t.approverId &&
      typeof t.expiresAt === 'number' &&
      Number.isFinite(t.expiresAt) &&
      typeof t.mac === 'string' &&
      HEX64.test(t.mac),
  );
}

function sameHex(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * Null when `ticket` is good for exactly this operation and input, otherwise why not. A request
 * that fails is final (plan 7.2): the way on is a new request, so the messages say "ask again".
 */
function ticketProblem(key, ticket, operation, input, now = Date.now()) {
  if (typeof key !== 'string' || !key) {
    return 'This Ironbooks has no key for approval tickets, so it cannot carry out approved requests. Restart Ironbooks, then have the agent ask again.';
  }
  if (!readableTicket(ticket)) return 'The approval ticket could not be read, so nothing was done. The agent can ask again.';
  // The MAC first: until it checks out, nothing else in the ticket can be believed.
  if (!sameHex(ticketMac(key, ticket), ticket.mac)) {
    return 'The approval ticket was not made by this Ironbooks, so nothing was done. Requests are approved in the Ironbooks window; the agent can ask again.';
  }
  if (now > ticket.expiresAt) return 'The approval ran out before Ironbooks got to it, so nothing was done. The agent can ask again.';
  if (ticket.expiresAt - now > TICKET_SECONDS * 1000 + CLOCK_SLACK_MS) return 'The approval ticket could not be read, so nothing was done. The agent can ask again.';
  if (ticket.operation !== operation) return 'The approval ticket is for another request, so nothing was done. The agent can ask again.';
  if (!sameHex(ticket.inputHash, inputHash(input))) return 'The request changed after it was approved, so nothing was done. The agent can ask again.';
  return null;
}

/**
 * Tickets already used, until they run out (after that the ticket check refuses them anyway). Also
 * by request id: one approval runs one request once, even when two tickets for it arrive together.
 * A request that did not work is final (plan 7.2: it becomes `failed`), so nothing approves the
 * same request id twice: the agent asks again, which is a new request.
 */
function createReplayMemory() {
  const seen = new Map();
  return {
    /** Remember the ticket. False when it, or another ticket for its request, was used before. */
    use(ticket, now = Date.now()) {
      for (const [k, until] of seen) if (until < now) seen.delete(k);
      const byMac = `mac:${ticket.mac}`;
      const byRequest = `request:${ticket.requestId}`;
      if (seen.has(byMac) || seen.has(byRequest)) return false;
      seen.set(byMac, ticket.expiresAt);
      seen.set(byRequest, ticket.expiresAt);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Folders agents may use
// ---------------------------------------------------------------------------

/** \\?\…, \\.\… and \??\…: device and raw namespace paths, never a place an agent may name. */
const DEVICE_PATH = /^(?:[\\/]{2}[?.](?:[\\/]|$)|\\\?\?\\)/;
/** Names Windows keeps for devices, with or without an extension ("CON", "nul.txt", "COM1.pdf"). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu;
const PATH_MAX = 1024;

/** The folders agents may use without the Admin naming them. */
function defaultFolders({ companyFile, documents } = {}) {
  const out = [];
  if (typeof companyFile === 'string' && companyFile) out.push(path.dirname(companyFile));
  if (typeof documents === 'string' && documents) {
    out.push(path.join(documents, 'Ironbooks'));
    out.push(path.join(documents, 'Ironbooks', OUTBOX_NAME));
  }
  return out;
}

/** The path as it will be used (absolute, ".." resolved), or null when it is no plain path on this computer. */
function cleanPath(raw, platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (typeof raw !== 'string' || !raw || raw.length > PATH_MAX || raw !== raw.trim()) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(raw)) return null;
  if (platform !== 'win32') return P.isAbsolute(raw) ? P.resolve(raw) : null;
  if (DEVICE_PATH.test(raw)) return null;
  // A drive letter or a share: never "\folder" or "C:folder", which depend on the current drive or folder.
  const share = /^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+/.test(raw);
  if (!share && !/^[A-Za-z]:[\\/]/.test(raw)) return null;
  const resolved = P.resolve(raw);
  const rest = resolved.slice(P.parse(resolved).root.length);
  // No alternate data streams ("file:stream"), no device names, no names Windows would change
  // (a trailing dot or space is dropped, so "Books." is "Books"), nothing a file name cannot hold.
  if (rest.includes(':')) return null;
  if (rest.split(P.sep).some((part) => part && (DEVICE_NAME.test(part) || /[. ]$/.test(part) || /[<>"|?*]/.test(part)))) return null;
  return resolved;
}

/**
 * A name as Windows compares names, near enough for a first look by the words: each character in
 * upper case when that is still one character (as NTFS does, character by character). Not lower
 * case: "K" (the Kelvin sign) lowers to "k" but is a name of its own on the disk.
 */
function windowsFold(s) {
  let out = '';
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += Array.from(up).length === 1 ? up : ch;
  }
  return out;
}

/**
 * `child` is inside `parent`: below it, never the folder itself (every path an agent names is a
 * file, and a "file" that is an allowed folder becomes "<folder>.ironbooks" beside it). By the
 * words: without regard to case on Windows. `exact`: names as written, for paths that come from
 * the disk itself (realpath spells every existing name as the disk does).
 */
function insideFolder(child, parent, platform, { exact = false } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const key = (p) => (platform === 'win32' && !exact ? windowsFold(p) : p);
  const c = key(child);
  let p = key(parent);
  if (!p.endsWith(P.sep)) p += P.sep;
  return c.length > p.length && c.startsWith(p);
}

const REAL_FS = {
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync.native(p),
};

/**
 * Where `p` is on the disk: the real path of its nearest part that exists (every link followed,
 * every name spelled as the disk spells it), joined with the parts below it that do not exist yet,
 * as written. Null when unknown (a part the disk will not say anything about).
 */
function onDisk(p, platform, fsx) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const rest = [];
  let current = p;
  for (let i = 0; i < 512; i++) {
    let exists = false;
    try {
      fsx.lstat(current);
      exists = true;
    } catch (err) {
      // Only "not there" lets the look go up a level; anything else (no access) is unknown.
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) return null;
    }
    if (exists) {
      let real;
      try {
        real = fsx.realpath(current);
      } catch {
        return null;
      }
      return rest.length ? P.join(real, ...rest.reverse()) : real;
    }
    const parent = P.dirname(current);
    if (parent === current) return null;
    rest.push(P.basename(current));
    current = parent;
  }
  return null;
}

/**
 * Null when `raw` is inside one of the `allowed` folders, otherwise why not, in plain words.
 * First by the words alone, before the disk is looked at: a path on another computer's share is
 * never touched unless an allowed folder is on that share (merely looking makes Windows offer the
 * person's sign-in to that computer). Then, with `fs` (the real disk by default; null for words
 * only), as the disk has it: links followed and names compared exactly as the disk spells them, so
 * neither a shortcut inside an allowed folder nor a name that only looks like the folder's (one
 * that differs in a way Windows does not fold, like the Kelvin sign) leads out of it. A part that
 * does not exist yet must then be spelled exactly as the allowed folder is.
 */
function pathProblem(raw, allowed, { platform = process.platform, fs: fsx = REAL_FS } = {}) {
  const shown = oneLine(raw, 200);
  const want = cleanPath(raw, platform);
  if (!want) {
    const start = platform === 'win32' ? 'with the drive (C:\\…)' : 'with /';
    return `"${shown}" is not a full path to a place on this computer. Give the whole path, starting ${start}.`;
  }
  const bases = (Array.isArray(allowed) ? allowed : []).map((a) => cleanPath(a, platform)).filter(Boolean);
  const outside =
    `"${shown}" is not in a folder agents may use on this computer. Use the company file's folder, Documents\\Ironbooks, ` +
    "or a folder the Admin added in the agent's settings, and name a file inside it.";
  const candidates = bases.filter((b) => insideFolder(want, b, platform));
  if (!candidates.length) return outside;
  if (!fsx) return null;
  const real = onDisk(want, platform, fsx);
  if (real && candidates.some((b) => {
    const base = onDisk(b, platform, fsx);
    return base && insideFolder(real, base, platform, { exact: true });
  })) {
    return null;
  }
  return `"${shown}" leads outside the folders agents may use (through a shortcut, a link, or a name that only looks like the folder's), so it was refused. Spell the folder exactly as it is on the disk.`;
}

/** The company file a flow makes of `p`: the flows add ".ironbooks" when it is missing. */
function companyFilePath(p) {
  return /\.ironbooks$/i.test(p) ? p : `${p}.ironbooks`;
}

/** Something is at `p` (a file, a folder, or a link, even one that leads nowhere). */
function pathTaken(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The operations the shell carries out (lib/agent/operations/shell.ts, runner 'electron')
// ---------------------------------------------------------------------------
//
// fields: the input it takes. saveDialog / openDialog: the input field a Save / Open dialog takes
// its answer from. newFile: the input field naming a company file the flow writes (".ironbooks"
// added when missing), which must not be there yet. password: the secret a password prompt takes.
// hostPrompt: the field the "Open company on host" prompt takes. questions: the flow questions
// (QUESTIONS) the approver may answer. confirmedByApproval: the flow's own "do it?" question,
// answered yes by the approval itself. pdf: a PDF comes with the request.

const PATH_FIELD = { type: 'path', required: true };

const OPERATIONS = Object.freeze({
  'shell.company.new': { fields: { file: PATH_FIELD }, saveDialog: 'file', newFile: 'file', questions: ['temporaryFolder', 'cloudFolder'] },
  'shell.company.open': { fields: { file: PATH_FIELD }, openDialog: 'file', questions: ['temporaryFolder', 'readOnlyFile', 'cloudFolder'] },
  'shell.company.switch': { fields: { file: PATH_FIELD }, questions: [] },
  'shell.company.close': { fields: {}, questions: ['closeWhileHosting'] },
  'shell.company.saveCopyAs': { fields: { file: PATH_FIELD }, saveDialog: 'file', newFile: 'file', questions: [], fixedAnswers: ['savedCopy'] },
  'shell.portable.open': {
    fields: { file: PATH_FIELD, target: PATH_FIELD },
    saveDialog: 'target',
    newFile: 'target',
    password: 'backup_password',
    questions: ['openNow'],
  },
  'shell.accountantCopy.open': {
    fields: { file: PATH_FIELD, target: PATH_FIELD },
    saveDialog: 'target',
    newFile: 'target',
    password: 'backup_password',
    questions: ['openNow'],
  },
  'shell.backup.restoreAsNew': {
    fields: { file: PATH_FIELD, target: PATH_FIELD },
    saveDialog: 'target',
    newFile: 'target',
    questions: ['openNow', 'temporaryFolder', 'readOnlyFile', 'cloudFolder'],
  },
  'shell.sandbox.enter': { fields: {}, questions: [] },
  'shell.sandbox.leave': { fields: {}, questions: [] },
  'shell.hosting.start': { fields: { network: { type: 'string', required: true, oneOf: ['office', 'tailnet'] } }, questions: [] },
  'shell.hosting.stop': { fields: {}, questions: ['disconnectOthers'] },
  'shell.hosting.connect': { fields: { host: { type: 'string', required: true } }, hostPrompt: 'host', questions: [] },
  'shell.hosting.disconnect': { fields: {}, questions: [] },
  'shell.update.install': { fields: {}, questions: ['closeOverUnsavedForm'] },
  'shell.ollama.install': { fields: {}, questions: [], confirmedByApproval: ['installOllama'] },
  'shell.print.file': {
    fields: {
      fileId: { type: 'fileId', required: true },
      printer: { type: 'string', required: false },
      copies: { type: 'number', required: false, integer: [1, MAX_COPIES] },
    },
    pdf: true,
    questions: [],
  },
});

/**
 * The message boxes the flows can show with more than one button, known by their buttons (the
 * message itself names files and people). `id`: the flow question the approver answers
 * (lib/agent/operations/shell.ts). `approval`: the operation's own "do it?", answered yes by the
 * approval. `fixed`: a notice whose second button is never the agent's to press ("Show in Folder").
 * Yes is always the first button; no and Cancel are the box's own cancel button.
 */
const QUESTIONS = Object.freeze([
  { id: 'temporaryFolder', kind: 'choice', buttons: ['Save a Copy and Open It', 'Open It Here Anyway', 'Cancel'] },
  { id: 'readOnlyFile', kind: 'choice', buttons: ['Save a Copy and Open It', 'Cancel'] },
  { id: 'cloudFolder', kind: 'yes_no', buttons: ['Open It', 'Cancel'] },
  { id: 'openNow', kind: 'yes_no', buttons: ['Open It Now', 'Later'] },
  { id: 'openNow', kind: 'yes_no', buttons: ['Open it now', 'Later'] },
  { id: 'closeWhileHosting', kind: 'yes_no', buttons: ['Close Company', 'Cancel'] },
  { id: 'disconnectOthers', kind: 'yes_no', buttons: ['Switch to Single-user Mode', 'Cancel'] },
  { id: 'closeOverUnsavedForm', kind: 'yes_no', buttons: ['Close Without Recording', 'Cancel'] },
  { approval: 'installOllama', buttons: ['Download and install', 'Cancel'] },
  { approval: 'installOllama', buttons: ['Open the download page', 'Cancel'] },
  { fixed: 'savedCopy', response: 0, buttons: ['OK', 'Show in Folder'] },
]);

function sameButtons(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Check the input against what the operation takes. Null when it is fine, otherwise why not. */
function inputProblem(spec, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'The request carries no input the Ironbooks window can read.';
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec.fields, k)) return `"${oneLine(k, 60)}" is not something this request takes.`;
  }
  for (const [k, f] of Object.entries(spec.fields)) {
    const v = input[k];
    if (v === undefined || v === null) {
      if (f.required) return `This request needs "${k}".`;
      continue;
    }
    if (f.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `"${k}" must be a number.`;
      if (f.integer && (!Number.isInteger(v) || v < f.integer[0] || v > f.integer[1])) {
        return `"${k}" must be a whole number from ${f.integer[0]} to ${f.integer[1]}.`;
      }
      continue;
    }
    if (f.type === 'boolean') {
      if (typeof v !== 'boolean') return `"${k}" must be true or false.`;
      continue;
    }
    if (typeof v !== 'string' || v.length > 2048) return `"${k}" must be text.`;
    if ((f.type === 'path' || f.type === 'fileId') && !v.trim()) return `This request needs "${k}".`;
    if (f.type === 'fileId' && !FILE_ID.test(v)) return `"${k}" is not a file id from upload_file.`;
    if (f.oneOf && !f.oneOf.includes(v)) return `"${k}" must be one of: ${f.oneOf.join(', ')}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scripted dialogs
// ---------------------------------------------------------------------------

const scripts = new AsyncLocalStorage();

/** An options object as a flow writes one (`{ … }`): never a window, which is an object of a class. */
function plainObject(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const proto = Object.getPrototypeOf(a);
  return proto === Object.prototype || proto === null;
}

/**
 * The options of a dialog call, read as Electron reads its arguments: a plain object first is the
 * options; otherwise the first argument is the window (or null / undefined, for none) and the
 * options come second. Never picked by what the object holds: a window has a `title` of its own.
 * Null when there are none to read, and every scripted dialog then refuses.
 */
function dialogOptions(args) {
  const list = Array.isArray(args) ? args : [];
  if (plainObject(list[0])) return list[0];
  return plainObject(list[1]) ? list[1] : null;
}

/**
 * The button that changes nothing: the box's own cancelId; without one, a button that says so
 * (as Electron picks for Escape); failing that the last one, never the first (usually the action).
 */
function cancelOf(buttons, cancelId) {
  if (Number.isInteger(cancelId) && cancelId >= 0 && cancelId < Math.max(buttons.length, 1)) return cancelId;
  const named = buttons.findIndex((b) => /^(cancel|no|later|not now|keep working)$/i.test(b.trim()));
  if (named >= 0) return named;
  return Math.max(buttons.length - 1, 0);
}

function extensionsOf(filters) {
  const out = [];
  for (const f of Array.isArray(filters) ? filters : []) {
    for (const e of Array.isArray(f && f.extensions) ? f.extensions : []) {
      const x = String(e).toLowerCase();
      if (x === '*') return [];
      if (!out.includes(x)) out.push(x);
    }
  }
  return out;
}

/**
 * The answers to one flow's dialogs, from one approved request. Records what the flow said
 * (notices, errors) and every question it could not answer, so the request's answer can say what
 * happened. Holds the approver's secrets only for this one run: finish() lets go of them.
 */
class ShellScript {
  /**
   * `checkPath(p)`: null when a path a dialog answers with is in a folder agents may use, otherwise
   * why not (the request's own folder check, run again on the path the dialog really gives, after
   * the file type is added). The endpoint always passes it.
   */
  constructor({ operation, spec, input, answers, secrets, fileExists, checkPath }) {
    this.operation = operation;
    this.spec = spec;
    this.input = input || {};
    this.answers = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
    this.secrets = {};
    for (const [k, v] of Object.entries(secrets && typeof secrets === 'object' ? secrets : {})) if (typeof v === 'string' && v) this.secrets[k] = v;
    this.secretValues = Object.values(this.secrets);
    this.fileExists = fileExists || pathTaken;
    this.checkPath = typeof checkPath === 'function' ? checkPath : () => null;
    this.open = true;
    this.used = { open: false, save: false, password: false, host: false };
    /** What the flow showed as a notice (one button or none). */
    this.notices = [];
    /** What the flow showed as an error box. */
    this.errors = [];
    /** Questions or steps this request had no usable answer for. */
    this.problems = [];
    /** The questions answered, with the button chosen. */
    this.asked = [];
    /** Set when an answer chose a box's cancel button: what stopped the flow. */
    this.stoppedBy = null;
  }

  finish() {
    this.open = false;
    this.secrets = {};
  }

  problem(text) {
    this.problems.push(oneLine(text, 500));
  }

  /** dialog.showMessageBox / showMessageBoxSync. */
  messageBox(args) {
    const opts = dialogOptions(args);
    if (!opts) {
      // Nothing to tell a notice from a question: no button at all (-1), which every flow takes
      // for "no", and the request does not count as done.
      this.problem('Ironbooks showed a message this request could not read, so it stopped there. A person can do this in the Ironbooks window.');
      return { response: -1, checkboxChecked: false };
    }
    const buttons = Array.isArray(opts.buttons) ? opts.buttons.map((b) => String(b)) : [];
    const cancel = cancelOf(buttons, opts.cancelId);
    const quiet = { response: cancel, checkboxChecked: false };
    const said = oneLine(opts.message || opts.title || '', 240);
    if (buttons.length <= 1) {
      // A notice: nothing to decide. What it said goes back with the answer.
      const detail = oneLine(opts.detail || '', 400);
      this.notices.push(detail ? `${said}${/[.!?]$/.test(said) ? '' : '.'} ${detail}` : said);
      return { response: 0, checkboxChecked: false };
    }
    const spec = this.spec || {};
    const q = QUESTIONS.find((x) => sameButtons(x.buttons, buttons));
    if (q && q.fixed && (spec.fixedAnswers || []).includes(q.fixed)) return { response: q.response, checkboxChecked: false };
    if (q && q.approval && (spec.confirmedByApproval || []).includes(q.approval)) return { response: 0, checkboxChecked: false };
    if (!q || !q.id || !(spec.questions || []).includes(q.id)) {
      this.problem(`Ironbooks asked "${said}", which this request has no answer for, so it stopped there. A person can do this in the Ironbooks window.`);
      return quiet;
    }
    const raw = this.answers[q.id];
    let index = -1;
    if (q.kind === 'yes_no') {
      const yes = raw === true || (typeof raw === 'string' && /^(yes|true)$/i.test(raw.trim()));
      const no = raw === false || (typeof raw === 'string' && /^(no|false)$/i.test(raw.trim()));
      index = yes ? 0 : no ? cancel : -1;
    } else if (typeof raw === 'string') {
      const want = raw.trim().toLowerCase();
      index = buttons.findIndex((b) => b.toLowerCase() === want);
    }
    if (raw === undefined || raw === null) {
      this.problem(`Ironbooks needed an answer to "${said}" and the approval gave none, so it stopped there. The agent can ask again; answer that question on the approval card.`);
      return quiet;
    }
    if (index < 0) {
      this.problem(`The answer to "${said}" is not one of its choices (${buttons.join(', ')}), so Ironbooks stopped there. The agent can ask again; choose one of them on the approval card.`);
      return quiet;
    }
    this.asked.push({ id: q.id, answer: buttons[index] });
    if (index === cancel && !this.stoppedBy) this.stoppedBy = `Nothing more was done: the answer to "${said}" was "${buttons[index]}".`;
    return { response: index, checkboxChecked: false };
  }

  /** dialog.showOpenDialog: the input's path, which must exist and be of a kind the dialog offers. */
  openDialog(args) {
    const opts = dialogOptions(args);
    const none = { canceled: true, filePaths: [] };
    if (!opts) {
      this.problem('Ironbooks asked for a file in a way this request could not read, so it stopped there. A person can do this in the Ironbooks window.');
      return none;
    }
    const field = this.spec && this.spec.openDialog;
    const p = field ? this.input[field] : undefined;
    if (!field || typeof p !== 'string' || !p) {
      this.problem(`Ironbooks asked which file to open ("${oneLine(opts.title || opts.message || 'Open', 120)}"), and this request names none.`);
      return none;
    }
    if (this.used.open) {
      this.problem('Ironbooks asked for a second file to open, which this request does not name.');
      return none;
    }
    this.used.open = true;
    const props = Array.isArray(opts.properties) ? opts.properties : [];
    const exts = props.includes('openDirectory') ? [] : extensionsOf(opts.filters);
    if (exts.length && !exts.includes(path.extname(p).slice(1).toLowerCase())) {
      this.problem(`"${oneLine(p, 200)}" is not a file this step opens. It takes ${exts.map((e) => `.${e}`).join(', ')}.`);
      return none;
    }
    const outside = this.checkPath(p);
    if (outside) {
      this.problem(outside);
      return none;
    }
    if (!this.fileExists(p)) {
      this.problem(`There is no file at "${oneLine(p, 200)}".`);
      return none;
    }
    return { canceled: false, filePaths: [p] };
  }

  /**
   * dialog.showSaveDialog: the input's path, with the dialog's file type added when it is missing
   * (as the Save dialog does). That path, the one the flow will write, is checked against the
   * folders agents may use. Never a file that is already there: the dialog would ask the person
   * whether to replace it, and an agent's request never replaces a file.
   */
  saveDialog(args) {
    const opts = dialogOptions(args);
    const none = { canceled: true, filePath: '' };
    if (!opts) {
      this.problem('Ironbooks asked where to save in a way this request could not read, so it stopped there. A person can do this in the Ironbooks window.');
      return none;
    }
    const field = this.spec && this.spec.saveDialog;
    let p = field ? this.input[field] : undefined;
    if (!field || typeof p !== 'string' || !p) {
      this.problem(`Ironbooks asked where to save ("${oneLine(opts.title || opts.message || 'Save', 120)}"), and this request names no place.`);
      return none;
    }
    if (this.used.save) {
      this.problem('Ironbooks asked for a second place to save, which this request does not name.');
      return none;
    }
    this.used.save = true;
    const exts = extensionsOf(opts.filters);
    if (exts.length && !exts.includes(path.extname(p).slice(1).toLowerCase())) p = `${p}.${exts[0]}`;
    const outside = this.checkPath(p);
    if (outside) {
      this.problem(outside);
      return none;
    }
    if (this.fileExists(p)) {
      this.problem(`There is already a file at "${oneLine(p, 200)}". Choose a new name: Ironbooks never replaces a file for an agent.`);
      return none;
    }
    return { canceled: false, filePath: p };
  }

  /** dialog.showErrorBox: recorded, never shown. */
  errorBox(title, content) {
    const t = oneLine(title || '', 160);
    const c = oneLine(content || '', 500);
    this.errors.push(t && c ? `${t}${/[.!?]$/.test(t) ? '' : '.'} ${c}` : t || c || 'Something went wrong.');
  }

  /** The password prompt (electron/passwordPrompt.js): what the approver typed, tried once. */
  async passwordPrompt(opts) {
    const kind = this.spec && this.spec.password;
    const secret = kind ? this.secrets[kind] : undefined;
    if (this.used.password) {
      this.problem('Ironbooks asked for a second password, which this request does not give.');
      return null;
    }
    this.used.password = true;
    if (!secret) {
      this.problem('The file is protected with a password, and the approval gave none. The agent can ask again; type the password it was saved with on the approval card.');
      return null;
    }
    let r;
    try {
      r = await opts.onSubmit(secret);
    } catch (err) {
      this.problem(errorText(err));
      return null;
    }
    if (r && r.ok) return r.value === undefined ? true : r.value;
    this.problem(`${oneLine((r && r.error) || 'That password does not open this file.', 300)} The agent can ask again; type the right password on the approval card.`);
    return null;
  }

  /** The "Open company on host" prompt (electron/connectPrompt.js): the input's address, tried once. */
  async hostPrompt(opts) {
    const field = this.spec && this.spec.hostPrompt;
    const value = field ? this.input[field] : undefined;
    if (!field || typeof value !== 'string' || !value || this.used.host) {
      this.problem('Ironbooks asked for the address of the host computer, and this request names none.');
      return undefined;
    }
    this.used.host = true;
    let r;
    try {
      r = await opts.onSubmit(value);
    } catch (err) {
      this.problem(errorText(err));
      return undefined;
    }
    if (!(r && r.ok)) this.problem((r && r.error) || 'That address did not work.');
    return undefined;
  }
}

/** The script of the flow this code runs in, or null (a person's own dialog). */
function activeScript() {
  const s = scripts.getStore();
  return s && s.open ? s : null;
}

/** Run `fn` with `script` answering its dialogs. The script ends when fn has settled. */
async function runScripted(script, fn) {
  try {
    return await scripts.run(script, fn);
  } finally {
    script.finish();
  }
}

const SCRIPTED = Symbol.for('ironbooks.agentShell.scriptedDialogs');

/**
 * Wrap Electron's dialog module (main.js, once): inside a script a dialog takes the script's
 * answer and nothing opens; outside one, every call goes on to what was there before, unchanged
 * (the person, or the agent service's quiet answers).
 */
function scriptDialogs(dialog) {
  if (!dialog || dialog[SCRIPTED]) return;
  const wrap = (name, scripted) => {
    if (typeof dialog[name] !== 'function') return;
    const before = dialog[name].bind(dialog);
    dialog[name] = (...args) => {
      const s = activeScript();
      return s ? scripted(s, args) : before(...args);
    };
  };
  wrap('showMessageBox', (s, args) => Promise.resolve(s.messageBox(args)));
  wrap('showMessageBoxSync', (s, args) => s.messageBox(args).response);
  wrap('showOpenDialog', (s, args) => Promise.resolve(s.openDialog(args)));
  wrap('showOpenDialogSync', (s, args) => {
    const r = s.openDialog(args);
    return r.canceled ? undefined : r.filePaths;
  });
  wrap('showSaveDialog', (s, args) => Promise.resolve(s.saveDialog(args)));
  wrap('showSaveDialogSync', (s, args) => {
    const r = s.saveDialog(args);
    return r.canceled ? undefined : r.filePath;
  });
  wrap('showErrorBox', (s, args) => {
    s.errorBox(args[0], args[1]);
  });
  dialog[SCRIPTED] = true;
}

/**
 * A prompt window of the shell's own (kind 'password': electron/passwordPrompt.js; 'host':
 * electron/connectPrompt.js) that answers from the script inside one, and opens as before outside.
 */
function scriptedPrompt(kind, real) {
  return (...args) => {
    const s = activeScript();
    if (!s) return real(...args);
    const opts = args[1] && typeof args[1] === 'object' ? args[1] : {};
    return kind === 'password' ? s.passwordPrompt(opts) : s.hostPrompt(opts);
  };
}

// ---------------------------------------------------------------------------
// One request: check, run, answer
// ---------------------------------------------------------------------------

function refuse(error) {
  return { ok: false, result: null, error: oneLine(error, 500), restarting: false };
}

/** Replace every secret of the request wherever it appears in the answer. */
function scrub(value, secrets) {
  const list = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 3);
  if (!list.length) return value;
  const clean = (v) => {
    if (typeof v === 'string') return list.reduce((s, secret) => s.split(secret).join('[hidden]'), v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return clean(value);
}

/**
 * The answer to a flow run. `outcome` is what the flow returned: { done, restarting, result }.
 * A question it could not answer or an error box means it did not work; a flow that did nothing
 * says why (the answer that stopped it, or the notice it showed).
 */
function answerOf(script, outcome, error) {
  const out = outcome && typeof outcome === 'object' ? outcome : {};
  let result = out.result && typeof out.result === 'object' ? { ...out.result } : out.result === undefined ? null : out.result;
  if (script.notices.length) result = { ...(result && typeof result === 'object' ? result : {}), messages: [...script.notices] };
  if (error) return { ok: false, result, error: errorText(error), restarting: false };
  const why = script.problems[0] || script.errors[0];
  if (why) return { ok: false, result, error: why, restarting: Boolean(out.restarting) };
  if (!out.done) return { ok: false, result, error: script.stoppedBy || script.notices[0] || 'Nothing was changed.', restarting: false };
  return { ok: true, result, error: null, restarting: Boolean(out.restarting) };
}

/** The PDF a print request carries, or null. */
function pdfOf(file) {
  if (!file || typeof file !== 'object' || typeof file.base64 !== 'string') return null;
  if (file.base64.length > Math.ceil(MAX_PRINT_BYTES / 3) * 4 + 8) return null;
  const bytes = Buffer.from(file.base64, 'base64');
  if (!isPdf(bytes)) return null;
  return { bytes, name: oneLine(file.name || 'document.pdf', 120) };
}

function isPdf(bytes) {
  return Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-' : false;
}

/**
 * The checking and running of requests, without the endpoint: `handle(line)` resolves the answer.
 * `flows`: operation id → async ({ input, file, script }) => { done, restarting, result }.
 * `folders`: () => the default folders agents may use right now.
 */
function createShellCore({ key, flows, folders = () => [], now = () => Date.now(), pathOptions, fileExists, log = () => {} }) {
  const memory = createReplayMemory();
  const taken = typeof fileExists === 'function' ? fileExists : pathTaken;
  let running = null;

  async function handle(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return refuse('The request could not be read.');
    }
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse('The request could not be read.');
    const { ticket, operation, input } = req;
    const bad = ticketProblem(key, ticket, operation, input, now());
    if (bad) return refuse(bad);
    const spec = Object.prototype.hasOwnProperty.call(OPERATIONS, operation) ? OPERATIONS[operation] : null;
    const flow = spec && flows && typeof flows[operation] === 'function' ? flows[operation] : null;
    if (!flow) return refuse(`This Ironbooks cannot carry out "${oneLine(operation, 80)}".`);
    // One at a time: two flows would answer each other's questions on screen.
    if (running) return refuse('Ironbooks is carrying out another approved request, so it did not start this one. The agent can ask again in a minute.');
    if (!memory.use(ticket, now())) return refuse('This approval was already used, so nothing more was done. The agent can ask again.');
    const wrongInput = inputProblem(spec, input);
    if (wrongInput) return refuse(wrongInput);
    let allowed;
    try {
      allowed = [...(folders() || []), ...(Array.isArray(req.folders) ? req.folders.filter((f) => typeof f === 'string' && f) : [])];
    } catch (err) {
      return refuse(`Ironbooks could not tell which folders agents may use (${errorText(err)}).`);
    }
    for (const [k, f] of Object.entries(spec.fields)) {
      if (f.type !== 'path' || input[k] === undefined || input[k] === null) continue;
      const p = pathProblem(input[k], allowed, pathOptions);
      if (p) return refuse(p);
    }
    if (spec.newFile) {
      // The company file the flow will write, ".ironbooks" added: checked as written, and never
      // one that is there (the save of a copy replaces a file without asking).
      const made = companyFilePath(input[spec.newFile]);
      const p = pathProblem(made, allowed, pathOptions);
      if (p) return refuse(p);
      if (taken(made)) return refuse(`There is already a file at "${oneLine(made, 200)}". Choose a new name: Ironbooks never replaces a file for an agent.`);
    }
    let file = null;
    if (spec.pdf) {
      file = pdfOf(req.file);
      if (!file) return refuse('Only a PDF of up to 1.5 MB can be printed this way, and this request carries none. A person can print a larger one from the Ironbooks window.');
    }
    const script = new ShellScript({
      operation,
      spec,
      input,
      answers: req.answers,
      secrets: req.secrets,
      fileExists: taken,
      checkPath: (p) => pathProblem(p, allowed, pathOptions),
    });
    const secrets = script.secretValues;
    let outcome;
    let error = null;
    running = operation;
    try {
      outcome = await runScripted(script, () => flow({ input, file, script }));
    } catch (err) {
      error = err;
    } finally {
      running = null;
    }
    const answer = scrub(answerOf(script, outcome, error), secrets);
    script.secretValues = [];
    log(`${operation}: ${answer.ok ? (answer.restarting ? 'done, restarting' : 'done') : `not done: ${answer.error}`}`);
    return answer;
  }

  return {
    handle,
    memory,
    get running() {
      return running;
    },
  };
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

/** A fresh, unguessable place to listen: a named pipe on Windows, a socket in a private folder elsewhere. */
function newEndpointPath({ platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  const name = crypto.randomBytes(16).toString('hex');
  if (platform === 'win32') return { path: `\\\\.\\pipe\\ironbooks-agent-shell-${name}`, dir: null };
  // mkdtemp makes the folder readable by this account only (0700).
  const dir = fs.mkdtempSync(path.join(tmpdir, 'ironbooks-shell-'));
  return { path: path.join(dir, 'agent.sock'), dir };
}

/** One connection: read one line, answer it, close. */
function serveConnection(socket, core, log) {
  const chunks = [];
  let size = 0;
  let settled = false;
  const reply = (answer) => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
  };
  socket.on('error', () => {
    /* the server went away: nothing to tell */
  });
  // One deadline from the moment the connection was accepted, never pushed back by more data.
  const deadline = setTimeout(() => {
    if (!settled) socket.destroy();
  }, READ_TIMEOUT_MS);
  socket.on('close', () => clearTimeout(deadline));
  socket.on('data', (chunk) => {
    if (settled) return;
    const nl = chunk.indexOf(0x0a);
    const part = nl < 0 ? chunk : chunk.subarray(0, nl);
    size += part.length;
    if (size > MAX_LINE_BYTES) {
      settled = true;
      clearTimeout(deadline);
      chunks.length = 0;
      reply(refuse('The request is too large.'));
      return;
    }
    chunks.push(part);
    if (nl < 0) return;
    settled = true;
    clearTimeout(deadline);
    const line = Buffer.concat(chunks).toString('utf8');
    chunks.length = 0;
    core.handle(line).then(reply, (err) => {
      log(`a request failed: ${errorText(err)}`);
      reply(refuse('Ironbooks could not carry out the request.'));
    });
  });
}

/**
 * Open the endpoint. Resolves nothing: `ready` settles once it listens. `env` is what the company
 * server gets: { endpoint, key }. Options are those of createShellCore, plus `platform` and
 * `tmpdir` for where to listen.
 */
function openEndpoint(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const key = typeof opts.key === 'string' && opts.key ? opts.key : crypto.randomBytes(32).toString('hex');
  const where = newEndpointPath({ platform: opts.platform, tmpdir: opts.tmpdir });
  const core = createShellCore({ ...opts, key, log });
  const server = net.createServer((socket) => serveConnection(socket, core, log));
  server.maxConnections = 8;
  const ready = new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  ready.catch((err) => log(`could not open the endpoint for agent requests: ${errorText(err)}`));
  // Kept for the endpoint's whole life: an 'error' event with no listener would end the app.
  server.on('error', () => {});
  server.listen(where.path, () => {
    if (where.dir) {
      try {
        fs.chmodSync(where.path, 0o600);
      } catch {
        /* the private folder already keeps others out */
      }
    }
  });
  let closed = null;
  return {
    env: { endpoint: where.path, key },
    ready,
    core,
    close() {
      if (!closed) {
        closed = new Promise((resolve) => {
          server.close(() => resolve());
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        }).then(() => {
          if (where.dir) fs.rmSync(where.dir, { recursive: true, force: true });
        });
      }
      return closed;
    },
  };
}

// ---------------------------------------------------------------------------
// Printing (D10): a PDF from a hidden window, with no print dialog
// ---------------------------------------------------------------------------

function printFailure(why) {
  const w = String(why || '').toLowerCase();
  if (w.includes('cancel')) return 'The printer stopped the job.';
  if (w.includes('no valid printers')) return 'This computer has no printer to print on.';
  return 'The job could not be sent to the printer.';
}

/**
 * What the print window may load: the PDF itself (data:), and what Chromium's PDF viewer draws it
 * with (its chrome-extension: and chrome: pages, blob:, about:blank). Nothing on any network, and
 * no file on the disk.
 */
const PRINT_PROTOCOLS = new Set(['data:', 'blob:', 'chrome-extension:', 'chrome:', 'about:']);

function printRequestAllowed(url) {
  try {
    return PRINT_PROTOCOLS.has(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

const lockedPrintSessions = new WeakSet();

/**
 * Hold the print window's session to what electron/security.js holds the app's own session to
 * (it sets up only the default session): no request off the list above, no permission ever
 * granted, no download. A session that cannot be held so is not printed from.
 */
function lockPrintSession(ses) {
  const ok =
    ses &&
    typeof ses === 'object' &&
    ses.webRequest &&
    typeof ses.webRequest.onBeforeRequest === 'function' &&
    typeof ses.setPermissionRequestHandler === 'function' &&
    typeof ses.setPermissionCheckHandler === 'function';
  if (!ok) throw new Error('The job was not sent to the printer: Ironbooks could not keep the print window off the network.');
  if (lockedPrintSessions.has(ses)) return;
  ses.webRequest.onBeforeRequest((details, callback) => callback(printRequestAllowed(details && details.url) ? {} : { cancel: true }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  if (typeof ses.on === 'function') ses.on('will-download', (event) => event.preventDefault());
  lockedPrintSessions.add(ses);
}

/**
 * Print `bytes` (a PDF) silently on `printer` (null: the default printer). Electron is passed in
 * (`BrowserWindow`). The window is never shown, keeps to a session of its own (none of the app's
 * cookies) held off the network (lockPrintSession), loads the PDF from a data: address (nothing is
 * written to disk, and no window loads a file:// page), and is destroyed whatever happens.
 */
async function printPdf({ BrowserWindow, bytes, printer = null, copies = 1, settleMs = 1500 }) {
  if (!isPdf(bytes)) throw new Error('Only a PDF can be printed this way.');
  if (bytes.length > MAX_PRINT_BYTES) {
    throw new Error('This PDF is too large to print without a person (at most 1.5 MB). A person can print it from the Ironbooks window.');
  }
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new Error(`The number of copies must be a whole number from 1 to ${MAX_COPIES}.`);
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: 'ironbooks-agent-print',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        plugins: true,
        spellcheck: false,
      },
    });
    // Before anything loads.
    lockPrintSession(win.webContents && win.webContents.session);
    await win.loadURL(`data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`);
    let deviceName;
    if (printer) {
      const list = await win.webContents.getPrintersAsync();
      const want = String(printer).trim().toLowerCase();
      const found = (list || []).find((p) => String(p.name).toLowerCase() === want || String(p.displayName || '').toLowerCase() === want);
      if (!found) throw new Error(`There is no printer called "${oneLine(printer, 80)}" on this computer.`);
      deviceName = found.name;
    }
    // The PDF viewer draws the pages after the load finishes.
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    await new Promise((resolve, reject) => {
      win.webContents.print({ silent: true, printBackground: true, deviceName, copies }, (ok, why) => (ok ? resolve() : reject(new Error(printFailure(why)))));
    });
    return { printed: true, printer: deviceName || null, copies };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

// ---------------------------------------------------------------------------
// The desktop notice when an agent asks (plan 7.2; lib/desktop/agentNotice.ts)
// ---------------------------------------------------------------------------

/** Pages a notice may open: the approval center, or one request in it. */
const NOTICE_ROUTE = /^\/agent-requests(?:\/[A-Za-z0-9_-]{1,64})?$/;

/** Title and body as one plain line each, and the page to open (the approval center unless it is one of its own). */
function cleanNotice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = oneLine(raw.title, 80);
  if (!title) return null;
  const href = typeof raw.href === 'string' && NOTICE_ROUTE.test(raw.href) ? raw.href : '/agent-requests';
  return { title, body: oneLine(raw.body, 240), href };
}

/** Notices on screen, kept until clicked or closed (one that is collected forgets its click). */
const shownNotices = new Set();

/**
 * Show the notice unless the window is in front. Electron is passed in (`Notification`); `open`
 * brings the window forward on the page. True when it was shown.
 */
function showNotice({ Notification, win, notice, open }) {
  const n = cleanNotice(notice);
  if (!n) return false;
  if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.isFocused()) return false;
  if (typeof Notification !== 'function') return false;
  if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return false;
  const shown = new Notification({ title: n.title, body: n.body });
  const forget = () => shownNotices.delete(shown);
  shown.on('click', () => {
    forget();
    if (typeof open === 'function') open(n.href);
  });
  shown.on('close', forget);
  shownNotices.add(shown);
  if (shownNotices.size > 20) shownNotices.delete(shownNotices.values().next().value);
  shown.show();
  return true;
}

module.exports = {
  ENDPOINT_ENV,
  KEY_ENV,
  TICKET_SECONDS,
  OUTBOX_NAME,
  MAX_LINE_BYTES,
  OPERATIONS,
  QUESTIONS,
  stableJson,
  inputHash,
  ticketProblem,
  createReplayMemory,
  defaultFolders,
  cleanPath,
  windowsFold,
  insideFolder,
  pathProblem,
  companyFilePath,
  inputProblem,
  dialogOptions,
  ShellScript,
  runScripted,
  activeScript,
  scriptDialogs,
  scriptedPrompt,
  answerOf,
  scrub,
  createShellCore,
  newEndpointPath,
  openEndpoint,
  isPdf,
  printRequestAllowed,
  printPdf,
  cleanNotice,
  showNotice,
};
