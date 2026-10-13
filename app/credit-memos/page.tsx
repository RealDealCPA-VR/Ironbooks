'use client';

import { useEffect, useState, useCallback } from 'react';
import { RotateCcw, Plus, PlusCircle, MinusCircle, Pencil } from 'lucide-react';
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
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  Spinner,
  toast,
  useGridKeys,
} from '@/components/ui';
import { api } from '@/lib/client';
// wave2 prefs: Memorize (Ctrl+M)
import MemorizeButton from '@/components/MemorizeButton';
import { formatCurrency } from '@/lib/money';
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  inventoryLinePayload,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';
import { formatDate } from '@/lib/format';
import {
  EMPTY_SHIPPING,
  FormSendButtons,
  ShippingSection,
  type ShippingState,
  shippingFromDoc,
  shippingPayload,
  useCustomerSalesDefaults,
} from '@/components/sales/SalesExtras';
import {
  DocNumberField,
  docNo,
  useDocNumber,
  useDuplicateNumberConfirm,
} from '@/components/sales/DocNumberField';
import { usePreferences } from '@/lib/usePreferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
}

interface Invoice {
  id: string;
  invoiceNumber: number;
  refNumber?: string | null;
  customerId: string;
  status: string;
  balanceDue: string;
  total: string;
}

interface CreditMemo {
  id: string;
  memoNumber: number;
  /** Credit No. the user typed / sees. */
  refNumber?: string | null;
  customerId: string;
  date: string;
  status: 'open' | 'paid' | 'void';
  total: string;
  unapplied: string;
  refundedAmount: string;
  memo: string | null;
}

