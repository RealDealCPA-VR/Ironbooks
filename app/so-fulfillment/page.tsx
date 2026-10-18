'use client';

/**
 * Sales Order Fulfillment Worksheet (QB Enterprise parity): every open sales order with what
 * can ship now (stock is allocated first-come-first-served after pending builds), filters,
 * per-line quantities to ship, pick lists / packing slips, and batch invoicing.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, PackageCheck, Printer, RefreshCw, ClipboardList } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';

type ShipStatus = 'complete' | 'partial' | 'none';

interface WorksheetLine {
  lineId: string;
  itemId: string | null;
  itemName: string | null;
  sku: string | null;
  description: string | null;
  tracksStock: boolean;
  rate: string;
  quantityOrdered: string;
  quantityInvoiced: string;
  quantityRemaining: string;
  quantityOnHand: string | null;
  quantityAvailable: string | null;
  quantityAllocatedBefore: string | null;
  canShip: string;
  shipStatus: ShipStatus;
}
interface WorksheetOrder {
  salesOrderId: string;
  orderNumber: number;
  refNumber?: string | null;
  date: string;
  status: string;
  customerId: string;
  customerName: string;
  openAmount: string;
  shippableAmount: string;
  shipStatus: ShipStatus;
  lines: WorksheetLine[];
}
interface WorksheetItem {
  itemId: string;
  name: string;
  onHand: string;
  committedToOrders: string;
  committedToBuilds: string;
  available: string;
}
interface Worksheet {
  orders: WorksheetOrder[];
  items: WorksheetItem[];
  totals: { orders: number; complete: number; partial: number; none: number; shippableAmount: string };
}
interface BatchResult {
  salesOrderId: string;
  orderNumber: number;
  refNumber?: string | null;
  customerName: string;
  ok: boolean;
  invoiceNumber?: number;
  invoiceRef?: string;
  total?: string;
  error?: string;
}

const SHIP_BADGE: Record<ShipStatus, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  complete: { label: 'Can ship complete', tone: 'success' },
  partial: { label: 'Can ship partial', tone: 'warning' },
  none: { label: 'Cannot ship', tone: 'danger' },
};

/** Quantity without trailing zeros ("6.0000" -> "6"). */
function q(v: string | null | undefined): string {
  if (v == null) return '—';
  return String(Math.round(Number(v) * 10000) / 10000);
}

