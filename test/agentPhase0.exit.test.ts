/**
 * Agent full access, Phase 0 exit (plan §9 Phase 0, §6.1, §7.3), end to end IN PROCESS: a real
 * PGlite company, the real door (lib/agent/operate.ts handleVerb, as POST /api/agent/actions
 * calls it with the context lib/agentContext.ts builds from the agent's token), the real bridge,
 * policy, requests and audit trail. Nothing of the app is mocked (test/helpers/agentScenario.ts).
 *
 * What is proved:
 *  - an agent with "Ask for every change" finds, dry runs and asks for an estimate, a purchase
 *    order and a time entry using only find_operations, describe_operation and run_operation;
 *  - a person approves each in the approval center; each is then in the books, its audit rows name
 *    the agent, the approving person and the request, and the audit trail words it
 *    "<agent> (agent), approved by <person>" (lib/services/auditTrail.ts);
 *  - a denial with a note reaches the agent through list_my_requests (and run_operation's replay),
 *    and so does a request nobody answered in 7 days (expired);
 *  - the same request id twice asks once;
 *  - a read_only agent is refused (and is not even asked about);
 *  - a trusted_bookkeeper agent posts without asking, named "<agent> (agent)".
 *
 * A step that does not behave as the plan says is kept as it.fails with a comment naming what is
 * wrong and where, never bent to pass.
 *
 * Order: vitest runs the tests of this file one after the other, in the order written. Most share
 * only the asking agent (asker) and stand on their own; the few that build on an earlier test say
 * so, naming it. The last describe expires every request still waiting, so it stays last.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bills, estimates, invoices, items, journalEntries, purchaseOrders, timeEntries } from '@/lib/db/schema';
import { agentActivityReport, getAuditLog, listAuditLogs } from '@/lib/services/auditTrail';
import { NO_REASON_NOTE, resetAgentRateLimits } from '@/lib/agent/operate';
import { approveAgentRequest, badgeForPerson, expireRequests, waitForDecision } from '@/lib/services/agentRequests';
import { updateItem } from '@/lib/services/items';
import type { ReportParams } from '@/lib/validation/reports';
import { ServiceError } from '@/lib/services/_base';
import type { AgentOperationAnswer, AgentRequestView } from '@/lib/agent/contract';
import { createdId, scenarioEnv, setupScenario, type Scenario, type ScenarioAgent } from './helpers/agentScenario';

scenarioEnv('test-agent-phase0-exit');

let s: Scenario;
let asker: ScenarioAgent;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function count(table: typeof estimates | typeof purchaseOrders | typeof timeEntries | typeof bills): Promise<number> {
  return (await s.db.select({ id: table.id }).from(table).where(eq(table.companyId, s.companyId))).length;
}

/**
 * The three documents the plan names (none of which the curated tools could enter before), and
 * the amount the approval card shows for each: the dry run's total, or "0.00" for work that has
 * no amount and posted nothing (a time entry), never unknown.
 */
function phase0Cases() {
  return [
    {
      what: 'an estimate',
      operation: 'estimates.create',
      query: 'estimate',
      table: estimates,
      amount: '600.00',
      body: () => ({
        customerId: s.rich.customerId,
        date: '2026-11-02',
        lines: [{ description: 'Year-end review', quantity: '4', rate: '150.00' }],
      }),
    },
    {
      what: 'a purchase order',
      operation: 'purchase-orders.create',
      query: 'purchase order',
      table: purchaseOrders,
      amount: '150.00',
      body: () => ({
        vendorId: s.rich.vendorId,
        date: '2026-11-02',
        lines: [{ accountId: s.rich.acct['6300'], description: 'Copier paper', quantity: '5', rate: '30.00' }],
      }),
    },
    {
      what: 'a time entry',
      operation: 'time-entries.create',
      query: 'time',
      table: timeEntries,
      amount: '0.00',
      body: () => ({ customerId: s.rich.customerId, date: '2026-11-02', hours: '3', description: 'Cleaning up the vendor list', billable: true }),
    },
  ] as const;
}

async function myRequest(agent: ScenarioAgent, id: string): Promise<AgentRequestView | undefined> {
  const { requests } = await agent.verb('list_my_requests', { limit: 200 });
  return requests.find((r) => r.id === id);
}

