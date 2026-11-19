/**
 * Encryption at rest for saved keys of outside services: AI provider API keys, the "Continue with
 * ChatGPT" sign-in and the Send Forms mail server password.
 *
 * AES-256-GCM; the key is derived (HKDF-SHA256) from a secret and bound to the company id
 * (HKDF info + GCM additional data), so a key copied into another company's settings row will
 * not decrypt. Blob formats, told apart by their prefix:
 *
 *   "v3:" + keyId + ":" + base64(iv[12] | tag[16] | ciphertext)   CURRENT on the desktop. The
 *         secret is THIS COMPUTER's device secret (one per Windows account, kept wrapped by Windows
 *         in the desktop shell's userData — electron/deviceVault.js — and handed to the server as
 *         BKA_DEVICE_VAULT). `keyId` (8 hex characters, not secret) says which computer sealed it.
 *         A copy of the company file, a backup or a portable file carries nothing that opens it.
 *   "v3m:" + JSON ["v3:…", "v3:…"]   The same value set up on several computers that open the same
 *         company file (two office PCs using one file on a shared folder): one "v3:" blob per
 *         computer, oldest first, at most MAX_COMPUTERS. Each computer reads its own entry.
 *   "v2:" + base64(iv | tag | ciphertext)   The company FILE's own vault secret (file_secrets row
 *         'vault'), which travels with every copy of the file. Still used — knowingly — while the
 *         company file is protected with passwords (lib/services/fileProtection.ts: the file and
 *         every copy of it are encrypted, so the vault secret is too, and the keys keep working on
 *         every computer that opens it), and wherever no device secret exists (tests, `next dev`,
 *         scripts, Linux without a keyring), exactly as before.
 *   "v1:" + base64(iv | tag | ciphertext)   LEGACY (before review round 5): this computer's
 *         `.auth-secret`, only ever readable on the computer that saved it.
 *
 * The owner's decision (security plan 1.3): a key for an outside service belongs to the computer
 * that entered it; each computer that opens a company file without passwords sets up AI and email
 * once. migrateStoredSecrets moves the values this computer can read (v2 with the file's vault
 * secret, v1 with its .auth-secret) to its device secret the first time it opens such a file, then
 * deletes the file's vault secret — in one transaction, every new blob checked before it is
 * written — so the file no longer holds anything that opens them. Values another computer sealed
 * are left as they are ("set up once on this computer" on the settings pages).
 *
 * Writing (sealStoredSecret) says why the value is written:
 *   entered    the person typed a new secret here (an API key, the mail password, a fresh ChatGPT
 *              sign-in). When this computer could read the value before, it is a CHANGE: the other
 *              computers' copies are stale and are dropped (they ask to be set up again, never keep
 *              using the old key). When it could not (this computer sets it up for the first time),
 *              this computer's entry is added and the others are kept — otherwise two computers
 *              sharing one file would knock each other's key out at every set-up, forever.
 *   refreshed  this computer renewed its own sign-in token (ChatGPT): only its own entry changes.
 * Clearing a value (Disconnect, Remove) removes every computer's copy: the callers store null.
 *
 * Neither secret is ever used to sign sessions: lib/auth.ts keeps signing with the per-computer
 * `.auth-secret`. Plaintext keys never leave the server: the settings APIs return only whether a
 * key is saved (and readable here).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { resolveDataDir, type DB } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { aiSettings, companyEmailSettings, fileProtection, fileSecrets } from '@/lib/db/schema';

const PREFIX_V1 = 'v1:';
const PREFIX_V2 = 'v2:';
const PREFIX_V3 = 'v3:';
const PREFIX_V3M = 'v3m:';
const SALT_V1 = 'bookkeeper-ai/ai-keys';
const SALT_V2 = 'ironbooks/file-vault/v2';
const SALT_V3 = 'ironbooks/device-vault/v3';

/** Name of the file_secrets row holding the vault secret. */
export const VAULT_SECRET_NAME = 'vault';

