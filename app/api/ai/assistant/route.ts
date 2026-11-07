/**
 * POST /api/ai/assistant { message, history?: [{ role: 'user'|'assistant', content }] }
 *   → AssistantReply { answer, toolCalls[], proposals[], unverifiedNumbers[], mode, providerId?, redacted?, notice? }
 *
 * The model can only call read-only report tools computed locally; proposed writes come back
 * as pending proposals (approve/reject via /api/ai/proposals/:id).
 *
 * ?stream=1: newline-delimited JSON instead — one {"type":"step","tool","args"} line per report
 * the model reads (the panel shows "Looking at Profit & Loss…" instead of one long spinner),
 * then {"type":"reply", ...AssistantReply} or {"type":"error","error","code"}.
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
    if (req.nextUrl.searchParams.get('stream') !== '1') {
      return NextResponse.json(await ask(ctx, parsed.data.history, parsed.data.message));
    }
    const { history, message } = parsed.data;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const line = (obj: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        try {
          const reply = await ask(ctx, history, message, { onStep: (step) => line({ type: 'step', ...step }) });
          line({ type: 'reply', ...reply });
        } catch (err) {
          const res = aiErrorResponse(err, 'POST /api/ai/assistant');
          const body = await res.json().catch(() => ({ error: 'The assistant could not answer.' }));
          line({ type: 'error', status: res.status, ...body });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/assistant');
  }
}
