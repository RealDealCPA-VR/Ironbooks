/**
 * Approval of a company file on THIS computer for internet services (security plan 1.5, row 3).
 *
 * A company file carries its own network settings (mode, cloud opt-ins, the vendor lookup
 * address), its AI servers, its mail server and its report schedules with their recipients — and
 * people send company files to each other. A crafted file could arrive with cloud access already
 * on, an "OpenAI-compatible" AI pointing at the sender's server, the sender's mail relay and a
 * schedule that emails reports out; once someone works in it, the app would talk to those places
 * without anyone at this computer having agreed. So:
 *
 *   A company file this computer has not approved never reaches the public internet, whatever its
 *   own settings say, until an Admin sitting at this computer allows it once (Privacy & Network →
 *   "Allow on this computer").
 *
 * This computer, the LAN and the tailnet keep working as the file's settings allow (a local AI, an
 * office mail relay); the cap itself is lib/net/policy.ts holdForThisComputer, applied by
 * lib/net/guard.ts to every outbound call. App update checks keep their own rules. Scheduled
 * reports that email wait (lib/services/memorizedReports.ts runDueSchedules): their recipients
 * were chosen wherever the file came from, and they run with nobody at the keyboard.
 *
 * The approval is a stamp per computer: HMAC-SHA256 under this computer's device secret
 * (lib/ai/keyVault.ts deviceKey — kept wrapped by Windows, never in the file) over a fixed label and
 * a random id kept beside the stamps. Nobody without this computer's secret can make one, so a file
 * from elsewhere never arrives approved here. Several computers each keep their own stamp (at most
 * MAX_APPROVALS, the oldest set aside first).
 *
 * Where: one row of the company file's own secrets (file_secrets, name APPROVAL_ROW). That table
 *  - travels with every copy that stays with the owner (the company file and its saves, Save Copy
 *    As, "Try it on a copy" sandboxes and training files, this computer's backups, the owner's own
 *    portable file), so those stay approved with no extra step in any of those paths;
 *  - is left out of every copy for someone outside the company (Accountant's Copy, Period Copy:
 *    lib/services/portableFile.ts OUTSIDER_VIEWS) and of per-company backups;
 *  - is not reachable from any settings API, unlike companies.settings.
 *
 * When a file counts as approved here without anyone pressing the button:
 *  - no device secret (tests, `next dev`, scripts, Linux without a keyring): the feature is off and
 *    every file is approved, exactly as before;
 *  - a file this computer already knew before this version (electron/knownFiles.js): the shell
 *    starts its server with BKA_FILE_KNOWN_HERE naming the data folder, and the first open stamps it;
 *  - a brand-new company file made here: at its first open it has no users, no companies and none
 *    of the settings that reach out (nothing in it came from anywhere else), so it is stamped;
 *  - a file whose own settings reach nothing on the internet: stamped the first time an Admin at
 *    this computer saves its network, AI or mail settings (approveQuietFileHere).
 *
 * A per-company backup restored into an approved file would bring its company's network policy and
 * emailing schedules in past that approval; it carries its own proof of the computer that made it
 * instead (see "Per-company backups" at the end of this file).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { resolveDataDir, type DB } from '@/lib/db';
import { aiSettings, companies, companyEmailSettings, fileSecrets, reportSchedules, users } from '@/lib/db/schema';
import { deviceKey, type DeviceKey } from '@/lib/ai/keyVault';
import { CHATGPT_RESOURCE } from '@/lib/ai/chatgpt';
import { type ServiceContext, inTransaction, writeAudit } from '@/lib/services/_base';
import { classifyHost, normalizeHost } from './cidr';
import { DEFAULT_NETWORK_POLICY, normalizeLookupUrl, normalizePolicy, PURPOSE_INFO } from './policy';
import { verifyTailnetUrls } from './tailnetVerify';

/** The file_secrets row holding the approvals. */
export const APPROVAL_ROW = 'network-approval';

/** Computers that can each keep a stamp in one file. */
export const MAX_APPROVALS = 16;

/** The environment variable the desktop shell names a file it already knew in (electron/knownFiles.js). */
export const KNOWN_HERE_ENV = 'BKA_FILE_KNOWN_HERE';

