/**
 * GET /api/agent/whoami — for an agent (AGENT_ACCESS.md): who it is here and which books these
 * are. Its name, roles and mode; the company's name, fiscal year, report basis, home currency,
 * closing date, time zone and today's date there; and which optional features the company uses.
 *
 * A chosen set of facts, never the company's settings object (which also holds the network and
 * password rules). A person calling it gets the same company facts and `agent: null`.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { agentCompanyInfo } from '@/lib/agent/companyInfo';
import { routeError } from '@/lib/routeErrors';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await agentCompanyInfo(ctx), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return routeError(err, 'agent/whoami/route');
  }
}
