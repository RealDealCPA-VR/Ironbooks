/**
 * Letters routes act on customers, vendors, employees or leads; each recipient type needs the
 * matching area permission (view to list recipients, print to produce letters/labels/envelopes).
 */
import type { AccessRef } from '@/lib/permissions/model';
import type { RecipientType } from '@/lib/services/letters';

/** prefsperms: the recipients' own list activity (Customer Center, Vendor Center, …), not the whole area. */
export const RECIPIENT_AREA: Record<RecipientType, AccessRef> = {
  customer: 'customers.center',
  vendor: 'vendors.center',
  employee: 'payroll.employees',
  lead: 'customers.leads',
};
