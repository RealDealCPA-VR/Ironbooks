/**
 * Plan Phase 3 exit (payroll and sensitive data, plan §5.9, §4.5, D6), end to end in process: a
 * real PGlite company, the agent's own request context (lib/agentContext.ts), the door
 * (lib/agent/operate.ts handleVerb), the approval service (lib/services/agentRequests.ts), the route
 * bridge and the app's own route handlers. Nothing is replaced but next/headers (there is no HTTP
 * request in a test).
 *
 *  - An agent finds, reads, tries and asks for a pay run with only the generic verbs; a person
 *    approves it once in their own window and the paychecks are in the books, named "agent,
 *    approved by person".
 *  - Every answer the agent got on the way is masked: no full SSN and no full bank account number,
 *    although the agent's role (Full Access) holds both View flags.
 *  - One approved reveal: an approver without "View sensitive payroll data" cannot approve it, one
 *    with it can; the agent then reads the full SSNs in that one answer, the next ordinary read is
 *    masked again and another reveal asks again. The audit trail words the reveal (which fields, to
 *    which agent, approved by whom). The answer stays readable by the agent for
 *    REVEAL_KEPT_MINUTES after the run (D6) and is masked for good afterwards.
 *
 * Where the build does not do what the plan says, the test stays as it.fails with what is wrong.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-phase3-exit`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-phase3-exit-secret';
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = `${root}/endpoints`;
  process.env.BKA_AGENT_FILES_DIR = `${root}/agent-files`;
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_AGENT_SHELL;
  delete process.env.BKA_AGENT_SHELL_KEY;
});

// The route handlers and the request-origin helper read next/headers; there is no request here.
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));

import path from 'node:path';
import { accounts, agentPermissionRequests, agentRequests, auditLogs, paychecks, payRuns } from '@/lib/db/schema';
import { operationForRoute } from '@/lib/agent/operations/registry';
import type { AgentOperationAnswer, AgentRequestView } from '@/lib/agent/contract';
import { createEmployee, updateEmployee } from '@/lib/services/payroll';
import { createBankAccount } from '@/lib/services/bankAccounts';
import { approveAgentRequest, requestForPerson, REVEAL_KEPT_MINUTES } from '@/lib/services/agentRequests';
import { ServiceError } from '@/lib/services/_base';
import {
  addPerson,
  closeScenario,
  freshLimits,
  holds,
  makeAgent,
  openScenario,
  requestKey,
  seenText,
  type Person,
  type Scenario,
  type ScenarioAgent,
} from './helpers/agentScenarioB';

type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DATA_DIR = path.resolve(process.env.BKA_DATA_DIR!);

/** Distinctive protected values: a scan cannot find them by chance. */
const SSN_DANA = '521-73-9846';
const SSN_LEE = '608-24-1357';
const BANK_NUMBER = '004417829013';
const PROTECTED = [SSN_DANA, SSN_LEE, BANK_NUMBER];

let s: Scenario;
let pat: Person; // Payroll Processor: holds "View sensitive payroll data"
let bo: Person; // Accountant: may approve payroll work, but not a reveal of SSNs
let agent: ScenarioAgent;
let dana: string;
let lee: string;

/** The registry's operation id of a route (the agent finds it with find_operations; the test looks it up). */
function idOf(method: string, route: string): string {
  const op = operationForRoute(method, route);
  if (!op) throw new Error(`No operation for ${method} ${route}`);
  return op.id;
}

const PAY_RUN = () => idOf('POST', '/api/payroll/pay-runs');
const EMPLOYEES = () => idOf('GET', '/api/employees');
const EMPLOYEE = () => idOf('GET', '/api/employees/[id]');
const BANK_ACCOUNTS = () => idOf('GET', '/api/bank-accounts');

const payRunBody = () => ({
  payDate: '2026-11-13',
  periodStart: '2026-11-01',
  periodEnd: '2026-11-14',
  memo: 'First half of November',
  employees: [
    { employeeId: dana, hours: '80' },
    { employeeId: lee, hours: '80' },
  ],
});

async function expectRefused(p: Promise<unknown>, code: string, message?: RegExp): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe(code);
    if (message) expect((e as ServiceError).message).toMatch(message);
    return e as ServiceError;
  }
  throw new Error(`expected ${code}`);
}

