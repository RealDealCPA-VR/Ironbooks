/**
 * Permission guarding the notes of each kind of record (see app/api/notes): the activity of the
 * record's own list (Customer Center, Vendor Center, Employee Center, Other Lists), not the whole
 * area (prefsperms).
 */
import type { AccessRef } from '@/lib/permissions/model';

export const NOTE_AREA: Record<'customer' | 'vendor' | 'employee' | 'other_name', AccessRef> = {
  customer: 'customers.center',
  vendor: 'vendors.center',
  employee: 'payroll.employees',
  other_name: 'lists.other_lists',
};
