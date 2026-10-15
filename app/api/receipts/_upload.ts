/**
 * Shared helpers for the receipt upload routes (desktop drop zone and phone link): read ONE file
 * from a multipart body without trusting the client's size or type, and start reading the
 * receipt in the background so it is ready by the time someone opens it.
 */
import { NextResponse } from 'next/server';
import type { ServiceContext } from '@/lib/services/_base';
import { extractReceipt } from '@/lib/services/receipts';

/** Multipart overhead allowed on top of the file itself. */
const ENVELOPE_BYTES = 256 * 1024;

export type ReadFileResult =
  | { ok: true; filename: string; bytes: Uint8Array }
  | { ok: false; response: NextResponse };

const fail = (status: number, error: string) => ({ ok: false as const, response: NextResponse.json({ error, code: 'VALIDATION' }, { status }) });

/** The `file` field of a multipart/form-data request, refusing oversized bodies up front. */
export async function readUploadedFile(req: Request, maxBytes: number): Promise<ReadFileResult> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data/i.test(type)) return fail(415, 'Send the receipt as a file upload (multipart/form-data).');
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(declared)) return fail(411, 'The upload size is missing.');
  if (declared > maxBytes + ENVELOPE_BYTES) {
    return fail(413, `That file is too big. Receipts can be up to ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, 'The upload could not be read.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail(400, 'Choose a photo or PDF to upload.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { ok: true, filename: file.name || 'receipt', bytes };
}

/** Read the receipt after the response is sent (claims the row; a reader that is already busy wins). */
export function readInBackground(ctx: ServiceContext, id: string): void {
  void extractReceipt(ctx, id).catch((err) => {
    console.warn('[receipts] background read failed:', err instanceof Error ? err.message : err);
  });
}
