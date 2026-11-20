# Agent access

Ironbooks can let an AI agent read a company's books, the way you would add a bookkeeper: with a
name and a role. The agent connects through the Ironbooks app running on your own computer. It
looks at lists, registers, transactions and reports, and it cannot change anything.

This guide covers what an agent can and cannot do, how to make one, and how to connect Claude
Code or Claude Desktop to it. (It is a guide for people who use agents with their books. It is not
instructions for coding agents working on this repository.)

## What it is

- **Off until you turn it on.** A company file with no agents behaves exactly as it always has.
  Nothing new listens on the network, and nothing is written outside the company file.
- **One agent, one company, one role.** An Admin makes each agent under **Users & Roles >
  Agents**, gives it the same kind of role a person has, and can remove it at any time.
- **Read only in this version.** An agent has a mode (Read only, Propose or Post). Propose and
  Post are saved for when entering transactions is added; until then every agent only reads.
- **This computer only.** An agent works on the computer that holds the company file, while the
  file is open in Ironbooks and someone has signed in. It does not work over multi-user hosting,
  from a web page, or in a practice copy.
- **Named in the records.** The audit trail and the transaction log record an agent's work under
  its own name, not under a person's.

### What an agent can never do

Whatever role you give it, an agent:

- is never an Admin, and never reaches Users & Roles, backups, restore or other file utilities;
- never sees full Social Security numbers or full bank account numbers;
- never gets past the closing date;
- cannot change settings that decide where this computer connects (AI servers, the mail server,
  Privacy & Network);
- cannot sign in, has no password, and takes no user seat.

### What it can read

A connected agent gets these tools. Each one only reads.

| Tool | What it answers |
| --- | --- |
| `get_company_info` | Which company this is, fiscal year, report basis, home currency, closing date, today's date there, and the agent's own role |
| `list_accounts` | The chart of accounts, with balances |
| `list_customers`, `list_vendors` | Customers and vendors, with what is owed |
| `list_items`, `list_classes`, `list_employees` | Items, classes and employees |
| `list_other` | Terms, payment methods, sales tax codes and items, other names, and the other small lists |
| `search` | Quick search across names and documents |
| `find_transactions` | Transactions by type, name, account, dates, amount, number, memo or cleared status |
| `get_register` | An account's register: each transaction, the running balance, cleared or reconciled |
| `get_journal_entry` | Every debit and credit line behind one transaction |
| `report_profit_and_loss`, `report_balance_sheet`, `report_trial_balance`, `report_general_ledger`, `report_ar_aging`, `report_ap_aging` | The core reports, with dates, basis, comparisons and filters |

What an agent sees follows its role. A role that cannot see payroll gets no employee list; a role
without View Balance gets balances left blank.

### A note on privacy

What an agent reads is sent to the AI service that runs the agent, as it is. Ironbooks' own cloud
AI replaces names and identifiers before anything is sent; an outside agent reads the real thing.
If you run the agent on a model on your own computer or network, nothing leaves. Choose the role
with that in mind. See [`PRIVACY.md`](./PRIVACY.md).

## Make an agent

On the computer that holds the company file, signed in as an Admin:

1. Open **Users & Roles** and choose the **Agents** tab.
2. Choose **New agent**. Give it a name (it appears in the audit trail), pick a role, and pick what
   it may do.
3. Ironbooks shows the agent's **access token once**. Copy it, or copy the ready-made settings
   for Claude Code or Claude Desktop shown under it. Ironbooks stores only a scrambled form of the
   token and cannot show it again. If it is lost, remove the agent and make a new one.

Keep the token like a password. It works only on the computer where it was made.

To take an agent's access away, choose **Remove** next to it. It stops working with its next
request. Restoring a backup also removes every agent's access, so make them again afterwards.

Preferences > Integrated Applications > *Don't allow any applications to access this company
file* stops all agents at once.

## Connect an agent

The connector is a small program that ships with Ironbooks (the `mcp` folder). Your AI client
starts it and talks to it directly; it opens no port. It needs one thing from you: the token.

