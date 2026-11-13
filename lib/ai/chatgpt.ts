/**
 * "Continue with ChatGPT" — use the person's own ChatGPT Plus / Pro plan instead of an API key.
 *
 * OpenAI's Sign in with ChatGPT lets open-source and locally hosted apps spend the signed-in
 * person's plan usage (https://developers.openai.com/siwc/token-sharing-open-source). Ironbooks
 * is both. The protocol below follows OpenAI's own reference implementation
 * (github.com/openai/sign-in-with-chatgpt-devkit, packages/local/src/oauth.ts and responses.ts):
 *
 *  - OAuth 2.0 authorization code + PKCE against https://auth.openai.com, endpoints taken from its
 *    OpenID discovery document; the first sign-in registers the app (client_id
 *    "dynamic_agent_client"), and the issued client id is reused after that.
 *  - Scopes: identity + offline_access + resource.invoke + chatgpt.tokens.use.direct (the "use my
 *    plan" permission, which the person can decline — then the plan cannot be used).
 *  - Inference: the Responses API at https://api.openai.com/v1 with the access token as a bearer
 *    token, `store: false`, `stream: true`; system guidance goes in `instructions` (system-role
 *    messages are refused); sampling parameters are not sent.
 *  - Access tokens last about an hour and are refreshed with the refresh token, which ROTATES:
 *    every refresh is persisted, and concurrent refreshes in this process share one request.
 *
 * Locality is always 'cloud': calls are redacted, counted against the daily cloud limit and
 * need the company's cloud-AI permission like any other cloud provider. Every HTTP call goes
 * through the network-policy guard (purpose 'ai') via the `fetch` this module is handed.
 */
import crypto from 'node:crypto';
import { AiError, type AiProvider, type ChatMessage, type ChatOptions, type ModelInfo, type ProviderRuntimeConfig } from './types';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const CHATGPT_SHARING_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_FIRST_CLIENT_ID = 'dynamic_agent_client';
/** The callback port OpenAI's examples use; any free port works if it is taken. */
export const CHATGPT_CALLBACK_PORT = 1455;
export const CHATGPT_CALLBACK_PATH = '/auth/callback';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What is sealed in the provider's apiKeyEnc (lib/ai/keyVault) — never sent to the browser. */
export interface ChatGptCredentials {
  v: 1;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  /** OpenID subject: the ChatGPT account this connection belongs to. */
  subject: string;
  email: string | null;
}

export function parseCredentials(secret: string | null | undefined): ChatGptCredentials | null {
  if (!secret) return null;
  try {
    const c = JSON.parse(secret) as ChatGptCredentials;
    if (c && c.v === 1 && typeof c.accessToken === 'string' && typeof c.clientId === 'string' && typeof c.subject === 'string') return c;
  } catch {
    /* not a ChatGPT credential */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors: OpenAI's codes in plain words (from the devkit's errors.ts)
// ---------------------------------------------------------------------------

const KNOWN_ERRORS: Record<string, string> = {
  subscription_sharing_user_not_eligible: 'This ChatGPT account cannot share its plan with apps (it needs ChatGPT Plus or Pro, and some work accounts do not allow it).',
  subscription_sharing_usage_limit_exceeded: 'Your ChatGPT plan limit for Ironbooks is reached. Raise it at chatgpt.com → Settings → Usage, or wait for it to reset.',
  subscription_sharing_usage_unavailable: 'ChatGPT could not check your plan usage right now. Try again shortly.',
  subscription_sharing_unsupported_capability: 'ChatGPT plan sharing does not support this kind of request.',
  subscription_sharing_route_not_supported: 'ChatGPT plan sharing does not support this kind of request.',
  subscription_sharing_invalid_user: 'ChatGPT could not confirm the plan of the signed-in account. Sign in again.',
  subscription_sharing_user_unavailable: 'Your ChatGPT account is temporarily unavailable. Try again shortly.',
  subscription_sharing_v2_client_not_enabled: 'OpenAI has not enabled plan sharing for this app.',
  invalid_grant: 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.',
  invalid_refresh_token: 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.',
  token_expired: 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.',
  refresh_token_expired: 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.',
  refresh_token_invalidated: 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.',
  refresh_token_reused: 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.',
  invalid_token: 'ChatGPT did not accept the saved sign-in. Sign in with ChatGPT again.',
  access_denied: 'Sign-in was not completed.',
  model_not_found: 'That model is not available on your ChatGPT plan. Pick another under AI & Automation.',
};

function errorCode(body: unknown): string | null {
  let d: unknown = body;
  for (let i = 0; i < 4 && d && typeof d === 'object'; i++) {
    const o = d as Record<string, unknown>;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.code === 'string') return o.code;
    d = o.error ?? o.detail ?? o.response;
  }
  return null;
}

