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

/** Resolve a user's effective access in a company. */
export async function resolveAccess(
  db: DB,
  companyId: string,
  userId: string,
): Promise<ResolvedAccess> {
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

/** True when the context may see the given sensitive flag (trusted contexts: yes). */
export function hasFlag(
  ctx: Pick<ServiceContext, 'access'>,
  flag: keyof EffectiveAccess['flags'],
): boolean {
  if (!ctx.access) return true;
  return ctx.access.flags[flag] === true;
}
