/**
 * Company-level Users & Roles (QuickBooks Desktop Enterprise "Users and Roles").
 *
 * Users and their permissions live INSIDE the company file (each file is its own PGlite data
 * dir). A user holds one or more roles per company; effective permissions are the union
 * (lib/permissions/model.ts). Built-in roles are read-only — clone one to customize.
 *
 * Invariants enforced here (inside a transaction, so concurrent edits can't race past them):
 *  - The last ACTIVE Admin of a company can never be deactivated or lose the Admin role.
 *  - No privilege escalation: a non-Admin user manager can only grant roles / edit roles /
 *    manage users whose permissions are a subset of their own; only an Admin grants Admin.
 *  - A login shared with other companies of the file can only be renamed / have its password
 *    reset by an Admin of all of them (no cross-company account takeover).
 *  - Every change writes an audit row (passwords are never logged).
 */
import { and, eq } from 'drizzle-orm';
import { companies, companyRoles, userCompanies, userRoleAssignments, users } from '@/lib/db/schema';
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth';
import {
  ADMIN_ROLE_KEY,
  BUILTIN_ROLES,
  builtinRole,
  normalizeGrant,
  unionRoles,
  isSubset,
  legacyRoleFor,
  type EffectiveAccess,
  type PermissionGrant,
  type RoleDefinition,
  type RoleFlags,
} from '@/lib/permissions/model';
import {
  definitionsFor,
  effectiveRoleKeys,
  listRoleDefinitions,
  requirePermission,
  resolveAccess,
} from './access';
import {
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
  type ServiceContext,
} from './_base';

export interface CompanyUser {
  userId: string;
  name: string;
  /** Login name (stored in users.email; may be an email address or a plain user name). */
  login: string;
  isActive: boolean;
  /** The company creator (companies.ownerId). */
  isOwner: boolean;
  roleKeys: string[];
  roles: { key: string; name: string }[];
  isAdmin: boolean;
}

export interface CompanyUserDetail extends CompanyUser {
  access: EffectiveAccess;
}

export interface RoleSummary extends RoleDefinition {
  /** Number of members (active or not) holding the role. */
  userCount: number;
}

const normLogin = (s: string) => s.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function membershipRows(ctx: ServiceContext) {
  const [company] = await ctx.db
    .select({ ownerId: companies.ownerId })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const members = await ctx.db
    .select({
      userId: userCompanies.userId,
      legacyRole: userCompanies.role,
      isActive: userCompanies.isActive,
      name: users.name,
      login: users.email,
    })
    .from(userCompanies)
    .innerJoin(users, eq(users.id, userCompanies.userId))
    .where(eq(userCompanies.companyId, ctx.companyId));
  const assignments = await ctx.db
    .select({ userId: userRoleAssignments.userId, roleKey: userRoleAssignments.roleKey })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.companyId, ctx.companyId));
  const byUser = new Map<string, string[]>();
  for (const a of assignments) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a.roleKey]);
  // De-duplicate membership rows (user_companies has no PK).
  const seen = new Set<string>();
  const unique = members.filter((m) => (seen.has(m.userId) ? false : (seen.add(m.userId), true)));
  return { ownerId: company?.ownerId ?? null, members: unique, byUser };
}

