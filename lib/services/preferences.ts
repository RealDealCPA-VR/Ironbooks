/**
 * Preferences service (QB Edit > Preferences): company preferences (companies.settings, written
 * by updateCompany) + "My Preferences" (user_preferences, one row per user per company).
 *
 * Consumers read the resolved values with getPreferences (company) / getMyPreferences (user);
 * the catalogue, defaults and pure helpers live in lib/preferences.ts.
 */
import { and, eq, sql } from 'drizzle-orm';
import { userPreferences } from '@/lib/db/schema';
import {
  MY_PREFERENCE_KEYS,
  resolveMyPreferences,
  todayInTimeZone,
  type CompanyPreferences,
  type MyPreferences,
} from '@/lib/preferences';
import { type ServiceContext, validation, writeAudit } from './_base';
import { getPreferences } from './company';

export { getPreferences };

export interface AllPreferences {
  company: CompanyPreferences;
  my: MyPreferences;
}

export async function getMyPreferences(ctx: ServiceContext): Promise<MyPreferences> {
  if (!ctx.userId) return resolveMyPreferences({});
  const [row] = await ctx.db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(and(eq(userPreferences.companyId, ctx.companyId), eq(userPreferences.userId, ctx.userId)));
  return resolveMyPreferences(row?.prefs ?? {});
}

/**
 * Today's calendar day for this company ('YYYY-MM-DD'), in its time zone (Preferences > Company).
 * `new Date().toISOString().slice(0, 10)` is the UTC day: in the evening west of UTC it is already
 * tomorrow, so "today", "this month" and default dates came out a day (or a month) ahead.
 */
export async function companyTodayIso(ctx: ServiceContext, now: Date = new Date()): Promise<string> {
  const prefs = await getPreferences(ctx);
  return todayInTimeZone(prefs.timezone, now);
}

/**
 * companyTodayIso as a Date at noon UTC of that day — for code that reads calendar parts with
 * getUTC* (lib/commands/dates.ts) or slices toISOString(): both then see the company's day.
 */
export async function companyToday(ctx: ServiceContext, now: Date = new Date()): Promise<Date> {
  return new Date(`${await companyTodayIso(ctx, now)}T12:00:00.000Z`);
}

export async function getAllPreferences(ctx: ServiceContext): Promise<AllPreferences> {
  const [company, my] = await Promise.all([getPreferences(ctx), getMyPreferences(ctx)]);
  return { company, my };
}

const MY_KEY_SET = new Set<string>(MY_PREFERENCE_KEYS);

/**
 * Merge a patch into the signed-in user's My Preferences. Unknown keys are dropped. My
 * Preferences change only how the app behaves for this person, so any member may save their
 * own — including view-only members (no books data changes; the audit row records it).
 */
export async function updateMyPreferences(
  ctx: ServiceContext,
  patch: Partial<MyPreferences>,
): Promise<MyPreferences> {
  if (!ctx.userId) throw validation('My Preferences need a signed-in user.');
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (MY_KEY_SET.has(k) && v !== undefined) clean[k] = v;
  }
  const [existing] = await ctx.db
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.companyId, ctx.companyId), eq(userPreferences.userId, ctx.userId)));
  // Atomic upsert: two quick saves (even a person's very first ones) both stick — the unique
  // (company_id, user_id) key turns the second insert into a JSON merge of just its own keys,
  // so overlapping saves never drop each other's settings.
  const [row] = await ctx.db
    .insert(userPreferences)
    .values({ companyId: ctx.companyId, userId: ctx.userId, prefs: clean })
    .onConflictDoUpdate({
      target: [userPreferences.companyId, userPreferences.userId],
      set: { prefs: sql`${userPreferences.prefs} || excluded.prefs`, updatedAt: new Date() },
    })
    .returning({ id: userPreferences.id, prefs: userPreferences.prefs });
  const id = row.id;
  const merged = (row.prefs as Record<string, unknown>) ?? {};
  // My Preferences are personal settings, so a view-only member may change their own: audit
  // under a context without the viewer role (writeAudit would otherwise refuse the row).
  await writeAudit(
    { ...ctx, role: ctx.role === 'viewer' ? undefined : ctx.role },
    {
      action: existing ? 'update' : 'create',
      entityType: 'user_preferences',
      entityId: id,
      oldValues: existing?.prefs ?? null,
      newValues: merged,
    },
  );
  return resolveMyPreferences(merged);
}
