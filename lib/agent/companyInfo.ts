/**
 * The facts about a company an agent starts from (GET /api/agent/whoami, AGENT_ACCESS.md).
 *
 * A projection, on purpose. The company row's `settings` also holds the network policy, the
 * password rules and other things an agent has no use for; this picks what a bookkeeper needs to
 * read the books correctly and nothing else.
 */
import { resolveCompanyPreferences } from '@/lib/preferences';
import { APP_VERSION } from '@/lib/appVersion';
import { AGENT_MODE_LABELS, agentMayPropose, agentMayWrite } from '@/lib/permissions/agentAccess';
import { type ServiceContext, notFound } from '@/lib/services/_base';
import { listRoleDefinitions } from '@/lib/services/access';
import { getCompany } from '@/lib/services/company';
import { homeCode } from '@/lib/services/fxLines';
import { companyToday } from '@/lib/services/salesDates';

export interface AgentCompanyInfo {
  agent: null | {
    name: string;
    mode: string;
    modeLabel: string;
    /** Post: the agent enters changes itself. */
    canChangeBooks: boolean;
    /** Propose or Post: the agent may ask for changes (entered at once, or after a person approves). */
    canProposeChanges: boolean;
    roles: string[];
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
    agent: ctx.agent
      ? {
          name: ctx.agent.name,
          mode: ctx.agent.mode,
          modeLabel: AGENT_MODE_LABELS[ctx.agent.mode],
          canChangeBooks: agentMayWrite(ctx.agent.mode),
          canProposeChanges: agentMayPropose(ctx.agent.mode),
          roles,
        }
      : null,
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
