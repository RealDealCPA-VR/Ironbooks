// Users & Roles > Agents (app/users/AgentsTab.tsx), in a real browser window: the list never shows
// a token; New agent asks for a name, roles (Admin with a plain warning, plan D1) and a preset
// ("Ask for every change" unless another is chosen, D2), sends exactly that, and shows the token
// once with the settings to paste; Remove asks first; another computer only looks.
//
// The agent's detail page (app/users/agents/, plan 7.1): the policy grid with its locked cells,
// per-area overrides, limits, a save that sends only what changed, standing permissions with
// Revoke, the activity with its links, and Pause / Resume. Only an Admin lets an agent do more by
// itself (plan 4.4): anyone else who manages agents may only tighten or pause.
//
// The audit trail (app/audit-trail/page.tsx) opens the entry its address names (?id=), so the
// Activity tab's links land on the row.
//
// Users & Roles (app/users/page.tsx) shows the Agents tab to anyone who may view Users & Roles >
// Users, and tells it whether the person is an Admin once GET /api/auth/me has answered.
import * as React from 'react';
import AgentsTab from '@/app/users/AgentsTab';
import UsersAndRolesPage from '@/app/users/page';
import AuditTrailPage from '@/app/audit-trail/page';
import { agentRequestCountStore } from '@/components/AgentRequestsBadge';
import { Toaster } from '@/components/ui';
import { PRESET_DEFAULTS } from '@/lib/agent/policy';
import { TAB_HELP } from '@/lib/pageHelp';
import { $, $$, button, check, click, domTest, equal, focus, mount, reply, runDomTests, sleep, stubFetch, textOf, typeText, unmount, until, type FetchAnswer, type FetchCall } from './kit';

/**
 * Who is signed in at this window (GET /api/auth/me, with the permission fields it sends). Sam may
 * view and change Users & Roles > Users, what tightening, pausing and Revoke ask for; Val may only
 * view that list, which is enough to see the agents and nothing more.
 */
const ADMIN_ME = { id: 'u1', name: 'Pat Owner', isAdmin: true };
const MANAGER_ME = { id: 'u2', name: 'Sam Manager', isAdmin: false, permissions: { users: ['view', 'modify'] }, activities: { 'users.users': ['view', 'modify'] } };
const VIEWER_ME = { id: 'u4', name: 'Val Viewer', isAdmin: false, permissions: { users: ['view'] }, activities: { 'users.users': ['view'] } };

/**
 * The window's count poll (GET /api/agent-requests/count, AgentRequestCount): what the title bar
 * and the tab's Pause all agents read. By default the switch is not offered (canPauseAll false), so
 * no test sees it unless it says so. The poll is one for the whole window and keeps its last good
 * answer, so every stub answers it.
 */
const NO_SWITCH = { pending: 0, newest: null, agents: 1, allPaused: false, canPauseAll: false };
const COUNT_ROUTE = 'GET /api/agent-requests/count';
/** stubFetch, signed in as an Admin unless the routes say otherwise, with the count poll answered. */
const stub = (routes: Record<string, FetchAnswer>) => stubFetch({ 'GET /api/auth/me': ADMIN_ME, [COUNT_ROUTE]: NO_SWITCH, ...routes });

const ROLES = [
  { key: 'admin', name: 'Admin', description: 'Everything.', builtin: true },
  { key: 'bookkeeper', name: 'Bookkeeper', description: 'Day-to-day entries.', builtin: true },
  { key: 'view_only', name: 'View-Only', description: 'Look at everything.', builtin: true },
];
const TOKEN = `ibka_0123abcd_${'T'.repeat(43)}`;
const CONNECTION = { command: 'C:\\Apps\\Ironbooks\\Ironbooks.exe', args: ['C:\\Apps\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' }, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: true };

/** The older mode the server keeps in step with each preset (modeForPreset, lib/services/agents.ts). */
const MODE_OF_PRESET: Record<string, string> = { read_only: 'read_only', ask_every_change: 'propose', trusted_bookkeeper: 'post', full_with_asks: 'post' };

/** When a test's agent was removed, unless it says. */
const REMOVED_AT = '2026-11-21T15:00:00.000Z';

/**
 * One agent exactly as GET /api/agents lists it (app/api/agents/route.ts listedAgent): AgentView
 * (lib/services/agents.ts) with overrideCount, field by field. Never a token, never a connection.
 * Built the way the server builds it: the mode follows the preset, the role names are those of its
 * role keys that still exist (ROLES), and a removed one says when. Unless told otherwise it is the
 * same agent detailOf describes: "Month-end helper", a Bookkeeper on "Ask for every change".
 */
function agentRow(
  over: {
    id?: string;
    name?: string;
    roleKeys?: string[];
    preset?: keyof typeof MODE_OF_PRESET;
    pausedAt?: string | null;
    tokenPrefix?: string;
    createdAt?: string;
    createdByName?: string | null;
    lastUsedAt?: string | null;
    revokedAt?: string;
    status?: 'active' | 'revoked';
    unattended?: boolean;
    overrideCount?: number;
  } = {},
) {
  const roleKeys = over.roleKeys ?? ['bookkeeper'];
  const preset = over.preset ?? 'ask_every_change';
  const status = over.status ?? 'active';
  return {
    id: over.id ?? 'a1',
    name: over.name ?? 'Month-end helper',
    roleKeys,
    roleNames: roleKeys.flatMap((k) => ROLES.filter((r) => r.key === k).map((r) => r.name)),
    preset,
    mode: MODE_OF_PRESET[preset],
    pausedAt: over.pausedAt ?? null,
    tokenPrefix: over.tokenPrefix ?? 'ibka_0123abcd_Tabc',
    createdAt: over.createdAt ?? '2026-11-01T15:00:00.000Z',
    createdByName: over.createdByName === undefined ? 'Pat Owner' : over.createdByName,
    lastUsedAt: over.lastUsedAt === undefined ? '2026-11-18T14:30:00.000Z' : over.lastUsedAt,
    revokedAt: status === 'revoked' ? (over.revokedAt ?? REMOVED_AT) : null,
    status,
    unattended: over.unattended ?? false,
    overrideCount: over.overrideCount ?? 0,
  };
}
const HELPER = agentRow();
/** HELPER after Remove. */
const HELPER_REMOVED = agentRow({ status: 'revoked' });
/** Removed long ago, with a role that no longer exists (so no role name is listed for it). */
const GONE = agentRow({
  id: 'a0',
  name: 'Old helper',
  roleKeys: ['old_role'],
  preset: 'trusted_bookkeeper',
  tokenPrefix: 'ibka_0123abcd_Zzzz',
  createdAt: '2026-10-01T15:00:00.000Z',
  createdByName: null,
  lastUsedAt: null,
  revokedAt: '2026-10-20T15:00:00.000Z',
  status: 'revoked',
});

/** Audit entries' ids are UUIDs (audit_logs.id): the audit trail asks the server only for one of those. */
const AU1 = '0b5e2c1a-1111-4aaa-8bbb-000000000001';
const AU2 = '0b5e2c1a-1111-4aaa-8bbb-000000000002';
const GONE_ID = '0b5e2c1a-1111-4aaa-8bbb-000000000009';

/** GET /api/agents as the route answers it: { agents, allPaused, hostOnly, unattendedPossible }. */
function listed(agents: object[], over: { allPaused?: boolean; hostOnly?: boolean; unattendedPossible?: boolean } = {}) {
  return { agents, allPaused: false, hostOnly: false, unattendedPossible: true, ...over };
}

const page = () => (
  <div>
    <Toaster />
    <AgentsTab roles={ROLES} />
  </div>
);
const dialog = () => $('[role="dialog"]');

domTest('the list shows each agent, its role and last use, and never a token', async () => {
  stub({ 'GET /api/agents': listed([HELPER, GONE]) });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  const text = textOf();
  check(text.includes('Bookkeeper') && text.includes('Ask for every change'), `role and preset are shown: ${text}`);
  check(text.includes('by Pat Owner'), 'who made it is shown');
  check(text.includes('ibka_0123abcd_Tabc…'), 'the start of the token tells agents apart');
  check(text.includes('Old helper') && text.includes('Removed') && text.includes('Role removed'), 'a removed agent stays listed as removed');
  check(text.includes('everything it enters is listed under its name'), 'the page says what holds for every agent');
  check(!text.includes(TOKEN), 'no token on the page');
  equal($$('button[title="Remove this agent\'s access"]').length, 1, 'only an active agent can be removed');
  check(button(/New agent/), 'New agent is offered on this computer');
  await unmount();
});

// Changed on purpose (plan D1, D2): Admin is now offered, with a warning, and the dialog sends a
// preset ("Ask for every change" unless another is chosen) instead of the older mode.
domTest('New agent: name, roles (Admin with a warning) and the chosen preset are sent, and the token is shown once', async () => {
  let made = false;
  const calls = stub({
    'GET /api/agents': () => listed(made ? [HELPER] : []),
    'POST /api/agents': () => {
      made = true;
      return reply(201, { agent: HELPER, token: TOKEN, connection: CONNECTION });
    },
  });
  await mount(page());
  await until(() => textOf().includes('No agents.'), 'the empty list');
  check(textOf().includes('Nothing outside Ironbooks can read this company.'), 'the empty state says nothing can read the company');
  check(textOf().includes('The role is the most an agent can ever ask for'), 'the tab says what the role means for safety');
  check(textOf().includes('choose the smallest role and the strictest preset'), 'and what to do about it');

  await click(button(/New agent/), 'New agent');
  const d = await until(dialog, 'the New agent dialog');
  const roleNames = $$('label', d).map((l) => textOf(l));
  check(roleNames.some((r) => r.startsWith('Bookkeeper')), 'Bookkeeper is offered');
  check(roleNames.some((r) => r.startsWith('Admin')), `Admin is offered: ${roleNames.join(' | ')}`);
  check(textOf(d).includes('What an agent reads is sent to the AI service that runs it'), 'the dialog says where what it reads goes');
  check(textOf(d).includes('The preset is what it may do without asking'), 'the dialog says what the preset means for safety');
  check(!$('[data-admin-warning]', d), 'no Admin warning before Admin is ticked');
  const make = button('Make agent', d);
  check(make?.disabled, 'Make agent waits for a name and a role');

  // Ticking Admin says plainly what it means; unticking takes the warning away.
  const adminBox = $$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('Admin')) ?? null;
  await click(adminBox, 'the Admin role');
  const warning = textOf(await until(() => $('[data-admin-warning]', d), 'the Admin warning'));
  // Changed on purpose (wave 5): Admin work stays on Never under "Ask for every change", so the
  // warning says it can be asked for only where the settings say Ask.
  check(warning.includes('can ask for Admin work'), `the warning says it can ask for Admin work: ${warning}`);
  check(warning.includes('wherever its settings say Ask for that work') && warning.includes('"Ask for every change" keeps it on Never'), `and only where its settings say Ask: ${warning}`);
  check(!warning.includes('anything an Admin can do'), 'never that it can ask for anything an Admin can do');
  check(warning.includes('still needs a person to say yes'), 'and that every such request still needs a person');
  await click(adminBox, 'the Admin role again');
  await until(() => !$('[data-admin-warning]', d), 'the warning to go');

  await focus($('#ag-name', d), 'the name field');
  await typeText('Month-end helper');
  await click($$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('Bookkeeper')) ?? null, 'the Bookkeeper role');
  const presets = $$<HTMLInputElement>('input[type="radio"]', d);
  equal(presets.map((p) => p.value).join(','), 'read_only,ask_every_change,trusted_bookkeeper,full_with_asks', 'the four presets');
  check(presets.find((p) => p.value === 'ask_every_change')?.checked, '"Ask for every change" is the starting choice');
  for (const p of presets) check(textOf(p.closest('label')).length > 30, `each preset says what it means: ${textOf(p.closest('label'))}`);
  check(textOf(presets[2].closest('label')).startsWith('Trusted bookkeeper'), 'the presets are named');
  await click(presets.find((p) => p.value === 'trusted_bookkeeper') ?? null, 'Trusted bookkeeper');
  check(!button('Make agent', d)?.disabled, 'Make agent is ready');
  await click(button('Make agent', d), 'Make agent');

  const once = await until(() => (textOf(dialog()).includes('is ready') ? dialog() : null), 'the token dialog');
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ name: 'Month-end helper', roleKeys: ['bookkeeper'], preset: 'trusted_bookkeeper', unattended: false }), 'what was sent');
  const shown = textOf(once);
  check(shown.includes(TOKEN), 'the token is shown');
  check(shown.includes('It is shown only now.'), 'the dialog says it is shown only now');
  check(shown.includes(`claude mcp add ironbooks --env IRONBOOKS_AGENT_TOKEN=${TOKEN} --env ELECTRON_RUN_AS_NODE=1 -- C:\\Apps\\Ironbooks\\Ironbooks.exe C:\\Apps\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs`), `the Claude Code command: ${shown}`);
  check(shown.includes('"mcpServers"') && shown.includes('"ELECTRON_RUN_AS_NODE": "1"'), 'the Claude Desktop settings');
  check(!shown.includes('IRONBOOKS_AGENT_START'), 'nothing that starts Ironbooks by itself, unless asked for');
  check(shown.includes('and someone has signed in'), 'it says the agent works while someone is signed in');

  await click(button('I have copied it', once), 'I have copied it');
  await until(() => !dialog(), 'the dialog to close');
  await until(() => textOf().includes('Month-end helper'), 'the new agent in the list');
  check(!textOf().includes(TOKEN), 'the token is gone from the page for good');
  await unmount();
});

