/**
 * Encryption at rest for AI provider API keys.
 *
 * AES-256-GCM; the key is derived (HKDF-SHA256) from a secret and bound to the company id
 * (HKDF info + GCM additional data), so a key copied into another company's settings row will
 * not decrypt. Two blob formats, told apart by their prefix:
 *
 *   "v2:" + base64(iv[12] | tag[16] | ciphertext)   CURRENT. The secret is the company FILE's own
 *         vault secret (file_secrets row 'vault', created on first use). It travels with every
 *         copy of the file — the single company file, backups, portable files — so the keys work
 *         on whichever computer opens the file (the office file server, the accountant's PC, a
 *         restore on a new computer).
 *   "v1:" + base64(iv | tag | ciphertext)            LEGACY (before review round 5). The secret was
 *         this computer's `.auth-secret` (or BKA_AUTH_SECRET), the session-signing key that never
 *         goes into a company file, so a v1 key could only ever be read on the computer that saved
 *         it. migrateLegacySecrets re-encrypts v1 keys as v2 the first time the file is opened on
 *         a computer that can still read them (lib/db/index.ts, after migrations).
 *
 * The vault secret is never used to sign sessions: lib/auth.ts keeps signing with the per-computer
 * `.auth-secret`, so a copy of the company file still cannot forge a session on another computer.
 *
 * Plaintext keys never leave the server: the settings API returns only `hasApiKey`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { resolveDataDir, type DB } from '@/lib/db';
import { aiSettings, fileSecrets } from '@/lib/db/schema';

const PREFIX_V1 = 'v1:';
const PREFIX_V2 = 'v2:';
const SALT_V1 = 'bookkeeper-ai/ai-keys';
const SALT_V2 = 'ironbooks/file-vault/v2';

/** Name of the file_secrets row holding the vault secret. */
export const VAULT_SECRET_NAME = 'vault';

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
 * sealForFile (v2), never with this.
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

/**
 * Open a stored blob: "v2:" with the file's vault secret (`fileSecret`, from readVaultSecret),
 * "v1:" with this computer's legacy secret. Null when it can't be read here.
 */
export function openStoredSecret(
  blob: string | null | undefined,
  companyId: string,
  fileSecret: string | null,
  dataDir?: string,
): string | null {
  if (!blob || typeof blob !== 'string') return null;
  if (blob.startsWith(PREFIX_V2)) return fileSecret ? decryptSecret(blob, companyId, fileSecret) : null;
  if (blob.startsWith(PREFIX_V1)) {
    const legacy = legacySecretOrNull(dataDir);
    return legacy ? decryptSecret(blob, companyId, legacy) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Migration: legacy per-computer keys → keys that travel with the file
// ---------------------------------------------------------------------------

/**
 * Re-encrypt every legacy "v1:" provider key this computer can still read as a "v2:" key sealed
 * with the company file's vault secret, so the file's AI keys keep working when the file is
 * opened elsewhere. Keys this computer cannot read (saved on another computer) are left as they
 * are — the AI settings page asks for them again. Writes nothing (and creates no vault secret)
 * when there is nothing to migrate. Returns how many keys were re-encrypted.
 *
 * Runs when the company file is opened (lib/db/index.ts) and again, for one company, whenever its
 * AI settings are loaded (lib/services/aiSettings.ts loadSettings).
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
