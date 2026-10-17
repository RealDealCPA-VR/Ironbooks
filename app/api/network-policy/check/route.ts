/**
 * GET /api/network-policy/check?purpose=<ai|email|bank-feeds|updates>&url=<destination>
 *
 * Ask the network policy whether a destination may be contacted. Used by the Electron shell
 * (which has no session cookie) before checking for updates, and to decide which remote
 * origins the window may load (Plaid Link, only when bank feeds are opted in).
 *
 * Auth: the per-launch internal token (x-bka-internal — same trusted-local pattern as
 * /api/dashboard/auto-backup; resolves to the file's primary company) or a normal session.
 */
import { timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { asc } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import { getServerContext } from '@/lib/context';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
import { getNetworkPolicy } from '@/lib/services/networkPolicy';
import { decideOutbound, isOutboundPurpose } from '@/lib/net/policy';
import { applySandboxToDecision } from '@/lib/services/sandboxState';
import { serviceErrorStatus } from '@/lib/routeErrors';

async function internalContext(
  req: NextRequest,
): Promise<Pick<ServiceContext, 'db' | 'companyId'> | null> {
  const token = process.env.BKA_INTERNAL_TOKEN;
  const header = req.headers.get('x-bka-internal');
  if (!token || !header) return null;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const db = await getDb();
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .orderBy(asc(companies.createdAt))
    .limit(1);
  if (!company) return null;
  return { db, companyId: company.id };
}

export async function GET(req: NextRequest) {
  try {
    const purpose = req.nextUrl.searchParams.get('purpose');
    const url = req.nextUrl.searchParams.get('url');
    if (!isOutboundPurpose(purpose) || !url) {
      return NextResponse.json(
        { error: 'purpose and url are required.', code: 'VALIDATION' },
        { status: 400 },
      );
    }
    const ctx = (await internalContext(req)) ?? (await getServerContext());
    // A question, not a connection — decided without adding to the outbound activity log.
    // Sandbox mode: update checks / bank feeds / email are off in a practice copy.
    return NextResponse.json(applySandboxToDecision(decideOutbound(await getNetworkPolicy(ctx), url, purpose)));
  } catch (err) {
    if (err instanceof ServiceError) {
      const status = serviceErrorStatus(err.code);
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('[network-policy/check] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
