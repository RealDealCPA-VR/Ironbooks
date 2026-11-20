'use client';
/**
 * The four presets (plan 4.2) as radio buttons, each with one line on what it means. Used by the
 * New agent dialog and the agent's detail page, so both say the same thing.
 */
import { AGENT_PRESETS, type AgentPreset } from '@/lib/agent/operations/types';
import { AGENT_PRESET_LABELS, NEW_AGENT_PRESET, PRESET_HELP } from './words';

export default function PresetChoice({
  value,
  onChange,
  name,
  disabled = false,
}: {
  value: AgentPreset;
  onChange: (preset: AgentPreset) => void;
  /** The radio group's name: unique on the page. */
  name: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1" role="radiogroup" aria-label="What the agent may do without asking">
      {AGENT_PRESETS.map((p) => (
        <label
          key={p}
          className={`flex items-start gap-2 rounded p-1.5 ${disabled ? 'opacity-70' : 'cursor-pointer hover:bg-electric/5'}`}
        >
          <input
            type="radio"
            name={name}
            value={p}
            className="mt-1"
            checked={value === p}
            disabled={disabled}
            onChange={() => onChange(p)}
          />
          <span>
            <span className="text-sm font-semibold text-navy">{AGENT_PRESET_LABELS[p]}</span>
            {p === NEW_AGENT_PRESET && <span className="ml-1 text-xs text-navy/40">(suggested)</span>}
            <span className="block text-xs text-navy/50">{PRESET_HELP[p]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
