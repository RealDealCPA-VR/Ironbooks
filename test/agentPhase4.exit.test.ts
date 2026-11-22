/**
 * Plan Phase 4 exit (outside the computer, plan §5.4, §4.4, D5), end to end in process: an agent
 * emails month-end statements to 40 customers under ONE approved 30-minute standing permission.
 *
 * A real PGlite company, the agent's own request context (lib/agentContext.ts), the door
 * (lib/agent/operate.ts handleVerb), the approval service and grants, the route bridge with its
 * effects outbox, and the app's own POST /api/sales-forms/statement-email (PDF and all). Replaced:
 * next/headers (no HTTP request here), the mail transport (each message is recorded instead of
 * sent) and the clock (Date only, moved past the window for the last test). One fault is injected
 * for the test of a failed commit: the statement's own audit write (lib/services/_base.ts
 * writeAudit, wrapped) fails once for one customer, after its email was queued.
 *
 *  - The agent asks ahead with ask_for_permission; only an Admin may give standing permission for
 *    an outside send; the Admin gives 30 minutes.
 *  - A dry run shows the email and sends nothing, and does not use the permission.
 *  - 40 statements: 40 emails on the transport, one audit row per email naming the grant, 40 uses.
 *  - A commit that fails after the email was queued sends nothing and uses nothing.
 *  - After the 30 minutes the next one asks a person again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const h = vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-phase4-exit`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-phase4-exit-secret';
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = `${root}/endpoints`;
  process.env.BKA_AGENT_FILES_DIR = `${root}/agent-files`;
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_AGENT_SHELL;
  delete process.env.BKA_AGENT_SHELL_KEY;
  /**
   * Make the statement's own audit write for this customer fail on its Nth call (the dry run is the
   * first, the commit the second): the save then fails after the email was queued.
   */
  return { failAudit: null as null | { customerId: string; onCall: number; calls: number } };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));

// The one fault this file injects: the statement's audit row (written after the email was queued,
// lib/services/salesForms.ts emailCustomerStatement) fails once, so the commit fails after the queue.
vi.mock('@/lib/services/_base', async (orig) => {
  const real = await orig<typeof import('@/lib/services/_base')>();
  const writeAudit: typeof real.writeAudit = async (ctx, entry) => {
    const f = h.failAudit;
    const values = (entry as { newValues?: { action?: unknown } } | undefined)?.newValues;
    if (f && entry?.entityId === f.customerId && values?.action === 'statement_emailed' && ++f.calls === f.onCall) {
      throw new Error('The disk is full.');
    }
    return real.writeAudit(ctx, entry);
  };
  return { ...real, writeAudit };
});

import path from 'node:path';
import { agentGrants, agentPermissionRequests, auditLogs } from '@/lib/db/schema';
import { operationForRoute } from '@/lib/agent/operations/registry';
import { createCustomer } from '@/lib/services/customers';
import { approveAgentRequest, requestForPerson } from '@/lib/services/agentRequests';
import { ServiceError } from '@/lib/services/_base';
import {
  addPerson,
  closeScenario,
  fakeMail,
  freshLimits,
  makeAgent,
  openScenario,
  recipientsOf,
  requestKey,
  settled,
  type FakeMail,
  type Person,
  type Scenario,
  type ScenarioAgent,
} from './helpers/agentScenarioB';

type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DATA_DIR = path.resolve(process.env.BKA_DATA_DIR!);
const CUSTOMERS = 40;

let s: Scenario;
let bo: Person; // Accountant: may email statements, but is not an Admin
let agent: ScenarioAgent;
let mail: FakeMail;
const customers: Array<{ id: string; email: string }> = [];
let noEmailCustomer: string;
let grantId: string;
/** The pinned start of the test's clock (Date only; it advances in real time from there). */
let start: number;

function idOf(method: string, route: string): string {
  const op = operationForRoute(method, route);
  if (!op) throw new Error(`No operation for ${method} ${route}`);
  return op.id;
}
const STATEMENT_EMAIL = () => idOf('POST', '/api/sales-forms/statement-email');

