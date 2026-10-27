/**
 * Jobs, Time & Mileage reports (QB Report Center → Jobs, Time & Mileage):
 *  - Job Profitability Summary / Detail (actual revenue vs actual cost per Customer:Job)
 *  - Job Estimates vs. Actuals, Item Estimates vs. Actuals
 *  - Unbilled Costs by Job (billable costs and time not yet invoiced)
 *  - Time by Job / by Name / by Item (summary or detail)
 *  - Mileage by Job / by Vehicle (summary or detail)
 *
 * A "job" is either a row in the jobs list (invoice / bill / expense lines tagged with jobId) or a
 * customer / sub-customer (lines tagged with the customer but no job), shown as "Customer:Job".
 * Revenue comes from invoices and sales receipts (credit memos reduce it); cost from bills and
 * direct expenses (checks / card charges), less vendor credits. Void documents never count.
 */
import { and, eq, gte, isNull, lte, ne, notInArray, or, isNotNull, sql, type SQL } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  billLines,
  bills,
  creditMemoLines,
  creditMemos,
  employees,
  estimateLines,
  estimates,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  jobs,
  mileageLogs,
  salesReceiptLines,
  salesReceipts,
  timeEntries,
  vehicles,
  vendorCreditLines,
  vendorCredits,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { customerNames, dayStr, entryIdsForSourceRefs, parseDay, resolveRange, stdHref } from './reportEngine';
import { rangeLabel } from './reportsStandard';
import { docRef } from './docNumbers';

const amt = (v: Decimal) => toAmountString(v);

interface JobFact {
  kind: 'revenue' | 'cost';
  jobKey: string;
  date: Date;
  type: string;
  num: string;
  sourceRef: string;
  itemOrAccount: string;
  memo: string;
  qty: Decimal;
  amount: Decimal;
}

async function jobLabels(ctx: ServiceContext) {
  const names = await customerNames(ctx);
  const jobRows = await ctx.db
    .select({ id: jobs.id, name: jobs.name, customerId: jobs.customerId })
    .from(jobs)
    .where(eq(jobs.companyId, ctx.companyId));
  const label = (key: string): string => {
    const [kind, id] = key.split(':');
    if (kind === 'job') {
      const j = jobRows.find((x) => x.id === id);
      if (!j) return '(unknown job)';
      return j.customerId ? `${names.get(j.customerId)?.name ?? ''}:${j.name}` : j.name;
    }
    return names.get(id)?.name ?? '(unknown customer)';
  };
  return { label, names, jobRows };
}

/**
 * Revenue lines only: not subtotal items (non-posting; their amount repeats the lines above),
 * payment items (money received) or manual sales-tax items (owed to the agency). Discounts stay.
 * Needs `items` joined on the line.
 */
const REVENUE_LINE_ONLY = sql`COALESCE(${items.type}::text, '') NOT IN ('subtotal', 'payment', 'sales_tax')`;

const keyOf = (jobId: string | null, customerId: string | null) =>
  jobId ? `job:${jobId}` : customerId ? `cust:${customerId}` : null;

/** Home-currency value of a document amount (invoices, bills and checks may be in a foreign currency). */
const homeOf = (v: string, rate: string | null | undefined): Decimal =>
  rate && !Money.eq(rate, 1) ? Money.round2(Money.of(v).times(Money.of(rate))) : Money.of(v);

