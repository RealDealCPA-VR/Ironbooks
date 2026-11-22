/**
 * Calls from the AI layer to other computers go through the effects outbox (lib/effects.ts,
 * agent full access plan 5.4): a model's answer, its list of models, a health check, a model
 * download, the ChatGPT sign-in. For a person nothing changes: outside an effects scope
 * effects.network just runs the call. In an agent's preview the call is NOT made: the outbox
 * records "Contact {host} for {purpose}" and throws EffectNotRunInPreview, so nothing leaves the
 * computer and the approval card can say what would be sent where. In an agent's real run the
 * call is made at once (the operation needs the answer) and recorded for the audit trail.
 *
 * Every provider the factories in lib/ai/providers.ts and lib/ai/chatgpt.ts build is wrapped here
 * (withNetworkEffects), so no caller can reach a model around the outbox. The router (router.ts)
 * names the purpose from its task, or takes the caller's own (ChatOptions.purpose), and stops at
 * once when a preview stops: no retry, no other provider, because the real run would contact this
 * one first.
 *
 * Purposes are short plain phrases that read after "for": "Contact api.openai.com for sending a
 * request about the books to an AI model". They say what is sent, never the content itself.
 *
 * Outside lib/ai, the vendor lookup (lib/services/vendorLookup.ts lookupVendor, which sends a
 * payee's name to the company's SearXNG) goes through outboundCall too, and passes
 * EffectNotRunInPreview on to its caller instead of answering "nothing known".
 *
 * No database or Next imports, and nothing here is needed by the browser: the AI settings page
 * imports lib/ai/presets.ts and lib/ai/types.ts only.
 */
import { EffectNotRunInPreview, effects } from '@/lib/effects';
import type { AiProvider, AiTask, ChatOptions } from './types';

/** What each router task sends, for "Contact {host} for {purpose}". */
export const AI_TASK_PURPOSES: Record<AiTask, string> = {
  categorize: 'sending transactions or a document to an AI model to read or categorize them',
  assistant: 'sending a request about the books to an AI model',
  'error-correction': 'sending entries from the books to an AI model to suggest fixes',
};

/** Purposes of the calls that are not a task's chat. */
export const AI_CALL_PURPOSES = {
  /** A chat whose caller named no purpose (a provider used without the router). */
  chat: 'sending text to an AI model',
  listModels: 'listing the AI models it offers',
  health: 'checking that the AI model answers',
  download: 'downloading an AI model',
  signInStart: 'starting the ChatGPT sign-in',
  signInFinish: 'finishing the ChatGPT sign-in',
  signInRenew: 'renewing the ChatGPT sign-in',
  signOut: 'signing out of ChatGPT',
} as const;

/** The longest purpose kept; the outbox cuts summaries further. */
const MAX_PURPOSE = 200;

/**
 * "api.openai.com", "127.0.0.1:11434": the computer a URL reaches, with its port when it names
 * one. `fallback` when the URL cannot be read (the call itself then fails the way it always did).
 */
export function hostOf(url: string | null | undefined, fallback: string): string {
  try {
    const host = new URL(String(url ?? '')).host;
    return host || fallback;
  } catch {
    return fallback;
  }
}

/**
 * True for the outbox's "a preview does not contact other computers" stop. Also by name, since Next
 * can load lib/effects.ts twice (the bridge's bundle and a route's) and instanceof then fails.
 */
export function isNotRunInPreview(err: unknown): boolean {
  return err instanceof EffectNotRunInPreview || (err instanceof Error && err.name === 'EffectNotRunInPreview');
}

/** The caller's purpose when it gave a usable one, else `fallback`. */
export function purposeOf(opts: Pick<ChatOptions, 'purpose'> | undefined, fallback: string): string {
  const given = typeof opts?.purpose === 'string' ? opts.purpose.trim() : '';
  return given ? given.slice(0, MAX_PURPOSE) : fallback;
}

/** Run one call to another computer through the outbox. */
export function outboundCall<T>(purpose: string, host: string, fn: () => Promise<T>): Promise<T> {
  return effects.network({ purpose, host }, fn);
}

/**
 * The same provider, with each of its calls going through the outbox. One call is one effect,
 * whatever it does inside: the ChatGPT provider's own renewal of the sign-in is recorded on its own
 * (it reaches another computer, auth.openai.com). health stays one effect even where it lists the
 * models to check.
 */
export function withNetworkEffects(provider: AiProvider, host: string): AiProvider {
  return {
    id: provider.id,
    kind: provider.kind,
    locality: provider.locality,
    host,
    chat: (messages, opts = {}) => outboundCall(purposeOf(opts, AI_CALL_PURPOSES.chat), host, () => provider.chat(messages, opts)),
    listModels: (opts) => outboundCall(AI_CALL_PURPOSES.listModels, host, () => provider.listModels(opts)),
    health: (opts) => outboundCall(AI_CALL_PURPOSES.health, host, () => provider.health(opts)),
  };
}
