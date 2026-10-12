/**
 * Server side of the Preferences feature switches (lib/preferences.ts FEATURE_GATES).
 *
 *  - enforceFeatureGate: called by getServerContext for every API request. A save
 *    (POST/PUT/PATCH/DELETE) to a gated API while its feature is off is refused with a plain
 *    message naming the setting that turns it back on. Reads stay open so existing records keep
 *    showing in reports and lists. Only gated paths cost a settings lookup.
 *  - assertFeatureOn: the same check for features that have no route of their own (progress
 *    invoicing is an action on the estimate route).
 */
import { eq } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import {
  FEATURE_GATES,
  blockingFeatureGate,
  featureGateForApi,
  featureOffMessage,
  resolveCompanyPreferences,
  type CompanyPreferences,
} from '@/lib/preferences';
import { currentRequestInfo } from '@/lib/permissions/enforce';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';

/** FORBIDDEN error for a feature that is turned off (friendlyErrors shows it as "turned off"). */
export function featureOffError(gate: { label: string; category: string; setting: string }): ServiceError {
  return new ServiceError('FORBIDDEN', featureOffMessage(gate), { featureOff: true });
}

async function companyPrefs(db: DB, companyId: string): Promise<CompanyPreferences> {
  const [row] = await db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  return resolveCompanyPreferences(row?.settings ?? {});
}

/** Refuse a save to a gated API while its feature is off (no-op outside a request). */
export async function enforceFeatureGate(db: DB, companyId: string): Promise<void> {
  const info = await currentRequestInfo();
  if (!info?.path || info.method === 'GET' || info.method === 'HEAD') return;
  if (!featureGateForApi(info.path)) return; // cheap path check first: no DB read
  const gate = blockingFeatureGate(info.path, await companyPrefs(db, companyId), info.method);
  if (gate) throw featureOffError(gate);
}

/** Labels for features that are switched by a preference but have no gated route. */
const EXTRA: Partial<Record<keyof CompanyPreferences, { label: string; category: string; setting: string }>> = {
  progressInvoicingEnabled: {
    label: 'Progress invoicing',
    category: 'Jobs & Estimates',
    setting: 'Use progress invoicing',
  },
};

/** Throw the plain "turned off" error unless the boolean preference `key` is on. */
export async function assertFeatureOn(ctx: ServiceContext, key: keyof CompanyPreferences): Promise<void> {
  const prefs = await companyPrefs(ctx.db, ctx.companyId);
  if (prefs[key] !== false) return;
  const gate = FEATURE_GATES.find((g) => g.key === key) ?? EXTRA[key];
  throw featureOffError(gate ?? { label: String(key), category: 'Preferences', setting: String(key) });
}
