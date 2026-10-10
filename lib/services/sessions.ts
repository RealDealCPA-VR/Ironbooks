/**
 * Multi-user sessions + single-user mode (QuickBooks Desktop Enterprise parity).
 *
 * In multi-user mode one machine hosts the company file and up to ~40 people work in it at
 * once through the host's server (PGlite is single-process, so the host server is the only
 * writer — concurrency between users is handled by lib/services/concurrency.ts).
 *
 *  - Every sign-in creates a `user_sessions` row; its id travels inside the signed session
 *    cookie, so an admin can see "Who is logged in" and sign a session out (revocation is
 *    checked on every request by lib/auth.getSessionInfo).
 *  - "Single-user mode" (`single_user_mode` row, id 'file') reserves the file for one admin
 *    session; getServerContext refuses every other session while it is held. It lapses on its
 *    own if the holder logs out or goes idle, so a crashed admin can't lock everyone out.
 *  - Admin utilities that rewrite the file (condense, restore, rebuild, import) call
 *    assertExclusiveAccess(): owner/admin only, and single-user mode is required whenever
 *    anyone else is connected.
 */
import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { singleUserMode, userSessions, users } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, writeAudit } from './_base';

/** A session counts as "logged in" if it made a request within this window. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
/** lastSeenAt is refreshed at most this often per session (keeps writes off the hot path). */
export const TOUCH_INTERVAL_MS = 60 * 1000;
const SINGLE_USER_ROW = 'file';

export function isAdminRole(role: ServiceContext['role']): boolean {
  // undefined = trusted internal context (tests / system jobs).
  return role === undefined || role === 'owner' || role === 'admin';
}

function assertAdmin(ctx: ServiceContext, what: string): void {
  if (!isAdminRole(ctx.role)) {
    throw new ServiceError('FORBIDDEN', `${what} requires an owner or admin.`);
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface StartSessionInput {
  userId: string;
  companyId?: string | null;
  remoteAddr?: string | null;
  userAgent?: string | null;
  viaHost?: boolean;
}

export async function startSession(db: DB, input: StartSessionInput): Promise<{ id: string }> {
  // Timestamps are set from the app clock (not the column defaults) so every comparison in
  // this module uses one clock regardless of the database session's TimeZone setting.
  const now = new Date();
  const [row] = await db
    .insert(userSessions)
    .values({
      createdAt: now,
      lastSeenAt: now,
      userId: input.userId,
      companyId: input.companyId ?? null,
      remoteAddr: input.remoteAddr?.slice(0, 100) ?? null,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      viaHost: Boolean(input.viaHost),
    })
    .returning({ id: userSessions.id });
  return row;
}

export async function endSession(db: DB, sessionId: string, reason = 'logout'): Promise<void> {
  if (!isUuid(sessionId)) return;
  await db
    .update(userSessions)
    .set({ endedAt: new Date(), endReason: reason })
    .where(and(eq(userSessions.id, sessionId), isNull(userSessions.endedAt)));
  // Leaving the file releases single-user mode too.
  await db.delete(singleUserMode).where(eq(singleUserMode.sessionId, sessionId));
}

/**
 * Validate a session id taken from a verified cookie and refresh its lastSeenAt (throttled).
 * Returns false when the session doesn't exist, belongs to someone else, or has been ended
 * (logout / signed out by an admin) — the caller then treats the request as signed out.
 */
export async function touchSession(
  db: DB,
  sessionId: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isUuid(sessionId)) return false;
  const [row] = await db
    .select({ userId: userSessions.userId, endedAt: userSessions.endedAt, lastSeenAt: userSessions.lastSeenAt })
    .from(userSessions)
    .where(eq(userSessions.id, sessionId));
  if (!row || row.userId !== userId || row.endedAt) return false;
  if (now.getTime() - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    await db.update(userSessions).set({ lastSeenAt: now }).where(eq(userSessions.id, sessionId));
  }
  return true;
}

export interface ActiveSession {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  remoteAddr: string | null;
  userAgent: string | null;
  viaHost: boolean;
  createdAt: Date;
  lastSeenAt: Date;
  /** The session making this request. */
  isCurrent: boolean;
}

/** Sessions that made a request within ACTIVE_WINDOW_MS and haven't ended, newest first. */
export async function listActiveSessions(
  db: DB,
  opts: { currentSessionId?: string; now?: Date } = {},
): Promise<ActiveSession[]> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - ACTIVE_WINDOW_MS);
  const rows = await db
    .select({
      id: userSessions.id,
      userId: userSessions.userId,
      userName: users.name,
      userEmail: users.email,
      remoteAddr: userSessions.remoteAddr,
      userAgent: userSessions.userAgent,
      viaHost: userSessions.viaHost,
      createdAt: userSessions.createdAt,
      lastSeenAt: userSessions.lastSeenAt,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(isNull(userSessions.endedAt), gt(userSessions.lastSeenAt, cutoff)))
    .orderBy(desc(userSessions.lastSeenAt));
  return rows.map((r) => ({ ...r, isCurrent: r.id === opts.currentSessionId }));
}

