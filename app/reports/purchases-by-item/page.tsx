'use client';

import { ShoppingCart } from 'lucide-react';
import { formatCurrency } from '@/lib/money';
import SimpleReport from '../_components/SimpleReport';
import { fmtDate, type CsvCell } from '../_components/shared';

interface PurchasesByItemRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  cost: string;
  avgUnitCost: string | null;
}

interface PurchasesByItemData {
  from?: string;
  to?: string;
  rows: PurchasesByItemRow[];
  totals: { quantity: string; cost: string };
}

export default function PurchasesByItemPage() {
  return (
    <SimpleReport<PurchasesByItemData, PurchasesByItemRow>
      title="Purchases by Item"
      icon={ShoppingCart}
      csvName="purchases-by-item.csv"
      emptyText="No item purchases in this period."
      controls="range"
      buildUrl={({ from, to }) => `/api/reports/purchases-by-item?from=${from}&to=${to}`}
      getRows={(d) => d.rows}
      rowHref={(r, q) => (r.itemId ? `/reports/std/purchases-by-item-detail?itemId=${r.itemId}&from=${q.from}&to=${q.to}` : null)}
      subtitle={(d) => (d.from || d.to ? `${fmtDate(d.from)} – ${fmtDate(d.to)}` : 'All dates')}
      columns={[
        {
          header: 'Item',
          cell: (r) => (
            <span className="font-medium">{r.itemName}</span>
          ),
          csv: (r) => r.itemName,
        },
        { header: 'SKU', cell: (r) => r.sku ?? '—', csv: (r) => r.sku ?? '' },
        { header: 'Qty', className: 'text-right tabular-nums', cell: (r) => r.quantity, csv: (r) => r.quantity },
        {
          header: 'Cost',
          className: 'text-right tabular-nums',
          cell: (r) => <span className="font-semibold">{formatCurrency(r.cost)}</span>,
          csv: (r) => r.cost,
        },
        {
          header: 'Avg Unit Cost',
          className: 'text-right tabular-nums',
          cell: (r) => (r.avgUnitCost === null ? '—' : formatCurrency(r.avgUnitCost)),
          csv: (r) => r.avgUnitCost ?? '',
        },
      ]}
      footerRows={(d) => [
        {
          cells: ['TOTAL', '', d.totals.quantity, formatCurrency(d.totals.cost), ''] as CsvCell[],
          emphasized: true,
        },
      ]}
    />
  );
}