beforeAll(async () => {
  s = await setupScenario('test-agent-phase0-exit');
  asker = await s.makeAgent('Phase Zero Asker', 'ask_every_change');
}, 240_000);

afterAll(async () => {
  await s?.close();
});

beforeEach(() => {
  // The per-minute call limit is per process; these tests make many calls in a few seconds.
  resetAgentRateLimits();
});

describe('Phase 0 exit: an agent with "Ask for every change", using only the generic tools', () => {
  it('finds each operation and is told it must ask', async () => {
    for (const c of phase0Cases()) {
      const found = await asker.verb('find_operations', { query: c.query, class: 'enter' });
      const hit = found.operations.find((o) => o.id === c.operation);
      expect(hit, `${c.what}: ${JSON.stringify(found.operations.map((o) => o.id))}`).toBeTruthy();
      expect(hit!.class).toBe('enter');
      expect(hit!.treatment).toBe('ask');
      expect(hit!.why).toBeTruthy();
    }
  });

  it('describes each operation: its fields, the method and how its policy treats it', async () => {
    for (const c of phase0Cases()) {
      const d = await asker.verb('describe_operation', { operation: c.operation });
      expect(d.id).toBe(c.operation);
      expect(d.method).toBe('POST');
      expect(d.treatment).toBe('ask');
      expect(d.dryRun).toBe('transaction');
      // The body's JSON Schema, from the app's own zod (plan §6.3).
      expect(d.bodySchema, c.what).toBeTruthy();
      expect(JSON.stringify(d.bodySchema)).toMatch(/date/);
    }
  });

  it('dry runs each: a preview, nothing kept, and a note that the real one would ask a person', async () => {
    for (const c of phase0Cases()) {
      const before = await count(c.table);
      const dry = (await asker.run({ operation: c.operation, body: c.body(), dryRun: true })) as AgentOperationAnswer;
      expect(dry.outcome, `${c.what}: ${JSON.stringify(dry).slice(0, 400)}`).toBe('dry_run');
      expect(dry.preview?.records.some((r) => r.action === 'create')).toBe(true);
      expect(dry.note).toMatch(/ask a person/);
      expect(dry.requestId).toBeUndefined();
      expect(await count(c.table)).toBe(before);
    }
  });

  for (const c of phase0Cases()) {
    it(`asks for ${c.what}; a person approves it; it is in the books, named "agent, approved by person"`, async () => {
      const before = await count(c.table);
      const requestKey = `p0-${c.operation}`;
      const asked = await asker.run({
        operation: c.operation,
        body: c.body(),
        requestId: requestKey,
        reason: `The client emailed the paperwork for ${c.what}.`,
      });
      expect(asked.outcome, JSON.stringify(asked).slice(0, 400)).toBe('asked');
      expect(asked.status).toBe('pending');
      expect(asked.requestId).toMatch(UUID);
      expect(asked.preview, 'the request carries the dry run it was asked with').toBeTruthy();
      // Nothing is in the books until a person says yes.
      expect(await count(c.table)).toBe(before);

      // The approval center: the person sees it, may approve it, and says yes.
      const listed = (await s.admin.requests()).find((r) => r.id === asked.requestId);
      expect(listed, 'the request is in the approval center').toBeTruthy();
      expect(listed!.agentName).toBe(asker.name);
      expect(listed!.operation).toBe(c.operation);
      expect(listed!.class).toBe('enter');
      expect(listed!.reason).toBe(`The client emailed the paperwork for ${c.what}.`);
      expect(listed!.canApprove, listed!.cannotApproveWhy ?? '').toBe(true);
      expect(listed!.amount).toBe(c.amount);
      expect(listed!.stale ?? false).toBe(false);
      // The summary is Ironbooks' own words; the agent's are kept apart, as its reason.
      expect(listed!.summary).not.toContain('The client emailed');
      // It waits 7 days by default (plan §4.3), then expires.
      const days = (Date.parse(listed!.expiresAt) - Date.parse(listed!.createdAt)) / 86_400_000;
      expect(days).toBeGreaterThan(6.99);
      expect(days).toBeLessThan(7.01);

      // Never from the agent itself (plan §4.5, §4.6): its own context cannot approve.
      const selfApproval = await approveAgentRequest(await asker.ctx(), asked.requestId!, {}, { atHost: true }).catch((e) => e);
      expect(selfApproval).toBeInstanceOf(ServiceError);
      expect((selfApproval as ServiceError).code).toBe('FORBIDDEN');
      expect(await count(c.table)).toBe(before);

      const approved = await s.admin.approve(asked.requestId!);
      expect(approved.status, JSON.stringify({ error: approved.request.error, status: approved.request.status })).toBe('executed');
      expect(approved.request.status).toBe('executed');
      expect(approved.request.decidedByName).toBe(s.admin.name);
      expect(approved.produced).toEqual([]);
      // What the run itself did (wave 3): these post nothing to the ledger.
      expect(approved.request.posted).toBe(false);
      expect(approved.request.entryIds).toEqual([]);

      // In the books.
      const id = createdId(approved.request.result);
      expect(await count(c.table)).toBe(before + 1);
      const [row] = await s.db.select({ id: c.table.id }).from(c.table).where(eq(c.table.id, id));
      expect(row?.id).toBe(id);

      // Its audit rows name the agent, the person and the request.
      const audit = await s.auditOf(id);
      expect(audit.length).toBeGreaterThan(0);
      for (const a of audit) {
        expect(a.agentId).toBe(asker.id);
        expect(a.approvedBy).toBe(s.admin.id);
        expect(a.agentRequestId).toBe(asked.requestId);
        expect(a.agentGrantId).toBeNull();
      }
      // Every record the run wrote carries the same names (lines, numbering …), not only the document.
      for (const a of await s.auditOfRequest(asked.requestId!)) {
        expect(a.agentId).toBe(asker.id);
        expect(a.approvedBy).toBe(s.admin.id);
      }

      // The audit trail's own words (lib/services/auditTrail.ts), in the list and in one entry.
      const words = `${asker.name} (agent), approved by ${s.admin.name}`;
      const one = await getAuditLog(await s.admin.ctx(), audit[0].id);
      expect(one.actorName).toBe(words);
      expect(one.approvedByName).toBe(s.admin.name);
      expect(one.agentRequestId).toBe(asked.requestId);
      const list = await listAuditLogs(await s.admin.ctx(), { agentId: asker.id, limit: 500 });
      const inList = list.rows.find((r) => r.entityId === id);
      expect(inList?.actorName).toBe(words);
      // And the transaction log, in the same words (plan §7.3).
      const logged = s.logOf(id);
      expect(logged.length).toBeGreaterThan(0);
      for (const r of logged) {
        expect(r.userName).toBe(words);
        expect(r.agentId).toBe(asker.id);
        expect(r.approvedBy).toBe(s.admin.id);
        expect(r.agentRequestId).toBe(asked.requestId);
      }

      // The agent learns it was done: list_my_requests, and the same request id again.
      const mine = await myRequest(asker, asked.requestId!);
      expect(mine?.status).toBe('executed');
      expect(createdId(mine?.result)).toBe(id);
      const replay = await asker.run({ operation: c.operation, body: c.body(), requestId: requestKey, reason: 'Asking again.' });
      expect(replay.replayed).toBe(true);
      expect(replay.requestId).toBe(asked.requestId);
      // Estimates, purchase orders and time entries post nothing to the ledger.
      expect(replay.outcome).toBe('done');
      expect(createdId(replay.result)).toBe(id);
      expect(await count(c.table)).toBe(before + 1);
    });
  }
});