/** All users of the active company with their roles. */
export async function listUsers(ctx: ServiceContext): Promise<CompanyUser[]> {
  requirePermission(ctx, 'users', 'view');
  const { ownerId, members, byUser } = await membershipRows(ctx);
  const defs = await listRoleDefinitions(ctx.db, ctx.companyId);
  const nameOf = new Map(defs.map((d) => [d.key, d.name]));
  return members
    .map((m) => {
      const isOwner = m.userId === ownerId;
      const keys = effectiveRoleKeys(byUser.get(m.userId) ?? [], m.legacyRole, isOwner).filter(
        (k) => nameOf.has(k),
      );
      return {
        userId: m.userId,
        name: m.name,
        login: m.login,
        isActive: m.isActive !== false,
        isOwner,
        roleKeys: keys,
        roles: keys.map((k) => ({ key: k, name: nameOf.get(k)! })),
        isAdmin: keys.includes(ADMIN_ROLE_KEY),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One user with their effective (union) permissions. */
export async function getUser(ctx: ServiceContext, userId: string): Promise<CompanyUserDetail> {
  requirePermission(ctx, 'users', 'view');
  const list = await listUsers(ctx);
  const u = list.find((x) => x.userId === userId);
  if (!u) throw notFound('User');
  const { access } = await resolveAccess(ctx.db, ctx.companyId, userId);
  return { ...u, access };
}

/** User ids of ACTIVE members who hold the built-in Admin role (incl. legacy fallback). */
export async function activeAdminIds(ctx: ServiceContext): Promise<string[]> {
  const { ownerId, members, byUser } = await membershipRows(ctx);
  const ids = members
    .filter((m) => m.isActive !== false)
    .filter((m) =>
      effectiveRoleKeys(byUser.get(m.userId) ?? [], m.legacyRole, m.userId === ownerId).includes(
        ADMIN_ROLE_KEY,
      ),
    )
    .map((m) => m.userId);
  // A creator with no membership row is implicitly an active Admin (resolveAccess fallback).
  if (ownerId && !members.some((m) => m.userId === ownerId)) ids.push(ownerId);
  return ids;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Block privilege escalation by non-Admin user managers. Trusted contexts pass. */
function assertCanGrant(ctx: ServiceContext, granted: EffectiveAccess, what: string): void {
  if (!ctx.access || ctx.access.isAdmin) return;
  if (granted.isAdmin) {
    throw new ServiceError('FORBIDDEN', 'Only an Admin can grant the Admin role.');
  }
  if (!isSubset(granted, ctx.access)) {
    throw new ServiceError(
      'FORBIDDEN',
      `You cannot ${what} with permissions beyond your own. Ask an Admin.`,
    );
  }
}

/** Non-Admins may only manage users whose current access is within their own. */
async function assertCanManageUser(ctx: ServiceContext, targetUserId: string): Promise<void> {
  if (!ctx.access || ctx.access.isAdmin) return;
  const { access } = await resolveAccess(ctx.db, ctx.companyId, targetUserId);
  if (access.isAdmin || !isSubset(access, ctx.access)) {
    throw new ServiceError(
      'FORBIDDEN',
      'Only an Admin can change a user who has more access than you.',
    );
  }
}

/**
 * A login (users row: name, login, password) is SHARED by every company of this file the user
 * belongs to, so changing it from company A also changes how they sign in to company B. Only
 * the user themself, or a caller who is an ACTIVE Admin of every OTHER company the user belongs
 * to (or created), may change it — otherwise an Admin of A could attach B's Admin login
 * (addUser) and then reset its password: a cross-company account takeover. Trusted contexts
 * (no `access`) pass.
 */
async function assertCanChangeSharedLogin(ctx: ServiceContext, targetUserId: string): Promise<void> {
  if (!ctx.access) return;
  if (ctx.userId && ctx.userId === targetUserId) return;
  const memberOf = await ctx.db
    .select({ companyId: userCompanies.companyId })
    .from(userCompanies)
    .where(eq(userCompanies.userId, targetUserId));
  const created = await ctx.db
    .select({ companyId: companies.id })
    .from(companies)
    .where(eq(companies.ownerId, targetUserId));
  const others = new Set(
    [...memberOf, ...created].map((r) => r.companyId).filter((id) => id !== ctx.companyId),
  );
  for (const companyId of others) {
    const caller = ctx.userId ? await resolveAccess(ctx.db, companyId, ctx.userId) : null;
    if (!caller || !caller.active || !caller.access.isAdmin) {
      throw new ServiceError(
        'FORBIDDEN',
        "This login is also used in another company of this file. Only an Admin of every company the user belongs to can change the user's login or password.",
      );
    }
  }
}

async function assertNotLastAdmin(
  ctx: ServiceContext,
  targetUserId: string,
  change: { deactivate?: boolean; roleKeys?: string[] },
): Promise<void> {
  const admins = await activeAdminIds(ctx);
  if (!admins.includes(targetUserId)) return;
  const losesAdmin =
    change.deactivate === true ||
    (change.roleKeys !== undefined && !change.roleKeys.includes(ADMIN_ROLE_KEY));
  if (losesAdmin && admins.length <= 1) {
    throw new ServiceError(
      'FORBIDDEN',
      'This is the last active Admin of the company. Make another user an Admin first.',
    );
  }
}

async function validateRoleKeys(ctx: ServiceContext, keys: string[]): Promise<RoleDefinition[]> {
  const unique = [...new Set(keys)];
  const defs = await definitionsFor(ctx.db, ctx.companyId, unique);
  if (defs.length !== unique.length) {
    const known = new Set(defs.map((d) => d.key));
    throw validation(`Unknown role: ${unique.filter((k) => !known.has(k)).join(', ')}`);
  }
  return defs;
}

async function getMembership(ctx: ServiceContext, userId: string) {
  const [m] = await ctx.db
    .select({ role: userCompanies.role, isActive: userCompanies.isActive })
    .from(userCompanies)
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, ctx.companyId)));
  return m ?? null;
}

/**
 * Replace a member's role assignments (no permission/escalation checks — callers do those).
 * Also keeps the legacy user_companies.role column in step for older code paths.
 */
async function writeRoleAssignments(
  ctx: ServiceContext,
  userId: string,
  defs: RoleDefinition[],
): Promise<void> {
  await ctx.db
    .delete(userRoleAssignments)
    .where(
      and(eq(userRoleAssignments.companyId, ctx.companyId), eq(userRoleAssignments.userId, userId)),
    );
  if (defs.length) {
    await ctx.db
      .insert(userRoleAssignments)
      .values(defs.map((d) => ({ companyId: ctx.companyId, userId, roleKey: d.key })))
      .onConflictDoNothing();
  }
  const [company] = await ctx.db
    .select({ ownerId: companies.ownerId })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const legacy = legacyRoleFor(unionRoles(defs), company?.ownerId === userId);
  await ctx.db
    .update(userCompanies)
    .set({ role: legacy })
    .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, ctx.companyId)));
}

