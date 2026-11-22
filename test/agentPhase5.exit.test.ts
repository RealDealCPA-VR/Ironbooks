/**
 * Plan Phase 5 exit (settings, closing date and period work, plan §5.8, §4.5, §4.2 "period"), end
 * to end in process: a real PGlite company, the agent's own request context (lib/agentContext.ts),
 * the door (lib/agent/operate.ts handleVerb), the approval service (lib/services/agentRequests.ts),
 * the route bridge and the app's own route handlers. Nothing is replaced but next/headers (there is
 * no HTTP request in a test).
 *
 *  - The Admin closes October (Month-End Close, with a closing-date password). An Accountant-role
 *    agent then asks to move the closing date back to 03-31. It cannot supply the password itself.
 *  - The Admin approves with the closing-date password typed on the card (ApproveInput.secrets).
 *    A wrong password changes nothing and counts toward the closing-date password's guess limit;
 *    the right one moves the date, and the audit trail shows the agent and the Admin.
 *  - Neither password is in any stored row (agent_permission_requests, agent_requests, audit_logs,
 *    agent_grants, scanned as JSON text) nor in anything the agent was answered.
 *  - A host-only setting (the Privacy & Network policy) cannot be approved from a teammate's
 *    window (atHost false), only at the host computer.
 *
 * Where the build does not do what the plan says, the test stays as it.fails with what is wrong.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-phase5-exit`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-phase5-exit-secret';
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
import { agentPermissionRequests, auditLogs } from '@/lib/db/schema';
import { operationForRoute } from '@/lib/agent/operations/registry';
import type { AgentOperationAnswer } from '@/lib/agent/contract';
import { getClosingDateSettings } from '@/lib/services/company';
import { closeMonth, getMonthEndChecklist, updateMonthEndStep } from '@/lib/services/monthEndClose';
import { getNetworkPolicy } from '@/lib/services/networkPolicy';
import { approveAgentRequest, listRequestsForPerson, requestForPerson } from '@/lib/services/agentRequests';
import { ServiceError } from '@/lib/services/_base';
import {
  answeredText,
  closeScenario,
  closingGuesses,
  freshLimits,
  holds,
  makeAgent,
  openScenario,
  requestKey,
  seenText,
  storedText,
  type ClosingGuesses,
  type Scenario,
  type ScenarioAgent,
} from './helpers/agentScenarioB';

type Out = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DATA_DIR = path.resolve(process.env.BKA_DATA_DIR!);

/** Distinctive passwords: a scan cannot find them by chance. */
const CLOSING_PASSWORD = 'Oct-Close-7781-Quill';
const WRONG_PASSWORD = 'Not-The-One-5523-Fern';
const AGENT_GUESS = 'Agent-Guess-4410-Moss';

let s: Scenario;
let agent: ScenarioAgent;
/** The month that was closed: the last day of last month (Month-End Close only closes a period that is over). */
let periodEnd: string;
/** Where the agent asks to move the closing date: 03-31, before the period end. */
let target: string;

function idOf(method: string, route: string): string {
  const op = operationForRoute(method, route);
  if (!op) throw new Error(`No operation for ${method} ${route}`);
  return op.id;
}
const CLOSING_DATE = () => idOf('PATCH', '/api/company/closing-date');
const NETWORK_POLICY = () => idOf('PUT', '/api/network-policy');

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function requestRow(id: string) {
  const [row] = await s.db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.id, id));
  return row;
}

async function closingDate(): Promise<string | null> {
  return (await getClosingDateSettings(s.seed)).closingDate;
}

/** The Month-End Close as a person does it: every open step reviewed, then Close the Month with a password. */
async function closeTheMonth(end: string, password: string): Promise<void> {
  const list = await getMonthEndChecklist(s.admin.ctx, end);
  for (const step of list.steps) {
    if (step.resolved) continue;
    await updateMonthEndStep(s.admin.ctx, { periodEnd: end, stepKey: step.key, action: 'review', note: 'Checked by the Admin.' });
  }
  await closeMonth(s.admin.ctx, { periodEnd: end, password });
}

/** The agent asks to move the closing date to `day` (a person must approve). */
async function askToMove(day: string, label: string, extra: Record<string, unknown> = {}): Promise<AgentOperationAnswer> {
  return agent.run({
    operation: CLOSING_DATE(),
    body: { closingDate: day, ...extra },
    requestId: requestKey(label),
    reason: `Reopen the books back to ${day} to correct a misposted March deposit.`,
  });
}