/** An AiError for an OpenAI error body. Plan limits are UNAVAILABLE (never retried; the router moves on). */
export function chatGptError(body: unknown, status?: number): AiError {
  const code = errorCode(body);
  const norm = code?.replace(/_v2_/, '_') ?? null;
  const known = code ? KNOWN_ERRORS[norm!] ?? KNOWN_ERRORS[code] : undefined;
  if (norm === 'subscription_sharing_usage_limit_exceeded' || norm === 'subscription_sharing_user_not_eligible') {
    return new AiError('UNAVAILABLE', known!, { code });
  }
  if (known) return new AiError('HTTP', known, { code }, status === 429 ? 400 : status);
  if (status === 401) return new AiError('HTTP', 'ChatGPT did not accept the saved sign-in. Sign in with ChatGPT again.', { code }, 401);
  if (status === 429) return new AiError('HTTP', 'ChatGPT is busy. Wait a moment and try again.', { code }, 429);
  if (status && status >= 500) return new AiError('HTTP', 'ChatGPT is temporarily unavailable. Try again shortly.', { code }, status);
  return new AiError('HTTP', `ChatGPT could not complete the request${code ? ` (${code})` : ''}.`, { code }, status);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function call(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (err) {
    if (err instanceof AiError) throw err; // network-policy refusal
    const e = err as Error;
    if (e?.name === 'AbortError' || init.signal?.aborted) throw new AiError('TIMEOUT', 'ChatGPT did not answer in time.');
    throw new AiError('NETWORK', `Could not reach ChatGPT: ${e?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// OAuth: discovery, authorization URL, code exchange, refresh, revocation
// ---------------------------------------------------------------------------

export interface ChatGptDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

export async function discover(fetchImpl: FetchLike): Promise<ChatGptDiscovery> {
  const res = await call(fetchImpl, `${CHATGPT_ISSUER}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  const data = (await readJson(res)) as Record<string, unknown> | undefined;
  const sameOrigin = (v: unknown) => {
    try {
      return typeof v === 'string' && new URL(v).origin === CHATGPT_ISSUER;
    } catch {
      return false;
    }
  };
  if (!res.ok || !data || data.issuer !== CHATGPT_ISSUER || !sameOrigin(data.authorization_endpoint) || !sameOrigin(data.token_endpoint)) {
    throw new AiError('HTTP', 'ChatGPT sign-in could not be verified (OpenAI discovery document). Try again shortly.');
  }
  return {
    authorization_endpoint: data.authorization_endpoint as string,
    token_endpoint: data.token_endpoint as string,
    ...(sameOrigin(data.revocation_endpoint) ? { revocation_endpoint: data.revocation_endpoint as string } : {}),
  };
}

export const randomValue = () => crypto.randomBytes(32).toString('base64url');
export const pkceChallenge = (verifier: string) => crypto.createHash('sha256').update(verifier).digest('base64url');

export function authorizationUrl(
  d: ChatGptDiscovery,
  p: { clientId: string | null; redirectUri: string; state: string; nonce: string; verifier: string; appName: string; loginHint?: string | null },
): string {
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: p.clientId ?? CHATGPT_FIRST_CLIENT_ID,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge_method: 'S256',
    code_challenge: pkceChallenge(p.verifier),
  }).toString();
  if (!p.clientId) u.searchParams.set('agent_name_hint', p.appName);
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

/** The claims of a JWT, without checking its signature (see verifyIdToken). */
function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Check the ID token's claims: issuer, audience (our client id), nonce, expiry and subject. The
 * token arrives straight from OpenAI's token endpoint over HTTPS (never through the browser), so
 * — as OpenID Connect Core 3.1.3.7 allows for that case — TLS stands in for a signature check.
 */
export function verifyIdToken(idToken: unknown, clientId: string, nonce: string | null, now = Date.now()): { subject: string; email: string | null } {
  const c = typeof idToken === 'string' ? jwtClaims(idToken) : null;
  const aud = c?.aud;
  const audOk = typeof aud === 'string' ? aud === clientId : Array.isArray(aud) && aud.includes(clientId) && (aud.length === 1 || c?.azp === clientId);
  if (
    !c ||
    c.iss !== CHATGPT_ISSUER ||
    !audOk ||
    (c.azp !== undefined && c.azp !== clientId) ||
    typeof c.sub !== 'string' ||
    !c.sub ||
    typeof c.exp !== 'number' ||
    c.exp * 1000 < now - 5000 ||
    (nonce !== null && c.nonce !== nonce)
  ) {
    throw new AiError('CONFIG', 'ChatGPT returned a sign-in Ironbooks could not verify. Sign in again.');
  }
  return { subject: c.sub, email: typeof c.email === 'string' ? c.email : null };
}

async function tokenRequest(fetchImpl: FetchLike, d: ChatGptDiscovery, body: URLSearchParams, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await call(fetchImpl, d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal,
  });
  const data = await readJson(res);
  if (!res.ok) throw chatGptError(data, res.status);
  if (!data || typeof data !== 'object') throw new AiError('BAD_OUTPUT', 'ChatGPT returned an invalid sign-in response.');
  return data as Record<string, unknown>;
}

function tokenFields(data: Record<string, unknown>, previousScopes?: string[]) {
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previousScopes;
  if (!scopes) throw new AiError('BAD_OUTPUT', 'ChatGPT did not confirm the granted permissions. Sign in again.');
  if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
    throw new AiError('BAD_OUTPUT', 'ChatGPT returned incomplete credentials. Sign in again.');
  }
  if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer') {
    throw new AiError('BAD_OUTPUT', 'ChatGPT returned an unexpected credential type. Sign in again.');
  }
  return {
    scopes,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
  };
}

