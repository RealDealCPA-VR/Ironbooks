/**
 * Users & Roles > Agents: the words the tab and the agent's detail page share (plan 7.1, 11.1).
 *
 * Pure: no React, no fetch, no Node. What the words promise is enforced by the server
 * (lib/services/agents.ts, agentPolicies.ts, lib/agent/policy.ts); this file only says it, so the
 * New agent dialog and the detail page say it the same way.
 */
import { AGENT_PRESET_LABELS, RISK_CLASS_LABELS, type AgentPreset, type GrantConstraints, type PolicySetting, type RequestStatus, type RiskClass } from '@/lib/agent/operations/types';
import type { AgentMode } from '@/lib/permissions/agentAccess';
import { DEFAULT_PRESET } from '@/lib/agent/policy';

export { AGENT_PRESET_LABELS, RISK_CLASS_LABELS };

/**
 * One line per preset: what the agent does by itself, and what waits for a person (plan 4.2). It
 * describes the preset as it comes; changes made in the grid are shown with the agent's preset
 * (presetSummary) and on its detail page. No number that can be changed is named here.
 */
export const PRESET_HELP: Record<AgentPreset, string> = {
  read_only: 'Looks at lists, registers and reports. Changes nothing and asks for nothing.',
  ask_every_change:
    'Looks and prepares drafts by itself. Every change to the books waits for a person to say yes. Never Users & Roles, the company file or passwords.',
  trusted_bookkeeper:
    'Looks, prepares drafts, enters and edits everyday transactions by itself. Protected data, changing many at once, deleting, closed periods, sending, printing, settings and company file work wait for a person. Never Users & Roles or passwords.',
  full_with_asks:
    'Looks, prepares drafts, enters, edits and changes many records at once by itself, within a limit on how many one request may change. Protected data, deleting, closed periods, sending, printing, settings, Users & Roles, the company file and passwords wait for a person.',
};

/** D2: a new agent starts here: the server's own default (DEFAULT_PRESET, lib/agent/policy.ts). */
export const NEW_AGENT_PRESET: AgentPreset = DEFAULT_PRESET;

/**
 * The preset as the list and the detail page name it, with how many settings the agent has of its
 * own (stored adjustments, AgentView.overrideCount): "Read only (adjusted: 2)". So an agent
 * switched to "Read only" that still has looser changes is never shown as plain "Read only".
 */
export function presetSummary(label: string, changes: number | null | undefined): string {
  if (!label || !changes || changes < 1) return label;
  return `${label} (adjusted: ${changes})`;
}

/**
 * What "(adjusted: N)" means, for its tooltip. N counts every setting of the agent's own, and one
 * may only keep the setting its cell would follow anyway ("Kept as chosen", so a later change of
 * preset cannot move it): an adjusted agent does not always do other than its preset. The list
 * cannot tell (it has the count only), so it says so; the detail page passes `kept`, how many of
 * them change nothing today (policyDraft.ts keptAsChosen), and says it exactly.
 */
export function adjustedTitle(changes: number | null | undefined, kept?: number): string | undefined {
  if (!changes || changes < 1) return undefined;
  const head = `${changes === 1 ? 'One kind of work is' : `${changes} kinds of work are`} set for this agent itself, everywhere or in an area.`;
  if (kept === undefined) {
    return `${head} Some may only keep the setting they would have anyway, so a later change cannot move them. Open the agent to see what it may do.`;
  }
  if (kept <= 0) return `${head} ${changes === 1 ? 'It changes' : 'Each one changes'} what the agent may do.`;
  if (kept >= changes) {
    return `${head} ${keptWords(changes, changes)} Today the agent may do just what the preset says.`;
  }
  return `${head} ${keptWords(kept, changes)}`;
}

/** How many of the agent's own settings only keep the setting they would have anyway. */
function keptWords(kept: number, changes: number): string {
  if (kept >= changes) {
    return changes === 1
      ? 'It only keeps the setting it would have anyway, so a later change cannot move it.'
      : 'Each one only keeps the setting it would have anyway, so a later change cannot move them.';
  }
  return kept === 1
    ? 'One of them only keeps the setting it would have anyway, so a later change cannot move it.'
    : `${kept} of them only keep the setting they would have anyway, so a later change cannot move them.`;
}

/**
 * Said under the preset's own line on the detail page when the agent has settings of its own, so
 * the preset's line ("Changes nothing and asks for nothing") never claims more than is true: it
 * describes the preset as it comes, and this says what the agent's own settings add. `kept`: how
 * many of them only keep the setting they would have anyway (policyDraft.ts keptAsChosen).
 */
export function adjustedPresetNote(changes: number, looserChanges: string[], kept = 0): string | null {
  if (changes < 1) return null;
  let note = `That is the preset as it comes. This agent has ${changes === 1 ? 'one setting' : `${changes} settings`} of its own, so the grid below is what holds.`;
  if (looserChanges.length > 0) {
    note += ` ${looserChanges.length === 1 ? 'One of them lets' : `${looserChanges.length} of them let`} it do more by itself than the preset says: ${looserChanges.join('; ')}.`;
  }
  if (kept > 0) note += ` ${keptWords(kept, changes)}`;
  return note;
}

