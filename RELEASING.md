# Releasing & Auto-Update

Ironbooks desktop ships auto-update via [`electron-updater`](https://www.electron.build/auto-update)
against **GitHub Releases**. Installed apps check the repo's Releases at launch, every 4 hours, and
from **Help → Check for Updates…**. When a newer release is published they show an in-app
**"Update available"** banner (`components/DesktopBridge.tsx`) offering **Download & install** or
**Later**; nothing downloads until the user agrees. After the download the banner offers
**Restart & install now**; choosing **Later** installs the update on the next normal quit.
Update checks are on by default (version + platform only); a company can turn them off in
Privacy & Network, and Offline mode blocks them.

- **Feed:** configured in `package.json` → `build.publish` (`github` / `RealDealCPA-VR` / `Ironbooks`).
- **Renderer wiring:** `electron/main.js` `checkForUpdates()` → `update` IPC channel (`available` →
  `downloading` → `ready` / `error`) → `components/DesktopBridge.tsx` banner; the user's choices go
  back over `app:downloadUpdate` / `app:quitAndInstall`.
- **Update granularity:** electron-updater swaps the **entire installed package** — the Electron shell,
  the bundled Next.js standalone server, and the `drizzle/` migrations all update together atomically.

## One-time setup

1. **GitHub token.** Create a fine-grained or classic PAT with **`repo`** scope (it needs to create
   releases and upload assets on `RealDealCPA-VR/Ironbooks`). Keep it out of git.
2. Make the repo's **Releases public** (the repo can be private, but a private repo's update feed
   requires every client to ship a token — for a normal distributable app, use public releases).

## Cut a release

```powershell
# 1. Bump the version (this is what clients compare against — it MUST increase every release).
#    Edit package.json "version", or:
npm version patch        # 1.0.0 -> 1.0.1   (use minor / major as appropriate)

# 2. Build installers + upload them (and latest.yml / .blockmap) to a GitHub Release.
$env:GH_TOKEN = "<your PAT>"
npm run desktop:publish
```

`electron-builder --publish always` builds the NSIS installer + portable exe (per the `win.target`
config), generates the **`latest.yml`** feed file and a **`.blockmap`** (enables delta downloads),
and uploads all of them to a GitHub Release tagged `v<version>`. The publish config sets
`"releaseType": "release"`, so the release is published **live immediately** — there is no draft
step, and clients can pick it up as soon as the upload finishes.

> If you'd rather review release notes before clients see it, change
> `build.publish[0].releaseType` back to `"draft"` and click **Publish** on the GitHub release
> when ready.

That's the whole loop: **bump version → `npm run desktop:publish`.** Existing installs pick it up on
their next launch.

## What happens on the user's machine

1. At launch (and every 4 hours, or Help → Check for Updates…) `checkForUpdates()` asks the
   company's Privacy & Network policy, then queries the latest GitHub Release.
2. If its version > the installed version, the **"Update available"** banner appears. **Download &
   install** downloads it (with a progress bar); **Later** hides it until the next check.
3. `update-downloaded` fires → the banner switches to **"Update ready"**. The user can click
   **Restart & install now** (quits, installs, relaunches immediately via the `app:quitAndInstall`
   IPC handler) or **Later**.
4. If they chose Later, the NSIS updater applies it on the next quit; relaunch runs the new version.
5. **Data is preserved.** The books are in the user's `.ironbooks` company file, wherever they saved
   it (DESKTOP.md); the working copy (`%LOCALAPPDATA%\Ironbooks\Working`), automatic backups and
   settings (`%APPDATA%\Ironbooks`) are outside the install folder, so the update never touches
   them. "Restart & install now" first asks about a form still being typed, then saves and closes
   the open company file before the installer runs. The first time the new version opens a company
   file, `lib/db/index.ts` makes a safety copy (stamped with the file's pre-upgrade layout, so the
   previous version can still restore it) and runs any **new Drizzle migrations** bundled in the
   release. Always ship the matching `drizzle/` migration files with a release that changes the
   schema. Once a release with new migrations has saved a file, older versions refuse to open it
   (they ask to update).

## Signing caveats

- **Windows:** auto-update works **unsigned**, but SmartScreen warns on first run of each new version,
  and on Windows 11 with Smart App Control **On** an unsigned installer is blocked outright (no "Run
  anyway"; Windows Security > App & browser control > Smart App Control). Sign with an EV/OV
  code-signing cert (see `SIGNING.md`) to remove the warning.
- **macOS:** auto-update **requires** a properly **signed + notarized** build. The self-signed pipeline
  in `SIGNING.md` is enough to run locally but will **not** auto-update on macOS — you need an Apple
  Developer ID cert + notarization for the `.dmg`/`.zip` feed.
- **Linux:** AppImage auto-updates via the same feed; `.deb` does not (users update via apt/manual).

## Testing the update flow before a real release

1. Build `1.0.0` and install it.
2. Bump to `1.0.1`, `npm run desktop:publish`, publish the draft release.
3. Relaunch the installed `1.0.0` — it should detect, download, and toast within a few seconds.
   (Auto-update is disabled in `isDev`, so this only works against an installed build, not `npm run desktop`.)
