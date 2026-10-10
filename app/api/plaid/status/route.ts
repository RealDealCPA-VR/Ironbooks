/**
 * GET /api/plaid/status
 * Returns { configured, allowed, reason } so the UI can show the appropriate state without
 * exposing any credentials. `allowed` reflects the company's Privacy & Network policy — bank
 * feeds contact *.plaid.com, so they stay off unless the company opted in to cloud bank feeds.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { isConfigured } from '@/lib/services/plaid';
import { getNetworkPolicy } from '@/lib/services/networkPolicy';
import { decideOutbound } from '@/lib/net/policy';

export async function GET() {
  let allowed = false;
  let reason = 'Sign in to check bank-feed availability.';
  try {
    const ctx = await getServerContext();
    const decision = decideOutbound(await getNetworkPolicy(ctx), 'https://production.plaid.com/', 'bank-feeds');
    allowed = decision.allowed;
    reason = decision.reason;
  } catch {
    /* unauthenticated/locked: report not allowed, never leak details */
  }
  return NextResponse.json({ configured: isConfigured(), allowed, reason });
}
