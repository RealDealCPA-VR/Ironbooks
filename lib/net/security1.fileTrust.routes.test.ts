/**
 * Security plan 1.5, row 3 — the AI and mail save paths approve a quiet company file
 * (lib/net/fileTrust.ts approveQuietFileHere).
 *
 * A company file from another computer whose own settings reach nothing on the internet is approved
 * on this computer by the first save of an Admin sitting at it: saving AI settings, testing an AI
 * connection, starting "Continue with ChatGPT", saving the mail server. A file whose own settings do
 * reach the internet is approved only by "Allow on this computer"; a save from another computer
 * never approves. The approval can never make the save itself fail.
 *
 * The connection test and the ChatGPT sign-in are stubbed (no connection, no browser): only the
 * route's own step is under test. Two "computers" are simulated by switching BKA_DEVICE_VAULT.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-file-trust-routes');
const QUIET = path.join(ROOT, 'quiet');
const HOSTILE = path.join(ROOT, 'hostile');

const holder = vi.hoisted(() => ({ ctx: null as unknown, tests: 0, signIns: 0 }));
vi.mock('@/lib/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/context')>()),
  getServerContext: vi.fn(async () => holder.ctx),
}));
vi.mock('@/lib/services/aiSettings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/aiSettings')>()),
  testConnection: vi.fn(async () => (holder.tests++, { ok: true, latencyMs: 1, models: [], locality: 'local', hostClass: 'lan', warning: null })),
}));
vi.mock('@/lib/services/chatgptSignIn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/chatgptSignIn')>()),
  startChatGptSignIn: vi.fn(async () => (holder.signIns++, { attemptId: 'attempt-1', url: 'https://auth.openai.com/authorize' })),
}));

import { closeDb, getDb, type DB } from '@/lib/db';
import { fileSecrets, users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { fullAccess } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import { setNetworkPolicy } from '@/lib/services/networkPolicy';
import { updateSettings } from '@/lib/services/aiSettings';
import { saveEmailSetup } from '@/lib/services/emailSettings';
import { createReportSchedule, saveMemorizedReport } from '@/lib/services/memorizedReports';
import { DEVICE_VAULT_ENV } from '@/lib/ai/keyVault';
import { PUT as aiSettingsPUT } from '@/app/api/ai/settings/route';
import { POST as aiTestPOST } from '@/app/api/ai/test/route';
import { POST as chatgptPOST } from '@/app/api/ai/chatgpt/route';
import { PUT as emailPUT } from '@/app/api/email/settings/route';
import { APPROVAL_ROW, KNOWN_HERE_ENV, fileApprovedHere, forgetOpenedFoldersForTests, holdStatus } from './fileTrust';

const PC_A = 'a1'.repeat(32);
const PC_B = 'b2'.repeat(32);
const SLOW = 180_000;

function onComputer(secret: string | null) {
  if (secret) process.env[DEVICE_VAULT_ENV] = secret;
  else delete process.env[DEVICE_VAULT_ENV];
}

async function openOn(secret: string, dir: string): Promise<DB> {
  await closeDb(dir);
  forgetOpenedFoldersForTests();
  onComputer(secret);
  process.env.BKA_DATA_DIR = dir;
  return getDb(dir);
}

const ownerCtx = (db: DB, companyId: string, userId: string): ServiceContext => ({ db, companyId, userId, access: fullAccess(), role: 'owner' });

/** Made on computer B: `hostile` adds the sender's internet services, otherwise a LAN AI only. */
async function fileFromB(dir: string, hostile: boolean): Promise<{ companyId: string; userId: string }> {
  const db = await openOn(PC_B, dir);
  const [u] = await db.insert(users).values({ email: `${path.basename(dir)}@sender.test`, name: 'Sender', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: path.basename(dir), ownerId: u.id });
  const ctx = ownerCtx(db, company.id, u.id);
  await updateSettings(ctx, { providers: [{ kind: 'ollama', label: 'Office GPU', baseUrl: 'http://192.168.1.20:11434', model: 'llama3.2', enabled: true }] });
  if (hostile) {
    await setNetworkPolicy(ctx, { mode: 'allow-cloud', cloudOptIn: { ai: true, email: true } });
    await updateSettings(ctx, {
      providers: [{ kind: 'openai-compatible', label: 'Helper', baseUrl: 'https://llm.evil.example/v1', model: 'm1', enabled: true, apiKey: 'sk-any-key' }],
      cloudEnabled: true,
    });
    await saveEmailSetup(ctx, { host: 'smtp.evil.example', port: 587, security: 'starttls', fromEmail: 'books@acme.test' });
    const rep = await saveMemorizedReport(ctx, { name: 'P&L', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-01-31' } } });
    await createReportSchedule(ctx, { name: 'To sender', memorizedReportId: rep.id, frequency: 'monthly', startDate: '2026-02-01', format: 'csv', emailTo: 'drop@evil.example' });
  }
  await closeDb(dir);
  return { companyId: company.id, userId: u.id };
}

type Who = 'host' | 'teammate';
function request(who: Who, method: string, route: string, body: unknown): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'teammate') {
    headers['x-bka-remote-addr'] = '100.64.0.9';
    headers['sec-bka-proxy'] = '1';
  } else headers['x-bka-launch'] = 'pass-of-this-launch';
  return new NextRequest(`http://127.0.0.1:3123${route}`, { method, headers, body: JSON.stringify(body) });
}

