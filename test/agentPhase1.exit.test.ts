/**
 * Agent full access, Phase 1 exit (plan §9 Phase 1, §4.4, §5.6, §7.2, §7.3, §8), end to end IN
 * PROCESS: a real PGlite company, the real door (lib/agent/operate.ts handleVerb with the context
 * lib/agentContext.ts builds from the agent's token), bridge, policy, grants, requests and audit
 * trail. Nothing of the app is mocked (test/helpers/agentScenario.ts).
 *
 * What is proved:
 *  - standing permission: a person approves one bill with "this and similar for an hour" limited
 *    to the same vendor and an amount; the next similar bill runs under the grant, and its audit
 *    row names the grant ("under permission from <person> until <the grant's end>"); one over the
 *    amount, or for another vendor, asks again; once the grant is taken back, or its hour is up
 *    (the clock faked), the next one asks;
 *  - batch approval: five requests of the same operation approved in one call, each run on its own
 *    with its own audit row (time entries, and bills, which post: the entry number one takes does
 *    not make the next stale, nor does a posting elsewhere in the books); a request that needs two
 *    people is refused in a batch (and two different people approve it on its own);
 *  - confirmation flags: a duplicate bill number answers needs_confirmation, and runs when sent
 *    again with confirm (straight away for a trusted agent; after a person's yes for one that asks,
 *    whose card shows the warning in the app's own words); a duplicate a person enters while the
 *    agent waits makes the yes fail with the app's own warning, which the agent reads;
 *  - a memorized transaction always asks, and its card shows the schedule and the next 3 dates;
 *  - one round trip per area of plan §8 that Phase 1 covers: sales, purchases, banking,
 *    inventory, lists, time and sales tax (find, dry run, ask, approve, in the books, named).
 *
 * A step that does not behave as the plan says is kept as it.fails with a comment naming what is
 * wrong and where, never bent to pass. None is left in this file (wave 5).
 *
 * Order: vitest runs the tests of this file one after the other, in the order written, and some
 * build on the ones before them in their describe (a grant given, a request asked for, a card
 * read). Each describe or test that does says so, naming the test it relies on. Run the file
 * whole: one such test picked alone with -t, or moved above the one it relies on, fails for that
 * reason only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentGrants,
  auditLogs,
  bills,
  customers,
  invoices,
  items,
  journalEntryLines,
  mileageLogs,
  paymentChecks,
  timeEntries,
  transfers,
} from '@/lib/db/schema';
import { localDateTime } from '@/lib/reports/dates';
import { getAuditLog } from '@/lib/services/auditTrail';
import { listGrants, revokeGrant } from '@/lib/services/agentGrants';
import { pauseAgent, saveAgentPolicy } from '@/lib/services/agentPolicies';
import { createRole, updateUser } from '@/lib/services/users';
import { operationById } from '@/lib/agent/operations/registry';
import { createVendor } from '@/lib/services/vendors';
import { createBill } from '@/lib/services/bills';
import { createItem } from '@/lib/services/items';
import { createTaxAgency } from '@/lib/services/salesTax';
import { postJournalEntry } from '@/lib/services/posting';
import { resetAgentRateLimits } from '@/lib/agent/operate';
import { ServiceError } from '@/lib/services/_base';
import type { AgentOperationAnswer, AgentRequestForPerson, ApproveResult } from '@/lib/agent/contract';
import { createdId, scenarioEnv, setupScenario, type Scenario, type ScenarioAgent } from './helpers/agentScenario';

scenarioEnv('test-agent-phase1-exit');

let s: Scenario;
let otherVendorId: string;
let widgetId: string;
let agencyId: string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function billBody(amount: string, opts: { vendorId?: string; billNumber?: string | null; date?: string } = {}) {
  return {
    vendorId: opts.vendorId ?? s.rich.vendorId,
    billNumber: opts.billNumber === undefined ? null : opts.billNumber,
    date: opts.date ?? '2026-11-09',
    lines: [{ accountId: s.rich.acct['6300'], description: 'Office supplies', amount }],
  };
}

async function billCount(): Promise<number> {
  return (await s.db.select({ id: bills.id }).from(bills).where(eq(bills.companyId, s.companyId))).length;
}

/** Ask for an operation and check the answer is a pending request. */
async function ask(agent: ScenarioAgent, operation: string, body: unknown, requestId: string, reason = 'Entering this week\'s paperwork.'): Promise<AgentOperationAnswer> {
  const a = await agent.run({ operation, body, requestId, reason });
  expect(a.outcome, `${operation} ${requestId}: ${JSON.stringify(a).slice(0, 500)}`).toBe('asked');
  expect(a.status).toBe('pending');
  expect(a.requestId).toMatch(UUID);
  return a;
}

function expectExecuted(r: ApproveResult): void {
  expect(r.status, JSON.stringify({ status: r.request.status, error: r.request.error, stale: r.request.stale })).toBe('executed');
  expect(r.request.status).toBe('executed');
}

beforeAll(async () => {
  s = await setupScenario('test-agent-phase1-exit');
  const adminCtx = await s.admin.ctx();
  otherVendorId = (await createVendor(adminCtx, { displayName: 'Other Supplies Ltd' })).id;
  widgetId = (
    await createItem(adminCtx, {
      name: 'Widget',
      type: 'inventory',
      salesPrice: '12.00',
      purchaseCost: '4.00',
      incomeAccountId: s.rich.acct['4000'],
      expenseAccountId: s.rich.acct['5000'],
      assetAccountId: s.rich.acct['1300'],
    })
  ).id;
  agencyId = (await createTaxAgency(adminCtx, { name: 'State Department of Revenue' })).id;
}, 240_000);

afterAll(async () => {
  await s?.close();
});

beforeEach(() => {
  resetAgentRateLimits();
});

