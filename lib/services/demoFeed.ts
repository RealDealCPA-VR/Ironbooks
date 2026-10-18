/**
 * Built-in demo bank feed. Lets the banking/reconciliation workflow be exercised end-to-end with
 * no external provider (real bank data comes in from imported statement files).
 * Inserts a set of realistic sample transactions into the bank_transactions staging table,
 * deduped by a stable fitId so repeated loads don't duplicate.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { bankTransactions, bankAccounts } from '@/lib/db/schema';
import { type ServiceContext, notFound } from './_base';
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
  const existing = await ctx.db
    .select({ fitId: bankTransactions.fitId })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.bankAccountId, bankAccountId), inArray(bankTransactions.fitId, ids)));
  const seen = new Set(existing.map((e) => e.fitId));

  let imported = 0;
  for (const s of SAMPLE) {
    const fitId = `${bankAccountId}:${s.id}`;
    if (seen.has(fitId)) continue;
    const date = new Date(now.getTime() - s.days * 24 * 60 * 60 * 1000);
    const suggested = await applyRules(ctx, { description: s.desc, payee: s.payee, amount: s.amount, bankAccountId }).catch(
      () => null,
    );
    await ctx.db.insert(bankTransactions).values({
      companyId: ctx.companyId,
      bankAccountId,
      fitId,
      date,
      description: s.desc,
      payee: s.payee,
      amount: s.amount,
      matched: false,
      suggestedAccountId: suggested ?? null,
    });
    imported += 1;
  }
  return { imported, total: SAMPLE.length, skipped: SAMPLE.length - imported };
}
