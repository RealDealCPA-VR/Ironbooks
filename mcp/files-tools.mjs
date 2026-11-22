/**
 * Files in and out (plan §5.7): the agent hands Ironbooks a file, gets one back, or has a person
 * save one to a folder.
 *
 *  - upload_file: a file the agent holds, as base64. It goes to Ironbooks in parts of
 *    UPLOAD_CHUNK_BYTES through the upload_file verb and comes back as a file id, which any
 *    operation that takes a file accepts as { "fileId": "<id>" }. At most UPLOAD_MAX_BYTES.
 *  - attach_local_file: a file on this computer the agent names by its path. The connector reads
 *    it itself (it runs on the same computer as the agent's client), but only when the file, once
 *    every link and ".." is resolved, is inside one of the folders an Admin opened to this agent
 *    (get_my_permissions lists them), and not inside a folder Ironbooks keeps for itself
 *    (ironbooksFolders: its settings, the working copies of company files, staged agent files),
 *    even when an opened folder holds one, under any spelling of it (case, short names, trailing
 *    dots). A path through a share of this very computer (\\localhost\c$\…, \\127.1\…, its own
 *    name: isThisComputerShare) is never read, nor is such a folder ever one the agent may use:
 *    through it Ironbooks' own folders are there under another name. Anywhere else it is refused
 *    before the file is opened, and every refusal is written to the connector's log. A missing file is said to be missing
 *    only where it would be inside an allowed folder, so nothing is learnt about what exists
 *    elsewhere. A network share is looked at only when an allowed folder is on it: merely touching
 *    a share makes Windows offer it this person's sign-in. The file is read with the size cap
 *    held all the way (readUpTo), even when it grows while it is read.
 *  - get_file: a staged file's content: an image as an image, text as text, anything else as an
 *    embedded resource with its bytes in base64.
 *  - save_file: writes a staged file to an allowed folder. That is the 'file' class: a person
 *    always approves it (the save_file verb asks).
 *
 * The folder rules here follow lib/agent/files.ts allowedFolder, which Ironbooks applies to
 * save_file and the shell's paths. This file cannot import it: the connector is plain JavaScript.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENDPOINT_DIR_ENV, LOST_ANSWER_MESSAGE, TOKEN_FILE_ENV, endpointDir } from './client.mjs';
import { ToolContent, ToolError } from './protocol.mjs';
import { REQUEST_ID, settleLong, verb } from './operations-tools.mjs';

/** One part of an upload, and the whole of one (lib/agent/contract.ts UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES). */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** How long Ironbooks keeps a staged file (lib/agent/contract.ts STAGED_FILE_HOURS). */
export const STAGED_FILE_HOURS = 24;

export const FILE_URI_PREFIX = 'ironbooks://files/';

const MB = 1024 * 1024;
const WIN = process.platform === 'win32';
/** \\?\…, \\.\… and \??\…: device and raw namespace paths, never a file an agent may use. */
const DEVICE_PATH = /^(?:[\\/]{2}[?.](?:[\\/]|$)|\\\?\?\\)/;
/** Names Windows keeps for devices, with or without an extension (lib/agent/files.ts DEVICE_NAME). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu;
const PATH_MAX = 1024;
/** The longest folder save_file sends (lib/agent/operate.ts save_file: at most 1000). */
const SAVE_FOLDER_MAX = 1000;
const MAX_LINK_HOPS = 32;

/** As long as the door takes one (lib/agent/operate.ts get_file, save_file: at most 64). */
const FILE_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$', patternHint: 'must be a file_id an answer gave you' };
const FILE_NAME = {
  type: 'string',
  maxLength: 255,
  pattern: '^[^\\\\/\\u0000-\\u001f]+$',
  patternHint: 'must be a file name without folders, for example "statement-2026-03.pdf"',
};
/** A media type, as long as the door's upload takes one (lib/agent/operate.ts upload_file: at most 200). */
const MIME = {
  type: 'string',
  maxLength: 200,
  pattern: '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$',
  patternHint: 'must be a media type like application/pdf or text/csv',
};

/** @param {object} properties @param {string[]} [required] */
function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Media types by extension, for a local file whose type the agent did not give. */
const TYPES = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
  '.qbo': 'application/vnd.intu.qbo',
  '.qfx': 'application/vnd.intu.qfx',
  '.ofx': 'application/x-ofx',
  '.iif': 'text/plain',
};
export const typeOf = (/** @type {string} */ name) => TYPES[/** @type {keyof typeof TYPES} */ (path.extname(name).toLowerCase())] ?? 'application/octet-stream';