async function requestRow(id: string) {
  const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, id));
  return row;
}

/** Every answer the agent got, except those of the one approved reveal (by its request id). */
function seenExcept(requestIds: string[]): string {
  return JSON.stringify(agent.seen.filter((x) => !requestIds.includes(String((x.args as Out)?.requestId ?? ''))));
}

beforeAll(async () => {
  s = await openScenario(DATA_DIR, 'Phase Three Payroll Co');
  pat = await addPerson(s, 'Pat Payroll', 'payroll_processor');
  bo = await addPerson(s, 'Bo Accountant', 'accountant');

  // The books: two hourly employees with full SSNs, and the checking account's full bank number.
  const d = await createEmployee(s.seed, { firstName: 'Dana', lastName: 'Lee', payType: 'hourly', payRate: '25.00' });
  const l = await createEmployee(s.seed, { firstName: 'Lee', lastName: 'Park', payType: 'hourly', payRate: '30.00' });
  await updateEmployee(s.seed, d.id, { ssn: SSN_DANA });
  await updateEmployee(s.seed, l.id, { ssn: SSN_LEE });
  dana = d.id;
  lee = l.id;
  const [checking] = await s.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, s.companyId), eq(accounts.code, '1000')));
  await createBankAccount(s.seed, { accountId: checking.id, bankName: 'First Exit Bank', accountNumber: BANK_NUMBER });

  // Full Access holds both View flags: masking is the agent's own rule, never a role without them.
  agent = await makeAgent(s, { name: 'Payroll Agent', roleKeys: ['full_access'], preset: 'trusted_bookkeeper' });
  freshLimits();
}, 240_000);

afterAll(async () => {
  await closeScenario(s);
});

