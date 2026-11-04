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
import { canRef, type AccessRef } from '@/lib/permissions/model';
import { serviceErrorStatus } from '@/lib/routeErrors';

/**
 * Result type → the ACTIVITY whose 'view' it needs (Users & Roles; prefsperms: Invoices, Receive
 * Payments… — not any activity of the area). Unknown types are dropped.
 */
const RESULT_AREA: Record<string, AccessRef> = {
  Customer: 'customers.center',
  Invoice: 'customers.invoices',
  Payment: 'customers.payments',
  Vendor: 'vendors.center',
  Bill: 'vendors.bills',
  Item: 'lists.items',
  Account: 'lists.chart_of_accounts',
  Employee: 'payroll.employees',
  'Journal Entry': 'accounting.journal_entries',
  Expense: 'banking.write_checks',
  // Numbered sales / purchase forms found by their typed number (results.ts DOC_KIND_LABEL).
  // Without these every one of them was dropped, for everyone.
  Estimate: 'customers.estimates',
  'Sales Order': 'customers.sales_orders',
  'Sales Receipt': 'customers.sales_receipts',
  'Credit Memo': 'customers.credit_memos',
  'Purchase Order': 'vendors.purchase_orders',
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
      return area ? !ctx.access || canRef(ctx.access, area, 'view') : false;
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