// ---------------------------------------------------------------------------
// Only an Admin lets an agent do more by itself (plan 4.4)
// ---------------------------------------------------------------------------

/** On a control that would let the agent do more by itself, for a person who is not an Admin. */
export const ADMIN_TO_LOOSEN = 'Only an Admin can let an agent do more by itself.';

/** At the top of the detail page for a person who manages agents but is not an Admin. */
export const NOT_ADMIN_NOTE =
  'You can make this agent stricter, pause it and take back its standing permissions. Only an Admin can let it do more by itself: a looser preset, Allow or Ask where it is stricter now, a higher limit on records per request, another folder, a higher two-person amount, a longer wait for requests, or the email notice.';

/** On the list for a person who is not an Admin. */
export const NOT_ADMIN_LIST_NOTE = 'Only an Admin can make or remove an agent. Open one to make it stricter or pause it.';

/** Under the limits a person who is not an Admin may only lower. */
export const ADMIN_TO_RAISE_CAP = 'Only an Admin can raise this limit or take it away. You can lower it.';
/** The same, where no limit is saved: standing permissions are still held to the usual one (DEFAULT_BULK_CAP). */
export function adminToRaiseUsualCap(usual: number): string {
  return `With no limit saved, standing permissions are still held to the usual ${usual.toLocaleString('en-US')} records a request. Only an Admin can set a limit above that. You can set one up to ${usual.toLocaleString('en-US')}.`;
}
export const ADMIN_TO_RAISE_TWO_PERSON = 'Only an Admin can raise this amount or turn two-person approval off. You can lower it, or turn it on.';
export const ADMIN_TO_ADD_FOLDER = 'Only an Admin can give an agent another folder. You can take folders off the list.';
export const ADMIN_TO_RAISE_DAYS = 'Only an Admin can let requests wait longer. You can shorten the wait.';
export const ADMIN_TO_NOTIFY = 'Only an Admin can turn the email notice on, since it sends email outside this computer. You can turn it off.';
/**
 * On Resume, for a person who is not an Admin, when the agent holds the Admin role: the server's
 * own words (lib/services/agentPolicies.ts ADMIN_AGENT_RESUME). An agent with more access than the
 * person in another way is refused by the server too, and that refusal is shown as it is.
 */
export const ADMIN_TO_RESUME_ADMIN_AGENT = 'Only an Admin can turn back on an agent that holds the Admin role.';

/** By the Save button when the draft would let the agent do more, for a person who is not an Admin. */
export function adminOnlyNote(loosenings: string[]): string {
  const n = loosenings.length;
  return `${ADMIN_TO_LOOSEN} ${n === 1 ? 'This change would give it' : 'These changes would give it'}: ${loosenings.join('; ')}. Put ${n === 1 ? 'it' : 'them'} back to save the rest, or ask an Admin.`;
}

/** Shown when another preset is picked and some changes still let the agent do more than it. */
export function looserNote(presetLabel: string, changes: string[]): string {
  const n = changes.length;
  return `"${presetLabel}" is chosen, but ${n === 1 ? 'one change still lets' : `${n} changes still let`} the agent do more by itself than that preset: ${changes.join('; ')}. Take ${n === 1 ? 'it' : 'them'} away, or keep ${n === 1 ? 'it' : 'them'} on purpose.`;
}

/** The preset an agent listed without one has: the older mode's own (presetForMode, lib/agent/policy.ts). */
const PRESET_OF_MODE: Record<AgentMode, AgentPreset> = {
  read_only: 'read_only',
  propose: 'ask_every_change',
  post: 'trusted_bookkeeper',
};

export function presetLabelOf(a: { preset?: AgentPreset | null; mode?: AgentMode | null }): string {
  const preset = a.preset && a.preset in AGENT_PRESET_LABELS ? a.preset : a.mode && a.mode in PRESET_OF_MODE ? PRESET_OF_MODE[a.mode] : null;
  return preset ? AGENT_PRESET_LABELS[preset] : '';
}

/** One line per kind of work, in plain words (plan 4.2, "What it covers"). */
export const CLASS_HELP: Record<RiskClass, string> = {
  read: 'Look at lists, registers and reports.',
  read_sensitive: 'See protected data: full Social Security numbers, full account numbers, payroll detail.',
  prepare: 'Work a person can throw away: statement lines, drafts, notes, to-dos, ticking off a reconciliation.',
  enter: 'Add new transactions and list entries: invoices, bills, estimates, customers, items.',
  change: 'Edit or void what is already there, apply credits, finish a reconciliation.',
  bulk: 'One request that changes many records: batch invoicing, merging, accepting many bank lines.',
  remove: 'Delete for good, or anything else that cannot be undone.',
  period: 'Enter or change on or before the closing date, or move the closing date.',
  outside: 'Anything that leaves this computer: emailing forms and reports, 1099 files, AI services.',
  print: 'Print checks, forms and labels on a real printer.',
  settings: 'Company preferences, templates, numbering, sales tax, payroll, email and AI settings.',
  admin: 'Users, roles, password rules, file protection and who is signed in.',
  file: 'Back up, restore, copy, open, switch or close the company file.',
  secret: 'Work that needs or shows a password or key. It is typed or shown only on the screen of the person who approves.',
};

