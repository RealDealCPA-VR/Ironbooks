/**
 * POST /api/ai/assistant { message, history?: [{ role: 'user'|'assistant', content }] }
 *   → AssistantReply { answer, toolCalls[], proposals[], unverifiedNumbers[], mode, providerId?, redacted?, notice? }
 *
 * The model can only call read-only report tools computed locally; proposed writes come back
 * as pending proposals (approve/reject via /api/ai/proposals/:id).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { ask } from '@/lib/services/aiAssistant';
import { zodErrorBody } from '@/lib/validation/helpers';
import { aiErrorResponse } from '../_errors';

const bodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(40)
    .default([]),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await ask(ctx, parsed.data.history, parsed.data.message));
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/assistant');
  }
}
