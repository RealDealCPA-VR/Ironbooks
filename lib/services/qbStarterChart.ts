/**
 * "Replace Ironbooks' starter chart of accounts" for a QuickBooks conversion (IIF chart import).
 *
 * A new company starts with Ironbooks' 25-account starter chart (company.ts DEFAULT_COA). Importing
 * a client's QuickBooks chart on top of it used to leave every starter account the client doesn't
 * use next to the real chart (Advertising & Marketing, Owner's Equity, a second "Checking"...).
 *
 *  1. BEFORE the accounts are created, a starter account Ironbooks posts to by its number (A/R
 *     1200, A/P 2000, Undeposited Funds 1050, Inventory Asset 1300, Sales Tax Payable 2200, Payroll
 *     Liabilities 2300, Retained Earnings 3900, Sales Income 4000, Cost of Goods Sold 5000, Payroll
 *     Expense 6500) whose QuickBooks counterpart has another name ("A/R - Trade") takes that name,
 *     so the import uses it instead of creating a second A/R account. It keeps its number (the
 *     posting services find it by number).
 *  2. AFTER the import, every other starter account that the file did not bring and that was never
 *     used is deleted. 1000 Checking goes only when the file brings a bank account of its own.
 *     The system accounts above stay (renamed or not): Ironbooks needs them.
 *
 * Nothing that has a transaction, a sub-account, is chosen in Preferences or is referenced by
 * another record is ever deleted; each one kept is reported.
 */
import { and, eq } from 'drizzle-orm';
import { accounts, companies, journalEntryLines } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, writeAudit } from './_base';
import { DEFAULT_COA } from './company';
import type { ImportCounts } from './qbImport';

interface IifAccountLike {
  name: string;
  accntType: string;
}

type IssueSink = Pick<ImportCounts, 'issues'>;

/** System starter accounts: kept, and merged with their QuickBooks counterpart by kind. */
const SYSTEM_STARTERS: Array<{ code: string; match: (a: IifAccountLike) => boolean }> = [
  { code: '1200', match: (a) => a.accntType === 'AR' },
  { code: '2000', match: (a) => a.accntType === 'AP' },
  { code: '1050', match: (a) => a.accntType === 'OCASSET' && /undeposited/i.test(a.name) },
  { code: '1300', match: (a) => a.accntType === 'OCASSET' && /inventory/i.test(a.name) },
  { code: '2200', match: (a) => a.accntType === 'OCLIAB' && /sales\s*tax/i.test(a.name) },
  { code: '2300', match: (a) => a.accntType === 'OCLIAB' && /payroll/i.test(a.name) },
  { code: '3900', match: (a) => a.accntType === 'EQUITY' && /retained\s+earnings/i.test(a.name) },
  { code: '4000', match: (a) => a.accntType === 'INC' && /^(sales|sales income|income|revenue)$/i.test(a.name.trim()) },
  { code: '5000', match: (a) => a.accntType === 'COGS' },
  { code: '6500', match: (a) => a.accntType === 'EXP' && /^payroll\s+expenses?$/i.test(a.name.trim()) },
];
/** Kept even with no counterpart: posted to by number (company.ts / accountRoles SYSTEM_ACCOUNT_CODES). */
const ALWAYS_KEEP = new Set(SYSTEM_STARTERS.map((s) => s.code));

/** The QuickBooks IIF account type code for an Ironbooks type / detail type (CSV / Excel charts). */
export function iifTypeFor(type: string, subtype: string | null | undefined): string {
  const st = subtype ?? '';
  if (type === 'asset') {
    if (st === 'checking' || st === 'savings') return 'BANK';
    if (st === 'accounts_receivable') return 'AR';
    if (st === 'fixed_assets') return 'FIXASSET';
    if (st === 'other_asset') return 'OASSET';
    return 'OCASSET';
  }
  if (type === 'liability') {
    if (st === 'accounts_payable') return 'AP';
    if (st === 'credit_card') return 'CCARD';
    if (st === 'long_term_liability') return 'LTLIAB';
    return 'OCLIAB';
  }
  if (type === 'equity') return 'EQUITY';
  if (type === 'revenue') return st === 'other_income' ? 'EXINC' : 'INC';
  if (type === 'expense') return st === 'cost_of_goods_sold' ? 'COGS' : st === 'other_expense' ? 'EXEXP' : 'EXP';
  return '';
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const topLevel = (a: IifAccountLike) => !a.name.includes(':');

/** The starter accounts still as they were seeded (number AND name), by number. */
async function starterAccounts(ctx: ServiceContext) {
  const seeded = new Map(DEFAULT_COA.map((s) => [s.code, s]));
  const rows = await ctx.db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, parentId: accounts.parentId })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return rows.filter((r) => !r.parentId && seeded.get(r.code)?.name === r.name);
}

