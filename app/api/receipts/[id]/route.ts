/**
 * One receipt.
 * GET    /api/receipts/[id]  — what was read + suggestions (matched vendor, expense account,
 *                              paying account, kind of transaction)
 * DELETE /api/receipts/[id]  — remove a receipt that was not saved as a transaction (and its file)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { deleteReceipt, getReceipt, receiptSuggestions } from '@/lib/services/receipts';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const receipt = await getReceipt(ctx, id);
    const suggestions = receipt.status === 'saved' ? null : await receiptSuggestions(ctx, id);
    return NextResponse.json({ receipt, suggestions });
  } catch (err) {
    return routeError(err, 'GET /api/receipts/[id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    await deleteReceipt(ctx, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return routeError(err, 'DELETE /api/receipts/[id]');
  }
}
