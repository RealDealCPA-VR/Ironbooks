/**
 * Providers + router, with fetch and the Anthropic SDK mocked — no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAiCompatibleProvider,
  localityOf,
  openAiBase,
  type AnthropicLike,
  type FetchLike,
} from './providers';
import { AiRouter } from './router';
import { Redactor } from './redact';
import { extractJson } from './json';
import { AiError, type AiProvider, type ChatMessage } from './types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn: FetchLike = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return handler(url, init);
  };
  return { fn, calls };
}

describe('Ollama provider', () => {
  it('posts to /api/chat with schema as format and reads message.content', async () => {
    const f = mockFetch(() => jsonResponse({ model: 'llama3.1:8b', message: { role: 'assistant', content: '{"a":1}' } }));
    const p = createOllamaProvider({ id: 'o', kind: 'ollama', label: 'GPU', baseUrl: 'http://gpu-box.tail1234.ts.net:11434/', model: 'llama3.1:8b', enabled: true }, { fetch: f.fn });
    expect(p.locality).toBe('local');
    const res = await p.chat([{ role: 'user', content: 'hi' }], { jsonSchema: { type: 'object' }, temperature: 0, maxTokens: 50 });
    expect(res.content).toBe('{"a":1}');
    expect(f.calls[0].url).toBe('http://gpu-box.tail1234.ts.net:11434/api/chat');
    expect(f.calls[0].body).toMatchObject({ model: 'llama3.1:8b', stream: false, format: { type: 'object' }, options: { temperature: 0, num_predict: 50 } });
  });

  it('lists models from /api/tags and reports health', async () => {
    const f = mockFetch(() => jsonResponse({ models: [{ name: 'qwen2.5:14b', details: { parameter_size: '14B' } }] }));
    const p = createOllamaProvider({ id: 'o', kind: 'ollama', label: 'x', baseUrl: 'http://100.64.0.9:11434', model: 'm', enabled: true }, { fetch: f.fn });
    expect(await p.listModels()).toEqual([{ id: 'qwen2.5:14b', label: '14B' }]);
    expect((await p.health()).ok).toBe(true);
    expect(f.calls[0].url).toBe('http://100.64.0.9:11434/api/tags');
  });

  it('maps network failures and HTTP errors to AiError', async () => {
    const down = createOllamaProvider({ id: 'o', kind: 'ollama', label: 'x', baseUrl: 'http://10.0.0.2:11434', model: 'm', enabled: true }, {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'NETWORK' });
    const h = await down.health();
    expect(h.ok).toBe(false);

    const err500 = createOllamaProvider({ id: 'o', kind: 'ollama', label: 'x', baseUrl: 'http://10.0.0.2:11434', model: 'm', enabled: true }, {
      fetch: async () => new Response('boom', { status: 500 }),
    });
    await expect(err500.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'HTTP', status: 500 });
  });

  it('an Ollama on a PUBLIC host is classified as cloud', () => {
    expect(localityOf({ kind: 'ollama', baseUrl: 'http://203.0.113.4:11434' })).toBe('cloud');
  });
});

describe('OpenAI-compatible provider', () => {
  it('normalizes base URLs', () => {
    expect(openAiBase('http://h:1234')).toBe('http://h:1234/v1');
    expect(openAiBase('http://h:1234/v1/')).toBe('http://h:1234/v1');
  });

  it('sends response_format + bearer key; local servers get no store flag', async () => {
    const f = mockFetch(() => jsonResponse({ model: 'qwen', choices: [{ message: { content: 'ok' } }] }));
    const p = createOpenAiCompatibleProvider({ id: 'l', kind: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://192.168.1.5:1234', model: 'qwen', apiKey: 'sk-local', enabled: true }, { fetch: f.fn });
    await p.chat([{ role: 'user', content: 'x' }], { jsonSchema: { type: 'object' } });
    expect(f.calls[0].url).toBe('http://192.168.1.5:1234/v1/chat/completions');
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-local');
    expect(f.calls[0].body.response_format.type).toBe('json_schema');
    expect(f.calls[0].body.store).toBeUndefined();
  });

  it('cloud endpoints ask the provider not to store the conversation', async () => {
    const f = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const p = createOpenAiCompatibleProvider({ id: 'c', kind: 'openai-compatible', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt', apiKey: 'k', enabled: true }, { fetch: f.fn });
    expect(p.locality).toBe('cloud');
    await p.chat([{ role: 'user', content: 'x' }]);
    expect(f.calls[0].body.store).toBe(false);
  });

  it('retries once without response_format when the server rejects it', async () => {
    let n = 0;
    const f = mockFetch(() => (++n === 1 ? new Response('unsupported response_format', { status: 400 }) : jsonResponse({ choices: [{ message: { content: '{}' } }] })));
    const p = createOpenAiCompatibleProvider({ id: 'l', kind: 'openai-compatible', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080', model: 'm', enabled: true }, { fetch: f.fn });
    expect((await p.chat([{ role: 'user', content: 'x' }], { jsonSchema: { type: 'object' } })).content).toBe('{}');
    expect(f.calls[1].body.response_format).toBeUndefined();
  });

  it('lists /v1/models', async () => {
    const f = mockFetch(() => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    const p = createOpenAiCompatibleProvider({ id: 'l', kind: 'openai-compatible', label: 'x', baseUrl: 'http://127.0.0.1:8000/v1', model: 'm', enabled: true }, { fetch: f.fn });
    expect((await p.listModels()).map((m) => m.id)).toEqual(['a', 'b']);
    expect(f.calls[0].url).toBe('http://127.0.0.1:8000/v1/models');
  });
});

describe('Anthropic provider (SDK mocked)', () => {
  function fakeClient() {
    const create = vi.fn(async () => ({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hello' }] }));
    const client: AnthropicLike = {
      messages: { create },
      models: { list: async () => ({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet' }] }) },
    };
    return { client, create };
  }

  it('defaults the model, folds system messages, merges same-role turns, and is cloud', async () => {
    const { client, create } = fakeClient();
    let seenKey = '';
    const p = createAnthropicProvider({ id: 'a', kind: 'anthropic', label: 'Claude', model: '', apiKey: 'sk-ant', enabled: true }, {
      anthropicFactory: (cfg) => {
        seenKey = cfg.apiKey;
        return client;
      },
    });
    expect(p.locality).toBe('cloud');
    expect(seenKey).toBe('sk-ant');
    const res = await p.chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
      { jsonSchema: { type: 'object' } },
    );
    expect(res.content).toBe('hello');
    const body = (create.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.system).toContain('sys');
    expect(body.system).toContain('JSON Schema');
    expect(body.messages).toEqual([{ role: 'user', content: 'a\n\nb' }]);
    expect(await p.listModels()).toEqual([{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet' }]);
  });

  it('requires an API key', () => {
    expect(() => createAnthropicProvider({ id: 'a', kind: 'anthropic', label: 'x', model: 'm', enabled: true })).toThrow(AiError);
  });

  it('maps SDK HTTP errors', async () => {
    const client: AnthropicLike = {
      messages: { create: async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); } },
      models: { list: async () => ({ data: [] }) },
    };
    const p = createAnthropicProvider({ id: 'a', kind: 'anthropic', label: 'x', model: 'm', apiKey: 'k', enabled: true }, { anthropicFactory: () => client });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'HTTP', status: 529 });
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function fakeProvider(id: string, locality: 'local' | 'cloud', replies: Array<string | Error>): AiProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    id,
    kind: locality === 'local' ? 'ollama' : 'anthropic',
    locality,
    seen,
    async chat(messages) {
      seen.push(messages);
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { content: r, model: `${id}-model`, providerId: id };
    },
    async listModels() {
      return [];
    },
    async health() {
      return { ok: true, latencyMs: 1 };
    },
  };
}

const noSleep = async () => {};

describe('AiRouter policies', () => {
  it("defaults to 'local-only' and never touches cloud", async () => {
    const local = fakeProvider('local', 'local', ['hi']);
    const cloud = fakeProvider('cloud', 'cloud', ['cloud hi']);
    const r = new AiRouter({ providers: [cloud, local], cloudEnabled: true, sleep: noSleep });
    expect(r.candidates('assistant').map((p) => p.id)).toEqual(['local']);
    const res = await r.chat('assistant', [{ role: 'user', content: 'x' }]);
    expect(res.providerId).toBe('local');
    expect(cloud.seen).toHaveLength(0);
  });

  it('local-then-cloud falls back to cloud only when local fails', async () => {
    const local = fakeProvider('local', 'local', [new AiError('NETWORK', 'down')]);
    const cloud = fakeProvider('cloud', 'cloud', ['from cloud']);
    const r = new AiRouter({ providers: [local, cloud], cloudEnabled: true, taskPolicies: { assistant: 'local-then-cloud' }, retries: 1, sleep: noSleep });
    const res = await r.chat('assistant', [{ role: 'user', content: 'x' }]);
    expect(res.providerId).toBe('cloud');
    expect(local.seen).toHaveLength(2); // retried once
    expect(res.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it('cloud is never used when the company has not enabled it', async () => {
    const cloud = fakeProvider('cloud', 'cloud', ['x']);
    const r = new AiRouter({ providers: [cloud], cloudEnabled: false, taskPolicies: { assistant: 'cloud-only' } });
    expect(r.isAvailable('assistant')).toBe(false);
    expect(r.unavailableReason('assistant')).toMatch(/turned off/);
    await expect(r.chat('assistant', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(cloud.seen).toHaveLength(0);
  });

  it('does not retry non-transient errors', async () => {
    const local = fakeProvider('local', 'local', [new AiError('HTTP', 'bad request', undefined, 400)]);
    const r = new AiRouter({ providers: [local], cloudEnabled: false, retries: 3, sleep: noSleep });
    await expect(r.chat('categorize', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(local.seen).toHaveLength(1);
  });

  it('times out a hung provider', async () => {
    const hung: AiProvider = {
      id: 'hung', kind: 'ollama', locality: 'local',
      chat: () => new Promise(() => {}),
      listModels: async () => [],
      health: async () => ({ ok: true, latencyMs: 0 }),
    };
    const r = new AiRouter({ providers: [hung], cloudEnabled: false, localTimeoutMs: 20, retries: 0 });
    await expect(r.chat('categorize', [{ role: 'user', content: 'x' }])).rejects.toThrow(/timed out/);
  });
});

describe('AiRouter redaction', () => {
  it('cloud calls are redacted and replies restored; local calls are not redacted', async () => {
    const cloud = fakeProvider('cloud', 'cloud', ['Yes, [CUSTOMER_1] paid.']);
    const r = new AiRouter({
      providers: [cloud],
      cloudEnabled: true,
      taskPolicies: { assistant: 'cloud-only' },
      redactorFactory: () => new Redactor([{ text: 'Acme Corporation', kind: 'CUSTOMER' }]),
    });
    const res = await r.chat('assistant', [{ role: 'user', content: 'Did Acme Corporation (ap@acme.com) pay?' }]);
    const wire = cloud.seen[0][0].content;
    expect(wire).not.toContain('Acme');
    expect(wire).not.toContain('ap@acme.com');
    expect(res.content).toBe('Yes, Acme Corporation paid.');
    expect(res.redacted).toBe(true);

    const local = fakeProvider('local', 'local', ['ok']);
    const r2 = new AiRouter({ providers: [local], cloudEnabled: false, redactorFactory: () => new Redactor([{ text: 'Acme Corporation', kind: 'CUSTOMER' }]) });
    const res2 = await r2.chat('assistant', [{ role: 'user', content: 'Acme Corporation' }]);
    expect(local.seen[0][0].content).toBe('Acme Corporation');
    expect(res2.redacted).toBe(false);
  });

  it('cloud calls are pattern-redacted even without a company redactor', async () => {
    const cloud = fakeProvider('cloud', 'cloud', ['ok']);
    const r = new AiRouter({ providers: [cloud], cloudEnabled: true, taskPolicies: { categorize: 'cloud-only' } });
    await r.chat('categorize', [{ role: 'user', content: 'SSN 123-45-6789 email a@b.co' }]);
    expect(cloud.seen[0][0].content).not.toMatch(/6789|a@b\.co/);
  });
});

describe('AiRouter structured JSON', () => {
  const schema = z.object({ accountCode: z.enum(['6000', '6100']), confidence: z.number() });

  it('parses fenced JSON', async () => {
    const p = fakeProvider('l', 'local', ['Sure!\n```json\n{"accountCode":"6000","confidence":0.7}\n```']);
    const r = new AiRouter({ providers: [p], cloudEnabled: false });
    const res = await r.chatJson('categorize', [{ role: 'user', content: 'x' }], schema);
    expect(res.data).toEqual({ accountCode: '6000', confidence: 0.7 });
    expect(res.repaired).toBe(false);
  });

  it('makes exactly one repair attempt with the validation error', async () => {
    const p = fakeProvider('l', 'local', ['{"accountCode":"9999","confidence":0.9}', '{"accountCode":"6100","confidence":0.6}']);
    const r = new AiRouter({ providers: [p], cloudEnabled: false });
    const res = await r.chatJson('categorize', [{ role: 'user', content: 'x' }], schema);
    expect(res.data.accountCode).toBe('6100');
    expect(res.repaired).toBe(true);
    const repairTurn = p.seen[1];
    expect(repairTurn[repairTurn.length - 1].content).toMatch(/not valid: accountCode/);
  });

  it('gives up on a provider after a failed repair and tries the next one', async () => {
    const bad = fakeProvider('bad', 'local', ['nope', 'still nope']);
    const good = fakeProvider('good', 'local', ['{"accountCode":"6000","confidence":1}']);
    const r = new AiRouter({ providers: [bad, good], cloudEnabled: false });
    const res = await r.chatJson('categorize', [{ role: 'user', content: 'x' }], schema);
    expect(res.providerId).toBe('good');
    expect(bad.seen).toHaveLength(2);
  });

  it('restores placeholders inside parsed JSON from cloud models', async () => {
    const cloud = fakeProvider('c', 'cloud', ['{"who":"[VENDOR_1]"}']);
    const r = new AiRouter({ providers: [cloud], cloudEnabled: true, taskPolicies: { assistant: 'cloud-only' }, redactorFactory: () => new Redactor([{ text: 'Bob Plumbing', kind: 'VENDOR' }]) });
    const res = await r.chatJson('assistant', [{ role: 'user', content: 'Bob Plumbing' }], z.object({ who: z.string() }));
    expect(res.data.who).toBe('Bob Plumbing');
  });

  it('cloud repair turns quote placeholders, never restored values', async () => {
    const cloud = fakeProvider('c', 'cloud', ['{"who":"[VENDOR_1]","n":"x"}', '{"who":"6000","n":1}']);
    const r = new AiRouter({ providers: [cloud], cloudEnabled: true, taskPolicies: { assistant: 'cloud-only' }, redactorFactory: () => new Redactor([{ text: 'Bob Plumbing', kind: 'VENDOR' }]) });
    await r.chatJson('assistant', [{ role: 'user', content: 'Bob Plumbing' }], z.object({ who: z.enum(['6000', '6100']), n: z.number() }));
    const repair = cloud.seen[1][cloud.seen[1].length - 1].content;
    expect(repair).toContain('[VENDOR_1]');
    expect(cloud.seen.flat().map((m) => m.content).join('\n')).not.toContain('Bob');
  });

  it('a cloud reply valid only in placeholder form gets a detail-free repair message', async () => {
    // The placeholder passes max(12) but the restored vendor name does not.
    const cloud = fakeProvider('c', 'cloud', ['{"who":"[VENDOR_1]"}', '{"who":"short"}']);
    const r = new AiRouter({ providers: [cloud], cloudEnabled: true, taskPolicies: { assistant: 'cloud-only' }, redactorFactory: () => new Redactor([{ text: 'Bob Plumbing and Heating', kind: 'VENDOR' }]) });
    const res = await r.chatJson('assistant', [{ role: 'user', content: 'Bob Plumbing and Heating' }], z.object({ who: z.string().max(12) }));
    expect(res.data.who).toBe('short');
    const wire = cloud.seen.flat().map((m) => m.content).join('\n');
    expect(wire).not.toContain('Bob');
    expect(wire).toMatch(/did not satisfy the required schema/);
  });
});

describe('extractJson', () => {
  it('handles plain, fenced and embedded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```\n[1,2]\n```')).toEqual([1, 2]);
    expect(extractJson('Answer: {"a":"}"} trailing')).toEqual({ a: '}' });
    expect(() => extractJson('no json here')).toThrow();
  });
});
