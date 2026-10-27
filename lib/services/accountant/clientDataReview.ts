/**
 * Client Data Review (QB Accountant → Client Data Review) — wave2 accountant, I13.
 *
 * A checklist of clean-up tasks, each listing the issues it found and a fix action:
 *
 *   unapplied_customer_credits   customer payments / credit memos with money not applied while
 *                                the same customer has open invoices → "Apply" (oldest first,
 *                                through payments.applyPayment / creditMemos.applyToInvoice)
 *   undeposited_funds            payments & sales receipts sitting in Undeposited Funds for more
 *                                than N days → open Make Deposits
 *   unapplied_vendor_credits     bill credits not applied while the vendor has open bills
 *                                → "Apply" (vendorCredits.applyToBill)
 *   item_setup                   items missing income / asset accounts, negative stock, inactive
 *                                items still on hand → open the item
 *   payroll_liabilities          payroll liabilities (2300) paid by check / bill / journal entry
 *                                instead of Pay Liabilities → open the entry
 *   compare_balances             account balances (as of the last review date) that changed since
 *                                the review snapshot was taken → see the changes
 *   prior_balances               the transactions behind those changes (dated in the reviewed
 *                                period but entered/changed after the review) → open/audit
 *
 * Task status (not started / in progress / completed) and review snapshots are stored per company
 * (client_review_tasks / client_review_snapshots); every change is audited.
 */
