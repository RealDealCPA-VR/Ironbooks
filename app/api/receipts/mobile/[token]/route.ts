/**
 * Phone upload link (receipt capture) — the ONLY receipt route that works without a session.
 * Mapped 'public' in lib/permissions/routes.ts: the token in the URL is the credential.
 *
 * GET  /api/receipts/mobile/[token]  — { companyName, expiresAt, remaining, maxBytes }
 * POST /api/receipts/mobile/[token]  — multipart/form-data `file` (one photo / PDF per request)
 *
 * What the token can do: add receipts to the inbox of the ONE company it was made for, until it
 * expires (15 minutes), is turned off, or its upload limit is reached — nothing else. It never
 * reads data back (the answer is only "received" and how many uploads are left). Invalid or
 * expired tokens count against the caller's address (lib/net/rateLimit.ts) so tokens can't be
 * guessed; files are checked by their bytes and size (lib/receipts/files.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { routeError } from '@/lib/routeErrors';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { LoginRateLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { MOBILE_MAX_BYTES } from '@/lib/receipts/files';
import { UploadTokenError, uploadLinkStatus, uploadWithToken } from '@/lib/services/receipts';
import { readInBackground, readUploadedFile } from '../../_upload';

type RouteContext = { params: Promise<{ token: string }> };

const g = globalThis as unknown as { __bkaReceiptLinkLimiter?: LoginRateLimiter };
/** 10 bad links per address per 15 minutes, then a growing lockout. */
function limiter(): LoginRateLimiter {
  return (g.__bkaReceiptLinkLimiter ??= new LoginRateLimiter({
    maxFailures: 10,
    windowMs: 15 * 60 * 1000,
    lockoutMs: 5 * 60 * 1000,
    maxLockoutMs: 60 * 60 * 1000,
  }));
}

const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

async function guard(): Promise<{ keys: string[]; blocked: NextResponse | null }> {
  const { addr } = await getRequestOrigin();
  const keys = [`receipt-link:addr:${addr}`];
  const verdict = limiter().check(keys);
  if (verdict.allowed) return { keys, blocked: null };
  const r = tooManyAttempts(verdict.retryAfterMs);
  return { keys, blocked: NextResponse.json(r.body, { status: 429, headers: { ...HEADERS, 'Retry-After': r.retryAfter } }) };
}

function answerError(err: unknown, keys: string[], tag: string): NextResponse {
  if (err instanceof UploadTokenError) {
    limiter().recordFailure(keys);
    const status = err.problem === 'invalid' ? 404 : err.problem === 'not_allowed' ? 403 : 410;
    return NextResponse.json({ error: err.message, code: err.problem }, { status, headers: HEADERS });
  }
  const res = routeError(err, tag);
  for (const [k, v] of Object.entries(HEADERS)) res.headers.set(k, v);
  return res;
}

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { keys, blocked } = await guard();
  if (blocked) return blocked;
  try {
    const { token } = await params;
    const db = await getDb();
    return NextResponse.json(await uploadLinkStatus(db, token), { headers: HEADERS });
  } catch (err) {
    return answerError(err, keys, 'GET /api/receipts/mobile/[token]');
  }
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  const { keys, blocked } = await guard();
  if (blocked) return blocked;
  try {
    const { token } = await params;
    const db = await getDb();
    // Check the link before reading a (possibly large) body.
    await uploadLinkStatus(db, token);
    const file = await readUploadedFile(req, MOBILE_MAX_BYTES);
    if (!file.ok) {
      for (const [k, v] of Object.entries(HEADERS)) file.response.headers.set(k, v);
      return file.response;
    }
    const { receipt, remaining, ctx } = await uploadWithToken(db, token, { filename: file.filename, bytes: file.bytes });
    if (receipt.status === 'pending') readInBackground(ctx, receipt.id);
    return NextResponse.json(
      { received: true, filename: receipt.filename, remaining },
      { status: 201, headers: HEADERS },
    );
  } catch (err) {
    return answerError(err, keys, 'POST /api/receipts/mobile/[token]');
  }
}
