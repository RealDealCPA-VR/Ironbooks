/**
 * POST /api/checks/pdf
 *
 * Renders a printable check PDF in the company's check style (voucher / standard / wallet) with
 * its printer alignment offsets (Print Checks > Printer setup). Modes:
 *
 * 1. From a recorded document in the print queue:
 *      { source: 'expense' | 'bill_payment' | 'paycheck' | 'payment_check', id: string, checkNumber?: string }
 *    or the legacy { expenseId, checkNumber? }.
 *    Payee ("print on check as" name), amount, date, memo (vendor account number when blank) and
 *    the voucher detail are pulled from the recorded transaction.
 *
 * 2. Ad-hoc (quick check, not recorded):
 *      { payee: string, amount: string, date: string, memo?: string, checkNumber?: string }
 *
 * 3. Alignment test page: { alignmentTest: true, style?, stock?, offsetX?, offsetY? } — a sample check
 *    printed with the given (unsaved) settings so the user can line it up with their stock.
 *
 * Response: application/pdf (inline)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { checkPrintData, getCheckPrintSettings, PRINT_SOURCES, type PrintSource } from '@/lib/services/printQueue';
import {
  renderCheckPdf,
  numberToWords,
  CHECK_STOCKS,
  CHECK_STYLES,
  type CheckStock,
  type CheckStyle,
  type VoucherLine,
} from '@/lib/pdf/check';
import { pdfResponse, routeError } from '@/lib/routeErrors';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const ctx = await getServerContext();
    const company = await getCompany(ctx);
    if (!company) {
      return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    const settings = await getCheckPrintSettings(ctx);

    let payee: string;
    let amount: string;
    let date: string;
    let memo: string | undefined;
    let checkNumber =
      body.checkNumber != null && String(body.checkNumber).trim() !== ''
        ? String(body.checkNumber).trim()
        : undefined;
    let voucher: VoucherLine[] | undefined;
    let style: CheckStyle = settings.style;
    let stock: CheckStock = settings.stock;
    let offset: { x: string | number; y: string | number } = { x: settings.offsetX, y: settings.offsetY };

    const source: PrintSource | null =
      typeof body.source === 'string' && PRINT_SOURCES.includes(body.source as PrintSource)
        ? (body.source as PrintSource)
        : typeof body.expenseId === 'string'
          ? 'expense'
          : null;
    const docId = typeof body.id === 'string' ? body.id : typeof body.expenseId === 'string' ? body.expenseId : null;

    if (body.alignmentTest === true) {
      payee = 'ALIGNMENT TEST — DO NOT DEPOSIT';
      amount = '1234.56';
      date = new Date().toISOString().slice(0, 10);
      memo = 'Alignment test';
      checkNumber = checkNumber ?? '0000';
      voucher = [{ account: 'Sample account', description: 'Sample line', amount: '1234.56' }];
      if (typeof body.style === 'string' && CHECK_STYLES.includes(body.style as CheckStyle)) style = body.style as CheckStyle;
      if (typeof body.stock === 'string' && CHECK_STOCKS.includes(body.stock as CheckStock)) stock = body.stock as CheckStock;
      if (body.offsetX != null) offset = { ...offset, x: String(body.offsetX) };
      if (body.offsetY != null) offset = { ...offset, y: String(body.offsetY) };
    } else if (source && docId) {
      // --- Mode 1: render from a recorded document (with voucher stub) ---
      const data = await checkPrintData(ctx, source, docId);
      payee = data.payee;
      amount = data.amount;
      date = data.date;
      memo = data.memo ?? undefined;
      checkNumber = checkNumber ?? data.checkNumber ?? undefined;
      voucher = data.voucher;
    } else {
      // --- Mode 2: ad-hoc quick check ---
      if (!body.payee || typeof body.payee !== 'string' || !body.payee.trim()) {
        return NextResponse.json({ error: 'payee is required', code: 'VALIDATION' }, { status: 400 });
      }
      if (!body.amount || typeof body.amount !== 'string' || isNaN(parseFloat(body.amount))) {
        return NextResponse.json({ error: 'amount must be a valid decimal string', code: 'VALIDATION' }, { status: 400 });
      }
      if (!body.date || typeof body.date !== 'string' || !body.date.trim()) {
        return NextResponse.json({ error: 'date is required', code: 'VALIDATION' }, { status: 400 });
      }
      payee = body.payee.trim();
      amount = body.amount.trim();
      date = body.date.trim();
      memo = body.memo && typeof body.memo === 'string' ? body.memo.trim() : undefined;
    }

    const pdfBytes = await renderCheckPdf({
      company: { name: company.name },
      payee,
      amountNumeric: amount,
      amountWords: numberToWords(amount),
      date,
      memo,
      checkNumber,
      voucher,
      style,
      stock,
      offset,
    });

    return pdfResponse(pdfBytes, checkNumber ? `check-${checkNumber}.pdf` : 'check.pdf');
  } catch (err) {
    return routeError(err, 'POST /api/checks/pdf');
  }
}
