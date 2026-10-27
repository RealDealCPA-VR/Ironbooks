'use client';

/**
 * Advanced Inventory reports (QB Desktop Enterprise parity) — five tabs:
 *   Quantity on Hand by Site   item × site matrix with bin breakdown and value
 *   Stock Status by Site       on hand / committed / available / on PO / reorder per site
 *   Reorder by Site            only the item/site pairs at or below their reorder point
 *   Serial/Lot in Stock        every serial and lot on hand, by site and bin (lot expiry)
 *   Serial/Lot History         every transaction that moved a serial or lot number
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Barcode, Download, History, PackageCheck, ShoppingCart, Warehouse } from 'lucide-react';
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
import { lotExpired } from '@/lib/reports/dates';
import { formatCurrency } from '@/lib/money';
import { downloadCsv, fmtDate } from '../_components/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SiteCol {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  totalQuantity: string;
  totalValue: string;
}

interface QohRow {
  itemId: string;
  name: string;
  sku: string | null;
  trackingMode: string;
  unitCost: string;
  totalQuantity: string;
  totalValue: string;
  bySite: Record<string, string>;
  bins: Array<{ siteId: string; binId: string; binName: string; quantity: string }>;
}

interface QohData {
  sites: SiteCol[];
  rows: QohRow[];
  grandTotalValue: string;
}

interface StatusRow {
  siteId: string;
  siteName: string;
  itemId: string;
  name: string;
  sku: string | null;
  onHand: string;
  committed: string;
  available: string;
  onPO: string;
  reorderPoint: string | null;
  maxQuantity: string | null;
  suggestedOrder: string;
  needsReorder: boolean;
}

interface SerialRow {
  itemId: string;
  itemName: string;
  serialNumber: string;
  siteName: string;
  binName: string | null;
  receivedDate: string | null;
}

interface LotRow {
  itemId: string;
  itemName: string;
  lotNumber: string;
  siteName: string;
  binName: string | null;
  quantity: string;
  expirationDate: string | null;
}

interface TxnRow {
  movementId: string;
  date: string;
  itemName: string;
  serialNumber: string | null;
  lotNumber: string | null;
  siteName: string;
  binName: string | null;
  quantity: string;
  sourceLabel: string;
  sourceNumber: string | null;
  reversed: boolean;
}

interface SiteOption {
  id: string;
  name: string;
  isDefault: boolean;
}

type Tab = 'qoh' | 'status' | 'reorder' | 'tracked' | 'history';

const qty = (v: string | number | null | undefined) =>
  v == null || v === '' ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 4 });

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InventoryBySiteReportsPage() {
  const [tab, setTab] = useState<Tab>('qoh');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [siteId, setSiteId] = useState('');
  const [loading, setLoading] = useState(false);

  const [qoh, setQoh] = useState<QohData | null>(null);
  const [status, setStatus] = useState<StatusRow[] | null>(null);
  const [reorder, setReorder] = useState<StatusRow[] | null>(null);
  const [tracked, setTracked] = useState<{ serials: SerialRow[]; lots: LotRow[] } | null>(null);
  const [history, setHistory] = useState<TxnRow[] | null>(null);
  const [showBins, setShowBins] = useState(false);
  const [search, setSearch] = useState('');
  const [searchKind, setSearchKind] = useState<'serialNumber' | 'lotNumber'>('serialNumber');

  useEffect(() => {
    api
      .get<SiteOption[]>('/api/inventory-sites')
      .then(setSites)
      .catch(() => undefined);
  }, []);

  const load = useCallback(
    async (which: Tab) => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (siteId) qs.set('siteId', siteId);
        if (which === 'qoh') {
          qs.set('report', 'qoh');
          setQoh(await api.get<QohData>(`/api/inventory-sites/reports?${qs}`));
        } else if (which === 'status') {
          qs.set('report', 'stock-status');
          setStatus((await api.get<{ rows: StatusRow[] }>(`/api/inventory-sites/reports?${qs}`)).rows);
        } else if (which === 'reorder') {
          qs.set('report', 'reorder');
          setReorder((await api.get<{ rows: StatusRow[] }>(`/api/inventory-sites/reports?${qs}`)).rows);
        } else if (which === 'tracked') {
          qs.set('report', 'serial-lot');
          setTracked(await api.get<{ serials: SerialRow[]; lots: LotRow[] }>(`/api/inventory-sites/reports?${qs}`));
        } else {
          const hq = new URLSearchParams({ report: 'transactions', includeReversed: '1' });
          if (search.trim()) hq.set(searchKind, search.trim());
          setHistory((await api.get<{ rows: TxnRow[] }>(`/api/inventory-sites/reports?${hq}`)).rows);
        }
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load report.', 'danger');
      } finally {
        setLoading(false);
      }
    },
    [siteId, search, searchKind],
  );

  // Reload the active tab when it or the site filter changes.
  useEffect(() => {
    if (tab !== 'history') void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, siteId]);

  const visibleSites = useMemo(() => (qoh ? qoh.sites : []), [qoh]);

  function exportCsv() {
    const siteLabel = siteId ? ` — ${sites.find((s) => s.id === siteId)?.name ?? ''}` : '';
    if (tab === 'qoh' && qoh) {
      downloadCsv(
        'quantity-on-hand-by-site.csv',
        `Quantity on Hand by Site${siteLabel}`,
        ['Item', 'SKU', ...visibleSites.map((s) => s.name), 'Total Qty', 'Unit Cost', 'Value'],
        qoh.rows.map((r) => [
          r.name,
          r.sku ?? '',
          ...visibleSites.map((s) => r.bySite[s.id] ?? '0'),
          r.totalQuantity,
          r.unitCost,
          r.totalValue,
        ]),
      );
    } else if ((tab === 'status' && status) || (tab === 'reorder' && reorder)) {
      const rows = (tab === 'status' ? status : reorder) ?? [];
      downloadCsv(
        tab === 'status' ? 'stock-status-by-site.csv' : 'reorder-by-site.csv',
        `${tab === 'status' ? 'Inventory Stock Status by Site' : 'Inventory Reorder Report by Site'}${siteLabel}`,
        ['Site', 'Item', 'SKU', 'On Hand', 'Committed', 'Available', 'On PO', 'Reorder Pt', 'Max', 'Order'],
        rows.map((r) => [r.siteName, r.name, r.sku ?? '', r.onHand, r.committed, r.available, r.onPO, r.reorderPoint ?? '', r.maxQuantity ?? '', r.suggestedOrder]),
      );
    } else if (tab === 'tracked' && tracked) {
      downloadCsv(
        'serial-lot-in-stock.csv',
        `Serial/Lot Numbers in Stock by Site${siteLabel}`,
        ['Item', 'Type', 'Serial / Lot', 'Site', 'Bin', 'Qty', 'Received / Expires'],
        [
          ...tracked.serials.map((s) => [s.itemName, 'Serial', s.serialNumber, s.siteName, s.binName ?? '', '1', fmtDate(s.receivedDate)]),
          ...tracked.lots.map((l) => [l.itemName, 'Lot', l.lotNumber, l.siteName, l.binName ?? '', l.quantity, fmtDate(l.expirationDate)]),
        ],
      );
    } else if (tab === 'history' && history) {
      downloadCsv(
        'serial-lot-transactions.csv',
        'Transactions by Serial/Lot Number',
        ['Date', 'Item', 'Serial', 'Lot', 'Site', 'Bin', 'Qty', 'Transaction', 'No.', 'Status'],
        history.map((h) => [fmtDate(h.date), h.itemName, h.serialNumber ?? '', h.lotNumber ?? '', h.siteName, h.binName ?? '', h.quantity, h.sourceLabel, h.sourceNumber ?? '', h.reversed ? 'Void/Edited' : '']),
      );
    }
  }

  const tabs: Array<{ id: Tab; label: string; icon: typeof Warehouse }> = [
    { id: 'qoh', label: 'Quantity on Hand by Site', icon: Warehouse },
    { id: 'status', label: 'Stock Status by Site', icon: PackageCheck },
    { id: 'reorder', label: 'Reorder by Site', icon: ShoppingCart },
    { id: 'tracked', label: 'Serial/Lot in Stock', icon: Barcode },
    { id: 'history', label: 'Serial/Lot History', icon: History },
  ];

  const statusRows = tab === 'status' ? status : reorder;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Inventory by Site"
        icon={Warehouse}
        action={
          <Button variant="secondary" onClick={exportCsv} disabled={loading}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.id ? 'bg-electric text-white shadow-sm' : 'bg-white/70 text-navy/60 hover:bg-white hover:text-navy'
            }`}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      <Card className="mb-6 flex flex-wrap items-end gap-4 p-4">
        {tab !== 'history' ? (
          <div className="w-64">
            <Label htmlFor="site-filter">Site</Label>
            <Select id="site-filter" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">All sites</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void load('history');
            }}
          >
            <div>
              <Label htmlFor="hist-kind">Search by</Label>
              <Select id="hist-kind" value={searchKind} onChange={(e) => setSearchKind(e.target.value as typeof searchKind)}>
                <option value="serialNumber">Serial number</option>
                <option value="lotNumber">Lot number</option>
              </Select>
            </div>
            <div className="w-64">
              <Label htmlFor="hist-search">Number (blank = all)</Label>
              <Input id="hist-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Scan or type…" />
            </div>
            <Button type="submit" loading={loading}>
              Run
            </Button>
          </form>
        )}
        {tab === 'qoh' && (
          <label className="flex items-center gap-2 text-sm text-navy/70">
            <input type="checkbox" className="accent-electric" checked={showBins} onChange={(e) => setShowBins(e.target.checked)} />
            Show bins
          </label>
        )}
        {loading && <Spinner className="h-5 w-5 text-electric" />}
      </Card>

      {tab === 'qoh' && qoh && (
        <Card className="overflow-hidden p-0">
          {qoh.rows.length === 0 ? (
            <EmptyState icon={Warehouse} title="No stock on hand" message="Receive inventory to see quantities by site." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  {visibleSites.map((s) => (
                    <Th key={s.id} numeric>
                      {s.name}
                    </Th>
                  ))}
                  <Th numeric>Total</Th>
                  <Th numeric>Value</Th>
                </tr>
              </thead>
              <tbody>
                {qoh.rows.map((r) => (
                  <Fragment key={r.itemId}>
                    <Tr>
                      <Td>
                        <span className="font-medium">{r.name}</span>
                        {r.sku && <span className="ml-2 text-xs text-navy/40">{r.sku}</span>}
                        {r.trackingMode !== 'none' && (
                          <Badge tone="info" className="ml-2">
                            {r.trackingMode}
                          </Badge>
                        )}
                      </Td>
                      {visibleSites.map((s) => (
                        <Td key={s.id} numeric>
                          {qty(r.bySite[s.id] ?? '0')}
                        </Td>
                      ))}
                      <Td numeric className="font-semibold">
                        {qty(r.totalQuantity)}
                      </Td>
                      <Td numeric>{formatCurrency(r.totalValue)}</Td>
                    </Tr>
                    {showBins &&
                      r.bins.map((b) => (
                        <tr key={`${r.itemId}-${b.binId}`} className="text-xs text-navy/50">
                          <td className="py-1 pl-10">Bin {b.binName}</td>
                          {visibleSites.map((s) => (
                            <td key={s.id} className="py-1 px-4 text-right tabular-nums">
                              {s.id === b.siteId ? qty(b.quantity) : ''}
                            </td>
                          ))}
                          <td />
                          <td />
                        </tr>
                      ))}
                  </Fragment>
                ))}
                <tr className="bg-navy/5 font-semibold">
                  <Td>Total</Td>
                  {visibleSites.map((s) => (
                    <Td key={s.id} numeric>
                      {formatCurrency(s.totalValue)}
                    </Td>
                  ))}
                  <Td />
                  <Td numeric>{formatCurrency(qoh.grandTotalValue)}</Td>
                </tr>
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {(tab === 'status' || tab === 'reorder') && statusRows && (
        <Card className="overflow-hidden p-0">
          {statusRows.length === 0 ? (
            <EmptyState
              icon={PackageCheck}
              title={tab === 'reorder' ? 'Nothing to reorder' : 'No stock'}
              message={tab === 'reorder' ? 'Every site is above its reorder point.' : 'No inventory activity at this site yet.'}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Site</Th>
                  <Th>Item</Th>
                  <Th numeric>On Hand</Th>
                  <Th numeric>On Sales Order</Th>
                  <Th numeric>Available</Th>
                  <Th numeric>On PO</Th>
                  <Th numeric>Reorder Pt</Th>
                  <Th numeric>Max</Th>
                  <Th numeric>Order</Th>
                </tr>
              </thead>
              <tbody>
                {statusRows.map((r) => (
                  <Tr key={`${r.siteId}-${r.itemId}`}>
                    <Td>{r.siteName}</Td>
                    <Td>
                      {r.name}
                      {r.needsReorder && (
                        <Badge tone="warning" className="ml-2">
                          Reorder
                        </Badge>
                      )}
                    </Td>
                    <Td numeric>{qty(r.onHand)}</Td>
                    <Td numeric>{qty(r.committed)}</Td>
                    <Td numeric className={Number(r.available) < 0 ? 'text-red-600' : undefined}>
                      {qty(r.available)}
                    </Td>
                    <Td numeric>{qty(r.onPO)}</Td>
                    <Td numeric>{qty(r.reorderPoint)}</Td>
                    <Td numeric>{qty(r.maxQuantity)}</Td>
                    <Td numeric className="font-semibold">
                      {Number(r.suggestedOrder) > 0 ? qty(r.suggestedOrder) : ''}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="px-4 py-3 text-xs text-navy/50">
            Sales orders and purchase orders carry no site, so their quantities count against the default site.
          </p>
        </Card>
      )}

      {tab === 'tracked' && tracked && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="overflow-hidden p-0">
            <h2 className="px-4 pt-4 text-lg font-bold text-navy">Serial numbers</h2>
            {tracked.serials.length === 0 ? (
              <EmptyState icon={Barcode} title="No serial numbers in stock" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th>Serial</Th>
                    <Th>Site</Th>
                    <Th>Bin</Th>
                    <Th>Received</Th>
                  </tr>
                </thead>
                <tbody>
                  {tracked.serials.map((s) => (
                    <Tr key={`${s.itemId}-${s.serialNumber}`}>
                      <Td>{s.itemName}</Td>
                      <Td className="font-mono text-sm">{s.serialNumber}</Td>
                      <Td>{s.siteName}</Td>
                      <Td>{s.binName ?? '—'}</Td>
                      <Td>{fmtDate(s.receivedDate)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card className="overflow-hidden p-0">
            <h2 className="px-4 pt-4 text-lg font-bold text-navy">Lots</h2>
            {tracked.lots.length === 0 ? (
              <EmptyState icon={Barcode} title="No lots in stock" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th>Lot</Th>
                    <Th>Site</Th>
                    <Th>Bin</Th>
                    <Th numeric>Qty</Th>
                    <Th>Expires</Th>
                  </tr>
                </thead>
                <tbody>
                  {tracked.lots.map((l) => {
                    // Expired once its day has passed on this computer's calendar (not the evening before).
                    const expired = lotExpired(l.expirationDate);
                    return (
                      <Tr key={`${l.itemId}-${l.lotNumber}-${l.siteName}-${l.binName ?? ''}`}>
                        <Td>{l.itemName}</Td>
                        <Td className="font-mono text-sm">{l.lotNumber}</Td>
                        <Td>{l.siteName}</Td>
                        <Td>{l.binName ?? '—'}</Td>
                        <Td numeric>{qty(l.quantity)}</Td>
                        <Td>
                          {fmtDate(l.expirationDate)}
                          {expired && (
                            <Badge tone="danger" className="ml-2">
                              Expired
                            </Badge>
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}

      {tab === 'history' && (
        <Card className="overflow-hidden p-0">
          {!history ? (
            <EmptyState icon={History} title="Search a serial or lot number" message="Leave the box blank and press Run to list every serial/lot transaction." />
          ) : history.length === 0 ? (
            <EmptyState icon={History} title="No transactions found" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Item</Th>
                  <Th>Serial / Lot</Th>
                  <Th>Site</Th>
                  <Th>Bin</Th>
                  <Th numeric>Qty</Th>
                  <Th>Transaction</Th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <Tr key={h.movementId} className={h.reversed ? 'opacity-50' : undefined}>
                    <Td>{fmtDate(h.date)}</Td>
                    <Td>{h.itemName}</Td>
                    <Td className="font-mono text-sm">{h.serialNumber ?? h.lotNumber}</Td>
                    <Td>{h.siteName}</Td>
                    <Td>{h.binName ?? '—'}</Td>
                    <Td numeric className={Number(h.quantity) < 0 ? 'text-red-600' : 'text-emerald'}>
                      {qty(h.quantity)}
                    </Td>
                    <Td>
                      {h.sourceLabel}
                      {h.sourceNumber ? ` #${h.sourceNumber}` : ''}
                      {h.reversed && (
                        <Badge tone="void" className="ml-2">
                          Void/edited
                        </Badge>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </main>
  );
}