const STAMP_LABEL = 'ironbooks/network-approval/v1';
const KEY_ID_RE = /^[0-9a-f]{8}$/;
const MAC_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f-]{8,64}$/i;

/** Where an AI provider of a kind with a fixed address connects (lib/ai/providers.ts). */
const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com';

interface ApprovalRecord {
  id: string;
  /** [computer key id, stamp], oldest first. */
  stamps: Array<[string, string]>;
}

/** A stored record, or null when there is none or it is not one (anything else is ignored). */
function parseRecord(raw: unknown): ApprovalRecord | null {
  if (typeof raw !== 'string' || raw.length > 16_384) return null;
  try {
    const r = JSON.parse(raw) as { v?: unknown; id?: unknown; stamps?: unknown };
    if (!r || r.v !== 1 || typeof r.id !== 'string' || !ID_RE.test(r.id) || !Array.isArray(r.stamps)) return null;
    const stamps: Array<[string, string]> = [];
    for (const e of r.stamps.slice(0, MAX_APPROVALS * 2)) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string') continue;
      if (!KEY_ID_RE.test(e[0]) || !MAC_RE.test(e[1]) || stamps.some(([k]) => k === e[0])) continue;
      stamps.push([e[0], e[1]]);
    }
    return { id: r.id, stamps };
  } catch {
    return null;
  }
}

/** This computer's stamp for a file id (64 hex characters). */
export function stampFor(secret: string, id: string): string {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`${STAMP_LABEL}\n${id}`).digest('hex');
}

