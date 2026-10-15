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
import { removeTaxFixes } from '@/lib/errorFixes';
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

/** Convenience: the plain "turned off" error for a FEATURE_GATES key. */
function gateError(key: keyof CompanyPreferences): ServiceError {
  const gate = FEATURE_GATES.find((g) => g.key === key) ?? EXTRA[key];
  return featureOffError(gate ?? { label: String(key), category: 'Preferences', setting: String(key) });
}

/**
 * Sales forms (invoice, sales receipt, estimate, credit memo) may not charge sales tax while
 * "Charge sales tax" is off (QB removes the tax column and tax item from forms). `keep` lists
 * tax rates already on the document being edited: an edit that leaves an old document's tax as
 * it was is allowed, so turning sales tax off never locks existing records.
 */
export async function assertSalesTaxAllowed(
  ctx: ServiceContext,
  input: { taxRateId?: string | null; lines?: ReadonlyArray<object> },
  keep: ReadonlyArray<string | null | undefined> = [],
): Promise<void> {
  const kept = new Set(keep.filter(Boolean) as string[]);
  const isNew = (id: string | null | undefined): id is string => !!id && !kept.has(id);
  const lineTax = (input.lines ?? []).map((l) => (l as { taxRateId?: string | null }).taxRateId);
  const used = [input.taxRateId, ...lineTax].filter(isNew);
  if (used.length === 0) return;
  const prefs = await companyPrefs(ctx.db, ctx.companyId);
  if (prefs.salesTaxEnabled === false) {
    // Fix: take the tax off the form (header tax rate + any line tax rates), or turn tax back on.
    throw gateError('salesTaxEnabled').withFixes(
      removeTaxFixes({
        headerTax: isNew(input.taxRateId),
        linePaths: lineTax.flatMap((id, i) => (isNew(id) ? [`lines.${i}.taxRateId`] : [])),
      }),
    );
  }
}

/** Is the company's sales tax feature on? (Customer tax defaults are skipped while it is off.) */
export async function salesTaxOn(ctx: ServiceContext): Promise<boolean> {
  return (await companyPrefs(ctx.db, ctx.companyId)).salesTaxEnabled !== false;
}

/** Inventory Part / Inventory Assembly items need "Track inventory" (QB hides those types). */
export async function assertItemTypeAllowed(ctx: ServiceContext, type: string | null | undefined): Promise<void> {
  if (type !== 'inventory' && type !== 'assembly') return;
  const prefs = await companyPrefs(ctx.db, ctx.companyId);
  if (prefs.inventoryEnabled === false) throw gateError('inventoryEnabled');
}
