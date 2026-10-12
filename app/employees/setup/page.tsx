'use client';

/**
 * Payroll setup (after-the-fact payroll):
 *   - Year-to-date amounts — historical paychecks or quarter totals per employee when you start
 *     mid-year (QB "Set Up YTD Amounts"). They count on W-2s, 941/940, pay-stub YTD and the
 *     wage limits; by default they do NOT touch your accounts (the General Ledger import already
 *     has them).
 *   - Adjust liabilities — correct what is owed for a tax or deduction.
 *   - State payroll taxes — unemployment (SUI) and disability (SDI) rates and wage bases.
 *   - Workers' comp — class codes and rates per $100 of wages.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Label,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api, ApiError } from '@/lib/client';

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}
type LineKind = 'earning' | 'tax' | 'deduction' | 'employer_contribution';
interface AdjLine {
  kind: LineKind;
  name: string;
  amount: string;
}
interface Adjustment {
  id: string;
  employeeId: string;
  employeeName: string;
  entryType: 'ytd_adjustment' | 'liability_adjustment';
  payDate: string;
  grossPay: string;
  netPay: string;
  memo: string | null;
  affectsAccounts: boolean;
  isVoid: boolean;
  lines: Array<{ kind: string; name: string; amount: string }>;
}
interface StateSetting {
  id: string;
  state: string;
  year: number;
  suiRate: string;
  suiWageBase: string;
  sdiRate: string;
  sdiWageBase: string;
  accountNumber: string | null;
}
interface WcCode {
  id: string;
  code: string;
  description: string | null;
  ratePer100: string;
  isActive: boolean;
}

const KIND_LABEL: Record<LineKind, string> = {
  earning: 'Wages',
  tax: 'Tax withheld',
  deduction: 'Deduction',
  employer_contribution: 'Employer tax / contribution',
};

const YTD_TEMPLATE: AdjLine[] = [
  { kind: 'earning', name: 'Regular', amount: '' },
  { kind: 'tax', name: 'Federal Income Tax', amount: '' },
  { kind: 'tax', name: 'Social Security', amount: '' },
  { kind: 'tax', name: 'Medicare', amount: '' },
  { kind: 'employer_contribution', name: 'Employer Social Security', amount: '' },
  { kind: 'employer_contribution', name: 'Employer Medicare', amount: '' },
  { kind: 'employer_contribution', name: 'Federal Unemployment (FUTA)', amount: '' },
];

const money = (v: string | number) => Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pct = (fraction: string) => `${(Number(fraction) * 100).toFixed(3).replace(/\.?0+$/, '')}%`;

function quarterEnd(year: number, q: number) {
  const d = new Date(Date.UTC(year, q * 3, 0));
  return d.toISOString().slice(0, 10);
}

type Tab = 'ytd' | 'liability' | 'state' | 'wc';

export default function PayrollSetupPage() {
  const [tab, setTab] = useState<Tab>('ytd');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [settings, setSettings] = useState<StateSetting[]>([]);
  const [codes, setCodes] = useState<WcCode[]>([]);

  const reload = useCallback(async () => {
    try {
      const [emps, accts, adjs, st, wc] = await Promise.all([
        api.get<Employee[]>('/api/employees?includeInactive=true'),
        api.get<Account[]>('/api/accounts'),
        api.get<Adjustment[]>('/api/payroll/adjustments'),
        api.get<StateSetting[]>('/api/payroll/state-settings'),
        api.get<WcCode[]>('/api/payroll/workers-comp'),
      ]);
      setEmployees(emps);
      setAccounts(accts);
      setAdjustments(adjs);
      setSettings(st);
      setCodes(wc);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load payroll setup.', 'danger');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'ytd', label: 'Year-to-date amounts' },
    { key: 'liability', label: 'Adjust liabilities' },
    { key: 'state', label: 'State payroll taxes' },
    { key: 'wc', label: "Workers' comp" },
  ];

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Payroll setup"
        icon={Settings2}
        action={
          <Link href="/employees" className="text-sm text-electric underline">
            Back to Payroll
          </Link>
        }
      />
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap gap-2" role="tablist">
          {tabs.map((t) => (
            <Button key={t.key} role="tab" aria-selected={tab === t.key} variant={tab === t.key ? 'primary' : 'secondary'} onClick={() => setTab(t.key)}>
              {t.label}
            </Button>
          ))}
        </div>

        {tab === 'ytd' && (
          <AdjustmentForm
            kind="ytd"
            employees={employees}
            accounts={accounts}
            onSaved={reload}
          />
        )}
        {tab === 'liability' && (
          <AdjustmentForm kind="liability" employees={employees} accounts={accounts} onSaved={reload} />
        )}
        {(tab === 'ytd' || tab === 'liability') && (
          <AdjustmentList
            rows={adjustments.filter((a) => (tab === 'ytd' ? a.entryType === 'ytd_adjustment' : a.entryType === 'liability_adjustment'))}
            onChanged={reload}
          />
        )}
        {tab === 'state' && <StateTaxes rows={settings} onChanged={reload} />}
        {tab === 'wc' && <WorkersComp rows={codes} onChanged={reload} />}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// YTD / liability adjustment form
// ---------------------------------------------------------------------------

function AdjustmentForm({
  kind,
  employees,
  accounts,
  onSaved,
}: {
  kind: 'ytd' | 'liability';
  employees: Employee[];
  accounts: Account[];
  onSaved: () => void;
}) {
  const year = new Date().getFullYear();
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(quarterEnd(year, 1));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<AdjLine[]>(
    kind === 'ytd' ? YTD_TEMPLATE.map((l) => ({ ...l })) : [{ kind: 'tax', name: 'Federal Income Tax', amount: '' }],
  );
  const [affects, setAffects] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  const bankAccounts = accounts.filter((a) => a.type === 'asset' && (a.subtype === 'checking' || a.subtype === 'savings'));
  const expenseAccounts = accounts.filter((a) => a.type === 'expense');

  const totals = useMemo(() => {
    const sum = (k: LineKind) => lines.filter((l) => l.kind === k).reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const gross = sum('earning');
    return { gross, net: gross - sum('tax') - sum('deduction') };
  }, [lines]);

  async function save() {
    if (!employeeId) {
      toast('Choose the employee.', 'danger');
      return;
    }
    const filled = lines.filter((l) => l.name.trim() && l.amount.trim() && Number(l.amount) !== 0);
    if (!filled.length) {
      toast('Enter at least one amount.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/payroll/adjustments', {
        type: kind,
        employeeId,
        date,
        memo: memo || null,
        lines: filled.map((l) => ({ kind: l.kind, name: l.name.trim(), amount: l.amount.trim() })),
        affectsAccounts: affects,
        ...(affects && accountId ? (kind === 'ytd' ? { bankAccountId: accountId } : { offsetAccountId: accountId }) : {}),
      });
      toast(kind === 'ytd' ? 'Year-to-date amounts saved.' : 'Liability adjustment saved.', 'success');
      setLines(kind === 'ytd' ? YTD_TEMPLATE.map((l) => ({ ...l })) : [{ kind: 'tax', name: 'Federal Income Tax', amount: '' }]);
      setMemo('');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const kinds: LineKind[] = kind === 'ytd' ? ['earning', 'tax', 'deduction', 'employer_contribution'] : ['tax', 'deduction', 'employer_contribution'];

  return (
    <Card className="p-6 space-y-4">
      {kind === 'ytd' ? (
        <p className="text-sm text-navy/70">
          Starting payroll here partway through the year? Enter what each employee was already paid — one historical
          paycheck at a time, or one total per quarter. These amounts appear on W-2s, quarterly 941s and pay stubs, and
          count toward wage limits such as Social Security&apos;s yearly maximum.
        </p>
      ) : (
        <p className="text-sm text-navy/70">
          Correct how much you owe for a payroll tax or deduction (for example a rounding difference or a missed
          deduction). Use a minus sign to lower the amount owed. See <Help term="payroll-liabilities">payroll liabilities</Help>.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor={`${kind}-emp`} required>Employee</Label>
          <Select id={`${kind}-emp`} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.lastName}, {e.firstName}
                {e.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor={`${kind}-date`} required>{kind === 'ytd' ? 'Pay date (or last day of the quarter)' : 'Date'}</Label>
          <Input id={`${kind}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {kind === 'ytd' && (
            <div className="mt-1 flex gap-1">
              {[1, 2, 3, 4].map((q) => (
                <button key={q} type="button" className="text-xs text-electric underline" onClick={() => setDate(quarterEnd(Number(date.slice(0, 4)) || year, q))}>
                  Q{q}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <Label htmlFor={`${kind}-memo`}>Memo</Label>
          <Input id={`${kind}-memo`} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Q1 totals from old payroll" />
        </div>
      </div>

      <Table>
        <thead>
          <tr>
            <Th>What</Th>
            <Th>Payroll item</Th>
            <Th numeric>Amount</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <Tr key={i}>
              <Td>
                <Select
                  aria-label="Line type"
                  value={l.kind}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, kind: e.target.value as LineKind } : x)))}
                >
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Td>
              <Td>
                <Input aria-label="Payroll item name" value={l.name} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              </Td>
              <Td>
                <Input
                  aria-label="Amount"
                  inputMode="decimal"
                  className="text-right"
                  value={l.amount}
                  placeholder="0.00"
                  onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                />
              </Td>
              <Td>
                <Button variant="ghost" size="sm" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  ×
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => setLines((ls) => [...ls, { kind: kinds[0], name: '', amount: '' }])}>
          + Add a line
        </Button>
        {kind === 'ytd' && (
          <p className="text-sm text-navy">
            Gross {money(totals.gross)} · Net pay {money(totals.net)}
          </p>
        )}
      </div>

      <label className="flex items-start gap-2 text-sm text-navy">
        <input type="checkbox" className="mt-1" checked={affects} onChange={(e) => setAffects(e.target.checked)} />
        <span>
          Also record this in my accounts
          <span className="block text-xs text-navy/50">
            {kind === 'ytd'
              ? 'Leave this off if your General Ledger was imported from QuickBooks — those paychecks are already in your books, and recording them again would count them twice.'
              : 'Posts the change to Payroll Liabilities with the other side to an expense account.'}
          </span>
        </span>
      </label>
      {affects && (
        <div className="max-w-sm">
          <Label htmlFor={`${kind}-acct`}>{kind === 'ytd' ? 'Net pay was paid from' : 'Expense account for the other side'}</Label>
          <Select id={`${kind}-acct`} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{kind === 'ytd' ? 'Checking (1000)' : 'Payroll Tax Expense'}</option>
            {(kind === 'ytd' ? bankAccounts : expenseAccounts).map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <Button onClick={save} loading={saving}>
        Save
      </Button>
    </Card>
  );
}

function AdjustmentList({ rows, onChanged }: { rows: Adjustment[]; onChanged: () => void }) {
  const [voidId, setVoidId] = useState<string | null>(null);
  async function doVoid() {
    if (!voidId) return;
    try {
      await api.del(`/api/payroll/adjustments/${voidId}`);
      toast('Voided.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not void.', 'danger');
    } finally {
      setVoidId(null);
    }
  }
  if (!rows.length) return <p className="text-sm text-navy/50">Nothing entered yet.</p>;
  return (
    <Card className="p-6">
      <Table>
        <thead>
          <tr>
            <Th>Date</Th>
            <Th>Employee</Th>
            <Th>Details</Th>
            <Th numeric>Gross</Th>
            <Th>In accounts</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td>{String(r.payDate).slice(0, 10)}</Td>
              <Td>{r.employeeName}</Td>
              <Td className="text-xs text-navy/70">
                {r.lines.map((l) => `${l.name} ${money(l.amount)}`).join(' · ')}
                {r.memo ? ` — ${r.memo}` : ''}
              </Td>
              <Td numeric>{money(r.grossPay)}</Td>
              <Td>{r.affectsAccounts ? <Badge tone="info">Yes</Badge> : <Badge tone="neutral">No</Badge>}</Td>
              <Td>
                <Button variant="ghost" size="sm" onClick={() => setVoidId(r.id)}>
                  Void
                </Button>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <ConfirmDialog
        open={!!voidId}
        title="Void this entry?"
        message="It will no longer count on W-2s, 941s or reports. If it was recorded in your accounts, that entry is voided too."
        confirmLabel="Void"
        tone="danger"
        onConfirm={doVoid}
        onClose={() => setVoidId(null)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// State payroll taxes (SUI / SDI)
// ---------------------------------------------------------------------------

function StateTaxes({ rows, onChanged }: { rows: StateSetting[]; onChanged: () => void }) {
  const [form, setForm] = useState({
    state: '',
    year: String(new Date().getFullYear()),
    suiRate: '',
    suiWageBase: '',
    sdiRate: '',
    sdiWageBase: '',
    accountNumber: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      await api.post('/api/payroll/state-settings', {
        state: form.state.trim().toUpperCase(),
        year: Number(form.year),
        suiRate: (Number(form.suiRate || 0) / 100).toFixed(6),
        suiWageBase: form.suiWageBase || '0',
        sdiRate: (Number(form.sdiRate || 0) / 100).toFixed(6),
        sdiWageBase: form.sdiWageBase || '0',
        accountNumber: form.accountNumber || null,
      });
      toast('State payroll taxes saved.', 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.del(`/api/payroll/state-settings/${id}`);
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not remove.', 'danger');
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <p className="text-sm text-navy/70">
        Your state sends you an unemployment (SUI) rate every year. Enter it here with the yearly wage limit, and new
        paychecks will add the employer&apos;s unemployment tax for employees who work in that state. If your state has
        employee disability insurance (SDI — for example California), enter that rate too; it is withheld from pay.
        The employee&apos;s work state comes from their W-4 state (or their address).
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <Label htmlFor="st-state" required>State</Label>
          <Input id="st-state" maxLength={2} value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="CA" />
        </div>
        <div>
          <Label htmlFor="st-year" required>Year</Label>
          <Input id="st-year" type="number" value={form.year} onChange={(e) => set('year', e.target.value)} />
        </div>
        <div>
          <Label htmlFor="st-sui">Unemployment rate %</Label>
          <Input id="st-sui" inputMode="decimal" value={form.suiRate} onChange={(e) => set('suiRate', e.target.value)} placeholder="3.4" />
        </div>
        <div>
          <Label htmlFor="st-suibase">Unemployment wage limit</Label>
          <Input id="st-suibase" inputMode="decimal" value={form.suiWageBase} onChange={(e) => set('suiWageBase', e.target.value)} placeholder="7000" />
        </div>
        <div>
          <Label htmlFor="st-sdi">Disability (SDI) rate %</Label>
          <Input id="st-sdi" inputMode="decimal" value={form.sdiRate} onChange={(e) => set('sdiRate', e.target.value)} placeholder="0" />
        </div>
        <div>
          <Label htmlFor="st-sdibase">Disability wage limit (0 = none)</Label>
          <Input id="st-sdibase" inputMode="decimal" value={form.sdiWageBase} onChange={(e) => set('sdiWageBase', e.target.value)} placeholder="0" />
        </div>
        <div>
          <Label htmlFor="st-acct">State account number</Label>
          <Input id="st-acct" value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} />
        </div>
        <div className="flex items-end">
          <Button onClick={save} loading={saving} disabled={!/^[A-Za-z]{2}$/.test(form.state)}>
            Save
          </Button>
        </div>
      </div>
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>State</Th>
              <Th>Year</Th>
              <Th numeric>Unemployment</Th>
              <Th numeric>Wage limit</Th>
              <Th numeric>Disability</Th>
              <Th numeric>Wage limit</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>{r.state}</Td>
                <Td>{r.year}</Td>
                <Td numeric>{pct(r.suiRate)}</Td>
                <Td numeric>{Number(r.suiWageBase) ? money(r.suiWageBase) : 'No limit'}</Td>
                <Td numeric>{pct(r.sdiRate)}</Td>
                <Td numeric>{Number(r.sdiWageBase) ? money(r.sdiWageBase) : 'No limit'}</Td>
                <Td>
                  <Button variant="ghost" size="sm" onClick={() => remove(r.id)}>
                    Remove
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <p className="text-xs text-navy/50">
        Quarterly wage report: <Link href="/payroll-forms/reports" className="text-electric underline">Payroll reports › State wage worksheet</Link>.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Workers' comp
// ---------------------------------------------------------------------------

function WorkersComp({ rows, onChanged }: { rows: WcCode[]; onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [rate, setRate] = useState('');
  async function add() {
    try {
      await api.post('/api/payroll/workers-comp', { code, description: desc || null, ratePer100: rate });
      setCode('');
      setDesc('');
      setRate('');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'danger');
    }
  }
  async function patch(id: string, body: Partial<WcCode>) {
    try {
      await api.patch(`/api/payroll/workers-comp/${id}`, body);
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'danger');
    }
  }
  return (
    <Card className="p-6 space-y-4">
      <p className="text-sm text-navy/70">
        Workers&apos; compensation insurance is priced per $100 of wages for each job class. Add your class codes here,
        then pick a code on each employee (Payroll › edit employee). Every paycheck then records the premium you owe.
      </p>
      <div className="grid gap-3 sm:grid-cols-4 items-end">
        <div>
          <Label htmlFor="wc-code" required>Class code</Label>
          <Input id="wc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="8810" />
        </div>
        <div>
          <Label htmlFor="wc-desc">Description</Label>
          <Input id="wc-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Clerical office" />
        </div>
        <div>
          <Label htmlFor="wc-rate" required>Rate per $100 of wages</Label>
          <Input id="wc-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.35" />
        </div>
        <Button onClick={add} disabled={!code.trim() || !rate.trim()}>
          Add
        </Button>
      </div>
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Description</Th>
              <Th numeric>Rate per $100</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="font-mono">{r.code}</Td>
                <Td>{r.description ?? '—'}</Td>
                <Td numeric>{money(r.ratePer100)}</Td>
                <Td>{r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                <Td>
                  <Button variant="ghost" size="sm" onClick={() => patch(r.id, { isActive: !r.isActive })}>
                    {r.isActive ? 'Make inactive' : 'Make active'}
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