const sizeWords = (/** @type {number} */ bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const TOO_LARGE = (/** @type {number} */ bytes) =>
  `The file is ${sizeWords(bytes)}; at most ${UPLOAD_MAX_BYTES / MB} MB can be handed to Ironbooks. Nothing was uploaded.`;
const OVER_CAP = `The file is over ${UPLOAD_MAX_BYTES / MB} MB; at most ${UPLOAD_MAX_BYTES / MB} MB can be handed to Ironbooks. Nothing was uploaded.`;
/**
 * The longest base64 text upload_file takes: the file at its largest, plus line breaks (a CR LF
 * every 64 characters, the densest common wrapping, adds 3.2%) and some room for padding.
 */
export const BASE64_MAX_CHARS = Math.ceil((Math.ceil(UPLOAD_MAX_BYTES / 3) * 4 * 66) / 64) + 4096;

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

/** A staged file in the tools' words (lib/agent/contract.ts StagedFile). */
export function fileRow(/** @type {any} */ f) {
  return { file_id: f.fileId, name: f.name, type: f.type, size: f.size };
}

/**
 * Hand bytes to Ironbooks in parts of UPLOAD_CHUNK_BYTES (the upload_file verb). Returns the staged file.
 * @param {any} client
 * @param {{ name: string, type: string, bytes: Uint8Array }} file
 */
export async function uploadBytes(client, file) {
  const total = file.bytes.byteLength;
  if (total === 0) throw new ToolError('The file is empty. Nothing was uploaded.');
  if (total > UPLOAD_MAX_BYTES) throw new ToolError(TOO_LARGE(total));
  /** @type {string | undefined} */
  let uploadId;
  for (let offset = 0; offset < total; offset += UPLOAD_CHUNK_BYTES) {
    const part = file.bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, total));
    const last = offset + part.byteLength >= total;
    let res;
    try {
      res = await verb(client, 'upload_file', { uploadId, name: file.name, type: file.type, chunkBase64: Buffer.from(part).toString('base64'), last });
    } catch (err) {
      // A part whose answer was lost cannot be sent again: the upload has to start over.
      if (err instanceof Error && err.message === LOST_ANSWER_MESSAGE) throw new ToolError('The upload was cut off. Nothing was kept; upload the file again.');
      throw err;
    }
    if (typeof res?.received === 'number' && res.received !== offset + part.byteLength) {
      throw new ToolError('The file did not arrive whole. Nothing was kept; upload it again.');
    }
    if (last) {
      if (!res?.file?.fileId) throw new ToolError('Ironbooks did not confirm the upload. Upload the file again.');
      return res.file;
    }
    uploadId = typeof res?.uploadId === 'string' ? res.uploadId : undefined;
    if (!uploadId) throw new ToolError('Ironbooks did not start the upload. Try again.');
  }
  throw new ToolError('Nothing was uploaded.');
}

/** What an upload's answer says. */
function uploaded(/** @type {any} */ f) {
  return {
    ...fileRow(f),
    said: `Handed to Ironbooks. Where an operation takes a file, give { "fileId": "${f.fileId}" }. It is kept for ${STAGED_FILE_HOURS} hours.`,
  };
}

/** Base64 as the agent sent it, as bytes; null when it is not base64. */
export function decodeBase64(/** @type {string} */ text) {
  const clean = text.replace(/[\r\n\t ]/g, '');
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
}

// ---------------------------------------------------------------------------
// A file on this computer, only from the folders an Admin opened to the agent
// ---------------------------------------------------------------------------

/**
 * A name as Windows compares names (lib/agent/files.ts windowsFold): each character in upper case
 * when that is still one character, as NTFS does. Not lower case: "K" (the Kelvin sign) lowers to
 * "k" but is a name of its own on the disk.
 * @param {string} s
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
 * On Windows, the share a UNC path is on, as "\\SERVER\SHARE" folded the way Windows compares
 * names; '' for a UNC path without a share; null for any other path (and always on other systems).
 * @param {string} p
 */
function uncShare(p) {
  if (!WIN || !/^[\\/]{2}/.test(p) || DEVICE_PATH.test(p)) return null;
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
  return m ? windowsFold(`\\\\${m[1]}\\${m[2]}`) : '';
}

const key = (/** @type {string} */ p) => (WIN ? windowsFold(p) : p);

// ---------------------------------------------------------------------------
// A share of this very computer (lib/agent/files.ts isThisComputerShare, ported: the connector
// cannot import TypeScript; test/mcp/files.test.ts holds the two to lib/agent/thisComputerShares.json)
// ---------------------------------------------------------------------------

/** "\\?\UNC\server\share\…", "\\.\UNC\…" and "\??\UNC\…": a share written as a device path (lib/agent/files.ts DEVICE_UNC). */
const DEVICE_UNC = /^(?:[\\/]{2}[?.][\\/]|\\\?\?\\)UNC(?=[\\/]|$)/i;

/**
 * The server a UNC path names ("\\SERVER\share\…" gives "SERVER"), as written, also when it is
 * written as a device path ("\\?\UNC\SERVER\share\…"); null for any other path (lib/agent/files.ts
 * uncServer; the caller says whether this is Windows).
 * @param {string} p
 * @returns {string | null}
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
 * @param {string} s
 */
function looseHost(s) {
  return s.normalize('NFKC').replace(/[\u3002\uff0e\uff61]/g, '.').toLowerCase();
}

/**
 * An IPv4 address in any spelling the system takes ("127.0.0.1", "127.1", "0x7f.1", "0177.0.0.1",
 * "2130706433"), as its 32-bit number; null for anything else.
 * @param {string} s
 * @returns {number | null}
 */