/** Where the desktop shell puts this computer's device secret (electron/deviceVault.js). */
export const DEVICE_VAULT_ENV = 'BKA_DEVICE_VAULT';

/** Computers one value can be set up on at once (the oldest set-up is dropped beyond it). */
export const MAX_COMPUTERS = 8;

/** The folder marker of a protected company file (lib/services/fileProtection.ts PROTECTED_MARKER). */
export const PROTECTED_MARKER_NAME = '.ironbooks-protected';

/**
 * The data-directory secret (mirrors lib/auth.ts `secret()`; same file, same env override) —
 * only used to READ legacy "v1:" blobs now. Created with an exclusive write so two first-callers
 * can't race different secrets.
 */
export function dataDirSecret(dataDir?: string): string {
  if (process.env.BKA_AUTH_SECRET) return process.env.BKA_AUTH_SECRET;
  const dir = resolveDataDir(dataDir);
  const file = path.join(dir, '.auth-secret');
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    fs.mkdirSync(dir, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(file, s, { mode: 0o600, flag: 'wx' });
      return s;
    } catch {
      return fs.readFileSync(file, 'utf8'); // lost the race — use the winner's secret
    }
  } catch {
    throw new Error('Cannot read or create the company data secret; refusing to store API keys.');
  }
}

/** The legacy secret, or null when it can't be read (never throws). */
function legacySecretOrNull(dataDir?: string): string | null {
  try {
    const s = dataDirSecret(dataDir);
    return s && s.trim() ? s : null;
  } catch {
    return null;
  }
}

function deriveKey(secret: string, companyId: string, salt: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(salt), Buffer.from(`company:${companyId}`), 32),
  );
}

