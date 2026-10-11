'use client';

/**
 * Payroll reports (QuickBooks parity): Employee Earnings Summary, Payroll Item Detail, Payroll
 * Transactions by Payee, Workers' Comp Summary and the State quarterly wage worksheet.
 * Year-to-date amounts entered at payroll setup are included (shown as "YTD Adjustment").
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, Select, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

type ReportKey = 'earnings-summary' | 'item-detail' | 'transactions-by-payee' | 'workers-comp' | 'state-wage';

const REPORTS: Array<{ key: ReportKey; label: string; help: string }> = [
  { key: 'earnings-summary', label: 'Employee Earnings Summary', help: 'Every payroll item for each employee, side by side.' },
  { key: 'item-detail', label: 'Payroll Item Detail', help: 'Every line of every paycheck, grouped by payroll item.' },
  { key: 'transactions-by-payee', label: 'Payroll Transactions by Payee', help: 'Each paycheck and adjustment, grouped by employee.' },
  { key: 'workers-comp', label: "Workers' Comp Summary", help: 'Wages and premium by class code.' },
  { key: 'state-wage', label: 'State wage worksheet', help: 'Quarterly wages, excess over the unemployment limit, and taxable wages for your state report.' },
];

const money = (v: string | number) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface EarningsSummary {
  employees: Array<{ id: string; name: string }>;
  rows: Array<{ section: string; item: string; amounts: Record<string, string>; total: string }>;
  gross: Record<string, string>;
  net: Record<string, string>;
  totalGross: string;
  totalNet: string;
}
interface ItemDetail {
  groups: Array<{ item: string; kind: string; total: string; lines: Array<{ date: string; type: string; employeeName: string; detail: string; amount: string }> }>;
}
interface ByPayee {
  payees: Array<{ employeeName: string; totalGross: string; totalNet: string; transactions: Array<{ paycheckId: string; date: string; type: string; reference: string; memo: string | null; gross: string; taxes: string; deductions: string; net: string }> }>;
  totalGross: string;
  totalNet: string;
}
interface WcSummary {
  rows: Array<{ code: string; description: string | null; ratePer100: string; wages: string; premium: string; employees: number }>;
  totalWages: string;
  totalPremium: string;
}
interface StateWage {
  state: string;
  quarter: number;
  year: number;
  accountNumber: string | null;
  suiRate: string;
  suiWageBase: string;
  employees: Array<{ employeeName: string; ssnLast4: string | null; quarterWages: string; excessWages: string; taxableWages: string; suiAccrued: string; sdiWithheld: string; stateWithheld: string }>;
  totals: { quarterWages: string; excessWages: string; taxableWages: string; suiAccrued: string; sdiWithheld: string; stateWithheld: string; suiCalculated: string };
}

export default function PayrollReportsPage() {
  const year = new Date().getFullYear();
  const [report, setReport] = useState<ReportKey>('earnings-summary');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [state, setState] = useState('');
  const [quarter, setQuarter] = useState(String(Math.floor(new Date().getMonth() / 3) + 1));
  const [wyear, setWyear] = useState(String(year));
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        report === 'state-wage'
          ? `/api/payroll/state-wage-worksheet?state=${encodeURIComponent(state)}&year=${wyear}&quarter=${quarter}`
          : `/api/payroll/reports?report=${report}&from=${from}&to=${to}`;
      setData(await api.get(url));
    } catch (err) {
      setData(null);
      toast(err instanceof ApiError ? err.message : 'Could not run the report.', 'danger');
    } finally {
      setLoading(false);
    }
  }, [report, from, to, state, wyear, quarter]);

  useEffect(() => {
    if (report !== 'state-wage') void run();
    else setData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  const current = REPORTS.find((r) => r.key === report)!;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Payroll reports" icon={ClipboardList} action={<Button variant="secondary" onClick={() => window.print()}>Print</Button>} />
      <div className="max-w-6xl mx-auto space-y-6">
        <Card className="p-6 space-y-4 print:hidden">
          <div className="grid gap-4 sm:grid-cols-4 items-end">
            <div className="sm:col-span-2">
              <Label htmlFor="rep">Report</Label>
              <Select id="rep" value={report} onChange={(e) => setReport(e.target.value as ReportKey)}>
                {REPORTS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            {report === 'state-wage' ? (
              <>
                <div>
                  <Label htmlFor="st">State</Label>
                  <Input id="st" maxLength={2} value={state} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="CA" />
                </div>
                <div className="flex gap-2">
                  <div>
                    <Label htmlFor="q">Quarter</Label>
                    <Select id="q" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
                      {[1, 2, 3, 4].map((q) => (
                        <option key={q} value={q}>
                          Q{q}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="y">Year</Label>
                    <Input id="y" type="number" value={wyear} onChange={(e) => setWyear(e.target.value)} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div>
                  <Label htmlFor="from">From</Label>
                  <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="to">To</Label>
                  <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={run} loading={loading} disabled={report === 'state-wage' && !/^[A-Z]{2}$/.test(state)}>
              Run report
            </Button>
            <p className="text-sm text-navy/60">{current.help}</p>
          </div>
        </Card>

        {data !== null && (
          <Card className="p-6">
            <h2 className="text-lg font-bold text-navy mb-3">{current.label}</h2>
            {report === 'earnings-summary' && <EarningsSummaryView d={data as EarningsSummary} />}
            {report === 'item-detail' && <ItemDetailView d={data as ItemDetail} />}
            {report === 'transactions-by-payee' && <ByPayeeView d={data as ByPayee} />}
            {report === 'workers-comp' && <WcView d={data as WcSummary} />}
            {report === 'state-wage' && <StateWageView d={data as StateWage} />}
          </Card>
        )}
      </div>
    </main>
  );
}

function EarningsSummaryView({ d }: { d: EarningsSummary }) {
  if (!d.employees.length) return <p className="text-sm text-navy/60">No payroll in this period.</p>;
  let lastSection = '';
  return (
    <Table>
      <thead>
        <tr>
          <Th>Payroll item</Th>
          {d.employees.map((e) => (
            <Th key={e.id} numeric>
              {e.name}
            </Th>
          ))}
          <Th numeric>Total</Th>
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r, i) => {
          const header = r.section !== lastSection;
          lastSection = r.section;
          return (
            <Fragment key={i}>
              {header && (
                <tr>
                  <td colSpan={d.employees.length + 2} className="pt-4 pb-1 px-4 text-xs font-bold uppercase text-navy/50">
                    {r.section}
                  </td>
                </tr>
              )}
              <Tr key={i}>
                <Td>{r.item}</Td>
                {d.employees.map((e) => (
                  <Td key={e.id} numeric>
                    {r.amounts[e.id] ? money(r.amounts[e.id]) : ''}
                  </Td>
                ))}
                <Td numeric className="font-semibold">{money(r.total)}</Td>
              </Tr>
            </Fragment>
          );
        })}
        <Tr>
          <Td className="font-bold">Gross pay</Td>
          {d.employees.map((e) => (
            <Td key={e.id} numeric className="font-bold">{money(d.gross[e.id] ?? 0)}</Td>
          ))}
          <Td numeric className="font-bold">{money(d.totalGross)}</Td>
        </Tr>
        <Tr>
          <Td className="font-bold">Net pay</Td>
          {d.employees.map((e) => (
            <Td key={e.id} numeric className="font-bold">{money(d.net[e.id] ?? 0)}</Td>
          ))}
          <Td numeric className="font-bold">{money(d.totalNet)}</Td>
        </Tr>
      </tbody>
    </Table>
  );
}

function ItemDetailView({ d }: { d: ItemDetail }) {
  if (!d.groups.length) return <p className="text-sm text-navy/60">No payroll in this period.</p>;
  return (
    <div className="space-y-6">
      {d.groups.map((g) => (
        <div key={`${g.kind}|${g.item}`}>
          <h3 className="font-bold text-navy">{g.item}</h3>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Employee</Th>
                <Th>Detail</Th>
                <Th numeric>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {g.lines.map((l, i) => (
                <Tr key={i}>
                  <Td>{l.date}</Td>
                  <Td>{l.type}</Td>
                  <Td>{l.employeeName}</Td>
                  <Td className="text-xs text-navy/60">{l.detail}</Td>
                  <Td numeric>{money(l.amount)}</Td>
                </Tr>
              ))}
              <Tr>
                <Td colSpan={4} className="font-bold">Total {g.item}</Td>
                <Td numeric className="font-bold">{money(g.total)}</Td>
              </Tr>
            </tbody>
          </Table>
        </div>
      ))}
    </div>
  );
}

function ByPayeeView({ d }: { d: ByPayee }) {
  if (!d.payees.length) return <p className="text-sm text-navy/60">No payroll in this period.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Type</Th>
          <Th>Ref</Th>
          <Th>Memo</Th>
          <Th numeric>Gross</Th>
          <Th numeric>Taxes</Th>
          <Th numeric>Deductions</Th>
          <Th numeric>Net</Th>
        </tr>
      </thead>
      <tbody>
        {d.payees.map((p) => (
          <Fragment key={p.employeeName}>
            <tr>
              <td colSpan={8} className="pt-4 pb-1 px-4 font-bold text-navy">{p.employeeName}</td>
            </tr>
            {p.transactions.map((t) => (
              <Tr key={t.paycheckId}>
                <Td>{t.date}</Td>
                <Td>{t.type}</Td>
                <Td className="font-mono text-xs">{t.reference}</Td>
                <Td className="text-xs">{t.memo ?? ''}</Td>
                <Td numeric>{money(t.gross)}</Td>
                <Td numeric>{money(t.taxes)}</Td>
                <Td numeric>{money(t.deductions)}</Td>
                <Td numeric>{money(t.net)}</Td>
              </Tr>
            ))}
            <Tr key={`t-${p.employeeName}`}>
              <Td colSpan={4} className="font-semibold">Total {p.employeeName}</Td>
              <Td numeric className="font-semibold">{money(p.totalGross)}</Td>
              <Td />
              <Td />
              <Td numeric className="font-semibold">{money(p.totalNet)}</Td>
            </Tr>
          </Fragment>
        ))}
        <Tr>
          <Td colSpan={4} className="font-bold">Total</Td>
          <Td numeric className="font-bold">{money(d.totalGross)}</Td>
          <Td />
          <Td />
          <Td numeric className="font-bold">{money(d.totalNet)}</Td>
        </Tr>
      </tbody>
    </Table>
  );
}

function WcView({ d }: { d: WcSummary }) {
  if (!d.rows.length) return <p className="text-sm text-navy/60">No workers&apos; comp premium was recorded in this period.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Class code</Th>
          <Th>Description</Th>
          <Th numeric>Employees</Th>
          <Th numeric>Wages</Th>
          <Th numeric>Rate per $100</Th>
          <Th numeric>Premium</Th>
        </tr>
      </thead>
      <tbody>
        {d.rows.map((r) => (
          <Tr key={r.code}>
            <Td className="font-mono">{r.code}</Td>
            <Td>{r.description ?? ''}</Td>
            <Td numeric>{r.employees}</Td>
            <Td numeric>{money(r.wages)}</Td>
            <Td numeric>{r.ratePer100}</Td>
            <Td numeric>{money(r.premium)}</Td>
          </Tr>
        ))}
        <Tr>
          <Td colSpan={3} className="font-bold">Total</Td>
          <Td numeric className="font-bold">{money(d.totalWages)}</Td>
          <Td />
          <Td numeric className="font-bold">{money(d.totalPremium)}</Td>
        </Tr>
      </tbody>
    </Table>
  );
}

function StateWageView({ d }: { d: StateWage }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-navy/70">
        {d.state} · Q{d.quarter} {d.year}
        {d.accountNumber ? ` · Account ${d.accountNumber}` : ''} · Unemployment rate {(Number(d.suiRate) * 100).toFixed(3)}% on the first{' '}
        {Number(d.suiWageBase) ? money(d.suiWageBase) : 'dollar (no limit)'} per employee
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Employee</Th>
            <Th>SSN</Th>
            <Th numeric>Quarter wages</Th>
            <Th numeric>Excess wages</Th>
            <Th numeric>Taxable wages</Th>
            <Th numeric>Unemployment</Th>
            <Th numeric>Disability</Th>
            <Th numeric>State income tax</Th>
          </tr>
        </thead>
        <tbody>
          {d.employees.map((e, i) => (
            <Tr key={i}>
              <Td>{e.employeeName}</Td>
              <Td className="font-mono">{e.ssnLast4 ? `•••-••-${e.ssnLast4}` : '—'}</Td>
              <Td numeric>{money(e.quarterWages)}</Td>
              <Td numeric>{money(e.excessWages)}</Td>
              <Td numeric>{money(e.taxableWages)}</Td>
              <Td numeric>{money(e.suiAccrued)}</Td>
              <Td numeric>{money(e.sdiWithheld)}</Td>
              <Td numeric>{money(e.stateWithheld)}</Td>
            </Tr>
          ))}
          <Tr>
            <Td colSpan={2} className="font-bold">Total</Td>
            <Td numeric className="font-bold">{money(d.totals.quarterWages)}</Td>
            <Td numeric className="font-bold">{money(d.totals.excessWages)}</Td>
            <Td numeric className="font-bold">{money(d.totals.taxableWages)}</Td>
            <Td numeric className="font-bold">{money(d.totals.suiAccrued)}</Td>
            <Td numeric className="font-bold">{money(d.totals.sdiWithheld)}</Td>
            <Td numeric className="font-bold">{money(d.totals.stateWithheld)}</Td>
          </Tr>
        </tbody>
      </Table>
      <p className="text-xs text-navy/50">
        Unemployment tax due by the worksheet (taxable wages × rate): {money(d.totals.suiCalculated)}. Recorded on
        paychecks: {money(d.totals.suiAccrued)}.
      </p>
    </div>
  );
}
