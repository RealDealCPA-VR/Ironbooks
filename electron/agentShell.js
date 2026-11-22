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
//    approver, an expiry two minutes ahead, and a hash of everything else the shell acts on: the
//    approver's answers, the folders the Admin allowed, the file that comes with it and which
//    secrets were typed (lib/agent/shellTicket.ts). It sends ONE JSON line:
//    { ticket, operation, input, answers, folders, sealed? }. `sealed` holds what must stay private
//    (the approver's passwords, a print job's PDF): AES-256-GCM with a key derived from the launch
//    key, tied to the ticket, so whoever might sit between the server and the shell reads nothing of
//    it and cannot swap it.
//  - Here, before anything runs: the ticket must be good for exactly this operation, input,
//    answers, folders and file, and must not have been seen before (a ticket is used once, and a
//    replay is refused); the input must be what the operation takes; every path in it must be
//    inside a folder agents may use (the open company file's folder, Documents\Ironbooks and its
//    Agent Outbox, plus the folders the Admin added for the agent, which the line carries from the
//    policy). A drive or share root (a USB stick's E:\, a mapped drive's Q:\, \\server\share, on
//    macOS and Linux a mounted volume's top folder such as /Volumes/USB or /media/pat/USB, and a
//    disk mounted into a folder) is never such a folder: a company file kept there leaves only the
//    Documents folders. Neither is a share of this very computer (\\localhost\c$, a loopback
//    address, its own name: isThisComputerShare), through which Ironbooks' own folders are there
//    under another name. Anything
//    unexpected is refused: fail closed. A path is a file strictly inside such a folder (never the
//    folder itself), checked as the disk has it (links followed, names exactly as the disk spells
//    them); the company file a flow will write (".ironbooks" added) is checked too, and must not be
//    there yet. A host an agent asks to join must not be this computer itself, nor a virtual
//    machine or container it runs (joinProblem).
//  - Then the operation runs the same flow the File menu runs (electron/main.js), inside a SCRIPT:
//    every native dialog the flow would show takes its answer from the request instead of opening.
//    A dialog's options are read as Electron reads them (window first, or none). File pickers get
//    the input's paths (checked again as the dialog gives them), questions the approver's answers
//    from the approval card, a password prompt what the approver typed there. A question with no
//    answer is answered the way Cancel would answer it, and the request fails naming the question.
//    A button that would switch to a company file nobody approved by its path ("Save a Copy and
//    Open It") is never pressed for an agent, whatever the answer says. Nothing ever waits on screen. The script follows the flow's own async work (AsyncLocalStorage)
//    and ends with it: a dialog shown by anything else, at any other moment, goes to the person
//    exactly as before.
//  - One JSON line goes back: { ok, result, error, restarting, mac }. Never a secret, never the
//    ticket. `mac` is an HMAC with the launch key over the answer and the ticket's MAC: the server
//    never takes an answer that does not check out for "done".
//
// The endpoint itself (openEndpoint):
//  - Windows: a named pipe with 128 random bits in its name. Node (libuv) creates its first
//    instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so listening fails (EADDRINUSE) when anything
//    already holds the name: no second server can take it, and this one never shares it. The pipe
//    gets Windows' default security for a named pipe: full control for this Windows account, SYSTEM
//    and Administrators, read-only for other accounts. Read-only is no way in: every connection is
//    its own pipe instance, so another account reads nothing of anyone else's requests, cannot write
//    one, and cannot make an instance of its own. Node offers no way to set a narrower list, so a
//    program running as this same Windows account could make a second instance with native code;
//    against that the ticket's MAC (nothing it changes is carried out), the sealed part (it reads no
//    password or PDF) and the signed answer (it cannot make the server believe a result) hold. That
//    part can only be checked in the running app (test/agentShell.test.ts checks what Node does).
//    What read-only access still allows: another account that finds the name (pipe names can be
//    listed) can open connections that send nothing and so hold the endpoint's few connections
//    (MAX_CONNECTIONS); approvals then fail as "not answering", and nothing runs. A connection that
//    stays silent is closed after FIRST_BYTE_MS, so such a program has to keep reconnecting.
//  - Elsewhere: a Unix socket in a folder only this account can open (mkdtemp, 0700), itself 0600.
//
// Plain Node, no Electron import: the ticket check, the replay memory, the path check, the
// scripted dialogs and the endpoint itself are driven by test/agentShell.test.ts with fake flows.
// main.js passes in what needs Electron (the dialog module, the flows, BrowserWindow, Notification).

'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const hostingCore = require('./hostingCore');

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
/**
 * A request line: the input plus, for printing, that PDF sealed (base64 inside the sealed JSON,
 * base64 again on the line: about 2.7 MB for the largest) and room for the rest.
 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/**
 * How long a connection has, from the moment it is accepted, to send its whole line (the server
 * writes it at once). Counted from the start, not from the last byte: a program that trickles a
 * byte at a time cannot hold the endpoint's few connections for long.
 */
const READ_TIMEOUT_MS = 10_000;
/**
 * How long a connection may stay silent before it is closed. The server writes its line the moment
 * it connects, so a connection that sends nothing is something else holding one of the endpoint's
 * few connections (another Windows account may connect read-only): it lets go of it quickly.
 */
const FIRST_BYTE_MS = 2_000;
/** Connections the endpoint holds at once; more are closed as they arrive. */
const MAX_CONNECTIONS = 8;
const MAX_COPIES = 100;

const TICKET_LABEL = 'ironbooks-shell-ticket/2';
const ANSWER_LABEL = 'ironbooks-shell-answer/1';
const SEAL_INFO = 'ironbooks-shell-private/1';
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

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function inputHash(input) {
  return sha256Hex(Buffer.from(stableJson(input === undefined ? null : input), 'utf8'));
}

/** The file of a request as the ticket covers it: name, type and a sha256 of the bytes (shellFileRef). */
function fileRef(file) {
  if (!file || typeof file !== 'object') return null;
  const bytes = Buffer.from(typeof file.base64 === 'string' ? file.base64 : '', 'base64');
  return { name: String(file.name ?? ''), type: String(file.type ?? ''), sha256: sha256Hex(bytes) };
}

