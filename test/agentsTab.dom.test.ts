/**
 * Agent access: Users & Roles > Agents on screen (app/users/AgentsTab.tsx and the agent's detail
 * page, app/users/agents/), the settings it hands the Admin to paste into Claude Code or Claude
 * Desktop, and the detail page's unsaved policy (app/users/agents/policyDraft.ts).
 */
import { describe, expect, it } from 'vitest';
import { agentConnection } from '@/lib/agent/connection';
import { claudeCodeCommand, claudeDesktopConfig } from '@/app/users/AgentsTab';
import {
  addFolder,
  addedFolders,
  amountText,
  capLoosened,
  capThatApplies,
  changesOf,
  chooseSetting,
  clearLooser,
  clearScope,
  clearSetting,
  draftFrom,
  inheritedSetting,
  isChanged,
  keptAsChosen,
  lockedReason,
  looserCells,
  looserThanPreset,
  looseningsOf,
  neverAllowReason,
  overrideText,
  policyOf,
  presetLooser,
  cellSetting,
  repeatsPreset,
  twoPersonLoosened,
  withTypedFolder,
  type PolicyDraft,
} from '@/app/users/agents/policyDraft';
import {
  ADMIN_TO_LOOSEN,
  ADMIN_TO_RESUME_ADMIN_AGENT,
  CLASS_HELP,
  GRANT_ALL_PAUSED,
  GRANT_PAUSED,
  NEW_AGENT_PRESET,
  PRESET_HELP,
  adjustedPresetNote,
  adjustedTitle,
  adminOnlyNote,
  adminToRaiseUsualCap,
  presetLabelOf,
  presetSummary,
} from '@/app/users/agents/words';
import { grantState } from '@/app/users/agents/GrantsSection';
import { AGENT_PRESETS, NEVER_ALLOW_CLASSES, RISK_CLASSES, type AgentPreset, type PolicyOverride } from '@/lib/agent/operations/types';
import { DEFAULT_BULK_CAP, DEFAULT_PRESET, resolvePolicy } from '@/lib/agent/policy';
import type { AgentPolicyView } from '@/lib/agent/contract';
import { TOKEN_ENV } from '../mcp/client.mjs';
import { expectAllPassed, runDomFile } from './domHarness';

const TOKEN = `ibka_0123abcd_${'T'.repeat(43)}`;

describe('the Agents tab', () => {
  // "New agent" changed on purpose with full access (plan D1, D2): the Admin role is offered with a
  // warning, and a preset is sent instead of the older mode.
  it('lists agents without tokens, makes one with a preset and shows its token once, opens its detail page, removes after asking, and only lists on another computer', async () => {
    expectAllPassed(await runDomFile('test/dom/agentsTab.dom.tsx', 200_000), [
      'the list shows each agent, its role and last use, and never a token',
      'New agent: name, roles (Admin with a warning) and the chosen preset are sent, and the token is shown once',
      'working while nobody is signed in is off unless ticked, and says what it means',
      'a company file with passwords: the switch is not offered, and the tab says why',
      'a refusal from the server is said in its own words, and the dialog stays',
      'Remove asks first, then takes the access away',
      'on another computer the tab only lists',
      'the agent detail: the grid shows locked cells with their reason, and they cannot be changed',
      'saving sends only what changed, in the policy shape',
      'standing permissions: who gave it, what it is held to and until when; Revoke asks once, then takes it back',
      'a standing permission is marked as not in effect while the agent is paused',
      'Pause and Resume call the pause route, and Remove asks first',
      'activity: what it ran and asked, with links to the approval center and the audit trail',
      'the list marks an adjusted preset, and every agent as paused while Integrated Applications is off',
      'picking a stricter preset says which changes still let the agent do more, and takes them away on request',
      'an Allow the engine never gives stays locked even when the server list leaves it out',
      'an area keeps the setting chosen for it, even the one it already follows',
      'a folder typed but not added is added by Save, and the cap that applies is shown',
      'on another computer the detail only shows the policy, and the agent can still be paused',
      'a click on the setting a cell already follows keeps it as chosen, everywhere too',
      'a person who is not an Admin can make an agent stricter or pause it, and never let it do more',
      'a person who is not an Admin is not offered Resume for an agent with the Admin role',
      'the page can say whether the person is an Admin, and the tab then does not ask again',
      'the audit trail opens the entry its address names, expanded and scrolled to',
      'an audit trail entry that cannot be found is said once, and the whole trail is shown; another failure is said as it is, with Try again',
    ]);
  }, 300_000);
});

