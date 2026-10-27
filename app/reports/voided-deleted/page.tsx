import { Fragment } from 'react';
import Link from 'next/link';
import { Ban } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Table, Td, Th, Tr } from '@/components/ui';
import { getPageContext } from '@/lib/context';
import { formatCurrency } from '@/lib/money';
import { voidedDeletedTransactions } from '@/lib/services/accountant/auditReports';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';

export const dynamic = 'force-dynamic';

/** A typed day; the report reads it in the company's time zone. */
function day(v: string | undefined): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

function summarize(original: unknown): string {
  if (!original || typeof original !== 'object') return '';
  const o = original as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    if (['id', 'companyId', 'createdAt', 'updatedAt'].includes(k)) continue;
    parts.push(`${k}: ${String(v)}`);
    if (parts.length >= 8) break;
  }
  const lines = Array.isArray(o.lines) ? ` · ${o.lines.length} line(s)` : '';
  return parts.join(' · ') + lines;
}

export default async function VoidedDeletedPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; detail?: string }>;
}) {
  const ctx = await getPageContext('/reports/voided-deleted');
  const p = await searchParams;
  const detail = p.detail === '1';
  const { rows } = await voidedDeletedTransactions(ctx, { from: day(p.from), to: day(p.to), detail });

  const exportTable: ExportTable = {
    filename: detail ? 'voided-deleted-detail' : 'voided-deleted-summary',
    title: `Voided/Deleted Transactions ${detail ? 'Detail' : 'Summary'}`,
    columns: [
      { header: 'Action' },
      { header: 'When' },
      { header: 'User' },
      { header: 'Type' },
      { header: 'Num' },
      { header: 'Date' },
      { header: 'Name / description' },
      { header: 'Amount', numeric: true },
      ...(detail ? [{ header: 'Original values' }] : []),
    ],
    rows: rows.map((r) => [
      r.action === 'void' ? 'Voided' : 'Deleted',
      r.at.slice(0, 16).replace('T', ' '),
      r.user ?? '',
      r.typeLabel,
      r.number ?? '',
      r.transactionDate ? r.transactionDate.slice(0, 10) : '',
      r.name ?? '',
      r.amount ?? '',
      ...(detail ? [summarize(r.original)] : []),
    ]),
  };
  const qs = (d: boolean) => '?' + new URLSearchParams({ ...(p.from ? { from: p.from } : {}), ...(p.to ? { to: p.to } : {}), ...(d ? { detail: '1' } : {}) }).toString();

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <div className="max-w-6xl">
        <PageHeader
          title={`Voided/Deleted Transactions ${detail ? 'Detail' : 'Summary'}`}
          iconNode={<Ban className="text-electric h-8 w-8" />}
        />
        <div className="mb-4 flex gap-2 print-hidden">
          <Link href={qs(false)}><Button size="sm" variant={detail ? 'secondary' : 'primary'}>Summary</Button></Link>
          <Link href={qs(true)}><Button size="sm" variant={detail ? 'primary' : 'secondary'}>Detail</Button></Link>
        </div>
        <ReportToolbar table={exportTable} />
        <Card className="mb-6 print-hidden">
          <form method="get" className="flex items-end gap-3 flex-wrap p-4">
            {detail && <input type="hidden" name="detail" value="1" />}
            <div>
              <Label htmlFor="vd-from">Voided/deleted from</Label>
              <Input id="vd-from" type="date" name="from" defaultValue={p.from ?? ''} />
            </div>
            <div>
              <Label htmlFor="vd-to">to</Label>
              <Input id="vd-to" type="date" name="to" defaultValue={p.to ?? ''} />
            </div>
            <Button type="submit" variant="secondary" size="sm" className="mb-0.5">Run Report</Button>
          </form>
        </Card>
        <Card className="p-6">
          <Table>
            <thead>
              <tr>
                <Th>Action</Th>
                <Th>When</Th>
                <Th>User</Th>
                <Th>Type</Th>
                <Th>Num</Th>
                <Th>Date</Th>
                <Th>Name / description</Th>
                <Th numeric>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <Td colSpan={8} className="py-8 text-center text-navy/40">No transactions were voided or deleted in this period.</Td>
                </tr>
              )}
              {rows.map((r) => (
                <Fragment key={r.auditLogId}>
                  <Tr>
                    <Td><Badge tone={r.action === 'void' ? 'warning' : 'danger'}>{r.action === 'void' ? 'Voided' : 'Deleted'}</Badge></Td>
                    <Td className="whitespace-nowrap">{r.at.slice(0, 16).replace('T', ' ')}</Td>
                    <Td>{r.user ?? '—'}</Td>
                    <Td>{r.typeLabel}</Td>
                    <Td>{r.number ?? ''}</Td>
                    <Td>{r.transactionDate ? r.transactionDate.slice(0, 10) : ''}</Td>
                    <Td>{r.name ?? ''}</Td>
                    <Td numeric>{r.amount ? formatCurrency(r.amount) : ''}</Td>
                  </Tr>
                  {detail && (
                    <tr>
                      <td colSpan={8} className="px-8 pb-3 text-xs text-navy/50 border-b border-slate-100">
                        {summarize(r.original) || 'No original values were recorded.'}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </main>
  );
}
