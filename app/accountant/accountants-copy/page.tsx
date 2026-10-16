'use client';
/**
 * Accountant's Copy (QB "Accountant's Copy", PARITY I1).
 *
 * Client file:   create the transfer file (.ibac) with a dividing date; while it is out, see what
 *                is locked; import the accountant's changes file (.ibcx) after reviewing every
 *                change; or cancel the copy.
 * Accountant:    open a client's .ibac as a new company file; in that copy, see the changes made
 *                so far (journal entries, checks, transfers, deposits, invoices, sales receipts,
 *                credit memos, payments, bills, bill payments, vendor credits, item receipts,
 *                inventory adjustments, estimates / orders, applied credits, reconciliations,
 *                accounts, classes, names and items) and save the changes file for the client.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, FileDown, FileUp, FolderInput, Lock, Send, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Label,
  Modal,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { desktopBridge, niceDate, postAndSave } from '@/lib/accountantCopyClient';
import { formatCurrency } from '@/lib/money';
import { BackToCenter } from '../_shared';

interface CopyRow {
  id: string;
  side: 'client' | 'accountant';
  status: string;
  dividingDate: string;
  createdAt: string;
  openedAt: string | null;
  exportedAt: string | null;
  exportCount: number;
  importedAt: string | null;
  cancelledAt: string | null;
  accountantNote: string | null;
  result: { applied?: Applied } | null;
}
interface Status {
  mode: 'none' | 'client' | 'accountant';
  current: CopyRow | null;
  history: CopyRow[];
  closingDate: string | null;
}
type Op = 'add' | 'edit' | 'void' | 'apply' | 'unapply' | 'reconcile' | 'undo';
interface Applied {
  accounts: number;
  classes: number;
  names?: number;
  added: number;
  changed: number;
  voided: number;
  applications?: number;
  reconciliations?: number;
}
interface ReviewItem {
  key: string;
  group: 'account' | 'class' | 'name' | 'transaction' | 'application' | 'reconciliation';
  op: Op;
  kind: string;
  date: string | null;
  title: string;
  amount: string | null;
  before: string[] | null;
  after: string[] | null;
  problem: string | null;
  note?: string | null;
  /** A name / item you also changed: you can keep your version of the fields you both changed. */
  keepable?: boolean;
  conflictFields?: string[];
}
interface Review {
  companyName: string;
  dividingDate: string;
  preparedBy: string | null;
  createdAt: string;
  note: string | null;
  warnings: string[];
  items: ReviewItem[];
  counts: { added: number; changed: number; voided: number; lists: number; applications?: number; reconciliations?: number };
  canImport: boolean;
  canImportKeepingMine?: boolean;
  closingDate: string | null;
  needsClosingPassword: boolean;
  formatVersion?: number;
}
interface SummaryRow {
  key: string;
  op: Op;
  kind: string;
  title: string;
  date: string | null;
  amount: string | null;
}
interface AccountantChanges {
  copy: { dividingDate: string; openedAt: string | null; exportedAt: string | null; exportCount: number; note: string | null };
  warnings: string[];
  /** Every change in plain language (what the client will see in their review). */
  summary: SummaryRow[];
}
interface TransferInfo {
  companyName: string;
  dividingDate: string;
  createdAt: string;
  createdBy: string | null;
  journalEntries: number;
  users: number;
}
interface Opened {
  dataDir: string;
  companyName: string;
  dividingDate: string;
}

const OP_LABEL: Record<Op, string> = {
  add: 'Added',
  edit: 'Changed',
  void: 'Voided',
  apply: 'Applied',
  unapply: 'Unapplied',
  reconcile: 'Reconciled',
  undo: 'Undone',
};
const OP_TONE: Record<Op, 'success' | 'info' | 'warning' | 'neutral'> = {
  add: 'success',
  edit: 'info',
  void: 'warning',
  apply: 'success',
  unapply: 'warning',
  reconcile: 'success',
  undo: 'warning',
};

/** "3 added, 2 changed, 1 voided, 4 list change(s), 2 application(s), 1 reconciliation(s)". */
function appliedText(a: Applied): string {
  const parts = [
    `${a.added} added`,
    `${a.changed} changed`,
    `${a.voided} voided`,
    `${a.accounts + a.classes + (a.names ?? 0)} list change(s)`,
  ];
  if (a.applications) parts.push(`${a.applications} application(s)`);
  if (a.reconciliations) parts.push(`${a.reconciliations} reconciliation(s)`);
  return parts.join(', ');
}

