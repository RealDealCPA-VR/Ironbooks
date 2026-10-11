'use client';

/**
 * Write Checks / Expenses — QB-style direct spend entry.
 *
 * Records non-bill spend straight against expense accounts:
 *   - Check (with auto-next check number, or "Print Later" → Print Checks queue)
 *   - Cash
 *   - Credit Card Charge / Credit Card Credit (refund)
 *
 * Form posts to /api/expenses; the service posts Dr expense lines / Cr payment
 * account (flipped for CC credits) through the central posting engine.
 */

import { Suspense, useEffect, useState, useCallback } from 'react';
import { Banknote, Paperclip, Plus, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  Modal,
  toast, toastError,
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api, ApiError } from '@/lib/client';
import { fetchVendorPrefill, PREFILL_SOURCE_LABEL } from '@/lib/aiClient';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { useNewParam } from '@/lib/useFocusParam';
// wave2 prefs: Preferences-driven defaults/warnings, memorize (Ctrl+M), attachments
import { usePreferences } from '@/lib/usePreferences';
import { confirmTransactionDate, confirmUniqueNumber, findDuplicateNumber } from '@/lib/formPrefs';
import MemorizeButton from '@/components/MemorizeButton';
import AttachmentPanel from '@/components/AttachmentPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Expense {
  id: string;
  vendorId: string | null;
  vendorName: string | null;
  payeeName: string | null;
  date: string;
  method: string;
  reference: string | null;
  paymentAccountId: string;
  paymentAccountName: string | null;
  total: string;
  memo: string | null;
  toPrint: boolean;
  voidedAt: string | null;
}

interface Vendor {
  id: string;
  displayName: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}

interface ClassRow {
  id: string;
  name: string;
}

interface Customer {
  id: string;
  displayName: string;
}

interface LineRow {
  accountId: string;
  description: string;
  amount: string;
  classId: string;
  customerId: string;
}

/** UI entry type → service method + refund flag. */
type EntryType = 'check' | 'cash' | 'cc_charge' | 'cc_credit';

const ENTRY_LABEL: Record<EntryType, string> = {
  check: 'Check',
  cash: 'Cash',
  cc_charge: 'CC Charge',
  cc_credit: 'CC Credit',
};

const OTHER_PAYEE = '__other__';

function emptyLine(): LineRow {
  return { accountId: '', description: '', amount: '', classId: '', customerId: '' };
}

function isBankish(a: Account): boolean {
  return (
    a.type === 'asset' &&
    !['accounts_receivable', 'inventory', 'fixed_assets'].includes(a.subtype)
  );
}

