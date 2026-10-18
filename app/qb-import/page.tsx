'use client';

/**
 * Migrate from QuickBooks.
 *
 *   Step 1 (optional) — Lists: IIF / CSV / Excel import of the chart of accounts (full
 *                       hierarchy), customers & jobs, vendors, items, classes, employees and the
 *                       other QuickBooks lists (ListImport.tsx).
 *   Step 2 — History: the QuickBooks General Ledger report (Excel, CSV or PDF) becomes part of
 *                       the record, reconciled account by account (GlWizard.tsx).
 *   Step 3 — Open invoices & bills: unpaid invoices / bills become real documents without
 *                       changing the A/R and A/P totals (OpenItemsImport.tsx).
 *   Step 4 — Export: any list (or the journal) back out as CSV / Excel / IIF (ExportLists.tsx).
 *   Payroll year-to-date amounts are entered on Payroll › Setup (app/employees/setup).
 *
 * Everything runs on this computer: files are read locally and sent only to the local server.
 */
import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Upload } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import { GlWizard } from './GlWizard';
import { ListImport } from './ListImport';
import { OpenItemsImport } from './OpenItemsImport';
import { ExportLists } from './ExportLists';

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between p-6 text-left"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="text-lg font-bold text-navy">{title}</span>
        {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
    </Card>
  );
}

export default function QbImportPage() {
  const [showLists, setShowLists] = useState(false);
  const [showOpenItems, setShowOpenItems] = useState(false);
  const [showExport, setShowExport] = useState(false);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Migrate from QuickBooks" icon={Upload} />

      <div className="max-w-5xl mx-auto space-y-6">
        <Card className="p-6 space-y-2">
          <p className="text-navy">
            Move your books from QuickBooks Desktop step by step. Your files never leave this computer.
          </p>
          <ol className="list-decimal pl-5 text-sm text-navy/70 space-y-1">
            <li>
              <b>Lists (optional):</b> bring over accounts, customers and jobs, vendors, items and employees from
              QuickBooks IIF, CSV or Excel exports.
            </li>
            <li>
              <b>History:</b> upload your General Ledger report. We rebuild every transaction, check that each one
              balances, and prove that every account ends with exactly the same balance as in QuickBooks before
              anything is saved.
            </li>
            <li>
              <b>Open invoices and bills:</b> bring each unpaid invoice and bill over as a real document so you can
              receive payments and pay bills right away — your totals stay exactly the same.
            </li>
            <li>
              <b>Payroll mid-year?</b> Enter each employee&apos;s year-to-date pay on{' '}
              <Link href="/employees/setup" className="text-electric underline">
                Payroll setup
              </Link>{' '}
              so W-2s, 941s and wage limits are right.
            </li>
          </ol>
        </Card>

        <Section title="Step 1 · Lists (IIF / CSV / Excel) — optional" open={showLists} onToggle={() => setShowLists((v) => !v)}>
          <ListImport />
        </Section>

        <div className="space-y-3">
          <h2 className="text-lg font-bold text-navy">Step 2 · History from your General Ledger</h2>
          <GlWizard />
        </div>

        <Section title="Step 3 · Open invoices and unpaid bills" open={showOpenItems} onToggle={() => setShowOpenItems((v) => !v)}>
          <OpenItemsImport />
        </Section>

        <Section title="Export lists and transactions" open={showExport} onToggle={() => setShowExport((v) => !v)}>
          <ExportLists />
        </Section>
      </div>
    </main>
  );
}
