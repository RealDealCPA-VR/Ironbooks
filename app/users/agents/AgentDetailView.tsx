'use client';
/**
 * One agent, opened from Users & Roles > Agents (plan 7.1): what it may do (the preset and the
 * policy grid, everywhere and per area), its limits, its standing permissions, what it did and
 * asked for, and Pause / Resume / Remove.
 *
 * Saving sends only what changed (PATCH /api/agents/[id], AgentPolicyInput). Changing the policy
 * is done at the computer that holds the company file, like making an agent; pausing and taking
 * back a standing permission work from any person's window, so stopping an agent is never more
 * than a click away. The server decides who may change what (lib/services/agentPolicies.ts); an
 * agent never reaches any of this (plan 4.6).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Pause, Play, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Label, PageSkeleton, Select, toast } from '@/components/ui';
import { api } from '@/lib/client';
import type { AgentDetail } from '@/lib/agent/contract';
import type { AgentPreset, PolicySetting, RiskClass } from '@/lib/agent/operations/types';
import { ADMIN_ROLE_KEY, AREAS, type Area } from '@/lib/permissions/model';
import ActivitySection from './ActivitySection';
import GrantsSection from './GrantsSection';
import LimitsForm from './LimitsForm';
import PolicyGrid from './PolicyGrid';
import PresetChoice from './PresetChoice';
import {
  areaCounts,
  changesOf,
  chooseSetting,
  clearLooser,
  clearScope,
  clearSetting,
  draftFrom,
  isChanged,
  looserThanPreset,
  overrideText,
  policyOf,
  withTypedFolder,
  type PolicyDraft,
} from './policyDraft';
import {
  ADMIN_ROLE_WARNING,
  AGENT_PRESET_LABELS,
  ALL_PAUSED_NOTE,
  AREA_INTRO,
  PAUSED_NOTE,
  POLICY_INTRO,
  REMOVED_NOTE,
  ROLE_AND_PRESET_NOTE,
  looserNote,
  presetSummary,
  when,
} from './words';

/** The words of lib/net/hostOnly.ts HOST_ONLY_MESSAGE (a server module this page cannot import). */
const HOST_ONLY_MESSAGE = 'This can only be changed on the computer that holds the company file.';

