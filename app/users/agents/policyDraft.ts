/**
 * The agent detail page's unsaved policy (plan 7.1): the preset, the Allow / Ask / Never
 * adjustments (everywhere and per area) and the limits, as the person edits them, and what a
 * save sends: only what changed, in the AgentPolicyInput shape (lib/agent/contract.ts).
 *
 * Pure: no React, no fetch. The grid shows each cell through the policy engine's own resolvePolicy
 * and settingFor (lib/agent/policy.ts), so the screen never shows another setting than the one the
 * decisions use. The server checks everything again and has the last word
 * (lib/services/agentPolicies.ts saveAgentPolicy); the checks here only say a problem before the
 * round trip, in the same words.
 */
import type { AgentPolicyInput, AgentPolicyView } from '@/lib/agent/contract';
import {
  RISK_CLASSES,
  RISK_CLASS_LABELS,
  type AgentPolicy,
  type AgentPreset,
  type PolicyOverride,
  type PolicySetting,
  type RiskClass,
} from '@/lib/agent/operations/types';
import { AREA_KEYS, areaLabel, type Area } from '@/lib/permissions/model';
import { DEFAULT_BULK_CAP, PRESET_DEFAULTS, canBeAllowed, resolvePolicy, settingFor } from '@/lib/agent/policy';
import { MAX_LEDGER_AMOUNT, toDecimal } from '@/lib/money';

/** The limits as typed (text), so a half-typed number is kept as the person left it. */
export interface PolicyDraft {
  preset: AgentPreset;
  overrides: PolicyOverride[];
  /** Blank: no limit, or DEFAULT_BULK_CAP while bulk work is Allow anywhere (see changesOf). */
  bulkCap: string;
  /** Blank: off. "0": every amount needs two people. */
  twoPersonOver: string;
  requestExpiryDays: string;
  folders: string[];
  notifyEmail: boolean;
}

export type Locked = AgentPolicyView['locked'];

/** The same bounds the server holds (lib/services/agentPolicies.ts). */
export const BULK_CAP_MAX = 100_000;
export const EXPIRY_DAYS_MAX = 365;
export const FOLDERS_MAX = 50;

const rank = (cls: RiskClass) => (RISK_CLASSES as readonly string[]).indexOf(cls);

/** Classes in the grid's order, the class everywhere before its areas (as the server sorts them). */
export function sortOverrides(list: readonly PolicyOverride[]): PolicyOverride[] {
  return [...list]
    .map((o) => ({ class: o.class, area: o.area ?? null, setting: o.setting }))
    .sort((a, b) => rank(a.class) - rank(b.class) || (a.area ?? '').localeCompare(b.area ?? ''));
}

function overridesKey(list: readonly PolicyOverride[]): string {
  return JSON.stringify(sortOverrides(list).map((o) => [o.class, o.area, o.setting]));
}

export function draftFrom(view: AgentPolicyView): PolicyDraft {
  const p = view.policy;
  return {
    preset: view.preset,
    overrides: sortOverrides(view.overrides),
    bulkCap: p.bulkCap === null || p.bulkCap === undefined ? '' : String(p.bulkCap),
    twoPersonOver: p.twoPersonOver ?? '',
    requestExpiryDays: String(p.requestExpiryDays),
    folders: [...(p.folders ?? [])],
    notifyEmail: p.notifyEmail === true,
  };
}

/** The policy the draft makes, through the engine (limits do not change any cell). */
export function policyOf(draft: PolicyDraft): AgentPolicy {
  return resolvePolicy(draft.preset, draft.overrides);
}

/** The setting a cell shows: the area's own when it has one, else everywhere's. */
export function cellSetting(policy: AgentPolicy, area: Area | null, cls: RiskClass): PolicySetting {
  return settingFor(policy, area, cls);
}

/** The stored adjustment for one class in one scope (everywhere: area null), or null. */
export function overrideOf(draft: PolicyDraft, area: Area | null, cls: RiskClass): PolicyOverride | null {
  return draft.overrides.find((o) => o.class === cls && (o.area ?? null) === area) ?? null;
}

/** What the cell would be without its own adjustment: the preset's (everywhere), or everywhere's (an area). */
export function inheritedSetting(draft: PolicyDraft, area: Area | null, cls: RiskClass): PolicySetting {
  if (area) {
    const rest = draft.overrides.filter((o) => !(o.class === cls && (o.area ?? null) === area));
    return settingFor(resolvePolicy(draft.preset, rest), null, cls);
  }
  return presetSetting(draft.preset, cls);
}

/** Said for an Allow cell the engine never allows when the server's list did not name it. */
export function neverAllowReason(cls: RiskClass): string {
  return `"${RISK_CLASS_LABELS[cls]}" can never be Allow for an agent: a person approves this work.`;
}

/**
 * Why a cell cannot be chosen, or null: the server's reason (AgentPolicyView.locked), and for an
 * Allow the engine never gives (canBeAllowed) a fixed one even when the list leaves it out, so an
 * incomplete list can never make such a cell look choosable.
 */