domTest('working while nobody is signed in is off unless ticked, and says what it means', async () => {
  const NIGHT = agentRow({ id: 'a2', name: 'Night closer', unattended: true });
  const STARTS = { ...CONNECTION, env: { ...CONNECTION.env, IRONBOOKS_AGENT_START: '1' } };
  let made = false;
  const calls = stub({
    'GET /api/agents': () => listed(made ? [HELPER, NIGHT] : [HELPER]),
    'POST /api/agents': () => {
      made = true;
      return reply(201, { agent: NIGHT, token: TOKEN, connection: STARTS });
    },
  });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  check(!textOf().includes('Also while nobody is signed in'), 'an agent without it is not marked');

  await click(button(/New agent/), 'New agent');
  const d = await until(dialog, 'the New agent dialog');
  const box = $$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('May work while nobody is signed in')) ?? null;
  check(box && !box.checked, 'the switch is there and off');
  const help = textOf(box?.closest('label') ?? null);
  check(help.includes('opens this company file by itself with no window'), `it says what it does: ${help}`);
  check(help.includes('gets it at once'), 'it says people come first');
  check(help.includes('never does this for a company file with passwords'), 'it says where it never applies');

  await focus($('#ag-name', d), 'the name field');
  await typeText('Night closer');
  await click($$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('Bookkeeper')) ?? null, 'the Bookkeeper role');
  await click(box, 'the switch');
  await click(button('Make agent', d), 'Make agent');

  const once = await until(() => (textOf(dialog()).includes('is ready') ? dialog() : null), 'the token dialog');
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ name: 'Night closer', roleKeys: ['bookkeeper'], preset: 'ask_every_change', unattended: true }), 'what was sent');
  const shown = textOf(once);
  check(shown.includes('--env IRONBOOKS_AGENT_START=1'), `the Claude Code command lets the connector start Ironbooks: ${shown}`);
  check(shown.includes('"IRONBOOKS_AGENT_START": "1"'), 'so do the Claude Desktop settings');
  check(shown.includes('it opens the file by itself for as long as the agent is working'), 'the dialog says so');
  await click(button('I have copied it', once), 'I have copied it');
  await until(() => textOf().includes('Night closer'), 'the new agent in the list');
  check(textOf().includes('Also while nobody is signed in'), 'the list marks it');
  await unmount();
});

domTest('a company file with passwords: the switch is not offered, and the tab says why', async () => {
  const NIGHT = agentRow({ id: 'a2', name: 'Night closer', unattended: true });
  const calls = stub({
    'GET /api/agents': listed([NIGHT], { unattendedPossible: false }),
    'POST /api/agents': reply(201, { agent: HELPER, token: TOKEN, connection: CONNECTION }),
  });
  await mount(page());
  await until(() => textOf().includes('Night closer'), 'the agents');
  check(!textOf().includes('Also while nobody is signed in'), 'no agent is shown as working alone in a file only a person can open');
  await click(button(/New agent/), 'New agent');
  const d = await until(dialog, 'the New agent dialog');
  const box = $$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('May work while nobody is signed in')) ?? null;
  check(box && box.disabled && !box.checked, 'the switch is there, off, and cannot be ticked');
  check(textOf(box?.closest('label') ?? null).includes('it has passwords, so only a person signing in opens it'), 'it says why');
  await focus($('#ag-name', d), 'the name field');
  await typeText('Helper');
  await click($$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('Bookkeeper')) ?? null, 'the Bookkeeper role');
  await click(button('Make agent', d), 'Make agent');
  await until(() => (textOf(dialog()).includes('is ready') ? dialog() : null), 'the token dialog');
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ name: 'Helper', roleKeys: ['bookkeeper'], preset: 'ask_every_change', unattended: false }), 'what was sent');
  await unmount();
});

domTest('a refusal from the server is said in its own words, and the dialog stays', async () => {
  stub({
    'GET /api/agents': listed([]),
    'POST /api/agents': reply(409, { error: 'There is already an agent named "Twin".', code: 'CONFLICT' }),
  });
  await mount(page());
  await click(await until(() => button(/New agent/), 'New agent'), 'New agent');
  const d = await until(dialog, 'the dialog');
  await focus($('#ag-name', d), 'the name field');
  await typeText('Twin');
  await click($$<HTMLInputElement>('input[type="checkbox"]', d)[0], 'a role');
  await click(button('Make agent', d), 'Make agent');
  await until(() => textOf().includes('There is already an agent named "Twin".'), 'the refusal');
  check(dialog(), 'the dialog is still open');
  await unmount();
});

domTest('Remove asks first, then takes the access away', async () => {
  let removed = false;
  const calls = stub({
    'GET /api/agents': () => listed([removed ? HELPER_REMOVED : HELPER]),
    'DELETE /api/agents/a1': () => {
      removed = true;
      return { agent: HELPER_REMOVED };
    },
  });
  await mount(page());
  await click(await until(() => $('button[title="Remove this agent\'s access"]'), 'the remove button'), 'Remove');
  const confirm = await until(dialog, 'the confirmation');
  check(textOf(confirm).includes('Month-end helper will stop working at once.'), `it says what will happen: ${textOf(confirm)}`);
  equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing is removed before the answer');
  await click(button('Remove', confirm), 'Remove');
  await until(() => textOf().includes('Removed'), 'the agent shown as removed');
  equal(calls.filter((c) => c.method === 'DELETE' && c.path === '/api/agents/a1').length, 1, 'one removal');
  await unmount();
});

domTest('on another computer the tab only lists', async () => {
  stub({ 'GET /api/agents': listed([HELPER], { hostOnly: true }) });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  check(textOf().includes('This can only be changed on the computer that holds the company file.'), 'it says where agents are made');
  check(!button(/New agent/), 'no New agent');
  equal($$('button[title="Remove this agent\'s access"]').length, 0, 'no Remove');
  await unmount();
});

// ---------------------------------------------------------------------------
// The agent's detail page
// ---------------------------------------------------------------------------

const NEVER_ALLOW = ['read_sensitive', 'remove', 'period', 'outside', 'print', 'settings', 'admin', 'file', 'secret'] as const;
const LOCKED = NEVER_ALLOW.map((c) => ({
  class: c,
  setting: 'allow',
  reason: c === 'remove' ? '"Delete for good" can never be Allow for an agent: a person approves this work.' : `"${c}" can never be Allow for an agent.`,
}));
type Override = { class: string; area: string | null; setting: string };

/** AgentDetail (lib/agent/contract.ts) for HELPER, "Ask for every change" unless told, with `overrides` on top. */
function detailOf(
  opts: {
    overrides?: Override[];
    paused?: boolean;
    bulkCap?: number | null;
    preset?: keyof typeof PRESET_DEFAULTS;
    locked?: typeof LOCKED;
    folders?: string[];
  } = {},
) {
  const overrides = opts.overrides ?? [];
  const preset = opts.preset ?? 'ask_every_change';
  const classes: Record<string, string> = { ...PRESET_DEFAULTS[preset] };
  const areas: Record<string, Record<string, string>> = {};
  for (const o of overrides) {
    if (o.area) areas[o.area] = { ...(areas[o.area] ?? {}), [o.class]: o.setting };
    else classes[o.class] = o.setting;
  }
  return {
    id: 'a1',
    name: 'Month-end helper',
    roleKeys: ['bookkeeper'],
    roleNames: ['Bookkeeper'],
    unattended: false,
    createdAt: '2026-11-01T15:00:00.000Z',
    lastUsedAt: '2026-11-18T14:30:00.000Z',
    revokedAt: null,
    paused: Boolean(opts.paused),
    allPaused: false,
    policy: {
      agentId: 'a1',
      preset,
      overrides,
      locked: opts.locked ?? LOCKED,
      policy: {
        preset,
        classes,
        areas,
        bulkCap: opts.bulkCap ?? null,
        twoPersonOver: null,
        requestExpiryDays: 7,
        folders: opts.folders ?? ['C:\\Receipts'],
        notifyEmail: false,
        pausedAt: opts.paused ? '2026-11-19T10:00:00.000Z' : null,
      },
    },
  };
}

const cell = (scope: string, cls: string, setting: string) =>
  $<HTMLInputElement>(`[data-policy-grid="${scope}"] input[data-cell="${cls}:${setting}"]`);

async function openDetail(calls?: FetchCall[]) {
  await mount(page());
  await click(await until(() => $('button[aria-label="Open Month-end helper"]'), 'the Open button'), 'Open');
  await until(() => $('[data-agent-detail="a1"]') && cell('everywhere', 'read', 'allow'), 'the detail page with its grid');
  if (calls) check(calls.some((c) => c.method === 'GET' && c.path === '/api/agents/a1'), 'the detail was loaded');
}

