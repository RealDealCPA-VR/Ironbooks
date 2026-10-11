'use client';

import { useEffect, useState, useCallback } from 'react';
import { ClipboardList, Plus, ArrowRight, Download, Percent } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  DateInput,
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
import { formatDate } from '@/lib/format';
import { PricedLinesEditor, type PricedLineItem } from '@/components/PricedLinesEditor';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Estimate {
  id: string;
  estimateNumber: number;
  customerId: string;
  date: string;
  expirationDate: string | null;
  status: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  memo: string | null;
  convertedInvoiceId: string | null;
  /** Total billed via progress invoicing so far (≤ total). */
  amountInvoiced: string;
}

interface EstimateDetailLine {
  id: string;
  itemId: string | null;
  description: string | null;
  quantity: string;
  rate: string;
  amount: string;
  taxable: boolean;
}

interface Customer {
  id: string;
  displayName: string;
}

interface TaxRate {
  id: string;
  name: string;
  rate: string; // fraction, e.g. "0.082500"
}

interface EstimateLineForm {
  itemId: string;
  description: string;
  quantity: string;
  rate: string;
  taxable: boolean;
  /** Advanced pricing: the user typed the rate (automatic prices leave it alone). */
  rateManual?: boolean;
}

interface EstimateForm {
  customerId: string;
  date: string;
  expirationDate: string;
  taxRateId: string;
  memo: string;
  lines: EstimateLineForm[];
}

const EMPTY_LINE: EstimateLineForm = {
  itemId: '',
  description: '',
  quantity: '1',
  rate: '',
  taxable: true,
};

const today = () => new Date().toISOString().slice(0, 10);

const EMPTY_FORM: EstimateForm = {
  customerId: '',
  date: today(),
  expirationDate: '',
  taxRateId: '',
  memo: '',
  lines: [{ ...EMPTY_LINE }],
};

// ---------------------------------------------------------------------------
// Status badge helper
// ---------------------------------------------------------------------------

function statusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'draft': return 'neutral';
    case 'accepted': return 'success';
    case 'partial': return 'warning';
    case 'rejected': return 'danger';
    case 'closed': return 'info';
    default: return 'neutral';
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ---------------------------------------------------------------------------
// New Estimate modal form
// ---------------------------------------------------------------------------

