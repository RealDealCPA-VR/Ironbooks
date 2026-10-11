/**
 * Letters routes act on customers, vendors, employees or leads; each recipient type needs the
 * matching area permission (view to list recipients, print to produce letters/labels/envelopes).
 */
import type { Area } from '@/lib/permissions/model';
import type { RecipientType } from '@/lib/services/letters';

export const RECIPIENT_AREA: Record<RecipientType, Area> = {
  customer: 'customers',
  vendor: 'vendors',
  employee: 'payroll',
  lead: 'customers',
};
