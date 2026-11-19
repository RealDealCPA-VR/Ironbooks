# Security Policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue, pull request or discussion.
On GitHub, open this repository's **Security** tab and choose **Report a vulnerability**. That
uses GitHub's private vulnerability reporting: only you and the maintainers can see the report.

Helpful things to include:

- what the problem is, and what someone could do with it;
- the Ironbooks version (Help → About) and your version of Windows, or how you ran it from source;
- steps to reproduce it, or a small proof of concept;
- anything it depends on: multi-user hosting, a network mode in Privacy & Network, a crafted
  company file or import file, a cloud AI provider.

Ironbooks is maintained by a small team. Reports are read and answered on a best-effort basis,
and we keep the conversation in the private report while a fix is prepared. Please give us a
fair chance to release that fix before you publish details.

Problems in other projects Ironbooks works with (Tailscale, Ollama, an AI provider, your mail
server) belong with those projects.

## Supported versions

Fixes go into the latest release only; older versions are not patched. Installed copies check
for new releases themselves and offer to install them (unless a company has turned update checks
off in Privacy & Network), so a fix reaches people through the normal update.

## Security model in short

Ironbooks is a local-first desktop app. The books live in a company file on your own computer,
or on a drive you choose; nothing is stored in the cloud, and there is no telemetry, analytics or
crash reporting. The app's built-in server listens only on this computer (`127.0.0.1`). Every
connection it makes goes through one network policy (Offline, local network and tailnet, or
cloud services you switch on one at a time), and the desktop window loads only the app itself,
with Chromium's sandbox and a strict Content-Security-Policy. [`PRIVACY.md`](./PRIVACY.md) lists
everything that can leave the computer and the switch for each. Saved keys for outside services
(AI providers, the mail server password) are kept for the Windows account that entered them.

A company file can be protected with a password. The file is then encrypted with a random key
that only its users' passwords, challenge answers or its recovery key can unlock, and its
backups and copies are encrypted the same way. Multi-user hosting is off until someone turns it
on. It then serves the company file only to devices on your own network or your own Tailscale
tailnet; each person signs in with their own user account and role, and sign-in attempts are
limited.
