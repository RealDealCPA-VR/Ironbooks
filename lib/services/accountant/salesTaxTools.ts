/**
 * Sales tax accountant tools (wave2 accountant):
 *
 *  - D8 Sales Tax Adjustment — QB "Adjust Sales Tax Due": reduce what is owed (vendor discount for
 *    paying on time, rounding) or increase it (penalty, interest). Posts a balanced entry through
 *    postJournalEntry against the agency's liability account (else 2200), stamped
 *    "sales_tax_adj:<agencyId>" so the liability engine attributes it to the agency.
 *
 *  - I2 Fix Incorrectly Recorded Sales Tax — finds sales-tax activity recorded outside Pay Sales
 *    Tax: (a) lines on a sales-tax liability account that no sales document / tax payment /
 *    adjustment explains (a check or journal entry written straight to Sales Tax Payable), and
 *    (b) checks / bills / journal entries that paid a tax agency but were posted to an expense
 *    account. Fixes:
 *      (a) linkSalesTaxLine — attribute the existing line to an agency as a payment, adjustment
 *          or collected tax (sales_tax_line_links; the posted line itself never changes);
 *      (b) reclassifySalesTaxPayment — post a correcting entry Dr agency liability / Cr the
 *          expense account, stamped "tax_agency:<id>", so the money counts as a tax payment.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  accounts,
  journalEntries,
  journalEntryLines,
  salesTaxLineLinks,
  taxAgencies,
  vendors,
  expenses,
  bills,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { controlAccountIds } from './reclassify';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from '../_base';
import { postJournalEntry, voidJournalEntry } from '../posting';
import { salesTaxActivity, salesTaxLiabilityAccounts, SALES_TAX_PAYABLE_CODE } from './salesTaxLedger';

async function loadAgency(ctx: ServiceContext, agencyId: string) {
  const [agency] = await ctx.db
    .select()
    .from(taxAgencies)
    .where(and(eq(taxAgencies.companyId, ctx.companyId), eq(taxAgencies.id, agencyId)));
  if (!agency) throw notFound('Tax agency');
  return agency;
}

/** The liability account an agency's activity posts to: its own account, else 2200. */
export async function agencyLiabilityAccountId(ctx: ServiceContext, agencyId: string): Promise<string> {
  const agency = await loadAgency(ctx, agencyId);
  if (agency.liabilityAccountId) return agency.liabilityAccountId;
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, SALES_TAX_PAYABLE_CODE)));
  if (!row) throw validation('Sales Tax Payable (2200) is missing from the chart of accounts.');
  return row.id;
}

// ---------------------------------------------------------------------------
// D8 — Sales Tax Adjustment
// ---------------------------------------------------------------------------

export const SALES_TAX_ADJUSTMENT_REASONS = ['discount', 'rounding', 'penalty', 'interest', 'other'] as const;
export type SalesTaxAdjustmentReason = (typeof SALES_TAX_ADJUSTMENT_REASONS)[number];

export interface SalesTaxAdjustmentInput {
  date: Date;
  agencyId: string;
  /** Positive amount. */
  amount: string | number;
  /** 'reduce' lowers what is owed (discount, rounding down); 'increase' raises it (penalty, interest). */
  direction: 'reduce' | 'increase';
  /** Income account (discount) or expense account (penalty/interest) on the other side. */
  adjustmentAccountId: string;
  reason: SalesTaxAdjustmentReason;
  memo?: string | null;
  reference?: string | null;
}

const REASON_LABEL: Record<SalesTaxAdjustmentReason, string> = {
  discount: 'discount',
  rounding: 'rounding',
  penalty: 'penalty',
  interest: 'interest',
  other: 'adjustment',
};

/**
 * Post a sales tax adjustment:
 *   reduce:   Dr agency liability   / Cr adjustment account
 *   increase: Dr adjustment account / Cr agency liability
 */
