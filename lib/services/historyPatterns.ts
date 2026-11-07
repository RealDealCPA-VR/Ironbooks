/**
 * Payee → account patterns mined from imported QuickBooks history (lib/services/qbGlImport.ts
 * posts each GL transaction as a journal entry with sourceRef 'qbgl:…').
 *
 * Years of a bookkeeper's choices sit in that history: "Shell Oil" went to Fuel 140 times,
 * "Verizon" to Telephone. Two consumers turn that into automation the moment the import is done:
 *  - bank rules: lib/services/bankRules.ts ruleOffers lists these as "Your QuickBooks history
 *    put SHELL OIL under Fuel 140 times. Always categorize it that way?" (one click → a rule);
 *  - the learned categorizer: lib/services/aiCategorizer.ts trains on them like on the person's
 *    own categorizations, so new bank-feed lines are suggested from day one.
 *
 * Only plain two-line transactions count (one bank / credit-card line, one category line that
 * is not A/R or A/P): checks, charges, deposits, transfers between a bank and a category. The
 * payee is the line's name (vendor / customer) when the import kept one, else the memo of the
 * transaction (QuickBooks' Name / Memo columns).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { bankAccounts, customers, vendors } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { patternOf } from '@/lib/bankRules/core';
import type { ServiceContext } from './_base';

const MONEY_SUBTYPES = new Set(['checking', 'savings', 'credit_card']);
const CONTROL_SUBTYPES = new Set(['accounts_receivable', 'accounts_payable']);

export interface HistoryPattern {
  entryId: string;
  createdAt: Date;
  /** The payee as the person would write it (vendor / customer name, else the memo). */
  payee: string;
  /** Normalized pattern (lib/bankRules/core patternOf), the key rules match on. */
  pattern: string;
  memo: string | null;
  /** Bank-side amount: negative = money out. */
  amount: string;
  direction: 'in' | 'out';
  accountId: string;
  classId: string | null;
  /** The bank account (bank_accounts.id) the money line belongs to, '' when none is set up. */
  bankAccountId: string;
}

interface LineRow {
  entryId: string;
  description: string | null;
  createdAt: Date;
  accountId: string;
  subtype: string | null;
  debit: string | null;
  credit: string | null;
  entityType: string | null;
  entityId: string | null;
  memo: string | null;
  classId: string | null;
}

/** Every two-line imported transaction as a (payee → account) observation, oldest first. */
export async function glHistoryPatterns(ctx: ServiceContext, opts: { since?: Date | null } = {}): Promise<HistoryPattern[]> {
  const since = opts.since ?? null;
  const rows = (
    await ctx.db.execute(sql`
      SELECT je.id AS entry_id, je.description, je.created_at,
             jel.account_id, a.subtype, jel.debit, jel.credit, jel.entity_type, jel.entity_id, jel.memo, jel.class_id
      FROM journal_entries je
      JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN accounts a ON a.id = jel.account_id
      WHERE je.company_id = ${ctx.companyId}
        AND je.status = 'posted'
        AND je.source_ref LIKE 'qbgl:%'
        ${since ? sql`AND je.created_at > ${since}` : sql``}
        AND (SELECT count(*) FROM journal_entry_lines x WHERE x.journal_entry_id = je.id) = 2
      ORDER BY je.created_at, je.id, jel.created_at, jel.id
    `)
  ).rows as unknown as Array<Record<string, unknown>>;
  const lines: LineRow[] = rows.map((r) => ({
    entryId: String(r.entry_id),
    description: (r.description as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    accountId: String(r.account_id),
    subtype: (r.subtype as string | null) ?? null,
    debit: (r.debit as string | null) ?? null,
    credit: (r.credit as string | null) ?? null,
    entityType: (r.entity_type as string | null) ?? null,
    entityId: (r.entity_id as string | null) ?? null,
    memo: (r.memo as string | null) ?? null,
    classId: (r.class_id as string | null) ?? null,
  }));
  if (lines.length === 0) return [];

  // Names of the vendors / customers the lines point at (one query each).
  const vendorIds = [...new Set(lines.filter((l) => l.entityType === 'vendor' && l.entityId).map((l) => l.entityId!))];
  const customerIds = [...new Set(lines.filter((l) => l.entityType === 'customer' && l.entityId).map((l) => l.entityId!))];
  const names = new Map<string, string>();
  for (let i = 0; i < vendorIds.length; i += 500) {
    const chunk = vendorIds.slice(i, i + 500);
    for (const v of await ctx.db.select({ id: vendors.id, name: vendors.displayName }).from(vendors).where(and(eq(vendors.companyId, ctx.companyId), inArray(vendors.id, chunk)))) {
      names.set(v.id, v.name);
    }
  }
  for (let i = 0; i < customerIds.length; i += 500) {
    const chunk = customerIds.slice(i, i + 500);
    for (const c of await ctx.db.select({ id: customers.id, name: customers.displayName }).from(customers).where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, chunk)))) {
      names.set(c.id, c.name);
    }
  }
  const bankByAccount = new Map(
    (await ctx.db.select({ id: bankAccounts.id, accountId: bankAccounts.accountId }).from(bankAccounts).where(eq(bankAccounts.companyId, ctx.companyId))).map((b) => [b.accountId, b.id]),
  );

  const byEntry = new Map<string, LineRow[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const out: HistoryPattern[] = [];
  for (const [entryId, ls] of byEntry) {
    if (ls.length !== 2) continue;
    const money = ls.find((l) => l.subtype && MONEY_SUBTYPES.has(l.subtype));
    const cat = ls.find((l) => l !== money);
    if (!money || !cat) continue;
    if (!cat.subtype || MONEY_SUBTYPES.has(cat.subtype) || CONTROL_SUBTYPES.has(cat.subtype)) continue;
    // Bank-side net: a debit to the bank is money in.
    const net = Money.sub(money.debit ?? '0', money.credit ?? '0');
    if (net.isZero()) continue;
    const inflow = !net.isNegative();
    const name = (cat.entityId && names.get(cat.entityId)) || (money.entityId && names.get(money.entityId)) || null;
    const payee = (name ?? cat.description ?? '').trim();
    if (!payee) continue;
    const pattern = patternOf({ description: payee });
    if (!pattern) continue;
    out.push({
      entryId,
      createdAt: cat.createdAt,
      payee,
      pattern,
      memo: cat.memo ?? cat.description,
      amount: net.toFixed(2),
      direction: inflow ? 'in' : 'out',
      accountId: cat.accountId,
      classId: cat.classId,
      bankAccountId: bankByAccount.get(money.accountId) ?? '',
    });
  }
  return out;
}
