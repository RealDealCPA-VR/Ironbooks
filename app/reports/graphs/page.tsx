'use client';

/**
 * QB-style graphs (Reports → Company & Financial → graphs): Income & Expense, Net Worth, Sales,
 * Accounts Receivable, Accounts Payable and Budget vs. Actual. Plain SVG (no chart library),
 * one shared y-axis per chart, a legend for 2+ series, a hover tooltip on every bar / point,
 * QuickZoom on click, and a "Show as table" view for screen readers and printing.
 * Palette: validated reference categorical slots 1-3 (light + dark steps).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PieChart } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, Select, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';

interface GraphData {
  kind: string;
  title: string;
  subtitle: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  breakdown?: { label: string; value: number; href?: string }[];
  hrefs?: string[];
}

const KINDS: [string, string][] = [
  ['income-expense', 'Income & Expense'],
  ['net-worth', 'Net Worth'],
  ['sales', 'Sales'],
  ['ar', 'Accounts Receivable'],
  ['ap', 'Accounts Payable'],
  ['budget-vs-actual', 'Budget vs. Actual'],
];

const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtFull = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function BarChart({ data, onZoom }: { data: GraphData; onZoom: (i: number) => void }) {
  const [hover, setHover] = useState<{ i: number; s: number } | null>(null);
  const W = 760;
  const H = 300;
  const pad = { l: 64, r: 16, t: 16, b: 40 };
  const all = data.series.flatMap((s) => s.values);
  const maxV = niceMax(Math.max(0, ...all));
  const minV = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(0, ...all)) : 0;
  const y = (v: number) => pad.t + ((maxV - v) / (maxV - minV)) * (H - pad.t - pad.b);
  const n = data.labels.length;
  const groupW = (W - pad.l - pad.r) / Math.max(1, n);
  const barSeries = data.kind === 'net-worth' ? data.series.slice(0, 2) : data.series;
  const lineSeries = data.kind === 'net-worth' ? data.series[2] : null;
  const barW = Math.max(4, Math.min(28, (groupW - 8) / Math.max(1, barSeries.length) - 2));
  const ticks = Array.from({ length: 5 }, (_, i) => minV + ((maxV - minV) * i) / 4);
  const cx = (i: number) => pad.l + groupW * i + groupW / 2;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${data.title}: ${data.subtitle}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--viz-grid)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--viz-muted)">
              {fmt(t)}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" strokeWidth={1} />
        {data.labels.map((label, i) => (
          <g key={label}>
            <text x={cx(i)} y={H - pad.b + 16} textAnchor="middle" fontSize={11} fill="var(--viz-muted)">
              {n > 12 && i % 2 ? '' : label}
            </text>
            {barSeries.map((s, si) => {
              const v = s.values[i] ?? 0;
              const x = cx(i) - (barSeries.length * (barW + 2)) / 2 + si * (barW + 2) + 1;
              const top = Math.min(y(v), y(0));
              const h = Math.max(1, Math.abs(y(v) - y(0)));
              return (
                <rect
                  key={s.name}
                  x={x}
                  y={top}
                  width={barW}
                  height={h}
                  rx={Math.min(4, barW / 2)}
                  fill={`var(--viz-s${si + 1})`}
                  opacity={hover && (hover.i !== i || hover.s !== si) ? 0.55 : 1}
                />
              );
            })}
            {/* Hit target larger than the marks: the whole column. */}
            <rect
              x={pad.l + groupW * i}
              y={pad.t}
              width={groupW}
              height={H - pad.t - pad.b}
              fill="transparent"
              style={{ cursor: data.hrefs?.[i] ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover({ i, s: -1 })}
              onMouseLeave={() => setHover(null)}
              onClick={() => onZoom(i)}
            >
              <title>{`${label}: ${data.series.map((s) => `${s.name} ${fmtFull(s.values[i] ?? 0)}`).join(', ')}`}</title>
            </rect>
          </g>
        ))}
        {lineSeries && (
          <>
            <polyline
              fill="none"
              stroke="var(--viz-s3)"
              strokeWidth={2}
              points={lineSeries.values.map((v, i) => `${cx(i)},${y(v)}`).join(' ')}
            />
            {lineSeries.values.map((v, i) => (
              <circle key={i} cx={cx(i)} cy={y(v)} r={4} fill="var(--viz-s3)" stroke="var(--viz-surface)" strokeWidth={2} pointerEvents="none" />
            ))}
          </>
        )}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg text-navy"
          style={{ left: `${Math.min(70, (cx(hover.i) / W) * 100)}%` }}
        >
          <div className="font-semibold mb-1">{data.labels[hover.i]}</div>
          {data.series.map((s, si) => (
            <div key={s.name} className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: `var(--viz-s${si + 1})` }} />
              <span>{s.name}</span>
              <span className="ml-auto tabular-nums">{fmtFull(s.values[hover.i] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Breakdown({ items }: { items: NonNullable<GraphData['breakdown']> }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value)));
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.label} className="text-sm">
          <div className="flex justify-between text-navy">
            {it.href ? (
              <Link href={it.href} className="hover:text-electric hover:underline">
                {it.label}
              </Link>
            ) : (
              <span>{it.label}</span>
            )}
            <span className="tabular-nums text-navy/70">{fmtFull(it.value)}</span>
          </div>
          <div className="h-2 rounded bg-slate-100 mt-1" aria-hidden="true">
            <div className="h-2 rounded" style={{ width: `${(Math.abs(it.value) / max) * 100}%`, background: 'var(--viz-s1)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function GraphsPage() {
  const router = useRouter();
  const year = new Date().getFullYear();
  const [kind, setKind] = useState('income-expense');
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(todayISO());
  const [budgetId, setBudgetId] = useState('');
  const [budgets, setBudgets] = useState<{ id: string; name: string; fiscalYear: number }[]>([]);
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    api
      .get<{ budgets: { id: string; name: string; fiscalYear: number }[] }>('/api/reports/filter-options')
      .then((o) => setBudgets(o.budgets))
      .catch(() => setBudgets([]));
  }, []);

  const load = useCallback(async () => {
    if (kind === 'budget-vs-actual' && !budgetId) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ kind });
      if (kind === 'ar' || kind === 'ap') qs.set('asOf', to);
      else if (kind === 'budget-vs-actual') qs.set('budgetId', budgetId);
      else {
        qs.set('from', from);
        qs.set('to', to);
      }
      setData(await api.get<GraphData>(`/api/reports/graphs?${qs.toString()}`));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not draw the graph.', 'danger');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [kind, from, to, budgetId]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, budgetId]);

  const totals = useMemo(() => data?.series.map((s) => s.values.reduce((a, b) => a + b, 0)) ?? [], [data]);

  return (
    <main className="viz-root min-h-screen bg-offwhite p-8 font-sans">
      <style>{`
        .viz-root { --viz-surface:#fcfcfb; --viz-grid:#e5e7eb; --viz-axis:#9ca3af; --viz-muted:#52514e; --viz-s1:#2a78d6; --viz-s2:#eb6834; --viz-s3:#1baf7a; }
        @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .viz-root { --viz-surface:#1a1a19; --viz-grid:#3a3a38; --viz-axis:#6b6b68; --viz-muted:#c3c2b7; --viz-s1:#3987e5; --viz-s2:#d95926; --viz-s3:#199e70; } }
        :root[data-theme="dark"] .viz-root { --viz-surface:#1a1a19; --viz-grid:#3a3a38; --viz-axis:#6b6b68; --viz-muted:#c3c2b7; --viz-s1:#3987e5; --viz-s2:#d95926; --viz-s3:#199e70; }
      `}</style>
      <PageHeader title="Graphs" icon={PieChart} />
      <Card className="p-4 mb-4 print-hidden">
        <form
          className="flex items-end gap-3 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <div>
            <Label htmlFor="g-kind">Graph</Label>
            <Select id="g-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          {kind === 'budget-vs-actual' ? (
            <div>
              <Label htmlFor="g-budget">Budget</Label>
              <Select id="g-budget" value={budgetId} onChange={(e) => setBudgetId(e.target.value)}>
                <option value="">Choose…</option>
                {budgets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} (FY{b.fiscalYear})
                  </option>
                ))}
              </Select>
            </div>
          ) : kind === 'ar' || kind === 'ap' ? (
            <div>
              <Label htmlFor="g-asof">As of</Label>
              <Input id="g-asof" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="g-from">From</Label>
                <Input id="g-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="g-to">To</Label>
                <Input id="g-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <Button type="submit" size="sm">
            Draw graph
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
            {asTable ? 'Show as graph' : 'Show as table'}
          </Button>
        </form>
      </Card>

      {loading && (
        <div className="flex items-center gap-2 justify-center py-16 text-navy/50 text-sm">
          <Spinner className="text-electric" /> Drawing…
        </div>
      )}
      {!loading && !data && kind === 'budget-vs-actual' && <p className="text-sm text-navy/60">Choose a budget to compare.</p>}
      {!loading && data && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="p-5 lg:col-span-2">
            <h2 className="font-bold text-navy">{data.title}</h2>
            <p className="text-xs text-navy/50 mb-3">{data.subtitle}</p>
            {data.series.length > 1 && (
              <div className="flex gap-4 mb-2 text-xs text-navy" aria-label="Legend">
                {data.series.map((s, i) => (
                  <span key={s.name} className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: `var(--viz-s${i + 1})` }} />
                    {s.name} <span className="text-navy/50 tabular-nums">{fmtFull(totals[i] ?? 0)}</span>
                  </span>
                ))}
              </div>
            )}
            {asTable ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-navy/20">
                    <th className="text-left py-1 px-2">Period</th>
                    {data.series.map((s) => (
                      <th key={s.name} className="text-right py-1 px-2">
                        {s.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.labels.map((l, i) => (
                    <tr key={l} className="border-b border-slate-100">
                      <td className="py-1 px-2">{data.hrefs?.[i] ? <Link href={data.hrefs[i]} className="text-electric hover:underline">{l}</Link> : l}</td>
                      {data.series.map((s) => (
                        <td key={s.name} className="text-right tabular-nums py-1 px-2">
                          {fmtFull(s.values[i] ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <BarChart data={data} onZoom={(i) => data.hrefs?.[i] && router.push(data.hrefs[i])} />
            )}
            <p className="text-xs text-navy/40 mt-2 print-hidden">Click a bar to see the report behind it.</p>
          </Card>
          {data.breakdown && data.breakdown.length > 0 && (
            <Card className="p-5">
              <h2 className="font-bold text-navy mb-3">
                {data.kind === 'income-expense' ? 'Expenses by account' : data.kind === 'sales' ? 'Sales by customer' : data.kind === 'ar' ? 'Owed by customer' : 'Owed to vendor'}
              </h2>
              <Breakdown items={data.breakdown} />
            </Card>
          )}
        </div>
      )}
    </main>
  );
}
