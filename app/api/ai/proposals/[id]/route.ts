/**
 * POST /api/ai/proposals/:id { action: 'approve' | 'reject' } → { proposal }
 *
 * Approve posts the proposed journal entry through journal.createManualEntry → postJournalEntry
 * under the caller's own permissions (viewers get 403; closed periods need the closing-date
 * password header like any other posting).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { approveProposal, rejectProposal } from '@/lib/services/aiAssistant';
import { aiErrorResponse } from '../../_errors';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'approve') return NextResponse.json({ proposal: await approveProposal(ctx, id) });
    if (body?.action === 'reject') return NextResponse.json({ proposal: await rejectProposal(ctx, id) });
    return NextResponse.json({ error: "action must be 'approve' or 'reject'." }, { status: 400 });
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/proposals/:id');
  }
}
