/**
 * Smart defaults (QB "Automatically recall last transaction for this name" + next check number).
 *
 * getSmartDefaults(ctx, { form, vendorId | customerId, paymentAccountId? }) reads the name's
 * history — nothing is stored — and returns what a NEW form should be pre-filled with:
 *
 *  - Vendor forms (bill, check, expense, credit card charge): the account lines (account, memo,
 *    amount, class, customer:job) and item lines (item, qty, cost) of the vendor's most recent
 *    transaction of that form type, plus the bill's terms / class and the memo. When the vendor
 *    has none of that form type, the lines of its most recent purchase of any type are used.
 *  - Customer forms (invoice, sales receipt, estimate, sales order): the item lines (item, rate,
 *    qty, taxable, class), terms, sales rep, class, tax item and memo of the customer's last
 *    transaction of that type; falling back to the lines / class / tax item of its last sale of
 *    any type.
 *  - Checks: the next check number for the bank account (lib/services/checkNumbers).
 *
 * My Preferences > General "Recall the last transaction for a name" off (and, for checks,
 * cash expenses and card charges, Preferences > Checking "Autofill") turns recall off; the check
 * number is still offered. Every query is scoped to ctx.companyId; the vendor / customer / bank
 * account must belong to the company; the caller needs view access to the form's area. Inactive
 * accounts, items, classes, reps and tax items are never recalled.
 */
import { and, desc, eq, gte, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import {
  accounts,
  billLines,
  bills,
  classes,
  customers,
  estimateLines,
  estimates,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  salesOrderLines,
  salesOrders,
  salesReceiptLines,
  salesReceipts,
  salesReps,
  taxRates,
  vendors,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { Area } from '@/lib/permissions/model';
import {
  EMPTY_HEADER,
  FORM_HEADER_FIELDS,
  isSmartForm,
  isVendorForm,
  type CustomerForm,
  type SmartDefaults,
  type SmartForm,
  type SmartHeader,
  type SmartLine,
  type VendorForm,
} from '@/lib/smartDefaults';
import { type ServiceContext, assertRefInCompany, validation } from './_base';
import { requirePermission } from './access';
import { nextCheckNumber } from './checkNumbers';
import { getPreferences } from './company';
import { getMyPreferences } from './preferences';

/** Recalled lines are capped (a 300-line bill is not a template). */
const MAX_LINES = 50;

const FORM_AREA: Record<SmartForm, Area> = {
  bill: 'vendors',
  check: 'banking',
  expense: 'banking',
  credit_card: 'banking',
  invoice: 'customers',
  sales_receipt: 'customers',
  estimate: 'customers',
  sales_order: 'customers',
};

export interface SmartDefaultsInput {
  form: SmartForm;
  vendorId?: string | null;
  customerId?: string | null;
  /** Checks: the bank account the check is drawn on (for the next check number). */
  paymentAccountId?: string | null;
}

interface Recalled {
  form: SmartForm;
  id: string;
  date: Date;
  number: string | null;
  header: SmartHeader;
  lines: SmartLine[];
}

// ---------------------------------------------------------------------------
// Vendor history
// ---------------------------------------------------------------------------

const NON_EXPENSE_METHODS = ['check', 'credit_card'] as const;

function expenseFormWhere(form: Exclude<VendorForm, 'bill'>) {
  if (form === 'check') return eq(expenses.method, 'check');
  // Card charges only: a card credit (refund) is stored with a negative total.
  if (form === 'credit_card') return and(eq(expenses.method, 'credit_card'), gte(expenses.total, '0'));
  return notInArray(expenses.method, [...NON_EXPENSE_METHODS]);
}

async function lastBill(ctx: ServiceContext, vendorId: string): Promise<Recalled | null> {
  const [b] = await ctx.db
    .select({
      id: bills.id,
      date: bills.date,
      number: bills.billNumber,
      terms: bills.terms,
      classId: bills.classId,
      memo: bills.memo,
    })
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, vendorId), ne(bills.status, 'void')))
    .orderBy(desc(bills.date), desc(bills.createdAt))
    .limit(1);
  if (!b) return null;
  const rows = await ctx.db
    .select()
    .from(billLines)
    .where(eq(billLines.billId, b.id))
    .orderBy(billLines.lineOrder)
    .limit(MAX_LINES);
  return {
    form: 'bill',
    id: b.id,
    date: b.date,
    number: b.number,
    header: { ...EMPTY_HEADER, terms: b.terms, classId: b.classId, memo: b.memo },
    lines: rows.map((l) => {
      if (l.itemId) {
        const qty = Money.of(l.quantity || '1');
        const rate = qty.isZero() ? Money.of(l.amount) : Money.of(l.amount).div(qty);
        return line({
          kind: 'item',
          itemId: l.itemId,
          accountId: l.accountId,
          description: l.description,
          quantity: qty.toString(),
          rate: rate.toDecimalPlaces(4).toString(),
          amount: l.amount,
          classId: l.classId,
          customerId: l.customerId,
          jobId: l.jobId,
        });
      }
      return line({
        kind: 'account',
        accountId: l.accountId,
        description: l.description,
        amount: l.amount,
        classId: l.classId,
        customerId: l.customerId,
        jobId: l.jobId,
      });
    }),
  };
}

