'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { Button, Card, PageHeader, Table, Th, Td, Tr, Badge, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency, Money, toAmountString } from '@/lib/money';
import type { ConsolidatedPL, ConsolidatedBS } from '@/lib/services/consolidation';

// ---------------------------------------------------------------------------
// Types (mirrored from service layer; avoid direct server import in client)
// ---------------------------------------------------------------------------

type ReportType = 'pl' | 'bs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SectionHeader({ label, colSpan }: { label: string; colSpan: number }) {
  return (
    <tr className="bg-navy/5">
      <td className="py-2 px-3 font-bold text-navy" colSpan={colSpan}>
        {label}
      </td>
    </tr>
  );
}

function TotalRow({
  label,
  values,
  className = '',
}: {
  label: string;
  values: string[];
  className?: string;
}) {
  return (
    <tr className={`border-t border-navy/20 font-semibold text-navy/80 ${className}`}>
      <td className="py-2 px-3">{label}</td>
      {values.map((v, i) => (
        <td key={i} className="py-2 px-3 text-right tabular-nums">
          {formatCurrency(v)}
        </td>
      ))}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// P&L table
// ---------------------------------------------------------------------------

function PLTable({ data }: { data: ConsolidatedPL }) {
  const { companies, consolidated } = data;
  const colSpan = companies.length + 2; // label + one per company + consolidated

  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th className="min-w-[160px]">Account</Th>
            {companies.map((c) => (
              <Th key={c.companyId} className="text-right min-w-[140px]">
                {c.companyName}
              </Th>
            ))}
            <Th className="text-right min-w-[140px] bg-navy/5">Consolidated</Th>
          </tr>
        </thead>
        <tbody>
          {/* ---- Income ---- */}
          <SectionHeader label="Income" colSpan={colSpan} />
          {companies.some((c) => c.report.income.length > 0) ? (
            // Collect all unique account codes across all companies.
            Array.from(
              new Map(
                companies.flatMap((c) => c.report.income.map((l) => [l.code, l.name])),
              ).entries(),
            )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, name]) => (
                <Tr key={code}>
                  <Td className="pl-8 text-navy">
                    <span className="text-navy/40 text-xs mr-2">{code}</span>
                    {name}
                  </Td>
                  {companies.map((c) => {
                    const line = c.report.income.find((l) => l.code === code);
                    return (
                      <Td key={c.companyId} className="text-right tabular-nums text-navy">
                        {line ? formatCurrency(line.amount) : '-'}
                      </Td>
                    );
                  })}
                  <Td className="text-right tabular-nums text-navy bg-navy/5">
                    {formatCurrency(
                      Money.add(
                        ...companies.map((c) => c.report.income.find((l) => l.code === code)?.amount),
                      ),
                    )}
                  </Td>
                </Tr>
              ))
          ) : (
            <Tr>
              <Td className="pl-8 text-navy/40 italic" colSpan={colSpan}>
                No income accounts with activity
              </Td>
            </Tr>
          )}
          <TotalRow
            label="Total Income"
            values={[...companies.map((c) => c.report.totalIncome), consolidated.totalIncome]}
          />

          {/* ---- Spacer ---- */}
          <tr>
            <td className="py-1" colSpan={colSpan} />
          </tr>

          {/* ---- Expenses ---- */}
          <SectionHeader label="Expenses" colSpan={colSpan} />
          {companies.some((c) => c.report.expenses.length > 0) ? (
            Array.from(
              new Map(
                companies.flatMap((c) => c.report.expenses.map((l) => [l.code, l.name])),
              ).entries(),
            )
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, name]) => (
                <Tr key={code}>
                  <Td className="pl-8 text-navy">
                    <span className="text-navy/40 text-xs mr-2">{code}</span>
                    {name}
                  </Td>
                  {companies.map((c) => {
                    const line = c.report.expenses.find((l) => l.code === code);
                    return (
                      <Td key={c.companyId} className="text-right tabular-nums text-navy">
                        {line ? formatCurrency(line.amount) : '-'}
                      </Td>
                    );
                  })}
                  <Td className="text-right tabular-nums text-navy bg-navy/5">
                    {formatCurrency(
                      Money.add(
                        ...companies.map((c) => c.report.expenses.find((l) => l.code === code)?.amount),
                      ),
                    )}
                  </Td>
                </Tr>
              ))
          ) : (
            <Tr>
              <Td className="pl-8 text-navy/40 italic" colSpan={colSpan}>
                No expense accounts with activity
              </Td>
            </Tr>
          )}
          <TotalRow
            label="Total Expenses"
            values={[...companies.map((c) => c.report.totalExpenses), consolidated.totalExpenses]}
          />
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy/30 text-base font-extrabold">
            <td className="py-3 px-3 text-navy">Net Income</td>
            {companies.map((c) => {
              const net = parseFloat(c.report.netIncome);
              return (
                <td
                  key={c.companyId}
                  className={`py-3 px-3 text-right tabular-nums ${
                    net >= 0 ? 'text-emerald' : 'text-red-600'
                  }`}
                >
                  {formatCurrency(c.report.netIncome)}
                </td>
              );
            })}
            <td
              className={`py-3 px-3 text-right tabular-nums bg-navy/5 ${
                parseFloat(consolidated.netIncome) >= 0 ? 'text-emerald' : 'text-red-600'
              }`}
            >
              {formatCurrency(consolidated.netIncome)}
            </td>
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Balance Sheet table
// ---------------------------------------------------------------------------

