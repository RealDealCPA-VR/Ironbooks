'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { FileCheck, Plus, ArrowRight, Printer, PackageCheck, Pencil } from 'lucide-react';
import Link from 'next/link';
import {
  Button,
  Card,
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
} from '@/components/ui';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { recallNote, useSmartDefaults } from '@/lib/useSmartDefaults';
import { salesRowsFromRecall } from '@/lib/smartDefaults';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { previewSalesTotals } from '@/lib/salesLineMath';
import {
  PricedLinesEditor,
  emptyPricedLine,
  type PricedLineItem,
  type PricedLineValue,
} from '@/components/PricedLinesEditor';
import {
  EMPTY_SHIPPING,
  FormSendButtons,
  ShippingSection,
  type ShippingState,
  shippingFromDoc,
  shippingPayload,
  useCreditLimitConfirm,
  useCustomerSalesDefaults,
  defaultShipToState,
} from '@/components/sales/SalesExtras';
import {
  DocNumberField,
  docNo,
  useDocNumber,
  useDuplicateNumberConfirm,
} from '@/components/sales/DocNumberField';
import { TransactionNav, useAdjacentTransactions } from '@/components/TransactionNav';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
}

interface SalesOrder {
  id: string;
  orderNumber: number;
  /** The number the user typed / sees (e.g. "SO-1001"). */
  refNumber?: string | null;
  customerId: string;
  date: string;
  total: string;
  taxRateId?: string | null;
  taxAmount?: string;
  status: string;
  convertedInvoiceId: string | null;
  memo?: string | null;
  shipDate?: string | null;
  shipVia?: string | null;
  fob?: string | null;
  trackingNumber?: string | null;
  poNumber?: string | null;
  shipTo?: Record<string, string> | null;
  toBePrinted?: boolean;
  toBeEmailed?: boolean;
}

interface SalesOrderLine {
  id: string;
  itemId?: string | null;
  description: string | null;
  quantity: string;
  rate: string;
  amount: string;
  quantityInvoiced: string;
  taxable?: boolean;
}

interface TaxRate {
  id: string;
  name: string;
  rate: string;
}