export async function createSalesTaxAdjustment(ctx: ServiceContext, input: SalesTaxAdjustmentInput) {
  let amt;
  try {
    amt = Money.round2(input.amount);
  } catch {
    throw validation('Adjustment amount is not a valid number.');
  }
  if (!amt.greaterThan(0)) throw validation('Adjustment amount must be greater than zero.');
  if (input.direction !== 'reduce' && input.direction !== 'increase') {
    throw validation("direction must be 'reduce' or 'increase'.");
  }
  if (!SALES_TAX_ADJUSTMENT_REASONS.includes(input.reason)) throw validation('Unknown adjustment reason.');

  const agency = await loadAgency(ctx, input.agencyId);
  const liabilityId = await agencyLiabilityAccountId(ctx, input.agencyId);
  const [adj] = await ctx.db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.adjustmentAccountId)));
  if (!adj) throw notFound('Adjustment account');
  const liabAccts = await salesTaxLiabilityAccounts(ctx);
  if (liabAccts.some((a) => a.id === adj.id)) {
    throw validation('Choose an income or expense account for the other side, not a sales tax liability account.');
  }
  // Sub-ledger control accounts (A/R, A/P, bank, credit card, inventory, payroll liabilities…) can only
  // move through their own documents — a bare journal line there would break the subledger tie-out.
  const control = await controlAccountIds(ctx);
  if (control.has(adj.id)) {
    throw validation(
      'Choose an income or expense account for the other side. Accounts like Accounts Receivable, Accounts Payable, bank, credit card, inventory or payroll accounts cannot be used here.',
    );
  }

  const amount = toAmountString(amt);
  const description =
    input.memo?.trim() || `Sales tax ${REASON_LABEL[input.reason]} — ${agency.name}`;
  const lines =
    input.direction === 'reduce'
      ? [
          { accountId: liabilityId, debit: amount, memo: `Sales tax ${REASON_LABEL[input.reason]}` },
          { accountId: adj.id, credit: amount, memo: description },
        ]
      : [
          { accountId: adj.id, debit: amount, memo: description },
          { accountId: liabilityId, credit: amount, memo: `Sales tax ${REASON_LABEL[input.reason]}` },
        ];

  return inTransaction(ctx, async (tx) => {
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description,
      reference: input.reference ?? null,
      sourceRef: `sales_tax_adj:${agency.id}`,
      lines,
    });
    await writeAudit(tx, {
      action: 'create',
      entityType: 'sales_tax_adjustment',
      entityId: entry.id,
      newValues: {
        agencyId: agency.id,
        agencyName: agency.name,
        amount,
        direction: input.direction,
        reason: input.reason,
        adjustmentAccountId: adj.id,
      },
    });
    return entry;
  });
}

// ---------------------------------------------------------------------------
// I2 — Fix Incorrectly Recorded Sales Tax
// ---------------------------------------------------------------------------

