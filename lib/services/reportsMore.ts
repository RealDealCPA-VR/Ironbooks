/**
 * Report gaps round: the reports that only had their own legacy pages, plus the QuickBooks
 * reports Ironbooks did not have yet, on the standard report engine (lib/reports/catalog.ts), so
 * every one can be memorized, put in a memorized group, processed with Process Multiple Reports,
 * scheduled, filtered, number-formatted and QuickZoomed:
 *
 *  - Sales by Rep Summary / Detail (invoices carry the rep; commission at the rep's rate),
 *  - Check Detail, Deposit Detail, Missing Checks (banking),
 *  - Inventory Valuation Summary / Detail, Inventory Stock Status by Item / by Vendor, Physical
 *    Inventory Worksheet, Quantity on Hand / Stock Status / Reorder by Site, Serial / Lot Numbers
 *    in Stock and Transactions by Serial / Lot Number (inventory),
 *  - Payroll Summary, Employee Earnings Summary, Payroll Detail, Payroll Item Detail, Payroll
 *    Liability Balances and the Employee Contact List (payroll),
 *  - Voided/Deleted Transactions Summary / Detail and the Closing Date Exception Report (audit),
 *  - Sales Tax Revenue Summary,
 *  - Cash Flow Forecast.
 *
 * The figures come from the same services the legacy pages used (reportsExtra, inventory,
 * inventorySiteReports, payrollReports, accountant/auditReports, accountant/salesTaxLedger), so
 * the numbers do not change by moving them; this module only lays them out as StdReports.
 * Money is Decimal throughout; everything is company-scoped by the services it calls.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  employees,
  inventorySites,
  invoices,
  items,
  purchaseOrderLines,
  purchaseOrders,
  salesReps,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { CellValue, StdColumn, StdReport, StdRow } from '@/lib/reports/types';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { validation } from './_base';
import { taxIdFor } from './access';
import { getPreferences } from './company';
import { localDateTime } from '@/lib/reports/dates';
import {
  activityByAccount,
  dayStr,
  endOfToday,
  entryIdsForSourceRefs,
  fmtDay,
  inIds,
  loadAccountMeta,
  localToday,
  parseDay,
  resolveAsOf,
  resolveRange,
  stdHref,
} from './reportEngine';
import { rangeLabel } from './reportsStandard';
import { salesLinesOnBasis, type SalesLine } from './reportsLists';
import { apAgingDetail, arAgingDetail, checkDetail, depositDetail, missingChecks } from './reportsExtra';
import { inventoryValuation, inventoryValuationAsOf, inventoryValuationDetail, stockStatus } from './inventory';
import {
  quantityOnHandBySite,
  reorderBySite,
  serialLotInStock,
  stockStatusBySite,
  transactionsBySerialLot,
} from './inventorySiteReports';
import {
  employeeEarningsSummary,
  payrollDetail,
  payrollItemDetail,
  payrollLiabilityBalances,
  payrollSummary,
} from './payrollReports';
import { closingDateExceptionReport, voidedDeletedTransactions } from './accountant/auditReports';
import { salesTaxRevenueSummary } from './accountant/salesTaxLedger';

const amt = (v: Decimal) => toAmountString(v);
const money = (v: string | number | null | undefined) => Money.of(v ?? '0');
const qty4 = (v: Decimal) => v.toFixed(4);
const DAY_MS = 86_400_000;

/** The report's range on the company calendar as YYYY-MM-DD strings (for links). */
const qsRange = (from: Date, to: Date) => ({ from: dayStr(from), to: dayStr(to) });

// ===========================================================================
// Sales by Rep
// ===========================================================================

/** The sales rep of each sales line's document (only invoices carry a rep). */
async function repsOfLines(ctx: ServiceContext, lines: SalesLine[]): Promise<Map<string, string | null>> {
  const invoiceIds = [...new Set(lines.filter((l) => l.sourceRef.startsWith('invoice:')).map((l) => l.sourceRef.slice('invoice:'.length)))];
  const out = new Map<string, string | null>();
  for (let i = 0; i < invoiceIds.length; i += 5000) {
    for (const r of await ctx.db
      .select({ id: invoices.id, rep: invoices.salesRepId })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), inIds(invoices.id, invoiceIds.slice(i, i + 5000))))) {
      out.set(`invoice:${r.id}`, r.rep);
    }
  }
  return out;
}

const NO_REP = 'none';

async function salesByRepLines(ctx: ServiceContext, p: ReportParams) {
  const { from, to } = await resolveRange(ctx, p);
  const lines = await salesLinesOnBasis(ctx, { from, to }, { customerId: p.customerId, itemId: p.itemId, classId: p.classId }, p.basis);
  const repOf = await repsOfLines(ctx, lines);
  const reps = await ctx.db.select().from(salesReps).where(eq(salesReps.companyId, ctx.companyId));
  const repById = new Map(reps.map((r) => [r.id, r]));
  const keyed = lines
    .map((l) => ({ l, rep: repOf.get(l.sourceRef) ?? null }))
    .map((x) => ({ ...x, key: x.rep && repById.has(x.rep) ? x.rep : NO_REP }))
    .filter((x) => !p.repId || x.key === p.repId);
  return { from, to, keyed, repById };
}

/**
 * Sales by Rep Summary (QB Reports > Sales): sales per sales rep in the period, on the report's
 * basis, with the commission each rep earned at their commission rate. Sales without a rep are
 * listed as "No sales rep", so the TOTAL ties to Sales by Customer Summary.
 */
export async function salesByRepSummary(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to, keyed, repById } = await salesByRepLines(ctx, p);
  const totals = new Map<string, Decimal>();
  for (const { l, key } of keyed) totals.set(key, (totals.get(key) ?? Money.zero()).plus(l.amount));
  let grand = Money.zero();
  let grandCommission = Money.zero();
  const rows: StdRow[] = [...totals.entries()]
    .map(([key, total]) => ({ key, total, rep: repById.get(key) }))
    .sort((a, b) => (a.key === NO_REP ? 1 : b.key === NO_REP ? -1 : (a.rep?.name ?? '').localeCompare(b.rep?.name ?? '')))
    .map(({ key, total, rep }) => {
      const rate = rep ? money(rep.commissionRate) : null;
      const commission = rate ? Money.round2(total.times(rate)) : null;
      grand = grand.plus(total);
      if (commission) grandCommission = grandCommission.plus(commission);
      return {
        id: `sbr:${key}`,
        depth: 0,
        kind: 'data' as const,
        cells: {
          label: rep?.name ?? 'No sales rep',
          sales: amt(total),
          rate: rate ? rate.times(100).toFixed(2) : null,
          commission: commission ? amt(commission) : null,
        },
        href: stdHref('sales-by-rep-detail', { ...qsRange(from, to), repId: key, basis: p.basis, customerId: p.customerId, itemId: p.itemId, classId: p.classId }),
      };
    });
  rows.push({ id: 'sbr:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', sales: amt(grand), commission: amt(grandCommission) } });
  return {
    key: 'sales-by-rep-summary',
    title: 'Sales by Rep Summary',
    subtitle: `${rangeLabel(from, to)}${p.basis === 'cash' ? ' · Cash Basis' : ''}`,
    columns: [
      { key: 'label', header: 'Sales Rep' },
      { key: 'sales', header: 'Sales', type: 'money' },
      { key: 'rate', header: 'Commission Rate', type: 'percent' },
      { key: 'commission', header: 'Commission', type: 'money' },
    ],
    rows,
    notes: ['Sales reps are set on invoices. Sales receipts and credit memos carry no rep, so they show under "No sales rep".'],
  };
}

