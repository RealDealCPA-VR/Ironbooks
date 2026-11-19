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

## How a release is made

Releases are built and published only by GitHub Actions. Pushing a tag `v<version>` starts
[`.github/workflows/release.yml`](./.github/workflows/release.yml), which runs on a Windows
runner and:

1. installs the dependencies (`npm ci`);
2. creates a **draft** GitHub Release for the tag, which installed copies cannot see yet;
3. builds the app and uploads into that draft the NSIS installer
   (`Ironbooks-Setup-<version>.exe`), its `.blockmap` (for smaller, delta downloads), the
   portable `Ironbooks-<version>.exe` and the `latest.yml` update feed. When signing is set up
   (`SIGNING.md`) the files are signed first;
4. checks that all four files are on the release, then publishes it and marks it **Latest**.
   Installed copies pick it up from that moment.

The workflow uploads with the token GitHub Actions gives each run (`GITHUB_TOKEN`, which can
write releases for this repository only). No personal access token is needed. Pushing a tag is
the only supported way to publish: do not run `npm run desktop:publish` (the command the
workflow uses) on your own computer.

The update feed is this repository's public GitHub Releases, so installed copies read it without
a token.

## Before tagging

- **CI on `main` must be green for the exact commit you are tagging** (Actions → CI). The release
  workflow builds the installers but does not run the tests.
- `package.json` `"version"` (and `package-lock.json`) must already hold the new version, and the
  tag must be that version with a `v` in front. The files are named after `package.json`'s
  version (and electron-builder uploads to the release of that name), so with a mismatch the
  tag's own release never gets its files and is never published.
- The version must be higher than the last release: installed copies compare it with their own.
- A release that changes the database layout ships its new `drizzle/` migration files.

## Cut a release

```powershell
# 1. Bump the version in package.json and package-lock.json (patch / minor / major as fits),
#    commit it and push it to main.
npm version patch --no-git-tag-version
git commit -am "Version 1.2.3"
git push origin main

# 2. When CI has passed on that commit, tag it and push the tag. This starts the release.
git tag v1.2.3
git push origin v1.2.3
```

Follow the run under Actions → Release. When it finishes, the release is live and existing
installs offer the update at their next check.

If the workflow fails, nothing is published: the release stays a draft that installed copies
never see. If the failure was temporary (a network error, for example), re-run the workflow from
the Actions page; it reuses the same draft. If the code needs a fix, delete the draft release and
release the fix under the next version number.

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
  anyway"; Windows Security > App & browser control > Smart App Control). Turn on signing for
  releases (`SIGNING.md`: Azure Artifact Signing, SignPath or a certificate) to remove the warning.
  From the first signed release on, installed copies accept only updates signed by the same
  publisher.
- **macOS:** auto-update **requires** a properly **signed + notarized** build. The self-signed pipeline
  in `SIGNING.md` is enough to run locally but will **not** auto-update on macOS — you need an Apple
  Developer ID cert + notarization for the `.dmg`/`.zip` feed.
- **Linux:** AppImage auto-updates via the same feed; `.deb` does not (users update via apt/manual).
- The release workflow builds the Windows installers only; macOS and Linux builds are not
  published today.

## Checking the update flow

1. Install the current release from GitHub (`Ironbooks-Setup-<version>.exe`).
2. Release the next version with a tag, as above.
3. When the release is live, start the installed copy (or Help → Check for Updates…). It should
   offer the update within a few seconds, download it and install it.
   (Auto-update is disabled in `isDev`, so this only works against an installed build, not `npm run desktop`.)
