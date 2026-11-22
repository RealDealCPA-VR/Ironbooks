/**
 * Ask AI and what outside agents asked for (lib/services/aiAssistant.ts), on a real PGlite company.
 *
 *  - An agent's proposal (kind 'agent_action') is never approved or rejected from Ask AI: both are
 *    refused with a message pointing to Agent requests, naming the request copied from it, and
 *    nothing is entered. Deciding it in Agent requests (lib/services/agentRequests.ts) settles the
 *    Ask AI row too.
 *  - listProposals gives each agent row its request (link and state) and writes nothing. A
 *    withdrawn or expired request reads as rejected, with why. The agent's input is not part of the
 *    list. A status filter answers by the state shown, and agent rows that read otherwise never
 *    push real matches out of it. An agent reading the list is given only the proposals it made
 *    itself.
 *  - The refusal reaches the client with its "Open in Agent requests" fix (app/api/ai/_errors.ts),
 *    and, when the row moved on since the list was read, with the row as it stands now.
 *  - One with no request cannot be approved (refused with what to do instead) but can be declined,
 *    which enters nothing. An agent never approves or declines anything.
 *  - The app's own proposals are approved here as before.
 *  - Line memos in search_transactions mask "Acct # <number>" for a caller without "view full
 *    account numbers"; such a caller finds a memo by what it shows, never by the digits it hides
 *    (a non-breaking space after the label included).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-agent-requests');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'ai-agent-requests-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

import { closeDb, getDb, type DB } from '@/lib/db';
import { readOnlyDb } from '@/lib/db/readOnly';
import { accounts, agentPermissionRequests, aiProposals, auditLogs, customers, users } from '@/lib/db/schema';
import { fullAccess, legacyRoleFor, normalizeGrant, type EffectiveAccess } from '@/lib/permissions/model';
import { createCompany } from './company';
import { agentAccess, createAgent } from './agents';
import { resolveAccess } from './access';
import { createManualEntry } from './journal';
import { approveAgentRequest, denyAgentRequest } from './agentRequests';
import { ServiceError, type ServiceContext } from './_base';
import { aiErrorResponse } from '@/app/api/ai/_errors';
import {
  AGENT_DECIDES_NOTHING_MESSAGE,
  AGENT_PROPOSAL_ELSEWHERE_MESSAGE,
  AGENT_PROPOSAL_UNLISTED_MESSAGE,
  approveProposal,
  createProposal,
  listProposals,
  rejectProposal,
  runTool,
} from './aiAssistant';

let db: DB;
let companyId: string;
let owner: ServiceContext;
let person: ServiceContext;
let agentCtx: ServiceContext;
let agent: { id: string; name: string };
let seq = 0;

const DAY = 86_400_000;

async function expectError(p: Promise<unknown>, code: string): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).code).toBe(code);
    return e as ServiceError;
  }
  throw new Error(`expected ${code}`);
}

/** An agent's proposal as the curated actions store it (lib/agent/actions.ts proposeAction). */
async function agentProposal(
  name: string,
  over: Partial<typeof aiProposals.$inferInsert> = {},
  input: Record<string, unknown> = { displayName: name },
) {
  const [p] = await db
    .insert(aiProposals)
    .values({
      companyId,
      createdBy: null,
      agentId: agent.id,
      kind: 'agent_action',
      summary: `New customer: ${name}`,
      payload: {
        date: '2026-03-14',
        description: `New customer: ${name}`,
        lines: [],
        totalDebit: '0.00',
        action: 'add_customer',
        input,
        changes: [{ table: 'customers' }],
        agent: { id: agent.id, name: agent.name },
      },
      status: 'pending',
      ...over,
    })
    .returning();
  return p;
}

/** The request migration 0097 copies from a proposal. */
async function copiedRequest(proposalId: string, name: string, over: Partial<typeof agentPermissionRequests.$inferInsert> = {}) {
  seq += 1;
  const [r] = await db
    .insert(agentPermissionRequests)
    .values({
      companyId,
      agentId: agent.id,
      requestKey: `proposal:${proposalId}`,
      operation: 'action:add_customer',
      class: 'change',
      input: { displayName: name },
      summary: `New customer: ${name}`,
      status: 'pending',
      expiresAt: new Date(Date.now() + DAY),
      proposalId,
      ...over,
    })
    .returning();
  return r;
}

