'use client';

/**
 * Commented Reports (QB Reports > Commented Reports): reports saved with comments on their
 * amounts. Each one is a picture of the report as it was when it was commented (it does not
 * change when the books do), so it can be printed, exported or discussed later exactly as it was.
 *  - The list: open, rename or delete a commented report.
 *  - One report (?id=): the report with its numbered comments; add, change or delete comments,
 *    export (CSV / Excel / PDF — the comments follow the report), print, or run the report again.
 * Comments are added on a report from its "Comment on report" button (StdReportView).
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, MessageSquare, Pencil, Play, Trash2, Type } from 'lucide-react';
import { Button, Card, ConfirmDialog, EmptyState, Input, Label, Modal, PageHeader, Spinner, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { stdReportHref } from '@/lib/reports/catalog';
import { commentMarks, commentedTable, type ReportComment } from '@/lib/reports/comments';
import type { StdReport } from '@/lib/reports/types';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';
import StdReportTable, { useCollapse } from '../_components/StdReportTable';
import NumberFormatPanel, { useNumberFormat } from '../_components/NumberFormatPanel';
import { CommentDialog, CommentList, commentLabel, useCommentEditing } from '../_components/ReportComments';

interface ListRow {
  id: string;
  name: string;
  reportType: string;
  reportTitle: string;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Detail {
  id: string;
  name: string;
  reportType: string;
  params: Record<string, string>;
  snapshot: StdReport;
  comments: ReportComment[];
  createdAt: string;
  updatedAt: string;
}

const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export default function CommentedReportsPage() {
  return (
    <Suspense fallback={null}>
      <CommentedReports />
    </Suspense>
  );
}

function CommentedReports() {
  const search = useSearchParams();
  const id = search?.get('id') ?? null;
  return id ? <CommentedReportView id={id} /> : <CommentedReportList />;
}

function RenameDialog({ open, name, onClose, onSave }: { open: boolean; name: string; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(name);
  }, [open, name]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Rename commented report"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!value.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(value.trim());
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Label htmlFor="commented-rename">Name</Label>
      <Input id="commented-rename" value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={255} />
    </Modal>
  );
}

function CommentedReportList() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState<ListRow | null>(null);
  const [deleting, setDeleting] = useState<ListRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<ListRow[]>('/api/commented-reports'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the commented reports.', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Commented Reports" icon={MessageSquare} />
      <p className="text-sm text-navy/60 -mt-4 mb-4">
        Reports saved with your comments on their amounts. Each one stays exactly as it was when you commented it. To comment on a report, open it and
        click <strong>Comment on report</strong>.
      </p>
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-navy/50 text-sm">
            <Spinner className="text-electric" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No commented reports yet"
            message="Open any report from the Report Center, click Comment on report, click the amounts you want to explain, then save."
            action={
              <Link href="/reports" className="text-electric hover:underline text-sm">
                Open the Report Center
              </Link>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Report</Th>
                <Th className="text-right">Comments</Th>
                <Th>Saved</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <Link href={`/reports/commented?id=${r.id}`} className="text-electric hover:underline font-medium">
                      {r.name}
                    </Link>
                  </Td>
                  <Td className="text-navy/70">{r.reportTitle}</Td>
                  <Td className="text-right tabular-nums">{r.commentCount}</Td>
                  <Td className="text-navy/60 text-sm">{fmtWhen(r.updatedAt)}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(r)} aria-label={`Rename ${r.name}`}>
                      <Pencil className="h-3.5 w-3.5" /> Rename
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <RenameDialog
        open={!!renaming}
        name={renaming?.name ?? ''}
        onClose={() => setRenaming(null)}
        onSave={async (name) => {
          try {
            await api.patch(`/api/commented-reports/${renaming!.id}`, { name });
            toast('Renamed.', 'success');
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not rename it.', 'danger');
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete commented report?"
        message={`"${deleting?.name ?? ''}" and its comments will be deleted. The report itself is not affected.`}
        confirmLabel="Delete"
        tone="danger"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.del(`/api/commented-reports/${deleting!.id}`);
            toast('Commented report deleted.', 'success');
            setDeleting(null);
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not delete it.', 'danger');
          }
        }}
      />
    </main>
  );
}

function CommentedReportView({ id }: { id: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReportComment[]>([]);
  const [commenting, setCommenting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [format, setFormat] = useNumberFormat();
  const report = detail?.snapshot ?? null;
  const { collapsed, toggle } = useCollapse(report);
  const edit = useCommentEditing(comments, setComments);
  const marks = useMemo(() => commentMarks(comments), [comments]);
  const dirty = !!detail && JSON.stringify(detail.comments) !== JSON.stringify(comments);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .get<Detail>(`/api/commented-reports/${encodeURIComponent(id)}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setComments(d.comments);
      })
      .catch((err) => live && setError(err instanceof ApiError ? err.message : 'Could not open the commented report.'));
    return () => {
      live = false;
    };
  }, [id]);

  const table: ExportTable | null = useMemo(() => {
    if (!detail) return null;
    const t = commentedTable(detail.snapshot, comments);
    return { filename: detail.name, title: detail.name, subtitle: [detail.snapshot.title, detail.snapshot.subtitle].filter(Boolean).join(' — '), columns: t.columns, rows: t.rows };
  }, [detail, comments]);

  const saveComments = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const d = await api.patch<Detail>(`/api/commented-reports/${detail.id}`, { comments });
      setDetail(d);
      setComments(d.comments);
      setCommenting(false);
      toast('Comments saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the comments.', 'danger');
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <main className="min-h-screen bg-offwhite p-8 font-sans">
        <PageHeader title="Commented Report" icon={MessageSquare} />
        <EmptyState
          title="Commented report not found"
          message={error}
          action={
            <Link href="/reports/commented" className="text-electric hover:underline text-sm">
              Back to Commented Reports
            </Link>
          }
        />
      </main>
    );
  }
  if (!detail || !report) {
    return (
      <main className="min-h-screen bg-offwhite p-8 font-sans flex items-center justify-center gap-2 text-navy/50 text-sm">
        <Spinner className="text-electric" /> Loading…
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title={detail.name} icon={MessageSquare} action={<span className="text-sm text-navy/60">{[report.title, report.subtitle].filter(Boolean).join(' · ')}</span>} />
      <div className="-mt-4 mb-4 flex flex-wrap items-center gap-3 text-sm print-hidden">
        <Link href="/reports/commented" className="inline-flex items-center gap-1 text-electric hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Commented Reports
        </Link>
        <span className="text-navy/50">Saved {fmtWhen(detail.createdAt)} — the numbers are as they were then.</span>
        <Link href={stdReportHref(detail.reportType, detail.params)} className="inline-flex items-center gap-1 text-electric hover:underline">
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> Run this report again
        </Link>
      </div>

      <ReportToolbar table={table} />

      <Card className="p-4 mb-4 print-hidden">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={commenting ? 'primary' : 'secondary'} onClick={() => setCommenting(!commenting)} aria-pressed={commenting}>
            <MessageSquare className="h-4 w-4" />
            {commenting ? 'Done adding comments' : 'Add comments'}
          </Button>
          {dirty && (
            <>
              <Button size="sm" loading={saving} onClick={saveComments}>
                Save comments
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setComments(detail.comments)}>
                Undo changes
              </Button>
            </>
          )}
          <Button size="sm" variant="secondary" onClick={() => setFormatOpen(!formatOpen)} aria-expanded={formatOpen}>
            <Type className="h-4 w-4" /> Fonts &amp; numbers
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRenaming(true)}>
            <Pencil className="h-4 w-4" /> Rename
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDeleting(true)}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
        {commenting && <p className="mt-2 text-sm text-navy/60">Click (or tab to and press Enter on) an amount to comment on it, then Save comments.</p>}
        {formatOpen && (
          <div className="mt-3">
            <NumberFormatPanel format={format} onChange={setFormat} />
          </div>
        )}
      </Card>

      <Card className="p-0 overflow-hidden">
        <StdReportTable report={report} format={format} collapsed={collapsed} onToggle={toggle} marks={marks} onComment={commenting ? edit.startAdd : undefined} />
      </Card>
      <CommentList report={report} comments={comments} onEdit={edit.startEdit} onDelete={edit.remove} />
      {report.notes?.map((n) => (
        <p key={n} className="text-xs text-navy/50 mt-2">
          {n}
        </p>
      ))}

      <CommentDialog
        open={!!edit.adding || edit.editing !== null}
        target={
          edit.adding
            ? commentLabel(report, { rowId: edit.adding.row.id, columnKey: edit.adding.column.key })
            : edit.editing !== null && comments[edit.editing]
              ? commentLabel(report, comments[edit.editing])
              : ''
        }
        initialText={edit.editing !== null ? comments[edit.editing]?.text : ''}
        onClose={edit.close}
        onSave={edit.save}
      />
      <RenameDialog
        open={renaming}
        name={detail.name}
        onClose={() => setRenaming(false)}
        onSave={async (name) => {
          try {
            const d = await api.patch<Detail>(`/api/commented-reports/${detail.id}`, { name });
            setDetail({ ...detail, name: d.name, updatedAt: d.updatedAt });
            toast('Renamed.', 'success');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not rename it.', 'danger');
            throw err;
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        title="Delete commented report?"
        message={`"${detail.name}" and its comments will be deleted. The report itself is not affected.`}
        confirmLabel="Delete"
        tone="danger"
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          try {
            await api.del(`/api/commented-reports/${detail.id}`);
            toast('Commented report deleted.', 'success');
            router.push('/reports/commented');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not delete it.', 'danger');
          }
        }}
      />
    </main>
  );
}
