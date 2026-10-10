/**
 * Local-only network policy — the single rulebook for every server-side outbound call.
 *
 * BookKeeper AI is local-first: client data lives in the company file on this machine and is
 * never stored in the cloud. The only code allowed to open a connection off the machine is code
 * that asks this module first (via lib/net/guard.ts: assertOutboundAllowed / policyFetch).
 *
 * Modes (per company, stored in companies.settings.networkPolicy):
 *   offline       — nothing leaves the machine (loopback only).
 *   tailnet-only  — DEFAULT. Loopback, the private LAN (RFC 1918 / IPv6 ULA) and the Tailscale
 *                   tailnet (100.64.0.0/10, *.ts.net) are reachable; the public internet is not.
 *   allow-cloud   — as tailnet-only, plus public destinations for the purposes the company has
 *                   explicitly opted in to (ai, email, bank-feeds, updates). Every purpose is
 *                   OFF by default, even in this mode.
 *
 * A machine-wide ceiling can be set with BKA_NETWORK_MODE; the effective mode is the more
 * restrictive of the company's mode and the ceiling (an operator can force 'offline').
 *
 * This file is pure (no I/O) so the rules are unit-testable; see lib/net/guard.ts for the
 * enforcement wrapper and lib/services/networkPolicy.ts for persistence.
 */
import { classifyHost, isPrivateClass, normalizeHost, type HostClass } from './cidr';