function seal(prefix: string, salt: string, plaintext: string, companyId: string, secret: string): string {
  const key = deriveKey(secret, companyId, salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(companyId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return prefix + Buffer.concat([iv, tag, ct]).toString('base64');
}

function unseal(body: string, salt: string, companyId: string, secret: string): string | null {
  try {
    const raw = Buffer.from(body, 'base64');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, companyId, salt), iv);
    decipher.setAAD(Buffer.from(companyId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * LEGACY format ("v1:"), kept for reading old blobs and for tests. New keys are sealed with
 * sealStoredSecret, never with this.
 */
export function encryptSecret(plaintext: string, companyId: string, secret = dataDirSecret()): string {
  return seal(PREFIX_V1, SALT_V1, plaintext, companyId, secret);
}

/**
 * Decrypt a v1 or v2 blob with an explicit secret. Returns null when the value cannot be
 * decrypted (wrong secret/company, tampered, malformed).
 */
export function decryptSecret(blob: string | null | undefined, companyId: string, secret = dataDirSecret()): string | null {
  if (!blob || typeof blob !== 'string') return null;
  if (blob.startsWith(PREFIX_V2)) return unseal(blob.slice(PREFIX_V2.length), SALT_V2, companyId, secret);
  if (blob.startsWith(PREFIX_V1)) return unseal(blob.slice(PREFIX_V1.length), SALT_V1, companyId, secret);
  return null;
}

/** True for a legacy (per-computer) blob. */
export function isLegacyBlob(blob: unknown): blob is string {
  return typeof blob === 'string' && blob.startsWith(PREFIX_V1);
}

/** True for a value sealed with the company file's own vault secret ("v2:"). */
export function isFileBlob(blob: unknown): blob is string {
  return typeof blob === 'string' && blob.startsWith(PREFIX_V2);
}

/** True for a value sealed for one or more computers ("v3:" / "v3m:"). */
export function isDeviceSealed(blob: unknown): boolean {
  return typeof blob === 'string' && (blob.startsWith(PREFIX_V3) || blob.startsWith(PREFIX_V3M));
}

// ---------------------------------------------------------------------------
// This computer's device secret
// ---------------------------------------------------------------------------

export interface DeviceKey {
  secret: string;
  /** Not secret: tells this computer's blobs from other computers' ones. */
  keyId: string;
}

/** The short, non-secret id of a device secret. */
export function deviceKeyId(secret: string): string {
  return crypto.createHash('sha256').update(`ironbooks/device-vault/key-id\n${secret.toLowerCase()}`).digest('hex').slice(0, 8);
}

/**
 * This computer's device secret, from the desktop shell (BKA_DEVICE_VAULT: 64 hex characters), or
 * null — no shell (tests, `next dev`, scripts), or the operating system could not protect one.
 */
export function deviceKey(): DeviceKey | null {
  const raw = process.env[DEVICE_VAULT_ENV];
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) return null;
  const secret = raw.toLowerCase();
  return { secret, keyId: deviceKeyId(secret) };
}

const KEY_ID_RE = /^[0-9a-f]{8}$/;

/** The per-computer entries of a device-sealed value ([keyId, "v3:" blob], oldest first), or null. */
function deviceEntries(blob: unknown): Array<[string, string]> | null {
  if (typeof blob !== 'string') return null;
  const one = (b: unknown): [string, string] | null => {
    if (typeof b !== 'string' || !b.startsWith(PREFIX_V3)) return null;
    const kid = b.slice(PREFIX_V3.length, PREFIX_V3.length + 8);
    return KEY_ID_RE.test(kid) && b[PREFIX_V3.length + 8] === ':' ? [kid, b] : null;
  };
  if (blob.startsWith(PREFIX_V3M)) {
    try {
      const list = JSON.parse(blob.slice(PREFIX_V3M.length)) as unknown;
      if (!Array.isArray(list)) return null;
      const out: Array<[string, string]> = [];
      for (const b of list.slice(0, MAX_COMPUTERS * 2)) {
        const e = one(b);
        if (e && !out.some(([k]) => k === e[0])) out.push(e);
      }
      return out;
    } catch {
      return null;
    }
  }
  if (blob.startsWith(PREFIX_V3)) {
    const e = one(blob);
    return e ? [e] : null;
  }
  return null;
}

/** Store a list of per-computer entries: one computer as a plain "v3:" blob, several as "v3m:". */
function packEntries(entries: Array<[string, string]>): string {
  const kept = entries.slice(-MAX_COMPUTERS);
  return kept.length === 1 ? kept[0][1] : PREFIX_V3M + JSON.stringify(kept.map(([, b]) => b));
}

function sealForDevice(plaintext: string, companyId: string, dk: DeviceKey): string {
  return seal(`${PREFIX_V3}${dk.keyId}:`, SALT_V3, plaintext, companyId, dk.secret);
}

/** This computer's entry of a device-sealed value, opened (null: none, or not readable). */
function openForDevice(blob: unknown, companyId: string, dk: DeviceKey): string | null {
  const mine = deviceEntries(blob)?.find(([kid]) => kid === dk.keyId);
  if (!mine) return null;
  return unseal(mine[1].slice(PREFIX_V3.length + 9), SALT_V3, companyId, dk.secret);
}

/** The person typed a new secret on this computer (see the module comment). */
function enteredHere(previous: string | null, plaintext: string, companyId: string, dk: DeviceKey): string {
  const mine = sealForDevice(plaintext, companyId, dk);
  const entries = deviceEntries(previous);
  // A change made where the value was readable: every other computer's copy is now stale.
  if (!entries || openForDevice(previous, companyId, dk) !== null) return mine;
  // Set up here for the first time: the computers that already have it keep theirs.
  return packEntries([...entries.filter(([kid]) => kid !== dk.keyId), [dk.keyId, mine]]);
}

/** This computer renewed its own token: only its own entry changes. */
function refreshedHere(previous: string | null, plaintext: string, companyId: string, dk: DeviceKey): string {
  const entries = deviceEntries(previous) ?? [];
  return packEntries([...entries.filter(([kid]) => kid !== dk.keyId), [dk.keyId, sealForDevice(plaintext, companyId, dk)]]);
}

// ---------------------------------------------------------------------------
// The company file's vault secret
// ---------------------------------------------------------------------------

/** The file's vault secret, or null when none has been created yet (read-only). */
export async function readVaultSecret(db: DB): Promise<string | null> {
  const [row] = await db
    .select({ secret: fileSecrets.secret })
    .from(fileSecrets)
    .where(eq(fileSecrets.name, VAULT_SECRET_NAME));
  return row?.secret && row.secret.trim() ? row.secret : null;
}

/** The file's vault secret, created (random, 256 bits) on first use. Concurrent callers agree. */
export async function ensureVaultSecret(db: DB): Promise<string> {
  const existing = await readVaultSecret(db);
  if (existing) return existing;
  await db
    .insert(fileSecrets)
    .values({ name: VAULT_SECRET_NAME, secret: crypto.randomBytes(32).toString('hex') })
    .onConflictDoNothing();
  const created = await readVaultSecret(db);
  if (!created) throw new Error('Cannot create the company file vault secret; refusing to store API keys.');
  return created;
}

/** Seal a plaintext key with the company file's own vault secret ("v2:"). */
export async function sealForFile(db: DB, plaintext: string, companyId: string): Promise<string> {
  return seal(PREFIX_V2, SALT_V2, plaintext, companyId, await ensureVaultSecret(db));
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * True when the company file is protected with passwords (lib/services/fileProtection.ts): its
 * protection record; or its folder's marker (written before the database opens); or the desktop
 * shell started this server for a protected file (BKA_COMPANY_SEALED stays set after the sign-in
 * unlocked it) and `db` is that file's working copy.
 */
export async function fileIsProtected(db: DB, dataDir?: string): Promise<boolean> {
  const [row] = await db.select({ id: fileProtection.id }).from(fileProtection).limit(1);
  if (row) return true;
  const dir = dataDir ?? dataDirOf(db);
  if (!dir) return false;
  if (fs.existsSync(path.join(dir, PROTECTED_MARKER_NAME))) return true;
  const state = process.env.BKA_COMPANY_STATE;
  return Boolean(process.env.BKA_COMPANY_SEALED && state && samePath(path.resolve(path.dirname(state), 'data'), dir));
}

/** Why a value is written (see the module comment). `previous`: the value stored until now. */
export type SealIntent = { entered: string | null | undefined } | { refreshed: string | null | undefined };

/**
 * Seal a secret to store it: for this computer (device secret) when there is one and the company
 * file has no passwords; with the company file's own vault secret otherwise (as before). A renewed
 * sign-in token of a value already sealed for this computer stays this computer's. The result is
 * opened again before it is returned: nothing is stored that can't be read back here.
 */
export async function sealStoredSecret(db: DB, plaintext: string, companyId: string, intent: SealIntent): Promise<string> {
  const dk = deviceKey();
  if (dk) {
    const refresh = 'refreshed' in intent;
    const previous = (refresh ? intent.refreshed : intent.entered) ?? null;
    if ((refresh && isDeviceSealed(previous)) || !(await fileIsProtected(db))) {
      const out = refresh ? refreshedHere(previous, plaintext, companyId, dk) : enteredHere(previous, plaintext, companyId, dk);
      if (openForDevice(out, companyId, dk) !== plaintext) throw new Error('The key could not be stored safely on this computer.');
      return out;
    }
  }
  return sealForFile(db, plaintext, companyId);
}

/**
 * Open a stored value: "v3:"/"v3m:" with this computer's device secret, "v2:" with the file's
 * vault secret (`fileSecret`, from readVaultSecret), "v1:" with this computer's legacy secret.
 * Null when it can't be read here.
 */
export function openStoredSecret(
  blob: string | null | undefined,
  companyId: string,
  fileSecret: string | null,
  dataDir?: string,
): string | null {
  if (!blob || typeof blob !== 'string') return null;
  if (isDeviceSealed(blob)) {
    const dk = deviceKey();
    return dk ? openForDevice(blob, companyId, dk) : null;
  }
  if (blob.startsWith(PREFIX_V2)) return fileSecret ? decryptSecret(blob, companyId, fileSecret) : null;
  if (blob.startsWith(PREFIX_V1)) {
    const legacy = legacySecretOrNull(dataDir);
    return legacy ? decryptSecret(blob, companyId, legacy) : null;
  }
  return null;
}

/** A stored value migrateStoredSecrets would move on this computer (worth calling it for). */
export function needsMoveHere(blob: unknown): boolean {
  return isLegacyBlob(blob) || (isFileBlob(blob) && deviceKey() !== null);
}

// ---------------------------------------------------------------------------
// Migration: keys that travel with the file → keys that stay on this computer
// ---------------------------------------------------------------------------

/**
 * Re-encrypt every legacy "v1:" provider key this computer can still read as a "v2:" key sealed
 * with the company file's vault secret. Keys this computer cannot read (saved on another computer)
 * are left as they are — the AI settings page asks for them again. Writes nothing (and creates no
 * vault secret) when there is nothing to migrate. Returns how many keys were re-encrypted.
 *
 * What migrateStoredSecrets does where there is no device secret, or for a file protected with
 * passwords.
 */
export async function migrateLegacySecrets(
  db: DB,
  opts: { dataDir?: string; companyId?: string } = {},
): Promise<number> {
  const rows = await db
    .select({ id: aiSettings.id, companyId: aiSettings.companyId, providers: aiSettings.providers })
    .from(aiSettings)
    .where(
      opts.companyId
        ? sql`${aiSettings.companyId} = ${opts.companyId} and ${aiSettings.providers}::text like '%"v1:%'`
        : sql`${aiSettings.providers}::text like '%"v1:%'`,
    );
  if (!rows.length) return 0;
  const legacy = legacySecretOrNull(opts.dataDir);
  if (!legacy) return 0;
  let fileSecret: string | null = null;
  let migrated = 0;
  for (const row of rows) {
    const providers = Array.isArray(row.providers) ? row.providers : [];
    let changed = false;
    const next: Record<string, unknown>[] = [];
    for (const p of providers) {
      const blob = p && typeof p === 'object' ? (p as { apiKeyEnc?: unknown }).apiKeyEnc : undefined;
      if (isLegacyBlob(blob)) {
        const plain = decryptSecret(blob, row.companyId, legacy);
        if (plain !== null) {
          fileSecret ??= await ensureVaultSecret(db);
          next.push({ ...p, apiKeyEnc: seal(PREFIX_V2, SALT_V2, plain, row.companyId, fileSecret) });
          changed = true;
          migrated++;
          continue;
        }
      }
      next.push(p);
    }
    if (changed) {
      await db.update(aiSettings).set({ providers: next, updatedAt: new Date() }).where(eq(aiSettings.id, row.id));
    }
  }
  return migrated;
}

/** What is left to move: the vault secret and the values sealed with it (or with .auth-secret). */
async function leftToMove(db: DB) {
  const vault = await readVaultSecret(db);
  const ai = await db
    .select({ id: aiSettings.id, companyId: aiSettings.companyId, providers: aiSettings.providers })
    .from(aiSettings)
    .where(sql`${aiSettings.providers}::text like '%"v1:%' or ${aiSettings.providers}::text like '%"v2:%'`);
  const mail = await db
    .select({ id: companyEmailSettings.id, companyId: companyEmailSettings.companyId, passwordEnc: companyEmailSettings.passwordEnc })
    .from(companyEmailSettings)
    .where(sql`${companyEmailSettings.passwordEnc} like 'v1:%' or ${companyEmailSettings.passwordEnc} like 'v2:%'`);
  return { vault, ai, mail };
}

/**
 * The tables a move rewrites. PGlite never vacuums by itself, so the old row versions (the vault
 * secret, the old blobs) would stay in the database's files — and in every copy of them — until
 * something rewrote the pages: the caller that opened the database compacts them (lib/db/index.ts).
 */
export const MOVED_SECRET_TABLES = ['file_secrets', 'ai_settings', 'company_email_settings'] as const;

async function moveToDevice(db: DB, dk: DeviceKey, dataDir?: string, compact?: () => Promise<void>): Promise<number> {
  // Every open and every settings load looks: nothing to move → nothing written. Without the vault
  // secret only legacy values can be moved (a "v2:" value is then unreadable anywhere — a copy made
  // without the secret): such a file must not be rewritten (and saved) on every open.
  const first = await leftToMove(db);
  const legacyLeft =
    first.ai.some((r) => (Array.isArray(r.providers) ? r.providers : []).some((p) => isLegacyBlob((p as { apiKeyEnc?: unknown } | null)?.apiKeyEnc))) ||
    first.mail.some((r) => isLegacyBlob(r.passwordEnc));
  if (!first.vault && !legacyLeft) return 0;
  let moved = 0;
  let wrote = false;
  // One transaction: a crash leaves the old state (vault secret + v2 values) or the new one, never
  // values that nothing can open.
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    moved = 0;
    const { vault, ai, mail } = await leftToMove(tx);
    let legacy: string | null | undefined;
    const reseal = (blob: unknown, companyId: string): string | null => {
      let plain: string | null = null;
      if (isFileBlob(blob)) plain = vault ? decryptSecret(blob, companyId, vault) : null;
      else if (isLegacyBlob(blob)) {
        if (legacy === undefined) legacy = legacySecretOrNull(dataDir);
        plain = legacy ? decryptSecret(blob, companyId, legacy) : null;
      }
      // Not readable here (sealed elsewhere, damaged): left exactly as it is.
      if (plain === null) return null;
      const next = sealForDevice(plain, companyId, dk);
      if (openForDevice(next, companyId, dk) !== plain) {
        throw new Error('A saved key could not be moved to this computer safely; nothing was changed.');
      }
      moved++;
      return next;
    };
    for (const row of ai) {
      const providers = Array.isArray(row.providers) ? row.providers : [];
      let changed = false;
      const next = providers.map((p) => {
        const blob = p && typeof p === 'object' ? (p as { apiKeyEnc?: unknown }).apiKeyEnc : undefined;
        const sealed = reseal(blob, row.companyId);
        if (sealed === null) return p;
        changed = true;
        return { ...p, apiKeyEnc: sealed };
      });
      if (changed) await tx.update(aiSettings).set({ providers: next }).where(eq(aiSettings.id, row.id));
    }
    for (const row of mail) {
      const sealed = reseal(row.passwordEnc, row.companyId);
      if (sealed !== null) await tx.update(companyEmailSettings).set({ passwordEnc: sealed }).where(eq(companyEmailSettings.id, row.id));
    }
    // The file no longer holds a key that opens its saved values.
    if (vault) await tx.delete(fileSecrets).where(eq(fileSecrets.name, VAULT_SECRET_NAME));
    wrote = moved > 0 || Boolean(vault);
  });
  // Committed: drop the old row versions too (best effort — the move itself is done).
  if (compact && wrote) {
    try {
      await compact();
    } catch (err) {
      console.warn('[keys] could not compact the moved settings:', (err as Error)?.message ?? err);
    }
  }
  return moved;
}

/**
 * Bring the file's saved keys to where they belong on this computer. With a device secret and a
 * company file without passwords: every value this computer can read (v2 with the file's vault
 * secret, v1 with its .auth-secret) is sealed for this computer, and the file's vault secret is
 * deleted (moveToDevice). Otherwise (no device secret, or a protected file) the legacy step as
 * before: v1 → v2. Idempotent; returns how many values were re-sealed.
 *
 * Runs when the company file is opened (lib/db/index.ts) and again when the AI or email settings
 * are loaded and still hold a value to move (lib/services/aiSettings.ts, emailSettings.ts).
 */
export async function migrateStoredSecrets(
  db: DB,
  opts: {
    dataDir?: string;
    companyId?: string;
    /** After a move committed, outside any transaction: rewrite MOVED_SECRET_TABLES (VACUUM FULL). */
    compact?: () => Promise<void>;
  } = {},
): Promise<number> {
  const dk = deviceKey();
  if (!dk || (await fileIsProtected(db, opts.dataDir))) return migrateLegacySecrets(db, opts);
  return moveToDevice(db, dk, opts.dataDir, opts.compact);
}