/** All revenue / cost facts tagged to a job or customer in the range (home currency). */
async function jobFacts(ctx: ServiceContext, range: { from?: Date; to?: Date }): Promise<JobFact[]> {
  const c = ctx.companyId;
  const out: JobFact[] = [];
  const dateConds = (col: Parameters<typeof gte>[0]) => {
    const conds: SQL[] = [];
    if (range.from) conds.push(gte(col, range.from));
    if (range.to) conds.push(lte(col, range.to));
    return conds;
  };
  for (const r of await ctx.db
    .select({ id: invoices.id, num: invoices.invoiceNumber, ref: invoices.refNumber, date: invoices.date, customerId: invoices.customerId, headJob: invoices.jobId, jobId: invoiceLines.jobId, item: items.name, memo: invoiceLines.description, qty: invoiceLines.quantity, amount: invoiceLines.amount, fx: invoices.exchangeRate })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .leftJoin(items, and(eq(invoiceLines.itemId, items.id), eq(items.companyId, c)))
    .where(and(eq(invoices.companyId, c), notInArray(invoices.status, ['void', 'draft']), REVENUE_LINE_ONLY, ...dateConds(invoices.date)))) {
    const k = keyOf(r.jobId ?? r.headJob, r.customerId);
    if (k) out.push({ kind: 'revenue', jobKey: k, date: r.date, type: 'Invoice', num: docRef(r.ref, r.num), sourceRef: `invoice:${r.id}`, itemOrAccount: r.item ?? r.memo ?? '', memo: r.memo ?? '', qty: Money.of(r.qty), amount: homeOf(r.amount, r.fx) });
  }
  // Invoice header discounts reduce the job's revenue (posted as a debit to income).
  for (const r of await ctx.db
    .select({ id: invoices.id, num: invoices.invoiceNumber, ref: invoices.refNumber, date: invoices.date, customerId: invoices.customerId, jobId: invoices.jobId, discount: invoices.discount, fx: invoices.exchangeRate })
    .from(invoices)
    .where(and(eq(invoices.companyId, c), notInArray(invoices.status, ['void', 'draft']), sql`${invoices.discount} <> 0`, ...dateConds(invoices.date)))) {
    const k = keyOf(r.jobId, r.customerId);
    if (k) out.push({ kind: 'revenue', jobKey: k, date: r.date, type: 'Invoice', num: docRef(r.ref, r.num), sourceRef: `invoice:${r.id}`, itemOrAccount: 'Discount', memo: 'Invoice discount', qty: Money.zero(), amount: homeOf(r.discount, r.fx).negated() });
  }
  for (const r of await ctx.db
    .select({ id: salesReceipts.id, num: salesReceipts.receiptNumber, ref: salesReceipts.refNumber, date: salesReceipts.date, customerId: salesReceipts.customerId, jobId: salesReceiptLines.jobId, item: items.name, memo: salesReceiptLines.description, qty: salesReceiptLines.quantity, amount: salesReceiptLines.amount })
    .from(salesReceiptLines)
    .innerJoin(salesReceipts, eq(salesReceiptLines.salesReceiptId, salesReceipts.id))
    .leftJoin(items, and(eq(salesReceiptLines.itemId, items.id), eq(items.companyId, c)))
    .where(and(eq(salesReceipts.companyId, c), ne(salesReceipts.status, 'void'), REVENUE_LINE_ONLY, ...dateConds(salesReceipts.date)))) {
    const k = keyOf(r.jobId, r.customerId);
    if (k) out.push({ kind: 'revenue', jobKey: k, date: r.date, type: 'Sales Receipt', num: docRef(r.ref, r.num), sourceRef: `salesreceipt:${r.id}`, itemOrAccount: r.item ?? r.memo ?? '', memo: r.memo ?? '', qty: Money.of(r.qty), amount: Money.of(r.amount) });
  }
  for (const r of await ctx.db
    .select({ id: creditMemos.id, num: creditMemos.memoNumber, ref: creditMemos.refNumber, date: creditMemos.date, customerId: creditMemos.customerId, item: items.name, memo: creditMemoLines.description, qty: creditMemoLines.quantity, amount: creditMemoLines.amount })
    .from(creditMemoLines)
    .innerJoin(creditMemos, eq(creditMemoLines.creditMemoId, creditMemos.id))
    .leftJoin(items, and(eq(creditMemoLines.itemId, items.id), eq(items.companyId, c)))
    .where(and(eq(creditMemos.companyId, c), ne(creditMemos.status, 'void'), REVENUE_LINE_ONLY, ...dateConds(creditMemos.date)))) {
    out.push({ kind: 'revenue', jobKey: `cust:${r.customerId}`, date: r.date, type: 'Credit Memo', num: docRef(r.ref, r.num), sourceRef: `credit_memo:${r.id}`, itemOrAccount: r.item ?? r.memo ?? '', memo: r.memo ?? '', qty: Money.of(r.qty).negated(), amount: Money.of(r.amount).negated() });
  }
  for (const r of await ctx.db
    .select({ id: bills.id, num: bills.billNumber, date: bills.date, customerId: billLines.customerId, jobId: billLines.jobId, item: items.name, account: accounts.name, memo: billLines.description, qty: billLines.quantity, amount: billLines.amount, fx: bills.exchangeRate })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .leftJoin(items, and(eq(billLines.itemId, items.id), eq(items.companyId, c)))
    .leftJoin(accounts, and(eq(billLines.accountId, accounts.id), eq(accounts.companyId, c)))
    .where(and(eq(bills.companyId, c), ne(bills.status, 'void'), or(isNotNull(billLines.jobId), isNotNull(billLines.customerId)), ...dateConds(bills.date)))) {
    const k = keyOf(r.jobId, r.customerId);
    if (k) out.push({ kind: 'cost', jobKey: k, date: r.date, type: 'Bill', num: r.num ?? '', sourceRef: `bill:${r.id}`, itemOrAccount: r.item ?? r.account ?? '', memo: r.memo ?? '', qty: Money.of(r.qty), amount: homeOf(r.amount, r.fx) });
  }
  for (const r of await ctx.db
    .select({ id: expenses.id, num: expenses.reference, date: expenses.date, customerId: expenseLines.customerId, jobId: expenseLines.jobId, account: accounts.name, memo: expenseLines.description, amount: expenseLines.amount, fx: expenses.exchangeRate })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .leftJoin(accounts, and(eq(expenseLines.accountId, accounts.id), eq(accounts.companyId, c)))
    .where(and(eq(expenses.companyId, c), isNull(expenses.voidedAt), or(isNotNull(expenseLines.jobId), isNotNull(expenseLines.customerId)), ...dateConds(expenses.date)))) {
    const k = keyOf(r.jobId, r.customerId);
    if (k) out.push({ kind: 'cost', jobKey: k, date: r.date, type: 'Check', num: r.num ?? '', sourceRef: `expense:${r.id}`, itemOrAccount: r.account ?? '', memo: r.memo ?? '', qty: Money.of(1), amount: homeOf(r.amount, r.fx) });
  }
  // Vendor credits costed to a job (returns, rebates) reduce its cost, as in QuickBooks.
  for (const r of await ctx.db
    .select({ id: vendorCredits.id, num: vendorCredits.refNumber, date: vendorCredits.date, customerId: vendorCreditLines.customerId, jobId: vendorCreditLines.jobId, item: items.name, account: accounts.name, memo: vendorCreditLines.description, qty: vendorCreditLines.quantity, amount: vendorCreditLines.amount, fx: vendorCredits.exchangeRate })
    .from(vendorCreditLines)
    .innerJoin(vendorCredits, eq(vendorCreditLines.vendorCreditId, vendorCredits.id))
    .leftJoin(items, and(eq(vendorCreditLines.itemId, items.id), eq(items.companyId, c)))
    .leftJoin(accounts, and(eq(vendorCreditLines.accountId, accounts.id), eq(accounts.companyId, c)))
    .where(and(eq(vendorCredits.companyId, c), ne(vendorCredits.status, 'void'), or(isNotNull(vendorCreditLines.jobId), isNotNull(vendorCreditLines.customerId)), ...dateConds(vendorCredits.date)))) {
    const k = keyOf(r.jobId, r.customerId);
    if (k) out.push({ kind: 'cost', jobKey: k, date: r.date, type: 'Credit', num: r.num ?? '', sourceRef: `vendor_credit:${r.id}`, itemOrAccount: r.item ?? r.account ?? '', memo: r.memo ?? '', qty: Money.of(r.qty ?? '1').negated(), amount: homeOf(r.amount, r.fx).negated() });
  }
  return out;
}

