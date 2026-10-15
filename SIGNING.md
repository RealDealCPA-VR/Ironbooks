# Code Signing

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
