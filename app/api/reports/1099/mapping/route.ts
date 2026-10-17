/**
 * /api/reports/1099/mapping — 1099 account → box mapping (companies.settings.tax1099)
 *
 * GET   → { mapping: Tax1099Mapping | null, boxes: [{ box, label }] }
 * PATCH → body { boxes: [{ box: 'nec_1'|'misc_1'|'misc_3', accountIds: string[] }] }
 *         Saves the mapping; an empty boxes array clears it (back to
 *         "all payments count as NEC box 1").
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import {
  TAX_1099_BOXES,
  get1099Mapping,
  set1099Mapping,
  type Tax1099Mapping,
} from '@/lib/services/statements';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[1099/mapping] Unexpected error', err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const mapping = await get1099Mapping(ctx);
    return NextResponse.json({ mapping, boxes: TAX_1099_BOXES });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req)) as { boxes?: unknown };
    if (!Array.isArray(body.boxes)) {
      return NextResponse.json(
        { error: 'boxes must be an array of { box, accountIds[] }.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const mapping = await set1099Mapping(ctx, { boxes: body.boxes } as Tax1099Mapping);
    return NextResponse.json({ mapping, boxes: TAX_1099_BOXES });
  } catch (err) {
    return errorResponse(err);
  }
}