const PROFIT_COLS: StdColumn[] = [
  { key: 'label', header: '' },
  { key: 'cost', header: 'Act. Cost', type: 'money' },
  { key: 'revenue', header: 'Act. Revenue', type: 'money' },
  { key: 'diff', header: '($) Diff.', type: 'money' },
];

function optRange(p: ReportParams) {
  return { from: parseDay(p.from), to: parseDay(p.to, true) };
}

function rangeText(r: { from?: Date; to?: Date }) {
  return r.from && r.to ? rangeLabel(r.from, r.to) : 'All dates';
}

export async function jobProfitabilitySummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const range = optRange(p);
  const facts = await jobFacts(ctx, range);
  const { label } = await jobLabels(ctx);
  const sums = new Map<string, { cost: Decimal; revenue: Decimal }>();
  for (const f of facts) {
    const s = sums.get(f.jobKey) ?? { cost: Money.zero(), revenue: Money.zero() };
    s[f.kind] = s[f.kind].plus(f.amount);
    sums.set(f.jobKey, s);
  }
  let tc = Money.zero();
  let tr = Money.zero();
  const rows: StdRow[] = [...sums.entries()]
    .map(([k, v]) => ({ k, v, name: label(k) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ k, v, name }) => {
      tc = tc.plus(v.cost);
      tr = tr.plus(v.revenue);
      const [kind, id] = k.split(':');
      return {
        id: `jps:${k}`,
        depth: 0,
        kind: 'data' as const,
        cells: { label: name, cost: amt(v.cost), revenue: amt(v.revenue), diff: amt(v.revenue.minus(v.cost)) },
        href: stdHref('job-profitability-detail', { [kind === 'job' ? 'jobId' : 'customerId']: id, from: p.from, to: p.to }),
      };
    });
  rows.push({ id: 'jps:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', cost: amt(tc), revenue: amt(tr), diff: amt(tr.minus(tc)) } });
  return { key: 'job-profitability-summary', title: 'Job Profitability Summary', subtitle: rangeText(range), columns: PROFIT_COLS, rows };
}

