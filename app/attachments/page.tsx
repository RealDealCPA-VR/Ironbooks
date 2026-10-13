'use client';

/**
 * Doc Center (QB Company > Documents > Doc Center): every document in the company file.
 *  - Inbox: files dropped here wait, unattached, until you file them to a record.
 *  - All documents: search by file name or description.
 *  - By record: the original record-centric view below.
 * Files are stored locally in the company data directory; nothing is uploaded anywhere.
 *
 * By record — attach receipts and files — attach receipts and files to any entity (invoice, bill, expense, etc.).
 *
 * UX:
 *  1. User picks an entity type, then picks the actual record from a searchable list
 *     (no UUIDs — records are shown by number/name). Deep links can prefill the record
 *     via ?entityType=...&entityId=... query params.
 *  2. The page lists all existing attachments for that record.
 *  3. A file <input> lets the user pick a local file. On "Upload" the file is read
 *     as base64 and POSTed to /api/attachments.
 *  4. Each listed row has a Download link and a Delete button.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Upload, Trash2, Download, Inbox, Search, FolderInput } from 'lucide-react';
import { uploadFiles } from '@/components/AttachmentPanel';
import {
  Button,
  Card,
  Input,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  ConfirmDialog,
  EmptyState,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Attachment {
  id: string;
  entityType: string | null;
  entityId: string | null;
  description?: string | null;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string;
  createdAt: string;
}

interface RecordOption {
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Entity-type config — how to list pickable records for each type
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;

interface EntitySource {
  url: string;
  /** Unwrap the API response into a row array. */
  rows: (data: unknown) => AnyRow[];
  /** Human label for a row (document number / name — never the UUID). */
  label: (row: AnyRow) => string;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

