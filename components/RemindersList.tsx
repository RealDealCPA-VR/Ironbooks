'use client';
/**
 * <RemindersList /> — the Reminders list (used by /reminders and the dashboard): what needs attention today — checks to print, overdue
 * invoices, bills to pay, money to deposit, inventory to reorder, memorized transactions due,
 * to-dos, open orders. What shows (summary, full list, or nothing) and how far ahead each
 * category looks is set in Preferences > Reminders.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, ChevronDown, ChevronRight } from 'lucide-react';
import { EmptyState, PageSkeleton, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

interface ReminderItem {
  id: string;
  label: string;
  date: string | null;
  amount: string | null;
  href: string;
}
interface ReminderSection {
  key: string;
  label: string;
  mode: 'summary' | 'list';
  count: number;
  total: string | null;
  href: string;
  items: ReminderItem[];
}

export default function RemindersList({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<{ asOf: string; sections: ReminderSection[] } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api
      .get<{ asOf: string; sections: ReminderSection[] }>('/api/reminders')
      .then((d) => {
        setData(d);
        setOpen(Object.fromEntries(d.sections.map((s) => [s.key, s.mode === 'list'])));
      })
      .catch((err: ApiError) => {
        toast(err.message || 'Could not load reminders', 'danger');
        setData({ asOf: '', sections: [] });
      });
  }, []);

  if (!data) return compact ? <p className="text-sm text-navy/40">Loading reminders…</p> : <PageSkeleton rows={4} />;
  if (data.sections.length === 0) {
    return compact ? (
      <p className="text-sm text-navy/50">Nothing needs your attention right now.</p>
    ) : (
      <EmptyState icon={Bell} title="You're all caught up" message="Nothing needs your attention right now." />
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {data.sections.map((s) => {
        const isOpen = open[s.key];
        return (
          <li key={s.key} className="py-2">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}
                className="flex items-center gap-2 text-left text-sm font-semibold text-navy"
                aria-expanded={isOpen}
              >
                {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {s.label}
                <span className="rounded-full bg-electric/10 px-2 py-0.5 text-xs text-electric">{s.count}</span>
              </button>
              <span className="flex items-center gap-3 text-sm">
                {s.total !== null && <span className="tabular-nums text-navy/70">{formatCurrency(s.total)}</span>}
                <Link href={s.href} className="text-xs font-semibold text-electric hover:underline">
                  Open
                </Link>
              </span>
            </div>
            {isOpen && (
              <ul className="mt-2 ml-6 flex flex-col gap-1">
                {s.items.map((i) => (
                  <li key={`${s.key}-${i.id}-${i.date}`} className="flex items-center justify-between gap-3 text-sm">
                    <Link href={i.href} className="min-w-0 truncate text-navy/80 hover:text-electric hover:underline">
                      {i.date && <span className="mr-2 tabular-nums text-navy/40">{i.date}</span>}
                      {i.label}
                    </Link>
                    {i.amount !== null && <span className="shrink-0 tabular-nums text-navy/70">{formatCurrency(i.amount)}</span>}
                  </li>
                ))}
                {s.count > s.items.length && (
                  <li className="text-xs text-navy/40">…and {s.count - s.items.length} more</li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