export async function jobProfitabilityDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const range = optRange(p);
  const want = p.jobId ? `job:${p.jobId}` : p.customerId ? `cust:${p.customerId}` : null;
  const facts = (await jobFacts(ctx, range)).filter((f) => !want || f.jobKey === want);
  const { label } = await jobLabels(ctx);
  const entryIds = await entryIdsForSourceRefs(ctx, facts.map((f) => f.sourceRef));
  const rows: StdRow[] = [];
  let tc = Money.zero();
  let tr = Money.zero();
  const byJob = new Map<string, JobFact[]>();
  for (const f of facts) byJob.set(f.jobKey, [...(byJob.get(f.jobKey) ?? []), f]);
  for (const [k, list] of [...byJob.entries()].sort((a, b) => label(a[0]).localeCompare(label(b[0])))) {
    const hid = `jpd:${k}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: label(k) } };
    rows.push(header);
    let jc = Money.zero();
    let jr = Money.zero();
    // QB groups the job's lines by item (service / parts / other charges).
    const byItem = new Map<string, JobFact[]>();
    for (const f of list) byItem.set(f.itemOrAccount || '(no item)', [...(byItem.get(f.itemOrAccount || '(no item)') ?? []), f]);
    for (const [item, fl] of [...byItem.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const c = fl.filter((f) => f.kind === 'cost').reduce((s, f) => s.plus(f.amount), Money.zero());
      const r = fl.filter((f) => f.kind === 'revenue').reduce((s, f) => s.plus(f.amount), Money.zero());
      jc = jc.plus(c);
      jr = jr.plus(r);
      const iid = `${hid}:i:${item}`;
      rows.push({ id: iid, parentId: hid, depth: 1, kind: 'section', collapseKind: 'group', cells: { label: item }, collapsedCells: { label: item, cost: amt(c), revenue: amt(r), diff: amt(r.minus(c)) } });
      for (const f of fl.sort((a, b) => a.date.getTime() - b.date.getTime())) {
        rows.push({
          id: `${iid}:${f.sourceRef}:${rows.length}`,
          parentId: iid,
          depth: 2,
          kind: 'data',
          cells: {
            label: `${f.type} ${f.num ? `#${f.num}` : ''} · ${dayStr(f.date)}${f.memo && f.memo !== item ? ` · ${f.memo}` : ''}`,
            cost: f.kind === 'cost' ? amt(f.amount) : null,
            revenue: f.kind === 'revenue' ? amt(f.amount) : null,
          },
          entryId: entryIds.get(f.sourceRef) ?? null,
        });
      }
      rows.push({ id: `${iid}:total`, parentId: hid, depth: 1, kind: 'subtotal', totalOf: iid, cells: { label: `Total ${item}`, cost: amt(c), revenue: amt(r), diff: amt(r.minus(c)) } });
    }
    tc = tc.plus(jc);
    tr = tr.plus(jr);
    const tcells = { label: `Total ${label(k)}`, cost: amt(jc), revenue: amt(jr), diff: amt(jr.minus(jc)) };
    header.collapsedCells = { ...tcells, label: label(k) };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tcells });
  }
  rows.push({ id: 'jpd:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', cost: amt(tc), revenue: amt(tr), diff: amt(tr.minus(tc)) } });
  return { key: 'job-profitability-detail', title: 'Job Profitability Detail', subtitle: rangeText(range), columns: PROFIT_COLS, rows };
}

/** Estimate lines (accepted / open / closed estimates; rejected and void are excluded). */
async function estimateFacts(ctx: ServiceContext, range: { from?: Date; to?: Date }) {
  const conds: SQL[] = [eq(estimates.companyId, ctx.companyId), notInArray(estimates.status, ['void', 'rejected', 'draft']), REVENUE_LINE_ONLY];
  if (range.from) conds.push(gte(estimates.date, range.from));
  if (range.to) conds.push(lte(estimates.date, range.to));
  return ctx.db
    .select({ customerId: estimates.customerId, itemId: estimateLines.itemId, item: items.name, qty: estimateLines.quantity, amount: estimateLines.amount })
    .from(estimateLines)
    .innerJoin(estimates, eq(estimateLines.estimateId, estimates.id))
    .leftJoin(items, and(eq(estimateLines.itemId, items.id), eq(items.companyId, ctx.companyId)))
    .where(and(...conds));
}

export async function jobEstimatesVsActuals(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const range = optRange(p);
  const [est, facts, { names }] = await Promise.all([estimateFacts(ctx, range), jobFacts(ctx, range), jobLabels(ctx)]);
  const jobCustomer = new Map<string, string | null>();
  const jobRows = await ctx.db.select({ id: jobs.id, customerId: jobs.customerId }).from(jobs).where(eq(jobs.companyId, ctx.companyId));
  for (const j of jobRows) jobCustomer.set(j.id, j.customerId);
  const sums = new Map<string, { est: Decimal; rev: Decimal; cost: Decimal }>();
  const get = (id: string) => sums.get(id) ?? { est: Money.zero(), rev: Money.zero(), cost: Money.zero() };
  for (const e of est) {
    const s = get(e.customerId);
    s.est = s.est.plus(Money.of(e.amount));
    sums.set(e.customerId, s);
  }
  for (const f of facts) {
    const [kind, id] = f.jobKey.split(':');
    const cust = kind === 'job' ? jobCustomer.get(id) : id;
    if (!cust) continue;
    const s = get(cust);
    if (f.kind === 'revenue') s.rev = s.rev.plus(f.amount);
    else s.cost = s.cost.plus(f.amount);
    sums.set(cust, s);
  }
  const rows: StdRow[] = [];
  const t = { est: Money.zero(), rev: Money.zero(), cost: Money.zero() };
  for (const [id, s] of [...sums.entries()].sort((a, b) => (names.get(a[0])?.name ?? '').localeCompare(names.get(b[0])?.name ?? ''))) {
    t.est = t.est.plus(s.est);
    t.rev = t.rev.plus(s.rev);
    t.cost = t.cost.plus(s.cost);
    rows.push({
      id: `jeva:${id}`,
      depth: 0,
      kind: 'data',
      cells: {
        label: names.get(id)?.name ?? '',
        est: amt(s.est),
        rev: amt(s.rev),
        diff: amt(s.rev.minus(s.est)),
        pct: s.est.isZero() ? null : s.rev.dividedBy(s.est).times(100).toFixed(2),
        cost: amt(s.cost),
      },
      href: stdHref('job-profitability-detail', { customerId: id, from: p.from, to: p.to }),
    });
  }
  rows.push({
    id: 'jeva:grand',
    depth: 0,
    kind: 'grand',
    cells: { label: 'TOTAL', est: amt(t.est), rev: amt(t.rev), diff: amt(t.rev.minus(t.est)), pct: t.est.isZero() ? null : t.rev.dividedBy(t.est).times(100).toFixed(2), cost: amt(t.cost) },
  });
  return {
    key: 'job-estimates-vs-actuals',
    title: 'Job Estimates vs. Actuals Summary',
    subtitle: rangeText(range),
    columns: [
      { key: 'label', header: 'Customer:Job' },
      { key: 'est', header: 'Est. Revenue', type: 'money' },
      { key: 'rev', header: 'Act. Revenue', type: 'money' },
      { key: 'diff', header: '($) Diff.', type: 'money' },
      { key: 'pct', header: '% of Est. Rev.', type: 'percent' },
      { key: 'cost', header: 'Act. Cost', type: 'money' },
    ],
    rows,
    notes: ['Estimates record selling prices only, so estimated cost is not shown.'],
  };
}

export async function itemEstimatesVsActuals(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const range = optRange(p);
  const [est, facts] = await Promise.all([estimateFacts(ctx, range), jobFacts(ctx, range)]);
  const sums = new Map<string, { estQty: Decimal; est: Decimal; actQty: Decimal; act: Decimal }>();
  const get = (k: string) => sums.get(k) ?? { estQty: Money.zero(), est: Money.zero(), actQty: Money.zero(), act: Money.zero() };
  for (const e of est) {
    const k = e.item ?? '(no item)';
    const s = get(k);
    s.estQty = s.estQty.plus(Money.of(e.qty));
    s.est = s.est.plus(Money.of(e.amount));
    sums.set(k, s);
  }
  for (const f of facts) {
    if (f.kind !== 'revenue') continue;
    const k = f.itemOrAccount || '(no item)';
    const s = get(k);
    s.actQty = s.actQty.plus(f.qty);
    s.act = s.act.plus(f.amount);
    sums.set(k, s);
  }
  const rows: StdRow[] = [...sums.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, s]) => ({
      id: `ieva:${k}`,
      depth: 0,
      kind: 'data' as const,
      cells: { label: k, estQty: s.estQty.toFixed(4), actQty: s.actQty.toFixed(4), est: amt(s.est), act: amt(s.act), diff: amt(s.act.minus(s.est)) },
    }));
  const t = [...sums.values()].reduce((a, s) => ({ est: a.est.plus(s.est), act: a.act.plus(s.act) }), { est: Money.zero(), act: Money.zero() });
  rows.push({ id: 'ieva:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', est: amt(t.est), act: amt(t.act), diff: amt(t.act.minus(t.est)) } });
  return {
    key: 'item-estimates-vs-actuals',
    title: 'Item Estimates vs. Actuals',
    subtitle: rangeText(range),
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'estQty', header: 'Est. Qty', type: 'number' },
      { key: 'actQty', header: 'Act. Qty', type: 'number' },
      { key: 'est', header: 'Est. Revenue', type: 'money' },
      { key: 'act', header: 'Act. Revenue', type: 'money' },
      { key: 'diff', header: '($) Diff.', type: 'money' },
    ],
    rows,
  };
}

/** Unbilled Costs by Job — billable bill / expense lines and billable time not yet invoiced. */
export async function unbilledCostsByJob(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const c = ctx.companyId;
  const to = parseDay(p.to ?? p.asOf, true);
  const { label } = await jobLabels(ctx);
  type U = { jobKey: string; date: Date; type: string; num: string; memo: string; amount: Decimal; sourceRef?: string };
  const out: U[] = [];
  const toCond = (col: Parameters<typeof lte>[0]) => (to ? [lte(col, to)] : []);
  for (const r of await ctx.db
    .select({ id: bills.id, num: bills.billNumber, date: bills.date, customerId: billLines.customerId, jobId: billLines.jobId, memo: billLines.description, amount: billLines.amount, fx: bills.exchangeRate })
    .from(billLines)
    .innerJoin(bills, eq(billLines.billId, bills.id))
    .where(and(eq(bills.companyId, c), ne(bills.status, 'void'), isNotNull(billLines.customerId), isNull(billLines.billedInvoiceId), ...toCond(bills.date)))) {
    const k = keyOf(r.jobId, r.customerId)!;
    // Home currency, like Job Profitability (a EUR bill line is never added as dollars).
    out.push({ jobKey: k, date: r.date, type: 'Bill', num: r.num ?? '', memo: r.memo ?? '', amount: homeOf(r.amount, r.fx), sourceRef: `bill:${r.id}` });
  }
  for (const r of await ctx.db
    .select({ id: expenses.id, num: expenses.reference, date: expenses.date, customerId: expenseLines.customerId, jobId: expenseLines.jobId, memo: expenseLines.description, amount: expenseLines.amount, fx: expenses.exchangeRate })
    .from(expenseLines)
    .innerJoin(expenses, eq(expenseLines.expenseId, expenses.id))
    .where(and(eq(expenses.companyId, c), isNull(expenses.voidedAt), isNotNull(expenseLines.customerId), isNull(expenseLines.billedInvoiceId), ...toCond(expenses.date)))) {
    const k = keyOf(r.jobId, r.customerId)!;
    out.push({ jobKey: k, date: r.date, type: 'Check', num: r.num ?? '', memo: r.memo ?? '', amount: homeOf(r.amount, r.fx), sourceRef: `expense:${r.id}` });
  }
  for (const r of await ctx.db
    .select({ id: timeEntries.id, date: timeEntries.date, customerId: timeEntries.customerId, jobId: timeEntries.jobId, hours: timeEntries.hours, rate: timeEntries.rate, memo: timeEntries.description })
    .from(timeEntries)
    .where(and(eq(timeEntries.companyId, c), eq(timeEntries.billable, true), isNull(timeEntries.invoicedInvoiceId), ...toCond(timeEntries.date)))) {
    const k = keyOf(r.jobId, r.customerId);
    if (!k) continue;
    out.push({ jobKey: k, date: r.date, type: 'Time', num: '', memo: `${Money.of(r.hours).toFixed(2)} h${r.memo ? ` · ${r.memo}` : ''}`, amount: Money.round2(Money.of(r.hours).times(Money.of(r.rate ?? '0'))) });
  }
  const entryIds = await entryIdsForSourceRefs(ctx, out.map((u) => u.sourceRef ?? '').filter(Boolean));
  const rows: StdRow[] = [];
  let total = Money.zero();
  const groups = new Map<string, U[]>();
  for (const u of out) groups.set(u.jobKey, [...(groups.get(u.jobKey) ?? []), u]);
  for (const [k, list] of [...groups.entries()].sort((a, b) => label(a[0]).localeCompare(label(b[0])))) {
    const hid = `ubc:${k}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: label(k) } };
    rows.push(header);
    let sub = Money.zero();
    list.sort((a, b) => a.date.getTime() - b.date.getTime()).forEach((u, i) => {
      sub = sub.plus(u.amount);
      rows.push({
        id: `${hid}:${i}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: u.type, date: dayStr(u.date), num: u.num, memo: u.memo, amount: amt(u.amount) },
        entryId: u.sourceRef ? (entryIds.get(u.sourceRef) ?? null) : null,
        href: u.type === 'Time' ? '/time-tracking' : null,
      });
    });
    total = total.plus(sub);
    header.collapsedCells = { label: label(k), amount: amt(sub) };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${label(k)}`, amount: amt(sub) } });
  }
  rows.push({ id: 'ubc:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(total) } });
  return {
    key: 'unbilled-costs-by-job',
    title: 'Unbilled Costs by Job',
    subtitle: to ? `Through ${dayStr(to)}` : 'All dates',
    columns: [
      { key: 'label', header: '' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'memo', header: 'Memo' },
      { key: 'amount', header: 'Amount', type: 'money' },
    ],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Time & mileage
// ---------------------------------------------------------------------------

export async function timeReport(ctx: ServiceContext, p: ReportParams, by: 'job' | 'name' | 'item'): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const conds: SQL[] = [eq(timeEntries.companyId, ctx.companyId), gte(timeEntries.date, from), lte(timeEntries.date, to)];
  if (p.employeeId) conds.push(eq(timeEntries.employeeId, p.employeeId));
  if (p.customerId) conds.push(eq(timeEntries.customerId, p.customerId));
  if (p.jobId) conds.push(eq(timeEntries.jobId, p.jobId));
  if (p.itemId) conds.push(eq(timeEntries.serviceItemId, p.itemId));
  const rowsDb = await ctx.db
    .select({
      id: timeEntries.id,
      date: timeEntries.date,
      hours: timeEntries.hours,
      billable: timeEntries.billable,
      invoiced: timeEntries.invoicedInvoiceId,
      memo: timeEntries.description,
      customerId: timeEntries.customerId,
      jobId: timeEntries.jobId,
      employeeId: timeEntries.employeeId,
      first: employees.firstName,
      last: employees.lastName,
      item: items.name,
    })
    .from(timeEntries)
    .leftJoin(employees, and(eq(timeEntries.employeeId, employees.id), eq(employees.companyId, ctx.companyId)))
    .leftJoin(items, and(eq(timeEntries.serviceItemId, items.id), eq(items.companyId, ctx.companyId)))
    .where(and(...conds));
  const { label } = await jobLabels(ctx);
  const jobOf = (r: (typeof rowsDb)[number]) => {
    const k = keyOf(r.jobId, r.customerId);
    return k ? label(k) : '(no customer:job)';
  };
  const empOf = (r: (typeof rowsDb)[number]) => (r.employeeId ? `${r.first ?? ''} ${r.last ?? ''}`.trim() : '(no name)');
  const itemOf = (r: (typeof rowsDb)[number]) => r.item ?? '(no service item)';
  const outer = by === 'job' ? jobOf : by === 'name' ? empOf : itemOf;
  const inner = by === 'job' ? itemOf : by === 'name' ? jobOf : jobOf;
  const detail = p.view === 'detail';
  const rows: StdRow[] = [];
  let total = Money.zero();
  const groups = new Map<string, typeof rowsDb>();
  for (const r of rowsDb) groups.set(outer(r), [...(groups.get(outer(r)) ?? []), r]);
  for (const [g, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hid = `t:${g}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g } };
    rows.push(header);
    let sub = Money.zero();
    const innerGroups = new Map<string, typeof rowsDb>();
    for (const r of list) innerGroups.set(inner(r), [...(innerGroups.get(inner(r)) ?? []), r]);
    for (const [ig, il] of [...innerGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const h = il.reduce((s, r) => s.plus(Money.of(r.hours)), Money.zero());
      sub = sub.plus(h);
      if (!detail) {
        rows.push({ id: `${hid}:${ig}`, parentId: hid, depth: 1, kind: 'data', cells: { label: ig, hours: h.toFixed(2) } });
        continue;
      }
      const iid = `${hid}:${ig}`;
      rows.push({ id: iid, parentId: hid, depth: 1, kind: 'section', collapseKind: 'group', cells: { label: ig }, collapsedCells: { label: ig, hours: h.toFixed(2) } });
      for (const r of il.sort((a, b) => a.date.getTime() - b.date.getTime())) {
        rows.push({
          id: `${iid}:${r.id}`,
          parentId: iid,
          depth: 2,
          kind: 'data',
          cells: {
            label: '',
            date: dayStr(r.date),
            name: by === 'name' ? itemOf(r) : empOf(r),
            memo: r.memo ?? '',
            billing: r.invoiced ? 'Billed' : r.billable ? 'Unbilled' : 'Not Billable',
            hours: Money.of(r.hours).toFixed(2),
          },
          href: '/time-tracking',
        });
      }
      rows.push({ id: `${iid}:total`, parentId: hid, depth: 1, kind: 'subtotal', totalOf: iid, cells: { label: `Total ${ig}`, hours: h.toFixed(2) } });
    }
    total = total.plus(sub);
    header.collapsedCells = { label: g, hours: sub.toFixed(2) };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${g}`, hours: sub.toFixed(2) } });
  }
  rows.push({ id: 't:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', hours: total.toFixed(2) } });
  const title = by === 'job' ? 'Time by Job' : by === 'name' ? 'Time by Name' : 'Time by Item';
  return {
    key: `time-by-${by}`,
    title: `${title} ${detail ? 'Detail' : 'Summary'}`,
    subtitle: rangeLabel(from, to),
    columns: detail
      ? [
          { key: 'label', header: '' },
          { key: 'date', header: 'Date', type: 'date' },
          { key: 'name', header: by === 'name' ? 'Service Item' : 'Name' },
          { key: 'memo', header: 'Notes' },
          { key: 'billing', header: 'Billing Status' },
          { key: 'hours', header: 'Duration (h)', type: 'number' },
        ]
      : [
          { key: 'label', header: '' },
          { key: 'hours', header: 'Hours', type: 'number' },
        ],
    rows,
  };
}

