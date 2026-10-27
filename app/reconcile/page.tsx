'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckSquare } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency, Money } from '@/lib/money';
import { canFinishReconciliation, statementLineAmount } from '@/lib/reconcileRules';
import { isBankAccount } from '@/lib/accountTypes';
import { formatDate as fmtDate, todayISO } from '@/lib/dates';
// cmdbar: "reconcile checking" opens this page with the account picked.
import { usePrefill } from '@/lib/commands/usePrefill';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BankAccount {
  id: string;
  /** Linked GL account id. */
  accountId: string;
  bankName: string;
  accountNumber: string;
  glAccountName: string;
  glAccountCode: string;
  /** GL type / detail type of the linked account (a card is paid from a bank account only). */
  glAccountType?: string;
  glAccountSubtype?: string | null;
  lastReconciledDate: string | null;
  lastReconciledBalance: string | null;
}

interface Reconciliation {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementBalance: string;
  reconciledBalance: string | null;
  status: string;
  createdAt: string;
  completedAt: string | null;
  bankName: string;
  accountNumber: string;
}

interface ClearableLine {
  journalEntryLineId: string;
  journalEntryId: string;
  date: string;
  description: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
  isCleared: boolean;
}

interface Progress {
  reconciliationId: string;
  statementBalance: string;
  clearedBalance: string;
  difference: string;
}

interface ReconcileInfo {
  bankAccountId: string;
  bankName: string;
  glAccountId: string;
  glAccountName: string;
  glAccountCode: string;
  glType: string;
  isCreditCard: boolean;
  lastReconciledDate: string | null;
  beginningBalance: string;
  recomputedBalance: string;
  discrepancy: string;
  /** p1 fx: account currency (null = home) — every amount on this page is in it. */
  currency?: string | null;
}

