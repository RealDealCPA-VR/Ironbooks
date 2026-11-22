'use client';
/**
 * What an agent ran and asked for (plan 7.1): its last 200 operations and requests, newest first
 * (GET /api/agents/[id]/activity), each linked to the approval center or the audit trail. A
 * request's own link opens that request (the approval center reads `id`); an operation's opens its
 * entry in the audit trail (that page reads `id`).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Spinner, Td, Th, Tr } from '@/components/ui';
import { api } from '@/lib/client';
import type { AgentActivityRow } from '@/lib/agent/contract';
import { ACTIVITY_INTRO, ACTIVITY_STATUS_LABELS, ACTIVITY_STATUS_TONES, RISK_CLASS_LABELS, when } from './words';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/**
 * The approval center (app/agent-requests), for one agent or one request. That page opens one
 * request from `id`, and starts with only one agent's requests from `agentId`, so the link at the
 * top is named for what it opens: this agent's requests.
 */
export function approvalCenterHref(q: { agentId?: string; requestId?: string }): string {
  const p = new URLSearchParams();
  if (q.agentId) p.set('agentId', q.agentId);
  if (q.requestId) p.set('id', q.requestId);
  const s = p.toString();
  return s ? `/agent-requests?${s}` : '/agent-requests';
}

/**
 * The audit trail (app/audit-trail). With `id` the page opens that entry at the top, scrolled to
 * and expanded, above the whole trail.
 */
export function auditTrailHref(auditId?: string | null): string {
  return auditId ? `/audit-trail?id=${encodeURIComponent(auditId)}` : '/audit-trail';
}

export default function ActivitySection({ agentId }: { agentId: string }) {
  const [rows, setRows] = useState<AgentActivityRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ activity: AgentActivityRow[] }>(`/api/agents/${encodeURIComponent(agentId)}/activity`);
      setRows(Array.isArray(res.activity) ? res.activity : []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
      setRows([]);
    }
  }, [agentId]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-navy/60">{ACTIVITY_INTRO}</p>
        <span className="flex gap-3 text-sm">
          <Link href={approvalCenterHref({ agentId })} className="text-electric hover:underline">
            Its requests in the approval center
          </Link>
          <Link href={auditTrailHref()} className="text-electric hover:underline">
            Audit trail
          </Link>
        </span>
      </div>
      {rows === null ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-slate-200 p-4 text-center text-sm text-navy/50">Nothing yet. What the agent does and asks for is listed here.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" aria-label="What the agent did and asked for">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>Kind of work</Th>
                <Th>Outcome</Th>
                <Th>Approved by</Th>
                <Th className="text-right">
                  <span className="sr-only">Links</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Tr key={`${r.kind}-${r.requestId ?? r.auditId ?? i}-${i}`} data-activity={r.kind}>
                  <Td className="whitespace-nowrap text-sm">{when(r.at, '')}</Td>
                  <Td>
                    <span className="text-sm">{r.summary || r.operation}</span>
                    <span className="block text-xs text-navy/40">{r.kind === 'request' ? 'Asked' : 'Ran'}</span>
                  </Td>
                  <Td>{r.class ? <Badge>{RISK_CLASS_LABELS[r.class] ?? r.class}</Badge> : null}</Td>
                  <Td>
                    <Badge tone={ACTIVITY_STATUS_TONES[r.status] ?? 'neutral'}>{ACTIVITY_STATUS_LABELS[r.status] ?? r.status}</Badge>
                  </Td>
                  <Td className="text-sm">{r.approvedByName ?? ''}</Td>
                  <Td className="text-right whitespace-nowrap text-sm">
                    <span className="inline-flex gap-3">
                      {r.requestId && (
                        <Link href={approvalCenterHref({ requestId: r.requestId })} className="text-electric hover:underline">
                          Request
                        </Link>
                      )}
                      {r.auditId && (
                        <Link href={auditTrailHref(r.auditId)} className="text-electric hover:underline">
                          Audit trail
                        </Link>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
