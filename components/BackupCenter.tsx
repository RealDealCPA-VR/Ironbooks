'use client';
/**
 * Back Up & Restore page, top section (team backups):
 *  - status + "Back up now" (saved into the backup folder)
 *  - automatic backups: how often (off / every day / every N hours), how many to keep, where
 *  - backup history: every backup made of this company file; versions still on disk can be
 *    previewed and restored ("Look inside & restore…").
 */
import * as React from 'react';
import { CheckCircle2, AlertTriangle, History, Save, ShieldCheck, Eye } from 'lucide-react';
import { Badge, Button, Card, Input, Label, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatAge, indicatorDetail, scheduleCopy, sourceLabel, type BackupStatusDto } from '@/lib/backupStatusText';
import { BACKUP_CHANGED_EVENT, notifyBackupChanged } from './BackupStatus';
import { formatBytes } from './BackupPreviewModal';

export interface BackupHistoryRow {
  id: string;
  at: string;
  source: 'manual' | 'scheduled' | 'quit' | 'pre-op';
  kind: 'full' | 'company';
  filename: string;
  path: string | null;
  sizeBytes: number;
  note?: string;
  prunedAt?: string;
  available: boolean;
}

interface BackupSettingsDto {
  schedule: 'off' | 'daily' | 'hours';
  everyHours: number;
  keep: number;
  folder: string | null;
}

/** Mirrors MANUAL_VERSIONS_KEEP in lib/services/backupHistory.ts (server-only module). */
const MANUAL_COPIES_KEPT = 30;

interface BackupsResponse {
  settings: BackupSettingsDto;
  /** Absolute folder paths are only sent to an Admin of every company in the file. */
  folder: string | null;
  defaultFolder: string | null;
  canManage: boolean;
  status: BackupStatusDto;
  history: BackupHistoryRow[];
}

function whereText(r: BackupHistoryRow): string {
  if (r.kind === 'company') return 'Downloaded (one company)';
  if (!r.path) return 'Downloaded to your computer';
  if (r.prunedAt) return 'Removed (older than the versions kept)';
  if (!r.available) return 'File no longer in the folder';
  return r.path;
}

