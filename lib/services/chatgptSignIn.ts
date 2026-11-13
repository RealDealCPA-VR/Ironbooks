/**
 * "Continue with ChatGPT" — connect the person's ChatGPT Plus / Pro plan (lib/ai/chatgpt.ts).
 *
 * Flow (OpenAI's loopback sign-in for local apps):
 *  1. start(): an admin clicks the button. Ironbooks gets the cloud-AI permission (the same
 *     switch "Allow cloud AI" gives; kept only if sign-in succeeds), opens a one-shot listener on
 *     127.0.0.1:1455 (any free port if that one is taken) and returns OpenAI's sign-in URL, which
 *     the page opens in the person's own browser. Ironbooks never sees their password.
 *  2. OpenAI redirects the browser to the listener with a one-time code (state-checked); the
 *     code is traded for credentials, the "use my plan" permission is confirmed, and a ChatGPT
 *     provider is saved — credentials sealed with the company file's key (lib/ai/keyVault), the
 *     model set to the plan's first listed model, cloud AI turned on for this company, and
 *     "local only" tasks moved to "local first, then cloud" so a local model still goes first.
 *  3. The page polls status() until the attempt is done.
 *
 * The listener only works when the browser runs on the same computer as Ironbooks (the desktop
 * app, or the server's own machine) — the redirect goes to 127.0.0.1.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { aiSettings, companies } from '@/lib/db/schema';
import { policyFetch } from '@/lib/net/guard';
import { sealForFile } from '@/lib/ai/keyVault';
import {
  CHATGPT_CALLBACK_PATH,
  CHATGPT_CALLBACK_PORT,
  CHATGPT_FIRST_CLIENT_ID,
  CHATGPT_SHARING_SCOPE,
  authorizationUrl,
  discover,
  exchangeCode,
  listChatGptModels,
  parseCredentials,
  randomValue,
  revokeCredentials,
  type ChatGptCredentials,
  type ChatGptDiscovery,
} from '@/lib/ai/chatgpt';
import { AiError, type AiTask, type RoutingPolicy, type StoredProviderConfig } from '@/lib/ai/types';
import { ServiceError, inTransaction, notFound, validation, writeAudit, type ServiceContext } from './_base';
import { requireRole } from './rbac';
import { loadSettings } from './aiSettings';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The issued client id is reused for every later sign-in (not secret; travels with the file). */
const CLIENT_ID_KEY = 'aiChatGptClientId';
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const APP_NAME = 'Ironbooks';

export type SignInStatus =
  | { status: 'pending' }
  | { status: 'done'; providerId: string; account: string | null; model: string }
  | { status: 'error'; error: string };

interface Attempt {
  id: string;
  companyId: string;
  userId: string | null;
  result: SignInStatus;
  close: () => void;
  /** A cancel putting Privacy & Network back; a new sign-in waits for it. */
  undoing?: Promise<void>;
  expires: number;
}

const g = globalThis as unknown as { __ibChatGptAttempts?: Map<string, Attempt> };
const attempts = (g.__ibChatGptAttempts ??= new Map());

function policyTransport(ctx: Pick<ServiceContext, 'db' | 'companyId'>, transport?: FetchLike): FetchLike {
  return async (input, init) => {
    try {
      return await policyFetch(input, init, { purpose: 'ai', ctx: { db: ctx.db, companyId: ctx.companyId }, fetchImpl: transport });
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw new AiError('POLICY', `Blocked by network policy: ${err.message}`);
      throw err;
    }
  };
}

async function savedClientId(ctx: Pick<ServiceContext, 'db' | 'companyId'>): Promise<string | null> {
  const [row] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const v = (row?.settings as Record<string, unknown> | null)?.[CLIENT_ID_KEY];
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v) ? v : null;
}

