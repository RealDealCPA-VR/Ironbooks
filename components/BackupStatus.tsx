'use client';
/**
 * Backup status in the app shell (team backups):
 *  - <BackupIndicator/>   sidebar footer: "Last backup: 2 hours ago ✓" (or a warning), links to
 *                         the Back Up & Restore page.
 *  - <BackupWarningBanner/> top of the page when the file has not been backed up in 7 days
 *                         (and changed since) or never; "Remind me tomorrow" hides it for a day.
 *
 * Both read GET /api/backups/status through one shared poller (every 5 minutes, plus whenever
 * the Backup page announces a change with the `ironbooks:backup-changed` event). That request
 * also keeps the server's scheduled-backup timer running. People without File Utilities access
 * get a 403 and see neither.
 */
import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import {
  BANNER_DISMISS_KEY,
  BANNER_DISMISS_MS,
  bannerDismissed,
  bannerText,
  indicatorDetail,
  indicatorText,
  type BackupStatusDto,
} from '@/lib/backupStatusText';
import { cn } from '@/lib/utils';

export const BACKUP_CHANGED_EVENT = 'ironbooks:backup-changed';
const POLL_MS = 5 * 60 * 1000;

/** Tell the indicator and banner to refresh (call after a backup, restore or settings change). */
export function notifyBackupChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BACKUP_CHANGED_EVENT));
}

// ---- one shared poller for every mounted consumer ----
let current: BackupStatusDto | null = null;
const listeners = new Set<(s: BackupStatusDto | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/backups/status', { cache: 'no-store' });
      current = res.ok ? ((await res.json()) as BackupStatusDto) : null;
    } catch {
      /* offline / server restarting: keep the last known status */
    } finally {
      inflight = null;
    }
    for (const l of listeners) l(current);
  })();
  return inflight;
}

function onChanged() {
  void refresh();
}

function useBackupStatus(): BackupStatusDto | null {
  const [status, setStatus] = React.useState<BackupStatusDto | null>(current);
  const pathname = usePathname();
  React.useEffect(() => {
    listeners.add(setStatus);
    if (listeners.size === 1) {
      timer = setInterval(() => void refresh(), POLL_MS);
      window.addEventListener(BACKUP_CHANGED_EVENT, onChanged);
    }
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        window.removeEventListener(BACKUP_CHANGED_EVENT, onChanged);
      }
    };
  }, []);
  // Refresh on navigation too, so the age text stays current while people work.
  React.useEffect(() => {
    void refresh();
  }, [pathname]);
  return status;
}

export function BackupIndicator() {
  const status = useBackupStatus();
  if (!status) return null;
  const warn = status.warn;
  const text = indicatorText(status);
  const detail = indicatorDetail(status);
  const Icon = warn ? AlertTriangle : CheckCircle2;
  return (
    <Link
      href="/backup"
      title={detail}
      aria-label={`${text}${warn ? ' (needs attention)' : ''}. ${detail}`}
      className={cn(
        'flex items-center justify-center lg:justify-start gap-2 px-2 lg:px-3 py-1.5 mb-1 rounded-lg text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50',
        warn ? 'text-amber-700 bg-amber-50 hover:bg-amber-100' : 'text-navy/60 hover:bg-slate-50 hover:text-navy',
      )}
    >
      <span className="hidden lg:inline truncate">{text}</span>
      <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', warn ? 'text-amber-600' : 'text-emerald-600')} />
    </Link>
  );
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(BANNER_DISMISS_KEY);
  } catch {
    return null;
  }
}

export function BackupWarningBanner() {
  const status = useBackupStatus();
  const pathname = usePathname() || '';
  const [dismissedUntil, setDismissedUntil] = React.useState<string | null>(null);
  React.useEffect(() => setDismissedUntil(readDismissed()), []);

  if (!status?.warn || pathname === '/backup' || bannerDismissed(dismissedUntil)) return null;

  function dismiss() {
    const until = String(Date.now() + BANNER_DISMISS_MS);
    setDismissedUntil(until);
    try {
      window.localStorage.setItem(BANNER_DISMISS_KEY, until);
    } catch {
      /* private window: dismissed for this page view only */
    }
  }

  return (
    <div
      role="status"
      className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0 text-amber-600" />
      <p className="flex-1 min-w-[12rem]">{bannerText(status)}</p>
      <Link
        href="/backup"
        className="rounded-lg bg-contrast px-3 py-1.5 font-semibold text-white hover:bg-contrast/90 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
      >
        Back up now
      </Link>
      <button
        type="button"
        onClick={dismiss}
        className="flex items-center gap-1 rounded-lg px-2 py-1.5 font-medium text-amber-800 hover:bg-amber-100 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
      >
        <X aria-hidden="true" className="h-4 w-4" />
        Remind me tomorrow
      </button>
    </div>
  );
}
