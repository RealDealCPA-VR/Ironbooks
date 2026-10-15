# Privacy & Network

Ironbooks is **local-first**. Your company file is a folder on your computer (or on a
drive you choose). Client data is never stored in the cloud, and the app makes no network
connection you have not turned on.

This document lists everything that can leave the machine, and what controls it.

## The short version

| What | Leaves the machine? | Controlled by |
| --- | --- | --- |
| Company data (books, customers, vendors, payroll, attachments) | **Never stored remotely.** | — |
| Multi-user hosting | Only to devices on **your** Tailscale tailnet, and only while hosting is on | File > Host multi-user access |
| AI (assistant, categorization, AI Review "Analyze") | Model servers on this computer, your LAN or your tailnet by default; a cloud AI provider only if opted in (and then redacted) | AI & Automation (providers) + Privacy & Network → AI assistance |
| Emailing an invoice | Only the message and PDF you send, to your SMTP server | Privacy & Network → Email |
| Bank feeds (Plaid) | Plaid credentials and the bank link token; transactions download into the file | Privacy & Network → Bank feeds |
| Update checks | App version and platform only (no company data); **on by default** | Privacy & Network → App updates |
| Telemetry / analytics / crash reports | **None.** | — |
| Web fonts / CDNs | **None.** Fonts are bundled at build time. | — |

## Network modes

Each company has a network mode (Settings → **Privacy & Network**). Owners and admins can
change it; every change is written to the audit trail.

- **Offline** — nothing leaves the computer. Email, bank feeds, AI and update checks are off.
- **Local network + tailnet** (default) — the app may talk to:
  - this computer (`127.0.0.0/8`, `::1`, `localhost`),
  - your private LAN (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6 `fc00::/7`),
  - your Tailscale tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `*.ts.net`).

  It never connects to the public internet, except the app update check (version and platform
  only, to GitHub Releases), which is on by default and can be turned off. This is enough for
  multi-user hosting, an SMTP relay on your network, or an AI model running on a computer you own.
- **Allow cloud services I choose** — as above, plus the public internet **only** for the
  purposes you switch on individually (AI, email, bank feeds). Those are off until you turn them
  on; update checks stay on unless you turn them off.

Hostnames other than `localhost` and `*.ts.net` are treated as public internet, because a
name can resolve anywhere. Link-local and cloud-metadata addresses (`169.254.0.0/16`,
`fe80::/10`), multicast and other special ranges are never contacted.

An administrator can cap a machine with the `BKA_NETWORK_MODE` environment variable
(`offline`, `tailnet-only` or `allow-cloud`, any letter case). The effective mode is the stricter
of that cap and the company setting. A value that is set but not recognised counts as `offline`.

## How it is enforced

- **Server:** every outbound call from the app server goes through one gate,
  `lib/net/guard.ts` (`assertOutboundAllowed` and `policyFetch`), which applies the rules in
  `lib/net/policy.ts`. A blocked call fails with a plain-English message and never opens a
  connection. Redirects are checked hop by hop, so an allowed host cannot bounce a request to a
  disallowed one. Today that covers Plaid (bank feeds), SMTP (email) and every AI provider
  configured in AI & Automation (Ollama / OpenAI-compatible / Anthropic, see
  `lib/ai/providers.ts`); new integrations must use the same gate.
- **Recent network activity:** the Privacy & Network page lists every outbound attempt since the
  app started: destination host, purpose and whether it was allowed. It never records the
  content, headers or query strings.
- **Desktop app (Electron):**
  - The window can only load the app itself (the local server, or the host you connected to).
    Navigation and pop-ups to other sites are blocked. A normal `https` link you click opens in
    your own web browser.
  - Every request the window makes is filtered. Requests to other origins (CDNs, fonts,
    trackers) are cancelled and logged. Plaid's domains are allowed only once the company has
    opted in to cloud bank feeds.
  - `contextIsolation`, `sandbox` and no Node integration are on. There is no `<webview>`, no
    permission prompts (camera, microphone, location, notifications), and the spellchecker is
    off, because Chromium would otherwise download dictionaries.
  - The page also sends a strict Content-Security-Policy and related headers
    (`next.config.js`).
  - **Updates** are checked unless the company turns off the *App updates* purpose (or is in
    Offline mode, or the computer's `BKA_NETWORK_MODE` ceiling is below allow-cloud). The app
    asks before downloading a new version.
  - Next.js telemetry is disabled for the app server (`NEXT_TELEMETRY_DISABLED=1`).

User actions that open your system browser are not data transfers by the app. These are
**Help → Ironbooks on the web**, the IRS FIRE upload link and the Plaid sign-up link.

## Multi-user hosting (tailnet only)

Like QuickBooks Enterprise, one computer can **host** a company file for up to 40 people logged in
at once (further sign-ins over the network are refused until someone logs out).

- **File > Host multi-user access** keeps the app server on `127.0.0.1`. It adds a small
  forwarding service on this computer's **Tailscale address** only (detected with
  `tailscale ip -4`, or from the network interfaces in `100.64.0.0/10`). The app never listens on
  every interface (`0.0.0.0`) unless you set `hosting.bindAll` in the app config yourself. Even
  then, connections from public addresses are refused.
- If `tailscale cert` can issue a certificate for the computer's `*.ts.net` name, the host
  serves HTTPS. Otherwise traffic is plain HTTP inside the tailnet, which Tailscale already
  encrypts end to end.
- Every request needs a sign-in with a personal user account. Sign-in is rate-limited per
  account, per address and overall (attempts still being checked count too), and the
  company-file password and employee portal sign-in are limited the same way. Failed attempts
  from other computers never lock out sign-in on the host computer itself. Remote devices cannot use the no-account first-run mode. They
  cannot create accounts, and they never receive password-reset tokens.
- The host is the only computer that writes to the company file. If two people edit the same
  invoice, bill, journal entry, customer, vendor or item, the second save is refused with
  *"This record was changed by … at …. Reload to see the latest."*
- **Settings → Multi-user** shows who is logged in to your company and lets an admin sign them
  out. It also switches the company to **single-user mode**. Condense Data, Rebuild Data and
  Import require single-user mode while anyone else in the company is connected. When one file
  holds several companies, each company's admins see and control only their own company's
  users. Restore replaces the whole file, so it also needs every other company's users to log
  out (they are counted, not named). Idle sessions are ended before these utilities run.
- On another computer, **File > Open company on host…** accepts only tailnet or LAN addresses.
  The company data stays on the host. A client never backs up, hosts or updates on the host's
  behalf.

## Data at rest

- The company file is a local PGlite (embedded Postgres) folder.
- Backups (`.bka`) are written to your own disk, including the automatic rotating backups in
  the app's data folder.
- Sign-in sessions are stored in the company file (`user_sessions`) so admins can see and
  revoke them. They record the client address, browser/app identifier and times, and nothing
  else.
