'use client';
/**
 * Period Copy (QB "Period Copy", PARITY I7): save a portable company file that holds only one
 * date range — opening balances for everything before it, nothing after it — for an auditor or
 * an outside accountant. The open company file is not changed.
 */
import { useState } from 'react';
import { CalendarRange, FileDown } from 'lucide-react';
import { Button, Card, DateInput, Label, PageHeader, toast, toastError } from '@/components/ui';
import { niceDate, postAndSave } from '@/lib/accountantCopyClient';
import { formatCurrency } from '@/lib/money';
import { BackToCenter, lastCalendarYear } from '../_shared';

interface Summary {
  from: string;
  to: string;
  companyName: string;
  removedAfter: { journalEntries: number; documents: number };
  condensed: { entries: number; summaryEntries: number; keptOpenDocumentEntries: number } | null;
  otherCompaniesRemoved: number;
  verified: {
    openingTrialBalance: { totalDebit: string; totalCredit: string };
    closingTrialBalance: { totalDebit: string; totalCredit: string };
    accountsCompared: number;
  };
}

export default function PeriodCopyPage() {
  const [from, setFrom] = useState(lastCalendarYear().from);
  const [to, setTo] = useState(lastCalendarYear().to);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const invalid = !from || !to || from > to;

  async function create() {
    setBusy(true);
    setSummary(null);
    try {
      const res = await postAndSave('/api/period-copy', { from, to }, 'Period Copy.bkp', {
        name: 'Ironbooks Portable Company File',
        extensions: ['bkp'],
      });
      const raw = res.headers.get('X-Period-Copy-Summary');
      if (raw) {
        try {
          setSummary(JSON.parse(decodeURIComponent(raw)) as Summary);
        } catch {
          /* the file itself is what matters */
        }
      }
      if (res.saved) toast(`Period Copy saved: ${res.saved}`, 'success');
    } catch (err) {
      toastError(err, 'Could not create the Period Copy.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Period Copy" icon={CalendarRange} />
      <p className="mb-6 max-w-3xl text-sm text-navy/60">
        Make a separate copy of your company file that shows only one period — for example last year, for your auditor. Everything before
        the start date becomes opening balances, everything after the end date is left out, and the copy is checked against your books
        before it is saved. Your own company file is not changed.
      </p>

      <Card className="mb-6 p-6">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="flex flex-wrap gap-4">
              <div>
                <Label htmlFor="pc-from" required>
                  First day
                </Label>
                <DateInput id="pc-from" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="pc-to" required>
                  Last day
                </Label>
                <DateInput id="pc-to" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            {from && to && from > to && (
              <p className="mt-2 text-sm text-red-600" role="alert">
                The first day must be on or before the last day.
              </p>
            )}
            <Button className="mt-5" onClick={create} loading={busy} disabled={invalid}>
              <FileDown className="h-4 w-4" aria-hidden="true" /> Create Period Copy…
            </Button>
            <p className="mt-2 text-xs text-navy/50">This can take a minute for a large file.</p>
          </div>
          <div className="text-sm text-navy/70">
            <p className="font-semibold text-navy">What the copy contains</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>All transactions dated from {niceDate(from) || 'the first day'} to {niceDate(to) || 'the last day'}.</li>
              <li>
                Opening balances for everything before: earlier detail is summarized month by month, like Condense Data. Invoices, bills and
                other items still open on the first day keep their detail.
              </li>
              <li>Nothing dated after the last day. An invoice paid after it shows as still open, as it was on that day.</li>
              <li>Only this company — other companies in the file are left out.</li>
              <li>The copy&apos;s closing date is set to the last day, so nothing is added to the period by mistake.</li>
            </ul>
            <p className="mt-3 text-xs text-navy/50">
              The copy is a portable company file (.bkp). Open it on any computer with Company File → Open Portable File. It holds the users
              and passwords of this file, so only an admin can create it — keep it private.
            </p>
          </div>
        </div>
      </Card>

      {summary && (
        <Card className="mb-6 p-6" role="status">
          <h2 className="text-lg font-bold text-navy">Period Copy created and verified</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-navy/70">
            <li>
              {summary.companyName}, {niceDate(summary.from)} – {niceDate(summary.to)}.
            </li>
            <li>
              Opening balances (trial balance just before {niceDate(summary.from)}):{' '}
              {formatCurrency(summary.verified.openingTrialBalance.totalDebit)} — the same as your books.
            </li>
            <li>
              Trial balance on {niceDate(summary.to)}: {formatCurrency(summary.verified.closingTrialBalance.totalDebit)} — the same as your
              books, account by account ({summary.verified.accountsCompared} accounts checked).
            </li>
            <li>
              Left out after the period: {summary.removedAfter.journalEntries} ledger entries and {summary.removedAfter.documents} other records.
            </li>
            {summary.condensed && (
              <li>
                Before the period: {summary.condensed.entries} entries summarized into {summary.condensed.summaryEntries} monthly opening
                balance entries ({summary.condensed.keptOpenDocumentEntries} kept in detail because they were still open).
              </li>
            )}
            {summary.otherCompaniesRemoved > 0 && <li>{summary.otherCompaniesRemoved} other company(ies) in the file were left out.</li>}
          </ul>
        </Card>
      )}
    </main>
  );
}
