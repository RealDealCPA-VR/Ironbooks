'use client';

/**
 * Close the month (guided month-end close). A step-by-step checklist computed live from the books
 * (lib/services/monthEndClose.ts): reconcile, bank feed, uncategorized money, Undeposited Funds,
 * customer and vendor balances, payroll taxes, the error scan / Verify Data and open orders. Each
 * step can be marked reviewed or skipped with a reason; the last step sets the closing date and
 * the "Books are closed" screen offers the PDF report pack.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  Download,
  Lock,
  MinusCircle,
  ScanSearch,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Label,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import type {
  MonthEndChecklist,
  MonthEndHistoryRow,
  MonthEndStep,
  StepStatus,
} from '@/lib/services/monthEndClose';

interface Payload {
  checklist: MonthEndChecklist;
  history: MonthEndHistoryRow[];
}

const CLOSE_KEY = 'close';

/** Last day of the month `back` months before the current one ('YYYY-MM-DD', UTC calendar). */
function monthEnd(back: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - back + 1, 0));
  return d.toISOString().slice(0, 10);
}

function monthLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const STATUS_TEXT: Record<StepStatus, string> = {
  done: 'Done',
  attention: 'Needs attention',
  skipped: 'Skipped',
};

function StatusIcon({ status, className = 'h-5 w-5' }: { status: StepStatus; className?: string }) {
  if (status === 'done') return <CheckCircle2 aria-hidden="true" className={`${className} text-emerald flex-shrink-0`} />;
  if (status === 'skipped') return <MinusCircle aria-hidden="true" className={`${className} text-slate-400 flex-shrink-0`} />;
  return <AlertTriangle aria-hidden="true" className={`${className} text-gold flex-shrink-0`} />;
}

