/**
 * GET /api/agent/hello?tag=<file tag>&nonce=<hex> — an agent's connector checks, before it shows
 * its token, that the program answering on this port is the Ironbooks that published the
 * endpoint file it read (lib/agent/endpointFile.ts helloProof).
 *
 * Public and read-only, and it never opens the company file: the answer is a keyed hash of the
 * caller's own random nonce, useless to anyone who cannot already read the endpoint file in the
 * signed-in person's own profile folder. 404 unless this run published an endpoint for that tag
 * (a company file with no agents publishes none), and for anything that came through the
 * multi-user proxy: agents work only on the computer that holds the company file.
 */
import { NextRequest, NextResponse } from 'next/server';
import { helloProof } from '@/lib/agent/endpointFile';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  if (req.headers.get('x-bka-remote-addr') || req.headers.get('sec-bka-proxy')) return notFound();
  const proof = helloProof(req.nextUrl.searchParams.get('tag'), req.nextUrl.searchParams.get('nonce'));
  if (!proof) return notFound();
  return NextResponse.json({ proof }, { headers: NO_STORE });
}
