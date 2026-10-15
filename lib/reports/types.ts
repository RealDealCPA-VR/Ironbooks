/**
 * Standard report shape shared by the report engine (lib/services/reportsStandard.ts and
 * friends), the report API (/api/reports/std/[report]) and the generic report viewer
 * (app/reports/_components/StdReportView.tsx).
 *
 * PURE module — no Node / DB imports — so the client can import the types and helpers.
 *
 * A report is a list of columns plus a flat list of rows. Rows carry a depth (indent) and an
 * optional parentId so the viewer can collapse / expand sub-account roll-ups and grouped detail
 * (QB "Collapse Rows"). Money cells are 2dp decimal strings (never floats); the viewer formats
 * them with the user's number-format preferences (lib/reports/format.ts).
 */

export type CellValue = string | number | null;

export type ColumnType = 'money' | 'number' | 'percent' | 'text' | 'date';

export interface StdColumn {
  key: string;
  header: string;
  type?: ColumnType;
}

export type StdRowKind =
  /** A heading row (section title or a parent account / group header). */
  | 'section'
  /** An ordinary data row (one account, one transaction, one name …). */
  | 'data'
  /** "Total <Parent>" / group subtotal. */
  | 'subtotal'
  /** Section total ("Total Income", "TOTAL ASSETS" …). */
  | 'total'
  /** The bottom line (Net Income, grand totals). */
  | 'grand'
  /** Blank spacer row. */
  | 'spacer';

export interface StdRow {
  /** Stable id (used for collapse state). */
  id: string;
  /** Id of the heading row this row is nested under (collapse hides it). */
  parentId?: string | null;
  depth: number;
  kind: StdRowKind;
  cells: Record<string, CellValue>;
  /**
   * For a heading row that has a matching "Total …" row: the totals to show ON the heading when
   * the group is collapsed (QB shows the parent with its rolled-up amount).
   */
  collapsedCells?: Record<string, CellValue>;
  /**
   * What a collapsible heading groups: 'account' (sub-account roll-up), 'group' (subtotal-by
   * group in a detail report) or 'section' (statement section). The toolbar's Collapse Rows
   * button folds 'account' and 'group' headings; sections fold only one at a time.
   */
  collapseKind?: 'account' | 'group' | 'section';
  /** For a subtotal row: the heading row id it totals (hidden while that heading is collapsed). */
  totalOf?: string;
  /** QuickZoom target for the whole row (a report or page URL). */
  href?: string | null;
  /** QuickZoom targets for individual cells (column key → URL). */
  hrefs?: Record<string, string>;
  /** Transaction rows: the journal entry to open in the QuickZoom transaction view. */
  entryId?: string | null;
}

export interface StdReport {
  key: string;
  title: string;
  subtitle?: string;
  columns: StdColumn[];
  rows: StdRow[];
  /** Balance-sheet / trial-balance style reports: did the ledger check pass? */
  balanced?: boolean;
  /** True when a row cap cut the report short. */
  truncated?: boolean;
  /** Plain-language notes shown under the report. */
  notes?: string[];
  /** Reports offered on both bases: the basis this run used (set by runStandardReport). */
  basis?: 'accrual' | 'cash';
  /**
   * The dates this run actually covered (set by runStandardReport after relative "Dates"
   * presets and defaults are resolved), as YYYY-MM-DD: `from`..`to` for period reports,
   * `asOf` for point-in-time reports. Used by "Why did this change?" to explain the same number.
   */
  range?: { from: string; to: string; asOf: string };
}

/** Flatten a report into an export table (labels indented with spaces by depth). */
export function reportToTable(report: StdReport): {
  columns: { header: string; numeric?: boolean }[];
  rows: CellValue[][];
} {
  const columns = report.columns.map((c) => ({
    header: c.header,
    numeric: c.type === 'money' || c.type === 'number' || c.type === 'percent',
  }));
  const rows = report.rows
    .filter((r) => r.kind !== 'spacer')
    .map((r) =>
      report.columns.map((c, i) => {
        const v = r.cells[c.key] ?? null;
        if (i === 0 && typeof v === 'string') return `${'  '.repeat(Math.max(0, r.depth))}${v}`;
        return v;
      }),
    );
  return { columns, rows };
}

/** Build the CSV text for a report (title line, blank line, header, rows). */
export function reportToCsv(report: StdReport): string {
  const t = reportToTable(report);
  const esc = (v: CellValue) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const title = report.subtitle ? `${report.title} — ${report.subtitle}` : report.title;
  return [
    esc(title),
    '',
    t.columns.map((c) => esc(c.header)).join(','),
    ...t.rows.map((r) => r.map(esc).join(',')),
  ].join('\r\n');
}
