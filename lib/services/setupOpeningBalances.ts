/**
 * EasyStep setup interview — opening balances (QB: "Add your bank accounts" with the statement
 * balance as of the start date, plus what customers owe you and what you owe vendors).
 *
 * Every amount is balanced through Opening Balance Equity and dated the "as of" day (by default
 * the day before the start date, so the first day you track holds only new activity):
 *   - bank / other asset accounts:   Dr account          / Cr Opening Balance Equity
 *   - credit card / loan / liability: Dr Opening Balance Equity / Cr account
 *     (a negative amount flips the direction — an overdrawn bank, a card in credit);
 *   - customers (A/R): an invoice to the customer, its line on Opening Balance Equity
 *     (a negative amount: a credit memo), so the balance can be received like any invoice and
 *     A/R aging shows who owes it;
 *   - vendors (A/P): a bill from the vendor on Opening Balance Equity (negative: a vendor credit).
 * Posting goes through postJournalEntry / createInvoice / createCreditMemo / createBill /
 * createVendorCredit, so the closing date (and its password), audit trail and subledgers apply
 * exactly as for anything entered by hand.
 *
 * Safe to re-run: an account's interview entry is found by its sourceRef; the same amount and
 * date is left alone, a changed one is voided and posted again (voidJournalEntry, closing-date
 * aware). A customer or vendor that already has an interview opening document is left alone
 * (change it on the invoice / bill itself).
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accounts, bills, customers, invoices, journalEntries, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { isIsoDate } from '@/lib/onboarding';
import { type ServiceContext, notFound, validation } from './_base';
import { requirePermission } from './access';
import { createAccount, findOrCreateOpeningBalanceEquity, nextAccountNumber } from './accounts';
import { postJournalEntry, voidJournalEntry } from './posting';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createCreditMemo } from './creditMemos';
import { createBill } from './bills';
import { createVendorCredit } from './vendorCredits';

/** Kinds of account the interview asks about (QB EasyStep account types). */
export const OPENING_ACCOUNT_KINDS = {
  bank: { label: 'Bank', type: 'asset', subtype: 'checking' },
  credit_card: { label: 'Credit card', type: 'liability', subtype: 'credit_card' },
  loan: { label: 'Loan', type: 'liability', subtype: 'long_term_liability' },
  other_current_asset: { label: 'Other current asset', type: 'asset', subtype: 'other_current_asset' },
  fixed_asset: { label: 'Fixed asset', type: 'asset', subtype: 'fixed_assets' },
  other_current_liability: { label: 'Other current liability', type: 'liability', subtype: 'other_current_liability' },
} as const;
export type OpeningAccountKind = keyof typeof OPENING_ACCOUNT_KINDS;

const OPENING_MEMO = 'Opening balance (setup interview)';
const SOURCE_PREFIX = 'setup-opening:';

const zAmount = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d{1,2})?$/, 'Amounts must be numbers with at most 2 decimals, like 1250.00');
const zDay = z.string().refine((s) => isIsoDate(s), 'The balance date is not a real calendar date');

export const openingBalancesSchema = z.object({
  /** The day the balances are as of (default: the day before the start date). */
  asOf: zDay.optional().or(z.literal('').transform(() => undefined)),
  accounts: z
    .array(
      z
        .object({
          accountId: z.string().uuid().optional().nullable(),
          /** A new account's name (when no accountId). */
          name: z.string().trim().max(100).optional(),
          kind: z.enum(Object.keys(OPENING_ACCOUNT_KINDS) as [OpeningAccountKind, ...OpeningAccountKind[]]),
          amount: zAmount,
        })
        .refine((a) => Boolean(a.accountId) || Boolean(a.name), { message: 'Pick an account or type a name for a new one.' }),
    )
    .max(200)
    .optional(),
  customers: z.array(z.object({ name: z.string().trim().min(1).max(255), amount: zAmount })).max(500).optional(),
  vendors: z.array(z.object({ name: z.string().trim().min(1).max(255), amount: zAmount })).max(500).optional(),
});
export type OpeningBalancesInput = z.infer<typeof openingBalancesSchema>;

export interface OpeningBalancesResult {
  asOf: string | null;
  /** One plain-language line per balance posted or kept. */
  lines: string[];
  posted: number;
}