/** Sales by Rep Detail: every sales line, grouped by the rep of its invoice. */
export async function salesByRepDetail(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to, keyed, repById } = await salesByRepLines(ctx, p);
  const entryIds = await entryIdsForSourceRefs(ctx, keyed.map((x) => x.l.sourceRef));
  const groups = new Map<string, SalesLine[]>();
  for (const { l, key } of keyed) groups.set(key, [...(groups.get(key) ?? []), l]);
  const rows: StdRow[] = [];
  let grand = Money.zero();
  let grandQty = Money.zero();
  const order = [...groups.keys()].sort((a, b) =>
    a === NO_REP ? 1 : b === NO_REP ? -1 : (repById.get(a)?.name ?? '').localeCompare(repById.get(b)?.name ?? ''),
  );
  for (const key of order) {
    const list = groups.get(key)!;
    const label = repById.get(key)?.name ?? 'No sales rep';
    const hid = `sbrd:${key}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label } };
    rows.push(header);
    let sum = Money.zero();
    let q = Money.zero();
    for (const l of list) {
      sum = sum.plus(l.amount);
      q = q.plus(l.qty);
      rows.push({
        id: `sbrd:l:${l.id}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', type: l.type, date: dayStr(l.date), num: l.num, item: l.item, memo: l.memo, qty: qty4(l.qty), price: amt(l.price), amount: amt(l.amount), balance: amt(sum) },
        entryId: l.entryId ?? entryIds.get(l.sourceRef) ?? null,
      });
    }
    grand = grand.plus(sum);
    grandQty = grandQty.plus(q);
    const tc = { label: `Total ${label}`, qty: qty4(q), amount: amt(sum), balance: amt(sum) };
    header.collapsedCells = { ...tc, label };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  rows.push({ id: 'sbrd:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', qty: qty4(grandQty), amount: amt(grand), balance: amt(grand) } });
  return {
    key: 'sales-by-rep-detail',
    title: 'Sales by Rep Detail',
    subtitle: `${rangeLabel(from, to)}${p.basis === 'cash' ? ' · Cash Basis' : ''}`,
    columns: [
      { key: 'label', header: '' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Num' },
      { key: 'item', header: 'Item' },
      { key: 'memo', header: 'Memo' },
      { key: 'qty', header: 'Qty', type: 'number' },
      { key: 'price', header: 'Sales Price', type: 'money' },
      { key: 'amount', header: 'Amount', type: 'money' },
      { key: 'balance', header: 'Balance', type: 'money' },
    ],
    rows,
  };
}

// ===========================================================================
// Banking: Check Detail, Deposit Detail, Missing Checks
// ===========================================================================

const CHECK_TYPE: Record<string, string> = {
  expense: 'Check',
  bill_payment: 'Bill Pmt -Check',
  payment_check: 'Check',
  paycheck: 'Paycheck',
  bank_transaction: 'Check',
};

/**
 * Check Detail (QB Reports > Banking): every check written in the period — write-check
 * expenses, bill payments by check, sales tax / liability / refund checks, paychecks and
 * bank-feed withdrawals — with the split lines under each check. Voided checks are listed at
 * zero (QB keeps the number). The TOTAL is the home-currency amount of the checks.
 */
export async function checkDetailStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const r = await checkDetail(ctx, { from, to });
  const list = p.accountId ? r.rows.filter((x) => x.bankAccountId === p.accountId) : r.rows;
  const rows: StdRow[] = [];
  let total = Money.zero();
  for (const c of list) {
    const home = money(c.homeAmount ?? c.amount);
    const foreign = !Money.eq(home, money(c.amount));
    const hid = `chk:${c.source}:${c.id}`;
    if (!c.voided) total = total.plus(home);
    const header: StdRow = {
      id: hid,
      depth: 0,
      kind: 'section',
      collapseKind: 'group',
      cells: {
        label: CHECK_TYPE[c.source] ?? 'Check',
        date: c.date.slice(0, 10),
        num: c.checkNumber ?? '',
        name: c.payee ?? '',
        account: c.bankAccountName,
        memo: c.voided ? 'VOID' : foreign ? `${c.amount} in the account's currency` : '',
        amount: c.voided ? '0.00' : amt(home),
      },
      entryId: c.entryId ?? null,
    };
    rows.push(header);
    if (c.voided) continue;
    for (const [i, l] of c.lines.entries()) {
      rows.push({
        id: `${hid}:${i}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', account: l.detail, memo: l.description ?? '', amount: foreign ? null : amt(money(l.amount)), original: foreign ? amt(money(l.amount)) : null },
        entryId: c.entryId ?? null,
      });
    }
  }
  rows.push({ id: 'chk:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(total) } });
  const hasForeign = list.some((c) => !Money.eq(money(c.homeAmount ?? c.amount), money(c.amount)));
  const columns: StdColumn[] = [
    { key: 'label', header: 'Type' },
    { key: 'date', header: 'Date', type: 'date' },
    { key: 'num', header: 'Num' },
    { key: 'name', header: 'Name' },
    { key: 'account', header: 'Account' },
    { key: 'memo', header: 'Memo' },
    { key: 'amount', header: 'Paid Amount', type: 'money' },
  ];
  if (hasForeign) columns.push({ key: 'original', header: 'Original Amount', type: 'money' });
  return {
    key: 'check-detail',
    title: 'Check Detail',
    subtitle: rangeLabel(from, to),
    columns,
    rows,
    notes: hasForeign ? ['Checks from a foreign-currency bank account show their split lines in that account’s currency under Original Amount.'] : undefined,
  };
}

/**
 * Deposit Detail (QB Reports > Banking): every deposit in the period with the payments and
 * lines it holds; bank-feed deposits included; voided deposits listed at zero.
 */
export async function depositDetailStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const r = await depositDetail(ctx, { from, to });
  const list = p.accountId ? r.rows.filter((x) => x.accountId === p.accountId) : r.rows;
  const rows: StdRow[] = [];
  let total = Money.zero();
  for (const d of list) {
    const home = money(d.homeTotal ?? d.total);
    const foreign = !Money.eq(home, money(d.total));
    if (!d.voided) total = total.plus(home);
    const hid = `dep:${d.source ?? 'deposit'}:${d.id}`;
    rows.push({
      id: hid,
      depth: 0,
      kind: 'section',
      collapseKind: 'group',
      cells: {
        label: 'Deposit',
        date: d.date.slice(0, 10),
        name: '',
        account: d.accountName,
        memo: d.voided ? 'VOID' : [d.memo ?? '', foreign ? `${d.total} in the account's currency` : ''].filter(Boolean).join(' · '),
        amount: d.voided ? '0.00' : amt(home),
      },
      entryId: d.entryId ?? null,
    });
    if (d.voided) continue;
    for (const [i, l] of d.lines.entries()) {
      rows.push({
        id: `${hid}:${i}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', name: l.customerName ?? '', account: l.accountName ?? '', memo: l.description ?? '', amount: foreign ? null : amt(money(l.amount)), original: foreign ? amt(money(l.amount)) : null },
        entryId: d.entryId ?? null,
      });
    }
  }
  rows.push({ id: 'dep:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', amount: amt(total) } });
  const hasForeign = list.some((d) => !Money.eq(money(d.homeTotal ?? d.total), money(d.total)));
  const columns: StdColumn[] = [
    { key: 'label', header: 'Type' },
    { key: 'date', header: 'Date', type: 'date' },
    { key: 'name', header: 'Name' },
    { key: 'account', header: 'Account' },
    { key: 'memo', header: 'Memo' },
    { key: 'amount', header: 'Amount', type: 'money' },
  ];
  if (hasForeign) columns.push({ key: 'original', header: 'Original Amount', type: 'money' });
  return { key: 'deposit-detail', title: 'Deposit Detail', subtitle: rangeLabel(from, to), columns, rows };
}

/**
 * Missing Checks (QB Reports > Banking): for each bank account, the run of check numbers used
 * and every gap in it (a voided check still uses its number).
 */
export async function missingChecksStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const r = await missingChecks(ctx, p.accountId);
  const rows: StdRow[] = [];
  let missingTotal = 0;
  for (const a of r.accounts) {
    const hid = `mc:${a.accountId}`;
    const header: StdRow = {
      id: hid,
      depth: 0,
      kind: 'section',
      collapseKind: 'group',
      cells: { label: a.accountName },
      href: stdHref('check-detail', { accountId: a.accountId, from: '1900-01-01' }),
    };
    rows.push(header);
    rows.push({ id: `${hid}:range`, parentId: hid, depth: 1, kind: 'data', cells: { label: 'Check numbers used', first: a.firstNumber, last: a.lastNumber, count: a.checkCount } });
    for (const m of a.missing) {
      rows.push({
        id: `${hid}:m:${m.from}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: m.count === 1 ? '*** Missing check ***' : '*** Missing checks ***', first: m.from, last: m.to, count: m.count },
      });
    }
    missingTotal += a.missingCount;
    const tc = { label: `Total missing — ${a.accountName}`, count: a.missingCount };
    header.collapsedCells = { label: a.accountName, count: a.missingCount };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  rows.push({ id: 'mc:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL MISSING', count: missingTotal } });
  return {
    key: 'missing-checks',
    title: 'Missing Checks',
    subtitle: 'All dates',
    columns: [
      { key: 'label', header: 'Account' },
      { key: 'first', header: 'From number', type: 'text' },
      { key: 'last', header: 'To number', type: 'text' },
      { key: 'count', header: 'Checks', type: 'number' },
    ],
    rows,
    notes: ['Counts write-check expenses, bill payments by check, sales tax / liability / refund checks and numbered paychecks. Voided checks use their number.'],
  };
}

