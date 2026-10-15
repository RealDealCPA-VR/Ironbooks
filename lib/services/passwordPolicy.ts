/**
 * Password policy for the company file (gapsb, K) — the server side of lib/passwordPolicy.ts.
 *
 * The policy is file-wide (users and their logins live in the company file, not in one company),
 * so like the file password it is stored on the file's PRIMARY company (earliest created) under
 * settings.passwordPolicy. Only an Admin of every company in the file may change it
 * (requireFileAdmin), from Users & Roles.
 *
 * Enforced wherever a password is SET: sign-up, reset by email token, an Admin setting a user's
 * password (add user / reset password), and a person changing their own password. Sign-in never
 * rejects an existing password for not meeting a newer policy; when the password has expired (or
 * an Admin asked for a new one) the sign-in succeeds but the session is limited to choosing a new
 * password (getServerContext refuses everything else with PASSWORD_CHANGE_REQUIRED_MESSAGE).
 */
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { companies, passwordHistory, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  PASSWORD_POLICY_LIMITS,
  isPasswordExpired,
  normalizePasswordPolicy,
  passwordProblemMessage,
  passwordProblems,
  type PasswordPolicy,
} from '@/lib/passwordPolicy';
import { ServiceError, validation, writeAudit, type ServiceContext } from './_base';
import { requireFileAdmin } from './access';
import { logTransaction } from './transactionLog';

/** How many old hashes are kept per user (the largest "don't reuse" setting). */
const HISTORY_KEEP = PASSWORD_POLICY_LIMITS.historyCount[1];

async function primaryCompany(db: DB) {
  const [c] = await db
    .select({ id: companies.id, settings: companies.settings })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  return c ?? null;
}

/** The file's password policy (defaults until an Admin saves one). */
export async function getPasswordPolicy(db: DB): Promise<PasswordPolicy> {
  const c = await primaryCompany(db);
  const raw = (c?.settings as Record<string, unknown> | null | undefined)?.passwordPolicy;
  return raw ? normalizePasswordPolicy(raw) : { ...DEFAULT_PASSWORD_POLICY };
}

/** Validate an Admin's policy edit (plain messages; numbers must be whole and in range). */
function validatePolicyInput(input: Partial<PasswordPolicy>, current: PasswordPolicy): PasswordPolicy {
  const next = { ...current };
  const whole = (key: 'minLength' | 'expiryDays' | 'historyCount', label: string) => {
    const v = input[key];
    if (v === undefined) return;
    const [lo, hi] = PASSWORD_POLICY_LIMITS[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
      throw validation(`${label} must be a whole number from ${lo} to ${hi}.`);
    }
    next[key] = v;
  };
  whole('minLength', 'Minimum length');
  whole('expiryDays', 'Days before a password expires');
  whole('historyCount', 'Number of earlier passwords that cannot be reused');
  for (const key of ['requireLettersAndNumbers', 'requireSymbol'] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw validation(`${key} must be true or false.`);
    next[key] = v;
  }
  return next;
}

/** Save the file's password policy. Admin of every company in the file only. */
export async function updatePasswordPolicy(
  ctx: ServiceContext,
  input: Partial<PasswordPolicy>,
): Promise<PasswordPolicy> {
  await requireFileAdmin(ctx);
  const c = await primaryCompany(ctx.db);
  if (!c) throw new ServiceError('NOT_FOUND', 'No company exists in this file yet.');
  const before = await getPasswordPolicy(ctx.db);
  const next = validatePolicyInput(input, before);
  const settings = { ...((c.settings ?? {}) as Record<string, unknown>), passwordPolicy: next };
  await ctx.db.update(companies).set({ settings, updatedAt: new Date() }).where(eq(companies.id, c.id));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'password_policy',
    entityId: c.id,
    oldValues: before,
    newValues: next,
  });
  return next;
}

/**
 * Refuse a new password that breaks the policy, or (for an existing user) one of their last N
 * passwords. Plain-language messages; the password itself is never logged or echoed.
 */
