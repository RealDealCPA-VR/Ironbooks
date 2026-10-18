'use client';

/**
 * Shared report toolbar — one component gives every report page identical
 * Export CSV / Excel / PDF / Print / Email controls plus customization:
 *  - custom report header & subtitle (per-run, applied on screen, in print and
 *    in every export format)
 *  - optional column show/hide picker
 *  - optional accrual/cash basis toggle
 *
 * CSV is built client-side; Excel and PDF post the current table to
 * POST /api/export/reports (server renders via lib/export). Print uses
 * window.print() with the @media print rules in app/reports/print.css.
 * Email opens a mailto draft (attach the exported file manually — the desktop
 * app has no SMTP relay).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Columns3,
  FileDown,
  FileSpreadsheet,
  FileText,
  Mail,
  Printer,
  Settings2,
} from 'lucide-react';
import { Button, Input, Label, toast } from '@/components/ui';
import { downloadCsv, type CsvCell } from './shared';

export interface ExportColumn {
  header: string;
  numeric?: boolean;
}

/** The currently rendered report as a flat exportable table. */
export interface ExportTable {
  /** Download base name, no extension (e.g. 'profit-loss'). */
  filename: string;
  title: string;
  subtitle?: string;
  columns: ExportColumn[];
  rows: CsvCell[][];
  /** Footer/totals rows (rendered bold in PDF, appended in CSV/Excel). */
  totals?: CsvCell[][];
  /** Force PDF orientation (defaults to landscape when > 6 columns). */
  landscape?: boolean;
}

export interface ColumnToggle {
  key: string;
  label: string;
  visible: boolean;
}

