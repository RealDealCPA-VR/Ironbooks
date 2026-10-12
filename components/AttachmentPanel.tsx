'use client';
/**
 * <AttachmentPanel entityType="invoice" entityId={id} /> — attach files to any record.
 *
 * Drop files onto the panel (or click "Add files"), pick a document already waiting in the Doc
 * Center inbox, download, or remove. Files are stored locally in the company file
 * (lib/services/attachments.ts); nothing is uploaded anywhere else.
 *
 * Drop it into a form/detail view with one line. Before the record is saved (no id yet) it shows
 * a short hint instead.
 */
import * as React from 'react';
import { Download, FileUp, Inbox, Paperclip, Trash2 } from 'lucide-react';
import { Button, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { cn } from '@/lib/utils';

export interface AttachmentInfo {
  id: string;
  entityType: string | null;
  entityId: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  description?: string | null;
  createdAt: string;
}

/** 25 MB — mirrors MAX_ATTACHMENT_BYTES in lib/services/attachments.ts. */
const MAX_BYTES = 25 * 1024 * 1024;

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a File as base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** Upload files (to a record, or to the inbox when entity is null). Returns the saved rows. */
export async function uploadFiles(
  files: File[],
  entity: { entityType: string; entityId: string } | null,
): Promise<AttachmentInfo[]> {
  const saved: AttachmentInfo[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      toast(`${file.name} is larger than 25 MB and was skipped.`, 'danger');
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      saved.push(
        await api.post<AttachmentInfo>('/api/attachments', {
          ...(entity ?? {}),
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64,
        }),
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Could not attach ${file.name}`, 'danger');
    }
  }
  return saved;
}

export default function AttachmentPanel({
  entityType,
  entityId,
  className,
  title = 'Attachments',
}: {
  entityType: string;
  entityId: string | null | undefined;
  className?: string;
  title?: string;
}) {
  const [items, setItems] = React.useState<AttachmentInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [inbox, setInbox] = React.useState<AttachmentInfo[] | null>(null);
  const [inboxPick, setInboxPick] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      setItems(
        await api.get<AttachmentInfo[]>(
          `/api/attachments?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`,
        ),
      );
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function addFiles(files: File[]) {
    if (!entityId || files.length === 0) return;
    setBusy(true);
    const saved = await uploadFiles(files, { entityType, entityId });
    setBusy(false);
    if (saved.length) {
      toast(`Attached ${saved.length} file${saved.length === 1 ? '' : 's'}`, 'success');
      await load();
    }
  }

  async function remove(a: AttachmentInfo) {
    if (!window.confirm(`Remove ${a.filename}? The file is deleted from the company file.`)) return;
    try {
      await api.del(`/api/attachments/${a.id}`);
      setItems((prev) => prev.filter((x) => x.id !== a.id));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove the file', 'danger');
    }
  }

  async function openInbox() {
    try {
      setInbox(await api.get<AttachmentInfo[]>('/api/attachments?unfiled=1'));
    } catch {
      setInbox([]);
    }
  }

  async function attachFromInbox() {
    if (!inboxPick || !entityId) return;
    try {
      await api.patch(`/api/attachments/${inboxPick}`, { entityType, entityId });
      setInbox(null);
      setInboxPick('');
      await load();
      toast('Attached from the Doc Center', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not attach the document', 'danger');
    }
  }

  if (!entityId) {
    return (
      <div className={cn('rounded-xl border border-dashed border-slate-200 p-3 text-xs text-navy/50', className)}>
        <Paperclip className="mr-1 inline h-3.5 w-3.5" /> Save first, then you can attach receipts and files.
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-xl border p-3 transition-colors',
        dragOver ? 'border-electric bg-electric/5' : 'border-slate-200 bg-white/60',
        className,
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void addFiles(Array.from(e.dataTransfer.files ?? []));
      }}
      aria-label={`${title}: drop files here`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-navy">
          <Paperclip className="h-4 w-4 text-electric" /> {title}
          {items.length > 0 && <span className="text-navy/40">({items.length})</span>}
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => void openInbox()} title="Attach a document from the Doc Center inbox">
            <Inbox className="h-3.5 w-3.5" /> From Doc Center
          </Button>
          <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => inputRef.current?.click()}>
            <FileUp className="h-3.5 w-3.5" /> Add files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {inbox !== null && (
        <div className="mb-2 flex items-center gap-2">
          {inbox.length === 0 ? (
            <p className="text-xs text-navy/50">The Doc Center inbox is empty.</p>
          ) : (
            <>
              <Select value={inboxPick} onChange={(e) => setInboxPick(e.target.value)} aria-label="Document to attach">
                <option value="">Pick a document…</option>
                {inbox.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.filename}
                    {d.description ? ` — ${d.description}` : ''}
                  </option>
                ))}
              </Select>
              <Button type="button" size="sm" onClick={() => void attachFromInbox()} disabled={!inboxPick}>
                Attach
              </Button>
            </>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => setInbox(null)}>
            Close
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-2 text-electric">
          <Spinner className="h-4 w-4" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-navy/40">Drop receipts or documents here.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
              <span className="min-w-0 truncate text-navy" title={a.filename}>
                {a.filename}
                <span className="ml-2 text-xs text-navy/40">{formatBytes(a.sizeBytes)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <a
                  href={`/api/attachments/${a.id}`}
                  className="rounded p-1 text-navy/60 hover:bg-navy/5 hover:text-electric"
                  title="Download"
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => void remove(a)}
                  className="rounded p-1 text-red-400 hover:bg-red-50 hover:text-red-600"
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
