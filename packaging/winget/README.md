# Ironbooks in winget (Windows Package Manager)

`winget install RealDealCPA-VR.Ironbooks` installs Ironbooks without the browser download, so
Windows doesn't show "Windows protected your PC" for it: winget checks the installer against the
SHA-256 in these manifests before running it.

The manifests for each release live here (`<version>/`). They are published by a pull request to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) under
`manifests/r/RealDealCPA-VR/Ironbooks/<version>/`; Microsoft's checks run on the PR and a
moderator merges it, usually within a few days.

## A new release

1. Copy the previous version's folder and change `PackageVersion`, `InstallerUrl`,
   `ReleaseDate`, `ReleaseNotesUrl` and the `DisplayName` (`Ironbooks <version>`).
2. `InstallerSha256`: download `Ironbooks-Setup-<version>.exe` from the release and run
   `(Get-FileHash Ironbooks-Setup-<version>.exe).Hash`. A signed installer has a different hash
   from the unsigned build, so always hash the file attached to the release.
3. `winget validate --manifest packaging/winget/<version>`.
4. Submit: `wingetcreate submit packaging/winget/<version>` (needs a GitHub token), or open the
   pull request to microsoft/winget-pkgs by hand.

`ProductCode` (`1e5db7f1-93dd-5df9-90f5-5738b06d6083`) is the installer's uninstall key; it
comes from the app id `com.bookkeeperai.desktop` and doesn't change between versions.