/** Last day of the month before the current LOCAL month (UTC month flipped early west of UTC). */
function lastMonthEnd(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10);
}

function statusLabel(r: CopyRow): { text: string; tone: 'success' | 'warning' | 'neutral' | 'info' } {
  if (r.status === 'outstanding') return { text: 'Out with accountant', tone: 'warning' };
  if (r.status === 'imported') return { text: 'Changes imported', tone: 'success' };
  if (r.status === 'cancelled') return { text: 'Cancelled', tone: 'neutral' };
  return { text: r.status, tone: 'info' };
}

export default function AccountantsCopyPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<Status>('/api/accountant-copy'));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the Accountant’s Copy status.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <BackToCenter />
      <PageHeader
        title="Accountant's Copy"
        icon={ArrowRightLeft}
        action={
          status?.mode === 'client' ? (
            <Badge tone="warning">Out with your accountant</Badge>
          ) : status?.mode === 'accountant' ? (
            <Badge tone="info">This is an Accountant&apos;s Copy</Badge>
          ) : null
        }
      />
      <p className="mb-6 max-w-3xl text-sm text-navy/60">
        Send your books to your accountant and keep working at the same time. You pick a <strong>dividing date</strong>: your
        accountant fixes things dated on or before it, you keep entering everything after it. When they send their changes back,
        you review them and bring them in with one click.
      </p>
      {loadError && (
        <Card className="mb-6 p-5 text-sm text-red-600" role="alert">
          {loadError}
        </Card>
      )}
      {status?.mode === 'none' && <ClientStart status={status} onChanged={load} />}
      {status?.mode === 'client' && status.current && <ClientOutstanding status={status} onChanged={load} />}
      {status?.mode === 'accountant' && status.current && <AccountantSide copy={status.current} closingDate={status.closingDate} />}
      {status && status.mode !== 'accountant' && <OpenTransferFile />}
      {status && status.mode !== 'accountant' && status.history.length > 0 && <History rows={status.history} />}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Client: create
// ---------------------------------------------------------------------------

