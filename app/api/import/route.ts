/**
 * POST /api/import
 *
 * Parse and stage a bank file (OFX, QBO, or CSV) into the bank_transactions
 * staging table. No GL posting occurs here; that is the reconcile/match step.
 *
 * Request body:
 *   {
 *     bankAccountId: string;       // UUID of the bankAccounts row
 *     fileType: "ofx" | "qfx" | "qbo" | "csv";
 *     content: string;             // raw file text (base64 is NOT required; send as-is)
 *     csvMapping?: {               // required when fileType === "csv"
 *       dateCol: string | number;
 *       descriptionCol: string | number;
 *       amountCol: string | number;
 *       debitCol?: string | number;
 *       creditCol?: string | number;
 *       fitIdCol?: string | number;
 *       dateFormat?: string;
 *     };
 *     filename?: string;           // optional, stored on fileImports row
 *   }
 *
 * Response 201:
 *   { fileImportId, parsed, imported, skippedDupes, errors }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { importTransactions } from '@/lib/services/import';
import { tieOut } from '@/lib/statements/parse';
import { ServiceError } from '@/lib/services/_base';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[import/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await requireJsonObject(req);

    // Validate required fields.
    if (!body.bankAccountId || typeof body.bankAccountId !== 'string') {
      return NextResponse.json(
        { error: 'bankAccountId is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    if (!body.fileType || !['ofx', 'qfx', 'qbo', 'csv', 'rows'].includes(body.fileType)) {
      return NextResponse.json(
        { error: 'fileType must be one of: ofx, qfx, qbo, csv, rows', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    // Reviewed statement rows: the statement must tie out (opening + rows = closing), or the
    // person must have said "import anyway" — checked here, not just on the review screen.
    if (body.fileType === 'rows') {
      const st = (body.statement ?? {}) as Record<string, unknown>;
      if (!Array.isArray(body.rows) || (st.kind !== 'bank' && st.kind !== 'card')) {
        return NextResponse.json({ error: 'rows and statement { kind, openingBalance, closingBalance } are required', code: 'VALIDATION' }, { status: 400 });
      }
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const t = tieOut(body.rows as Array<{ amount: string }>, str(st.openingBalance), str(st.closingBalance), st.kind);
      if (!t.ok && st.acknowledgeDifference !== true) {
        return NextResponse.json(
          { error: t.difference === null ? 'The statement balances are missing, so the rows cannot be tied out.' : `The rows are off from the statement by ${t.difference}.`, code: 'VALIDATION', details: { tieOut: t } },
          { status: 400 },
        );
      }
      const summary = await importTransactions(ctx, {
        bankAccountId: body.bankAccountId,
        fileType: 'rows',
        content: '',
        rows: body.rows as never,
        filename: typeof body.filename === 'string' ? body.filename : undefined,
        statementCheck: { tieOut: t, acknowledgedDifference: !t.ok },
      });
      return NextResponse.json(summary, { status: 201 });
    }
    if (!body.content || typeof body.content !== 'string') {
      return NextResponse.json(
        { error: 'content (raw file text) is required', code: 'VALIDATION' },
        { status: 400 },
      );
    }

    const summary = await importTransactions(ctx, {
      bankAccountId: body.bankAccountId,
      fileType: body.fileType,
      content: body.content,
      csvMapping: body.csvMapping ?? undefined,
      filename: typeof body.filename === 'string' ? body.filename : undefined,
    });

    return NextResponse.json(summary, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