async function lastExpense(
  ctx: ServiceContext,
  vendorId: string,
  form: Exclude<VendorForm, 'bill'>,
): Promise<Recalled | null> {
  const [e] = await ctx.db
    .select({ id: expenses.id, date: expenses.date, number: expenses.reference, memo: expenses.memo })
    .from(expenses)
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(expenses.vendorId, vendorId),
        isNull(expenses.voidedAt),
        expenseFormWhere(form),
      ),
    )
    .orderBy(desc(expenses.date), desc(expenses.createdAt))
    .limit(1);
  if (!e) return null;
  const rows = await ctx.db
    .select()
    .from(expenseLines)
    .where(eq(expenseLines.expenseId, e.id))
    .orderBy(expenseLines.lineOrder)
    .limit(MAX_LINES);
  return {
    form,
    id: e.id,
    date: e.date,
    number: e.number,
    header: { ...EMPTY_HEADER, memo: e.memo },
    lines: rows.map((l) =>
      l.itemId
        ? line({
            kind: 'item',
            itemId: l.itemId,
            accountId: l.accountId,
            description: l.description,
            quantity: l.quantity ? Money.of(l.quantity).toString() : '1',
            rate: l.unitCost ? Money.of(l.unitCost).toString() : null,
            amount: l.amount,
            classId: l.classId,
            customerId: l.customerId,
            jobId: l.jobId,
          })
        : line({
            kind: 'account',
            accountId: l.accountId,
            description: l.description,
            amount: l.amount,
            classId: l.classId,
            customerId: l.customerId,
            jobId: l.jobId,
          }),
    ),
  };
}

async function lastVendorTxn(ctx: ServiceContext, vendorId: string, form: VendorForm): Promise<Recalled | null> {
  return form === 'bill' ? lastBill(ctx, vendorId) : lastExpense(ctx, vendorId, form);
}

// ---------------------------------------------------------------------------
// Customer history
// ---------------------------------------------------------------------------

type SalesLineRow = {
  itemId: string | null;
  accountId?: string | null;
  description: string | null;
  quantity: string;
  rate: string;
  amount: string;
  taxable: boolean;
  classId?: string | null;
  jobId?: string | null;
};

function salesLines(rows: SalesLineRow[]): SmartLine[] {
  return rows.map((l) =>
    line({
      kind: l.itemId ? 'item' : 'account',
      itemId: l.itemId,
      accountId: l.accountId ?? null,
      description: l.description,
      quantity: Money.of(l.quantity || '1').toString(),
      rate: Money.of(l.rate || '0').toString(),
      amount: l.amount,
      taxable: l.taxable,
      classId: l.classId ?? null,
      jobId: l.jobId ?? null,
    }),
  );
}

