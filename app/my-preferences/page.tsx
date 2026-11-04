'use client';
/**
 * My Preferences (prefsperms review P2): every user's own preferences - the name and address
 * they send forms from, Bcc me, menu style, spelling, reminders and the rest of QuickBooks'
 * "My Preferences" tabs - on a page open to EVERY member of the company, like QB Edit >
 * Preferences > My Preferences. /settings (Company Preferences as well) needs Company &
 * Preferences, which the A/R Clerk, A/P Clerk, Banking and Payroll roles do not have; they are
 * the people who email forms. Saves through PATCH /api/preferences/my (any member).
 */
import * as React from 'react';
import { User } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { PREFERENCE_CATEGORIES } from '@/lib/preferences';
import PreferencePane from '@/app/settings/PreferencePane';

/** The QB categories that have a My Preferences side. */
const MY_CATEGORIES = PREFERENCE_CATEGORIES.filter((c) => c.my.length > 0 || Boolean(c.notes?.my));

export default function MyPreferencesPage() {
  const [tab, setTab] = React.useState<string>(() => MY_CATEGORIES.find((c) => c.id === 'sendForms')?.id ?? MY_CATEGORIES[0]?.id ?? '');

  // Deep links: /my-preferences?tab=sendForms.
  React.useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('tab');
    if (want && MY_CATEGORIES.some((c) => c.id === want)) setTab(want);
  }, []);

  return (
    <main className="p-6 md:p-8">
      <PageHeader title="My Preferences" icon={User} />
      <p className="mb-6 max-w-3xl text-sm text-navy/60">
        These settings only change how Ironbooks works for you, such as the name and email address your forms are sent
        from. Company-wide preferences are under Company &gt; Preferences (they need Company &amp; Preferences access).
      </p>
      <div className="flex max-w-5xl items-start gap-8">
        <nav
          aria-label="My Preferences categories"
          className="flex w-56 shrink-0 flex-col gap-0.5 rounded-2xl border border-slate-200/70 bg-white p-1.5 shadow-xl"
        >
          {MY_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-current={c.id === tab ? 'page' : undefined}
              onClick={() => setTab(c.id)}
              className={`rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                c.id === tab ? 'bg-electric font-medium text-white' : 'text-navy/75 hover:bg-navy/[.05] hover:text-navy'
              }`}
            >
              {c.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">{tab && <PreferencePane key={tab} categoryId={tab} accounts={[]} myOnly />}</div>
      </div>
    </main>
  );
}