/** The day before an ISO day. */
export function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const nonZero = (s: string) => !Money.of(s).isZero();

function hasAny(input: OpeningBalancesInput | undefined): boolean {
  if (!input) return false;
  return [...(input.accounts ?? []), ...(input.customers ?? []), ...(input.vendors ?? [])].some((r) => nonZero(r.amount));
}

/** The account a row names: an existing one of this company, or a new one of its kind. */
async function accountFor(
  ctx: ServiceContext,
  row: NonNullable<OpeningBalancesInput['accounts']>[number],
): Promise<{ id: string; label: string; type: string; created: boolean }> {
  const kind = OPENING_ACCOUNT_KINDS[row.kind];
  if (row.accountId) {
    const [a] = await ctx.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, row.accountId)));
    if (!a) throw notFound('Account');
    const st = String(a.subtype);
    if (st === 'accounts_receivable' || st === 'accounts_payable') {
      throw validation(`"${a.name}": enter what customers owe and what you owe vendors in their own sections, not on the account.`);
    }
    if (String(a.type) !== 'asset' && String(a.type) !== 'liability') {
      throw validation(`"${a.name}" is not a balance sheet account (bank, card, loan or other asset / liability).`);
    }
    return { id: a.id, label: `${a.code} · ${a.name}`, type: String(a.type), created: false };
  }
  const name = row.name!.trim();
  const [same] = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), sql`lower(${accounts.name}) = ${name.toLowerCase()}`));
  if (same) {
    if (String(same.type) !== kind.type) throw validation(`An account named "${same.name}" already exists and is not a ${kind.label.toLowerCase()} account.`);
    return { id: same.id, label: `${same.code} · ${same.name}`, type: String(same.type), created: false };
  }
  const code = await nextAccountNumber(ctx, kind.type, kind.subtype);
  const created = await createAccount(ctx, { code, name, type: kind.type, subtype: kind.subtype });
  return { id: created.id, label: `${created.code} · ${created.name}`, type: kind.type, created: true };
}

/** Find a customer / vendor by name (case-insensitive), or add it. */
async function nameId(ctx: ServiceContext, who: 'customer' | 'vendor', name: string): Promise<string> {
  const table = who === 'customer' ? customers : vendors;
  const [hit] = await ctx.db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, ctx.companyId), sql`lower(${table.displayName}) = ${name.toLowerCase()}`));
  if (hit) return hit.id;
  const row = who === 'customer' ? await createCustomer(ctx, { displayName: name } as never) : await createVendor(ctx, { displayName: name } as never);
  return (row as { id: string }).id;
}

/**
 * Post the interview's opening balances (inside the caller's transaction). Returns what was
 * posted, in plain language. No amounts → nothing happens.
 */
