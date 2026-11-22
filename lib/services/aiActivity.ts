/**
 * "What the AI did" — the Home page's AI card (app/dashboard/page.tsx). One small read model:
 *  - whether an AI is connected (and whether it runs on this computer or in the cloud),
 *  - bank-feed lines the AI posted on its own in the last 7 days (auto-apply, each undoable),
 *  - bank-feed lines still waiting for review, and how many already carry a suggestion,
 *  - the assistant's own proposals waiting for approval under Ask AI,
 *  - outside agents' requests waiting for this person in Agent requests,
 *  - learned bank-rule offers (including ones from imported QuickBooks history),
 *  - today's cloud AI calls against the daily limit.
 * Every count links to the screen where the person finishes the job.
 *
 * What an agent asks for is decided in Agent requests (app/agent-requests), never under Ask AI, so
 * it is not counted with the assistant's proposals: an old agent proposal (kind 'agent_action')
 * still in the proposals table is left out of that count. The agents' count is the title bar
 * badge's (lib/services/agentRequests.ts badgeForPerson): only what this person could approve, and
 * nothing for an agent or a context without a person.
 */
import { and, count, eq, gte, isNotNull, ne } from 'drizzle-orm';
import { aiAutoApplied, aiProposals, bankTransactions, journalEntries } from '@/lib/db/schema';
import { localityOf } from '@/lib/ai/providers';
import type { ServiceContext } from './_base';
import { cloudCallsToday, loadSettings } from './aiSettings';
import { ruleOffers } from './bankRules';

/** The proposals table's kind for what an outside agent asked for (lib/agent/actions.ts AGENT_PROPOSAL_KIND). */
const AGENT_PROPOSAL_KIND = 'agent_action';

export interface AiActivity {
  /** 'none' = no AI connected; 'local' / 'cloud' = where the enabled models run (both → 'cloud'). */
  connected: 'none' | 'local' | 'cloud';
  autoApplyEnabled: boolean;
  autoPostedLast7Days: number;
  bankLinesToReview: number;
  bankLinesWithSuggestion: number;
  /** The assistant's own proposals waiting under Ask AI (agents' are not among them). */
  pendingProposals: number;
  /** Agents' requests waiting in Agent requests that this person could approve (the title bar badge). */
  agentRequestsWaiting: number;
  ruleOffers: number;
  cloudCallsToday: number;
  cloudDailyCap: number;
}

export interface AiActivityOptions {
  /**
   * Whether the page is shown in the Ironbooks window on the computer that holds the company file,
   * as the title bar badge is told (app/api/agent-requests/_guards.ts atHostWindow): a teammate's
   * window does not count host-only work it could not approve there. Left out, it counts as true,
   * as the contract reads a left-out `atHost` (lib/agent/contract.ts ListRequestsForPerson) and as
   * pendingCountForPerson does. A caller that can tell (Home can, from its request's headers) passes
   * it, so Home and the title bar count the same requests.
   */
  atHost?: boolean;
}

/**
 * The badge's count, read alongside Home's other counts. The approval center's service is large,
 * so it is imported only here, when a person's count is asked for, not by every caller of this
 * module. It never fails Home: any error is "nothing waiting here".
 */
async function agentRequestsFor(ctx: ServiceContext, atHost: boolean): Promise<number> {
  if (ctx.agent || !ctx.userId) return 0;
  try {
    const { badgeForPerson } = await import('./agentRequests');
    return (await badgeForPerson(ctx, { atHost })).pending;
  } catch {
    return 0;
  }
}

export async function aiActivity(ctx: ServiceContext, now = new Date(), opts: AiActivityOptions = {}): Promise<AiActivity> {
  const s = await loadSettings(ctx);
  const enabled = s.providers.filter((p) => p.enabled);
  const hasCloud = s.cloudEnabled && enabled.some((p) => localityOf(p) === 'cloud');
  const hasLocal = enabled.some((p) => localityOf(p) === 'local');
  const connected: AiActivity['connected'] = hasCloud ? 'cloud' : hasLocal ? 'local' : 'none';
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const open = and(eq(bankTransactions.companyId, ctx.companyId), eq(bankTransactions.matched, false), eq(bankTransactions.excluded, false));
  const [[auto], [toReview], [suggested], [proposals], agentRequests, offers, calls] = await Promise.all([
    ctx.db
      .select({ n: count() })
      .from(aiAutoApplied)
      .innerJoin(journalEntries, eq(journalEntries.id, aiAutoApplied.journalEntryId))
      .where(and(eq(aiAutoApplied.companyId, ctx.companyId), gte(aiAutoApplied.createdAt, weekAgo), eq(journalEntries.status, 'posted'))),
    ctx.db.select({ n: count() }).from(bankTransactions).where(open),
    ctx.db.select({ n: count() }).from(bankTransactions).where(and(open, isNotNull(bankTransactions.suggestedAccountId))),
    ctx.db
      .select({ n: count() })
      .from(aiProposals)
      .where(and(eq(aiProposals.companyId, ctx.companyId), eq(aiProposals.status, 'pending'), ne(aiProposals.kind, AGENT_PROPOSAL_KIND))),
    agentRequestsFor(ctx, opts.atHost ?? true),
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
    agentRequestsWaiting: agentRequests,
    ruleOffers: offers.length,
    cloudCallsToday: calls,
    cloudDailyCap: s.cloudDailyCap,
  };
}
