/**
 * ChatGPT plan protocol details (lib/ai/chatgpt.ts): the ID token checks, the Responses stream
 * reader's failure cases, OpenAI error codes in plain words, and one shared refresh when several
 * requests find the sign-in expired at once (refresh tokens rotate; a reused one is rejected).
 */
import { describe, expect, it } from 'vitest';
import {
  chatGptError,
  readResponseStream,
  refreshCredentials,
  toResponsesRequest,
  verifyIdToken,
  type ChatGptCredentials,
} from './chatgpt';
import { AiError } from './types';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const good = { iss: 'https://auth.openai.com', aud: 'client_1', sub: 'u1', email: 'a@b.c', nonce: 'n1', exp: Math.floor(Date.now() / 1000) + 600 };
const sse = (events: unknown[], tail = '') => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + tail, { status: 200 });

describe('verifyIdToken', () => {
  it('accepts the expected issuer, audience, nonce and expiry', () => {
    expect(verifyIdToken(jwt(good), 'client_1', 'n1')).toEqual({ subject: 'u1', email: 'a@b.c' });
  });
  it.each([
    ['another issuer', { iss: 'https://evil.example' }],
    ['another app', { aud: 'client_2' }],
    ['a replayed sign-in (nonce)', { nonce: 'n2' }],
    ['an expired token', { exp: 1000 }],
    ['no subject', { sub: '' }],
  ])('rejects %s', (_name, patch) => {
    expect(() => verifyIdToken(jwt({ ...good, ...patch }), 'client_1', 'n1')).toThrow(/could not verify/);
  });
  it('rejects garbage', () => {
    expect(() => verifyIdToken('not-a-jwt', 'client_1', 'n1')).toThrow(AiError);
  });
});

describe('Responses API', () => {
  it('puts system text in instructions and never sends images', () => {
    const r = toResponsesRequest('m', [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
    expect(r).toEqual({ model: 'm', input: [{ role: 'user', content: 'U' }], instructions: 'S', store: false, stream: true });
    expect(() => toResponsesRequest('m', [{ role: 'user', content: 'x', images: ['iVBOR'] }])).toThrow(/local model/);
  });

  it('a stream that ends before response.completed is an error, not a partial answer', async () => {
    await expect(readResponseStream(sse([{ type: 'response.output_text.delta', delta: 'half' }]))).rejects.toThrow(/cut off/);
  });

  it('response.failed and response.incomplete are errors', async () => {
    await expect(readResponseStream(sse([{ type: 'response.failed', response: { error: { code: 'model_not_found' } } }]))).rejects.toThrow(/not available on your ChatGPT plan/);
    await expect(readResponseStream(sse([{ type: 'response.incomplete' }]))).rejects.toThrow(/stopped before finishing/);
  });

  it('reads deltas split across chunks and CRLF line endings', async () => {
    const text = 'data: {"type":"response.output_text.delta","delta":"Hel"}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"lo"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n';
    const enc = new TextEncoder().encode(text);
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < enc.length; i += 7) c.enqueue(enc.slice(i, i + 7));
        c.close();
      },
    });
    expect(await readResponseStream(new Response(body))).toBe('Hello');
  });
});

describe('errors', () => {
  it('plan limits and ineligible accounts are UNAVAILABLE (the router moves on, no retry)', () => {
    const limit = chatGptError({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429);
    expect(limit.code).toBe('UNAVAILABLE');
    expect(chatGptError({ error: { code: 'subscription_sharing_v2_user_not_eligible' } }, 403).message).toMatch(/Plus or Pro/);
    expect(chatGptError({ error: 'refresh_token_reused' }, 400).message).toMatch(/Sign in with ChatGPT again/);
  });
});

describe('refresh', () => {
  it('several expired requests share one refresh (the rotated refresh token is used once)', async () => {
    let calls = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/a', token_endpoint: 'https://auth.openai.com/t' });
      }
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ access_token: 'new', refresh_token: 'r2', token_type: 'Bearer', expires_in: 3600 });
    };
    const c: ChatGptCredentials = { v: 1, clientId: 'cid-share', accessToken: 'old', refreshToken: 'r1', expiresAt: 0, scopes: ['chatgpt.tokens.use.direct'], subject: 's-share', email: null };
    const [a, b, d] = await Promise.all([refreshCredentials(fetchImpl, c), refreshCredentials(fetchImpl, c), refreshCredentials(fetchImpl, c)]);
    expect(calls).toBe(1);
    expect([a.accessToken, b.accessToken, d.accessToken]).toEqual(['new', 'new', 'new']);
    expect(a.refreshToken).toBe('r2');
  });
});
