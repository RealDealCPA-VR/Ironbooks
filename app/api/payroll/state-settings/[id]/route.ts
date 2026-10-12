/** DELETE /api/payroll/state-settings/[id] — remove a state's SUI/SDI settings for a year. */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { deleteStateTaxSetting } from '@/lib/services/payrollAdjustments';
import { routeError } from '@/lib/routeErrors';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getServerContext();
    const { id } = await params;
    return NextResponse.json(await deleteStateTaxSetting(ctx, id));
  } catch (err) {
    return routeError(err, 'payroll/state-settings/[id]');
  }
}
