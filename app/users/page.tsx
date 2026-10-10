'use client';
/**
 * Users & Roles (QuickBooks Desktop Enterprise "Users and Roles").
 *
 * Users tab: add a user (name, login, password, roles), edit, change roles, deactivate /
 * reactivate, reset password, and show a user's effective permissions (union of their roles).
 * Roles tab: built-in roles (read-only) and custom roles — create, clone, edit with a permission
 * matrix (area × view/create/modify/delete/print + Full) and the sensitive-data flags, delete.
 *
 * All rules (last active Admin, no privilege escalation, audit) are enforced server-side in
 * lib/services/users.ts; this page only presents them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserCheck, UserX, Users } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Label,
  Modal,
  PageHeader,
  PageSkeleton,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api } from '@/lib/client';
import type { Action, Area, Flag, PermissionGrant, PermissionSet, RoleFlags } from '@/lib/permissions/model';

interface CompanyUser {
  userId: string;
  name: string;
  login: string;
  isActive: boolean;
  isOwner: boolean;
  roleKeys: string[];
  roles: { key: string; name: string }[];
  isAdmin: boolean;
}
interface UserDetail extends CompanyUser {
  access: { permissions: PermissionSet; flags: Record<Flag, boolean>; isAdmin: boolean };
}
interface Role {
  key: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: PermissionGrant;
  flags: RoleFlags;
  userCount: number;
}
interface Catalog {
  areas: { key: Area; label: string; group: string; description: string }[];
  actions: Action[];
  flags: { key: Flag; label: string }[];
}

const ACTION_LABEL: Record<Action, string> = {
  view: 'View',
  create: 'Create',
  modify: 'Modify',
  delete: 'Delete',
  print: 'Print',
};

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/** Expand a stored grant ('full', implied view) into concrete actions per area. */
function expand(grant: PermissionGrant, actions: Action[]): Record<string, Set<Action>> {
  const out: Record<string, Set<Action>> = {};
  for (const [area, list] of Object.entries(grant ?? {})) {
    const set = new Set<Action>();
    for (const a of list ?? []) {
      if (a === 'full') actions.forEach((x) => set.add(x));
      else set.add(a as Action);
    }
    if (set.size) set.add('view');
    out[area] = set;
  }
  return out;
}