function ipv4Number(s) {
  const parts = s.split('.');
  if (parts.length > 4) return null;
  /** @type {number[]} */
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
  const last = /** @type {number} */ (nums.pop());
  if (nums.some((n) => n > 255)) return null;
  const room = 2 ** (8 * (4 - nums.length));
  if (last >= room) return null;
  return nums.reduce((v, n) => v * 256 + n, 0) * room + last;
}

/**
 * An IPv6 address as its eight 16-bit groups: "::1", "[::1]", "0:0:0:0:0:0:0:1", with a zone or an
 * IPv4 tail, and Windows' own UNC spelling of one ("0--1.ipv6-literal.net"). Null for anything else.
 * @param {string} s
 * @returns {number[] | null}
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
  const groups = (/** @type {string} */ x) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array(missing).fill('0'), ...rest].map((g) => parseInt(g, 16));
}

/** An address in one spelling for comparing ("v4:2130706433", "v6:0:0:0:0:0:0:0:1"), or null for a name. */
function addressKey(/** @type {string} */ host) {
  const v4 = ipv4Number(host);
  if (v4 !== null) return `v4:${v4}`;
  const g = ipv6Groups(host);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || (g[5] === 0 && g[6] !== 0))) return `v4:${g[6] * 65536 + g[7]}`;
  return `v6:${g.join(':')}`;
}

/** This computer itself: 127.0.0.0/8, 0.0.0.0/8, ::1 and ::. */
function isLoopbackKey(/** @type {string} */ k) {
  if (k.startsWith('v4:')) {
    const first = Math.floor(Number(k.slice(3)) / 2 ** 24);
    return first === 127 || first === 0;
  }
  return k === 'v6:0:0:0:0:0:0:0:1' || k === 'v6:0:0:0:0:0:0:0:0';
}

/** This computer's own addresses (every network card's), as addressKey spells them. Nothing is sent. */
function ownAddressKeys() {
  const out = new Set();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        const k = addressKey(looseHost(a.address));
        if (k) out.add(k);
      }
    }
  } catch {
    /* none known: names and loopback still count */
  }
  return out;
}

/** This computer's own names (its host name and its Windows computer name), first label only. */
function ownNames(/** @type {Record<string, string | undefined>} */ env) {
  /** @type {Array<string | undefined>} */
  const names = [env.COMPUTERNAME];
  try {
    names.push(os.hostname());
  } catch {
    /* the computer name from the environment still counts */
  }
  return names.map((n) => looseHost(n?.trim() ?? '').split('.')[0]).filter((n) => !!n);
}

/**
 * A path whose server is this very computer, on Windows: "localhost" and every name under
 * ".localhost", "wsl$", a loopback address in any spelling (127.1, 0x7f000001, ::1, [::1],
 * 0--1.ipv6-literal.net), one of this computer's own addresses, or its own name (with any domain
 * after it). Through such a share Ironbooks' own folders, the books and other agents' files are
 * there under another name, so it is never a folder an agent may read from. Judged by the words
 * alone: nothing is looked up and nothing is looked at. The share may be written as a device path
 * ("\\?\UNC\localhost\c$", which readAllowedFile refuses anyway), and the server with spaces or
 * dots around it. False for every path that is no UNC path, and on other systems. `opts` are for
 * tests: another system, another environment.
 * @param {unknown} p
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [opts]
 */
export function isThisComputerShare(p, opts = {}) {
  if (typeof p !== 'string' || (opts.platform ?? process.platform) !== 'win32') return false;
  const raw = uncServer(p.trim());
  if (raw === null) return false;
  // "server@SSL@443" (a WebDAV share) is on that same server; trailing dots, and spaces either
  // side, leave the same name (a refusal errs on the side of refusing).
  const host = looseHost(raw.split('@')[0]).trim().replace(/[.\s]+$/, '');
  // No server at all is no share anyone can name: refused as well.
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'wsl$') return true;
  const k = addressKey(host);
  if (k) return isLoopbackKey(k) || ownAddressKeys().has(k);
  return ownNames(opts.env ?? process.env).includes(host.split('.')[0]);
}

/** `child` is strictly inside `parent` (case-insensitive on Windows). */
function inside(/** @type {string} */ child, /** @type {string} */ parent) {
  let p = key(parent);
  if (!p.endsWith(path.sep)) p += path.sep;
  return key(child).startsWith(p) && key(child) !== key(parent);
}

/**
 * A path as given, made absolute and normalised (".." resolved), or null when it is not a plain
 * full path: relative, too long, with control characters, a device path, or (Windows) a stream
 * ("file:stream") or a device name ("CON") along the way.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function plainPath(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p || p.length > PATH_MAX || /[\p{Cc}]/u.test(p) || DEVICE_PATH.test(p)) return null;
  if (WIN) {
    const share = uncShare(p);
    if (share === '' || (share === null && !/^[A-Za-z]:[\\/]/.test(p))) return null;
  } else if (!path.isAbsolute(p)) {
    return null;
  }
  const resolved = path.resolve(p);
  if (WIN) {
    const rest = resolved.slice(path.parse(resolved).root.length);
    if (rest.includes(':') || rest.split(path.sep).some((part) => DEVICE_NAME.test(part))) return null;
  }
  return resolved;
}

/**
 * Follow the links along `start` one part at a time without opening their targets, and refuse a
 * link that leads to a device path or to a network share not in `shares`.
 *
 * `at` is where the path leads with every link on the way followed. When a part is missing, it is
 * the place reached so far with the missing part and the rest added as given: that is where the
 * file would be, so the caller can tell "missing in an allowed folder" from "missing somewhere
 * else" without being fooled by a link that leads out. Null when a link was refused. `found` is
 * the part that exists (links followed), `missing` the parts after it that do not.
 * @param {string} start @param {ReadonlySet<string>} shares
 * @returns {Promise<{ ok: boolean, at: string | null, found: string, missing: string[] }>}
 */
