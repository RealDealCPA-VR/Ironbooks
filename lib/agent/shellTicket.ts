/**
 * Agent full access: the approval ticket of a shell operation (plan §5.5): an HMAC the server makes
 * when a person approves, and the desktop shell checks before it does anything.
 *
 * The desktop shell gives its company server a random key for this launch (BKA_AGENT_SHELL_KEY,
 * electron/agentShell.js), the same way it hands over BKA_INTERNAL_TOKEN. Only that server and the
 * shell know it, so a ticket that checks out was made by this launch's server, for exactly:
 *  - this request (its id),
 *  - this operation ("shell.company.switch"),
 *  - this input (a sha256 of its stable JSON: keys sorted, so the same input always hashes the same),
 *  - this approver,
 *  - until SHELL_TICKET_SECONDS from when it was made,
 *  - and everything else the shell acts on (ShellBound): the approver's answers to the flow's
 *    questions, the folders the Admin allowed for the agent, the file that comes with it (by its
 *    name, type and a sha256 of its bytes) and which secrets the approver typed (their kinds; the
 *    values travel sealed, below). The ticket object keeps the contract's shape (ShellTicket): the
 *    MAC covers a hash of these too, so changing any of them on the way makes the MAC fail.
 * Anything else (another operation, an input changed after the approval, a late or altered ticket)
 * is refused with a plain reason. The shell also refuses a ticket it has already seen (replay).
 *
 * What the line carries that must stay private (the approver's passwords, the PDF of a print job)
 * travels sealed: AES-256-GCM with a key derived from the launch key, tied to the ticket's MAC, so a
 * program that got between the server and the shell reads nothing of it and cannot swap it. The
 * shell's answer comes back with an HMAC over the answer and the ticket's MAC (shellAnswerMac): an
 * answer that does not check out is never taken as "done".
 *
 * electron/agentShell.js checks tickets with the same algorithm in plain Node: the two must agree
 * byte for byte (test/agentShell.test.ts makes tickets here and checks them there, and back).
 *
 * Pure: node:crypto only, no database or Next imports.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { SHELL_TICKET_SECONDS, type ShellTicket } from './contract';

/** Marks what the MAC is over, so it can never be taken for any other keyed hash of this key. */
const TICKET_LABEL = 'ironbooks-shell-ticket/2';
const ANSWER_LABEL = 'ironbooks-shell-answer/1';
const SEAL_INFO = 'ironbooks-shell-private/1';
const HEX64 = /^[0-9a-f]{64}$/;
/** A ticket whose expiry lies further ahead than this was not made by makeShellTicket. */
const CLOCK_SLACK_MS = 60_000;

/** The file a request carries, as the ticket covers it: never its bytes, only their hash. */
export interface ShellFileRef {
  name: string;
  type: string;
  /** sha256 (hex) of the file's bytes. */
  sha256: string;
}

/** Everything the shell acts on besides the operation and its input, as the ticket covers it. */
export interface ShellBound {
  /** The approver's answers to the flow's questions, as sent ({} when none). */
  answers?: unknown;
  /** The folders the Admin allowed for the agent, as sent ([] when none). */
  folders?: unknown;
  /** The file that comes with the request (a print job's PDF), or null. */
  file?: ShellFileRef | null;
  /** Which secrets the approver typed (their kinds; never the values). */
  secrets?: readonly string[];
}

/** What travels sealed on the line. */
export interface ShellPrivate {
  secrets?: Record<string, string>;
  file?: { name: string; type: string; base64: string };
}

/** The sealed part of a line: AES-256-GCM, hex iv and tag, base64 data. */
export interface ShellSealed {
  iv: string;
  data: string;
  tag: string;
}

/**
 * JSON with the keys of every object sorted, so the same input gives the same text however it was
 * built. Follows JSON.stringify otherwise: undefined and functions are left out of objects and
 * become null in arrays, a value with toJSON is replaced by what it returns, NaN and Infinity are
 * null. What travels to the shell is JSON.stringify of the input, so both ends hash the same text.
 */
export function stableJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return stableJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 (hex) of the stable JSON of an operation's input. */
export function shellInputHash(input: unknown): string {
  return sha256Hex(Buffer.from(stableJson(input === undefined ? null : input), 'utf8'));
}

/** The file of a request as the ticket covers it (null for none). */
export function shellFileRef(file: { name?: unknown; type?: unknown; base64?: unknown } | null | undefined): ShellFileRef | null {
  if (!file || typeof file !== 'object') return null;
  const bytes = Buffer.from(typeof file.base64 === 'string' ? file.base64 : '', 'base64');
  return { name: String(file.name ?? ''), type: String(file.type ?? ''), sha256: sha256Hex(bytes) };
}

/** sha256 (hex) of everything else the shell acts on (ShellBound), with the same defaults on both ends. */
export function shellBoundHash(bound?: ShellBound | null): string {
  const b = bound ?? {};
  const kinds = Array.isArray(b.secrets) ? b.secrets.map((k) => String(k)).sort() : [];
  const text = stableJson({ answers: b.answers ?? {}, folders: b.folders ?? [], file: b.file ?? null, secrets: kinds });
  return sha256Hex(Buffer.from(text, 'utf8'));
}