// ---------------------------------------------------------------------------
// User mutations
// ---------------------------------------------------------------------------

/**
 * Add a user to the active company. A brand-new login needs a password; a login that already
 * exists in this company file (member of another company in it) is attached as-is — their
 * password is not changed.
 */
export async function addUser(
  ctx: ServiceContext,
  input: { name: string; login: string; password?: string; roleKeys: string[] },
): Promise<CompanyUser> {
  requirePermission(ctx, 'users', 'create');
  const login = normLogin(input.login);
  if (!login) throw validation('Login is required.');
  const defs = await validateRoleKeys(ctx, input.roleKeys);
  if (!defs.length) throw validation('Assign at least one role.');
  assertCanGrant(ctx, unionRoles(defs), 'add a user');

  const userId = await inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db.select().from(users).where(eq(users.email, login));
    let id: string;
    if (existing) {
      if (await getMembership(tx, existing.id)) {
        throw new ServiceError('CONFLICT', `A user with the login "${login}" already exists.`);
      }
      id = existing.id;
    } else {
      if (!input.password || input.password.length < MIN_PASSWORD_LENGTH) {
        throw validation(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      const [created] = await tx.db
        .insert(users)
        .values({
          name: input.name.trim(),
          email: login,
          passwordHash: await hashPassword(input.password),
        })
        .returning({ id: users.id });
      id = created.id;
    }
    await tx.db
      .insert(userCompanies)
      .values({ userId: id, companyId: ctx.companyId, role: 'viewer', isActive: true });
    await writeRoleAssignments(tx, id, defs);
    await writeAudit(tx, {
      action: 'create',
      entityType: 'user',
      entityId: id,
      newValues: {
        name: input.name.trim(),
        login,
        roles: defs.map((d) => d.name),
        attachedExistingLogin: Boolean(existing),
      },
    });
    return id;
  });
  return (await listUsers({ ...ctx, access: undefined })).find((u) => u.userId === userId)!;
}

