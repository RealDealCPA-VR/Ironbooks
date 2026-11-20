# Ironbooks: guide for coding agents

Ironbooks is an open-source desktop accounting app (Electron + Next.js 15 + PGlite), a QuickBooks
Desktop replacement. It is large. Do not read it end to end: look things up.

## Start with the index

- **[docs/agents/README.md](./docs/agents/README.md)**: how the code is laid out, the request
  path, the rules that are easy to break, the checklist for a new screen.
- **[docs/agents/code-map.md](./docs/agents/code-map.md)**: every screen → its page file, API
  routes and service modules. Search it for the screen's name, QuickBooks name or path, then open
  only those files.
- **[docs/agents/kb.json](./docs/agents/kb.json)**: what each screen is for and how people use
  it, as data (`articles`, `screens`, `glossary`). Query it; do not load it whole.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)**: how each subsystem works, in fourteen sections. Read
  the one section you need (the index lists them).

## Rules

- Never write account balances directly. Post through `lib/services/posting.ts`.
- Map every new API route in `lib/permissions/routes.ts`.
- Write migrations by hand: the next `drizzle/00NN_*.sql` plus `drizzle/meta/_journal.json`. Do
  not run `drizzle-kit generate`.
- Outbound network calls go through `lib/net/guard.ts` only.
- Money is `lib/money.ts` (decimal), never a JavaScript number.
- A screen's menu entry, page help and how-to article live in `lib/nav.ts`, `lib/pageHelp.ts`
  and `lib/kb/articles.ts`. After changing any of them run `npm run docs`.

## Checks

```bash
npm run typecheck
```

```bash
npx vitest run --maxWorkers=4
```

```bash
npm run build
```

Run the tests beside your change first; the full run is long.

## Documentation for people

[docs/START-HERE.md](./docs/START-HERE.md) and [docs/guide/](./docs/guide/README.md). The guide is
generated from `lib/kb`; edit the source, not the Markdown.
