/**
 * GET   /api/receiving/settings — enhanced receiving preferences
 * PATCH /api/receiving/settings — { enhancedReceiving?, varianceMode?: 'inventory'|'ppv', ppvAccountId? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getReceivingSettings, updateReceivingSettings } from '@/lib/services/receiving';
import { zodErrorBody } from '@/lib/validation/helpers';
import { receivingSettingsSchema } from '@/lib/validation/pricing';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getReceivingSettings(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/receiving/settings');
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = receivingSettingsSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await updateReceivingSettings(ctx, parsed.data));
  } catch (err) {
    return routeError(err, 'PATCH /api/receiving/settings');
  }
}
