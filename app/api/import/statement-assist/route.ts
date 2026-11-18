/**
 * POST /api/import/statement-assist — "Fix with AI" on the statement review screen.
 *
 * Body: { bankAccountId, text, rows: [{ date, description, amount }], openingBalance,
 *         closingBalance, instruction? }
 * Returns the AI's corrected { rows, openingBalance, closingBalance, notes, tieOut }. Nothing is
 * imported or saved: the review screen shows it (with Undo) and the person still imports.
 * See lib/services/statementImport.ts assistStatement.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { assistStatement } from '@/lib/services/statementImport';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';

const bodySchema = z.object({
  bankAccountId: z.string().uuid(),
  text: z.string().max(200_000).default(''),
  rows: z
    .array(z.object({ date: z.string().max(20), description: z.string().max(500), amount: z.string().max(30) }))
    .max(1500),
  openingBalance: z.string().max(30).nullable(),
  closingBalance: z.string().max(30).nullable(),
  instruction: z.string().max(1000).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    return NextResponse.json(await assistStatement(ctx, parsed.data));
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: serviceErrorStatus(err.code) });
    }
    console.error('[import/statement-assist]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