async function walkLinks(start, shares) {
  const split = (/** @type {string} */ p) => {
    const root = path.parse(p).root;
    return { root, rest: p.slice(root.length).split(path.sep).filter(Boolean) };
  };
  let { root, rest } = split(start);
  let current = root;
  let hops = 0;
  const refused = { ok: false, at: null, found: '', missing: [] };
  while (rest.length) {
    const part = /** @type {string} */ (rest.shift());
    const next = path.join(current, part);
    let st;
    try {
      st = await fsp.lstat(next);
    } catch {
      return { ok: false, at: path.join(next, ...rest), found: current, missing: [part, ...rest] };
    }
    if (!st.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return refused;
    let target;
    try {
      target = await fsp.readlink(next);
    } catch {
      return refused;
    }
    const abs = path.resolve(current, target);
    if (DEVICE_PATH.test(abs)) return refused;
    const share = uncShare(abs);
    if (share !== null && !shares.has(share)) return refused;
    const more = split(abs);
    current = more.root;
    rest = [...more.rest, ...rest];
  }
  return { ok: true, at: current, found: current, missing: [] };
}

function realpathNative(/** @type {string} */ p) {
  return new Promise((resolve, reject) => fs.realpath.native(p, (err, out) => (err ? reject(err) : resolve(out))));
}

/** realOf's answer for a place the disk gives as a share of this very computer (a drive mapped to \\localhost\c$). */
const HERE = Symbol('a share of this computer');

/** `p` (which exists) as the system spells it: true case, short names expanded, links resolved. Null when it will not say. */
async function systemSpelling(/** @type {string} */ p) {
  /** @type {string} */
  let real;
  try {
    real = /** @type {string} */ (await realpathNative(p));
  } catch {
    try {
      real = await fsp.realpath(p);
    } catch {
      return null;
    }
  }
  if (DEVICE_PATH.test(real) || uncShare(real) === '') return null;
  return real;
}

/**
 * `p` with every link resolved, or null (missing, or a link leads somewhere not allowed), or HERE
 * when the disk answers it as a share of this very computer (refused like one typed that way).
 * @param {string} p @param {ReadonlySet<string>} shares
 * @returns {Promise<string | null | typeof HERE>}
 */
async function realOf(p, shares) {
  if (!(await walkLinks(p, shares)).ok) return null;
  const real = await systemSpelling(p);
  if (real === null) return null;
  return isThisComputerShare(real) ? HERE : real;
}

/** realOf for a folder to compare with: a share of this computer is no place to compare with. */
async function realBase(/** @type {string} */ p, /** @type {ReadonlySet<string>} */ shares) {
  const real = await realOf(p, shares);
  return typeof real === 'string' ? real : null;
}

/**
 * Where `p` is, as the system spells the part of it that exists (true case, short names such as
 * IRONBO~1 expanded, links followed), with the parts that do not exist added as given. So a file
 * that is missing is still placed by the real spelling of its folder. Null when a link on the way
 * may not be followed.
 * @param {string} p @param {ReadonlySet<string>} shares
 */
async function diskSpelling(p, shares) {
  const w = await walkLinks(p, shares);
  if (!w.found) return null;
  const base = await systemSpelling(w.found);
  if (base === null) return null;
  return w.missing.length ? path.join(base, ...w.missing) : base;
}

/**
 * The forms a path is compared in with Ironbooks' own places: on Windows without the trailing dots
 * and spaces the system drops from every name ("Ironbooks." is "Ironbooks"), and in either folding
 * of case (lower case, and the upper case NTFS compares in, which differ for a few letters such as
 * "ſ"). Case is folded on every system: a Mac's disk ignores it too, and here refusing more is the
 * safe side.
 * @param {string} p
 */
function ownForms(p) {
  const root = path.parse(p).root;
  const parts = p
    .slice(root.length)
    .split(WIN ? /[\\/]+/ : /\/+/)
    .map((part) => (WIN ? part.replace(/[. ]+$/, '') : part))
    .filter(Boolean);
  const s = root + parts.join(path.sep);
  return [s.toLowerCase(), windowsFold(s)];
}

/** `p` is `place`, or inside it, in any of the forms the disk takes for the same name. */
function ownWithin(/** @type {string} */ p, /** @type {string} */ place, /** @type {boolean} */ orInside = true) {
  const a = ownForms(p);
  const b = ownForms(place);
  return a.some((x, i) => x === b[i] || (orInside && x.startsWith(b[i].endsWith(path.sep) ? b[i] : b[i] + path.sep)));
}

export const NO_FOLDERS_MESSAGE =
  'No folders are open to this agent, so it cannot read files from this computer. An Admin can add folders for it under Users & Roles > Agents. Or hand the file over with upload_file.';
export const NOT_A_PATH_MESSAGE = 'Give the full path of the file, for example C:\\Users\\Pat\\Documents\\Ironbooks\\statement.pdf.';

/** The plain message for a file outside the folders this agent may use. */
export function outsideMessage(/** @type {string[]} */ folders) {
  return `That file is not in a folder this agent may use. Folders open to this agent: ${folders.join('; ')}. Ask the person to put the file in one of them, or an Admin can add a folder under Users & Roles > Agents.`;
}

export const NOT_FOUND_MESSAGE = 'That file could not be found. Check the path, or ask the person where the file is.';

/** Said of a path that reaches this computer through one of its own network shares (isThisComputerShare). */
export const THIS_COMPUTER_SHARE_MESSAGE =
  "That path reaches this computer through one of its own network shares (\\\\localhost, a loopback address or this computer's own name). An agent may never read files that way. Give the file's own path on this computer instead, for example C:\\Users\\Pat\\Documents\\Ironbooks\\statement.pdf.";

/** Said when every folder open to this agent is such a share, so none can be used. */
export const ONLY_THIS_COMPUTER_FOLDERS_MESSAGE =
  "The folders open to this agent are reached through a network share of this same computer (\\\\localhost or this computer's own name), which an agent may never use, so it cannot read files from this computer. An Admin can open the folder again by its own path on this computer (for example C:\\Users\\Pat\\Documents\\Ironbooks) under Users & Roles > Agents. Or hand the file over with upload_file.";

/**
 * Said of a file in ironbooksFolders or ironbooksFiles. It names only what those cover: the
 * company file itself and a backups folder the person chose elsewhere are not among them (no
 * connector setting says where they are), so it does not claim them.
 */
export const IRONBOOKS_OWN_MESSAGE =
  "That file is one Ironbooks keeps for itself on this computer (its settings folder with the backups it makes when it closes, the working copies of company files, agent files, or this connector's access token). An agent may never read those, even inside a folder open to it. Read what you need through Ironbooks itself instead: find_operations lists what it can show you.";

/** Older names of Ironbooks' settings folder (electron/main.js useLegacyUserDataIfPresent), and the name in a source checkout. */
const APP_FOLDER_NAMES = ['Ironbooks', 'BookKeeper AI', 'bookkeeper-ai', 'ironbooks'];

/**
 * Folders Ironbooks keeps for itself on this computer, which an agent may never read from even
 * when an Admin opened a folder that holds one (say the whole user profile):
 *  - its settings folder (electron/main.js userData, also by its older names, or
 *    IRONBOOKS_USER_DATA): the device key, settings, quit-time backups, TLS keys;
 *  - its local folder (Windows %LOCALAPPDATA%\Ironbooks): the working copies of company files and
 *    practice copies (electron/companySession.js workingRoot, sandboxRoot), which hold the books in
 *    plain form even for a password-protected file; every agent's staged files (lib/agent/files.ts
 *    appDataRoot); the endpoint files with the value Ironbooks proves itself with to this
 *    connector (lib/agent/endpointFile.ts endpointDir);
 *  - elsewhere, the same places under the system's own names.
 * A test holds these to those modules.
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [platform]
 * @param {string} [home]
 * @returns {string[]}
 */
export function ironbooksFolders(env = process.env, platform = process.platform, home = os.homedir()) {
  const out = [];
  if (platform === 'win32') {
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const n of APP_FOLDER_NAMES) out.push(path.join(roaming, n));
    out.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Ironbooks'));
  } else if (platform === 'darwin') {
    for (const n of APP_FOLDER_NAMES) out.push(path.join(home, 'Library', 'Application Support', n));
  } else {
    for (const n of APP_FOLDER_NAMES) out.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), n));
    out.push(path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ironbooks'));
  }
  // companySession.workingRoot when Electron gives it no settings folder.
  out.push(path.join(home, '.ironbooks'));
  if (env.IRONBOOKS_USER_DATA) out.push(path.resolve(env.IRONBOOKS_USER_DATA));
  if (env[ENDPOINT_DIR_ENV]) out.push(endpointDir(env, platform));
  return [...new Map(out.map((p) => [key(p), p])).values()];
}