describe('the detail page: the unsaved policy and what a save sends', () => {
  const LOCKED: AgentPolicyView['locked'] = [
    { class: 'remove', setting: 'allow', reason: '"Delete for good" can never be Allow for an agent: a person approves this work.' },
  ];
  function view(preset: AgentPreset, overrides: PolicyOverride[] = []): AgentPolicyView {
    return { agentId: 'a1', preset, overrides, locked: LOCKED, policy: resolvePolicy(preset, overrides, { requestExpiryDays: 7, folders: ['C:\\Receipts'] }) };
  }
  const start = (): PolicyDraft => draftFrom(view('ask_every_change'));

  it('starts from what was saved, and sends nothing when nothing changed', () => {
    const d = start();
    expect(d).toEqual({ preset: 'ask_every_change', overrides: [], bulkCap: '', twoPersonOver: '', requestExpiryDays: '7', folders: ['C:\\Receipts'], notifyEmail: false });
    expect(changesOf(d, d)).toEqual({ input: {}, error: null });
    expect(isChanged(d, d)).toBe(false);
  });

  it('a cell keeps what was clicked as its own setting; "As the preset" / "As everywhere" make it follow again', () => {
    const d0 = start();
    const d1 = chooseSetting(d0, LOCKED, null, 'enter', 'allow');
    expect(d1.overrides).toEqual([{ class: 'enter', area: null, setting: 'allow' }]);
    expect(cellSetting(policyOf(d1), null, 'enter')).toBe('allow');
    // Changed on purpose (wave 3): back to the preset's own is still kept as chosen, so a later
    // looser preset cannot move it. clearSetting is what makes the cell follow the preset again.
    expect(chooseSetting(d1, LOCKED, null, 'enter', 'ask').overrides).toEqual([{ class: 'enter', area: null, setting: 'ask' }]);
    expect(repeatsPreset(d1, { class: 'enter', area: null, setting: 'ask' })).toBe(true);
    expect(repeatsPreset(d1, { class: 'enter', area: null, setting: 'allow' })).toBe(false);
    expect(clearSetting(chooseSetting(d1, LOCKED, null, 'enter', 'ask'), null, 'enter').overrides).toEqual([]);
    // An area follows everywhere until set.
    expect(inheritedSetting(d1, 'payroll', 'enter')).toBe('allow');
    expect(cellSetting(policyOf(d1), 'payroll', 'enter')).toBe('allow');
    const d2 = chooseSetting(d1, LOCKED, 'payroll', 'enter', 'never');
    expect(d2.overrides).toEqual([
      { class: 'enter', area: null, setting: 'allow' },
      { class: 'enter', area: 'payroll', setting: 'never' },
    ]);
    expect(cellSetting(policyOf(d2), 'payroll', 'enter')).toBe('never');
    expect(cellSetting(policyOf(d2), 'banking', 'enter')).toBe('allow');
    // Changed on purpose (review): an area keeps what was chosen for it, even everywhere's own
    // setting, so a later change to everywhere does not move it. "As everywhere" lets it follow.
    const d3 = chooseSetting(d2, LOCKED, 'payroll', 'enter', 'allow');
    expect(d3.overrides).toEqual([
      { class: 'enter', area: null, setting: 'allow' },
      { class: 'enter', area: 'payroll', setting: 'allow' },
    ]);
    expect(clearSetting(d3, 'payroll', 'enter').overrides).toEqual([{ class: 'enter', area: null, setting: 'allow' }]);
    expect(clearScope(d2, 'payroll').overrides).toEqual([{ class: 'enter', area: null, setting: 'allow' }]);
  });

  it('a restriction chosen for an area does not loosen when everywhere is loosened later', () => {
    // Everywhere is Ask (the preset's); the person picks Ask for Payroll on purpose.
    const pinned = chooseSetting(start(), LOCKED, 'payroll', 'enter', 'ask');
    expect(pinned.overrides).toEqual([{ class: 'enter', area: 'payroll', setting: 'ask' }]);
    const loosened = chooseSetting(pinned, LOCKED, null, 'enter', 'allow');
    expect(cellSetting(policyOf(loosened), null, 'enter')).toBe('allow');
    expect(cellSetting(policyOf(loosened), 'payroll', 'enter')).toBe('ask');
    expect(cellSetting(policyOf(loosened), 'banking', 'enter')).toBe('allow');
    // Changed on purpose (wave 3): everywhere too keeps what was clicked, the preset's own included.
    expect(chooseSetting(loosened, LOCKED, null, 'enter', 'ask').overrides).toEqual([
      { class: 'enter', area: null, setting: 'ask' },
      { class: 'enter', area: 'payroll', setting: 'ask' },
    ]);
  });

  it('a restriction chosen everywhere does not loosen when a looser preset is picked later', () => {
    // "Ask for every change" asks before entering; the person clicks Ask on purpose.
    const pinned = chooseSetting(start(), LOCKED, null, 'enter', 'ask');
    expect(pinned.overrides).toEqual([{ class: 'enter', area: null, setting: 'ask' }]);
    const trusted = { ...pinned, preset: 'trusted_bookkeeper' as const };
    expect(cellSetting(policyOf(trusted), null, 'enter')).toBe('ask');
    expect(cellSetting(policyOf(trusted), null, 'change')).toBe('allow');
    // Without the click the cell follows the preset.
    expect(cellSetting(policyOf({ ...start(), preset: 'trusted_bookkeeper' }), null, 'enter')).toBe('allow');
    // And it is saved as its own row.
    expect(changesOf(start(), pinned).input).toEqual({ overrides: [{ class: 'enter', area: null, setting: 'ask' }] });
  });

  it('a locked cell cannot be chosen, everywhere or in an area', () => {
    const d = start();
    expect(chooseSetting(d, LOCKED, null, 'remove', 'allow')).toBe(d);
    expect(chooseSetting(d, LOCKED, 'banking', 'remove', 'allow')).toBe(d);
    expect(chooseSetting(d, LOCKED, null, 'remove', 'never').overrides).toEqual([{ class: 'remove', area: null, setting: 'never' }]);
  });

  it('an Allow the engine never gives is locked even when the server list leaves it out', () => {
    const d = start();
    for (const cls of NEVER_ALLOW_CLASSES) {
      expect(lockedReason([], cls, 'allow')).toBe(neverAllowReason(cls));
      expect(chooseSetting(d, [], null, cls, 'allow')).toBe(d);
      expect(chooseSetting(d, [], 'banking', cls, 'allow')).toBe(d);
    }
    // The server's own words win when it gives them.
    expect(lockedReason(LOCKED, 'remove', 'allow')).toBe(LOCKED[0].reason);
    expect(lockedReason([], 'enter', 'allow')).toBeNull();
    expect(lockedReason([], 'remove', 'ask')).toBeNull();
  });

  it('picking a stricter preset: the changes that still let it do more are named, and can be taken away alone', () => {
    const saved = draftFrom(
      view('ask_every_change', [
        { class: 'enter', area: null, setting: 'allow' },
        { class: 'change', area: 'banking', setting: 'allow' },
        { class: 'bulk', area: null, setting: 'never' },
      ]),
    );
    expect(looserThanPreset(saved).map(overrideText)).toEqual(['Enter new: Allow', 'Change or void in Banking: Allow']);
    const readOnly = { ...saved, preset: 'read_only' as const };
    expect(looserThanPreset(readOnly).map(overrideText)).toEqual(['Enter new: Allow', 'Change or void in Banking: Allow']);
    expect(clearLooser(readOnly).overrides).toEqual([{ class: 'bulk', area: null, setting: 'never' }]);
    expect(looserThanPreset({ ...saved, preset: 'full_with_asks' })).toEqual([]);
    expect(presetSummary('Read only', 0)).toBe('Read only');
    expect(presetSummary('Read only', undefined)).toBe('Read only');
    // Changed on purpose (wave 3): the form the list and the header use, "Read only (adjusted: 2)".
    expect(presetSummary('Read only', 1)).toBe('Read only (adjusted: 1)');
    expect(presetSummary('Read only', 2)).toBe('Read only (adjusted: 2)');
    expect(adjustedTitle(0)).toBeUndefined();
    expect(adjustedTitle(2)).toMatch(/^2 kinds of work are set for this agent itself/);
  });

  it("the preset's line never claims more than is true for an adjusted agent", () => {
    // "Read only" says it changes nothing; an agent on it with Enter new: Allow can enter.
    expect(PRESET_HELP.read_only).toMatch(/Changes nothing/);
    const adjusted = draftFrom(view('read_only', [{ class: 'enter', area: null, setting: 'allow' }, { class: 'bulk', area: null, setting: 'never' }]));
    const note = adjustedPresetNote(adjusted.overrides.length, looserThanPreset(adjusted).map(overrideText));
    expect(note).toBe(
      'That is the preset as it comes. This agent has 2 settings of its own, so the grid below is what holds. One of them lets it do more by itself than the preset says: Enter new: Allow.',
    );
    // Only stricter settings: no claim of more.
    expect(adjustedPresetNote(1, [])).toBe('That is the preset as it comes. This agent has one setting of its own, so the grid below is what holds.');
    // No settings of its own: the line stands alone.
    expect(adjustedPresetNote(0, [])).toBeNull();
  });

  it('"(adjusted: N)" never reads as more than is true: a setting kept as chosen is said to change nothing', () => {
    // Ask for every change: Enter new is Ask. Ask clicked keeps it; Allow changes it; Payroll set to
    // everywhere's own keeps it too.
    const d = draftFrom(
      view('ask_every_change', [
        { class: 'enter', area: null, setting: 'ask' },
        { class: 'change', area: null, setting: 'allow' },
        { class: 'change', area: 'payroll', setting: 'allow' },
        { class: 'bulk', area: 'banking', setting: 'never' },
      ]),
    );
    expect(keptAsChosen(d).map(overrideText)).toEqual(['Enter new: Ask', 'Change or void in Employees & Payroll: Allow']);
    // An Allow the engine never gives counts as the Ask it is.
    expect(keptAsChosen(draftFrom(view('ask_every_change', [{ class: 'remove', area: null, setting: 'allow' }]))).length).toBe(1);

    // The list has the count only: it says some may change nothing.
    expect(adjustedTitle(2)).toBe(
      '2 kinds of work are set for this agent itself, everywhere or in an area. Some may only keep the setting they would have anyway, so a later change cannot move them. Open the agent to see what it may do.',
    );
    // The detail page knows exactly.
    expect(adjustedTitle(4, 2)).toBe(
      '4 kinds of work are set for this agent itself, everywhere or in an area. 2 of them only keep the setting they would have anyway, so a later change cannot move them.',
    );
    expect(adjustedTitle(1, 1)).toBe(
      'One kind of work is set for this agent itself, everywhere or in an area. It only keeps the setting it would have anyway, so a later change cannot move it. Today the agent may do just what the preset says.',
    );
    expect(adjustedTitle(2, 0)).toBe('2 kinds of work are set for this agent itself, everywhere or in an area. Each one changes what the agent may do.');
    expect(adjustedPresetNote(2, [], 1)).toBe(
      'That is the preset as it comes. This agent has 2 settings of its own, so the grid below is what holds. One of them only keeps the setting it would have anyway, so a later change cannot move it.',
    );
  });

  it('a save sends only what changed, in the AgentPolicyInput shape; the whole adjustment list when any changed', () => {
    const saved = draftFrom(view('ask_every_change', [{ class: 'bulk', area: 'banking', setting: 'never' }]));
    const d = chooseSetting({ ...saved, bulkCap: '50', notifyEmail: true }, LOCKED, null, 'enter', 'allow');
    expect(changesOf(saved, d)).toEqual({
      input: {
        overrides: [
          { class: 'enter', area: null, setting: 'allow' },
          { class: 'bulk', area: 'banking', setting: 'never' },
        ],
        bulkCap: 50,
        notifyEmail: true,
      },
      error: null,
    });
    expect(changesOf(saved, { ...saved, preset: 'trusted_bookkeeper' }).input).toEqual({ preset: 'trusted_bookkeeper' });
    // Changed on purpose (review): the amount goes in the form the server stores, checked as a decimal.
    expect(changesOf(saved, { ...saved, twoPersonOver: '$5,000' }).input).toEqual({ twoPersonOver: '5000.00' });
    expect(changesOf({ ...saved, twoPersonOver: '5000.00' }, { ...saved, twoPersonOver: '' }).input).toEqual({ twoPersonOver: null });
    expect(changesOf({ ...saved, twoPersonOver: '5000.00' }, { ...saved, twoPersonOver: '5,000' }).input).toEqual({});
    expect(changesOf(saved, { ...saved, twoPersonOver: '0' }).input).toEqual({ twoPersonOver: '0.00' });
    expect(changesOf({ ...saved, bulkCap: '200' }, { ...saved, bulkCap: ' ' }).input).toEqual({ bulkCap: null });
    expect(changesOf(saved, { ...saved, requestExpiryDays: '30' }).input).toEqual({ requestExpiryDays: 30 });
    expect(changesOf(saved, { ...saved, folders: [] }).input).toEqual({ folders: [] });
  });

  it('the bulk cap: empty means none, except while bulk work is Allow, where it means the usual cap', () => {
    const d = start();
    expect(capThatApplies(d)).toBeNull();
    expect(capThatApplies({ ...d, bulkCap: '1,500' })).toBe(1500);
    expect(capThatApplies({ ...d, bulkCap: 'x' })).toBeNull();
    const bulkAllowed = chooseSetting(d, LOCKED, 'banking', 'bulk', 'allow');
    expect(capThatApplies(bulkAllowed)).toBe(DEFAULT_BULK_CAP);
    // Emptied while bulk is Allow: the server would refuse null, and the form says empty means the usual cap.
    expect(changesOf({ ...bulkAllowed, bulkCap: '50' }, bulkAllowed).input).toEqual({ bulkCap: DEFAULT_BULK_CAP });
    const full = draftFrom(view('full_with_asks'));
    expect(full.bulkCap).toBe(String(DEFAULT_BULK_CAP));
    expect(changesOf(full, { ...full, bulkCap: '' }).input).toEqual({ bulkCap: DEFAULT_BULK_CAP });
    // Not Allow anywhere: empty is no limit.
    expect(changesOf({ ...d, bulkCap: '50' }, d).input).toEqual({ bulkCap: null });
  });

  it('a limit that cannot be sent is said in plain words, and nothing is sent', () => {
    const d = start();
    // Changed on purpose (wave 3): "empty" says what really happens while bulk work is Allow.
    expect(changesOf(d, { ...d, bulkCap: '0' }).error).toBe(
      `The most records one request may change must be a whole number from 1 to 100,000, or empty: no limit, or ${DEFAULT_BULK_CAP} while "Change many at once" is Allow anywhere.`,
    );
    expect(changesOf(d, { ...d, bulkCap: '2.5' }).input).toBeNull();
    // Changed on purpose (review): 0 is taken (every amount needs two people), as the server takes it.
    expect(changesOf(d, { ...d, twoPersonOver: 'lots' }).error).toMatch(/an amount like 5000 or 5000.00 \(0 for every amount\), or empty for off/);
    expect(changesOf(d, { ...d, twoPersonOver: '-5' }).input).toBeNull();
    expect(changesOf(d, { ...d, twoPersonOver: '1.005' }).input).toBeNull();
    expect(changesOf(d, { ...d, twoPersonOver: '99999999999999' }).input).toBeNull();
    expect(changesOf(d, { ...d, requestExpiryDays: '366' }).error).toMatch(/whole number from 1 to 365/);
    expect(isChanged(d, { ...d, requestExpiryDays: '' })).toBe(true);
    expect(amountText('$12,345.6')).toBe('12345.60');
    expect(amountText('0.00')).toBe('0.00');
  });

  it('folders: added once, as typed; a folder typed but not added is added by Save', () => {
    const d = start();
    expect(addFolder(d, '  D:\\Scans ').draft?.folders).toEqual(['C:\\Receipts', 'D:\\Scans']);
    expect(addFolder(d, 'c:\\receipts').error).toBe('That folder is already on the list.');
    expect(addFolder(d, '   ').error).toBe('Type the full path of a folder first.');
    expect(withTypedFolder(d, ' D:\\Scans ').draft?.folders).toEqual(['C:\\Receipts', 'D:\\Scans']);
    expect(withTypedFolder(d, '').draft).toBe(d);
    expect(withTypedFolder(d, 'C:\\RECEIPTS').draft).toBe(d);
    const full = { ...d, folders: Array.from({ length: 50 }, (_, i) => `C:\\F${i}`) };
    expect(withTypedFolder(full, 'D:\\One more').error).toBe('An agent can have at most 50 folders.');
  });

  it('loosening, for a person who is not an Admin (plan 4.4): presets, cells, limits and folders, measured against what was saved', () => {
    // Presets run strictest first.
    expect(presetLooser('trusted_bookkeeper', 'ask_every_change')).toBe(true);
    expect(presetLooser('read_only', 'ask_every_change')).toBe(false);
    expect(presetLooser('ask_every_change', 'ask_every_change')).toBe(false);

    const saved = draftFrom(view('ask_every_change', [{ class: 'enter', area: null, setting: 'never' }]));
    // Tightening is never loosening, and neither is putting back what was saved.
    const stricter = chooseSetting(saved, LOCKED, null, 'change', 'never');
    expect(looseningsOf(saved, stricter)).toEqual([]);
    expect(looseningsOf(saved, chooseSetting(stricter, LOCKED, null, 'change', 'ask'))).toEqual([]);
    expect(looseningsOf(saved, { ...saved, preset: 'read_only' })).toEqual([]);
    // A cell that lets it do more: everywhere, or in one area.
    expect(looseningsOf(saved, chooseSetting(saved, LOCKED, null, 'change', 'allow'))).toEqual(['"Change or void" from Ask to Allow']);
    expect(looseningsOf(saved, chooseSetting(saved, LOCKED, 'banking', 'enter', 'ask'))).toEqual(['"Enter new" in Banking from Never to Ask']);
    // "As the preset" on a stricter row loosens it (Never back to the preset's Ask).
    expect(looserCells(saved, clearSetting(saved, null, 'enter'), 'enter')).toEqual([{ class: 'enter', area: null, from: 'never', to: 'ask' }]);
    expect(looserCells(saved, clearScope(saved, 'all')).length).toBe(1);
    // An area loosened by everywhere is said once, for everywhere.
    expect(looserCells(saved, chooseSetting(saved, LOCKED, null, 'change', 'allow')).map((c) => c.area)).toEqual([null]);
    // A looser preset.
    expect(looseningsOf(saved, { ...saved, preset: 'full_with_asks' })).toEqual(['the preset "Full, with asks" in place of "Ask for every change"']);

    // The limit on records per request: raised or taken away, never lowered.
    const capped = { ...saved, bulkCap: '100' };
    expect(capLoosened(capped, { ...capped, bulkCap: '50' })).toBeNull();
    expect(capLoosened(capped, { ...capped, bulkCap: '500' })).toEqual({ from: 100, to: 500 });
    expect(capLoosened(capped, { ...capped, bulkCap: '' })).toEqual({ from: 100, to: null });
    expect(capLoosened(capped, { ...capped, bulkCap: 'x' })).toBeNull();
    expect(capLoosened(saved, { ...saved, bulkCap: '50' })).toBeNull(); // no limit before: any number is lower
    expect(looseningsOf(capped, { ...capped, bulkCap: '' })).toEqual(['no limit on the records one request may change']);
    expect(looseningsOf(capped, { ...capped, bulkCap: '1,500' })).toEqual(['up to 1,500 records in one request instead of 100']);
    // While bulk is Allow, empty means the usual cap: not a raise from 200.
    const bulky = { ...chooseSetting(saved, LOCKED, null, 'bulk', 'allow'), bulkCap: String(DEFAULT_BULK_CAP) };
    expect(capLoosened(bulky, { ...bulky, bulkCap: '' })).toBeNull();
    // Review (wave 3): measured as the server measures it. With no limit saved, standing permissions
    // are still held to the usual cap, so a number above it is a raise from that usual one.
    expect(capLoosened(saved, { ...saved, bulkCap: String(DEFAULT_BULK_CAP) })).toBeNull();
    expect(capLoosened(saved, { ...saved, bulkCap: '500' })).toEqual({ from: DEFAULT_BULK_CAP, to: 500, usual: true });
    expect(looseningsOf(saved, { ...saved, bulkCap: '500' })).toEqual([`up to 500 records in one request instead of the usual ${DEFAULT_BULK_CAP}`]);
    expect(adminToRaiseUsualCap(DEFAULT_BULK_CAP)).toBe(
      `With no limit saved, standing permissions are still held to the usual ${DEFAULT_BULK_CAP} records a request. Only an Admin can set a limit above that. You can set one up to ${DEFAULT_BULK_CAP}.`,
    );

    // Two-person approval: a higher amount or off, compared as decimals; a lower one or turning it on is fine.
    const two = { ...saved, twoPersonOver: '1000.00' };
    expect(twoPersonLoosened(two, { ...two, twoPersonOver: '5,000' })).toEqual({ from: '1000.00', to: '5000.00' });
    expect(twoPersonLoosened(two, { ...two, twoPersonOver: '' })).toEqual({ from: '1000.00', to: null });
    expect(twoPersonLoosened(two, { ...two, twoPersonOver: '999.99' })).toBeNull();
    expect(twoPersonLoosened(two, { ...two, twoPersonOver: '1000' })).toBeNull();
    expect(twoPersonLoosened(two, { ...two, twoPersonOver: '0' })).toBeNull();
    expect(twoPersonLoosened(saved, { ...saved, twoPersonOver: '50' })).toBeNull();
    expect(looseningsOf(two, { ...two, twoPersonOver: '' })).toEqual(['two-person approval turned off']);
    expect(looseningsOf(two, { ...two, twoPersonOver: '1000.01' })).toEqual(['two-person approval only above 1000.01 instead of 1000.00']);

    // Folders: another one is loosening, the same one in other letters is not, taking one off is fine.
    // Deliberately stricter than the server (which takes a folder inside one that reaches something
    // on the disk): a window cannot see the disk, so a folder inside one counts as another here.
    expect(addedFolders(saved, { ...saved, folders: ['C:\\Receipts', 'C:\\Receipts\\2026'] })).toEqual(['C:\\Receipts\\2026']);
    expect(addedFolders(saved, { ...saved, folders: ['C:\\Receipts', 'D:\\Scans'] })).toEqual(['D:\\Scans']);
    expect(addedFolders(saved, { ...saved, folders: ['c:\\receipts'] })).toEqual([]);
    expect(looseningsOf(saved, { ...saved, folders: [] })).toEqual([]);
    expect(looseningsOf(saved, { ...saved, folders: ['C:\\Receipts', 'D:\\Scans'] })).toEqual(['another folder: D:\\Scans']);

    // A longer wait and the email notice turned on are loosening too, as the server holds them;
    // a shorter wait and the notice turned off are not.
    expect(looseningsOf(saved, { ...saved, requestExpiryDays: '30', notifyEmail: true })).toEqual([
      'requests that wait 30 days instead of 7',
      'the email notice turned on, which sends email outside this computer',
    ]);
    expect(looseningsOf(saved, { ...saved, requestExpiryDays: '3' })).toEqual([]);
    expect(looseningsOf({ ...saved, notifyEmail: true }, saved)).toEqual([]);
    expect(looseningsOf(saved, { ...saved, requestExpiryDays: 'x' })).toEqual([]); // typed wrong: changesOf says why

    // Said in plain words, with what to do next.
    expect(adminOnlyNote(['another folder: D:\\Scans'])).toBe(
      `${ADMIN_TO_LOOSEN} This change would give it: another folder: D:\\Scans. Put it back to save the rest, or ask an Admin.`,
    );
  });

  it("Resume's reason for a person who is not an Admin is the server's own words", () => {
    const src = require('node:fs').readFileSync('lib/services/agentPolicies.ts', 'utf8') as string;
    expect(src).toContain(`'${ADMIN_TO_RESUME_ADMIN_AGENT}'`);
  });

  it('a standing permission says when it is not in effect: the agent is paused, it ended or was used up', () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const live = { revokedAt: null, expiresAt: '2026-11-20T23:59:00.000Z', uses: 2, maxUses: 10 };
    expect(grantState(live, null, now)).toEqual({ state: 'live', label: 'In effect', why: null });
    expect(grantState(live, 'agent', now)).toEqual({ state: 'not_in_effect', label: 'Not in effect', why: GRANT_PAUSED });
    expect(grantState(live, 'all', now)).toEqual({ state: 'not_in_effect', label: 'Not in effect', why: GRANT_ALL_PAUSED });
    expect(grantState({ ...live, expiresAt: '2026-11-20T11:00:00.000Z' }, 'agent', now).state).toBe('ended');
    expect(grantState({ ...live, uses: 10 }, null, now).state).toBe('used_up');
    expect(grantState({ ...live, revokedAt: '2026-11-20T10:00:00.000Z' }, null, now).state).toBe('taken_back');
    expect(grantState({ ...live, maxUses: null, uses: 99 }, null, now).state).toBe('live');
  });

  it('every preset and every kind of work has its line, and a new agent asks for every change (D2)', () => {
    for (const p of AGENT_PRESETS) expect(PRESET_HELP[p].length).toBeGreaterThan(30);
    for (const c of RISK_CLASSES) expect(CLASS_HELP[c].length).toBeGreaterThan(15);
    expect(DEFAULT_PRESET).toBe('ask_every_change');
    expect(NEW_AGENT_PRESET).toBe(DEFAULT_PRESET);
    // A line stays true when the cap or the grid is changed: no changeable number is named.
    for (const p of AGENT_PRESETS) expect(PRESET_HELP[p]).not.toMatch(/\d/);
    expect(PRESET_HELP.trusted_bookkeeper).toMatch(/Protected data[^.]*wait for a person/);
    expect(presetLabelOf({ preset: 'full_with_asks', mode: 'post' })).toBe('Full, with asks');
    expect(presetLabelOf({ mode: 'propose' })).toBe('Ask for every change');
    expect(presetLabelOf({ mode: 'read_only' })).toBe('Read only');
  });
});