interface SalesOrderDetail extends SalesOrder {
  lines: SalesOrderLine[];
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StatusTone = 'info' | 'success' | 'neutral' | 'warning';

function statusTone(status: string): StatusTone {
  if (status === 'open') return 'info';
  if (status === 'partial') return 'warning';
  if (status === 'closed') return 'success';
  if (status === 'void') return 'neutral';
  return 'warning';
}

function statusLabel(status: string): string {
  if (status === 'open') return 'Open';
  if (status === 'partial') return 'Partially Invoiced';
  if (status === 'closed') return 'Invoiced';
  if (status === 'void') return 'Void';
  return status;
}

/** Same item-type math as the service: discount items subtract, subtotal items add nothing. */
function computeTotal(lines: PricedLineValue[], items: PricedLineItem[], taxRate = 0): number {
  const t = previewSalesTotals(
    lines.map((l) => ({ ...l, itemType: items.find((i) => i.id === l.itemId)?.type ?? null })),
    taxRate,
  );
  return t.subtotal + Math.round(t.tax * 100) / 100;
}

// ---------------------------------------------------------------------------
// New Sales Order Modal
// ---------------------------------------------------------------------------

interface NewOrderModalProps {
  open: boolean;
  /** wave2 sales (C1): the order being edited (null = new). */
  editing?: SalesOrderDetail | null;
  /** QB's Previous / Next / Revert / Journal toolbar (components/TransactionNav.tsx). */
  nav?: React.ReactNode;
  onClose: () => void;
  customers: Customer[];
  items: PricedLineItem[];
  taxRates: TaxRate[];
  onCreated: () => void;
}

type EditableLine = PricedLineValue & { id?: string; invoiced?: number };

function NewOrderModal({ open, editing, onClose, customers, items, taxRates, onCreated, nav = null }: NewOrderModalProps) {
  const [customerId, setCustomerId] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const docNumber = useDocNumber('sales_order', open, editing ? docNo(editing.refNumber, editing.orderNumber) : null);
  const dupConfirm = useDuplicateNumberConfirm();
  // Customer defaults (new orders): tax item, non-taxable tax code, default ship-to.
  const custDefaults = useCustomerSalesDefaults(open ? customerId : null);
  /** Tax item recalled from the last order — wins over the customer's default tax item. */
  const recalledTaxRef = useRef<string | null>(null);
  useEffect(() => {
    if (!custDefaults || editing) return;
    setTaxRateId(custDefaults.taxable ? (recalledTaxRef.current ?? custDefaults.taxRateId ?? '') : '');
    const st = defaultShipToState(custDefaults);
    if (st) setShip((prev) => ({ ...prev, shipTo: st }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custDefaults]);
  const [date, setDate] = useState(() => todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<EditableLine[]>([emptyPricedLine()]);
  const [ship, setShip] = useState<ShippingState>(EMPTY_SHIPPING);
  const [saving, setSaving] = useState(false);
  // Smart defaults (lib/useSmartDefaults.ts): default date + recall the customer's last order.
  const smart = useSmartDefaults('sales_order');
  const [recallText, setRecallText] = useState('');

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCustomerId(editing.customerId);
      setDate(editing.date.slice(0, 10));
      setMemo(editing.memo ?? '');
      setShip(shippingFromDoc(editing));
      setTaxRateId(editing.taxRateId ?? '');
      setLines(
        editing.lines.map((l) => ({
          id: l.id,
          invoiced: Number(l.quantityInvoiced ?? 0),
          itemId: l.itemId ?? '',
          description: l.description ?? '',
          quantity: String(Number(l.quantity)),
          rate: String(Number(l.rate)),
          taxable: l.taxable !== false,
          rateManual: true,
        })),
      );
    } else {
      setCustomerId('');
      // My Preferences > General "Default date": today, or the last order date entered this session.
      setDate(smart.defaultDate());
      setMemo('');
      setShip(shippingFromDoc(null));
      setTaxRateId('');
      setLines([emptyPricedLine()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // QB "Recall the last transaction for a name" (My Preferences > General): a NEW order for this
  // customer starts from their last one — items, rates, tax item and memo. Typed lines are kept.
  const { recall } = smart;
  useEffect(() => {
    setRecallText('');
    recalledTaxRef.current = null;
    if (!open || editing || !customerId) return;
    let live = true;
    void recall(customerId).then((d) => {
      if (!live || !d) return;
      if (d.header.taxRateId) {
        recalledTaxRef.current = d.header.taxRateId;
        setTaxRateId(d.header.taxRateId);
      }
      const m = d.header.memo;
      if (m) setMemo((prev) => prev || m);
      if (d.lines.length > 0) {
        setLines((prev) =>
          prev.every((l) => !l.itemId && !l.description && !l.rate)
            ? salesRowsFromRecall(d.lines)
            : prev,
        );
      }
      setRecallText(recallNote(d));
    });
    return () => {
      live = false;
    };
  }, [open, editing, customerId, recall]);

  const selectedRate = taxRates.find((t) => t.id === taxRateId);
  const liveTotal = computeTotal(lines, items, selectedRate ? parseFloat(selectedRate.rate) || 0 : 0);

  async function handleSubmit() {
    if (!customerId) { toast('Please select a customer.', 'danger'); return; }
    if (!date) { toast('Please enter an order date.', 'danger'); return; }
    const validLines = lines.filter((l) => l.itemId || l.description || l.rate);
    if (validLines.length === 0) { toast('Add at least one line item.', 'danger'); return; }
    for (let i = 0; i < validLines.length; i++) {
      const l = validLines[i];
      if (!l.quantity || parseFloat(l.quantity) <= 0) {
        toast(`Line ${i + 1}: quantity must be a positive number.`, 'danger'); return;
      }
      if ((l.rate === '' && !l.itemId) || parseFloat(l.rate) < 0) {
        toast(`Line ${i + 1}: enter a rate (it cannot be negative).`, 'danger'); return;
      }
    }

    setSaving(true);
    try {
      const body = {
        customerId,
        refNumber: docNumber.payload,
        date,
        memo: memo || undefined,
        taxRateId: taxRateId || null,
        ...shippingPayload(ship),
        lines: validLines.map((l) => ({
          ...(l.id ? { id: l.id } : {}),
          itemId: l.itemId || null,
          description: l.description || null,
          quantity: l.quantity,
          // Blank rate on an item line: the server prices it (advanced pricing).
          rate: l.rate === '' ? null : l.rate,
          taxable: l.taxable !== false,
        })),
      };
      const saved = await dupConfirm.run((allowDuplicateNumber) =>
        editing
          ? api.patch<SalesOrder>(`/api/sales-orders/${editing.id}`, { ...body, allowDuplicateNumber })
          : api.post<SalesOrder>('/api/sales-orders', { ...body, allowDuplicateNumber }),
      );
      if (saved === undefined) return;
      if (!editing) smart.rememberDate(date);
      if (editing) {
        toast(`Sales Order #${docNo(saved.refNumber, saved.orderNumber)} updated.`, 'success');
      } else {
        toast(`Sales Order #${docNo(saved.refNumber, saved.orderNumber)} created.`, 'success');
      }
      onCreated();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create sales order.';
      toast(msg, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit Sales Order #${docNo(editing.refNumber, editing.orderNumber)}` : 'New Sales Order'}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : 'Create Sales Order'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {nav}
        {/* Customer */}
        <div>
          <Label htmlFor="so-customer">Customer *</Label>
          <Select
            id="so-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            autoFocus
          >
            <option value="">Select a customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
          {recallText && <p className="mt-1 text-xs text-electric" role="status">{recallText}</p>}
        </div>

        {/* S.O. No. + Date */}
        <div className="grid grid-cols-2 gap-3">
          <DocNumberField id="so-number" label="S.O. No." value={docNumber.value} onChange={docNumber.setValue} />
          <div>
            <Label htmlFor="so-date">Order Date *</Label>
            <Input
              id="so-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>

        {/* Sales tax (QB: Tax item; carried to the invoice) */}
        <div>
          <Label htmlFor="so-taxrate">Sales Tax</Label>
          <Select id="so-taxrate" value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
            <option value="">No tax</option>
            {taxRates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
              </option>
            ))}
          </Select>
        </div>

        {/* Memo */}
        <div>
          <Label htmlFor="so-memo">Memo</Label>
          <Input
            id="so-memo"
            placeholder="Optional note…"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        <ShippingSection value={ship} onChange={setShip} shipTos={custDefaults?.shipTos} idPrefix="so-ship" />
        {dupConfirm.dialog}

        {/* Line items (item pick -> server-side pricing) */}
        <div>
          <Label className="mb-2">Line Items</Label>
          {editing && editing.status === 'partial' && (
            <p className="mb-2 text-xs text-amber-700">
              Some lines are already invoiced. Keep those lines, and don&apos;t lower their quantity below what
              has been invoiced.
            </p>
          )}
          <PricedLinesEditor
            items={items}
            lines={lines}
            onChange={setLines}
            header={{ customerId: customerId || null, date }}
            showTaxable
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
// Invoice modal — per-line quantities with backorder tracking
// ---------------------------------------------------------------------------

interface InvoiceModalProps {
  open: boolean;
  order: SalesOrder | null;
  onClose: () => void;
  onInvoiced: () => void;
}

/** ordered - invoiced, never below 0 (display-side decimal-safe enough at 4dp). */
function remainingOf(line: SalesOrderLine): number {
  const rem = (parseFloat(line.quantity) || 0) - (parseFloat(line.quantityInvoiced) || 0);
  return Math.max(0, Math.round(rem * 10000) / 10000);
}

function fmtQty(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

function InvoiceModal({ open, order, onClose, onInvoiced }: InvoiceModalProps) {
  const [detail, setDetail] = useState<SalesOrderDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [qtyNow, setQtyNow] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const creditLimit = useCreditLimitConfirm();

  useEffect(() => {
    if (!open || !order) {
      setDetail(null);
      setQtyNow({});
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    api
      .get<SalesOrderDetail>(`/api/sales-orders/${order.id}`)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        // Default: invoice the full remaining quantity of every line.
        setQtyNow(
          Object.fromEntries(d.lines.map((l) => [l.id, fmtQty(remainingOf(l))])),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          toast(err instanceof Error ? err.message : 'Failed to load sales order.', 'danger');
          onClose();
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order?.id]);

  const lines = detail?.lines ?? [];
  const invoiceNowTotal = lines.reduce(
    (sum, l) => sum + (parseFloat(qtyNow[l.id]) || 0) * (parseFloat(l.rate) || 0),
    0,
  );
  const anyQty = lines.some((l) => (parseFloat(qtyNow[l.id]) || 0) > 0);

  async function handleSubmit() {
    if (!order || !detail) return;

    const plan: Array<{ lineId: string; quantity: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const qty = parseFloat(qtyNow[l.id]) || 0;
      if (qty < 0) {
        toast(`Line ${i + 1}: quantity cannot be negative.`, 'danger');
        return;
      }
      const remaining = remainingOf(l);
      if (qty > remaining) {
        toast(`Line ${i + 1}: only ${fmtQty(remaining)} remaining (backordered).`, 'danger');
        return;
      }
      if (qty > 0) plan.push({ lineId: l.id, quantity: qtyNow[l.id] });
    }
    if (plan.length === 0) {
      toast('Enter a quantity to invoice on at least one line.', 'danger');
      return;
    }

    setSaving(true);
    try {
      const done = await creditLimit.run((override) =>
        api.post(`/api/sales-orders/${order.id}`, { action: 'convert', lines: plan, overrideCreditLimit: override }),
      );
      if (done === undefined) return;
      const fully = lines.every(
        (l) => (parseFloat(qtyNow[l.id]) || 0) >= remainingOf(l),
      );
      toast(
        fully
          ? `Sales Order #${docNo(order.refNumber, order.orderNumber)} fully invoiced.`
          : `Sales Order #${docNo(order.refNumber, order.orderNumber)} partially invoiced — remainder on backorder.`,
        'success',
      );
      onInvoiced();
      onClose();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Failed to create invoice.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Create Invoice — Sales Order #${docNo(order?.refNumber, order?.orderNumber ?? '')}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} loading={saving} disabled={loadingDetail || !anyQty}>
            <ArrowRight className="h-4 w-4" /> Create Invoice
          </Button>
        </>
      }
    >
      {loadingDetail ? (
        <div className="flex items-center justify-center py-12 text-navy/40">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Set the quantity to invoice now for each line. Anything left over stays on the
            sales order as a <strong>backorder</strong> and can be invoiced later.
          </p>

          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <Table>
              <thead>
                <Tr>
                  <Th>Description</Th>
                  <Th numeric>Ordered</Th>
                  <Th numeric>Invoiced</Th>
                  <Th numeric>Invoice Now</Th>
                  <Th numeric>Backordered</Th>
                </Tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const remaining = remainingOf(l);
                  const now = parseFloat(qtyNow[l.id]) || 0;
                  const backordered = Math.max(0, Math.round((remaining - now) * 10000) / 10000);
                  return (
                    <Tr key={l.id}>
                      <Td className="text-navy">{l.description || '—'}</Td>
                      <Td numeric>{fmtQty(parseFloat(l.quantity) || 0)}</Td>
                      <Td numeric className="text-navy/60">
                        {fmtQty(parseFloat(l.quantityInvoiced) || 0)}
                      </Td>
                      <Td numeric>
                        <Input
                          type="number"
                          min="0"
                          max={remaining}
                          step="any"
                          value={qtyNow[l.id] ?? ''}
                          disabled={remaining <= 0}
                          onChange={(e) =>
                            setQtyNow((prev) => ({ ...prev, [l.id]: e.target.value }))
                          }
                          className="w-24 text-right ml-auto"
                          aria-label={`Quantity to invoice for ${l.description || 'line'}`}
                        />
                      </Td>
                      <Td numeric className={backordered > 0 ? 'text-amber-600 font-semibold' : 'text-navy/40'}>
                        {fmtQty(backordered)}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-navy/5 px-4 py-3">
            <span className="text-sm font-semibold text-navy/70">Invoice Total (before tax)</span>
            <span className="text-lg font-bold text-navy tabular-nums">
              {formatCurrency(invoiceNowTotal.toFixed(2))}
            </span>
          </div>
        </div>
      )}
      {creditLimit.dialog}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SalesOrdersPage() {
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<PricedLineItem[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  // Invoice (convert) state
  const [invoiceTarget, setInvoiceTarget] = useState<SalesOrder | null>(null);
  // Edit state (wave2 sales C1)
  const [editTarget, setEditTarget] = useState<SalesOrderDetail | null>(null);
  /** Remounts the form: Revert / Clear, and moving to another sales order (Previous / Next). */
  const [formKey, setFormKey] = useState(0);

  async function openEdit(order: SalesOrder) {
    try {
      setEditTarget(await api.get<SalesOrderDetail>(`/api/sales-orders/${order.id}`));
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Could not open the sales order.', 'danger');
    }
  }

  const nav = useAdjacentTransactions(orders, editTarget?.id ?? null, (o) => o.date, (o) => o.orderNumber);
  async function goTo(o: SalesOrder) {
    await openEdit(o);
    setShowNew(false);
    setFormKey((k) => k + 1);
  }

  const customerMap = Object.fromEntries(customers.map((c) => [c.id, c.displayName]));

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [orderList, custList] = await Promise.all([
        api.get<SalesOrder[]>('/api/sales-orders'),
        api.get<Customer[]>('/api/customers'),
      ]);
      setOrders(orderList);
      setCustomers(custList);
      api
        .get<{ items: PricedLineItem[] }>('/api/items')
        .then((r) => setItems(r.items ?? []))
        .catch(() => {
          // Non-fatal; lines can still be typed without an item.
        });
      api
        .get<TaxRate[]>('/api/tax-rates')
        .then((r) => setTaxRates(Array.isArray(r) ? r : []))
        .catch(() => {
          // Non-fatal; the tax picker just stays empty.
        });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load sales orders.';
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Sales Orders"
        icon={FileCheck}
        action={
          <div className="flex items-center gap-2">
            <Link href="/so-fulfillment">
              <Button variant="secondary">
                <PackageCheck className="h-4 w-4" /> Fulfillment Worksheet
              </Button>
            </Link>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="h-4 w-4" /> New Sales Order
            </Button>
          </div>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={FileCheck}
            title="No sales orders yet"
            message="Create your first sales order to get started."
            action={
              <Button onClick={() => setShowNew(true)}>
                <Plus className="h-4 w-4" /> New Sales Order
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Order #</Th>
                <Th>Customer</Th>
                <Th>Date</Th>
                <Th numeric>Total</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <Tr key={order.id}>
                  <Td className="font-semibold text-navy">#{docNo(order.refNumber, order.orderNumber)}</Td>
                  <Td>{customerMap[order.customerId] ?? '—'}</Td>
                  <Td className="text-navy/70">{formatDate(order.date)}</Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(order.total)}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(order.status)}>{statusLabel(order.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <FormSendButtons kind="sales_order" id={order.id} />
                      {(order.status === 'open' || order.status === 'partial') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Edit sales order"
                          aria-label="Edit sales order"
                          onClick={() => openEdit(order)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {(order.status === 'open' || order.status === 'partial') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setInvoiceTarget(order)}
                          title={
                            order.status === 'partial'
                              ? 'Invoice the backordered quantity'
                              : 'Create an invoice (full or partial)'
                          }
                        >
                          <ArrowRight className="h-3.5 w-3.5" />
                          {order.status === 'partial' ? 'Invoice Backorder' : 'Invoice'}
                        </Button>
                      )}
                      {order.convertedInvoiceId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            window.open(
                              `/api/invoices/${order.convertedInvoiceId}/packing-slip`,
                              '_blank',
                            )
                          }
                          title="Print packing slip (no prices) for the linked invoice"
                        >
                          <Printer className="h-3.5 w-3.5" /> Packing Slip
                        </Button>
                      )}
                      {order.status === 'closed' && !order.convertedInvoiceId && (
                        <span className="text-xs text-navy/30 italic">Closed</span>
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
      {orders.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {orders.length} order{orders.length !== 1 ? 's' : ''}
          </span>
          <span>
            Open:{' '}
            <span className="font-semibold text-navy/70">
              {orders.filter((o) => o.status === 'open').length}
            </span>
          </span>
          <span>
            Partially invoiced:{' '}
            <span className="font-semibold text-amber-600">
              {orders.filter((o) => o.status === 'partial').length}
            </span>
          </span>
          <span>
            Open total:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(
                orders
                  .filter((o) => o.status === 'open' || o.status === 'partial')
                  .reduce((s, o) => s + Number(o.total), 0)
                  .toFixed(2),
              )}
            </span>
          </span>
        </div>
      )}

      <NewOrderModal
        key={formKey}
        nav={
          <TransactionNav
            sourceRef={null}
            onPrevious={nav.prev ? () => void goTo(nav.prev!) : null}
            onNext={nav.next ? () => void goTo(nav.next!) : null}
            onRevert={() => setFormKey((k) => k + 1)}
            loadKey={`${formKey}:${editTarget?.id ?? 'new'}`}
          />
        }
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

      <InvoiceModal
        open={!!invoiceTarget}
        order={invoiceTarget}
        onClose={() => setInvoiceTarget(null)}
        onInvoiced={fetchData}
      />
    </main>
  );
}