export async function mileageReport(ctx: ServiceContext, p: ReportParams, by: 'job' | 'vehicle'): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const conds: SQL[] = [eq(mileageLogs.companyId, ctx.companyId), gte(mileageLogs.date, from), lte(mileageLogs.date, to)];
  if (p.customerId) conds.push(eq(mileageLogs.customerId, p.customerId));
  // The vehicle is the Vehicle list entry (wave2 lists, mileage_logs.vehicle_id) when the trip has
  // one, else the free-text vehicle (wave2 reports, mileage_logs.vehicle).
  const rowsDb = (
    await ctx.db
      .select({ log: mileageLogs, vehicleName: vehicles.name })
      .from(mileageLogs)
      .leftJoin(vehicles, and(eq(vehicles.id, mileageLogs.vehicleId), eq(vehicles.companyId, ctx.companyId)))
      .where(and(...conds))
  )
    .map((r) => ({ ...r.log, vehicle: r.vehicleName ?? r.log.vehicle }))
    .filter((r) => !p.vehicle || r.vehicle === p.vehicle);
  const { label } = await jobLabels(ctx);
  const groupOf = (r: (typeof rowsDb)[number]) => {
    if (by === 'vehicle') return r.vehicle?.trim() || '(no vehicle)';
    const k = keyOf(r.jobId, r.customerId);
    return k ? label(k) : '(no customer:job)';
  };
  const detail = p.view === 'detail';
  const rows: StdRow[] = [];
  let tMiles = Money.zero();
  let tAmt = Money.zero();
  const groups = new Map<string, typeof rowsDb>();
  for (const r of rowsDb) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  for (const [g, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let miles = Money.zero();
    let amount = Money.zero();
    for (const r of list) {
      miles = miles.plus(Money.of(r.miles));
      amount = amount.plus(Money.round2(Money.of(r.miles).times(Money.of(r.ratePerMile))));
    }
    tMiles = tMiles.plus(miles);
    tAmt = tAmt.plus(amount);
    if (!detail) {
      rows.push({ id: `m:${g}`, depth: 0, kind: 'data', cells: { label: g, miles: miles.toFixed(2), amount: amt(amount) } });
      continue;
    }
    const hid = `m:${g}`;
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g }, collapsedCells: { label: g, miles: miles.toFixed(2), amount: amt(amount) } });
    for (const r of list.sort((a, b) => a.date.getTime() - b.date.getTime())) {
      rows.push({
        id: `${hid}:${r.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: {
          label: '',
          date: dayStr(r.date),
          other: by === 'vehicle' ? (keyOf(r.jobId, r.customerId) ? label(keyOf(r.jobId, r.customerId)!) : '') : (r.vehicle ?? ''),
          memo: r.purpose ?? '',
          billable: r.billable ? 'Billable' : '',
          miles: Money.of(r.miles).toFixed(2),
          rate: Money.of(r.ratePerMile).toFixed(4),
          amount: amt(Money.round2(Money.of(r.miles).times(Money.of(r.ratePerMile)))),
        },
        href: '/mileage',
      });
    }
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${g}`, miles: miles.toFixed(2), amount: amt(amount) } });
  }
  rows.push({ id: 'm:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', miles: tMiles.toFixed(2), amount: amt(tAmt) } });
  return {
    key: `mileage-by-${by}`,
    title: `Mileage by ${by === 'job' ? 'Job' : 'Vehicle'} ${detail ? 'Detail' : 'Summary'}`,
    subtitle: rangeLabel(from, to),
    columns: detail
      ? [
          { key: 'label', header: '' },
          { key: 'date', header: 'Trip Date', type: 'date' },
          { key: 'other', header: by === 'vehicle' ? 'Customer:Job' : 'Vehicle' },
          { key: 'memo', header: 'Notes' },
          { key: 'billable', header: 'Billing Status' },
          { key: 'miles', header: 'Total Miles', type: 'number' },
          { key: 'rate', header: 'Rate', type: 'number' },
          { key: 'amount', header: 'Amount', type: 'money' },
        ]
      : [
          { key: 'label', header: '' },
          { key: 'miles', header: 'Total Miles', type: 'number' },
          { key: 'amount', header: 'Amount', type: 'money' },
        ],
    rows,
  };
}
