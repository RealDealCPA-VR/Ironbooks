/**
 * GET  /api/backup/company?companyId=<id>  — download a per-company .bka (one tenant's rows).
 * POST /api/backup/company?name=<optional> — restore a per-company .bka as a NEW company
 *                                            (raw bytes in request body). Other companies
 *                                            in the data dir are never touched.
 *
 * SECURITY: middleware excludes /api from the session check, so both handlers fail closed
 * via getServerContext(). Export additionally verifies the caller is a MEMBER of the
 * requested company (never exports another tenant's data). Restore requires write access
 * (viewers are read-only app-wide).
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { getServerContext } from '@/lib/context';
import { companies, userCompanies } from '@/lib/db/schema';
import { createCompanyBackup, restoreCompanyBackup } from '@/lib/services/backup';
import { ServiceError } from '@/lib/services/_base';
import { assertExclusiveAccess } from '@/lib/services/sessions';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status =
      err.code === 'NOT_FOUND' ? 404
      : err.code === 'VALIDATION' ? 400
      : err.code === 'FORBIDDEN' ? 403
      : err.code === 'CONFLICT' ? 409
      : 500;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  // Do not leak raw error text (may contain absolute data-dir paths / OS details).
  console.error('[backup/company] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** The caller may export a company only if they are a member (or it is their active company). */
async function assertMembership(
  ctx: Awaited<ReturnType<typeof getServerContext>>,
  companyId: string,
): Promise<void> {
  if (companyId === ctx.companyId) return;
  if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'Authentication required.');
  const [member] = await ctx.db
    .select({ companyId: userCompanies.companyId })
    .from(userCompanies)
    .where(and(eq(userCompanies.userId, ctx.userId), eq(userCompanies.companyId, companyId)));
  if (member) return;
  const [owned] = await ctx.db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.ownerId, ctx.userId)));
  if (!owned) throw new ServiceError('FORBIDDEN', 'You are not a member of that company.');
}

// ---------------------------------------------------------------------------
// GET — download a per-company backup
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const companyId = req.nextUrl.searchParams.get('companyId') ?? ctx.companyId;
    await assertMembership(ctx, companyId);

    const { buffer, filename } = await createCompanyBackup(ctx.db, companyId);
    const arrayBuf: ArrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(arrayBuf, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST — restore as a NEW company
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    if (ctx.role === 'viewer') {
      throw new ServiceError('FORBIDDEN', 'Your role is view-only. This action requires write access.');
    }
    if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'Authentication required.');
    await assertExclusiveAccess(ctx, 'Restore');

    const arrayBuffer = await req.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return NextResponse.json({ error: 'Request body is empty.' }, { status: 400 });
    }

    const name = req.nextUrl.searchParams.get('name') ?? undefined;
    const result = await restoreCompanyBackup(ctx.db, Buffer.from(arrayBuffer), {
      ownerId: ctx.userId,
      name,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
