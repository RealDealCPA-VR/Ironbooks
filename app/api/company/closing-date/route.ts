/**
 * GET   /api/company/closing-date — current closing date + whether a password is set.
 * PATCH /api/company/closing-date — set/clear the closing date and password (admin/owner).
 *   Body: { closingDate: 'YYYY-MM-DD' | null, password?: string | null }
 *   (closingDate null clears both; password undefined keeps existing, null/'' removes it)
 *
 * QB Desktop parity: Company > Set Closing Date + Closing Date Password. Postings dated
 * on/before the closing date are blocked unless the request carries a valid
 * x-closing-password header (verified in getServerContext).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getClosingDateSettings, setClosingDate } from '@/lib/services/company';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { setClosingDateSchema } from '@/lib/validation/company';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[company/closing-date]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const settings = await getClosingDateSettings(ctx);
    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = setClosingDateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const settings = await setClosingDate(ctx, parsed.data);
    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}
