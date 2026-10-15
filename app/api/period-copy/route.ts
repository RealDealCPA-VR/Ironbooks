/**
 * POST /api/period-copy { from, to } — QB "Period Copy" (PARITY I7): a portable company file
 * (.bkp) of the active company holding only that date range (opening balances for earlier
 * activity, nothing after the end date), verified against this file's trial balance.
 * The summary rides in the X-Period-Copy-Summary header (URI-encoded JSON).
 * Needs an Admin of every company (the copy carries the file's users), like the portable file.
 */
import { type NextRequest } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { fileResponse } from '@/lib/fileDownload';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { requireFileAdmin } from '@/lib/services/access';
import { createPeriodCopy } from '@/lib/services/periodCopy';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    await requireFileAdmin(ctx);
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const res = await createPeriodCopy(ctx, {
      from: String(body.from ?? ''),
      to: String(body.to ?? ''),
      dataDir: dataDirOf(ctx.db) ?? resolveDataDir(),
    });
    return fileResponse(res.buffer, res.filename, {
      'X-Period-Copy-Summary': encodeURIComponent(JSON.stringify(res.summary)),
    });
  } catch (err) {
    return routeError(err, '/api/period-copy');
  }
}
