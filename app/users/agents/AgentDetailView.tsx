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
 *
 * Letting an agent do more by itself is for an Admin (plan 4.4). For anyone else who manages
 * agents, every control that would loosen it (a looser preset, a cell, "follow again" buttons that
 * would loosen a cell, a folder outside the ones it has, the email notice) is off and says why, and
 * a raised limit typed in is held at Save with the reason (policyDraft.ts looseningsOf); tightening,
 * pausing and a folder inside one it has stay open. A refusal from the server is shown in its own
 * words, beside Save: the folder checks only the server can make (a folder that is not there, a
 * share of this computer, one of Ironbooks' own places, a stored folder that does not really reach
 * the new one) come back that way. A folder the agent had that the server took off its list itself
 * on a save (for a person who is not an Admin, one that would be refused were it given today) is
 * found by comparing what was sent with what came back, and said beside Save.
 *
 * Tightening, pausing and taking back a standing permission need the right to change Users & Roles
 * > Users (viewerMayManage; an Admin always has it). Someone who may only see that list sees this
 * page as it is, with no control the server would refuse, and is told what they would need.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Pause, Play, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Label, PageSkeleton, Select, toast } from '@/components/ui';
import { api } from '@/lib/client';
import type { AgentDetail } from '@/lib/agent/contract';
import { AGENT_PRESETS, type AgentPreset, type PolicySetting, type RiskClass } from '@/lib/agent/operations/types';
import { ADMIN_ROLE_KEY, AREAS, type Area } from '@/lib/permissions/model';
import ActivitySection from './ActivitySection';
import GrantsSection from './GrantsSection';
import LimitsForm from './LimitsForm';
import PolicyGrid, { ADMIN_ONLY_NOTE_ID } from './PolicyGrid';
import PresetChoice from './PresetChoice';
import {
  areaCounts,
  changesOf,
  chooseSetting,
  clearLooser,
  clearScope,
  clearSetting,
  differingCount,
  draftFrom,
  foldersTakenAway,
  isChanged,
  keptAsChosen,
  lockedReason,
  looserCells,
  looserThanPreset,
  looseningsOf,
  overrideText,
  policyOf,
  presetLooser,
  withTypedFolder,
  type PolicyDraft,
} from './policyDraft';
import {
  ADMIN_ROLE_WARNING,
  ADMIN_TO_LOOSEN,
  ADMIN_TO_PAUSE_ALL,
  ADMIN_TO_RESUME_ADMIN_AGENT,
  AGENT_PRESET_LABELS,
  ALL_PAUSED_NOTE,
  AREA_INTRO,
  NOT_ADMIN_NOTE,
  PAUSED_NOTE,
  POLICY_INTRO,
  REMOVED_NOTE,
  ROLE_AND_PRESET_NOTE,
  VIEW_ONLY_NOTE,
  adjustedPresetNote,
  adjustedTitle,
  adminOnlyNote,
  foldersTakenAwayNote,
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
  viewerIsAdmin = false,
  viewerMayManage = false,
  pauseAllOffered = null,
}: {
  agentId: string;
  /** This window is not at the computer that holds the company file: the policy can only be looked at. */
  hostOnly: boolean;
  onBack: () => void;
  /** Remove, asked and done by the list (as the list's own Remove button). Only an Admin is offered it. */
  onRemove: (agent: { id: string; name: string }) => void;
  /**
   * The person at this window is an Admin, who may let the agent do more by itself (plan 4.4).
   * Unknown counts as not: the controls that would loosen stay off, and the server decides anyway.
   */
  viewerIsAdmin?: boolean;
  /**
   * The person may change Users & Roles > Users, which tightening, pausing and taking back a
   * standing permission need (lib/services/agentPolicies.ts personWhoManagesAgents). An Admin
   * always may. Unknown counts as not: the page is shown to look at only.
   */
  viewerMayManage?: boolean;
  /**
   * Pause all agents is offered to this person (AgentRequestCount.canPauseAll), false when it is
   * not, null while that is not known. Only used to say who can turn every agent back on.
   */
  pauseAllOffered?: boolean | null;
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
  /**
   * The server's refusal of the last save, as it said it, with the draft and typed folder it
   * refused: it is shown only while those are still on screen, so once the person edits again a
   * refusal of a draft that no longer exists does not sit beside Save.
   */
  const [refusal, setRefusal] = useState<{ draft: PolicyDraft; folder: string; message: string } | null>(null);
  /**
   * Folders the agent had that the last save sent back and Ironbooks took off its list itself
   * (policyDraft.ts foldersTakenAway): said beside Save until the next save that is sent, or Undo,
   * since the person did not take them off and would otherwise not know.
   */
  const [takenAway, setTakenAway] = useState<string[]>([]);

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
  // Tightening, pausing and Revoke all need Users & Roles > Users, Modify; without it the page is
  // there to look at, and offers nothing the server would refuse.
  const mayManage = viewerIsAdmin || viewerMayManage;
  const readOnly = hostOnly || removed || !mayManage;
  const counts = areaCounts(draft);
  const everywhereCount = draft.overrides.filter((o) => o.area === null).length;
  const isAdminAgent = detail.roleKeys.includes(ADMIN_ROLE_KEY);
  const locked = detail.policy.locked;
  // Another preset was picked and some changes still let the agent do more than it says.
  const stillLooser = draft.preset !== initial.preset ? looserThanPreset(draft) : [];
  // The preset's own line describes it as it comes; this says what the agent's own settings add.
  // Rows that only keep the setting their cell would have anyway are said as such, so "(adjusted)"
  // never reads as "does other than its preset" when it does not.
  const presetNote = adjustedPresetNote(draft.overrides.length, looserThanPreset(draft).map(overrideText), keptAsChosen(draft).length);

  // Only an Admin may let the agent do more by itself (plan 4.4). Everything is measured against
  // what was saved, so whatever this person tightened they may put back.
  const mayLoosen = viewerIsAdmin;
  // Resuming lets a paused agent work again: the server turns back on an agent that holds the Admin
  // role only for an Admin (assertWithinYourAccess), so it is not offered to anyone else. One with
  // more access than this person in another way is refused there, and the refusal is shown.
  const resumeBlocked = !mayLoosen && isAdminAgent;
  const blocksLoosening = (next: PolicyDraft, cls?: RiskClass) => !mayLoosen && looserCells(initial, next, cls).length > 0;
  const presetWhy: Partial<Record<AgentPreset, string>> = mayLoosen
    ? {}
    : Object.fromEntries(AGENT_PRESETS.filter((p) => presetLooser(p, initial.preset)).map((p) => [p, ADMIN_TO_LOOSEN]));
  const cellWhy = (areaKey: Area | null) =>
    mayLoosen
      ? undefined
      : (cls: RiskClass, s: PolicySetting) =>
          !lockedReason(locked, cls, s) && blocksLoosening(chooseSetting(draft, locked, areaKey, cls, s), cls) ? ADMIN_TO_LOOSEN : null;
  const clearWhy = (areaKey: Area | null) =>
    mayLoosen ? undefined : (cls: RiskClass) => (blocksLoosening(clearSetting(draft, areaKey, cls), cls) ? ADMIN_TO_LOOSEN : null);
  const clearAllBlocked = blocksLoosening(clearScope(draft, 'all'));
  const clearAreaBlocked = blocksLoosening(clearScope(draft, area));
  // What a save would let the agent do more of, a folder typed but not added included.
  const typed = withTypedFolder(draft, folderText);
  const loosenings = mayLoosen || readOnly ? [] : looseningsOf(initial, typed.draft ?? draft);
  // A folder the agent already has is never looked at on the disk again (lib/services/agentPolicies.ts
  // checkFolders), so a refusal of "not found" is always about one typed in this save, and the
  // server's words say what to do ("or take it off the list"): no hint of the page's own is needed.
  const saveError = refusal && refusal.draft === draft && refusal.folder === folderText ? refusal.message : '';

  function choose(areaKey: Area | null, cls: RiskClass, setting: PolicySetting) {
    setDraft((d) => (d && detail ? chooseSetting(d, detail.policy.locked, areaKey, cls, setting) : d));
  }

  async function save() {
    if (!initial || !draft || !detail) return;
    setRefusal(null);
    const refused = { draft, folder: folderText };
    // A folder typed but not added is added now, so nothing the person typed is dropped unsaid.
    const folded = withTypedFolder(draft, folderText);
    if (folded.error !== null) {
      toast(folded.error, 'danger');
      return;
    }
    // Said beside Save already; held here too, so nothing loosening is ever sent from this window.
    const loose = mayLoosen ? [] : looseningsOf(initial, folded.draft);
    if (loose.length) {
      toast(adminOnlyNote(loose), 'danger');
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
    // Only now is something sent: a save stopped above saved nothing, so the note about folders the
    // last save really took away stays.
    setTakenAway([]);
    setSaving(true);
    try {
      const answer = await api.patch<AgentDetail>(`/api/agents/${encodeURIComponent(detail.id)}`, c.input);
      take(answer, true);
      setFolderText('');
      // A folder it had that Ironbooks took off the list itself (for a person who is not an Admin):
      // the save went through, so it is said beside Save as well as in the notice.
      const gone = foldersTakenAway(initial, c.input.folders, answer.policy?.policy?.folders);
      setTakenAway(gone);
      toast(
        gone.length ? foldersTakenAwayNote(gone) : `Saved. ${detail.name} works under these settings from its next request.`,
        gone.length ? 'info' : 'success',
      );
    } catch (e) {
      // The server's own words: it decides who may change what (lib/services/agentPolicies.ts).
      setRefusal({ ...refused, message: errMsg(e) });
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
              {/* "(adjusted: N)": the settings that differ from the preset, worked out from the saved
                  settings themselves, so it holds whatever the list's count means. */}
              <span className="ml-1" data-preset-summary="" title={adjustedTitle(differingCount(initial), keptAsChosen(initial).length)}>
                {presetSummary(AGENT_PRESET_LABELS[initial.preset], differingCount(initial))}
              </span>
              {detail.unattended && <span className="ml-1">· Also while nobody is signed in</span>}
            </div>
            <p className="mt-1 text-xs text-navy/40">
              Made {when(detail.createdAt)} · Last used {when(detail.lastUsedAt)}
            </p>
          </div>
          {!removed && mayManage && (
            <div className="flex flex-wrap gap-2">
              {detail.paused ? (
                <Button
                  variant="secondary"
                  onClick={() => pause(false)}
                  loading={pausing}
                  disabled={resumeBlocked}
                  title={resumeBlocked ? ADMIN_TO_RESUME_ADMIN_AGENT : undefined}
                >
                  <Play className="mr-1 h-4 w-4" /> Resume
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => pause(true)} loading={pausing}>
                  <Pause className="mr-1 h-4 w-4" /> Pause this agent
                </Button>
              )}
              {!hostOnly && viewerIsAdmin && (
                <Button variant="ghost" onClick={() => onRemove({ id: detail.id, name: detail.name })} title="Remove this agent's access">
                  <Trash2 className="mr-1 h-4 w-4" /> Remove
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="mt-3 space-y-2">
          {removed && <p className="text-sm text-navy/60">{REMOVED_NOTE}</p>}
          {!removed && detail.allPaused && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-all-paused="">
              {ALL_PAUSED_NOTE}
              {/* Only whoever may use the switch can turn it back on (canPauseAll): say so to anyone else. */}
              {pauseAllOffered === false && <span className="mt-1 block">{ADMIN_TO_PAUSE_ALL}</span>}
            </p>
          )}
          {!removed && detail.paused && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
              {PAUSED_NOTE}
              {resumeBlocked && mayManage && (
                <span className="mt-1 block" data-resume-blocked="">
                  {ADMIN_TO_RESUME_ADMIN_AGENT}
                </span>
              )}
            </p>
          )}
          {isAdminAgent && !removed && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{ADMIN_ROLE_WARNING}</p>}
          {hostOnly && !removed && (
            <p className="text-sm text-amber-700">
              {HOST_ONLY_MESSAGE}
              {mayManage && ' Pausing and taking back standing permission work from here.'}
            </p>
          )}
          {!mayManage && !removed && (
            <p className="rounded-lg bg-slate-50 p-3 text-xs text-navy/70" data-view-only="">
              {VIEW_ONLY_NOTE}
            </p>
          )}
          {!mayLoosen && !readOnly && (
            <p id={ADMIN_ONLY_NOTE_ID} className="rounded-lg bg-slate-50 p-3 text-xs text-navy/70" data-not-admin="">
              {NOT_ADMIN_NOTE}
            </p>
          )}
        </div>
      </Card>

      <TabBar tabs={SECTIONS} value={section} onChange={setSection} label="Agent settings" />

      {section === 'policy' && (
        <Card className="space-y-4 p-4">
          <p className="text-sm text-navy/70">{ROLE_AND_PRESET_NOTE}</p>
          <div>
            <Label>Preset: what it may do without asking</Label>
            <PresetChoice
              value={draft.preset}
              onChange={(p: AgentPreset) => setDraft({ ...draft, preset: p })}
              name="ag-detail-preset"
              disabled={readOnly}
              disabledWhy={readOnly ? undefined : presetWhy}
              note={presetNote}
            />
            <p className="mt-1 text-xs text-navy/50">The grid below starts from the preset. Your changes to it stay when you pick another preset.</p>
            {stillLooser.length > 0 && !readOnly && (
              <div className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900" role="note" data-looser-note="">
                <p>{looserNote(AGENT_PRESET_LABELS[draft.preset], stillLooser.map(overrideText))}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setDraft(clearLooser(draft))}>
                    Take {stillLooser.length === 1 ? 'it' : 'them'} away
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft(clearScope(draft, 'all'))}
                    disabled={clearAllBlocked}
                    title={clearAllBlocked ? ADMIN_TO_LOOSEN : 'Take away every change and use the preset as it is'}
                  >
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(clearScope(draft, 'all'))}
                disabled={clearAllBlocked}
                title={clearAllBlocked ? ADMIN_TO_LOOSEN : 'Take away every change and use the preset as it is'}
              >
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
                locked={locked}
                area={null}
                disabled={readOnly}
                onChoose={(cls, s) => choose(null, cls, s)}
                onClear={(cls) => setDraft(clearSetting(draft, null, cls))}
                adminOnly={cellWhy(null)}
                clearBlocked={clearWhy(null)}
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft(clearScope(draft, area))}
                    disabled={clearAreaBlocked}
                    title={clearAreaBlocked ? ADMIN_TO_LOOSEN : undefined}
                  >
                    Clear this area
                  </Button>
                ) : null}
              </div>
              <PolicyGrid
                draft={draft}
                policy={policy}
                locked={locked}
                area={area}
                disabled={readOnly}
                onChoose={(cls, s) => choose(area, cls, s)}
                onClear={(cls) => setDraft(clearSetting(draft, area, cls))}
                adminOnly={cellWhy(area)}
                clearBlocked={clearWhy(area)}
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
            saved={initial}
            mayLoosen={mayLoosen}
          />
        </Card>
      )}

      {(section === 'policy' || section === 'limits') && !readOnly && (
        <div className="space-y-2">
          {loosenings.length > 0 && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900" role="note" data-loosen-blocked="">
              {adminOnlyNote(loosenings)}
            </p>
          )}
          {saveError && (
            <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert" data-save-error="">
              {saveError}
            </p>
          )}
          {takenAway.length > 0 && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900" role="status" data-folders-taken-away="">
              {foldersTakenAwayNote(takenAway)}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {changed && <span className="mr-auto text-sm text-navy/60">Not saved yet.</span>}
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(initial);
                setFolderText('');
                setRefusal(null);
                setTakenAway([]);
              }}
              disabled={!changed || saving}
            >
              Undo changes
            </Button>
            <Button onClick={save} loading={saving} disabled={!changed || loosenings.length > 0} data-shortcut="save">
              Save changes
            </Button>
          </div>
        </div>
      )}

      {section === 'grants' && (
        <Card className="p-4">
          <GrantsSection
            agentId={detail.id}
            agentName={detail.name}
            paused={removed ? null : detail.paused ? 'agent' : detail.allPaused ? 'all' : null}
            mayRevoke={mayManage}
          />
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
