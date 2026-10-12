/**
 * GET /api/letters/recipients?type=customer|vendor|employee|lead[&overdueDays=30&minBalance=0.01&includeInactive=1]
 * Recipients with their address, balance and (customers) overdue amounts for letters/labels.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requirePermission } from '@/lib/services/access';
import { listRecipients, RECIPIENT_TYPES, type RecipientType } from '@/lib/services/letters';
import { routeError } from '@/lib/routeErrors';
import { RECIPIENT_AREA } from '../_shared';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const type = sp.get('type') as RecipientType;
    if (!RECIPIENT_TYPES.includes(type)) {
      return NextResponse.json({ error: 'type must be customer, vendor, employee or lead', code: 'VALIDATION' }, { status: 400 });
    }
    requirePermission(ctx, RECIPIENT_AREA[type], 'view');
    const overdue = sp.get('overdueDays');
    const minBalance = sp.get('minBalance');
    if (overdue !== null && !/^\d{1,4}$/.test(overdue)) {
      return NextResponse.json({ error: 'overdueDays must be a whole number', code: 'VALIDATION' }, { status: 400 });
    }
    if (minBalance !== null && minBalance !== '' && !/^\d+(\.\d{1,2})?$/.test(minBalance)) {
      return NextResponse.json({ error: 'minBalance must be an amount', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(
      await listRecipients(ctx, {
        type,
        overdueDays: overdue !== null ? Number(overdue) : undefined,
        minBalance: minBalance || undefined,
        includeInactive: sp.get('includeInactive') === '1',
      }),
    );
  } catch (err) {
    return routeError(err, 'GET /api/letters/recipients');
  }
}
