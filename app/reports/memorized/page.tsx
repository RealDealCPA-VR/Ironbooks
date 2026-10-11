'use client';

/**
 * Memorized Report List (QB Reports → Memorized Reports): saved reports organised in groups.
 *  - Run a report with its saved settings, rename it, move it to another group, delete it.
 *  - Create / rename / delete groups.
 *  - Process Multiple Reports: run a whole group (or ticked reports) at once and export them all
 *    into one Excel workbook (one sheet per report).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bookmark, FileSpreadsheet, FolderPlus, Pencil, Play, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Label, Modal, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { CATALOG_BY_KEY } from '@/lib/reports/catalog';

interface MemorizedRow {
  id: string;
  name: string;
  reportType: string;
  groupId: string | null;
  config: { params?: Record<string, string> };
  createdAt: string;
}
interface Group {
  id: string;
  name: string;
}
interface Processed {
  id: string;
  name: string;
  report?: { title: string; rows: unknown[] };
  error?: string;
}

function reportHref(r: MemorizedRow): string {
  if (r.reportType === 'custom') return '/reports/builder';
  const params = new URLSearchParams(r.config?.params ?? {});
  params.set('mem', r.id);
  return `/reports/std/${r.reportType}?${params.toString()}`;
}

export default function MemorizedReportsPage() {
  const [reports, setReports] = useState<MemorizedRow[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rename, setRename] = useState<{ kind: 'report' | 'group'; id: string; name: string; groupId?: string | null } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'report' | 'group'; id: string; name: string } | null>(null);
  const [newGroup, setNewGroup] = useState('');
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<Processed[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ reports: MemorizedRow[]; groups: Group[] }>('/api/memorized-reports?withGroups=1');
      setReports(d.reports);
      setGroups(d.groups);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load memorized reports.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const out: { group: Group | null; rows: MemorizedRow[] }[] = groups.map((g) => ({ group: g, rows: reports.filter((r) => r.groupId === g.id) }));
    out.push({ group: null, rows: reports.filter((r) => !r.groupId || !groups.some((g) => g.id === r.groupId)) });
    return out;
  }, [reports, groups]);

  const addGroup = async () => {
    if (!newGroup.trim()) return;
    try {
      await api.post('/api/memorized-reports/groups', { name: newGroup.trim() });
      setNewGroup('');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create the group.', 'danger');
    }
  };

  const saveRename = async () => {
    if (!rename) return;
    try {
      if (rename.kind === 'group') await api.patch(`/api/memorized-reports/groups/${rename.id}`, { name: rename.name });
      else await api.patch(`/api/memorized-reports/${rename.id}`, { name: rename.name, groupId: rename.groupId ?? null });
      setRename(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'danger');
    }
  };

  const doDelete = async () => {
    if (!confirm) return;
    try {
      await api.del(confirm.kind === 'group' ? `/api/memorized-reports/groups/${confirm.id}` : `/api/memorized-reports/${confirm.id}`);
      setConfirm(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', 'danger');
    }
  };

  const processRun = async (body: { groupId?: string; ids?: string[] }, xlsx: boolean) => {
    setProcessing(true);
    try {
      if (xlsx) {
        const res = await fetch('/api/memorized-reports/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, format: 'xlsx' }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => null);
          throw new Error(d?.error || 'Export failed.');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'memorized-reports.xlsx';
        a.click();
        URL.revokeObjectURL(url);
        toast('Workbook downloaded — one sheet per report.', 'success');
      } else {
        const d = await api.post<{ results: Processed[] }>('/api/memorized-reports/process', body);
        setResults(d.results);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not process the reports.', 'danger');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Memorized Reports" icon={Bookmark} />
      <p className="text-sm text-navy/60 -mt-4 mb-6">
        Save any report with its settings using the <strong>Memorize</strong> button on the report. Put related reports in a group
        (for example “Month-end”) to run and export them together.
      </p>

      <Card className="p-4 mb-6 flex items-end gap-3 flex-wrap">
        <div>
          <Label htmlFor="mg-new">New group</Label>
          <Input id="mg-new" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="e.g. Month-end" />
        </div>
        <Button variant="secondary" size="sm" onClick={addGroup} disabled={!newGroup.trim()}>
          <FolderPlus className="h-4 w-4" />
          Add group
        </Button>
        <div className="grow" />
        <Button variant="secondary" size="sm" disabled={selected.size === 0 || processing} onClick={() => processRun({ ids: [...selected] }, false)}>
          <Play className="h-4 w-4" />
          Run selected ({selected.size})
        </Button>
        <Button size="sm" disabled={selected.size === 0 || processing} onClick={() => processRun({ ids: [...selected] }, true)}>
          <FileSpreadsheet className="h-4 w-4" />
          Export selected to Excel
        </Button>
        <Link href="/reports/schedules" className="text-sm text-electric hover:underline">
          Schedule reports
        </Link>
      </Card>

      {loading && (
        <div className="flex items-center gap-2 text-navy/50 text-sm py-10 justify-center">
          <Spinner className="text-electric" /> Loading…
        </div>
      )}
      {!loading && reports.length === 0 && groups.length === 0 && (
        <EmptyState icon={Bookmark} title="No memorized reports yet" message="Open any report, set it up the way you like, and click Memorize." />
      )}

      {!loading &&
        grouped.map(({ group, rows }) =>
          group === null && rows.length === 0 ? null : (
            <Card key={group?.id ?? 'none'} className="p-0 mb-4 overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 bg-navy/5 border-b border-slate-200">
                <h2 className="font-bold text-navy">{group?.name ?? 'Not in a group'}</h2>
                <Badge tone="neutral">{rows.length}</Badge>
                <div className="grow" />
                {group && (
                  <>
                    <Button variant="secondary" size="sm" disabled={rows.length === 0 || processing} onClick={() => processRun({ groupId: group.id }, false)}>
                      <Play className="h-4 w-4" /> Process group
                    </Button>
                    <Button variant="secondary" size="sm" disabled={rows.length === 0 || processing} onClick={() => processRun({ groupId: group.id }, true)}>
                      <FileSpreadsheet className="h-4 w-4" /> Export group
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Rename group ${group.name}`} onClick={() => setRename({ kind: 'group', id: group.id, name: group.name })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Delete group ${group.name}`} onClick={() => setConfirm({ kind: 'group', id: group.id, name: group.name })}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </div>
              {rows.length === 0 ? (
                <p className="px-4 py-3 text-sm text-navy/50">No reports in this group yet.</p>
              ) : (
                <ul>
                  {rows.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2 border-b border-slate-100 last:border-0">
                      <input
                        type="checkbox"
                        className="accent-[#2563eb]"
                        aria-label={`Select ${r.name}`}
                        checked={selected.has(r.id)}
                        onChange={() =>
                          setSelected((prev) => {
                            const n = new Set(prev);
                            if (n.has(r.id)) n.delete(r.id);
                            else n.add(r.id);
                            return n;
                          })
                        }
                      />
                      <Link href={reportHref(r)} className="font-medium text-electric hover:underline">
                        {r.name}
                      </Link>
                      <span className="text-xs text-navy/50">{CATALOG_BY_KEY[r.reportType]?.title ?? (r.reportType === 'custom' ? 'Report Builder' : r.reportType)}</span>
                      <div className="grow" />
                      <Button variant="ghost" size="sm" aria-label={`Rename ${r.name}`} onClick={() => setRename({ kind: 'report', id: r.id, name: r.name, groupId: r.groupId })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete ${r.name}`} onClick={() => setConfirm({ kind: 'report', id: r.id, name: r.name })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ),
        )}

      <Modal
        open={!!rename}
        onClose={() => setRename(null)}
        title={rename?.kind === 'group' ? 'Rename group' : 'Edit memorized report'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRename(null)}>
              Cancel
            </Button>
            <Button onClick={saveRename} disabled={!rename?.name.trim()}>
              Save
            </Button>
          </>
        }
      >
        {rename && (
          <div className="space-y-3">
            <div>
              <Label htmlFor="mr-name">Name</Label>
              <Input id="mr-name" value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} autoFocus />
            </div>
            {rename.kind === 'report' && (
              <div>
                <Label htmlFor="mr-group">Group</Label>
                <Select id="mr-group" value={rename.groupId ?? ''} onChange={(e) => setRename({ ...rename, groupId: e.target.value || null })}>
                  <option value="">(no group)</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {rename.kind === 'report' && (
              <p className="text-xs text-navy/50">To change the report’s settings, open it, adjust the settings, then Memorize → Replace.</p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'group' ? 'Delete group?' : 'Delete memorized report?'}
        message={
          confirm?.kind === 'group'
            ? `Delete the group “${confirm?.name}”? Its reports are kept (moved to “Not in a group”); schedules for the group are removed.`
            : `Delete “${confirm?.name}”? Any schedule that runs it is removed too.`
        }
        confirmLabel="Delete"
        tone="danger"
        onConfirm={doDelete}
        onClose={() => setConfirm(null)}
      />

      <Modal open={!!results} onClose={() => setResults(null)} title="Processed reports" size="lg">
        <ul className="space-y-2">
          {results?.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              {r.error ? <Badge tone="danger">Failed</Badge> : <Badge tone="success">Ready</Badge>}
              <span className="font-medium text-navy">{r.name}</span>
              <span className="text-navy/50">{r.error ?? `${r.report?.rows.length ?? 0} rows`}</span>
              {!r.error && (
                <Link className="text-electric hover:underline ml-auto" href={reportHref(reports.find((x) => x.id === r.id)!)}>
                  Open
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Modal>
    </main>
  );
}