export const SETTING_LABELS: Record<PolicySetting, string> = { allow: 'Allow', ask: 'Ask', never: 'Never' };

export const SETTING_HELP: Record<PolicySetting, string> = {
  allow: 'Does it by itself',
  ask: 'Asks a person first',
  never: 'Refused',
};

/** Plan 11.1: the choice of role and preset now matters more, and the tab says so. */
export const ROLE_AND_PRESET_NOTE =
  'The role is the most an agent can ever ask for: anything outside it is refused. The preset is what it may do without asking. Anyone who gets hold of its token can ask for everything the role allows, so choose the smallest role and the strictest preset that do the job.';

/** Under the role choice. */
export const ROLE_HELP =
  'An agent sees what a person with this role sees, and can ask for no more than the role allows. Full Social Security numbers, full account numbers and work in a closed period never happen without a person saying yes, one request at a time.';

/** D1: shown when the Admin role is ticked. */
export const ADMIN_ROLE_WARNING =
  'With the Admin role this agent can ask for anything an Admin can do: users and roles, backups, restoring, the company file and passwords. Every one of those requests still needs a person to say yes, and only an Admin can approve them. Choose it only if the agent needs that work.';

export const POLICY_INTRO =
  'For each kind of work: Allow lets the agent do it by itself, Ask makes it wait for a person, Never refuses it. A locked choice cannot be made for an agent. What you click is kept as chosen, even when it is the preset\'s own, so a later change of preset does not move it; "As the preset" makes it follow again.';

export const AREA_INTRO =
  'Make an exception for one area, such as "Allow entry in Banking, Ask in Payroll". A kind of work not set here follows the setting for everywhere. What you choose here stays when the setting for everywhere changes, even when it is the same now; "As everywhere" makes it follow again.';

export const GRANTS_INTRO =
  'Standing permission a person gave while approving a request ("this and similar ones until the end of the day"). Revoke takes it back at once; the next such request waits for a person again.';

/** Why a standing permission that is still listed does nothing right now. */
export const GRANT_PAUSED = 'Not in effect while this agent is paused. It counts again if the agent is resumed before it ends.';
export const GRANT_ALL_PAUSED =
  'Not in effect while every agent is paused (Preferences > Integrated Applications). It counts again if that is turned back on before it ends.';

/** Asked once before a standing permission is taken back. */
export function revokeQuestion(agentName: string, what: string): string {
  return `${agentName} will ask a person again before "${what}", one request at a time. A person can give standing permission again when approving a request.`;
}

export const ACTIVITY_INTRO = 'Its last 200 operations and requests, newest first.';

/** Integrated Applications is off: every agent is paused, whatever its own switch says. */
export const ALL_PAUSED_NOTE =
  'Every agent is paused: applications are not allowed into this company file (Preferences > Integrated Applications). Nothing an agent asks for runs until that is turned back on.';

/** The list's short form of ALL_PAUSED_NOTE, on each agent's Paused badge. */
export const ALL_PAUSED_TITLE = 'Every agent is paused (Preferences > Integrated Applications).';

export const PAUSED_NOTE =
  'This agent is paused. Everything it asks for is refused until someone resumes it. Its token and settings stay as they are.';

export const REMOVED_NOTE = 'This agent has been removed. Its settings are shown as they were; what it did stays in the audit trail.';

/** How a row of the activity list ended. */
export const ACTIVITY_STATUS_LABELS: Record<RequestStatus | 'done' | 'refused', string> = {
  pending: 'Waiting',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Failed',
  executed: 'Done',
  done: 'Done',
  refused: 'Refused',
};

export const ACTIVITY_STATUS_TONES: Record<RequestStatus | 'done' | 'refused', 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = {
  pending: 'warning',
  approved: 'info',
  denied: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
  failed: 'danger',
  executed: 'success',
  done: 'success',
  refused: 'danger',
};

export function when(iso: string | null | undefined, never = 'Never'): string {
  if (!iso) return never;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? never : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a standing permission is held to, one short phrase each (GrantConstraints). */
export function constraintText(c: GrantConstraints | null | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.entityIds?.length) out.push(`only ${plural(c.entityIds.length, 'customer or vendor', 'customers or vendors')}`);
  if (c.accountIds?.length) out.push(`only ${plural(c.accountIds.length, 'account', 'accounts')}`);
  if (c.maxAmount) out.push(`up to ${c.maxAmount}`);
  if (c.dateFrom && c.dateTo) out.push(`dated ${c.dateFrom} to ${c.dateTo}`);
  else if (c.dateFrom) out.push(`dated ${c.dateFrom} or later`);
  else if (c.dateTo) out.push(`dated ${c.dateTo} or earlier`);
  if (c.maxCount) out.push(`at most ${plural(c.maxCount, 'record', 'records')} a request`);
  return out;
}
