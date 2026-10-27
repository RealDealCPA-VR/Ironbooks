/**
 * Effective-permission resolution for a user in a company (Enterprise roles & permissions).
 *
 * Roles come from user_role_assignments (built-in role keys or custom company_roles ids).
 * Members with no assignment rows (memberships created by older code paths, e.g. createCompany's
 * owner row, or files predating migration 0021) fall back to the equivalent of their legacy
 * user_companies.role (owner/admin → Admin, accountant → Accountant, viewer → View-Only).
 *
 * The model itself (areas, built-in roles, union) lives in lib/permissions/model.ts.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { companies, companyRoles, userCompanies, userRoleAssignments } from '@/lib/db/schema';
import {
  BUILTIN_ROLES,
  LEGACY_ROLE_MAP,
  areaLabel,
  builtinRole,
  can,
  unionRoles,
  type Action,
  type Area,
  type EffectiveAccess,
  type PermissionGrant,
  type RoleDefinition,
  type RoleFlags,
} from '@/lib/permissions/model';
import { maskAccountNumber, maskSensitive, maskSsn, stripSecrets } from '@/lib/permissions/mask';
import { ServiceError, type ServiceContext } from './_base';

export interface ResolvedAccess {
  access: EffectiveAccess;
  /** Has a membership row (or is the company owner). */
  member: boolean;
  /** Membership is active (owner without a membership row counts as active). */
  active: boolean;
  isOwner: boolean;
}

type CustomRoleRow = typeof companyRoles.$inferSelect;

export function customRoleToDefinition(row: CustomRoleRow): RoleDefinition {
  return {
    key: row.id,
    name: row.name,
    description: row.description ?? '',
    builtin: false,
    permissions: (row.permissions ?? {}) as PermissionGrant,
    flags: (row.flags ?? {}) as RoleFlags,
  };
}

/** Built-in + custom role definitions available in a company. */
export async function listRoleDefinitions(db: DB, companyId: string): Promise<RoleDefinition[]> {
  const rows = await db.select().from(companyRoles).where(eq(companyRoles.companyId, companyId));
  return [
    ...BUILTIN_ROLES,
    ...rows.sort((a, b) => a.name.localeCompare(b.name)).map(customRoleToDefinition),
  ];
}

/** Role keys assigned to a user in a company (may be empty → legacy fallback applies). */
export async function getAssignedRoleKeys(
  db: DB,
  companyId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ roleKey: userRoleAssignments.roleKey })
    .from(userRoleAssignments)
    .where(and(eq(userRoleAssignments.companyId, companyId), eq(userRoleAssignments.userId, userId)));
  return rows.map((r) => r.roleKey);
}

/** Role keys that are in effect for a member: their assignments, else the legacy equivalent. */
export function effectiveRoleKeys(
  assigned: string[],
  legacyRole: string | null | undefined,
  isOwner: boolean,
): string[] {
  if (assigned.length) return assigned;
  // Legacy semantics: the company creator (companies.ownerId) was always 'owner' → Admin.
  if (isOwner) return ['admin'];
  if (legacyRole && legacyRole in LEGACY_ROLE_MAP) {
    return [LEGACY_ROLE_MAP[legacyRole as keyof typeof LEGACY_ROLE_MAP]];
  }
  return [];
}

/** Resolve role keys to definitions (unknown/deleted custom role ids are ignored). */
export async function definitionsFor(
  db: DB,
  companyId: string,
  keys: string[],
): Promise<RoleDefinition[]> {
  const out: RoleDefinition[] = [];
  const customIds: string[] = [];
  for (const k of keys) {
    const b = builtinRole(k);
    if (b) out.push(b);
    else customIds.push(k);
  }
  if (customIds.length) {
    const rows = await db.select().from(companyRoles).where(eq(companyRoles.companyId, companyId));
    for (const row of rows) if (customIds.includes(row.id)) out.push(customRoleToDefinition(row));
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a user's effective access in a company. */
export async function resolveAccess(
  db: DB,
  companyId: string,
  userId: string,
): Promise<ResolvedAccess> {
  if (!UUID_RE.test(companyId) || !UUID_RE.test(userId)) {
    return { access: unionRoles([]), member: false, active: false, isOwner: false };
  }
  const [company] = await db
    .select({ ownerId: companies.ownerId })
    .from(companies)
    .where(eq(companies.id, companyId));
  const isOwner = company?.ownerId === userId;
  const [m] = await db
    .select({ role: userCompanies.role, isActive: userCompanies.isActive })
    .from(userCompanies)
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, companyId)));
  const member = Boolean(m) || isOwner;
  const active = m ? m.isActive !== false : isOwner;
  if (!member) return { access: unionRoles([]), member, active: false, isOwner };

  const assigned = await getAssignedRoleKeys(db, companyId, userId);
  const keys = effectiveRoleKeys(assigned, m?.role, isOwner);
  const defs = await definitionsFor(db, companyId, keys);
  return { access: unionRoles(defs), member, active, isOwner };
}

/** Message prefix shared with getPageContext (lib/context.ts) — keep in sync. */
export const PERMISSION_DENIED_PREFIX = 'You do not have permission';