domTest('the agent detail: the grid shows locked cells with their reason, and they cannot be changed', async () => {
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
  });
  await openDetail(calls);
  const grid = $('[data-policy-grid="everywhere"]');
  equal($$('tr[data-class]', grid ?? document).length, 14, 'the fourteen kinds of work');
  const text = textOf(grid);
  check(text.includes('Delete for good') && text.includes('Users and security'), 'each kind of work is named');
  check(text.includes('Delete for good, or anything else that cannot be undone.'), 'with one line on what it covers');
  check(textOf().includes('The role is the most an agent can ever ask for'), 'the page says what the role means for safety');

  // The preset's own settings are shown.
  check(cell('everywhere', 'read', 'allow')?.checked, 'Read is Allow');
  check(cell('everywhere', 'enter', 'ask')?.checked, 'Enter new is Ask');
  check(cell('everywhere', 'admin', 'never')?.checked, 'Users and security is Never');

  // Locked: disabled, marked, and the reason is on the row and on the cell.
  const locked = cell('everywhere', 'remove', 'allow');
  check(locked?.disabled && locked.dataset.locked === 'true', 'Delete for good cannot be Allow');
  check(textOf($('[data-lock-reason="remove"]', grid ?? document)).includes('"Delete for good" can never be Allow for an agent: a person approves this work.'), 'the row says why');
  check(locked?.closest('label')?.getAttribute('title')?.includes('can never be Allow'), 'and so does the cell');
  equal($$('input[data-locked="true"]', grid ?? document).length, NEVER_ALLOW.length, 'every locked cell is locked');
  check(!cell('everywhere', 'enter', 'allow')?.disabled, 'an open cell can be chosen');

  await click(locked, 'the locked cell');
  check(!cell('everywhere', 'remove', 'allow')?.checked && cell('everywhere', 'remove', 'ask')?.checked, 'clicking it changes nothing');
  check(button('Save changes')?.disabled, 'nothing to save');

  // The same holds in an area.
  await click(button('By area'), 'By area');
  await until(() => cell('banking', 'remove', 'allow'), 'the Banking grid');
  check(cell('banking', 'remove', 'allow')?.disabled, 'locked in an area too');
  equal(calls.filter((c) => c.method !== 'GET').length, 0, 'nothing was sent');
  await unmount();
});

domTest('saving sends only what changed, in the policy shape', async () => {
  let saved: Override[] = [];
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': () => detailOf({ overrides: saved }),
    'PATCH /api/agents/a1': (c: FetchCall) => {
      const body = c.body as { overrides?: Override[]; bulkCap?: number };
      saved = body.overrides ?? saved;
      return detailOf({ overrides: saved, bulkCap: body.bulkCap ?? null });
    },
  });
  await openDetail(calls);
  check(button('Save changes')?.disabled, 'Save waits for a change');

  // Everywhere: Enter new to Allow; Change to Allow and back to Ask. Changed on purpose (wave 3):
  // the preset's own Ask, clicked, is kept as chosen, so a later looser preset cannot move it.
  await click(cell('everywhere', 'enter', 'allow'), 'Enter new: Allow');
  await click(cell('everywhere', 'change', 'allow'), 'Change or void: Allow');
  await click(cell('everywhere', 'change', 'ask'), 'Change or void: Ask');
  check(textOf($('[data-own="enter"]')) === 'Changed from the preset', 'the changed row is marked');
  check(textOf($('[data-own="change"]')) === 'Kept as chosen', "the preset's own setting, clicked, is kept as chosen");
  check(!button('Save changes')?.disabled, 'Save is ready');

  // Payroll: Enter new is Never there.
  await click(button('By area'), 'By area');
  const area = await until(() => $<HTMLSelectElement>('#ag-area'), 'the area choice');
  area.value = 'payroll';
  area.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => cell('payroll', 'enter', 'never'), 'the Payroll grid');
  check(cell('payroll', 'enter', 'allow')?.checked, 'an area follows everywhere until set');
  await click(cell('payroll', 'enter', 'never'), 'Payroll, Enter new: Never');
  check(cell('payroll', 'enter', 'never')?.checked, 'set for Payroll');

  // Limits: the most records one request may change.
  await click(button('Limits'), 'Limits');
  await focus(await until(() => $('#ag-bulk-cap'), 'the bulk cap'), 'the bulk cap');
  await typeText('50');
  check(textOf().includes('C:\\Receipts'), 'the folders are listed');

  await click(button('Save changes'), 'Save changes');
  await until(() => calls.some((c) => c.method === 'PATCH'), 'the save');
  const patches = calls.filter((c) => c.method === 'PATCH');
  equal(patches.length, 1, 'one save');
  equal(patches[0].path, '/api/agents/a1', 'to the agent');
  equal(
    JSON.stringify(patches[0].body),
    JSON.stringify({
      overrides: [
        { class: 'enter', area: null, setting: 'allow' },
        { class: 'enter', area: 'payroll', setting: 'never' },
        { class: 'change', area: null, setting: 'ask' },
      ],
      bulkCap: 50,
    }),
    'only what changed, as AgentPolicyInput',
  );
  await until(() => textOf().includes('Saved.'), 'the saved notice');
  await until(() => button('Save changes')?.disabled, 'nothing left to save');

  // A limit that cannot be sent is said in plain words, and nothing is sent.
  await focus($('#ag-expiry'), 'the days field');
  ($('#ag-expiry') as HTMLInputElement).select();
  await typeText('0');
  await click(button('Save changes'), 'Save changes');
  await until(() => textOf().includes('Days a request waits for an answer must be a whole number from 1 to 365.'), 'the problem');
  equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'nothing more was sent');
  await unmount();
});

/** AgentGrantView (lib/agent/contract.ts): given by Pat Owner, ending later today. */
const GRANT = {
  id: 'g1',
  agentId: 'a1',
  operation: 'invoices.create',
  constraints: { maxAmount: '500.00', maxUses: 10 },
  givenBy: 'u1',
  expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  revokedAt: null,
  uses: 2,
  agentName: 'Month-end helper',
  operationLabel: 'Enter an invoice',
  class: 'enter',
  givenByName: 'Pat Owner',
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  maxUses: 10,
};

// Changed on purpose (wave 3): Revoke asks once before it takes the permission back.
domTest('standing permissions: who gave it, what it is held to and until when; Revoke asks once, then takes it back', async () => {
  let revoked = false;
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    'GET /api/agents/a1/grants': () => ({ grants: revoked ? [] : [GRANT] }),
    'DELETE /api/agent-grants/g1': () => {
      revoked = true;
      return { ok: true };
    },
  });
  await openDetail(calls);
  await click(button('Standing permissions'), 'Standing permissions');
  const row = await until(() => $('tr[data-grant="g1"]'), 'the standing permission');
  const text = textOf(row);
  check(text.includes('Enter an invoice') && text.includes('Pat Owner'), `what it covers and who gave it: ${text}`);
  check(text.includes('up to 500.00') && text.includes('2 of 10'), `what holds it and how often it was used: ${text}`);
  check(text.includes(new Date(GRANT.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), `until when: ${text}`);
  equal(row.dataset.grantState, 'live', 'it is in effect');
  check(text.includes('In effect'), 'and says so');
  check(!$('[data-grants-paused]'), 'no note that it is not in effect');

  await click(button('Revoke', row), 'Revoke');
  const confirm = await until(dialog, 'the question');
  check(textOf(confirm).includes('Month-end helper will ask a person again before "Enter an invoice"'), `it says what happens: ${textOf(confirm)}`);
  equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing is taken back before the answer');
  await click(button('Revoke', confirm), 'Revoke in the question');
  await until(() => textOf().includes('No standing permissions.'), 'the list without it');
  check(!dialog(), 'asked once');
  equal(calls.filter((c) => c.method === 'DELETE').map((c) => c.path).join(','), '/api/agent-grants/g1', 'the grant route, once');
  await unmount();
});

domTest('a standing permission is marked as not in effect while the agent is paused', async () => {
  stub({
    'GET /api/agents': listed([agentRow({ pausedAt: '2026-11-19T10:00:00.000Z' })]),
    'GET /api/agents/a1': detailOf({ paused: true }),
    'GET /api/agents/a1/grants': { grants: [GRANT] },
  });
  await openDetail();
  await click(button('Standing permissions'), 'Standing permissions');
  const row = await until(() => $('tr[data-grant="g1"]'), 'the standing permission');
  equal(row.dataset.grantState, 'not_in_effect', 'it is not in effect');
  check(textOf(row).includes('Not in effect') && textOf(row).includes('while this agent is paused'), `the row says why: ${textOf(row)}`);
  check(textOf($('[data-grants-paused]')).includes('Not in effect while this agent is paused'), 'and so does the section');
  check(button('Revoke', row), 'it can still be taken back');
  await unmount();
});

domTest('Pause and Resume call the pause route, and Remove asks first', async () => {
  let removed = false;
  const calls = stub({
    'GET /api/agents': () => listed([removed ? HELPER_REMOVED : HELPER]),
    'GET /api/agents/a1': detailOf(),
    'POST /api/agents/a1/pause': (c: FetchCall) => detailOf({ paused: (c.body as { paused: boolean }).paused }),
    'DELETE /api/agents/a1': () => {
      removed = true;
      return { agent: HELPER_REMOVED };
    },
  });
  await openDetail(calls);
  await click(button(/Pause this agent/), 'Pause this agent');
  await until(() => button(/Resume/), 'Resume');
  check(textOf().includes('This agent is paused.'), 'the page says it is paused');
  await click(button(/Resume/), 'Resume');
  await until(() => button(/Pause this agent/), 'Pause again');
  const pauses = calls.filter((c) => c.method === 'POST');
  equal(pauses.map((c) => `${c.path} ${JSON.stringify(c.body)}`).join(' | '), '/api/agents/a1/pause {"paused":true} | /api/agents/a1/pause {"paused":false}', 'the pause route');

  await click($('[data-agent-detail] button[title="Remove this agent\'s access"]'), 'Remove');
  const confirm = await until(dialog, 'the confirmation');
  check(textOf(confirm).includes('Month-end helper will stop working at once.'), 'it says what will happen');
  equal(calls.filter((c) => c.method === 'DELETE').length, 0, 'nothing is removed before the answer');
  await click(button('Remove', confirm), 'Remove');
  await until(() => !$('[data-agent-detail]') && textOf().includes('Removed'), 'back to the list, the agent shown as removed');
  equal(calls.filter((c) => c.method === 'DELETE' && c.path === '/api/agents/a1').length, 1, 'one removal');
  await unmount();
});

domTest('activity: what it ran and asked, with links to the approval center and the audit trail', async () => {
  stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    'GET /api/agents/a1/activity': {
      activity: [
        { at: '2026-11-20T10:00:00.000Z', kind: 'request', operation: 'invoices.email', summary: 'Email invoice 1042 to billing@acme.com', class: 'outside', status: 'pending', approvedByName: null, auditId: null, requestId: 'r1' },
        { at: '2026-11-20T09:00:00.000Z', kind: 'operation', operation: 'invoices.create', summary: 'Added invoice', class: 'enter', status: 'done', approvedByName: 'Pat Owner', auditId: AU1, requestId: null },
      ],
    },
  });
  await openDetail();
  await click(button('Activity'), 'Activity');
  await until(() => textOf().includes('Email invoice 1042'), 'the activity');
  const text = textOf();
  check(text.includes('Added invoice') && text.includes('Pat Owner') && text.includes('Waiting') && text.includes('Done'), `each row with its outcome: ${text}`);
  check($('a[href="/agent-requests?id=r1"]'), 'a request links to the approval center');
  check($(`a[href="/audit-trail?id=${AU1}"]`), 'an operation links to the audit trail entry');
  // Changed on purpose (review): the approval center reads agentId and starts with this agent's
  // requests, so the link is named for that.
  equal(textOf($('a[href="/agent-requests?agentId=a1"]')), 'Its requests in the approval center', "and the agent's requests in the approval center are one click away");
  await unmount();
});

