/**
 * POST /api/export/reports — generic report file export.
 *
 * The client posts the already-rendered tabular report (columns + rows +
 * optional totals) and gets back a downloadable file:
 *   { format: 'xlsx' | 'pdf', filename, title, subtitle?, columns, rows,
 *     totals?, landscape? }
 *
 * One endpoint serves every report page — the ReportToolbar component builds
 * the payload from whatever table the page is currently showing, so Excel/PDF
 * exports always match the on-screen filters exactly.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { ServiceError } from '@/lib/services/_base';
import { buildXlsx, type XlsxCell } from '@/lib/export/xlsx';
import { buildReportPdf } from '@/lib/export/reportPdf';
import { serviceErrorStatus, requireJsonObject } from '@/lib/routeErrors';

const cellSchema = z.union([z.string(), z.number(), z.null()]);

const bodySchema = z.object({
  format: z.enum(['xlsx', 'pdf']),
  filename: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  columns: z
    .array(z.object({ header: z.string().max(120), numeric: z.boolean().optional() }))
    .min(1)
    .max(64),
  rows: z.array(z.array(cellSchema)).max(50_000),
  totals: z.array(z.array(cellSchema)).max(200).optional(),
  landscape: z.boolean().optional(),
});

/** Strip path separators / control chars so the filename is download-safe. */
function safeFilename(name: string, ext: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').trim() || 'report';
  return base.endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bodySchema.safeParse(await requireJsonObject(req));
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Invalid export payload: ${parsed.error.issues[0]?.message ?? 'bad request'}` },
        { status: 400 },
      );
    }
    const body = parsed.data;

    if (body.format === 'xlsx') {
      const buffer = buildXlsx({
        sheetName: body.title,
        title: body.title,
        subtitle: body.subtitle,
        columns: body.columns,
        rows: body.rows as XlsxCell[][],
        totals: body.totals as XlsxCell[][] | undefined,
      });
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${safeFilename(body.filename, 'xlsx')}"`,
        },
      });
    }

    const company = await getCompany(ctx);
    const bytes = await buildReportPdf({
      title: body.title,
      company: company?.name ?? undefined,
      subtitle: body.subtitle,
      columns: body.columns,
      rows: body.rows,
      totals: body.totals,
      // Wide tables flip to landscape automatically unless the caller decides.
      landscape: body.landscape ?? body.columns.length > 6,
    });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeFilename(body.filename, 'pdf')}"`,
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[export/reports] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
