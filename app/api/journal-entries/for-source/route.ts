/**
 * GET /api/journal-entries/for-source?ref=invoice:<id> — the journal entry a document posted, so
 * Ctrl+Y (QuickBooks "Transaction Journal") and Ctrl+H work from an open invoice, bill, check, …
 * (components/KeyboardCommands.tsx). Answers the latest live (not voided) entry for that document;
 * an edited document posts a new entry, which is the one shown. 404 when it posted nothing (a
 * pending invoice, say).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { getServerContext } from '@/lib/context';
import { creditMemos, invoices, journalEntries, paymentsReceived, salesReceipts } from '@/lib/db/schema';
import { routeError } from '@/lib/routeErrors';

/** "<type>:<uuid>" with a known document type. */
const REF_RE =
  /^(invoice|bill|expense|salesreceipt|credit_memo|payment|deposit|vendor_credit|paycheck|refund|bill_payment):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A/R documents that record the entry they posted (postedEntryId). That entry wins over the
 * sourceRef search: a received payment posts under `customer:<id>` (its `payment:<id>` entries are
 * later exchange-rate adjustments), and a sales receipt's COGS entries carry its own
 * `salesreceipt:<id>` sourceRef and the same creation time.
 */
const POSTED_ENTRY = {
  invoice: invoices,
  salesreceipt: salesReceipts,
  credit_memo: creditMemos,
  payment: paymentsReceived,
} as const;

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const ref = req.nextUrl.searchParams.get('ref') ?? '';
    if (!REF_RE.test(ref)) {
      return NextResponse.json({ error: 'ref must look like "invoice:<id>".', code: 'VALIDATION' }, { status: 400 });
    }
    const [type, docId] = ref.split(':');
    const doc = POSTED_ENTRY[type.toLowerCase() as keyof typeof POSTED_ENTRY] as typeof invoices | undefined;
    if (doc) {
      const [own] = await ctx.db
        .select({ id: journalEntries.id })
        .from(doc)
        .innerJoin(journalEntries, eq(journalEntries.id, doc.postedEntryId))
        .where(
          and(
            eq(doc.companyId, ctx.companyId),
            eq(doc.id, docId),
            eq(journalEntries.companyId, ctx.companyId),
            ne(journalEntries.status, 'void'),
            isNull(journalEntries.voidedAt),
          ),
        )
        .limit(1);
      if (own) return NextResponse.json({ entryId: own.id });
    }
    const [row] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, ref),
          ne(journalEntries.status, 'void'),
          isNull(journalEntries.voidedAt),
        ),
      )
      .orderBy(desc(journalEntries.createdAt))
      .limit(1);
    if (!row) return NextResponse.json({ error: 'This transaction has not posted to the books yet.', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ entryId: row.id });
  } catch (err) {
    return routeError(err, 'GET /api/journal-entries/for-source');
  }
}
