/**
 * Enterprise roles & permissions model (QuickBooks Desktop Enterprise parity).
 *
 * Pure data + functions — no DB or Node imports — so the same definitions drive server-side
 * enforcement (lib/context.ts → lib/permissions/routes.ts), the Users & Roles admin page, and
 * the client-side nav filter.
 *
 *  - An AREA is a permission area (Banking, Customers & Receivables, Reports — Financial, …).
 *  - An ACTION is one of view/create/modify/delete/print. 'full' is shorthand for all five.
 *  - A ROLE grants a set of actions per area plus three extra FLAGS (sensitive payroll data,
 *    full bank/account numbers, modify transactions on/before the closing date).
 *  - A user may hold several roles in a company; their EFFECTIVE permissions are the union.
 *
 * Any granted action implies 'view' of the same area (you can't edit what you can't see).
 * Built-in roles are defined here in code (read-only, like QB's predefined roles — clone one to
 * customize). Custom roles live in the company file (company_roles table).
 */

import {
  ACTIVITIES,
  ACTIVITY_KEYS,
  VIEW_BALANCE,
  activitiesOf,
  activityDef,
  supportedActions,
  type ActivityAction,
  type ActivityDef,
  type ActivityKey,
} from './activities';

export const ACTIONS = ['view', 'create', 'modify', 'delete', 'print'] as const;
export type Action = (typeof ACTIONS)[number];
/**
 * What a role may store per area or per activity: concrete actions, 'full', or (activities with a
 * balance) 'view_balance'.
 */
export type GrantAction = Action | 'full' | typeof VIEW_BALANCE;
export type { ActivityAction, ActivityKey } from './activities';

export const AREAS = [
  { key: 'banking', label: 'Banking', group: 'Transactions' },
  { key: 'lists', label: 'Lists / Centers', group: 'Transactions' },
  { key: 'customers', label: 'Customers & Receivables', group: 'Transactions' },
  { key: 'vendors', label: 'Vendors & Payables', group: 'Transactions' },
  { key: 'payroll', label: 'Employees & Payroll', group: 'Transactions' },
  { key: 'inventory', label: 'Inventory', group: 'Transactions' },
  { key: 'sales_tax', label: 'Sales Tax', group: 'Transactions' },
  { key: 'time', label: 'Time & Mileage', group: 'Transactions' },
  { key: 'reports_financial', label: 'Reports — Financial', group: 'Reports' },
  { key: 'reports_sales', label: 'Reports — Customers & Sales', group: 'Reports' },
  { key: 'reports_purchases', label: 'Reports — Vendors & Purchases', group: 'Reports' },
  { key: 'reports_payroll', label: 'Reports — Payroll', group: 'Reports' },
  { key: 'reports_inventory', label: 'Reports — Inventory', group: 'Reports' },
  { key: 'accounting', label: 'Sensitive Accounting', group: 'Company' },
  { key: 'company', label: 'Company & Preferences', group: 'Company' },
  { key: 'closing', label: 'Closing Date / Periods', group: 'Company' },
  { key: 'users', label: 'Users & Roles', group: 'Company' },
  { key: 'file_utilities', label: 'File Utilities', group: 'Company' },
] as const;
export type Area = (typeof AREAS)[number]['key'];
export const AREA_KEYS: Area[] = AREAS.map((a) => a.key);