function isCreditCard(a: Account): boolean {
  return a.type === 'liability' && a.subtype === 'credit_card';
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ExpensesPageContent() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [pendingVoid, setPendingVoid] = useState<Expense | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // Form state
  const [entryType, setEntryType] = useState<EntryType>('check');
  const [payeeSel, setPayeeSel] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [toPrint, setToPrint] = useState(false);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([emptyLine()]);
  /** Shown under the payee after accounts were pre-filled (QB vendor pre-fill). */
  const [prefillNote, setPrefillNote] = useState('');
  const prefs = usePreferences();
  const [attachFor, setAttachFor] = useState<string | null>(null);
  // My Preferences > Checking: "Start with payee field on check" (else the bank account).
  useEffect(() => {
    if (!prefs.loaded || typeof document === 'undefined') return;
    if (document.activeElement && document.activeElement !== document.body) return;
    document.getElementById(prefs.my.startWithPayee ? 'exp-payee' : 'exp-account')?.focus();
  }, [prefs.loaded, prefs.my.startWithPayee]);

  const isCC = entryType === 'cc_charge' || entryType === 'cc_credit';
  const paymentAccounts = accounts.filter((a) => (isCC ? isCreditCard(a) : isBankish(a)));
  const lineAccounts = accounts.filter((a) => a.id !== paymentAccountId);

  // ── data loading ──────────────────────────────────────────────────────────

  const fetchExpenses = useCallback(async () => {
    try {
      const data = await api.get<{ expenses: Expense[] }>('/api/expenses?includeVoided=true');
      setExpenses(data.expenses);
    } catch (err) {
      toastError(err, 'Failed to load expenses');
    }
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);
      try {
        const [expData, vendorData, accountData, classData, customerData] = await Promise.all([
          api.get<{ expenses: Expense[] }>('/api/expenses?includeVoided=true'),
          api.get<Vendor[]>('/api/vendors'),
          api.get<Account[]>('/api/accounts'),
          api.get<ClassRow[]>('/api/classes').catch(() => [] as ClassRow[]),
          api.get<Customer[]>('/api/customers').catch(() => [] as Customer[]),
        ]);
        setExpenses(expData.expenses);
        setVendors(vendorData);
        setAccounts(accountData);
        setClasses(classData);
        setCustomers(customerData);
      } catch (err) {
        toastError(err, 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Preferences > Checking: default bank account for Write Checks.
  useEffect(() => {
    const def = prefs.company.defaultCheckAccountId;
    if (!def || paymentAccountId || isCC) return;
    const acc = accounts.find((a) => a.id === def);
    if (acc && isBankish(acc)) setPaymentAccountId(def);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, prefs.loaded, isCC]);

  // Clear an incompatible payment account when switching entry type.
  useEffect(() => {
    setPaymentAccountId((prev) => {
      if (!prev) return prev;
      const acc = accounts.find((a) => a.id === prev);
      if (!acc) return '';
      const ok = isCC ? isCreditCard(acc) : isBankish(acc);
      return ok ? prev : '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCC]);

  // Auto-suggest the next check number for checks not queued for printing.
  useEffect(() => {
    let cancelled = false;
    async function loadNext() {
      if (entryType !== 'check' || toPrint || !paymentAccountId) return;
      try {
        const data = await api.get<{ next: string }>(
          `/api/check-numbers/next?paymentAccountId=${paymentAccountId}`,
        );
        if (!cancelled) setReference(data.next);
      } catch {
        /* non-fatal — the user can type a number */
      }
    }
    loadNext();
    return () => {
      cancelled = true;
    };
  }, [entryType, toPrint, paymentAccountId]);

  // ── line helpers ──────────────────────────────────────────────────────────

  function updateLine(index: number, field: keyof LineRow, value: string) {
    setLines((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }
  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }
  function removeLine(index: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev));
  }

  // Line-grid keyboard ergonomics: Ctrl+Insert add / Ctrl+Delete remove / Enter down.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: submitting });

  // Ctrl+E / Quick Actions navigate here with ?new=1 — the entry form is always
  // visible, so jump focus to the start of it (the payee field).
  useNewParam(() => {
    document.getElementById('exp-payee')?.focus();
  });

  const runningTotal = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);

  function resetForm() {
    setPayeeSel('');
    setPayeeName('');
    setReference('');
    setToPrint(false);
    setMemo('');
    setLines([emptyLine()]);
    setPrefillNote('');
  }

  /**
   * Payee chosen while the lines are still blank: pre-fill accounts (vendor default → last
   * transaction → learned categorizer). Never overwrites anything the user typed.
   */
  async function prefillFor(q: { vendorId?: string; payee?: string }) {
    setPrefillNote('');
    // Preferences > Checking: "Autofill payee account number / last account used".
    if (!prefs.company.autofillPayeeAccount) return;
    const blank = (ls: LineRow[]) => ls.every((l) => !l.accountId && !l.amount && !l.description);
    if (!blank(lines)) return;
    const pf = await fetchVendorPrefill(q);
    if (!pf) return;
    setLines((prev) => {
      if (!blank(prev)) return prev; // user started typing while we fetched
      return pf.lines.map((l) => ({
        ...emptyLine(),
        accountId: l.accountId,
        classId: l.classId ?? '',
        customerId: l.customerId ?? '',
      }));
    });
    setPrefillNote(`Accounts pre-filled ${PREFILL_SOURCE_LABEL[pf.source]}.`);
  }

  // ── submit ────────────────────────────────────────────────────────────────

  async function handleSubmit() {
    const vendorId = payeeSel && payeeSel !== OTHER_PAYEE ? payeeSel : undefined;
    const freePayee = payeeSel === OTHER_PAYEE ? payeeName.trim() : '';
    if (!vendorId && !freePayee) {
      toast('Select a vendor or enter a payee name.', 'danger');
      return;
    }
    if (!paymentAccountId) {
      toast(isCC ? 'Select a credit card account.' : 'Select a bank account.', 'danger');
      return;
    }
    if (!date) {
      toast('Date is required.', 'danger');
      return;
    }
    for (const [i, line] of lines.entries()) {
      if (!line.accountId) {
        toast(`Line ${i + 1}: select an expense account.`, 'danger');
        return;
      }
      if (!line.amount || Number(line.amount) <= 0) {
        toast(`Line ${i + 1}: amount must be greater than zero.`, 'danger');
        return;
      }
    }

    if (!confirmTransactionDate(date, prefs)) return;
    // Preferences > Checking: "Warn about duplicate check numbers" (same bank account).
    if (entryType === 'check' && !toPrint) {
      const dupCheck = findDuplicateNumber(reference, expenses, (e) => e.reference, {
        sameScope: (e) => e.method === 'check' && e.paymentAccountId === paymentAccountId && !e.voidedAt,
      });
      if (!confirmUniqueNumber(prefs.company.warnDuplicateCheckNumbers, 'Check number', dupCheck, reference)) return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/expenses', {
        vendorId,
        payeeName: freePayee || undefined,
        date,
        method: entryType === 'cash' ? 'cash' : isCC ? 'credit_card' : 'check',
        isRefund: entryType === 'cc_credit',
        // Send the typed reference for every entry type except print-later checks
        // (those get their number assigned when printed).
        reference:
          entryType === 'check' && toPrint
            ? undefined
            : reference.trim() || undefined,
        toPrint: entryType === 'check' ? toPrint : false,
        paymentAccountId,
        memo: memo.trim() || undefined,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim() || undefined,
          amount: l.amount,
          classId: l.classId || undefined,
          customerId: l.customerId || undefined,
        })),
      });
      toast(
        entryType === 'check' && toPrint
          ? 'Check saved and added to the print queue.'
          : `${ENTRY_LABEL[entryType]} recorded.`,
        'success',
      );
      resetForm();
      await fetchExpenses();
    } catch (err) {
      toastError(err, 'Failed to save expense.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── void ──────────────────────────────────────────────────────────────────

  async function handleVoid(id: string) {
    setVoidingId(id);
    try {
      await api.del(`/api/expenses/${id}`);
      toast('Expense voided.', 'success');
      setPendingVoid(null);
      await fetchExpenses();
    } catch (err) {
      toastError(err, 'Failed to void expense.');
    } finally {
      setVoidingId(null);
    }
  }

  // ── render helpers ────────────────────────────────────────────────────────

  function methodBadge(e: Expense) {
    if (e.method === 'credit_card') {
      return Number(e.total) < 0 ? (
        <Badge tone="success">CC Credit</Badge>
      ) : (
        <Badge tone="info">CC Charge</Badge>
      );
    }
    if (e.method === 'cash') return <Badge tone="neutral">Cash</Badge>;
    return <Badge tone="info">Check</Badge>;
  }

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Write Checks / Expenses" icon={Banknote} />

      {/* ------------------------------------------------------------------ */}
      {/* Entry form                                                          */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-8 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-navy">New Transaction</h2>
          {/* Entry type toggle */}
          <div className="flex gap-1 rounded-lg bg-navy/5 p-1">
            {(Object.keys(ENTRY_LABEL) as EntryType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setEntryType(t)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  entryType === t
                    ? 'bg-white text-navy shadow-sm'
                    : 'text-navy/50 hover:text-navy'
                }`}
              >
                {ENTRY_LABEL[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Payee + payment account + date */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="exp-payee" required>Pay to the Order of</Label>
            <Select
              id="exp-payee"
              value={payeeSel}
              onChange={(e) => {
                const v = e.target.value;
                setPayeeSel(v);
                if (v && v !== OTHER_PAYEE) prefillFor({ vendorId: v });
              }}
            >
              <option value="">Select payee…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
              <option value={OTHER_PAYEE}>Other (type a name)…</option>
            </Select>
            {payeeSel === OTHER_PAYEE && (
              <Input
                className="mt-2"
                placeholder="Payee name"
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
                onBlur={() => payeeName.trim() && prefillFor({ payee: payeeName })}
              />
            )}
            {prefillNote && <p className="mt-1 text-xs text-electric">{prefillNote}</p>}
          </div>

          <div>
            <Label htmlFor="exp-account" required>
              {isCC ? 'Credit Card Account' : 'Bank Account'} <Help term="reconcile" side="bottom" />
            </Label>
            <Select
              id="exp-account"
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} – {a.name}
                </option>
              ))}
            </Select>
            {isCC && paymentAccounts.length === 0 && (
              <p className="mt-1 text-xs text-navy/40">
                No credit-card accounts found. Add one (liability / credit card) in the chart of
                accounts.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="exp-date" required>Date</Label>
            <DateInput id="exp-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>

        {/* Check number + print later (checks only) + memo */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {entryType === 'check' && (
            <div>
              <Label htmlFor="exp-checkno">Check No.</Label>
              <Input
                id="exp-checkno"
                placeholder="auto"
                value={toPrint ? '' : reference}
                disabled={toPrint}
                onChange={(e) => setReference(e.target.value)}
              />
              <label className="mt-2 flex items-center gap-2 text-sm text-navy/70 select-none">
                <input
                  type="checkbox"
                  checked={toPrint}
                  onChange={(e) => setToPrint(e.target.checked)}
                  className="h-4 w-4 accent-electric"
                />
                Print later (number assigned when printed)
              </label>
            </div>
          )}
          {entryType !== 'check' && (
            <div>
              <Label htmlFor="exp-ref">Reference No.</Label>
              <Input
                id="exp-ref"
                placeholder="optional"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          )}
          <div className="md:col-span-2">
            <Label htmlFor="exp-memo">Memo</Label>
            <Input
              id="exp-memo"
              placeholder="Optional note"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
        </div>

        {/* Lines grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0" required>
              {entryType === 'cc_credit' ? 'Refunded Expense Lines' : 'Expense Lines'}{' '}
              <Help term="chart-of-accounts" />
            </Label>
            <button
              type="button"
              onClick={addLine}
              className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" /> Add Line
            </button>
          </div>

          {/* Header row */}
          <div className="hidden md:grid grid-cols-[2fr_2fr_1fr_1.5fr_1.5fr_24px] gap-2 mb-1 text-[11px] font-semibold uppercase tracking-wide text-navy/40 px-1">
            <span>Account</span>
            <span>Description</span>
            <span>Amount</span>
            <span>Class</span>
            <span>Billable Customer</span>
            <span />
          </div>

          <div className="space-y-2" onKeyDown={grid.onKeyDown}>
            {lines.map((line, idx) => (
              <div
                key={idx}
                data-grid-row
                className="grid grid-cols-1 md:grid-cols-[2fr_2fr_1fr_1.5fr_1.5fr_24px] gap-2 items-start"
              >
                <Select
                  value={line.accountId}
                  onChange={(e) => updateLine(idx, 'accountId', e.target.value)}
                >
                  <option value="">Account…</option>
                  {lineAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} – {a.name}
                    </option>
                  ))}
                </Select>

                <Input
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateLine(idx, 'description', e.target.value)}
                />

                <AmountInput
                  placeholder="0.00"
                  value={line.amount}
                  onChange={(e) => updateLine(idx, 'amount', e.target.value)}
                />

                <Select
                  value={line.classId}
                  onChange={(e) => updateLine(idx, 'classId', e.target.value)}
                >
                  <option value="">Class…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>

                <Select
                  value={line.customerId}
                  onChange={(e) => updateLine(idx, 'customerId', e.target.value)}
                >
                  <option value="">Customer…</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </Select>

                <button
                  type="button"
                  onClick={() => removeLine(idx)}
                  disabled={lines.length === 1}
                  className="mt-2 text-red-400 hover:text-red-600 disabled:opacity-20 disabled:pointer-events-none"
                  title="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-end gap-2">
            <span className="text-sm text-navy/50">
              {entryType === 'cc_credit' ? 'Total credit:' : 'Total:'}
            </span>
            <span className="text-sm font-bold text-navy tabular-nums">
              {formatCurrency(runningTotal.toFixed(2))}
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <MemorizeButton
            docType={entryType === 'check' ? 'check' : 'expense'}
            defaultName={payeeSel === OTHER_PAYEE ? payeeName : vendors.find((v) => v.id === payeeSel)?.displayName}
            getTemplate={() => {
              const vendorId = payeeSel && payeeSel !== OTHER_PAYEE ? payeeSel : undefined;
              const freePayee = payeeSel === OTHER_PAYEE ? payeeName.trim() : '';
              if (!vendorId && !freePayee) return 'Pick a payee before memorizing.';
              if (!paymentAccountId) return 'Pick the account you pay from before memorizing.';
              const rows = lines.filter((l) => l.accountId && Number(l.amount) > 0);
              if (rows.length === 0) return 'Add at least one line before memorizing.';
              return {
                vendorId,
                payeeName: freePayee || undefined,
                date,
                method: entryType === 'cash' ? 'cash' : isCC ? 'credit_card' : 'check',
                isRefund: entryType === 'cc_credit',
                toPrint: entryType === 'check' ? toPrint : false,
                paymentAccountId,
                memo: memo.trim() || undefined,
                lines: rows.map((l) => ({
                  accountId: l.accountId,
                  description: l.description.trim() || undefined,
                  amount: l.amount,
                  classId: l.classId || undefined,
                  customerId: l.customerId || undefined,
                })),
              };
            }}
          />
          <Button onClick={handleSubmit} loading={submitting}>
            {`Save ${ENTRY_LABEL[entryType]}`}
          </Button>
        </div>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Expense list                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading expenses…
          </div>
        ) : expenses.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title="No checks or expenses yet"
            message="Paid for something right away (check, debit card, cash or credit card)? Record it here. For bills you will pay later, use Enter Bills."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>No.</Th>
                <Th>Payee</Th>
                <Th>Account</Th>
                <Th>Type</Th>
                <Th numeric>Amount</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <Tr key={e.id}>
                  <Td>{e.date ? formatDate(e.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td className="font-mono text-sm">
                    {e.reference ?? (
                      <span className="text-navy/30 italic">{e.toPrint ? 'to print' : '—'}</span>
                    )}
                  </Td>
                  <Td className="font-medium">{e.vendorName ?? e.payeeName ?? '—'}</Td>
                  <Td>{e.paymentAccountName ?? '—'}</Td>
                  <Td>{methodBadge(e)}</Td>
                  <Td numeric className="font-semibold">
                    {formatCurrency(e.total)}
                  </Td>
                  <Td>
                    {e.voidedAt ? (
                      <Badge tone="danger">Void</Badge>
                    ) : e.toPrint ? (
                      <Badge tone="warning">To Print</Badge>
                    ) : (
                      <Badge tone="success">Recorded</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setAttachFor(e.id)} title="Receipts and files">
                      <Paperclip className="h-4 w-4" />
                    </Button>
                    {!e.voidedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        disabled={voidingId === e.id}
                        onClick={() => setPendingVoid(e)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={!!attachFor} onClose={() => setAttachFor(null)} title="Receipts & files" size="md">
        <AttachmentPanel entityType="expense" entityId={attachFor} />
      </Modal>

      {/* Void confirm */}
      <ConfirmDialog
        open={!!pendingVoid}
        title="Void transaction?"
        message={`Void this transaction for ${formatCurrency(pendingVoid?.total ?? '0')} to ${pendingVoid?.vendorName ?? pendingVoid?.payeeName ?? 'the payee'}? This reverses the posted entry and cannot be undone.`}
        confirmLabel="Void"
        tone="danger"
        loading={!!pendingVoid && voidingId === pendingVoid.id}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid.id)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}

export default function ExpensesPage() {
  return (
    <Suspense fallback={null}>
      <ExpensesPageContent />
    </Suspense>
  );
}
