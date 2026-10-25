'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { Landmark, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  EmptyState,
  Input,
  Select,
  Label,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  toast, toastError,
  useGridKeys,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import MemorizeButton from '@/components/MemorizeButton';
import { formatCurrency } from '@/lib/money';
import { formatDate, todayISO } from '@/lib/dates';
import { useNewParam } from '@/lib/useFocusParam';
// wave2 prefs: Checking > default account for Make Deposits; date warnings
import { usePreferences } from '@/lib/usePreferences';
import { useErrorFixes } from '@/components/ErrorFixPanel';
import { FieldError, fieldA11y, focusFirstError } from '@/components/FieldError';
import { getPath, parseLinePath, type ErrorFix } from '@/lib/errorFixes';
import { amountMessage, collectErrors, dateMessage, hasErrors, requiredMessage, type FieldErrors } from '@/lib/fieldValidation';

/** Body sent to /api/deposits (fix patches address its paths, e.g. "paymentIds", "depositAccountId"). */
type DepositBody = Record<string, unknown> & {
  paymentIds: string[];
  salesReceiptIds: string[];
  invoicePaymentIds?: string[];
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  /** p1 fx: bank account currency (null = home). */
  currency?: string | null;
}

interface UndepositedItem {
  id: string;
  /** invoice_payment = payment-item lines recorded on an invoice (id = the invoice). */
  kind: 'payment' | 'sales_receipt' | 'invoice_payment';
  customerId: string | null;
  customerName: string | null;
  date: string;
  method: string;
  reference: string | null;
  amount: string;
  /** p1 fx: payment currency (null = home). */
  currency?: string | null;
}

interface DepositLine {
  id: string;
  depositId: string;
  paymentId: string | null;
  description: string | null;
  amount: string;
  /** Account an extra line credits (null on payment / receipt / cash-back lines). */
  accountId?: string | null;
}

interface Deposit {
  id: string;
  depositAccountId: string;
  accountName: string | null;
  accountCode: string | null;
  date: string;
  total: string;
  memo: string | null;
  voidedAt: string | null;
  createdAt: string;
  lines: DepositLine[];
  /** p1 fx: deposit currency (null = home) and its home value. */
  currency?: string | null;
  homeTotal?: string | null;
}

interface ExtraLine {
  accountId: string;
  amount: string;
  description: string;
}

function emptyExtraLine(): ExtraLine {
  return { accountId: '', amount: '', description: '' };
}

const RECEIPT_PREFIX = 'salesReceipt:';
const INVOICE_PAYMENT_PREFIX = 'invoicePayment:';
const CASHBACK_PREFIX = 'cashback:';

/** A saved deposit loaded into the modal for editing. */
interface DepositEdit {
  id: string;
  depositAccountId: string;
  date: string;
  memo: string;
  /** Payments / sales receipts already on this deposit (shown in the picker, pre-checked). */
  items: UndepositedItem[];
  extraLines: ExtraLine[];
  cashBackAccountId: string;
  cashBackAmount: string;
}

/** Rebuild the form state of a saved deposit from its lines. */
function depositToEdit(dep: Deposit): DepositEdit {
  const items: UndepositedItem[] = [];
  const extraLines: ExtraLine[] = [];
  let cashBackAccountId = '';
  let cashBackAmount = '';
  for (const l of dep.lines) {
    const desc = l.description ?? '';
    if (l.paymentId) {
      items.push({
        id: l.paymentId,
        kind: 'payment',
        customerId: null,
        customerName: 'Already on this deposit',
        date: dep.date,
        method: 'payment',
        reference: null,
        amount: l.amount,
      });
    } else if (desc.startsWith(RECEIPT_PREFIX)) {
      items.push({
        id: desc.slice(RECEIPT_PREFIX.length),
        kind: 'sales_receipt',
        customerId: null,
        customerName: 'Already on this deposit',
        date: dep.date,
        method: 'sales receipt',
        reference: null,
        amount: l.amount,
      });
    } else if (desc.startsWith(INVOICE_PAYMENT_PREFIX)) {
      items.push({
        id: desc.slice(INVOICE_PAYMENT_PREFIX.length),
        kind: 'invoice_payment',
        customerId: null,
        customerName: 'Already on this deposit',
        date: dep.date,
        method: 'invoice payment',
        reference: null,
        amount: l.amount,
      });
    } else if (desc.startsWith(CASHBACK_PREFIX)) {
      cashBackAccountId = desc.slice(CASHBACK_PREFIX.length);
      cashBackAmount = String(Math.abs(Number(l.amount)).toFixed(2));
    } else {
      // Extra lines keep their description and credited account (deposit_lines.account_id, 0037;
      // older lines without one are re-picked — the form flags it as required).
      extraLines.push({ accountId: l.accountId ?? '', amount: l.amount, description: desc });
    }
  }
  return {
    id: dep.id,
    depositAccountId: dep.depositAccountId,
    date: dep.date.slice(0, 10),
    memo: dep.memo ?? '',
    items,
    extraLines,
    cashBackAccountId,
    cashBackAmount,
  };
}