export default function SoFulfillmentPage() {
  const [ws, setWs] = useState<Worksheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<Array<{ id: string; displayName: string }>>([]);
  const [items, setItems] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [filters, setFilters] = useState({ customerId: '', itemId: '', from: '', to: '', shipStatus: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** lineId -> quantity to ship (string as typed). Defaults to "can ship". */
  const [shipQty, setShipQty] = useState<Record<string, string>>({});
  const [invoiceDate, setInvoiceDate] = useState(() => todayISO());
  const [invoicing, setInvoicing] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [showItems, setShowItems] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>);
      const data = await api.get<Worksheet>(`/api/fulfillment?${qs.toString()}`);
      setWs(data);
      setShipQty(Object.fromEntries(data.orders.flatMap((o) => o.lines.map((l) => [l.lineId, q(l.canShip)]))));
      setSelected((prev) => new Set([...prev].filter((id) => data.orders.some((o) => o.salesOrderId === id))));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load the worksheet.', 'danger');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<Array<{ id: string; displayName: string }>>('/api/customers').then(setCustomers).catch(() => {});
    api
      .get<{ items: Array<{ id: string; name: string; type: string }> }>('/api/items')
      .then((r) => setItems(r.items ?? []))
      .catch(() => {});
  }, []);

  const orders = ws?.orders ?? [];
  const allSelected = orders.length > 0 && orders.every((o) => selected.has(o.salesOrderId));

  /** Build the selection payload: explicit quantities only where the user changed them. */
  const selections = useMemo(() => {
    return orders
      .filter((o) => selected.has(o.salesOrderId))
      .map((o) => {
        const edited = o.lines.some((l) => (shipQty[l.lineId] ?? q(l.canShip)) !== q(l.canShip));
        if (!edited) return { salesOrderId: o.salesOrderId };
        return {
          salesOrderId: o.salesOrderId,
          lines: o.lines
            .map((l) => ({ lineId: l.lineId, quantity: shipQty[l.lineId] || '0' }))
            .filter((l) => Number(l.quantity) > 0),
        };
      });
  }, [orders, selected, shipQty]);

  const selectedShipValue = useMemo(
    () =>
      orders
        .filter((o) => selected.has(o.salesOrderId))
        .reduce(
          (sum, o) => sum + o.lines.reduce((s, l) => s + (Number(shipQty[l.lineId]) || 0) * Number(l.rate), 0),
          0,
        ),
    [orders, selected, shipQty],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function validSelection(): boolean {
    if (selections.length === 0) {
      toast('Select at least one sales order.', 'danger');
      return false;
    }
    for (const o of orders.filter((x) => selected.has(x.salesOrderId))) {
      for (const l of o.lines) {
        const v = Number(shipQty[l.lineId] || 0);
        if (!Number.isFinite(v) || v < 0) {
          toast(`SO #${o.refNumber || o.orderNumber}: enter a valid quantity.`, 'danger');
          return false;
        }
        if (v > Number(l.quantityRemaining)) {
          toast(`SO #${o.refNumber || o.orderNumber}: only ${q(l.quantityRemaining)} of ${l.itemName ?? l.description ?? 'a line'} remain.`, 'danger');
          return false;
        }
      }
    }
    return true;
  }

  function print(kind: 'pick-list' | 'packing-slips') {
    if (!validSelection()) return;
    window.open(`/api/fulfillment/${kind}?s=${encodeURIComponent(JSON.stringify(selections))}`, '_blank');
  }

  async function createInvoices() {
    if (!validSelection()) return;
    setInvoicing(true);
    try {
      const res = await api.post<{ results: BatchResult[]; invoiced: number; failed: number }>('/api/fulfillment', {
        date: invoiceDate,
        selections,
      });
      setResults(res.results);
      toast(
        res.failed === 0 ? `Created ${res.invoiced} invoice${res.invoiced === 1 ? '' : 's'}.` : `Created ${res.invoiced}; ${res.failed} not invoiced.`,
        res.failed === 0 ? 'success' : 'info',
      );
      setSelected(new Set());
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Batch invoicing failed.', 'danger');
    } finally {
      setInvoicing(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Sales Order Fulfillment"
        icon={PackageCheck}
        action={
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        }
      />

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <div>
            <Label htmlFor="f-cust">Customer</Label>
            <Select id="f-cust" value={filters.customerId} onChange={(e) => setFilters({ ...filters, customerId: e.target.value })}>
              <option value="">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="f-item">Item</Label>
            <Select id="f-item" value={filters.itemId} onChange={(e) => setFilters({ ...filters, itemId: e.target.value })}>
              <option value="">All items</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="f-from">Order date from</Label>
            <Input id="f-from" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="f-to">to</Label>
            <Input id="f-to" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="f-ship">Can ship</Label>
            <Select id="f-ship" value={filters.shipStatus} onChange={(e) => setFilters({ ...filters, shipStatus: e.target.value })}>
              <option value="">Any</option>
              <option value="complete">Complete</option>
              <option value="partial">Partial</option>
              <option value="none">None</option>
            </Select>
          </div>
        </div>
        <p className="mt-2 text-xs text-navy/50">
          Stock goes to the oldest orders first, after components reserved for pending builds. Filters never change what an order can ship.
        </p>
      </Card>

      {ws && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-navy/60">
          <span>{ws.totals.orders} open order{ws.totals.orders === 1 ? '' : 's'}</span>
          <Badge tone="success">{ws.totals.complete} complete</Badge>
          <Badge tone="warning">{ws.totals.partial} partial</Badge>
          <Badge tone="danger">{ws.totals.none} cannot ship</Badge>
          <span>Shippable now: <strong className="text-navy">{formatCurrency(ws.totals.shippableAmount)}</strong></span>
          <button type="button" className="ml-auto text-electric hover:underline text-sm" onClick={() => setShowItems((v) => !v)}>
            {showItems ? 'Hide' : 'Show'} item availability
          </button>
        </div>
      )}

      {showItems && ws && (
        <Card className="p-0 mb-4 overflow-hidden">
          <Table>
            <thead>
              <Tr>
                <Th>Item</Th>
                <Th numeric>On hand</Th>
                <Th numeric>On sales orders</Th>
                <Th numeric>For pending builds</Th>
                <Th numeric>Available</Th>
              </Tr>
            </thead>
            <tbody>
              {ws.items.map((i) => (
                <Tr key={i.itemId}>
                  <Td>{i.name}</Td>
                  <Td numeric>{q(i.onHand)}</Td>
                  <Td numeric>{q(i.committedToOrders)}</Td>
                  <Td numeric>{q(i.committedToBuilds)}</Td>
                  <Td numeric className={Number(i.available) < 0 ? 'text-red-600 font-semibold' : ''}>{q(i.available)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : orders.length === 0 ? (
          <EmptyState icon={PackageCheck} title="Nothing to fulfill" message="There are no open sales orders matching these filters." />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th className="w-10">
                  <input
                    type="checkbox"
                    className="accent-electric"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(orders.map((o) => o.salesOrderId)))}
                    aria-label="Select all orders"
                  />
                </Th>
                <Th>Order</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Ship status</Th>
                <Th numeric>Open amount</Th>
                <Th numeric>Can ship now</Th>
              </Tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const open = expanded.has(o.salesOrderId);
                return (
                  <Fragment key={o.salesOrderId}>
                    <Tr>
                      <Td>
                        <input
                          type="checkbox"
                          className="accent-electric"
                          checked={selected.has(o.salesOrderId)}
                          onChange={() => toggle(o.salesOrderId)}
                          aria-label={`Select sales order ${o.refNumber || o.orderNumber}`}
                        />
                      </Td>
                      <Td>
                        <button type="button" className="inline-flex items-center gap-1 font-semibold text-navy" onClick={() => toggleExpand(o.salesOrderId)}>
                          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}#{o.refNumber || o.orderNumber}
                        </button>
                      </Td>
                      <Td className="text-navy/70">{formatDate(o.date)}</Td>
                      <Td>{o.customerName}</Td>
                      <Td>
                        <Badge tone={SHIP_BADGE[o.shipStatus].tone}>{SHIP_BADGE[o.shipStatus].label}</Badge>
                      </Td>
                      <Td numeric>{formatCurrency(o.openAmount)}</Td>
                      <Td numeric className="font-semibold">{formatCurrency(o.shippableAmount)}</Td>
                    </Tr>
                    {open && (
                      <tr>
                        <td colSpan={7} className="bg-slate-50 px-6 py-3">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-navy/50">
                                <th className="text-left py-1">Item</th>
                                <th className="text-right">Ordered</th>
                                <th className="text-right">Invoiced</th>
                                <th className="text-right">Remaining</th>
                                <th className="text-right">On hand</th>
                                <th className="text-right" title="Reserved for earlier orders and pending builds">Ahead of it</th>
                                <th className="text-right">Can ship</th>
                                <th className="text-right">Ship now</th>
                              </tr>
                            </thead>
                            <tbody>
                              {o.lines.map((l) => (
                                <tr key={l.lineId} className="border-t border-slate-200">
                                  <td className="py-1.5">
                                    <div className="font-medium text-navy">{l.itemName ?? l.description ?? '—'}</div>
                                    {l.itemName && l.description && <div className="text-xs text-navy/50">{l.description}</div>}
                                  </td>
                                  <td className="text-right tabular-nums">{q(l.quantityOrdered)}</td>
                                  <td className="text-right tabular-nums">{q(l.quantityInvoiced)}</td>
                                  <td className="text-right tabular-nums">{q(l.quantityRemaining)}</td>
                                  <td className="text-right tabular-nums">{l.tracksStock ? q(l.quantityOnHand) : 'n/a'}</td>
                                  <td className="text-right tabular-nums">{l.tracksStock ? q(l.quantityAllocatedBefore) : '—'}</td>
                                  <td className="text-right tabular-nums">
                                    <span className={l.shipStatus === 'complete' ? 'text-emerald font-semibold' : l.shipStatus === 'partial' ? 'text-amber-600 font-semibold' : 'text-red-600 font-semibold'}>
                                      {q(l.canShip)}
                                    </span>
                                  </td>
                                  <td className="text-right">
                                    <Input
                                      type="number"
                                      min="0"
                                      max={Number(l.quantityRemaining)}
                                      step="any"
                                      className="ml-auto w-20 py-1 text-right"
                                      value={shipQty[l.lineId] ?? ''}
                                      onChange={(e) => setShipQty((p) => ({ ...p, [l.lineId]: e.target.value }))}
                                      aria-label={`Quantity to ship for ${l.itemName ?? l.description ?? 'line'}`}
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {orders.length > 0 && (
        <Card className="mt-4 p-4 flex flex-wrap items-end gap-3">
          <div className="text-sm text-navy/70 mr-auto">
            <strong className="text-navy">{selected.size}</strong> order{selected.size === 1 ? '' : 's'} selected ·{' '}
            {formatCurrency(selectedShipValue.toFixed(2))} to ship (before tax)
          </div>
          <Button variant="secondary" onClick={() => print('pick-list')} disabled={selected.size === 0}>
            <ClipboardList className="h-4 w-4" /> Print pick list
          </Button>
          <Button variant="secondary" onClick={() => print('packing-slips')} disabled={selected.size === 0}>
            <Printer className="h-4 w-4" /> Print packing slips
          </Button>
          <div>
            <Label htmlFor="inv-date" className="text-xs">Invoice date</Label>
            <Input id="inv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>
          <Button onClick={createInvoices} loading={invoicing} disabled={selected.size === 0}>
            <FileText className="h-4 w-4" /> Create invoices
          </Button>
        </Card>
      )}

      <Modal open={!!results} onClose={() => setResults(null)} title="Batch invoicing results" size="lg" footer={<Button onClick={() => setResults(null)}>Done</Button>}>
        <Table>
          <thead>
            <Tr>
              <Th>Order</Th>
              <Th>Customer</Th>
              <Th>Result</Th>
              <Th numeric>Invoice total</Th>
            </Tr>
          </thead>
          <tbody>
            {(results ?? []).map((r) => (
              <Tr key={r.salesOrderId}>
                <Td>#{r.refNumber || r.orderNumber}</Td>
                <Td>{r.customerName}</Td>
                <Td>{r.ok ? <Badge tone="success">Invoice #{r.invoiceRef || r.invoiceNumber}</Badge> : <span className="text-sm text-red-600">{r.error}</span>}</Td>
                <Td numeric>{r.total ? formatCurrency(r.total) : '—'}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Modal>
    </main>
  );
}
