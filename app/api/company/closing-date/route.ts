/**
 * GET   /api/company/closing-date — current closing date + whether a password is set.
 * PATCH /api/company/closing-date — set/clear the closing date and password (Closing Date: modify).
 *   Body: { closingDate: 'YYYY-MM-DD' | null, password?: string | null, currentPassword?: string }
 *   (closingDate null clears both; password undefined keeps existing, null/'' removes it)
 *   Once a password is set, someone who is not an Admin gives `currentPassword` to move the date
 *   earlier, clear it, or change or remove the password (GET answers currentPasswordRequired).
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
    // The current password travels beside the validated fields (never logged, never stored).
    const raw = body as { currentPassword?: unknown } | null;
    const currentPassword = typeof raw?.currentPassword === 'string' ? raw.currentPassword : undefined;
    const settings = await setClosingDate(ctx, { ...parsed.data, currentPassword });
    return NextResponse.json(settings);
  } catch (err) {
    return errorResponse(err);
  }
}