import { and, asc, desc, eq, gt, lte, ne, sql } from 'drizzle-orm';
import {
  accounts,
  bills,
  clientReviewSnapshots,
  clientReviewTasks,
  creditMemos,
  customers,
  invoices,
  items,
  journalEntries,
  journalEntryLines,
  paymentsReceived,
  users,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from '../_base';
import { listUndepositedPayments } from '../deposits';
import { applyPayment } from '../payments';
import { applyToInvoice } from '../creditMemos';
import { applyToBill } from '../vendorCredits';
import { journalOpenItems, resolveEntityNames } from '../journal';
import { requirePermission } from '../access';

export const REVIEW_TASKS = [
  { key: 'unapplied_customer_credits', group: 'Customers', title: 'Fix unapplied customer payments and credits' },
  { key: 'undeposited_funds', group: 'Customers', title: 'Clear up Undeposited Funds' },
  { key: 'unapplied_vendor_credits', group: 'Vendors', title: 'Fix unapplied vendor payments and credits' },
  { key: 'item_setup', group: 'Items', title: 'Review item setup' },
  { key: 'payroll_liabilities', group: 'Payroll', title: 'Find incorrectly paid payroll liabilities' },
  { key: 'compare_balances', group: 'Account balances', title: 'Compare balances with the last review' },
  { key: 'prior_balances', group: 'Account balances', title: 'Troubleshoot prior account balances' },
] as const;
export type ReviewTaskKey = (typeof REVIEW_TASKS)[number]['key'];

export interface ReviewIssue {
  id: string;
  title: string;
  detail: string;
  amount?: string;
  /** Fix action the UI offers: an API action, or a link to the screen that fixes it. */
  fix?: { kind: 'apply_customer_credit'; refType: 'payment' | 'credit_memo'; refId: string }
    | { kind: 'apply_vendor_credit'; refId: string }
    | { kind: 'link'; href: string; label: string };
}

export interface ReviewTaskResult {
  key: ReviewTaskKey;
  group: string;
  title: string;
  status: 'not_started' | 'in_progress' | 'completed';
  note: string | null;
  issues: ReviewIssue[];
}

// ---------------------------------------------------------------------------
// Individual task finders
// ---------------------------------------------------------------------------

async function unappliedCustomerCredits(ctx: ServiceContext): Promise<ReviewIssue[]> {
  const open = await ctx.db
    .select({ customerId: invoices.customerId, n: sql<number>`COUNT(*)`, due: sql<string>`SUM(${invoices.balanceDue})` })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), sql`${invoices.status} NOT IN ('void','draft','paid')`, gt(invoices.balanceDue, '0')))
    .groupBy(invoices.customerId);
  const openBy = new Map(open.map((o) => [o.customerId, o]));
  const out: ReviewIssue[] = [];
  const pays = await ctx.db
    .select({ id: paymentsReceived.id, customerId: paymentsReceived.customerId, unapplied: paymentsReceived.unapplied, date: paymentsReceived.date, name: customers.displayName })
    .from(paymentsReceived)
    .innerJoin(customers, eq(paymentsReceived.customerId, customers.id))
    .where(and(eq(paymentsReceived.companyId, ctx.companyId), sql`${paymentsReceived.voidedAt} IS NULL`, gt(paymentsReceived.unapplied, '0')));
  for (const p of pays) {
    const o = openBy.get(p.customerId);
    out.push({
      id: `payment:${p.id}`,
      title: `${p.name}: payment of ${p.date.toISOString().slice(0, 10)} has ${toAmountString(p.unapplied)} not applied`,
      detail: o
        ? `${p.name} has ${Number(o.n)} open invoice(s) totalling ${toAmountString(o.due)}. Apply the payment to them.`
        : `${p.name} has no open invoices — refund the overpayment or leave it as a credit.`,
      amount: toAmountString(p.unapplied),
      fix: o
        ? { kind: 'apply_customer_credit', refType: 'payment', refId: p.id }
        : { kind: 'link', href: `/payments?focus=${p.id}`, label: 'Open payment' },
    });
  }
  const memos = await ctx.db
    .select({ id: creditMemos.id, customerId: creditMemos.customerId, unapplied: creditMemos.unapplied, n: sql<string>`COALESCE(NULLIF(${creditMemos.refNumber}, ''), CAST(${creditMemos.memoNumber} AS TEXT))`, name: customers.displayName })
    .from(creditMemos)
    .innerJoin(customers, eq(creditMemos.customerId, customers.id))
    .where(and(eq(creditMemos.companyId, ctx.companyId), ne(creditMemos.status, 'void'), gt(creditMemos.unapplied, '0')));
  for (const m of memos) {
    const o = openBy.get(m.customerId);
    out.push({
      id: `credit_memo:${m.id}`,
      title: `${m.name}: credit memo #${m.n} has ${toAmountString(m.unapplied)} not applied`,
      detail: o
        ? `${m.name} has ${Number(o.n)} open invoice(s). Apply the credit to them.`
        : `${m.name} has no open invoices — refund the credit or keep it for future invoices.`,
      amount: toAmountString(m.unapplied),
      fix: o
        ? { kind: 'apply_customer_credit', refType: 'credit_memo', refId: m.id }
        : { kind: 'link', href: `/credit-memos?focus=${m.id}`, label: 'Open credit memo' },
    });
  }
  // I11: General Journal credits to A/R for a customer are open credits too.
  const journalCredits = (await journalOpenItems(ctx, 'ar')).filter((j) => Money.lt(j.amount, 0));
  const names = await resolveEntityNames(ctx, journalCredits);
  for (const j of journalCredits) {
    const name = names.get(`customer:${j.entityId}`) ?? 'Customer';
    const o = openBy.get(j.entityId);
    const amt = toAmountString(Money.abs(j.amount));
    out.push({
      id: `journal_line:${j.lineId}`,
      title: `${name}: General Journal #${j.entryNumber} credit has ${amt} not applied`,
      detail: o
        ? `${name} has ${Number(o.n)} open invoice(s). Apply the credit to them in Receive Payments.`
        : `${name} has no open invoices — keep the credit for future invoices or refund it.`,
      amount: amt,
      fix: { kind: 'link', href: '/payments', label: 'Receive Payments' },
    });
  }
  return out;
}

