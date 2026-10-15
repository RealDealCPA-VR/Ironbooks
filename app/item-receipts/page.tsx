'use client';

/**
 * Item Receipts — QB "Receive Items" (stock arrives before the vendor's bill).
 * List + New Receipt (vendor / optional PO picker prefilling remaining
 * quantities) + Convert to Bill + Void.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  PackageCheck,
  Plus,
  PlusCircle,
  MinusCircle,
  ArrowRight,
  Ban,
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
import {
  BarcodeScanInput,
  InventoryLineFields,
  type InvDetail,
  inventoryLinePayload,
  invFromLine,
  useAdvancedInventory,
} from '@/components/inventory/AdvancedInventory';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string;
  displayName: string;
}

interface Item {
  id: string;
  name: string;
  type: string;
  purchaseCost?: string | null;
  trackingMode?: string | null;
}

type ReceiptStatus = 'open' | 'partial' | 'billed' | 'void';

interface ItemReceipt {
  id: string;
  vendorId: string;
  purchaseOrderId: string | null;
  date: string;
  reference: string | null;
  status: ReceiptStatus;
  total: string;
  memo: string | null;
  convertedBillId: string | null;
}

interface PurchaseOrder {
  id: string;
  poNumber: number;
  /** P.O. No. the user sees (typed ref number). */
  refNumber?: string | null;
  vendorId: string;
  status: 'open' | 'partial' | 'closed' | 'void';
}

interface PoLine {
  id: string;
  itemId: string | null;
  description: string | null;
  quantity: string;
  rate: string;
  quantityBilled: string;
}

interface PoDetail extends PurchaseOrder {
  lines: PoLine[];
}

