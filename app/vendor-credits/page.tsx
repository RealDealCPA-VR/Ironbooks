'use client';

import { isDepositTargetAccount } from '@/lib/accountTypes';
import { useEffect, useState, useCallback } from 'react';
import { RotateCcw, Plus, Trash2, PlusCircle, MinusCircle, CheckCircle, Banknote, Pencil, Printer } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
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
  Modal,
  PageHeader,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { Money, formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string;
  displayName: string;
  /** p1 fx: the vendor's currency (null = home); its credits are in it. */
  currency?: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

interface Bill {
  id: string;
  vendorId: string;
  billNumber: string | null;
  total: string;
  balanceDue: string;
  status: string;
  date: string;
}

interface VendorCredit {
  id: string;
  vendorId: string;
  date: string;
  status: 'open' | 'partial' | 'closed' | 'void';
  total: string;
  unapplied: string;
  refundedAmount: string;
  memo: string | null;
  refNumber?: string | null;
}

interface CreditLine {
  accountId: string;
  description: string;
  amount: string;
  classId: string;
  customerId: string;
  jobId: string;
}

/** Items tab line (returned items). */
interface ItemLine {
  itemId: string;
  description: string;
  quantity: string;
  unitCost: string;
  amount: string;
  classId: string;
  customerId: string;
  jobId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusTone(status: VendorCredit['status']): 'info' | 'warning' | 'success' | 'neutral' {
  if (status === 'open') return 'info';
  if (status === 'partial') return 'warning';
  if (status === 'closed') return 'success';
  return 'neutral';
}

function statusLabel(status: VendorCredit['status']): string {
  if (status === 'open') return 'Open';
  if (status === 'partial') return 'Partial';
  if (status === 'closed') return 'Closed';
  return 'Void';
}

const EMPTY_LINE: CreditLine = { accountId: '', description: '', amount: '', classId: '', customerId: '', jobId: '' };
const EMPTY_ITEM_LINE: ItemLine = {
  itemId: '',
  description: '',
  quantity: '',
  unitCost: '',
  amount: '',
  classId: '',
  customerId: '',
  jobId: '',
};

// ---------------------------------------------------------------------------
// New Vendor Credit Modal
// ---------------------------------------------------------------------------

interface NewCreditModalProps {
  open: boolean;
  onClose: () => void;
  vendors: Vendor[];
  accounts: Account[];
  onCreated: () => void;
  /** When set, the modal edits this saved credit (PATCH) instead of creating one. */
  editId?: string | null;
}

interface Named {
  id: string;
  name?: string;
  displayName?: string;
  type?: string;
  customerId?: string | null;
  purchaseCost?: string | null;
  averageCost?: string | null;
}

interface SavedLine {
  accountId: string;
  itemId: string | null;
  quantity: string | null;
  unitCost: string | null;
  description: string | null;
  amount: string;
  classId: string | null;
  customerId: string | null;
  jobId: string | null;
}

/** QB Enter Bills (Credit): Expenses and Items tabs, Ref. No., Class and Customer:Job per line. */
function NewCreditModal({ open, onClose, vendors, accounts, onCreated, editId }: NewCreditModalProps) {
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [refNumber, setRefNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [tab, setTab] = useState<'expenses' | 'items'>('expenses');
  const [lines, setLines] = useState<CreditLine[]>([{ ...EMPTY_LINE }]);
  const [itemLines, setItemLines] = useState<ItemLine[]>([{ ...EMPTY_ITEM_LINE }]);
  const [saving, setSaving] = useState(false);
  // p1 fx: a foreign vendor's credit is in its currency at the stated / list rate.
  const [fxRate, setFxRate] = useState('');
  const vendorCur = vendors.find((v) => v.id === vendorId)?.currency || null;

  const [loadingEdit, setLoadingEdit] = useState(false);
  const [itemList, setItemList] = useState<Named[]>([]);
  const [classList, setClassList] = useState<Named[]>([]);
  const [customerList, setCustomerList] = useState<Named[]>([]);
  const [jobList, setJobList] = useState<Named[]>([]);

  // Lists for the Items tab and the Class / Customer:Job columns.
  useEffect(() => {
    if (!open) return;
    const soft = <T,>(p: Promise<T>, fb: T) => p.catch(() => fb);
    Promise.all([
      soft(api.get<Named[]>('/api/items'), []),
      soft(api.get<Named[]>('/api/classes'), []),
      soft(api.get<Named[]>('/api/customers'), []),
      soft(api.get<Named[]>('/api/jobs'), []),
    ]).then(([it, cl, cu, jb]) => {
      setItemList(Array.isArray(it) ? it.filter((i) => !['subtotal', 'discount', 'payment', 'sales_tax', 'group'].includes(i.type ?? '')) : []);
      setClassList(Array.isArray(cl) ? cl : []);
      setCustomerList(Array.isArray(cu) ? cu : []);
      setJobList(Array.isArray(jb) ? jb : []);
    });
  }, [open]);

  // Reset on open (or load the saved credit when editing).
  useEffect(() => {
    if (!open) return;
    setVendorId('');
    setDate(new Date().toISOString().slice(0, 10));
    setRefNumber('');
    setMemo('');
    setTab('expenses');
    setLines([{ ...EMPTY_LINE }]);
    setItemLines([{ ...EMPTY_ITEM_LINE }]);
    setFxRate('');
    if (!editId) return;
    let cancelled = false;
    setLoadingEdit(true);
    api
      .get<{
        vendorId: string;
        date: string;
        memo: string | null;
        refNumber: string | null;
        exchangeRate?: string | null;
        lines: SavedLine[];
      }>(
        `/api/vendor-credits/${editId}`,
      )
      .then((c) => {
        if (cancelled) return;
        setVendorId(c.vendorId);
        setDate(String(c.date).slice(0, 10));
        setMemo(c.memo ?? '');
        setRefNumber(c.refNumber ?? '');
        setFxRate(c.exchangeRate ? String(Number(c.exchangeRate)) : '');
        const dims = (l: SavedLine) => ({ classId: l.classId ?? '', customerId: l.customerId ?? '', jobId: l.jobId ?? '' });
        const exp = c.lines.filter((l) => !l.itemId);
        const its = c.lines.filter((l) => l.itemId);
        setLines(
          exp.length > 0
            ? exp.map((l) => ({ accountId: l.accountId, description: l.description ?? '', amount: l.amount, ...dims(l) }))
            : [{ ...EMPTY_LINE }],
        );
        setItemLines(
          its.length > 0
            ? its.map((l) => ({
                itemId: l.itemId ?? '',
                description: l.description ?? '',
                quantity: l.quantity ? String(Number(l.quantity)) : '',
                unitCost: l.unitCost ? String(Number(l.unitCost)) : '',
                amount: l.amount,
                ...dims(l),
              }))
            : [{ ...EMPTY_ITEM_LINE }],
        );
        if (exp.length === 0 && its.length > 0) setTab('items');
      })
      .catch((err) => {
        toastError(err, 'Could not load this vendor credit.');
        onClose();
      })
      .finally(() => !cancelled && setLoadingEdit(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  function updateLine(idx: number, field: keyof CreditLine, value: string) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value, ...(field === 'customerId' ? { jobId: '' } : {}) } : l)));
  }

  function updateItemLine(idx: number, field: keyof ItemLine, value: string) {
    setItemLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const next: ItemLine = { ...l, [field]: value, ...(field === 'customerId' ? { jobId: '' } : {}) };
        if (field === 'itemId') {
          const it = itemList.find((x) => x.id === value);
          next.unitCost = it?.purchaseCost ? String(Number(it.purchaseCost)) : next.unitCost;
          if (!next.description) next.description = it?.name ?? '';
        }
        if (field === 'itemId' || field === 'quantity' || field === 'unitCost') {
          const q = parseFloat(next.quantity);
          const c = parseFloat(next.unitCost);
          if (!isNaN(q) && !isNaN(c)) next.amount = (Math.round(q * c * 100) / 100).toFixed(2);
        }
        return next;
      }),
    );
  }

  const expenseLinesFilled = lines.filter((l) => l.accountId && l.amount);
  const itemLinesFilled = itemLines.filter((l) => l.itemId && l.quantity);
  const liveTotal = Money.add(
    ...expenseLinesFilled.map((l) => l.amount || 0),
    ...itemLinesFilled.map((l) => l.amount || 0),
  );

  async function handleSubmit() {
    if (!vendorId) { toast('Please select a vendor.', 'danger'); return; }
    if (!date) { toast('Please enter a date.', 'danger'); return; }
    if (expenseLinesFilled.length + itemLinesFilled.length === 0) {
      toast('Add at least one expense line (account and amount) or item line (item and quantity).', 'danger');
      return;
    }
    for (const [i, l] of expenseLinesFilled.entries()) {
      if (!(parseFloat(l.amount) > 0)) { toast(`Expenses line ${i + 1}: amount must be greater than zero.`, 'danger'); return; }
    }
    for (const [i, l] of itemLinesFilled.entries()) {
      if (!(parseFloat(l.quantity) > 0)) { toast(`Items line ${i + 1}: enter the quantity returned.`, 'danger'); return; }
      if (!(parseFloat(l.amount) > 0)) { toast(`Items line ${i + 1}: enter the cost or amount.`, 'danger'); return; }
    }
    const dims = (l: { classId: string; customerId: string; jobId: string }) => ({
      classId: l.classId || null,
      customerId: l.customerId || null,
      jobId: l.jobId || null,
    });

    setSaving(true);
    try {
      const body = {
        vendorId,
        date,
        refNumber: refNumber.trim() || null,
        memo: memo || null,
        lines: [
          ...expenseLinesFilled.map((l) => ({
            accountId: l.accountId,
            description: l.description || null,
            amount: l.amount,
            ...dims(l),
          })),
          ...itemLinesFilled.map((l) => ({
            itemId: l.itemId,
            quantity: l.quantity,
            unitCost: l.unitCost || null,
            amount: l.amount || null,
            description: l.description || null,
            ...dims(l),
          })),
        ],
        ...(vendorCur && fxRate.trim() ? { exchangeRate: fxRate.trim() } : {}),
      };
      if (editId) {
        await api.patch(`/api/vendor-credits/${editId}`, body);
        toast('Vendor credit updated.', 'success');
      } else {
        await api.post('/api/vendor-credits', body);
        toast('Vendor credit created.', 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, editId ? 'Failed to save changes.' : 'Failed to create vendor credit.');
    } finally {
      setSaving(false);
    }
  }

  // Show only expense/asset accounts for credit lines (the accounts that get credited).
  const eligibleAccounts = accounts.filter(
    (a) =>
      (a.type === 'expense' || a.type === 'asset') &&
      a.subtype !== 'accounts_receivable',
  );

  const dimCells = (
    l: { classId: string; customerId: string; jobId: string },
    set: (f: 'classId' | 'customerId' | 'jobId', v: string) => void,
  ) => {
    const jobs = l.customerId ? jobList.filter((j) => !j.customerId || j.customerId === l.customerId) : [];
    return (
      <>
        <Select aria-label="Class" value={l.classId} onChange={(e) => set('classId', e.target.value)}>
          <option value="">Class</option>
          {classList.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        <div className="flex gap-1">
          <Select aria-label="Customer:Job" value={l.customerId} onChange={(e) => set('customerId', e.target.value)}>
            <option value="">Customer:Job</option>
            {customerList.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName ?? c.name}</option>
            ))}
          </Select>
          {jobs.length > 0 && (
            <Select aria-label="Job" value={l.jobId} onChange={(e) => set('jobId', e.target.value)}>
              <option value="">Job</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>{j.name}</option>
              ))}
            </Select>
          )}
        </div>
      </>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editId ? 'Edit Vendor Credit' : 'New Vendor Credit'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {editId ? 'Cancel edit' : 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={loadingEdit}>
            {editId ? 'Save Changes' : 'Create Credit'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editId && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Changing amounts, items or quantities is only possible while none of the credit is applied or
            refunded — memo, Ref. No. and descriptions can always be changed.
          </div>
        )}
        {loadingEdit && (
          <div className="flex items-center gap-2 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading credit…
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="vc-vendor">Vendor *</Label>
            <Select id="vc-vendor" autoFocus value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select a vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.displayName}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="vc-date">Credit Date *</Label>
            <Input id="vc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="vc-ref">Ref. No.</Label>
            <Input id="vc-ref" placeholder="Vendor's credit memo #" value={refNumber} onChange={(e) => setRefNumber(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="vc-memo">Memo</Label>
          <Input
            id="vc-memo"
            placeholder="e.g. Returned goods, overcharge refund…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        {/* Expenses / Items tabs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex gap-1" role="tablist">
              {(['expenses', 'items'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-md px-3 py-1 text-sm font-semibold ${tab === t ? 'bg-electric text-white' : 'text-navy/60 hover:bg-navy/5'}`}
                >
                  {t === 'expenses'
                    ? `Expenses ${formatCurrency(Money.add(...expenseLinesFilled.map((l) => l.amount || 0)))}`
                    : `Items ${formatCurrency(Money.add(...itemLinesFilled.map((l) => l.amount || 0)))}`}
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                tab === 'expenses'
                  ? setLines((p) => [...p, { ...EMPTY_LINE }])
                  : setItemLines((p) => [...p, { ...EMPTY_ITEM_LINE }])
              }
            >
              <PlusCircle className="h-4 w-4" /> Add line
            </Button>
          </div>

          {tab === 'expenses' ? (
            <div className="rounded-lg border border-slate-200 overflow-x-auto">
              <div className="grid min-w-[760px] grid-cols-[1.3fr_1fr_90px_1fr_1.3fr_28px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
                <span>Account</span>
                <span>Memo</span>
                <span>Amount</span>
                <span>Class</span>
                <span>Customer:Job</span>
                <span />
              </div>
              {lines.map((line, idx) => (
                <div
                  key={idx}
                  className="grid min-w-[760px] grid-cols-[1.3fr_1fr_90px_1fr_1.3fr_28px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
                >
                  <Select aria-label="Account" value={line.accountId} onChange={(e) => updateLine(idx, 'accountId', e.target.value)}>
                    <option value="">Select account…</option>
                    {eligibleAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                  <Input placeholder="Description" value={line.description} onChange={(e) => updateLine(idx, 'description', e.target.value)} />
                  <Input placeholder="0.00" type="number" min="0.01" step="0.01" value={line.amount} onChange={(e) => updateLine(idx, 'amount', e.target.value)} />
                  {dimCells(line, (f, v) => updateLine(idx, f, v))}
                  <button
                    type="button"
                    onClick={() => setLines((p) => (p.length === 1 ? [{ ...EMPTY_LINE }] : p.filter((_, i) => i !== idx)))}
                    className="text-navy/30 hover:text-red-500 transition-colors flex items-center justify-center"
                    aria-label="Remove line"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 overflow-x-auto">
              <div className="grid min-w-[880px] grid-cols-[1.3fr_1fr_70px_80px_90px_1fr_1.3fr_28px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
                <span>Item</span>
                <span>Description</span>
                <span>Qty</span>
                <span>Cost</span>
                <span>Amount</span>
                <span>Class</span>
                <span>Customer:Job</span>
                <span />
              </div>
              {itemLines.map((line, idx) => (
                <div
                  key={idx}
                  className="grid min-w-[880px] grid-cols-[1.3fr_1fr_70px_80px_90px_1fr_1.3fr_28px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
                >
                  <Select aria-label="Item" value={line.itemId} onChange={(e) => updateItemLine(idx, 'itemId', e.target.value)}>
                    <option value="">Select item…</option>
                    {itemList.map((it) => (
                      <option key={it.id} value={it.id}>{it.name}</option>
                    ))}
                  </Select>
                  <Input placeholder="Description" value={line.description} onChange={(e) => updateItemLine(idx, 'description', e.target.value)} />
                  <Input aria-label="Quantity" type="number" min="0" step="any" value={line.quantity} onChange={(e) => updateItemLine(idx, 'quantity', e.target.value)} />
                  <Input aria-label="Cost" type="number" min="0" step="any" value={line.unitCost} onChange={(e) => updateItemLine(idx, 'unitCost', e.target.value)} />
                  <Input aria-label="Amount" type="number" min="0.01" step="0.01" value={line.amount} onChange={(e) => updateItemLine(idx, 'amount', e.target.value)} />
                  {dimCells(line, (f, v) => updateItemLine(idx, f, v))}
                  <button
                    type="button"
                    onClick={() => setItemLines((p) => (p.length === 1 ? [{ ...EMPTY_ITEM_LINE }] : p.filter((_, i) => i !== idx)))}
                    className="text-navy/30 hover:text-red-500 transition-colors flex items-center justify-center"
                    aria-label="Remove line"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <p className="px-3 py-2 text-xs text-navy/50">
                Returned inventory leaves stock at its current cost. If the vendor credits a different amount, the
                difference goes to Cost of Goods Sold.
              </p>
            </div>
          )}
        </div>

        {/* Live total */}
        <div className="flex items-center justify-between rounded-lg bg-navy/5 px-4 py-3">
          <span className="text-sm font-semibold text-navy/70">Credit Total</span>
          <span className="text-lg font-bold text-navy tabular-nums">
            {formatCurrency(liveTotal.toFixed(2), vendorCur ?? undefined)}
          </span>
        </div>
        {vendorCur && (
          <div>
            <Label htmlFor="vc-rate">Exchange rate (1 {vendorCur} = ? home)</Label>
            <Input
              id="vc-rate"
              inputMode="decimal"
              placeholder="Blank = Currencies list rate"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
            />
            <p className="text-xs text-navy/40 mt-1">
              This vendor uses {vendorCur}. When the credit is applied to a {vendorCur} bill, any difference between the two
              rates is recorded as an exchange gain or loss.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Apply to Bill Modal
// ---------------------------------------------------------------------------

interface ApplyModalProps {
  open: boolean;
  credit: VendorCredit | null;
  bills: Bill[];
  onClose: () => void;
  onApplied: () => void;
}

function ApplyModal({ open, credit, bills, onClose, onApplied }: ApplyModalProps) {
  const [billId, setBillId] = useState('');
  const [amount, setAmount] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (open) {
      setBillId('');
      setAmount('');
    }
  }, [open]);

  // Only bills belonging to the same vendor that have a balance.
  const eligibleBills = bills.filter(
    (b) => b.vendorId === credit?.vendorId && parseFloat(b.balanceDue) > 0 && b.status !== 'void',
  );

  const maxAmount = Math.min(
    parseFloat(credit?.unapplied ?? '0'),
    parseFloat(bills.find((b) => b.id === billId)?.balanceDue ?? '0'),
  );

  async function handleApply() {
    if (!credit) return;
    if (!billId) { toast('Please select a bill.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Amount must be greater than zero.', 'danger'); return; }

    setApplying(true);
    try {
      await api.post(`/api/vendor-credits/${credit.id}`, {
        action: 'apply',
        billId,
        amount,
      });
      toast('Credit applied to bill.', 'success');
      onApplied();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to apply credit.';
      toast(msg, 'danger');
    } finally {
      setApplying(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Apply Vendor Credit to Bill"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>Cancel</Button>
          <Button onClick={handleApply} loading={applying}>
            Apply Credit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {credit && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm">
            <span className="text-navy/60">Unapplied credit balance: </span>
            <span className="font-bold text-navy tabular-nums">
              {formatCurrency(credit.unapplied)}
            </span>
          </div>
        )}

        <div>
          <Label htmlFor="apply-bill">Bill *</Label>
          <Select id="apply-bill" autoFocus value={billId} onChange={(e) => setBillId(e.target.value)}>
            <option value="">Select a bill…</option>
            {eligibleBills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.billNumber
                  ? `#${b.billNumber} — Balance: ${formatCurrency(b.balanceDue)} — ${formatDate(b.date, 'MMM d, yyyy')}`
                  : `Bill dated ${formatDate(b.date, 'MMM d, yyyy')} — Balance: ${formatCurrency(b.balanceDue)}`}
              </option>
            ))}
          </Select>
          {eligibleBills.length === 0 && (
            <p className="mt-1 text-xs text-navy/40">No open bills found for this vendor.</p>
          )}
        </div>

        <div>
          <Label htmlFor="apply-amount">Amount to Apply *</Label>
          <Input
            id="apply-amount"
            type="number"
            min="0.01"
            step="0.01"
            max={maxAmount > 0 ? maxAmount : undefined}
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {billId && maxAmount > 0 && (
            <p className="mt-1 text-xs text-navy/50">
              Max applicable: {formatCurrency(maxAmount.toFixed(2))}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Refund Modal — record a vendor refund (cash back) against the credit
// ---------------------------------------------------------------------------

interface RefundModalProps {
  open: boolean;
  credit: VendorCredit | null;
  accounts: Account[];
  onClose: () => void;
  onRefunded: () => void;
}

function RefundModal({ open, credit, accounts, onClose, onRefunded }: RefundModalProps) {
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && credit) {
      setBankAccountId('');
      setAmount(Number(credit.unapplied).toFixed(2));
    }
  }, [open, credit]);

  // Accounts a vendor refund can be deposited to: banks, Undeposited Funds and other
  // cash-like current assets (lib/accountTypes.ts, same rule the service enforces).
  const bankAccounts = accounts.filter((a) => isDepositTargetAccount(a));

  async function handleRefund() {
    if (!credit) return;
    if (!bankAccountId) { toast('Select a bank account.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Enter a valid refund amount.', 'danger'); return; }

    setSaving(true);
    try {
      await api.post(`/api/vendor-credits/${credit.id}`, {
        action: 'refund',
        bankAccountId,
        amount,
      });
      toast('Vendor refund recorded.', 'success');
      onRefunded();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record refund.';
      toast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record Vendor Refund"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleRefund} loading={saving}>
            Record Refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {credit && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm">
            <span className="text-navy/60">Unapplied credit available to refund: </span>
            <span className="font-bold text-navy tabular-nums">
              {formatCurrency(credit.unapplied)}
            </span>
          </div>
        )}

        <div>
          <Label htmlFor="vc-refund-bank">Deposit To (Bank Account) *</Label>
          <Select
            id="vc-refund-bank"
            autoFocus
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
          >
            <option value="">Select a bank account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="vc-refund-amt">Refund Amount *</Label>
          <Input
            id="vc-refund-amt"
            type="number"
            min="0.01"
            step="0.01"
            max={credit?.unapplied}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function VendorCreditsPage() {
  const [credits, setCredits] = useState<VendorCredit[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNew, setShowNew] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [applyTarget, setApplyTarget] = useState<VendorCredit | null>(null);
  const [refundTarget, setRefundTarget] = useState<VendorCredit | null>(null);
  const [voidTarget, setVoidTarget] = useState<VendorCredit | null>(null);
  const [voiding, setVoiding] = useState(false);

  const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v.displayName]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [creditList, vendorList, accountList, billList] = await Promise.all([
        api.get<VendorCredit[]>('/api/vendor-credits'),
        api.get<Vendor[]>('/api/vendors'),
        api.get<Account[]>('/api/accounts'),
        api.get<Bill[]>('/api/bills'),
      ]);
      setCredits(creditList);
      setVendors(vendorList);
      setAccounts(accountList);
      setBills(billList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load vendor credits.';
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  async function handleVoid() {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/vendor-credits/${voidTarget.id}`);
      toast('Vendor credit voided.', 'success');
      setVoidTarget(null);
      fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void vendor credit.';
      toast(msg, 'danger');
    } finally {
      setVoiding(false);
    }
  }

  const totalUnapplied = credits
    .filter((c) => c.status !== 'void')
    .reduce((s, c) => s + Number(c.unapplied), 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Vendor Credits"
        icon={RotateCcw}
        action={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Vendor Credit
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading vendor credits…
          </div>
        ) : credits.length === 0 ? (
          <EmptyState
            icon={RotateCcw}
            title="No vendor credits yet"
            message="Record a credit from a vendor to apply it against bills or get a refund."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Vendor Credit
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th>Ref. No.</Th>
                <Th>Memo</Th>
                <Th numeric>Total</Th>
                <Th numeric>Unapplied</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {credits.map((c) => (
                <Tr key={c.id}>
                  <Td className="font-medium text-navy">
                    {vendorMap[c.vendorId] ?? '—'}
                  </Td>
                  <Td className="text-navy/70">{c.date ? formatDate(c.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td className="text-navy/70">{c.refNumber ?? '—'}</Td>
                  <Td className="text-navy/60 text-sm truncate max-w-[200px]">
                    {c.memo ?? '—'}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(c.total)}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(c.unapplied)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <a href={`/api/vendor-credits/${c.id}/pdf`} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="sm" title="Print credit">
                          <Printer className="h-3.5 w-3.5" /> Print
                        </Button>
                      </a>
                      {c.status !== 'void' && c.status !== 'closed' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setApplyTarget(c)}
                          title="Apply to bill"
                        >
                          <CheckCircle className="h-3.5 w-3.5" /> Apply
                        </Button>
                      )}
                      {c.status !== 'void' && Number(c.unapplied) > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRefundTarget(c)}
                          title="Record vendor refund (cash back)"
                        >
                          <Banknote className="h-3.5 w-3.5" /> Refund
                        </Button>
                      )}
                      {c.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditId(c.id);
                            setShowNew(true);
                          }}
                          title="Edit credit"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                      )}
                      {c.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          onClick={() => setVoidTarget(c)}
                          title="Void credit"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Void
                        </Button>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer */}
      {credits.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {credits.length} credit{credits.length !== 1 ? 's' : ''}
          </span>
          <span>
            Open:{' '}
            <span className="font-semibold text-navy/70">
              {credits.filter((c) => c.status === 'open' || c.status === 'partial').length}
            </span>
          </span>
          <span>
            Total unapplied:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(totalUnapplied.toFixed(2))}
            </span>
          </span>
        </div>
      )}

      <NewCreditModal
        open={showNew}
        onClose={() => {
          setShowNew(false);
          setEditId(null);
        }}
        vendors={vendors}
        accounts={accounts}
        onCreated={fetchData}
        editId={editId}
      />

      <ApplyModal
        open={!!applyTarget}
        credit={applyTarget}
        bills={bills}
        onClose={() => setApplyTarget(null)}
        onApplied={fetchData}
      />

      <RefundModal
        open={!!refundTarget}
        credit={refundTarget}
        accounts={accounts}
        onClose={() => setRefundTarget(null)}
        onRefunded={fetchData}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void vendor credit?"
        message={`Are you sure you want to void this vendor credit (${formatCurrency(voidTarget?.total ?? '0')})? This will reverse the GL entry and cannot be undone.`}
        confirmLabel="Void Credit"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}
