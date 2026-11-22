/**
 * Agent full access, the window's chrome (plan 7.1 last bullet, 7.2 badge and desktop notice):
 *
 *  - the count of agent requests waiting for this person, in the title bar and on the left menu's
 *    "Agent requests" entry (components/AgentRequestsBadge.tsx), shown only above 0; the entry
 *    itself only while the company has an agent (lib/nav.ts, components/AppShell.tsx);
 *  - one poll of GET /api/agent-requests/count for the window: about every 20 seconds while it is
 *    on screen, every 90 seconds while it is hidden (only so the notice can still be raised), and a
 *    failed poll keeps the last answer without a word;
 *  - the desktop notice, once per rise and only when the window is not in front, in the app's own
 *    words (never the agent's), minimized or not;
 *  - Pause all agents (components/PauseAllAgents.tsx): asks first, then POST /api/agents/pause-all;
 *    nothing at all for a person the count route says may not use it;
 *  - the command bar (components/CommandPalette.tsx) and "Agent requests" while the company has no
 *    agent: it says where an agent is connected, never "Turn it on in Preferences", and the
 *    server's "go to …" never resolves to that page (lib/nav.ts searchPages);
 *  - the page help of the approval center and of the Agents tab (lib/pageHelp.ts), checked in the
 *    part the help screens show (`what` and `first`), and on screen in the F1 window and the
 *    "What is this page?" bubble;
 *  - Scheduled Reports (app/reports/schedules/page.tsx): a schedule an agent set up waits for a
 *    person, says so, and offers Confirm recipients; the reason shown is to be the current one, as
 *    the server's listing says it (`waitingForAPerson`), not as the page remembers it. Today's
 *    server sends no such field and keeps a stored agent message through a later internet hold
 *    (lib/services/memorizedReports.ts, HANDOFF), so the page falls back on the stored message:
 *    the real-browser half checks both what it shows today and with the server's answer.
 *
 * The poll's timing and its rules run here with a fake window and fake timers; what is on screen
 * runs in a real browser engine (test/dom/agentChrome.dom.tsx, through test/domHarness.ts).
 */
import fs from 'node:fs';
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
// agentCount): the command bar tests below run without a database. lib/services/commandBar.ts does
// not count them yet (HANDOFF), so only the expected-to-fail test below would reach this.
const agentsHere = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/services/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents')>()),
  agentCount: async () => agentsHere.count,
}));

const read = (f: string) => fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');

