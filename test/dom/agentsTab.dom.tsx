// Users & Roles > Agents (app/users/AgentsTab.tsx), in a real browser window: the list never shows
// a token; New agent asks for a name, roles (Admin with a plain warning, plan D1) and a preset
// ("Ask for every change" unless another is chosen, D2), sends exactly that, and shows the token
// once with the settings to paste; Remove asks first; another computer only looks.
//
// The agent's detail page (app/users/agents/, plan 7.1): the policy grid with its locked cells,
// per-area overrides, limits, a save that sends only what changed, standing permissions with
// Revoke, the activity with its links, and Pause / Resume.
import * as React from 'react';
import AgentsTab from '@/app/users/AgentsTab';
import { Toaster } from '@/components/ui';
import { PRESET_DEFAULTS } from '@/lib/agent/policy';
import { $, $$, button, check, click, domTest, equal, focus, mount, reply, runDomTests, stubFetch, textOf, typeText, unmount, until, type FetchCall } from './kit';

const ROLES = [
  { key: 'admin', name: 'Admin', description: 'Everything.', builtin: true },
  { key: 'bookkeeper', name: 'Bookkeeper', description: 'Day-to-day entries.', builtin: true },
  { key: 'view_only', name: 'View-Only', description: 'Look at everything.', builtin: true },
];
const TOKEN = `ibka_0123abcd_${'T'.repeat(43)}`;
const CONNECTION = { command: 'C:\\Apps\\Ironbooks\\Ironbooks.exe', args: ['C:\\Apps\\Ironbooks\\resources\\mcp\\ironbooks-mcp.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' }, tokenEnv: 'IRONBOOKS_AGENT_TOKEN', installed: true };
const READER = { id: 'a1', name: 'Month-end helper', roleNames: ['Bookkeeper'], mode: 'read_only', tokenPrefix: 'ibka_0123abcd_Tabc', createdAt: '2026-11-01T15:00:00.000Z', createdByName: 'Pat Owner', lastUsedAt: '2026-11-18T14:30:00.000Z', status: 'active' };
const GONE = { id: 'a0', name: 'Old helper', roleNames: [], mode: 'post', tokenPrefix: 'ibka_0123abcd_Zzzz', createdAt: '2026-10-01T15:00:00.000Z', createdByName: null, lastUsedAt: null, status: 'revoked' };

const page = () => (
  <div>
    <Toaster />
    <AgentsTab roles={ROLES} />
  </div>
);
const dialog = () => $('[role="dialog"]');

