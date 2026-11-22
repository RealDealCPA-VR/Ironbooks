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
 * The preset as the list and the detail page name it, with how many of the agent's settings
 * differ from the preset: "Read only (adjusted: 2)". So an agent switched to "Read only" that
 * still has looser changes is never shown as plain "Read only".
 *
 * N counts only settings that change what the cell would otherwise follow. A setting kept as
 * chosen (the preset's own, clicked, so a later change of preset cannot move it) changes nothing
 * today and is not counted. The list takes N from the server (AgentView.overrideCount, which counts
 * that way); the detail page works it out from the agent's own settings (differingCount), so its
 * header is right whatever the server counts.
 */
export function presetSummary(label: string, differing: number | null | undefined): string {
  if (!label || !differing || differing < 1) return label;
  return `${label} (adjusted: ${differing})`;
}

/**
 * What "(adjusted: N)" means, for its tooltip: N settings differ from the preset. The list has the
 * count only (`kept` left out) and sends the person to the agent for the detail; the detail page
 * passes `kept`, how many more settings only keep what the preset says (policyDraft.ts
 * keptAsChosen), and says that too. With nothing that differs and nothing kept: no tooltip.
 */
export function adjustedTitle(differing: number | null | undefined, kept?: number): string | undefined {
  const n = differing && differing > 0 ? differing : 0;
  const k = kept && kept > 0 ? kept : 0;
  if (n === 0) {
    if (k === 0) return undefined;
    return `No setting differs from the preset. ${keptWords(k)} Today the agent may do just what the preset says.`;
  }
  const head = `${n === 1 ? 'One setting differs' : `${n} settings differ`} from the preset, everywhere or in an area.`;
  if (kept === undefined) return `${head} Open the agent to see what it may do.`;
  return k === 0 ? head : `${head} ${keptWords(k, true)}`;
}

/**
 * How many of the agent's own settings only keep the setting they would have anyway (the preset's
 * everywhere, everywhere's in an area). `more`: said after the ones that differ.
 */
function keptWords(kept: number, more = false): string {
  const which = kept === 1 ? (more ? 'One more setting is' : 'One setting is') : `${kept} ${more ? 'more ' : ''}settings are`;
  const it = kept === 1 ? 'it' : 'them';
  return `${which} kept as chosen: ${kept === 1 ? 'it changes' : 'they change'} nothing today, and a later change of the preset or of everywhere cannot move ${it}.`;
}

/** The same, for the note under the preset (adjustedPresetNote), out of all `changes` of its own. */
function keptNoteWords(kept: number, changes: number): string {
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
  if (kept > 0) note += ` ${keptNoteWords(kept, changes)}`;
  return note;
}

// ---------------------------------------------------------------------------
// Only an Admin lets an agent do more by itself (plan 4.4)
// ---------------------------------------------------------------------------

/** On a control that would let the agent do more by itself, for a person who is not an Admin. */
export const ADMIN_TO_LOOSEN = 'Only an Admin can let an agent do more by itself.';

/** At the top of the detail page for a person who manages agents but is not an Admin. */
export const NOT_ADMIN_NOTE =
  'You can make this agent stricter, pause it, give it a folder inside one it already has, and take back its standing permissions. Only an Admin can let it do more by itself: a looser preset, Allow or Ask where it is stricter now, a higher limit on records per request, a folder outside the ones it has, a higher two-person amount, a longer wait for requests, or the email notice.';

/** On the list for a person who is not an Admin but may change Users & Roles > Users. */
export const NOT_ADMIN_LIST_NOTE = 'Only an Admin can make or remove an agent. Open one to make it stricter or pause it.';

/**
 * Making an agent stricter, pausing it and taking back its standing permission need the right to
 * change Users & Roles > Users (the server's personWhoManagesAgents). Someone who may only see
 * that list sees the agents too, and is told this instead of being offered what the server refuses.
 */
export const VIEW_ONLY_LIST_NOTE =
  'Only an Admin can make or remove an agent. To make one stricter or pause it, you need permission to change Users & Roles > Users: ask an Admin for it.';

/** At the top of the detail page for someone who may see agents but not change them. */
export const VIEW_ONLY_NOTE =
  "You can look at this agent's settings. To make it stricter, pause it or take back a standing permission, you need permission to change Users & Roles > Users: ask an Admin for it.";

/**
 * Pause all agents is the company's Integrated Applications switch, which only an Admin turns
 * (AgentRequestCount.canPauseAll). Said on the list to anyone the switch is not offered to, so
 * nobody is left looking for it.
 */
export const ADMIN_TO_PAUSE_ALL = 'Only an Admin can pause or resume all agents at once.';

/**
 * After a save, beside Save: folders the agent had that Ironbooks took off its list itself
 * (policyDraft.ts foldersTakenAway). The server does that, for a person who is not an Admin, to a
 * folder that would be refused were it given today (agentPolicies.ts keptFolderRefusal: a share of
 * this computer, a whole drive or a share's own folder, the books' or Ironbooks' own places); the
 * rest of the save went through. The answer does not say which rule each one broke, so this names
 * the rules and where the reason is written (the save's audit row, foldersTakenAway). The audit
 * trail needs its own permission (lib/permissions/routes.ts), which a person who manages agents may
 * not have, so the note says an Admin can look. What only an Admin may add is said as LimitsForm
 * says it (ADMIN_TO_ADD_FOLDER): a folder inside one the agent still has is open to this person.
 */
export function foldersTakenAwayNote(folders: string[]): string {
  const one = folders.length === 1;
  const list = folders.map((f) => `"${f}"`).join(', ');
  return `Saved. Ironbooks took ${one ? 'this folder' : 'these folders'} off the agent's list, because an agent may no longer be given ${one ? 'it' : 'them'}: ${list}. A folder is taken off when it is a whole drive or share, a share of this computer, or holds or is inside the company file's folders or Ironbooks' own data. The audit trail entry for this save says which; if you cannot open the audit trail, an Admin can. Only an Admin can give the agent a folder outside the ones it has.`;
}

/** Under the limits a person who is not an Admin may only lower. */
export const ADMIN_TO_RAISE_CAP = 'Only an Admin can raise this limit or take it away. You can lower it.';
/** The same, where no limit is saved: standing permissions are still held to the usual one (DEFAULT_BULK_CAP). */
export function adminToRaiseUsualCap(usual: number): string {
  return `With no limit saved, standing permissions are still held to the usual ${usual.toLocaleString('en-US')} records a request. Only an Admin can set a limit above that. You can set one up to ${usual.toLocaleString('en-US')}.`;
}
export const ADMIN_TO_RAISE_TWO_PERSON = 'Only an Admin can raise this amount or turn two-person approval off. You can lower it, or turn it on.';
export const ADMIN_TO_ADD_FOLDER =
  'Only an Admin can give an agent a folder outside the ones it has. You can add a folder inside one of them, or take folders off the list.';
/** The same, for an agent with no folder yet: there is nothing to add a folder inside. */
export const ADMIN_TO_ADD_FIRST_FOLDER = 'Only an Admin can give an agent a folder.';
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

/**
 * D1: shown when the Admin role is ticked, and on the page of an agent that holds it. Admin work
 * (users and roles, the company file, passwords) stays on Never under "Ask for every change", the
 * new agent's preset (PRESET_DEFAULTS, lib/agent/policy.ts), so the warning says the agent can ask
 * for it only where its settings say Ask, as the set-up-an-agent article in lib/kb/articles.ts does.
 */
export const ADMIN_ROLE_WARNING =
  'With the Admin role this agent can ask for Admin work: users and roles, backups, restoring, the company file and passwords, wherever its settings say Ask for that work ("Ask for every change" keeps it on Never). Every one of those requests still needs a person to say yes, and only an Admin can approve them. Choose it only if the agent needs that work.';

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