/** Minutes left in today in New York (the company's zone: the test run's TZ). */
function minutesLeftToday(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(at));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return 24 * 60 - (hour * 60 + minute);
}

async function statementRows() {
  const rows = await s.db.select().from(auditLogs).where(and(eq(auditLogs.companyId, s.companyId), eq(auditLogs.entityType, 'customer')));
  return rows.filter((r) => (r.newValues as Out | null)?.action === 'statement_emailed');
}

async function grantRow() {
  const [g] = await s.db.select().from(agentGrants).where(eq(agentGrants.id, grantId));
  return g;
}

beforeAll(async () => {
  // A standing window cannot run past the end of the company's day: start well inside one.
  const now = Date.now();
  start = minutesLeftToday(now) > 90 ? now : now - 3 * 60 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(start);

  s = await openScenario(DATA_DIR, 'Phase Four Statements Co');
  bo = await addPerson(s, 'Bo Accountant', 'accountant');
  for (let i = 1; i <= CUSTOMERS; i++) {
    const n = String(i).padStart(2, '0');
    const email = `ap${n}@customer${n}.exit-b.test`;
    const c = await createCustomer(s.seed, { displayName: `Customer ${n}`, email });
    customers.push({ id: c.id, email });
  }
  noEmailCustomer = (await createCustomer(s.seed, { displayName: 'Customer Without Email' })).id;

  agent = await makeAgent(s, { name: 'Statements Agent', roleKeys: ['full_access'], preset: 'ask_every_change' });
  mail = fakeMail();
  freshLimits();
}, 240_000);

afterAll(async () => {
  mail?.restore();
  vi.useRealTimers();
  await closeScenario(s);
});

