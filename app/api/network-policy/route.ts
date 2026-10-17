/**
 * GET /api/network-policy — the company's Privacy & Network policy, the machine-wide ceiling
 *                           (BKA_NETWORK_MODE), the per-purpose verdict for each cloud service,
 *                           and recent outbound activity (host + purpose + verdict only).
 * PUT /api/network-policy — replace the policy. Body: { mode, cloudOptIn: { ai, email,
 *                           'bank-feeds', updates } }. Owner/admin only; audited.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError } from '@/lib/services/_base';
import { getNetworkPolicy, setNetworkPolicy } from '@/lib/services/networkPolicy';
import { isAdminRole } from '@/lib/services/sessions';
import { recentOutbound } from '@/lib/net/guard';
import {
  OUTBOUND_PURPOSES,
  PURPOSE_INFO,
  decideOutbound,
  effectiveMode,
  envModeCeiling,
  type NetworkPolicy,
  type OutboundPurpose,
} from '@/lib/net/policy';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[network-policy] unexpected error:', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** A representative public destination per purpose, to show the current cloud verdict. */
const SAMPLE_CLOUD_URL: Record<OutboundPurpose, string> = {
  ai: 'https://api.anthropic.com/',
  email: 'smtps://smtp.example.com:465',
  'bank-feeds': 'https://production.plaid.com/',
  updates: 'https://github.com/',
};

function describe(policy: NetworkPolicy, companyId: string, canEdit: boolean) {
  const ceiling = envModeCeiling();
  return {
    policy,
    canEdit,
    ceiling: ceiling ?? null,
    effectiveMode: effectiveMode(policy.mode, ceiling),
    purposes: OUTBOUND_PURPOSES.map((p) => ({
      purpose: p,
      ...PURPOSE_INFO[p],
      cloud: decideOutbound(policy, SAMPLE_CLOUD_URL[p], p, ceiling),
    })),
    recent: recentOutbound(companyId),
  };
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(describe(await getNetworkPolicy(ctx), ctx.companyId, isAdminRole(ctx.role)));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const policy = await setNetworkPolicy(ctx, body);
    return NextResponse.json(describe(policy, ctx.companyId, true));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Alias of PUT (the shared api client exposes patch). */
export async function PATCH(req: NextRequest) {
  return PUT(req);
}
