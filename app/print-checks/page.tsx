'use client';

/**
 * Print Checks page — QB-style "Print Checks" (wave2 purchases D3/D4).
 *
 * Sections:
 *  1. Checks to Print — ONE queue for every source: checks written with "Print later", bill
 *     payments marked "To be printed" and paychecks added to the queue. Printing a check renders
 *     its PDF (in the company's check style) AND stamps the check number on the recorded
 *     transaction and its journal entry. A number already used on the account asks first.
 *  2. Add paychecks — paychecks that were never printed can be added to the queue.
 *     Add refund checks — customer refunds paid from a bank account (D3) can be added too.
 *     Sales Tax Payment and Liability checks saved "To be printed" appear in the queue directly.
 *  3. Printer setup — check paper, check style (voucher / standard / wallet), where the check is
 *     on the sheet, checks left on a partly used sheet, paper size, check height, alignment nudges
 *     and (advanced) the position of every printed field, with an alignment test page that uses
 *     the unsaved setup. Works with any pre-cut / pre-printed check stock.
 *  Printing several selected checks records their numbers one by one (asking before reusing a
 *  number) and produces ONE PDF (standard checks three to a sheet).
 *  4. Quick Check — ad-hoc check PDF that is not recorded.
 */

import { useState, useEffect, useCallback } from 'react';
import { Printer, RefreshCw, Settings2, UserPlus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { numberToWords } from '@/lib/pdf/check';
import {
  CHECK_FIELD_KEYS,
  CHECK_FIELD_LABELS,
  OPTIONAL_CHECK_FIELDS,
  defaultCheckLayout,
  diffCheckLayout,
  resolveCheckLayout,
  type CheckFieldKey,
  type CheckLayout,
  type CheckLayoutOverrides,
  type CheckPageSize,
  type CheckPosition,
} from '@/lib/pdf/checkLayout';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { checkNumberSeries, nextCheckNumber } from './checkNumbers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PrintSource = 'expense' | 'bill_payment' | 'paycheck' | 'payment_check';

interface UnprintedRefund {
  entryId: string;
  date: string;
  payee: string;
  amount: string;
  paymentAccountName: string;
}

interface QueueItem {
  source: PrintSource;
  id: string;
  date: string;
  payee: string;
  amount: string;
  memo: string | null;
  paymentAccountId: string | null;
  paymentAccountName: string | null;
}

interface UnprintedPaycheck {
  id: string;
  payDate: string;
  employee: string;
  netPay: string;
}

type CheckStyle = 'voucher' | 'standard' | 'wallet';

type CheckStock = 'preprinted' | 'blank';

interface PrintSettings {
  style: CheckStyle;
  stock: CheckStock;
  offsetX: string;
  offsetY: string;
  position: CheckPosition;
  pageSize: CheckPageSize;
  checkHeight: string;
  firstSheetRemaining: number;
  layout: CheckLayoutOverrides | null;
}

/** Field positions as edited in the form (inches / points as typed). */
type LayoutDraft = Record<CheckFieldKey, { x: string; y: string; size: string; show: boolean }>;

function toDraft(l: CheckLayout): LayoutDraft {
  const out = {} as LayoutDraft;
  for (const k of CHECK_FIELD_KEYS) out[k] = { x: String(l[k].x), y: String(l[k].y), size: String(l[k].size), show: l[k].show };
  return out;
}

/** The draft as layout overrides (blank inputs fall back to the standard position). */
function fromDraft(d: LayoutDraft): CheckLayoutOverrides {
  const out: Record<string, Record<string, unknown>> = {};
  for (const k of CHECK_FIELD_KEYS) {
    const f: Record<string, unknown> = {};
    for (const p of ['x', 'y', 'size'] as const) if (d[k][p].trim() !== '') f[p] = d[k][p].trim();
    if (OPTIONAL_CHECK_FIELDS.includes(k)) f.show = d[k].show;
    out[k] = f;
  }
  return out as CheckLayoutOverrides;
}

/** Same layout as numbers (for switching styles); unparsable values are dropped. */
function draftNumbers(d: LayoutDraft): CheckLayoutOverrides {
  const out: CheckLayoutOverrides = {};
  for (const k of CHECK_FIELD_KEYS) {
    const f: { x?: number; y?: number; size?: number; show?: boolean } = {};
    for (const p of ['x', 'y', 'size'] as const) {
      const n = Number(d[k][p]);
      if (d[k][p].trim() !== '' && Number.isFinite(n)) f[p] = n;
    }
    if (OPTIONAL_CHECK_FIELDS.includes(k)) f.show = d[k].show;
    out[k] = f;
  }
  return out;
}

const DEFAULT_SETTINGS: PrintSettings = {
  style: 'voucher',
  stock: 'preprinted',
  offsetX: '0',
  offsetY: '0',
  position: 'top',
  pageSize: 'letter',
  checkHeight: '3.50',
  firstSheetRemaining: 3,
  layout: null,
};

const POSITION_HELP: Record<CheckPosition, string> = {
  top: 'The check is the top part of the sheet; the stubs are below it.',
  middle: 'The check is in the middle of the sheet, between two stubs.',
  bottom: 'The check is the bottom part of the sheet; the stubs are above it.',
};

const SOURCE_LABEL: Record<PrintSource, string> = {
  expense: 'Check',
  bill_payment: 'Bill payment',
  paycheck: 'Paycheck',
  payment_check: 'Tax / liability / refund',
};

const STOCK_HELP: Record<CheckStock, string> = {
  preprinted:
    'Your bank checks already show the lines, labels and bank numbers. Only the date, payee, amount and memo are printed.',
  blank: 'Plain paper: the whole check is drawn. No bank (MICR) line is printed, so these are for records or hand-signed use.',
};

const STYLE_HELP: Record<CheckStyle, string> = {
  voucher: 'Check on top with a detail stub below (shows the bills or expenses paid).',
  standard: 'Just the check, no detail stub.',
  wallet: 'Smaller check with a stub on the left for your checkbook register.',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a check PDF via the API and open it in a new tab. */
async function openCheckPdf(args: Record<string, unknown>) {
  const res = await fetch('/api/checks/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server error ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PrintChecksPage() {
  // ── Print queue state ─────────────────────────────────────────────────────
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [nextNumber, setNextNumber] = useState('');
  const [printingId, setPrintingId] = useState<string | null>(null);

  // ── Paychecks not yet queued ──────────────────────────────────────────────
  const [unprinted, setUnprinted] = useState<UnprintedPaycheck[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [queuingPaychecks, setQueuingPaychecks] = useState(false);

  // ── Printer setup ─────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<PrintSettings>(DEFAULT_SETTINGS);
  const [layoutDraft, setLayoutDraft] = useState<LayoutDraft>(() => toDraft(defaultCheckLayout('voucher')));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Printing several checks into one PDF ──────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runRemaining, setRunRemaining] = useState(3);
  const [printingBatch, setPrintingBatch] = useState(false);

  // ── Customer refunds not yet printed (D3) ─────────────────────────────────
  const [refunds, setRefunds] = useState<UnprintedRefund[]>([]);
  const [queuingRefund, setQueuingRefund] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [testing, setTesting] = useState(false);

  // ── Quick-check form state ────────────────────────────────────────────────
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => todayISO());
  const [memo, setMemo] = useState('');
  const [checkNumber, setCheckNumber] = useState('');
  const [generating, setGenerating] = useState(false);
  const [amountWords, setAmountWords] = useState('');

  // ── Loading ───────────────────────────────────────────────────────────────

  const refreshQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const [queueData, nextData, pcData, refundData] = await Promise.all([
        api.get<{ items: QueueItem[] }>('/api/print-queue'),
        api.get<{ next: string }>('/api/check-numbers/next'),
        api.get<{ paychecks: UnprintedPaycheck[] }>('/api/print-queue/paychecks').catch(() => ({ paychecks: [] })),
        api.get<{ items: UnprintedRefund[] }>('/api/print-queue/refunds').catch(() => ({ items: [] })),
      ]);
      setQueue(queueData.items);
      setNextNumber((prev) => prev || nextData.next);
      setUnprinted(pcData.paychecks);
      setRefunds(refundData.items);
      setPicked(new Set());
      setSelected(new Set());
    } catch (err) {
      toastError(err, 'Failed to load the print queue.');
    } finally {
      setQueueLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshQueue();
    api
      .get<PrintSettings>('/api/checks/settings')
      .then((s) => {
        const merged = { ...DEFAULT_SETTINGS, ...s };
        setSettings(merged);
        setLayoutDraft(toDraft(resolveCheckLayout(merged.style, merged.layout)));
        setRunRemaining(merged.firstSheetRemaining);
      })
      .catch(() => {
        /* defaults are fine */
      });
  }, [refreshQueue]);

  useEffect(() => {
    const n = parseFloat(amount);
    setAmountWords(!amount || isNaN(n) || n < 0 ? '' : numberToWords(amount));
  }, [amount]);

  // ── Print a queued check ──────────────────────────────────────────────────

  async function handlePrintQueued(item: QueueItem) {
    const num = nextNumber.trim();
    if (!num) {
      toast('Enter the number printed on the first check in the printer.', 'danger');
      return;
    }
    setPrintingId(item.id);
    let recorded = false;
    try {
      // 1. Record the number first (asks before reusing a number), then render the PDF.
      const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.post('/api/print-queue', { source: item.source, id: item.id, checkNumber: num, allowDuplicateNumber }),
      );
      if (saved === null) return; // user chose a different number
      recorded = true;
      // The number is used from here on, whatever happens to the PDF: advance to the next one
      // (keeping its padding / prefix) and take the check off the queue, as a batch run does.
      // A PDF failure used to leave both, so the next check was printed with the same number.
      const next = nextCheckNumber(num);
      if (next) setNextNumber(next);
      setQueue((prev) => prev.filter((q) => !(q.id === item.id && q.source === item.source)));
      await openCheckPdf({ source: item.source, id: item.id, checkNumber: num, firstSheetRemaining: runRemaining });
      toast(`Check #${num} printed and recorded.`, 'success');
      // Standard checks: one fewer left on the sheet (a fresh sheet after the last one).
      if (settings.style === 'standard') setRunRemaining((r) => (r <= 1 ? 3 : r - 1));
    } catch (err) {
      toast(
        errMsg(err, recorded ? `Check #${num} was recorded but the PDF could not be opened.` : 'Failed to print check.'),
        'danger',
      );
    } finally {
      setPrintingId(null);
    }
  }

  // ── Print the selected checks into ONE PDF ────────────────────────────────

  const itemKey = (q: QueueItem) => `${q.source}:${q.id}`;

  async function handlePrintSelected() {
    const items = queue.filter((q) => selected.has(itemKey(q)));
    if (items.length === 0) {
      toast('Tick the checks you want to print.', 'danger');
      return;
    }
    const num = nextNumber.trim();
    if (!num) {
      toast('Enter the number printed on the first check in the printer.', 'danger');
      return;
    }
    // One number per check, stepped like the + key (padding and prefix kept: 001099 → 001100).
    const numbers = checkNumberSeries(num, items.length);
    if (!numbers) {
      toast('To print several checks at once, the next check number must end in digits (e.g. 1001).', 'danger');
      return;
    }
    setPrintingBatch(true);
    const printed: Array<{ item: QueueItem; checkNumber: string }> = [];
    try {
      // 1. Record each number in order (asks before reusing a number). Stop at the first check the
      //    user does not confirm, so the numbers stay in step with the check paper.
      for (let i = 0; i < items.length; i++) {
        const checkNumber = numbers[i];
        const item = items[i];
        const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
          api.post('/api/print-queue', { source: item.source, id: item.id, checkNumber, allowDuplicateNumber }),
        );
        if (saved === null) break; // user chose a different number
        printed.push({ item, checkNumber });
      }
    } catch (err) {
      toast(errMsg(err, 'Failed to record a check number.'), 'danger');
    }
    try {
      if (printed.length === 0) return;
      // 2. One PDF for every recorded check.
      await openCheckPdf({
        items: printed.map((p) => ({ source: p.item.source, id: p.item.id, checkNumber: p.checkNumber })),
        firstSheetRemaining: runRemaining,
      });
      const first = printed[0].checkNumber;
      const last = printed[printed.length - 1].checkNumber;
      toast(
        printed.length === 1 ? `Check #${first} printed and recorded.` : `Checks #${first}–${last} printed and recorded.`,
        'success',
      );
      if (printed.length < items.length) toast('Printing stopped early; the other checks are still in the queue.', 'danger');
      // Standard checks: what is left of the last sheet is the next run's first sheet.
      if (settings.style === 'standard') {
        const left = (3 - ((3 - runRemaining + printed.length) % 3)) % 3;
        setRunRemaining(left === 0 ? 3 : left);
      }
    } catch (err) {
      toast(errMsg(err, 'The checks were recorded but the PDF could not be opened.'), 'danger');
    } finally {
      // Advance the number past every check that was recorded.
      if (printed.length > 0) {
        const next = nextCheckNumber(printed[printed.length - 1].checkNumber);
        if (next) setNextNumber(next);
      }
      const done = new Set(printed.map((p) => itemKey(p.item)));
      setQueue((prev) => prev.filter((q) => !done.has(itemKey(q))));
      setSelected((prev) => new Set([...prev].filter((k) => !done.has(k))));
      setPrintingBatch(false);
    }
  }

  // ── Queue paychecks ───────────────────────────────────────────────────────

  async function handleQueuePaychecks() {
    if (picked.size === 0) {
      toast('Tick the paychecks you want to print.', 'danger');
      return;
    }
    setQueuingPaychecks(true);
    try {
      await api.post('/api/print-queue/paychecks', { paycheckIds: [...picked] });
      toast(`${picked.size} paycheck${picked.size === 1 ? '' : 's'} added to the queue.`, 'success');
      await refreshQueue();
    } catch (err) {
      toastError(err, 'Could not add the paychecks.');
    } finally {
      setQueuingPaychecks(false);
    }
  }

  // ── Queue a customer refund check ─────────────────────────────────────────

  async function handleQueueRefund(r: UnprintedRefund) {
    setQueuingRefund(r.entryId);
    try {
      await api.post('/api/print-queue/refunds', { entryId: r.entryId });
      toast(`Refund check to ${r.payee} added to the queue.`, 'success');
      await refreshQueue();
    } catch (err) {
      toastError(err, 'Could not add the refund check.');
    } finally {
      setQueuingRefund(null);
    }
  }

  // ── Printer setup ─────────────────────────────────────────────────────────

  function offsetOk(v: string) {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && Math.abs(n) <= 1;
  }

  async function handleSaveSettings() {
    if (!offsetOk(settings.offsetX) || !offsetOk(settings.offsetY)) {
      toast('Alignment must be between -1 and 1 inch.', 'danger');
      return;
    }
    setSavingSettings(true);
    try {
      const saved = await api.put<PrintSettings>('/api/checks/settings', {
        style: settings.style,
        stock: settings.stock,
        offsetX: settings.offsetX,
        offsetY: settings.offsetY,
        position: settings.position,
        pageSize: settings.pageSize,
        checkHeight: settings.checkHeight,
        firstSheetRemaining: settings.firstSheetRemaining,
        layout: fromDraft(layoutDraft),
      });
      const merged = { ...DEFAULT_SETTINGS, ...saved };
      setSettings(merged);
      setLayoutDraft(toDraft(resolveCheckLayout(merged.style, merged.layout)));
      setRunRemaining(merged.firstSheetRemaining);
      toast('Printer setup saved.', 'success');
    } catch (err) {
      toastError(err, 'Could not save the printer setup.');
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleAlignmentTest() {
    if (!offsetOk(settings.offsetX) || !offsetOk(settings.offsetY)) {
      toast('Alignment must be between -1 and 1 inch.', 'danger');
      return;
    }
    setTesting(true);
    try {
      await openCheckPdf({
        alignmentTest: true,
        style: settings.style,
        stock: settings.stock,
        offsetX: settings.offsetX,
        offsetY: settings.offsetY,
        position: settings.position,
        pageSize: settings.pageSize,
        checkHeight: settings.checkHeight,
        firstSheetRemaining: settings.firstSheetRemaining,
        layout: fromDraft(layoutDraft),
      });
    } catch (err) {
      toast(errMsg(err, 'Could not print the test page.'), 'danger');
    } finally {
      setTesting(false);
    }
  }

  /** Switching styles keeps the fields you moved and puts the rest at the new style's positions. */
  function changeStyle(style: CheckStyle) {
    const custom = diffCheckLayout(settings.style, draftNumbers(layoutDraft));
    setLayoutDraft(toDraft(resolveCheckLayout(style, custom)));
    setSettings((s) => ({ ...s, style }));
  }

  function resetLayout() {
    setLayoutDraft(toDraft(defaultCheckLayout(settings.style)));
    toast('Field positions are back to the standard positions. Save the setup to keep them.', 'success');
  }

  function setField(k: CheckFieldKey, patch: Partial<LayoutDraft[CheckFieldKey]>) {
    setLayoutDraft((d) => ({ ...d, [k]: { ...d[k], ...patch } }));
  }

  // ── Quick-check generator (ad-hoc, not recorded) ──────────────────────────

  async function handleGenerate() {
    if (!payee.trim()) {
      toast('Payee name is required.', 'danger');
      return;
    }
    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      toast('Amount must be a positive number.', 'danger');
      return;
    }
    if (!date) {
      toast('Date is required.', 'danger');
      return;
    }
    setGenerating(true);
    try {
      await openCheckPdf({
        payee: payee.trim(),
        amount: amountNum.toFixed(2),
        date,
        memo: memo.trim() || undefined,
        checkNumber: checkNumber.trim() || undefined,
      });
      toast('Check PDF opened in a new tab.', 'success');
    } catch (err) {
      toast(errMsg(err, 'Failed to generate check PDF.'), 'danger');
    } finally {
      setGenerating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        <PageHeader title="Print Checks" icon={Printer} />

        {/* Print queue */}
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-navy">Checks to Print</h2>
              <p className="text-sm text-navy/50">
                Checks written with &quot;Print later&quot;, bill payments marked &quot;To be printed&quot;, and
                paychecks you added below. Printing records the check number on the transaction. Tick several
                checks and use &quot;Print selected&quot; to get them all in one PDF.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={refreshQueue} disabled={queueLoading}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
          </div>

          <div className="flex items-end gap-3">
            <div className="w-44">
              <Label htmlFor="next-number">Next Check Number</Label>
              <Input
                id="next-number"
                placeholder="e.g. 1001"
                value={nextNumber}
                onChange={(e) => setNextNumber(e.target.value)}
              />
            </div>
            {settings.style === 'standard' && queue.length > 0 && (
              <div className="w-56">
                <Label htmlFor="run-remaining">Checks left on the first sheet</Label>
                <Select id="run-remaining" value={String(runRemaining)} onChange={(e) => setRunRemaining(Number(e.target.value))}>
                  <option value="3">3 (a full sheet)</option>
                  <option value="2">2 (top check used)</option>
                  <option value="1">1 (top two used)</option>
                </Select>
              </div>
            )}
            {queue.length > 0 && (
              <Badge tone="warning">
                {queue.length} check{queue.length === 1 ? '' : 's'} queued
              </Badge>
            )}
            {queue.length > 0 && (
              <Button className="ml-auto" onClick={handlePrintSelected} loading={printingBatch} disabled={selected.size === 0}>
                <Printer className="h-4 w-4" />
                Print selected ({selected.size})
              </Button>
            )}
          </div>

          {queueLoading ? (
            <div className="p-8 flex items-center justify-center gap-2 text-navy/40 text-sm">
              <Spinner className="h-4 w-4" /> Loading queue…
            </div>
          ) : queue.length === 0 ? (
            <EmptyState
              icon={Printer}
              title="No checks waiting to print"
              message='Write a check with "Print later", pay bills with "To be printed", or add paychecks below.'
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Select all checks"
                      className="h-4 w-4 accent-electric"
                      checked={queue.length > 0 && queue.every((q) => selected.has(itemKey(q)))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(queue.map(itemKey)) : new Set())}
                    />
                  </Th>
                  <Th>Date</Th>
                  <Th>Type</Th>
                  <Th>Pay to</Th>
                  <Th>Bank Account</Th>
                  <Th>Memo</Th>
                  <Th numeric>Amount</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {queue.map((q) => (
                  <Tr key={itemKey(q)}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Select check to ${q.payee || 'payee'}`}
                        className="h-4 w-4 accent-electric"
                        checked={selected.has(itemKey(q))}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(itemKey(q));
                            else next.delete(itemKey(q));
                            return next;
                          })
                        }
                      />
                    </Td>
                    <Td>{q.date ? formatDate(q.date, 'MMM d, yyyy') : '—'}</Td>
                    <Td>
                      <Badge
                        tone={
                          q.source === 'paycheck'
                            ? 'success'
                            : q.source === 'bill_payment'
                              ? 'neutral'
                              : q.source === 'payment_check'
                                ? 'warning'
                                : 'info'
                        }
                      >
                        {SOURCE_LABEL[q.source]}
                      </Badge>
                    </Td>
                    <Td className="font-medium">{q.payee || '—'}</Td>
                    <Td>{q.paymentAccountName ?? '—'}</Td>
                    <Td className="text-navy/60">{q.memo ?? '—'}</Td>
                    <Td numeric className="font-semibold">
                      {formatCurrency(q.amount)}
                    </Td>
                    <Td className="text-right">
                      <Button size="sm" loading={printingId === q.id} onClick={() => handlePrintQueued(q)}>
                        <Printer className="h-4 w-4" />
                        Print &amp; Record
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {/* Add paychecks */}
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-navy">Add Paychecks to the Queue</h2>
              <p className="text-sm text-navy/50">Paychecks that have not been printed yet. Tick the ones to print.</p>
            </div>
            <Button size="sm" onClick={handleQueuePaychecks} loading={queuingPaychecks} disabled={picked.size === 0}>
              <UserPlus className="h-4 w-4" />
              Add to queue
            </Button>
          </div>
          {unprinted.length === 0 ? (
            <p className="text-sm text-navy/40">No unprinted paychecks.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>
                    <input
                      type="checkbox"
                      aria-label="Select all paychecks"
                      className="h-4 w-4 accent-electric"
                      checked={picked.size === unprinted.length}
                      onChange={(e) => setPicked(e.target.checked ? new Set(unprinted.map((p) => p.id)) : new Set())}
                    />
                  </Th>
                  <Th>Pay date</Th>
                  <Th>Employee</Th>
                  <Th numeric>Net pay</Th>
                </tr>
              </thead>
              <tbody>
                {unprinted.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Select paycheck for ${p.employee}`}
                        className="h-4 w-4 accent-electric"
                        checked={picked.has(p.id)}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          })
                        }
                      />
                    </Td>
                    <Td>{formatDate(p.payDate, 'MMM d, yyyy')}</Td>
                    <Td className="font-medium">{p.employee}</Td>
                    <Td numeric>{formatCurrency(p.netPay)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {/* Customer refund checks (D3) */}
        <Card className="p-6 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-navy">Add Refund Checks to the Queue</h2>
            <p className="text-sm text-navy/50">
              Refunds you gave customers from a bank account that have no check number yet.
            </p>
          </div>
          {refunds.length === 0 ? (
            <p className="text-sm text-navy/40">No refunds waiting for a check.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th>Bank Account</Th>
                  <Th numeric>Amount</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => (
                  <Tr key={r.entryId}>
                    <Td>{formatDate(r.date, 'MMM d, yyyy')}</Td>
                    <Td className="font-medium">{r.payee}</Td>
                    <Td>{r.paymentAccountName}</Td>
                    <Td numeric>{formatCurrency(r.amount)}</Td>
                    <Td className="text-right">
                      <Button size="sm" variant="secondary" loading={queuingRefund === r.entryId} onClick={() => handleQueueRefund(r)}>
                        Add to queue
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        {/* Printer setup */}
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-navy/60" />
            <h2 className="text-lg font-bold text-navy">Printer Setup</h2>
          </div>
          <p className="text-sm text-navy/50">
            Works with any check paper (Deluxe, Intuit, Costco, Harland, blank check stock and others). Pick your
            paper and where the check sits on the sheet. If the printing lands a little off, nudge it: positive
            numbers move the print right / up, negative numbers left / down (in inches, at most 1). If only one item
            is off, move it under Advanced.
          </p>
          <div>
            <Label htmlFor="chk-stock">Check paper</Label>
            <Select
              id="chk-stock"
              value={settings.stock}
              onChange={(e) => setSettings((s) => ({ ...s, stock: e.target.value as CheckStock }))}
            >
              <option value="preprinted">Pre-printed checks from my bank (recommended)</option>
              <option value="blank">Blank check paper</option>
            </Select>
            <p className="mt-1 text-xs text-navy/50">{STOCK_HELP[settings.stock]}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="chk-style">Check style</Label>
              <Select
                id="chk-style"
                value={settings.style}
                onChange={(e) => changeStyle(e.target.value as CheckStyle)}
              >
                <option value="voucher">Voucher</option>
                <option value="standard">Standard (3 checks per sheet)</option>
                <option value="wallet">Wallet</option>
              </Select>
              <p className="mt-1 text-xs text-navy/50">{STYLE_HELP[settings.style]}</p>
            </div>
            {settings.style === 'standard' ? (
              <div>
                <Label htmlFor="chk-remaining">How many checks are left on the first sheet?</Label>
                <Select
                  id="chk-remaining"
                  value={String(settings.firstSheetRemaining)}
                  onChange={(e) => setSettings((s) => ({ ...s, firstSheetRemaining: Number(e.target.value) }))}
                >
                  <option value="3">3 (a full sheet)</option>
                  <option value="2">2 (the top check was used)</option>
                  <option value="1">1 (only the bottom check is left)</option>
                </Select>
                <p className="mt-1 text-xs text-navy/50">
                  Lets you reuse a partly used sheet. You can also change it just before printing.
                </p>
              </div>
            ) : (
              <div>
                <Label htmlFor="chk-position">Where is the check on the page?</Label>
                <Select
                  id="chk-position"
                  value={settings.position}
                  onChange={(e) => setSettings((s) => ({ ...s, position: e.target.value as CheckPosition }))}
                >
                  <option value="top">Top</option>
                  <option value="middle">Middle</option>
                  <option value="bottom">Bottom</option>
                </Select>
                <p className="mt-1 text-xs text-navy/50">{POSITION_HELP[settings.position]}</p>
              </div>
            )}
            <div>
              <Label htmlFor="chk-pagesize">Paper size</Label>
              <Select
                id="chk-pagesize"
                value={settings.pageSize}
                onChange={(e) => setSettings((s) => ({ ...s, pageSize: e.target.value as CheckPageSize }))}
              >
                <option value="letter">Letter (8.5 × 11 in)</option>
                <option value="legal">Legal (8.5 × 14 in)</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="chk-height">How tall is one check? (inches)</Label>
              <Input
                id="chk-height"
                type="number"
                step="0.01"
                min="2.75"
                max="3.67"
                value={settings.checkHeight}
                onChange={(e) => setSettings((s) => ({ ...s, checkHeight: e.target.value }))}
              />
              <p className="mt-1 text-xs text-navy/50">Most checks are 3.5 in. Measure from the top edge to the perforation.</p>
            </div>
            <div>
              <Label htmlFor="chk-offx">Move right (inches)</Label>
              <Input
                id="chk-offx"
                type="number"
                step="0.01"
                min="-1"
                max="1"
                value={settings.offsetX}
                onChange={(e) => setSettings((s) => ({ ...s, offsetX: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="chk-offy">Move up (inches)</Label>
              <Input
                id="chk-offy"
                type="number"
                step="0.01"
                min="-1"
                max="1"
                value={settings.offsetY}
                onChange={(e) => setSettings((s) => ({ ...s, offsetY: e.target.value }))}
              />
            </div>
          </div>

          {/* Advanced: field positions */}
          <div className="rounded-lg border border-navy/10">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-navy"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>Advanced: field positions</span>
              <span className="text-navy/40">{showAdvanced ? 'Hide' : 'Show'}</span>
            </button>
            {showAdvanced && (
              <div className="px-4 pb-4 space-y-3">
                <p className="text-xs text-navy/50">
                  If one item lands in the wrong place on your checks, move just that item. Measure in inches from the
                  top-left corner of the check: &quot;Across&quot; is from the left edge, &quot;Down&quot; is from the top
                  edge to the bottom of the text. The amount in numbers is placed by its right end. Changing the check
                  style keeps the items you moved.
                </p>
                <Table>
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th>Print it?</Th>
                      <Th>Across (in)</Th>
                      <Th>Down (in)</Th>
                      <Th>Text size</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {CHECK_FIELD_KEYS.map((k) => {
                      const optional = OPTIONAL_CHECK_FIELDS.includes(k);
                      const f = layoutDraft[k];
                      return (
                        <Tr key={k}>
                          <Td className="font-medium">{CHECK_FIELD_LABELS[k]}</Td>
                          <Td>
                            {optional ? (
                              <input
                                type="checkbox"
                                aria-label={`Print ${CHECK_FIELD_LABELS[k]}`}
                                className="h-4 w-4 accent-electric"
                                checked={f.show}
                                onChange={(e) => setField(k, { show: e.target.checked })}
                              />
                            ) : (
                              <span className="text-xs text-navy/40">Always</span>
                            )}
                          </Td>
                          <Td>
                            <Input
                              aria-label={`${CHECK_FIELD_LABELS[k]} across`}
                              type="number"
                              step="0.01"
                              min="0"
                              max="8.5"
                              value={f.x}
                              onChange={(e) => setField(k, { x: e.target.value })}
                            />
                          </Td>
                          <Td>
                            <Input
                              aria-label={`${CHECK_FIELD_LABELS[k]} down`}
                              type="number"
                              step="0.01"
                              min="0"
                              max="3.67"
                              value={f.y}
                              onChange={(e) => setField(k, { y: e.target.value })}
                            />
                          </Td>
                          <Td>
                            <Input
                              aria-label={`${CHECK_FIELD_LABELS[k]} text size`}
                              type="number"
                              step="0.5"
                              min="6"
                              max="16"
                              value={f.size}
                              onChange={(e) => setField(k, { size: e.target.value })}
                            />
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
                <p className="text-xs text-navy/50">
                  Payee address is for window envelopes. Turn on the check number or your company name only if your
                  checks don&apos;t already show them.
                </p>
                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" onClick={resetLayout}>
                    Reset to standard positions
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={handleAlignmentTest} loading={testing}>
              Print alignment test
            </Button>
            <Button onClick={handleSaveSettings} loading={savingSettings}>
              Save setup
            </Button>
          </div>
        </Card>

        {/* Quick check (ad-hoc PDF, not recorded) */}
        <Card className="p-6 space-y-5">
          <div>
            <h2 className="text-lg font-bold text-navy">Quick Check</h2>
            <p className="text-sm text-navy/50">
              Generate a one-off check PDF without recording a transaction. To record spend on the books, use
              Write Checks / Expenses instead.
            </p>
          </div>

          <div>
            <Label htmlFor="chk-payee">Pay to the Order of *</Label>
            <Input
              id="chk-payee"
              placeholder="Vendor or individual name"
              value={payee}
              onChange={(e) => setPayee(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="chk-amount">Amount ($) *</Label>
              <Input
                id="chk-amount"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="chk-date">Date *</Label>
              <Input id="chk-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>

          {amountWords && (
            <div className="rounded-lg border border-electric/30 bg-electric/5 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-navy/50 mb-0.5">Amount in words</p>
              <p className="text-sm font-medium text-navy italic leading-snug">{amountWords} DOLLARS</p>
              <p className="text-xs text-navy/40 mt-1 tabular-nums">{formatCurrency(amount)}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="chk-number">Check Number</Label>
              <Input
                id="chk-number"
                placeholder="e.g. 1001"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="chk-memo">Memo</Label>
              <Input id="chk-memo" placeholder="Optional note" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleGenerate} loading={generating}>
              <Printer className="h-4 w-4" />
              Generate Check PDF
            </Button>
          </div>
        </Card>

        <Card className="p-5 bg-navy/5 border-navy/10">
          <h3 className="text-sm font-semibold text-navy mb-2">Tips</h3>
          <ul className="text-sm text-navy/60 space-y-1 list-disc list-inside">
            <li>The PDF opens in a new tab — use your browser&apos;s print dialog to send it to your printer.</li>
            <li>Print the alignment test on plain paper first and hold it over a blank check to compare.</li>
            <li>The alignment test uses the setup shown above, even before you save it.</li>
            <li>Printing a queued check stamps its number onto the recorded transaction and journal entry.</li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
