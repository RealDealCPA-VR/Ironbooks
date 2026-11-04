/**
 * Client Data Review — the tasks added in the feature round (accountant, PARITY I13):
 *
 *   undeposited_funds   a real "Clear Up Undeposited Funds" matcher: a payment or sales receipt
 *                       still waiting in Undeposited Funds whose money was ALSO recorded by a
 *                       deposit straight to income (or A/R), so the income is counted twice.
 *                       The fix rewrites that deposit to take the payment(s) instead of its
 *                       direct line (deposits.updateDeposit: same checks, re-post and audit as
 *                       an edit of the deposit), which moves the payment out of Undeposited Funds
 *                       and the duplicate income out of the books.
 *   vendor_1099         1099 vendors paid through accounts not mapped to a 1099 box (when a
 *                       mapping exists, those payments are left off the 1099s), no mapping at
 *                       all, and 1099 vendors with no tax ID.
 *   unapplied_vendor_payments  checks / card charges written to Accounts Payable for a vendor
 *                       and never applied to a bill, and bill payments that pay more than the
 *                       bills they were applied to.
 *   employee_defaults   active employees missing what payroll and W-2s need (pay rate, SSN,
 *                       W-4 filing status, address, hire date).
 *   closing_date        the books are not closed through the end of the reviewed period, the
 *                       closing date has no password, and changes made in the closed period
 *                       since the last review (Closing Date Exception report).
 *
 * Every finder is read-only; clearUpUndepositedFunds is the one fix that writes.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  billPayments,
  depositLines,
  deposits,
  employees,
  journalEntries,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, notFound, validation } from '../_base';
import {
  CASHBACK_LINE_PREFIX,
  INVOICE_PAYMENT_LINE_PREFIX,
  RECEIPT_LINE_PREFIX,
  type CashBackInput,
  type ExtraDepositLineInput,
  type UndepositedItem,
  getDeposit,
  listUndepositedPayments,
  updateDeposit,
} from '../deposits';
import { get1099Mapping } from '../statements';
import { getClosingDateSettings } from '../company';
import { journalOpenItems, resolveEntityNames } from '../journal';
import { requirePermission } from '../access';
import { closingDateExceptionReport } from './auditReports';

/** Issue shape shared with clientDataReview.ts (kept structural to avoid an import cycle). */
export interface ReviewIssueLike {
  id: string;
  title: string;
  detail: string;
  amount?: string;
  fix?:
    | { kind: 'link'; href: string; label: string }
    | { kind: 'clear_undeposited'; depositId: string; lineId: string; items: Array<{ kind: UndepositedItem['kind']; id: string }> }
    | { kind: 'set_closing_date'; suggested: string | null };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const MATCH_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Clear Up Undeposited Funds
// ---------------------------------------------------------------------------

interface DirectLine {
  depositId: string;
  depositDate: Date;
  lineId: string;
  amount: string;
  accountLabel: string;
  currency: string | null;
}

/** Deposit lines that credit income or A/R directly (not through Undeposited Funds). */
async function directIncomeLines(ctx: ServiceContext): Promise<DirectLine[]> {
  const rows = await ctx.db
    .select({
      depositId: deposits.id,
      depositDate: deposits.date,
      currency: deposits.currency,
      lineId: depositLines.id,
      amount: depositLines.amount,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(depositLines)
    .innerJoin(deposits, eq(depositLines.depositId, deposits.id))
    .innerJoin(accounts, eq(depositLines.accountId, accounts.id))
    .where(and(eq(deposits.companyId, ctx.companyId), isNull(deposits.voidedAt), isNull(depositLines.paymentId)));
  return rows
    .filter((r) => {
      const t = String(r.type);
      const st = String(r.subtype);
      return Money.isPositive(r.amount) && (t === 'revenue' || (t === 'asset' && st === 'accounts_receivable'));
    })
    .map((r) => ({
      depositId: r.depositId,
      depositDate: r.depositDate,
      lineId: r.lineId,
      amount: toAmountString(r.amount),
      accountLabel: `${r.code} · ${r.name}`,
      currency: r.currency ? r.currency.toUpperCase() : null,
    }));
}

export interface UndepositedMatch {
  line: DirectLine;
  items: UndepositedItem[];
}

/**
 * Pair Undeposited Funds items with direct deposit lines: one item of the same amount deposited
 * within 30 days after it (closest date first), else all the items of one day that add up to the
 * line. Each item and each line is used once.
 */
export async function matchUndepositedFunds(ctx: ServiceContext): Promise<{ matches: UndepositedMatch[]; waiting: UndepositedItem[] }> {
  let waiting: UndepositedItem[];
  try {
    waiting = await listUndepositedPayments(ctx);
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'NOT_FOUND') return { matches: [], waiting: [] };
    throw err;
  }
  const lines = await directIncomeLines(ctx);
  const used = new Set<string>();
  const matches: UndepositedMatch[] = [];
  const cur = (i: UndepositedItem) => (i.currency ? i.currency.toUpperCase() : null);
  const inWindow = (i: UndepositedItem, l: DirectLine) => {
    const days = (l.depositDate.getTime() - i.date.getTime()) / 86_400_000;
    return days >= -0.5 && days <= MATCH_WINDOW_DAYS + 0.5;
  };
  // 1) One payment, one line.
  const pairs: Array<{ i: UndepositedItem; l: DirectLine; gap: number }> = [];
  for (const l of lines) {
    for (const i of waiting) {
      if (cur(i) !== l.currency || !Money.eq(i.amount, l.amount) || !inWindow(i, l)) continue;
      pairs.push({ i, l, gap: Math.abs(l.depositDate.getTime() - i.date.getTime()) });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap);
  const lineUsed = new Set<string>();
  for (const p of pairs) {
    const key = `${p.i.kind}:${p.i.id}`;
    if (used.has(key) || lineUsed.has(p.l.lineId)) continue;
    used.add(key);
    lineUsed.add(p.l.lineId);
    matches.push({ line: p.l, items: [p.i] });
  }
  // 2) A day's payments deposited together as one direct line.
  for (const l of lines) {
    if (lineUsed.has(l.lineId)) continue;
    const byDay = new Map<string, UndepositedItem[]>();
    for (const i of waiting) {
      if (used.has(`${i.kind}:${i.id}`) || cur(i) !== l.currency || !inWindow(i, l)) continue;
      const k = isoDay(i.date);
      (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(i);
    }
    for (const group of byDay.values()) {
      if (group.length < 2) continue;
      const total = group.reduce((s, i) => s.plus(Money.of(i.amount)), Money.zero());
      if (!total.equals(Money.of(l.amount))) continue;
      for (const i of group) used.add(`${i.kind}:${i.id}`);
      lineUsed.add(l.lineId);
      matches.push({ line: l, items: group });
      break;
    }
  }
  return { matches, waiting: waiting.filter((i) => !used.has(`${i.kind}:${i.id}`)) };
}

/** The Clear Up Undeposited Funds issues, then the items simply waiting too long. */
export async function undepositedFundsIssues(ctx: ServiceContext, olderThanDays: number, today: Date = new Date()): Promise<ReviewIssueLike[]> {
  const { matches, waiting } = await matchUndepositedFunds(ctx);
  const out: ReviewIssueLike[] = matches.map((m) => {
    const who = [...new Set(m.items.map((i) => i.customerName ?? 'Walk-in'))].join(', ');
    const what = m.items.length === 1 ? `${m.items[0].kind === 'sales_receipt' ? 'Sales receipt' : 'Payment'} of ${isoDay(m.items[0].date)}` : `${m.items.length} payments of ${isoDay(m.items[0].date)}`;
    return {
      id: `uf_match:${m.line.lineId}`,
      title: `${who}: ${what} is still in Undeposited Funds, but the deposit of ${isoDay(m.line.depositDate)} recorded the same ${m.line.amount}`,
      detail: `The deposit put ${m.line.amount} straight to ${m.line.accountLabel} instead of taking the payment out of Undeposited Funds, so this income is counted twice. Clear it up: the deposit takes the payment in place of that line (its total and date stay the same).`,
      amount: m.line.amount,
      fix: { kind: 'clear_undeposited', depositId: m.line.depositId, lineId: m.line.lineId, items: m.items.map((i) => ({ kind: i.kind, id: i.id })) },
    };
  });
  const cutoff = today.getTime() - olderThanDays * 86_400_000;
  for (const i of waiting.filter((x) => x.date.getTime() <= cutoff)) {
    out.push({
      id: `${i.kind}:${i.id}`,
      title: `${i.customerName ?? 'Walk-in'}: ${i.kind === 'payment' ? 'payment' : 'sales receipt'} of ${isoDay(i.date)} not yet deposited`,
      detail: `${toAmountString(i.amount)} has been waiting in Undeposited Funds for more than ${olderThanDays} days and no deposit recorded the same amount. Deposit it, or void it if it was recorded twice.`,
      amount: toAmountString(i.amount),
      fix: { kind: 'link', href: '/deposits', label: 'Make deposits' },
    });
  }
  return out;
}

/**
 * Clear up one match: the deposit's direct income line is replaced by the payment(s) still in
 * Undeposited Funds (same total). Needs Banking: modify (it edits the deposit).
 */
export async function clearUpUndepositedFunds(
  ctx: ServiceContext,
  input: { depositId: string; lineId: string; items: Array<{ kind: UndepositedItem['kind']; id: string }> },
): Promise<{ depositId: string; moved: number }> {
  requirePermission(ctx, 'banking.deposits', 'modify');
  if (!input.items?.length) throw validation('Choose the payments to deposit.');
  const deposit = await getDeposit(ctx, input.depositId);
  if (deposit.voidedAt) throw new ServiceError('CONFLICT', 'This deposit is void.');
  const line = deposit.lines.find((l) => l.id === input.lineId);
  if (!line || line.paymentId || !line.accountId) throw notFound('Deposit line');
  const waiting = await listUndepositedPayments(ctx);
  const chosen = input.items.map((it) => {
    const w = waiting.find((x) => x.kind === it.kind && x.id === it.id);
    if (!w) throw new ServiceError('CONFLICT', 'That payment is no longer in Undeposited Funds.');
    return w;
  });
  const total = chosen.reduce((s, i) => s.plus(Money.of(i.amount)), Money.zero());
  if (!total.equals(Money.of(line.amount))) {
    throw validation(`The payments total ${toAmountString(total)}, but the deposit line is ${toAmountString(line.amount)}.`);
  }
  const paymentIds: string[] = [];
  const salesReceiptIds: string[] = [];
  const invoicePaymentIds: string[] = [];
  const extraLines: ExtraDepositLineInput[] = [];
  let cashBack: CashBackInput | null = null;
  for (const l of deposit.lines) {
    const desc = l.description ?? '';
    if (l.id === line.id) continue;
    if (l.paymentId) paymentIds.push(l.paymentId);
    else if (desc.startsWith(RECEIPT_LINE_PREFIX)) salesReceiptIds.push(desc.slice(RECEIPT_LINE_PREFIX.length));
    else if (desc.startsWith(INVOICE_PAYMENT_LINE_PREFIX)) invoicePaymentIds.push(desc.slice(INVOICE_PAYMENT_LINE_PREFIX.length));
    else if (desc.startsWith(CASHBACK_LINE_PREFIX)) cashBack = { accountId: desc.slice(CASHBACK_LINE_PREFIX.length), amount: toAmountString(Money.of(l.amount).abs()) };
    else if (l.accountId) extraLines.push({ accountId: l.accountId, amount: l.amount, description: l.description });
    else throw new ServiceError('CONFLICT', 'This deposit has a line from an older version. Open the deposit and add the payment there.');
  }
  for (const c of chosen) {
    if (c.kind === 'payment') paymentIds.push(c.id);
    else if (c.kind === 'sales_receipt') salesReceiptIds.push(c.id);
    else invoicePaymentIds.push(c.id);
  }
  await updateDeposit(ctx, deposit.id, {
    depositAccountId: deposit.depositAccountId,
    date: deposit.date,
    paymentIds,
    salesReceiptIds,
    invoicePaymentIds,
    extraLines,
    cashBack,
    memo: deposit.memo,
    exchangeRate: deposit.currency ? deposit.exchangeRate : null,
  });
  return { depositId: deposit.id, moved: chosen.length };
}

// ---------------------------------------------------------------------------
// 1099 account mapping
// ---------------------------------------------------------------------------

export async function vendor1099Issues(ctx: ServiceContext, year: number): Promise<ReviewIssueLike[]> {
  const out: ReviewIssueLike[] = [];
  const vend = await ctx.db
    .select({ id: vendors.id, name: vendors.displayName, taxId: vendors.taxId })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.is1099, true), eq(vendors.isActive, true)));
  if (vend.length === 0) return out;
  for (const v of vend) {
    if (!v.taxId?.trim()) {
      out.push({
        id: `1099_taxid:${v.id}`,
        title: `${v.name}: 1099 vendor with no tax ID`,
        detail: 'A 1099 needs the vendor\'s tax ID (EIN or SSN). Ask the vendor for a W-9 and enter it on the vendor.',
        fix: { kind: 'link', href: `/vendors?focus=${v.id}`, label: 'Edit vendor' },
      });
    }
  }
  // Accounts this year's payments to 1099 vendors went to (checks, card charges, and the bills
  // their bill payments paid).
  const ids = vend.map((v) => v.id);
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  const used = await ctx.db.execute(sql`
    SELECT a.id::text AS id, a.code, a.name, SUM(x.amount)::text AS amount FROM (
      SELECT el.account_id, el.amount FROM expense_lines el
        JOIN expenses e ON e.id = el.expense_id
       WHERE e.company_id = ${ctx.companyId}::uuid AND e.voided_at IS NULL
         AND e.vendor_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
         AND e.date >= ${from} AND e.date <= ${to} AND el.account_id IS NOT NULL
      UNION ALL
      SELECT bl.account_id, bl.amount FROM bill_lines bl
        JOIN bills b ON b.id = bl.bill_id
       WHERE b.company_id = ${ctx.companyId}::uuid AND b.status <> 'void'
         AND b.vendor_id IN (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
         AND b.date >= ${from} AND b.date <= ${to} AND bl.account_id IS NOT NULL
    ) x JOIN accounts a ON a.id = x.account_id
    GROUP BY a.id, a.code, a.name`);
  const usedRows = (used as unknown as { rows: Array<{ id: string; code: string; name: string; amount: string }> }).rows;
  if (usedRows.length === 0) return out;
  const mapping = await get1099Mapping(ctx);
  if (!mapping || mapping.boxes.every((b) => b.accountIds.length === 0)) {
    out.push({
      id: '1099_mapping:none',
      title: '1099 accounts are not mapped',
      detail: `Payments to 1099 vendors this year went to ${usedRows.length} account(s), and no account is mapped to a 1099 box, so every payment is reported as nonemployee compensation (1099-NEC box 1). Map rent and other income accounts to their 1099-MISC boxes.`,
      fix: { kind: 'link', href: '/reports/1099', label: 'Map 1099 accounts' },
    });
    return out;
  }
  const mapped = new Set(mapping.boxes.flatMap((b) => b.accountIds));
  for (const a of usedRows) {
    if (mapped.has(a.id)) continue;
    out.push({
      id: `1099_unmapped:${a.id}`,
      title: `${a.code} · ${a.name} is not mapped to a 1099 box`,
      detail: `${toAmountString(a.amount)} paid to 1099 vendors in ${year} went to this account, which no 1099 box includes, so it is left off their 1099s. Map it, or confirm it is not reportable.`,
      amount: toAmountString(a.amount),
      fix: { kind: 'link', href: '/reports/1099', label: 'Map 1099 accounts' },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unapplied vendor (bill) payments
// ---------------------------------------------------------------------------

export async function unappliedVendorPaymentIssues(ctx: ServiceContext): Promise<ReviewIssueLike[]> {
  const out: ReviewIssueLike[] = [];
  // Checks / card charges written to A/P for a vendor (QB: "unapplied vendor payments").
  const items = (await journalOpenItems(ctx, 'ap')).filter((j) => Money.lt(j.amount, 0));
  const entries = items.length
    ? await ctx.db
        .select({ id: journalEntries.id, sourceRef: journalEntries.sourceRef })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntries.id, [...new Set(items.map((i) => i.journalEntryId))])))
    : [];
  const refOf = new Map(entries.map((e) => [e.id, e.sourceRef ?? '']));
  const fromChecks = items.filter((i) => (refOf.get(i.journalEntryId) ?? '').startsWith('expense:'));
  const names = await resolveEntityNames(ctx, fromChecks);
  for (const j of fromChecks) {
    const name = names.get(`vendor:${j.entityId}`) ?? 'Vendor';
    const amt = toAmountString(Money.abs(j.amount));
    out.push({
      id: `ap_check:${j.lineId}`,
      title: `${name}: check of ${isoDay(j.date)} paid ${amt} to Accounts Payable without paying a bill`,
      detail: 'The check went to Accounts Payable but was never applied to a bill, so the vendor shows both an open bill and a credit. Apply it to the bill in Pay Bills (Set Credits).',
      amount: amt,
      fix: { kind: 'link', href: '/pay-bills', label: 'Pay Bills' },
    });
  }
  // Bill payments that pay more than the bills they were applied to.
  const pays = await ctx.db
    .select({
      id: billPayments.id,
      date: billPayments.date,
      amount: billPayments.amount,
      vendor: vendors.displayName,
      applied: sql<string>`COALESCE((SELECT SUM(a.amount_applied) FROM bill_payment_applications a WHERE a.bill_payment_id = ${billPayments.id}), 0)`,
    })
    .from(billPayments)
    .innerJoin(vendors, eq(vendors.id, billPayments.vendorId))
    .where(and(eq(billPayments.companyId, ctx.companyId), isNull(billPayments.voidedAt)));
  for (const p of pays) {
    const left = Money.of(p.amount).minus(Money.of(p.applied));
    if (!left.greaterThan('0.005')) continue;
    out.push({
      id: `bill_payment:${p.id}`,
      title: `${p.vendor}: bill payment of ${isoDay(p.date)} has ${toAmountString(left)} not applied to a bill`,
      detail: `The payment was ${toAmountString(p.amount)} but only ${toAmountString(p.applied)} paid bills. Apply the rest to an open bill, or record the vendor credit or refund it stands for.`,
      amount: toAmountString(left),
      fix: { kind: 'link', href: '/pay-bills', label: 'Pay Bills' },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Employee defaults
// ---------------------------------------------------------------------------

export async function employeeDefaultIssues(ctx: ServiceContext): Promise<ReviewIssueLike[]> {
  const out: ReviewIssueLike[] = [];
  const emps = await ctx.db
    .select({
      id: employees.id,
      first: employees.firstName,
      last: employees.lastName,
      payType: employees.payType,
      payRate: employees.payRate,
      ssn: employees.ssn,
      w4: employees.w4,
      address: employees.address,
      hireDate: employees.hireDate,
    })
    .from(employees)
    .where(and(eq(employees.companyId, ctx.companyId), eq(employees.isActive, true)));
  if (emps.length === 0) return out;
  for (const e of emps) {
    const name = `${e.first ?? ''} ${e.last ?? ''}`.trim() || 'Employee';
    const missing: string[] = [];
    if (String(e.payType) !== 'commission' && Money.isZero(e.payRate ?? 0)) missing.push('pay rate');
    if (!e.ssn) missing.push('Social Security number');
    const w4 = (e.w4 ?? {}) as Record<string, unknown>;
    if (!w4.filingStatus) missing.push('W-4 filing status');
    const addr = (e.address ?? {}) as Record<string, unknown>;
    if (!addr.line1 || !addr.city || !addr.state || !addr.zip) missing.push('address (W-2)');
    if (!e.hireDate) missing.push('hire date');
    if (missing.length === 0) continue;
    out.push({
      id: `employee:${e.id}`,
      title: `${name}: missing ${missing.join(', ')}`,
      detail: 'Paychecks, payroll tax forms and W-2s use these. Fill them in on the employee.',
      fix: { kind: 'link', href: `/employees?focus=${e.id}`, label: 'Edit employee' },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Closing date
// ---------------------------------------------------------------------------

export async function closingDateIssues(ctx: ServiceContext, lastReview: { asOf: string; at: Date } | null): Promise<ReviewIssueLike[]> {
  const out: ReviewIssueLike[] = [];
  const { closingDate, hasPassword } = await getClosingDateSettings(ctx);
  const suggested = lastReview?.asOf ?? null;
  if (!closingDate) {
    out.push({
      id: 'closing:none',
      title: 'The books have no closing date',
      detail: `Anyone can still change reviewed periods. Set the closing date${suggested ? ` to the end of the reviewed period (${suggested})` : ''} and a closing date password.`,
      fix: { kind: 'set_closing_date', suggested },
    });
  } else if (suggested && closingDate < suggested) {
    out.push({
      id: 'closing:behind',
      title: `The books are closed through ${closingDate}, before the reviewed period ends (${suggested})`,
      detail: 'Move the closing date to the end of the period you reviewed so it can\'t change after the review.',
      fix: { kind: 'set_closing_date', suggested },
    });
  }
  if (closingDate && !hasPassword) {
    out.push({
      id: 'closing:no_password',
      title: 'The closing date has no password',
      detail: 'Without a password, anyone who may change closed periods can do it without being asked. Add a closing date password.',
      fix: { kind: 'set_closing_date', suggested: closingDate },
    });
  }
  if (closingDate) {
    const rep = await closingDateExceptionReport(ctx, { from: lastReview?.at ?? null });
    if (rep.groups.length > 0) {
      out.push({
        id: 'closing:exceptions',
        title: `${rep.groups.length} transaction(s) in the closed period changed${lastReview ? ' since the last review' : ''}`,
        detail: 'Review each change on the Closing Date Exception report (latest and prior values).',
        fix: { kind: 'link', href: '/reports/closing-date-exceptions', label: 'Closing Date Exception report' },
      });
    }
  }
  return out;
}
