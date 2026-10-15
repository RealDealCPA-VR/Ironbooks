/**
 * Receipt reading settings.
 * GET /api/receipts/settings  — local vision model choice, date order, whether offline OCR is
 *                               installed, and the local (Ollama) models that could be used
 * PUT /api/receipts/settings  — { visionProviderId?, preferVision?, dateOrder? } (company setting)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { getReceiptSettingsView, setReceiptSettings } from '@/lib/services/receipts';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getReceiptSettingsView(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/receipts/settings');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    return NextResponse.json(await setReceiptSettings(ctx, body));
  } catch (err) {
    return routeError(err, 'PUT /api/receipts/settings');
  }
}
