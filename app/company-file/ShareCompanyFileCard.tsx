'use client';
/**
 * "Share or move this company file" — Portable Company File (.bkp) create/open, the shareable
 * ledger (Excel / PDF), and a link to the running Transaction Log.
 *
 * Desktop: Create saves through a native Save dialog; Open runs the shell's flow (pick the
 * .bkp, pick where the new company file goes, restore + verify, offer to open it).
 * Browser: Open uploads the .bkp; it is restored into a new folder next to this company file.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FileArchive, FileSpreadsheet, FileText, FolderInput, ScrollText, Share2 } from 'lucide-react';
import { Button, Card, Modal, toast } from '@/components/ui';
import { savePortableCompanyFile, saveShareableLedger } from '@/lib/companyFileClient';

interface PortableSummary {
  companyName: string;
  createdAt: string;
  appVersion: string;
  rowCounts: Record<string, number>;
  transactionLogRecords: number;
  files: number;
}

interface RestoreResult {
  dataDir: string;
  companyName: string;
  verified: { tables: number; rows: number; files: number; transactionLogRecords: number };
}

interface ShareBridge {
  isDesktop?: boolean;
  portable?: { open?: () => Promise<unknown> };
  company?: { switch?: (dir: string) => Promise<unknown> };
}

function bridge(): ShareBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: ShareBridge }).bookkeeper;
}

export default function ShareCompanyFileCard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<null | 'bkp' | 'xlsx' | 'pdf' | 'inspect' | 'restore'>(null);
  const [pending, setPending] = useState<{ file: File; summary: PortableSummary } | null>(null);
  const [restored, setRestored] = useState<RestoreResult | null>(null);
  const [highlight, setHighlight] = useState(false);

  // Deep link from the desktop File menu (dev fallback) or other pages: ?share=1 / ?restore=portable.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('share') || params.get('restore')) {
      setHighlight(true);
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  async function run(kind: 'bkp' | 'xlsx' | 'pdf') {
    setBusy(kind);
    try {
      const saved = kind === 'bkp' ? await savePortableCompanyFile() : await saveShareableLedger(kind);
      if (saved) {
        toast(
          kind === 'bkp'
            ? `Portable company file saved: ${saved}`
            : `Shareable ledger (${kind === 'xlsx' ? 'Excel' : 'PDF'}) saved: ${saved}`,
          'success',
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Export failed.', 'danger');
    } finally {
      setBusy(null);
    }
  }

  function openPortable() {
    const b = bridge();
    if (b?.isDesktop && b.portable?.open) {
      b.portable.open();
      return;
    }
    inputRef.current?.click();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('inspect');
    try {
      const res = await fetch('/api/portable/restore?inspect=1', {
        method: 'POST',
        body: await file.arrayBuffer(),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'This file could not be read.');
      setPending({ file, summary: data as PortableSummary });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'This file could not be read.', 'danger');
    } finally {
      setBusy(null);
    }
  }

  async function confirmRestore() {
    if (!pending) return;
    setBusy('restore');
    try {
      const res = await fetch('/api/portable/restore', {
        method: 'POST',
        body: await pending.file.arrayBuffer(),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'The portable file could not be restored.');
      setPending(null);
      setRestored(data as RestoreResult);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The portable file could not be restored.', 'danger');
    } finally {
      setBusy(null);
    }
  }

  const s = pending?.summary;
  const desktop = Boolean(bridge()?.isDesktop);

  return (
    <div ref={cardRef}>
      <Card className={`p-6 mb-6 ${highlight ? 'ring-2 ring-electric/40' : ''}`}>
        <p className="text-lg font-bold text-navy flex items-center gap-2">
          <Share2 className="h-5 w-5 text-electric" /> Share or move this company file
        </p>

        <div className="mt-4 grid gap-5">
          <section>
            <p className="font-semibold text-navy">Portable company file (.bkp)</p>
            <p className="text-sm text-navy/60 mt-1 max-w-xl">
              One compact file with everything in this company file — transactions, lists, preferences, users,
              attachments and the transaction log. Use it to move to another computer or to hand the books to your
              accountant. Opening it creates a <span className="font-semibold">new</span> company file and checks that
              every number matches the original.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => run('bkp')} loading={busy === 'bkp'}>
                <FileArchive className="h-4 w-4" /> Create Portable File…
              </Button>
              <Button variant="secondary" onClick={openPortable} loading={busy === 'inspect'}>
                <FolderInput className="h-4 w-4" /> Open Portable File…
              </Button>
              <input ref={inputRef} type="file" accept=".bkp" className="hidden" onChange={onFile} />
            </div>
            <p className="text-xs text-navy/40 mt-2">
              Contains every user and password of this file — only owners and admins can create it. Keep it private.
            </p>
          </section>

          <section>
            <p className="font-semibold text-navy">Shareable ledger</p>
            <p className="text-sm text-navy/60 mt-1 max-w-xl">
              A read-only copy anyone can open without Ironbooks: an Excel workbook (company info, chart of accounts,
              trial balance, general ledger with running balances, journal, customers, vendors, items) or a PDF summary.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => run('xlsx')} loading={busy === 'xlsx'}>
                <FileSpreadsheet className="h-4 w-4" /> Excel workbook
              </Button>
              <Button variant="secondary" onClick={() => run('pdf')} loading={busy === 'pdf'}>
                <FileText className="h-4 w-4" /> PDF summary
              </Button>
            </div>
          </section>

          <section className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-4 py-3">
            <p className="text-sm text-navy/70">
              Every saved change is recorded in the tamper-evident transaction log.
            </p>
            <Link href="/transaction-log" className="inline-flex items-center gap-1.5 text-sm font-semibold text-electric hover:underline">
              <ScrollText className="h-4 w-4" /> View Transaction Log
            </Link>
          </section>
        </div>
      </Card>

      <Modal
        open={Boolean(pending)}
        onClose={() => busy !== 'restore' && setPending(null)}
        title="Open portable company file?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={busy === 'restore'}>
              Cancel
            </Button>
            <Button onClick={confirmRestore} loading={busy === 'restore'}>
              Restore as a new company file
            </Button>
          </>
        }
      >
        {s && (
          <div className="space-y-3 text-sm text-navy/70">
            <p>
              <span className="font-semibold text-navy">{s.companyName}</span> — created{' '}
              {new Date(s.createdAt).toLocaleString('en-US')} (Ironbooks {s.appVersion}).
            </p>
            <ul className="list-disc pl-5">
              <li>{(s.rowCounts.journal_entries ?? 0).toLocaleString()} journal entries</li>
              <li>
                {(s.rowCounts.customers ?? 0).toLocaleString()} customers, {(s.rowCounts.vendors ?? 0).toLocaleString()} vendors,{' '}
                {(s.rowCounts.items ?? 0).toLocaleString()} items
              </li>
              <li>{(s.rowCounts.users ?? 0).toLocaleString()} user(s), {s.files} attached file(s)</li>
              <li>{s.transactionLogRecords.toLocaleString()} transaction log records</li>
            </ul>
            <p>
              It will be restored into a new folder next to this company file. Your current company file is not changed.
              Sign in with the user names and passwords from the original file.
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(restored)}
        onClose={() => setRestored(null)}
        title="Portable file restored and verified"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRestored(null)}>
              Close
            </Button>
            {desktop && restored && (
              <Button onClick={() => bridge()?.company?.switch?.(restored.dataDir)}>Open it now</Button>
            )}
          </>
        }
      >
        {restored && (
          <div className="space-y-2 text-sm text-navy/70">
            <p>
              <span className="font-semibold text-navy">{restored.companyName}</span> was recreated and checked:{' '}
              {restored.verified.rows.toLocaleString()} records in {restored.verified.tables} tables, the trial balance,
              {` ${restored.verified.files}`} attached file(s) and {restored.verified.transactionLogRecords.toLocaleString()} log
              records all match the original.
            </p>
            <p className="break-all text-xs text-navy/50">Location: {restored.dataDir}</p>
            {!desktop && <p>Open it from the desktop app with File → Open Company.</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
