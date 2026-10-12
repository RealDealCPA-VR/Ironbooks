/**
 * GET /api/reports/filter-options — id + name lists (accounts, customers, vendors, classes, items,
 * employees, jobs, budgets, vehicles) for the report toolbar's filter pickers. Names only; any
 * member who may run some report may read them (checked in the service).
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { reportFilterOptions } from '@/lib/services/reportsAnalysis';
import { reportError } from '../_lib';

export async function GET() {
  try {
    return NextResponse.json(await reportFilterOptions(await getServerContext()));
  } catch (err) {
    return reportError(err, 'filter-options');
  }
}
