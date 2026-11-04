/**
 * Reminders list (QB Company > Reminders) driven by Preferences > Reminders.
 *
 * Each category (checks to print, overdue invoices, bills to pay, money to deposit, inventory
 * to reorder, memorized transactions due, to-dos, open sales/purchase orders, forms to print)
 * honors its preference: 'summary' (count + total), 'list' (every item) or 'off', plus its
 * look-ahead window in days. Categories the member can't view (Users & Roles) are left out, and
 * a failing source never breaks the rest of the list.
 */
import { and, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  assemblyComponents,
  bills,
  customers,
  employees,
  expenses,
  invoices,
  items as itemsTable,
  paychecks,
  paymentsReceived,
  pendingBuilds,
  purchaseOrders,
  recurringTemplates,
  salesOrders,
  salesReceipts,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { canRef, type AccessRef } from '@/lib/permissions/model';
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
import { payrollLiabilityBalances } from './payrollReports';
import { effectiveHomeCurrency } from './multiCurrency';

export interface ReminderItem {
  id: string;
  label: string;
  /** 'YYYY-MM-DD' (due / scheduled / document date). */
  date: string | null;
  /** In the document's own currency (see `currency`). */
  amount: string | null;
  href: string;
  /** Foreign-currency documents: their currency code (null / absent = home currency). */
  currency?: string | null;
  /** Foreign-currency documents: the amount in home currency at the document's exchange rate. */
  homeAmount?: string | null;
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

/** Which permission activity (prefsperms; an area = the whole area) a category's data belongs to. */
const AREA: Record<ReminderKey, AccessRef | null> = {
  checksToPrint: 'banking.print_checks',
  invoicesToPrint: 'customers.invoices',
  overdueInvoices: 'customers.invoices',
  salesReceiptsToPrint: 'customers.sales_receipts',
  salesOrdersToPrint: 'customers.sales_orders',
  inventoryToReorder: 'inventory.center',
  billsToPay: 'vendors.bills',
  memorizedTransactionsDue: 'lists.memorized',
  moneyToDeposit: 'banking.deposits',
  purchaseOrdersToPrint: 'vendors.purchase_orders',
  toDoNotes: null,
  almostDueInvoices: 'customers.invoices',
  overdueBills: 'vendors.bills',
  paychecksToPrint: 'payroll.paychecks',
  assembliesToBuild: 'inventory.assemblies',
  liabilitiesDue: 'payroll.liabilities',
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
  almostDueInvoices: '/reports/open-invoices',
  overdueBills: '/pay-bills',
  paychecksToPrint: '/print-checks',
  assembliesToBuild: '/assemblies',
  liabilitiesDue: '/pay-liabilities',
};

/**
 * A foreign-currency document's amount with its home value at the document's exchange rate (the
 * value the books carry it at), so a section total never adds euros to dollars.
 */
function fx(amount: string | null, currency: string | null | undefined, rate: string | null | undefined, home: string) {
  if (amount === null || !currency || currency.toUpperCase() === home) return { amount, currency: null, homeAmount: null };
  const r = rate && !Money.isZero(rate) ? Money.of(rate) : Money.of(1);
  return { amount, currency: currency.toUpperCase(), homeAmount: toAmountString(Money.of(amount).times(r)) };
}

/** The 15th of the month after `iso` ('YYYY-MM-DD'): when a monthly depositor's payroll taxes are due. */
function fifteenthOfNextMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 15));
  return d.toISOString().slice(0, 10);
}

/** Last day of the month before `iso`. */
function endOfPreviousMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}

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

/** Per-request facts a few sources share (home currency, whether a split category is on). */
interface SourceEnv {
  home: string;
  /** Overdue bills have their own section (Preferences), so Bills to pay lists the ones not yet due. */
  overdueBillsShown: boolean;
}

type Source = (ctx: ServiceContext, today: string, days: number, env: SourceEnv) => Promise<ReminderItem[]>;