export default function UsersAndRolesPage() {
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [users, setUsers] = useState<CompanyUser[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        api.get<CompanyUser[]>('/api/users'),
        api.get<{ roles: Role[]; catalog: Catalog }>('/api/roles'),
      ]);
      setUsers(u);
      setRoles(r.roles);
      setCatalog(r.catalog);
      setError('');
    } catch (e) {
      setError(errMsg(e));
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Users & Roles" icon={Users} />
      <div className="mb-4 flex gap-2" role="tablist">
        {(['users', 'roles'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              tab === t ? 'bg-electric text-white' : 'bg-white text-navy hover:bg-electric/5'
            }`}
          >
            {t === 'users' ? 'Users' : 'Roles'}
          </button>
        ))}
      </div>
      {error && (
        <Card className="mb-4 p-4 text-sm text-red-600">
          {error}
        </Card>
      )}
      {users === null || !catalog ? (
        error ? null : <PageSkeleton />
      ) : tab === 'users' ? (
        <UsersTab users={users} roles={roles} catalog={catalog} reload={load} />
      ) : (
        <RolesTab roles={roles} catalog={catalog} reload={load} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersTab({
  users,
  roles,
  catalog,
  reload,
}: {
  users: CompanyUser[];
  roles: Role[];
  catalog: Catalog;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<CompanyUser | 'new' | null>(null);
  const [resetting, setResetting] = useState<CompanyUser | null>(null);
  const [toggling, setToggling] = useState<CompanyUser | null>(null);
  const [viewing, setViewing] = useState<UserDetail | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggleActive() {
    if (!toggling) return;
    setBusy(true);
    try {
      await api.patch(`/api/users/${toggling.userId}`, { isActive: !toggling.isActive });
      toast(toggling.isActive ? 'User deactivated.' : 'User reactivated.', 'success');
      setToggling(null);
      await reload();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function showPermissions(u: CompanyUser) {
    try {
      setViewing(await api.get<UserDetail>(`/api/users/${u.userId}`));
    } catch (e) {
      toast(errMsg(e), 'danger');
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between p-4">
        <p className="text-sm text-navy/60">
          People who can sign in to this company file. A user can hold several roles — they get
          everything any of their roles allows.
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Login</Th>
            <Th>Roles</Th>
            <Th>Status</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <Tr key={u.userId} className={u.isActive ? '' : 'opacity-60'}>
              <Td>
                <span className="font-semibold">{u.name}</span>
                {u.isOwner && <span className="ml-2 text-xs text-navy/40">(company creator)</span>}
              </Td>
              <Td className="font-mono text-sm">{u.login}</Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {u.roles.map((r) => (
                    <Badge key={r.key} tone={r.key === 'admin' ? 'info' : 'neutral'}>
                      {r.name}
                    </Badge>
                  ))}
                </div>
              </Td>
              <Td>
                {u.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="void">Inactive</Badge>}
              </Td>
              <Td className="text-right whitespace-nowrap">
                <Button size="sm" variant="ghost" onClick={() => showPermissions(u)} title="Effective permissions">
                  <ShieldCheck className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(u)} title="Edit user">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setResetting(u)} title="Reset password">
                  <KeyRound className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setToggling(u)}
                  title={u.isActive ? 'Deactivate' : 'Reactivate'}
                >
                  {u.isActive ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {editing && (
        <UserEditor
          user={editing === 'new' ? null : editing}
          roles={roles}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
      <ConfirmDialog
        open={!!toggling}
        title={toggling?.isActive ? 'Deactivate user' : 'Reactivate user'}
        message={
          toggling?.isActive
            ? `${toggling?.name} will no longer be able to sign in to this company. Their history is kept.`
            : `${toggling?.name} will be able to sign in again with their existing roles.`
        }
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Reactivate'}
        tone={toggling?.isActive ? 'danger' : undefined}
        loading={busy}
        onConfirm={toggleActive}
        onClose={() => setToggling(null)}
      />
      {viewing && (
        <Modal open onClose={() => setViewing(null)} title={`Effective permissions — ${viewing.name}`} size="xl">
          <p className="mb-3 text-sm text-navy/60">
            Combined from: {viewing.roles.map((r) => r.name).join(', ') || 'no roles'}.
          </p>
          <PermissionMatrix
            catalog={catalog}
            value={viewing.access.permissions as PermissionGrant}
            flags={viewing.access.flags}
            readOnly
          />
        </Modal>
      )}
    </Card>
  );
}

function RoleChecklist({
  roles,
  selected,
  onChange,
}: {
  roles: Role[];
  selected: string[];
  onChange: (keys: string[]) => void;
}) {
  return (
    <div className="grid max-h-64 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
      {roles.map((r) => (
        <label key={r.key} className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-electric/5">
          <input
            type="checkbox"
            className="mt-1"
            checked={selected.includes(r.key)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, r.key] : selected.filter((k) => k !== r.key))
            }
          />
          <span>
            <span className="text-sm font-semibold text-navy">{r.name}</span>
            {!r.builtin && <span className="ml-1 text-xs text-navy/40">(custom)</span>}
            <span className="block text-xs text-navy/50">{r.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function UserEditor({
  user,
  roles,
  onClose,
  onSaved,
}: {
  user: CompanyUser | null;
  roles: Role[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(user?.name ?? '');
  const [login, setLogin] = useState(user?.login ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>(user?.roleKeys ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!user && password !== confirm) {
      toast('Passwords do not match.', 'danger');
      return;
    }
    setBusy(true);
    try {
      if (user) {
        await api.patch(`/api/users/${user.userId}`, { name, login, roleKeys });
        toast('User updated.', 'success');
      } else {
        await api.post('/api/users', { name, login, password: password || undefined, roleKeys });
        toast('User added.', 'success');
      }
      await onSaved();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Add user'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim() || !login.trim() || roleKeys.length === 0}>
            {user ? 'Save' : 'Add user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="u-name">Full name</Label>
            <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label htmlFor="u-login">Login (email or user name)</Label>
            <Input id="u-login" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" />
          </div>
        </div>
        {!user && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="u-pw">Password (min 8 characters)</Label>
              <Input
                id="u-pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="u-pw2">Confirm password</Label>
              <Input
                id="u-pw2"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
        )}
        <div>
          <Label>Roles</Label>
          <RoleChecklist roles={roles} selected={roleKeys} onChange={setRoleKeys} />
        </div>
      </div>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: CompanyUser; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (password !== confirm) {
      toast('Passwords do not match.', 'danger');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/users/${user.userId}/reset-password`, { password });
      toast(`Password reset for ${user.name}.`, 'success');
      onClose();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset password — ${user.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={password.length < 8}>
            Reset password
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="rp-1">New password (min 8 characters)</Label>
          <Input id="rp-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" />
        </div>
        <div>
          <Label htmlFor="rp-2">Confirm new password</Label>
          <Input id="rp-2" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function RolesTab({
  roles,
  catalog,
  reload,
}: {
  roles: Role[];
  catalog: Catalog;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [cloning, setCloning] = useState<Role | null>(null);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);

  async function doDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.del(`/api/roles/${deleting.key}`);
      toast('Role deleted.', 'success');
      setDeleting(null);
      await reload();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between p-4">
        <p className="text-sm text-navy/60">
          Built-in roles can&apos;t be changed — clone one to make a custom version.
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> New role
        </Button>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Role</Th>
            <Th>Description</Th>
            <Th numeric>Users</Th>
            <Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <Tr key={r.key}>
              <Td>
                <span className="font-semibold">{r.name}</span>{' '}
                {r.builtin ? <Badge>Built-in</Badge> : <Badge tone="info">Custom</Badge>}
              </Td>
              <Td className="text-sm text-navy/60">{r.description}</Td>
              <Td numeric>{r.userCount}</Td>
              <Td className="text-right whitespace-nowrap">
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)} title={r.builtin ? 'View' : 'Edit'}>
                  {r.builtin ? <ShieldCheck className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCloning(r)} title="Clone">
                  <Copy className="h-4 w-4" />
                </Button>
                {!r.builtin && (
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} title="Delete">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      {editing && (
        <RoleEditor
          role={editing === 'new' ? null : editing}
          catalog={catalog}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {cloning && (
        <CloneRole
          role={cloning}
          onClose={() => setCloning(null)}
          onSaved={async () => {
            setCloning(null);
            await reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete role"
        message={`Delete the custom role "${deleting?.name}"? This can't be undone.`}
        confirmLabel="Delete"
        tone="danger"
        loading={busy}
        onConfirm={doDelete}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function CloneRole({
  role,
  onClose,
  onSaved,
}: {
  role: Role;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(`${role.name} (copy)`);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.post('/api/roles', { cloneFrom: role.key, name });
      toast('Role cloned.', 'success');
      await onSaved();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`Clone ${role.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            Clone role
          </Button>
        </>
      }
    >
      <Label htmlFor="clone-name">New role name</Label>
      <Input id="clone-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
    </Modal>
  );
}

function RoleEditor({
  role,
  catalog,
  onClose,
  onSaved,
}: {
  role: Role | null;
  catalog: Catalog;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const readOnly = role?.builtin ?? false;
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [grant, setGrant] = useState<PermissionGrant>(role?.permissions ?? {});
  const [flags, setFlags] = useState<RoleFlags>(role?.flags ?? {});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (role) {
        await api.patch(`/api/roles/${role.key}`, { name, description, permissions: grant, flags });
        toast('Role saved.', 'success');
      } else {
        await api.post('/api/roles', { name, description, permissions: grant, flags });
        toast('Role created.', 'success');
      }
      await onSaved();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? (readOnly ? `${role.name} (built-in)` : `Edit role — ${role.name}`) : 'New role'}
      size="xl"
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={busy} disabled={!name.trim()}>
              {role ? 'Save role' : 'Create role'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {!readOnly && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="r-name">Role name</Label>
              <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </div>
            <div>
              <Label htmlFor="r-desc">Description</Label>
              <Input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        )}
        {readOnly && <p className="text-sm text-navy/60">{role?.description}</p>}
        <PermissionMatrix
          catalog={catalog}
          value={grant}
          flags={flags}
          readOnly={readOnly}
          onChange={setGrant}
          onFlagsChange={setFlags}
        />
      </div>
    </Modal>
  );
}

/** Area × action checkbox grid (+ Full column) and the sensitive-data flags. */
function PermissionMatrix({
  catalog,
  value,
  flags,
  readOnly,
  onChange,
  onFlagsChange,
}: {
  catalog: Catalog;
  value: PermissionGrant;
  flags: RoleFlags;
  readOnly?: boolean;
  onChange?: (g: PermissionGrant) => void;
  onFlagsChange?: (f: RoleFlags) => void;
}) {
  const expanded = useMemo(() => expand(value, catalog.actions), [value, catalog.actions]);

  function setArea(area: Area, set: Set<Action>) {
    const next: PermissionGrant = { ...value };
    // Granting anything implies View; clearing View clears the area.
    if (set.size && !set.has('view')) set.add('view');
    if (set.size) next[area] = catalog.actions.filter((a) => set.has(a));
    else delete next[area];
    onChange?.(next);
  }
  function toggle(area: Area, action: Action, on: boolean) {
    const set = new Set(expanded[area] ?? []);
    if (on) set.add(action);
    else if (action === 'view') set.clear();
    else set.delete(action);
    setArea(area, set);
  }
  function toggleFull(area: Area, on: boolean) {
    setArea(area, on ? new Set(catalog.actions) : new Set());
  }

  let lastGroup = '';
  return (
    <div>
      <Table>
        <thead>
          <tr>
            <Th>Area</Th>
            {catalog.actions.map((a) => (
              <Th key={a} className="text-center">
                {ACTION_LABEL[a]}
              </Th>
            ))}
            <Th className="text-center">Full</Th>
          </tr>
        </thead>
        <tbody>
          {catalog.areas.flatMap((area) => {
            const rows = [];
            if (area.group !== lastGroup) {
              lastGroup = area.group;
              rows.push(
                <tr key={`g-${area.group}`}>
                  <td colSpan={catalog.actions.length + 2} className="px-4 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider text-navy/40">
                    {area.group}
                  </td>
                </tr>,
              );
            }
            const set = expanded[area.key] ?? new Set<Action>();
            const full = catalog.actions.every((a) => set.has(a));
            rows.push(
              <Tr key={area.key}>
                <Td>
                  <span className="text-sm font-semibold">{area.label}</span>
                  <span className="block text-xs text-navy/40">{area.description}</span>
                </Td>
                {catalog.actions.map((a) => (
                  <Td key={a} className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${area.label}: ${ACTION_LABEL[a]}`}
                      checked={set.has(a)}
                      disabled={readOnly}
                      onChange={(e) => toggle(area.key, a, e.target.checked)}
                    />
                  </Td>
                ))}
                <Td className="text-center">
                  <input
                    type="checkbox"
                    aria-label={`${area.label}: full access`}
                    checked={full}
                    disabled={readOnly}
                    onChange={(e) => toggleFull(area.key, e.target.checked)}
                  />
                </Td>
              </Tr>,
            );
            return rows;
          })}
        </tbody>
      </Table>
      <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-3">
        <div className="text-[11px] font-bold uppercase tracking-wider text-navy/40">Sensitive data</div>
        {catalog.flags.map((f) => (
          <label key={f.key} className="flex items-center gap-2 text-sm text-navy">
            <input
              type="checkbox"
              checked={Boolean(flags?.[f.key])}
              disabled={readOnly}
              onChange={(e) => onFlagsChange?.({ ...flags, [f.key]: e.target.checked })}
            />
            {f.label}
          </label>
        ))}
      </div>
    </div>
  );
}
