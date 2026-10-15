'use client';
/**
 * Count bubble on the sidebar's "Needs attention" link (team home). Reads GET /api/attention/count
 * on load and whenever the inbox changes something (ATTENTION_CHANGED_EVENT, at once). Page
 * navigation, window focus and the two-minute timer also refresh it, but at most once every 30
 * seconds (lib/throttledRefresh.ts): the count runs every inbox query, so it must not run on
 * every click. A refresh that comes too soon is folded into one shortly after, so the number
 * still catches up (e.g. after paying a bill on its own screen). Shows nothing while zero or
 * unavailable.
 */
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ATTENTION_CHANGED_EVENT } from '@/lib/attentionKinds';
import { createThrottledRefresh, type ThrottledRefresh } from '@/lib/throttledRefresh';

export default function AttentionBadge() {
  const [count, setCount] = useState<number | null>(null);
  const pathname = usePathname();
  const refresher = useRef<ThrottledRefresh | null>(null);

  useEffect(() => {
    let cancelled = false;
    const r = createThrottledRefresh(() =>
      fetch('/api/attention/count', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((d) => {
          if (!cancelled) setCount(typeof d?.count === 'number' ? d.count : null);
        }),
    );
    refresher.current = r;
    r.request(true);
    const routine = () => r.request(false);
    const changed = () => r.request(true);
    const timer = window.setInterval(routine, 120_000);
    window.addEventListener(ATTENTION_CHANGED_EVENT, changed);
    window.addEventListener('focus', routine);
    return () => {
      cancelled = true;
      r.cancel();
      refresher.current = null;
      window.clearInterval(timer);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, changed);
      window.removeEventListener('focus', routine);
    };
  }, []);

  // Navigating (e.g. after paying a bill on its own screen) refreshes the count too (throttled).
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    refresher.current?.request(false);
  }, [pathname]);

  if (!count) return null;
  const shown = count > 99 ? '99+' : String(count);
  const label = `${count} ${count === 1 ? 'item needs' : 'items need'} attention`;
  return (
    <>
      {/* Wide sidebar: a pill after the label. */}
      <span
        className="ml-auto hidden lg:inline-flex min-w-[1.5rem] justify-center rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white tabular-nums"
        aria-label={label}
        title={label}
      >
        {shown}
      </span>
      {/* Icon-only sidebar: a dot on the icon. */}
      <span className="lg:hidden absolute right-1.5 top-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white" aria-hidden="true" />
      <span className="sr-only lg:hidden">{label}</span>
    </>
  );
}
