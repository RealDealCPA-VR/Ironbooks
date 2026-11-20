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
 *  - until SHELL_TICKET_SECONDS from when it was made.
 * Anything else (another operation, an input changed after the approval, a late or altered ticket)
 * is refused with a plain reason. The shell also refuses a ticket it has already seen (replay).
 *
 * electron/agentShell.js checks tickets with the same algorithm in plain Node: the two must agree
 * byte for byte (test/agentShell.test.ts makes tickets here and checks them there, and back).
 *
 * Pure: node:crypto only, no database or Next imports.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SHELL_TICKET_SECONDS, type ShellTicket } from './contract';

/** Marks what the MAC is over, so it can never be taken for any other keyed hash of this key. */
const TICKET_LABEL = 'ironbooks-shell-ticket/1';
const HEX64 = /^[0-9a-f]{64}$/;
/** A ticket whose expiry lies further ahead than this was not made by makeShellTicket. */
const CLOCK_SLACK_MS = 60_000;

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

/** sha256 (hex) of the stable JSON of an operation's input. */
export function shellInputHash(input: unknown): string {
  return createHash('sha256').update(stableJson(input === undefined ? null : input), 'utf8').digest('hex');
}

function ticketMac(key: string, t: Omit<ShellTicket, 'mac'>): string {
  // A JSON array, so no field can run into the next one whatever it holds.
  const message = JSON.stringify([TICKET_LABEL, t.requestId, t.operation, t.inputHash, t.approverId, t.expiresAt]);
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** `key` is the per-launch shell key. `input` is hashed (stable JSON, sha256). */
export function makeShellTicket(
  key: string,
  t: { requestId: string; operation: string; input: unknown; approverId: string; now?: number },
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
  return { ...fields, mac: ticketMac(key, fields) };
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
 * Null when the ticket is good for exactly this operation and input, otherwise why not. A request
 * that fails is final (plan §7.2), so the way on is a new request: the messages say "ask again".
 */
export function shellTicketProblem(key: string, ticket: ShellTicket, operation: string, input: unknown, now?: number): string | null {
  if (typeof key !== 'string' || !key) {
    return 'This Ironbooks has no key for approval tickets, so it cannot carry out approved requests. Restart Ironbooks, then have the agent ask again.';
  }
  if (!readable(ticket)) return 'The approval ticket could not be read, so nothing was done. The agent can ask again.';
  // The MAC first: until it checks out, nothing else in the ticket can be believed.
  if (!sameHex(ticketMac(key, ticket), ticket.mac)) {
    return 'The approval ticket was not made by this Ironbooks, so nothing was done. Requests are approved in the Ironbooks window; the agent can ask again.';
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
