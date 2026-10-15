/**
 * POST /api/checks/pdf
 *
 * Renders a printable check PDF in the company's check style (voucher / standard / wallet) with
 * its printer setup (Print Checks > Printer setup): alignment offsets, check position on the
 * sheet, field positions, check height, paper size. Modes:
 *
 * 1. From a recorded document in the print queue:
 *      { source: 'expense' | 'bill_payment' | 'paycheck' | 'payment_check', id: string, checkNumber?: string }
 *    (+ optional firstSheetRemaining for standard checks: which of the 3 slots it lands in)
 *    or the legacy { expenseId, checkNumber? }.
 *    Payee ("print on check as" name), amount, date, memo (vendor account number when blank),
 *    payee address and the voucher detail are pulled from the recorded transaction.
 *
 * 1b. Batch — several recorded checks in ONE PDF:
 *      { items: [{ source, id, checkNumber? }, ...], firstSheetRemaining?: 1 | 2 | 3 }
 *    Standard checks are packed three per sheet (the first sheet starts below the used checks
 *    when `firstSheetRemaining` < 3; defaults to the saved setup); voucher / wallet checks print
 *    one per sheet.
 *
 * 2. Ad-hoc (quick check, not recorded):
 *      { payee: string, amount: string, date: string, memo?: string, checkNumber?: string }
 *
 * 3. Alignment test page: { alignmentTest: true, style?, stock?, offsetX?, offsetY?, position?,
 *    pageSize?, checkHeight?, firstSheetRemaining?, layout? } — sample check(s) printed with the
 *    given (unsaved) settings so the user can line them up with their stock. Standard style fills
 *    the remaining checks of the first sheet.
 *
 * Response: application/pdf (inline)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { companyLetterhead } from '@/lib/pdf/forms';
import {
  checkPrintData,
  getCheckPrintSettings,
  parseCheckLayoutSettings,
  PRINT_SOURCES,
  type PrintSource,
} from '@/lib/services/printQueue';
import {
  renderChecksPdf,
  numberToWords,
  CHECK_STOCKS,
  CHECK_STYLES,
  type CheckPdfData,
  type CheckRenderSettings,
  type CheckStock,
  type CheckStyle,
} from '@/lib/pdf/check';
import { pdfResponse, routeError } from '@/lib/routeErrors';
import { validation } from '@/lib/services/_base';

/** Most checks accepted in one batch PDF. */
const MAX_BATCH = 300;

