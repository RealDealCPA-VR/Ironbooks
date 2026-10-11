/**
 * Preferences service (QB Edit > Preferences): company preferences (companies.settings, written
 * by updateCompany) + "My Preferences" (user_preferences, one row per user per company).
 *
 * Consumers read the resolved values with getPreferences (company) / getMyPreferences (user);
 * the catalogue, defaults and pure helpers live in lib/preferences.ts.
 */
import { and, eq } from 'drizzle-orm';
import { userPreferences } from '@/lib/db/schema';
import {
  MY_PREFERENCE_KEYS,
  resolveMyPreferences,
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
  const merged = { ...((existing?.prefs as Record<string, unknown>) ?? {}), ...clean };
  let id: string;
  if (existing) {
    await ctx.db
      .update(userPreferences)
      .set({ prefs: merged, updatedAt: new Date() })
      .where(eq(userPreferences.id, existing.id));
    id = existing.id;
  } else {
    const [row] = await ctx.db
      .insert(userPreferences)
      .values({ companyId: ctx.companyId, userId: ctx.userId, prefs: merged })
      .returning({ id: userPreferences.id });
    id = row.id;
  }
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