describe('where the connector is on this computer', () => {
  const none = () => false;

  it('the installed app runs the connector with its own program', () => {
    const shipped = 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs';
    const c = agentConnection({
      execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\Ironbooks.exe',
      serverScript: 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\resources\\app\\server.js',
      cwd: 'C:\\somewhere\\else',
      fileExists: (p) => p === shipped,
    });
    expect(c).toEqual({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\Ironbooks\\Ironbooks.exe',
      args: [shipped],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      tokenEnv: 'IRONBOOKS_AGENT_TOKEN',
      installed: true,
    });
  });

  it('a source checkout runs it with node', () => {
    const local = 'C:\\src\\ironbooks\\mcp\\ironbooks-mcp.mjs';
    const c = agentConnection({ execPath: 'C:\\node\\node.exe', serverScript: 'C:\\src\\ironbooks\\node_modules\\next\\dist\\bin\\next', cwd: 'C:\\src\\ironbooks', fileExists: (p) => p === local });
    expect(c).toEqual({ command: 'node', args: [local], env: {}, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: false });
    expect(agentConnection({ execPath: 'x', serverScript: undefined, cwd: 'C:\\nowhere', fileExists: none })).toBeNull();
  });

  it('names the same token variable the connector reads, and ships the script it points at', () => {
    expect(agentConnection({ cwd: process.cwd(), serverScript: undefined })).toMatchObject({ command: 'node', tokenEnv: TOKEN_ENV, installed: false });
    const pkg = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'));
    expect(pkg.build.extraResources).toContainEqual({ from: 'mcp', to: 'mcp', filter: ['*.mjs'] });
    // Nothing was added to what the app depends on.
    expect(Object.keys(pkg.dependencies).some((d) => /modelcontextprotocol/i.test(d))).toBe(false);
  });
});

describe('the settings to paste', () => {
  const installed = { command: 'C:\\Program Files\\Ironbooks\\Ironbooks.exe', args: ['C:\\Program Files\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' }, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: true };

  it('Claude Code: one command, paths with spaces quoted', () => {
    expect(claudeCodeCommand(installed, TOKEN)).toBe(
      `claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=${TOKEN} --env ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\Ironbooks\\Ironbooks.exe" "C:\\Program Files\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs"`,
    );
    expect(claudeCodeCommand({ command: 'node', args: ['/src/mcp/ironbooks-mcp.mjs'], env: {}, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: false }, TOKEN)).toBe(
      `claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=${TOKEN} -- node /src/mcp/ironbooks-mcp.mjs`,
    );
  });

  it('Claude Desktop: a valid configuration entry', () => {
    expect(JSON.parse(claudeDesktopConfig(installed, TOKEN))).toEqual({
      mcpServers: { ironbooks: { command: installed.command, args: installed.args, env: { IRONBOOKS_AGENT_TOKEN: TOKEN, ELECTRON_RUN_AS_NODE: '1' } } },
    });
  });
});
