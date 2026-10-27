/**
 * /api/qb-import/gl — QuickBooks General Ledger migration (lib/services/qbGlImport.ts).
 *
 * POST body (JSON, see lib/validation/qbGlImport.ts):
 *   {
 *     action: 'preview' | 'dry-run' | 'import',
 *     file: { name, data: base64 },             // GL report: .xlsx, .csv or .pdf
 *     references?: [{ name, data }],            // QB Account List / Trial Balance / IIF chart
 *     periodStart?, periodEnd?: 'YYYY-MM-DD',   // override the dates read from the report
 *     accounts?: { [qbAccountKey]: { qbType?, mapTo?: 'new' | accountId } },
 *     acceptVariance?: boolean,                 // post differences to 'QB Import Suspense'
 *   }
 *
 * preview → GlPreview (accounts with suggested types/mappings, totals, review list, problems).
 * dry-run → GlImportResult; everything is done and proven, then rolled back.
 * import  → GlImportResult; committed only when every account reconciles (or the user accepted
 *           the variance). A failed proof returns 200 with ok:false and the proof — nothing saved.
 *
 * GET → past General Ledger imports with their stored proof.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import { ServiceError } from '@/lib/services/_base';
import { listGlImports, previewGlImport, runGlImport } from '@/lib/services/qbGlImport';
import { zodErrorBody } from '@/lib/validation/helpers';
import { qbGlImportSchema } from '@/lib/validation/qbGlImport';
import { serviceErrorStatus } from '@/lib/routeErrors';

// Large reports take a while to post; never let the platform cache or time-box this route.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code, { PERIOD_CLOSED: 409 });
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[qb-import/gl] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const imports = await listGlImports(ctx);
    return NextResponse.json({ imports });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = qbGlImportSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const { action, ...input } = parsed.data;
    if (action === 'preview') {
      return NextResponse.json(await previewGlImport(ctx, input));
    }
    // Bringing years of history into the books is an import like the IIF / open-items ones (QB:
    // File > Utilities > Import is admin-only, in single-user mode): owner/admin, nobody else on.
    // The dry run does the same work in one long transaction (then rolls it back), which holds
    // the company file for everyone while it runs — so it needs the same.
    await assertExclusiveAccess(ctx, 'Import');
    const result = await runGlImport(ctx, input, { dryRun: action === 'dry-run' });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
