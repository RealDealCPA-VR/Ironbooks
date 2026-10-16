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
}

interface LogTimeForm {
  customerId: string;
  date: string;
  hours: string;
  rate: string;
  description: string;
  billable: boolean;
}

const emptyForm: LogTimeForm = {
  customerId: '',
  date: todayISO(),
  hours: '',
  rate: '',
  description: '',
  billable: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decimal-safe hours x rate (never float math for money). */
function entryAmount(entry: TimeEntry) {
  return Money.mul(entry.hours, entry.rate ?? '0');
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
  const [loading, setLoading] = useState(true);
  const [showLog, setShowLog] = useState(false);
  const [form, setForm] = useState<LogTimeForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [billing, setBilling] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingBill, setPendingBill] = useState<string | null>(null);

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
        customerId: form.customerId || null,
        date: form.date,
        hours: form.hours,
        rate: form.rate ? form.rate : null,
        description: form.description || null,
        billable: form.billable,
      });
      toast('Time entry logged', 'success');
      setShowLog(false);
      setForm(emptyForm);
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

  const unbilled = unbilledByCustomer(entries, customers);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Time Tracking"
        icon={Timer}
        action={
          <Button onClick={() => { setForm(emptyForm); setShowLog(true); }}>
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
              <Button onClick={() => { setForm(emptyForm); setShowLog(true); }}>
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
                  <Td>{e.customerId ? (custMap.get(e.customerId) ?? '—') : '—'}</Td>
                  <Td className="max-w-xs truncate">{e.description ?? '—'}</Td>
                  <Td numeric>{parseFloat(e.hours).toFixed(2)}</Td>
                  <Td numeric>
                    {e.rate ? formatCurrency(e.rate) : '—'}
                  </Td>
                  <Td numeric>
                    {e.rate ? formatCurrency(entryAmount(e)) : '—'}
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
                  </Td>
                  <Td>
                    {!e.invoicedInvoiceId && (
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
            <Button type="submit" form="log-time-form" loading={saving}>
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
            <Label>Customer</Label>
            <Select
              autoFocus
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

          {form.hours && form.rate && (
            <p className="text-sm text-navy/70">
              Amount: <span className="font-semibold">{formatCurrency(Money.mul(form.hours || '0', form.rate || '0'))}</span>
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
