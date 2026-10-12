/**
 * Integration of the AI providers with the network policy (lib/net/guard.ts, purpose 'ai'):
 * every provider HTTP call is policy-checked, tailnet/LAN/loopback model servers work in the
 * default 'tailnet-only' mode, public endpoints need the company's cloud-AI opt-in, redirect
 * hops are re-checked, and a provider built without a policy context never connects.
 */
import { describe, it, expect } from 'vitest';
import type { DB } from '@/lib/db';
import { createProvider, type FetchLike, type AnthropicLike } from './providers';
import { AiError } from './types';

/** Minimal db stand-in for getNetworkPolicy (select settings from companies where id = ?). */
function policyDb(networkPolicy?: unknown): DB {
  const rows = [{ settings: networkPolicy ? { networkPolicy } : {} }];
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as DB;
}

const CLOUD_OPT_IN = { mode: 'allow-cloud', cloudOptIn: { ai: true } };

function recordingFetch(respond?: (url: string) => Response): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return respond?.(url) ?? new Response(JSON.stringify({ message: { content: 'hi' }, models: [], data: [] }), { status: 200 });
    },
  };
}

const ollamaCfg = (baseUrl: string) => ({
  id: 'p1', kind: 'ollama' as const, label: 'Ollama', baseUrl, model: 'llama3', enabled: true, apiKey: null,
});

describe('AI providers obey the network policy', () => {
  it('reaches a tailnet model server in the default tailnet-only mode', async () => {
    const t = recordingFetch();
    const p = createProvider(ollamaCfg('http://100.101.102.103:11434'), {
      fetch: t.fetch,
      policyCtx: { db: policyDb(), companyId: 'c1' },
    });
    const r = await p.chat([{ role: 'user', content: 'hello' }]);
    expect(r.content).toBe('hi');
    expect(t.urls).toEqual(['http://100.101.102.103:11434/api/chat']);
  });

  it('allows loopback and LAN servers by default', async () => {
    for (const base of ['http://127.0.0.1:11434', 'http://192.168.1.20:11434']) {
      const t = recordingFetch();
      const p = createProvider(ollamaCfg(base), { fetch: t.fetch, policyCtx: { db: policyDb(), companyId: 'c1' } });
      await expect(p.chat([{ role: 'user', content: 'x' }])).resolves.toMatchObject({ content: 'hi' });
      expect(t.urls).toHaveLength(1);
    }
  });

  it('blocks a public endpoint unless the company opted in to cloud AI', async () => {
    const t = recordingFetch();
    const cfg = {
      id: 'p2', kind: 'openai-compatible' as const, label: 'Cloud', baseUrl: 'https://api.example.com',
      model: 'm', enabled: true, apiKey: 'sk-secret',
    };
    const blocked = createProvider(cfg, { fetch: t.fetch, policyCtx: { db: policyDb(), companyId: 'c1' } });
    await expect(blocked.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'POLICY' });
    expect(t.urls).toHaveLength(0);

    const allowed = createProvider(cfg, {
      fetch: recordingFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })).fetch,
      policyCtx: { db: policyDb(CLOUD_OPT_IN), companyId: 'c1' },
    });
    await expect(allowed.chat([{ role: 'user', content: 'x' }])).resolves.toMatchObject({ content: 'ok' });
  });

  it('re-checks redirect hops: a tailnet server cannot bounce the request to the internet', async () => {
    const t = recordingFetch((url) =>
      url.startsWith('http://100.')
        ? new Response(null, { status: 307, headers: { location: 'https://exfil.example.com/api/chat' } })
        : new Response('{}', { status: 200 }),
    );
    const p = createProvider(ollamaCfg('http://100.64.0.9:11434'), { fetch: t.fetch, policyCtx: { db: policyDb(), companyId: 'c1' } });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(AiError);
    expect(t.urls.some((u) => u.includes('exfil'))).toBe(false);
  });

  it('offline mode blocks even LAN/tailnet model servers', async () => {
    const t = recordingFetch();
    const p = createProvider(ollamaCfg('http://100.101.102.103:11434'), {
      fetch: t.fetch,
      policyCtx: { db: policyDb({ mode: 'offline' }), companyId: 'c1' },
    });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'POLICY' });
    expect(t.urls).toHaveLength(0);
  });

  it('Anthropic is refused before the SDK is called unless cloud AI is opted in', async () => {
    let calls = 0;
    const fake: AnthropicLike = {
      messages: { create: async () => { calls++; return { content: [{ type: 'text', text: 'ok' }] }; } },
      models: { list: async () => ({ data: [] }) },
    };
    const cfg = { id: 'a', kind: 'anthropic' as const, label: 'Claude', baseUrl: null, model: '', enabled: true, apiKey: 'sk-ant' };
    const blocked = createProvider(cfg, { anthropicFactory: () => fake, policyCtx: { db: policyDb(), companyId: 'c1' } });
    await expect(blocked.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'POLICY' });
    expect(calls).toBe(0);
    const allowed = createProvider(cfg, { anthropicFactory: () => fake, policyCtx: { db: policyDb(CLOUD_OPT_IN), companyId: 'c1' } });
    await expect(allowed.chat([{ role: 'user', content: 'x' }])).resolves.toMatchObject({ content: 'ok' });
    expect(calls).toBe(1);
  });

  it('fails closed without a policy context (no unchecked global fetch, no unchecked SDK client)', async () => {
    const p = createProvider(ollamaCfg('http://127.0.0.1:11434'));
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'POLICY' });
    expect(() =>
      createProvider({ id: 'a', kind: 'anthropic', label: 'Claude', baseUrl: null, model: '', enabled: true, apiKey: 'k' }),
    ).toThrow(/network-policy/);
  });
});
