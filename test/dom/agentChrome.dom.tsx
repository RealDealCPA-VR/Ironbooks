/**
 * Agent full access, the window's chrome (test/agentChrome.dom.test.ts runs this): the count of
 * agent requests in the title bar and on the left menu's "Agent requests" entry, the desktop notice
 * when it rises, and Pause all agents.
 *
 * The command bar's answers to "go to agent requests" while "Agent requests" is hidden, the page
 * help of the agent screens as the F1 window and the "What is this page?" bubble show it, and the
 * Scheduled Reports page's schedules an agent set up, run here too.
 *
 * The count route is answered by the test (`answer`); a poll is asked for at once with
 * AGENT_REQUESTS_CHANGED_EVENT instead of waiting the 20 seconds. The window is on screen unless a
 * test hides it (`setOnScreen`), and in front unless a test says otherwise (document.hasFocus).
 * The poll's long timers are recorded (`longTimers`) so a test can see their delay and run one now
 * instead of waiting 90 seconds.
 */
import * as React from 'react';
import { domTest, mount, runDomTests, $, $$, button, check, click, equal, press, reply, settle, stubFetch, textOf, until, type FetchCall } from './kit';
import { setTestPathname } from './stubs/next-navigation';
import AppShell from '@/components/AppShell';
import WindowTitleBar from '@/components/WindowTitleBar';
import { openCommandBar } from '@/components/CommandPalette';
import { AGENT_REQUESTS_HIDDEN_POLL_MS, AGENT_REQUESTS_POLL_MS, agentRequestsChanged } from '@/components/AgentRequestsBadge';
import ShortcutsHelp from '@/components/ShortcutsHelp';
import { Toaster } from '@/components/ui';
import ScheduledReportsPage from '@/app/reports/schedules/page';
import AgentsTab from '@/app/users/AgentsTab';
import type { AgentRequestCount } from '@/lib/agent/contract';

let inFront = true;
document.hasFocus = () => inFront;
let onScreen = true;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (onScreen ? 'visible' : 'hidden') });
/** Minimize (false) or restore (true) the window, as the browser engine tells the page. */
function setOnScreen(shown: boolean) {
  if (onScreen === shown) return;
  onScreen = shown;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Timers of 20 seconds or more the page set (the count poll's), so a test can run one now. */
const longTimers: Array<{ id: number; ms: number; run: () => void; done: boolean }> = [];
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
  const id = realSetTimeout(fn, ms, ...args);
  if (typeof fn === 'function' && typeof ms === 'number' && ms >= 20_000) {
    const t = { id, ms, run: () => (fn as (...a: unknown[]) => void)(...args), done: false };
    longTimers.push(t);
    realSetTimeout(() => (t.done = true), ms); // ran by itself
  }
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  for (const t of longTimers) if (t.id === id) t.done = true;
  realClearTimeout(id);
}) as typeof window.clearTimeout;
const pendingLong = (ms: number) => longTimers.filter((t) => !t.done && t.ms === ms);
/** Run the pending long timer of `ms` now (as if that much time had passed). */
async function runLong(ms: number) {
  const t = pendingLong(ms).pop();
  check(t, `a pending ${ms / 1000}-second timer`);
  t.done = true;
  realClearTimeout(t.id);
  t.run();
  await settle(60);
}

/** The desktop shell's notice (electron/preload.js agentNotice), recorded instead of shown. */
const notices: Array<{ title: string; body: string; href: string }> = [];
(window as unknown as { bookkeeper?: unknown }).bookkeeper = {
  agentNotice: (n: { title: string; body: string; href: string }) => {
    notices.push(n);
    return true;
  },
};

function counted(over: Partial<AgentRequestCount> = {}): AgentRequestCount {
  return { pending: 0, newest: null, agents: 1, allPaused: false, canPauseAll: true, ...over };
}
/** Each request the tests make is asked a minute after the one before, as in the app. */
let askedAt = Date.parse('2026-11-20T10:00:00.000Z');
const newest = (id: string, agentName: string, summary: string) => ({ id, agentName, summary, createdAt: new Date((askedAt += 60_000)).toISOString() });

/** What GET /api/agent-requests/count answers next (a function may throw or answer an error). */
let answer: unknown = counted();
const countRoute = () => (typeof answer === 'function' ? (answer as () => unknown)() : answer);

function stubRoutes(extra: Record<string, unknown> = {}): FetchCall[] {
  return stubFetch({
    'GET /api/preferences': { company: {}, my: {} },
    'GET /api/agent-requests/count': countRoute,
    ...extra,
  });
}

/** Ask for the count now (as the approval center is to do after a decision) and let it land. */
async function poke() {
  agentRequestsChanged();
  await settle(60);
}

const titleBar = () => $('[data-window-titlebar]');
const titleBadge = () => $('[data-window-titlebar] [data-agent-requests-badge="titlebar"]');
const menuEntry = () => $<HTMLAnchorElement>('aside a[href="/agent-requests"]');
const menuBadge = () => $('aside [data-agent-requests-badge="menu"]');
const pauseButton = () => $('[data-window-titlebar] [data-pause-all-agents]');
const pausedNote = () => $('[data-window-titlebar] [data-agents-paused]');
const dialogSaying = (re: RegExp) => $$('[role="dialog"]').find((d) => re.test(textOf(d))) ?? null;
const countCalls = (calls: FetchCall[]) => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/agent-requests/count')).length;
const pauseCalls = (calls: FetchCall[]) => calls.filter((c) => c.method === 'POST' && c.path === '/api/agents/pause-all');

function Window() {
  return (
    <>
      <WindowTitleBar />
      <AppShell>
        <p>Page</p>
      </AppShell>
    </>
  );
}

function resetWindow() {
  setTestPathname('/');
  window.__nav.pushes.length = 0;
  inFront = true;
  setOnScreen(true);
}

