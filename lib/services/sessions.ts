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
 *  - One company file may hold several companies. Everything an admin sees or does here is
 *    scoped to their company: "Who is logged in" and sign-out cover only sessions of users who
 *    are members of ctx.companyId, never another company's people.
 *  - "Single-user mode" (`single_user_mode` row, id = company id) reserves ONE company for one
 *    admin session; getServerContext refuses every other session working in that company while
 *    it is held. It lapses on its own if the holder logs out or goes idle, so a crashed admin
 *    can't lock everyone out.
 *  - Admin utilities call assertExclusiveAccess(): owner/admin only, and single-user mode is
 *    required whenever anyone else is connected. Condense / Rebuild / Import act on one company
 *    (scope 'company'); Restore replaces the whole data directory (scope 'file') and so also
 *    needs every other company's users to be logged out.
 *  - At most MAX_CONCURRENT_USERS distinct people may be logged in at once (QB Enterprise: 40).
 */
import { and, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { singleUserMode, userCompanies, userSessions, users } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, writeAudit } from './_base';

/** A session counts as "logged in" if it made a request within this window. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
/** lastSeenAt is refreshed at most this often per session (keeps writes off the hot path). */
export const TOUCH_INTERVAL_MS = 60 * 1000;
/** QuickBooks Desktop Enterprise allows up to 40 simultaneous users per company file. */
export const MAX_CONCURRENT_USERS = 40;

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
  // The seat count and the insert run in one transaction, serialised by an advisory lock, so
  // two sign-ins racing for the last seat can't both see a free one and both get in.
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    await tx.execute(sql`select pg_advisory_xact_lock(${SEAT_LOCK_KEY})`);
    // Seat limit applies to people connecting over the network; the host machine always gets in.
    if (input.viaHost) await assertSeatAvailable(tx, input.userId);
    // Timestamps are set from the app clock (not the column defaults) so every comparison in
    // this module uses one clock regardless of the database session's TimeZone setting.
    const now = new Date();
    const [row] = await tx
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
  });
}

/** Advisory-lock key serialising sign-ins (seat count + insert). Arbitrary app-wide constant. */
const SEAT_LOCK_KEY = 4_024_001;

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
 * End every live session of one user (e.g. after a self-service password reset, so whoever
 * held the old password is signed out everywhere). Returns how many sessions were ended.
 */
export async function endUserSessions(db: DB, userId: string, reason = 'password_reset'): Promise<number> {
  if (!isUuid(userId)) return 0;
  const ended = await db
    .update(userSessions)
    .set({ endedAt: new Date(), endReason: reason })
    .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)))
    .returning({ id: userSessions.id });
  const ids = ended.map((r) => r.id);
  if (ids.length) await db.delete(singleUserMode).where(inArray(singleUserMode.sessionId, ids));
  return ids.length;
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

/**
 * Sessions that made a request within ACTIVE_WINDOW_MS and haven't ended, newest first.
 * `companyId` limits the list to users who are members of that company (omit = whole file —
 * only for file-wide checks such as Restore and the seat limit, never shown to a user).
 */
export async function listActiveSessions(
  db: DB,
  opts: { currentSessionId?: string; now?: Date; companyId?: string } = {},
): Promise<ActiveSession[]> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - ACTIVE_WINDOW_MS);
  const conds = [isNull(userSessions.endedAt), gt(userSessions.lastSeenAt, cutoff)];
  if (opts.companyId) conds.push(inArray(userSessions.userId, membersOf(db, opts.companyId)));
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
    .where(and(...conds))
    .orderBy(desc(userSessions.lastSeenAt));
  return rows.map((r) => ({ ...r, isCurrent: r.id === opts.currentSessionId }));
}

/** Subquery: ids of the users who are members of a company. */
function membersOf(db: DB, companyId: string) {
  return db.select({ id: userCompanies.userId }).from(userCompanies).where(eq(userCompanies.companyId, companyId));
}

async function isMemberOf(db: DB, userId: string, companyId: string): Promise<boolean> {
  const [m] = await db
    .select({ userId: userCompanies.userId })
    .from(userCompanies)
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, companyId)));
  return Boolean(m);
}

/** "Who is logged in" for the caller's company — owner/admin only. */
export async function listSessionsForAdmin(ctx: ServiceContext): Promise<ActiveSession[]> {
  assertAdmin(ctx, 'Viewing who is logged in');
  return listActiveSessions(ctx.db, { currentSessionId: ctx.sessionId, companyId: ctx.companyId });
}

/**
 * Sign a session out. Everyone may end their own; owner/admin may end sessions of members of
 * their own company (another company's sessions in the same file are reported as not found).
 */
