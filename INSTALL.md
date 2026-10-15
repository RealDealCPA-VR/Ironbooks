# Installing Ironbooks (desktop)

You do **not** need Node, a terminal, or the dev server to use the app. There are two ways to get a
clickable desktop icon. Both run the fully self-contained app (it starts its own local server +
embedded database internally).

## Option A — Installer (recommended; creates a Desktop icon)

1. Get **`Ironbooks Setup 1.2.0.exe`** (in the `release/` folder after a build, or from a release page).
2. Double-click it. The installer:
   - installs per-user (no admin password needed),
   - lets you choose the install folder,
   - **creates an "Ironbooks" icon on your Desktop and in the Start Menu**,
   - launches the app when it finishes.
3. From then on, just double-click the **Ironbooks** desktop icon to open it. That's it.

To uninstall: Settings → Apps → Ironbooks → Uninstall (your company data is kept).

## Option B — Portable (no install)

Use **`Ironbooks 1.2.0.exe`** (the portable build). Double-click to run it directly — nothing is
installed. To get an icon, right-click it → *Send to → Desktop (create shortcut)*, or drag it to the
taskbar to pin it.

## Where your data lives

All financial data is stored locally at:
`C:\Users\<you>\AppData\Roaming\Ironbooks\companies\` (one folder per company file).
(If you installed the app back when it was called BookKeeper AI, it keeps using your existing
`AppData\Roaming\BookKeeper AI\` folder, so nothing moves and no company files are lost.)
It never leaves your machine. Back it up from the in-app **Backup** screen (or copy that folder).

## Building the installer yourself (developers)

```bash
npm install
npm run desktop:dist     # produces release/Ironbooks Setup 1.2.0.exe + the portable .exe
```

- The installer is **code-signed** if you set `CSC_LINK` / `CSC_KEY_PASSWORD` (see SIGNING.md).
  Without a trusted CA certificate, Windows SmartScreen may warn on first run ("More info → Run anyway");
  a real cert removes that. The app itself is unaffected.
- `npm run desktop:pack` makes an unpacked build in `release/win-unpacked/` (no installer) for quick testing.

## Developer-only shortcut (run the dev build from an icon)

If you're developing and want a desktop icon that launches the live dev app (`npm run desktop`) instead
of installing, run once:

```powershell
npm run make-dev-shortcut
```

This creates an "Ironbooks (Dev)" shortcut on your Desktop that starts the dev server + window.
(End users should use Option A or B instead — those don't need Node installed.)
