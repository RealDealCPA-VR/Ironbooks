'use client';

/**
 * Migrate from QuickBooks.
 *
 *   Step 1 (optional) — Lists: IIF / CSV import of the chart of accounts, customers, vendors,
 *                       items, classes, employees (ListImport.tsx, the original import page).
 *   Step 2 — History: the QuickBooks General Ledger report (Excel, CSV or PDF) becomes part of
 *                       the record, reconciled account by account (GlWizard.tsx).
 *
 * Everything runs on this computer: files are read locally and sent only to the local server.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Upload } from 'lucide-react';
import { Card, PageHeader } from '@/components/ui';
import { GlWizard } from './GlWizard';
import { ListImport } from './ListImport';

export default function QbImportPage() {
  const [showLists, setShowLists] = useState(false);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Migrate from QuickBooks" icon={Upload} />

      <div className="max-w-5xl mx-auto space-y-6">
        <Card className="p-6 space-y-2">
          <p className="text-navy">
            Move your books from QuickBooks Desktop in two steps. Your files never leave this computer.
          </p>
          <ol className="list-decimal pl-5 text-sm text-navy/70 space-y-1">
            <li>
              <b>Lists (optional):</b> bring over contact details and items from QuickBooks IIF or CSV exports.
            </li>
            <li>
              <b>History:</b> upload your General Ledger report. We rebuild every transaction, check that each one
              balances, and prove that every account ends with exactly the same balance as in QuickBooks before
              anything is saved.
            </li>
          </ol>
        </Card>

        <Card className="p-0 overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center justify-between p-6 text-left"
            aria-expanded={showLists}
            onClick={() => setShowLists((v) => !v)}
          >
            <span className="text-lg font-bold text-navy">Step 1 · Lists (IIF / CSV) — optional</span>
            {showLists ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </button>
          {showLists && (
            <div className="px-6 pb-6">
              <ListImport />
            </div>
          )}
        </Card>

        <div className="space-y-3">
          <h2 className="text-lg font-bold text-navy">Step 2 · History from your General Ledger</h2>
          <GlWizard />
        </div>
      </div>
    </main>
  );
}