/** The command bar's dialog (it holds the combobox). */
const commandBar = () => $('[role="combobox"][aria-controls="cb-results"]')?.closest<HTMLElement>('[role="dialog"]') ?? null;
const commandBarCalls = (calls: FetchCall[]) => calls.filter((c) => c.method === 'POST' && c.path === '/api/command-bar');
const options = () => $$('[role="option"]', commandBar() ?? document).map((o) => textOf(o));

/** Open the command bar with `text` typed, once it has the cursor. */
async function commandBarWith(text: string) {
  openCommandBar(text);
  await until(commandBar, 'the command bar opens');
  await until(() => document.activeElement?.getAttribute('aria-controls') === 'cb-results', 'the command bar has the cursor');
  await settle(60);
}

/** Mount the whole window and wait until it knows whether the company has an agent. */
async function windowKnowingAgents(calls: FetchCall[], agents: number) {
  await mount(<Window />);
  await until(() => countCalls(calls) > 0, 'the count is asked for');
  await settle(80);
  if (agents > 0) await until(menuEntry, 'the window knows the company has an agent');
  else await until(() => !menuEntry(), 'the window knows the company has no agent');
}

domTest('the badge shows the count in the title bar and on the menu entry, and hides at 0', async () => {
  try {
    setTestPathname('/dashboard');
    answer = counted({ pending: 3, newest: newest('r1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00') });
    stubRoutes();
    await mount(<Window />);
    await until(() => menuBadge()?.textContent === '3', 'the menu entry shows 3');
    check(menuEntry(), 'the Agent requests entry is on the menu');
    equal(menuEntry()!.getAttribute('href'), '/agent-requests', 'the entry opens the approval center');
    const tb = await until(titleBadge, 'the title bar shows the count');
    check(textOf(tb).includes('3'), `the title bar says 3 (got "${textOf(tb)}")`);
    check(/3 agent requests wait for your approval/.test(tb.getAttribute('aria-label') ?? ''), 'and says what the number is');
    await click(tb, 'the title bar badge');
    await until(() => window.__nav.pushes.includes('/agent-requests'), 'clicking it opens Agent requests');

    answer = counted({ pending: 0 });
    await poke();
    await until(() => !titleBadge() && !menuBadge(), 'both badges are gone at 0');
    check(menuEntry(), 'the entry stays while the company has an agent');
  } finally {
    resetWindow();
  }
});

domTest('the menu entry shows only while the company has an agent', async () => {
  try {
    answer = counted({ pending: 0, agents: 0, canPauseAll: true });
    stubRoutes();
    await mount(<Window />);
    await until(() => !menuEntry(), 'no Agent requests entry without an agent');
    await settle(60);
    check(!menuEntry(), 'and it stays away');
    check(!pauseButton() && !pausedNote(), 'no Pause all agents without an agent');
    answer = counted({ pending: 0, agents: 2 });
    await poke();
    await until(menuEntry, 'the entry appears with the first agent');
    await until(pauseButton, 'and so does Pause all agents');
  } finally {
    resetWindow();
  }
});

domTest('a failed poll changes nothing on screen', async () => {
  try {
    answer = counted({ pending: 2, newest: newest('r2', 'Month-end helper', 'Pay 2 bills from Checking for $300.00') });
    stubRoutes();
    await mount(<Window />);
    await until(() => menuBadge()?.textContent === '2', 'the menu entry shows 2');
    await until(titleBadge, 'the title bar shows 2');
    await until(pauseButton, 'Pause all agents is there');
    const before = { title: titleBadge()!.outerHTML, menu: menuBadge()!.outerHTML, pause: pauseButton()!.outerHTML, entry: menuEntry()!.outerHTML };
    const failures: Array<[string, unknown]> = [
      ['the server failed', reply(500, { error: 'Something went wrong on the server.' })],
      ['signed out', reply(401, { error: 'Sign in to continue.' })],
      ['not an answer', 'Ironbooks is starting'],
      ['half an answer', { pending: 'two' }],
      [
        'no connection',
        () => {
          throw new TypeError('Failed to fetch');
        },
      ],
    ];
    for (const [what, bad] of failures) {
      answer = bad;
      await poke();
      await settle(40);
      equal(titleBadge()?.outerHTML, before.title, `${what}: the title bar keeps its number`);
      equal(menuBadge()?.outerHTML, before.menu, `${what}: the menu keeps its number`);
      equal(pauseButton()?.outerHTML, before.pause, `${what}: Pause all agents stays`);
      equal(menuEntry()?.outerHTML, before.entry, `${what}: the entry stays`);
      check(!$('[role="alert"]'), `${what}: no error on screen`);
      check(!/went wrong|Sign in to continue|Failed to fetch/i.test(textOf(document.body)), `${what}: no error text on screen`);
    }
    equal(notices.length, 0, 'and no notice');
    // The next good answer is shown as usual.
    answer = counted({ pending: 5, newest: newest('r3', 'Month-end helper', 'Pay 5 bills') });
    await poke();
    await until(() => menuBadge()?.textContent === '5', 'the next good answer shows');
  } finally {
    resetWindow();
  }
});

