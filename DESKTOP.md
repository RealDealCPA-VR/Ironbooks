# Ironbooks — Desktop App

Ironbooks runs as a native desktop application (Windows/macOS/Linux) via Electron. All data
lives **locally** in an embedded Postgres (PGlite) — fully offline, you own your data.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Electron main (electron/main.js)             │
│  • single-instance, app menu, native dialogs │
│  • launches the Next.js server on a free port │
│  • sets BKA_DATA_DIR = userData/companies/... │
└───────────────┬─────────────────────────────┘
                │ loads http://127.0.0.1:<port>
┌───────────────▼─────────────────────────────┐
│ Next.js standalone server (.next/standalone) │
│  • React UI (renderer)                        │
│  • API routes -> lib/services/* (engine)      │
│  • lib/db -> PGlite (local file DB)           │
└───────────────────────────────────────────────┘
```

The renderer talks to Electron only through the audited `window.bookkeeper` bridge
(`electron/preload.js`): native file open/save, the active data dir, and menu/navigation events.

## Develop

One command — starts the Next dev server, waits for it, then opens the desktop window.
Closing the window (or Ctrl+C) stops both:

```bash
npm run desktop
```

(If you prefer two terminals: `npm run dev` in one, `npm run electron:dev` in the other.)

## Build a distributable

```bash
npm run desktop:pack   # unpacked app in dist/ (fast, for smoke testing)
npm run desktop:dist   # installers: Windows nsis+portable / mac dmg / linux AppImage+deb
```

`output: 'standalone'` in `next.config.js` produces `.next/standalone/server.js`; electron-builder
bundles it (plus `.next/static`, `public`, and `drizzle/` migrations) under the app resources.
On boot the DB migrator runs `drizzle/` against the local company file.

## Data & backups

- Company files: `app.getPath('userData')/companies/<name>/` (one PGlite directory per company).
- `BKA_DATA_DIR` overrides the active company dir (used by the main process + tests).
- Backup/restore packages a company directory into a single `.bka` archive (see Phase 10).
- Every committed change is appended to a hash-chained running transaction log,
  `<company dir>/transactions.bktlg` (QB .TLG parity; File > View Transaction Log).
- File > Create Portable Company File writes `<Company>.bkp` (QB .QBM parity): a checksummed
  logical export of every table, attachments and the transaction log. Opening one (File menu or
  double-click — `.bkp` is a registered file type) restores it into a NEW company folder and
  refuses unless every table hash and trial balance matches the original.
- File > Export Shareable Ledger writes an .xlsx workbook / PDF summary readable without the app.
- Condense writes and verifies a full archive `.bka` (sibling `archives/` folder) first; the
  Backup page lists these archive copies and can restore one.

## Sandbox mode ("Try it on a copy")

- File / Help > Try It on a Copy (or Setup > Try it on a copy, `/sandbox`) copies the whole
  company file (every company in the data dir) into `userData/sandboxes/<id>/` and opens the app
  on the copy. The server closes the real file's PGlite handle (checkpoint + flush) and copies the
  directory synchronously, writes a `.ironbooks-sandbox.json` marker into the copy and switches its
  active data dir; the shell then records `config.sandbox = { dir, realDir }` and relaunches into
  the copy (`lib/services/sandbox.ts`, `electron/main.js`).
- While the active file carries the marker: an orange "SANDBOX — changes here don't affect your
  real books" bar is on every page, printed checks / invoices / forms are stamped SANDBOX, and
  email, bank-feed sync, scheduled reports, auto-backups, multi-user hosting, Recent Companies and
  update prompts are off. The real file is not opened until you leave.
- Leave by Discard sandbox (copy deleted) or Keep as a training file (moved next to the real file
  under the chosen name, with its own file id, still marked as a practice copy). Nothing is ever
  merged back. The marker never travels in a `.bka` backup.
- Web / dev (no shell): the server switches its active data dir in-process. A server restart
  comes back on the real file; the copy is then listed on the Sandbox page ("Copies left over")
  to open again or delete. `BKA_SANDBOX_ROOT` overrides where copies go (default: an
  `Ironbooks Sandboxes` folder next to the real file).