function ticketMac(key: string, t: Omit<ShellTicket, 'mac'>, boundHash: string): string {
  // A JSON array, so no field can run into the next one whatever it holds.
  const message = JSON.stringify([TICKET_LABEL, t.requestId, t.operation, t.inputHash, t.approverId, t.expiresAt, boundHash]);
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** `key` is the per-launch shell key. `input` is hashed (stable JSON, sha256); `bound` is covered by the MAC. */
export function makeShellTicket(
  key: string,
  t: { requestId: string; operation: string; input: unknown; approverId: string; now?: number; bound?: ShellBound | null },
): ShellTicket {
  if (typeof key !== 'string' || !key) throw new Error('There is no key for approval tickets, so the desktop shell cannot be asked to do this.');
  for (const [name, v] of [['request id', t.requestId], ['operation', t.operation], ['approver', t.approverId]] as const) {
    if (typeof v !== 'string' || !v) throw new Error(`An approval ticket needs a ${name}.`);
  }
  const now = t.now ?? Date.now();
  const fields: Omit<ShellTicket, 'mac'> = {
    requestId: t.requestId,
    operation: t.operation,
    inputHash: shellInputHash(t.input),
    approverId: t.approverId,
    expiresAt: now + SHELL_TICKET_SECONDS * 1000,
  };
  return { ...fields, mac: ticketMac(key, fields, shellBoundHash(t.bound)) };
}

function readable(ticket: unknown): ticket is ShellTicket {
  if (!ticket || typeof ticket !== 'object') return false;
  const t = ticket as Record<string, unknown>;
  return (
    typeof t.requestId === 'string' &&
    t.requestId !== '' &&
    typeof t.operation === 'string' &&
    t.operation !== '' &&
    typeof t.inputHash === 'string' &&
    HEX64.test(t.inputHash) &&
    typeof t.approverId === 'string' &&
    t.approverId !== '' &&
    typeof t.expiresAt === 'number' &&
    Number.isFinite(t.expiresAt) &&
    typeof t.mac === 'string' &&
    HEX64.test(t.mac)
  );
}

/** Constant-time comparison of two hex strings of the same length. */
function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Null when the ticket is good for exactly this operation, input and `bound`, otherwise why not. A
 * request that fails is final (plan §7.2), so the way on is a new request: the messages say "ask again".
 */
export function shellTicketProblem(
  key: string,
  ticket: ShellTicket,
  operation: string,
  input: unknown,
  now?: number,
  bound?: ShellBound | null,
): string | null {
  if (typeof key !== 'string' || !key) {
    return 'This Ironbooks has no key for approval tickets, so it cannot carry out approved requests. Restart Ironbooks, then have the agent ask again.';
  }
  if (!readable(ticket)) return 'The approval ticket could not be read, so nothing was done. The agent can ask again.';
  // The MAC first: until it checks out, nothing else in the ticket can be believed.
  if (!sameHex(ticketMac(key, ticket, shellBoundHash(bound)), ticket.mac)) {
    return 'The approval ticket was not made by this Ironbooks for exactly what came with it, so nothing was done. Requests are approved in the Ironbooks window; the agent can ask again.';
  }
  const at = now ?? Date.now();
  if (at > ticket.expiresAt) return 'The approval ran out before Ironbooks got to it, so nothing was done. The agent can ask again.';
  if (ticket.expiresAt - at > SHELL_TICKET_SECONDS * 1000 + CLOCK_SLACK_MS) {
    return 'The approval ticket could not be read, so nothing was done. The agent can ask again.';
  }
  if (ticket.operation !== operation) return 'The approval ticket is for another request, so nothing was done. The agent can ask again.';
  if (!sameHex(ticket.inputHash, shellInputHash(input))) return 'The request changed after it was approved, so nothing was done. The agent can ask again.';
  return null;
}

// ---------------------------------------------------------------------------
// The sealed part of a line, and the shell's signed answer
// ---------------------------------------------------------------------------

function sealKey(key: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(key, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32));
}

/** Seal what must stay private on the line, tied to this ticket (its MAC is the additional data). */
export function sealShellPrivate(key: string, ticketMac: string, priv: ShellPrivate): ShellSealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(key), iv);
  cipher.setAAD(Buffer.from(ticketMac, 'utf8'));
  const data = Buffer.concat([cipher.update(JSON.stringify(priv), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('hex') };
}

/** What was sealed, or null when it was not sealed with this key for this ticket (or is not one). */
export function openShellPrivate(key: string, ticketMac: string, sealed: unknown): ShellPrivate | null {
  if (!sealed || typeof sealed !== 'object' || typeof key !== 'string' || !key) return null;
  const s = sealed as Record<string, unknown>;
  if (typeof s.iv !== 'string' || !/^[0-9a-f]{24}$/.test(s.iv) || typeof s.tag !== 'string' || !/^[0-9a-f]{32}$/.test(s.tag) || typeof s.data !== 'string') {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKey(key), Buffer.from(s.iv, 'hex'));
    decipher.setAAD(Buffer.from(String(ticketMac), 'utf8'));
    decipher.setAuthTag(Buffer.from(s.tag, 'hex'));
    const text = Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ShellPrivate) : null;
  } catch {
    return null;
  }
}

/** The HMAC of the shell's answer to the request whose ticket has `ticketMac`. */
export function shellAnswerMac(
  key: string,
  ticketMac: string,
  answer: { ok: unknown; result: unknown; error: unknown; restarting: unknown },
): string {
  const text = stableJson({ ok: answer.ok, result: answer.result, error: answer.error, restarting: answer.restarting });
  return createHmac('sha256', key).update(JSON.stringify([ANSWER_LABEL, String(ticketMac), text]), 'utf8').digest('hex');
}

/** True when `mac` is the shell's HMAC of this answer to this ticket. */
export function shellAnswerChecks(
  key: string,
  ticketMac: string,
  answer: { ok: unknown; result: unknown; error: unknown; restarting: unknown },
  mac: unknown,
): boolean {
  return typeof key === 'string' && key !== '' && typeof mac === 'string' && HEX64.test(mac) && sameHex(shellAnswerMac(key, ticketMac, answer), mac);
}
