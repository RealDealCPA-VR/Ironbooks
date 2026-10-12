/**
 * Report-level access helpers shared by the report routes.
 */
import { can } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';

export const REPORT_AREAS = ['reports_financial', 'reports_sales', 'reports_purchases', 'reports_payroll', 'reports_inventory', 'time'] as const;

/** Trusted contexts pass; otherwise the caller must be able to view at least one report area. */
export function requireAnyReportAccess(ctx: ServiceContext): void {
  if (!ctx.access) return;
  if (!REPORT_AREAS.some((a) => can(ctx.access, a, 'view'))) {
    throw new ServiceError('FORBIDDEN', 'You do not have permission to run reports. Ask your administrator for access.');
  }
}
