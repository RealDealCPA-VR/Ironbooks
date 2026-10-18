'use client';

/**
 * Generic flat-table report page: optional date-range or as-of controls, the
 * shared export toolbar (CSV / Excel / PDF / Print / Email + column show/hide
 * + custom header), loading/error states, totals footer. Each concrete report
 * page just supplies columns + an endpoint builder. Underscore folder — not a
 * route.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Card, EmptyState, PageHeader, Spinner, Table, Th, Td, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import ReportToolbar, { type ExportTable } from './ReportToolbar';
import { AsOfControl, RangeControls, todayStr, yearStartStr, type CsvCell } from './shared';

export interface SimpleColumn<R> {
  header: string;
  /** Right-align + tabular-nums (money/qty columns). */
  numeric?: boolean;
  /** Extra classes for the body cell. */
  className?: string;
  cell: (row: R) => React.ReactNode;
  csv: (row: R) => CsvCell;
}

export interface SimpleReportProps<T, R> {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  csvName: string;
  emptyText: string;
  /** 'range' renders From/To, 'asof' renders a single As-of date, 'none' renders no controls. */
  controls: 'range' | 'asof' | 'none';
  /** Defaults for the range controls (fall back to fiscal-year start / today). */
  defaultFrom?: string;
  defaultTo?: string;
  buildUrl: (q: { from: string; to: string; asOf: string }) => string;
  getRows: (data: T) => R[];
  columns: SimpleColumn<R>[];
  /** Optional subtitle derived from the loaded report (e.g. period label). */
  subtitle?: (data: T) => string;
  /** Optional totals/footer rows: label + per-column CSV-able cells, rendered in tfoot. */
  footerRows?: (data: T) => { cells: CsvCell[]; emphasized?: boolean }[];
  /**
   * QuickZoom: where a row drills to (its first column and numeric cells become links), given the
   * report's current dates. Return null for rows without a drill-down.
   */
  rowHref?: (row: R, q: { from: string; to: string; asOf: string }) => string | null;
}

export default function SimpleReport<T, R>({
  title,
  icon,
  csvName,
  emptyText,
  controls,
  defaultFrom,
  defaultTo,
  buildUrl,
  getRows,
  columns,
  subtitle,
  footerRows,
  rowHref,
}: SimpleReportProps<T, R>) {
  const [from, setFrom] = useState(defaultFrom ?? yearStartStr());
  const [to, setTo] = useState(defaultTo ?? todayStr());
  const [asOf, setAsOf] = useState(todayStr());
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Hidden column headers (column show/hide picker in the toolbar). */
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<T>(buildUrl({ from, to, asOf }));
      setData(result);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : `Failed to load ${title}.`;
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, asOf, buildUrl, title]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = data ? getRows(data) : [];

  // Visible-column projection (indices into the full column list).
  const visibleIdx = columns
    .map((c, i) => (hidden.has(c.header) ? -1 : i))
    .filter((i) => i >= 0);
  const visibleColumns = visibleIdx.map((i) => columns[i]);

  const isNumeric = (c: SimpleColumn<R>) =>
    c.numeric || (c.className?.includes('text-right') ?? false);

  const table: ExportTable | null = data
    ? {
        filename: csvName.replace(/\.csv$/i, ''),
        title,
        subtitle: subtitle?.(data),
        columns: visibleColumns.map((c) => ({ header: c.header, numeric: isNumeric(c) })),
        rows: rows.map((r) => visibleIdx.map((i) => columns[i].csv(r))),
        totals: footerRows?.(data).map((f) => visibleIdx.map((i) => f.cells[i])),
      }
    : null;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title={title} icon={icon} />

      <ReportToolbar
        table={table}
        disabled={loading}
        columnPicker={columns.map((c) => ({
          key: c.header,
          label: c.header,
          visible: !hidden.has(c.header),
        }))}
        onToggleColumn={(key) =>
          setHidden((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            // Never allow hiding the last visible column.
            else if (next.size < columns.length - 1) next.add(key);
            return next;
          })
        }
      />

      {controls !== 'none' && (
        <Card className="p-4 mb-4 print-hidden">
          {controls === 'range' ? (
            <RangeControls from={from} to={to} onFrom={setFrom} onTo={setTo} onRun={load} />
          ) : (
            <AsOfControl asOf={asOf} onChange={setAsOf} onRun={load} />
          )}
        </Card>
      )}

      {data && subtitle && (
        <p className="text-sm text-navy/60 mb-3">{subtitle(data)}</p>
      )}

      <Card className="p-0 overflow-hidden">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-16 text-navy/50 text-sm">
            <Spinner className="text-electric" />
            Loading…
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && data && (
          <Table>
            <thead>
              <tr>
                {visibleColumns.map((c) => (
                  <Th key={c.header} numeric={c.numeric} className={c.className}>
                    {c.header}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.length}>
                    <EmptyState icon={icon} title={emptyText} />
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => {
                  const href = rowHref?.(row, { from, to, asOf }) ?? null;
                  return (
                    <Tr key={i}>
                      {visibleColumns.map((c, ci) => (
                        <Td key={c.header} numeric={c.numeric} className={c.className}>
                          {href && (ci === 0 || c.numeric) ? (
                            <Link href={href} className="hover:text-electric hover:underline" title="QuickZoom: see the detail">
                              {c.cell(row)}
                            </Link>
                          ) : (
                            c.cell(row)
                          )}
                        </Td>
                      ))}
                    </Tr>
                  );
                })
              )}
            </tbody>
            {rows.length > 0 && footerRows && (
              <tfoot>
                {footerRows(data).map((f, i) => (
                  <tr
                    key={i}
                    className={
                      f.emphasized
                        ? 'border-t-2 border-navy/20 bg-navy/5 font-bold text-navy'
                        : 'border-t border-navy/10 font-semibold text-navy/80'
                    }
                  >
                    {visibleIdx.map((colIdx) => (
                      <td
                        key={colIdx}
                        className={`py-3 px-4 ${isNumeric(columns[colIdx]) ? 'text-right tabular-nums' : ''}`}
                      >
                        {f.cells[colIdx]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tfoot>
            )}
          </Table>
        )}
      </Card>
    </main>
  );
}
