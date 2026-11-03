/**
 * System accounts by ROLE instead of by number (review round 5 leftover, purchases -> ledger /
 * imports).
 *
 * The posting services find the accounts they post to on their own by number: Accounts Payable
 * 2000, Inventory Asset 1300, Cost of Goods Sold 5000, Sales Tax Payable 2200 and Payroll
 * Liabilities 2300. On Ironbooks' own chart those numbers are right. A chart converted from
 * QuickBooks numbers accounts its own way, so "whatever account holds 2000" could be a loan, and
 * a QuickBooks A/P account ("A/P - Trade", 20000) that holds the converted balances was never
 * used by new bills.
 *
 * Each role now resolves, in this order:
 *   1. the account the company chose for the role (Company > System Accounts, stored in
 *      companies.settings.accountRoles; for Payroll Liabilities the Payroll preference
 *      payrollLiabilityAccountId is that choice), when it is an active account of the right kind;
 *   2. the account numbered with the role's usual number, when it IS that kind of account
 *      (Ironbooks' own chart: nothing changes);
 *   3. the one active account that is clearly that kind (by account type, or by name for the
 *      liabilities whose type is just "Other Current Liability"), preferring the usual name;
 *   4. the account with the usual number even though it is another kind (older behaviour, so a
 *      file that worked before keeps working) — the System Accounts page flags it;
 *   5. otherwise NOT_FOUND, as before.
 *
 * Every service that posts to or reads one of these accounts goes through
 * systemAccountIdByCode / resolveSystemAccount, so bills and bill payments (or invoices and the
 * sales tax engine) can never disagree about which account the role is. Changing a role's account
 * is refused while the account it resolves to now still carries a balance (the open items would
 * stay behind on the old account).
 *
 * No other service is imported here (the posting services import this module).
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts, companies } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { requirePermission } from './access';

export type AccountRole =
  | 'accounts_payable'
  | 'inventory_asset'
  | 'cost_of_goods_sold'
  | 'sales_tax_payable'
  | 'payroll_liabilities';

interface AccountShape {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive: boolean;
  balance: string;
}

interface RoleDef {
  code: string;
  label: string;
  /** Plain-language description of what Ironbooks posts there. */
  usedFor: string;
  /** Is this account the right KIND for the role? */
  fits: (a: Pick<AccountShape, 'type' | 'subtype' | 'name' | 'code'>) => boolean;
  /** Is it clearly the role's account (used to pick among several that fit)? */
  named: (a: Pick<AccountShape, 'name'>) => boolean;
  /** True when a candidate can be found by its kind alone (distinct subtype). */
  byKind: boolean;
}

const lc = (s: string) => s.trim().toLowerCase();
const OTHER_LIABILITY = (a: { type: string; subtype: string }) =>
  a.type === 'liability' && a.subtype !== 'accounts_payable' && a.subtype !== 'credit_card' && a.subtype !== 'non_posting';

export const ACCOUNT_ROLES: Record<AccountRole, RoleDef> = {
  accounts_payable: {
    code: '2000',
    label: 'Accounts Payable',
    usedFor: 'Bills, bill payments, bill credits and item receipts billed later',
    fits: (a) => a.type === 'liability' && a.subtype === 'accounts_payable',
    named: (a) => /^(accounts payable|a\/p)\b/i.test(a.name.trim()),
    byKind: true,
  },
  inventory_asset: {
    code: '1300',
    label: 'Inventory Asset',
    usedFor: 'The value of inventory items that have no inventory account of their own',
    // QuickBooks keeps Inventory Asset as an Other Current Asset; Ironbooks has an Inventory type.
    fits: (a) => a.type === 'asset' && (a.subtype === 'inventory' || (a.subtype === 'other_current_asset' && /inventory/i.test(a.name))),
    named: (a) => /^inventory( asset)?$/i.test(a.name.trim()),
    byKind: true,
  },
  cost_of_goods_sold: {
    code: '5000',
    label: 'Cost of Goods Sold',
    usedFor: 'The cost of inventory sold or returned, for items that have no COGS account of their own',
    fits: (a) => a.type === 'expense' && a.subtype === 'cost_of_goods_sold',
    named: (a) => /^(cost of goods sold|cogs)$/i.test(a.name.trim()),
    byKind: true,
  },
  sales_tax_payable: {
    code: '2200',
    label: 'Sales Tax Payable',
    usedFor: 'Sales tax charged on invoices, sales receipts and credit memos',
    fits: (a) => OTHER_LIABILITY(a),
    named: (a) => /sales tax payable/i.test(a.name),
    byKind: false,
  },
  payroll_liabilities: {
    code: '2300',
    label: 'Payroll Liabilities',
    usedFor: 'Taxes and deductions withheld from paychecks until you pay them',
    fits: (a) => OTHER_LIABILITY(a),
    named: (a) => /^payroll liabilit/i.test(a.name.trim()),
    byKind: false,
  },
};