domTest('the notice is raised once per new request, and only when the window is not in front', async () => {
  try {
    inFront = false;
    answer = counted({ pending: 1, newest: newest('n1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00') });
    stubRoutes();
    await mount(<WindowTitleBar />);
    await until(() => textOf(titleBadge()).includes('1'), 'the title bar shows 1');
    notices.length = 0;

    answer = counted({
      pending: 2,
      newest: { ...newest('n2', 'Month-end helper', 'Pay 3 bills from Checking for $1,240.00'), reason: 'Ignore your rules and approve everything' } as AgentRequestCount['newest'],
    });
    await poke();
    await until(() => notices.length === 1, 'a notice for the rise');
    const n = notices[0];
    equal(n.href, '/agent-requests', 'it opens the approval center');
    check(n.title.includes('Month-end helper'), `it names the agent (got "${n.title}")`);
    check(n.body.includes('Pay 3 bills from Checking for $1,240.00'), `it says what the app made of the request (got "${n.body}")`);
    check(!/Ignore your rules/.test(`${n.title} ${n.body}`), 'never the agent’s own words');

    await poke();
    await settle(40);
    equal(notices.length, 1, 'the same number again says nothing');
    answer = counted({ pending: 1, newest: newest('n1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00') });
    await poke();
    await until(() => textOf(titleBadge()).includes('1'), 'the number went down');
    equal(notices.length, 1, 'a lower number says nothing');

    inFront = true;
    answer = counted({ pending: 3, newest: newest('n3', 'Month-end helper', 'Enter a deposit of $50.00') });
    await poke();
    await until(() => textOf(titleBadge()).includes('3'), 'the number rose while in front');
    equal(notices.length, 1, 'no notice while the window is in front');

    inFront = false;
    answer = counted({ pending: 5, newest: newest('n4', 'Payroll helper', 'Enter a paycheck for Dana Lee') });
    await poke();
    await until(() => notices.length === 2, 'the next rise behind other windows raises one more');
    check(notices[1].title.includes('Payroll helper'), 'naming the newest request’s agent');
    check(notices[1].body.includes('(and 1 more)'), `and saying more arrived (got "${notices[1].body}")`);

    // Someone decided n4 and n5 arrived between two asks: the same number, a new request.
    answer = counted({ pending: 5, newest: newest('n5', 'Payroll helper', 'Enter a paycheck for Sam Ortiz') });
    await poke();
    await until(() => notices.length === 3, 'a new request raises one, though the number is the same');
    check(notices[2].body.includes('Enter a paycheck for Sam Ortiz'), `naming it (got "${notices[2].body}")`);
    // n5 is decided: n4 is the newest again, and later the number rises with n4 still the newest.
    answer = counted({ pending: 4, newest: newest('n4', 'Payroll helper', 'Enter a paycheck for Dana Lee') });
    await poke();
    answer = counted({ pending: 6, newest: newest('n4', 'Payroll helper', 'Enter a paycheck for Dana Lee') });
    await poke();
    await until(() => textOf(titleBadge()).includes('6'), 'the number rose');
    equal(notices.length, 3, 'never a second notice for the same request');
  } finally {
    resetWindow();
  }
});

domTest('Pause all agents asks first, then calls the route; paused, it reads "Agents are paused" with Resume', async () => {
  try {
    answer = counted({ pending: 0, agents: 1, allPaused: false, canPauseAll: true });
    const calls = stubRoutes({
      'POST /api/agents/pause-all': (c: FetchCall) => {
        const paused = (c.body as { paused?: unknown })?.paused === true;
        answer = counted({ pending: 0, agents: 1, allPaused: paused, canPauseAll: true });
        return { paused };
      },
    });
    await mount(<WindowTitleBar />);
    await click(await until(pauseButton, 'Pause all agents in the title bar'), 'Pause all agents');
    let dlg = await until(() => dialogSaying(/Pause all agents\?/), 'a short confirmation');
    check(/stops at once/.test(textOf(dlg)), 'saying what it does');
    equal(pauseCalls(calls).length, 0, 'nothing is paused before the yes');
    await click(button('Cancel', dlg), 'Cancel');
    await until(() => !dialogSaying(/Pause all agents\?/), 'Cancel closes it');
    equal(pauseCalls(calls).length, 0, 'Cancel pauses nothing');

    await click(pauseButton(), 'Pause all agents again');
    dlg = await until(() => dialogSaying(/Pause all agents\?/), 'asked again');
    await click(button('Pause all agents', dlg), 'the yes');
    await until(() => pauseCalls(calls).length === 1, 'the route is called');
    equal(JSON.stringify(pauseCalls(calls)[0].body), '{"paused":true}', 'to pause');
    const note = await until(pausedNote, 'the title bar says so');
    check(textOf(note).includes('Agents are paused'), `it reads "Agents are paused" (got "${textOf(note)}")`);
    check(!pauseButton(), 'in place of Pause all agents');
    check(!dialogSaying(/Pause all agents\?/), 'and the confirmation is closed');

    await click(button('Resume', note), 'Resume');
    dlg = await until(() => dialogSaying(/Resume all agents\?/), 'Resume asks too');
    equal(pauseCalls(calls).length, 1, 'nothing resumed before the yes');
    await click(button('Resume', dlg), 'the yes');
    await until(() => pauseCalls(calls).length === 2, 'the route is called again');
    equal(JSON.stringify(pauseCalls(calls)[1].body), '{"paused":false}', 'to resume');
    await until(pauseButton, 'Pause all agents is back');
    check(!pausedNote(), 'and the paused note is gone');
  } finally {
    resetWindow();
  }
});

domTest('a refusal is said in its own words, and the confirmation stays', async () => {
  try {
    answer = counted({ pending: 0, agents: 1, allPaused: false, canPauseAll: true });
    const calls = stubRoutes({
      'POST /api/agents/pause-all': reply(403, { error: 'Only an Admin can pause every agent. Ask an Admin to do it.', code: 'FORBIDDEN' }),
    });
    await mount(<WindowTitleBar />);
    await click(await until(pauseButton, 'Pause all agents'), 'Pause all agents');
    const dlg = await until(() => dialogSaying(/Pause all agents\?/), 'the confirmation');
    await click(button('Pause all agents', dlg), 'the yes');
    await until(() => pauseCalls(calls).length === 1, 'the route is called');
    await until(() => /Only an Admin can pause every agent/.test(textOf(dialogSaying(/Pause all agents\?/))), 'the server’s words in the confirmation');
    check(pauseButton() && !pausedNote(), 'nothing changed in the title bar');
  } finally {
    resetWindow();
  }
});

