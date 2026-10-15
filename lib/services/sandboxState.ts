/**
 * Sandbox mode ("Try it on a copy") — the lightweight state half.
 *
 * A sandbox is a throwaway copy of the whole company file (every company in the data directory)
 * made by lib/services/sandbox.ts. The copy carries a marker file (SANDBOX_MARKER) at its root;
 * whichever way the copy is opened (the server switching its active data dir in web/dev mode,
 * or the desktop shell relaunching into it like any other company file) the marker is what
 * makes it a sandbox. A copy the user decided to keep becomes a "training file": same marker,
 * kind 'training'.
 *
 * While the active data dir is a sandbox or training file, every outbound effect is off:
 * emails, bank-feed sync, scheduled reports, auto-backups and app-update prompts. This module
 * answers "are we in a sandbox?" and throws the friendly error the blocked features show. It is
 * deliberately small (fs + the data-dir resolver) so the network guard and the email / bank-feed
 * services can import it without pulling in the copy machinery.
 *
 * The marker is listed in FILE_LOCAL_SECRETS (lib/services/backup.ts) so it never travels inside
 * a backup and a restore never adopts one: restoring a backup made in a sandbox into the real
 * file can never turn the real file into a "sandbox".
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '@/lib/db';
import { ServiceError } from './errors';
import type { OutboundDecision, OutboundPurpose } from '@/lib/net/policy';

/** Marker file at the root of a sandbox / training data directory. */
export const SANDBOX_MARKER = '.ironbooks-sandbox.json';
export const SANDBOX_MARKER_SCHEMA = 'ironbooks-sandbox/v1';

export type SandboxKind = 'sandbox' | 'training';

export interface SandboxMarker {
  schema: typeof SANDBOX_MARKER_SCHEMA;
  kind: SandboxKind;
  /** The real company file this copy was made from (absolute data-dir path). */
  realDataDir: string;
  /** Human name of the real company file when the copy was made. */
  sourceName: string;
  createdAt: string;
  /** Training files only: when the sandbox was kept, and the name it was given. */
  keptAt?: string;
  trainingName?: string;
}

/** Banner text shown on every page (and the PDF stamp's subtitle). */
export const SANDBOX_BANNER_TEXT = "SANDBOX — changes here don't affect your real books";
export const TRAINING_BANNER_TEXT = 'TRAINING FILE — a practice copy, not your real books';

/** Read the marker of a data directory (default: the active one). Null when it is a real file. */
export function readSandboxMarker(dir?: string): SandboxMarker | null {
  const root = resolveDataDir(dir);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, SANDBOX_MARKER), 'utf8')) as Partial<SandboxMarker>;
    if (
      m &&
      m.schema === SANDBOX_MARKER_SCHEMA &&
      (m.kind === 'sandbox' || m.kind === 'training') &&
      typeof m.realDataDir === 'string'
    ) {
      return {
        schema: SANDBOX_MARKER_SCHEMA,
        kind: m.kind,
        realDataDir: m.realDataDir,
        sourceName: typeof m.sourceName === 'string' ? m.sourceName : 'Company',
        createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
        ...(typeof m.keptAt === 'string' ? { keptAt: m.keptAt } : {}),
        ...(typeof m.trainingName === 'string' ? { trainingName: m.trainingName } : {}),
      };
    }
  } catch {
    /* no marker / unreadable: a real company file */
  }
  return null;
}

export function writeSandboxMarker(dir: string, marker: SandboxMarker): void {
  fs.writeFileSync(path.join(dir, SANDBOX_MARKER), JSON.stringify(marker, null, 2), 'utf8');
}

/**
 * Keep process.env.BKA_SANDBOX in step with the active data dir. The PDF renderers (lib/pdf,
 * shared with client bundles, so they cannot touch the file system) read this flag to stamp
 * "SANDBOX" on printed documents.
 */
export function syncSandboxEnv(marker: SandboxMarker | null = readSandboxMarker()): void {
  if (marker) process.env.BKA_SANDBOX = '1';
  else delete process.env.BKA_SANDBOX;
  syncedDir = resolveDataDir();
}

/** Data dir the stamp flag was last synced for (null: never synced in this process). */
let syncedDir: string | null = null;

/**
 * Sync the PDF stamp flag the first time a request runs against a data directory (called from
 * getServerContext), so a server started directly on a sandbox / training folder (BKA_DATA_DIR)
 * stamps its printouts from the very first request, not only after the banner asked for status.
 */
export function ensureSandboxEnvSynced(): void {
  if (syncedDir !== resolveDataDir()) syncSandboxEnv();
}

/** The active data directory's sandbox marker (and refresh the PDF stamp flag). */
export function activeSandbox(): SandboxMarker | null {
  const marker = readSandboxMarker();
  syncSandboxEnv(marker);
  return marker;
}

/** True when the active company file is a sandbox or a training file. */
export function isSandboxActive(): boolean {
  return activeSandbox() !== null;
}

/** The error every blocked outbound feature shows inside a sandbox / training file. */
export function sandboxBlockedError(what: string, kind: SandboxKind = 'sandbox'): ServiceError {
  const where = kind === 'training' ? 'a training file' : 'the sandbox';
  return new ServiceError(
    'FORBIDDEN',
    `${what} is turned off in ${where}, so nothing leaves this practice copy. ` +
      (kind === 'training'
        ? 'Open your real company file to do this for real.'
        : 'Leave the sandbox (the orange bar at the top) to do this in your real books.'),
    { sandbox: true },
  );
}

/** Throw sandboxBlockedError when the active company file is a sandbox / training file. */
export function assertNotSandbox(what: string): void {
  const marker = activeSandbox();
  if (marker) throw sandboxBlockedError(what, marker.kind);
}

/** Outbound purposes that stay off inside a sandbox (AI help keeps working). */
const SANDBOX_BLOCKED_PURPOSES: ReadonlySet<OutboundPurpose> = new Set(['email', 'bank-feeds', 'updates']);

const PURPOSE_WORDS: Record<OutboundPurpose, string> = {
  ai: 'AI assistance',
  email: 'Email',
  'bank-feeds': 'Bank feed sync',
  updates: 'Installing app updates',
};

/**
 * Overlay the sandbox rule on a network-policy decision (lib/net/guard.ts and
 * /api/network-policy/check): inside a sandbox, email, bank feeds and update checks are refused
 * whatever the company's policy says.
 */
export function applySandboxToDecision(decision: OutboundDecision): OutboundDecision {
  if (!decision.allowed || !SANDBOX_BLOCKED_PURPOSES.has(decision.purpose)) return decision;
  const marker = activeSandbox();
  if (!marker) return decision;
  return {
    ...decision,
    allowed: false,
    reason: sandboxBlockedError(PURPOSE_WORDS[decision.purpose], marker.kind).message,
  };
}
