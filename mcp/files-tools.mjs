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
 *    (get_my_permissions lists them). Anywhere else it is refused before the file is opened, and
 *    the refusal is written to the connector's log. A network share is looked at only when an
 *    allowed folder is on it: merely touching a share makes Windows offer it this person's sign-in.
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
import path from 'node:path';
import { LOST_ANSWER_MESSAGE } from './client.mjs';
import { ToolContent, ToolError } from './protocol.mjs';
import { settle } from './write-tools.mjs';
import { REQUEST_ID, verb } from './operations-tools.mjs';

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
const MAX_LINK_HOPS = 32;

const FILE_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$', patternHint: 'must be a file_id an answer gave you' };
const FILE_NAME = {
  type: 'string',
  maxLength: 255,
  pattern: '^[^\\\\/\\u0000-\\u001f]+$',
  patternHint: 'must be a file name without folders, for example "statement-2026-03.pdf"',
};
const MIME = {
  type: 'string',
  maxLength: 255,
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
 * On Windows, the share a UNC path is on, as "\\server\share" in lower case; '' for a UNC path
 * without a share; null for any other path (and always on other systems).
 * @param {string} p
 */
function uncShare(p) {
  if (!WIN || !/^[\\/]{2}/.test(p) || DEVICE_PATH.test(p)) return null;
  const m = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(p);
  return m ? `\\\\${m[1]}\\${m[2]}`.toLowerCase() : '';
}

const key = (/** @type {string} */ p) => (WIN ? p.toLowerCase() : p);

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
 * else" without being fooled by a link that leads out. Null when a link was refused.
 * @param {string} start @param {ReadonlySet<string>} shares
 * @returns {Promise<{ ok: boolean, at: string | null }>}
 */
async function walkLinks(start, shares) {
  const split = (/** @type {string} */ p) => {
    const root = path.parse(p).root;
    return { root, rest: p.slice(root.length).split(path.sep).filter(Boolean) };
  };
  let { root, rest } = split(start);
  let current = root;
  let hops = 0;
  while (rest.length) {
    const next = path.join(current, /** @type {string} */ (rest.shift()));
    let st;
    try {
      st = await fsp.lstat(next);
    } catch {
      return { ok: false, at: path.join(next, ...rest) };
    }
    if (!st.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return { ok: false, at: null };
    let target;
    try {
      target = await fsp.readlink(next);
    } catch {
      return { ok: false, at: null };
    }
    const abs = path.resolve(current, target);
    if (DEVICE_PATH.test(abs)) return { ok: false, at: null };
    const share = uncShare(abs);
    if (share !== null && !shares.has(share)) return { ok: false, at: null };
    const more = split(abs);
    current = more.root;
    rest = [...more.rest, ...rest];
  }
  return { ok: true, at: current };
}

function realpathNative(/** @type {string} */ p) {
  return new Promise((resolve, reject) => fs.realpath.native(p, (err, out) => (err ? reject(err) : resolve(out))));
}

/** `p` with every link resolved, or null (missing, or a link leads somewhere not allowed). */
async function realOf(/** @type {string} */ p, /** @type {ReadonlySet<string>} */ shares) {
  if (!(await walkLinks(p, shares)).ok) return null;
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

export const NO_FOLDERS_MESSAGE =
  'No folders are open to this agent, so it cannot read files from this computer. An Admin can add folders for it under Users & Roles > Agents. Or hand the file over with upload_file.';
export const NOT_A_PATH_MESSAGE = 'Give the full path of the file, for example C:\\Users\\Pat\\Documents\\Ironbooks\\statement.pdf.';

/** The plain message for a file outside the folders this agent may use. */
export function outsideMessage(/** @type {string[]} */ folders) {
  return `That file is not in a folder this agent may use. Folders open to this agent: ${folders.join('; ')}. Ask the person to put the file in one of them, or an Admin can add a folder under Users & Roles > Agents.`;
}

export const NOT_FOUND_MESSAGE = 'That file could not be found. Check the path, or ask the person where the file is.';

/** Write a refusal to the connector's log (stderr; never stdout, which is the protocol). */
function logRefusal(/** @type {unknown} */ requested, /** @type {string} */ why) {
  // Quoted as JSON and cut short, so a path cannot add lines of its own to the log.
  const shown = JSON.stringify(typeof requested === 'string' ? requested.slice(0, 300) : String(requested));
  process.stderr.write(`[ironbooks-mcp] attach_local_file refused ${shown}: ${why}\n`);
}

/** `p` is one of `folders`, or inside one (each as given, and with its links followed). */
async function inAllowedFolder(/** @type {string} */ p, /** @type {string[]} */ folders, /** @type {ReadonlySet<string>} */ shares) {
  for (const folder of folders) {
    if (inside(p, folder) || key(p) === key(folder)) return true;
    const base = await realOf(folder, shares);
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
 * @returns {Promise<{ path: string, bytes: Buffer }>}
 */
export async function readAllowedFile(requested, folders) {
  const entries = /** @type {string[]} */ ((Array.isArray(folders) ? folders : []).map(plainPath).filter((p) => typeof p === 'string'));
  if (!entries.length) throw new ToolError(NO_FOLDERS_MESSAGE);
  const want = plainPath(requested);
  if (!want) {
    logRefusal(requested, 'not a plain full path (relative, a device, a stream or a device name).');
    throw new ToolError(NOT_A_PATH_MESSAGE);
  }
  const outside = () => {
    logRefusal(requested, 'not inside a folder this agent may use.');
    return new ToolError(outsideMessage(entries));
  };
  // Network shares an allowed folder names itself: the only ones ever looked at.
  const shares = new Set(entries.map(uncShare).filter((s) => typeof s === 'string' && s !== ''));
  const wantShare = uncShare(want);
  if (wantShare !== null && !shares.has(wantShare)) throw outside();

  const real = await realOf(want, shares);
  if (!real) {
    // Missing: say so only where the file would be inside an allowed folder once every link on the
    // way is followed, so nothing is learnt about what exists elsewhere, even through a link that
    // leads out. A link that may not be followed at all counts as outside.
    const { at } = await walkLinks(want, shares);
    if (at && (await inAllowedFolder(at, entries, shares))) throw new ToolError(NOT_FOUND_MESSAGE);
    throw outside();
  }
  const realShare = uncShare(real);
  let allowed = false;
  for (const entry of entries) {
    const entryShare = uncShare(entry);
    if (entryShare !== null && entryShare !== realShare) continue;
    const base = await realOf(entry, shares);
    // The folder itself counts too, so that it is refused below as "not a file", not as outside.
    if (base && (inside(real, base) || key(real) === key(base))) {
      allowed = true;
      break;
    }
  }
  if (!allowed) throw outside();

  // A pipe or a device would never end; a folder is not a file. Looked at before it is opened.
  const before = await fsp.stat(real).catch(() => null);
  if (!before || !before.isFile()) throw new ToolError('That is not a file. Give the path of one file.');
  if (before.size > UPLOAD_MAX_BYTES) throw new ToolError(TOO_LARGE(before.size));

  const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)).catch(() => null);
  if (!handle) throw new ToolError('That file could not be opened. It may be open in another program; close it and try again.');
  try {
    const st = await handle.stat();
    // The path still leads to the file that was checked: nothing was swapped in meanwhile.
    const again = await realOf(real, shares);
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
        folder: { type: 'string', maxLength: PATH_MAX, description: 'The folder to save it in: one get_my_permissions lists, or a folder inside one.' },
        name: { ...FILE_NAME, description: 'The name to save it under (default: the file\'s own name).' },
        request_id: REQUEST_ID,
        reason: { type: 'string', maxLength: 500, description: 'Why it should be saved there, in a sentence. The person sees it labelled as your words.' },
      },
      ['file_id', 'folder', 'request_id'],
    ),
    handler: async (a, c) =>
      settle(await verb(c, 'save_file', { fileId: a.file_id, folder: a.folder, name: a.name, requestId: a.request_id, reason: a.reason }), { fields: 'confirm' }),
  },
];
