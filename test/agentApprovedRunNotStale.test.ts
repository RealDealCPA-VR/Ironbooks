// An approved request whose run makes a record that names who made it (a collection note's
// createdBy) is not stale: the agent's trial run when it asked had no person, the run at approval is
// the approver's, and who carries the work out is not a change in the books (bridge.ts ACTOR_KEYS).
// Found by the packaged e2e (scripts/e2e-agent.mjs P4).
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-approved-run-not-stale`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-approved-run-not-stale';
  process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = `${root}/endpoints`;
  process.env.BKA_AGENT_FILES_DIR = `${root}/agent-files`;
  delete process.env.BKA_DEVICE_VAULT;
  delete process.env.BKA_LAUNCH_PASS;
  delete process.env.BKA_COMPANY_STATE;
  delete process.env.BKA_AGENT_SHELL;
  delete process.env.BKA_AGENT_SHELL_KEY;
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
  headers: async () => new Headers(),
}));

import path from 'node:path';
import { operationForRoute } from '@/lib/agent/operations/registry';
import { createCustomer } from '@/lib/services/customers';
import { createInvoice } from '@/lib/services/invoices';
import { approveAgentRequest } from '@/lib/services/agentRequests';
import { closeScenario, fakeMail, freshLimits, makeAgent, openScenario, requestKey, type FakeMail, type Scenario, type ScenarioAgent } from './helpers/agentScenarioB';

let s: Scenario;
let agent: ScenarioAgent;
let mail: FakeMail;
let customerId: string;

const day = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeAll(async () => {
  s = await openScenario(path.resolve(process.env.BKA_DATA_DIR!), 'Stale Reminder Co');
  customerId = (await createCustomer(s.seed, { displayName: 'E2E Acme Corp', email: 'billing@acme.example' })).id;
  await createInvoice(s.seed, { customerId, date: day(-45), dueDate: day(-15), lines: [{ description: 'E2E consulting', quantity: '1', rate: '450.00' }] } as never);
  agent = await makeAgent(s, { name: 'Night bookkeeper', roleKeys: ['full_access'], preset: 'trusted_bookkeeper' });
  mail = fakeMail();
  freshLimits();
}, 240_000);

afterAll(async () => {
  mail?.restore();
  await closeScenario(s);
});

it('an approved collections reminder runs (the books did not change)', async () => {
  const op = operationForRoute('POST', '/api/collections/email') ?? null;
  const id = op?.id ?? 'collections.email';
  const asked = await agent.run({ operation: id, body: { customerId, what: 'invoices' }, requestId: requestKey('reminder'), reason: 'Reminder.' });
  expect(asked.outcome).toBe('asked');
  await new Promise((r) => setTimeout(r, 3000));
  const res = await approveAgentRequest(s.admin.ctx, asked.requestId!, {}, { atHost: true });
  expect(res.status, JSON.stringify(res).slice(0, 2000)).toBe('executed');
}, 120_000);
