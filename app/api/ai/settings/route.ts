/**
 * GET /api/ai/settings  → AiSettingsView (API keys are never returned — only hasApiKey).
 * PUT /api/ai/settings  → update (admin/owner). Body: UpdateSettingsInput
 *   { providers?: [{ id?, kind, label, baseUrl?, model, enabled, timeoutMs?, apiKey? (write-only), clearApiKey? }],
 *     taskPolicies?: { categorize|assistant|error-correction: 'local-only'|'local-then-cloud'|'cloud-only' },
 *     cloudEnabled?, autoApplyEnabled?, autoApplyThreshold? (0.5–1), llmSuggestEnabled? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { allowCloudPurpose } from '@/lib/services/networkPolicy';
import { getServerContext } from '@/lib/context';
import { getPublicSettings, updateSettings } from '@/lib/services/aiSettings';
import { aiErrorResponse } from '../_errors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getPublicSettings(ctx));
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/settings');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = await req.json().catch(() => ({}));
    const view = await updateSettings(ctx, body ?? {});
    // "Allow cloud AI for this company" is one switch: it also lets AI through the company's
    // Privacy & Network policy (lib/services/networkPolicy.ts allowCloudPurpose), so nobody has
    // to find a second page. Offline mode and a machine ceiling are reported, never overridden.
    let networkNotice: string | null = null;
    if (view.cloudEnabled && body && (body as { cloudEnabled?: unknown }).cloudEnabled === true) {
      networkNotice = (await allowCloudPurpose(ctx, 'ai')).notice;
    }
    return NextResponse.json({ ...view, networkNotice });
  } catch (err) {
    return aiErrorResponse(err, 'PUT /api/ai/settings');
  }
}
