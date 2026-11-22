/**
 * Built-in demo bank feed. Lets the banking/reconciliation workflow be exercised end-to-end with
 * no external provider (real bank data comes in from imported statement files).
 * Inserts a set of realistic sample transactions into the bank_transactions staging table,
 * deduped by a stable fitId so repeated loads don't duplicate.
 *
 * Every line it adds gets an audit row, in the same transaction as the insert: the audit trail
 * shows what came in, and an agent's preview of the load (lib/agent/bridge.ts reads a dry run's
 * audit rows) shows the lines it would add instead of nothing.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { bankTransactions, bankAccounts } from '@/lib/db/schema';
import { type ServiceContext, inTransaction, notFound, writeAudit } from './_base';
import { applyRules } from './rules';

const SAMPLE: Array<{ id: string; days: number; desc: string; payee: string; amount: string }> = [
  { id: 'demo-001', days: 2, desc: 'STRIPE TRANSFER', payee: 'Stripe', amount: '2450.00' },
  { id: 'demo-002', days: 3, desc: 'AMAZON WEB SERVICES', payee: 'AWS', amount: '-318.55' },
  { id: 'demo-003', days: 5, desc: 'OFFICE DEPOT #1123', payee: 'Office Depot', amount: '-86.20' },
  { id: 'demo-004', days: 6, desc: 'CUSTOMER PMT - GLOBEX', payee: 'Globex', amount: '1200.00' },
  { id: 'demo-005', days: 8, desc: 'COMCAST BUSINESS', payee: 'Comcast', amount: '-149.99' },
  { id: 'demo-006', days: 10, desc: 'UNITED AIRLINES', payee: 'United', amount: '-512.40' },
  { id: 'demo-007', days: 12, desc: 'STARBUCKS', payee: 'Starbucks', amount: '-14.75' },
  { id: 'demo-008', days: 14, desc: 'PAYROLL ADP', payee: 'ADP', amount: '-3850.00' },
];

export async function loadDemoFeed(
  ctx: ServiceContext,
  bankAccountId: string,
  now: Date = new Date(),
) {
  const [bank] = await ctx.db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)));
  if (!bank) throw notFound('Bank account');

  const ids = SAMPLE.map((s) => `${bankAccountId}:${s.id}`);
  // The duplicate check, the inserts and their audit rows in one transaction: two loads at once
  // cannot both read "not there yet", and a line is never staged without its audit row.
  const imported = await inTransaction(ctx, async (tx) => {
    const existing = await tx.db
      .select({ fitId: bankTransactions.fitId })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.bankAccountId, bankAccountId), inArray(bankTransactions.fitId, ids)));
    const seen = new Set(existing.map((e) => e.fitId));

    let count = 0;
    for (const s of SAMPLE) {
      const fitId = `${bankAccountId}:${s.id}`;
      if (seen.has(fitId)) continue;
      const date = new Date(now.getTime() - s.days * 24 * 60 * 60 * 1000);
      // In a savepoint: a rule lookup that fails leaves no suggestion, as before, and does not
      // spoil the transaction the remaining lines go into.
      const suggested = await inTransaction(tx, (sp) =>
        applyRules(sp, { description: s.desc, payee: s.payee, amount: s.amount, bankAccountId }),
      ).catch(() => null);
      const [row] = await tx.db
        .insert(bankTransactions)
        .values({
          companyId: tx.companyId,
          bankAccountId,
          fitId,
          date,
          description: s.desc,
          payee: s.payee,
          amount: s.amount,
          matched: false,
          suggestedAccountId: suggested ?? null,
        })
        .returning({ id: bankTransactions.id });
      await writeAudit(tx, {
        action: 'create',
        entityType: 'bank_transaction',
        entityId: row.id,
        newValues: {
          source: 'demo_feed',
          bankAccountId,
          fitId,
          date: date.toISOString(),
          description: s.desc,
          payee: s.payee,
          amount: s.amount,
          suggestedAccountId: suggested ?? null,
        },
      });
      count += 1;
    }
    return count;
  });
  return { imported, total: SAMPLE.length, skipped: SAMPLE.length - imported };
}
