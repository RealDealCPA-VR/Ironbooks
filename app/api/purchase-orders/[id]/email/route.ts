/**
 * POST /api/purchase-orders/:id/email — email the purchase order (PDF) to the vendor (prefsperms).
 * Body: { to?: string, templateId?: string }. Subject and message: the Purchase Order template of
 * Preferences > Send Forms. Needs Purchase Orders: print.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { emailPurchaseOrder } from '@/lib/services/purchaseOrderEmail';
import { requireJsonObject, routeError } from '@/lib/routeErrors';
import { templateIdParam } from '@/lib/validation/prefs';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await requireJsonObject(req, { optional: true });
    const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : null;
    let templateId: string | null = null;
    if (typeof body.templateId === 'string' && body.templateId) {
      const t = templateIdParam(body.templateId);
      if (t === false) {
        return NextResponse.json({ error: 'templateId must be a valid id', code: 'VALIDATION' }, { status: 400 });
      }
      templateId = t;
    }
    return NextResponse.json(await emailPurchaseOrder(ctx, id, to, templateId));
  } catch (err) {
    return routeError(err, 'POST /api/purchase-orders/[id]/email');
  }
}
