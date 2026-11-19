/**
 * GET /api/handshake?nonce=<hex> — the desktop shell's start-up check that the program answering
 * on the port it chose is the server it started (lib/net/internalToken.ts serverCheckProof).
 *
 * Public, read-only, touches no company data: the answer is a keyed hash of the caller's own
 * random nonce, useless to anyone who does not already hold the shell's per-launch token.
 * 404 when this server was not started by the desktop shell (no token) or the nonce is malformed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { serverCheckProof } from '@/lib/net/internalToken';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const proof = serverCheckProof(req.nextUrl.searchParams.get('nonce'));
  if (!proof) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json({ proof }, { headers: { 'Cache-Control': 'no-store' } });
}