async function lastCustomerTxn(ctx: ServiceContext, customerId: string, form: CustomerForm): Promise<Recalled | null> {
  const c = ctx.companyId;
  if (form === 'invoice') {
    const [h] = await ctx.db
      .select({
        id: invoices.id,
        date: invoices.date,
        number: invoices.invoiceNumber,
        terms: invoices.terms,
        classId: invoices.classId,
        salesRepId: invoices.salesRepId,
        taxRateId: invoices.taxRateId,
        memo: invoices.memo,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, c),
          eq(invoices.customerId, customerId),
          ne(invoices.status, 'void'),
          eq(invoices.isStatementCharge, false),
        ),
      )
      .orderBy(desc(invoices.date), desc(invoices.createdAt))
      .limit(1);
    if (!h) return null;
    const rows = await ctx.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, h.id))
      .orderBy(invoiceLines.lineOrder)
      .limit(MAX_LINES);
    return {
      form,
      id: h.id,
      date: h.date,
      number: String(h.number),
      header: { terms: h.terms, classId: h.classId, salesRepId: h.salesRepId, taxRateId: h.taxRateId, memo: h.memo },
      lines: salesLines(rows),
    };
  }
  if (form === 'sales_receipt') {
    const [h] = await ctx.db
      .select({
        id: salesReceipts.id,
        date: salesReceipts.date,
        number: salesReceipts.receiptNumber,
        classId: salesReceipts.classId,
        taxRateId: salesReceipts.taxRateId,
        memo: salesReceipts.memo,
      })
      .from(salesReceipts)
      .where(and(eq(salesReceipts.companyId, c), eq(salesReceipts.customerId, customerId), ne(salesReceipts.status, 'void')))
      .orderBy(desc(salesReceipts.date), desc(salesReceipts.createdAt))
      .limit(1);
    if (!h) return null;
    const rows = await ctx.db
      .select()
      .from(salesReceiptLines)
      .where(eq(salesReceiptLines.salesReceiptId, h.id))
      .orderBy(salesReceiptLines.lineOrder)
      .limit(MAX_LINES);
    return {
      form,
      id: h.id,
      date: h.date,
      number: String(h.number),
      header: { ...EMPTY_HEADER, classId: h.classId, taxRateId: h.taxRateId, memo: h.memo },
      lines: salesLines(rows),
    };
  }
  if (form === 'estimate') {
    const [h] = await ctx.db
      .select({ id: estimates.id, date: estimates.date, number: estimates.estimateNumber, taxRateId: estimates.taxRateId, memo: estimates.memo })
      .from(estimates)
      .where(and(eq(estimates.companyId, c), eq(estimates.customerId, customerId), ne(estimates.status, 'void')))
      .orderBy(desc(estimates.date), desc(estimates.createdAt))
      .limit(1);
    if (!h) return null;
    const rows = await ctx.db
      .select()
      .from(estimateLines)
      .where(eq(estimateLines.estimateId, h.id))
      .orderBy(estimateLines.lineOrder)
      .limit(MAX_LINES);
    return {
      form,
      id: h.id,
      date: h.date,
      number: String(h.number),
      header: { ...EMPTY_HEADER, taxRateId: h.taxRateId, memo: h.memo },
      lines: salesLines(rows),
    };
  }
  const [h] = await ctx.db
    .select({ id: salesOrders.id, date: salesOrders.date, number: salesOrders.orderNumber, taxRateId: salesOrders.taxRateId, memo: salesOrders.memo })
    .from(salesOrders)
    .where(and(eq(salesOrders.companyId, c), eq(salesOrders.customerId, customerId), ne(salesOrders.status, 'void')))
    .orderBy(desc(salesOrders.date), desc(salesOrders.createdAt))
    .limit(1);
  if (!h) return null;
  const rows = await ctx.db
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, h.id))
    .orderBy(salesOrderLines.lineOrder)
    .limit(MAX_LINES);
  return {
    form: 'sales_order',
    id: h.id,
    date: h.date,
    number: String(h.number),
    header: { ...EMPTY_HEADER, taxRateId: h.taxRateId, memo: h.memo },
    lines: salesLines(rows),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(p: Partial<SmartLine> & { kind: SmartLine['kind']; amount: string }): SmartLine {
  return {
    kind: p.kind,
    accountId: p.accountId ?? null,
    itemId: p.itemId ?? null,
    description: p.description ?? null,
    quantity: p.quantity ?? null,
    rate: p.rate ?? null,
    amount: Money.round2(Money.of(p.amount || '0')).toFixed(2),
    taxable: p.taxable ?? null,
    classId: p.classId ?? null,
    customerId: p.customerId ?? null,
    jobId: p.jobId ?? null,
  };
}

/** The most recent of several candidates (ties keep the earlier one in the list). */
function newest(list: Array<Recalled | null>): Recalled | null {
  let best: Recalled | null = null;
  for (const r of list) if (r && (!best || r.date.getTime() > best.date.getTime())) best = r;
  return best;
}

/** Ids from `ids` that exist, are active and belong to the company. */
async function activeIds(
  ctx: ServiceContext,
  table: typeof accounts | typeof items | typeof classes | typeof salesReps | typeof taxRates | typeof customers,
  ids: Array<string | null>,
): Promise<Set<string>> {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (!want.length) return new Set();
  const rows = await ctx.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, ctx.companyId), eq(table.isActive, true), inArray(table.id, want)));
  return new Set(rows.map((r) => r.id));
}

