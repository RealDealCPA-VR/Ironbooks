/**
 * Tailnet helpers — classify where a model endpoint lives and (optionally) discover peers.
 *
 *  - loopback: 127.0.0.0/8, ::1, localhost
 *  - lan:      RFC1918 (10/8, 172.16/12, 192.168/16), link-local, *.local, bare hostnames
 *  - tailnet:  Tailscale CGNAT range 100.64.0.0/10, Tailscale ULA fd7a:115c:a1e0::/48, and *.ts.net
 *              names verified to resolve only to those (lib/net/tailnetVerify.ts) — Tailscale
 *              Funnel names under ts.net are public, so an unverified *.ts.net name is 'public'
 *  - public:   anything else
 *
 * Plain-HTTP to a PUBLIC host sends client data over the open internet unencrypted — the UI
 * warns loudly. HTTP inside the tailnet is fine (WireGuard already encrypts the hop).
 */
import { execFile } from 'node:child_process';
import type { HostClass } from './types';
import { isVerifiedTailnetName } from '@/lib/net/cidr';

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** Classify a bare host (no scheme/port). */
export function classifyHost(rawHost: string): HostClass {
  let host = (rawHost || '').trim().toLowerCase();
  if (!host) return 'invalid';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';

  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'loopback';
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet'; // 100.64.0.0/10 (CGNAT / Tailscale)
    if (a === 10) return 'lan';
    if (a === 172 && b >= 16 && b <= 31) return 'lan';
    if (a === 192 && b === 168) return 'lan';
    if (a === 169 && b === 254) return 'lan';
    if (a === 0) return 'invalid';
    return 'public';
  }

  if (host.includes(':')) {
    // IPv6 literal.
    if (host === '::1') return 'loopback';
    if (host.startsWith('fd7a:115c:a1e0:')) return 'tailnet';
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'lan'; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) return 'lan'; // link-local fe80::/10
    return 'public';
  }

  if (!/^[a-z0-9.-]+$/.test(host)) return 'invalid';
  if (host.endsWith('.ts.net')) return isVerifiedTailnetName(host) ? 'tailnet' : 'public';
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || host.endsWith('.internal')) {
    return 'lan';
  }
  // A single-label hostname (e.g. "gpu-box") only resolves via local DNS / MagicDNS.
  if (!host.includes('.')) return 'lan';
  return 'public';
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
  if (hostClass === 'public' && protocol === 'http') {
    warning =
      'This is a PUBLIC address over plain HTTP — anything sent is readable on the internet. Use your Tailscale address (100.x.y.z or *.ts.net) or HTTPS.';
  } else if (hostClass === 'public') {
    warning = 'This is a public internet address. It is treated as a CLOUD model: data is redacted and cloud must be enabled.';
  } else if (hostClass === 'lan' && protocol === 'http') {
    warning = 'Local network over HTTP — fine on a trusted network; prefer the machine’s Tailscale address.';
  } else if (hostClass === 'invalid') {
    warning = 'Unrecognized host.';
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
