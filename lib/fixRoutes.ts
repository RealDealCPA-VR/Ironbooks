/**
 * Route helper for "Fix errors where they happen": a 400 for an invalid body that also carries
 * fixes when the problem is a required account left empty ("Use 6000 Office Supplies on line 2"),
 * computed by lib/services/errorFixes.ts. Same body as zodErrorBody otherwise.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import type { ServiceContext } from '@/lib/services/_base';
import { missingAccountFixesForIssues, type DefaultAccountKind } from '@/lib/services/errorFixes';
import { zodErrorBody } from '@/lib/validation/helpers';

export async function zodErrorWithFixes(
  ctx: ServiceContext,
  error: z.ZodError,
  body: unknown,
  kind: DefaultAccountKind,
  opts: { purpose?: 'deposit' | 'check' } = {},
): Promise<NextResponse> {
  const base = zodErrorBody(error);
  // A failed lookup must never turn the user's 400 into a 500: fixes are a bonus.
  const fixes = await missingAccountFixesForIssues(ctx, base.issues, body, kind, opts).catch(() => []);
  return NextResponse.json(fixes.length ? { ...base, fixes } : base, { status: 400 });
}