// ---------------------------------------------------------------------------
// Make Deposit Modal
// ---------------------------------------------------------------------------

interface MakeDepositModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  bankAccounts: Account[];
  allAccounts: Account[];
  undepositedItems: UndepositedItem[];
  loadingItems: boolean;
  /** When set, the modal edits this saved deposit (PATCH). */
  editing?: DepositEdit | null;
}

function MakeDepositModal({
  open,
  onClose,
  onCreated,
  bankAccounts,
  allAccounts,
  undepositedItems: freeItems,
  loadingItems,
  editing,
}: MakeDepositModalProps) {
  // While editing, the items already on the deposit are selectable alongside the free ones.
  const allItems = editing
    ? [...editing.items, ...freeItems.filter((f) => !editing.items.some((i) => i.id === f.id))]
    : freeItems;
  const [depositAccountId, setDepositAccountId] = useState('');
  // p1 fx: a deposit is in its bank account's currency — only payments in that currency show.
  const depCur = bankAccounts.find((a) => a.id === depositAccountId)?.currency || null;
  const undepositedItems = allItems.filter((p) => (p.currency || null) === depCur);
  const [fxRate, setFxRate] = useState('');
  const money = (v: string | number) => formatCurrency(v, depCur ?? undefined);
  const prefs = usePreferences();
  const [date, setDate] = useState(() => todayISO());
  const [memo, setMemo] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [methodFilter, setMethodFilter] = useState('all');
  const [extraLines, setExtraLines] = useState<ExtraLine[]>([]);
  const [cashBackAccountId, setCashBackAccountId] = useState('');
  const [cashBackAmount, setCashBackAmount] = useState('');
  const [saving, setSaving] = useState(false);
  // Fix errors where they happen: server fix suggestions + inline field messages.
  const fixer = useErrorFixes<DepositBody>();
  const [showErrors, setShowErrors] = useState(false);

  // Reset when modal opens.
  useEffect(() => {
    if (open) {
      // Editing keeps the deposit's own account; a new deposit starts on the Preferences default.
      const def = prefs.company.defaultDepositAccountId;
      setDepositAccountId(
        editing ? (editing.depositAccountId ?? '') : def && bankAccounts.some((a) => a.id === def) ? def : '',
      );
      setDate(editing?.date ?? todayISO());
      setMemo(editing?.memo ?? '');
      setSelectedIds(new Set(editing?.items.map((i) => i.id) ?? []));
      setMethodFilter('all');
      setExtraLines(editing?.extraLines ?? []);
      setCashBackAccountId(editing?.cashBackAccountId ?? '');
      setCashBackAmount(editing?.cashBackAmount ?? '');
      setFxRate('');
      fixer.clear();
      setShowErrors(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // QB groups "Payments to Deposit" by method — offer a method filter.
  const methods = [...new Set(undepositedItems.map((p) => p.method))];
  const visibleItems =
    methodFilter === 'all'
      ? undepositedItems
      : undepositedItems.filter((p) => p.method === methodFilter);

  function toggleItem(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    const visibleSelected = visibleItems.filter((p) => selectedIds.has(p.id)).length;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (visibleSelected === visibleItems.length) {
        for (const p of visibleItems) next.delete(p.id);
      } else {
        for (const p of visibleItems) next.add(p.id);
      }
      return next;
    });
  }

  // Line-grid keys for the additional lines: Enter / Down next line (adds one), Ctrl+Insert, Ctrl+D.
  const extraGrid = useGridKeys({
    addRow: () => setExtraLines((prev) => [...prev, emptyExtraLine()]),
    removeRow: (i) => setExtraLines((prev) => prev.filter((_, k) => k !== i)),
    disabled: saving,
  });

  function patchExtraLine(index: number, patch: Partial<ExtraLine>) {
    setExtraLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const selectedTotal = undepositedItems
    .filter((p) => selectedIds.has(p.id))
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const extraTotal = extraLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const cashBackNum = Number(cashBackAmount) || 0;
  const netTotal = selectedTotal + extraTotal - cashBackNum;

  /** Inline field messages (lib/fieldValidation.ts). */
  function validateForm(): FieldErrors {
    const entries: Record<string, string | null> = {
      account: requiredMessage(depositAccountId, 'Choose the bank account the money goes into.'),
      date: dateMessage(date, 'Deposit date'),
      cashBackAmount: amountMessage(cashBackAmount, { label: 'Cash back' }),
      cashBackAccount: cashBackNum > 0 && !cashBackAccountId ? 'Choose the account that cash back goes to.' : null,
      total:
        selectedIds.size === 0 && extraLines.length === 0
          ? 'Select at least one payment or add a deposit line.'
          : netTotal <= 0
            ? 'Cash back is as much as the deposit itself. Lower the cash back or add more to deposit.'
            : null,
    };
    extraLines.forEach((l, i) => {
      entries[`extra-${i}-account`] = requiredMessage(l.accountId, `Additional line ${i + 1}: choose where the money came from.`);
      entries[`extra-${i}-amount`] = amountMessage(l.amount, { label: `Additional line ${i + 1} amount`, required: true });
    });
    return collectErrors(entries);
  }
  const fieldErrors: FieldErrors = showErrors ? validateForm() : {};

  /** Copy a fix's changes (request-body paths) back onto the form. */
  function applyToForm(patched: DepositBody, fix: ErrorFix) {
    for (const op of fix.patch ?? []) {
      const value = getPath(patched, op.path);
      const str = typeof value === 'string' ? value : value == null ? '' : String(value);
      if (op.path === 'depositAccountId') setDepositAccountId(str);
      else if (op.path === 'date') setDate(str);
      else if (op.path === 'cashBack' && value == null) {
        setCashBackAccountId('');
        setCashBackAmount('');
      } else if (op.op === 'pull' && (op.path === 'paymentIds' || op.path === 'salesReceiptIds' || op.path === 'invoicePaymentIds')) {
        const removed = String(op.value);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(removed);
          return next;
        });
      } else {
        const lp = parseLinePath(op.path);
        if (lp?.collection === 'extraLines' && (lp.field === 'accountId' || lp.field === 'amount')) {
          patchExtraLine(lp.index, { [lp.field]: str });
        }
      }
    }
  }

  /** Save the deposit. Throws on failure (the fix presenter shows it). */
  async function send(body: DepositBody) {
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/api/deposits/${editing.id}`, body);
        toast('Deposit updated.', 'success');
      } else {
        await api.post('/api/deposits', body);
        toast('Deposit created successfully.', 'success');
      }
      fixer.clear();
      onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit() {
    setShowErrors(true);
    const errs = validateForm();
    if (hasErrors(errs)) {
      focusFirstError('dep', errs);
      return;
    }

    const paymentIds = undepositedItems
      .filter((p) => p.kind === 'payment' && selectedIds.has(p.id))
      .map((p) => p.id);
    const salesReceiptIds = undepositedItems
      .filter((p) => p.kind === 'sales_receipt' && selectedIds.has(p.id))
      .map((p) => p.id);
    const invoicePaymentIds = undepositedItems
      .filter((p) => p.kind === 'invoice_payment' && selectedIds.has(p.id))
      .map((p) => p.id);

    {
      const body: DepositBody = {
        depositAccountId,
        date,
        paymentIds,
        salesReceiptIds,
        invoicePaymentIds,
        extraLines: extraLines.map((l) => ({
          accountId: l.accountId,
          amount: l.amount,
          description: l.description.trim() || undefined,
        })),
        cashBack:
          cashBackNum > 0
            ? { accountId: cashBackAccountId, amount: cashBackAmount }
            : undefined,
        memo: memo || undefined,
        ...(depCur && fxRate.trim() ? { exchangeRate: fxRate.trim() } : {}),
      };
      try {
        await send(body);
      } catch (err: unknown) {
        // Already deposited / not in Undeposited Funds / wrong account → Fix buttons.
        fixer.report(err, { payload: body, resubmit: send, applyToForm, fallback: 'Failed to save deposit.' });
      }
    }
  }

  const allSelected =
    visibleItems.length > 0 && visibleItems.every((p) => selectedIds.has(p.id));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Deposit' : 'Make Deposit'}
      size="lg"
      footer={
        <>
          <MemorizeButton
            docType="deposit"
            shortcut={open}
            defaultName={memo || undefined}
            getTemplate={() => {
              // Only the "other" lines recur: customer payments are one-time money.
              if (!depositAccountId) return 'Pick the bank account before memorizing.';
              const rows = extraLines.filter((l) => l.accountId && Number(l.amount) > 0);
              if (rows.length === 0)
                return 'Add at least one deposit line (not a customer payment) to memorize a deposit.';
              return {
                depositAccountId,
                date,
                paymentIds: [],
                salesReceiptIds: [],
                extraLines: rows.map((l) => ({
                  accountId: l.accountId,
                  amount: l.amount,
                  description: l.description.trim() || undefined,
                })),
                memo: memo || undefined,
              };
            }}
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={selectedIds.size === 0 && extraLines.length === 0}
          >
            {`Deposit ${money(netTotal.toFixed(2))}`}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* Ctrl+Y / Ctrl+H: the journal entry this deposit posted (components/KeyboardCommands.tsx). */}
        {editing && <span hidden data-source-ref={`deposit:${editing.id}`} />}
        {fixer.panel}
        {editing && (
          <div className="rounded-lg border border-electric/30 bg-electric/5 px-4 py-3 text-sm text-navy/80">
            You are changing a saved deposit. Uncheck a payment to send it back to Undeposited
            Funds, or check more to add them. Pick the account again for any additional lines.
          </div>
        )}
        {/* Bank account */}
        <div>
          <Label htmlFor="dep-account" required>Deposit To</Label>
          <Select
            id="dep-account"
            autoFocus
            value={depositAccountId}
            onChange={(e) => setDepositAccountId(e.target.value)}
            aria-required="true"
            {...fieldA11y('dep', 'account', fieldErrors)}
          >
            <option value="">Select bank account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
          <FieldError formId="dep" name="account" errors={fieldErrors} />
        </div>

        {/* p1 fx: foreign-currency bank account */}
        {depCur && (
          <div>
            <Label htmlFor="dep-rate">Exchange rate (1 {depCur} = ? home)</Label>
            <Input
              id="dep-rate"
              type="number"
              step="0.00000001"
              min="0.00000001"
              placeholder="Blank = Currencies list rate"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
            />
            <p className="text-xs text-navy/40 mt-1">
              This account is in {depCur}: only {depCur} payments are listed and amounts are in {depCur}. Any difference
              from the rate each payment was received at is recorded as an exchange gain or loss.
            </p>
          </div>
        )}

        {/* Date */}
        <div>
          <Label htmlFor="dep-date" required>Date</Label>
          <DateInput
            id="dep-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-required="true"
            {...fieldA11y('dep', 'date', fieldErrors)}
          />
          <FieldError formId="dep" name="date" errors={fieldErrors} />
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="dep-memo">Memo</Label>
          <Input
            id="dep-memo"
            placeholder="Optional note"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        {/* Undeposited items list */}
        <div>
          <div className="flex items-center justify-between mb-2 gap-2">
            <Label className="mb-0">Payments in Undeposited Funds <Help term="undeposited-funds" /></Label>
            <span className="flex items-center gap-3">
              {methods.length > 1 && (
                <select
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                  className="text-xs border border-slate-200 rounded-md px-2 py-1 text-navy/70 bg-white"
                  aria-label="Filter by payment method"
                >
                  <option value="all">All methods</option>
                  {methods.map((m) => (
                    <option key={m} value={m}>
                      {m.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              )}
              {visibleItems.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-electric hover:text-electric/80 font-medium"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </span>
          </div>

          {loadingItems ? (
            <div className="text-sm text-navy/40 py-4 text-center">Loading payments…</div>
          ) : visibleItems.length === 0 ? (
            <div className="text-sm text-navy/40 py-4 text-center rounded-lg border border-dashed border-slate-200">
              No undeposited payments found.
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 overflow-hidden divide-y divide-slate-100">
              {visibleItems.map((p) => {
                const checked = selectedIds.has(p.id);
                return (
                  <label
                    key={p.id}
                    className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${
                      checked ? 'bg-electric/5' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleItem(p.id)}
                      className="accent-electric"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-navy truncate">
                          {p.customerName ?? p.customerId ?? 'No customer'}
                          <span className="ml-2 inline-block">
                            <Badge tone={p.kind === 'sales_receipt' ? 'info' : 'neutral'}>
                              {p.kind === 'sales_receipt'
                                ? 'Sales Receipt'
                                : p.kind === 'invoice_payment'
                                  ? 'Invoice Payment'
                                  : 'Payment'}
                            </Badge>
                          </span>
                        </span>
                        <span className="text-sm font-semibold text-navy tabular-nums shrink-0">
                          {formatCurrency(p.amount, p.currency ?? undefined)}
                        </span>
                      </div>
                      <div className="flex gap-3 text-xs text-navy/50 mt-0.5">
                        <span>{formatDate(p.date)}</span>
                        <span className="capitalize">{p.method.replace('_', ' ')}</span>
                        {p.reference && <span>#{p.reference}</span>}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Additional deposit lines (e.g. owner contribution) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Additional Deposit Lines</Label>
            <button
              type="button"
              onClick={() => setExtraLines((prev) => [...prev, emptyExtraLine()])}
              className="text-xs text-electric font-semibold hover:text-electric/70 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" /> Add Line
            </button>
          </div>
          {extraLines.length === 0 ? (
            <p className="text-xs text-navy/40">
              For funds not in Undeposited Funds — e.g. an owner contribution or refund.
            </p>
          ) : (
            <div className="space-y-2" onKeyDown={extraGrid.onKeyDown}>
              {extraLines.map((l, idx) => (
                <div key={idx} data-grid-row className="flex gap-2 items-center">
                  <div className="flex-1 min-w-0">
                    <Select
                      value={l.accountId}
                      onChange={(e) => patchExtraLine(idx, { accountId: e.target.value })}
                      aria-label={`Extra line ${idx + 1} account`}
                      {...fieldA11y('dep', `extra-${idx}-account`, fieldErrors)}
                    >
                      <option value="">From account…</option>
                      {allAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex-1 min-w-0">
                    <Input
                      placeholder="Description"
                      value={l.description}
                      onChange={(e) => patchExtraLine(idx, { description: e.target.value })}
                    />
                  </div>
                  <div className="w-28 shrink-0">
                    <AmountInput
                      placeholder="0.00"
                      aria-label={`Extra line ${idx + 1} amount`}
                      {...fieldA11y('dep', `extra-${idx}-amount`, fieldErrors)}
                      value={l.amount}
                      onChange={(e) => patchExtraLine(idx, { amount: e.target.value })}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setExtraLines((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-red-400 hover:text-red-600"
                    title="Remove line"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {Object.keys(fieldErrors)
                .filter((k) => k.startsWith('extra-'))
                .map((k) => (
                  <FieldError key={k} formId="dep" name={k} errors={fieldErrors} />
                ))}
            </div>
          )}
        </div>

        {/* Cash back */}
        <div>
          <Label className="mb-2">Cash Back (optional)</Label>
          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <Select
                value={cashBackAccountId}
                onChange={(e) => setCashBackAccountId(e.target.value)}
                aria-label="Cash back goes to"
                {...fieldA11y('dep', 'cashBackAccount', fieldErrors)}
              >
                <option value="">Cash back goes to…</option>
                {allAccounts
                  .filter((a) => a.id !== depositAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="w-28 shrink-0">
              <AmountInput
                placeholder="0.00"
                aria-label="Cash back amount"
                {...fieldA11y('dep', 'cashBackAmount', fieldErrors)}
                value={cashBackAmount}
                onChange={(e) => setCashBackAmount(e.target.value)}
              />
            </div>
          </div>
          <FieldError formId="dep" name="cashBackAccount" errors={fieldErrors} />
          <FieldError formId="dep" name="cashBackAmount" errors={fieldErrors} />
          <FieldError formId="dep" name="total" errors={fieldErrors} />
        </div>

        {/* Live total */}
        {(selectedIds.size > 0 || extraTotal > 0 || cashBackNum > 0) && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 space-y-1">
            <div className="flex items-center justify-between text-sm text-navy/70">
              <span>
                Selected ({selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''})
              </span>
              <span className="tabular-nums">{money(selectedTotal.toFixed(2))}</span>
            </div>
            {extraTotal > 0 && (
              <div className="flex items-center justify-between text-sm text-navy/70">
                <span>Additional lines</span>
                <span className="tabular-nums">{money(extraTotal.toFixed(2))}</span>
              </div>
            )}
            {cashBackNum > 0 && (
              <div className="flex items-center justify-between text-sm text-navy/70">
                <span>Cash back</span>
                <span className="tabular-nums">-{money(cashBackNum.toFixed(2))}</span>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-navy/10 pt-1">
              <span className="text-sm font-semibold text-navy/70">Net deposit</span>
              <span className="text-lg font-bold text-navy tabular-nums">
                {money(netTotal.toFixed(2))}
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function DepositsPageContent() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [undepositedItems, setUndepositedItems] = useState<UndepositedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [pendingVoid, setPendingVoid] = useState<string | null>(null);
  const [editing, setEditing] = useState<DepositEdit | null>(null);

  async function openEdit(id: string) {
    try {
      const dep = await api.get<Deposit>(`/api/deposits/${id}`);
      await fetchSupportingData();
      setEditing(depositToEdit(dep));
      setShowModal(true);
    } catch (err: unknown) {
      toastError(err, 'Failed to load the deposit.');
    }
  }

  const fetchDeposits = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.get<Deposit[]>('/api/deposits');
      setDeposits(rows);
    } catch (err: unknown) {
      toastError(err, 'Failed to load deposits.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSupportingData = useCallback(async () => {
    try {
      const [accts, items] = await Promise.all([
        api.get<Account[]>('/api/accounts'),
        (async () => {
          setLoadingItems(true);
          const r = await api.get<UndepositedItem[]>('/api/deposits/undeposited');
          setLoadingItems(false);
          return r;
        })(),
      ]);
      setAccounts(accts);
      setUndepositedItems(items);
    } catch (err: unknown) {
      toastError(err, 'Failed to load data.');
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    fetchDeposits();
    fetchSupportingData();
  }, [fetchDeposits, fetchSupportingData]);

  function openModal() {
    // Refresh undeposited items each time the modal is opened.
    setEditing(null);
    fetchSupportingData();
    setShowModal(true);
  }

  // Quick Actions navigate here with ?new=1 — open the Make Deposit modal.
  useNewParam(openModal);

  function handleCreated() {
    fetchDeposits();
    fetchSupportingData();
  }

  async function handleVoid(id: string) {
    setVoidingId(id);
    try {
      await api.del(`/api/deposits/${id}`);
      toast('Deposit voided — items returned to Undeposited Funds.', 'success');
      await Promise.all([fetchDeposits(), fetchSupportingData()]);
    } catch (err: unknown) {
      toastError(err, 'Failed to void deposit.');
    } finally {
      setVoidingId(null);
      setPendingVoid(null);
    }
  }

  // Bank accounts for the "Deposit To" picker (asset accounts excluding UF).
  const bankAccounts = accounts.filter((a) => a.type === 'asset' && a.code !== '1050');

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Bank Deposits"
        icon={Landmark}
        action={
          <Button onClick={openModal}>
            <Plus className="h-4 w-4" /> Make Deposit
          </Button>
        }
      />

      {/* Undeposited Funds summary banner */}
      {undepositedItems.length > 0 && (
        <div className="mb-6 flex items-center justify-between rounded-xl bg-gold/10 border border-gold/30 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-navy">
              {undepositedItems.length} undeposited item
              {undepositedItems.length !== 1 ? 's' : ''} in Undeposited Funds
            </p>
            <p className="text-xs text-navy/60 mt-0.5">
              Total:{' '}
              <strong>
                {formatCurrency(
                  undepositedItems
                    .reduce((s, p) => s + Number(p.amount), 0)
                    .toFixed(2),
                )}
              </strong>
            </p>
          </div>
          <Button size="sm" onClick={openModal}>
            Make Deposit
          </Button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="py-20 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : deposits.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No deposits yet"
            message="After you receive payments, take them to the bank and record the deposit here so your books match your bank statement."
            action={
              <Button onClick={openModal}>
                <Plus className="h-4 w-4" /> Make Deposit
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Date</Th>
                <Th>Account</Th>
                <Th>Lines</Th>
                <Th>Memo</Th>
                <Th>Status</Th>
                <Th numeric>Total</Th>
                <Th />
              </Tr>
            </thead>
            <tbody>
              {deposits.map((dep) => (
                <Tr key={dep.id} className={dep.voidedAt ? 'opacity-60' : undefined}>
                  <Td className="text-navy/70">{formatDate(dep.date)}</Td>
                  <Td className="font-medium text-navy">
                    {dep.accountCode ? (
                      <span>
                        <span className="text-navy/50 text-xs mr-1">{dep.accountCode}</span>
                        {dep.accountName}
                      </span>
                    ) : (
                      dep.depositAccountId
                    )}
                  </Td>
                  <Td className="text-navy/70">
                    {dep.lines.length} line{dep.lines.length !== 1 ? 's' : ''}
                  </Td>
                  <Td className="text-navy/60 text-sm">{dep.memo ?? '—'}</Td>
                  <Td>
                    {dep.voidedAt ? (
                      <Badge tone="void">Voided</Badge>
                    ) : (
                      <Badge tone="success">Posted</Badge>
                    )}
                  </Td>
                  <Td numeric className="font-semibold text-navy">
                    {formatCurrency(dep.total, dep.currency ?? undefined)}
                  </Td>
                  <Td className="text-right">
                    {!dep.voidedAt && (
                      <Button variant="ghost" size="sm" onClick={() => openEdit(dep.id)}>
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                    )}
                    {!dep.voidedAt && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700 hover:bg-red-50"
                        disabled={voidingId === dep.id}
                        onClick={() => setPendingVoid(dep.id)}
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

      {/* Summary footer (voided deposits excluded) */}
      {deposits.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {deposits.length} deposit{deposits.length !== 1 ? 's' : ''}
          </span>
          <span>
            Total deposited:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                deposits
                  .filter((d) => !d.voidedAt)
                  .reduce((s, d) => s + Number(d.total), 0)
                  .toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <MakeDepositModal
        open={showModal}
        onClose={() => {
          setShowModal(false);
          setEditing(null);
        }}
        onCreated={handleCreated}
        editing={editing}
        bankAccounts={bankAccounts}
        allAccounts={accounts}
        undepositedItems={undepositedItems}
        loadingItems={loadingItems}
      />

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void deposit?"
        message="Items will be returned to Undeposited Funds."
        confirmLabel="Void"
        tone="danger"
        loading={!!voidingId}
        onConfirm={() => pendingVoid && handleVoid(pendingVoid)}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}

export default function DepositsPage() {
  return (
    <Suspense fallback={null}>
      <DepositsPageContent />
    </Suspense>
  );
}
