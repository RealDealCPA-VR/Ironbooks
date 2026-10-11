/**
 * Model providers: Ollama, OpenAI-compatible servers (LM Studio / vLLM / llama.cpp / cloud
 * APIs) and Anthropic (via @anthropic-ai/sdk). Each implements { chat, listModels, health }.
 *
 * Locality: ollama / openai-compatible endpoints on loopback, LAN or the tailnet are 'local'
 * (may receive unredacted data). The SAME kinds pointed at a public host are 'cloud' and get
 * the full cloud treatment (company opt-in + redaction). Anthropic is always 'cloud'.
 *
 * `fetch` and the Anthropic client are injectable so tests never touch the network.
 *
 * Network policy (lib/net/policy.ts): EVERY provider HTTP call goes through lib/net/guard.ts
 * with purpose 'ai' -- `policyFetch` for Ollama / OpenAI-compatible (every redirect hop is
 * re-checked) and `assertOutboundAllowed` plus a policy-checked `fetch` for the Anthropic SDK.
 * In the default 'tailnet-only' mode loopback / LAN / tailnet model servers are reachable and
 * public hosts are refused unless the company opted in to cloud AI (Privacy & Network). A
 * provider built without a policy context (`deps.policyCtx`) and without an injected test
 * transport refuses to make any call (fails closed).
 */
import Anthropic from '@anthropic-ai/sdk';
import { assertOutboundAllowed, policyFetch, type PolicyCtx } from '@/lib/net/guard';
import { ServiceError } from '@/lib/services/_base';
import { classifyEndpoint } from './tailnet';
import {
  AiError,
  DEFAULT_ANTHROPIC_MODEL,
  type AiProvider,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type HealthResult,
  type Locality,
  type ModelInfo,
  type ProviderRuntimeConfig,
} from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Minimal slice of the Anthropic SDK we use — lets tests pass a fake. */
export interface AnthropicLike {
  messages: {
    create(body: {
      model: string;
      max_tokens: number;
      system?: string;
      temperature?: number;
      messages: { role: 'user' | 'assistant'; content: string }[];
    }, opts?: { signal?: AbortSignal }): Promise<{ content: Array<{ type: string; text?: string }>; model?: string }>;
  };
  models: {
    list(params?: unknown, opts?: { signal?: AbortSignal }): PromiseLike<{ data: Array<{ id: string; display_name?: string }> }>;
  };
}

export interface ProviderDeps {
  fetch?: FetchLike;
  anthropicFactory?: (cfg: { apiKey: string; baseURL?: string; fetch?: FetchLike }) => AnthropicLike;
  /**
   * Company whose network policy governs this provider's calls (purpose 'ai'). Production code
   * always passes it (lib/services/aiSettings.ts). When set, an injected `fetch` is only the
   * transport underneath the policy check.
   */
  policyCtx?: PolicyCtx;
}

/** Turn a network-policy refusal into a typed AI error the router can fall back on. */
function policyError(err: unknown): AiError | null {
  if (err instanceof ServiceError && err.code === 'FORBIDDEN') {
    return new AiError('POLICY', `Blocked by network policy: ${err.message}`, err.details);
  }
  return null;
}

const NO_POLICY_MESSAGE = 'AI provider built without a network-policy context; refusing to connect.';

/**
 * The transport every Ollama / OpenAI-compatible call uses: policy-checked when a policy
 * context is present, the injected test transport otherwise, and a hard refusal when neither
 * is available (never an unchecked global fetch).
 */
function guardedFetch(deps: ProviderDeps): FetchLike {
  const ctx = deps.policyCtx;
  if (ctx) {
    return async (input, init) => {
      try {
        return await policyFetch(input, init, { purpose: 'ai', ctx, fetchImpl: deps.fetch });
      } catch (err) {
        throw policyError(err) ?? err;
      }
    };
  }
  if (deps.fetch) return deps.fetch;
  return async () => {
    throw new AiError('POLICY', NO_POLICY_MESSAGE);
  };
}