async function undepositedFunds(ctx: ServiceContext, olderThanDays: number): Promise<ReviewIssue[]> {
  let items: Awaited<ReturnType<typeof listUndepositedPayments>> = [];
  try {
    items = await listUndepositedPayments(ctx);
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'NOT_FOUND') return []; // no UF account
    throw err;
  }
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  return items
    .filter((i) => i.date.getTime() <= cutoff)
    .map((i) => ({
      id: `${i.kind}:${i.id}`,
      title: `${i.customerName ?? 'Walk-in'}: ${i.kind === 'payment' ? 'payment' : 'sales receipt'} of ${i.date.toISOString().slice(0, 10)} not yet deposited`,
      detail: `${toAmountString(i.amount)} has been waiting in Undeposited Funds for more than ${olderThanDays} days. Deposit it, or void it if it was recorded twice.`,
      amount: toAmountString(i.amount),
      fix: { kind: 'link' as const, href: '/deposits', label: 'Make deposits' },
    }));
}

async function unappliedVendorCredits(ctx: ServiceContext): Promise<ReviewIssue[]> {
  const open = await ctx.db
    .select({ vendorId: bills.vendorId, n: sql<number>`COUNT(*)` })
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), sql`${bills.status} NOT IN ('void','draft','paid')`, gt(bills.balanceDue, '0')))
    .groupBy(bills.vendorId);
  const openBy = new Map(open.map((o) => [o.vendorId, Number(o.n)]));
  const credits = await ctx.db
    .select({ id: vendorCredits.id, vendorId: vendorCredits.vendorId, unapplied: vendorCredits.unapplied, date: vendorCredits.date, name: vendors.displayName })
    .from(vendorCredits)
    .innerJoin(vendors, eq(vendorCredits.vendorId, vendors.id))
    .where(and(eq(vendorCredits.companyId, ctx.companyId), ne(vendorCredits.status, 'void'), gt(vendorCredits.unapplied, '0')));
  const out: ReviewIssue[] = credits.map((c) => {
    const n = openBy.get(c.vendorId) ?? 0;
    return {
      id: `vendor_credit:${c.id}`,
      title: `${c.name}: bill credit of ${c.date.toISOString().slice(0, 10)} has ${toAmountString(c.unapplied)} not applied`,
      detail: n > 0 ? `${c.name} has ${n} open bill(s). Apply the credit to them.` : `${c.name} has no open bills — ask for a refund or keep the credit.`,
      amount: toAmountString(c.unapplied),
      fix: n > 0 ? { kind: 'apply_vendor_credit' as const, refId: c.id } : { kind: 'link' as const, href: '/vendor-credits', label: 'Open bill credits' },
    };
  });
  // I11: General Journal debits to A/P for a vendor are vendor credits too.
  const journalCredits = (await journalOpenItems(ctx, 'ap')).filter((j) => Money.lt(j.amount, 0));
  const names = await resolveEntityNames(ctx, journalCredits);
  for (const j of journalCredits) {
    const name = names.get(`vendor:${j.entityId}`) ?? 'Vendor';
    const n = openBy.get(j.entityId) ?? 0;
    const amt = toAmountString(Money.abs(j.amount));
    out.push({
      id: `journal_line:${j.lineId}`,
      title: `${name}: General Journal #${j.entryNumber} credit has ${amt} not applied`,
      detail: n > 0 ? `${name} has ${n} open bill(s). Apply the credit to them in Pay Bills.` : `${name} has no open bills — ask for a refund or keep the credit.`,
      amount: amt,
      fix: { kind: 'link', href: '/pay-bills', label: 'Pay Bills' },
    });
  }
  return out;
}

