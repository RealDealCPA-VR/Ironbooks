/**
 * POST /api/accountant-copy/open — body: the client's .ibac transfer file (raw bytes).
 *   ?inspect=1  only check the file and describe it
 * Otherwise restores it (fully verified) into a NEW company-file folder next to the open one and
 * turns it into the accountant's working copy. The open company file is not changed.
 * Owner/admin only (the file carries every user of the client's file).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { dataDirOf } from '@/lib/db/txHooks';
import { routeError } from '@/lib/routeErrors';
import { ServiceError } from '@/lib/services/_base';
import {
  defaultAccountantCopyDir,
  inspectTransferFile,
  openAccountantCopyFile,
} from '@/lib/services/accountantCopy/accountant';

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      throw new ServiceError('FORBIDDEN', "Only the company owner or an admin can open an Accountant's Copy.");
    }
    const buffer = Buffer.from(await req.arrayBuffer());
    if (!buffer.byteLength) {
      return NextResponse.json({ error: 'Choose the transfer file first.', code: 'VALIDATION' }, { status: 400 });
    }
    const info = inspectTransferFile(buffer);
    if (req.nextUrl.searchParams.get('inspect') === '1') return NextResponse.json(info);
    const target = defaultAccountantCopyDir(info.companyName, dataDirOf(ctx.db) ?? undefined);
    return NextResponse.json(await openAccountantCopyFile(buffer, target), { status: 201 });
  } catch (err) {
    return routeError(err, '/api/accountant-copy/open');
  }
}
