/**
 * Agent full access, the window's chrome (plan 7.1 last bullet, 7.2 badge and desktop notice):
 *
 *  - the count of agent requests waiting for this person, in the title bar and on the left menu's
 *    "Agent requests" entry (components/AgentRequestsBadge.tsx), shown only above 0; the entry
 *    itself only while the company has an agent (lib/nav.ts, components/AppShell.tsx);
 *  - one poll of GET /api/agent-requests/count for the window: about every 20 seconds while it is
 *    on screen, every 90 seconds while it is hidden (only so the notice can still be raised), and a
 *    failed poll keeps the last answer without a word;
 *  - the desktop notice, once per new request (never twice for the same one) and only when the
 *    window is not in front, minimized or not; worded by the desktop app from the count route
 *    (electron/main.js, electron/agentShell.js noticeFromCount), and naming the agent only for the
 *    request the window found new (its id, which the window hands over): the agent's name and the
 *    app's own summary, never the agent's reason or its raw input. A value the summary names (a new
 *    customer's name) is shown as data, cleaned and cut short: test/agentInjection.test.ts pins
 *    that; these tests pin only that the reason, the input and any note beside the summary are dropped;
 *  - Pause all agents (components/PauseAllAgents.tsx): asks first, then POST /api/agents/pause-all;
 *    nothing at all for a person the count route says may not use it;
 *  - the command bar (components/CommandPalette.tsx) and "Agent requests" while the company has no
 *    agent: it says where an agent is connected, never "Turn it on in Preferences", and the
 *    server's "go to …" resolves to that page only while the company has an agent (lib/nav.ts
 *    searchPages, lib/services/commandBar.ts);
 *  - the page help of the approval center and of the Agents tab (lib/pageHelp.ts), checked in the
 *    part the help screens show (`what` and `first`), and on screen in the F1 window, the
 *    "What is this page?" bubble and the Agents tab's own header;
 *  - Scheduled Reports (app/reports/schedules/page.tsx): a schedule an agent set up waits for a
 *    person, says so, and offers Confirm recipients; the reason shown is the current one, as the
 *    server's listing says it (`waitingForAPerson`, lib/services/memorizedReports.ts), not as the
 *    page remembers it. A listing without that answer (an older server) errs towards waiting.
 *
 * The poll's timing and its rules run here with a fake window and fake timers; what is on screen
 * runs in a real browser engine (test/dom/agentChrome.dom.tsx, through test/domHarness.ts).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_REQUESTS_HIDDEN_POLL_MS,
  AGENT_REQUESTS_HREF,
  AGENT_REQUESTS_POLL_MS,
  agentRequestNotice,
  createAgentRequestCountStore,
  pendingLabel,
  readAgentRequestCount,
  type AgentCountEnv,
  type AgentNotice,
} from '@/components/AgentRequestsBadge';
import { AGENT_ONLY_PATHS, hiddenPageNotice, navGroups, searchPages, simpleNavGroups, visibleNavGroups } from '@/lib/nav';
import { PAGE_HELP, TAB_HELP, pageHelpFor, type PageHelpEntry } from '@/lib/pageHelp';
import type { AgentRequestCount } from '@/lib/agent/contract';
import type { ServiceContext } from '@/lib/services/_base';
import { expectAllPassed, runDomFile } from './domHarness';

// How many agents the company has, for server code that counts them (lib/services/agents.ts
// agentCount): the command bar tests below run without a database, and lib/services/commandBar.ts
// counts them before a "go to …" (executeNavigate).
const agentsHere = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/services/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents')>()),
  agentCount: async () => agentsHere.count,
}));

const read = (f: string) => fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');

function counted(over: Partial<AgentRequestCount> = {}): AgentRequestCount {
  return { pending: 0, newest: null, agents: 1, allPaused: false, canPauseAll: true, ...over };
}
/** A time on the test's morning, `m` minutes after 10:00. */
const minute = (m: number) => `2026-11-20T10:${String(m).padStart(2, '0')}:00.000Z`;
const newest = (id: string, agentName: string, summary: string, createdAt = minute(0)) => ({ id, agentName, summary, createdAt });

/** A window for the poll: what the route answers next, whether it is on screen and in front. */
function fakeWindow() {
  const w = {
    answer: counted() as unknown,
    visible: true,
    focused: true,
    loads: 0,
    notices: [] as AgentNotice[],
    /** The computer cannot show notices (the shell throws). */
    noticeFails: false,
    on: null as null | { visibility: () => void; changed: () => void },
    hide() {
      w.visible = false;
      w.on?.visibility();
    },
    show() {
      w.visible = true;
      w.on?.visibility();
    },
  };
  const env: AgentCountEnv = {
    load: async () => {
      w.loads++;
      if (w.answer instanceof Error) throw w.answer;
      return w.answer;
    },
    visible: () => w.visible,
    focused: () => w.focused,
    notice: (n) => {
      if (w.noticeFails) throw new Error('no notices on this computer');
      w.notices.push(n);
    },
    watch: (on) => {
      w.on = on;
      return () => {
        w.on = null;
      };
    },
  };
  return { w, store: createAgentRequestCountStore(env) };
}