async function itemSetup(ctx: ServiceContext): Promise<ReviewIssue[]> {
  const rows = await ctx.db.select().from(items).where(eq(items.companyId, ctx.companyId));
  const out: ReviewIssue[] = [];
  for (const it of rows) {
    const href = `/items?focus=${it.id}`;
    const sells = ['service', 'inventory', 'non_inventory', 'other_charge', 'bundle'].includes(it.type);
    const qty = Money.of(it.quantityOnHand ?? 0);
    if (it.isActive && sells && it.type !== 'bundle' && !it.incomeAccountId) {
      out.push({ id: `income:${it.id}`, title: `${it.name}: no income account`, detail: 'Sales of this item post to the default Sales Income account. Choose the right income account.', fix: { kind: 'link', href, label: 'Edit item' } });
    }
    if (it.type === 'inventory' && (!it.assetAccountId || !it.expenseAccountId)) {
      out.push({ id: `inv:${it.id}`, title: `${it.name}: inventory accounts incomplete`, detail: 'Inventory items need an inventory asset account and a cost of goods sold account.', fix: { kind: 'link', href, label: 'Edit item' } });
    }
    if (it.type === 'inventory' && qty.isNegative()) {
      out.push({ id: `neg:${it.id}`, title: `${it.name}: negative quantity on hand (${qty.toString()})`, detail: 'More was sold than received. Enter the missing purchase or adjust the quantity.', fix: { kind: 'link', href: '/inventory-ops', label: 'Adjust inventory' } });
    }
    if (!it.isActive && it.type === 'inventory' && !qty.isZero()) {
      out.push({ id: `inactive:${it.id}`, title: `${it.name}: inactive but ${qty.toString()} still on hand`, detail: 'An inactive item still carries inventory value. Adjust it to zero or reactivate it.', fix: { kind: 'link', href, label: 'Open item' } });
    }
  }
  return out;
}

async function payrollLiabilityMispayments(ctx: ServiceContext): Promise<ReviewIssue[]> {
  const [acct] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '2300')));
  if (!acct) return [];
  const rows = await ctx.db
    .select({
      lineId: journalEntryLines.id,
      debit: journalEntryLines.debit,
      entryId: journalEntries.id,
      n: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, acct.id),
        gt(journalEntryLines.debit, '0'),
      ),
    );
  // Pay Liabilities entries carry no sourceRef and a "Pay Payroll Liabilities" description (or a
  // memo-only description); paychecks are 'paycheck:'. Anything else that drains 2300 is suspect.
  return rows
    .filter((r) => {
      const ref = r.sourceRef ?? '';
      if (ref.startsWith('paycheck:')) return false;
      if (!ref && /pay payroll liabilit/i.test(r.description)) return false;
      return ref.startsWith('expense:') || ref.startsWith('bill:') || ref === 'manual' || ref.startsWith('adjusting');
    })
    .map((r) => ({
      id: `jel:${r.lineId}`,
      title: `Entry #${r.n} (${r.date.toISOString().slice(0, 10)}) paid payroll liabilities outside Pay Liabilities`,
      detail: `${r.description} — ${toAmountString(r.debit)} was taken out of Payroll Liabilities by a ${r.sourceRef?.startsWith('expense:') ? 'check' : r.sourceRef?.startsWith('bill:') ? 'bill' : 'journal entry'}, so the payroll liability reports will not show it as paid. Void it and record the payment with Pay Liabilities.`,
      amount: toAmountString(r.debit),
      fix: { kind: 'link' as const, href: `/journal?focus=${r.entryId}`, label: 'Open entry' },
    }));
}

// ---------------------------------------------------------------------------
// Balances snapshot (compare with last review / troubleshoot prior balances)
// ---------------------------------------------------------------------------

async function naturalBalancesAsOf(ctx: ServiceContext, asOf: Date): Promise<Record<string, string>> {
  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      type: accounts.type,
      d: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      c: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted'), lte(journalEntries.date, asOf)))
    .groupBy(journalEntryLines.accountId, accounts.type);
  const out: Record<string, string> = {};
  for (const r of rows) {
    const debitNormal = r.type === 'asset' || r.type === 'expense';
    out[r.accountId] = toAmountString(debitNormal ? Money.sub(r.d, r.c) : Money.sub(r.c, r.d));
  }
  return out;
}

function endOfDay(iso: string): Date {
  return new Date(`${iso}T23:59:59.999Z`);
}

export async function latestSnapshot(ctx: ServiceContext) {
  const [snap] = await ctx.db
    .select()
    .from(clientReviewSnapshots)
    .where(eq(clientReviewSnapshots.companyId, ctx.companyId))
    .orderBy(desc(clientReviewSnapshots.createdAt))
    .limit(1);
  return snap ?? null;
}

