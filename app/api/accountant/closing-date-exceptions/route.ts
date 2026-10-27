/** GET /api/accountant/closing-date-exceptions?from=&to= — Closing Date Exception report
 * (changes made on/before the closing date with the closing-date password). */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { closingDateExceptionReport } from '@/lib/services/accountant/auditReports';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(
      await closingDateExceptionReport(ctx, { from: sp.get('from'), to: sp.get('to') }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/closing-date-exceptions');
  }
}
