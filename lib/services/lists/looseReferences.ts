/**
 * References a list merge must re-point that are not foreign keys (repointForeignKeys only follows
 * those): ids inside JSON — memorized transactions, memorized reports, price rules, bank-rule
 * splits — and plain id columns with no constraint — a deposit line's "Received From", a filed
 * document, a bank rule's class, estimate lines' class, bank categorization history's class.
 *
 * Left behind, a recurring invoice kept naming the merged-away (inactive) customer and failed every
 * run, a saved report filtered on it showed nothing, a price rule stopped applying, re-saving a
 * deposit wrote the merged-away name back onto its journal line, and bank rules kept tagging the
 * merged-away class.
 *
 * Ids are UUIDs, so replacing one wherever it appears is exact (it can't match another value).
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  attachments,
  bankCategorizationHistory,
  depositLines,
  estimateLines,
  memorizedReports,
  priceRules,
  recurringTemplates,
  transactionRules,
} from '@/lib/db/schema';
import type { ServiceContext } from '../_base';

export async function repointLooseReferences(tx: ServiceContext, fromId: string, toId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const like = `%${fromId}%`;
  const swap = <T>(v: T): T => JSON.parse(JSON.stringify(v).split(fromId).join(toId)) as T;

  // JSON columns (company-scoped tables).
  const templates = await tx.db
    .select({ id: recurringTemplates.id, template: recurringTemplates.template })
    .from(recurringTemplates)
    .where(and(eq(recurringTemplates.companyId, tx.companyId), sql`${recurringTemplates.template}::text LIKE ${like}`));
  for (const t of templates) await tx.db.update(recurringTemplates).set({ template: swap(t.template) }).where(eq(recurringTemplates.id, t.id));
  counts.recurringTemplates = templates.length;

  const reports = await tx.db
    .select({ id: memorizedReports.id, config: memorizedReports.config })
    .from(memorizedReports)
    .where(and(eq(memorizedReports.companyId, tx.companyId), sql`${memorizedReports.config}::text LIKE ${like}`));
  for (const r of reports) await tx.db.update(memorizedReports).set({ config: swap(r.config) }).where(eq(memorizedReports.id, r.id));
  counts.memorizedReports = reports.length;

  const rules = await tx.db
    .select({ id: priceRules.id, conditions: priceRules.conditions })
    .from(priceRules)
    .where(and(eq(priceRules.companyId, tx.companyId), sql`${priceRules.conditions}::text LIKE ${like}`));
  for (const r of rules) await tx.db.update(priceRules).set({ conditions: swap(r.conditions) }).where(eq(priceRules.id, r.id));
  counts.priceRules = rules.length;

  const bankRules = await tx.db
    .select({ id: transactionRules.id, splits: transactionRules.splits })
    .from(transactionRules)
    .where(and(eq(transactionRules.companyId, tx.companyId), sql`${transactionRules.splits}::text LIKE ${like}`));
  for (const r of bankRules) await tx.db.update(transactionRules).set({ splits: swap(r.splits) }).where(eq(transactionRules.id, r.id));
  counts.bankRuleSplits = bankRules.length;

  // Plain id columns.
  counts.bankRuleClass = (
    await tx.db
      .update(transactionRules)
      .set({ setClassId: toId })
      .where(and(eq(transactionRules.companyId, tx.companyId), eq(transactionRules.setClassId, fromId)))
      .returning({ id: transactionRules.id })
  ).length;
  counts.bankHistoryClass = (
    await tx.db
      .update(bankCategorizationHistory)
      .set({ classId: toId })
      .where(and(eq(bankCategorizationHistory.companyId, tx.companyId), eq(bankCategorizationHistory.classId, fromId)))
      .returning({ id: bankCategorizationHistory.id })
  ).length;
  // Estimate lines carry no company id; the uuid was verified to be this company's.
  counts.estimateLineClass = (
    await tx.db.update(estimateLines).set({ classId: toId }).where(eq(estimateLines.classId, fromId)).returning({ id: estimateLines.id })
  ).length;
  counts.depositLineNames = (
    await tx.db.update(depositLines).set({ entityId: toId }).where(eq(depositLines.entityId, fromId)).returning({ id: depositLines.id })
  ).length;
  counts.attachments = (
    await tx.db
      .update(attachments)
      .set({ entityId: toId })
      .where(and(eq(attachments.companyId, tx.companyId), eq(attachments.entityId, fromId)))
      .returning({ id: attachments.id })
  ).length;
  return counts;
}
