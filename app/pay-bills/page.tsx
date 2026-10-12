'use client';

/**
 * Pay Bills — QB-style batch bill-payment screen.
 *
 * Select a vendor, check off open bills, optionally short-pay (partial amount),
 * apply available vendor credits per bill, and take early-payment discounts.
 * Cash goes out of the chosen payment account; discounts post to the chosen
 * discount account; credits draw down the vendor's open credits.
 *
 * wave2 purchases: due dates and discount suggestions come from the bill's terms
 * (/api/bills/to-pay), with "due on or before" and "discount available" filters; check
 * payments can be queued "To be printed"; foreign-currency bills take an exchange rate;
 * duplicate check numbers are warned about; recent payments can be edited or voided.
 */
import { isPaymentSourceAccount } from '@/lib/accountTypes';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { HandCoins, Pencil, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast, toastError,
} from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { describeError } from '@/lib/friendlyErrors';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor {
  id: string;
  displayName: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

interface Bill {
  id: string;
  vendorId: string;
  billNumber: string | null;
  date: string;
  dueDate: string | null;
  total: string;
  balanceDue: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  terms?: string | null;
  currency?: string | null;
  discountDate?: string | null;
  discountPercent?: number;
  suggestedDiscount?: string;
  discountAvailable?: boolean;
  overdue?: boolean;
}

interface BillPayment {
  id: string;
  date: string;
  method: string;
  reference: string | null;
  amount: string;
  paymentAccountId: string | null;
  toPrint: boolean;
  voidedAt: string | null;
  currency?: string | null;
  exchangeRate?: string | null;
}

interface PaymentDetail extends BillPayment {
  applications: Array<{ billId: string; amountApplied: string }>;
  discountTotal: string;
}

interface VendorCredit {
  id: string;
  vendorId: string;
  status: string;
  total: string;
  unapplied: string;
}

interface RowState {
  checked: boolean;
  /** Cash to pay from the payment account. */
  payAmount: string;
  /** Early-payment discount taken. */
  discount: string;
  /** Vendor credit to apply against this bill. */
  credit: string;
}

function emptyRow(): RowState {
  return { checked: false, payAmount: '', discount: '', credit: '' };
}

const num = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PayBillsPage() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [bills, setBills] = useState<Bill[]>([]);
  const [credits, setCredits] = useState<VendorCredit[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loadingBills, setLoadingBills] = useState(false);

  // Payment header
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [discountAccountId, setDiscountAccountId] = useState('');
  const [method, setMethod] = useState('check');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [toPrint, setToPrint] = useState(false);
  const [exchangeRate, setExchangeRate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Filters (QB "Show bills due on or before" / discount available)
  const [dueFilterOn, setDueFilterOn] = useState(false);
  const [dueOnOrBefore, setDueOnOrBefore] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 10);
    return d.toISOString().slice(0, 10);
  });
  const [discountOnly, setDiscountOnly] = useState(false);

  // Recent payments (edit / void)
  const [payments, setPayments] = useState<BillPayment[]>([]);
  const [editPay, setEditPay] = useState<PaymentDetail | null>(null);
  const [editAmounts, setEditAmounts] = useState<Record<string, string>>({});
  const [editDate, setEditDate] = useState('');
  const [editRef, setEditRef] = useState('');
  const [editAccount, setEditAccount] = useState('');
  const [editBills, setEditBills] = useState<Record<string, { billNumber: string | null; balanceDue: string }>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [pendingVoid, setPendingVoid] = useState<BillPayment | null>(null);

  // ── data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      try {
        const [vendorData, accountData] = await Promise.all([
          api.get<Vendor[]>('/api/vendors'),
          api.get<Account[]>('/api/accounts'),
        ]);
        setVendors(vendorData);
        setAccounts(accountData);
      } catch (err) {
        toastError(err, 'Failed to load data');
      }
    }
    init();
  }, []);

  const loadVendorData = useCallback(async (vid: string) => {
    if (!vid) {
      setBills([]);
      setCredits([]);
      setRows({});
      return;
    }
    setLoadingBills(true);
    try {
      const qs = new URLSearchParams({ vendorId: vid, asOf: date });
      if (dueFilterOn && dueOnOrBefore) qs.set('dueOnOrBefore', dueOnOrBefore);
      if (discountOnly) qs.set('discountOnly', 'true');
      const [billData, creditData, payData] = await Promise.all([
        api.get<{ bills: Bill[] }>(`/api/bills/to-pay?${qs.toString()}`),
        api.get<VendorCredit[]>(`/api/vendor-credits?vendorId=${vid}`),
        api.get<{ payments: BillPayment[] }>(`/api/bill-payments?vendorId=${vid}&limit=10`).catch(() => ({ payments: [] })),
      ]);
      setPayments(payData.payments.filter((p) => !p.voidedAt));
      const open = billData.bills.filter(
        (b) => (b.status === 'open' || b.status === 'partial') && Number(b.balanceDue) > 0,
      );
      setBills(open);
      setCredits(creditData.filter((c) => c.status !== 'void' && Number(c.unapplied) > 0));
      setRows(Object.fromEntries(open.map((b) => [b.id, emptyRow()])));
    } catch (err) {
      toastError(err, 'Failed to load vendor bills');
    } finally {
      setLoadingBills(false);
    }
  }, [date, dueFilterOn, dueOnOrBefore, discountOnly]);

  useEffect(() => {
    loadVendorData(vendorId);
  }, [vendorId, loadVendorData]);

  const billCurrency = bills.find((b) => b.currency)?.currency ?? null;

  // ── derived ───────────────────────────────────────────────────────────────

  // Bills are paid from a Bank or Credit Card account (lib/accountTypes.ts).
  const paymentAccounts = accounts.filter((a) => isPaymentSourceAccount(a));
  const discountAccounts = accounts.filter((a) => a.type === 'revenue' || a.type === 'expense');

  const availableCredit = credits.reduce((s, c) => s + Number(c.unapplied), 0);

  const selected = bills.filter((b) => rows[b.id]?.checked);
  const cashTotal = selected.reduce((s, b) => s + num(rows[b.id].payAmount), 0);
  const discountTotal = selected.reduce((s, b) => s + num(rows[b.id].discount), 0);
  const creditTotal = selected.reduce((s, b) => s + num(rows[b.id].credit), 0);

  const creditOverdrawn = creditTotal > availableCredit + 0.005;

  // ── row helpers ───────────────────────────────────────────────────────────

  function patchRow(billId: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [billId]: { ...(prev[billId] ?? emptyRow()), ...patch } }));
  }

  function toggleBill(bill: Bill) {
    const row = rows[bill.id] ?? emptyRow();
    if (row.checked) {
      patchRow(bill.id, emptyRow());
    } else {
      // Default: pay the full balance in cash.
      patchRow(bill.id, { checked: true, payAmount: Number(bill.balanceDue).toFixed(2) });
    }
  }

  /** Re-default the cash amount after credit/discount edits: balance - credit - discount. */
  function rebalanceCash(bill: Bill, patch: Partial<RowState>) {
    const row = { ...(rows[bill.id] ?? emptyRow()), ...patch };
    const remainder = Number(bill.balanceDue) - num(row.credit) - num(row.discount);
    patchRow(bill.id, { ...patch, payAmount: Math.max(0, remainder).toFixed(2) });
  }

  function rowError(bill: Bill): string | null {
    const row = rows[bill.id];
    if (!row?.checked) return null;
    const pay = num(row.payAmount);
    const disc = num(row.discount);
    const cred = num(row.credit);
    if (pay < 0 || disc < 0 || cred < 0) return 'Amounts cannot be negative';
    if (pay + disc + cred > Number(bill.balanceDue) + 0.005) return 'Exceeds balance due';
    if (pay === 0 && disc === 0 && cred === 0) return 'Enter an amount';
    if (disc > 0 && pay + cred === 0) return 'Discount requires a payment or credit';
    return null;
  }

  const rowErrors = selected.map((b) => rowError(b)).filter((e): e is string => e !== null);

  // ── submit ────────────────────────────────────────────────────────────────

  async function handlePay() {
    if (!vendorId) {
      toast('Select a vendor first.', 'danger');
      return;
    }
    if (selected.length === 0) {
      toast('Check at least one bill to pay.', 'danger');
      return;
    }
    if (rowErrors.length > 0) {
      toast(`Fix line errors first: ${rowErrors[0]}`, 'danger');
      return;
    }
    if (creditOverdrawn) {
      toast('Credits applied exceed the vendor’s available credit.', 'danger');
      return;
    }
    if (cashTotal > 0 && !paymentAccountId) {
      toast('Select a payment account.', 'danger');
      return;
    }
    if (discountTotal > 0 && !discountAccountId) {
      toast('Select a discount account (Discounts Taken).', 'danger');
      return;
    }
    if (cashTotal === 0 && creditTotal === 0) {
      toast('Nothing to pay — enter cash amounts or credits.', 'danger');
      return;
    }

    setSubmitting(true);
    try {
      // 1. Apply vendor credits per bill (greedy across open credits).
      const pool = credits.map((c) => ({ id: c.id, remaining: Number(c.unapplied) }));
      for (const bill of selected) {
        let toApply = num(rows[bill.id].credit);
        for (const credit of pool) {
          if (toApply <= 0) break;
          if (credit.remaining <= 0) continue;
          const amount = Math.min(toApply, credit.remaining);
          await api.post(`/api/vendor-credits/${credit.id}`, {
            action: 'apply',
            billId: bill.id,
            amount: amount.toFixed(2),
          });
          credit.remaining -= amount;
          toApply -= amount;
        }
      }

      // 2. Batch cash payment (with discounts taken) for bills with cash > 0.
      const applications = selected
        .filter((b) => num(rows[b.id].payAmount) > 0)
        .map((b) => ({
          billId: b.id,
          amountApplied: num(rows[b.id].payAmount).toFixed(2),
          discountTaken:
            num(rows[b.id].discount) > 0 ? num(rows[b.id].discount).toFixed(2) : undefined,
        }));

      if (applications.length > 0) {
        const queued = method === 'check' && toPrint;
        const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
          api.post('/api/bill-payments', {
            vendorId,
            date,
            method,
            reference: queued ? undefined : reference.trim() || undefined,
            toPrint: queued,
            paymentAccountId,
            discountAccountId: discountTotal > 0 ? discountAccountId : undefined,
            exchangeRate: billCurrency && exchangeRate.trim() ? exchangeRate.trim() : undefined,
            applications,
            allowDuplicateNumber,
          }),
        );
        if (saved === null) {
          await loadVendorData(vendorId);
          return;
        }
      }

      toast(
        applications.length > 0
          ? `Paid ${applications.length} bill${applications.length !== 1 ? 's' : ''} — ${formatCurrency(cashTotal.toFixed(2))}.`
          : 'Vendor credits applied.',
        'success',
      );
      setReference('');
      await loadVendorData(vendorId);
    } catch (err) {
      const f = describeError(err, 'Failed to pay bills.');
      toast(
        `${f.title}: ${f.message} ${f.nextStep} Note: vendor credits may already have been applied — review the refreshed balances below.`,
        'danger',
      );
      // Credits may have been applied before the failure — reload to show reality.
      await loadVendorData(vendorId);
    } finally {
      setSubmitting(false);
    }
  }

  // ── edit / void a recent payment ─────────────────────────────────────────

  async function openEditPayment(p: BillPayment) {
    try {
      const detail = await api.get<PaymentDetail>(`/api/bill-payments/${p.id}`);
      if (Number(detail.discountTotal) > 0) {
        toast('This payment took an early-payment discount. Void it and pay the bills again to change it.', 'danger');
        return;
      }
      const info: Record<string, { billNumber: string | null; balanceDue: string }> = {};
      for (const a of detail.applications) {
        const b = await api.get<{ billNumber: string | null; balanceDue: string }>(`/api/bills/${a.billId}`);
        info[a.billId] = { billNumber: b.billNumber, balanceDue: b.balanceDue };
      }
      setEditBills(info);
      setEditAmounts(Object.fromEntries(detail.applications.map((a) => [a.billId, Number(a.amountApplied).toFixed(2)])));
      setEditDate(detail.date.slice(0, 10));
      setEditRef(detail.reference ?? '');
      setEditAccount(detail.paymentAccountId ?? '');
      setEditPay(detail);
    } catch (err) {
      toastError(err, 'Failed to load the payment.');
    }
  }

  async function saveEditPayment() {
    if (!editPay) return;
    const applications = Object.entries(editAmounts)
      .filter(([, v]) => num(v) > 0)
      .map(([billId, v]) => ({ billId, amountApplied: num(v).toFixed(2) }));
    if (applications.length === 0) {
      toast('Enter an amount for at least one bill (or void the payment).', 'danger');
      return;
    }
    setSavingEdit(true);
    try {
      const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.patch(`/api/bill-payments/${editPay.id}`, {
          vendorId,
          date: editDate,
          method: editPay.method,
          reference: editPay.toPrint ? undefined : editRef.trim() || undefined,
          toPrint: editPay.toPrint,
          paymentAccountId: editAccount,
          exchangeRate: editPay.currency && editPay.exchangeRate ? editPay.exchangeRate : undefined,
          applications,
          allowDuplicateNumber,
        }),
      );
      if (saved === null) return;
      toast('Payment updated.', 'success');
      setEditPay(null);
      await loadVendorData(vendorId);
    } catch (err) {
      toastError(err, 'Failed to update the payment.');
    } finally {
      setSavingEdit(false);
    }
  }

  async function voidPayment(p: BillPayment) {
    try {
      await api.del(`/api/bill-payments/${p.id}`);
      toast('Payment voided — the bills are open again.', 'success');
      setPendingVoid(null);
      await loadVendorData(vendorId);
    } catch (err) {
      toastError(err, 'Failed to void the payment.');
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  const dueTone = useMemo(
    () => (dueDate: string | null) => {
      if (!dueDate) return 'text-navy/40';
      return new Date(dueDate) < new Date() ? 'text-red-600 font-semibold' : 'text-navy/70';
    },
    [],
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Pay Bills" icon={HandCoins} />

      {/* Vendor + payment header */}
      <Card className="mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="lg:col-span-2">
            <Label htmlFor="pb-vendor" required>Vendor <Help term="ap" side="bottom" /></Label>
            <Select id="pb-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Select vendor…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          </div>
          <div className="lg:col-span-2">
            <Label htmlFor="pb-account" required>Payment Account</Label>
            <Select
              id="pb-account"
              value={paymentAccountId}
              onChange={(e) => setPaymentAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {paymentAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="pb-method">Method</Label>
            <Select id="pb-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="check">Check</option>
              <option value="cash">Cash</option>
              <option value="credit_card">Credit Card</option>
              <option value="ach">ACH</option>
              <option value="bank_transfer">Bank Transfer</option>
              <option value="other">Other</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pb-date" required>Date</Label>
            <Input id="pb-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="lg:col-span-2">
            <Label htmlFor="pb-ref">Reference / Check #</Label>
            <Input
              id="pb-ref"
              placeholder={method === 'check' && toPrint ? 'assigned when printed' : 'e.g. 1042'}
              value={method === 'check' && toPrint ? '' : reference}
              disabled={method === 'check' && toPrint}
              onChange={(e) => setReference(e.target.value)}
            />
            {method === 'check' && (
              <label className="mt-2 flex items-center gap-2 text-sm text-navy/70 select-none">
                <input
                  type="checkbox"
                  checked={toPrint}
                  onChange={(e) => setToPrint(e.target.checked)}
                  className="h-4 w-4 accent-electric"
                />
                To be printed (number assigned in Print Checks)
              </label>
            )}
          </div>
          {billCurrency && (
            <div className="lg:col-span-2">
              <Label htmlFor="pb-fx">Exchange rate today (home per 1 {billCurrency})</Label>
              <Input
                id="pb-fx"
                inputMode="decimal"
                placeholder="Use the rate from Currencies"
                value={exchangeRate}
                onChange={(e) => setExchangeRate(e.target.value)}
              />
              <p className="mt-1 text-xs text-navy/40">
                Amounts below are in {billCurrency}. Any difference from the bill&apos;s rate is recorded as exchange gain or loss.
              </p>
            </div>
          )}
          <div className="lg:col-span-2">
            <Label htmlFor="pb-disc-acct">
              Discount Account {discountTotal > 0 ? '*' : '(for discounts taken)'}
            </Label>
            <Select
              id="pb-disc-acct"
              value={discountAccountId}
              onChange={(e) => setDiscountAccountId(e.target.value)}
            >
              <option value="">Select account…</option>
              {discountAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="lg:col-span-2 flex items-end">
            <div className="rounded-lg bg-navy/5 px-4 py-2 w-full">
              <p className="text-xs text-navy/50">Vendor credits available</p>
              <p
                className={`text-sm font-bold tabular-nums ${creditOverdrawn ? 'text-red-600' : 'text-navy'}`}
              >
                {formatCurrency(availableCredit.toFixed(2))}
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* Filters */}
      {vendorId && (
        <div className="mb-3 flex flex-wrap items-center gap-4 text-sm text-navy/70">
          <label className="flex items-center gap-2 select-none">
            <input type="checkbox" className="h-4 w-4 accent-electric" checked={dueFilterOn} onChange={(e) => setDueFilterOn(e.target.checked)} />
            Show bills due on or before
          </label>
          <Input type="date" className="w-40" value={dueOnOrBefore} disabled={!dueFilterOn} onChange={(e) => setDueOnOrBefore(e.target.value)} aria-label="Due on or before" />
          <label className="flex items-center gap-2 select-none">
            <input type="checkbox" className="h-4 w-4 accent-electric" checked={discountOnly} onChange={(e) => setDiscountOnly(e.target.checked)} />
            Only bills with an early-payment discount available
          </label>
        </div>
      )}

      {/* Open bills */}
      <Card className="p-0 overflow-hidden">
        {!vendorId ? (
          <EmptyState
            icon={HandCoins}
            title="Select a vendor"
            message="Choose a vendor above to see the bills you owe them. Only bills entered with Enter Bills appear here."
          />
        ) : loadingBills ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading open bills…
          </div>
        ) : bills.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="No open bills"
            message="Nothing is owed to this vendor. To pay for something without a bill, use Write Checks."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-10" />
                <Th>Bill #</Th>
                <Th>Due Date</Th>
                <Th numeric>Balance Due</Th>
                <Th numeric>Credit Applied</Th>
                <Th numeric>Discount Taken</Th>
                <Th numeric>Amount to Pay</Th>
                <Th>Issues</Th>
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => {
                const row = rows[bill.id] ?? emptyRow();
                const err = rowError(bill);
                return (
                  <Tr key={bill.id} className={row.checked ? 'bg-electric/5' : undefined}>
                    <Td>
                      <input
                        type="checkbox"
                        checked={row.checked}
                        onChange={() => toggleBill(bill)}
                        className="accent-electric"
                        aria-label={`Select bill ${bill.billNumber ?? bill.id}`}
                      />
                    </Td>
                    <Td className="font-mono text-sm">
                      {bill.billNumber ?? <span className="text-navy/30 italic">—</span>}
                      {bill.status === 'partial' && (
                        <span className="ml-2">
                          <Badge tone="warning">Partial</Badge>
                        </span>
                      )}
                    </Td>
                    <Td className={dueTone(bill.dueDate)}>
                      {bill.dueDate ? formatDate(bill.dueDate, 'MMM d, yyyy') : '—'}
                      {bill.discountAvailable && (
                        <div className="text-xs font-normal text-emerald-700">
                          {bill.discountPercent}% off until{' '}
                          {bill.discountDate ? formatDate(bill.discountDate, 'MMM d') : ''}{' '}
                          <button
                            type="button"
                            className="underline"
                            onClick={() => {
                              if (!row.checked) patchRow(bill.id, { checked: true });
                              rebalanceCash(bill, { checked: true, discount: bill.suggestedDiscount ?? '' });
                            }}
                          >
                            take {formatCurrency(bill.suggestedDiscount ?? '0')}
                          </button>
                        </div>
                      )}
                    </Td>
                    <Td numeric className="font-semibold">
                      {formatCurrency(bill.balanceDue)}
                      {bill.currency && <span className="ml-1 text-xs font-normal text-navy/50">{bill.currency}</span>}
                    </Td>
                    <Td numeric>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        className="w-28 text-right ml-auto"
                        disabled={!row.checked || availableCredit <= 0}
                        value={row.credit}
                        onChange={(e) => rebalanceCash(bill, { credit: e.target.value })}
                      />
                    </Td>
                    <Td numeric>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        className="w-28 text-right ml-auto"
                        disabled={!row.checked}
                        value={row.discount}
                        onChange={(e) => rebalanceCash(bill, { discount: e.target.value })}
                      />
                    </Td>
                    <Td numeric>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        className="w-28 text-right ml-auto"
                        disabled={!row.checked}
                        value={row.payAmount}
                        onChange={(e) => patchRow(bill.id, { payAmount: e.target.value })}
                      />
                    </Td>
                    <Td className="text-xs text-red-500">{err}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Recent payments to this vendor — edit or void (QB: edit a saved bill payment) */}
      {vendorId && payments.length > 0 && (
        <Card className="mt-6 p-0 overflow-hidden">
          <div className="px-4 pt-4 pb-2">
            <h2 className="text-sm font-bold text-navy">Recent payments to this vendor</h2>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Method</Th>
                <Th>Check / Ref</Th>
                <Th numeric>Amount</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <Tr key={p.id}>
                  <Td>{formatDate(p.date, 'MMM d, yyyy')}</Td>
                  <Td className="capitalize">{p.method.replace('_', ' ')}</Td>
                  <Td className="font-mono text-sm">
                    {p.reference ?? (p.toPrint ? <Badge tone="warning">To print</Badge> : '—')}
                  </Td>
                  <Td numeric>
                    {formatCurrency(p.amount)}
                    {p.currency && <span className="ml-1 text-xs text-navy/50">{p.currency}</span>}
                  </Td>
                  <Td className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => openEditPayment(p)}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                    <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => setPendingVoid(p)}>
                      <Trash2 className="h-4 w-4" /> Void
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal
        open={!!editPay}
        onClose={() => !savingEdit && setEditPay(null)}
        title="Edit Bill Payment"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditPay(null)} disabled={savingEdit}>
              Cancel
            </Button>
            <Button onClick={saveEditPayment} loading={savingEdit}>
              Save Changes
            </Button>
          </>
        }
      >
        {editPay && (
          <div className="space-y-4">
            <p className="text-xs text-navy/50 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2">
              Changing only the check number keeps the original entry. Changing amounts, the account or
              the date replaces the entry (not allowed once the check is reconciled).
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ep-date">Date</Label>
                <Input id="ep-date" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ep-ref">Check # / Ref</Label>
                <Input id="ep-ref" value={editPay.toPrint ? '' : editRef} disabled={editPay.toPrint} placeholder={editPay.toPrint ? 'assigned when printed' : ''} onChange={(e) => setEditRef(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="ep-acct">Payment Account</Label>
              <Select id="ep-acct" value={editAccount} onChange={(e) => setEditAccount(e.target.value)}>
                {paymentAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              {Object.entries(editAmounts).map(([billId, amt]) => (
                <div key={billId} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-navy">
                    Bill {editBills[billId]?.billNumber ?? ''}{' '}
                    <span className="text-xs text-navy/40">
                      (open now {formatCurrency(editBills[billId]?.balanceDue ?? '0')})
                    </span>
                  </span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    className="w-32 text-right"
                    value={amt}
                    onChange={(e) => setEditAmounts((prev) => ({ ...prev, [billId]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!pendingVoid}
        title="Void payment?"
        message={`Void this ${formatCurrency(pendingVoid?.amount ?? '0')} payment? The bills it paid become open again.`}
        confirmLabel="Void"
        tone="danger"
        onConfirm={() => pendingVoid && voidPayment(pendingVoid)}
        onClose={() => setPendingVoid(null)}
      />

      {/* Totals + action bar — sticky so the primary action stays on screen */}
      {vendorId && bills.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-8 mt-4 border-t border-slate-200 bg-white/90 px-8 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-end gap-6">
            <div className="text-sm text-navy/60">
              Credits: <span className="font-semibold tabular-nums">{formatCurrency(creditTotal.toFixed(2))}</span>
            </div>
            <div className="text-sm text-navy/60">
              Discounts: <span className="font-semibold tabular-nums">{formatCurrency(discountTotal.toFixed(2))}</span>
            </div>
            <div className="text-base text-navy">
              Cash to pay:{' '}
              <span className="font-bold tabular-nums">{formatCurrency(cashTotal.toFixed(2))}</span>
            </div>
            <Button
              onClick={handlePay}
              loading={submitting}
              disabled={selected.length === 0 || rowErrors.length > 0}
            >
              {`Pay ${selected.length} Bill${selected.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
