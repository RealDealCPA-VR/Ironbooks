/**
 * Accountant's Copy (PARITY I1).
 * GET  /api/accountant-copy                   → status: none | client (a copy is out) | accountant (this file is the copy)
 * POST /api/accountant-copy { dividingDate }  → create the copy; responds with the .ibac transfer file
 * POST /api/accountant-copy { saveAgain: true } → the transfer file of the copy that is out, saved
 *      again (the first Save was cancelled or the file was lost): same copy id, file token and
 *      dividing date (saveTransferFileAgain)
 *
 * Creating (or saving again) writes every company and user of the file into the transfer file
 * (like a portable company file), so it needs an Admin of every company (requireFileAdmin).
 *
 * Both take { password } (filecrypto; the page offers it, on by default): the transfer file is
 * encrypted under it and opening it needs it. { protect: false } saves it without a password.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { dataDirOf } from '@/lib/db/txHooks';
import { fileResponse } from '@/lib/fileDownload';
import { invalidJsonBody, readJsonObject, routeError } from '@/lib/routeErrors';
import { requireFileAdmin } from '@/lib/services/access';
import { accountantCopyStatus, createAccountantCopy, saveTransferFileAgain } from '@/lib/services/accountantCopy/client';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await accountantCopyStatus(ctx));
  } catch (err) {
    return routeError(err, '/api/accountant-copy');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    await requireFileAdmin(ctx);
    const body = await readJsonObject(req);
    if (!body) return invalidJsonBody();
    const dataDir = dataDirOf(ctx.db) ?? resolveDataDir();
    if (body.protect !== false && (typeof body.password !== 'string' || !body.password)) {
      return NextResponse.json({ error: 'Enter a password for the transfer file, or choose to save it without one.', code: 'VALIDATION' }, { status: 400 });
    }
    const password = body.protect === false ? null : (body.password as string);
    const res =
      body.saveAgain === true
        ? await saveTransferFileAgain(ctx, { dataDir, password })
        : await createAccountantCopy(ctx, { dividingDate: String(body.dividingDate ?? ''), dataDir, password });
    return fileResponse(res.buffer, res.filename, { 'X-Accountant-Copy-Id': res.copy.id });
  } catch (err) {
    return routeError(err, '/api/accountant-copy');
  }
}