/** sha256 of everything else the shell acts on, with the same defaults as shellBoundHash. */
function boundHash(bound) {
  const b = bound && typeof bound === 'object' ? bound : {};
  const kinds = Array.isArray(b.secrets) ? b.secrets.map((k) => String(k)).sort() : [];
  const text = stableJson({ answers: b.answers ?? {}, folders: b.folders ?? [], file: b.file ?? null, secrets: kinds });
  return sha256Hex(Buffer.from(text, 'utf8'));
}

function ticketMac(key, t, bound) {
  const message = JSON.stringify([TICKET_LABEL, t.requestId, t.operation, t.inputHash, t.approverId, t.expiresAt, boundHash(bound)]);
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

function sealKey(key) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(key, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32));
}

/** Seal what must stay private for this ticket (lib/agent/shellTicket.ts sealShellPrivate). */
function sealPrivate(key, mac, priv) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealKey(key), iv);
  cipher.setAAD(Buffer.from(mac, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(priv), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
}

/** What was sealed for this ticket with this key, or null (openShellPrivate). */
function openPrivate(key, mac, sealed) {
  if (!sealed || typeof sealed !== 'object' || typeof key !== 'string' || !key) return null;
  if (typeof sealed.iv !== 'string' || !/^[0-9a-f]{24}$/.test(sealed.iv) || typeof sealed.tag !== 'string' || !/^[0-9a-f]{32}$/.test(sealed.tag)) return null;
  if (typeof sealed.data !== 'string') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey(key), Buffer.from(sealed.iv, 'hex'));
    decipher.setAAD(Buffer.from(String(mac), 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The HMAC of an answer to the request whose ticket has `mac` (shellAnswerMac). */
function answerMac(key, mac, answer) {
  const text = stableJson({ ok: answer.ok, result: answer.result, error: answer.error, restarting: answer.restarting });
  return crypto.createHmac('sha256', String(key || '')).update(JSON.stringify([ANSWER_LABEL, String(mac), text]), 'utf8').digest('hex');
}

/** The answer as it goes on the line: its JSON form, with its HMAC. */
function signAnswer(key, mac, answer) {
  const sent = JSON.parse(JSON.stringify({ ok: answer.ok, result: answer.result, error: answer.error, restarting: answer.restarting }));
  return { ...sent, mac: answerMac(key, mac, sent) };
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

const NO_KEY =
  'This Ironbooks has no key for approval tickets, so it cannot carry out approved requests. Restart Ironbooks, then have the agent ask again.';
const UNREADABLE_TICKET = 'The approval ticket could not be read, so nothing was done. The agent can ask again.';
const NOT_OURS =
  'The approval ticket was not made by this Ironbooks for exactly what came with it, so nothing was done. Requests are approved in the Ironbooks window; the agent can ask again.';

/**
 * Null when `ticket` is good for exactly this operation, input and `bound` (answers, folders,
 * file, secret kinds), otherwise why not. A request that fails is final (plan 7.2): the way on is a
 * new request, so the messages say "ask again".
 */
function ticketProblem(key, ticket, operation, input, now = Date.now(), bound = null) {
  if (typeof key !== 'string' || !key) return NO_KEY;
  if (!readableTicket(ticket)) return UNREADABLE_TICKET;
  // The MAC first: until it checks out, nothing else in the ticket can be believed.
  if (!sameHex(ticketMac(key, ticket, bound), ticket.mac)) return NOT_OURS;
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

// ---- A share of this very computer (lib/agent/files.ts isThisComputerShare, ported: the shell
// cannot import TypeScript; test/agentShell.test.ts holds the port to that rule's own table of
// cases, lib/agent/thisComputerShares.json) ----

/** "\\?\UNC\server\share\…", "\\.\UNC\…" and "\??\UNC\…": a share written as a device path (lib/agent/files.ts DEVICE_UNC). */
const DEVICE_UNC = /^(?:[\\/]{2}[?.][\\/]|\\\?\?\\)UNC(?=[\\/]|$)/i;

/**
 * The server a UNC path names ("\\SERVER\share\…" gives "SERVER"), as written, also when it is
 * written as a device path ("\\?\UNC\SERVER\share\…"); null for any other path (lib/agent/files.ts
 * uncServer; the caller says whether this is Windows).
 */
function uncServer(p) {
  const s = DEVICE_UNC.test(p) ? `\\\\${p.replace(DEVICE_UNC, '').replace(/^[\\/]+/, '')}` : p;
  if (DEVICE_PATH.test(s)) return null;
  const m = /^[\\/]{2}([^\\/]*)/.exec(s);
  return m ? m[1] : null;
}

/**
 * A server name as the name service may take it, for a refusal only: compatibility forms folded
 * (a full-width "ｌｏｃａｌｈｏｓｔ" is "localhost" once the system maps it), the other full stops a
 * name may be written with as ".", lower case.
 */
function looseHost(s) {
  return String(s).normalize('NFKC').replace(/[。．｡]/g, '.').toLowerCase();
}

/**
 * An IPv4 address in any spelling the system takes ("127.0.0.1", "127.1", "0x7f.1", "0177.0.0.1",
 * "2130706433"), as its 32-bit number; null for anything else.
 */
function ipv4Number(s) {
  const parts = s.split('.');
  if (parts.length > 4) return null;
  const nums = [];
  for (const part of parts) {
    let n;
    if (/^0x[0-9a-f]*$/i.test(part)) n = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) n = part.length === 1 ? 0 : parseInt(part.slice(1), 8);
    else if (/^[1-9][0-9]*$/.test(part)) n = parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255)) return null;
  const room = 2 ** (8 * (4 - nums.length));
  if (last >= room) return null;
  return nums.reduce((v, n) => v * 256 + n, 0) * room + last;
}

/**
 * An IPv6 address as its eight 16-bit groups: "::1", "[::1]", "0:0:0:0:0:0:0:1", with a zone or an
 * IPv4 tail, and Windows' own UNC spelling of one ("0--1.ipv6-literal.net"). Null for anything else.
 */
function ipv6Groups(s) {
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
  const groups = (x) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array(missing).fill('0'), ...rest].map((g) => parseInt(g, 16));
}

/** An address in one spelling for comparing ("v4:2130706433", "v6:0:0:0:0:0:0:0:1"), or null for a name. */
function addressKey(host) {
  const v4 = ipv4Number(host);
  if (v4 !== null) return `v4:${v4}`;
  const g = ipv6Groups(host);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && g[6] !== 0))) return `v4:${g[6] * 65536 + g[7]}`;
  return `v6:${g.join(':')}`;
}

