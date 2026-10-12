/**
 * GET /api/integrity/books-in-balance
 *
 * Live "Books in balance" status for the current company: trial balance debits = credits,
 * accrual and cash-basis balance sheets balance, every cached account balance equals its
 * ledger-derived balance, and the database ledger guards are active.
 *
 * Response shape: BooksInBalance (lib/services/integrity.ts)
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { booksInBalance } from '@/lib/services/integrity';
import { ServiceError } from '@/lib/services/_base';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const result = await booksInBalance(ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      const status =
        err.code === 'NOT_FOUND' ? 404
        : err.code === 'FORBIDDEN' ? 403
        : err.code === 'VALIDATION' || err.code === 'UNBALANCED' ? 400
        : err.code === 'CONFLICT' ? 409
        : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[integrity/books-in-balance] Unexpected error', err);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
