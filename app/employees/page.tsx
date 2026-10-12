'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  UserSquare, Plus, Play, KeyRound, Pencil, Ban, RotateCcw, MinusCircle,
  CalendarClock, ListChecks,
} from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  ConfirmDialog,
  EmptyState,
  Spinner,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { EditPaycheckModal } from './EditPaycheckModal';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmployeeAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

type FilingStatus = 'single' | 'married' | 'head_of_household';

/** employees.w4 — 2020+ Form W-4 Steps 1(c)-4, or pre-2020 allowances (formYear < 2020). */
interface EmployeeW4 {
  filingStatus?: FilingStatus;
  formYear?: number;
  step2Checkbox?: boolean;
  dependentsAmount?: string;
  otherIncome?: string;
  deductions?: string;
  extraWithholding?: string;
  allowances?: number;
  exempt?: boolean;
  /** Work state for state payroll taxes (SUI / SDI). */
  state?: string;
  /** Legacy field from earlier versions (count of dependents, not used in the math). */
  dependents?: number;
}

interface WcCode {
  id: string;
  code: string;
  description: string | null;
  isActive: boolean;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  payType: 'hourly' | 'salary' | 'commission';
  payRate: string;
  ssnLast4: string | null;
  w4: EmployeeW4 | null;
  address: EmployeeAddress | null;
  isActive: boolean;
  phone?: string | null;
  hireDate?: string | null;
  releaseDate?: string | null;
  workersCompCodeId?: string | null;
}

interface Paycheck {
  id: string;
  employeeId: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  grossPay: string;
  totalTaxes: string;
  totalDeductions: string;
  netPay: string;
  postedEntryId: string | null;
  isVoid: boolean;
  ytdGross: string | null;
  ytdNet: string | null;
}

interface EmployeeFormState {
  firstName: string;
  lastName: string;
  email: string;
  payType: 'hourly' | 'salary' | 'commission';
  payRate: string;
  // Payroll info (edit modal)
  ssn: string; // new entry only — existing value shown masked
  filingStatus: FilingStatus;
  /** '2020' = redesigned W-4 (2020 or later), '2019' = older form with allowances. */
  w4Version: '2020' | '2019';
  step2: string; // 'true' | ''
  dependentsAmount: string;
  otherIncome: string;
  w4Deductions: string;
  allowances: string;
  extraWithholding: string;
  exempt: string; // 'true' | ''
  workState: string;
  phone: string;
  hireDate: string;
  releaseDate: string;
  workersCompCodeId: string;
  addrLine1: string;
  addrLine2: string;
  addrCity: string;
  addrState: string;
  addrZip: string;
  isActive: boolean;
}

type EarningKind = 'regular' | 'overtime' | 'bonus' | 'commission';

interface EarningRow {
  kind: EarningKind;
  hours: string;
  rate: string;
  amount: string;
}

interface PayrollLineInput {
  name: string;
  amount: string;
  /** Deduction rows only: payroll item providing GL mapping / pre-tax behavior. */
  payrollItemId?: string;
}

type PayrollItemKind = 'earning' | 'tax' | 'deduction' | 'employer_contribution' | 'garnishment';

