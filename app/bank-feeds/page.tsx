'use client';
/**
 * Bank Feeds / Import — where bank transactions come into Ironbooks.
 *
 * Ironbooks never connects to your bank or a third-party feed service: transactions come in from
 * the statement files you download from your bank (OFX / QFX / QBO / CSV), from a spreadsheet
 * pasted into Batch Enter, or typed straight into an account register. Imported lines wait in
 * Review bank transactions, where suggested accounts (rules, your history, the learned model and
 * optional local AI) are confirmed before anything posts.
 */
import Link from 'next/link';
import { BookOpen, FileUp, ListChecks, Rss, Table2 } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import { Help } from '@/components/Help';

const PATHS = [
  {
    href: '/banking',
    icon: FileUp,
    title: 'Import a statement file',
    body: 'Download transactions from your bank’s website (OFX, QFX, QBO or CSV) and import them into a bank or credit card account. Lines already imported are skipped.',
    cta: 'Import a file',
  },
  {
    href: '/bank-review',
    icon: ListChecks,
    title: 'Review bank transactions',
    body: 'Confirm the suggested account for each imported line, match it to something you already entered, or exclude it. Nothing posts until you confirm.',
    cta: 'Review transactions',
  },
  {
    href: '/accountant/batch-enter',
    icon: Table2,
    title: 'Batch enter from a spreadsheet',
    body: 'Copy rows from Excel or Google Sheets and paste them in. Columns are matched by their headers.',
    cta: 'Open Batch Enter',
  },
  {
    href: '/registers',
    icon: BookOpen,
    title: 'Type into a register',
    body: 'Open any account’s register and enter transactions on the blank row at the bottom, like a checkbook.',
    cta: 'Open registers',
  },
];

export default function BankFeedsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Bank Feeds / Import" icon={Rss} />
      <p className="text-sm text-navy/60 mb-6 max-w-3xl">
        Ironbooks does not connect to your bank or to any feed service. Your bank data comes in only from files you choose,
        and it stays on this computer. At month end, reconcile <Help term="reconcile" side="bottom" /> each account against
        its statement.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {PATHS.map((p) => {
          const Icon = p.icon;
          return (
            <Card key={p.href} className="p-6 flex flex-col">
              <div className="flex items-center gap-3 mb-2">
                <Icon className="h-5 w-5 text-electric" />
                <h2 className="text-lg font-bold text-navy">{p.title}</h2>
              </div>
              <p className="text-sm text-navy/70 flex-1">{p.body}</p>
              <div className="mt-4">
                <Link
                  href={p.href}
                  className="inline-flex items-center justify-center gap-2 rounded-lg font-semibold bg-electric text-white hover:bg-electric/90 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-electric/50 focus-visible:ring-offset-1 px-4 py-2 text-sm"
                >
                  {p.cta}
                </Link>
              </div>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
