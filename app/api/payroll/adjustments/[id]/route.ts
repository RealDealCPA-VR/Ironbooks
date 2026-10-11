/**
 * DELETE /api/payroll/adjustments/[id] — void a YTD / liability adjustment (its GL entry too,
 * when it affected accounts). To change one, void it and enter it again.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { voidPayrollAdjustment } from '@/lib/services/payrollAdjustments';
import { routeError } from '@/lib/routeErrors';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    return NextResponse.json(await voidPayrollAdjustment(ctx, id));
  } catch (err) {
    return routeError(err, 'payroll/adjustments/[id]');
  }
}
