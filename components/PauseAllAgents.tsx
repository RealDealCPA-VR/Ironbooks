'use client';
/**
 * Agent full access (plan §7.1): "Pause all agents" in the window's title bar. It is the
 * Integrated Applications switch of the company (AgentRequestCount.allPaused), made one click
 * away: while it is on, every agent is refused everything until a person resumes them.
 *
 * Shown whenever the company has an agent and this person may use the switch (canPauseAll, from
 * the same poll as the request badge: components/AgentRequestsBadge.tsx). One click and a short
 * confirmation; paused, it reads "Agents are paused" with Resume, which asks too (resuming hands
 * the agents their access back). POST /api/agents/pause-all { paused }. The server decides who
 * may: a refusal is shown in its own words in the confirmation, which stays open.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { CirclePause } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { ConfirmDialog } from '@/components/ui';
import { cn } from '@/lib/utils';
import { agentRequestCountStore, useAgentRequestCount } from './AgentRequestsBadge';

export const PAUSE_ALL_URL = '/api/agents/pause-all';

const ASK = {
  pause: {
    title: 'Pause all agents?',
    message: 'Every agent connected to this company stops at once: whatever it asks is refused until you resume them. Nothing an agent already did is undone.',
    confirm: 'Pause all agents',
    failed: 'The agents could not be paused just now. Try again in a moment.',
  },
  resume: {
    title: 'Resume all agents?',
    message: 'Agents can work again, each within its own permissions. An agent you paused on its own stays paused.',
    confirm: 'Resume',
    failed: 'The agents could not be resumed just now. Try again in a moment.',
  },
} as const;

/** The server's own words when it answered; otherwise a plain next step. */
function failureText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status > 0 && err.message.trim()) return err.message;
  return fallback;
}

export default function PauseAllAgents({ enabled = true, className }: { enabled?: boolean; className?: string }) {
  const count = useAgentRequestCount(enabled);
  const [asking, setAsking] = React.useState<'pause' | 'resume' | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const shown = !!count && count.agents >= 1 && count.canPauseAll;

  // A poll that takes the switch away (the last agent removed, or this person may no longer use
  // it) closes an open confirmation for good: it must not come back by itself when the switch does.
  React.useEffect(() => {
    if (shown) return;
    setAsking(null);
    setError(null);
  }, [shown]);

  if (!shown) return null;
  const paused = count.allPaused;

  function ask(what: 'pause' | 'resume') {
    setError(null);
    setAsking(what);
  }

  function close() {
    if (busy) return;
    setAsking(null);
    setError(null);
  }

  async function confirm() {
    if (!asking || busy) return;
    const pause = asking === 'pause';
    setBusy(true);
    setError(null);
    try {
      await api.post<{ paused: boolean }>(PAUSE_ALL_URL, { paused: pause }, { noUndo: true });
      const store = agentRequestCountStore();
      store.setAllPaused(pause);
      void store.refresh();
      setAsking(null);
    } catch (err) {
      setError(failureText(err, ASK[asking].failed));
    } finally {
      setBusy(false);
    }
  }

  const words = asking ? ASK[asking] : null;
  const dialog =
    words && typeof document !== 'undefined'
      ? createPortal(
          <ConfirmDialog
            open
            title={words.title}
            message={
              <>
                {words.message}
                {error && (
                  <span role="alert" className="mt-3 block rounded-md bg-red-50 px-3 py-2 text-red-700" data-pause-all-error>
                    {error}
                  </span>
                )}
              </>
            }
            confirmLabel={words.confirm}
            loading={busy}
            onConfirm={() => void confirm()}
            onClose={close}
          />,
          document.body,
        )
      : null;

  return (
    <>
      {paused ? (
        <div
          role="status"
          data-agents-paused
          className={cn('app-no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-amber-100/80 pl-2 pr-1 text-[12px] font-medium text-amber-900', className)}
        >
          <CirclePause className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Agents are paused</span>
          <button
            type="button"
            onClick={() => ask('resume')}
            title="Let the agents work again"
            className="h-5 rounded px-1.5 text-[12px] font-semibold text-amber-950 underline-offset-2 outline-none hover:bg-amber-200/80 hover:underline focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            Resume
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => ask('pause')}
          title="Stop every agent at once (Integrated Applications)"
          data-pause-all-agents
          className={cn(
            'app-no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-navy/80 outline-none transition-colors hover:bg-navy/[.07] hover:text-navy focus-visible:ring-2 focus-visible:ring-electric/50',
            className,
          )}
        >
          <CirclePause className="h-3.5 w-3.5 text-navy/60" aria-hidden="true" />
          <span>Pause all agents</span>
        </button>
      )}
      {/* In <body>: the title bar is a drag area and keeps its text from being selected. */}
      {dialog}
    </>
  );
}