// Changed on purpose (wave 3): GET /api/agents answers { agents, allPaused } (contract §11), so the
// list says it from its own answer; "(adjusted: N)" is the form. Changed on purpose (wave 4): the
// count poll is read too, for Pause all agents only (canPauseAll), never for what the list shows;
// and N counts the settings that differ from the preset, which the tooltip says.
domTest('the list marks an adjusted preset, and every agent as paused while Integrated Applications is off', async () => {
  stub({
    'GET /api/agents': listed([agentRow({ preset: 'read_only', overrideCount: 2 }), GONE], { allPaused: true }),
    // The poll says otherwise: the list goes by its own answer.
    [COUNT_ROUTE]: { ...NO_SWITCH, allPaused: false },
  });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  await until(() => $('[data-all-paused]'), 'the note that every agent is paused');
  const text = textOf();
  equal(textOf($('[data-preset-of="a1"]')), 'Read only (adjusted: 2)', 'the preset says it was adjusted');
  equal(
    $('[data-preset-of="a1"]')?.getAttribute('title'),
    '2 settings differ from the preset, everywhere or in an area. Open the agent to see what it may do.',
    'and what that means',
  );
  check(text.includes('Every agent is paused') && text.includes('Integrated Applications'), 'the note says why');
  check(text.includes('Paused') && text.includes('All agents') && !text.includes('Active'), `the agent is shown paused: ${text}`);
  check(text.includes('Removed'), 'a removed agent stays removed');
  await unmount();

  // Applications allowed: the agent is active, whatever the poll says.
  stub({
    'GET /api/agents': listed([HELPER], { allPaused: false }),
    [COUNT_ROUTE]: { ...NO_SWITCH, allPaused: true },
  });
  await mount(page());
  await until(() => textOf().includes('Active'), 'the agent shown active');
  check(!$('[data-all-paused]'), 'no note');
  equal(textOf($('[data-preset-of="a1"]')), 'Ask for every change', 'a preset without changes is named as it is');
  check(!$('[data-preset-of="a1"]')?.getAttribute('title'), 'and has no tooltip');
  await unmount();
});

domTest('picking a stricter preset says which changes still let the agent do more, and takes them away on request', async () => {
  const OVERRIDES: Override[] = [
    { class: 'enter', area: null, setting: 'allow' },
    { class: 'bulk', area: null, setting: 'never' },
  ];
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf({ overrides: OVERRIDES }),
    'PATCH /api/agents/a1': (c: FetchCall) => {
      const body = c.body as { preset?: 'read_only'; overrides?: Override[] };
      return detailOf({ preset: body.preset, overrides: body.overrides ?? OVERRIDES });
    },
  });
  await openDetail(calls);
  check(textOf($('[data-preset-summary]')).includes('Ask for every change (adjusted: 2)'), 'the header says the preset was adjusted');
  check(!$('[data-looser-note]'), 'no note before another preset is picked');
  // The preset's line describes it as it comes; the note under it says what this agent's own add.
  const adjusted = textOf($('[data-preset-adjusted]'));
  check(adjusted.includes('That is the preset as it comes. This agent has 2 settings of its own'), `the preset's line is put right: ${adjusted}`);
  check(adjusted.includes('One of them lets it do more by itself than the preset says: Enter new: Allow.'), 'and names what lets it do more');
  check($('[data-preset-adjusted]')?.closest('label')?.querySelector<HTMLInputElement>('input')?.value === 'ask_every_change', 'under the chosen preset');

  await click($('input[name="ag-detail-preset"][value="read_only"]'), 'Read only');
  const note = await until(() => $('[data-looser-note]'), 'the note');
  const said = textOf(note);
  check(said.includes('"Read only" is chosen') && said.includes('Enter new: Allow'), `it names the looser change: ${said}`);
  check(!said.includes('Change many at once'), 'and only that one');
  check(cell('everywhere', 'enter', 'allow')?.checked, 'the grid still shows it');
  check($('[data-preset-adjusted]')?.closest('label')?.querySelector<HTMLInputElement>('input')?.value === 'read_only', "the note follows the chosen preset, so Read only's line is never taken as the whole truth");

  await click(button('Take it away', note), 'Take it away');
  await until(() => !$('[data-looser-note]'), 'the note to go');
  check(cell('everywhere', 'enter', 'never')?.checked, 'Enter new follows Read only again');
  await click(button('Save changes'), 'Save changes');
  await until(() => calls.some((c) => c.method === 'PATCH'), 'the save');
  equal(
    JSON.stringify(calls.find((c) => c.method === 'PATCH')?.body),
    JSON.stringify({ preset: 'read_only', overrides: [{ class: 'bulk', area: null, setting: 'never' }] }),
    'the stricter preset, without the looser change',
  );
  // Changed on purpose (wave 4): "(adjusted: N)" counts what differs from the preset. Change many
  // at once: Never is what Read only says too, so the header names the preset as it is, and its
  // tooltip says that one setting is kept as chosen.
  await until(() => textOf($('[data-preset-summary]')) === 'Read only', 'the header after the save');
  equal(
    $('[data-preset-summary]')?.getAttribute('title'),
    'No setting differs from the preset. One setting is kept as chosen: it changes nothing today, and a later change of the preset or of everywhere cannot move it. Today the agent may do just what the preset says.',
    "the header's tooltip",
  );
  await unmount();
});

domTest('an Allow the engine never gives stays locked even when the server list leaves it out', async () => {
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf({ locked: [] }),
  });
  await openDetail(calls);
  const grid = $('[data-policy-grid="everywhere"]');
  equal($$('input[data-locked="true"]', grid ?? document).length, NEVER_ALLOW.length, 'every Allow it never gives is locked');
  const locked = cell('everywhere', 'remove', 'allow');
  check(locked?.disabled, 'Delete for good cannot be Allow');
  check(textOf($('[data-lock-reason="remove"]', grid ?? document)).includes('"Delete for good" can never be Allow for an agent'), 'it says why');
  await click(locked, 'the locked cell');
  check(cell('everywhere', 'remove', 'ask')?.checked, 'clicking it changes nothing');
  check(button('Save changes')?.disabled, 'nothing to save');
  await unmount();
});

domTest('an area keeps the setting chosen for it, even the one it already follows', async () => {
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    'PATCH /api/agents/a1': (c: FetchCall) => detailOf({ overrides: (c.body as { overrides?: Override[] }).overrides ?? [] }),
  });
  await openDetail(calls);
  await click(button('By area'), 'By area');
  const area = await until(() => $<HTMLSelectElement>('#ag-area'), 'the area choice');
  area.value = 'payroll';
  area.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => cell('payroll', 'enter', 'ask'), 'the Payroll grid');
  const row = () => $('[data-policy-grid="payroll"] tr[data-class="enter"]');
  check(cell('payroll', 'enter', 'ask')?.checked && textOf(row()).includes('As everywhere'), 'Payroll follows everywhere');

  // Ask is already on (from everywhere): choosing it keeps it for Payroll.
  await click(cell('payroll', 'enter', 'ask'), 'Payroll, Enter new: Ask');
  await until(() => textOf(row()).includes('Set for this area'), 'Ask kept for Payroll');
  check(!button('Save changes')?.disabled, 'Save is ready');

  // Loosening everywhere leaves Payroll as chosen.
  await click(button('Everywhere'), 'Everywhere');
  await click(await until(() => cell('everywhere', 'enter', 'allow'), 'the everywhere grid'), 'Enter new: Allow');
  await click(button(/^By area/), 'By area');
  await until(() => cell('payroll', 'enter', 'ask'), 'the Payroll grid again');
  check(cell('payroll', 'enter', 'ask')?.checked, 'Payroll still asks');
  await click(button('Save changes'), 'Save changes');
  await until(() => calls.some((c) => c.method === 'PATCH'), 'the save');
  equal(
    JSON.stringify(calls.find((c) => c.method === 'PATCH')?.body),
    JSON.stringify({
      overrides: [
        { class: 'enter', area: null, setting: 'allow' },
        { class: 'enter', area: 'payroll', setting: 'ask' },
      ],
    }),
    'the area row is saved',
  );
  await unmount();
});

domTest('a folder typed but not added is added by Save, and the cap that applies is shown', async () => {
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    'PATCH /api/agents/a1': () => detailOf({ bulkCap: 75 }),
  });
  await openDetail(calls);
  await click(button('Limits'), 'Limits');
  const capLine = () => textOf($('[data-cap-applies]'));
  await until(() => capLine().includes('Once saved: no limit.'), 'the cap that applies');
  check(textOf().includes('empty means 200'), 'the help says what empty means while bulk work is Allow');
  await focus($('#ag-bulk-cap'), 'the bulk cap');
  await typeText('75');
  await until(() => capLine().includes('at most 75 records'), 'the cap typed');

  await focus($('#ag-folder'), 'the folder field');
  await typeText('D:/Scans');
  await until(() => $('[data-folder-pending]'), 'the note that it is not on the list yet');
  await click(button('Save changes'), 'Save changes');
  await until(() => calls.some((c) => c.method === 'PATCH'), 'the save');
  equal(JSON.stringify(calls.find((c) => c.method === 'PATCH')?.body), JSON.stringify({ bulkCap: 75, folders: ['C:\\Receipts', 'D:/Scans'] }), 'the typed folder is saved too');
  await until(() => !$('[data-folder-pending]') && ($('#ag-folder') as HTMLInputElement | null)?.value === '', 'the field empty after the save');
  // The answer does not spell the new folder as typed; only a folder the agent had can be "taken away".
  check(!$('[data-folders-taken-away]'), 'a new folder is never said to be taken away');
  await unmount();
});

domTest('on another computer the detail only shows the policy, and the agent can still be paused', async () => {
  const calls = stub({
    'GET /api/agents': listed([HELPER], { hostOnly: true }),
    'GET /api/agents/a1': detailOf(),
    'POST /api/agents/a1/pause': detailOf({ paused: true }),
  });
  await openDetail(calls);
  check(textOf().includes('This can only be changed on the computer that holds the company file.'), 'it says where it is changed');
  check($$<HTMLInputElement>('[data-policy-grid] input').every((i) => i.disabled), 'the grid cannot be changed');
  check(!button('Save changes'), 'no Save');
  check(!$('[data-agent-detail] button[title="Remove this agent\'s access"]'), 'no Remove');
  await click(button(/Pause this agent/), 'Pause this agent');
  await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/agents/a1/pause'), 'the pause');
  await unmount();
});

domTest('a click on the setting a cell already follows keeps it as chosen, everywhere too', async () => {
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    'PATCH /api/agents/a1': (c: FetchCall) => detailOf({ overrides: (c.body as { overrides?: Override[] }).overrides ?? [] }),
  });
  await openDetail(calls);
  const row = () => $('[data-policy-grid="everywhere"] tr[data-class="enter"]');
  check(cell('everywhere', 'enter', 'ask')?.checked && !$('[data-own="enter"]'), "Enter new follows the preset's Ask");
  // Ask is already on (from the preset): clicking it keeps it as this agent's own.
  await click(cell('everywhere', 'enter', 'ask'), 'Enter new: Ask');
  await until(() => textOf(row()).includes('Kept as chosen'), 'Ask kept as chosen');
  check(button('As the preset', row() ?? document), 'and it can follow the preset again');
  await click(button('Save changes'), 'Save changes');
  await until(() => calls.some((c) => c.method === 'PATCH'), 'the save');
  equal(JSON.stringify(calls.find((c) => c.method === 'PATCH')?.body), JSON.stringify({ overrides: [{ class: 'enter', area: null, setting: 'ask' }] }), 'saved as its own row');
  // Changed on purpose (wave 4): "(adjusted: N)" counts only what differs from the preset, so a
  // setting kept as chosen leaves the header as the preset's name; its tooltip says it is kept.
  await until(() => calls.filter((c) => c.method === 'PATCH').length === 1 && button('Save changes')?.disabled, 'saved');
  equal(textOf($('[data-preset-summary]')), 'Ask for every change', 'the header names the preset as it is');
  const title = $('[data-preset-summary]')?.getAttribute('title') ?? '';
  check(title.startsWith('No setting differs from the preset. One setting is kept as chosen') && title.includes('just what the preset says'), `the header's title says so: ${title}`);
  check(textOf($('[data-preset-adjusted]')).includes('It only keeps the setting it would have anyway'), 'and so does the note under the preset');
  await unmount();
});