function EstimateFormBody({
  form,
  customers,
  taxRates,
  items,
  onChange,
  onLinesChange,
}: {
  form: EstimateForm;
  customers: Customer[];
  taxRates: TaxRate[];
  items: PricedLineItem[];
  onChange: (field: keyof EstimateForm, value: string) => void;
  onLinesChange: (lines: EstimateLineForm[]) => void;
}) {
  const subtotal = form.lines.reduce(
    (sum, l) => sum + (parseFloat(l.quantity) || 0) * (parseFloat(l.rate) || 0),
    0,
  );
  // Mirror the service/invoice math: tax applies to taxable lines only.
  const taxableSubtotal = form.lines.reduce(
    (sum, l) => sum + (l.taxable ? (parseFloat(l.quantity) || 0) * (parseFloat(l.rate) || 0) : 0),
    0,
  );
  const selectedRate = taxRates.find((t) => t.id === form.taxRateId);
  const taxAmount = taxableSubtotal * (selectedRate ? parseFloat(selectedRate.rate) || 0 : 0);
  const total = subtotal + taxAmount;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="customerId">Customer *</Label>
          <Select
            id="customerId"
            value={form.customerId}
            onChange={(e) => onChange('customerId', e.target.value)}
            required
            autoFocus
          >
            <option value="">Select customer...</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="date">Date *</Label>
          <DateInput
            id="date"
            value={form.date}
            onChange={(e) => onChange('date', e.target.value)}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="expirationDate">Expiration Date</Label>
          <DateInput
            id="expirationDate"
            value={form.expirationDate}
            onChange={(e) => onChange('expirationDate', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="est-taxrate">Sales Tax</Label>
          <Select
            id="est-taxrate"
            value={form.taxRateId}
            onChange={(e) => onChange('taxRateId', e.target.value)}
          >
            <option value="">No tax</option>
            {taxRates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({(parseFloat(t.rate) * 100).toFixed(2)}%)
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <Label>Line Items *</Label>
        <PricedLinesEditor
          items={items}
          lines={form.lines}
          onChange={onLinesChange}
          header={{ customerId: form.customerId || null, date: form.date }}
          showTaxable
        />

        <div className="flex flex-col items-end gap-0.5 mt-3 pt-3 border-t border-slate-100 text-sm">
          <span className="text-navy/60">Subtotal: {formatCurrency(subtotal)}</span>
          <span className="text-navy/60">
            Sales Tax{selectedRate ? ` (${(parseFloat(selectedRate.rate) * 100).toFixed(2)}%)` : ''}:{' '}
            {formatCurrency(taxAmount)}
          </span>
          <span className="font-bold text-navy">Total: {formatCurrency(total)}</span>
        </div>
      </div>

      <div>
        <Label htmlFor="memo">Memo</Label>
        <textarea
          id="memo"
          rows={2}
          placeholder="Optional note to customer..."
          value={form.memo}
          onChange={(e) => onChange('memo', e.target.value)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30 placeholder:text-navy/30 resize-none"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function EstimatesPage() {
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [items, setItems] = useState<PricedLineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [customerMap, setCustomerMap] = useState<Map<string, string>>(new Map());

  // New estimate modal.
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<EstimateForm>({ ...EMPTY_FORM, lines: [{ ...EMPTY_LINE }] });
  const [addSaving, setAddSaving] = useState(false);

  // Convert confirm modal.
  const [convertTarget, setConvertTarget] = useState<Estimate | null>(null);
  const [converting, setConverting] = useState(false);

  // Row whose Accept/Reject/Draft PATCH is in flight (disables that row's status buttons).
  const [pendingStatusId, setPendingStatusId] = useState<string | null>(null);

  // Progress invoicing modal.
  const [progressTarget, setProgressTarget] = useState<Estimate | null>(null);
  const [progressLines, setProgressLines] = useState<EstimateDetailLine[]>([]);
  const [progressMode, setProgressMode] = useState<'percent' | 'lines'>('percent');
  const [progressPercent, setProgressPercent] = useState('');
  const [progressLineAmounts, setProgressLineAmounts] = useState<Record<string, string>>({});
  const [progressSaving, setProgressSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  const fetchEstimates = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<Estimate[]>('/api/estimates');
      setEstimates(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load estimates', 'danger');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCustomers = useCallback(async () => {
    try {
      const data = await api.get<Customer[]>('/api/customers');
      setCustomers(data);
      setCustomerMap(new Map(data.map((c) => [c.id, c.displayName])));
    } catch {
      // Non-fatal; customers just won't populate the dropdown.
    }
  }, []);

  const fetchTaxRates = useCallback(async () => {
    try {
      const data = await api.get<TaxRate[]>('/api/tax-rates');
      setTaxRates(data);
    } catch {
      // Non-fatal; the tax dropdown just won't populate.
    }
  }, []);

  useEffect(() => {
    fetchEstimates();
    fetchCustomers();
    fetchTaxRates();
    api
      .get<{ items: PricedLineItem[] }>('/api/items')
      .then((r) => setItems(r.items ?? []))
      .catch(() => {
        // Non-fatal; lines can still be typed without an item.
      });
  }, [fetchEstimates, fetchCustomers, fetchTaxRates]);

  // ---------------------------------------------------------------------------
  // New estimate
  // ---------------------------------------------------------------------------

  function openAddModal() {
    setAddForm({ ...EMPTY_FORM, date: today(), lines: [{ ...EMPTY_LINE }] });
    setAddOpen(true);
  }

  function handleFormChange(field: keyof EstimateForm, value: string) {
    setAddForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleCreate() {
    if (!addForm.customerId) {
      toast('Please select a customer', 'danger');
      return;
    }
    if (!addForm.date) {
      toast('Please enter a date', 'danger');
      return;
    }
    if (addForm.lines.some((l) => !l.description.trim())) {
      toast('All lines must have a description', 'danger');
      return;
    }

    setAddSaving(true);
    try {
      await api.post('/api/estimates', {
        customerId: addForm.customerId,
        date: addForm.date,
        expirationDate: addForm.expirationDate || null,
        taxRateId: addForm.taxRateId || null,
        memo: addForm.memo || null,
        lines: addForm.lines.map((l) => ({
          itemId: l.itemId || null,
          description: l.description.trim(),
          quantity: parseFloat(l.quantity) || 1,
          // Blank rate on an item line: the server prices it (advanced pricing).
          rate: l.rate.trim() === '' ? (l.itemId ? null : 0) : parseFloat(l.rate) || 0,
          taxable: l.taxable,
        })),
      });
      toast('Estimate created', 'success');
      setAddOpen(false);
      await fetchEstimates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create estimate', 'danger');
    } finally {
      setAddSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Status update
  // ---------------------------------------------------------------------------

  async function handleStatusChange(estimate: Estimate, status: string) {
    setPendingStatusId(estimate.id);
    try {
      await api.patch(`/api/estimates/${estimate.id}`, { status });
      toast(`Estimate #${estimate.estimateNumber} marked ${status}`, 'success');
      await fetchEstimates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update status', 'danger');
    } finally {
      setPendingStatusId(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Convert to invoice
  // ---------------------------------------------------------------------------

  async function handleConvert() {
    if (!convertTarget) return;
    setConverting(true);
    try {
      await api.post(`/api/estimates/${convertTarget.id}`, { action: 'convert' });
      toast(`Estimate #${convertTarget.estimateNumber} converted to invoice`, 'success');
      setConvertTarget(null);
      await fetchEstimates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to convert estimate', 'danger');
    } finally {
      setConverting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Progress invoicing
  // ---------------------------------------------------------------------------

  async function openProgressModal(estimate: Estimate) {
    setProgressTarget(estimate);
    setProgressMode('percent');
    setProgressPercent('');
    setProgressLineAmounts({});
    setProgressLines([]);
    try {
      const detail = await api.get<Estimate & { lines: EstimateDetailLine[] }>(
        `/api/estimates/${estimate.id}`,
      );
      setProgressLines(detail.lines ?? []);
    } catch {
      // Per-line mode just won't have rows; percent mode still works.
    }
  }

  async function handleProgressInvoice() {
    if (!progressTarget) return;

    const payload: Record<string, unknown> = { action: 'progress' };
    if (progressMode === 'percent') {
      const pct = parseFloat(progressPercent);
      if (!pct || pct <= 0 || pct > 100) {
        toast('Enter a percentage between 0 and 100', 'danger');
        return;
      }
      payload.percent = progressPercent;
    } else {
      const lineAmounts = Object.entries(progressLineAmounts)
        .filter(([, amount]) => parseFloat(amount) > 0)
        .map(([lineId, amount]) => ({ lineId, amount }));
      if (lineAmounts.length === 0) {
        toast('Enter an amount for at least one line', 'danger');
        return;
      }
      payload.lineAmounts = lineAmounts;
    }

    setProgressSaving(true);
    try {
      await api.post(`/api/estimates/${progressTarget.id}`, payload);
      toast(
        `Progress invoice created for estimate EST-${String(progressTarget.estimateNumber).padStart(4, '0')}`,
        'success',
      );
      setProgressTarget(null);
      await fetchEstimates();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create progress invoice', 'danger');
    } finally {
      setProgressSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Estimates"
        icon={ClipboardList}
        action={
          <Button onClick={openAddModal}>
            <Plus className="h-4 w-4" />
            New Estimate
          </Button>
        }
      />

      <Card>
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : estimates.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No estimates yet"
            message="Create your first quote to get started."
            action={
              <Button onClick={openAddModal}>
                <Plus className="h-4 w-4" /> New Estimate
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>#</Th>
                <Th>Customer</Th>
                <Th>Date</Th>
                <Th>Expires</Th>
                <Th numeric>Total</Th>
                <Th numeric>Invoiced</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {estimates.map((e) => (
                <Tr key={e.id}>
                  <Td className="font-mono font-semibold text-navy">
                    EST-{String(e.estimateNumber).padStart(4, '0')}
                  </Td>
                  <Td className="font-semibold text-navy">
                    {customerMap.get(e.customerId) ?? '—'}
                  </Td>
                  <Td className="text-navy/70">{formatDate(e.date)}</Td>
                  <Td className="text-navy/70">{formatDate(e.expirationDate)}</Td>
                  <Td numeric className="font-semibold text-navy">
                    {formatCurrency(e.total)}
                  </Td>
                  <Td numeric className="text-navy/70">
                    {Number(e.amountInvoiced) > 0 ? formatCurrency(e.amountInvoiced) : '-'}
                  </Td>
                  <Td>
                    <Badge tone={statusTone(e.status)}>{statusLabel(e.status)}</Badge>
                  </Td>
                  <Td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* PDF download */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => window.open(`/api/estimates/${e.id}/pdf`, '_blank')}
                        title="Download PDF"
                      >
                        <Download className="h-3.5 w-3.5" />
                        PDF
                      </Button>
                      {/* Status transitions for non-closed, non-partial estimates */}
                      {e.status !== 'closed' && e.status !== 'partial' && (
                        <>
                          {e.status !== 'accepted' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleStatusChange(e, 'accepted')}
                              disabled={pendingStatusId === e.id}
                              title="Mark accepted"
                            >
                              Accept
                            </Button>
                          )}
                          {e.status !== 'rejected' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleStatusChange(e, 'rejected')}
                              disabled={pendingStatusId === e.id}
                              className="text-red-500 hover:bg-red-50"
                              title="Mark rejected"
                            >
                              Reject
                            </Button>
                          )}
                          {e.status !== 'draft' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleStatusChange(e, 'draft')}
                              disabled={pendingStatusId === e.id}
                              title="Reset to draft"
                            >
                              Draft
                            </Button>
                          )}
                        </>
                      )}
                      {e.status !== 'closed' && e.status !== 'rejected' && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openProgressModal(e)}
                            title="Bill part of this estimate (progress invoicing)"
                          >
                            <Percent className="h-3.5 w-3.5" />
                            Progress
                          </Button>
                          {e.status !== 'partial' && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setConvertTarget(e)}
                              title="Convert to invoice"
                            >
                              <ArrowRight className="h-3.5 w-3.5" />
                              Invoice
                            </Button>
                          )}
                        </>
                      )}
                      {e.status === 'closed' && e.convertedInvoiceId && (
                        <span className="text-xs text-navy/40 italic">Converted</span>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ---- New Estimate modal ---- */}
      <Modal
        size="lg"
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="New Estimate"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={addSaving}>
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={addSaving}>
              Create Estimate
            </Button>
          </>
        }
      >
        <EstimateFormBody
          form={addForm}
          customers={customers}
          taxRates={taxRates}
          items={items}
          onChange={handleFormChange}
          onLinesChange={(lines) => setAddForm((prev) => ({ ...prev, lines }))}
        />
      </Modal>

      {/* ---- Progress Invoice modal ---- */}
      <Modal
        open={!!progressTarget}
        onClose={() => setProgressTarget(null)}
        title={`Progress Invoice — EST-${String(progressTarget?.estimateNumber ?? 0).padStart(4, '0')}`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setProgressTarget(null)}
              disabled={progressSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleProgressInvoice} loading={progressSaving}>
              Create Progress Invoice
            </Button>
          </>
        }
      >
        {progressTarget && (
          <div className="flex flex-col gap-4">
            {/* Remaining summary */}
            <div className="rounded-lg bg-navy/5 px-4 py-3 grid grid-cols-3 gap-2 text-sm">
              <div>
                <div className="text-xs text-navy/50">Estimate Total</div>
                <div className="font-semibold text-navy tabular-nums">
                  {formatCurrency(progressTarget.total)}
                </div>
              </div>
              <div>
                <div className="text-xs text-navy/50">Already Invoiced</div>
                <div className="font-semibold text-navy tabular-nums">
                  {formatCurrency(progressTarget.amountInvoiced)}
                </div>
              </div>
              <div>
                <div className="text-xs text-navy/50">Remaining</div>
                <div className="font-semibold text-electric tabular-nums">
                  {formatCurrency(
                    (Number(progressTarget.total) - Number(progressTarget.amountInvoiced)).toFixed(2),
                  )}
                </div>
              </div>
            </div>

            {/* Mode toggle */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden w-fit">
              <button
                type="button"
                onClick={() => setProgressMode('percent')}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${
                  progressMode === 'percent'
                    ? 'bg-electric text-white'
                    : 'bg-white text-navy/60 hover:bg-slate-50'
                }`}
              >
                % of remaining
              </button>
              <button
                type="button"
                onClick={() => setProgressMode('lines')}
                className={`px-3 py-2 text-xs font-semibold transition-colors ${
                  progressMode === 'lines'
                    ? 'bg-electric text-white'
                    : 'bg-white text-navy/60 hover:bg-slate-50'
                }`}
              >
                Per-line amounts
              </button>
            </div>

            {progressMode === 'percent' ? (
              <div>
                <Label htmlFor="progress-pct">Percentage of remaining balance *</Label>
                <Input
                  id="progress-pct"
                  type="number"
                  min="0.01"
                  max="100"
                  step="any"
                  placeholder="e.g. 50"
                  value={progressPercent}
                  onChange={(e) => setProgressPercent(e.target.value)}
                />
                {parseFloat(progressPercent) > 0 && (
                  <p className="mt-1 text-xs text-navy/50">
                    Will invoice{' '}
                    <strong>
                      {formatCurrency(
                        (
                          (Number(progressTarget.total) - Number(progressTarget.amountInvoiced)) *
                          (parseFloat(progressPercent) / 100)
                        ).toFixed(2),
                      )}
                    </strong>{' '}
                    allocated across the estimate lines.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <Label>Amount to bill per line</Label>
                <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
                  {progressLines.length === 0 ? (
                    <div className="flex items-center gap-2 p-3 text-xs text-navy/40">
                      <Spinner className="h-4 w-4" /> Loading estimate lines…
                    </div>
                  ) : (
                    progressLines.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                        <span className="flex-1 truncate text-navy/80">
                          {l.description ?? 'Line'}
                          <span className="text-navy/40">
                            {' '}
                            ({formatCurrency(l.amount)} quoted)
                          </span>
                        </span>
                        <AmountInput
                          placeholder="0.00"
                          value={progressLineAmounts[l.id] ?? ''}
                          onChange={(ev) =>
                            setProgressLineAmounts((prev) => ({ ...prev, [l.id]: ev.target.value }))
                          }
                          className="w-28"
                          aria-label={`Amount for ${l.description ?? 'line'}`}
                        />
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            <p className="text-xs text-navy/50">
              A partial invoice will be posted to A/R and linked to this estimate. The estimate
              stays open until the full {formatCurrency(progressTarget.total)} has been invoiced.
            </p>
          </div>
        )}
      </Modal>

      {/* ---- Convert confirm modal ---- */}
      <Modal
        open={!!convertTarget}
        onClose={() => setConvertTarget(null)}
        title="Convert to Invoice"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConvertTarget(null)}
              disabled={converting}
            >
              Cancel
            </Button>
            <Button onClick={handleConvert} loading={converting}>
              Convert to Invoice
            </Button>
          </>
        }
      >
        <p className="text-navy/70 text-sm">
          Convert{' '}
          <strong className="text-navy">
            EST-{String(convertTarget?.estimateNumber ?? 0).padStart(4, '0')}
          </strong>{' '}
          (
          <strong>{formatCurrency(convertTarget?.total ?? 0)}</strong>) into a posted invoice?
          This will debit Accounts Receivable and credit Sales Income. The estimate will be
          marked as closed.
        </p>
      </Modal>
    </main>
  );
}