/** "Mark review complete": capture balances as of the review period end. */
export async function takeReviewSnapshot(ctx: ServiceContext, input: { asOf: string; note?: string | null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf ?? '')) throw validation('asOf must be YYYY-MM-DD.');
  const balances = await naturalBalancesAsOf(ctx, endOfDay(input.asOf));
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(clientReviewSnapshots)
      .values({ companyId: tx.companyId, asOf: input.asOf, balances, note: input.note?.trim() || null, createdBy: tx.userId })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'client_review_snapshot',
      entityId: row.id,
      newValues: { asOf: input.asOf, accounts: Object.keys(balances).length },
    });
    return row;
  });
}

async function compareBalances(ctx: ServiceContext): Promise<{ issues: ReviewIssue[]; prior: ReviewIssue[] }> {
  const snap = await latestSnapshot(ctx);
  if (!snap) {
    return {
      issues: [{ id: 'no-snapshot', title: 'No previous review on file', detail: 'Finish this review with "Save review balances" so the next review can compare against it.' }],
      prior: [],
    };
  }
  const now = await naturalBalancesAsOf(ctx, endOfDay(snap.asOf));
  const acctRows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const name = new Map(acctRows.map((a) => [a.id, `${a.code} · ${a.name}`]));
  const issues: ReviewIssue[] = [];
  const ids = new Set([...Object.keys(now), ...Object.keys(snap.balances ?? {})]);
  for (const id of ids) {
    const before = Money.of(snap.balances?.[id] ?? 0);
    const after = Money.of(now[id] ?? 0);
    if (before.equals(after)) continue;
    issues.push({
      id: `acct:${id}`,
      title: `${name.get(id) ?? 'Deleted account'}: balance as of ${snap.asOf} changed`,
      detail: `Was ${toAmountString(before)} at the last review, now ${toAmountString(after)} (difference ${toAmountString(after.minus(before))}).`,
      amount: toAmountString(after.minus(before)),
      fix: { kind: 'link', href: `/registers/${id}?to=${snap.asOf}`, label: 'Open register' },
    });
  }
  // The transactions behind the change: dated in the reviewed period, entered, voided or changed in
  // place later. The only in-place change of posted lines is Reclassify Transactions, and it is
  // found by its audit row (an account moved on at least one line). The entry's updated_at is no
  // guide: printing a check, a memo / number edit or a class-only reclassify moves it too, and
  // none of them changes an account balance.
  const reclassifiedAfter = sql`(
    SELECT a.entity_id FROM audit_logs a
    WHERE a.company_id = ${ctx.companyId}
      AND a.entity_type = 'journal_entry'
      AND a.action = 'update'
      AND a.created_at > ${snap.createdAt}
      AND jsonb_typeof(a.new_values -> 'reclassify') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(a.new_values -> 'reclassify') AS n(v)
        JOIN jsonb_array_elements(COALESCE(a.old_values -> 'reclassify', '[]'::jsonb)) AS o(v)
          ON o.v ->> 'lineId' = n.v ->> 'lineId'
        WHERE (n.v ->> 'accountId') IS DISTINCT FROM (o.v ->> 'accountId')
      )
  )`;
  const late = await ctx.db
    .select({
      id: journalEntries.id,
      n: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      status: journalEntries.status,
      createdAt: journalEntries.createdAt,
      voidedAt: journalEntries.voidedAt,
      user: users.name,
    })
    .from(journalEntries)
    .leftJoin(users, eq(journalEntries.createdBy, users.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        lte(journalEntries.date, endOfDay(snap.asOf)),
        sql`(${journalEntries.createdAt} > ${snap.createdAt} OR ${journalEntries.voidedAt} > ${snap.createdAt} OR (${journalEntries.status} = 'posted' AND ${journalEntries.id} IN ${reclassifiedAfter}))`,
        sql`${journalEntries.status} IN ('posted', 'void')`,
      ),
    )
    .orderBy(asc(journalEntries.date));
  const prior: ReviewIssue[] = late
    .filter((e) => !(e.status === 'void' && e.createdAt > snap.createdAt)) // entered and voided after: no net effect
    .map((e) => {
      const what =
        e.voidedAt && e.voidedAt > snap.createdAt ? 'voided' : e.createdAt > snap.createdAt ? 'entered' : 'changed';
      return {
        id: `je:${e.id}`,
        title: `Entry #${e.n} dated ${e.date.toISOString().slice(0, 10)} was ${what} after the last review`,
        detail: `${e.description}${e.user ? ` — by ${e.user}` : ''}. It changes balances you already reviewed.`,
        fix: { kind: 'link' as const, href: `/journal?focus=${e.id}`, label: 'Open entry' },
      };
    });
  return { issues, prior };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function clientDataReview(
  ctx: ServiceContext,
  opts: { undepositedOlderThanDays?: number } = {},
): Promise<{ tasks: ReviewTaskResult[]; lastReview: { asOf: string; at: string } | null }> {
  const statusRows = await ctx.db
    .select()
    .from(clientReviewTasks)
    .where(eq(clientReviewTasks.companyId, ctx.companyId));
  const status = new Map(statusRows.map((s) => [s.taskKey, s]));
  const cmp = await compareBalances(ctx);
  const found: Record<ReviewTaskKey, ReviewIssue[]> = {
    unapplied_customer_credits: await unappliedCustomerCredits(ctx),
    undeposited_funds: await undepositedFunds(ctx, opts.undepositedOlderThanDays ?? 30),
    unapplied_vendor_credits: await unappliedVendorCredits(ctx),
    item_setup: await itemSetup(ctx),
    payroll_liabilities: await payrollLiabilityMispayments(ctx),
    compare_balances: cmp.issues,
    prior_balances: cmp.prior,
  };
  const snap = await latestSnapshot(ctx);
  return {
    tasks: REVIEW_TASKS.map((t) => ({
      key: t.key,
      group: t.group,
      title: t.title,
      status: (status.get(t.key)?.status as ReviewTaskResult['status']) ?? 'not_started',
      note: status.get(t.key)?.note ?? null,
      issues: found[t.key],
    })),
    lastReview: snap ? { asOf: snap.asOf, at: snap.createdAt.toISOString() } : null,
  };
}

export async function setReviewTaskStatus(
  ctx: ServiceContext,
  input: { taskKey: string; status: 'not_started' | 'in_progress' | 'completed'; note?: string | null },
) {
  if (!REVIEW_TASKS.some((t) => t.key === input.taskKey)) throw validation('Unknown review task.');
  if (!['not_started', 'in_progress', 'completed'].includes(input.status)) throw validation('Unknown status.');
  return inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(clientReviewTasks)
      .where(and(eq(clientReviewTasks.companyId, tx.companyId), eq(clientReviewTasks.taskKey, input.taskKey)));
    let row;
    if (existing) {
      [row] = await tx.db
        .update(clientReviewTasks)
        .set({ status: input.status, note: input.note ?? existing.note, updatedAt: new Date(), createdBy: tx.userId })
        .where(eq(clientReviewTasks.id, existing.id))
        .returning();
    } else {
      [row] = await tx.db
        .insert(clientReviewTasks)
        .values({ companyId: tx.companyId, taskKey: input.taskKey, status: input.status, note: input.note ?? null, createdBy: tx.userId })
        .returning();
    }
    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'client_review_task',
      entityId: row.id,
      oldValues: existing ? { status: existing.status } : undefined,
      newValues: { taskKey: input.taskKey, status: input.status },
    });
    return row;
  });
}

