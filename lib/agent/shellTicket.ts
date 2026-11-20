/**
 * Agent full access: the approval ticket of a shell operation (plan §5.5): an HMAC the server makes
 * when a person approves, and the desktop shell checks before it does anything.
 * STUB: the signatures are fixed; the bodies are still to be written.
 */
import type { ShellTicket } from './contract';

/** `key` is the per-launch shell key. `input` is hashed (stable JSON, sha256). */
export function makeShellTicket(
  _key: string,
  _t: { requestId: string; operation: string; input: unknown; approverId: string; now?: number },
): ShellTicket {
  throw new Error('makeShellTicket is not built yet.');
}

/** Null when the ticket is good for exactly this operation and input, otherwise why not. */
export function shellTicketProblem(_key: string, _ticket: ShellTicket, _operation: string, _input: unknown, _now?: number): string | null {
  throw new Error('shellTicketProblem is not built yet.');
}