export function BackupCenter({ onPreviewVersion }: { onPreviewVersion: (row: BackupHistoryRow) => void }) {
  const [data, setData] = React.useState<BackupsResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState<{ schedule: BackupSettingsDto['schedule']; everyHours: string; keep: string; folder: string }>({
    schedule: 'daily',
    everyHours: '24',
    keep: '14',
    folder: '',
  });

  // Only the desktop shell backs up on close; decided after mount so server and client render match.
  const [isDesktop, setIsDesktop] = React.useState(false);
  React.useEffect(() => {
    setIsDesktop(Boolean((window as unknown as { bookkeeper?: { isDesktop?: boolean } }).bookkeeper?.isDesktop));
  }, []);
  const copy = scheduleCopy(isDesktop);

  const load = React.useCallback(async () => {
    try {
      const res = await api.get<BackupsResponse>('/api/backups');
      setData(res);
      setLoadError(null);
      setForm({
        schedule: res.settings.schedule,
        everyHours: String(res.settings.everyHours),
        keep: String(res.settings.keep),
        folder: res.settings.folder ?? '',
      });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Backup history could not be loaded.');
    }
  }, []);

  React.useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(BACKUP_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(BACKUP_CHANGED_EVENT, onChanged);
  }, [load]);

  async function backUpNow() {
    setRunning(true);
    try {
      await api.post('/api/backups/run', {});
      toast('Backup saved to the backup folder.', 'success');
      notifyBackupChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The backup could not be made. Please try again.', 'danger');
    } finally {
      setRunning(false);
    }
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/api/backups', {
        schedule: form.schedule,
        everyHours: Number(form.everyHours),
        keep: Number(form.keep),
        folder: form.folder.trim() || null,
      });
      toast('Automatic backup settings saved.', 'success');
      notifyBackupChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Settings could not be saved.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const status = data?.status;
  const StatusIcon = status?.warn ? AlertTriangle : CheckCircle2;

  return (
    <>
      <Card className="p-6 flex flex-col gap-4">
        <h2 className="text-lg font-bold text-navy flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-electric" aria-hidden="true" />
          Backup status
        </h2>
        {loadError && (
          <p role="alert" className="text-sm text-red-600">
            {loadError}
          </p>
        )}
        {status && (
          <div
            className={
              status.warn
                ? 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-2'
                : 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 flex items-start gap-2'
            }
          >
            <StatusIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">
                {status.lastBackupAt ? `Last backup: ${formatAge(status.lastBackupAt)}` : 'This company file has never been backed up'}
              </p>
              <p>{indicatorDetail(status)}</p>
              <p className="mt-1 text-xs opacity-80">
                {status.schedule === 'off'
                  ? 'Automatic backups are off.'
                  : status.nextDueAt
                    ? `Next automatic backup: ${new Date(status.nextDueAt) <= new Date() ? 'within a few minutes (if anything changed)' : new Date(status.nextDueAt).toLocaleString('en-US')}.`
                    : ''}
              </p>
            </div>
          </div>
        )}
        <div>
          <Button onClick={backUpNow} loading={running}>
            <Save className="h-4 w-4" aria-hidden="true" />
            Back up now
          </Button>
          {data && (
            <p className="mt-2 text-xs text-navy/50 break-all">
              Saved to {data.folder ? <span className="font-mono">{data.folder}</span> : 'the backup folder'}
            </p>
          )}
          {data && !data.canManage && (
            <p className="mt-1 text-xs text-navy/60">
              Only an Admin of every company in this file can back up, restore or change these settings.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-6 flex flex-col gap-3">
        <h2 className="text-lg font-bold text-navy">Automatic backups</h2>
        <p className="text-sm text-navy/60">
          {copy.intro} A copy is skipped when nothing has changed since the last one. Older copies are removed
          so only the most recent ones are kept. Copies you make with Back up now are kept separately (the newest{' '}
          {MANUAL_COPIES_KEPT}).
        </p>
        <form onSubmit={saveSettings} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <Label htmlFor="backup-schedule">How often</Label>
              <Select
                id="backup-schedule"
                value={form.schedule}
                onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value as BackupSettingsDto['schedule'] }))}
              >
                <option value="daily">Every day</option>
                <option value="hours">Every few hours</option>
                <option value="off">{copy.offLabel}</option>
              </Select>
              {form.schedule === 'off' && (
                <p className="mt-1 text-xs text-navy/50 max-w-xs">{copy.offHint}</p>
              )}
            </div>
            {form.schedule === 'hours' && (
              <div className="w-36">
                <Label htmlFor="backup-hours">Every how many hours</Label>
                <Input
                  id="backup-hours"
                  type="number"
                  min={1}
                  max={168}
                  step={1}
                  value={form.everyHours}
                  onChange={(e) => setForm((f) => ({ ...f, everyHours: e.target.value }))}
                />
              </div>
            )}
            <div className="w-36">
              <Label htmlFor="backup-keep">Backups to keep</Label>
              <Input
                id="backup-keep"
                type="number"
                min={1}
                max={365}
                step={1}
                value={form.keep}
                onChange={(e) => setForm((f) => ({ ...f, keep: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="backup-folder">Backup folder (leave empty for the usual folder)</Label>
            <Input
              id="backup-folder"
              value={form.folder}
              placeholder={data?.defaultFolder ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, folder: e.target.value }))}
              aria-describedby="backup-folder-hint"
            />
            <p id="backup-folder-hint" className="mt-1 text-xs text-navy/50">
              Tip: choose a folder on a different drive or a synced folder so a copy survives if this computer fails.
            </p>
          </div>
          <div>
            <Button type="submit" variant="secondary" loading={saving}>
              Save settings
            </Button>
          </div>
        </form>
      </Card>

      <Card className="p-6 flex flex-col gap-3">
        <h2 className="text-lg font-bold text-navy flex items-center gap-2">
          <History className="h-5 w-5 text-electric" aria-hidden="true" />
          Backup history
        </h2>
        <p className="text-sm text-navy/60">
          Every backup made of this company file. Copies still in the backup folder can be opened to look inside and
          restored.
        </p>
        {!data ? null : data.history.length === 0 ? (
          <p className="text-sm text-navy/40">No backups yet. Click &ldquo;Back up now&rdquo; to make the first one.</p>
        ) : (
          <ul className="divide-y divide-slate-100" aria-label="Backups, newest first">
            {data.history.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-navy flex flex-wrap items-center gap-2">
                    {new Date(r.at).toLocaleString('en-US')}
                    <Badge tone={r.source === 'pre-op' ? 'info' : r.source === 'manual' ? 'neutral' : 'success'}>
                      {sourceLabel(r.source)}
                    </Badge>
                    {r.kind === 'company' && <Badge tone="neutral">One company</Badge>}
                  </p>
                  <p className="text-xs text-navy/50 truncate" title={r.path ?? r.filename}>
                    {r.note ? `${r.note} · ` : ''}
                    {formatBytes(r.sizeBytes)} · {whereText(r)}
                  </p>
                </div>
                {r.available && (
                  <Button size="sm" variant="secondary" onClick={() => onPreviewVersion(r)}>
                    <Eye className="h-4 w-4" aria-hidden="true" />
                    Look inside &amp; restore…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