function stampValid(rec: ApprovalRecord, dk: DeviceKey): boolean {
  const mine = rec.stamps.find(([k]) => k === dk.keyId);
  if (!mine) return false;
  const want = Buffer.from(stampFor(dk.secret, rec.id), 'hex');
  const got = Buffer.from(mine[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** True when a stored record (the raw row value) holds a valid stamp of this device key. Pure. */
export function recordApproves(raw: unknown, dk: DeviceKey): boolean {
  const rec = parseRecord(raw);
  return Boolean(rec && stampValid(rec, dk));
}

async function readRaw(db: DB): Promise<string | null> {
  const [row] = await db.select({ secret: fileSecrets.secret }).from(fileSecrets).where(eq(fileSecrets.name, APPROVAL_ROW));
  return row?.secret ?? null;
}

/**
 * True when this computer has approved the company file behind `db` (or the feature is off: no
 * device secret). Fails closed: a record that can't be read counts as not approved.
 */
export async function fileApprovedHere(db: DB): Promise<boolean> {
  const dk = deviceKey();
  if (!dk) return true;
  try {
    return recordApproves(await readRaw(db), dk);
  } catch {
    return false;
  }
}

/** True when the company file's internet services are held on this computer (not approved here). */
export async function internetHeldHere(db: DB): Promise<boolean> {
  return !(await fileApprovedHere(db));
}

/**
 * Write this computer's stamp into the company file (keeping every other computer's). Returns true
 * when something was written; false when it was already approved here, or there is no device secret.
 */
export async function approveFileHere(db: DB): Promise<boolean> {
  const dk = deviceKey();
  if (!dk) return false;
  const rec = parseRecord(await readRaw(db));
  if (rec && stampValid(rec, dk)) return false;
  const id = rec?.id ?? crypto.randomUUID();
  const stamps = [...(rec?.stamps ?? []).filter(([k]) => k !== dk.keyId), [dk.keyId, stampFor(dk.secret, id)] as [string, string]].slice(
    -MAX_APPROVALS,
  );
  const value = JSON.stringify({ v: 1, id, stamps });
  await db
    .insert(fileSecrets)
    .values({ name: APPROVAL_ROW, secret: value })
    .onConflictDoUpdate({ target: fileSecrets.name, set: { secret: value } });
  return true;
}

// ---------------------------------------------------------------------------
// At open
// ---------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

const opened = globalThis as typeof globalThis & { __bkaFileTrustOpened?: Set<string> };

/** No users, no companies and none of the settings that reach out: nothing came from elsewhere. */
async function isBrandNew(db: DB): Promise<boolean> {
  const found = await Promise.all([
    db.select({ id: users.id }).from(users).limit(1),
    db.select({ id: companies.id }).from(companies).limit(1),
    db.select({ id: aiSettings.id }).from(aiSettings).limit(1),
    db.select({ id: companyEmailSettings.id }).from(companyEmailSettings).limit(1),
    db.select({ id: reportSchedules.id }).from(reportSchedules).limit(1),
  ]);
  return found.every((rows) => rows.length === 0);
}

/**
 * Called once the company database behind `dir` has opened (lib/db/index.ts). Stamps it for this
 * computer when:
 *  - the desktop shell named this very folder in BKA_FILE_KNOWN_HERE (a file this computer already
 *    knew before this version) — honoured at the FIRST open of the folder in this process only, so
 *    books restored over it later (a backup from elsewhere) are never stamped by it; or
 *  - it is the server's own company file and brand new (made here: see isBrandNew).
 * Writes nothing otherwise, never removes a stamp, and never throws past the caller's catch.
 */
export async function noteFileOpenedHere(db: DB, dir: string, opts: { damaged?: boolean } = {}): Promise<void> {
  const dk = deviceKey();
  if (!dk) return;
  const seen = (opened.__bkaFileTrustOpened ??= new Set());
  const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
  const first = !seen.has(key);
  seen.add(key);
  // Damaged books are never written to at open (and the hand-over above is spent all the same).
  if (opts.damaged) return;
  const named = process.env[KNOWN_HERE_ENV];
  const knownHere = first && Boolean(named) && samePath(named!, dir);
  if (!knownHere && !(samePath(dir, resolveDataDir()) && (await isBrandNew(db)))) return;
  await approveFileHere(db);
}

/** Tests: forget which folders were opened in this process (a new "launch"). */
export function forgetOpenedFoldersForTests(): void {
  opened.__bkaFileTrustOpened?.clear();
}

// ---------------------------------------------------------------------------
// What a file's own settings would reach on the internet (the note on Privacy & Network)
// ---------------------------------------------------------------------------

export type HeldPurpose = 'ai' | 'email' | 'vendor-lookup' | 'scheduled-reports';

export interface HeldService {
  purpose: HeldPurpose;
  label: string;
  /** Public host names involved (recipient domains for scheduled reports); may be empty. */
  hosts: string[];
}

const HELD_LABELS: Record<HeldPurpose, string> = {
  ai: PURPOSE_INFO.ai.label,
  email: PURPOSE_INFO.email.label,
  'vendor-lookup': PURPOSE_INFO['vendor-lookup'].label,
  'scheduled-reports': 'Scheduled reports sent by email',
};

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return normalizeHost(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

function mailUrl(host: string): string {
  const h = host.trim();
  return `smtp://${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}`;
}

/**
 * Everything in the company file (every company in it) that would reach the public internet by its
 * own settings, switched on or only set up: the mode "Allow cloud services I choose" with AI, email
 * or vendor lookup on; an AI server, mail server or vendor lookup address on the internet; vendor
 * lookup turned on (its SearXNG passes names on to public search engines); a report schedule that
 * emails. Empty: nothing in it reaches the internet. Host names only, never content.
 */
export async function heldDestinations(db: DB): Promise<HeldService[]> {
  const [companyRows, aiRows, mailRows, scheduleRows] = await Promise.all([
    db.select({ settings: companies.settings }).from(companies),
    db.select({ providers: aiSettings.providers }).from(aiSettings),
    db.select({ host: companyEmailSettings.host }).from(companyEmailSettings),
    db.select({ emailTo: reportSchedules.emailTo }).from(reportSchedules),
  ]);
  const aiUrls: string[] = [];
  for (const row of aiRows) {
    for (const p of Array.isArray(row.providers) ? row.providers : []) {
      if (!p || typeof p !== 'object') continue;
      const { kind, baseUrl } = p as { kind?: unknown; baseUrl?: unknown };
      const url =
        typeof baseUrl === 'string' && baseUrl.trim()
          ? baseUrl.trim()
          : kind === 'anthropic'
            ? DEFAULT_ANTHROPIC_URL
            : kind === 'chatgpt'
              ? CHATGPT_RESOURCE
              : null;
      if (url) aiUrls.push(url);
    }
  }
  const mailUrls = mailRows.map((r) => (r.host && r.host.trim() ? mailUrl(r.host) : null)).filter((u): u is string => Boolean(u));
  const policies = companyRows.map((r) => normalizePolicy((r.settings as Record<string, unknown> | null)?.networkPolicy));
  const lookupUrls = policies.map((p) => normalizeLookupUrl(p.vendorLookupUrl)).filter((u): u is string => Boolean(u));
  // A *.ts.net name is the tailnet only once it resolved to tailnet addresses (Funnel names are public).
  await verifyTailnetUrls([...aiUrls, ...mailUrls, ...lookupUrls]);
  const publicHost = (url: string): string | null => {
    const h = hostOf(url);
    return h && classifyHost(h) === 'public' ? h : null;
  };

  const out = new Map<HeldPurpose, Set<string>>();
  const add = (purpose: HeldPurpose, host?: string | null) => {
    const set = out.get(purpose) ?? new Set<string>();
    if (host) set.add(host);
    out.set(purpose, set);
  };
  const aiPublic = aiUrls.map(publicHost).filter((h): h is string => Boolean(h));
  const mailPublic = mailUrls.map(publicHost).filter((h): h is string => Boolean(h));
  for (const h of aiPublic) add('ai', h);
  for (const h of mailPublic) add('email', h);
  for (const p of policies) {
    if (p.mode === 'allow-cloud' && p.cloudOptIn.ai) add('ai');
    if (p.mode === 'allow-cloud' && p.cloudOptIn.email) add('email');
    const lookup = normalizeLookupUrl(p.vendorLookupUrl);
    if (lookup && (p.cloudOptIn['vendor-lookup'] || publicHost(lookup))) add('vendor-lookup', hostOf(lookup));
  }
  for (const r of scheduleRows) {
    if (!r.emailTo || !r.emailTo.trim()) continue;
    add('scheduled-reports');
    for (const addr of r.emailTo.split(/[\s,;]+/)) {
      const at = addr.lastIndexOf('@');
      if (at > 0) add('scheduled-reports', addr.slice(at + 1).toLowerCase().replace(/[>)\]]+$/, '') || null);
    }
  }
  const order: HeldPurpose[] = ['ai', 'email', 'vendor-lookup', 'scheduled-reports'];
  return order
    .filter((p) => out.has(p))
    .map((p) => ({ purpose: p, label: HELD_LABELS[p], hosts: [...out.get(p)!].sort() }));
}

/** What Privacy & Network (and later the AI and Send Forms pages) show for the open file. */
export interface HoldStatus {
  /** The file is not approved here AND its own settings would reach the internet: show the note. */
  heldForThisComputer: boolean;
  /** The internet services involved (empty unless heldForThisComputer). */
  heldServices: HeldService[];
  /** Every public host among them, sorted (empty unless heldForThisComputer). */
  heldHosts: string[];
}

export async function holdStatus(db: DB): Promise<HoldStatus> {
  if (!(await internetHeldHere(db))) return { heldForThisComputer: false, heldServices: [], heldHosts: [] };
  const services = await heldDestinations(db);
  return {
    heldForThisComputer: services.length > 0,
    heldServices: services,
    heldHosts: [...new Set(services.flatMap((s) => s.hosts))].sort(),
  };
}

// ---------------------------------------------------------------------------
// Approving
// ---------------------------------------------------------------------------

/**
 * "Allow on this computer" (Privacy & Network): write this computer's stamp, audit-logged with the
 * internet destinations it lets through. The route checks the caller is an Admin at this computer.
 */
export async function allowFileOnThisComputer(ctx: ServiceContext): Promise<boolean> {
  const dk = deviceKey();
  if (!dk) return false;
  const services = await heldDestinations(ctx.db);
  return inTransaction(ctx, async (tx) => {
    const wrote = await approveFileHere(tx.db);
    if (wrote) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'network_policy',
        entityId: tx.companyId,
        oldValues: { allowedOnThisComputer: false },
        newValues: { allowedOnThisComputer: true, computer: dk.keyId, services: services.map((s) => ({ service: s.label, hosts: s.hosts })) },
      });
    }
    return wrote;
  });
}