/** GET /api/credit-memos/:id — prefills the edit form (wave2 sales C1). */
interface CreditMemoDetail extends CreditMemo {
  taxRateId: string | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
  lines: Array<{
    itemId: string | null;
    description: string | null;
    quantity: string;
    rate: string;
    taxable?: boolean;
    restock?: boolean;
  }>;
  applications: Array<{ id: string; invoiceId: string; invoiceNumber: number; invoiceRef?: string | null; amount: string; paymentId: string | null }>;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface Item {
  id: string;
  name: string;
  type: 'service' | 'inventory' | 'non_inventory' | 'bundle';
  salesPrice: string | null;
  taxable: boolean;
  trackingMode?: string | null;
}

interface TaxRate {
  id: string;
  name: string;
  rate: string; // fraction, e.g. "0.082500"
}

interface LineRow {
  itemId: string;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  /** Inventory items only: true = return to stock, false = damaged write-off. */
  restock: boolean;
  /** Advanced Inventory: site / bin / serials / lot the returned goods go back to. */
  inv?: InvDetail;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusTone(status: CreditMemo['status']): 'info' | 'success' | 'neutral' | 'warning' {
  if (status === 'open') return 'info';
  if (status === 'paid') return 'success';
  return 'neutral';
}

function statusLabel(status: CreditMemo['status']): string {
  if (status === 'open') return 'Open';
  if (status === 'paid') return 'Applied';
  return 'Void';
}

function computeLineTotal(line: LineRow): number {
  return (parseFloat(line.quantity) || 0) * (parseFloat(line.rate) || 0);
}

function computeSubtotal(lines: LineRow[]): number {
  return lines.reduce((sum, l) => sum + computeLineTotal(l), 0);
}

/** Mirror the service math: tax applies to taxable lines only. */
function computeTax(lines: LineRow[], taxRate: number): number {
  const taxableSubtotal = lines.reduce(
    (sum, l) => sum + (l.taxable ? computeLineTotal(l) : 0),
    0,
  );
  return taxableSubtotal * taxRate;
}

const EMPTY_LINE: LineRow = {
  itemId: '',
  description: '',
  quantity: '',
  rate: '',
  taxable: true,
  restock: true,
};

// ---------------------------------------------------------------------------
// New Credit Memo Modal
// ---------------------------------------------------------------------------

interface NewMemoModalProps {
  open: boolean;
  /** wave2 sales (C1): memo being edited (null = new). */
  editing?: CreditMemoDetail | null;
  onClose: () => void;
  customers: Customer[];
  items: Item[];
  taxRates: TaxRate[];
  onCreated: () => void;
}

function NewMemoModal({ open, editing, onClose, customers, items, taxRates, onCreated }: NewMemoModalProps) {
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memoNote, setMemoNote] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const salesTaxOn = usePreferences().company.salesTaxEnabled;
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [flags, setFlags] = useState<ShippingState>(EMPTY_SHIPPING);
  const [applications, setApplications] = useState<CreditMemoDetail['applications']>([]);
  const [saving, setSaving] = useState(false);
  const docNumber = useDocNumber('credit_memo', open, editing ? docNo(editing.refNumber, editing.memoNumber) : null);
  const dupConfirm = useDuplicateNumberConfirm();
  // Customer defaults (new credit memos): tax item / non-taxable tax code.
  const custDefaults = useCustomerSalesDefaults(open ? customerId : null);
  useEffect(() => {
    if (!custDefaults || editing) return;
    setTaxRateId(custDefaults.taxable ? (custDefaults.taxRateId ?? '') : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custDefaults]);

  useEffect(() => {
    if (open && editing) {
      setCustomerId(editing.customerId);
      setDate(editing.date.slice(0, 10));
      setMemoNote(editing.memo ?? '');
      setTaxRateId(editing.taxRateId ?? '');
      setFlags(shippingFromDoc(editing));
      setApplications(editing.applications ?? []);
      setLines(
        editing.lines.map((l) => ({
          itemId: l.itemId ?? '',
          description: l.description ?? '',
          quantity: String(Number(l.quantity)),
          rate: String(Number(l.rate)),
          taxable: l.taxable !== false,
          restock: l.restock !== false,
        })),
      );
      return;
    }
    if (open) {
      setFlags(shippingFromDoc(null));
      setApplications([]);
      setCustomerId('');
      setDate(new Date().toISOString().slice(0, 10));
      setMemoNote('');
      setTaxRateId('');
      setLines([{ ...EMPTY_LINE }]);
    }
  }, [open, editing]);

  async function unapply(applicationId: string) {
    if (!editing) return;
    try {
      await api.post(`/api/credit-memos/${editing.id}`, { action: 'unapply', applicationId });
      setApplications((prev) => prev.filter((a) => a.id !== applicationId));
      toast('Credit unapplied — the invoice is open again.', 'success');
      onCreated();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Could not unapply the credit.', 'danger');
    }
  }

  const itemMap = new Map(items.map((i) => [i.id, i]));

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  /** Selecting an item pre-fills description/rate/taxable like the invoice modal. */
  function selectItem(idx: number, itemId: string) {
    const item = itemMap.get(itemId);
    if (!item) {
      updateLine(idx, { itemId: '' });
      return;
    }
    updateLine(idx, {
      itemId,
      description: lines[idx].description || item.name,
      rate: lines[idx].rate || (item.salesPrice ?? ''),
      taxable: item.taxable,
      restock: true,
    });
  }

  const selectedRate = taxRates.find((t) => t.id === taxRateId);
  const liveSubtotal = computeSubtotal(lines);
  const liveTax = selectedRate ? computeTax(lines, parseFloat(selectedRate.rate) || 0) : 0;
  const liveTotal = liveSubtotal + liveTax;

  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }

  // Advanced Inventory: sites/bins + scan-to-add.
  const adv = useAdvancedInventory(open);
  function addScannedItem(it: { id: string; name: string; salesPrice?: string | null }) {
    const item = itemMap.get(it.id);
    setLines((prev) => {
      const row: LineRow = {
        ...EMPTY_LINE,
        itemId: it.id,
        description: it.name,
        quantity: '1',
        rate: it.salesPrice ?? '',
        taxable: item?.taxable ?? true,
      };
      const emptyIdx = prev.findIndex((l) => !l.itemId && !l.description && !l.quantity && !l.rate);
      if (emptyIdx >= 0) return prev.map((l, i) => (i === emptyIdx ? row : l));
      return [...prev, row];
    });
  }

  function removeLine(idx: number) {
    // Keep at least one line (mirrors the per-row remove button being disabled).
    setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  }

  // Line-grid keyboard ergonomics: Ctrl+Insert add / Ctrl+Delete remove / Enter down.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: saving });

  async function handleSubmit() {
    if (!customerId) { toast('Please select a customer.', 'danger'); return; }
    if (!date) { toast('Please enter a date.', 'danger'); return; }
    const validLines = lines.filter((l) => l.quantity || l.rate);
    if (validLines.length === 0) { toast('Add at least one line item.', 'danger'); return; }
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      if (!l.quantity || parseFloat(l.quantity) <= 0) {
        toast(`Line ${i + 1}: quantity must be positive.`, 'danger'); return;
      }
      if (!l.rate || parseFloat(l.rate) < 0) {
        toast(`Line ${i + 1}: rate cannot be negative.`, 'danger'); return;
      }
    }

