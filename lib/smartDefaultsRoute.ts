/**
 * Query parsing shared by the smart-defaults routes (one route per permission area so the
 * fail-closed map in lib/permissions/routes.ts names the right area):
 *   /api/smart-defaults/bills     form=bill                         (vendors)
 *   /api/smart-defaults/expenses  form=check|expense|credit_card    (banking)
 *   /api/smart-defaults/sales     form=invoice|sales_receipt|estimate|sales_order (customers)
 * Query: form, vendorId | customerId, paymentAccountId (checks).
 */
import { validation } from '@/lib/services/_base';
import type { SmartDefaultsInput } from '@/lib/services/smartDefaults';
import { isSmartForm, type SmartForm } from '@/lib/smartDefaults';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse and validate the query; throws VALIDATION (→ 400) on a bad form or id. */
export function parseSmartDefaultsQuery(sp: URLSearchParams, allowed: readonly SmartForm[]): SmartDefaultsInput {
  const form = sp.get('form');
  if (!isSmartForm(form) || !allowed.includes(form)) {
    throw validation(`form must be one of: ${allowed.join(', ')}.`);
  }
  const ids = {
    vendorId: sp.get('vendorId') || null,
    customerId: sp.get('customerId') || null,
    paymentAccountId: sp.get('paymentAccountId') || null,
  };
  for (const [k, v] of Object.entries(ids)) {
    if (v && !UUID.test(v)) throw validation(`${k} must be a uuid.`);
  }
  return { form, ...ids };
}
