/**
 * Accountant Center (QB Accountant → Accountant Center) — wave2 accountant, I12.
 * One read-only summary: reconciliation status per bank/credit-card account, memorized reports,
 * closing date, sales tax owed (tied to the GL), list changes awaiting review and the last
 * Client Data Review.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { accounts, bankAccounts, companies, memorizedReports, reconciliations } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { salesTaxGlBalance } from './salesTaxLedger';
import { listListChanges } from './listChanges';
import { latestSnapshot } from './clientDataReview';

export interface ReconciliationStatusRow {
  bankAccountId: string;
  accountId: string;
  name: string;
  balance: string;
  lastReconciledDate: string | null;
  lastReconciledBalance: string | null;
  inProgress: boolean;
  daysSinceReconciled: number | null;
}

export async function accountantCenterSummary(ctx: ServiceContext) {
  const banks = await ctx.db
    .select({
      id: bankAccounts.id,
      accountId: bankAccounts.accountId,
      bankName: bankAccounts.bankName,
      code: accounts.code,
      name: accounts.name,
      balance: accounts.balance,
      lastReconciledDate: bankAccounts.lastReconciledDate,
      lastReconciledBalance: bankAccounts.lastReconciledBalance,
    })
    .from(bankAccounts)
    .innerJoin(accounts, eq(bankAccounts.accountId, accounts.id))
    .where(eq(bankAccounts.companyId, ctx.companyId));
  const inProgress = banks.length
    ? await ctx.db
        .select({ bankAccountId: reconciliations.bankAccountId })
        .from(reconciliations)
        .where(and(inArray(reconciliations.bankAccountId, banks.map((b) => b.id)), eq(reconciliations.status, 'in_progress')))
    : [];
  const open = new Set(inProgress.map((r) => r.bankAccountId));
  const now = Date.now();
  const reconciliationStatus: ReconciliationStatusRow[] = banks
    .map((b) => ({
      bankAccountId: b.id,
      accountId: b.accountId,
      name: `${b.code} · ${b.name}`,
      balance: b.balance,
      lastReconciledDate: b.lastReconciledDate ? b.lastReconciledDate.toISOString() : null,
      lastReconciledBalance: b.lastReconciledBalance ?? null,
      inProgress: open.has(b.id),
      daysSinceReconciled: b.lastReconciledDate ? Math.floor((now - b.lastReconciledDate.getTime()) / 86_400_000) : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const memorized = await ctx.db
    .select({ id: memorizedReports.id, name: memorizedReports.name, reportType: memorizedReports.reportType })
    .from(memorizedReports)
    .where(eq(memorizedReports.companyId, ctx.companyId))
    .orderBy(desc(memorizedReports.createdAt));

  const [company] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const cd = ((company?.settings ?? {}) as Record<string, unknown>).closingDate;

  const changes = await listListChanges(ctx, { includeReviewed: false, limit: 1000 });
  const snap = await latestSnapshot(ctx);
  return {
    reconciliationStatus,
    memorizedReports: memorized,
    closingDate: typeof cd === 'string' && cd ? cd : null,
    salesTaxOwed: await salesTaxGlBalance(ctx),
    unreviewedListChanges: changes.unreviewed,
    lastReview: snap ? { asOf: snap.asOf, at: snap.createdAt.toISOString() } : null,
  };
}
