/**
 * Receipts inbox (receipt capture).
 * GET  /api/receipts?status=open|saved|all  — receipts waiting for review (default), saved, or all
 * POST /api/receipts                        — multipart/form-data `file`: add a photo / PDF to the
 *                                             Doc Center inbox as a receipt; reading starts at once
 *                                             in the background (on this machine).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { listReceipts, uploadReceipt } from '@/lib/services/receipts';
import { RECEIPT_MAX_BYTES } from '@/lib/receipts/files';
import { readInBackground, readUploadedFile } from './_upload';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const s = req.nextUrl.searchParams.get('status');
    const status = s === 'saved' || s === 'all' ? s : 'open';
    return NextResponse.json({ receipts: await listReceipts(ctx, { status }) });
  } catch (err) {
    return routeError(err, 'GET /api/receipts');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const file = await readUploadedFile(req, RECEIPT_MAX_BYTES);
    if (!file.ok) return file.response;
    const receipt = await uploadReceipt(ctx, { filename: file.filename, bytes: file.bytes, source: 'desktop' });
    if (receipt.status === 'pending') readInBackground(ctx, receipt.id);
    return NextResponse.json({ receipt }, { status: 201 });
  } catch (err) {
    return routeError(err, 'POST /api/receipts');
  }
}