export const AREA_DESCRIPTIONS: Record<Area, string> = {
  banking: 'Checks, deposits, bank feeds, credit cards, registers',
  lists: 'Items, classes, locations, custom fields, memorized transactions',
  customers: 'Customers, invoices, estimates, sales orders, payments, credit memos',
  vendors: 'Vendors, bills, bill payments, purchase orders, vendor credits, 1099s',
  payroll: 'Employees, paychecks, payroll items, payroll liabilities & forms',
  inventory: 'Item receipts, adjustments, assemblies, physical counts',
  sales_tax: 'Sales tax codes, agencies, pay sales tax',
  time: 'Timesheets, mileage, billable time',
  reports_financial: 'P&L, balance sheet, trial balance, general ledger, cash flow',
  reports_sales: 'A/R aging, sales by customer/item, open invoices, statements',
  reports_purchases: 'A/P aging, purchases by vendor/item, 1099 summary',
  reports_payroll: 'Payroll summary, W-2/W-3, 940/941',
  reports_inventory: 'Inventory valuation, stock status, worksheets',
  accounting: 'Journal entries, transfers, reconciliation, chart of accounts edits',
  company: 'Company information, preferences, budgets, currencies',
  closing: 'Set closing date, close fiscal periods, year-end close',
  users: 'Add/edit users, assign roles, edit roles',
  file_utilities: 'Backup, restore, condense, import & export',
};

export const FLAGS = [
  {
    key: 'sensitivePayroll',
    label: 'View sensitive payroll data (full SSNs)',
  },
  {
    key: 'fullAccountNumbers',
    label: 'View full bank / account numbers',
  },
  {
    key: 'closedPeriod',
    label: 'Modify transactions on or before the closing date',
  },
] as const;
export type Flag = (typeof FLAGS)[number]['key'];
export type RoleFlags = Partial<Record<Flag, boolean>>;

/**
 * Stored (sparse) permission grant. Keys are AREAS (the format every role had before activities:
 * the actions apply to every activity of the area) or ACTIVITY keys ('customers.invoices').
 */
export type PermissionGrant = Partial<Record<Area | ActivityKey, GrantAction[]>>;

/** Normalized permission set: every area present with concrete actions. */
export type PermissionSet = Record<Area, Action[]>;

/** Normalized activity rights: every activity present with its concrete rights. */
export type ActivitySet = Record<ActivityKey, ActivityAction[]>;

export interface RoleDefinition {
  /** Built-in key ('admin', 'bookkeeper', …) or a custom role's uuid. */
  key: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: PermissionGrant;
  flags: RoleFlags;
}