/** The four save paths, each as an Admin would use it. */
const SAVES: Array<{ name: string; send: (who: Who) => Promise<Response>; remoteRefused: boolean }> = [
  {
    name: 'saving AI settings',
    send: (who) => aiSettingsPUT(request(who, 'PUT', '/api/ai/settings', { taskPolicies: { categorize: 'local-only' } })),
    remoteRefused: false, // a save that connects nowhere new is allowed from another computer
  },
  {
    name: 'testing an AI connection',
    send: (who) => aiTestPOST(request(who, 'POST', '/api/ai/test', { kind: 'ollama', label: 'Office GPU', baseUrl: 'http://192.168.1.20:11434', model: '' })),
    remoteRefused: true,
  },
  {
    name: 'starting the ChatGPT sign-in',
    send: (who) => chatgptPOST(request(who, 'POST', '/api/ai/chatgpt', { action: 'start' })),
    remoteRefused: false,
  },
  {
    name: 'saving the mail server',
    send: (who) => emailPUT(request(who, 'PUT', '/api/email/settings', { host: '192.168.1.5', port: 25, security: 'starttls', fromEmail: 'books@acme.test' })),
    remoteRefused: true,
  },
];

let quietDb: DB;
let quietCtx: ServiceContext;
let hostileDb: DB;
let hostileCtx: ServiceContext;

/** Back to "as received": no stamp of this computer (the other computer's is gone too; still not approved here). */
async function unapprove(db: DB): Promise<void> {
  await db.delete(fileSecrets).where(eq(fileSecrets.name, APPROVAL_ROW));
  expect(await fileApprovedHere(db)).toBe(false);
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const k of ['BKA_NETWORK_MODE', 'SMTP_HOST', KNOWN_HERE_ENV]) delete process.env[k];
  process.env.BKA_LAUNCH_PASS = 'pass-of-this-launch';
  const quiet = await fileFromB(QUIET, false);
  const hostile = await fileFromB(HOSTILE, true);
  // A second server process opens the hostile file on computer A first, then the quiet one.
  hostileDb = await openOn(PC_A, HOSTILE);
  hostileCtx = ownerCtx(hostileDb, hostile.companyId, hostile.userId);
  quietDb = await openOn(PC_A, QUIET);
  quietCtx = ownerCtx(quietDb, quiet.companyId, quiet.userId);
}, SLOW);

beforeEach(() => {
  onComputer(PC_A);
  holder.tests = 0;
  holder.signIns = 0;
});

afterAll(async () => {
  for (const dir of [QUIET, HOSTILE]) await closeDb(dir).catch(() => undefined);
  onComputer(null);
  delete process.env.BKA_LAUNCH_PASS;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the received files', () => {
  it('quiet: not approved here and nothing to show; hostile: not approved here and the note shows', async () => {
    expect(await fileApprovedHere(quietDb)).toBe(false);
    expect((await holdStatus(quietDb)).heldForThisComputer).toBe(false);
    expect(await fileApprovedHere(hostileDb)).toBe(false);
    expect((await holdStatus(hostileDb)).heldForThisComputer).toBe(true);
  });
});

describe.each(SAVES)('$name', ({ send, remoteRefused }) => {
  it('by an Admin at this computer, in a quiet file: the file is approved and the save goes through', async () => {
    await unapprove(quietDb);
    holder.ctx = quietCtx;
    const res = await send('host');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await fileApprovedHere(quietDb)).toBe(true);
  });

  it('by an Admin at this computer, in a file with internet services pre-loaded: not approved', async () => {
    holder.ctx = hostileCtx;
    const res = await send('host');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await fileApprovedHere(hostileDb)).toBe(false);
  });

  it('by an Admin on another computer: never approves', async () => {
    await unapprove(quietDb);
    holder.ctx = quietCtx;
    const res = await send('teammate');
    if (remoteRefused) expect(res.status).toBe(403);
    expect(await fileApprovedHere(quietDb)).toBe(false);
  });
});

describe('the approval never fails the save', () => {
  it('each route catches and logs a failure of approveQuietFileHere', () => {
    for (const rel of ['app/api/ai/settings/route.ts', 'app/api/ai/test/route.ts', 'app/api/ai/chatgpt/route.ts', 'app/api/email/settings/route.ts', 'app/api/network-policy/route.ts']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      const calls = src.split('\n').filter((l) => l.includes('approveQuietFileHere(ctx'));
      expect(calls, rel).toHaveLength(1);
      expect(calls[0], rel).toMatch(/await approveQuietFileHere\(ctx, \{ remote(: isRemoteRequest\(req\))? \}\)\.catch\(\(err\) => console\.warn\(/);
    }
  });

  it('a failing approval (the company file cannot be read) still saves', async () => {
    await unapprove(quietDb);
    // A context whose database refuses the approval's reads; the ChatGPT start (stubbed, no
    // database) must still answer, and the failure is logged in one line.
    const broken = new Proxy(quietDb, {
      get(target, prop, receiver) {
        if (prop === 'select') return () => { throw new Error('file is busy'); };
        return Reflect.get(target, prop, receiver);
      },
    });
    holder.ctx = { ...quietCtx, db: broken };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await chatgptPOST(request('host', 'POST', '/api/ai/chatgpt', { action: 'start' }));
    expect(res.status).toBe(200);
    expect(holder.signIns).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[file-trust]'))).toHaveLength(1);
    warn.mockRestore();
    holder.ctx = quietCtx;
    expect(await fileApprovedHere(quietDb)).toBe(false);
  });
});
