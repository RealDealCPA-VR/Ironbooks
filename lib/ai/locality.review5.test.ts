/**
 * Review round 5 (security): the AI router's idea of "local" matches the network policy.
 *
 * lib/ai/tailnet.ts had its own host classifier that called short names ("gpu-box"), *.local,
 * *.lan, *.internal and link-local addresses LAN, while the network policy (lib/net/cidr.ts)
 * calls a name it cannot pin to a network PUBLIC. A 'local' provider gets UNREDACTED data and
 * skips the company's cloud-AI switch, so with Privacy & Network on "allow cloud" + AI, a model at
 * http://gpu-box:11434 — which the policy itself treats as an internet host — received customer
 * names, emails and amounts in the clear while cloud AI was OFF.
 */
import { describe, expect, it } from 'vitest';
import { AiRouter } from './router';
import { Redactor } from './redact';
import { createOllamaProvider, localityOf } from './providers';
import { classifyEndpoint } from './tailnet';
import { classifyHost as networkClass, isPrivateClass } from '@/lib/net/cidr';
import { decideOutbound, DEFAULT_NETWORK_POLICY, normalizePolicy } from '@/lib/net/policy';

const HOSTS = [
  'gpu-box',
  'studio.local',
  'nas.lan',
  'model.internal',
  'box.home.arpa',
  '169.254.10.20',
  '[fe80::1]',
  '127.0.0.1',
  'localhost',
  '192.168.1.20',
  '10.0.0.7',
  '100.101.102.103',
  '[fd12:3456::1]',
  'api.example.com',
  '8.8.8.8',
];

describe('review5: AI locality = network policy class', () => {
  it.each(HOSTS)('%s', (host) => {
    const url = `http://${host}:11434`;
    const local = localityOf({ kind: 'ollama', baseUrl: url }) === 'local';
    const policyPrivate = isPrivateClass(networkClass(new URL(url).hostname));
    expect(local).toBe(policyPrivate);
    // Anything the AI layer calls local is reachable in the default (tailnet-only) mode.
    if (local) expect(decideOutbound(normalizePolicy(DEFAULT_NETWORK_POLICY), url, 'ai', undefined).allowed).toBe(true);
  });

  it('a short host name is treated as cloud: redacted, and only used when cloud AI is on', async () => {
    const seen: string[] = [];
    const provider = createOllamaProvider(
      { id: 'box', kind: 'ollama', label: 'Box', baseUrl: 'http://gpu-box:11434', model: 'm', enabled: true },
      {
        fetch: async (_u, init) => {
          seen.push(String(init?.body ?? ''));
          return new Response(JSON.stringify({ message: { content: 'ok' }, model: 'm' }), { status: 200 });
        },
      },
    );
    expect(provider.locality).toBe('cloud');
    const redactor = new Redactor([{ text: 'Acme Holdings', kind: 'CUSTOMER' }]);
    const off = new AiRouter({ providers: [provider], cloudEnabled: false, taskPolicies: { assistant: 'local-only' } });
    await expect(off.chat('assistant', [{ role: 'user', content: 'Invoice for Acme Holdings, jane@acme.example' }])).rejects.toThrow();
    expect(seen).toHaveLength(0);
    const on = new AiRouter({
      providers: [provider],
      cloudEnabled: true,
      taskPolicies: { assistant: 'local-then-cloud' },
      redactorFactory: () => redactor,
    });
    await on.chat('assistant', [{ role: 'user', content: 'Invoice for Acme Holdings, jane@acme.example' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('Acme Holdings');
    expect(seen[0]).not.toContain('jane@acme.example');
  });

  it('the settings page explains why a short name is not local', () => {
    const c = classifyEndpoint('http://gpu-box:11434');
    expect(c.isPrivate).toBe(false);
    expect(c.warning).toMatch(/IP address|ts\.net/);
    expect(classifyEndpoint('http://169.254.1.1:11434').hostClass).toBe('invalid');
  });
});
