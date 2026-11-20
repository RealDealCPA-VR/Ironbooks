/**
 * Agent full access: the server's side of the shell bridge (plan §5.5): hands an approved shell
 * operation to the desktop shell (electron/agentShell.js), or carries out a 'server' one itself.
 * STUB: the signatures are fixed; the bodies are still to be written.
 */
import type { ServiceContext } from '@/lib/services/_base';
import type { ShellOperationDef } from './contract';

export interface ShellRunResult {
  ok: boolean;
  /** What the flow answered (paths, names); never a secret. */
  result: unknown;
  /** The app's own message when it did not work. */
  error: string | null;
  /** Ironbooks is restarting or changing company file: the agent must connect again. */
  restarting: boolean;
}

/** True when a desktop shell is listening (false in a plain server or a test). */
export function shellAvailable(): boolean {
  return false;
}

/**
 * Carry out an approved shell operation. `approver` is the approving person's context; `answers`
 * are their answers to the flow's questions; `secrets` are what they typed on the card.
 */
export async function runShellOperation(
  _approver: ServiceContext,
  _def: ShellOperationDef,
  _request: { id: string; agentId: string; input: Record<string, unknown> },
  _answers: Record<string, unknown>,
  _secrets: Record<string, string>,
): Promise<ShellRunResult> {
  throw new Error('runShellOperation is not built yet.');
}
