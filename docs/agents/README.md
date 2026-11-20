# Working in this codebase (people and coding agents)

Ironbooks is large: about 190 screens, 500 API routes and 230 service modules. You do not need
it all in your head, or in your context. This folder is the index. Look the thing up, open only
the files it names.

## Find what you need

| You want to… | Look in | How |
|---|---|---|
| Change a **screen** ("the Reconcile page", "Pay Bills") | [`code-map.md`](./code-map.md) | Search for the screen's name, QuickBooks name or path. It lists the page file, the API routes it calls and the service modules behind them. |
| Know what a screen is **for**, or how people use it | [`../guide/screens.md`](../guide/screens.md), [`../guide/`](../guide/README.md) | One line per screen; how-to guides by area. |
| The same product knowledge **as data** | [`kb.json`](./kb.json) | `articles[]`, `screens[]`, `glossary[]`. Query it; do not read it whole. |
| Understand **how a subsystem works** and which rules it must keep | [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) | Fourteen sections by subsystem (table below). Read the one section you need. |
| Find a QuickBooks feature's status | [`../../PARITY.md`](../../PARITY.md) | Search for the QuickBooks name. |

`code-map.md` and `kb.json` are generated (`npm run docs`), so they match the code they describe.

### ARCHITECTURE.md by section

| § | Subsystem | Start here in the code |
|---|---|---|
| 1 | Ledger core, posting, journal, database guards | `lib/services/posting.ts`, `lib/services/journal.ts`, `lib/db/ledgerGuards.ts` |
| 2 | Sales and A/R | `lib/services/invoices.ts`, `lib/services/payments.ts` |
| 3 | Purchases, A/P, checks, sales tax, 1099s | `lib/services/bills.ts` |
| 4 | Banking, registers, reconciliation, statement import | `lib/services/reconcile.ts`, `lib/bankRules/`, `lib/statements/` |
| 5 | Items, inventory, cost layers | `lib/services/` (inventory modules) |
| 6 | Payroll | `lib/services/` (payroll modules) |
| 7 | Multiple currencies | `lib/money.ts` and the currency services |
| 8 | Reports | `lib/services/reports.ts`, `lib/services/reportsExtra.ts`, `lib/reports/` |
| 9 | Accountant tools, Accountant's Copy, preferences, setup | `lib/preferences.ts`, `lib/onboarding.ts` |
| 10 | QuickBooks migration, imports, exports | `app/qb-import/`, `lib/export/` |
| 11 | The desktop app and the company file | `electron/` |
| 12 | Sign-in, permissions, API surface, network policy | `lib/context.ts`, `lib/permissions/`, `lib/net/guard.ts` |
| 13 | Transaction forms, centers, registers (UI) | `app/<screen>/page.tsx`, `components/` |
| 14 | App shell, navigation, keyboard, reports UI | `components/AppShell.tsx`, `lib/nav.ts`, `lib/shortcuts.ts` |

## The shape of the code

```
Electron shell ──► Next.js 15 (React 19 pages + API routes) ──► lib/services/* ──► PGlite
electron/          app/<screen>/page.tsx   app/api/**/route.ts   accounting rules   embedded Postgres
```

A request always takes the same path, so you can follow any feature the same way:

1. **Page** `app/<screen>/page.tsx` (a client component) calls `/api/...` through `lib/client.ts`.
2. **API route** `app/api/<name>/route.ts` calls `getServerContext()` (`lib/context.ts`), which
   signs the person in, loads their permissions and checks the route against
   `lib/permissions/routes.ts`. It validates the body with zod and calls a service.
3. **Service** `lib/services/<name>.ts` takes a `ServiceContext` (`lib/services/_base.ts`: db,
   company, user, access) and does the work inside `inTransaction`, writing the audit trail with
   `writeAudit`.
4. **Ledger**: anything that moves money calls `postJournalEntry` in `lib/services/posting.ts`.
   The database itself refuses unbalanced entries and edits to posted lines
   (`lib/db/ledgerGuards.ts`, `drizzle/*.sql`).

