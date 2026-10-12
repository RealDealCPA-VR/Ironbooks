/**
 * Client Data Review.
 * GET  /api/accountant/client-data-review?undepositedDays=30 → tasks with issues + fix actions
 * POST /api/accountant/client-data-review { action: 'task_status' | 'snapshot' |
 *      'apply_customer_credit' | 'apply_vendor_credit', ... }
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import {
  autoApplyCustomerCredit,
  autoApplyVendorCredit,
  clientDataReview,
  setReviewTaskStatus,
  takeReviewSnapshot,
} from '@/lib/services/accountant/clientDataReview';
import { zodErrorBody } from '@/lib/validation/helpers';
import { clientReviewActionSchema } from '@/lib/validation/accountant';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const days = Number(req.nextUrl.searchParams.get('undepositedDays') ?? 30);
    return NextResponse.json(
      await clientDataReview(ctx, { undepositedOlderThanDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : 30 }),
    );
  } catch (err) {
    return routeError(err, '/api/accountant/client-data-review');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = clientReviewActionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const b = parsed.data;
    switch (b.action) {
      case 'task_status':
        return NextResponse.json(await setReviewTaskStatus(ctx, { taskKey: b.taskKey, status: b.status, note: b.note }));
      case 'snapshot':
        return NextResponse.json(await takeReviewSnapshot(ctx, { asOf: b.asOf, note: b.note }), { status: 201 });
      case 'apply_customer_credit':
        return NextResponse.json(await autoApplyCustomerCredit(ctx, { refType: b.refType, refId: b.refId }));
      case 'apply_vendor_credit':
        return NextResponse.json(await autoApplyVendorCredit(ctx, { refId: b.refId }));
    }
  } catch (err) {
    return routeError(err, '/api/accountant/client-data-review');
  }
}