export default function ReportToolbar({
  table,
  disabled,
  basis,
  basisNav,
  columnPicker,
  onToggleColumn,
  className,
}: {
  /** Null while the report is still loading — buttons disable themselves. */
  table: ExportTable | null;
  disabled?: boolean;
  /** Accrual/cash toggle, only for reports with a cash-basis variant. */
  basis?: { value: 'accrual' | 'cash'; onChange: (value: 'accrual' | 'cash') => void };
  /**
   * Serializable variant of `basis` for server-rendered pages: navigates to the
   * accrual/cash sibling report instead of invoking a callback.
   */
  basisNav?: { value: 'accrual' | 'cash'; accrualHref: string; cashHref: string };
  /** Column show/hide picker entries (controlled by the page). */
  columnPicker?: ColumnToggle[];
  onToggleColumn?: (key: string) => void;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'xlsx' | 'pdf' | null>(null);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [customSubtitle, setCustomSubtitle] = useState('');

  const off = disabled || !table;
  const effTitle = (t: ExportTable) => customTitle.trim() || t.title;
  const effSubtitle = (t: ExportTable) => customSubtitle.trim() || t.subtitle || '';

  const exportCsv = () => {
    if (!table) return;
    const sub = effSubtitle(table);
    downloadCsv(
      `${table.filename}.csv`,
      sub ? `${effTitle(table)} — ${sub}` : effTitle(table),
      table.columns.map((c) => c.header),
      [...table.rows, ...(table.totals ?? [])],
    );
  };

  const exportFile = async (format: 'xlsx' | 'pdf') => {
    if (!table) return;
    setBusy(format);
    try {
      const res = await fetch('/api/export/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          filename: table.filename,
          title: effTitle(table),
          subtitle: effSubtitle(table) || undefined,
          columns: table.columns,
          rows: table.rows,
          totals: table.totals,
          landscape: table.landscape,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `${format.toUpperCase()} export failed.`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${table.filename}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err instanceof Error ? err.message : `${format.toUpperCase()} export failed.`, 'danger');
    } finally {
      setBusy(null);
    }
  };

  const emailReport = () => {
    if (!table) return;
    const subject = encodeURIComponent(effTitle(table));
    const body = encodeURIComponent(
      `${effTitle(table)}${effSubtitle(table) ? ` (${effSubtitle(table)})` : ''}\n\n` +
        'Export the report from Ironbooks (CSV, Excel or PDF) and attach the downloaded file to this email.',
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  return (
    <>
      {/* Custom header is NOT print-hidden — it shows on screen and on paper. */}
      {(customTitle.trim() || customSubtitle.trim()) && (
        <div className="mb-3">
          {customTitle.trim() && (
            <div className="text-lg font-bold text-navy">{customTitle.trim()}</div>
          )}
          {customSubtitle.trim() && (
            <div className="text-sm text-navy/60">{customSubtitle.trim()}</div>
          )}
        </div>
      )}

      <div className={`print-hidden mb-4 ${className ?? ''}`}>
        <div className="flex items-center gap-2 flex-wrap">
          {basisNav && (
            <div className="flex rounded-lg border border-slate-200 overflow-hidden mr-1" role="group" aria-label="Report basis">
              {(['accrual', 'cash'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() =>
                    b !== basisNav.value &&
                    router.push(b === 'accrual' ? basisNav.accrualHref : basisNav.cashHref)
                  }
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    basisNav.value === b
                      ? 'bg-electric text-white'
                      : 'bg-white text-navy/60 hover:bg-electric/5'
                  }`}
                >
                  {b === 'accrual' ? 'Accrual' : 'Cash'}
                </button>
              ))}
            </div>
          )}
          {basis && (
            <div className="flex rounded-lg border border-slate-200 overflow-hidden mr-1" role="group" aria-label="Report basis">
              {(['accrual', 'cash'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => basis.onChange(b)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    basis.value === b
                      ? 'bg-electric text-white'
                      : 'bg-white text-navy/60 hover:bg-electric/5'
                  }`}
                >
                  {b === 'accrual' ? 'Accrual' : 'Cash'}
                </button>
              ))}
            </div>
          )}

          <Button variant="secondary" size="sm" disabled={off} onClick={exportCsv}>
            <FileDown className="h-4 w-4" />
            CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={off}
            loading={busy === 'xlsx'}
            onClick={() => exportFile('xlsx')}
          >
            <FileSpreadsheet className="h-4 w-4" />
            Excel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={off}
            loading={busy === 'pdf'}
            onClick={() => exportFile('pdf')}
          >
            <FileText className="h-4 w-4" />
            PDF
          </Button>
          <Button variant="secondary" size="sm" disabled={off} onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Print
          </Button>
          <Button variant="secondary" size="sm" disabled={off} onClick={emailReport}>
            <Mail className="h-4 w-4" />
            Email
          </Button>

          {columnPicker && columnPicker.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setShowColumns((v) => !v);
                setShowCustomize(false);
              }}
            >
              <Columns3 className="h-4 w-4" />
              Columns
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowCustomize((v) => !v);
              setShowColumns(false);
            }}
          >
            <Settings2 className="h-4 w-4" />
            Customize
          </Button>
        </div>

        {showColumns && columnPicker && (
          <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3 flex flex-wrap gap-x-5 gap-y-2 max-w-2xl shadow-sm">
            {columnPicker.map((col) => (
              <label key={col.key} className="flex items-center gap-1.5 text-sm text-navy cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={col.visible}
                  onChange={() => onToggleColumn?.(col.key)}
                  className="accent-electric"
                />
                {col.label}
              </label>
            ))}
          </div>
        )}

        {showCustomize && (
          <div className="mt-2 rounded-xl border border-slate-200 bg-white p-3 flex items-end gap-3 flex-wrap max-w-2xl shadow-sm">
            <div className="min-w-[220px]">
              <Label htmlFor="report-custom-title">Report header</Label>
              <Input
                id="report-custom-title"
                placeholder={table?.title ?? 'Custom header'}
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
              />
            </div>
            <div className="min-w-[220px]">
              <Label htmlFor="report-custom-subtitle">Subtitle</Label>
              <Input
                id="report-custom-subtitle"
                placeholder={table?.subtitle ?? 'Custom subtitle'}
                value={customSubtitle}
                onChange={(e) => setCustomSubtitle(e.target.value)}
              />
            </div>
            <p className="text-xs text-navy/40 mb-2 basis-full">
              Applied to the printed page and to CSV / Excel / PDF exports for this run.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
