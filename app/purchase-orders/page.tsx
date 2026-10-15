'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ShoppingCart,
  Plus,
  PlusCircle,
  MinusCircle,
  ArrowRight,
  Download,
  Ban,
  CheckSquare,
  Pencil,
} from 'lucide-react';
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
  useGridKeys,
} from '@/components/ui';
import { api } from '@/lib/client';
// wave2 prefs: Memorize (Ctrl+M)
import MemorizeButton from '@/components/MemorizeButton';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import {
  DocNumberField,
  docNo,
  useDocNumber,
  useDuplicateNumberConfirm,
} from '@/components/sales/DocNumberField';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string;
  displayName: string;
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
  type: string;
}

type PoStatus = 'open' | 'partial' | 'closed' | 'void';

interface PurchaseOrder {
  id: string;
  poNumber: number;
  /** P.O. No. the user typed / sees. */
  refNumber?: string | null;
  vendorId: string;
  date: string;
  expectedDate: string | null;
  total: string;
  status: PoStatus;
  convertedBillId: string | null;
  memo: string | null;
}

interface PoLine {
  id: string;
  itemId: string | null;
  accountId: string | null;
  description: string | null;
  quantity: string;
  rate: string;
  amount: string;
  quantityBilled: string;
  lineOrder: number;
}

interface PoDetail extends PurchaseOrder {
  lines: PoLine[];
}

interface LineRow {
  /** Saved line id (edit mode) - sent back so received/billed quantities stay linked. */
  id?: string;
  /** Quantity already received or billed from this line (edit mode). */
  billed?: number;
  itemId: string;
  accountId: string;
  description: string;
  quantity: string;
  rate: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusTone(status: PoStatus): 'info' | 'success' | 'warning' | 'neutral' {
  if (status === 'open') return 'info';
  if (status === 'partial') return 'warning';
  if (status === 'closed') return 'success';
  return 'neutral';
}

function statusLabel(status: PoStatus): string {
  if (status === 'open') return 'Open';
  if (status === 'partial') return 'Partially Billed';
  if (status === 'closed') return 'Closed';
  return 'Void';
}

function computeLineAmount(line: LineRow): number {
  const qty = parseFloat(line.quantity) || 0;
  const rate = parseFloat(line.rate) || 0;
  return qty * rate;
}

function computeTotal(lines: LineRow[]): number {
  return lines.reduce((sum, l) => sum + computeLineAmount(l), 0);
}

function lineRemaining(line: PoLine): number {
  return Math.max(0, (parseFloat(line.quantity) || 0) - (parseFloat(line.quantityBilled) || 0));
}

const EMPTY_LINE: LineRow = { itemId: '', accountId: '', description: '', quantity: '', rate: '' };

// ---------------------------------------------------------------------------
// New PO Modal
// ---------------------------------------------------------------------------

interface NewPoModalProps {
  open: boolean;
  onClose: () => void;
  vendors: Vendor[];
  accounts: Account[];
  items: Item[];
  onCreated: () => void;
  /** When set, edits this saved PO (PATCH) instead of creating one. */
  editId?: string | null;
}

function NewPoModal({ open, onClose, vendors, accounts, items, onCreated, editId }: NewPoModalProps) {
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);

  const [loadingEdit, setLoadingEdit] = useState(false);
  // P.O. No. (next number on a new PO; the saved one once the edited PO has loaded).
  const [editRef, setEditRef] = useState<string | null>(null);
  const docNumber = useDocNumber('purchase_order', open, editId ? (editRef ?? '') : null);
  const dupConfirm = useDuplicateNumberConfirm();