interface LineRow {
  itemId: string;
  description: string;
  quantity: string;
  unitCost: string;
  /** Advanced Inventory: receiving site / bin / serials / lot. */
  inv?: InvDetail;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusTone(status: ReceiptStatus): 'info' | 'success' | 'neutral' | 'warning' {
  if (status === 'open') return 'info';
  if (status === 'partial') return 'warning';
  if (status === 'billed') return 'success';
  return 'neutral';
}

function statusLabel(status: ReceiptStatus): string {
  if (status === 'open') return 'Awaiting Bill';
  if (status === 'partial') return 'Partly Billed';
  if (status === 'billed') return 'Billed';
  return 'Void';
}

function computeTotal(lines: LineRow[]): number {
  return lines.reduce(
    (sum, l) => sum + (parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0),
    0,
  );
}

function lineRemaining(line: PoLine): number {
  return Math.max(0, (parseFloat(line.quantity) || 0) - (parseFloat(line.quantityBilled) || 0));
}

const EMPTY_LINE: LineRow = { itemId: '', description: '', quantity: '', unitCost: '' };

// ---------------------------------------------------------------------------
// New Receipt modal
// ---------------------------------------------------------------------------

interface NewReceiptModalProps {
  open: boolean;
  onClose: () => void;
  vendors: Vendor[];
  items: Item[];
  onCreated: () => void;
  /** When set, edits this saved (unbilled) receipt (PATCH) instead of creating one. */
  editId?: string | null;
}

function NewReceiptModal({ open, onClose, vendors, items, onCreated, editId }: NewReceiptModalProps) {
  const [vendorId, setVendorId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineRow[]>([{ ...EMPTY_LINE }]);
  const [saving, setSaving] = useState(false);

  // PO picker state.
  const [vendorPos, setVendorPos] = useState<PurchaseOrder[]>([]);
  const [poId, setPoId] = useState('');
  const [poLoading, setPoLoading] = useState(false);

  const itemMap = Object.fromEntries(items.map((it) => [it.id, it.name]));
  const itemById = new Map(items.map((it) => [it.id, it]));
  const adv = useAdvancedInventory(open);

  // Scan-to-add: a scanned item fills the first empty line or appends one (qty 1, last cost).
  function addScannedItem(it: { id: string; name: string; purchaseCost?: string | null }) {
    setLines((prev) => {
      const row: LineRow = { itemId: it.id, description: '', quantity: '1', unitCost: it.purchaseCost ?? '' };
      const emptyIdx = prev.findIndex((l) => !l.itemId && !l.quantity && !l.unitCost);
      if (emptyIdx >= 0) return prev.map((l, i) => (i === emptyIdx ? row : l));
      return [...prev, row];
    });
  }

  const [loadingEdit, setLoadingEdit] = useState(false);
  /** PO linked to the receipt being edited — restored after the vendor effect clears poId. */
  const pendingPoRef = useRef<string | null>(null);

  // Reset the form when the modal opens (or load the saved receipt when editing).
  useEffect(() => {
    if (!open) return;
    setVendorId('');
    setDate(new Date().toISOString().slice(0, 10));
    setReference('');
    setMemo('');
    setLines([{ ...EMPTY_LINE }]);
    setVendorPos([]);
    setPoId('');
    pendingPoRef.current = null;
    if (!editId) return;
    let cancelled = false;
    setLoadingEdit(true);
    api
      .get<{
        vendorId: string;
        purchaseOrderId: string | null;
        date: string;
        reference: string | null;
        memo: string | null;
        lines: Array<{
          itemId: string;
          description: string | null;
          quantity: string;
          unitCost: string;
          siteId?: string | null;
          binId?: string | null;
          serialNumbers?: string[] | null;
          lotNumber?: string | null;
          lotExpiration?: string | null;
        }>;
      }>(`/api/item-receipts/${editId}`)
      .then((r) => {
        if (cancelled) return;
        pendingPoRef.current = r.purchaseOrderId ?? null;
        setVendorId(r.vendorId);
        setDate(String(r.date).slice(0, 10));
        setReference(r.reference ?? '');
        setMemo(r.memo ?? '');
        setLines(
          r.lines.length > 0
            ? r.lines.map((l) => ({
                itemId: l.itemId,
                description: l.description ?? '',
                quantity: String(parseFloat(l.quantity)),
                unitCost: String(parseFloat(l.unitCost)),
                inv: invFromLine(l),
              }))
            : [{ ...EMPTY_LINE }],
        );
      })
      .catch((err) => {
        toastError(err, 'Could not load this item receipt.');
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

  // Load this vendor's receivable POs (open/partial) when the vendor changes.
  useEffect(() => {
    // Editing: keep the receipt's own PO link (changing the PO means void + re-enter).
    setPoId(pendingPoRef.current ?? '');
    if (vendorId) pendingPoRef.current = null; // only restore once, for the loaded vendor
    setVendorPos([]);
    if (!vendorId) return;
    let cancelled = false;
    api
      .get<PurchaseOrder[]>(`/api/purchase-orders?vendorId=${vendorId}`)
      .then((pos) => {
        if (cancelled) return;
        setVendorPos(pos.filter((p) => p.status === 'open' || p.status === 'partial'));
      })
      .catch(() => {
        /* PO list is optional — receipts work without a PO */
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  // When a PO is picked, prefill lines from its item lines' remaining quantities.
  async function handlePoChange(nextPoId: string) {
    setPoId(nextPoId);
    if (!nextPoId) {
      setLines([{ ...EMPTY_LINE }]);
      return;
    }
    setPoLoading(true);
    try {
      const detail = await api.get<PoDetail>(`/api/purchase-orders/${nextPoId}`);
      const prefilled = detail.lines
        .filter((l) => l.itemId && lineRemaining(l) > 0)
        .map((l) => ({
          itemId: l.itemId as string,
          description: l.description ?? '',
          quantity: String(lineRemaining(l)),
          unitCost: l.rate,
        }));
      if (prefilled.length === 0) {
        toast('This PO has no item quantities remaining to receive.', 'danger');
        setPoId('');
        setLines([{ ...EMPTY_LINE }]);
        return;
      }
      setLines(prefilled);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load purchase order.';
      toast(msg, 'danger');
      setPoId('');
    } finally {
      setPoLoading(false);
    }
  }

  function updateLineInv(idx: number, inv: InvDetail) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, inv } : l)));
  }

  function updateLine(idx: number, field: Exclude<keyof LineRow, 'inv'>, value: string) {
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
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  // Line-grid keys: Enter / Down next line (adds one at the end), Ctrl+Insert, Ctrl+D.
  const grid = useGridKeys({ addRow: addLine, removeRow: removeLine, disabled: saving });

  const liveTotal = computeTotal(lines);

  async function handleSubmit() {
    if (!vendorId) { toast('Please select a vendor.', 'danger'); return; }
    if (!date) { toast('Please enter a receipt date.', 'danger'); return; }
    const validLines = lines.filter((l) => l.itemId || l.quantity || l.unitCost || l.description);
    if (validLines.length === 0) { toast('Add at least one item line.', 'danger'); return; }
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      if (!l.itemId) { toast(`Line ${i + 1}: please select an item.`, 'danger'); return; }
      if (!l.quantity || parseFloat(l.quantity) <= 0) {
        toast(`Line ${i + 1}: quantity must be a positive number.`, 'danger'); return;
      }
      if (l.unitCost === '' || parseFloat(l.unitCost) < 0) {
        toast(`Line ${i + 1}: enter a unit cost (0 or more).`, 'danger'); return;
      }
      if ((parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0) <= 0) {
        toast(`Line ${i + 1}: line amount must be greater than zero.`, 'danger'); return;
      }
    }

    setSaving(true);
    try {
      const body = {
        vendorId,
        date,
        reference: reference || undefined,
        memo: memo || undefined,
        purchaseOrderId: poId || undefined,
        lines: validLines.map((l) => ({
          itemId: l.itemId,
          description: l.description || null,
          quantity: l.quantity,
          unitCost: l.unitCost,
          ...inventoryLinePayload(l.inv),
        })),
      };
      if (editId) {
        await api.patch(`/api/item-receipts/${editId}`, body);
        toast('Item receipt updated — stock adjusted to match.', 'success');
      } else {
        await api.post('/api/item-receipts', body);
        toast('Item receipt recorded — stock received.', 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      toastError(err, editId ? 'Failed to save changes.' : 'Failed to create item receipt.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editId ? 'Edit Item Receipt' : 'Receive Items'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {editId ? 'Cancel edit' : 'Cancel'}
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={poLoading || loadingEdit}>
            {editId ? 'Save Changes' : 'Receive Items'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editId && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You can change this receipt until its bill is entered. Saving replaces the received
            quantities and costs. To link it to a different purchase order, void it and receive the
            items again.
          </div>
        )}
        {loadingEdit && (
          <div className="flex items-center gap-2 text-sm text-navy/50">
            <Spinner className="h-4 w-4" /> Loading receipt...
          </div>
        )}
        <p className="text-sm text-navy/70">
          Record items that arrived <strong>before the vendor&apos;s bill</strong>. Stock is
          received immediately and the value sits in the Item Receipts Accrual (2050) until you
          convert the receipt to a bill.
        </p>

        {/* Vendor + PO */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ir-vendor">Vendor *</Label>
            <Select
              id="ir-vendor"
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
          <div>
            <Label htmlFor="ir-po">Purchase Order</Label>
            <Select
              id="ir-po"
              value={poId}
              disabled={Boolean(editId) || !vendorId || vendorPos.length === 0}
              onChange={(e) => handlePoChange(e.target.value)}
            >
              {editId && poId && !vendorPos.some((p) => p.id === poId) && (
                <option value={poId}>Linked purchase order</option>
              )}
              <option value="">
                {vendorId
                  ? vendorPos.length > 0
                    ? 'No PO — receive without one'
                    : 'No open POs for this vendor'
                  : 'Select a vendor first'}
              </option>
              {vendorPos.map((p) => (
                <option key={p.id} value={p.id}>
                  PO #{p.refNumber || p.poNumber} ({p.status === 'partial' ? 'partially received' : 'open'})
                </option>
              ))}
            </Select>
          </div>
        </div>

        {/* Date + reference */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="ir-date">Receipt Date *</Label>
            <Input id="ir-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ir-ref">Reference / Packing Slip</Label>
            <Input
              id="ir-ref"
              placeholder="e.g. PS-1042"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="mb-0">Items Received</Label>
            <div className="flex items-center gap-2">
              {!poId && <BarcodeScanInput onItem={addScannedItem} />}
              <Button type="button" variant="ghost" size="sm" onClick={addLine} disabled={poLoading}>
                <PlusCircle className="h-4 w-4" /> Add line
              </Button>
            </div>
          </div>

          {poLoading ? (
            <div className="rounded-lg border border-slate-200 py-8 flex items-center justify-center gap-2 text-sm text-navy/40">
              <Spinner className="h-4 w-4" /> Loading purchase order lines…
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 overflow-hidden" onKeyDown={grid.onKeyDown}>
              <div className="grid grid-cols-[1.3fr_1.2fr_80px_90px_90px_28px] gap-2 bg-slate-50 px-3 py-2 text-xs font-semibold text-navy/60 border-b border-slate-200">
                <span>Item</span>
                <span>Description</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Unit Cost</span>
                <span className="text-right">Amount</span>
                <span />
              </div>

              {lines.map((line, idx) => {
                const amount = (parseFloat(line.quantity) || 0) * (parseFloat(line.unitCost) || 0);
                return (
                  <div
                    key={idx}
                    data-grid-row
                    className="grid grid-cols-[1.3fr_1.2fr_80px_90px_90px_28px] gap-2 items-center px-3 py-2 border-b border-slate-100 last:border-b-0"
                  >
                    {poId ? (
                      <span className="truncate text-sm font-medium text-navy">
                        {itemMap[line.itemId] ?? 'Item'}
                      </span>
                    ) : (
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
                    )}
                    <Input
                      placeholder="Description"
                      value={line.description}
                      onChange={(e) => updateLine(idx, 'description', e.target.value)}
                    />
                    <Input
                      placeholder="1"
                      type="number"
                      min="0"
                      step="any"
                      className="text-right"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, 'quantity', e.target.value)}
                    />
                    <Input
                      placeholder="0.00"
                      type="number"
                      min="0"
                      step="any"
                      className="text-right"
                      value={line.unitCost}
                      onChange={(e) => updateLine(idx, 'unitCost', e.target.value)}
                    />
                    <span className="text-right text-sm tabular-nums text-navy/70">
                      {formatCurrency(amount.toFixed(2))}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      disabled={lines.length === 1}
                      className="text-navy/30 hover:text-red-500 disabled:opacity-20 transition-colors flex items-center justify-center"
                      aria-label="Remove line"
                    >
                      <MinusCircle className="h-4 w-4" />
                    </button>
                    <InventoryLineFields
                      className="col-span-full"
                      adv={adv}
                      item={itemById.get(line.itemId)}
                      quantity={line.quantity}
                      direction="in"
                      value={line.inv}
                      onChange={(inv) => updateLineInv(idx, inv)}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {poId && (
            <p className="mt-1 text-xs text-navy/50">
              Quantities are prefilled with each PO line&apos;s remaining amount — lower them for a
              partial receipt. Received quantities are locked on the PO so they can&apos;t be billed
              twice.
            </p>
          )}
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="ir-memo">Memo</Label>
          <Input
            id="ir-memo"
            placeholder="Internal notes…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        {/* Live total */}
        <div className="flex items-center justify-between rounded-lg bg-navy/5 px-4 py-3">
          <span className="text-sm font-semibold text-navy/70">Receipt Total</span>
          <span className="text-lg font-bold text-navy tabular-nums">
            {formatCurrency(liveTotal.toFixed(2))}
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Convert to Bill modal
// ---------------------------------------------------------------------------

interface ConvertModalProps {
  receipt: ItemReceipt | null;
  vendorName: string;
  onClose: () => void;
  onConverted: () => void;
}

function ConvertModal({ receipt, vendorName, onClose, onConverted }: ConvertModalProps) {
  const [billNumber, setBillNumber] = useState('');
  const [date, setDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [converting, setConverting] = useState(false);

  useEffect(() => {
    if (receipt) {
      setBillNumber(receipt.reference ?? '');
      setDate(receipt.date ? receipt.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
      setDueDate('');
    }
  }, [receipt]);

  async function handleConvert() {
    if (!receipt) return;
    setConverting(true);
    try {
      await api.post(`/api/item-receipts/${receipt.id}`, {
        action: 'convert',
        billNumber: billNumber || undefined,
        date: date || undefined,
        dueDate: dueDate || undefined,
      });
      toast('Bill created — accrual moved to Accounts Payable.', 'success');
      onConverted();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to convert receipt to a bill.';
      toast(msg, 'danger');
    } finally {
      setConverting(false);
    }
  }

  return (
    <Modal
      open={!!receipt}
      onClose={onClose}
      title="Convert to Bill"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={converting}>
            Cancel
          </Button>
          <Button onClick={handleConvert} loading={converting}>
            Create Bill
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-navy/70">
          Enter the vendor&apos;s bill for this receipt from <strong>{vendorName}</strong> (
          {formatCurrency(receipt?.total ?? '0')}). The bill moves the received value out of the
          Item Receipts Accrual and into Accounts Payable — inventory is untouched (it was received
          with the items).
        </p>
        <div>
          <Label htmlFor="cv-number">Bill Number</Label>
          <Input
            id="cv-number"
            placeholder="Vendor invoice #"
            value={billNumber}
            onChange={(e) => setBillNumber(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="cv-date">Bill Date</Label>
            <Input id="cv-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="cv-due">Due Date</Label>
            <Input
              id="cv-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ItemReceiptsPage() {
  const [receipts, setReceipts] = useState<ItemReceipt[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [convertTarget, setConvertTarget] = useState<ItemReceipt | null>(null);
  const [voidTarget, setVoidTarget] = useState<ItemReceipt | null>(null);
  const [voiding, setVoiding] = useState(false);

  const vendorMap = Object.fromEntries(vendors.map((v) => [v.id, v.displayName]));
  const poNumberMap = Object.fromEntries(pos.map((p) => [p.id, p.refNumber || String(p.poNumber)]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [receiptList, vendorList, itemRes, poList] = await Promise.all([
        api.get<ItemReceipt[]>('/api/item-receipts'),
        api.get<Vendor[]>('/api/vendors'),
        api.get<{ items: Item[] }>('/api/items'),
        api.get<PurchaseOrder[]>('/api/purchase-orders'),
      ]);
      setReceipts(receiptList);
      setVendors(vendorList);
      setItems(itemRes.items ?? []);
      setPos(poList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load item receipts.';
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
      await api.post(`/api/item-receipts/${voidTarget.id}`, { action: 'void' });
      toast('Item receipt voided — stock and accrual reversed.', 'success');
      setVoidTarget(null);
      await fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void item receipt.';
      toast(msg, 'danger');
    } finally {
      setVoiding(false);
    }
  }

  const openCount = receipts.filter((r) => r.status === 'open').length;
  const openValue = receipts
    .filter((r) => r.status === 'open')
    .reduce((s, r) => s + Number(r.total), 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Item Receipts"
        icon={PackageCheck}
        action={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => window.location.assign('/receive-bill')} title="Bill received items with quantity / price variances">
              <ArrowRight className="h-4 w-4" /> Enter Bill for Received Items
            </Button>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" /> Receive Items
            </Button>
          </div>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading item receipts…
          </div>
        ) : receipts.length === 0 ? (
          <EmptyState
            icon={PackageCheck}
            title="No item receipts yet"
            message="Receive items that arrive before the vendor's bill. Stock comes in immediately; convert the receipt to a bill when the invoice shows up."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> Receive Items
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Reference</Th>
                <Th>Vendor</Th>
                <Th>Date</Th>
                <Th>PO</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-semibold text-navy">
                    {r.reference ?? r.id.slice(0, 8)}
                  </Td>
                  <Td>{vendorMap[r.vendorId] ?? '—'}</Td>
                  <Td className="text-navy/70">
                    {r.date ? formatDate(r.date, 'MMM d, yyyy') : '—'}
                  </Td>
                  <Td className="text-navy/70">
                    {r.purchaseOrderId
                      ? `#${poNumberMap[r.purchaseOrderId] ?? '…'}`
                      : '—'}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(r.total)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {r.status === 'open' && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditId(r.id);
                              setShowNew(true);
                            }}
                            title="Edit this receipt (until its bill is entered)"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConvertTarget(r)}
                            title="Enter the vendor's bill for this receipt"
                          >
                            <ArrowRight className="h-3.5 w-3.5" /> Convert to Bill
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                            onClick={() => setVoidTarget(r)}
                            title="Void the receipt — reverses stock and accrual"
                          >
                            <Ban className="h-3.5 w-3.5" /> Void
                          </Button>
                        </>
                      )}
                      {r.status === 'billed' && (
                        <span className="text-xs text-navy/30 italic">Bill created</span>
                      )}
                      {r.status === 'partial' && (
                        <Button variant="ghost" size="sm" onClick={() => window.location.assign('/receive-bill')} title="Bill the rest of this receipt">
                          <ArrowRight className="h-3.5 w-3.5" /> Bill the rest
                        </Button>
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
      {receipts.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {receipts.length} receipt{receipts.length !== 1 ? 's' : ''}
          </span>
          <span>
            Awaiting bill: <span className="font-semibold text-navy/70">{openCount}</span>
          </span>
          <span>
            Accrued value:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(openValue.toFixed(2))}
            </span>
          </span>
        </div>
      )}

      <NewReceiptModal
        open={showNew}
        onClose={() => {
          setShowNew(false);
          setEditId(null);
        }}
        vendors={vendors}
        items={items}
        onCreated={fetchData}
        editId={editId}
      />

      <ConvertModal
        receipt={convertTarget}
        vendorName={convertTarget ? vendorMap[convertTarget.vendorId] ?? 'this vendor' : ''}
        onClose={() => setConvertTarget(null)}
        onConverted={fetchData}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void item receipt?"
        message={`Void receipt ${voidTarget?.reference ?? ''} (${formatCurrency(voidTarget?.total ?? '0')})? The received stock and the accrual posting are reversed${voidTarget?.purchaseOrderId ? ', and the PO quantities reopen' : ''}. Blocked if the stock has already been consumed.`}
        confirmLabel="Void"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}
