/**
 * POST /api/dashboard/auto-backup — produce a .bka backup for the Electron shell's
 * quit-time auto-backup (electron/main.js writes it to userData/backups with rotation).
 *
 * Auth: the Electron main process has no session cookie, so it authenticates with the
 * per-launch random internal token it generated itself and passed to this server as
 * BKA_INTERNAL_TOKEN (same trusted-local-system pattern as /api/recurring/run — the
 * server is bound to 127.0.0.1 and the token never leaves the machine). A normal
 * authenticated session is also accepted.
 *
 * NOTE: GET /api/backup is the user-facing manual download and requires a session;
 * this route exists because the desktop shell cannot present one. It reuses the exact
 * same createBackup() service, so the archive format is identical.
 */
import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { getServerContext } from '@/lib/context';
import { getCompany } from '@/lib/services/company';
import { createBackup } from '@/lib/services/backup';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { requireFileAdmin } from '@/lib/services/access';

/** Constant-time check of the x-bka-internal header against BKA_INTERNAL_TOKEN. */
async function internalContext(req: NextRequest): Promise<ServiceContext | null> {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return null;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const db = await getDb();
  const [company] = await db
    .select({ id: companies.id, ownerId: companies.ownerId })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  if (!company) return null;
  return { db, companyId: company.id, userId: company.ownerId };
}

export async function POST(req: NextRequest) {
  try {
    // Fail closed BEFORE producing any backup bytes.
    let ctx = await internalContext(req);
    if (!ctx) {
      // A user session gets the same whole-file archive as GET /api/backup, so it needs the
      // same gate: an active Admin of every company in the file.
      ctx = await getServerContext();
      await requireFileAdmin(ctx);
    }

    // Company name is cosmetic (filename slug only).
    let companyName: string | undefined;
    try {
      companyName = (await getCompany(ctx))?.name ?? undefined;
    } catch {
      /* proceed without it */
    }

    const { buffer, filename } = createBackup(companyName);
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
    if (err instanceof ServiceError) {
      const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'VALIDATION' ? 400 : 500;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    // Do not leak raw error text (may contain absolute data-dir paths).
    console.error('[auto-backup] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
