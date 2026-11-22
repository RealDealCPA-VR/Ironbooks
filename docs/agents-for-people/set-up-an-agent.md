# How do I let an AI agent work in my books?

<!--
  Knowledge base article, written on goal/agentaccess, where lib/kb does not exist yet.
  At the merge with main, add it to lib/kb/articles.ts (area 'ai', id 'set-up-an-agent') with the
  fields below, then run `npm run docs`. Buttons and headings are quoted as the screens show them
  (app/users/page.tsx, app/users/AgentsTab.tsx, app/users/agents/*).
-->

- **id:** `set-up-an-agent`
- **area:** `ai` (AI & automation)
- **go:** [Users & Roles](/users)

**Summary.** An Admin adds the agent in Users & Roles > Agents, the way you would add a bookkeeper:
a name, a role and what it may do without asking. Ironbooks then shows the agent's access token
once, with the settings to paste into Claude Code or Claude Desktop.

## Steps

1. On the computer that holds the company file, open Users & Roles and click the Agents tab.
   ([Users & Roles](/users))
2. Click "New agent". Give it a Name: it is shown in the audit trail next to everything the agent
   does.
3. Tick a Role. The agent sees what a person with that role sees and can never ask for more.
   Choose the smallest role that does the job.
4. Under "What it may do without asking", keep "Ask for every change" unless you have a reason to
   change it: the agent then looks and prepares drafts by itself, and every change to the books
   waits for a person to say yes.
5. Leave "May work while nobody is signed in" off unless the agent must work when nobody is at the
   computer. Click "Make agent".
6. Copy what the next window shows: the Access token, and the line for Claude Code or the block for
   Claude Desktop. The token is shown only now. Keep it like a password, then click "I have copied
   it".
7. Paste the settings into Claude Code or Claude Desktop on this computer. The agent works while the
   company file is open in Ironbooks here and someone has signed in (unless you let it work while
   nobody is signed in). What it asks for waits in Agent requests.
   ([Agent requests](/agent-requests))
8. To change what it may do later, click the agent in the list: "What it may do", "Limits",
   "Standing permissions" and "Activity". "Pause this agent" stops it at once; Remove takes its
   access away for good.

## Good to know

- Only an Admin can add or remove an agent, or let one do more by itself (a looser preset, Allow,
  a higher limit or another folder). Anyone who may see Users & Roles > Users sees the Agents tab,
  and whoever may change users can make an agent stricter, pause it, or Revoke standing permission
  it was given.
- An agent never changes its own settings or another agent's, and never approves its own requests.
  No agent may change or delete a role an agent holds.
- With the Admin role an agent can ask for Admin work: users and roles, backups, restoring, the
  company file and passwords. It can ask only if its settings say Ask for that work ("Ask for every
  change" keeps it on Never), and only an Admin can approve those requests. Everything else it does
  follows its settings like any agent's: under "Trusted bookkeeper" or "Full, with asks" it enters
  and changes records with nobody asked. Choose the Admin role only if the agent needs Admin work.
- What an agent reads is sent to the AI service that runs it, as it is. With an AI model on your
  own computer or network, nothing leaves.
- Full Social Security and account numbers are never shown to an agent unless a person approves
  that one request. The Audit Trail says which kinds of numbers were shown, to which agent, and who
  approved it; it does not keep the numbers.
- A lost token cannot be shown again: remove the agent and make a new one. An Admin can stop every
  agent at once with "Pause all agents" on the Agents tab (in the desktop app, also at the top of
  the window).

## Other ways people ask

- connect claude to my books
- add an ai agent
- let an agent do my bookkeeping
- make an agent
- agent access token
- connect claude desktop to ironbooks
- what can an agent do on its own

**Keywords:** agent ai assistant claude code claude desktop token role preset ask for every change
users roles connect mcp