/** "Who is logged in" — owner/admin only. */
export async function listSessionsForAdmin(ctx: ServiceContext): Promise<ActiveSession[]> {
  assertAdmin(ctx, 'Viewing who is logged in');
  return listActiveSessions(ctx.db, { currentSessionId: ctx.sessionId });
}

/** Sign a session out. Admins may end any session; everyone may end their own. */
export async function signOutSession(ctx: ServiceContext, sessionId: string): Promise<void> {
  if (!isUuid(sessionId)) throw new ServiceError('NOT_FOUND', 'Session not found');
  const [row] = await ctx.db
    .select({ userId: userSessions.userId, endedAt: userSessions.endedAt })
    .from(userSessions)
    .where(eq(userSessions.id, sessionId));
  if (!row) throw new ServiceError('NOT_FOUND', 'Session not found');
  const own = row.userId === ctx.userId;
  if (!own) assertAdmin(ctx, "Signing out another user's session");
  if (row.endedAt) return;
  await endSession(ctx.db, sessionId, own ? 'logout' : 'signed_out_by_admin');
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'user_session',
    entityId: sessionId,
    newValues: { ended: true, by: ctx.userId, reason: own ? 'logout' : 'signed_out_by_admin' },
  });
}

// ---------------------------------------------------------------------------
// Single-user mode
// ---------------------------------------------------------------------------

export interface SingleUserState {
  sessionId: string;
  userId: string;
  userName: string;
  enabledAt: Date;
}

/** Current single-user holder, or null. A holder that logged out or went idle is released. */
export async function getSingleUserMode(db: DB, now: Date = new Date()): Promise<SingleUserState | null> {
  const [row] = await db
    .select({
      sessionId: singleUserMode.sessionId,
      userId: singleUserMode.userId,
      enabledAt: singleUserMode.enabledAt,
      userName: users.name,
      endedAt: userSessions.endedAt,
      lastSeenAt: userSessions.lastSeenAt,
    })
    .from(singleUserMode)
    .leftJoin(users, eq(users.id, singleUserMode.userId))
    .leftJoin(userSessions, eq(userSessions.id, singleUserMode.sessionId))
    .where(eq(singleUserMode.id, SINGLE_USER_ROW));
  if (!row) return null;
  const stale =
    !row.lastSeenAt || row.endedAt !== null || now.getTime() - row.lastSeenAt.getTime() > ACTIVE_WINDOW_MS;
  if (stale) {
    await db.delete(singleUserMode).where(eq(singleUserMode.id, SINGLE_USER_ROW));
    return null;
  }
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    userName: row.userName ?? 'An administrator',
    enabledAt: row.enabledAt,
  };
}

/**
 * Request gate (called by getServerContext): while single-user mode is held, only the holder's
 * session may use the file.
 */
export async function assertSessionAllowed(db: DB, sessionId: string | undefined): Promise<void> {
  const holder = await getSingleUserMode(db);
  if (holder && holder.sessionId !== sessionId) {
    throw new ServiceError(
      'FORBIDDEN',
      `The company file is in single-user mode — ${holder.userName} is doing maintenance. Try again when they switch back to multi-user mode.`,
      { singleUserMode: true },
    );
  }
}

function describeOthers(others: ActiveSession[]): string {
  const names = [...new Set(others.map((s) => s.userName))];
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? `, +${names.length - 5} more` : '');
  return `${others.length} other ${others.length === 1 ? 'session is' : 'sessions are'} logged in (${shown})`;
}

