/**
 * "Continue with ChatGPT" end to end (lib/services/chatgptSignIn.ts + lib/ai/chatgpt.ts), against
 * a fake OpenAI (auth.openai.com + api.openai.com) and the real loopback listener:
 *  - the sign-in URL carries OpenAI's parameters (PKCE S256, the plan scope, the API resource);
 *  - the browser's return is state-checked, the code is exchanged, the plan connection is saved
 *    (credentials sealed, never in the public settings), cloud AI is turned on for it;
 *  - chat goes to the Responses API (store false, streamed, system text as instructions);
 *  - an expired sign-in is refreshed once and the rotated credentials are saved;
 *  - a plan limit is reported in plain words and not retried;
 *  - declining "use my plan" fails the sign-in and leaves Privacy & Network as it was;
 *  - Disconnect removes it and signs out at OpenAI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { aiSettings, companies, users } from '@/lib/db/schema';
import { openStoredSecret, readVaultSecret } from '@/lib/ai/keyVault';
import { parseCredentials } from '@/lib/ai/chatgpt';
import { AiError, type StoredProviderConfig } from '@/lib/ai/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { buildProviders, getPublicSettings, loadSettings, testConnection, updateSettings } from './aiSettings';
import { getNetworkPolicy, setNetworkPolicy } from './networkPolicy';
import { cancelChatGptSignIn, chatGptSignInStatus, disconnectChatGpt, persistChatGptCredentials, startChatGptSignIn } from './chatgptSignIn';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-chatgpt-signin');
let db: DB;
let ctx: ServiceContext;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake OpenAI: discovery, token endpoint (code + refresh), models, Responses, revocation. */
function fakeOpenAi(opts: { grantSharing?: boolean; gate?: Promise<void> } = {}) {
  const s = {
    nonce: '',
    access: 'at-1',
    refresh: 'rt-1',
    revoked: [] as string[],
    responses: [] as Record<string, unknown>[],
    refreshes: 0,
    limitReached: false,
  };
  const scope = `openid profile email offline_access resource.invoke${opts.grantSharing === false ? '' : ' chatgpt.tokens.use.direct'}`;
  const fn = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const auth = new Headers(init.headers).get('authorization');
    if (u.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: 'https://auth.openai.com',
        authorization_endpoint: 'https://auth.openai.com/oauth/authorize',
        token_endpoint: 'https://auth.openai.com/oauth/token',
        revocation_endpoint: 'https://auth.openai.com/oauth/revoke',
        jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
      });
    }
    if (u.pathname === '/oauth/token') {
      const p = new URLSearchParams(String(init.body));
      if (p.get('resource') !== 'https://api.openai.com/v1') return json({ error: 'invalid_request' }, 400);
      if (p.get('grant_type') === 'authorization_code') {
        if (opts.gate) await opts.gate;
        if (p.get('code') !== 'code-123' || !p.get('code_verifier') || p.get('client_id') !== 'client_abc') return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: s.access,
          refresh_token: s.refresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope,
          id_token: jwt({ iss: 'https://auth.openai.com', aud: 'client_abc', sub: 'user-1', email: 'owner@example.com', nonce: s.nonce, exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 }),
        });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (p.get('refresh_token') !== s.refresh) return json({ error: 'refresh_token_reused' }, 400);
        s.refreshes += 1;
        s.access = `at-${s.refreshes + 1}`;
        s.refresh = `rt-${s.refreshes + 1}`;
        return json({ access_token: s.access, refresh_token: s.refresh, token_type: 'Bearer', expires_in: 3600 });
      }
    }
    if (u.pathname === '/oauth/revoke') {
      s.revoked.push(new URLSearchParams(String(init.body)).get('token') ?? '');
      return new Response('', { status: 200 });
    }
    if (u.origin === 'https://api.openai.com' && auth !== `Bearer ${s.access}`) return json({ error: { code: 'invalid_token' } }, 401);
    if (u.pathname === '/v1/models') return json({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' }, { slug: 'hidden', display_name: 'H', visibility: 'hide' }] });
    if (u.pathname === '/v1/responses') {
      s.responses.push(JSON.parse(String(init.body)));
      if (s.limitReached) return json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429);
      const events = [
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: '{"answer":' },
        { type: 'response.output_text.delta', delta: '42}' },
        { type: 'response.completed', response: {} },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ error: 'not_found' }, 404);
  };
  return { fn, s };
}