beforeAll(async () => {
  s = await openScenario(DATA_DIR, 'Phase Five Closing Co');
  const now = new Date();
  periodEnd = isoDay(new Date(now.getFullYear(), now.getMonth(), 0));
  const year = Number(periodEnd.slice(0, 4));
  target = `${year}-03-31` < periodEnd ? `${year}-03-31` : `${year - 1}-03-31`;

  await closeTheMonth(periodEnd, CLOSING_PASSWORD);

  // Accountant: closing-date rights and the closed-period flag, but not an Admin, so moving the
  // date back needs the closing-date password (lib/services/company.ts setClosingDate).
  agent = await makeAgent(s, { name: 'Close Agent', roleKeys: ['accountant'], preset: 'ask_every_change' });
  freshLimits();
}, 240_000);

afterAll(async () => {
  await closeScenario(s);
});

describe('Phase 5 exit: an agent asks to move the closing date after a month-end close', { timeout: 240_000 }, () => {
  let wrongId: string;
  let rightId: string;
  /** The guesses held against the Admin just before the right password was typed. */
  let heldBeforeRight: ClosingGuesses;

  it('the month is closed with a password, and the agent sees that moving the date is period work a person approves', async () => {
    const settings = await getClosingDateSettings(s.seed);
    expect(settings.closingDate).toBe(periodEnd);
    expect(settings.hasPassword).toBe(true);

    const perms = await agent.verb('get_my_permissions', {});
    expect(perms.classes.period).toBe('ask');
    const desc = await agent.verb('describe_operation', { operation: CLOSING_DATE() });
    expect(desc.class).toBe('period');
    expect(desc.treatment).toBe('ask');
    expect(desc.needsSecret).toEqual(['closing_password']);
  });

  it('the agent cannot type the password itself: what it sent is taken out and never tried', async () => {
    const before = closingGuesses(s.companyId, s.admin.id);
    const asked = await askToMove(target, 'move-with-own-guess', { currentPassword: AGENT_GUESS });
    expect(asked.outcome).toBe('asked');
    const row = await requestRow(asked.requestId!);
    expect(JSON.stringify(row.input)).not.toContain(AGENT_GUESS);
    expect(holds(await storedText(s.db), AGENT_GUESS)).toBe(false);
    expect(closingGuesses(s.companyId, s.admin.id)).toEqual(before);
    expect(await closingDate()).toBe(periodEnd);
    // Not wanted: the agent withdraws it.
    await agent.verb('cancel_request', { requestId: asked.requestId! });
  });

  it('asking puts a request to a person that needs the closing-date password, with nothing tried ahead', async () => {
    const asked = await askToMove(target, 'move-wrong');
    expect(asked.outcome).toBe('asked');
    expect(asked.status).toBe('pending');
    wrongId = asked.requestId!;
    expect(asked.needs?.secrets).toContain('closing_password');
    expect(asked.summary).toContain(target);
    expect(await closingDate()).toBe(periodEnd);

    const card = await requestForPerson(s.admin.ctx, wrongId, { atHost: true });
    expect(card.canApprove).toBe(true);
    expect(card.class).toBe('period');
    expect(card.needs?.secrets).toEqual(['closing_password']);
  });

  it('a wrong password changes nothing and counts toward the guess limit', async () => {
    const before = closingGuesses(s.companyId, s.admin.id).wrong;
    const done = await approveAgentRequest(s.admin.ctx, wrongId, { secrets: { closing_password: WRONG_PASSWORD } }, { atHost: true });
    expect(done.status).toBe('failed');
    expect(done.request.error ?? '').toMatch(/password/i);
    expect(done.request.error ?? '').not.toContain(WRONG_PASSWORD);
    expect(done.produced).toEqual([]);

    expect(await closingDate()).toBe(periodEnd);
    expect((await getClosingDateSettings(s.seed)).hasPassword).toBe(true);
    const after = closingGuesses(s.companyId, s.admin.id).wrong;
    expect(after).toBeGreaterThan(before);

    // No change to the company was recorded under this request.
    const rows = await s.db.select().from(auditLogs).where(and(eq(auditLogs.agentRequestId, wrongId), eq(auditLogs.entityType, 'company')));
    expect(rows).toHaveLength(0);
  });

  // The bridge checks the typed password for its closing-date override (lib/agent/bridge.ts
  // closingOverride, outside the scope: the approving person's own 'local' keys), and the route
  // checks it again as body.currentPassword inside the agent's service scope, whose origin is
  // "this computer, outside Ironbooks" (lib/net/requestInfo.ts), so with that realm's keys. Each
  // realm counts it once: one wrong password on the card brings the Admin's lockout one guess
  // nearer, not two. (Seen in the limiter: after two wrong cards, two failures on
  // "closing-password:acct:local:<company>:<admin>" and two on the agent realm's "acct-at" key.)
  it('a wrong password on the card counts as one guess', async () => {
    const asked = await askToMove(target, 'move-wrong-once');
    const before = closingGuesses(s.companyId, s.admin.id);
    expect(before.wrong).toBeGreaterThan(0);
    await approveAgentRequest(s.admin.ctx, asked.requestId!, { secrets: { closing_password: WRONG_PASSWORD } }, { atHost: true });
    const after = closingGuesses(s.companyId, s.admin.id);
    expect(after.wrong - before.wrong).toBe(1);
    expect(after.app - before.app).toBe(1);
    // At most once in the agent realm too (none at all if the route ever stops checking it again).
    expect(after.agentScope - before.agentScope).toBeLessThanOrEqual(1);
    expect(after.locked).toBe(false);
  });

  // A yes without a password the operation's route always needs is sent back to the card before
  // anything is claimed (lib/services/agentRequests.ts checkTypedSecrets): the person types it and
  // approves again, and the agent does not have to ask all over.
  it('a yes without the password is sent back to the card: nothing is tried, and the request still waits', async () => {
    const asked = await askToMove(target, 'move-no-password');
    const before = closingGuesses(s.companyId, s.admin.id);
    let refused: unknown = null;
    try {
      await approveAgentRequest(s.admin.ctx, asked.requestId!, {}, { atHost: true });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe('VALIDATION');
    expect((refused as ServiceError).message).toMatch(/closing-date password/);
    expect((refused as ServiceError).message).toMatch(/approve again/);

    const row = await requestRow(asked.requestId!);
    expect(row.status).toBe('pending');
    expect(row.decidedBy).toBeNull();
    expect(await closingDate()).toBe(periodEnd);
    // Nothing was typed, so nothing was guessed.
    expect(closingGuesses(s.companyId, s.admin.id)).toEqual(before);
    // It is withdrawn here so the next test asks afresh.
    await agent.verb('cancel_request', { requestId: asked.requestId! });
  });

  it('the Admin approves with the right password: the date moves, and the audit trail shows the agent and the Admin', async () => {
    const asked = await askToMove(target, 'move-right');
    expect(asked.outcome).toBe('asked');
    rightId = asked.requestId!;
    heldBeforeRight = closingGuesses(s.companyId, s.admin.id);
    const done = await approveAgentRequest(s.admin.ctx, rightId, { secrets: { closing_password: CLOSING_PASSWORD } }, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    expect(done.produced).toEqual([]);
    expect(await closingDate()).toBe(target);
    // The password stays: only the date moved.
    expect((await getClosingDateSettings(s.seed)).hasPassword).toBe(true);

    const rows = await s.db.select().from(auditLogs).where(and(eq(auditLogs.agentRequestId, rightId), eq(auditLogs.entityType, 'company')));
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe(agent.id);
    expect(rows[0].approvedBy).toBe(s.admin.id);
    expect(rows[0].oldValues).toMatchObject({ closingDate: periodEnd });
    expect(rows[0].newValues).toMatchObject({ closingDate: target, hasPassword: true });

    const decision = (await s.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'agent_permission_request'), eq(auditLogs.entityId, rightId)))).find(
      (r) => (r.newValues as Out | null)?.status === 'executed',
    );
    expect(decision?.userId).toBe(s.admin.id);
    expect((decision?.newValues as Out).agentId).toBe(agent.id);

    // The agent reads what happened with its request id.
    const mine = await agent.verb('list_my_requests', {});
    const view = mine.requests.find((r) => r.id === rightId);
    expect(view?.status).toBe('executed');
    expect(view?.decidedByName).toBe(s.admin.name);
  });

  // limitClosingPasswordGuess calls recordSuccess on the person's own keys (lib/closingPasswordLimiter.ts):
  // the wrong guesses held before the right password (in both realms) are gone after it.
  it('a right password clears the wrong guesses held against the Admin', () => {
    expect(heldBeforeRight.app).toBeGreaterThan(0);
    const now = closingGuesses(s.companyId, s.admin.id);
    expect(now).toEqual({ app: 0, agentScope: 0, wrong: 0, locked: false });
  });

  it('neither password is in any stored row, nor in anything the agent was answered', async () => {
    const stored = await storedText(s.db);
    for (const secret of [CLOSING_PASSWORD, WRONG_PASSWORD, AGENT_GUESS]) {
      expect(holds(stored, secret), `stored: ${secret}`).toBe(false);
      expect(holds(answeredText(agent), secret), `answered: ${secret}`).toBe(false);
    }
    // The person's passwords were never even sent by the agent: they reached it in no form.
    for (const secret of [CLOSING_PASSWORD, WRONG_PASSWORD]) expect(holds(seenText(agent), secret)).toBe(false);
    // And the stored hash is never handed out either.
    const settings = await getClosingDateSettings(s.seed);
    expect(JSON.stringify(settings)).not.toMatch(/\$2[aby]\$/);
    expect(stored).not.toMatch(/\$2[aby]\$\d\d\$/);
  });
});

