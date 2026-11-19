/**
 * GET /api/network-policy — the company's Privacy & Network policy, the machine-wide ceiling
 *                           (BKA_NETWORK_MODE), the per-purpose verdict for each cloud service,
 *                           and recent outbound activity (host + purpose + verdict only). Also
 *                           whether the open company file is held on this computer
 *                           (lib/net/fileTrust.ts): heldForThisComputer, heldServices (purpose,
 *                           label, public hosts) and heldHosts — what the note on this page and a
 *                           one-line pointer on the AI and Send Forms pages need — and canAllowHere.
 * PUT /api/network-policy — replace the policy. Body: { mode, cloudOptIn: { ai, email,
 *                           'vendor-lookup', updates }, vendorLookupUrl }. Owner/admin only;
 *                           audited. Only from the computer that holds the company file
 *                           (lib/net/hostOnly.ts): the mode, the cloud opt-ins and the vendor
 *                           lookup address decide where the host connects. From another
 *                           computer GET answers canEdit: false and hostOnly: true.
 *                           Body { allowOnThisComputer: true } instead: "Allow on this computer" —
 *                           approve the company file's internet services on this computer
 *                           (an Admin at this computer only; audited).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { ServiceError, type ServiceContext } from '@/lib/services/_base';
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
import { allowFileOnThisComputer, approveQuietFileHere, holdStatus, internetHeldHere } from '@/lib/net/fileTrust';
import { serviceErrorStatus } from '@/lib/routeErrors';
import { HOST_ONLY_ACTION_MESSAGE, hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';

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
  'vendor-lookup': 'https://searx.example.com/',
  updates: 'https://github.com/',
};

async function describe(ctx: ServiceContext, policy: NetworkPolicy, canEdit: boolean, hostOnly = false) {
  const ceiling = envModeCeiling();
  // A company file this computer has not approved: the verdicts below are what really happens here.
  const heldHere = await internetHeldHere(ctx.db);
  const hold = heldHere ? await holdStatus(ctx.db) : { heldForThisComputer: false, heldServices: [], heldHosts: [] };
  const mode = effectiveMode(policy.mode, ceiling);
  return {
    policy,
    canEdit,
    /** An admin using another computer: the page says these are changed on the host. */
    hostOnly,
    ceiling: ceiling ?? null,
    effectiveMode: heldHere && mode === 'allow-cloud' ? 'tailnet-only' : mode,
    purposes: OUTBOUND_PURPOSES.map((p) => ({
      purpose: p,
      ...PURPOSE_INFO[p],
      // Vendor lookup: the verdict for the company's own SearXNG address once one is set.
      cloud: decideOutbound(policy, (p === 'vendor-lookup' && policy.vendorLookupUrl) || SAMPLE_CLOUD_URL[p], p, ceiling, { heldHere }),
    })),
    ...hold,
    /** "Allow on this computer" is offered: the note shows and the viewer is an Admin at this computer. */
    canAllowHere: hold.heldForThisComputer && canEdit,
    recent: recentOutbound(ctx.companyId),
  };
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const remote = isRemoteRequest(req);
    const admin = isAdminRole(ctx.role);
    return NextResponse.json(await describe(ctx, await getNetworkPolicy(ctx), admin && !remote, admin && remote));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const allowHere = Boolean(body && typeof body === 'object' && (body as { allowOnThisComputer?: unknown }).allowOnThisComputer === true);
    if (isRemoteRequest(req)) return hostOnlyResponse(allowHere ? HOST_ONLY_ACTION_MESSAGE : undefined);
    if (allowHere) {
      // Approving is for an Admin sitting at this computer (the remote case is refused above).
      if (!isAdminRole(ctx.role)) {
        throw new ServiceError('FORBIDDEN', 'Only an owner or admin can allow internet services for this company file.');
      }
      await allowFileOnThisComputer(ctx);
      return NextResponse.json(await describe(ctx, await getNetworkPolicy(ctx), true));
    }
    // A file from another computer whose own settings reach nothing on the internet is approved
    // here by its first save from an Admin at this computer, before what they choose now applies.
    await approveQuietFileHere(ctx, { remote: isRemoteRequest(req) }).catch((err) => console.warn('[file-trust] could not approve the company file on this computer:', (err as Error)?.message ?? err));
    const policy = await setNetworkPolicy(ctx, body);
    return NextResponse.json(await describe(ctx, policy, true));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Alias of PUT (the shared api client exposes patch). */
export async function PATCH(req: NextRequest) {
  return PUT(req);
}