/** What the person's browser does after signing in: follow OpenAI's redirect to the listener. */
async function browserReturn(authUrl: string, fake: ReturnType<typeof fakeOpenAi>, override: Record<string, string> = {}) {
  const a = new URL(authUrl);
  fake.s.nonce = a.searchParams.get('nonce')!;
  const back = new URL(a.searchParams.get('redirect_uri')!);
  back.search = new URLSearchParams({ code: 'code-123', state: a.searchParams.get('state')!, client_id: 'client_abc', ...override }).toString();
  return fetch(back);
}

async function waitDone(attemptId: string) {
  for (let i = 0; i < 100; i++) {
    const st = await chatGptSignInStatus(ctx, attemptId);
    if (st.status !== 'pending') return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('sign-in never finished');
}

async function savedCreds() {
  const s = await loadSettings(ctx);
  const p = s.providers.find((x) => x.kind === 'chatgpt')!;
  return { p, creds: parseCredentials(openStoredSecret(p.apiKeyEnc!, ctx.companyId, await readVaultSecret(db)))! };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.BKA_NETWORK_MODE;
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'owner@chatgpt.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'ChatGPT Plan Co', ownerId: owner.id });
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Continue with ChatGPT', () => {
  it('declining "use my plan" fails the sign-in and leaves Privacy & Network as it was', async () => {
    const fake = fakeOpenAi({ grantSharing: false });
    const { attemptId, url } = await startChatGptSignIn(ctx, { fetch: fake.fn, port: 0 });
    expect((await browserReturn(url, fake)).status).toBe(200);
    const st = await waitDone(attemptId);
    expect(st).toMatchObject({ status: 'error' });
    expect((st as { error: string }).error).toMatch(/did not allow Ironbooks to use your ChatGPT plan/);
    expect((await getNetworkPolicy(ctx)).mode).toBe('tailnet-only');
    expect((await loadSettings(ctx)).providers).toHaveLength(0);
  });

  it('signs in through the browser and saves a sealed plan connection', async () => {
    const fake = fakeOpenAi();
    const { attemptId, url } = await startChatGptSignIn(ctx, { fetch: fake.fn, port: 0 });
    const a = new URL(url);
    expect(a.origin + a.pathname).toBe('https://auth.openai.com/oauth/authorize');
    // The first sign-in failed after registration, so the issued client id is already reused.
    expect(a.searchParams.get('client_id')).toBe('client_abc');
    expect(a.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(a.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(a.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    // Someone else's request with the wrong state is turned away and does not end the sign-in.
    expect((await browserReturn(url, fake, { state: 'forged' })).status).toBe(400);
    expect((await chatGptSignInStatus(ctx, attemptId)).status).toBe('pending');

    expect((await browserReturn(url, fake)).status).toBe(200);
    const st = await waitDone(attemptId);
    expect(st).toMatchObject({ status: 'done', account: 'owner@example.com', model: 'gpt-5.5' });

    const pub = await getPublicSettings(ctx);
    const row = pub.providers.find((p) => p.kind === 'chatgpt')!;
    expect(row).toMatchObject({ model: 'gpt-5.5', locality: 'cloud', account: 'owner@example.com', hasApiKey: true });
    expect(JSON.stringify(pub)).not.toMatch(/at-1|rt-1/);
    expect(pub.cloudEnabled).toBe(true);
    expect(pub.taskPolicies.assistant).toBe('local-then-cloud');
    expect((await getNetworkPolicy(ctx)).cloudOptIn.ai).toBe(true);
    const [raw] = await db.select({ providers: aiSettings.providers }).from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
    expect(JSON.stringify(raw.providers)).not.toMatch(/at-1|rt-1/);
    const [co] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
    expect((co.settings as Record<string, unknown>).aiChatGptClientId).toBe('client_abc');
  });

  it('chats through the Responses API on the plan, refreshing an expired sign-in once', async () => {
    const fake = fakeOpenAi();
    fake.s.access = 'at-1';
    fake.s.refresh = 'rt-1';
    const s = await loadSettings(ctx);
    const [provider] = buildProviders(s.providers, ctx, { fetch: fake.fn });
    expect(provider.kind).toBe('chatgpt');
    const r = await provider.chat(
      [
        { role: 'system', content: 'You are a bookkeeper.' },
        { role: 'user', content: 'What is 6 x 7?' },
      ],
      { jsonSchema: { type: 'object' }, temperature: 0.1, maxTokens: 100 },
    );
    expect(r.content).toBe('{"answer":42}');
    const body = fake.s.responses[0];
    expect(body).toMatchObject({ model: 'gpt-5.5', store: false, stream: true, input: [{ role: 'user', content: 'What is 6 x 7?' }] });
    expect(String(body.instructions)).toMatch(/You are a bookkeeper\.[\s\S]*JSON Schema/);
    expect(body).not.toHaveProperty('temperature');

    // OpenAI expires the access token: one refresh, the call succeeds, the new tokens are saved.
    fake.s.access = 'at-expired-elsewhere';
    fake.s.refresh = 'rt-1';
    fake.s.refreshes = 5;
    const again = await buildProviders((await loadSettings(ctx)).providers, ctx, { fetch: fake.fn })[0].chat([{ role: 'user', content: 'hi' }]);
    expect(again.content).toBe('{"answer":42}');
    expect(fake.s.refreshes).toBe(6);
    const { creds } = await savedCreds();
    expect(creds).toMatchObject({ accessToken: 'at-7', refreshToken: 'rt-7', subject: 'user-1' });
  });

  it('a reached plan limit is reported in plain words and not retried', async () => {
    const fake = fakeOpenAi();
    fake.s.access = 'at-7';
    fake.s.refresh = 'rt-7';
    fake.s.limitReached = true;
    const [provider] = buildProviders((await loadSettings(ctx)).providers, ctx, { fetch: fake.fn });
    const err = await provider.chat([{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/plan limit for Ironbooks is reached/);
    expect(fake.s.responses).toHaveLength(1);
  });

  it('a ChatGPT row cannot be given a pasted key through the settings form', async () => {
    const { updateSettings } = await import('./aiSettings');
    const pub = await getPublicSettings(ctx);
    const rows = pub.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: p.enabled }));
    await expect(updateSettings(ctx, { providers: rows.map((r) => ({ ...r, apiKey: '{"v":1}' })) })).rejects.toThrow(/Continue with ChatGPT/);
    // Saving the form unchanged keeps the sign-in.
    await updateSettings(ctx, { providers: rows });
    expect((await savedCreds()).creds.subject).toBe('user-1');
  });

  it('Test connection saves a refreshed sign-in (rotated tokens are never only in memory)', async () => {
    const fake = fakeOpenAi();
    fake.s.access = 'at-elsewhere';
    fake.s.refresh = 'rt-7';
    fake.s.refreshes = 7;
    const { p } = await savedCreds();
    const r = await testConnection(ctx, { id: p.id, kind: 'chatgpt', label: p.label, model: p.model, enabled: true }, { fetch: fake.fn });
    expect(r.ok).toBe(true);
    expect((await savedCreds()).creds).toMatchObject({ accessToken: 'at-9', refreshToken: 'rt-9' });
  });

  it('a page save without the ChatGPT row keeps the connection (only Disconnect removes it)', async () => {
    await updateSettings(ctx, { providers: [] });
    expect((await savedCreds()).creds.subject).toBe('user-1');
  });

  it('a refresh for another account or with older tokens never overwrites the saved sign-in', async () => {
    const { p, creds } = await savedCreds();
    await persistChatGptCredentials(ctx, p.id, { ...creds, subject: 'someone-else', accessToken: 'x', expiresAt: Date.now() + 9e9 });
    await persistChatGptCredentials(ctx, p.id, { ...creds, accessToken: 'older', expiresAt: creds.expiresAt - 1000 });
    expect((await savedCreds()).creds).toMatchObject({ subject: 'user-1', accessToken: 'at-9' });
  });

  it('Cancel after the browser came back: nothing is saved and the new sign-in is revoked', async () => {
    let release!: () => void;
    const fake = fakeOpenAi({ gate: new Promise<void>((r) => (release = r)) });
    const { attemptId, url } = await startChatGptSignIn(ctx, { fetch: fake.fn, port: 0 });
    expect((await browserReturn(url, fake)).status).toBe(200);
    await cancelChatGptSignIn(ctx, attemptId);
    release();
    expect(await waitDone(attemptId)).toEqual({ status: 'error', error: 'Sign-in was cancelled.' });
    expect((await savedCreds()).creds.accessToken).toBe('at-9');
    expect(fake.s.revoked).toContain('rt-1');
  });

  it('Disconnect removes the connection and signs out at OpenAI', async () => {
    const fake = fakeOpenAi();
    const r = await disconnectChatGpt(ctx, { fetch: fake.fn });
    expect(r.revoked).toBe(true);
    expect(fake.s.revoked).toEqual(['rt-9']);
    expect((await loadSettings(ctx)).providers.filter((p: StoredProviderConfig) => p.kind === 'chatgpt')).toHaveLength(0);
  });

  it('cancelling a sign-in puts Privacy & Network back as it was', async () => {
    await setNetworkPolicy(ctx, { mode: 'tailnet-only' });
    const { attemptId } = await startChatGptSignIn(ctx, { fetch: fakeOpenAi().fn, port: 0 });
    expect((await getNetworkPolicy(ctx)).mode).toBe('allow-cloud');
    await cancelChatGptSignIn(ctx, attemptId);
    expect(await chatGptSignInStatus(ctx, attemptId)).toEqual({ status: 'error', error: 'Sign-in was cancelled.' });
    for (let i = 0; i < 50 && (await getNetworkPolicy(ctx)).mode !== 'tailnet-only'; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await getNetworkPolicy(ctx)).mode).toBe('tailnet-only');
  });

  it('cancelling gives back only the cloud-AI switch it turned on (other Privacy & Network changes stay)', async () => {
    await setNetworkPolicy(ctx, { mode: 'tailnet-only' });
    const { attemptId } = await startChatGptSignIn(ctx, { fetch: fakeOpenAi().fn, port: 0 });
    const mid = await getNetworkPolicy(ctx);
    await setNetworkPolicy(ctx, { mode: 'allow-cloud', cloudOptIn: { ...mid.cloudOptIn, email: true } });
    await cancelChatGptSignIn(ctx, attemptId);
    for (let i = 0; i < 50 && (await getNetworkPolicy(ctx)).cloudOptIn.ai; i++) await new Promise((r) => setTimeout(r, 20));
    const after = await getNetworkPolicy(ctx);
    expect(after.cloudOptIn).toMatchObject({ ai: false, email: true });
    expect(after.mode).toBe('allow-cloud');
  });

  it('a double click runs one sign-in; finishing it keeps cloud AI allowed', async () => {
    await setNetworkPolicy(ctx, { mode: 'tailnet-only' });
    const fake = fakeOpenAi();
    const [a, b] = await Promise.allSettled([startChatGptSignIn(ctx, { fetch: fake.fn, port: 0 }), startChatGptSignIn(ctx, { fetch: fake.fn, port: 0 })]);
    const started = [a, b].filter((x): x is PromiseFulfilledResult<{ attemptId: string; url: string }> => x.status === 'fulfilled').map((x) => x.value);
    const live = [];
    for (const s of started) if ((await chatGptSignInStatus(ctx, s.attemptId)).status === 'pending') live.push(s);
    expect(live).toHaveLength(1);
    expect((await browserReturn(live[0].url, fake)).status).toBe(200);
    expect(await waitDone(live[0].attemptId)).toMatchObject({ status: 'done' });
    await new Promise((r) => setTimeout(r, 100));
    expect((await getNetworkPolicy(ctx)).cloudOptIn.ai).toBe(true);
    await disconnectChatGpt(ctx, { fetch: fake.fn });
  });

  it('offline mode is respected: sign-in does not start', async () => {
    await setNetworkPolicy(ctx, { mode: 'offline' });
    await expect(startChatGptSignIn(ctx, { fetch: fakeOpenAi().fn, port: 0 })).rejects.toThrow(/Offline mode/);
  });
});
