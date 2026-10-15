/**
 * One-line report summary ("what changed") for the top of a report.
 *
 * Deterministic first: the report's headline number (Net Income, Equity, Total sales, Total
 * expenses) for its period is compared with the previous period and the same period last year,
 * with the % change, and the three biggest movers (accounts, customers, items or vendors) with
 * their amounts. All of it is computed by re-running the standard report engine on the same
 * options (basis, class, customer / item filters) for each window — never from floats, never
 * from the AI.
 *
 * Optionally the sentence is re-phrased by the company's AI router (lib/ai/router.ts, task
 * 'assistant'): local / tailnet models by default, a cloud model only when the company opted in,
 * and then always redacted by the router. The AI reply is accepted only if every number in it
 * appears in the deterministic facts; otherwise the deterministic sentence is used. With AI off
 * (or unavailable) the deterministic sentence is the summary.
 */
import type Decimal from 'decimal.js';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import type { ReportSummaryFacts, ReportSummaryResult, SummaryComparison, SummaryMover } from '@/lib/reports/drilldown';
import { isSummaryReport } from '@/lib/reports/drilldown';
import type { StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { validation } from './_base';
import { prepareStandardReport } from './reportRegistry';
import { dayStr, fmtDay, resolveAsOf, resolveRange } from './reportEngine';
import { balanceSheetReport, previousPeriod, profitAndLossReport, rangeLabel, shiftMonths, shiftYears } from './reportsStandard';
import { expensesByVendorSummary, salesByCustomerSummary, salesByItemSummary } from './reportsLists';
import { buildRouter, type BuildRouterOptions } from './aiSettings';

type Kind = 'pl' | 'bs' | 'sales-customer' | 'sales-item' | 'expenses';

const KIND: Record<string, Kind> = {
  'profit-loss': 'pl',
  'profit-loss-prev-year': 'pl',
  'profit-loss-by-month': 'pl',
  'profit-loss-percent': 'pl',
  'profit-loss-ytd': 'pl',
  'pl-by-class': 'pl',
  'profit-loss-by-job': 'pl',
  'balance-sheet': 'bs',
  'balance-sheet-prev-year': 'bs',
  'balance-sheet-summary': 'bs',
  'balance-sheet-by-period': 'bs',
  'sales-by-customer-summary': 'sales-customer',
  'sales-by-item-summary': 'sales-item',
  'expenses-by-vendor-summary': 'expenses',
};

interface KindSpec {
  metric: string;
  moverNoun: string;
  /** Headline row id and column. */
  metricRow: string;
  column: string;
  isMover: (r: StdRow) => boolean;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ACCOUNT_ROW = new RegExp(`:a:${UUID}(:other)?$`);

const SPECS: Record<Kind, KindSpec> = {
  pl: { metric: 'Net income', moverNoun: 'accounts', metricRow: 'pl:net', column: 'total', isMover: (r) => r.kind === 'data' && ACCOUNT_ROW.test(r.id) },
  bs: {
    metric: 'Equity (what the business is worth to its owners)',
    moverNoun: 'accounts',
    metricRow: 'bs:equity:total',
    column: 'total',
    isMover: (r) => r.kind === 'data' && (ACCOUNT_ROW.test(r.id) || r.id === 'bs:re' || r.id === 'bs:ni'),
  },
  'sales-customer': { metric: 'Total sales', moverNoun: 'customers', metricRow: 'sbc:grand', column: 'amount', isMover: (r) => r.kind === 'data' },
  'sales-item': { metric: 'Total sales', moverNoun: 'items', metricRow: 'sbi:grand', column: 'amount', isMover: (r) => r.kind === 'data' },
  expenses: { metric: 'Total expenses', moverNoun: 'vendors', metricRow: 'ebv:grand', column: 'amount', isMover: (r) => r.kind === 'data' },
};

const dollars = (v: Decimal | string) => formatCurrency(Money.round2(Money.of(v)));
const signed = (v: Decimal) => (v.isNegative() ? `−${dollars(v.abs())}` : `+${dollars(v)}`);

interface Window {
  label: string;
  run: () => Promise<StdReport>;
}

/** The three report runs (current, previous period, same period last year) for a summary. */
async function windows(ctx: ServiceContext, key: string, kind: Kind, p: ReportParams): Promise<[Window, Window, Window]> {
  const basis = p.basis === 'cash' ? 'cash' : 'accrual';
  if (kind === 'bs') {
    // By-period sheets summarise their last column (the end of the range).
    const asOf = key === 'balance-sheet-by-period' ? (await resolveRange(ctx, p)).to : resolveAsOf(p);
    const at = (d: Date): Window => ({ label: `as of ${fmtDay(d)}`, run: () => balanceSheetReport(ctx, { asOf: dayStr(d), basis }) });
    return [at(asOf), at(shiftMonths(asOf, -1)), at(shiftYears(asOf, -1))];
  }
  const { from, to } = await resolveRange(ctx, p);
  const prev = previousPeriod(from, to);
  const yr = { from: shiftYears(from, -1), to: shiftYears(to, -1) };
  const runFor = (w: { from: Date; to: Date }): Window => {
    const q: ReportParams = { from: dayStr(w.from), to: dayStr(w.to), basis };
    let run: () => Promise<StdReport>;
    switch (kind) {
      case 'pl':
        // P&L by Class spreads classes into columns (no class filter); the others honour it.
        run = () => profitAndLossReport(ctx, { ...q, classId: key === 'pl-by-class' ? undefined : p.classId });
        break;
      case 'sales-customer':
        run = () => salesByCustomerSummary(ctx, { ...q, customerId: p.customerId, itemId: p.itemId, classId: p.classId });
        break;
      case 'sales-item':
        run = () => salesByItemSummary(ctx, { ...q, customerId: p.customerId, itemId: p.itemId, classId: p.classId });
        break;
      default:
        run = () => expensesByVendorSummary(ctx, { ...q, classId: p.classId });
    }
    return { label: rangeLabel(w.from, w.to), run };
  };
  return [runFor({ from, to }), runFor(prev), runFor(yr)];
}

const cellAmount = (r: StdReport, rowId: string, col: string): Decimal => {
  const v = r.rows.find((x) => x.id === rowId)?.cells[col];
  return v === null || v === undefined || v === '' ? Money.zero() : Money.of(String(v));
};

function compare(label: string, range: string, current: Decimal, prior: Decimal): SummaryComparison {
  const change = current.minus(prior);
  return {
    label,
    range,
    value: toAmountString(prior),
    change: toAmountString(change),
    changePct: prior.isZero() ? null : change.dividedBy(prior.abs()).times(100).toFixed(2),
  };
}

/** Biggest movers between two runs of the same report, by size of the change. */
export function topMovers(cur: StdReport, prior: StdReport, spec: KindSpec, n = 3): SummaryMover[] {
  const rows = new Map<string, { label: string; cur: Decimal; prior: Decimal }>();
  const take = (r: StdReport, which: 'cur' | 'prior') => {
    for (const row of r.rows) {
      if (!spec.isMover(row)) continue;
      const v = row.cells[spec.column];
      const amt = v === null || v === undefined || v === '' ? Money.zero() : Money.of(String(v));
      const e = rows.get(row.id) ?? { label: String(row.cells.label ?? ''), cur: Money.zero(), prior: Money.zero() };
      e[which] = e[which].plus(amt);
      rows.set(row.id, e);
    }
  };
  take(cur, 'cur');
  take(prior, 'prior');
  return [...rows.entries()]
    .map(([id, e]) => ({ id, label: e.label, cur: e.cur, prior: e.prior, change: e.cur.minus(e.prior) }))
    .filter((m) => !m.change.isZero())
    .sort((a, b) => b.change.abs().comparedTo(a.change.abs()) || a.label.localeCompare(b.label))
    .slice(0, n)
    .map((m) => ({ id: m.id, label: m.label, current: toAmountString(m.cur), prior: toAmountString(m.prior), change: toAmountString(m.change) }));
}

function changePhrase(c: SummaryComparison, what: string): string {
  const ch = Money.of(c.change);
  if (ch.isZero()) return `unchanged from ${what} (${dollars(c.value)})`;
  const dir = ch.isNegative() ? 'down' : 'up';
  if (c.changePct === null) return `${dir} ${dollars(ch.abs())} from ${what} (${dollars(c.value)})`;
  return `${dir} ${Money.of(c.changePct).abs().toFixed(1)}% (${signed(ch)}) from ${what} (${dollars(c.value)})`;
}

/** The deterministic one-line summary. */
export function summaryText(f: ReportSummaryFacts): string {
  const when = f.current.range.startsWith('as of') ? f.current.range : `for ${f.current.range}`;
  const prevWhat = f.current.range.startsWith('as of') ? 'a month earlier' : 'the previous period';
  const yrWhat = f.current.range.startsWith('as of') ? 'a year earlier' : 'the same period last year';
  const head = `${f.metric.replace(/ \(.*\)$/, '')} is ${dollars(f.current.value)} ${when}, ${changePhrase(f.priorPeriod, prevWhat)} and ${changePhrase(f.priorYear, yrWhat)}.`;
  const vsWhat = f.vs === 'prior_year' ? yrWhat : prevWhat;
  const movers = f.movers.length
    ? ` Biggest changes vs ${vsWhat}: ${f.movers.map((m) => `${m.label} ${signed(Money.of(m.change))}`).join(', ')}.`
    : ` None of the ${f.moverNoun} changed vs ${vsWhat}.`;
  return head + movers;
}

/** Number tokens (digits with optional thousands separators / decimals), normalized. */
const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((t) => t.replace(/,/g, '').replace(/^0+(?=\d)/, ''));

/** True when every number in `reply` appears in `facts` (the AI may not invent or alter numbers). */
export function aiReplyKeepsNumbers(reply: string, facts: string): boolean {
  const allowed = new Set(numbersIn(facts));
  return numbersIn(reply).every((n) => allowed.has(n));
}

export interface ReportSummaryOptions {
  /** Which comparison the movers use (default: previous period). */
  vs?: 'prior_period' | 'prior_year';
  /** Ask the AI router to phrase the sentence. */
  ai?: boolean;
  router?: BuildRouterOptions;
  now?: Date;
}

export async function reportSummary(
  ctx: ServiceContext,
  key: string,
  rawParams: URLSearchParams | Record<string, unknown>,
  opts: ReportSummaryOptions = {},
): Promise<ReportSummaryResult> {
  const { entry, params } = await prepareStandardReport(ctx, key, rawParams, { now: opts.now });
  if (!isSummaryReport(key) || !KIND[key]) throw validation('A summary is not available for this report.');
  const kind = KIND[key];
  const spec = SPECS[kind];
  const vs = opts.vs === 'prior_year' ? 'prior_year' : 'prior_period';
  const [w0, w1, w2] = await windows(ctx, key, kind, params);
  const [cur, prev, yr] = await Promise.all([w0.run(), w1.run(), w2.run()]);
  const value = cellAmount(cur, spec.metricRow, spec.column);
  const facts: ReportSummaryFacts = {
    report: key,
    metric: spec.metric,
    current: { range: w0.label, value: toAmountString(value) },
    priorPeriod: compare('Previous period', w1.label, value, cellAmount(prev, spec.metricRow, spec.column)),
    priorYear: compare('Same period last year', w2.label, value, cellAmount(yr, spec.metricRow, spec.column)),
    vs,
    movers: topMovers(cur, vs === 'prior_year' ? yr : prev, spec),
    moverNoun: spec.moverNoun,
    basis: entry.basis ? (params.basis === 'cash' ? 'cash' : 'accrual') : undefined,
  };
  const text = summaryText(facts);
  const result: ReportSummaryResult = { facts, text, aiAvailable: false };

  let router;
  try {
    router = await buildRouter(ctx, opts.router);
  } catch {
    router = null;
  }
  result.aiAvailable = !!router?.isAvailable('assistant');
  if (!opts.ai) return result;
  if (!router || !result.aiAvailable) {
    result.aiNotice = router?.unavailableReason('assistant') ?? 'No AI model is configured.';
    return result;
  }
  try {
    const res = await router.chat(
      'assistant',
      [
        {
          role: 'system',
          content:
            'You rewrite a small-business financial report summary as ONE short, friendly, plain-English sentence for an owner who is not an accountant. ' +
            'Use only the numbers given, written exactly as given. Do not add numbers, advice, causes or guesses. Reply with the sentence only.',
        },
        { role: 'user', content: `Report: ${key}\nSummary: ${text}` },
      ],
      { temperature: 0.2, maxTokens: 220 },
    );
    const reply = res.content.trim().split(/\r?\n/).find((l) => l.trim())?.trim().replace(/^["“]|["”]$/g, '') ?? '';
    if (!reply || reply.length > 500) {
      result.aiNotice = 'The AI reply was empty or too long, so the standard summary is shown.';
    } else if (!aiReplyKeepsNumbers(reply, text)) {
      result.aiNotice = 'The AI reply changed the numbers, so the standard summary is shown.';
    } else {
      result.ai = { text: reply, providerId: res.providerId, locality: res.locality, redacted: res.redacted };
    }
  } catch (err) {
    result.aiNotice = `The AI model could not answer (${err instanceof Error ? err.message : 'unknown error'}); the standard summary is shown.`;
  }
  return result;
}
