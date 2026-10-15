/**
 * GET /api/checks/settings — check printer setup (style + alignment offsets, inches)
 * PUT /api/checks/settings { style: 'voucher'|'standard'|'wallet', stock?, offsetX, offsetY, position?, pageSize?,
 *     checkHeight?, firstSheetRemaining?, layout? (field positions; null = standard positions) }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCheckPrintSettings, saveCheckPrintSettings } from '@/lib/services/printQueue';
import { routeError } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { checkPrintSettingsSchema } from '@/lib/validation/purchases';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getCheckPrintSettings(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/checks/settings');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = checkPrintSettingsSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await saveCheckPrintSettings(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'PUT /api/checks/settings');
  }
}
