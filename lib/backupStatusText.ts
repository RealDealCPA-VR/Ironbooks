/**
 * Plain-language text for the backup indicator, banner and Backup page (pure; client-safe).
 * The server decides the state (lib/services/backupHistory.ts backupHealth); this only words it.
 */

/** Shape of GET /api/backups/status. */
export interface BackupStatusDto {
  state: 'ok' | 'warning' | 'never';
  lastBackupAt: string | null;
  lastBackupSource: 'manual' | 'scheduled' | 'quit' | 'pre-op' | null;
  daysSince: number | null;
  upToDate: boolean;
  warn: boolean;
  schedule: 'off' | 'daily' | 'hours';
  nextDueAt: string | null;
  running: boolean;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago". */
export function formatAge(iso: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - Date.parse(iso));
  if (ms < MIN) return 'just now';
  if (ms < HOUR) {
    const m = Math.floor(ms / MIN);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(ms / DAY);
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

/** One line for the sidebar indicator, e.g. "Last backup: 2 hours ago". */
export function indicatorText(s: BackupStatusDto, now: Date = new Date()): string {
  if (!s.lastBackupAt) return 'Never backed up';
  return `Last backup: ${formatAge(s.lastBackupAt, now)}`;
}

/** Longer description for the tooltip / screen readers. */
export function indicatorDetail(s: BackupStatusDto): string {
  if (!s.lastBackupAt) return 'This company file has never been backed up. Click to back it up now.';
  const when = new Date(s.lastBackupAt).toLocaleString('en-US');
  const how = s.lastBackupSource ? ` (${sourceLabel(s.lastBackupSource).toLowerCase()})` : '';
  const state = s.warn
    ? `No backup for ${s.daysSince} days and the books have changed since. Click to back up now.`
    : s.upToDate
      ? 'Nothing has changed since then.'
      : 'Backups are up to date.';
  return `Last backup ${when}${how}. ${state}`;
}

/** Banner text when no backup in the warning window. */
export function bannerText(s: BackupStatusDto): string {
  if (!s.lastBackupAt) return 'This company file has never been backed up. A backup protects your books if this computer fails.';
  return `This company file has not been backed up in ${s.daysSince} days. Back it up now to protect your recent work.`;
}

export function sourceLabel(source: BackupStatusDto['lastBackupSource']): string {
  switch (source) {
    case 'scheduled':
      return 'Automatic';
    case 'quit':
      return 'When the app closed';
    case 'pre-op':
      return 'Safety copy';
    case 'manual':
      return 'Made by you';
    default:
      return '';
  }
}

/** The banner was dismissed "for a day": hidden until this time. */
export const BANNER_DISMISS_MS = DAY;
export const BANNER_DISMISS_KEY = 'ironbooks.backupBannerDismissedUntil';

export function bannerDismissed(dismissedUntil: string | null, now: Date = new Date()): boolean {
  if (!dismissedUntil) return false;
  const t = Number(dismissedUntil);
  return Number.isFinite(t) && t > now.getTime();
}
