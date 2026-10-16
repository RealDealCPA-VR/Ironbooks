'use client';
/**
 * Pay Liabilities page (payroll) — shows the amount due on 2300 Payroll Liabilities.
 * Sales tax is paid on its own Pay Sales Tax page (/sales-tax, Sales Tax permission).
 *
 * Paying from a bank account writes a QB Liability Check: payee, check number or
 * "To be printed" (it then waits in Print Checks). Liability checks can be voided below.
 *
 * Payroll liabilities additionally break down by payroll ITEM (QB "Pay Scheduled
 * Liabilities"): each withheld tax / deduction / employer accrual shows its
 * accrued / paid / balance, with checkboxes + per-item amounts. Itemized payments
 * post one 2300 debit line per item (memo = item name) so they reconcile against
 * the specific tax.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Landmark, ListChecks } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Select,
  Label,
  Modal,
  PageHeader,
  Table,
  Th,
  Td,
  Tr,
  Badge,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';
import { Money, formatCurrency } from '@/lib/money';
import { isBankAccount } from '@/lib/accountTypes';
import { formatDate } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DueAmounts {
  payrollLiabilitiesDue: string;
}

interface LiabilityCheck {
  id: string;
  date: string;
  payeeName: string;
  amount: string;
  reference: string | null;
  toPrint: boolean;
  isVoid: boolean;
  paymentAccountName: string | null;
}

interface LiabilityItem {
  name: string;
  kind: 'tax' | 'deduction' | 'employer_contribution';
  accrued: string;
  paid: string;
  balance: string;
}

interface LiabilityBalances {
  asOf: string;
  items: LiabilityItem[];
  totalAccrued: string;
  totalPaid: string;
  balance: string;
}

const KIND_LABELS: Record<LiabilityItem['kind'], string> = {
  tax: 'Withheld Tax',
  deduction: 'Deduction',
  employer_contribution: 'Employer Tax',
};

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}

type LiabilityType = 'payroll';

interface PayForm {
  amount: string;
  date: string;
  paymentAccountId: string;
  memo: string;
  payeeName: string;
  checkNumber: string;
  toPrint: boolean;
}

const today = () => todayISO();

const EMPTY_FORM: PayForm = {
  amount: '',
  date: today(),
  paymentAccountId: '',
  memo: '',
  payeeName: '',
  checkNumber: '',
  toPrint: false,
};

// ---------------------------------------------------------------------------
// Liability tile
// ---------------------------------------------------------------------------

function LiabilityTile({
  icon: Icon,
  label,
  accountCode,
  amount,
  onPay,
}: {
  icon: React.ElementType;
  label: string;
  accountCode: string;
  amount: string;
  onPay: () => void;
}) {
  const isZero = Number(amount) === 0;
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-electric/10">
          <Icon className="h-5 w-5 text-electric" />
        </span>
        <div>
          <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide">{accountCode}</p>
          <p className="text-base font-bold text-navy">{label}</p>
        </div>
      </div>

      <div>
        <p className="text-xs text-navy/50 mb-0.5">Amount Due</p>
        <p
          className={`text-3xl font-extrabold tabular-nums ${
            isZero ? 'text-navy/25' : 'text-red-500'
          }`}
        >
          {formatCurrency(amount)}
        </p>
      </div>

      <Button onClick={onPay} disabled={isZero} variant={isZero ? 'secondary' : 'primary'}>
        {isZero ? 'No balance due' : 'Pay Now'}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pay modal
// ---------------------------------------------------------------------------

function PayModal({
  open,
  type,
  agency,
  accounts,
  onClose,
  onSuccess,
}: {
  open: boolean;
  type: LiabilityType | null;
  agency?: { id: string; name: string; defaultAmount: string } | null;
  accounts: Account[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState<PayForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Reset form whenever the modal opens; agency payments prefill the balance due.
  useEffect(() => {
    if (open) {
      setForm(
        agency && Number(agency.defaultAmount) > 0
          ? { ...EMPTY_FORM, amount: agency.defaultAmount }
          : EMPTY_FORM,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function update(field: keyof PayForm, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit() {
    if (!form.amount || Number(form.amount) <= 0) {
      toast('Amount must be greater than zero.', 'danger');
      return;
    }
    if (!form.date) {
      toast('Date is required.', 'danger');
      return;
    }
    if (!form.paymentAccountId) {
      toast('Please select a bank / payment account.', 'danger');
      return;
    }

    setSaving(true);
    try {
      const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.post('/api/pay-liabilities', {
          type,
          amount: Money.toString(form.amount),
          date: `${form.date}T12:00:00.000Z`,
          paymentAccountId: form.paymentAccountId,
          memo: form.memo.trim() || undefined,
          payeeName: form.payeeName.trim() || undefined,
          checkNumber: form.toPrint ? undefined : form.checkNumber.trim() || undefined,
          toPrint: form.toPrint,
          allowDuplicateNumber,
        }),
      );
      if (saved === null) return;
      toast(form.toPrint ? 'Liability check saved — print it from Print Checks.' : 'Payroll liability payment recorded.', 'success');
      onSuccess();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to record payment.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const title = agency ? `Pay — ${agency.name}` : 'Pay Payroll Liabilities (2300)';

  // QB writes liability checks from a bank account.
  const bankAccounts = accounts.filter((a) => isBankAccount(a));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
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
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="amount">Amount to Pay</Label>
          <Input
            id="amount"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="0.00"
            autoFocus
            value={form.amount}
            onChange={(e) => update('amount', e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="payDate">Payment Date</Label>
          <Input
            id="payDate"
            type="date"
            value={form.date}
            onChange={(e) => update('date', e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="payAccount">Payment Account (Bank)</Label>
          <Select
            id="payAccount"
            value={form.paymentAccountId}
            onChange={(e) => update('paymentAccountId', e.target.value)}
          >
            <option value="">Select account…</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="payee">Pay to the order of</Label>
          <Input
            id="payee"
            placeholder="e.g. United States Treasury"
            value={form.payeeName}
            onChange={(e) => update('payeeName', e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 items-end">
          <div>
            <Label htmlFor="checkNo">Check no.</Label>
            <Input
              id="checkNo"
              placeholder={form.toPrint ? 'Assigned when printed' : 'Next number'}
              disabled={form.toPrint}
              value={form.toPrint ? '' : form.checkNumber}
              onChange={(e) => update('checkNumber', e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-navy/70 pb-2">
            <input
              type="checkbox"
              className="h-4 w-4 accent-electric"
              checked={form.toPrint}
              onChange={(e) => update('toPrint', e.target.checked)}
            />
            To be printed
          </label>
        </div>

        <div>
          <Label htmlFor="memo">Memo (optional)</Label>
          <Input
            id="memo"
            placeholder="e.g. 941 deposit — March"
            value={form.memo}
            onChange={(e) => update('memo', e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pay payroll liabilities BY ITEM (QB Pay Scheduled Liabilities)
// ---------------------------------------------------------------------------

function PayrollByItemCard({
  balances,
  accounts,
  onPaid,
}: {
  balances: LiabilityBalances | null;
  accounts: Account[];
  onPaid: () => void;
}) {
  // Per-item selection + editable amounts (default = remaining balance).
  // Keyed by `${kind}|${name}` — withheld-tax and employer items can share a name
  // (e.g. employee + employer Social Security), so name alone is ambiguous.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState(today());
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [toPrint, setToPrint] = useState(false);
  const [saving, setSaving] = useState(false);

  // Re-seed editable amounts whenever fresh balances arrive.
  useEffect(() => {
    if (!balances) return;
    const next: Record<string, string> = {};
    for (const item of balances.items) {
      next[`${item.kind}|${item.name}`] = Number(item.balance) > 0 ? item.balance : '';
    }
    setAmounts(next);
    setChecked({});
  }, [balances]);

  if (!balances) return null;

  const bankAccounts = accounts.filter((a) => isBankAccount(a));
  const items = balances.items;

  const keyOf = (i: LiabilityItem) => `${i.kind}|${i.name}`;
  const selected = items.filter((i) => checked[keyOf(i)]);
  const selectedTotal = Money.add(...selected.map((i) => amounts[keyOf(i)] || 0));

  async function handlePaySelected() {
    if (selected.length === 0) {
      toast('Select at least one liability item to pay.', 'danger');
      return;
    }
    for (const item of selected) {
      const amt = Number(amounts[keyOf(item)]);
      if (!amounts[keyOf(item)] || isNaN(amt) || amt <= 0) {
        toast(`Enter an amount greater than zero for "${item.name}".`, 'danger');
        return;
      }
    }
    if (!date) { toast('Payment date is required.', 'danger'); return; }
    if (!paymentAccountId) { toast('Please select a bank / payment account.', 'danger'); return; }

    setSaving(true);
    try {
      const saved = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.post('/api/pay-liabilities/by-item', {
          date: `${date}T12:00:00.000Z`,
          paymentAccountId,
          memo: memo.trim() || undefined,
          payeeName: payeeName.trim() || undefined,
          toPrint,
          allowDuplicateNumber,
          items: selected.map((i) => ({
            name: i.name,
            kind: i.kind,
            amount: Money.toString(amounts[keyOf(i)]),
          })),
        }),
      );
      if (saved === null) return;
      toast(toPrint ? 'Liability check saved — print it from Print Checks.' : 'Payroll liability payment recorded.', 'success');
      setMemo('');
      onPaid();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to record payment.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-6 pb-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-electric/10">
            <ListChecks className="h-5 w-5 text-electric" />
          </span>
          <div>
            <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide">2300 — by item</p>
            <p className="text-base font-bold text-navy">Pay Payroll Liabilities by Item</p>
          </div>
        </div>
        <p className="text-xs text-navy/50 mt-2">
          Accrued through {balances.asOf}. Check the items to pay; each item posts its own
          memo line so payments reconcile against the specific tax or deduction.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="px-6 pb-6 text-sm text-navy/40">No payroll liabilities accrued yet.</div>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th className="w-8"> </Th>
                <Th>Payroll Item</Th>
                <Th>Type</Th>
                <Th numeric>Accrued</Th>
                <Th numeric>Paid</Th>
                <Th numeric>Balance</Th>
                <Th numeric>Amount to Pay</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const k = keyOf(item);
                return (
                  <Tr key={k}>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Pay ${item.name} (${KIND_LABELS[item.kind]})`}
                        checked={Boolean(checked[k])}
                        onChange={(e) =>
                          setChecked((prev) => ({ ...prev, [k]: e.target.checked }))
                        }
                      />
                    </Td>
                    <Td className="font-semibold text-navy">{item.name}</Td>
                    <Td>
                      <Badge tone={item.kind === 'deduction' ? 'neutral' : 'info'}>
                        {KIND_LABELS[item.kind]}
                      </Badge>
                    </Td>
                    <Td numeric className="text-navy/70">
                      {formatCurrency(item.accrued)}
                    </Td>
                    <Td numeric className="text-navy/70">
                      {formatCurrency(item.paid)}
                    </Td>
                    <Td
                      numeric
                      className={`font-semibold ${
                        Number(item.balance) > 0 ? 'text-red-500' : 'text-navy/40'
                      }`}
                    >
                      {formatCurrency(item.balance)}
                    </Td>
                    <Td numeric>
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        className="w-28 text-right ml-auto"
                        value={amounts[k] ?? ''}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [k]: e.target.value }))
                        }
                        disabled={!checked[k]}
                      />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>

          <div className="p-6 pt-4 border-t border-navy/5 grid grid-cols-1 sm:grid-cols-5 gap-4 items-end">
            <div>
              <Label htmlFor="itemPayDate">Payment Date</Label>
              <Input
                id="itemPayDate"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="itemPayAccount">Payment Account (Bank)</Label>
              <Select
                id="itemPayAccount"
                value={paymentAccountId}
                onChange={(e) => setPaymentAccountId(e.target.value)}
              >
                <option value="">Select account…</option>
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="itemPayee">Pay to the order of</Label>
              <Input
                id="itemPayee"
                placeholder="e.g. United States Treasury"
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
              />
              <label className="mt-1 flex items-center gap-2 text-xs text-navy/70">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-electric"
                  checked={toPrint}
                  onChange={(e) => setToPrint(e.target.checked)}
                />
                To be printed
              </label>
            </div>
            <div>
              <Label htmlFor="itemPayMemo">Memo (optional)</Label>
              <Input
                id="itemPayMemo"
                placeholder="e.g. 941 deposit — March"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
            <Button onClick={handlePaySelected} loading={saving} disabled={selected.length === 0}>
              Pay Selected ({formatCurrency(selectedTotal)})
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PayLiabilitiesPage() {
  const [due, setDue] = useState<DueAmounts>({ payrollLiabilitiesDue: '0.00' });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<LiabilityBalances | null>(null);
  const [checks, setChecks] = useState<LiabilityCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [voidingId, setVoidingId] = useState<string | null>(null);

  // Modal state
  const [payType, setPayType] = useState<LiabilityType | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  async function fetchData() {
    setLoading(true);
    try {
      const [dueData, acctData, balanceData, checkData] = await Promise.all([
        api.get<DueAmounts>('/api/pay-liabilities'),
        api.get<Account[]>('/api/accounts'),
        api.get<LiabilityBalances>('/api/pay-liabilities/by-item'),
        api.get<{ items: LiabilityCheck[] }>('/api/pay-liabilities/checks'),
      ]);
      setDue(dueData);
      setAccounts(acctData);
      setBalances(balanceData);
      setChecks(checkData.items);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load data.', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openPayModal(type: LiabilityType) {
    setPayType(type);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setPayType(null);
  }

  async function handleSuccess() {
    closeModal();
    await fetchData();
  }

  async function handleVoid(c: LiabilityCheck) {
    if (!window.confirm(`Void the ${formatCurrency(c.amount)} liability check to ${c.payeeName}? The amount will show as owed again.`)) return;
    setVoidingId(c.id);
    try {
      await api.post(`/api/pay-liabilities/checks/${c.id}`, { action: 'void' });
      toast('Liability check voided.', 'success');
      await fetchData();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not void the check.', 'danger');
    } finally {
      setVoidingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Pay Liabilities" icon={Landmark} />
      <p className="mt-2 text-sm text-navy/50">
        Payroll taxes and deductions you withheld. Sales tax is paid on{' '}
        <Link href="/sales-tax" className="text-electric hover:underline">Pay Sales Tax</Link>.
      </p>

      {loading ? (
        <div className="mt-8 flex justify-center text-electric">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
            <Card>
              <LiabilityTile
                icon={Landmark}
                label="Payroll Liabilities (lump sum)"
                accountCode="2300"
                amount={due.payrollLiabilitiesDue}
                onPay={() => openPayModal('payroll')}
              />
            </Card>
          </div>

          <div className="mt-6 max-w-5xl">
            <PayrollByItemCard balances={balances} accounts={accounts} onPaid={fetchData} />
          </div>

          <div className="mt-6 max-w-5xl">
            <Card className="p-0 overflow-hidden">
              <div className="p-6 pb-3">
                <p className="text-base font-bold text-navy">Liability checks</p>
              </div>
              {checks.length === 0 ? (
                <p className="px-6 pb-6 text-sm text-navy/40">No liability checks yet.</p>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Check no.</Th>
                      <Th>Pay to</Th>
                      <Th>Bank account</Th>
                      <Th numeric>Amount</Th>
                      <Th className="text-right">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <Tr key={c.id}>
                        <Td>{formatDate(c.date, 'MMM d, yyyy')}</Td>
                        <Td>
                          {c.isVoid ? (
                            <Badge tone="danger">Void</Badge>
                          ) : c.toPrint ? (
                            <Link href="/print-checks"><Badge tone="warning">To print</Badge></Link>
                          ) : (
                            (c.reference ?? '—')
                          )}
                        </Td>
                        <Td className="font-medium">{c.payeeName}</Td>
                        <Td>{c.paymentAccountName ?? '—'}</Td>
                        <Td numeric className={c.isVoid ? 'line-through text-navy/40' : ''}>{formatCurrency(c.amount)}</Td>
                        <Td className="text-right">
                          {!c.isVoid && (
                            <Button variant="ghost" size="sm" loading={voidingId === c.id} onClick={() => handleVoid(c)}>
                              Void
                            </Button>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </div>
        </>
      )}

      <PayModal
        open={modalOpen}
        type={payType}
        agency={null}
        accounts={accounts}
        onClose={closeModal}
        onSuccess={handleSuccess}
      />
    </main>
  );
}
