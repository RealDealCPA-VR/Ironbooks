'use client';
/**
 * Pay Liabilities page — shows current amounts due for:
 *   - 2200 Sales Tax Payable
 *   - 2300 Payroll Liabilities
 *
 * Each tile has a "Pay" button that opens a modal where the user selects
 * a bank account, enters an amount and date, then posts the GL entry.
 *
 * Payroll liabilities additionally break down by payroll ITEM (QB "Pay Scheduled
 * Liabilities"): each withheld tax / deduction / employer accrual shows its
 * accrued / paid / balance, with checkboxes + per-item amounts. Itemized payments
 * post one 2300 debit line per item (memo = item name) so they reconcile against
 * the specific tax.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Landmark, ListChecks, Receipt } from 'lucide-react';
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
import { Money, formatCurrency } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DueAmounts {
  salesTaxDue: string;
  payrollLiabilitiesDue: string;
}

interface AgencyLiabilityRow {
  agencyId: string | null;
  agencyName: string | null;
  liabilityAccountId: string | null;
  collected: string;
  /** Sales tax adjustments (discounts, penalties…) — signed. */
  adjusted?: string;
  paid: string;
  balance: string;
}

interface AgencyLiabilities {
  rows: AgencyLiabilityRow[];
  totalCollected: string;
  totalPaid: string;
  totalBalance: string;
  /** Sales tax liability accounts' balance in the books; tiesToGl = the grid matches it. */
  glBalance?: string;
  tiesToGl?: boolean;
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

type LiabilityType = 'sales_tax' | 'payroll';

interface PayForm {
  amount: string;
  date: string;
  paymentAccountId: string;
  memo: string;
}

const today = () => new Date().toISOString().split('T')[0];

const EMPTY_FORM: PayForm = {
  amount: '',
  date: today(),
  paymentAccountId: '',
  memo: '',
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
  /** Set when paying a specific tax agency: posts against its liability account. */
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

  function update(field: keyof PayForm, value: string) {
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
      await api.post('/api/pay-liabilities', {
        type,
        amount: parseFloat(form.amount).toFixed(2),
        date: new Date(form.date).toISOString(),
        paymentAccountId: form.paymentAccountId,
        agencyId: agency?.id,
        memo: form.memo.trim() || undefined,
      });
      toast(
        type === 'sales_tax' ? 'Sales tax payment recorded.' : 'Payroll liability payment recorded.',
        'success',
      );
      onSuccess();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to record payment.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const title = agency
    ? `Pay Sales Tax — ${agency.name}`
    : type === 'sales_tax'
      ? 'Pay Sales Tax (2200)'
      : 'Pay Payroll Liabilities (2300)';

  // Only offer asset accounts as payment sources (bank, checking, savings)
  const bankAccounts = accounts.filter((a) => a.type === 'asset');

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
          <Label htmlFor="memo">Memo (optional)</Label>
          <Input
            id="memo"
            placeholder="e.g. Q1 sales tax remittance"
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

  const bankAccounts = accounts.filter((a) => a.type === 'asset');
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
      await api.post('/api/pay-liabilities/by-item', {
        date: new Date(date).toISOString(),
        paymentAccountId,
        memo: memo.trim() || undefined,
        items: selected.map((i) => ({
          name: i.name,
          kind: i.kind,
          amount: Money.toString(amounts[keyOf(i)]),
        })),
      });
      toast('Payroll liability payment recorded.', 'success');
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

          <div className="p-6 pt-4 border-t border-navy/5 grid grid-cols-1 sm:grid-cols-4 gap-4 items-end">
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
  const [due, setDue] = useState<DueAmounts>({ salesTaxDue: '0.00', payrollLiabilitiesDue: '0.00' });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<LiabilityBalances | null>(null);
  const [agencyData, setAgencyData] = useState<AgencyLiabilities | null>(null);
  const [loading, setLoading] = useState(true);

  // Modal state
  const [payType, setPayType] = useState<LiabilityType | null>(null);
  const [payAgency, setPayAgency] = useState<{ id: string; name: string; defaultAmount: string } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  async function fetchData() {
    setLoading(true);
    try {
      const [dueData, acctData, balanceData, agencyRows] = await Promise.all([
        api.get<DueAmounts>('/api/pay-liabilities'),
        api.get<Account[]>('/api/accounts'),
        api.get<LiabilityBalances>('/api/pay-liabilities/by-item'),
        api.get<AgencyLiabilities>('/api/pay-liabilities/sales-tax'),
      ]);
      setDue(dueData);
      setAccounts(acctData);
      setBalances(balanceData);
      setAgencyData(agencyRows);
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
    setPayAgency(null);
    setModalOpen(true);
  }

  function openAgencyPayModal(row: AgencyLiabilityRow) {
    if (!row.agencyId) return;
    setPayType('sales_tax');
    setPayAgency({
      id: row.agencyId,
      name: row.agencyName ?? 'Tax Agency',
      defaultAmount: Number(row.balance) > 0 ? row.balance : '',
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setPayType(null);
    setPayAgency(null);
  }

  async function handleSuccess() {
    closeModal();
    await fetchData();
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Pay Liabilities" icon={Landmark} />

      {loading ? (
        <div className="mt-8 flex justify-center text-electric">
          <Spinner className="h-6 w-6" />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
            <Card>
              <LiabilityTile
                icon={Receipt}
                label="Sales Tax Payable"
                accountCode="2200"
                amount={due.salesTaxDue}
                onPay={() => openPayModal('sales_tax')}
              />
            </Card>

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

          {/* ---- Pay Sales Tax by agency (QB Pay Sales Tax grid) ---- */}
          <div className="mt-6 max-w-5xl">
            <Card className="p-0 overflow-hidden">
              <div className="p-6 pb-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-electric/10">
                    <Receipt className="h-5 w-5 text-electric" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide">
                      Sales tax — by agency
                    </p>
                    <p className="text-base font-bold text-navy">Pay Sales Tax</p>
                  </div>
                </div>
                <p className="text-xs text-navy/50 mt-2">
                  Tax from invoices, sales receipts and credit memos is split to agencies by each tax
                  rate (and its combined-rate parts). Payments post against the agency&apos;s own liability
                  account when one is set (otherwise 2200).
                  {agencyData?.tiesToGl !== undefined && (
                    <span className={`ml-1 font-semibold ${agencyData.tiesToGl ? 'text-emerald' : 'text-red-600'}`}>
                      {agencyData.tiesToGl ? 'Matches your Sales Tax Payable balance.' : 'Does not match Sales Tax Payable — run Fix Incorrectly Recorded Sales Tax.'}
                    </span>
                  )}
                </p>
                <div className="mt-2 flex flex-wrap gap-4 text-xs">
                  <Link href="/accountant/sales-tax-adjustment" className="text-electric hover:underline">Adjust sales tax due</Link>
                  <Link href="/accountant/fix-sales-tax" className="text-electric hover:underline">Fix incorrectly recorded sales tax</Link>
                  <Link href="/reports/sales-tax" className="text-electric hover:underline">Sales tax liability report</Link>
                </div>
              </div>

              {!agencyData || agencyData.rows.length === 0 ? (
                <div className="px-6 pb-6 text-sm text-navy/40">
                  No tax agencies or collected sales tax yet. Set up agencies and rates on the
                  Sales Tax settings page.
                </div>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <Th>Agency</Th>
                      <Th numeric>Collected</Th>
                      <Th numeric>Paid</Th>
                      <Th numeric>Balance</Th>
                      <Th className="text-right">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {agencyData.rows.map((row) => (
                      <Tr key={row.agencyId ?? '__unassigned__'}>
                        <Td className="font-semibold text-navy">
                          {row.agencyName ?? (
                            <Link href="/accountant/fix-sales-tax" className="italic text-navy/50 hover:text-electric hover:underline">Not tied to an agency — fix</Link>
                          )}
                          {row.agencyId && !row.liabilityAccountId && (
                            <span className="ml-2 text-[11px] font-normal text-navy/40">
                              posts to 2200
                            </span>
                          )}
                        </Td>
                        <Td numeric className="text-navy/70">{formatCurrency(row.collected)}</Td>
                        <Td numeric className="text-navy/70">{formatCurrency(row.paid)}</Td>
                        <Td
                          numeric
                          className={`font-semibold ${
                            Number(row.balance) > 0 ? 'text-red-500' : 'text-navy/40'
                          }`}
                        >
                          {formatCurrency(row.balance)}
                        </Td>
                        <Td className="text-right">
                          {row.agencyId ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={Number(row.balance) <= 0}
                              onClick={() => openAgencyPayModal(row)}
                            >
                              Pay
                            </Button>
                          ) : (
                            <span
                              className="text-xs text-navy/40"
                              title="Link this tax to an agency via rate components to pay it per-agency"
                            >
                              —
                            </span>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                      <td className="py-3 px-4">Total</td>
                      <td className="py-3 px-4 text-right tabular-nums">
                        {formatCurrency(agencyData.totalCollected)}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">
                        {formatCurrency(agencyData.totalPaid)}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">
                        {formatCurrency(agencyData.totalBalance)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </Table>
              )}
            </Card>
          </div>

          <div className="mt-6 max-w-5xl">
            <PayrollByItemCard balances={balances} accounts={accounts} onPaid={fetchData} />
          </div>
        </>
      )}

      <PayModal
        open={modalOpen}
        type={payType}
        agency={payAgency}
        accounts={accounts}
        onClose={closeModal}
        onSuccess={handleSuccess}
      />
    </main>
  );
}
