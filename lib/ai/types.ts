/**
 * AI layer — shared types.
 *
 * BookKeeper AI is local-first: the default model lives on a machine on the workstation's
 * Tailscale tailnet (Ollama, LM Studio, vLLM, llama.cpp). Cloud models (Anthropic, any
 * OpenAI-compatible API) are optional, opt-in per company, and every cloud call is redacted
 * (lib/ai/redact.ts) before it leaves the machine.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** JSON Schema the reply must satisfy (passed to providers that support constrained output). */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /** Abort signal (the router wires per-attempt timeouts through this). */
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  providerId: string;
}

export interface ModelInfo {
  id: string;
  /** Optional human label / size info. */
  label?: string;
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Every provider implements this. */
export interface AiProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** 'local' providers may receive unredacted data; 'cloud' ones never do. */
  readonly locality: Locality;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  listModels(opts?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
  health(opts?: { signal?: AbortSignal }): Promise<HealthResult>;
}

export type ProviderKind = 'ollama' | 'openai-compatible' | 'anthropic';
export type Locality = 'local' | 'cloud';

export const PROVIDER_KINDS: ProviderKind[] = ['ollama', 'openai-compatible', 'anthropic'];

/** Tasks the router knows about; each can have its own routing policy. */
export type AiTask = 'categorize' | 'assistant' | 'error-correction';
export const AI_TASKS: AiTask[] = ['categorize', 'assistant', 'error-correction'];

export const AI_TASK_LABELS: Record<AiTask, string> = {
  categorize: 'Transaction categorization',
  assistant: 'Bookkeeping assistant',
  'error-correction': 'Error review suggestions',
};

/**
 * 'local-only' (DEFAULT) — never leave the tailnet/LAN.
 * 'local-then-cloud'     — try local providers first, fall back to cloud (redacted).
 * 'cloud-only'           — cloud providers only (redacted).
 */
export type RoutingPolicy = 'local-only' | 'local-then-cloud' | 'cloud-only';
export const ROUTING_POLICIES: RoutingPolicy[] = ['local-only', 'local-then-cloud', 'cloud-only'];
export const DEFAULT_POLICY: RoutingPolicy = 'local-only';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** Provider configuration as persisted in ai_settings.providers. */
export interface StoredProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  /** Required for ollama / openai-compatible; optional override for anthropic. */
  baseUrl?: string | null;
  model: string;
  /** AES-GCM ciphertext (lib/ai/keyVault). Never plaintext, never sent to the client. */
  apiKeyEnc?: string | null;
  enabled: boolean;
  /** Per-call timeout; defaults applied by the router. */
  timeoutMs?: number | null;
}

/** Decrypted runtime config handed to provider factories (server-side only). */
export interface ProviderRuntimeConfig extends Omit<StoredProviderConfig, 'apiKeyEnc'> {
  apiKey?: string | null;
}

/** What the client sees: no key material, just whether one is set. */
export interface PublicProviderConfig extends Omit<StoredProviderConfig, 'apiKeyEnc'> {
  hasApiKey: boolean;
  /** Present when a key exists but cannot be decrypted (e.g. secret rotated) — must re-enter. */
  apiKeyUnreadable?: boolean;
  locality: Locality;
  hostClass: HostClass | null;
  warning: string | null;
}

export type HostClass = 'loopback' | 'lan' | 'tailnet' | 'public' | 'invalid';

/** Typed AI errors so callers can fall back deterministically. */
export class AiError extends Error {
  constructor(
    public code: 'UNAVAILABLE' | 'TIMEOUT' | 'HTTP' | 'BAD_OUTPUT' | 'NETWORK' | 'CONFIG',
    message: string,
    public details?: unknown,
    /** HTTP status when code === 'HTTP'. */
    public status?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** True for failures worth retrying against the same provider. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof AiError)) return false;
  if (err.code === 'NETWORK' || err.code === 'TIMEOUT') return true;
  if (err.code === 'HTTP') return err.status === 429 || (err.status ?? 0) >= 500;
  return false;
}
