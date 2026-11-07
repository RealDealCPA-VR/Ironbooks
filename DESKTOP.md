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
requester opens it), or *Not Now*. File > Switch to Multi-user Mode (also on the Multi-user page)
lets people join without asking; Switch to Single-user Mode stops it, asking first while another
computer has used the file in the last few minutes (the proxy notes when each peer last made a request).
A holder that stopped responding (crash, power cut, sleep) is reported as such and can be taken
over; if it had unsaved changes the person opening the file is told they are still on that computer.

**Passwords** belong to the company file: users, password hashes and challenge questions are inside
it. In the desktop app every open of the file asks for the user name and password (sessions are
bound to that launch — `lib/auth.ts`); the sign-in screen names the company and the file's location
and pre-fills the last user. "I forgot my password" asks the user's challenge question.

**A company file protected with its passwords** (format 2, on by default for new files; Company >
Security turns it on for an existing one) is encrypted at rest, so nobody can read or change the
books by unzipping it, and it opens on any computer with a fresh install for anyone who knows one of
its passwords — and nobody else:

- *Layout* (`electron/companyFileFormat.js`, `electron/fileCrypto.js`): the manifest stays the
  plain first entry with only what the No Company Open list shows (company name, file id, save ids,
  dates, app version) plus the key slots. Every other entry — the database, attachments, the
  transaction log, the backup manifest — is AES-256-GCM encrypted under a subkey of a random 256-bit
  file key made for that save alone (HKDF with its seal id, so random nonces never pile up under one
  key), a fresh nonce per entry, under an opaque name, with the container's seal id and the entry's
  names as additional data; an encrypted index lists the real names. The index also holds a copy of
  the plain listing (save ids, training flag, layout, company name, encryption details — not the
  key slots): once the key is known (sign-in, restore, a reused working copy) a listing changed
  without the key is refused as tampered. Every entry is verified (tag, then CRC) before a byte of
  it is written to disk; one entry at a time is in memory. Ironbooks 1.6 refuses format 2 as "saved
  by a newer version".
- *Key slots*: each slot has its own X25519 key pair; the private key is encrypted with a key
  derived by scrypt (N=2^16, r=8, about 250 ms; its own salt) from one secret, and the file key is
  wrapped to the public key. One slot per active user with a password, one per user whose challenge
  answer is long enough (at least 10 characters with some variety — a short phrase; the slot costs
  N=2^17: a short one-word answer to a known question could be guessed offline from a copy of the
  file, so it still resets the password while the file is open but never opens the file), and one
  for the **recovery key** — 24 characters in groups of four, shown once when the file is created
  or protected (Print / Save to a File; printed from the page itself). It is the only way back in if
  every password is lost. Slots are found by an HMAC of the user name with the file's random salt,
  so the manifest does not list user names — but someone with a copy of the file can confirm a
  guessed user name by computing its tag (and, on the computer that has the file, the sign-in
  screen's "I forgot my password" says whether a name has a challenge question). Scrypt costs above
  N=2^18, r=16, p=4 are refused (a changed slot can't make every sign-in slow). Slots follow every
  password path: sign-in (creates a missing slot,
  re-wraps a stale or weaker one; also for teammates signing in to a hosted file), password change,
  "I forgot my password", an Admin setting a password, a new user, a changed challenge question, a
  new recovery key; a deactivated or removed user's slot is left out of the next save.
- *The file key changes* whenever a secret stops being one that should open the file: a password
  changed or reset, a challenge answer changed, a user made inactive, a new recovery key, a restore
  that brought an older key back — and whenever an Admin chooses Company > Security > Change the
  File Key. The new key is wrapped for every remaining slot through its public key, without anyone's
  password, so nobody who may open the file is locked out; the change is made by the next save,
  before its snapshot. From then on an old password, a removed user, an old recovery key or anyone
  holding an OLDER copy of the file (whose slots still open the old key) can open only what was
  saved before. Slots made by the first protected version have no public key: their users are listed
  as "needs to sign in once" after a change (their next sign-in re-makes the slot). If the app stops
  between the change and the save, the next open takes the file's key again (no one is locked out;
  the next secret change rotates again).
- *Opening* is ONE sign-in, the QuickBooks way: the shell locks the file and works out the open plan
  (and asks the conflict question) without the key, then starts the server *sealed*
  (`BKA_COMPANY_SEALED` = extract / conflict / key; `lib/db/sealed.ts`): only the sign-in page and
  its routes work. The sign-in unwraps the file key from the user's slot (an unknown user name costs
  the same work as a wrong password; attempts are rate-limited), decrypts the file into the working
  copy, opens the database, checks the password against the users table and starts the session. A
  company-file password, if the file also has one, is asked on the same screen. The file key lives
  only in the server's memory — never in state.json, the environment, a log or a URL.
- *Working copy*: plain text only on this computer (`%LOCALAPPDATA%`). After a clean close it is
  deleted; it is kept whenever the company file lacks something, so crash recovery still works.
