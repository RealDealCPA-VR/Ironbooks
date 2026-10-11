/**
 * GET /api/find — Advanced Find: transactions matching txnType, customerId / vendorId, amountMin /
 * amountMax (transaction total), number, accountId, from / to, memo, classId, cleared.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { findTransactions } from '@/lib/services/reportsAnalysis';
import { ServiceError } from '@/lib/services/_base';
import { parseReportParams } from '@/lib/validation/reports';
import { reportError } from '../reports/_lib';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = parseReportParams(req.nextUrl.searchParams);
    if (!parsed.success) throw new ServiceError('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid search.');
    return NextResponse.json(await findTransactions(ctx, parsed.data));
  } catch (err) {
    return reportError(err, 'find');
  }
}