async function saveClientId(ctx: Pick<ServiceContext, 'db' | 'companyId'>, clientId: string): Promise<void> {
  await ctx.db
    .update(companies)
    .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${CLIENT_ID_KEY}::text, ${clientId}::text)` })
    .where(eq(companies.id, ctx.companyId));
}

/**
 * Save (or replace) the company's ChatGPT connection and turn cloud AI on for it. Returns the
 * provider id. Used by sign-in; exported for tests.
 */
export async function saveChatGptConnection(ctx: ServiceContext, creds: ChatGptCredentials, model: string): Promise<string> {
  const current = await loadSettings(ctx);
  const existing = current.providers.find((p) => p.kind === 'chatgpt');
  const id = existing?.id ?? crypto.randomUUID();
  const label = 'ChatGPT (your plan)';
  return inTransaction(ctx, async (tx) => {
    const sealed = await sealForFile(tx.db, JSON.stringify(creds), tx.companyId);
    const entry: StoredProviderConfig = {
      id,
      kind: 'chatgpt',
      label,
      baseUrl: null,
      model: model || existing?.model || '',
      apiKeyEnc: sealed,
      enabled: true,
      timeoutMs: existing?.timeoutMs ?? null,
    };
    const providers = existing ? current.providers.map((p) => (p.id === id ? entry : p)) : [...current.providers, entry];
    // A local model (if any) still answers first; the plan is the fallback — or the only AI.
    const taskPolicies = Object.fromEntries(
      Object.entries(current.taskPolicies).map(([t, pol]) => [t, pol === 'local-only' ? 'local-then-cloud' : pol]),
    ) as Record<AiTask, RoutingPolicy>;
    const values = {
      providers: providers as unknown as Record<string, unknown>[],
      taskPolicies: taskPolicies as Record<string, string>,
      cloudEnabled: true,
      updatedAt: new Date(),
    };
    const [row] = await tx.db.select({ id: aiSettings.id }).from(aiSettings).where(eq(aiSettings.companyId, tx.companyId));
    if (row) await tx.db.update(aiSettings).set(values).where(eq(aiSettings.id, row.id));
    else await tx.db.insert(aiSettings).values({ companyId: tx.companyId, autoApplyEnabled: false, autoApplyThreshold: '0.9500', llmSuggestEnabled: true, ...values });
    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'ai_settings',
      entityId: tx.companyId,
      oldValues: existing ? { chatgpt: { model: existing.model } } : null,
      newValues: { chatgpt: { id, model: entry.model, account: creds.email }, cloudEnabled: true, taskPolicies },
    });
    return id;
  });
}

/** Save rotated credentials for an existing ChatGPT provider (token refresh). No audit entry. */
export async function persistChatGptCredentials(ctx: Pick<ServiceContext, 'db' | 'companyId'>, providerId: string, creds: ChatGptCredentials): Promise<void> {
  const sealed = await sealForFile(ctx.db, JSON.stringify(creds), ctx.companyId);
  const [row] = await ctx.db.select({ id: aiSettings.id, providers: aiSettings.providers }).from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
  if (!row) return;
  const providers = (row.providers as unknown as StoredProviderConfig[]) ?? [];
  if (!providers.some((p) => p.id === providerId && p.kind === 'chatgpt')) return;
  const next = providers.map((p) => (p.id === providerId ? { ...p, apiKeyEnc: sealed } : p));
  await ctx.db.update(aiSettings).set({ providers: next as unknown as Record<string, unknown>[] }).where(eq(aiSettings.id, row.id));
}

function listen(port: number, handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => {
      server.removeListener('error', reject);
      const a = server.address();
      resolve({ server, port: a && typeof a !== 'string' ? a.port : port });
    });
  });
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{font:17px system-ui;max-width:32rem;margin:18vh auto;padding:24px;color:#202123}h1{font-size:24px}</style><h1>${title}</h1><p>${body}</p></html>`;

export interface StartDeps {
  /** Transport under the network-policy check (tests). */
  fetch?: FetchLike;
  /** Callback port (tests pass 0). */
  port?: number;
}

