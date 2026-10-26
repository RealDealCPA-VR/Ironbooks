/**
 * Bank accounts — links a real bank/credit-card account to its GL account. Required before
 * importing transactions or reconciling. (Account numbers should be encrypted at rest — Phase 12.4.)
 */
import { and, eq } from 'drizzle-orm';
import { accounts, bankAccounts } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { maskForContext } from './access';
import { isMaskedValue } from '@/lib/permissions/mask';
import { subledgerAccountReason } from '@/lib/registerEntryPlan';

// Account numbers leave this service masked (last 4 only) unless the caller's roles grant
// "view full bank / account numbers" (Users & Roles); see maskForContext.

export async function listBankAccounts(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({
      id: bankAccounts.id,
      accountId: bankAccounts.accountId,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      lastReconciledDate: bankAccounts.lastReconciledDate,
      lastReconciledBalance: bankAccounts.lastReconciledBalance,
      glAccountName: accounts.name,
      glAccountCode: accounts.code,
      /** p1 fx: the GL account's currency (null = home); feed amounts are in it. */
      currency: accounts.currency,
    })
    .from(bankAccounts)
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(eq(bankAccounts.companyId, ctx.companyId));
  return maskForContext(ctx, rows);
}

export async function getBankAccount(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, ctx.companyId)));
  if (!row) throw notFound('Bank account');
  return maskForContext(ctx, row);
}

export async function createBankAccount(
  ctx: ServiceContext,
  input: { accountId: string; bankName: string; accountNumber: string },
) {
  if (typeof input.bankName !== 'string' || !input.bankName.trim()) throw validation('Bank name is required.');
  if (input.bankName.trim().length > 255) throw validation('The bank name is too long (max 255 characters).');
  if (input.accountNumber != null && typeof input.accountNumber !== 'string') {
    throw validation('Enter the account number as text.');
  }
  if ((input.accountNumber ?? '').length > 100) throw validation('The account number is too long.');
  // A role without "view full account numbers" only ever sees "••••6789"; never store that
  // placeholder as if it were the real number.
  if (isMaskedValue(input.accountNumber)) {
    throw validation('Enter the full account number (a masked number cannot be saved).');
  }
  if (typeof input.accountId !== 'string' || !input.accountId) throw validation('Choose the GL account to link.');

  return inTransaction(ctx, async (tx) => {
    // The GL account must belong to this company and be an asset/liability (bank or credit card).
    const [gl] = await tx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, tx.companyId)));
    if (!gl) throw notFound('GL account');
    if (gl.type !== 'asset' && gl.type !== 'liability') {
      throw validation('A bank account must map to an asset or liability GL account.');
    }
    // Lines imported for the link are added to the GL account itself: on Undeposited Funds or an
    // inventory asset account they moved a balance Make Deposits / the inventory valuation keep;
    // on A/R or A/P every line would need a customer or vendor (and could never be added).
    const reason =
      subledgerAccountReason(gl) ??
      (gl.subtype === 'accounts_receivable' || gl.subtype === 'accounts_payable'
        ? `"${gl.name}" is ${gl.subtype === 'accounts_receivable' ? 'Accounts Receivable' : 'Accounts Payable'}: its amounts belong to customers or vendors.`
        : null);
    if (reason) throw validation(`${reason} Link a bank, credit card or other balance-sheet account instead.`);
    // One link per GL account (QB: one register, one reconciliation history per account). A
    // second link — e.g. a double-clicked "Add Account" — gave the same register two separate
    // reconciliation histories, opening balances and in-progress sessions. Checked inside the
    // transaction, so two saves at once cannot both pass.
    const [linked] = await tx.db
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, tx.companyId), eq(bankAccounts.accountId, input.accountId)))
      .limit(1);
    if (linked) {
      throw new ServiceError('CONFLICT', `"${gl.name}" is already linked to a bank account.`, { bankAccountId: linked.id });
    }

    const [row] = await tx.db
      .insert(bankAccounts)
      .values({
        companyId: tx.companyId,
        accountId: input.accountId,
        bankName: input.bankName.trim(),
        accountNumber: input.accountNumber ?? '',
      })
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'bank_account',
      entityId: row.id,
      newValues: { bankName: row.bankName, accountId: row.accountId },
    });
    return maskForContext(ctx, row);
  });
}
