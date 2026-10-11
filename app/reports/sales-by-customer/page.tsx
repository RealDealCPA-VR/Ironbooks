'use client';

import { TrendingUp } from 'lucide-react';
import { formatCurrency } from '@/lib/money';
import SimpleReport from '../_components/SimpleReport';

interface SalesByCustomerRow {
  customerId: string;
  customerName: string;
  totalSales: string;
  invoiceCount: number;
}

interface SalesByCustomerData {
  rows: SalesByCustomerRow[];
}

export default function SalesByCustomerPage() {
  return (
    <SimpleReport<SalesByCustomerData, SalesByCustomerRow>
      title="Sales by Customer"
      icon={TrendingUp}
      csvName="sales-by-customer.csv"
      emptyText="No sales in this period."
      controls="range"
      buildUrl={({ from, to }) => `/api/reports/sales-by-customer?from=${from}&to=${to}`}
      getRows={(d) => d.rows}
      rowHref={(r, q) => `/reports/std/sales-by-customer-detail?customerId=${r.customerId}&from=${q.from}&to=${q.to}`}
      columns={[
        {
          header: 'Customer',
          cell: (r) => (
            <span className="font-medium">{r.customerName}</span>
          ),
          csv: (r) => r.customerName,
        },
        {
          header: 'Invoices',
          className: 'text-right tabular-nums',
          cell: (r) => r.invoiceCount,
          csv: (r) => r.invoiceCount,
        },
        {
          header: 'Total Sales',
          className: 'text-right tabular-nums',
          cell: (r) => <span className="font-semibold">{formatCurrency(r.totalSales)}</span>,
          csv: (r) => r.totalSales,
        },
      ]}
    />
  );
}
