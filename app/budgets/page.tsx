'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart2, Plus } from 'lucide-react';
import {
  Badge,
  Select,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Budget {
  id: string;
  name: string;
  fiscalYear: number;
  /** 'profit_loss' | 'balance_sheet' */
  kind?: string;
  isForecast?: boolean;
  createdAt: string;
}

interface BudgetLine {
  id: string;
  budgetId: string;
  accountId: string;
  customerId?: string | null;
  classId?: string | null;
  month: number;
  amount: string;
}

interface BudgetWithLines extends Budget {
  lines: BudgetLine[];
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive: boolean;
}

interface PeriodCell {
  budget: string;
  actual: string;
  variance: string;
}

interface VsActualRow {
  accountId: string;
  code: string;
  name: string;
  budget: string;
  actual: string;
  variance: string;
  periods?: PeriodCell[];
}

interface VsActualReport {
  budgetId: string;
  budgetName: string;
  fiscalYear: number;
  rows: VsActualRow[];
  totalBudget: string;
  totalActual: string;
  totalVariance: string;
  periodLabels?: string[];
  periodNetTotals?: PeriodCell[];
}

type PeriodMode = 'annual' | 'monthly' | 'quarterly';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getLineAmount(lines: BudgetLine[], accountId: string, month: number, customerId = ''): string {
  const line = lines.find(
    (l) => l.accountId === accountId && l.month === month && (l.customerId ?? '') === customerId && !l.classId,
  );
  return line?.amount ?? '';
}

function varianceColor(variance: string): string {
  const n = Number(variance);
  if (n > 0) return 'text-emerald';
  if (n < 0) return 'text-red-500';
  return 'text-navy/60';
}

// ---------------------------------------------------------------------------
// New Budget modal form
// ---------------------------------------------------------------------------

function NewBudgetModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (b: Budget) => void;
}) {
  const [name, setName] = useState('');
  const [fiscalYear, setFiscalYear] = useState(String(new Date().getFullYear()));
  const [kind, setKind] = useState<'profit_loss' | 'balance_sheet'>('profit_loss');
  const [isForecast, setIsForecast] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) { toast('Budget name is required', 'danger'); return; }
    const yr = Number(fiscalYear);
    if (!yr || yr < 2000 || yr > 2100) { toast('Enter a valid 4-digit fiscal year', 'danger'); return; }
    setSaving(true);
    try {
      const budget = await api.post<Budget>('/api/budgets', { name: name.trim(), fiscalYear: yr, kind, isForecast });
      toast(isForecast ? 'Forecast created' : 'Budget created', 'success');
      onCreated(budget);
      setName('');
      setFiscalYear(String(new Date().getFullYear()));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create budget', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Budget"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button loading={saving} onClick={handleCreate}>Create Budget</Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <div>
          <Label htmlFor="budgetName">Budget Name *</Label>
          <Input
            id="budgetName"
            autoFocus
            placeholder="e.g. FY2025 Annual Budget"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="fiscalYear">Fiscal Year *</Label>
          <Input
            id="fiscalYear"
            type="number"
            min={2000}
            max={2100}
            placeholder="e.g. 2025"
            value={fiscalYear}
            onChange={(e) => setFiscalYear(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="budgetKind">What are you planning?</Label>
          <Select id="budgetKind" value={kind} onChange={(e) => setKind(e.target.value as 'profit_loss' | 'balance_sheet')}>
            <option value="profit_loss">Income and expenses (Profit &amp; Loss)</option>
            <option value="balance_sheet">Month-end balances (Balance Sheet)</option>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm text-navy">
          <input type="checkbox" className="accent-[#2563eb]" checked={isForecast} onChange={(e) => setIsForecast(e.target.checked)} />
          This is a forecast (your best guess), not a budget (your target)
        </label>
        <p className="text-xs text-navy/50">
          You can enter amounts for the whole company, or pick a Customer:Job in the grid to budget for one customer or job.
        </p>
        {/* Hidden submit so Enter submits the form in all browsers */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Monthly Budget Grid
// ---------------------------------------------------------------------------

function BudgetGrid({
  budget,
  accounts,
  onLineChange,
  customerId,
}: {
  budget: BudgetWithLines;
  accounts: Account[];
  onLineChange: (accountId: string, month: number, amount: string) => void;
  /** Customer:Job being budgeted ('' = whole company). */
  customerId: string;
}) {
  // P&L budgets: income and expense accounts. Balance-sheet budgets: asset, liability, equity.
  const isBs = budget.kind === 'balance_sheet';
  const relevantAccounts = accounts.filter(
    (a) => (isBs ? !['revenue', 'expense'].includes(a.type) : a.type === 'revenue' || a.type === 'expense') && a.isActive,
  );

  return (
    <div className="overflow-x-auto">
      {/* Keyed by budget so switching budgets remounts the uncontrolled inputs. */}
      <table key={`${budget.id}:${customerId}`} className="w-full border-collapse text-sm min-w-[900px]">
        <thead>
          <tr>
            <th className="py-2.5 px-3 text-left font-semibold text-navy/70 border-b-2 border-navy/10 sticky left-0 bg-white z-10 min-w-[180px]">
              Account
            </th>
            {MONTHS.map((m) => (
              <th
                key={m}
                className="py-2.5 px-2 text-right font-semibold text-navy/70 border-b-2 border-navy/10 min-w-[90px]"
              >
                {m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {relevantAccounts.length === 0 ? (
            <tr>
              <td colSpan={13} className="py-8 text-center text-navy/40">
                {isBs ? 'No balance sheet accounts found.' : 'No income or expense accounts found.'} Add accounts first.
              </td>
            </tr>
          ) : (
            relevantAccounts.map((acct) => (
              <tr key={acct.id} className="border-b border-slate-100 hover:bg-electric/5">
                <td className="py-1.5 px-3 sticky left-0 bg-white z-10">
                  <span className="text-navy/50 text-xs mr-1">{acct.code}</span>
                  <span className="text-navy font-medium">{acct.name}</span>
                </td>
                {MONTHS.map((_, idx) => {
                  const month = idx + 1;
                  const current = getLineAmount(budget.lines, acct.id, month, customerId);
                  return (
                    <td key={month} className="py-1 px-1">
                      <input
                        type="number"
                        step="0.01"
                        placeholder="—"
                        aria-label={`${acct.name} ${MONTHS[idx]}`}
                        defaultValue={current || ''}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val !== current) {
                            onLineChange(acct.id, month, val || '0');
                          }
                        }}
                        className="w-full rounded border border-slate-200 px-2 py-1 text-right text-sm text-navy outline-none focus:border-electric focus:ring-1 focus:ring-electric/30 placeholder:text-navy/20"
                      />
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget vs Actual view
// ---------------------------------------------------------------------------

function BudgetVsActualView({ report }: { report: VsActualReport }) {
  // Period-column mode (monthly/quarterly): per-period budget/actual grid.
  if (report.periodLabels && report.periodLabels.length > 0) {
    return (
      <div>
        <h3 className="text-lg font-bold text-navy mb-3">
          Budget vs Actual — FY{report.fiscalYear}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[900px]">
            <thead>
              <tr>
                <th className="py-2.5 px-3 text-left font-semibold text-navy/70 border-b-2 border-navy/10 sticky left-0 bg-white z-10 min-w-[160px]">
                  Account
                </th>
                {report.periodLabels.map((label) => (
                  <th
                    key={label}
                    className="py-2.5 px-2 text-right font-semibold text-navy/70 border-b-2 border-navy/10 min-w-[110px]"
                  >
                    {label}
                    <div className="text-[10px] font-normal text-navy/40">Actual / Budget</div>
                  </th>
                ))}
                <th className="py-2.5 px-2 text-right font-semibold text-navy/70 border-b-2 border-navy/10 min-w-[110px]">
                  Total Var.
                </th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.accountId} className="border-b border-slate-100 hover:bg-electric/5">
                  <td className="py-1.5 px-3 sticky left-0 bg-white z-10">
                    <span className="text-navy/50 text-xs mr-1">{row.code}</span>
                    <span className="text-navy font-medium">{row.name}</span>
                  </td>
                  {(row.periods ?? []).map((cell, i) => (
                    <td key={i} className="py-1.5 px-2 text-right tabular-nums">
                      <div className="text-navy">{formatCurrency(cell.actual)}</div>
                      <div className="text-xs text-navy/45">{formatCurrency(cell.budget)}</div>
                    </td>
                  ))}
                  <td
                    className={`py-1.5 px-2 text-right tabular-nums font-semibold ${varianceColor(row.variance)}`}
                  >
                    {Number(row.variance) > 0 ? '+' : ''}
                    {formatCurrency(row.variance)}
                  </td>
                </tr>
              ))}
            </tbody>
            {report.periodNetTotals && (
              <tfoot>
                <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                  <td className="py-2.5 px-3 sticky left-0 bg-navy/5 z-10">Net (Actual / Budget)</td>
                  {report.periodNetTotals.map((cell, i) => (
                    <td key={i} className="py-2.5 px-2 text-right tabular-nums">
                      <div>{formatCurrency(cell.actual)}</div>
                      <div className="text-xs font-normal text-navy/50">
                        {formatCurrency(cell.budget)}
                      </div>
                    </td>
                  ))}
                  <td className={`py-2.5 px-2 text-right tabular-nums ${varianceColor(report.totalVariance)}`}>
                    {Number(report.totalVariance) > 0 ? '+' : ''}
                    {formatCurrency(report.totalVariance)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-lg font-bold text-navy mb-3">
        Budget vs Actual — FY{report.fiscalYear}
      </h3>
      <Table>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th className="text-right">Budget</Th>
            <Th className="text-right">Actual</Th>
            <Th className="text-right">Variance</Th>
          </tr>
        </thead>
        <tbody>
          {report.rows.length === 0 ? (
            <tr>
              <Td colSpan={4} className="py-10 text-center text-navy/40">
                No budget lines have been set yet.
              </Td>
            </tr>
          ) : (
            report.rows.map((row) => (
              <Tr key={row.accountId}>
                <Td>
                  <span className="text-navy/50 text-xs mr-1">{row.code}</span>
                  <span className="font-medium text-navy">{row.name}</span>
                </Td>
                <Td className="text-right tabular-nums">{formatCurrency(row.budget)}</Td>
                <Td className="text-right tabular-nums">{formatCurrency(row.actual)}</Td>
                <Td className={`text-right tabular-nums font-semibold ${varianceColor(row.variance)}`}>
                  {Number(row.variance) > 0 ? '+' : ''}
                  {formatCurrency(row.variance)}
                </Td>
              </Tr>
            ))
          )}
        </tbody>
        {report.rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
              <td className="py-3 px-4">Total</td>
              <td className="py-3 px-4 text-right tabular-nums">
                {formatCurrency(report.totalBudget)}
              </td>
              <td className="py-3 px-4 text-right tabular-nums">
                {formatCurrency(report.totalActual)}
              </td>
              <td className={`py-3 px-4 text-right tabular-nums ${varianceColor(report.totalVariance)}`}>
                {Number(report.totalVariance) > 0 ? '+' : ''}
                {formatCurrency(report.totalVariance)}
              </td>
            </tr>
          </tfoot>
        )}
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BudgetsPage() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [budgetsLoading, setBudgetsLoading] = useState(true);

  const [newBudgetOpen, setNewBudgetOpen] = useState(false);

  // Currently selected budget detail.
  const [selected, setSelected] = useState<BudgetWithLines | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  // Accounts for the grid.
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);

  // Vs-actual report.
  const [vsActual, setVsActual] = useState<VsActualReport | null>(null);
  const [vsActualLoading, setVsActualLoading] = useState(false);
  // Period columns: annual totals (default), monthly, or quarterly.
  const [periodMode, setPeriodMode] = useState<PeriodMode>('annual');

  // Active tab on the right panel.
  const [tab, setTab] = useState<'grid' | 'vs-actual'>('grid');
  // Customer:Job dimension for the grid ('' = whole company).
  const [customerId, setCustomerId] = useState('');
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api
      .get<{ customers: { id: string; name: string }[] }>('/api/reports/filter-options')
      .then((o) => setCustomers(o.customers))
      .catch(() => setCustomers([]));
  }, []);

  // ---------------------------------------------------------------------------
  // Load budget list
  // ---------------------------------------------------------------------------

  const loadBudgets = useCallback(async () => {
    setBudgetsLoading(true);
    try {
      const list = await api.get<Budget[]>('/api/budgets');
      setBudgets(list);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load budgets', 'danger');
    } finally {
      setBudgetsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBudgets();
  }, [loadBudgets]);

  // ---------------------------------------------------------------------------
  // Load accounts (once)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (accountsLoaded) return;
    api
      .get<Account[]>('/api/accounts')
      .then((list) => {
        setAccounts(list);
        setAccountsLoaded(true);
      })
      .catch((err) => {
        toast(err instanceof ApiError ? err.message : 'Failed to load accounts', 'danger');
      });
  }, [accountsLoaded]);

  // ---------------------------------------------------------------------------
  // Select a budget
  // ---------------------------------------------------------------------------

  async function selectBudget(budget: Budget) {
    setSelectedLoading(true);
    setVsActual(null);
    setTab('grid');
    try {
      const full = await api.get<BudgetWithLines>(`/api/budgets/${budget.id}`);
      setSelected(full);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load budget', 'danger');
    } finally {
      setSelectedLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Set a budget line (called on blur)
  // ---------------------------------------------------------------------------

  async function handleLineChange(accountId: string, month: number, amount: string) {
    if (!selected) return;
    const numAmount = Number(amount);
    if (isNaN(numAmount)) return;
    try {
      await api.patch(`/api/budgets/${selected.id}`, { accountId, month, amount, customerId: customerId || null });
      // Refresh budget lines silently.
      const full = await api.get<BudgetWithLines>(`/api/budgets/${selected.id}`);
      setSelected(full);
      // Clear cached vs-actual so it reloads on next tab switch.
      setVsActual(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save budget line', 'danger');
    }
  }

  // ---------------------------------------------------------------------------
  // Load vs-actual
  // ---------------------------------------------------------------------------

  async function loadVsActual(mode: PeriodMode = periodMode) {
    if (!selected) return;
    setVsActualLoading(true);
    try {
      const url =
        mode === 'annual'
          ? `/api/budgets/${selected.id}/vs-actual`
          : `/api/reports/budget-vs-actual?budgetId=${selected.id}&periods=${mode}`;
      const report = await api.get<VsActualReport>(url);
      setVsActual(report);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load vs-actual report', 'danger');
    } finally {
      setVsActualLoading(false);
    }
  }

  function changePeriodMode(mode: PeriodMode) {
    setPeriodMode(mode);
    setVsActual(null);
    loadVsActual(mode);
  }

  function switchTab(t: 'grid' | 'vs-actual') {
    setTab(t);
    if (t === 'vs-actual' && !vsActual) {
      loadVsActual();
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Budgets"
        icon={BarChart2}
        action={
          <Button onClick={() => setNewBudgetOpen(true)}>
            <Plus className="h-4 w-4" />
            New Budget
          </Button>
        }
      />

      <div className="flex gap-6 items-start">
        {/* ---- Left: Budget list ---- */}
        <div className="w-64 shrink-0">
          <Card className="p-0 overflow-hidden">
            {budgetsLoading ? (
              <div className="flex items-center justify-center gap-2 p-6 text-navy/40 text-sm">
                <Spinner className="text-electric" />
                Loading...
              </div>
            ) : budgets.length === 0 ? (
              <EmptyState
                icon={BarChart2}
                title="No budgets yet"
                message="Create your first budget to get started."
                action={<Button onClick={() => setNewBudgetOpen(true)}>New Budget</Button>}
              />
            ) : (
              <ul>
                {budgets.map((b) => (
                  <li key={b.id}>
                    <button
                      onClick={() => selectBudget(b)}
                      className={`w-full text-left px-4 py-3 border-b border-slate-100 transition-colors ${
                        selected?.id === b.id
                          ? 'bg-electric/10 text-electric font-semibold'
                          : 'hover:bg-electric/5 text-navy'
                      }`}
                    >
                      <div className="font-medium text-sm truncate">{b.name}</div>
                      <div className="text-xs text-navy/50 mt-0.5 flex gap-1 items-center">
                        FY{b.fiscalYear}
                        {b.isForecast && <Badge tone="info">Forecast</Badge>}
                        {b.kind === 'balance_sheet' && <Badge tone="neutral">Balance sheet</Badge>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ---- Right: Detail panel ---- */}
        <div className="flex-1 min-w-0">
          {!selected && !selectedLoading && (
            <Card className="p-12 text-center">
              <BarChart2 className="mx-auto h-10 w-10 text-navy/20 mb-3" />
              <p className="text-navy/50 text-sm">
                Select a budget from the list to view and edit monthly amounts.
              </p>
            </Card>
          )}

          {selectedLoading && (
            <Card className="p-12">
              <div className="flex items-center justify-center gap-2 text-navy/40 text-sm">
                <Spinner className="text-electric" />
                Loading budget...
              </div>
            </Card>
          )}

          {selected && !selectedLoading && (
            <Card className="p-0 overflow-hidden">
              {/* Tab bar */}
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <div>
                  <span className="font-bold text-navy text-lg">{selected.name}</span>
                  <span className="ml-2 text-sm text-navy/50">FY{selected.fiscalYear}</span>
                  <div className="flex gap-3 mt-1 text-xs">
                    <Link
                      className="text-electric hover:underline"
                      href={`/reports/std/${selected.isForecast ? 'forecast-overview' : 'budget-overview'}?budgetId=${selected.id}${customerId ? `&customerId=${customerId}` : ''}`}
                    >
                      {selected.isForecast ? 'Forecast Overview' : 'Budget Overview'} report
                    </Link>
                    <Link
                      className="text-electric hover:underline"
                      href={`/reports/std/budget-vs-actual-report?budgetId=${selected.id}${customerId ? `&customerId=${customerId}` : ''}`}
                    >
                      {selected.isForecast ? 'Forecast' : 'Budget'} vs. Actual report
                    </Link>
                  </div>
                </div>
                <div className="flex gap-1">
                  {(['grid', 'vs-actual'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => switchTab(t)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                        tab === t
                          ? 'bg-electric text-white'
                          : 'text-navy/60 hover:bg-navy/5'
                      }`}
                    >
                      {t === 'grid' ? 'Monthly Budget' : 'Budget vs Actual'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4">
                {tab === 'grid' && (
                  <>
                    {selected.kind !== 'balance_sheet' && customers.length > 0 && (
                      <div className="flex items-end gap-2 mb-3">
                        <div className="min-w-[16rem]">
                          <Label htmlFor="budget-customer">Budget for</Label>
                          <Select id="budget-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                            <option value="">Whole company</option>
                            {customers.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <p className="text-xs text-navy/50 mb-2">A budget is either for the whole company or by Customer:Job — not both.</p>
                      </div>
                    )}
                    <BudgetGrid
                      budget={selected}
                      accounts={accounts}
                      onLineChange={handleLineChange}
                      customerId={selected.kind === 'balance_sheet' ? '' : customerId}
                    />
                  </>
                )}

                {tab === 'vs-actual' && (
                  <>
                    <div className="flex items-center gap-2 mb-4">
                      <span className="text-xs font-semibold text-navy/50 uppercase tracking-wide">
                        Columns
                      </span>
                      <div
                        className="flex rounded-lg border border-slate-200 overflow-hidden"
                        role="group"
                        aria-label="Period columns"
                      >
                        {(['annual', 'monthly', 'quarterly'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => changePeriodMode(mode)}
                            disabled={vsActualLoading}
                            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                              periodMode === mode
                                ? 'bg-electric text-white'
                                : 'bg-white text-navy/60 hover:bg-electric/5'
                            }`}
                          >
                            {mode === 'annual' ? 'Annual' : mode === 'monthly' ? 'Monthly' : 'Quarterly'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {vsActualLoading && (
                      <div className="flex items-center justify-center gap-2 py-12 text-navy/40 text-sm">
                        <Spinner className="text-electric" />
                        Loading report...
                      </div>
                    )}
                    {!vsActualLoading && vsActual && (
                      <BudgetVsActualView report={vsActual} />
                    )}
                    {!vsActualLoading && !vsActual && (
                      <div className="py-12 text-center">
                        <Button variant="secondary" size="sm" onClick={() => loadVsActual()}>
                          Load Report
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* New Budget modal */}
      <NewBudgetModal
        open={newBudgetOpen}
        onClose={() => setNewBudgetOpen(false)}
        onCreated={(b) => {
          setBudgets((prev) => [...prev, b]);
          setNewBudgetOpen(false);
          selectBudget(b);
        }}
      />
    </main>
  );
}
