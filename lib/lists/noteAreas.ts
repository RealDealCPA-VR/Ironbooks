/** Permission area guarding the notes of each kind of record (see app/api/notes). */
import type { Area } from '@/lib/permissions/model';

export const NOTE_AREA: Record<'customer' | 'vendor' | 'employee' | 'other_name', Area> = {
  customer: 'customers',
  vendor: 'vendors',
  employee: 'payroll',
  other_name: 'lists',
};