describe('Phase 3 exit: an agent prepares a pay run that a person approves', { timeout: 240_000 }, () => {
  let requestId: string;
  let key: string;

  it('the agent finds the pay run and sees that a person approves it', async () => {
    const perms = await agent.verb('get_my_permissions', {});
    expect(perms.agent.name).toBe('Payroll Agent');
    expect(perms.classes.bulk).toBe('ask');
    expect(perms.classes.read_sensitive).toBe('ask');

    const found = await agent.verb('find_operations', { query: 'pay-runs' });
    const run = found.operations.find((o) => o.id === PAY_RUN());
    expect(run, JSON.stringify(found.operations.map((o) => o.id))).toBeTruthy();
    // A pay run always asks, even for a trusted bookkeeper (classification alwaysAsk).
    expect(run!.treatment).toBe('ask');
    expect(run!.class).toBe('bulk');

    const desc = await agent.verb('describe_operation', { operation: PAY_RUN() });
    expect(desc.treatment).toBe('ask');
    expect(desc.notes.join(' ')).toMatch(/dry_run/);
  });

  it('reads the employees and the bank account: every SSN and bank number comes back masked', async () => {
    const list = await agent.run({ operation: EMPLOYEES() });
    expect(list.outcome).toBe('read');
    const people = list.result as Out[];
    expect(people.map((p) => p.firstName).sort()).toEqual(['Dana', 'Lee']);
    for (const p of people) {
      // The route gives the last four digits; the full number is not there in any form.
      expect(p.ssnLast4).toMatch(/^\d{4}$/);
      expect(typeof p.ssn === 'string' ? p.ssn : '').not.toMatch(/^\d{3}-?\d{2}-?\d{4}$/);
    }

    const one = await agent.run({ operation: EMPLOYEE(), params: { id: dana } });
    expect(one.outcome).toBe('read');
    expect((one.result as Out).ssnLast4).toBe('9846');

    const banks = await agent.run({ operation: BANK_ACCOUNTS() });
    expect(banks.outcome).toBe('read');
    const numbers = (banks.result as Out[]).map((b) => String(b.accountNumber ?? ''));
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) expect(n).toMatch(/^[•*]+9013$/);

    for (const v of PROTECTED) expect(holds(seenText(agent), v), `the agent read ${v}`).toBe(false);
  });

  it('a dry run of the pay run shows its paychecks and keeps nothing', async () => {
    const before = await s.db.select().from(paychecks);
    const dry = await agent.run({ operation: PAY_RUN(), body: payRunBody(), dryRun: true });
    expect(dry.outcome).toBe('dry_run');
    // One ledger entry per paycheck, both shown to whoever approves.
    expect(dry.preview?.ledger?.entries.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(dry.note).toMatch(/ask a person/);
    expect(await s.db.select().from(paychecks)).toHaveLength(before.length);
    for (const v of PROTECTED) expect(holds(JSON.stringify(dry), v), `the dry run showed ${v}`).toBe(false);
  });

  it('asking for it puts a request to a person, with the preview and the agent\'s reason', async () => {
    key = requestKey('pay-run');
    const asked = await agent.run({ operation: PAY_RUN(), body: payRunBody(), requestId: key, reason: 'Payroll for the first half of November.' });
    expect(asked.outcome).toBe('asked');
    expect(asked.requestId).toBeTruthy();
    requestId = asked.requestId!;
    expect(asked.status).toBe('pending');
    expect(asked.preview?.ledger?.entries.length ?? 0).toBeGreaterThanOrEqual(2);

    const mine = await agent.verb('list_my_requests', { status: 'pending' });
    const view = mine.requests.find((r) => r.id === requestId) as AgentRequestView;
    expect(view.class).toBe('bulk');
    expect(view.reason).toBe('Payroll for the first half of November.');
    expect(view.summary).toMatch(/2026-11-13/);
    expect(await s.db.select().from(paychecks)).toHaveLength(0);
  });

  // One yes is enough (plan §7.4: a person approves the preview on their screen, and it runs while
  // the books are as it showed). The staleness key leaves out what the run assigns to itself:
  // lib/agent/bridge.ts keyRules/keyText map the ids the run made, and their 8-digit prefixes (each
  // paycheck's journal reference is the first 8 hex digits of the new paycheck's id,
  // lib/services/payroll.ts), to "new:<kind>", so the approval's own dry run gives the stored key.
  it('a person approves it once in their own window and it runs (the books did not change)', async () => {
    const card = await requestForPerson(s.admin.ctx, requestId, { atHost: true });
    expect(card.canApprove).toBe(true);
    expect(card.stale ?? false).toBe(false);
    const done = await approveAgentRequest(s.admin.ctx, requestId, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    expect(done.request.stale ?? false).toBe(false);
    expect(done.request.posted).toBe(true);
    expect(done.request.entryIds?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the paychecks are in the books, named "agent, approved by person"; a second yes adds nothing', async () => {
    const runs = await s.db.select().from(payRuns).where(eq(payRuns.companyId, s.companyId));
    expect(runs).toHaveLength(1);
    const checks = await s.db.select().from(paychecks).where(eq(paychecks.companyId, s.companyId));
    expect(checks.map((c) => c.employeeId).sort()).toEqual([dana, lee].sort());

    // Every row the run wrote names the agent and the person who approved, under this request.
    const rows = await s.db.select().from(auditLogs).where(eq(auditLogs.agentRequestId, requestId));
    const written = rows.filter((r) => r.entityType !== 'agent_permission_request');
    expect(written.length).toBeGreaterThan(0);
    for (const r of written) {
      expect(r.agentId).toBe(agent.id);
      expect(r.approvedBy).toBe(s.admin.id);
    }
    // One decision, by the Admin: the request never went back to waiting with a new preview.
    const row = await requestRow(requestId);
    expect(row.status).toBe('executed');
    expect(row.decidedBy).toBe(s.admin.id);

    // The same yes again (an old window, a double click) runs nothing a second time.
    await expect(approveAgentRequest(s.admin.ctx, requestId, {}, { atHost: true })).rejects.toBeInstanceOf(ServiceError);
    expect(await s.db.select().from(payRuns).where(eq(payRuns.companyId, s.companyId))).toHaveLength(1);
    expect(await s.db.select().from(paychecks).where(eq(paychecks.companyId, s.companyId))).toHaveLength(2);

    // The agent asks again with its request id and reads what happened.
    const again = await agent.run({ operation: PAY_RUN(), body: payRunBody(), requestId: key, reason: 'Payroll for the first half of November.' });
    expect(again.replayed).toBe(true);
    expect(again.outcome).toBe('posted');
    expect(again.status).toBe('executed');
  });

  it('the agent reads its request back (and every preview of it) masked', async () => {
    const view = await agent.verb('list_my_requests', {});
    const mine = view.requests.find((r) => r.id === requestId);
    expect(mine, 'the pay run request').toBeTruthy();
    for (const v of PROTECTED) expect(holds(JSON.stringify(mine), v)).toBe(false);
  });

  it('nothing the agent was answered along the way holds a full SSN or bank account number', () => {
    expect(agent.seen.length).toBeGreaterThanOrEqual(8);
    const text = seenText(agent);
    for (const v of PROTECTED) expect(holds(text, v), `the agent was shown ${v}`).toBe(false);
  });
});

describe('Phase 3 exit: one approved reveal of the SSNs', { timeout: 240_000 }, () => {
  let revealKey: string;
  let revealId: string;

  it('asking for the full values asks a person who holds "View sensitive payroll data"', async () => {
    revealKey = requestKey('reveal');
    const asked = await agent.run({ operation: EMPLOYEES(), reveal: true, requestId: revealKey, reason: 'The W-4 review needs the full SSNs to match the forms.' });
    expect(asked.outcome).toBe('asked');
    revealId = asked.requestId!;
    const flags = asked.needs?.flags ?? (asked.needs?.flag ? [asked.needs.flag] : []);
    expect(flags).toContain('sensitivePayroll');
    expect(asked.note).toMatch(/View sensitive payroll data/);
    // Nothing was shown yet.
    expect(asked.result).toBeUndefined();
    for (const v of PROTECTED) expect(holds(JSON.stringify(asked), v)).toBe(false);
  });

  it('an approver without the View flag cannot approve it, and nothing runs', async () => {
    const card = await requestForPerson(bo.ctx, revealId, { atHost: true });
    expect(card.canApprove).toBe(false);
    expect(card.cannotApproveWhy).toMatch(/View sensitive payroll data/);
    await expectRefused(approveAgentRequest(bo.ctx, revealId, {}, { atHost: true }), 'FORBIDDEN', /View sensitive payroll data/);
    const row = await requestRow(revealId);
    expect(row.status).toBe('pending');
    expect(row.decidedBy).toBeNull();
  });

  it('one with the flag approves it: the agent reads the full SSNs in that one answer', async () => {
    const done = await approveAgentRequest(pat.ctx, revealId, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    // The approver sees what they approved (their own role shows SSNs in full).
    expect(JSON.stringify(done.request.result)).toContain(SSN_DANA);

    const again = (await agent.run({
      operation: EMPLOYEES(),
      reveal: true,
      requestId: revealKey,
      reason: 'The W-4 review needs the full SSNs to match the forms.',
    })) as AgentOperationAnswer;
    expect(again.outcome).toBe('read');
    expect(again.replayed).toBe(true);
    const shown = JSON.stringify(again.result);
    expect(shown).toContain(SSN_DANA);
    expect(shown).toContain(SSN_LEE);
    // A reveal of SSNs shows SSNs only: the bank number was never part of it.
    expect(holds(shown, BANK_NUMBER)).toBe(false);
  });

  it('the decision is in the audit trail: who approved, for which agent, under which request', async () => {
    const rows = await s.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent_permission_request'), eq(auditLogs.entityId, revealId)));
    const executed = rows.find((r) => (r.newValues as Out | null)?.status === 'executed');
    expect(executed, JSON.stringify(rows)).toBeTruthy();
    expect(executed!.userId).toBe(pat.id);
    expect((executed!.newValues as Out).approvedBy).toBe(pat.id);
    expect((executed!.newValues as Out).agentId).toBe(agent.id);
    expect((executed!.newValues as Out).operation).toBe(EMPLOYEES());
  });

  // Plan §5.9 (D6): the audit trail words the reveal: "Revealed <which kinds of fields> of <record or
  // report> to agent <name>, approved by <person>" (lib/services/agentRequests.ts revealAudit, put
  // on the decision's row), and never the values themselves.
  it('the audit trail words it as a reveal: what was revealed (SSNs), to which agent, approved by whom', async () => {
    const rows = await s.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'agent_permission_request'), eq(auditLogs.entityId, revealId)));
    const executed = rows.find((r) => (r.newValues as Out | null)?.status === 'executed');
    const said = String((executed?.newValues as Out | undefined)?.revealed ?? '');
    expect(said, JSON.stringify(rows)).toMatch(/^Revealed full SSNs/);
    expect(said).toContain('to agent "Payroll Agent"');
    expect(said).toContain('approved by Pat Payroll');
    expect(String((executed!.newValues as Out).revealedFields)).toMatch(/SSNs/);
    // What was revealed is named, never shown.
    const text = JSON.stringify(rows);
    for (const v of PROTECTED) expect(holds(text, v), `the audit trail holds ${v}`).toBe(false);
  });

  it('the reveal was for that one call: the next read is masked, and another reveal asks again', async () => {
    const plain = await agent.run({ operation: EMPLOYEES() });
    expect(plain.outcome).toBe('read');
    for (const v of PROTECTED) expect(holds(JSON.stringify(plain), v)).toBe(false);

    const second = await agent.run({ operation: EMPLOYEES(), reveal: true, requestId: requestKey('reveal-2'), reason: 'One more look at the SSNs.' });
    expect(second.outcome).toBe('asked');
    expect(second.status).toBe('pending');
    expect(second.result).toBeUndefined();
  });

  it('the full SSNs reached the agent only in the answer of the one approved reveal', () => {
    const text = seenExcept([revealKey]);
    for (const v of PROTECTED) expect(holds(text, v), `the agent was shown ${v} outside the approved reveal`).toBe(false);
    // And never a bank account number, anywhere.
    expect(holds(seenText(agent), BANK_NUMBER)).toBe(false);
  });

  // Decided (D6, plan §5.9): after an approved reveal the unmasked answer stays readable by that
  // agent (wait_for_decision, list_my_requests, a replay of the same request id) for
  // REVEAL_KEPT_MINUTES after the run; after that it is masked for good, in every view and in the
  // stored row (lib/services/agentRequests.ts storedResult/revealOver for the views, settleRow and
  // endedReveal for the row). The clock (Date only) proves both halves: a minute before the end and
  // a minute after it.
  async function revealSeen(): Promise<{ list: string; replay: AgentOperationAnswer }> {
    const mine = await agent.verb('list_my_requests', {});
    const view = mine.requests.find((r) => r.id === revealId);
    expect(view?.status).toBe('executed');
    const replay = await agent.run({ operation: EMPLOYEES(), reveal: true, requestId: revealKey, reason: 'The W-4 review needs the full SSNs to match the forms.' });
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toBe('read');
    return { list: JSON.stringify(view), replay };
  }

  it(`for ${REVEAL_KEPT_MINUTES} minutes after the run the agent may read the revealed answer again: its list and a replay`, async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + (REVEAL_KEPT_MINUTES - 1) * 60_000);
      const { list, replay } = await revealSeen();
      for (const v of [SSN_DANA, SSN_LEE]) {
        expect(holds(list, v), `list_my_requests hid ${v}`).toBe(true);
        expect(holds(JSON.stringify(replay.result), v), `the replay hid ${v}`).toBe(true);
      }
      // Still only the SSNs: the bank number was never part of it.
      expect(holds(list, BANK_NUMBER)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it(`after the ${REVEAL_KEPT_MINUTES} minutes it is masked for good: in the list, in a replay and in the stored rows`, async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + (REVEAL_KEPT_MINUTES + 1) * 60_000);
      const { list, replay } = await revealSeen();
      for (const v of PROTECTED) {
        expect(holds(list, v), `list_my_requests showed ${v}`).toBe(false);
        expect(holds(JSON.stringify(replay), v), `the replay showed ${v}`).toBe(false);
      }
      // The answer is still there, masked: the people are listed, with their last four digits.
      const people = replay.result as Out[];
      expect(people.map((x) => x.firstName).sort()).toEqual(['Dana', 'Lee']);

      // The reads settled the row: masked for good, not only in the views.
      const perm = JSON.stringify(await s.db.select().from(agentPermissionRequests));
      const claims = JSON.stringify(await s.db.select().from(agentRequests));
      expect({
        agent_permission_requests: holds(perm, SSN_DANA) || holds(perm, SSN_LEE),
        agent_requests: holds(claims, SSN_DANA) || holds(claims, SSN_LEE),
      }).toEqual({ agent_permission_requests: false, agent_requests: false });
      const row = await requestRow(revealId);
      expect((row.result as Out).revealUntil).toBeUndefined();
      expect((row.result as Out).revealEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