export function lockedReason(locked: Locked, cls: RiskClass, setting: PolicySetting): string | null {
  const fromServer = locked.find((l) => l.class === cls && l.setting === setting)?.reason;
  if (fromServer) return fromServer;
  return setting === 'allow' && !canBeAllowed(cls) ? neverAllowReason(cls) : null;
}

const STRICTNESS: Record<PolicySetting, number> = { allow: 0, ask: 1, never: 2 };

/** `a` lets the agent do more by itself than `b`. */
export function looser(a: PolicySetting, b: PolicySetting): boolean {
  return STRICTNESS[a] < STRICTNESS[b];
}

/**
 * Choose a cell. A locked cell changes nothing.
 *
 * Everywhere, an adjustment is kept only where it differs from the preset, so choosing the
 * preset's own setting takes the adjustment away.
 *
 * In an area, what the person chooses is kept as that area's own setting even when it is the same
 * as everywhere's: a restriction chosen for Payroll must not loosen by itself when someone later
 * loosens the setting for everywhere. "As everywhere" (clearSetting) makes the area follow again.
 */
export function chooseSetting(draft: PolicyDraft, locked: Locked, area: Area | null, cls: RiskClass, setting: PolicySetting): PolicyDraft {
  if (lockedReason(locked, cls, setting)) return draft;
  const rest = draft.overrides.filter((o) => !(o.class === cls && (o.area ?? null) === area));
  const inherited = inheritedSetting({ ...draft, overrides: rest }, area, cls);
  const keep = area !== null || setting !== inherited;
  const overrides = keep ? [...rest, { class: cls, area, setting }] : rest;
  return { ...draft, overrides: sortOverrides(overrides) };
}

/** The preset's own setting for a class, as the engine holds it (an Allow it never gives is Ask). */
export function presetSetting(preset: AgentPreset, cls: RiskClass): PolicySetting {
  const s = PRESET_DEFAULTS[preset][cls];
  return s === 'allow' && !canBeAllowed(cls) ? 'ask' : s;
}

/** The adjustments that let the agent do more by itself than its preset says, everywhere or in an area. */
export function looserThanPreset(draft: PolicyDraft): PolicyOverride[] {
  return draft.overrides.filter((o) => {
    const s = o.setting === 'allow' && !canBeAllowed(o.class) ? 'ask' : o.setting;
    return looser(s, presetSetting(draft.preset, o.class));
  });
}

/** Take away only the adjustments looser than the preset; stricter ones stay. */
export function clearLooser(draft: PolicyDraft): PolicyDraft {
  const loose = new Set(looserThanPreset(draft));
  return { ...draft, overrides: draft.overrides.filter((o) => !loose.has(o)) };
}

/** One adjustment in a few words: "Enter new in Banking: Allow". */
export function overrideText(o: PolicyOverride): string {
  const what = o.area ? `${RISK_CLASS_LABELS[o.class]} in ${areaLabel(o.area)}` : RISK_CLASS_LABELS[o.class];
  return `${what}: ${o.setting === 'allow' ? 'Allow' : o.setting === 'ask' ? 'Ask' : 'Never'}`;
}

/** Whether the draft lets the agent change many records at once by itself anywhere. */
export function allowsBulk(draft: PolicyDraft): boolean {
  const p = policyOf(draft);
  return settingFor(p, null, 'bulk') === 'allow' || AREA_KEYS.some((a) => settingFor(p, a, 'bulk') === 'allow');
}

/**
 * The most records one request may change once the draft is saved, as the engine would hold it:
 * the number typed, or, left empty, none, except while bulk work is Allow anywhere, which always
 * has one (DEFAULT_BULK_CAP). Null when there is no limit, or the typed text is not a number yet.
 */
export function capThatApplies(draft: PolicyDraft): number | null {
  const cap = draft.bulkCap.trim().replace(/,/g, '');
  if (cap === '') return allowsBulk(draft) ? DEFAULT_BULK_CAP : null;
  const n = wholeNumber(cap);
  return n >= 1 && n <= BULK_CAP_MAX ? n : null;
}

/** Take one adjustment away: the cell follows the preset (everywhere) or everywhere's setting (an area). */
export function clearSetting(draft: PolicyDraft, area: Area | null, cls: RiskClass): PolicyDraft {
  return { ...draft, overrides: draft.overrides.filter((o) => !(o.class === cls && (o.area ?? null) === area)) };
}

/** Take away every adjustment in one scope (everywhere: area null; an area; or all with 'all'). */
export function clearScope(draft: PolicyDraft, area: Area | null | 'all'): PolicyDraft {
  if (area === 'all') return { ...draft, overrides: [] };
  return { ...draft, overrides: draft.overrides.filter((o) => (o.area ?? null) !== area) };
}

/** How many adjustments each area has. */
export function areaCounts(draft: PolicyDraft): Partial<Record<Area, number>> {
  const out: Partial<Record<Area, number>> = {};
  for (const o of draft.overrides) if (o.area) out[o.area] = (out[o.area] ?? 0) + 1;
  return out;
}