/**
 * The first save of network, AI or mail settings by an Admin at this computer, in a file that is
 * not approved here and whose own settings reach nothing on the internet: approve it silently, so
 * what the Admin sets up now works. Call it BEFORE the save is applied (it looks at the settings
 * the file arrived with). A file whose settings do reach the internet is only approved by the
 * button. Returns true when the stamp was written.
 */
export async function approveQuietFileHere(ctx: ServiceContext, opts: { remote: boolean }): Promise<boolean> {
  if (opts.remote || !deviceKey()) return false;
  if (ctx.role !== 'owner' && ctx.role !== 'admin') return false;
  if (!(await internetHeldHere(ctx.db))) return false;
  if ((await heldDestinations(ctx.db)).length > 0) return false;
  return inTransaction(ctx, async (tx) => {
    const wrote = await approveFileHere(tx.db);
    if (wrote) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'network_policy',
        entityId: tx.companyId,
        oldValues: { allowedOnThisComputer: false },
        newValues: { allowedOnThisComputer: true, computer: deviceKey()?.keyId ?? null, services: [] },
      });
    }
    return wrote;
  });
}

// ---------------------------------------------------------------------------
// Per-company backups ("Back up this company", lib/services/backup.ts)
// ---------------------------------------------------------------------------
//
// Restoring one company from a per-company backup adds it to the OPEN company file, which is
// usually approved on this computer already, so the approval above never looks at what it brings:
// that company's network policy (mode, cloud opt-ins, vendor lookup address) and its report
// schedules with their recipients. A crafted backup could switch internet services on that way.
// So the export, when there is a device secret, adds a proof of the computer that made it
// (company-data.json `madeOn`): HMAC-SHA256 under that computer's device secret over a fixed label,
// the proof's own id and time, the company id and a digest of exactly those settings. It cannot be
// made without the secret, nor moved onto other settings. At restore:
//   - a valid proof of THIS computer: everything comes back as it was (as before);
//   - no proof, another computer's, a broken one, or no device secret here while the backup has a
//     proof: the network policy comes back no wider than the app's default and the schedules that
//     email come back paused, and the restore says so (BACKUP_OUTSIDE_SETTINGS_NOTICE);
//   - no device secret here and no proof (tests, `next dev`, scripts): exactly as before.

