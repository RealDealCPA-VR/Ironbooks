'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet, Download, Ban, Clock } from 'lucide-react';
import {
  Button,
  Card,
  Table,
  Th,
  Td,
  Tr,
  Badge,
  ConfirmDialog,
  EmptyState,
  Spinner,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { Money, formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Calendar year-to-date gross through this check's pay date (null for voided checks). */
  ytdGross: string | null;
  ytdNet: string | null;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
}

interface AccrualBucket {
  rate: string | null;
  starting: string;
  accrued: string;
  balance: string;
}

interface SickVacationRow {
  employeeId: string;
  employeeName: string;
  payType: string;
  isActive: boolean;
  hasPolicy: boolean;
  asOf: string | null;
  paychecksCounted: number;
  sick: AccrualBucket;
  vacation: AccrualBucket;
}

// ---------------------------------------------------------------------------
// Pay Stubs Page
// ---------------------------------------------------------------------------

export default function PayStubsPage() {
  const router = useRouter();
  const [paychecks, setPaychecks] = useState<Paycheck[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [accruals, setAccruals] = useState<SickVacationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingVoid, setPendingVoid] = useState<Paycheck | null>(null);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  const employeeMap = Object.fromEntries(
    employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]),
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [paycheckList, employeeList, accrualList] = await Promise.all([
        api.get<Paycheck[]>('/api/payroll?includeVoided=true'),
        api.get<Employee[]>('/api/employees?includeInactive=true'),
        api.get<SickVacationRow[]>('/api/payroll/accruals'),
      ]);
      setPaychecks(paycheckList);
      setEmployees(employeeList);
      setAccruals(accrualList);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load pay stubs.';
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function openPaystubPdf(paycheckId: string) {
    window.open(`/api/payroll/paystub?paycheckId=${encodeURIComponent(paycheckId)}`, '_blank');
  }

  async function handleVoid() {
    const pc = pendingVoid;
    if (!pc) return;
    setVoidingId(pc.id);
    try {
      await api.del(`/api/payroll/${pc.id}`);
      toast('Paycheck voided', 'success');
      setPendingVoid(null);
      await fetchData();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to void paycheck', 'danger');
    } finally {
      setVoidingId(null);
    }
  }

  const livePaychecks = paychecks.filter((p) => !p.isVoid);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Pay Stubs" icon={FileSpreadsheet} />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        ) : paychecks.length === 0 ? (
          <EmptyState
            icon={FileSpreadsheet}
            title="No paychecks yet"
            message="Run a payroll to generate pay stubs for your employees."
            action={<Button onClick={() => router.push('/employees')}>Run Payroll</Button>}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Pay Date</Th>
                <Th>Period</Th>
                <Th numeric>Gross Pay</Th>
                <Th numeric>Taxes</Th>
                <Th numeric>Net Pay</Th>
                <Th numeric>YTD Gross</Th>
                <Th numeric>YTD Net</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {paychecks.map((pc) => (
                <Tr key={pc.id} className={pc.isVoid ? 'opacity-60' : undefined}>
                  <Td className="font-semibold text-navy">
                    {employeeMap[pc.employeeId] ?? (
                      <span className="text-navy/40 italic font-normal">Unknown employee</span>
                    )}
                  </Td>
                  <Td className="text-navy/70">{formatDate(pc.payDate)}</Td>
                  <Td className="text-navy/60 text-sm">
                    {pc.periodStart && pc.periodEnd
                      ? `${formatDate(pc.periodStart)} – ${formatDate(pc.periodEnd)}`
                      : '—'}
                  </Td>
                  <Td numeric className="font-medium">
                    {formatCurrency(pc.grossPay)}
                  </Td>
                  <Td numeric className="text-navy/70">
                    {formatCurrency(pc.totalTaxes)}
                  </Td>
                  <Td numeric className="font-semibold text-emerald">
                    {formatCurrency(pc.netPay)}
                  </Td>
                  <Td numeric className="text-navy/60">
                    {pc.ytdGross != null ? formatCurrency(pc.ytdGross) : '—'}
                  </Td>
                  <Td numeric className="text-navy/60">
                    {pc.ytdNet != null ? formatCurrency(pc.ytdNet) : '—'}
                  </Td>
                  <Td>
                    {pc.isVoid ? (
                      <Badge tone="void">Void</Badge>
                    ) : pc.postedEntryId ? (
                      <Badge tone="success">Posted</Badge>
                    ) : (
                      <Badge tone="neutral">Pending</Badge>
                    )}
                  </Td>
                  <Td className="text-right whitespace-nowrap">
                    <button
                      onClick={() => openPaystubPdf(pc.id)}
                      className="inline-flex items-center gap-1 text-xs text-navy/40 hover:text-electric transition-colors font-medium mr-3"
                      title="View Pay Stub PDF (includes YTD column)"
                    >
                      <Download className="h-3.5 w-3.5" /> PDF
                    </button>
                    {!pc.isVoid && (
                      <button
                        onClick={() => setPendingVoid(pc)}
                        disabled={voidingId === pc.id}
                        className="inline-flex items-center gap-1 text-xs text-navy/40 hover:text-red-600 transition-colors font-medium disabled:opacity-50"
                        title="Void this paycheck (reverses the GL entry)"
                      >
                        <Ban className="h-3.5 w-3.5" />
                        Void
                      </button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Sick & vacation balances (employees.accruals policy + per-paycheck accrual) */}
      {!loading && accruals.some((a) => a.hasPolicy) && (
        <Card className="p-0 overflow-hidden mt-6">
          <div className="px-6 pt-5 pb-3 flex items-center gap-2">
            <Clock className="h-4 w-4 text-electric" />
            <h2 className="text-sm font-bold text-navy">Sick &amp; Vacation Balances (hours)</h2>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Pay Type</Th>
                <Th numeric>Sick Accrued</Th>
                <Th numeric>Sick Balance</Th>
                <Th numeric>Vacation Accrued</Th>
                <Th numeric>Vacation Balance</Th>
                <Th>As Of</Th>
              </tr>
            </thead>
            <tbody>
              {accruals
                .filter((a) => a.hasPolicy)
                .map((a) => (
                  <Tr key={a.employeeId}>
                    <Td className="font-semibold text-navy">
                      {a.employeeName}
                      {!a.isActive && (
                        <span className="ml-2 text-xs text-navy/40">(inactive)</span>
                      )}
                    </Td>
                    <Td className="text-navy/60 capitalize">{a.payType}</Td>
                    <Td numeric className="text-navy/70">{a.sick.accrued}</Td>
                    <Td numeric className="font-semibold text-navy">
                      {a.sick.balance}
                    </Td>
                    <Td numeric className="text-navy/70">{a.vacation.accrued}</Td>
                    <Td numeric className="font-semibold text-navy">
                      {a.vacation.balance}
                    </Td>
                    <Td className="text-navy/60">{formatDate(a.asOf)}</Td>
                  </Tr>
                ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* Summary footer (voided checks excluded) */}
      {livePaychecks.length > 0 && !loading && (
        <div className="mt-4 flex gap-6 text-sm text-navy/50">
          <span>
            {livePaychecks.length} paycheck{livePaychecks.length !== 1 ? 's' : ''}
          </span>
          <span>
            Total gross:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(Money.add(...livePaychecks.map((p) => p.grossPay)))}
            </span>
          </span>
          <span>
            Total net:{' '}
            <span className="font-semibold text-navy/70">
              {formatCurrency(Money.add(...livePaychecks.map((p) => p.netPay)))}
            </span>
          </span>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void paycheck?"
        message={
          pendingVoid
            ? `Void the ${formatDate(pendingVoid.payDate)} paycheck for ${
                employeeMap[pendingVoid.employeeId] ?? 'this employee'
              } (net ${formatCurrency(pendingVoid.netPay)})? This reverses the GL posting.`
            : undefined
        }
        confirmLabel="Void"
        tone="danger"
        loading={voidingId !== null}
        onConfirm={handleVoid}
        onClose={() => setPendingVoid(null)}
      />
    </main>
  );
}