async function proposalOf(id: string) {
  const [p] = await db.select().from(aiProposals).where(eq(aiProposals.id, id));
  return p;
}

async function requestsFor(proposalId: string) {
  return db.select().from(agentPermissionRequests).where(eq(agentPermissionRequests.proposalId, proposalId));
}

async function viewOf(id: string, ctx: ServiceContext = owner) {
  return (await listProposals(ctx)).find((p) => p.id === id);
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'owner@ai-agent-requests.test', name: 'Olive Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Ask AI Agents Co', ownerId: u.id });
  companyId = company.id;
  owner = { db, companyId, userId: u.id, role: 'owner', access: fullAccess() };
  const r = await resolveAccess(db, companyId, u.id);
  person = { db, companyId, userId: u.id, access: r.access, role: legacyRoleFor(r.access, r.isOwner) };
  const made = await createAgent(owner, { name: 'Agent Ledger', roleKeys: ['bookkeeper'], mode: 'propose' });
  agent = { id: made.agent.id, name: made.agent.name };
  agentCtx = {
    db: readOnlyDb(db),
    companyId,
    userId: null,
    role: 'viewer',
    closingDateOverride: false,
    access: await agentAccess(db, { companyId, roleKeys: ['bookkeeper'] }),
    agent: { id: agent.id, name: agent.name, mode: 'propose' },
    readOnly: true,
  };
}, 240_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// One place approves an agent's work: Agent requests
// ---------------------------------------------------------------------------

describe("an agent's proposal is decided in Agent requests, not in Ask AI", () => {
  it('approving it here is refused, names its request, and enters nothing', async () => {
    const p = await agentProposal('Refused Here LLC');
    const r = await copiedRequest(p.id, 'Refused Here LLC');
    const err = await expectError(approveProposal(owner, p.id), 'FORBIDDEN');
    expect(err.message).toBe(AGENT_PROPOSAL_ELSEWHERE_MESSAGE);
    expect(err.details).toEqual({
      agentRequests: true,
      agentRequestId: r.id,
      href: `/agent-requests?id=${r.id}`,
      // The row as the list shows it now, so the panel can show where it stands.
      proposal: await viewOf(p.id),
    });
    expect(err.fixes).toEqual([{ id: 'open-agent-request', label: 'Open in Agent requests', kind: 'navigate', href: `/agent-requests?id=${r.id}` }]);
    expect((await proposalOf(p.id)).status).toBe('pending');
    expect((await requestsFor(p.id))[0].status).toBe('pending');
    expect(await db.select().from(customers).where(like(customers.displayName, 'Refused Here LLC'))).toHaveLength(0);
  });

  it('rejecting it here is refused too, and it keeps waiting there', async () => {
    const p = await agentProposal('Not Rejected Here LLC');
    const r = await copiedRequest(p.id, 'Not Rejected Here LLC');
    const err = await expectError(rejectProposal(owner, p.id), 'FORBIDDEN');
    expect(err.message).toMatch(/Agent requests/);
    expect((err.details as { agentRequestId: string }).agentRequestId).toBe(r.id);
    expect((await proposalOf(p.id)).status).toBe('pending');
    expect((await requestsFor(p.id))[0].status).toBe('pending');
  });

  it('one already decided is refused here as well, not decided a second time', async () => {
    const p = await agentProposal('Decided Before LLC', { status: 'approved', decidedBy: owner.userId, decidedAt: new Date() });
    await copiedRequest(p.id, 'Decided Before LLC', { status: 'executed' });
    await expectError(approveProposal(owner, p.id), 'FORBIDDEN');
    await expectError(rejectProposal(owner, p.id), 'FORBIDDEN');
    expect((await proposalOf(p.id)).status).toBe('approved');
  });

  it('approved in Agent requests: entered once, and Ask AI shows it done', async () => {
    const p = await agentProposal('Approved There LLC');
    const r = await copiedRequest(p.id, 'Approved There LLC');
    expect((await viewOf(p.id))?.agentRequest).toEqual({ id: r.id, status: 'pending', href: `/agent-requests?id=${r.id}` });
    const res = await approveAgentRequest(person, r.id, {}, { atHost: true });
    expect(res.status).toBe('executed');
    const made = await db.select().from(customers).where(and(eq(customers.companyId, companyId), like(customers.displayName, 'Approved There LLC')));
    expect(made).toHaveLength(1);
    const v = await viewOf(p.id);
    expect(v).toMatchObject({ status: 'approved', agentRequest: { id: r.id, status: 'executed' } });
    // Still never decided from Ask AI.
    await expectError(approveProposal(owner, p.id), 'FORBIDDEN');
    expect(await db.select().from(customers).where(like(customers.displayName, 'Approved There LLC'))).toHaveLength(1);
  });

  it('denied in Agent requests: Ask AI shows it rejected', async () => {
    const p = await agentProposal('Denied There LLC');
    const r = await copiedRequest(p.id, 'Denied There LLC');
    expect((await denyAgentRequest(person, r.id, 'Not this one')).status).toBe('denied');
    expect(await viewOf(p.id)).toMatchObject({ status: 'rejected', error: null, agentRequest: { id: r.id, status: 'denied' } });
  });
});