/**
 * Apply an unapplied customer payment / credit memo to the customer's oldest open invoices.
 * `date` dates the credit-memo applications; without it each one takes the later of the memo's
 * and the invoice's dates (applyToInvoice), never "today" — which would be refused in an
 * Accountant's Copy, where today is after the dividing date.
 */
export async function autoApplyCustomerCredit(
  ctx: ServiceContext,
  input: { refType: 'payment' | 'credit_memo'; refId: string; date?: Date | null },
): Promise<{ applied: string; invoices: number }> {
  // The route only guarantees Accounting; applying a payment / credit memo is a Customers change
  // (Receive Payments needs Customers: modify), so this fix is never a side door around it.
  requirePermission(ctx, 'customers', 'modify');
  let customerId: string;
  let available: ReturnType<typeof Money.zero>;
  if (input.refType === 'payment') {
    const [p] = await ctx.db
      .select()
      .from(paymentsReceived)
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), eq(paymentsReceived.id, input.refId)));
    if (!p) throw notFound('Payment');
    customerId = p.customerId;
    available = Money.of(p.unapplied);
  } else if (input.refType === 'credit_memo') {
    const [m] = await ctx.db
      .select()
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), eq(creditMemos.id, input.refId)));
    if (!m) throw notFound('Credit memo');
    customerId = m.customerId;
    available = Money.of(m.unapplied);
  } else throw validation('refType must be payment or credit_memo.');
  if (!available.greaterThan(0)) throw new ServiceError('CONFLICT', 'Nothing left to apply.');

  const open = await ctx.db
    .select({ id: invoices.id, balanceDue: invoices.balanceDue })
    .from(invoices)
    .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId), sql`${invoices.status} NOT IN ('void','draft','paid')`, gt(invoices.balanceDue, '0')))
    .orderBy(asc(invoices.date), asc(invoices.invoiceNumber));
  if (open.length === 0) throw new ServiceError('CONFLICT', 'This customer has no open invoices.');
  const apps: Array<{ invoiceId: string; amount: string }> = [];
  let left = available;
  for (const inv of open) {
    if (!left.greaterThan(0)) break;
    const amt = Money.of(inv.balanceDue).lessThan(left) ? Money.of(inv.balanceDue) : left;
    apps.push({ invoiceId: inv.id, amount: toAmountString(amt) });
    left = left.minus(amt);
  }
  await inTransaction(ctx, async (tx) => {
    if (input.refType === 'payment') {
      await applyPayment(tx, { paymentId: input.refId, applications: apps.map((a) => ({ invoiceId: a.invoiceId, amountApplied: a.amount })) });
    } else {
      for (const a of apps) {
        await applyToInvoice(tx, { creditMemoId: input.refId, invoiceId: a.invoiceId, amount: a.amount, date: input.date ?? null });
      }
    }
  });
  return { applied: toAmountString(available.minus(left)), invoices: apps.length };
}