describe('Phase 0 exit: a denial, and asking twice', () => {
  it('a denial with a note reaches the agent through list_my_requests', async () => {
    const before = await count(timeEntries);
    const asked = await asker.run({
      operation: 'time-entries.create',
      body: { customerId: s.rich.customerId, date: '2026-11-03', hours: '9', description: 'Wrong job', billable: true },
      requestId: 'p0-deny-1',
      reason: 'Logging the hours from the timesheet.',
    });
    expect(asked.outcome).toBe('asked');

    const note = 'Those hours were for Zeta, not Acme. Ask again with the right customer.';
    const denied = await s.admin.deny(asked.requestId!, note);
    expect(denied.status).toBe('denied');
    expect(denied.note).toBe(note);
    expect(denied.decidedByName).toBe(s.admin.name);

    const { requests } = await asker.verb('list_my_requests', { status: 'denied' });
    const mine = requests.find((r) => r.id === asked.requestId);
    expect(mine, 'the denied request is in list_my_requests').toBeTruthy();
    expect(mine!.status).toBe('denied');
    expect(mine!.note).toBe(note);
    expect(mine!.decidedByName).toBe(s.admin.name);
    // The long poll (GET /api/agent/requests/[id]?wait=) answers at once with the decision.
    const waited = await waitForDecision(await asker.ctx(), asked.requestId!, 5);
    expect(waited.status).toBe('denied');
    expect(waited.note).toBe(note);

    // Asking again with the same request id answers the denial, with the person's words.
    const again = await asker.run({
      operation: 'time-entries.create',
      body: { customerId: s.rich.customerId, date: '2026-11-03', hours: '9', description: 'Wrong job', billable: true },
      requestId: 'p0-deny-1',
      reason: 'Logging the hours from the timesheet.',
    });
    expect(again.outcome).toBe('refused');
    expect(again.replayed).toBe(true);
    expect(again.note).toContain(note);

    expect(await count(timeEntries)).toBe(before);
    // The person can no longer approve it.
    await expect(s.admin.approve(asked.requestId!)).rejects.toBeInstanceOf(ServiceError);
    expect(await count(timeEntries)).toBe(before);
  });

  it('the same request id twice asks once', async () => {
    const body = { customerId: s.rich.customerId, date: '2026-11-04', lines: [{ description: 'Second opinion', quantity: '1', rate: '90.00' }] };
    const first = await asker.run({ operation: 'estimates.create', body, requestId: 'p0-twice-1', reason: 'The client asked for a quote.' });
    const second = await asker.run({ operation: 'estimates.create', body, requestId: 'p0-twice-1', reason: 'The client asked for a quote.' });
    expect(first.outcome).toBe('asked');
    expect(second.outcome).toBe('asked');
    expect(second.replayed).toBe(true);
    expect(second.requestId).toBe(first.requestId);
    expect(await s.requestRows(asker.id, 'p0-twice-1')).toBe(1);
    const pending = (await s.admin.requests({ agentId: asker.id })).filter((r) => r.id === first.requestId);
    expect(pending).toHaveLength(1);

    // The same id for different work is refused, and asks nothing.
    const other = { ...body, lines: [{ description: 'Something else', quantity: '1', rate: '91.00' }] };
    const err = await asker.run({ operation: 'estimates.create', body: other, requestId: 'p0-twice-1', reason: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('CONFLICT');
    expect(await s.requestRows(asker.id, 'p0-twice-1')).toBe(1);
  });
});

// Relies on order: the second test approves the estimate the first one asks for (second), after
// the first one's yes.
describe('Phase 0: two estimates waiting, approved one after the other', () => {
  let second: AgentOperationAnswer | null = null;

  it('two estimates are asked for; the person approves the first', async () => {
    const body = (n: number) => ({ customerId: s.rich.customerId, date: '2026-11-08', lines: [{ description: `Quote ${n}`, quantity: '1', rate: '75.00' }] });
    const first = await asker.run({ operation: 'estimates.create', body: body(1), requestId: 'p0-pair-1', reason: 'Two quotes from the same email.' });
    second = await asker.run({ operation: 'estimates.create', body: body(2), requestId: 'p0-pair-2', reason: 'Two quotes from the same email.' });
    expect(first.outcome).toBe('asked');
    expect(second.outcome).toBe('asked');
    const r = await s.admin.approve(first.requestId!);
    expect(r.status).toBe('executed');
  });

  // DOES NOT BEHAVE AS THE PLAN SAYS (plan §7.4: "the server compares the touched records'
  // versions with the staleness key"; §7.2 "Approve" runs it). The second estimate touches no
  // record the first one changed, yet its approval answers 'stale' and nothing runs: the person
  // has to say yes again on a "the books changed" preview that shows the same estimate.
  // Evidence: the only difference between the preview the agent asked with and the stale one is
  // the estimate's own number (records: estimate.estimateNumber 2 -> 3). Same for purchase
  // orders (purchase_order.poNumber 1 -> 2), and for anything that posts (journal_entry
  // .entryNumber 15 -> 16: bills, invoices, transfers). Time entries, customers and mileage, which
  // take no number, approve fine one after the other.
  // Why: lib/agent/bridge.ts stalenessKeyOf hashes every audit row's new values through keyValue,
  // which leaves out ids, times and secrets but not the next number the run takes for itself
  // (estimateNumber, poNumber, entryNumber, the next invoice or check number). Any record of that
  // kind made by anyone in between moves it. The bridge unit's WAVE2 notes leave this as an open
  // question ("Is a re-preview whenever another posting changes the next document number
  // acceptable noise?"); for the approval center it means only the first of several waiting
  // estimates, orders or bills runs on a yes. See also test/agentPhase1.exit.test.ts (five bills).
  it.fails('the second runs on the first yes', async () => {
    expect(second?.requestId).toBeTruthy();
    const r = await s.admin.approve(second!.requestId!);
    expect(r.status).toBe('executed');
  });
});

describe('Phase 0: the badge, and an agent sees only its own requests', () => {
  it('the badge counts what a person could approve and names the newest; an agent gets nothing', async () => {
    const asked = await asker.run({
      operation: 'estimates.create',
      body: { customerId: s.rich.customerId, date: '2026-11-04', lines: [{ description: 'Badge check', quantity: '1', rate: '10.00' }] },
      requestId: 'p0-badge-1',
      reason: 'A small quote.',
    });
    expect(asked.outcome).toBe('asked');
    const badge = await badgeForPerson(await s.admin.ctx(), { atHost: true });
    const pending = await s.admin.requests();
    expect(badge.pending).toBe(pending.filter((r) => r.canApprove).length);
    expect(badge.pending).toBeGreaterThan(0);
    expect(badge.newest?.id).toBe(asked.requestId);
    expect(badge.newest?.agentName).toBe(asker.name);
    // The summary is Ironbooks' own words, never the agent's reason.
    expect(badge.newest?.summary).not.toContain('A small quote.');
    expect(await badgeForPerson(await asker.ctx(), { atHost: true })).toEqual({ pending: 0, newest: null });

    // Another agent's list_my_requests never shows this agent's requests.
    const other = await s.makeAgent('Phase Zero Bystander', 'ask_every_change');
    expect((await other.verb('list_my_requests', {})).requests).toEqual([]);
    const cancelOther = await other.verb('cancel_request', { requestId: asked.requestId! }).catch((e) => e);
    expect(cancelOther).toBeInstanceOf(ServiceError);
    expect((await s.admin.request(asked.requestId!)).status).toBe('pending');

    // Its own agent withdraws it (cancel_request, by the request id it chose): nobody can approve it then.
    const cancelled = await asker.verb('cancel_request', { requestId: 'p0-badge-1' });
    expect(cancelled.request.status).toBe('cancelled');
    await expect(s.admin.approve(asked.requestId!)).rejects.toBeInstanceOf(ServiceError);
    expect((await badgeForPerson(await s.admin.ctx(), { atHost: true })).newest?.id).not.toBe(asked.requestId);
  });
});

describe('Phase 0: asking needs a reason; the books change before the yes; every request is reported', () => {
  it('a request that would ask is refused without a reason, and nobody is asked (plan §6.1)', async () => {
    const body = { customerId: s.rich.customerId, date: '2026-11-05', hours: '1', description: 'No reason given', billable: false };
    const noReason = await asker.run({ operation: 'time-entries.create', body, requestId: 'p0-noreason-1' });
    expect(noReason.outcome).toBe('refused');
    expect(noReason.note).toBe(NO_REASON_NOTE);
    expect(await s.requestRows(asker.id, 'p0-noreason-1')).toBe(0);
    // The same request id, now with a reason, asks.
    const withReason = await asker.run({ operation: 'time-entries.create', body, requestId: 'p0-noreason-1', reason: 'From the timesheet.' });
    expect(withReason.outcome).toBe('asked');
    expect(await s.requestRows(asker.id, 'p0-noreason-1')).toBe(1);
  });

  it('the books changed since the agent asked: nothing runs, the new preview waits, and a yes on it runs (plan §7.4)', async () => {
    const [consulting] = await s.db.select().from(items).where(and(eq(items.companyId, s.companyId), eq(items.name, 'Consulting')));
    // An item line with no rate: the price is read from the item when it runs.
    const body = { customerId: s.rich.customerId, date: '2026-11-06', lines: [{ itemId: consulting.id, quantity: '2' }] };
    const asked = await asker.run({ operation: 'invoices.create', body, requestId: 'p0-stale-1', reason: 'Two hours of consulting.' });
    expect(asked.outcome).toBe('asked');
    expect((await s.admin.request(asked.requestId!)).amount).toBe('251.00');

    await updateItem(await s.admin.ctx(), consulting.id, { salesPrice: '200.00' });
    const invoicesBefore = (await s.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, s.companyId))).length;

    const first = await s.admin.approve(asked.requestId!);
    expect(first.status).toBe('stale');
    expect(first.request.status).toBe('pending');
    expect(first.request.stale).toBe(true);
    expect(first.request.amount).toBe('400.00');
    expect((await s.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, s.companyId))).length).toBe(invoicesBefore);

    // Someone who was not shown the new preview is shown it first, even with acceptStale.
    const other = await s.second.approve(asked.requestId!, { acceptStale: true });
    expect(other.status).toBe('stale');
    expect((await s.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.companyId, s.companyId))).length).toBe(invoicesBefore);

    const yes = await s.admin.approve(asked.requestId!, { acceptStale: true });
    expect(yes.status, JSON.stringify({ error: yes.request.error })).toBe('executed');
    const [inv] = await s.db.select().from(invoices).where(eq(invoices.id, createdId(yes.request.result)));
    expect(inv.total).toBe('400.00');
    expect(yes.request.posted).toBe(true);
    expect(yes.request.entryIds?.length).toBeGreaterThan(0);
    // The agent's replay says it posted.
    const replay = await asker.run({ operation: 'invoices.create', body, requestId: 'p0-stale-1', reason: 'Two hours of consulting.' });
    expect(replay.outcome).toBe('posted');
  });

  it('every request is kept and reported under Agent Activity, with who decided and the note (plan §7.3)', async () => {
    // On its own: an agent of its own asks three times; one is approved, one denied with a note, one waits.
    const reported = await s.makeAgent('Phase Zero Reported', 'ask_every_change');
    const entry = (n: number) => ({ customerId: s.rich.customerId, date: '2026-11-05', hours: `${n}`, description: `Reported ${n}`, billable: false });
    const askFor = async (n: number) => {
      const a = await reported.run({ operation: 'time-entries.create', body: entry(n), requestId: `p0-report-${n}`, reason: 'From the timesheet.' });
      expect(a.outcome, JSON.stringify(a).slice(0, 400)).toBe('asked');
      return a.requestId!;
    };
    const done = await askFor(1);
    const refused = await askFor(2);
    const waiting = await askFor(3);
    expect((await s.admin.approve(done)).status).toBe('executed');
    const note = 'Not billable to this customer. Ask again with the right one.';
    expect((await s.admin.deny(refused, note)).status).toBe('denied');

    const report = await agentActivityReport(await s.admin.ctx(), {} as ReportParams);
    const ours = report.rows.filter((r) => r.cells.agent === reported.name);
    // One row for every request, whatever became of it.
    expect(ours).toHaveLength(3);
    const byId = (requestId: string) => ours.find((r) => r.id === `aa:${requestId}`);
    expect(byId(done)?.cells.status).toBe('Done');
    expect(byId(done)?.cells.decidedBy).toBe(s.admin.name);
    expect(byId(refused)?.cells.status).toBe('Denied');
    expect(String(byId(refused)?.cells.note)).toBe(note);
    expect(byId(refused)?.cells.decidedBy).toBe(s.admin.name);
    expect(byId(waiting)?.cells.status).toBe('Waiting for approval');
    // An agent cannot read it.
    await expect(agentActivityReport(await reported.ctx(), {} as ReportParams)).rejects.toBeInstanceOf(ServiceError);
  });
});

