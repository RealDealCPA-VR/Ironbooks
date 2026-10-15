/**
 * POST /api/command-bar — the Ctrl+K command bar's plain-English engine.
 *   { text, allowAi? }            → run a typed command (grammar first; AI fallback only when
 *                                   allowAi and the company has an AI model configured)
 *   { intent, hints? }            → re-run a pick from a "Which one did you mean?" list
 * Returns a CommandResult (lib/services/commandBar.ts): a prefilled form to open, a page or
 * filtered report, a computed answer, choices, or "not understood". READ-ONLY — it never
 * creates, posts or changes a record; prefilled forms are saved by the user as usual.
 *
 * Permission map: 'member' — each result is checked against the caller's own permissions
 * inside the service (like /api/search), so a role only gets pages/actions/answers it may use.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { routeError, invalidJsonBody, readJsonObject } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';
import { commandIntentSchema, resolveHintsSchema } from '@/lib/commands/intent';
import { runCommand } from '@/lib/services/commandBar';
import { AiError } from '@/lib/ai/types';

const bodySchema = z
  .object({
    text: z.string().max(500).optional(),
    intent: commandIntentSchema.optional(),
    hints: resolveHintsSchema.optional(),
    allowAi: z.boolean().optional(),
  })
  .refine((b) => !!b.text?.trim() || !!b.intent, { message: 'Type what you want to do.', path: ['text'] });

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await runCommand(ctx, parsed.data));
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: `AI_${err.code}` }, { status: 503 });
    }
    return routeError(err, 'POST /api/command-bar');
  }
}
