/**
 * POST /api/ai/pull { baseUrl?, model? } — download a model into a local Ollama server
 * ("Download a starter model" on AI & Automation). Admin/owner; local servers only; only from the
 * computer that holds the company file (the download lands on that computer — lib/net/hostOnly.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { pullStarterModel } from '@/lib/services/aiSettings';
import { HOST_ONLY_ACTION_MESSAGE, hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';
import { aiErrorResponse } from '../_errors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const body = (await req.json().catch(() => ({}))) as { baseUrl?: string; model?: string };
    return NextResponse.json(await pullStarterModel(ctx, body ?? {}));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/pull');
  }
}
