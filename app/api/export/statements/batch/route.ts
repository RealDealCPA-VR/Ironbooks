/**
 * GET /api/export/statements/batch
 *
 * Month-end batch statement generation for ALL active customers with
 * something to report (QB "Create Statements" for everyone at once).
 *
 * Query params:
 *   format = balance_forward | open_item   (default balance_forward)
 *   output = pdf | zip                     (default pdf)
 *            pdf — one combined PDF (statements concatenated)
 *            zip — one PDF per customer, zipped (adm-zip)
 *   from, to   — balance_forward period (optional ISO dates)
 *   asOf       — open_item statement date (optional ISO date, default today)
 */
import { NextRequest, NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';
import { tagSandbox } from '@/lib/pdf/sandboxStamp';
import { getServerContext } from '@/lib/context';
import {
  batchStatements,
  type StatementFormat,
} from '@/lib/services/statements';
import { getCompany } from '@/lib/services/company';
import { buildStatementPdf } from '@/lib/pdf/forms';
import { ServiceError } from '@/lib/services/_base';
import { renderOpenItemStatementPdf } from '../openItemPdf';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  console.error('[export/statements/batch] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

function parseDate(value: string | null, name: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) throw new ServiceError('VALIDATION', `Invalid ${name} date.`);
  return d;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'customer';
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const format: StatementFormat =
      searchParams.get('format') === 'open_item' ? 'open_item' : 'balance_forward';
    const output = searchParams.get('output') === 'zip' ? 'zip' : 'pdf';
    const from = parseDate(searchParams.get('from'), 'from');
    const to = parseDate(searchParams.get('to'), 'to');
    const asOf = parseDate(searchParams.get('asOf'), 'asOf') ?? new Date();

    const ctx = await getServerContext();
    const entries = await batchStatements(ctx, { format, from, to, asOf });
    if (entries.length === 0) {
      return NextResponse.json(
        { error: 'No customers with balances or activity to generate statements for.' },
        { status: 404 },
      );
    }

    const company = await getCompany(ctx);
    const companyName = company?.name ?? 'Your Company';
    const today = new Date().toISOString().slice(0, 10);

    // Render each customer's statement PDF.
    const rendered: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const entry of entries) {
      const bytes =
        entry.format === 'open_item'
          ? await renderOpenItemStatementPdf(entry.statement, companyName)
          : await buildStatementPdf(ctx, entry.statement);
      rendered.push({ name: `statement-${safeName(entry.displayName)}.pdf`, bytes });
    }

    if (output === 'zip') {
      const zip = new AdmZip();
      for (const r of rendered) {
        zip.addFile(r.name, Buffer.from(r.bytes));
      }
      const buf = zip.toBuffer();
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="statements-${format}-${today}.zip"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    // Combined PDF: merge every statement's pages into one document.
    const combined = await PDFDocument.create();
    for (const r of rendered) {
      const doc = await PDFDocument.load(r.bytes);
      const pages = await combined.copyPages(doc, doc.getPageIndices());
      for (const p of pages) combined.addPage(p);
    }
    tagSandbox(combined); // each statement's pages were stamped when it was rendered
    const merged = await combined.save();
    const buffer = merged.buffer.slice(
      merged.byteOffset,
      merged.byteOffset + merged.byteLength,
    ) as ArrayBuffer;

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="statements-${format}-${today}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