const ENTITY_TYPES: { value: string; label: string; source?: EntitySource }[] = [
  {
    value: 'invoice',
    label: 'Invoice',
    source: {
      url: '/api/invoices',
      rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
      label: (r) => `Invoice #${str(r.invoiceNumber)}${r.date ? ` — ${formatDate(str(r.date))}` : ''}`,
    },
  },
  {
    value: 'bill',
    label: 'Bill',
    source: {
      url: '/api/bills',
      rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
      label: (r) =>
        `Bill ${r.billNumber ? `#${str(r.billNumber)}` : '(no number)'}${r.date ? ` — ${formatDate(str(r.date))}` : ''}`,
    },
  },
  {
    value: 'expense',
    label: 'Expense',
    source: {
      url: '/api/expenses',
      rows: (d) => ((d as { expenses?: AnyRow[] })?.expenses ?? []),
      label: (r) =>
        `${str(r.payeeName) || 'Expense'}${r.date ? ` — ${formatDate(str(r.date))}` : ''}`,
    },
  },
  {
    value: 'journal_entry',
    label: 'Journal Entry',
    source: {
      url: '/api/journal-entries',
      rows: (d) => ((d as { entries?: AnyRow[] })?.entries ?? []),
      label: (r) => `JE #${str(r.entryNumber)}${r.memo ? ` — ${str(r.memo)}` : ''}`,
    },
  },
  {
    value: 'customer',
    label: 'Customer',
    source: {
      url: '/api/customers',
      rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
      label: (r) => str(r.displayName) || 'Customer',
    },
  },
  {
    value: 'vendor',
    label: 'Vendor',
    source: {
      url: '/api/vendors',
      rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
      label: (r) => str(r.displayName) || str(r.name) || 'Vendor',
    },
  },
  {
    value: 'employee',
    label: 'Employee',
    source: {
      url: '/api/employees',
      rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
      label: (r) => `${str(r.firstName)} ${str(r.lastName)}`.trim() || 'Employee',
    },
  },
  // No list endpoint for these — the record reference comes from a deep link.
  { value: 'paycheck', label: 'Paycheck' },
  { value: 'other', label: 'Other' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>" — strip the prefix
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function ByRecordView() {
  // Entity picker state
  const [entityType, setEntityType] = useState<string>(ENTITY_TYPES[0].value);
  const [entityId, setEntityId] = useState<string>('');

  // Pickable records for the chosen entity type
  const [records, setRecords] = useState<RecordOption[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [recordSearch, setRecordSearch] = useState('');

  // Attachments list
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Deleting state
  const [pendingDelete, setPendingDelete] = useState<Attachment | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const typeConfig = ENTITY_TYPES.find((t) => t.value === entityType);

  // ---------------------------------------------------------------------------
  // Fetch attachments for the selected record
  // ---------------------------------------------------------------------------

  const fetchAttachments = useCallback(
    async (type: string, id: string) => {
      if (!id.trim()) return;
      setListLoading(true);
      setHasSearched(true);
      try {
        const list = await api.get<Attachment[]>(
          `/api/attachments?entityType=${encodeURIComponent(type)}&entityId=${encodeURIComponent(id.trim())}`,
        );
        setAttachments(list);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load attachments', 'danger');
      } finally {
        setListLoading(false);
      }
    },
    [],
  );

  // Deep-link prefill: /attachments?entityType=invoice&entityId=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qpType = params.get('entityType');
    const qpId = params.get('entityId');
    if (qpType && ENTITY_TYPES.some((t) => t.value === qpType)) setEntityType(qpType);
    if (qpId) {
      setEntityId(qpId);
      fetchAttachments(qpType && ENTITY_TYPES.some((t) => t.value === qpType) ? qpType : ENTITY_TYPES[0].value, qpId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load pickable records whenever the entity type changes.
  useEffect(() => {
    const source = ENTITY_TYPES.find((t) => t.value === entityType)?.source;
    setRecords([]);
    setRecordSearch('');
    if (!source) return;
    let cancelled = false;
    (async () => {
      setRecordsLoading(true);
      try {
        const data = await api.get<unknown>(source.url);
        if (cancelled) return;
        setRecords(
          source
            .rows(data)
            .filter((r) => typeof r.id === 'string')
            .map((r) => ({ id: r.id as string, label: source.label(r) })),
        );
      } catch (err) {
        if (!cancelled) {
          toast(err instanceof ApiError ? err.message : 'Failed to load records', 'danger');
        }
      } finally {
        if (!cancelled) setRecordsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entityType]);

  function handleSelectRecord(id: string) {
    setEntityId(id);
    setAttachments([]);
    setHasSearched(false);
    if (id) fetchAttachments(entityType, id);
  }

  const filteredRecords = recordSearch.trim()
    ? records.filter((r) => r.label.toLowerCase().includes(recordSearch.trim().toLowerCase()))
    : records;

  const selectedRecord = records.find((r) => r.id === entityId) ?? null;
  const selectedLabel =
    selectedRecord?.label ?? (entityId ? `${typeConfig?.label ?? entityType} record` : '');

  // ---------------------------------------------------------------------------
  // Upload handler
  // ---------------------------------------------------------------------------

  async function handleUpload() {
    if (!selectedFile) {
      toast('Select a file first', 'danger');
      return;
    }
    if (!entityId.trim()) {
      toast('Pick a record first', 'danger');
      return;
    }

    setUploading(true);
    try {
      const base64 = await readFileAsBase64(selectedFile);
      await api.post('/api/attachments', {
        entityType,
        entityId: entityId.trim(),
        filename: selectedFile.name,
        mimeType: selectedFile.type || 'application/octet-stream',
        base64,
      });
      toast(`"${selectedFile.name}" uploaded`, 'success');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchAttachments(entityType, entityId);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Upload failed', 'danger');
    } finally {
      setUploading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete handler
  // ---------------------------------------------------------------------------

  async function doDelete() {
    const att = pendingDelete;
    if (!att) return;
    setDeletingId(att.id);
    try {
      await api.del(`/api/attachments/${att.id}`);
      toast(`"${att.filename}" deleted`, 'success');
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      setPendingDelete(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Delete failed', 'danger');
    } finally {
      setDeletingId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* ---- Entity picker ---- */}
      <Card className="p-6 mb-6 max-w-2xl">
        <h2 className="text-base font-bold text-navy mb-4">Find attachments for a record</h2>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="entityType">Record Type</Label>
              <Select
                id="entityType"
                value={entityType}
                onChange={(e) => {
                  setEntityType(e.target.value);
                  setEntityId('');
                  setAttachments([]);
                  setHasSearched(false);
                }}
              >
                {ENTITY_TYPES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            {typeConfig?.source ? (
              <div>
                <Label htmlFor="entityRecord">Record</Label>
                {recordsLoading ? (
                  <div className="flex items-center gap-2 text-navy/40 text-sm py-2">
                    <Spinner className="h-4 w-4" /> Loading {typeConfig.label.toLowerCase()}s…
                  </div>
                ) : (
                  <>
                    {records.length > 8 && (
                      <Input
                        className="mb-2"
                        placeholder={`Search ${typeConfig.label.toLowerCase()}s…`}
                        value={recordSearch}
                        onChange={(e) => setRecordSearch(e.target.value)}
                      />
                    )}
                    <Select
                      id="entityRecord"
                      value={entityId}
                      onChange={(e) => handleSelectRecord(e.target.value)}
                    >
                      <option value="">— Pick a {typeConfig.label.toLowerCase()} —</option>
                      {filteredRecords.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </Select>
                  </>
                )}
              </div>
            ) : (
              <div className="text-sm text-navy/50 self-end pb-2">
                Open this page from the record&apos;s screen to view its attachments.
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ---- Upload panel ---- */}
      {entityId.trim() && (
        <Card className="p-6 mb-6 max-w-2xl">
          <h2 className="text-base font-bold text-navy mb-4">
            Upload a file to{' '}
            <span className="text-electric">{selectedLabel}</span>
          </h2>
          <div className="flex items-end gap-4">
            <div className="flex-1">
              <Label htmlFor="fileInput">Choose file</Label>
              <input
                id="fileInput"
                ref={fileInputRef}
                type="file"
                className="block w-full text-sm text-navy/70 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-electric/10 file:text-electric file:font-semibold hover:file:bg-electric/20 cursor-pointer"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <Button onClick={handleUpload} loading={uploading} disabled={!selectedFile}>
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          </div>
          {selectedFile && (
            <p className="mt-2 text-xs text-navy/50">
              Selected: <span className="font-medium text-navy">{selectedFile.name}</span> (
              {formatBytes(selectedFile.size)})
            </p>
          )}
        </Card>
      )}

      {/* ---- Attachments list ---- */}
      {hasSearched && (
        <Card className="max-w-4xl">
          {listLoading ? (
            <div className="flex items-center justify-center gap-2 p-12 text-navy/40 text-sm">
              <Spinner className="h-4 w-4" /> Loading...
            </div>
          ) : attachments.length === 0 ? (
            <EmptyState
              icon={Paperclip}
              title="No attachments yet"
              message="Upload a receipt or document above to attach it to this record."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Filename</Th>
                  <Th>Type</Th>
                  <Th numeric>Size</Th>
                  <Th>Uploaded</Th>
                  <Th numeric>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {attachments.map((att) => (
                  <Tr key={att.id}>
                    <Td className="font-medium text-navy">{att.filename}</Td>
                    <Td>
                      {att.mimeType ? (
                        <Badge tone="info">{att.mimeType.split('/')[1] ?? att.mimeType}</Badge>
                      ) : (
                        <span className="text-navy/40">-</span>
                      )}
                    </Td>
                    <Td numeric className="text-navy/70">{formatBytes(att.sizeBytes)}</Td>
                    <Td className="text-navy/60 text-sm">{formatDate(att.createdAt)}</Td>
                    <Td numeric>
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/api/attachments/${att.id}`}
                          download={att.filename}
                          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-electric hover:bg-electric/10 transition-colors"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:bg-red-50"
                          disabled={deletingId === att.id}
                          onClick={() => setPendingDelete(att)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete attachment?"
        message={`Delete "${pendingDelete?.filename}"? This cannot be undone.`}
        confirmLabel="Delete"
        tone="danger"
        loading={!!deletingId}
        onConfirm={doDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Doc Center: inbox + all documents + filing
// ---------------------------------------------------------------------------

/** Pick a record of a given type (same sources as the By record view). */
function useRecords(entityType: string) {
  const [records, setRecords] = useState<RecordOption[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const source = ENTITY_TYPES.find((t) => t.value === entityType)?.source;
    setRecords([]);
    if (!source) return;
    let cancelled = false;
    setLoading(true);
    api
      .get<unknown>(source.url)
      .then((data) => {
        if (cancelled) return;
        setRecords(
          source
            .rows(data)
            .filter((r) => typeof r.id === 'string')
            .map((r) => ({ id: r.id as string, label: source.label(r) })),
        );
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [entityType]);
  return { records, loading };
}

function FileToRecord({ doc, onDone }: { doc: Attachment; onDone: () => void }) {
  const filable = ENTITY_TYPES.filter((t) => t.source);
  const [type, setType] = useState(filable[0].value);
  const [recordId, setRecordId] = useState('');
  const { records, loading } = useRecords(type);
  const [saving, setSaving] = useState(false);

  async function file() {
    if (!recordId) return;
    setSaving(true);
    try {
      await api.patch(`/api/attachments/${doc.id}`, { entityType: type, entityId: recordId });
      toast(`Filed ${doc.filename}`, 'success');
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not file the document', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Record type" value={type} onChange={(e) => { setType(e.target.value); setRecordId(''); }} className="w-36">
        {filable.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </Select>
      <Select aria-label="Record" value={recordId} onChange={(e) => setRecordId(e.target.value)} className="w-56" disabled={loading}>
        <option value="">{loading ? 'Loading…' : 'Pick a record…'}</option>
        {records.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </Select>
      <Button size="sm" onClick={() => void file()} disabled={!recordId} loading={saving}>
        <FolderInput className="h-3.5 w-3.5" /> File
      </Button>
    </div>
  );
}

function InboxView() {
  const [docs, setDocs] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDocs(await api.get<Attachment[]>('/api/attachments?unfiled=1'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the inbox', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    const saved = await uploadFiles(files, null);
    setUploading(false);
    if (saved.length) {
      toast(`Added ${saved.length} document${saved.length === 1 ? '' : 's'} to the inbox`, 'success');
      await load();
    }
  }

  async function remove(d: Attachment) {
    if (!window.confirm(`Delete ${d.filename}? This cannot be undone.`)) return;
    try {
      await api.del(`/api/attachments/${d.id}`);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Delete failed', 'danger');
    }
  }

  async function describe(d: Attachment) {
    const description = window.prompt('Description or keywords for this document', d.description ?? '');
    if (description === null) return;
    try {
      await api.patch(`/api/attachments/${d.id}`, { description });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the description', 'danger');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void add(Array.from(e.dataTransfer.files ?? []));
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center ${dragOver ? 'border-electric bg-electric/5' : 'border-slate-300 bg-white/60'}`}
      >
        <Upload className="h-6 w-6 text-electric" />
        <p className="text-sm text-navy">Drag receipts, bills and other documents here</p>
        <p className="text-xs text-navy/50">They wait in the inbox until you file them to an invoice, bill, customer…</p>
        <Button size="sm" variant="secondary" loading={uploading} onClick={() => inputRef.current?.click()}>
          Browse files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void add(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      <Card>
        {loading ? (
          <div className="flex justify-center p-8 text-electric">
            <Spinner className="h-5 w-5" />
          </div>
        ) : docs.length === 0 ? (
          <EmptyState icon={Inbox} title="Inbox is empty" message="Documents you add here without a record wait for you to file them." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Document</Th>
                <Th>Added</Th>
                <Th>Size</Th>
                <Th>File it to</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <button type="button" className="text-left font-semibold text-navy hover:text-electric" onClick={() => void describe(d)} title="Add a description">
                      {d.filename}
                    </button>
                    {d.description && (
                      <p className="text-xs text-navy/50">{d.description}</p>
                    )}
                  </Td>
                  <Td className="text-navy/60">{formatDate(d.createdAt)}</Td>
                  <Td className="text-navy/60">{formatBytes(d.sizeBytes)}</Td>
                  <Td>
                    <FileToRecord doc={d} onDone={() => void load()} />
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <a href={`/api/attachments/${d.id}`} className="mr-2 inline-flex items-center text-electric" title="Download">
                      <Download className="h-4 w-4" />
                    </a>
                    <button type="button" onClick={() => void remove(d)} className="inline-flex items-center text-red-500" title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function AllDocsView() {
  const [q, setQ] = useState('');
  const [docs, setDocs] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      setDocs(await api.get<Attachment[]>(`/api/attachments?all=1&q=${encodeURIComponent(query)}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load documents', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q), 250);
    return () => clearTimeout(t);
  }, [q, load]);

  async function unfile(d: Attachment) {
    try {
      await api.patch(`/api/attachments/${d.id}`, { entityType: null, entityId: null });
      await load(q);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not move the document', 'danger');
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-slate-100 p-4">
        <Search className="h-4 w-4 text-navy/40" />
        <Input aria-label="Search documents" placeholder="Search by file name or description" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {loading ? (
        <div className="flex justify-center p-8 text-electric">
          <Spinner className="h-5 w-5" />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState icon={Paperclip} title="No documents" message="Nothing matches." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Attached to</Th>
              <Th>Added</Th>
              <Th>Size</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <Tr key={d.id}>
                <Td className="font-semibold text-navy">{d.filename}</Td>
                <Td>
                  {d.entityType ? (
                    <Badge tone="info">{ENTITY_TYPES.find((t) => t.value === d.entityType)?.label ?? d.entityType.replace(/_/g, ' ')}</Badge>
                  ) : (
                    <Badge tone="neutral">Inbox</Badge>
                  )}
                </Td>
                <Td className="text-navy/60">{formatDate(d.createdAt)}</Td>
                <Td className="text-navy/60">{formatBytes(d.sizeBytes)}</Td>
                <Td className="text-right whitespace-nowrap">
                  <a href={`/api/attachments/${d.id}`} className="mr-2 inline-flex items-center text-electric" title="Download">
                    <Download className="h-4 w-4" />
                  </a>
                  {d.entityType && (
                    <Button size="sm" variant="ghost" onClick={() => void unfile(d)} title="Move back to the inbox">
                      Unfile
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

const DOC_TABS = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'all', label: 'All documents', icon: Search },
  { id: 'record', label: 'By record', icon: Paperclip },
] as const;

export default function DocCenterPage() {
  const [tab, setTab] = useState<(typeof DOC_TABS)[number]['id']>('inbox');

  // Deep links (?entityType=&entityId=) open the record view directly.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('entityId')) setTab('record');
  }, []);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Attached documents (Doc Center)" icon={Paperclip} />
      <div className="mb-6 flex gap-1 rounded-xl border border-slate-200 bg-white/70 p-1 w-fit" role="tablist">
        {DOC_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${tab === t.id ? 'bg-electric text-white' : 'text-navy/60 hover:bg-electric/10'}`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'inbox' && <InboxView />}
      {tab === 'all' && <AllDocsView />}
      {tab === 'record' && <ByRecordView />}
    </main>
  );
}