describe('Phase 5 exit: a host-only setting is approved only at the host computer', { timeout: 240_000 }, () => {
  let settingsAgent: ScenarioAgent;
  let askId: string;
  const body = { mode: 'offline', cloudOptIn: { ai: false, email: false, 'vendor-lookup': false, updates: false }, vendorLookupUrl: null };

  beforeAll(async () => {
    settingsAgent = await makeAgent(s, { name: 'Settings Agent', roleKeys: ['admin'], preset: 'ask_every_change' });
  });

  it('the agent asks to change the Privacy & Network policy: an Admin approves it, at the host', async () => {
    const asked = await settingsAgent.run({ operation: NETWORK_POLICY(), body, requestId: requestKey('network'), reason: 'Keep this computer offline over the holidays.' });
    expect(asked.outcome).toBe('asked');
    askId = asked.requestId!;
    expect(asked.needs?.hostOnly).toBe(true);
    expect(asked.note).toMatch(/computer that holds the company file/);
  });

  it("from a teammate's window (atHost false) it cannot be approved, and nothing changes", async () => {
    const before = await getNetworkPolicy(s.seed);
    const card = await requestForPerson(s.admin.ctx, askId, { atHost: false });
    expect(card.canApprove).toBe(false);
    expect(card.cannotApproveWhy).toMatch(/computer that holds the company file/);
    const listed = (await listRequestsForPerson(s.admin.ctx, { atHost: false })).find((r) => r.id === askId);
    expect(listed?.canApprove).toBe(false);

    await expect(approveAgentRequest(s.admin.ctx, askId, {}, { atHost: false })).rejects.toBeInstanceOf(ServiceError);
    const row = await requestRow(askId);
    expect(row.status).toBe('pending');
    expect(row.decidedBy).toBeNull();
    expect(await getNetworkPolicy(s.seed)).toEqual(before);
  });

  it('at the host computer the same Admin approves it, and it is done', async () => {
    const card = await requestForPerson(s.admin.ctx, askId, { atHost: true });
    expect(card.canApprove).toBe(true);
    const done = await approveAgentRequest(s.admin.ctx, askId, {}, { atHost: true });
    expect(done.status, JSON.stringify(done.request.error)).toBe('executed');
    expect((await getNetworkPolicy(s.seed)).mode).toBe('offline');
  });
});

