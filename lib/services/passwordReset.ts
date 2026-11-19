/**
 * "I forgot my password" (app/api/auth/request-reset → app/api/auth/reset): how reset tokens are
 * kept, and what is left behind when a password was reset with the challenge question.
 *
 * Tokens: 24 random bytes, handed to the person who proved who they are and kept in the company
 * file only as a SHA-256 fingerprint, with how it was earned ("challenge:<sha256>" or
 * "single:<sha256>"). A copy of the file therefore holds no usable token. Tokens older versions
 * stored as plain text never match a fingerprint (migration 0094 also removes them).
 *
 * A reset by challenge question is recorded in the audit trail of every company the user belongs
 * to, and leaves a passive note for the user and for each Admin: a to-do assigned to them, due
 * today, which shows in Needs attention and Reminders and can be marked done or dismissed there
 * ("Your password was reset with your challenge question on <date>."). If someone else guessed the
 * answer, the people who can act on it see it at their next sign-in.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { auditLogs, companies, todos, userCompanies } from '@/lib/db/schema';
import { todayInTimeZone } from '@/lib/preferences';
import { resolveAccess } from './access';

/** How a reset token was earned. */
export type ResetVia = 'challenge' | 'single';

const VIAS: ResetVia[] = ['challenge', 'single'];

/** A new reset token (48 hex characters) — returned to the caller, never stored. */
export function newResetToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

function fingerprint(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** What is stored in users.reset_token for a token. */
export function storedResetToken(token: string, via: ResetVia): string {
  return `${via}:${fingerprint(token)}`;
}

/** Every stored value a presented token can match (one per way of earning it). */
export function resetTokenCandidates(token: string): string[] {
  const f = fingerprint(token);
  return VIAS.map((v) => `${v}:${f}`);
}

/** How the stored token was earned (null for anything else). */
export function resetVia(stored: string | null | undefined): ResetVia | null {
  const via = typeof stored === 'string' ? stored.slice(0, stored.indexOf(':')) : '';
  return (VIAS as string[]).includes(via) ? (via as ResetVia) : null;
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * After a password was reset with the challenge question: an audit-trail row and the notes, in
 * every company the user belongs to. Never throws a reason to undo the reset itself: a failure
 * here is logged and the new password stays.
 */
export async function recordChallengeReset(
  db: DB,
  user: { id: string; name: string; email: string },
  now: Date = new Date(),
): Promise<void> {
  try {
    const memberships = await db
      .select({ companyId: userCompanies.companyId, settings: companies.settings })
      .from(userCompanies)
      .innerJoin(companies, eq(companies.id, userCompanies.companyId))
      .where(eq(userCompanies.userId, user.id));
    const owned = await db
      .select({ companyId: companies.id, settings: companies.settings })
      .from(companies)
      .where(eq(companies.ownerId, user.id));
    const seen = new Set<string>();
    for (const c of [...memberships, ...owned]) {
      if (seen.has(c.companyId)) continue;
      seen.add(c.companyId);
      await db.insert(auditLogs).values({
        companyId: c.companyId,
        userId: user.id,
        action: 'update',
        entityType: 'user',
        entityId: user.id,
        newValues: { email: user.email, passwordReset: true, resetWith: 'challenge_question' },
      });
      const tz = (c.settings as { timezone?: unknown } | null)?.timezone;
      const today = todayInTimeZone(typeof tz === 'string' ? tz : null, now);
      const when = longDate(today);
      const notes: Array<{ to: string; title: string; notes: string }> = [
        {
          to: user.id,
          title: `Your password was reset with your challenge question on ${when}.`,
          notes:
            'If you did not do this, change your password now (Change Password) and pick a new challenge question under Security.',
        },
      ];
      for (const adminId of await adminsOf(db, c.companyId)) {
        if (adminId === user.id) continue;
        notes.push({
          to: adminId,
          title: `${user.name}'s password was reset with their challenge question on ${when}.`,
          notes: `If ${user.name} did not do this, reset their password in Users & Roles.`,
        });
      }
      await db.insert(todos).values(
        notes.map((n) => ({
          companyId: c.companyId,
          userId: user.id,
          title: n.title.slice(0, 255),
          notes: n.notes,
          kind: 'task',
          priority: 'high',
          dueDate: today,
          remindOn: today,
          status: 'open',
          done: false,
          assignedUserId: n.to,
        })),
      );
    }
  } catch (err) {
    console.warn('[auth/reset] could not record the challenge-question reset:', (err as Error)?.message ?? err);
  }
}

/** Active Admins of a company (the owner included when they hold the Admin role). */
async function adminsOf(db: DB, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: userCompanies.userId })
    .from(userCompanies)
    .where(eq(userCompanies.companyId, companyId));
  const [company] = await db.select({ ownerId: companies.ownerId }).from(companies).where(eq(companies.id, companyId));
  const ids = [...new Set([...rows.map((r) => r.userId), ...(company ? [company.ownerId] : [])])];
  const out: string[] = [];
  for (const id of ids) {
    const r = await resolveAccess(db, companyId, id);
    if (r.member && r.active && r.access.isAdmin) out.push(id);
  }
  return out;
}

