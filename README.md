<div align="center">

# 📒 Ironbooks

### QuickBooks Desktop Enterprise power. Your machine. Your AI. No subscription.

**Open-source double-entry accounting for Windows, macOS and Linux. The database itself
refuses to let your books go out of balance.**

![license](https://img.shields.io/badge/license-MIT-green)
![tests](https://img.shields.io/badge/tests-3%2C965%20passing-brightgreen)
![typecheck](https://img.shields.io/badge/tsc-clean-blue)
![local-first](https://img.shields.io/badge/data-100%25%20local-success)
![AI](https://img.shields.io/badge/AI-local%20%2B%20tailnet%20first-purple)
![platforms](https://img.shields.io/badge/desktop-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![stack](https://img.shields.io/badge/Next.js%2015%20%C2%B7%20Electron%20%C2%B7%20Postgres-black)

[Download](https://github.com/RealDealCPA-VR/Ironbooks/releases/latest) · [Why](#-why-ironbooks) · [Features](#-what-you-get) · [Switching from QuickBooks](#-switching-from-quickbooks) · [AI](#-ai-that-stays-home) · [Quick start](#-quick-start) · [Roadmap](#-roadmap) · [Code signing policy](#-code-signing-policy)

</div>

---

## 💡 Why Ironbooks

QuickBooks Desktop runs on rising subscriptions and a shrinking product line. Cloud accounting
puts your clients' books on someone else's server. Ironbooks is the third option:

- 🔒 **Your books never leave your computer.** The company file is a folder you own. There's no
  account, no telemetry and no lock-in.
- ⚖️ **Unbalanced books are impossible, not just unlikely.** Ledger rules run as **database
  triggers**. An unbalanced entry, a hand-edited balance, or a change to a posted line is
  rejected at commit, whatever code path tries it.
- 🤖 **AI that works for you, on your hardware.** Local models on your PC or Tailscale tailnet do
  the categorizing, suggest entries and catch mistakes. Cloud AI is opt-in and redacted.
- 🧾 **Built by working through QuickBooks Desktop Enterprise screen by screen**, from account
  types to the Accountant Center. If your bookkeeper knows QB, they already know the workflow.

## 🆚 At a glance

| | QuickBooks Desktop Enterprise | Cloud accounting | **Ironbooks** |
|---|:---:|:---:|:---:|
| Data stays on your machine | ✅ | ❌ | ✅ |
| No subscription | ❌ | ❌ | ✅ |
| Open source | ❌ | ❌ | ✅ |
| Ledger balance enforced by the database | ❌ | ❓ | ✅ |
| AI on your own hardware | ❌ | ❌ | ✅ |
| Tamper-evident transaction log | ➖ (TLG) | ❌ | ✅ |
| Imports a QB General Ledger from **PDF**, Excel or CSV | ❌ | ➖ | ✅ |
| Multi-user | ✅ | ✅ | ✅ (over your tailnet) |

## 🚀 What you get

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
OFX / QBO / CSV import with rules · optional bank feeds · reconciliation ·
deposits & transfers

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
Fix Incorrectly Recorded Sales Tax · sales tax that **ties to the GL by agency**

### 📊 Reports
QB-style P&L sections & sub-account roll-ups · the standard report set ·
**QuickZoom** drill-down · filters · memorized report groups · scheduled
exports · graphs · pivot builder · multi-company · budgets & forecasts ·
Advanced Find

### ⚙️ Make it yours
QB-style Preferences · form templates (logo, colors, fields) · memorized
transactions · reminders · calendar · Lead Center · Doc Center · letters & labels

</td></tr>
</table>

### ✨ Built to feel effortless
- **Ctrl+K command bar that understands plain English.** Type "invoice Acme 3 hours consulting",
  "show unpaid bills over 60 days" or "what did we spend on fuel in Q3?". Forms open prefilled
  for you to confirm, and nothing is saved without you.
- **Needs attention** home. One prioritized list: bank lines to categorize, overdue invoices,
  bills due, reconciliations behind, payroll deposits, AI-flagged errors and stale backups. Fix
  each one where it is listed.
- **Undo for 30 seconds** after any save, void or delete, and **"Why did this number change?"**
  on report totals and balances.
- **Bank rules that learn.** Categorize the same payee twice and Ironbooks offers a rule.
  Suggestions show their confidence, and high-confidence ones can be accepted in bulk.
- **Every report number explains itself.** Hover to see what it's made of, click to drill down,
  and read a one-line summary at the top.
- **Smart defaults:** last account, class, terms and items per vendor or customer, the next check
  number, and the last date you used.
- **Errors with Fix buttons:** "Debits are $40 more than credits. Add $40 to line 3?"
- **Keyboard first:** shortcuts everywhere (press `?`), and **Enter many transactions** at once in
  a grid with paste from Excel.
- **Receipt capture:** drop a photo or PDF anywhere, or upload it from your phone over your
  tailnet. **Offline OCR** fills in the expense.
- **Guided month-end close:** a checklist, then set the closing date, then download a PDF report
  pack.
- **Backups you can see:** "Last backup 2 hours ago ✓", scheduled versioned backups, a preview
  before restoring, and a warning after 7 days without one.
- **Sandbox:** "Try it on a copy" for practice and training. Your real books are never touched.
- **Accountant's Copy** with a dividing date, and **Period Copy** for audits.
- **Checks on any pre-cut stock:** voucher, standard 3-per-page or wallet, the check at the top,
  middle or bottom of the sheet, and every field position adjustable.

### 🗄️ A company file you can trust
- **Running transaction log** inside the file records every change, tamper-evident, like QB's TLG.
- **Shareable**: a single-file portable copy, or an Excel/PDF ledger for your accountant.
- **Backups that restore in full**, an automatic backup before risky operations, and **Condense
  Data** that writes a restorable archive first.
- **Per-company users, roles and permissions.** Multi-user hosting is limited to your Tailscale
  tailnet.

## 🔄 Switching from QuickBooks

Bring your history with you:

1. **Import your General Ledger** from a QuickBooks GL report in **PDF, Excel or CSV**. It reconciles
   to the penny against the trial balance *before* anything is committed.
2. **Import your lists via IIF**: the account hierarchy, every item type, and customer, vendor and
   employee details.
3. **Import open invoices and bills as real documents**, then receive payments and pay bills on day
   one. A/R and A/P still tie to the imported GL.

Want out again? Lists and transactions export to **IIF, CSV and Excel**.

## 🤖 AI that stays home

| Where the model runs | Default? | What leaves the machine |
|---|:---:|---|
| This computer (Ollama, LM Studio, any OpenAI-compatible server) | ✅ | Nothing |
| Your LAN or **Tailscale tailnet** | ✅ | Nothing beyond your own network |
| A cloud provider (e.g. Claude) | Opt-in per company | Only the prompt, with **SSNs, TINs and account numbers redacted** |

The AI learns your categorization the way QuickBooks does, suggests journal entries for **your
approval**, and reviews the books for unbalanced, duplicate or miscategorized entries and
outliers. Every network call goes through one policy guard. [`PRIVACY.md`](./PRIVACY.md) lists
exactly what can leave the machine, and it's never your books.

## ⚡ Quick start

```bash
npm install --legacy-peer-deps

npm run dev            # web/dev mode → http://localhost:3000
npm run electron:dev   # desktop shell (with `npm run dev` running in another terminal)
npm run desktop:dist   # build installers for Windows / macOS / Linux
```

More: [`GETTING_STARTED.md`](./GETTING_STARTED.md) · [`INSTALL.md`](./INSTALL.md) ·
[`DESKTOP.md`](./DESKTOP.md) · [`RELEASING.md`](./RELEASING.md) (tag-triggered releases)

## 🧪 Tested like the money matters

```bash
npm test          # 315 files · 3,965 tests: unit, integration, adversarial
npm run typecheck # tsc --noEmit
npm run build     # Next standalone production build
```

Every feature area was built by a **doer**, attacked by an **independent adversarial tester** and
signed off by a **reviewer**. The tests check the trial balance and balance sheet stay balanced and
each subledger matches its control account after every operation. They also cover closing-date
rules, permissions and rollback. On a busy machine, run `npx vitest run --maxWorkers=3`.

## 🏗 Under the hood

```
Electron shell ──► Next.js 15 (React 19 UI + API routes) ──► lib/services/* (accounting engine) ──► PGlite
 native menus,                                                 posting, documents, reports,          embedded Postgres,
 per-company dir                                               payroll, import/export, AI            one dir per company,
                                                                                                     ledger rules as triggers
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
PARITY.md            QuickBooks Desktop Enterprise parity gap matrix
```

### 🤝 Contributing
- Work on `main` and keep branches short-lived.
- **Never write account balances directly.** Post through `lib/services/posting.ts`; the database
  will reject anything else.
- Map every new API route in `lib/permissions/routes.ts`. A test fails if you forget.
- Write migrations by hand as the next `drizzle/00NN_*.sql` plus a `_journal.json` entry. Don't
  run drizzle-kit generate.

## 🗺 Roadmap

- [x] Wave 1: database-enforced ledger, transaction log, company file, backup and restore, local and
  tailnet AI, GL import from PDF/Excel/CSV, users and permissions
- [x] Wave 2: 8 teams closing the QuickBooks Enterprise gaps in [`PARITY.md`](./PARITY.md)
- [x] **Final parity audit**: 52 of 109 gaps done, 11 P0 items found (see [`PARITY.md`](./PARITY.md))
- [x] **P0 fix round**: all 11 fixed, covering restore safety, cash-basis P&L, consolidated-report access, payroll wage bases and W-2 Box 12, progress invoicing, statements, and A/R and A/P journal entries
- [x] **P1 round**: 9 teams. Setup interview and every preference wired, Simple menu mode with page search and help, typed document numbers on every form, full multi-currency (foreign banks, Home Currency Adjustment, aging in both currencies), one To Do list, Form 941/940, closing-date password prompt and record locking everywhere
- [x] **v1.1.0 release**: parity re-checked 2026-10-13: 66 of 109 gaps done, no P0 open (see [`PARITY.md`](./PARITY.md) Scorecard)
- [x] **v1.2.0 release**: the desktop app checks for new versions by default (version only, can be turned off in Privacy & Network) and asks before downloading and installing; Help → Check for Updates
- [x] **Production-readiness pass**: buggy rows fixed (terms due dates, templates on print/email, reorder list), security hardening, dependency updates, CI on every push
- [x] **Checks on any pre-cut stock**: position, 3-per-page, per-field layout, batch PDF
- [x] **Renamed to Ironbooks**
- [x] **UX round**: 15 doer/reviewer teams. Command bar, Needs attention home, undo and "why did this change", learning bank rules, report explanations, smart defaults, Fix buttons on errors, keyboard and batch entry, receipt capture with offline OCR, month-end close, visible backups, sandbox, Accountant's Copy and Period Copy, and the Other Names / price level / opening stock / deposited payment / multi-currency switch / password policy gaps
- [ ] The remaining partial rows and P2 follow-ups in [`PARITY.md`](./PARITY.md)
- [ ] Hands-on QA of the new screens, then a tagged release

## 📜 License

[MIT](./LICENSE). Use it, fork it, ship it.

## 🔏 Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

Windows installers are built from this repository by GitHub Actions
([`release.yml`](./.github/workflows/release.yml)) and signed only after a maintainer approves
each release. Releases up to and including 1.3.1 were published unsigned, while the
SignPath application was in progress.

| Role | Members |
| --- | --- |
| Committers and reviewers | [@RealDealCPA-VR](https://github.com/RealDealCPA-VR) |
| Approvers | [@RealDealCPA-VR](https://github.com/RealDealCPA-VR) |

**Privacy:** Ironbooks does not send information to other networked systems unless you, the
user, turn that feature on. Update checks (app version and platform only) are the one
connection on by default, and you can turn them off in Privacy & Network. The full list of
what can leave your computer, and the switch for each, is in [`PRIVACY.md`](./PRIVACY.md).

## ⚠️ Disclaimer

Accounting, tax and payroll features (including tax tables and wage bases) are provided as-is.
Verify them against current regulations before filing. This is open-source software, not
professional accounting advice.
