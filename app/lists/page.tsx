'use client';
/**
 * Lists — /lists
 *
 * One place for QuickBooks' smaller lists: Terms, Other Names, Customer / Vendor / Job Types,
 * Sales Tax Codes, Payment Methods, Ship Via, Customer Messages and Vehicles, plus links to the
 * list tools (Billing Rate Levels, Units of Measure, To Do, Add/Edit Multiple, Clean Up).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ListChecks, Ruler, Timer, Table2, Eraser, BadgeDollarSign, ClipboardCheck } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import { SimpleListEditor } from '@/components/lists/SimpleListEditor';
import { LIST_SPECS } from '@/lib/lists/listSpecs';
import { cn } from '@/lib/utils';

const TOOLS = [
  { href: '/todos', label: 'To Do list', icon: ClipboardCheck, text: 'Reminders to call, email or follow up.' },
  { href: '/lists/multiple', label: 'Add/Edit Multiple', icon: Table2, text: 'Type or paste many customers, vendors or items at once.' },
  { href: '/lists/billing-rates', label: 'Billing Rate Levels', icon: Timer, text: 'Hourly rates used when billing time.' },
  { href: '/lists/uom', label: 'Units of Measure', icon: Ruler, text: 'Each, case of 12, box of 100…' },
  { href: '/lists/item-prices', label: 'Change Item Prices', icon: BadgeDollarSign, text: 'Raise or lower many prices at once.' },
  { href: '/lists/cleanup', label: 'Clean Up Lists', icon: Eraser, text: 'Remove inactive entries nothing uses.' },
];

export default function ListsPage() {
  const [active, setActive] = useState(LIST_SPECS[0].key);

  // Deep link: /lists?list=terms
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get('list');
    if (k && LIST_SPECS.some((s) => s.key === k)) setActive(k);
  }, []);

  const spec = LIST_SPECS.find((s) => s.key === active) ?? LIST_SPECS[0];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Lists" icon={ListChecks} />
      <div className="flex flex-col gap-6 lg:flex-row">
        <nav aria-label="Lists" className="lg:w-56 shrink-0">
          <Card className="p-2">
            <ul className="flex flex-col">
              {LIST_SPECS.map((s) => (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setActive(s.key);
                      window.history.replaceState(null, '', `/lists?list=${s.key}`);
                    }}
                    aria-current={s.key === active ? 'page' : undefined}
                    className={cn(
                      'w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-navy hover:bg-navy/5',
                      s.key === active && 'bg-electric/10 text-electric',
                    )}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </nav>
        <div className="min-w-0 flex-1">
          <SimpleListEditor key={spec.key} spec={spec} />
          <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-navy/50">List tools</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {TOOLS.map((t) => (
              <Link key={t.href} href={t.href} className="block">
                <Card className="h-full p-4 transition-colors hover:bg-electric/5">
                  <div className="flex items-center gap-2 font-semibold text-navy">
                    <t.icon className="h-4 w-4 text-electric" /> {t.label}
                  </div>
                  <p className="mt-1 text-sm text-navy/60">{t.text}</p>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