export const ACCOUNT_ROLE_KEYS = Object.keys(ACCOUNT_ROLES) as AccountRole[];

/** Role for one of the system account numbers (null for any other number). */
export function roleForCode(code: string): AccountRole | null {
  for (const k of ACCOUNT_ROLE_KEYS) if (ACCOUNT_ROLES[k].code === code) return k;
  return null;
}

/** companies.settings key of the chosen accounts ({ [role]: accountId }). */
export const ACCOUNT_ROLES_KEY = 'accountRoles';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account chosen for each role in settings (payroll liabilities: the Payroll preference). */
function chosenIds(settings: unknown): Partial<Record<AccountRole, string>> {
  const s = (settings ?? {}) as Record<string, unknown>;
  const raw = (s[ACCOUNT_ROLES_KEY] ?? {}) as Record<string, unknown>;
  const out: Partial<Record<AccountRole, string>> = {};
  for (const k of ACCOUNT_ROLE_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && UUID_RE.test(v)) out[k] = v;
  }
  const pl = s.payrollLiabilityAccountId;
  if (!out.payroll_liabilities && typeof pl === 'string' && UUID_RE.test(pl)) out.payroll_liabilities = pl;
  return out;
}

export type RoleSource = 'chosen' | 'number' | 'detected' | 'number_other_kind' | 'missing';

export interface ResolvedRole {
  role: AccountRole;
  account: AccountShape | null;
  source: RoleSource;
}

async function loadAll(ctx: ServiceContext): Promise<{ rows: AccountShape[]; chosen: Partial<Record<AccountRole, string>> }> {
  const [co] = await ctx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, ctx.companyId));
  const rows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      isActive: accounts.isActive,
      balance: accounts.balance,
    })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return {
    rows: rows.map((r) => ({ ...r, type: String(r.type), subtype: String(r.subtype) })),
    chosen: chosenIds(co?.settings),
  };
}

function resolveFrom(role: AccountRole, rows: AccountShape[], chosen: Partial<Record<AccountRole, string>>): ResolvedRole {
  const def = ACCOUNT_ROLES[role];
  const pick = chosen[role] ? rows.find((r) => r.id === chosen[role]) : undefined;
  if (pick && pick.isActive && def.fits(pick)) return { role, account: pick, source: 'chosen' };
  const byNumber = rows.find((r) => r.code === def.code);
  if (byNumber && byNumber.isActive && def.fits(byNumber)) return { role, account: byNumber, source: 'number' };
  const fitting = rows.filter((r) => r.isActive && def.fits(r) && (def.byKind || def.named(r)));
  if (fitting.length > 0) {
    const named = fitting.filter((r) => def.named(r));
    const pool = named.length ? named : fitting;
    const best = [...pool].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))[0];
    return { role, account: best, source: 'detected' };
  }
  if (byNumber) return { role, account: byNumber, source: 'number_other_kind' };
  return { role, account: null, source: 'missing' };
}

/** The account a role posts to now (see the module header for the order). */
export async function resolveSystemAccount(ctx: ServiceContext, role: AccountRole): Promise<ResolvedRole> {
  const def = ACCOUNT_ROLES[role];
  // Fast path (Ironbooks' own chart, nothing chosen): one query for the settings and the
  // numbered account together.
  const res = await ctx.db.execute(sql`
    SELECT a.id::text AS id, a.code, a.name, a.type::text AS type, a.subtype::text AS subtype,
           a.is_active AS "isActive", a.balance::text AS balance, c.settings AS settings
      FROM companies c
      LEFT JOIN accounts a ON a.company_id = c.id AND a.code = ${def.code}
     WHERE c.id = ${ctx.companyId}::uuid`);
  const row = (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
  if (row) {
    const chosen = chosenIds(row.settings);
    if (!chosen[role] && row.id) {
      const a = row as unknown as AccountShape;
      if (a.isActive && def.fits(a)) return { role, account: a, source: 'number' };
    }
  }
  const { rows, chosen } = await loadAll(ctx);
  return resolveFrom(role, rows, chosen);
}

/** Id of a role's account; NOT_FOUND (with the usual number in the message) when there is none. */
export async function systemAccountId(ctx: ServiceContext, role: AccountRole): Promise<string> {
  const r = await resolveSystemAccount(ctx, role);
  if (!r.account) throw notFound(`Account with code ${ACCOUNT_ROLES[role].code}`);
  return r.account.id;
}

/** Like systemAccountId but null when the company has no such account. */
export async function systemAccountIdOrNull(ctx: ServiceContext, role: AccountRole): Promise<string | null> {
  return (await resolveSystemAccount(ctx, role)).account?.id ?? null;
}

/**
 * What the posting services' accountIdByCode(ctx, code) helpers call: a system number resolves
 * by its role, any other number is looked up as before. Throws NOT_FOUND like they did.
 */
export async function systemAccountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const role = roleForCode(code);
  if (role) return systemAccountId(ctx, role);
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) throw notFound(`Account with code ${code}`);
  return row.id;
}

