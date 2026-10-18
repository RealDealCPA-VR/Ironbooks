'use client';
/**
 * Inventory Center — /inventory-center
 * Every inventory item with its stock picture on the left; pick one to see its details and
 * every transaction that used it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Warehouse, AlertTriangle } from 'lucide-react';
import { Badge, Card, EmptyState, Input, PageHeader, Spinner, Table, Td, Th, Tr, toastError } from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { cn } from '@/lib/utils';

interface Row {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  isActive: boolean;
  quantityOnHand: string;
  committed: string;
  available: string;
  onPO: string;
  reorderPoint: string | null;
  averageCost: string;
  value: string;
  costing: 'fifo' | 'average';
  salesPrice: string | null;
  preferredVendorName: string | null;
  needsReorder: boolean;
}
interface Txn {
  type: string;
  path: string | null;
  id: string;
  number: string | null;
  date: string;
  name: string | null;
  quantity: string;
  amount: string | null;
  status: string | null;
}
interface Detail {
  item: { id: string; name: string; description: string | null; unitOfMeasure: string | null; barcode: string | null };
  stock: Row | null;
  uomSet: { name: string; base: string } | null;
  transactions: Txn[];
}

const qty = (v: string | null | undefined) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 }));

export default function InventoryCenterPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get<{ items: Row[] }>(`/api/inventory/center${showInactive ? '?includeInactive=true' : ''}`);
      setRows(d.items);
      setSelectedId((prev) => prev ?? d.items[0]?.id ?? null);
    } catch (err) {
      toastError(err, 'Could not load inventory.');
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    api
      .get<Detail>(`/api/inventory/center/${selectedId}`)
      .then(setDetail)
      .catch((err) => toastError(err, 'Could not load the item.'))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || (r.sku ?? '').toLowerCase().includes(q)) : rows;
  }, [rows, search]);
  const totalValue = useMemo(() => rows.reduce((s, r) => s + Number(r.value), 0), [rows]);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Inventory Center" icon={Warehouse} />
      <div className="flex flex-col gap-6 xl:flex-row">
        <Card className="p-4 xl:w-[28rem] shrink-0">
          <div className="mb-3 flex items-center gap-2">
            <Input aria-label="Search items" placeholder="Search name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
            <label className="flex items-center gap-1 whitespace-nowrap text-xs text-navy/60">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Inactive
            </label>
          </div>
          <p className="mb-2 text-xs text-navy/50">
            {rows.length} items · total value {formatCurrency(totalValue)}
          </p>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-navy/50">
              <Spinner className="h-4 w-4" /> Loading…
            </div>
          ) : shown.length === 0 ? (
            <EmptyState icon={Warehouse} title="No inventory items" message="Create an inventory part on the Items page." />
          ) : (
            <ul className="max-h-[70vh] overflow-y-auto">
              {shown.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={r.id === selectedId ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-navy/5',
                      r.id === selectedId && 'bg-electric/10',
                    )}
                  >
                    <span className="min-w-0">
                      <span className={cn('block truncate font-medium text-navy', !r.isActive && 'text-navy/40')}>{r.name}</span>
                      {r.sku && <span className="block text-xs text-navy/40">{r.sku}</span>}
                    </span>
                    <span className="flex items-center gap-2 tabular-nums text-navy/70">
                      {r.needsReorder && <AlertTriangle className="h-4 w-4 text-amber-500" aria-label="Below reorder point" />}
                      {qty(r.quantityOnHand)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="min-w-0 flex-1">
          {detailLoading && !detail ? (
            <Card className="p-6">
              <Spinner className="h-5 w-5" />
            </Card>
          ) : detail ? (
            <>
              <Card className="mb-6 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-2xl font-bold text-navy">{detail.item.name}</h2>
                    {detail.item.description && <p className="text-sm text-navy/60">{detail.item.description}</p>}
                    <p className="mt-1 text-xs text-navy/50">
                      {detail.uomSet ? `Counted in ${detail.uomSet.base} (${detail.uomSet.name})` : detail.item.unitOfMeasure ? `Unit: ${detail.item.unitOfMeasure}` : ''}
                      {detail.item.barcode ? ` · Barcode ${detail.item.barcode}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Link href={`/items?focus=${detail.item.id}`} className="text-sm font-semibold text-electric hover:underline">
                      Edit item
                    </Link>
                    <Link href="/inventory-ops" className="text-sm font-semibold text-electric hover:underline">
                      Adjust / count
                    </Link>
                  </div>
                </div>
                {detail.stock && (
                  <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-8">
                    {[
                      ['On hand', qty(detail.stock.quantityOnHand)],
                      ['On sales orders', qty(detail.stock.committed)],
                      ['Available', qty(detail.stock.available)],
                      ['On purchase orders', qty(detail.stock.onPO)],
                      ['Reorder point', qty(detail.stock.reorderPoint)],
                      ['Average cost', formatCurrency(detail.stock.averageCost)],
                      ['Value', formatCurrency(detail.stock.value)],
                      ['Preferred vendor', detail.stock.preferredVendorName ?? '—'],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-navy/50">{k}</dt>
                        <dd className="font-semibold tabular-nums text-navy">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {detail.stock?.needsReorder && (
                  <p className="mt-3 flex items-center gap-2 text-sm text-amber-700">
                    <AlertTriangle className="h-4 w-4" /> Stock is at or below the reorder point.{' '}
                    <Link href="/inventory-ops" className="font-semibold underline">
                      Create a purchase order
                    </Link>
                  </p>
                )}
              </Card>
              <Card className="p-6">
                <h3 className="mb-3 text-lg font-bold text-navy">Transactions</h3>
                {detail.transactions.length === 0 ? (
                  <p className="text-sm text-navy/50">No transactions use this item yet.</p>
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Date</Th>
                        <Th>Type</Th>
                        <Th>No.</Th>
                        <Th>Name</Th>
                        <Th numeric>Qty in/out</Th>
                        <Th numeric>Amount</Th>
                        <Th>Status</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.transactions.map((t, i) => (
                        <Tr key={`${t.type}-${t.id}-${i}`}>
                          <Td>{t.date.slice(0, 10)}</Td>
                          <Td>{t.path ? <Link href={`/${t.path}?focus=${t.id}`} className="text-electric hover:underline">{t.type}</Link> : t.type}</Td>
                          <Td>{t.number ?? ''}</Td>
                          <Td>{t.name ?? ''}</Td>
                          <Td numeric className={Number(t.quantity) < 0 ? 'text-red-600' : ''}>
                            {Number(t.quantity) === 0 ? '—' : qty(t.quantity)}
                          </Td>
                          <Td numeric>{t.amount ? formatCurrency(t.amount) : ''}</Td>
                          <Td>{t.status ? <Badge tone="neutral">{t.status}</Badge> : null}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          ) : (
            <Card className="p-6 text-sm text-navy/50">Pick an item to see its details.</Card>
          )}
        </div>
      </div>
    </main>
  );
}
