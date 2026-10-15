'use client';
/**
 * Count bubble on the sidebar's "Needs attention" link (team home). Reads GET /api/attention/count
 * on load, every two minutes, when the window regains focus and whenever the inbox changes
 * something (ATTENTION_CHANGED_EVENT). Shows nothing while zero or unavailable.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ATTENTION_CHANGED_EVENT } from '@/lib/attentionKinds';

export default function AttentionBadge() {
  const [count, setCount] = useState<number | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/attention/count', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setCount(typeof d?.count === 'number' ? d.count : null);
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 120_000);
    window.addEventListener(ATTENTION_CHANGED_EVENT, load);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(ATTENTION_CHANGED_EVENT, load);
      window.removeEventListener('focus', load);
    };
    // Navigating (e.g. after paying a bill on its own screen) refreshes the count too.
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
