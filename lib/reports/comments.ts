/**
 * Commented Reports — pure helpers shared by the report viewer, the Commented Reports page and
 * the server (lib/services/commentedReports.ts). PURE module (client + server).
 */
import { reportToTable, type CellValue, type StdReport } from './types';

export interface ReportComment {
  id: string;
  /** The StdRow id the comment is on. */
  rowId: string;
  /** The column key of the commented amount. */
  columnKey: string;
  text: string;
}

/** Cell key → the comment numbers (1-based, in comment order) shown next to that cell. */
export function commentMarks(comments: ReportComment[]): Map<string, number[]> {
  const marks = new Map<string, number[]>();
  comments.forEach((c, i) => {
    const k = `${c.rowId}|${c.columnKey}`;
    marks.set(k, [...(marks.get(k) ?? []), i + 1]);
  });
  return marks;
}

/**
 * The export table of a commented report: every commented cell carries its "[n]" marks, and the
 * numbered comments follow the report under a "Comments" heading (CSV / Excel / PDF).
 */
export function commentedTable(report: StdReport, comments: ReportComment[]): { columns: { header: string; numeric?: boolean }[]; rows: CellValue[][] } {
  const marks = commentMarks(comments);
  const shown = report.rows.filter((r) => r.kind !== 'spacer');
  const t = reportToTable(report);
  const rows = t.rows.map((cells, ri) => {
    const row = shown[ri];
    return cells.map((v, ci) => {
      const m = marks.get(`${row.id}|${report.columns[ci].key}`);
      if (!m) return v;
      return `${v ?? ''} [${m.join(', ')}]`.trim();
    });
  });
  if (comments.length) {
    const blank = () => report.columns.map(() => null as CellValue);
    rows.push(blank());
    const head = blank();
    head[0] = 'Comments';
    rows.push(head);
    comments.forEach((c, i) => {
      const r = blank();
      r[0] = `[${i + 1}] ${c.text}`;
      rows.push(r);
    });
  }
  return { columns: t.columns, rows };
}
