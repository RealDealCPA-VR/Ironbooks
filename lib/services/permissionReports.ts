/**
 * Users & Roles reports (QuickBooks Enterprise "View Permissions" and the user / role lists).
 *
 *  - Role permissions: one or several roles side by side, every Area and Activity with its access
 *    level (None / Full / Partial) and the rights behind a Partial level (Create, Modify, Delete,
 *    Print, View Balance), plus the sensitive-data rights.
 *  - User permissions: the same for users — what each person can really do (the union of their
 *    roles), with the roles it comes from.
 *  - User list: every user of the company with login, roles, status, two-factor and last sign-in.
 *  - Role list: every role with its description and who holds it.
 *
 * Needs Users & Roles > View Permissions Reports (users.permission_reports): View to run a
 * report, Print to download it as CSV. Read-only; nothing here changes the file.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { userSessions } from '@/lib/db/schema';
import {
  ACTIVITIES,
  ACTIVITY_ACTION_LABEL,
  accessLevel,
  supportedActions,
  type ActivityAction,
  type ActivityDef,
} from '@/lib/permissions/activities';
import { AREAS, FLAGS, normalizeActivities, type ActivityKey, type ActivitySet, type Flag } from '@/lib/permissions/model';
import { csvFile, csvMinimal } from '@/lib/csv';
import { requireActivity, resolveAccess } from './access';
import { listRoles, listUsers } from './users';
import { notFound, validation, type ServiceContext } from './_base';

export type PermissionsReportKind = 'roles' | 'users' | 'user_list' | 'role_list';
export const PERMISSIONS_REPORT_KINDS: PermissionsReportKind[] = ['roles', 'users', 'user_list', 'role_list'];

export interface ReportColumn {
  key: string;
  name: string;
  /** Roles of a user column ("Bookkeeper, A/R Clerk"). */
  detail?: string;
}

export interface ActivityCell {
  level: 'None' | 'Full' | 'Partial';
  rights: ActivityAction[];
  /** "Create, Modify, Print" — the rights of a Partial level, in QB's words. */
  text: string;
}

export interface MatrixRow {
  area: string;
  areaLabel: string;
  activity: string;
  label: string;
  cells: Record<string, ActivityCell>;
}

export interface MatrixReport {
  kind: 'roles' | 'users';
  title: string;
  columns: ReportColumn[];
  rows: MatrixRow[];
  flags: Array<{ key: Flag; label: string; cells: Record<string, boolean> }>;
}

export interface UserListRow {
  userId: string;
  name: string;
  login: string;
  roles: string;
  status: 'Active' | 'Inactive';
  twoFactor: boolean;
  isOwner: boolean;
  lastSignIn: string | null;
}

export interface RoleListRow {
  key: string;
  name: string;
  type: 'Built-in' | 'Custom';
  description: string;
  users: string;
  userCount: number;
}

function cellFor(def: ActivityDef, rights: readonly ActivityAction[]): ActivityCell {
  const level = accessLevel(def, rights);
  const shown = supportedActions(def).filter((a) => a !== 'view' && rights.includes(a));
  return {
    level,
    rights: [...rights],
    text: level === 'Partial' ? (shown.length ? shown.map((a) => ACTIVITY_ACTION_LABEL[a]).join(', ') : 'View only') : level,
  };
}

function matrix(columns: ReportColumn[], sets: Record<string, ActivitySet>): MatrixRow[] {
  const areaLabel = new Map<string, string>(AREAS.map((a) => [a.key, a.label]));
  return (ACTIVITIES as readonly ActivityDef[]).map((def) => ({
    area: def.area,
    areaLabel: areaLabel.get(def.area) ?? def.area,
    activity: def.key,
    label: def.label,
    cells: Object.fromEntries(columns.map((c) => [c.key, cellFor(def, sets[c.key][def.key as ActivityKey] ?? [])])),
  }));
}

/** Side-by-side permissions of roles (all roles when `roleKeys` is empty). */
export async function rolePermissionsReport(ctx: ServiceContext, roleKeys: string[] = []): Promise<MatrixReport> {
  requireActivity(ctx, 'users.permission_reports', 'view');
  const roles = await listRoles({ ...ctx, access: undefined });
  const picked = roleKeys.length ? roleKeys.map((k) => roles.find((r) => r.key === k) ?? null) : roles;
  if (picked.some((r) => r === null)) throw notFound('Role');
  const list = picked.filter((r): r is NonNullable<typeof r> => r !== null);
  const columns = list.map((r) => ({ key: r.key, name: r.name, detail: r.builtin ? 'Built-in' : 'Custom' }));
  const sets = Object.fromEntries(list.map((r) => [r.key, normalizeActivities(r.permissions)]));
  return {
    kind: 'roles',
    title: 'Role Permissions',
    columns,
    rows: matrix(columns, sets),
    flags: FLAGS.map((f) => ({
      key: f.key,
      label: f.label,
      cells: Object.fromEntries(list.map((r) => [r.key, Boolean(r.flags?.[f.key])])),
    })),
  };
}