const BACKUP_PROOF_LABEL = 'ironbooks/company-backup-origin/v1';

/** The proof a per-company backup made on a computer with a device secret carries. */
export interface CompanyBackupProof {
  v: 1;
  /** Which computer made it (not secret). */
  keyId: string;
  id: string;
  createdAt: string;
  /** HMAC-SHA256 (hex) over the label, id, createdAt and the settings digest. */
  mac: string;
}

/** The parts of a per-company backup's company data looked at here (lib/services/backup.ts CompanyExportData). */
export interface CompanyBackupContent {
  company: { id: string; settings: unknown };
  tables: Record<string, Array<Record<string, unknown>> | undefined>;
  madeOn?: unknown;
}

/** Said after restoring a per-company backup whose outside settings were left off. */
export const BACKUP_OUTSIDE_SETTINGS_NOTICE =
  'Internet services and emailed report schedules in this backup were left switched off; turn them on under Privacy & Network and Report Schedules if you want them.';

/** JSON with object keys in a fixed order: the same text for the same settings before and after the backup's round trip. */
function canonicalJson(value: unknown): string {
  const walk = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${walk(o[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(v);
  };
  return walk(value === undefined ? null : JSON.parse(JSON.stringify(value)));
}

/** Digest of what the proof covers: the company id, its network policy, every schedule's recipients and whether it runs. */
function outsideSettingsDigest(data: CompanyBackupContent): string {
  const s = data.company.settings;
  const policy = s && typeof s === 'object' && !Array.isArray(s) ? ((s as Record<string, unknown>).networkPolicy ?? null) : null;
  const schedules = (data.tables.reportSchedules ?? [])
    .map((r) => [String(r.id ?? ''), typeof r.emailTo === 'string' ? r.emailTo : null, r.isActive !== false] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto
    .createHash('sha256')
    .update(canonicalJson({ company: String(data.company.id), networkPolicy: policy, schedules }))
    .digest('hex');
}

function backupProofMac(secret: string, id: string, createdAt: string, digest: string): string {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`${BACKUP_PROOF_LABEL}\n${id}\n${createdAt}\n${digest}`).digest('hex');
}

/** This computer's proof for a per-company backup's company data; null without a device secret. */
export function companyBackupProof(data: CompanyBackupContent, now: Date = new Date()): CompanyBackupProof | null {
  const dk = deviceKey();
  if (!dk) return null;
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  return { v: 1, keyId: dk.keyId, id, createdAt, mac: backupProofMac(dk.secret, id, createdAt, outsideSettingsDigest(data)) };
}

/**
 * True when the per-company backup was made on THIS computer with exactly these outside settings;
 * false when it was not (no proof, another computer's, a proof that does not match, or a proof but
 * no device secret here); null when there is neither a device secret here nor a proof (restore as
 * before).
 */
export function companyBackupMadeHere(data: CompanyBackupContent): boolean | null {
  const dk = deviceKey();
  const p = data.madeOn && typeof data.madeOn === 'object' ? (data.madeOn as Partial<CompanyBackupProof>) : null;
  if (!dk) return p ? false : null;
  if (!p || p.v !== 1 || p.keyId !== dk.keyId) return false;
  if (typeof p.id !== 'string' || !ID_RE.test(p.id) || typeof p.createdAt !== 'string' || p.createdAt.length > 64) return false;
  if (typeof p.mac !== 'string' || !MAC_RE.test(p.mac)) return false;
  const want = Buffer.from(backupProofMac(dk.secret, p.id, p.createdAt, outsideSettingsDigest(data)), 'hex');
  const got = Buffer.from(p.mac, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * A stored network policy narrowed to reach no further than the app's default
 * (lib/net/policy.ts DEFAULT_NETWORK_POLICY): Offline stays Offline, any other mode becomes the
 * default one, every cloud opt-in is off and there is no vendor lookup address. The update-check
 * choice and its stored revision are kept (update checks send no company data), so a company that
 * had them off keeps them off.
 */
export function policyNoWiderThanDefault(raw: unknown): Record<string, unknown> {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const opt = r.cloudOptIn && typeof r.cloudOptIn === 'object' ? (r.cloudOptIn as Record<string, unknown>) : {};
  return {
    mode: r.mode === 'offline' ? 'offline' : DEFAULT_NETWORK_POLICY.mode,
    cloudOptIn: {
      ai: false,
      email: false,
      'vendor-lookup': false,
      ...(typeof opt.updates === 'boolean' ? { updates: opt.updates } : {}),
    },
    vendorLookupUrl: DEFAULT_NETWORK_POLICY.vendorLookupUrl,
    ...(r.rev !== undefined ? { rev: r.rev } : {}),
  };
}

/**
 * For a per-company backup not made here (companyBackupMadeHere false): the company settings to
 * restore (the network policy no wider than the default) and the ids of the schedules to restore
 * paused (those that email). `changed` is false when the backup brought nothing that reaches out;
 * then nothing is changed and nothing is said.
 */
export function holdBackupOutsideSettings(data: CompanyBackupContent): {
  settings: unknown;
  pauseScheduleIds: Set<string>;
  changed: boolean;
} {
  let settings = data.company.settings;
  let changed = false;
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null;
  if (s && s.networkPolicy !== undefined && s.networkPolicy !== null) {
    const narrowed = policyNoWiderThanDefault(s.networkPolicy);
    if (canonicalJson(normalizePolicy(narrowed)) !== canonicalJson(normalizePolicy(s.networkPolicy))) {
      settings = { ...s, networkPolicy: narrowed };
      changed = true;
    }
  }
  const pauseScheduleIds = new Set<string>();
  for (const r of data.tables.reportSchedules ?? []) {
    if (typeof r.id === 'string' && typeof r.emailTo === 'string' && r.emailTo.trim() && r.isActive !== false) pauseScheduleIds.add(r.id);
  }
  if (pauseScheduleIds.size) changed = true;
  return { settings, pauseScheduleIds, changed };
}
