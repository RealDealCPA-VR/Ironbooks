/**
 * POST /api/memorized-reports/process — Process Multiple Reports.
 *   body: { groupId } or { ids: [...] }, optional { format: 'xlsx' } to download one workbook
 *   (one sheet per report). Each report is permission-checked for its own area; a report the
 *   caller may not run comes back with an error instead of failing the batch.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import { processMultipleReports, reportsToWorkbook } from '@/lib/services/memorizedReports';
import { zodErrorBody } from '@/lib/validation/helpers';
import { reportError } from '../../reports/_lib';

const bodySchema = z.object({
  groupId: z.string().uuid().optional(),
  ids: z.array(z.string().uuid()).max(100).optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const results = await processMultipleReports(ctx, parsed.data);
    if (parsed.data.format === 'xlsx') {
      const ok = results.filter((r) => r.report).map((r) => r.report!);
      if (ok.length === 0) {
        return NextResponse.json({ error: 'None of the selected reports could be run.', results }, { status: 400 });
      }
      return new NextResponse(new Uint8Array(reportsToWorkbook(ok)), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="memorized-reports.xlsx"',
        },
      });
    }
    return NextResponse.json({ results });
  } catch (e) {
    return reportError(e, 'memorized-reports/process');
  }
}
