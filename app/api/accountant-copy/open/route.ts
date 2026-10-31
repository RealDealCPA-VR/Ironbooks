/**
 * POST /api/accountant-copy/open — body: the client's .ibac transfer file (raw bytes).
 *   ?inspect=1  only check the file and describe it
 * Otherwise restores it (fully verified) into a NEW company-file folder next to the open one and
 * turns it into the accountant's working copy. The open company file is not changed.
 * Owner/admin only (the file carries every user of the client's file).
 *
 * A transfer file protected with a password (filecrypto) needs it in the x-ironbooks-password
 * header (base64url; never in the URL): 403 details.passwordRequired (details.wrongPassword)
 * otherwise; wrong passwords are rate-limited like sign-in.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { dataDirOf } from '@/lib/db/txHooks';
import { routeError } from '@/lib/routeErrors';
import { ServiceError } from '@/lib/services/_base';
import { unlockPortableBuffer } from '@/lib/services/portableFile';
import { filePasswordFrom, withFilePasswordLimit } from '@/lib/net/archiveCredentials';
import { originFromHeaders } from '@/lib/net/requestInfo';
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
    const raw = Buffer.from(await req.arrayBuffer());
    if (!raw.byteLength) {
      return NextResponse.json({ error: 'Choose the transfer file first.', code: 'VALIDATION' }, { status: 400 });
    }
    const password = filePasswordFrom(req.headers);
    const buffer = await withFilePasswordLimit(password, originFromHeaders(req.headers).addr, () => unlockPortableBuffer(raw, password));
    const info = inspectTransferFile(buffer);
    if (req.nextUrl.searchParams.get('inspect') === '1') return NextResponse.json(info);
    const target = defaultAccountantCopyDir(info.companyName, dataDirOf(ctx.db) ?? undefined);
    return NextResponse.json(await openAccountantCopyFile(buffer, target), { status: 201 });
  } catch (err) {
    return routeError(err, '/api/accountant-copy/open');
  }
}
