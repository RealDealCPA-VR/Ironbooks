# Ironbooks — Desktop App

Ironbooks runs as a native desktop application (Windows/macOS/Linux) via Electron. All data
lives **locally** in an embedded Postgres (PGlite) — fully offline, you own your data.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Electron main (electron/main.js)             │
│  • single-instance, app menu, native dialogs │
│  • launches the Next.js server on a free port │
│  • locks + opens the company file, sets       │
│    BKA_DATA_DIR = its working copy             │
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

## The company file (QuickBooks .QBW style)

A company file is ONE file, `ABC Company.ironbooks`, that can live anywhere: this computer, a USB
drive, or the office file server (`S:\Accounting`, `\\SERVER\Books`). Double-click it to open it,
copy it like any file, back it up, hand it to your accountant. It is a standard zip
(`electron/companyFileFormat.js`): the manifest first (stored, so lists can read the company name
from the first few KB), a `.bka`-compatible backup manifest (a company file restores like a
backup), then the embedded database folder with its attachments and transaction log.

**Opening** (`electron/main.js` `openSingleFileForLaunch`):

1. **Lock.** `ABC Company.ironbooks.lock\` (hidden) is created next to the file — mkdir is atomic on
   local disks and SMB/NAS shares, so two workstations can't both get it (`electron/companyLock.js`).
   `owner.json` says who (Ironbooks user, Windows user, computer), since when, whether there are
   unsaved changes, and — in multi-user mode — where to join. The holder refreshes it every 10 s;
   its modification time is stamped by the file server, so clocks don't matter.
2. **Working copy.** The file is opened into `%LOCALAPPDATA%\Ironbooks\Working\<name>-<hash>\data`
   (never a roaming profile; `electron/companySession.js`). It is reused when the company file is
   unchanged since this computer last saved it, recovered when it holds changes that never reached
   the file (the app stopped before saving), or kept aside as `… (unsaved changes from PC, date)
   .ironbooks` when someone else saved the file in the meantime — nothing is ever silently lost.
3. **Server.** The app server runs on the working copy with `BKA_COMPANY_FILE`,
   `BKA_COMPANY_STATE`, `BKA_COMPANY_LOCK` and `BKA_COMPANY_LOCK_TOKEN`.

**Saving** (`lib/services/companyFileSave.ts`): a few seconds after the books change (at most 30 s
while someone keeps typing), every 5 minutes for housekeeping-only changes, on File > Save Company
File Now, and when the file is closed or the app quits. A save takes a consistent snapshot of the
working copy (the database runs in the same process, so one synchronous read is exactly what a
power cut would leave — which PostgreSQL recovers from), writes the zip to a temporary file next to
the company file, flushes it and renames it over the company file: the file on the server is always
the previous save or the new one. Before writing, the server checks it still holds the lock and that
the file is still the save it started from; otherwise the changes go to a separate copy. The title
bar shows Saved / Saving… / Not saved (`components/CompanyFileStatus.tsx`).

**Someone else has it open.** Opening a locked file shows who has it and offers *Ask to Come In*. The
request appears on the holder's screen: *Let Them In* (multi-user mode: the holder's Ironbooks serves
the file over the office network with HTTPS and its own certificate, which the requester pins — the
fingerprint travels through the lock folder), *Hand It Over* (the holder saves and closes; the
requester opens it), or *Not Now*. File > Switch to Multi-user Mode lets people join without asking.
A holder that stopped responding (crash, power cut, sleep) is reported as such and can be taken
over; if it had unsaved changes the person opening the file is told they are still on that computer.

**Passwords** belong to the company file: users, password hashes and challenge questions are inside
it. In the desktop app every open of the file asks for the user name and password (sessions are
bound to that launch — `lib/auth.ts`); the sign-in screen names the company and the file's location
and pre-fills the last user. "I forgot my password" asks the user's challenge question.

**Older company folders** (`*.ironbooks` folders from earlier versions) still open (File > Open
Company Folder (Older Format)); File > Save as a Single Company File converts one.

## Testing the desktop app

After `npm run build && npx electron-builder --dir` (the packaged app in `release/win-unpacked`):

| Command | What it drives |
|---|---|
| `npm run test:e2e:file` | the built server on a single company file: autosave, close, reopen elsewhere |
| `npm run test:e2e:desktop` | the packaged app: open, lock, autosave, an access request answered on screen (Not Now, Hand It Over), No Company Open, sign-in, save on close |
| `npm run test:e2e:keyboard` | QuickBooks keys in the packaged app (Ctrl+J/A/W/I, date keys, list keys, Previous / Next / Revert, Ctrl+Y) |
| `npm run test:e2e:multiuser` | two copies of the app as two workstations on one company file: Ask to Come In, Let Them In, a second user working over the office network |

Set `E2E_UNC=1` to put the company file behind this computer's SMB server (the `C$` share of
`localhost` as a UNC path), so every lock, save and rename goes over the same protocol as an office file server.
The scripts use their own settings and working-copy folders (`IRONBOOKS_USER_DATA`, `LOCALAPPDATA`),
press keys through DevTools input (never the Windows keyboard) and click native message boxes only
after checking, with UI Automation, that the button is really under the pointer.

## Data & backups

- `BKA_DATA_DIR` overrides the active company (used by the main process + tests).
- Backup/restore packages a company's database folder into a single `.bka` archive.
- Every committed change is appended to a hash-chained running transaction log,
  `transactions.bktlg` inside the company file (QB .TLG parity; File > View Transaction Log).
- File > Create Portable Company File writes `<Company>.bkp` (QB .QBM parity): a checksummed
  logical export of every table, attachments and the transaction log. Opening one (File menu or
  double-click — `.bkp` is a registered file type) restores it into a NEW company file and
  refuses unless every table hash and trial balance matches the original.
- File > Save Copy As writes an independent copy of the open company as a new company file.
- File > Export Shareable Ledger writes an .xlsx workbook / PDF summary readable without the app.
- Condense writes and verifies a full archive `.bka` first; the Backup page lists these archive
  copies and can restore one.

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
- File password: the unlock is bound to the active data dir and the launch. On the desktop the
  shell relaunches into the copy (and back), so you are asked for the file password again (the
  copy has the same password). Web / dev: the sandbox routes re-issue the unlock cookie for the
  new folder when the request held a valid one, so no new prompt (`lib/sandboxUnlock.ts`).
- PDF stamp: `getServerContext` syncs `BKA_SANDBOX` the first time a request runs against a data
  dir, so a server started directly on a sandbox / training folder stamps from the first print.