export function localityOf(cfg: Pick<ProviderRuntimeConfig, 'kind' | 'baseUrl'>): Locality {
  if (cfg.kind === 'anthropic') return 'cloud';
  return classifyEndpoint(cfg.baseUrl).isPrivate ? 'local' : 'cloud';
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

async function httpJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof AiError) throw err; // e.g. POLICY (network-policy refusal)
    const e = err as Error;
    if (e?.name === 'AbortError' || init.signal?.aborted) {
      throw new AiError('TIMEOUT', `Request to ${new URL(url).host} timed out.`);
    }
    throw new AiError('NETWORK', `Could not reach ${new URL(url).host}: ${e?.message ?? err}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new AiError('HTTP', `HTTP ${res.status} from ${new URL(url).host}${detail ? `: ${detail}` : ''}`, undefined, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new AiError('BAD_OUTPUT', `Invalid JSON response from ${new URL(url).host}.`);
  }
}

async function timeHealth(fn: () => Promise<unknown>): Promise<HealthResult> {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Ollama — POST /api/chat, GET /api/tags
// ---------------------------------------------------------------------------

export function createOllamaProvider(cfg: ProviderRuntimeConfig, deps: ProviderDeps = {}): AiProvider {
  const fetchImpl = guardedFetch(deps);
  if (!cfg.baseUrl) throw new AiError('CONFIG', 'Ollama provider needs a base URL.');
  const base = trimSlash(cfg.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`; // reverse-proxy auth, optional

  return {
    id: cfg.id,
    kind: 'ollama',
    locality: localityOf(cfg),
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.1,
          ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        },
      };
      // Ollama >= 0.5 accepts a JSON schema as `format`; older builds accept 'json'.
      if (opts.jsonSchema) body.format = opts.jsonSchema;
      const data = await httpJson<{ message?: { content?: string }; model?: string }>(fetchImpl, `${base}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      const content = data.message?.content;
      if (typeof content !== 'string') throw new AiError('BAD_OUTPUT', 'Ollama returned no message content.');
      return { content, model: data.model ?? cfg.model, providerId: cfg.id };
    },
    async listModels(o = {}): Promise<ModelInfo[]> {
      const data = await httpJson<{ models?: { name: string; details?: { parameter_size?: string } }[] }>(
        fetchImpl,
        `${base}/api/tags`,
        { method: 'GET', headers, signal: o.signal },
      );
      return (data.models ?? []).map((m) => ({ id: m.name, label: m.details?.parameter_size }));
    },
    health(o = {}) {
      return timeHealth(() => httpJson(fetchImpl, `${base}/api/tags`, { method: 'GET', headers, signal: o.signal }));
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible — POST /v1/chat/completions, GET /v1/models
// ---------------------------------------------------------------------------

/** Accept both "http://host:1234" and "http://host:1234/v1" as base URLs. */
export function openAiBase(baseUrl: string): string {
  const b = trimSlash(baseUrl);
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

export function createOpenAiCompatibleProvider(cfg: ProviderRuntimeConfig, deps: ProviderDeps = {}): AiProvider {
  const fetchImpl = guardedFetch(deps);
  if (!cfg.baseUrl) throw new AiError('CONFIG', 'OpenAI-compatible provider needs a base URL.');
  const base = openAiBase(cfg.baseUrl);
  const locality = localityOf(cfg);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  async function complete(messages: ChatMessage[], opts: ChatOptions, withSchema: boolean) {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: opts.temperature ?? 0.1,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // Cloud APIs: ask the provider not to retain the conversation (OpenAI `store`).
      ...(locality === 'cloud' ? { store: false } : {}),
    };
    if (withSchema && opts.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'response', schema: opts.jsonSchema, strict: false },
      };
    }
    return httpJson<{ choices?: { message?: { content?: string } }[]; model?: string }>(
      fetchImpl,
      `${base}/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal },
    );
  }

  return {
    id: cfg.id,
    kind: 'openai-compatible',
    locality,
    async chat(messages, opts = {}) {
      let data;
      try {
        data = await complete(messages, opts, true);
      } catch (err) {
        // Some servers reject response_format/json_schema — retry once without it; the
        // router still validates the JSON with zod.
        if (opts.jsonSchema && err instanceof AiError && err.code === 'HTTP' && (err.status === 400 || err.status === 422)) {
          data = await complete(messages, opts, false);
        } else {
          throw err;
        }
      }
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new AiError('BAD_OUTPUT', 'Model returned no message content.');
      return { content, model: data.model ?? cfg.model, providerId: cfg.id };
    },
    async listModels(o = {}) {
      const data = await httpJson<{ data?: { id: string }[] }>(fetchImpl, `${base}/models`, {
        method: 'GET',
        headers,
        signal: o.signal,
      });
      return (data.data ?? []).map((m) => ({ id: m.id }));
    },
    health(o = {}) {
      return timeHealth(() => httpJson(fetchImpl, `${base}/models`, { method: 'GET', headers, signal: o.signal }));
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic — @anthropic-ai/sdk
// ---------------------------------------------------------------------------

function defaultAnthropicFactory(cfg: { apiKey: string; baseURL?: string; fetch?: FetchLike }): AnthropicLike {
  // maxRetries: 0 -- the router owns retry policy. `fetch` is the policy-checked transport.
  return new Anthropic({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    maxRetries: 0,
    ...(cfg.fetch ? { fetch: cfg.fetch as unknown as typeof fetch } : {}),
  }) as unknown as AnthropicLike;
}

/** The endpoint the Anthropic SDK contacts when no base URL is configured. */
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

function mapSdkError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const blocked = policyError(err);
  if (blocked) return blocked;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof AiError) return cause;
  const e = err as { status?: number; name?: string; message?: string };
  if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return new AiError('TIMEOUT', 'Anthropic request timed out.');
  if (typeof e?.status === 'number') return new AiError('HTTP', `Anthropic HTTP ${e.status}: ${e.message ?? ''}`.trim(), undefined, e.status);
  return new AiError('NETWORK', `Anthropic request failed: ${e?.message ?? err}`);
}

