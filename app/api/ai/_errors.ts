/**
 * Shared error mapping for /api/ai/* routes (same code → status table as the other routes,
 * plus AiError: no eligible/working model → 503 so the UI can show "configure a model").
 *
 * A ServiceError is answered with the same body as every other route (lib/routeErrors.ts
 * serviceErrorBody), so the fixes it carries reach the client: refusing to decide an agent's
 * proposal in Ask AI comes with "Open in Agent requests" and the link to the request.
 * `details` stays null when there are none, as these routes always answered.
 */
import { NextResponse } from 'next/server';
import { ServiceError } from '@/lib/services/_base';
import { AiError } from '@/lib/ai/types';
import { serviceErrorBody, serviceErrorStatus } from '@/lib/routeErrors';

export function aiErrorResponse(err: unknown, route: string): NextResponse {
  if (err instanceof ServiceError) {
    return NextResponse.json({ ...serviceErrorBody(err), details: err.details ?? null }, { status: serviceErrorStatus(err.code) });
  }
  if (err instanceof AiError) {
    const status = err.code === 'CONFIG' ? 400 : 503;
    return NextResponse.json({ error: err.message, code: `AI_${err.code}` }, { status });
  }
  console.error(`[${route}]`, err);
  return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
}
