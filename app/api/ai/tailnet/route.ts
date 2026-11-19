/**
 * GET /api/ai/tailnet — discover Tailscale peers via `tailscale status --json` (admin/owner).
 * Graceful when the CLI is absent: { available: false, reason, peers: [] }.
 * Each peer is returned with suggested model-server URLs (Ollama / LM Studio / vLLM / llama.cpp).
 * Only from the computer that holds the company file: it lists that computer's tailnet
 * (lib/net/hostOnly.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requireRole } from '@/lib/services/rbac';
import { KNOWN_MODEL_PORTS, discoverTailnetPeers } from '@/lib/ai/tailnet';
import { HOST_ONLY_ACTION_MESSAGE, hostOnlyResponse, isRemoteRequest } from '@/lib/net/hostOnly';
import { aiErrorResponse } from '../_errors';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    await requireRole(ctx, 'admin');
    if (isRemoteRequest(req)) return hostOnlyResponse(HOST_ONLY_ACTION_MESSAGE);
    const r = await discoverTailnetPeers();
    return NextResponse.json({
      ...r,
      peers: r.peers.map((p) => {
        const host = p.dnsName || p.ips.find((ip) => ip.includes('.')) || p.hostName;
        return {
          ...p,
          suggestions: KNOWN_MODEL_PORTS.map((k) => ({ kind: k.kind, label: k.label, baseUrl: `http://${host}:${k.port}` })),
        };
      }),
    });
  } catch (err) {
    return aiErrorResponse(err, 'GET /api/ai/tailnet');
  }
}
