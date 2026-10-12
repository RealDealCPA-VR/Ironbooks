'use client';

/**
 * Advanced Reporting (lite): pick what goes down the side, what goes across the top and what to
 * add up — over your ledger lines or your item sales. Every cell QuickZooms to the transactions
 * behind it.
 */
import { useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import type { StdReport } from '@/lib/reports/types';
import ReportToolbar from '../_components/ReportToolbar';
import StdReportTable, { useCollapse } from '../_components/StdReportTable';
import { useNumberFormat } from '../_components/NumberFormatPanel';
import { reportToTable } from '@/lib/reports/types';

const DIMS: Record<'gl' | 'sales', [string, string][]> = {
  gl: [
    ['account', 'Account'],
    ['accountType', 'Account type'],
    ['class', 'Class'],
    ['customer', 'Customer'],
    ['vendor', 'Vendor'],
    ['name', 'Name (any)'],
    ['txnType', 'Transaction type'],
    ['month', 'Month'],
    ['quarter', 'Quarter'],
    ['year', 'Year'],
  ],
  sales: [
    ['customer', 'Customer'],
    ['item', 'Item'],
    ['month', 'Month'],
    ['quarter', 'Quarter'],
    ['year', 'Year'],
  ],
};

const SECTIONS: [string, string][] = [
  ['', 'All accounts'],
  ['income,other_income', 'Income'],
  ['cogs,expense,other_expense', 'Costs & expenses'],
  ['income,cogs,expense,other_income,other_expense', 'Profit & loss accounts'],
  ['bank', 'Bank accounts'],
  ['ar', 'Accounts receivable'],
  ['ap', 'Accounts payable'],
];

export default function PivotPage() {
  const year = new Date().getFullYear();
  const [source, setSource] = useState<'gl' | 'sales'>('gl');
  const [rows, setRows] = useState('account');
  const [cols, setCols] = useState('month');
  const [measure, setMeasure] = useState('amount');
  const [section, setSection] = useState('income,cogs,expense,other_income,other_expense');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<StdReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [format] = useNumberFormat();
  const { collapsed, toggle } = useCollapse(report);

  const run = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ rows, measure, source, from, to });
      if (cols) qs.set('cols', cols);
      if (source === 'gl' && section) qs.set('section', section);
      setReport(await api.get<StdReport>(`/api/reports/pivot?${qs.toString()}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not build the table.', 'danger');
    } finally {
      setLoading(false);
    }
  };

  const changeSource = (s: 'gl' | 'sales') => {
    setSource(s);
    setRows(s === 'gl' ? 'account' : 'customer');
    setCols(s === 'gl' ? 'month' : 'item');
    setMeasure('amount');
  };

  const t = report ? reportToTable(report) : null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Advanced Reporting" icon={Grid3x3} />
      <p className="text-sm text-navy/60 -mt-4 mb-4">
        Build a summary table from your own books: choose rows, columns and what to total. Click any number to see the transactions behind it.
      </p>
      <Card className="p-4 mb-4 print-hidden">
        <form
          className="flex items-end gap-3 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <div>
            <Label htmlFor="pv-src">Data</Label>
            <Select id="pv-src" value={source} onChange={(e) => changeSource(e.target.value as 'gl' | 'sales')}>
              <option value="gl">Ledger (all postings)</option>
              <option value="sales">Item sales</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pv-rows">Rows</Label>
            <Select id="pv-rows" value={rows} onChange={(e) => setRows(e.target.value)}>
              {DIMS[source].map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pv-cols">Columns</Label>
            <Select id="pv-cols" value={cols} onChange={(e) => setCols(e.target.value)}>
              <option value="">Total only</option>
              {DIMS[source]
                .filter(([k]) => k !== rows)
                .map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pv-measure">Add up</Label>
            <Select id="pv-measure" value={measure} onChange={(e) => setMeasure(e.target.value)}>
              <option value="amount">Amount</option>
              {source === 'gl' && <option value="debit">Debits</option>}
              {source === 'gl' && <option value="credit">Credits</option>}
              {source === 'sales' && <option value="quantity">Quantity</option>}
              <option value="count">Number of lines</option>
            </Select>
          </div>
          {source === 'gl' && (
            <div>
              <Label htmlFor="pv-sec">Accounts</Label>
              <Select id="pv-sec" value={section} onChange={(e) => setSection(e.target.value)}>
                {SECTIONS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div>
            <Label htmlFor="pv-from">From</Label>
            <Input id="pv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pv-to">To</Label>
            <Input id="pv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button type="submit" size="sm">
            Build table
          </Button>
        </form>
        <p className="text-xs text-navy/50 mt-2">Amounts follow each account’s normal side (income and liabilities as positive credits, expenses and assets as positive debits).</p>
      </Card>
      <ReportToolbar table={report && t ? { filename: 'advanced-reporting', title: report.title, subtitle: report.subtitle, ...t } : null} disabled={loading} />
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 justify-center py-16 text-navy/50 text-sm">
            <Spinner className="text-electric" /> Building…
          </div>
        ) : report ? (
          <StdReportTable report={report} format={format} collapsed={collapsed} onToggle={toggle} />
        ) : (
          <p className="p-8 text-center text-sm text-navy/50">Choose your rows and columns, then Build table.</p>
        )}
      </Card>
      {report?.notes?.map((n) => (
        <p key={n} className="text-xs text-navy/50 mt-2">
          {n}
        </p>
      ))}
    </main>
  );
}