- *Every copy is protected the same way*: saves, Save Copy As, "unsaved changes" copies, automatic
  and manual backups (`.bka`), safety copies before a restore / condense / year-end close, condense
  archives, per-company backups and training files kept from the sandbox. A protected backup
  restores into its own file without a question; restoring one elsewhere (or File > Open or Restore
  Company) asks for a user name + password from the file it came from, or its recovery key.
  Portable company files (`.bkp`), Period Copies and Accountant's Copy transfer files (`.ibac`) are
  offered with a password (on by default) that encrypts the whole file; for a protected company file
  the password is required. Such a copy never carries this file's key: it gets its own, with every
  slot re-wrapped for it, so the company file restored from it is protected again and opens with
  the same user names, passwords and recovery key — while whoever has the copy's password never
  learns the original file's key. A Period Copy of a protected file is built beside its working copy
  on this computer (never a shared temp folder) and removed right after.
- *Sandbox* ("Try it on a copy") copies live in `%LOCALAPPDATA%\Ironbooks\Sandboxes`, next to the
  working copies (never the roaming profile; older ones are moved there). A sandbox of a protected
  file is plain text like its working copy; copies of it left over are removed when the real file is
  closed cleanly.
- *Earlier copies*: backups, portable files and copies made before a file was protected stay as they
  were (not encrypted); Company > Security says so — delete them or keep them out of reach.
- *Upgrading*: a file without passwords opens as before; an Admin signing in is offered "Protect
  this company file with passwords". Users who have not signed in since are listed as "needs to
  sign in once, or an Admin resets their password".
- *Nothing machine-bound*: stored AI provider keys are sealed with a vault secret inside the file
  (`lib/ai/keyVault.ts`); only the session-signing key (`.auth-secret`) is per computer.

**Older company folders** (`*.ironbooks` folders from earlier versions) still open (File > Open
Company Folder (Older Format)); File > Save as a Single Company File converts one.

**Known limits** (recorded so they are decided, not forgotten):

- *Restore or preview of a backup over about 2 GB from the Back Up and Restore page* reads the whole
  upload in memory (adm-zip; a protected backup is decrypted in memory too, about 2-3x its size).
  Restoring it as a new company file through the desktop shell (File > Open or Restore Company)
  reads with positioned reads and works at any size; streaming the page's restore is a larger
  rewrite of `lib/services/backup.ts` / `backupPreview.ts`.
- *Safety copies made before a restore, condense or year-end close* stay in the working-copy folder
  of the computer that made them (rotated per company file); they are not moved next to the shared
  file, so another computer does not see them.
- *Backup health counts every computer's backups*: the history travels with the file, so "Last
  backup" and the schedule include backups this computer cannot see. Per-computer versus per-file
  backup semantics is a product decision.
- *Ironbooks 1.6.0 and earlier cannot refuse files from later versions it does not know about* beyond
  `formatVersion` (it refuses format 2, so protected and newer files are safe). Update every
  computer of an office together (release notes).
- *A file key change waits for the next save*: if the app stops between a password change (or a
  deactivated user) and that save, the change is not made; the next secret change makes it.

### Moving files between computers (1.7.0)

- **Where the file is.** Opening a company file from File Explorer or File > Open first checks its
  folder (`electron/fileLocation.js`, `confirmCompanyFileLocation` in `electron/main.js`). An email
  attachment opened from Outlook or a download cache (a temporary folder), or a read-only file, is
  offered "Save a Copy and Open It" in Documents. A file in a OneDrive, Dropbox, Google Drive or
  iCloud Drive folder is told once (per file, `cloudWarned` in config) not to be opened from two
  computers at once: sync copies the file between them, so the lock cannot protect it. Shared books
  belong on the office file server or in multi-user mode.
- **Backups and portable files on a new computer.** Double-clicking a `.bka` or `.bkp` on a fresh
  install (or with no company open) restores it as a new company file. A portable file restored from
  No Company Open runs the restore on a short-lived server (`startScratchServer`). A `.bka`
  double-clicked while a company is open asks "As a New Company File / Into the Open Company".
- **Accountant's Copy.** `.ibac` (transfer file) and `.ibcx` (changes) are registered file types and
  open from File > Open. An `.ibac` becomes the accountant's working copy as one `.ironbooks` file
  where the accountant chooses (`openAccountantCopyFlow`; no company needs to be open). An `.ibcx`
  opens the Accountant's Copy page of the open company file with the changes ready to review.
- **Forgotten file password.** The unlock screen offers "Forgot the file password?": on a file
  protected with passwords, the recovery key; on any other file an Admin of the file signs in with
  their own user name and password and the file password is removed (`/api/unlock/admin`).

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
  company file (every company in the data dir) into `%LOCALAPPDATA%\Ironbooks\Sandboxes\<id>\` (next
  to the working copies; earlier versions used `userData/sandboxes`, moved on start) and opens the app
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