interface PayrollItem {
  id: string;
  name: string;
  kind: PayrollItemKind;
  pretax: boolean;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
  calcBasis: 'fixed' | 'percent' | null;
  defaultRate: string | null;
  isActive: boolean;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface PayrollItemFormState {
  name: string;
  kind: PayrollItemKind;
  pretax: boolean;
  expenseAccountId: string;
  liabilityAccountId: string;
  calcBasis: '' | 'fixed' | 'percent';
  defaultRate: string;
}

interface PayrollFormState {
  employeeId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  earnings: EarningRow[];
  taxes: PayrollLineInput[];
  deductions: PayrollLineInput[];
}

// Leave accruals (GET/PUT /api/payroll/accruals)

interface AccrualBucket {
  rate: string | null;
  starting: string;
  accrued: string;
  balance: string;
}

interface AccrualRow {
  employeeId: string;
  hasPolicy: boolean;
  asOf: string | null;
  sick: AccrualBucket;
  vacation: AccrualBucket;
}

interface AccrualFormState {
  sickRate: string;
  vacRate: string;
  sickBalance: string;
  vacBalance: string;
  asOf: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_EMPLOYEE_FORM: EmployeeFormState = {
  firstName: '',
  lastName: '',
  email: '',
  payType: 'salary',
  payRate: '',
  ssn: '',
  filingStatus: 'single',
  w4Version: '2020',
  step2: '',
  dependentsAmount: '',
  otherIncome: '',
  w4Deductions: '',
  allowances: '',
  extraWithholding: '',
  exempt: '',
  workState: '',
  phone: '',
  hireDate: '',
  releaseDate: '',
  workersCompCodeId: '',
  addrLine1: '',
  addrLine2: '',
  addrCity: '',
  addrState: '',
  addrZip: '',
  isActive: true,
};

const EMPTY_ACCRUAL_FORM: AccrualFormState = {
  sickRate: '',
  vacRate: '',
  sickBalance: '',
  vacBalance: '',
  asOf: '',
};

const EMPTY_PAYROLL_FORM: PayrollFormState = {
  employeeId: '',
  payDate: new Date().toISOString().slice(0, 10),
  periodStart: '',
  periodEnd: '',
  earnings: [{ kind: 'regular', hours: '', rate: '', amount: '' }],
  taxes: [{ name: '', amount: '' }],
  deductions: [],
};

const PAY_TYPE_LABELS: Record<string, string> = {
  hourly: 'Hourly',
  salary: 'Salary',
  commission: 'Commission',
};

const EARNING_LABELS: Record<EarningKind, string> = {
  regular: 'Regular',
  overtime: 'Overtime',
  bonus: 'Bonus',
  commission: 'Commission',
};

const ITEM_KIND_LABELS: Record<PayrollItemKind, string> = {
  earning: 'Earning',
  tax: 'Tax',
  deduction: 'Deduction',
  employer_contribution: 'Employer Contribution',
  garnishment: 'Garnishment',
};

const EMPTY_ITEM_FORM: PayrollItemFormState = {
  name: '',
  kind: 'deduction',
  pretax: false,
  expenseAccountId: '',
  liabilityAccountId: '',
  calcBasis: '',
  defaultRate: '',
};

/** GL sides required per payroll item kind (mirrors the service validation). */
const KIND_SIDES: Record<PayrollItemKind, { expense: boolean; liability: boolean }> = {
  earning: { expense: true, liability: false },
  tax: { expense: false, liability: true },
  deduction: { expense: false, liability: true },
  employer_contribution: { expense: true, liability: true },
  garnishment: { expense: false, liability: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDecimalSafe(val: string): Decimal {
  try {
    return new Decimal(val || '0');
  } catch {
    return new Decimal(0);
  }
}

function computeGross(earnings: EarningRow[]): Decimal {
  return earnings.reduce((s, e) => s.plus(toDecimalSafe(e.amount)), new Decimal(0));
}

function computeNet(form: PayrollFormState): string {
  const gross = computeGross(form.earnings);
  const taxSum = form.taxes.reduce((s, t) => s.plus(toDecimalSafe(t.amount)), new Decimal(0));
  const dedSum = form.deductions.reduce((s, d) => s.plus(toDecimalSafe(d.amount)), new Decimal(0));
  return gross.minus(taxSum).minus(dedSum).toFixed(2);
}

function employeeName(emp: Employee) {
  return `${emp.firstName} ${emp.lastName}`;
}

function employeeToForm(emp: Employee): EmployeeFormState {
  return {
    firstName: emp.firstName,
    lastName: emp.lastName,
    email: emp.email ?? '',
    payType: emp.payType,
    payRate: emp.payRate,
    ssn: '',
    filingStatus:
      emp.w4?.filingStatus === 'married' || emp.w4?.filingStatus === 'head_of_household'
        ? emp.w4.filingStatus
        : 'single',
    w4Version:
      (typeof emp.w4?.formYear === 'number' && emp.w4.formYear < 2020) ||
      (emp.w4?.formYear == null && (emp.w4?.allowances ?? 0) > 0)
        ? '2019'
        : '2020',
    step2: emp.w4?.step2Checkbox ? 'true' : '',
    dependentsAmount: emp.w4?.dependentsAmount != null ? String(emp.w4.dependentsAmount) : '',
    otherIncome: emp.w4?.otherIncome != null ? String(emp.w4.otherIncome) : '',
    w4Deductions: emp.w4?.deductions != null ? String(emp.w4.deductions) : '',
    allowances: emp.w4?.allowances != null ? String(emp.w4.allowances) : '',
    extraWithholding: emp.w4?.extraWithholding != null ? String(emp.w4.extraWithholding) : '',
    exempt: emp.w4?.exempt ? 'true' : '',
    workState: emp.w4?.state ?? '',
    phone: emp.phone ?? '',
    hireDate: emp.hireDate ? String(emp.hireDate).slice(0, 10) : '',
    releaseDate: emp.releaseDate ? String(emp.releaseDate).slice(0, 10) : '',
    workersCompCodeId: emp.workersCompCodeId ?? '',
    addrLine1: emp.address?.line1 ?? '',
    addrLine2: emp.address?.line2 ?? '',
    addrCity: emp.address?.city ?? '',
    addrState: emp.address?.state ?? '',
    addrZip: emp.address?.zip ?? '',
    isActive: emp.isActive,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EmployeeForm({
  form,
  onChange,
  ssnLast4,
  showPayrollInfo,
  wcCodes = [],
}: {
  form: EmployeeFormState;
  onChange: (field: keyof EmployeeFormState, value: string) => void;
  ssnLast4?: string | null;
  showPayrollInfo?: boolean;
  wcCodes?: WcCode[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="firstName">First Name *</Label>
          <Input
            id="firstName"
            placeholder="Jane"
            autoFocus
            value={form.firstName}
            onChange={(e) => onChange('firstName', e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="lastName">Last Name *</Label>
          <Input
            id="lastName"
            placeholder="Doe"
            value={form.lastName}
            onChange={(e) => onChange('lastName', e.target.value)}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="empEmail">Email</Label>
        <Input
          id="empEmail"
          type="email"
          placeholder="jane@example.com"
          value={form.email}
          onChange={(e) => onChange('email', e.target.value)}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="payType">Pay Type *</Label>
          <Select
            id="payType"
            value={form.payType}
            onChange={(e) => onChange('payType', e.target.value)}
          >
            <option value="salary">Salary</option>
            <option value="hourly">Hourly</option>
            <option value="commission">Commission</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="payRate">Pay Rate *</Label>
          <Input
            id="payRate"
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={form.payRate}
            onChange={(e) => onChange('payRate', e.target.value)}
          />
        </div>
      </div>

      {showPayrollInfo && (
        <>
          <div className="border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-3">
              Payroll Info
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="empSsn">SSN</Label>
                <Input
                  id="empSsn"
                  placeholder={ssnLast4 ? `•••-••-${ssnLast4} (on file)` : '123-45-6789'}
                  value={form.ssn}
                  onChange={(e) => onChange('ssn', e.target.value)}
                  autoComplete="off"
                />
                {ssnLast4 && (
                  <p className="text-[11px] text-navy/40 mt-1">
                    Leave blank to keep the SSN on file.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="empPhone">Phone</Label>
                <Input
                  id="empPhone"
                  value={form.phone}
                  onChange={(e) => onChange('phone', e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <Label htmlFor="empHire">Hire date</Label>
                <Input id="empHire" type="date" value={form.hireDate} onChange={(e) => onChange('hireDate', e.target.value)} />
              </div>
              <div>
                <Label htmlFor="empRelease">Release date</Label>
                <Input id="empRelease" type="date" value={form.releaseDate} onChange={(e) => onChange('releaseDate', e.target.value)} />
              </div>
            </div>

            <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mt-4 mb-2">
              Federal W-4
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="empW4Version">Form version</Label>
                <Select id="empW4Version" value={form.w4Version} onChange={(e) => onChange('w4Version', e.target.value)}>
                  <option value="2020">2020 or later</option>
                  <option value="2019">2019 or earlier (allowances)</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="empFiling">Filing status</Label>
                <Select id="empFiling" value={form.filingStatus} onChange={(e) => onChange('filingStatus', e.target.value)}>
                  <option value="single">Single or married filing separately</option>
                  <option value="married">Married filing jointly</option>
                  {form.w4Version === '2020' && <option value="head_of_household">Head of household</option>}
                </Select>
              </div>
            </div>
            {form.w4Version === '2020' ? (
              <>
                <label className="flex items-start gap-2 text-sm text-navy mt-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.step2 === 'true'}
                    onChange={(e) => onChange('step2', e.target.checked ? 'true' : '')}
                  />
                  <span>Step 2: multiple jobs or spouse works (box checked)</span>
                </label>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <Label htmlFor="empDepAmt">Step 3: dependents amount ($ per year)</Label>
                    <Input id="empDepAmt" inputMode="decimal" placeholder="0.00" value={form.dependentsAmount} onChange={(e) => onChange('dependentsAmount', e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="empOther">Step 4(a): other income ($ per year)</Label>
                    <Input id="empOther" inputMode="decimal" placeholder="0.00" value={form.otherIncome} onChange={(e) => onChange('otherIncome', e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="empDed">Step 4(b): deductions ($ per year)</Label>
                    <Input id="empDed" inputMode="decimal" placeholder="0.00" value={form.w4Deductions} onChange={(e) => onChange('w4Deductions', e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="empExtraWh">Step 4(c): extra withholding per paycheck</Label>
                    <Input id="empExtraWh" inputMode="decimal" placeholder="0.00" value={form.extraWithholding} onChange={(e) => onChange('extraWithholding', e.target.value)} />
                  </div>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <Label htmlFor="empAllow">Allowances</Label>
                  <Input id="empAllow" type="number" min="0" step="1" value={form.allowances} onChange={(e) => onChange('allowances', e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="empExtraWh">Extra withholding per paycheck</Label>
                  <Input id="empExtraWh" inputMode="decimal" placeholder="0.00" value={form.extraWithholding} onChange={(e) => onChange('extraWithholding', e.target.value)} />
                </div>
              </div>
            )}
            <label className="flex items-start gap-2 text-sm text-navy mt-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.exempt === 'true'}
                onChange={(e) => onChange('exempt', e.target.checked ? 'true' : '')}
              />
              <span>Exempt from federal income tax withholding (Social Security and Medicare still apply)</span>
            </label>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <Label htmlFor="empWorkState">Work state (for state payroll taxes)</Label>
                <Input
                  id="empWorkState"
                  maxLength={2}
                  placeholder="Same as address"
                  value={form.workState}
                  onChange={(e) => onChange('workState', e.target.value.toUpperCase())}
                />
              </div>
              <div>
                <Label htmlFor="empWc">Workers&apos; comp class</Label>
                <Select id="empWc" value={form.workersCompCodeId} onChange={(e) => onChange('workersCompCodeId', e.target.value)}>
                  <option value="">None</option>
                  {wcCodes
                    .filter((c) => c.isActive || c.id === form.workersCompCodeId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code}
                        {c.description ? ` — ${c.description}` : ''}
                      </option>
                    ))}
                </Select>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-3">
              Address
            </p>
            <div className="flex flex-col gap-3">
              <Input
                placeholder="Street address"
                value={form.addrLine1}
                onChange={(e) => onChange('addrLine1', e.target.value)}
              />
              <Input
                placeholder="Apt / Suite (optional)"
                value={form.addrLine2}
                onChange={(e) => onChange('addrLine2', e.target.value)}
              />
              <div className="grid grid-cols-3 gap-3">
                <Input
                  placeholder="City"
                  value={form.addrCity}
                  onChange={(e) => onChange('addrCity', e.target.value)}
                />
                <Input
                  placeholder="State"
                  maxLength={2}
                  value={form.addrState}
                  onChange={(e) => onChange('addrState', e.target.value.toUpperCase())}
                />
                <Input
                  placeholder="ZIP"
                  value={form.addrZip}
                  onChange={(e) => onChange('addrZip', e.target.value)}
                />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function LineEditor({
  label,
  lines,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string;
  lines: PayrollLineInput[];
  onChange: (idx: number, field: 'name' | 'amount', value: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label>{label}</Label>
        <button
          type="button"
          onClick={onAdd}
          className="text-xs text-electric hover:underline"
        >
          + Add line
        </button>
      </div>
      {lines.length === 0 && (
        <p className="text-xs text-navy/40 italic">No {label.toLowerCase()} lines.</p>
      )}
      {lines.map((line, idx) => (
        <div key={idx} className="flex gap-2 mb-2">
          <Input
            placeholder="Description"
            value={line.name}
            onChange={(e) => onChange(idx, 'name', e.target.value)}
            className="flex-1"
          />
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={line.amount}
            onChange={(e) => onChange(idx, 'amount', e.target.value)}
            className="w-28"
          />
          <button
            type="button"
            onClick={() => onRemove(idx)}
            className="text-red-400 hover:text-red-600 px-1 transition-colors"
            title="Remove line"
          >
            <MinusCircle className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [paychecks, setPaychecks] = useState<Paycheck[]>([]);
  const [payrollItems, setPayrollItems] = useState<PayrollItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);

  // Payroll item modal (add + edit share the form)
  const [itemOpen, setItemOpen] = useState(false);
  const [itemEditId, setItemEditId] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState<PayrollItemFormState>(EMPTY_ITEM_FORM);
  const [itemSaving, setItemSaving] = useState(false);

  // Add employee modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<EmployeeFormState>(EMPTY_EMPLOYEE_FORM);
  const [addSaving, setAddSaving] = useState(false);

  // Edit employee modal
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EmployeeFormState>(EMPTY_EMPLOYEE_FORM);
  const [editSaving, setEditSaving] = useState(false);

  // Leave accruals (within the edit modal)
  const [accrualForm, setAccrualForm] = useState<AccrualFormState>(EMPTY_ACCRUAL_FORM);
  const [accrualRow, setAccrualRow] = useState<AccrualRow | null>(null);
  const [accrualSaving, setAccrualSaving] = useState(false);

  // Run payroll modal
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [payrollForm, setPayrollForm] = useState<PayrollFormState>(EMPTY_PAYROLL_FORM);
  const [payrollSaving, setPayrollSaving] = useState(false);

  // Voiding state (paycheck pending confirmation + id being voided)
  const [pendingVoid, setPendingVoid] = useState<(Paycheck & { employeeName: string }) | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  // Edit paycheck (void + repost on the server)
  const [editPaycheck, setEditPaycheck] = useState<{ id: string; employeeName: string } | null>(null);
  const [wcCodes, setWcCodes] = useState<WcCode[]>([]);

  // Deactivation confirm state
  const [pendingDeactivate, setPendingDeactivate] = useState<Employee | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // Portal password modal state
  const [portalTarget, setPortalTarget] = useState<Employee | null>(null);
  const [portalPassword, setPortalPassword] = useState('');
  const [portalSaving, setPortalSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchAll() {
    setLoading(true);
    try {
      const [empData, pcData, itemData, acctData] = await Promise.all([
        api.get<Employee[]>('/api/employees?includeInactive=true'),
        api.get<Paycheck[]>('/api/payroll?includeVoided=true'),
        api.get<PayrollItem[]>('/api/payroll-items?includeInactive=true'),
        api.get<Account[]>('/api/accounts'),
      ]);
      setEmployees(empData);
      setPaychecks(pcData);
      setPayrollItems(itemData);
      setAccounts(acctData);
      // Workers' comp codes are optional — the page works without them.
      api.get<WcCode[]>('/api/payroll/workers-comp').then(setWcCodes).catch(() => setWcCodes([]));
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

  // ---------------------------------------------------------------------------
  // Add employee
  // ---------------------------------------------------------------------------

  function openAddModal() {
    setAddForm(EMPTY_EMPLOYEE_FORM);
    setAddOpen(true);
  }

  function updateAddForm(field: keyof EmployeeFormState, value: string) {
    setAddForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleAdd() {
    if (!addForm.firstName.trim()) { toast('First name is required', 'danger'); return; }
    if (!addForm.lastName.trim()) { toast('Last name is required', 'danger'); return; }
    if (!addForm.payRate || Number(addForm.payRate) < 0) {
      toast('Pay rate must be 0 or more', 'danger'); return;
    }
    setAddSaving(true);
    try {
      await api.post('/api/employees', {
        firstName: addForm.firstName.trim(),
        lastName: addForm.lastName.trim(),
        email: addForm.email.trim() || undefined,
        payType: addForm.payType,
        payRate: addForm.payRate,
      });
      toast('Employee created', 'success');
      setAddOpen(false);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create employee', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Edit employee
  // ---------------------------------------------------------------------------

  function openEditModal(emp: Employee) {
    setEditId(emp.id);
    setEditForm(employeeToForm(emp));
    setAccrualRow(null);
    setAccrualForm(EMPTY_ACCRUAL_FORM);
    setEditOpen(true);
    // Load the leave-accrual policy + derived balances (best-effort).
    api
      .get<AccrualRow[]>(`/api/payroll/accruals?employeeId=${encodeURIComponent(emp.id)}`)
      .then(([row]) => {
        if (!row) return;
        setAccrualRow(row);
        if (row.hasPolicy) {
          setAccrualForm({
            sickRate: row.sick.rate ?? '',
            vacRate: row.vacation.rate ?? '',
            sickBalance: row.sick.starting,
            vacBalance: row.vacation.starting,
            asOf: row.asOf ?? '',
          });
        }
      })
      .catch(() => {
        /* accruals are optional — the rest of the modal still works */
      });
  }

  function updateAccrualForm(field: keyof AccrualFormState, value: string) {
    setAccrualForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSaveAccruals() {
    if (!editId) return;
    const hasAny = [
      accrualForm.sickRate, accrualForm.vacRate,
      accrualForm.sickBalance, accrualForm.vacBalance,
    ].some((v) => v.trim() !== '');
    setAccrualSaving(true);
    try {
      const row = await api.put<AccrualRow>('/api/payroll/accruals', {
        employeeId: editId,
        // Empty form clears the policy (PUT with policy: null).
        policy: hasAny
          ? {
              sickRateHrsPerHour: accrualForm.sickRate ? Number(accrualForm.sickRate) : null,
              vacRateHrsPerHour: accrualForm.vacRate ? Number(accrualForm.vacRate) : null,
              sickBalance: accrualForm.sickBalance ? Number(accrualForm.sickBalance) : null,
              vacBalance: accrualForm.vacBalance ? Number(accrualForm.vacBalance) : null,
              asOf: accrualForm.asOf || null,
            }
          : null,
      });
      setAccrualRow(row);
      toast(hasAny ? 'Leave accruals saved' : 'Leave accrual policy cleared', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save leave accruals', 'danger');
    } finally {
      setAccrualSaving(false);
    }
  }

  function updateEditForm(field: keyof EmployeeFormState, value: string) {
    setEditForm((prev) => ({ ...prev, [field]: value }));
  }

  function buildPatchBody(form: EmployeeFormState) {
    const hasAddress =
      form.addrLine1.trim() || form.addrLine2.trim() || form.addrCity.trim() ||
      form.addrState.trim() || form.addrZip.trim();
    return {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || null,
      payType: form.payType,
      payRate: form.payRate,
      // SSN only when a new value was typed — blank keeps what is on file.
      ...(form.ssn.trim() ? { ssn: form.ssn.trim() } : {}),
      w4:
        form.w4Version === '2019'
          ? {
              formYear: 2019,
              filingStatus: form.filingStatus === 'married' ? 'married' : 'single',
              allowances: form.allowances ? Number(form.allowances) : 0,
              extraWithholding: form.extraWithholding || '0',
              exempt: form.exempt === 'true',
              ...(form.workState.trim() ? { state: form.workState.trim().toUpperCase() } : {}),
            }
          : {
              formYear: 2020,
              filingStatus: form.filingStatus,
              step2Checkbox: form.step2 === 'true',
              dependentsAmount: form.dependentsAmount || '0',
              otherIncome: form.otherIncome || '0',
              deductions: form.w4Deductions || '0',
              extraWithholding: form.extraWithholding || '0',
              exempt: form.exempt === 'true',
              ...(form.workState.trim() ? { state: form.workState.trim().toUpperCase() } : {}),
            },
      phone: form.phone.trim() || null,
      hireDate: form.hireDate || null,
      releaseDate: form.releaseDate || null,
      workersCompCodeId: form.workersCompCodeId || null,
      address: hasAddress
        ? {
            line1: form.addrLine1.trim(),
            line2: form.addrLine2.trim() || undefined,
            city: form.addrCity.trim(),
            state: form.addrState.trim(),
            zip: form.addrZip.trim(),
          }
        : null,
    };
  }

  async function handleEditSave() {
    if (!editId) return;
    if (!editForm.firstName.trim()) { toast('First name is required', 'danger'); return; }
    if (!editForm.lastName.trim()) { toast('Last name is required', 'danger'); return; }
    if (!editForm.payRate || Number(editForm.payRate) < 0) {
      toast('Pay rate must be 0 or more', 'danger'); return;
    }
    setEditSaving(true);
    try {
      await api.patch(`/api/employees/${editId}`, buildPatchBody(editForm));
      toast('Employee updated', 'success');
      setEditOpen(false);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update employee', 'danger');
    } finally {
      setEditSaving(false);
    }
  }

  async function setActive(emp: Employee, isActive: boolean) {
    const verb = isActive ? 'reactivate' : 'deactivate';
    try {
      await api.patch(`/api/employees/${emp.id}`, { isActive });
      toast(`Employee ${verb}d`, 'success');
      await fetchAll();
      return true;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Failed to ${verb} employee`, 'danger');
      return false;
    }
  }

  function handleToggleActive(emp: Employee) {
    if (emp.isActive) {
      setPendingDeactivate(emp);
    } else {
      void setActive(emp, true);
    }
  }

  async function handleConfirmDeactivate() {
    if (!pendingDeactivate) return;
    setDeactivating(true);
    const ok = await setActive(pendingDeactivate, false);
    setDeactivating(false);
    if (ok) setPendingDeactivate(null);
  }

  // ---------------------------------------------------------------------------
  // Portal password
  // ---------------------------------------------------------------------------

  function openPortalModal(emp: Employee) {
    setPortalPassword('');
    setPortalTarget(emp);
  }

  async function handleSetPortalPassword() {
    if (!portalTarget) return;
    if (portalPassword.length < 6) {
      toast('Password must be at least 6 characters', 'danger');
      return;
    }
    setPortalSaving(true);
    try {
      await api.post(`/api/employees/${portalTarget.id}/portal-password`, {
        password: portalPassword,
      });
      toast('Portal access enabled', 'success');
      setPortalTarget(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to set password', 'danger');
    } finally {
      setPortalSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Run payroll
  // ---------------------------------------------------------------------------

  function defaultEarningsFor(emp: Employee | undefined): EarningRow[] {
    return [
      {
        kind: 'regular',
        hours: '',
        rate: emp?.payType === 'hourly' ? emp.payRate : '',
        amount: '',
      },
    ];
  }

  function openPayrollModal(empId?: string) {
    const activeEmployees = employees.filter((e) => e.isActive);
    const target =
      activeEmployees.find((e) => e.id === empId) ?? activeEmployees[0];
    setPayrollForm({
      ...EMPTY_PAYROLL_FORM,
      employeeId: target?.id ?? '',
      payDate: new Date().toISOString().slice(0, 10),
      earnings: defaultEarningsFor(target),
    });
    setPayrollOpen(true);
  }

  function updatePayrollField(
    field: keyof Omit<PayrollFormState, 'taxes' | 'deductions' | 'earnings'>,
    value: string,
  ) {
    setPayrollForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'employeeId') {
        const emp = employees.find((e) => e.id === value);
        next.earnings = defaultEarningsFor(emp);
      }
      return next;
    });
  }

  // ---- Earnings rows ----

  function updateEarningRow(idx: number, field: keyof EarningRow, value: string) {
    setPayrollForm((prev) => {
      const earnings = [...prev.earnings];
      const row = { ...earnings[idx], [field]: value };
      // Auto-calc amount = hours x rate when both present.
      if (field === 'hours' || field === 'rate') {
        const h = toDecimalSafe(row.hours);
        const r = toDecimalSafe(row.rate);
        if (row.hours && row.rate) row.amount = h.times(r).toFixed(2);
      }
      earnings[idx] = row;
      return { ...prev, earnings };
    });
  }

  function addEarningRow(kind: EarningKind = 'regular') {
    setPayrollForm((prev) => {
      const emp = employees.find((e) => e.id === prev.employeeId);
      let rate = '';
      if (emp?.payType === 'hourly') {
        rate =
          kind === 'overtime'
            ? toDecimalSafe(emp.payRate).times('1.5').toFixed(2)
            : emp.payRate;
      }
      return {
        ...prev,
        earnings: [...prev.earnings, { kind, hours: '', rate, amount: '' }],
      };
    });
  }

  function removeEarningRow(idx: number) {
    setPayrollForm((prev) => ({
      ...prev,
      earnings: prev.earnings.filter((_, i) => i !== idx),
    }));
  }

  // ---- Tax / deduction rows ----

  function updateTaxLine(idx: number, field: 'name' | 'amount', value: string) {
    setPayrollForm((prev) => {
      const taxes = [...prev.taxes];
      taxes[idx] = { ...taxes[idx], [field]: value };
      return { ...prev, taxes };
    });
  }

  function addTaxLine() {
    setPayrollForm((prev) => ({ ...prev, taxes: [...prev.taxes, { name: '', amount: '' }] }));
  }

  function removeTaxLine(idx: number) {
    setPayrollForm((prev) => ({ ...prev, taxes: prev.taxes.filter((_, i) => i !== idx) }));
  }

  function updateDeductionLine(idx: number, field: 'name' | 'amount', value: string) {
    setPayrollForm((prev) => {
      const deductions = [...prev.deductions];
      deductions[idx] = { ...deductions[idx], [field]: value };
      return { ...prev, deductions };
    });
  }

  function addDeductionLine() {
    setPayrollForm((prev) => ({
      ...prev,
      deductions: [...prev.deductions, { name: '', amount: '' }],
    }));
  }

  function removeDeductionLine(idx: number) {
    setPayrollForm((prev) => ({
      ...prev,
      deductions: prev.deductions.filter((_, i) => i !== idx),
    }));
  }

  async function handleRunPayroll() {
    if (!payrollForm.employeeId) { toast('Select an employee', 'danger'); return; }
    if (!payrollForm.payDate) { toast('Pay date is required', 'danger'); return; }
    const earningRows = payrollForm.earnings.filter((e) => Number(e.amount) > 0);
    if (earningRows.length === 0) {
      toast('Add at least one earnings line with an amount', 'danger'); return;
    }
    const net = parseFloat(computeNet(payrollForm));
    if (net < 0) {
      toast('Taxes + deductions exceed gross pay — net pay would be negative', 'danger'); return;
    }

    setPayrollSaving(true);
    try {
      await api.post('/api/payroll', {
        employeeId: payrollForm.employeeId,
        payDate: payrollForm.payDate,
        periodStart: payrollForm.periodStart || undefined,
        periodEnd: payrollForm.periodEnd || undefined,
        earnings: earningRows.map((e) => ({
          kind: e.kind,
          hours: e.hours || undefined,
          rate: e.rate || undefined,
          amount: e.amount,
        })),
        taxes: payrollForm.taxes
          .filter((t) => t.name.trim() && Number(t.amount) > 0)
          .map((t) => ({ kind: 'tax', name: t.name.trim(), amount: t.amount })),
        deductions: payrollForm.deductions
          .filter((d) => d.name.trim() && Number(d.amount) > 0)
          .map((d) => ({
            kind: 'deduction',
            name: d.name.trim(),
            amount: d.amount,
            payrollItemId: d.payrollItemId || undefined,
          })),
      });
      toast('Paycheck posted to GL', 'success');
      setPayrollOpen(false);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to run payroll', 'danger');
    } finally {
      setPayrollSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Void paycheck
  // ---------------------------------------------------------------------------

  async function handleVoidPaycheck() {
    const pc = pendingVoid;
    if (!pc) return;
    setVoidingId(pc.id);
    try {
      await api.del(`/api/payroll/${pc.id}`);
      toast('Paycheck voided', 'success');
      setPendingVoid(null);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to void paycheck', 'danger');
    } finally {
      setVoidingId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Payroll items
  // ---------------------------------------------------------------------------

  function openAddItemModal() {
    setItemEditId(null);
    setItemForm(EMPTY_ITEM_FORM);
    setItemOpen(true);
  }

  function openEditItemModal(item: PayrollItem) {
    setItemEditId(item.id);
    setItemForm({
      name: item.name,
      kind: item.kind,
      pretax: item.pretax,
      expenseAccountId: item.expenseAccountId ?? '',
      liabilityAccountId: item.liabilityAccountId ?? '',
      calcBasis: item.calcBasis ?? '',
      defaultRate: item.defaultRate ?? '',
    });
    setItemOpen(true);
  }

  async function handleSaveItem() {
    if (!itemForm.name.trim()) { toast('Item name is required', 'danger'); return; }
    const sides = KIND_SIDES[itemForm.kind];
    if (sides.expense && !itemForm.expenseAccountId) {
      toast('This item kind needs an expense account', 'danger'); return;
    }
    if (sides.liability && !itemForm.liabilityAccountId) {
      toast('This item kind needs a liability account', 'danger'); return;
    }
    setItemSaving(true);
    try {
      const body = {
        name: itemForm.name.trim(),
        pretax: itemForm.kind === 'deduction' ? itemForm.pretax : false,
        expenseAccountId: itemForm.expenseAccountId || null,
        liabilityAccountId: itemForm.liabilityAccountId || null,
        calcBasis: itemForm.calcBasis || null,
        defaultRate: itemForm.defaultRate || null,
      };
      if (itemEditId) {
        await api.patch(`/api/payroll-items/${itemEditId}`, body);
        toast('Payroll item updated', 'success');
      } else {
        await api.post('/api/payroll-items', { ...body, kind: itemForm.kind });
        toast('Payroll item created', 'success');
      }
      setItemOpen(false);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save payroll item', 'danger');
    } finally {
      setItemSaving(false);
    }
  }

  async function toggleItemActive(item: PayrollItem) {
    try {
      await api.patch(`/api/payroll-items/${item.id}`, { isActive: !item.isActive });
      toast(`Payroll item ${item.isActive ? 'deactivated' : 'reactivated'}`, 'success');
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update payroll item', 'danger');
    }
  }

  /** Deduction row: picking a payroll item sets name/GL mapping and prefills a fixed default. */
  function selectDeductionItem(idx: number, itemId: string) {
    setPayrollForm((prev) => {
      const deductions = [...prev.deductions];
      const item = payrollItems.find((i) => i.id === itemId);
      if (!item) {
        deductions[idx] = { ...deductions[idx], payrollItemId: undefined };
      } else {
        let amount = deductions[idx].amount;
        if (!amount && item.calcBasis === 'fixed' && item.defaultRate) {
          amount = toDecimalSafe(item.defaultRate).toFixed(2);
        } else if (!amount && item.calcBasis === 'percent' && item.defaultRate) {
          amount = computeGross(prev.earnings)
            .times(toDecimalSafe(item.defaultRate))
            .dividedBy(100)
            .toFixed(2);
        }
        deductions[idx] = { name: item.name, amount, payrollItemId: item.id };
      }
      return { ...prev, deductions };
    });
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  function accountLabel(id: string | null): string {
    if (!id) return '—';
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : '—';
  }

  const grossPreview = computeGross(payrollForm.earnings).toFixed(2);
  const netPreview = computeNet(payrollForm);
  const netIsNegative = parseFloat(netPreview) < 0;

  const selectedEmployee = employees.find((e) => e.id === payrollForm.employeeId);

  const visibleEmployees = showInactive ? employees : employees.filter((e) => e.isActive);
  const inactiveCount = employees.filter((e) => !e.isActive).length;

  const paycheckWithName = paychecks.map((pc) => {
    const emp = employees.find((e) => e.id === pc.employeeId);
    return { ...pc, employeeName: emp ? employeeName(emp) : 'Unknown employee' };
  });

  const editingEmployee = employees.find((e) => e.id === editId);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Employees & Payroll"
        icon={UserSquare}
        action={
          <div className="flex items-center gap-3">
            <Link href="/pay-runs">
              <Button variant="secondary" title="Batch payroll: run paychecks for several employees at once">
                <CalendarClock className="h-4 w-4" />
                Pay Runs
              </Button>
            </Link>
            <Button variant="secondary" onClick={() => openPayrollModal()} disabled={employees.filter((e) => e.isActive).length === 0}>
              <Play className="h-4 w-4" />
              Run Payroll
            </Button>
            <Button onClick={openAddModal}>
              <Plus className="h-4 w-4" />
              Add Employee
            </Button>
          </div>
        }
      />

      {/* ---- Employees table ---- */}
      <Card className="mb-6">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-navy/60 uppercase tracking-wide">Employees</h2>
          <label className="flex items-center gap-2 text-xs text-navy/60 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="accent-electric"
            />
            Show inactive{inactiveCount > 0 ? ` (${inactiveCount})` : ''}
          </label>
        </div>
        {loading ? (
          <div className="p-12 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : visibleEmployees.length === 0 ? (
          <EmptyState
            icon={UserSquare}
            title={employees.length === 0 ? 'No employees yet' : 'No active employees'}
            message={
              employees.length === 0
                ? 'Add your first employee to start running payroll.'
                : 'Toggle "Show inactive" to see deactivated employees.'
            }
            action={
              employees.length === 0 ? (
                <Button onClick={openAddModal}>
                  <Plus className="h-4 w-4" /> Add Employee
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Pay Type</Th>
                <Th numeric>Pay Rate</Th>
                <Th>SSN</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {visibleEmployees.map((emp) => (
                <Tr key={emp.id}>
                  <Td className="font-semibold text-navy">{employeeName(emp)}</Td>
                  <Td className="text-navy/70">{emp.email ?? '-'}</Td>
                  <Td className="text-navy/70">{PAY_TYPE_LABELS[emp.payType] ?? emp.payType}</Td>
                  <Td numeric className="text-navy">
                    {formatCurrency(emp.payRate)}
                    {emp.payType === 'hourly' && <span className="text-navy/40 text-xs ml-1">/hr</span>}
                  </Td>
                  <Td className="font-mono text-navy/60 text-xs">
                    {emp.ssnLast4 ? `•••-••-${emp.ssnLast4}` : '—'}
                  </Td>
                  <Td>
                    {emp.isActive ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditModal(emp)}
                      title="Edit employee"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openPayrollModal(emp.id)}
                      disabled={!emp.isActive}
                      title="Run paycheck for this employee"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Paycheck
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Set this employee's self-service portal password"
                      onClick={() => openPortalModal(emp)}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Portal
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(emp)}
                      title={emp.isActive ? 'Deactivate employee' : 'Reactivate employee'}
                    >
                      {emp.isActive ? (
                        <><Ban className="h-3.5 w-3.5" /> Deactivate</>
                      ) : (
                        <><RotateCcw className="h-3.5 w-3.5" /> Reactivate</>
                      )}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Recent paychecks table ---- */}
      <Card>
        <div className="px-5 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-navy/60 uppercase tracking-wide">Recent Paychecks</h2>
        </div>
        {loading ? (
          <div className="p-8 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : paycheckWithName.length === 0 ? (
          <div className="p-8 text-center text-navy/40 text-sm">No paychecks yet.</div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Pay Date</Th>
                <Th>Period</Th>
                <Th numeric>Gross</Th>
                <Th numeric>Taxes</Th>
                <Th numeric>Deductions</Th>
                <Th numeric>Net Pay</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {paycheckWithName.map((pc) => (
                <Tr key={pc.id} className={pc.isVoid ? 'opacity-60' : undefined}>
                  <Td className="font-semibold text-navy">{pc.employeeName}</Td>
                  <Td className="text-navy/70">{formatDate(pc.payDate)}</Td>
                  <Td className="text-navy/50 text-xs">
                    {pc.periodStart && pc.periodEnd
                      ? `${formatDate(pc.periodStart)} – ${formatDate(pc.periodEnd)}`
                      : '-'}
                  </Td>
                  <Td numeric className="text-navy">{formatCurrency(pc.grossPay)}</Td>
                  <Td numeric className="text-navy/70">{formatCurrency(pc.totalTaxes)}</Td>
                  <Td numeric className="text-navy/70">{formatCurrency(pc.totalDeductions)}</Td>
                  <Td numeric className="font-semibold text-navy">{formatCurrency(pc.netPay)}</Td>
                  <Td>
                    {pc.isVoid ? (
                      <Badge tone="void">Void</Badge>
                    ) : pc.postedEntryId ? (
                      <Badge tone="success">Posted</Badge>
                    ) : (
                      <Badge tone="neutral">Draft</Badge>
                    )}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    {!pc.isVoid && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditPaycheck({ id: pc.id, employeeName: pc.employeeName })}
                        title="Correct this paycheck"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                    )}
                    {!pc.isVoid && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingVoid(pc)}
                        disabled={voidingId === pc.id}
                        title="Void this paycheck (reverses the GL entry)"
                      >
                        <Ban className="h-3.5 w-3.5" />
                        Void
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Payroll items table ---- */}
      <Card className="mt-6">
        <div className="px-5 pt-4 pb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-navy/60 uppercase tracking-wide">
            Payroll Items
          </h2>
          <Button variant="ghost" size="sm" onClick={openAddItemModal}>
            <Plus className="h-3.5 w-3.5" />
            Add Item
          </Button>
        </div>
        {loading ? (
          <div className="p-8 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : payrollItems.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No payroll items"
            message="Payroll items map earnings, taxes, deductions and garnishments to GL accounts. Defaults are seeded automatically on first load."
            action={
              <Button onClick={openAddItemModal}>
                <Plus className="h-4 w-4" /> Add Payroll Item
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Kind</Th>
                <Th>Tax Treatment</Th>
                <Th>Expense Account</Th>
                <Th>Liability Account</Th>
                <Th numeric>Default</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {payrollItems.map((item) => (
                <Tr key={item.id} className={item.isActive ? undefined : 'opacity-60'}>
                  <Td className="font-semibold text-navy">{item.name}</Td>
                  <Td className="text-navy/70">{ITEM_KIND_LABELS[item.kind]}</Td>
                  <Td>
                    {item.kind === 'deduction' ? (
                      item.pretax ? <Badge tone="info">Pre-tax</Badge> : <Badge tone="neutral">Post-tax</Badge>
                    ) : item.kind === 'garnishment' ? (
                      <Badge tone="warning">Post-tax</Badge>
                    ) : (
                      <span className="text-navy/30">—</span>
                    )}
                  </Td>
                  <Td className="text-navy/70 text-sm">{accountLabel(item.expenseAccountId)}</Td>
                  <Td className="text-navy/70 text-sm">{accountLabel(item.liabilityAccountId)}</Td>
                  <Td numeric className="text-navy/70 font-mono text-sm">
                    {item.defaultRate
                      ? item.calcBasis === 'percent'
                        ? `${toDecimalSafe(item.defaultRate).toFixed(2)}%`
                        : formatCurrency(item.defaultRate)
                      : '—'}
                  </Td>
                  <Td>
                    {item.isActive ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditItemModal(item)}
                      title="Edit payroll item"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleItemActive(item)}
                      title={item.isActive ? 'Deactivate item' : 'Reactivate item'}
                    >
                      {item.isActive ? (
                        <><Ban className="h-3.5 w-3.5" /> Deactivate</>
                      ) : (
                        <><RotateCcw className="h-3.5 w-3.5" /> Reactivate</>
                      )}
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Payroll Item Modal (add / edit) ---- */}
      <Modal
        open={itemOpen}
        onClose={() => setItemOpen(false)}
        title={itemEditId ? 'Edit Payroll Item' : 'Add Payroll Item'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setItemOpen(false)} disabled={itemSaving}>
              Cancel
            </Button>
            <Button onClick={handleSaveItem} loading={itemSaving}>
              {itemEditId ? 'Save Changes' : 'Create Item'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="piName">Name *</Label>
              <Input
                id="piName"
                autoFocus
                placeholder="e.g. Dental Insurance"
                value={itemForm.name}
                onChange={(e) => setItemForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="piKind">Kind *</Label>
              <Select
                id="piKind"
                value={itemForm.kind}
                disabled={!!itemEditId}
                onChange={(e) =>
                  setItemForm((p) => ({ ...p, kind: e.target.value as PayrollItemKind, pretax: false }))
                }
              >
                {(Object.keys(ITEM_KIND_LABELS) as PayrollItemKind[]).map((k) => (
                  <option key={k} value={k}>{ITEM_KIND_LABELS[k]}</option>
                ))}
              </Select>
              {itemEditId && (
                <p className="text-[11px] text-navy/40 mt-1">Kind cannot change after creation.</p>
              )}
            </div>
          </div>

          {itemForm.kind === 'deduction' && (
            <label className="flex items-center gap-2 text-sm text-navy/70 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-electric"
                checked={itemForm.pretax}
                onChange={(e) => setItemForm((p) => ({ ...p, pretax: e.target.checked }))}
              />
              Pre-tax (reduces the wage base before withholding — e.g. 401(k), Section 125 health)
            </label>
          )}
          {itemForm.kind === 'garnishment' && (
            <p className="text-xs text-navy/50">
              Garnishments are always withheld AFTER taxes and credited to their own liability account.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            {KIND_SIDES[itemForm.kind].expense && (
              <div>
                <Label htmlFor="piExpense">Expense Account *</Label>
                <Select
                  id="piExpense"
                  value={itemForm.expenseAccountId}
                  onChange={(e) => setItemForm((p) => ({ ...p, expenseAccountId: e.target.value }))}
                >
                  <option value="">Select account…</option>
                  {accounts.filter((a) => a.type === 'expense').map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </Select>
              </div>
            )}
            {KIND_SIDES[itemForm.kind].liability && (
              <div>
                <Label htmlFor="piLiability">Liability Account *</Label>
                <Select
                  id="piLiability"
                  value={itemForm.liabilityAccountId}
                  onChange={(e) => setItemForm((p) => ({ ...p, liabilityAccountId: e.target.value }))}
                >
                  <option value="">Select account…</option>
                  {accounts.filter((a) => a.type === 'liability').map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="piCalc">Calculation</Label>
              <Select
                id="piCalc"
                value={itemForm.calcBasis}
                onChange={(e) =>
                  setItemForm((p) => ({ ...p, calcBasis: e.target.value as '' | 'fixed' | 'percent' }))
                }
              >
                <option value="">None (entered per check)</option>
                <option value="fixed">Fixed amount per check</option>
                <option value="percent">Percent of gross</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="piRate">
                Default {itemForm.calcBasis === 'percent' ? 'Rate (%)' : 'Amount'}
              </Label>
              <Input
                id="piRate"
                type="number"
                min="0"
                step="0.01"
                placeholder={itemForm.calcBasis === 'percent' ? 'e.g. 6.2' : '0.00'}
                value={itemForm.defaultRate}
                onChange={(e) => setItemForm((p) => ({ ...p, defaultRate: e.target.value }))}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* ---- Add Employee Modal ---- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Employee"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={addSaving}>
              Create Employee
            </Button>
          </>
        }
      >
        <EmployeeForm form={addForm} onChange={updateAddForm} />
      </Modal>

      {/* ---- Edit Employee Modal ---- */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={editingEmployee ? `Edit ${employeeName(editingEmployee)}` : 'Edit Employee'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={handleEditSave} loading={editSaving}>
              Save Changes
            </Button>
          </>
        }
      >
        <EmployeeForm
          form={editForm}
          onChange={updateEditForm}
          ssnLast4={editingEmployee?.ssnLast4}
          showPayrollInfo
          wcCodes={wcCodes}
        />

        {/* ---- Leave accruals (saved separately via PUT /api/payroll/accruals) ---- */}
        <div className="border-t border-slate-200 pt-3 mt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide">
              Leave Accruals
            </p>
            {accrualRow?.hasPolicy && (
              <span className="text-[11px] text-navy/40">
                Current: sick {accrualRow.sick.balance} hrs · vacation {accrualRow.vacation.balance} hrs
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="accSickRate">
                Sick Accrual ({editingEmployee?.payType === 'hourly' ? 'hrs / hour worked' : 'hrs / paycheck'})
              </Label>
              <Input
                id="accSickRate"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 0.04"
                value={accrualForm.sickRate}
                onChange={(e) => updateAccrualForm('sickRate', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="accVacRate">
                Vacation Accrual ({editingEmployee?.payType === 'hourly' ? 'hrs / hour worked' : 'hrs / paycheck'})
              </Label>
              <Input
                id="accVacRate"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 0.06"
                value={accrualForm.vacRate}
                onChange={(e) => updateAccrualForm('vacRate', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <div>
              <Label htmlFor="accSickBal">Sick Starting (hrs)</Label>
              <Input
                id="accSickBal"
                type="number"
                step="0.01"
                placeholder="0"
                value={accrualForm.sickBalance}
                onChange={(e) => updateAccrualForm('sickBalance', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="accVacBal">Vacation Starting (hrs)</Label>
              <Input
                id="accVacBal"
                type="number"
                step="0.01"
                placeholder="0"
                value={accrualForm.vacBalance}
                onChange={(e) => updateAccrualForm('vacBalance', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="accAsOf">Balances As Of</Label>
              <Input
                id="accAsOf"
                type="date"
                value={accrualForm.asOf}
                onChange={(e) => updateAccrualForm('asOf', e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center justify-between mt-3">
            <p className="text-[11px] text-navy/40 pr-3">
              Paychecks after the as-of date accrue on top of the starting balances.
              Leave every field blank and save to clear the policy.
            </p>
            <Button variant="secondary" size="sm" onClick={handleSaveAccruals} loading={accrualSaving}>
              Save Accruals
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---- Run Payroll Modal ---- */}
      <Modal
        open={payrollOpen}
        onClose={() => setPayrollOpen(false)}
        size="lg"
        title="Run Payroll"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPayrollOpen(false)} disabled={payrollSaving}>
              Cancel
            </Button>
            <Button onClick={handleRunPayroll} disabled={netIsNegative} loading={payrollSaving}>
              Post Paycheck
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Employee selector */}
          <div>
            <Label htmlFor="prEmployee">Employee *</Label>
            <Select
              id="prEmployee"
              autoFocus
              value={payrollForm.employeeId}
              onChange={(e) => updatePayrollField('employeeId', e.target.value)}
            >
              {employees.filter((e) => e.isActive).map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {employeeName(emp)} ({PAY_TYPE_LABELS[emp.payType]} — {formatCurrency(emp.payRate)})
                </option>
              ))}
            </Select>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="prPayDate">Pay Date *</Label>
              <Input
                id="prPayDate"
                type="date"
                value={payrollForm.payDate}
                onChange={(e) => updatePayrollField('payDate', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="prPeriodStart">Period Start</Label>
              <Input
                id="prPeriodStart"
                type="date"
                value={payrollForm.periodStart}
                onChange={(e) => updatePayrollField('periodStart', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="prPeriodEnd">Period End</Label>
              <Input
                id="prPeriodEnd"
                type="date"
                value={payrollForm.periodEnd}
                onChange={(e) => updatePayrollField('periodEnd', e.target.value)}
              />
            </div>
          </div>

          {/* Earnings rows */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>Earnings *</Label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => addEarningRow('overtime')}
                  className="text-xs text-electric hover:underline"
                  title={selectedEmployee?.payType === 'hourly'
                    ? `Overtime at 1.5x rate (${formatCurrency(toDecimalSafe(selectedEmployee.payRate).times('1.5').toFixed(2))}/hr)`
                    : 'Add an overtime line'}
                >
                  + Overtime (1.5x)
                </button>
                <button
                  type="button"
                  onClick={() => addEarningRow('regular')}
                  className="text-xs text-electric hover:underline"
                >
                  + Add line
                </button>
              </div>
            </div>
            <div className="grid grid-cols-[1fr_5rem_6rem_7rem_1rem] gap-2 mb-1 text-[11px] text-navy/40 font-medium px-1">
              <span>Type</span>
              <span>Hours</span>
              <span>Rate</span>
              <span className="text-right">Amount</span>
              <span />
            </div>
            {payrollForm.earnings.map((row, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_5rem_6rem_7rem_1rem] gap-2 mb-2 items-center">
                <Select
                  value={row.kind}
                  onChange={(e) => updateEarningRow(idx, 'kind', e.target.value)}
                >
                  {(Object.keys(EARNING_LABELS) as EarningKind[]).map((k) => (
                    <option key={k} value={k}>{EARNING_LABELS[k]}</option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min="0"
                  step="0.25"
                  placeholder="hrs"
                  value={row.hours}
                  onChange={(e) => updateEarningRow(idx, 'hours', e.target.value)}
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="rate"
                  value={row.rate}
                  onChange={(e) => updateEarningRow(idx, 'rate', e.target.value)}
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={row.amount}
                  onChange={(e) => updateEarningRow(idx, 'amount', e.target.value)}
                  className="text-right"
                />
                <button
                  type="button"
                  onClick={() => removeEarningRow(idx)}
                  className="text-red-400 hover:text-red-600 transition-colors"
                  title="Remove line"
                >
                  <MinusCircle className="h-4 w-4" />
                </button>
              </div>
            ))}
            <p className="text-xs text-navy/50 text-right font-medium">
              Gross: <span className="font-mono">{formatCurrency(grossPreview)}</span>
            </p>
          </div>

          {/* Tax lines */}
          <LineEditor
            label="Tax Withholdings"
            lines={payrollForm.taxes}
            onChange={updateTaxLine}
            onAdd={addTaxLine}
            onRemove={removeTaxLine}
          />

          {/* Deduction lines — may reference a payroll item (GL mapping / pre-tax) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>Deductions</Label>
              <button
                type="button"
                onClick={addDeductionLine}
                className="text-xs text-electric hover:underline"
              >
                + Add line
              </button>
            </div>
            {payrollForm.deductions.length === 0 && (
              <p className="text-xs text-navy/40 italic">No deduction lines.</p>
            )}
            {payrollForm.deductions.map((line, idx) => {
              const item = payrollItems.find((i) => i.id === line.payrollItemId);
              return (
                <div key={idx} className="flex gap-2 mb-2 items-center">
                  <Select
                    value={line.payrollItemId ?? ''}
                    onChange={(e) => selectDeductionItem(idx, e.target.value)}
                    className="w-44"
                    title="Payroll item — maps the deduction to its GL liability account"
                  >
                    <option value="">Custom…</option>
                    {payrollItems
                      .filter((i) => i.isActive && (i.kind === 'deduction' || i.kind === 'garnishment'))
                      .map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}{i.kind === 'garnishment' ? ' (garnishment)' : i.pretax ? ' (pre-tax)' : ''}
                        </option>
                      ))}
                  </Select>
                  <Input
                    placeholder="Description"
                    value={line.name}
                    onChange={(e) => updateDeductionLine(idx, 'name', e.target.value)}
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(e) => updateDeductionLine(idx, 'amount', e.target.value)}
                    className="w-28"
                  />
                  {item?.pretax && <Badge tone="info">pre-tax</Badge>}
                  {item?.kind === 'garnishment' && <Badge tone="warning">post-tax</Badge>}
                  <button
                    type="button"
                    onClick={() => removeDeductionLine(idx)}
                    className="text-red-400 hover:text-red-600 px-1 transition-colors"
                    title="Remove line"
                  >
                    <MinusCircle className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
            <p className="text-[11px] text-navy/40">
              Pre-tax items reduce the wage base before withholding; garnishments are
              withheld after tax to the item&apos;s liability account.
            </p>
          </div>

          {/* Net pay preview */}
          <div className={`rounded-lg p-4 border ${netIsNegative ? 'bg-red-50 border-red-200' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-navy/70">Computed Net Pay</span>
              <span className={`text-lg font-bold font-mono ${netIsNegative ? 'text-red-600' : 'text-navy'}`}>
                {formatCurrency(netIsNegative ? '0' : netPreview)}
              </span>
            </div>
            {selectedEmployee && (
              <p className="text-xs text-navy/40 mt-1">
                GL: Dr 6500 Payroll Expense {formatCurrency(grossPreview)} |
                Cr 2300 Payroll Liabilities + Cr 1000 Checking
                (deduction lines with a payroll item post to that item&apos;s account)
              </p>
            )}
            {netIsNegative && (
              <p className="text-xs text-red-500 mt-1 font-medium">
                Taxes + deductions exceed gross pay. Adjust the amounts before posting.
              </p>
            )}
          </div>
        </div>
      </Modal>

      {/* ---- Portal Password Modal ---- */}
      <Modal
        open={!!portalTarget}
        onClose={() => setPortalTarget(null)}
        title={
          portalTarget
            ? `Portal Access — ${employeeName(portalTarget)}`
            : 'Portal Access'
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPortalTarget(null)}
              disabled={portalSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSetPortalPassword}
              disabled={portalPassword.length < 6}
              loading={portalSaving}
            >
              Set Password
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/60 mb-4">
          Set a password for this employee&apos;s self-service portal. They sign in with their
          email to view pay stubs.
        </p>
        <div>
          <Label htmlFor="portalPassword">Portal Password</Label>
          <Input
            id="portalPassword"
            type="password"
            autoFocus
            minLength={6}
            placeholder="Minimum 6 characters"
            value={portalPassword}
            onChange={(e) => setPortalPassword(e.target.value)}
            autoComplete="new-password"
          />
          {portalPassword.length > 0 && portalPassword.length < 6 && (
            <p className="text-xs text-red-500 mt-1">Password must be at least 6 characters.</p>
          )}
        </div>
      </Modal>

      {/* ---- Deactivate confirmation ---- */}
      <ConfirmDialog
        open={!!pendingDeactivate}
        title="Deactivate employee?"
        message={
          pendingDeactivate
            ? `Deactivate ${employeeName(pendingDeactivate)}? Inactive employees cannot be paid.`
            : undefined
        }
        confirmLabel="Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleConfirmDeactivate}
        onClose={() => setPendingDeactivate(null)}
      />

      {/* ---- Void paycheck confirmation ---- */}
      <ConfirmDialog
        open={!!pendingVoid}
        title="Void paycheck?"
        message={
          pendingVoid
            ? `Void the ${formatDate(pendingVoid.payDate)} paycheck for ${pendingVoid.employeeName} (net ${formatCurrency(pendingVoid.netPay)})? This reverses the GL posting.`
            : undefined
        }
        confirmLabel="Void"
        tone="danger"
        loading={voidingId !== null}
        onConfirm={handleVoidPaycheck}
        onClose={() => setPendingVoid(null)}
      />

      {/* ---- Edit paycheck ---- */}
      <EditPaycheckModal
        paycheckId={editPaycheck?.id ?? null}
        employeeName={editPaycheck?.employeeName ?? ''}
        onClose={() => setEditPaycheck(null)}
        onSaved={() => void fetchAll()}
      />
    </main>
  );
}