describe('Phase 5 exit: the guess limit holds for approvals too', { timeout: 240_000 }, () => {
  it('after too many wrong passwords even the right one is refused for a while, and nothing changes', async () => {
    const back = `${Number(target.slice(0, 4)) - 1}-12-31`;
    for (let i = 0; i < 8 && !closingGuesses(s.companyId, s.admin.id).locked; i++) {
      const asked = await askToMove(back, `lock-${i}`);
      await approveAgentRequest(s.admin.ctx, asked.requestId!, { secrets: { closing_password: WRONG_PASSWORD } }, { atHost: true });
    }
    expect(closingGuesses(s.companyId, s.admin.id).locked).toBe(true);

    const asked = await askToMove(back, 'locked-right');
    const done = await approveAgentRequest(s.admin.ctx, asked.requestId!, { secrets: { closing_password: CLOSING_PASSWORD } }, { atHost: true });
    expect(done.status).toBe('failed');
    expect(done.request.error ?? '').toMatch(/Too many wrong closing-date passwords/);
    expect(await closingDate()).toBe(target);
    // The answers given on the way to the lockout, and while locked, go through the refusal for too
    // many wrong passwords, not the path the scan above saw: neither password is kept there either.
    const stored = await storedText(s.db);
    for (const secret of [CLOSING_PASSWORD, WRONG_PASSWORD]) {
      expect(holds(stored, secret), `stored: ${secret}`).toBe(false);
      expect(holds(answeredText(agent), secret), `answered: ${secret}`).toBe(false);
      expect(holds(done.request.error ?? '', secret)).toBe(false);
    }
  });
});