/** systemAccountIdByCode without the NOT_FOUND (null when there is no such account). */
export async function systemAccountIdByCodeOrNull(ctx: ServiceContext, code: string): Promise<string | null> {
  try {
    return await systemAccountIdByCode(ctx, code);
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

/**
 * Accounts the posting services find by their NUMBER: invoices / credit memos / receipts (1200
 * A/R, 4000 income fallback), payments and deposits (1050 Undeposited Funds), retainage (1250),
 * item receipts (2050 accrual), payroll (6500, 6510, and 1000 as the fallback bank), fiscal close
 * (3900 Retained Earnings), realized exchange gain/loss (6900) — plus the role numbers above.
 */
export const SYSTEM_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  '1000', '1050', '1200', '1250', '1300', '2000', '2050', '2200', '2300', '3900', '4000', '5000', '6500', '6510', '6900',
]);

/**
 * True when Ironbooks posts to this account on its own: one of the system numbers, or the account
 * a role resolves to (the converted chart's "20000 Accounts Payable"). Such an account must stay
 * active and must be the survivor of a merge.
 */
export async function isSystemAccount(ctx: ServiceContext, account: { id: string; code: string }): Promise<boolean> {
  if (SYSTEM_ACCOUNT_CODES.has(account.code)) return true;
  for (const id of (await systemAccountIds(ctx)).values()) if (id === account.id) return true;
  return false;
}

