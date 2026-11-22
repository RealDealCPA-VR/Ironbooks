# Ironbooks documentation

| You are… | Read |
|---|---|
| **New to Ironbooks** | [START-HERE.md](./START-HERE.md): install, open a company, connect AI, first week |
| **Using Ironbooks** and want to know how to do something | [guide/](./guide/README.md): how-to guides by area · [every screen](./guide/screens.md) · [glossary](./guide/glossary.md) |
| **Coming from QuickBooks Desktop** | [Moving your books](./guide/coming-from-quickbooks.md) · [QuickBooks names → Ironbooks screens](./guide/quickbooks-names.md) |
| **Changing the code**, or a coding agent working in this repository | [agents/](./agents/README.md): where things live · [code map](./agents/code-map.md) (screen → files) |
| **An agent or tool that needs product knowledge as data** | [agents/kb.json](./agents/kb.json) |

## One knowledge base, four readers

The how-to content is written once, in [`lib/kb/articles.ts`](../lib/kb/articles.ts). The screens
come from the app's own menus ([`lib/nav.ts`](../lib/nav.ts)) and page help
([`lib/pageHelp.ts`](../lib/pageHelp.ts)); the terms from [`lib/glossary.ts`](../lib/glossary.ts).

```
lib/kb/articles.ts ─┐
lib/nav.ts          ├─► lib/kb ─┬─► Ask AI            answers "how do I…?" and links to the screen
lib/pageHelp.ts     │           ├─► Help & Glossary   in the app, searchable
lib/glossary.ts    ─┘           ├─► docs/guide/*.md   this folder (npm run docs)
                                └─► docs/agents/kb.json + code-map.md
```

So what the guide says, what the Help page shows and what Ask AI answers are the same words,
and every link is checked against the screens that really exist.

## Keeping it current

- Changed how a screen works, or added one? Update its article in `lib/kb/articles.ts` (and its
  entry in `lib/nav.ts` / `lib/pageHelp.ts`), then run:

  ```bash
  npm run docs
  ```

- `npm test` fails if a guide links to a screen that does not exist, if the generated guides are
  out of date, or if the code map misses a screen or names a file that is gone. Adding an API
  call to a page does not fail it: the code map is refreshed the next time someone runs
  `npm run docs`.
- Files in `docs/guide/`, `docs/agents/kb.json` and `docs/agents/code-map.md` are generated. Do
  not edit them by hand. `START-HERE.md`, this file and `agents/README.md` are written by hand.

## Other documents

[INSTALL.md](../INSTALL.md) installing and where data lives · [PRIVACY.md](../PRIVACY.md) what can
leave the computer · [SECURITY.md](../SECURITY.md) reporting a weakness ·
[MIGRATION.md](../MIGRATION.md) QuickBooks migration in depth ·
[ARCHITECTURE.md](../ARCHITECTURE.md) how the code works, by subsystem ·
[DESKTOP.md](../DESKTOP.md) the desktop shell · [RELEASING.md](../RELEASING.md) and
[SIGNING.md](../SIGNING.md) releases · [PARITY.md](../PARITY.md) QuickBooks Desktop parity matrix.
