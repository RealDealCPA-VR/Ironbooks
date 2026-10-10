/**
 * GET /api/ai/tailnet — discover Tailscale peers via `tailscale status --json` (admin/owner).
 * Graceful when the CLI is absent: { available: false, reason, peers: [] }.
 * Each peer is returned with suggested model-server URLs (Ollama / LM Studio / vLLM / llama.cpp).
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { requireRole } from '@/lib/services/rbac';
import { KNOWN_MODEL_PORTS, discoverTailnetPeers } from '@/lib/ai/tailnet';
import { aiErrorResponse } from '../_errors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    await requireRole(ctx, 'admin');
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
