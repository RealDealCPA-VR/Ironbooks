/**
 * POST /api/collections/email — email a late customer their overdue invoices or a statement
 * through the app's email flow, and record the contact (C9).
 * Body: { customerId, what: 'invoices' | 'statement', invoiceIds?, to?, followUpDate?, addTodo? }
 * Returns { sent, failed, note, todoId }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { emailCollectionReminder } from '@/lib/services/collections';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const b = await requireJsonObject(req);
    if (b.what !== 'invoices' && b.what !== 'statement') {
      return NextResponse.json({ error: "what must be 'invoices' or 'statement'.", code: 'VALIDATION' }, { status: 400 });
    }
    const invoiceIds = Array.isArray(b.invoiceIds) ? b.invoiceIds.filter((v): v is string => typeof v === 'string') : null;
    return NextResponse.json(
      await emailCollectionReminder(ctx, {
        customerId: typeof b.customerId === 'string' ? b.customerId : '',
        what: b.what,
        invoiceIds,
        to: str(b.to),
        followUpDate: str(b.followUpDate),
        addTodo: b.addTodo === true,
      }),
    );
  } catch (err) {
    return routeError(err, 'POST /api/collections/email');
  }
}
