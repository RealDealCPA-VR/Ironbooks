'use client';

/**
 * Shared client-side plumbing for the report pages: CSV download, date
 * formatting, and the common date-range / as-of toolbars. Lives in an
 * underscore folder so Next.js does not treat it as a route.
 */
import { Button, Input, Label } from '@/components/ui';
import { formatShortDate } from '@/lib/format';
import { todayISO } from '@/lib/dates';

// ---------------------------------------------------------------------------
// CSV download
// ---------------------------------------------------------------------------

export type CsvCell = string | number | null | undefined;

/** Build a CSV (title line + header + rows) and trigger a browser download. */
export function downloadCsv(filename: string, title: string, headers: string[], rows: CsvCell[][]) {
  const escape = (v: CsvCell) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    `"${title.replace(/"/g, '""')}"`,
    '',
    headers.map(escape).join(','),
    ...rows.map((row) => row.map(escape).join(',')),
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Format an API date as a short US date, e.g. "6/9/2026" ('' for null). Calendar days sent as
 * UTC midnight show as the day they name (lib/format.ts); real timestamps in local time.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return formatShortDate(iso);
}

/** Today as a YYYY-MM-DD input value (local time). */
export function todayStr(): string {
  return todayISO();
}

/** Jan 1 of the current year as a YYYY-MM-DD input value. */
export function yearStartStr(): string {
  return `${new Date().getFullYear()}-01-01`;
}

// ---------------------------------------------------------------------------
// Toolbars
// ---------------------------------------------------------------------------

export function RangeControls({
  from,
  to,
  onFrom,
  onTo,
  onRun,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  onRun: () => void;
}) {
  return (
    <form
      className="flex items-end gap-3 flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        onRun();
      }}
    >
      <div>
        <Label htmlFor="report-from">From</Label>
        <Input id="report-from" type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="report-to">To</Label>
        <Input id="report-to" type="date" value={to} onChange={(e) => onTo(e.target.value)} />
      </div>
      <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
        Run Report
      </Button>
    </form>
  );
}

export function AsOfControl({
  asOf,
  onChange,
  onRun,
}: {
  asOf: string;
  onChange: (v: string) => void;
  onRun: () => void;
}) {
  return (
    <form
      className="flex items-end gap-3 flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        onRun();
      }}
    >
      <div>
        <Label htmlFor="report-asof">As of</Label>
        <Input id="report-asof" type="date" value={asOf} onChange={(e) => onChange(e.target.value)} />
      </div>
      <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
        Run Report
      </Button>
    </form>
  );
}
