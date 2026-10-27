'use client';

/**
 * Payroll Forms page — W-2, Form 941, Form 940 (FUTA), and W-3 PDF downloads.
 *
 * - W-2 section: select employee + year → "Download W-2" opens the PDF in a new tab.
 * - Form 941 section: pick quarter + year → "Download 941" opens the PDF in a new tab.
 * - Form 940 section: pick year → annual FUTA worksheet with quarterly liability.
 * - W-3 section: pick year → transmittal totals across all W-2s.
 *
 * Employer EIN (W-2 Box b / W-3 / 940) is read from company settings (settings.ein)
 * and rendered blank when not configured.
 */
import { useEffect, useState } from 'react';
import { FileText, ClipboardList } from 'lucide-react';
import {
  Button,
  Card,
  Select,
  Label,
  Input,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { lastCompletedQuarter, lastCompletedYear } from '@/lib/formPeriods';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a list of recent years for the year picker (this year first). */
function recentYears(count = 5): number[] {
  const currentYear = new Date().getFullYear();
  return Array.from({ length: count }, (_, i) => currentYear - i);
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function PayrollFormsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(true);

  // W-2 form state
  const [w2EmployeeId, setW2EmployeeId] = useState('');
  const [w2Year, setW2Year]             = useState(String(lastCompletedYear()));

  // 941 form state
  // 941 form state (quarterly — defaults to the last finished quarter, the one due next)
  const [q941Quarter, setQ941Quarter] = useState(String(lastCompletedQuarter().quarter));
  const [q941Year, setQ941Year]       = useState(String(lastCompletedQuarter().year));
  const [q941Schedule, setQ941Schedule] = useState<'monthly' | 'semiweekly'>('monthly');
  const [q941Deposits, setQ941Deposits] = useState('');
  const [f940Deposits, setF940Deposits] = useState('');

  // 940 form state (annual — defaults to the last completed year)
  const [f940Year, setF940Year] = useState(String(lastCompletedYear()));

  // W-3 form state (annual — defaults to the last completed year)
  const [w3Year, setW3Year] = useState(String(lastCompletedYear()));

  // ---------------------------------------------------------------------------
  // Load employees on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    async function load() {
      setLoadingEmployees(true);
      try {
        // Include inactive employees: W-2s must still be issued to staff terminated
        // during the tax year.
        const data = await api.get<Employee[]>('/api/employees?includeInactive=true');
        setEmployees(data);
        if (data.length > 0) setW2EmployeeId(data[0].id);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load employees', 'danger');
      } finally {
        setLoadingEmployees(false);
      }
    }
    load();
  }, []);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleDownloadW2() {
    if (!w2EmployeeId) { toast('Please select an employee', 'danger'); return; }
    if (!w2Year)        { toast('Please select a year', 'danger');     return; }
    const url = `/api/payroll/w2?employeeId=${encodeURIComponent(w2EmployeeId)}&year=${encodeURIComponent(w2Year)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleDownload941() {
    if (!q941Quarter) { toast('Please select a quarter', 'danger'); return; }
    if (!q941Year)    { toast('Please select a year', 'danger');   return; }
    if (q941Deposits.trim() && !/^\d+(\.\d{1,2})?$/.test(q941Deposits.trim())) {
      toast('Enter deposits as an amount, like 1234.56', 'danger'); return;
    }
    const url =
      `/api/payroll/941?quarter=${encodeURIComponent(q941Quarter)}&year=${encodeURIComponent(q941Year)}` +
      `&schedule=${q941Schedule}` +
      (q941Deposits.trim() ? `&deposits=${encodeURIComponent(q941Deposits.trim())}` : '');
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleDownload940() {
    if (!f940Year) { toast('Please select a year', 'danger'); return; }
    if (f940Deposits.trim() && !/^\d+(\.\d{1,2})?$/.test(f940Deposits.trim())) {
      toast('Enter deposits as an amount, like 1234.56', 'danger'); return;
    }
    const url =
      `/api/payroll/940?year=${encodeURIComponent(f940Year)}` +
      (f940Deposits.trim() ? `&deposits=${encodeURIComponent(f940Deposits.trim())}` : '');
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleDownloadW3() {
    if (!w3Year) { toast('Please select a year', 'danger'); return; }
    const url = `/api/payroll/w3?year=${encodeURIComponent(w3Year)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Payroll Tax Forms" icon={ClipboardList} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6 max-w-3xl">

        {/* ---- W-2 Section ---- */}
        <Card className="p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-navy">W-2 — Wage and Tax Statement</h2>
            <p className="text-xs text-navy/50 mt-1">
              Download a W-2 statement for one employee for a full calendar year.
            </p>
          </div>

          <div>
            <Label htmlFor="w2Employee">Employee</Label>
            {loadingEmployees ? (
              <p className="text-xs text-navy/40 mt-1">Loading employees…</p>
            ) : employees.length === 0 ? (
              <p className="text-xs text-navy/40 mt-1">No employees found.</p>
            ) : (
              <Select
                id="w2Employee"
                value={w2EmployeeId}
                onChange={(e) => setW2EmployeeId(e.target.value)}
              >
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.firstName} {emp.lastName}{emp.isActive ? '' : ' (inactive)'}
                  </option>
                ))}
              </Select>
            )}
          </div>

          <div>
            <Label htmlFor="w2Year">Tax Year</Label>
            <Select
              id="w2Year"
              value={w2Year}
              onChange={(e) => setW2Year(e.target.value)}
            >
              {recentYears().map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </Select>
          </div>

          <Button
            onClick={handleDownloadW2}
            disabled={loadingEmployees || employees.length === 0}
            className="mt-auto"
          >
            <FileText className="h-4 w-4" />
            Download W-2
          </Button>
        </Card>

        {/* ---- Form 941 Section ---- */}
        <Card className="p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Form 941 — Quarterly Tax Return</h2>
            <p className="text-xs text-navy/50 mt-1">
              Form 941 for a calendar quarter, covering all employees: every line, the monthly
              liability (line 16) and Schedule B for semiweekly depositors. Deposits come from
              your Pay Liabilities payments of federal withholding, Social Security and Medicare.
            </p>
          </div>

          <div>
            <Label htmlFor="q941Quarter">Quarter</Label>
            <Select
              id="q941Quarter"
              value={q941Quarter}
              onChange={(e) => setQ941Quarter(e.target.value)}
            >
              <option value="1">Q1 — January, February, March</option>
              <option value="2">Q2 — April, May, June</option>
              <option value="3">Q3 — July, August, September</option>
              <option value="4">Q4 — October, November, December</option>
            </Select>
          </div>

          <div>
            <Label htmlFor="q941Year">Year</Label>
            <Select
              id="q941Year"
              value={q941Year}
              onChange={(e) => setQ941Year(e.target.value)}
            >
              {recentYears().map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="q941Schedule">Deposit schedule</Label>
            <Select
              id="q941Schedule"
              value={q941Schedule}
              onChange={(e) => setQ941Schedule(e.target.value as 'monthly' | 'semiweekly')}
            >
              <option value="monthly">Monthly depositor</option>
              <option value="semiweekly">Semiweekly depositor (adds Schedule B)</option>
            </Select>
          </div>

          <div>
            <Label htmlFor="q941Deposits">Deposits made outside the app (optional)</Label>
            <Input
              id="q941Deposits"
              inputMode="decimal"
              placeholder="Leave blank to use your recorded payments"
              value={q941Deposits}
              onChange={(e) => setQ941Deposits(e.target.value)}
            />
          </div>

          <Button onClick={handleDownload941} className="mt-auto">
            <FileText className="h-4 w-4" />
            Download 941
          </Button>
        </Card>

        {/* ---- Form 940 Section ---- */}
        <Card className="p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-navy">Form 940 — Annual FUTA Return</h2>
            <p className="text-xs text-navy/50 mt-1">
              Annual FUTA return: total and exempt payments, wages over the $7,000 base, FUTA
              tax, credit reduction states (Schedule A), deposits, balance due and the quarterly
              liability.
            </p>
          </div>

          <div>
            <Label htmlFor="f940Year">Year</Label>
            <Select
              id="f940Year"
              value={f940Year}
              onChange={(e) => setF940Year(e.target.value)}
            >
              {recentYears().map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="f940Deposits">FUTA deposits made outside the app (optional)</Label>
            <Input
              id="f940Deposits"
              inputMode="decimal"
              placeholder="Leave blank to use your recorded payments"
              value={f940Deposits}
              onChange={(e) => setF940Deposits(e.target.value)}
            />
          </div>

          <Button onClick={handleDownload940} className="mt-auto">
            <FileText className="h-4 w-4" />
            Download 940
          </Button>
        </Card>

        {/* ---- W-3 Section ---- */}
        <Card className="p-6 flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold text-navy">W-3 — Transmittal of W-2s</h2>
            <p className="text-xs text-navy/50 mt-1">
              Totals across all employee W-2s for a calendar year, with the employer EIN
              from company settings.
            </p>
          </div>

          <div>
            <Label htmlFor="w3Year">Tax Year</Label>
            <Select
              id="w3Year"
              value={w3Year}
              onChange={(e) => setW3Year(e.target.value)}
            >
              {recentYears().map((y) => (
                <option key={y} value={String(y)}>{y}</option>
              ))}
            </Select>
          </div>

          <Button onClick={handleDownloadW3} className="mt-auto">
            <FileText className="h-4 w-4" />
            Download W-3
          </Button>
        </Card>

      </div>
    </main>
  );
}