const str = (v: unknown) => (v != null && String(v).trim() !== '' ? String(v).trim() : undefined);

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const ctx = await getServerContext();
    const company = await getCompany(ctx);
    if (!company) {
      return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    const letterhead = await companyLetterhead(ctx);
    const companyInfo = { name: company.name, addressLines: letterhead.addressLines };
    const settings = await getCheckPrintSettings(ctx);

    const render: CheckRenderSettings = {
      style: settings.style,
      stock: settings.stock,
      offset: { x: settings.offsetX, y: settings.offsetY },
      position: settings.position,
      layout: settings.layout,
      pageSize: settings.pageSize,
      checkHeight: settings.checkHeight,
      firstSheetRemaining: settings.firstSheetRemaining,
    };

    // Checks left on the first sheet for this print run (standard checks); defaults to the setup.
    if (body.alignmentTest !== true && body.firstSheetRemaining != null) {
      render.firstSheetRemaining = parseCheckLayoutSettings(
        { firstSheetRemaining: body.firstSheetRemaining as number | string },
        settings.style,
        settings,
      ).firstSheetRemaining;
    }

    // --- Mode 1b: batch of recorded checks → one PDF ---
    if (Array.isArray(body.items)) {
      const items = body.items as unknown[];
      if (items.length === 0) throw validation('Pick at least one check to print.');
      if (items.length > MAX_BATCH) throw validation(`Print at most ${MAX_BATCH} checks at a time.`);
      const checks: CheckPdfData[] = [];
      for (const raw of items) {
        const it = (raw ?? {}) as Record<string, unknown>;
        if (typeof it.source !== 'string' || !PRINT_SOURCES.includes(it.source as PrintSource) || typeof it.id !== 'string') {
          throw validation('Each check needs a source and an id.');
        }
        const data = await checkPrintData(ctx, it.source as PrintSource, it.id);
        checks.push({
          company: companyInfo,
          payee: data.payee,
          payeeAddress: data.payeeAddress,
          amountNumeric: data.amount,
          amountWords: numberToWords(data.amount),
          date: data.date,
          memo: data.memo ?? undefined,
          checkNumber: str(it.checkNumber) ?? data.checkNumber ?? undefined,
          voucher: data.voucher,
        });
      }
      const nums = checks.map((c) => c.checkNumber).filter((n) => n != null);
      const name =
        nums.length > 1 ? `checks-${nums[0]}-${nums[nums.length - 1]}.pdf` : nums.length === 1 ? `check-${nums[0]}.pdf` : 'checks.pdf';
      return pdfResponse(await renderChecksPdf(checks, render), name);
    }

    let payee: string;
    let payeeAddress: string[] | undefined;
    let amount: string;
    let date: string;
    let memo: string | undefined;
    let checkNumber = str(body.checkNumber);
    let voucher: CheckPdfData['voucher'];
    let copies = 1;

    const source: PrintSource | null =
      typeof body.source === 'string' && PRINT_SOURCES.includes(body.source as PrintSource)
        ? (body.source as PrintSource)
        : typeof body.expenseId === 'string'
          ? 'expense'
          : null;
    const docId = typeof body.id === 'string' ? body.id : typeof body.expenseId === 'string' ? body.expenseId : null;

    if (body.alignmentTest === true) {
      payee = 'ALIGNMENT TEST — DO NOT DEPOSIT';
      payeeAddress = ['123 Sample Street', 'Anytown, ST 12345'];
      amount = '1234.56';
      date = new Date().toISOString().slice(0, 10);
      memo = 'Alignment test';
      checkNumber = checkNumber ?? '0000';
      voucher = [{ account: 'Sample account', description: 'Sample line', amount: '1234.56' }];
      if (typeof body.style === 'string' && CHECK_STYLES.includes(body.style as CheckStyle)) render.style = body.style as CheckStyle;
      if (typeof body.stock === 'string' && CHECK_STOCKS.includes(body.stock as CheckStock)) render.stock = body.stock as CheckStock;
      if (body.offsetX != null) render.offset = { ...render.offset, x: String(body.offsetX) };
      if (body.offsetY != null) render.offset = { ...render.offset, y: String(body.offsetY) };
      // Unsaved layout settings: validated exactly as Save would.
      const extra = parseCheckLayoutSettings(
        {
          position: body.position as string | null | undefined,
          pageSize: body.pageSize as string | null | undefined,
          checkHeight: body.checkHeight as string | number | null | undefined,
          firstSheetRemaining: body.firstSheetRemaining as string | number | null | undefined,
          layout: body.layout,
        },
        render.style ?? settings.style,
        settings,
      );
      Object.assign(render, extra);
      if (render.style === 'standard') copies = extra.firstSheetRemaining;
    } else if (source && docId) {
      // --- Mode 1: render from a recorded document (with voucher stub) ---
      const data = await checkPrintData(ctx, source, docId);
      payee = data.payee;
      payeeAddress = data.payeeAddress;
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

    const check: CheckPdfData = {
      company: companyInfo,
      payee,
      payeeAddress,
      amountNumeric: amount,
      amountWords: numberToWords(amount),
      date,
      memo,
      checkNumber,
      voucher,
    };
    const pdfBytes = await renderChecksPdf(Array.from({ length: copies }, () => check), render);

    return pdfResponse(pdfBytes, checkNumber ? `check-${checkNumber}.pdf` : 'check.pdf');
  } catch (err) {
    return routeError(err, 'POST /api/checks/pdf');
  }
}
