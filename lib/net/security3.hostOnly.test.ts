/**
 * Security plan 3.3: through multi-user hosting a signed-in Admin on another computer could make
 * the HOST connect to its own loopback and office network and read the error text back. The
 * routes that do that are host-only for a remote request (lib/net/hostOnly.ts): reading stays
 * allowed, changing a destination or running a test / pull / peer listing is refused. The
 * services are stubbed: only the route's own decision is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const calls = vi.hoisted(() => ({
  testConnection: 0,
  pullStarterModel: 0,
  updateSettings: 0,
  allowCloudPurpose: 0,
  discoverTailnetPeers: 0,
  sendTestEmail: 0,
  saveEmailSetup: 0,
  removeEmailSetup: 0,
  setNetworkPolicy: 0,
  current: {
    providers: [{ id: 'p1', kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2', enabled: true, timeoutMs: null, hasApiKey: false, locality: 'local', hostClass: 'loopback', warning: null }],
    taskPolicies: { categorize: 'local-only', assistant: 'local-only', 'error-correction': 'local-only' },
    cloudEnabled: false,
    cloudDailyCap: 500,
    cloudCallsToday: 0,
    autoApplyEnabled: false,
    autoApplyThreshold: '0.9500',
    llmSuggestEnabled: true,
  } as Record<string, unknown>,
}));

vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ({ db: null, companyId: 'c1', userId: 'u1', role: 'admin' })) }));
vi.mock('@/lib/services/aiSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/aiSettings')>()),
  testConnection: vi.fn(async () => (calls.testConnection++, { ok: true, models: [] })),
  pullStarterModel: vi.fn(async () => (calls.pullStarterModel++, { model: 'llama3.2' })),
  getPublicSettings: vi.fn(async () => calls.current),
  updateSettings: vi.fn(async (_ctx: unknown, body: Record<string, unknown>) => (calls.updateSettings++, { ...calls.current, cloudEnabled: body.cloudEnabled ?? calls.current.cloudEnabled })),
}));
vi.mock('@/lib/services/networkPolicy', () => ({
  allowCloudPurpose: vi.fn(async () => (calls.allowCloudPurpose++, { notice: null })),
  getNetworkPolicy: vi.fn(async () => ({ mode: 'tailnet-only', cloudOptIn: { ai: false, email: false, 'vendor-lookup': false, updates: true }, vendorLookupUrl: null })),
  setNetworkPolicy: vi.fn(async (_ctx: unknown, body: Record<string, unknown>) => (calls.setNetworkPolicy++, body)),
}));
vi.mock('@/lib/services/sessions', () => ({ isAdminRole: (r: string | undefined) => r === undefined || r === 'owner' || r === 'admin' }));
vi.mock('@/lib/net/guard', () => ({ recentOutbound: () => [] }));
vi.mock('@/lib/services/rbac', () => ({ requireRole: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/tailnet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/tailnet')>()),
  discoverTailnetPeers: vi.fn(async () => (calls.discoverTailnetPeers++, { available: true, peers: [] })),
}));
vi.mock('@/lib/services/emailSettings', () => ({
  getEmailSetup: vi.fn(async () => ({ source: 'file', configured: true, host: 'smtp.example.com' })),
  saveEmailSetup: vi.fn(async () => (calls.saveEmailSetup++, { source: 'file', configured: true })),
  removeEmailSetup: vi.fn(async () => (calls.removeEmailSetup++, { source: 'none', configured: false })),
  sendTestEmail: vi.fn(async () => (calls.sendTestEmail++, { ok: true, message: 'Sent.', to: 'a@b.c', from: 'a@b.c' })),
}));

import { POST as aiTest } from '@/app/api/ai/test/route';
import { POST as aiPull } from '@/app/api/ai/pull/route';
import { GET as aiTailnet } from '@/app/api/ai/tailnet/route';
import { GET as aiSettingsGET, PUT as aiSettingsPUT } from '@/app/api/ai/settings/route';
import { POST as emailTest } from '@/app/api/email/test/route';
import { DELETE as emailDELETE, GET as emailGET, PUT as emailPUT } from '@/app/api/email/settings/route';
import { GET as policyGET, PATCH as policyPATCH, PUT as policyPUT } from '@/app/api/network-policy/route';
import { HOST_ONLY_MESSAGE } from './hostOnly';

type Who = 'host' | 'teammate' | 'other-program';

function request(who: Who, method: string, path: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // A teammate through the multi-user proxy; another program on this computer has no launch pass.
  if (who === 'teammate') {
    headers['x-bka-remote-addr'] = '100.64.0.9';
    headers['sec-bka-proxy'] = '1';
  }
  if (who === 'host') headers['x-bka-launch'] = 'pass-of-this-launch';
  return new NextRequest(`http://127.0.0.1:3123${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function refused(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const j = await res.json();
  expect(j.details).toEqual({ hostOnly: true });
  expect(j.error).toMatch(/only be (changed|done) on the computer that holds the company file/);
}

const provider = (patch: Record<string, unknown> = {}) => ({ id: 'p1', kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434', model: 'llama3.2', enabled: true, ...patch });

beforeEach(() => {
  process.env.BKA_LAUNCH_PASS = 'pass-of-this-launch';
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) if (typeof calls[k] === 'number') (calls as Record<string, unknown>)[k] = 0;
  calls.current = { ...calls.current, cloudEnabled: false };
});
afterEach(() => {
  delete process.env.BKA_LAUNCH_PASS;
});

describe.each<Who>(['teammate', 'other-program'])('from another computer (%s)', (who) => {
  it('AI connection tests, model downloads and the tailnet peer list are refused', async () => {
    await refused(await aiTest(request(who, 'POST', '/api/ai/test', { kind: 'ollama', label: 'x', baseUrl: 'http://127.0.0.1:5432', model: '' })));
    await refused(await aiPull(request(who, 'POST', '/api/ai/pull', { baseUrl: 'http://localhost:11434' })));
    await refused(await aiTailnet(request(who, 'GET', '/api/ai/tailnet')));
    expect(calls.testConnection + calls.pullStarterModel + calls.discoverTailnetPeers).toBe(0);
  });

  it('AI settings: reading works and says the page is host-only', async () => {
    const res = await aiSettingsGET(request(who, 'GET', '/api/ai/settings'));
    expect(res.status).toBe(200);
    expect((await res.json()).hostOnly).toBe(true);
  });

  it('AI settings: adding an AI, or changing its type or server address, is refused', async () => {
    await refused(await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { providers: [provider(), { kind: 'ollama', label: 'Probe', baseUrl: 'http://192.168.1.1:80', model: '' }] })));
    await refused(await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { providers: [provider({ baseUrl: 'http://127.0.0.1:5432' })] })));
    await refused(await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { providers: [provider({ kind: 'openai-compatible' })] })));
    await refused(await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { providers: [provider({ id: 'made-up' })] })));
    expect(calls.updateSettings).toBe(0);
  });

  it('AI settings: turning cloud AI on is refused; switching saved AI, models and routing is not', async () => {
    await refused(await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { cloudEnabled: true })));
    expect(calls.updateSettings).toBe(0);
    // Narrower rule: nothing here makes the host connect anywhere new.
    const ok = await aiSettingsPUT(
      request(who, 'PUT', '/api/ai/settings', {
        providers: [provider({ enabled: false, model: 'qwen3', label: 'GPU box', baseUrl: 'http://LOCALHOST:11434/' })],
        taskPolicies: { categorize: 'local-only' },
        cloudEnabled: false,
        autoApplyEnabled: true,
      }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).hostOnly).toBe(true);
    // Removing every AI is fine too.
    expect((await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { providers: [] }))).status).toBe(200);
    expect(calls.updateSettings).toBe(2);
  });

  it('AI settings: with cloud AI already on, saving never re-opens Privacy & Network from here', async () => {
    calls.current = { ...calls.current, cloudEnabled: true };
    const res = await aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { cloudEnabled: true }));
    expect(res.status).toBe(200);
    expect(calls.allowCloudPurpose).toBe(0);
  });

  it('email: the mail server cannot be saved, removed or tested as typed; the saved one can be tested', async () => {
    const g = await emailGET(request(who, 'GET', '/api/email/settings'));
    expect(g.status).toBe(200);
    expect((await g.json()).hostOnly).toBe(true);
    const draft = { host: '192.168.1.1', port: 22, security: 'none', fromEmail: 'a@b.c' };
    await refused(await emailPUT(request(who, 'PUT', '/api/email/settings', draft)));
    await refused(await emailDELETE(request(who, 'DELETE', '/api/email/settings')));
    await refused(await emailTest(request(who, 'POST', '/api/email/test', { to: 'a@b.c', draft })));
    expect(calls.saveEmailSetup + calls.removeEmailSetup + calls.sendTestEmail).toBe(0);
    const saved = await emailTest(request(who, 'POST', '/api/email/test', { to: null }));
    expect(saved.status).toBe(200);
    expect(calls.sendTestEmail).toBe(1);
  });

  it('Privacy & Network: shown read-only, and changes are refused', async () => {
    const g = await policyGET(request(who, 'GET', '/api/network-policy'));
    expect(g.status).toBe(200);
    const view = await g.json();
    expect(view.canEdit).toBe(false);
    expect(view.hostOnly).toBe(true);
    const body = { mode: 'allow-cloud', cloudOptIn: { ai: true, email: true, 'vendor-lookup': true, updates: true }, vendorLookupUrl: 'http://127.0.0.1:8080' };
    await refused(await policyPUT(request(who, 'PUT', '/api/network-policy', body)));
    await refused(await policyPATCH(request(who, 'PATCH', '/api/network-policy', body)));
    expect(calls.setNetworkPolicy).toBe(0);
  });
});

describe('on the computer that holds the company file', () => {
  it('everything works as before', async () => {
    expect((await aiTest(request('host', 'POST', '/api/ai/test', { kind: 'ollama', label: 'x', baseUrl: 'http://localhost:11434', model: '' }))).status).toBe(200);
    expect((await aiPull(request('host', 'POST', '/api/ai/pull', {}))).status).toBe(200);
    expect((await aiTailnet(request('host', 'GET', '/api/ai/tailnet'))).status).toBe(200);
    expect(calls.testConnection + calls.pullStarterModel + calls.discoverTailnetPeers).toBe(3);

    const g = await aiSettingsGET(request('host', 'GET', '/api/ai/settings'));
    expect((await g.json()).hostOnly).toBe(false);
    const put = await aiSettingsPUT(request('host', 'PUT', '/api/ai/settings', { providers: [provider({ baseUrl: 'http://gpu.tail1.ts.net:11434' })], cloudEnabled: true }));
    expect(put.status).toBe(200);
    expect(calls.allowCloudPurpose).toBe(1); // "Allow cloud AI" still opens Privacy & Network here

    const draft = { host: 'smtp.example.com', port: 587, security: 'starttls', fromEmail: 'a@b.c' };
    expect((await emailPUT(request('host', 'PUT', '/api/email/settings', draft))).status).toBe(200);
    expect((await emailDELETE(request('host', 'DELETE', '/api/email/settings'))).status).toBe(200);
    expect((await emailTest(request('host', 'POST', '/api/email/test', { draft }))).status).toBe(200);
    expect((await (await emailGET(request('host', 'GET', '/api/email/settings'))).json()).hostOnly).toBe(false);

    const view = await (await policyGET(request('host', 'GET', '/api/network-policy'))).json();
    expect(view.canEdit).toBe(true);
    expect(view.hostOnly).toBe(false);
    expect((await policyPUT(request('host', 'PUT', '/api/network-policy', { mode: 'offline' }))).status).toBe(200);
    expect(calls.setNetworkPolicy).toBe(1);
  });

  it('the message is the plain sentence the pages show', () => {
    expect(HOST_ONLY_MESSAGE).toBe('This can only be changed on the computer that holds the company file.');
  });
});
