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
  AGENT_PRESETS,
  AGENT_PRESET_LABELS,
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
 * What the person clicks is kept as the cell's own setting, even when it is the same as the one
 * the cell would follow (the preset's everywhere, everywhere's in an area): a restriction someone
 * chose must not loosen by itself when the preset, or the setting for everywhere, is loosened
 * later. "As the preset" / "As everywhere" (clearSetting) makes the cell follow again.
 */
export function chooseSetting(draft: PolicyDraft, locked: Locked, area: Area | null, cls: RiskClass, setting: PolicySetting): PolicyDraft {
  if (lockedReason(locked, cls, setting)) return draft;
  const rest = draft.overrides.filter((o) => !(o.class === cls && (o.area ?? null) === area));
  return { ...draft, overrides: sortOverrides([...rest, { class: cls, area, setting }]) };
}

/** An adjustment everywhere that only repeats the preset's own setting (kept so it cannot move). */
export function repeatsPreset(draft: PolicyDraft, o: PolicyOverride): boolean {
  return o.area === null && o.setting === presetSetting(draft.preset, o.class);
}

/**
 * The adjustments that change nothing today: each keeps the setting its cell would follow anyway
 * (the preset's everywhere, everywhere's in an area), only so a later change cannot move it. They
 * are the agent's own settings but do not make it differ from its preset, so "(adjusted: N)" leaves
 * them out (differingCount) and the detail page says how many of them are only kept as chosen.
 */
export function keptAsChosen(draft: PolicyDraft): PolicyOverride[] {
  return draft.overrides.filter((o) => {
    const s = o.setting === 'allow' && !canBeAllowed(o.class) ? 'ask' : o.setting;
    return s === inheritedSetting(draft, o.area ?? null, o.class);
  });
}

/**
 * How many of the agent's own settings differ from the preset: those that change what their cell
 * would otherwise follow. "(adjusted: N)" on the detail page, worked out here from the settings
 * themselves, so it is right whether or not the server's overrideCount counts the same way.
 */
