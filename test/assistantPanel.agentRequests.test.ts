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
 *    nothing), so it does not wait in the panel for good. When Decline is refused because the row
 *    moved on since the list was read, the row shows where it stands now, from the refusal: the
 *    link to Agent requests (its request still waiting there), or settled and gone from the
 *    waiting list (its request decided, or someone else declined it first).
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
  declineAgentProposal,
  isAgentProposal,
  requestFromRefusal,
  shownAfterRefusal,
  updatePending,
  type Proposal,
} from '@/components/AssistantPanel';
import { ApiError } from '@/lib/client';

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

  it('a Decline refused because it is in Agent requests after all names the request to link to', () => {
    const href = `/agent-requests?id=${REQUEST_ID}`;
    // The body app/api/ai/_errors.ts sends for that refusal, as lib/client.ts reads it.
    const refused = new ApiError(403, 'An agent asked for this, so it is approved or denied in Agent requests.', 'FORBIDDEN', { agentRequests: true, agentRequestId: REQUEST_ID, href }, [
      { id: 'open-agent-request', label: 'Open in Agent requests', kind: 'navigate', href },
    ]);
    expect(requestFromRefusal(refused)).toEqual({ id: REQUEST_ID, status: 'pending', href });
    // The row then shows the link, and no Decline button any more.
    const linked = render(createElement(ProposalItem, { p: asked({ agentRequest: requestFromRefusal(refused) }), onChange: () => {} }));
    expect(linked).toContain(`href="${href}"`);
    expect(linked).not.toContain('<button');
    // Any other failure names no request: the row stays as it is.
    expect(requestFromRefusal(new ApiError(409, 'Proposal is already rejected.', 'CONFLICT'))).toBeNull();
    expect(requestFromRefusal(new ApiError(403, 'Not one.', 'FORBIDDEN', { agentRequests: true, agentRequestId: null }))).toBeNull();
    expect(requestFromRefusal(new Error('offline'))).toBeNull();
  });

  describe('clicking Decline', () => {
    const leftover = () => asked({ agentRequest: null });
    const refusedWith = (status: number, code: string, details: unknown) => async () => {
      throw new ApiError(status, status === 409 ? 'Proposal is already rejected.' : 'An agent asked for this, so it is approved or denied in Agent requests.', code, details);
    };

    it('declined: the row the server answers, settled, and gone from the waiting list', async () => {
      const calls: Array<[string, unknown]> = [];
      const r = await declineAgentProposal(leftover(), async (url, body) => {
        calls.push([url, body]);
        return { proposal: asked({ status: 'rejected', agentRequest: null }) };
      });
      expect(calls).toEqual([['/api/ai/proposals/agent-1', { action: 'reject' }]]);
      expect(r).toMatchObject({ ok: true, message: 'Declined. Nothing was entered.', shown: { id: 'agent-1', status: 'rejected' } });
      expect(updatePending([own(), leftover()], r.shown!).map((x) => x.id)).toEqual(['own-1']);
    });

    it('in Agent requests after all and still waiting there: the row shows the link, not the button', async () => {
      const href = `/agent-requests?id=${REQUEST_ID}`;
      const now = asked({ agentRequest: { id: REQUEST_ID, status: 'pending', href } });
      const r = await declineAgentProposal(leftover(), refusedWith(403, 'FORBIDDEN', { agentRequests: true, agentRequestId: REQUEST_ID, href, proposal: now }));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Agent requests/);
      expect(r.shown).toEqual(now);
      const pending = updatePending([leftover()], r.shown!);
      const html = render(createElement(WaitingProposals, { pending, onChange: () => {} }));
      expect(html).toContain(`href="${href}"`);
      expect(html).not.toContain('<button');
      expect(textOf(html)).toContain('Waiting in Agent requests');
    });

    it('in Agent requests after all and already denied there: it no longer reads as waiting', async () => {
      const now = asked({ status: 'rejected', error: null, agentRequest: { id: REQUEST_ID, status: 'denied', href: `/agent-requests?id=${REQUEST_ID}` } });
      const r = await declineAgentProposal(leftover(), refusedWith(403, 'FORBIDDEN', { agentRequests: true, agentRequestId: REQUEST_ID, proposal: now }));
      expect(r.shown).toEqual(now);
      expect(updatePending([own(), leftover()], r.shown!).map((x) => x.id)).toEqual(['own-1']);
      const text = textOf(render(createElement(AgentRequestRow, { p: r.shown!, onChange: () => {} })));
      expect(text).toContain('Denied');
      expect(text).not.toContain('Waiting in Agent requests');
      expect(text).not.toContain('Decline');
    });

    it('declined by someone else first (a conflict): settled, its Decline button gone', async () => {
      const now = asked({ status: 'rejected', error: null, agentRequest: null });
      const r = await declineAgentProposal(leftover(), refusedWith(409, 'CONFLICT', { agentRequests: true, agentRequestId: null, proposal: now }));
      expect(r).toMatchObject({ ok: false, message: 'Proposal is already rejected.' });
      expect(r.shown).toEqual(now);
      expect(updatePending([leftover()], r.shown!)).toEqual([]);
      expect(render(createElement(AgentRequestRow, { p: r.shown!, onChange: () => {} }))).not.toContain('<button');
    });

    it('a refusal without the row still links a named request; anything else leaves the row as it is', async () => {
      const r = await declineAgentProposal(leftover(), refusedWith(403, 'FORBIDDEN', { agentRequests: true, agentRequestId: REQUEST_ID }));
      expect(r.shown).toMatchObject({ id: 'agent-1', agentRequest: { id: REQUEST_ID, href: `/agent-requests?id=${REQUEST_ID}` } });
      // Not taken from the refusal: another proposal, the app's own kind, or something that is not a row.
      for (const proposal of [asked({ id: 'agent-2', status: 'rejected' }), own({ id: 'agent-1' }), { id: 'agent-1' }, 'agent-1']) {
        expect(shownAfterRefusal(leftover(), new ApiError(409, 'Proposal is already rejected.', 'CONFLICT', { proposal }))).toBeNull();
      }
      const offline = await declineAgentProposal(leftover(), async () => {
        throw new TypeError('Failed to fetch');
      });
      expect(offline).toEqual({ shown: null, message: 'It could not be declined. Try again.', ok: false });
    });
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