export async function signOutSession(ctx: ServiceContext, sessionId: string): Promise<void> {
  if (!isUuid(sessionId)) throw new ServiceError('NOT_FOUND', 'Session not found');
  const [row] = await ctx.db
    .select({ userId: userSessions.userId, endedAt: userSessions.endedAt })
    .from(userSessions)
    .where(eq(userSessions.id, sessionId));
  if (!row) throw new ServiceError('NOT_FOUND', 'Session not found');
  const own = row.userId === ctx.userId;
  if (!own) {
    assertAdmin(ctx, "Signing out another user's session");
    if (!(await isMemberOf(ctx.db, row.userId, ctx.companyId))) {
      throw new ServiceError('NOT_FOUND', 'Session not found');
    }
  }
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
  companyId: string;
  sessionId: string;
  userId: string;
  userName: string;
  enabledAt: Date;
}

/**
 * Current single-user holder for a company (omit companyId = any company in the file), or null.
 * A holder that logged out or went idle is released.
 */
export async function getSingleUserMode(
  db: DB,
  companyId?: string | null,
  now: Date = new Date(),
): Promise<SingleUserState | null> {
  const rows = await db
    .select({
      id: singleUserMode.id,
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
    .where(companyId ? eq(singleUserMode.id, companyId) : undefined);
  for (const row of rows) {
    const stale =
      !row.lastSeenAt || row.endedAt !== null || now.getTime() - row.lastSeenAt.getTime() > ACTIVE_WINDOW_MS;
    if (stale) {
      await db.delete(singleUserMode).where(eq(singleUserMode.id, row.id));
      continue;
    }
    return {
      companyId: row.id,
      sessionId: row.sessionId,
      userId: row.userId,
      userName: row.userName ?? 'An administrator',
      enabledAt: row.enabledAt,
    };
  }
  return null;
}

/**
 * Request gate (called by getServerContext with the company the request works in): while
 * single-user mode is held for that company, only the holder's session may use it. Without a
 * companyId the session's sign-in company is used; with neither, any holder refuses (fail closed).
 */
export async function assertSessionAllowed(
  db: DB,
  sessionId: string | undefined,
  companyId?: string | null,
): Promise<void> {
  let scope = companyId ?? null;
  if (!scope && sessionId && isUuid(sessionId)) {
    const [row] = await db
      .select({ companyId: userSessions.companyId })
      .from(userSessions)
      .where(eq(userSessions.id, sessionId));
    scope = row?.companyId ?? null;
  }
  const holder = await getSingleUserMode(db, scope);
  if (holder && holder.sessionId !== sessionId) {
    throw new ServiceError(
      'FORBIDDEN',
      `The company file is in single-user mode — ${holder.userName} is doing maintenance. Try again when they switch back to multi-user mode.`,
      { singleUserMode: true },
    );
  }
}

/**
 * QB Enterprise seat limit: refuse a new sign-in when MAX_CONCURRENT_USERS other people are
 * already logged in to the file (a user opening a second session doesn't take another seat).
 */
export async function assertSeatAvailable(db: DB, userId: string, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${userSessions.userId})::int` })
    .from(userSessions)
    .where(and(isNull(userSessions.endedAt), gt(userSessions.lastSeenAt, cutoff), ne(userSessions.userId, userId)));
  if (Number(row?.n ?? 0) >= MAX_CONCURRENT_USERS) {
    throw new ServiceError(
      'CONFLICT',
      `This company file already has ${MAX_CONCURRENT_USERS} users logged in (the most allowed at once). Try again when someone logs out.`,
      { seatLimit: MAX_CONCURRENT_USERS },
    );
  }
}

function describeOthers(others: ActiveSession[], hiddenCount = 0): string {
  const names = [...new Set(others.map((s) => s.userName))];
  const listed = names.slice(0, 5).join(', ') + (names.length > 5 ? `, +${names.length - 5} more` : '');
  // Other companies' users are counted, never named.
  const hidden = hiddenCount > 0 ? `${hiddenCount} from other companies in this file` : '';
  const shown = [listed, hidden].filter(Boolean).join(', ');
  const total = others.length + hiddenCount;
  return `${total} other ${total === 1 ? 'session is' : 'sessions are'} logged in (${shown})`;
}

/** Active sessions of the caller's company other than the caller's own. */
async function otherSessions(ctx: ServiceContext): Promise<ActiveSession[]> {
  const all = await listActiveSessions(ctx.db, { currentSessionId: ctx.sessionId, companyId: ctx.companyId });
  return all.filter((s) => !s.isCurrent);
}

/** End idle sessions (not counted as logged in) — of a company's members, or file-wide. */
async function expireIdleSessions(db: DB, companyId?: string, keepSessionId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const conds = [isNull(userSessions.endedAt), lte(userSessions.lastSeenAt, cutoff)];
  if (companyId) conds.push(inArray(userSessions.userId, membersOf(db, companyId)));
  if (keepSessionId && isUuid(keepSessionId)) conds.push(ne(userSessions.id, keepSessionId));
  await db.update(userSessions).set({ endedAt: new Date(), endReason: 'expired' }).where(and(...conds));
}

/**
 * Switch the caller's company to single-user mode. Owner/admin only, from a signed-in session.
 * Refuses (CONFLICT, listing who) while anyone else is still connected to the company — they
 * log out, or the admin signs them out.
 */
export async function enterSingleUserMode(ctx: ServiceContext): Promise<SingleUserState> {
  assertAdmin(ctx, 'Single-user mode');
  if (!ctx.sessionId || !ctx.userId) {
    throw new ServiceError('FORBIDDEN', 'Sign in to switch to single-user mode.');
  }
  const holder = await getSingleUserMode(ctx.db, ctx.companyId);
  if (holder) {
    if (holder.sessionId === ctx.sessionId) return holder;
    throw new ServiceError('CONFLICT', `${holder.userName} already has the company in single-user mode.`);
  }
  const others = await otherSessions(ctx);
  if (others.length > 0) {
    throw new ServiceError(
      'CONFLICT',
      `Can't switch to single-user mode: ${describeOthers(others)}. Ask them to log out, or sign them out from the list.`,
      { sessions: others.map((s) => ({ id: s.id, userName: s.userName })) },
    );
  }
  // Idle sessions (not counted above) are ended, so nobody drifts back in mid-maintenance.
  await expireIdleSessions(ctx.db, ctx.companyId, ctx.sessionId);
  const inserted = await ctx.db
    .insert(singleUserMode)
    .values({ id: ctx.companyId, sessionId: ctx.sessionId, userId: ctx.userId, enabledAt: new Date() })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    throw new ServiceError('CONFLICT', 'Another administrator just switched the company to single-user mode.');
  }
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'single_user_mode',
    entityId: ctx.sessionId,
    newValues: { enabled: true },
  });
  const state = await getSingleUserMode(ctx.db, ctx.companyId);
  return state!;
}

