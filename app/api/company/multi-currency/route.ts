/**
 * GET /api/company/multi-currency — Preferences > Multiple Currencies status for the active
 * company: { enabled, hasForeignData, locked }. `locked` = on and foreign-currency data exists,
 * so it can no longer be turned off (QB). The switch itself is saved through PATCH /api/company
 * { settings: { multiCurrencyEnabled } }, which enforces the lock (lib/services/multiCurrency.ts).
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getMultiCurrencyStatus } from '@/lib/services/multiCurrency';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getMultiCurrencyStatus(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/company/multi-currency');
  }
}
