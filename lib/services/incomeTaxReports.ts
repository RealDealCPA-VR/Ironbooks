/**
 * Income tax reports (QB Reports > Accountant & Taxes): Income Tax Preparation, Income Tax Summary
 * and Income Tax Detail.
 *
 * Each account carries a tax-line key ("1120S:7") in accounts.tax_line (Tax-Line Mapping); the
 * company picks its return in Company settings (incomeTaxForm). As in QuickBooks:
 *  - lines show the form line NAME ("Compensation of officers"), never the stored key;
 *  - lines are listed in the order they appear on the form (income, cost of goods sold,
 *    deductions, schedule K / M-1 lines, then Schedule L balance-sheet lines);
 *  - accounts with no line, or mapped to a line of a different form than the company's, fall
 *    under "Tax Line Unassigned (income/expense)" or "Tax Line Unassigned (balance sheet)" at
 *    the end;
 *  - P&L accounts show period activity; balance-sheet accounts show the balance at the end date;
 *  - the report runs on either basis (accrual / cash).
 */
import { eq } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import { accounts } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import type { StdReport, StdRow } from '@/lib/reports/types';
import { getTaxLine, taxLinesForForm, INCOME_TAX_FORMS, type IncomeTaxForm, type TaxLine as FormTaxLine } from '@/lib/taxLines';
import type { ReportParams } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';
import { getIncomeTaxForm } from './accounts';
import {
  SECTION_LABELS,
  activityByAccount,
  dayStr,
  isPLSection,
  loadAccountMeta,
  naturalAmount,
  resolveRange,
  stdHref,
  type AccountMeta,
} from './reportEngine';
import { rangeLabel } from './reportsStandard';

const amt = (v: Decimal) => toAmountString(v);

/** A tax line as shown on the reports. `order` sorts lines in form order. */
export interface TaxLine {
  id: string;
  name: string;
  order?: number;
}

/** Maps an account to its income-tax form line (null = unassigned). */
export type TaxLineMapper = (account: AccountMeta & { raw: Record<string, unknown> }) => TaxLine | null;

export const UNASSIGNED_PL: TaxLine = { id: '', name: 'Tax Line Unassigned (income/expense)', order: 1_000_000 };
export const UNASSIGNED_BS: TaxLine = { id: '-bs', name: 'Tax Line Unassigned (balance sheet)', order: 1_000_001 };

/**
 * The QuickBooks mapper for a company: resolves the stored key through the tax-line list (label +
 * form order) and keeps only lines of the company's form. With no form chosen, any known line
 * counts (ordered by form, then line order).
 */
export function formTaxLineMapper(form: IncomeTaxForm | null): TaxLineMapper {
  const order = new Map<string, number>();
  const forms = form ? [form] : INCOME_TAX_FORMS.map((f) => f.value);
  let i = 0;
  for (const f of forms) for (const t of taxLinesForForm(f)) order.set(t.key, i++);
  return (a) => {
    const v = a.raw.taxLine ?? a.raw.tax_line ?? a.raw.taxLineId;
    const line: FormTaxLine | undefined = typeof v === 'string' ? getTaxLine(v) : undefined;
    if (!line || !order.has(line.key)) return null;
    return { id: line.key, name: line.label, order: order.get(line.key) };
  };
}

/** Kept for callers that map accounts themselves: resolves the key with every form's list. */
export const defaultTaxLineMapper: TaxLineMapper = formTaxLineMapper(null);

async function setup(ctx: ServiceContext, mapper?: TaxLineMapper) {
  const meta = await loadAccountMeta(ctx);
  const raw = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const rawById = new Map(raw.map((r) => [r.id, r as unknown as Record<string, unknown>]));
  const form = await getIncomeTaxForm(ctx);
  const map = mapper ?? formTaxLineMapper(form);
  const lineOf = (a: AccountMeta): TaxLine =>
    map({ ...a, raw: rawById.get(a.id) ?? {} }) ?? (isPLSection(a.section) ? UNASSIGNED_PL : UNASSIGNED_BS);
  const formLabel = form ? INCOME_TAX_FORMS.find((f) => f.value === form)?.label : undefined;
  return { meta, lineOf, formLabel };
}

/** Form order, unassigned last; ties by name. */
function byLineOrder(a: TaxLine, b: TaxLine): number {
  const oa = a.order ?? 500_000;
  const ob = b.order ?? 500_000;
  return oa - ob || a.name.localeCompare(b.name);
}