export function createAnthropicProvider(cfg: ProviderRuntimeConfig, deps: ProviderDeps = {}): AiProvider {
  if (!cfg.apiKey) throw new AiError('CONFIG', 'Anthropic provider needs an API key.');
  const endpoint = cfg.baseUrl || DEFAULT_ANTHROPIC_BASE_URL;
  const policyCtx = deps.policyCtx;
  if (!policyCtx && !deps.anthropicFactory) {
    // Production always supplies the policy context; never build an unchecked cloud client.
    throw new AiError('POLICY', NO_POLICY_MESSAGE);
  }
  const client = (deps.anthropicFactory ?? defaultAnthropicFactory)({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl || undefined,
    // Every SDK request (and redirect hop) is re-checked against the policy.
    ...(policyCtx ? { fetch: guardedFetch(deps) } : {}),
  });
  const model = cfg.model || DEFAULT_ANTHROPIC_MODEL;

  /** Refuse before any data is handed to the SDK when the policy blocks the endpoint. */
  async function assertAllowed(): Promise<void> {
    if (!policyCtx) return; // injected test client
    try {
      await assertOutboundAllowed(endpoint, 'ai', policyCtx);
    } catch (err) {
      throw policyError(err) ?? err;
    }
  }

  async function listModels(o: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    await assertAllowed();
    try {
      const page = await client.models.list(undefined, { signal: o.signal });
      return page.data.map((m) => ({ id: m.id, label: m.display_name }));
    } catch (err) {
      throw mapSdkError(err);
    }
  }

  return {
    id: cfg.id,
    kind: 'anthropic',
    locality: 'cloud',
    async chat(messages, opts = {}) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
      if (opts.jsonSchema) {
        system.push(
          `Reply with ONLY a JSON value (no markdown fences, no prose) that conforms to this JSON Schema:\n${JSON.stringify(opts.jsonSchema)}`,
        );
      }
      // Anthropic needs alternating user/assistant turns starting with 'user' — merge runs.
      const turns: { role: 'user' | 'assistant'; content: string }[] = [];
      for (const m of messages) {
        if (m.role === 'system') continue;
        const last = turns[turns.length - 1];
        if (last && last.role === m.role) last.content += `\n\n${m.content}`;
        else turns.push({ role: m.role, content: m.content });
      }
      if (turns.length === 0 || turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(start)' });
      await assertAllowed();
      try {
        const res = await client.messages.create(
          {
            model,
            max_tokens: opts.maxTokens ?? 1024,
            ...(system.length ? { system: system.join('\n\n') } : {}),
            temperature: opts.temperature ?? 0.1,
            messages: turns,
          },
          { signal: opts.signal },
        );
        const content = res.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
        return { content, model: res.model ?? model, providerId: cfg.id };
      } catch (err) {
        throw mapSdkError(err);
      }
    },
    listModels,
    health(o = {}) {
      return timeHealth(() => listModels(o));
    },
  };
}

/** Build a provider from runtime config. */
export function createProvider(cfg: ProviderRuntimeConfig, deps: ProviderDeps = {}): AiProvider {
  switch (cfg.kind) {
    case 'ollama':
      return createOllamaProvider(cfg, deps);
    case 'openai-compatible':
      return createOpenAiCompatibleProvider(cfg, deps);
    case 'anthropic':
      return createAnthropicProvider(cfg, deps);
    default:
      throw new AiError('CONFIG', `Unknown provider kind: ${(cfg as { kind: string }).kind}`);
  }
}