  // Reset form when modal opens (or load the saved PO when editing).
  useEffect(() => {
    if (!open) return;
    setVendorId('');
    setDate(new Date().toISOString().slice(0, 10));
    setExpectedDate('');
    setMemo('');
    setLines([{ ...EMPTY_LINE }]);
    setEditRef(null);
    if (!editId) return;
    let cancelled = false;
    setLoadingEdit(true);
    api
      .get<PoDetail>(`/api/purchase-orders/${editId}`)
      .then((po) => {
        if (cancelled) return;
        setVendorId(po.vendorId);
        setEditRef(docNo(po.refNumber, po.poNumber));
        setDate(String(po.date).slice(0, 10));
        setExpectedDate(po.expectedDate ? String(po.expectedDate).slice(0, 10) : '');
        setMemo(po.memo ?? '');
        setLines(
          po.lines.length > 0
            ? po.lines.map((l) => ({
                id: l.id,
                billed: parseFloat(l.quantityBilled) || 0,
                itemId: l.itemId ?? '',
                accountId: l.accountId ?? '',
                description: l.description ?? '',
                quantity: String(parseFloat(l.quantity)),
                rate: String(parseFloat(l.rate)),
              }))
            : [{ ...EMPTY_LINE }],
        );
      })
      .catch((err) => {
        toastError(err, 'Could not load this purchase order.');
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoadingEdit(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  function updateLine(idx: number, field: keyof LineRow, value: string) {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }

  function removeLine(idx: number) {
    // Lines already received or billed must stay on the PO.
    setLines((prev) => (prev[idx]?.billed ? prev : prev.filter((_, i) => i !== idx)));
  }

  // Line-grid keys: Enter / Down next line (adds one at the end), Ctrl+Insert, Ctrl+D.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: saving });

  const liveTotal = computeTotal(lines);

  // Only expense/asset accounts are valid targets for PO lines.
  const eligibleAccounts = accounts.filter(
    (a) => a.type === 'expense' || a.type === 'asset',
  );

  async function handleSubmit() {
    if (!vendorId) { toast('Please select a vendor.', 'danger'); return; }
    if (!date) { toast('Please enter a PO date.', 'danger'); return; }
    const validLines = lines.filter(
      (l) => l.itemId || l.accountId || l.description || l.quantity || l.rate,
    );
    if (validLines.length === 0) { toast('Add at least one line item.', 'danger'); return; }
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      if (!l.accountId && !l.itemId) {
        toast(`Line ${i + 1}: please select an item or an account.`, 'danger'); return;
      }
      if (!l.quantity || parseFloat(l.quantity) <= 0) {
        toast(`Line ${i + 1}: quantity must be a positive number.`, 'danger'); return;
      }
      if (!l.rate || parseFloat(l.rate) < 0) {
        toast(`Line ${i + 1}: rate cannot be negative.`, 'danger'); return;
      }
    }

    setSaving(true);
    try {
      const lineBody = validLines.map((l) => ({
        ...(l.id ? { id: l.id } : {}),
        itemId: l.itemId || null,
        accountId: l.accountId || null,
        description: l.description || null,
        quantity: l.quantity,
        rate: l.rate,
      }));
      const saved = await dupConfirm.run((allowDuplicateNumber) =>
        editId
          ? api.patch<PurchaseOrder>(`/api/purchase-orders/${editId}`, {
              vendorId,
              refNumber: docNumber.payload,
              allowDuplicateNumber,
              date,
              expectedDate: expectedDate || null,
              memo: memo || null,
              lines: lineBody,
            })
          : api.post<PurchaseOrder>('/api/purchase-orders', {
              vendorId,
              refNumber: docNumber.payload,
              allowDuplicateNumber,
              date,
              expectedDate: expectedDate || undefined,
              memo: memo || undefined,
              lines: lineBody,
            }),
      );
      if (saved === undefined) return;
      const savedNo = saved ? docNo(saved.refNumber, saved.poNumber) : '';
      toast(
        editId ? `Purchase order ${savedNo ? `#${savedNo} ` : ''}updated.` : `Purchase order ${savedNo ? `#${savedNo} ` : ''}created.`,
        'success',
      );
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, editId ? 'Failed to save changes.' : 'Failed to create purchase order.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editId ? `Edit Purchase Order${editRef ? ` #${editRef}` : ''}` : 'New Purchase Order'}
      size="lg"
      footer={
        <>
          <MemorizeButton
            docType="purchase_order"
            shortcut={open}
            defaultName={vendors.find((v) => v.id === vendorId)?.displayName}
            getTemplate={() => {
              if (!vendorId) return 'Pick a vendor before memorizing.';
              const valid = lines.filter((l) => (l.itemId || l.accountId) && l.quantity && l.rate);
              if (valid.length === 0) return 'Add at least one complete line before memorizing.';
              return {
                vendorId,
                date,
                expectedDate: expectedDate || undefined,
                memo: memo || undefined,
                lines: valid.map((l) => ({
                  itemId: l.itemId || null,
                  accountId: l.accountId || null,
                  description: l.description || null,
                  quantity: l.quantity,
                  rate: l.rate,
                })),
              };
            }}
          />
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {editId ? 'Cancel edit' : 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={loadingEdit}>
            {editId ? 'Save Changes' : 'Create PO'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editId && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Lines you have already received or billed can&apos;t be removed, and their quantity can&apos;t go
            below what was received or billed. Everything else can be changed.
          </div>
        )}
        {loadingEdit && (
          <div className="flex items-center gap-2 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading purchase order...
          </div>
        )}
        {/* Vendor */}
        <div>
          <Label htmlFor="po-vendor">Vendor *</Label>
          <Select
            id="po-vendor"
            autoFocus
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
          >
            <option value="">Select a vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </Select>
        </div>

        {/* P.O. No. + dates */}
        {dupConfirm.dialog}
        <div className="grid grid-cols-3 gap-3">
          <DocNumberField id="po-number" label="P.O. No." value={docNumber.value} onChange={docNumber.setValue} />
          <div>
            <Label htmlFor="po-date">PO Date *</Label>
            <Input
              id="po-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="po-expected">Expected Date</Label>
            <Input
              id="po-expected"
              type="date"
              value={expectedDate}
              onChange={(e) => setExpectedDate(e.target.value)}
            />
          </div>
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Line Items</Label>
            <Button type="button" variant="ghost" size="sm" onClick={addLine}>
              <PlusCircle className="h-4 w-4" /> Add line
            </Button>
          </div>

          <div className="rounded-lg border border-slate-200 overflow-hidden" onKeyDown={grid.onKeyDown}>
            {/* Header row */}
            <div className="grid grid-cols-[1.1fr_1.1fr_1fr_70px_80px_28px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
              <span>Item</span>
              <span>Account</span>
              <span>Description</span>
              <span>Qty</span>
              <span>Rate</span>
              <span />
            </div>

            {lines.map((line, idx) => (
              <div
                key={idx}
                data-grid-row
                className="grid grid-cols-[1.1fr_1.1fr_1fr_70px_80px_28px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
              >
                <Select
                  value={line.itemId}
                  onChange={(e) => updateLine(idx, 'itemId', e.target.value)}
                >
                  <option value="">Item…</option>
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={line.accountId}
                  onChange={(e) => updateLine(idx, 'accountId', e.target.value)}
                >
                  <option value="">{line.itemId ? 'Account (optional)…' : 'Account…'}</option>
                  {eligibleAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                <Input
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateLine(idx, 'description', e.target.value)}
                />
                <div>
                  <Input
                    placeholder="1"
                    type="number"
                    min="0"
                    step="any"
                    value={line.quantity}
                    onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                  />
                  {line.billed ? (
                    <p className="mt-0.5 text-[10px] leading-tight text-amber-700">
                      received/billed: {line.billed}
                    </p>
                  ) : null}
                </div>
                <Input
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="any"
                  value={line.rate}
                  onChange={(e) => updateLine(idx, 'rate', e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => removeLine(idx)}
                  disabled={lines.length === 1 || Boolean(line.billed)}
                  title={line.billed ? 'Already received or billed - this line stays on the PO' : 'Remove line'}
                  className="text-navy/30 hover:text-red-500 disabled:opacity-20 transition-colors flex items-center justify-center"
                  aria-label="Remove line"
                >
                  <MinusCircle className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="po-memo">Memo</Label>
          <Input
            id="po-memo"
            placeholder="Internal notes…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        {/* Live total */}
        <div className="flex items-center justify-between rounded-lg bg-navy/5 px-4 py-3">
          <span className="text-sm font-semibold text-navy/70">Estimated Total</span>
          <span className="text-lg font-bold text-navy tabular-nums">
            {formatCurrency(liveTotal.toFixed(2))}
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Receive & Bill modal — per-line billed/remaining with quantity inputs
// ---------------------------------------------------------------------------

interface ReceiveBillModalProps {
  po: PurchaseOrder | null;
  onClose: () => void;
  onBilled: () => void;
  accounts: Account[];
  items: Item[];
}

function ReceiveBillModal({ po, onClose, onBilled, accounts, items }: ReceiveBillModalProps) {
  const [detail, setDetail] = useState<PoDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [billing, setBilling] = useState(false);
  /** lineId → quantity-to-bill input value */
  const [qtyInputs, setQtyInputs] = useState<Record<string, string>>({});

  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, `${a.code} — ${a.name}`]));
  const itemMap = Object.fromEntries(items.map((it) => [it.id, it.name]));

  // Load PO detail (lines with quantityBilled) when the modal opens.
  useEffect(() => {
    if (!po) {
      setDetail(null);
      setQtyInputs({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<PoDetail>(`/api/purchase-orders/${po.id}`)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        // Default each line's "bill now" quantity to its remaining quantity.
        setQtyInputs(
          Object.fromEntries(
            d.lines.map((l) => [l.id, String(lineRemaining(l))]),
          ),
        );
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load purchase order.';
        toast(msg, 'danger');
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po?.id]);

  const billTotal = detail
    ? detail.lines.reduce((sum, l) => {
        const qty = parseFloat(qtyInputs[l.id] ?? '') || 0;
        return sum + qty * (parseFloat(l.rate) || 0);
      }, 0)
    : 0;

  async function handleBill() {
    if (!po || !detail) return;

    const billLines: { lineId: string; quantity: string }[] = [];
    for (const [i, l] of detail.lines.entries()) {
      const raw = qtyInputs[l.id] ?? '';
      const qty = parseFloat(raw) || 0;
      if (qty < 0) {
        toast(`Line ${i + 1}: quantity cannot be negative.`, 'danger');
        return;
      }
      if (qty === 0) continue;
      const remaining = lineRemaining(l);
      if (qty > remaining + 1e-9) {
        toast(`Line ${i + 1}: only ${remaining} remaining to bill.`, 'danger');
        return;
      }
      billLines.push({ lineId: l.id, quantity: raw });
    }
    if (billLines.length === 0) {
      toast('Enter a quantity to bill on at least one line.', 'danger');
      return;
    }

    setBilling(true);
    try {
      await api.post(`/api/purchase-orders/${po.id}`, {
        action: 'convert',
        lines: billLines,
      });
      toast(`Bill created from PO #${docNo(po.refNumber, po.poNumber)}.`, 'success');
      onBilled();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create bill.';
      toast(msg, 'danger');
    } finally {
      setBilling(false);
    }
  }

  return (
    <Modal
      open={!!po}
      onClose={onClose}
      title={po ? `Receive & Bill — PO #${docNo(po.refNumber, po.poNumber)}` : 'Receive & Bill'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={billing}>
            Cancel
          </Button>
          <Button onClick={handleBill} loading={billing} disabled={loading || !detail}>
            Create Bill
          </Button>
        </>
      }
    >
      {loading || !detail ? (
        <div className="py-10 flex items-center justify-center gap-2 text-sm text-navy/40">
          <Spinner className="h-4 w-4" /> Loading purchase order…
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Enter the quantities received to bill now. Anything left unbilled keeps the PO open
            as <strong>Partially Billed</strong>; billing every remaining quantity closes it.
            Inventory items are received into stock when the bill posts.
          </p>

          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <div className="grid grid-cols-[1.4fr_70px_70px_80px_90px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
              <span>Item / Account</span>
              <span className="text-right">Ordered</span>
              <span className="text-right">Billed</span>
              <span className="text-right">Remaining</span>
              <span className="text-right">Bill Now</span>
            </div>

            {detail.lines.map((l) => {
              const remaining = lineRemaining(l);
              const label = l.itemId
                ? itemMap[l.itemId] ?? 'Item'
                : l.accountId
                  ? accountMap[l.accountId] ?? 'Account'
                  : '—';
              return (
                <div
                  key={l.id}
                  className="grid grid-cols-[1.4fr_70px_70px_80px_90px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-navy">{label}</div>
                    {l.description && (
                      <div className="truncate text-xs text-navy/50">{l.description}</div>
                    )}
                  </div>
                  <span className="text-right text-sm tabular-nums text-navy/70">
                    {parseFloat(l.quantity) || 0}
                  </span>
                  <span className="text-right text-sm tabular-nums text-navy/70">
                    {parseFloat(l.quantityBilled) || 0}
                  </span>
                  <span
                    className={`text-right text-sm tabular-nums font-medium ${
                      remaining > 0 ? 'text-navy' : 'text-navy/30'
                    }`}
                  >
                    {remaining}
                  </span>
                  <Input
                    type="number"
                    min="0"
                    max={remaining}
                    step="any"
                    disabled={remaining <= 0}
                    value={qtyInputs[l.id] ?? ''}
                    onChange={(e) =>
                      setQtyInputs((prev) => ({ ...prev, [l.id]: e.target.value }))
                    }
                    className="text-right"
                  />
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-navy/5 px-4 py-3">
            <span className="text-sm font-semibold text-navy/70">Bill Total</span>
            <span className="text-lg font-bold text-navy tabular-nums">
              {formatCurrency(billTotal.toFixed(2))}
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function PurchaseOrdersPage() {
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  // Receive & Bill state
  const [billTarget, setBillTarget] = useState<PurchaseOrder | null>(null);

  // Void / Close state
  const [voidTarget, setVoidTarget] = useState<PurchaseOrder | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);

  const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v.displayName]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [poList, vendorList, accountList, itemRes] = await Promise.all([
        api.get<PurchaseOrder[]>('/api/purchase-orders'),
        api.get<Vendor[]>('/api/vendors'),
        api.get<Account[]>('/api/accounts'),
        api.get<{ items: Item[] }>('/api/items'),
      ]);
      setPos(poList);
      setVendors(vendorList);
      setAccounts(accountList);
      setItems(itemRes.items ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load purchase orders.';
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
      await api.post(`/api/purchase-orders/${voidTarget.id}`, { action: 'void' });
      toast(`PO #${docNo(voidTarget.refNumber, voidTarget.poNumber)} voided.`, 'success');
      setVoidTarget(null);
      await fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void purchase order.';
      toast(msg, 'danger');
    } finally {
      setVoiding(false);
    }
  }

  async function handleClose(po: PurchaseOrder) {
    setClosingId(po.id);
    try {
      await api.post(`/api/purchase-orders/${po.id}`, { action: 'close' });
      toast(`PO #${docNo(po.refNumber, po.poNumber)} closed.`, 'success');
      await fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to close purchase order.';
      toast(msg, 'danger');
    } finally {
      setClosingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Purchase Orders"
        icon={ShoppingCart}
        action={
          <Button onClick={() => setShowNew(true)}>
            <Plus className="h-4 w-4" /> New PO
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading purchase orders…
          </div>
        ) : pos.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title="No purchase orders yet"
            message="Create your first purchase order to start tracking what you've ordered from vendors."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New PO
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>PO #</Th>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th>Expected</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {pos.map((po) => (
                <Tr key={po.id}>
                  <Td className="font-semibold text-navy">#{docNo(po.refNumber, po.poNumber)}</Td>
                  <Td>{vendorMap[po.vendorId] ?? '—'}</Td>
                  <Td className="text-navy/70">{po.date ? formatDate(po.date, 'MMM d, yyyy') : '—'}</Td>
                  <Td className="text-navy/70">
                    {po.expectedDate ? formatDate(po.expectedDate, 'MMM d, yyyy') : '—'}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(po.total)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(po.status)}>{statusLabel(po.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* PDF download */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.open(`/api/purchase-orders/${po.id}/pdf`, '_blank')}
                        title="Download PDF"
                      >
                        <Download className="h-3.5 w-3.5" /> PDF
                      </Button>
                      {(po.status === 'open' || po.status === 'partial') && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditId(po.id);
                              setShowNew(true);
                            }}
                            title="Edit the purchase order"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setBillTarget(po)}
                            title="Receive items and create a bill"
                          >
                            <ArrowRight className="h-3.5 w-3.5" /> Receive &amp; Bill
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={closingId === po.id}
                            onClick={() => handleClose(po)}
                            title="Close the PO — no further billing"
                          >
                            <CheckSquare className="h-3.5 w-3.5" /> Close
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setVoidTarget(po)}
                            title="Void the PO"
                          >
                            <Ban className="h-3.5 w-3.5" /> Void
                          </Button>
                        </>
                      )}
                      {po.status === 'closed' && po.convertedBillId && (
                        <span className="text-xs text-navy/30 italic">Bill created</span>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Summary footer */}
      {pos.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {pos.length} purchase order{pos.length !== 1 ? 's' : ''}
          </span>
          <span>
            Open:{' '}
            <span className="font-semibold text-navy/70">
              {pos.filter((p) => p.status === 'open').length}
            </span>
          </span>
          <span>
            Partially billed:{' '}
            <span className="font-semibold text-navy/70">
              {pos.filter((p) => p.status === 'partial').length}
            </span>
          </span>
          <span>
            Open value:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                pos
                  .filter((p) => p.status === 'open' || p.status === 'partial')
                  .reduce((s, p) => s + Number(p.total), 0)
                  .toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <NewPoModal
        open={showNew}
        onClose={() => {
          setShowNew(false);
          setEditId(null);
        }}
        vendors={vendors}
        accounts={accounts}
        items={items}
        onCreated={fetchData}
        editId={editId}
      />

      <ReceiveBillModal
        po={billTarget}
        onClose={() => setBillTarget(null)}
        onBilled={fetchData}
        accounts={accounts}
        items={items}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void purchase order?"
        message={`Void PO #${docNo(voidTarget?.refNumber, voidTarget?.poNumber ?? '')} (${formatCurrency(voidTarget?.total ?? '0')})? The PO can no longer be billed. This cannot be undone.`}
        confirmLabel="Void"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}