/**
 * Files of Ironbooks' an agent may never read either: this connector's own token file.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function ironbooksFiles(env = process.env) {
  const file = env[TOKEN_FILE_ENV];
  return file ? [path.resolve(file)] : [];
}

/**
 * `p` (a path with its links resolved) is inside, or is, one of Ironbooks' own folders or files,
 * under any spelling the disk takes for the same place: in either folding of case, without the
 * trailing dots and spaces Windows drops, and as the system spells the part that exists (short
 * names expanded, links followed, even for a place that does not exist yet). A folder on a network
 * share is only looked at when an allowed folder is on that share too.
 * @param {string} p @param {{ folders: string[], files: string[] }} own @param {ReadonlySet<string>} shares
 */
async function isIronbooksOwn(p, own, shares) {
  const lookable = (/** @type {string} */ f) => {
    const s = uncShare(f);
    return s === null || shares.has(s);
  };
  const places = async (/** @type {string} */ f) => {
    const spelled = lookable(f) ? await diskSpelling(f, shares) : null;
    return spelled && spelled !== f ? [f, spelled] : [f];
  };
  for (const folder of own.folders) {
    for (const place of await places(folder)) if (ownWithin(p, place)) return true;
  }
  for (const file of own.files) {
    for (const place of await places(file)) if (ownWithin(p, place, false)) return true;
  }
  return false;
}

