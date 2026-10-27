/**
 * GET   /api/company — return the active company row
 * PATCH /api/company — update name and/or Preferences settings.
 *   Body (zod-validated, lib/validation/company.ts):
 *     { name?, settings?: CompanySettings }            — Preferences dialog shape
 *     { currency?, fiscalYearEnd?, timezone?, industry? } — legacy flat keys (onboarding)
 *   Settings keys outside the COMPANY_SETTINGS_KEYS whitelist are dropped by the
 *   service (closing date + finance charges have dedicated endpoints).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getCompany, redactCompany, updateCompany } from '@/lib/services/company';
import { ServiceError } from '@/lib/services/_base';
import { zodErrorBody } from '@/lib/validation/helpers';
import { updateCompanyBodySchema } from '@/lib/validation/company';
import { serviceErrorStatus } from '@/lib/routeErrors';

function errorResponse(err: unknown) {
  if (err instanceof ServiceError) {
    const status = serviceErrorStatus(err.code);
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  console.error('[company/route]', err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const company = await getCompany(ctx);
    if (!company) {
      return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
    }
    // Never hand the closing-date password hash to the browser (any member may call this).
    return NextResponse.json(redactCompany(company));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const parsed = updateCompanyBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
    }
    const { name, settings, currency, fiscalYearEnd, timezone, industry } = parsed.data;

    // Merge legacy flat keys (onboarding wizard) with the settings object.
    const settingsPatch = {
      ...(currency !== undefined ? { currency } : {}),
      ...(fiscalYearEnd !== undefined ? { fiscalYearEnd } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(industry !== undefined ? { industry } : {}),
      ...(settings ?? {}),
    };

    const updated = await updateCompany(ctx, {
      ...(name !== undefined ? { name } : {}),
      ...(Object.keys(settingsPatch).length > 0 ? { settings: settingsPatch } : {}),
    });
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