export function differingCount(draft: PolicyDraft): number {
  return draft.overrides.length - keptAsChosen(draft).length;
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

// ---------------------------------------------------------------------------
// Loosening: only an Admin may let an agent do more by itself (plan 4.4)
// ---------------------------------------------------------------------------
//
// A person who may manage agents but is not an Admin may make an agent stricter or pause it. What
// counts as loosening: a higher preset, a cell that lets the agent do more by itself than it does
// now (as the engine resolves it), a higher limit on records per request or none, a folder outside
// the ones it has (addedFolders), a higher two-person amount or none, and, as the server also
// holds them (lib/services/agentPolicies.ts), a longer wait for requests and turning the email
// notice on (an outside send). Everything is compared with what was saved (`before`),
// so a person who tightened something in the draft may always put it back. The screen uses this to
// disable those controls and say why; the server checks the same and has the last word.

/** `a` is a preset that lets the agent do more by itself than `b` (AGENT_PRESETS runs strictest first). */
export function presetLooser(a: AgentPreset, b: AgentPreset): boolean {
  return AGENT_PRESETS.indexOf(a) > AGENT_PRESETS.indexOf(b);
}

/** One cell that would let the agent do more by itself: everywhere (area null) or in one area. */
export interface LooserCell {
  class: RiskClass;
  area: Area | null;
  from: PolicySetting;
  to: PolicySetting;
}

/**
 * The cells where `after` lets the agent do more by itself than `before`, everywhere and in each
 * area, as the engine resolves them. When everywhere loosened, an area that simply moved with it
 * (it showed everywhere's setting before and shows it after) is not named again: that line already
 * covers it. An area that loosened otherwise, by its own row, is named too, so the list is
 * everything a save loosens, as the server's own check names it (lib/services/agentPolicies.ts
 * loosenings). `only` checks one kind of work.
 */
export function looserCells(before: PolicyDraft, after: PolicyDraft, only?: RiskClass): LooserCell[] {
  const a = policyOf(before);
  const b = policyOf(after);
  const out: LooserCell[] = [];
  for (const cls of only ? [only] : RISK_CLASSES) {
    const from = settingFor(a, null, cls);
    const to = settingFor(b, null, cls);
    const everywhereLoosened = looser(to, from);
    if (everywhereLoosened) out.push({ class: cls, area: null, from, to });
    for (const area of AREA_KEYS) {
      const f = settingFor(a, area, cls);
      const t = settingFor(b, area, cls);
      if (!looser(t, f)) continue;
      if (everywhereLoosened && f === from && t === to) continue;
      out.push({ class: cls, area, from: f, to: t });
    }
  }
  return out;
}

/**
 * The limit on records per request a save would raise or take away: what applies now and what
 * would apply (null = no limit). Null when the cap is not sent, is not raised, or is typed wrong
 * (changesOf says why then).
 *
 * As the server measures it (lib/services/agentPolicies.ts loosenings): where no limit was saved,
 * a standing permission for bulk work is still held to the usual DEFAULT_BULK_CAP, so a number
 * above it is a raise from that usual limit (`usual`), and one at or below it only tightens.
 */
export function capLoosened(before: PolicyDraft, after: PolicyDraft): { from: number; to: number | null; usual?: true } | null {
  const typed = after.bulkCap.trim().replace(/,/g, '');
  const had = before.bulkCap.trim().replace(/,/g, '');
  if (typed === had) return null;
  const saved = capThatApplies(before);
  const usual = saved === null && had === '';
  const from = saved ?? (usual ? DEFAULT_BULK_CAP : null);
  if (from === null) return null;
  let to: number | null;
  if (typed === '') to = allowsBulk(after) ? DEFAULT_BULK_CAP : null;
  else {
    const n = wholeNumber(typed);
    if (!(n >= 1 && n <= BULK_CAP_MAX)) return null;
    to = n;
  }
  if (!(to === null || to > from)) return null;
  return usual ? { from, to, usual: true } : { from, to };
}

/**
 * The two-person amount a save would raise or turn off: the saved amount and the new one (null =
 * off). Compared as decimals (lib/money.ts). Null when it is not loosened, or typed wrong.
 */
export function twoPersonLoosened(before: PolicyDraft, after: PolicyDraft): { from: string; to: string | null } | null {
  const from = before.twoPersonOver.trim() === '' ? null : amountText(before.twoPersonOver);
  if (from === null) return null;
  const typed = after.twoPersonOver.trim();
  if (typed === '') return { from, to: null };
  const to = amountText(typed);
  if (to === null) return null;
  return toDecimal(to).greaterThan(toDecimal(from)) ? { from, to } : null;
}

/** The days a request waits, raised: saved and new. Null when not raised, or typed wrong. */
export function expiryLoosened(before: PolicyDraft, after: PolicyDraft): { from: number; to: number } | null {
  const from = wholeNumber(before.requestExpiryDays.trim());
  const to = wholeNumber(after.requestExpiryDays.trim());
  if (!(to >= 1 && to <= EXPIRY_DAYS_MAX) || !(from >= 1)) return null;
  return to > from ? { from, to } : null;
}

/** The email notice turned on (it is itself an email that leaves this computer). */
export function notifyLoosened(before: PolicyDraft, after: PolicyDraft): boolean {
  return after.notifyEmail && !before.notifyEmail;
}

/** Folders in `after` that `before` did not have (the same folder in other letter case is not new). */
export function newFolders(before: PolicyDraft, after: PolicyDraft): string[] {
  const had = new Set(before.folders.map((f) => f.toLowerCase()));
  return after.folders.filter((f) => !had.has(f.toLowerCase()));
}

/** A Windows path: a drive letter or a network share. Compared without regard to letter case. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * A full path as its parts, by the words alone (no disk): a drive ("c:"), a share ("\\server\share")
 * or "/" first, then each folder. Null when it is not a full path or has a "." or ".." part, which
 * the words cannot place: such a path never counts as inside another one.
 */
function pathParts(p: string): string[] | null {
  const t = p.trim();
  if (WINDOWS_PATH.test(t)) {
    const parts = t.replace(/\//g, '\\').split('\\');
    if (parts[0] === '' && parts[1] === '') {
      // \\server\share\rest: the share is the root.
      const [, , server, share, ...rest] = parts;
      if (!server || !share) return null;
      return clean([`\\\\${server}\\${share}`.toLowerCase(), ...rest.map((s) => s.toLowerCase())]);
    }
    return clean(parts.map((s) => s.toLowerCase()));
  }
  if (t.startsWith('/')) return clean(['/', ...t.split('/')]);
  return null;
}

function clean(parts: string[]): string[] | null {
  const [root, ...rest] = parts;
  const folders = rest.filter((s) => s !== '');
  return folders.some((s) => s === '.' || s === '..') ? null : [root, ...folders];
}

/**
 * `child` is a folder inside `parent`, by the words alone: both full paths, `parent` not a whole
 * drive or share (the server never takes one as an agent's folder), and every part of `parent`
 * starts `child`. Windows paths compare without regard to letter case, as the server does there.
 */
export function insideFolder(child: string, parent: string): boolean {
  const c = pathParts(child);
  const p = pathParts(parent);
  if (!c || !p || p.length < 2 || c.length <= p.length) return false;
  return p.every((part, i) => c[i] === part);
}

/**
 * The new folders that would let the agent use something it cannot use now: those not inside a
 * folder it already has (`before`), by the words.
 *
 * As the server counts them (lib/services/agentPolicies.ts loosenings): a folder inside one the
 * agent already has gives it nothing more. The server also asks the disk whether that stored folder
 * really reaches the new one (not a mounted volume, a link off elsewhere, or one of Ironbooks' own
 * places), which a window cannot see; when it does not, the server refuses the save in its own
 * words, and the page shows them. So a person who is not an Admin may add a folder inside one the
 * agent has (LimitsForm), and the server has the last word.
 */
export function addedFolders(before: PolicyDraft, after: PolicyDraft): string[] {
  return newFolders(before, after).filter((f) => !before.folders.some((had) => insideFolder(f, had)));
}

const SETTING_WORD: Record<PolicySetting, string> = { allow: 'Allow', ask: 'Ask', never: 'Never' };

/**
 * What a save would let the agent do more of by itself, one short phrase each, in plain words.
 * Empty when it only tightens or changes nothing that matters for safety.
 */
export function looseningsOf(before: PolicyDraft, after: PolicyDraft): string[] {
  const out: string[] = [];
  if (presetLooser(after.preset, before.preset)) {
    out.push(`the preset "${AGENT_PRESET_LABELS[after.preset]}" in place of "${AGENT_PRESET_LABELS[before.preset]}"`);
  } else {
    for (const c of looserCells(before, after)) {
      const what = c.area ? `"${RISK_CLASS_LABELS[c.class]}" in ${areaLabel(c.area)}` : `"${RISK_CLASS_LABELS[c.class]}"`;
      out.push(`${what} from ${SETTING_WORD[c.from]} to ${SETTING_WORD[c.to]}`);
    }
  }
  const cap = capLoosened(before, after);
  if (cap) {
    out.push(
      cap.to === null
        ? 'no limit on the records one request may change'
        : `up to ${cap.to.toLocaleString('en-US')} records in one request instead of ${cap.usual ? 'the usual ' : ''}${cap.from.toLocaleString('en-US')}`,
    );
  }
  const two = twoPersonLoosened(before, after);
  if (two) out.push(two.to === null ? 'two-person approval turned off' : `two-person approval only above ${two.to} instead of ${two.from}`);
  for (const f of addedFolders(before, after)) out.push(`another folder: ${f}`);
  const days = expiryLoosened(before, after);
  if (days) out.push(`requests that wait ${days.to} days instead of ${days.from}`);
  if (notifyLoosened(before, after)) out.push('the email notice turned on, which sends email outside this computer');
  return out;
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
          error: `The most records one request may change must be a whole number from 1 to ${BULK_CAP_MAX.toLocaleString('en-US')}, or empty: no limit, or ${DEFAULT_BULK_CAP} while "${RISK_CLASS_LABELS.bulk}" is Allow anywhere.`,
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

/** A folder as words to compare: either slash, no trailing one, letter case ignored on Windows. */
function folderWords(p: string): string {
  const t = p.trim();
  if (!WINDOWS_PATH.test(t)) return t.replace(/\/+$/, '') || t;
  return t.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * The folders the agent had (`saved`) that a save sent back (`sent`, AgentPolicyInput.folders) and
 * the server's answer (`answer`, the saved policy's folders) no longer holds: Ironbooks took them
 * away itself. The server does that for a person who is not an Admin when a folder the agent had
 * would be refused were it new today (lib/services/agentPolicies.ts checkFolders: a whole drive, a
 * share of this computer, or one that holds the company file or Ironbooks' own data); the save
 * goes through, since taking a folder away only tightens, and the audit row says why
 * (foldersTakenAway). The answer has no field for it, so the page finds them here and says so.
 *
 * Only folders the agent already had are compared: one it had is kept as stored, spelled as it
 * was, while a new one is stored as the disk names it, so a new folder spelled otherwise is never
 * taken for one taken away. Nothing sent (folders unchanged): nothing was looked at. An answer
 * without a folder list says nothing either way, so nothing is said to be taken away.
 */
export function foldersTakenAway(saved: PolicyDraft, sent: readonly string[] | undefined, answer: readonly string[] | null | undefined): string[] {
  if (!sent || !Array.isArray(answer)) return [];
  const asked = new Set(sent.map(folderWords));
  const kept = new Set(answer.map(folderWords));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of saved.folders) {
    const w = folderWords(f);
    if (!asked.has(w) || kept.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(f);
  }
  return out;
}