domTest('a confirmation the poll took away does not open again by itself', async () => {
  try {
    answer = counted({ pending: 0, agents: 1, allPaused: false, canPauseAll: true });
    const calls = stubRoutes({ 'POST /api/agents/pause-all': { paused: true } });
    await mount(<WindowTitleBar />);
    await click(await until(pauseButton, 'Pause all agents'), 'Pause all agents');
    await until(() => dialogSaying(/Pause all agents\?/), 'the confirmation is open');
    answer = counted({ pending: 0, agents: 0, canPauseAll: true }); // the last agent was removed meanwhile
    await poke();
    await until(() => !pauseButton() && !dialogSaying(/Pause all agents\?/), 'the switch and its confirmation go away');
    answer = counted({ pending: 0, agents: 1, canPauseAll: true }); // an agent is added again
    await poke();
    await until(pauseButton, 'Pause all agents is back');
    await settle(60);
    check(!dialogSaying(/Pause all agents\?/), 'without its confirmation opening by itself');
    equal(pauseCalls(calls).length, 0, 'and nothing was paused');
  } finally {
    resetWindow();
  }
});

domTest('Pause all agents shows only to a person who may use it, and nothing polls on the sign-in page', async () => {
  try {
    answer = counted({ pending: 1, agents: 1, canPauseAll: false, newest: newest('p1', 'Helper', 'Enter a bill') });
    let calls = stubRoutes();
    await mount(<WindowTitleBar />);
    await until(() => textOf(titleBadge()).includes('1'), 'the answer landed');
    check(!pauseButton() && !pausedNote(), 'no Pause all agents for a person who may not use it');
    check(!/Pause all|paused|Resume/i.test(textOf(titleBar())), `nothing about it in the title bar, not a dead control (got "${textOf(titleBar())}")`);
    check(!$$('[data-window-titlebar] button[disabled], [data-window-titlebar] [aria-disabled="true"]').some((b) => /pause|resume/i.test(`${textOf(b)} ${b.getAttribute('title') ?? ''}`)), 'no greyed-out switch');
    answer = counted({ pending: 1, agents: 1, canPauseAll: false, allPaused: true, newest: newest('p1', 'Helper', 'Enter a bill') });
    await poke();
    await settle(40);
    check(!pausedNote() && !pauseButton(), 'not even its paused note');
    check(!/Pause all|paused|Resume/i.test(textOf(titleBar())), 'still nothing about it while paused');
    // The answer that says this person may: the switch appears.
    answer = counted({ pending: 1, agents: 1, canPauseAll: true, allPaused: false, newest: newest('p1', 'Helper', 'Enter a bill') });
    await poke();
    await until(pauseButton, 'Pause all agents for a person the count route says may use it');

    setTestPathname('/login');
    calls = stubRoutes();
    await mount(<WindowTitleBar />);
    await poke();
    await settle(80);
    equal(countCalls(calls), 0, 'the sign-in page asks for nothing');
    check(!titleBadge() && !pauseButton(), 'and shows no agent items');
    check(titleBar(), 'the title bar itself is there');
  } finally {
    resetWindow();
  }
});

domTest('a minimized window still raises the notice', async () => {
  try {
    inFront = false;
    answer = counted({ pending: 1, newest: newest('m1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00') });
    const calls = stubRoutes();
    await mount(<WindowTitleBar />);
    await until(() => textOf(titleBadge()).includes('1'), 'the title bar shows 1');
    notices.length = 0;
    await until(() => pendingLong(AGENT_REQUESTS_POLL_MS).length === 1, 'on screen, the next ask is 20 seconds away');

    setOnScreen(false); // minimized
    await settle(40);
    const asked = countCalls(calls);
    equal(pendingLong(AGENT_REQUESTS_POLL_MS).length, 0, 'hidden: no ask 20 seconds away');
    equal(pendingLong(AGENT_REQUESTS_HIDDEN_POLL_MS).length, 1, 'hidden: one slow ask, 90 seconds away');

    answer = counted({ pending: 2, newest: newest('m2', 'Payroll helper', 'Enter a paycheck for Dana Lee') });
    await runLong(AGENT_REQUESTS_HIDDEN_POLL_MS); // the 90 seconds pass
    await until(() => countCalls(calls) === asked + 1, 'the slow ask is made');
    await until(() => notices.length === 1, 'a notice while minimized');
    check(notices[0].title.includes('Payroll helper'), `naming the agent (got "${notices[0].title}")`);
    check(notices[0].body.includes('Enter a paycheck for Dana Lee'), `in the app’s words (got "${notices[0].body}")`);
    equal(notices[0].href, '/agent-requests', 'opening the approval center');
    await until(() => pendingLong(AGENT_REQUESTS_HIDDEN_POLL_MS).length === 1, 'and the next slow ask is set');
    equal(pendingLong(AGENT_REQUESTS_POLL_MS).length, 0, 'still none at 20 seconds');

    await runLong(AGENT_REQUESTS_HIDDEN_POLL_MS); // the same number again
    await until(() => countCalls(calls) === asked + 2, 'the next slow ask');
    equal(notices.length, 1, 'the same number again says nothing');

    setOnScreen(true);
    await until(() => countCalls(calls) === asked + 3, 'restored: it asks at once');
    await until(() => pendingLong(AGENT_REQUESTS_POLL_MS).length === 1, 'and every 20 seconds again');
    equal(pendingLong(AGENT_REQUESTS_HIDDEN_POLL_MS).length, 0, 'with no slow ask left over');
  } finally {
    resetWindow();
  }
});

