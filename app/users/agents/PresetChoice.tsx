'use client';
/**
 * The four presets (plan 4.2) as radio buttons, each with one line on what it means. Used by the
 * New agent dialog and the agent's detail page, so both say the same thing.
 *
 * Each line describes the preset as it comes. On the detail page `note` goes under the chosen one
 * when the agent has settings of its own (adjustedPresetNote), so the line never claims more than
 * is true for that agent. A preset in `disabledWhy` cannot be picked and says why (a looser
 * preset, for a person who is not an Admin: plan 4.4).
 */
import { AGENT_PRESETS, type AgentPreset } from '@/lib/agent/operations/types';
import { AGENT_PRESET_LABELS, NEW_AGENT_PRESET, PRESET_HELP } from './words';

export default function PresetChoice({
  value,
  onChange,
  name,
  disabled = false,
  disabledWhy,
  note,
}: {
  value: AgentPreset;
  onChange: (preset: AgentPreset) => void;
  /** The radio group's name: unique on the page. */
  name: string;
  disabled?: boolean;
  /** Presets that cannot be picked, with the reason shown on them. */
  disabledWhy?: Partial<Record<AgentPreset, string>>;
  /** Said under the chosen preset's line. */
  note?: string | null;
}) {
  return (
    <div className="space-y-1" role="radiogroup" aria-label="What the agent may do without asking">
      {AGENT_PRESETS.map((p) => {
        const why = disabledWhy?.[p] ?? null;
        const off = disabled || Boolean(why);
        return (
          <label
            key={p}
            className={`flex items-start gap-2 rounded p-1.5 ${off ? 'opacity-70' : 'cursor-pointer hover:bg-electric/5'}`}
            title={why ?? undefined}
          >
            <input
              type="radio"
              name={name}
              value={p}
              className="mt-1"
              checked={value === p}
              disabled={off}
              data-admin-only={why ? 'true' : undefined}
              onChange={() => {
                if (!why) onChange(p);
              }}
            />
            <span>
              <span className="text-sm font-semibold text-navy">{AGENT_PRESET_LABELS[p]}</span>
              {p === NEW_AGENT_PRESET && <span className="ml-1 text-xs text-navy/40">(suggested)</span>}
              <span className="block text-xs text-navy/50">{PRESET_HELP[p]}</span>
              {why && <span className="block text-xs text-amber-800">{why}</span>}
              {value === p && note && (
                <span className="mt-0.5 block text-xs text-amber-900" data-preset-adjusted="">
                  {note}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