const REFUSAL = 'Only an Admin can change the settings of an agent that has more access than you. You can still pause it.';

domTest('a person who is not an Admin can make an agent stricter or pause it, and never let it do more', async () => {
  const calls = stubFetch({
    'GET /api/auth/me': MANAGER_ME,
    [COUNT_ROUTE]: NO_SWITCH,
    'GET /api/agents': listed([agentRow({ overrideCount: 1 })], { allPaused: false }),
    'GET /api/agents/a1': detailOf({ overrides: [{ class: 'enter', area: null, setting: 'never' }], bulkCap: 100 }),
    'PATCH /api/agents/a1': reply(403, { error: REFUSAL, code: 'FORBIDDEN' }),
    'POST /api/agents/a1/pause': (c: FetchCall) =>
      detailOf({ overrides: [{ class: 'enter', area: null, setting: 'never' }], bulkCap: 100, paused: (c.body as { paused: boolean }).paused }),
  });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  check(!button(/New agent/), 'no New agent');
  equal($$('button[title="Remove this agent\'s access"]').length, 0, 'no Remove');
  check(textOf($('[data-not-admin]')).includes('Only an Admin can make or remove an agent.'), 'the list says why');
  // Pause all agents follows canPauseAll: not offered, and the list says who can.
  check(!$('[data-pause-all-agents]'), 'no Pause all agents');
  equal(textOf($('[data-pause-all-admin-only]')), 'Only an Admin can pause or resume all agents at once.', 'and it says who can');

  await click($('button[aria-label="Open Month-end helper"]'), 'Open');
  await until(() => cell('everywhere', 'read', 'allow'), 'the grid');
  check(textOf($('[data-not-admin]')).includes('Only an Admin can let it do more by itself'), 'the page says what this person may do');
  check(!$('[data-agent-detail] button[title="Remove this agent\'s access"]'), 'no Remove on the detail page');

  // Presets: the looser ones are off and say why; a stricter one can be picked.
  const preset = (p: string) => $<HTMLInputElement>(`input[name="ag-detail-preset"][value="${p}"]`);
  check(preset('trusted_bookkeeper')?.disabled && preset('full_with_asks')?.disabled, 'a looser preset cannot be picked');
  check(textOf(preset('trusted_bookkeeper')?.closest('label') ?? null).includes('Only an Admin can let an agent do more by itself.'), 'and it says why');
  check(!preset('read_only')?.disabled && !preset('ask_every_change')?.disabled, 'a stricter preset, or the same, can');

  // The grid: nothing that lets the agent do more; everything stricter.
  const grid = $('[data-policy-grid="everywhere"]') ?? document;
  check(cell('everywhere', 'change', 'allow')?.disabled && cell('everywhere', 'change', 'allow')?.dataset.adminOnly === 'true', 'Change or void cannot become Allow');
  check(cell('everywhere', 'enter', 'ask')?.disabled && cell('everywhere', 'enter', 'allow')?.disabled, 'Enter new cannot go back up from Never');
  check(cell('everywhere', 'change', 'allow')?.closest('label')?.getAttribute('title') === 'Only an Admin can let an agent do more by itself.', 'the cell says why');
  check(!cell('everywhere', 'change', 'never')?.disabled && !cell('everywhere', 'prepare', 'ask')?.disabled, 'a stricter choice is open');
  equal($$('input[data-locked="true"]', grid).length, NEVER_ALLOW.length, 'the locked cells are still the locked ones');
  check(button('As the preset')?.disabled, '"As the preset" on the stricter row would loosen it');
  check(button('Use the preset as it is')?.disabled, 'and so would using the preset as it is');

  await click(cell('everywhere', 'change', 'never'), 'Change or void: Never');
  check(cell('everywhere', 'change', 'never')?.checked, 'made stricter');
  check(!cell('everywhere', 'change', 'ask')?.disabled, 'and it can be put back as it was saved');

  // Limits: lowering is open, raising is held and says why.
  await click(button('Limits'), 'Limits');
  const cap = await until(() => $<HTMLInputElement>('#ag-bulk-cap'), 'the cap');
  await focus(cap, 'the cap');
  cap.select();
  await typeText('500');
  await until(() => $('[data-admin-only="bulkCap"]'), 'the note that only an Admin raises it');
  const held = textOf(await until(() => $('[data-loosen-blocked]'), 'the note by Save'));
  check(held.includes('up to 500 records in one request instead of 100') && held.includes('Put it back to save the rest'), `it says what is held: ${held}`);
  check(button('Save changes')?.disabled, 'Save is held');
  cap.select();
  await typeText('50');
  await until(() => !$('[data-admin-only="bulkCap"]') && !$('[data-loosen-blocked]'), 'the notes to go');
  check(!button('Save changes')?.disabled, 'Save is ready');
  // Folders (wave 4): one outside the agent's folders is not added for them, and the screen says why;
  // one inside a folder it has gives it nothing more, so it can be added (the server checks the disk).
  check(textOf($('[data-admin-only="folders"]')).includes('Only an Admin can give an agent a folder outside the ones it has.'), 'the rule is said');
  const folderField = await until(() => $<HTMLInputElement>('#ag-folder'), 'the folder field');
  check(!folderField.disabled, 'the folder field is open');
  await focus(folderField, 'the folder field');
  // Typed with forward slashes (a backslash key is not one the test's keyboard sends reliably).
  await typeText('D:/Scans');
  check(button(/Add folder/)?.disabled, 'a folder outside cannot be added');
  check(textOf($('[data-folder-pending]')).includes('Only an Admin can give an agent a folder outside the ones it has.'), 'and it says why');
  check($('[data-loosen-blocked]') && button('Save changes')?.disabled, 'Save holds it too, typed but not added');
  folderField.select();
  await typeText('C:/Receipts/2026');
  await until(() => !button(/Add folder/)?.disabled, 'a folder inside one it has can be added');
  check(!$('[data-loosen-blocked]'), 'and nothing is held');
  await click(button(/Add folder/), 'Add folder');
  await until(() => button('Remove C:/Receipts/2026'), 'the folder on the list');
  check(button('Remove C:\\Receipts'), 'a folder can still be taken off');
  const notify = $$<HTMLInputElement>('input[type="checkbox"]').find((c) => textOf(c.closest('label')).startsWith('Email the Admin')) ?? null;
  check(notify?.disabled && notify.dataset.adminOnly === 'true', 'the email notice cannot be turned on');
  check(textOf(notify?.closest('label') ?? null).includes('Only an Admin can turn the email notice on'), 'and it says why');

  // The server refuses (this agent has more access than the person): said in its own words.
  await click(button('Save changes'), 'Save changes');
  const refusal = await until(() => $('[data-save-error]'), 'the refusal');
  equal(textOf(refusal), REFUSAL, 'the refusal in its own words');
  equal(
    JSON.stringify(calls.find((c) => c.method === 'PATCH')?.body),
    JSON.stringify({
      overrides: [{ class: 'enter', area: null, setting: 'never' }, { class: 'change', area: null, setting: 'never' }],
      bulkCap: 50,
      folders: ['C:\\Receipts', 'C:/Receipts/2026'],
    }),
    'only the tightening, and the folder inside one it has, were sent',
  );

  // Pausing is open.
  await click(button(/Pause this agent/), 'Pause this agent');
  await until(() => button(/Resume/), 'Resume');
  await unmount();
});

// Review (wave 3): the server turns back on an agent that holds the Admin role only for an Admin,
// so nobody else is offered Resume for one; the page says why.
domTest('a person who is not an Admin is not offered Resume for an agent with the Admin role', async () => {
  const PAUSED_ADMIN_AGENT = { ...detailOf({ paused: true }), roleKeys: ['admin'], roleNames: ['Admin'] };
  const LISTED = agentRow({ roleKeys: ['admin'], pausedAt: '2026-11-19T10:00:00.000Z' });
  let calls = stubFetch({
    'GET /api/auth/me': MANAGER_ME,
    [COUNT_ROUTE]: NO_SWITCH,
    'GET /api/agents': listed([LISTED], { allPaused: false }),
    'GET /api/agents/a1': PAUSED_ADMIN_AGENT,
    'POST /api/agents/a1/pause': detailOf(),
  });
  await openDetail();
  const resume = await until(() => button(/Resume/), 'Resume');
  check(resume.disabled, 'Resume is off');
  equal(resume.getAttribute('title'), 'Only an Admin can turn back on an agent that holds the Admin role.', 'and says why');
  equal(textOf($('[data-resume-blocked]')), 'Only an Admin can turn back on an agent that holds the Admin role.', 'so does the page');
  await click(resume, 'Resume');
  equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing was sent');
  await unmount();

  // An Admin may turn it back on.
  calls = stub({
    'GET /api/agents': listed([LISTED], { allPaused: false }),
    'GET /api/agents/a1': PAUSED_ADMIN_AGENT,
    'POST /api/agents/a1/pause': { ...detailOf(), roleKeys: ['admin'], roleNames: ['Admin'] },
  });
  await openDetail();
  const forAdmin = await until(() => button(/Resume/), 'Resume');
  check(!forAdmin.disabled && !$('[data-resume-blocked]'), 'an Admin is offered Resume');
  await click(forAdmin, 'Resume');
  await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/agents/a1/pause'), 'the pause route');
  await unmount();
});

// Review (wave 3): Users & Roles knows whether the person is an Admin; it can say so, and the tab
// then does not ask GET /api/auth/me a second time.
function AnsweredLater() {
  const [admin, setAdmin] = React.useState<boolean | null>(null);
  return (
    <div>
      <Toaster />
      <button type="button" onClick={() => setAdmin(false)}>
        The page knows now
      </button>
      <AgentsTab roles={ROLES} viewerIsAdmin={admin} />
    </div>
  );
}

