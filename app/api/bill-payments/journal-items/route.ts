/**
 * General Journal A/P items of a vendor in Pay Bills (QB invariant I11).
 *
 * GET  /api/bill-payments/journal-items?vendorId=
 *        → { charges, credits } — open JE A/P credits (amounts owed, payable in Pay Bills) and
 *          debits (vendor credits, applicable to bills)
 * POST /api/bill-payments/journal-items
 *        { action: 'apply_credit', journalLineId, billId | chargeLineId, amount, date? }
 *                                   — JE vendor credit → bill, or → General Journal amount owed
 *        { action: 'unapply', applicationId } — remove one credit application
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getServerContext } from '@/lib/context';
import {
  applyJournalCredit,
  listJournalOpenItems,
  unapplyJournalApplication,
} from '@/lib/services/journalApplications';
import { routeError } from '@/lib/routeErrors';
import { zDate, zMoneyPositive, zUuid, zodErrorBody } from '@/lib/validation/helpers';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply_credit'),
    journalLineId: zUuid,
    /** The bill to apply the credit to — or `chargeLineId`, a General Journal amount owed (P1). */
    billId: zUuid.nullish(),
    chargeLineId: zUuid.nullish(),
    amount: zMoneyPositive,
    date: zDate.nullish(),
  }),
  z.object({ action: z.literal('unapply'), applicationId: zUuid }),
]);

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const vendorId = req.nextUrl.searchParams.get('vendorId');
    if (!vendorId) {
      return NextResponse.json({ error: 'vendorId is required', code: 'VALIDATION' }, { status: 400 });
    }
    return NextResponse.json(await listJournalOpenItems(ctx, 'ap', vendorId));
  } catch (err) {
    return routeError(err, 'GET /api/bill-payments/journal-items');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    const b = parsed.data;
    if (b.action === 'apply_credit') {
      const application = await applyJournalCredit(ctx, {
        journalLineId: b.journalLineId,
        billId: b.billId ?? null,
        chargeLineId: b.chargeLineId ?? null,
        amount: b.amount,
        date: b.date ?? null,
      });
      return NextResponse.json({ application }, { status: 201 });
    }
    const application = await unapplyJournalApplication(ctx, b.applicationId);
    return NextResponse.json({ application });
  } catch (err) {
    return routeError(err, 'POST /api/bill-payments/journal-items');
  }
}