// ===========================================================================
// Inventory
// ===========================================================================

async function itemInfo(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({
      id: items.id,
      name: items.name,
      description: items.description,
      salesPrice: items.salesPrice,
      reorderPoint: items.reorderPoint,
      vendorId: items.preferredVendorId,
      vendor: vendors.displayName,
      isActive: items.isActive,
    })
    .from(items)
    .leftJoin(vendors, eq(items.preferredVendorId, vendors.id))
    .where(and(eq(items.companyId, ctx.companyId), eq(items.type, 'inventory')));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Inventory Valuation Summary: on hand, average cost, asset value (ties to the inventory asset
 * accounts) and retail value per item — today, or reconstructed from the ledger at an earlier
 * as-of date (quantities then are approximate: value / current cost).
 */
export async function inventoryValuationSummaryStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const today = localToday();
  const past = dayStr(asOf) < today;
  const info = await itemInfo(ctx);
  const rows: StdRow[] = [];
  let totalValue = Money.zero();
  let totalRetail = Money.zero();
  const lines: { id: string; name: string; qty: Decimal | null; cost: Decimal | null; value: Decimal; retail: Decimal | null; price: Decimal | null }[] = [];
  const notes: string[] = [];
  if (past) {
    const r = await inventoryValuationAsOf(ctx, asOf);
    notes.push(...r.notes);
    for (const it of r.items) {
      const price = info.get(it.id)?.salesPrice != null ? money(info.get(it.id)!.salesPrice) : null;
      const q = it.quantityAsOf != null ? money(it.quantityAsOf) : null;
      lines.push({ id: it.id, name: it.name, qty: q, cost: it.unitCostUsed != null ? money(it.unitCostUsed) : null, value: money(it.valueAsOf), retail: price && q ? Money.round2(price.times(q)) : null, price });
    }
  } else {
    const r = await inventoryValuation(ctx);
    for (const it of r.items) {
      const price = info.get(it.id)?.salesPrice != null ? money(info.get(it.id)!.salesPrice) : null;
      const q = money(it.quantityOnHand);
      lines.push({ id: it.id, name: it.name, qty: q, cost: money(it.averageCost), value: money(it.totalValue), retail: price ? Money.round2(price.times(q)) : null, price });
    }
  }
  const filtered = p.itemId ? lines.filter((l) => l.id === p.itemId) : lines;
  for (const l of filtered) {
    totalValue = totalValue.plus(l.value);
    if (l.retail) totalRetail = totalRetail.plus(l.retail);
  }
  const pctOf = (v: Decimal | null, t: Decimal) => (v && !t.isZero() ? v.dividedBy(t.abs()).times(100).toFixed(2) : null);
  for (const l of filtered.sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push({
      id: `ivs:${l.id}`,
      depth: 0,
      kind: 'data',
      cells: {
        label: l.name,
        description: info.get(l.id)?.description ?? '',
        onHand: l.qty ? qty4(l.qty) : null,
        avgCost: l.cost ? l.cost.toFixed(2) : null,
        value: amt(l.value),
        pctValue: pctOf(l.value, totalValue),
        price: l.price ? amt(l.price) : null,
        retail: l.retail ? amt(l.retail) : null,
        pctRetail: pctOf(l.retail, totalRetail),
      },
      href: stdHref('inventory-valuation-detail', { itemId: l.id, to: dayStr(asOf), from: '1900-01-01' }),
    });
  }
  rows.push({ id: 'ivs:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', value: amt(totalValue), pctValue: totalValue.isZero() ? null : '100.00', retail: amt(totalRetail), pctRetail: totalRetail.isZero() ? null : '100.00' } });
  return {
    key: 'inventory-valuation-summary',
    title: 'Inventory Valuation Summary',
    subtitle: `As of ${fmtDay(asOf)}`,
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'description', header: 'Description' },
      { key: 'onHand', header: 'On Hand', type: 'number' },
      { key: 'avgCost', header: 'Avg Cost', type: 'money' },
      { key: 'value', header: 'Asset Value', type: 'money' },
      { key: 'pctValue', header: '% of Tot Asset', type: 'percent' },
      { key: 'price', header: 'Sales Price', type: 'money' },
      { key: 'retail', header: 'Retail Value', type: 'money' },
      { key: 'pctRetail', header: '% of Tot Retail', type: 'percent' },
    ],
    rows,
    notes: notes.length ? notes : undefined,
  };
}

/** Inventory Valuation Detail: each item's value movements with a running asset value. */
export async function inventoryValuationDetailStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const r = await inventoryValuationDetail(ctx, { itemId: p.itemId ?? null, from, to });
  const rows: StdRow[] = [];
  let grand = Money.zero();
  for (const it of r.items) {
    if (it.movements.length === 0 && money(it.openingValue).isZero() && money(it.closingValue).isZero()) continue;
    const hid = `ivd:${it.itemId}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: it.name } };
    rows.push(header);
    rows.push({ id: `${hid}:open`, parentId: hid, depth: 1, kind: 'data', cells: { label: 'Beginning value', balance: amt(money(it.openingValue)) } });
    for (const m of it.movements) {
      rows.push({
        id: `${hid}:${m.entryId}:${m.entryNumber}:${m.date}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: '', date: m.date.slice(0, 10), num: String(m.entryNumber), memo: m.description, qty: m.approxQty, amount: amt(money(m.delta)), balance: amt(money(m.runningValue)) },
        entryId: m.entryId,
      });
    }
    grand = grand.plus(money(it.closingValue));
    const tc = { label: `Total ${it.name}`, balance: amt(money(it.closingValue)) };
    header.collapsedCells = { label: it.name, balance: tc.balance };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  rows.push({ id: 'ivd:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', balance: amt(grand) } });
  return {
    key: 'inventory-valuation-detail',
    title: 'Inventory Valuation Detail',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: '' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'num', header: 'Entry #' },
      { key: 'memo', header: 'Description' },
      { key: 'qty', header: 'Qty (approx.)', type: 'number' },
      { key: 'amount', header: 'Value', type: 'money' },
      { key: 'balance', header: 'Asset Value', type: 'money' },
    ],
    rows,
    notes: r.notes.length ? r.notes : undefined,
  };
}