describe('Phase 0 exit: the other presets', () => {
  it('a read_only agent is refused, and no person is asked', async () => {
    const reader = await s.makeAgent('Phase Zero Reader', 'read_only');
    const found = await reader.verb('find_operations', { query: 'estimate', class: 'enter' });
    const hit = found.operations.find((o) => o.id === 'estimates.create');
    expect(hit?.treatment).toBe('refused');
    expect(hit?.why).toBeTruthy();

    const before = await count(estimates);
    const body = phase0Cases()[0].body();
    const dry = await reader.run({ operation: 'estimates.create', body, dryRun: true });
    expect(dry.outcome).toBe('refused');
    const real = await reader.run({ operation: 'estimates.create', body, requestId: 'p0-reader-1', reason: 'Please let me.' });
    expect(real.outcome).toBe('refused');
    expect(real.note).toBeTruthy();
    expect(real.requestId).toBeUndefined();
    expect(await count(estimates)).toBe(before);
    expect(await s.requestRows(reader.id, 'p0-reader-1')).toBe(0);
    expect(await s.admin.requests({ agentId: reader.id, status: 'all' })).toEqual([]);

    // Reading is still open to it.
    const read = await reader.run({ operation: 'estimates.list' });
    expect(read.outcome).toBe('read');
  });

  it('what the agent\'s role does not allow is refused, not asked (plan §4.1, the ceiling)', async () => {
    const narrow = await s.makeAgent('Phase Zero Report Reader', 'ask_every_change', { roleKeys: ['reports_only'] });
    const before = await count(bills);
    const refused = await narrow.run({
      operation: 'bills.create',
      body: { vendorId: s.rich.vendorId, date: '2026-11-05', lines: [{ accountId: s.rich.acct['6300'], description: 'Toner', amount: '10.00' }] },
      requestId: 'p0-narrow-1',
      reason: 'Please let me.',
    });
    expect(refused.outcome).toBe('refused');
    expect(refused.note).toMatch(/role/);
    expect(await s.requestRows(narrow.id, 'p0-narrow-1')).toBe(0);
    expect(await count(bills)).toBe(before);
  });

  it('even the widest agent (Admin role, "Full, with asks") can never approve, change agents or take back a grant (plan §4.6)', async () => {
    const wide = await s.makeAgent('Phase Zero Wide', 'full_with_asks', { roleKeys: ['admin'] });
    const pending = await asker.run({
      operation: 'estimates.create',
      body: { customerId: s.rich.customerId, date: '2026-11-07', lines: [{ description: 'Hard floor', quantity: '1', rate: '5.00' }] },
      requestId: 'p0-floor-target',
      reason: 'A small quote.',
    });
    expect(pending.outcome).toBe('asked');
    const tries: Array<[string, Record<string, unknown>]> = [
      ['agent-requests.approve', { params: { id: pending.requestId! }, body: {} }],
      ['agent-requests.deny', { params: { id: pending.requestId! }, body: { note: 'no' } }],
      ['agents.update', { params: { id: wide.id }, body: { preset: 'full_with_asks', overrides: [] } }],
      ['agents.pause', { params: { id: asker.id }, body: { paused: true } }],
      ['agent-grants.revoke', { params: { id: '11111111-2222-4333-8444-555555555555' } }],
    ];
    for (const [operation, input] of tries) {
      const answer = await wide.run({ operation, ...input, requestId: `p0-floor-${operation}`, reason: 'Trying the hard floor.' });
      expect(answer.outcome, operation).toBe('refused');
      // Refused as the hard floor, not as an operation that does not exist.
      expect(answer.note, operation).toBeTruthy();
      expect(answer.note, operation).not.toMatch(/There is no operation/);
      expect(await s.requestRows(wide.id, `p0-floor-${operation}`), operation).toBe(0);
    }
    expect((await s.admin.request(pending.requestId!)).status).toBe('pending');
    // The asking agent was not paused by it.
    expect((await asker.verb('get_my_permissions', {})).paused).toBe(false);
  });

  it('a trusted_bookkeeper agent posts without asking, named "<agent> (agent)"', async () => {
    const trusted = await s.makeAgent('Phase Zero Bookkeeper', 'trusted_bookkeeper');
    const found = await trusted.verb('find_operations', { query: 'bill', class: 'enter' });
    expect(found.operations.find((o) => o.id === 'bills.create')?.treatment).toBe('run');

    const before = await count(bills);
    const posted = await trusted.run({
      operation: 'bills.create',
      body: {
        vendorId: s.rich.vendorId,
        billNumber: 'P0-TRUSTED-1',
        date: '2026-11-05',
        lines: [{ accountId: s.rich.acct['6300'], description: 'Toner', amount: '64.20' }],
      },
      requestId: 'p0-trusted-1',
    });
    expect(posted.outcome, JSON.stringify(posted).slice(0, 400)).toBe('posted');
    expect(posted.requestId).toBeUndefined();
    expect(posted.grantId).toBeUndefined();
    expect(posted.ledger?.entries.length).toBeGreaterThan(0);
    expect(await count(bills)).toBe(before + 1);
    expect(await s.admin.requests({ agentId: trusted.id, status: 'all' })).toEqual([]);

    const id = createdId(posted.result);
    const [bill] = await s.db.select().from(bills).where(eq(bills.id, id));
    expect(bill.total).toBe('64.20');
    // Its ledger entry is in the books, and it is the one the agent was told about.
    expect(bill.postedEntryId).toMatch(UUID);
    const [je] = await s.db
      .select({ id: journalEntries.id, agentId: journalEntries.agentId })
      .from(journalEntries)
      .where(eq(journalEntries.id, bill.postedEntryId!));
    expect(je?.id).toBe(bill.postedEntryId);
    expect(je?.agentId).toBe(trusted.id);
    expect(posted.ledger?.entries.map((e) => e.journalEntryId)).toContain(bill.postedEntryId);

    const audit = await s.auditOf(id);
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) {
      expect(a.agentId).toBe(trusted.id);
      expect(a.approvedBy).toBeNull();
      expect(a.agentRequestId).toBeNull();
      expect(a.agentGrantId).toBeNull();
    }
    const one = await getAuditLog(await s.admin.ctx(), audit[0].id);
    expect(one.actorName).toBe(`${trusted.name} (agent)`);
    expect(one.approvedByName).toBeNull();
    const logged = s.logOf(id);
    expect(logged.length).toBeGreaterThan(0);
    for (const r of logged) {
      expect(r.userName).toBe(`${trusted.name} (agent)`);
      expect(r.agentId).toBe(trusted.id);
      expect(r.approvedBy).toBeUndefined();
    }

    // The same request id again gives the first answer, and no second bill.
    const replay = await trusted.run({
      operation: 'bills.create',
      body: {
        vendorId: s.rich.vendorId,
        billNumber: 'P0-TRUSTED-1',
        date: '2026-11-05',
        lines: [{ accountId: s.rich.acct['6300'], description: 'Toner', amount: '64.20' }],
      },
      requestId: 'p0-trusted-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toBe('posted');
    expect(await count(bills)).toBe(before + 1);
  });
});

// Last in the file: expiring settles every request of the company that is still waiting.
describe('Phase 0: a request nobody answers expires, and the agent is told (plan §4.3)', () => {
  it('after 7 days it is expired: list_my_requests, the long poll and the same request id all say so', async () => {
    const body = { customerId: s.rich.customerId, date: '2026-11-09', hours: '2', description: 'Nobody looked', billable: false };
    const asked = await asker.run({ operation: 'time-entries.create', body, requestId: 'p0-expire-1', reason: 'From the timesheet.' });
    expect(asked.outcome).toBe('asked');
    const before = await count(timeEntries);

    // A day short of the 7 days, nothing happens; a minute past them, it expires.
    expect(await expireRequests(await s.admin.ctx(), new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect((await s.admin.request(asked.requestId!)).status).toBe('pending');
    expect(await expireRequests(await s.admin.ctx(), new Date(Date.now() + 7 * 86_400_000 + 60_000))).toBeGreaterThanOrEqual(1);

    const mine = await myRequest(asker, asked.requestId!);
    expect(mine?.status).toBe('expired');
    expect((await waitForDecision(await asker.ctx(), asked.requestId!, 5)).status).toBe('expired');
    const again = await asker.run({ operation: 'time-entries.create', body, requestId: 'p0-expire-1', reason: 'From the timesheet.' });
    expect(again.replayed).toBe(true);
    expect(again.outcome).toBe('refused');
    expect(again.note).toMatch(/expired/);
    // Nobody can approve it any more, and nothing was entered.
    await expect(s.admin.approve(asked.requestId!)).rejects.toBeInstanceOf(ServiceError);
    expect(await count(timeEntries)).toBe(before);
  });
});
