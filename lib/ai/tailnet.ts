/**
 * Tailnet helpers — classify where a model endpoint lives and (optionally) discover peers.
 *
 * The classes are EXACTLY the network policy's (lib/net/cidr.ts classifyHost), because the AI
 * router trusts them: a 'local' provider gets unredacted data and skips the company's cloud
 * opt-in, so anything the network policy would treat as the internet must be 'cloud' here too.
 *  - loopback: 127.0.0.0/8, ::1, localhost
 *  - lan:      RFC 1918 (10/8, 172.16/12, 192.168/16) and IPv6 ULA fc00::/7 addresses
 *  - tailnet:  Tailscale CGNAT range 100.64.0.0/10, Tailscale ULA fd7a:115c:a1e0::/48, and *.ts.net
 *              names verified to resolve only to those (lib/net/tailnetVerify.ts) — Tailscale
 *              Funnel names under ts.net are public, so an unverified *.ts.net name is 'public'
 *  - public:   anything else, INCLUDING short or "local" names (gpu-box, studio.local, nas.lan,
 *              *.internal): a name could resolve anywhere (a DNS search domain, a public DNS
 *              answer), so it is never trusted with unredacted data. Use the machine's IP address
 *              or its full *.ts.net name.
 *  - invalid:  link-local (169.254/16, fe80::/10 — includes cloud metadata), 0/8, multicast, …
 *
 * Plain-HTTP to a PUBLIC host sends client data over the open internet unencrypted — the UI
 * warns loudly. HTTP inside the tailnet is fine (WireGuard already encrypts the hop).
 */
import { execFile } from 'node:child_process';
import type { HostClass } from './types';
import { classifyHost as classifyNetworkHost } from '@/lib/net/cidr';

/** Classify a bare host (no scheme/port) — the network policy's own classification. */
export function classifyHost(rawHost: string): HostClass {
  return classifyNetworkHost(rawHost);
}

/** A host NAME (not an address) that only looks local: single-label or a .local-style suffix. */
function looksLocalName(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || /^[\d.]+$/.test(h)) return false;
  return !h.includes('.') || /\.(local|lan|home\.arpa|internal|localdomain|corp|home)$/.test(h);
}

export interface EndpointClassification {
  hostClass: HostClass;
  protocol: 'http' | 'https' | null;
  host: string | null;
  /** Human-readable warning to surface in the settings UI, or null. */
  warning: string | null;
  /** True when the endpoint is on this machine / LAN / tailnet (may receive unredacted data). */
  isPrivate: boolean;
}

/** Classify a base URL and produce the UI warning (public HTTP → strong warning). */
export function classifyEndpoint(baseUrl: string | null | undefined): EndpointClassification {
  if (!baseUrl) {
    return { hostClass: 'invalid', protocol: null, host: null, warning: 'No URL configured.', isPrivate: false };
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { hostClass: 'invalid', protocol: null, host: null, warning: 'Not a valid URL.', isPrivate: false };
  }
  const protocol = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : null;
  if (!protocol) {
    return { hostClass: 'invalid', protocol: null, host: url.hostname, warning: 'URL must start with http:// or https://.', isPrivate: false };
  }
  const hostClass = classifyHost(url.hostname);
  let warning: string | null = null;
  if (hostClass === 'public' && looksLocalName(url.hostname)) {
    warning = `${url.hostname} is a name that could point anywhere, so it is treated as a CLOUD model (data is redacted, cloud AI must be on and Privacy & Network must allow it). To keep it local, use the machine's IP address (192.168.x.x or 100.x.y.z) or its full Tailscale name (*.ts.net).`;
  } else if (hostClass === 'public' && protocol === 'http') {
    warning =
      'This is a PUBLIC address over plain HTTP — anything sent is readable on the internet. Use your Tailscale address (100.x.y.z or *.ts.net) or HTTPS.';
  } else if (hostClass === 'public') {
    warning = 'This is a public internet address. It is treated as a CLOUD model: data is redacted and cloud must be enabled.';
  } else if (hostClass === 'lan' && protocol === 'http') {
    warning = 'Local network over HTTP — fine on a trusted network; prefer the machine’s Tailscale address.';
  } else if (hostClass === 'invalid') {
    warning = 'This address cannot be used (link-local, reserved or not a valid host name).';
  }
  return {
    hostClass,
    protocol,
    host: url.hostname,
    warning,
    isPrivate: hostClass === 'loopback' || hostClass === 'lan' || hostClass === 'tailnet',
  };
}

