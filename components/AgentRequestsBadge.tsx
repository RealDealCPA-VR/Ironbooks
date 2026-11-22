'use client';
/**
 * Agent full access (plan §7.2): how many agent requests wait for THIS person. A count bubble on
 * the left menu's "Agent requests" entry (the default export, drawn like AttentionBadge) and a
 * button in the desktop window's title bar (TitleBarAgentRequests) that opens the approval center.
 *
 * One poll for the whole window: the title bar, the menu entry, Pause all agents and the menu's
 * "only while the company has an agent" rule all read the same answer of
 * GET /api/agent-requests/count (AgentRequestCount, lib/agent/contract.ts). It asks once at the
 * start, then about every 20 seconds while the window is on screen, and at once when it shows
 * again or when something says the requests changed (AGENT_REQUESTS_CHANGED_EVENT). A poll that
 * fails keeps the last answer: the person never sees an error from it, the number just waits for
 * the next good answer.
 *
 * While the window is hidden (minimized, in the tray, or covered so the system reports it hidden)
 * it still asks, slowly: every 90 seconds. That slow poll is there only for the desktop notice, which
 * matters most exactly then (plan 7.2: "when an agent asks and the window is not focused"); without
 * it a minimized window would never see a rise. The desktop app keeps Chromium's background timer
 * throttling, so a hidden window's ask may come up to a minute later than that; it is a notice, not
 * a deadline.
 *
 * When the number goes up while the window is not in front, a desktop notice (lib/desktop/
 * agentNotice.ts; nothing in a browser) names the agent and says what it asks in the app's own
 * words (AgentRequestCount.newest.summary, built from the operation), never the agent's own text,
 * and opens the approval center. Once per rise: the same number again, or a lower one, says nothing.
 * The first answer is where the window starts, never news.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import type { AgentRequestCount } from '@/lib/agent/contract';
import { showAgentRequestNotice } from '@/lib/desktop/agentNotice';
import { navigateGuarded } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';

/** The approval center (app/agent-requests/page.tsx) and the menu entry's path (lib/nav.ts). */
export const AGENT_REQUESTS_HREF = '/agent-requests';
export const AGENT_REQUESTS_COUNT_URL = '/api/agent-requests/count';
/** About how often the count is asked for while the window is on screen. */
export const AGENT_REQUESTS_POLL_MS = 20_000;
/** While the window is hidden: slowly, only so a rise can still raise the desktop notice. */
export const AGENT_REQUESTS_HIDDEN_POLL_MS = 90_000;
/**
 * Window event: requests were approved, denied or asked — ask for the count now instead of at the
 * next poll. Send it with agentRequestsChanged() (the approval center, after each decision).
 */
export const AGENT_REQUESTS_CHANGED_EVENT = 'ironbooks:agent-requests-changed';

/**
 * Tell the title bar and the menu that requests were decided (or asked), so their count is asked
 * for now rather than up to 20 seconds later. Safe anywhere: does nothing outside a browser window.
 */
export function agentRequestsChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(AGENT_REQUESTS_CHANGED_EVENT));
  } catch {
    /* the next poll brings the number anyway */
  }
}

export interface AgentNotice {
  title: string;
  body: string;
  href: string;
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * The route's answer as the window uses it, or null when it is not one (an error page, a sign-in
 * redirect, something half-built): such an answer is a failed poll. Fails closed: Pause all agents
 * shows only when the answer says `canPauseAll: true` in so many words.
 */
export function readAgentRequestCount(v: unknown): AgentRequestCount | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const pending = count(o.pending);
  const agents = count(o.agents);
  if (pending === null || agents === null) return null;
  const n = o.newest;
  let newest: AgentRequestCount['newest'] = null;
  if (n && typeof n === 'object') {
    const r = n as Record<string, unknown>;
    if (typeof r.id === 'string' && typeof r.agentName === 'string' && typeof r.summary === 'string') {
      newest = { id: r.id, agentName: r.agentName, summary: r.summary, createdAt: typeof r.createdAt === 'string' ? r.createdAt : '' };
    }
  }
  return { pending, newest, agents, allPaused: o.allPaused === true, canPauseAll: o.canPauseAll === true };
}

function sameCount(a: AgentRequestCount, b: AgentRequestCount): boolean {
  return (
    a.pending === b.pending &&
    a.agents === b.agents &&
    a.allPaused === b.allPaused &&
    a.canPauseAll === b.canPauseAll &&
    a.newest?.id === b.newest?.id &&
    a.newest?.agentName === b.newest?.agentName &&
    a.newest?.summary === b.newest?.summary
  );
}

