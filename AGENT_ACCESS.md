# Agent access

Ironbooks can let an AI agent work in a company's books, the way you would add a bookkeeper: with
a name and a role. The agent connects through the Ironbooks app running on your own computer. It
can look things up and run reports, and, if you allow it, enter transactions, bring in bank
statement lines and reconcile.

This guide covers what an agent can and cannot do, how to make one, and how to connect Claude
Code or Claude Desktop to it. (It is a guide for people who use agents with their books. It is not
instructions for coding agents working on this repository.)

## What it is

- **Off until you turn it on.** A company file with no agents behaves exactly as it always has.
  Nothing new listens on the network, and nothing is written outside the company file.
- **One agent, one company, one role.** An Admin makes each agent under **Users & Roles >
  Agents**, gives it the same kind of role a person has, and can remove it at any time.
- **You choose how far it may go.** Read only, Propose or Post (below).
- **This computer only.** An agent works on the computer that holds the company file, while the
  file is open in Ironbooks and someone has signed in. It does not work over multi-user hosting,
  from a web page, or in a practice copy. (Working while Ironbooks is closed is a separate switch,
  off unless you tick it. See [While Ironbooks is closed](#while-ironbooks-is-closed).)
- **Named in the records.** The audit trail and the transaction log record an agent's work under
  its own name, not under a person's. A transaction an agent proposed and a person approved shows
  both: "*name* (agent), approved by *person*".

### What it may do: Read only, Propose, Post

| Mode | What the agent does |
| --- | --- |
| **Read only** | Looks at lists, registers, transactions and reports. Changes nothing. |
| **Propose** | Drafts transactions. Each one is checked the way it would be when entered, then waits under **Ask AI > Waiting for your approval** until a person approves or dismisses it. Nothing reaches the books before that. |
| **Post** | Enters, edits and voids transactions itself, within its role. |

Two things a Propose agent does without waiting, because neither changes the books: it brings bank
statement lines into the bank feed, and it ticks off items in a reconciliation it started.
Categorizing a line, matching one, and finishing a reconciliation are changes, so they wait for
approval.

In every mode:

- **The role still decides.** An agent in Post mode with a role that cannot enter bills cannot
  enter bills.
- **The closing date holds.** An agent never enters, edits or voids anything on or before it.
- **Void, never delete.** An agent can void a transaction. It cannot delete one.
- **A dry run first, when it wants one.** Every tool that changes something takes `dry_run`: the
  agent gets back exactly what would be entered, and nothing is kept.
- **Nothing is entered twice.** Every change carries a `request_id` the agent chooses. Asking
  again with the same one, after a dropped connection for example, returns the first answer
  instead of entering it a second time.
- **Someone else changed it first?** An edit names the version of the record the agent looked at.
  If a person changed it since, the edit is refused and the agent looks again.

### What an agent can never do

Whatever role and mode you give it, an agent:

- is never an Admin, and never reaches Users & Roles, backups, restore or other file utilities;
- never sees full Social Security numbers or full bank account numbers;
- never gets past the closing date;
- never deletes a transaction, and never forces a reconciliation that does not come to 0.00;
- cannot change settings that decide where this computer connects (AI servers, the mail server,
  Privacy & Network);
- cannot sign in, has no password, and takes no user seat.

### The tools

A connected agent gets these tools. What it sees and may do follows its role: a role that cannot
see payroll gets no employee list, and a role without View Balance gets balances left blank.

**Looking things up** (every mode)

| Tool | What it answers |
| --- | --- |
| `get_company_info` | Which company this is, fiscal year, report basis, home currency, closing date, today's date there, and the agent's own role and mode |
| `list_accounts` | The chart of accounts, with balances |
| `list_customers`, `list_vendors` | Customers and vendors, with what is owed |
| `list_items`, `list_classes`, `list_employees` | Items, classes and employees |
| `list_other` | Terms, payment methods, sales tax codes and items, other names, and the other small lists |
| `search` | Quick search across names and documents |
| `find_transactions` | Transactions by type, name, account, dates, amount, number, memo or cleared status |
| `get_register` | An account's register: each transaction, the running balance, cleared or reconciled |
| `get_journal_entry` | Every debit and credit line behind one transaction |
| `get_transaction` | One invoice, bill, payment, check, deposit, transfer or other document, in full |
| `list_invoices`, `list_bills` | Open or all invoices and bills |
| `undeposited_funds` | Payments received and waiting to be deposited |
| `list_my_proposals` | What this agent has proposed, and what became of each |
| `report_profit_and_loss`, `report_balance_sheet`, `report_trial_balance`, `report_general_ledger`, `report_ar_aging`, `report_ap_aging` | The core reports, with dates, basis, comparisons and filters |

**Entering and changing** (Propose: waits for approval. Post: entered.)

| Tool | What it does |
| --- | --- |
| `enter_journal_entry` | A general journal entry |
| `enter_invoice`, `enter_sales_receipt`, `receive_payment` | Sales: an invoice, a cash sale, a customer payment applied to invoices |
| `enter_bill`, `pay_bills`, `write_check` | Purchases: a bill, bill payments, a check or other expense |
| `make_deposit`, `transfer_funds` | Banking: a deposit (from undeposited funds or direct), a transfer between accounts |
| `add_customer`, `add_vendor`, `add_account`, `add_item`, `add_class` | New list entries |
| `edit_transaction`, `void_transaction` | Change or void one transaction |
| `edit_list_entry`, `deactivate_list_entry` | Change a customer, vendor, account or item, or make one inactive |

**Bank statements and reconciling**

| Tool | What it does |
| --- | --- |
| `list_bank_accounts`, `get_bank_feed` | The bank and card accounts, and the statement lines waiting in each, with suggested matches |
| `import_statement_lines` | Brings statement lines into the bank feed (from a CSV, OFX or QFX file's text). Nothing is entered in the books by importing |
| `categorize_bank_line`, `match_bank_line`, `unmatch_bank_line`, `exclude_bank_line` | Turn a statement line into a transaction, tie it to one already entered, undo that, or set a line aside |
| `reconcile_status`, `get_reconciliation` | Where each account stands, and one reconciliation with what is cleared and the difference |
| `start_reconciliation`, `mark_cleared`, `update_reconciliation_statement` | Begin a reconciliation from the statement's ending balance and date, tick items off, correct the statement figures |
| `add_statement_adjustments` | Enter the bank's service charge or interest from the statement |
| `finish_reconciliation` | Finish, only when the difference is 0.00 |
| `cancel_reconciliation`, `undo_last_reconciliation` | Leave one unfinished, or undo the last finished one |

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

A good way to start: make the agent **Propose** with the Bookkeeper role, approve what it drafts
for a while, and move to **Post** when you trust its work.

To take an agent's access away, choose **Remove** next to it. It stops working with its next
request. What it entered stays, under its name. Restoring a backup also removes every agent's
access, so make them again afterwards.

Preferences > Integrated Applications > *Don't allow any applications to access this company
file* stops all agents at once.

## Approving what an agent proposes

Open **Ask AI**. Under **Waiting for your approval**, each proposal says which agent made it, what
it would enter, and its lines. **Approve** enters it, checked again at that moment against your
own permissions and the closing date, and records it as the agent's work approved by you.
**Dismiss** drops it. The agent can see what became of its proposals and does not enter anything
you dismissed.

## While Ironbooks is closed

Off unless you tick **May work while nobody is signed in** when you make the agent.

With it on, when the agent needs the books and Ironbooks is closed, Ironbooks opens the company
file by itself, with no window, for as long as the agent is working. Then it saves, closes the
file and quits (after about ten quiet minutes).

- **People come first.** Start Ironbooks while it is running for an agent and you simply get its
  window and sign in as usual. Another computer that asks for the company file gets it at once:
  the hidden Ironbooks saves, closes the file and steps aside.
- **It never asks a question.** If opening the company file would need a decision (the file
  moved, it is open on another computer, there is unsaved work to sort out), it closes again and
  the agent is told to wait for a person.
- **Never past a password.** A company file protected with passwords, or one with a file
  password, is opened only by a person's sign-in. The switch does nothing for such a file.
- **Nothing else starts.** While nobody is there, no recurring transactions are entered, no
  scheduled reports are sent, multi-user hosting is not started and no update is installed. Those
  wait for a person.
- **Same rules as always.** The agent's role, mode, the closing date and everything under "What an
  agent can never do" apply exactly as when you are there.

The company file's lock shows "an agent (no one is signed in)" to anyone who looks from another
computer.

This needs the installed app. From a source checkout an agent with the switch works while the app
is open at its sign-in screen, but the app is not started for it.

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

For an agent that may work while nobody is signed in, the settings the Agents tab gives you have
one more line, `IRONBOOKS_AGENT_START=1`. It lets the connector start Ironbooks when it is closed.
Without that line the connector never starts anything.

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
| Ironbooks is closed and did not open the company file for this agent | The agent is not allowed to work while nobody is signed in, the company file has passwords, or opening it needs a person. Open Ironbooks and sign in |
| Ironbooks did not accept this agent | The agent was removed, a backup was restored, or the token was made on another computer or for another company file. Make a new agent |
| This connector has no access token | The token is missing from the client's settings |
| This is not available to agents | The agent asked for something outside its tools |
| This agent can only read | The agent is in Read only mode. An Admin makes one that may Propose or Post |
| You do not have permission to … | The agent's role does not include that. An Admin can make an agent with a different role |
| … is on or before the closing date | The date is in a closed period. A person with the right to do so can enter it |
| Ironbooks did not answer. If this was a change, ask again with the SAME request_id | The connection dropped. Asking again with the same `request_id` settles it without entering anything twice |
| Applications are not allowed to access this company file | Preferences > Integrated Applications has the master switch on |

The portable version of Ironbooks (the single `.exe` that needs no install) unpacks itself to a
different folder on every start, so use the installed version or a source checkout with agents.

## How it is kept safe

For readers who want the mechanics. The code is in `lib/agentContext.ts`,
`lib/permissions/agentAccess.ts`, `lib/services/agents.ts`, `lib/db/readOnly.ts`,
`lib/agent/` (the action runner, the tools' actions, the endpoint file), `electron/agentService.js`
and `mcp/`.

- An agent presents its token in an `Authorization` header. The app's own window never sends
  one, so any request that carries one is treated as a program outside Ironbooks: it gets the same
  lower trust as another computer, and it is never treated as the app itself.
- Such a request never uses a sign-in cookie that came along with it. It is the agent, held to the
  agent's rules, or it is refused.
- An agent may call only a fixed list of read routes, plus one route for actions. Each request is
  checked against the same permission map as a person with the agent's role.
- The agent's own connection to the books can only read: the database refuses a write made
  through it, whatever asks. A change happens only through the action runner, which checks the
  mode, the role and the action's own rules, and then runs the same code a person's entry runs,
  for that one action.
- A dry run runs the real entry inside a transaction that is always undone, so what it reports is
  what would happen, and nothing is kept.
- The connector finds the running app through a small file Ironbooks writes in your own profile
  folder while the company file has an agent and is open. Before the connector sends its token, the
  app has to prove it is the Ironbooks that wrote that file. The connector only ever connects to
  this computer.
- The token is stored as a keyed digest tied to this computer and this company file. A copy of the
  file, or a file someone sends you, carries no agent that works.
- Started for an agent, Ironbooks takes the same company-file lock and uses the same working copy
  as any start. There is never a second program writing to the books.

To report a security problem, see [`SECURITY.md`](./SECURITY.md).
