/**
 * POST /api/collections/contacts — record a collection contact or note (C9).
 * Body: { customerId, method?: 'call'|'email'|'letter'|'statement'|'visit'|'other'|null, note?,
 *         invoiceId?, followUpDate?: 'YYYY-MM-DD', addTodo?: boolean, addCustomerNote?: boolean }
 * Returns { note, todoId, customerNoteId }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { CONTACT_METHODS, type ContactMethod, recordCollectionContact } from '@/lib/services/collections';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const b = await requireJsonObject(req);
    const method = str(b.method);
    if (method && !CONTACT_METHODS.includes(method as ContactMethod)) {
      return NextResponse.json({ error: 'Unknown contact method.', code: 'VALIDATION' }, { status: 400 });
    }
    const result = await recordCollectionContact(ctx, {
      customerId: typeof b.customerId === 'string' ? b.customerId : '',
      method: method as ContactMethod | null,
      note: typeof b.note === 'string' ? b.note : null,
      invoiceId: str(b.invoiceId),
      followUpDate: str(b.followUpDate),
      addTodo: b.addTodo === true,
      addCustomerNote: b.addCustomerNote === true,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/collections/contacts');
  }
}
