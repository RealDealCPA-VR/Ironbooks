/**
 * Calendar (QB Company > Calendar): for each day in a range, the transactions ENTERED that day,
 * the transactions DUE that day (invoices, bills, estimates expiring, P.O.s expected), to-dos,
 * and memorized transactions scheduled to enter. Areas the member can't view are left out.
 */
import { and, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import {
  bills,
  customers,
  deposits,
  estimates,
  expenses,
  invoices,
  paymentsReceived,
  purchaseOrders,
  recurringTemplates,
  salesOrders,
  salesReceipts,
  vendors,
} from '@/lib/db/schema';
import { can, type Area } from '@/lib/permissions/model';
import { type ServiceContext, validation } from './_base';
import { projectOccurrences, type Frequency } from './recurring';
import { listTodos } from './todos';

export interface CalendarEvent {
  id: string;
  kind:
    | 'invoice'
    | 'bill'
    | 'estimate'
    | 'sales_order'
    | 'purchase_order'
    | 'payment'
    | 'sales_receipt'
    | 'check'
    | 'deposit'
    | 'todo'
    | 'memorized';
  /** 'entered' = dated that day, 'due' = due/expected that day, 'todo', 'scheduled'. */
  type: 'entered' | 'due' | 'todo' | 'scheduled';
  label: string;
  amount: string | null;
  href: string;
  done?: boolean;
  overdue?: boolean;
}

export interface CalendarDay {
  date: string;
  events: CalendarEvent[];
}

export interface CalendarResult {
  from: string;
  to: string;
  days: CalendarDay[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function day(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function canView(ctx: ServiceContext, area: Area): boolean {
  return !ctx.access || can(ctx.access, area, 'view');
}

export async function getCalendar(
  ctx: ServiceContext,
  opts: { from: string; to: string; today?: string },
): Promise<CalendarResult> {
  if (!DATE_RE.test(opts.from) || !DATE_RE.test(opts.to)) throw validation('from and to must be YYYY-MM-DD.');
  if (opts.from > opts.to) throw validation('from must be on or before to.');
  const fromD = new Date(`${opts.from}T00:00:00.000Z`);
  const toD = new Date(`${opts.to}T23:59:59.999Z`);
  if (toD.getTime() - fromD.getTime() > 400 * 86_400_000) throw validation('Pick a range of about a year or less.');
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const events = new Map<string, CalendarEvent[]>();
  const add = (date: string | null, e: CalendarEvent) => {
    if (!date || date < opts.from || date > opts.to) return;
    const list = events.get(date) ?? [];
    list.push(e);
    events.set(date, list);
  };
  const inRange = (col: Parameters<typeof gte>[0]) => and(gte(col, fromD), lte(col, toD));

  if (canView(ctx, 'customers')) {
    const inv = await ctx.db
      .select({ id: invoices.id, n: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`, date: invoices.date, due: invoices.dueDate, total: invoices.total, balance: invoices.balanceDue, status: invoices.status, customer: customers.displayName })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(invoices.companyId, ctx.companyId), ne(invoices.status, 'void'), or(inRange(invoices.date), inRange(invoices.dueDate))));
    for (const r of inv) {
      const href = `/invoices?focus=${r.id}`;
      add(day(r.date), { id: r.id, kind: 'invoice', type: 'entered', label: `Invoice ${r.n} — ${r.customer}`, amount: r.total, href });
      if (r.due && Number(r.balance) > 0) {
        const d = day(r.due)!;
        add(d, { id: r.id, kind: 'invoice', type: 'due', label: `Invoice ${r.n} due — ${r.customer}`, amount: r.balance, href, overdue: d < today });
      }
    }
    const est = await ctx.db
      .select({ id: estimates.id, n: sql<string>`COALESCE(NULLIF(${estimates.refNumber}, ''), CAST(${estimates.estimateNumber} AS TEXT))`, date: estimates.date, exp: estimates.expirationDate, total: estimates.total, status: estimates.status, customer: customers.displayName })
      .from(estimates)
      .innerJoin(customers, eq(customers.id, estimates.customerId))
      .where(and(eq(estimates.companyId, ctx.companyId), or(inRange(estimates.date), inRange(estimates.expirationDate))));
    for (const r of est) {
      add(day(r.date), { id: r.id, kind: 'estimate', type: 'entered', label: `Estimate ${r.n} — ${r.customer}`, amount: r.total, href: '/estimates' });
      if (r.exp && !['closed', 'rejected', 'void'].includes(r.status)) {
        add(day(r.exp), { id: r.id, kind: 'estimate', type: 'due', label: `Estimate ${r.n} expires — ${r.customer}`, amount: r.total, href: '/estimates' });
      }
    }
    const so = await ctx.db
      .select({ id: salesOrders.id, n: sql<string>`COALESCE(NULLIF(${salesOrders.refNumber}, ''), CAST(${salesOrders.orderNumber} AS TEXT))`, date: salesOrders.date, total: salesOrders.total })
      .from(salesOrders)
      .where(and(eq(salesOrders.companyId, ctx.companyId), inRange(salesOrders.date)));
    for (const r of so) add(day(r.date), { id: r.id, kind: 'sales_order', type: 'entered', label: `Sales order ${r.n}`, amount: r.total, href: '/sales-orders' });
    const pay = await ctx.db
      .select({ id: paymentsReceived.id, date: paymentsReceived.date, amount: paymentsReceived.amount, customer: customers.displayName })
      .from(paymentsReceived)
      .innerJoin(customers, eq(customers.id, paymentsReceived.customerId))
      .where(and(eq(paymentsReceived.companyId, ctx.companyId), isNull(paymentsReceived.voidedAt), inRange(paymentsReceived.date)));
    for (const r of pay) add(day(r.date), { id: r.id, kind: 'payment', type: 'entered', label: `Payment from ${r.customer}`, amount: r.amount, href: '/payments' });
    const sr = await ctx.db
      .select({ id: salesReceipts.id, n: sql<string>`COALESCE(NULLIF(${salesReceipts.refNumber}, ''), CAST(${salesReceipts.receiptNumber} AS TEXT))`, date: salesReceipts.date, total: salesReceipts.total, status: salesReceipts.status })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, ctx.companyId), ne(salesReceipts.status, 'void'), inRange(salesReceipts.date)));
    for (const r of sr) add(day(r.date), { id: r.id, kind: 'sales_receipt', type: 'entered', label: `Sales receipt ${r.n}`, amount: r.total, href: '/sales-receipts' });
  }

  if (canView(ctx, 'vendors')) {
    const b = await ctx.db
      .select({ id: bills.id, n: bills.billNumber, date: bills.date, due: bills.dueDate, total: bills.total, balance: bills.balanceDue, vendor: vendors.displayName })
      .from(bills)
      .innerJoin(vendors, eq(vendors.id, bills.vendorId))
      .where(and(eq(bills.companyId, ctx.companyId), ne(bills.status, 'void'), or(inRange(bills.date), inRange(bills.dueDate))));
    for (const r of b) {
      add(day(r.date), { id: r.id, kind: 'bill', type: 'entered', label: `Bill${r.n ? ` ${r.n}` : ''} — ${r.vendor}`, amount: r.total, href: '/bills' });
      if (r.due && Number(r.balance) > 0) {
        const d = day(r.due)!;
        add(d, { id: r.id, kind: 'bill', type: 'due', label: `Bill due — ${r.vendor}`, amount: r.balance, href: '/pay-bills', overdue: d < today });
      }
    }
    const po = await ctx.db
      .select({ id: purchaseOrders.id, n: sql<string>`COALESCE(NULLIF(${purchaseOrders.refNumber}, ''), CAST(${purchaseOrders.poNumber} AS TEXT))`, date: purchaseOrders.date, exp: purchaseOrders.expectedDate, total: purchaseOrders.total, status: purchaseOrders.status, vendor: vendors.displayName })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(eq(purchaseOrders.companyId, ctx.companyId), or(inRange(purchaseOrders.date), inRange(purchaseOrders.expectedDate))));
    for (const r of po) {
      add(day(r.date), { id: r.id, kind: 'purchase_order', type: 'entered', label: `P.O. ${r.n} — ${r.vendor}`, amount: r.total, href: '/purchase-orders' });
      if (r.exp && ['open', 'partial'].includes(r.status)) {
        add(day(r.exp), { id: r.id, kind: 'purchase_order', type: 'due', label: `P.O. ${r.n} expected — ${r.vendor}`, amount: r.total, href: '/purchase-orders' });
      }
    }
  }

  if (canView(ctx, 'banking')) {
    const ex = await ctx.db
      .select({ id: expenses.id, date: expenses.date, total: expenses.total, method: expenses.method, payee: expenses.payeeName, vendor: vendors.displayName })
      .from(expenses)
      .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
      .where(and(eq(expenses.companyId, ctx.companyId), isNull(expenses.voidedAt), inRange(expenses.date)));
    for (const r of ex) {
      add(day(r.date), {
        id: r.id,
        kind: 'check',
        type: 'entered',
        label: `${r.method === 'check' ? 'Check' : 'Expense'} — ${r.vendor ?? r.payee ?? 'payee'}`,
        amount: r.total,
        href: '/expenses',
      });
    }
    const dep = await ctx.db
      .select({ id: deposits.id, date: deposits.date, total: deposits.total })
      .from(deposits)
      .where(and(eq(deposits.companyId, ctx.companyId), isNull(deposits.voidedAt), inRange(deposits.date)));
    for (const r of dep) add(day(r.date), { id: r.id, kind: 'deposit', type: 'entered', label: 'Deposit', amount: r.total, href: '/deposits' });
  }

  if (canView(ctx, 'lists')) {
    const tpl = await ctx.db
      .select()
      .from(recurringTemplates)
      .where(and(eq(recurringTemplates.companyId, ctx.companyId), eq(recurringTemplates.isActive, true)));
    for (const t of tpl) {
      if (t.mode === 'never' || t.frequency === 'never') continue;
      const limit = t.remaining === null ? 100 : t.remaining;
      for (const occ of projectOccurrences(t.nextRunDate, t.frequency as Frequency, fromD, toD, limit, t.anchorDay)) {
        add(day(occ), {
          id: t.id,
          kind: 'memorized',
          type: 'scheduled',
          label: `${t.name} (${t.mode === 'automatic' ? 'enters automatically' : 'reminder'})`,
          amount: null,
          href: '/recurring',
        });
      }
    }
  }

  const todoRows = await listTodos(ctx, { includeDone: true, from: opts.from, to: opts.to });
  for (const t of todoRows) {
    add(t.dueDate, {
      id: t.id,
      kind: 'todo',
      type: 'todo',
      label: `${t.dueTime ? `${t.dueTime} ` : ''}${t.title}`,
      amount: null,
      href: '/todos',
      done: t.done,
      overdue: !t.done && (t.dueDate ?? '') < today,
    });
  }

  const days: CalendarDay[] = [...events.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, evs]) => ({ date, events: evs }));
  return { from: opts.from, to: opts.to, days };
}
