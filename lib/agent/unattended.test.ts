/**
 * Agents working while nobody is signed in (AGENT_ACCESS.md; lib/agentContext.ts,
 * lib/services/agents.ts, app/api/agent/service/route.ts).
 *
 * What is proved, with the real `getServerContext` and the real route handlers:
 *  - it is OFF unless an Admin ticked it for that agent: every other agent is still told to wait
 *    until a person signs in, exactly as before;
 *  - an agent with the permission works before anyone signs in, read-only on its request like any
 *    agent, and its changes go through the same door (lib/agent/operate.ts) under its own name;
 *    what its policy asks a person about waits for one (D7: nothing is ever approved by itself);
 *  - never past a company-file password, and never in a file protected with passwords (not open
 *    at all before a person's sign-in), and never in a practice copy;
 *  - only the desktop shell (its per-launch token) can ask the server to serve agents with no
 *    window, and the server says yes only when such an agent exists; an agent's own token, a
 *    person's sign-in and a plain local request are all refused;
 *  - the shell can ask when an agent last worked, so it can close the file after a quiet while.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), headers: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined) }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-unattended');
const TEST_DIR = path.join(ROOT, 'data');
const ENDPOINTS = path.join(ROOT, 'endpoints');
const SHELL_TOKEN = 'shell-token-for-this-launch-0123456789abcdef';
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'agent-unattended-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = ENDPOINTS;
process.env.BKA_INTERNAL_TOKEN = SHELL_TOKEN;
delete process.env.BKA_DEVICE_VAULT;
delete process.env.BKA_LAUNCH_PASS;
delete process.env.PORT;

import { getDb, closeDb, type DB } from '@/lib/db';
import { isReadOnlyDb } from '@/lib/db/readOnly';
import { accounts, agentPermissionRequests, auditLogs, journalEntries, users } from '@/lib/db/schema';
import { saveAgentPolicy } from '@/lib/services/agentPolicies';
import { getServerContext } from '@/lib/context';
import { AGENT_NOT_READY_MESSAGE, AGENT_SANDBOX_MESSAGE } from '@/lib/agentContext';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess } from '@/lib/permissions/model';
import { endpointDir, personSignedIn, resetAgentEndpointState } from '@/lib/agent/endpointFile';
import { resolveDataDir } from '@/lib/db';
import { createCompany } from '@/lib/services/company';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { agentFileTag, createAgent, listAgents, revokeAgent, unattendedAgentsReady } from '@/lib/services/agents';
import { removeFilePassword, setFilePassword } from '@/lib/services/fileLock';
import { SANDBOX_MARKER, SANDBOX_MARKER_SCHEMA } from '@/lib/services/sandboxState';
import { createAgentSchema } from '@/lib/validation/agents';
import { AGENT_START_ENV, agentConnection, forUnattended } from '@/lib/agent/connection';
import { GET as serviceGET, POST as servicePOST } from '@/app/api/agent/service/route';
import { POST as actionsPOST } from '@/app/api/agent/actions/route';

let db: DB;
let companyId: string;
let ownerId: string;
let admin: ServiceContext;
let attendedToken: string;
let unattendedToken: string;
let unattendedId: string;

const endpointFile = () => path.join(endpointDir(), `${agentFileTag()}.json`);

function request(method: string, routePath: string, token: string) {
  h.headers.clear();
  h.cookies.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.headers.set('host', 'localhost:45123');
  h.headers.set('authorization', `Bearer ${token}`);
}

async function refusedWith(p: Promise<unknown>, message: string): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, 'the request was let through').toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe('FORBIDDEN');
  expect((err as ServiceError).message).toBe(message);
}

/** The desktop shell's own call (its per-launch token), or someone else's. */
function shellRequest(method: 'GET' | 'POST', headers: Record<string, string> = { 'x-bka-internal': SHELL_TOKEN }) {
  return new NextRequest('http://localhost:45123/api/agent/service', { method, headers });
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  resetAgentEndpointState();
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'owner@unattended.test', name: 'Olive Owner', passwordHash: 'x' }).returning();
  ownerId = owner.id;
  companyId = (await createCompany(db, { name: 'Unattended Co', ownerId })).id;
  admin = { db, companyId, userId: ownerId, role: 'owner', access: fullAccess() };
  attendedToken = (await createAgent(admin, { name: 'Day helper', roleKeys: ['bookkeeper'], mode: 'post' })).token;
});

afterAll(async () => {
  resetAgentEndpointState();
  delete process.env.BKA_INTERNAL_TOKEN;
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  delete process.env.BKA_COMPANY_SEALED;
});