export interface MisrecordedTaxLine {
  /** 'liability_unattributed' = on a sales-tax account but not via a sales doc / Pay Sales Tax;
   *  'expense_payment' = a payment to a tax agency posted to an expense account;
   *  'orphaned_fix' = a "count as tax payment" correction whose original check/bill was voided
   *  afterwards (entryId = the correcting entry; undo it with undoOrphanedSalesTaxFix). */
  issue: 'liability_unattributed' | 'expense_payment' | 'orphaned_fix';
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: string;
  description: string;
  sourceRef: string | null;
  accountId: string;
  accountName: string;
  /** Debit − credit on the line (positive = paid out / reduced the liability). */
  amount: string;
  /** Best guess of the agency (payee name match), when any. */
  suggestedAgencyId: string | null;
  explanation: string;
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find sales tax that was recorded outside the sales-tax workflow. */
export async function findMisrecordedSalesTax(ctx: ServiceContext): Promise<MisrecordedTaxLine[]> {
  const agencies = await ctx.db
    .select({ id: taxAgencies.id, name: taxAgencies.name })
    .from(taxAgencies)
    .where(eq(taxAgencies.companyId, ctx.companyId));
  const guessAgency = (...texts: Array<string | null | undefined>): string | null => {
    const hay = texts.map(normalize).join(' ');
    const hit = agencies.find((a) => normalize(a.name) && hay.includes(normalize(a.name)));
    return hit?.id ?? (agencies.length === 1 ? agencies[0].id : null);
  };
  const acctRows = await ctx.db
    .select({ id: accounts.id, name: accounts.name, code: accounts.code, type: accounts.type })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const acctName = new Map(acctRows.map((a) => [a.id, `${a.code} · ${a.name}`]));

  const out: MisrecordedTaxLine[] = [];

  // (a) unattributed activity on the liability accounts
  const activity = await salesTaxActivity(ctx);
  for (const r of activity.filter((x) => x.kind === 'unattributed')) {
    const amount = Money.of(r.amount).negated();
    out.push({
      issue: 'liability_unattributed',
      lineId: r.lineId,
      entryId: r.entryId,
      entryNumber: r.entryNumber,
      date: r.date.toISOString(),
      description: r.description,
      sourceRef: r.sourceRef,
      accountId: r.accountId,
      accountName: acctName.get(r.accountId) ?? '',
      amount: toAmountString(amount),
      suggestedAgencyId: guessAgency(r.description, r.componentName),
      explanation: amount.greaterThan(0)
        ? 'Money was taken out of Sales Tax Payable without using Pay Sales Tax, so the agency balance does not show this payment.'
        : 'Sales tax was added to Sales Tax Payable without a sales form, so it is not tied to any agency.',
    });
  }

  // (b) payments to an agency (payee matches an agency name) posted to expense accounts.
  if (agencies.length) {
    const expenseIds = acctRows.filter((a) => a.type === 'expense').map((a) => a.id);
    if (expenseIds.length) {
      const rows = await ctx.db
        .select({
          lineId: journalEntryLines.id,
          accountId: journalEntryLines.accountId,
          debit: journalEntryLines.debit,
          credit: journalEntryLines.credit,
          memo: journalEntryLines.memo,
          entryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          date: journalEntries.date,
          description: journalEntries.description,
          sourceRef: journalEntries.sourceRef,
        })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .where(
          and(
            eq(journalEntries.companyId, ctx.companyId),
            eq(journalEntries.status, 'posted'),
            inArray(journalEntryLines.accountId, expenseIds),
            sql`${journalEntryLines.debit} > 0`,
          ),
        );
      // Payee names for checks and bills.
      const expRows = await ctx.db
        .select({ id: expenses.id, payee: expenses.payeeName, vendor: vendors.displayName })
        .from(expenses)
        .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
        .where(eq(expenses.companyId, ctx.companyId));
      const billRows = await ctx.db
        .select({ id: bills.id, vendor: vendors.displayName })
        .from(bills)
        .leftJoin(vendors, eq(bills.vendorId, vendors.id))
        .where(eq(bills.companyId, ctx.companyId));
      const payee = new Map<string, string>();
      for (const e of expRows) payee.set(`expense:${e.id}`, e.vendor ?? e.payee ?? '');
      for (const b of billRows) payee.set(`bill:${b.id}`, b.vendor ?? '');

      // Already corrected (a "tax_agency:" entry referencing this line exists)?
      const corrected = await ctx.db
        .select({ reference: journalEntries.reference })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.companyId, ctx.companyId),
            eq(journalEntries.status, 'posted'),
            sql`${journalEntries.sourceRef} LIKE 'tax_agency:%'`,
            sql`${journalEntries.reference} LIKE 'fix-line:%'`,
          ),
        );
      const fixed = new Set(corrected.map((c) => c.reference?.slice('fix-line:'.length)));

