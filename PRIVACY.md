# Privacy & Network

Ironbooks is **local-first**. Your company file is a folder on your computer (or on a
drive you choose). Client data is never stored in the cloud, and the app makes no network
connection you have not turned on.

This document lists everything that can leave the machine, and what controls it.

## The short version

| What | Leaves the machine? | Controlled by |
| --- | --- | --- |
| Company data (books, customers, vendors, payroll, attachments) | **Never stored remotely.** | — |
| Multi-user hosting | Only to devices on **your** Tailscale tailnet, or in office-network mode to devices on your private network, and only while hosting is on. Starting tailnet hosting asks Tailscale for an HTTPS certificate, which makes this computer's `*.ts.net` name public (see below). | File > Host multi-user access; File > Switch to Multi-user Mode (office network) |
| AI (assistant, categorization, AI Review "Analyze") | Model servers on this computer, your LAN or your tailnet by default; a cloud AI provider only if opted in (and then redacted) | AI & Automation (providers) + Privacy & Network → AI assistance |
| Emailing an invoice | Only the message and PDF you send, to your SMTP server | Privacy & Network → Email |
| Bank transactions | **Nothing.** Ironbooks never connects to your bank or a feed service; transactions come only from statement files you import. | — |
| Vendor lookup (new vendors only) | Only the vendor's name (store numbers and long digit runs removed), to **your own** SearXNG, which searches public engines. **Off by default**; needs your OK even when SearXNG is on your tailnet; never in Offline mode. | Privacy & Network → Vendor lookup (your SearXNG) |
| AI agents you connect (agent access) | Ironbooks sends nothing by itself. An agent an Admin lets in reads the books on this computer, and what it reads goes to the AI service that runs that agent, **not redacted**. Nothing leaves when the agent runs on a model on your own computer or network. **Off until an Admin makes an agent.** | Users & Roles → Agents; Preferences → Integrated Applications |
| Update checks | App version and platform only (no company data); **on by default** | Privacy & Network → App updates |
| Telemetry / analytics / crash reports | **None.** | — |
| Web fonts / CDNs | **None.** Fonts are bundled at build time. | — |

## Network modes

Each company has a network mode (Settings → **Privacy & Network**). Owners and admins can
change it on the computer that holds the company file; every change is written to the audit
trail.

- **Offline** — the app connects to nothing outside the computer. Email, AI and update checks are
  off. One thing can still happen: if a `*.ts.net` address is saved or used in the app (an AI
  model server, a mail server, your SearXNG), the app looks that name up through this computer's
  normal DNS to check that it really is on your tailnet (see below). Only the name is looked up;
  no connection to it is made.
- **Local network + tailnet** (default) — the app may talk to:
  - this computer (`127.0.0.0/8`, `::1`, `localhost`),
  - your private LAN (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6 `fc00::/7`),
  - your Tailscale tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `*.ts.net`).

  It never connects to the public internet, except the app update check (version and platform
  only, to GitHub Releases), which is on by default and can be turned off. This is enough for
  multi-user hosting, an SMTP relay on your network, or an AI model running on a computer you own.
- **Allow cloud services I choose** — as above, plus the public internet **only** for the
  purposes you switch on individually (AI, email). Those are off until you turn them
  on; update checks stay on unless you turn them off.

Hostnames other than `localhost` and `*.ts.net` are treated as public internet, because a
name can resolve anywhere. A `*.ts.net` name counts as your tailnet only when it resolves to
Tailscale addresses (Tailscale Funnel publishes public names under `ts.net` too), so the app
looks such a name up before deciding. Link-local and cloud-metadata addresses (`169.254.0.0/16`,
`fe80::/10`), multicast and other special ranges are never contacted.

An administrator can cap a machine with the `BKA_NETWORK_MODE` environment variable
(`offline`, `tailnet-only` or `allow-cloud`, any letter case). The effective mode is the stricter
of that cap and the company setting. A value that is set but not recognised counts as `offline`.