domTest('the list shows each agent, its role and last use, and never a token', async () => {
  stubFetch({ 'GET /api/agents': { agents: [READER, GONE], hostOnly: false, connection: CONNECTION } });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  const text = textOf();
  check(text.includes('Bookkeeper') && text.includes('Read only'), `role and mode are shown: ${text}`);
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
  const calls = stubFetch({
    'GET /api/agents': () => ({ agents: made ? [READER] : [], hostOnly: false, connection: CONNECTION }),
    'POST /api/agents': () => {
      made = true;
      return reply(201, { agent: READER, token: TOKEN, connection: CONNECTION });
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
  check(warning.includes('can ask for anything an Admin can do'), `the warning says it can ask for anything an Admin can do: ${warning}`);
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
  const NIGHT = { ...READER, id: 'a2', name: 'Night closer', mode: 'post', unattended: true };
  const STARTS = { ...CONNECTION, env: { ...CONNECTION.env, IRONBOOKS_AGENT_START: '1' } };
  let made = false;
  const calls = stubFetch({
    'GET /api/agents': () => ({ agents: made ? [READER, NIGHT] : [READER], hostOnly: false, connection: CONNECTION }),
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
  const NIGHT = { ...READER, id: 'a2', name: 'Night closer', mode: 'post', unattended: true };
  const calls = stubFetch({
    'GET /api/agents': { agents: [NIGHT], hostOnly: false, connection: CONNECTION, unattendedPossible: false },
    'POST /api/agents': reply(201, { agent: READER, token: TOKEN, connection: CONNECTION }),
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
  stubFetch({
    'GET /api/agents': { agents: [], hostOnly: false, connection: CONNECTION },
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
  const calls = stubFetch({
    'GET /api/agents': () => ({ agents: [removed ? { ...READER, status: 'revoked' } : READER], hostOnly: false, connection: CONNECTION }),
    'DELETE /api/agents/a1': () => {
      removed = true;
      return { agent: { ...READER, status: 'revoked' } };
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
  stubFetch({ 'GET /api/agents': { agents: [READER], hostOnly: true, connection: null } });
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

/** AgentDetail (lib/agent/contract.ts) for READER, "Ask for every change" unless told, with `overrides` on top. */
function detailOf(
  opts: { overrides?: Override[]; paused?: boolean; bulkCap?: number | null; preset?: keyof typeof PRESET_DEFAULTS; locked?: typeof LOCKED } = {},
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
        folders: ['C:\\Receipts'],
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
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
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
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
    'GET /api/agents/a1': () => detailOf({ overrides: saved }),
    'PATCH /api/agents/a1': (c: FetchCall) => {
      const body = c.body as { overrides?: Override[]; bulkCap?: number };
      saved = body.overrides ?? saved;
      return detailOf({ overrides: saved, bulkCap: body.bulkCap ?? null });
    },
  });
  await openDetail(calls);
  check(button('Save changes')?.disabled, 'Save waits for a change');

  // Everywhere: Enter new to Allow; Change to Allow and back to Ask (the preset's own: no change).
  await click(cell('everywhere', 'enter', 'allow'), 'Enter new: Allow');
  await click(cell('everywhere', 'change', 'allow'), 'Change or void: Allow');
  await click(cell('everywhere', 'change', 'ask'), 'Change or void: Ask');
  check(textOf().includes('Changed from the preset'), 'the changed row is marked');
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

domTest('standing permissions: Revoke takes one back at once', async () => {
  let revoked = false;
  const GRANT = {
    id: 'g1',
    agentId: 'a1',
    operation: 'invoices.create',
    constraints: { maxAmount: '500.00', maxUses: 10 },
    givenBy: 'u1',
    expiresAt: '2026-11-20T23:59:00.000Z',
    revokedAt: null,
    uses: 2,
    agentName: 'Month-end helper',
    operationLabel: 'Enter an invoice',
    class: 'enter',
    givenByName: 'Pat Owner',
    createdAt: '2026-11-20T09:00:00.000Z',
    maxUses: 10,
  };
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
    'GET /api/agents/a1': detailOf(),
    'GET /api/agents/a1/grants': () => ({ grants: revoked ? [] : [GRANT] }),
    'DELETE /api/agent-grants/g1': () => {
      revoked = true;
      return { ok: true };
    },
  });
  await openDetail(calls);
  await click(button('Standing permissions'), 'Standing permissions');
  await until(() => textOf().includes('Enter an invoice'), 'the standing permission');
  const text = textOf();
  check(text.includes('Pat Owner') && text.includes('up to 500.00') && text.includes('2 of 10'), `who gave it, what holds it, how often used: ${text}`);
  await click(button('Revoke'), 'Revoke');
  await until(() => textOf().includes('No standing permissions.'), 'the list without it');
  equal(calls.filter((c) => c.method === 'DELETE').map((c) => c.path).join(','), '/api/agent-grants/g1', 'the grant route, once');
  await unmount();
});

domTest('Pause and Resume call the pause route, and Remove asks first', async () => {
  let removed = false;
  const calls = stubFetch({
    'GET /api/agents': () => ({ agents: [removed ? { ...READER, status: 'revoked' } : READER], hostOnly: false, connection: CONNECTION }),
    'GET /api/agents/a1': detailOf(),
    'POST /api/agents/a1/pause': (c: FetchCall) => detailOf({ paused: (c.body as { paused: boolean }).paused }),
    'DELETE /api/agents/a1': () => {
      removed = true;
      return { agent: { ...READER, status: 'revoked' } };
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
  stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
    'GET /api/agents/a1': detailOf(),
    'GET /api/agents/a1/activity': {
      activity: [
        { at: '2026-11-20T10:00:00.000Z', kind: 'request', operation: 'invoices.email', summary: 'Email invoice 1042 to billing@acme.com', class: 'outside', status: 'pending', approvedByName: null, auditId: null, requestId: 'r1' },
        { at: '2026-11-20T09:00:00.000Z', kind: 'operation', operation: 'invoices.create', summary: 'Added invoice', class: 'enter', status: 'done', approvedByName: 'Pat Owner', auditId: 'au1', requestId: null },
      ],
    },
  });
  await openDetail();
  await click(button('Activity'), 'Activity');
  await until(() => textOf().includes('Email invoice 1042'), 'the activity');
  const text = textOf();
  check(text.includes('Added invoice') && text.includes('Pat Owner') && text.includes('Waiting') && text.includes('Done'), `each row with its outcome: ${text}`);
  check($('a[href="/agent-requests?id=r1"]'), 'a request links to the approval center');
  check($('a[href="/audit-trail?id=au1"]'), 'an operation links to the audit trail');
  // Named for what it opens today: the approval center does not filter by agent yet (review).
  equal(textOf($('a[href="/agent-requests?agentId=a1"]')), 'Approval center', 'and the approval center is one click away');
  await unmount();
});

domTest('the list marks an adjusted preset, and every agent as paused while Integrated Applications is off', async () => {
  // The list route does not say yet, so the count route does.
  stubFetch({
    'GET /api/agents': { agents: [{ ...READER, preset: 'read_only', overrideCount: 2 }], hostOnly: false, connection: CONNECTION },
    'GET /api/agent-requests/count': { pending: 0, newest: null, agents: 1, allPaused: true, canPauseAll: true },
  });
  await mount(page());
  await until(() => textOf().includes('Month-end helper'), 'the agents');
  await until(() => $('[data-all-paused]'), 'the note that every agent is paused');
  const text = textOf();
  check(text.includes('Read only (adjusted: 2 changes)'), `the preset says it was adjusted: ${text}`);
  check(text.includes('Every agent is paused') && text.includes('Integrated Applications'), 'the note says why');
  check(text.includes('Paused') && text.includes('All agents') && !text.includes('Active'), `the agent is shown paused: ${text}`);
  await unmount();

  // The list route's own answer wins, and then the count is not asked.
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION, allPaused: false },
    'GET /api/agent-requests/count': { pending: 0, newest: null, agents: 1, allPaused: true, canPauseAll: true },
  });
  await mount(page());
  await until(() => textOf().includes('Active'), 'the agent shown active');
  check(!$('[data-all-paused]'), 'no note');
  equal(calls.filter((c) => c.path === '/api/agent-requests/count').length, 0, 'the count route is not asked');
  await unmount();
});

domTest('picking a stricter preset says which changes still let the agent do more, and takes them away on request', async () => {
  const OVERRIDES: Override[] = [
    { class: 'enter', area: null, setting: 'allow' },
    { class: 'bulk', area: null, setting: 'never' },
  ];
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
    'GET /api/agents/a1': detailOf({ overrides: OVERRIDES }),
    'PATCH /api/agents/a1': (c: FetchCall) => {
      const body = c.body as { preset?: 'read_only'; overrides?: Override[] };
      return detailOf({ preset: body.preset, overrides: body.overrides ?? OVERRIDES });
    },
  });
  await openDetail(calls);
  check(textOf($('[data-preset-summary]')).includes('Ask for every change (adjusted: 2 changes)'), 'the header says the preset was adjusted');
  check(!$('[data-looser-note]'), 'no note before another preset is picked');

  await click($('input[name="ag-detail-preset"][value="read_only"]'), 'Read only');
  const note = await until(() => $('[data-looser-note]'), 'the note');
  const said = textOf(note);
  check(said.includes('"Read only" is chosen') && said.includes('Enter new: Allow'), `it names the looser change: ${said}`);
  check(!said.includes('Change many at once'), 'and only that one');
  check(cell('everywhere', 'enter', 'allow')?.checked, 'the grid still shows it');

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
  await until(() => textOf($('[data-preset-summary]')).includes('Read only (adjusted: 1 change)'), 'the header after the save');
  await unmount();
});

domTest('an Allow the engine never gives stays locked even when the server list leaves it out', async () => {
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
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
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
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
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: false, connection: CONNECTION },
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
  await unmount();
});

domTest('on another computer the detail only shows the policy, and the agent can still be paused', async () => {
  const calls = stubFetch({
    'GET /api/agents': { agents: [READER], hostOnly: true, connection: null },
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

void runDomTests();
