/**
 * GET /api/journal-entries/for-source?ref=invoice:<id> — the journal entry a document posted, so
 * Ctrl+Y (QuickBooks "Transaction Journal") and Ctrl+H work from an open invoice, bill, check, …
 * (components/KeyboardCommands.tsx). Answers the document's OWN live entry (its postedEntryId —
 * an edited document posts a new entry and points at it). Other entries share a document's source
 * link (a payment's later exchange-rate plugs, …), so the newest live entry with the link is only
 * the fallback, for documents without a posted-entry column (refunds) or legacy rows. 404 when it
 * posted nothing (a pending invoice, say).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getServerContext } from '@/lib/context';
import {
  bills,
  creditMemos,
  deposits,
  expenses,
  invoices,
  journalEntries,
  paychecks,
  paymentsReceived,
  salesReceipts,
  vendorCredits,
} from '@/lib/db/schema';
import { routeError } from '@/lib/routeErrors';

/** "<type>:<uuid>" with a known document type. */
const REF_RE =
  /^(invoice|bill|expense|salesreceipt|credit_memo|payment|deposit|vendor_credit|paycheck|refund|bill_payment):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DocTable = PgTable & { id: PgColumn; companyId: PgColumn; postedEntryId: PgColumn };

/** Document tables that record the entry the document posted. */
const DOC_TABLES: Record<string, DocTable> = {
  invoice: invoices,
  bill: bills,
  expense: expenses,
  salesreceipt: salesReceipts,
  credit_memo: creditMemos,
  payment: paymentsReceived,
  deposit: deposits,
  vendor_credit: vendorCredits,
  paycheck: paychecks,
};

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const ref = req.nextUrl.searchParams.get('ref') ?? '';
    if (!REF_RE.test(ref)) {
      return NextResponse.json({ error: 'ref must look like "invoice:<id>".', code: 'VALIDATION' }, { status: 400 });
    }
    const [type, id] = [ref.slice(0, ref.indexOf(':')).toLowerCase(), ref.slice(ref.indexOf(':') + 1)];

    // 1. The document's own entry, when it is still live.
    const table = DOC_TABLES[type];
    if (table) {
      const [own] = await ctx.db
        .select({ id: journalEntries.id })
        .from(table)
        .innerJoin(journalEntries, eq(journalEntries.id, table.postedEntryId))
        .where(
          and(
            eq(table.id, id),
            eq(table.companyId, ctx.companyId),
            eq(journalEntries.companyId, ctx.companyId),
            ne(journalEntries.status, 'void'),
            isNull(journalEntries.voidedAt),
          ),
        )
        .limit(1);
      if (own) return NextResponse.json({ entryId: own.id });
    }

    // 2. Fallback: the newest live entry carrying the document's source link.
    const [row] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `${type}:${id}`),
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