**A company file from another computer.** The network mode, the AI servers, the mail server and
the report schedules travel inside the company file, so a file someone sends you could arrive with
internet services already switched on. Until an Admin at this computer approves the file, it is
capped at *Local network + tailnet* whatever its own settings say: AI, email and vendor lookup do
not reach the public internet, and its report schedules that email wait (they then run by
themselves). This computer, your LAN and your tailnet keep working as the file's settings say (a
local AI, an office mail relay); Offline stays Offline; app update checks keep their own rule (they
send no company data). If the file's own settings would reach the internet, Privacy & Network shows
one note listing those destinations (host names only) with **Allow on this computer**. The approval
is a stamp in the file that only this computer can make: an HMAC under the secret Windows keeps for
this computer's Ironbooks (the one that seals saved AI and mail keys), which no file, copy or backup
carries. A file is approved without asking when this computer already knew it before this
rule existed (Recent Companies, files signed in to here), when it was made here as a new company
file, when it is a copy of an approved file (Save Copy As, a sandbox or training file, this
computer's own backup), or when its own settings reach nothing on the internet and an Admin here
saves its network settings. An Accountant's Copy or a portable file made on another computer is
not approved here until allowed. Where Ironbooks has no protected secret (Linux without a keyring),
files are not held.

## How it is enforced

- **Server:** every outbound call from the app server goes through one gate,
  `lib/net/guard.ts` (`assertOutboundAllowed` and `policyFetch`), which applies the rules in
  `lib/net/policy.ts`. A blocked call fails with a plain-English message and never opens a
  connection. Redirects are checked hop by hop, so an allowed host cannot bounce a request to a
  disallowed one. Today that covers SMTP (email) and every AI provider
  configured in AI & Automation (Ollama / OpenAI-compatible / Anthropic / your ChatGPT plan, see
  `lib/ai/providers.ts` and `lib/ai/chatgpt.ts`); new integrations must use the same gate.
- **Set up free AI (desktop app):** after you confirm, the app downloads Ollama's installer from
  `ollama.com` (which may hand off to GitHub), checks it is signed by Ollama, and starts it. This
  follows the *App updates* purpose (blocked in Offline mode or when updates are turned off). Your
  books are not sent anywhere; the model then runs on this computer.
- **Continue with ChatGPT:** you sign in on OpenAI's own page in your web browser; Ironbooks never
  sees your password. For the sign-in, Ironbooks listens on `127.0.0.1` (this computer only) for
  OpenAI to hand back a one-time code, then stops listening. The resulting sign-in (an access and
  refresh token, plus your ChatGPT account email) is sealed inside the company file like an API
  key. Requests go to `api.openai.com` with `store: false`, redacted like every cloud AI call, and
  count against your ChatGPT plan's usage. **Disconnect** on the AI page removes the sign-in and
  signs Ironbooks out at OpenAI.
- **Recent network activity:** the Privacy & Network page lists every outbound attempt since the
  app started: destination host, purpose and whether it was allowed. It never records the
  content, headers or query strings.
- **Desktop app (Electron):**
  - The window can only load the app itself (the local server, or the host you connected to).
    Navigation and pop-ups to other sites are blocked. A normal `https` link you click opens in
    your own web browser.
  - Every request the window makes is filtered. Requests to other origins (CDNs, fonts,
    trackers, third-party bank widgets) are cancelled and logged.
  - `contextIsolation`, `sandbox` and no Node integration are on. There is no `<webview>` and
    no permission prompts (camera, microphone, location, notifications).
  - Spell check is on (each user can turn it off in My Preferences > Spelling). On Windows and
    macOS it uses the operating system's own spell checker, so no dictionaries are downloaded.
    On other systems the dictionary download address points at this computer, where nothing
    answers, so nothing is downloaded and spell check works only with dictionaries already
    installed.
  - The page also sends a strict Content-Security-Policy and related headers
    (`next.config.js`).
  - **Updates** are checked unless the company turns off the *App updates* purpose (or is in
    Offline mode, or the computer's `BKA_NETWORK_MODE` ceiling is below allow-cloud). The app
    asks before downloading a new version.
  - Next.js telemetry is disabled for the app server (`NEXT_TELEMETRY_DISABLED=1`).

User actions that open your system browser are not data transfers by the app. These are
**Help → Ironbooks on the web** and the IRS FIRE upload link.

## Multi-user hosting

Like QuickBooks Enterprise, one computer can **host** a company file for up to 40 people logged in
at once (further sign-ins over the network are refused until someone logs out).

- **File > Host multi-user access** keeps the app server on `127.0.0.1`. It adds a small
  forwarding service on this computer's **Tailscale address** only. An address counts as the
  Tailscale address only when Tailscale itself reports it (`tailscale status --json`, or
  `tailscale ip -4`) and it is on one of this computer's network adapters. Some internet providers
  hand out addresses in Tailscale's range (`100.64.0.0/10`) too, so an address in that range is
  never taken as Tailscale's on its own. When Tailscale is not installed, stopped or signed out,
  hosting does not start and says Tailscale is not running.
- **Office-network mode** (File > Switch to Multi-user Mode, or letting someone on the same network
  into a company file on a shared drive) also keeps the app server on `127.0.0.1`. The forwarding
  service listens only on this computer's own network addresses that it shows to teammates, plus
  its Tailscale address when Tailscale confirms one. It can be reached by devices on your private
  network that can route to those addresses (another subnet of the office, a VPN between sites);
  connections from public internet addresses are refused before anything is read. Every teammate
  still has to sign in, over an HTTPS connection that uses this computer's own certificate, which
  their Ironbooks recognises by its fingerprint. If the computer's address changes on the same
  network (Wi-Fi reconnecting, a new address from the router), the service follows it. If the
  computer moves to a different network, it stops listening on the old address (once the address
  has been gone for two checks, about 10 to 20 seconds) and does not listen on the new network
  until multi-user mode is turned off and on again there.
- The app never listens on every interface (`0.0.0.0`) unless you set `hosting.bindAll` in the app
  config yourself. Even then, connections from public addresses are refused.
- The forwarding service answers only to the addresses and names it shares with teammates, so a
  web page that renames itself to this computer's address is refused. It allows each device 20
  connections at once (400 in all) and closes a connection that has not finished starting a
  request within about 10 seconds (the upload that follows, such as a backup, may take longer).
- Each time tailnet hosting starts, the app runs `tailscale cert` to get an HTTPS certificate for the
  computer's `*.ts.net` name. If HTTPS certificates are turned on for your tailnet, Tailscale
  contacts its own servers and Let's Encrypt to issue it, and the host serves HTTPS. Otherwise
  traffic is plain HTTP inside the tailnet, which Tailscale already encrypts end to end.
- **This makes the computer's tailnet name public.** Like every publicly trusted certificate,
  the one Let's Encrypt issues is recorded in public Certificate Transparency logs, which anyone
  can search. The computer's full `*.ts.net` name (for example `office-pc.tail1234.ts.net`, the
  computer's name plus your tailnet's name) is then visible to anyone. Nothing from the company
  file is in it. To avoid this, leave HTTPS certificates turned off for your tailnet in the
  Tailscale admin console, or set `hosting.tls` to `false` in the app config.
- The private keys of the hosting certificates (the tailnet certificate and this computer's own
  office-network certificate) are kept wrapped by the operating system where it can protect them
  (Windows' data protection for your Windows account), not as plain files.
- Every request needs a sign-in with a personal user account. Sign-in is rate-limited (attempts
  still being checked count too), and the company-file password and employee portal sign-in are
  limited the same way. Wrong passwords from one device lock only that device out of that account
  (5 tries, then a wait that grows from 1 minute to an hour). Wrong passwords for one account from
  many devices, and from everyone together, slow further tries down (after 30 for one account,
  one try every 5 minutes; after 50 in all, one a minute) but never lock anyone out for longer.
  A device that has already signed in to an account is not slowed down by other devices' wrong
  passwords. Failed attempts from other computers, or from other programs on this computer, never
  lock out sign-in in Ironbooks on the host computer itself. Remote devices cannot use the
  no-account first-run mode. They cannot create accounts, and they never receive password-reset
  tokens.
- From another computer, even an Admin cannot add an AI server or change its address, turn on
  cloud AI, test AI connections, download AI models or list the host's tailnet. They cannot set
  up, change or remove the mail server, or test mail settings they typed, and they cannot change
  Privacy & Network. These settings decide where the host computer connects, so they are changed
  on the computer that holds the company file. Others can still see them (passwords and keys stay
  hidden), switch saved AI on or off and choose its model, and send a test email through the
  saved mail server.
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

## Agent access

An Admin can let an AI agent read one company's books ([`AGENT_ACCESS.md`](./AGENT_ACCESS.md)).
A company file with no agents behaves exactly as before.

- The agent reaches the books through the app's own server on this computer (`127.0.0.1`). Nothing
  new listens on the network, and an agent does not work through multi-user hosting.
- While a company file with an agent is open and someone has signed in, Ironbooks writes one small
  file in your own profile folder (`%LOCALAPPDATA%\Ironbooks\agent-endpoints`) so the agent's
  connector can find the app. It holds the app's local port and a check value for that run, nothing
  from the books, and is removed when the app closes or the last agent is removed.
- An agent only reads in this version, and only what its role allows. It never sees full Social
  Security numbers or full account numbers, and it cannot change where this computer connects.
- Only a keyed digest of the agent's access token is stored, tied to this computer and this company
  file. A copy of the file, a backup or a portable file carries no agent that works elsewhere, and
  restoring a backup removes every agent's access.
- **What the agent reads is sent to whatever AI service runs it, as it is.** The redaction Ironbooks
  applies to its own cloud AI calls does not apply to an outside agent. Run the agent on a model on
  your own computer or network to keep everything local.

## Receipts (photos and PDFs)

- Receipts are read **on this computer**: PDF text with pdf.js, photos with the bundled offline
  text recognition (tesseract.js; the engine and English language data ship with the app, nothing
  is downloaded). A company can instead pick its own AI model on this computer, the LAN or the
  tailnet (an Ollama vision model). Photos are never sent to a cloud AI service, even when cloud
  AI is turned on, because a picture cannot be redacted.
- **Send receipts from your phone** makes a QR code for a link that works for one company only,
  for 15 minutes and up to 20 uploads, and can be turned off early. Only a hash of the link's
  secret is stored. The phone needs to reach this computer over the tailnet (multi-user hosting).
  The link can only add files to that company's receipts inbox; it can't read anything. Guessing
  links is rate-limited, and files are checked by their content (photos and PDFs only, up to
  15 MB).

## Data at rest

- The company file is a local PGlite (embedded Postgres) database packed into one file
  (`ABC Company.ironbooks`). A company file **protected with its passwords** (the default for new
  files; Company > Security for older ones) is encrypted with AES-256-GCM under a random file key;
  only its own user names and passwords, challenge answers or its recovery key unlock that key
  (scrypt key slots in the file). Only the company name, file id, save dates and app version stay
  readable, so the No Company Open list can show the file. Nothing about the password or the key is
  sent anywhere: unlocking happens on the computer that opens the file.
- While the file is open its books are decrypted only into a private working copy on that
  computer (`%LOCALAPPDATA%\Ironbooks\Working`), which is deleted after a clean close.
- Backups, safety copies, condense archives, Save Copy As and "unsaved changes" copies of a
  protected file are encrypted the same way. Portable company files, Period Copies and Accountant's
  Copy transfer files are offered with a password (on by default; required for a protected file),
  and never carry the original file's key — each copy gets its own.
- The file key changes whenever a password is changed or reset, a challenge answer is changed, a
  user is made inactive or a new recovery key is made (and on request, Company > Security): older
  copies of the file and replaced passwords then open nothing saved afterwards.
- A challenge answer opens a protected file only when it is at least 10 characters long (a short
  answer to a known question could be guessed offline from a copy of the file), and only on a
  computer that has opened the file before. On any other computer the file opens with a password
  or the recovery key.
- The plain listing (company name, file id, save dates, app version, user-name lookup tags) is
  readable without a password, and a guessed user name can be confirmed against a copy of the file.
- "Try it on a copy" sandboxes are kept in `%LOCALAPPDATA%\Ironbooks\Sandboxes` (never the roaming
  profile); a protected file's leftover sandbox copies are removed when the file is closed cleanly.
- Backups (`.bka`) are written to your own disk, including the automatic rotating backups in
  the app's data folder.
- Sign-in sessions are stored in the company file (`user_sessions`) so admins can see and
  revoke them. They record the client address, browser/app identifier and times, and nothing
  else.
