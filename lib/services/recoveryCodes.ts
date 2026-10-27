/**
 * Two-factor RECOVERY codes (prefsperms; review round 5 leftover "a sole Admin who loses their
 * authenticator cannot get back in").
 *
 * When someone turns two-factor sign-in on they get ten one-time codes to keep somewhere safe.
 * At sign-in, one of them can be typed instead of the 6-digit authenticator code; it can also turn
 * two-factor sign-in off (Security (2FA)) so a new phone can be set up. Each code works once. New
 * codes (which replace every old one) need a current authenticator code.
 *
 * This is deliberately NOT tied to the challenge question: letting "I forgot my password" also
 * clear two-factor sign-in would turn 2FA into "password OR challenge answer".
 *
 * Codes are 10 characters of Crockford base32 (about 50 bits each), shown as XXXXX-XXXXX. Only a
 * SHA-256 hash bound to the user id is stored (users.totp_recovery_codes); sign-in attempts are
 * rate-limited like passwords, so a fast hash is enough for codes this long and random.
 */
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { users } from '@/lib/db/schema';

export const RECOVERY_CODE_COUNT = 10;
const CODE_LENGTH = 10;
/** Crockford base32: no I, L, O or U, so codes read back without confusion. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface StoredRecoveryCode {
  hash: string;
  usedAt: string | null;
}

/** "abcde 12345" / "ABCDE-12345" → "ABCDE12345"; null when it can't be a recovery code. */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.toUpperCase().replace(/[\s-]+/g, '');
  // Crockford read-back: O is zero, I and L are one.
  const t = raw.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (t.length !== CODE_LENGTH) return null;
  for (const ch of t) if (!ALPHABET.includes(ch)) return null;
  return t;
}

/** True when the typed second factor is shaped like a recovery code (not a 6-digit code). */
export function looksLikeRecoveryCode(input: unknown): boolean {
  return normalizeRecoveryCode(input) !== null;
}

function hashCode(userId: string, normalized: string): string {
  return crypto.createHash('sha256').update(`ironbooks-2fa-recovery:${userId}:${normalized}`).digest('hex');
}

function newCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

const pretty = (c: string) => `${c.slice(0, 5)}-${c.slice(5)}`;

function storedOf(v: unknown): StoredRecoveryCode[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is StoredRecoveryCode => !!x && typeof x === 'object' && typeof (x as StoredRecoveryCode).hash === 'string',
  );
}

/**
 * Make a fresh set of codes for a user (replacing every earlier one) and return them in plain text
 * — the only time they are ever readable.
 */
export async function issueRecoveryCodes(db: DB, userId: string): Promise<string[]> {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newCode());
  const list = [...codes];
  await db
    .update(users)
    .set({ totpRecoveryCodes: list.map((c) => ({ hash: hashCode(userId, c), usedAt: null })), updatedAt: new Date() })
    .where(eq(users.id, userId));
  return list.map(pretty);
}

/** How many unused codes the user has. */
export async function recoveryCodesLeft(db: DB, userId: string): Promise<number> {
  const [row] = await db.select({ codes: users.totpRecoveryCodes }).from(users).where(eq(users.id, userId));
  return storedOf(row?.codes).filter((c) => !c.usedAt).length;
}

/**
 * Use one code: true (and the code is marked used) when it matches an unused code of this user.
 * Compare-and-swap on the stored list, so two sign-ins racing with the same code can't both win.
 */
export async function consumeRecoveryCode(db: DB, userId: string, input: unknown): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return false;
  const want = Buffer.from(hashCode(userId, normalized), 'hex');
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db.select({ codes: users.totpRecoveryCodes }).from(users).where(eq(users.id, userId));
    const stored = storedOf(row?.codes);
    let hit = -1;
    stored.forEach((c, i) => {
      const got = Buffer.from(c.hash, 'hex');
      if (!c.usedAt && got.length === want.length && crypto.timingSafeEqual(got, want)) hit = i;
    });
    if (hit < 0) return false;
    const next = stored.map((c, i) => (i === hit ? { ...c, usedAt: new Date().toISOString() } : c));
    const done = await db
      .update(users)
      .set({ totpRecoveryCodes: next, updatedAt: new Date() })
      .where(and(eq(users.id, userId), sql`${users.totpRecoveryCodes}::text = ${JSON.stringify(row!.codes)}::jsonb::text`))
      .returning({ id: users.id });
    if (done.length) return true;
  }
  return false;
}
