'use client';

/**
 * Commented Reports (QB "Comment on Report"): the numbered comment list under a report and the
 * dialog that writes one comment on one amount. Used by the report viewer (StdReportView, while
 * commenting) and by the Commented Reports page (app/reports/commented).
 */
import { useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button, Label, Modal } from '@/components/ui';
import type { ReportComment } from '@/lib/reports/comments';
import type { StdColumn, StdReport, StdRow } from '@/lib/reports/types';

export const MAX_COMMENT_LENGTH = 2000;

/** What a comment points at, in words: "Office Supplies, TOTAL". */
export function commentLabel(report: StdReport, c: Pick<ReportComment, 'rowId' | 'columnKey'>): string {
  const row = report.rows.find((r) => r.id === c.rowId);
  const col = report.columns.find((k) => k.key === c.columnKey);
  const first = report.columns[0]?.key;
  const name = row ? String(row.cells[first] ?? row.cells.label ?? row.cells.name ?? '').trim() : '';
  return [name || '(line)', col?.header || ''].filter(Boolean).join(', ');
}

/** Write or change one comment (on the amount at `row` / `column`). */
export function CommentDialog({
  open,
  target,
  initialText,
  onClose,
  onSave,
}: {
  open: boolean;
  /** The amount being commented on, in words. */
  target: string;
  initialText?: string;
  onClose: () => void;
  onSave: (text: string) => void;
}) {
  const [text, setText] = useState(initialText ?? '');
  useEffect(() => {
    if (open) setText(initialText ?? '');
  }, [open, initialText]);
  const trimmed = text.trim();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Comment on this amount"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(trimmed)} disabled={!trimmed || trimmed.length > MAX_COMMENT_LENGTH}>
            Save comment
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/60 mb-3">{target}</p>
      <Label htmlFor="report-comment-text">Comment</Label>
      <textarea
        id="report-comment-text"
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-4 focus:ring-electric/20"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={MAX_COMMENT_LENGTH}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && trimmed) {
            e.preventDefault();
            onSave(trimmed);
          }
        }}
      />
      <p className="text-xs text-navy/40 mt-1">Ctrl+Enter saves. The number of the comment appears next to the amount.</p>
    </Modal>
  );
}

/** The numbered comments under the report, with Edit / Delete while editing. */
export function CommentList({
  report,
  comments,
  onEdit,
  onDelete,
}: {
  report: StdReport;
  comments: ReportComment[];
  onEdit?: (index: number) => void;
  onDelete?: (index: number) => void;
}) {
  if (!comments.length) return null;
  return (
    <section aria-label="Comments" className="mt-4">
      <h2 className="text-sm font-semibold text-navy mb-2">Comments</h2>
      <ol className="space-y-2">
        {comments.map((c, i) => (
          <li key={c.id} className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <span className="font-semibold text-electric tabular-nums">[{i + 1}]</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-navy/50">{commentLabel(report, c)}</p>
              <p className="whitespace-pre-wrap text-navy">{c.text}</p>
            </div>
            {(onEdit || onDelete) && (
              <div className="flex gap-1 print-hidden">
                {onEdit && (
                  <Button variant="ghost" size="sm" onClick={() => onEdit(i)} aria-label={`Edit comment ${i + 1}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                {onDelete && (
                  <Button variant="ghost" size="sm" onClick={() => onDelete(i)} aria-label={`Delete comment ${i + 1}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Comment editing state shared by the viewer and the Commented Reports page: which amount the
 * dialog is open on (a new comment) or which comment is being changed.
 */
export function useCommentEditing(comments: ReportComment[], setComments: (next: ReportComment[]) => void) {
  const [adding, setAdding] = useState<{ row: StdRow; column: StdColumn } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const newId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    adding,
    editing,
    startAdd: (row: StdRow, column: StdColumn) => setAdding({ row, column }),
    startEdit: (i: number) => setEditing(i),
    remove: (i: number) => setComments(comments.filter((_, j) => j !== i)),
    close: () => {
      setAdding(null);
      setEditing(null);
    },
    save: (text: string) => {
      if (adding) setComments([...comments, { id: newId(), rowId: adding.row.id, columnKey: adding.column.key, text }]);
      else if (editing !== null) setComments(comments.map((c, j) => (j === editing ? { ...c, text } : c)));
      setAdding(null);
      setEditing(null);
    },
  };
}
