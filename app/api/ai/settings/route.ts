/**
 * GET /api/ai/settings  → AiSettingsView (API keys are never returned — only hasApiKey) plus
 *                         `hostOnly`: true when the page is used from another computer, so it shows
 *                         the host-only controls read-only.
 * PUT /api/ai/settings  → update (admin/owner). Body: UpdateSettingsInput
 *   { providers?: [{ id?, kind, label, baseUrl?, model, enabled, timeoutMs?, apiKey? (write-only), clearApiKey? }],
 *     taskPolicies?: { categorize|assistant|error-correction: 'local-only'|'local-then-cloud'|'cloud-only' },
 *     cloudEnabled?, autoApplyEnabled?, autoApplyThreshold? (0.5–1), llmSuggestEnabled? }
 *
 * From another computer (lib/net/hostOnly.ts) an Admin may still save what never makes the host
 * connect anywhere new: switch saved AI on or off, pick a model, change names, keys, routing,
 * limits and auto-apply, remove an AI, turn cloud AI off. Adding an AI, changing one's type or
 * server address, and turning cloud AI on (which also opens Privacy & Network) are refused: an
 * address typed on another computer would make the host connect to its own loopback or office
 * network.
 */
import { NextRequest, NextResponse } from 'next/server';
import { allowCloudPurpose } from '@/lib/services/networkPolicy';
import { getServerContext } from '@/lib/context';
import { getPublicSettings, updateSettings, updateSettingsSchema, type AiSettingsView } from '@/lib/services/aiSettings';
import { hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';
import { approveQuietFileHere } from '@/lib/net/fileTrust';
import { aiErrorResponse } from '../_errors';

function normUrl(u: string | null | undefined): string {
  return (u ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Would this save, asked for from another computer, add an AI, change a saved one's type or
 * server address, or turn cloud AI on? A body the service would refuse anyway is left to it.
 */
function changesWhereHostConnects(body: unknown, current: AiSettingsView): boolean {
  const parsed = updateSettingsSchema.safeParse(body);
  if (!parsed.success) return false;
  const saved = new Map(current.providers.map((p) => [p.id, p]));
  for (const p of parsed.data.providers ?? []) {
    const prev = p.id ? saved.get(p.id) : undefined;
    if (!prev || prev.kind !== p.kind || normUrl(prev.baseUrl) !== normUrl(p.baseUrl)) return true;
  }
  return parsed.data.cloudEnabled === true && !current.cloudEnabled;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    return NextResponse.json({ ...(await getPublicSettings(ctx)), hostOnly: isRemoteRequest(req) });
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/settings');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const remote = isRemoteRequest(req);
    const body = await req.json().catch(() => ({}));
    if (remote && changesWhereHostConnects(body, await getPublicSettings(ctx))) return hostOnlyResponse();
    await approveQuietFileHere(ctx, { remote }).catch((err) => console.warn('[file-trust] could not approve the company file on this computer:', (err as Error)?.message ?? err));
    const view = await updateSettings(ctx, body ?? {});
    // "Allow cloud AI for this company" is one switch: it also lets AI through the company's
    // Privacy & Network policy (lib/services/networkPolicy.ts allowCloudPurpose), so nobody has
    // to find a second page. Offline mode and a machine ceiling are reported, never overridden.
    // Not from another computer: Privacy & Network is changed only on the host.
    let networkNotice: string | null = null;
    if (!remote && view.cloudEnabled && body && (body as { cloudEnabled?: unknown }).cloudEnabled === true) {
      networkNotice = (await allowCloudPurpose(ctx, 'ai')).notice;
    }
    return NextResponse.json({ ...view, networkNotice, hostOnly: remote });
  } catch (err) {
    return aiErrorResponse(err, 'PUT /api/ai/settings');
  }
}
