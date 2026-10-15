/**
 * Tabs at the top of Home (team home): "Needs attention" first, then "Overview". Plain links, so
 * they work from server components and with the browser's back button.
 */
import Link from 'next/link';
import { HOME_TAB_HREF, type HomeTab } from '@/lib/homeTabs';

export default function HomeTabs({ active, attentionCount }: { active: HomeTab; attentionCount?: number }) {
  const tab = (key: HomeTab, label: string, count?: number) => (
    <Link
      href={HOME_TAB_HREF[key]}
      aria-current={active === key ? 'page' : undefined}
      className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-electric/50 rounded-t ${
        active === key ? 'border-electric text-electric' : 'border-transparent text-navy/60 hover:text-navy'
      }`}
    >
      {label}
      {count ? (
        <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white tabular-nums">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
  return (
    <nav aria-label="Home views" className="mb-6 flex gap-1 border-b border-slate-200">
      {tab('attention', 'Needs attention', attentionCount)}
      {tab('overview', 'Overview')}
    </nav>
  );
}