/** Income Tax Preparation — every account with its assigned tax line (by tax line, then account). */
export async function incomeTaxPreparation(ctx: ServiceContext, _p: ReportParams, mapper?: TaxLineMapper): Promise<StdReport> {
  const { meta, lineOf, formLabel } = await setup(ctx, mapper);
  const list = [...meta.values()]
    .filter((a) => a.subtype !== 'non_posting')
    .map((a) => ({ a, line: lineOf(a) }))
    .sort((x, y) => byLineOrder(x.line, y.line) || x.a.code.localeCompare(y.a.code, undefined, { numeric: true }));
  return {
    key: 'income-tax-preparation',
    title: 'Income Tax Preparation',
    subtitle: formLabel ? `Tax line assignments · ${formLabel}` : 'Tax line assignments · choose your tax form in Company settings',
    columns: [
      { key: 'label', header: 'Account' },
      { key: 'type', header: 'Type' },
      { key: 'taxLine', header: 'Tax Line' },
    ],
    rows: list.map(({ a, line }) => ({
      id: `itp:${a.id}`,
      depth: 0,
      kind: 'data',
      cells: { label: a.fullName, type: SECTION_LABELS[a.section], taxLine: line.name },
    })),
  };
}

/**
 * Income Tax Summary / Detail — period activity per tax line (P&L accounts: activity in the
 * range; balance-sheet accounts: balance at the end date), in form order.
 */
export async function incomeTaxReport(
  ctx: ServiceContext,
  p: ReportParams,
  detail: boolean,
  mapper?: TaxLineMapper,
): Promise<StdReport> {
  const { from, to } = await resolveRange(ctx, p);
  const basis = p.basis === 'cash' ? 'cash' : undefined;
  const { meta, lineOf, formLabel } = await setup(ctx, mapper);
  const [plAct, bsAct] = await Promise.all([
    activityByAccount(ctx, { from, to, excludeClose: true, basis }),
    activityByAccount(ctx, { to, basis }),
  ]);
  const perAccount = new Map<string, Decimal>();
  for (const r of plAct) {
    const a = meta.get(r.accountId);
    if (a && isPLSection(a.section)) perAccount.set(r.accountId, (perAccount.get(r.accountId) ?? Money.zero()).plus(naturalAmount(a.section, r.debit, r.credit)));
  }
  for (const r of bsAct) {
    const a = meta.get(r.accountId);
    if (a && !isPLSection(a.section)) perAccount.set(r.accountId, (perAccount.get(r.accountId) ?? Money.zero()).plus(naturalAmount(a.section, r.debit, r.credit)));
  }
  const groups = new Map<string, { line: TaxLine; accounts: { a: AccountMeta; v: Decimal }[] }>();
  for (const [id, v] of perAccount) {
    if (v.isZero()) continue;
    const a = meta.get(id);
    if (!a) continue;
    const t = lineOf(a);
    if (!groups.has(t.id)) groups.set(t.id, { line: t, accounts: [] });
    groups.get(t.id)!.accounts.push({ a, v });
  }
  const rows: StdRow[] = [];
  const zoom = (a: AccountMeta) =>
    stdHref('transaction-detail-by-account', {
      accountId: a.id,
      from: isPLSection(a.section) ? dayStr(from) : undefined,
      to: dayStr(to),
      basis,
    });
  for (const g of [...groups.values()].sort((x, y) => byLineOrder(x.line, y.line))) {
    const total = g.accounts.reduce((s, x) => s.plus(x.v), Money.zero());
    const hid = `it:${g.line.id || 'none'}`;
    const sorted = g.accounts.sort((x, y) => x.a.code.localeCompare(y.a.code, undefined, { numeric: true }));
    if (!detail) {
      rows.push({
        id: hid,
        depth: 0,
        kind: 'data',
        cells: { label: g.line.name, amount: amt(total) },
        // QuickZoom: one account → its transactions; several → the detail report.
        href: sorted.length === 1 ? zoom(sorted[0].a) : stdHref('income-tax-detail', { from: dayStr(from), to: dayStr(to), basis }),
      });
      continue;
    }
    rows.push({ id: hid, depth: 0, kind: 'section', collapseKind: 'group', cells: { label: g.line.name }, collapsedCells: { label: g.line.name, amount: amt(total) } });
    for (const x of sorted) {
      rows.push({ id: `${hid}:${x.a.id}`, parentId: hid, depth: 1, kind: 'data', cells: { label: x.a.fullName, amount: amt(x.v) }, href: zoom(x.a) });
    }
    rows.push({ id: `${hid}:total`, depth: 0, kind: 'subtotal', totalOf: hid, cells: { label: `Total ${g.line.name}`, amount: amt(total) } });
  }
  const parts = [rangeLabel(from, to)];
  if (formLabel) parts.push(formLabel);
  if (basis) parts.push('Cash Basis');
  return {
    key: detail ? 'income-tax-detail' : 'income-tax-summary',
    title: detail ? 'Income Tax Detail' : 'Income Tax Summary',
    subtitle: parts.join(' · '),
    columns: [{ key: 'label', header: 'Tax Line' }, { key: 'amount', header: 'Amount', type: 'money' }],
    rows,
    notes: formLabel ? undefined : ['Choose your income tax form in Company settings so only that form’s lines are used.'],
  };
}