/**
 * Step 1 (before the accounts are created): give each system starter account the name of its
 * QuickBooks counterpart when the file names it differently, so the import uses that account.
 * Returns the ids of the starter accounts the file brings (merged here or with the same name).
 */
export async function mergeStarterChart(ctx: ServiceContext, iif: IifAccountLike[], sink: IssueSink): Promise<Set<string>> {
  const matched = new Set<string>();
  const starters = await starterAccounts(ctx);
  const fileNames = new Set(iif.filter(topLevel).map((a) => norm(a.name)));
  for (const s of starters) if (fileNames.has(norm(s.name))) matched.add(s.id);
  for (const rule of SYSTEM_STARTERS) {
    const starter = starters.find((s) => s.code === rule.code);
    if (!starter || matched.has(starter.id)) continue;
    const candidates = iif.filter((a) => topLevel(a) && rule.match(a));
    if (candidates.length !== 1) continue; // none, or several (ambiguous): left as they are
    const qbName = candidates[0].name.trim();
    // Another account already carries that name (not a starter): leave both alone.
    const [taken] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, qbName)))
      .limit(1);
    if (taken) continue;
    await inTransaction(ctx, async (tx) => {
      await tx.db.update(accounts).set({ name: qbName }).where(eq(accounts.id, starter.id));
      await writeAudit(tx, {
        action: 'update',
        entityType: 'account',
        entityId: starter.id,
        oldValues: { name: starter.name },
        newValues: { name: qbName, reason: 'QuickBooks chart import: uses the starter system account' },
      });
    });
    matched.add(starter.id);
    sink.issues.push({
      entity: 'account',
      name: qbName,
      code: starter.code,
      reason: 'note',
      message: `QuickBooks' "${qbName}" uses Ironbooks' system account ${starter.code} (renamed from "${starter.name}"), which keeps its number because Ironbooks posts to it.`,
    });
  }
  return matched;
}

/**
 * Step 2 (after the import): delete the starter accounts the file did not bring and that were
 * never used. Returns how many were removed.
 */
export async function removeUnusedStarterAccounts(
  ctx: ServiceContext,
  iif: IifAccountLike[],
  matched: Set<string>,
  sink: IssueSink,
): Promise<number> {
  const fileHasBank = iif.some((a) => a.accntType === 'BANK');
  const [co] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const settingsText = JSON.stringify(co?.settings ?? {});
  let removed = 0;
  const kept: string[] = [];
  for (const s of await starterAccounts(ctx)) {
    if (matched.has(s.id) || ALWAYS_KEEP.has(s.code)) continue;
    if (s.code === '1000' && !fileHasBank) continue;
    const [line] = await ctx.db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.accountId, s.id))
      .limit(1);
    const [child] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.parentId, s.id)))
      .limit(1);
    if (line || child || settingsText.includes(s.id)) {
      kept.push(`${s.code} ${s.name}`);
      continue;
    }
    try {
      await inTransaction(ctx, async (tx) => {
        await tx.db.delete(accounts).where(and(eq(accounts.id, s.id), eq(accounts.companyId, tx.companyId)));
        await writeAudit(tx, {
          action: 'delete',
          entityType: 'account',
          entityId: s.id,
          oldValues: { code: s.code, name: s.name, reason: 'QuickBooks chart import replaced the starter chart' },
        });
      });
      removed++;
    } catch {
      kept.push(`${s.code} ${s.name}`); // still referenced by another record
    }
  }
  if (removed > 0) {
    sink.issues.push({
      entity: 'account',
      name: 'Starter chart of accounts',
      reason: 'note',
      message: `${removed} of Ironbooks' starter accounts that your QuickBooks chart doesn't have were removed.`,
    });
  }
  if (kept.length > 0) {
    sink.issues.push({
      entity: 'account',
      name: 'Starter chart of accounts',
      reason: 'note',
      message: `Kept because they are already in use: ${kept.join(', ')}. Make them inactive in the Chart of Accounts if you don't need them.`,
    });
  }
  return removed;
}
