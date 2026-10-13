/**
 * Reminders list (QB Company > Reminders) driven by Preferences > Reminders.
 *
 * Each category (checks to print, overdue invoices, bills to pay, money to deposit, inventory
 * to reorder, memorized transactions due, to-dos, open sales/purchase orders, forms to print)
 * honors its preference: 'summary' (count + total), 'list' (every item) or 'off', plus its
 * look-ahead window in days. Categories the member can't view (Users & Roles) are left out, and
 * a failing source never breaks the rest of the list.
 */
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  bills,
  customers,
  expenses,
  invoices,
  purchaseOrders,
  recurringTemplates,
  salesOrders,
  salesReceipts,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { can, type Area } from '@/lib/permissions/model';
import {
  REMINDER_KEYS,
  REMINDER_LABELS,
  addDaysIso,
  todayInTimeZone,
  type ReminderKey,
  type ReminderMode,
} from '@/lib/preferences';
import type { ServiceContext } from './_base';
import { getPreferences } from './company';
import { listUndepositedPayments } from './deposits';
import { reorderReport } from './inventoryOps';
import { todosToRemind } from './todos';

export interface ReminderItem {
  id: string;
  label: string;
  /** 'YYYY-MM-DD' (due / scheduled / document date). */
  date: string | null;
  amount: string | null;
  href: string;
}

export interface ReminderSection {
  key: ReminderKey;
  label: string;
  mode: Exclude<ReminderMode, 'off'>;
  count: number;
  total: string | null;
  href: string;
  /** Present for 'list' mode, and always available for drill-down (capped at 50). */
  items: ReminderItem[];
}

export interface RemindersResult {
  asOf: string;
  sections: ReminderSection[];
}

/** Which permission area a category's data belongs to. */
const AREA: Record<ReminderKey, Area | null> = {
  checksToPrint: 'banking',
  invoicesToPrint: 'customers',
  overdueInvoices: 'customers',
  salesReceiptsToPrint: 'customers',
  salesOrdersToPrint: 'customers',
  inventoryToReorder: 'inventory',
  billsToPay: 'vendors',
  memorizedTransactionsDue: 'lists',
  moneyToDeposit: 'banking',
  purchaseOrdersToPrint: 'vendors',
  toDoNotes: null,
};

const HREF: Record<ReminderKey, string> = {
  checksToPrint: '/print-checks',
  invoicesToPrint: '/invoices',
  overdueInvoices: '/reports/ar-aging',
  salesReceiptsToPrint: '/sales-receipts',
  salesOrdersToPrint: '/sales-orders',
  inventoryToReorder: '/inventory-ops',
  billsToPay: '/pay-bills',
  memorizedTransactionsDue: '/recurring',
  moneyToDeposit: '/deposits',
  purchaseOrdersToPrint: '/purchase-orders',
  toDoNotes: '/todos',
};

function isoDay(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
}

/** End of the given calendar day (UTC) — documents are stored at UTC midnight. */
function endOfDay(iso: string): Date {
  return new Date(`${iso}T23:59:59.999Z`);
}

/**
 * Forms "to be printed" depend on a toBePrinted flag the sales/purchases packages add to their
 * documents. Until a document table carries it, that category is simply empty.
 */
function printFlag(table: unknown): unknown {
  return (table as Record<string, unknown>).toBePrinted;
}

type Source = (ctx: ServiceContext, today: string, days: number) => Promise<ReminderItem[]>;

