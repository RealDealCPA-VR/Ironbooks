/**
 * GET /api/search?q=... — global search across customers, vendors, items, invoices, bills,
 * payments (by reference), employees, accounts, journal entries, and exact amounts against
 * invoice/bill/expense totals. Powers the Cmd/Ctrl-K command palette.
 *
 * Session-checked via getServerContext (fails closed once any user exists) and scoped to the
 * caller's active company. Queries run in parallel with a per-type LIMIT to stay fast.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { runGlobalSearch } from './queries';
import { buildResults } from './results';
import { can, type Area } from '@/lib/permissions/model';
import { serviceErrorStatus } from '@/lib/routeErrors';

/** Result type → the area whose 'view' it needs (Users & Roles). Unknown types are dropped. */
const RESULT_AREA: Record<string, Area> = {
  Customer: 'customers',
  Invoice: 'customers',
  Payment: 'customers',
  Vendor: 'vendors',
  Bill: 'vendors',
  Item: 'lists',
  Account: 'lists',
  Employee: 'payroll',
  'Journal Entry': 'accounting',
  Expense: 'banking',
};

export async function GET(req: NextRequest) {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < 1) return NextResponse.json({ results: [] });
  try {
    const ctx = await getServerContext();
    const hits = await runGlobalSearch(ctx.db, ctx.companyId, q);
    // Only show hits from areas the caller's roles can view.
    const results = buildResults(hits).filter((r) => {
      const area = RESULT_AREA[r.type];
      return area ? !ctx.access || can(ctx.access, area, 'view') : false;
    });
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: serviceErrorStatus(err.code) });
    }
    console.error('[search] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