/** Next expected delivery (open purchase order line with quantity still to come) per item. */
async function nextDeliveries(ctx: ServiceContext): Promise<Map<string, Date>> {
  const rows = await ctx.db
    .select({
      itemId: purchaseOrderLines.itemId,
      next: sql<Date>`MIN(COALESCE(${purchaseOrders.expectedDate}, ${purchaseOrders.date}))`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
    .where(
      and(
        eq(purchaseOrders.companyId, ctx.companyId),
        inArray(purchaseOrders.status, ['open', 'partial']),
        isNotNull(purchaseOrderLines.itemId),
        sql`${purchaseOrderLines.quantity} > ${purchaseOrderLines.quantityBilled}`,
      ),
    )
    .groupBy(purchaseOrderLines.itemId);
  return new Map(rows.filter((r) => r.itemId && r.next).map((r) => [r.itemId!, new Date(r.next)]));
}

/** Units sold per item in [from, to] (invoices + sales receipts − credit memos). */
async function unitsSold(ctx: ServiceContext, from: Date, to: Date): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  for (const l of await salesLinesOnBasis(ctx, { from, to }, {}, 'accrual')) {
    if (!l.itemId) continue;
    out.set(l.itemId, (out.get(l.itemId) ?? Money.zero()).plus(l.qty));
  }
  return out;
}

/**
 * Inventory Stock Status by Item / by Vendor (QB Reports > Inventory): description, preferred
 * vendor, reorder point, on hand, on sales order, available, on purchase order, an Order flag
 * when (available + on PO) is at or below the reorder point, the next delivery date and the
 * average sales per week over the report dates.
 */
async function stockStatusStd(ctx: ServiceContext, p: ReportParams, by: 'item' | 'vendor'): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const [status, info, next, sold] = await Promise.all([stockStatus(ctx), itemInfo(ctx), nextDeliveries(ctx), unitsSold(ctx, from, to)]);
  const weeks = Math.max(1, (to.getTime() - from.getTime() + 1) / (7 * DAY_MS));
  let list = status.rows;
  if (p.itemId) list = list.filter((r) => r.id === p.itemId);
  if (p.vendorId) list = list.filter((r) => info.get(r.id)?.vendorId === p.vendorId);
  const rowOf = (r: (typeof list)[number], parentId: string | null, depth: number): StdRow => {
    const i = info.get(r.id);
    const reorder = r.reorderPoint != null ? money(r.reorderPoint) : null;
    const needs = reorder != null && money(r.available).plus(money(r.onPO)).lessThanOrEqualTo(reorder);
    const n = next.get(r.id);
    return {
      id: `iss:${by}:${r.id}`,
      parentId,
      depth,
      kind: 'data',
      cells: {
        label: r.name,
        description: i?.description ?? '',
        vendor: i?.vendor ?? '',
        reorder: reorder ? qty4(reorder) : null,
        onHand: r.quantityOnHand,
        onSO: r.committed,
        available: r.available,
        order: needs ? '✓' : '',
        onPO: r.onPO,
        nextDeliv: n && money(r.onPO).greaterThan(0) ? dayStr(n) : null,
        perWeek: (sold.get(r.id) ?? Money.zero()).dividedBy(weeks).toFixed(2),
      },
      href: stdHref('inventory-valuation-detail', { itemId: r.id, from: dayStr(from), to: dayStr(to) }),
    };
  };
  const rows: StdRow[] = [];
  if (by === 'item') {
    for (const r of list) rows.push(rowOf(r, null, 0));
  } else {
    const groups = new Map<string, typeof list>();
    for (const r of list) {
      const k = info.get(r.id)?.vendorId ?? '';
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const order = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : (info.get(groups.get(a)![0].id)?.vendor ?? '').localeCompare(info.get(groups.get(b)![0].id)?.vendor ?? '')));
    for (const k of order) {
      const g = groups.get(k)!;
      const label = k ? (info.get(g[0].id)?.vendor ?? '') : 'No preferred vendor';
      const hid = `issv:${k || 'none'}`;
      rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label } });
      for (const r of g) rows.push(rowOf(r, hid, 1));
      const sum = (f: 'quantityOnHand' | 'committed' | 'available' | 'onPO') => qty4(g.reduce((s, r) => s.plus(money(r[f])), Money.zero()));
      rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${label}`, onHand: sum('quantityOnHand'), onSO: sum('committed'), available: sum('available'), onPO: sum('onPO') } });
    }
  }
  return {
    key: by === 'item' ? 'inventory-stock-status-by-item' : 'inventory-stock-status-by-vendor',
    title: by === 'item' ? 'Inventory Stock Status by Item' : 'Inventory Stock Status by Vendor',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'description', header: 'Description' },
      ...(by === 'item' ? [{ key: 'vendor', header: 'Pref Vendor' }] : []),
      { key: 'reorder', header: 'Reorder Pt', type: 'number' },
      { key: 'onHand', header: 'On Hand', type: 'number' },
      { key: 'onSO', header: 'On Sales Order', type: 'number' },
      { key: 'available', header: 'Available', type: 'number' },
      { key: 'order', header: 'Order' },
      { key: 'onPO', header: 'On PO', type: 'number' },
      { key: 'nextDeliv', header: 'Next Deliv', type: 'date' },
      { key: 'perWeek', header: 'Sales/Week', type: 'number' },
    ],
    rows,
    notes: ['Sales/Week is the average number of units sold per week between the report dates.'],
  };
}

export const inventoryStockStatusByItem = (ctx: ServiceContext, p: ReportParams) => stockStatusStd(ctx, p, 'item');
export const inventoryStockStatusByVendor = (ctx: ServiceContext, p: ReportParams) => stockStatusStd(ctx, p, 'vendor');

/** Physical Inventory Worksheet: every active inventory item with a blank Physical Count column. */
export async function physicalInventoryWorksheet(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const [status, info] = await Promise.all([stockStatus(ctx), itemInfo(ctx)]);
  const list = p.itemId ? status.rows.filter((r) => r.id === p.itemId) : status.rows;
  return {
    key: 'physical-inventory-worksheet',
    title: 'Physical Inventory Worksheet',
    subtitle: `As of ${fmtDay(endOfToday())}`,
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'description', header: 'Description' },
      { key: 'vendor', header: 'Pref Vendor' },
      { key: 'onHand', header: 'On Hand', type: 'number' },
      { key: 'count', header: 'Physical Count' },
    ],
    rows: list.map((r) => ({
      id: `piw:${r.id}`,
      depth: 0,
      kind: 'data' as const,
      cells: { label: r.name, description: info.get(r.id)?.description ?? '', vendor: info.get(r.id)?.vendor ?? '', onHand: r.quantityOnHand, count: '______' },
    })),
    notes: ['Print this worksheet, count the stock and enter the differences with Adjust Quantity/Value on Hand.'],
  };
}

async function hasSites(ctx: ServiceContext): Promise<boolean> {
  const [s] = await ctx.db.select({ id: inventorySites.id }).from(inventorySites).where(eq(inventorySites.companyId, ctx.companyId)).limit(1);
  return !!s;
}

const NO_SITES_NOTE = 'No inventory sites have been set up. Add sites in Inventory Sites to track stock by location.';

/** Quantity on Hand by Site: per item, the quantity at each site. */
export async function quantityOnHandBySiteStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const base: StdReport = { key: 'quantity-on-hand-by-site', title: 'Quantity on Hand by Site', subtitle: `As of ${fmtDay(endOfToday())}`, columns: [{ key: 'label', header: 'Item' }], rows: [] };
  if (!(await hasSites(ctx))) return { ...base, notes: [NO_SITES_NOTE] };
  const r = await quantityOnHandBySite(ctx, { siteId: p.siteId ?? null, itemId: p.itemId ?? null });
  const sites = (await ctx.db.select({ id: inventorySites.id, name: inventorySites.name }).from(inventorySites).where(eq(inventorySites.companyId, ctx.companyId)).orderBy(asc(inventorySites.name)))
    .filter((s) => !p.siteId || s.id === p.siteId);
  const used = sites.filter((s) => r.rows.some((x: { bySite: Record<string, string> }) => x.bySite[s.id] !== undefined));
  const columns: StdColumn[] = [
    { key: 'label', header: 'Item' },
    ...used.map((s, i) => ({ key: `s${i}`, header: s.name, type: 'number' as const })),
    { key: 'total', header: 'TOTAL', type: 'number' },
    { key: 'value', header: 'Asset Value', type: 'money' },
  ];
  let value = Money.zero();
  const rows: StdRow[] = (r.rows as Array<{ itemId: string; name: string; totalQuantity: string; totalValue: string; bySite: Record<string, string> }>).map((x) => {
    const cells: Record<string, CellValue> = { label: x.name, value: amt(money(x.totalValue)) };
    let t = Money.zero();
    used.forEach((s, i) => {
      const q = x.bySite[s.id];
      cells[`s${i}`] = q ?? null;
      if (q) t = t.plus(money(q));
    });
    cells.total = p.siteId ? qty4(t) : x.totalQuantity;
    value = value.plus(money(x.totalValue));
    return { id: `qbs:${x.itemId}`, depth: 0, kind: 'data' as const, cells, href: stdHref('inventory-valuation-detail', { itemId: x.itemId, from: '1900-01-01' }) };
  });
  rows.push({ id: 'qbs:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', value: amt(value) } });
  return { ...base, columns, rows };
}

/** Inventory Stock Status by Site / Reorder by Site. */
async function siteStatusStd(ctx: ServiceContext, p: ReportParams, reorderOnly: boolean): Promise<StdReport> {
  const key = reorderOnly ? 'inventory-reorder-by-site' : 'inventory-stock-status-by-site';
  const title = reorderOnly ? 'Inventory Reorder Report by Site' : 'Inventory Stock Status by Site';
  const columns: StdColumn[] = [
    { key: 'label', header: 'Site / Item' },
    { key: 'onHand', header: 'On Hand', type: 'number' },
    { key: 'onSO', header: 'On Sales Order', type: 'number' },
    { key: 'available', header: 'Available', type: 'number' },
    { key: 'onPO', header: 'On PO', type: 'number' },
    { key: 'reorder', header: 'Reorder Pt', type: 'number' },
    { key: 'max', header: 'Max', type: 'number' },
    { key: 'suggested', header: 'Suggested Order', type: 'number' },
  ];
  if (!(await hasSites(ctx))) return { key, title, columns, rows: [], notes: [NO_SITES_NOTE] };
  const data = reorderOnly ? await reorderBySite(ctx, { siteId: p.siteId ?? null }) : await stockStatusBySite(ctx, { siteId: p.siteId ?? null, itemId: p.itemId ?? null });
  const list = p.itemId ? data.rows.filter((r) => r.itemId === p.itemId) : data.rows;
  const bySite = new Map<string, typeof list>();
  for (const r of list) bySite.set(r.siteId, [...(bySite.get(r.siteId) ?? []), r]);
  const rows: StdRow[] = [];
  for (const [siteId, g] of [...bySite.entries()].sort((a, b) => a[1][0].siteName.localeCompare(b[1][0].siteName))) {
    const hid = `${key}:${siteId}`;
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g[0].siteName } });
    for (const r of g.sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({
        id: `${hid}:${r.itemId}`,
        parentId: hid,
        depth: 1,
        kind: 'data',
        cells: { label: r.name, onHand: r.onHand, onSO: r.committed, available: r.available, onPO: r.onPO, reorder: r.reorderPoint, max: r.maxQuantity, suggested: r.suggestedOrder },
      });
    }
  }
  return { key, title, subtitle: `As of ${fmtDay(endOfToday())}`, columns, rows, notes: ['Open sales orders and purchase orders count at the default site.'] };
}

export const inventoryStockStatusBySite = (ctx: ServiceContext, p: ReportParams) => siteStatusStd(ctx, p, false);
export const inventoryReorderBySite = (ctx: ServiceContext, p: ReportParams) => siteStatusStd(ctx, p, true);

/** Serial / Lot Numbers in Stock by site. */
export async function serialLotInStockStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const r = await serialLotInStock(ctx, { siteId: p.siteId ?? null, itemId: p.itemId ?? null });
  const rows: StdRow[] = [];
  for (const s of r.serials) {
    rows.push({ id: `sls:s:${s.itemId}:${s.serialNumber}`, depth: 0, kind: 'data', cells: { label: s.itemName, kind: 'Serial', number: s.serialNumber, site: s.siteName, bin: s.binName ?? '', qty: '1.0000', date: s.receivedDate ? dayStr(new Date(s.receivedDate)) : null } });
  }
  for (const l of r.lots) {
    rows.push({ id: `sls:l:${l.itemId}:${l.lotNumber}:${l.siteId}:${l.binId ?? ''}`, depth: 0, kind: 'data', cells: { label: l.itemName, kind: 'Lot', number: l.lotNumber, site: l.siteName, bin: l.binName ?? '', qty: l.quantity, date: l.expirationDate ? dayStr(new Date(l.expirationDate)) : null } });
  }
  return {
    key: 'serial-lot-in-stock',
    title: 'Serial/Lot Numbers in Stock',
    subtitle: `As of ${fmtDay(endOfToday())}`,
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'kind', header: 'Tracking' },
      { key: 'number', header: 'Serial / Lot' },
      { key: 'site', header: 'Site' },
      { key: 'bin', header: 'Bin' },
      { key: 'qty', header: 'Qty', type: 'number' },
      { key: 'date', header: 'Received / Expires', type: 'date' },
    ],
    rows,
    notes: ['Serial numbers show the date they were received; lots show their expiration date.'],
  };
}

/** Transactions by Serial / Lot Number (the Number filter is the serial or lot number). */
export async function transactionsBySerialLotStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const base: StdReport = {
    key: 'transactions-by-serial-lot',
    title: 'Transactions by Serial/Lot Number',
    columns: [
      { key: 'label', header: 'Item' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'type', header: 'Type' },
      { key: 'num', header: 'Num' },
      { key: 'number', header: 'Serial / Lot' },
      { key: 'site', header: 'Site' },
      { key: 'qty', header: 'Qty', type: 'number' },
    ],
    rows: [],
  };
  const n = p.number?.trim();
  if (!n) return { ...base, notes: ['Type a serial or lot number in the Number filter.'] };
  const [bySerial, byLot] = await Promise.all([
    transactionsBySerialLot(ctx, { serialNumber: n, itemId: p.itemId ?? null, includeReversed: false }),
    transactionsBySerialLot(ctx, { lotNumber: n, itemId: p.itemId ?? null, includeReversed: false }),
  ]);
  const seen = new Set<string>();
  const rows: StdRow[] = [];
  for (const r of [...bySerial.rows, ...byLot.rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())) {
    if (seen.has(r.movementId)) continue;
    seen.add(r.movementId);
    rows.push({ id: `tsl:${r.movementId}`, depth: 0, kind: 'data', cells: { label: r.itemName, date: dayStr(new Date(r.date)), type: r.sourceLabel, num: r.sourceNumber ?? '', number: r.serialNumber ?? r.lotNumber ?? '', site: r.siteName, qty: money(r.quantity).toFixed(4) } });
  }
  return { ...base, subtitle: `Serial / lot ${n}`, rows };
}

// ===========================================================================
// Payroll
// ===========================================================================

async function payrollRange(ctx: ServiceContext, p: ReportParams) {
  const { from, to } = await resolveRange(ctx, p);
  return { from, to, input: { from, to, employeeId: p.employeeId } };
}

/**
 * Payroll Summary (QB layout): one row per payroll item — earnings, gross pay, deductions,
 * taxes withheld, net pay and employer taxes — one column per employee, plus TOTAL.
 */
export async function payrollSummaryStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to, input } = await payrollRange(ctx, p);
  const r = await employeeEarningsSummary(ctx, input);
  const emps = r.employees;
  if (emps.length > 100) throw validation('More than 100 employees were paid in this period. Choose one employee or a shorter date range.');
  const columns: StdColumn[] = [
    { key: 'label', header: '' },
    ...emps.map((e, i) => ({ key: `e${i}`, header: e.name, type: 'money' as const })),
    { key: 'total', header: 'TOTAL', type: 'money' },
  ];
  const rows: StdRow[] = [];
  const sections = new Map<string, typeof r.rows>();
  for (const row of r.rows) sections.set(row.section, [...(sections.get(row.section) ?? []), row]);
  for (const [section, list] of sections) {
    const hid = `prs:${section}`;
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'section', cells: { label: section } });
    const sums = emps.map(() => Money.zero());
    let total = Money.zero();
    for (const row of list) {
      const cells: Record<string, CellValue> = { label: row.item, total: amt(money(row.total)) };
      emps.forEach((e, i) => {
        const v = row.amounts[e.id];
        cells[`e${i}`] = v != null ? amt(money(v)) : null;
        if (v != null) sums[i] = sums[i].plus(money(v));
      });
      total = total.plus(money(row.total));
      rows.push({ id: `${hid}:${row.kind}:${row.item}`, parentId: hid, depth: 1, kind: 'data', cells, hrefs: Object.fromEntries(emps.map((e, i) => [`e${i}`, stdHref('payroll-item-detail', { ...qsRange(from, to), employeeId: e.id })])) });
    }
    const tc: Record<string, CellValue> = { label: `Total ${section}`, total: amt(total) };
    emps.forEach((_, i) => (tc[`e${i}`] = amt(sums[i])));
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  const gross: Record<string, CellValue> = { label: 'Gross Pay', total: amt(money(r.totalGross)) };
  const net: Record<string, CellValue> = { label: 'Net Pay', total: amt(money(r.totalNet)) };
  emps.forEach((e, i) => {
    gross[`e${i}`] = amt(money(r.gross[e.id]));
    net[`e${i}`] = amt(money(r.net[e.id]));
  });
  rows.push({ id: 'prs:gross', depth: 0, kind: 'total', cells: gross });
  rows.push({ id: 'prs:net', depth: 0, kind: 'grand', cells: net });
  return { key: 'payroll-summary', title: 'Payroll Summary', subtitle: rangeLabel(from, to), columns, rows };
}

/** Employee Earnings Summary: one row per employee — gross, taxes, deductions, employer taxes, net. */
export async function employeeEarningsSummaryStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to, input } = await payrollRange(ctx, p);
  const r = await payrollSummary(ctx, input);
  const columns: StdColumn[] = [
    { key: 'label', header: 'Employee' },
    { key: 'count', header: 'Paychecks', type: 'number' },
    { key: 'gross', header: 'Gross Pay', type: 'money' },
    ...r.taxNames.map((n, i) => ({ key: `t${i}`, header: n, type: 'money' as const })),
    ...r.deductionNames.map((n, i) => ({ key: `d${i}`, header: n, type: 'money' as const })),
    { key: 'net', header: 'Net Pay', type: 'money' },
    ...r.employerTaxNames.map((n, i) => ({ key: `x${i}`, header: n, type: 'money' as const })),
    { key: 'employer', header: 'Employer Taxes', type: 'money' },
  ];
  const rows: StdRow[] = r.rows.map((e) => {
    const cells: Record<string, CellValue> = { label: e.employeeName, count: e.paycheckCount, gross: amt(money(e.gross)), net: amt(money(e.net)), employer: amt(money(e.totalEmployerTaxes)) };
    r.taxNames.forEach((n, i) => (cells[`t${i}`] = e.taxes[n] != null ? amt(money(e.taxes[n]).negated()) : null));
    r.deductionNames.forEach((n, i) => (cells[`d${i}`] = e.deductions[n] != null ? amt(money(e.deductions[n]).negated()) : null));
    r.employerTaxNames.forEach((n, i) => (cells[`x${i}`] = e.employerTaxes[n] != null ? amt(money(e.employerTaxes[n])) : null));
    return { id: `ees:${e.employeeId}`, depth: 0, kind: 'data' as const, cells, href: stdHref('payroll-detail', { ...qsRange(from, to), employeeId: e.employeeId }) };
  });
  const sumCol = (pick: (e: (typeof r.rows)[number]) => string | undefined) => amt(r.rows.reduce((s, e) => s.plus(money(pick(e))), Money.zero()));
  const tc: Record<string, CellValue> = { label: 'TOTAL', gross: amt(money(r.totals.gross)), net: amt(money(r.totals.net)), employer: amt(money(r.totals.totalEmployerTaxes)) };
  r.taxNames.forEach((n, i) => (tc[`t${i}`] = amt(money(sumCol((e) => e.taxes[n])).negated())));
  r.deductionNames.forEach((n, i) => (tc[`d${i}`] = amt(money(sumCol((e) => e.deductions[n])).negated())));
  r.employerTaxNames.forEach((n, i) => (tc[`x${i}`] = sumCol((e) => e.employerTaxes[n])));
  rows.push({ id: 'ees:grand', depth: 0, kind: 'grand', cells: tc });
  return { key: 'employee-earnings-summary', title: 'Employee Earnings Summary', subtitle: rangeLabel(from, to), columns, rows };
}

/** Payroll Detail: one row per paycheck. */
export async function payrollDetailStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to, input } = await payrollRange(ctx, p);
  const r = await payrollDetail(ctx, input);
  const entryIds = await entryIdsForSourceRefs(ctx, r.rows.map((x) => `paycheck:${x.paycheckId}`));
  const t = { gross: Money.zero(), taxes: Money.zero(), ded: Money.zero(), emp: Money.zero(), net: Money.zero() };
  const rows: StdRow[] = r.rows.map((x) => {
    t.gross = t.gross.plus(money(x.gross));
    t.taxes = t.taxes.plus(money(x.totalTaxes));
    t.ded = t.ded.plus(money(x.totalDeductions));
    t.emp = t.emp.plus(money(x.totalEmployerTaxes));
    t.net = t.net.plus(money(x.net));
    return {
      id: `prd:${x.paycheckId}`,
      depth: 0,
      kind: 'data' as const,
      cells: { label: x.employeeName, date: x.payDate, period: x.periodStart && x.periodEnd ? `${x.periodStart} – ${x.periodEnd}` : '', gross: amt(money(x.gross)), taxes: amt(money(x.totalTaxes).negated()), deductions: amt(money(x.totalDeductions).negated()), net: amt(money(x.net)), employer: amt(money(x.totalEmployerTaxes)) },
      entryId: entryIds.get(`paycheck:${x.paycheckId}`) ?? null,
    };
  });
  rows.push({ id: 'prd:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', gross: amt(t.gross), taxes: amt(t.taxes.negated()), deductions: amt(t.ded.negated()), net: amt(t.net), employer: amt(t.emp) } });
  return {
    key: 'payroll-detail',
    title: 'Payroll Detail',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: 'Employee' },
      { key: 'date', header: 'Pay Date', type: 'date' },
      { key: 'period', header: 'Pay Period' },
      { key: 'gross', header: 'Gross Pay', type: 'money' },
      { key: 'taxes', header: 'Taxes Withheld', type: 'money' },
      { key: 'deductions', header: 'Deductions', type: 'money' },
      { key: 'net', header: 'Net Pay', type: 'money' },
      { key: 'employer', header: 'Employer Taxes', type: 'money' },
    ],
    rows,
  };
}

/** Payroll Item Detail: every paycheck line grouped by payroll item. */
export async function payrollItemDetailStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to, input } = await payrollRange(ctx, p);
  const r = await payrollItemDetail(ctx, input);
  const entryIds = await entryIdsForSourceRefs(ctx, r.groups.flatMap((g) => g.lines.map((l) => `paycheck:${l.paycheckId}`)));
  const rows: StdRow[] = [];
  for (const g of r.groups) {
    const hid = `pid:${g.kind}:${g.item}`;
    const header: StdRow = { id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g.item } };
    rows.push(header);
    g.lines.forEach((l, i) => {
      rows.push({ id: `${hid}:${l.paycheckId}:${i}`, parentId: hid, depth: 1, kind: 'data', cells: { label: '', type: l.type, date: l.date, name: l.employeeName, memo: l.detail, amount: amt(money(l.amount)) }, entryId: entryIds.get(`paycheck:${l.paycheckId}`) ?? null });
    });
    const tc = { label: `Total ${g.item}`, amount: amt(money(g.total)) };
    header.collapsedCells = { label: g.item, amount: tc.amount };
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: tc });
  }
  return {
    key: 'payroll-item-detail',
    title: 'Payroll Item Detail',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: '' },
      { key: 'type', header: 'Type' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'name', header: 'Employee' },
      { key: 'memo', header: 'Detail' },
      { key: 'amount', header: 'Amount', type: 'money' },
    ],
    rows,
  };
}

/** Payroll Liability Balances: accrued, paid and still owed per payroll item as of a date. */
export async function payrollLiabilityBalancesStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const asOf = resolveAsOf(p);
  const r = await payrollLiabilityBalances(ctx, { asOf });
  const KIND: Record<string, string> = { tax: 'Taxes', deduction: 'Deductions', employer_contribution: 'Employer contributions' };
  const rows: StdRow[] = r.items.map((i) => ({
    id: `plb:${i.kind}:${i.name}`,
    depth: 0,
    kind: 'data' as const,
    cells: { label: i.name, kind: KIND[i.kind] ?? i.kind, accrued: amt(money(i.accrued)), paid: amt(money(i.paid)), balance: amt(money(i.balance)) },
  }));
  rows.push({ id: 'plb:grand', depth: 0, kind: 'grand', cells: { label: 'TOTAL', accrued: amt(money(r.totalAccrued)), paid: amt(money(r.totalPaid)), balance: amt(money(r.balance)) } });
  return {
    key: 'payroll-liability-balances',
    title: 'Payroll Liability Balances',
    subtitle: `As of ${fmtDay(asOf)}`,
    columns: [
      { key: 'label', header: 'Payroll Item' },
      { key: 'kind', header: 'Kind' },
      { key: 'accrued', header: 'Accrued', type: 'money' },
      { key: 'paid', header: 'Paid', type: 'money' },
      { key: 'balance', header: 'Balance', type: 'money' },
    ],
    rows,
    notes: ['Lump-sum liability payments that name no payroll item reduce only the TOTAL balance.'],
  };
}

function addressText(a: Record<string, unknown> | null | undefined): string {
  if (!a) return '';
  const part = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
  const cityLine = [part('city'), [part('state'), part('zip')].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [part('line1'), part('line2'), cityLine].filter(Boolean).join(', ');
}

/**
 * Employee Contact List (QB Reports > Lists): name, SS No. (last four digits unless the user may
 * view sensitive payroll data), phone, email, address and hire date.
 */
export async function employeeContactList(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const rows = await ctx.db
    .select({ id: employees.id, first: employees.firstName, last: employees.lastName, ssn: employees.ssn, phone: employees.phone, email: employees.email, address: employees.address, hireDate: employees.hireDate, isActive: employees.isActive })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), ...(p.employeeId ? [eq(employees.id, p.employeeId)] : [])))
    .orderBy(asc(employees.lastName), asc(employees.firstName));
  return {
    key: 'employee-contact-list',
    title: 'Employee Contact List',
    columns: [
      { key: 'label', header: 'Employee' },
      { key: 'ssn', header: 'SS No.' },
      { key: 'phone', header: 'Phone' },
      { key: 'email', header: 'Email' },
      { key: 'address', header: 'Address' },
      { key: 'hired', header: 'Hire Date', type: 'date' },
      { key: 'status', header: 'Status' },
    ],
    rows: rows.map((e) => ({
      id: `ecl:${e.id}`,
      depth: 0,
      kind: 'data' as const,
      cells: {
        label: `${e.last}, ${e.first}`.replace(/^, |, $/g, ''),
        ssn: taxIdFor(ctx, e.ssn) ?? '',
        phone: e.phone ?? '',
        email: e.email ?? '',
        address: addressText(e.address),
        hired: e.hireDate ? dayStr(e.hireDate) : null,
        status: e.isActive ? 'Active' : 'Inactive',
      },
    })),
  };
}

// ===========================================================================
// Audit reports (Accountant & Taxes)
// ===========================================================================

/** Voided/Deleted Transactions Summary / Detail: every void or delete, who did it and when. */
async function voidedDeletedStd(ctx: ServiceContext, p: ReportParams, detail: boolean): Promise<StdReport> {
  const { timezone } = await getPreferences(ctx);
  const { rows: list } = await voidedDeletedTransactions(ctx, { from: p.from, to: p.to, detail });
  const rows: StdRow[] = list.map((r) => ({
    id: `vd:${r.auditLogId}`,
    depth: 0,
    kind: 'data' as const,
    cells: {
      label: r.action === 'void' ? 'Voided' : 'Deleted',
      when: localDateTime(r.at, timezone),
      user: r.user ?? '',
      type: r.typeLabel,
      num: r.number ?? '',
      date: r.transactionDate ? r.transactionDate.slice(0, 10) : null,
      name: r.name ?? '',
      amount: r.amount,
      ...(detail ? { original: summarizeOriginal(r.original) } : {}),
    },
  }));
  return {
    key: detail ? 'voided-deleted-detail' : 'voided-deleted-summary',
    title: `Voided/Deleted Transactions ${detail ? 'Detail' : 'Summary'}`,
    subtitle: p.from || p.to ? `Changed ${p.from ?? 'any time'} – ${p.to ?? 'today'}` : 'All dates',
    columns: [
      { key: 'label', header: 'Action' },
      { key: 'when', header: 'Entered/Last Modified' },
      { key: 'user', header: 'Last modified by' },
      { key: 'type', header: 'Type' },
      { key: 'num', header: 'Num' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'name', header: 'Name' },
      { key: 'amount', header: 'Amount', type: 'money' },
      ...(detail ? [{ key: 'original', header: 'Original values' }] : []),
    ],
    rows,
    notes: ['The dates choose when the transaction was voided or deleted, on the company’s clock.'],
  };
}

function summarizeOriginal(original: unknown): string {
  if (!original || typeof original !== 'object') return '';
  const o = original as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    if (['id', 'companyId', 'createdAt', 'updatedAt'].includes(k)) continue;
    parts.push(`${k}: ${String(v)}`);
    if (parts.length >= 8) break;
  }
  const lines = Array.isArray(o.lines) ? ` · ${o.lines.length} line(s)` : '';
  return parts.join(' · ') + lines;
}

export const voidedDeletedSummaryStd = (ctx: ServiceContext, p: ReportParams) => voidedDeletedStd(ctx, p, false);
export const voidedDeletedDetailStd = (ctx: ServiceContext, p: ReportParams) => voidedDeletedStd(ctx, p, true);

const CLOSING_OP: Record<string, string> = { post: 'Added', void: 'Voided', reclassify: 'Reclassified' };

/**
 * Closing Date Exception Report: every change made on or before the closing date with the
 * closing-date password, and entries dated in the closed period that were entered later.
 */
export async function closingDateExceptionsStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { timezone } = await getPreferences(ctx);
  const r = await closingDateExceptionReport(ctx, { from: p.from, to: p.to });
  // QB layout: each changed transaction once (one heading row), its Latest values, then each
  // Prior version changed in the closed period (auditReports.ts exceptionGroups).
  const changeText = (c: { operation: string; source: string }) =>
    c.source === 'override' ? `${CLOSING_OP[c.operation] ?? c.operation} with password` : 'Entered after close';
  const rows: StdRow[] = [];
  for (const g of r.groups) {
    const headingId = `cde:${g.key}`;
    const changes = g.changes.map(changeText).join(', ');
    rows.push({
      id: headingId,
      depth: 0,
      kind: 'section',
      cells: {
        state: `${g.typeLabel} dated ${g.transactionDate}: ${changes}${g.closingDate ? ` (closed through ${g.closingDate})` : ''}`,
      },
    });
    const versions = [...(g.latest ? [g.latest] : []), ...g.prior];
    if (!g.latest) {
      rows.push({
        id: `${headingId}:void-now`,
        parentId: headingId,
        depth: 1,
        kind: 'data' as const,
        cells: {
          state: 'Latest',
          changed: '',
          user: '',
          num: '',
          date: '',
          account: '',
          name: '',
          memo: 'Void now: the prior values below are what it was before.',
          debit: null,
          credit: null,
        },
      });
    }
    for (const v of versions) {
      v.lines.forEach((l, i) => {
        const first = i === 0;
        rows.push({
          id: `${headingId}:${v.state}:${v.entryId}:${i}`,
          parentId: headingId,
          depth: 1,
          kind: 'data' as const,
          cells: {
            state: v.state === 'latest' ? 'Latest' : 'Prior',
            changed: first ? localDateTime(v.at, timezone) : '',
            user: first ? v.user ?? '' : '',
            num: first ? (v.entryNumber != null ? String(v.entryNumber) : '') : '',
            date: first ? v.date : '',
            account: l.className ? `${l.account} · ${l.className}` : l.account,
            name: l.name ?? '',
            memo: l.memo ?? (first ? v.description ?? '' : ''),
            debit: l.debit ?? null,
            credit: l.credit ?? null,
          },
          entryId: v.entryId,
        });
      });
    }
  }
  return {
    key: 'closing-date-exceptions',
    title: 'Closing Date Exception Report',
    subtitle: r.closingDate ? `Closing date ${fmtDay(parseDay(r.closingDate.slice(0, 10))!)}` : 'No closing date set',
    columns: [
      { key: 'state', header: 'State' },
      { key: 'changed', header: 'Entered / changed' },
      { key: 'user', header: 'User' },
      { key: 'num', header: 'Entry #' },
      { key: 'date', header: 'Date', type: 'date' },
      { key: 'account', header: 'Account' },
      { key: 'name', header: 'Name' },
      { key: 'memo', header: 'Memo' },
      { key: 'debit', header: 'Debit', type: 'money' },
      { key: 'credit', header: 'Credit', type: 'money' },
    ],
    rows,
    notes: ['The dates choose when the change was made, on the company’s clock.'],
  };
}

// ===========================================================================
// Sales Tax Revenue Summary
// ===========================================================================

/**
 * Sales Tax Revenue Summary (QB Reports > Vendors & Payables): per sales tax item, total sales,
 * non-taxable sales, taxable sales and the tax on them, on the Sales Tax preference's basis
 * unless the report chooses one.
 */
export async function salesTaxRevenueSummaryStd(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const basis = p.basis ?? ((await getPreferences(ctx)).salesTaxBasis === 'cash' ? 'cash' : 'accrual');
  const r = await salesTaxRevenueSummary(ctx, { from, to, basis });
  const cells = (label: string, x: { totalSales: string; nonTaxableSales: string; taxableSales: string; taxCollected: string }, rate?: string | null): Record<string, CellValue> => ({
    label,
    // The tax rate is stored as a fraction (0.0825); the report shows the percentage (8.25).
    rate: rate != null ? money(rate).times(100).toFixed(3).replace(/\.?0+$/, '') : null,
    totalSales: amt(money(x.totalSales)),
    nonTaxable: amt(money(x.nonTaxableSales)),
    taxable: amt(money(x.taxableSales)),
    tax: amt(money(x.taxCollected)),
  });
  const rows: StdRow[] = r.rows.map((x) => ({
    id: `strs:${x.taxRateId ?? 'none'}`,
    depth: 0,
    kind: 'data' as const,
    cells: cells(x.taxRateName, x, x.rate),
    href: stdHref('sales-by-item-summary', { ...qsRange(from, to), basis }),
  }));
  rows.push({ id: 'strs:grand', depth: 0, kind: 'grand', cells: cells('TOTAL', r.totals) });
  return {
    key: 'sales-tax-revenue-summary',
    title: 'Sales Tax Revenue Summary',
    subtitle: `${rangeLabel(from, to)}${r.basis === 'cash' ? ' · Cash Basis' : ''}`,
    columns: [
      { key: 'label', header: 'Sales Tax Item' },
      { key: 'rate', header: 'Rate %', type: 'text' },
      { key: 'totalSales', header: 'Total Sales', type: 'money' },
      { key: 'nonTaxable', header: 'Non-Taxable Sales', type: 'money' },
      { key: 'taxable', header: 'Taxable Sales', type: 'money' },
      { key: 'tax', header: 'Tax Collected', type: 'money' },
    ],
    rows,
    notes: ['On the cash basis, sales count when the customer pays.'],
  };
}

// ===========================================================================
// Cash Flow Forecast
// ===========================================================================

export interface ForecastPeriod {
  key: string;
  label: string;
  from: Date;
  to: Date;
}

/** Forecast periods from `from` to `to`: weeks (Sunday–Saturday, QB) or calendar months. */
export function forecastPeriods(from: Date, to: Date, kind: 'week' | 'month'): ForecastPeriod[] {
  const out: ForecastPeriod[] = [];
  let start = new Date(from);
  let i = 0;
  while (start <= to && i < 120) {
    let end: Date;
    if (kind === 'month') {
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    } else {
      const toSat = 6 - start.getUTCDay();
      end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + toSat, 23, 59, 59, 999));
    }
    if (end > to) end = new Date(to);
    out.push({ key: `p${i}`, label: kind === 'month' ? `${fmtDay(start)} – ${fmtDay(end)}` : `Week of ${fmtDay(start)}`, from: start, to: end });
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
    i++;
  }
  return out;
}

/**
 * Cash Flow Forecast (QB Reports > Company & Financial): the cash you can expect, period by
 * period, from today's open receivables and payables by their due dates and the bank
 * transactions already entered with future dates.
 *
 *  - Beginning Balance: bank balances the day before the forecast starts, plus receivables and
 *    payables already overdue (QB counts them at the start).
 *  - Accnts Receivable: open invoices (less unapplied credits) due in the period.
 *  - Accnts Payable: open bills (less unapplied vendor credits) due in the period (negative).
 *  - Bank Accnts: bank-account activity dated in the period (entered transactions, including
 *    post-dated ones); a paid document is no longer open, so nothing is counted twice.
 *  - Net Inflows and the projected balance.
 *
 * Amounts are in home currency. Default dates: the next 6 weeks; Display by week or by month.
 */
export async function cashFlowForecast(ctx: ServiceContext, p: ReportParams): Promise<StdReport> {
  const todayStr = localToday();
  const from = parseDay(p.from ?? todayStr)!;
  const to = p.to ? parseDay(p.to, true)! : new Date(from.getTime() + 42 * DAY_MS - 1);
  if (from > to) throw validation('The "From" date is after the "To" date.');
  const periods = forecastPeriods(from, to, p.period === 'month' ? 'month' : 'week');
  if (periods.length > 104) throw validation('Too many periods — choose a shorter date range or display by month.');
  const asOf = parseDay(todayStr, true)!;
  const [ar, ap, meta] = await Promise.all([arAgingDetail(ctx, asOf), apAgingDetail(ctx, asOf), loadAccountMeta(ctx)]);
  const bankIds = [...meta.values()].filter((a) => a.section === 'bank').map((a) => a.id);
  const dayBefore = new Date(from.getTime() - 1);
  // Bank balance at the start.
  const opening = bankIds.length ? await activityByAccount(ctx, { to: dayBefore, accountIds: bankIds }) : [];
  const beginBank = opening.reduce((s, r) => s.plus(money(r.debit)).minus(money(r.credit)), Money.zero());
  // Bank activity dated in the forecast window (deposits, checks, transfers — including those
  // entered ahead with future dates). A paid invoice or bill is no longer open, so its payment is
  // counted here once and never again under A/R or A/P.
  const bankAct = bankIds.length ? await activityByAccount(ctx, { from, to, accountIds: bankIds }, 'day') : [];

  const dueIndex = (due: string | null, date: string): number => {
    const d = parseDay((due ?? date).slice(0, 10))!;
    if (d < from) return -1;
    return periods.findIndex((x) => d >= x.from && d <= x.to);
  };
  const arBy = periods.map(() => Money.zero());
  const apBy = periods.map(() => Money.zero());
  const bankBy = periods.map(() => Money.zero());
  let arOverdue = Money.zero();
  let apOverdue = Money.zero();
  for (const r of ar.rows) {
    const i = dueIndex(r.dueDate, r.date);
    if (i === -1) arOverdue = arOverdue.plus(money(r.openBalance));
    else if (i >= 0) arBy[i] = arBy[i].plus(money(r.openBalance));
  }
  for (const r of ap.rows) {
    const i = dueIndex(r.dueDate, r.date);
    if (i === -1) apOverdue = apOverdue.plus(money(r.openBalance));
    else if (i >= 0) apBy[i] = apBy[i].plus(money(r.openBalance));
  }
  for (const r of bankAct) {
    const d = parseDay(r.bucket ?? undefined);
    if (!d) continue;
    const i = periods.findIndex((x) => d >= x.from && d <= x.to);
    if (i >= 0) bankBy[i] = bankBy[i].plus(money(r.debit)).minus(money(r.credit));
  }

  const rows: StdRow[] = [];
  let proj = beginBank.plus(arOverdue).minus(apOverdue);
  rows.push({
    id: 'cff:begin',
    depth: 0,
    kind: 'subtotal',
    cells: { label: 'Beginning Balance', ar: amt(arOverdue), ap: amt(apOverdue.negated()), bank: amt(beginBank), net: null, proj: amt(proj) },
    hrefs: {
      ar: stdHref('ar-aging-detail', { asOf: todayStr }),
      ap: stdHref('ap-aging-detail', { asOf: todayStr }),
      bank: stdHref('balance-sheet', { asOf: dayStr(dayBefore) }),
    },
  });
  let tAr = Money.zero();
  let tAp = Money.zero();
  let tBank = Money.zero();
  periods.forEach((x, i) => {
    const net = arBy[i].minus(apBy[i]).plus(bankBy[i]);
    proj = proj.plus(net);
    tAr = tAr.plus(arBy[i]);
    tAp = tAp.plus(apBy[i]);
    tBank = tBank.plus(bankBy[i]);
    rows.push({
      id: `cff:${x.key}`,
      depth: 0,
      kind: 'data',
      cells: { label: x.label, ar: amt(arBy[i]), ap: amt(apBy[i].negated()), bank: amt(bankBy[i]), net: amt(net), proj: amt(proj) },
      hrefs: bankIds.length ? { bank: stdHref('transaction-detail-by-account', { section: 'bank', from: dayStr(x.from), to: dayStr(x.to) }) } : undefined,
    });
  });
  rows.push({
    id: 'cff:grand',
    depth: 0,
    kind: 'grand',
    cells: { label: 'Ending Balance', ar: amt(tAr.plus(arOverdue)), ap: amt(tAp.plus(apOverdue).negated()), bank: amt(tBank.plus(beginBank)), net: amt(tAr.minus(tAp).plus(tBank)), proj: amt(proj) },
  });
  return {
    key: 'cash-flow-forecast',
    title: 'Cash Flow Forecast',
    subtitle: rangeLabel(from, to),
    columns: [
      { key: 'label', header: '' },
      { key: 'ar', header: 'Accnts Receivable', type: 'money' },
      { key: 'ap', header: 'Accnts Payable', type: 'money' },
      { key: 'bank', header: 'Bank Accnts', type: 'money' },
      { key: 'net', header: 'Net Inflows', type: 'money' },
      { key: 'proj', header: 'Proj Balance', type: 'money' },
    ],
    rows,
    range: { from: dayStr(from), to: dayStr(to), asOf: todayStr },
    notes: [
      'Receivables and payables are expected on their due dates; overdue ones count at the start.',
      'Bank Accnts adds the bank transactions dated in each period, including ones entered ahead.',
    ],
  };
}
