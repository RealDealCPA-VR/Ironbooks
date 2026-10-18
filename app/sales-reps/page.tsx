'use client';

import { useEffect, useState } from 'react';
import { BadgePercent, Pencil, UserX, Plus, BarChart2, Link2 } from 'lucide-react';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
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
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SalesRep {
  id: string;
  name: string;
  email: string | null;
  commissionRate: string;
  isActive: boolean;
}

interface Invoice {
  id: string;
  invoiceNumber: number;
  total: string;
  salesRepId: string | null;
  status: string;
}

interface CommissionRow {
  repId: string;
  name: string;
  salesTotal: string;
  commissionRate: string;
  commission: string;
}

interface CommissionReport {
  rows: CommissionRow[];
  totals: { salesTotal: string; commission: string };
}

interface RepFormState {
  name: string;
  email: string;
  commissionRate: string;
}

const EMPTY_FORM: RepFormState = { name: '', email: '', commissionRate: '0.05' };

// ---------------------------------------------------------------------------
// Sales rep form (shared add / edit)
// ---------------------------------------------------------------------------

function RepForm({
  form,
  onChange,
}: {
  form: RepFormState;
  onChange: (field: keyof RepFormState, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="rep-name">Name *</Label>
        <Input
          id="rep-name"
          placeholder="e.g. Jane Doe"
          value={form.name}
          onChange={(e) => onChange('name', e.target.value)}
          required
          autoFocus
        />
      </div>
      <div>
        <Label htmlFor="rep-email">Email</Label>
        <Input
          id="rep-email"
          type="email"
          placeholder="jane@example.com"
          value={form.email}
          onChange={(e) => onChange('email', e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="rep-rate">Commission Rate (e.g. 0.05 = 5%)</Label>
        <Input
          id="rep-rate"
          type="number"
          step="0.001"
          min="0"
          max="1"
          placeholder="0.05"
          value={form.commissionRate}
          onChange={(e) => onChange('commissionRate', e.target.value)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SalesRepsPage() {
  const [reps, setReps] = useState<SalesRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeInactive, setIncludeInactive] = useState(false);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<RepFormState>(EMPTY_FORM);
  const [addSaving, setAddSaving] = useState(false);

  // Edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SalesRep | null>(null);
  const [editForm, setEditForm] = useState<RepFormState>(EMPTY_FORM);
  const [editSaving, setEditSaving] = useState(false);

  // Deactivate confirm modal
  const [deactivateTarget, setDeactivateTarget] = useState<SalesRep | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // Commission report section
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [report, setReport] = useState<CommissionReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Assign rep to invoice section
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [assignInvoiceId, setAssignInvoiceId] = useState('');
  const [assignRepId, setAssignRepId] = useState('');
  const [assigning, setAssigning] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  async function fetchReps() {
    setLoading(true);
    try {
      const url = includeInactive ? '/api/sales-reps?includeInactive=true' : '/api/sales-reps';
      const data = await api.get<SalesRep[]>(url);
      setReps(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load sales reps', 'danger');
    } finally {
      setLoading(false);
    }
  }

  async function fetchInvoices() {
    try {
      const data = await api.get<Invoice[]>('/api/invoices');
      setInvoices(data);
    } catch {
      // non-critical
    }
  }

  useEffect(() => {
    fetchReps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeInactive]);

  useEffect(() => {
    fetchInvoices();
  }, []);

  // ---------------------------------------------------------------------------
  // Add rep
  // ---------------------------------------------------------------------------

  function openAddModal() {
    setAddForm(EMPTY_FORM);
    setAddOpen(true);
  }

  function updateAddForm(field: keyof RepFormState, value: string) {
    setAddForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleAdd() {
    if (!addForm.name.trim()) {
      toast('Name is required', 'danger');
      return;
    }
    setAddSaving(true);
    try {
      await api.post('/api/sales-reps', {
        name: addForm.name.trim(),
        email: addForm.email.trim() || null,
        commissionRate: parseFloat(addForm.commissionRate) || 0,
      });
      toast('Sales rep created', 'success');
      setAddOpen(false);
      await fetchReps();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create sales rep', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Edit rep
  // ---------------------------------------------------------------------------

  function openEditModal(rep: SalesRep) {
    setEditTarget(rep);
    setEditForm({
      name: rep.name,
      email: rep.email ?? '',
      commissionRate: rep.commissionRate,
    });
    setEditOpen(true);
  }

  function updateEditForm(field: keyof RepFormState, value: string) {
    setEditForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleEdit() {
    if (!editTarget) return;
    if (!editForm.name.trim()) {
      toast('Name is required', 'danger');
      return;
    }
    setEditSaving(true);
    try {
      await api.patch(`/api/sales-reps/${editTarget.id}`, {
        name: editForm.name.trim(),
        email: editForm.email.trim() || null,
        commissionRate: parseFloat(editForm.commissionRate) || 0,
      });
      toast('Sales rep updated', 'success');
      setEditOpen(false);
      setEditTarget(null);
      await fetchReps();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update sales rep', 'danger');
    } finally {
      setEditSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Deactivate rep
  // ---------------------------------------------------------------------------

  async function handleDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.del(`/api/sales-reps/${deactivateTarget.id}`);
      toast(`${deactivateTarget.name} deactivated`, 'success');
      setDeactivateTarget(null);
      await fetchReps();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to deactivate', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Commission report
  // ---------------------------------------------------------------------------

  async function fetchReport() {
    setReportLoading(true);
    try {
      const params = new URLSearchParams();
      if (reportFrom) params.set('from', reportFrom);
      if (reportTo) params.set('to', reportTo);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await api.get<CommissionReport>(`/api/reports/commissions${qs}`);
      setReport(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load commission report', 'danger');
    } finally {
      setReportLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Assign rep to invoice
  // ---------------------------------------------------------------------------

  async function handleAssign() {
    if (!assignInvoiceId) {
      toast('Select an invoice', 'danger');
      return;
    }
    setAssigning(true);
    try {
      await api.post('/api/sales-reps/assign', {
        invoiceId: assignInvoiceId,
        salesRepId: assignRepId || null,
      });
      toast('Invoice updated', 'success');
      setAssignInvoiceId('');
      setAssignRepId('');
      await fetchInvoices();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to assign rep', 'danger');
    } finally {
      setAssigning(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const fmtRate = (rate: string) => `${(parseFloat(rate) * 100).toFixed(1)}%`;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Sales Reps"
        icon={BadgePercent}
        action={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-navy/60 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="rounded border-slate-300 text-electric focus:ring-electric/40"
              />
              Show inactive
            </label>
            <Button onClick={openAddModal}>
              <Plus className="h-4 w-4" />
              Add Rep
            </Button>
          </div>
        }
      />

      {/* ---- Reps table ---- */}
      <Card className="mb-8">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : reps.length === 0 ? (
          <EmptyState
            icon={BadgePercent}
            title={includeInactive ? 'No sales reps found' : 'No sales reps yet'}
            message={
              includeInactive
                ? 'There are no sales reps, active or inactive.'
                : 'Add your first sales rep to get started.'
            }
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" /> Add Rep
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th numeric>Commission Rate</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {reps.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-semibold text-navy">{r.name}</Td>
                  <Td className="text-navy/70">
                    {r.email ? (
                      <a href={`mailto:${r.email}`} className="text-electric hover:underline">
                        {r.email}
                      </a>
                    ) : (
                      '-'
                    )}
                  </Td>
                  <Td numeric className="text-navy">{fmtRate(r.commissionRate)}</Td>
                  <Td>
                    {r.isActive ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="neutral">Inactive</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditModal(r)}
                        title="Edit rep"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                      {r.isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeactivateTarget(r)}
                          title="Deactivate rep"
                          className="text-red-500 hover:bg-red-50"
                        >
                          <UserX className="h-3.5 w-3.5" />
                          Deactivate
                        </Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- Commission report ---- */}
      <div className="mb-8">
        <h2 className="text-xl font-bold text-navy flex items-center gap-2 mb-4">
          <BarChart2 className="h-5 w-5 text-electric" />
          Commission Report
        </h2>
        <Card className="p-6">
          <div className="flex flex-wrap items-end gap-4 mb-6">
            <div>
              <Label htmlFor="report-from">From</Label>
              <Input
                id="report-from"
                type="date"
                value={reportFrom}
                onChange={(e) => setReportFrom(e.target.value)}
                className="w-40"
              />
            </div>
            <div>
              <Label htmlFor="report-to">To</Label>
              <Input
                id="report-to"
                type="date"
                value={reportTo}
                onChange={(e) => setReportTo(e.target.value)}
                className="w-40"
              />
            </div>
            <Button onClick={fetchReport} loading={reportLoading}>
              Run Report
            </Button>
          </div>

          {report && (
            <>
              {report.rows.length === 0 ? (
                <p className="text-navy/50 text-sm">
                  No invoices with assigned sales reps in the selected period.
                </p>
              ) : (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Rep Name</Th>
                        <Th numeric>Sales Total</Th>
                        <Th numeric>Rate</Th>
                        <Th numeric>Commission</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((row) => (
                        <Tr key={row.repId}>
                          <Td className="font-semibold text-navy">{row.name}</Td>
                          <Td numeric className="text-navy">
                            {formatCurrency(row.salesTotal)}
                          </Td>
                          <Td numeric className="text-navy">
                            {fmtRate(row.commissionRate)}
                          </Td>
                          <Td numeric className="font-semibold text-emerald">
                            {formatCurrency(row.commission)}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-navy/20">
                        <Td className="font-bold text-navy">Totals</Td>
                        <Td numeric className="font-bold text-navy">
                          {formatCurrency(report.totals.salesTotal)}
                        </Td>
                        <Td />
                        <Td numeric className="font-bold text-emerald">
                          {formatCurrency(report.totals.commission)}
                        </Td>
                      </tr>
                    </tfoot>
                  </Table>
                </>
              )}
            </>
          )}
        </Card>
      </div>

      {/* ---- Assign rep to invoice ---- */}
      <div className="mb-8">
        <h2 className="text-xl font-bold text-navy flex items-center gap-2 mb-4">
          <Link2 className="h-5 w-5 text-electric" />
          Assign Rep to Invoice
        </h2>
        <Card className="p-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex-1 min-w-48">
              <Label htmlFor="assign-invoice">Invoice</Label>
              <Select
                id="assign-invoice"
                value={assignInvoiceId}
                onChange={(e) => setAssignInvoiceId(e.target.value)}
              >
                <option value="">-- Select invoice --</option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    #{inv.invoiceNumber} — {formatCurrency(inv.total)}{' '}
                    {inv.status !== 'open' ? `(${inv.status})` : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex-1 min-w-48">
              <Label htmlFor="assign-rep">Sales Rep</Label>
              <Select
                id="assign-rep"
                value={assignRepId}
                onChange={(e) => setAssignRepId(e.target.value)}
              >
                <option value="">-- None (clear) --</option>
                {reps
                  .filter((r) => r.isActive)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({fmtRate(r.commissionRate)})
                    </option>
                  ))}
              </Select>
            </div>
            <Button onClick={handleAssign} loading={assigning} disabled={!assignInvoiceId}>
              Assign
            </Button>
          </div>
          {assignInvoiceId && (
            <p className="mt-3 text-xs text-navy/50">
              Selecting &quot;None (clear)&quot; will remove any existing rep from the invoice.
            </p>
          )}
        </Card>
      </div>

      {/* ---- Add rep modal ---- */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Sales Rep"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleAdd} loading={addSaving}>
              Create Rep
            </Button>
          </>
        }
      >
        <RepForm form={addForm} onChange={updateAddForm} />
      </Modal>

      {/* ---- Edit rep modal ---- */}
      <Modal
        open={editOpen}
        onClose={() => { setEditOpen(false); setEditTarget(null); }}
        title={`Edit: ${editTarget?.name ?? ''}`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => { setEditOpen(false); setEditTarget(null); }}
              disabled={editSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleEdit} loading={editSaving}>
              Save Changes
            </Button>
          </>
        }
      >
        <RepForm form={editForm} onChange={updateEditForm} />
      </Modal>

      {/* ---- Deactivate confirm modal ---- */}
      <ConfirmDialog
        open={!!deactivateTarget}
        title="Deactivate Sales Rep"
        message={
          <>
            Are you sure you want to deactivate{' '}
            <strong className="text-navy">{deactivateTarget?.name}</strong>? They will no longer
            appear in active rep lists, but historical invoice assignments are preserved.
          </>
        }
        confirmLabel="Yes, Deactivate"
        tone="danger"
        loading={deactivating}
        onConfirm={handleDeactivate}
        onClose={() => setDeactivateTarget(null)}
      />
    </main>
  );
}
