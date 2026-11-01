import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Table, Td, Th, Tr } from '@/components/ui';
import { Help } from '@/components/Help';
import { getPageContext } from '@/lib/context';
import { formatCurrency } from '@/lib/money';
import { closingDateExceptionReport } from '@/lib/services/accountant/auditReports';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';
// The change's own day and time on the company's calendar and clock (they were UTC): the same
// time zone the report service reads the From / To days in (Preferences).
import { localDateTime } from '@/lib/reports/dates';
import { getPreferences } from '@/lib/services/preferences';

export const dynamic = 'force-dynamic';

const OP_LABEL: Record<string, string> = { post: 'Added', void: 'Voided', reclassify: 'Reclassified' };

/** A typed day; the report reads it in the company's time zone. */
function day(v: string | undefined): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

export default async function ClosingDateExceptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await getPageContext('/reports/closing-date-exceptions');
  const p = await searchParams;
  const { timezone } = await getPreferences(ctx);
  const report = await closingDateExceptionReport(ctx, { from: day(p.from), to: day(p.to) });

  // QB layout: each changed transaction once, its Latest values, then each Prior version changed
  // in the closed period (lib/services/accountant/auditReports.ts exceptionGroups).
  const changeText = (c: { operation: string; source: string }) =>
    c.source === 'override' ? `${OP_LABEL[c.operation] ?? c.operation} with password` : 'Entered after close';
  const exportRows: Array<Array<string | number>> = [];
  for (const g of report.groups) {
    const versions = [...(g.latest ? [g.latest] : []), ...g.prior];
    if (!g.latest) {
      exportRows.push([localDateTime(g.lastChangedAt, timezone), g.changes[0]?.user ?? '', `${g.typeLabel}: ${g.changes.map(changeText).join(', ')}`, 'Latest', '', g.transactionDate, 'Void', '', '', '', '']);
    }
    for (const v of versions) {
      for (const l of v.lines) {
        exportRows.push([
          localDateTime(v.at, timezone),
          v.user ?? '',
          `${g.typeLabel}: ${g.changes.map(changeText).join(', ')}`,
          v.state === 'latest' ? 'Latest' : 'Prior',
          v.entryNumber ?? '',
          v.date,
          l.account,
          l.name ?? '',
          l.memo ?? v.description ?? '',
          l.debit ?? '',
          l.credit ?? '',
        ]);
      }
    }
  }
  const exportTable: ExportTable = {
    filename: 'closing-date-exceptions',
    title: 'Closing Date Exception Report',
    subtitle: report.closingDate ? `Closing date ${report.closingDate}` : 'No closing date set',
    columns: [
      { header: 'Entered / last modified' },
      { header: 'User' },
      { header: 'Transaction' },
      { header: 'State' },
      { header: 'Entry #' },
      { header: 'Date' },
      { header: 'Account' },
      { header: 'Name' },
      { header: 'Memo' },
      { header: 'Debit', numeric: true },
      { header: 'Credit', numeric: true },
    ],
    rows: exportRows,
  };

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
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
            closing-date password, and entries in the closed period that were added after the books were closed. Each
            transaction shows its latest values and, under them, the prior values it had before each change.
          </p>
          <Table>
            <thead>
              <tr>
                <Th>State</Th>
                <Th>Entered / changed</Th>
                <Th>User</Th>
                <Th>Entry</Th>
                <Th>Date</Th>
                <Th>Account</Th>
                <Th>Name</Th>
                <Th>Memo</Th>
                <Th numeric>Debit</Th>
                <Th numeric>Credit</Th>
              </tr>
            </thead>
            {report.groups.length === 0 && (
              <tbody>
                <tr>
                  <Td colSpan={10} className="py-8 text-center text-navy/40">No changes were made to the closed period.</Td>
                </tr>
              </tbody>
            )}
            {report.groups.map((g) => (
              <tbody key={g.key}>
                <tr className="bg-slate-50">
                  <Td colSpan={10} className="font-semibold">
                    {g.typeLabel} dated {g.transactionDate}{' '}
                    {g.changes.map((c, i) => (
                      <Badge key={i} tone={c.source === 'override' ? 'warning' : 'danger'} className="ml-1">
                        {changeText(c)}
                      </Badge>
                    ))}
                    {g.closingDate && <span className="ml-2 text-xs font-normal text-navy/50">closed through {g.closingDate}</span>}
                  </Td>
                </tr>
                {!g.latest && (
                  <Tr>
                    <Td><Badge tone="void">Latest</Badge></Td>
                    <Td colSpan={9} className="text-navy/60">Void now: the prior values below are what it was before.</Td>
                  </Tr>
                )}
                {[...(g.latest ? [g.latest] : []), ...g.prior].map((v) =>
                  v.lines.map((l, i) => (
                    <Tr key={`${v.state}-${v.entryId}-${v.at}-${i}`} className={v.state === 'prior' ? 'text-navy/60' : ''}>
                      <Td>{i === 0 ? <Badge tone={v.state === 'latest' ? 'success' : 'neutral'}>{v.state === 'latest' ? 'Latest' : 'Prior'}</Badge> : null}</Td>
                      <Td className="whitespace-nowrap">{i === 0 ? localDateTime(v.at, timezone) : ''}</Td>
                      <Td>{i === 0 ? v.user ?? '—' : ''}</Td>
                      <Td>
                        {i === 0 ? (
                          <Link href={`/journal?focus=${v.entryId}`} className="hover:text-electric hover:underline">
                            {v.entryNumber ? `#${v.entryNumber}` : 'Open'}
                          </Link>
                        ) : null}
                      </Td>
                      <Td>{i === 0 ? v.date : ''}</Td>
                      <Td>{l.account}{l.className ? <span className="text-xs text-navy/50"> · {l.className}</span> : null}</Td>
                      <Td>{l.name ?? ''}</Td>
                      <Td>{l.memo ?? (i === 0 ? v.description ?? '' : '')}</Td>
                      <Td numeric>{l.debit ? formatCurrency(l.debit) : ''}</Td>
                      <Td numeric>{l.credit ? formatCurrency(l.credit) : ''}</Td>
                    </Tr>
                  )),
                )}
              </tbody>
            ))}
          </Table>
        </Card>
      </div>
    </main>
  );
}
