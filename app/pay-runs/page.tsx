'use client';

/**
 * Pay Runs — batch payroll (QB "Scheduled Payroll" parity).
 *
 * Pick a pay date + period, check off employees (hours/amounts editable per row,
 * defaults from the employee's pay rate), optionally pull unpaid time entries for
 * the period into hourly checks, run the batch, and review the per-employee
 * result summary. Past runs list below with their paychecks expanded on click.
 */
import { Fragment, useEffect, useState } from 'react';
// wave2 prefs: Payroll & Employees > pay period + standard hours drive the defaults.
import { usePreferences } from '@/lib/usePreferences';
import { PAY_PERIODS_PER_YEAR, defaultPeriodHours } from '@/lib/preferences';
import Link from 'next/link';
import {
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Play,
  UserSquare,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
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
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate, todayISO } from '@/lib/dates';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  payType: 'hourly' | 'salary' | 'commission';
  payRate: string;
  isActive: boolean;
}

interface RowState {
  selected: boolean;
  hours: string;
  amount: string;
  timeEntryIds: string[];
  pulledHours: string | null;
  pulling: boolean;
}

interface PayRunPaycheck {
  id: string;
  employeeId: string;
  employeeName: string;
  grossPay: string;
  netPay: string;
  isVoid: boolean;
}

interface PayRunSummary {
  id: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  memo: string | null;
  createdAt: string;
  paychecks: PayRunPaycheck[];
  totalGross: string;
  totalNet: string;
}

interface RunResult {
  employeeId: string;
  employeeName: string;
  ok: boolean;
  paycheckId?: string;
  grossPay?: string;
  netPay?: string;
  error?: string;
  warning?: string;
  /** Calculation notes (state withholding not set up, nearest-year tables, local taxes). */
  notes?: string[];
}

interface UnpaidTime {
  entries: Array<{ id: string; date: string; hours: string; description: string | null }>;
  totalHours: string;
}

const PAY_TYPE_LABELS: Record<string, string> = {
  hourly: 'Hourly',
  salary: 'Salary',
  commission: 'Commission',
};

const FREQUENCIES: Array<{ value: string; label: string }> = [
  { value: '52', label: 'Weekly (52)' },
  { value: '26', label: 'Biweekly (26)' },
  { value: '24', label: 'Semimonthly (24)' },
  { value: '12', label: 'Monthly (12)' },
];

function toDec(v: string): Decimal {
  try {
    return new Decimal(v || '0');
  } catch {
    return new Decimal(0);
  }
}

/** Default hourly hours for one pay period (set from Preferences by the page). */
let defaultHours = '80';