function BSSection({
  label,
  companies,
  consolidated,
  getLines,
  getTotal,
  colSpan,
}: {
  label: string;
  companies: ConsolidatedBS['companies'];
  consolidated: ConsolidatedBS['consolidated'];
  getLines: (r: ConsolidatedBS['companies'][0]['report']) => { code: string; name: string; amount: string }[];
  getTotal: (r: ConsolidatedBS['consolidated']) => string;
  colSpan: number;
}) {
  const allCodes = Array.from(
    new Map(
      companies.flatMap((c) => getLines(c.report).map((l) => [l.code, l.name])),
    ).entries(),
  ).sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <SectionHeader label={label} colSpan={colSpan} />
      {allCodes.length === 0 ? (
        <Tr>
          <Td className="pl-8 text-navy/40 italic" colSpan={colSpan}>
            No accounts with activity
          </Td>
        </Tr>
      ) : (
        allCodes.map(([code, name]) => (
          <Tr key={code}>
            <Td className="pl-8 text-navy">
              <span className="text-navy/40 text-xs mr-2">{code}</span>
              {name}
            </Td>
            {companies.map((c) => {
              const line = getLines(c.report).find((l) => l.code === code);
              return (
                <Td key={c.companyId} className="text-right tabular-nums text-navy">
                  {line ? formatCurrency(line.amount) : '-'}
                </Td>
              );
            })}
            <Td className="text-right tabular-nums text-navy bg-navy/5">
              {formatCurrency(
                Money.add(
                  ...companies.map((c) => getLines(c.report).find((l) => l.code === code)?.amount),
                ),
              )}
            </Td>
          </Tr>
        ))
      )}
      <TotalRow
        label={`Total ${label}`}
        values={[
          ...companies.map((c) =>
            toAmountString(Money.add(...getLines(c.report).map((l) => l.amount))),
          ),
          getTotal(consolidated),
        ]}
      />
    </>
  );
}

