/**
 * Legacy 4-level role API (owner/admin/accountant/viewer), kept for older call sites.
 *
 * Since the Enterprise roles & permissions work (lib/permissions, lib/services/access.ts,
 * lib/services/users.ts) the source of truth is the member's assigned roles; `getRole` collapses
 * their effective permissions to the closest legacy level (Admin → admin/owner, no write access →
 * viewer, otherwise accountant). Fine-grained checks belong in the route map
 * (lib/permissions/routes.ts) or `requirePermission` (lib/services/access.ts).
 */
import { and, eq } from 'drizzle-orm';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, notFound, validation } from './_base';
import { resolveAccess } from './access';
import { LEGACY_ROLE_MAP, legacyRoleFor } from '@/lib/permissions/model';
import { setUserRoles } from './users';

export type Role = 'owner' | 'admin' | 'accountant' | 'viewer';

/** Capability rank — higher can do everything a lower role can. */
const RANK: Record<Role, number> = { viewer: 0, accountant: 1, admin: 2, owner: 3 };

export async function getRole(ctx: ServiceContext): Promise<Role | null> {
  if (!ctx.userId) return null;
  const r = await resolveAccess(ctx.db, ctx.companyId, ctx.userId);
  if (!r.member || !r.active) return null;
  return legacyRoleFor(r.access, r.isOwner);
}

/** Throw FORBIDDEN unless the current user's role meets the minimum (or is in the allowed set). */
export async function requireRole(ctx: ServiceContext, allowed: Role | Role[]): Promise<Role> {
  const role = await getRole(ctx);
  if (!role) throw new ServiceError('FORBIDDEN', 'You do not have access to this company.');
  const list = Array.isArray(allowed) ? allowed : [allowed];
  const minRank = Math.min(...list.map((r) => RANK[r]));
  if (RANK[role] < minRank) {
    throw new ServiceError('FORBIDDEN', `This action requires one of: ${list.join(', ')}.`);
  }
  return role;
}

/** Convenience: viewers cannot write. */
export async function requireWrite(ctx: ServiceContext): Promise<Role> {
  return requireRole(ctx, ['accountant', 'admin', 'owner']);
}

/**
 * Synchronous write guard against the role pre-loaded onto ctx by `getServerContext`
 * (no DB round-trip). The same check runs centrally inside `writeAudit`/`inTransaction`
 * in _base.ts, so every mutation is covered app-wide; call this at the top of a service
 * when you want the FORBIDDEN error before any work happens.
 * Contexts without a role (tests, system jobs) are trusted and pass.
 */
export function assertWrite(ctx: ServiceContext): void {
  if (ctx.role === 'viewer') {
    throw new ServiceError('FORBIDDEN', 'Your role is view-only. This action requires write access.');
  }
}

export interface CompanyMember {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /** True for the company owner (companies.ownerId) — role cannot be changed. */
  isOwner: boolean;
}

/** All members of the active company (user_companies join users). Owner always reports 'owner'. */
export async function listMembers(ctx: ServiceContext): Promise<CompanyMember[]> {
  const [company] = await ctx.db
    .select({ ownerId: companies.ownerId })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const rows = await ctx.db
    .select({
      userId: userCompanies.userId,
      role: userCompanies.role,
      email: users.email,
      name: users.name,
    })
    .from(userCompanies)
    .innerJoin(users, eq(users.id, userCompanies.userId))
    .where(eq(userCompanies.companyId, ctx.companyId));
  return rows.map((r) => {
    const isOwner = r.userId === company?.ownerId;
    return {
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: (isOwner ? 'owner' : (r.role as Role)) ?? 'viewer',
      isOwner,
    };
  });
}

const ALL_ROLES: Role[] = ['owner', 'admin', 'accountant', 'viewer'];

/**
 * Change a member's role. Requires admin+; granting 'owner' requires being the owner.
 * The company owner's own role can never be changed (it derives from companies.ownerId).
 */
export async function setMemberRole(
  ctx: ServiceContext,
  targetUserId: string,
  role: Role,
): Promise<CompanyMember> {
  const actorRole = await requireRole(ctx, 'admin');
  if (!ALL_ROLES.includes(role)) {
    throw validation(`role must be one of: ${ALL_ROLES.join(', ')}.`);
  }
  if (role === 'owner' && actorRole !== 'owner') {
    throw new ServiceError('FORBIDDEN', "Only the company owner can grant the 'owner' role.");
  }

  const [company] = await ctx.db
    .select({ ownerId: companies.ownerId })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  if (company?.ownerId === targetUserId) {
    throw new ServiceError('FORBIDDEN', "The company owner's role cannot be changed.");
  }

  const [membership] = await ctx.db
    .select({ role: userCompanies.role })
    .from(userCompanies)
    .where(
      and(eq(userCompanies.userId, targetUserId), eq(userCompanies.companyId, ctx.companyId)),
    );
  if (!membership) throw notFound('Company member');

  // Map to the equivalent built-in role (Enterprise roles), which also updates the legacy column
  // and enforces the last-active-Admin rule + writes the audit row.
  await setUserRoles(ctx, targetUserId, [LEGACY_ROLE_MAP[role]]);

  const [user] = await ctx.db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, targetUserId));
  return {
    userId: targetUserId,
    email: user?.email ?? '',
    name: user?.name ?? '',
    role,
    isOwner: false,
  };
}
