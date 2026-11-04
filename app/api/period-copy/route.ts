/**
 * POST /api/period-copy { from, to } — QB "Period Copy" (PARITY I7): a portable company file
 * (.bkp) of the active company holding only that date range (opening balances for earlier
 * activity, nothing after the end date), verified against this file's trial balance.
 * The summary rides in the X-Period-Copy-Summary header (URI-encoded JSON).
 * Needs an Admin of every company (the copy carries the file's users), like the portable file.
 *
 * filecrypto: { password } encrypts the whole .bkp (offered, on by default); { protect: false }
 * saves it without one — refused for a company file protected with passwords, whose copy is
 * always encrypted and, once restored, opens with the same user names and passwords.
 */
import { NextResponse, type NextRequest } from 'next/server';
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
    if (body.protect !== false && (typeof body.password !== 'string' || !body.password)) {
      return NextResponse.json({ error: 'Enter a password for the Period Copy, or choose to save it without one.', code: 'VALIDATION' }, { status: 400 });
    }
    const res = await createPeriodCopy(ctx, {
      from: String(body.from ?? ''),
      to: String(body.to ?? ''),
      dataDir: dataDirOf(ctx.db) ?? resolveDataDir(),
      password: body.protect === false ? null : (body.password as string),
    });
    return fileResponse(res.buffer, res.filename, {
      'X-Period-Copy-Summary': encodeURIComponent(JSON.stringify(res.summary)),
    });
  } catch (err) {
    return routeError(err, '/api/period-copy');
  }
}