function StatusBadge({ step }: { step: MonthEndStep }) {
  const tone = step.status === 'done' ? 'success' : step.status === 'skipped' ? 'neutral' : 'warning';
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={tone}>{STATUS_TEXT[step.status]}</Badge>
      {step.reviewed && <Badge tone="info">Reviewed</Badge>}
      {step.optional && <Badge tone="neutral">Optional</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

function StepPanel({
  step,
  checklist,
  busy,
  onAction,
  onScan,
  scanning,
}: {
  step: MonthEndStep;
  checklist: MonthEndChecklist;
  busy: boolean;
  onAction: (action: 'review' | 'unreview' | 'skip' | 'unskip', extra?: { note?: string; reason?: string }) => void;
  onScan: () => void;
  scanning: boolean;
}) {
  const [note, setNote] = useState(step.note ?? '');
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState('');
  const locked = checklist.status === 'closed';
  useEffect(() => {
    setNote(step.note ?? '');
    setSkipping(false);
    setReason('');
  }, [step.key, step.note]);

  const hasAmounts = step.rows.some((r) => r.amount !== undefined);
  return (
    <section aria-labelledby={`step-${step.key}-title`} className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <StatusIcon status={step.status} className="h-6 w-6 mt-1" />
          <div>
            <h2 id={`step-${step.key}-title`} className="text-xl font-bold text-navy">
              {step.title}
            </h2>
            <p className="text-sm text-navy/60 mt-1 max-w-2xl">{step.why}</p>
          </div>
        </div>
        <StatusBadge step={step} />
      </div>

      <div
        className={`rounded-lg border px-4 py-3 text-sm ${
          step.status === 'attention'
            ? 'bg-gold/10 border-gold/30 text-navy'
            : step.status === 'done'
              ? 'bg-emerald/10 border-emerald/30 text-navy'
              : 'bg-slate-50 border-slate-200 text-navy/80'
        }`}
        role="status"
      >
        <p className="font-semibold">{step.summary}</p>
        {step.statusReason && (
          <p className="mt-1 text-navy/70">
            {step.skippedByUser ? 'Skipped on purpose: ' : 'Skipped: '}
            {step.statusReason}
          </p>
        )}
      </div>

      {step.figures.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {step.figures.map((f) => (
            <div key={f.label} className="rounded-xl bg-navy/5 px-4 py-3">
              <dt className="text-xs font-semibold text-navy/50 uppercase tracking-wide">{f.label}</dt>
              <dd className="mt-1 text-base font-bold text-navy tabular-nums break-words">
                {f.kind === 'money' ? formatCurrency(f.value) : /^\d{4}-\d{2}-\d{2}T/.test(f.value) ? formatDate(f.value) : f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {step.rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>
                <span className="sr-only">Status</span>
              </Th>
              <Th>Item</Th>
              {hasAmounts && <Th numeric>Amount</Th>}
              <Th>
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {step.rows.map((r, i) => (
              <Tr key={`${r.label}-${i}`}>
                <Td className="w-8">
                  {r.status ? (
                    <>
                      <StatusIcon status={r.status} className="h-4 w-4" />
                      <span className="sr-only">{STATUS_TEXT[r.status]}</span>
                    </>
                  ) : null}
                </Td>
                <Td>
                  <div className="font-medium text-sm">{r.label}</div>
                  {r.detail && <div className="text-xs text-navy/60 mt-0.5">{r.detail}</div>}
                </Td>
                {hasAmounts && (
                  <Td numeric className="text-sm">
                    {r.amount !== undefined ? formatCurrency(r.amount) : ''}
                  </Td>
                )}
                <Td className="text-right whitespace-nowrap">
                  {r.href && (
                    <Link href={r.href} className="text-sm font-semibold text-electric hover:underline">
                      {r.hrefLabel ?? 'Open'}
                      <span className="sr-only"> {r.label}</span>
                    </Link>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <div className="flex flex-wrap gap-3">
        {step.action && (
          <Link
            href={step.action.href}
            className="inline-flex items-center gap-2 rounded-lg bg-white border border-slate-200 px-4 py-2 text-sm font-semibold text-navy hover:bg-slate-50"
          >
            {step.action.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        )}
        {step.key === 'error_scan' && !locked && (
          <Button variant="secondary" onClick={onScan} loading={scanning}>
            <ScanSearch className="h-4 w-4" aria-hidden="true" />
            Run error scan now
          </Button>
        )}
      </div>

      {!locked && (
        <div className="rounded-xl border border-slate-200 p-4 space-y-4">
          <h3 className="text-sm font-bold text-navy">Your review</h3>
          {step.reviewed ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-navy/70">
                Marked reviewed{step.reviewedByName ? ` by ${step.reviewedByName}` : ''}
                {step.reviewedAt ? ` on ${formatDate(step.reviewedAt)}` : ''}.
                {step.note ? ` Note: ${step.note}` : ''}
              </p>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction('unreview')}>
                Undo review
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`note-${step.key}`}>Note (optional)</Label>
              <textarea
                id={`note-${step.key}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                rows={2}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
                placeholder="e.g. Checked with the owner; the old deposit is a duplicate to void next month."
              />
              <Button size="sm" loading={busy} onClick={() => onAction('review', { note })}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Mark as reviewed
              </Button>
              {step.status === 'attention' && !step.optional && (
                <p className="text-xs text-navy/50">
                  Fix what is listed above, or mark it reviewed to say you looked at it and it is fine for this month.
                </p>
              )}
            </div>
          )}

          {step.skippedByUser ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
              <p className="text-sm text-navy/70">Skipped: {step.statusReason}</p>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction('unskip')}>
                Undo skip
              </Button>
            </div>
          ) : skipping ? (
            <form
              className="space-y-2 border-t border-slate-100 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reason.trim()) {
                  toast('Say why you are skipping this step.', 'danger');
                  return;
                }
                onAction('skip', { reason });
              }}
            >
              <Label htmlFor={`reason-${step.key}`} required>
                Why skip this step?
              </Label>
              <Input
                id={`reason-${step.key}`}
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. The bank statement has not arrived yet."
                autoFocus
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" variant="secondary" loading={busy}>
                  Skip step
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setSkipping(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="border-t border-slate-100 pt-3">
              <Button variant="ghost" size="sm" onClick={() => setSkipping(true)}>
                Skip this step…
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Final step
// ---------------------------------------------------------------------------

function ClosePanel({
  checklist,
  onJump,
  onClosed,
}: {
  checklist: MonthEndChecklist;
  onJump: (key: string) => void;
  onClosed: () => void;
}) {
  const [mode, setMode] = useState<'keep' | 'set' | 'remove'>(checklist.hasClosingPassword ? 'keep' : 'set');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const pretty = formatDate(checklist.periodEnd);
  const outstanding = checklist.steps.filter((s) => !s.resolved);
  const laterClosed = !!checklist.closingDate && checklist.closingDate > checklist.periodEnd;

  function check(): boolean {
    if (mode === 'set' && checklist.hasClosingPassword && !password) {
      toast('Type the new password, or choose Keep the current password.', 'danger');
      return false;
    }
    if (mode === 'set' && password !== confirmPw) {
      toast('The two passwords do not match.', 'danger');
      return false;
    }
    return true;
  }

  async function doClose() {
    setClosing(true);
    try {
      const body: Record<string, unknown> = { periodEnd: checklist.periodEnd, version: checklist.version };
      if (mode === 'set' && password) body.password = password;
      if (mode === 'remove') body.password = null;
      await api.post('/api/month-end-close/close', body);
      toast(`The books are closed through ${pretty}.`, 'success');
      setConfirming(false);
      onClosed();
    } catch (err) {
      toastError(err, 'Could not close the books.');
    } finally {
      setClosing(false);
    }
  }

  return (
    <section aria-labelledby="step-close-title" className="space-y-5">
      <div className="flex items-start gap-3">
        <Lock className="h-6 w-6 mt-1 text-electric" aria-hidden="true" />
        <div>
          <h2 id="step-close-title" className="text-xl font-bold text-navy">
            Close the books
          </h2>
          <p className="text-sm text-navy/60 mt-1 max-w-2xl">
            Sets the closing date to {pretty}. After that, nobody can add, change or delete transactions dated on
            or before it without the closing date password.
          </p>
        </div>
      </div>

      {checklist.closingDate && (
        <p className="text-sm text-navy/70">
          Current closing date: <strong>{formatDate(checklist.closingDate)}</strong>
          {checklist.hasClosingPassword ? ' (password protected)' : ' (no password)'}.
        </p>
      )}

      {laterClosed ? (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-navy/80" role="status">
          The books are already closed through a later date, so this month is already protected.
        </div>
      ) : outstanding.length > 0 ? (
        <div className="rounded-lg bg-gold/10 border border-gold/30 px-4 py-3 text-sm" role="status">
          <p className="font-semibold text-navy">Finish, review or skip these steps first:</p>
          <ul className="mt-2 space-y-1">
            {outstanding.map((s) => (
              <li key={s.key}>
                <button
                  type="button"
                  className="text-electric font-semibold hover:underline"
                  onClick={() => onJump(s.key)}
                >
                  {s.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : !checklist.canClose ? (
        <div className="rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-navy/80" role="status">
          Every step is finished. Only people allowed to set the closing date (for example an Admin or the
          Accountant) can close the books — ask one of them to finish this step.
        </div>
      ) : (
        <form
          className="space-y-4 max-w-lg"
          onSubmit={(e) => {
            e.preventDefault();
            if (check()) setConfirming(true);
          }}
        >
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-navy/70 mb-1">Closing date password</legend>
            {checklist.hasClosingPassword && (
              <label className="flex items-center gap-2 text-sm text-navy">
                <input type="radio" name="pw-mode" checked={mode === 'keep'} onChange={() => setMode('keep')} />
                Keep the current password
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-navy">
              <input type="radio" name="pw-mode" checked={mode === 'set'} onChange={() => setMode('set')} />
              {checklist.hasClosingPassword ? 'Set a new password' : 'Set a password (recommended)'}
            </label>
            <label className="flex items-center gap-2 text-sm text-navy">
              <input type="radio" name="pw-mode" checked={mode === 'remove'} onChange={() => setMode('remove')} />
              {checklist.hasClosingPassword ? 'Remove the password' : 'No password'}
            </label>
          </fieldset>
          {mode === 'set' && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="close-pw">Password</Label>
                <Input
                  id="close-pw"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="close-pw2">Type it again</Label>
                <Input
                  id="close-pw2"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                />
              </div>
            </div>
          )}
          <Button type="submit">
            <Lock className="h-4 w-4" aria-hidden="true" />
            Close the books through {pretty}
          </Button>
        </form>
      )}

      <p className="text-sm text-navy/60">
        <a
          href={`/api/month-end-close/report-pack?periodEnd=${checklist.periodEnd}`}
          download
          className="inline-flex items-center gap-1 font-semibold text-electric hover:underline"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download a draft report pack
        </a>{' '}
        to look over the numbers first.
      </p>

      <ConfirmDialog
        open={confirming}
        title="Close the books?"
        message={`Transactions dated on or before ${pretty} will be locked. You can still move the closing date later in Preferences if you need to.`}
        confirmLabel="Close the books"
        loading={closing}
        onConfirm={doClose}
        onClose={() => setConfirming(false)}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// "Books are closed"
// ---------------------------------------------------------------------------

function ClosedScreen({ checklist, onReview }: { checklist: MonthEndChecklist; onReview: () => void }) {
  return (
    <Card className="p-8 text-center">
      <CheckCircle2 className="mx-auto h-14 w-14 text-emerald" aria-hidden="true" />
      <h2 className="mt-4 text-2xl font-extrabold text-navy">Books are closed</h2>
      <p className="mt-2 text-navy/70">
        {monthLabel(checklist.periodEnd)} is closed through {formatDate(checklist.periodEnd)}
        {checklist.closedByName ? ` by ${checklist.closedByName}` : ''}
        {checklist.closedAt ? ` on ${formatDate(checklist.closedAt)}` : ''}.
      </p>
      <p className="mt-1 text-sm text-navy/50">
        Changes dated on or before the closing date now need the closing date password
        {checklist.hasClosingPassword ? '' : ' (none is set — anyone allowed to edit closed periods can still change them)'}.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <a
          href={`/api/month-end-close/report-pack?periodEnd=${checklist.periodEnd}`}
          download
          className="inline-flex items-center gap-2 rounded-lg bg-electric px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-electric/90"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download report pack (PDF)
        </a>
        <Button variant="secondary" onClick={onReview}>
          See the checklist
        </Button>
      </div>
      <p className="mt-4 text-xs text-navy/40">
        The pack has the Profit &amp; Loss, Balance Sheet, Trial Balance, customer and vendor aging summaries and
        the reconciliation summaries for the month.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MonthEndPage() {
  const [periodEnd, setPeriodEnd] = useState(() => monthEnd(1));
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string>('reconcile');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  const monthEnds = useMemo(() => Array.from({ length: 12 }, (_, i) => monthEnd(i + 1)), []);

  const load = useCallback(async (pe: string) => {
    setLoading(true);
    try {
      setData(await api.get<Payload>(`/api/month-end-close?periodEnd=${pe}`));
    } catch (err) {
      toastError(err, 'Could not load the month-end checklist.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setShowSteps(false);
    void load(periodEnd);
  }, [periodEnd, load]);

  const checklist = data?.checklist ?? null;
  const step = checklist?.steps.find((s) => s.key === active) ?? null;
  const order = checklist ? [...checklist.steps.map((s) => s.key as string), CLOSE_KEY] : [];
  const idx = order.indexOf(active);

  async function stepAction(
    action: 'review' | 'unreview' | 'skip' | 'unskip',
    extra?: { note?: string; reason?: string },
  ) {
    if (!checklist || !step) return;
    setBusy(true);
    try {
      const updated = await api.patch<MonthEndChecklist>('/api/month-end-close/steps', {
        periodEnd: checklist.periodEnd,
        stepKey: step.key,
        action,
        ...(extra?.note ? { note: extra.note } : {}),
        ...(extra?.reason ? { reason: extra.reason } : {}),
        version: checklist.version,
      });
      setData((d) => (d ? { ...d, checklist: updated } : d));
      if (action === 'review' || action === 'skip') {
        const next = order[idx + 1];
        if (next) setActive(next);
      }
    } catch (err) {
      toastError(err, 'Could not save this step.');
    } finally {
      setBusy(false);
    }
  }

  async function runScan() {
    if (!checklist) return;
    setScanning(true);
    try {
      const res = await api.post<{ found: number; checklist: MonthEndChecklist }>('/api/month-end-close/scan', {
        periodEnd: checklist.periodEnd,
      });
      setData((d) => (d ? { ...d, checklist: res.checklist } : d));
      toast(res.found ? `The scan found ${res.found} new possible error(s).` : 'The scan found no new problems.', res.found ? 'info' : 'success');
    } catch (err) {
      toastError(err, 'Could not run the error scan.');
    } finally {
      setScanning(false);
    }
  }

  const pct = checklist ? Math.round((checklist.progress.resolved / checklist.progress.total) * 100) : 0;
  const isClosed = checklist?.status === 'closed';

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Close the month" icon={CalendarCheck} />

      <Card className="p-6 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-64">
            <Label htmlFor="period-month">Month to close</Label>
            <Select
              id="period-month"
              value={monthEnds.includes(periodEnd) ? periodEnd : ''}
              onChange={(e) => e.target.value && setPeriodEnd(e.target.value)}
            >
              {!monthEnds.includes(periodEnd) && <option value="">Other date</option>}
              {monthEnds.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-48">
            <Label htmlFor="period-end">Or period ending</Label>
            <Input
              id="period-end"
              type="date"
              value={periodEnd}
              onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && setPeriodEnd(e.target.value)}
            />
          </div>
          {checklist && (
            <div className="flex-1 min-w-[220px]">
              <p className="text-sm text-navy/70 mb-1" id="progress-label">
                {checklist.progress.resolved} of {checklist.progress.total} steps finished
                {checklist.closingDate ? ` · Closing date ${formatDate(checklist.closingDate)}` : ' · No closing date set'}
              </p>
              <div
                role="progressbar"
                aria-labelledby="progress-label"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="h-2.5 w-full rounded-full bg-navy/10 overflow-hidden"
              >
                <div className="h-full bg-emerald transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </div>
      </Card>

      {loading && !checklist ? (
        <div className="flex items-center gap-2 text-navy/60" role="status">
          <Spinner className="h-5 w-5" /> Checking your books for {monthLabel(periodEnd)}…
        </div>
      ) : !checklist ? null : isClosed && !showSteps ? (
        <ClosedScreen checklist={checklist} onReview={() => setShowSteps(true)} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          <nav aria-label="Month-end steps">
            <Card className="p-3">
              <ol className="space-y-1">
                {checklist.steps.map((s, i) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      onClick={() => setActive(s.key)}
                      aria-current={active === s.key ? 'step' : undefined}
                      className={`w-full flex items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        active === s.key ? 'bg-electric/10 text-navy font-semibold' : 'text-navy/80 hover:bg-navy/5'
                      }`}
                    >
                      <StatusIcon status={s.reviewed && s.status === 'attention' ? 'done' : s.status} className="h-5 w-5 mt-0.5" />
                      <span>
                        <span className="text-navy/40 mr-1">{i + 1}.</span>
                        {s.title}
                        <span className="sr-only">
                          {' '}
                          — {STATUS_TEXT[s.status]}
                          {s.reviewed ? ', reviewed' : ''}
                        </span>
                        {s.optional && <span className="block text-xs text-navy/40 font-normal">Optional</span>}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={() => setActive(CLOSE_KEY)}
                    aria-current={active === CLOSE_KEY ? 'step' : undefined}
                    className={`w-full flex items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      active === CLOSE_KEY ? 'bg-electric/10 text-navy font-semibold' : 'text-navy/80 hover:bg-navy/5'
                    }`}
                  >
                    <Lock className={`h-5 w-5 mt-0.5 ${isClosed ? 'text-emerald' : 'text-electric'}`} aria-hidden="true" />
                    <span>
                      <span className="text-navy/40 mr-1">{checklist.steps.length + 1}.</span>
                      Close the books
                      <span className="sr-only"> — {isClosed ? 'Done' : checklist.ready ? 'Ready' : 'Not ready yet'}</span>
                    </span>
                  </button>
                </li>
              </ol>
            </Card>

            {data && data.history.length > 0 && (
              <Card className="p-4 mt-4">
                <h2 className="text-sm font-bold text-navy mb-2">Months you worked on</h2>
                <ul className="space-y-1">
                  {data.history.map((h) => (
                    <li key={h.periodEnd} className="flex items-center justify-between gap-2 text-sm">
                      <button
                        type="button"
                        className="text-electric hover:underline"
                        onClick={() => setPeriodEnd(h.periodEnd)}
                      >
                        {formatDate(h.periodEnd)}
                      </button>
                      <Badge tone={h.status === 'closed' ? 'success' : 'neutral'}>
                        {h.status === 'closed' ? 'Closed' : 'In progress'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </nav>

          <Card className="p-6" aria-busy={loading}>
            {isClosed && (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald/10 border border-emerald/30 px-4 py-2 text-sm text-navy" role="status">
                <span>This month is closed. The checklist is read-only.</span>
                <Button size="sm" variant="ghost" onClick={() => setShowSteps(false)}>
                  Back to summary
                </Button>
              </div>
            )}
            {active === CLOSE_KEY ? (
              isClosed ? (
                <ClosedScreen checklist={checklist} onReview={() => setActive(checklist.steps[0].key)} />
              ) : (
                <ClosePanel key={checklist.periodEnd} checklist={checklist} onJump={setActive} onClosed={() => void load(periodEnd)} />
              )
            ) : step ? (
              <StepPanel
                step={step}
                checklist={checklist}
                busy={busy}
                onAction={stepAction}
                onScan={runScan}
                scanning={scanning}
              />
            ) : null}

            <div className="mt-8 flex justify-between border-t border-slate-100 pt-4">
              <Button variant="ghost" disabled={idx <= 0} onClick={() => setActive(order[idx - 1])}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Back
              </Button>
              <Button variant="secondary" disabled={idx < 0 || idx >= order.length - 1} onClick={() => setActive(order[idx + 1])}>
                Next step
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}
