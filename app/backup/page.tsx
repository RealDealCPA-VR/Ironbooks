'use client';

import { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Building2, Download, History } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Company {
  id: string;
  name: string;
}

interface RestoreCompanyResult {
  companyId: string;
  name: string;
  tableCounts: Record<string, number>;
}

interface CondenseResult {
  beforeDate: string;
  months: string[];
  entriesToCondense: number;
  linesToCondense: number;
  voidEntriesToDelete: number;
  summaryEntriesToCreate: number;
  summaryLinesToCreate: number;
  keptOpenDocumentEntries: number;
  keptInProgressReconciliationEntries: number;
  reconciliationItemsToDelete: number;
  bankFeedRowsToDelete: number;
  draftEntriesSkipped: number;
  dryRun: boolean;
  archivePath: string | null;
  runId: string | null;
}

interface CondenseArchiveRow {
  id: string;
  filename: string;
  createdAt: string;
  companyId: string;
  companyName: string | null;
  beforeDate: string;
  entriesCondensed: number;
  sizeBytes: number;
  available: boolean;
}

/** Download a fetch Response as a file, using Content-Disposition when present. */
async function downloadResponse(res: Response, fallbackName: string) {
  let filename = fallbackName;
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  if (match) filename = match[1];

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BackupPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const companyFileInputRef = useRef<HTMLInputElement>(null);

  // ---- Companies (per-company backup selector) ----
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');

  // ---- Download state ----
  const [downloading, setDownloading] = useState(false);
  const [downloadingCompany, setDownloadingCompany] = useState(false);

  // ---- Full-restore confirm modal ----
  const [restoreModalOpen, setRestoreModalOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  // ---- Company-restore confirm modal ----
  const [companyRestoreModalOpen, setCompanyRestoreModalOpen] = useState(false);
  const [pendingCompanyFile, setPendingCompanyFile] = useState<File | null>(null);
  const [restoreName, setRestoreName] = useState('');
  const [restoringCompany, setRestoringCompany] = useState(false);

  // ---- Condense / Archive ----
  const [condenseDate, setCondenseDate] = useState('');
  const [condensePreview, setCondensePreview] = useState<CondenseResult | null>(null);
  const [previewingCondense, setPreviewingCondense] = useState(false);
  const [condenseModalOpen, setCondenseModalOpen] = useState(false);
  const [condenseConfirmText, setCondenseConfirmText] = useState('');
  const [condensing, setCondensing] = useState(false);

  // ---- Condense archive copies ----
  const [archives, setArchives] = useState<CondenseArchiveRow[]>([]);
  const [archiveToRestore, setArchiveToRestore] = useState<CondenseArchiveRow | null>(null);
  const [archiveConfirmText, setArchiveConfirmText] = useState('');
  const [restoringArchive, setRestoringArchive] = useState(false);

  async function loadCompanies() {
    try {
      const res = await fetch('/api/companies', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as Company[];
      setCompanies(data);
      setSelectedCompanyId((prev) => prev || data[0]?.id || '');
    } catch {
      /* companies list is a convenience — page still works without it */
    }
  }

  async function loadArchives() {
    try {
      const data = await api.get<{ archives: CondenseArchiveRow[] }>('/api/condense/archives');
      setArchives(data.archives);
    } catch {
      /* archive list is informational — the rest of the page still works */
    }
  }

  useEffect(() => {
    loadCompanies();
    loadArchives();
  }, []);

  // ---------------------------------------------------------------------------
  // Full backup (whole data dir — all companies)
  // ---------------------------------------------------------------------------

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch('/api/backup', { cache: 'no-store' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data?.error ?? 'Backup failed. Please try again.', 'danger');
        return;
      }
      await downloadResponse(res, 'bookkeeper-backup.bka');
      toast('Full backup downloaded successfully.', 'success');
    } catch {
      toast('Backup failed. Please try again.', 'danger');
    } finally {
      setDownloading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-company backup
  // ---------------------------------------------------------------------------

  async function handleDownloadCompany() {
    if (!selectedCompanyId) {
      toast('Select a company first.', 'danger');
      return;
    }
    setDownloadingCompany(true);
    try {
      const res = await fetch(
        `/api/backup/company?companyId=${encodeURIComponent(selectedCompanyId)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data?.error ?? 'Company backup failed. Please try again.', 'danger');
        return;
      }
      await downloadResponse(res, 'bookkeeper-company.bka');
      toast('Company backup downloaded successfully.', 'success');
    } catch {
      toast('Company backup failed. Please try again.', 'danger');
    } finally {
      setDownloadingCompany(false);
    }
  }

  function handleCompanyFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;
    setPendingCompanyFile(file);
    setRestoreName('');
    setCompanyRestoreModalOpen(true);
  }

  async function handleCompanyRestoreConfirm() {
    if (!pendingCompanyFile) return;
    setRestoringCompany(true);
    try {
      const arrayBuffer = await pendingCompanyFile.arrayBuffer();
      const qs = restoreName.trim() ? `?name=${encodeURIComponent(restoreName.trim())}` : '';
      const res = await fetch(`/api/backup/company${qs}`, {
        method: 'POST',
        body: arrayBuffer,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data?.error ?? 'Restore failed. The file may be corrupt or invalid.', 'danger');
        return;
      }
      const result = (await res.json()) as RestoreCompanyResult;
      toast(`Restored as new company "${result.name}". Switch to it from the company picker.`, 'success');
      setCompanyRestoreModalOpen(false);
      setPendingCompanyFile(null);
      await loadCompanies();
    } catch {
      toast('Restore failed. Please check the file and try again.', 'danger');
    } finally {
      setRestoringCompany(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Full restore — file selection (opens confirm modal)
  // ---------------------------------------------------------------------------

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    // Reset input so same file can be selected again after a cancel.
    e.target.value = '';
    if (!file) return;
    setPendingFile(file);
    setRestoreModalOpen(true);
  }

  async function handleRestoreConfirm() {
    if (!pendingFile) return;
    setRestoring(true);
    try {
      const arrayBuffer = await pendingFile.arrayBuffer();
      const res = await fetch('/api/backup', {
        method: 'POST',
        body: arrayBuffer,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data?.error ?? 'Restore failed. The file may be corrupt or invalid.', 'danger');
        return;
      }

      toast(
        'Restore complete. Please restart the application to see the restored data.',
        'success',
      );
      setRestoreModalOpen(false);
      setPendingFile(null);
    } catch {
      toast('Restore failed. Please check the file and try again.', 'danger');
    } finally {
      setRestoring(false);
    }
  }

  function handleRestoreCancel() {
    setRestoreModalOpen(false);
    setPendingFile(null);
  }

  // ---------------------------------------------------------------------------
  // Condense / Archive
  // ---------------------------------------------------------------------------

  async function handleCondensePreview() {
    if (!condenseDate) {
      toast('Pick a cutoff date first.', 'danger');
      return;
    }
    setPreviewingCondense(true);
    setCondensePreview(null);
    try {
      const result = await api.post<CondenseResult>('/api/condense', {
        beforeDate: condenseDate,
        dryRun: true,
      });
      setCondensePreview(result);
      if (result.entriesToCondense === 0 && result.voidEntriesToDelete === 0) {
        toast('Nothing to condense before that date.', 'info');
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Condense preview failed.', 'danger');
    } finally {
      setPreviewingCondense(false);
    }
  }

  async function handleCondenseConfirm() {
    if (condenseConfirmText !== 'CONDENSE') return;
    setCondensing(true);
    try {
      const result = await api.post<CondenseResult>('/api/condense', {
        beforeDate: condenseDate,
      });
      toast(
        `Condensed ${result.entriesToCondense} entries into ${result.summaryEntriesToCreate} ` +
          `monthly summaries. Archive saved before condensing.`,
        'success',
      );
      setCondenseModalOpen(false);
      setCondenseConfirmText('');
      setCondensePreview(null);
      await loadArchives();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Condense failed. Nothing was changed.', 'danger');
    } finally {
      setCondensing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Restore a condense archive copy
  // ---------------------------------------------------------------------------

  async function handleArchiveRestoreConfirm() {
    if (!archiveToRestore || archiveConfirmText !== 'RESTORE') return;
    setRestoringArchive(true);
    try {
      await api.post('/api/condense/archives', { id: archiveToRestore.id });
      toast(
        `Archive copy from ${new Date(archiveToRestore.createdAt).toLocaleDateString('en-US')} restored — ` +
          'the full transaction detail is back. Reloading…',
        'success',
      );
      setArchiveToRestore(null);
      setArchiveConfirmText('');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The archive copy could not be restored.', 'danger');
    } finally {
      setRestoringArchive(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
        <PageHeader title="Backup & Restore" icon={ArchiveRestore} />

        <div className="max-w-xl flex flex-col gap-6">
          {/* Per-company backup card */}
          <Card className="p-6 flex flex-col gap-3">
            <h2 className="text-lg font-bold text-navy flex items-center gap-2">
              <Building2 className="h-5 w-5 text-electric" />
              Company Backup
            </h2>
            <p className="text-sm text-navy/60">
              Export a single company&apos;s data (accounts, transactions, lists, settings) as a
              portable <span className="font-mono text-navy/80">.bka</span> file. Restoring it
              creates a <span className="font-semibold">new</span> company — other companies are
              never touched.
            </p>
            <div className="flex flex-col gap-3">
              <div>
                <Label>Company</Label>
                <Select
                  value={selectedCompanyId}
                  onChange={(e) => setSelectedCompanyId(e.target.value)}
                  className="max-w-xs"
                >
                  {companies.length === 0 && <option value="">(no companies found)</option>}
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button onClick={handleDownloadCompany} loading={downloadingCompany} disabled={!selectedCompanyId}>
                  <Download className="h-4 w-4" />
                  Download Company Backup
                </Button>
                <input
                  ref={companyFileInputRef}
                  type="file"
                  accept=".bka,.zip"
                  className="hidden"
                  onChange={handleCompanyFileChange}
                />
                <Button
                  variant="secondary"
                  onClick={() => companyFileInputRef.current?.click()}
                  disabled={restoringCompany}
                >
                  <ArchiveRestore className="h-4 w-4" />
                  Restore Company as New…
                </Button>
              </div>
            </div>
          </Card>

          {/* Full download card */}
          <Card className="p-6 flex flex-col gap-3">
            <h2 className="text-lg font-bold text-navy">Full Backup (all companies)</h2>
            <p className="text-sm text-navy/60">
              Save a complete, compressed snapshot of the whole data directory — every company
              file, attachments and the transaction log — to your computer as a{' '}
              <span className="font-mono text-navy/80">.bka</span> file. Restoring it brings back
              everything exactly. Keep this file in a safe place.
            </p>
            <div>
              <Button onClick={handleDownload} loading={downloading}>
                <Download className="h-4 w-4" />
                Download Full Backup (.bka)
              </Button>
            </div>
          </Card>

          {/* Full restore card */}
          <Card className="p-6 flex flex-col gap-3">
            <h2 className="text-lg font-bold text-navy">Restore Full Backup</h2>
            <p className="text-sm text-navy/60">
              Overwrite <span className="font-semibold">all</span> company data with a previously
              saved full <span className="font-mono text-navy/80">.bka</span> backup. This cannot
              be undone — to bring back just one company without touching the others, use{' '}
              <span className="font-semibold">Restore Company as New</span> above.
            </p>
            <div>
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".bka,.zip"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                disabled={restoring}
              >
                <ArchiveRestore className="h-4 w-4" />
                Restore from File…
              </Button>
            </div>
          </Card>

          {/* Condense / Archive card */}
          <Card className="p-6 flex flex-col gap-3 border-red-200">
            <h2 className="text-lg font-bold text-navy flex items-center gap-2">
              <Archive className="h-5 w-5 text-red-600" />
              Condense / Archive Old Detail
            </h2>
            <p className="text-sm text-navy/60">
              Replace detailed journal entries dated <span className="font-semibold">before</span>{' '}
              a cutoff with one summary entry per month. Account balances, debit/credit totals,
              and class totals are preserved exactly; documents with open balances and
              in-progress reconciliations are kept intact. The affected period must be{' '}
              <span className="font-semibold">closed</span> first.
            </p>
            <p className="text-sm font-medium text-red-600">
              This permanently deletes transaction detail from the working file. A complete archive
              copy (<span className="font-mono">.bka</span>) is saved and verified automatically
              before anything is removed — restore it from <span className="font-semibold">Archive
              copies</span> below to bring the full detail back.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="condense-date">Remove detail dated before</Label>
                <Input
                  id="condense-date"
                  type="date"
                  value={condenseDate}
                  onChange={(e) => {
                    setCondenseDate(e.target.value);
                    setCondensePreview(null);
                  }}
                  className="max-w-xs"
                />
              </div>
              <Button
                variant="secondary"
                onClick={handleCondensePreview}
                loading={previewingCondense}
                disabled={!condenseDate}
              >
                Preview
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setCondenseConfirmText('');
                  setCondenseModalOpen(true);
                }}
                disabled={
                  !condensePreview ||
                  (condensePreview.entriesToCondense === 0 &&
                    condensePreview.voidEntriesToDelete === 0)
                }
              >
                <Archive className="h-4 w-4" />
                Condense…
              </Button>
            </div>

            {condensePreview && (
              <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-navy/80">
                <p className="font-semibold text-navy mb-2">
                  Preview — condensing before {condensePreview.beforeDate}
                </p>
                <ul className="space-y-1">
                  <li>
                    <span className="font-medium">{condensePreview.entriesToCondense}</span>{' '}
                    detail entries ({condensePreview.linesToCondense} lines) will be replaced by{' '}
                    <span className="font-medium">{condensePreview.summaryEntriesToCreate}</span>{' '}
                    monthly summary entries
                    {condensePreview.months.length > 0 && (
                      <> ({condensePreview.months.join(', ')})</>
                    )}
                  </li>
                  <li>{condensePreview.voidEntriesToDelete} voided entries will be deleted</li>
                  <li>
                    {condensePreview.reconciliationItemsToDelete} completed-reconciliation detail
                    rows and {condensePreview.bankFeedRowsToDelete} matched bank-feed rows will be
                    removed
                  </li>
                  <li>
                    Kept intact: {condensePreview.keptOpenDocumentEntries} entries behind
                    open-balance documents, {condensePreview.keptInProgressReconciliationEntries}{' '}
                    entries in the in-progress reconciliation,{' '}
                    {condensePreview.draftEntriesSkipped} drafts
                  </li>
                </ul>
              </div>
            )}
          </Card>
        </div>

        {/* Condense archive copies */}
        <div className="max-w-xl mt-6">
          <Card className="p-6 flex flex-col gap-3">
            <h2 className="text-lg font-bold text-navy flex items-center gap-2">
              <History className="h-5 w-5 text-electric" />
              Archive copies (from Condense)
            </h2>
            <p className="text-sm text-navy/60">
              Each condense first saves a full copy of the company file with all of its detail.
              Restoring one replaces the current file with that copy — anything entered after the
              condense is not in it (the current file is backed up automatically first).
            </p>
            {archives.length === 0 ? (
              <p className="text-sm text-navy/40">No archive copies yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {archives.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-navy">
                        {new Date(a.createdAt).toLocaleString('en-US')} — detail before {a.beforeDate}
                      </p>
                      <p className="text-xs text-navy/50 truncate" title={a.filename}>
                        {a.entriesCondensed.toLocaleString()} entries condensed ·{' '}
                        {(a.sizeBytes / (1024 * 1024)).toFixed(1)} MB · {a.filename}
                        {!a.available && <span className="text-red-600"> · file missing</span>}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!a.available}
                      onClick={() => {
                        setArchiveConfirmText('');
                        setArchiveToRestore(a);
                      }}
                    >
                      <ArchiveRestore className="h-4 w-4" />
                      Restore archive copy…
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Archive-restore confirmation modal — requires typing RESTORE */}
        <Modal
          open={Boolean(archiveToRestore)}
          onClose={() => {
            if (!restoringArchive) setArchiveToRestore(null);
          }}
          title="Restore archive copy?"
          footer={
            <>
              <Button variant="secondary" onClick={() => setArchiveToRestore(null)} disabled={restoringArchive}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleArchiveRestoreConfirm}
                loading={restoringArchive}
                disabled={archiveConfirmText !== 'RESTORE'}
              >
                Restore archive copy
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm text-navy/70">
            <p>
              The company file will be returned to how it was on{' '}
              <span className="font-semibold text-navy">
                {archiveToRestore ? new Date(archiveToRestore.createdAt).toLocaleString('en-US') : ''}
              </span>
              , just before condensing — with every detailed transaction.
            </p>
            <p className="text-red-600 font-medium">
              Changes made after that moment will not be in the restored file. The current file is
              saved automatically as a safety backup first.
            </p>
            <div>
              <Label htmlFor="archive-confirm">
                Type <span className="font-mono font-bold">RESTORE</span> to continue
              </Label>
              <Input
                id="archive-confirm"
                autoFocus
                value={archiveConfirmText}
                onChange={(e) => setArchiveConfirmText(e.target.value)}
                placeholder="RESTORE"
              />
            </div>
          </div>
        </Modal>

        {/* Full-restore confirmation modal */}
        <Modal
          open={restoreModalOpen}
          onClose={handleRestoreCancel}
          title="Restore Full Backup?"
          footer={
            <>
              <Button variant="secondary" onClick={handleRestoreCancel} disabled={restoring}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleRestoreConfirm} loading={restoring}>
                Yes, Overwrite &amp; Restore
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm text-navy/70">
            <p>
              You are about to restore from{' '}
              <span className="font-semibold text-navy break-all">{pendingFile?.name}</span>.
            </p>
            <p className="text-red-600 font-medium">
              This will overwrite ALL current company data and cannot be undone.
            </p>
            <p>
              After restoring, you must restart the application for the restored data to become
              active.
            </p>
            <p>Are you sure you want to continue?</p>
          </div>
        </Modal>

        {/* Company-restore confirmation modal */}
        <Modal
          open={companyRestoreModalOpen}
          onClose={() => {
            setCompanyRestoreModalOpen(false);
            setPendingCompanyFile(null);
          }}
          title="Restore Company as New?"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setCompanyRestoreModalOpen(false);
                  setPendingCompanyFile(null);
                }}
                disabled={restoringCompany}
              >
                Cancel
              </Button>
              <Button type="submit" form="company-restore-form" loading={restoringCompany}>
                Restore as New Company
              </Button>
            </>
          }
        >
          <form
            id="company-restore-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleCompanyRestoreConfirm();
            }}
            className="flex flex-col gap-3 text-sm text-navy/70"
          >
            <p>
              You are about to restore{' '}
              <span className="font-semibold text-navy break-all">{pendingCompanyFile?.name}</span>{' '}
              as a <span className="font-semibold">new</span> company. Existing companies are not
              modified.
            </p>
            <div>
              <Label>New company name (optional — defaults to the backed-up name)</Label>
              <Input
                autoFocus
                value={restoreName}
                onChange={(e) => setRestoreName(e.target.value)}
                placeholder="e.g. Acme Corp (restored)"
              />
            </div>
          </form>
        </Modal>

        {/* Condense confirmation modal — requires typing CONDENSE */}
        <Modal
          open={condenseModalOpen}
          onClose={() => {
            if (!condensing) {
              setCondenseModalOpen(false);
              setCondenseConfirmText('');
            }
          }}
          title="Permanently condense old detail?"
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setCondenseModalOpen(false);
                  setCondenseConfirmText('');
                }}
                disabled={condensing}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleCondenseConfirm}
                loading={condensing}
                disabled={condenseConfirmText !== 'CONDENSE'}
              >
                Condense Permanently
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm text-navy/70">
            <p>
              You are about to permanently delete{' '}
              <span className="font-semibold text-navy">
                {condensePreview?.entriesToCondense ?? 0} journal entries
              </span>{' '}
              (plus {condensePreview?.voidEntriesToDelete ?? 0} voided entries) dated before{' '}
              <span className="font-semibold text-navy">{condenseDate}</span> and replace them with{' '}
              {condensePreview?.summaryEntriesToCreate ?? 0} monthly summary entries.
            </p>
            <p className="text-red-600 font-medium">
              Transaction-level detail, drill-down links on old closed documents, and
              completed-reconciliation detail in this range will be removed from the working file.
              The only way back is restoring the archive copy saved automatically before
              condensing (Archive copies, below) — which rolls back EVERYTHING to this moment.
            </p>
            <p>
              Account balances, monthly totals, and class totals are preserved. Open invoices,
              unpaid bills, unapplied credits/payments, and the in-progress reconciliation are
              kept intact.
            </p>
            <div>
              <Label htmlFor="condense-confirm">
                Type <span className="font-mono font-bold">CONDENSE</span> to continue
              </Label>
              <Input
                id="condense-confirm"
                autoFocus
                value={condenseConfirmText}
                onChange={(e) => setCondenseConfirmText(e.target.value)}
                placeholder="CONDENSE"
              />
            </div>
          </div>
        </Modal>
      </main>
    </>
  );
}