/** Apply an unapplied bill credit to the vendor's oldest open bills. */
export async function autoApplyVendorCredit(ctx: ServiceContext, input: { refId: string }) {
  // Applying a bill credit is a Vendors change (the bill credit's own Apply needs Vendors: modify).
  requirePermission(ctx, 'vendors', 'modify');
  const [c] = await ctx.db
    .select()
    .from(vendorCredits)
    .where(and(eq(vendorCredits.companyId, ctx.companyId), eq(vendorCredits.id, input.refId)));
  if (!c) throw notFound('Bill credit');
  let left = Money.of(c.unapplied);
  if (!left.greaterThan(0)) throw new ServiceError('CONFLICT', 'Nothing left to apply.');
  const open = await ctx.db
    .select({ id: bills.id, balanceDue: bills.balanceDue })
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, c.vendorId), sql`${bills.status} NOT IN ('void','draft','paid')`, gt(bills.balanceDue, '0')))
    .orderBy(asc(bills.date));
  if (open.length === 0) throw new ServiceError('CONFLICT', 'This vendor has no open bills.');
  let n = 0;
  const start = left;
  await inTransaction(ctx, async (tx) => {
    for (const b of open) {
      if (!left.greaterThan(0)) break;
      const amt = Money.of(b.balanceDue).lessThan(left) ? Money.of(b.balanceDue) : left;
      await applyToBill(tx, { vendorCreditId: c.id, billId: b.id, amount: toAmountString(amt) });
      left = left.minus(amt);
      n += 1;
    }
  });
  return { applied: toAmountString(start.minus(left)), bills: n };
}

