'use client';
/**
 * An agent's standing permissions (plan 4.4, 7.1): what a person said yes to "for this and
 * similar ones", until when, and Revoke, which takes it back at once (DELETE /api/agent-grants/[id]).
 * Taking permission away is never held back, so Revoke does not ask first.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Spinner, Td, Th, Tr, toast } from '@/components/ui';
import { api } from '@/lib/client';
import type { AgentGrantView } from '@/lib/agent/contract';
import { GRANTS_INTRO, RISK_CLASS_LABELS, constraintText, when } from './words';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

export default function GrantsSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [grants, setGrants] = useState<AgentGrantView[] | null>(null);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ grants: AgentGrantView[] }>(`/api/agents/${encodeURIComponent(agentId)}/grants`);
      setGrants(Array.isArray(res.grants) ? res.grants : []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
      setGrants([]);
    }
  }, [agentId]);
  useEffect(() => {
    load();
  }, [load]);

  async function revoke(g: AgentGrantView) {
    setRevoking(g.id);
    try {
      await api.del(`/api/agent-grants/${encodeURIComponent(g.id)}`);
      toast(`Taken back. ${agentName} now asks again before "${g.operationLabel}".`, 'success');
      await load();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-navy/60">{GRANTS_INTRO}</p>
      {grants === null ? (
        <div className="flex justify-center p-4">
          <Spinner />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : grants.length === 0 ? (
        <p className="rounded-lg border border-slate-200 p-4 text-center text-sm text-navy/50">
          No standing permissions. Everything set to Ask waits for a person each time.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" aria-label="Standing permissions">
            <thead>
              <tr>
                <Th>What it covers</Th>
                <Th>Held to</Th>
                <Th>Given by</Th>
                <Th>Until</Th>
                <Th>Used</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const limits = constraintText(g.constraints);
                const gone = Boolean(g.revokedAt);
                return (
                  <Tr key={g.id} className={gone ? 'opacity-60' : ''}>
                    <Td>
                      <span className="text-sm font-semibold">{g.operationLabel || g.operation}</span>
                      <span className="block">
                        <Badge>{RISK_CLASS_LABELS[g.class] ?? g.class}</Badge>
                      </span>
                    </Td>
                    <Td className="text-xs text-navy/70">{limits.length ? limits.join(', ') : 'Nothing more'}</Td>
                    <Td className="text-sm">
                      {g.givenByName}
                      <span className="block text-xs text-navy/40">{when(g.createdAt)}</span>
                    </Td>
                    <Td className="text-sm">{gone ? 'Taken back' : when(g.expiresAt)}</Td>
                    <Td className="text-sm tabular-nums">{g.maxUses ? `${g.uses} of ${g.maxUses}` : g.uses}</Td>
                    <Td className="text-right whitespace-nowrap">
                      {!gone && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={revoking === g.id}
                          onClick={() => revoke(g)}
                          title="Take this standing permission back now"
                        >
                          Revoke
                        </Button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