export const NETWORK_MODES = ['offline', 'tailnet-only', 'allow-cloud'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const OUTBOUND_PURPOSES = ['ai', 'email', 'bank-feeds', 'updates'] as const;
export type OutboundPurpose = (typeof OUTBOUND_PURPOSES)[number];

export interface NetworkPolicy {
  mode: NetworkMode;
  /** Per-purpose cloud opt-in. Only consulted in 'allow-cloud' mode; all false by default. */
  cloudOptIn: Record<OutboundPurpose, boolean>;
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = Object.freeze({
  mode: 'tailnet-only',
  cloudOptIn: Object.freeze({ ai: false, email: false, 'bank-feeds': false, updates: false }),
}) as NetworkPolicy;

/** Human-facing description of each purpose: what would leave the machine if allowed. */
export const PURPOSE_INFO: Record<
  OutboundPurpose,
  { label: string; sends: string; destinations: string }
> = {
  ai: {
    label: 'AI assistance',
    sends:
      'The specific transaction(s) you ask the AI to review (description, accounts, amounts, dates). Nothing else, and nothing is stored by BookKeeper AI off this machine.',
    destinations: 'The configured AI provider (e.g. api.anthropic.com), or a model server on your LAN/tailnet.',
  },
  email: {
    label: 'Email (invoices, statements)',
    sends: 'The message and PDF attachment you choose to send, to the recipient you enter.',
    destinations: 'Your configured SMTP server (SMTP_HOST). A relay on your LAN/tailnet works without cloud opt-in.',
  },
  'bank-feeds': {
    label: 'Bank feeds (Plaid)',
    sends:
      'Plaid credentials and the bank connection token; downloads transactions into this company file.',
    destinations: '*.plaid.com',
  },
  updates: {
    label: 'App updates',
    sends: 'A request for the latest release manifest (app version and platform only — no company data).',
    destinations: 'The release feed configured at build time (GitHub Releases).',
  },
};

const MODE_RANK: Record<NetworkMode, number> = { offline: 0, 'tailnet-only': 1, 'allow-cloud': 2 };

export function isNetworkMode(v: unknown): v is NetworkMode {
  return typeof v === 'string' && (NETWORK_MODES as readonly string[]).includes(v);
}

export function isOutboundPurpose(v: unknown): v is OutboundPurpose {
  return typeof v === 'string' && (OUTBOUND_PURPOSES as readonly string[]).includes(v);
}

/** Coerce stored/untrusted JSON into a complete policy; anything unknown falls back to defaults. */
export function normalizePolicy(raw: unknown): NetworkPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const opt = (r.cloudOptIn && typeof r.cloudOptIn === 'object' ? r.cloudOptIn : {}) as Record<
    string,
    unknown
  >;
  const cloudOptIn = {} as Record<OutboundPurpose, boolean>;
  for (const p of OUTBOUND_PURPOSES) cloudOptIn[p] = opt[p] === true;
  return { mode: isNetworkMode(r.mode) ? r.mode : DEFAULT_NETWORK_POLICY.mode, cloudOptIn };
}

/** The machine-wide ceiling from BKA_NETWORK_MODE (undefined = no ceiling). */
export function envModeCeiling(env: Record<string, string | undefined> = process.env): NetworkMode | undefined {
  const v = env.BKA_NETWORK_MODE?.trim();
  return isNetworkMode(v) ? v : undefined;
}

/** The more restrictive of the company mode and the machine ceiling. */
export function effectiveMode(mode: NetworkMode, ceiling?: NetworkMode): NetworkMode {
  if (!ceiling) return mode;
  return MODE_RANK[ceiling] < MODE_RANK[mode] ? ceiling : mode;
}

export interface OutboundDecision {
  allowed: boolean;
  /** Plain-English reason, safe to show to the user. */
  reason: string;
  purpose: OutboundPurpose;
  host: string;
  hostClass: HostClass;
  mode: NetworkMode;
}

/** Protocols an outbound call may use. Everything else (file:, data:, ftp:, …) is refused. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'smtp:', 'smtps:']);

/**
 * Decide whether a server-side call to `target` for `purpose` is allowed under `policy`.
 * Pure: pass `ceiling` explicitly (defaults to the BKA_NETWORK_MODE env ceiling).
 */
export function decideOutbound(
  policy: NetworkPolicy,
  target: string | URL,
  purpose: OutboundPurpose,
  ceiling: NetworkMode | undefined = envModeCeiling(),
): OutboundDecision {
  const mode = effectiveMode(policy.mode, ceiling);
  let url: URL;
  try {
    url = typeof target === 'string' ? new URL(target) : target;
  } catch {
    return { allowed: false, reason: 'Invalid destination URL.', purpose, host: '', hostClass: 'invalid', mode };
  }
  const host = normalizeHost(url.hostname);
  const base = { purpose, host, mode };
  if (!isOutboundPurpose(purpose)) {
    return { ...base, allowed: false, hostClass: 'invalid', reason: 'Unknown outbound purpose.' };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ...base, allowed: false, hostClass: 'invalid', reason: `Protocol ${url.protocol} is not allowed.` };
  }
  if (url.username || url.password) {
    // Credentials belong in headers/auth options, never in a URL that could end up in a log.
    return { ...base, allowed: false, hostClass: classifyHost(host), reason: 'Credentials in URLs are not allowed.' };
  }
  const hostClass = classifyHost(host);
  if (hostClass === 'invalid') {
    return { ...base, allowed: false, hostClass, reason: `${host || 'That address'} is not a routable destination.` };
  }
  if (hostClass === 'loopback') {
    return { ...base, allowed: true, hostClass, reason: 'Destination is this computer.' };
  }
  if (mode === 'offline') {
    return { ...base, allowed: false, hostClass, reason: 'Offline mode: no network connections are made.' };
  }
  if (isPrivateClass(hostClass)) {
    return {
      ...base,
      allowed: true,
      hostClass,
      reason: hostClass === 'tailnet' ? 'Destination is on your tailnet.' : 'Destination is on your local network.',
    };
  }
  // Public internet.
  if (mode !== 'allow-cloud') {
    return {
      ...base,
      allowed: false,
      hostClass,
      reason: `${PURPOSE_INFO[purpose].label} would contact ${host} on the internet, but this company is set to ${
        mode === 'tailnet-only' ? 'local network + tailnet only' : mode
      }. Change it in Settings → Privacy & Network.`,
    };
  }
  if (!policy.cloudOptIn[purpose]) {
    return {
      ...base,
      allowed: false,
      hostClass,
      reason: `${PURPOSE_INFO[purpose].label} has not been allowed to use cloud services for this company. Turn it on in Settings → Privacy & Network.`,
    };
  }
  return { ...base, allowed: true, hostClass, reason: `Cloud use for ${PURPOSE_INFO[purpose].label} is opted in.` };
}
