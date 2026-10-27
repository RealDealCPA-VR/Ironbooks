'use client';

import { useState } from 'react';
import { CalendarClock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  PageHeader,
  toast,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CloseResult {
  entryId: string;
  entryNumber: number;
  description: string;
  date: string;
  netIncome: string;
  totalRevenue: string;
  totalExpenses: string;
  /** The account the net income went to (the equity account of type Retained Earnings). */
  retainedEarnings?: { code: string; name: string };
}

// ---------------------------------------------------------------------------
// Confirmation modal
// ---------------------------------------------------------------------------

interface ConfirmModalProps {
  open: boolean;
  fiscalYear: number;
  running: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function ConfirmModal({ open, fiscalYear, running, onConfirm, onClose }: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm Year-End Close"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={running}>
            Close FY {fiscalYear}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg bg-gold/10 border border-gold/30 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-gold mt-0.5 flex-shrink-0" />
          <div className="text-sm text-navy/80">
            <p className="font-semibold text-navy mb-1">This action cannot be undone without voiding the closing entry.</p>
            <p>
              Running year-end close for <strong>Fiscal Year {fiscalYear}</strong> will post a
              journal entry that zeros out all revenue and expense accounts and transfers
              net income into your <strong>Retained Earnings</strong> account.
            </p>
          </div>
        </div>
        <p className="text-sm text-navy/60">
          Make sure you have reviewed all transactions for FY {fiscalYear} and that the trial
          balance is balanced before proceeding.
        </p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

interface ResultCardProps {
  result: CloseResult;
}

function ResultCard({ result }: ResultCardProps) {
  const netPositive = parseFloat(result.netIncome) >= 0;

  return (
    <Card className="p-6 mt-6">
      <div className="flex items-center gap-3 mb-5">
        <CheckCircle2 className="h-6 w-6 text-emerald flex-shrink-0" />
        <div>
          <p className="font-bold text-navy text-lg">Year-End Close Completed</p>
          <p className="text-sm text-navy/50">Journal Entry #{result.entryNumber}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
        <div className="rounded-xl bg-navy/5 px-4 py-3">
          <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-1">
            Total Revenue
          </p>
          <p className="text-xl font-bold text-emerald tabular-nums">
            {formatCurrency(result.totalRevenue)}
          </p>
        </div>
        <div className="rounded-xl bg-navy/5 px-4 py-3">
          <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-1">
            Total Expenses
          </p>
          <p className="text-xl font-bold text-red-500 tabular-nums">
            {formatCurrency(result.totalExpenses)}
          </p>
        </div>
        <div className="rounded-xl bg-navy/5 px-4 py-3">
          <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-1">
            Net Income
          </p>
          <p
            className={`text-xl font-bold tabular-nums ${
              netPositive ? 'text-emerald' : 'text-red-500'
            }`}
          >
            {formatCurrency(result.netIncome)}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 px-4 py-3 bg-slate-50 text-sm text-navy/70">
        <span className="font-semibold text-navy">Closing Entry: </span>
        {result.description}
        <span className="ml-3 text-navy/40 text-xs">
          {result.date ? formatDate(result.date) : ''}
        </span>
      </div>

      <p className="mt-3 text-xs text-navy/40">
        Net income of {formatCurrency(result.netIncome)} has been transferred to{' '}
        {result.retainedEarnings
          ? `${result.retainedEarnings.code} · ${result.retainedEarnings.name}`
          : 'Retained Earnings'}
        . Revenue and expense accounts are now zeroed out for the new fiscal year.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function YearEndPage() {
  const currentYear = new Date().getFullYear();
  const [fiscalYear, setFiscalYear] = useState<string>(String(currentYear - 1));
  const [showConfirm, setShowConfirm] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CloseResult | null>(null);

  const yearNum = parseInt(fiscalYear, 10);
  const yearValid =
    !isNaN(yearNum) && yearNum >= 1900 && yearNum <= 2100;

  async function handleClose() {
    if (!yearValid) {
      toast('Please enter a valid four-digit fiscal year.', 'danger');
      return;
    }
    setRunning(true);
    try {
      const data = await api.post<CloseResult>('/api/year-end-close', {
        fiscalYear: yearNum,
      });
      setResult(data);
      toast(`FY ${yearNum} closed successfully.`, 'success');
      setShowConfirm(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Failed to run year-end close.';
      toast(msg, 'danger');
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Year-End Close" icon={CalendarClock} />

      <div className="max-w-xl">
        <Card className="p-6">
          <p className="text-sm text-navy/70 mb-5">
            Year-end close zeroes out all revenue and expense accounts for the selected fiscal year
            and transfers net income into your <strong>Retained Earnings</strong> account. Run this once
            at the end of each fiscal year after all transactions have been entered and reviewed.
          </p>

          <div className="mb-5">
            <Label htmlFor="fiscal-year">Fiscal Year</Label>
            <Input
              id="fiscal-year"
              type="number"
              min="1900"
              max="2100"
              step="1"
              placeholder="e.g. 2024"
              value={fiscalYear}
              onChange={(e) => {
                setFiscalYear(e.target.value);
                setResult(null);
              }}
              className="w-40"
            />
            {fiscalYear && !yearValid && (
              <p className="mt-1 text-xs text-red-500">
                Enter a valid year between 1900 and 2100.
              </p>
            )}
          </div>

          <div className="flex items-start gap-3 rounded-lg bg-gold/10 border border-gold/30 px-4 py-3 mb-5">
            <AlertTriangle className="h-5 w-5 text-gold mt-0.5 flex-shrink-0" />
            <p className="text-xs text-navy/70">
              This will post a permanent journal entry. Ensure your fiscal year {yearValid ? yearNum : '___'}{' '}
              books are complete and reviewed before proceeding.
            </p>
          </div>

          <Button
            onClick={() => setShowConfirm(true)}
            disabled={!yearValid || running}
          >
            <CalendarClock className="h-4 w-4" />
            Run Year-End Close for FY {yearValid ? yearNum : '—'}
          </Button>
        </Card>

        {result && <ResultCard result={result} />}
      </div>

      <ConfirmModal
        open={showConfirm}
        fiscalYear={yearNum}
        running={running}
        onConfirm={handleClose}
        onClose={() => setShowConfirm(false)}
      />
    </main>
  );
}
