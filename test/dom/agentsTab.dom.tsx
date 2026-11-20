// Users & Roles > Agents (app/users/AgentsTab.tsx), in a real browser window: the list never shows
// a token; New agent asks for a name, a role (never Admin) and a mode, sends exactly that, and
// shows the token once with the settings to paste; Remove asks first; another computer only looks.
import * as React from 'react';
import AgentsTab from '@/app/users/AgentsTab';
import { Toaster } from '@/components/ui';
import { $, $$, button, check, click, domTest, equal, focus, mount, reply, runDomTests, stubFetch, textOf, typeText, unmount, until } from './kit';

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

domTest('New agent: name, role (never Admin) and mode are sent, and the token is shown once', async () => {
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

  await click(button(/New agent/), 'New agent');
  const d = await until(dialog, 'the New agent dialog');
  const roleNames = $$('label', d).map((l) => textOf(l));
  check(roleNames.some((r) => r.startsWith('Bookkeeper')), 'Bookkeeper is offered');
  check(!roleNames.some((r) => r.startsWith('Admin')), `Admin is not offered: ${roleNames.join(' | ')}`);
  check(textOf(d).includes('What an agent reads is sent to the AI service that runs it'), 'the dialog says where what it reads goes');
  const make = button('Make agent', d);
  check(make?.disabled, 'Make agent waits for a name and a role');

  await focus($('#ag-name', d), 'the name field');
  await typeText('Month-end helper');
  await click($$<HTMLInputElement>('input[type="checkbox"]', d).find((c) => textOf(c.closest('label')).startsWith('Bookkeeper')) ?? null, 'the Bookkeeper role');
  const modes = $$<HTMLInputElement>('input[type="radio"]', d);
  equal(modes.length, 3, 'Read only, Propose and Post');
  check(modes[0].checked, 'Read only is the starting choice');
  check(!button('Make agent', d)?.disabled, 'Make agent is ready');
  await click(button('Make agent', d), 'Make agent');

  const once = await until(() => (textOf(dialog()).includes('is ready') ? dialog() : null), 'the token dialog');
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ name: 'Month-end helper', roleKeys: ['bookkeeper'], mode: 'read_only', unattended: false }), 'what was sent');
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
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ name: 'Night closer', roleKeys: ['bookkeeper'], mode: 'read_only', unattended: true }), 'what was sent');
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
  equal(JSON.stringify(calls.find((c) => c.method === 'POST')?.body), JSON.stringify({ name: 'Helper', roleKeys: ['bookkeeper'], mode: 'read_only', unattended: false }), 'what was sent');
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

void runDomTests();