const SOURCES: Record<ReminderKey, Source> = {
  async checksToPrint(ctx) {
    const rows = await ctx.db
      .select({
        id: expenses.id,
        date: expenses.date,
        total: expenses.total,
        payeeName: expenses.payeeName,
        vendorName: vendors.displayName,
      })
      .from(expenses)
      .leftJoin(vendors, eq(vendors.id, expenses.vendorId))
      .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.toPrint, true), isNull(expenses.voidedAt)));
    return rows.map((r) => ({
      id: r.id,
      label: `Check to ${r.vendorName ?? r.payeeName ?? 'payee'}`,
      date: isoDay(r.date),
      amount: r.total,
      href: '/print-checks',
    }));
  },
  async invoicesToPrint(ctx) {
    const flag = printFlag(invoices);
    if (!flag) return [];
    const rows = await ctx.db
      .select({ id: invoices.id, n: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`, date: invoices.date, total: invoices.total, customer: customers.displayName })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(invoices.companyId, ctx.companyId), eq(flag as never, true)));
    return rows.map((r) => ({ id: r.id, label: `Invoice ${r.n} — ${r.customer}`, date: isoDay(r.date), amount: r.total, href: `/invoices?focus=${r.id}` }));
  },
  async overdueInvoices(ctx, today, days) {
    // QB: "remind me N days after the due date".
    const cutoff = endOfDay(addDaysIso(today, -days - 1));
    const rows = await ctx.db
      .select({
        id: invoices.id,
        n: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`,
        due: invoices.dueDate,
        balance: invoices.balanceDue,
        customer: customers.displayName,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          inArray(invoices.status, ['open', 'partial', 'overdue']),
          gt(invoices.balanceDue, '0'),
          lte(invoices.dueDate, cutoff),
        ),
      );
    return rows.map((r) => ({
      id: r.id,
      label: `Invoice ${r.n} — ${r.customer}`,
      date: isoDay(r.due),
      amount: r.balance,
      href: `/invoices?focus=${r.id}`,
    }));
  },
  async salesReceiptsToPrint(ctx) {
    const flag = printFlag(salesReceipts);
    if (!flag) return [];
    const rows = await ctx.db
      .select({ id: salesReceipts.id, n: sql<string>`COALESCE(NULLIF(${salesReceipts.refNumber}, ''), CAST(${salesReceipts.receiptNumber} AS TEXT))`, date: salesReceipts.date, total: salesReceipts.total })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, ctx.companyId), eq(flag as never, true)));
    return rows.map((r) => ({ id: r.id, label: `Sales receipt ${r.n}`, date: isoDay(r.date), amount: r.total, href: '/sales-receipts' }));
  },
  async salesOrdersToPrint(ctx, today, days) {
    const rows = await ctx.db
      .select({ id: salesOrders.id, n: sql<string>`COALESCE(NULLIF(${salesOrders.refNumber}, ''), CAST(${salesOrders.orderNumber} AS TEXT))`, date: salesOrders.date, total: salesOrders.total, customer: customers.displayName })
      .from(salesOrders)
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .where(
        and(
          eq(salesOrders.companyId, ctx.companyId),
          inArray(salesOrders.status, ['open', 'partial']),
          lte(salesOrders.date, endOfDay(addDaysIso(today, days))),
        ),
      );
    return rows.map((r) => ({ id: r.id, label: `Sales order ${r.n} — ${r.customer}`, date: isoDay(r.date), amount: r.total, href: '/sales-orders' }));
  },
  async inventoryToReorder(ctx) {
    const report = await reorderReport(ctx);
    return report.rows.map((r) => ({
      id: r.id,
      label: `${r.name}: ${Number(r.quantityOnHand)} on hand (reorder at ${Number(r.reorderPoint)})`,
      date: null,
      amount: null,
      href: '/inventory-ops',
    }));
  },
  async billsToPay(ctx, today, days) {
    const rows = await ctx.db
      .select({ id: bills.id, n: bills.billNumber, due: bills.dueDate, date: bills.date, balance: bills.balanceDue, vendor: vendors.displayName })
      .from(bills)
      .innerJoin(vendors, eq(vendors.id, bills.vendorId))
      .where(
        and(
          eq(bills.companyId, ctx.companyId),
          inArray(bills.status, ['open', 'partial', 'overdue']),
          gt(bills.balanceDue, '0'),
        ),
      );
    const horizon = addDaysIso(today, days);
    return rows
      .filter((r) => (isoDay(r.due ?? r.date) ?? '') <= horizon)
      .map((r) => ({
        id: r.id,
        label: `Bill${r.n ? ` ${r.n}` : ''} — ${r.vendor}`,
        date: isoDay(r.due ?? r.date),
        amount: r.balance,
        href: '/pay-bills',
      }));
  },
  async memorizedTransactionsDue(ctx, today, days) {
    const rows = await ctx.db
      .select()
      .from(recurringTemplates)
      .where(and(eq(recurringTemplates.companyId, ctx.companyId), eq(recurringTemplates.isActive, true)));
    return rows
      .filter((r) => r.mode !== 'never' && r.frequency !== 'never' && r.nextRunDate && r.remaining !== 0)
      .filter((r) => (isoDay(r.nextRunDate) ?? '9999') <= addDaysIso(today, days + (r.daysInAdvance ?? 0)))
      .map((r) => ({
        id: r.id,
        label: `${r.name}${r.mode === 'automatic' ? ' (enters automatically)' : ''}`,
        date: isoDay(r.nextRunDate),
        amount: null,
        href: '/recurring',
      }));
  },
  async moneyToDeposit(ctx) {
    const rows = await listUndepositedPayments(ctx);
    return rows.map((r) => ({
      id: r.id,
      label: `${r.kind === 'payment' ? 'Payment' : 'Sales receipt'} from ${r.customerName ?? 'customer'}`,
      date: isoDay(r.date),
      amount: r.amount,
      href: '/deposits',
    }));
  },
  async purchaseOrdersToPrint(ctx, today, days) {
    const rows = await ctx.db
      .select({ id: purchaseOrders.id, n: sql<string>`COALESCE(NULLIF(${purchaseOrders.refNumber}, ''), CAST(${purchaseOrders.poNumber} AS TEXT))`, date: purchaseOrders.date, expected: purchaseOrders.expectedDate, total: purchaseOrders.total, vendor: vendors.displayName })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(eq(purchaseOrders.companyId, ctx.companyId), inArray(purchaseOrders.status, ['open', 'partial'])));
    const horizon = addDaysIso(today, days);
    return rows
      .filter((r) => (isoDay(r.expected ?? r.date) ?? '') <= horizon)
      .map((r) => ({ id: r.id, label: `P.O. ${r.n} — ${r.vendor}`, date: isoDay(r.expected ?? r.date), amount: r.total, href: '/purchase-orders' }));
  },
  async toDoNotes(ctx, today, days) {
    // THE To Do list: open to-dos due within the window, or whose "remind me on" day has come.
    const rows = await todosToRemind(ctx, today, addDaysIso(today, days));
    return rows.map((r) => ({
      id: r.id,
      label: r.entityName ? `${r.title} (${r.entityName})` : r.title,
      date: r.dueDate,
      amount: null,
      href: '/todos',
    }));
  },
};

