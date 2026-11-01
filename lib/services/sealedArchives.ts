/**
 * Opening the protected copies of a company file in the app server (filecrypto): backups (.bka),
 * safety copies made before a restore or a condense, condense archives and per-company backups.
 *
 * A copy of a company file protected with passwords is encrypted with that file's key
 * (electron/companyFileFormat.js sealed layout). When it was made with the key this server holds
 * for the open file, it opens without asking. Otherwise — a backup of another protected company
 * file, or one made before a restore brought in another key — it opens only with a user name and
 * password from the company file it was made from, or that file's recovery key
 * (ArchiveCredentials). Every entry is decrypted and its authentication tag verified in memory
 * before a single byte is written to disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import format from '@/electron/companyFileFormat';
import { resolveDataDir } from '@/lib/db';
import { ServiceError } from './errors';
import { keyForSealedArchive } from './fileProtection';

/** A user name + password from the company file a copy was made from, or its recovery key. */
export interface ArchiveCredentials {
  login?: string | null;
  password?: string | null;
  recoveryKey?: string | null;
}

export const PROTECTED_ARCHIVE_MESSAGE =
  'This backup is protected with passwords from another company file. Enter a user name and password from the company file it was made from, or that file’s recovery key.';

export const WRONG_ARCHIVE_CREDENTIALS_MESSAGE =
  'That user name and password (or recovery key) do not open this backup. Use one from the company file it was made from.';

export interface SealedHead {
  /** 'ironbooks-company.json' (a company file used as a backup) or 'bookkeeper-manifest.json'. */
  name: string;
  manifest: Record<string, any>;
}

/** The plain manifest of a protected archive, or null for one without passwords (or not ours). */
export function sealedHeadOf(buffer: Buffer): SealedHead | null {
  const head = format.readArchiveHead(buffer) as { name: string; manifest: Record<string, any> | null } | null;
  return head && head.manifest && format.isSealedManifest(head.manifest) ? { name: head.name, manifest: head.manifest } : null;
}

function hasCredentials(c: ArchiveCredentials | null | undefined): boolean {
  return Boolean(c && ((c.login && c.password) || c.recoveryKey));
}

export interface UnsealedArchive {
  head: SealedHead;
  /** The private details of the archive's plain manifest (kept encrypted inside it). */
  info: Record<string, any>;
  /** Every entry, verified and decrypted: { name, data } for files, { name, dir: true } for folders. */
  entries: Array<{ name: string; data?: Buffer; dir?: boolean }>;
  /** The key that opened it (this file's own, or the one the credentials unwrapped). */
  key: Buffer;
}

/**
 * Decrypt a protected archive held in memory. Throws FORBIDDEN (details.credentialsRequired) when
 * nothing given opens it — details.wrongCredentials when credentials were given and are wrong —
 * and VALIDATION when it was changed or damaged.
 */
export async function unsealArchive(
  buffer: Buffer,
  credentials?: ArchiveCredentials | null,
  dataDir: string = resolveDataDir(),
): Promise<UnsealedArchive> {
  const head = sealedHeadOf(buffer);
  if (!head) throw new ServiceError('VALIDATION', 'This file is not a protected Ironbooks backup.');
  const key = await keyForSealedArchive(head.manifest.encryption, credentials ?? null, dataDir);
  if (!key) {
    const wrong = hasCredentials(credentials);
    throw new ServiceError('FORBIDDEN', wrong ? WRONG_ARCHIVE_CREDENTIALS_MESSAGE : PROTECTED_ARCHIVE_MESSAGE, {
      credentialsRequired: true,
      ...(wrong ? { wrongCredentials: true } : {}),
      companyName: typeof head.manifest.companyName === 'string' ? head.manifest.companyName : null,
    });
  }
  try {
    const opened = format.unsealArchiveSync(buffer, key) as { info: Record<string, any>; entries: UnsealedArchive['entries'] };
    return { head, info: opened.info ?? {}, entries: opened.entries, key };
  } catch (err) {
    if ((err as { code?: string })?.code === 'TAMPERED' || (err as Error)?.name === 'NotACompanyFileError') {
      throw new ServiceError('VALIDATION', `${(err as Error).message} Try an earlier backup.`);
    }
    throw err;
  }
}

/**
 * Write the decrypted entries of an archive into `root` (created; must be empty). Names stay
 * inside `root`; the archive's own manifests and `skip` (this location's files) are left out.
 */
export function writeUnsealedEntries(entries: UnsealedArchive['entries'], root: string, skip: readonly string[] = []): void {
  const abs = path.resolve(root);
  fs.mkdirSync(abs, { recursive: true });
  if (fs.readdirSync(abs).length) throw new ServiceError('INTERNAL', 'The folder to restore into is not empty.');
  for (const e of entries) {
    const name = format.safeEntryName(e.name) as string | null;
    if (!name) continue;
    if (name === format.COMPANY_MANIFEST_ENTRY || name === format.BACKUP_MANIFEST_ENTRY || skip.includes(name)) continue;
    const target = path.resolve(abs, ...name.split('/').filter(Boolean));
    if (target !== abs && !target.startsWith(abs + path.sep)) continue;
    if (e.dir || name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data ?? Buffer.alloc(0));
  }
}

/**
 * The backup manifest of an unsealed archive: a sealed backup's plain listing fields joined with
 * its private details, or — for a protected company file used as a backup — the backup manifest
 * kept (encrypted) inside it.
 */
export function backupManifestOf(u: UnsealedArchive): Record<string, any> | null {
  if (u.head.name === format.BACKUP_MANIFEST_ENTRY) return { ...u.info, ...u.head.manifest };
  const inner = u.entries.find((e) => e.name === format.BACKUP_MANIFEST_ENTRY && e.data);
  if (!inner?.data) return null;
  try {
    const m = JSON.parse(inner.data.toString('utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}