interface GLAccount {
  id: string;
  code: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** p1 fx: currency of the account being reconciled (set when its info loads). */
let displayCurrency: string | undefined;
function setDisplayCurrency(info: ReconcileInfo | null) {
  displayCurrency = info?.currency ?? undefined;
}

function fmt(v: string | null | undefined) {
  if (v == null) return '—';
  return formatCurrency(v, displayCurrency);
}

function statusTone(status: string): 'info' | 'success' | 'warning' | 'neutral' {
  if (status === 'in_progress') return 'info';
  if (status === 'completed') return 'success';
  if (status === 'undone') return 'warning';
  return 'neutral';
}

function statusLabel(status: string): string {
  if (status === 'in_progress') return 'In Progress';
  if (status === 'completed') return 'Completed';
  if (status === 'undone') return 'Undone';
  return status;
}

/** The amount as the statement shows it (a card's charges +, its payments −). */
function lineAmount(line: ClearableLine, isCreditCard: boolean): string {
  return statementLineAmount(line, isCreditCard);
}

function differenceClose(difference: string): boolean {
  // "Finish Reconciliation" is enabled exactly when the server completes: a 0.00 difference.
  return canFinishReconciliation(difference);
}

// ---------------------------------------------------------------------------
// Start Reconciliation form
// ---------------------------------------------------------------------------

function StartForm({
  bankAccounts,
  onStarted,
  onUndone,
}: {
  bankAccounts: BankAccount[];
  onStarted: (recon: Reconciliation) => void;
  onUndone: () => void;
}) {
  const [bankAccountId, setBankAccountId] = useState('');
  const [statementDate, setStatementDate] = useState('');
  const [statementBalance, setStatementBalance] = useState('');
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<ReconcileInfo | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  usePrefill(
    'reconcile',
    (p) => {
      if (p.bankAccountId && bankAccounts.some((b) => b.id === p.bankAccountId)) {
        setBankAccountId(p.bankAccountId);
        setTimeout(() => document.getElementById('recon-statement-date')?.focus(), 50);
      }
    },
    bankAccounts.length > 0,
  );

  // Deep links: Needs attention > Reconcile (?account=<bank account id>&through=YYYY-MM-DD) and the
  // month-end close checklist (?bankAccountId=...&statementDate=YYYY-MM-DD) pick the account and date.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const account = q.get('account') ?? q.get('bankAccountId');
    const through = q.get('through') ?? q.get('statementDate');
    if (account && bankAccounts.some((b) => b.id === account)) setBankAccountId(account);
    if (through && /^\d{4}-\d{2}-\d{2}$/.test(through)) setStatementDate(through);
  }, [bankAccounts]);

  // Load Begin-Reconciliation info (beginning balance, last reconciled,
  // discrepancy check) whenever the selected bank account changes.
  useEffect(() => {
    setInfo(null);
    if (!bankAccountId) return;
    let cancelled = false;
    api
      .get<ReconcileInfo>(`/api/reconciliations/info?bankAccountId=${bankAccountId}`)
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((err) => {
        toastError(err, 'Failed to load account info.');
      });
    return () => {
      cancelled = true;
    };
  }, [bankAccountId]);

  async function handleStart() {
    if (!bankAccountId || !statementDate || !statementBalance) {
      toast('All fields are required.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const recon = await api.post<Reconciliation>('/api/reconciliations', {
        bankAccountId,
        statementDate: new Date(statementDate).toISOString(),
        statementBalance,
      });
      toast('Reconciliation started.', 'success');
      onStarted(recon);
    } catch (err) {
      toastError(err, 'Failed to start reconciliation.');
    } finally {
      setSaving(false);
    }
  }

  async function handleUndo() {
    if (!info) return;
    setUndoing(true);
    try {
      await api.post('/api/reconciliations/undo', { bankAccountId });
      toast('Last reconciliation undone.', 'success');
      // Refresh the info panel and the history list.
      const refreshed = await api.get<ReconcileInfo>(
        `/api/reconciliations/info?bankAccountId=${bankAccountId}`,
      );
      setInfo(refreshed);
      onUndone();
    } catch (err) {
      toastError(err, 'Failed to undo reconciliation.');
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  }

  const hasDiscrepancy = info != null && !Money.isZero(info.discrepancy);
  setDisplayCurrency(info);

  return (
    <Card className="p-6 max-w-lg">
      <h2 className="text-lg font-bold text-navy mb-1 flex items-center gap-1.5">
        Start New Reconciliation <Help term="reconcile" side="bottom" />
      </h2>
      <p className="text-sm text-navy/50 mb-4">
        Have your bank statement handy. Enter its date and ending balance, then tick each
        transaction that appears on it until the difference is 0.00.
      </p>
      <div className="space-y-4">
        <div>
          <Label htmlFor="recon-bank-account" required>Bank Account</Label>
          <Select
            id="recon-bank-account"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
          >
            <option value="">Select bank account…</option>
            {bankAccounts.map((ba) => (
              <option key={ba.id} value={ba.id}>
                {ba.bankName} – {ba.glAccountCode} {ba.glAccountName}
              </option>
            ))}
          </Select>
        </div>

        {info && (
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-navy/60">Beginning Balance</span>
              <span className="font-mono font-semibold text-navy">
                {fmt(info.beginningBalance)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-navy/60">Last Reconciled</span>
              <span className="text-navy">{fmtDate(info.lastReconciledDate)}</span>
            </div>
            {info.isCreditCard && (
              <div className="pt-1">
                <Badge tone="info">Credit Card Account</Badge>
              </div>
            )}
            {info.currency && (
              <p className="pt-1 text-xs text-navy/60">
                This account is in {info.currency}. Enter the statement ending balance in {info.currency}, as printed on the statement.
              </p>
            )}
            {hasDiscrepancy && (
              <div className="mt-2 rounded-md bg-gold/10 border border-gold/40 p-2 text-navy text-xs">
                <strong>Beginning balance discrepancy of {formatCurrency(info.discrepancy)}.</strong>{' '}
                A previously reconciled transaction was voided or changed (recomputed cleared
                balance: {formatCurrency(info.recomputedBalance)}). See the{' '}
                <Link href="/reports/reconciliation" className="underline">
                  Reconciliation Discrepancy report
                </Link>{' '}
                to locate it, or undo the last reconciliation to repair.
              </div>
            )}
            {info.lastReconciledDate && (
              <div className="pt-2">
                <Button size="sm" variant="secondary" onClick={() => setConfirmUndo(true)}>
                  Undo Last Reconciliation
                </Button>
              </div>
            )}
          </div>
        )}

        <div>
          <Label htmlFor="recon-statement-date" required>Statement Date</Label>
          <Input
            id="recon-statement-date"
            type="date"
            value={statementDate}
            onChange={(e) => setStatementDate(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="recon-statement-balance" required>
            Statement Ending Balance <Help term="statement-ending-balance" />
          </Label>
          <Input
            id="recon-statement-balance"
            type="number"
            step="0.01"
            placeholder="0.00"
            value={statementBalance}
            onChange={(e) => setStatementBalance(e.target.value)}
          />
        </div>
        <Button onClick={handleStart} loading={saving}>
          Start Reconciliation
        </Button>
      </div>

      <ConfirmDialog
        open={confirmUndo}
        title="Undo last reconciliation?"
        message={`Undo the last completed reconciliation for ${info?.bankName ?? 'this account'}? Its cleared transactions will become un-cleared and the beginning balance will roll back to the previous statement.`}
        confirmLabel="Undo"
        tone="danger"
        loading={undoing}
        onConfirm={handleUndo}
        onClose={() => setConfirmUndo(false)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reconcile session (clearable lines + progress)
// ---------------------------------------------------------------------------

function ReconcileSession({
  recon,
  bankAccounts,
  onComplete,
}: {
  recon: Reconciliation;
  bankAccounts: BankAccount[];
  onComplete: () => void;
}) {
  const [lines, setLines] = useState<ClearableLine[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [info, setInfo] = useState<ReconcileInfo | null>(null);
  setDisplayCurrency(info); // p1 fx: amounts in the account currency
  const [glAccounts, setGlAccounts] = useState<GLAccount[]>([]);
  const [loadingLines, setLoadingLines] = useState(true);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [editBalance, setEditBalance] = useState('');
  const [savingBalance, setSavingBalance] = useState(false);

  // Service charge / interest earned inputs
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeAccountId, setChargeAccountId] = useState('');
  const [interestAmount, setInterestAmount] = useState('');
  const [interestAccountId, setInterestAccountId] = useState('');
  const [applyingAdjustments, setApplyingAdjustments] = useState(false);

  // Pay credit card prompt (shown after completing a CC reconciliation)
  const [showPayCC, setShowPayCC] = useState(false);
  const [payAccountId, setPayAccountId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(() => todayISO());
  const [paying, setPaying] = useState(false);

  // Load account info (beginning balance / CC detection) + GL accounts for the
  // service charge / interest selects.
  useEffect(() => {
    api
      .get<ReconcileInfo>(`/api/reconciliations/info?bankAccountId=${recon.bankAccountId}`)
      .then(setInfo)
      .catch(() => {});
    api
      .get<GLAccount[]>('/api/accounts')
      .then(setGlAccounts)
      .catch(() => {});
  }, [recon.bankAccountId]);

  const loadLines = useCallback(async () => {
    setLoadingLines(true);
    try {
      const [fetchedLines, fetchedProgress] = await Promise.all([
        api.get<ClearableLine[]>(`/api/reconciliations/${recon.id}/clearable`),
        api.get<Progress>(`/api/reconciliations/${recon.id}`),
      ]);
      setLines(fetchedLines);
      setProgress(fetchedProgress);
    } catch (err) {
      toastError(err, 'Failed to load reconciliation data.');
    } finally {
      setLoadingLines(false);
    }
  }, [recon.id]);

  useEffect(() => {
    loadLines();
  }, [loadLines]);

  async function handleToggle(line: ClearableLine) {
    setToggling(line.journalEntryLineId);
    try {
      const updatedProgress = await api.patch<Progress>(`/api/reconciliations/${recon.id}`, {
        action: 'toggleCleared',
        journalEntryLineId: line.journalEntryLineId,
        isCleared: !line.isCleared,
      });
      // Update isCleared on the line locally to avoid a full refetch.
      setLines((prev) =>
        prev.map((l) =>
          l.journalEntryLineId === line.journalEntryLineId
            ? { ...l, isCleared: !l.isCleared }
            : l,
        ),
      );
      setProgress(updatedProgress);
    } catch (err) {
      toastError(err, 'Failed to toggle line.');
    } finally {
      setToggling(null);
    }
  }

  async function handleComplete() {
    setCompleting(true);
    try {
      await api.patch(`/api/reconciliations/${recon.id}`, { action: 'complete' });
      toast('Reconciliation completed successfully.', 'success');
      if (info?.isCreditCard) {
        // QB flow: offer to write a check for the reconciled balance.
        setPayAmount(progress?.statementBalance ?? recon.statementBalance);
        setShowPayCC(true);
      } else {
        onComplete();
      }
    } catch (err) {
      toastError(err, 'Failed to complete reconciliation.');
    } finally {
      setCompleting(false);
    }
  }

  async function handleApplyAdjustments() {
    const body: {
      action: string;
      serviceCharge?: { amount: string; accountId: string };
      interestEarned?: { amount: string; accountId: string };
    } = { action: 'adjustments' };
    if (chargeAmount && Number(chargeAmount) > 0) {
      if (!chargeAccountId) {
        toast('Select an expense account for the service charge.', 'danger');
        return;
      }
      body.serviceCharge = { amount: chargeAmount, accountId: chargeAccountId };
    }
    if (interestAmount && Number(interestAmount) > 0) {
      if (!interestAccountId) {
        toast('Select an income account for the interest earned.', 'danger');
        return;
      }
      body.interestEarned = { amount: interestAmount, accountId: interestAccountId };
    }
    if (!body.serviceCharge && !body.interestEarned) {
      toast('Enter a service charge and/or interest amount.', 'danger');
      return;
    }
    setApplyingAdjustments(true);
    try {
      await api.patch<Progress>(`/api/reconciliations/${recon.id}`, body);
      setChargeAmount('');
      setInterestAmount('');
      toast('Adjustments posted and cleared.', 'success');
      await loadLines();
    } catch (err) {
      toastError(err, 'Failed to post adjustments.');
    } finally {
      setApplyingAdjustments(false);
    }
  }

  async function handlePayCC() {
    if (!payAccountId) {
      toast('Select the bank account to pay from.', 'danger');
      return;
    }
    if (!payAmount || Number(payAmount) <= 0) {
      toast('Enter a payment amount greater than zero.', 'danger');
      return;
    }
    setPaying(true);
    try {
      await api.post(`/api/reconciliations/${recon.id}/pay`, {
        paymentAccountId: payAccountId,
        amount: payAmount,
        date: payDate ? new Date(payDate).toISOString() : undefined,
      });
      toast('Credit card payment recorded.', 'success');
      setShowPayCC(false);
      onComplete();
    } catch (err) {
      toastError(err, 'Failed to record payment.');
    } finally {
      setPaying(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      await api.del(`/api/reconciliations/${recon.id}`);
      toast('Reconciliation cancelled.', 'success');
      onComplete();
    } catch (err) {
      toastError(err, 'Failed to cancel reconciliation.');
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  async function handleUpdateBalance() {
    if (!editBalance) {
      toast('Enter the corrected statement balance.', 'danger');
      return;
    }
    setSavingBalance(true);
    try {
      const updatedProgress = await api.patch<Progress>(`/api/reconciliations/${recon.id}`, {
        action: 'updateStatement',
        statementBalance: editBalance,
      });
      setProgress(updatedProgress);
      setEditBalance('');
      toast('Statement balance updated.', 'success');
    } catch (err) {
      toastError(err, 'Failed to update statement balance.');
    } finally {
      setSavingBalance(false);
    }
  }

  const canComplete =
    recon.status === 'in_progress' &&
    progress != null &&
    differenceClose(progress.difference);

  return (
    <div className="space-y-6">
      {/* Progress summary */}
      <Card className="p-6">
        <h2 className="text-lg font-bold text-navy mb-1">
          Reconciliation — {recon.bankName} (statement date: {fmtDate(recon.statementDate)})
        </h2>
        {info && (
          <p className="text-sm text-navy/60 mb-4">
            {info.isCreditCard && (
              <span className="mr-2 align-middle">
                <Badge tone="info">Credit Card</Badge>
              </span>
            )}
            {info.currency && (
              <span className="mr-2 align-middle">
                <Badge tone="info">Amounts in {info.currency}</Badge>
              </span>
            )}
            Last reconciled: {fmtDate(info.lastReconciledDate)}
            {info.lastReconciledDate ? ` at ${formatCurrency(info.beginningBalance)}` : ' — never'}
            {!Money.isZero(info.discrepancy) && (
              <span className="ml-2 text-gold font-semibold">
                Beginning balance discrepancy: {formatCurrency(info.discrepancy)}
              </span>
            )}
          </p>
        )}
        {progress ? (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-6 text-center">
            <div>
              <p className="text-xs text-navy/60 uppercase tracking-wide mb-1">Beginning Balance</p>
              <p className="text-2xl font-bold text-navy">
                {info ? fmt(info.beginningBalance) : '…'}
              </p>
            </div>
            <div>
              <p className="text-xs text-navy/60 uppercase tracking-wide mb-1">Statement Balance</p>
              <p className="text-2xl font-bold text-navy">{fmt(progress.statementBalance)}</p>
            </div>
            <div>
              <p className="text-xs text-navy/60 uppercase tracking-wide mb-1">Cleared Balance</p>
              <p className="text-2xl font-bold text-navy">{fmt(progress.clearedBalance)}</p>
            </div>
            <div>
              <p className="text-xs text-navy/60 uppercase tracking-wide mb-1">Difference</p>
              <p
                className={`text-2xl font-bold ${differenceClose(progress.difference) ? 'text-emerald' : 'text-red-500'}`}
              >
                {fmt(progress.difference)}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-navy/50 text-sm">Loading progress…</p>
        )}
        {recon.status === 'in_progress' && (
          <div className="mt-4 flex items-end gap-2">
            <div>
              <Label htmlFor="recon-correct-balance">Correct Statement Balance</Label>
              <Input
                id="recon-correct-balance"
                type="number"
                step="0.01"
                placeholder={progress?.statementBalance ?? '0.00'}
                value={editBalance}
                onChange={(e) => setEditBalance(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              onClick={handleUpdateBalance}
              loading={savingBalance}
              disabled={!editBalance}
            >
              Update Balance
            </Button>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {recon.status === 'in_progress' && (
            <Button variant="secondary" onClick={() => setConfirmCancel(true)}>
              Cancel Reconciliation
            </Button>
          )}
          <Button onClick={handleComplete} loading={completing} disabled={!canComplete}>
            Finish Reconciliation
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel reconciliation?"
        message="Cleared checkmarks from this session will be discarded."
        confirmLabel="Cancel Reconciliation"
        tone="danger"
        loading={cancelling}
        onConfirm={handleCancel}
        onClose={() => setConfirmCancel(false)}
      />

      {/* Service charge / interest earned */}
      {recon.status === 'in_progress' && (
        <Card className="p-6">
          <h3 className="text-base font-bold text-navy mb-1">Service Charge & Interest Earned</h3>
          <p className="text-sm text-navy/60 mb-4">
            Amounts on the statement that are not in your books yet. They post journal entries
            dated {fmtDate(recon.statementDate)} and are cleared into this reconciliation
            automatically.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <Label htmlFor="recon-service-charge">Service Charge</Label>
              <Input
                id="recon-service-charge"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={chargeAmount}
                onChange={(e) => setChargeAmount(e.target.value)}
              />
              <Select
                aria-label="Service charge expense account"
                value={chargeAccountId}
                onChange={(e) => setChargeAccountId(e.target.value)}
              >
                <option value="">Expense account…</option>
                {glAccounts
                  .filter((a) => a.type === 'expense')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="recon-interest-earned">Interest Earned</Label>
              <Input
                id="recon-interest-earned"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={interestAmount}
                onChange={(e) => setInterestAmount(e.target.value)}
              />
              <Select
                aria-label="Interest earned income account"
                value={interestAccountId}
                onChange={(e) => setInterestAccountId(e.target.value)}
              >
                <option value="">Income account…</option>
                {glAccounts
                  .filter((a) => a.type === 'revenue')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
              </Select>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              variant="secondary"
              onClick={handleApplyAdjustments}
              loading={applyingAdjustments}
            >
              Post & Clear Adjustments
            </Button>
          </div>
        </Card>
      )}

      {/* Pay credit card prompt (after completing a CC reconciliation) */}
      <Modal
        open={showPayCC}
        onClose={() => {
          setShowPayCC(false);
          onComplete();
        }}
        title="Pay Credit Card Balance"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setShowPayCC(false);
                onComplete();
              }}
              disabled={paying}
            >
              Not Now
            </Button>
            <Button onClick={handlePayCC} loading={paying}>
              Write a Check for the Balance
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            The reconciliation is complete. Record a payment for the statement balance now? This
            posts <span className="font-semibold">Dr {info?.glAccountName ?? 'Credit Card'}</span>{' '}
            / <span className="font-semibold">Cr bank</span>.
          </p>
          <div>
            <Label htmlFor="recon-pay-from">Pay From</Label>
            <Select
              id="recon-pay-from"
              autoFocus
              value={payAccountId}
              onChange={(e) => setPayAccountId(e.target.value)}
            >
              <option value="">Select bank account…</option>
              {bankAccounts
                .filter(
                  (ba) =>
                    ba.id !== recon.bankAccountId &&
                    ba.accountId !== info?.glAccountId &&
                    // The check is written from a bank account (another card or a loan can't pay it).
                    (ba.glAccountType === undefined ||
                      isBankAccount({ type: ba.glAccountType, subtype: ba.glAccountSubtype ?? null })),
                )
                .map((ba) => (
                  <option key={ba.id} value={ba.accountId}>
                    {ba.bankName} – {ba.glAccountCode} {ba.glAccountName}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="recon-pay-amount">Amount</Label>
            <Input
              id="recon-pay-amount"
              type="number"
              step="0.01"
              min="0"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="recon-pay-date">Payment Date</Label>
            <Input
              id="recon-pay-date"
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {/* Clearable lines */}
      <Card className="p-6">
        <h3 className="text-base font-bold text-navy mb-4">
          Transactions to Clear
          {!loadingLines && (
            <span className="ml-2 text-sm font-normal text-navy/50">
              ({lines.filter((l) => l.isCleared).length} of {lines.length} cleared)
            </span>
          )}
        </h3>
        {loadingLines ? (
          <div className="py-10 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : lines.length === 0 ? (
          <p className="text-navy/50 text-sm py-6 text-center">
            No clearable transactions found for this period.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10">Clear</Th>
                <Th>Date</Th>
                <Th>Description</Th>
                <Th>Memo</Th>
                <Th numeric>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <Tr
                  key={line.journalEntryLineId}
                  className={line.isCleared ? 'bg-emerald/10' : ''}
                >
                  <Td>
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric/30 cursor-pointer"
                      checked={line.isCleared}
                      disabled={toggling === line.journalEntryLineId || recon.status !== 'in_progress'}
                      onChange={() => handleToggle(line)}
                    />
                  </Td>
                  <Td>{fmtDate(line.date)}</Td>
                  <Td className="max-w-xs truncate">{line.description}</Td>
                  <Td className="text-navy/60">{line.memo ?? '—'}</Td>
                  <Td numeric>
                    {(() => {
                      const amount = lineAmount(line, !!info?.isCreditCard);
                      return (
                        <span className={Money.isZero(amount) ? 'text-navy/40' : Money.isNegative(amount) ? 'text-red-500' : 'text-navy'}>
                          {fmt(amount)}
                        </span>
                      );
                    })()}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past reconciliations list
// ---------------------------------------------------------------------------

function PastReconciliations({
  reconciliations,
  onResume,
}: {
  reconciliations: Reconciliation[];
  onResume: (recon: Reconciliation) => void;
}) {
  if (reconciliations.length === 0) return null;

  return (
    <Card className="p-6">
      <h2 className="text-lg font-bold text-navy mb-4">Reconciliation History</h2>
      <Table>
        <thead>
          <tr>
            <Th>Bank Account</Th>
            <Th>Statement Date</Th>
            <Th numeric>Statement Balance</Th>
            <Th numeric>Reconciled Balance</Th>
            <Th>Status</Th>
            <Th>Completed</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody>
          {reconciliations.map((r) => (
            <Tr key={r.id}>
              <Td>
                {r.bankName}
                <span className="ml-1 text-navy/40 text-xs">…{r.accountNumber.slice(-4)}</span>
              </Td>
              <Td>{fmtDate(r.statementDate)}</Td>
              <Td numeric>{fmt(r.statementBalance)}</Td>
              <Td numeric>{fmt(r.reconciledBalance)}</Td>
              <Td>
                <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
              </Td>
              <Td>{fmtDate(r.completedAt)}</Td>
              <Td>
                {r.status === 'in_progress' ? (
                  <Button size="sm" variant="secondary" onClick={() => onResume(r)}>
                    Resume
                  </Button>
                ) : (
                  <Link
                    href={`/reports/reconciliation/${r.id}`}
                    className="text-electric text-sm font-semibold hover:underline"
                  >
                    Report
                  </Link>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ReconcilePage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [activeRecon, setActiveRecon] = useState<Reconciliation | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [bas, recons] = await Promise.all([
        api.get<BankAccount[]>('/api/bank-accounts'),
        api.get<Reconciliation[]>('/api/reconciliations'),
      ]);
      setBankAccounts(bas);
      setReconciliations(recons);
      // Auto-resume if there is exactly one in-progress reconciliation (for the account named by
      // a ?account= deep link, when there is one).
      const wanted = new URLSearchParams(window.location.search).get('account');
      const inProgress = recons.find((r) => r.status === 'in_progress' && (!wanted || r.bankAccountId === wanted));
      if (inProgress && !activeRecon) {
        setActiveRecon(inProgress);
      }
    } catch (err) {
      toastError(err, 'Failed to load data.');
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleStarted(recon: Reconciliation) {
    setReconciliations((prev) => [recon, ...prev]);
    setActiveRecon(recon);
  }

  function handleComplete() {
    setActiveRecon(null);
    loadData();
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Bank Reconciliation" icon={CheckSquare} />

      {loading ? (
        <div className="py-10 flex justify-center">
          <Spinner className="text-electric" />
        </div>
      ) : activeRecon ? (
        <div className="space-y-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActiveRecon(null)}
            className="mb-2"
          >
            Back to reconciliation list
          </Button>
          <ReconcileSession
            recon={activeRecon}
            bankAccounts={bankAccounts}
            onComplete={handleComplete}
          />
        </div>
      ) : (
        <div className="space-y-8">
          <StartForm
            bankAccounts={bankAccounts}
            onStarted={handleStarted}
            onUndone={loadData}
          />
          <PastReconciliations
            reconciliations={reconciliations}
            onResume={(r) => setActiveRecon(r)}
          />
        </div>
      )}
    </main>
  );
}
