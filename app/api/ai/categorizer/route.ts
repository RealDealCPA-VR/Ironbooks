/**
 * GET  /api/ai/categorizer → { status, autoApplied[] } — learned-model stats + recent AI auto-posts.
 * POST /api/ai/categorizer { action: 'retrain' } → retrain from all posted history (write roles).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requireWrite } from '@/lib/services/rbac';
import { listAutoApplied, modelStatus, retrainModel } from '@/lib/services/aiCategorizer';
import { aiErrorResponse } from '../_errors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    const [status, autoApplied] = await Promise.all([modelStatus(ctx), listAutoApplied(ctx, 25)]);
    return NextResponse.json({ status, autoApplied });
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/categorizer');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    if (body?.action !== 'retrain') {
      return NextResponse.json({ error: "action must be 'retrain'." }, { status: 400 });
    }
    await requireWrite(ctx);
    const summary = await retrainModel(ctx);
    return NextResponse.json({ summary });
  } catch (err) {
    return aiErrorResponse(err, 'POST /api/ai/categorizer');
  }
}
