/**
 * Server-side lookups behind the "pick the default" fixes (lib/errorFixes.ts): which account to
 * suggest when a required account was left empty. Read-only; every query is scoped to
 * ctx.companyId.
 *
 *  - expense: the vendor's default expense account, else Preferences > Purchases default expense
 *    account, else the first active expense account (by code).
 *  - bank: Preferences default deposit / check account, else the first active checking or savings
 *    account (never Undeposited Funds).
 *
 * `missingAccountFixesForIssues` turns zod issues on a route's body (e.g. `lines.2.accountId`
 * "Pick an account or an item.") into a "Use 6000 Office Supplies" fix the route returns with
 * its 400, so the form can fill the account in and save again.
 */
import { and, asc, eq } from 'drizzle-orm';
import { accounts, vendors } from '@/lib/db/schema';
import { missingAccountFixes, type ErrorFix } from '@/lib/errorFixes';
import type { ServiceContext } from './_base';
import { getPreferences } from './company';
import { accountFitsKind } from './prefAccounts';

export type DefaultAccountKind = 'expense' | 'bank';

export interface SuggestedAccount {
  id: string;
  name: string;
  code: string | null;
}

async function activeAccount(ctx: ServiceContext, id: string | null | undefined, kind: DefaultAccountKind) {
  if (!id) return null;
  const [row] = await ctx.db
    .select({ id: accounts.id, name: accounts.name, code: accounts.code, type: accounts.type, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
  if (!row || !row.isActive || !accountFitsKind(row, kind)) return null;
  return { id: row.id, name: row.name, code: row.code };
}

/** The account to suggest for an empty required account field (null when the company has none). */
export async function defaultAccountFor(
  ctx: ServiceContext,
  kind: DefaultAccountKind,
  opts: { vendorId?: string | null; purpose?: 'deposit' | 'check' } = {},
): Promise<SuggestedAccount | null> {
  const prefs = await getPreferences(ctx);
  if (kind === 'expense') {
    if (opts.vendorId) {
      const [v] = await ctx.db
        .select({ acct: vendors.defaultExpenseAccountId })
        .from(vendors)
        .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, opts.vendorId)));
      const fromVendor = await activeAccount(ctx, v?.acct, 'expense');
      if (fromVendor) return fromVendor;
    }
    const fromPrefs = await activeAccount(ctx, prefs.defaultExpenseAccountId, 'expense');
    if (fromPrefs) return fromPrefs;
  } else {
    const prefId = opts.purpose === 'check' ? prefs.defaultCheckAccountId : prefs.defaultDepositAccountId;
    const fromPrefs = await activeAccount(ctx, prefId, 'bank');
    if (fromPrefs) return fromPrefs;
  }
  const rows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, code: accounts.code, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true)))
    .orderBy(asc(accounts.code));
  const hit = rows.find((r) => accountFitsKind(r, kind));
  return hit ? { id: hit.id, name: hit.name, code: hit.code } : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_PATH = /^(?:(lines|extraLines)\.(\d+)\.)?(accountId|depositAccountId|paymentAccountId)$/;

/**
 * Fixes for zod issues that say a required account is missing. `body` is the raw request body
 * (for the vendor). Issues on other fields are ignored; returns [] when none apply.
 */
export async function missingAccountFixesForIssues(
  ctx: ServiceContext,
  issues: ReadonlyArray<{ path: string; message: string }>,
  body: unknown,
  kind: DefaultAccountKind,
  opts: { purpose?: 'deposit' | 'check' } = {},
): Promise<ErrorFix[]> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const paths: string[] = [];
  const lineNumbers: (number | null)[] = [];
  for (const issue of issues) {
    const m = ACCOUNT_PATH.exec(issue.path);
    if (!m) continue;
    // Line accounts get an expense default; header accounts (deposit to / pay from) a bank one.
    if ((kind === 'expense') !== (m[1] === 'lines')) continue;
    // Only empty values: a wrong id is a different problem (the user picked something).
    const current = m[1] ? ((b[m[1]] as unknown[] | undefined)?.[Number(m[2])] as Record<string, unknown> | undefined)?.[m[3]] : b[m[3]];
    if (current !== undefined && current !== null && current !== '') continue;
    if (paths.includes(issue.path)) continue;
    paths.push(issue.path);
    lineNumbers.push(m[2] !== undefined ? Number(m[2]) + 1 : null);
  }
  if (!paths.length) return [];
  const vendorId = typeof b.vendorId === 'string' && UUID_RE.test(b.vendorId) ? b.vendorId : null;
  const account = await defaultAccountFor(ctx, kind, { vendorId, purpose: opts.purpose });
  return missingAccountFixes({ paths, account, lineNumbers });
}
