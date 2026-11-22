# Agent access

Ironbooks can let an AI agent work in a company's books, the way you would let in a new
bookkeeper: with a name, a role, and rules about what it may do on its own. The agent connects
through the Ironbooks app on your own computer. It can look things up and run reports. Anything
you have not allowed it to do on its own, it asks for. A person sees exactly what would happen and
says yes or no in Ironbooks, and nothing happens before that yes.

This guide is for the people who use agents with their books. It covers what an agent is, how to
make and connect one, what it does on its own and what it asks for, how to answer it, what it can
never do, and how to stop it. Near the end there is a part for people who write agents, and the
mechanics for engineers. (It is not instructions for coding agents working on this repository.)

## Contents

- [What an agent is](#what-an-agent-is)
- [Make an agent](#make-an-agent)
- [Connect an agent](#connect-an-agent)
- [What an agent may do](#what-an-agent-may-do)
- [Answering an agent: Agent requests](#answering-an-agent-agent-requests)
- [Standing permission](#standing-permission)
- [What an agent can never do](#what-an-agent-can-never-do)
- [Full Social Security and account numbers (reveals)](#full-social-security-and-account-numbers-reveals)
- [Pausing and removing an agent](#pausing-and-removing-an-agent)
- [What is recorded, and where to read it](#what-is-recorded-and-where-to-read-it)
- [While Ironbooks is closed](#while-ironbooks-is-closed)
- [If it does not connect, or the agent is refused](#if-it-does-not-connect-or-the-agent-is-refused)
- [Words that changed](#words-that-changed)
- [Full access: for people who write agents](#full-access-for-people-who-write-agents)
- [How it is kept safe](#how-it-is-kept-safe)

## What an agent is

- **Off until you turn it on.** A company file with no agents behaves exactly as it always has.
  Nothing new listens on the network, and nothing is written outside the company file.
- **One agent, one company, one role.** An Admin makes each agent under **Users & Roles >
  Agents**. It gets the same kind of role a person has, and the role is the most it can ever ask
  for. An agent is not a user: it cannot sign in, has no password and takes no user seat.
- **Rules for asking.** For each kind of work, the agent's settings say whether it does it by
  itself (**Allow**), asks a person first (**Ask**), or is refused (**Never**). You start from one
  of four presets and adjust from there.
- **A person says yes.** What it must ask for waits under **Agent requests**, with a preview of
  exactly what would happen. Nothing reaches the books before a person approves it.
- **This computer only.** An agent works on the computer that holds the company file, while the
  file is open in Ironbooks and someone has signed in. It does not work through multi-user hosting,
  from a web page, or in a practice copy. (Working while Ironbooks is closed is a separate switch,
  off unless you tick it. See [While Ironbooks is closed](#while-ironbooks-is-closed).)
- **Named in the records.** The audit trail and the transaction log record an agent's work under
  its own name: "*name* (agent)", "*name* (agent), approved by *person*", or "*name* (agent),
  under permission from *person* until *time*".

## Make an agent

On the computer that holds the company file, signed in as an Admin:

1. Open **Users & Roles** and choose the **Agents** tab.
2. Choose **New agent**. Give it a name (it appears in the audit trail), pick a role, pick **What
   it may do without asking** (a preset: "Ask for every change" unless you choose another), and
   choose **When it may work**.
3. Ironbooks shows the agent's **access token once**, with the ready-made settings for Claude Code
   and Claude Desktop. Copy them. Ironbooks keeps only a scrambled form of the token and cannot
   show it again. If it is lost, remove the agent and make a new one.

Keep the token like a password. It works only on this computer, for this company file.

**Choose the smallest role and the strictest preset that do the job.** Anyone who gets hold of
the token can ask for everything the role allows. A person still has to say yes to whatever the
preset makes the agent ask for, but the role decides what can be asked at all.

**The Admin role.** An agent may be given the Admin role. It can then ask for anything an Admin
can do: users and roles, backups, restoring, the company file and passwords. Every one of those
requests still needs a person to say yes, and only an Admin can approve them. Choose it only if
the agent needs that work.

**A good start:** the Bookkeeper role and "Ask for every change". Approve what it asks for a
while, then let it do more by itself, area by area, once you trust its work.

Open an agent from the list to see and change its settings. Its page has four parts:

| Part | What it holds |
| --- | --- |
| **What it may do** | The preset, and Allow / Ask / Never for each kind of work, **Everywhere** or **By area** (for example "Allow entry in Banking, Ask in Payroll"). A locked choice cannot be made for an agent. |
| **Limits** | Most records one request may change; two people approve above an amount; days a request waits for an answer; folders it may read from or save to; an email notice when it asks while nobody is signed in. |
| **Standing permissions** | What people gave while approving, with **Revoke**. |
| **Activity** | Its last 200 operations and requests, newest first. |

At the top: **Pause this agent** (or **Resume**) and **Remove**.

**Who may change what.** The Agents tab is shown to anyone who may view Users & Roles > Users.
Only an Admin makes or removes an agent, or lets one do more by itself (a looser preset, Allow
or Ask where it is stricter now, a higher limit, a folder outside the ones it has, a higher
two-person amount, a longer wait, the email notice). Anyone who may change Users & Roles > Users
can make an agent stricter, pause it, give it a folder inside one it already has, and take back
its standing permissions. Making, changing and removing agents happen only on the computer that
holds the company file; from another computer the tab lists them, and an agent can be paused
there.

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

The portable version of Ironbooks (the single `.exe` that needs no install) unpacks itself to a
different folder on every start, so use the installed version or a source checkout with agents.

## What an agent may do

### The role comes first

The role is the most the agent can ever do or ask for. A request outside the role is refused, not
turned into a question: asking for something you deliberately left out of the role would invite
approving it anyway. The agent is told which right is missing and to ask an Admin to change its
role.

Full Social Security numbers, full account numbers and work on or before the closing date also
need the matching right in the role. Even then the agent never does them by itself: it asks, one
request at a time.

### The fourteen kinds of work and the four presets

Every operation in Ironbooks belongs to one kind of work. The preset sets each kind to **Allow**
(does it by itself), **Ask** (waits for a person) or **Never** (refused, nobody is asked).

| Kind of work | What it covers | Read only | Ask for every change | Trusted bookkeeper | Full, with asks |
| --- | --- | --- | --- | --- | --- |
| Read | Lists, registers, transactions and reports | Allow | Allow | Allow | Allow |
| Read protected data | Full Social Security numbers, full account numbers, payroll detail | Never | Ask | Ask | Ask |
| Prepare work | Work a person can throw away: drafts, notes, to-dos, starting a reconciliation, bringing statement lines into the bank feed | Never | Allow | Allow | Allow |
| Enter new | New transactions and list entries: invoices, bills, estimates, customers, items | Never | Ask | Allow | Allow |
| Change or void | Edit or void what is there, apply credits, tick and finish a reconciliation | Never | Ask | Allow | Allow |
| Change many at once | One request that changes many records: batch invoicing, merging, accepting many bank lines | Never | Ask | Ask | Allow, at most 200 records a request |
| Delete for good | Deleting, or anything else that cannot be undone | Never | Ask | Ask | Ask |
| Closed-period work | Entering or changing on or before the closing date, or moving the closing date | Never | Ask | Ask | Ask |
| Send outside this computer | Emailing forms, statements and reports, the app's own AI services, downloading updates | Never | Ask | Ask | Ask |
| Print | Checks, forms and labels on a real printer | Never | Ask | Ask | Ask |
| Company settings | Preferences, templates, numbering, sales tax, payroll, email and AI settings | Never | Ask | Ask | Ask |
| Users and security | Users, roles, password rules, file protection, who is signed in | Never | Never | Never | Ask |
| Company file | Back up, restore, copy, open, switch or close the company file, hosting | Never | Never | Ask | Ask |
| Passwords and keys | Work that needs or shows a password or key | Never | Never | Never | Ask |

What each kind allows beyond the preset:

| Kind of work | Can it be set to Allow? | Standing permission | Who can approve |
| --- | --- | --- | --- |
| Read | Yes | Not needed | Nobody is asked |
| Read protected data | No | No: one request at a time | Someone whose role has the matching View right |
| Prepare work, Enter new, Change or void | Yes | Until the end of the day at most | Someone whose role allows the work |
| Change many at once | Yes, with a limit on records per request | Until the end of the day, always with a records limit | Someone whose role allows the work |
| Delete for good | No | No | Someone whose role allows the work |
| Closed-period work | No | No | Someone with the closed-period right, who types the closing-date password if one is set |
| Send outside this computer | No | 30 minutes at most, given only by an Admin | Someone whose role allows the work |
| Print | No | 30 minutes at most | Someone whose role allows the work |
| Company settings | No | No | Someone whose role allows it; settings that decide where this computer connects only at this computer |
| Users and security | No | No | An Admin |
| Company file | No | No | An Admin (an Admin of every company in the file for whole-file work); desktop actions only at this computer |
| Passwords and keys | No | No | An Admin, who types or sees the secret on their own screen |

The person who approves must be allowed to do the work themselves. The approved run uses the
approver's access and the agent's role together, so approving never gives either one more than it
had.

### When one request counts as stricter work

A request is judged as the strictest of everything it falls under:

- dated on or before the closing date: **Closed-period work**;
- asking to see full values: **Read protected data** (see [reveals](#full-social-security-and-account-numbers-reveals));
- sent again with a "yes, I am sure" flag after a warning (a duplicate number, for example): one
  step stricter, so a new entry counts as a change; editing a reconciled entry or rewriting the
  ledger counts as closed-period work;
- for work that changes many records, the records limit holds for every request that reports a
  count, under Allow and under standing permission alike. Above it the agent is told to split the
  work.

### Work that always asks

Some operations ask a person even where the preset says Allow, because they keep working after the
yes or pay someone. The main ones: paychecks and pay runs (writing, editing or voiding a check),
payroll adjustments (entering and voiding one), changing a payroll item (adding one follows the
preset), bank rules (adding, changing, reordering, running, taking an offered rule), accepting
many bank lines at once, memorized transactions (adding, changing, running, and memorizing one the
AI suggested), loading sample lines into a real bank feed, month-end close checklist steps, and
the accountant's list-changes and client data review. A report schedule an agent made or changed
is held until a person saves its email recipients on the Scheduled Reports page.

A read never creates anything on the way: where Ironbooks would make a default on first use (the
default inventory site, the default payroll items), an agent's read answers as if nothing exists
yet.

### Bank statements and reconciling

The banking tools follow the same rules as everything else:

- Bringing statement lines into the bank feed is **Prepare work**: it runs by itself under every
  preset but Read only. The lines only wait in the feed for review. An agent's import never posts
  anything, also when *Auto-categorize confident bank-feed transactions* is ticked in AI settings
  (a person's own import still posts those lines, as before). Lines that do not add up to the
  statement's balances are refused; bringing them in anyway (the agent says it is sure) counts as
  **Enter new**, so it asks under "Ask for every change". The records limit, where one is set,
  still holds for the number of lines.
- Posting the lines is its own step: categorizing or matching each line (**Enter new** and
  **Change or void**), or posting every line the AI is sure of in one go, which always asks (it
  counts as **Send outside this computer**, because it uses the app's AI services).
- Starting a reconciliation is **Prepare work** and runs by itself under every preset but Read
  only.
- Ticking items off, correcting the statement figures and finishing count as **Change or void**:
  they ask under "Ask for every change" and run under "Trusted bookkeeper". A reconciliation is
  finished only when the difference is 0.00.
- Cancelling a reconciliation and undoing the last one are **Delete for good**: they always ask.

### Limits

| Limit | What it does |
| --- | --- |
| Most records one request may change | The records limit above. "Full, with asks" comes with 200. |
| Two people approve above this amount | Off unless set. Above it, two different people must approve. Work that changes the books, or pays or posts money, whose amount Ironbooks cannot work out ahead of time counts as above it. With no amount set, one person approves such work, and the card says the amount is unknown. |
| Days a request waits for an answer | 7 unless set. After that the request expires and the agent is told. |
| Folders it may read from or save to | The only folders the agent may take files from on this computer (none unless an Admin adds them). Saving, which an Admin always approves, may also go to the company file's folder, `Documents\Ironbooks` and its `Agent Outbox`. A whole drive or share is never one of them. |
| Email notice | Off unless an Admin turns it on: an email to the Admins when the agent asks while nobody is signed in. |

## Answering an agent: Agent requests

### Where requests show up

- **Agent requests** in the left menu, under Needs attention. It appears once the company has an
  agent, with the number waiting for you.
- The **Agent requests** button in the window's title bar, with the same number.
- A desktop notice when an agent asks and the Ironbooks window is not in front. It names the agent
  and says what it asks in Ironbooks' own words. Clicking it opens Agent requests.
- **Ask AI** lists agents' requests under "Asked by agents" with **Open in Agent requests**. It no
  longer approves them.

### The list

Each row shows the agent, what the request would do, its kind of work, the amount, how long it has
waited, what approving it needs ("Needs an Admin", "Needs a password", "Needs two people", "Only
at the host computer" and the like), a mark when it needs a yes again, and its status. You can
filter by agent, kind of work, area and status.

- What the request would do is written by Ironbooks from the operation and a trial run, never from
  the agent's own text.
- "Amount unknown" means Ironbooks could not work the amount out ahead of time. A standing
  permission's amount limit never covers it, and the two-person amount treats it as above it for
  work that changes the books or pays or posts money.
- Rows you cannot approve stay in the list, greyed, with the reason.

### The card

Open a row to see its card:

1. **Who asked and why.** The agent's reason, in quotes under "The agent says". These are the
   agent's words, not facts: text written by outsiders (a vendor name, a memo, an emailed PDF) can
   reach an agent and steer it.
2. **What Ironbooks worked out it would do,** from a trial run that was rolled back:
   - the ledger entries it would post;
   - the record changes, each field before and after;
   - what would leave this computer: each email with every recipient and their domain in full, the
     subject and attachments, files it would save and where, the printer;
   - for a desktop action, the files and computers it touches, with whole paths;
   - the warnings the app would have asked a person about in the window;
   - for a delete, what would be lost.
   Some work cannot be tried ahead (company file work, outside-only work, closed-period work that
   needs a password). Its card describes it and says it was not tried.
3. **Who can approve** and what the approval needs: an Admin, a View right, the closed-period
   right, two people, the host computer, a password typed in a box on the card, and for a desktop
   action the questions its window would have asked.
4. **Approve once**, **Approve similar…** (standing permission, below) and **Deny**, with a note
   the agent reads.

**Where you can approve.** Only from a person's Ironbooks window: the window on the computer that
holds the company file, or a teammate's Ironbooks through multi-user hosting. Work that decides
where this computer connects, and every desktop action, is approved only at the computer that holds
the company file. Another program on this computer is refused, even with a person's sign-in, and so
is anything that carries an agent's token. A paused agent's requests cannot be approved until it is
resumed.

**The books changed.** Ironbooks tries the work again just before it runs it. If a record the
request reads or changes was changed since the agent asked, nothing runs. The card shows "The books
changed since the agent asked. This is what would happen now." with the new preview, and the button
becomes **Approve what would happen now**. You approve again on what you now see. What the run
assigns to itself does not count as a change: the next invoice, check or entry number, the next
place in a list (a new bank rule goes to the top; a new account without a number gets the next
free one), records it makes itself, and times. So two waiting requests that each take "the next
number" do not make each other stale, and a posting elsewhere that touches none of the request's
records leaves it as it was.

**Sent back with a note.** An approval can also send a request back before it runs (it turned out
to be dated in a closed period, it needs a second person, or it shows more once protected values
are revealed). The card says so, and the next **Approve again** is your yes to what it now says.

**Two people.** Above the agent's two-person amount, the first yes leaves the request "Waiting for a
second person". A different person must approve it. Standing permission never stands in for the
second person, and such requests are left out of approving several at once.

**Typed passwords.** Some work needs a secret: the closing-date password, the company file
password, a backup file's password, the sign-in for a protected backup, a new user's password, the
email server password, the employee portal password. The person who approves types it on the card.
It goes with that one approval, is never stored, never shown to the agent, and the box empties at
once. An agent that sends one itself has it taken out. A wrong password ends that request: nothing
changes, the request shows as failed and the agent is told. It asks again, and you type the right
password on the new card. A wrong closing-date password counts as one guess toward the same limit
as in the window. When work produces a secret (a recovery key, a sharing link),
the approver sees it once on the card, and the agent reads only "Shown to the person who approved".
To add a user, the approving Admin types the new user's password on the card; nothing is produced
for that request, and the agent never learns the password.

**Approving several at once.** Tick requests of the same operation, then **Approve chosen…**. Only
new entries and changes that Ironbooks could try ahead of time and that one person may approve
alone, up to 100 at a time. The confirmation lists every one, and each is approved and reported on
its own.

**When nobody answers.** A request waits (7 days unless the agent's limit says otherwise), then
expires; the agent is told. An agent can also take a request back ("Taken back by the agent").
Nothing is ever approved automatically, also when nobody is at the computer.

**Too many questions.** An agent that asks for approval more than 50 times in an hour is paused
until a person resumes it, so a flood of requests is never one click away.

## Standing permission

**Approve similar…** on a card lets the agent do more of the same operation without asking, within
limits you tick, until the time runs out:

- the same customers, vendors or other names;
- the same accounts;
- an amount at or below the one shown;
- dates within a range;
- a number of uses;
- for work that changes many records, a records limit per request (always set).

It lasts for the time you choose, until the end of the company's day at the latest, or 30 minutes
at most for sending and printing. It is never "always": changing what an agent may do for good is
done in the Agents tab. An agent can also ask ahead ("let me enter bills from these 12 vendors this afternoon"); that
arrives in Agent requests as a request for standing permission.

Its limits:

- **Not for every kind of work.** Never for protected data, deleting, closed-period work,
  settings, users and security, the company file, or passwords and keys.
- **Never for work approved only at the host computer, or only by an Admin of every company in
  the file**, Admins included. Such work is approved one request at a time.
- **Sending outside this computer:** only an Admin may give it, for 30 minutes at most.
- **It is the giver's to lend.** A run under standing permission uses the access of the person who
  gave it together with the agent's role. If that person leaves, is made inactive or loses the
  right, it stops covering anything and the agent asks again.
- **Only the same question.** A request that is stricter than the one you answered (a reveal, a
  "yes, I am sure" flag, a closed-period date), another operation, or anything outside the limits
  asks again.
- **Taken back at once.** The agent's **Standing permissions** list has **Revoke**. It is for the
  person who gave it or anyone who may change Users & Roles > Users. It does not count while the
  agent is paused.

Every grant given or taken back is in the audit trail under the person who did it, and every run
under one names it.

## What an agent can never do

Whatever its role and preset, with or without a person's yes, an agent can never:

- make, change, pause, resume or remove agents, change any agent's settings or standing
  permissions, or read the Agents tab's lists;
- approve, deny or answer any request, its own included, or decide the Ask AI assistant's
  proposals;
- change or delete a role that any agent holds (a paused agent still holds its roles, a removed one
  no longer does). It is refused on every path, and again at the moment a person approves; the agent
  is told which role and that an agent holds it. Standing permission for changing or deleting roles
  is never given, for any role;
- pause or resume all agents, or change the Integrated Applications switch (nor the employee
  portal or phone receipts switches, which only a person sets);
- see a password, key, token or one-time code, its own token included;
- sign in as a person, use a person's session, or work through multi-user hosting;
- work in a practice copy, or in a company file with passwords while nobody is signed in;
- turn off or edit the audit trail or the transaction log (neither has a switch or an edit screen,
  and the Rebuild Data repair that removes audit trail rows is refused to agents);
- download the raw transaction log file (it cannot be masked; it reads the masked log instead);
- use what is a person acting as themselves: sign-in, two-step sign-in, their own preferences, the
  ChatGPT sign-in, the list of company files they belong to.

The named tools never delete: they void. Deleting for good is a request like any other, of the kind
**Delete for good**, and always asks.

## Full Social Security and account numbers (reveals)

- **Masked by default.** In everything an agent reads, full Social Security numbers and tax IDs
  show as "\*\*\*-\*\*-6789" and bank and account numbers as "••••6789", also where a labelled
  number sits inside a memo ("Acct # ••••1234"). The text Ironbooks reads off a receipt is not given
  to an agent unless a reveal is approved. Masking finds numbers by their field and by their label:
  a number typed into a note with no label can still reach the agent.
- **One reveal at a time.** To see full values, the agent asks for a reveal. It is always a
  request, never covered by standing permission. The person who approves needs the matching View
  right ("View sensitive payroll data" for SSNs, "View full bank / account numbers" for account
  numbers). When Ironbooks cannot tell which kind of value it is, only an Admin can approve it.
- **It goes to the agent's AI service.** The card says so: what an agent reads is sent to the AI
  service that runs it, as it is. Ironbooks does not know which service that is.
- **Fifteen minutes.** After the approved run the agent can read that answer again for 15 minutes
  (waiting for the decision, listing its requests, or asking with the same request id). After that
  it is masked for good. The next read is masked again, and another reveal asks again.
- **Logged.** The audit trail and the Agent Activity report word it as: Revealed *which kinds of
  values* of "*record or report*" to agent "*name*", approved by *person*. The record is named by
  its own name where Ironbooks knows it, otherwise by the request's summary.

## Pausing and removing an agent

| To | Do this | Who |
| --- | --- | --- |
| Stop one agent for now | Its page > **Pause this agent**. Everything it asks is refused until someone resumes it. Its token, settings and standing permissions stay (they do not count while it is paused). | Anyone who may change Users & Roles > Users. Resuming an agent that holds the Admin role, or one with more access than you, needs an Admin. |
| Stop every agent at once | **Pause all agents** at the top of the Agents tab, and in the desktop window's title bar. It is the same switch as Preferences > Integrated Applications > *Don't allow any applications to access this company file*. Resuming asks first; an agent paused on its own stays paused. | An Admin |
| End an agent for good | **Remove** next to it, or on its page. It stops with its next request. What it did stays, under its name. | An Admin, on the computer that holds the company file |

Restoring a backup removes every agent's access and what they were waiting on, so make them again
afterwards. Ironbooks also slows an agent down by itself: more than 120 requests a minute, or more
than 4 at the same time, and it is told to wait.

## What is recorded, and where to read it

| Where | What you find |
| --- | --- |
| Audit Trail (left menu, under Admin) | Every change an agent made, under its name and how it was allowed (by itself, approved by a person, or under standing permission from a person until a time); every decision on a request, with the note; every standing permission given or taken back; every reveal. |
| Reports > Accountant & Taxes > Agent Activity | Every request an agent made for approval, who decided and what became of it. |
| Transaction log | The same names on each record. |
| Users & Roles > Agents > the agent > Activity | Its last 200 operations and requests, with who approved each. |
| Agent requests | Every request, waiting or settled: choose the status filter "All requests". |

Every request is kept, whatever became of it: waiting, done, did not go through, denied, expired
or taken back.

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
  password, is opened only by a person's sign-in. The switch is not offered for such a file.
- **Nothing else starts.** While nobody is there, no recurring transactions are entered, no
  scheduled reports are sent, multi-user hosting is not started and no update is installed. Those
  wait for a person.
- **What it asks for waits.** Nobody is there to approve, so its requests wait for a person.
  Nothing is approved automatically. If an Admin turned on the email notice, the Admins get a
  short email naming the agent and what it asks (at most one every ten minutes per agent, and only
  while nobody is signed in).
- **Same rules as always.** The agent's role, settings, the closing date and everything under
  [What an agent can never do](#what-an-agent-can-never-do) apply exactly as when you are there.

The company file's lock shows "an agent (no one is signed in)" to anyone who looks from another
computer.

This needs the installed app. From a source checkout an agent with the switch works while the app
is open at its sign-in screen, but the app is not started for it.

## If it does not connect, or the agent is refused

| The agent says | What to do |
| --- | --- |
| Ironbooks is not ready for this agent | Open the company file in Ironbooks on this computer and sign in. The agent works while the file is open and someone has signed in during that run of the app. |
| Ironbooks is closed and did not open the company file for this agent | The agent is not allowed to work while nobody is signed in, the company file has passwords, or opening it needs a person. Open Ironbooks and sign in. |
| Ironbooks did not accept this agent | The agent was removed, a backup was restored, or the token was made on another computer or for another company file. Make a new agent. |
| This connector has no access token | The token is missing from the client's settings. |
| This agent is paused | A person paused it. Resume it on its page in Users & Roles > Agents. |
| Applications are not allowed to access this company file | Every agent is paused (Pause all agents, which is Preferences > Integrated Applications). An Admin resumes them. |
| Your role does not allow this: it needs … | The agent's role does not include that. An Admin can change the agent's role. |
| An Admin has not allowed agents to … | That kind of work is set to Never for this agent. A person can do it, or an Admin can change the agent's settings. |
| Agents can never do this, even with a person's approval | It is on the list above. A person does it in Ironbooks. |
| Only a person can do this, signed in as themselves | It is a person's own action (signing in, their own preferences). |
| This would change … records, more than this agent may change in one request | Split the work, or an Admin raises the limit. |
| Agents do not work in a practice copy | Leave the practice copy first. |
| This agent has sent more than 120 requests in the last minute / already has 4 requests under way | Wait the time it says, then carry on. |
| This agent asked for approval more than 50 times in the last hour, so Ironbooks paused it | A person looks at what it asked, then resumes it. |
| Ironbooks did not answer. If this was a change, ask again with the SAME request_id | The connection dropped. Asking again with the same `request_id` settles it without doing anything twice. |

## Words that changed

Agents made before this version keep their setting, moved to the nearest preset when the company
file was first opened by this version. What changed is below.

| Before | Now |
| --- | --- |
| **Read only** | The preset **Read only**: reads, changes nothing, asks for nothing. |
| **Propose** | The preset **Ask for every change**: every kind of change asks, now including deleting, sending, printing and settings. Preparing work (drafts, starting a reconciliation, bringing statement lines into the feed) runs by itself. Ticking reconciliation items now asks. |
| **Post** | The preset **Trusted bookkeeper**: enters and edits by itself; changing many at once, deleting, closed periods, sending, printing, settings and company-file work ask. Bringing statement lines into the feed runs by itself and only stages them: an agent's import never posts lines on its own. |
| Proposals under **Ask AI > Waiting for your approval** | **Agent requests** (left menu, under Needs attention). Ask AI lists them under "Asked by agents" with a link, and approves only its own suggestions. Proposals waiting when the file was upgraded were copied into Agent requests. |
| `list_my_proposals` | `list_my_requests`. The old name still answers, with the same requests. |
| The answer "proposed" | "asked", with a `request_id` to wait on. "proposed" still comes back for an old proposal that was copied in. |
| "An agent is never an Admin" | An agent may hold the Admin role. What it reads directly is never read as an Admin, and every Admin-level request asks an Admin. |
| "Void, never delete" | The named tools still void. Deleting for good is now a request a person approves. |
| "Never past the closing date" | Work on or before the closing date is now closed-period work: it asks someone with that right, who types the closing-date password. |

## Full access: for people who write agents

### The tools

The connector offers 82 tools. Read its guide first: the resource `ironbooks://guide`, also the
prompt `ironbooks_guide`.

| Group | Tools |
| --- | --- |
| Start here | `get_company_info`, `get_my_permissions` (role, setting per kind of work and area, limits, folders, live standing permissions, whether someone is signed in) |
| Looking things up | `list_accounts`, `list_customers`, `list_vendors`, `list_items`, `list_classes`, `list_employees`, `list_other`, `search`, `find_transactions`, `get_register`, `get_journal_entry`, `get_transaction`, `list_invoices`, `list_bills`, `undeposited_funds` |
| Reports | `list_reports`, `run_report` (every standard report by its key), `report_drilldown`, `export_report`, and `report_profit_and_loss`, `report_balance_sheet`, `report_trial_balance`, `report_general_ledger`, `report_ar_aging`, `report_ap_aging` |
| Entering and changing | `enter_journal_entry`, `enter_invoice`, `enter_sales_receipt`, `receive_payment`, `enter_bill`, `pay_bills`, `write_check`, `make_deposit`, `transfer_funds`, `enter_estimate`, `convert_estimate`, `enter_purchase_order`, `receive_items`, `enter_credit_memo`, `enter_vendor_credit`, `enter_time`, `adjust_inventory`, `pay_sales_tax`, `add_customer`, `add_vendor`, `add_account`, `add_item`, `add_class`, `edit_transaction`, `void_transaction`, `edit_list_entry`, `deactivate_list_entry` |
| Bank statements and reconciling | `list_bank_accounts`, `get_bank_feed`, `import_statement_lines`, `categorize_bank_line`, `match_bank_line`, `unmatch_bank_line`, `exclude_bank_line`, `reconcile_status`, `get_reconciliation`, `start_reconciliation`, `mark_cleared`, `update_reconciliation_statement`, `add_statement_adjustments`, `finish_reconciliation`, `cancel_reconciliation`, `undo_last_reconciliation` |
| Everything else | `find_operations`, `describe_operation`, `run_operation`: every operation a person can do in Ironbooks has an id (about 800, `lib/agent/operations/operation-ids.txt`) |
| Requests | `wait_for_decision`, `list_my_requests` (`list_my_proposals` is its older name), `cancel_request`, `ask_for_permission` |
| Files | `upload_file`, `attach_local_file`, `get_file`, `save_file` |

### How a change goes

- **Look first.** `dry_run: true` really runs the change inside Ironbooks and rolls it back: you
  see what it would post, change or send, and whether the real one would run or ask. Nothing is
  kept.
- **`request_id`** is your own name for one change. Asking again with the same one gives the first
  answer and never does it twice: repeat with the SAME id after a timeout, use a NEW one for each
  new change.
- **`reason`** is one plain sentence a person reads on the approval card (at most 500 characters).
  It is required whenever the answer would be "asked"; without it nothing is put to a person.
- **Edits, voids and making inactive** send the `updated_at` you read as `expected_updated_at`
  (`run_operation` takes it too: the record's `updatedAt`, or `editedAt` for an account or an item,
  exactly as you read it). A conflict then means someone changed the record after you read it, and nothing was changed: read
  it again. A request that asks keeps that version and sends it with the approved run, so an
  approval never overwrites a change a person saved in between.
- **Answers:** `read`, `dry_run`, `posted` or `done` (it ran), `asked` (a person must approve:
  call `wait_for_decision` with its request id, at most 50 seconds a call, and do not send it
  again), `needs_confirmation` (a warning a person would have been asked about: resend with the
  flag in `confirm` only when going ahead is right), `refused` (stop; the note says what to do
  instead).
- **Email recipients are plain addresses only:** `billing@acme.com`, with one @ and a domain of
  letters, digits, dots and hyphens. No name, quotes, angle or square brackets, parentheses, spaces
  or backslashes, and one address in a field that takes one (no comma or semicolon). Anything else
  is refused before a person is asked: send just the address. A person's own email in Ironbooks
  keeps its usual rules.
- **Slow down.** Too many calls in the last minute, or too many under way, is answered HTTP 429
  with a Retry-After, and the connector says "Nothing was done. Wait *N* seconds, then send it
  again as it was". It is not a refusal of the work: wait, then send it again with the same
  `request_id`.
- **Never ask the person for a password, code or key, and never send one.** When an operation
  needs one, the person types it on their own screen.
- **Restarts.** Opening, switching or restoring a company file and installing an update restart
  Ironbooks. The answer says so; wait a minute, then read what you need again.

### Files

- `upload_file` hands Ironbooks a file you hold (base64, in parts of 4 MB, 50 MB at most). It
  comes back as a file id, which any operation that takes a file accepts as `{ "fileId": "<id>" }`.
- `attach_local_file` reads a file on this computer, but only inside a folder an Admin opened to the
  agent (`get_my_permissions` lists them), never inside Ironbooks' own folders, and never through a
  share of this very computer. Anywhere else it is refused before the file is opened.
- What an operation produces (a PDF, an export, a backup) is staged and returned as a file id;
  `get_file` gives you its content.
- `save_file` writes a staged file into the company file's folder, `Documents\Ironbooks`, its
  `Agent Outbox`, or a folder the Admin added. It is company-file work: an Admin approves it at the
  host computer, and it never replaces a file that is there.
- Staged files are kept outside the company file and removed after 24 hours, and when the file
  closes.

### Three worked examples

**1. An estimate, with "Ask for every change".**

1. `find_operations("estimate")` lists `estimates.create` and says this agent must ask.
2. `describe_operation("estimates.create")` gives the fields and how the policy treats it.
3. `run_operation("estimates.create", body, dry_run: true)` shows the estimate it would make;
   nothing is kept.
4. `run_operation("estimates.create", body, request_id: "est-acme-0301", reason: "Acme asked for a
   quote for March work.")` answers `asked`.
5. `wait_for_decision("est-acme-0301")` answers `pending` until a person approves on the card; then
   `approved`, with the estimate. The audit trail reads "*agent* (agent), approved by *person*".

**2. Closing March, with "Trusted bookkeeper".** The agent's role must be one that may change the
closing date (Admin or Accountant; Full Access may only view it, so with Full Access the close is
refused, not asked).

1. `get_my_permissions`: entering and changing run by itself; changing many at once, deleting,
   closed periods, sending, printing, settings and company-file work ask.
2. `import_statement_lines` for March runs (prepare work): the lines wait in the bank feed and
   nothing is posted. `categorize_bank_line` and `match_bank_line` for each line then run by
   themselves.
3. `run_operation("bank-rules.create", …)` for a vendor seen 12 times answers `asked`: bank rules
   keep posting later, so they always ask.
4. `start_reconciliation`, `mark_cleared`, `finish_reconciliation` (at a difference of 0.00) run.
5. `run_operation("month-end-close.scan", …)` runs (prepare work).
   `run_operation("month-end-close.close", …)` answers `asked` (closed-period work), with the
   reason "All 3 bank accounts reconciled to 0.00; the scan found nothing to fix."
6. `wait_for_decision`. The person approves; if a closing-date password is set, they type it on the
   card. The agent never sees it.
7. `run_report("profit-loss", …)` reads; the agent writes its summary.

**3. Month-end statements to 40 customers.**

1. `ask_for_permission("sales-forms.statement-email", constraints, minutes: 30, reason: "Month-end
   statements for the 40 customers with a balance.", request_id: …)` answers `asked`.
2. An Admin gives it (only an Admin may, for sending outside this computer, and for 30 minutes at
   most).
3. `run_operation("sales-forms.statement-email", …)` for each customer, each with its own
   `request_id`, runs under the permission: 40 emails, one audit row each naming it.
4. After the 30 minutes, the next one answers `asked` again.

## How it is kept safe

For readers who want the mechanics; [`ARCHITECTURE.md`](./ARCHITECTURE.md), section 15, has the
full path of a request.

- An agent presents its token in an `Authorization` header. The app's own window never sends one,
  so any request that carries one is treated as a program outside Ironbooks: it gets the same lower
  trust as another computer, and it is never treated as the app itself. A sign-in cookie that comes
  with it is never used.
- What an agent's own request may reach directly is narrow: its own requests, and reads the
  operation registry classes as plain reads outside Users & Roles and File Utilities. Those run on a
  read-only connection to the books, masked, never as an Admin. Everything else goes through one
  door, `POST /api/agent/actions`, where the policy decides. One exception, a known gap: the
  sign-in screen's public read of the company file (its name, its id, whether it has a password or
  protection) also answers an agent's token directly, with nobody asked. It never shows the folder
  the file is in. This lasts until that read refuses a request that carries a token.
- Every operation is the app's own route, run inside Ironbooks for the agent with the agent's
  access, so it meets exactly the checks a person's request meets. A dry run and the trial run behind
  every approval card run inside a database transaction that is always rolled back. Emails, saved
  files and print jobs are held until the real run has been saved, and never happen for a run that
  failed.
- An approval only ever comes from a signed-in person's window. Desktop actions (open, switch,
  Save Copy As, restore, hosting, printing, saving a file) go to the desktop app with a one-time
  ticket made for that one approved request, which the desktop app checks before it does anything.
- The connector finds the running app through a small file Ironbooks writes in your own profile
  folder while the company file has an agent and is open. Before the connector sends its token, the
  app has to prove it is the Ironbooks that wrote that file. The connector only ever connects to
  this computer.
- The token is stored as a keyed digest tied to this computer and this company file. A copy of the
  file, or a file someone sends you, carries no agent that works.
- Started for an agent, Ironbooks takes the same company-file lock and uses the same working copy
  as any start. There is never a second program writing to the books.

What leaves the computer when an agent is connected is in [`PRIVACY.md`](./PRIVACY.md). To report a
security problem, see [`SECURITY.md`](./SECURITY.md).