/** Finish a sign-in: trade the one-time code for credentials and check who signed in. */
export async function exchangeCode(
  fetchImpl: FetchLike,
  d: ChatGptDiscovery,
  p: { clientId: string; code: string; verifier: string; redirectUri: string; nonce: string },
): Promise<ChatGptCredentials> {
  const data = await tokenRequest(
    fetchImpl,
    d,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: p.clientId,
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource: CHATGPT_RESOURCE,
    }),
  );
  const who = verifyIdToken(data.id_token, p.clientId, p.nonce);
  return { v: 1, clientId: p.clientId, ...tokenFields(data), ...who };
}

/** One in-flight refresh per ChatGPT connection in this process (refresh tokens rotate). */
const g = globalThis as unknown as { __ibChatGptRefresh?: Map<string, Promise<ChatGptCredentials>>; __ibChatGptLatest?: Map<string, ChatGptCredentials> };
const inflight = (g.__ibChatGptRefresh ??= new Map());
/** The newest credentials seen per connection — a provider built from older saved settings uses these. */
const latest = (g.__ibChatGptLatest ??= new Map());
const connKey = (c: Pick<ChatGptCredentials, 'clientId' | 'subject'>) => `${c.clientId}|${c.subject}`;

export function newestCredentials(c: ChatGptCredentials): ChatGptCredentials {
  const l = latest.get(connKey(c));
  return l && l.expiresAt > c.expiresAt ? l : c;
}

