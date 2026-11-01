/**
 * File-level password — a QuickBooks-Desktop-style "company file password".
 *
 * A company file is one PGlite data directory. This optional password gates OPENING the whole
 * file and is independent of the multi-user login: a file can have a file password and no user
 * accounts at all (the standalone model). The bcrypt hash is stored on the file's PRIMARY company
 * (the earliest-created company row), so a single-company file — the normal case — has exactly one
 * file password.
 *
 * Enforcement lives in `getServerContext` (covers every API route and server render, even when the
 * file has no user accounts) plus a middleware redirect to `/unlock` for page navigation. The
 * unlock token itself (lib/auth) is bound to the data dir + per-launch nonce.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { companies } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import type { DB } from '@/lib/db';
import { ServiceError, validation } from './_base';

interface FileLock {
  enabled?: boolean;
  hash?: string;
}

export interface FileLockStatus {
  enabled: boolean;
  /** Display name of the file (its primary company), for the unlock screen. */
  companyName: string | null;
}

/** The file's primary company row (earliest created) — the canonical holder of file-wide config. */
async function primaryCompany(db: DB) {
  const [c] = await db
    .select({ id: companies.id, name: companies.name, settings: companies.settings })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  return c ?? null;
}

function readLock(settings: unknown): FileLock {
  const fl = (settings as Record<string, unknown> | null | undefined)?.fileLock;
  return fl && typeof fl === 'object' ? (fl as FileLock) : {};
}

/** Whether this company file requires a password to open. */
export async function getFileLockStatus(db: DB): Promise<FileLockStatus> {
  const c = await primaryCompany(db);
  const fl = readLock(c?.settings);
  return { enabled: Boolean(fl.enabled && fl.hash), companyName: c?.name ?? null };
}

/** True when the file is unprotected, or when the supplied password matches. */
export async function verifyFilePassword(db: DB, password: string): Promise<boolean> {
  const c = await primaryCompany(db);
  const fl = readLock(c?.settings);
  if (!fl.enabled || !fl.hash) return true; // not protected → always "unlocked"
  if (!password) return false;
  return verifyPassword(password, fl.hash);
}

async function writeLock(db: DB, next: FileLock | null): Promise<void> {
  const c = await primaryCompany(db);
  if (!c) throw new ServiceError('NOT_FOUND', 'No company exists in this file yet.');
  // Only the fileLock key changes, merged in SQL (prefsperms, review 5 leftover): writing back the
  // whole settings object read above undid a Preferences save or a policy change made meanwhile.
  const settings = next
    ? sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('fileLock', ${JSON.stringify(next)}::jsonb)`
    : sql`coalesce(${companies.settings}, '{}'::jsonb) - 'fileLock'`;
  await db.update(companies).set({ settings, updatedAt: new Date() }).where(eq(companies.id, c.id));
}

/**
 * Set or change the file password. When a password is already set, the current one must be
 * supplied. Never stores or logs the plaintext.
 */
export async function setFilePassword(
  db: DB,
  newPassword: string,
  opts: { currentPassword?: string } = {},
): Promise<void> {
  const status = await getFileLockStatus(db);
  if (status.enabled && !(await verifyFilePassword(db, opts.currentPassword ?? ''))) {
    throw validation('The current file password is incorrect.');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    throw validation('The file password must be at least 4 characters.');
  }
  await writeLock(db, { enabled: true, hash: await hashPassword(newPassword) });
}

/** Remove the file password (the current password must be supplied). */
export async function removeFilePassword(db: DB, currentPassword: string): Promise<void> {
  const status = await getFileLockStatus(db);
  if (!status.enabled) return;
  if (!(await verifyFilePassword(db, currentPassword))) {
    throw validation('The current file password is incorrect.');
  }
  await writeLock(db, null);
}

/**
 * Remove the file password WITHOUT the current one — only for someone who has just proved they
 * hold the company file's recovery key (app/api/auth/recover, lib/services/fileProtection.ts):
 * the recovery key opens everything in the file, so it must also get past a forgotten file password.
 */
export async function removeFilePasswordWithRecoveryKey(db: DB): Promise<boolean> {
  const status = await getFileLockStatus(db);
  if (!status.enabled) return false;
  await writeLock(db, null);
  return true;
}