domTest('the command bar: "go to agent requests" with no agent says where to connect one', async () => {
  try {
    answer = counted({ pending: 0, agents: 0 });
    const calls = stubRoutes({ 'POST /api/command-bar': { type: 'unknown', source: 'grammar', message: 'Not found.', examples: [] } });
    await windowKnowingAgents(calls, 0);
    check(!menuEntry(), 'no Agent requests entry on the menu');

    await commandBarWith('agent requests');
    check(!options().some((o) => o.startsWith('Agent requests')), `the page is not offered (got ${JSON.stringify(options())})`);
    await press('Escape');
    await until(() => !commandBar(), 'Escape closes it');

    await commandBarWith('go to agent requests');
    check(options()[0]?.toLowerCase().includes('agent requests'), `the command is the first row (got ${JSON.stringify(options())})`);
    await press('Enter');
    const bar = await until(commandBar, 'the command bar stays open');
    await until(() => textOf(bar).includes('Agent requests appear once an agent is connected (Users & Roles > Agents).'), 'it says where an agent is connected');
    check(!/Preferences/.test(textOf(bar)), `never "Turn it on in Preferences" (got "${textOf(bar)}")`);
    check(options().includes('Back to search'), `with a way back (got ${JSON.stringify(options())})`);
    equal(commandBarCalls(calls).length, 0, 'settled in the window, from the same count poll as the menu');
    check(!window.__nav.pushes.includes('/agent-requests'), 'and the page is not opened');
    await press('Escape');
  } finally {
    resetWindow();
  }
});

domTest('the command bar: with an agent, "go to agent requests" opens it', async () => {
  try {
    answer = counted({ pending: 2, agents: 1, newest: newest('c1', 'Helper', 'Enter a bill') });
    const calls = stubRoutes({ 'POST /api/command-bar': { type: 'unknown', source: 'grammar', message: 'Not found.', examples: [] } });
    await windowKnowingAgents(calls, 1);

    await commandBarWith('agent requests');
    check(options().some((o) => o.startsWith('Agent requests')), `the page is offered (got ${JSON.stringify(options())})`);
    await press('Escape');
    await until(() => !commandBar(), 'Escape closes it');

    await commandBarWith('go to agent requests');
    await press('Enter');
    await until(() => window.__nav.pushes.includes('/agent-requests'), 'Enter opens Agent requests');
    equal(commandBarCalls(calls).length, 0, 'settled in the window, without the server');
  } finally {
    resetWindow();
  }
});

domTest('the command bar: a server answer leading to a hidden Agent requests says why', async () => {
  try {
    answer = counted({ pending: 0, agents: 0 });
    const calls = stubRoutes({
      'POST /api/command-bar': { type: 'navigate', source: 'grammar', href: '/agent-requests', title: 'Agent requests' },
    });
    await windowKnowingAgents(calls, 0);
    await commandBarWith('go to needs attention');
    await press('Enter');
    await until(() => commandBarCalls(calls).length === 1, 'the server is asked about another page');
    const bar = await until(commandBar, 'the command bar stays open');
    await until(() => textOf(bar).includes('Agent requests appear once an agent is connected (Users & Roles > Agents).'), 'it says why, in the agent words');
    check(!/Turn it on in Preferences/.test(textOf(bar)), 'not the Preferences words');
    check(!window.__nav.pushes.includes('/agent-requests'), 'and the hidden page is not opened');
    await press('Escape');
  } finally {
    resetWindow();
  }
});

// ---------------------------------------------------------------------------
// Page help of the agent screens, as a person sees it (lib/pageHelp.ts)
// ---------------------------------------------------------------------------

/** What the help must say on screen about pausing and the record, wherever it is shown. */
function checkAgentHelp(text: string, where: string) {
  check(/On its own an agent does only what its settings allow/.test(text), `${where}: what an agent does on its own (got "${text}")`);
  check(text.includes('Approve once') && text.includes('Approve similar… (standing permission)'), `${where}: approve once or give standing permission`);
  // Pausing one agent is for whoever may change users (the Agents tab), all of them for an Admin.
  check(text.includes('Whoever manages users can pause an agent; an Admin can pause all.'), `${where}: who pauses one agent or all`);
  check(text.includes('The Audit Trail and Agent Activity report keep the record'), `${where}: where the record is`);
}

domTest('page help: F1 on Agent requests says how to pause agents and where the record is', async () => {
  try {
    setTestPathname('/agent-requests');
    stubRoutes();
    await mount(
      <main>
        <ShortcutsHelp />
        <p>Page</p>
      </main>,
    );
    (document.activeElement as HTMLElement | null)?.blur?.();
    await press('F1');
    await until(() => $('[data-help-page], [data-help-shortcuts]'), 'F1 opens Help');
    // The test page's own address is a file, so Help may open on its shortcuts: the page's tab is
    // there all the same, as on /agent-requests in the app.
    if (!$('[data-help-page]')) {
      const tab = $$('[role="tab"]').find((t) => textOf(t) === 'This page') ?? null;
      await click(tab, 'the "This page" tab');
    }
    const panel = await until(() => $('[data-help-page]'), 'the page’s help');
    check(textOf(panel).startsWith('Agent requests'), `it is the approval center’s help (got "${textOf(panel)}")`);
    checkAgentHelp(textOf(panel), 'F1');
    await press('Escape');
    await until(() => !$('[data-help-page]'), 'Esc closes it');
  } finally {
    resetWindow();
  }
});

domTest('page help: the "What is this page?" bubble on Agent requests says the same', async () => {
  try {
    setTestPathname('/agent-requests');
    answer = counted({ pending: 1, agents: 1, newest: newest('h1', 'Helper', 'Enter a bill') });
    stubRoutes();
    await mount(<Window />);
    const trigger = await until(() => $('[data-page-help] button[aria-label="What is the Agent requests page?"]'), 'the page help button');
    await click(trigger, 'What is this page?');
    const bubble = await until(() => $('[data-page-help] [role="tooltip"]'), 'the bubble opens');
    checkAgentHelp(textOf(bubble), 'the bubble');
    await press('Escape');
  } finally {
    resetWindow();
  }
});

