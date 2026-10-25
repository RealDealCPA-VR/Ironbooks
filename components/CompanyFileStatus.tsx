'use client';
/**
 * Is the company file saved? A quiet indicator in the desktop title bar for a single company file
 * ("ABC Company.ironbooks", lib/services/companyFileSave.ts): normally just "Saved", "Saving…"
 * for a moment after changes, and a clear warning when the file server can't be reached (changes
 * are kept on this computer meanwhile) or the file was opened elsewhere. Click for details and
 * Save Now. Renders nothing for an older company folder or before sign-in.
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Status {
  singleFile: boolean;
  path: string | null;
  status: 'saved' | 'unsaved' | 'saving' | 'error' | 'lost';
  lastSavedAt: string | null;
  unsavedSince: string | null;
  error: string | null;
  conflictCopy: string | null;
}

const POLL_MS = 4000;

function timeOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function CompanyFileStatus({ className }: { className?: string }) {
  const [s, setS] = React.useState<Status | null>(null);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const r = await fetch('/api/company-file/status', { cache: 'no-store' });
      setS(r.ok ? ((await r.json()) as Status) : null);
    } catch {
      /* server busy / restarting: keep the last state */
    }
  }, []);

  React.useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  if (!s?.singleFile) return null;

  async function saveNow() {
    setSaving(true);
    try {
      const r = await fetch('/api/company-file/save', { method: 'POST' });
      const d = (await r.json().catch(() => null)) as { status?: Status } | null;
      if (d?.status) setS(d.status);
    } finally {
      setSaving(false);
    }
  }

  const where = s.path ?? 'the company file';
  let icon: React.ReactNode;
  let label: string;
  let tone: string;
  let title: string;
  switch (s.status) {
    case 'saved':
      icon = <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />;
      label = 'Saved';
      tone = 'text-navy/45';
      title = `Saved to ${where}${s.lastSavedAt ? ` at ${timeOf(s.lastSavedAt)}` : ''}`;
      break;
    case 'unsaved':
    case 'saving':
      icon = <Loader2 className={cn('h-3.5 w-3.5', s.status === 'saving' && 'animate-spin')} aria-hidden />;
      label = s.status === 'saving' ? 'Saving…' : 'Saving soon';
      tone = 'text-navy/55';
      title = `Your latest changes are being saved to ${where}`;
      break;
    case 'lost':
      icon = <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
      label = 'Opened elsewhere';
      tone = 'text-red-600';
      title = s.error ?? 'This company file was opened on another computer.';
      break;
    default:
      icon = <AlertTriangle className="h-3.5 w-3.5" aria-hidden />;
      label = 'Not saved';
      tone = 'text-amber-600';
      title = s.error ?? 'The company file could not be saved.';
  }

  return (
    <div className={cn('relative app-no-drag', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-6 items-center gap-1.5 rounded-md px-2 text-xs outline-none hover:bg-navy/[.06] focus-visible:ring-2 focus-visible:ring-electric/50',
          tone,
        )}
        title={title}
        aria-label={`Company file: ${label}. ${title}`}
        aria-expanded={open}
      >
        {icon}
        <span>{label}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Company file"
          className="absolute right-0 top-8 z-[90] w-80 rounded-xl border border-slate-200 bg-white p-4 text-sm text-navy shadow-xl"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
        >
          <p className="font-semibold">{label}</p>
          <p className="mt-1 break-all font-mono text-[11px] text-navy/50">{s.path}</p>
          <p className="mt-2 text-navy/70">{title}</p>
          {s.conflictCopy && <p className="mt-2 break-all text-xs text-navy/60">Separate copy: {s.conflictCopy}</p>}
          <div className="mt-3 flex gap-2">
            {s.status !== 'lost' && (
              <button
                type="button"
                onClick={saveNow}
                disabled={saving}
                className="rounded-md bg-electric px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save now'}
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CompanyFileStatus;
