/**
 * Ask AI (components/AssistantPanel.tsx) and what outside agents asked for, rendered with
 * react-dom/server (no DOM needed).
 *
 *  - An agent's request shows as a row: who asked, what, where it stands, and a link to it in Agent
 *    requests (/agent-requests?id=<request id>). It has no Approve or Reject button: it is decided
 *    there.
 *  - "Waiting for your approval (n)" counts the app's own proposals only; agents' requests are
 *    listed apart (the title bar badge counts them).
 *  - A withdrawn or expired request reads as not done, with why; the app's own proposals keep
 *    their Approve and Reject buttons.
 *  - One left over with no request in Agent requests has a single button, Decline (it enters
 *    nothing), so it does not wait in the panel for good.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentRequestRow,
  ProposalItem,
  WaitingProposals,
  agentRequestState,
  agentRequestsHref,
  canOnlyDecline,
  isAgentProposal,
  type Proposal,
} from '@/components/AssistantPanel';

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const REQUEST_ID = '0b9a3c1e-5d2f-4a7b-9c8d-1e2f3a4b5c6d';

function own(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'own-1',
    kind: 'journal_entry',
    summary: 'Journal entry 2026-03-02: Office supplies ($12.00)',
    status: 'pending',
    payload: {
      date: '2026-03-02',
      description: 'Office supplies',
      totalDebit: '12.00',
      lines: [
        { accountCode: '6000', accountName: 'Office Supplies', debit: '12.00', credit: null, memo: null },
        { accountCode: '1000', accountName: 'Checking', debit: null, credit: '12.00', memo: null },
      ],
    },
    resultRef: null,
    ...over,
  };
}

function asked(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'agent-1',
    kind: 'agent_action',
    summary: 'New customer: Harbor Freight LLC',
    status: 'pending',
    payload: { date: '2026-03-14', description: 'New customer: Harbor Freight LLC', totalDebit: '0.00', lines: [], agent: { name: 'Month-end helper' } },
    resultRef: null,
    error: null,
    agentRequest: { id: REQUEST_ID, status: 'pending', href: `/agent-requests?id=${REQUEST_ID}` },
    ...over,
  };
}

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const count = (html: string, s: string) => html.split(s).length - 1;

describe("an agent's request in Ask AI", () => {
  it('is a row with who asked, what, its state and a link to Agent requests, and no buttons', () => {
    const html = render(createElement(AgentRequestRow, { p: asked() }));
    const text = textOf(html);
    expect(text).toContain('The agent Month-end helper asked');
    expect(text).toContain('New customer: Harbor Freight LLC');
    expect(text).toContain('Waiting in Agent requests');
    expect(html).toContain(`href="/agent-requests?id=${REQUEST_ID}"`);
    expect(text).toContain('Open in Agent requests');
    expect(html).not.toContain('<button');
    expect(text).not.toMatch(/Approve|Reject/);
  });

  it('never gets the Approve and Reject buttons, wherever it is shown', () => {
    const html = render(createElement(ProposalItem, { p: asked(), onChange: () => {} }));
    expect(html).not.toContain('<button');
    expect(html).toContain('Open in Agent requests');
    // The app's own proposal still has both.
    const mine = textOf(render(createElement(ProposalItem, { p: own(), onChange: () => {} })));
    expect(mine).toContain('Approve & post');
    expect(mine).toContain('Reject');
  });

  it('withdrawn or expired reads as not done, with the reason', () => {
    const withdrawn = textOf(render(createElement(AgentRequestRow, { p: asked({ status: 'rejected', error: 'The agent withdrew this request.', agentRequest: { id: REQUEST_ID, status: 'cancelled' } }) })));
    expect(withdrawn).toContain('Not done');
    expect(withdrawn).toContain('The agent withdrew this request.');
    const expired = textOf(render(createElement(AgentRequestRow, { p: asked({ status: 'rejected', error: 'This request expired before anyone decided it.', agentRequest: { id: REQUEST_ID, status: 'expired' } }) })));
    expect(expired).toContain('Not done');
    expect(expired).toContain('This request expired before anyone decided it.');
  });

  it('says where every other state stands', () => {
    expect(agentRequestState(asked({ status: 'rejected', error: null }))).toMatchObject({ label: 'Denied', note: null });
    expect(agentRequestState(asked({ status: 'approved' }))).toMatchObject({ label: 'Done', tone: 'success' });
    expect(agentRequestState(asked({ status: 'failed', error: 'That name is already used.' }))).toMatchObject({ label: 'Failed', note: 'That name is already used.' });
    expect(agentRequestState(asked({ agentRequest: { id: REQUEST_ID, status: 'approved' } }))).toMatchObject({ label: 'Being carried out' });
    const missing = agentRequestState(asked({ agentRequest: null }));
    expect(missing.label).toBe('Not in Agent requests');
    expect(missing.note).toMatch(/Ask the agent to send it again/);
    // Without a request there is nothing to link to.
    expect(render(createElement(AgentRequestRow, { p: asked({ agentRequest: null }) }))).not.toContain('href=');
  });

  it('one with no request in Agent requests can only be declined, which clears it', () => {
    const leftover = asked({ agentRequest: null });
    expect(canOnlyDecline(leftover)).toBe(true);
    const html = render(createElement(ProposalItem, { p: leftover, onChange: () => {} }));
    const text = textOf(html);
    expect(count(html, '<button')).toBe(1);
    expect(text).toContain('Decline');
    expect(text).not.toMatch(/Approve|Reject/);
    expect(text).toContain('Decline it to clear it from this list.');
    // Listed apart from the app's own, and not counted with them.
    const waiting = textOf(render(createElement(WaitingProposals, { pending: [leftover], onChange: () => {} })));
    expect(waiting).toContain('Asked by agents');
    expect(waiting).toContain('Decline');
    expect(waiting).not.toMatch(/Waiting for your approval/);
    // Every other agent row: no button at all.
    for (const p of [
      asked(),
      asked({ agentRequest: { id: REQUEST_ID, status: 'approved' } }),
      asked({ status: 'rejected', agentRequest: null }),
      asked({ status: 'approved', agentRequest: null }),
    ]) {
      expect(canOnlyDecline(p)).toBe(false);
      expect(render(createElement(ProposalItem, { p, onChange: () => {} }))).not.toContain('<button');
    }
    // The app's own proposal is never "decline only": it keeps Approve and Reject.
    expect(canOnlyDecline(own({ agentRequest: null }))).toBe(false);
  });

  it('links by the request id, made safe for a URL', () => {
    expect(agentRequestsHref(REQUEST_ID)).toBe(`/agent-requests?id=${REQUEST_ID}`);
    expect(agentRequestsHref('a&b=c')).toBe('/agent-requests?id=a%26b%3Dc');
    expect(isAgentProposal(asked())).toBe(true);
    expect(isAgentProposal(own())).toBe(false);
  });
});

describe('Waiting for your approval', () => {
  it("counts the app's own proposals only and lists agents' requests apart", () => {
    const html = render(createElement(WaitingProposals, { pending: [own(), asked(), asked({ id: 'agent-2', summary: 'New vendor: Paper Co' })], onChange: () => {} }));
    const text = textOf(html);
    expect(text).toContain('Waiting for your approval (1)');
    expect(text).toContain('Asked by agents');
    expect(text).toContain('New vendor: Paper Co');
    expect(count(html, 'Open in Agent requests')).toBe(2);
    // One card with buttons: the app's own.
    expect(count(text, 'Approve & post')).toBe(1);
  });

  it('with only agents waiting, nothing is counted as waiting for an answer here', () => {
    const text = textOf(render(createElement(WaitingProposals, { pending: [asked()], onChange: () => {} })));
    expect(text).not.toMatch(/Waiting for your approval/);
    expect(text).toContain('Asked by agents');
    expect(text).not.toContain('Approve');
  });

  it('shows nothing when nothing is waiting', () => {
    expect(render(createElement(WaitingProposals, { pending: [], onChange: () => {} }))).toBe('');
  });
});
