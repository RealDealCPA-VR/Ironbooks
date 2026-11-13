/**
 * "What the AI posted" (lib/services/aiPosts.ts). Same rights as Bank Review.
 *   GET                       → { posts: AiPostRow[] }
 *   POST { action: 'undo', id } → the row, now undone (Bank Review's Unmatch on its line)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { validation } from '@/lib/services/_base';
import { listAiPosts, undoAiPost } from '@/lib/services/aiPosts';
import { aiErrorResponse } from '../_errors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ posts: await listAiPosts(ctx) });
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/posts');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string };
    if (body?.action !== 'undo' || typeof body.id !== 'string') throw validation('Send { action: "undo", id }.');
    return NextResponse.json(await undoAiPost(ctx, body.id));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/posts');
  }
}
