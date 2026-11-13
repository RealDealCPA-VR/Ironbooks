/**
 * "What the AI did" — the Home page's AI card (app/dashboard/page.tsx). One small read model:
 *  - whether an AI is connected (and whether it runs on this computer or in the cloud),
 *  - bank-feed lines the AI posted on its own in the last 7 days (auto-apply, each undoable),
 *  - bank-feed lines still waiting for review, and how many already carry a suggestion,
 *  - assistant proposals waiting for approval,
 *  - learned bank-rule offers (including ones from imported QuickBooks history),
 *  - today's cloud AI calls against the daily limit.
 * Every count links to the screen where the person finishes the job.
 */
import { and, count, eq, gte, isNotNull } from 'drizzle-orm';
import { aiAutoApplied, aiProposals, bankTransactions, journalEntries } from '@/lib/db/schema';
import { localityOf } from '@/lib/ai/providers';
import type { ServiceContext } from './_base';
import { cloudCallsToday, loadSettings } from './aiSettings';
import { ruleOffers } from './bankRules';

export interface AiActivity {
  /** 'none' = no AI connected; 'local' / 'cloud' = where the enabled models run (both → 'cloud'). */
  connected: 'none' | 'local' | 'cloud';
  autoApplyEnabled: boolean;
  autoPostedLast7Days: number;
  bankLinesToReview: number;
  bankLinesWithSuggestion: number;
  pendingProposals: number;
  ruleOffers: number;
  cloudCallsToday: number;
  cloudDailyCap: number;
}

export async function aiActivity(ctx: ServiceContext, now = new Date()): Promise<AiActivity> {
  const s = await loadSettings(ctx);
  const enabled = s.providers.filter((p) => p.enabled);
  const hasCloud = s.cloudEnabled && enabled.some((p) => localityOf(p) === 'cloud');
  const hasLocal = enabled.some((p) => localityOf(p) === 'local');
  const connected: AiActivity['connected'] = hasCloud ? 'cloud' : hasLocal ? 'local' : 'none';
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const open = and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.matched, false), eq(bankTransactions.excluded, false));
  const [[auto], [toReview], [suggested], [proposals], offers, calls] = await Promise.all([
    ctx.db
      .select({ n: count() })
      .from(aiAutoApplied)
      .innerJoin(journalEntries, eq(journalEntries.id, aiAutoApplied.journalEntryId))
      .where(and(eq(aiAutoApplied.companyId, ctx.companyId), gte(aiAutoApplied.createdAt, weekAgo), eq(journalEntries.status, 'posted'))),
    ctx.db.select({ n: count() }).from(bankTransactions).where(open),
    ctx.db.select({ n: count() }).from(bankTransactions).where(and(open, isNotNull(bankTransactions.suggestedAccountId))),
    ctx.db.select({ n: count() }).from(aiProposals).where(and(eq(aiProposals.companyId, ctx.companyId), eq(aiProposals.status, 'pending'))),
    ruleOffers(ctx).catch(() => []),
    cloudCallsToday(ctx),
  ]);
  return {
    connected,
    autoApplyEnabled: s.autoApplyEnabled,
    autoPostedLast7Days: Number(auto?.n ?? 0),
    bankLinesToReview: Number(toReview?.n ?? 0),
    bankLinesWithSuggestion: Number(suggested?.n ?? 0),
    pendingProposals: Number(proposals?.n ?? 0),
    ruleOffers: offers.length,
    cloudCallsToday: calls,
    cloudDailyCap: s.cloudDailyCap,
  };
}
