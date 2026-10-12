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
  /** wave2 sales (F2): set when the check bounced. */
  bouncedAt?: string | null;
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
  invoiceNumber?: number;
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
// Receive Payment Modal (new + edit) — cash, early-payment discounts, credits
// ---------------------------------------------------------------------------

interface PaymentDetail extends Payment {
  depositAccountId: string | null;
  discountAccountId: string | null;
  memo: string | null;
  applications: Array<{ invoiceId: string; amountApplied: string; discountAmount: string }>;
  credits: Array<{ id: string; creditMemoId: string; invoiceId: string; amount: string }>;
}

interface AvailableCredit {
  kind: 'credit_memo' | 'payment';
  id: string;
  ref: string;
  date: string;
  available: string;
}

interface DiscountSuggestion {
  invoiceId: string;
  eligible: boolean;
  suggested: string;
  discountDate: string | null;
}

interface ReceivePaymentModalProps {
  open: boolean;
  /** wave2 sales (C1): payment being edited (null = new). */
  editing?: PaymentDetail | null;
  onClose: () => void;
  onSaved: () => void;
  customers: Customer[];
  accounts: Account[];
}

function ReceivePaymentModal({ open, editing, onClose, onSaved, customers, accounts }: ReceivePaymentModalProps) {
  const today = new Date().toISOString().slice(0, 10);

  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState<string>('check');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [discountAccountId, setDiscountAccountId] = useState('');

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  // invoiceId -> cash / discount
  const [applicationAmounts, setApplicationAmounts] = useState<Record<string, string>>({});
  const [discountAmounts, setDiscountAmounts] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, DiscountSuggestion>>({});
  // credit memo id -> { invoiceId, amount }
  const [credits, setCredits] = useState<AvailableCredit[]>([]);
  const [creditUse, setCreditUse] = useState<Record<string, { invoiceId: string; amount: string }>>({});

  const [saving, setSaving] = useState(false);

  const depositAccounts = accounts.filter((a) => a.type === 'asset' && a.code !== '1200');
  const discountAccounts = accounts.filter((a) => a.type === 'revenue' || a.type === 'expense');

  // Reset / prefill when the modal opens.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setCustomerId(editing.customerId);
      setDate(editing.date.slice(0, 10));
      setMethod(editing.method);
      setAmount(String(Number(editing.amount)));
      setReference(editing.reference ?? '');
      setMemo(editing.memo ?? '');
      setDepositAccountId(editing.depositAccountId ?? '');
      setDiscountAccountId(editing.discountAccountId ?? '');
    } else {
      setCustomerId('');
      setDate(today);
      setMethod('check');
      setAmount('');
      setReference('');
      setMemo('');
      setDepositAccountId('');
      setDiscountAccountId('');
    }
    setInvoices([]);
    setApplicationAmounts({});
    setDiscountAmounts({});
    setCredits([]);
    setCreditUse({});
  }, [open, editing, today]);

  // Fetch open invoices + available credits when the customer changes.
  useEffect(() => {
    if (!open || !customerId) {
      setInvoices([]);
      setCredits([]);
      return;
    }
    setInvoicesLoading(true);
    const mine = editing && editing.customerId === customerId ? editing : null;
    Promise.all([
      api.get<Invoice[] | { invoices?: Invoice[] }>(`/api/invoices?customerId=${customerId}`),
      api.get<{ credits: AvailableCredit[] }>(`/api/payments/credits?customerId=${customerId}`),
    ])
      .then(([rows, cred]) => {
        const list = Array.isArray(rows) ? rows : (rows.invoices ?? []);
        // While editing, this payment's own applications are handed back to each invoice.
        const giveBack = new Map<string, number>();
        for (const a of mine?.applications ?? []) {
          giveBack.set(a.invoiceId, (giveBack.get(a.invoiceId) ?? 0) + Number(a.amountApplied) + Number(a.discountAmount ?? 0));
        }
        for (const c of mine?.credits ?? []) {
          giveBack.set(c.invoiceId, (giveBack.get(c.invoiceId) ?? 0) + Number(c.amount));
        }
        const open = list
          .map((inv) => ({ ...inv, balanceDue: (Number(inv.balanceDue) + (giveBack.get(inv.id) ?? 0)).toFixed(2) }))
          .filter((inv) => inv.status !== 'void' && inv.status !== 'draft' && Number(inv.balanceDue) > 0);
        setInvoices(open);
        // Earlier unapplied payments can be used on a NEW payment only (not while editing).
        const memoCredits = (cred.credits ?? []).filter((c) => c.kind === 'credit_memo' || (!mine && c.kind === 'payment'));
        // Add back credit used by this payment so it can be re-applied when editing.
        const usedByMe = new Map<string, number>();
        for (const c of mine?.credits ?? []) usedByMe.set(c.creditMemoId, (usedByMe.get(c.creditMemoId) ?? 0) + Number(c.amount));
        const merged = memoCredits.map((c) => ({ ...c, available: (Number(c.available) + (usedByMe.get(c.id) ?? 0)).toFixed(2) }));
        for (const [id, amt] of usedByMe) {
          if (!merged.some((c) => c.id === id)) merged.push({ kind: 'credit_memo', id, ref: 'Credit memo', date: '', available: amt.toFixed(2) });
        }
        setCredits(merged);
        if (mine) {
          setApplicationAmounts(Object.fromEntries(mine.applications.filter((a) => Number(a.amountApplied) > 0).map((a) => [a.invoiceId, String(Number(a.amountApplied))])));
          setDiscountAmounts(Object.fromEntries(mine.applications.filter((a) => Number(a.discountAmount) > 0).map((a) => [a.invoiceId, String(Number(a.discountAmount))])));
          setCreditUse(Object.fromEntries(mine.credits.map((c) => [c.creditMemoId, { invoiceId: c.invoiceId, amount: String(Number(c.amount)) }])));
        } else {
          setApplicationAmounts({});
          setDiscountAmounts({});
          setCreditUse({});
        }
      })
      .catch((err) => {
        toastError(err, 'Failed to load invoices.');
        setInvoices([]);
      })
      .finally(() => setInvoicesLoading(false));
  }, [open, customerId, editing]);

  // Early-payment discount suggestions from the customer's terms, for the payment date.
  useEffect(() => {
    if (!open || !customerId || !date) {
      setSuggestions({});
      return;
    }
    api
      .get<{ discounts: DiscountSuggestion[] }>(`/api/payments/discounts?customerId=${customerId}&date=${date}`)
      .then((r) => setSuggestions(Object.fromEntries((r.discounts ?? []).map((d) => [d.invoiceId, d]))))
      .catch(() => setSuggestions({}));
  }, [open, customerId, date]);

  const applications = invoices
    .map((inv) => ({
      invoiceId: inv.id,
      amountApplied: applicationAmounts[inv.id] && Number(applicationAmounts[inv.id]) > 0 ? applicationAmounts[inv.id] : '0',
      discountAmount: discountAmounts[inv.id] && Number(discountAmounts[inv.id]) > 0 ? discountAmounts[inv.id] : null,
    }))
    .filter((a) => Number(a.amountApplied) > 0 || Number(a.discountAmount ?? 0) > 0);
  const paymentCreditIds = new Set(credits.filter((c) => c.kind === 'payment').map((c) => c.id));
  const usedCredits = Object.entries(creditUse).filter(([, u]) => u.invoiceId && Number(u.amount) > 0);
  const creditApps = usedCredits
    .filter(([id]) => !paymentCreditIds.has(id))
    .map(([creditMemoId, u]) => ({ creditMemoId, invoiceId: u.invoiceId, amount: u.amount }));
  const paymentCreditApps = usedCredits
    .filter(([id]) => paymentCreditIds.has(id))
    .map(([paymentId, u]) => ({ paymentId, invoiceId: u.invoiceId, amount: u.amount }));
  const allCreditApps = [...creditApps, ...paymentCreditApps];

  const appliedTotal = applications.reduce((s, a) => s + Number(a.amountApplied), 0);
  const discountTotal = applications.reduce((s, a) => s + Number(a.discountAmount ?? 0), 0);
  const creditTotal = allCreditApps.reduce((s, c) => s + Number(c.amount), 0);
  const anyDiscount = discountTotal > 0;

  /** "Pay in full": fill cash for every invoice up to its balance (after discount/credits). */
  function payAll() {
    const next: Record<string, string> = {};
    let left = Number(amount) || 0;
    for (const inv of invoices) {
      const credit = allCreditApps.filter((c) => c.invoiceId === inv.id).reduce((s, c) => s + Number(c.amount), 0);
      const due = Math.max(0, Number(inv.balanceDue) - Number(discountAmounts[inv.id] || 0) - credit);
      const take = amount ? Math.min(due, left) : due;
      if (take > 0) next[inv.id] = take.toFixed(2);
      left -= take;
    }
    setApplicationAmounts(next);
    if (!amount) setAmount(Object.values(next).reduce((s, v) => s + Number(v), 0).toFixed(2));
  }

  async function handleSubmit() {
    if (!customerId) { toast('Please select a customer.', 'danger'); return; }
    if (!date) { toast('Please enter a date.', 'danger'); return; }
    const amt = Number(amount || 0);
    if (amt < 0) { toast('The amount received cannot be negative.', 'danger'); return; }
    if (amt === 0 && creditTotal === 0 && discountTotal === 0) {
      toast('Enter the amount received, or apply a credit or discount.', 'danger');
      return;
    }
    if (appliedTotal > amt + 0.005) {
      toast('You applied more cash than you received. Lower an amount or raise the total.', 'danger');
      return;
    }
    for (const inv of invoices) {
      const cash = Number(applicationAmounts[inv.id] || 0);
      const disc = Number(discountAmounts[inv.id] || 0);
      const cred = allCreditApps.filter((c) => c.invoiceId === inv.id).reduce((s, c) => s + Number(c.amount), 0);
      if (cash + disc + cred > Number(inv.balanceDue) + 0.005) {
        toast(`Invoice #${inv.invoiceNumber ?? ''}: cash, discount and credits add up to more than it owes.`, 'danger');
        return;
      }
    }

    const body = {
      customerId,
      date,
      method,
      amount: amt.toFixed(2),
      reference: reference.trim() || null,
      memo: memo.trim() || null,
      depositAccountId: depositAccountId || null,
      discountAccountId: anyDiscount && discountAccountId ? discountAccountId : null,
      applications,
      credits: creditApps,
      ...(editing ? {} : { paymentCredits: paymentCreditApps }),
    };
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/api/payments/${editing.id}`, body);
        toast('Payment updated.', 'success');
      } else {
        await api.post('/api/payments', body);
        toast('Payment recorded successfully.', 'success');
      }
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
      size="xl"
      open={open}
      onClose={onClose}
      title={editing ? 'Edit Payment' : 'Receive Payment'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            {editing ? 'Save Changes' : 'Record Payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {editing && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            Saving changes re-posts this payment so your books stay balanced. Invoices get their old
            amounts back first, then the new amounts are applied.
          </div>
        )}
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

        {/* Date + Method + Deposit-to */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="pm-date" required>Payment Date</Label>
            <DateInput id="pm-date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pm-method">Method</Label>
            <Select id="pm-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="credit_card">Credit Card</option>
              <option value="ach">ACH</option>
              <option value="bank_transfer">Bank Transfer</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pm-deposit">Deposit to <Help term="undeposited-funds" /></Label>
            <Select id="pm-deposit" value={depositAccountId} onChange={(e) => setDepositAccountId(e.target.value)}>
              <option value="">Undeposited Funds (deposit later)</option>
              {depositAccounts
                .filter((a) => a.code !== '1050')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
            </Select>
          </div>
        </div>

        {/* Amount + Reference + Memo */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="pm-amount" required>Amount Received</Label>
            <AmountInput id="pm-amount" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pm-ref">Reference / Check #</Label>
            <Input id="pm-ref" type="text" placeholder="Optional" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pm-memo">Memo</Label>
            <Input id="pm-memo" type="text" placeholder="Optional" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>

        {/* Open invoices */}
        {customerId && (
          <div>
            <div className="flex items-center justify-between">
              <Label>Apply to Open Invoices <Help term="ar" /></Label>
              {invoices.length > 0 && (
                <Button variant="ghost" size="sm" onClick={payAll}>
                  Pay all
                </Button>
              )}
            </div>
            {invoicesLoading ? (
              <div className="flex items-center gap-2 py-2 text-sm text-navy/50">
                <Spinner className="h-4 w-4" /> Loading invoices…
              </div>
            ) : invoices.length === 0 ? (
              <p className="text-sm text-navy/40 py-2 italic">No open invoices for this customer.</p>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden mt-1">
                <Table>
                  <thead>
                    <tr className="bg-slate-50">
                      <Th>Invoice</Th>
                      <Th>Date</Th>
                      <Th numeric>Balance Due</Th>
                      <Th numeric>Early-pay discount <Help term="early-payment-discount" side="bottom" /></Th>
                      <Th numeric>Payment</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => {
                      const sug = suggestions[inv.id];
                      return (
                        <Tr key={inv.id}>
                          <Td className="font-medium">#{inv.invoiceNumber ?? ''}</Td>
                          <Td>{formatDate(inv.date)}</Td>
                          <Td numeric className="font-semibold">{formatCurrency(inv.balanceDue)}</Td>
                          <Td numeric>
                            <AmountInput
                              placeholder="0.00"
                              aria-label={`Discount for invoice ${inv.invoiceNumber ?? ''}`}
                              value={discountAmounts[inv.id] ?? ''}
                              onChange={(e) => setDiscountAmounts((p) => ({ ...p, [inv.id]: e.target.value }))}
                              className="text-right"
                            />
                            {sug?.eligible && Number(sug.suggested) > 0 && !discountAmounts[inv.id] && (
                              <button
                                type="button"
                                className="mt-1 text-xs text-electric hover:underline"
                                onClick={() => setDiscountAmounts((p) => ({ ...p, [inv.id]: sug.suggested }))}
                              >
                                Take {formatCurrency(sug.suggested)} (paid by {formatDate(sug.discountDate)})
                              </button>
                            )}
                          </Td>
                          <Td numeric>
                            <AmountInput
                              placeholder="0.00"
                              aria-label={`Payment for invoice ${inv.invoiceNumber ?? ''}`}
                              value={applicationAmounts[inv.id] ?? ''}
                              onChange={(e) => setApplicationAmounts((p) => ({ ...p, [inv.id]: e.target.value }))}
                              className="text-right"
                            />
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}

            {anyDiscount && (
              <div className="mt-2 grid grid-cols-2 gap-3 items-end">
                <div>
                  <Label htmlFor="pm-disc-acct">Discount account</Label>
                  <Select id="pm-disc-acct" value={discountAccountId} onChange={(e) => setDiscountAccountId(e.target.value)}>
                    <option value="">Sales Discounts (created if needed)</option>
                    {discountAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <p className="text-xs text-navy/50">
                  A discount reduces what the customer owes without any money changing hands.
                </p>
              </div>
            )}

            {/* Credits (credit memos) */}
            {credits.length > 0 && invoices.length > 0 && (
              <div className="mt-4">
                <Label>Use available credits</Label>
                <div className="border border-slate-200 rounded-lg overflow-hidden mt-1">
                  <Table>
                    <thead>
                      <tr className="bg-slate-50">
                        <Th>Credit</Th>
                        <Th numeric>Available</Th>
                        <Th>Apply to</Th>
                        <Th numeric>Amount</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {credits.map((c) => {
                        const use = creditUse[c.id] ?? { invoiceId: '', amount: '' };
                        return (
                          <Tr key={c.id}>
                            <Td>{c.ref}</Td>
                            <Td numeric>{formatCurrency(c.available)}</Td>
                            <Td>
                              <Select
                                aria-label={`Invoice for ${c.ref}`}
                                value={use.invoiceId}
                                onChange={(e) => setCreditUse((p) => ({ ...p, [c.id]: { ...use, invoiceId: e.target.value } }))}
                              >
                                <option value="">Don&apos;t use</option>
                                {invoices.map((inv) => (
                                  <option key={inv.id} value={inv.id}>
                                    Invoice #{inv.invoiceNumber ?? ''} ({formatCurrency(inv.balanceDue)})
                                  </option>
                                ))}
                              </Select>
                            </Td>
                            <Td numeric>
                              <AmountInput
                                placeholder="0.00"
                                aria-label={`Amount of ${c.ref}`}
                                value={use.amount}
                                onChange={(e) => setCreditUse((p) => ({ ...p, [c.id]: { ...use, amount: e.target.value } }))}
                                className="text-right"
                              />
                            </Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              </div>
            )}

            {/* Totals */}
            <div className="mt-3 space-y-1 px-1 text-sm">
              <div className="flex justify-between"><span className="text-navy/60">Payment applied</span><span className="font-semibold tabular-nums">{formatCurrency(appliedTotal)}</span></div>
              {discountTotal > 0 && (
                <div className="flex justify-between"><span className="text-navy/60">Discounts</span><span className="font-semibold tabular-nums">{formatCurrency(discountTotal)}</span></div>
              )}
              {creditTotal > 0 && (
                <div className="flex justify-between"><span className="text-navy/60">Credits used</span><span className="font-semibold tabular-nums">{formatCurrency(creditTotal)}</span></div>
              )}
              {Number(amount) > 0 && (
                <div className="flex justify-between">
                  <span className="text-navy/60">Left over (kept as a credit for this customer)</span>
                  <span className={'font-semibold tabular-nums ' + (Number(amount) - appliedTotal > 0.005 ? 'text-gold' : 'text-emerald')}>
                    {formatCurrency(Math.max(0, Number(amount) - appliedTotal))}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Record Bounced Check (wave2 sales F2)
// ---------------------------------------------------------------------------

function BouncedCheckModal({
  payment,
  accounts,
  customerName,
  onClose,
  onDone,
}: {
  payment: Payment | null;
  accounts: Account[];
  customerName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [bankFee, setBankFee] = useState('');
  const [bankFeeAccountId, setBankFeeAccountId] = useState('');
  const [customerFee, setCustomerFee] = useState('');
  const [customerFeeAccountId, setCustomerFeeAccountId] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!payment) return;
    setDate(new Date().toISOString().slice(0, 10));
    setBankFee('');
    setBankFeeAccountId('');
    setCustomerFee('');
    setCustomerFeeAccountId('');
  }, [payment]);
  async function submit() {
    if (!payment) return;
    setSaving(true);
    try {
      await api.post(`/api/payments/${payment.id}`, {
        action: 'bounce',
        date,
        bankFee: bankFee || null,
        bankFeeAccountId: bankFeeAccountId || null,
        customerFee: customerFee || null,
        customerFeeAccountId: customerFeeAccountId || null,
      });
      toast('Bounced check recorded. The invoices it paid are open again.', 'success');
      onDone();
      onClose();
    } catch (err) {
      toastError(err, 'Could not record the bounced check.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      open={!!payment}
      onClose={onClose}
      title="Record Bounced Check"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="danger" loading={saving} onClick={submit}>Record bounced check</Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-navy/70">
          The bank returned the <strong>{formatCurrency(payment?.amount ?? '0')}</strong> payment from{' '}
          <strong>{customerName}</strong>. We&apos;ll take the money back out of your bank account and
          reopen the invoices it paid, so the customer owes them again. <Help term="bounced-check" side="bottom" />
        </p>
        <div>
          <Label htmlFor="nsf-date">Date the bank returned it</Label>
          <DateInput id="nsf-date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="nsf-bank-fee">Fee your bank charged you</Label>
            <AmountInput id="nsf-bank-fee" placeholder="0.00" value={bankFee} onChange={(e) => setBankFee(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nsf-bank-acct">Expense account for that fee</Label>
            <Select id="nsf-bank-acct" value={bankFeeAccountId} onChange={(e) => setBankFeeAccountId(e.target.value)}>
              <option value="">Bank &amp; Merchant Fees</option>
              {accounts.filter((a) => a.type === 'expense').map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="nsf-cust-fee">Fee to charge the customer</Label>
            <AmountInput id="nsf-cust-fee" placeholder="0.00" value={customerFee} onChange={(e) => setCustomerFee(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="nsf-cust-acct">Income account for that fee</Label>
            <Select id="nsf-cust-acct" value={customerFeeAccountId} onChange={(e) => setCustomerFeeAccountId(e.target.value)}>
              <option value="">Other Income</option>
              {accounts.filter((a) => a.type === 'revenue').map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </Select>
          </div>
        </div>
        <p className="text-xs text-navy/50">A customer fee is added as a new invoice to this customer.</p>
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
  const [editTarget, setEditTarget] = useState<PaymentDetail | null>(null);
  const [bounceTarget, setBounceTarget] = useState<Payment | null>(null);

  async function openEdit(p: Payment) {
    try {
      setEditTarget(await api.get<PaymentDetail>(`/api/payments/${p.id}`));
    } catch (err: unknown) {
      toastError(err, 'Could not open the payment.');
    }
  }

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
                    ) : p.bouncedAt ? (
                      <Badge tone="danger">Bounced</Badge>
                    ) : (
                      <Badge tone="success">Posted</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    {!p.voidedAt && !p.bouncedAt && (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(p)} title="Edit this payment">
                          Edit
                        </Button>
                        {Number(p.amount) > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setBounceTarget(p)}
                            title="The bank returned this check (NSF)"
                          >
                            Bounced
                          </Button>
                        )}
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
        open={modalOpen || !!editTarget}
        editing={editTarget}
        onClose={() => {
          setModalOpen(false);
          setEditTarget(null);
        }}
        onSaved={fetchPayments}
        customers={customers}
        accounts={accounts}
      />

      <BouncedCheckModal
        payment={bounceTarget}
        accounts={accounts}
        customerName={bounceTarget ? customerMap[bounceTarget.customerId] ?? 'this customer' : ''}
        onClose={() => setBounceTarget(null)}
        onDone={fetchPayments}
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
