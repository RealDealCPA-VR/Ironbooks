'use client';

/**
 * Scheduled Reports: run a memorized report (or a whole group) every day, week or month and
 * save the export (CSV or Excel) into a folder on this computer. The desktop app checks for due
 * schedules automatically; "Run due reports now" does it on demand. Nothing is emailed — files
 * stay on this computer.
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Label, Modal, PageHeader, Select, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';

interface Schedule {
  id: string;
  name: string;
  memorizedReportId: string | null;
  groupId: string | null;
  frequency: 'daily' | 'weekly' | 'monthly';
  nextRunAt: string;
  format: 'csv' | 'xlsx';
  folder: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
}
interface Option {
  id: string;
  name: string;
}

const today = () => todayISO();

export default function ScheduledReportsPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [folder, setFolder] = useState('');
  const [reports, setReports] = useState<Option[]>([]);
  const [groups, setGroups] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', target: '', frequency: 'monthly', startDate: today(), format: 'csv', folder: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        api.get<{ schedules: Schedule[]; exportFolder: string }>('/api/report-schedules'),
        api.get<{ reports: Option[]; groups: Option[] }>('/api/memorized-reports?withGroups=1'),
      ]);
      setSchedules(s.schedules);
      setFolder(s.exportFolder);
      setReports(m.reports);
      setGroups(m.groups);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load scheduled reports.', 'danger');
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const [kind, id] = form.target.split(':');
      await api.post('/api/report-schedules', {
        name: form.name,
        memorizedReportId: kind === 'r' ? id : null,
        groupId: kind === 'g' ? id : null,
        frequency: form.frequency,
        startDate: form.startDate,
        format: form.format,
        folder: form.folder || undefined,
      });
      setOpen(false);
      setForm({ name: '', target: '', frequency: 'monthly', startDate: today(), format: 'csv', folder: '' });
      await load();
      toast('Schedule saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the schedule.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const runDue = async () => {
    setBusy(true);
    try {
      const d = await api.post<{ results: { name: string; status: string; files: string[]; message?: string }[] }>('/api/report-schedules/run-due');
      if (d.results.length === 0) toast('Nothing is due right now.', 'info');
      else toast(d.results.map((r) => `${r.name}: ${r.status === 'ok' ? `${r.files.length} file(s) saved` : r.message}`).join(' · '), d.results.every((r) => r.status === 'ok') ? 'success' : 'danger');
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not run the schedules.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: Schedule) => {
    try {
      await api.patch(`/api/report-schedules/${s.id}`, { isActive: !s.isActive });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'danger');
    }
  };
  // Deleting asks first (the row's Delete button, and Ctrl+D on a highlighted row).
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const remove = async (s: Schedule) => {
    try {
      await api.del(`/api/report-schedules/${s.id}`);
      setRemoving(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', 'danger');
    }
  };

  const targetName = (s: Schedule) =>
    s.groupId ? `Group: ${groups.find((g) => g.id === s.groupId)?.name ?? '?'}` : reports.find((r) => r.id === s.memorizedReportId)?.name ?? '?';

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Scheduled Reports"
        icon={CalendarClock}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={runDue} loading={busy}>
              <Play className="h-4 w-4" /> Run due reports now
            </Button>
            <Button onClick={() => setOpen(true)} disabled={reports.length === 0 && groups.length === 0}>
              <Plus className="h-4 w-4" /> New schedule
            </Button>
          </div>
        }
      />
      <p className="text-sm text-navy/60 -mt-4 mb-6">
        Files are saved on this computer in <code className="rounded bg-white px-1">{folder || '…'}</code>. Reports are never emailed
        automatically.
      </p>
      <Card className="p-0 overflow-hidden">
        {schedules.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No scheduled reports" message="Memorize a report first, then schedule it here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Runs</Th>
                <Th>Report</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>Format</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    {s.name} {!s.isActive && <Badge tone="warning">Paused</Badge>}
                  </Td>
                  <Td className="capitalize">{s.frequency}</Td>
                  <Td>{targetName(s)}</Td>
                  <Td>{new Date(s.nextRunAt).toLocaleDateString()}</Td>
                  <Td>
                    {s.lastRunAt ? (
                      <span title={s.lastMessage ?? ''}>
                        {new Date(s.lastRunAt).toLocaleDateString()}{' '}
                        <Badge tone={s.lastStatus === 'ok' ? 'success' : s.lastStatus === 'partial' ? 'warning' : 'danger'}>{s.lastStatus}</Badge>
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="uppercase">{s.format}{s.folder ? ` → ${s.folder}` : ''}</Td>
                  <Td>
                    <Button variant="ghost" size="sm" onClick={() => toggle(s)} aria-label={s.isActive ? `Pause ${s.name}` : `Resume ${s.name}`}>
                      {s.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(s)} aria-label={`Delete ${s.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="Delete this schedule?"
        message={removing ? `“${removing.name}” will no longer run. Files it already saved are kept.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => removing && void remove(removing)}
        onClose={() => setRemoving(null)}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Schedule a report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!form.name.trim() || !form.target}>
              Save schedule
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="sc-name">Schedule name</Label>
            <Input id="sc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Month-end pack" />
          </div>
          <div>
            <Label htmlFor="sc-target">What to run</Label>
            <Select id="sc-target" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
              <option value="">Choose a memorized report or group…</option>
              {groups.length > 0 && (
                <optgroup label="Groups">
                  {groups.map((g) => (
                    <option key={g.id} value={`g:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Reports">
                {reports.map((r) => (
                  <option key={r.id} value={`r:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sc-freq">How often</Label>
              <Select id="sc-freq" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="sc-start">First run</Label>
              <Input id="sc-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="sc-format">File type</Label>
              <Select id="sc-format" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                <option value="csv">CSV (one file per report)</option>
                <option value="xlsx">Excel (one workbook)</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="sc-folder">Sub-folder (optional)</Label>
              <Input id="sc-folder" value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} placeholder="Scheduled" />
            </div>
          </div>
          <p className="text-xs text-navy/50">Dates saved in the memorized report are used as-is each time it runs.</p>
        </div>
      </Modal>
    </main>
  );
}
