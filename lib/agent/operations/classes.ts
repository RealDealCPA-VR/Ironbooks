/**
 * Agent full access: the hand-written classification of every API route + method, merged from
 * one file per area (classes/buckets.ts). test/agentRegistry.test.ts fails when a route is missing.
 */
import type { ClassificationMap } from './types';
import { SALES_CLASSES } from './classes/sales';
import { PURCHASES_CLASSES } from './classes/purchases';
import { BANKING_CLASSES } from './classes/banking';
import { LISTS_CLASSES } from './classes/lists';
import { PLANNING_CLASSES } from './classes/planning';
import { PAYROLL_CLASSES } from './classes/payroll';
import { REPORTS_CLASSES } from './classes/reports';
import { DOCUMENTS_CLASSES } from './classes/documents';
import { COMPANY_CLASSES } from './classes/company';
import { ADMIN_CLASSES } from './classes/admin';

export const OPERATION_CLASSES: ClassificationMap = {
  ...SALES_CLASSES,
  ...PURCHASES_CLASSES,
  ...BANKING_CLASSES,
  ...LISTS_CLASSES,
  ...PLANNING_CLASSES,
  ...PAYROLL_CLASSES,
  ...REPORTS_CLASSES,
  ...DOCUMENTS_CLASSES,
  ...COMPANY_CLASSES,
  ...ADMIN_CLASSES,
};