export async function postSetupOpeningBalances(
  ctx: ServiceContext,
  input: OpeningBalancesInput | undefined,
  startDate: string | null | undefined,
): Promise<OpeningBalancesResult> {
  if (!hasAny(input)) return { asOf: null, lines: [], posted: 0 };
  const asOf = input!.asOf || (startDate ? dayBefore(startDate) : null);
  if (!asOf) throw validation('Enter the date your opening balances are as of (or a start date).');
  const date = dateOf(asOf);
  const out: string[] = [];
  let posted = 0;

  const accountRows = (input!.accounts ?? []).filter((r) => nonZero(r.amount));
  const customerRows = (input!.customers ?? []).filter((r) => nonZero(r.amount));
  const vendorRows = (input!.vendors ?? []).filter((r) => nonZero(r.amount));
  if (accountRows.length) requirePermission(ctx, 'accounting', 'create');
  if (customerRows.length) requirePermission(ctx, 'customers', 'create');
  if (vendorRows.length) requirePermission(ctx, 'vendors', 'create');

  const obe = await findOrCreateOpeningBalanceEquity(ctx);

  // 1. Bank, credit card, loan and other balance sheet accounts: one entry per account.
  const seen = new Set<string>();
  for (const row of accountRows) {
    const acct = await accountFor(ctx, row);
    if (acct.id === obe.id) throw validation('Opening Balance Equity takes the other side of every opening balance; pick another account.');
    if (seen.has(acct.id)) throw validation(`${acct.label} is listed twice. Enter one balance per account.`);
    seen.add(acct.id);
    const amt = Money.of(row.amount);
    const amount = toAmountString(amt.abs());
    const sourceRef = `${SOURCE_PREFIX}${acct.id}`;
    const debitAccount = (acct.type === 'asset') !== amt.isNegative();
    const lines = debitAccount
      ? [
          { accountId: acct.id, debit: amount, memo: OPENING_MEMO },
          { accountId: obe.id, credit: amount, memo: 'Opening balance offset' },
        ]
      : [
          { accountId: acct.id, credit: amount, memo: OPENING_MEMO },
          { accountId: obe.id, debit: amount, memo: 'Opening balance offset' },
        ];
    // Re-run: an earlier interview entry for this account.
    const [prior] = await ctx.db
      .select({ id: journalEntries.id, date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, sourceRef), ne(journalEntries.status, 'void')));
    if (prior) {
      const [bal] = (
        await ctx.db.execute(sql`
          SELECT COALESCE(SUM(COALESCE(debit,0) - COALESCE(credit,0)),0)::text AS net
            FROM journal_entry_lines WHERE journal_entry_id = ${prior.id}::uuid AND account_id = ${acct.id}::uuid`)
      ).rows as Array<{ net: string }>;
      const want = debitAccount ? Money.of(amount) : Money.of(amount).negated();
      if (Money.of(bal?.net ?? 0).equals(want) && prior.date.toISOString().slice(0, 10) === asOf) {
        out.push(`${acct.label}: opening balance ${toAmountString(amt)} as of ${asOf} (already entered)`);
        continue;
      }
      await voidJournalEntry(ctx, prior.id);
    }
    await postJournalEntry(ctx, {
      date,
      description: `Opening balance for ${acct.label}`,
      status: 'posted',
      sourceRef,
      lines,
    });
    posted++;
    out.push(`${acct.label}${acct.created ? ' (new account)' : ''}: opening balance ${toAmountString(amt)} as of ${asOf}`);
  }

  // 2. Customers who owe you: an invoice (or credit memo) on Opening Balance Equity.
  for (const row of customerRows) {
    const customerId = await nameId(ctx, 'customer', row.name);
    const [already] = await ctx.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, customerId), eq(invoices.memo, OPENING_MEMO), ne(invoices.status, 'void')));
    if (already) {
      out.push(`${row.name}: already has an opening balance invoice from the setup interview (change it on the invoice)`);
      continue;
    }
    const amt = Money.of(row.amount);
    const line = { accountId: obe.id, description: 'Opening balance', quantity: 1, rate: toAmountString(amt.abs()), taxable: false };
    if (amt.isPositive()) {
      await createInvoice(ctx, { customerId, date, memo: OPENING_MEMO, lines: [line], taxRateId: null, overrideCreditLimit: true } as never);
    } else {
      await createCreditMemo(ctx, { customerId, date, memo: OPENING_MEMO, lines: [line], taxRateId: null });
    }
    posted++;
    out.push(`${row.name} owes you ${toAmountString(amt)} as of ${asOf} (${amt.isPositive() ? 'invoice' : 'credit memo'})`);
  }

  // 3. Vendors you owe: a bill (or vendor credit) on Opening Balance Equity.
  for (const row of vendorRows) {
    const vendorId = await nameId(ctx, 'vendor', row.name);
    const [already] = await ctx.db
      .select({ id: bills.id })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, vendorId), eq(bills.memo, OPENING_MEMO), ne(bills.status, 'void')));
    if (already) {
      out.push(`${row.name}: already has an opening balance bill from the setup interview (change it on the bill)`);
      continue;
    }
    const amt = Money.of(row.amount);
    const line = { accountId: obe.id, description: 'Opening balance', amount: toAmountString(amt.abs()) };
    if (amt.isPositive()) await createBill(ctx, { vendorId, date, memo: OPENING_MEMO, lines: [line] });
    else await createVendorCredit(ctx, { vendorId, date, memo: OPENING_MEMO, lines: [line] });
    posted++;
    out.push(`You owe ${row.name} ${toAmountString(amt)} as of ${asOf} (${amt.isPositive() ? 'bill' : 'vendor credit'})`);
  }

  return { asOf, lines: out, posted };
}