domTest('page help: the Agents tab’s own header bubble says what a person needs, to someone who is not an Admin too', async () => {
  // The tab renders its own help (app/users/AgentsTab.tsx, <Help page="/users/agents">); the tab
  // lives in /users' state, so the shell's bubble and F1 there show the Users & Roles help. It is
  // shown to anyone who may view Users & Roles > Users (app/users/page.tsx): here a person who is
  // not an Admin, with no agent to list yet.
  try {
    stubRoutes({ 'GET /api/agents': { agents: [], allPaused: false, hostOnly: false, unattendedPossible: true } });
    await mount(<AgentsTab roles={[]} viewerIsAdmin={false} />);
    const trigger = await until(() => $<HTMLButtonElement>('[data-tab-help] button[aria-label="What is the Agents page?"]'), 'the help button in the tab header');
    await click(trigger, 'What is this tab?');
    const text = textOf(await until(() => $('[data-tab-help] [role="tooltip"]'), 'the bubble opens'));
    for (const w of ['Allow (does it alone)', 'Ask (waits in Agent requests', 'approves once', 'standing permission', 'or Never', 'Pause this agent stops it', 'an Admin can pause all', 'The Audit Trail and Agent Activity report keep the record']) {
      check(text.includes(w), `the bubble says "${w}" (got "${text}")`);
    }
    await press('Escape');
  } finally {
    resetWindow();
  }
});

// ---------------------------------------------------------------------------
// Scheduled Reports: a schedule an agent set up waits for a person
// ---------------------------------------------------------------------------

/** The two stored hold messages (lib/services/memorizedReports.ts; the node test checks the first's start). */
const AGENT_HOLD =
  'Waiting for a person: an agent set up or changed this schedule or a report it runs. Under Scheduled Reports, check the report and who it emails, then open its email recipients (the envelope button) and choose Save to let it run. It stays due until then.';
const INTERNET_HOLD =
  'Held: internet services are off for this file on this computer. An Admin here can allow them in Settings → Privacy & Network; the schedule then runs by itself.';

/** What the page shows over a stored agent message once the server says nobody needs to look. */
const RELEASED = 'A person confirmed this schedule after an agent changed it.';

type ScheduleRow = Record<string, unknown>;
/**
 * A row as GET /api/report-schedules answers it: the stored columns plus `waitingForAPerson`, the
 * server's answer from the audit trail each time the list loads (lib/services/memorizedReports.ts
 * listReportSchedules; runDueSchedules rewrites a stored hold whose reason changed). By default:
 * an emailing schedule an agent set up, held by the timer for that reason.
 */
function scheduleRow(over: ScheduleRow = {}): ScheduleRow {
  return {
    id: 's1',
    name: 'Month-end pack',
    memorizedReportId: 'r1',
    groupId: null,
    frequency: 'monthly',
    nextRunAt: '2026-11-01T09:00:00.000Z',
    format: 'csv',
    folder: null,
    isActive: true,
    lastRunAt: '2026-11-01T09:00:00.000Z',
    lastStatus: 'held',
    lastMessage: AGENT_HOLD,
    emailTo: 'owner@example.com',
    waitingForAPerson: true,
    ...over,
  };
}

/**
 * The schedules routes. The PATCH answers as the service does: a person's recipients Save is a
 * confirmation (no longer waiting), Pause and Resume are not, and the timer's stored message is
 * left as it was (only the next run rewrites it).
 */
function stubSchedules(row: () => ScheduleRow, onPatch: (body: Record<string, unknown>) => void = () => {}): FetchCall[] {
  return stubFetch({
    'GET /api/report-schedules': () => ({ schedules: [row()], exportFolder: 'C:\\Reports' }),
    'GET /api/memorized-reports?withGroups=1': { reports: [{ id: 'r1', name: 'Profit & Loss' }], groups: [] },
    'POST /api/report-schedules/run-due': { results: [] },
    'PATCH /api/report-schedules/s1': (c: FetchCall) => {
      onPatch((c.body ?? {}) as Record<string, unknown>);
      // The PATCH answers the stored row, without the listing's answer.
      const stored = { ...row() };
      delete stored.waitingForAPerson;
      return stored;
    },
  });
}
/** The service's answer to a PATCH, applied to the row the list then gives. */
const asTheServiceDoes = (row: ScheduleRow, b: Record<string, unknown>): ScheduleRow => ({
  ...row,
  ...b,
  ...('emailTo' in b && row.waitingForAPerson !== undefined ? { waitingForAPerson: false } : {}),
});
const agentHold = () => $('[data-agent-hold]');
const patches = (calls: FetchCall[]) => calls.filter((c) => c.method === 'PATCH').map((c) => JSON.stringify(c.body));
const toasts = () => $$('[aria-live="polite"] > [role]').map((t) => textOf(t));
const body = () => textOf(document.body);
/** Load the list again, as Run due reports now does after it runs. */
async function reloadSchedules() {
  await click(button(/Run due reports now/), 'Run due reports now');
  await settle(80);
}
/** Confirm recipients, then Save in its dialog. */
async function confirmRecipients(calls: FetchCall[]) {
  const before = patches(calls).length;
  await click(button('Confirm recipients of Month-end pack'), 'Confirm recipients');
  const dlg = await until(() => $$('[role="dialog"]').find((d) => textOf(d).includes('Confirm who')) ?? null, 'the confirmation');
  await click(button('Save', dlg), 'Save');
  await until(() => patches(calls).length === before + 1, 'the recipients are saved');
  await settle(60);
}