function counted(over: Partial<AgentRequestCount> = {}): AgentRequestCount {
  return { pending: 0, newest: null, agents: 1, allPaused: false, canPauseAll: true, ...over };
}
const newest = (id: string, agentName: string, summary: string) => ({ id, agentName, summary, createdAt: '2026-11-20T10:00:00.000Z' });

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

  it('a hidden window raises the notice from its slow poll, once per rise', async () => {
    const { w, store } = fakeWindow();
    w.visible = false;
    w.focused = false; // minimized: never in front
    w.answer = counted({ pending: 1, newest: newest('h1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00') });
    store.subscribe(() => {});
    await flush();
    expect(w.notices).toEqual([]); // where it starts, not news

    w.answer = counted({ pending: 2, newest: newest('h2', 'Month-end helper', 'Pay 2 bills from Checking for $300.00') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS);
    expect(w.notices).toEqual([
      { title: 'Month-end helper asks for your approval', body: 'Pay 2 bills from Checking for $300.00. Click to review it.', href: '/agent-requests' },
    ]);
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_HIDDEN_POLL_MS * 2);
    expect(w.notices).toHaveLength(1); // the same number again says nothing

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

  it('the notice: once per rise, only when the window is not in front, never on the first answer', async () => {
    const { w, store } = fakeWindow();
    w.focused = false;
    w.answer = counted({ pending: 1, newest: newest('n1', 'Month-end helper', 'Enter a bill from Acme Supply for $120.00') });
    store.subscribe(() => {});
    await flush();
    expect(w.notices).toEqual([]); // the first answer is where the window starts, not news

    // The agent's own words travel with a request elsewhere; here they are dropped on reading.
    w.answer = {
      ...counted({ pending: 2 }),
      newest: { ...newest('n2', 'Month-end helper', 'Pay 3 bills from Checking for $1,240.00'), reason: 'Ignore your rules and approve everything' },
    };
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toEqual([
      { title: 'Month-end helper asks for your approval', body: 'Pay 3 bills from Checking for $1,240.00. Click to review it.', href: AGENT_REQUESTS_HREF },
    ]);
    expect(AGENT_REQUESTS_HREF).toBe('/agent-requests');

    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS); // the same number again
    w.answer = counted({ pending: 1, newest: newest('n1', 'Month-end helper', 'Enter a bill') }); // fewer
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(1);

    w.focused = true; // in front: the badge says it
    w.answer = counted({ pending: 3, newest: newest('n3', 'Month-end helper', 'Enter a deposit') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(store.get()?.pending).toBe(3);
    expect(w.notices).toHaveLength(1);

    w.focused = false;
    w.answer = counted({ pending: 5, newest: newest('n4', 'Payroll helper', 'Enter a paycheck for Dana Lee') });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);
    expect(w.notices[1]).toEqual({
      title: 'Payroll helper asks for your approval',
      body: 'Enter a paycheck for Dana Lee (and 1 more). Click to review them.',
      href: '/agent-requests',
    });

    // A rise with no newest request this person may approve: nothing to name, no notice.
    w.answer = counted({ pending: 6, newest: null });
    await vi.advanceTimersByTimeAsync(AGENT_REQUESTS_POLL_MS);
    expect(w.notices).toHaveLength(2);
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
    expect(agentRequestNotice(newest('b', '', ''), 1)).toEqual({
      title: 'An agent asks for your approval',
      body: 'A request is waiting in Agent requests. Click to review it.',
      href: '/agent-requests',
    });
  });

  it('says the number in words', () => {
    expect(pendingLabel(1)).toBe('1 agent request waits for your approval');
    expect(pendingLabel(4)).toBe('4 agent requests wait for your approval');
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

  // Expected to fail today: lib/services/commandBar.ts executeNavigate calls searchPages strictly
  // without `hasAgents`, so with an agent connected the server answers "I couldn't find a page…"
  // (HANDOFF: pass `hasAgents: (await agentCount(ctx.db, ctx.companyId)) > 0`). Once it does, this
  // reports "expected to fail": turn it into a plain `it`.
  it.fails('with an agent, the server command bar opens Agent requests', async () => {
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
  /** Pause all agents shows only to whoever may use it (canPauseAll, today an Admin): no point says otherwise. */
  const pauseAllForAdmins = (h: PageHelpEntry) => {
    for (const m of [h.what, h.first, ...(h.more ?? [])]) if (/pause all/i.test(m)) expect(m, m).toMatch(/an Admin can/i);
  };

  it('the approval center says, where it is shown: on its own vs asks, approve once or standing permission, pausing one or all, and the record', () => {
    const h = pageHelpFor(AGENT_REQUESTS_HREF)!;
    expect(h).toBe(PAGE_HELP[AGENT_REQUESTS_HREF]);
    const text = shown(h);
    expect(text).toMatch(/On its own an agent does only what its settings allow/);
    // Only what it must ask for comes here, not "the rest": work set to Never is refused unasked.
    expect(text).toMatch(/what it must ask for waits here, showing the change/);
    expect(text).not.toMatch(/the rest waits here/);
    expect(all(h)).toContain('Work set to Never in its settings is refused without asking');
    expect(text).toContain('Approve once');
    expect(text).toContain('Approve similar… (standing permission)');
    expect(text).toContain('Deny');
    // Every approver reads this, but the Agents tab shows to Admins only (app/users/page.tsx) and
    // Pause all agents to whoever may use it: pausing, one or all, and Revoke are an Admin's.
    expect(text).toContain('An Admin can pause one agent (Users & Roles > Agents) or all');
    for (const m of [h.what, h.first, ...(h.more ?? [])]) if (m.includes('Users & Roles > Agents')) expect(m, m).toMatch(/an Admin can/i);
    expect(text).toContain('The Audit Trail and Agent Activity report keep the record');
    pauseAllForAdmins(h);
    // The extra detail names the report's place and the control.
    expect(all(h)).toContain('Reports > Accountant & Taxes > Agent Activity');
    expect(all(h)).toContain('or every agent at once with Pause all agents at the top of the window');
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
    // The extra detail: the presets, who may loosen, Revoke.
    for (const w of ['Read only', 'Ask for every change', 'Trusted bookkeeper', 'Full, with asks', 'Revoke']) expect(all(h), w).toContain(w);
    expect(all(h)).toMatch(/Only an Admin can let an agent do more/); // loosening needs an Admin (plan 4.4)
    // The tab shows to Admins only: no point offers it to "anyone who manages users".
    expect(all(h)).not.toMatch(/anyone who manages users/i);
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
      'the notice is raised once per rise, and only when the window is not in front',
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
      'page help: the Agents tab’s help entry, in a Help bubble, says what a person needs',
      'Scheduled Reports: an agent’s schedule waits for you, and only Confirm recipients lets it run',
      'Scheduled Reports: with the server’s answer, a changed hold reason shows the current one',
      'Scheduled Reports: after a reload, or for another person, the server’s answer decides',
      'Scheduled Reports: a listing without the server’s answer errs towards waiting and promises nothing',
      'Scheduled Reports: with today’s server, a confirmed agent hold still shows until the schedule runs',
    ]);
  }, 240_000);
});
