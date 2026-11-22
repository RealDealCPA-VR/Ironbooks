/**
 * The Home page AI card's read model (lib/services/aiActivity.ts) and the card itself
 * (components/AiActivityCard.tsx): no AI connected says so; bank lines to review (with and without
 * a suggestion) and the assistant's pending proposals are counted.
 *
 * What an agent asked for is not one of the assistant's proposals waiting under Ask AI: an old agent
 * proposal is left out of that count, and agents' requests are counted apart (the title bar badge's
 * count) and linked to Agent requests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-ai-activity');
const TEST_DIR = path.join(ROOT, 'data');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'ai-activity-test-secret';
process.env.IRONBOOKS_AGENT_ENDPOINT_DIR = path.join(ROOT, 'endpoints');
delete process.env.BKA_DEVICE_VAULT;

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, agentPermissionRequests, aiProposals, bankAccounts, bankTransactions, users } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { AGENT_PROPOSAL_KIND } from '@/lib/agent/actions';
import AiActivityCard from '@/components/AiActivityCard';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { agentAccess, createAgent } from './agents';
import { aiActivity, type AiActivity } from './aiActivity';

let db: DB;
let ctx: ServiceContext;
let companyId: string;

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function card(a: AiActivity): string {
  return renderToStaticMarkup(createElement(AiActivityCard, { a }));
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'act@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Activity Co', ownerId: owner.id });
  companyId = company.id;
  ctx = { db, companyId: company.id, userId: owner.id, role: 'owner' };
  const all = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  const checking = all.find((a) => a.subtype === 'checking')!;
  const expense = all.find((a) => a.type === 'expense')!;
  const [bank] = await db.insert(bankAccounts).values({ companyId: company.id, accountId: checking.id, bankName: 'Bank', accountNumber: '1' }).returning();
  await db.insert(bankTransactions).values([
    { companyId: company.id, bankAccountId: bank.id, date: new Date('2026-03-01T12:00:00Z'), description: 'SHELL OIL', amount: '-40.00', fitId: 'a', suggestedAccountId: expense.id },
    { companyId: company.id, bankAccountId: bank.id, date: new Date('2026-03-02T12:00:00Z'), description: 'UNKNOWN', amount: '-12.00', fitId: 'b' },
    { companyId: company.id, bankAccountId: bank.id, date: new Date('2026-03-03T12:00:00Z'), description: 'DUPLICATE', amount: '-12.00', fitId: 'c', excluded: true },
  ]);
}, 240_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('Home AI card', () => {
  it('reports no AI connected and the bank lines waiting for review', async () => {
    const a = await aiActivity(ctx);
    expect(a.connected).toBe('none');
    expect(a.bankLinesToReview).toBe(2);
    expect(a.bankLinesWithSuggestion).toBe(1);
    expect(a.pendingProposals).toBe(0);
    expect(a.agentRequestsWaiting).toBe(0);
    expect(a.autoPostedLast7Days).toBe(0);
  });

  it("counts the assistant's proposals under Ask AI and agents' requests apart, each linked where it is decided", async () => {
    const owner: ServiceContext = { ...ctx, access: fullAccess() };
    const made = await createAgent(owner, { name: 'Home Card Agent', roleKeys: ['bookkeeper'], mode: 'propose' });
    const base = { companyId, payload: { date: '2026-03-14', description: 'x', lines: [], totalDebit: '0.00' }, status: 'pending' as const };
    // The assistant's own: counted under Ask AI.
    await db.insert(aiProposals).values({ ...base, createdBy: ctx.userId, kind: 'journal_entry', summary: 'Journal entry 2026-03-14' });
    // An agent's old proposal, copied into Agent requests, and one the upgrade left with no request:
    // neither waits for an approval under Ask AI.
    const [copied] = await db
      .insert(aiProposals)
      .values({ ...base, createdBy: null, agentId: made.agent.id, kind: AGENT_PROPOSAL_KIND, summary: 'New customer: Copied LLC' })
      .returning();
    await db.insert(aiProposals).values({ ...base, createdBy: null, agentId: null, kind: AGENT_PROPOSAL_KIND, summary: 'New customer: Leftover LLC' });
    await db.insert(agentPermissionRequests).values({
      companyId,
      agentId: made.agent.id,
      requestKey: `proposal:${copied.id}`,
      operation: 'action:add_customer',
      class: 'change',
      input: { displayName: 'Copied LLC' },
      summary: 'New customer: Copied LLC',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      proposalId: copied.id,
    });

    const a = await aiActivity(ctx);
    expect(a.pendingProposals).toBe(1);
    expect(a.agentRequestsWaiting).toBe(1);

    const html = card(a);
    const text = textOf(html);
    expect(html).toContain('href="/dashboard?assistant=1"');
    expect(text).toContain('1 entry the assistant drafted, waiting for your approval (Ask AI)');
    expect(text).not.toMatch(/agent drafted/);
    expect(html).toContain('href="/agent-requests"');
    expect(text).toContain('1 request from an agent waiting for your decision (Agent requests)');

    // Nothing is counted for an agent reading it, nor for a context without a person.
    const agentCtx: ServiceContext = {
      db,
      companyId,
      userId: null,
      role: 'viewer',
      access: await agentAccess(db, { companyId, roleKeys: ['bookkeeper'] }),
      agent: { id: made.agent.id, name: made.agent.name, mode: 'propose' },
    };
    expect((await aiActivity(agentCtx)).agentRequestsWaiting).toBe(0);
    expect((await aiActivity({ db, companyId, userId: null })).agentRequestsWaiting).toBe(0);
  });

  it("a teammate's window leaves out host-only work, as the title bar badge does", async () => {
    const owner: ServiceContext = { ...ctx, access: fullAccess() };
    const made = await createAgent(owner, { name: 'Host Only Agent', roleKeys: ['bookkeeper'], mode: 'propose' });
    // Removing the mail server set-up is approved only at the computer that holds the company file.
    await db.insert(agentPermissionRequests).values({
      companyId,
      agentId: made.agent.id,
      requestKey: 'host-only-1',
      operation: 'email.settings.delete',
      class: 'settings',
      input: {},
      summary: 'Remove the mail server set-up',
      needs: { admin: true, fileAdmin: false, hostOnly: true, flag: null, flags: [], grantAdminOnly: false, secrets: [], twoPerson: false, grantable: 'no' },
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { badgeForPerson } = await import('./agentRequests');
    const atHost = await aiActivity(ctx, new Date(), { atHost: true });
    const teammate = await aiActivity(ctx, new Date(), { atHost: false });
    // The copied proposal from the test above, and this one at the host; only the copied one elsewhere.
    expect(atHost.agentRequestsWaiting).toBe(2);
    expect(teammate.agentRequestsWaiting).toBe(1);
    expect(atHost.agentRequestsWaiting).toBe((await badgeForPerson(ctx, { atHost: true })).pending);
    expect(teammate.agentRequestsWaiting).toBe((await badgeForPerson(ctx, { atHost: false })).pending);
    // Left out, it counts as the host's window (lib/agent/contract.ts ListRequestsForPerson).
    expect((await aiActivity(ctx)).agentRequestsWaiting).toBe(2);
  });

  it("with no AI connected, agents' requests still show (agents work without the app's AI)", () => {
    const quiet: AiActivity = {
      connected: 'none',
      autoApplyEnabled: false,
      autoPostedLast7Days: 0,
      bankLinesToReview: 0,
      bankLinesWithSuggestion: 0,
      pendingProposals: 0,
      agentRequestsWaiting: 0,
      ruleOffers: 0,
      cloudCallsToday: 0,
      cloudDailyCap: 0,
    };
    expect(textOf(card(quiet))).toContain('Connect your AI');
    expect(card(quiet)).not.toContain('/agent-requests');
    const html = card({ ...quiet, agentRequestsWaiting: 2 });
    expect(html).toContain('href="/agent-requests"');
    expect(textOf(html)).toContain('2 requests from agents waiting for your decision (Agent requests)');
  });

  it('each count reads as a sentence, one or many', () => {
    const base: AiActivity = {
      connected: 'local',
      autoApplyEnabled: true,
      autoPostedLast7Days: 1,
      bankLinesToReview: 1,
      bankLinesWithSuggestion: 1,
      pendingProposals: 1,
      agentRequestsWaiting: 1,
      ruleOffers: 1,
      cloudCallsToday: 0,
      cloudDailyCap: 0,
    };
    const single = textOf(card(base));
    expect(single).toContain('1 bank line the AI posted this week');
    expect(single).toContain('1 bank line to review — 1 already has a suggested account');
    expect(single).toContain('1 entry the assistant drafted');
    expect(single).toContain('1 request from an agent waiting for your decision');
    expect(single).toContain('1 learned payee rule ready to turn on');
    const many = textOf(
      card({ ...base, autoPostedLast7Days: 3, bankLinesToReview: 4, bankLinesWithSuggestion: 2, pendingProposals: 2, agentRequestsWaiting: 5, ruleOffers: 6 }),
    );
    expect(many).toContain('3 bank lines the AI posted this week');
    expect(many).toContain('4 bank lines to review — 2 already have a suggested account');
    expect(many).toContain('2 entries the assistant drafted');
    expect(many).toContain('5 requests from agents waiting for your decision');
    expect(many).toContain('6 learned payee rules ready to turn on');
  });
});