/** Begin a sign-in. Returns the URL to open in the person's browser and the attempt to poll. */
export async function startChatGptSignIn(ctx: ServiceContext, deps: StartDeps = {}): Promise<{ attemptId: string; url: string }> {
  await requireRole(ctx, 'admin');
  // One sign-in at a time per company.
  for (const a of attempts.values()) {
    if (a.companyId !== ctx.companyId || a.result.status !== 'pending') continue;
    a.close();
    await a.undoing;
  }

  const { allowCloudPurpose, getNetworkPolicy, setNetworkPolicy } = await import('./networkPolicy');
  const policyBefore = await getNetworkPolicy(ctx);
  const allowed = await allowCloudPurpose(ctx, 'ai');
  if (allowed.notice) throw validation(allowed.notice);
  const undoCloud = async () => {
    if (allowed.changed) await setNetworkPolicy(ctx, policyBefore).catch(() => undefined);
  };

  const fetchImpl = policyTransport(ctx, deps.fetch);
  let d: ChatGptDiscovery;
  try {
    d = await discover(fetchImpl);
  } catch (err) {
    await undoCloud();
    throw validation(err instanceof Error ? err.message : 'Could not reach ChatGPT sign-in.');
  }
  const clientId = await savedClientId(ctx);
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue();
  const id = crypto.randomUUID();
  const attempt: Attempt = { id, companyId: ctx.companyId, userId: ctx.userId, result: { status: 'pending' }, close: () => undefined, expires: Date.now() + ATTEMPT_TTL_MS };
  let port = deps.port ?? CHATGPT_CALLBACK_PORT;
  let settled = false;

  const finish = async (code: string, issuedClientId: string, redirectUri: string) => {
    try {
      if (issuedClientId !== clientId) await saveClientId(ctx, issuedClientId);
      const creds = await exchangeCode(fetchImpl, d, { clientId: issuedClientId, code, verifier, redirectUri, nonce });
      if (!creds.scopes.includes(CHATGPT_SHARING_SCOPE)) {
        throw new AiError('CONFIG', 'You signed in, but did not allow Ironbooks to use your ChatGPT plan. Click "Continue with ChatGPT" again and allow it.');
      }
      let model = '';
      try {
        model = (await listChatGptModels(fetchImpl, creds.accessToken))[0]?.id ?? '';
      } catch {
        /* the person can pick a model on the page */
      }
      const providerId = await saveChatGptConnection(ctx, creds, model);
      attempt.result = { status: 'done', providerId, account: creds.email, model };
    } catch (err) {
      await undoCloud();
      attempt.result = { status: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      attempt.close();
    }
  };

  const handler: http.RequestListener = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      res.writeHead(400).end('Invalid request');
      return;
    }
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || url.pathname !== CHATGPT_CALLBACK_PATH || settled) {
      res.writeHead(404).end('Not found');
      return;
    }
    const got = Buffer.from(url.searchParams.get('state') ?? '');
    const want = Buffer.from(state);
    if (url.searchParams.getAll('state').length !== 1 || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      res.writeHead(400).end('This sign-in does not match. Go back to Ironbooks and click "Continue with ChatGPT" again.');
      return;
    }
    settled = true;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const oauthError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const issued = url.searchParams.get('client_id') ?? clientId;
    if (oauthError || !code || !issued || issued === CHATGPT_FIRST_CLIENT_ID || !/^[A-Za-z0-9_-]{1,200}$/.test(issued) || (clientId && url.searchParams.get('client_id') && issued !== clientId)) {
      res.end(PAGE('Sign-in not completed', 'You can close this tab and go back to Ironbooks.'));
      attempt.result = { status: 'error', error: oauthError === 'access_denied' ? 'Sign-in was cancelled.' : 'ChatGPT did not finish the sign-in. Try again.' };
      void undoCloud();
      attempt.close();
      return;
    }
    res.end(PAGE('Back to Ironbooks', 'Ironbooks is finishing the connection to your ChatGPT plan. You can close this tab.'));
    void finish(code, issued, `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`);
  };

  let listener: { server: http.Server; port: number };
  try {
    listener = await listen(port, handler).catch(() => listen(0, handler));
  } catch {
    await undoCloud();
    throw validation('Ironbooks could not open its sign-in listener on this computer. Close other apps that may be signing in to ChatGPT and try again.');
  }
  port = listener.port;
  const timer = setTimeout(() => {
    if (attempt.result.status === 'pending') {
      attempt.result = { status: 'error', error: 'Sign-in timed out. Click "Continue with ChatGPT" to try again.' };
      void undoCloud();
    }
    attempt.close();
  }, ATTEMPT_TTL_MS);
  timer.unref?.();
  attempt.close = () => {
    clearTimeout(timer);
    listener.server.close();
    listener.server.closeAllConnections?.();
    // Cancelled before the browser came back: put Privacy & Network back as it was. (Once the
    // browser is back, `finish` decides — it keeps the permission only on success.)
    if (attempt.result.status === 'pending' && !settled) {
      attempt.result = { status: 'error', error: 'Sign-in was cancelled.' };
      attempt.undoing = undoCloud();
    }
  };
  attempts.set(id, attempt);
  // Forget finished attempts after a while.
  for (const [k, a] of attempts) if (a.expires + ATTEMPT_TTL_MS < Date.now()) attempts.delete(k);

  const redirectUri = `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`;
  const url = authorizationUrl(d, { clientId, redirectUri, state, nonce, verifier, appName: APP_NAME });
  return { attemptId: id, url };
}

export async function chatGptSignInStatus(ctx: ServiceContext, attemptId: string): Promise<SignInStatus> {
  await requireRole(ctx, 'admin');
  const a = attempts.get(attemptId);
  if (!a || a.companyId !== ctx.companyId) throw notFound('Sign-in');
  return a.result;
}

export async function cancelChatGptSignIn(ctx: ServiceContext, attemptId: string): Promise<void> {
  await requireRole(ctx, 'admin');
  const a = attempts.get(attemptId);
  if (a && a.companyId === ctx.companyId) a.close();
}

/**
 * Disconnect: remove the ChatGPT connection from this company and sign Ironbooks out at OpenAI
 * (best effort — `revoked: false` means the person may also remove it in ChatGPT's settings).
 */
export async function disconnectChatGpt(ctx: ServiceContext, deps: { fetch?: FetchLike } = {}): Promise<{ revoked: boolean }> {
  await requireRole(ctx, 'admin');
  const s = await loadSettings(ctx);
  const p = s.providers.find((x) => x.kind === 'chatgpt');
  if (!p) return { revoked: true };
  const { openStoredSecret, readVaultSecret } = await import('@/lib/ai/keyVault');
  const creds = p.apiKeyEnc ? parseCredentials(openStoredSecret(p.apiKeyEnc, ctx.companyId, await readVaultSecret(ctx.db))) : null;
  await inTransaction(ctx, async (tx) => {
    const providers = s.providers.filter((x) => x.id !== p.id);
    await tx.db
      .update(aiSettings)
      .set({ providers: providers as unknown as Record<string, unknown>[], updatedAt: new Date() })
      .where(eq(aiSettings.companyId, tx.companyId));
    await writeAudit(tx, { action: 'delete', entityType: 'ai_settings', entityId: tx.companyId, oldValues: { chatgpt: { id: p.id, model: p.model } }, newValues: null });
  });
  if (!creds) return { revoked: true };
  return { revoked: await revokeCredentials(policyTransport(ctx, deps.fetch), creds) };
}