/** This computer itself: 127.0.0.0/8, 0.0.0.0/8 (the system connects 0.0.0.0 here), ::1 and ::. */
function isLoopbackKey(k) {
  if (k.startsWith('v4:')) {
    const first = Math.floor(Number(k.slice(3)) / 2 ** 24);
    return first === 127 || first === 0;
  }
  return k === 'v6:0:0:0:0:0:0:0:1' || k === 'v6:0:0:0:0:0:0:0:0';
}

/** This computer's own addresses (every network adapter's), as addressKey spells them. Nothing is sent. */
function ownAddressKeys(interfaces) {
  const out = new Set();
  try {
    for (const list of Object.values(interfaces() || {})) {
      for (const a of Array.isArray(list) ? list : []) {
        const k = a && a.address ? addressKey(looseHost(a.address)) : null;
        if (k) out.add(k);
      }
    }
  } catch {
    /* none known: names and loopback still count */
  }
  return out;
}

/** This computer's own names (its host name and its Windows computer name), first label only. */
function ownNames(env, hostname) {
  const names = [env && env.COMPUTERNAME];
  try {
    names.push(hostname());
  } catch {
    /* the computer name from the environment still counts */
  }
  return names.map((n) => looseHost(typeof n === 'string' ? n.trim() : '').split('.')[0]).filter((n) => !!n);
}

/**
 * On Windows, a UNC path whose server is this very computer: "localhost" and every name under
 * ".localhost" (WSL's "wsl.localhost" too), "wsl$", a loopback address in any spelling (127.1,
 * 0x7f000001, ::1, [::1], 0--1.ipv6-literal.net), one of this computer's own addresses, or its own
 * name (with any domain after it). Through such a share Ironbooks' own folders, the books and the
 * agents' staged files are there under another name (\\localhost\c$\Users\…\AppData), so it is
 * never a folder agents may use, whoever named it: the same rule as the company server's
 * (lib/agent/files.ts) and the connector's (mcp/files-tools.mjs). Judged by the words alone:
 * nothing is looked up and nothing is looked at. The share may be written as a device path
 * ("\\?\UNC\localhost\c$", which cleanPath refuses anyway), the server with spaces or dots around
 * it, or in Windows' offline-files spelling ("localhost$NOCSC$"). False for every path that is no
 * UNC path, every other device path included ("\\?\GLOBALROOT\Device\Mup\localhost\c$" may reach
 * this computer's share as well: cleanPath refuses every device path by the words first), and on
 * other systems. `opts` are for tests: another system, environment, adapters or host name.
 */
function isThisComputerShare(p, { platform = process.platform, env = process.env, interfaces = () => os.networkInterfaces(), hostname = () => os.hostname() } = {}) {
  if (typeof p !== 'string' || platform !== 'win32') return false;
  const raw = uncServer(p.trim());
  if (raw === null) return false;
  // "server@SSL@443" (a WebDAV share) is on that same server, and so is "server$NOCSC$" (Windows'
  // offline files reaching it directly); trailing dots, and spaces either side, leave the same
  // name, in any order (a refusal errs on the side of refusing).
  let host = looseHost(raw.split('@')[0]).trim();
  for (let before = ''; before !== host; ) {
    before = host;
    host = host.replace(/[.\s]+$/, '').replace(/\$nocsc\$$/, '').trim();
  }
  // No server at all is no share anyone can name: refused as well.
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'wsl$') return true;
  const k = addressKey(host);
  if (k) return isLoopbackKey(k) || ownAddressKeys(interfaces).has(k);
  return ownNames(env, hostname).includes(host.split('.')[0]);
}

/**
 * On macOS and Linux, by the words: the top folder of a mounted volume, or a folder that holds
 * mounted volumes. macOS mounts a USB stick or an office share at /Volumes/<name> (and its own data
 * volume at /System/Volumes/Data); Linux at /media/<user>/<name> (older systems /media/<name>),
 * /run/media/<user>/<name> or /mnt/<name> (WSL's /mnt/c is the whole C: drive). Compared without
 * regard to case, as macOS's disks mostly are. A folder one level further down /media is refused
 * too (on a system that mounts at /media/<name> it is a folder on the stick): that only ever refuses
 * more.
 */
function posixVolumeTop(resolved) {
  const parts = resolved.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (!parts.length) return true;
  if (parts[0] === 'volumes' || parts[0] === 'mnt') return parts.length <= 2;
  if (parts[0] === 'media') return parts.length <= 3;
  if (parts[0] === 'run' && parts[1] === 'media') return parts.length <= 4;
  if (parts[0] === 'system' && parts[1] === 'volumes') return parts.length <= 3;
  return false;
}

/**
 * `p` is the top of a drive or a share: "E:\" (a USB stick, a mapped drive letter, C:\ itself),
 * "\\server\share", "/", or on macOS and Linux a mounted volume's top folder (posixVolumeTop:
 * /Volumes/USB, /media/pat/USB, /mnt/c). Such a folder is never one agents may use: it would hand
 * them the whole drive, share or volume.
 */
function driveOrShareRoot(p, platform = process.platform) {
  if (typeof p !== 'string' || !p) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const resolved = P.resolve(p);
  if (resolved === P.parse(resolved).root) return true;
  return platform !== 'win32' && posixVolumeTop(resolved);
}

/**
 * The folders agents may use without the Admin naming them: the open company file's folder, and
 * Documents\Ironbooks with its Agent Outbox. A company file at the top of a drive or share (a USB
 * stick's E:\Books.ironbooks, a mapped Q:\, \\office\books\Books.ironbooks) adds no folder of its
 * own: only the Documents ones apply.
 */
