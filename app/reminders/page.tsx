'use client';
/**
 * Reminders (QB Company > Reminders). What shows (summary, full list, or nothing) and how far
 * ahead each category looks is set in Preferences > Reminders.
 */
import Link from 'next/link';
import { Bell, Settings } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import RemindersList from '@/components/RemindersList';

export default function RemindersPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Reminders"
        icon={Bell}
        action={
          <Link href="/settings" className="flex items-center gap-1.5 text-sm font-semibold text-electric hover:underline">
            <Settings className="h-4 w-4" /> Choose what to show
          </Link>
        }
      />
      <Card className="max-w-3xl p-6">
        <RemindersList />
      </Card>
    </main>
  );
}
