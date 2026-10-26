'use client';

import { useEffect, useState } from 'react';
import { Car, Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { irsMileageRateFor } from '@/lib/services/mileageRates';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MileageLog {
  id: string;
  customerId: string | null;
  jobId: string | null;
  date: string;
  miles: string;
  ratePerMile: string;
  amount: string;
  purpose: string | null;
  billable: boolean;
  customerName: string | null;
  jobName: string | null;
}

interface MileageSummary {
  totalMiles: string;
  totalAmount: string;
  groups: Array<{
    customerId: string | null;
    customerName: string | null;
    jobId: string | null;
    jobName: string | null;
    totalMiles: string;
    totalAmount: string;
  }>;
}

interface Customer {
  id: string;
  displayName: string;
}

interface LogMilesForm {
  date: string;
  miles: string;
  ratePerMile: string;
  customerId: string;
  purpose: string;
  billable: boolean;
  vehicleId: string;
  odometerStart: string;
  odometerEnd: string;
}

/** Vehicle list entry (wave-2 lists). */
interface Vehicle {
  id: string;
  name: string;
}

const EMPTY_FORM: LogMilesForm = {
  // date is set fresh each time the modal opens (see openLogModal) so a long-running
  // session never defaults to a stale day.
  date: '',
  miles: '',
  // Blank = the IRS business rate for the trip's year (the server fills it in; shown as the placeholder).
  ratePerMile: '',
  customerId: '',
  purpose: '',
  billable: false,
  vehicleId: '',
  odometerStart: '',
  odometerEnd: '',
};

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

function SummaryCard({ summary }: { summary: MileageSummary | null }) {
  if (!summary) {
    return (
      <Card className="p-5 mb-6 flex items-center gap-6">
        <div className="animate-pulse h-10 w-64 bg-slate-100 rounded" />
      </Card>
    );
  }

  return (
    <Card className="p-5 mb-6">
      <div className="flex flex-wrap items-center gap-8">
        <div>
          <p className="text-xs font-semibold text-navy/50 uppercase tracking-wider mb-1">
            Total Miles
          </p>
          <p className="text-3xl font-bold text-navy">
            {parseFloat(summary.totalMiles).toLocaleString('en-US', {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold text-navy/50 uppercase tracking-wider mb-1">
            Total Deduction
          </p>
          <p className="text-3xl font-bold text-emerald">
            {formatCurrency(summary.totalAmount)}
          </p>
        </div>
        <div className="ml-auto text-sm text-navy/50">
          {summary.groups.length} group{summary.groups.length !== 1 ? 's' : ''}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Log Miles form
// ---------------------------------------------------------------------------

function LogMilesForm({
  form,
  customers,
  vehicles,
  onChange,
}: {
  form: LogMilesForm;
  customers: Customer[];
  vehicles: Vehicle[];
  onChange: (field: keyof LogMilesForm, value: string | boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="ml-date">Date *</Label>
          <Input
            id="ml-date"
            type="date"
            autoFocus
            value={form.date}
            onChange={(e) => onChange('date', e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="ml-miles">Miles *</Label>
          <Input
            id="ml-miles"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="e.g. 45.2"
            value={form.miles}
            onChange={(e) => onChange('miles', e.target.value)}
            required
          />
        </div>
      </div>
      <div>
        <Label htmlFor="ml-rate">Rate per Mile ($/mi)</Label>
        <Input
          id="ml-rate"
          type="number"
          min="0"
          step="0.0001"
          placeholder={irsMileageRateFor(form.date || undefined)}
          value={form.ratePerMile}
          onChange={(e) => onChange('ratePerMile', e.target.value)}
        />
        <p className="text-xs text-navy/40 mt-1">
          Leave blank for the IRS business rate for the trip&apos;s year (${irsMileageRateFor(form.date || undefined)}/mi).
        </p>
      </div>
      <div>
        <Label htmlFor="ml-customer">Customer (optional)</Label>
        <Select
          id="ml-customer"
          value={form.customerId}
          onChange={(e) => onChange('customerId', e.target.value)}
        >
          <option value="">-- None --</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="ml-vehicle">Vehicle</Label>
          <Select id="ml-vehicle" value={form.vehicleId} onChange={(e) => onChange('vehicleId', e.target.value)}>
            <option value="">-- None --</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="ml-odo-start">Odometer start</Label>
          <Input
            id="ml-odo-start"
            type="number"
            min="0"
            step="0.1"
            value={form.odometerStart}
            onChange={(e) => {
              onChange('odometerStart', e.target.value);
              const end = parseFloat(form.odometerEnd);
              const start = parseFloat(e.target.value);
              if (!Number.isNaN(end) && !Number.isNaN(start) && end >= start) onChange('miles', (end - start).toFixed(1));
            }}
          />
        </div>
        <div>
          <Label htmlFor="ml-odo-end">Odometer end</Label>
          <Input
            id="ml-odo-end"
            type="number"
            min="0"
            step="0.1"
            value={form.odometerEnd}
            onChange={(e) => {
              onChange('odometerEnd', e.target.value);
              const start = parseFloat(form.odometerStart);
              const end = parseFloat(e.target.value);
              if (!Number.isNaN(end) && !Number.isNaN(start) && end >= start) onChange('miles', (end - start).toFixed(1));
            }}
          />
        </div>
      </div>
      <div>
        <Label htmlFor="ml-purpose">Purpose</Label>
        <Input
          id="ml-purpose"
          placeholder="e.g. Client site visit"
          value={form.purpose}
          onChange={(e) => onChange('purpose', e.target.value)}
        />
      </div>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={form.billable}
          onChange={(e) => onChange('billable', e.target.checked)}
          className="rounded border-slate-300 text-electric focus:ring-electric/40"
        />
        <span className="text-sm text-navy/70">Billable to customer</span>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MileagePage() {
  const [logs, setLogs] = useState<MileageLog[]>([]);
  const [summary, setSummary] = useState<MileageSummary | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ entries: Vehicle[] }>('/api/lists/vehicles')
      .then((d) => setVehicles(d.entries))
      .catch(() => {
        /* the Vehicle list is optional */
      });
  }, []);

  // Log modal
  const [logOpen, setLogOpen] = useState(false);
  const [logForm, setLogForm] = useState<LogMilesForm>(EMPTY_FORM);
  const [logSaving, setLogSaving] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<MileageLog | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchAll() {
    setLoading(true);
    try {
      const [logsData, summaryData, custData] = await Promise.all([
        api.get<MileageLog[]>('/api/mileage'),
        api.get<MileageSummary>('/api/mileage?summary=true'),
        api.get<Customer[]>('/api/customers'),
      ]);
      setLogs(logsData);
      setSummary(summaryData);
      setCustomers(custData);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load mileage data', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Log Miles
  // ---------------------------------------------------------------------------

  function openLogModal() {
    setLogForm({ ...EMPTY_FORM, date: todayISO() });
    setLogOpen(true);
  }

  function updateForm(field: keyof LogMilesForm, value: string | boolean) {
    setLogForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleLog() {
    if (!logForm.miles || parseFloat(logForm.miles) <= 0) {
      toast('Miles must be greater than zero', 'danger');
      return;
    }
    if (!logForm.date) {
      toast('Date is required', 'danger');
      return;
    }
    setLogSaving(true);
    try {
      await api.post('/api/mileage', {
        date: logForm.date,
        miles: parseFloat(logForm.miles),
        ratePerMile: logForm.ratePerMile ? parseFloat(logForm.ratePerMile) : undefined,
        customerId: logForm.customerId || undefined,
        purpose: logForm.purpose.trim() || undefined,
        billable: logForm.billable,
        vehicleId: logForm.vehicleId || undefined,
        odometerStart: logForm.odometerStart || undefined,
        odometerEnd: logForm.odometerEnd || undefined,
      });
      toast('Mileage logged', 'success');
      setLogOpen(false);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to log mileage', 'danger');
    } finally {
      setLogSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/api/mileage/${deleteTarget.id}`);
      toast('Mileage log deleted', 'success');
      setDeleteTarget(null);
      await fetchAll();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete log', 'danger');
    } finally {
      setDeleting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function fmtDate(iso: string) {
    return formatDate(iso, 'MMM d, yyyy');
  }

  function fmtMiles(m: string) {
    return parseFloat(m).toLocaleString('en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Mileage"
        icon={Car}
        action={
          <Button onClick={openLogModal}>
            <Plus className="h-4 w-4" />
            Log Miles
          </Button>
        }
      />

      {/* Summary card */}
      <SummaryCard summary={summary} />

      {/* Log table */}
      <Card>
        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading mileage logs...
          </div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={Car}
            title="No mileage logs yet"
            message="Log your business miles to track your deduction."
            action={
              <Button onClick={openLogModal}>
                <Plus className="h-4 w-4" /> Log Miles
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Purpose</Th>
                <Th numeric>Miles</Th>
                <Th numeric>Rate</Th>
                <Th numeric>Amount</Th>
                <Th>Billable</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <Tr key={log.id}>
                  <Td className="text-navy/80 whitespace-nowrap">{fmtDate(log.date)}</Td>
                  <Td className="text-navy/70">
                    {log.customerName ? (
                      <span>
                        {log.customerName}
                        {log.jobName && (
                          <span className="text-navy/40 text-xs ml-1">/ {log.jobName}</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-navy/30">—</span>
                    )}
                  </Td>
                  <Td className="text-navy/70">{log.purpose ?? <span className="text-navy/30">—</span>}</Td>
                  <Td numeric className="text-navy">{fmtMiles(log.miles)}</Td>
                  <Td numeric className="text-navy/70">
                    ${parseFloat(log.ratePerMile).toFixed(4)}
                  </Td>
                  <Td numeric className="font-semibold text-navy">
                    {formatCurrency(log.amount)}
                  </Td>
                  <Td>
                    {log.billable ? (
                      <Badge tone="info">Billable</Badge>
                    ) : (
                      <Badge tone="neutral">Internal</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(log)}
                      className="text-red-500 hover:bg-red-50"
                      title="Delete log"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Log Miles modal ---- */}
      <Modal
        open={logOpen}
        onClose={() => setLogOpen(false)}
        title="Log Miles"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLogOpen(false)} disabled={logSaving}>
              Cancel
            </Button>
            <Button onClick={handleLog} loading={logSaving}>
              Log Miles
            </Button>
          </>
        }
      >
        <LogMilesForm
          form={logForm}
          vehicles={vehicles}
          customers={customers}
          onChange={updateForm}
        />
      </Modal>

      {/* ---- Delete confirm ---- */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Mileage Log"
        message={
          <>
            Are you sure you want to delete this mileage log entry?{' '}
            {deleteTarget && (
              <>
                <strong className="text-navy">
                  {fmtMiles(deleteTarget.miles)} mi
                </strong>{' '}
                on{' '}
                <strong className="text-navy">{fmtDate(deleteTarget.date)}</strong>
                {deleteTarget.purpose ? ` — ${deleteTarget.purpose}` : ''}.
              </>
            )}{' '}
            This action cannot be undone.
          </>
        }
        confirmLabel="Yes, Delete"
        tone="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setDeleteTarget(null)}
      />
    </main>
  );
}
