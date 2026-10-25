# Code Signing

An unsigned installer makes Windows SmartScreen say "Windows protected your PC" (unknown
publisher) when people download it. Signing removes that. The release workflow
(`.github/workflows/release.yml`) signs automatically as soon as ONE of these is set up in the
GitHub repository; with none, releases are built unsigned exactly as before.

## Turn on signing for releases (GitHub)

**Azure Trusted Signing (Microsoft's signing service — the route chosen for this project):**
1. In the Azure portal (an Azure subscription is needed): create a **Trusted Signing account**.
   Note its region's endpoint, for example `https://eus.codesigning.azure.net/` (East US).
2. In the account: **Identity validation** → New → Public. Microsoft checks the name that will
   appear as the publisher (an organization, or an individual developer where offered). This can
   take a few days.
3. When it is approved: **Certificate profiles** → Create → *Public Trust*, using that identity.
4. Microsoft Entra ID → **App registrations** → New registration (for example
   `ironbooks-release-signing`) → Certificates & secrets → New client secret. Note the
   Directory (tenant) ID, Application (client) ID and the secret's value.
5. Back on the Trusted Signing account → Access control (IAM) → Add role assignment →
   **Trusted Signing Certificate Profile Signer** → the app registration from step 4.
6. GitHub → the repository → Settings → Secrets and variables → Actions:
   - secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (step 4);
   - variables `AZURE_SIGNING_ENDPOINT` (step 1), `AZURE_SIGNING_ACCOUNT` (the Trusted Signing
     account's name), `AZURE_CERT_PROFILE` (step 3's profile name) and `AZURE_PUBLISHER_NAME`
     (the validated name, exactly as the certificate shows it — the CN).
7. Tag a release as usual. electron-builder signs the app, the installer and the portable
   build while it builds. If only some of the settings are there, the release stops with a
   message naming the missing one instead of shipping unsigned.

The publisher name is also written into the app's update settings: from the first signed
release on, installed copies accept only updates signed by that publisher, so keep signing
turned on for later releases. Copies of unsigned versions (1.6.0 and earlier) update to the
signed release as usual. Azure's certificates last only a few days and renew themselves;
nothing needs replacing each year.

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

**A code-signing certificate you bought (OV/EV) as a .pfx file:**
1. Secrets `WIN_CSC_LINK` (the .pfx, base64-encoded: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`)
   and `WIN_CSC_KEY_PASSWORD`.
2. Tag a release: electron-builder signs every file while it builds.

Signed downloads name the publisher instead of "Unknown publisher". SmartScreen also weighs how
many people have downloaded a publisher's files, so for a brand-new publisher it can still show
its warning for the first downloads, whichever kind of signing is used; that fades as people
download and run the signed installer.

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