/** Drop lines / fields whose account, item, class, rep or tax item is inactive (or foreign). */
async function keepActive(ctx: ServiceContext, r: Recalled): Promise<Recalled> {
  const [acc, itm, cls, rep, tax, cust] = await Promise.all([
    activeIds(ctx, accounts, r.lines.map((l) => l.accountId)),
    activeIds(ctx, items, r.lines.map((l) => l.itemId)),
    activeIds(ctx, classes, [...r.lines.map((l) => l.classId), r.header.classId]),
    activeIds(ctx, salesReps, [r.header.salesRepId]),
    activeIds(ctx, taxRates, [r.header.taxRateId]),
    activeIds(ctx, customers, r.lines.map((l) => l.customerId)),
  ]);
  const keepId = (set: Set<string>, id: string | null) => (id && set.has(id) ? id : null);
  const lines = r.lines
    .filter((l) => (l.kind === 'item' ? !!l.itemId && itm.has(l.itemId) : !!l.accountId && acc.has(l.accountId)))
    .map((l) => ({
      ...l,
      accountId: keepId(acc, l.accountId),
      classId: keepId(cls, l.classId),
      customerId: keepId(cust, l.customerId),
      jobId: l.customerId && cust.has(l.customerId) ? l.jobId : null,
    }));
  return {
    ...r,
    lines,
    header: {
      ...r.header,
      classId: keepId(cls, r.header.classId),
      salesRepId: keepId(rep, r.header.salesRepId),
      taxRateId: keepId(tax, r.header.taxRateId),
    },
  };
}

/** Only the header fields the target form has; memo / terms only from the same form type. */
function headerFor(form: SmartForm, r: Recalled): SmartHeader {
  const out: SmartHeader = { ...EMPTY_HEADER };
  for (const f of FORM_HEADER_FIELDS[form]) {
    if ((f === 'memo' || f === 'terms' || f === 'salesRepId') && r.form !== form) continue;
    out[f] = r.header[f];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function getSmartDefaults(ctx: ServiceContext, input: SmartDefaultsInput): Promise<SmartDefaults> {
  if (!isSmartForm(input.form)) throw validation('Unknown form type.');
  const form = input.form;
  requirePermission(ctx, FORM_AREA[form], 'view');
  const vendorForm = isVendorForm(form);
  const partyId = vendorForm ? input.vendorId : input.customerId;
  if (partyId) {
    if (vendorForm) await assertRefInCompany(ctx, vendors, partyId, 'Vendor');
    else await assertRefInCompany(ctx, customers, partyId, 'Customer');
  }
  if (input.paymentAccountId) await assertRefInCompany(ctx, accounts, input.paymentAccountId, 'Bank account');

  const out: SmartDefaults = {
    form,
    recallEnabled: false,
    source: null,
    header: { ...EMPTY_HEADER },
    lines: [],
    nextCheckNumber: form === 'check' && input.paymentAccountId ? await nextCheckNumber(ctx, input.paymentAccountId) : null,
  };

  const [my, company] = await Promise.all([getMyPreferences(ctx), getPreferences(ctx)]);
  out.recallEnabled =
    my.autoRecallLastTransaction && (form === 'bill' || !vendorForm || company.autofillPayeeAccount);
  if (!out.recallEnabled || !partyId) return out;

  let recalled: Recalled | null;
  if (vendorForm) {
    recalled = await lastVendorTxn(ctx, partyId, form as VendorForm);
    if (!recalled) {
      const others = (['bill', 'check', 'expense', 'credit_card'] as VendorForm[]).filter((f) => f !== form);
      recalled = newest(await Promise.all(others.map((f) => lastVendorTxn(ctx, partyId, f))));
    }
  } else {
    recalled = await lastCustomerTxn(ctx, partyId, form as CustomerForm);
    if (!recalled) {
      const others = (['invoice', 'sales_receipt', 'sales_order', 'estimate'] as CustomerForm[]).filter((f) => f !== form);
      recalled = newest(await Promise.all(others.map((f) => lastCustomerTxn(ctx, partyId, f))));
    }
  }
  if (!recalled) return out;
  recalled = await keepActive(ctx, recalled);
  out.source = {
    form: recalled.form,
    id: recalled.id,
    date: recalled.date.toISOString().slice(0, 10),
    number: recalled.number,
  };
  out.header = headerFor(form, recalled);
  out.lines = recalled.lines;
  return out;
}