domTest('the page can say whether the person is an Admin, and the tab then does not ask again', async () => {
  const LIST = listed([HELPER], { allPaused: false });
  const asked = (calls: FetchCall[]) => calls.filter((c) => c.path === '/api/auth/me').length;

  // An Admin, as the page says.
  let calls = stubFetch({ 'GET /api/agents': LIST, [COUNT_ROUTE]: NO_SWITCH });
  await mount(
    <div>
      <Toaster />
      <AgentsTab roles={ROLES} viewerIsAdmin />
    </div>,
  );
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  check(button(/New agent/) && !$('[data-not-admin]'), 'New agent is offered, and no note for someone else');
  equal(asked(calls), 0, 'the tab did not ask who is signed in');
  await unmount();

  // Not an Admin, as the page says: its word is taken, even where the server would say Admin.
  calls = stub({ 'GET /api/agents': LIST });
  await mount(
    <div>
      <Toaster />
      <AgentsTab roles={ROLES} viewerIsAdmin={false} />
    </div>,
  );
  await until(() => $('[data-not-admin]'), 'the note for someone who is not an Admin');
  check(!button(/New agent/), 'no New agent');
  // Wave 5, kept on purpose: told only that the person is not an Admin, the tab takes it that they
  // may not change users either (fail closed), and offers the screens to look at only.
  check($('[data-not-admin][data-view-only]'), 'without viewerMayManage, the screens to look at only');
  equal(asked(calls), 0, 'the tab did not ask who is signed in');
  await unmount();

  // Told both, as Users & Roles tells it: someone who may change users gets the screens to tighten.
  calls = stub({ 'GET /api/agents': LIST });
  await mount(
    <div>
      <Toaster />
      <AgentsTab roles={ROLES} viewerIsAdmin={false} viewerMayManage />
    </div>,
  );
  await until(() => $('[data-not-admin]'), 'the note for someone who is not an Admin');
  check(!$('[data-view-only]') && textOf($('[data-not-admin]')).includes('Open one to make it stricter or pause it.'), 'told they may tighten or pause');
  equal(asked(calls), 0, 'the tab did not ask who is signed in');
  await unmount();

  // Still asking (null): the tab waits for the page, and shows nothing it might have to take back.
  calls = stub({ 'GET /api/agents': LIST });
  await mount(<AnsweredLater />);
  await until(() => calls.some((c) => c.path === '/api/agents'), 'the list asked for');
  check(!textOf().includes('Month-end helper') && !button(/New agent/), 'nothing shown before the page knows');
  await click(button('The page knows now'), 'the page answering');
  await until(() => $('[data-not-admin]') && textOf().includes('Month-end helper'), 'the list for someone who is not an Admin');
  check(!button(/New agent/), 'no New agent');
  equal(asked(calls), 0, 'the tab did not ask who is signed in');
  await unmount();

  // Left out: the tab asks itself, once.
  calls = stub({ 'GET /api/agents': LIST });
  await mount(page());
  await until(() => button(/New agent/), 'New agent for the Admin');
  equal(asked(calls), 1, 'the tab asked once');
  await unmount();
});

// ---------------------------------------------------------------------------
// Wave 4: the tab's help, Pause all agents, and who sees the tab in Users & Roles
// ---------------------------------------------------------------------------

domTest('the tab header shows its own help (/users/agents)', async () => {
  stub({ 'GET /api/agents': listed([HELPER]) });
  await mount(page());
  const trigger = await until(() => $<HTMLButtonElement>('[data-tab-help] button[aria-label="What is the Agents page?"]'), 'the help button in the header');
  await click(trigger, 'What is this tab?');
  const text = textOf(await until(() => $('[data-tab-help] [role="tooltip"]'), 'the bubble'));
  const h = TAB_HELP['/users/agents'];
  check(text.includes(h.what) && text.includes(h.first), `the bubble says the tab's own help: ${text}`);
  await unmount();
});

domTest('Pause all agents in the tab follows canPauseAll, and the list follows the switch', async () => {
  let paused = false;
  const calls = stub({
    'GET /api/agents': () => listed([HELPER], { allPaused: paused }),
    [COUNT_ROUTE]: () => ({ ...NO_SWITCH, allPaused: paused, canPauseAll: true }),
    'POST /api/agents/pause-all': (c: FetchCall) => {
      paused = (c.body as { paused: boolean }).paused;
      return { paused };
    },
  });
  await mount(page());
  const offered = await until(() => $<HTMLButtonElement>('[data-pause-all-agents]'), 'Pause all agents, for whoever may use it');
  check(!$('[data-pause-all-admin-only]'), 'and no note that only an Admin can');
  await click(offered, 'Pause all agents');
  const ask = await until(() => $('[role="dialog"]'), 'the question');
  check(textOf(ask).includes('Pause all agents?'), `it asks first: ${textOf(ask)}`);
  equal(calls.filter((c) => c.method === 'POST').length, 0, 'nothing is sent before the answer');
  await click(button('Pause all agents', ask), 'Pause all agents in the question');
  await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/agents/pause-all'), 'the switch');
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ paused: true }), 'what was sent');
  // The list is asked for again and says so from its own answer.
  await until(() => $('[data-all-paused]'), 'the list shows every agent paused');
  check(calls.filter((c) => c.method === 'GET' && c.path === '/api/agents').length >= 2, 'the list was asked for again');
  check(textOf().includes('Agents are paused'), 'the switch shows it is on');
  await unmount();

  // Not offered: no switch, and the list says who can use it (an Admin, or anyone else).
  for (const viewerIsAdmin of [true, false]) {
    stub({ 'GET /api/agents': listed([HELPER]), [COUNT_ROUTE]: NO_SWITCH });
    await mount(
      <div>
        <Toaster />
        <AgentsTab roles={ROLES} viewerIsAdmin={viewerIsAdmin} />
      </div>,
    );
    await until(() => $('[data-pause-all-admin-only]'), 'the note');
    check(!$('[data-pause-all-agents]'), 'no Pause all agents');
    equal(textOf($('[data-pause-all-admin-only]')), 'Only an Admin can pause or resume all agents at once.', 'it says who can');
    await unmount();
  }
  // The agent's page, while every agent is paused: who can turn them back on.
  stub({ 'GET /api/agents': listed([HELPER], { allPaused: true }), 'GET /api/agents/a1': { ...detailOf(), allPaused: true }, [COUNT_ROUTE]: { ...NO_SWITCH, allPaused: true } });
  await openDetail();
  const note = textOf(await until(() => $('[data-agent-detail] [data-all-paused]'), 'the note on the agent'));
  check(note.includes('Every agent is paused') && note.includes('Only an Admin can pause or resume all agents at once.'), `it says who can: ${note}`);
  await unmount();
  // The window's poll keeps its last answer: leave it saying the switch is not offered.
  stub({});
  await agentRequestCountStore().refresh();
});

// Review (wave 4): the count poll runs every 20 seconds. Making the company's first agent, or
// removing its last, asks it again at once, so Pause all agents follows straight away; and a poll
// still behind the list is not taken to mean that only an Admin can use the switch.
domTest('Pause all agents follows at once when an Admin makes the first agent or removes the last', async () => {
  let made = false;
  let removed = false;
  /** While set, the count poll waits: a poll that has not caught up with the list yet. */
  let held: Promise<void> | null = null;
  let release = () => {};
  const calls = stub({
    'GET /api/agents': () => listed(made ? [removed ? HELPER_REMOVED : HELPER] : []),
    [COUNT_ROUTE]: async () => {
      if (held) await held;
      return { ...NO_SWITCH, agents: made && !removed ? 1 : 0, canPauseAll: true };
    },
    'POST /api/agents': () => {
      made = true;
      held = new Promise<void>((r) => {
        release = () => {
          held = null;
          r();
        };
      });
      return reply(201, { agent: HELPER, token: TOKEN, connection: CONNECTION });
    },
    'DELETE /api/agents/a1': () => {
      removed = true;
      return { agent: HELPER_REMOVED };
    },
  });
  const countsAfter = (method: string) => {
    const at = calls.findIndex((c) => c.method === method);
    return at < 0 ? 0 : calls.slice(at + 1).filter((c) => c.path === '/api/agent-requests/count').length;
  };
  try {
    await madeThenRemoved();
  } finally {
    // Never leave the window's one poll waiting, whatever happened above.
    release();
  }
  // Leave the window's poll saying the switch is not offered, as the other tests expect.
  stub({});
  await agentRequestCountStore().refresh();

  async function madeThenRemoved() {
    await mount(page());
    await until(() => textOf().includes('No agents.'), 'the empty list');
    check(!$('[data-pause-all-agents]') && !$('[data-pause-all-admin-only]'), 'no switch, and nothing said, with no agent to pause');

    await click(button(/New agent/), 'New agent');
    const d = await until(dialog, 'the New agent dialog');
    await focus($('#ag-name', d), 'the name field');
    await typeText('Month-end helper');
    await click($$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('Bookkeeper')) ?? null, 'the Bookkeeper role');
    await click(button('Make agent', d), 'Make agent');
    const once = await until(() => (textOf(dialog()).includes('is ready') ? dialog() : null), 'the token dialog');
    await click(button('I have copied it', once), 'I have copied it');
    await until(() => !dialog() && textOf().includes('Active'), 'the new agent in the list, active');
    // The poll was asked again at once; until it answers it still counts no agent.
    await until(() => countsAfter('POST') >= 1, 'the count asked for again after the agent was made');
    check(!$('[data-pause-all-admin-only]'), 'an Admin is not told that only an Admin can pause all agents');
    check(!$('[data-pause-all-agents]'), 'and the switch waits for the poll');
    release();
    await until(() => $('[data-pause-all-agents]'), 'Pause all agents, without waiting for the next poll');
    check(!$('[data-pause-all-admin-only]'), 'still nothing said about who can');

    // Removing the last agent: the switch goes at once too.
    await click($('button[title="Remove this agent\'s access"]'), 'Remove');
    await click(button('Remove', await until(dialog, 'the confirmation')), 'Remove');
    await until(() => textOf().includes('Removed'), 'the agent shown as removed');
    await until(() => !$('[data-pause-all-agents]'), 'no Pause all agents once no agent is left');
    check(countsAfter('DELETE') >= 1, 'the count was asked for again after the removal');
    check(!$('[data-pause-all-admin-only]'), 'and nothing said about who can');
    await unmount();
  }
});

// Review (wave 4): tightening, pausing and Revoke need the right to change Users & Roles > Users.
// Someone who may only see that list sees the agents, and is offered nothing the server refuses.
domTest('someone who may only see Users sees each agent, and is offered nothing the server would refuse', async () => {
  const calls = stubFetch({
    'GET /api/auth/me': VIEWER_ME,
    [COUNT_ROUTE]: NO_SWITCH,
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf({ overrides: [{ class: 'enter', area: null, setting: 'never' }] }),
    'GET /api/agents/a1/grants': { grants: [GRANT] },
  });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  check(!button(/New agent/) && !$('button[title="Remove this agent\'s access"]'), 'no New agent, no Remove');
  const listNote = textOf($('[data-not-admin][data-view-only]'));
  check(listNote.includes('you need permission to change Users & Roles > Users') && !listNote.includes('Open one to make it stricter'), `the list says what they would need: ${listNote}`);

  await click($('button[aria-label="Open Month-end helper"]'), 'Open');
  await until(() => cell('everywhere', 'read', 'allow'), 'the grid');
  const note = textOf($('[data-agent-detail] [data-view-only]'));
  check(note.includes("You can look at this agent's settings") && note.includes('ask an Admin'), `the page says so: ${note}`);
  check(!$('[data-agent-detail] [data-not-admin]'), 'and does not say they may make it stricter');
  check($$<HTMLInputElement>('[data-policy-grid] input').every((i) => i.disabled), 'the grid cannot be changed');
  check($$<HTMLInputElement>('input[name="ag-detail-preset"]').every((i) => i.disabled), 'nor the preset');
  check(!button('Save changes') && !button(/Pause this agent/) && !button(/Resume/), 'no Save, no Pause, no Resume');
  await click(button('Limits'), 'Limits');
  check($<HTMLInputElement>('#ag-bulk-cap')?.disabled, 'the limits cannot be changed');
  await click(button('Standing permissions'), 'Standing permissions');
  const row = await until(() => $('tr[data-grant="g1"]'), 'the standing permission');
  check(textOf(row).includes('Enter an invoice'), 'it is listed');
  check(!button('Revoke', row), 'without Revoke');
  equal(calls.filter((c) => c.method !== 'GET').length, 0, 'nothing was sent');
  await unmount();
});

