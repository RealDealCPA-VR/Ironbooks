/**
 * GET /api/export/<list>[.csv|.xlsx|.iif][?format=csv|xlsx|iif] — export a list.
 *
 * <list> ∈ customers | vendors | items | accounts | employees | classes | tax_rates | terms |
 *          jobs | payroll_items | customer_types | vendor_types | sales_reps |
 *          workers_comp_codes | all
 *   all + xlsx → one workbook, a sheet per list; all + iif → every QuickBooks-readable list.
 *
 * GET /api/export/journal?format=iif&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   — posted journal entries as IIF GENERAL JOURNAL TRNS/SPL blocks.
 *
 * Returns the file as an attachment download.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { exportList, type ExportFormat } from '@/lib/services/listExport';
import { exportJournalIif } from '@/lib/services/iifExport';
import { routeError } from '@/lib/routeErrors';

interface RouteParams {
  params: Promise<{ list: string }>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { list } = await params;
    const raw = decodeURIComponent(list).toLowerCase();
    const ext = /\.(csv|xlsx|iif)$/.exec(raw)?.[1] as ExportFormat | undefined;
    const name = raw.replace(/\.(csv|xlsx|iif)$/, '');
    const format = ((req.nextUrl.searchParams.get('format') ?? ext ?? 'csv').toLowerCase()) as ExportFormat;

    const ctx = await getServerContext();

    if (name === 'journal') {
      const from = req.nextUrl.searchParams.get('from');
      const to = req.nextUrl.searchParams.get('to');
      if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
        return NextResponse.json({ error: 'from and to (YYYY-MM-DD) are required', code: 'VALIDATION' }, { status: 400 });
      }
      const body = await exportJournalIif(ctx, {
        from: new Date(`${from}T00:00:00.000Z`),
        to: new Date(`${to}T23:59:59.999Z`),
      });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="journal-${from}-to-${to}.iif"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const file = await exportList(ctx, name, format);
    const body = typeof file.body === 'string' ? file.body : new Uint8Array(file.body);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return routeError(err, 'export/[list]');
  }
}
