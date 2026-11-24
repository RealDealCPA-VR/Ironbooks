// The approval card names the records a request names by id (the bill's vendor, the payment's
// customer, the accounts of its lines) by their names in the books, on a line of their own. Found by
// a live trial with a real Claude session (the card read "Enter a bill from vendor 22779a77-…" and
// nothing else). The one-line summary itself stays free of record names: it is also the desktop
// notice, and a name can be an outsider's text (test/agentInjection.test.ts).
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const root = `${process.cwd()}/.bookkeeper-data/test-agent-request-names`;
  process.env.BKA_DATA_DIR = `${root}/data`;
  process.env.BKA_AUTH_SECRET = 'agent-request-names';
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
import { and, eq } from 'drizzle-orm';
import { accounts } from '@/lib/db/schema';
import { operationForRoute } from '@/lib/agent/operations/registry';
import { createCustomer } from '@/lib/services/customers';
import { createVendor } from '@/lib/services/vendors';
import { createInvoice } from '@/lib/services/invoices';
import { requestForPerson } from '@/lib/services/agentRequests';
import { closeScenario, freshLimits, makeAgent, openScenario, requestKey, type Scenario, type ScenarioAgent } from './helpers/agentScenarioB';

let s: Scenario;
let agent: ScenarioAgent;
let vendorId: string;
let customerId: string;
let suppliesId: string;
let checkingId: string;
let invoiceId: string;

const today = () => new Date().toISOString().slice(0, 10);
const opId = (method: string, route: string) => {
  const op = operationForRoute(method, route);
  if (!op) throw new Error(`no operation for ${method} ${route}`);
  return op.id;
};
async function accountId(code: string): Promise<string> {
  const [row] = await s.db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, s.companyId), eq(accounts.code, code)));
  if (!row) throw new Error(`no account ${code}`);
  return row.id;
}

beforeAll(async () => {
  s = await openScenario(path.resolve(process.env.BKA_DATA_DIR!), 'Request Names Co');
  vendorId = (await createVendor(s.seed, { displayName: 'Staples' } as never)).id;
  customerId = (await createCustomer(s.seed, { displayName: 'Acme Property Management' } as never)).id;
  invoiceId = (await createInvoice(s.seed, { customerId, date: new Date(), lines: [{ description: 'Repair', quantity: '1', rate: '1850.00' }] } as never)).id;
  suppliesId = await accountId('6300');
  checkingId = await accountId('1000');
  agent = await makeAgent(s, { name: 'Names Agent', roleKeys: ['bookkeeper'], preset: 'ask_every_change' });
  freshLimits();
}, 240_000);

afterAll(async () => {
  await closeScenario(s);
});

it("a bill's card names its vendor and account, and its summary stays free of record names", async () => {
  const asked = await agent.run({
    operation: opId('POST', '/api/bills'),
    body: { vendorId, billNumber: '88412', date: today(), lines: [{ accountId: suppliesId, amount: '212.40', description: 'Office supplies' }] },
    requestId: requestKey('bill-names'),
    reason: 'Enter the Staples bill.',
  });
  expect(asked.outcome).toBe('asked');
  const card = await requestForPerson(s.admin.ctx, asked.requestId!);
  expect(card?.named).toEqual(expect.arrayContaining([{ kind: 'vendors', name: 'Staples' }, { kind: 'accounts', name: expect.stringMatching(/^6300 /) }]));
  expect(card?.summary).not.toMatch(/Staples/);
}, 120_000);

it("a payment's card names its customer and bank account", async () => {
  const asked = await agent.run({
    operation: opId('POST', '/api/payments'),
    body: { customerId, date: today(), amount: '1000.00', method: 'check', reference: '4521', depositToAccountId: checkingId, applications: [{ invoiceId, amountApplied: '1000.00' }] },
    requestId: requestKey('payment-names'),
    reason: 'Record the Acme check.',
  });
  expect(asked.outcome).toBe('asked');
  const card = await requestForPerson(s.admin.ctx, asked.requestId!);
  expect(card?.named).toEqual(expect.arrayContaining([{ kind: 'customers', name: 'Acme Property Management' }, { kind: 'accounts', name: expect.stringMatching(/^1000 /) }]));
  // The agent's own view of the request carries no names it was not shown.
  expect(JSON.stringify(await agent.verb('list_my_requests', {} as never))).not.toMatch(/"named"/);
}, 120_000);

it("a recurring invoice's card shows what one run would enter, not 0.00", async () => {
  const asked = await agent.run({
    operation: opId('POST', '/api/recurring'),
    body: {
      name: 'Acme monthly service',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: today(),
      template: { customerId, lines: [{ description: 'Monthly service', quantity: '2', rate: '160.00' }] },
    },
    requestId: requestKey('recurring-amount'),
    reason: 'Set up the monthly invoice.',
  });
  expect(asked.outcome).toBe('asked');
  const card = await requestForPerson(s.admin.ctx, asked.requestId!);
  expect(card?.amount).toBe('320.00');
}, 120_000);