type Section = 'policy' | 'limits' | 'grants' | 'activity';
const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'policy', label: 'What it may do' },
  { key: 'limits', label: 'Limits' },
  { key: 'grants', label: 'Standing permissions' },
  { key: 'activity', label: 'Activity' },
];

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function TabBar<K extends string>({
  tabs,
  value,
  onChange,
  label,
  small = false,
}: {
  tabs: Array<{ key: K; label: string }>;
  value: K;
  onChange: (k: K) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-lg border border-slate-200 font-medium transition ${small ? 'px-3 py-1 text-xs' : 'px-3 py-1.5 text-sm'} ${
            value === t.key ? 'bg-electric text-white' : 'bg-white text-navy hover:bg-electric/5'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function AgentDetailView({
  agentId,
  hostOnly,
  onBack,
  onRemove,
}: {
  agentId: string;
  /** This window is not at the computer that holds the company file: the policy can only be looked at. */
  hostOnly: boolean;
  onBack: () => void;
  /** Remove, asked and done by the list (as the list's own Remove button). */
  onRemove: (agent: { id: string; name: string }) => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState('');
  const [initial, setInitial] = useState<PolicyDraft | null>(null);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [section, setSection] = useState<Section>('policy');
  const [scope, setScope] = useState<'everywhere' | 'areas'>('everywhere');
  const [area, setArea] = useState<Area>(AREAS[0].key);
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** A folder path typed on the Limits tab and not added yet: Save changes adds it. */
  const [folderText, setFolderText] = useState('');

  /** Show what the server answered; an unsaved draft is kept unless asked to start again. */
  const take = useCallback((d: AgentDetail, resetDraft: boolean) => {
    setDetail(d);
    const fresh = draftFrom(d.policy);
    setInitial(fresh);
    if (resetDraft) setDraft(fresh);
  }, []);

  const load = useCallback(async () => {
    try {
      take(await api.get<AgentDetail>(`/api/agents/${encodeURIComponent(agentId)}`), true);
      setError('');
    } catch (e) {
      setError(errMsg(e));
    }
  }, [agentId, take]);
  useEffect(() => {
    load();
  }, [load]);

  const policy = useMemo(() => (draft ? policyOf(draft) : null), [draft]);
  const changed = (initial && draft ? isChanged(initial, draft) : false) || folderText.trim() !== '';

  if (!detail || !draft || !initial || !policy) {
    return error ? (
      <div className="space-y-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> All agents
        </Button>
        <Card className="p-4 text-sm text-red-600">{error}</Card>
      </div>
    ) : (
      <PageSkeleton />
    );
  }

  const removed = Boolean(detail.revokedAt);
  const readOnly = hostOnly || removed;
  const counts = areaCounts(draft);
  const everywhereCount = draft.overrides.filter((o) => o.area === null).length;
  const isAdminAgent = detail.roleKeys.includes(ADMIN_ROLE_KEY);
  // Another preset was picked and some changes still let the agent do more than it says.
  const stillLooser = draft.preset !== initial.preset ? looserThanPreset(draft) : [];

  function choose(areaKey: Area | null, cls: RiskClass, setting: PolicySetting) {
    setDraft((d) => (d && detail ? chooseSetting(d, detail.policy.locked, areaKey, cls, setting) : d));
  }

  async function save() {
    if (!initial || !draft || !detail) return;
    // A folder typed but not added is added now, so nothing the person typed is dropped unsaid.
    const folded = withTypedFolder(draft, folderText);
    if (folded.error !== null) {
      toast(folded.error, 'danger');
      return;
    }
    const c = changesOf(initial, folded.draft);
    if (c.error !== null) {
      toast(c.error, 'danger');
      return;
    }
    if (Object.keys(c.input).length === 0) {
      setFolderText('');
      return;
    }
    setSaving(true);
    try {
      take(await api.patch<AgentDetail>(`/api/agents/${encodeURIComponent(detail.id)}`, c.input), true);
      setFolderText('');
      toast(`Saved. ${detail.name} works under these settings from its next request.`, 'success');
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function pause(paused: boolean) {
    if (!detail) return;
    setPausing(true);
    try {
      take(await api.post<AgentDetail>(`/api/agents/${encodeURIComponent(detail.id)}/pause`, { paused }), !changed);
      toast(
        paused
          ? `${detail.name} is paused. Everything it asks for is refused until someone resumes it.`
          : `${detail.name} can work again.`,
        'success',
      );
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setPausing(false);
    }
  }

  function back() {
    if (changed && !readOnly) setLeaving(true);
    else onBack();
  }

  const statusBadge = removed ? (
    <Badge tone="void">Removed</Badge>
  ) : detail.paused || detail.allPaused ? (
    <Badge tone="warning">Paused</Badge>
  ) : (
    <Badge tone="success">Active</Badge>
  );

  return (
    <div className="space-y-4" data-agent-detail={detail.id}>
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <Button variant="ghost" size="sm" onClick={back} title="Back to the list of agents">
            <ArrowLeft className="mr-1 h-4 w-4" /> All agents
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-navy">
              {detail.name} {statusBadge}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-navy/60">
              {detail.roleNames.length ? detail.roleNames.map((r) => <Badge key={r}>{r}</Badge>) : <span>Role removed</span>}
              <span className="ml-1" data-preset-summary="">
                {presetSummary(AGENT_PRESET_LABELS[detail.policy.preset], detail.policy.overrides.length)}
              </span>
              {detail.unattended && <span className="ml-1">· Also while nobody is signed in</span>}
            </div>
            <p className="mt-1 text-xs text-navy/40">
              Made {when(detail.createdAt)} · Last used {when(detail.lastUsedAt)}
            </p>
          </div>
          {!removed && (
            <div className="flex flex-wrap gap-2">
              {detail.paused ? (
                <Button variant="secondary" onClick={() => pause(false)} loading={pausing}>
                  <Play className="mr-1 h-4 w-4" /> Resume
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => pause(true)} loading={pausing}>
                  <Pause className="mr-1 h-4 w-4" /> Pause this agent
                </Button>
              )}
              {!hostOnly && (
                <Button variant="ghost" onClick={() => onRemove({ id: detail.id, name: detail.name })} title="Remove this agent's access">
                  <Trash2 className="mr-1 h-4 w-4" /> Remove
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {removed && <p className="text-sm text-navy/60">{REMOVED_NOTE}</p>}
          {!removed && detail.allPaused && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{ALL_PAUSED_NOTE}</p>}
          {!removed && detail.paused && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{PAUSED_NOTE}</p>}
          {isAdminAgent && !removed && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{ADMIN_ROLE_WARNING}</p>}
          {hostOnly && !removed && <p className="text-sm text-amber-700">{HOST_ONLY_MESSAGE} Pausing and taking back standing permission work from here.</p>}
        </div>
      </Card>

      <TabBar tabs={SECTIONS} value={section} onChange={setSection} label="Agent settings" />

      {section === 'policy' && (
        <Card className="space-y-4 p-4">
          <p className="text-sm text-navy/70">{ROLE_AND_PRESET_NOTE}</p>
          <div>
            <Label>Preset: what it may do without asking</Label>
            <PresetChoice value={draft.preset} onChange={(p: AgentPreset) => setDraft({ ...draft, preset: p })} name="ag-detail-preset" disabled={readOnly} />
            <p className="mt-1 text-xs text-navy/50">The grid below starts from the preset. Your changes to it stay when you pick another preset.</p>
            {stillLooser.length > 0 && !readOnly && (
              <div className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900" role="note" data-looser-note="">
                <p>{looserNote(AGENT_PRESET_LABELS[draft.preset], stillLooser.map(overrideText))}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setDraft(clearLooser(draft))}>
                    Take {stillLooser.length === 1 ? 'it' : 'them'} away
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDraft(clearScope(draft, 'all'))} title="Take away every change and use the preset as it is">
                    Use the preset as it is
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabBar
              tabs={[
                { key: 'everywhere' as const, label: 'Everywhere' },
                { key: 'areas' as const, label: `By area${Object.keys(counts).length ? ` (${Object.keys(counts).length})` : ''}` },
              ]}
              value={scope}
              onChange={setScope}
              label="Where the settings apply"
              small
            />
            {!readOnly && draft.overrides.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(clearScope(draft, 'all'))} title="Take away every change and use the preset as it is">
                Use the preset as it is
              </Button>
            )}
          </div>
          {scope === 'everywhere' ? (
            <>
              <p className="text-xs text-navy/50">
                {POLICY_INTRO}
                {everywhereCount > 0 && ` ${everywhereCount} changed from the preset.`}
              </p>
              <PolicyGrid
                draft={draft}
                policy={policy}
                locked={detail.policy.locked}
                area={null}
                disabled={readOnly}
                onChoose={(cls, s) => choose(null, cls, s)}
                onClear={(cls) => setDraft(clearSetting(draft, null, cls))}
              />
            </>
          ) : (
            <>
              <p className="text-xs text-navy/50">{AREA_INTRO}</p>
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-full sm:w-72">
                  <Label htmlFor="ag-area">Area</Label>
                  <Select id="ag-area" value={area} onChange={(e) => setArea(e.target.value as Area)}>
                    {AREAS.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.label}
                        {counts[a.key] ? ` (${counts[a.key]} set)` : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                {!readOnly && counts[area] ? (
                  <Button size="sm" variant="ghost" onClick={() => setDraft(clearScope(draft, area))}>
                    Clear this area
                  </Button>
                ) : null}
              </div>
              <PolicyGrid
                draft={draft}
                policy={policy}
                locked={detail.policy.locked}
                area={area}
                disabled={readOnly}
                onChoose={(cls, s) => choose(area, cls, s)}
                onClear={(cls) => setDraft(clearSetting(draft, area, cls))}
              />
            </>
          )}
        </Card>
      )}

      {section === 'limits' && (
        <Card className="p-4">
          <LimitsForm
            draft={draft}
            onChange={setDraft}
            disabled={readOnly}
            unattended={detail.unattended}
            folder={folderText}
            onFolderChange={setFolderText}
          />
        </Card>
      )}

      {(section === 'policy' || section === 'limits') && !readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {changed && <span className="mr-auto text-sm text-navy/60">Not saved yet.</span>}
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(initial);
              setFolderText('');
            }}
            disabled={!changed || saving}
          >
            Undo changes
          </Button>
          <Button onClick={save} loading={saving} disabled={!changed} data-shortcut="save">
            Save changes
          </Button>
        </div>
      )}

      {section === 'grants' && (
        <Card className="p-4">
          <GrantsSection agentId={detail.id} agentName={detail.name} />
        </Card>
      )}

      {section === 'activity' && (
        <Card className="p-4">
          <ActivitySection agentId={detail.id} />
        </Card>
      )}

      <ConfirmDialog
        open={leaving}
        title="Leave without saving?"
        message={`Your changes to ${detail.name} are not saved. Leave them, or go back and save.`}
        confirmLabel="Leave without saving"
        onConfirm={() => {
          setLeaving(false);
          onBack();
        }}
        onClose={() => setLeaving(false)}
      />
    </div>
  );
}