function BSTable({ data }: { data: ConsolidatedBS }) {
  const { companies, consolidated } = data;
  const colSpan = companies.length + 2;

  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th className="min-w-[160px]">Account</Th>
            {companies.map((c) => (
              <Th key={c.companyId} className="text-right min-w-[140px]">
                {c.companyName}
              </Th>
            ))}
            <Th className="text-right min-w-[140px] bg-navy/5">Consolidated</Th>
          </tr>
        </thead>
        <tbody>
          <BSSection
            label="Assets"
            companies={companies}
            consolidated={consolidated}
            getLines={(r) => r.assets}
            getTotal={(r) => r.totalAssets}
            colSpan={colSpan}
          />
          <tr>
            <td className="py-1" colSpan={colSpan} />
          </tr>
          <BSSection
            label="Liabilities"
            companies={companies}
            consolidated={consolidated}
            getLines={(r) => r.liabilities}
            getTotal={(r) => r.totalLiabilities}
            colSpan={colSpan}
          />
          <tr>
            <td className="py-1" colSpan={colSpan} />
          </tr>
          <BSSection
            label="Equity"
            companies={companies}
            consolidated={consolidated}
            getLines={(r) => r.equity}
            getTotal={(r) => r.totalEquity}
            colSpan={colSpan}
          />
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy/30 text-sm font-bold text-navy/70">
            <td className="py-2 px-3">Retained Earnings (net income)</td>
            {companies.map((c) => (
              <td key={c.companyId} className="py-2 px-3 text-right tabular-nums">
                {formatCurrency(c.report.retainedEarnings)}
              </td>
            ))}
            <td className="py-2 px-3 text-right tabular-nums bg-navy/5">
              {formatCurrency(consolidated.retainedEarnings)}
            </td>
          </tr>
          <tr className="border-t-2 border-navy/30 text-base font-extrabold">
            <td className="py-3 px-3 text-navy">Total Equity (incl. retained earnings)</td>
            {companies.map((c) => (
              <td key={c.companyId} className="py-3 px-3 text-right tabular-nums text-navy">
                {formatCurrency(c.report.totalEquity)}
              </td>
            ))}
            <td className="py-3 px-3 text-right tabular-nums text-navy bg-navy/5">
              {formatCurrency(consolidated.totalEquity)}
            </td>
          </tr>
          <tr className="border-t border-navy/20 font-semibold text-navy/80">
            <td className="py-2 px-3 text-navy">Balanced?</td>
            {companies.map((c) => (
              <td key={c.companyId} className="py-2 px-3 text-right">
                {c.report.balanced ? (
                  <Badge tone="success">Yes</Badge>
                ) : (
                  <Badge tone="danger">No</Badge>
                )}
              </td>
            ))}
            <td className="py-2 px-3 text-right bg-navy/5">
              {consolidated.balanced ? (
                <Badge tone="success">Yes</Badge>
              ) : (
                <Badge tone="danger">No</Badge>
              )}
            </td>
          </tr>
        </tfoot>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ConsolidatedReportPage() {
  const [reportType, setReportType] = useState<ReportType>('pl');
  const [plData, setPlData] = useState<ConsolidatedPL | null>(null);
  const [bsData, setBsData] = useState<ConsolidatedBS | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchReport = useCallback(
    async (type: ReportType) => {
      setLoading(true);
      try {
        if (type === 'pl') {
          const data = await api.get<ConsolidatedPL>('/api/reports/consolidated?type=pl');
          setPlData(data);
        } else {
          const data = await api.get<ConsolidatedBS>('/api/reports/consolidated?type=bs');
          setBsData(data);
        }
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load report', 'danger');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchReport(reportType);
  }, [reportType, fetchReport]);

  const companyCount =
    reportType === 'pl' ? (plData?.companies.length ?? 0) : (bsData?.companies.length ?? 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <nav aria-label="More combined reports" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm print-hidden">
        <span className="text-navy/50">More combined reports:</span>
        <Link className="text-electric hover:underline" href="/reports/std/combined-trial-balance">Trial Balance</Link>
        <Link className="text-electric hover:underline" href="/reports/std/combined-cash-flow">Cash Flow</Link>
        <Link className="text-electric hover:underline" href="/reports/std/combined-pl-by-month">P&amp;L by Month</Link>
        <Link className="text-electric hover:underline" href="/reports/std/combined-ar-aging">A/R Aging</Link>
        <Link className="text-electric hover:underline" href="/reports/std/combined-ap-aging">A/P Aging</Link>
      </nav>
      <PageHeader
        title="Consolidated Reports"
        icon={Building2}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant={reportType === 'pl' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setReportType('pl')}
            >
              Profit &amp; Loss
            </Button>
            <Button
              variant={reportType === 'bs' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setReportType('bs')}
            >
              Balance Sheet
            </Button>
          </div>
        }
      />

      {/* Subtitle */}
      <p className="text-navy/50 text-sm mb-6">
        Multi-entity view across{' '}
        <span className="font-semibold text-navy/70">{companyCount}</span>{' '}
        {companyCount === 1 ? 'company' : 'companies'}. The last column shows the arithmetic
        consolidated total.
      </p>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-navy/40 text-sm">Loading report...</div>
        ) : reportType === 'pl' && plData ? (
          plData.companies.length === 0 ? (
            <div className="p-12 text-center">
              <Building2 className="mx-auto h-10 w-10 text-navy/20 mb-3" />
              <p className="text-navy/50 text-sm">No companies found in the database.</p>
            </div>
          ) : (
            <PLTable data={plData} />
          )
        ) : reportType === 'bs' && bsData ? (
          bsData.companies.length === 0 ? (
            <div className="p-12 text-center">
              <Building2 className="mx-auto h-10 w-10 text-navy/20 mb-3" />
              <p className="text-navy/50 text-sm">No companies found in the database.</p>
            </div>
          ) : (
            <BSTable data={bsData} />
          )
        ) : null}
      </Card>
    </main>
  );
}