    setSaving(true);
    try {
      const body = {
        ...shippingPayload(flags, { shipping: false }),
        refNumber: docNumber.payload,
        customerId,
        date,
        memo: memoNote || null,
        taxRateId: taxRateId || null,
        lines: validLines.map((l) => ({
          itemId: l.itemId || null,
          description: l.description || null,
          quantity: l.quantity,
          rate: l.rate,
          taxable: l.taxable,
          restock: l.restock,
          ...(l.restock ? inventoryLinePayload(l.inv) : {}),
        })),
      };
      const saved = await dupConfirm.run((allowDuplicateNumber) =>
        editing
          ? api.patch<CreditMemo>(`/api/credit-memos/${editing.id}`, { ...body, allowDuplicateNumber })
          : api.post<CreditMemo>('/api/credit-memos', { ...body, allowDuplicateNumber }),
      );
      if (saved === undefined) return;
      if (editing) {
        toast(`Credit Memo #${docNo(saved.refNumber, saved.memoNumber)} updated.`, 'success');
      } else {
        toast(`Credit Memo #${docNo(saved.refNumber, saved.memoNumber)} created.`, 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create credit memo.';
      toast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title={editing ? `Edit Credit Memo #${docNo(editing.refNumber, editing.memoNumber)}` : 'New Credit Memo'}
      footer={
        <>
          <MemorizeButton
            docType="credit_memo"
            shortcut={open}
            defaultName={customers.find((c) => c.id === customerId)?.displayName}
            getTemplate={() => {
              if (!customerId) return 'Pick a customer before memorizing.';
              const valid = lines.filter((l) => l.quantity || l.rate);
              if (valid.length === 0) return 'Add at least one line before memorizing.';
              // Lot / serial picks for restocked items are one-time and are not memorized.
              return {
                customerId,
                date,
                memo: memoNote || null,
                taxRateId: taxRateId || null,
                lines: valid.map((l) => ({
                  itemId: l.itemId || null,
                  description: l.description || null,
                  quantity: l.quantity,
                  rate: l.rate,
                  taxable: l.taxable,
                  restock: l.restock,
                })),
              };
            }}
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : 'Create Credit Memo'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Saving changes re-posts this credit so your books stay balanced. Credit already applied
            or refunded stays used, so the new total can&apos;t be less than that.
          </div>
        )}
        {editing && applications.length > 0 && (
          <div className="rounded-lg border border-slate-100 p-3 text-sm">
            <p className="font-semibold text-navy mb-2">Applied to</p>
            <ul className="space-y-1">
              {applications.map((a) => (
                <li key={a.id} className="flex items-center justify-between">
                  <span>
                    Invoice #{a.invoiceRef || a.invoiceNumber} — {formatCurrency(a.amount)}
                    {a.paymentId ? <span className="text-navy/40"> (with a payment)</span> : null}
                  </span>
                  {!a.paymentId && (
                    <Button variant="ghost" size="sm" onClick={() => unapply(a.id)}>
                      Unapply
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Customer */}
        <div>
          <Label htmlFor="cm-customer">Customer *</Label>
          <Select
            id="cm-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            autoFocus
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
        </div>

        {/* Credit No. + Date */}
        <div className="grid grid-cols-2 gap-3">
          <DocNumberField id="cm-number" label="Credit No." value={docNumber.value} onChange={docNumber.setValue} />
          <div>
            <Label htmlFor="cm-date">Date *</Label>
            <DateInput
              id="cm-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Line Items</Label>
            <div className="flex items-center gap-3">
              <BarcodeScanInput onItem={addScannedItem} />
              <button
                type="button"
                onClick={addLine}
                className="text-electric hover:text-electric/80 flex items-center gap-1 text-sm font-medium"
              >
                <PlusCircle className="h-4 w-4" /> Add line
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 overflow-hidden" onKeyDown={grid.onKeyDown}>
            <div className="grid grid-cols-[minmax(110px,1fr)_minmax(110px,1fr)_64px_80px_40px_56px_32px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
              <span>Item</span>
              <span>Description</span>
              <span>Qty</span>
              <span>Rate</span>
              <span title="Line participates in sales tax">Tax</span>
              <span title="Return inventory to stock (uncheck for damaged write-off)">Restock</span>
              <span />
            </div>
            {lines.map((line, idx) => {
              const lineItem = line.itemId ? itemMap.get(line.itemId) : undefined;
              const isInventory = lineItem?.type === 'inventory';
              return (
                <div
                  key={idx}
                  data-grid-row
                  className="grid grid-cols-[minmax(110px,1fr)_minmax(110px,1fr)_64px_80px_40px_56px_32px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
                >
                  <Select
                    value={line.itemId}
                    onChange={(e) => selectItem(idx, e.target.value)}
                    aria-label={`Line ${idx + 1} item`}
                  >
                    <option value="">— No item —</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>{it.name}</option>
                    ))}
                  </Select>
                  <Input
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => updateLine(idx, { description: e.target.value })}
                  />
                  <AmountInput
                    placeholder="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                  />
                  <AmountInput
                    placeholder="0.00"
                    value={line.rate}
                    onChange={(e) => updateLine(idx, { rate: e.target.value })}
                  />
                  <span className="flex items-center justify-center">
                    <input
                      type="checkbox"
                      checked={line.taxable}
                      onChange={(e) => updateLine(idx, { taxable: e.target.checked })}
                      className="h-4 w-4 accent-electric"
                      aria-label={`Line ${idx + 1} taxable`}
                    />
                  </span>
                  <span className="flex items-center justify-center">
                    {isInventory ? (
                      <input
                        type="checkbox"
                        checked={line.restock}
                        onChange={(e) => updateLine(idx, { restock: e.target.checked })}
                        className="h-4 w-4 accent-electric"
                        aria-label={`Line ${idx + 1} restock`}
                        title="Checked: return to stock. Unchecked: damaged write-off (cost stays in COGS)."
                      />
                    ) : (
                      <span className="text-navy/20 text-xs">—</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                    disabled={lines.length === 1}
                    className="text-navy/30 hover:text-red-500 disabled:opacity-20 transition-colors flex items-center justify-center"
                    aria-label="Remove line"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </button>
                  {line.restock && (
                    <InventoryLineFields
                      className="col-span-full"
                      adv={adv}
                      item={lineItem}
                      quantity={line.quantity}
                      direction="in"
                      value={line.inv}
                      onChange={(inv) => updateLine(idx, { inv })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Tax rate */}
        {/* Hidden while "Charge sales tax" is off (QB removes tax from forms); an old document keeps its tax. */}
        {(salesTaxOn || taxRateId) && (<div>
          <Label htmlFor="cm-taxrate">Sales Tax Rate</Label>
          <Select
            id="cm-taxrate"
            value={taxRateId}
            onChange={(e) => setTaxRateId(e.target.value)}
          >
            <option value="">No tax</option>
            {taxRates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
              </option>
            ))}
          </Select>
        </div>)}

        {/* Memo note */}
        <div>
          <Label htmlFor="cm-note">Memo / Note</Label>
          <Input
            id="cm-note"
            placeholder="Optional internal note…"
            value={memoNote}
            onChange={(e) => setMemoNote(e.target.value)}
          />
        </div>

        <ShippingSection value={flags} onChange={setFlags} showShipping={false} idPrefix="cm" />
        {dupConfirm.dialog}

        {/* Live totals */}
        <div className="rounded-lg bg-navy/5 px-4 py-3 space-y-1">
          <div className="flex items-center justify-between text-sm text-navy/60">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatCurrency(liveSubtotal.toFixed(2))}</span>
          </div>
          <div className="flex items-center justify-between text-sm text-navy/60">
            <span>Sales Tax{selectedRate ? ` (${(parseFloat(selectedRate.rate) * 100).toFixed(2)}%)` : ''}</span>
            <span className="tabular-nums">{formatCurrency(liveTax.toFixed(2))}</span>
          </div>
          <div className="flex items-center justify-between pt-1 border-t border-navy/10">
            <span className="text-sm font-semibold text-navy/70">Credit Total</span>
            <span className="text-lg font-bold text-navy tabular-nums">
              {formatCurrency(liveTotal.toFixed(2))}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Apply to Invoice Modal
// ---------------------------------------------------------------------------

interface ApplyModalProps {
  open: boolean;
  memo: CreditMemo | null;
  onClose: () => void;
  onApplied: () => void;
}

function ApplyModal({ open, memo, onClose, onApplied }: ApplyModalProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoiceId, setInvoiceId] = useState('');
  const [amount, setAmount] = useState('');
  const [applying, setApplying] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !memo) return;
    setInvoiceId('');
    setAmount('');
    setLoading(true);
    api.get<Invoice[]>(`/api/invoices?customerId=${memo.customerId}`)
      .then((list) => setInvoices(list.filter((i) => i.status !== 'void' && i.status !== 'paid')))
      .catch(() => toast('Failed to load invoices.', 'danger'))
      .finally(() => setLoading(false));
  }, [open, memo]);

  // Pre-fill amount from selected invoice's balanceDue capped by unapplied
  useEffect(() => {
    if (!invoiceId || !memo) return;
    const inv = invoices.find((i) => i.id === invoiceId);
    if (!inv) return;
    const cap = Math.min(Number(inv.balanceDue), Number(memo.unapplied));
    setAmount(cap.toFixed(2));
  }, [invoiceId, invoices, memo]);

  async function handleApply() {
    if (!memo) return;
    if (!invoiceId) { toast('Select an invoice.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Enter a valid amount.', 'danger'); return; }

    setApplying(true);
    try {
      await api.post(`/api/credit-memos/${memo.id}`, {
        action: 'apply',
        invoiceId,
        amount,
      });
      toast('Credit applied to invoice.', 'success');
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
      title={`Apply Credit Memo #${docNo(memo?.refNumber, memo?.memoNumber ?? '')}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>Cancel</Button>
          <Button onClick={handleApply} loading={applying} disabled={loading}>
            Apply Credit
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {memo && (
          <div className="rounded-lg bg-emerald/10 border border-emerald/30 px-4 py-3 text-sm text-navy/80">
            Unapplied balance:{' '}
            <span className="font-bold">{formatCurrency(memo.unapplied)}</span>
          </div>
        )}

        <div>
          <Label htmlFor="apply-inv">Invoice to Apply To *</Label>
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-navy/40">
              <Spinner className="h-4 w-4" /> Loading invoices…
            </div>
          ) : invoices.length === 0 ? (
            <p className="text-sm text-navy/40 py-2">No open invoices for this customer.</p>
          ) : (
            <Select
              id="apply-inv"
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value)}
            >
              <option value="">Select an invoice…</option>
              {invoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  #{inv.refNumber || inv.invoiceNumber} — Balance: {formatCurrency(inv.balanceDue)}
                </option>
              ))}
            </Select>
          )}
        </div>

        <div>
          <Label htmlFor="apply-amt">Amount to Apply *</Label>
          <AmountInput
            id="apply-amt"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Refund Modal — issue a refund check for the unapplied balance
// ---------------------------------------------------------------------------

interface RefundModalProps {
  open: boolean;
  memo: CreditMemo | null;
  accounts: Account[];
  onClose: () => void;
  onRefunded: () => void;
}

function RefundModal({ open, memo, accounts, onClose, onRefunded }: RefundModalProps) {
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && memo) {
      setBankAccountId('');
      setAmount(Number(memo.unapplied).toFixed(2));
    }
  }, [open, memo]);

  const bankAccounts = accounts.filter((a) => a.type === 'asset');

  async function handleRefund() {
    if (!memo) return;
    if (!bankAccountId) { toast('Select a bank account.', 'danger'); return; }
    if (!amount || parseFloat(amount) <= 0) { toast('Enter a valid refund amount.', 'danger'); return; }

    setSaving(true);
    try {
      await api.post(`/api/credit-memos/${memo.id}`, {
        action: 'refund',
        bankAccountId,
        amount,
      });
      toast('Refund check recorded.', 'success');
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
      title={`Refund Credit Memo #${docNo(memo?.refNumber, memo?.memoNumber ?? '')}`}
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
        {memo && (
          <div className="rounded-lg bg-emerald/10 border border-emerald/30 px-4 py-3 text-sm text-navy/80">
            Unapplied balance available to refund:{' '}
            <span className="font-bold">{formatCurrency(memo.unapplied)}</span>
          </div>
        )}

        <div>
          <Label htmlFor="refund-bank">Refund From (Bank Account) *</Label>
          <Select
            id="refund-bank"
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
          <Label htmlFor="refund-amt">Refund Amount *</Label>
          <AmountInput
            id="refund-amt"
            placeholder="0.00"
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

export default function CreditMemosPage() {
  const [memos, setMemos] = useState<CreditMemo[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  const [applyTarget, setApplyTarget] = useState<CreditMemo | null>(null);
  const [refundTarget, setRefundTarget] = useState<CreditMemo | null>(null);
  const [voidTarget, setVoidTarget] = useState<CreditMemo | null>(null);
  const [editTarget, setEditTarget] = useState<CreditMemoDetail | null>(null);

  async function openEdit(m: CreditMemo) {
    try {
      setEditTarget(await api.get<CreditMemoDetail>(`/api/credit-memos/${m.id}`));
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Could not open the credit memo.', 'danger');
    }
  }
  const [voiding, setVoiding] = useState(false);

  const customerMap = Object.fromEntries(customers.map((c) => [c.id, c.displayName]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [memoList, custList, acctList, itemRes, rateList] = await Promise.all([
        api.get<CreditMemo[]>('/api/credit-memos'),
        api.get<Customer[]>('/api/customers'),
        api.get<Account[]>('/api/accounts').catch(() => [] as Account[]),
        api.get<{ items: Item[] }>('/api/items').catch(() => ({ items: [] as Item[] })),
        api.get<TaxRate[]>('/api/tax-rates').catch(() => [] as TaxRate[]),
      ]);
      setMemos(memoList);
      setCustomers(custList);
      setAccounts(Array.isArray(acctList) ? acctList : []);
      setItems(Array.isArray(itemRes?.items) ? itemRes.items : []);
      setTaxRates(Array.isArray(rateList) ? rateList : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load credit memos.';
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
      await api.del(`/api/credit-memos/${voidTarget.id}`);
      toast(`Credit Memo #${docNo(voidTarget.refNumber, voidTarget.memoNumber)} voided.`, 'success');
      setVoidTarget(null);
      fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void credit memo.';
      toast(msg, 'danger');
    } finally {
      setVoiding(false);
    }
  }

  const totalUnapplied = memos
    .filter((m) => m.status !== 'void')
    .reduce((s, m) => s + Number(m.unapplied), 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Credit Memos"
        icon={RotateCcw}
        action={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New Credit Memo
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : memos.length === 0 ? (
          <EmptyState
            icon={RotateCcw}
            title="No credit memos yet"
            message="Create your first credit memo to get started."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Credit Memo
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Memo #</Th>
                <Th>Customer</Th>
                <Th>Date</Th>
                <Th numeric>Total</Th>
                <Th numeric>Unapplied</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {memos.map((m) => (
                <Tr key={m.id}>
                  <Td className="font-semibold text-navy">#{docNo(m.refNumber, m.memoNumber)}</Td>
                  <Td>{customerMap[m.customerId] ?? '—'}</Td>
                  <Td className="text-navy/70">{formatDate(m.date)}</Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(m.total)}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(m.unapplied)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(m.status)}>{statusLabel(m.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <span className="inline-flex items-center gap-1">
                      {m.status !== 'void' && <FormSendButtons kind="credit_memo" id={m.id} />}
                      {m.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Edit credit memo"
                          aria-label="Edit credit memo"
                          onClick={() => openEdit(m)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {m.status === 'open' && Number(m.unapplied) > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setApplyTarget(m)}
                          title="Apply to Invoice"
                        >
                          Apply
                        </Button>
                      )}
                      {m.status !== 'void' && Number(m.unapplied) > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRefundTarget(m)}
                          title="Refund by check"
                        >
                          Refund
                        </Button>
                      )}
                      {m.status !== 'void' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setVoidTarget(m)}
                          className="text-red-500 hover:bg-red-50"
                          title="Void credit memo"
                        >
                          Void
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

      {memos.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {memos.length} credit memo{memos.length !== 1 ? 's' : ''}
          </span>
          <span>
            Total unapplied:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(totalUnapplied.toFixed(2))}
            </span>
          </span>
        </div>
      )}

      <NewMemoModal
        open={showNew || !!editTarget}
        editing={editTarget}
        onClose={() => {
          setShowNew(false);
          setEditTarget(null);
        }}
        customers={customers}
        items={items}
        taxRates={taxRates}
        onCreated={fetchData}
      />

      <ApplyModal
        open={!!applyTarget}
        memo={applyTarget}
        onClose={() => setApplyTarget(null)}
        onApplied={fetchData}
      />

      <RefundModal
        open={!!refundTarget}
        memo={refundTarget}
        accounts={accounts}
        onClose={() => setRefundTarget(null)}
        onRefunded={fetchData}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void Credit Memo"
        message={
          <>
            Are you sure you want to void{' '}
            <strong>Credit Memo #{docNo(voidTarget?.refNumber, voidTarget?.memoNumber)}</strong>? This will reverse the GL
            entry and cannot be undone.
          </>
        }
        confirmLabel="Void Credit Memo"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}