/** One line of plain text, at most `max` characters. */
function oneLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The desktop notice for a rise: the agent's name and the app's own summary of what it asks
 * (never the agent's reason), and a click opens the approval center. `added`: how many more
 * requests wait than at the last answer.
 */
export function agentRequestNotice(newest: NonNullable<AgentRequestCount['newest']>, added = 1): AgentNotice {
  const name = oneLine(newest.agentName, 60) || 'An agent';
  // One line: the desktop shell shows the body as a single line (electron/agentShell.js).
  const summary = oneLine(newest.summary, 180).replace(/[.\s]+$/, '') || 'A request is waiting in Agent requests';
  const more = added > 1 ? ` (and ${added - 1} more)` : '';
  return {
    title: `${name} asks for your approval`,
    body: `${summary}${more}. Click to review ${added > 1 ? 'them' : 'it'}.`,
    href: AGENT_REQUESTS_HREF,
  };
}

/** "1 agent request waits for your approval" / "3 agent requests wait for your approval". */
export function pendingLabel(n: number): string {
  return n === 1 ? '1 agent request waits for your approval' : `${n} agent requests wait for your approval`;
}

// ---------------------------------------------------------------------------
// The poll, shared by everything in the window
// ---------------------------------------------------------------------------

/** What the poll needs from the window; the tests hand it a fake one. */
export interface AgentCountEnv {
  /** One read of the count route: the parsed body, or null when it failed. May throw. */
  load: () => Promise<unknown>;
  /** The window is on screen (not minimized or hidden). */
  visible: () => boolean;
  /** The window is in front, with the keyboard. */
  focused: () => boolean;
  notice: (n: AgentNotice) => void;
  /** Start listening for the window showing or hiding, and for AGENT_REQUESTS_CHANGED_EVENT. Returns the undo. */
  watch: (on: { visibility: () => void; changed: () => void }) => () => void;
  pollMs?: number;
  /** The poll's interval while the window is hidden (AGENT_REQUESTS_HIDDEN_POLL_MS). */
  hiddenPollMs?: number;
}

export interface AgentCountStore {
  /** The last good answer (null until the first one). The same object until something changes. */
  get: () => AgentRequestCount | null;
  /** The first subscriber starts the poll, the last one leaving stops it. */
  subscribe: (listener: () => void) => () => void;
  /** Ask now (a poll already on its way is followed by one more). */
  refresh: () => Promise<void>;
  /** After Pause all agents or Resume: show the new state at once; the next answer confirms it. */
  setAllPaused: (paused: boolean) => void;
}

export function createAgentRequestCountStore(env: AgentCountEnv): AgentCountStore {
  const pollMs = env.pollMs ?? AGENT_REQUESTS_POLL_MS;
  const hiddenPollMs = env.hiddenPollMs ?? AGENT_REQUESTS_HIDDEN_POLL_MS;
  const listeners = new Set<() => void>();
  let current: AgentRequestCount | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unwatch: (() => void) | null = null;
  let running = false;
  let again = false;

  const emit = () => {
    for (const l of Array.from(listeners)) l();
  };
  const visible = () => {
    try {
      return env.visible();
    } catch {
      return false;
    }
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** The next ask: soon while the window is on screen, slowly while it is hidden (for the notice). */
  const schedule = () => {
    clearTimer();
    if (listeners.size === 0) return;
    timer = setTimeout(
      () => {
        timer = null;
        void poll();
      },
      visible() ? pollMs : hiddenPollMs,
    );
  };

  function take(answer: AgentRequestCount) {
    const before = current;
    if (before && sameCount(before, answer)) return;
    current = answer;
    // Once per rise, and only when the person is not already looking at the window.
    if (before && answer.pending > before.pending && answer.newest) {
      let inFront = true;
      try {
        inFront = env.focused();
      } catch {
        /* unknown: no notice */
      }
      if (!inFront) {
        try {
          env.notice(agentRequestNotice(answer.newest, answer.pending - before.pending));
        } catch {
          /* the window keeps working without the notice */
        }
      }
    }
    emit();
  }

  async function poll(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimer();
    let answer: AgentRequestCount | null = null;
    try {
      answer = readAgentRequestCount(await env.load());
    } catch {
      answer = null; // a failed poll: the last answer stays, nothing is said
    }
    running = false;
    if (answer) take(answer);
    if (again) {
      again = false;
      if (listeners.size > 0) return poll();
    }
    schedule();
  }

  function onVisibility() {
    // Shown again: ask now. Hidden: the next ask moves to the slow interval (a poll on its way
    // schedules it when it lands).
    if (visible()) void poll();
    else if (!running) schedule();
  }

  function start() {
    unwatch = env.watch({ visibility: onVisibility, changed: () => void poll() });
    // At once, on screen or not: a window that starts hidden needs where it starts, or the first
    // rise it sees would be taken for that and raise no notice.
    void poll();
  }

  function stop() {
    unwatch?.();
    unwatch = null;
    clearTimer();
  }

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) stop();
      };
    },
    refresh: () => poll(),
    setAllPaused(paused) {
      if (!current || current.allPaused === paused) return;
      current = { ...current, allPaused: paused };
      emit();
    },
  };
}

