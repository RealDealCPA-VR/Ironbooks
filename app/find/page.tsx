'use client';

/**
 * Find (QB Edit → Advanced Find): search every transaction by type, name, amount range,
 * number, account, date, memo, class and cleared status. Results list one line per
 * transaction; double-click (or click the type / amount) to open it.
 */
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import type { StdReport } from '@/lib/reports/types';
import { reportToTable } from '@/lib/reports/types';
import ReportToolbar from '../reports/_components/ReportToolbar';
import StdReportTable, { useCollapse } from '../reports/_components/StdReportTable';
import { useNumberFormat } from '../reports/_components/NumberFormatPanel';
import { TXN_TYPES, loadFilterOptions, type FilterOptions } from '../reports/_components/ReportFilters';

type Q = Record<string, string>;

export default function FindPage() {
  const [q, setQ] = useState<Q>({});
  const [opts, setOpts] = useState<FilterOptions | null>(null);
  const [report, setReport] = useState<StdReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [format] = useNumberFormat();
  const { collapsed, toggle } = useCollapse(report);

  useEffect(() => {
    loadFilterOptions()
      .then(setOpts)
      .catch(() => setOpts(null));
  }, []);

  const set = (k: string, v: string) => {
    const next = { ...q };
    if (v) next[k] = v;
    else delete next[k];
    setQ(next);
  };

  const find = async () => {
    setLoading(true);
    try {
      setReport(await api.get<StdReport>(`/api/find?${new URLSearchParams(q).toString()}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Search failed.', 'danger');
    } finally {
      setLoading(false);
    }
  };

  const nameValue = q.customerId ? `c:${q.customerId}` : q.vendorId ? `v:${q.vendorId}` : q.employeeId ? `e:${q.employeeId}` : '';
  const t = report ? reportToTable(report) : null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Find Transactions" icon={Search} />
      <Card className="p-4 mb-4 print-hidden">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            find();
          }}
        >
          <div>
            <Label htmlFor="f-type">Transaction type</Label>
            <Select id="f-type" value={q.txnType ?? ''} onChange={(e) => set('txnType', e.target.value)}>
              <option value="">Any</option>
              {TXN_TYPES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="f-name">Name</Label>
            <Select
              id="f-name"
              value={nameValue}
              onChange={(e) => {
                const next = { ...q };
                delete next.customerId;
                delete next.vendorId;
                delete next.employeeId;
                const [k, id] = e.target.value.split(':');
                if (id) next[k === 'c' ? 'customerId' : k === 'v' ? 'vendorId' : 'employeeId'] = id;
                setQ(next);
              }}
            >
              <option value="">Anyone</option>
              {opts && (
                <>
                  <optgroup label="Customers">
                    {opts.customers.map((c) => (
                      <option key={c.id} value={`c:${c.id}`}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Vendors">
                    {opts.vendors.map((v) => (
                      <option key={v.id} value={`v:${v.id}`}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Employees">
                    {opts.employees.map((v) => (
                      <option key={v.id} value={`e:${v.id}`}>
                        {v.name}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
            </Select>
          </div>
          <div>
            <Label htmlFor="f-acct">Account</Label>
            <Select id="f-acct" value={q.accountId ?? ''} onChange={(e) => set('accountId', e.target.value)}>
              <option value="">Any</option>
              {opts?.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="f-class">Class</Label>
            <Select id="f-class" value={q.classId ?? ''} onChange={(e) => set('classId', e.target.value)}>
              <option value="">Any</option>
              {opts?.classes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="f-from">Date from</Label>
            <Input id="f-from" type="date" value={q.from ?? ''} onChange={(e) => set('from', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="f-to">Date to</Label>
            <Input id="f-to" type="date" value={q.to ?? ''} onChange={(e) => set('to', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="f-amin">Amount from</Label>
            <Input id="f-amin" inputMode="decimal" value={q.amountMin ?? ''} onChange={(e) => set('amountMin', e.target.value.trim())} />
          </div>
          <div>
            <Label htmlFor="f-amax">Amount to</Label>
            <Input id="f-amax" inputMode="decimal" value={q.amountMax ?? ''} onChange={(e) => set('amountMax', e.target.value.trim())} />
          </div>
          <div>
            <Label htmlFor="f-num">Number contains</Label>
            <Input id="f-num" value={q.number ?? ''} onChange={(e) => set('number', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="f-memo">Memo contains</Label>
            <Input id="f-memo" value={q.memo ?? ''} onChange={(e) => set('memo', e.target.value)} />
          </div>
          <div>
            <Label htmlFor="f-clr">Cleared</Label>
            <Select id="f-clr" value={q.cleared ?? ''} onChange={(e) => set('cleared', e.target.value)}>
              <option value="">Either</option>
              <option value="cleared">Cleared</option>
              <option value="uncleared">Not cleared</option>
            </Select>
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm">
              Find
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => { setQ({}); setReport(null); }}>
              Reset
            </Button>
          </div>
        </form>
        <p className="text-xs text-navy/50 mt-2">The amount range is matched against the transaction total.</p>
      </Card>
      <ReportToolbar table={report && t ? { filename: 'find', title: report.title, subtitle: report.subtitle, ...t } : null} disabled={loading} />
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center gap-2 justify-center py-16 text-navy/50 text-sm">
            <Spinner className="text-electric" /> Searching…
          </div>
        ) : report ? (
          <StdReportTable report={report} format={format} collapsed={collapsed} onToggle={toggle} />
        ) : (
          <p className="p-8 text-center text-sm text-navy/50">Set any filters and click Find.</p>
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