export function permissionDenied(area: Area, action: Action): ServiceError {
  const verb = action === 'view' ? 'view' : action === 'print' ? 'print or export' : action;
  return new ServiceError(
    'FORBIDDEN',
    `${PERMISSION_DENIED_PREFIX} to ${verb} ${areaLabel(area)}. Ask your administrator for access.`,
    { area, action },
  );
}

/**
 * Service-level guard. Contexts without `access` (tests, system jobs, the Electron internal
 * token) are trusted and pass — exactly like the legacy `ctx.role` convention.
 */
export function requirePermission(ctx: ServiceContext, area: Area, action: Action): void {
  if (!ctx.access) return;
  if (!can(ctx.access, area, action)) throw permissionDenied(area, action);
}

/**
 * Async service-level guard for services that must hold even for contexts built WITHOUT
 * `access` (replaces the legacy `requireRole(ctx, 'admin')`): uses ctx.access when present,
 * otherwise resolves the user's effective permissions from the company file. A context with
 * neither access nor a user id is refused (same as the legacy guard), and so is an inactive or
 * non-member user.
 */
export async function requireEffectivePermission(
  ctx: ServiceContext,
  area: Area,
  action: Action,
): Promise<EffectiveAccess> {
  let access = ctx.access;
  if (!access) {
    if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'You do not have access to this company.');
    const r = await resolveAccess(ctx.db, ctx.companyId, ctx.userId);
    if (!r.member || !r.active) {
      throw new ServiceError('FORBIDDEN', 'You do not have access to this company.');
    }
    access = r.access;
  }
  if (!can(access, area, action)) throw permissionDenied(area, action);
  return access;
}

/** True when the context may see the given sensitive flag (trusted contexts: yes). */
export function hasFlag(
  ctx: Pick<ServiceContext, 'access'>,
  flag: keyof EffectiveAccess['flags'],
): boolean {
  if (!ctx.access) return true;
  return ctx.access.flags[flag] === true;
}

/**
 * Mask sensitive fields (SSNs / tax IDs, bank & account numbers) in a service's return value for
 * the context's effective permissions (lib/permissions/mask.ts). Services that return such data
 * to callers apply it at their boundary, so every route and export built on them is covered.
 * Credential material (password hashes, the file-password hash, TOTP secrets — stripSecrets) is
 * removed for every signed-in caller, the Admin included. Trusted contexts (no `access`) see
 * everything.
 */
export function maskForContext<T>(ctx: Pick<ServiceContext, 'access'>, data: T): T {
  if (!ctx.access) return data;
  return stripSecrets(maskSensitive(data, ctx.access));
}

/** An SSN / taxpayer id as this context may see it (full, or "***-**-6789"). */
export function taxIdFor(ctx: Pick<ServiceContext, 'access'>, value: string | null): string | null {
  return hasFlag(ctx, 'sensitivePayroll') ? value : maskSsn(value);
}

/** A bank / account number as this context may see it (full, or "••••6789"). */
export function accountNumberFor(ctx: Pick<ServiceContext, 'access'>, value: string): string {
  return hasFlag(ctx, 'fullAccountNumbers') ? value : (maskAccountNumber(value) ?? '');
}

/**
 * File-wide operations (whole-file backup / restore, the company-file password) reach EVERY
 * company in the PGlite data dir, so a permission in the active company is not enough: the
 * caller must be an active Admin of every company in the file (QB Enterprise: only the file's
 * Admin can do these). Fails closed for contexts without a user.
 */
export async function requireFileAdmin(
  ctx: Pick<ServiceContext, 'db' | 'userId'>,
): Promise<void> {
  const denied = () =>
    new ServiceError(
      'FORBIDDEN',
      'Only an Admin of every company in this file can do this. Ask your administrator.',
    );
  if (!ctx.userId) throw denied();
  const all = await ctx.db.select({ id: companies.id }).from(companies);
  for (const c of all) {
    const r = await resolveAccess(ctx.db, c.id, ctx.userId);
    if (!r.member || !r.active || !r.access.isAdmin) throw denied();
  }
}

/**
 * Resolve the caller's access in a company OTHER than the active one (e.g. a per-company export
 * named by ?companyId=) and require an action there. The route map only authorized the ACTIVE
 * company, so cross-company routes must re-check membership, is_active and the permission in
 * the target company itself.
 */
export async function requireAccessInCompany(
  ctx: Pick<ServiceContext, 'db' | 'userId'>,
  companyId: string,
  area: Area,
  action: Action,
): Promise<EffectiveAccess> {
  if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'Authentication required.');
  // A malformed id would make Postgres throw 22P02 on the uuid comparison (→ 500); refuse it.
  if (!UUID_RE.test(companyId)) {
    throw new ServiceError('FORBIDDEN', 'You do not have access to that company.');
  }
  const r = await resolveAccess(ctx.db, companyId, ctx.userId);
  if (!r.member || !r.active) {
    throw new ServiceError('FORBIDDEN', 'You do not have access to that company.');
  }
  if (!can(r.access, area, action)) throw permissionDenied(area, action);
  return r.access;
}
