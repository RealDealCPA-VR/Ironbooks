/** GET /api/accountant/center — Accountant Center summary (reconciliation status, memorized
 * reports, closing date, sales tax owed, list changes to review, last client data review). */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { accountantCenterSummary } from '@/lib/services/accountant/accountantCenter';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await accountantCenterSummary(ctx));
  } catch (err) {
    return routeError(err, '/api/accountant/center');
  }
}
