/**
 * Phone upload links (receipt capture).
 * GET  /api/receipts/upload-links  — links of this company that still work
 * POST /api/receipts/upload-links  — new link: { token, expiresAt, maxUploads, ... }. The token is
 *                                    shown once (in the QR code) and only its hash is stored.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { createUploadToken, listUploadTokens } from '@/lib/services/receipts';

const noStore = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ links: await listUploadTokens(ctx) }, { headers: noStore });
  } catch (err) {
    return routeError(err, 'GET /api/receipts/upload-links');
  }
}

export async function POST() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await createUploadToken(ctx), { status: 201, headers: noStore });
  } catch (err) {
    return routeError(err, 'POST /api/receipts/upload-links');
  }
}
