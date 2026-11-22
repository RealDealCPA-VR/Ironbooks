/**
 * An agent's Ask AI never stores an Ask AI proposal (WAVE5C F1). An Ask AI proposal is approved in
 * Ask AI by any person, outside the agent's rules (policy, role ceiling, two-person amount, dry-run
 * card). So when an agent's ai.assistant call gets a proposal from the model, the suggestion comes
 * back as text with a plain note, and nothing is stored. A person's own Ask AI is unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiProposals } from '@/lib/db/schema';
import type { FetchLike } from '@/lib/ai/providers';
import type { ServiceContext } from './_base';
import { AGENT_PROPOSAL_NOT_STORED_MESSAGE, ask, createProposal } from './aiAssistant';
import { updateSettings } from './aiSettings';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let agentCtx: ServiceContext;

const PROPOSAL = {
  type: 'journal_entry',
  date: '2026-09-30',
  description: 'Owner draw',
  lines: [
    { accountCode: '6600', debit: '480.00' },
    { accountCode: '1000', credit: '480.00' },
  ],
};

/** A local model server that answers every chat with a proposal. */
function model(): FetchLike {
  return async (url) => {
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 });
    const content = JSON.stringify({ action: 'answer', answer: 'Prepared for approval.', proposal: PROPOSAL });
    return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { role: 'assistant', content } }), { status: 200 });
  };
}

const count = async () => (await t.db.select().from(aiProposals).where(eq(aiProposals.companyId, t.ctx.companyId))).length;

beforeAll(async () => {
  t = await makeTestCompany('ai-agent-ask');
  await updateSettings(t.ctx, {
    providers: [{ kind: 'ollama', label: 'GPU', baseUrl: 'http://100.80.1.2:11434', model: 'qwen2.5:14b', enabled: true }],
  });
  agentCtx = {
    ...t.ctx,
    agent: { id: '00000000-0000-4000-8000-0000000000f1', name: 'Helper', mode: 'post', onBehalfOf: t.ctx.userId },
  };
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe("an agent's Ask AI", () => {
  it('answers the proposal as text with a note, and stores nothing', async () => {
    const before = await count();
    const r = await ask(agentCtx, [], 'Propose a journal entry for the owner draw', { deps: { fetch: model() } });
    expect(r.mode).toBe('llm');
    expect(r.proposals).toEqual([]);
    expect(r.answer).toContain('Owner draw');
    expect(r.answer).toContain('480.00');
    expect(r.answer).toContain(AGENT_PROPOSAL_NOT_STORED_MESSAGE);
    // The proposal's own numbers are not flagged as made up.
    expect(r.unverifiedNumbers).toEqual([]);
    expect(await count()).toBe(before);
  }, 120_000);

  it('createProposal refuses an agent outright', async () => {
    const before = await count();
    await expect(createProposal(agentCtx, PROPOSAL)).rejects.toMatchObject({ code: 'FORBIDDEN', message: AGENT_PROPOSAL_NOT_STORED_MESSAGE });
    expect(await count()).toBe(before);
  });

  it("a person's own Ask AI still stores the proposal for approval", async () => {
    const before = await count();
    const r = await ask(t.ctx, [], 'Propose a journal entry for the owner draw', { deps: { fetch: model() } });
    expect(r.proposals).toHaveLength(1);
    expect(r.answer).not.toContain(AGENT_PROPOSAL_NOT_STORED_MESSAGE);
    expect(await count()).toBe(before + 1);
  }, 120_000);
});
