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
 *  3. Printer setup — check style (voucher / standard / wallet) and alignment nudges, with an
 *     alignment test page.
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
import { api } from '@/lib/client';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

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
}

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
  const [settings, setSettings] = useState<PrintSettings>({ style: 'voucher', stock: 'preprinted', offsetX: '0', offsetY: '0' });

  // ── Customer refunds not yet printed (D3) ─────────────────────────────────
  const [refunds, setRefunds] = useState<UnprintedRefund[]>([]);
  const [queuingRefund, setQueuingRefund] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [testing, setTesting] = useState(false);

  // ── Quick-check form state ────────────────────────────────────────────────
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
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
      .then((s) => setSettings(s))
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
    try {
      // 1. Record the number first (asks before reusing a number), then render the PDF.
      const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.post('/api/print-queue', { source: item.source, id: item.id, checkNumber: num, allowDuplicateNumber }),
      );
      if (saved === null) return; // user chose a different number
      await openCheckPdf({ source: item.source, id: item.id, checkNumber: num });
      toast(`Check #${num} printed and recorded.`, 'success');

      // Advance the number for the next check in the run.
      const parsed = parseInt(num, 10);
      if (!isNaN(parsed) && String(parsed) === num) setNextNumber(String(parsed + 1));
      setQueue((prev) => prev.filter((q) => !(q.id === item.id && q.source === item.source)));
    } catch (err) {
      toast(errMsg(err, 'Failed to print check.'), 'danger');
    } finally {
      setPrintingId(null);
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
      const saved = await api.put<PrintSettings>('/api/checks/settings', settings);
      setSettings(saved);
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
      });
    } catch (err) {
      toast(errMsg(err, 'Could not print the test page.'), 'danger');
    } finally {
      setTesting(false);
    }
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
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-6">
        <PageHeader title="Print Checks" icon={Printer} />

        {/* Print queue */}
        <Card className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-navy">Checks to Print</h2>
              <p className="text-sm text-navy/50">
                Checks written with &quot;Print later&quot;, bill payments marked &quot;To be printed&quot;, and
                paychecks you added below. Printing records the check number on the transaction.
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
            {queue.length > 0 && (
              <Badge tone="warning">
                {queue.length} check{queue.length === 1 ? '' : 's'} queued
              </Badge>
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
                  <Tr key={`${q.source}:${q.id}`}>
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
            Pick the kind of check paper you use. If the printing lands a little off on the paper, nudge it:
            positive numbers move the print right / up, negative numbers left / down (in inches, at most 1).
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
                onChange={(e) => setSettings((s) => ({ ...s, style: e.target.value as CheckStyle }))}
              >
                <option value="voucher">Voucher</option>
                <option value="standard">Standard</option>
                <option value="wallet">Wallet</option>
              </Select>
              <p className="mt-1 text-xs text-navy/50">{STYLE_HELP[settings.style]}</p>
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
            <li>Printing a queued check stamps its number onto the recorded transaction and journal entry.</li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