      for (const r of rows) {
        if (fixed.has(r.lineId)) continue;
        // Sales-tax workflow entries (payments, adjustments such as a penalty) are already right.
        if (r.sourceRef?.startsWith('tax_agency:') || r.sourceRef?.startsWith('sales_tax_adj:')) continue;
        const who = r.sourceRef ? payee.get(r.sourceRef) : undefined;
        const text = normalize(`${who ?? ''} ${r.description} ${r.memo ?? ''}`);
        const hit = agencies.find((a) => normalize(a.name) && text.includes(normalize(a.name)));
        if (!hit) continue;
        out.push({
          issue: 'expense_payment',
          lineId: r.lineId,
          entryId: r.entryId,
          entryNumber: r.entryNumber,
          date: r.date.toISOString(),
          description: r.description,
          sourceRef: r.sourceRef,
          accountId: r.accountId,
          accountName: acctName.get(r.accountId) ?? '',
          amount: toAmountString(Money.sub(r.debit ?? 0, r.credit ?? 0)),
          suggestedAgencyId: hit.id,
          explanation: `This looks like a payment to ${hit.name}, but it was recorded as an expense, so sales tax still shows as owed.`,
        });
      }
    }
  }
  // (c) correcting entries left behind after their original payment was voided.
  for (const o of await orphanedSalesTaxFixes(ctx)) {
    out.push({
      issue: 'orphaned_fix',
      lineId: o.lineId,
      entryId: o.entryId,
      entryNumber: o.entryNumber,
      date: o.date.toISOString(),
      description: o.description,
      sourceRef: o.sourceRef,
      accountId: o.accountId,
      accountName: acctName.get(o.accountId) ?? '',
      amount: o.amount,
      suggestedAgencyId: o.agencyId,
      explanation:
        'The payment this correction was made for has since been voided, so the correction now counts a tax payment that never happened. Undo the correction.',
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

interface OrphanedFix {
  entryId: string;
  entryNumber: number;
  date: Date;
  description: string;
  sourceRef: string | null;
  /** The liability (debit) line of the correcting entry. */
  lineId: string;
  accountId: string;
  amount: string;
  agencyId: string | null;
}

/** Posted "fix-line:<lineId>" correcting entries whose original line now sits on a voided entry. */
export async function orphanedSalesTaxFixes(ctx: ServiceContext): Promise<OrphanedFix[]> {
  const fixes = await ctx.db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      sourceRef: journalEntries.sourceRef,
      reference: journalEntries.reference,
    })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.sourceRef} LIKE 'tax_agency:%'`,
        sql`${journalEntries.reference} LIKE 'fix-line:%'`,
      ),
    );
  if (fixes.length === 0) return [];
  const refOf = (f: { reference: string | null }) => (f.reference ?? '').slice('fix-line:'.length);
  const originalIds = fixes.map(refOf).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (originalIds.length === 0) return [];
  const originals = await ctx.db
    .select({ lineId: journalEntryLines.id, status: journalEntries.status })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, ctx.companyId), inArray(journalEntryLines.id, originalIds)));
  const voided = new Set(originals.filter((o) => o.status === 'void').map((o) => o.lineId));
  const orphans = fixes.filter((f) => voided.has(refOf(f)));
  if (orphans.length === 0) return [];
  const lines = await ctx.db
    .select({
      id: journalEntryLines.id,
      entryId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
    })
    .from(journalEntryLines)
    .where(
      inArray(
        journalEntryLines.journalEntryId,
        orphans.map((o) => o.entryId),
      ),
    );
  return orphans.map((o) => {
    const dr = lines.find((l) => l.entryId === o.entryId && Money.of(l.debit ?? 0).greaterThan(0));
    return {
      entryId: o.entryId,
      entryNumber: o.entryNumber,
      date: o.date,
      description: o.description,
      sourceRef: o.sourceRef,
      lineId: dr?.id ?? o.entryId,
      accountId: dr?.accountId ?? '',
      amount: toAmountString(Money.of(dr?.debit ?? 0)),
      agencyId: o.sourceRef ? o.sourceRef.slice('tax_agency:'.length) : null,
    };
  });
}

/** Void one orphaned correcting entry (only entries orphanedSalesTaxFixes reports qualify). */
export async function undoOrphanedSalesTaxFix(ctx: ServiceContext, entryId: string) {
  const orphan = (await orphanedSalesTaxFixes(ctx)).find((o) => o.entryId === entryId);
  if (!orphan) {
    throw new ServiceError('CONFLICT', 'That correction is still needed because its original payment is not voided.');
  }
  return voidJournalEntry(ctx, entryId);
}

/**
 * Void every orphaned correcting entry (called after Batch Void). Best effort: an entry in a closed
 * period is left in place and keeps showing on the Fix Incorrectly Recorded Sales Tax screen.
 */
export async function voidOrphanedSalesTaxFixes(ctx: ServiceContext): Promise<number> {
  let n = 0;
  for (const o of await orphanedSalesTaxFixes(ctx)) {
    try {
      await voidJournalEntry(ctx, o.entryId);
      n++;
    } catch {
      // closed period or reconciled: surfaced on the Fix Incorrectly Recorded Sales Tax screen
    }
  }
  return n;
}

export interface LinkSalesTaxLineInput {
  lineId: string;
  agencyId: string;
  kind: 'payment' | 'adjustment' | 'collected';
  note?: string | null;
}

/** Attribute an existing liability-account line to an agency (the line itself is untouched). */
export async function linkSalesTaxLine(ctx: ServiceContext, input: LinkSalesTaxLineInput) {
  if (!['payment', 'adjustment', 'collected'].includes(input.kind)) {
    throw validation("kind must be 'payment', 'adjustment' or 'collected'.");
  }
  await loadAgency(ctx, input.agencyId);
  const liab = await salesTaxLiabilityAccounts(ctx);
  const [line] = await ctx.db
    .select({ id: journalEntryLines.id, accountId: journalEntryLines.accountId, status: journalEntries.status })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntryLines.id, input.lineId), eq(journalEntries.companyId, ctx.companyId)));
  if (!line) throw notFound('Journal line');
  if (!liab.some((a) => a.id === line.accountId)) {
    throw validation('Only lines on a sales tax liability account can be linked to an agency.');
  }
  if (line.status !== 'posted') throw new ServiceError('CONFLICT', 'That transaction is not posted.');

  return inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(salesTaxLineLinks)
      .where(eq(salesTaxLineLinks.journalEntryLineId, input.lineId));
    let row;
    if (existing) {
      [row] = await tx.db
        .update(salesTaxLineLinks)
        .set({ agencyId: input.agencyId, kind: input.kind, note: input.note ?? null })
        .where(eq(salesTaxLineLinks.id, existing.id))
        .returning();
    } else {
      [row] = await tx.db
        .insert(salesTaxLineLinks)
        .values({
          companyId: tx.companyId,
          journalEntryLineId: input.lineId,
          agencyId: input.agencyId,
          kind: input.kind,
          note: input.note ?? null,
          createdBy: tx.userId,
        })
        .returning();
    }
    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'sales_tax_line_link',
      entityId: row.id,
      oldValues: existing ? { agencyId: existing.agencyId, kind: existing.kind } : undefined,
      newValues: { lineId: input.lineId, agencyId: input.agencyId, kind: input.kind },
    });
    return row;
  });
}

/** Remove a Fix-Sales-Tax link (the line goes back to "needs review"). */
export async function unlinkSalesTaxLine(ctx: ServiceContext, lineId: string) {
  return inTransaction(ctx, async (tx) => {
    const [existing] = await tx.db
      .select()
      .from(salesTaxLineLinks)
      .where(and(eq(salesTaxLineLinks.journalEntryLineId, lineId), eq(salesTaxLineLinks.companyId, tx.companyId)));
    if (!existing) throw notFound('Sales tax link');
    await tx.db.delete(salesTaxLineLinks).where(eq(salesTaxLineLinks.id, existing.id));
    await writeAudit(tx, {
      action: 'delete',
      entityType: 'sales_tax_line_link',
      entityId: existing.id,
      oldValues: { lineId, agencyId: existing.agencyId, kind: existing.kind },
    });
    return { ok: true };
  });
}

/**
 * Turn an expense-coded agency payment into a sales tax payment: Dr agency liability /
 * Cr the expense account it was posted to, dated like the original. Original stays untouched
 * (it may be printed / reconciled); the correcting entry references it ("fix-line:<lineId>").
 */
export async function reclassifySalesTaxPayment(
  ctx: ServiceContext,
  input: { lineId: string; agencyId: string; date?: Date | null },
) {
  const agency = await loadAgency(ctx, input.agencyId);
  const [line] = await ctx.db
    .select({
      id: journalEntryLines.id,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      status: journalEntries.status,
      date: journalEntries.date,
      entryNumber: journalEntries.entryNumber,
      type: accounts.type,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(eq(journalEntryLines.id, input.lineId), eq(journalEntries.companyId, ctx.companyId)));
  if (!line) throw notFound('Journal line');
  if (line.status !== 'posted') throw new ServiceError('CONFLICT', 'That transaction is not posted.');
  if (line.type !== 'expense') throw validation('Only expense lines can be moved to sales tax.');
  const amount = Money.sub(line.debit ?? 0, line.credit ?? 0);
  if (!amount.greaterThan(0)) throw validation('Only payments (debits) can be moved to sales tax.');

  const [dup] = await ctx.db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntries.reference, `fix-line:${line.id}`),
      ),
    );
  if (dup) throw new ServiceError('CONFLICT', 'This payment has already been moved to sales tax.');

  const liabilityId = await agencyLiabilityAccountId(ctx, agency.id);
  const amt = toAmountString(amount);
  return inTransaction(ctx, async (tx) => {
    const entry = await postJournalEntry(tx, {
      date: input.date ?? line.date,
      description: `Fix sales tax: payment to ${agency.name} recorded as an expense (entry #${line.entryNumber})`,
      reference: `fix-line:${line.id}`,
      sourceRef: `tax_agency:${agency.id}`,
      lines: [
        { accountId: liabilityId, debit: amt, memo: 'Sales tax payment (reclassified)' },
        { accountId: line.accountId, credit: amt, memo: 'Moved to sales tax payable' },
      ],
    });
    await writeAudit(tx, {
      action: 'create',
      entityType: 'sales_tax_fix',
      entityId: entry.id,
      newValues: { fixedLineId: line.id, agencyId: agency.id, amount: amt },
    });
    return entry;
  });
}
