/**
 * POST /api/ai/test — "Test Connection" + model picker (admin/owner).
 * Body: a provider config (saved id and/or unsaved draft fields; apiKey optional — a saved
 * provider's stored key is reused). Response: { ok, latencyMs, error?, models[], locality,
 * hostClass, warning }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { testConnection } from '@/lib/services/aiSettings';
import { aiErrorResponse } from '../_errors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    return NextResponse.json(await testConnection(ctx, body ?? {}));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/test');
  }
}
