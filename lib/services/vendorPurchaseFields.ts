/**
 * Purchase-side vendor fields (wave2 D6 + J10), kept out of vendors.ts so the master-data module
 * stays small:
 *   - prefillAccountIds : up to 3 accounts pre-filled on new bills / checks / card charges
 *   - printOnCheckAs    : the name printed on checks (defaults to the display name)
 *   - accountNumber     : the account number the vendor knows us by — printed on the check memo
 *   - currency          : the vendor's currency (multi-currency); fixed once it has transactions
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  accounts,
  billPayments,
  bills,
  expenses,
  itemReceipts,
  purchaseOrders,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { type ServiceContext, ServiceError, validation } from './_base';
import { assertForeignCurrencyAllowed } from './multiCurrency';
import { getHomeCurrencyCode } from './currencies';
import { currencies } from '@/lib/db/schema';
import { isMaskedValue } from '@/lib/permissions/mask';

export interface VendorPurchaseFieldsInput {
  prefillAccountIds?: string[] | null;
  printOnCheckAs?: string | null;
  accountNumber?: string | null;
  currency?: string | null;
}

export const MAX_PREFILL_ACCOUNTS = 3;

/**
 * True when the vendor already has bills, checks, bill payments, vendor credits, purchase orders or
 * item receipts (that are not void).
 */
async function vendorHasTransactions(ctx: ServiceContext, vendorId: string): Promise<boolean> {
  const [b] = await ctx.db
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.companyId, ctx.companyId), eq(bills.vendorId, vendorId), ne(bills.status, 'void')))
    .limit(1);
  if (b) return true;
  const [e] = await ctx.db
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.vendorId, vendorId), isNull(expenses.voidedAt)))
    .limit(1);
  if (e) return true;
  const [p] = await ctx.db
    .select({ id: billPayments.id })
    .from(billPayments)
    .where(
      and(eq(billPayments.companyId, ctx.companyId), eq(billPayments.vendorId, vendorId), isNull(billPayments.voidedAt)),
    )
    .limit(1);
  if (p) return true;
  const [vc] = await ctx.db
    .select({ id: vendorCredits.id })
    .from(vendorCredits)
    .where(and(eq(vendorCredits.companyId, ctx.companyId), eq(vendorCredits.vendorId, vendorId), ne(vendorCredits.status, 'void')))
    .limit(1);
  if (vc) return true;
  const [po] = await ctx.db
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.vendorId, vendorId), ne(purchaseOrders.status, 'void')))
    .limit(1);
  if (po) return true;
  const [ir] = await ctx.db
    .select({ id: itemReceipts.id })
    .from(itemReceipts)
    .where(and(eq(itemReceipts.companyId, ctx.companyId), eq(itemReceipts.vendorId, vendorId), isNull(itemReceipts.voidedAt)))
    .limit(1);
  return Boolean(ir);
}

/**
 * Validate + normalise the purchase fields present in `input` (absent keys are left out of the
 * result so a PATCH keeps current values). `existing` is the current vendor row on update.
 */
export async function resolveVendorPurchaseFields(
  ctx: ServiceContext,
  input: VendorPurchaseFieldsInput,
  existing?: { id: string; currency: string | null },
): Promise<Partial<{ prefillAccountIds: string[] | null; printOnCheckAs: string | null; accountNumber: string | null; currency: string | null }>> {
  const out: Partial<{ prefillAccountIds: string[] | null; printOnCheckAs: string | null; accountNumber: string | null; currency: string | null }> = {};

  if (input.prefillAccountIds !== undefined) {
    const ids = [...new Set((input.prefillAccountIds ?? []).filter(Boolean))];
    if (ids.length > MAX_PREFILL_ACCOUNTS) {
      throw validation(`A vendor can have at most ${MAX_PREFILL_ACCOUNTS} pre-fill accounts.`);
    }
    if (ids.length > 0) {
      const rows = await ctx.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, ids)));
      if (rows.length !== ids.length) throw validation('A pre-fill account was not found in your chart of accounts.');
    }
    out.prefillAccountIds = ids.length > 0 ? ids : null;
  }
  if (input.printOnCheckAs !== undefined) out.printOnCheckAs = input.printOnCheckAs?.trim() || null;
  if (input.accountNumber !== undefined) {
    // A user who may not see full account numbers gets "••••6789" in the vendor form, and the form
    // sends it back on every save: it overwrote the real account number (then printed on every
    // check memo as "Acct # ••••6789"). A masked value is never data — an edit keeps the saved
    // number; a new vendor must be given the real one.
    if (isMaskedValue(input.accountNumber)) {
      if (!existing) throw validation('Enter the full account number; a masked value cannot be saved.');
    } else {
      out.accountNumber = input.accountNumber?.trim() || null;
    }
  }

  if (input.currency !== undefined) {
    const home = await getHomeCurrencyCode(ctx);
    let next = (input.currency ?? '').trim().toUpperCase() || null;
    if (next && home && next === home) next = null;
    if (next) {
      await assertForeignCurrencyAllowed(ctx, next); // A2: Multiple Currencies off
      const [cur] = await ctx.db
        .select({ id: currencies.id })
        .from(currencies)
        .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.code, next)));
      if (!cur) throw validation(`${next} is not in your currency list. Add it under Currencies first.`);
    }
    if (existing && (existing.currency ?? null) !== next && (await vendorHasTransactions(ctx, existing.id))) {
      throw new ServiceError(
        'CONFLICT',
        "This vendor already has transactions, so its currency can't change. Create a new vendor for the other currency.",
      );
    }
    out.currency = next;
  }
  return out;
}

/** The vendor's pre-fill accounts (for bills / checks), in order. */
export async function vendorPrefillAccounts(ctx: ServiceContext, vendorId: string): Promise<string[]> {
  const [row] = await ctx.db
    .select({ ids: vendors.prefillAccountIds, def: vendors.defaultExpenseAccountId })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
  if (!row) return [];
  const ids = (row.ids ?? []).filter(Boolean);
  if (ids.length > 0) return ids;
  return row.def ? [row.def] : [];
}
