/**
 * POST /api/company-file/save-as?target=<path> — write a copy of the open company to a new
 * single company file (File > Save Copy As…, and converting an older folder company file to a
 * single file). The copy gets its own identity.
 *
 * Internal token only: the shell asked the person for `target` in a native Save dialog. A page
 * can never name a path on this computer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isInternalRequest } from '@/lib/net/internalToken';
import { saveCopyAs } from '@/lib/services/companyFileSave';

export async function POST(req: NextRequest) {
  if (!isInternalRequest(req)) {
    return NextResponse.json({ error: 'Not allowed.', code: 'FORBIDDEN' }, { status: 403 });
  }
  const target = req.nextUrl.searchParams.get('target');
  if (!target) return NextResponse.json({ error: 'target is required', code: 'VALIDATION' }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { companyName?: unknown; convert?: unknown };
  try {
    const result = await saveCopyAs(target, {
      companyName: typeof body?.companyName === 'string' ? body.companyName : null,
      // Converting a company folder into a single file continues the same company (its backups too).
      keepBackupHistory: body?.convert === true,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const code = (err as { code?: string }).code;
    return NextResponse.json(
      { ok: false, error: (err as Error).message, code: code === 'VALIDATION' ? 'VALIDATION' : 'INTERNAL' },
      { status: code === 'VALIDATION' ? 400 : 500 },
    );
  }
}
