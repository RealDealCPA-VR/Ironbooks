/**
 * Plan Phase 3 exit (payroll and sensitive data, plan §5.9, §4.5, D6), end to end in process: a
 * real PGlite company, the agent's own request context (lib/agentContext.ts), the door
 * (lib/agent/operate.ts handleVerb), the approval service (lib/services/agentRequests.ts), the route
 * bridge and the app's own route handlers. Nothing is replaced but next/headers (there is no HTTP
 * request in a test).
 *
 *  - An agent finds, reads, tries and asks for a pay run with only the generic verbs; a person
 *    approves it in their own window and the paychecks are in the books, named "agent, approved by
 *    person".
 *  - Every answer the agent got on the way is masked: no full SSN and no full bank account number,
 *    although the agent's role (Full Access) holds both View flags.
 *  - One approved reveal: an approver without "View sensitive payroll data" cannot approve it, one
 *    with it can; the agent then reads the full SSNs in that one answer, the next ordinary read is
 *    masked again and another reveal asks again. The decision is in the audit trail.
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
import { approveAgentRequest, requestForPerson } from '@/lib/services/agentRequests';
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

  // DEFECT (lib/agent/bridge.ts stalenessKeyOf, with lib/services/payroll.ts): the staleness key of
  // a pay run differs on EVERY run over the same books, so the approval always answers "the books
  // changed" (status 'stale') and nothing runs. Each paycheck's journal entry carries
  // reference = the first 8 hex digits of the new paycheck's id (seen: "2fcf3b08" in one rolled-back
  // run, "e923e58c" in the next, all else equal). stalenessKeyOf puts `reference` in the key and
  // keyValue only maps WHOLE uuids of created records to "new:<kind>", so a prefix of one stays as
  // it is. Two dry runs by the same actor gave keys 1aa8f167… and 6b5cab49….
  it.fails('a person approves it once in their own window and it runs (the books did not change)', async () => {
    const card = await requestForPerson(s.admin.ctx, requestId, { atHost: true });
    expect(card.canApprove).toBe(true);
    const done = await approveAgentRequest(s.admin.ctx, requestId, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
  });

  // The same defect, seen through the second yes the plan gives (§7.4): the person is shown the new
  // preview and approves again with acceptStale, but every new dry run has a new key again, so the
  // request goes back to waiting each time and a pay run can never be approved at all.
  it.fails('approving the new preview again runs it: the paychecks are in the books, named "agent, approved by person"', async () => {
    let done = await approveAgentRequest(s.admin.ctx, requestId, { acceptStale: true }, { atHost: true });
    for (let i = 0; i < 3 && done.status === 'stale'; i++) {
      expect(done.request.stale).toBe(true);
      done = await approveAgentRequest(s.admin.ctx, requestId, { acceptStale: true }, { atHost: true });
    }
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    expect(done.request.posted).toBe(true);
    expect(done.request.entryIds?.length ?? 0).toBeGreaterThanOrEqual(2);

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

    // The agent asks again with its request id and reads what happened.
    const again = await agent.run({ operation: PAY_RUN(), body: payRunBody(), requestId: key, reason: 'Payroll for the first half of November.' });
    expect(again.replayed).toBe(true);
    expect(again.outcome).toBe('posted');
    expect(again.status).toBe('executed');
  });

  it('while it waits, the agent reads it back (and every new preview of it) masked', async () => {
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

  // PLAN DEVIATION (plan §5.9: "the audit trail records 'revealed fields of record to agent X,
  // approved by Y'"). lib/services/agentRequests.ts auditDecision writes only
  // { operation, agentId, status, approvedBy, grantId } for the decision, and the approved read runs
  // on the read-only handle (lib/agent/bridge.ts 'read' mode), which writes no audit row. Nothing in
  // the audit trail says that protected values were revealed, which kind (SSNs) or of which records.
  it.fails('the audit trail words it as a reveal: what was revealed (SSNs), to which agent, approved by whom', async () => {
    const rows = await s.db.select().from(auditLogs).where(eq(auditLogs.companyId, s.companyId));
    const about = rows.filter((r) => r.entityId === revealId || r.agentRequestId === revealId);
    const text = JSON.stringify(about);
    expect(text).toMatch(/reveal/i);
    expect(text).toMatch(/ssn/i);
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

  // DEFECT (lib/services/agentRequests.ts record(), with the agent's views listRequestsForAgent and
  // the door's replay, lib/agent/operate.ts presentState): the answer of an approved reveal is
  // stored UNMASKED in agent_permission_requests.result (record() keeps scrubDeep(stripSecrets(
  // r.result)), which takes out secrets, not protected values) and handed back on every read of
  // the request: list_my_requests, every replay with the same request id, wait_for_decision. So
  // "that single call runs unmasked" (plan §5.9) becomes "the agent can read the full SSNs again
  // whenever it likes, for as long as the request is kept", and the full SSNs sit in a second table
  // outside the employee records. Seen: list_my_requests and a second replay both answer
  // "521-73-9846"; the stored row holds it too. The next three tests show each.
  //
  // A DECISION FOR THE OWNER, not only a bug: this reverses an earlier reading of D6. The second
  // wave's review of the requests unit (_vr_tmp/WAVE2-NOTES.md, "requests" summary) says "The
  // agent's own view keeps the revealed answer, as D6 intends", and the module header of
  // lib/services/agentRequests.ts ("What an approved run answered is stored as the agent reads it,
  // so an approved reveal (D6) keeps the full values for the agent") says the same. These tests
  // follow the plan's wording instead (§5.9 "that single call runs unmasked"; the Phase 3 exit "one
  // approved reveal shows them once"). Either (a) the agent keeps the revealed answer: these three
  // become plain tests of the opposite and the exit wording changes; or (b) it is shown once, in the
  // answer that carries it, and then masked in list_my_requests, every replay and the stored row.
  it.fails("the agent's list of its requests shows the approved reveal masked", async () => {
    const mine = await agent.verb('list_my_requests', {});
    const view = mine.requests.find((r) => r.id === revealId);
    expect(view?.status).toBe('executed');
    for (const v of PROTECTED) expect(holds(JSON.stringify(view), v), `list_my_requests showed ${v}`).toBe(false);
  });

  it.fails('asking again with the same request id does not show the SSNs a second time', async () => {
    const again = await agent.run({ operation: EMPLOYEES(), reveal: true, requestId: revealKey, reason: 'The W-4 review needs the full SSNs to match the forms.' });
    expect(again.replayed).toBe(true);
    for (const v of [SSN_DANA, SSN_LEE]) expect(holds(JSON.stringify(again), v), `the replay showed ${v} again`).toBe(false);
  });

  it.fails('the full SSNs are not kept in the request rows once they were shown', async () => {
    const perm = JSON.stringify(await s.db.select().from(agentPermissionRequests));
    const claims = JSON.stringify(await s.db.select().from(agentRequests));
    expect({ agent_permission_requests: holds(perm, SSN_DANA) || holds(perm, SSN_LEE), agent_requests: holds(claims, SSN_DANA) || holds(claims, SSN_LEE) }).toEqual({
      agent_permission_requests: false,
      agent_requests: false,
    });
  });
});
