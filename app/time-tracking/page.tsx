'use client';

import { useEffect, useState, useCallback } from 'react';
import { Timer, Plus } from 'lucide-react';
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
  PageHeader,
  ConfirmDialog,
  EmptyState,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency, Money } from '@/lib/money';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
}

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
}

interface TimeEntry {
  id: string;
  customerId: string | null;
  employeeId: string | null;
  jobId: string | null;
  serviceItemId: string | null;
  date: string;
  hours: string;
  billable: boolean;
  rate: string | null;
  description: string | null;
  invoicedInvoiceId: string | null;
  createdAt: string;
  /** B13: the hourly rate billing uses (typed rate > billing rate level > item price > 0). */
  billingRate?: string;
  billingAmount?: string;
  rateSource?: 'entry' | 'billing_rate_level' | 'item_price' | 'none';
  rateLevelName?: string | null;
}

interface ServiceItem {
  id: string;
  name: string;
  type: string;
  isActive?: boolean;
}

/** GET /api/billing-rate-levels/resolve — what an hour bills at when no rate is typed. */
interface ResolvedRate {
  rate: string | null;
  source: 'billing_rate_level' | 'item_price' | 'none';
  levelName: string | null;
}

/** Where a listed entry's rate came from, in plain words ("Senior rate", "item price"). */
function rateNote(e: TimeEntry): string | null {
  if (e.rateSource === 'billing_rate_level') return e.rateLevelName ? `${e.rateLevelName} rate` : 'billing rate level';
  if (e.rateSource === 'item_price') return 'item price';
  return null;
}

interface LogTimeForm {
  /** QB timesheet Name: the employee whose hours these are (needed to pay them in a pay run). */
  employeeId: string;
  customerId: string;
  /** Service item worked (prices the hour: billing rate level / item price). */
  serviceItemId: string;
  date: string;
  hours: string;
  rate: string;
  description: string;
  billable: boolean;
}

/** A blank Log Time form dated today (worked out each time: the app can stay open past midnight). */
const emptyForm = (): LogTimeForm => ({
  employeeId: '',
  customerId: '',
  serviceItemId: '',
  date: todayISO(),
  hours: '',
  rate: '',
  description: '',
  billable: true,
});

