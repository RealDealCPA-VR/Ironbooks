# How do I approve or deny what an agent asks to do?

<!--
  Knowledge base article, written on goal/agentaccess, where lib/kb does not exist yet.
  At the merge with main, add it to lib/kb/articles.ts (area 'ai', id 'approve-agent-requests')
  with the fields below, then run `npm run docs`. Buttons and headings are quoted as the screens
  show them (app/agent-requests/page.tsx, RequestCard.tsx, ApproveSimilar.tsx).
-->

- **id:** `approve-agent-requests`
- **area:** `ai` (AI & automation)
- **go:** [Agent requests](/agent-requests)

**Summary.** An agent asks before it does anything its settings do not let it do alone. Its
requests wait in Agent requests: open one, check what Ironbooks worked out it would do, then
choose "Approve once", "Approve similar…" or "Deny…".

## Steps

1. When an agent asks, a number shows on "Agent requests" in the left menu (in the desktop app,
   also at the top of the window). If the desktop app is minimized or behind other windows, a
   desktop notice says an agent asks for your approval, usually with the agent's name and what it
   asks; click it. ([Agent requests](/agent-requests))
2. Click Open on a request. The card shows the agent's reason in quotes (its own words, which
   Ironbooks has not checked) and what Ironbooks worked out the request would do: the entries it
   would post, what it would change, any email, file or printing, and any warnings.
3. If it is right, click "Approve once". Ironbooks does it now, with your access, says Done. and
   offers "Open the entry it posted".
4. To let the agent do requests like this one by itself for a while, click "Approve similar…".
   Choose "For how long" and the limits under "Only when", such as "The amount is at or below",
   then click "Approve this and similar".
5. If it is not right, click "Deny…". Write a "Note for the agent (optional)" if you like, then
   click "Deny request". Nothing is done.
6. Several new entries or changes of the same kind can be approved together: tick them in the
   list, click "Approve chosen (…)…", check the list it shows, and click "Approve all …". Each one
   is checked and reported on its own.

## Good to know

- "The books changed since the agent asked" means someone changed a record the request uses after
  the agent asked. The card shows what would happen now. Click "Approve what would happen now"
  only if that is still right. Work elsewhere in the books, or the next invoice or check number,
  does not count.
- Standing permission ("Approve similar…") lasts until the end of the day at most, and at most
  30 minutes for emails and printing; for emails only an Admin can give it. It is never given, not
  even by an Admin, for deleting, closed periods, settings, users, the company file, passwords,
  showing full Social Security or account numbers, or anything approved only at the host
  computer: those are asked one request at a time.
- Some requests need an Admin, a second person or a password. The card says so. A password you
  type on the card goes to Ironbooks only, never to the agent.
- An agent sees full Social Security or account numbers only through a request a person approves.
  It can read that answer again for 15 minutes; after that it is masked for good. What an agent
  reads is sent to the AI service that runs it. The Audit Trail says which kinds of numbers were
  shown, to which agent, and who approved it; it does not keep the numbers.
- Whoever manages users can stop one agent with "Pause this agent", or take back standing
  permission with Revoke, in Users & Roles > Agents. An Admin can stop every agent at once with
  "Pause all agents" on the Agents tab (in the desktop app, also at the top of the window).
- Everything an agent did or asked is kept: see the Audit Trail, or Reports > Accountant & Taxes >
  Agent Activity.

## Other ways people ask

- approve an agent request
- the agent is waiting for my approval
- deny what the agent asked
- what does the books changed mean
- give the agent permission for the rest of the day
- take back standing permission
- stop an agent
- agent notice

**Keywords:** agent requests approve deny standing permission similar batch notice badge stale
pause revoke ai assistant claude
