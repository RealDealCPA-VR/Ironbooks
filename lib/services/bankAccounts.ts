/**
 * Bank accounts — links a real bank/credit-card account to its GL account. Required before
 * importing transactions or reconciling. (Account numbers should be encrypted at rest — Phase 12.4.)
 */
import { and, eq } from 'drizzle-orm';
import { accounts, bankAccounts } from '@/lib/db/schema';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { maskForContext } from './access';

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
  if (!input.bankName?.trim()) throw validation('Bank name is required.');
  // The GL account must belong to this company and be an asset/liability (bank or credit card).
  const [gl] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, ctx.companyId)));
  if (!gl) throw notFound('GL account');
  if (gl.type !== 'asset' && gl.type !== 'liability') {
    throw validation('A bank account must map to an asset or liability GL account.');
  }

  const [row] = await ctx.db
    .insert(bankAccounts)
    .values({
      companyId: ctx.companyId,
      accountId: input.accountId,
      bankName: input.bankName.trim(),
      accountNumber: input.accountNumber ?? '',
    })
    .returning();

  await writeAudit(ctx, {
    action: 'create',
    entityType: 'bank_account',
    entityId: row.id,
    newValues: { bankName: row.bankName, accountId: row.accountId },
  });
  return maskForContext(ctx, row);
}