/** Time paid on a paycheck carries a [payroll:<paycheckId>] marker in its description. */
const PAID_TAG_RE = /\s*\[payroll:[^\]\s]+\]/g;
const isPaidInPayroll = (e: TimeEntry) => /\[payroll:[^\]\s]+\]/.test(e.description ?? '');
const displayDescription = (e: TimeEntry) => (e.description ?? '').replace(PAID_TAG_RE, '').trim() || '—';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** What the entry bills (the server's hours x billing rate; else hours x typed rate, Decimal-safe). */
function entryAmount(entry: TimeEntry) {
  return entry.billingAmount != null ? Money.of(entry.billingAmount) : Money.mul(entry.hours, entry.rate ?? '0');
}

/** Group entries by customerId, returning only billable + uninvoiced ones */
function unbilledByCustomer(entries: TimeEntry[], customers: Customer[]) {
  const custMap = new Map(customers.map((c) => [c.id, c.displayName]));
  const groups = new Map<string, { name: string; total: ReturnType<typeof entryAmount> }>();

  for (const e of entries) {
    if (!e.billable || e.invoicedInvoiceId || !e.customerId) continue;
    const prev = groups.get(e.customerId);
    const amount = entryAmount(e);
    if (prev) {
      prev.total = prev.total.plus(amount);
    } else {
      groups.set(e.customerId, { name: custMap.get(e.customerId) ?? e.customerId, total: amount });
    }
  }
  return [...groups.entries()].map(([id, info]) => ({ id, ...info }));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TimeTrackingPage() {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [form, setForm] = useState<LogTimeForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [billing, setBilling] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingBill, setPendingBill] = useState<string | null>(null);
  const [serviceItems, setServiceItems] = useState<ServiceItem[]>([]);
  const [resolved, setResolved] = useState<ResolvedRate | null>(null);

  // Service items for the Log Time form (optional: a user without the items list still logs time).
  useEffect(() => {
    api
      .get<{ items: ServiceItem[] }>('/api/items')
      .then((r) => setServiceItems((r.items ?? []).filter((i) => i.type === 'service')))
      .catch(() => setServiceItems([]));
  }, []);

  // B13: what an hour of this item bills at for this employee when no rate is typed.
  useEffect(() => {
    setResolved(null);
    if (!showLog || !form.serviceItemId) return;
    let live = true;
    const qs = new URLSearchParams({ itemId: form.serviceItemId });
    if (form.employeeId) qs.set('employeeId', form.employeeId);
    api
      .get<ResolvedRate>(`/api/billing-rate-levels/resolve?${qs}`)
      .then((r) => live && setResolved(r))
      .catch(() => live && setResolved(null));
    return () => {
      live = false;
    };
  }, [showLog, form.serviceItemId, form.employeeId]);

  // Filters
  const [filterBillable, setFilterBillable] = useState<'all' | 'yes' | 'no'>('all');
  const [filterInvoiced, setFilterInvoiced] = useState<'all' | 'yes' | 'no'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterBillable !== 'all') params.set('billable', filterBillable === 'yes' ? 'true' : 'false');
      if (filterInvoiced !== 'all') params.set('invoiced', filterInvoiced === 'yes' ? 'true' : 'false');
      const [rows, custs] = await Promise.all([
        api.get<TimeEntry[]>(`/api/time-entries?${params}`),
        api.get<Customer[]>('/api/customers'),
      ]);
      setEntries(rows);
      setCustomers(custs);
      // Employees are optional here (a user without payroll access can still log time).
      api
        .get<Employee[]>('/api/employees?includeInactive=true')
        .then(setEmployees)
        .catch(() => setEmployees([]));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to load time entries', 'danger');
    } finally {
      setLoading(false);
    }
  }, [filterBillable, filterInvoiced]);

  useEffect(() => {
    load();
  }, [load]);

  // ---- Log Time ----

  async function handleLogTime() {
    if (!form.date) { toast('Date is required', 'danger'); return; }
    if (!form.hours || parseFloat(form.hours) <= 0) { toast('Hours must be positive', 'danger'); return; }
    setSaving(true);
    try {
      await api.post('/api/time-entries', {
        employeeId: form.employeeId || null,
        customerId: form.customerId || null,
        serviceItemId: form.serviceItemId || null,
        date: form.date,
        hours: form.hours,
        rate: form.rate ? form.rate : null,
        description: form.description || null,
        billable: form.billable,
      });
      toast('Time entry logged', 'success');
      setShowLog(false);
      setForm(emptyForm());
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to log time', 'danger');
    } finally {
      setSaving(false);
    }
  }

  // ---- Delete ----

  async function handleDelete() {
    const id = pendingDelete;
    if (!id) return;
    setDeleting(true);
    try {
      await api.del(`/api/time-entries/${id}`);
      toast('Entry deleted', 'success');
      setPendingDelete(null);
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to delete entry', 'danger');
    } finally {
      setDeleting(false);
    }
  }

  // ---- Bill to Invoice ----

  async function handleBill() {
    const customerId = pendingBill;
    if (!customerId) return;
    setBilling(customerId);
    try {
      const inv = await api.post<{ invoiceNumber: number; total: string }>(
        '/api/time-entries/bill',
        { customerId },
      );
      toast(`Invoice #${inv.invoiceNumber} created for ${formatCurrency(inv.total)}`, 'success');
      setPendingBill(null);
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to create invoice', 'danger');
    } finally {
      setBilling(null);
    }
  }

  // ---- Customer name lookup ----

  const custMap = new Map(customers.map((c) => [c.id, c.displayName]));
  const empMap = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

  const unbilled = unbilledByCustomer(entries, customers);

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Time Tracking"
        icon={Timer}
        action={
          <Button data-shortcut="new" onClick={() => { setForm(emptyForm()); setShowLog(true); }}>
            <Plus className="h-4 w-4" />
            Log Time
          </Button>
        }
      />

      {/* Unbilled Summary Card */}
      {unbilled.length > 0 && (
        <Card className="mb-6 p-4">
          <h2 className="text-base font-semibold text-navy mb-3">Unbilled Billable Time by Customer</h2>
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th numeric>Unbilled Amount</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {unbilled.map((g) => (
                <Tr key={g.id}>
                  <Td>{g.name}</Td>
                  <Td numeric>{formatCurrency(g.total)}</Td>
                  <Td numeric>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={billing === g.id}
                      onClick={() => setPendingBill(g.id)}
                    >
                      Create Invoice from Billable Time
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {/* Filters */}
      <Card className="mb-4 p-4 flex gap-4 items-end">
        <div>
          <Label>Billable</Label>
          <Select
            className="w-36"
            value={filterBillable}
            onChange={(e) => setFilterBillable(e.target.value as typeof filterBillable)}
          >
            <option value="all">All</option>
            <option value="yes">Billable only</option>
            <option value="no">Non-billable only</option>
          </Select>
        </div>
        <div>
          <Label>Invoiced</Label>
          <Select
            className="w-36"
            value={filterInvoiced}
            onChange={(e) => setFilterInvoiced(e.target.value as typeof filterInvoiced)}
          >
            <option value="all">All</option>
            <option value="no">Not yet invoiced</option>
            <option value="yes">Already invoiced</option>
          </Select>
        </div>
      </Card>

      {/* Time Entries Table */}
      <Card className="p-4">
        {loading ? (
          <div className="flex items-center gap-2 text-navy/50 text-sm p-4">
            <Spinner className="h-4 w-4" /> Loading...
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Timer}
            title="No time entries yet"
            message="Log your first time entry to start tracking billable hours."
            action={
              <Button data-shortcut="new" onClick={() => { setForm(emptyForm()); setShowLog(true); }}>
                <Plus className="h-4 w-4" />
                Log Time
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Employee</Th>
                <Th>Customer</Th>
                <Th>Description</Th>
                <Th numeric>Hours</Th>
                <Th numeric>Rate</Th>
                <Th numeric>Amount</Th>
                <Th>Billable</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Tr key={e.id}>
                  <Td>{e.date ? formatDate(e.date) : '—'}</Td>
                  <Td>{e.employeeId ? (empMap.get(e.employeeId) ?? '—') : '—'}</Td>
                  <Td>{e.customerId ? (custMap.get(e.customerId) ?? '—') : '—'}</Td>
                  <Td className="max-w-xs truncate">{displayDescription(e)}</Td>
                  <Td numeric>{parseFloat(e.hours).toFixed(2)}</Td>
                  <Td numeric>
                    {(e.billingRate ?? e.rate) && Number(e.billingRate ?? e.rate) > 0 ? (
                      <>
                        {formatCurrency(e.billingRate ?? e.rate ?? '0')}
                        {rateNote(e) && <div className="text-xs text-navy/50">{rateNote(e)}</div>}
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td numeric>
                    {(e.billingRate ?? e.rate) && Number(e.billingRate ?? e.rate) > 0 ? formatCurrency(entryAmount(e)) : '—'}
                  </Td>
                  <Td>
                    {e.billable ? (
                      <Badge tone="info">Billable</Badge>
                    ) : (
                      <Badge tone="neutral">Non-billable</Badge>
                    )}
                  </Td>
                  <Td>
                    {e.invoicedInvoiceId ? (
                      <Badge tone="success">Invoiced</Badge>
                    ) : (
                      <Badge tone="warning">Unbilled</Badge>
                    )}
                    {isPaidInPayroll(e) && (
                      <Badge tone="neutral" className="ml-1">Paid in payroll</Badge>
                    )}
                  </Td>
                  <Td>
                    {/* Invoiced or paid time can't be deleted (void the invoice / paycheck first). */}
                    {!e.invoicedInvoiceId && !isPaidInPayroll(e) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:bg-red-50"
                        onClick={() => setPendingDelete(e.id)}
                      >
                        Delete
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Log Time Modal */}
      <Modal
        open={showLog}
        onClose={() => setShowLog(false)}
        title="Log Time"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowLog(false)}>
              Cancel
            </Button>
            <Button type="submit" form="log-time-form" loading={saving} data-shortcut="save">
              Log Time
            </Button>
          </>
        }
      >
        <form
          id="log-time-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleLogTime();
          }}
          className="space-y-4"
        >
          <div>
            <Label htmlFor="time-employee">Employee</Label>
            <Select
              id="time-employee"
              autoFocus
              value={form.employeeId}
              onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
            >
              <option value="">— No employee —</option>
              {employees
                .filter((emp) => emp.isActive || emp.id === form.employeeId)
                .map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.firstName} {emp.lastName}
                  </option>
                ))}
            </Select>
            <p className="text-xs text-navy/50 mt-1">Pick the employee to pay these hours in a pay run (Pull time).</p>
          </div>

          <div>
            <Label>Customer</Label>
            <Select
              value={form.customerId}
              onChange={(e) => setForm((f) => ({ ...f, customerId: e.target.value }))}
            >
              <option value="">— No customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="time-item">Service item</Label>
            <Select
              id="time-item"
              value={form.serviceItemId}
              onChange={(e) => setForm((f) => ({ ...f, serviceItemId: e.target.value }))}
            >
              <option value="">— No service item —</option>
              {serviceItems
                .filter((it) => it.isActive !== false || it.id === form.serviceItemId)
                .map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name}
                  </option>
                ))}
            </Select>
          </div>

          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Hours</Label>
              <Input
                type="number"
                min="0.25"
                step="0.25"
                placeholder="0.00"
                value={form.hours}
                onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
              />
            </div>
            <div>
              <Label>Rate ($/hr)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={form.rate}
                onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
              />
            </div>
          </div>

          {!form.rate && resolved?.rate && Number(resolved.rate) > 0 && (
            <p className="text-xs text-navy/60" role="status">
              Leave the rate blank to bill {formatCurrency(resolved.rate)}/hr
              {resolved.source === 'billing_rate_level'
                ? ` (${resolved.levelName ?? 'billing rate level'} rate)`
                : ' (the item’s price)'}
              .
            </p>
          )}

          {form.hours && (form.rate || (resolved?.rate && Number(resolved.rate) > 0)) && (
            <p className="text-sm text-navy/70">
              Amount:{' '}
              <span className="font-semibold">
                {formatCurrency(Money.mul(form.hours || '0', form.rate || resolved?.rate || '0'))}
              </span>
            </p>
          )}

          <div>
            <Label>Description</Label>
            <Input
              placeholder="What did you work on?"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="billable"
              type="checkbox"
              checked={form.billable}
              onChange={(e) => setForm((f) => ({ ...f, billable: e.target.checked }))}
              className="h-4 w-4 rounded border-slate-300 accent-electric"
            />
            <label htmlFor="billable" className="text-sm font-medium text-navy">
              Billable to customer
            </label>
          </div>
        </form>
      </Modal>

      {/* Confirmations */}
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete time entry?"
        message="This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onClose={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={!!pendingBill}
        title="Create invoice from billable time?"
        message={`Create an invoice from all unbilled time for ${
          pendingBill ? (custMap.get(pendingBill) ?? 'this customer') : 'this customer'
        }?`}
        confirmLabel="Create Invoice"
        loading={!!pendingBill && billing === pendingBill}
        onConfirm={handleBill}
        onClose={() => setPendingBill(null)}
      />
    </main>
  );
}
