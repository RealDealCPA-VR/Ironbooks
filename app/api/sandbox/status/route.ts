/**
 * GET /api/sandbox/status — the banner flag ({ active, kind, text }), public so the
 * "SANDBOX — changes here don't affect your real books" bar also shows on the sign-in and
 * unlock pages of a sandbox copy. Reveals nothing but whether this is a practice copy.
 */
import { NextResponse } from 'next/server';
import { SANDBOX_BANNER_TEXT, TRAINING_BANNER_TEXT, activeSandbox } from '@/lib/services/sandboxState';

export const dynamic = 'force-dynamic';

export async function GET() {
  const marker = activeSandbox();
  return NextResponse.json(
    {
      active: marker !== null,
      kind: marker?.kind ?? null,
      text: marker ? (marker.kind === 'training' ? TRAINING_BANNER_TEXT : SANDBOX_BANNER_TEXT) : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