/** Write a refusal to the connector's log (stderr; never stdout, which is the protocol). */
function logRefusal(/** @type {unknown} */ requested, /** @type {string} */ why) {
  // Quoted as JSON and cut short, so a path cannot add lines of its own to the log.
  // The reason may quote an argument's name the agent chose: no control characters from it either.
  const shown = JSON.stringify(typeof requested === 'string' ? requested.slice(0, 300) : String(requested));
  process.stderr.write(`[ironbooks-mcp] attach_local_file refused ${shown}: ${why.slice(0, 400).replace(/\p{Cc}/gu, ' ')}\n`);
}

/** `p` is one of `folders`, or inside one (each as given, and with its links followed). */
async function inAllowedFolder(/** @type {string} */ p, /** @type {string[]} */ folders, /** @type {ReadonlySet<string>} */ shares) {
  for (const folder of folders) {
    if (inside(p, folder) || key(p) === key(folder)) return true;
    const base = await realBase(folder, shares);
    if (base && (inside(p, base) || key(p) === key(base))) return true;
  }
  return false;
}

/**
 * Read an open file from its start, at most `cap` bytes, however large it said it was (it may
 * have grown since). Null when it holds more than `cap`.
 * @param {import('node:fs/promises').FileHandle} handle @param {number} cap @param {number} [sizeHint]
 */