| Folder | What is in it |
|---|---|
| `app/` | One folder per screen (`page.tsx`); `app/api/` holds the API routes |
| `components/` | Shared UI: `AppShell.tsx` (menus, top bar), `ui.tsx` (buttons, inputs), `AssistantPanel.tsx` (Ask AI) |
| `lib/services/` | The accounting engine. `posting.ts` is the only way to touch the ledger |
| `lib/db/` | Drizzle schema (`schema.ts`) and the PGlite client |
| `lib/ai/` | AI router: local, tailnet and cloud providers, redaction, presets |
| `lib/kb/` | The product knowledge base: how-to articles, search, the docs generator |
| `lib/permissions/` | Roles, activities, and the route → permission map |
| `lib/nav.ts`, `lib/pageHelp.ts`, `lib/glossary.ts` | Menus, "what is this page" help, glossary. The single source for navigation |
| `lib/net/guard.ts` | The network policy. Every outbound call goes through it |
| `lib/money.ts` | Decimal-safe money. Never use floating point for amounts |
| `electron/` | Desktop shell: main process, menus, the company file, multi-user hosting |
| `drizzle/` | Hand-written SQL migrations (`00NN_*.sql`) and `meta/_journal.json` |
| `test/`, `lib/**/*.test.ts` | Vitest tests; `scripts/e2e*.mjs` drive the packaged app |

## Rules that are easy to break

- **Never write account balances directly.** Post through `lib/services/posting.ts`. The database
  rejects anything else.
- **Map every new API route** in `lib/permissions/routes.ts`. A test fails if you forget.
- **Migrations are written by hand**: the next `drizzle/00NN_*.sql` plus an entry in
  `drizzle/meta/_journal.json`. Do not run `drizzle-kit generate`. A company file opened by a
  build with a newer migration is refused by older builds, so test migrations on a copy of a
  company file.
- **Outbound network calls** go through `lib/net/guard.ts` (`policyFetch`). Nothing else may
  reach the network.
- **Money** is `lib/money.ts` (decimal), never a JavaScript number.
- **A/R lines need a customer and A/P lines a vendor** (the Name column), or aging stops matching
  the ledger.
- **Navigation has one source**: add a screen to `lib/nav.ts` (menu), `lib/pageHelp.ts` (what it
  is for) and, when people will ask how to use it, `lib/kb/articles.ts`. Then `npm run docs`.

## Adding or changing a screen: the checklist

1. Page: `app/<screen>/page.tsx`. Menu entry: `lib/nav.ts`. Page help: `lib/pageHelp.ts`.
2. API: `app/api/<name>/route.ts`, mapped in `lib/permissions/routes.ts`.
3. Rules: a service in `lib/services/`, with a test beside it.
4. Help: an article in `lib/kb/articles.ts` if it is a task people ask about. Quote buttons as
   the screen shows them. Ask AI and the Help page pick it up with no further wiring.
5. `npm run docs`, then the checks below.

## Checks

```bash
npm run typecheck
```

```bash
npx vitest run lib/kb
```

```bash
npx vitest run --maxWorkers=4
```

```bash
npm run build
```

The full test run is long (about 850 files). Run the tests beside what you changed first, then
the full run before you call the work done. Tests run in the `America/New_York` time zone
(`vitest.config.ts`).

## How Ask AI uses the knowledge base

`lib/services/aiAssistant.ts` gives the model read-only tools. `help_search` looks a question up
in `lib/kb` and returns the matching guides with their in-app links. For a "how do I…?" question
the lookup runs before the model does and its result is attached to the question, so even a small
local model answers from the guide. On the way out, any `[label](/path)` the model wrote that is
not a real screen the person may open is turned back into plain text, and the reply's `links`
become the "Open …" buttons in `components/AssistantPanel.tsx`. With no model connected, the
guide's answer is returned as it is.

To teach Ask AI something new about the product, write an article. Do not add it to the prompt.
