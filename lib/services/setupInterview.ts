/**
 * EasyStep setup interview — server side. Applies the plan built by lib/onboarding.ts to the
 * ACTIVE company in one transaction:
 *   1. company name + settings / Preferences (through updateCompany: whitelist, account checks,
 *      audit row), so every yes/no answer really switches its feature on or off;
 *   2. interview-only facts (entity type, tax-year start month, start date, finished/skipped);
 *   3. the income-tax form for the entity type, and a tax line on every account that has none
 *      yet and fits a line of that form (QB maps the starter chart for you);
 *   4. industry + equity accounts (createAccount — no opening balances, so the books stay
 *      balanced).
 * Re-running is safe: accounts are deduped by name, tax lines already set are never replaced.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { companies } from '@/lib/db/schema';
import {
  BUSINESS_TYPES,
  ENTITY_TYPES,
  buildSetupPlan,
  isIsoDate,
  suggestTaxLine,
  type InterviewAnswers,
  type SetupPlan,
} from '@/lib/onboarding';
import { companySettingsSchema } from '@/lib/validation/company';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { getCompany, updateCompany } from './company';
import { hasForeignCurrencyData } from './multiCurrency';
import { createAccount, listAccounts, setIncomeTaxForm, updateAccount } from './accounts';

export type SetupInterviewStatus = 'done' | 'skipped';

/** companies.settings key holding the interview record. */
export const SETUP_INTERVIEW_KEY = 'setupInterview';

export interface SetupInterviewRecord {
  status: SetupInterviewStatus;
  at: string;
  entityType?: string;
  taxYearStartMonth?: number;
  startDate?: string | null;
}

const zMonth = z.number().int().min(1).max(12);
const zText = (max: number) => z.string().trim().max(max).optional();

export const setupInterviewSchema = z.object({
  businessType: z.enum(BUSINESS_TYPES.map((b) => b.value) as [string, ...string[]]),
  entityType: z.enum(ENTITY_TYPES.map((e) => e.value) as [string, ...string[]]).optional(),
  fiscalYearStartMonth: zMonth,
  taxYearStartMonth: zMonth.optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Start date must be a date like 2026-01-01')
    .refine((s) => isIsoDate(s), 'Start date is not a real calendar date (check the day and month)')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  reportBasis: z.enum(['accrual', 'cash']),
  salesTax: z.boolean(),
  inventory: z.boolean(),
  employees: z.boolean(),
  estimates: z.boolean().optional(),
  progressInvoicing: z.boolean().optional(),
  timeTracking: z.boolean().optional(),
  classTracking: z.boolean().optional(),
  multiCurrency: z.boolean().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter code like USD').optional(),
  company: z
    .object({
      name: zText(255),
      legalName: zText(255),
      ein: z
        .union([z.literal(''), z.string().trim().regex(/^\d{2}-?\d{7}$/, 'EIN must look like 12-3456789')])
        .optional(),
      addressLine1: zText(255),
      addressLine2: zText(255),
      city: zText(100),
      state: zText(50),
      zip: zText(20),
      country: zText(60),
      phone: zText(40),
      email: z.union([z.literal(''), z.string().trim().email('Email is not a valid email address')]).optional(),
    })
    .optional(),
});
export type SetupInterviewInput = z.infer<typeof setupInterviewSchema>;

export interface SetupInterviewResult {
  plan: SetupPlan;
  accountsAdded: number;
  taxLinesMapped: number;
}

/** The interview record for the active company (null when never run or skipped). */
export async function getSetupInterview(ctx: ServiceContext): Promise<SetupInterviewRecord | null> {
  const company = await getCompany(ctx);
  if (!company) throw notFound('company');
  const rec = (company.settings as Record<string, unknown> | null)?.[SETUP_INTERVIEW_KEY];
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  if (r.status !== 'done' && r.status !== 'skipped') return null;
  return r as unknown as SetupInterviewRecord;
}