const browserEnv: AgentCountEnv = {
  load: async () => {
    const res = await fetch(AGENT_REQUESTS_COUNT_URL, { cache: 'no-store' });
    return res.ok ? res.json() : null;
  },
  visible: () => typeof document !== 'undefined' && document.visibilityState !== 'hidden',
  focused: () => typeof document === 'undefined' || document.hasFocus(),
  notice: (n) => showAgentRequestNotice(n),
  watch({ visibility, changed }) {
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener(AGENT_REQUESTS_CHANGED_EVENT, changed);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener(AGENT_REQUESTS_CHANGED_EVENT, changed);
    };
  },
};

let shared: AgentCountStore | null = null;

/** The window's one poll (made on first use; it touches the window only once something subscribes). */
export function agentRequestCountStore(): AgentCountStore {
  if (!shared) shared = createAgentRequestCountStore(browserEnv);
  return shared;
}

const noCount = () => null;
const noSubscription = () => () => {};

/**
 * The count for this window, or null until the first good answer. `enabled` false (sign-in and the
 * other pages without the app's menus): no poll, and null.
 */
export function useAgentRequestCount(enabled = true): AgentRequestCount | null {
  const store = agentRequestCountStore();
  const value = React.useSyncExternalStore(enabled ? store.subscribe : noSubscription, store.get, noCount);
  return enabled ? value : null;
}

// ---------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------

/** Count bubble on the left menu's "Agent requests" entry. Shows nothing while zero or unknown. */
export default function AgentRequestsBadge() {
  const pending = useAgentRequestCount()?.pending ?? 0;
  if (!pending) return null;
  const shown = pending > 99 ? '99+' : String(pending);
  const label = pendingLabel(pending);
  return (
    <>
      {/* Wide sidebar: a pill after the label. */}
      <span
        className="ml-auto hidden lg:inline-flex min-w-[1.5rem] justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white tabular-nums"
        aria-label={label}
        title={label}
        data-agent-requests-badge="menu"
      >
        {shown}
      </span>
      {/* Icon-only sidebar: a dot on the icon. */}
      <span className="lg:hidden absolute right-1.5 top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" aria-hidden="true" />
      <span className="sr-only lg:hidden">{label}</span>
    </>
  );
}

/**
 * The title bar's button: shown only while requests wait for this person; a click opens the
 * approval center (asking first when a form is being typed, like the menu's links).
 */
export function TitleBarAgentRequests({ enabled = true, className }: { enabled?: boolean; className?: string }) {
  const router = useRouter();
  const pending = useAgentRequestCount(enabled)?.pending ?? 0;
  if (!pending) return null;
  const shown = pending > 99 ? '99+' : String(pending);
  const label = pendingLabel(pending);
  return (
    <button
      type="button"
      onClick={() => navigateGuarded(AGENT_REQUESTS_HREF, (h) => router.push(h))}
      title={`${label}. Click to review.`}
      aria-label={`${label}. Open Agent requests.`}
      data-agent-requests-badge="titlebar"
      className={cn(
        'app-no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-navy/80 outline-none transition-colors hover:bg-navy/[.07] hover:text-navy focus-visible:ring-2 focus-visible:ring-electric/50',
        className,
      )}
    >
      <Bot className="h-3.5 w-3.5 text-electric" aria-hidden="true" />
      <span className="hidden lg:inline">Agent requests</span>
      <span className="min-w-[1.25rem] rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-white tabular-nums">
        {shown}
      </span>
    </button>
  );
}
