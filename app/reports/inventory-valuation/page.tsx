'use client';

/**
 * Inventory Valuation report — three tabs:
 *   Summary       current valuation (item/layer based) or GL-reconstructed as-of
 *                 a past date, with the documented approximations surfaced.
 *   Detail        transaction-level value movements per item with running balance.
 *   Stock Status  on-hand / committed / available / on-PO / reorder / suggested.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Boxes, Download, FileSearch, Layers3, PackageCheck } from 'lucide-react';
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
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatShortDate } from '@/lib/format';
import { downloadCsv, todayStr, yearStartStr } from '../_components/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface CurrentRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  averageCost: string;
  totalValue: string;
  costingMethod: 'fifo' | 'average';
}

interface AsOfRow {
  id: string;
  name: string;
  sku: string | null;
  costingMethod: 'fifo' | 'average';
  valueAsOf: string;
  quantityAsOf: string | null;
  unitCostUsed: string | null;
}

interface SummaryData {
  mode: 'current' | 'asOf';
  asOf: string | null;
  items: Array<CurrentRow | AsOfRow>;
  grandTotal: string;
  notes?: string[];
}

interface DetailMovement {
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  valueIn: string;
  valueOut: string;
  delta: string;
  runningValue: string;
  approxQty: string | null;
}

interface DetailItem {
  itemId: string;
  name: string;
  sku: string | null;
  costingMethod: 'fifo' | 'average';
  openingValue: string;
  closingValue: string;
  movements: DetailMovement[];
}

interface DetailData {
  from: string | null;
  to: string | null;
  items: DetailItem[];
  notes: string[];
}

interface StockRow {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: string;
  committed: string;
  available: string;
  onPO: string;
  reorderPoint: string | null;
  suggestedOrder: string;
}

interface StockData {
  rows: StockRow[];
  attentionCount: number;
}

interface ItemOption {
  id: string;
  name: string;
  sku: string | null;
}

type Tab = 'summary' | 'detail' | 'stock';

function fmtQty(v: string | null): string {
  if (v == null) return '—';
  return parseFloat(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InventoryValuationPage() {
  const [tab, setTab] = useState<Tab>('summary');

  // Summary
  const [asOf, setAsOf] = useState('');
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);

  // Detail
  const [itemOptions, setItemOptions] = useState<ItemOption[]>([]);
  const [detailItemId, setDetailItemId] = useState('');
  const [from, setFrom] = useState(yearStartStr());
  const [to, setTo] = useState(todayStr());
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Stock status
  const [stock, setStock] = useState<StockData | null>(null);
  const [loadingStock, setLoadingStock] = useState(false);

  // ── Loaders ─────────────────────────────────────────────────────────────────

  const fetchSummary = useCallback(async (asOfValue: string) => {
    setLoadingSummary(true);
    try {
      const url = asOfValue
        ? `/api/reports/inventory-valuation?asOf=${asOfValue}`
        : '/api/reports/inventory-valuation';
      const data = await api.get<SummaryData>(url);
      setSummary(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load valuation.', 'danger');
    } finally {
      setLoadingSummary(false);
    }
  }, []);

  const fetchDetail = useCallback(async (itemId: string, fromV: string, toV: string) => {
    setLoadingDetail(true);
    try {
      const params = new URLSearchParams();
      if (itemId) params.set('itemId', itemId);
      if (fromV) params.set('from', fromV);
      if (toV) params.set('to', toV);
      const data = await api.get<DetailData>(`/api/reports/inventory-valuation/detail?${params}`);
      setDetail(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load valuation detail.', 'danger');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const fetchStock = useCallback(async () => {
    setLoadingStock(true);
    try {
      const data = await api.get<StockData>('/api/inventory/stock-status');
      setStock(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load stock status.', 'danger');
    } finally {
      setLoadingStock(false);
    }
  }, []);

  useEffect(() => {
    fetchSummary('');
    api
      .get<{ items: Array<ItemOption & { type: string }> }>('/api/items?type=inventory')
      .then((d) => setItemOptions(d.items ?? []))
      .catch(() => undefined);
  }, [fetchSummary]);

  useEffect(() => {
    if (tab === 'stock' && !stock) fetchStock();
    if (tab === 'detail' && !detail) fetchDetail(detailItemId, from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ── Drill from summary to detail ────────────────────────────────────────────

  function drillToDetail(itemId: string) {
    setDetailItemId(itemId);
    setTab('detail');
    fetchDetail(itemId, from, to);
  }

  // ── CSV exports ─────────────────────────────────────────────────────────────

  function exportSummaryCsv() {
    if (!summary) return;
    if (summary.mode === 'asOf') {
      const rows = (summary.items as AsOfRow[]).map((r) => [
        r.name,
        r.sku ?? '',
        r.costingMethod,
        r.quantityAsOf ?? '',
        r.unitCostUsed ?? '',
        r.valueAsOf,
      ]);
      rows.push(['TOTAL', '', '', '', '', summary.grandTotal]);
      downloadCsv(
        'inventory-valuation-asof.csv',
        `Inventory Valuation as of ${formatShortDate(summary.asOf)}`,
        ['Item', 'SKU', 'Method', 'Qty (approx)', 'Unit Cost Used', 'Value'],
        rows,
      );
    } else {
      const rows = (summary.items as CurrentRow[]).map((r) => [
        r.name,
        r.sku ?? '',
        r.costingMethod,
        r.quantityOnHand,
        r.averageCost,
        r.totalValue,
      ]);
      rows.push(['TOTAL', '', '', '', '', summary.grandTotal]);
      downloadCsv(
        'inventory-valuation.csv',
        'Inventory Valuation Summary',
        ['Item', 'SKU', 'Method', 'Qty On Hand', 'Unit Cost', 'Value'],
        rows,
      );
    }
  }

  function exportDetailCsv() {
    if (!detail) return;
    const rows: Array<Array<string | number>> = [];
    for (const item of detail.items) {
      rows.push([item.name, '', '', '', 'Opening', item.openingValue]);
      for (const m of item.movements) {
        rows.push([
          item.name,
          formatShortDate(m.date),
          `JE #${m.entryNumber}`,
          m.description,
          m.delta,
          m.runningValue,
        ]);
      }
      rows.push([item.name, '', '', '', 'Closing', item.closingValue]);
    }
    downloadCsv(
      'inventory-valuation-detail.csv',
      'Inventory Valuation Detail',
      ['Item', 'Date', 'Entry', 'Description', 'Value Change', 'Running Value'],
      rows,
    );
  }

  function exportStockCsv() {
    if (!stock) return;
    downloadCsv(
      'inventory-stock-status.csv',
      'Inventory Stock Status by Item',
      ['Item', 'SKU', 'On Hand', 'Committed', 'Available', 'On PO', 'Reorder Point', 'Suggested Order'],
      stock.rows.map((r) => [
        r.name,
        r.sku ?? '',
        r.quantityOnHand,
        r.committed,
        r.available,
        r.onPO,
        r.reorderPoint ?? '',
        r.suggestedOrder,
      ]),
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const tabs: Array<{ id: Tab; label: string; icon: typeof Boxes }> = [
    { id: 'summary', label: 'Summary', icon: Boxes },
    { id: 'detail', label: 'Valuation Detail', icon: FileSearch },
    { id: 'stock', label: 'Stock Status', icon: PackageCheck },
  ];

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Inventory Valuation"
        icon={Layers3}
        action={
          <Button
            variant="secondary"
            onClick={tab === 'summary' ? exportSummaryCsv : tab === 'detail' ? exportDetailCsv : exportStockCsv}
            disabled={
              (tab === 'summary' && !summary) ||
              (tab === 'detail' && !detail) ||
              (tab === 'stock' && !stock)
            }
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      {/* Tab bar */}
      <div className="mb-6 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.id
                ? 'bg-electric text-white shadow-sm'
                : 'bg-white/70 text-navy/60 hover:bg-white hover:text-navy'
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Summary tab ───────────────────────────────────────────────────────── */}
      {tab === 'summary' && (
        <>
          <Card className="p-4 mb-6">
            <form
              className="flex items-end gap-3 flex-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                fetchSummary(asOf);
              }}
            >
              <div>
                <Label htmlFor="val-asof">As of date (blank = current)</Label>
                <Input id="val-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </div>
              <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
                Run Report
              </Button>
              {asOf && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mb-0.5"
                  onClick={() => {
                    setAsOf('');
                    fetchSummary('');
                  }}
                >
                  Reset to current
                </Button>
              )}
            </form>
          </Card>

          <Card className="p-0 overflow-hidden">
            {loadingSummary ? (
              <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
                <Spinner className="h-4 w-4" /> Loading valuation…
              </div>
            ) : !summary || summary.items.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="No inventory items"
                message="Inventory-type items appear here with their quantities and carrying value."
              />
            ) : summary.mode === 'asOf' ? (
              <Table>
                <thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th>SKU</Th>
                    <Th>Method</Th>
                    <Th numeric>Qty (approx)</Th>
                    <Th numeric>Unit Cost Used</Th>
                    <Th numeric>Value as of {formatShortDate(summary.asOf)}</Th>
                  </Tr>
                </thead>
                <tbody>
                  {(summary.items as AsOfRow[]).map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <button
                          className="font-semibold text-electric hover:underline"
                          onClick={() => drillToDetail(r.id)}
                          title="Open valuation detail"
                        >
                          {r.name}
                        </button>
                      </Td>
                      <Td className="text-navy/50 text-xs">{r.sku ?? '—'}</Td>
                      <Td>
                        <Badge tone="info">{r.costingMethod}</Badge>
                      </Td>
                      <Td numeric>{fmtQty(r.quantityAsOf)}</Td>
                      <Td numeric>{r.unitCostUsed ? formatCurrency(r.unitCostUsed) : '—'}</Td>
                      <Td numeric className="font-semibold">{formatCurrency(r.valueAsOf)}</Td>
                    </Tr>
                  ))}
                  <Tr>
                    <Td className="font-bold text-navy">TOTAL</Td>
                    <Td /><Td /><Td /><Td />
                    <Td numeric className="font-bold text-navy">{formatCurrency(summary.grandTotal)}</Td>
                  </Tr>
                </tbody>
              </Table>
            ) : (
              <Table>
                <thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th>SKU</Th>
                    <Th>Method</Th>
                    <Th numeric>Qty On Hand</Th>
                    <Th numeric>Unit Cost</Th>
                    <Th numeric>Total Value</Th>
                  </Tr>
                </thead>
                <tbody>
                  {(summary.items as CurrentRow[]).map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <button
                          className="font-semibold text-electric hover:underline"
                          onClick={() => drillToDetail(r.id)}
                          title="Open valuation detail"
                        >
                          {r.name}
                        </button>
                      </Td>
                      <Td className="text-navy/50 text-xs">{r.sku ?? '—'}</Td>
                      <Td>
                        <Badge tone="info">{r.costingMethod}</Badge>
                      </Td>
                      <Td numeric>{fmtQty(r.quantityOnHand)}</Td>
                      <Td numeric>{formatCurrency(r.averageCost)}</Td>
                      <Td numeric className="font-semibold">{formatCurrency(r.totalValue)}</Td>
                    </Tr>
                  ))}
                  <Tr>
                    <Td className="font-bold text-navy">TOTAL</Td>
                    <Td /><Td /><Td /><Td />
                    <Td numeric className="font-bold text-navy">{formatCurrency(summary.grandTotal)}</Td>
                  </Tr>
                </tbody>
              </Table>
            )}
          </Card>

          {summary?.notes && summary.notes.length > 0 && (
            <div className="mt-4 rounded-xl bg-gold/10 px-5 py-4 text-xs text-navy/60 space-y-1">
              <p className="font-semibold text-navy/80">About this reconstruction:</p>
              {summary.notes.map((n, i) => (
                <p key={i}>• {n}</p>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Detail tab ────────────────────────────────────────────────────────── */}
      {tab === 'detail' && (
        <>
          <Card className="p-4 mb-6">
            <form
              className="flex items-end gap-3 flex-wrap"
              onSubmit={(e) => {
                e.preventDefault();
                fetchDetail(detailItemId, from, to);
              }}
            >
              <div className="w-64">
                <Label htmlFor="det-item">Item</Label>
                <Select id="det-item" value={detailItemId} onChange={(e) => setDetailItemId(e.target.value)}>
                  <option value="">All items with activity</option>
                  {itemOptions.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                      {i.sku ? ` (${i.sku})` : ''}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="det-from">From</Label>
                <Input id="det-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="det-to">To</Label>
                <Input id="det-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
                Run Report
              </Button>
            </form>
          </Card>

          {loadingDetail ? (
            <Card className="p-0">
              <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
                <Spinner className="h-4 w-4" /> Loading valuation detail…
              </div>
            </Card>
          ) : !detail || detail.items.length === 0 ? (
            <Card className="p-0">
              <EmptyState
                icon={FileSearch}
                title="No inventory value movements"
                message="Inventory receipts, COGS, counts, and value adjustments appear here per item."
              />
            </Card>
          ) : (
            <div className="space-y-6">
              {detail.items.map((item) => (
                <Card key={item.itemId} className="p-0 overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-3 border-b border-navy/10 bg-navy/[0.03]">
                    <div className="flex items-center gap-3">
                      <h3 className="font-bold text-navy">{item.name}</h3>
                      {item.sku && <span className="text-xs text-navy/40">{item.sku}</span>}
                      <Badge tone="info">{item.costingMethod}</Badge>
                    </div>
                    <div className="text-sm text-navy/60">
                      Opening <span className="font-semibold tabular-nums">{formatCurrency(item.openingValue)}</span>
                      <span className="mx-2 text-navy/30">→</span>
                      Closing <span className="font-semibold tabular-nums">{formatCurrency(item.closingValue)}</span>
                    </div>
                  </div>
                  {item.movements.length === 0 ? (
                    <p className="px-5 py-4 text-sm text-navy/40">No movements in this period.</p>
                  ) : (
                    <Table>
                      <thead>
                        <Tr>
                          <Th>Date</Th>
                          <Th>Entry</Th>
                          <Th>Description</Th>
                          <Th numeric>Qty (approx)</Th>
                          <Th numeric>Value In</Th>
                          <Th numeric>Value Out</Th>
                          <Th numeric>Running Value</Th>
                        </Tr>
                      </thead>
                      <tbody>
                        {item.movements.map((m) => (
                          <Tr key={m.entryId}>
                            <Td className="text-navy/70">{formatShortDate(m.date)}</Td>
                            <Td>
                              <Link
                                href={`/journal?focus=${m.entryId}`}
                                className="text-electric text-xs font-semibold hover:underline"
                              >
                                JE #{m.entryNumber}
                              </Link>
                            </Td>
                            <Td className="text-sm text-navy/70">{m.description}</Td>
                            <Td numeric className="text-navy/50">{fmtQty(m.approxQty)}</Td>
                            <Td numeric className={parseFloat(m.valueIn) > 0 ? 'text-emerald font-medium' : 'text-navy/30'}>
                              {parseFloat(m.valueIn) > 0 ? formatCurrency(m.valueIn) : '—'}
                            </Td>
                            <Td numeric className={parseFloat(m.valueOut) > 0 ? 'text-red-600 font-medium' : 'text-navy/30'}>
                              {parseFloat(m.valueOut) > 0 ? formatCurrency(m.valueOut) : '—'}
                            </Td>
                            <Td numeric className="font-semibold tabular-nums">{formatCurrency(m.runningValue)}</Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Card>
              ))}
              <div className="rounded-xl bg-gold/10 px-5 py-4 text-xs text-navy/60 space-y-1">
                {detail.notes.map((n, i) => (
                  <p key={i}>• {n}</p>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Stock status tab ──────────────────────────────────────────────────── */}
      {tab === 'stock' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-navy/50">
              Committed = open sales-order quantity not yet invoiced. Available = on hand − committed.
              On PO = open purchase-order quantity not yet billed.
            </p>
            {stock && (
              <Badge tone={stock.attentionCount > 0 ? 'warning' : 'success'}>
                {stock.attentionCount === 0
                  ? 'No stock issues'
                  : `${stock.attentionCount} item${stock.attentionCount !== 1 ? 's' : ''} need attention`}
              </Badge>
            )}
          </div>
          <Card className="p-0 overflow-hidden">
            {loadingStock ? (
              <div className="flex items-center justify-center gap-2 py-20 text-navy/40 text-sm">
                <Spinner className="h-4 w-4" /> Loading stock status…
              </div>
            ) : !stock || stock.rows.length === 0 ? (
              <EmptyState
                icon={PackageCheck}
                title="No inventory items"
                message="Inventory-type items appear here with committed, available, and on-order quantities."
              />
            ) : (
              <Table>
                <thead>
                  <Tr>
                    <Th>Item</Th>
                    <Th>SKU</Th>
                    <Th numeric>On Hand</Th>
                    <Th numeric>Committed</Th>
                    <Th numeric>Available</Th>
                    <Th numeric>On PO</Th>
                    <Th numeric>Reorder Pt</Th>
                    <Th numeric>Suggested Order</Th>
                  </Tr>
                </thead>
                <tbody>
                  {stock.rows.map((r) => {
                    const available = parseFloat(r.available);
                    const suggested = parseFloat(r.suggestedOrder);
                    return (
                      <Tr key={r.id}>
                        <Td className="font-semibold text-navy">{r.name}</Td>
                        <Td className="text-navy/50 text-xs">{r.sku ?? '—'}</Td>
                        <Td numeric>{fmtQty(r.quantityOnHand)}</Td>
                        <Td numeric className={parseFloat(r.committed) > 0 ? 'text-electric font-semibold' : 'text-navy/50'}>
                          {fmtQty(r.committed)}
                        </Td>
                        <Td numeric>
                          <span className={available < 0 ? 'text-red-600 font-bold' : available === 0 ? 'text-gold font-semibold' : ''}>
                            {fmtQty(r.available)}
                          </span>
                        </Td>
                        <Td numeric className="text-navy/70">{fmtQty(r.onPO)}</Td>
                        <Td numeric className="text-navy/70">{r.reorderPoint == null ? '—' : fmtQty(r.reorderPoint)}</Td>
                        <Td numeric>
                          {suggested > 0 ? (
                            <span className="font-semibold text-electric">{fmtQty(r.suggestedOrder)}</span>
                          ) : (
                            <span className="text-navy/30">—</span>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