describe('Phase 4 exit: month-end statements to 40 customers under one 30-minute permission', { timeout: 300_000 }, () => {
  let askId: string;

  it('the agent asks ahead for standing permission; only an Admin may give it for an outside send', async () => {
    const asked = await agent.verb('ask_for_permission', {
      operation: STATEMENT_EMAIL(),
      minutes: 30,
      reason: 'Month-end: email this month\'s statement to every customer.',
      requestId: requestKey('statements-grant'),
    });
    expect(asked.outcome).toBe('asked');
    expect(asked.status).toBe('pending');
    askId = asked.requestId!;
    expect(asked.summary).toMatch(/30 minutes/);
    expect(asked.needs?.grantAdminOnly).toBe(true);

    // Bo may email statements himself, but standing permission for an outside send is an Admin's (D5).
    const bosCard = await requestForPerson(bo.ctx, askId, { atHost: true });
    expect(bosCard.canApprove).toBe(false);
    expect(bosCard.cannotApproveWhy).toMatch(/Admin/);
    await expect(approveAgentRequest(bo.ctx, askId, { grant: { minutes: 30, constraints: {} } }, { atHost: true })).rejects.toBeInstanceOf(ServiceError);

    const card = await requestForPerson(s.admin.ctx, askId, { atHost: true });
    expect(card.canApprove).toBe(true);
    const given = await approveAgentRequest(s.admin.ctx, askId, { grant: { minutes: 30, constraints: {} } }, { atHost: true });
    expect(given.status, JSON.stringify(given.request.error)).toBe('executed');
    expect(given.request.grantId).toBeTruthy();
    grantId = given.request.grantId!;
    const g = await grantRow();
    expect(g.givenBy).toBe(s.admin.id);
    expect(g.operation).toBe(STATEMENT_EMAIL());
    const minutes = (g.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30.01);

    const mine = await agent.verb('get_my_permissions', {});
    expect(mine.grants.map((x) => x.id)).toContain(grantId);
  });

  it('a dry run shows the email and sends nothing (nor uses the permission)', async () => {
    const dry = await agent.run({ operation: STATEMENT_EMAIL(), body: { customerId: customers[0].id }, dryRun: true });
    expect(dry.outcome).toBe('dry_run');
    const emails = (dry.preview?.effects ?? []).filter((e) => e.kind === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0].summary).toContain(customers[0].email);
    expect(dry.note).toMatch(/standing permission/);
    expect(mail.sent).toHaveLength(0);
    expect((await grantRow()).uses).toBe(0);
    expect(await statementRows()).toHaveLength(0);
  });

  it('40 statements under the one permission: 40 emails, one audit row per email naming the grant', async () => {
    const before = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agent.id));
    for (const c of customers) {
      const done = await agent.run({ operation: STATEMENT_EMAIL(), body: { customerId: c.id }, requestId: requestKey(`statement-${c.email}`) });
      expect(done.outcome, JSON.stringify(done)).toBe('done');
      expect(done.grantId).toBe(grantId);
      expect((done.effects ?? []).map((e) => e.status)).toEqual(['sent']);
    }

    // Each one handed to the mail server once, to its own customer, with its statement attached.
    expect(mail.sent).toHaveLength(CUSTOMERS);
    expect(mail.sent.map((m) => recipientsOf(m)[0]).sort()).toEqual(customers.map((c) => c.email).sort());
    for (const m of mail.sent) expect((m.attachments ?? []).map((a) => String(a.filename ?? ''))).toEqual([expect.stringMatching(/^statement-.*\.pdf$/)]);

    // One audit row per email, each naming the agent and the standing permission it ran under.
    const rows = await statementRows();
    expect(rows).toHaveLength(CUSTOMERS);
    expect(new Set(rows.map((r) => r.entityId))).toEqual(new Set(customers.map((c) => c.id)));
    for (const r of rows) {
      expect(r.agentGrantId).toBe(grantId);
      expect(r.agentId).toBe(agent.id);
      expect(r.approvedBy).toBeNull();
    }
    expect((await grantRow()).uses).toBe(CUSTOMERS);

    // Nobody was asked for any of them: the one approval was the standing permission.
    const after = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, agent.id));
    expect(after.length).toBe(before.length);
  });

  it('a commit that fails after its email was queued sends nothing and uses nothing', async () => {
    const sentBefore = mail.sent.length;
    const usesBefore = (await grantRow()).uses;
    const rowsBefore = (await statementRows()).length;
    // The dry run goes through; the commit's audit write fails after the email was queued.
    h.failAudit = { customerId: customers[1].id, onCall: 2, calls: 0 };
    try {
      await expect(
        agent.run({ operation: STATEMENT_EMAIL(), body: { customerId: customers[1].id }, requestId: requestKey('statement-fails') }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect(h.failAudit.calls).toBe(2);
    } finally {
      h.failAudit = null;
    }
    await settled(s.db);

    expect(mail.sent.length).toBe(sentBefore);
    // The use of the standing permission was counted inside the run, so it went with it.
    expect((await grantRow()).uses).toBe(usesBefore);
    expect((await statementRows()).length).toBe(rowsBefore);
  });

  it('a statement that cannot go out (no email address) fails before anything is sent', async () => {
    const sentBefore = mail.sent.length;
    const usesBefore = (await grantRow()).uses;
    await expect(
      agent.run({ operation: STATEMENT_EMAIL(), body: { customerId: noEmailCustomer }, requestId: requestKey('statement-no-email') }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/no email address/i) });
    expect(mail.sent.length).toBe(sentBefore);
    expect((await grantRow()).uses).toBe(usesBefore);
  });

  it('after the 30 minutes the next one asks a person again, and nothing is sent', async () => {
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const sentBefore = mail.sent.length;
    const mine = await agent.verb('get_my_permissions', {});
    expect(mine.grants.map((x) => x.id)).not.toContain(grantId);

    const next = await agent.run({
      operation: STATEMENT_EMAIL(),
      body: { customerId: customers[2].id },
      requestId: requestKey('statement-late'),
      reason: 'One more statement after the window closed.',
    });
    expect(next.outcome).toBe('asked');
    expect(next.status).toBe('pending');
    expect(next.grantId).toBeUndefined();
    expect(mail.sent.length).toBe(sentBefore);
    expect((await grantRow()).uses).toBe(CUSTOMERS);
  });
});