/** Effective access for one user in one company (union of all their roles). */
export interface EffectiveAccess {
  roleKeys: string[];
  /**
   * Per area: an action is here when the role grants it on the area (old-style grant) or on ANY
   * activity of the area. Coarse - routes and pages check the activity (`canActivity`).
   */
  permissions: PermissionSet;
  /**
   * Per activity (QB Enterprise access levels). Always filled by unionRoles; optional so access
   * objects built by hand (older tests, trusted contexts) keep type-checking - without it every
   * activity check falls back to the activity's area.
   */
  activities?: ActivitySet;
  flags: Record<Flag, boolean>;
  /** Holds the built-in Admin role. */
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Built-in roles (QB Enterprise predefined roles)
// ---------------------------------------------------------------------------

const FULL: GrantAction[] = ['full'];
const VIEW: GrantAction[] = ['view'];
const VIEW_PRINT: GrantAction[] = ['view', 'print'];
const NO_DELETE: GrantAction[] = ['view', 'create', 'modify', 'print'];
const VIEW_CREATE: GrantAction[] = ['view', 'create', 'print'];

function all(actions: GrantAction[], except: Area[] = []): PermissionGrant {
  const g: PermissionGrant = {};
  for (const a of AREA_KEYS) if (!except.includes(a)) g[a] = actions;
  return g;
}

const REPORT_AREAS: Area[] = [
  'reports_financial',
  'reports_sales',
  'reports_purchases',
  'reports_payroll',
  'reports_inventory',
];
function reports(actions: GrantAction[], which: Area[] = REPORT_AREAS): PermissionGrant {
  const g: PermissionGrant = {};
  for (const a of which) g[a] = actions;
  return g;
}

export const ADMIN_ROLE_KEY = 'admin';

export const BUILTIN_ROLES: RoleDefinition[] = [
  {
    key: 'admin',
    name: 'Admin',
    description: 'Complete access to every area, including users, roles, and sensitive data.',
    builtin: true,
    permissions: all(FULL),
    flags: { sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true },
  },
  {
    key: 'full_access',
    name: 'Full Access',
    description: 'Every area except managing users & roles and setting the closing date.',
    builtin: true,
    permissions: { ...all(FULL, ['users', 'closing']), closing: VIEW },
    flags: { sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: true },
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'All accounting areas, closing, and reports. Payroll without sensitive data.',
    builtin: true,
    permissions: {
      ...all(FULL, ['users', 'company', 'file_utilities', 'payroll']),
      payroll: NO_DELETE,
      company: ['view', 'modify', 'print'],
      file_utilities: VIEW_CREATE,
    },
    flags: { closedPeriod: true },
  },
  {
    key: 'external_accountant',
    name: 'External Accountant',
    description: 'Reviews and corrects the books; no deleting, no users, no sensitive data.',
    builtin: true,
    permissions: {
      ...all(NO_DELETE, ['users', 'file_utilities', 'closing']),
      closing: ['view', 'modify'],
      file_utilities: VIEW_CREATE,
    },
    flags: { closedPeriod: true },
  },
  {
    key: 'bookkeeper',
    name: 'Bookkeeper',
    description: 'Day-to-day transactions in every area plus financial reports. No payroll.',
    builtin: true,
    permissions: {
      banking: NO_DELETE,
      lists: NO_DELETE,
      customers: NO_DELETE,
      vendors: NO_DELETE,
      inventory: NO_DELETE,
      sales_tax: NO_DELETE,
      time: NO_DELETE,
      accounting: ['view', 'create', 'modify', 'print'],
      company: VIEW,
      ...reports(VIEW_PRINT, [
        'reports_financial',
        'reports_sales',
        'reports_purchases',
        'reports_inventory',
      ]),
    },
    flags: {},
  },
  {
    key: 'ar_clerk',
    name: 'A/R Clerk',
    description: 'Customers, invoicing, receiving payments, deposits, sales reports.',
    builtin: true,
    permissions: {
      customers: FULL,
      lists: ['view', 'create', 'modify'],
      banking: ['view', 'create'],
      sales_tax: VIEW,
      inventory: VIEW,
      time: VIEW,
      ...reports(VIEW_PRINT, ['reports_sales']),
    },
    flags: {},
  },
  {
    key: 'ap_clerk',
    name: 'A/P Clerk',
    description: 'Vendors, entering and paying bills, writing checks, purchase reports.',
    builtin: true,
    permissions: {
      vendors: FULL,
      lists: ['view', 'create', 'modify'],
      banking: ['view', 'create', 'print'],
      sales_tax: VIEW,
      inventory: VIEW,
      ...reports(VIEW_PRINT, ['reports_purchases']),
    },
    flags: {},
  },
  {
    key: 'banking',
    name: 'Banking',
    description: 'Bank accounts, deposits, checks, transfers, feeds and reconciliation.',
    builtin: true,
    permissions: {
      banking: FULL,
      accounting: ['view', 'create', 'modify'],
      lists: VIEW,
      customers: VIEW,
      vendors: VIEW,
      ...reports(VIEW_PRINT, ['reports_financial']),
    },
    flags: {},
  },
  {
    key: 'payroll_processor',
    name: 'Payroll Processor',
    description: 'Employees, paychecks, payroll liabilities and payroll reports, incl. SSNs.',
    builtin: true,
    permissions: {
      payroll: FULL,
      time: FULL,
      banking: ['view', 'create', 'print'],
      lists: VIEW,
      ...reports(VIEW_PRINT, ['reports_payroll']),
    },
    flags: { sensitivePayroll: true },
  },
  {
    key: 'sales',
    name: 'Sales',
    description: 'Estimates, sales orders, invoices and customer records. No deleting.',
    builtin: true,
    permissions: {
      customers: NO_DELETE,
      lists: VIEW,
      inventory: VIEW,
      time: ['view', 'create'],
      ...reports(VIEW_PRINT, ['reports_sales']),
    },
    flags: {},
  },
  {
    key: 'purchasing',
    name: 'Purchasing',
    description: 'Purchase orders, receiving items and vendor records.',
    builtin: true,
    permissions: {
      vendors: NO_DELETE,
      inventory: NO_DELETE,
      lists: VIEW,
      ...reports(VIEW_PRINT, ['reports_purchases', 'reports_inventory']),
    },
    flags: {},
  },
  {
    key: 'inventory',
    name: 'Inventory',
    description: 'Items, inventory adjustments, assemblies, counts and inventory reports.',
    builtin: true,
    permissions: {
      inventory: FULL,
      lists: ['view', 'create', 'modify'],
      vendors: VIEW,
      ...reports(VIEW_PRINT, ['reports_inventory']),
    },
    flags: {},
  },
  {
    key: 'time_tracking',
    name: 'Time Tracking',
    description: 'Enter and edit timesheets and mileage.',
    builtin: true,
    permissions: {
      time: FULL,
      lists: VIEW,
    },
    flags: {},
  },
  {
    key: 'view_only',
    name: 'View-Only',
    description: 'Look at everything (except users & roles); print reports. Cannot change anything.',
    builtin: true,
    permissions: { ...all(VIEW, ['users']), ...reports(VIEW_PRINT) },
    flags: {},
  },
  {
    key: 'reports_only',
    name: 'Reports Only',
    description: 'View and print every report. No access to transactions or lists.',
    builtin: true,
    permissions: reports(VIEW_PRINT),
    flags: {},
  },
];

export const BUILTIN_ROLE_KEYS = BUILTIN_ROLES.map((r) => r.key);

export function builtinRole(key: string): RoleDefinition | undefined {
  return BUILTIN_ROLES.find((r) => r.key === key);
}

/** Legacy user_companies.role → equivalent built-in role (migration + fallback). */
export const LEGACY_ROLE_MAP: Record<'owner' | 'admin' | 'accountant' | 'viewer', string> = {
  owner: 'admin',
  admin: 'admin',
  accountant: 'accountant',
  viewer: 'view_only',
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export function emptyPermissionSet(): PermissionSet {
  const s = {} as PermissionSet;
  for (const a of AREA_KEYS) s[a] = [];
  return s;
}

function expandActions(raw: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(raw)) return set;
  for (const x of raw) {
    if (x === 'full') {
      ACTIONS.forEach((a) => set.add(a));
      set.add(VIEW_BALANCE);
    } else if (typeof x === 'string') set.add(x);
  }
  return set;
}

const isAction = (a: string): a is Action => (ACTIONS as readonly string[]).includes(a);

/**
 * Expand 'full' and the implicit view; drop unknown areas/actions; stable action order. An
 * ACTIVITY key adds its rights (View Balance aside) to its area, so `can(access, area, …)` stays
 * true when any activity of the area allows it.
 */
export function normalizeGrant(grant: PermissionGrant | null | undefined): PermissionSet {
  const out = emptyPermissionSet();
  if (!grant || typeof grant !== 'object') return out;
  const sets = new Map<Area, Set<Action>>();
  const add = (area: Area, a: Action) => {
    const s = sets.get(area) ?? new Set<Action>();
    s.add(a);
    sets.set(area, s);
  };
  for (const [key, raw] of Object.entries(grant as Record<string, unknown>)) {
    const expanded = expandActions(raw);
    if ((AREA_KEYS as string[]).includes(key)) {
      const granted = [...expanded].filter(isAction);
      if (!granted.length) continue;
      for (const a of granted) add(key as Area, a);
      add(key as Area, 'view'); // any action implies view
      continue;
    }
    const def = activityDef(key);
    if (!def) continue;
    for (const a of activityRights(def, expanded, false)) if (isAction(a)) add(def.area, a);
  }
  for (const area of AREA_KEYS) {
    const s = sets.get(area);
    if (s?.size) out[area] = ACTIONS.filter((a) => s.has(a));
  }
  return out;
}

export function emptyActivitySet(): ActivitySet {
  const s = {} as ActivitySet;
  for (const k of ACTIVITY_KEYS) s[k] = [];
  return s;
}

/**
 * The rights one activity gets from a list of granted actions: only rights the activity has, and
 * any right implies View. `legacy` (an old-style AREA grant) also gives View Balance with View:
 * before activities existed everybody who could view an area saw its balances.
 */
function activityRights(def: ActivityDef, expanded: Set<string>, legacy: boolean): ActivityAction[] {
  const supported = supportedActions(def);
  const out = new Set<ActivityAction>();
  // An area grant only ever held the five actions (View Balance is per activity).
  const src = legacy ? new Set([...expanded].filter(isAction)) : expanded;
  for (const a of supported) if (src.has(a)) out.add(a);
  // An old-style area grant of ANY action meant "may use this area" (View was implied), even when
  // this activity has no such right (e.g. Print on an activity that has nothing to print).
  if (legacy && [...expanded].some(isAction)) out.add('view');
  if (out.size) out.add('view');
  if (legacy && out.has('view') && def.viewBalance) out.add(VIEW_BALANCE);
  return supported.filter((a) => out.has(a));
}

/**
 * Per-activity rights of a stored grant. An AREA key (every role stored before activities, and
 * the built-in roles) applies to every activity of that area - the migration that keeps every
 * existing role's access exactly as it was.
 */
export function normalizeActivities(grant: PermissionGrant | null | undefined): ActivitySet {
  const out = emptyActivitySet();
  if (!grant || typeof grant !== 'object') return out;
  const merge = (def: ActivityDef, rights: ActivityAction[]) => {
    if (!rights.length) return;
    const k = def.key as ActivityKey;
    const s = new Set([...out[k], ...rights]);
    out[k] = supportedActions(def).filter((a) => s.has(a));
  };
  for (const [key, raw] of Object.entries(grant as Record<string, unknown>)) {
    const expanded = expandActions(raw);
    if (!expanded.size) continue;
    if ((AREA_KEYS as string[]).includes(key)) {
      for (const def of activitiesOf(key as Area)) merge(def, activityRights(def, expanded, true));
      continue;
    }
    const def = activityDef(key);
    if (def) merge(def, activityRights(def, expanded, false));
  }
  return out;
}

/** Union of several roles → effective access. */
export function unionRoles(roles: RoleDefinition[]): EffectiveAccess {
  const permissions = emptyPermissionSet();
  const activities = emptyActivitySet();
  const flags: Record<Flag, boolean> = {
    sensitivePayroll: false,
    fullAccountNumbers: false,
    closedPeriod: false,
  };
  for (const role of roles) {
    const n = normalizeGrant(role.permissions);
    for (const area of AREA_KEYS) {
      if (!n[area].length) continue;
      const merged = new Set([...permissions[area], ...n[area]]);
      permissions[area] = ACTIONS.filter((a) => merged.has(a));
    }
    const na = normalizeActivities(role.permissions);
    for (const def of ACTIVITIES as readonly ActivityDef[]) {
      const k = def.key as ActivityKey;
      if (!na[k].length) continue;
      const merged = new Set([...activities[k], ...na[k]]);
      activities[k] = supportedActions(def).filter((a) => merged.has(a));
    }
    for (const f of FLAGS) if (role.flags?.[f.key]) flags[f.key] = true;
  }
  return {
    roleKeys: roles.map((r) => r.key),
    permissions,
    activities,
    flags,
    isAdmin: roles.some((r) => r.key === ADMIN_ROLE_KEY),
  };
}

/** Full access (trusted contexts: first-run fallback, system jobs). */
export function fullAccess(): EffectiveAccess {
  return unionRoles([builtinRole(ADMIN_ROLE_KEY)!]);
}

/** Test / tooling helper: an access with these areas taken away entirely (area grants and every activity of the area), like a role that never had them. */
export function withoutAreas(
  access: EffectiveAccess,
  areas: readonly Area[],
): EffectiveAccess {
  const permissions = { ...access.permissions };
  const activities = access.activities ? { ...access.activities } : undefined;
  for (const area of areas) {
    permissions[area] = [];
    if (!activities) continue;
    for (const def of activitiesOf(area)) activities[def.key as ActivityKey] = [];
  }
  return { ...access, permissions, activities };
}

export function can(
  access: Pick<EffectiveAccess, 'permissions'> | null | undefined,
  area: Area,
  action: Action,
): boolean {
  if (!access) return false;
  return access.permissions[area]?.includes(action) ?? false;
}

/**
 * QB Enterprise activity check: does the access allow `action` on one activity? Without activity
 * data (an access object built by hand) it falls back to the activity's area; View Balance then
 * follows View.
 */
export function canActivity(
  access: Pick<EffectiveAccess, 'permissions' | 'activities'> | null | undefined,
  activity: string,
  action: ActivityAction,
): boolean {
  if (!access) return false;
  const def = activityDef(activity);
  if (!def) return false;
  if (access.activities) return access.activities[def.key as ActivityKey]?.includes(action) ?? false;
  return can(access, def.area, action === VIEW_BALANCE ? 'view' : action);
}

/**
 * A rule that names only an AREA (a route no activity was mapped to): fail closed - the action is
 * needed on EVERY activity of the area that has that right. For a role stored the old way (one
 * grant for the whole area) this is exactly the old area check.
 */
export function canWholeArea(
  access: Pick<EffectiveAccess, 'permissions' | 'activities'> | null | undefined,
  area: Area,
  action: Action,
): boolean {
  if (!access) return false;
  if (!access.activities) return can(access, area, action);
  const defs = activitiesOf(area).filter((d) => supportedActions(d).includes(action));
  if (!defs.length) return can(access, area, action);
  return defs.every((d) => access.activities![d.key as ActivityKey]?.includes(action));
}

/** True when `inner` grants nothing beyond `outer` (used to block privilege escalation). */
export function isSubset(inner: EffectiveAccess, outer: EffectiveAccess): boolean {
  for (const area of AREA_KEYS) {
    for (const a of inner.permissions[area]) if (!outer.permissions[area].includes(a)) return false;
  }
  if (inner.activities) {
    for (const def of ACTIVITIES as readonly ActivityDef[]) {
      const k = def.key as ActivityKey;
      for (const a of inner.activities[k] ?? []) if (!canActivity(outer, k, a)) return false;
    }
  }
  for (const f of FLAGS) if (inner.flags[f.key] && !outer.flags[f.key]) return false;
  return true;
}

/** True when the access set allows any write (create/modify/delete) anywhere. */
export function hasAnyWrite(access: EffectiveAccess): boolean {
  return AREA_KEYS.some((a) =>
    access.permissions[a].some((x) => x === 'create' || x === 'modify' || x === 'delete'),
  );
}

/**
 * Collapse effective access to the legacy 4-level role still read by older code paths
 * (ctx.role view-only guard in _base.ts, rbac.ts getRole). Services check fine-grained
 * permissions with requirePermission / requireEffectivePermission (lib/services/access.ts).
 */
export function legacyRoleFor(
  access: EffectiveAccess,
  isOwner: boolean,
): 'owner' | 'admin' | 'accountant' | 'viewer' {
  if (access.isAdmin) return isOwner ? 'owner' : 'admin';
  if (!hasAnyWrite(access)) return 'viewer';
  return 'accountant';
}

export function areaLabel(area: Area): string {
  return AREAS.find((a) => a.key === area)?.label ?? area;
}