const SOURCES: Record<ReminderKey, Source> = {
  async checksToPrint(ctx, _today, _days, env) {
    const rows = await ctx.db
      .select({
        id: expenses.id,
        date: expenses.date,
        total: expenses.total,
        currency: expenses.currency,
        rate: expenses.exchangeRate,
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
      ...fx(r.total, r.currency, r.rate, env.home),
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
  async overdueInvoices(ctx, today, days, env) {
    // QB: "remind me N days after the due date".
    const cutoff = endOfDay(addDaysIso(today, -days - 1));
    const rows = await ctx.db
      .select({
        id: invoices.id,
        n: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`,
        due: invoices.dueDate,
        balance: invoices.balanceDue,
        currency: invoices.currency,
        rate: invoices.exchangeRate,
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
      ...fx(r.balance, r.currency, r.rate, env.home),
      href: `/invoices?focus=${r.id}`,
    }));
  },
  async almostDueInvoices(ctx, today, days, env) {
    // QB "Almost Due Invoices": open invoices due within the next N days (not yet overdue).
    const rows = await ctx.db
      .select({
        id: invoices.id,
        n: sql<string>`COALESCE(NULLIF(${invoices.refNumber}, ''), CAST(${invoices.invoiceNumber} AS TEXT))`,
        due: invoices.dueDate,
        balance: invoices.balanceDue,
        currency: invoices.currency,
        rate: invoices.exchangeRate,
        customer: customers.displayName,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          inArray(invoices.status, ['open', 'partial', 'overdue']),
          gt(invoices.balanceDue, '0'),
          gte(invoices.dueDate, new Date(`${today}T00:00:00.000Z`)),
          lte(invoices.dueDate, endOfDay(addDaysIso(today, days))),
        ),
      );
    return rows.map((r) => ({
      id: r.id,
      label: `Invoice ${r.n} — ${r.customer}`,
      date: isoDay(r.due),
      ...fx(r.balance, r.currency, r.rate, env.home),
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
  async billsToPay(ctx, today, days, env) {
    const horizon = addDaysIso(today, days);
    // With Overdue bills on, this section is the bills coming due (QB lists the two apart).
    return (await openBillItems(ctx, env)).filter(
      (b) => (b.date ?? '') <= horizon && (!env.overdueBillsShown || (b.date ?? '') >= today),
    );
  },
  async overdueBills(ctx, today, _days, env) {
    return (await openBillItems(ctx, env))
      .filter((b) => (b.date ?? '') < today)
      .map((b) => ({ ...b, label: `${b.label} (overdue)` }));
  },
  async paychecksToPrint(ctx, today, days) {
    // Paychecks queued for Print Checks (number stamped when printed), dated within the window.
    const rows = await ctx.db
      .select({
        id: paychecks.id,
        date: paychecks.payDate,
        net: paychecks.netPay,
        first: employees.firstName,
        last: employees.lastName,
      })
      .from(paychecks)
      .innerJoin(employees, eq(employees.id, paychecks.employeeId))
      .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.toPrint, true), isNull(paychecks.voidedAt), eq(paychecks.entryType, 'paycheck')));
    const horizon = addDaysIso(today, days);
    return rows
      .filter((r) => (isoDay(r.date) ?? '') <= horizon)
      .map((r) => ({
        id: r.id,
        label: `Paycheck to ${`${r.first ?? ''} ${r.last ?? ''}`.trim() || 'employee'}`,
        date: isoDay(r.date),
        amount: r.net,
        href: '/print-checks',
      }));
  },
  async assembliesToBuild(ctx) {
    // QB "Assemblies to Build": pending builds waiting on components, and assemblies at or below
    // their build point (the assembly's reorder point) with no pending build for them.
    const pending = await ctx.db
      .select({ id: pendingBuilds.id, itemId: pendingBuilds.assemblyItemId, qty: pendingBuilds.quantity, date: pendingBuilds.date, name: itemsTable.name })
      .from(pendingBuilds)
      .innerJoin(itemsTable, eq(itemsTable.id, pendingBuilds.assemblyItemId))
      .where(and(eq(pendingBuilds.companyId, ctx.companyId), eq(pendingBuilds.status, 'pending')));
    const out: ReminderItem[] = pending.map((p) => ({
      id: p.id,
      label: `Pending build: ${Number(p.qty)} × ${p.name}`,
      date: isoDay(p.date),
      amount: null,
      href: '/assemblies',
    }));
    const queued = new Set(pending.map((p) => p.itemId));
    const assemblies = await ctx.db
      .selectDistinct({ id: itemsTable.id, name: itemsTable.name, onHand: itemsTable.quantityOnHand, point: itemsTable.reorderPoint })
      .from(itemsTable)
      .innerJoin(assemblyComponents, eq(assemblyComponents.assemblyItemId, itemsTable.id))
      .where(and(eq(itemsTable.companyId, ctx.companyId), eq(itemsTable.isActive, true)));
    for (const a of assemblies) {
      if (a.point === null || queued.has(a.id)) continue;
      if (Money.lte(a.onHand ?? 0, a.point)) {
        out.push({
          id: a.id,
          label: `${a.name}: ${Number(a.onHand ?? 0)} on hand (build point ${Number(a.point)})`,
          date: null,
          amount: null,
          href: '/assemblies',
        });
      }
    }
    return out;
  },
  async liabilitiesDue(ctx, today, days) {
    // Payroll taxes and withholdings by payroll item, due on the monthly deposit schedule: what was
    // owed at the end of last month is due on the 15th of this month (overdue after it), what has
    // accrued since is due on the 15th of next month (shown once inside the look-ahead window).
    const prevEnd = endOfPreviousMonth(today);
    const before = await payrollLiabilityBalances(ctx, { asOf: new Date(`${prevEnd}T12:00:00.000Z`) });
    const now = await payrollLiabilityBalances(ctx, { asOf: new Date(`${today}T12:00:00.000Z`) });
    const dueThisMonth = fifteenthOfNextMonth(prevEnd);
    const dueNextMonth = fifteenthOfNextMonth(today);
    const horizon = addDaysIso(today, days);
    const out: ReminderItem[] = [];
    const prior = new Map(before.items.map((i) => [i.name, i]));
    for (const it of now.items) {
      const was = Money.of(prior.get(it.name)?.balance ?? 0);
      const is = Money.of(it.balance);
      const owedThen = was.isPositive() ? (was.lessThan(is) ? was : is) : Money.zero();
      const accruedSince = Money.of(it.balance).minus(owedThen);
      if (owedThen.isPositive()) {
        out.push({ id: `${it.name}:${dueThisMonth}`, label: `${it.name}${dueThisMonth < today ? ' (overdue)' : ''}`, date: dueThisMonth, amount: toAmountString(owedThen), href: '/pay-liabilities' });
      }
      if (accruedSince.isPositive() && dueNextMonth <= horizon) {
        out.push({ id: `${it.name}:${dueNextMonth}`, label: it.name, date: dueNextMonth, amount: toAmountString(accruedSince), href: '/pay-liabilities' });
      }
    }
    return out;
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
  async moneyToDeposit(ctx, _today, _days, env) {
    const rows = await listUndepositedPayments(ctx);
    // Foreign customer payments: their own exchange rate (invoice payment lines: the invoice's).
    const foreign = rows.filter((r) => r.currency && r.currency.toUpperCase() !== env.home);
    const rates = new Map<string, string | null>();
    const payIds = foreign.filter((r) => r.kind === 'payment').map((r) => r.id);
    const invIds = foreign.filter((r) => r.kind === 'invoice_payment').map((r) => r.id);
    if (payIds.length) {
      for (const p of await ctx.db
        .select({ id: paymentsReceived.id, rate: paymentsReceived.exchangeRate })
        .from(paymentsReceived)
        .where(and(eq(paymentsReceived.companyId, ctx.companyId), inArray(paymentsReceived.id, payIds)))) {
        rates.set(p.id, p.rate);
      }
    }
    if (invIds.length) {
      for (const i of await ctx.db
        .select({ id: invoices.id, rate: invoices.exchangeRate })
        .from(invoices)
        .where(and(eq(invoices.companyId, ctx.companyId), inArray(invoices.id, invIds)))) {
        rates.set(i.id, i.rate);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      label: `${r.kind === 'payment' ? 'Payment' : 'Sales receipt'} from ${r.customerName ?? 'customer'}`,
      date: isoDay(r.date),
      ...fx(r.amount, r.currency, rates.get(r.id) ?? null, env.home),
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

/** Open bills (balance in the bill's currency, home value at its rate), dated by due date. */
async function openBillItems(ctx: ServiceContext, env: SourceEnv): Promise<ReminderItem[]> {
  const rows = await ctx.db
    .select({
      id: bills.id,
      n: bills.billNumber,
      due: bills.dueDate,
      date: bills.date,
      balance: bills.balanceDue,
      currency: bills.currency,
      rate: bills.exchangeRate,
      vendor: vendors.displayName,
    })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.status, ['open', 'partial', 'overdue']), gt(bills.balanceDue, '0')));
  return rows.map((r) => ({
    id: r.id,
    label: `Bill${r.n ? ` ${r.n}` : ''} — ${r.vendor}`,
    date: isoDay(r.due ?? r.date),
    ...fx(r.balance, r.currency, r.rate, env.home),
    href: '/pay-bills',
  }));
}

function canView(ctx: ServiceContext, area: AccessRef | null): boolean {
  if (!area || !ctx.access) return true;
  return canRef(ctx.access, area, 'view');
}

export async function getReminders(ctx: ServiceContext, opts: { today?: string } = {}): Promise<RemindersResult> {
  const prefs = await getPreferences(ctx);
  const today = opts.today ?? todayInTimeZone(prefs.timezone);
  const sections: ReminderSection[] = [];
  let home = 'USD';
  try {
    home = ((await effectiveHomeCurrency(ctx)) ?? 'USD').toUpperCase();
  } catch {
    /* no currency list: every amount is home currency */
  }
  const env: SourceEnv = {
    home,
    overdueBillsShown: prefs.reminders.overdueBills.mode !== 'off' && canView(ctx, AREA.overdueBills),
  };
  for (const key of REMINDER_KEYS) {
    const setting = prefs.reminders[key];
    if (setting.mode === 'off' || !canView(ctx, AREA[key])) continue;
    let items: ReminderItem[];
    try {
      items = await SOURCES[key](ctx, today, setting.days, env);
    } catch (err) {
      console.warn(`[reminders] ${key} unavailable:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (items.length === 0) continue;
    items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    // The total is in home currency: foreign documents count at their home value.
    const withAmounts = items.filter((i) => i.amount !== null);
    const total = withAmounts.length
      ? toAmountString(withAmounts.reduce((s, i) => s.plus(Money.of(i.homeAmount ?? i.amount!)), Money.of(0)))
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
