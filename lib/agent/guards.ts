/**
 * Agent full access: What an agent may never supply, and what is hidden from it (plan §4.6, §5.8, §5.9).
 * STUB: the signatures are the contract (lib/agent/contract.ts); the bodies are still to be written.
 */
import type { ApplySecrets, GuardInput, RedactAnswer } from './contract';

export const guardInput: GuardInput = () => {
  throw new Error('guardInput is not built yet.');
};

export const applySecrets: ApplySecrets = () => {
  throw new Error('applySecrets is not built yet.');
};

export const redactAnswer: RedactAnswer = () => {
  throw new Error('redactAnswer is not built yet.');
};