afterEach(() => {
  // A test that moved the clock (Date only) puts it back even when it failed half way.
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Standing permission (plan §4.4)
// ---------------------------------------------------------------------------

// Relies on order: the first test gives the grant (grantId, grantExpiresAt) that every later test
// of this describe uses, up to 'once the grant is taken back', which revokes it; and the uses
// counted on the grant add up over the tests before. Only the last test ('a grant ends after its
// hour') stands on its own.
describe('Phase 1 exit: standing permission ("approve this and similar")', () => {
  let agent: ScenarioAgent;
  let grantId: string;
  let grantExpiresAt: string;

  /** The words the audit trail and the transaction log name a run under that grant with. */
  const underGrantWords = () =>
    // auditTrail.ts / transactionLog.ts standingPermissionWords: the grant's own end, on the
    // company's clock (its Preferences time zone), as localDateTime words it.
    `${agent.name} (agent), under permission from ${s.admin.name} until ${localDateTime(grantExpiresAt, s.zone)}`;

  beforeAll(async () => {
    agent = await s.makeAgent('Grant Asker', 'ask_every_change');
  });

  it('a person approves one bill with "this and similar for an hour", limited to the same vendor and an amount', async () => {
    const before = await billCount();
    const asked = await ask(agent, 'bills.create', billBody('120.00'), 'p1-grant-1');
    const card = await s.admin.request(asked.requestId!);
    expect(card.canApprove, card.cannotApproveWhy ?? '').toBe(true);
    expect(card.amount).toBe('120.00');
    expect(card.needs?.grantable).toBe('yes');
    expect(card.grantMinutesMax).toBeGreaterThanOrEqual(60);

    // "Similar" as plan §4.4 words it: the same vendor, and an amount at or below the shown amount.
    const constraints = { entityIds: [s.rich.vendorId], maxAmount: card.amount! };
    const approved = await s.admin.approve(asked.requestId!, { grant: { minutes: 60, constraints } });
    expectExecuted(approved);
    expect(approved.request.grantError ?? null).toBeNull();
    expect(approved.request.grantId).toMatch(UUID);
    expect(approved.request.grant?.minutes).toBe(60);
    expect(approved.request.grant?.constraints).toMatchObject(constraints);
    grantId = approved.request.grantId!;
    grantExpiresAt = approved.request.grant!.expiresAt;
    // For an hour from now.
    const lasts = Date.parse(grantExpiresAt) - Date.now();
    expect(lasts).toBeGreaterThan(58 * 60_000);
    expect(lasts).toBeLessThanOrEqual(60 * 60_000);
    // The end the person is shown is the one kept on the grant.
    const [kept] = await s.db.select({ expiresAt: agentGrants.expiresAt }).from(agentGrants).where(eq(agentGrants.id, grantId));
    expect(kept.expiresAt.toISOString()).toBe(new Date(grantExpiresAt).toISOString());
    expect(await billCount()).toBe(before + 1);

    // It is listed, live, for the agent; and the agent sees it in get_my_permissions.
    const live = await listGrants(await s.admin.ctx(), { agentId: agent.id, live: true });
    expect(live.map((g) => g.id)).toContain(grantId);
    const given = live.find((g) => g.id === grantId)!;
    expect(given.operation).toBe('bills.create');
    expect(given.givenBy).toBe(s.admin.id);
    const mine = await agent.verb('get_my_permissions', {});
    expect(mine.grants.map((g) => g.id)).toContain(grantId);
  });

  it('the next similar bill runs under the grant, and its audit row names the grant', async () => {
    expect(grantId).toBeTruthy();
    const before = await billCount();
    const pendingBefore = (await s.admin.requests({ agentId: agent.id })).length;
    const ran = await agent.run({ operation: 'bills.create', body: billBody('80.00'), requestId: 'p1-grant-2', reason: 'The next supplies bill.' });
    expect(ran.outcome, JSON.stringify(ran).slice(0, 500)).toBe('posted');
    expect(ran.grantId).toBe(grantId);
    expect(ran.requestId).toBeUndefined();
    expect(await billCount()).toBe(before + 1);
    expect((await s.admin.requests({ agentId: agent.id })).length).toBe(pendingBefore);

    const id = createdId(ran.result);
    const audit = await s.auditOf(id);
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) {
      expect(a.agentId).toBe(agent.id);
      expect(a.agentGrantId).toBe(grantId);
      expect(a.approvedBy).toBeNull();
      expect(a.agentRequestId).toBeNull();
    }
    const one = await getAuditLog(await s.admin.ctx(), audit[0].id);
    expect(one.agentGrantId).toBe(grantId);
    // "until" is this grant's own end (not the time it was given, nor the request's expiry).
    const words = underGrantWords();
    expect(words).toMatch(/ until \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(one.actorName).toBe(words);
    // Every record the run wrote (the bill, its ledger entry …) names the grant, not only the bill.
    const underGrant = (await s.db.select().from(auditLogs).where(eq(auditLogs.agentGrantId, grantId))).filter(
      (a) => a.entityType !== 'agent_permission_request' && a.entityType !== 'agent_grant' && a.agentRequestId === null,
    );
    expect(underGrant.length).toBeGreaterThanOrEqual(audit.length);
    for (const a of underGrant) {
      expect(a.agentId).toBe(agent.id);
      expect(a.approvedBy).toBeNull();
    }
    // The transaction log says the same.
    const logged = s.logOf(id);
    expect(logged.length).toBeGreaterThan(0);
    for (const r of logged) {
      expect(r.userName).toBe(words);
      expect(r.agentGrantId).toBe(grantId);
      expect(r.approvedBy).toBeUndefined();
    }

    // The use is counted on the grant.
    const [g] = await s.db.select({ uses: agentGrants.uses }).from(agentGrants).where(eq(agentGrants.id, grantId));
    expect(g.uses).toBe(1);

    // The same request id again is the first answer: no second bill, no second use.
    const replay = await agent.run({ operation: 'bills.create', body: billBody('80.00'), requestId: 'p1-grant-2', reason: 'The next supplies bill.' });
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toBe('posted');
    expect(replay.grantId).toBe(grantId);
    expect(await billCount()).toBe(before + 1);
    const [g2] = await s.db.select({ uses: agentGrants.uses }).from(agentGrants).where(eq(agentGrants.id, grantId));
    expect(g2.uses).toBe(1);
  });

  it('a bill of exactly the amount still runs under the grant ("at or below")', async () => {
    const before = await billCount();
    const ran = await agent.run({ operation: 'bills.create', body: billBody('120.00'), requestId: 'p1-grant-equal' });
    expect(ran.outcome, JSON.stringify(ran).slice(0, 500)).toBe('posted');
    expect(ran.grantId).toBe(grantId);
    expect(await billCount()).toBe(before + 1);
    const [g] = await s.db.select({ uses: agentGrants.uses }).from(agentGrants).where(eq(agentGrants.id, grantId));
    expect(g.uses).toBe(2);
  });

  it('a bill over the amount asks again, even by a cent', async () => {
    const before = await billCount();
    const cent = await ask(agent, 'bills.create', billBody('120.01'), 'p1-grant-cent');
    expect(cent.grantId).toBeUndefined();
    const asked = await ask(agent, 'bills.create', billBody('200.00'), 'p1-grant-over');
    expect(asked.grantId).toBeUndefined();
    expect(await billCount()).toBe(before);
  });

  it('a bill for another vendor asks again', async () => {
    const before = await billCount();
    const asked = await ask(agent, 'bills.create', billBody('50.00', { vendorId: otherVendorId }), 'p1-grant-vendor');
    expect(asked.grantId).toBeUndefined();
    expect(await billCount()).toBe(before);
  });

  it('other work for the same vendor, within the amount, asks: a grant is for one operation', async () => {
    const asked = await ask(
      agent,
      'purchase-orders.create',
      { vendorId: s.rich.vendorId, date: '2026-11-09', lines: [{ accountId: s.rich.acct['6300'], description: 'Paper', quantity: '1', rate: '20.00' }] },
      'p1-grant-other-op',
    );
    expect(asked.grantId).toBeUndefined();
  });

  it('a bill that needs a "yes, I am sure" flag is never covered by the grant: it asks', async () => {
    // PS-77 is the fixture's own bill number from this vendor: a duplicate.
    const body = billBody('40.00', { billNumber: 'PS-77' });
    const warned = await agent.run({ operation: 'bills.create', body, requestId: 'p1-grant-dup', reason: 'Entering it again.' });
    expect(warned.outcome).toBe('needs_confirmation');
    const before = await billCount();
    const asked = await agent.run({ operation: 'bills.create', body, requestId: 'p1-grant-dup', confirm: ['allowDuplicateNumber'], reason: 'Entering it again.' });
    expect(asked.outcome).toBe('asked');
    expect(asked.grantId).toBeUndefined();
    expect(await billCount()).toBe(before);
  });

  it('once the grant is taken back, the next similar bill asks', async () => {
    // Still covered just before.
    const covered = await agent.run({ operation: 'bills.create', body: billBody('60.00'), dryRun: true });
    expect(covered.note).toMatch(/standing permission/);

    await revokeGrant(await s.admin.ctx(), grantId);
    const live = await listGrants(await s.admin.ctx(), { agentId: agent.id, live: true });
    expect(live.map((g) => g.id)).not.toContain(grantId);
    expect((await agent.verb('get_my_permissions', {})).grants).toEqual([]);

    const before = await billCount();
    const asked = await ask(agent, 'bills.create', billBody('60.00'), 'p1-grant-revoked');
    expect(asked.grantId).toBeUndefined();
    expect(await billCount()).toBe(before);
  });

  // On its own: its own agent and grant. The clock is faked (Date only: PGlite's timers keep
  // running), as lib/services/agentGrants.test.ts does; a grant's end is compared with the
  // server's own clock (agentGrants.ts liveGrants), so this is the hour running out.
  it('a grant ends after its hour: a minute before, a similar bill is covered; a minute after, it asks', async () => {
    const expiring = await s.makeAgent('Expiry Asker', 'ask_every_change');
    const first = await ask(expiring, 'bills.create', billBody('15.00'), 'p1-expiry-1');
    const given = await s.admin.approve(first.requestId!, { grant: { minutes: 60, constraints: { entityIds: [s.rich.vendorId], maxAmount: '100.00' } } });
    expectExecuted(given);
    const givenId = given.request.grantId!;
    expect(givenId).toMatch(UUID);
    const ends = Date.parse(given.request.grant!.expiresAt);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(ends - 60_000));
    const covered = await expiring.run({ operation: 'bills.create', body: billBody('16.00'), dryRun: true });
    expect(covered.note).toMatch(/standing permission/);
    expect((await expiring.verb('get_my_permissions', {})).grants.map((g) => g.id)).toContain(givenId);

    vi.setSystemTime(new Date(ends + 60_000));
    expect((await listGrants(await s.admin.ctx(), { agentId: expiring.id, live: true })).map((g) => g.id)).not.toContain(givenId);
    expect((await expiring.verb('get_my_permissions', {})).grants).toEqual([]);
    const before = await billCount();
    const asked = await ask(expiring, 'bills.create', billBody('16.00'), 'p1-expiry-2');
    expect(asked.grantId).toBeUndefined();
    expect(await billCount()).toBe(before);
    const [g] = await s.db.select({ uses: agentGrants.uses }).from(agentGrants).where(eq(agentGrants.id, givenId));
    expect(g.uses).toBe(0);
    vi.useRealTimers();
  });
});

describe('Phase 1: asking ahead for standing permission, and "always allow" (plan §4.4, §6.1)', () => {
  it('ask_for_permission asks ahead; once a person gives it, the bills it covers run under it', async () => {
    const agent = await s.makeAgent('Ahead Asker', 'ask_every_change');
    const constraints = { entityIds: [s.rich.vendorId], maxAmount: '300.00' };
    const asked = await agent.verb('ask_for_permission', {
      operation: 'bills.create',
      constraints,
      minutes: 60,
      reason: 'I will enter this vendor\'s November bills this afternoon.',
      requestId: 'p1-ahead-1',
    });
    expect(asked.outcome, JSON.stringify(asked).slice(0, 500)).toBe('asked');
    const card = await s.admin.request(asked.requestId!);
    expect(card.kind).toBe('grant');
    expect(card.grantAsked?.minutes).toBe(60);
    expect(card.grantAsked?.constraints).toMatchObject(constraints);
    expect(card.canApprove, card.cannotApproveWhy ?? '').toBe(true);

    const given = await s.admin.approve(asked.requestId!);
    expectExecuted(given);
    expect(given.request.grantId).toMatch(UUID);
    const grantId = given.request.grantId!;

    const again = await agent.verb('ask_for_permission', {
      operation: 'bills.create',
      constraints,
      minutes: 60,
      reason: 'I will enter this vendor\'s November bills this afternoon.',
      requestId: 'p1-ahead-1',
    });
    expect(again.outcome).toBe('done');
    expect(again.grantId).toBe(grantId);

    const before = await billCount();
    const ran = await agent.run({ operation: 'bills.create', body: billBody('240.00', { billNumber: 'P1-AHEAD-1' }), requestId: 'p1-ahead-bill-1' });
    expect(ran.outcome, JSON.stringify(ran).slice(0, 500)).toBe('posted');
    expect(ran.grantId).toBe(grantId);
    expect(await billCount()).toBe(before + 1);
    for (const a of await s.auditOf(createdId(ran.result))) expect(a.agentGrantId).toBe(grantId);
  });

  it('a grant runs on its giver\'s access: once the giver loses the right, or is deactivated, the next one asks (plan §4.5)', async () => {
    const adminCtx = await s.admin.ctx();
    for (const [i, change] of [
      ['demoted', (id: string) => updateUser(adminCtx, id, { roleKeys: ['reports_only'] })],
      ['deactivated', (id: string) => updateUser(adminCtx, id, { isActive: false })],
    ] as const) {
      const giver = await s.addPerson(`Giver ${i}`, ['full_access']);
      const agent = await s.makeAgent(`Giver Asker ${i}`, 'ask_every_change');
      const first = await ask(agent, 'bills.create', billBody('20.00'), `p1-giver-${i}-1`);
      const given = await giver.approve(first.requestId!, { grant: { minutes: 60, constraints: { entityIds: [s.rich.vendorId], maxAmount: '100.00' } } });
      expectExecuted(given);
      const grantId = given.request.grantId!;
      expect(grantId).toMatch(UUID);

      const ran = await agent.run({ operation: 'bills.create', body: billBody('21.00'), requestId: `p1-giver-${i}-2` });
      expect(ran.outcome, `${i}: ${JSON.stringify(ran).slice(0, 400)}`).toBe('posted');
      expect(ran.grantId).toBe(grantId);
      const [a] = await s.auditOf(createdId(ran.result));
      const until = localDateTime(given.request.grant!.expiresAt, s.zone);
      expect((await getAuditLog(adminCtx, a.id)).actorName).toBe(`${agent.name} (agent), under permission from ${giver.name} until ${until}`);

      await change(giver.id);
      const after = await ask(agent, 'bills.create', billBody('22.00'), `p1-giver-${i}-3`);
      expect(after.grantId, i).toBeUndefined();
    }
  });

  it('only an Admin may loosen the policy ("always allow"); tightening and pausing are open to whoever manages agents', async () => {
    const agent = await s.makeAgent('Policy Asker', 'ask_every_change');
    const adminCtx = await s.admin.ctx();
    const managerRole = await createRole(adminCtx, { name: 'Agent Manager', permissions: { users: ['full'] } });
    // Full Access plus Users & Roles: manages agents (and holds every right the agent has), not an Admin.
    const cleo = await s.addPerson('Cleo Manager', ['full_access', managerRole.key]);
    const area = operationById('bills.create')!.area!;

    // Tightening: open to Cleo.
    await saveAgentPolicy(await cleo.ctx(), agent.id, { twoPersonOver: '5000.00' });
    // Pausing: open to Cleo, and the agent is then refused at the way in.
    await pauseAgent(await cleo.ctx(), agent.id, true);
    const paused = await agent.ctx().catch((e) => e);
    expect(paused).toBeInstanceOf(ServiceError);
    expect((paused as ServiceError).code).toBe('FORBIDDEN');
    await pauseAgent(await cleo.ctx(), agent.id, false);

    // Loosening: refused for Cleo, whole, and nothing changes.
    const allow = [{ class: 'enter' as const, area, setting: 'allow' as const }];
    const refused = await saveAgentPolicy(await cleo.ctx(), agent.id, { overrides: allow }).catch((e) => e);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe('FORBIDDEN');
    expect((refused as ServiceError).message).toMatch(/Admin/);
    await ask(agent, 'bills.create', billBody('30.00', { billNumber: 'P1-POLICY-1' }), 'p1-policy-ask');

    // The Admin loosens it in the Agents tab: from then on such a bill runs without asking.
    await saveAgentPolicy(adminCtx, agent.id, { overrides: allow });
    const before = await billCount();
    const ran = await agent.run({ operation: 'bills.create', body: billBody('30.00', { billNumber: 'P1-POLICY-2' }), requestId: 'p1-policy-run' });
    expect(ran.outcome, JSON.stringify(ran).slice(0, 500)).toBe('posted');
    expect(ran.grantId).toBeUndefined();
    expect(await billCount()).toBe(before + 1);
    const audit = await s.auditOf(createdId(ran.result));
    for (const a of audit) {
      expect(a.agentId).toBe(agent.id);
      expect(a.approvedBy).toBeNull();
      expect(a.agentGrantId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Batch approve (plan §7.2)
// ---------------------------------------------------------------------------

describe('Phase 1 exit: batch approval', () => {
  it('five requests of the same operation are approved in one call, each with its own audit row', async () => {
    const agent = await s.makeAgent('Batch Asker', 'ask_every_change');
    const asked: AgentOperationAnswer[] = [];
    for (let i = 1; i <= 5; i++) {
      asked.push(
        await ask(
          agent,
          'time-entries.create',
          { customerId: s.rich.customerId, date: `2026-11-1${i}`, hours: `${i}`, description: `Timesheet day ${i}`, billable: true },
          `p1-batch-${i}`,
          'Entering the week from the timesheet.',
        ),
      );
    }
    const before = (await s.db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.companyId, s.companyId))).length;

    const results = await s.admin.batch(asked.map((a) => a.requestId!));
    expect(results).toHaveLength(5);
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = results[i];
      expect(r.request.id).toBe(asked[i].requestId);
      expectExecuted(r);
      expect(r.request.decidedByName).toBe(s.admin.name);
      const id = createdId(r.request.result);
      ids.add(id);
      const [row] = await s.db.select().from(timeEntries).where(eq(timeEntries.id, id));
      expect(row?.description).toBe(`Timesheet day ${i + 1}`);
      // Its own audit row: this request, this person, this agent.
      const audit = await s.auditOf(id);
      expect(audit.length).toBeGreaterThan(0);
      for (const a of audit) {
        expect(a.agentId).toBe(agent.id);
        expect(a.approvedBy).toBe(s.admin.id);
        expect(a.agentRequestId).toBe(r.request.id);
      }
    }
    expect(ids.size).toBe(5);
    const after = (await s.db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.companyId, s.companyId))).length;
    expect(after).toBe(before + 5);
  });

  it('requests for different operations are refused together, before any runs', async () => {
    const agent = await s.makeAgent('Mixed Batch Asker', 'ask_every_change');
    const time = await ask(
      agent,
      'time-entries.create',
      { customerId: s.rich.customerId, date: '2026-11-16', hours: '1', description: 'Mixed batch', billable: false },
      'p1-mixed-time',
    );
    const bill = await ask(agent, 'bills.create', billBody('45.00', { billNumber: 'P1-MIXED-1' }), 'p1-mixed-bill');
    const before = await billCount();
    const err = await s.admin.batch([time.requestId!, bill.requestId!]).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('VALIDATION');
    expect(await billCount()).toBe(before);
    expect((await s.admin.request(time.requestId!)).status).toBe('pending');
    expect((await s.admin.request(bill.requestId!)).status).toBe('pending');
  });

  it('a request that needs two people is refused in a batch, and two different people approve it on its own', async () => {
    const agent = await s.makeAgent('Two Person Asker', 'ask_every_change');
    // Setting a two-person amount where there was none tightens the policy.
    await saveAgentPolicy(await s.admin.ctx(), agent.id, { twoPersonOver: '1000.00' });

    const big = await ask(agent, 'bills.create', billBody('1500.00', { billNumber: 'P1-BIG-1' }), 'p1-two-big');
    expect(big.needs?.twoPerson).toBe(true);
    const small = await ask(agent, 'bills.create', billBody('100.00', { billNumber: 'P1-SMALL-1' }), 'p1-two-small');
    expect(small.needs?.twoPerson).toBe(false);

    const before = await billCount();
    const err = await s.admin.batch([small.requestId!, big.requestId!]).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('VALIDATION');
    expect((err as ServiceError).message).toMatch(/two people/);
    // Refused as a whole, before anything ran.
    expect(await billCount()).toBe(before);
    expect((await s.admin.request(big.requestId!)).status).toBe('pending');
    expect((await s.admin.request(small.requestId!)).status).toBe('pending');

    // On its own: the first yes waits for a second, different person.
    const first = await s.admin.approve(big.requestId!);
    expect(first.status).toBe('needs_second_approver');
    expect(await billCount()).toBe(before);
    await expect(s.admin.approve(big.requestId!)).rejects.toBeInstanceOf(ServiceError);
    const second = await s.second.approve(big.requestId!);
    expectExecuted(second);
    expect(second.request.decidedByName).toBe(s.admin.name);
    expect(second.request.secondApproverName).toBe(s.second.name);
    expect(await billCount()).toBe(before + 1);
    const audit = await s.auditOf(createdId(second.request.result));
    for (const a of audit) {
      expect(a.agentId).toBe(agent.id);
      expect(a.agentRequestId).toBe(big.requestId);
      expect([s.admin.id, s.second.id]).toContain(a.approvedBy);
    }
  });

  it('standing permission never stands in for the second person (D8)', async () => {
    const agent = await s.makeAgent('Two Person Grant Asker', 'ask_every_change');
    await saveAgentPolicy(await s.admin.ctx(), agent.id, { twoPersonOver: '1000.00' });
    // With a grant up to 5,000, a bill over the two-person amount still asks two people; one under
    // it runs under the grant.
    const small = await ask(agent, 'bills.create', billBody('100.00', { billNumber: 'P1-SMALL-2' }), 'p1-twog-small');
    const given = await s.admin.approve(small.requestId!, { grant: { minutes: 60, constraints: { entityIds: [s.rich.vendorId], maxAmount: '5000.00' } } });
    expectExecuted(given);
    const grantId = given.request.grantId;
    expect(grantId).toMatch(UUID);
    const over = await ask(agent, 'bills.create', billBody('1500.00', { billNumber: 'P1-BIG-2' }), 'p1-twog-big');
    expect(over.needs?.twoPerson).toBe(true);
    expect(over.grantId).toBeUndefined();
    const under = await agent.run({ operation: 'bills.create', body: billBody('800.00', { billNumber: 'P1-UNDER-1' }), requestId: 'p1-twog-under' });
    expect(under.outcome).toBe('posted');
    expect(under.grantId).toBe(grantId);
  });

  // Relies on order: the second test approves the five requests the first one asks for (asked).
  describe('five bills', () => {
    let agent: ScenarioAgent;
    const asked: AgentOperationAnswer[] = [];

    it('five bills (work that posts) are asked for, each its own request', async () => {
      agent = await s.makeAgent('Bill Batch Asker', 'ask_every_change');
      for (let i = 1; i <= 5; i++) {
        asked.push(await ask(agent, 'bills.create', billBody(`${10 + i}.00`, { billNumber: `P1-BATCH-BILL-${i}` }), `p1-batch-bill-${i}`));
      }
      expect(new Set(asked.map((a) => a.requestId)).size).toBe(5);
    });

    // Plan §7.2 batch approve, Phase 1 exit "five same-operation requests approved in one call",
    // for work that posts. Each bill's run takes the next journal entry number, which the bill
    // before it moved (lib/services/posting.ts postJournalEntry, MAX(entry_number)+1). The
    // staleness key leaves out what a run assigns itself (lib/agent/bridge.ts stalenessKeyOf: an
    // entry's number is not read; keyValue reads a number of TAKEN_COLUMNS the run took as
    // "#own"), so none of the five makes the next one stale (plan §7.4, "the touched records'
    // versions"). Was it.fails until wave 4: then only the first ran and four came back 'stale'.
    it('are approved in one call, each with its own audit row', async () => {
      expect(asked).toHaveLength(5);
      const before = await billCount();
      const results = await s.admin.batch(asked.map((a) => a.requestId!));
      expect(results.map((r) => r.status)).toEqual(['executed', 'executed', 'executed', 'executed', 'executed']);
      expect(await billCount()).toBe(before + 5);
      const entries = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const r = results[i];
        expect(r.request.id).toBe(asked[i].requestId);
        expect(r.request.posted).toBe(true);
        // Its own bill, of its own amount, with its own ledger entry.
        const [bill] = await s.db.select().from(bills).where(eq(bills.id, createdId(r.request.result)));
        expect(bill.billNumber).toBe(`P1-BATCH-BILL-${i + 1}`);
        expect(bill.total).toBe(`${11 + i}.00`);
        expect(bill.postedEntryId).toMatch(UUID);
        expect(r.request.entryIds).toContain(bill.postedEntryId);
        entries.add(bill.postedEntryId!);
        for (const a of await s.auditOf(bill.id)) {
          expect(a.agentId).toBe(agent.id);
          expect(a.agentRequestId).toBe(r.request.id);
          expect(a.approvedBy).toBe(s.admin.id);
        }
      }
      expect(entries.size).toBe(5);
    });
  });

  // Relies on order: the second test approves the bill the first one asks for (asked), after the
  // first one's journal entry.
  describe('a posting elsewhere in the books', () => {
    let asked: AgentOperationAnswer | null = null;

    it('a bill is asked for; then a person posts a journal entry between accounts the bill does not touch, naming no one', async () => {
      const agent = await s.makeAgent('Elsewhere Asker', 'ask_every_change');
      asked = await ask(agent, 'bills.create', billBody('33.00', { billNumber: 'P1-ELSEWHERE-1' }), 'p1-elsewhere-1');
      await postJournalEntry(await s.admin.ctx(), {
        date: new Date('2026-11-12'),
        description: 'Petty cash for postage',
        lines: [
          { accountId: s.rich.acct['6400'], debit: '12.00' },
          { accountId: s.rich.acct['1010'], credit: '12.00' },
        ],
      });
    });

    // Plan §7.4: "the server compares the touched records' versions with the staleness key".
    // Nothing the bill reads or writes changed (another expense account, the savings account, no
    // vendor); only the next journal entry number moved, which the bill's own entry takes, and the
    // staleness key leaves that out (lib/agent/bridge.ts stalenessKeyOf, see the test above). So a
    // posting anyone makes elsewhere while an agent waits leaves the request as it was. Was it.fails
    // until wave 4. A change to what the request reads still makes it stale: the Phase 0 exit test
    // 'the books changed since the agent asked' (an item's price).
    it('leaves the waiting bill as it was: it runs on the first yes', async () => {
      expect(asked?.requestId).toBeTruthy();
      const r = await s.admin.approve(asked!.requestId!);
      expectExecuted(r);
      expect(r.request.stale ?? false).toBe(false);
      const [bill] = await s.db.select().from(bills).where(eq(bills.id, createdId(r.request.result)));
      expect(bill.billNumber).toBe('P1-ELSEWHERE-1');
      expect(bill.total).toBe('33.00');
      expect(r.request.posted).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Confirmation flags (plan §5.6)
// ---------------------------------------------------------------------------

describe('Phase 1 exit: confirmation flags', () => {
  /** The approval card of a request sent with a confirmation flag, and the warning it accepted. */
  let flaggedCard: AgentRequestForPerson | null = null;
  let warningMessage: string | null = null;

  it('a duplicate bill number answers needs_confirmation, and runs when sent again with confirm', async () => {
    const agent = await s.makeAgent('Trusted Confirmer', 'trusted_bookkeeper');
    // describe_operation names the flag the operation accepts.
    expect((await agent.verb('describe_operation', { operation: 'bills.create' })).confirmFlags).toContain('allowDuplicateNumber');
    // PS-77 is the fixture's own bill from this vendor.
    const body = billBody('310.40', { billNumber: 'PS-77', date: '2026-11-10' });
    const before = await billCount();

    const warned = await agent.run({ operation: 'bills.create', body, requestId: 'p1-dup-1' });
    expect(warned.outcome, JSON.stringify(warned).slice(0, 500)).toBe('needs_confirmation');
    expect(warned.warnings?.map((w) => w.flag)).toEqual(['allowDuplicateNumber']);
    expect(warned.warnings?.[0].message).toBeTruthy();
    expect(warned.note).toMatch(/confirm/);
    expect(await billCount()).toBe(before);

    const sent = await agent.run({ operation: 'bills.create', body, requestId: 'p1-dup-1', confirm: ['allowDuplicateNumber'] });
    expect(sent.outcome, JSON.stringify(sent).slice(0, 500)).toBe('posted');
    expect(await billCount()).toBe(before + 1);
    const dupes = await s.db
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.companyId, s.companyId), eq(bills.vendorId, s.rich.vendorId), eq(bills.billNumber, 'PS-77')));
    expect(dupes.length).toBe(2);
  });

  it('for an agent that asks, the warning comes first, then the flagged request is put to a person', async () => {
    const agent = await s.makeAgent('Asking Confirmer', 'ask_every_change');
    const body = billBody('88.12', { billNumber: 'PS-78', date: '2026-11-10' });
    const before = await billCount();

    const warned = await agent.run({ operation: 'bills.create', body, requestId: 'p1-dup-ask', reason: 'The vendor sent this bill again.' });
    expect(warned.outcome).toBe('needs_confirmation');
    expect(warned.warnings?.[0]?.message).toBeTruthy();
    warningMessage = warned.warnings![0].message;
    expect(await s.admin.requests({ agentId: agent.id })).toEqual([]);

    const asked = await agent.run({
      operation: 'bills.create',
      body,
      requestId: 'p1-dup-ask',
      confirm: ['allowDuplicateNumber'],
      reason: 'The vendor sent this bill again.',
    });
    expect(asked.outcome).toBe('asked');
    // A flagged request is judged one class higher (plan §5.6: enter becomes change).
    const card = await s.admin.request(asked.requestId!);
    expect(card.class).toBe('change');
    expect(card.input?.confirm).toEqual(['allowDuplicateNumber']);
    expect(card.preview, 'the request holds the preview of its dry run').toBeTruthy();
    flaggedCard = card;

    const approved = await s.admin.approve(asked.requestId!);
    expectExecuted(approved);
    expect(await billCount()).toBe(before + 1);
  });

  // Plan §5.6: "The warning text appears on the approval card, so the person answers the same
  // question they would have answered in the window". The request's preview comes from a dry run
  // made WITH the flag, where the route raises no warning; lib/agent/operate.ts change() dry runs
  // the input once more without the agent's flags (silencedWarnings) and adds the warnings they
  // silenced to the stored preview (withWarnings, each flag once), which the card's Preview.tsx
  // lists. Was it.fails until wave 4, when preview.warnings was always [].
  // Relies on order: the test above checks the steps before this claim and fills flaggedCard and
  // warningMessage.
  it('the approval card shows the warning the agent accepted (plan §5.6)', async () => {
    expect(flaggedCard && warningMessage).toBeTruthy();
    const warnings = flaggedCard!.preview?.warnings ?? [];
    // The app's own words, the same the agent was shown on its needs_confirmation answer, once.
    expect(warnings).toContainEqual(expect.objectContaining({ flag: 'allowDuplicateNumber', message: warningMessage }));
    expect(warnings.filter((w) => w.flag === 'allowDuplicateNumber')).toHaveLength(1);
  });

  it('a person enters the same bill while the agent waits: the yes fails with the app\'s own warning, and the agent is told (plan §7.2)', async () => {
    const agent = await s.makeAgent('Racing Asker', 'ask_every_change');
    const body = billBody('19.00', { billNumber: 'P1-RACE-1', date: '2026-11-10' });
    // No such bill yet: no warning, the request goes to a person.
    const asked = await ask(agent, 'bills.create', body, 'p1-race-1', 'The vendor emailed this bill.');

    // Meanwhile a person enters it in their own window.
    await createBill(await s.admin.ctx(), {
      vendorId: s.rich.vendorId,
      billNumber: 'P1-RACE-1',
      date: new Date('2026-11-10'),
      checkDuplicateNumber: true,
      lines: [{ accountId: s.rich.acct['6300'], description: 'Office supplies', amount: '19.00' }],
    });
    const before = await billCount();

    const r = await s.admin.approve(asked.requestId!);
    expect(r.status).toBe('failed');
    expect(r.request.status).toBe('failed');
    // The app's own words, and what the agent may do about it.
    expect(r.request.error).toMatch(/allowDuplicateNumber/);
    expect(await billCount()).toBe(before);

    const { requests } = await agent.verb('list_my_requests', { status: 'failed' });
    const mine = requests.find((q) => q.id === asked.requestId);
    expect(mine?.status).toBe('failed');
    expect(mine?.error).toBe(r.request.error);
    const replay = await agent.run({ operation: 'bills.create', body, requestId: 'p1-race-1', reason: 'The vendor emailed this bill.' });
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toBe('refused');
    expect(replay.note).toContain(r.request.error!);
    expect(await billCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Recurring (plan §8, "Recurring / memorized")
// ---------------------------------------------------------------------------

describe('Phase 1: a memorized transaction an agent makes always asks (plan §8)', () => {
  let agent: ScenarioAgent;
  let asked: AgentOperationAnswer;
  const body = () => ({
    name: 'Monthly paper order',
    docType: 'bill',
    frequency: 'monthly',
    nextRunDate: '2026-12-01',
    mode: 'automatic',
    template: { vendorId: s.rich.vendorId, lines: [{ accountId: s.rich.acct['6300'], description: 'Paper', amount: '95.00' }] },
  });

  beforeAll(async () => {
    // Trusted: entering runs without asking, yet a memorized transaction still asks.
    agent = await s.makeAgent('Recurring Bookkeeper', 'trusted_bookkeeper');
  });

  it('even for a trusted agent, making one is put to a person, with its schedule on the card, and no standing permission', async () => {
    const found = await agent.verb('find_operations', { query: 'recurring' });
    expect(found.operations.find((o) => o.id === 'recurring.create')?.treatment).toBe('ask');
    asked = await ask(agent, 'recurring.create', body(), 'p1-recurring-1', 'The vendor bills the same paper every month.');
    const card = await s.admin.request(asked.requestId!);
    expect(card.summary).toMatch(/monthly/);
    expect(card.needs?.grantable).toBe('no');
    expect(card.grantMinutesMax).toBe(0);

    const approved = await s.admin.approve(asked.requestId!);
    expectExecuted(approved);
    const id = createdId(approved.request.result);
    for (const a of await s.auditOf(id)) {
      expect(a.agentId).toBe(agent.id);
      expect(a.approvedBy).toBe(s.admin.id);
    }
  });

  // Plan §8, Recurring: "Creating or changing one is always Ask, and the card shows the schedule
  // and the next 3 dates". The request's summary, Ironbooks' own line at the top of the card, ends
  // with them (lib/agent/describe.ts runDatesText / nextRunDates, a copy of recurring.ts's schedule
  // helpers kept in step by its own parity test). Only the summary is read here: the preview's
  // record diff holds the first date (nextRunDate) anyway, but never the two after it. Was it.fails
  // until wave 4. Relies on order: the test above checks the steps before this claim and asks for
  // the request (asked) this one reads.
  it('the card shows the next 3 dates of the schedule', async () => {
    expect(asked?.requestId).toBeTruthy();
    const card = await s.admin.request(asked.requestId!);
    expect(card.summary).toMatch(/monthly/);
    expect(card.summary).toMatch(/2026-12-01, 2027-01-01, 2027-02-01/);
  });
});

// ---------------------------------------------------------------------------
// One round trip per area (plan §8)
// ---------------------------------------------------------------------------

interface AreaCase {
  area: string;
  operation: string;
  query: string;
  /** The run posts to the ledger (the agent's 'posted'), or only changes records ('done'). */
  posts: boolean;
  body: () => Record<string, unknown>;
  /** Checks the work is in the books; returns the record id the audit rows are about. */
  inBooks: (result: unknown) => Promise<string>;
}

async function one<T extends { id: unknown }>(rows: T[]): Promise<T> {
  expect(rows).toHaveLength(1);
  return rows[0];
}

function areaCases(): AreaCase[] {
  return [
    {
      area: 'sales',
      operation: 'invoices.create',
      query: 'invoice',
      posts: true,
      body: () => ({
        customerId: s.rich.customerId,
        date: '2026-11-06',
        lines: [{ accountId: s.rich.acct['4000'], description: 'Bookkeeping, November', quantity: '1', rate: '250.00' }],
      }),
      inBooks: async (result) => {
        const id = createdId(result);
        const row = await one(await s.db.select().from(invoices).where(eq(invoices.id, id)));
        expect(row.total).toBe('250.00');
        return id;
      },
    },
    {
      area: 'purchases',
      operation: 'bills.create',
      query: 'bill',
      posts: true,
      body: () => ({
        vendorId: s.rich.vendorId,
        billNumber: 'RT-ELEC-11',
        date: '2026-11-06',
        lines: [{ accountId: s.rich.acct['6600'], description: 'Electric, November', amount: '130.00' }],
      }),
      inBooks: async (result) => {
        const id = createdId(result);
        const row = await one(await s.db.select().from(bills).where(eq(bills.id, id)));
        expect(row.total).toBe('130.00');
        return id;
      },
    },
    {
      area: 'banking',
      operation: 'transfers.create',
      query: 'transfer',
      posts: true,
      body: () => ({ date: '2026-11-06', fromAccountId: s.rich.acct['1000'], toAccountId: s.rich.acct['1010'], amount: '75.00', memo: 'To savings' }),
      inBooks: async (result) => {
        const id = createdId(result);
        const row = await one(await s.db.select().from(transfers).where(eq(transfers.id, id)));
        expect(row.amount).toBe('75.00');
        return id;
      },
    },
    {
      area: 'inventory',
      operation: 'inventory.adjust',
      query: 'inventory adjust',
      posts: true,
      body: () => ({ action: 'adjust', itemId: widgetId, quantityChange: '10', unitCost: '4.00', date: '2026-11-06', memo: 'Found a box in the back' }),
      inBooks: async () => {
        const row = await one(await s.db.select().from(items).where(eq(items.id, widgetId)));
        expect(Number(row.quantityOnHand)).toBe(10);
        return widgetId;
      },
    },
    {
      area: 'lists',
      operation: 'customers.create',
      query: 'customer',
      posts: false,
      body: () => ({ displayName: 'Round Trip Bakery', email: 'orders@roundtrip.test' }),
      inBooks: async (result) => {
        const id = createdId(result);
        const row = await one(await s.db.select().from(customers).where(eq(customers.id, id)));
        expect(row.displayName).toBe('Round Trip Bakery');
        return id;
      },
    },
    {
      area: 'time',
      operation: 'mileage.create',
      query: 'mileage',
      posts: false,
      body: () => ({ date: '2026-11-06', miles: '42.5', ratePerMile: '0.70', purpose: 'Client visit', customerId: s.rich.customerId }),
      inBooks: async (result) => {
        const id = createdId(result);
        const row = await one(await s.db.select().from(mileageLogs).where(eq(mileageLogs.id, id)));
        expect(Number(row.miles)).toBe(42.5);
        return id;
      },
    },
    {
      area: 'sales tax',
      operation: 'sales-tax.payments.create',
      query: 'sales tax',
      posts: true,
      body: () => ({ date: '2026-11-06', paymentAccountId: s.rich.acct['1000'], payments: [{ agencyId, amount: '25.00' }] }),
      inBooks: async (result) => {
        const id = createdId(result);
        const row = await one(await s.db.select().from(paymentChecks).where(eq(paymentChecks.id, id)));
        // A Sales Tax Payment check of 25.00 to this agency, written on the checking account.
        expect(row.kind).toBe('sales_tax');
        expect(row.agencyId).toBe(agencyId);
        expect(row.amount).toBe('25.00');
        expect(row.paymentAccountId).toBe(s.rich.acct['1000']);
        // Its entry: Dr 2200 Sales Tax Payable 25.00, Cr checking 25.00 (liabilityPayments.ts paySalesTaxAgencies).
        expect(row.postedEntryId).toMatch(UUID);
        const lines = await s.db
          .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
          .from(journalEntryLines)
          .where(eq(journalEntryLines.journalEntryId, row.postedEntryId!));
        expect(lines).toHaveLength(2);
        expect(s.rich.acct['2200']).toMatch(UUID);
        expect(lines).toContainEqual(expect.objectContaining({ accountId: s.rich.acct['2200'], debit: '25.00' }));
        expect(lines).toContainEqual(expect.objectContaining({ accountId: s.rich.acct['1000'], credit: '25.00' }));
        return id;
      },
    },
  ];
}

describe('Phase 1 exit: one round trip per area (plan §8)', () => {
  let agent: ScenarioAgent;

  beforeAll(async () => {
    agent = await s.makeAgent('Area Asker', 'ask_every_change');
  });

  for (const c of areaCases()) {
    it(`${c.area}: ${c.operation} is found, dry run, asked for, approved, in the books and named`, async () => {
      const found = await agent.verb('find_operations', { query: c.query });
      const hit = found.operations.find((o) => o.id === c.operation);
      expect(hit, `${c.area}: ${JSON.stringify(found.operations.map((o) => o.id))}`).toBeTruthy();
      expect(hit!.treatment).toBe('ask');

      const dry = await agent.run({ operation: c.operation, body: c.body(), dryRun: true });
      expect(dry.outcome, `${c.area}: ${JSON.stringify(dry).slice(0, 500)}`).toBe('dry_run');
      expect(dry.note).toMatch(/ask a person/);

      const asked = await ask(agent, c.operation, c.body(), `p1-area-${c.operation}`, `Round trip for ${c.area}.`);
      const approved = await s.admin.approve(asked.requestId!);
      expectExecuted(approved);
      // What the run itself did (wave 3): posted to the ledger, and which entries.
      expect(approved.request.posted).toBe(c.posts);
      expect((approved.request.entryIds ?? []).length > 0).toBe(c.posts);

      const id = await c.inBooks(approved.request.result);
      const audit = (await s.auditOf(id)).filter((a) => a.agentRequestId === asked.requestId);
      expect(audit.length, `${c.area}: an audit row about ${id} under this request`).toBeGreaterThan(0);
      for (const a of await s.auditOfRequest(asked.requestId!)) {
        expect(a.agentId).toBe(agent.id);
        expect(a.approvedBy).toBe(s.admin.id);
      }
      const words = await getAuditLog(await s.admin.ctx(), audit[0].id);
      expect(words.actorName).toBe(`${agent.name} (agent), approved by ${s.admin.name}`);

      const replay = await agent.run({ operation: c.operation, body: c.body(), requestId: `p1-area-${c.operation}`, reason: `Round trip for ${c.area}.` });
      expect(replay.replayed).toBe(true);
      expect(replay.outcome).toBe(c.posts ? 'posted' : 'done');
    });
  }
});
