'use client';
/**
 * Users & Roles > View Permissions (QuickBooks Enterprise parity, prefsperms).
 *
 *  - Role permissions: pick roles (or all of them) and see every Area and Activity side by side
 *    with its access level (None / Full / Partial and the Partial rights) and the sensitive-data
 *    rights.
 *  - User permissions: the same for people — what each user can really do (all of their roles
 *    together).
 *  - User list and Role list: who uses the file, with roles, status, two-factor and last sign-in.
 *
 * Print prints the report on screen; Download CSV saves it (needs the report's Print right).
 * Data: GET /api/users/permissions-report (lib/services/permissionReports.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileText, Printer } from 'lucide-react';
import { Badge, Button, Card, PageHeader, PageSkeleton, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api } from '@/lib/client';

type Kind = 'roles' | 'users' | 'user_list' | 'role_list';

interface Column {
  key: string;
  name: string;
  detail?: string;
}
interface Cell {
  level: 'None' | 'Full' | 'Partial';
  text: string;
}
interface MatrixReport {
  title: string;
  columns: Column[];
  rows: Array<{ area: string; areaLabel: string; activity: string; label: string; cells: Record<string, Cell> }>;
  flags: Array<{ key: string; label: string; cells: Record<string, boolean> }>;
}
interface UserRow {
  userId: string;
  name: string;
  login: string;
  roles: string;
  status: string;
  twoFactor: boolean;
  isOwner: boolean;
  lastSignIn: string | null;
}
interface RoleRow {
  key: string;
  name: string;
  type: string;
  description: string;
  users: string;
  userCount: number;
}
interface Choice {
  key: string;
  name: string;
}

const TABS: Array<{ id: Kind; label: string }> = [
  { id: 'roles', label: 'Role permissions' },
  { id: 'users', label: 'User permissions' },
  { id: 'user_list', label: 'User list' },
  { id: 'role_list', label: 'Role list' },
];

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

const LEVEL_TONE: Record<Cell['level'], 'success' | 'info' | 'neutral'> = { Full: 'success', Partial: 'info', None: 'neutral' };

export default function ViewPermissionsPage() {
  const [kind, setKind] = useState<Kind>('roles');
  const [roles, setRoles] = useState<Choice[]>([]);
  const [users, setUsers] = useState<Choice[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [matrix, setMatrix] = useState<MatrixReport | null>(null);
  const [userRows, setUserRows] = useState<UserRow[] | null>(null);
  const [roleRows, setRoleRows] = useState<RoleRow[] | null>(null);
  const [onlyGranted, setOnlyGranted] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // The choices for the side-by-side reports come from the lists themselves.
  useEffect(() => {
    Promise.all([
      api.get<{ rows: RoleRow[] }>('/api/users/permissions-report?kind=role_list'),
      api.get<{ rows: UserRow[] }>('/api/users/permissions-report?kind=user_list'),
    ])
      .then(([r, u]) => {
        setRoles(r.rows.map((x) => ({ key: x.key, name: x.name })));
        setUsers(u.rows.map((x) => ({ key: x.userId, name: x.name })));
        setRoleRows(r.rows);
        setUserRows(u.rows);
      })
      .catch((e) => setError(errMsg(e)));
  }, []);

  const query = useMemo(() => {
    const p = new URLSearchParams({ kind });
    if ((kind === 'roles' || kind === 'users') && picked.length) p.set('keys', picked.join(','));
    return p.toString();
  }, [kind, picked]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (kind === 'roles' || kind === 'users') setMatrix(await api.get<MatrixReport>(`/api/users/permissions-report?${query}`));
      else if (kind === 'user_list') setUserRows((await api.get<{ rows: UserRow[] }>(`/api/users/permissions-report?${query}`)).rows);
      else setRoleRows((await api.get<{ rows: RoleRow[] }>(`/api/users/permissions-report?${query}`)).rows);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [kind, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const choices = kind === 'roles' ? roles : kind === 'users' ? users : [];
  const visibleRows = useMemo(() => {
    if (!matrix) return [];
    if (!onlyGranted) return matrix.rows;
    return matrix.rows.filter((r) => matrix.columns.some((c) => r.cells[c.key]?.level !== 'None'));
  }, [matrix, onlyGranted]);

  async function downloadCsv() {
    try {
      const res = await fetch(`/api/users/permissions-report?${query}&format=csv`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not download the report.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${TABS.find((t) => t.id === kind)!.label}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(errMsg(e), 'danger');
    }
  }

  let lastArea = '';
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="View Permissions"
        icon={FileText}
        action={
          <div className="flex gap-2 print:hidden">
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print
            </Button>
            <Button variant="secondary" onClick={() => void downloadCsv()}>
              <Download className="h-4 w-4" /> Download CSV
            </Button>
          </div>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Link href="/users" className="mr-2 inline-flex items-center gap-1 text-sm font-medium text-electric hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Users &amp; Roles
        </Link>
        <div role="tablist" aria-label="Report" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={kind === t.id}
              onClick={() => {
                setKind(t.id);
                setPicked([]);
              }}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                kind === t.id ? 'bg-electric text-white' : 'bg-white text-navy hover:bg-electric/5'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {(kind === 'roles' || kind === 'users') && (
        <Card className="mb-4 p-4 print:hidden">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-navy">
              {kind === 'roles' ? 'Roles to compare' : 'Users to compare'} <span className="font-normal text-navy/50">(none checked = all)</span>
            </legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {choices.map((c) => (
                <label key={c.key} className="flex items-center gap-1.5 text-sm text-navy">
                  <input
                    type="checkbox"
                    checked={picked.includes(c.key)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.key] : p.filter((k) => k !== c.key)))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="mt-3 flex items-center gap-1.5 text-sm text-navy/70">
            <input type="checkbox" checked={onlyGranted} onChange={(e) => setOnlyGranted(e.target.checked)} />
            Hide activities nobody in the report can use
          </label>
        </Card>
      )}

      {error && <Card className="mb-4 p-4 text-sm text-red-600">{error}</Card>}

      {loading && !matrix && !userRows && !roleRows ? (
        <PageSkeleton />
      ) : kind === 'roles' || kind === 'users' ? (
        matrix && (
          <Card className="p-0">
            <h2 className="px-4 pt-4 text-lg font-bold text-navy">{matrix.title}</h2>
            <Table>
              <thead>
                <tr>
                  <Th>Area and activity</Th>
                  {matrix.columns.map((c) => (
                    <Th key={c.key}>
                      {c.name}
                      {c.detail && <span className="block font-normal text-navy/40">{c.detail}</span>}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.flatMap((r) => {
                  const out = [];
                  if (r.area !== lastArea) {
                    lastArea = r.area;
                    out.push(
                      <tr key={`a-${r.area}`}>
                        <td colSpan={matrix.columns.length + 1} className="bg-slate-50 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-navy/50">
                          {r.areaLabel}
                        </td>
                      </tr>,
                    );
                  }
                  out.push(
                    <Tr key={r.activity}>
                      <Td className="pl-8 text-sm">{r.label}</Td>
                      {matrix.columns.map((c) => {
                        const cell = r.cells[c.key];
                        return (
                          <Td key={c.key} className="text-sm">
                            <Badge tone={LEVEL_TONE[cell.level]}>{cell.level}</Badge>
                            {cell.level === 'Partial' && <span className="ml-1.5 text-xs text-navy/60">{cell.text}</span>}
                          </Td>
                        );
                      })}
                    </Tr>,
                  );
                  return out;
                })}
                <tr>
                  <td colSpan={matrix.columns.length + 1} className="bg-slate-50 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-navy/50">
                    Sensitive data
                  </td>
                </tr>
                {matrix.flags.map((f) => (
                  <Tr key={f.key}>
                    <Td className="pl-8 text-sm">{f.label}</Td>
                    {matrix.columns.map((c) => (
                      <Td key={c.key} className="text-sm">
                        {f.cells[c.key] ? 'Yes' : 'No'}
                      </Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )
      ) : kind === 'user_list' ? (
        <Card className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Login</Th>
                <Th>Roles</Th>
                <Th>Status</Th>
                <Th>Two-factor sign-in</Th>
                <Th>Last sign-in</Th>
              </tr>
            </thead>
            <tbody>
              {(userRows ?? []).map((u) => (
                <Tr key={u.userId}>
                  <Td>
                    {u.name}
                    {u.isOwner && <span className="ml-2 text-xs text-navy/40">(company creator)</span>}
                  </Td>
                  <Td className="font-mono text-sm">{u.login}</Td>
                  <Td className="text-sm">{u.roles}</Td>
                  <Td>{u.status === 'Active' ? <Badge tone="success">Active</Badge> : <Badge tone="void">Inactive</Badge>}</Td>
                  <Td className="text-sm">{u.twoFactor ? 'On' : 'Off'}</Td>
                  <Td className="text-sm">{u.lastSignIn ? new Date(u.lastSignIn).toLocaleString() : 'Never'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <Card className="p-0">
          <Table>
            <thead>
              <tr>
                <Th>Role</Th>
                <Th>Type</Th>
                <Th>Description</Th>
                <Th>Users</Th>
              </tr>
            </thead>
            <tbody>
              {(roleRows ?? []).map((r) => (
                <Tr key={r.key}>
                  <Td className="font-semibold">{r.name}</Td>
                  <Td>
                    <Badge tone={r.type === 'Custom' ? 'info' : 'neutral'}>{r.type}</Badge>
                  </Td>
                  <Td className="text-sm text-navy/70">{r.description}</Td>
                  <Td className="text-sm">{r.users || '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </main>
  );
}
