/**
 * GET  /api/lists/:list  — entries of a simple QB list (?includeInactive=true for all)
 * POST /api/lists/:list  — add an entry
 *
 * :list is one of other-names, job-types, terms, ship-via, payment-methods, customer-messages,
 * sales-tax-codes, vehicles (lib/services/lists/simpleLists.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createEntry, isSimpleListKey, listEntries } from '@/lib/services/lists/simpleLists';

type RouteContext = { params: Promise<{ list: string }> };

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { list } = await params;
    if (!isSimpleListKey(list)) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === 'true';
    return NextResponse.json({ entries: await listEntries(ctx, list, { includeInactive }) });
  } catch (err) {
    return routeError(err, 'GET /api/lists/:list');
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { list } = await params;
    if (!isSimpleListKey(list)) return NextResponse.json({ error: 'Unknown list' }, { status: 404 });
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await createEntry(ctx, list, body), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/lists/:list');
  }
}