function emptyRow(emp: Employee): RowState {
  return {
    selected: emp.isActive,
    hours: emp.payType === 'hourly' ? defaultHours : '',
    amount: '',
    timeEntryIds: [],
    pulledHours: null,
    pulling: false,
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PayRunsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [runs, setRuns] = useState<PayRunSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [payDate, setPayDate] = useState(todayISO());
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [memo, setMemo] = useState('');
  const [periodsPerYear, setPeriodsPerYear] = useState('26');
  const prefs = usePreferences();
  useEffect(() => {
    if (!prefs.loaded) return;
    const period = prefs.company.payrollPayPeriod;
    setPeriodsPerYear(String(PAY_PERIODS_PER_YEAR[period] ?? 26));
    const hours = String(defaultPeriodHours(period, prefs.company.payrollStandardHours));
    const previous = defaultHours;
    defaultHours = hours;
    // Rows still showing the old default pick up the preference.
    setRows((prev) => {
      const next: Record<string, RowState> = {};
      for (const [id, r] of Object.entries(prev)) {
        next[id] = r.hours === previous && r.timeEntryIds.length === 0 ? { ...r, hours } : r;
      }
      return next;
    });
  }, [prefs.loaded, prefs.company.payrollPayPeriod, prefs.company.payrollStandardHours]);

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);

  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  async function fetchAll() {
    setLoading(true);
    try {
      const [empData, runData] = await Promise.all([
        api.get<Employee[]>('/api/employees'),
        api.get<PayRunSummary[]>('/api/payroll/pay-runs'),
      ]);
      const active = empData.filter((e) => e.isActive);
      setEmployees(active);
      setRuns(runData);
      setRows((prev) => {
        const next: Record<string, RowState> = {};
        for (const e of active) next[e.id] = prev[e.id] ?? emptyRow(e);
        return next;
      });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load data', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateRow(empId: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [empId]: { ...prev[empId], ...patch } }));
  }

  // ---- Pull unpaid time entries for the period into a row ----

  async function pullTime(emp: Employee) {
    if (!periodStart || !periodEnd) {
      toast('Set the period start and end dates first', 'danger');
      return;
    }
    updateRow(emp.id, { pulling: true });
    try {
      const data = await api.get<UnpaidTime>(
        `/api/payroll/unpaid-time?employeeId=${emp.id}&periodStart=${periodStart}&periodEnd=${periodEnd}`,
      );
      if (data.entries.length === 0) {
        toast('No unpaid time entries in this period', 'info');
        updateRow(emp.id, { pulling: false });
        return;
      }
      updateRow(emp.id, {
        pulling: false,
        selected: true,
        hours: data.totalHours,
        amount: '',
        timeEntryIds: data.entries.map((e) => e.id),
        pulledHours: data.totalHours,
      });
      toast(
        `Pulled ${data.entries.length} time entr${data.entries.length === 1 ? 'y' : 'ies'} (${data.totalHours} hrs)`,
        'success',
      );
    } catch (err) {
      updateRow(emp.id, { pulling: false });
      toast(err instanceof ApiError ? err.message : 'Failed to pull time entries', 'danger');
    }
  }

  function clearPulledTime(empId: string, emp: Employee) {
    updateRow(empId, {
      timeEntryIds: [],
      pulledHours: null,
      hours: emp.payType === 'hourly' ? defaultHours : '',
    });
  }

  // ---- Per-row gross estimate ----

  function estimatedGross(emp: Employee, row: RowState): Decimal | null {
    if (row.amount) return toDec(row.amount);
    if (emp.payType === 'hourly' || row.timeEntryIds.length > 0) {
      const hours = row.hours ? toDec(row.hours) : new Decimal(0);
      return hours.times(toDec(emp.payRate));
    }
    if (emp.payType === 'salary') {
      const periods = toDec(periodsPerYear || '26');
      return periods.greaterThan(0) ? toDec(emp.payRate).dividedBy(periods) : null;
    }
    return null; // commission without an amount — server will reject the row
  }

  const selectedEmployees = employees.filter((e) => rows[e.id]?.selected);
  const totalEstimate = selectedEmployees.reduce((sum, e) => {
    const est = estimatedGross(e, rows[e.id]);
    return est ? sum.plus(est) : sum;
  }, new Decimal(0));

  // ---- Run ----

  async function handleRun() {
    setRunning(true);
    try {
      const body = {
        payDate,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        memo: memo.trim() || undefined,
        periodsPerYear: Number(periodsPerYear) || 26,
        employees: selectedEmployees.map((e) => {
          const row = rows[e.id];
          return {
            employeeId: e.id,
            hours: row.timeEntryIds.length === 0 && row.hours ? row.hours : undefined,
            amount: row.amount || undefined,
            timeEntryIds: row.timeEntryIds.length > 0 ? row.timeEntryIds : undefined,
          };
        }),
      };
      const data = await api.post<{ results: RunResult[] }>('/api/payroll/pay-runs', body);
      setResults(data.results);
      const failed = data.results.filter((r) => !r.ok).length;
      toast(
        failed === 0
          ? `Pay run complete — ${data.results.length} paycheck${data.results.length === 1 ? '' : 's'} posted`
          : `Pay run finished with ${failed} failure${failed === 1 ? '' : 's'}`,
        failed === 0 ? 'success' : 'danger',
      );
      setConfirmOpen(false);
      // Reset pulled time on success rows; refresh data.
      setRows((prev) => {
        const next = { ...prev };
        for (const r of data.results) {
          if (r.ok && next[r.employeeId]) {
            const emp = employees.find((e) => e.id === r.employeeId);
            next[r.employeeId] = emp ? emptyRow(emp) : next[r.employeeId];
          }
        }
        return next;
      });
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to run payroll', 'danger');
    } finally {
      setRunning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Pay Runs"
        icon={CalendarClock}
        action={
          <Link href="/employees">
            <Button variant="secondary">
              <UserSquare className="h-4 w-4" />
              Employees &amp; Payroll
            </Button>
          </Link>
        }
      />

      {/* ---- Result summary (after a run) ---- */}
      {results && (
        <Card className="mb-6 p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-navy/60 uppercase tracking-wide">
              Run Results
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setResults(null)}>
              Dismiss
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {results.map((r) => (
              <div
                key={r.employeeId}
                className={`flex items-center justify-between rounded-lg border px-4 py-2 ${
                  r.ok ? 'bg-emerald/5 border-emerald/20' : 'bg-red-50 border-red-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  {r.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="text-sm font-medium text-navy">{r.employeeName}</span>
                  {r.warning && <Badge tone="warning">{r.warning}</Badge>}
                  {(r.notes ?? []).map((n) => (
                    <span key={n} className="text-[11px] text-amber-700">{n}</span>
                  ))}
                </div>
                {r.ok ? (
                  <span className="text-sm font-mono text-navy">
                    gross {formatCurrency(r.grossPay ?? '0')} / net {formatCurrency(r.netPay ?? '0')}
                  </span>
                ) : (
                  <span className="text-xs text-red-600">{r.error}</span>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ---- New pay run ---- */}
      <Card className="mb-6">
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-navy/60 uppercase tracking-wide">
            New Pay Run
          </h2>
        </div>
        <div className="px-5 pb-4">
          <div className="grid grid-cols-5 gap-3 mb-4">
            <div>
              <Label htmlFor="runPayDate">Pay Date *</Label>
              <Input
                id="runPayDate"
                type="date"
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="runPeriodStart">Period Start</Label>
              <Input
                id="runPeriodStart"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="runPeriodEnd">Period End</Label>
              <Input
                id="runPeriodEnd"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="runFrequency">Frequency</Label>
              <Select
                id="runFrequency"
                value={periodsPerYear}
                onChange={(e) => setPeriodsPerYear(e.target.value)}
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="runMemo">Memo</Label>
              <Input
                id="runMemo"
                placeholder="e.g. June 1-15 payroll"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          {loading ? (
            <div className="p-8 flex justify-center text-electric">
              <Spinner className="h-6 w-6" />
            </div>
          ) : employees.length === 0 ? (
            <EmptyState
              icon={UserSquare}
              title="No active employees"
              message="Add employees before running batch payroll."
              action={
                <Link href="/employees">
                  <Button>Go to Employees</Button>
                </Link>
              }
            />
          ) : (
            <>
              <Table>
                <thead>
                  <tr>
                    <Th className="w-8">
                      <input
                        type="checkbox"
                        className="accent-electric"
                        checked={selectedEmployees.length === employees.length}
                        onChange={(e) =>
                          setRows((prev) => {
                            const next = { ...prev };
                            for (const emp of employees) {
                              next[emp.id] = { ...next[emp.id], selected: e.target.checked };
                            }
                            return next;
                          })
                        }
                      />
                    </Th>
                    <Th>Employee</Th>
                    <Th>Pay Basis</Th>
                    <Th numeric>Hours</Th>
                    <Th numeric>Amount Override</Th>
                    <Th>Time</Th>
                    <Th numeric>Est. Gross</Th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((emp) => {
                    const row = rows[emp.id];
                    if (!row) return null;
                    const est = estimatedGross(emp, row);
                    const hoursEditable =
                      (emp.payType === 'hourly' || row.timeEntryIds.length > 0) && !row.amount;
                    return (
                      <Tr key={emp.id} className={row.selected ? undefined : 'opacity-50'}>
                        <Td>
                          <input
                            type="checkbox"
                            className="accent-electric"
                            checked={row.selected}
                            onChange={(e) => updateRow(emp.id, { selected: e.target.checked })}
                          />
                        </Td>
                        <Td className="font-semibold text-navy">
                          {emp.firstName} {emp.lastName}
                        </Td>
                        <Td className="text-navy/70 text-sm">
                          {PAY_TYPE_LABELS[emp.payType]} — {formatCurrency(emp.payRate)}
                          {emp.payType === 'hourly' && <span className="text-navy/40 text-xs">/hr</span>}
                          {emp.payType === 'salary' && <span className="text-navy/40 text-xs">/yr</span>}
                        </Td>
                        <Td numeric>
                          <Input
                            type="number"
                            min="0"
                            step="0.25"
                            className="w-20 text-right ml-auto"
                            value={row.hours}
                            disabled={!hoursEditable || row.timeEntryIds.length > 0}
                            placeholder={emp.payType === 'hourly' ? '80' : '—'}
                            onChange={(e) => updateRow(emp.id, { hours: e.target.value })}
                          />
                        </Td>
                        <Td numeric>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="w-28 text-right ml-auto"
                            value={row.amount}
                            placeholder={emp.payType === 'commission' ? 'required' : 'optional'}
                            onChange={(e) => updateRow(emp.id, { amount: e.target.value })}
                          />
                        </Td>
                        <Td>
                          {row.pulledHours ? (
                            <span className="inline-flex items-center gap-2">
                              <Badge tone="info">{row.pulledHours} hrs pulled</Badge>
                              <button
                                type="button"
                                className="text-xs text-navy/40 hover:text-red-500"
                                onClick={() => clearPulledTime(emp.id, emp)}
                                title="Clear pulled time entries"
                              >
                                clear
                              </button>
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={row.pulling}
                              disabled={!periodStart || !periodEnd}
                              title={
                                !periodStart || !periodEnd
                                  ? 'Set the period dates to pull time entries'
                                  : 'Pull unpaid time entries for the period (hours x pay rate)'
                              }
                              onClick={() => pullTime(emp)}
                            >
                              <Clock className="h-3.5 w-3.5" />
                              Pull time
                            </Button>
                          )}
                        </Td>
                        <Td numeric className="font-mono text-navy">
                          {est ? formatCurrency(est.toFixed(2)) : <span className="text-red-500 text-xs">needs amount</span>}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-navy/60">
                  {selectedEmployees.length} of {employees.length} employees selected —
                  estimated gross{' '}
                  <span className="font-mono font-semibold text-navy">
                    {formatCurrency(totalEstimate.toFixed(2))}
                  </span>
                  <span className="text-xs text-navy/40 ml-2">
                    (taxes auto-withheld per W-4; failures are reported per employee)
                  </span>
                </p>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={selectedEmployees.length === 0 || !payDate}
                >
                  <Play className="h-4 w-4" />
                  Run Payroll
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* ---- Past runs ---- */}
      <Card>
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-navy/60 uppercase tracking-wide">Past Pay Runs</h2>
        </div>
        {loading ? (
          <div className="p-8 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : runs.length === 0 ? (
          <div className="p-8 text-center text-navy/40 text-sm">No pay runs yet.</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-8" />
                <Th>Pay Date</Th>
                <Th>Period</Th>
                <Th>Memo</Th>
                <Th numeric>Paychecks</Th>
                <Th numeric>Total Gross</Th>
                <Th numeric>Total Net</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <Fragment key={run.id}>
                  <Tr
                    className="cursor-pointer"
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  >
                    <Td>
                      {expandedRun === run.id ? (
                        <ChevronDown className="h-4 w-4 text-navy/40" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-navy/40" />
                      )}
                    </Td>
                    <Td className="font-semibold text-navy">{formatDate(run.payDate)}</Td>
                    <Td className="text-navy/50 text-xs">
                      {run.periodStart && run.periodEnd
                        ? `${formatDate(run.periodStart)} - ${formatDate(run.periodEnd)}`
                        : '-'}
                    </Td>
                    <Td className="text-navy/70">{run.memo ?? '-'}</Td>
                    <Td numeric className="text-navy/70">{run.paychecks.length}</Td>
                    <Td numeric className="font-mono text-navy">{formatCurrency(run.totalGross)}</Td>
                    <Td numeric className="font-mono font-semibold text-navy">{formatCurrency(run.totalNet)}</Td>
                  </Tr>
                  {expandedRun === run.id &&
                    run.paychecks.map((pc) => (
                      <Tr key={pc.id} className="bg-slate-50/60">
                        <Td />
                        <Td className="text-navy/70 pl-8" colSpan={3}>
                          {pc.employeeName}
                          {pc.isVoid && (
                            <Badge tone="void" className="ml-2">Void</Badge>
                          )}
                        </Td>
                        <Td />
                        <Td numeric className="font-mono text-navy/70">{formatCurrency(pc.grossPay)}</Td>
                        <Td numeric className="font-mono text-navy/70">{formatCurrency(pc.netPay)}</Td>
                      </Tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Run confirmation ---- */}
      <ConfirmDialog
        open={confirmOpen}
        title="Run payroll?"
        message={`Post ${selectedEmployees.length} paycheck${selectedEmployees.length === 1 ? '' : 's'} dated ${payDate} (estimated gross ${formatCurrency(totalEstimate.toFixed(2))})? Taxes are withheld automatically; each check posts to the GL.`}
        confirmLabel="Run Payroll"
        loading={running}
        onConfirm={handleRun}
        onClose={() => setConfirmOpen(false)}
      />
    </main>
  );
}