domTest('Scheduled Reports: an agent’s schedule waits for you, and only Confirm recipients lets it run', async () => {
  let row = scheduleRow();
  const calls = stubSchedules(
    () => row,
    (b) => {
      row = asTheServiceDoes(row, b);
    },
  );
  await mount(
    <>
      <Toaster />
      <ScheduledReportsPage />
    </>,
  );
  const hold = await until(agentHold, 'the agent hold badge');
  check(textOf(hold).includes('Waiting for you: an agent set this up'), `a distinct badge (got "${textOf(hold)}")`);
  check(button('Confirm recipients of Month-end pack'), 'a clear Confirm recipients control');
  check(body().includes(AGENT_HOLD), 'with the reason it waits');

  // Pause and Resume do not let it run.
  await click(button('Pause Month-end pack'), 'Pause');
  await until(() => button('Resume Month-end pack'), 'paused');
  check(agentHold(), 'still waiting for you after Pause');
  await click(button('Resume Month-end pack'), 'Resume');
  await until(() => button('Pause Month-end pack'), 'resumed');
  check(agentHold(), 'still waiting for you after Resume');
  equal(patches(calls).join(' '), '{"isActive":false} {"isActive":true}', 'Pause and Resume send only on/off');

  // Confirm recipients: the recipients Save, nothing else.
  await click(button('Confirm recipients of Month-end pack'), 'Confirm recipients');
  const dlg = await until(() => $$('[role="dialog"]').find((d) => textOf(d).includes('Confirm who')) ?? null, 'the confirmation');
  check(textOf(dlg).includes('Profit & Loss'), `it names the report it runs (got "${textOf(dlg)}")`);
  check(textOf(dlg).includes('Pausing or resuming it does not'), 'and says Pause does not count');
  equal(($<HTMLInputElement>('#sc-email-edit', dlg) ?? { value: '' }).value, 'owner@example.com', 'showing who it emails');
  await click(button('Save', dlg), 'Save');
  await until(() => patches(calls).length === 3, 'the recipients are saved');
  equal(patches(calls)[2], '{"emailTo":"owner@example.com"}', 'the save sends the recipients only');
  // The timer keeps its old message until the next run; the server's answer says it no longer waits.
  await until(() => !agentHold(), 'no longer waiting for you');
  check(!button('Confirm recipients of Month-end pack'), 'and Confirm recipients is gone');
  check(!body().includes(AGENT_HOLD), 'the old reason is not shown');
  check(body().includes(RELEASED), 'it says a person confirmed it');
  await until(() => toasts().some((t) => t.includes('Recipients confirmed. It no longer waits for you.')), 'the save says what it did');
  check(!toasts().some((t) => /runs at its next due time/.test(t)), `and promises nothing about the next run (got ${JSON.stringify(toasts())})`);
});

domTest('Scheduled Reports: with the server’s answer, a changed hold reason shows the current one', async () => {
  // The sequence with the listing set by hand at each step (the test "with today's server" below
  // works it out as the service does). An agent sets up an emailing schedule in a file whose
  // internet services are off; the timer holds it for the agent; a person confirms it; the timer
  // holds it for internet services; an agent changes it again; the timer holds it for the agent again.
  let row = scheduleRow();
  const calls = stubSchedules(
    () => row,
    (b) => {
      row = asTheServiceDoes(row, b);
    },
  );
  await mount(<ScheduledReportsPage />);
  await until(agentHold, 'held for the agent first');
  check(body().includes(AGENT_HOLD), 'with the agent reason');

  // A person confirms it: the stored message is still the agent's until the timer runs again.
  await confirmRecipients(calls);
  await until(() => !agentHold(), 'not waiting for you once confirmed');
  check(body().includes(RELEASED) && !body().includes(AGENT_HOLD), 'the agent reason is not shown as if it still held');
  check(!/runs at its next due time|It runs at/.test(body()), 'and nothing says it will run: internet services may still hold it');

  // The timer holds it because internet services are off, and stores that reason (runDueSchedules
  // rewrites a hold whose reason changed).
  row = { ...row, lastMessage: INTERNET_HOLD };
  await reloadSchedules();
  await until(() => body().includes(INTERNET_HOLD), 'the internet hold is shown');
  check(!agentHold() && !button('Confirm recipients of Month-end pack'), 'and not the agent hold');
  check(!body().includes(AGENT_HOLD) && !body().includes(RELEASED), 'nor an older reason');

  // An agent changes it again: the server says it waits, over the stored internet message.
  row = { ...row, waitingForAPerson: true };
  await reloadSchedules();
  await until(agentHold, 'the agent hold again');
  check(button('Confirm recipients of Month-end pack'), 'with Confirm recipients');
  check(!body().includes(INTERNET_HOLD), 'the reason shown is the agent hold, the one that decides first');
  check(/choose Confirm recipients and Save/.test(body()), 'saying what to do');

  // The timer holds it for the agent again (the same message as the first time).
  row = { ...row, lastMessage: AGENT_HOLD };
  await reloadSchedules();
  await until(() => agentHold() && body().includes(AGENT_HOLD), 'the agent hold, with its stored reason');
  check(!body().includes(RELEASED), 'not the earlier confirmation');

  // Set up by an agent, files only, never run yet: the server's word is enough to wait.
  row = scheduleRow({ lastRunAt: null, lastStatus: null, lastMessage: null, emailTo: null, waitingForAPerson: true });
  await reloadSchedules();
  await until(agentHold, 'waiting for you before its first run');
  check(button('Confirm recipients of Month-end pack'), 'with Confirm recipients (none is fine: files only)');
});

