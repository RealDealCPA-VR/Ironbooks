'use client';
/**
 * An agent's standing permissions (plan 4.4, 7.1): what a person said yes to "for this and
 * similar ones", who gave it and when, what it is held to, until when, how often it was used, and
 * Revoke, which takes it back at once (DELETE /api/agent-grants/[id]) after asking once.
 *
 * One that is listed but does nothing right now says so: while the agent is paused (itself, or
 * every agent through Integrated Applications) no request runs, under a standing permission or
 * not. One that ran out or was used up while the page was open is marked as ended.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, ConfirmDialog, Spinner, Td, Th, Tr, toast } from '@/components/ui';
import { api } from '@/lib/client';
import type { AgentGrantView } from '@/lib/agent/contract';
import { GRANTS_INTRO, GRANT_ALL_PAUSED, GRANT_PAUSED, RISK_CLASS_LABELS, constraintText, revokeQuestion, when } from './words';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

type GrantState = 'live' | 'not_in_effect' | 'ended' | 'used_up' | 'taken_back';

/** Where a standing permission stands now, and the words for it. */
export function grantState(
  g: Pick<AgentGrantView, 'revokedAt' | 'expiresAt' | 'uses' | 'maxUses'>,
  paused: 'agent' | 'all' | null,
  now: number = Date.now(),
): { state: GrantState; label: string; why: string | null } {
  if (g.revokedAt) return { state: 'taken_back', label: 'Taken back', why: null };
  const ends = Date.parse(g.expiresAt);
  if (!Number.isNaN(ends) && ends <= now) return { state: 'ended', label: 'Ended', why: null };
  if (g.maxUses && g.uses >= g.maxUses) return { state: 'used_up', label: 'Used up', why: null };
  if (paused) return { state: 'not_in_effect', label: 'Not in effect', why: paused === 'all' ? GRANT_ALL_PAUSED : GRANT_PAUSED };
  return { state: 'live', label: 'In effect', why: null };
}

export default function GrantsSection({
  agentId,
  agentName,
  paused = null,
  mayRevoke = false,
}: {
  agentId: string;
  agentName: string;
  /** The agent is paused itself ('agent'), or every agent is ('all'): no standing permission is in effect. */
  paused?: 'agent' | 'all' | null;
  /**
   * The person may take a standing permission back (Users & Roles > Users, Modify: the server's
   * own rule). Anyone else sees the list without Revoke. Left out: not offered.
   */
  mayRevoke?: boolean;
}) {
  const [grants, setGrants] = useState<AgentGrantView[] | null>(null);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState<AgentGrantView | null>(null);
  const [revoking, setRevoking] = useState(false);

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

  async function revoke() {
    const g = asking;
    if (!g) return;
    setRevoking(true);
    try {
      await api.del(`/api/agent-grants/${encodeURIComponent(g.id)}`);
      toast(`Taken back. ${agentName} now asks again before "${g.operationLabel || g.operation}".`, 'success');
      setAsking(null);
      await load();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-navy/60">{GRANTS_INTRO}</p>
      {paused && grants && grants.length > 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900" data-grants-paused="">
          {paused === 'all' ? GRANT_ALL_PAUSED : GRANT_PAUSED}
        </p>
      )}
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
                <Th>Now</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => {
                const limits = constraintText(g.constraints);
                const st = grantState(g, paused);
                const over = st.state === 'taken_back' || st.state === 'ended' || st.state === 'used_up';
                return (
                  <Tr key={g.id} className={over ? 'opacity-60' : ''} data-grant={g.id} data-grant-state={st.state}>
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
                    <Td className="text-sm">{st.state === 'taken_back' ? 'Taken back' : when(g.expiresAt)}</Td>
                    <Td className="text-sm tabular-nums">{g.maxUses ? `${g.uses} of ${g.maxUses}` : g.uses}</Td>
                    <Td>
                      <Badge tone={st.state === 'live' ? 'success' : st.state === 'not_in_effect' ? 'warning' : 'neutral'}>{st.label}</Badge>
                      {st.why && <span className="mt-0.5 block max-w-xs text-xs text-navy/50">{st.why}</span>}
                    </Td>
                    <Td className="text-right whitespace-nowrap">
                      {mayRevoke && st.state !== 'taken_back' && st.state !== 'ended' && (
                        <Button size="sm" variant="secondary" onClick={() => setAsking(g)} title="Take this standing permission back now">
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
      <ConfirmDialog
        open={!!asking}
        title="Take back this standing permission?"
        message={asking ? revokeQuestion(agentName, asking.operationLabel || asking.operation) : undefined}
        confirmLabel="Revoke"
        loading={revoking}
        onConfirm={revoke}
        onClose={() => setAsking(null)}
      />
    </div>
  );
}
