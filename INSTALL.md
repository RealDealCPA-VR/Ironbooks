# Installing Ironbooks (desktop)

You do **not** need Node, a terminal, or the dev server to use the app. There are two ways to get a
clickable desktop icon. Both run the fully self-contained app (it starts its own local server +
embedded database internally).

## Option A — Installer (recommended; creates a Desktop icon)

1. Get **`Ironbooks-Setup-1.7.10.exe`** from the
   [latest release](https://github.com/RealDealCPA-VR/Ironbooks/releases/latest) (or the `release/`
   folder after a build).
2. Double-click it. The installer:
   - installs for your Windows user only (no admin password needed), into
     `C:\Users\<you>\AppData\Local\Programs\Ironbooks` (the install folder can't be changed),
   - **creates an "Ironbooks" icon on your Desktop and in the Start Menu**,
   - launches the app when it finishes.
3. From then on, just double-click the **Ironbooks** desktop icon to open it. That's it.

**Windows blocks it?** Until the installer is code-signed, Windows SmartScreen says "Windows
protected your PC": choose **More info**, then **Run anyway**. On Windows 11 with **Smart App
Control** turned **On**, unsigned apps are blocked outright, with no "Run anyway" button. Check
Windows Security > App & browser control > Smart App Control settings. If it is On, talk to whoever
looks after the computer before changing it.

To uninstall: Settings → Apps → Ironbooks → Uninstall. Your company files and backups are not
deleted.

## Option B — Portable (no install)

Use **`Ironbooks-1.7.10.exe`** (the portable build). Double-click to run it directly — nothing is
installed. To get an icon, right-click it → *Send to → Desktop (create shortcut)*, or drag it to the
taskbar to pin it.

## Where your data lives

Your books are in the **company file** you chose when you made it (File > New Company): one file,
such as `ABC Company.ironbooks`, in Documents by default or wherever you saved it (a local folder, a
USB drive or the office file server). That file is what you back up, copy or hand to your accountant.

Ironbooks also keeps, on this computer:

- a **working copy** of the open company file in `C:\Users\<you>\AppData\Local\Ironbooks\Working\`.
  Changes land there first and are saved into the company file a few seconds later, and when you
  close it. It is only a cache: don't use it as a backup, and don't delete it — after a crash it
  holds any changes not yet saved into the company file;
- **safety copies** made before a restore, an upgrade or Condense Data, next to that working copy
  (`pre-op-backups`);
- **automatic backups** (`.bka` files) in `C:\Users\<you>\AppData\Roaming\Ironbooks\backups\`,
  unless you choose another folder in Back Up and Restore, and the app's settings (recent files,
  window position). Company files made by versions before the single-file format are in
  `AppData\Roaming\Ironbooks\companies\` (or `AppData\Roaming\BookKeeper AI\` for very old installs).

Nothing leaves your machine. **To back up:** File > Back Up Company… > **Back up now** (choose a
backup folder on a USB drive or another disk first), or copy the `.ironbooks` file itself while it is
closed in Ironbooks.

## Building the installer yourself (developers)

```bash
npm install
npm run desktop:dist     # produces release/Ironbooks-Setup-<version>.exe + the portable Ironbooks-<version>.exe
```

- The installer is **code-signed** if you set `CSC_LINK` / `CSC_KEY_PASSWORD` (see SIGNING.md).
  Without a trusted CA certificate, Windows SmartScreen may warn on first run ("More info → Run anyway"),
  and Smart App Control (when On) blocks it; a real cert removes that. The app itself is unaffected.
- `npm run desktop:pack` makes an unpacked build in `release/win-unpacked/` (no installer) for quick testing.

## Developer-only shortcut (run the dev build from an icon)

If you're developing and want a desktop icon that launches the live dev app (`npm run desktop`) instead
of installing, run once:

```powershell
npm run make-dev-shortcut
```

This creates an "Ironbooks (Dev)" shortcut on your Desktop that starts the dev server + window.
(End users should use Option A or B instead — those don't need Node installed.)