/** Edit name/login, replace roles, and/or deactivate/reactivate a user. */
export async function updateUser(
  ctx: ServiceContext,
  userId: string,
  input: { name?: string; login?: string; roleKeys?: string[]; isActive?: boolean },
): Promise<CompanyUser> {
  requirePermission(ctx, 'users', 'modify');
  const before = (await listUsers({ ...ctx, access: undefined })).find((u) => u.userId === userId);
  if (!before) throw notFound('User');
  await assertCanManageUser(ctx, userId);

  let defs: RoleDefinition[] | undefined;
  if (input.roleKeys !== undefined) {
    defs = await validateRoleKeys(ctx, input.roleKeys);
    if (!defs.length) throw validation('Assign at least one role.');
    assertCanGrant(ctx, unionRoles(defs), 'assign roles');
  }

  const changesLogin =
    (input.name !== undefined && input.name.trim() !== before.name) ||
    (input.login !== undefined && normLogin(input.login) !== before.login);
  if (changesLogin) await assertCanChangeSharedLogin(ctx, userId);

  await inTransaction(ctx, async (tx) => {
    await assertNotLastAdmin(tx, userId, {
      deactivate: input.isActive === false,
      roleKeys: defs?.map((d) => d.key),
    });

    const userUpdates: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined && input.name.trim() !== before.name) {
      userUpdates.name = input.name.trim();
    }
    if (input.login !== undefined && normLogin(input.login) !== before.login) {
      const login = normLogin(input.login);
      const [clash] = await tx.db.select({ id: users.id }).from(users).where(eq(users.email, login));
      if (clash && clash.id !== userId) {
        throw new ServiceError('CONFLICT', `A user with the login "${login}" already exists.`);
      }
      userUpdates.email = login;
    }
    if (Object.keys(userUpdates).length) {
      await tx.db
        .update(users)
        .set({ ...userUpdates, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }
    if (input.isActive !== undefined && input.isActive !== before.isActive) {
      await tx.db
        .update(userCompanies)
        .set({ isActive: input.isActive })
        .where(and(eq(userCompanies.userId, userId), eq(userCompanies.companyId, ctx.companyId)));
    }
    if (defs) await writeRoleAssignments(tx, userId, defs);

    const oldValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    if (userUpdates.name !== undefined) {
      oldValues.name = before.name;
      newValues.name = userUpdates.name;
    }
    if (userUpdates.email !== undefined) {
      oldValues.login = before.login;
      newValues.login = userUpdates.email;
    }
    if (input.isActive !== undefined && input.isActive !== before.isActive) {
      oldValues.isActive = before.isActive;
      newValues.isActive = input.isActive;
    }
    if (defs) {
      oldValues.roles = before.roles.map((r) => r.name);
      newValues.roles = defs.map((d) => d.name);
    }
    if (Object.keys(newValues).length) {
      await writeAudit(tx, {
        action: 'update',
        entityType: 'user',
        entityId: userId,
        oldValues,
        newValues,
      });
    }
  });
  return (await listUsers({ ...ctx, access: undefined })).find((u) => u.userId === userId)!;
}

/** Replace a user's roles (convenience wrapper over updateUser). */
export async function setUserRoles(
  ctx: ServiceContext,
  userId: string,
  roleKeys: string[],
): Promise<CompanyUser> {
  return updateUser(ctx, userId, { roleKeys });
}

/** Admin-initiated password reset (the new password is never logged). */
export async function resetUserPassword(
  ctx: ServiceContext,
  userId: string,
  password: string,
): Promise<void> {
  requirePermission(ctx, 'users', 'modify');
  if (!(await getMembership(ctx, userId))) throw notFound('User');
  await assertCanManageUser(ctx, userId);
  await assertCanChangeSharedLogin(ctx, userId);
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw validation(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const hash = await hashPassword(password);
  await inTransaction(ctx, async (tx) => {
    await tx.db
      .update(users)
      .set({ passwordHash: hash, resetToken: null, resetExpires: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'user',
      entityId: userId,
      newValues: { passwordReset: true },
    });
  });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Built-in + custom roles with how many users hold each. */
export async function listRoles(ctx: ServiceContext): Promise<RoleSummary[]> {
  requirePermission(ctx, 'users', 'view');
  const defs = await listRoleDefinitions(ctx.db, ctx.companyId);
  const members = await listUsers({ ...ctx, access: undefined });
  return defs.map((d) => ({
    ...d,
    userCount: members.filter((m) => m.roleKeys.includes(d.key)).length,
  }));
}

export async function getRoleDefinition(
  ctx: ServiceContext,
  key: string,
): Promise<RoleSummary> {
  const role = (await listRoles(ctx)).find((r) => r.key === key);
  if (!role) throw notFound('Role');
  return role;
}

function cleanGrant(grant: PermissionGrant): PermissionGrant {
  // Store the normalized (expanded) form so the matrix shows exactly what is granted.
  const n = normalizeGrant(grant);
  const out: PermissionGrant = {};
  for (const [area, actions] of Object.entries(n)) if (actions.length) out[area as keyof PermissionGrant] = actions;
  return out;
}

function cleanFlags(flags: RoleFlags | undefined): RoleFlags {
  return {
    sensitivePayroll: Boolean(flags?.sensitivePayroll),
    fullAccountNumbers: Boolean(flags?.fullAccountNumbers),
    closedPeriod: Boolean(flags?.closedPeriod),
  };
}

async function assertUniqueRoleName(ctx: ServiceContext, name: string, exceptId?: string) {
  const lower = name.trim().toLowerCase();
  if (BUILTIN_NAMES.has(lower)) {
    throw new ServiceError('CONFLICT', `"${name}" is the name of a built-in role.`);
  }
  const rows = await ctx.db
    .select({ id: companyRoles.id, name: companyRoles.name })
    .from(companyRoles)
    .where(eq(companyRoles.companyId, ctx.companyId));
  if (rows.some((r) => r.id !== exceptId && r.name.toLowerCase() === lower)) {
    throw new ServiceError('CONFLICT', `A role named "${name}" already exists.`);
  }
}
const BUILTIN_NAMES = new Set(BUILTIN_ROLES.map((r) => r.name.toLowerCase()));

/** Create a custom role, or clone an existing (built-in or custom) role under a new name. */
export async function createRole(
  ctx: ServiceContext,
  input:
    | { cloneFrom: string; name: string; description?: string }
    | { name: string; description?: string; permissions: PermissionGrant; flags?: RoleFlags },
): Promise<RoleSummary> {
  requirePermission(ctx, 'users', 'create');
  let permissions: PermissionGrant;
  let flags: RoleFlags;
  let description = input.description;
  if ('cloneFrom' in input) {
    const [src] = await definitionsFor(ctx.db, ctx.companyId, [input.cloneFrom]);
    if (!src) throw notFound('Role to clone');
    permissions = src.permissions;
    flags = src.flags;
    description = description ?? `Copy of ${src.name}. ${src.description}`.trim();
  } else {
    permissions = input.permissions;
    flags = input.flags ?? {};
  }
  const grant = cleanGrant(permissions);
  const f = cleanFlags(flags);
  const name = input.name.trim();
  if (!name) throw validation('Role name is required.');
  assertCanGrant(
    ctx,
    unionRoles([{ key: 'new', name, description: '', builtin: false, permissions: grant, flags: f }]),
    'create a role',
  );

  const id = await inTransaction(ctx, async (tx) => {
    await assertUniqueRoleName(tx, name);
    const [row] = await tx.db
      .insert(companyRoles)
      .values({
        companyId: ctx.companyId,
        name,
        description: description ?? null,
        permissions: grant as Record<string, string[]>,
        flags: f as Record<string, boolean>,
      })
      .returning({ id: companyRoles.id });
    await writeAudit(tx, {
      action: 'create',
      entityType: 'role',
      entityId: row.id,
      newValues: {
        name,
        clonedFrom: 'cloneFrom' in input ? input.cloneFrom : undefined,
        permissions: grant,
        flags: f,
      },
    });
    return row.id;
  });
  return getRoleDefinition({ ...ctx, access: undefined }, id);
}

/** Edit a custom role (built-in roles are read-only — clone them instead). */
export async function updateRole(
  ctx: ServiceContext,
  roleId: string,
  input: { name?: string; description?: string; permissions?: PermissionGrant; flags?: RoleFlags },
): Promise<RoleSummary> {
  requirePermission(ctx, 'users', 'modify');
  if (builtinRole(roleId)) {
    throw new ServiceError('FORBIDDEN', 'Built-in roles cannot be edited. Clone the role to customize it.');
  }
  const [row] = await ctx.db
    .select()
    .from(companyRoles)
    .where(and(eq(companyRoles.id, roleId), eq(companyRoles.companyId, ctx.companyId)));
  if (!row) throw notFound('Role');

  const grant = input.permissions ? cleanGrant(input.permissions) : (row.permissions as PermissionGrant);
  const f = input.flags ? cleanFlags(input.flags) : (row.flags as RoleFlags);
  const name = input.name?.trim() || row.name;
  if (ctx.access && !ctx.access.isAdmin) {
    // A non-Admin may only edit roles within their own permissions, to within their own.
    const current = unionRoles([
      { key: row.id, name: row.name, description: '', builtin: false, permissions: row.permissions as PermissionGrant, flags: row.flags as RoleFlags },
    ]);
    if (!isSubset(current, ctx.access)) {
      throw new ServiceError('FORBIDDEN', 'Only an Admin can edit a role with more access than you.');
    }
    assertCanGrant(
      ctx,
      unionRoles([{ key: row.id, name, description: '', builtin: false, permissions: grant, flags: f }]),
      'edit a role',
    );
  }

  await inTransaction(ctx, async (tx) => {
    if (name !== row.name) await assertUniqueRoleName(tx, name, row.id);
    await tx.db
      .update(companyRoles)
      .set({
        name,
        description: input.description ?? row.description,
        permissions: grant as Record<string, string[]>,
        flags: f as Record<string, boolean>,
        updatedAt: new Date(),
      })
      .where(eq(companyRoles.id, row.id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'role',
      entityId: row.id,
      oldValues: { name: row.name, permissions: row.permissions, flags: row.flags },
      newValues: { name, permissions: grant, flags: f },
    });
  });
  return getRoleDefinition({ ...ctx, access: undefined }, row.id);
}

/** Delete a custom role. Refused while any user still holds it. */
export async function deleteRole(ctx: ServiceContext, roleId: string): Promise<void> {
  requirePermission(ctx, 'users', 'delete');
  if (builtinRole(roleId)) throw new ServiceError('FORBIDDEN', 'Built-in roles cannot be deleted.');
  const [row] = await ctx.db
    .select()
    .from(companyRoles)
    .where(and(eq(companyRoles.id, roleId), eq(companyRoles.companyId, ctx.companyId)));
  if (!row) throw notFound('Role');
  const holders = await ctx.db
    .select({ userId: userRoleAssignments.userId })
    .from(userRoleAssignments)
    .where(
      and(eq(userRoleAssignments.companyId, ctx.companyId), eq(userRoleAssignments.roleKey, roleId)),
    );
  if (holders.length) {
    throw new ServiceError(
      'CONFLICT',
      `"${row.name}" is assigned to ${holders.length} user(s). Remove it from them first.`,
    );
  }
  await inTransaction(ctx, async (tx) => {
    await tx.db.delete(companyRoles).where(eq(companyRoles.id, row.id));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'role',
      entityId: row.id,
      oldValues: { name: row.name, permissions: row.permissions, flags: row.flags },
    });
  });
}

/** Map a legacy 4-level role to its built-in equivalent key (legacy PATCH /api/users/[id]). */
export { LEGACY_ROLE_MAP } from '@/lib/permissions/model';
