/**
 * GET  /api/uom-sets — Unit of Measure sets with their units (?includeInactive=true)
 * POST /api/uom-sets — add { name, kind, baseUnitName, baseUnitAbbrev, units: [{name, abbrev, factor}], default*Unit }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createUomSet, listUomSets } from '@/lib/services/lists/uom';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === 'true';
    return NextResponse.json({ sets: await listUomSets(ctx, { includeInactive }) });
  } catch (err) {
    return routeError(err, 'GET /api/uom-sets');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await createUomSet(ctx, await req.json().catch(() => ({}))), { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/uom-sets');
  }
}