describe('off unless an Admin switched it on for that agent', () => {
  it('an agent is made without it, and the request for it is a plain yes or no', async () => {
    const [made] = await listAgents(admin);
    expect(made.unattended).toBe(false);
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['bookkeeper'], mode: 'post' }).success).toBe(true);
    expect(createAgentSchema.safeParse({ name: 'A', roleKeys: ['bookkeeper'], mode: 'post', unattended: 'yes' }).success).toBe(false);
  });

  it('with no such agent the shell is told no, nothing is published, and every agent waits for a person', async () => {
    expect(await unattendedAgentsReady(db)).toBe(0);
    const res = await servicePOST(shellRequest('POST'));
    expect(await res.json()).toEqual({ ok: false, reason: 'no_agents' });
    expect(fs.existsSync(endpointFile())).toBe(false);
    request('GET', '/api/accounts', attendedToken);
    await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
  });
});

describe('an agent an Admin allowed to work while nobody is signed in', () => {
  beforeAll(async () => {
    const made = await createAgent(admin, { name: 'Night closer', roleKeys: ['full_access'], mode: 'post', unattended: true });
    unattendedToken = made.token;
    unattendedId = made.agent.id;
    expect(made.agent.unattended).toBe(true);
  });

  it('making it is in the audit trail with the switch, under the Admin who made it', async () => {
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, unattendedId));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ownerId);
    expect(rows[0].newValues).toMatchObject({ name: 'Night closer', unattended: true });
  });

  it('nothing is published just because it exists: only the shell starts serving', async () => {
    expect(personSignedIn(resolveDataDir())).toBe(false);
    expect(await unattendedAgentsReady(db)).toBe(1);
  });

  it('only the desktop shell can ask: not a local program, not a person, not the agent itself', async () => {
    const others: Record<string, string>[] = [{}, { 'x-bka-internal': 'wrong' }, { authorization: `Bearer ${unattendedToken}` }, { 'x-bka-internal': `${SHELL_TOKEN}x` }];
    for (const headers of others) {
      for (const method of ['GET', 'POST'] as const) {
        const res = method === 'GET' ? await serviceGET(shellRequest(method, headers)) : await servicePOST(shellRequest(method, headers));
        expect(res.status, `${method} ${JSON.stringify(Object.keys(headers))}`).toBe(403);
      }
    }
    expect(fs.existsSync(endpointFile())).toBe(false);
  });

  it('the shell is told yes, and the endpoint is published so the connector can find the app', async () => {
    const res = await servicePOST(shellRequest('POST'));
    expect(await res.json()).toEqual({ ok: true, agents: 1 });
    expect(fs.existsSync(endpointFile())).toBe(true);
    // The port is the one the shell's own request arrived on.
    expect(JSON.parse(fs.readFileSync(endpointFile(), 'utf8'))).toMatchObject({ tag: agentFileTag(), port: 45123 });
    const quiet = await (await serviceGET(shellRequest('GET'))).json();
    expect(quiet.personSignedIn).toBe(false);
  });

  it('it works before anyone signs in: read-only on its request, like any agent', async () => {
    request('GET', '/api/accounts', unattendedToken);
    const ctx = await getServerContext();
    expect(ctx.userId).toBeNull();
    expect(ctx.role).toBe('viewer');
    expect(isReadOnlyDb(ctx.db)).toBe(true);
    expect(ctx.agent).toMatchObject({ id: unattendedId, name: 'Night closer', mode: 'post' });
    expect(ctx.access?.isAdmin).toBe(false);
    // Still no person: nobody was "signed in" by an agent working.
    expect(personSignedIn(resolveDataDir())).toBe(false);
  });

  it('the agent without the switch still waits for a person', async () => {
    request('GET', '/api/accounts', attendedToken);
    await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
  });

  /** One curated action as the unattended agent, the way the connector sends it. */
  async function nightAction(requestId: string, description: string): Promise<{ status: number; body: Record<string, any> }> {
    const rows = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    const bank = rows.find((a) => a.type === 'asset');
    const expense = rows.find((a) => a.type === 'expense');
    expect(bank && expense).toBeTruthy();
    request('POST', '/api/agent/actions', unattendedToken);
    const res = await actionsPOST(
      new NextRequest('http://localhost:45123/api/agent/actions', {
        method: 'POST',
        body: JSON.stringify({
          action: 'enter_journal_entry',
          requestId,
          input: {
            date: '2026-03-01',
            description,
            lines: [
              { accountId: expense!.id, debit: '12.00' },
              { accountId: bank!.id, credit: '12.00' },
            ],
          },
        }),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  it('what it enters is entered under its own name, through the same door and checks', async () => {
    const { status, body } = await nightAction('night-1', 'Entered at night');
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ outcome: 'posted', operation: 'journal-entries.create' });
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.description, 'Entered at night'));
    expect(je.agentId).toBe(unattendedId);
    // The person it stands in for where a person must be named is the Admin who made it.
    expect(je.createdBy).toBe(ownerId);
    // Nobody approved it: it ran on the agent's own policy.
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, je.id));
    expect(audit.every((a) => a.agentId === unattendedId && a.approvedBy === null)).toBe(true);
  });

  it('what its policy asks a person about waits for one; nothing is approved by itself', async () => {
    await saveAgentPolicy(admin, unattendedId, { preset: 'ask_every_change' });
    const { status, body } = await nightAction('night-2', 'Asked at night');
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ outcome: 'asked', status: 'pending' });
    expect(await db.select().from(journalEntries).where(eq(journalEntries.description, 'Asked at night'))).toEqual([]);
    const [waiting] = await db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, body.requestId));
    expect(waiting).toMatchObject({ agentId: unattendedId, status: 'pending', decidedBy: null });
  });

  it('the shell can see when an agent last worked', async () => {
    const before = Date.now();
    request('GET', '/api/accounts', unattendedToken);
    await getServerContext();
    const { lastAgentUse } = await (await serviceGET(shellRequest('GET'))).json();
    expect(typeof lastAgentUse).toBe('string');
    expect(new Date(lastAgentUse).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('never past a company-file password: only a person can enter it', async () => {
    await setFilePassword(db, 'open-sesame-1');
    try {
      expect(await unattendedAgentsReady(db)).toBe(0);
      expect(await (await servicePOST(shellRequest('POST'))).json()).toEqual({ ok: false, reason: 'no_agents' });
      request('GET', '/api/accounts', unattendedToken);
      await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
    } finally {
      await removeFilePassword(db, 'open-sesame-1');
    }
    request('GET', '/api/accounts', unattendedToken);
    expect((await getServerContext()).agent?.id).toBe(unattendedId);
  });

  it('never in a file protected with passwords: it is not open before a person signs in', async () => {
    process.env.BKA_COMPANY_SEALED = 'extract';
    try {
      expect(await (await servicePOST(shellRequest('POST'))).json()).toEqual({ ok: false, reason: 'protected' });
      request('GET', '/api/accounts', unattendedToken);
      await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
    } finally {
      delete process.env.BKA_COMPANY_SEALED;
    }
  });

  it('never in a practice copy', async () => {
    const marker = path.join(TEST_DIR, SANDBOX_MARKER);
    fs.writeFileSync(marker, JSON.stringify({ schema: SANDBOX_MARKER_SCHEMA, kind: 'sandbox', realDataDir: TEST_DIR, sourceName: 'Unattended Co', createdAt: new Date().toISOString() }));
    try {
      expect(await (await servicePOST(shellRequest('POST'))).json()).toEqual({ ok: false, reason: 'sandbox' });
      request('GET', '/api/accounts', unattendedToken);
      await refusedWith(getServerContext(), AGENT_SANDBOX_MESSAGE);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });

  it('removing it ends it at once, and the shell is told no again', async () => {
    await revokeAgent(admin, unattendedId);
    expect(await unattendedAgentsReady(db)).toBe(0);
    expect(await (await servicePOST(shellRequest('POST'))).json()).toEqual({ ok: false, reason: 'no_agents' });
    request('GET', '/api/accounts', unattendedToken);
    await refusedWith(getServerContext(), AGENT_NOT_READY_MESSAGE);
  });
});

describe('the settings shown for a connector', () => {
  const installed = () =>
    agentConnection({
      execPath: 'C:\\Program Files\\Ironbooks\\Ironbooks.exe',
      serverScript: 'C:\\Program Files\\Ironbooks\\resources\\app\\server.js',
      fileExists: () => true,
    });

  it('only an agent allowed to work unattended gets the switch that starts Ironbooks', () => {
    const plain = installed();
    expect(plain?.installed).toBe(true);
    expect(plain?.env).not.toHaveProperty(AGENT_START_ENV);
    const un = forUnattended(plain);
    expect(un?.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', [AGENT_START_ENV]: '1' });
    expect(un?.command).toBe(plain?.command);
    expect(un?.args).toEqual(plain?.args);
    // The original is left as it was.
    expect(plain?.env).not.toHaveProperty(AGENT_START_ENV);
  });

  it('a source checkout cannot be started that way, so it gets no switch', () => {
    const dev = agentConnection({ execPath: 'node', serverScript: undefined, cwd: '/repo', fileExists: (p) => p.replace(/\\/g, '/').endsWith('/repo/mcp/ironbooks-mcp.mjs') });
    expect(dev?.installed).toBe(false);
    expect(forUnattended(dev)).toEqual(dev);
    expect(forUnattended(null)).toBeNull();
  });
});
