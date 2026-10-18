'use client';
/**
 * Appearance controls, macOS style: Light / Dark / Auto with a small preview of each, and the
 * accent color swatches. Used in the toolbar popover (AppearanceButton) and in
 * Preferences > Appearance. Changes apply at once (lib/useTheme.ts).
 */
import * as React from 'react';
import { Check, Moon, Sun, SunMoon } from 'lucide-react';
import { ACCENTS, type ThemeMode } from '@/lib/theme';
import { currentTheme, useTheme } from '@/lib/useTheme';
import { cn } from '@/lib/utils';

const MODE_OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
  { mode: 'system', label: 'Auto' },
];

/** A miniature window in the given scheme ("Auto" shows both halves). */
function ModePreview({ mode }: { mode: ThemeMode }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex h-full flex-1 flex-col gap-1 p-1.5', dark ? 'bg-[#1e1e20]' : 'bg-[#f5f5f7]')}>
      <div className={cn('h-1.5 w-8 rounded-full', dark ? 'bg-white/25' : 'bg-black/15')} />
      <div className={cn('flex-1 rounded-[4px] shadow-sm', dark ? 'bg-[#2c2c2e]' : 'bg-[#ffffff]')}>
        <div className="m-1 h-1.5 w-6 rounded-full bg-electric" />
      </div>
    </div>
  );
  return (
    <div className="flex h-14 w-[88px] overflow-hidden rounded-lg border border-slate-200">
      {mode === 'light' && pane(false)}
      {mode === 'dark' && pane(true)}
      {mode === 'system' && (
        <>
          {pane(false)}
          {pane(true)}
        </>
      )}
    </div>
  );
}

export function AppearanceControls({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useTheme();
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-xs font-medium text-navy/50" id="appearance-mode-label">
          Appearance
        </div>
        <div role="radiogroup" aria-labelledby="appearance-mode-label" className="flex gap-3">
          {MODE_OPTIONS.map((o) => {
            const selected = theme.mode === o.mode;
            return (
              <button
                key={o.mode}
                type="button"
                role="radio"
                aria-checked={selected}
                data-theme-mode={o.mode}
                onClick={() => setTheme({ ...currentTheme(), mode: o.mode })}
                className="group flex flex-col items-center gap-1.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
              >
                <span
                  className={cn(
                    'rounded-[10px] p-0.5 ring-2 transition',
                    selected ? 'ring-electric' : 'ring-transparent group-hover:ring-slate-300',
                  )}
                >
                  {compact ? (
                    <span className="flex h-9 w-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-navy/70">
                      {o.mode === 'light' ? <Sun className="h-4 w-4" /> : o.mode === 'dark' ? <Moon className="h-4 w-4" /> : <SunMoon className="h-4 w-4" />}
                    </span>
                  ) : (
                    <ModePreview mode={o.mode} />
                  )}
                </span>
                <span className={cn('text-xs', selected ? 'font-semibold text-navy' : 'text-navy/60')}>{o.label}</span>
              </button>
            );
          })}
        </div>
        {!compact && (
          <p className="mt-2 text-xs text-navy/45">Auto follows your computer&rsquo;s light or dark setting.</p>
        )}
      </div>
      <div>
        <div className="mb-2 text-xs font-medium text-navy/50" id="appearance-accent-label">
          Accent color
        </div>
        <div role="radiogroup" aria-labelledby="appearance-accent-label" className="flex flex-wrap items-center gap-2.5">
          {ACCENTS.map((a) => {
            const selected = theme.accent === a.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={a.label}
                title={a.label}
                data-accent-choice={a.id}
                onClick={() => setTheme({ ...currentTheme(), accent: a.id })}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full outline-none ring-offset-2 ring-offset-white transition focus-visible:ring-2 focus-visible:ring-electric/60',
                  selected && 'ring-2 ring-slate-300',
                )}
                style={{ background: a.swatch, boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.12)' }}
              >
                {selected && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Toolbar button: the current scheme's icon; opens the appearance popover. */
export function AppearanceButton() {
  const [theme] = useTheme();
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const Icon = theme.mode === 'light' ? Sun : theme.mode === 'dark' ? Moon : SunMoon;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Appearance"
        title="Appearance: light, dark or auto, and the accent color"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-navy/70 shadow-sm transition-colors hover:text-electric outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
      >
        <Icon className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Appearance"
          className="absolute right-0 z-50 mt-2 w-80 rounded-2xl border border-slate-200/80 bg-white/95 p-4 shadow-2xl backdrop-blur-xl"
        >
          <AppearanceControls compact />
        </div>
      )}
    </div>
  );
}
