'use client';

/**
 * Receipts (receipt capture): photos and PDFs of receipts waiting to be entered.
 *
 * Add receipts by dragging them anywhere in the app, with "Add receipts" here, or from a phone
 * ("Send from your phone"). Each receipt is read on this computer — PDF text, offline text
 * recognition for photos, or the company's own local AI model — and the review screen turns it
 * into an expense, check, credit card charge or bill with the receipt attached.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Receipt, Upload, Smartphone, Trash2, Settings2 } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Label,
  PageHeader,
  PageSkeleton,
  Select,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { RECEIPTS_UPLOADED_EVENT, uploadReceiptFiles } from '@/components/ReceiptDropZone';
import { api } from '@/lib/client';
import { canDo, useMe } from '@/lib/usePermissions';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { RECEIPT_ACCEPT } from '@/lib/receipts/files';
import { ReceiptStatusBadge, type ReceiptRow } from '@/components/ReceiptStatus';

interface Settings {
  visionProviderId: string | null;
  preferVision: boolean;
  dateOrder: 'mdy' | 'dmy';
  visionModels: { id: string; label: string; model: string }[];
  ocrAvailable: boolean;
}

export default function ReceiptsPage() {
  const { me } = useMe();
  const [tab, setTab] = useState<'open' | 'saved'>('open');
  const [rows, setRows] = useState<ReceiptRow[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<ReceiptRow | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reading = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ receipts: ReceiptRow[] }>(`/api/receipts?status=${tab}`);
      setRows(d.receipts);
    } catch (err) {
      toastError(err, 'Could not load receipts.');
      setRows([]);
    }
  }, [tab]);

  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  // Refresh when a receipt is dropped anywhere in the app.
  useEffect(() => {
    const on = () => load();
    window.addEventListener(RECEIPTS_UPLOADED_EVENT, on);
    return () => window.removeEventListener(RECEIPTS_UPLOADED_EVENT, on);
  }, [load]);

  // Read any receipt still waiting (e.g. sent from a phone while the app was busy), and poll
  // while something is being read. A read abandoned mid-way (app closed during OCR) comes back
  // from the server as 'pending' after a few minutes (effectiveReceiptStatus), so it is retried here.
  useEffect(() => {
    if (!rows) return;
    for (const r of rows) {
      if (r.status === 'pending' && !reading.current.has(r.id)) {
        reading.current.add(r.id);
        api
          .post(`/api/receipts/${r.id}/extract`, {})
          .then(() => load())
          .catch(() => {})
          .finally(() => reading.current.delete(r.id));
      }
    }
    if (!rows.some((r) => r.status === 'pending' || r.status === 'processing')) return;
    const t = setTimeout(load, 2500);
    return () => clearTimeout(t);
  }, [rows, load]);

  useEffect(() => {
    api
      .get<Settings>('/api/receipts/settings')
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    try {
      const { added, failed } = await uploadReceiptFiles(Array.from(list));
      if (added.length) toast(`${added.length === 1 ? 'Receipt' : `${added.length} receipts`} added.`, 'success');
      for (const f of failed) toast(`${f.name}: ${f.error}`, 'danger');
      if (tab !== 'open') setTab('open');
      else load();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await api.del(`/api/receipts/${deleting.id}`);
      toast('Receipt removed.', 'success');
      setDeleting(null);
      load();
    } catch (err) {
      toastError(err, 'Could not remove the receipt.');
    }
  }

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const next = await api.put<Settings>('/api/receipts/settings', {
        visionProviderId: patch.visionProviderId !== undefined ? patch.visionProviderId : settings.visionProviderId,
        preferVision: patch.preferVision ?? settings.preferVision,
        dateOrder: patch.dateOrder ?? settings.dateOrder,
      });
      setSettings(next);
      toast('Saved.', 'success');
    } catch (err) {
      toastError(err, 'Could not save the settings.');
    } finally {
      setSavingSettings(false);
    }
  }

  const canAdd = canDo(me, 'lists', 'create');
  const canSettings = canDo(me, 'company', 'modify');

  return (
    <div className="p-8 max-w-6xl mx-auto w-full">
      <PageHeader
        title="Receipts"
        icon={Receipt}
        action={
          canAdd ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/receipts/phone"
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-navy hover:bg-slate-50 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
              >
                <Smartphone className="h-4 w-4" /> Send from your phone
              </Link>
              <Button onClick={() => fileRef.current?.click()} loading={uploading}>
                <Upload className="h-4 w-4" /> Add receipts
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={RECEIPT_ACCEPT}
                className="sr-only"
                aria-label="Choose receipt photos or PDFs"
                onChange={(e) => onFiles(e.target.files)}
              />
            </div>
          ) : undefined
        }
      />

      <p className="mb-6 max-w-3xl text-sm text-navy/60">
        Drag a photo or PDF of a receipt anywhere in Ironbooks, or add one here. Ironbooks reads the store, date, total
        and sales tax on this computer — nothing is sent anywhere — and you check the details before anything is
        recorded. The receipt is kept with the transaction it becomes.
      </p>

      <div role="tablist" aria-label="Receipts" className="mb-4 flex gap-1 rounded-xl bg-white p-1 shadow-sm border border-slate-100 w-fit">
        {(['open', 'saved'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-4 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-electric/50 ${
              tab === t ? 'bg-electric text-white' : 'text-navy/70 hover:bg-navy/5'
            }`}
          >
            {t === 'open' ? 'To review' : 'Saved'}
          </button>
        ))}
      </div>

      {!rows ? (
        <PageSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={Receipt}
            title={tab === 'open' ? 'No receipts waiting' : 'No saved receipts yet'}
            message={
              tab === 'open'
                ? 'Drop a receipt photo or PDF anywhere in the app, or send one from your phone.'
                : 'Receipts you save as expenses or bills show up here.'
            }
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Receipt</Th>
                <Th>Paid to</Th>
                <Th>Date</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <div className="font-medium text-navy">{r.filename}</div>
                    <div className="text-xs text-navy/50">
                      {r.source === 'phone' ? 'From a phone' : 'From this computer'} · {formatDate(r.createdAt)}
                    </div>
                  </Td>
                  <Td>{r.vendorName ?? <span className="text-navy/40">—</span>}</Td>
                  <Td>{r.date ? formatDate(`${r.date}T12:00:00`) : <span className="text-navy/40">—</span>}</Td>
                  <Td numeric>{r.total ? formatCurrency(r.total) : <span className="text-navy/40">—</span>}</Td>
                  <Td><ReceiptStatusBadge status={r.status} txnType={r.txnType} /></Td>
                  <Td className="text-right whitespace-nowrap">
                    <Link
                      href={`/receipts/${r.id}`}
                      className="mr-2 font-semibold text-electric hover:underline outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded"
                    >
                      {r.status === 'saved' ? 'View' : 'Review'}
                      <span className="sr-only"> {r.filename}</span>
                    </Link>
                    {r.status !== 'saved' && canAdd && (
                      <button
                        type="button"
                        onClick={() => setDeleting(r)}
                        className="rounded p-1 text-navy/40 hover:text-red-600 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
                        aria-label={`Remove ${r.filename}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {settings && (
        <Card className="mt-6 p-5">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded"
            aria-expanded={showSettings}
            onClick={() => setShowSettings((v) => !v)}
          >
            <span className="flex items-center gap-2 font-semibold text-navy">
              <Settings2 className="h-4 w-4 text-electric" /> How receipts are read
            </span>
            <span className="text-sm text-navy/50">{showSettings ? 'Hide' : 'Show'}</span>
          </button>
          {showSettings && (
            <div className="mt-4 space-y-4 text-sm">
              <p className="text-navy/70">
                PDF receipts are read from their text. Photos are read by{' '}
                {settings.ocrAvailable ? (
                  <strong>text recognition built into Ironbooks</strong>
                ) : (
                  <strong className="text-red-600">
                    text recognition, which is not installed on this computer (reinstall or update Ironbooks)
                  </strong>
                )}
                , on this computer. You can also use your own AI model on this computer or your network (set up in AI &amp;
                Automation). Photos never go to a cloud service.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <Label htmlFor="vision-model">Local AI model for photos</Label>
                  <Select
                    id="vision-model"
                    value={settings.visionProviderId ?? ''}
                    disabled={!canSettings || savingSettings}
                    onChange={(e) => saveSettings({ visionProviderId: e.target.value || null })}
                  >
                    <option value="">Don&apos;t use AI</option>
                    {settings.visionModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} ({m.model})
                      </option>
                    ))}
                  </Select>
                  {settings.visionModels.length === 0 && (
                    <p className="mt-1 text-xs text-navy/50">
                      No local model yet. <Link href="/ai-settings" className="text-electric hover:underline">Add one</Link> (a vision
                      model such as llava in Ollama).
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="prefer-vision">Which to try first</Label>
                  <Select
                    id="prefer-vision"
                    value={settings.preferVision ? 'vision' : 'ocr'}
                    disabled={!canSettings || savingSettings || !settings.visionProviderId}
                    onChange={(e) => saveSettings({ preferVision: e.target.value === 'vision' })}
                  >
                    <option value="ocr">Built-in text recognition</option>
                    <option value="vision">My local AI model</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="date-order">Dates like 03/04/2026 mean</Label>
                  <Select
                    id="date-order"
                    value={settings.dateOrder}
                    disabled={!canSettings || savingSettings}
                    onChange={(e) => saveSettings({ dateOrder: e.target.value === 'dmy' ? 'dmy' : 'mdy' })}
                  >
                    <option value="mdy">March 4 (month first)</option>
                    <option value="dmy">3 April (day first)</option>
                  </Select>
                </div>
              </div>
              {!canSettings && <p className="text-xs text-navy/50">Only someone who can change company settings can change these.</p>}
            </div>
          )}
        </Card>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Remove this receipt?"
        message={`"${deleting?.filename ?? ''}" will be deleted from the inbox. This can't be undone.`}
        confirmLabel="Remove"
        onConfirm={confirmDelete}
        tone="danger"
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