export async function assertPasswordAllowed(
  db: DB,
  password: string,
  opts: { userId?: string | null; policy?: PasswordPolicy } = {},
): Promise<PasswordPolicy> {
  const policy = opts.policy ?? (await getPasswordPolicy(db));
  const problems = passwordProblems(password, policy);
  if (problems.length) throw validation(passwordProblemMessage(problems));
  if (opts.userId && policy.historyCount > 0) {
    const [user] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, opts.userId));
    const earlier = await db
      .select({ hash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, opts.userId))
      .orderBy(desc(passwordHistory.createdAt))
      .limit(Math.max(0, policy.historyCount - 1));
    const hashes = [user?.hash, ...earlier.map((e) => e.hash)].filter(
      (h): h is string => typeof h === 'string' && h.length > 10,
    );
    for (const h of hashes) {
      if (await verifyPassword(password, h)) {
        throw validation(
          policy.historyCount === 1
            ? 'Choose a password that is different from the current one.'
            : `Choose a password you haven't used for your last ${policy.historyCount} passwords.`,
        );
      }
    }
  }
  return policy;
}

/**
 * Store a new password for a user (already checked with assertPasswordAllowed): the old hash
 * goes into the history, the change date is stamped, and `mustChange` decides whether the next
 * sign-in has to choose another one (an Admin can ask for that when setting a password).
 * Runs on the given db handle (pass a transaction to make it part of a larger change).
 */
export async function storeUserPassword(
  db: DB,
  userId: string,
  password: string,
  opts: { mustChange?: boolean } = {},
): Promise<void> {
  const [user] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!user) throw new ServiceError('NOT_FOUND', 'User not found.');
  if (user.hash && user.hash.length > 10) {
    await db.insert(passwordHistory).values({ userId, passwordHash: user.hash });
    const keep = await db
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt))
      .offset(HISTORY_KEEP);
    if (keep.length) await db.delete(passwordHistory).where(inArray(passwordHistory.id, keep.map((k) => k.id)));
  }
  const now = new Date();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      passwordChangedAt: now,
      mustChangePassword: opts.mustChange === true,
      resetToken: null,
      resetExpires: null,
      updatedAt: now,
    })
    .where(eq(users.id, userId));
}

export type PasswordChangeReason = 'expired' | 'required';

/**
 * Called right after a successful sign-in. An expired password (per the file's policy) is marked
 * "must change"; returns why a change is needed, or null. The sign-in itself always goes ahead.
 */
export async function passwordStatusAtSignIn(
  db: DB,
  user: { id: string; createdAt: Date; passwordChangedAt?: Date | null; mustChangePassword?: boolean | null },
  now: Date = new Date(),
): Promise<PasswordChangeReason | null> {
  if (user.mustChangePassword) return 'required';
  const policy = await getPasswordPolicy(db);
  if (!isPasswordExpired(user.passwordChangedAt ?? user.createdAt, policy, now)) return null;
  await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id));
  return 'expired';
}

/** getServerContext hook: a session whose password must be changed can do nothing else yet. */
export async function assertPasswordChangeNotRequired(db: DB, userId: string): Promise<void> {
  const [row] = await db.select({ must: users.mustChangePassword }).from(users).where(eq(users.id, userId));
  if (row?.must) {
    throw new ServiceError('FORBIDDEN', PASSWORD_CHANGE_REQUIRED_MESSAGE, { passwordChangeRequired: true });
  }
}

/** A signed-in person changes their own password (current password required). */
export async function changeOwnPassword(
  db: DB,
  userId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new ServiceError('FORBIDDEN', 'Authentication required.');
  if (typeof input.currentPassword !== 'string' || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw validation('Your current password is not correct.');
  }
  if (input.newPassword === input.currentPassword) {
    throw validation('Choose a password that is different from the current one.');
  }
  await assertPasswordAllowed(db, input.newPassword, { userId });
  await storeUserPassword(db, userId, input.newPassword, { mustChange: false });
  await logTransaction(db, {
    userId,
    action: 'update',
    entityType: 'user',
    entityId: userId,
    summary: `Changed the password for user "${user.name}"`,
    data: { new: { passwordChanged: true, wasRequired: user.mustChangePassword } },
  });
}
