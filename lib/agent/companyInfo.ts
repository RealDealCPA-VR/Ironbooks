/**
 * The facts about a company an agent starts from (GET /api/agent/whoami, AGENT_ACCESS.md).
 *
 * A projection, on purpose. The company row's `settings` also holds the network policy, the
 * password rules and other things an agent has no use for; this picks what a bookkeeper needs to
 * read the books correctly and nothing else.
 */
import { resolveCompanyPreferences } from '@/lib/preferences';
import { APP_VERSION } from '@/lib/appVersion';
import { AGENT_PRESET_LABELS, RISK_CLASSES, type AgentPreset, type RiskClass } from '@/lib/agent/operations/types';
import { and, eq } from 'drizzle-orm';
import { agentPolicies, agents } from '@/lib/db/schema';
import { resolvePolicy } from '@/lib/agent/policy';
import type { PolicyOverride } from '@/lib/agent/operations/types';
import { type ServiceContext, notFound } from '@/lib/services/_base';
import { listRoleDefinitions } from '@/lib/services/access';
import { getCompany } from '@/lib/services/company';
import { homeCode } from '@/lib/services/fxLines';
import { companyToday } from '@/lib/services/salesDates';

export interface AgentCompanyInfo {
  agent: null | {
    name: string;
    /** The settings an Admin gave it (Users & Roles > Agents), by name. */
    preset: AgentPreset | null;
    presetLabel: string | null;
    /** In one sentence: what it does on its own and what it asks a person for. */
    summary: string;
    /** The kinds of work (risk classes) it does on its own, asks a person for, and may never do. */
    doesAlone: RiskClass[];
    asksFor: RiskClass[];
    never: RiskClass[];
    paused: boolean;
    roles: string[];
    /** Where the full detail is: per area, limits, standing permissions. */
    detail: 'get_my_permissions';
  };
  company: {
    name: string;
    /** 'MM-DD': the last day of the fiscal year. */
    fiscalYearEnd: string;
    reportBasis: 'accrual' | 'cash';
    /** ISO code, or null when the currency list leaves it undecided. */
    homeCurrency: string | null;
    /** 'YYYY-MM-DD' or null. Nothing posts on or before it without the closing-date password. */
    closingDate: string | null;
    timeZone: string;
    /** Today's date in the company's time zone, 'YYYY-MM-DD'. */
    today: string;
    agingFrom: 'due_date' | 'transaction_date';
    features: {
      accountNumbers: boolean;
      classTracking: boolean;
      inventory: boolean;
      salesTax: boolean;
      payroll: boolean;
      multiCurrency: boolean;
    };
  };
  app: { name: 'Ironbooks'; version: string };
}

export async function agentCompanyInfo(ctx: ServiceContext): Promise<AgentCompanyInfo> {
  const row = await getCompany(ctx);
  if (!row) throw notFound('Company');
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const prefs = resolveCompanyPreferences(settings);
  let roles: string[] = [];
  if (ctx.agent && ctx.access) {
    const names = new Map((await listRoleDefinitions(ctx.db, ctx.companyId)).map((r) => [r.key, r.name]));
    roles = ctx.access.roleKeys.map((k) => names.get(k)).filter((n): n is string => Boolean(n));
  }
  return {
    agent: ctx.agent ? { name: ctx.agent.name, ...(await policyWords(ctx, ctx.agent.id)), roles, detail: 'get_my_permissions' as const } : null,
    company: {
      name: row.name,
      fiscalYearEnd: prefs.fiscalYearEnd,
      reportBasis: prefs.reportBasis,
      homeCurrency: await homeCode(ctx),
      closingDate: typeof settings.closingDate === 'string' ? settings.closingDate : null,
      timeZone: prefs.timezone,
      today: (await companyToday(ctx)).toISOString().slice(0, 10),
      agingFrom: prefs.agingFrom,
      features: {
        accountNumbers: prefs.accountNumbersEnabled !== false,
        classTracking: prefs.classTrackingEnabled !== false,
        inventory: prefs.inventoryEnabled !== false,
        salesTax: prefs.salesTaxEnabled !== false,
        payroll: prefs.payrollEnabled !== false,
        multiCurrency: prefs.multiCurrencyEnabled === true,
      },
    },
    app: { name: 'Ironbooks', version: APP_VERSION },
  };
}

/** Work that changes the books, in the words of the summary. */
const BOOK_CLASSES: readonly RiskClass[] = ['enter', 'change'];

/**
 * The agent's settings in plain words: its preset with the overrides an Admin saved, resolved as the
 * policy engine resolves them (lib/agent/policy.ts). Plain reads only: this answers on the agent's
 * read-only connection.
 */
async function policyWords(ctx: ServiceContext, agentId: string) {
  try {
    const [row] = await ctx.db
      .select({ preset: agents.preset, pausedAt: agents.pausedAt })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, ctx.companyId)));
    const preset = ((ctx.agent?.preset ?? row?.preset ?? 'ask_every_change') as AgentPreset);
    const saved = await ctx.db
      .select({ class: agentPolicies.class, area: agentPolicies.area, setting: agentPolicies.setting })
      .from(agentPolicies)
      .where(and(eq(agentPolicies.agentId, agentId), eq(agentPolicies.companyId, ctx.companyId)));
    const policy = { ...resolvePolicy(preset, saved as PolicyOverride[]), pausedAt: row?.pausedAt ? String(row.pausedAt) : null };
    const by = (setting: string) => RISK_CLASSES.filter((c) => policy.classes[c] === setting);
    const doesAlone = by('allow');
    const asksFor = by('ask');
    const never = by('never');
    const paused = Boolean(policy.pausedAt);
    const changesAlone = BOOK_CLASSES.every((c) => doesAlone.includes(c));
    const changesAsked = BOOK_CLASSES.some((c) => asksFor.includes(c));
    const summary = paused
      ? 'Paused: it can do nothing until a person turns it back on in Users & Roles > Agents.'
      : changesAlone
        ? 'It reads the books and enters and changes records on its own; it asks a person first for the other kinds of work its settings say to ask about.'
        : changesAsked
          ? 'It reads the books on its own and asks a person before entering or changing anything.'
          : 'It reads the books; it may not change them.';
    return { preset: policy.preset, presetLabel: AGENT_PRESET_LABELS[policy.preset] ?? null, summary, doesAlone, asksFor, never, paused };
  } catch {
    return { preset: null, presetLabel: null, summary: 'Its settings could not be read just now: get_my_permissions shows them.', doesAlone: [], asksFor: [], never: [], paused: false };
  }
}