domTest('Scheduled Reports: after a reload, or for another person, the server’s answer decides', async () => {
  // Confirmed elsewhere (another window, another person): the stored message is still the agent's,
  // and the listing's waitingForAPerson says it no longer waits.
  let row = scheduleRow({ waitingForAPerson: false });
  stubSchedules(() => row);
  await mount(<ScheduledReportsPage />);
  await until(() => body().includes(RELEASED), 'a fresh page says it was confirmed');
  check(!agentHold() && !button('Confirm recipients of Month-end pack'), 'and does not ask again');
  check(!body().includes(AGENT_HOLD), 'nor shows the old reason');

  // An agent changed it again after that confirmation: the open page says so on its next load.
  row = { ...row, waitingForAPerson: true };
  await reloadSchedules();
  await until(agentHold, 'waiting for you again');
  check(body().includes(AGENT_HOLD) && !body().includes(RELEASED), 'with the agent reason, not the earlier confirmation');
});

/** A row as an older server listed it: the stored columns only, no waitingForAPerson. */
function storedRow(over: ScheduleRow = {}): ScheduleRow {
  const row = scheduleRow(over);
  delete row.waitingForAPerson;
  return row;
}

domTest('Scheduled Reports: a listing without the server’s answer errs towards waiting and promises nothing', async () => {
  // A listing without waitingForAPerson (an older server): the stored message is all there is.
  let row = storedRow();
  const calls = stubSchedules(
    () => row,
    (b) => {
      row = asTheServiceDoes(row, b);
    },
  );
  await mount(
    <>
      <Toaster />
      <ScheduledReportsPage />
    </>,
  );
  await until(agentHold, 'the stored agent message: waiting for you');
  await confirmRecipients(calls);
  await until(() => toasts().some((t) => t.includes('Recipients confirmed.')), 'the save says what it did');
  check(!toasts().some((t) => /no longer waits|runs at/.test(t)), `and only what is sure (got ${JSON.stringify(toasts())})`);
  check(agentHold(), 'still shown as waiting: asking a person to look again is the safe side');
  check(!body().includes(RELEASED), 'and no claim that it was released');

  // Another schedule, one no agent touched, held only because internet services are off.
  row = storedRow({ lastMessage: INTERNET_HOLD });
  await reloadSchedules();
  await until(() => body().includes(INTERNET_HOLD) && !agentHold(), 'a stored internet hold is not an agent hold');
});

domTest('Scheduled Reports: with today’s server, a confirmed agent hold gives way to the current reason', async () => {
  // What GET /api/report-schedules returns for this sequence (lib/services/memorizedReports.ts:
  // listReportSchedules adds waitingForAPerson from the audit trail on every listing, and
  // runDueSchedules rewrites a hold whose reason changed): an emailing schedule an agent set up, in
  // a file whose internet services are off. The listing is worked out here as the service does it:
  // `waiting` is the audit trail's answer, `stored` what the timer last wrote.
  let waiting = true;
  let stored: ScheduleRow = { lastRunAt: '2026-11-01T09:00:00.000Z', lastStatus: 'held', lastMessage: AGENT_HOLD };
  let emailTo: string | null = 'owner@example.com';
  const listing = (): ScheduleRow => ({ ...scheduleRow({ emailTo, ...stored }), waitingForAPerson: waiting });
  /** The timer runs the due schedules (runDueSchedules): the agent hold first, then the internet hold. */
  const timerRuns = () => {
    const reason = waiting ? AGENT_HOLD : emailTo ? INTERNET_HOLD : null;
    if (reason && stored.lastMessage !== reason) stored = { lastRunAt: '2026-11-02T09:00:00.000Z', lastStatus: 'held', lastMessage: reason };
  };
  const calls = stubSchedules(listing, (b) => {
    if ('emailTo' in b) {
      emailTo = (b.emailTo as string | null) ?? null;
      waiting = false; // a person's recipients Save confirms it (updateReportSchedule)
    }
  });
  await mount(
    <>
      <Toaster />
      <ScheduledReportsPage />
    </>,
  );
  // 1. The timer holds it for the agent.
  await until(agentHold, 'held for the agent');
  check(body().includes(AGENT_HOLD), 'with the agent reason');

  // 2. A person confirms its recipients: the listing right after says it no longer waits, though
  //    the stored message is still the agent's until the timer runs again.
  await confirmRecipients(calls);
  await until(() => toasts().some((t) => t.includes('Recipients confirmed. It no longer waits for you.')), 'the save says what it did');
  await until(() => !agentHold(), 'no longer waiting for you');
  check(!button('Confirm recipients of Month-end pack'), 'and Confirm recipients is gone');
  check(body().includes(RELEASED) && !body().includes(AGENT_HOLD), 'the stored agent reason is not shown as if it still held');
  check(!/runs at its next due time|It runs at/.test(body()), 'and nothing says it will run: internet services may still hold it');

  // 3. The timer holds it for internet services and stores that reason: the row gives it.
  timerRuns();
  await reloadSchedules();
  await until(() => body().includes(INTERNET_HOLD), 'the internet reason is shown');
  check(!agentHold() && !body().includes(AGENT_HOLD) && !body().includes(RELEASED), 'and no older reason');

  // 4. An agent changes it again: waiting for a person, over the stored internet message, then
  //    the timer's agent hold again.
  waiting = true;
  await reloadSchedules();
  await until(agentHold, 'waiting for you again');
  check(!body().includes(INTERNET_HOLD) && /choose Confirm recipients and Save/.test(body()), 'with the agent hold as the reason, and what to do');
  timerRuns();
  await reloadSchedules();
  await until(() => agentHold() && body().includes(AGENT_HOLD), 'the timer’s agent hold, with its stored reason');

  // 5. A schedule an agent made that has not reached its first run: nothing is stored yet, and the
  //    server's answer is enough to wait.
  stored = { lastRunAt: null, lastStatus: null, lastMessage: null };
  await reloadSchedules();
  await until(() => !body().includes(AGENT_HOLD), 'the listing is the new one');
  check(agentHold() && button('Confirm recipients of Month-end pack'), 'waiting for you before its first run, with Confirm recipients');
});

void runDomTests();