domTest("the server's folder refusals are shown beside Save as they come", async () => {
  // Only the server can see the disk: a folder that is not there, a share of this computer, one of
  // Ironbooks' own places, or (for someone who is not an Admin) a stored folder that does not really
  // reach the new one. Each comes back in its own words: the server's messages (lib/services/
  // agentPolicies.ts checkFolders and thisComputerShareRefusal, Windows wording), for the folder sent.
  // Only a folder new in the save is looked at on the disk (a stored one is kept unlooked-at), so
  // each refusal names the folder typed, never one the agent already has.
  const REFUSALS: Array<(typed: string) => string> = [
    (f) => `The folder "${f}" was not found on this computer. Check the path, make the folder first, or take it off the list.`,
    (f) => `"${f}": that folder is on this computer, reached as a network share. Type its own path on this computer instead, like C:\\Users\\you\\Documents\\Receipts.`,
    (f) =>
      `The folder "${f}" is one of the folders Ironbooks keeps its own data in (settings, working copies, backups or agents' files), or is inside or holds one. Choose another folder for the agent.`,
  ];
  let next = 0;
  const calls = stub({
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    'PATCH /api/agents/a1': (c: FetchCall) => {
      // The folder refused is the one added (the last on the list sent).
      const folders = (c.body as { folders?: string[] }).folders ?? [];
      return reply(400, { error: REFUSALS[next](folders[folders.length - 1] ?? ''), code: 'VALIDATION' });
    },
  });
  await openDetail(calls);
  await click(button('Limits'), 'Limits');
  for (; next < REFUSALS.length; next++) {
    const typed = `D:/Folder${next}`;
    await focus(await until(() => $('#ag-folder'), 'the folder field'), 'the folder field');
    await typeText(typed);
    await click(button('Save changes'), 'Save changes');
    const said = await until(() => $('[data-save-error]'), 'the refusal');
    equal(textOf(said), REFUSALS[next](typed), 'in its own words, naming the folder typed');
    await click(button('Undo changes'), 'Undo changes');
    await until(() => !$('[data-save-error]') && button('Save changes')?.disabled, 'back as it was saved');
  }
  equal(calls.filter((c) => c.method === 'PATCH').length, REFUSALS.length, 'each was sent once');
  await unmount();
});

// Wave 5: for a person who is not an Admin, the server takes off the list a folder the agent had
// that would be refused were it given today (lib/services/agentPolicies.ts checkFolders), and the
// save goes through. The answer has no field for it: the page compares what it sent with what came
// back, and says which folders Ironbooks took off and why.
domTest('a folder Ironbooks takes off the list on a save is named beside Save, with why', async () => {
  // Given before the rule existed: a share of this very computer.
  const SHARE = '\\\\localhost\\c$\\Scans';
  let folders = ['C:\\Receipts', SHARE];
  const calls = stubFetch({
    'GET /api/auth/me': MANAGER_ME,
    [COUNT_ROUTE]: NO_SWITCH,
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': () => detailOf({ folders }),
    'PATCH /api/agents/a1': (c: FetchCall) => {
      const body = c.body as { folders?: string[]; bulkCap?: number };
      // The server keeps what may stay and takes the share away (the audit row says why).
      if (body.folders) folders = body.folders.filter((f) => !f.startsWith('\\\\localhost'));
      return detailOf({ folders, bulkCap: body.bulkCap ?? null });
    },
  });
  await openDetail(calls);
  await click(button('Limits'), 'Limits');
  await click(await until(() => button('Remove C:\\Receipts'), 'the folders'), 'Remove C:\\Receipts');
  await click(button('Save changes'), 'Save changes');
  const note = await until(() => $('[data-folders-taken-away]'), 'the note');
  equal(JSON.stringify(calls.find((c) => c.method === 'PATCH')?.body), JSON.stringify({ folders: [SHARE] }), 'what was sent: the share kept');
  const said = textOf(note);
  check(said.startsWith('Saved. Ironbooks took this folder off the agent\'s list') && said.includes(`"${SHARE}"`), `it names the folder: ${said}`);
  check(said.includes('a whole drive or share, a share of this computer, or holds or is inside the company file'), `and why: ${said}`);
  // The audit trail needs a permission of its own, which this person may not have.
  check(said.includes('The audit trail entry for this save says which; if you cannot open the audit trail, an Admin can.'), `where it is written, and who can look: ${said}`);
  check(said.endsWith('Only an Admin can give the agent a folder outside the ones it has.'), `what only an Admin may add, as the Limits section says it: ${said}`);
  check(!said.includes('C:\\Receipts'), 'the folder the person took off is not named');
  check(!button(`Remove ${SHARE}`), 'the list shows what was saved');
  check(!$('[data-save-error]'), 'and the save is not shown as refused');

  // A save the page itself stops sends nothing and saves nothing, so the note stays.
  const cap = await until(() => $<HTMLInputElement>('#ag-bulk-cap'), 'the bulk cap');
  cap.select();
  await typeText('0');
  await click(button('Save changes'), 'Save changes');
  await until(() => textOf().includes('The most records one request may change must be a whole number'), 'the problem');
  equal(calls.filter((c) => c.method === 'PATCH').length, 1, 'nothing more was sent');
  check(textOf($('[data-folders-taken-away]')) === said, 'the note about the folders taken away stays');

  // The next save says only what it did.
  cap.select();
  await typeText('50');
  await click(button('Save changes'), 'Save changes');
  await until(() => calls.filter((c) => c.method === 'PATCH').length === 2 && !$('[data-folders-taken-away]'), 'the note to go with the next save');
  equal(JSON.stringify(calls.filter((c) => c.method === 'PATCH')[1].body), JSON.stringify({ bulkCap: 50 }), 'no folders sent, so nothing to compare');
  await unmount();
});

/** Someone who may see Users & Roles > Roles only. */
const ROLES_ONLY_ME = { id: 'u3', name: 'Rae Roles', isAdmin: false, permissions: { users: ['view'] }, activities: { 'users.roles': ['view'] } };
const PEOPLE = [{ userId: 'u1', name: 'Pat Owner', login: 'pat', isActive: true, isOwner: true, roleKeys: ['admin'], roles: [{ key: 'admin', name: 'Admin' }], isAdmin: true }];
const ROLE_LIST = { roles: ROLES.map((r) => ({ ...r, permissions: {}, flags: {}, userCount: 1 })), catalog: { areas: [], actions: [], flags: [], activities: [] } };
const tabNames = () => $$('[role="tablist"] [role="tab"]').map((t) => textOf(t));

domTest('Users & Roles shows the Agents tab to whoever may view Users, once it knows who is signed in', async () => {
  // An Admin: the tab appears only once GET /api/auth/me has answered, and is told it is an Admin.
  let answerMe: (v: unknown) => void = () => {};
  const me = new Promise((r) => (answerMe = r));
  let calls = stubFetch({
    'GET /api/auth/me': () => me,
    'GET /api/users': PEOPLE,
    'GET /api/roles': ROLE_LIST,
    'GET /api/agents': listed([HELPER]),
    [COUNT_ROUTE]: NO_SWITCH,
  });
  await mount(
    <div>
      <Toaster />
      <UsersAndRolesPage />
    </div>,
  );
  await until(() => textOf().includes('Pat Owner'), 'the users');
  equal(tabNames().join(','), 'Users,Roles', 'no Agents tab before the page knows who is signed in');
  answerMe(ADMIN_ME);
  await until(() => tabNames().includes('Agents'), 'the Agents tab');
  equal(tabNames().join(','), 'Users,Roles,Password rules,Agents', 'the tabs for an Admin, as before');
  await click($$<HTMLButtonElement>('[role="tab"]').find((t) => textOf(t) === 'Agents') ?? null, 'Agents');
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  check(button(/New agent/) && !$('[data-not-admin]'), 'the Admin screen straight away');
  equal(calls.filter((c) => c.path === '/api/auth/me').length, 1, 'asked who is signed in once, by the page');
  await unmount();

  // Someone who may change Users but is not an Admin: the tab, with the screens for them.
  calls = stubFetch({
    'GET /api/auth/me': MANAGER_ME,
    'GET /api/users': PEOPLE,
    'GET /api/roles': ROLE_LIST,
    'GET /api/agents': listed([HELPER]),
    [COUNT_ROUTE]: NO_SWITCH,
  });
  await mount(
    <div>
      <Toaster />
      <UsersAndRolesPage />
    </div>,
  );
  await until(() => tabNames().includes('Agents'), 'the Agents tab');
  equal(tabNames().join(','), 'Users,Roles,Agents', 'no Password rules for them, as before');
  await click($$<HTMLButtonElement>('[role="tab"]').find((t) => textOf(t) === 'Agents') ?? null, 'Agents');
  await until(() => $('[data-not-admin]') && textOf().includes('Month-end helper'), 'the list for someone who is not an Admin');
  check(!button(/New agent/), 'no New agent');
  check(textOf($('[data-not-admin]')).includes('Open one to make it stricter or pause it.') && !$('[data-view-only]'), 'told they may tighten or pause');
  equal(calls.filter((c) => c.path === '/api/auth/me').length, 1, 'asked once');
  await unmount();

  // Someone who may only view Users: the tab, to look at, and told what they would need to do more.
  calls = stubFetch({
    'GET /api/auth/me': VIEWER_ME,
    'GET /api/users': PEOPLE,
    'GET /api/roles': ROLE_LIST,
    'GET /api/agents': listed([HELPER]),
    'GET /api/agents/a1': detailOf(),
    [COUNT_ROUTE]: NO_SWITCH,
  });
  await mount(
    <div>
      <Toaster />
      <UsersAndRolesPage />
    </div>,
  );
  await until(() => tabNames().includes('Agents'), 'the Agents tab');
  equal(tabNames().join(','), 'Users,Roles,Agents', 'the Agents tab for them too');
  await click($$<HTMLButtonElement>('[role="tab"]').find((t) => textOf(t) === 'Agents') ?? null, 'Agents');
  await until(() => $('[data-view-only]') && textOf().includes('Month-end helper'), 'the list for someone who may only look');
  check(!textOf().includes('Open one to make it stricter'), 'nothing they cannot do is promised');
  await click($('button[aria-label="Open Month-end helper"]'), 'Open');
  await until(() => $('[data-agent-detail] [data-view-only]') && cell('everywhere', 'read', 'allow'), 'the agent, to look at');
  check(!button(/Pause this agent/) && !button('Save changes'), 'no Pause, no Save');
  equal(calls.filter((c) => c.path === '/api/auth/me').length, 1, 'asked once, by the page');
  await unmount();

  // Someone who may see Roles only: no Agents tab (the server would not list agents for them).
  calls = stubFetch({
    'GET /api/auth/me': ROLES_ONLY_ME,
    'GET /api/users': reply(403, { error: 'You do not have permission to view users.', code: 'FORBIDDEN' }),
    'GET /api/roles': ROLE_LIST,
    [COUNT_ROUTE]: NO_SWITCH,
  });
  await mount(<UsersAndRolesPage />);
  await until(() => calls.some((c) => c.path === '/api/auth/me') && textOf().includes('You do not have permission to view users.'), 'the page');
  await sleep(100);
  equal(tabNames().join(','), 'Users,Roles', 'no Agents tab');
  equal(calls.filter((c) => c.path === '/api/agents').length, 0, 'and the agents are never asked for');
  await unmount();

  // GET /api/auth/me failed: nothing is guessed, so no Agents tab.
  calls = stubFetch({ 'GET /api/auth/me': reply(500, { error: 'Busy.' }), 'GET /api/users': PEOPLE, 'GET /api/roles': ROLE_LIST, [COUNT_ROUTE]: NO_SWITCH });
  await mount(<UsersAndRolesPage />);
  await until(() => textOf().includes('Pat Owner'), 'the users');
  await sleep(100);
  equal(tabNames().join(','), 'Users,Roles', 'no Agents tab');
  await unmount();
});