async function saveRecord(ctx: ServiceContext, record: SetupInterviewRecord) {
  const before = await getSetupInterview(ctx);
  await ctx.db
    .update(companies)
    .set({
      settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object(${SETUP_INTERVIEW_KEY}::text, ${JSON.stringify(record)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, ctx.companyId));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'company',
    entityId: ctx.companyId,
    oldValues: { [SETUP_INTERVIEW_KEY]: before },
    newValues: { [SETUP_INTERVIEW_KEY]: record },
  });
}

/** Apply the interview answers to the active company. */
export async function applySetupInterview(
  ctx: ServiceContext,
  input: SetupInterviewInput,
): Promise<SetupInterviewResult> {
  const parsed = setupInterviewSchema.safeParse(input);
  if (!parsed.success) {
    throw validation(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const answers = parsed.data as InterviewAnswers;

  return inTransaction(ctx, async (tx) => {
    const existing = await listAccounts(tx, { includeInactive: true });
    const plan = buildSetupPlan(answers, existing);
    // Turning payroll on again keeps a pay period / standard week the company already chose.
    const current = ((await getCompany(tx))?.settings ?? {}) as Record<string, unknown>;
    for (const k of ['payrollPayPeriod', 'payrollStandardHours'] as const) {
      if (current[k] !== undefined && current[k] !== null) delete plan.settings[k];
    }
    if (plan.settings.payrollEnabled === true && plan.settings.payrollPayPeriod === undefined) {
      plan.summary = plan.summary.map((r) => (r.startsWith('Payroll: on') ? 'Payroll: on (your pay period is kept)' : r));
    }

    // A2 (gapsb): "No" to multiple currencies can't undo it once foreign-currency data exists
    // (QB lock) — keep it on rather than failing the whole interview.
    if (plan.settings.multiCurrencyEnabled === false && (await hasForeignCurrencyData(tx.db, tx.companyId, current))) {
      delete plan.settings.multiCurrencyEnabled;
      plan.summary = plan.summary.map((r) =>
        r.startsWith('More than one currency:')
          ? 'More than one currency: yes (kept on: this company already has foreign-currency records)'
          : r,
      );
    }

    // 1. Settings through the Preferences schema + updateCompany whitelist.
    const settings = companySettingsSchema.parse(plan.settings);
    await updateCompany(tx, {
      ...(plan.name ? { name: plan.name } : {}),
      settings,
    });

    // 2. Income-tax form (only when the entity type files one we map).
    if (plan.taxForm) await setIncomeTaxForm(tx, plan.taxForm);

    // 3. New accounts (with their tax line).
    let accountsAdded = 0;
    for (const a of plan.accounts) {
      await createAccount(tx, {
        code: a.code,
        name: a.name,
        type: a.type,
        subtype: a.subtype,
        taxLine: a.taxLine ?? null,
      });
      accountsAdded++;
    }

    // 4. Map the existing chart's empty tax lines to the chosen form.
    let taxLinesMapped = 0;
    if (plan.taxForm) {
      for (const acct of existing) {
        if (acct.taxLine || acct.isActive === false) continue;
        const key = suggestTaxLine(plan.taxForm, acct);
        if (!key) continue;
        await updateAccount(tx, acct.id, { taxLine: key });
        taxLinesMapped++;
      }
    }

    await saveRecord(tx, {
      status: 'done',
      at: new Date().toISOString(),
      entityType: plan.interview.entityType,
      taxYearStartMonth: plan.interview.taxYearStartMonth,
      startDate: plan.interview.startDate,
    });

    return { plan, accountsAdded, taxLinesMapped };
  });
}

/** "Skip for now": remember the choice so the app doesn't keep sending the user back. */
export async function skipSetupInterview(ctx: ServiceContext): Promise<SetupInterviewRecord> {
  const current = await getSetupInterview(ctx);
  if (current?.status === 'done') return current;
  const record: SetupInterviewRecord = { status: 'skipped', at: new Date().toISOString() };
  await inTransaction(ctx, async (tx) => saveRecord(tx, record));
  return record;
}