/** Active sessions other than the caller's own. */
async function otherSessions(ctx: ServiceContext): Promise<ActiveSession[]> {
  const all = await listActiveSessions(ctx.db, { currentSessionId: ctx.sessionId });
  return all.filter((s) => !s.isCurrent);
}

/**
 * Switch to single-user mode. Owner/admin only, from a signed-in session. Refuses (CONFLICT,
 * listing who) while anyone else is still connected — they log out, or the admin signs them out.
 */
export async function enterSingleUserMode(ctx: ServiceContext): Promise<SingleUserState> {
  assertAdmin(ctx, 'Single-user mode');
  if (!ctx.sessionId || !ctx.userId) {
    throw new ServiceError('FORBIDDEN', 'Sign in to switch to single-user mode.');
  }
  const holder = await getSingleUserMode(ctx.db);
  if (holder) {
    if (holder.sessionId === ctx.sessionId) return holder;
    throw new ServiceError('CONFLICT', `${holder.userName} already has the file in single-user mode.`);
  }
  const others = await otherSessions(ctx);
  if (others.length > 0) {
    throw new ServiceError(
      'CONFLICT',
      `Can't switch to single-user mode: ${describeOthers(others)}. Ask them to log out, or sign them out from the list.`,
      { sessions: others.map((s) => ({ id: s.id, userName: s.userName })) },
    );
  }
  const inserted = await ctx.db
    .insert(singleUserMode)
    .values({ id: SINGLE_USER_ROW, sessionId: ctx.sessionId, userId: ctx.userId, enabledAt: new Date() })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    throw new ServiceError('CONFLICT', 'Another administrator just switched the file to single-user mode.');
  }
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'single_user_mode',
    entityId: ctx.sessionId,
    newValues: { enabled: true },
  });
  const state = await getSingleUserMode(ctx.db);
  return state!;
}

/** Switch back to multi-user mode (the holder, or any owner/admin). */
export async function exitSingleUserMode(ctx: ServiceContext): Promise<void> {
  const holder = await getSingleUserMode(ctx.db);
  if (!holder) return;
  if (holder.sessionId !== ctx.sessionId) assertAdmin(ctx, 'Leaving single-user mode');
  await ctx.db.delete(singleUserMode).where(eq(singleUserMode.id, SINGLE_USER_ROW));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'single_user_mode',
    entityId: holder.sessionId,
    newValues: { enabled: false },
  });
}

/**
 * Gate for admin utilities that rewrite the file (condense, restore, rebuild, import).
 * Owner/admin only; when anyone else is connected the caller must hold single-user mode.
 */
export async function assertExclusiveAccess(ctx: ServiceContext, utility: string): Promise<void> {
  assertAdmin(ctx, utility);
  const holder = await getSingleUserMode(ctx.db);
  if (holder && holder.sessionId === ctx.sessionId) return;
  const others = await otherSessions(ctx);
  if (others.length === 0) return;
  throw new ServiceError(
    'CONFLICT',
    `${utility} needs single-user mode while other people are using this company file: ${describeOthers(others)}. Switch to single-user mode (Setup → Multi-user) and try again.`,
    { requiresSingleUser: true, sessions: others.map((s) => ({ id: s.id, userName: s.userName })) },
  );
}

/** Sign out every other active session (used before switching to single-user mode). */
export async function signOutOtherSessions(ctx: ServiceContext): Promise<number> {
  assertAdmin(ctx, 'Signing out other users');
  const others = await otherSessions(ctx);
  if (others.length === 0) return 0;
  const ids = others.map((s) => s.id);
  await ctx.db
    .update(userSessions)
    .set({ endedAt: new Date(), endReason: 'signed_out_by_admin' })
    .where(and(inArray(userSessions.id, ids), isNull(userSessions.endedAt)));
  if (ctx.sessionId) {
    await ctx.db.delete(singleUserMode).where(ne(singleUserMode.sessionId, ctx.sessionId));
  }
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'user_session',
    entityId: ctx.sessionId ?? ids[0],
    newValues: { signedOutOthers: ids.length, by: ctx.userId },
  });
  return ids.length;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
