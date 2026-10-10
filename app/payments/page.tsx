'use client';

import { Suspense, useEffect, useState, useCallback } from 'react';
import { HandCoins, Plus } from 'lucide-react';
import {
  AmountInput,
  Button,
  Card,
  ConfirmDialog,
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
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';
import { useNewParam } from '@/lib/useFocusParam';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Payment {
  id: string;
  date: string;
  customerId: string;
  method: string;
  amount: string;
  unapplied: string;
  reference: string | null;
  voidedAt: string | null;
}

interface Customer {
  id: string;
  displayName: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface Invoice {
  id: string;
  date: string;
  total: string;
  balanceDue: string;
  status: string;
  memo: string | null;
}

interface Application {
  invoiceId: string;
  amountApplied: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  check: 'Check',
  credit_card: 'Credit Card',
  ach: 'ACH',
  bank_transfer: 'Bank Transfer',
  other: 'Other',
};

function methodBadgeTone(
  method: string,
): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  switch (method) {
    case 'cash':
      return 'success';
    case 'check':
      return 'info';
    case 'credit_card':
      return 'warning';
    case 'ach':
    case 'bank_transfer':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// Sum the amountApplied values across all applications for display only (Number() per rules).
function sumApplications(apps: Application[]): number {
  return apps.reduce((acc, a) => acc + (Number(a.amountApplied) || 0), 0);
}

// ---------------------------------------------------------------------------
// Receive Payment Modal
// ---------------------------------------------------------------------------

interface ReceivePaymentModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  customers: Customer[];
}

function ReceivePaymentModal({ open, onClose, onSaved, customers }: ReceivePaymentModalProps) {
  const today = new Date().toISOString().slice(0, 10);

  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<string>('check');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  // Map from invoiceId -> amountApplied string
  const [applicationAmounts, setApplicationAmounts] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!open) {
      setCustomerId('');
      setDate(today);
      setMethod('check');
      setAmount('');
      setReference('');
      setInvoices([]);
      setApplicationAmounts({});
    }
  }, [open, today]);

  // Fetch open invoices when customer changes
  useEffect(() => {
    if (!customerId) {
      setInvoices([]);
      setApplicationAmounts({});
      return;
    }
    setInvoicesLoading(true);
    api
      .get<Invoice[]>(`/api/invoices?customerId=${customerId}&status=open`)
      .then((rows) => {
        // API may return an array directly or wrapped; handle both shapes.
        const list = Array.isArray(rows) ? rows : (rows as { invoices?: Invoice[] }).invoices ?? [];
        // Show only invoices with a positive balance due
        const open = list.filter((inv) => Number(inv.balanceDue) > 0);
        setInvoices(open);
        setApplicationAmounts({});
      })
      .catch((err) => {
        toastError(err, 'Failed to load invoices.');
        setInvoices([]);
      })
      .finally(() => setInvoicesLoading(false));
  }, [customerId]);

  const setAppAmount = (invoiceId: string, value: string) => {
    setApplicationAmounts((prev) => ({ ...prev, [invoiceId]: value }));
  };

  const applications: Application[] = Object.entries(applicationAmounts)
    .filter(([, v]) => v && Number(v) > 0)
    .map(([invoiceId, amountApplied]) => ({ invoiceId, amountApplied }));

  const appliedTotal = sumApplications(applications);

  async function handleSubmit() {
    if (!customerId) { toast('Please select a customer.', 'danger'); return; }
    if (!date) { toast('Please enter a date.', 'danger'); return; }
    if (!amount || Number(amount) <= 0) { toast('Please enter a valid payment amount.', 'danger'); return; }

    setSaving(true);
    try {
      await api.post('/api/payments', {
        customerId,
        date,
        method,
        amount,
        reference: reference.trim() || null,
        applications,
      });
      toast('Payment recorded successfully.', 'success');
      onSaved();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to save payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title="Receive Payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            Record Payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Customer */}
        <div>
          <Label htmlFor="pm-customer" required>Customer</Label>
          <Select
            id="pm-customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            autoFocus
          >
            <option value="">— Select customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </Select>
        </div>

        {/* Date + Method row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="pm-date" required>Payment Date</Label>
            <DateInput
              id="pm-date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="pm-method">Method</Label>
            <Select
              id="pm-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="credit_card">Credit Card</option>
              <option value="ach">ACH</option>
              <option value="bank_transfer">Bank Transfer</option>
              <option value="other">Other</option>
            </Select>
          </div>
        </div>

        {/* Amount + Reference row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="pm-amount" required>Total Amount Received</Label>
            <AmountInput
              id="pm-amount"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="pm-ref">Reference / Check #</Label>
            <Input
              id="pm-ref"
              type="text"
              placeholder="Optional"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
        </div>

        {/* Open invoices */}
        {customerId && (
          <div>
            <Label>Apply to Open Invoices <Help term="ar" /></Label>
            {invoicesLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-navy/50">
                <Spinner className="h-4 w-4" /> Loading invoices…
              </div>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-navy/40 py-2 italic">
                No open invoices for this customer.
              </p>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden mt-1">
                <Table>
                  <thead>
                    <tr className="bg-slate-50">
                      <Th>Date</Th>
                      <Th numeric>Invoice Total</Th>
                      <Th numeric>Balance Due</Th>
                      <Th numeric>Amount to Apply</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <Tr key={inv.id}>
                        <Td>{formatDate(inv.date)}</Td>
                        <Td numeric>{formatCurrency(inv.total)}</Td>
                        <Td numeric className="font-semibold">
                          {formatCurrency(inv.balanceDue)}
                        </Td>
                        <Td numeric>
                          <AmountInput
                            placeholder="0.00"
                            value={applicationAmounts[inv.id] ?? ''}
                            onChange={(e) => setAppAmount(inv.id, e.target.value)}
                            className="text-right"
                          />
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}

            {/* Applied total summary */}
            {applications.length > 0 && (
              <div className="flex justify-between items-center mt-2 px-1 text-sm">
                <span className="text-navy/60">Total Applied</span>
                <span className="font-semibold text-navy tabular-nums">
                  {formatCurrency(appliedTotal)}
                </span>
              </div>
            )}
            {amount && Number(amount) > 0 && applications.length > 0 && (
              <div className="flex justify-between items-center px-1 text-sm">
                <span className="text-navy/60">Unapplied</span>
                <span
                  className={
                    'font-semibold tabular-nums ' +
                    (Number(amount) - appliedTotal > 0 ? 'text-gold' : 'text-emerald')
                  }
                >
                  {formatCurrency(Number(amount) - appliedTotal)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Apply Unapplied Modal — apply an overpaid/unapplied balance to open invoices
// ---------------------------------------------------------------------------

interface ApplyUnappliedModalProps {
  open: boolean;
  payment: Payment | null;
  onClose: () => void;
  onApplied: () => void;
}

function ApplyUnappliedModal({ open, payment, onClose, onApplied }: ApplyUnappliedModalProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !payment) return;
    setAmounts({});
    setLoading(true);
    api
      .get<{ invoices?: Invoice[] } | Invoice[]>(`/api/invoices?customerId=${payment.customerId}`)
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : (rows as { invoices?: Invoice[] }).invoices ?? [];
        setInvoices(list.filter((inv) => inv.status !== 'void' && Number(inv.balanceDue) > 0));
      })
      .catch(() => toast('Failed to load invoices.', 'danger'))
      .finally(() => setLoading(false));
  }, [open, payment]);

  const applications: Application[] = Object.entries(amounts)
    .filter(([, v]) => v && Number(v) > 0)
    .map(([invoiceId, amountApplied]) => ({ invoiceId, amountApplied }));
  const appliedTotal = sumApplications(applications);
  const unapplied = Number(payment?.unapplied ?? 0);

  async function handleApply() {
    if (!payment) return;
    if (applications.length === 0) { toast('Enter an amount to apply.', 'danger'); return; }
    if (appliedTotal > unapplied + 0.005) {
      toast('Total applied exceeds the unapplied balance.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post(`/api/payments/${payment.id}`, { action: 'apply', applications });
      toast('Unapplied balance applied to invoices.', 'success');
      onApplied();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to apply payment.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      size="lg"
      open={open}
      onClose={onClose}
      title="Apply Unapplied Balance"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleApply} loading={saving} disabled={loading}>
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {payment && (
          <div className="rounded-lg bg-navy/5 px-4 py-3 text-sm">
            <span className="text-navy/60">Unapplied balance: </span>
            <span className="font-bold text-navy tabular-nums">
              {formatCurrency(payment.unapplied)}
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-navy/40">
            <Spinner className="h-4 w-4" /> Loading invoices…
          </div>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-navy/40 py-2 italic">No open invoices for this customer.</p>
        ) : (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <Table>
              <thead>
                <tr className="bg-slate-50">
                  <Th>Date</Th>
                  <Th numeric>Balance Due</Th>
                  <Th numeric>Amount to Apply</Th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <Tr key={inv.id}>
                    <Td>{formatDate(inv.date)}</Td>
                    <Td numeric className="font-semibold">
                      {formatCurrency(inv.balanceDue)}
                    </Td>
                    <Td numeric>
                      <AmountInput
                        placeholder="0.00"
                        value={amounts[inv.id] ?? ''}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [inv.id]: e.target.value }))
                        }
                        className="text-right"
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {applications.length > 0 && (
          <div className="flex justify-between items-center px-1 text-sm">
            <span className="text-navy/60">Total to apply</span>
            <span
              className={
                'font-semibold tabular-nums ' +
                (appliedTotal > unapplied ? 'text-red-500' : 'text-navy')
              }
            >
              {formatCurrency(appliedTotal)}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Refund Modal — refund an unapplied balance back to the customer
// ---------------------------------------------------------------------------

interface RefundPaymentModalProps {
  open: boolean;
  payment: Payment | null;
  accounts: Account[];
  onClose: () => void;
  onRefunded: () => void;
}

function RefundPaymentModal({ open, payment, accounts, onClose, onRefunded }: RefundPaymentModalProps) {
  const [bankAccountId, setBankAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && payment) {
      setBankAccountId('');
      setAmount(Number(payment.unapplied).toFixed(2));
    }
  }, [open, payment]);

  const bankAccounts = accounts.filter((a) => a.type === 'asset');

  async function handleRefund() {
    if (!payment) return;
    if (!bankAccountId) { toast('Select a bank account.', 'danger'); return; }
    if (!amount || Number(amount) <= 0) { toast('Enter a valid refund amount.', 'danger'); return; }
    setSaving(true);
    try {
      await api.post(`/api/payments/${payment.id}`, {
        action: 'refund',
        bankAccountId,
        amount,
      });
      toast('Refund recorded.', 'success');
      onRefunded();
      onClose();
    } catch (err: unknown) {
      toastError(err, 'Failed to record refund.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refund Unapplied Payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleRefund} loading={saving}>
            Record Refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {payment && (
          <div className="rounded-lg bg-gold/10 border border-gold/30 px-4 py-3 text-sm text-navy/80">
            Unapplied balance available to refund:{' '}
            <span className="font-bold">{formatCurrency(payment.unapplied)}</span>
          </div>
        )}

        <div>
          <Label htmlFor="rf-bank" required>Refund From (Bank Account)</Label>
          <Select
            id="rf-bank"
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            autoFocus
          >
            <option value="">Select a bank account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="rf-amount" required>Refund Amount</Label>
          <AmountInput
            id="rf-amount"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

function PaymentsPageContent() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [customerMap, setCustomerMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const [applyTarget, setApplyTarget] = useState<Payment | null>(null);
  const [refundTarget, setRefundTarget] = useState<Payment | null>(null);
  const [voidTarget, setVoidTarget] = useState<Payment | null>(null);
  const [voiding, setVoiding] = useState(false);

  const fetchPayments = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ payments: Payment[] } | Payment[]>('/api/payments');
      const list = Array.isArray(data) ? data : (data as { payments: Payment[] }).payments ?? [];
      setPayments(list);
    } catch (err: unknown) {
      toastError(err, 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCustomers = useCallback(async () => {
    try {
      const list = await api.get<Customer[]>('/api/customers');
      const arr = Array.isArray(list) ? list : [];
      setCustomers(arr);
      const map: Record<string, string> = {};
      arr.forEach((c) => { map[c.id] = c.displayName; });
      setCustomerMap(map);
    } catch {
      // Non-fatal; customer names will fall back to IDs.
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const list = await api.get<Account[]>('/api/accounts');
      setAccounts(Array.isArray(list) ? list : []);
    } catch {
      // Non-fatal; refund modal will show an empty account list.
    }
  }, []);

  useEffect(() => {
    fetchPayments();
    fetchCustomers();
    fetchAccounts();
  }, [fetchPayments, fetchCustomers, fetchAccounts]);

  // Quick Actions navigate here with ?new=1 — open the Receive Payment modal.
  useNewParam(() => setModalOpen(true));

  async function handleVoid() {
    if (!voidTarget) return;
    setVoiding(true);
    try {
      await api.del(`/api/payments/${voidTarget.id}`);
      toast('Payment voided.', 'success');
      setVoidTarget(null);
      fetchPayments();
    } catch (err: unknown) {
      toastError(err, 'Failed to void payment.');
    } finally {
      setVoiding(false);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Receive Payments"
        icon={HandCoins}
        action={
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4" />
            Receive Payment
          </Button>
        }
      />

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-navy/40">
            <Spinner className="h-6 w-6" />
          </div>
        ) : payments.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="No payments recorded yet"
            message="When a customer pays an invoice, record it here. The money waits in Undeposited Funds until you record the bank deposit."
            action={
              <Button onClick={() => setModalOpen(true)}>
                <Plus className="h-4 w-4" /> Receive Payment
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Method</Th>
                <Th>Reference</Th>
                <Th numeric>Amount</Th>
                <Th numeric>Unapplied</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <Tr key={p.id} className={p.voidedAt ? 'opacity-50' : undefined}>
                  <Td className="whitespace-nowrap text-navy/70">{formatDate(p.date)}</Td>
                  <Td className="font-medium text-navy">
                    {customerMap[p.customerId] ?? '—'}
                  </Td>
                  <Td>
                    <Badge tone={methodBadgeTone(p.method)}>
                      {METHOD_LABELS[p.method] ?? p.method}
                    </Badge>
                  </Td>
                  <Td className="text-navy/60 text-sm">{p.reference ?? '—'}</Td>
                  <Td numeric className="font-semibold">
                    {formatCurrency(p.amount)}
                  </Td>
                  <Td numeric>
                    {Number(p.unapplied) > 0 ? (
                      <span className="text-gold font-medium">
                        {formatCurrency(p.unapplied)}
                      </span>
                    ) : (
                      <span className="text-emerald font-medium">
                        {formatCurrency(p.unapplied)}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {p.voidedAt ? (
                      <Badge tone="neutral">Void</Badge>
                    ) : (
                      <Badge tone="success">Posted</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    {!p.voidedAt && (
                      <span className="inline-flex items-center gap-1">
                        {Number(p.unapplied) > 0 && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setApplyTarget(p)}
                              title="Apply unapplied balance to open invoices"
                            >
                              Apply
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRefundTarget(p)}
                              title="Refund unapplied balance to the customer"
                            >
                              Refund
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setVoidTarget(p)}
                          className="text-red-500 hover:bg-red-50"
                          title="Void this payment"
                        >
                          Void
                        </Button>
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ReceivePaymentModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={fetchPayments}
        customers={customers}
      />

      <ApplyUnappliedModal
        open={!!applyTarget}
        payment={applyTarget}
        onClose={() => setApplyTarget(null)}
        onApplied={fetchPayments}
      />

      <RefundPaymentModal
        open={!!refundTarget}
        payment={refundTarget}
        accounts={accounts}
        onClose={() => setRefundTarget(null)}
        onRefunded={fetchPayments}
      />

      <ConfirmDialog
        open={!!voidTarget}
        title="Void Payment"
        message={
          <>
            Are you sure you want to void the{' '}
            <strong>{formatCurrency(voidTarget?.amount ?? '0')}</strong> payment from{' '}
            <strong>
              {voidTarget ? customerMap[voidTarget.customerId] ?? 'this customer' : ''}
            </strong>
            ? This reverses the journal entry and restores the balance due on every invoice it was
            applied to. This cannot be undone.
          </>
        }
        confirmLabel="Void Payment"
        tone="danger"
        loading={voiding}
        onConfirm={handleVoid}
        onClose={() => setVoidTarget(null)}
      />
    </main>
  );
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={null}>
      <PaymentsPageContent />
    </Suspense>
  );
}
