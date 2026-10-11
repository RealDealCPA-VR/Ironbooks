import Link from 'next/link';
import { BookOpen } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Table, Td, Th, Tr } from '@/components/ui';
import { getPageContext } from '@/lib/context';
import { trialBalance } from '@/lib/services/reports';
import { formatCurrency } from '@/lib/money';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';

export const dynamic = 'force-dynamic';

function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseParamDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  // Parse as local midnight so the rendered date matches what the user picked
  // regardless of the server's UTC offset.
  const d = new Date(`${v}T00:00:00`);
  return isNaN(d.getTime()) ? undefined : d;
}

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const ctx = await getPageContext('/reports/trial-balance');
  const params = await searchParams;
  const asOf = parseParamDate(params.asOf) ?? new Date();
  const asOfStr = toInputDate(asOf);
  // Drill into the register up to the as-of date.
  const asOfQs = `?to=${asOfStr}`;

  const tb = await trialBalance(ctx, asOf);

  const exportTable: ExportTable = {
    filename: 'trial-balance',
    title: 'Trial Balance',
    subtitle: `As of ${asOf.toLocaleDateString('en-US')}`,
    columns: [
      { header: 'Code' },
      { header: 'Account' },
      { header: 'Debit', numeric: true },
      { header: 'Credit', numeric: true },
    ],
    rows: tb.rows.map((r) => [r.code, r.name, r.debit, r.credit]),
    totals: [['', 'Total', tb.totalDebit, tb.totalCredit]],
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <div className="max-w-3xl">
        <PageHeader
          title="Trial Balance"
          iconNode={<BookOpen className="text-electric h-8 w-8" />}
          action={
            <div className="flex items-center gap-3">
              <span className="text-sm text-navy/50">
                as of {asOf.toLocaleDateString('en-US')}
              </span>
              <Badge tone={tb.balanced ? 'success' : 'danger'}>
                {tb.balanced ? 'In balance' : 'OUT OF BALANCE'}
              </Badge>
            </div>
          }
        />
      </div>

      <div className="max-w-3xl">
        <ReportToolbar table={exportTable} />
      </div>

      {/* As-of date picker (plain GET form — server-rendered page) */}
      <Card className="mb-6 max-w-3xl print-hidden">
        <form method="get" className="flex items-end gap-3 flex-wrap p-4">
          <div>
            <Label htmlFor="tb-asof">As of</Label>
            <Input id="tb-asof" type="date" name="asOf" defaultValue={asOfStr} />
          </div>
          <Button type="submit" variant="secondary" size="sm" className="mb-0.5">
            Run Report
          </Button>
        </form>
      </Card>

      <Card className="p-6 max-w-3xl">
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Account</Th>
              <Th numeric>Debit</Th>
              <Th numeric>Credit</Th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.length === 0 && (
              <tr>
                <Td colSpan={4} className="py-8 text-center text-navy/40">
                  No posted transactions yet.
                </Td>
              </tr>
            )}
            {tb.rows.map((r) => (
              <Tr key={r.accountId}>
                {/* QuickZoom: drill from the trial-balance line into the account register */}
                <Td className="text-navy/60 tabular-nums">
                  <Link href={`/registers/${r.accountId}${asOfQs}`} className="hover:text-electric hover:underline">
                    {r.code}
                  </Link>
                </Td>
                <Td>
                  <Link
                    href={`/registers/${r.accountId}${asOfQs}`}
                    className="text-navy hover:text-electric hover:underline"
                    title={`Open ${r.name} register`}
                  >
                    {r.name}
                  </Link>
                </Td>
                <Td numeric>
                  {Number(r.debit) ? (
                    <Link
                      href={`/registers/${r.accountId}${asOfQs}`}
                      className="text-navy hover:text-electric hover:underline"
                      title={`Open ${r.name} register`}
                    >
                      {formatCurrency(r.debit)}
                    </Link>
                  ) : (
                    ''
                  )}
                </Td>
                <Td numeric>
                  {Number(r.credit) ? (
                    <Link
                      href={`/registers/${r.accountId}${asOfQs}`}
                      className="text-navy hover:text-electric hover:underline"
                      title={`Open ${r.name} register`}
                    >
                      {formatCurrency(r.credit)}
                    </Link>
                  ) : (
                    ''
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy/20 font-bold text-navy">
              <td className="py-3 px-4" colSpan={2}>
                Total
              </td>
              <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(tb.totalDebit)}</td>
              <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(tb.totalCredit)}</td>
            </tr>
          </tfoot>
        </Table>
      </Card>
    </main>
  );
}
