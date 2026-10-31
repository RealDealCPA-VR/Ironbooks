/**
 * GET /api/transaction-log/download — the raw running transaction log (`.bktlg`, hash-chained
 *   JSON Lines), streamed byte for byte as it stands at the request (lib/services/transactionLogExport.ts).
 * GET /api/transaction-log/download?part=verification — the verification report for those bytes
 *   (size, SHA-256, head hash and the app's chain + journal-entry verification), as JSON.
 *
 * Owner / admin / accountant who manage every company the log records; a file utility (a copy
 * of part of the company file), like a portable copy.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { prepareRawLogDownload, streamFilePrefix, transactionLogVerificationReport } from '@/lib/services/transactionLogExport';

/** attachment; filename (ASCII fallback) + filename* (UTF-8). */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (req.nextUrl.searchParams.get('part') === 'verification') {
      const { filename, report } = await transactionLogVerificationReport(ctx);
      return new NextResponse(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': disposition(filename), 'Cache-Control': 'no-store' },
      });
    }
    const raw = await prepareRawLogDownload(ctx);
    return new Response(streamFilePrefix(raw.file, raw.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': disposition(raw.filename),
        'Content-Length': String(raw.bytes),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return routeError(err, 'transaction-log/download');
  }
}
