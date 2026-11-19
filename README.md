<div align="center">

# 📒 Ironbooks

### QuickBooks Desktop Enterprise power. Your machine. Your AI. No subscription.

**The desktop accounting system you own outright. Open source, signed, and built on a ledger
that the database itself refuses to let go out of balance.**

![license](https://img.shields.io/badge/license-MIT-green)
![tests](https://img.shields.io/badge/tests-9%2C100%2B%20passing-brightgreen)
![typecheck](https://img.shields.io/badge/tsc-clean-blue)
![signed](https://img.shields.io/badge/Windows%20installer-signed-success)
![local-first](https://img.shields.io/badge/data-100%25%20local-success)
![AI](https://img.shields.io/badge/AI-local%20first-purple)
![stack](https://img.shields.io/badge/Next.js%2015%20%C2%B7%20Electron%20%C2%B7%20Postgres-black)

**[⬇ Download for Windows](https://github.com/RealDealCPA-VR/Ironbooks/releases/latest)** · [Website](https://realdealcpa-vr.github.io/Ironbooks/)

[Why](#-why-ironbooks) · [Features](#-everything-a-real-set-of-books-needs) · [The company file](#-a-company-file-that-works-like-a-qbw) · [Switching from QuickBooks](#-switching-from-quickbooks) · [AI](#-ai-that-stays-home) · [Security](#-security-you-never-notice) · [Quick start](#-quick-start) · [Code signing policy](#-code-signing-policy)

</div>

---

Your accounting software raised its price again. Your client's books live on a server you have
never seen. The desktop product you trained your whole staff on is being retired one edition at
a time.

**Ironbooks is the way out.** Install it, open a company file, and work the way you already know:
registers you type into, the same keyboard shortcuts, the same Centers, the same reports. Nothing
to rent, no account to create, and nothing leaves your computer unless you switch it on.

## 💡 Why Ironbooks

- 🔒 **You own the books.** The company file is one file on your disk, like a .QBW. No account, no
  telemetry, no lock-in. Copy it, back it up, hand it to your accountant.
- ⚖️ **Out-of-balance books are impossible, not just unlikely.** The ledger rules run as
  **database triggers**. An unbalanced entry, a hand-edited balance or a change to a posted line
  is rejected at commit, whatever code path tries it.
- 🤖 **AI that works for you, on your hardware.** Local models categorize, suggest entries and
  catch mistakes. Cloud AI is opt-in, and listed names and identifiers are replaced before
  anything is sent.
- 🧾 **Built by working through QuickBooks Desktop Enterprise screen by screen**, from account
  types to the Accountant Center. If your bookkeeper knows QuickBooks, they already know
  Ironbooks.
- 💸 **Free. Really.** MIT licensed. No seats, no tiers, no renewal date.

## 🆚 At a glance

| | QuickBooks Desktop Enterprise | Cloud accounting | **Ironbooks** |
|---|:---:|:---:|:---:|
| Data stays on your machine | ✅ | ❌ | ✅ |
| No subscription | ❌ | ❌ | ✅ |
| Open source | ❌ | ❌ | ✅ |
| Ledger balance enforced by the database | ❌ | ❓ | ✅ |
| AI on your own hardware | ❌ | ❌ | ✅ |
| Tamper-evident transaction log | ➖ (TLG) | ❌ | ✅ |
| Imports a QuickBooks General Ledger from **PDF**, Excel or CSV | ❌ | ➖ | ✅ |
| Multi-user | ✅ | ✅ | ✅ (office network or your tailnet) |
| Works with no internet at all | ✅ | ❌ | ✅ |

## 🚀 Everything a real set of books needs

<table>
<tr><td width="50%" valign="top">

### 🧱 Rock-solid ledger
- Every QuickBooks account type, sub-accounts, tax lines
- A/R and A/P control accounts **always tie to aging**
- Names on every A/R and A/P line, as in QuickBooks
- Closing date + password, audit trail, integrity check
- Decimal money everywhere, with no floating-point drift

### 💼 Sales & A/R
Estimates → sales orders → invoices with **retainage**, alphanumeric numbers
and shipping · sales receipts · credit memos & refunds · Receive Payments with
discounts & credits · bounced checks · statements · batch invoicing ·
**Income Tracker** · **Collections Center**

### 🧾 Purchases & A/P
POs · item receipts · bills · Pay Bills with discount & due-date filters ·
checks & card charges with items · **check print queue with printer
alignment** · vendor credits · **Loan Manager** · multi-currency

### 🏦 Banking
**Registers you type into** on any account · statement **PDF / scan / Excel**
import with tie-out · OFX / QBO / CSV with rules · reconciliation · deposits &
transfers · no bank connection, ever

</td><td width="50%" valign="top">

### 📦 Inventory
FIFO & average cost · assemblies · landed cost · sites & transfers ·
units of measure · reorder points · **Inventory Center**

### 👥 Payroll (after-the-fact)
Social Security wage base & withholding **by year** · mid-year YTD setup ·
paycheck edits · state unemployment · workers' comp · 941 / 940 / W-2 data

### 🧮 Accountant toolbox
**Accountant Center** · Working Trial Balance · Reclassify · Write Off
Invoices · **Batch Enter** · Batch Delete/Void · Client Data Review ·
Fix Incorrectly Recorded Sales Tax · sales tax that **ties to the GL by agency** ·
**Accountant's Copy** with a dividing date · **Period Copy** for audits

### 📊 Reports
QuickBooks-style P&L sections & sub-account roll-ups · the standard report set ·
**QuickZoom** drill-down · filters · memorized report groups · scheduled
exports · graphs · pivot builder · multi-company · budgets & forecasts ·
Advanced Find

### ⚙️ Make it yours
Preferences · form templates (logo, colors, fields) · memorized
transactions · reminders · calendar · Lead Center · Doc Center · letters & labels

</td></tr>
</table>

## ✨ Fast where it counts

**Type it, don't hunt for it**
- **Ctrl+K command bar that understands plain English.** "invoice Acme 3 hours consulting",
  "show unpaid bills over 60 days", "what did we spend on fuel in Q3?". Forms open prefilled for
  you to confirm, and nothing is saved without you.
- **QuickBooks' keys, all of them.** Ctrl+W Write Checks, Ctrl+I Invoice, Ctrl+J Customer Center,
  Ctrl+A Chart of Accounts, Ctrl+R Register, Ctrl+F Find, Ctrl+M memorize, Alt+S Save & New, the
  date keys (+ − T W K M H Y R), and lists you drive with arrows and type-ahead. Press `?` to see
  every shortcut.
- **Registers on every account.** Type a row, press Enter, and it saves as the right check,
  deposit, transfer, card charge or journal entry. A new payee asks "Customer, Vendor, Employee
  or Other?" on the spot.
- **Enter many transactions at once** in a grid, with paste from Excel.

**It tells you what needs you**
- **Needs attention home.** One prioritized list: bank lines to categorize, overdue invoices,
  bills due, reconciliations behind, payroll deposits, flagged errors and stale backups. Fix each
  one where it is listed.
- **Errors with Fix buttons.** "Debits are $40 more than credits. Add $40 to line 3?"
- **Every report number explains itself.** Hover to see what it is made of, click to drill down,
  and read a one-line summary at the top. **"Why did this number change?"** answers the question
  every owner asks.
- **Undo for 30 seconds** after any save, void or delete.

**The busywork does itself**
- **Bank statements without a bank connection.** Import a statement PDF (scans and photos go
  through offline OCR), an Excel file or a CSV. Every row is checked against the statement's
  opening and closing balances before anything is imported.
- **Bank rules that learn.** Categorize the same payee twice and Ironbooks offers a rule.
  Suggestions show their confidence, and high-confidence ones can be accepted in bulk.
- **Receipt capture.** Drop a photo or PDF anywhere, or upload it from your phone over your
  tailnet. Offline OCR fills in the expense.
- **Smart defaults.** The last account, class, terms and items per vendor or customer, the next
  check number, the last date you used.
- **Guided month-end close.** A checklist, then the closing date, then a PDF report pack.

**Details people notice**
- **Checks on any pre-cut stock.** Voucher, standard 3-per-page or wallet, the check at the top,
  middle or bottom of the sheet, every field position adjustable.
- **Light, dark or auto, with your accent color.** A clean look with a themed window and the
  menus in the title bar. Printed forms always print on white.
- **Sandbox.** "Try it on a copy" for practice and training. Your real books are never touched.
- **Backups you can see.** "Last backup 2 hours ago ✓", scheduled versioned backups, a preview
  before restoring, and a warning after 7 days without one.

## 🗄️ A company file that works like a .QBW

- **One file, wherever you want it.** `ABC Company.ironbooks` on this computer, a USB drive or the
  office file server. Double-click to open it.
- **Built for a shared drive.** While someone is in the file it is locked, and anyone else who
  opens it sees who has it and on which computer. They can **ask to come in**, and the person in
  the file chooses **Let Them In** (multi-user mode, each person with their own user name),
  **Hand It Over** or **Not Now**.
- **Saved as you go, never half-written.** Every change lands in the company file seconds after
  you make it, with a new copy swapped in all at once, so a dropped connection or a power cut
  cannot leave a damaged file. Unsaved work on a computer that crashed is recovered the next time
  the file opens there.
- **Passwords belong to the file.** Each person signs in with their own user name and password
  every time it opens. Users, roles and permissions travel inside the file, so a copy is just as
  protected.
- **A running transaction log** inside the file records every change, tamper-evident, like
  QuickBooks' TLG.
- **Easy to share.** Save Copy As, a portable copy (like a .QBM), or an Excel/PDF ledger for your
  accountant.
- **Backups that restore in full**, an automatic backup before risky operations, and **Condense
  Data** that writes a restorable archive first.

## 🔄 Switching from QuickBooks

Bring your history with you:

1. **Import your General Ledger** from a QuickBooks GL report in **PDF, Excel or CSV**. It
   reconciles to the penny against the trial balance *before* anything is committed.
2. **Import your lists via IIF**: the account hierarchy, every item type, and customer, vendor
   and employee details.
3. **Import open invoices and bills as real documents**, then receive payments and pay bills on
   day one. A/R and A/P still tie to the imported GL.

Want out again? Lists and transactions export to **IIF, CSV and Excel**. No hostage data.

## 🤖 AI that stays home

| Where the model runs | Default? | What leaves the machine |
|---|:---:|---|
| This computer (Ollama, LM Studio, any OpenAI-compatible server) | ✅ | Nothing |
| Your LAN or **Tailscale tailnet** | ✅ | Nothing beyond your own network |
| A cloud provider | Opt-in per company | Only the prompt, with **SSNs, TINs and account numbers redacted** |

**Bring your own AI. No API key needed.** Company > AI & Automation offers two choices up front:

- **Set up free AI on this computer.** One click on Windows: Ironbooks downloads Ollama's
  official installer (and runs it only if it is signed by Ollama), downloads a starter model and
  connects it. On macOS and Linux it opens Ollama's download page and carries on once Ollama is
  running. LM Studio works too. Nothing leaves your PC.
- **Continue with ChatGPT.** Sign in with your ChatGPT Plus or Pro plan in your browser.
  Ironbooks uses your plan's included usage: no API key and no extra bill. Ironbooks never sees
  your password.

Use both and the local model answers first, with ChatGPT taking over when it cannot. Other
services (Anthropic, Google Gemini, Groq, OpenRouter, Mistral, xAI, DeepSeek, Azure OpenAI, any
OpenAI-compatible server) are available with an API key, billed by the service per use.

The AI learns your categorization, suggests journal entries for **your approval**, picks an
account for a payee it has never seen and says why, and reviews the books for unbalanced,
duplicate or miscategorized entries. It only ever suggests. [`PRIVACY.md`](./PRIVACY.md) lists
exactly what can leave the machine and the switch for each.

## 🛡️ Security you never notice

Protection that works without prompts, pop-ups or extra passwords:

- **Signed by its publisher.** The Windows installer and the app carry the signature of
  **RealDealCPA.Ai LLC**, issued through Microsoft's signing service, and installed copies accept
  only updates signed by that same publisher.
- **Nothing listens to the outside world.** The app talks only to itself on your computer. The
  one exception is multi-user mode, which you turn on, and which serves only your office network
  or tailnet over an encrypted connection.
- **One guard on the way out.** Every network call passes a single policy check. Update checks
  (version and platform only) are the one connection on by default, and you can turn them off.
- **A file password encrypts the whole company file** (AES-256), with a recovery key for the day
  someone forgets.
- **Saved keys stay yours.** AI keys and the mail password are never stored in plain text.
- **A company file from someone else is treated as a guest.** Its internet settings stay off on
  your computer until an Admin there allows them.
- **Roles and permissions on everything**, a closing date with its own password, and an audit
  trail of who changed what.

Found a weakness? Please report it privately: [`SECURITY.md`](./SECURITY.md).

## ⚡ Quick start

**Just want to use it?** [Download the Windows installer](https://github.com/RealDealCPA-VR/Ironbooks/releases/latest)
(`Ironbooks-Setup-x.y.z.exe`, or the portable `Ironbooks-x.y.z.exe` that needs no install). It
updates itself, and asks before it does. More in [`INSTALL.md`](./INSTALL.md).

**Build it yourself** (also the route for macOS and Linux today):

```bash
npm install --legacy-peer-deps

npm run dev            # web/dev mode → http://localhost:3000
npm run electron:dev   # desktop shell (with `npm run dev` running in another terminal)
npm run desktop:dist   # build installers for Windows / macOS / Linux
```

More: [`GETTING_STARTED.md`](./GETTING_STARTED.md) · [`DESKTOP.md`](./DESKTOP.md) ·
[`RELEASING.md`](./RELEASING.md) (tag-triggered releases)

## 🧪 Tested like the money matters

```bash
npm test          # 850 files · 9,100+ tests: unit, integration, adversarial
npm run typecheck # tsc --noEmit
npm run build     # Next standalone production build
```

Every feature area was built by a **doer**, attacked by an **independent adversarial tester** and
signed off by a **reviewer**. The tests check that the trial balance and balance sheet stay
balanced and each subledger matches its control account after every operation. They also cover
closing-date rules, permissions, rollback and hostile files. End-to-end tests drive the packaged
app itself, single-user and multi-user. On a busy machine, run `npx vitest run --maxWorkers=3`.

## 🏗 Under the hood

```
Electron shell ──► Next.js 15 (React 19 UI + API routes) ──► lib/services/* (accounting engine) ──► PGlite
 native menus,                                                 posting, documents, reports,          embedded Postgres,
 the company file                                              payroll, import/export, AI            ledger rules as triggers
```

```
electron/            Desktop shell (main process + preload bridge)
lib/services/        Accounting engine (posting.ts is the only way to touch the ledger)
lib/db/              Drizzle schema + PGlite client
lib/ai/              AI router: local / tailnet / cloud + redaction
lib/permissions/     Roles, areas, route → permission map
lib/net/guard.ts     Network policy (the only way out)
lib/money.ts         Decimal-safe money
app/                 Pages + API routes (app/api/*)
drizzle/             Hand-written SQL migrations
PARITY.md            QuickBooks Desktop Enterprise parity matrix
```

### 🤝 Contributing
- Work on `main` and keep branches short-lived.
- **Never write account balances directly.** Post through `lib/services/posting.ts`; the database
  will reject anything else.
- Map every new API route in `lib/permissions/routes.ts`. A test fails if you forget.
- Write migrations by hand as the next `drizzle/00NN_*.sql` plus a `_journal.json` entry. Don't
  run drizzle-kit generate.

## 📜 License

[MIT](./LICENSE). Use it, fork it, ship it.

## 🔏 Code signing policy

From version 1.7.19, the Windows installer, the portable build and the app itself are signed by
**RealDealCPA.Ai LLC**. The certificate is issued by Microsoft through **Azure Artifact Signing**
(formerly Trusted Signing) after Microsoft verified the company's identity. Windows shows that
name as the publisher when you download or install Ironbooks.

- **Built in the open.** Every release is built from this repository by GitHub Actions
  ([`release.yml`](./.github/workflows/release.yml)) when a maintainer pushes a version tag, and
  signed during that build. No release file is built or signed on a personal computer.
- **Updates check the publisher.** An installed copy accepts an update only if it is signed by
  the same publisher.
- **Earlier releases.** Versions up to and including 1.7.18 were published unsigned; Windows may
  show "Windows protected your PC" for those.
- **A new publisher earns trust over time.** Windows SmartScreen also weighs how many people have
  downloaded a publisher's files, so it can still show its warning for the first downloads of a
  signed release. Check that the publisher reads **RealDealCPA.Ai LLC**, then choose
  **More info → Run anyway**.
- **Check it yourself.** Right-click the downloaded file → Properties → Digital Signatures, or in
  PowerShell: `Get-AuthenticodeSignature .\Ironbooks-Setup-x.y.z.exe`.

How signing is set up: [`SIGNING.md`](./SIGNING.md).

| Role | Members |
| --- | --- |
| Committers and reviewers | [@RealDealCPA-VR](https://github.com/RealDealCPA-VR) |
| Approvers | [@RealDealCPA-VR](https://github.com/RealDealCPA-VR) |

**Privacy:** Ironbooks does not send information to other networked systems unless you, the
user, turn that feature on. Update checks (app version and platform only) are the one
connection on by default, and you can turn them off in Privacy & Network. The full list of
what can leave your computer, and the switch for each, is in [`PRIVACY.md`](./PRIVACY.md).

**Security:** please report a vulnerability privately, as described in
[`SECURITY.md`](./SECURITY.md), not in a public issue.

## ⚠️ Disclaimer

Accounting, tax and payroll features (including tax tables and wage bases) are provided as-is.
Verify them against current regulations before filing. This is open-source software, not
professional accounting advice.
