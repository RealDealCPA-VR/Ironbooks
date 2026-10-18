/**
 * POST /api/import/extract — read a bank statement file WITHOUT importing anything.
 *
 * Body: { bankAccountId, filename, data } where data is the file's bytes as base64.
 *   .xlsx           → { kind: 'csv', csv, sheet }        (then map columns like any CSV)
 *   .pdf/.png/.jpg  → { kind: 'statement', rows, openingBalance, closingBalance, period,
 *                       tieOut, warnings, method, pages } (review, then POST /api/import 'rows')
 * Everything is read on this computer (PDF text layer, offline OCR, the company's AI under its
 * usual routing rules). See lib/services/statementImport.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { MAX_STATEMENT_BYTES, extractBankFile } from '@/lib/services/statementImport';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { zodErrorBody } from '@/lib/validation/helpers';

const bodySchema = z.object({
  bankAccountId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  // base64 of at most MAX_STATEMENT_BYTES (4 chars per 3 bytes).
  data: z.string().min(1).max(Math.ceil(MAX_STATEMENT_BYTES / 3) * 4 + 4),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const bytes = Buffer.from(parsed.data.data, 'base64');
    const result = await extractBankFile(ctx, { bankAccountId: parsed.data.bankAccountId, filename: parsed.data.filename, bytes });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status: serviceErrorStatus(err.code) });
    }
    console.error('[import/extract]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