export async function readUpTo(handle, cap, sizeHint = 0) {
  let buf = Buffer.alloc(Math.min(cap + 1, Math.max(sizeHint + 1, 64 * 1024)));
  let filled = 0;
  for (;;) {
    if (filled === buf.length) {
      if (buf.length > cap) break; // one byte more than allowed: too large
      const bigger = Buffer.alloc(Math.min(cap + 1, buf.length * 2));
      buf.copy(bigger, 0, 0, filled);
      buf = bigger;
    }
    const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > cap ? null : buf.subarray(0, filled);
}

/**
 * Read a file the agent named, only when its real path is inside one of `folders`.
 * Throws ToolError with a plain message otherwise.
 *
 * Known limit: the path is checked, then the file is opened, then checked again (same file, same
 * real path). A program on this computer that swaps a folder for a link and back between those
 * steps could still slip one file past; it needs its own way to change files here, which an agent
 * that only has this connector does not have.
 * @param {string} requested
 * @param {string[]} folders
 * @param {{ own?: { folders: string[], files: string[] } }} [opts]  Ironbooks' own folders and files (tests pass their own)
 * @returns {Promise<{ path: string, bytes: Buffer }>}
 */
export async function readAllowedFile(requested, folders, opts = {}) {
  const typed = /** @type {string[]} */ ((Array.isArray(folders) ? folders : []).map(plainPath).filter((p) => typeof p === 'string'));
  // A folder reached through a share of this very computer is never one an agent may use, nor does
  // it allow anything (lib/agent/files.ts allowedFolder): by the words, so it is never looked at,
  // and so never among `shares` below, which keeps a link that leads to it out too.
  const entries = typed.filter((p) => !isThisComputerShare(p));
  // Every refusal is logged (plan §5.7); a file that is missing, a folder or too large is not one.
  if (!entries.length) {
    logRefusal(requested, typed.length ? 'every folder open to this agent is a share of this same computer.' : 'no folders are open to this agent.');
    throw new ToolError(typed.length ? ONLY_THIS_COMPUTER_FOLDERS_MESSAGE : NO_FOLDERS_MESSAGE);
  }
  const want = plainPath(requested);
  if (!want) {
    logRefusal(requested, 'not a plain full path (relative, a device, a stream or a device name).');
    throw new ToolError(NOT_A_PATH_MESSAGE);
  }
  const thisComputer = () => {
    logRefusal(requested, 'it reaches this computer through one of its own network shares.');
    return new ToolError(THIS_COMPUTER_SHARE_MESSAGE);
  };
  // \\localhost\c$\…, \\127.1\…, this computer's own name: refused by the words, before anything is looked at.
  if (isThisComputerShare(want)) throw thisComputer();
  const outside = () => {
    logRefusal(requested, 'not inside a folder this agent may use.');
    return new ToolError(outsideMessage(entries));
  };
  const own = opts.own ?? { folders: ironbooksFolders(), files: ironbooksFiles() };
  const ironbooksOwn = () => {
    logRefusal(requested, 'inside a folder Ironbooks keeps for itself.');
    return new ToolError(IRONBOOKS_OWN_MESSAGE);
  };
  // Network shares an allowed folder names itself: the only ones ever looked at.
  const shares = new Set(entries.map(uncShare).filter((s) => typeof s === 'string' && s !== ''));
  const wantShare = uncShare(want);
  if (wantShare !== null && !shares.has(wantShare)) throw outside();

  const real = await realOf(want, shares);
  // As the disk has it, on a share of this very computer (a drive mapped to \\localhost\c$).
  if (real === HERE) throw thisComputer();
  if (!real) {
    // Missing: say so only where the file would be inside an allowed folder once every link on the
    // way is followed, so nothing is learnt about what exists elsewhere, even through a link that
    // leads out. A link that may not be followed at all counts as outside.
    const { at } = await walkLinks(want, shares);
    if (!at) throw outside();
    // Where it would be, as the system spells the folders that exist (short names, true case).
    const spelled = await diskSpelling(want, shares);
    if (!(await inAllowedFolder(at, entries, shares)) && !(spelled && (await inAllowedFolder(spelled, entries, shares)))) throw outside();
    if (spelled && isThisComputerShare(spelled)) throw thisComputer();
    // Inside one of Ironbooks' own folders: refused alike whether the file is there or not.
    if ((await isIronbooksOwn(at, own, shares)) || (spelled && (await isIronbooksOwn(spelled, own, shares)))) throw ironbooksOwn();
    throw new ToolError(NOT_FOUND_MESSAGE);
  }
  const realShare = uncShare(real);
  let allowed = false;
  for (const entry of entries) {
    const entryShare = uncShare(entry);
    if (entryShare !== null && entryShare !== realShare) continue;
    const base = await realBase(entry, shares);
    // The folder itself counts too, so that it is refused below as "not a file", not as outside.
    if (base && (inside(real, base) || key(real) === key(base))) {
      allowed = true;
      break;
    }
  }
  if (!allowed) throw outside();
  if (await isIronbooksOwn(real, own, shares)) throw ironbooksOwn();

  // A pipe or a device would never end; a folder is not a file. Looked at before it is opened.
  const before = await fsp.stat(real).catch(() => null);
  if (!before || !before.isFile()) throw new ToolError('That is not a file. Give the path of one file.');
  if (before.size > UPLOAD_MAX_BYTES) throw new ToolError(TOO_LARGE(before.size));

  const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)).catch(() => null);
  if (!handle) throw new ToolError('That file could not be opened. It may be open in another program; close it and try again.');
  try {
    const st = await handle.stat();
    // The path still leads to the file that was checked: nothing was swapped in meanwhile.
    const again = await realBase(real, shares);
    if (!st.isFile() || !again || key(again) !== key(real) || st.ino !== before.ino || st.dev !== before.dev) throw outside();
    if (st.size > UPLOAD_MAX_BYTES) throw new ToolError(TOO_LARGE(st.size));
    // Never more than the cap in memory, even when the file grows while it is read.
    const bytes = await readUpTo(handle, UPLOAD_MAX_BYTES, st.size);
    if (!bytes) throw new ToolError(OVER_CAP);
    return { path: real, bytes };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Reading a staged file
// ---------------------------------------------------------------------------

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const isTextType = (/** @type {string} */ t) => /^text\//i.test(t) || /^application\/([\w.+-]+\+)?(json|xml|csv)$/i.test(t);

/** Text when the bytes are UTF-8, else null. */
function utf8(/** @type {Buffer} */ bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A staged file's content as one MCP content block (image, text resource, or base64 resource). */
export function contentBlock(/** @type {any} */ file, /** @type {string} */ base64) {
  const uri = `${FILE_URI_PREFIX}${file.fileId}`;
  const type = typeof file.type === 'string' && file.type ? file.type : 'application/octet-stream';
  if (IMAGE_TYPES.has(type.toLowerCase())) return { type: 'image', data: base64, mimeType: type };
  if (isTextType(type)) {
    const text = utf8(Buffer.from(base64, 'base64'));
    if (text !== null) return { type: 'resource', resource: { uri, mimeType: type, text } };
  }
  return { type: 'resource', resource: { uri, mimeType: type, blob: base64 } };
}

/** Fetch a staged file (the get_file verb), or null when there is no such file. */
async function fetchFile(/** @type {any} */ client, /** @type {string} */ fileId) {
  let res;
  try {
    res = await verb(client, 'get_file', { fileId });
  } catch (err) {
    if (err instanceof Error && /** @type {any} */ (err).status === 404) return null;
    throw err;
  }
  if (!res?.file?.fileId || typeof res.base64 !== 'string') return null;
  return { file: res.file, base64: res.base64 };
}

const NO_FILE = `There is no file with that file_id. Files are kept for ${STAGED_FILE_HOURS} hours; run the operation that made it again, or upload it again.`;

/** The resource ironbooks://files/<id>: one staged file. Null when there is none. */
export async function readFileResource(/** @type {string} */ uri, /** @type {any} */ client) {
  const id = uri.slice(FILE_URI_PREFIX.length);
  if (!new RegExp(FILE_ID.pattern).test(id)) return null;
  const got = await fetchFile(client, id);
  if (!got) return null;
  const block = contentBlock(got.file, got.base64);
  const type = got.file.type || 'application/octet-stream';
  if (block.type === 'resource') return [block.resource];
  return [{ uri, mimeType: type, blob: got.base64 }];
}

export const FILE_TEMPLATE = {
  uriTemplate: `${FILE_URI_PREFIX}{file_id}`,
  name: 'file',
  title: 'A file handed to or made by Ironbooks',
  description: `A file uploaded by you or made by an operation (a PDF, a download). Kept for ${STAGED_FILE_HOURS} hours.`,
  mimeType: 'application/octet-stream',
};

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/** @type {import('./protocol.mjs').Tool[]} */
export const FILE_TOOLS = [
  {
    name: 'upload_file',
    title: 'Hand a file to Ironbooks',
    changes: true,
    description: `Hand Ironbooks a file you hold (a receipt, a bank statement, an export), as base64, at most ${UPLOAD_MAX_BYTES / MB} MB. The answer gives a file_id; where an operation takes a file, give { "fileId": "<file_id>" }. For a file on this computer, attach_local_file reads it for you. Files are kept for ${STAGED_FILE_HOURS} hours.`,
    inputSchema: schema(
      {
        name: { ...FILE_NAME, description: 'The file\'s name, for example "statement-2026-03.pdf".' },
        type: { ...MIME, description: 'Its media type, for example application/pdf, text/csv or image/jpeg.' },
        base64: { type: 'string', maxLength: BASE64_MAX_CHARS, description: 'The file\'s bytes, base64 encoded (standard alphabet; line breaks are fine).' },
      },
      ['name', 'type', 'base64'],
    ),
    handler: async (a, c) => {
      const bytes = decodeBase64(a.base64);
      if (!bytes) throw new ToolError('"base64" is not base64 text. Encode the file\'s bytes with the standard base64 alphabet.');
      return uploaded(await uploadBytes(c, { name: a.name, type: a.type, bytes }));
    },
  },
  {
    name: 'attach_local_file',
    title: 'Hand Ironbooks a file on this computer',
    changes: true,
    description: `Hand Ironbooks a file on this computer by its full path: the connector reads it and uploads it, and the answer gives a file_id. Only files inside the folders an Admin opened to you (get_my_permissions lists them) can be read; anything else is refused. At most ${UPLOAD_MAX_BYTES / MB} MB.`,
    inputSchema: schema(
      {
        path: { type: 'string', maxLength: PATH_MAX, description: 'The full path of the file, for example C:\\Users\\Pat\\Documents\\Ironbooks\\statement.pdf.' },
        name: { ...FILE_NAME, description: 'A name for it in Ironbooks (default: the file\'s own name).' },
        type: { ...MIME, description: 'Its media type (default: from the file\'s extension).' },
      },
      ['path'],
    ),
    // Arguments the schema refuses (a path that is not text, or over PATH_MAX) never reach the
    // handler: they are logged like every other refusal.
    refused: (a, problem) => logRefusal(a && typeof a === 'object' ? /** @type {any} */ (a).path : a, `the arguments were refused: ${problem}`),
    handler: async (a, c) => {
      const permissions = await verb(c, 'get_my_permissions', {});
      const folders = Array.isArray(permissions?.folders) ? permissions.folders.filter((f) => typeof f === 'string') : [];
      const file = await readAllowedFile(a.path, folders);
      const name = a.name ?? path.basename(file.path);
      return uploaded(await uploadBytes(c, { name, type: a.type ?? typeOf(name), bytes: file.bytes }));
    },
  },
  {
    name: 'get_file',
    title: 'Read a file',
    description: `Read a file Ironbooks holds for you: one an operation made (a PDF, a download; its answer gave the file_id) or one you handed it. An image comes back as an image, text as text, anything else as base64. Files are kept for ${STAGED_FILE_HOURS} hours.`,
    inputSchema: schema({ file_id: { ...FILE_ID, description: 'The file_id from an answer.' } }, ['file_id']),
    handler: async (a, c) => {
      const got = await fetchFile(c, a.file_id);
      if (!got) throw new ToolError(NO_FILE);
      return new ToolContent([{ type: 'text', text: JSON.stringify(fileRow(got.file)) }, contentBlock(got.file, got.base64)]);
    },
  },
  {
    name: 'save_file',
    title: 'Save a file to a folder',
    changes: true,
    description:
      'Save a file Ironbooks holds for you (by its file_id) into a folder on this computer: one of the folders get_my_permissions lists, or a folder inside one. A person always approves this: the answer is "asked", then call wait_for_decision. Give a reason the person can check.',
    inputSchema: schema(
      {
        file_id: { ...FILE_ID, description: 'The file_id from an answer or from upload_file.' },
        folder: { type: 'string', maxLength: SAVE_FOLDER_MAX, description: 'The folder to save it in: one get_my_permissions lists, or a folder inside one.' },
        name: { ...FILE_NAME, description: 'The name to save it under (default: the file\'s own name).' },
        request_id: REQUEST_ID,
        reason: { type: 'string', maxLength: 500, description: 'Why it should be saved there, in a sentence. The person sees it labelled as your words.' },
      },
      ['file_id', 'folder', 'request_id'],
    ),
    handler: async (a, c) => settleLong(await verb(c, 'save_file', { fileId: a.file_id, folder: a.folder, name: a.name, requestId: a.request_id, reason: a.reason })),
  },
];