/** Switch the caller's company back to multi-user mode (the holder, or any owner/admin). */
export async function exitSingleUserMode(ctx: ServiceContext): Promise<void> {
  const holder = await getSingleUserMode(ctx.db, ctx.companyId);
  if (!holder) return;
  if (holder.sessionId !== ctx.sessionId) assertAdmin(ctx, 'Leaving single-user mode');
  await ctx.db.delete(singleUserMode).where(eq(singleUserMode.id, ctx.companyId));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'single_user_mode',
    entityId: holder.sessionId,
    newValues: { enabled: false },
  });
}

/**
 * Gate for admin utilities that rewrite data. Owner/admin only; when anyone else is connected
 * the caller must hold single-user mode.
 *  - scope 'company' (default — Condense, Rebuild, Import): "anyone else" means members of
 *    ctx.companyId; other companies in the same file are unaffected.
 *  - scope 'file' (Restore swaps the whole data directory): additionally nobody from any other
 *    company in the file may be logged in (they are counted, not named — and single-user mode
 *    for this company doesn't excuse them).
 * Idle sessions in scope are ended before the utility runs, so an idle user can't come back
 * and write in the middle of it.
 */
export async function assertExclusiveAccess(
  ctx: ServiceContext,
  utility: string,
  opts: { scope?: 'company' | 'file' } = {},
): Promise<void> {
  assertAdmin(ctx, utility);
  const fileWide = opts.scope === 'file';
  const holder = await getSingleUserMode(ctx.db, ctx.companyId);
  const holdsIt = Boolean(holder && holder.sessionId === ctx.sessionId);
  const mine = await otherSessions(ctx);
  const others = holdsIt ? [] : mine;
  let hidden = 0;
  if (fileWide) {
    const mineIds = new Set(mine.map((s) => s.id));
    const everyone = await listActiveSessions(ctx.db, { currentSessionId: ctx.sessionId });
    hidden = everyone.filter((s) => !s.isCurrent && !mineIds.has(s.id)).length;
  }
  if (others.length === 0 && hidden === 0) {
    await expireIdleSessions(ctx.db, fileWide ? undefined : ctx.companyId, ctx.sessionId);
    return;
  }
  throw new ServiceError(
    'CONFLICT',
    others.length > 0
      ? `${utility} needs single-user mode while other people are using this company file: ${describeOthers(others, hidden)}. Switch to single-user mode (Setup → Multi-user) and try again.`
      : `${utility} replaces the whole company file, but ${describeOthers([], hidden)}. They must log out first.`,
    {
      requiresSingleUser: others.length > 0,
      otherCompanySessions: hidden,
      sessions: others.map((s) => ({ id: s.id, userName: s.userName })),
    },
  );
}

/** Sign out every other active session in the caller's company (e.g. before single-user mode). */
export async function signOutOtherSessions(ctx: ServiceContext): Promise<number> {
  assertAdmin(ctx, 'Signing out other users');
  const others = await otherSessions(ctx);
  if (others.length === 0) return 0;
  const ids = others.map((s) => s.id);
  await ctx.db
    .update(userSessions)
    .set({ endedAt: new Date(), endReason: 'signed_out_by_admin' })
    .where(and(inArray(userSessions.id, ids), isNull(userSessions.endedAt)));
  // Release this company's single-user mode if one of those sessions held it.
  await ctx.db
    .delete(singleUserMode)
    .where(and(eq(singleUserMode.id, ctx.companyId), inArray(singleUserMode.sessionId, ids)));
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
