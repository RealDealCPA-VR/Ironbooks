# Code Signing

An unsigned installer makes Windows SmartScreen say "Windows protected your PC" (unknown
publisher) when people download it. Signing removes that. The release workflow
(`.github/workflows/release.yml`) signs automatically as soon as ONE of these is set up in the
GitHub repository; with neither, releases are built unsigned exactly as before.

## Turn on signing for releases (GitHub)

**SignPath Foundation (free for open source — the route this project applied for):**
1. When the SignPath application is approved, create the project and a signing policy there.
2. Repository → Settings → Secrets and variables → Actions:
   - secret `SIGNPATH_API_TOKEN` — a SignPath CI user's API token;
   - variable `SIGNPATH_ORGANIZATION_ID`;
   - variables `SIGNPATH_PROJECT_SLUG` (default `Ironbooks`) and `SIGNPATH_SIGNING_POLICY_SLUG`
     (default `release-signing`) if yours differ.
3. Tag a release as usual. The workflow builds the installers, has SignPath sign them, rebuilds
   the update feed for the signed files (`scripts/refresh-update-info.mjs` — the sha512 and block
   map change when a file is signed, and installed copies check them), then publishes.

**A code-signing certificate you bought (OV/EV) or Azure Trusted Signing exported as .pfx:**
1. Secrets `WIN_CSC_LINK` (the .pfx, base64-encoded: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`)
   and `WIN_CSC_KEY_PASSWORD`.
2. Tag a release: electron-builder signs every file while it builds.

A new certificate still has to earn SmartScreen reputation over the first downloads; an EV
certificate (or Azure Trusted Signing) is trusted at once.

## Signing a local build

The installer build supports Authenticode signing via electron-builder's standard env vars.

## With a real (trusted) certificate — production
Obtain a code-signing certificate from a CA (DigiCert, Sectigo, etc.). Then:

```powershell
$env:CSC_LINK = "C:\path\to\your-cert.pfx"
$env:CSC_KEY_PASSWORD = "your-cert-password"
npm run desktop:dist
```

The resulting installer is trusted by Windows SmartScreen once the cert has reputation.
For macOS notarization also set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## With a self-signed certificate — local/testing
A self-signed cert is generated at `build/code-sign.pfx` (password `bookkeeper-dev`, gitignored).
This produces a **signed** installer; Windows will still warn because the cert isn't CA-trusted —
install the cert into "Trusted Root Certification Authorities" to remove the warning on your own machine.

```powershell
$env:CSC_LINK = "build\code-sign.pfx"
$env:CSC_KEY_PASSWORD = "bookkeeper-dev"
npm run desktop:dist
```

Regenerate the self-signed cert:
```powershell
$p = ConvertTo-SecureString "bookkeeper-dev" -Force -AsPlainText
$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Ironbooks (Self-Signed)" -CertStoreLocation Cert:\CurrentUser\My
Export-PfxCertificate -Cert $c -FilePath build\code-sign.pfx -Password $p
Remove-Item "Cert:\CurrentUser\My\$($c.Thumbprint)"
```
