/**
 * Add/Edit Multiple List Entries — vendors.
 * GET  /api/vendors/bulk — current entries as grid rows (edit mode)
 * POST /api/vendors/bulk — { rows, dryRun? }: validate every row, then save all-or-nothing
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { bulkLoad } from '@/lib/services/lists/bulk';
import { handleBulkPost } from '@/lib/lists/bulkRoute';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ rows: await bulkLoad(ctx, 'vendors') });
  } catch (err) {
    return routeError(err, 'GET /api/vendors/bulk');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return await handleBulkPost(ctx, 'vendors', 'vendors', await req.json().catch(() => ({})));
  } catch (err) {
    return routeError(err, 'POST /api/vendors/bulk');
  }
}