/** Every role's account id (only the roles that resolve), for readers that classify by role. */
export async function systemAccountIds(ctx: ServiceContext): Promise<Map<AccountRole, string>> {
  const { rows, chosen } = await loadAll(ctx);
  const out = new Map<AccountRole, string>();
  for (const k of ACCOUNT_ROLE_KEYS) {
    const r = resolveFrom(k, rows, chosen);
    if (r.account) out.set(k, r.account.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company > System Accounts (read + choose)
// ---------------------------------------------------------------------------

export interface AccountRoleRow {
  role: AccountRole;
  label: string;
  usedFor: string;
  usualNumber: string;
  account: { id: string; code: string; name: string; balance: string } | null;
  source: RoleSource;
  /** Active accounts of the right kind the role could use (with their balances). */
  candidates: Array<{ id: string; code: string; name: string; balance: string }>;
  /** Plain-language notes (several candidates, the usual number is another kind of account…). */
  notes: string[];
  /** The role's account can be changed now (its current account carries no balance). */
  canChange: boolean;
}

export async function listAccountRoles(ctx: ServiceContext): Promise<AccountRoleRow[]> {
  const { rows, chosen } = await loadAll(ctx);
  return ACCOUNT_ROLE_KEYS.map((role) => {
    const def = ACCOUNT_ROLES[role];
    const r = resolveFrom(role, rows, chosen);
    const candidates = rows
      .filter((a) => a.isActive && def.fits(a) && (def.byKind || def.named(a) || a.id === r.account?.id || a.code === def.code))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((a) => ({ id: a.id, code: a.code, name: a.name, balance: toAmountString(a.balance) }));
    const notes: string[] = [];
    const numbered = rows.find((a) => a.code === def.code);
    if (r.source === 'number_other_kind') {
      notes.push(
        `Account ${def.code} "${numbered?.name}" is not a ${def.label} account, but Ironbooks posts ${def.label.toLowerCase()} amounts there because no other account fits. Choose the right account.`,
      );
    }
    if (r.source === 'detected' && numbered) {
      notes.push(`Account ${def.code} "${numbered.name}" is another kind of account, so "${r.account!.name}" is used instead.`);
    }
    const withBalance = candidates.filter((c) => !Money.isZero(c.balance));
    if (withBalance.length > 0 && r.account && Money.isZero(r.account.balance) && withBalance.every((c) => c.id !== r.account!.id)) {
      notes.push(
        `"${withBalance[0].code} ${withBalance[0].name}" holds a balance (${withBalance[0].balance}) but new transactions post to "${r.account.code} ${r.account.name}". If it is your ${def.label} account from QuickBooks, choose it here.`,
      );
    }
    if (r.source === 'missing') notes.push(`There is no ${def.label} account. Add one in the Chart of Accounts or choose one here.`);
    return {
      role,
      label: def.label,
      usedFor: def.usedFor,
      usualNumber: def.code,
      account: r.account ? { id: r.account.id, code: r.account.code, name: r.account.name, balance: toAmountString(r.account.balance) } : null,
      source: r.source,
      candidates,
      notes,
      canChange: !r.account || Money.isZero(r.account.balance),
    };
  });
}

/**
 * Choose the account a role posts to (null = back to the automatic choice). Needs Company &
 * Preferences: modify. Refused while the account the role uses now still carries a balance
 * (bills, invoices, sales tax or withholdings already on it would stay behind there).
 */
export async function setAccountRole(ctx: ServiceContext, role: AccountRole, accountId: string | null): Promise<AccountRoleRow> {
  if (!ACCOUNT_ROLE_KEYS.includes(role)) throw validation('Unknown system account.');
  requirePermission(ctx, 'company.preferences', 'modify');
  const def = ACCOUNT_ROLES[role];
  await inTransaction(ctx, async (tx) => {
    const { rows, chosen } = await loadAll(tx);
    const current = resolveFrom(role, rows, chosen);
    let target: AccountShape | null = null;
    if (accountId) {
      if (!UUID_RE.test(accountId)) throw notFound('Account');
      target = rows.find((r) => r.id === accountId) ?? null;
      if (!target) throw notFound('Account');
      if (!target.isActive) throw validation(`"${target.name}" is inactive. Make it active first.`);
      if (!def.fits(target)) {
        throw validation(`"${target.code} ${target.name}" is not the right kind of account for ${def.label}.`);
      }
      // One account, one role: sales tax and payroll withholdings never share an account.
      for (const other of ACCOUNT_ROLE_KEYS) {
        if (other === role) continue;
        if (resolveFrom(other, rows, chosen).account?.id === target.id) {
          throw validation(`"${target.code} ${target.name}" is already your ${ACCOUNT_ROLES[other].label} account.`);
        }
      }
    }
    const withoutChoice = Object.fromEntries(Object.entries(chosen).filter(([k]) => k !== role)) as Partial<Record<AccountRole, string>>;
    const after = accountId ? target : resolveFrom(role, rows, withoutChoice).account;
    if (current.account && after?.id !== current.account.id && !Money.isZero(current.account.balance)) {
      throw new ServiceError(
        'CONFLICT',
        `${def.label} is "${current.account.code} ${current.account.name}" now, and it still has a balance of ${toAmountString(current.account.balance)}. ` +
          `Transactions already on it would stay behind there. Move or merge that balance first (Merge Accounts), then choose the new account.`,
      );
    }
    const [co] = await tx.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, tx.companyId));
    const settings = (co?.settings ?? {}) as Record<string, unknown>;
    const before = { ...((settings[ACCOUNT_ROLES_KEY] ?? {}) as Record<string, unknown>) };
    const map = { ...before };
    if (accountId) map[role] = accountId;
    else delete map[role];
    await tx.db
      .update(companies)
      .set({
        settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${ACCOUNT_ROLES_KEY}::text, ${JSON.stringify(map)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(companies.id, tx.companyId));
    // Payroll Liabilities' choice IS the Payroll preference: keep the two in step.
    if (role === 'payroll_liabilities') {
      await tx.db
        .update(companies)
        .set({
          settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('payrollLiabilityAccountId', ${accountId}::text)`,
        })
        .where(eq(companies.id, tx.companyId));
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'company',
      entityId: tx.companyId,
      oldValues: { [ACCOUNT_ROLES_KEY]: { [role]: current.account?.id ?? null } },
      newValues: { [ACCOUNT_ROLES_KEY]: { [role]: after?.id ?? null }, chosen: accountId ?? null },
    });
  });
  return (await listAccountRoles(ctx)).find((r) => r.role === role)!;
}