function ClientStart({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [dividingDate, setDividingDate] = useState(lastMonthEnd());
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const res = await postAndSave('/api/accountant-copy', { dividingDate }, 'Company.ibac', {
        name: "Ironbooks Accountant's Copy",
        extensions: ['ibac'],
      });
      toast(
        res.saved
          ? `Accountant's Copy saved: ${res.saved}. Send it to your accountant.`
          : "The Accountant's Copy was created. Save it again from this page if you need another copy of the file.",
        'success',
      );
      onChanged();
    } catch (err) {
      toastError(err, "Could not create the Accountant's Copy.");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6 p-6">
      <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
        <FileDown className="h-5 w-5 text-electric" aria-hidden="true" /> Send your books to your accountant
      </h2>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <Label htmlFor="dividing-date" required>
            Dividing date
          </Label>
          <DateInput id="dividing-date" value={dividingDate} onChange={(e) => setDividingDate(e.target.value)} className="max-w-xs" />
          <p className="mt-1 text-xs text-navy/50">Usually the last day of the period your accountant is reviewing (for example, the end of last year).</p>
          <Button className="mt-4" onClick={create} loading={busy} disabled={!dividingDate}>
            <FileDown className="h-4 w-4" aria-hidden="true" /> Create Accountant&apos;s Copy…
          </Button>
        </div>
        <div className="text-sm text-navy/70">
          <p className="font-semibold text-navy">While the copy is with your accountant</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>You can&apos;t add, change or void transactions dated on or before {niceDate(dividingDate) || 'the dividing date'}.</li>
            <li>You can keep entering everything dated after it.</li>
            <li>Bank statements dated on or before it can&apos;t be reconciled (or un-reconciled) — your accountant does those.</li>
            <li>You can reconcile later statements, but if your accountant also reconciles that account, undo your later reconciliations before importing their changes (the review tells you which), then redo them.</li>
            <li>List entries (customers, vendors, items, accounts…) can&apos;t be deleted or merged, and accounts used on or before the dividing date can&apos;t be changed. You can still add new ones and edit names.</li>
          </ul>
          <p className="mt-3 text-xs text-navy/50">
            The file holds every user and password of this company file — only an admin can create it. Keep it private.
            {status.closingDate
              ? ` Your closing date (${niceDate(status.closingDate)}) still applies: your accountant needs the closing date password to change anything on or before it.`
              : ''}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Client: outstanding (import / cancel)
// ---------------------------------------------------------------------------

function ClientOutstanding({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const copy = status.current!;
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileJson, setFileJson] = useState<unknown>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<null | 'review' | 'import' | 'cancel'>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  /** Review keys of names / items you keep your version of. */
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const keepable = review ? review.items.filter((i) => i.problem && i.keepable) : [];
  const importable = Boolean(
    review && (review.canImport || (review.canImportKeepingMine && keepable.every((i) => keep.has(i.key)))),
  );

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('review');
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("This is not an accountant's changes file (.ibcx).");
      }
      setReview(await api.post<Review>('/api/accountant-copy/changes/review', parsed));
      setKeep(new Set());
      setFileJson(parsed);
    } catch (err) {
      toastError(err, 'Could not read the changes file.');
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    if (!fileJson) return;
    setBusy('import');
    try {
      const keys = keepable.filter((i) => keep.has(i.key)).map((i) => i.key);
      const url = `/api/accountant-copy/changes/import${keys.length ? `?keep=${encodeURIComponent(keys.join(','))}` : ''}`;
      const res = await api.post<{ applied: Applied; keptYours?: string[] }>(url, fileJson);
      const kept = res.keptYours?.length ? ` Kept your version: ${res.keptYours.join('; ')}.` : '';
      toast(`Imported: ${appliedText(res.applied)}. Your books are unlocked.${kept}`, 'success');
      setReview(null);
      setFileJson(null);
      onChanged();
    } catch (err) {
      toastError(err, "Could not import the accountant's changes. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  async function doCancel() {
    setBusy('cancel');
    try {
      await api.post('/api/accountant-copy/cancel');
      toast("Accountant's Copy cancelled. Your books are unlocked; that copy's changes file can no longer be imported.", 'success');
      setConfirmCancel(false);
      onChanged();
    } catch (err) {
      toastError(err, "Could not cancel the Accountant's Copy.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card className="mb-6 border-l-4 border-gold p-6">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
          <Lock className="h-5 w-5 text-yellow-700" aria-hidden="true" /> Your accountant has a copy of your books
        </h2>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-navy/60">Dividing date</dt>
          <dd className="font-semibold text-navy">{niceDate(copy.dividingDate)}</dd>
          <dt className="text-navy/60">Created</dt>
          <dd className="text-navy">{new Date(copy.createdAt).toLocaleString('en-US')}</dd>
        </dl>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-navy/70">
          <li>Transactions dated on or before {niceDate(copy.dividingDate)} are locked until you import your accountant&apos;s changes or cancel the copy.</li>
          <li>Keep entering transactions dated after {niceDate(copy.dividingDate)} as usual.</li>
          <li>Statements dated on or before {niceDate(copy.dividingDate)} can&apos;t be reconciled here for now. If you reconcile a later statement of an account your accountant also reconciles, the review asks you to undo it before importing (then redo it).</li>
          <li>List entries can&apos;t be deleted or merged for now, and accounts used on or before the dividing date can&apos;t be changed.</li>
        </ul>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={() => inputRef.current?.click()} loading={busy === 'review'}>
            <FileUp className="h-4 w-4" aria-hidden="true" /> Import accountant&apos;s changes…
          </Button>
          <Button variant="secondary" onClick={() => setConfirmCancel(true)}>
            <XCircle className="h-4 w-4" aria-hidden="true" /> Cancel Accountant&apos;s Copy
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".ibcx,application/json"
            className="hidden"
            aria-label="Accountant's changes file"
            onChange={onFile}
          />
        </div>
      </Card>

      {review && (
        <Card className="mb-6 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-navy">Review your accountant&apos;s changes</h2>
              <p className="text-sm text-navy/60">
                {review.preparedBy ? `From ${review.preparedBy}, ` : ''}saved {new Date(review.createdAt).toLocaleString('en-US')} ·{' '}
                {review.counts.added} added · {review.counts.changed} changed · {review.counts.voided} voided · {review.counts.lists} list change(s)
                {review.counts.applications ? ` · ${review.counts.applications} application(s)` : ''}
                {review.counts.reconciliations ? ` · ${review.counts.reconciliations} reconciliation(s)` : ''}
              </p>
              {review.formatVersion !== undefined && review.formatVersion < 3 && (
                <p className="text-xs text-navy/50">Made with an earlier version of Ironbooks (journal entries, checks, transfers, deposits, accounts and classes only).</p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setReview(null)} disabled={busy === 'import'}>
                Close
              </Button>
              <Button onClick={doImport} loading={busy === 'import'} disabled={!importable}>
                Import these changes
              </Button>
            </div>
          </div>
          {review.note && (
            <div className="mt-4 rounded-lg bg-electric/5 p-4 text-sm text-navy">
              <p className="font-semibold">Note from your accountant</p>
              <p className="mt-1 whitespace-pre-wrap">{review.note}</p>
            </div>
          )}
          {review.warnings.length > 0 && (
            <ul className="mt-4 list-disc space-y-1 rounded-lg bg-gold/10 p-4 pl-8 text-sm text-yellow-900">
              {review.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {review.needsClosingPassword && (
            <p className="mt-4 text-sm text-navy/70">
              Some changes are dated on or before your closing date ({niceDate(review.closingDate)}). You&apos;ll be asked for the closing
              date password when you import.
            </p>
          )}
          {!importable && (
            <p className="mt-4 text-sm font-semibold text-red-600" role="alert">
              {review.canImportKeepingMine
                ? 'You and your accountant both changed some names or items (see below). Tick "Keep mine" on each to keep your version, or ask your accountant.'
                : "Some changes can't be applied (see below). Ask your accountant about them; nothing will be imported until every change can be."}
            </p>
          )}
          <div className="mt-4">
            <Table>
              <thead>
                <tr>
                  <Th>Change</Th>
                  <Th>Date</Th>
                  <Th numeric>Amount</Th>
                  <Th>In your file now</Th>
                  <Th>Accountant&apos;s version</Th>
                </tr>
              </thead>
              <tbody>
                {review.items.map((i) => (
                  <Tr key={i.key} className={i.problem ? 'bg-red-50' : undefined}>
                    <Td className="align-top">
                      <Badge tone={OP_TONE[i.op]}>{OP_LABEL[i.op]}</Badge>
                      <p className="mt-1 text-sm font-medium">{i.title}</p>
                      <p className="text-xs text-navy/50">{i.kind}</p>
                      {i.problem && <p className="mt-1 text-xs font-semibold text-red-600">{i.problem}</p>}
                      {i.problem && i.keepable && (
                        <label className="mt-1 flex items-center gap-1.5 text-xs font-medium text-navy">
                          <input
                            type="checkbox"
                            checked={keep.has(i.key)}
                            onChange={(e) =>
                              setKeep((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(i.key);
                                else next.delete(i.key);
                                return next;
                              })
                            }
                          />
                          Keep mine{i.conflictFields?.length ? ` (${i.conflictFields.map((f) => f.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')})` : ''}
                        </label>
                      )}
                      {i.note && <p className="mt-1 text-xs text-yellow-800">{i.note}</p>}
                    </Td>
                    <Td className="align-top whitespace-nowrap text-sm">{niceDate(i.date)}</Td>
                    <Td numeric className="align-top text-sm">{i.amount ? formatCurrency(i.amount) : ''}</Td>
                    <Td className="align-top text-xs text-navy/70">
                      {i.before ? i.before.map((l, n) => <p key={n}>{l}</p>) : <span className="text-navy/40">—</span>}
                    </Td>
                    <Td className="align-top text-xs text-navy/70">
                      {i.after ? i.after.map((l, n) => <p key={n}>{l}</p>) : i.op === 'void' ? <span>Voided</span> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            {review.items.length === 0 && <p className="py-4 text-sm text-navy/60">No transaction or list changes — only a note.</p>}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel the Accountant's Copy?"
        tone="danger"
        confirmLabel="Cancel the copy"
        loading={busy === 'cancel'}
        message={
          "Your books will be unlocked right away. Any changes your accountant makes in that copy can no longer be imported — they would have to start over from a new Accountant's Copy, or you enter their changes yourself."
        }
        onConfirm={doCancel}
        onClose={() => setConfirmCancel(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Accountant: open a transfer file / work in the copy
// ---------------------------------------------------------------------------

function OpenTransferFile() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; info: TransferInfo } | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [busy, setBusy] = useState<null | 'inspect' | 'open'>(null);
  const desktop = Boolean(desktopBridge()?.isDesktop);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('inspect');
    try {
      const res = await fetch('/api/accountant-copy/open?inspect=1', { method: 'POST', body: await file.arrayBuffer() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'This file could not be read.');
      setPending({ file, info: data as TransferInfo });
    } catch (err) {
      toastError(err, 'This file could not be read.');
    } finally {
      setBusy(null);
    }
  }

  async function confirmOpen() {
    if (!pending) return;
    setBusy('open');
    try {
      const res = await fetch('/api/accountant-copy/open', { method: 'POST', body: await pending.file.arrayBuffer() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "The Accountant's Copy could not be opened.");
      setPending(null);
      setOpened(data as Opened);
    } catch (err) {
      toastError(err, "The Accountant's Copy could not be opened.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card className="mb-6 p-6">
        <h2 className="flex items-center gap-2 text-lg font-bold text-navy">
          <FolderInput className="h-5 w-5 text-electric" aria-hidden="true" /> For accountants: open a client&apos;s Accountant&apos;s Copy
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-navy/60">
          Opening an <span className="font-mono">.ibac</span> file creates a <strong>new</strong> company file next to this one (this file is not
          changed). In it you can enter and fix journal entries, checks, expenses and credit card charges, transfers, deposits, invoices, sales receipts, credit
          memos, payments, bills, bill payments, vendor credits, item receipts, inventory adjustments, estimates and orders, apply credits, reconcile,
          and add or edit accounts, classes, customers, vendors, items and other names — all dated on or before the dividing date. Then you save a
          changes file for your client.
        </p>
        <Button className="mt-4" variant="secondary" onClick={() => inputRef.current?.click()} loading={busy === 'inspect'}>
          <FolderInput className="h-4 w-4" aria-hidden="true" /> Open Accountant&apos;s Copy…
        </Button>
        <input ref={inputRef} type="file" accept=".ibac" className="hidden" aria-label="Accountant's Copy transfer file" onChange={onFile} />
      </Card>

      <Modal
        open={Boolean(pending)}
        onClose={() => busy !== 'open' && setPending(null)}
        title="Open this Accountant's Copy?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={busy === 'open'}>
              Cancel
            </Button>
            <Button onClick={confirmOpen} loading={busy === 'open'}>
              Open as a new company file
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-2 text-sm text-navy/70">
            <p>
              <span className="font-semibold text-navy">{pending.info.companyName}</span> — dividing date{' '}
              <span className="font-semibold text-navy">{niceDate(pending.info.dividingDate)}</span>, made{' '}
              {new Date(pending.info.createdAt).toLocaleString('en-US')}
              {pending.info.createdBy ? ` by ${pending.info.createdBy}` : ''}.
            </p>
            <p>
              {pending.info.journalEntries.toLocaleString()} journal entries, {pending.info.users} user(s). Every number is checked against the
              original while it opens. Sign in to it with a user name and password from your client&apos;s file.
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(opened)}
        onClose={() => setOpened(null)}
        title="Accountant's Copy opened and verified"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpened(null)}>
              Close
            </Button>
            {desktop && opened && <Button onClick={() => desktopBridge()?.company?.switch?.(opened.dataDir)}>Open it now</Button>}
          </>
        }
      >
        {opened && (
          <div className="space-y-2 text-sm text-navy/70">
            <p>
              <span className="font-semibold text-navy">{opened.companyName}</span> is ready. Work on transactions dated on or before{' '}
              {niceDate(opened.dividingDate)}, then come back to this page in that file to save the changes for your client.
            </p>
            <p className="break-all text-xs text-navy/50">Location: {opened.dataDir}</p>
            {!desktop && <p>Open it from the desktop app with File → Open Company.</p>}
          </div>
        )}
      </Modal>
    </>
  );
}

function AccountantSide({ copy, closingDate }: { copy: CopyRow; closingDate: string | null }) {
  const [changes, setChanges] = useState<AccountantChanges | null>(null);
  const [note, setNote] = useState(copy.accountantNote ?? '');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setChanges(await api.get<AccountantChanges>('/api/accountant-copy/changes'));
    } catch (err) {
      toastError(err, 'Could not load your changes.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const res = await postAndSave('/api/accountant-copy/changes', { note }, 'Changes.ibcx', {
        name: "Ironbooks Accountant's Changes",
        extensions: ['ibcx'],
      });
      if (res.saved) toast(`Changes file saved: ${res.saved}. Send it to your client.`, 'success');
      await load();
    } catch (err) {
      toastError(err, 'Could not save the changes file.');
    } finally {
      setBusy(false);
    }
  }

  const total = changes ? changes.summary.length : 0;

  return (
    <>
      <Card className="mb-6 border-l-4 border-electric p-6">
        <h2 className="text-lg font-bold text-navy">You are working in an Accountant&apos;s Copy</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-navy/70">
          <li>Dividing date: <strong>{niceDate(copy.dividingDate)}</strong>. You can only work on transactions dated on or before it.</li>
          <li>
            You can enter, change and void journal entries, checks, expenses and credit card charges, transfers, deposits, invoices, sales receipts,
            credit memos, received payments, bills, bill payments, vendor credits and item receipts; add inventory adjustments; work on estimates, sales
            orders and purchase orders; apply credits and journal entry lines; reconcile (and undo the last reconciliation of) statements; and add or edit
            accounts, classes, customers, vendors, items and other names.
          </li>
          <li>
            Not available here, because they can&apos;t be sent back: deleting, merging or making list entries inactive, changing a list entry&apos;s type,
            accounts or place in the list, turning estimates, orders or item receipts into invoices or bills, adding billable time and costs to an
            invoice, voiding or changing an inventory adjustment (enter a new one that corrects the quantity), a quantity on hand typed on a new item
            (save the item, then enter an inventory adjustment), refunds, bounced checks, payroll, and
            anything dated after the dividing date.
          </li>
          {closingDate && <li>The client&apos;s closing date ({niceDate(closingDate)}) still applies; changes on or before it need the closing date password.</li>}
          <li>When you are done, save the changes file and send it to your client. You can save it again later if you make more changes.</li>
        </ul>
      </Card>

      <Card className="mb-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-navy">Your changes so far</h2>
          {copy.exportedAt && (
            <span className="text-xs text-navy/50">Last saved for your client {new Date(copy.exportedAt).toLocaleString('en-US')}</span>
          )}
        </div>
        {!changes ? (
          <p className="mt-3 text-sm text-navy/50">Loading…</p>
        ) : total === 0 ? (
          <EmptyState title="No changes yet" message="Make your adjusting entries and corrections, then come back here." />
        ) : (
          <div className="mt-3">
            <Table>
              <thead>
                <tr>
                  <Th>Change</Th>
                  <Th>Date</Th>
                  <Th numeric>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {changes.summary.map((r) => (
                  <Tr key={r.key}>
                    <Td>
                      <Badge tone={OP_TONE[r.op]}>{OP_LABEL[r.op]}</Badge> {r.title}
                      <span className="block text-xs text-navy/50">{r.kind}</span>
                    </Td>
                    <Td className="whitespace-nowrap">{r.date ? niceDate(r.date) : ''}</Td>
                    <Td numeric>{r.amount ? formatCurrency(r.amount) : ''}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {changes && changes.warnings.length > 0 && (
          <ul className="mt-4 list-disc space-y-1 rounded-lg bg-gold/10 p-4 pl-8 text-sm text-yellow-900">
            {changes.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <div className="mt-5">
          <Label htmlFor="acct-note">Note for your client (optional)</Label>
          <textarea
            id="acct-note"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
            placeholder="Explain your adjustments, or list anything your client should change themselves."
          />
        </div>
        <Button className="mt-4" onClick={save} loading={busy} disabled={total === 0 && !note.trim()}>
          <Send className="h-4 w-4" aria-hidden="true" /> Save changes file for your client…
        </Button>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function History({ rows }: { rows: CopyRow[] }) {
  return (
    <Card className="mb-6 p-6">
      <h2 className="text-lg font-bold text-navy">Earlier Accountant&apos;s Copies</h2>
      <Table>
        <thead>
          <tr>
            <Th>Dividing date</Th>
            <Th>Created</Th>
            <Th>Status</Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = statusLabel(r);
            const a = r.result?.applied;
            return (
              <Tr key={r.id}>
                <Td>{niceDate(r.dividingDate)}</Td>
                <Td>{new Date(r.createdAt).toLocaleDateString('en-US')}</Td>
                <Td>
                  <Badge tone={s.tone}>{s.text}</Badge>
                </Td>
                <Td className="text-sm text-navy/70">
                  {a ? appliedText(a) : ''}
                  {r.importedAt ? ` on ${new Date(r.importedAt).toLocaleDateString('en-US')}` : ''}
                  {r.cancelledAt ? `Cancelled ${new Date(r.cancelledAt).toLocaleDateString('en-US')}` : ''}
                  {r.accountantNote ? <span className="block text-xs text-navy/50">Note: {r.accountantNote}</span> : null}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