// ---------------------------------------------------------------------------
// The list: each agent row with its request and state
// ---------------------------------------------------------------------------

describe("Ask AI's list of an agent's proposals", () => {
  it('withdrawn or expired reads as rejected with why, also before the proposal row is settled', async () => {
    // Settled by agentRequests.ts: the proposal row itself says so.
    const settled = await agentProposal('Withdrawn Settled LLC', { status: 'rejected', error: 'The agent withdrew this request.' });
    await copiedRequest(settled.id, 'Withdrawn Settled LLC', { status: 'cancelled' });
    expect(await viewOf(settled.id)).toMatchObject({ status: 'rejected', error: 'The agent withdrew this request.' });

    // Not settled yet: the request's state is shown.
    const withdrawn = await agentProposal('Withdrawn Unsettled LLC');
    await copiedRequest(withdrawn.id, 'Withdrawn Unsettled LLC', { status: 'cancelled' });
    expect(await viewOf(withdrawn.id)).toMatchObject({ status: 'rejected', error: 'The agent withdrew this request.', agentRequest: { status: 'cancelled' } });

    const overdue = await agentProposal('Overdue Unsettled LLC');
    await copiedRequest(overdue.id, 'Overdue Unsettled LLC', { expiresAt: new Date(Date.now() - 1000) });
    expect(await viewOf(overdue.id)).toMatchObject({
      status: 'rejected',
      error: 'This request expired before anyone decided it.',
      agentRequest: { status: 'expired' },
    });

    const failed = await agentProposal('Failed Unsettled LLC');
    await copiedRequest(failed.id, 'Failed Unsettled LLC', { status: 'failed', error: 'That customer name is already used.' });
    expect(await viewOf(failed.id)).toMatchObject({ status: 'failed', error: 'That customer name is already used.' });

    const running = await agentProposal('Running LLC');
    await copiedRequest(running.id, 'Running LLC', { status: 'approved' });
    expect(await viewOf(running.id)).toMatchObject({ status: 'pending', agentRequest: { status: 'approved' } });
  });

  it("the agent's input and the ledger preview are not part of the list", async () => {
    const p = await agentProposal('Private Input LLC', {}, { displayName: 'Private Input LLC', taxId: '123-45-6789' });
    await copiedRequest(p.id, 'Private Input LLC');
    const v = await viewOf(p.id);
    expect(v?.payload).not.toHaveProperty('input');
    expect(v?.payload).not.toHaveProperty('changes');
    expect(v?.payload.lines).toEqual([]);
    expect(v?.payload).toMatchObject({ description: 'New customer: Private Input LLC', agent: { id: agent.id, name: agent.name } });
    expect(JSON.stringify(v)).not.toContain('123-45-6789');
  });

  it('a waiting one with no request (left over by the upgrade) cannot be approved anywhere, and says what to do', async () => {
    const p = await agentProposal('No Request LLC');
    const v = await viewOf(p.id);
    expect(v).toMatchObject({ status: 'pending', agentRequest: null });
    const err = await expectError(approveProposal(owner, p.id), 'FORBIDDEN');
    expect(err.message).toBe(AGENT_PROPOSAL_UNLISTED_MESSAGE);
    expect(err.message).toMatch(/decline/);
    expect(err.details).toEqual({ agentRequests: true, agentRequestId: null });
    expect((await proposalOf(p.id)).status).toBe('pending');
    expect(await db.select().from(customers).where(like(customers.displayName, 'No Request LLC'))).toHaveLength(0);
  });

  it('one with no request can be declined here, so it does not wait for good; nothing is entered', async () => {
    const p = await agentProposal('Declined Leftover LLC', {}, { displayName: 'Declined Leftover LLC', taxId: '987-65-4321' });
    const declined = await rejectProposal(owner, p.id);
    expect(declined).toMatchObject({ id: p.id, status: 'rejected', agentRequest: null });
    // Answered the way the list shows it: without what the agent sent.
    expect(declined.payload).not.toHaveProperty('input');
    expect(JSON.stringify(declined)).not.toContain('987-65-4321');
    const stored = await proposalOf(p.id);
    expect(stored).toMatchObject({ status: 'rejected', decidedBy: owner.userId });
    expect(await db.select().from(customers).where(like(customers.displayName, 'Declined Leftover LLC'))).toHaveLength(0);
    // No request was made for it, and it is no longer waiting in Ask AI.
    expect(await requestsFor(p.id)).toHaveLength(0);
    expect((await listProposals(owner, 'pending')).find((x) => x.id === p.id)).toBeUndefined();
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'ai_proposal'), eq(auditLogs.entityId, p.id)));
    expect(audit.some((a) => (a.newValues as { status?: string } | null)?.status === 'rejected')).toBe(true);
    // Settled once: a second answer is a conflict, and approving it is still refused.
    await expectError(rejectProposal(owner, p.id), 'CONFLICT');
    await expectError(approveProposal(owner, p.id), 'CONFLICT');
  });

  it('one with a request is still never declined here', async () => {
    const p = await agentProposal('Listed Not Declined LLC');
    await copiedRequest(p.id, 'Listed Not Declined LLC');
    const err = await expectError(rejectProposal(owner, p.id), 'FORBIDDEN');
    expect(err.message).toBe(AGENT_PROPOSAL_ELSEWHERE_MESSAGE);
    expect((await proposalOf(p.id)).status).toBe('pending');
  });

  it('a Decline refused because the row moved on carries the row as it stands now, without what the agent sent', async () => {
    // Copied into Agent requests and denied there since the panel read its list; the Ask AI row
    // is not settled yet.
    const there = await agentProposal('Moved On LLC', {}, { displayName: 'Moved On LLC', taxId: '111-22-3333' });
    const r = await copiedRequest(there.id, 'Moved On LLC', { status: 'denied' });
    const refused = await expectError(rejectProposal(owner, there.id), 'FORBIDDEN');
    const shown = (refused.details as { proposal: Record<string, unknown> }).proposal;
    expect(shown).toMatchObject({ id: there.id, kind: 'agent_action', status: 'rejected', agentRequest: { id: r.id, status: 'denied' } });
    expect(shown.payload).not.toHaveProperty('input');
    expect(JSON.stringify(refused.details)).not.toContain('111-22-3333');

    // Declined by someone else first: a conflict, with the row settled.
    const leftover = await agentProposal('Declined First LLC', {}, { displayName: 'Declined First LLC', taxId: '444-55-6666' });
    await rejectProposal(owner, leftover.id);
    const second = await expectError(rejectProposal(person, leftover.id), 'CONFLICT');
    expect(second.details).toMatchObject({ agentRequests: true, agentRequestId: null, proposal: { id: leftover.id, status: 'rejected', agentRequest: null } });
    expect(JSON.stringify(second.details)).not.toContain('444-55-6666');
    // The body the panel reads (app/api/ai/_errors.ts).
    const body = await aiErrorResponse(second, 'test').json();
    expect(body).toMatchObject({ code: 'CONFLICT', details: { proposal: { id: leftover.id, status: 'rejected' } } });
  });

  it('an agent never approves or declines a proposal, its own kind or the assistant\'s', async () => {
    const leftover = await agentProposal('Agent Declines LLC');
    const listed = await agentProposal('Agent Approves LLC');
    await copiedRequest(listed.id, 'Agent Approves LLC');
    for (const id of [leftover.id, listed.id]) {
      expect((await expectError(rejectProposal(agentCtx, id), 'FORBIDDEN')).message).toBe(AGENT_DECIDES_NOTHING_MESSAGE);
      expect((await expectError(approveProposal(agentCtx, id), 'FORBIDDEN')).message).toBe(AGENT_DECIDES_NOTHING_MESSAGE);
      expect((await proposalOf(id)).status).toBe('pending');
    }
    // A person's context that carries an agent (a run on someone's behalf) is refused the same way.
    const onBehalf: ServiceContext = { ...owner, agent: { id: agent.id, name: agent.name, mode: 'post', onBehalfOf: owner.userId } };
    await expectError(rejectProposal(onBehalf, leftover.id), 'FORBIDDEN');
    const all = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    const mine = await createProposal(owner, {
      type: 'journal_entry',
      date: '2026-03-03',
      description: 'Not for an agent to decide',
      lines: [
        { accountCode: all.find((a) => a.type === 'expense' && a.isActive)!.code, debit: '5.00' },
        { accountCode: '1000', credit: '5.00' },
      ],
    });
    await expectError(approveProposal(onBehalf, mine.id), 'FORBIDDEN');
    await expectError(rejectProposal(onBehalf, mine.id), 'FORBIDDEN');
    expect((await proposalOf(mine.id)).status).toBe('pending');
  });

  it('the refusal reaches the client with its link to Agent requests (app/api/ai/_errors.ts)', async () => {
    const p = await agentProposal('Error Body LLC');
    const r = await copiedRequest(p.id, 'Error Body LLC');
    const href = `/agent-requests?id=${r.id}`;
    const res = aiErrorResponse(await expectError(approveProposal(owner, p.id), 'FORBIDDEN'), 'test');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: AGENT_PROPOSAL_ELSEWHERE_MESSAGE,
      code: 'FORBIDDEN',
      details: { agentRequests: true, agentRequestId: r.id, href, proposal: JSON.parse(JSON.stringify(await viewOf(p.id))) },
      fixes: [{ id: 'open-agent-request', label: 'Open in Agent requests', kind: 'navigate', href }],
    });
    // An error with no details and no fixes is answered as these routes always answered it.
    expect(await aiErrorResponse(new ServiceError('VALIDATION', 'Ask a question.'), 'test').json()).toEqual({
      error: 'Ask a question.',
      code: 'VALIDATION',
      details: null,
    });
  });

  it('listing is a read, also for an agent: nothing is written', async () => {
    const p = await agentProposal('Agent Reads LLC');
    const before = (await db.select().from(agentPermissionRequests)).length;
    const v = (await listProposals(agentCtx)).find((x) => x.id === p.id);
    expect(v).toMatchObject({ status: 'pending', agentRequest: null });
    expect(v?.payload).not.toHaveProperty('input');
    await listProposals(owner, 'pending');
    expect((await db.select().from(agentPermissionRequests)).length).toBe(before);
    expect((await proposalOf(p.id)).status).toBe('pending');
  });

  it('the pending filter still lists them, with the state of their request', async () => {
    const p = await agentProposal('Filtered LLC');
    const r = await copiedRequest(p.id, 'Filtered LLC');
    const pending = await listProposals(owner, 'pending');
    expect(pending.find((x) => x.id === p.id)).toMatchObject({ status: 'pending', agentRequest: { id: r.id, status: 'pending' } });
  });

  it('a status filter answers by the state shown, also before the proposal row is settled', async () => {
    // Each still 'pending' in ai_proposals; its request has moved on.
    const done = await agentProposal('Filter Done LLC');
    await copiedRequest(done.id, 'Filter Done LLC', { status: 'executed' });
    const expired = await agentProposal('Filter Expired LLC');
    await copiedRequest(expired.id, 'Filter Expired LLC', { expiresAt: new Date(Date.now() - 1000) });
    const failed = await agentProposal('Filter Failed LLC');
    await copiedRequest(failed.id, 'Filter Failed LLC', { status: 'failed', error: 'It could not be entered.' });
    const waiting = await agentProposal('Filter Waiting LLC');
    await copiedRequest(waiting.id, 'Filter Waiting LLC');
    const running = await agentProposal('Filter Running LLC');
    await copiedRequest(running.id, 'Filter Running LLC', { status: 'approved' });

    const ids = async (status: string) => new Set((await listProposals(owner, status)).map((x) => x.id));
    const pending = await ids('pending');
    expect(pending.has(waiting.id) && pending.has(running.id)).toBe(true);
    expect(pending.has(done.id) || pending.has(expired.id) || pending.has(failed.id)).toBe(false);
    const approved = await ids('approved');
    expect(approved.has(done.id)).toBe(true);
    expect(approved.has(waiting.id) || approved.has(expired.id)).toBe(false);
    const rejected = await ids('rejected');
    expect(rejected.has(expired.id)).toBe(true);
    expect(rejected.has(waiting.id) || rejected.has(done.id)).toBe(false);
    expect((await ids('failed')).has(failed.id)).toBe(true);
    // Every row answered reads as the filter asked, the app's own proposals included.
    for (const status of ['pending', 'approved', 'rejected', 'failed']) {
      expect((await listProposals(owner, status)).every((x) => x.status === status)).toBe(true);
    }
    // Still a read: nothing settled by listing.
    expect((await proposalOf(done.id)).status).toBe('pending');
  });

  it('many agent rows that read otherwise never push real matches out of a filtered list', async () => {
    // Dated in the past, so what later tests make is still the newest.
    const hourAgo = Date.now() - 3_600_000;
    const payload = { date: '2026-03-01', description: 'Older', lines: [], totalDebit: '0.00' };
    const own = { companyId, createdBy: owner.userId, kind: 'journal_entry', payload };
    const [ownWaiting] = await db.insert(aiProposals).values({ ...own, summary: 'Own, waiting', status: 'pending', createdAt: new Date(hourAgo) }).returning();
    const [ownRejected] = await db.insert(aiProposals).values({ ...own, summary: 'Own, rejected', status: 'rejected', createdAt: new Date(hourAgo + 1) }).returning();
    // Newer than both: agents' rows still 'pending' in this table, already done in Agent requests.
    const stale = await db
      .insert(aiProposals)
      .values(
        Array.from({ length: 105 }, (_, i) => ({
          companyId,
          createdBy: null,
          agentId: agent.id,
          kind: 'agent_action',
          summary: `Done there ${i}`,
          payload,
          status: 'pending',
          createdAt: new Date(hourAgo + 60_000 + i * 10),
        })),
      )
      .returning();
    await db.insert(agentPermissionRequests).values(
      stale.map((p) => ({
        companyId,
        agentId: agent.id,
        requestKey: `proposal:${p.id}`,
        operation: 'action:add_customer',
        class: 'change',
        input: {},
        summary: p.summary,
        status: 'executed',
        expiresAt: new Date(Date.now() + DAY),
        proposalId: p.id,
      })),
    );

    const waiting = await listProposals(owner, 'pending');
    expect(waiting.map((x) => x.id)).toContain(ownWaiting.id);
    expect(waiting.every((x) => x.status === 'pending')).toBe(true);
    expect((await listProposals(owner, 'rejected')).map((x) => x.id)).toContain(ownRejected.id);
    // Full of real matches: at most 100, each once, newest first.
    const approved = await listProposals(owner, 'approved');
    expect(approved).toHaveLength(100);
    expect(new Set(approved.map((x) => x.id)).size).toBe(100);
    expect(approved.every((x) => x.status === 'approved')).toBe(true);
    const times = approved.map((x) => x.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Unfiltered, the 100 newest as before.
    expect(await listProposals(owner)).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// An agent reading the list (GET /api/ai/proposals, class 'read')
// ---------------------------------------------------------------------------

describe('an agent reading the list', () => {
  it('is given only the proposals it made itself', async () => {
    const mine = await agentProposal('Own Row LLC');
    await copiedRequest(mine.id, 'Own Row LLC');
    const other = await createAgent(owner, { name: 'Agent Elsewhere', roleKeys: ['bookkeeper'], mode: 'propose' });
    const theirs = await agentProposal('Their Row LLC', { agentId: other.agent.id });
    // Left over by the upgrade with no agent it could tell: no agent's.
    const nobodys = await agentProposal('Nobody Row LLC', { agentId: null });
    const all = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    const persons = await createProposal(
      owner,
      {
        type: 'journal_entry',
        date: '2026-03-05',
        description: 'A person asked Ask AI for this',
        lines: [
          { accountCode: all.find((a) => a.type === 'expense' && a.isActive)!.code, debit: '7.00' },
          { accountCode: '1000', credit: '7.00' },
        ],
      },
      'Assistant proposal for: "what did I spend on lunch with my lawyer?"',
    );

    for (const status of [undefined, 'pending']) {
      const seen = await listProposals(agentCtx, status);
      const ids = seen.map((p) => p.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(ids).not.toContain(nobodys.id);
      expect(ids).not.toContain(persons.id);
      expect(seen.every((p) => p.kind === 'agent_action')).toBe(true);
      expect(JSON.stringify(seen)).not.toContain('lawyer');
    }
    // A person still sees every one of them.
    const shown = (await listProposals(owner)).map((p) => p.id);
    for (const id of [mine.id, theirs.id, nobodys.id, persons.id]) expect(shown).toContain(id);
    // The other agent is given its own and not this one's.
    const otherCtx: ServiceContext = { ...agentCtx, agent: { id: other.agent.id, name: other.agent.name, mode: 'propose' } };
    const theirView = (await listProposals(otherCtx)).map((p) => p.id);
    expect(theirView).toContain(theirs.id);
    expect(theirView).not.toContain(mine.id);
  });

  it('an agent id that cannot name an agent is given nothing', async () => {
    const odd: ServiceContext = { ...agentCtx, agent: { id: 'not-an-id', name: 'Odd', mode: 'propose' } };
    expect(await listProposals(odd)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The app's own proposals: unchanged
// ---------------------------------------------------------------------------

describe("the app's own proposals", () => {
  it('are approved here as before, and carry no agent request', async () => {
    const all = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    const expense = all.find((a) => a.type === 'expense' && a.isActive)!;
    const bank = all.find((a) => a.code === '1000')!; // Checking
    const made = await createProposal(owner, {
      type: 'journal_entry',
      date: '2026-03-02',
      description: 'Own proposal',
      lines: [
        { accountCode: expense.code, debit: '12.00' },
        { accountCode: bank.code, credit: '12.00' },
      ],
    });
    const listed = (await listProposals(owner, 'pending')).find((p) => p.id === made.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('agentRequest');
    expect((await approveProposal(owner, made.id)).status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Line memos with an account number (search_transactions)
// ---------------------------------------------------------------------------

describe('search_transactions and account numbers in line memos', () => {
  const access = (fullAccountNumbers: boolean): EffectiveAccess => ({
    roleKeys: ['custom'],
    permissions: normalizeGrant({ reports_financial: ['view'] }),
    flags: { sensitivePayroll: false, fullAccountNumbers, closedPeriod: false },
    isAdmin: false,
  });
  let masked: ServiceContext;
  let full: ServiceContext;

  type Found = { entries: Array<{ description: string; lines: Array<{ memo: string | null }> }> };
  const memos = (r: unknown, description: string) =>
    (r as Found).entries.filter((e) => e.description === description).flatMap((e) => e.lines.map((l) => l.memo));

  beforeAll(async () => {
    masked = { ...owner, role: 'accountant', access: access(false) };
    full = { ...owner, role: 'accountant', access: access(true) };
    const all = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    const liability = all.find((a) => a.code === '2200')!; // Sales Tax Payable
    const bank = all.find((a) => a.code === '1000')!; // Checking
    // What a Sales Tax Payment posted before the check kept the number to itself has on its line.
    await createManualEntry(owner, {
      date: new Date('2026-04-15T00:00:00Z'),
      description: 'Pay Sales Tax - State',
      lines: [
        { accountId: liability.id, debit: '250.00', memo: 'Acct # 000123456789' },
        { accountId: bank.id, credit: '250.00', memo: 'Paper and toner' },
      ],
    });
    // Pasted or imported text: a non-breaking space between the label and the number.
    await createManualEntry(owner, {
      date: new Date('2026-04-16T00:00:00Z'),
      description: 'Pay Sales Tax - County',
      lines: [
        { accountId: liability.id, debit: '40.00', memo: 'Acct # 000987654321' },
        { accountId: bank.id, credit: '40.00' },
      ],
    });
    // Memos with an account number and other words a person may look for.
    await createManualEntry(owner, {
      date: new Date('2026-04-17T00:00:00Z'),
      description: 'Remittance to the state',
      lines: [
        { accountId: liability.id, debit: '15.00', memo: 'March remittance, Acct # 000555666777' },
        { accountId: bank.id, credit: '15.00', memo: 'Account No 000444333222 April filing' },
      ],
    });
  });

  it('a caller without "view full account numbers" sees the number masked', async () => {
    const r = await runTool(masked, 'search_transactions', { query: 'Pay Sales Tax' });
    expect(memos(r, 'Pay Sales Tax - State')).toEqual(expect.arrayContaining(['Acct # ••••6789', 'Paper and toner']));
    expect(JSON.stringify(r)).not.toContain('000123456789');
  });

  it('a caller with the flag, and a trusted context, see it as stored', async () => {
    expect(memos(await runTool(full, 'search_transactions', { query: 'Pay Sales Tax' }), 'Pay Sales Tax - State')).toContain('Acct # 000123456789');
    const trusted: ServiceContext = { db, companyId, userId: owner.userId };
    expect(memos(await runTool(trusted, 'search_transactions', { query: 'Pay Sales Tax' }), 'Pay Sales Tax - State')).toContain('Acct # 000123456789');
  });

  it('without the flag, the digits cannot be found through the memo', async () => {
    for (const query of ['000123456789', '0001234', 'Acct # 0001']) {
      expect((await runTool(masked, 'search_transactions', { query }) as Found).entries).toEqual([]);
    }
    expect(((await runTool(full, 'search_transactions', { query: '0001234' })) as Found).entries).toHaveLength(1);
    // A memo without an account number is searched as before.
    expect(((await runTool(masked, 'search_transactions', { query: 'toner' })) as Found).entries).toHaveLength(1);
  });

  it('also when a non-breaking space stands between the label and the number', async () => {
    const shown = memos(await runTool(masked, 'search_transactions', { query: 'County' }), 'Pay Sales Tax - County');
    expect(shown).toContain('Acct # ••••4321');
    for (const query of ['000987654321', '0009876', '0009%']) {
      expect(((await runTool(masked, 'search_transactions', { query })) as Found).entries).toEqual([]);
    }
    expect(((await runTool(full, 'search_transactions', { query: '0009876' })) as Found).entries).toHaveLength(1);
  });

  it('also with the other spaces the mask reads as spaces (pasted or imported text)', async () => {
    const all = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
    const liability = all.find((a) => a.code === '2200')!;
    const bank = all.find((a) => a.code === '1000')!;
    // An ideographic space, a figure space, a narrow no-break space and a zero-width no-break space.
    const stored = [
      'Account　No. 000222111999 quarterly rent',
      'Acct #000333222111',
      'A/C Number: 000444555666',
      'Acct﻿# 000777888999',
    ];
    await createManualEntry(owner, {
      date: new Date('2026-04-18T00:00:00Z'),
      description: 'Unicode spaces',
      lines: [
        { accountId: liability.id, debit: '4.00', memo: stored[0] },
        { accountId: liability.id, debit: '3.00', memo: stored[1] },
        { accountId: liability.id, debit: '2.00', memo: stored[2] },
        { accountId: liability.id, debit: '1.00', memo: stored[3] },
        { accountId: bank.id, credit: '10.00' },
      ],
    });
    const shown = memos(await runTool(masked, 'search_transactions', { query: 'Unicode spaces' }), 'Unicode spaces');
    for (const s of stored) expect(shown).not.toContain(s);
    expect(JSON.stringify(shown)).not.toMatch(/000222111999|000333222111|000444555666|000777888999/);
    for (const query of ['0002221', '0003332', '0004445', '0007778', '000%999']) {
      expect(((await runTool(masked, 'search_transactions', { query })) as Found).entries).toEqual([]);
    }
    // Still found by the words it shows; and by its digits by a caller who may see them.
    expect(((await runTool(masked, 'search_transactions', { query: 'quarterly rent' })) as Found).entries.map((e) => e.description)).toEqual(['Unicode spaces']);
    expect(((await runTool(full, 'search_transactions', { query: '0004445' })) as Found).entries).toHaveLength(1);
  });

  it('without the flag, such a memo is still found by what it shows', async () => {
    const found = (query: string) => runTool(masked, 'search_transactions', { query }) as Promise<Found>;
    // The words before the label, and after a label that masks only the number.
    expect((await found('March remittance')).entries.map((e) => e.description)).toEqual(['Remittance to the state']);
    expect((await found('April filing')).entries.map((e) => e.description)).toEqual(['Remittance to the state']);
    expect(memos(await found('March remittance'), 'Remittance to the state')).toEqual(
      expect.arrayContaining(['March remittance, Acct # ••••6777', 'Account No ••••3222 April filing']),
    );
    // What it shows, masked digits included; never the digits it hides.
    expect((await found('••••6777')).entries).toHaveLength(1);
    expect((await found('000555')).entries).toEqual([]);
    expect((await found('000444333222')).entries).toEqual([]);
    // The limit counts entries that matched as shown.
    expect((await runTool(masked, 'search_transactions', { query: 'Acct', limit: 1 }) as Found).entries).toHaveLength(1);
  });
});