The **Agents** tab shows the exact command for your computer when you make an agent. The examples
below show the shape, with `<your token>` where the token goes.

### Claude Code

Installed app (Windows; Ironbooks installs under your own user folder, so put your Windows user name
in place of `<you>`):

```bash
claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=<your token> --env ELECTRON_RUN_AS_NODE=1 -- "C:\Users\<you>\AppData\Local\Programs\Ironbooks\Ironbooks.exe" "C:\Users\<you>\AppData\Local\Programs\Ironbooks\resources\mcp\ironbooks-mcp.mjs"
```

Source checkout (with `npm run dev` or the desktop app running):

```bash
claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=<your token> -- node /path/to/ironbooks/mcp/ironbooks-mcp.mjs
```

### Claude Desktop

Add this to Claude Desktop's configuration file (Settings > Developer > Edit Config), then restart
Claude Desktop:

```json
{
  "mcpServers": {
    "ironbooks": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Ironbooks\\Ironbooks.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs"],
      "env": {
        "IRONBOOKS_AGENT_TOKEN": "<your token>",
        "ELECTRON_RUN_AS_NODE": "1"
      }
    }
  }
}
```

From a source checkout, use `"command": "node"` and the path to `mcp/ironbooks-mcp.mjs`, and
leave out `ELECTRON_RUN_AS_NODE`.

### Other clients

Any client that can start a Model Context Protocol server over stdio works the same way: run
`ironbooks-mcp.mjs` with Node 18 or newer (or with the installed app's own program, as above) and
give it the token. An agent that runs on a model on your own computer keeps everything on it.

### Keeping the token out of a shared file

Instead of `IRONBOOKS_AGENT_TOKEN`, you can save the token in a file only you can read and point
the connector at it with `IRONBOOKS_AGENT_TOKEN_FILE=<path to that file>`.

## If it does not connect

| The agent says | What to do |
| --- | --- |
| Ironbooks is not ready for this agent | Open the company file in Ironbooks on this computer and sign in. The agent works while the file is open and someone has signed in during that run of the app |
| Ironbooks did not accept this agent | The agent was removed, a backup was restored, or the token was made on another computer or for another company file. Make a new agent |
| This connector has no access token | The token is missing from the client's settings |
| This is not available to agents | The agent asked for something outside its tools |
| You do not have permission to view … | The agent's role does not include that area. An Admin can make an agent with a different role |
| Applications are not allowed to access this company file | Preferences > Integrated Applications has the master switch on |

The portable version of Ironbooks (the single `.exe` that needs no install) unpacks itself to a
different folder on every start, so use the installed version or a source checkout with agents.

## How it is kept safe

For readers who want the mechanics. The code is in `lib/agentContext.ts`,
`lib/permissions/agentAccess.ts`, `lib/services/agents.ts`, `lib/db/readOnly.ts`,
`lib/agent/endpointFile.ts` and `mcp/`.

- An agent presents its token in an `Authorization` header. The app's own window never sends
  one, so any request that carries one is treated as a program outside Ironbooks: it gets the same
  lower trust as another computer, and it is never treated as the app itself.
- Such a request never uses a sign-in cookie that came along with it. It is the agent, held to the
  agent's rules, or it is refused.
- An agent may call only a fixed list of read routes. Each request is then checked against the
  same permission map as a person with the agent's role.
- The agent's connection to the books can only read: the database refuses a write made through
  it, whatever asks.
- The connector finds the running app through a small file Ironbooks writes in your own profile
  folder while the company file has an agent and is open. Before the connector sends its token, the
  app has to prove it is the Ironbooks that wrote that file. The connector only ever connects to
  this computer.
- The token is stored as a keyed digest tied to this computer and this company file. A copy of the
  file, or a file someone sends you, carries no agent that works.

To report a security problem, see [`SECURITY.md`](./SECURITY.md).

## What is planned

Later versions add tools that enter transactions (with a dry run, protection against entering
the same thing twice, and an approval queue for Propose mode), bank statement import and
reconciling, and working while the app is closed, as an explicit permission.