function canView(ctx: ServiceContext, area: Area | null): boolean {
  if (!area || !ctx.access) return true;
  return can(ctx.access, area, 'view');
}

export async function getReminders(ctx: ServiceContext, opts: { today?: string } = {}): Promise<RemindersResult> {
  const prefs = await getPreferences(ctx);
  const today = opts.today ?? todayInTimeZone(prefs.timezone);
  const sections: ReminderSection[] = [];
  for (const key of REMINDER_KEYS) {
    const setting = prefs.reminders[key];
    if (setting.mode === 'off' || !canView(ctx, AREA[key])) continue;
    let items: ReminderItem[];
    try {
      items = await SOURCES[key](ctx, today, setting.days);
    } catch (err) {
      console.warn(`[reminders] ${key} unavailable:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (items.length === 0) continue;
    items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    const withAmounts = items.filter((i) => i.amount !== null);
    const total = withAmounts.length
      ? toAmountString(withAmounts.reduce((s, i) => s.plus(Money.of(i.amount!)), Money.of(0)))
      : null;
    sections.push({
      key,
      label: REMINDER_LABELS[key],
      mode: setting.mode,
      count: items.length,
      total,
      href: HREF[key],
      items: items.slice(0, 50),
    });
  }
  return { asOf: today, sections };
}