// ---------------------------------------------------------------------------
// The audit trail: the Activity tab's links land on the entry (?id=)
// ---------------------------------------------------------------------------

// AU1, AU2 and GONE_ID (audit entries' ids, UUIDs) are with the fixtures at the top.
const AUDIT_ROW = {
  id: AU1,
  action: 'create',
  entityType: 'invoice',
  entityId: 'inv1',
  actorName: 'Month-end helper (agent)',
  actorId: null,
  createdAt: '2026-11-20T09:00:00.000Z',
};
const OTHER_ROW = { ...AUDIT_ROW, id: AU2, actorName: 'Pat Owner', createdAt: '2026-11-20T10:00:00.000Z' };

domTest('the audit trail opens the entry its address names, expanded and scrolled to', async () => {
  const scrolled: Element[] = [];
  const realScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  try {
    window.history.replaceState(null, '', `?id=${AU1}`);
    const calls = stubFetch({
      'GET /api/audit-trail': { rows: [OTHER_ROW, AUDIT_ROW], total: 2 },
      [`GET /api/audit-trail/${AU1}`]: { ...AUDIT_ROW, oldValues: null, newValues: { invoiceNumber: '1042', total: '250.00' } },
    });
    await mount(<AuditTrailPage />);
    const focused = await until(() => $(`[data-audit-focus="${AU1}"]`), 'the entry at the top');
    check(textOf(focused).includes('The entry you opened') && textOf(focused).includes('Month-end helper (agent)'), `it shows the entry: ${textOf(focused)}`);
    await until(() => textOf(focused).includes('"invoiceNumber": "1042"'), 'opened, with what it recorded');
    check(scrolled.includes(focused), 'scrolled to');
    await until(() => $$(`tr[data-audit-row="${AU2}"]`).length === 1, 'the whole trail below');
    equal($$(`tr[data-audit-row="${AU1}"][data-focused="true"]`).length, 2, 'the entry is marked at the top and in the trail');
    equal($$('tr[data-focused]').length, 2, 'and nothing else is');
    equal(calls.filter((c) => c.path === `/api/audit-trail/${AU1}`).length, 1, 'the entry was asked for once');

    await click(button('Close', focused), 'Close');
    await until(() => !$('[data-audit-focus]'), 'the entry at the top to go');
    check(!window.location.search.includes('id='), 'the address no longer names it');
    await unmount();
  } finally {
    Element.prototype.scrollIntoView = realScroll;
    window.history.replaceState(null, '', window.location.pathname);
  }
});

domTest('an audit trail entry that cannot be found is said once, and the whole trail is shown; another failure is said as it is, with Try again', async () => {
  try {
    window.history.replaceState(null, '', `?id=${GONE_ID}`);
    stubFetch({
      'GET /api/audit-trail': { rows: [AUDIT_ROW], total: 1 },
      [`GET /api/audit-trail/${GONE_ID}`]: reply(404, { error: 'Audit log entry not found.', code: 'NOT_FOUND' }),
    });
    await mount(<AuditTrailPage />);
    const note = await until(() => $(`[data-audit-focus="${GONE_ID}"]`), 'the note');
    check(textOf(note).includes("That entry is not in this company's audit trail"), `it says so: ${textOf(note)}`);
    await until(() => $(`tr[data-audit-row="${AU1}"]`), 'the trail below');
    check(!$('tr[data-focused]'), 'nothing is marked');
    await unmount();

    // Review (wave 3): any other failure is not "not found": it is said as it is, with Try again,
    // and no row of the trail is marked until the entry itself has loaded.
    window.history.replaceState(null, '', `?id=${AU1}`);
    let failing = true;
    const tries = stubFetch({
      'GET /api/audit-trail': { rows: [AUDIT_ROW], total: 1 },
      [`GET /api/audit-trail/${AU1}`]: () => (failing ? reply(500, { error: 'The company file is busy. Try again in a moment.' }) : { ...AUDIT_ROW, oldValues: null, newValues: { total: '250.00' } }),
    });
    await mount(<AuditTrailPage />);
    const failed = await until(() => $(`[data-audit-focus="${AU1}"]`), 'the note');
    check(textOf(failed).includes('The company file is busy. Try again in a moment.'), `the error in its own words: ${textOf(failed)}`);
    check(!textOf(failed).includes('not in this company'), 'not said to be missing');
    await until(() => $(`tr[data-audit-row="${AU1}"]`), 'the trail below');
    check(!$('tr[data-focused]'), 'nothing is marked before the entry loaded');
    failing = false;
    await click(button('Try again', failed), 'Try again');
    await until(() => textOf($(`[data-audit-focus="${AU1}"]`)).includes('The entry you opened'), 'the entry, on the second try');
    await until(() => $$('tr[data-focused="true"]').length === 2, 'marked at the top and in the trail');
    equal(tries.filter((c) => c.path === `/api/audit-trail/${AU1}`).length, 2, 'asked twice');
    await unmount();

    // A server error without a full stop still reads as a sentence before the next step.
    window.history.replaceState(null, '', `?id=${AU1}`);
    stubFetch({
      'GET /api/audit-trail': { rows: [AUDIT_ROW], total: 1 },
      [`GET /api/audit-trail/${AU1}`]: reply(500, { error: 'Internal server error' }),
    });
    await mount(<AuditTrailPage />);
    const plain = await until(() => $('[data-audit-focus-error]'), 'the error');
    equal(textOf(plain), 'Internal server error. Try again, or find the entry in the trail below.', 'said as a sentence, with what to do');
    await unmount();

    // Wave 4: an address whose id is not an entry's id at all names no entry: "not found", without
    // asking (the server could not look it up, and would answer with an error, not "not found").
    window.history.replaceState(null, '', '?id=not-an-entry');
    const odd = stubFetch({ 'GET /api/audit-trail': { rows: [AUDIT_ROW], total: 1 } });
    await mount(<AuditTrailPage />);
    const missing = await until(() => $('[data-audit-focus="not-an-entry"]'), 'the note');
    check(textOf(missing).includes("That entry is not in this company's audit trail") && !button('Try again', missing), `not found, with nothing to try again: ${textOf(missing)}`);
    equal(odd.filter((c) => c.path.startsWith('/api/audit-trail/')).length, 0, 'nothing was asked for');
    await unmount();

    // No id: the page is as it always was.
    window.history.replaceState(null, '', window.location.pathname);
    const calls = stubFetch({ 'GET /api/audit-trail': { rows: [AUDIT_ROW], total: 1 } });
    await mount(<AuditTrailPage />);
    await until(() => $(`tr[data-audit-row="${AU1}"]`), 'the trail');
    check(!$('[data-audit-focus]') && !$('tr[data-focused]'), 'nothing extra');
    equal(calls.filter((c) => c.path.startsWith('/api/audit-trail/')).length, 0, 'no entry was asked for');
    await unmount();
  } finally {
    window.history.replaceState(null, '', window.location.pathname);
  }
});

// Wave 4: a row whose details could not be read is not shown as an entry with nothing recorded.
domTest('an audit trail row whose details cannot be loaded stays closed and says why; a second click asks again', async () => {
  let failing = true;
  const calls = stubFetch({
    'GET /api/audit-trail': { rows: [AUDIT_ROW], total: 1 },
    [`GET /api/audit-trail/${AU1}`]: () => (failing ? reply(500, { error: 'The company file is busy. Try again in a moment.' }) : { ...AUDIT_ROW, oldValues: null, newValues: { total: '250.00' } }),
  });
  await mount(
    <div>
      <Toaster />
      <AuditTrailPage />
    </div>,
  );
  const row = await until(() => $(`tr[data-audit-row="${AU1}"]`), 'the row');
  await click(row, 'the row');
  await until(() => textOf().includes('The company file is busy. Try again in a moment.'), 'the reason');
  check(!textOf().includes('No value snapshot recorded.') && !textOf().includes('"total"'), 'the row stays closed, and nothing is said to be recorded');
  failing = false;
  await click($(`tr[data-audit-row="${AU1}"]`), 'the row again');
  await until(() => textOf().includes('"total": "250.00"'), 'the details, on the second click');
  equal(calls.filter((c) => c.path === `/api/audit-trail/${AU1}`).length, 2, 'asked twice');
  await unmount();
});

// Wave 5: an entry with words of its own (AuditLogRow.summary, lib/services/auditTrail.ts: a person's
// approval of an agent's reveal, or "Details hidden ..." for a reader who may not see it) shows them
// in the list and at the top of its details, as text. Every other row is as it was.
domTest("the audit trail shows an entry's own words in the list and in its details", async () => {
  const REVEAL_ID = '0b5e2c1a-1111-4aaa-8bbb-000000000003';
  const HIDDEN_ID = '0b5e2c1a-1111-4aaa-8bbb-000000000004';
  // The agent's name is data: it is shown as typed, never read as markup.
  const REVEALED = 'Revealed full SSNs and tax IDs of "Show employee Dana Reyes" to agent "Helper <b>bold</b>", approved by Pat Owner.';
  const HIDDEN = 'Revealed full SSNs and tax IDs to an agent. Details hidden. An Admin, or someone who may view Employees & Payroll, can see them.';
  const DECISION = { action: 'update', entityType: 'agent_permission_request', entityId: 'r9', actorName: 'Pat Owner', actorId: 'u1', createdAt: '2026-11-21T09:00:00.000Z' };
  const REVEAL_ROW = { ...DECISION, id: REVEAL_ID, summary: REVEALED };
  const HIDDEN_ROW = { ...DECISION, id: HIDDEN_ID, entityId: 'r8', summary: HIDDEN };
  const calls = stubFetch({
    'GET /api/audit-trail': { rows: [REVEAL_ROW, HIDDEN_ROW, AUDIT_ROW], total: 3 },
    [`GET /api/audit-trail/${REVEAL_ID}`]: { ...REVEAL_ROW, oldValues: { status: 'pending' }, newValues: { status: 'approved', revealed: REVEALED } },
  });
  await mount(<AuditTrailPage />);
  const row = await until(() => $(`tr[data-audit-row="${REVEAL_ID}"]`), 'the decision in the list');
  equal(textOf($('[data-audit-summary]', row)), REVEALED, 'the reveal in words, in the list');
  check(!$('[data-audit-summary] b'), 'as text, never markup');
  equal(textOf($('[data-audit-summary]', $(`tr[data-audit-row="${HIDDEN_ID}"]`) ?? document)), HIDDEN, "and for a reader who may not see it, the server's hidden words");
  check(!$('[data-audit-summary]', $(`tr[data-audit-row="${AU1}"]`) ?? document), 'an entry without words of its own is as it was');

  await click(row, 'the decision');
  const words = await until(() => $('[data-audit-summary-detail]'), 'the words at the top of the details');
  equal(textOf(words), REVEALED, 'the same words head the details');
  await until(() => textOf().includes('"status": "approved"'), 'with what it recorded');
  equal(calls.filter((c) => c.path === `/api/audit-trail/${REVEAL_ID}`).length, 1, 'the entry was asked for once');
  await unmount();
});

void runDomTests();
