/**
 * Fix Incorrectly Recorded Sales Tax.
 * GET  /api/accountant/sales-tax/fix → issues found
 * POST /api/accountant/sales-tax/fix → { action: 'link' | 'unlink' | 'reclassify', ... }
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import {
  findMisrecordedSalesTax,
  linkSalesTaxLine,
  reclassifySalesTaxPayment,
  unlinkSalesTaxLine,
} from '@/lib/services/accountant/salesTaxTools';
import { zodErrorBody } from '@/lib/validation/helpers';
import { fixSalesTaxSchema } from '@/lib/validation/accountant';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ issues: await findMisrecordedSalesTax(ctx) });
  } catch (err) {
    return routeError(err, '/api/accountant/sales-tax/fix');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = fixSalesTaxSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const b = parsed.data;
    if (b.action === 'link') {
      return NextResponse.json(await linkSalesTaxLine(ctx, { lineId: b.lineId, agencyId: b.agencyId, kind: b.kind, note: b.note }));
    }
    if (b.action === 'unlink') return NextResponse.json(await unlinkSalesTaxLine(ctx, b.lineId));
    return NextResponse.json(
      await reclassifySalesTaxPayment(ctx, { lineId: b.lineId, agencyId: b.agencyId, date: b.date ?? null }),
      { status: 201 },
    );
  } catch (err) {
    return routeError(err, '/api/accountant/sales-tax/fix');
  }
}
