/**
 * GET /api/ai/proposals[?status=pending|approved|rejected] → { proposals: ProposalView[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { listProposals } from '@/lib/services/aiAssistant';
import { aiErrorResponse } from '../_errors';

const STATUSES = ['pending', 'approved', 'rejected', 'failed'];

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const status = req.nextUrl.searchParams.get('status') ?? undefined;
    if (status && !STATUSES.includes(status)) {
      return NextResponse.json({ error: `status must be one of: ${STATUSES.join(', ')}.` }, { status: 400 });
    }
    return NextResponse.json({ proposals: await listProposals(ctx, status) });
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/proposals');
  }
}