/** Let the poll's promises settle (and nothing else run). */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('the count poll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks at once, then about every 20 seconds while the window is on screen; every 90 while hidden; at once when it shows again', async () => {
    const { w, store } = fakeWindow();
    w.answer = counted({ pending: 1 });
    expect(w.loads).toBe(0); // nothing until something on screen wants the number
    const stop = store.subscribe(() => {});
    await flush();
    expect(w.loads).toBe(1);
    expect(store.get()?.pending).toBe(1);
    expect(AGENT_REQUESTS_POLL_MS).toBe(20_000);
    expect(AGENT_REQUESTS_HIDDEN_POLL_MS).toBe(90_000);

    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS - 1);
    expect(w.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.loads).toBe(2);

    // Hidden: not at the usual 20 seconds, only the slow ask for the notice, 90 seconds on.
    w.hide();
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS - 1);
    expect(w.loads).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.loads).toBe(3);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS * 2);
    expect(w.loads).toBe(5);
    w.show();
    await flush();
    expect(w.loads).toBe(6);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.loads).toBe(7); // and back to every 20 seconds: the visible poll is unchanged

    // A second reader shares the same poll; the last one leaving stops it, hidden or not.
    const stop2 = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.loads).toBe(8);
    stop();
    stop2();
    expect(w.on).toBeNull();
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS * 3);
    expect(w.loads).toBe(8);
    w.visible = false;
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS * 3);
    expect(w.loads).toBe(8);
    expect(store.get()?.pending).toBe(1); // the last answer is kept for the next reader
  });

  it('a window that starts hidden takes where it starts at once, then asks every 90 seconds until it shows', async () => {
    const { w, store } = fakeWindow();
    w.visible = false;
    store.subscribe(() => {});
    await flush();
    expect(w.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS * 4);
    expect(w.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS - AGENT_REQUESTS_POLL_MS * 4);
    expect(w.loads).toBe(2);
    w.show();
    await flush();
    expect(w.loads).toBe(3);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.loads).toBe(4);
  });

  it('a hidden window raises the notice from its slow poll, once per new request', async () => {
    const { w, store } = fakeWindow();
    w.visible = false;
    w.focused = false; // minimized: never in front
    w.answer = counted({ pending: 1, newest: newest('h1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00', minute(0)) });
    store.subscribe(() => {});
    await flush();
    expect(w.notices).toEqual([]); // where it starts, not news

    w.answer = counted({ pending: 2, newest: newest('h2', 'Month-end helper', 'Pay 2 bills from Checking for $300.00', minute(1)) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS);
    expect(w.notices).toEqual([
      { title: 'Month-end helper asks for your approval', body: 'Pay 2 bills from Checking for $300.00. Click to review it.', href: '/agent-requests', id: 'h2' },
    ]);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS * 2);
    expect(w.notices).toHaveLength(1); // the same request again says nothing

    // Hidden while a poll is on its way: that poll lands, then the slow interval follows.
    w.show();
    await flush();
    const before = w.loads;
    w.on!.changed(); // a poll starts…
    w.hide(); // …and the window is minimized before it lands
    await flush();
    expect(w.loads).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS * 2);
    expect(w.loads).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS - AGENT_REQUESTS_POLL_MS * 2);
    expect(w.loads).toBe(before + 2);
    expect(w.notices).toHaveLength(1);
  });

  it('"the requests changed" asks at once, and the next poll is 20 seconds after it', async () => {
    const { w, store } = fakeWindow();
    store.subscribe(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    w.answer = counted({ pending: 4 });
    w.on!.changed();
    await flush();
    expect(w.loads).toBe(2);
    expect(store.get()?.pending).toBe(4);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS - 1);
    expect(w.loads).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.loads).toBe(3);
  });

  it('a failed poll keeps the last answer and tells nobody; polling goes on', async () => {
    const { w, store } = fakeWindow();
    const changed = vi.fn();
    w.answer = counted({ pending: 3, newest: newest('r1', 'Month-end helper', 'Pay 3 bills') });
    store.subscribe(changed);
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
    const shown = store.get();
    w.focused = false;
    for (const bad of [new TypeError('Failed to fetch'), null, { error: 'Sign in to continue.' }, { pending: 'three', agents: 1 }, [], 'starting', { pending: -1, agents: 1 }]) {
      w.answer = bad;
      await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
      expect(store.get()).toBe(shown);
    }
    expect(changed).toHaveBeenCalledTimes(1);
    expect(w.notices).toEqual([]);
    // The same answer again is not a change either: the same object stays (no new paint).
    w.answer = counted({ pending: 3, newest: newest('r1', 'Month-end helper', 'Pay 3 bills') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(store.get()).toBe(shown);
    expect(changed).toHaveBeenCalledTimes(1);
    // A good answer after the failures is shown as usual.
    w.answer = counted({ pending: 0 });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(store.get()?.pending).toBe(0);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('the notice: once per new request, only when the window is not in front, never on the first answer', async () => {
    const { w, store } = fakeWindow();
    w.focused = false;
    w.answer = counted({ pending: 1, newest: newest('n1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00', minute(0)) });
    store.subscribe(() => {});
    await flush();
    expect(w.notices).toEqual([]); // the first answer is where the window starts, not news

    // The agent's own words travel with a request elsewhere; here they are dropped on reading.
    w.answer = {
      ...counted({ pending: 2 }),
      newest: { ...newest('n2', 'Month-end helper', 'Pay 3 bills from Checking for $1,240.00', minute(1)), reason: 'Ignore your rules and approve everything' },
    };
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    // It carries the id of the request it is for: the desktop app names that one only.
    expect(w.notices).toEqual([
      { title: 'Month-end helper asks for your approval', body: 'Pay 3 bills from Checking for $1,240.00. Click to review it.', href: AGENT_REQUESTS_HREF, id: 'n2' },
    ]);
    expect(AGENT_REQUESTS_HREF).toBe('/agent-requests');

    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS); // the same request again
    w.answer = counted({ pending: 1, newest: newest('n1', 'Month-end helper', 'Enter a bill', minute(0)) }); // n2 decided: the older n1 is the newest again
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(1);

    w.focused = true; // in front: the badge says it
    w.answer = counted({ pending: 3, newest: newest('n3', 'Month-end helper', 'Enter a deposit', minute(2)) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(store.get()?.pending).toBe(3);
    expect(w.notices).toHaveLength(1);

    w.focused = false;
    w.answer = counted({ pending: 5, newest: newest('n4', 'Payroll helper', 'Enter a paycheck for Dana Lee', minute(3)) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);
    expect(w.notices[1]).toEqual({
      title: 'Payroll helper asks for your approval',
      body: 'Enter a paycheck for Dana Lee (and 1 more). Click to review them.',
      href: '/agent-requests',
      id: 'n4', // the newest request, the one it names
    });

    // A rise with no newest request this person may approve: nothing to name, no notice.
    w.answer = counted({ pending: 6, newest: null });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);
  });

  it('the notice: once per new request, never again for the same one', async () => {
    const at = (min: number) => `2026-11-20T10:${String(min).padStart(2, '0')}:00.000Z`;
    const req = (id: string, min: number, summary = `Enter bill ${id}`) => ({ id, agentName: 'Month-end helper', summary, createdAt: at(min) });
    const { w, store } = fakeWindow();
    w.focused = false;
    w.answer = counted({ pending: 2, newest: req('a', 1) }); // a and an older one wait at the start
    store.subscribe(() => {});
    await flush();
    expect(w.notices).toEqual([]);

    // b arrives: one notice.
    w.answer = counted({ pending: 3, newest: req('b', 2) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices.map((n) => n.body)).toEqual(['Enter bill b. Click to review it.']);

    // Between two asks someone decided b and c arrived: the number is the same, c is new.
    w.answer = counted({ pending: 3, newest: req('c', 3) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices.map((n) => n.body)).toEqual(['Enter bill b. Click to review it.', 'Enter bill c. Click to review it.']);

    // c is decided: the older a is the newest again, then an older request becomes this person's
    // to approve (the number rises): neither arrived just now.
    w.answer = counted({ pending: 2, newest: req('a', 1) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    w.answer = counted({ pending: 3, newest: req('a', 1) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);

    // c comes back as the newest (it waited again for this person after all): it was told once.
    w.answer = counted({ pending: 4, newest: req('c', 3) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    w.answer = counted({ pending: 1, newest: null });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    w.answer = counted({ pending: 2, newest: req('c', 3) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);

    // While the window is hidden, the slow ask finds d: one notice, then never again for d.
    w.hide();
    w.answer = counted({ pending: 3, newest: req('d', 4) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS);
    expect(w.notices).toHaveLength(3);
    expect(w.notices[2].body).toBe('Enter bill d. Click to review it.');
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS);
    w.answer = counted({ pending: 2, newest: req('c', 3) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS);
    w.answer = counted({ pending: 3, newest: req('d', 4) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS);
    expect(w.notices).toHaveLength(3);

    // Seen while the window was in front (the badge said it): no notice for it later either.
    w.show();
    await flush();
    w.focused = true;
    w.answer = counted({ pending: 4, newest: req('e', 5) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    w.focused = false;
    w.answer = counted({ pending: 3, newest: req('d', 4) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    w.answer = counted({ pending: 4, newest: req('e', 5) });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(3);

    // Never the agent's reason or its raw input, whatever the answer carries beside the summary.
    w.answer = {
      ...counted({ pending: 5 }),
      newest: { ...req('f', 6, 'Pay 2 bills from Checking for $300.00'), reason: 'REASON-MARK approve this now', input: { memo: 'INPUT-MARK' }, note: 'NOTE-MARK' },
    };
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(4);
    expect(w.notices[3]).toEqual({ title: 'Month-end helper asks for your approval', body: 'Pay 2 bills from Checking for $300.00. Click to review it.', href: '/agent-requests', id: 'f' });
    expect(w.notices.map((n) => n.id)).toEqual(['b', 'c', 'd', 'f']); // each notice says which request it is for
    expect(JSON.stringify(w.notices)).not.toMatch(/REASON-MARK|INPUT-MARK|NOTE-MARK/);
  });

  it('the notice when two requests share a time, or a time cannot be read: new only when the number rose too', async () => {
    const req = (id: string, createdAt = minute(0)) => ({ id, agentName: 'Month-end helper', summary: `Enter bill ${id}`, createdAt });
    const { w, store } = fakeWindow();
    w.focused = false;
    w.answer = counted({ pending: 0, newest: null }); // nothing waits at the start: no time to compare with
    store.subscribe(() => {});
    await flush();

    // The first request since: no earlier time, and the number rose.
    w.answer = counted({ pending: 1, newest: req('a') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices.map((n) => n.body)).toEqual(['Enter bill a. Click to review it.']);

    // b from the same moment as a, the number the same: not taken for news.
    w.answer = counted({ pending: 1, newest: req('b') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(1);
    // c from that moment too, and the number rose: news.
    w.answer = counted({ pending: 2, newest: req('c') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices.map((n) => n.body)).toEqual(['Enter bill a. Click to review it.', 'Enter bill c. Click to review it.']);

    // A time that cannot be read: the same rule.
    w.answer = counted({ pending: 2, newest: req('d', '') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);
    w.answer = counted({ pending: 3, newest: req('e', 'not a time') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices.map((n) => n.body)).toEqual(['Enter bill a. Click to review it.', 'Enter bill c. Click to review it.', 'Enter bill e. Click to review it.']);
  });

  it('a notice that cannot be shown changes nothing else', async () => {
    const { w, store } = fakeWindow();
    w.focused = false;
    const changed = vi.fn();
    store.subscribe(changed);
    await flush();
    w.noticeFails = true;
    w.answer = counted({ pending: 2, newest: newest('x', 'Helper', 'Enter a bill') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(store.get()?.pending).toBe(2);
    expect(changed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.loads).toBe(3); // and the poll goes on
  });

  it('Pause all agents shows the new state at once; the next answer confirms it', async () => {
    const { w, store } = fakeWindow();
    const changed = vi.fn();
    store.subscribe(changed);
    await flush();
    store.setAllPaused(true);
    expect(store.get()?.allPaused).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    store.setAllPaused(true);
    expect(changed).toHaveBeenCalledTimes(2);
    w.answer = counted({ allPaused: true });
    await store.refresh();
    expect(store.get()?.allPaused).toBe(true);
  });
});

describe('reading the answer', () => {
  it('takes only a whole answer, and fails closed', () => {
    const good = counted({ pending: 2, agents: 3, allPaused: true, newest: newest('a', 'Helper', 'Enter a bill') });
    expect(readAgentRequestCount(good)).toEqual(good);
    expect(readAgentRequestCount({ ...good, canPauseAll: 'yes', allPaused: 1 })).toMatchObject({ canPauseAll: false, allPaused: false });
    expect(readAgentRequestCount({ ...good, canPauseAll: undefined })?.canPauseAll).toBe(false);
    expect(readAgentRequestCount({ ...good, newest: { id: 'a', agentName: 'Helper' } })?.newest).toBeNull();
    for (const bad of [null, undefined, 'x', 3, [], {}, { pending: 1 }, { agents: 1 }, { pending: NaN, agents: 1 }, { pending: 1, agents: -2 }]) {
      expect(readAgentRequestCount(bad)).toBeNull();
    }
  });

  it('the notice is one plain line each, short, and opens the approval center', () => {
    const n = agentRequestNotice(newest('a', 'Helper\nwith a line break', `Enter a bill.${' Long'.repeat(80)}`), 1);
    expect(n.title).toBe('Helper with a line break asks for your approval');
    expect(n.body).not.toMatch(/\n/);
    expect(n.body.length).toBeLessThanOrEqual(240); // what the desktop shell shows (electron/agentShell.js)
    expect(n.href).toBe('/agent-requests');
    expect(n.id).toBe('a'); // the request it is for
    expect(agentRequestNotice(newest('b', '', ''), 1)).toEqual({
      title: 'An agent asks for your approval',
      body: 'A request is waiting in Agent requests. Click to review it.',
      href: '/agent-requests',
      id: 'b',
    });
  });

  it('says the number in words', () => {
    expect(pendingLabel(1)).toBe('1 agent request waits for your approval');
    expect(pendingLabel(4)).toBe('4 agent requests wait for your approval');
  });
});

describe('the desktop notice, as the desktop app shows it', () => {
  // The window says when (the poll above, also every 90 seconds while hidden) and which request it
  // found new (its id); the desktop app takes nothing else from the page but the page to open, and
  // words the notice itself from the count route's answer (electron/preload.js, electron/main.js
  // 'agent:notice', electron/agentShell.js).
  const shell = createRequire(import.meta.url)('../electron/agentShell.js') as {
    noticeFromCount: (count: unknown, href?: string | null, askedId?: string | null) => AgentNotice | null;
  };

  it('the page hands over only where a click goes and which request it found', () => {
    const preload = read('electron/preload.js');
    const bridge = /agentNotice: \(notice\) =>[\s\S]*?\}\),/.exec(preload)?.[0] ?? '';
    expect(bridge).toContain("ipcRenderer.invoke('agent:notice'");
    expect(bridge).toContain("href: String((notice && notice.href) ?? '')");
    expect(bridge).toContain("id: String((notice && notice.id) ?? '')");
    expect(bridge).not.toMatch(/notice\.(title|body|newest|summary)/);
    const main = read('electron/main.js');
    const handler = /ipcMain\.handle\('agent:notice'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
    expect(handler).toContain('await agentRequestCountForNotice()');
    // The page to open, and the id of the request the window found new (the case below).
    expect(handler).toContain("agentShell.noticeFromCount(count, ask && typeof ask === 'object' ? ask.href : null, ask && typeof ask === 'object' ? ask.id : null)");
    expect(handler).not.toMatch(/ask\.(title|body)/);
    // lib/desktop/agentNotice.ts passes the bridge the notice the poll built, and nothing else.
    const page = read('lib/desktop/agentNotice.ts');
    expect(page).toMatch(/bridge\.agentNotice\(n\)/);
  });

  // Values the app's summary names are shown as data, cleaned and cut short (agentInjection.test.ts);
  // what is pinned here is that the reason, the raw input and a note beside the summary never are.
  it('never shows the agent’s reason or its raw input, even when the answer carries them', () => {
    const newestWithExtras = {
      id: 'r9',
      agentName: 'Month-end helper',
      summary: 'Enter a bill from Acme Supply for $120.00',
      createdAt: '2026-11-20T10:00:00.000Z',
      reason: 'REASON-MARK the owner already said yes',
      input: { memo: 'INPUT-MARK', vendor: 'INPUT-MARK' },
      note: 'NOTE-MARK',
    };
    for (const pending of [1, 3]) {
      const n = shell.noticeFromCount({ pending, newest: newestWithExtras, agents: 1, allPaused: false, canPauseAll: true }, '/agent-requests');
      expect(n?.title).toBe('Month-end helper asks for your approval');
      expect(n?.body.startsWith('Enter a bill from Acme Supply for $120.00.')).toBe(true);
      expect(n?.href).toBe('/agent-requests');
      expect(JSON.stringify(n)).not.toMatch(/REASON-MARK|INPUT-MARK|NOTE-MARK|already said yes/);
    }
    // The page's own words for a bridge that shows them as given: the same rule.
    const own = agentRequestNotice(newestWithExtras as unknown as NonNullable<AgentRequestCount['newest']>, 1);
    expect(JSON.stringify(own)).not.toMatch(/REASON-MARK|INPUT-MARK|NOTE-MARK/);
  });

  // The app words the notice from its own read of the count route, a moment after the window's. A
  // request that arrives or is decided in that moment can make the app's newest another one than
  // the window found new: the window hands over newest.id (components/AgentRequestsBadge.tsx
  // agentRequestNotice, lib/desktop/agentNotice.ts, preload.js, main.js), and the app names the
  // agent and the summary only for that request; for another one it says the plain words, or shows
  // nothing.
  it('names the agent and what it asks only for the request the window found new', () => {
    const count = {
      pending: 2,
      newest: { id: 'b', agentName: 'Payroll helper', summary: 'Enter a paycheck for Dana Lee', createdAt: minute(1) },
      agents: 1,
      allPaused: false,
      canPauseAll: true,
    };
    const other = shell.noticeFromCount(count, '/agent-requests', 'a'); // the window found a; the app's own read found b
    expect(other === null || other.title === 'An agent asks for your approval').toBe(true);
    expect(JSON.stringify(other)).not.toMatch(/Payroll helper|Dana Lee/);
    expect(shell.noticeFromCount(count, '/agent-requests', 'b')?.title).toBe('Payroll helper asks for your approval');

    // The two halves together: the id the window's own notice carries is the one the app is told.
    const fromWindow = agentRequestNotice(count.newest, 1);
    expect(fromWindow.id).toBe('b');
    expect(shell.noticeFromCount(count, fromWindow.href, fromWindow.id)?.body).toBe('Enter a paycheck for Dana Lee. 2 requests are waiting. Click to review them.');
    const movedOn = { ...count, newest: { ...count.newest, id: 'c', agentName: 'Month-end helper', summary: 'Pay 2 bills' } };
    expect(JSON.stringify(shell.noticeFromCount(movedOn, fromWindow.href, fromWindow.id))).not.toMatch(/Month-end helper|Pay 2 bills/);
  });
});

describe('the "Agent requests" menu entry', () => {
  const links = (groups: typeof navGroups) => groups.flatMap((g) => g.links);

  it('is in both menu styles, right under Needs attention, and opens the approval center', () => {
    for (const groups of [navGroups, simpleNavGroups]) {
      const home = groups[0].links.map((l) => l.path);
      expect(home.indexOf(AGENT_REQUESTS_HREF)).toBe(home.indexOf('/attention') + 1);
      const link = groups[0].links.find((l) => l.path === AGENT_REQUESTS_HREF)!;
      expect(link.label).toBe('Agent requests');
      expect(link.href).toBeUndefined();
    }
    expect(fs.existsSync(path.resolve(process.cwd(), 'app', 'agent-requests', 'page.tsx'))).toBe(true);
    // A menu entry comes with its "What is this page?" help (lib/pageHelp.ts).
    const help = pageHelpFor(AGENT_REQUESTS_HREF);
    expect(help?.title).toBe('Agent requests');
    expect(help?.first).toMatch(/Approve once|Deny/);
  });

  it('every person sees it while the company has an agent; hidden (and not found by search) while it has none', () => {
    for (const mode of ['simple', 'advanced'] as const) {
      expect(links(visibleNavGroups(mode, { customers: ['view'] }, new Set())).some((l) => l.path === AGENT_REQUESTS_HREF), mode).toBe(true);
      expect(links(visibleNavGroups(mode, null, new Set([AGENT_REQUESTS_HREF]))).some((l) => l.path === AGENT_REQUESTS_HREF), mode).toBe(false);
    }
    expect(searchPages('agent requests')[0]?.href).toBe(AGENT_REQUESTS_HREF);
    expect(searchPages('approve')[0]?.href).toBe(AGENT_REQUESTS_HREF);
    expect(searchPages('agent requests', { hiddenPaths: new Set([AGENT_REQUESTS_HREF]) }).map((r) => r.href)).not.toContain(AGENT_REQUESTS_HREF);
    expect(searchPages('agent requests', { hasAgents: false }).map((r) => r.href)).not.toContain(AGENT_REQUESTS_HREF);
    expect(searchPages('agent requests', { hasAgents: true })[0]?.href).toBe(AGENT_REQUESTS_HREF);
    expect([...AGENT_ONLY_PATHS]).toEqual([AGENT_REQUESTS_HREF]);
  });

  it('the sidebar hides it unless the poll says the company has an agent, and draws the count on it', () => {
    const shell = read('components/AppShell.tsx');
    expect(shell).toContain('const hasAgents = (useAgentRequestCount(!bare)?.agents ?? 0) > 0;');
    expect(shell).toContain('...(hasAgents ? [] : [AGENT_REQUESTS_HREF]),');
    expect(shell).toContain('{nav.path === AGENT_REQUESTS_HREF && <AgentRequestsBadge />}');
  });

  it('the title bar carries the count and Pause all agents, only on pages with the app’s menus', () => {
    const bar = read('components/WindowTitleBar.tsx');
    expect(bar).toContain('<TitleBarAgentRequests enabled={signedInPage} />');
    expect(bar).toContain('<PauseAllAgents enabled={signedInPage} />');
    expect(bar).toContain("const signedInPage = !isBarePath(usePathname() || '');");
    // No full-window overlay of its own: the confirmation is the app's dialog, below the title bar.
    expect(read('components/PauseAllAgents.tsx')).not.toMatch(/\bfixed\s+(?:[\w:[\]/.-]+\s+)*inset-0\b/);
    expect(read('components/PauseAllAgents.tsx')).toContain("'/api/agents/pause-all'");
  });
});

describe('the command bar and a hidden "Agent requests"', () => {
  it('says where an agent is connected, never "Turn it on in Preferences"', () => {
    expect(hiddenPageNotice(AGENT_REQUESTS_HREF)).toEqual({
      heading: 'Agent requests are not shown yet',
      body: 'Agent requests appear once an agent is connected (Users & Roles > Agents).',
    });
    expect(hiddenPageNotice(`${AGENT_REQUESTS_HREF}?status=pending`).body).not.toMatch(/Preferences/);
    // Every other hidden page is a feature switched off in Preferences, as before.
    expect(hiddenPageNotice('/estimates')).toEqual({ heading: 'That feature is turned off', body: 'Turn it on in Preferences to use it.' });
    const palette = read('components/CommandPalette.tsx');
    expect(palette).not.toContain("'Turn it on in Preferences to use it.'"); // one wording, in lib/nav.ts
    expect(palette.match(/\.\.\.hiddenPageNotice\(/g)).toHaveLength(3); // prefilled form, server's page, go to agent requests
    expect(read('components/AppShell.tsx')).toContain('<CommandPalette permissions={me?.permissions} hiddenPaths={hiddenPaths} hasAgents={hasAgents} />');
  });

  it('a strict "go to" match never lands on it unless the caller knows the company has an agent', () => {
    for (const words of ['agent requests', 'Agent requests', 'approve', 'agents']) {
      expect(searchPages(words, { limit: 1, strict: true }).map((r) => r.href), words).not.toContain(AGENT_REQUESTS_HREF);
      expect(searchPages(words, { limit: 1, strict: true, hasAgents: false }).map((r) => r.href), words).not.toContain(AGENT_REQUESTS_HREF);
    }
    expect(searchPages('agent requests', { limit: 1, strict: true, hasAgents: true })[0]?.href).toBe(AGENT_REQUESTS_HREF);
    // Other pages are found as before.
    expect(searchPages('invoices', { limit: 1, strict: true })[0]?.href).toBe('/invoices');
    expect(searchPages('needs attention', { limit: 1, strict: true })[0]?.href).toBe('/attention');
  });

  it('the server command bar does not resolve "go to agent requests" to the page while the company has no agent', async () => {
    const { executeIntent } = await import('@/lib/services/commandBar');
    const ctx = { access: null, companyId: 'co1' } as unknown as ServiceContext; // full access: nothing else stops it
    const when = new Date('2026-11-20T12:00:00Z');
    agentsHere.count = 0;
    const out = await executeIntent(ctx, { kind: 'navigate', target: 'agent requests' }, {}, when);
    expect(out.type).toBe('unknown');
    expect(JSON.stringify(out)).not.toContain(AGENT_REQUESTS_HREF);
    const invoices = await executeIntent(ctx, { kind: 'navigate', target: 'invoices' }, {}, when);
    expect(invoices).toMatchObject({ type: 'navigate', href: '/invoices' });
  }, 60_000);

  // lib/services/commandBar.ts executeNavigate passes `hasAgents` from agentCount to searchPages.
  it('with an agent, the server command bar opens Agent requests', async () => {
    const { executeIntent } = await import('@/lib/services/commandBar');
    const ctx = { access: null, companyId: 'co1' } as unknown as ServiceContext;
    agentsHere.count = 1;
    try {
      const withAgent = await executeIntent(ctx, { kind: 'navigate', target: 'agent requests' }, {}, new Date('2026-11-20T12:00:00Z'));
      expect(withAgent).toMatchObject({ type: 'navigate', href: AGENT_REQUESTS_HREF });
    } finally {
      agentsHere.count = 0;
    }
  }, 60_000);
});

describe('page help for the agent screens', () => {
  // What the help screens show: the "What is this page?" bubble (components/Help.tsx) and the F1
  // window (components/ShortcutsHelp.tsx) read `what` and `first` only, so what a person must know
  // is checked there. `more` only adds detail (no screen shows it yet).
  const shown = (h: PageHelpEntry) => `${h.what} First: ${h.first}`;
  const all = (h: PageHelpEntry) => [h.what, h.first, ...(h.more ?? [])].join(' ');
  const points = (h: PageHelpEntry) => [h.what, h.first, ...(h.more ?? [])];
  /** Pause all agents shows only to whoever may use it (canPauseAll: an Admin): no point says otherwise. */
  const pauseAllForAdmins = (h: PageHelpEntry) => {
    for (const m of points(h)) if (/pause all/i.test(m)) expect(m, m).toMatch(/an Admin can/i);
  };
  /**
   * Pausing one agent, making it stricter and Revoke are open to whoever may change users, not to
   * every approver nor only to Admins (lib/services/agentPolicies.ts, agentGrants.ts): a point
   * that names them says who.
   */
  const pauseOneForUserManagers = (h: PageHelpEntry) => {
    for (const m of points(h)) {
      if (/pause an agent|stricter|Revoke/.test(m) && !/Pause this agent stops it/.test(m)) expect(m, m).toMatch(/Whoever (?:manages|may change) users/);
    }
    expect(all(h)).not.toMatch(/An Admin can (?:pause one|stop one)/i);
  };

  it('the approval center says, where it is shown: on its own vs asks, approve once or standing permission, pausing one or all, and the record', () => {
    const h = pageHelpFor(AGENT_REQUESTS_HREF)!;
    expect(h).toBe(PAGE_HELP[AGENT_REQUESTS_HREF]);
    const text = shown(h);
    expect(text).toMatch(/On its own an agent does only what its settings allow/);
    // Only what it must ask for comes here, not "the rest": work set to Never is refused unasked.
    expect(text).toMatch(/what it must ask for waits here, showing the change/);
    expect(text).not.toMatch(/the rest waits here/);
    expect(all(h)).toContain('Work set to Never is refused without asking');
    expect(text).toContain('Approve once');
    expect(text).toContain('Approve similar… (standing permission)');
    expect(text).toContain('Deny');
    // Every approver reads this; pausing one agent is for whoever may change users, all for an Admin.
    expect(text).toContain('Whoever manages users can pause an agent; an Admin can pause all.');
    expect(text).toContain('The Audit Trail and Agent Activity report keep the record');
    pauseAllForAdmins(h);
    pauseOneForUserManagers(h);
    // The extra detail: what standing permission is and never covers, what "the books changed"
    // means, where a reveal is logged, where to pause or Revoke, and the report's place.
    expect(all(h)).toMatch(/Approve similar… lets the agent do requests like this one by itself, within limits you tick, until the end of the day at most \(30 minutes for emails and printing\)/);
    expect(all(h)).toMatch(/Deleting, closed periods, settings, users, the company file and passwords are always asked one request at a time/);
    expect(all(h)).toMatch(/"The books changed since the agent asked" means a record the request uses was changed since\. It shows what would happen now/);
    // The trail keeps which kinds of values were shown, not the values (agentRequests.ts revealAudit).
    expect(all(h)).toMatch(/full Social Security or account numbers only through a request a person approves\. The Audit Trail says which kinds were shown, to which agent and who approved it/);
    expect(all(h)).toContain('pause an agent or Revoke standing permission in Users & Roles > Agents');
    expect(all(h)).toContain('Reports > Accountant & Taxes > Agent Activity');
  });

  it('the Agents tab: its own help, asked for as /users/agents, with the essentials in the part a bubble shows', () => {
    const h = pageHelpFor('/users/agents')!;
    expect(h).toBe(TAB_HELP['/users/agents']);
    expect(h.title).toBe('Agents');
    expect(pageHelpFor('/users')?.title).toBe('Users & Roles'); // the page's own help is unchanged
    const text = shown(h);
    for (const w of ['Allow (does it alone)', 'Ask (waits in Agent requests', 'approves once', 'standing permission', 'or Never', 'Pause this agent stops it', 'an Admin can pause all', 'The Audit Trail and Agent Activity report keep the record']) {
      expect(text, w).toContain(w);
    }
    pauseAllForAdmins(h);
    pauseOneForUserManagers(h);
    // The extra detail: the presets, who sees the tab, who may loosen, who may tighten, pause and
    // Revoke, what standing permission never covers, and the record of what was shown.
    for (const w of ['Read only', 'Ask for every change', 'Trusted bookkeeper', 'Full, with asks', 'Revoke']) expect(all(h), w).toContain(w);
    expect(all(h)).toContain('Anyone who may see Users & Roles > Users sees this tab.'); // app/users/page.tsx
    expect(all(h)).toMatch(/Only an Admin can add or remove an agent, or let one do more by itself/); // plan 4.4
    expect(all(h)).toContain('Whoever may change users can make an agent stricter, pause it, or Revoke standing permission it was given.');
    expect(all(h)).toMatch(/never given for deleting, closed periods, settings, users, the company file or passwords/);
    // Which kinds of numbers were shown and who approved: the trail never keeps the numbers.
    expect(all(h)).toContain('including which kinds of numbers were shown to it and who approved');
    expect(all(h)).not.toMatch(/including full numbers/);
    // No longer "only Admins see this tab".
    expect(all(h)).not.toMatch(/only (?:an )?Admins? (?:see|sees)/i);
  });

  it('is plain and short: two sentences, a first step, and a few short points', () => {
    for (const h of [PAGE_HELP[AGENT_REQUESTS_HREF], ...Object.values(TAB_HELP)]) {
      expect(h.what.length).toBeLessThanOrEqual(200);
      expect((h.what.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(2);
      expect(h.first.length).toBeLessThanOrEqual(130);
      expect(h.more?.length ?? 0).toBeLessThanOrEqual(6);
      for (const m of h.more ?? []) expect(m.length, m).toBeLessThanOrEqual(200);
      // No jargon a person would not use, and no blame.
      expect(all(h)).not.toMatch(/\b(token|grant|policy|risk class|operation|API|MCP)\b/i);
    }
  });
});

describe('Scheduled Reports: a schedule an agent set up', () => {
  const page = read('app/reports/schedules/page.tsx');

  it('reads the hold from the message the timer stores, as the service writes it', async () => {
    const start = /const AGENT_HOLD_START = '([^']+)';/.exec(page)?.[1];
    expect(start).toBeTruthy();
    const { AGENT_SCHEDULE_HELD_MESSAGE, SCHEDULE_HELD_MESSAGE } = await import('@/lib/services/memorizedReports');
    expect(AGENT_SCHEDULE_HELD_MESSAGE.startsWith(start!)).toBe(true);
    expect(SCHEDULE_HELD_MESSAGE.startsWith(start!)).toBe(false); // the internet hold is another reason
  }, 60_000);

  it('whether it waits is the server’s answer each time the list loads, not what the page remembers', () => {
    expect(page).toContain("if (typeof s.waitingForAPerson === 'boolean') return s.waitingForAPerson;");
    expect(page).not.toMatch(/setConfirmed|confirmedOver/);
    // The toast after a save promises nothing about the next run.
    expect(page).not.toMatch(/runs at its next due time/);
  });

  it('only the recipients Save sends what lets it run; Pause and Resume send isActive alone', () => {
    expect(page).toMatch(/api\.patch\(`\/api\/report-schedules\/\$\{id\}`, \{ emailTo: mailEdit\.value\.trim\(\) \|\| null \}\)/);
    expect(page).toMatch(/api\.patch\(`\/api\/report-schedules\/\$\{s\.id\}`, \{ isActive: !s\.isActive \}\)/);
    expect(page.match(/api\.patch\(/g)).toHaveLength(2);
  });
});

describe('on screen (a real browser engine)', () => {
  it('badge, menu entry, notice and Pause all agents', async () => {
    expectAllPassed(await runDomFile('test/dom/agentChrome.dom.tsx'), [
      'the badge shows the count in the title bar and on the menu entry, and hides at 0',
      'the menu entry shows only while the company has an agent',
      'a failed poll changes nothing on screen',
      'the notice is raised once per new request, and only when the window is not in front',
      'Pause all agents asks first, then calls the route; paused, it reads "Agents are paused" with Resume',
      'a refusal is said in its own words, and the confirmation stays',
      'a confirmation the poll took away does not open again by itself',
      'Pause all agents shows only to a person who may use it, and nothing polls on the sign-in page',
      'a minimized window still raises the notice',
      'the command bar: "go to agent requests" with no agent says where to connect one',
      'the command bar: with an agent, "go to agent requests" opens it',
      'the command bar: a server answer leading to a hidden Agent requests says why',
      'page help: F1 on Agent requests says how to pause agents and where the record is',
      'page help: the "What is this page?" bubble on Agent requests says the same',
      'page help: the Agents tab’s own header bubble says what a person needs, to someone who is not an Admin too',
      'Scheduled Reports: an agent’s schedule waits for you, and only Confirm recipients lets it run',
      'Scheduled Reports: with the server’s answer, a changed hold reason shows the current one',
      'Scheduled Reports: after a reload, or for another person, the server’s answer decides',
      'Scheduled Reports: a listing without the server’s answer errs towards waiting and promises nothing',
      'Scheduled Reports: with today’s server, a confirmed agent hold gives way to the current reason',
    ]);
  }, 240_000);
});
