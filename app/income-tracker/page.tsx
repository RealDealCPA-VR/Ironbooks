'use client';
/**
 * Income Tracker (wave2 sales C9) — QB's money bar: what is not billed yet, what is billed but
 * not due, what is overdue, and what came in during the last 30 days. Click a bar to filter;
 * select rows for batch actions (email, queue to print / email, turn into invoices).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TrendingUp } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  DateInput,
  EmptyState,
  Label,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { useCreditLimitConfirm } from '@/components/sales/SalesExtras';

type Bucket = 'unbilled' | 'unpaid' | 'overdue' | 'paid';

interface Row {
  bucket: Bucket;
  type: string;
  id: string;
  customerId: string | null;
  customerName: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  amount: string;
  openBalance: string;
  status: string;
  daysOverdue: number | null;
}

interface Tracker {
  asOf: string;
  totals: Record<Bucket, { amount: string; count: number }>;
  rows: Row[];
}

const BARS: Array<{ key: Bucket; label: string; hint: string; color: string }> = [
  { key: 'unbilled', label: 'Not billed yet', hint: 'Estimates, sales orders and billable time', color: 'bg-slate-400' },
  { key: 'unpaid', label: 'Billed, not due', hint: 'Open invoices not yet past due', color: 'bg-electric' },
  { key: 'overdue', label: 'Overdue', hint: 'Open invoices past their due date', color: 'bg-red-500' },
  { key: 'paid', label: 'Paid (last 30 days)', hint: 'Payments and sales receipts', color: 'bg-emerald' },
];

const TYPE_LABEL: Record<string, string> = {
  estimate: 'Estimate',
  sales_order: 'Sales Order',
  time: 'Billable time',
  invoice: 'Invoice',
  statement_charge: 'Statement charge',
  payment: 'Payment',
  sales_receipt: 'Sales Receipt',
};

const LINK: Record<string, string> = {
  estimate: '/estimates',
  sales_order: '/sales-orders',
  time: '/time-tracking',
  invoice: '/invoices',
  statement_charge: '/invoices/statement-charges',
  payment: '/payments',
  sales_receipt: '/sales-receipts',
};

const FORM_TYPES = new Set(['estimate', 'sales_order', 'invoice', 'statement_charge', 'sales_receipt']);

export default function IncomeTrackerPage() {
  const [data, setData] = useState<Tracker | null>(null);
  const [loading, setLoading] = useState(true);
  const [bucket, setBucket] = useState<Bucket | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const creditLimit = useCreditLimitConfirm();
  // As of (blank = today) and customer: every bar is rebuilt for that day on the server.
  const [asOf, setAsOf] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customers, setCustomers] = useState<Array<{ id: string; displayName: string }>>([]);

  useEffect(() => {
    api
      .get<Array<{ id: string; displayName: string }>>('/api/customers')
      .then((list) => setCustomers(Array.isArray(list) ? list : []))
      .catch(() => setCustomers([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (asOf) qs.set('asOf', asOf);
      if (customerId) qs.set('customerId', customerId);
      const q = qs.toString();
      setData(await api.get<Tracker>(`/api/income-tracker${q ? `?${q}` : ''}`));
      setSelected(new Set());
    } catch (err) {
      toastError(err, 'Could not load the Income Tracker.');
    } finally {
      setLoading(false);
    }
  }, [asOf, customerId]);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) => (bucket === 'all' || r.bucket === bucket) && (typeFilter === 'all' || r.type === typeFilter),
      ),
    [data, bucket, typeFilter],
  );
  const key = (r: Row) => `${r.type}:${r.id}`;
  const picked = rows.filter((r) => selected.has(key(r)));
  const maxBar = Math.max(1, ...BARS.map((b) => Number(data?.totals[b.key].amount ?? 0)));

  async function run(action: 'email' | 'queue_print' | 'queue_email' | 'convert') {
    const items = picked.map((r) => ({ type: r.type, id: r.id }));
    if (items.length === 0) {
      toast('Select at least one row first.', 'danger');
      return;
    }
    setRunning(true);
    try {
      const res = await creditLimit.run((override) =>
        api.post<{ done: unknown[]; failed: Array<{ error: string }> }>('/api/income-tracker/actions', {
          action,
          items,
          overrideCreditLimit: override,
        }),
      );
      if (!res) return;
      if (res.done.length) toast(`Done for ${res.done.length} row${res.done.length === 1 ? '' : 's'}.`, 'success');
      if (res.failed.length) toast(`${res.failed.length} could not be done: ${res.failed[0].error}`, 'danger');
      await load();
    } catch (err) {
      toastError(err, 'That batch action did not work.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Money coming in (Income Tracker)"
        icon={TrendingUp}
        action={
          <Link href="/collections-center" className="text-sm font-semibold text-electric hover:underline">
            Collections Center
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="it-asof">As of</Label>
          <DateInput id="it-asof" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <div className="w-64">
          <Label htmlFor="it-customer">Customer</Label>
          <Select id="it-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName}</option>
            ))}
          </Select>
        </div>
        {asOf && (
          <Button variant="ghost" size="sm" onClick={() => setAsOf('')}>
            Back to today
          </Button>
        )}
        <p className="text-xs text-navy/50 pb-2">
          {data
            ? `Showing what was unbilled, open, overdue and paid on ${formatDate(data.asOf)}.`
            : 'Pick a day to see the tracker as it stood then.'}
        </p>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-navy/40">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            {BARS.map((b) => {
              const t = data?.totals[b.key] ?? { amount: '0', count: 0 };
              const active = bucket === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => setBucket(active ? 'all' : b.key)}
                  className={`text-left rounded-2xl border bg-white p-4 shadow-sm transition ${active ? 'border-electric ring-2 ring-electric/30' : 'border-slate-100 hover:border-slate-300'}`}
                  aria-pressed={active}
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-navy/50">{b.label}</div>
                  <div className="mt-1 text-2xl font-bold text-navy tabular-nums">{formatCurrency(t.amount)}</div>
                  <div className="text-xs text-navy/50">
                    {t.count} item{t.count === 1 ? '' : 's'} · {b.hint}
                  </div>
                  <div className="mt-3 h-2 w-full rounded bg-slate-100">
                    <div className={`h-2 rounded ${b.color}`} style={{ width: `${(Number(t.amount) / maxBar) * 100}%` }} />
                  </div>
                </button>
              );
            })}
          </div>

          <Card className="p-0 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Filter by type" className="w-48">
                <option value="all">All types</option>
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
              <span className="text-sm text-navy/50">{picked.length} selected</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={running || picked.length === 0} onClick={() => run('email')}>
                  Email
                </Button>
                <Button size="sm" variant="secondary" disabled={running || picked.length === 0} onClick={() => run('queue_print')}>
                  Mark to print
                </Button>
                <Button size="sm" variant="secondary" disabled={running || picked.length === 0} onClick={() => run('queue_email')}>
                  Mark to email
                </Button>
                <Button size="sm" disabled={running || picked.length === 0} onClick={() => run('convert')}>
                  Turn into invoices
                </Button>
              </div>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon={TrendingUp} title="Nothing here" message="No transactions match this view." />
            ) : (
              <Table>
                <thead>
                  <Tr>
                    <Th>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={rows.length > 0 && rows.every((r) => selected.has(key(r)))}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(rows.map(key)) : new Set())
                        }
                      />
                    </Th>
                    <Th>Type</Th>
                    <Th>Customer</Th>
                    <Th>No.</Th>
                    <Th>Date</Th>
                    <Th>Due</Th>
                    <Th numeric>Amount</Th>
                    <Th numeric>Open balance</Th>
                    <Th>Status</Th>
                  </Tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={key(r)}>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${TYPE_LABEL[r.type] ?? r.type} ${r.number ?? ''}`}
                          checked={selected.has(key(r))}
                          disabled={!FORM_TYPES.has(r.type)}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(key(r));
                              else next.delete(key(r));
                              return next;
                            })
                          }
                        />
                      </Td>
                      <Td>
                        <Link href={LINK[r.type] ?? '#'} className="text-electric hover:underline">
                          {TYPE_LABEL[r.type] ?? r.type}
                        </Link>
                      </Td>
                      <Td className="font-medium text-navy">{r.customerName}</Td>
                      <Td>{r.number ? `#${r.number}` : '—'}</Td>
                      <Td className="text-navy/70">{formatDate(r.date)}</Td>
                      <Td className="text-navy/70">{formatDate(r.dueDate)}</Td>
                      <Td numeric>{formatCurrency(r.amount)}</Td>
                      <Td numeric className="font-semibold">{formatCurrency(r.openBalance)}</Td>
                      <Td>
                        {r.bucket === 'overdue' ? (
                          <Badge tone="danger">{r.daysOverdue} days late</Badge>
                        ) : r.bucket === 'paid' ? (
                          <Badge tone="success">Received</Badge>
                        ) : r.bucket === 'unbilled' ? (
                          <Badge tone="neutral">Not billed</Badge>
                        ) : (
                          <Badge tone="info">Open</Badge>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      )}
      {creditLimit.dialog}
    </main>
  );
}
