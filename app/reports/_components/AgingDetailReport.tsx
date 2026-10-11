'use client';

/**
 * Shared A/R / A/P Aging Detail page body — per-document rows with bucket
 * labels, bucket totals in the footer, CSV export, and an as-of date control.
 */
import { formatCurrency } from '@/lib/money';
import SimpleReport from './SimpleReport';
import { fmtDate, type CsvCell } from './shared';

interface AgingDetailRow {
  docId: string;
  docNumber: string;
  docType: string;
  entityId: string;
  entityName: string;
  date: string;
  dueDate: string | null;
  daysPastDue: number;
  bucket: string;
  openBalance: string;
}

interface AgingDetailReportData {
  asOf: string;
  rows: AgingDetailRow[];
  bucketTotals: Record<string, string>;
  total: string;
}

const BUCKET_LABELS: Record<string, string> = {
  current: 'Current',
  days1_30: '1-30 Days',
  days31_60: '31-60 Days',
  days61_90: '61-90 Days',
  days91plus: '91+ Days',
};

export default function AgingDetailReport({
  title,
  endpoint,
  entityLabel,
  csvName,
  icon,
}: {
  title: string;
  endpoint: string;
  entityLabel: string;
  csvName: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <SimpleReport<AgingDetailReportData, AgingDetailRow>
      title={title}
      icon={icon}
      csvName={csvName}
      emptyText="Nothing outstanding."
      controls="asof"
      buildUrl={({ asOf }) => `${endpoint}?asOf=${asOf}`}
      getRows={(d) => d.rows}
      rowHref={(r, q) =>
        r.docType === 'invoice' || r.docType === 'credit_memo'
          ? `/reports/std/customer-balance-detail?customerId=${r.entityId}&to=${q.asOf}`
          : `/reports/std/vendor-balance-detail?vendorId=${r.entityId}&to=${q.asOf}`
      }
      subtitle={(d) => `As of ${fmtDate(d.asOf)}`}
      columns={[
        { header: entityLabel, cell: (r) => <span className="font-medium">{r.entityName}</span>, csv: (r) => r.entityName },
        { header: 'Document', cell: (r) => r.docNumber, csv: (r) => r.docNumber },
        { header: 'Date', cell: (r) => fmtDate(r.date), csv: (r) => fmtDate(r.date) },
        { header: 'Due Date', cell: (r) => fmtDate(r.dueDate), csv: (r) => fmtDate(r.dueDate) },
        {
          header: 'Days Past Due',
          className: 'text-right tabular-nums',
          cell: (r) => (r.daysPastDue > 0 ? r.daysPastDue : '—'),
          csv: (r) => r.daysPastDue,
        },
        { header: 'Bucket', cell: (r) => BUCKET_LABELS[r.bucket] ?? r.bucket, csv: (r) => BUCKET_LABELS[r.bucket] ?? r.bucket },
        {
          header: 'Open Balance',
          className: 'text-right tabular-nums',
          cell: (r) => <span className="font-semibold">{formatCurrency(r.openBalance)}</span>,
          csv: (r) => r.openBalance,
        },
      ]}
      footerRows={(d) => [
        ...Object.entries(BUCKET_LABELS).map(([key, label]) => ({
          cells: [`Total ${label}`, '', '', '', '', '', d.bucketTotals[key] !== undefined ? formatCurrency(d.bucketTotals[key]) : ''] as CsvCell[],
        })),
        { cells: ['TOTAL', '', '', '', '', '', formatCurrency(d.total)] as CsvCell[], emphasized: true },
      ]}
    />
  );
}
