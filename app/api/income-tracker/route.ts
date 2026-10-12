/** GET /api/income-tracker?customerId= — Income Tracker bars + rows (wave2 sales C9). */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { incomeTracker } from '@/lib/services/incomeTracker';
import { routeError } from '@/lib/routeErrors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const customerId = req.nextUrl.searchParams.get('customerId') ?? undefined;
    return NextResponse.json(await incomeTracker(ctx, { customerId }));
  } catch (err) {
    return routeError(err, 'GET /api/income-tracker');
  }
}
