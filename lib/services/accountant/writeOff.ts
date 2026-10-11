/**
 * Write Off Invoices (QB Client Data Review → Write Off Invoices) — wave2 accountant, I4.
 *
 * Select open invoices (by age / customer / maximum balance) and write the remaining balance off
 * to a bad-debt expense account. Each write-off is a real credit memo (Dr Bad Debt / Cr A/R,
 * through the normal credit-memo service and postJournalEntry) applied to the invoice, so the
 * customer's open balance, A/R aging and the A/R control account all agree, and the write-off is
 * visible (and voidable) like any other document. Closing date / closed periods are enforced by
 * the posting engine; the whole batch is one transaction (all or nothing) and is audited.
 *
 * The balance is written off without reducing sales tax (QB's default write-off also leaves the
 * tax owed; use a Sales Tax Adjustment for bad-debt tax relief where the state allows it).
 */
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { accounts, customers, invoices } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from '../_base';
import { applyToInvoice, createCreditMemo } from '../creditMemos';

export interface WriteOffCandidate {
  invoiceId: string;
  invoiceNumber: number;
  customerId: string;
  customerName: string;
  date: string;
  dueDate: string | null;
  total: string;
  balanceDue: string;
  daysPastDue: number;
  foreignCurrency: boolean;
}

export async function listWriteOffCandidates(
  ctx: ServiceContext,
  filter: { asOf?: Date; minDaysPastDue?: number; maxBalance?: string | number | null; customerId?: string | null } = {},
): Promise<WriteOffCandidate[]> {
  const asOf = filter.asOf ?? new Date();
  const conds = [
    eq(invoices.companyId, ctx.companyId),
    sql`${invoices.status} NOT IN ('void', 'draft', 'paid')`,
    gt(invoices.balanceDue, '0'),
    lte(invoices.date, asOf),
  ];
  if (filter.customerId) conds.push(eq(invoices.customerId, filter.customerId));
  if (filter.maxBalance != null && filter.maxBalance !== '') {
    conds.push(lte(invoices.balanceDue, toAmountString(filter.maxBalance)));
  }
  const rows = await ctx.db
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      customerId: invoices.customerId,
      customerName: customers.displayName,
      date: invoices.date,
      dueDate: invoices.dueDate,
      total: invoices.total,
      balanceDue: invoices.balanceDue,
      currency: invoices.currency,
      exchangeRate: invoices.exchangeRate,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(...conds))
    .orderBy(invoices.date);
  const day = 86_400_000;
  return rows
    .map((r) => {
      const due = r.dueDate ?? r.date;
      return {
        invoiceId: r.id,
        invoiceNumber: r.invoiceNumber,
        customerId: r.customerId,
        customerName: r.customerName,
        date: r.date.toISOString(),
        dueDate: r.dueDate ? r.dueDate.toISOString() : null,
        total: toAmountString(r.total),
        balanceDue: toAmountString(r.balanceDue),
        daysPastDue: Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / day)),
        foreignCurrency: r.exchangeRate != null && !Money.eq(r.exchangeRate, 1),
      };
    })
    .filter((r) => r.daysPastDue >= (filter.minDaysPastDue ?? 0));
}

export interface WriteOffInput {
  invoiceIds: string[];
  date: Date;
  badDebtAccountId: string;
  memo?: string | null;
}

export interface WriteOffResult {
  invoiceId: string;
  invoiceNumber: number;
  amount: string;
  creditMemoId: string;
}

/** Write off the open balance of each selected invoice (all-or-nothing). */
export async function writeOffInvoices(
  ctx: ServiceContext,
  input: WriteOffInput,
): Promise<{ results: WriteOffResult[]; total: string }> {
  const ids = [...new Set(input.invoiceIds ?? [])];
  if (ids.length === 0) throw validation('Select at least one invoice to write off.');
  if (ids.length > 500) throw validation('Write off at most 500 invoices at a time.');
  if (!(input.date instanceof Date) || Number.isNaN(input.date.getTime())) throw validation('A valid date is required.');

  const [acct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.badDebtAccountId)));
  if (!acct) throw notFound('Bad debt account');
  if (acct.type !== 'expense') throw validation('Choose an expense account (for example "Bad Debt") for write-offs.');

  return inTransaction(ctx, async (tx) => {
    const rows = await tx.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.companyId, tx.companyId), inArray(invoices.id, ids)));
    if (rows.length !== ids.length) throw notFound('One or more invoices');
    const results: WriteOffResult[] = [];
    let total = Money.zero();
    for (const inv of rows.sort((a, b) => a.invoiceNumber - b.invoiceNumber)) {
      if (inv.status === 'void' || inv.status === 'draft') {
        throw new ServiceError('CONFLICT', `Invoice #${inv.invoiceNumber} is ${inv.status} and cannot be written off.`);
      }
      const balance = Money.round2(inv.balanceDue);
      if (!balance.greaterThan(0)) {
        throw new ServiceError('CONFLICT', `Invoice #${inv.invoiceNumber} has no open balance.`);
      }
      if (inv.exchangeRate != null && !Money.eq(inv.exchangeRate, 1)) {
        throw validation(`Invoice #${inv.invoiceNumber} is in a foreign currency — write it off with a credit memo in that currency.`);
      }
      if (input.date < inv.date) {
        throw validation(`The write-off date is before invoice #${inv.invoiceNumber}'s date.`);
      }
      const memo = await createCreditMemo(tx, {
        customerId: inv.customerId,
        date: input.date,
        memo: input.memo?.trim() || `Write-off of invoice #${inv.invoiceNumber} (bad debt)`,
        lines: [
          {
            description: `Bad debt write-off — invoice #${inv.invoiceNumber}`,
            quantity: 1,
            rate: toAmountString(balance),
            accountId: acct.id,
            taxable: false,
          },
        ],
      });
      await applyToInvoice(tx, { creditMemoId: memo.id, invoiceId: inv.id, amount: toAmountString(balance) });
      results.push({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: toAmountString(balance), creditMemoId: memo.id });
      total = total.plus(balance);
    }
    await writeAudit(tx, {
      action: 'create',
      entityType: 'invoice_write_off',
      entityId: randomUUID(),
      newValues: {
        date: input.date.toISOString().slice(0, 10),
        badDebtAccountId: acct.id,
        badDebtAccount: acct.name,
        total: toAmountString(total),
        invoices: results,
      },
    });
    return { results, total: toAmountString(total) };
  });
}
