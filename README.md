# BookKeeper AI

**Open-source desktop accounting built to match QuickBooks Desktop Enterprise, with local AI and books that can't go out of balance.**

BookKeeper AI is a cross-platform **desktop** app (Windows / macOS / Linux) for full double-entry
accounting. Your company file lives **on your computer**. It is an embedded Postgres database
(PGlite), and there is no cloud account, no subscription and no required internet. AI runs on
models on your own machine or Tailscale tailnet by default. Cloud AI is opt-in per company and
redacted.

> **Status:** two rounds of QuickBooks Desktop Enterprise parity work are merged into `main`.
> 290 test files and 3,658 tests pass, the typecheck is clean, and the production build succeeds.
> [`PARITY.md`](./PARITY.md) is the gap matrix that drove the second round. A final parity audit
> and a short list of follow-ups are still open (see [Roadmap](#-roadmap)).

## ✨ Features

### Books that can't go out of balance
- One posting engine, with ledger rules **enforced by the database itself**. An unbalanced
  entry, a direct balance edit, or a change to a posted line outside a sanctioned edit is rejected
  at commit, whatever code path tries it.
- A/R and A/P control accounts must tie to their aging. Every A/R and A/P line carries a customer
  or vendor name, as in QuickBooks. Draft invoices never touch A/R.
- A built-in integrity check, closing date with password, an audit trail, and Decimal-safe money
  everywhere.

### Company file and transaction log
- **A running, tamper-evident transaction log** inside the company file records every change,
  like QuickBooks' TLG file.
- **Shareable company files**: a single-file portable copy, plus an Excel or PDF ledger export
  for your accountant.
- **Backups** that restore in full, an automatic backup before risky operations, and **Condense
  Data** that writes a restorable full archive first.
- **Multi-user**: per-company users, roles and permissions, with multi-user hosting limited to your
  Tailscale tailnet.

### QuickBooks migration
- **General Ledger import** from a QuickBooks GL report in **Excel, CSV or PDF**. It reconciles to
  the penny against the trial balance before anything is committed.
- **IIF import** with the account hierarchy, every item type, and customer, vendor and employee
  fields and lists.
- **Open invoices and bills** come in as real documents, so you can receive payments and pay bills
  right after cutover. A/R and A/P still tie to the imported GL.
- IIF, CSV and Excel export of lists and transactions.

### QuickBooks Enterprise workflows
- **Chart of accounts**: every QuickBooks account type (Bank, A/R, Other Current Asset, Fixed
  Asset, Credit Card, Long Term Liability, COGS, Other Income/Expense, Non-posting and more),
  sub-accounts and tax-line mapping.
- **Lists**: terms, customer/vendor/job types, other names, ship via, payment methods, sales tax
  codes, price levels and billing rates, vehicles, units of measure, To Do and notes, Add/Edit
  Multiple, merge and Clean Up.
- **Sales / A/R**: estimates, sales orders, invoices (with alphanumeric numbers, retainage and
  shipping fields), sales receipts, credit memos and refunds, Receive Payments with discounts and
  credits, bounced checks, statements and statement charges, batch invoicing, finance charges, the
  Income Tracker and the Collections Center.
- **Purchases / A/P**: purchase orders, item receipts, bills, Pay Bills with due-date and discount
  filters, checks and credit card charges with items, a check print queue with printer alignment,
  vendor credits, the Loan Manager and multi-currency.
- **Banking**: OFX/QBO/CSV import with rules, bank feeds (optional), reconciliation, deposits and
  transfers.
- **Inventory**: FIFO and average cost, opening quantities, assemblies, landed cost, sites and
  transfers, reorder points and the Inventory Center.
- **Payroll** (after-the-fact): Social Security wage base and withholding tables by year,
  mid-year YTD setup, paycheck edits, liability adjustments, state unemployment, workers' comp,
  941/940/W-2 data and payroll reports.
- **Sales tax**: a liability report that ties to the GL by agency, on accrual or cash basis, plus
  Pay Sales Tax and adjustments.
- **Accountant tools**: the Accountant Center, Working Trial Balance, Reclassify Transactions,
  Write Off Invoices, Batch Enter, Batch Delete/Void, Client Data Review, Review List Changes and
  Fix Incorrectly Recorded Sales Tax.
- **Preferences and forms**: QuickBooks-style Preferences, form templates (logo, colors, fields),
  memorized transactions, reminders, the calendar, Lead Center, Doc Center, letters and labels.

### Reports
- QuickBooks P&L sections, sub-account roll-ups, and Retained Earnings and Net Income on
  separate lines.
- The standard report set, including detail, job, time, mileage, list and income-tax reports.
- Filters, QuickZoom drill-down, memorized report groups, scheduled exports, graphs, a pivot
  builder, combined multi-company reports, budgets, forecasts and Advanced Find.
- CSV/Excel/PDF export.

### AI that stays local
- **Local models first**: Ollama, LM Studio or any OpenAI-compatible server on this computer, your
  LAN or your **Tailscale tailnet**.
- **Cloud models are optional**, chosen per company in **AI & Automation**. When a cloud model is
  used, personal data (SSNs, TINs, account numbers) is redacted.
- QuickBooks-style learned categorization, an AI assistant that proposes entries for your
  approval, and AI error review: unbalanced, duplicate or miscategorized entries and outliers.
- All network access goes through one policy guard. See [`PRIVACY.md`](./PRIVACY.md) for exactly
  what can leave the machine. The answer is never your books.

## 🏗 Architecture

```
Electron shell  ──launches──►  Next.js server  ──►  lib/services/* (accounting engine)  ──►  PGlite (local DB)
(native menus,                 (React UI +              posting, documents, reports,          embedded Postgres,
 file dialogs,                  API routes)             payroll, import/export, AI            one dir per company,
 per-company data dir)                                                                        ledger rules as DB triggers)
```

- **UI**: Next.js 15 App Router + React 19 + Tailwind.
- **Engine**: pure TypeScript services (`lib/services/*`) that can be tested without a browser.
- **DB**: Drizzle ORM on **PGlite** (embedded Postgres). Migrations live in `drizzle/` and are
  written by hand (see below).
- **AI**: `lib/ai/` routes requests to local, tailnet or cloud providers. `lib/net/guard.ts` is the
  only way out to the network.
- **Desktop**: Electron (`electron/`). See [`DESKTOP.md`](./DESKTOP.md).

## 🚀 Getting started

```bash
npm install --legacy-peer-deps

# Web/dev mode (browser):
npm run dev            # http://localhost:3000

# Desktop dev (Electron pointed at the dev server):
npm run dev            # terminal 1
npm run electron:dev   # terminal 2

# Build desktop installers (Windows/mac/Linux):
npm run desktop:dist
```

See [`GETTING_STARTED.md`](./GETTING_STARTED.md) and [`INSTALL.md`](./INSTALL.md) for more.
Releases are tag-triggered. See [`RELEASING.md`](./RELEASING.md).

## 🧪 Quality

```bash
npm test          # vitest: unit, integration and adversarial accounting tests
npm run typecheck # tsc --noEmit
npm run build     # Next standalone production build
```

Every feature area has adversarial tests that check the accounting invariants: the trial balance
and balance sheet stay balanced, and each subledger matches its control account. They also cover
closing-date rules, permission mapping and rollback. On a busy machine, run the suite with
`npx vitest run --maxWorkers=3`.

**Contributing rules**:
- Work on `main` (short-lived branches only).
- Never write account balances directly; post through `lib/services/posting.ts`.
- Map every new API route in `lib/permissions/routes.ts`.
- Write migrations by hand as the next `drizzle/00NN_*.sql`, with a `_journal.json` entry. Don't
  run drizzle-kit generate.

## 📁 Layout

```
electron/            Desktop shell (main process + preload bridge)
lib/db/              Drizzle schema + PGlite client
lib/services/        Accounting engine: posting, documents, banking, inventory, payroll,
                     reports, QuickBooks import/export, company file, transaction log, …
lib/ai/              AI provider router (local / tailnet / cloud) + redaction
lib/permissions/     Roles, permission areas, route → permission map
lib/net/guard.ts     Network policy (the only path to the network)
lib/money.ts         Decimal-safe money + allocation + formatting
app/                 React UI (pages) + API route handlers (app/api/*)
components/          Shared UI kit, help/glossary
drizzle/             Hand-written SQL migrations (bundled into the desktop build)
PARITY.md            QuickBooks Desktop Enterprise parity gap matrix
```

## 🗺 Roadmap

1. **Final parity audit.** Re-audit `main` against every gap in `PARITY.md` and against the
   project goals: exact QB Desktop Enterprise parity, local-only data, local or tailnet AI, a
   shareable company file and transaction log, GL import, full backup and restore, per-company
   users, and books that can't go out of balance.
2. **Known follow-ups:**
   - Combine the two To-Do lists (Lists and Calendar/Leads).
   - Add the typed-number field to the estimate, sales order, sales receipt, credit memo and
     purchase order forms.
   - When names are merged, update the memorized transactions that use them.
   - Use as-of balances in the Income Tracker's unpaid and overdue groups.
   - Multi-currency vendor credits, deposits and transfers.
   - Refund-check printing.
   - Test migration 0029 against a real upgraded company file.
3. **Hands-on QA** of the new screens, Receive Payments first, then a tagged release.

## ⚠️ Disclaimer

Accounting, tax and payroll features (including tax tables and wage bases) are provided as-is.
Verify them against current regulations before filing. This is open-source software, not
professional accounting advice.
