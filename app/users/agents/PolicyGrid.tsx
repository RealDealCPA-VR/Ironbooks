'use client';
/**
 * The policy grid (plan 7.1): the fourteen kinds of work down, Allow / Ask / Never across, for
 * everywhere or for one area. A cell the policy can never take is locked and says why, in the
 * server's words (AgentPolicyView.locked), and an Allow the engine never gives is locked even if
 * that list leaves it out (lockedReason): the radio button is disabled, so it cannot be chosen
 * with the mouse or the keyboard.
 *
 * In an area, choosing the setting a cell already shows by following everywhere keeps it as the
 * area's own (chooseSetting), so a radio button that is already on still answers a click there.
 */
import { Lock } from 'lucide-react';
import { Button, Td, Th } from '@/components/ui';
import { POLICY_SETTINGS, RISK_CLASSES, type AgentPolicy, type PolicySetting, type RiskClass } from '@/lib/agent/operations/types';
import type { Area } from '@/lib/permissions/model';
import { cellSetting, lockedReason, overrideOf, type Locked, type PolicyDraft } from './policyDraft';
import { CLASS_HELP, RISK_CLASS_LABELS, SETTING_HELP, SETTING_LABELS } from './words';

export default function PolicyGrid({
  draft,
  policy,
  locked,
  area,
  disabled,
  onChoose,
  onClear,
}: {
  draft: PolicyDraft;
  /** The draft's policy through the engine (policyOf). */
  policy: AgentPolicy;
  locked: Locked;
  /** null: everywhere. */
  area: Area | null;
  disabled: boolean;
  onChoose: (cls: RiskClass, setting: PolicySetting) => void;
  onClear: (cls: RiskClass) => void;
}) {
  const scope = area ?? 'everywhere';
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" data-policy-grid={scope}>
        <thead>
          <tr>
            <Th>Kind of work</Th>
            {POLICY_SETTINGS.map((s) => (
              <Th key={s} className="w-24 text-center">
                {SETTING_LABELS[s]}
                <span className="block text-[11px] font-normal text-navy/40">{SETTING_HELP[s]}</span>
              </Th>
            ))}
            <Th className="w-36">
              <span className="sr-only">Adjustment</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {RISK_CLASSES.map((cls) => {
            const current = cellSetting(policy, area, cls);
            const own = overrideOf(draft, area, cls);
            const reasons = [...new Set(POLICY_SETTINGS.map((s) => lockedReason(locked, cls, s)).filter((r): r is string => Boolean(r)))];
            const reasonId = `agent-lock-${scope}-${cls}`;
            const label = RISK_CLASS_LABELS[cls];
            return (
              <tr key={cls} data-class={cls} className="align-top">
                <Td>
                  <span className="text-sm font-semibold text-navy">{label}</span>
                  <span className="block text-xs text-navy/50">{CLASS_HELP[cls]}</span>
                  {reasons.length > 0 && (
                    <span id={reasonId} className="mt-1 flex items-start gap-1 text-xs text-amber-800" data-lock-reason={cls}>
                      <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                      <span>{reasons.join(' ')}</span>
                    </span>
                  )}
                </Td>
                {POLICY_SETTINGS.map((s) => {
                  const reason = lockedReason(locked, cls, s);
                  return (
                    <Td key={s} className="text-center">
                      <label
                        className={`inline-flex items-center justify-center gap-1 rounded p-1 ${reason || disabled ? 'opacity-60' : 'cursor-pointer hover:bg-electric/5'}`}
                        title={reason ?? `${label}: ${SETTING_LABELS[s]}`}
                      >
                        {reason && <Lock className="h-3.5 w-3.5 text-navy/50" aria-hidden="true" />}
                        <input
                          type="radio"
                          name={`agent-policy-${scope}-${cls}`}
                          checked={current === s}
                          disabled={disabled || Boolean(reason)}
                          aria-label={`${label}: ${SETTING_LABELS[s]}`}
                          aria-describedby={reason ? reasonId : undefined}
                          data-cell={`${cls}:${s}`}
                          data-locked={reason ? 'true' : undefined}
                          onChange={() => {
                            if (!reason) onChoose(cls, s);
                          }}
                          // A radio button that is already on sends no change event. In an area,
                          // clicking the setting it follows from everywhere makes it the area's own.
                          onClick={() => {
                            if (!reason && !disabled && area && !own && current === s) onChoose(cls, s);
                          }}
                        />
                      </label>
                    </Td>
                  );
                })}
                <Td className="text-right">
                  {own ? (
                    <span className="inline-flex flex-col items-end gap-0.5">
                      <span className="text-[11px] text-electric">{area ? 'Set for this area' : 'Changed from the preset'}</span>
                      {!disabled && (
                        <Button size="sm" variant="ghost" onClick={() => onClear(cls)} title={area ? 'Follow the setting for everywhere' : "Go back to the preset's setting"}>
                          {area ? 'As everywhere' : 'As the preset'}
                        </Button>
                      )}
                    </span>
                  ) : (
                    area && <span className="text-[11px] text-navy/40">As everywhere</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
