'use client';

import { Package } from 'lucide-react';
import { formatCurrency } from '@/lib/money';
import SimpleReport from '../_components/SimpleReport';
import { fmtDate, type CsvCell } from '../_components/shared';

interface SalesByItemRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  type: string;
  quantity: string;
  revenue: string;
  cogs: string;
  margin: string;
  marginPct: string | null;
}

interface SalesByItemData {
  from?: string;
  to?: string;
  rows: SalesByItemRow[];
  totals: { quantity: string; revenue: string; cogs: string; margin: string; marginPct: string | null };
}

export default function SalesByItemPage() {
  return (
    <SimpleReport<SalesByItemData, SalesByItemRow>
      title="Sales by Item"
      icon={Package}
      csvName="sales-by-item.csv"
      emptyText="No item sales in this period."
      controls="range"
      buildUrl={({ from, to }) => `/api/reports/sales-by-item?from=${from}&to=${to}`}
      getRows={(d) => d.rows}
      rowHref={(r, q) => (r.itemId ? `/reports/std/sales-by-item-detail?itemId=${r.itemId}&from=${q.from}&to=${q.to}` : null)}
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
        { header: 'Type', cell: (r) => r.type, csv: (r) => r.type },
        { header: 'Qty', className: 'text-right tabular-nums', cell: (r) => r.quantity, csv: (r) => r.quantity },
        {
          header: 'Revenue',
          className: 'text-right tabular-nums',
          cell: (r) => formatCurrency(r.revenue),
          csv: (r) => r.revenue,
        },
        {
          header: 'COGS',
          className: 'text-right tabular-nums',
          cell: (r) => formatCurrency(r.cogs),
          csv: (r) => r.cogs,
        },
        {
          header: 'Margin',
          className: 'text-right tabular-nums',
          cell: (r) => <span className="font-semibold">{formatCurrency(r.margin)}</span>,
          csv: (r) => r.margin,
        },
        {
          header: 'Margin %',
          className: 'text-right tabular-nums',
          cell: (r) => (r.marginPct === null ? '—' : `${r.marginPct}%`),
          csv: (r) => r.marginPct ?? '',
        },
      ]}
      footerRows={(d) => [
        {
          cells: [
            'TOTAL',
            '',
            '',
            d.totals.quantity,
            formatCurrency(d.totals.revenue),
            formatCurrency(d.totals.cogs),
            formatCurrency(d.totals.margin),
            d.totals.marginPct === null ? '' : `${d.totals.marginPct}%`,
          ] as CsvCell[],
          emphasized: true,
        },
      ]}
    />
  );
}