function defaultFolders({ companyFile, documents, platform = process.platform } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  if (typeof companyFile === 'string' && companyFile) {
    const dir = P.dirname(P.resolve(companyFile));
    if (!driveOrShareRoot(dir, platform)) out.push(dir);
  }
  if (typeof documents === 'string' && documents) {
    out.push(P.join(documents, 'Ironbooks'));
    out.push(P.join(documents, 'Ironbooks', OUTBOX_NAME));
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
 * the disk itself (realpath spells every existing name as the disk does). Never when either is on
 * a share of this very computer (isThisComputerShare; `share` are its options): through one, a
 * folder "inside" an allowed share can be any folder on this computer.
 */
function insideFolder(child, parent, platform, { exact = false, share = {} } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const shareOpts = { ...share, platform };
  if (isThisComputerShare(child, shareOpts) || isThisComputerShare(parent, shareOpts)) return false;
  const key = (p) => (platform === 'win32' && !exact ? windowsFold(p) : p);
  const c = key(child);
  let p = key(parent);
  if (!p.endsWith(P.sep)) p += P.sep;
  return c.length > p.length && c.startsWith(p);
}

const REAL_FS = {
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync.native(p),
  stat: (p) => fs.statSync(p),
};

/**
 * `real` (a real path) is a volume mounted as a folder: on another device than the folder it sits
 * in (a disk mounted into a folder, /Volumes/USB, a share mounted under a name of its own). The top
 * of such a volume is never a folder agents may use, as the top of a drive is not (lib/agent/files.ts
 * isVolumeRoot does the same). A folder that is not there yet is no mount point; one the disk will
 * not say anything about counts as one (fail closed). Without `stat` (a test's own disk), nothing.
 */
function mountedVolumeTop(real, platform, fsx) {
  if (!fsx || typeof fsx.stat !== 'function') return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const parent = P.dirname(real);
  if (parent === real) return true;
  let here;
  try {
    here = fsx.stat(real);
  } catch (err) {
    return !(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR'));
  }
  try {
    const up = fsx.stat(parent);
    return Boolean(here && up && here.dev && up.dev && here.dev !== up.dev);
  } catch {
    return true;
  }
}

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
 * does not exist yet must then be spelled exactly as the allowed folder is. A share of this very
 * computer (\\localhost\c$\…, \\127.0.0.1\…, \\<its own name>\…) is never such a place, as typed or
 * as the disk has it (a drive mapped to one): refused before it is looked at. `env`, `interfaces`
 * and `hostname` are isThisComputerShare's (tests pass their own).
 */
function pathProblem(raw, allowed, { platform = process.platform, fs: fsx = REAL_FS, env, interfaces, hostname } = {}) {
  const shown = oneLine(raw, 200);
  const want = cleanPath(raw, platform);
  if (!want) {
    const start = platform === 'win32' ? 'with the drive (C:\\…)' : 'with /';
    return `"${shown}" is not a full path to a place on this computer. Give the whole path, starting ${start}.`;
  }
  const share = { platform, ...(env ? { env } : {}), ...(interfaces ? { interfaces } : {}), ...(hostname ? { hostname } : {}) };
  const thisComputer =
    `"${shown}" reaches this computer through one of its own network shares, so it was refused: through such a share, ` +
    "Ironbooks' own folders are there under another name. Give the file's own path on this computer instead (starting with " +
    'the drive, like C:\\…), in a folder agents may use.';
  if (isThisComputerShare(want, share)) return thisComputer;
  // The top of a drive or a share is never a folder agents may use, whoever named it; nor is a
  // share of this very computer.
  const bases = (Array.isArray(allowed) ? allowed : [])
    .map((a) => cleanPath(a, platform))
    .filter((b) => b && !driveOrShareRoot(b, platform) && !isThisComputerShare(b, share));
  const outside =
    `"${shown}" is not in a folder agents may use on this computer. Use the company file's folder, Documents\\Ironbooks, ` +
    "or a folder the Admin added in the agent's settings, and name a file inside it.";
  const candidates = bases.filter((b) => insideFolder(want, b, platform, { share }));
  if (!candidates.length) return outside;
  if (!fsx) return null;
  const real = onDisk(want, platform, fsx);
  // As the disk has it, the place may be on a share of this computer (a link to \\localhost\c$).
  if (real && isThisComputerShare(real, share)) return thisComputer;
  let wholeDisk = false;
  if (real && candidates.some((b) => {
    const base = onDisk(b, platform, fsx);
    if (!base || isThisComputerShare(base, share) || !insideFolder(real, base, platform, { exact: true, share })) return false;
    // A folder that is a link to the top of a drive or share, or that is the top of a volume
    // mounted as a folder, is refused like the top itself.
    if (driveOrShareRoot(base, platform) || mountedVolumeTop(base, platform, fsx)) {
      wholeDisk = true;
      return false;
    }
    return true;
  })) {
    return null;
  }
  if (wholeDisk) {
    return (
      `"${shown}" is in a folder that is the top of a whole drive, share or disk (on the disk it is one, or leads to one), which ` +
      "agents never use, so it was refused. Use the company file's folder, Documents\\Ironbooks, or a folder inside that drive the Admin added."
    );
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
// The host an agent asks to join (shell.hosting.connect)
// ---------------------------------------------------------------------------

/** How long a look-up of the host's name may take before the join is refused. */
const LOOKUP_MS = 5000;

const REAL_NETWORK = {
  interfaces: () => os.networkInterfaces(),
  hostname: () => os.hostname(),
  lookup: (name) => dns.promises.lookup(name, { all: true, verbatim: true }),
};

/** An address as compared here: lower case, no brackets, no zone ("%eth0"), IPv4 as itself. */
function plainAddress(a) {
  return hostingCore.unmapAddress(String(a || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '')).replace(/\.$/, '');
}

/** Every address of this computer (every network adapter, its own loopback too), and the "any" addresses. */
function ownAddresses(interfaces) {
  const out = new Set(['0.0.0.0', '::']);
  let list = {};
  try {
    list = interfaces() || {};
  } catch {
    list = {};
  }
  for (const entries of Object.values(list)) {
    for (const e of Array.isArray(entries) ? entries : []) if (e && e.address) out.add(plainAddress(e.address));
  }
  return out;
}

function isIpAddress(host) {
  return hostingCore.parseIPv4(host) !== null || host.includes(':');
}

/**
 * The adapters this computer has for virtual machines and containers it runs: WSL and Hyper-V's
 * switches ("vEthernet (WSL)", "vEthernet (Default Switch)"), Docker, VirtualBox, VMware,
 * Parallels, libvirt and LXC. What answers on their networks runs on this computer (an agent
 * inside WSL, say), behind an address of its own. Known by the adapter's name, or by the maker
 * part of its hardware address when the name says nothing (a Hyper-V switch someone named).
 */
const VIRTUAL_ADAPTER_NAME = /^(?:vEthernet\b|VirtualBox\b|VMware\b|vboxnet\d|vmnet\d|docker\d|docker_gwbridge|br-[0-9a-f]{6,}|virbr\d|lxcbr\d|lxdbr\d|podman\d|cni\d|cni-|flannel|vnic\d|bridge1\d\d)/i;
/**
 * Hyper-V, VirtualBox (guest and host-only), VMware, Parallels, QEMU/KVM. Not Docker's 02:42: a
 * Wi-Fi adapter's random hardware address may start that way too, and Docker's bridges are known
 * by their names.
 */
const VIRTUAL_MAC_PREFIXES = ['00:15:5d:', '08:00:27:', '0a:00:27:', '00:50:56:', '00:0c:29:', '00:05:69:', '00:1c:14:', '00:1c:42:', '52:54:00:'];
/**
 * A virtual network is taken as at least this wide (and /24, or /64, when its mask cannot be
 * read): WSL and Hyper-V use a /20, Docker a /16. Never wider, so an odd mask never turns a whole
 * private range (an office network included) into "this computer".
 */
const MIN_VIRTUAL_PREFIX_V4 = 16;
const MIN_VIRTUAL_PREFIX_V6 = 48;

function isVirtualAdapter(name, entry) {
  if (VIRTUAL_ADAPTER_NAME.test(String(name || ''))) return true;
  const mac = String((entry && entry.mac) || '').toLowerCase().replace(/-/g, ':');
  return VIRTUAL_MAC_PREFIXES.some((p) => mac.startsWith(p));
}

/** An IPv6 address as its eight 16-bit words, or null when it is not one. */
function ipv6Words(a) {
  let s = String(a || '').toLowerCase();
  if (!net.isIPv6(s)) return null;
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = hostingCore.parseIPv4(v4[2]);
    if (n === null) return null;
    s = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (h) => (h ? h.split(':') : []);
  const left = words(halves[0]);
  const right = halves.length === 2 ? words(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  const all = [...left, ...Array(Math.max(fill, 0)).fill('0'), ...right];
  if (all.length !== 8 || all.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  return all.map((w) => parseInt(w, 16));
}

function sameIPv6Prefix(a, b, bits) {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(bits, 16);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

/** The prefix length an interface entry says (its netmask, else its cidr), or null. */
function entryPrefix(e, v4) {
  if (v4) {
    const bits = hostingCore.maskBits(e.netmask);
    if (bits !== null) return bits;
  }
  const n = typeof e.cidr === 'string' ? Number(e.cidr.split('/')[1]) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= (v4 ? 32 : 128) ? n : null;
}

/**
 * The networks of this computer's virtual adapters (isVirtualAdapter): [{ v4, base, prefix }].
 * Link-local addresses are left out (the window never joins one anyway).
 */
function virtualNetworks(interfaces) {
  let list = {};
  try {
    list = interfaces() || {};
  } catch {
    list = {};
  }
  const out = [];
  for (const [name, entries] of Object.entries(list)) {
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !e.address || e.internal || !isVirtualAdapter(name, e)) continue;
      const address = plainAddress(e.address);
      const v4 = hostingCore.parseIPv4(address);
      if (v4 !== null) {
        const p = entryPrefix(e, true);
        out.push({ v4: true, base: address, prefix: p === null ? 24 : Math.max(p, MIN_VIRTUAL_PREFIX_V4) });
        continue;
      }
      const w = ipv6Words(address);
      if (!w || (w[0] & 0xffc0) === 0xfe80) continue;
      const p = entryPrefix(e, false);
      out.push({ v4: false, base: w, prefix: p === null ? 64 : Math.max(p, MIN_VIRTUAL_PREFIX_V6) });
    }
  }
  return out;
}

/** True when `host` (an address) is on one of the networks of this computer's virtual adapters. */
function onVirtualNetwork(host, networks) {
  const v4 = hostingCore.subnetKey(host, 32) !== null;
  const w = v4 ? null : ipv6Words(host);
  return networks.some((n) => {
    if (n.v4 !== v4) return false;
    if (v4) return hostingCore.subnetKey(host, n.prefix) === hostingCore.subnetKey(n.base, n.prefix);
    return Boolean(w) && sameIPv6Prefix(w, n.base, n.prefix);
  });
}

/**
 * Null when an agent may ask to join the multi-user host at `raw`, otherwise why not. Joining
 * makes the Ironbooks window close the books open here, restart, and show the pages the program at
 * that address serves, with this window's trust, where people then type their passwords: so it is
 * never this computer itself, where that program could be anything, the agent included. Refused:
 * what the window would refuse anyway (normalizeHostAddress: only this office network or a
 * tailnet), localhost and every loopback address, this computer's own addresses (each network
 * adapter's, its Tailscale address too) and name, an address on the network of one of its virtual
 * adapters (a WSL, Hyper-V or Docker guest is a program on this computer one hop removed:
 * virtualNetworks), and a name that leads to any of them now (it is looked up; a name that cannot
 * be looked up is refused). A Hyper-V switch shared with the office network (an "external" switch)
 * counts as virtual too, whatever it is named: no adapter is let off by its name, since a virtual
 * machine's network can be named anything (fail closed). An agent then cannot join a host on that
 * network; a person still can, from File > Open company on host.
 */
async function joinProblem(raw, network = REAL_NETWORK) {
  const net0 = { ...REAL_NETWORK, ...(network || {}) };
  const shown = oneLine(raw, 120);
  const n = hostingCore.normalizeHostAddress(raw);
  if (!n.ok) return `${oneLine(n.error, 240)} Ironbooks did not join "${shown}". The agent can ask again with the address the host computer's Company > Multi-user page shows.`;
  const host = plainAddress(n.host);
  const self =
    `"${shown}" is this computer itself, so Ironbooks did not join it. Joining a host makes the Ironbooks window show the pages ` +
    'of the program at that address instead of its own, so an agent may only join another computer that hosts the company file. ' +
    "The agent can ask again with the address the host computer's Company > Multi-user page shows.";
  const guest =
    `"${shown}" is a virtual machine or container running on this computer (such as WSL, Hyper-V, Docker or VirtualBox), so ` +
    'Ironbooks did not join it. Joining a host makes the Ironbooks window show the pages of the program at that address instead ' +
    'of its own, so an agent may only join another computer that hosts the company file. If that address really is your host ' +
    'computer, a person can join it from File > Open company on host.';
  if (hostingCore.classifyAddress(host) === 'loopback') return self;
  const own = ownAddresses(net0.interfaces);
  if (own.has(host)) return self;
  const guests = virtualNetworks(net0.interfaces);
  if (isIpAddress(host)) return onVirtualNetwork(host, guests) ? guest : null;
  let me = '';
  try {
    me = String(net0.hostname() || '').trim().toLowerCase();
  } catch {
    me = '';
  }
  if (me && (host === me || host.startsWith(`${me}.`))) return self;
  let found = null;
  let timer = null;
  try {
    found = await Promise.race([
      Promise.resolve().then(() => net0.lookup(host)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), LOOKUP_MS);
      }),
    ]);
  } catch {
    found = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const addresses = (Array.isArray(found) ? found : found ? [found] : []).map((a) => plainAddress(a && typeof a === 'object' ? a.address : a)).filter(Boolean);
  if (!addresses.length) {
    return `Ironbooks could not look up "${shown}", so it did not join it. Check the address on the host computer's Company > Multi-user page; the agent can ask again.`;
  }
  if (addresses.some((a) => hostingCore.classifyAddress(a) === 'loopback' || own.has(a))) return self;
  if (addresses.some((a) => onVirtualNetwork(a, guests))) return guest;
  return null;
}

// ---------------------------------------------------------------------------
// The operations the shell carries out (lib/agent/operations/shell.ts, runner 'electron')
// ---------------------------------------------------------------------------
//
// fields: the input it takes. saveDialog / openDialog: the input field a Save / Open dialog takes
// its answer from. newFile: the input field naming a company file the flow writes (".ironbooks"
// added when missing), which must not be there yet. password: the secret a password prompt takes.
// hostPrompt: the field the "Open company on host" prompt takes; joinHost: the field naming a host
// to join, which must not be this computer (joinProblem). questions: the flow questions
// (QUESTIONS) the approver may answer. confirmedByApproval: the flow's own "do it?" question,
// answered yes by the approval itself. pdf: a PDF comes with the request.

const PATH_FIELD = { type: 'path', required: true };

const OPERATIONS = Object.freeze({
  'shell.company.new': { fields: { file: PATH_FIELD }, saveDialog: 'file', newFile: 'file', questions: ['temporaryFolder', 'cloudFolder'] },
  'shell.company.open': { fields: { file: PATH_FIELD }, openDialog: 'file', questions: ['temporaryFolder', 'cloudFolder'] },
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
    questions: ['openNow', 'temporaryFolder', 'cloudFolder'],
  },
  'shell.sandbox.enter': { fields: {}, questions: [] },
  'shell.sandbox.leave': { fields: {}, questions: [] },
  'shell.hosting.start': { fields: { network: { type: 'string', required: true, oneOf: ['office', 'tailnet'] } }, questions: [] },
  'shell.hosting.stop': { fields: {}, questions: ['disconnectOthers'] },
  'shell.hosting.connect': { fields: { host: { type: 'string', required: true } }, hostPrompt: 'host', joinHost: 'host', questions: [] },
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
 * "Save a Copy and Open It" copies the company file into Documents under a name the window picks
 * and switches to that copy: a company file nobody approved by its path. An agent's request never
 * switches the open company file by itself, so that button is never pressed for one.
 */
const SAVE_A_COPY = 'Save a Copy and Open It';

/**
 * The message boxes the flows can show with more than one button, known by their buttons (the
 * message itself names files and people). `id`: the flow question the approver answers
 * (lib/agent/operations/shell.ts); `refused`: its buttons an agent's request never presses, even
 * when the answer names one. `approval`: the operation's own "do it?", answered yes by the
 * approval. `fixed`: a notice whose second button is never the agent's to press ("Show in Folder").
 * `stop`: a box whose only way on is a button an agent's request never presses: answered with its
 * cancel button, and the request fails with `why`. Yes is always the first button; no and Cancel
 * are the box's own cancel button.
 */
const QUESTIONS = Object.freeze([
  { id: 'temporaryFolder', kind: 'choice', buttons: [SAVE_A_COPY, 'Open It Here Anyway', 'Cancel'], refused: [SAVE_A_COPY] },
  {
    stop: 'readOnlyFile',
    buttons: [SAVE_A_COPY, 'Cancel'],
    why:
      'Ironbooks cannot work in a read-only company file, and for an agent it never makes a copy somewhere else and opens that, ' +
      'so nothing was opened. A person can open it from File > Open or Restore Company and choose "Save a Copy and Open It", ' +
      'or make the file writable and have the agent ask again.',
  },
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
    if (q && q.stop) {
      this.problem(`${said}${/[.!?]$/.test(said) ? '' : '.'} ${q.why}`);
      return quiet;
    }
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
    const offered = buttons.filter((b) => !(q.refused || []).includes(b));
    if (index >= 0 && (q.refused || []).includes(buttons[index])) {
      this.problem(
        `The answer to "${said}" was "${buttons[index]}", which an agent's request never chooses: it would switch to a copy of ` +
          `the company file nobody approved. Nothing was opened. The agent can ask again; choose ${offered.map((b) => `"${b}"`).join(' or ')} ` +
          'on the approval card, or a person can open the file from the Ironbooks window.',
      );
      return quiet;
    }
    if (index < 0) {
      this.problem(`The answer to "${said}" is not one of its choices (${offered.join(', ')}), so Ironbooks stopped there. The agent can ask again; choose one of them on the approval card.`);
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

const UNREADABLE_REQUEST = 'The request could not be read, so nothing was done. The agent can ask again.';

/**
 * The checking and running of requests, without the endpoint: `handle(line)` resolves the answer
 * as it goes on the line (signed: signAnswer). `flows`: operation id → async ({ input, file,
 * script }) => { done, restarting, result }. `folders`: () => the default folders agents may use
 * right now. `network`: how a host to join is looked at (joinProblem; tests pass their own).
 */
function createShellCore({ key, flows, folders = () => [], now = () => Date.now(), pathOptions, fileExists, network, log = () => {} }) {
  const memory = createReplayMemory();
  const taken = typeof fileExists === 'function' ? fileExists : pathTaken;
  let running = null;

  /** One request, checked and run: the answer before it is signed. */
  async function run(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) return refuse(UNREADABLE_REQUEST);
    const { ticket, operation, input } = req;
    // Passwords and files only ever travel sealed: a line that carries them in the open was not
    // made by this Ironbooks's server.
    if (Object.prototype.hasOwnProperty.call(req, 'secrets') || Object.prototype.hasOwnProperty.call(req, 'file')) return refuse(UNREADABLE_REQUEST);
    if (typeof key !== 'string' || !key) return refuse(NO_KEY);
    if (!readableTicket(ticket)) return refuse(UNREADABLE_TICKET);
    let priv = {};
    if (req.sealed !== undefined) {
      priv = openPrivate(key, ticket.mac, req.sealed);
      if (!priv) return refuse(NOT_OURS);
    }
    const secretsIn = priv.secrets && typeof priv.secrets === 'object' && !Array.isArray(priv.secrets) ? priv.secrets : {};
    const fileIn = priv.file && typeof priv.file === 'object' ? priv.file : null;
    // The MAC covers everything the shell acts on, exactly as it came.
    const bound = { answers: req.answers, folders: req.folders, file: fileRef(fileIn), secrets: Object.keys(secretsIn) };
    const bad = ticketProblem(key, ticket, operation, input, now(), bound);
    if (bad) return refuse(bad);
    // Used once, from here on, whatever happens next: an approval never runs twice.
    if (!memory.use(ticket, now())) return refuse('This approval was already used, so nothing more was done. The agent can ask again.');
    const spec = Object.prototype.hasOwnProperty.call(OPERATIONS, operation) ? OPERATIONS[operation] : null;
    const flow = spec && flows && typeof flows[operation] === 'function' ? flows[operation] : null;
    if (!flow) return refuse(`This Ironbooks cannot carry out "${oneLine(operation, 80)}".`);
    // One at a time: two flows would answer each other's questions on screen.
    if (running) return refuse('Ironbooks is carrying out another approved request, so it did not start this one. The agent can ask again in a minute.');
    running = operation;
    try {
      const wrongInput = inputProblem(spec, input);
      if (wrongInput) return refuse(wrongInput);
      if (req.answers !== undefined && (!req.answers || typeof req.answers !== 'object' || Array.isArray(req.answers))) return refuse(UNREADABLE_REQUEST);
      if (req.folders !== undefined && !Array.isArray(req.folders)) return refuse(UNREADABLE_REQUEST);
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
      if (spec.joinHost) {
        const p = await joinProblem(input[spec.joinHost], network);
        if (p) return refuse(p);
      }
      let file = null;
      if (spec.pdf) {
        file = pdfOf(fileIn);
        if (!file) return refuse('Only a PDF of up to 1.5 MB can be printed this way, and this request carries none. A person can print a larger one from the Ironbooks window.');
      }
      const script = new ShellScript({
        operation,
        spec,
        input,
        answers: req.answers,
        secrets: secretsIn,
        fileExists: taken,
        checkPath: (p) => pathProblem(p, allowed, pathOptions),
      });
      const secrets = script.secretValues;
      let outcome;
      let error = null;
      try {
        outcome = await runScripted(script, () => flow({ input, file, script }));
      } catch (err) {
        error = err;
      }
      const answer = scrub(answerOf(script, outcome, error), secrets);
      script.secretValues = [];
      // The log has the operation and the plain outcome only: never the input's secrets (scrubbed above).
      log(`${operation}: ${answer.ok ? (answer.restarting ? 'done, restarting' : 'done') : `not done: ${answer.error}`}`);
      return answer;
    } finally {
      running = null;
    }
  }

  async function handle(line) {
    let req = null;
    try {
      req = JSON.parse(line);
    } catch {
      req = null;
    }
    const mac = req && typeof req === 'object' && req.ticket && typeof req.ticket.mac === 'string' && HEX64.test(req.ticket.mac) ? req.ticket.mac : '';
    let answer;
    try {
      answer = await run(req);
    } catch (err) {
      log(`a request failed: ${errorText(err)}`);
      answer = refuse('Ironbooks could not carry out the request.');
    }
    return signAnswer(key, mac, answer);
  }

  return {
    handle,
    /** An answer this endpoint gives without reading a request (one too large): signed all the same. */
    sign: (answer, mac = '') => signAnswer(key, mac, answer),
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
function serveConnection(socket, core, log, firstByteMs = FIRST_BYTE_MS) {
  const chunks = [];
  let size = 0;
  let settled = false;
  let heard = false;
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
  // A connection that says nothing at all is let go much sooner. When the time is up, what already
  // arrived is read first (setImmediate runs after the reads waiting in this turn), so a busy moment
  // in this process never costs the server's real request.
  const quiet = setTimeout(() => {
    setImmediate(() => {
      if (!heard && !settled) socket.destroy();
    });
  }, firstByteMs);
  socket.on('close', () => {
    clearTimeout(deadline);
    clearTimeout(quiet);
  });
  socket.on('data', (chunk) => {
    if (!heard) {
      heard = true;
      clearTimeout(quiet);
    }
    if (settled) return;
    const nl = chunk.indexOf(0x0a);
    const part = nl < 0 ? chunk : chunk.subarray(0, nl);
    size += part.length;
    if (size > MAX_LINE_BYTES) {
      settled = true;
      clearTimeout(deadline);
      chunks.length = 0;
      reply(core.sign(refuse('The request is too large.')));
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
      reply(core.sign(refuse('Ironbooks could not carry out the request.')));
    });
  });
}

/**
 * Open the endpoint. Resolves nothing: `ready` settles once it listens. `env` is what the company
 * server gets: { endpoint, key }. Options are those of createShellCore, plus `platform` and
 * `tmpdir` for where to listen and `firstByteMs` (tests: how long a silent connection is kept).
 */
function openEndpoint(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const key = typeof opts.key === 'string' && opts.key ? opts.key : crypto.randomBytes(32).toString('hex');
  const where = newEndpointPath({ platform: opts.platform, tmpdir: opts.tmpdir });
  const core = createShellCore({ ...opts, key, log });
  const firstByteMs = Number.isInteger(opts.firstByteMs) && opts.firstByteMs > 0 ? Math.min(opts.firstByteMs, FIRST_BYTE_MS) : FIRST_BYTE_MS;
  const server = net.createServer((socket) => serveConnection(socket, core, log, firstByteMs));
  server.maxConnections = MAX_CONNECTIONS;
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
const NOTICE_HOME = '/agent-requests';
/** A request's id as a notice may carry it (the same shape as a request's page in NOTICE_ROUTE). */
const NOTICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `v` when it is a request id a notice may carry, else null. */
function noticeId(v) {
  return typeof v === 'string' && NOTICE_ID.test(v) ? v : null;
}

/**
 * Title and body as one plain line each, the page to open (the approval center unless it is one of
 * its own), and `id`, the request the notice is for, when it says (showNotice announces each once).
 */
function cleanNotice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = oneLine(raw.title, 80);
  if (!title) return null;
  const href = typeof raw.href === 'string' && NOTICE_ROUTE.test(raw.href) ? raw.href : NOTICE_HOME;
  const id = noticeId(raw.id);
  return { title, body: oneLine(raw.body, 240), href, ...(id ? { id } : {}) };
}

/**
 * The notice, worded here from what the app's own server answers for the title bar's count
 * (GET /api/agent-requests/count, AgentRequestCount): the newest request's agent name and the
 * summary the server built from the operation, never the agent's own words and never any text the
 * page sends. `count` null (the server could not be asked): a notice that names nothing. `href`:
 * the page the page asked to open, only when it is one of the approval center's own.
 *
 * `askedId`: the request the window found new (its own read of the same route). This read comes a
 * moment after the window's, so a request that arrives or is decided in between can make the
 * server's newest another one: the agent and the summary are then never named (they would be the
 * other request's), only the plain words. Without `askedId` (an older window), the newest one of
 * this read is named. The notice carries the id of the request it is for, so showNotice announces
 * each request once.
 */
function noticeFromCount(count, href, askedId) {
  const c = count && typeof count === 'object' ? count : {};
  const read = c.newest && typeof c.newest === 'object' ? c.newest : null;
  const asked = noticeId(askedId);
  const readId = read ? noticeId(read.id) : null;
  // Named only when this read's newest is the request the window found (or the window did not say).
  const newest = read && (asked === null || asked === readId) ? read : null;
  const pending = Number.isInteger(c.pending) && c.pending > 0 ? c.pending : 0;
  const name = newest ? oneLine(newest.agentName, 60) : '';
  const summary = newest ? oneLine(newest.summary, 180).replace(/[.\s]+$/u, '') : '';
  const waiting = pending > 1 ? ` ${pending} requests are waiting.` : '';
  const it = pending > 1 ? 'them' : 'it';
  return cleanNotice({
    title: name ? `${name} asks for your approval` : 'An agent asks for your approval',
    body: summary ? `${summary}.${waiting} Click to review ${it}.` : `A request is waiting in Agent requests.${waiting} Click to review ${it}.`,
    href: typeof href === 'string' ? href : NOTICE_HOME,
    id: asked ?? (newest ? readId : null),
  });
}

/** Bring the window forward (out of the taskbar, the tray or behind others) and open `route` in it. */
function showWindowOn(win, route, navigate) {
  if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
    if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  if (typeof navigate === 'function') navigate(NOTICE_ROUTE.test(String(route)) ? route : NOTICE_HOME);
}

/** Notices on screen, kept until clicked or closed (one that is collected forgets its click). */
const shownNotices = new Set();
/**
 * The requests a notice was shown for (their ids, the latest few hundred): each is announced once,
 * also when the window asks again for it (a reload of the page, or a later poll that finds as new
 * a request this app already named because it arrived while the window was asking for another).
 */
const announcedNotices = new Set();
const ANNOUNCED_MAX = 500;

/**
 * Show the notice unless the window is in front (a minimized, hidden or covered window is not), or
 * a notice was already shown for the request it is for (its `id`). Electron is passed in
 * (`Notification`); `open` brings the window forward on the page (showWindowOn). True when it was
 * shown.
 */
function showNotice({ Notification, win, notice, open }) {
  const n = cleanNotice(notice);
  if (!n) return false;
  if (n.id && announcedNotices.has(n.id)) return false;
  if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed() && win.isFocused()) return false;
  if (typeof Notification !== 'function') return false;
  if (typeof Notification.isSupported === 'function' && !Notification.isSupported()) return false;
  if (n.id) {
    announcedNotices.add(n.id);
    if (announcedNotices.size > ANNOUNCED_MAX) announcedNotices.delete(announcedNotices.values().next().value);
  }
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
  FIRST_BYTE_MS,
  MAX_CONNECTIONS,
  OPERATIONS,
  QUESTIONS,
  stableJson,
  inputHash,
  fileRef,
  boundHash,
  ticketProblem,
  sealPrivate,
  openPrivate,
  answerMac,
  signAnswer,
  createReplayMemory,
  driveOrShareRoot,
  defaultFolders,
  cleanPath,
  windowsFold,
  isThisComputerShare,
  insideFolder,
  pathProblem,
  companyFilePath,
  joinProblem,
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
  noticeFromCount,
  showWindowOn,
  showNotice,
};
