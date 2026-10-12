import Link from 'next/link';
import { Percent } from 'lucide-react';
import { Badge, Button, Card, Input, Label, PageHeader, Select, Table, Td, Th, Tr } from '@/components/ui';
import { Help } from '@/components/Help';
import { getPageContext } from '@/lib/context';
import { formatCurrency } from '@/lib/money';
import { salesTaxLiabilityReport, salesTaxRevenueSummary } from '@/lib/services/accountant/salesTaxLedger';
import ReportToolbar, { type ExportTable } from '../_components/ReportToolbar';

export const dynamic = 'force-dynamic';

function day(v: string | undefined, end: boolean): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  return new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

function monthStart(): string {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export default async function SalesTaxReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; basis?: string; view?: string }>;
}) {
  const ctx = await getPageContext('/reports/sales-tax');
  const p = await searchParams;
  const fromStr = p.from && /^\d{4}-\d{2}-\d{2}$/.test(p.from) ? p.from : monthStart();
  const toStr = p.to && /^\d{4}-\d{2}-\d{2}$/.test(p.to) ? p.to : new Date().toISOString().slice(0, 10);
  const basis = p.basis === 'cash' ? 'cash' : 'accrual';
  const view = p.view === 'revenue' ? 'revenue' : 'liability';
  const range = { from: day(fromStr, false), to: day(toStr, true) };

  const liability = view === 'liability' ? await salesTaxLiabilityReport(ctx, { ...range, basis }) : null;
  const revenue = view === 'revenue' ? await salesTaxRevenueSummary(ctx, range) : null;

  const exportTable: ExportTable = liability
    ? {
        filename: 'sales-tax-liability',
        title: 'Sales Tax Liability',
        subtitle: `${fromStr} to ${toStr} (${basis} basis)`,
        columns: [
          { header: 'Agency' },
          { header: 'Owed at start', numeric: true },
          { header: 'Tax collected', numeric: true },
          { header: 'Tax credited', numeric: true },
          { header: 'Adjustments', numeric: true },
          { header: 'Paid', numeric: true },
          { header: 'Owed at end', numeric: true },
        ],
        rows: liability.agencies.map((a) => [
          a.agencyName ?? 'Not assigned to an agency',
          a.openingBalance,
          a.collected,
          a.credited,
          toNum(a.adjustments, a.unattributed),
          a.paid,
          a.balance,
        ]),
        totals: [[
          'Total',
          liability.totals.openingBalance,
          liability.totals.collected,
          liability.totals.credited,
          toNum(liability.totals.adjustments, liability.totals.unattributed),
          liability.totals.paid,
          liability.totals.balance,
        ]],
      }
    : {
        filename: 'sales-tax-revenue-summary',
        title: 'Sales Tax Revenue Summary',
        subtitle: `${fromStr} to ${toStr}`,
        columns: [
          { header: 'Tax rate' },
          { header: 'Total sales', numeric: true },
          { header: 'Non-taxable sales', numeric: true },
          { header: 'Taxable sales', numeric: true },
          { header: 'Tax collected', numeric: true },
        ],
        rows: (revenue?.rows ?? []).map((r) => [r.taxRateName, r.totalSales, r.nonTaxableSales, r.taxableSales, r.taxCollected]),
        totals: revenue
          ? [['Total', revenue.totals.totalSales, revenue.totals.nonTaxableSales, revenue.totals.taxableSales, revenue.totals.taxCollected]]
          : [],
      };

  const qs = (over: Record<string, string>) =>
    '?' + new URLSearchParams({ from: fromStr, to: toStr, basis, view, ...over }).toString();

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <div className="max-w-6xl">
        <PageHeader
          title={view === 'liability' ? 'Sales Tax Liability' : 'Sales Tax Revenue Summary'}
          iconNode={<Percent className="text-electric h-8 w-8" />}
          action={
            liability && liability.basis === 'accrual' ? (
              <Badge tone={liability.tiesToGl ? 'success' : 'danger'}>
                {liability.tiesToGl ? 'Matches Sales Tax Payable' : 'Does NOT match the books'}
              </Badge>
            ) : undefined
          }
        />
        <div className="mb-4 flex gap-2 print-hidden">
          <Link href={qs({ view: 'liability' })}>
            <Button variant={view === 'liability' ? 'primary' : 'secondary'} size="sm">Liability</Button>
          </Link>
          <Link href={qs({ view: 'revenue' })}>
            <Button variant={view === 'revenue' ? 'primary' : 'secondary'} size="sm">Revenue summary</Button>
          </Link>
        </div>
        <ReportToolbar table={exportTable} />

        <Card className="mb-6 print-hidden">
          <form method="get" className="flex items-end gap-3 flex-wrap p-4">
            <input type="hidden" name="view" value={view} />
            <div>
              <Label htmlFor="st-from">From</Label>
              <Input id="st-from" type="date" name="from" defaultValue={fromStr} />
            </div>
            <div>
              <Label htmlFor="st-to">To</Label>
              <Input id="st-to" type="date" name="to" defaultValue={toStr} />
            </div>
            {view === 'liability' && (
              <div>
                <Label htmlFor="st-basis">
                  Basis <Help term="accrual-vs-cash" />
                </Label>
                <Select id="st-basis" name="basis" defaultValue={basis}>
                  <option value="accrual">Accrual (when invoiced)</option>
                  <option value="cash">Cash (when paid)</option>
                </Select>
              </div>
            )}
            <Button type="submit" variant="secondary" size="sm" className="mb-0.5">Run Report</Button>
          </form>
        </Card>

        {liability && (
          <Card className="p-6">
            <p className="mb-4 text-sm text-navy/60">
              What you owe each tax agency <Help term="sales-tax" />. “Owed at end” on the accrual basis always equals the
              Sales Tax Payable balance in your books ({formatCurrency(liability.glBalance)} as of {toStr}).
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Agency / tax</Th>
                  <Th numeric>Owed at start</Th>
                  <Th numeric>Tax collected</Th>
                  <Th numeric>Tax credited</Th>
                  <Th numeric>Adjustments</Th>
                  <Th numeric>Paid</Th>
                  <Th numeric>Owed at end</Th>
                </tr>
              </thead>
              <tbody>
                {liability.agencies.length === 0 && (
                  <tr>
                    <Td colSpan={7} className="py-8 text-center text-navy/40">No sales tax activity.</Td>
                  </tr>
                )}
                {liability.agencies.map((a) => (
                  <AgencyRows key={a.agencyId ?? 'none'} a={a} />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy/20 font-bold text-navy">
                  <td className="py-3 px-4">Total</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(liability.totals.openingBalance)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(liability.totals.collected)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(liability.totals.credited)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(toNum(liability.totals.adjustments, liability.totals.unattributed))}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(liability.totals.paid)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(liability.totals.balance)}</td>
                </tr>
              </tfoot>
            </Table>
            {Number(liability.totals.unattributed) !== 0 && (
              <p className="mt-4 text-sm text-yellow-800">
                Some sales tax was recorded outside the sales tax screens.{' '}
                <Link href="/accountant/fix-sales-tax" className="text-electric hover:underline">Fix incorrectly recorded sales tax</Link>
              </p>
            )}
            <div className="mt-4 flex gap-4 text-sm print-hidden">
              <Link href="/pay-liabilities" className="text-electric hover:underline">Pay sales tax</Link>
              <Link href="/accountant/sales-tax-adjustment" className="text-electric hover:underline">Adjust sales tax due</Link>
            </div>
          </Card>
        )}

        {revenue && (
          <Card className="p-6">
            <p className="mb-4 text-sm text-navy/60">
              Sales per tax rate, split into taxable and non-taxable. Credit memos reduce sales; voided sales are left out.
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Tax rate</Th>
                  <Th numeric>Total sales</Th>
                  <Th numeric>Non-taxable sales</Th>
                  <Th numeric>Taxable sales</Th>
                  <Th numeric>Tax collected</Th>
                </tr>
              </thead>
              <tbody>
                {revenue.rows.length === 0 && (
                  <tr>
                    <Td colSpan={5} className="py-8 text-center text-navy/40">No sales in this period.</Td>
                  </tr>
                )}
                {revenue.rows.map((r) => (
                  <Tr key={r.taxRateId ?? 'none'}>
                    <Td>
                      {r.taxRateName}
                      {r.taxRateId && <span className="ml-2 text-xs text-navy/50">{(Number(r.rate) * 100).toFixed(3).replace(/\.?0+$/, '')}%</span>}
                    </Td>
                    <Td numeric>{formatCurrency(r.totalSales)}</Td>
                    <Td numeric>{formatCurrency(r.nonTaxableSales)}</Td>
                    <Td numeric>{formatCurrency(r.taxableSales)}</Td>
                    <Td numeric>{formatCurrency(r.taxCollected)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy/20 font-bold text-navy">
                  <td className="py-3 px-4">Total</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(revenue.totals.totalSales)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(revenue.totals.nonTaxableSales)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(revenue.totals.taxableSales)}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(revenue.totals.taxCollected)}</td>
                </tr>
              </tfoot>
            </Table>
          </Card>
        )}
      </div>
    </main>
  );
}

function toNum(a: string, b: string): string {
  return (Math.round(Number(a) * 100 + Number(b) * 100) / 100).toFixed(2);
}

function AgencyRows({ a }: { a: Awaited<ReturnType<typeof salesTaxLiabilityReport>>['agencies'][number] }) {
  return (
    <>
      <Tr className="font-semibold">
        <Td>{a.agencyName ?? 'Not assigned to an agency'}</Td>
        <Td numeric>{formatCurrency(a.openingBalance)}</Td>
        <Td numeric>{formatCurrency(a.collected)}</Td>
        <Td numeric>{formatCurrency(a.credited)}</Td>
        <Td numeric>{formatCurrency(toNum(a.adjustments, a.unattributed))}</Td>
        <Td numeric>{formatCurrency(a.paid)}</Td>
        <Td numeric>{formatCurrency(a.balance)}</Td>
      </Tr>
      {a.components.map((c) => (
        <tr key={`${a.agencyId}-${c.taxRateId}-${c.componentName}`} className="text-sm text-navy/60">
          <td className="py-1.5 px-4 pl-10">{c.componentName}</td>
          <td />
          <td className="py-1.5 px-4 text-right tabular-nums">{formatCurrency(c.collected)}</td>
          <td className="py-1.5 px-4 text-right tabular-nums">{formatCurrency(c.credited)}</td>
          <td colSpan={3} />
        </tr>
      ))}
    </>
  );
}
