/**
 * "Continue with ChatGPT" (lib/services/chatgptSignIn.ts). Admin/owner.
 *   POST { action: 'start' }               → { attemptId, url }  (open url in the browser)
 *   GET  ?attempt=<id>                      → { status: 'pending' | 'done' | 'error', ... }
 *   POST { action: 'cancel', attemptId }    → { ok: true }
 *   POST { action: 'disconnect' }           → { revoked }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { cancelChatGptSignIn, chatGptSignInStatus, disconnectChatGpt, startChatGptSignIn } from '@/lib/services/chatgptSignIn';
import { validation } from '@/lib/services/_base';
import { aiErrorResponse } from '../_errors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const attempt = req.nextUrl.searchParams.get('attempt') ?? '';
    return NextResponse.json(await chatGptSignInStatus(ctx, attempt));
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/chatgpt');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { action?: string; attemptId?: string };
    switch (body?.action) {
      case 'start':
        return NextResponse.json(await startChatGptSignIn(ctx));
      case 'cancel':
        await cancelChatGptSignIn(ctx, String(body.attemptId ?? ''));
        return NextResponse.json({ ok: true });
      case 'disconnect':
        return NextResponse.json(await disconnectChatGpt(ctx));
      default:
        throw validation('Unknown action.');
    }
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/chatgpt');
  }
}