/** Side-by-side EFFECTIVE permissions of users (all users when `userIds` is empty). */
export async function userPermissionsReport(ctx: ServiceContext, userIds: string[] = []): Promise<MatrixReport> {
  requireActivity(ctx, 'users.permission_reports', 'view');
  const users = await listUsers({ ...ctx, access: undefined });
  const picked = userIds.length ? userIds.map((id) => users.find((u) => u.userId === id) ?? null) : users;
  if (picked.some((u) => u === null)) throw notFound('User');
  const list = picked.filter((u): u is NonNullable<typeof u> => u !== null);
  const columns = list.map((u) => ({ key: u.userId, name: u.name, detail: u.roles.map((r) => r.name).join(', ') }));
  const sets: Record<string, ActivitySet> = {};
  const flags: Record<string, Record<Flag, boolean>> = {};
  for (const u of list) {
    const { access } = await resolveAccess(ctx.db, ctx.companyId, u.userId);
    sets[u.userId] = access.activities ?? normalizeActivities({});
    // A deactivated user can do nothing in this company, whatever their roles say.
    if (!u.isActive) sets[u.userId] = normalizeActivities({});
    flags[u.userId] = u.isActive ? access.flags : { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false };
  }
  return {
    kind: 'users',
    title: 'User Permissions',
    columns: list.map((c, i) => (list[i].isActive ? columns[i] : { ...columns[i], detail: `${columns[i].detail} (inactive)` })),
    rows: matrix(columns, sets),
    flags: FLAGS.map((f) => ({
      key: f.key,
      label: f.label,
      cells: Object.fromEntries(list.map((u) => [u.userId, flags[u.userId][f.key]])),
    })),
  };
}

/** Every user of the company with roles, status, two-factor and last sign-in. */
export async function userListReport(ctx: ServiceContext): Promise<UserListRow[]> {
  requireActivity(ctx, 'users.permission_reports', 'view');
  const users = await listUsers({ ...ctx, access: undefined });
  const ids = users.map((u) => u.userId);
  const last = new Map<string, Date>();
  if (ids.length) {
    const rows = await ctx.db
      .select({ userId: userSessions.userId, createdAt: userSessions.createdAt })
      .from(userSessions)
      .where(and(inArray(userSessions.userId, ids), eq(userSessions.companyId, ctx.companyId)))
      .orderBy(desc(userSessions.createdAt));
    for (const r of rows) if (!last.has(r.userId)) last.set(r.userId, r.createdAt);
  }
  return users.map((u) => ({
    userId: u.userId,
    name: u.name,
    login: u.login,
    roles: u.roles.map((r) => r.name).join(', '),
    status: u.isActive ? 'Active' : 'Inactive',
    twoFactor: u.twoFactor,
    isOwner: u.isOwner,
    lastSignIn: last.get(u.userId)?.toISOString() ?? null,
  }));
}

/** Every role with its description and the users who hold it. */
export async function roleListReport(ctx: ServiceContext): Promise<RoleListRow[]> {
  requireActivity(ctx, 'users.permission_reports', 'view');
  const [roles, users] = await Promise.all([listRoles({ ...ctx, access: undefined }), listUsers({ ...ctx, access: undefined })]);
  return roles.map((r) => {
    const holders = users.filter((u) => u.roleKeys.includes(r.key));
    return {
      key: r.key,
      name: r.name,
      type: r.builtin ? 'Built-in' : 'Custom',
      description: r.description,
      users: holders.map((u) => u.name).join(', '),
      userCount: holders.length,
    };
  });
}

/** CSV text of a report (Print right needed: it leaves the app as a file). */
export async function permissionsReportCsv(
  ctx: ServiceContext,
  kind: PermissionsReportKind,
  keys: string[] = [],
): Promise<{ filename: string; csv: string }> {
  requireActivity(ctx, 'users.permission_reports', 'print');
  const line = (cells: Array<string | number | boolean | null>) => cells.map((c) => csvMinimal(c)).join(',');
  if (kind === 'roles' || kind === 'users') {
    const r = kind === 'roles' ? await rolePermissionsReport(ctx, keys) : await userPermissionsReport(ctx, keys);
    const lines = [line(['Area', 'Activity', ...r.columns.map((c) => c.name)])];
    for (const row of r.rows) lines.push(line([row.areaLabel, row.label, ...r.columns.map((c) => row.cells[c.key].text)]));
    for (const f of r.flags) lines.push(line(['Sensitive data', f.label, ...r.columns.map((c) => (f.cells[c.key] ? 'Yes' : 'No'))]));
    return { filename: `${r.title}.csv`, csv: csvFile(lines) };
  }
  if (kind === 'user_list') {
    const rows = await userListReport(ctx);
    const lines = [line(['Name', 'Login', 'Roles', 'Status', 'Two-factor sign-in', 'Company creator', 'Last sign-in'])];
    for (const u of rows) lines.push(line([u.name, u.login, u.roles, u.status, u.twoFactor ? 'On' : 'Off', u.isOwner ? 'Yes' : '', u.lastSignIn ?? '']));
    return { filename: 'User List.csv', csv: csvFile(lines) };
  }
  if (kind === 'role_list') {
    const rows = await roleListReport(ctx);
    const lines = [line(['Role', 'Type', 'Description', 'Users'])];
    for (const r of rows) lines.push(line([r.name, r.type, r.description, r.users]));
    return { filename: 'Role List.csv', csv: csvFile(lines) };
  }
  throw validation('Unknown report.');
}