/**
 * An amount as typed ("$5,000", "5000.00", "0") in the form the server stores ("5000.00"), or null
 * when it is not an amount the server takes: zero or more, at most two decimals, no larger than a
 * ledger amount. Zero is taken: it means every amount needs two people. Decimal, never a JS number.
 */
export function amountText(typed: string): string | null {
  const t = typed.trim().replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const d = toDecimal(t);
  return d.greaterThan(MAX_LEDGER_AMOUNT) ? null : d.toFixed(2);
}

const wholeNumber = (t: string) => (/^\d+$/.test(t) ? Number(t) : NaN);

/**
 * What a save sends: only the fields that changed, in the AgentPolicyInput shape. `overrides`
 * replaces every stored adjustment, so when any changed the whole list goes. A limit that cannot
 * be sent comes back as `error`, in plain words, and nothing is sent.
 *
 * A cap emptied while bulk work is Allow anywhere is sent as DEFAULT_BULK_CAP: such a policy always
 * has a cap (the engine and the server hold it to one), and the Limits form says empty means that.
 */
export function changesOf(initial: PolicyDraft, draft: PolicyDraft): { input: AgentPolicyInput; error: null } | { input: null; error: string } {
  const input: AgentPolicyInput = {};
  if (draft.preset !== initial.preset) input.preset = draft.preset;
  if (overridesKey(draft.overrides) !== overridesKey(initial.overrides)) input.overrides = sortOverrides(draft.overrides);

  const cap = draft.bulkCap.trim();
  if (cap !== initial.bulkCap.trim()) {
    if (cap === '') input.bulkCap = allowsBulk(draft) ? DEFAULT_BULK_CAP : null;
    else {
      const n = wholeNumber(cap.replace(/,/g, ''));
      if (!(n >= 1 && n <= BULK_CAP_MAX)) {
        return {
          input: null,
          error: `The most records one request may change must be a whole number from 1 to ${BULK_CAP_MAX.toLocaleString('en-US')}, or empty for no limit.`,
        };
      }
      input.bulkCap = n;
    }
  }

  const two = draft.twoPersonOver.trim();
  const twoBefore = initial.twoPersonOver.trim();
  if (two !== twoBefore) {
    if (two === '') input.twoPersonOver = null;
    else {
      const amount = amountText(two);
      if (!amount) {
        return {
          input: null,
          error: 'The amount for two-person approval must be an amount like 5000 or 5000.00 (0 for every amount), or empty for off.',
        };
      }
      // "5000" typed over a saved "5000.00" is the same amount: nothing to send.
      if (amount !== amountText(twoBefore)) input.twoPersonOver = amount;
    }
  }

  const days = draft.requestExpiryDays.trim();
  if (days !== initial.requestExpiryDays.trim()) {
    const n = wholeNumber(days);
    if (!(n >= 1 && n <= EXPIRY_DAYS_MAX)) {
      return { input: null, error: `Days a request waits for an answer must be a whole number from 1 to ${EXPIRY_DAYS_MAX}.` };
    }
    input.requestExpiryDays = n;
  }

  if (JSON.stringify(draft.folders) !== JSON.stringify(initial.folders)) input.folders = [...draft.folders];
  if (draft.notifyEmail !== initial.notifyEmail) input.notifyEmail = draft.notifyEmail;
  return { input, error: null };
}

/** Whether the draft differs from what was loaded (a limit typed wrong counts: Save says why). */
export function isChanged(initial: PolicyDraft, draft: PolicyDraft): boolean {
  const c = changesOf(initial, draft);
  return c.error !== null || Object.keys(c.input).length > 0;
}

/** Add a folder as typed. Null with a reason when it cannot be added. */
export function addFolder(draft: PolicyDraft, typed: string): { draft: PolicyDraft; error: null } | { draft: null; error: string } {
  const f = typed.trim();
  if (!f) return { draft: null, error: 'Type the full path of a folder first.' };
  if (draft.folders.some((x) => x.toLowerCase() === f.toLowerCase())) return { draft: null, error: 'That folder is already on the list.' };
  if (draft.folders.length >= FOLDERS_MAX) return { draft: null, error: `An agent can have at most ${FOLDERS_MAX} folders.` };
  return { draft: { ...draft, folders: [...draft.folders, f] }, error: null };
}

/**
 * Save changes with a folder typed but not added: it is added, as "Add folder" would, so a path
 * the person typed is never dropped without a word. One already on the list changes nothing.
 */
export function withTypedFolder(draft: PolicyDraft, typed: string): { draft: PolicyDraft; error: null } | { draft: null; error: string } {
  const f = typed.trim();
  if (!f || draft.folders.some((x) => x.toLowerCase() === f.toLowerCase())) return { draft, error: null };
  return addFolder(draft, f);
}

export function removeFolder(draft: PolicyDraft, folder: string): PolicyDraft {
  return { ...draft, folders: draft.folders.filter((f) => f !== folder) };
}
