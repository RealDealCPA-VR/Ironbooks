/**
 * POST /api/ai/test — "Test Connection" + model picker (admin/owner).
 * Body: a provider config (saved id and/or unsaved draft fields; apiKey optional — a saved
 * provider's stored key is reused). Response: { ok, latencyMs, error?, models[], locality,
 * hostClass, warning }.
 *
 * Only from the computer that holds the company file (lib/net/hostOnly.ts): the test is a
 * connection the host makes to whatever address the body names, with the error text sent back,
 * and with allowCloud it also changes the Privacy & Network policy.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { testConnection } from '@/lib/services/aiSettings';
import { HOST_ONLY_ACTION_MESSAGE, hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';
import { approveQuietFileHere } from '@/lib/net/fileTrust';
import { aiErrorResponse } from '../_errors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown> | null;
    const allowCloud = body?.allowCloud === true;
    if (body) delete body.allowCloud;
    await approveQuietFileHere(ctx, { remote: isRemoteRequest(req) }).catch((err) => console.warn('[file-trust] could not approve the company file on this computer:', (err as Error)?.message ?? err));
    return NextResponse.json(await testConnection(ctx, (body ?? {}) as never, {}, { allowCloud }));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/test');
  }
}