export async function refreshCredentials(fetchImpl: FetchLike, c: ChatGptCredentials, signal?: AbortSignal): Promise<ChatGptCredentials> {
  const key = connKey(c);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    if (!c.refreshToken) throw new AiError('HTTP', 'Your ChatGPT sign-in has expired. Sign in with ChatGPT again.', undefined, 401);
    const d = await discover(fetchImpl);
    const data = await tokenRequest(
      fetchImpl,
      d,
      new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refreshToken, resource: CHATGPT_RESOURCE }),
      signal,
    );
    const f = tokenFields(data, c.scopes);
    let who = { subject: c.subject, email: c.email };
    if (data.id_token !== undefined) {
      who = verifyIdToken(data.id_token, c.clientId, null);
      if (who.subject !== c.subject) throw new AiError('CONFIG', 'ChatGPT refreshed a different account. Sign in with ChatGPT again.');
    }
    const next: ChatGptCredentials = { ...c, ...f, refreshToken: f.refreshToken ?? c.refreshToken, ...who };
    latest.set(key, next);
    return next;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Sign out at OpenAI too (best effort — the local credentials are removed either way). */
export async function revokeCredentials(fetchImpl: FetchLike, c: ChatGptCredentials): Promise<boolean> {
  latest.delete(connKey(c));
  const token = c.refreshToken ?? c.accessToken;
  try {
    const d = await discover(fetchImpl);
    if (!d.revocation_endpoint) return false;
    const res = await call(fetchImpl, d.revocation_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: c.refreshToken ? 'refresh_token' : 'access_token', client_id: c.clientId }).toString(),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Models and the Responses API
// ---------------------------------------------------------------------------

export async function listChatGptModels(fetchImpl: FetchLike, accessToken: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const res = await call(fetchImpl, `${CHATGPT_RESOURCE}/models`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal,
  });
  const body = (await readJson(res)) as { models?: unknown; data?: unknown } | undefined;
  if (!res.ok) throw chatGptError(body, res.status);
  // Plan sharing lists { models: [{ slug, display_name, visibility }] }; tolerate the API shape too.
  if (Array.isArray(body?.models)) {
    return (body!.models as Array<Record<string, unknown>>)
      .filter((m) => m && typeof m.slug === 'string' && (m.visibility === undefined || m.visibility === 'list'))
      .map((m) => ({ id: m.slug as string, ...(typeof m.display_name === 'string' ? { label: m.display_name } : {}) }));
  }
  if (Array.isArray(body?.data)) {
    return (body!.data as Array<Record<string, unknown>>).filter((m) => typeof m?.id === 'string').map((m) => ({ id: m.id as string }));
  }
  throw new AiError('BAD_OUTPUT', 'ChatGPT returned an unexpected model list.');
}

/** Responses API input: system messages become `instructions`; the rest are user/assistant turns. */
export function toResponsesRequest(model: string, messages: ChatMessage[], opts: ChatOptions = {}) {
  if (messages.some((m) => m.images?.length)) throw new AiError('POLICY', 'Images are only sent to a local model.');
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content);
  if (opts.jsonSchema) {
    instructions.push(`Reply with ONLY a JSON value (no markdown fences, no prose) that conforms to this JSON Schema:\n${JSON.stringify(opts.jsonSchema)}`);
  }
  const input = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  if (input.length === 0) input.push({ role: 'user', content: '(start)' });
  return {
    model,
    input,
    ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    store: false,
    stream: true,
  };
}

