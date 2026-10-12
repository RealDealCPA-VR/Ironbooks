import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Table, Td, Th, Tr } from '@/components/ui';
import { Help } from '@/components/Help';
import { getPageContext } from '@/lib/context';
import { formatCurrency } from '@/lib/money';
import { closingDateExceptionReport } from '@/lib/services/accountant/auditReports';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';

export const dynamic = 'force-dynamic';

const OP_LABEL: Record<string, string> = { post: 'Added', void: 'Voided', reclassify: 'Reclassified' };

function day(v: string | undefined, end: boolean): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

export default async function ClosingDateExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await getPageContext('/reports/closing-date-exceptions');
  const p = await searchParams;
  const report = await closingDateExceptionReport(ctx, { from: day(p.from, false), to: day(p.to, true) });

  const exportTable: ExportTable = {
    filename: 'closing-date-exceptions',
    title: 'Closing Date Exception Report',
    subtitle: report.closingDate ? `Closing date ${report.closingDate}` : 'No closing date set',
    columns: [
      { header: 'Changed on' },
      { header: 'User' },
      { header: 'What happened' },
      { header: 'Entry #' },
      { header: 'Transaction date' },
      { header: 'Description' },
      { header: 'Amount', numeric: true },
    ],
    rows: report.rows.map((r) => [
      r.at.slice(0, 16).replace('T', ' '),
      r.user ?? '',
      r.source === 'override' ? OP_LABEL[r.operation] ?? r.operation : 'Entered after close',
      r.entryNumber ?? '',
      r.transactionDate,
      r.description ?? '',
      r.amount ?? '',
    ]),
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <div className="max-w-6xl">
        <PageHeader
          title="Closing Date Exception Report"
          iconNode={<ShieldAlert className="text-electric h-8 w-8" />}
          action={<Badge tone={report.closingDate ? 'info' : 'neutral'}>{report.closingDate ? `Books closed through ${report.closingDate}` : 'No closing date'}</Badge>}
        />
        <ReportToolbar table={exportTable} />
        <Card className="mb-6 print-hidden">
          <form method="get" className="flex items-end gap-3 flex-wrap p-4">
            <div>
              <Label htmlFor="cde-from">Changed from</Label>
              <Input id="cde-from" type="date" name="from" defaultValue={p.from ?? ''} />
            </div>
            <div>
              <Label htmlFor="cde-to">Changed to</Label>
              <Input id="cde-to" type="date" name="to" defaultValue={p.to ?? ''} />
            </div>
            <Button type="submit" variant="secondary" size="sm" className="mb-0.5">Run Report</Button>
          </form>
        </Card>
        <Card className="p-6">
          <p className="mb-4 text-sm text-navy/60">
            Every change to transactions dated on or before the closing date <Help term="closing-date" />, made with the
            closing-date password, and entries in the closed period that were added after the books were closed.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Changed on</Th>
                <Th>User</Th>
                <Th>What happened</Th>
                <Th>Entry</Th>
                <Th>Transaction date</Th>
                <Th>Description</Th>
                <Th numeric>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {report.rows.length === 0 && (
                <tr>
                  <Td colSpan={7} className="py-8 text-center text-navy/40">No changes were made to the closed period.</Td>
                </tr>
              )}
              {report.rows.map((r) => (
                <Tr key={`${r.auditLogId ?? 'je'}-${r.entryId}`}>
                  <Td className="whitespace-nowrap">{r.at.slice(0, 16).replace('T', ' ')}</Td>
                  <Td>{r.user ?? '—'}</Td>
                  <Td>
                    {r.source === 'override' ? (
                      <Badge tone="warning">{OP_LABEL[r.operation] ?? r.operation} with password</Badge>
                    ) : (
                      <Badge tone="danger">Entered after close</Badge>
                    )}
                  </Td>
                  <Td>
                    <Link href={`/journal?focus=${r.entryId}`} className="hover:text-electric hover:underline">
                      {r.entryNumber ? `#${r.entryNumber}` : 'Open'}
                    </Link>
                  </Td>
                  <Td>{r.transactionDate}</Td>
                  <Td>{r.description ?? ''}</Td>
                  <Td numeric>{r.amount ? formatCurrency(r.amount) : ''}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </main>
  );
}
