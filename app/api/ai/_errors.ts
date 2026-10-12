/**
 * Shared error mapping for /api/ai/* routes (same code → status table as the other routes,
 * plus AiError: no eligible/working model → 503 so the UI can show "configure a model").
 */
import { NextResponse } from 'next/server';
import { ServiceError } from '@/lib/services/_base';
import { AiError } from '@/lib/ai/types';

export function aiErrorResponse(err: unknown, route: string): NextResponse {
  if (err instanceof ServiceError) {
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      VALIDATION: 400,
      UNBALANCED: 400,
      PERIOD_CLOSED: 400,
      FORBIDDEN: 403,
      CONFLICT: 409,
    };
    return NextResponse.json(
      { error: err.message, code: err.code, details: err.details ?? null },
      { status: statusMap[err.code] ?? 500 },
    );
  }
  if (err instanceof AiError) {
    const status = err.code === 'CONFIG' ? 400 : 503;
    return NextResponse.json({ error: err.message, code: `AI_${err.code}` }, { status });
  }
  console.error(`[${route}]`, err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