/** Read a Responses API event stream to its `response.completed` event; returns the text. */
export async function readResponseStream(res: Response): Promise<string> {
  if (!res.body) throw new AiError('BAD_OUTPUT', 'ChatGPT returned no response stream.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = false;
  const onEvent = (raw: string) => {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data);
    } catch {
      throw new AiError('BAD_OUTPUT', 'ChatGPT sent an unreadable response.');
    }
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') text += ev.delta;
    else if (ev.type === 'response.failed' || ev.type === 'error') throw chatGptError(ev.type === 'error' ? ev : ev.response, 400);
    else if (ev.type === 'response.incomplete') throw new AiError('BAD_OUTPUT', 'ChatGPT stopped before finishing its answer.');
    else if (ev.type === 'response.completed') completed = true;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      onEvent(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      if (completed) {
        await reader.cancel().catch(() => undefined);
        return text;
      }
    }
  }
  if (buffer.trim()) onEvent(buffer);
  if (!completed) throw new AiError('NETWORK', 'The ChatGPT answer was cut off. Try again.');
  return text;
}

export interface ChatGptProviderDeps {
  /** The policy-checked transport (lib/ai/providers.ts guardedFetch). */
  fetch: FetchLike;
  /** Save rotated credentials (sealed into the company file). */
  persist?: (providerId: string, creds: ChatGptCredentials) => Promise<void>;
}

export function createChatGptProvider(cfg: ProviderRuntimeConfig, deps: ChatGptProviderDeps): AiProvider {
  const saved = parseCredentials(cfg.apiKey);
  if (!saved) throw new AiError('CONFIG', 'Sign in with ChatGPT first (AI & Automation).');
  if (!saved.scopes.includes(CHATGPT_SHARING_SCOPE)) {
    throw new AiError('CONFIG', 'You signed in to ChatGPT without allowing Ironbooks to use your plan. Sign in again and allow it.');
  }
  let creds = newestCredentials(saved);

  async function fresh(force: boolean, signal?: AbortSignal): Promise<ChatGptCredentials> {
    creds = newestCredentials(creds);
    if (!force && creds.expiresAt - 60_000 > Date.now()) return creds;
    const before = creds.accessToken;
    creds = await refreshCredentials(deps.fetch, creds, signal);
    if (creds.accessToken !== before && deps.persist) await deps.persist(cfg.id, creds).catch((e) => console.warn('[ai] could not save refreshed ChatGPT sign-in:', e));
    return creds;
  }

  /** One authorized call; a 401 refreshes the sign-in once and retries. */
  async function authed(run: (token: string) => Promise<Response>, signal?: AbortSignal): Promise<Response> {
    let res = await run((await fresh(false, signal)).accessToken);
    if (res.status === 401 && creds.refreshToken) {
      await res.body?.cancel().catch(() => undefined);
      res = await run((await fresh(true, signal)).accessToken);
    }
    return res;
  }

  const listModels = async (o: { signal?: AbortSignal } = {}) => {
    const c = await fresh(false, o.signal);
    try {
      return await listChatGptModels(deps.fetch, c.accessToken, o.signal);
    } catch (err) {
      if (!(err instanceof AiError && err.status === 401)) throw err;
      return listChatGptModels(deps.fetch, (await fresh(true, o.signal)).accessToken, o.signal);
    }
  };

  return {
    id: cfg.id,
    kind: 'chatgpt',
    locality: 'cloud',
    async chat(messages, opts = {}) {
      if (!cfg.model) throw new AiError('CONFIG', 'Pick a ChatGPT model under AI & Automation.');
      const body = JSON.stringify(toResponsesRequest(cfg.model, messages, opts));
      const res = await authed(
        (token) =>
          call(deps.fetch, `${CHATGPT_RESOURCE}/responses`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
            body,
            signal: opts.signal,
          }),
        opts.signal,
      );
      if (!res.ok) throw chatGptError(await readJson(res), res.status);
      const content = await readResponseStream(res);
      return { content, model: cfg.model, providerId: cfg.id };
    },
    listModels,
    async health(o = {}) {
      const start = Date.now();
      try {
        await listModels(o);
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
