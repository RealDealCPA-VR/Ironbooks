/**
 * Encryption at rest for AI provider API keys.
 *
 * AES-256-GCM with a key derived (HKDF-SHA256) from the company data directory's secret —
 * the same `.auth-secret` file lib/auth.ts uses for session signing (or BKA_AUTH_SECRET when
 * set). The ciphertext is bound to the company id via GCM additional data, so a key copied
 * into another company's settings row will not decrypt.
 *
 * Format: "v1:" + base64(iv[12] | tag[16] | ciphertext).
 *
 * Plaintext keys never leave the server: the settings API returns only `hasApiKey`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from '@/lib/db';

const PREFIX = 'v1:';

/**
 * The data-directory secret (mirrors lib/auth.ts `secret()`; same file, same env override).
 * Created with an exclusive write so two first-callers can't race different secrets.
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

function deriveKey(secret: string, companyId: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('bookkeeper-ai/ai-keys'), Buffer.from(`company:${companyId}`), 32),
  );
}

export function encryptSecret(plaintext: string, companyId: string, secret = dataDirSecret()): string {
  const key = deriveKey(secret, companyId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(companyId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Returns null when the value cannot be decrypted (wrong secret/company, tampered, malformed). */
export function decryptSecret(blob: string | null | undefined, companyId: string, secret = dataDirSecret()): string | null {
  if (!blob || !blob.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
    if (raw.length < 29) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, companyId), iv);
    decipher.setAAD(Buffer.from(companyId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