// ---------------------------------------------------------------------------
// Peer discovery via `tailscale status --json`
// ---------------------------------------------------------------------------

export interface TailnetPeer {
  hostName: string;
  dnsName: string | null;
  ips: string[];
  os: string | null;
  online: boolean;
  self: boolean;
}

export interface DiscoveryResult {
  available: boolean;
  /** Why discovery was unavailable (CLI missing, not logged in, …). */
  reason?: string;
  tailnetName?: string | null;
  peers: TailnetPeer[];
}

/** Runs a command and returns stdout. Injectable so tests never spawn processes. */
export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

interface RawNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
}

function toPeer(n: RawNode, self: boolean): TailnetPeer {
  return {
    hostName: n.HostName ?? '',
    dnsName: n.DNSName ? n.DNSName.replace(/\.$/, '') : null,
    ips: Array.isArray(n.TailscaleIPs) ? n.TailscaleIPs : [],
    os: n.OS ?? null,
    online: self ? true : n.Online === true,
    self,
  };
}

/** Parse `tailscale status --json` output. Exported for tests. */
export function parseTailscaleStatus(json: string): DiscoveryResult {
  let data: { Self?: RawNode; Peer?: Record<string, RawNode>; MagicDNSSuffix?: string; BackendState?: string };
  try {
    data = JSON.parse(json);
  } catch {
    return { available: false, reason: 'Could not parse tailscale status output.', peers: [] };
  }
  if (data.BackendState && data.BackendState !== 'Running') {
    return { available: false, reason: `Tailscale is ${data.BackendState}.`, peers: [] };
  }
  const peers: TailnetPeer[] = [];
  if (data.Self) peers.push(toPeer(data.Self, true));
  for (const n of Object.values(data.Peer ?? {})) peers.push(toPeer(n, false));
  peers.sort((a, b) => Number(b.online) - Number(a.online) || a.hostName.localeCompare(b.hostName));
  return { available: true, tailnetName: data.MagicDNSSuffix ?? null, peers };
}

/**
 * Discover tailnet peers. Never throws: when the CLI is missing or Tailscale is down the
 * result is `{ available: false, reason }` and the UI simply hides the picker.
 */
export async function discoverTailnetPeers(
  runner: CommandRunner = defaultRunner,
): Promise<DiscoveryResult> {
  const candidates =
    process.platform === 'win32'
      ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
      : process.platform === 'darwin'
        ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
        : ['tailscale'];
  let lastErr = 'Tailscale CLI not found.';
  for (const cmd of candidates) {
    try {
      const out = await runner(cmd, ['status', '--json'], 5000);
      return parseTailscaleStatus(out);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      lastErr = e?.code === 'ENOENT' ? 'Tailscale CLI not found.' : `tailscale status failed: ${e?.message ?? err}`;
    }
  }
  return { available: false, reason: lastErr, peers: [] };
}

/** Well-known local model server ports, for building suggested URLs from a peer. */
export const KNOWN_MODEL_PORTS: { kind: 'ollama' | 'openai-compatible'; port: number; label: string }[] = [
  { kind: 'ollama', port: 11434, label: 'Ollama' },
  { kind: 'openai-compatible', port: 1234, label: 'LM Studio' },
  { kind: 'openai-compatible', port: 8000, label: 'vLLM' },
  { kind: 'openai-compatible', port: 8080, label: 'llama.cpp server' },
];
