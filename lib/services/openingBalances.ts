/**
 * Opening Balance on New Customer / New Vendor (QB: the New Customer / New Vendor window's
 * "Opening Balance ... as of <date>").
 *
 * QuickBooks records the amount as a real document dated the as-of day:
 *  - customer: an invoice to the customer, its line on Uncategorized Income
 *    (Dr Accounts Receivable, Cr Uncategorized Income);
 *  - vendor: a bill from the vendor, its line on Uncategorized Expenses
 *    (Dr Uncategorized Expenses, Cr Accounts Payable).
 * A negative amount (the name owes nothing; you owe the customer / the vendor owes you) becomes a
 * credit memo / vendor credit on the same account instead, since an invoice or bill cannot be
 * negative.
 *
 * Posting goes through the invoice / bill / credit services, so the closing date (and its
 * password), the A/R and A/P subledgers, record numbers, foreign currency (a vendor's currency)
 * and the audit trail all apply exactly as for a document entered by hand. The callers
 * (createCustomer / createVendor) run this in the SAME transaction as the name's creation: if the
 * posting is refused, the name is not created either.
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, validation } from './_base';
import { createAccount } from './accounts';
import { createInvoice } from './invoices';
import { createCreditMemo } from './creditMemos';
import { createBill } from './bills';
import { createVendorCredit } from './vendorCredits';
import { companyToday } from './salesDates';

export interface OpeningBalanceInput {
  /** Amount the name owes you (customer) / you owe the name (vendor) on the as-of date. */
  openingBalance?: string | number | null;
  /** "as of" day (calendar day at UTC midnight); default the company's today. */
  openingBalanceDate?: Date | string | null;
}

export interface OpeningBalanceResult {
  kind: 'invoice' | 'credit_memo' | 'bill' | 'vendor_credit';
  id: string;
  amount: string;
  date: string;
}

export const UNCATEGORIZED_INCOME = 'Uncategorized Income';
export const UNCATEGORIZED_EXPENSES = 'Uncategorized Expenses';
const MEMO = 'Opening Balance';

/** The opening amount, or null when none was entered (blank / zero). */
function amountOf(input: OpeningBalanceInput): ReturnType<typeof Money.of> | null {
  const raw = input.openingBalance;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let v;
  try {
    v = Money.of(raw);
  } catch {
    throw validation('Opening balance must be an amount, for example 1250.00.');
  }
  if (!v.isFinite()) throw validation('Opening balance must be an amount, for example 1250.00.');
  if (v.decimalPlaces() > 2) throw validation('Opening balance can have at most 2 decimal places.');
  return v.isZero() ? null : v;
}

/** The as-of day: the given calendar day at UTC midnight, else the company's today. */
async function asOfDate(ctx: ServiceContext, input: OpeningBalanceInput): Promise<Date> {
  const raw = input.openingBalanceDate;
  if (raw === undefined || raw === null || raw === '') return companyToday(ctx);
  const d = raw instanceof Date ? raw : new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(d.getTime())) throw validation('Opening balance date is not a valid date.');
  // A document date is a calendar day: keep the day it names.
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Find (by name, case-insensitive, of the right kind) or create the Uncategorized Income /
 * Uncategorized Expenses account, the way QB adds it the first time an opening balance needs it.
 * A new account takes the first free number from 4990 / 6990.
 */
export async function ensureUncategorizedAccount(ctx: ServiceContext, which: 'income' | 'expense'): Promise<string> {
  const name = which === 'income' ? UNCATEGORIZED_INCOME : UNCATEGORIZED_EXPENSES;
  const type = which === 'income' ? 'revenue' : 'expense';
  const candidates = await ctx.db
    .select({ id: accounts.id, name: accounts.name, type: accounts.type, isActive: accounts.isActive })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, ctx.companyId),
        eq(accounts.type, type as never),
        // "Uncategorized Expenses" and the singular "Uncategorized Expense" (some charts use it).
        sql`lower(${accounts.name}) IN (${name.toLowerCase()}, ${name.toLowerCase().replace(/s$/, '')})`,
      ),
    );
  const pick = candidates.find((a) => a.isActive) ?? candidates[0];
  if (pick) return pick.id;
  const used = new Set(
    (await ctx.db.select({ code: accounts.code }).from(accounts).where(eq(accounts.companyId, ctx.companyId))).map((r) => r.code),
  );
  let code = which === 'income' ? 4990 : 6990;
  while (used.has(String(code))) code++;
  const row = await createAccount(ctx, {
    code: String(code),
    name,
    type: type as never,
    subtype: which === 'income' ? 'sales' : 'operating_expenses',
    description:
      which === 'income'
        ? 'Offsets customer opening balances entered on New Customer (QuickBooks: Uncategorized Income).'
        : 'Offsets vendor opening balances entered on New Vendor (QuickBooks: Uncategorized Expenses).',
  });
  return row.id;
}

/** Customer opening balance: an invoice (or, negative, a credit memo) dated the as-of day. */
export async function postCustomerOpeningBalance(
  ctx: ServiceContext,
  customerId: string,
  input: OpeningBalanceInput,
): Promise<OpeningBalanceResult | null> {
  const amount = amountOf(input);
  if (!amount) return null;
  const date = await asOfDate(ctx, input);
  const accountId = await ensureUncategorizedAccount(ctx, 'income');
  const line = { accountId, description: MEMO, quantity: 1, rate: amount.abs().toFixed(2), taxable: false };
  const day = date.toISOString().slice(0, 10);
  if (amount.isPositive()) {
    const inv = await createInvoice(ctx, {
      customerId,
      date,
      memo: MEMO,
      lines: [line],
      // Never the customer's default tax item: an opening balance is not a sale.
      taxRateId: null,
      // The balance already exists; a credit limit set on the same form must not refuse it.
      overrideCreditLimit: true,
    });
    return { kind: 'invoice', id: (inv as { id: string }).id, amount: amount.toFixed(2), date: day };
  }
  const memo = await createCreditMemo(ctx, { customerId, date, memo: MEMO, lines: [line], taxRateId: null });
  return { kind: 'credit_memo', id: (memo as { id: string }).id, amount: amount.toFixed(2), date: day };
}

/** Vendor opening balance: a bill (or, negative, a vendor credit) dated the as-of day. */
export async function postVendorOpeningBalance(
  ctx: ServiceContext,
  vendorId: string,
  input: OpeningBalanceInput,
): Promise<OpeningBalanceResult | null> {
  const amount = amountOf(input);
  if (!amount) return null;
  const date = await asOfDate(ctx, input);
  const accountId = await ensureUncategorizedAccount(ctx, 'expense');
  const line = { accountId, description: MEMO, amount: amount.abs().toFixed(2) };
  const day = date.toISOString().slice(0, 10);
  if (amount.isPositive()) {
    const bill = await createBill(ctx, { vendorId, date, memo: MEMO, lines: [line] });
    return { kind: 'bill', id: (bill as { id: string }).id, amount: amount.toFixed(2), date: day };
  }
  const credit = await createVendorCredit(ctx, { vendorId, date, memo: MEMO, lines: [line] });
  return { kind: 'vendor_credit', id: (credit as { id: string }).id, amount: amount.toFixed(2), date: day };
}
