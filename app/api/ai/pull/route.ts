/**
 * POST /api/ai/pull { baseUrl?, model? } — download a model into a local Ollama server
 * ("Download a starter model" on AI & Automation). Admin/owner; local servers only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { pullStarterModel } from '@/lib/services/aiSettings';
import { aiErrorResponse } from '../_errors';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { baseUrl?: string; model?: string };
    return NextResponse.json(await pullStarterModel(ctx, body ?? {}));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/pull');
  }
}
